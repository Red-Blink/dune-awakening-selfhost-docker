import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { buildDuneArgs, runDune } from "./runner.js";
import { resolveCatalogItem } from "./adminCatalog.js";
import { publishCarePackageWhisper } from "./rmq.js";

const DEFAULT_KIT_ID = "starter-kit-v1";
const CARE_PACKAGE_SERVER_PERSONA = {
  accountId: "922337203685477000",
  funcomId: "Server#00000",
  hexFlsId: "53657276657200000000000000000000",
  displayName: "Server"
};
const DEFAULT_KIT = {
  id: DEFAULT_KIT_ID,
  name: "Care Package",
  items: [],
  xp: 0,
  welcomeMessage: ""
};

const DEFAULT_CONFIG = {
  enabled: false,
  version: DEFAULT_KIT_ID,
  activeKitId: DEFAULT_KIT_ID,
  autoGrantKitId: DEFAULT_KIT_ID,
  kits: [DEFAULT_KIT],
  items: [],
  xp: 0,
  allowRepeatGrants: false,
  autoGrantEnabled: false,
  autoGrantIntervalSeconds: 60,
  grantWhen: "first_online",
  autoGrantRules: [{ id: "auto-rule-1", enabled: true, kitId: DEFAULT_KIT_ID, grantWhen: "first_online", lastSeenDays: 30 }]
};

export function starterKitCapabilities() {
  return {
    config: true,
    manualGrant: true,
    bulkGrant: true,
    retryFailedGrant: true,
    automaticScanner: true,
    currency: false,
    reason: "Care Package grants use existing RedBlink dune admin grant-item/grant-item-id and award-xp commands. Auto-grant is disabled by default and only scans when the Care Package and auto-grant are both explicitly enabled."
  };
}

export function starterKitConfig(config) {
  return readConfig(config);
}

export function saveStarterKitConfig(config, body) {
  const next = validateStarterKitConfig(body);
  writeConfig(config, next);
  return next;
}

export function enableStarterKit(config, enabled) {
  const next = { ...readConfig(config), enabled: Boolean(enabled) };
  writeConfig(config, next);
  return next;
}

export function starterKitHistory(config, limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const file = grantsPath(config);
  if (!existsSync(file)) return { rows: [] };
  const rows = readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-safeLimit)
    .map((line) => JSON.parse(line))
    .map(normalizeHistoryRow)
    .reverse();
  return { rows };
}

function normalizeHistoryRow(row = {}) {
  const status = row.status || (row.ok === true ? "granted" : row.ok === false ? "failed" : "unknown");
  const timestamp = row.timestamp || row.startedAt || row.finishedAt || "";
  return {
    ...row,
    timestamp,
    local_timestamp: formatServerLocalTimestamp(timestamp),
    status,
    summary: row.summary || summarizeStoredRow(row, status)
  };
}

function formatServerLocalTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function summarizeStoredRow(row, status) {
  if (row.reason) return `${status}: ${row.reason}`;
  if (Array.isArray(row.results)) {
    const successCount = row.results.filter((result) => result.ok).length;
    const failureCount = row.results.length - successCount;
    return `${successCount} succeeded, ${failureCount} failed`;
  }
  return status;
}

export function starterKitEligiblePlayers(config, players = [], options = {}) {
  const kitConfig = readConfig(config);
  const rule = options.ruleId ? kitConfig.autoGrantRules.find((entry) => entry.id === options.ruleId) : null;
  const kit = rule ? selectedKit(kitConfig, rule.kitId, rule.grantWhen, rule.lastSeenDays) : selectedKit(kitConfig, kitConfig.autoGrantKitId);
  const history = starterKitHistory(config, 500).rows;
  return {
    config: kitConfig,
    kit,
    ruleId: rule?.id || "",
    rows: players.map((player) => eligibilityForPlayer(kit, history, normalizePlayer(player)))
  };
}

