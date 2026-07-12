import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { DISCORD_ADAPTER_ROUTES, discordAdapterErrorResponse, discordAdapterHealth, discordAdapterPopulation, discordAdapterReadiness, discordAdapterServices, discordAdapterStatus, discordWritesEnabled } from "../src/integrations/discord/adapter.js";

const OLD_ENV = { ...process.env };
const FAKE_TOKEN_FILE = "/tmp/dune-test-bot-token.txt";
const FAKE_TOKEN = "test-bot-token-value";

function setupBotToken() {
  writeFileSync(FAKE_TOKEN_FILE, FAKE_TOKEN);
  process.env.DUNE_BOT_API_TOKEN_FILE = FAKE_TOKEN_FILE;
}

function teardownBotToken() {
  try { unlinkSync(FAKE_TOKEN_FILE); } catch {}
  delete process.env.DUNE_BOT_API_TOKEN_FILE;
}

function authHeaders() {
  return { authorization: `Bearer ${FAKE_TOKEN}` };
}

function resetEnv() {
  process.env.DISCORD_OBSERVER_ROLE_IDS = "role-observer";
  process.env.DISCORD_MODERATOR_ROLE_IDS = "role-moderator";
  process.env.DISCORD_ADMIN_ROLE_IDS = "role-admin";
  process.env.DISCORD_OWNER_ROLE_IDS = "role-owner";
  process.env.DUNE_DISCORD_ADAPTER_ENABLED = "true";
  process.env.DUNE_DISCORD_WRITES_ENABLED = "false";
}

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

const config = {
  auditLog: "/tmp/dune-discord-adapter-test-audit.jsonl",
  generatedDir: "/tmp/dune-discord-adapter-test-generated"
};

test.beforeEach(resetEnv);
test.after(() => {
  process.env = OLD_ENV;
});

test("reports adapter health as experimental read-only", async () => {
  const result = await discordAdapterHealth({});
  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(result.experimental, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.writesEnabled, false);
  assert.deepEqual([...result.liveRoutes].sort(), [
    "/api/integrations/discord/announcements",
    "/api/integrations/discord/broadcast",
    "/api/integrations/discord/db",
    "/api/integrations/discord/health",
    "/api/integrations/discord/population",
    "/api/integrations/discord/ports",
    "/api/integrations/discord/readiness",
    "/api/integrations/discord/servers",
    "/api/integrations/discord/services",
    "/api/integrations/discord/status",
    "/api/integrations/discord/version"
  ].sort());
  assert.ok(result.plannedRoutes.includes("/api/integrations/discord/logs"));
  assert.ok(result.plannedRoutes.includes("/api/integrations/discord/ops/activity"));
});

test("forces writes disabled even if environment attempts to enable them", () => {
  process.env.DUNE_DISCORD_WRITES_ENABLED = "true";
  assert.equal(discordWritesEnabled({ discordWritesEnabled: true }), false);
});

test("exposes only experimental read-only route names", () => {
  const routes = Object.values(DISCORD_ADAPTER_ROUTES);
  assert.deepEqual(routes.sort(), [
    "/api/integrations/discord/announcements",
    "/api/integrations/discord/backups/list",
    "/api/integrations/discord/broadcast",
    "/api/integrations/discord/db",
    "/api/integrations/discord/health",
    "/api/integrations/discord/logs",
    "/api/integrations/discord/map-state",
    "/api/integrations/discord/ops/activity",
    "/api/integrations/discord/ops/combat",
    "/api/integrations/discord/ops/dashboard",
    "/api/integrations/discord/ops/economy",
    "/api/integrations/discord/ops/inventory",
    "/api/integrations/discord/ops/location",
    "/api/integrations/discord/ops/prometheus",
    "/api/integrations/discord/ops/resources",
    "/api/integrations/discord/ops/soc",
    "/api/integrations/discord/population",
    "/api/integrations/discord/ports",
    "/api/integrations/discord/readiness",
    "/api/integrations/discord/servers",
    "/api/integrations/discord/services",
    "/api/integrations/discord/status",
    "/api/integrations/discord/version"
  ].sort());
  for (const route of routes) {
    assert.doesNotMatch(route, /write|execute|delete|restore|kick|grant|teleport|reset|admin/i);
  }
});

