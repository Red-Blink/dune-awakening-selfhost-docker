import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync, chownSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { clampInt } from "./jsonStore.js";

export const APP_NAME = "Dune Docker Console";

// Single source of truth for every host-facing port this console cares
// about. Stock (Instance 1) values are the fallback defaults only --
// multi-server / single-public-IP deployments override these via .env.
// These values MUST stay in sync with runtime/scripts/runtime-env.sh's
// resolve_*_port() functions -- that file is the shell-side equivalent
// used by non-Node scripts, and the two must never drift (found 6
// places across the codebase that hardcoded these stock values directly
// instead of reading them from a shared source, breaking any deployment
// running non-default configured ports).
//
// Requirement 20 Layer 3 (integration) audit finding, CRITICAL,
// independently reproduced before this fix: this comment previously
// claimed the shell-side resolve_client_port_base()/resolve_igw_port_base()
// (runtime-env.sh) fall back to .env's CLIENT_PORT_BASE/IGW_PORT_BASE
// before the profile file exists -- that was never true. Reading
// runtime-env.sh's usersettings_engine_value() directly: its real
// fallback chain is gameplay-profile.ini -> runtime/generated/
// usersettings.json's legacy "engine" config -> the stock literal.
// .env is NEVER consulted anywhere in that chain. Directly reproduced
// the divergence this caused: with CLIENT_PORT_BASE=7001 set in .env
// and no profile file yet, the old Node-side code here returned 7001
// while the real shell/Python resolver returned stock 7777, so the Web
// UI could show a port the game server's own startup scripts (which
// all resolve through runtime-env.sh, not through this file) would
// never actually bind to. Fixed by matching the real shell/Python
// fallback chain exactly instead of the previously-assumed (and
// incorrect) one: profile file -> usersettings.json's legacy engine
// config -> stock. .env's CLIENT_PORT_BASE/IGW_PORT_BASE are no longer
// read for these two specific fields (they remain read for every other
// field in this function, which genuinely are env-var-only with no
// other source of truth -- confirmed those fields have no equivalent
// in ENGINE_FIELDS/usersettings.json).
export function resolvePorts(env = process.env, repoRoot = process.cwd()) {
  const enginePorts = readEnginePortsFromProfile(repoRoot);
  const legacyEnginePorts = enginePorts.port === null || enginePorts.igwPort === null
    ? readEnginePortsFromLegacyUsersettings(repoRoot)
    : { port: null, igwPort: null };
  // Route profile-parsed values through portValue() too (not just the
  // legacy/stock fallback branch) -- a corrupted/malformed
  // gameplay-profile.ini could otherwise produce an out-of-range value
  // (e.g. Port=0 or a 10-digit garbage number) that bypasses range
  // validation entirely and flows through to the frontend and the
  // public-hosting reminder text unvalidated.
  const rawClientBase = enginePorts.port !== null
    ? portValue(enginePorts.port, 7777)
    : (legacyEnginePorts.port !== null ? portValue(legacyEnginePorts.port, 7777) : 7777);
  const rawIgwBase = enginePorts.igwPort !== null
    ? portValue(enginePorts.igwPort, 7888)
    : (legacyEnginePorts.igwPort !== null ? portValue(legacyEnginePorts.igwPort, 7888) : 7888);
  // Upstream review finding: portValue() only range-checks the base
  // port itself (1-65535), but every Player/Game and IGW base is
  // actually the start of a 34-slot range (see spawn-server.sh's
  // game_end=$((CLIENT_PORT_BASE + 33))/igw_end=$((IGW_PORT_BASE + 33)),
  // covering the maximum 34 world partitions this project supports) --
  // a base in the valid 1-65535 range can still overflow past 65535
  // once the +33 offset for the highest partition (or the console's
  // own +1 "secondary" port, used for the stock 2-partition default) is
  // applied. A base that would overflow is exactly as unusable as one
  // that's already out of range, so it falls back to stock the same
  // way portValue() already does for a directly out-of-range value.
  const clientBase = rawClientBase + 33 <= 65535 ? rawClientBase : 7777;
  const igwBase = rawIgwBase + 33 <= 65535 ? rawIgwBase : 7888;
  return {
    postgres: portValue(env.POSTGRES_PORT || env.DUNE_DB_PORT || env.PGPORT, 15432),
    rmqAdmin: portValue(env.RMQ_ADMIN_PORT, 32573),
    rmqGame: portValue(env.RMQ_GAME_PORT, 31982),
    rmqGameHttp: portValue(env.RMQ_GAME_HTTP_PORT, 31983),
    rmqGameLocalHttp: portValue(env.RMQ_GAME_LOCAL_HTTP_PORT, 15672),
    textRouter: portValue(env.TEXT_ROUTER_PORT, 5059),
    director: portValue(env.DIRECTOR_PORT, 11717),
    metricsPrometheus: portValue(env.METRICS_PROMETHEUS_PORT, 9090),
    clientBase,
    clientBaseSecondary: clientBase + 1,
    igwBase,
    igwBaseSecondary: igwBase + 1
  };
}

