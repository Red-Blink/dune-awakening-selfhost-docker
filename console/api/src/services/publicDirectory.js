import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as duneDb from "../duneDb.js";

const DEFAULT_BASE_URL = "https://dunedocker.app/api/v1/servers";
const DEFAULT_HEARTBEAT_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 15 * 60;
const REQUEST_TIMEOUT_MS = 10000;
const BATTLEGROUP_CORE_CONTAINERS = new Set([
  "dune-director",
  "dune-server-gateway",
  "dune-server-survival-1",
  "dune-server-overmap"
]);
const SUPPORTED_REGIONS = new Set([
  "North America",
  "Europe",
  "Asia",
  "Oceania",
  "South America"
]);

export function createPublicDirectoryReporter(config, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const getDb = options.getDb || (() => options.db);
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const getBattlegroupRunning = options.getBattlegroupRunning || isBattlegroupRunning;
  const now = options.now || (() => Date.now());
  const random = options.random || Math.random;
  const identityPath = options.identityPath || resolve(config.secretsDir, "public-directory.json");
  const statusPath = options.statusPath || resolve(config.generatedDir, "public-directory-status.json");
  const baseUrl = String(
    options.baseUrl ||
    process.env.DUNE_PUBLIC_DIRECTORY_URL ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");

  let timer = null;
  let running = false;
  let stopped = false;
  let failureCount = 0;
  let state = readStatus(statusPath);

  function start() {
    if (stopped || timer) return;
    schedule(5000 + Math.floor(random() * 10000));
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeoutFn(timer);
    timer = null;
  }

  async function tick() {
    if (stopped || running) return;
    if (timer) clearTimeoutFn(timer);
    running = true;
    timer = null;
    try {
      const settings = readDirectorySettings(config.repoRoot);
      if (!settings.enabled || settings.mode !== "public") {
        await removeRemoteListing(settings);
        failureCount = 0;
        schedule(DEFAULT_HEARTBEAT_SECONDS * 1000);
        return;
      }

      const identity = getOrCreateIdentity(identityPath);
      const snapshot = await collectDirectorySnapshot(config, getDb(), settings, {
        running: await getBattlegroupRunning()
      });
      const payload = buildHeartbeatPayload(identity, snapshot);
      const attemptedAt = new Date(now()).toISOString();
      writeState({
        enabled: true,
        mode: settings.mode,
        state: "reporting",
        serverId: identity.serverId,
        remoteListed: Boolean(state.remoteListed),
        lastAttemptAt: attemptedAt,
        lastSuccessAt: state.lastSuccessAt || null,
        nextHeartbeatAt: null,
        error: null
      });

      const receipt = await requestJson(fetchImpl, `${baseUrl}/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const heartbeatSeconds = clampInteger(
        receipt.nextHeartbeatSeconds,
        30,
        15 * 60,
        DEFAULT_HEARTBEAT_SECONDS
      );
      failureCount = 0;
      writeState({
        enabled: true,
        mode: settings.mode,
        state: !snapshot.running ? "offline" : snapshot.ready ? "online" : "degraded",
        serverId: identity.serverId,
        remoteListed: true,
        lastAttemptAt: attemptedAt,
        lastSuccessAt: new Date(now()).toISOString(),
        nextHeartbeatAt: new Date(now() + heartbeatSeconds * 1000).toISOString(),
        error: null
      });
      schedule(heartbeatSeconds * 1000);
    } catch (error) {
      failureCount += 1;
      const delaySeconds = Math.min(
        MAX_BACKOFF_SECONDS,
        DEFAULT_HEARTBEAT_SECONDS * (2 ** Math.min(failureCount - 1, 4))
      );
      writeState({
        ...state,
        enabled: true,
        state: "error",
        lastAttemptAt: new Date(now()).toISOString(),
        nextHeartbeatAt: new Date(now() + delaySeconds * 1000).toISOString(),
        error: safeError(error)
      });
      schedule(delaySeconds * 1000);
    } finally {
      running = false;
    }
  }

  async function removeRemoteListing(settings) {
    const identity = readIdentity(identityPath);
    const shouldDelete = identity && state.remoteListed !== false;
    if (shouldDelete) {
      await requestJson(fetchImpl, `${baseUrl}/${encodeURIComponent(identity.serverId)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${identity.secret}` }
      });
    }
    writeState({
      enabled: settings.enabled,
      mode: settings.mode,
      state: settings.enabled ? "local-only" : "disabled",
      serverId: identity?.serverId || null,
      remoteListed: false,
      lastAttemptAt: shouldDelete ? new Date(now()).toISOString() : state.lastAttemptAt || null,
      lastSuccessAt: state.lastSuccessAt || null,
      nextHeartbeatAt: null,
      error: null
    });
  }

  function schedule(delayMs) {
    if (stopped) return;
    if (timer) clearTimeoutFn(timer);
    timer = setTimeoutFn(() => {
      void tick();
    }, Math.max(0, delayMs));
    timer?.unref?.();
  }

  function writeState(next) {
    state = {
      updatedAt: new Date(now()).toISOString(),
      ...next
    };
    writeJsonAtomic(statusPath, state, 0o600);
  }

  return {
    start,
    stop,
    tick,
    publicState: () => ({ ...state })
  };
}

export function readDirectorySettings(repoRoot, env = process.env) {
  const fileEnv = readEnvFile(resolve(repoRoot, ".env"));
  const rawEnabled = firstValue(fileEnv.DUNE_PUBLIC_DIRECTORY_ENABLED, env.DUNE_PUBLIC_DIRECTORY_ENABLED);
  const mode = String(firstValue(fileEnv.SERVER_IP_MODE, env.SERVER_IP_MODE, "local")).trim().toLowerCase();
  return {
    enabled: rawEnabled === undefined ? true : !/^(0|false|no|off|disabled)$/i.test(String(rawEnabled).trim()),
    mode,
    title: cleanText(firstValue(fileEnv.SERVER_TITLE, env.SERVER_TITLE, ""), 120),
    region: normalizeRegion(firstValue(fileEnv.SERVER_REGION, env.SERVER_REGION, ""))
  };
}

export async function collectDirectorySnapshot(
  config,
  db,
  settings = readDirectorySettings(config.repoRoot),
  options = {}
) {
  const version = readGameBuild(config.repoRoot);
  if (!settings.title) throw new Error("Public directory reporting requires SERVER_TITLE.");
  if (!SUPPORTED_REGIONS.has(settings.region)) {
    throw new Error(`Public directory reporting does not support region: ${settings.region || "unknown"}.`);
  }
  if (!version) throw new Error("Public directory reporting is waiting for a detected game build.");

  const capacity = readConfiguredCapacity(config.repoRoot);
  const probePort = readPublicProbePort(config.repoRoot);
  const running = options.running !== false;
  let playersOnline = 0;
  let ready = false;
  let sietches = readConfiguredSietches(config.repoRoot);

  if (running && db) {
    try {
      const hasFarms = await duneDb.tableExists(db, "farm_state");
      const hasPartitions = await duneDb.tableExists(db, "world_partition");
      const hasPlayers = await duneDb.tableExists(db, "player_state");
      let farmPlayers = 0;
      let playerRows = 0;

      if (hasFarms) {
        const result = await db.query(`
          select coalesce(sum(coalesce(connected_players, 0))
            filter (where coalesce(alive, false)), 0)::int as players
          from dune.farm_state`);
        farmPlayers = Number(result.rows?.[0]?.players || 0);
      }
      if (hasPlayers) {
        const result = await db.query(`
          select count(*)::int as players
          from dune.player_state
          where coalesce(online_status::text, '') = 'Online'`);
        playerRows = Number(result.rows?.[0]?.players || 0);
      }
      if (hasFarms && hasPartitions) {
        const result = await db.query(`
          select count(*)::int as ready_maps
          from (
            select lower(wp.map) as map
            from dune.world_partition wp
            join dune.farm_state fs on fs.server_id = wp.server_id
            where lower(wp.map) in ('survival_1', 'overmap')
              and coalesce(fs.alive, false)
              and coalesce(fs.ready, false)
            group by lower(wp.map)
          ) core_maps`);
        ready = Number(result.rows?.[0]?.ready_maps || 0) === 2;
      }
      if (!sietches && hasPartitions) {
        const result = await db.query(`
          select count(*)::int as sietches
          from dune.world_partition
          where lower(map) = 'survival_1'`);
        sietches = Number(result.rows?.[0]?.sietches || 0);
      }
      playersOnline = Math.max(farmPlayers, playerRows);
    } catch {
      ready = false;
      playersOnline = 0;
    }
  }

  return {
    name: settings.title,
    region: settings.region,
    running,
    ready,
    playersOnline: Math.min(Math.max(0, playersOnline), capacity),
    capacity,
    version,
    sietches: clampInteger(sietches, 0, 1000, 0),
    probePort
  };
}

export function buildHeartbeatPayload(identity, snapshot) {
  return {
    serverId: identity.serverId,
    secret: identity.secret,
    publicMode: true,
    name: snapshot.name,
    region: snapshot.region,
    running: Boolean(snapshot.running),
    ready: Boolean(snapshot.ready),
    playersOnline: snapshot.playersOnline,
    capacity: snapshot.capacity,
    version: snapshot.version,
    sietches: snapshot.sietches,
    probePort: snapshot.probePort
  };
}

export function isBattlegroupRunning(getRunningContainers = runningContainerNames) {
  try {
    const running = new Set(getRunningContainers());
    return [...BATTLEGROUP_CORE_CONTAINERS].some((name) => running.has(name));
  } catch {
    return false;
  }
}

export function getOrCreateIdentity(path) {
  const current = readIdentity(path);
  if (current) return current;
  const identity = {
    serverId: randomUUID(),
    secret: randomBytes(32).toString("base64url")
  };
  writeJsonAtomic(path, identity, 0o600);
  return identity;
}

function runningContainerNames() {
  const output = execFileSync("docker", ["ps", "--format", "{{.Names}}"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"]
  });
  return output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

export function readConfiguredCapacity(repoRoot) {
  const path = resolve(repoRoot, "runtime/director/config/director_config.ini");
  if (!existsSync(path)) return 60;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  let section = "";
  let defaultCap = 60;
  let defaultUpdates = true;
  let sectionCap = null;
  let sectionUpdates = null;
  let total = 0;

  const flush = () => {
    if (!section || ["Server", "Battlegroup", "InstancingModes"].includes(section)) return;
    const updates = sectionUpdates ?? defaultUpdates;
    const cap = sectionCap ?? defaultCap;
    if (updates && Number.isInteger(cap) && cap > 0) total += cap;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      flush();
      section = sectionMatch[1];
      sectionCap = null;
      sectionUpdates = null;
      continue;
    }
    const [key, rawValue] = line.split("=", 2);
    if (!rawValue) continue;
    const value = rawValue.trim();
    if (key === "PlayerHardCap") {
      const parsed = Number(value);
      if (section === "Server") defaultCap = parsed;
      else sectionCap = parsed;
    } else if (key === "ShouldUpdatePlayerCountOnFls") {
      const parsed = /^true$/i.test(value);
      if (section === "Server") defaultUpdates = parsed;
      else sectionUpdates = parsed;
    }
  }
  flush();
  return clampInteger(total || defaultCap, 1, 10000, 60);
}

export function readGameBuild(repoRoot) {
  const env = readEnvFile(resolve(repoRoot, "runtime/generated/image-tags.env"));
  const tag = String(env.DUNE_WORLD_IMAGE_TAG || "").trim();
  const match = tag.match(/^([A-Za-z0-9._+]+?)(?:-\d+-shipping)?$/i);
  return match?.[1] || "";
}

export function readPublicProbePort(repoRoot) {
  const env = readEnvFile(resolve(repoRoot, ".env"));
  return clampInteger(env.RMQ_GAME_HTTP_PORT, 1, 65535, 31983);
}

function readConfiguredSietches(repoRoot) {
  try {
    const value = JSON.parse(readFileSync(resolve(repoRoot, "runtime/generated/sietch-config.json"), "utf8"));
    return Number(value?.maps?.Survival_1?.active_dimensions || 0);
  } catch {
    return 0;
  }
}

function normalizeRegion(value) {
  const raw = cleanText(value, 80).replace(/\s+Test$/i, "");
  for (const region of SUPPORTED_REGIONS) {
    if (region.toLowerCase() === raw.toLowerCase()) return region;
  }
  return raw;
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function readIdentity(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!/^[0-9a-f-]{36}$/i.test(String(value?.serverId || ""))) return null;
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(String(value?.secret || ""))) return null;
    return { serverId: value.serverId, secret: value.secret };
  } catch {
    return null;
  }
}

function readStatus(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return {
      updatedAt: safeStatusText(value.updatedAt, 40),
      enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
      mode: safeStatusText(value.mode, 20),
      state: safeStatusText(value.state, 30),
      serverId: /^[0-9a-f-]{36}$/i.test(String(value.serverId || "")) ? value.serverId : null,
      remoteListed: typeof value.remoteListed === "boolean" ? value.remoteListed : undefined,
      lastAttemptAt: safeStatusText(value.lastAttemptAt, 40),
      lastSuccessAt: safeStatusText(value.lastSuccessAt, 40),
      nextHeartbeatAt: safeStatusText(value.nextHeartbeatAt, 40),
      error: safeStatusText(value.error, 240)
    };
  } catch {
    return {};
  }
}

async function requestJson(fetchImpl, url, options) {
  if (typeof fetchImpl !== "function") throw new Error("Public directory HTTP client is unavailable.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok) {
      throw new Error(`Public directory returned HTTP ${response.status}.`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function writeJsonAtomic(path, value, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  chmodSync(temporaryPath, mode);
  renameSync(temporaryPath, path);
  try { chmodSync(path, mode); } catch {}
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function safeStatusText(value, maxLength) {
  if (value === undefined || value === null) return null;
  return cleanText(value, maxLength) || null;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function safeError(error) {
  const message = String(error?.name === "AbortError" ? "Public directory request timed out." : error?.message || error);
  return cleanText(message, 240);
}
