#!/usr/bin/env node
import { readFileSync } from "node:fs";

const command = process.argv[2] || "status";
const role = process.argv[3] || "public";

const apiUrl = requiredEnv("DUNE_CONSOLE_API_URL").replace(/\/$/, "");
const apiToken = readFileSync(requiredEnv("DUNE_BOT_API_TOKEN_FILE"), "utf8").trim();

const roleIds = role === "owner"
  ? csv(process.env.DISCORD_OWNER_ROLE_IDS)
  : role === "admin"
    ? csv(process.env.DISCORD_ADMIN_ROLE_IDS)
    : role === "moderator"
      ? csv(process.env.DISCORD_MODERATOR_ROLE_IDS)
      : role === "observer"
        ? csv(process.env.DISCORD_OBSERVER_ROLE_IDS)
        : [];

const actor = {
  guildId: process.env.DISCORD_GUILD_ID || "local-guild",
  channelId: "local-channel",
  userId: "local-user",
  username: `local-${role}`,
  roleIds,
  commandName: `/dune ${command}`
};

const commandMap = {
  health: { method: "GET", path: "/api/integrations/discord/health" },
  status: { method: "POST", path: "/api/integrations/discord/status", body: { actor, diagnostic: false } },
  statusDetail: { method: "POST", path: "/api/integrations/discord/status", body: { actor, diagnostic: true } },
  readiness: { method: "POST", path: "/api/integrations/discord/readiness", body: { actor } },
  services: { method: "POST", path: "/api/integrations/discord/services", body: { actor } }
};

if (!commandMap[command]) {
  console.error(`Unsupported command: ${command}`);
  console.error(`Use one of: ${Object.keys(commandMap).join(", ")}`);
  process.exit(2);
}

const health = await call({ method: "GET", path: "/api/integrations/discord/health" });
const request = commandMap[command];
const result = await call(request);

console.log(JSON.stringify({
  command,
  role,
  actorRoleIdsSent: roleIds,
  consoleRolePolicy: health.body?.rolePolicy || null,
  status: result.status,
  body: result.body
}, null, 2));

process.exitCode = result.ok ? 0 : 1;

async function call(request) {
  const response = await fetch(`${apiUrl}${request.path}`, {
    method: request.method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      ...(request.body ? { "content-type": "application/json" } : {})
    },
    body: request.body ? JSON.stringify(request.body) : undefined
  });
  const body = await response.json().catch(() => ({ ok: false, code: "invalid_response", error: "Console returned non-JSON output." }));
  return { ok: response.ok, status: response.status, body };
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function csv(value = "") {
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}