// Reads Port/IGWPort directly from the [Engine:URL] section of
// runtime/generated/gameplay-profile.ini -- a cheap, synchronous read
// (no shelling out to usersettings.py, which resolvePorts() cannot
// afford given it's called from hot paths like server.js's error
// handler). Returns { port: null, igwPort: null } if the file doesn't
// exist yet (fresh install, before the first `dune init`/materialize)
// or doesn't have an [Engine:URL] section -- callers fall back to
// readEnginePortsFromLegacyUsersettings() / stock values in that case,
// exactly matching runtime-env.sh's own
// resolve_client_port_base()/resolve_igw_port_base() fallback behavior
// (see usersettings_engine_value() in runtime-env.sh, which calls
// `usersettings.py engine-values` first, then falls back to reading
// runtime/generated/usersettings.json's legacy "engine" config
// directly -- .env is never consulted anywhere in that real chain).
function readEnginePortsFromProfile(repoRoot) {
  const profilePath = resolve(repoRoot, "runtime/generated/gameplay-profile.ini");
  if (!existsSync(profilePath)) return { port: null, igwPort: null };
  let text;
  try {
    text = readFileSync(profilePath, "utf8");
  } catch {
    return { port: null, igwPort: null };
  }
  // Normalize CRLF -> LF before parsing. The section-boundary regex
  // below relies on `$` (multiline) matching end-of-line -- `$` matches
  // before `\n` but not before a `\r` that precedes it, so an
  // unnormalized CRLF file causes the lookahead to treat the position
  // right before the trailing `\r` as the section boundary, silently
  // truncating the section one line early and dropping whichever key
  // (Port or IGWPort) comes last. usersettings.py always writes LF-only
  // on this project's Linux hosts, so this is a defensive normalization
  // for hand-edited/out-of-band files, not the common path.
  const normalized = text.replace(/\r\n/g, "\n");
  const sectionMatch = normalized.match(/^\[Engine:URL\]\s*$([\s\S]*?)(?=^\[|\s*$(?!\n))/m);
  // Upstream review finding: if [Engine:URL] is absent entirely (a
  // stripped-down or hand-edited profile file), this previously fell
  // back to scanning the WHOLE file for a Port=/IGWPort= match -- which
  // could silently pick up an unrelated key from a different section
  // (e.g. [Engine:ConsoleVariables]'s own Port= override, which means
  // something entirely different) and report it as the real game port.
  // The real Python tool (usersettings.py's profile_get_key()) only
  // ever looks inside the named section; if the section doesn't exist,
  // it returns nothing for that key, not a value from elsewhere in the
  // file. Match that exactly: no section match -> no port match, fall
  // through to the legacy usersettings.json / stock fallback chain.
  if (!sectionMatch) return { port: null, igwPort: null };
  const sectionText = sectionMatch[1];
  // Layer 3 audit regression: if a section has a duplicate key (Port=
  // appearing twice, which usersettings.py's own
  // _advanced_editor_duplicate_key_warnings() explicitly anticipates and
  // warns about as a real, reachable state, not a theoretical one), the
  // LAST occurrence wins -- matching usersettings.py's profile_get_key()/
  // profile_get_raw_key(), which both iterate reversed(block["lines"])
  // for exactly this reason (standard INI semantics: a later assignment
  // overrides an earlier one in the same section). Directly verified via
  // both implementations against the same duplicate-key fixture -- a
  // previous first-match approach here disagreed with the real Python
  // tool the game server itself uses to materialize this file, which
  // would have shown operators a different port than the one the engine
  // actually bound to. matchAll() + at(-1) implements "last match" for a
  // global multiline regex.
  const portMatches = [...sectionText.matchAll(/^\s*Port\s*=\s*(\d+)\s*$/gm)];
  const igwMatches = [...sectionText.matchAll(/^\s*IGWPort\s*=\s*(\d+)\s*$/gm)];
  return {
    port: portMatches.length ? Number(portMatches.at(-1)[1]) : null,
    igwPort: igwMatches.length ? Number(igwMatches.at(-1)[1]) : null
  };
}

// Reads Port/IGWPort from runtime/generated/usersettings.json's legacy
// "engine" config -- the SECOND step of the real fallback chain used by
// runtime-env.sh's usersettings_engine_value() (see that function and
// usersettings.py's load_config()/ENGINE_FIELDS for the authoritative
// implementation this mirrors). This is genuinely a legacy path: once
// `dune init`/materialize has run at least once, gameplay-profile.ini
// exists and this function is never reached for these two fields. It
// matters only in the narrow fresh-install window before the first
// materialize call, which is exactly the window a Requirement 20 Layer
// 3 audit found this file's Node-side resolver handling differently
// (and incorrectly, relative to the real shell/Python resolver) by
// falling back to .env instead. usersettings.json's schema is
// {"engine": {"port": "...", "igw_port": "..."}, ...} -- see
// usersettings.py's load_config().
function readEnginePortsFromLegacyUsersettings(repoRoot) {
  const path = resolve(repoRoot, "runtime/generated/usersettings.json");
  if (!existsSync(path)) return { port: null, igwPort: null };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { port: null, igwPort: null };
  }
  const engine = parsed && typeof parsed === "object" ? parsed.engine : null;
  if (!engine || typeof engine !== "object") return { port: null, igwPort: null };
  const rawPort = engine.port;
  const rawIgwPort = engine.igw_port;
  return {
    port: rawPort !== undefined && rawPort !== null && String(rawPort).trim() !== "" ? Number(rawPort) : null,
    igwPort: rawIgwPort !== undefined && rawIgwPort !== null && String(rawIgwPort).trim() !== "" ? Number(rawIgwPort) : null
  };
}

