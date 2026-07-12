import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { buildDuneArgs, runDune } from "./runner.js";
import { itemRequiresDatabaseGrant, resolveCatalogItem } from "./adminCatalog.js";
import { publishCarePackageWhisper } from "./rmq.js";
import { giveItemToPlayer } from "./duneDb.js";
import { liveItemGrantOk, liveItemGrantWarning } from "./grantResults.js";

const DEFAULT_KIT_ID = "care-package-v1";
const CARE_PACKAGE_SERVER_PERSONA = {
  accountId: "9000002",
  funcomId: "Server#4242",
  hexFlsId: "5E121CE000000001",
  displayName: "Server",
  playerControllerId: "900000201",
  playerStateId: "900000202",
  playerPawnId: "900000203"
};
export const MESSAGE_OF_THE_DAY_PERSONA = {
  accountId: "9000003",
  funcomId: "MOTD#4242",
  hexFlsId: "5E121CE000000002",
  displayName: "Message of the Day",
  playerControllerId: "900000301",
  playerStateId: "900000302",
  playerPawnId: "900000303"
};
const DEFAULT_KIT = {
  id: DEFAULT_KIT_ID,
  name: "Care Package",
  items: [],
  xp: 0,
  sendMessage: ""
};

const DEFAULT_CONFIG = {
  enabled: false,
  version: "",
  activeKitId: "",
  autoGrantKitId: "",
  kits: [],
  items: [],
  xp: 0,
  allowRepeatGrants: false,
  autoGrantEnabled: false,
  autoGrantIntervalSeconds: 60,
  grantWhen: "first_online",
  autoGrantRules: []
};
const firstOnlineClaimLocks = new Map();

class FirstOnlineAlreadyClaimedError extends Error {
  constructor(message, claim) {
    super(message);
    this.name = "FirstOnlineAlreadyClaimedError";
    this.statusCode = 409;
    this.claim = claim;
  }
}

export function carePackageCapabilities() {
  return {
    config: true,
    manualGrant: true,
    bulkGrant: true,
    retryFailedGrant: true,
    automaticScanner: true,
    currency: false,
    reason: "Care Package grants use existing RedBlink dune admin grant-item/grant-item-id and award-xp commands. Automatic grants run when Care Package is enabled and at least one rule is enabled."
  };
}

export function carePackageConfig(config) {
  return readConfig(config);
}

export function saveCarePackageConfig(config, body) {
  const next = validateCarePackageConfig(body);
  writeConfig(config, next);
  return next;
}

export function enableCarePackage(config, enabled) {
  const next = { ...readConfig(config), enabled: Boolean(enabled) };
  writeConfig(config, next);
  return next;
}

export function carePackageHistory(config, limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const file = grantsPath(config);
  if (!existsSync(file)) return { rows: [] };
  const rows = readCarePackageGrantRows(file)
    .map(normalizeHistoryRow)
    .filter((row) => String(row.status || "").toLowerCase() !== "skipped")
    .slice(-safeLimit)
    .reverse();
  return { rows };
}

