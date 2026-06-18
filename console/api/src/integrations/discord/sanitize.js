import { redact, redactValue } from "../../redact.js";

const INTERNAL_IPV4_PATTERN = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g;
const INTERNAL_HOST_PORT_PATTERN = /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}):\d+\b/g;
const CONNECTION_STRING_PATTERN = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb|redis|amqp|amqps):\/\/[^\s"']+/gi;
const ENV_PATH_PATTERN = /(?:^|\s)(?:\/repo|\/app|\/run\/secrets|runtime\/secrets|\.env)(?:[^\s,"']*)?/g;

const PUBLIC_BLOCKED_KEYS = new Set([
  "ssh_host",
  "sshHost",
  "databaseUrl",
  "dbUrl",
  "adminPassword",
  "token",
  "password",
  "secret",
  "funcomToken",
  "env",
  "environment"
]);

export function sanitizeDiscordPublicStatus(status = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(status || {})) {
    if (PUBLIC_BLOCKED_KEYS.has(key)) continue;
    if (/host|ip|url|path|token|password|secret|env/i.test(key)) continue;
    safe[key] = sanitizeDiscordValue(value);
  }
  return redactValue(safe);
}

export function sanitizeDiscordValue(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeDiscordValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !PUBLIC_BLOCKED_KEYS.has(key) && !/host|ip|url|path|token|password|secret|env/i.test(key))
      .map(([key, item]) => [key, sanitizeDiscordValue(item)]));
  }
  if (typeof value !== "string") return value;
  return redact(value)
    .replace(CONNECTION_STRING_PATTERN, "<redacted-connection-string>")
    .replace(INTERNAL_HOST_PORT_PATTERN, "<internal-address>")
    .replace(INTERNAL_IPV4_PATTERN, "<internal-address>")
    .replace(ENV_PATH_PATTERN, " <internal-path>")
    .trim();
}

export function discordSafeError(error) {
  const code = String(error?.code || "adapter_error").replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
  const message = sanitizeDiscordValue(String(error?.message || "Request failed."));
  return {
    ok: false,
    code,
    error: message || "Request failed."
  };
}