test("returns sanitized public status", async () => {
  const response = await discordAdapterStatus({
    config,
    actorPayload: actor([]),
    diagnostic: false,
    statusProvider: async () => ({
      db_connected: true,
      ssh_connected: true,
      ssh_host: "172.19.240.122:22",
      runtime: "docker"
    })
  });

  assert.equal(response.ok, true);
  assert.equal(response.result.db_connected, true);
  assert.equal(response.result.ssh_connected, true);
  assert.equal(response.result.runtime, "docker");
  assert.equal(Object.hasOwn(response.result, "ssh_host"), false);
});

test("requires admin capability before diagnostic status provider runs", async () => {
  let called = false;
  await assert.rejects(() => discordAdapterStatus({
    config,
    actorPayload: actor(["role-moderator"]),
    diagnostic: true,
    statusProvider: async () => {
      called = true;
      return { ssh_host: "172.19.240.122:22" };
    }
  }), /not authorized/);
  assert.equal(called, false);

  const response = await discordAdapterStatus({
    config,
    actorPayload: actor(["role-admin"]),
    diagnostic: true,
    statusProvider: async () => ({ ssh_host: "172.19.240.122:22" })
  });
  assert.equal(response.result.ssh_host, undefined);
});

test("allows observer readiness and services", async () => {
  const readiness = await discordAdapterReadiness({
    config,
    actorPayload: actor(["role-observer"]),
    readinessProvider: async () => ({ ready: true, overall: "READY", issues: [] })
  });
  assert.equal(readiness.ok, true);
  assert.equal(readiness.result.ready, true);

  const services = await discordAdapterServices({
    config,
    actorPayload: actor(["role-observer"]),
    servicesProvider: async () => ({ overall: "OK", services: [{ name: "Database", status: "up" }], issues: [] })
  });
  assert.equal(services.ok, true);
  assert.equal(services.result.services[0].name, "Database");
});

test("allows moderator population summary", async () => {
  const response = await discordAdapterPopulation({
    config,
    actorPayload: actor(["role-moderator"]),
    populationProvider: async () => ({ overall: "OK", onlinePlayers: 2, totalPlayers: 3, detailsSuppressed: true })
  });
  assert.equal(response.ok, true);
  assert.equal(response.result.onlinePlayers, 2);
  assert.equal(response.result.detailsSuppressed, true);
});

test("blocks public readiness services and population", async () => {
  await assert.rejects(() => discordAdapterReadiness({
    config,
    actorPayload: actor([]),
    readinessProvider: async () => ({ ready: true })
  }), /not authorized/);

  await assert.rejects(() => discordAdapterServices({
    config,
    actorPayload: actor([]),
    servicesProvider: async () => ({ services: [] })
  }), /not authorized/);

  await assert.rejects(() => discordAdapterPopulation({
    config,
    actorPayload: actor([]),
    populationProvider: async () => ({ onlinePlayers: 1 })
  }), /not authorized/);
});

test("formats safe adapter errors", () => {
  const error = new Error("Failed with marker sample-value at 127.0.0.1:15432");
  error.code = "bad_request";
  error.statusCode = 400;
  const response = discordAdapterErrorResponse(error);
  assert.equal(response.statusCode, 400);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.code, "bad_request");
  assert.doesNotMatch(response.body.error, /127\.0\.0\.1/);
});

// Server route integration test — exercises handleDiscordAdapterRoute through a live HTTP server
import { createServer } from "node:http";
import { handleDiscordAdapterRoute } from "../src/integrations/discord/routes.js";

