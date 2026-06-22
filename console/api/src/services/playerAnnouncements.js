import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { publishMapChat, validateBroadcastMessage } from "../rmq.js";
import { ensureCarePackageServerPersona } from "../carePackage.js";

const DEFAULT_PLAYER_ANNOUNCEMENTS = {
  joinEnabled: false,
  joinMessage: "{playerName} has entered the sands of Arrakis.",
  leaveEnabled: false,
  leaveMessage: "{playerName} has vanished beyond the dunes."
};

const EMPTY_STATE = { online: {} };

export function readPlayerAnnouncements(config) {
  return {
    settings: readSettings(config),
    defaults: { ...DEFAULT_PLAYER_ANNOUNCEMENTS }
  };
}

export function savePlayerAnnouncements(config, body = {}) {
  const settings = normalizeSettings(body.settings || body);
  writeJson(settingsPath(config), settings, 0o600);
  return { settings, defaults: { ...DEFAULT_PLAYER_ANNOUNCEMENTS } };
}

export function restorePlayerAnnouncements(config) {
  const settings = { ...DEFAULT_PLAYER_ANNOUNCEMENTS };
  writeJson(settingsPath(config), settings, 0o600);
  writeJson(statePath(config), EMPTY_STATE, 0o600);
  return { settings, defaults: { ...DEFAULT_PLAYER_ANNOUNCEMENTS } };
}

export function primePlayerAnnouncementOnlineState(config, players) {
  const online = onlineMap(players);
  writeJson(statePath(config), { online }, 0o600);
  return { online: Object.keys(online).length };
}

export async function runPlayerAnnouncementScan(config, players, context = {}) {
  const settings = readSettings(config);
  const currentOnline = onlineMap(players);
  const previousOnline = readState(config).online || {};
  if (!settings.joinEnabled && !settings.leaveEnabled) return { ok: true, skipped: true, joined: 0, left: 0, sent: 0, failed: 0 };

  const events = [];
  if (settings.joinEnabled) {
    for (const [key, player] of Object.entries(currentOnline)) {
      if (!previousOnline[key]) events.push({ type: "join", player, message: renderPlayerMessage(settings.joinMessage, player) });
    }
  }
  if (settings.leaveEnabled) {
    for (const [key, player] of Object.entries(previousOnline)) {
      if (!currentOnline[key]) events.push({ type: "leave", player, message: renderPlayerMessage(settings.leaveMessage, player) });
    }
  }

  let sent = 0;
  let failed = 0;
  let skippedNoRecipients = 0;
  const results = [];
  const recipients = Object.values(currentOnline).filter((player) => player.queue);
  for (const event of events) {
    try {
      if (!recipients.length) {
        skippedNoRecipients += 1;
        results.push({ ok: true, skipped: true, reason: "no_online_recipients", type: event.type, player: event.player.characterName, recipients: 0 });
        continue;
      }
      if (context.mockMode || config.mockMode) {
        results.push({ ok: true, mock: true, type: event.type, player: event.player.characterName, recipients: recipients.length });
        sent += recipients.length;
      } else {
        const persona = context.persona || await ensureCarePackageServerPersona(context.db);
        const published = [];
        for (const recipient of recipients) {
          published.push(await publishMapChat(config, {
            message: event.message,
            senderFuncomId: persona.funcomId,
            senderHexFlsId: persona.hexFlsId,
            recipientQueue: recipient.queue
          }));
        }
        sent += published.length;
        results.push({ ok: true, type: event.type, player: event.player.characterName, recipients: published.length, stdout: published.map((result) => result.stdout).join("\n") });
      }
    } catch (error) {
      failed += 1;
      results.push({ ok: false, type: event.type, player: event.player.characterName, error: String(error.message || error) });
    }
  }

  writeJson(statePath(config), { online: currentOnline }, 0o600);
  return {
    ok: failed === 0,
    skipped: false,
    joined: events.filter((event) => event.type === "join").length,
    left: events.filter((event) => event.type === "leave").length,
    sent,
    failed,
    skippedNoRecipients,
    results
  };
}

export function previewPlayerAnnouncement(settings, playerName = "John") {
  const normalized = normalizeSettings(settings);
  return renderPlayerMessage(normalized.joinMessage, { characterName: playerName });
}

export function normalizeSettings(input = {}) {
  return {
    joinEnabled: normalizeBoolean(input.joinEnabled, "joinEnabled"),
    joinMessage: normalizeTemplate(input.joinMessage, "Join message"),
    leaveEnabled: normalizeBoolean(input.leaveEnabled, "leaveEnabled"),
    leaveMessage: normalizeTemplate(input.leaveMessage, "Leave message")
  };
}

function readSettings(config) {
  try {
    return normalizeSettings(JSON.parse(readFileSync(settingsPath(config), "utf8")));
  } catch {
    return { ...DEFAULT_PLAYER_ANNOUNCEMENTS };
  }
}

function readState(config) {
  try {
    const state = JSON.parse(readFileSync(statePath(config), "utf8"));
    return state && typeof state === "object" && state.online && typeof state.online === "object" ? state : EMPTY_STATE;
  } catch {
    return EMPTY_STATE;
  }
}

function onlineMap(players = []) {
  const online = {};
  for (const player of players.map(normalizePlayer).filter((entry) => entry.key && entry.characterName)) {
    online[player.key] = player;
  }
  return online;
}

function normalizePlayer(player = {}) {
  const key = String(player.action_player_id || player.actor_id || player.player_pawn_id || player.fls_id || player.flsId || player.funcom_id || player.funcomId || "").trim();
  const characterName = String(player.character_name || player.characterName || player.funcom_id || player.funcomId || key).trim();
  const flsId = String(player.fls_id || player.flsId || "").trim();
  return { key, characterName, flsId, queue: flsId ? `${flsId}_queue` : "" };
}

function renderPlayerMessage(template, player) {
  return validateBroadcastMessage(String(template || "").replaceAll("{playerName}", player.characterName));
}

function normalizeTemplate(value, label) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`${label} is required`);
  return validateBroadcastMessage(raw);
}

function normalizeBoolean(value, field) {
  if (value === true || value === false) return value;
  throw new Error(`${field} must be true or false`);
}

function settingsPath(config) {
  return resolve(config.generatedDir || resolve(config.repoRoot, "runtime", "generated"), "player-announcements.json");
}

function statePath(config) {
  return resolve(config.generatedDir || resolve(config.repoRoot, "runtime", "generated"), "player-announcements-state.json");
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