function portValue(value, fallback) {
  const parsed = Number(value || fallback);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

export function loadConfig() {
  const repoRoot = resolve(process.env.DUNE_DOCKER_DIR || process.env.RUNTIME_DIR || process.cwd());
  const generatedDir = resolve(repoRoot, "runtime/generated");
  const secretsDir = resolve(repoRoot, "runtime/secrets");
  const secureCookieEnv = process.env.ADMIN_SECURE_COOKIES;
  mkdirSync(generatedDir, { recursive: true });
  mkdirSync(secretsDir, { recursive: true });
  repairRootOwnedHostState(repoRoot);

  const adminPasswordFile = resolve(secretsDir, "admin-web-password.txt");
  const adminPasswordEnvManaged = Boolean(process.env.ADMIN_PASSWORD);
  return {
    appName: APP_NAME,
    version: readConsoleVersion(repoRoot),
    repoRoot,
    duneScript: resolve(repoRoot, "runtime/scripts/dune"),
    host: resolveAdminBindHost(process.env.ADMIN_BIND_HOST),
    port: Number(process.env.ADMIN_BIND_PORT || 8088),
    // A getter, not a plain value: config is loaded once at process
    // startup and lives for the life of the process (see server.js's
    // top-level `const config = loadConfig()`), but clientBase/igwBase
    // are backed by runtime/generated/gameplay-profile.ini, which the
    // Maps UI can rewrite at any time without restarting the console
    // (see userSettingsRawWriteRoute in server.js). A plain value here
    // would silently re-introduce the exact staleness bug resolvePorts()
    // was written to fix -- correct once at boot, stale forever after
    // the first Maps UI port change. Re-resolving on every read keeps
    // every consumer (publicConfig() -> /api/auth/state, preflight.js)
    // live-accurate without requiring a console restart. resolvePorts()
    // is a cheap sync file read (see readEnginePortsFromProfile()), safe
    // to call on every request.
    get ports() {
      return resolvePorts(process.env, repoRoot);
    },
    authDisabled: process.env.ADMIN_AUTH_DISABLED === "1",
    secureCookies: secureCookieEnv === undefined ? process.env.NODE_ENV === "production" : secureCookieEnv === "1",
    allowHostBootstrap: process.env.ALLOW_HOST_BOOTSTRAP === "true",
    mockMode: process.env.ADMIN_MOCK_MODE === "1",
    sessionSecret: getOrCreateSecret(resolve(secretsDir, "admin-web-session-secret.txt"), 48),
    adminPassword: process.env.ADMIN_PASSWORD || getOrCreateSecret(adminPasswordFile, 18),
    adminPasswordFile,
    adminPasswordEnvManaged,
    generatedDir,
    secretsDir,
    apiKeysFile: resolve(secretsDir, "api-keys.json"),
    auditLog: resolve(generatedDir, "web-admin-audit.jsonl"),
    spicefieldOverridesFile: resolve(generatedDir, "spicefield-overrides.json"),
    // Committed data, not runtime state: Large-spice coordinates are a
    // permanent lookup keyed by Coriolis seed (0-11) -- the same seed
    // number produces the same pool on every Deep Desert server, so this
    // ships in the repo and grows over time as more seeds get recorded.
    spiceLocationsFile: resolve(repoRoot, "console/api/data/large-spice-locations.json"),
    // Runtime companion to the committed archive above -- the console
    // fills this in itself as it observes fields going active, growing
    // "Static Spice Spawns" beyond what the committed archive alone has.
    learnedSpiceLocationsFile: resolve(generatedDir, "learned-spice-locations.json"),
    landsraadMilestonePresetFile: resolve(generatedDir, "landsraad-milestones.json"),
    taskRetention: Number(process.env.ADMIN_TASK_RETENTION || 200),
    maxJsonBytes: Number(process.env.ADMIN_MAX_JSON_BYTES || 2 * 1024 * 1024),
    maxUploadBytes: Number(process.env.ADMIN_MAX_UPLOAD_BYTES || 1024 * 1024 * 1024),
    commandTimeoutMs: Number(process.env.ADMIN_COMMAND_TIMEOUT_MS || 120000),
    updateCheckCacheMs: Number(process.env.ADMIN_UPDATE_CHECK_CACHE_MS || 5 * 60 * 1000),
    // status/readiness each shell out for ~4s; Home asks for both on every
    // mount and idle poll. clampInt, not bare Number() like its neighbours: a
    // typo'd env var here would otherwise become NaN and disable the cache
    // silently. 0 disables it deliberately.
    statusCacheMs: clampInt(process.env.ADMIN_STATUS_CACHE_MS, 15000, 0, 120000),
    staticDir: process.env.ADMIN_STATIC_DIR || resolve(repoRoot, "console/web/dist"),
    allowedIps: parseAllowedIps(process.env.ADMIN_ALLOWED_IPS)
  };
}

export function parseAllowedIps(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((ip) => ip.trim())
    .filter((ip) => ip.length > 0)
    .map((ip) => ip.replace(/^::ffff:/, ""));
}

function repairRootOwnedHostState(repoRoot) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) return;

  let owner;
  try {
    owner = statSync(repoRoot);
  } catch {
    return;
  }
  if (!owner.uid || owner.uid === 0) return;

  const envPath = resolve(repoRoot, ".env");
  if (existsSync(envPath)) {
    updateEnvFileValue(envPath, "DUNE_HOST_UID", String(owner.uid));
    updateEnvFileValue(envPath, "DUNE_HOST_GID", String(owner.gid));
  }

  for (const path of [
    repoRoot,
    envPath,
    resolve(repoRoot, "runtime/generated"),
    resolve(repoRoot, "runtime/generated/battlegroup.env"),
    resolve(repoRoot, "runtime/generated/db-backup.env"),
    resolve(repoRoot, "runtime/generated/director-character-transfer.ini"),
    resolve(repoRoot, "runtime/generated/director-deepdesert-dual.ini"),
    resolve(repoRoot, "runtime/generated/ip-change-restart.env"),
    resolve(repoRoot, "runtime/generated/landsraad-milestones.json"),
    resolve(repoRoot, "runtime/generated/map-runtime-modes.json"),
    resolve(repoRoot, "runtime/generated/memory-balancer.json"),
    resolve(repoRoot, "runtime/generated/message-of-the-day.json"),
    resolve(repoRoot, "runtime/generated/message-of-the-day-state.json"),
    resolve(repoRoot, "runtime/generated/player-announcements.json"),
    resolve(repoRoot, "runtime/generated/player-announcements-state.json"),
    resolve(repoRoot, "runtime/generated/scheduled-map-messages.json"),
    resolve(repoRoot, "runtime/generated/player-bans.json"),
    resolve(repoRoot, "runtime/generated/public-directory-status.json"),
    resolve(repoRoot, "runtime/generated/restart-queue.json"),
    resolve(repoRoot, "runtime/generated/restart-queue-state.json"),
    resolve(repoRoot, "runtime/generated/restart-schedule.env"),
    resolve(repoRoot, "runtime/generated/shutdown-protection.env"),
    resolve(repoRoot, "runtime/generated/sietch-config.json"),
    resolve(repoRoot, "runtime/generated/spicefield-overrides.json"),
    resolve(repoRoot, "runtime/generated/learned-spice-locations.json"),
    resolve(repoRoot, "runtime/generated/update-auto.env"),
    resolve(repoRoot, "runtime/generated/usersettings.json"),
    resolve(repoRoot, "runtime/generated/auto-refill-bases.json"),
    resolve(repoRoot, "runtime/generated/pending-generator-refills.json"),
    resolve(repoRoot, "runtime/generated/gameplay-profile.ini"),
    resolve(repoRoot, "runtime/generated/care-package.json"),
    resolve(repoRoot, "runtime/generated/care-package-grants.jsonl"),
    resolve(repoRoot, "runtime/generated/care-package-pending-returns.json"),
    resolve(repoRoot, "runtime/addons"),
    resolve(repoRoot, "runtime/addons/downloads"),
    resolve(repoRoot, "runtime/addons/grant-receipts"),
    resolve(repoRoot, "runtime/addons/installed"),
    resolve(repoRoot, "runtime/addons/staging"),
    resolve(repoRoot, "runtime/addons/state.json"),
    resolve(repoRoot, "runtime/secrets/funcom-token.txt"),
    resolve(repoRoot, "runtime/secrets/public-directory.json")
  ]) {
    try {
      if (existsSync(path)) chownSync(path, owner.uid, owner.gid);
    } catch {
      // Best effort. The console should still start even if a mounted path
      // cannot be chowned by the current runtime.
    }
  }
}