export async function grantEligibleStarterKits(config, players = [], body = {}, context = {}) {
  const phrase = "GRANT STARTER KIT TO ELIGIBLE PLAYERS";
  if (body.confirmation !== phrase) throw new Error(`Confirmation phrase required: ${phrase}`);
  const kitConfig = readConfig(config);
  const kit = selectedKit(kitConfig, kitConfig.autoGrantKitId);
  if (!kit.items.length && !kit.xp) throw new Error("Care Package has no configured items or XP");
  const rows = starterKitEligiblePlayers(config, players).rows;
  const results = [];
  for (const player of rows) {
    if (!player.eligible) {
      const row = skippedGrant(config, kit, player, player.reason || "not eligible", "bulk");
      results.push(row);
      continue;
    }
    try {
      results.push(await grantStarterKit(config, player.action_player_id, {
        confirmation: "GRANT STARTER KIT",
        source: "bulk",
        characterName: player.character_name,
        actorId: player.actor_id,
        funcomId: player.funcom_id || player.fls_id || player.action_player_id
      }, context));
    } catch (error) {
      const row = failedGrant(config, kit, player, error.message || String(error), "bulk");
      results.push(row);
    }
  }
  return summarizeGrantResults(results);
}

export async function runStarterKitAutoScan(config, players = [], source = "auto", context = {}) {
  const kitConfig = readConfig(config);
  if (!kitConfig.enabled) return { ok: true, skipped: true, reason: "Care Package is disabled", results: [] };
  if (!kitConfig.autoGrantEnabled) return { ok: true, skipped: true, reason: "Auto-grant is disabled", results: [] };
  const rules = kitConfig.autoGrantRules.filter((rule) => rule.enabled);
  if (!rules.length) return { ok: true, skipped: true, reason: "No enabled auto-grant rules", results: [] };
  const results = [];
  for (const rule of rules) {
    const kit = selectedKit(kitConfig, rule.kitId, rule.grantWhen, rule.lastSeenDays);
    if (!kit.items.length && !kit.xp) {
      results.push(failedGrant(config, kit, { action_player_id: "", actor_id: "", character_name: "" }, "Care Package has no configured items or XP", source));
      continue;
    }
    const history = starterKitHistory(config, 500).rows;
    const rows = players.map((player) => eligibilityForPlayer(kit, history, normalizePlayer(player)));
    for (const player of rows) {
      if (!player.eligible) {
        results.push(skippedGrant(config, kit, player, player.reason || "not eligible", source));
        continue;
      }
      try {
        results.push(await grantStarterKit(config, player.action_player_id, {
          confirmation: "GRANT STARTER KIT",
          source,
          kitId: kit.id,
          characterName: player.character_name,
          actorId: player.actor_id,
          funcomId: player.funcom_id || player.fls_id || player.action_player_id
        }, context));
      } catch (error) {
        results.push(failedGrant(config, kit, player, error.message || String(error), source));
      }
    }
  }
  return summarizeGrantResults(results);
}

export async function grantStarterKit(config, playerId, body = {}, context = {}) {
  const phrase = "GRANT STARTER KIT";
  if (body.confirmation !== phrase) throw new Error(`Confirmation phrase required: ${phrase}`);
  const kitConfig = readConfig(config);
  const source = body.source || "manual";
  const kit = selectedKit(kitConfig, body.kitId || (source === "manual" ? kitConfig.activeKitId : kitConfig.autoGrantKitId));
  validatePlayerTarget(playerId);
  if (!kit.items.length && !kit.xp) throw new Error("Care Package has no configured items or XP");
  if (source !== "manual" && hasSuccessfulGrant(config, playerId, kit.id)) {
    throw new Error(`Care Package ${kit.name} was already granted to ${playerId}`);
  }

  const grantId = randomUUID();
  const startedAt = new Date().toISOString();
  const results = [];
  for (const item of kit.items) {
    try {
      const resolved = resolveCatalogItem(config.repoRoot, item.itemId ? { itemId: item.itemId } : { itemName: item.itemName });
      const operation = item.itemId ? "adminGiveItemId" : "adminGiveItem";
      const payload = {
        playerId,
        itemId: resolved.itemId,
        itemName: resolved.name,
        quantity: item.quantity,
        durability: item.durability
      };
      const command = buildDuneArgs(operation, payload);
      const result = config.mockMode ? { code: 0, stdout: "mock starter item grant\n", stderr: "" } : await runDune(config, command);
      results.push({ ok: true, operation, item: payload, stdout: result.stdout, stderr: result.stderr, exitCode: result.code });
    } catch (error) {
      results.push({ ok: false, item, error: error.message || String(error) });
    }
  }
  if (kit.xp > 0) {
    try {
      const payload = { playerId, amount: kit.xp };
      const command = buildDuneArgs("adminAddXp", payload);
      const result = config.mockMode ? { code: 0, stdout: "mock starter xp grant\n", stderr: "" } : await runDune(config, command);
      results.push({ ok: true, operation: "adminAddXp", amount: kit.xp, stdout: result.stdout, stderr: result.stderr, exitCode: result.code });
    } catch (error) {
      results.push({ ok: false, operation: "adminAddXp", amount: kit.xp, error: error.message || String(error) });
    }
  }
  if (kit.welcomeMessage) {
    try {
      const persona = await ensureCarePackageServerPersona(context.db);
      const recipient = resolveWelcomeWhisperRecipient(playerId, body);
      const result = config.mockMode
        ? { code: 0, stdout: "mock care package welcome whisper\n", stderr: "", payload: null }
        : await publishCarePackageWhisper(config, {
            recipientFuncomId: recipient.funcomId,
            recipientCharacterName: recipient.characterName,
            senderFuncomId: persona.funcomId,
            senderHexFlsId: persona.hexFlsId,
            message: kit.welcomeMessage
          });
      results.push({
        ok: true,
        operation: "carePackageWelcomeWhisper",
        recipientFuncomId: recipient.funcomId,
        recipientCharacterName: recipient.characterName,
        senderName: persona.displayName,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code
      });
    } catch (error) {
      results.push({ ok: false, operation: "carePackageWelcomeWhisper", error: error.message || String(error) });
    }
  }
  const aggregate = summarizeActionResults(results);
  const row = { id: grantId, playerId, action_player_id: playerId, actor_id: body.actorId || "", character_name: body.characterName || "", source, version: kit.id, kitId: kit.id, kitName: kit.name, status: aggregate.status, ok: aggregate.ok, summary: aggregate.summary, startedAt, finishedAt: new Date().toISOString(), results };
  appendGrant(config, row);
  return row;
}

