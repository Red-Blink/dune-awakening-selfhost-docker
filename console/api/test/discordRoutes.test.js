import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handleDiscordAdapterRoute, isDiscordAdapterRoute, requireDiscordBotToken } from "../src/integrations/discord/routes.js";
import { DISCORD_ADAPTER_ROUTES } from "../src/integrations/discord/adapter.js";

const OLD_ENV = { ...process.env };
let tempDir;
let tokenFile;

function resetEnv() {
  tempDir = mkdtempSync(join(tmpdir(), "dune-discord-routes-"));
  tokenFile = join(tempDir, "bot-api.txt");
  writeFileSync(tokenFile, "abc\n", { mode: 0o600 });
  process.env.DUNE_BOT_API_TOKEN_FILE = tokenFile;
  process.env.DUNE_DISCORD_ADAPTER_ENABLED = "true";
  process.env.DISCORD_OBSERVER_ROLE_IDS = "role-observer";
  process.env.DISCORD_MODERATOR_ROLE_IDS = "role-moderator";
  process.env.DISCORD_ADMIN_ROLE_IDS = "role-admin";
  process.env.DISCORD_OWNER_ROLE_IDS = "role-owner";
}

function cleanupEnv() {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  process.env = { ...OLD_ENV };
}

function req({ method = "GET", authorization = "Bearer abc" } = {}) {
  return { method, headers: { authorization } };
}

function captureJson() {
  const calls = [];
  return {
    calls,
    json: (_res, status, body) => {
      calls.push({ status, body });
      return body;
    }
  };
}

const config = {
  auditLog: "/tmp/dune-discord-routes-audit.jsonl",
  generatedDir: "/tmp/dune-discord-routes-generated"
};

function actor(roleIds = []) {
  return {
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    username: "tester",
    roleIds,
    interactionId: "interaction-1",
    commandName: "/dune status"
  };
}

test.beforeEach(resetEnv);
test.afterEach(cleanupEnv);

test("identifies experimental Discord adapter routes", () => {
  assert.equal(isDiscordAdapterRoute(DISCORD_ADAPTER_ROUTES.HEALTH), true);
  assert.equal(isDiscordAdapterRoute(DISCORD_ADAPTER_ROUTES.STATUS), true);
  assert.equal(isDiscordAdapterRoute(DISCORD_ADAPTER_ROUTES.READINESS), true);
  assert.equal(isDiscordAdapterRoute(DISCORD_ADAPTER_ROUTES.SERVICES), true);
  assert.equal(isDiscordAdapterRoute("/api/integrations/discord/backups/delete"), false);
  assert.equal(isDiscordAdapterRoute("/api/admin/broadcast"), false);
});

test("rejects disabled adapter before processing route", async () => {
  process.env.DUNE_DISCORD_ADAPTER_ENABLED = "false";
  const out = captureJson();
  await handleDiscordAdapterRoute({
    req: req(),
    res: {},
    path: DISCORD_ADAPTER_ROUTES.HEALTH,
    config,
    readJson: async () => ({}),
    json: out.json
  });
  assert.equal(out.calls[0].status, 404);
  assert.equal(out.calls[0].body.code, "adapter_disabled");
});

test("rejects missing bot API credential", async () => {
  const out = captureJson();
  await handleDiscordAdapterRoute({
    req: req({ authorization: "" }),
    res: {},
    path: DISCORD_ADAPTER_ROUTES.HEALTH,
    config,
    readJson: async () => ({}),
    json: out.json
  });
  assert.equal(out.calls[0].status, 401);
  assert.equal(out.calls[0].body.code, "missing_bot_token");
});

test("rejects invalid bot API credential", () => {
  assert.throws(() => requireDiscordBotToken(req({ authorization: "Bearer xyz" }), config), /Invalid adapter credential/);
});

test("allows health with valid bot API credential", async () => {
  const out = captureJson();
  await handleDiscordAdapterRoute({
    req: req(),
    res: {},
    path: DISCORD_ADAPTER_ROUTES.HEALTH,
    config,
    readJson: async () => ({}),
    json: out.json
  });
  assert.equal(out.calls[0].status, 200);
  assert.equal(out.calls[0].body.ok, true);
  assert.equal(out.calls[0].body.readOnly, true);
  assert.equal(out.calls[0].body.writesEnabled, false);
  assert.ok(out.calls[0].body.liveRoutes.includes(DISCORD_ADAPTER_ROUTES.STATUS));
  assert.ok(out.calls[0].body.plannedRoutes.includes(DISCORD_ADAPTER_ROUTES.LOGS));
});

test("allows sanitized status with valid bot API credential", async () => {
  const out = captureJson();
  await handleDiscordAdapterRoute({
    req: req({ method: "POST" }),
    res: {},
    path: DISCORD_ADAPTER_ROUTES.STATUS,
    config,
    readJson: async () => ({ actor: actor([]), diagnostic: false }),
    json: out.json,
    statusProvider: async () => ({ db_connected: true, ssh_host: "172.19.240.122:22", runtime: "docker" })
  });
  assert.equal(out.calls[0].status, 200);
  assert.equal(out.calls[0].body.ok, true);
  assert.equal(out.calls[0].body.result.db_connected, true);
  assert.equal(Object.hasOwn(out.calls[0].body.result, "ssh_host"), false);
});

test("allows readiness with observer role", async () => {
  const out = captureJson();
  await handleDiscordAdapterRoute({
    req: req({ method: "POST" }),
    res: {},
    path: DISCORD_ADAPTER_ROUTES.READINESS,
    config,
    readJson: async () => ({ actor: actor(["role-observer"]) }),
    json: out.json,
    readinessProvider: async () => ({ ready: true, overall: "READY", issues: [] })
  });
  assert.equal(out.calls[0].status, 200);
  assert.equal(out.calls[0].body.result.ready, true);
});

test("allows services with observer role", async () => {
  const out = captureJson();
  await handleDiscordAdapterRoute({
    req: req({ method: "POST" }),
    res: {},
    path: DISCORD_ADAPTER_ROUTES.SERVICES,
    config,
    readJson: async () => ({ actor: actor(["role-observer"]) }),
    json: out.json,
    servicesProvider: async () => ({ overall: "OK", services: [{ name: "Database", status: "up" }], issues: [] })
  });
  assert.equal(out.calls[0].status, 200);
  assert.equal(out.calls[0].body.result.services[0].name, "Database");
});