function updateEnvFileValue(path, key, value) {
  const current = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  let found = false;
  const line = `${key}=${value}`;
  const next = current.map((entry) => {
    if (envLineKey(entry) !== key) return entry;
    found = true;
    return line;
  });
  if (!found) next.push(line);
  writeFileSync(path, `${next.filter((entry, index) => entry !== "" || index < next.length - 1).join("\n")}\n`, { mode: 0o644 });
  try { chmodSync(path, 0o644); } catch {}
}

function envLineKey(line) {
  const text = String(line || "").trimStart();
  if (!text || text.startsWith("#")) return "";
  const index = text.indexOf("=");
  return index > 0 ? text.slice(0, index).trim() : "";
}

function readConsoleVersion(repoRoot) {
  try {
    return readFileSync(resolve(repoRoot, "VERSION"), "utf8").trim() || "dev";
  } catch {
    return "dev";
  }
}

export function readConsoleBuildId(staticDir, fallback = "dev") {
  try {
    // Vite's index references every entry asset by its content-hashed
    // filename, so its digest changes whenever the browser-facing build
    // changes. Reading it live also detects an in-place rebuild without
    // requiring VERSION to be bumped or the API process to restart.
    const index = readFileSync(resolve(staticDir, "index.html"));
    return createHash("sha256").update(index).digest("hex").slice(0, 16);
  } catch {
    return fallback;
  }
}