test("adapter routes respond through mounted HTTP server path", async () => {
  const tokenFile = "/tmp/discord-adapter-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-test-generated" };

  // Mock providers so routes return 200 without requiring a running Dune server
  const mockStatus = async () => ({ ok: true, summary: { overall: "OK", region: "us", mode: "pve", population: "8/128" } });
  const mockReadiness = async () => ({ ready: true, overall: "READY", issues: [] });
  const mockServices = async () => ({ overall: "OK", services: [{ name: "Database", status: "up" }] });
  const mockPopulation = async () => ({ onlinePlayers: 8, totalPlayers: 128, aggregate: true, detailsSuppressed: true });

  try {
    await new Promise((resolve, reject) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", "http://local");
        const path = url.pathname;
        const readJson = async () => {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          return Buffer.concat(chunks).length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        };
        const json = (r, code, body) => { r.writeHead(code, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };
        await handleDiscordAdapterRoute({
          req, res, path, config: testConfig, readJson, json,
          statusProvider: mockStatus,
          readinessProvider: mockReadiness,
          servicesProvider: mockServices,
          populationProvider: mockPopulation
        });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;

          // Health
          const health = await (await fetch(`${base}/api/integrations/discord/health`, { headers: auth })).json();
          assert.equal(health.ok, true);
          assert.equal(health.enabled, true);

          // Status
          const status = await (await fetch(`${base}/api/integrations/discord/status`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-observer"]) }) })).json();
          assert.equal(status.ok, true);

          // Readiness
          const readiness = await (await fetch(`${base}/api/integrations/discord/readiness`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-observer"]) }) })).json();
          assert.equal(readiness.ok, true);

          // Services
          const services = await (await fetch(`${base}/api/integrations/discord/services`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-observer"]) }) })).json();
          assert.equal(services.ok, true);
          assert.ok(Array.isArray(services.result.services));

          // Population
          const pop = await (await fetch(`${base}/api/integrations/discord/population`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-moderator"]) }) })).json();
          assert.equal(pop.ok, true);

          // Auth: 401 without token
          assert.equal((await fetch(`${base}/api/integrations/discord/health`)).status, 401);

          // Auth: 404 unknown route
          assert.equal((await fetch(`${base}/api/integrations/discord/nonexistent`, { headers: auth })).status, 404);

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
  }
});

test("infra routes enforce actor capability via requireDiscordCapability", () => {
  assert.ok(DISCORD_ADAPTER_ROUTES.SERVERS, "SERVERS route is defined");
  assert.ok(DISCORD_ADAPTER_ROUTES.PORTS, "PORTS route is defined");
  assert.ok(DISCORD_ADAPTER_ROUTES.DB, "DB route is defined");
});

test("infra routes reject missing actor body", async () => {
  setupBotToken();
  try {

    const req = { method: "POST", headers: authHeaders() };
    const res = { statusCode: 0, body: null };
    const json = (r, code, body) => { res.statusCode = code; res.body = body; };

    await handleDiscordAdapterRoute({
      req, res, path: DISCORD_ADAPTER_ROUTES.SERVERS,
      config: { repoRoot: "/tmp" },
      readJson: async () => ({ actor: null }),
      json
    });
    assert.ok(res.statusCode >= 400, `expected 4xx for missing actor, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.match(res.body?.error || "", /actor/i);
  } finally {
    teardownBotToken();
  }
});

test("infra routes reject unauthorized actor tier", async () => {
  setupBotToken();
  try {

    const req = { method: "POST", headers: authHeaders() };
    const res = { statusCode: 0, body: null };
    const json = (r, code, body) => { res.statusCode = code; res.body = body; };
    const oldObs = process.env.DISCORD_OBSERVER_ROLE_IDS;
    process.env.DISCORD_OBSERVER_ROLE_IDS = "role-observer";

    try {
      await handleDiscordAdapterRoute({
        req, res, path: DISCORD_ADAPTER_ROUTES.SERVERS,
        config: { repoRoot: "/tmp" },
        readJson: async () => ({ actor: actor(["role-public"]) }),
        json
      });
      // Public tier should not have SERVICES_READ — expect rejection
      assert.ok(res.statusCode >= 400, `expected 4xx for public+servers, got ${res.statusCode}`);
    } finally {
      process.env.DISCORD_OBSERVER_ROLE_IDS = oldObs;
    }
  } finally {
    teardownBotToken();
  }
});

test("infra routes accept authorized actor tier", async () => {
  setupBotToken();
  try {

    const req = { method: "GET", headers: authHeaders() };
    const res = { statusCode: 0, body: null };
    const json = (r, code, body) => { res.statusCode = code; res.body = body; };

    await handleDiscordAdapterRoute({
      req, res, path: DISCORD_ADAPTER_ROUTES.VERSION,
      config: { repoRoot: "/tmp", version: "test-version" },
      readJson: async () => ({}),
      json
    });
    assert.equal(res.statusCode, 200, `expected 200 for version, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body?.version, "test-version", `expected version=test-version, got ${JSON.stringify(res.body)}`);
  } finally {
    teardownBotToken();
  }
});

test("VERSION route uses config.version not hardcoded path", () => {
  assert.ok(DISCORD_ADAPTER_ROUTES.VERSION, "VERSION route exists");
  assert.equal(DISCORD_ADAPTER_ROUTES.VERSION, "/api/integrations/discord/version");
});
