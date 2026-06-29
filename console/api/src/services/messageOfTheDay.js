import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { publishCarePackageWhisper, validateBroadcastMessage } from "../rmq.js";
import { ensureMessageOfTheDayPersona, MESSAGE_OF_THE_DAY_PERSONA } from "../carePackage.js";

const DEFAULT_MESSAGE_OF_THE_DAY = {
  enabled: false,
  title: "",
  message: ""
};

const EMPTY_STATE = { delivered: {} };

export function readMessageOfTheDay(config) {
  return {
    settings: readSettings(config),
    defaults: { ...DEFAULT_MESSAGE_OF_THE_DAY }
  };
}

export function saveMessageOfTheDay(config, body = {}) {
  const settings = normalizeSettings(body.settings || body);
  writeJson(settingsPath(config), settings, 0o600);
  return { settings, defaults: { ...DEFAULT_MESSAGE_OF_THE_DAY } };
}

export function restoreMessageOfTheDay(config) {
  const settings = { ...DEFAULT_MESSAGE_OF_THE_DAY };
  writeJson(settingsPath(config), settings, 0o600);
  writeJson(statePath(config), EMPTY_STATE, 0o600);
  return { settings, defaults: { ...DEFAULT_MESSAGE_OF_THE_DAY } };
}

export function primeMessageOfTheDayOnlineState(config, players) {
  const delivered = {};
  for (const player of (players || []).map(normalizePlayer).filter((entry) => entry.key && entry.characterName)) {
    delivered[player.key] = {
      deliveredAt: new Date().toISOString(),
      characterName: player.characterName,
      sessionKey: player.sessionKey,
      primed: true
    };
  }
  writeJson(statePath(config), { delivered }, 0o600);
  return { delivered: Object.keys(delivered).length };
}

export async function runMessageOfTheDayScan(config, players, context = {}) {
  const settings = readSettings(config);
  if (!settings.enabled) return { ok: true, skipped: true, reason: "disabled", sent: 0, failed: 0 };
  if (!settings.message.trim()) return { ok: true, skipped: true, reason: "empty", sent: 0, failed: 0 };

  const onlinePlayers = (players || []).map(normalizePlayer).filter((player) => player.key && player.funcomId && player.characterName);
  const state = readState(config);
  const delivered = {};
  for (const [key, entry] of Object.entries(state.delivered || {})) {
    const player = onlinePlayers.find((player) => player.key === key);
    if (player && sameSession(entry, player)) delivered[key] = entry;
  }

  const pendingPlayers = onlinePlayers.filter((player) => !delivered[player.key]);
  if (!pendingPlayers.length) {
    writeJson(statePath(config), { delivered }, 0o600);
    return { ok: true, skipped: false, sent: 0, failed: 0 };
  }

  const results = [];
  let sent = 0;
  let failed = 0;
  const persona = (context.mockMode || config.mockMode)
    ? (context.persona || MESSAGE_OF_THE_DAY_PERSONA)
    : await ensureMessageOfTheDayPersona(context.db);
  for (const player of pendingPlayers) {
    try {
      if (context.mockMode || config.mockMode) {
        results.push({ player: player.characterName, ok: true, mock: true, senderName: persona.displayName });
      } else {
        const result = await publishCarePackageWhisper(config, {
          message: settings.message,
          senderFuncomId: persona.funcomId,
          senderHexFlsId: persona.hexFlsId,
          recipientFuncomId: player.funcomId,
          recipientCharacterName: player.characterName
        });
        results.push({ player: player.characterName, ok: true, senderName: persona.displayName, stdout: result.stdout });
      }
      sent += 1;
      delivered[player.key] = {
        deliveredAt: new Date().toISOString(),
        characterName: player.characterName,
        sessionKey: player.sessionKey
      };
    } catch (error) {
      failed += 1;
      results.push({ player: player.characterName, ok: false, error: String(error.message || error) });
    }
  }

  writeJson(statePath(config), { delivered }, 0o600);
  return { ok: failed === 0, skipped: false, sent, failed, results };
}

export function normalizeSettings(input = {}) {
  return {
    enabled: normalizeBoolean(input.enabled, "enabled"),
    title: "",
    message: normalizeMessage(input.message ?? input.body ?? "")
  };
}

export function messageOfTheDayDeliveryPlan(settings, players, state = EMPTY_STATE) {
  const normalizedSettings = normalizeSettings(settings);
  const onlinePlayers = (players || []).map(normalizePlayer).filter((player) => player.key && player.funcomId && player.characterName);
  const delivered = {};
  for (const [key, entry] of Object.entries(state.delivered || {})) {
    const player = onlinePlayers.find((player) => player.key === key);
    if (player && sameSession(entry, player)) delivered[key] = entry;
  }
  const pending = normalizedSettings.enabled && normalizedSettings.message
    ? onlinePlayers.filter((player) => !delivered[player.key])
    : [];
  return { pending, delivered };
}

function readSettings(config) {
  try {
    return normalizeSettings(JSON.parse(readFileSync(settingsPath(config), "utf8")));
  } catch {
    return { ...DEFAULT_MESSAGE_OF_THE_DAY };
  }
}

function readState(config) {
  try {
    const state = JSON.parse(readFileSync(statePath(config), "utf8"));
    return state && typeof state === "object" && state.delivered && typeof state.delivered === "object" ? state : EMPTY_STATE;
  } catch {
    return EMPTY_STATE;
  }
}

function normalizePlayer(player = {}) {
  const flsId = String(player.fls_id || player.flsId || player.recipientFlsId || "").trim();
  const funcomId = String(player.funcom_id || player.funcomId || player.recipientFuncomId || "").trim();
  const characterName = String(player.character_name || player.characterName || player.recipientCharacterName || "").trim();
  const key = String(player.action_player_id || flsId || funcomId || player.actor_id || player.player_pawn_id || "").trim();
  const sessionKey = String(player.login_session || player.loginSession || player.last_login_time || player.lastLoginTime || "").trim();
  return {
    key,
    flsId,
    funcomId,
    characterName,
    sessionKey,
    queue: flsId ? `${flsId}_queue` : ""
  };
}

function sameSession(entry = {}, player = {}) {
  const current = String(player.sessionKey || "").trim();
  if (!current) return true;
  return String(entry.sessionKey || "").trim() === current;
}

function normalizeBoolean(value, field) {
  if (value === true || value === false) return value;
  throw new Error(`${field} must be true or false`);
}

function normalizeMessage(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return validateBroadcastMessage(raw);
}

function settingsPath(config) {
  return resolve(config.generatedDir || resolve(config.repoRoot, "runtime", "generated"), "message-of-the-day.json");
}

function statePath(config) {
  return resolve(config.generatedDir || resolve(config.repoRoot, "runtime", "generated"), "message-of-the-day-state.json");
}

function writeJson(path, value, mode) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  try {
    if (existsSync(path)) chmodSync(path, mode);
  } catch {
    // Best effort only. Some mounted filesystems do not support chmod.
  }
}
