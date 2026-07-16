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
import { execFile } from "node:child_process";
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
  const reconcileProbe = options.reconcileProbe || ((probe) => reconcilePublicProbe(config.repoRoot, probe));
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
      const probe = normalizeProbeReceipt(receipt.probe);
      let probeState = probe?.signalingUrl ? "starting" : "unavailable";
      let probeError = null;
      try {
        if (probe?.signalingUrl) {
          await reconcileProbe({
            enabled: true,
            signalingUrl: probe.signalingUrl,
            serverId: identity.serverId,
            secret: identity.secret
          });
        } else if (state.probeEndpoint) {
          await reconcileProbe({ enabled: false });
        }
        probeState = probe?.signalingUrl ? "started" : "unavailable";
      } catch (error) {
        probeState = "error";
        probeError = safeError(error);
      }
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
        error: null,
        probeEndpoint: probe?.signalingUrl || null,
        probeState,
        probeError
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
    if (state.probeEndpoint) {
      try {
        await reconcileProbe({ enabled: false, endpoint: null });
      } catch {
        // Listing removal must not fail because local probe cleanup encountered an issue.
      }
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
      error: null,
      probeEndpoint: null,
      probeState: "disabled",
      probeError: null
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
  const discordInvite = normalizeDiscordInvite(firstValue(
    fileEnv.DUNE_PUBLIC_DIRECTORY_DISCORD_INVITE,
    env.DUNE_PUBLIC_DIRECTORY_DISCORD_INVITE,
    ""
  ));
  return {
    enabled: rawEnabled === undefined ? true : !/^(0|false|no|off|disabled)$/i.test(String(rawEnabled).trim()),
    mode,
    title: cleanText(firstValue(fileEnv.SERVER_TITLE, env.SERVER_TITLE, ""), 120),
    region: normalizeRegion(firstValue(fileEnv.SERVER_REGION, env.SERVER_REGION, "")),
    discordInvite: discordInvite || ""
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
    discordInvite: settings.discordInvite || ""
  };
}

export function buildHeartbeatPayload(identity, snapshot) {
  const payload = {
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
    discordInvite: snapshot.discordInvite || "",
    personalizedPingEnabled: true
  };
  return payload;
}

export function normalizeDiscordInvite(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.length > 160) return null;
  try {
    const invite = new URL(raw);
    const hostname = invite.hostname.toLowerCase();
    if (
      invite.protocol !== "https:" ||
      invite.port ||
      invite.username ||
      invite.password ||
      invite.search ||
      invite.hash
    ) return null;
    const parts = invite.pathname.split("/").filter(Boolean);
    let code = "";
    if (hostname === "discord.gg" && parts.length === 1) {
      [code] = parts;
    } else if (
      (hostname === "discord.com" || hostname === "www.discord.com") &&
      parts.length === 2 &&
      parts[0].toLowerCase() === "invite"
    ) {
      code = parts[1];
    } else {
      return null;
    }
    if (!/^[A-Za-z0-9_-]{2,100}$/.test(code)) return null;
    return `https://discord.gg/${code}`;
  } catch {
    return null;
  }
}

export async function isBattlegroupRunning(getRunningContainers = runningContainerNames) {
  try {
    const running = new Set(await getRunningContainers());
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

async function runningContainerNames() {
  const output = await execFileOutput("docker", ["ps", "--format", "{{.Names}}"], {
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
      error: safeStatusText(value.error, 240),
      probeEndpoint: normalizeSignalingUrl(value.probeEndpoint),
      probeState: safeStatusText(value.probeState, 30),
      probeError: safeStatusText(value.probeError, 240)
    };
  } catch {
    return {};
  }
}

function normalizeProbeReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.mode !== "webrtc") return null;
  const signalingUrl = normalizeSignalingUrl(value.signalingUrl);
  return signalingUrl ? { mode: "webrtc", signalingUrl } : null;
}

function normalizeSignalingUrl(value) {
  try {
    const endpoint = new URL(String(value || "").trim());
    if (
      endpoint.protocol !== "https:" ||
      endpoint.hostname !== "dunedocker.app" ||
      endpoint.port ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== "/api/v1/probes" ||
      endpoint.search ||
      endpoint.hash
    ) return null;
    return endpoint.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export async function reconcilePublicProbe(repoRoot, probe, runCommand = execFileOutput) {
  const script = resolve(repoRoot, "runtime", "scripts", "public-probe.sh");
  if (!probe?.enabled) {
    await runCommand(script, ["stop"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return;
  }
  const signalingUrl = normalizeSignalingUrl(probe.signalingUrl);
  if (!signalingUrl) throw new Error("Public probe signaling URL is invalid.");
  if (!/^[0-9a-f-]{36}$/i.test(String(probe.serverId || ""))) {
    throw new Error("Public probe server identity is invalid.");
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(String(probe.secret || ""))) {
    throw new Error("Public probe credential is invalid.");
  }
  writeProbeEnv(repoRoot, {
    signalingUrl,
    serverId: probe.serverId,
    secret: probe.secret
  });
  await runCommand(script, ["reconcile"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function execFileOutput(file, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, { ...options, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise(stdout || "");
    });
  });
}

function writeProbeEnv(repoRoot, probe) {
  const path = resolve(repoRoot, "runtime", "generated", "public-probe.env");
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, [
    "DUNE_PUBLIC_PROBE_ENABLED=true",
    `DUNE_PUBLIC_PROBE_SERVER_ID=${probe.serverId}`,
    `DUNE_PUBLIC_PROBE_SECRET=${probe.secret}`,
    `DUNE_PUBLIC_PROBE_SIGNAL_URL=${probe.signalingUrl}`,
    ""
  ].join("\n"), { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch {}
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
