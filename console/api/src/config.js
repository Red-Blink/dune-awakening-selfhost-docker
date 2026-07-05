import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync, chownSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";

export const APP_NAME = "Dune Docker Console";

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
    auditLog: resolve(generatedDir, "web-admin-audit.jsonl"),
    spicefieldOverridesFile: resolve(generatedDir, "spicefield-overrides.json"),
    taskRetention: Number(process.env.ADMIN_TASK_RETENTION || 200),
    maxJsonBytes: Number(process.env.ADMIN_MAX_JSON_BYTES || 2 * 1024 * 1024),
    maxUploadBytes: Number(process.env.ADMIN_MAX_UPLOAD_BYTES || 1024 * 1024 * 1024),
    commandTimeoutMs: Number(process.env.ADMIN_COMMAND_TIMEOUT_MS || 120000),
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
    resolve(repoRoot, "runtime/generated/map-runtime-modes.json"),
    resolve(repoRoot, "runtime/generated/memory-balancer.json"),
    resolve(repoRoot, "runtime/generated/message-of-the-day.json"),
    resolve(repoRoot, "runtime/generated/message-of-the-day-state.json"),
    resolve(repoRoot, "runtime/generated/player-announcements.json"),
    resolve(repoRoot, "runtime/generated/player-announcements-state.json"),
    resolve(repoRoot, "runtime/generated/restart-schedule.env"),
    resolve(repoRoot, "runtime/generated/shutdown-protection.env"),
    resolve(repoRoot, "runtime/generated/sietch-config.json"),
    resolve(repoRoot, "runtime/generated/spicefield-overrides.json"),
    resolve(repoRoot, "runtime/generated/update-auto.env"),
    resolve(repoRoot, "runtime/generated/usersettings.json"),
    resolve(repoRoot, "runtime/generated/gameplay-profile.ini"),
    resolve(repoRoot, "runtime/generated/care-package.json"),
    resolve(repoRoot, "runtime/generated/care-package-grants.jsonl"),
    resolve(repoRoot, "runtime/generated/care-package-pending-returns.json"),
    resolve(repoRoot, "runtime/addons"),
    resolve(repoRoot, "runtime/addons/downloads"),
    resolve(repoRoot, "runtime/addons/installed"),
    resolve(repoRoot, "runtime/addons/staging"),
    resolve(repoRoot, "runtime/addons/state.json"),
    resolve(repoRoot, "runtime/secrets/funcom-token.txt")
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
    repoRoot: config.repoRoot,
    host: config.host,
    port: config.port,
    authDisabled: config.authDisabled,
    adminPasswordEnvManaged: config.adminPasswordEnvManaged,
    secureCookies: config.secureCookies,
    allowHostBootstrap: config.allowHostBootstrap,
    mockMode: config.mockMode
  };
}
