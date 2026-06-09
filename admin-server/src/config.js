import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";

export const APP_NAME = "Arrakis Server Console";

export function loadConfig() {
  const repoRoot = resolve(process.env.DUNE_DOCKER_DIR || process.env.RUNTIME_DIR || process.cwd());
  const generatedDir = resolve(repoRoot, "runtime/generated");
  const secretsDir = resolve(repoRoot, "runtime/secrets");
  const secureCookieEnv = process.env.ADMIN_SECURE_COOKIES;
  mkdirSync(generatedDir, { recursive: true });
  mkdirSync(secretsDir, { recursive: true });

  return {
    appName: APP_NAME,
    repoRoot,
    duneScript: resolve(repoRoot, "runtime/scripts/dune"),
    host: resolveAdminBindHost(process.env.ADMIN_BIND_HOST),
    port: Number(process.env.ADMIN_BIND_PORT || 8088),
    authDisabled: process.env.ADMIN_AUTH_DISABLED === "1",
    secureCookies: secureCookieEnv === undefined ? process.env.NODE_ENV === "production" : secureCookieEnv === "1",
    allowHostBootstrap: process.env.ALLOW_HOST_BOOTSTRAP === "true",
    mockMode: process.env.ADMIN_MOCK_MODE === "1",
    sessionSecret: getOrCreateSecret(resolve(secretsDir, "admin-web-session-secret.txt"), 48),
    adminPassword: process.env.ADMIN_PASSWORD || getOrCreateSecret(resolve(secretsDir, "admin-web-password.txt"), 18),
    generatedDir,
    secretsDir,
    auditLog: resolve(generatedDir, "web-admin-audit.jsonl"),
    taskRetention: Number(process.env.ADMIN_TASK_RETENTION || 200),
    maxJsonBytes: Number(process.env.ADMIN_MAX_JSON_BYTES || 2 * 1024 * 1024),
    maxUploadBytes: Number(process.env.ADMIN_MAX_UPLOAD_BYTES || 1024 * 1024 * 1024),
    commandTimeoutMs: Number(process.env.ADMIN_COMMAND_TIMEOUT_MS || 120000),
    staticDir: process.env.ADMIN_STATIC_DIR || resolve(repoRoot, "web/dist")
  };
}

function resolveAdminBindHost(value) {
  const raw = String(value || "auto").trim();
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
    repoRoot: config.repoRoot,
    authDisabled: config.authDisabled,
    secureCookies: config.secureCookies,
    allowHostBootstrap: config.allowHostBootstrap,
    mockMode: config.mockMode
  };
}