function resolveAdminBindHost(value) {
  const raw = String(value || "0.0.0.0").trim();
  if (raw && raw !== "auto") return raw;
  return detectPrivateIpv4() || "127.0.0.1";
}

function detectPrivateIpv4() {
  let interfaces = {};
  try {
    interfaces = networkInterfaces();
  } catch {
    return "";
  }
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family !== "IPv4" || address.internal || !isPrivateIpv4(address.address)) continue;
      return address.address;
    }
  }
  return "";
}

function isPrivateIpv4(value) {
  const parts = String(value || "").split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  return false;
}

function getOrCreateSecret(path, bytes) {
  if (existsSync(path)) {
    return readFileSync(path, "utf8").trim();
  }
  mkdirSync(dirname(path), { recursive: true });
  const value = randomBytes(bytes).toString("base64url");
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on non-POSIX development hosts.
  }
  return value;
}

export function publicConfig(config) {
  return {
    appName: config.appName,
    version: config.version,
    buildId: readConsoleBuildId(config.staticDir, config.version),
    repoRoot: config.repoRoot,
    host: config.host,
    port: config.port,
    ports: config.ports,
    authDisabled: config.authDisabled,
    adminPasswordEnvManaged: config.adminPasswordEnvManaged,
    secureCookies: config.secureCookies,
    allowHostBootstrap: config.allowHostBootstrap,
    mockMode: config.mockMode
  };
}