export async function retryStarterKitGrant(config, grantId, body = {}, context = {}) {
  const phrase = "RETRY STARTER KIT";
  if (body.confirmation !== phrase) throw new Error(`Confirmation phrase required: ${phrase}`);
  const existing = starterKitHistory(config, 500).rows.find((row) => row.id === grantId);
  if (!existing) throw new Error("Care Package grant was not found");
  if (existing.ok) throw new Error("Only failed Care Package grants can be retried");
  return grantStarterKit(config, existing.playerId, { confirmation: "GRANT STARTER KIT", kitId: existing.kitId || existing.version, characterName: existing.character_name, actorId: existing.actor_id }, context);
}

export function validateStarterKitConfig(body = {}) {
  const enabled = Boolean(body.enabled);
  const kits = validateStarterKits(body);
  const activeKitId = validKitId(body.activeKitId, kits) || kits[0]?.id || "";
  const autoGrantKitId = validKitId(body.autoGrantKitId, kits) || activeKitId;
  const activeKit = kits.find((kit) => kit.id === activeKitId) || kits[0] || { id: "", items: [], xp: 0 };
  const grantWhen = validateGrantWhen(body.grantWhen || DEFAULT_CONFIG.grantWhen);
  return {
    enabled,
    version: activeKit.id,
    activeKitId,
    autoGrantKitId,
    kits,
    items: activeKit.items,
    xp: activeKit.xp,
    allowRepeatGrants: false,
    autoGrantEnabled: Boolean(body.autoGrantEnabled),
    autoGrantIntervalSeconds: validateInteger(body.autoGrantIntervalSeconds ?? DEFAULT_CONFIG.autoGrantIntervalSeconds, "autoGrantIntervalSeconds", 60, 3600),
    grantWhen,
    autoGrantRules: validateAutoGrantRules(body, kits, autoGrantKitId, grantWhen)
  };
}

function eligibilityForPlayer(kit, history, player) {
  if (!player.action_player_id) return { ...player, eligible: false, reason: "Missing admin action ID" };
  if (kit.grantWhen === "first_online" && String(player.online_status || "").toLowerCase() !== "online") {
    return { ...player, eligible: false, reason: "Not currently online" };
  }
  if (kit.grantWhen === "last_seen") {
    if (String(player.online_status || "").toLowerCase() !== "online") {
      return { ...player, eligible: false, reason: "Not currently online" };
    }
    const lastSeen = parseTimestamp(player.last_seen);
    if (!lastSeen) return { ...player, eligible: false, reason: "Last seen timestamp unavailable" };
    const days = Math.max(1, Number(kit.lastSeenDays) || 30);
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    if (lastSeen.getTime() > cutoff) {
      return { ...player, eligible: false, reason: `Seen within ${days} days` };
    }
  }
  if (history.some((row) => isSuccessfulGrant(row) && (row.kitId || row.version) === kit.id && row.playerId === player.action_player_id)) {
    return { ...player, eligible: false, reason: `Already granted ${kit.name}` };
  }
  return { ...player, eligible: true, reason: "" };
}

