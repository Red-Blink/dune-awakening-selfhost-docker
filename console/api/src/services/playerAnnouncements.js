import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { publishMapChat, validateBroadcastMessage } from "../rmq.js";
import { ensureCarePackageServerPersona } from "../carePackage.js";

const OLD_DEFAULT_JOIN_MESSAGE = "{playerName} has entered the sands of Arrakis.";
const OLD_DEFAULT_LEAVE_MESSAGE = "{playerName} has vanished beyond the dunes.";
const DEFAULT_JOIN_MESSAGE = "{playerName} has entered {mapName}, their trail fresh upon the sands.";
const DEFAULT_LEAVE_MESSAGE = "{playerName} has vanished from {mapName}, their tracks swallowed by the dunes.";

const DEFAULT_PLAYER_ANNOUNCEMENTS = {
  joinEnabled: false,
  joinMessage: DEFAULT_JOIN_MESSAGE,
  leaveEnabled: false,
  leaveMessage: DEFAULT_LEAVE_MESSAGE
};

const EMPTY_STATE = { online: {} };
const DEFAULT_CHAT_MAP = "HaggaBasin";
const MAP_CHAT_REGIONS = {
  Survival_1: "HaggaBasin",
  Overmap: "Overland",
  DeepDesert_1: "DeepDesert",
  SH_Arrakeen: "Arrakeen",
  SH_HarkoVillage: "HarkoVillage"
};
const FRIENDLY_MAP_NAMES = {
  Survival_1: "Hagga Basin",
  Overmap: "Overland",
  DeepDesert_1: "Deep Desert",
  SH_Arrakeen: "Arrakeen",
  SH_HarkoVillage: "Harko Village",
  CB_Story_Hephaestus: "Hephaestus",
  CB_Story_Ecolab_Carthag: "Ecology Lab Carthag",
  CB_Story_WaterFatManor: "Water Fat Manor",
  Story_ProcesVerbal: "Proces Verbal",
  DLC_Story_LostHarvest_EcolabA: "Lost Harvest Ecology Lab A",
  DLC_Story_LostHarvest_EcolabB: "Lost Harvest Ecology Lab B",
  DLC_Story_LostHarvest_ForgottenLab: "Lost Harvest Forgotten Lab",
  Story_ArtOfKanly: "Art of Kanly",
  CB_Dungeon_Hephaestus: "Hephaestus Dungeon",
  CB_Dungeon_OldCarthag: "Old Carthag",
  Story_Faction_Outpost_Atre: "Atreides Outpost",
  Story_Faction_Outpost_Hark: "Harkonnen Outpost",
  Story_HeighlinerDungeon: "Heighliner Dungeon",
  CB_Ecolab_Bronze_Green_089: "Bronze Green Ecology Lab 089",
  CB_Ecolab_Bronze_Green_152: "Bronze Green Ecology Lab 152",
  CB_Ecolab_Bronze_Green_195: "Bronze Green Ecology Lab 195",
  CB_Ecolab_Bronze_Green_024: "Bronze Green Ecology Lab 024",
  CB_Ecolab_Bronze_Green_136: "Bronze Green Ecology Lab 136",
  CB_Dungeon_ThePit: "The Pit",
  CB_Overland_M_01: "Overland M-01",
  CB_Overland_S_04: "Overland S-04",
  CB_Overland_S_06: "Overland S-06",
  CB_Overland_S_07: "Overland S-07",
  CB_Overland_S_08: "Overland S-08",
  CB_Story_BanditFortress01: "Bandit Fortress"
};

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
  const onlineRecipients = Object.values(currentOnline).filter((player) => player.queue);
  for (const event of events) {
    try {
      const recipients = eventRecipients(event, onlineRecipients);
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
            mapName: event.player.chatMapName,
            dimension: event.player.dimension,
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

export function previewPlayerAnnouncement(settings, playerName = "John", mapName = "Hagga Basin") {
  const normalized = normalizeSettings(settings);
  return renderPlayerMessage(normalized.joinMessage, { characterName: playerName, mapName });
}

export function normalizeSettings(input = {}) {
  return {
    joinEnabled: normalizeBoolean(input.joinEnabled, "joinEnabled"),
    joinMessage: normalizeTemplate(input.joinMessage, "Join message", OLD_DEFAULT_JOIN_MESSAGE, DEFAULT_JOIN_MESSAGE),
    leaveEnabled: normalizeBoolean(input.leaveEnabled, "leaveEnabled"),
    leaveMessage: normalizeTemplate(input.leaveMessage, "Leave message", OLD_DEFAULT_LEAVE_MESSAGE, DEFAULT_LEAVE_MESSAGE)
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
  for (const player of players.map(normalizePlayer).filter((entry) => entry.key && entry.characterName && entry.online)) {
    online[player.key] = player;
  }
  return online;
}

function normalizePlayer(player = {}) {
  const key = String(player.action_player_id || player.actor_id || player.player_pawn_id || player.fls_id || player.flsId || player.funcom_id || player.funcomId || "").trim();
  const characterName = String(player.character_name || player.characterName || player.funcom_id || player.funcomId || key).trim();
  const flsId = String(player.fls_id || player.flsId || "").trim();
  const onlineStatus = String(player.online_status || player.onlineStatus || "").trim().toLowerCase();
  const map = String(player.map || player.map_name || player.mapName || "").trim();
  const dimension = normalizeDimension(player.dimension_index ?? player.dimensionIndex ?? player.dimension);
  return {
    key,
    characterName,
    flsId,
    online: onlineStatus === "online",
    queue: flsId ? `${flsId}_queue` : "",
    map,
    mapName: friendlyMapName(map),
    chatMapName: chatMapName(map),
    dimension
  };
}

function renderPlayerMessage(template, player) {
  return validateBroadcastMessage(String(template || "")
    .replaceAll("{playerName}", player.characterName)
    .replaceAll("{mapName}", player.mapName || friendlyMapName(player.map))
    .replaceAll("{map}", player.mapName || friendlyMapName(player.map))
    .replaceAll("{mapId}", player.map || ""));
}

function eventRecipients(event, onlineRecipients) {
  if (!event.player.map) return onlineRecipients;
  return onlineRecipients.filter((recipient) => sameMapAndDimension(recipient, event.player));
}

function sameMapAndDimension(a, b) {
  return String(a.map || "") === String(b.map || "") && normalizeDimension(a.dimension) === normalizeDimension(b.dimension);
}

function normalizeDimension(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function friendlyMapName(map) {
  const raw = String(map || "").trim();
  if (!raw) return "Arrakis";
  if (FRIENDLY_MAP_NAMES[raw]) return FRIENDLY_MAP_NAMES[raw];
  return raw
    .replace(/^SH_/, "")
    .replace(/^CB_Story_/, "")
    .replace(/^CB_Dungeon_/, "")
    .replace(/^CB_Ecolab_/, "Ecolab_")
    .replace(/^CB_Overland_/, "Overland_")
    .replace(/^DLC_Story_/, "")
    .replace(/^Story_/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chatMapName(map) {
  const raw = String(map || "").trim();
  if (!raw) return DEFAULT_CHAT_MAP;
  return MAP_CHAT_REGIONS[raw] || raw.replace(/^SH_/, "");
}

function normalizeTemplate(value, label, oldDefault, newDefault) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`${label} is required`);
  if (raw === oldDefault) return newDefault;
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