function readCarePackageGrantRows(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.includes("\u0000"))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function clearCarePackageHistory(config) {
  const file = grantsPath(config);
  const removed = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).length : 0;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "", { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
  return { ok: true, removed, rows: [], firstOnlineClaimsPreserved: true };
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

export function carePackageEligiblePlayers(config, players = [], options = {}) {
  const kitConfig = readConfig(config);
  const rule = options.ruleId ? kitConfig.autoGrantRules.find((entry) => entry.id === options.ruleId) : null;
  const kit = rule ? selectedKit(kitConfig, rule.kitId, rule.grantWhen, rule.lastSeenDays) : selectedKit(kitConfig, kitConfig.autoGrantKitId);
  const history = carePackageHistory(config, 500).rows;
  const claims = readFirstOnlineClaims(config);
  const rows = players.map((player) => eligibilityForPlayer(kit, history, normalizePlayer(player), { claims }));
  return {
    config: kitConfig,
    kit,
    ruleId: rule?.id || "",
    rows: options.onlyEligible ? rows.filter((row) => row.eligible) : rows
  };
}

export async function grantEligibleCarePackages(config, players = [], body = {}, context = {}) {
  const phrase = "GRANT CARE PACKAGE TO ELIGIBLE PLAYERS";
  if (body.confirmation !== phrase) throw new Error(`Confirmation phrase required: ${phrase}`);
  const kitConfig = readConfig(config);
  const kit = selectedKit(kitConfig, kitConfig.autoGrantKitId);
  if (!kit.items.length && !kit.xp) throw new Error("Care Package has no configured items or XP");
  const rows = carePackageEligiblePlayers(config, players).rows;
  const results = [];
  for (const player of rows) {
    if (!player.eligible) {
      const row = skippedGrant(config, kit, player, player.reason || "not eligible", "bulk");
      results.push(row);
      continue;
    }
    try {
      results.push(await grantCarePackage(config, player.action_player_id, {
        confirmation: "GRANT CARE PACKAGE",
        source: "bulk",
        grantWhen: kit.grantWhen,
        characterName: player.character_name,
        actorId: player.actor_id,
        accountId: player.account_id,
        funcomId: player.funcom_id || player.fls_id || player.action_player_id,
        flsId: player.fls_id || player.action_player_id,
        onlineStatus: player.online_status
      }, context));
    } catch (error) {
      const row = failedGrant(config, kit, player, error.message || String(error), "bulk");
      results.push(row);
    }
  }
  return summarizeGrantResults(results);
}

export async function runCarePackageAutoScan(config, players = [], source = "auto", context = {}) {
  const kitConfig = readConfig(config);
  if (!kitConfig.enabled) return { ok: true, skipped: true, reason: "Care Package is disabled", results: [] };
  const rules = kitConfig.autoGrantRules.filter((rule) => rule.enabled);
  if (!rules.length) return { ok: true, skipped: true, reason: "No enabled auto-grant rules", results: [] };
  const results = [];
  const pendingReturns = readPendingReturns(config);
  let pendingChanged = false;
  for (const rule of rules) {
    const kit = selectedKit(kitConfig, rule.kitId, rule.grantWhen, rule.lastSeenDays);
    if (!kit.items.length && !kit.xp) {
      results.push(failedGrant(config, kit, { action_player_id: "", actor_id: "", character_name: "" }, "Care Package has no configured items or XP", source));
      continue;
    }
    const history = carePackageHistory(config, 500).rows;
    const claims = readFirstOnlineClaims(config);
    const rows = players.map((player) => {
      const normalized = normalizePlayer(player);
      if (kit.grantWhen !== "last_seen") return eligibilityForPlayer(kit, history, normalized, { requireOnline: true, claims });
      return lastSeenReturnEligibility(config, pendingReturns, kit, rule, history, normalized);
    });
    for (const player of rows) {
      if (!player.eligible) {
        if (player.markPending) pendingChanged = markPendingReturn(pendingReturns, kit, rule, player) || pendingChanged;
        if (player.clearPending) pendingChanged = clearPendingReturn(pendingReturns, kit, rule, player) || pendingChanged;
        results.push(skippedGrant(config, kit, player, player.reason || "not eligible", source));
        continue;
      }
      try {
        results.push(await grantCarePackage(config, player.action_player_id, {
          confirmation: "GRANT CARE PACKAGE",
          source,
          kitId: kit.id,
          grantWhen: kit.grantWhen,
          characterName: player.character_name,
          actorId: player.actor_id,
          accountId: player.account_id,
          funcomId: player.funcom_id || player.fls_id || player.action_player_id,
          flsId: player.fls_id || player.action_player_id,
          onlineStatus: player.online_status
        }, context));
        if (kit.grantWhen === "last_seen") pendingChanged = clearPendingReturn(pendingReturns, kit, rule, player) || pendingChanged;
      } catch (error) {
        results.push(failedGrant(config, kit, player, error.message || String(error), source));
      }
    }
  }
  if (pendingChanged) writePendingReturns(config, pendingReturns);
  return summarizeGrantResults(results);
}

export async function grantCarePackage(config, playerId, body = {}, context = {}) {
  const phrase = "GRANT CARE PACKAGE";
  if (body.confirmation !== phrase) throw new Error(`Confirmation phrase required: ${phrase}`);
  const kitConfig = readConfig(config);
  const source = body.source || "manual";
  const kit = selectedKit(kitConfig, body.kitId || (source === "manual" ? kitConfig.activeKitId : kitConfig.autoGrantKitId));
  validatePlayerTarget(playerId);
  if (!kit.items.length && !kit.xp) throw new Error("Care Package has no configured items or XP");
  const grantIdentity = {
    action_player_id: playerId,
    actor_id: body.actorId || body.actor_id || "",
    account_id: body.accountId || body.account_id || "",
    funcom_id: body.funcomId || body.funcom_id || "",
    fls_id: body.flsId || body.fls_id || "",
    character_name: body.characterName || body.character_name || ""
  };
  const useFirstOnlineClaim = firstOnlineClaimApplies(config, kit, source, body);
  const firstOnlineReservation = useFirstOnlineClaim
    ? await withFirstOnlineClaimLock(firstOnlineClaimKey(grantIdentity), () => reserveFirstOnlineClaim(config, kit, source, playerId, body))
    : null;
  if (firstOnlineReservation?.existing) {
    return skippedGrant(config, kit, {
      action_player_id: playerId,
      actor_id: grantIdentity.actor_id,
      account_id: grantIdentity.account_id,
      funcom_id: grantIdentity.funcom_id,
      fls_id: grantIdentity.fls_id,
      character_name: grantIdentity.character_name,
      online_status: body.onlineStatus || body.online_status || ""
    }, "Already received first-online Care Package", source);
  }
  if (source !== "manual" && useFirstOnlineClaim && hasSuccessfulFirstOnlineGrant(carePackageHistory(config, 500).rows, {
    action_player_id: playerId,
    actor_id: grantIdentity.actor_id,
    account_id: grantIdentity.account_id,
    funcom_id: grantIdentity.funcom_id,
    fls_id: grantIdentity.fls_id
  })) {
    releaseFirstOnlineClaim(config, firstOnlineReservation);
    throw new Error(`A first-online Care Package was already granted to ${playerId}`);
  }
  if (source !== "manual" && hasSuccessfulGrant(config, playerId, kit.id, body.actorId, body)) {
    releaseFirstOnlineClaim(config, firstOnlineReservation);
    throw new Error(`Care Package ${kit.name} was already granted to ${playerId}`);
  }

  const grantId = randomUUID();
  const startedAt = new Date().toISOString();
  const results = [];
  if (kit.sendMessage) {
    try {
      const recipient = resolveWelcomeWhisperRecipient(playerId, body);
      const persona = context.db ? await ensureCarePackageServerPersona(context.db) : CARE_PACKAGE_SERVER_PERSONA;
      const result = config.mockMode
        ? { code: 0, stdout: "mock care package message whisper\n", stderr: "", payload: null }
        : await publishCarePackageWhisper(config, {
            recipientFuncomId: recipient.funcomId,
            recipientCharacterName: recipient.characterName,
            senderFuncomId: persona.funcomId,
            senderHexFlsId: persona.hexFlsId,
            message: kit.sendMessage
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
  for (const item of kit.items) {
    try {
      const resolved = resolveCatalogItem(config.repoRoot, item.itemId ? { itemId: item.itemId } : { itemName: item.itemName });
      const operation = item.itemId ? "adminGiveItemId" : "adminGiveItem";
      const payload = {
        playerId,
        itemId: resolved.itemId,
        itemName: resolved.name,
        quantity: item.quantity,
        quality: item.quality,
        durability: 1,
        augments: [],
        augmentQuality: 1
      };
      const needsDatabaseGrant = itemRequiresDatabaseGrant(resolved);
      if (needsDatabaseGrant && context.db && body.actorId) {
        const result = config.mockMode
          ? { ok: true, inserted: { template_id: resolved.itemId, stack_size: item.quantity, quality_level: item.quality } }
          : await (context.dbGiveItemToPlayer || ((actorId, itemPayload) => giveItemToPlayer(context.db, actorId, itemPayload)))(body.actorId, {
              templateId: resolved.itemId,
              quantity: item.quantity,
              quality: item.quality,
              augments: [],
              augmentQuality: payload.augmentQuality,
              allowOnlinePreAugmented: source === "manual"
            });
        results.push({ ok: true, operation: "dbGiveItemToPlayer", item: payload, result, warning: result?.requiresRelog ? "Relog required before the item appears correctly." : undefined });
      } else {
        const command = buildDuneArgs(operation, payload);
        const result = config.mockMode ? { code: 0, stdout: "mock package item grant\n", stderr: "" } : await runDune(config, command);
        const warnings = [
          liveItemGrantWarning(result)
        ].filter(Boolean);
        results.push({
          ok: liveItemGrantOk(result),
          operation,
          item: payload,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.code,
          warning: warnings.join(" ") || undefined
        });
      }
    } catch (error) {
      results.push({ ok: false, item, error: error.message || String(error) });
    }
  }
  if (kit.xp > 0) {
    try {
      const payload = { playerId, amount: kit.xp };
      const command = buildDuneArgs("adminAddXp", payload);
      const result = config.mockMode ? { code: 0, stdout: "mock package xp grant\n", stderr: "" } : await runDune(config, command);
      results.push({ ok: true, operation: "adminAddXp", amount: kit.xp, stdout: result.stdout, stderr: result.stderr, exitCode: result.code });
    } catch (error) {
      results.push({ ok: false, operation: "adminAddXp", amount: kit.xp, error: error.message || String(error) });
    }
  }
  const aggregate = summarizeActionResults(results);
  const row = {
    id: grantId,
    playerId,
    action_player_id: playerId,
    actor_id: body.actorId || body.actor_id || "",
    account_id: body.accountId || body.account_id || "",
    funcom_id: body.funcomId || body.funcom_id || "",
    fls_id: body.flsId || body.fls_id || "",
    character_name: body.characterName || body.character_name || "",
    online_status: body.onlineStatus || body.online_status || "",
    source,
    version: kit.id,
    kitId: kit.id,
    kitName: kit.name,
    grantWhen: body.grantWhen || kit.grantWhen || "",
    status: aggregate.status,
    ok: aggregate.ok,
    summary: aggregate.summary,
    startedAt,
    finishedAt: new Date().toISOString(),
    results
  };
  appendGrant(config, row);
  if (firstOnlineReservation?.claimed && !hasDeliveredCarePackageContent(row)) {
    releaseFirstOnlineClaim(config, firstOnlineReservation);
  }
  return row;
}

export async function retryCarePackageGrant(config, grantId, body = {}, context = {}) {
  const phrase = "RETRY CARE PACKAGE";
  if (body.confirmation !== phrase) throw new Error(`Confirmation phrase required: ${phrase}`);
  const existing = carePackageHistory(config, 500).rows.find((row) => row.id === grantId);
  if (!existing) throw new Error("Care Package grant was not found");
  if (existing.ok) throw new Error("Only failed Care Package grants can be retried");
  return grantCarePackage(config, existing.playerId, { confirmation: "GRANT CARE PACKAGE", kitId: existing.kitId || existing.version, characterName: existing.character_name, actorId: existing.actor_id }, context);
}

export function validateCarePackageConfig(body = {}) {
  const enabled = Boolean(body.enabled);
  const kits = validateCarePackages(body);
  const activeKitId = validKitId(body.activeKitId, kits) || kits[0]?.id || "";
  const autoGrantKitId = validKitId(body.autoGrantKitId, kits) || activeKitId;
  const activeKit = kits.find((kit) => kit.id === activeKitId) || kits[0] || { id: "", items: [], xp: 0 };
  const grantWhen = validateGrantWhen(body.grantWhen || DEFAULT_CONFIG.grantWhen);
  const autoGrantRules = validateAutoGrantRules(body, kits, autoGrantKitId, grantWhen);
  return {
    enabled,
    version: activeKit.id,
    activeKitId,
    autoGrantKitId,
    kits,
    items: activeKit.items,
    xp: activeKit.xp,
    allowRepeatGrants: false,
    autoGrantEnabled: autoGrantRules.some((rule) => rule.enabled),
    autoGrantIntervalSeconds: validateInteger(body.autoGrantIntervalSeconds ?? DEFAULT_CONFIG.autoGrantIntervalSeconds, "autoGrantIntervalSeconds", 60, 3600),
    grantWhen,
    autoGrantRules
  };
}

function eligibilityForPlayer(kit, history, player, options = {}) {
  if (!player.action_player_id) return { ...player, eligible: false, reason: "Missing admin action ID" };
  if (kit.grantWhen === "first_online" && String(player.online_status || "").toLowerCase() !== "online") {
    return { ...player, eligible: false, reason: "Not currently online" };
  }
  if (kit.grantWhen === "first_online" && firstOnlineClaimForPlayer(options.claims || options.firstOnlineClaims, player)) {
    return { ...player, eligible: false, reason: "Already received first-online Care Package" };
  }
  if (kit.grantWhen === "first_online" && hasSuccessfulFirstOnlineGrant(history, player)) {
    return { ...player, eligible: false, reason: "Already received first-online Care Package" };
  }
  if (kit.grantWhen === "last_seen") {
    if (options.requireOnline && String(player.online_status || "").toLowerCase() !== "online") {
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
  if (history.some((row) => isSuccessfulGrant(row) && (row.kitId || row.version) === kit.id && grantMatchesPlayer(row, player))) {
    return { ...player, eligible: false, reason: `Already granted ${kit.name}` };
  }
  return { ...player, eligible: true, reason: "" };
}

function lastSeenReturnEligibility(config, pendingReturns, kit, rule, history, player) {
  const staleEligibility = eligibilityForPlayer(kit, history, player);
  const online = String(player.online_status || "").toLowerCase() === "online";
  const key = pendingReturnKey(kit, rule, player);
  const pending = Boolean(pendingReturns[key]);
  if (staleEligibility.eligible && !online) {
    return { ...staleEligibility, eligible: false, reason: "Waiting for player to return online", markPending: true };
  }
  if (online && pending) {
    if (hasSuccessfulGrant(config, player.action_player_id, kit.id, player.actor_id, player)) {
      return { ...player, eligible: false, reason: `Already granted ${kit.name}`, clearPending: true };
    }
    return { ...player, eligible: true, reason: "Returning player qualified" };
  }
  if (online && staleEligibility.eligible) return staleEligibility;
  return staleEligibility;
}

function pendingReturnKey(kit, rule, player) {
  const playerKey = String(player.action_player_id || player.actor_id || "").trim();
  return `${kit.id}:${rule.id}:${playerKey}`;
}

function markPendingReturn(pendingReturns, kit, rule, player) {
  const key = pendingReturnKey(kit, rule, player);
  const next = {
    kitId: kit.id,
    kitName: kit.name,
    ruleId: rule.id,
    action_player_id: player.action_player_id || "",
    actor_id: player.actor_id || "",
    character_name: player.character_name || "",
    last_seen: player.last_seen || "",
    qualifiedAt: pendingReturns[key]?.qualifiedAt || new Date().toISOString()
  };
  if (JSON.stringify(pendingReturns[key] || {}) === JSON.stringify(next)) return false;
  pendingReturns[key] = next;
  return true;
}

function clearPendingReturn(pendingReturns, kit, rule, player) {
  const key = pendingReturnKey(kit, rule, player);
  if (!pendingReturns[key]) return false;
  delete pendingReturns[key];
  return true;
}

function grantMatchesPlayer(row, player) {
  const rowStableIds = stableIdentityValues(row);
  const playerStableIds = stableIdentityValues(player);
  for (const id of rowStableIds) {
    if (playerStableIds.has(id)) return true;
  }
  if (rowStableIds.size || playerStableIds.size) return false;

  const rowActorId = String(row.actor_id || row.actorId || "").trim();
  const playerActorId = String(player.actor_id || player.player_pawn_id || "").trim();
  return Boolean(rowActorId && playerActorId && rowActorId === playerActorId);
}

function hasSuccessfulFirstOnlineGrant(history, player) {
  return history.some((row) => isSuccessfulGrant(row) && isFirstOnlineGrantRow(row) && grantMatchesPlayer(row, player));
}

function isFirstOnlineGrantRow(row = {}) {
  const grantWhen = String(row.grantWhen || "").trim();
  if (grantWhen) return grantWhen === "first_online";
  return ["auto", "bulk"].includes(String(row.source || "").trim());
}

function stableIdentityValues(entity = {}) {
  return new Set([
    entity.playerId,
    entity.action_player_id,
    entity.funcom_id,
    entity.funcomId,
    entity.fls_id,
    entity.flsId,
    entity.account_id,
    entity.accountId
  ].map((value) => String(value || "").trim()).filter(Boolean));
}

function firstOnlineClaimKey(entity = {}) {
  return firstOnlineIdentityKeys(entity)[0] || "";
}

function firstOnlineClaimForPlayer(claims, player) {
  if (!claims || typeof claims !== "object") return null;
  const players = claims.players || {};
  const aliases = claims.aliases || {};
  for (const key of firstOnlineIdentityKeys(player)) {
    const primary = aliases[key] || key;
    if (players[primary]) return players[primary];
  }
  return null;
}

function firstOnlineClaimIdentity(entity = {}) {
  return {
    account_id: String(entity.account_id || entity.accountId || "").trim(),
    funcom_id: String(entity.funcom_id || entity.funcomId || "").trim(),
    fls_id: String(entity.fls_id || entity.flsId || "").trim(),
    action_player_id: String(entity.action_player_id || entity.playerId || "").trim(),
    actor_id: String(entity.actor_id || entity.actorId || entity.player_pawn_id || "").trim()
  };
}

async function withFirstOnlineClaimLock(key, fn) {
  if (!key) return await fn();
  const previous = firstOnlineClaimLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolveRelease) => { release = resolveRelease; });
  const chain = previous.then(() => current, () => current);
  firstOnlineClaimLocks.set(key, chain);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (firstOnlineClaimLocks.get(key) === chain) firstOnlineClaimLocks.delete(key);
  }
}

function firstOnlineClaimApplies(config, kit, source, body = {}) {
  const kitConfig = readConfig(config);
  const grantWhen = body.grantWhen || kit.grantWhen || kitConfig.grantWhen;
  if (source !== "manual") return grantWhen === "first_online";
  if (body.grantWhen === "first_online") return true;
  return kitConfig.autoGrantRules.some((rule) => rule.enabled && rule.grantWhen === "first_online" && rule.kitId === kit.id);
}

function reserveFirstOnlineClaim(config, kit, source, playerId, body = {}) {
  const identity = firstOnlineClaimIdentity({
    ...body,
    action_player_id: playerId,
    actor_id: body.actorId || body.actor_id || "",
    account_id: body.accountId || body.account_id || "",
    funcom_id: body.funcomId || body.funcom_id || "",
    fls_id: body.flsId || body.fls_id || ""
  });
  const keys = firstOnlineIdentityKeys(identity);
  const key = keys[0] || "";
  if (!key) return null;
  const claims = readFirstOnlineClaims(config);
  const existing = firstOnlineClaimForPlayer(claims, identity);
  if (existing) {
    if (source === "manual") return { key, claimed: false, existing };
    throw new FirstOnlineAlreadyClaimedError(`A first-online Care Package was already granted to ${playerId}`, existing);
  }
  const claim = {
    claimedAt: new Date().toISOString(),
    source,
    kitId: kit.id,
    kitName: kit.name,
    characterName: String(body.characterName || body.character_name || "").trim(),
    identities: identity
  };
  claims.players[key] = claim;
  claims.aliases ||= {};
  for (const alias of keys) claims.aliases[alias] = key;
  writeFirstOnlineClaims(config, claims);
  return { key, claimed: true, claim };
}

function releaseFirstOnlineClaim(config, reservation) {
  if (!reservation?.claimed || !reservation.key) return;
  const claims = readFirstOnlineClaims(config);
  if (!claims.players[reservation.key]) return;
  delete claims.players[reservation.key];
  for (const [alias, primary] of Object.entries(claims.aliases || {})) {
    if (primary === reservation.key) delete claims.aliases[alias];
  }
  writeFirstOnlineClaims(config, claims);
}

function firstOnlineIdentityKeys(entity = {}) {
  const identities = firstOnlineClaimIdentity(entity);
  return [
    ["account_id", identities.account_id],
    ["funcom_id", identities.funcom_id],
    ["fls_id", identities.fls_id],
    ["action_player_id", identities.action_player_id],
    ["actor_id", identities.actor_id]
  ]
    .map(([kind, value]) => [kind, String(value || "").trim().toLowerCase()])
    .filter(([, value]) => value)
    .map(([kind, value]) => `${kind}:${value}`);
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

function hasSuccessfulGrant(config, playerId, kitId, actorId = "", identity = {}) {
  return carePackageHistory(config, 500).rows.some((row) => isSuccessfulGrant(row) && (row.kitId || row.version) === kitId && grantMatchesPlayer(row, {
    action_player_id: playerId,
    actor_id: actorId,
    account_id: identity.account_id || identity.accountId || "",
    funcom_id: identity.funcom_id || identity.funcomId || "",
    fls_id: identity.fls_id || identity.flsId || ""
  }));
}

function isSuccessfulGrant(row) {
  return row?.status === "granted" || (row?.ok === true && !row?.status) || hasDeliveredCarePackageContent(row);
}

function hasDeliveredCarePackageContent(row = {}) {
  if (!Array.isArray(row.results)) return false;
  return row.results.some((result) => result?.ok === true && result.operation !== "carePackageWelcomeWhisper");
}

function skippedGrant(config, kit, player, reason, source) {
  const now = new Date().toISOString();
  const row = { id: randomUUID(), playerId: player.action_player_id || "", action_player_id: player.action_player_id || "", actor_id: player.actor_id || "", account_id: player.account_id || "", funcom_id: player.funcom_id || "", fls_id: player.fls_id || "", character_name: player.character_name || "", online_status: player.online_status || "", source, version: kit.id, kitId: kit.id, kitName: kit.name, status: "skipped", ok: true, summary: `Skipped: ${reason}`, startedAt: now, finishedAt: now, reason, results: [] };
  appendGrant(config, row);
  return row;
}

function failedGrant(config, kit, player, reason, source) {
  const now = new Date().toISOString();
  const row = { id: randomUUID(), playerId: player.action_player_id || "", action_player_id: player.action_player_id || "", actor_id: player.actor_id || "", account_id: player.account_id || "", funcom_id: player.funcom_id || "", fls_id: player.fls_id || "", character_name: player.character_name || "", online_status: player.online_status || "", source, version: kit.id, kitId: kit.id, kitName: kit.name, status: "failed", ok: false, summary: `Failed: ${reason}`, startedAt: now, finishedAt: now, reason, results: [{ ok: false, error: reason }] };
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
  const warnings = results
    .filter((result) => result.ok && result.warning)
    .map((result) => `${describeAction(result)}: ${result.warning}`)
    .slice(0, 3);
  return {
    ok: failureCount === 0,
    status,
    summary: `${successCount} succeeded, ${failureCount} failed${failed.length ? `; ${failed.join("; ")}` : ""}${warnings.length ? `; ${warnings.join("; ")}` : ""}`
  };
}

function describeAction(result) {
  if (result.item) return `${result.item.itemName || result.item.itemId || "Item"} x${result.item.quantity || 1}`;
  if (result.operation === "adminAddXp") return `${result.amount || 0} XP`;
  if (result.operation === "carePackageWelcomeWhisper") return "Message whisper";
  return result.operation || "Care Package action";
}

function selectedKit(config, kitId, grantWhen = config.grantWhen, lastSeenDays = 30) {
  const kit = config.kits.find((entry) => entry.id === kitId) || config.kits.find((entry) => entry.id === config.activeKitId) || config.kits[0] || DEFAULT_KIT;
  return { ...kit, grantWhen, lastSeenDays };
}

function validateCarePackages(body = {}) {
  const hasLegacyPackage = !Array.isArray(body.kits) && (
    (Array.isArray(body.items) && body.items.length > 0) ||
    (Object.prototype.hasOwnProperty.call(body, "xp") && Number(body.xp) !== 0) ||
    Boolean(validateSendMessage(body.sendMessage || ""))
  );
  const rawKits = Array.isArray(body.kits)
    ? body.kits
    : hasLegacyPackage ? [{
        id: /^[A-Za-z0-9_.:-]{1,80}$/.test(String(body.version || "")) ? body.version : DEFAULT_KIT_ID,
        name: body.name || "Care Package",
        items: body.items,
        xp: body.xp,
        sendMessage: body.sendMessage
      }] : [];
  if (rawKits.length > 12) throw new Error("Care Package supports at most 12 packages");
  const used = new Set();
  return rawKits.map((kit, index) => {
    const fallbackName = index === 0 ? "Care Package" : `Care Package ${index + 1}`;
    const name = validateKitName(Object.prototype.hasOwnProperty.call(kit, "name") ? kit.name : fallbackName);
    let id = validateKitId(kit.id || slugKitName(name) || `care-package-${index + 1}`);
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    const rawItems = Array.isArray(kit.items) ? kit.items : [];
    if (rawItems.length > 25) throw new Error("Care Package supports at most 25 item entries per package");
    return {
      id,
      name,
      items: rawItems.map(validateCarePackageItem),
      xp: validateInteger(kit.xp ?? 0, "xp", 0, 100000000),
      sendMessage: validateSendMessage(kit.sendMessage ?? "")
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
    : [];
  if (rawRules.length > 24) throw new Error("Care Package supports at most 24 auto-grant rules");
  const used = new Set();
  return rawRules.map((rule, index) => {
    let id = validateRuleId(rule.id || `auto-rule-${index + 1}`);
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    return {
      id,
      enabled: rule.enabled === true,
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

function validateCarePackageItem(item = {}) {
  const itemName = String(item.itemName || "").trim();
  const itemId = String(item.itemId || "").trim();
  if (!itemName && !itemId) throw new Error("Care Package item requires itemName or itemId");
  if (itemName && (itemName.length > 240 || /[\r\n]/.test(itemName))) throw new Error("Invalid Care Package item name");
  if (itemId && !/^[A-Za-z0-9_./:-]{1,240}$/.test(itemId)) throw new Error("Invalid Care Package item id");
  const normalized = {
    itemName,
    itemId,
    quantity: validateInteger(item.quantity ?? 1, "quantity", 1, 1000000),
    quality: 0,
    durability: 1,
    augments: []
  };
  return normalized;
}

function validateSendMessage(value) {
  const raw = String(value || "").trim();
  if (raw === "Welcome to the server") return "";
  if (!raw) return "";
  if (raw.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw)) throw new Error("Send message must be 1-500 printable characters");
  return raw;
}

function validatePlayerTarget(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_#./:-]{1,160}$/.test(raw)) return raw;
  throw new Error("Invalid player id");
}

function resolveWelcomeWhisperRecipient(playerId, body = {}) {
  const funcomId = String(body.funcomId || body.recipientFuncomId || body.flsId || (/^[A-Za-z0-9_.-]+#\d+$/.test(String(playerId || "")) ? playerId : "")).trim();
  const flsId = String(body.flsId || body.recipientFlsId || (/^[A-Fa-f0-9]{16,64}$/.test(String(playerId || "")) ? playerId : "")).trim();
  const characterName = String(body.characterName || body.recipientCharacterName || body.userNameTo || "").trim();
  if (!funcomId) throw new Error("Care Package message whisper cannot be sent: recipient Funcom ID is unavailable");
  if (!characterName) throw new Error("Care Package message whisper cannot be sent: recipient character name is unavailable");
  return { funcomId, characterName, flsId, queue: flsId ? `${flsId}_queue` : "" };
}

export async function ensureCarePackageServerPersona(db) {
  return ensureSyntheticWhisperPersona(db, CARE_PACKAGE_SERVER_PERSONA, "Care Package message whisper");
}

export async function ensureMessageOfTheDayPersona(db) {
  return ensureSyntheticWhisperPersona(db, MESSAGE_OF_THE_DAY_PERSONA, "Message of the Day whisper");
}

async function ensureSyntheticWhisperPersona(db, persona, label) {
  if (!db?.query) throw new Error(`${label} cannot be sent: database is unavailable for ${persona.displayName} persona setup`);
  const encryptedColumns = await tableColumns(db, "encrypted_accounts");
  if (encryptedColumns.has("id")) {
    const encryptedValues = [["id", persona.accountId]];
    if (encryptedColumns.has("user")) encryptedValues.push(["user", persona.hexFlsId]);
    if (encryptedColumns.has("encrypted_funcom_id")) encryptedValues.push(["encrypted_funcom_id", { rawSql: "dune.encrypt_user_data($VALUE)", value: persona.funcomId }]);
    if (encryptedColumns.has("takeoverable")) encryptedValues.push(["takeoverable", false]);
    if (encryptedColumns.has("platform_id")) encryptedValues.push(["platform_id", "redblink-console"]);
    if (encryptedColumns.has("platform_name")) encryptedValues.push(["platform_name", "RedBlink Console"]);
    if (encryptedValues.length > 1) await upsertDuneRow(db, "encrypted_accounts", encryptedValues, "id");
  }

  const accountsColumns = await tableColumns(db, "accounts");
  if (!accountsColumns.has("id")) throw new Error(`${label} cannot be sent: dune.accounts.id is unavailable for ${persona.displayName} persona setup`);
  if (await isWritableDuneRelation(db, "accounts")) {
    const accountValues = [["id", persona.accountId]];
    if (accountsColumns.has("user")) accountValues.push(["user", persona.hexFlsId]);
    if (accountsColumns.has("funcom_id")) accountValues.push(["funcom_id", persona.funcomId]);
    if (accountsColumns.has("display_name")) accountValues.push(["display_name", persona.displayName]);
    if (accountsColumns.has("name")) accountValues.push(["name", persona.displayName]);
    if (accountValues.length < 2) throw new Error(`${label} cannot be sent: dune.accounts has no Funcom ID column for ${persona.displayName} persona setup`);
    await upsertDuneRow(db, "accounts", accountValues, "id");
  } else if (!encryptedColumns.has("encrypted_funcom_id")) {
    throw new Error(`${label} cannot be sent: writable ${persona.displayName} persona account table is unavailable`);
  }

  const playerStateColumns = await tableColumns(db, "player_state");
  if (playerStateColumns.has("account_id") && playerStateColumns.has("character_name") && await isWritableDuneRelation(db, "player_state")) {
    await upsertDuneRow(db, "player_state", [
      ["account_id", persona.accountId],
      ["character_name", persona.displayName]
    ], "account_id").catch(() => null);
  }
  await ensureSyntheticWhisperPersonaPlayerRows(db, persona);
  return await resolveSyntheticWhisperPersona(db, persona, label);
}

async function ensureSyntheticWhisperPersonaPlayerRows(db, persona) {
  await ensureSyntheticWhisperPersonaActors(db, persona);

  const encryptedPlayerStateColumns = await tableColumns(db, "encrypted_player_state");
  if (encryptedPlayerStateColumns.has("account_id") && encryptedPlayerStateColumns.has("encrypted_character_name")) {
    if (encryptedPlayerStateColumns.has("id")) {
      await db.query(`
        delete from dune."encrypted_player_state"
        where "account_id" = $1
          and "id" <> (select min("id") from dune."encrypted_player_state" where "account_id" = $1)`, [persona.accountId]);
    }
    const playerStateValues = [
      ["account_id", persona.accountId],
      ["encrypted_character_name", { rawSql: "dune.encrypt_user_data($VALUE)" }]
    ];
    if (encryptedPlayerStateColumns.has("last_avatar_activity")) playerStateValues.push(["last_avatar_activity", new Date(0)]);
    if (encryptedPlayerStateColumns.has("player_controller_id")) playerStateValues.push(["player_controller_id", persona.playerControllerId]);
    if (encryptedPlayerStateColumns.has("player_pawn_id")) playerStateValues.push(["player_pawn_id", persona.playerPawnId]);
    if (encryptedPlayerStateColumns.has("player_state_id")) playerStateValues.push(["player_state_id", persona.playerStateId]);
    if (encryptedPlayerStateColumns.has("life_state")) playerStateValues.push(["life_state", { rawSql: "$VALUE::dune.playerlifestate", value: "Alive" }]);
    if (encryptedPlayerStateColumns.has("online_status")) playerStateValues.push(["online_status", { rawSql: "$VALUE::dune.playerconnectionstatus", value: "Offline" }]);
    if (encryptedPlayerStateColumns.has("server_id")) playerStateValues.push(["server_id", { rawSql: "(select server_id from dune.encrypted_player_state where server_id is not null limit 1)" }]);
    if (encryptedPlayerStateColumns.has("previous_server_partition_id")) playerStateValues.push(["previous_server_partition_id", 1]);
    if (encryptedPlayerStateColumns.has("is_coriolis_processed")) playerStateValues.push(["is_coriolis_processed", false]);
    if (encryptedPlayerStateColumns.has("return_dimension_index")) playerStateValues.push(["return_dimension_index", 0]);
    if (encryptedPlayerStateColumns.has("home_dimension_index")) playerStateValues.push(["home_dimension_index", 0]);
    await upsertDuneRow(db, "encrypted_player_state", playerStateValues, "account_id", {
      encrypted_character_name: persona.displayName
    });
  }
}

async function ensureSyntheticWhisperPersonaActors(db, persona) {
  const actorColumns = await tableColumns(db, "actors");
  if (!actorColumns.has("id")) return;
  const actors = [
    [persona.playerControllerId, "/Game/Dune/Characters/Player/BP_DunePlayerController.BP_DunePlayerController_C"],
    [persona.playerStateId, "/Script/DuneSandbox.DunePlayerState"],
    [persona.playerPawnId, "/Game/Dune/Characters/Player/BP_DunePlayerCharacter.BP_DunePlayerCharacter_C"]
  ];
  for (const [id, actorClass] of actors) {
    const values = [["id", id]];
    if (actorColumns.has("class")) values.push(["class", actorClass]);
    if (actorColumns.has("map")) values.push(["map", "HaggaBasin"]);
    if (actorColumns.has("partition_id")) values.push(["partition_id", 1]);
    if (actorColumns.has("dimension_index")) values.push(["dimension_index", 0]);
    if (actorColumns.has("gas_attributes")) values.push(["gas_attributes", {}]);
    if (actorColumns.has("properties")) values.push(["properties", {}]);
    if (actorColumns.has("owner_account_id")) values.push(["owner_account_id", persona.accountId]);
    if (actorColumns.has("serial")) values.push(["serial", 1]);
    await upsertDuneRow(db, "actors", values, "id");
  }
}

async function resolveSyntheticWhisperPersona(db, persona, label) {
  const result = await db.query(`
    select coalesce("user", '') as hex_fls_id,
           coalesce(funcom_id, '') as funcom_id
    from dune.accounts
    where id = $1
    limit 1`, [persona.accountId]);
  const row = result.rows?.[0] || {};
  const hexFlsId = String(row.hex_fls_id || "").trim();
  const funcomId = String(row.funcom_id || "").trim();
  if (!/^[A-Fa-f0-9]{16,64}$/.test(hexFlsId)) throw new Error(`${label} cannot be sent: ${persona.displayName} sender hex FLS ID was not resolved from the database`);
  if (!funcomId) throw new Error(`${label} cannot be sent: ${persona.displayName} sender Funcom ID was not resolved from the database`);
  return {
    ...persona,
    hexFlsId,
    funcomId
  };
}

async function isWritableDuneRelation(db, table) {
  const result = await db.query(`
    select table_type
    from information_schema.tables
    where table_schema = 'dune' and table_name = $1`, [table]);
  return String(result.rows?.[0]?.table_type || "").toUpperCase() === "BASE TABLE";
}

async function tableColumns(db, table) {
  const result = await db.query(`
    select column_name
    from information_schema.columns
    where table_schema = 'dune' and table_name = $1`, [table]);
  return new Set((result.rows || []).map((row) => row.column_name));
}

async function upsertDuneRow(db, table, entries, conflictColumn, rawSqlValues = {}) {
  const columns = entries.map(([name]) => name);
  const values = [];
  const placeholders = entries.map(([name, value]) => {
    const parameterValue = Object.prototype.hasOwnProperty.call(rawSqlValues, name) ? rawSqlValues[name] : value?.value ?? value;
    if (value && typeof value === "object" && value.rawSql && !value.rawSql.includes("$VALUE")) return value.rawSql;
    values.push(parameterValue);
    const placeholder = `$${values.length}`;
    if (value && typeof value === "object" && value.rawSql) return value.rawSql.replace("$VALUE", placeholder);
    return placeholder;
  });
  const updates = columns
    .filter((column) => column !== conflictColumn)
    .map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`);
  const tableName = quoteIdentifier(table);
  const conflictName = quoteIdentifier(conflictColumn);
  try {
    await db.query(
      `insert into dune.${tableName} (${columns.map(quoteIdentifier).join(", ")}) values (${placeholders.join(", ")}) on conflict (${conflictName}) do update set ${updates.join(", ")}`,
      values
    );
  } catch (error) {
    if (!/no unique or exclusion constraint matching the ON CONFLICT specification/i.test(String(error.message || error))) throw error;
    const conflictIndex = columns.indexOf(conflictColumn);
    if (conflictIndex < 0) throw error;
    const assignments = entries
      .map(([name], index) => ({ name, placeholder: placeholders[index] }))
      .filter((entry) => entry.name !== conflictColumn)
      .map((entry) => `${quoteIdentifier(entry.name)} = ${entry.placeholder}`);
    if (assignments.length) {
      await db.query(
        `update dune.${tableName} set ${assignments.join(", ")} where ${conflictName} = ${placeholders[conflictIndex]}`,
        values
      );
    }
    await db.query(
      `insert into dune.${tableName} (${columns.map(quoteIdentifier).join(", ")}) select ${placeholders.join(", ")} where not exists (select 1 from dune.${tableName} where ${conflictName} = ${placeholders[conflictIndex]})`,
      values
    );
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function validateGrantWhen(value) {
  const raw = String(value || "").trim();
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
  return resolve(config.generatedDir, "care-package.json");
}

function grantsPath(config) {
  return resolve(config.generatedDir, "care-package-grants.jsonl");
}

function pendingReturnsPath(config) {
  return resolve(config.generatedDir, "care-package-pending-returns.json");
}

function firstOnlineClaimsPath(config) {
  return resolve(config.generatedDir, "care-package-first-online-claims.json");
}

function readConfig(config) {
  const file = configPath(config);
  if (!existsSync(file)) return DEFAULT_CONFIG;
  return validateCarePackageConfig(JSON.parse(readFileSync(file, "utf8")));
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

function readPendingReturns(config) {
  const file = pendingReturnsPath(config);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writePendingReturns(config, value) {
  const file = pendingReturnsPath(config);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
}

function readFirstOnlineClaims(config) {
  const file = firstOnlineClaimsPath(config);
  if (!existsSync(file)) return { version: 1, players: {}, aliases: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const players = parsed?.players && typeof parsed.players === "object" && !Array.isArray(parsed.players) ? parsed.players : {};
    const aliases = parsed?.aliases && typeof parsed.aliases === "object" && !Array.isArray(parsed.aliases) ? parsed.aliases : {};
    return { version: 1, players, aliases };
  } catch {
    return { version: 1, players: {}, aliases: {} };
  }
}

function writeFirstOnlineClaims(config, value) {
  const file = firstOnlineClaimsPath(config);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ version: 1, players: value.players || {}, aliases: value.aliases || {} }, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
}