function normalizePlayer(player = {}) {
  return {
    actor_id: player.actor_id || player.player_pawn_id || "",
    player_pawn_id: player.player_pawn_id || player.actor_id || "",
    account_id: player.account_id || "",
    character_name: player.character_name || "",
    online_status: player.online_status || "",
    last_seen: player.last_seen || player.last_seen_at || player.last_online || player.last_online_at || "",
    action_player_id: player.action_player_id || player.fls_id || player.funcom_id || (player.account_id ? String(player.account_id) : ""),
    funcom_id: player.funcom_id || player.fls_id || "",
    fls_id: player.fls_id || player.funcom_id || ""
  };
}

function hasSuccessfulGrant(config, playerId, kitId) {
  return starterKitHistory(config, 500).rows.some((row) => isSuccessfulGrant(row) && (row.kitId || row.version) === kitId && row.playerId === playerId);
}

function isSuccessfulGrant(row) {
  return row?.status === "granted" || (row?.ok === true && !row?.status);
}

function skippedGrant(config, kit, player, reason, source) {
  const now = new Date().toISOString();
  const row = { id: randomUUID(), playerId: player.action_player_id || "", action_player_id: player.action_player_id || "", actor_id: player.actor_id || "", character_name: player.character_name || "", source, version: kit.id, kitId: kit.id, kitName: kit.name, status: "skipped", ok: true, summary: `Skipped: ${reason}`, startedAt: now, finishedAt: now, reason, results: [] };
  appendGrant(config, row);
  return row;
}

function failedGrant(config, kit, player, reason, source) {
  const now = new Date().toISOString();
  const row = { id: randomUUID(), playerId: player.action_player_id || "", action_player_id: player.action_player_id || "", actor_id: player.actor_id || "", character_name: player.character_name || "", source, version: kit.id, kitId: kit.id, kitName: kit.name, status: "failed", ok: false, summary: `Failed: ${reason}`, startedAt: now, finishedAt: now, reason, results: [{ ok: false, error: reason }] };
  appendGrant(config, row);
  return row;
}

function summarizeGrantResults(results) {
  return {
    ok: results.every((row) => row.ok),
    granted: results.filter((row) => row.status === "granted").length,
    skipped: results.filter((row) => row.status === "skipped").length,
    failed: results.filter((row) => row.status === "failed").length,
    results
  };
}

function summarizeActionResults(results) {
  const successCount = results.filter((result) => result.ok).length;
  const failureCount = results.length - successCount;
  const status = failureCount === 0 ? "granted" : successCount === 0 ? "failed" : "partial_failed";
  const failed = results
    .filter((result) => !result.ok)
    .map((result) => `${describeAction(result)} failed: ${result.error || "unknown error"}`)
    .slice(0, 3);
  return {
    ok: failureCount === 0,
    status,
    summary: `${successCount} succeeded, ${failureCount} failed${failed.length ? `; ${failed.join("; ")}` : ""}`
  };
}

function describeAction(result) {
  if (result.item) return `${result.item.itemName || result.item.itemId || "Item"} x${result.item.quantity || 1}`;
  if (result.operation === "adminAddXp") return `${result.amount || 0} XP`;
  if (result.operation === "carePackageWelcomeWhisper") return "Welcome whisper";
  return result.operation || "Care Package action";
}

function selectedKit(config, kitId, grantWhen = config.grantWhen, lastSeenDays = 30) {
  const kit = config.kits.find((entry) => entry.id === kitId) || config.kits.find((entry) => entry.id === config.activeKitId) || config.kits[0] || DEFAULT_KIT;
  return { ...kit, grantWhen, lastSeenDays };
}

function validateStarterKits(body = {}) {
  const rawKits = Array.isArray(body.kits)
    ? body.kits
    : [{
        id: /^[A-Za-z0-9_.:-]{1,80}$/.test(String(body.version || "")) ? body.version : DEFAULT_KIT_ID,
        name: body.name || "Care Package",
        items: body.items,
        xp: body.xp,
        welcomeMessage: body.welcomeMessage
      }];
  if (rawKits.length > 12) throw new Error("Care Package supports at most 12 packages");
  const used = new Set();
  return rawKits.map((kit, index) => {
    const fallbackName = index === 0 ? "Care Package" : `Care Package ${index + 1}`;
    const name = validateKitName(Object.prototype.hasOwnProperty.call(kit, "name") ? kit.name : fallbackName);
    let id = validateKitId(kit.id || slugKitName(name) || `starter-kit-${index + 1}`);
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    const rawItems = Array.isArray(kit.items) ? kit.items : [];
    if (rawItems.length > 25) throw new Error("Care Package supports at most 25 item entries per package");
    return {
      id,
      name,
      items: rawItems.map(validateStarterKitItem),
      xp: validateInteger(kit.xp ?? 0, "xp", 0, 100000000),
      welcomeMessage: validateWelcomeMessage(kit.welcomeMessage ?? "")
    };
  });
}

function validKitId(value, kits) {
  const id = String(value || "").trim();
  return kits.some((kit) => kit.id === id) ? id : "";
}

function validateAutoGrantRules(body, kits, fallbackKitId, fallbackGrantWhen) {
  if (!kits.length) return [];
  const rawRules = Array.isArray(body.autoGrantRules)
    ? body.autoGrantRules
    : [{ id: "auto-rule-1", enabled: true, kitId: body.autoGrantKitId || fallbackKitId, grantWhen: body.grantWhen || fallbackGrantWhen, lastSeenDays: body.lastSeenDays || 30 }];
  if (rawRules.length > 24) throw new Error("Care Package supports at most 24 auto-grant rules");
  const used = new Set();
  return rawRules.map((rule, index) => {
    let id = validateRuleId(rule.id || `auto-rule-${index + 1}`);
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    return {
      id,
      enabled: rule.enabled !== false,
      kitId: validKitId(rule.kitId, kits) || fallbackKitId,
      grantWhen: validateGrantWhen(rule.grantWhen || fallbackGrantWhen),
      lastSeenDays: validateInteger(rule.lastSeenDays ?? 30, "lastSeenDays", 1, 3650)
    };
  });
}

function validateRuleId(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_.:-]{1,80}$/.test(raw)) return raw;
  throw new Error("Invalid Care Package auto-grant rule id");
}

function validateKitName(value) {
  const raw = String(value || "").trim();
  if (raw && raw.length <= 80 && !/[\r\n]/.test(raw)) return raw;
  throw new Error("Invalid Care Package name");
}

function validateKitId(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_.:-]{1,80}$/.test(raw)) return raw;
  throw new Error("Invalid Care Package id");
}

function slugKitName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function validateStarterKitItem(item = {}) {
  const itemName = String(item.itemName || "").trim();
  const itemId = String(item.itemId || "").trim();
  if (!itemName && !itemId) throw new Error("Care Package item requires itemName or itemId");
  if (itemName && (itemName.length > 240 || /[\r\n]/.test(itemName))) throw new Error("Invalid Care Package item name");
  if (itemId && !/^[A-Za-z0-9_./:-]{1,240}$/.test(itemId)) throw new Error("Invalid Care Package item id");
  return {
    itemName,
    itemId,
    quantity: validateInteger(item.quantity ?? 1, "quantity", 1, 1000000),
    durability: validateNumber(item.durability ?? 1, "durability", 0, 1)
  };
}

function validateWelcomeMessage(value) {
  const raw = String(value || "").trim();
  if (raw === "Welcome to the server") return "";
  if (!raw) return "";
  if (raw.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw)) throw new Error("Welcome message must be 1-500 printable characters");
  return raw;
}

function validatePlayerTarget(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_#./:-]{1,160}$/.test(raw)) return raw;
  throw new Error("Invalid player id");
}

function resolveWelcomeWhisperRecipient(playerId, body = {}) {
  const funcomId = String(body.funcomId || body.recipientFuncomId || body.flsId || (/^[A-Za-z0-9_.-]+#\d+$/.test(String(playerId || "")) ? playerId : "")).trim();
  const characterName = String(body.characterName || body.recipientCharacterName || body.userNameTo || "").trim();
  if (!funcomId) throw new Error("Care Package welcome whisper cannot be sent: recipient Funcom ID is unavailable");
  if (!characterName) throw new Error("Care Package welcome whisper cannot be sent: recipient character name is unavailable");
  return { funcomId, characterName };
}

async function ensureCarePackageServerPersona(db) {
  if (!db?.query) throw new Error("Care Package welcome whisper cannot be sent: database is unavailable for Server persona setup");
  const accountsColumns = await tableColumns(db, "accounts");
  if (!accountsColumns.has("id")) throw new Error("Care Package welcome whisper cannot be sent: dune.accounts.id is unavailable for Server persona setup");
  const accountValues = [["id", CARE_PACKAGE_SERVER_PERSONA.accountId]];
  if (accountsColumns.has("user")) accountValues.push(["user", CARE_PACKAGE_SERVER_PERSONA.funcomId]);
  if (accountsColumns.has("funcom_id")) accountValues.push(["funcom_id", CARE_PACKAGE_SERVER_PERSONA.funcomId]);
  if (accountsColumns.has("display_name")) accountValues.push(["display_name", CARE_PACKAGE_SERVER_PERSONA.displayName]);
  if (accountsColumns.has("name")) accountValues.push(["name", CARE_PACKAGE_SERVER_PERSONA.displayName]);
  if (accountValues.length < 2) throw new Error("Care Package welcome whisper cannot be sent: dune.accounts has no Funcom ID column for Server persona setup");
  await upsertDuneRow(db, "accounts", accountValues, "id");

  const encryptedColumns = await tableColumns(db, "encrypted_accounts");
  if (encryptedColumns.has("id") && encryptedColumns.has("encrypted_funcom_id")) {
    await upsertDuneRow(db, "encrypted_accounts", [
      ["id", CARE_PACKAGE_SERVER_PERSONA.accountId],
      ["encrypted_funcom_id", Buffer.from(CARE_PACKAGE_SERVER_PERSONA.hexFlsId, "utf8")]
    ], "id");
  }

  const playerStateColumns = await tableColumns(db, "player_state");
  if (playerStateColumns.has("account_id") && playerStateColumns.has("character_name")) {
    await upsertDuneRow(db, "player_state", [
      ["account_id", CARE_PACKAGE_SERVER_PERSONA.accountId],
      ["character_name", CARE_PACKAGE_SERVER_PERSONA.displayName]
    ], "account_id").catch(() => null);
  }
  return CARE_PACKAGE_SERVER_PERSONA;
}

async function tableColumns(db, table) {
  const result = await db.query(`
    select column_name
    from information_schema.columns
    where table_schema = 'dune' and table_name = $1`, [table]);
  return new Set((result.rows || []).map((row) => row.column_name));
}

async function upsertDuneRow(db, table, entries, conflictColumn) {
  const columns = entries.map(([name]) => name);
  const values = entries.map(([, value]) => value);
  const placeholders = entries.map((_, index) => `$${index + 1}`);
  const updates = columns
    .filter((column) => column !== conflictColumn)
    .map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`);
  await db.query(
    `insert into dune.${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) values (${placeholders.join(", ")}) on conflict (${quoteIdentifier(conflictColumn)}) do update set ${updates.join(", ")}`,
    values
  );
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function validateGrantWhen(value) {
  const raw = String(value || "").trim();
  if (raw === "first_seen") return "last_seen";
  if (["last_seen", "first_online"].includes(raw)) return raw;
  return DEFAULT_CONFIG.grantWhen;
}

function parseTimestamp(value) {
  if (!value) return null;
  if (/^\d+$/.test(String(value))) {
    const number = Number(value);
    const date = new Date(number < 100000000000 ? number * 1000 : number);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function validateInteger(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return number;
}

function validateNumber(value, name, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${name} must be a number from ${min} to ${max}`);
  return number;
}

function configPath(config) {
  return resolve(config.generatedDir, "starter-kit.json");
}

function grantsPath(config) {
  return resolve(config.generatedDir, "starter-kit-grants.jsonl");
}

function readConfig(config) {
  const file = configPath(config);
  if (!existsSync(file)) return DEFAULT_CONFIG;
  return validateStarterKitConfig(JSON.parse(readFileSync(file, "utf8")));
}

function writeConfig(config, value) {
  const file = configPath(config);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
}

function appendGrant(config, row) {
  const file = grantsPath(config);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
}
