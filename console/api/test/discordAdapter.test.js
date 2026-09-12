import assert from "node:assert/strict";
import test from "node:test";
import { DISCORD_ADAPTER_ROUTES, DISCORD_CATALOG_PROTOCOL_VERSION, discordAdapterErrorResponse, discordAdapterHealth, discordAdapterPopulation, discordAdapterReadiness, discordAdapterServices, discordAdapterStatus, discordRoleMappingFromEnv, discordWritesEnabled } from "../src/integrations/discord/adapter.js";

const OLD_ENV = { ...process.env };

function resetEnv() {
  delete process.env.DISCORD_OBSERVER_ROLE_IDS;
  process.env.DISCORD_PLAYER_ROLE_IDS = "role-player";
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

test("reports adapter health with isolated link-state writes", async () => {
  const result = await discordAdapterHealth({});
  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(result.experimental, true);
  assert.equal(result.readOnly, false);
  assert.equal(result.gameDataWritesEnabled, false);
  assert.deepEqual(result.adapterDataWrites, ["player-link"]);
  assert.equal(result.writesEnabled, false);
  // RFC §3.4: /health must report the catalog protocol version so the
  // bot can detect a contract-breaking change without needing to fetch
  // the full catalog first.
  assert.equal(typeof result.protocolVersion, "number");
  assert.equal(result.protocolVersion, DISCORD_CATALOG_PROTOCOL_VERSION);
  // Issue #245 fix: LOGS, MAP_STATE, and MAINTENANCE were promoted from
  // planned -> live (see adapter.js's DISCORD_LIVE_ADAPTER_ROUTES,
  // "fix(adapter): implement LOGS, MAP_STATE, MAINTENANCE handlers" --
  // 8 bot slash commands were 404ing before this), but this hardcoded
  // exact-match expected array was never updated to include them, so
  // assert.deepEqual failed on the 3 missing entries even though the
  // real, current behavior is correct and intentional.
  assert.deepEqual([...result.liveRoutes].sort(), [
    "/api/integrations/discord/announcements",
    "/api/integrations/discord/broadcast",
    "/api/integrations/discord/db",
    "/api/integrations/discord/guilds/find",
    "/api/integrations/discord/guilds/storage",
    "/api/integrations/discord/health",
    "/api/integrations/discord/logs",
    "/api/integrations/discord/map-state",
    "/api/integrations/discord/maintenance",
    "/api/integrations/discord/backups/list",
    "/api/integrations/discord/ops/activity",
    "/api/integrations/discord/ops/combat",
    "/api/integrations/discord/ops/economy",
    "/api/integrations/discord/ops/inventory",
    "/api/integrations/discord/ops/prometheus",
    "/api/integrations/discord/ops/resources",
    "/api/integrations/discord/ops/soc",
    "/api/integrations/discord/players/find",
    "/api/integrations/discord/players/inventory",
    "/api/integrations/discord/players/inventory-search",
    "/api/integrations/discord/players/link",
    "/api/integrations/discord/players/link/verify",
    "/api/integrations/discord/players/me",
    "/api/integrations/discord/players/storage",
    "/api/integrations/discord/players/unlink",
    "/api/integrations/discord/population",
    "/api/integrations/discord/ports",
    "/api/integrations/discord/readiness",
    "/api/integrations/discord/servers",
    "/api/integrations/discord/services",
    "/api/integrations/discord/status",
    "/api/integrations/discord/version"
  ].sort());
  assert.ok(!result.plannedRoutes.includes("/api/integrations/discord/logs"));
  assert.ok(!result.plannedRoutes.includes("/api/integrations/discord/ops/activity"));
  assert.ok(result.plannedRoutes.includes("/api/integrations/discord/ops/location"));
});

// Audit finding #3 (HIGH): an operator who explicitly clears
// DISCORD_PLAYER_ROLE_IDS (writes "") via the new Settings UI must see
// access actually revoked -- not silently fall back to a stale, non-empty
// legacy DISCORD_OBSERVER_ROLE_IDS just because "" is falsy under `||`.
test("discordRoleMappingFromEnv does NOT fall back to the legacy var when DISCORD_PLAYER_ROLE_IDS is explicitly set to empty -- clearing role IDs must actually revoke access", () => {
  process.env.DISCORD_PLAYER_ROLE_IDS = "";
  process.env.DISCORD_OBSERVER_ROLE_IDS = "111111111111111111";
  const mapping = discordRoleMappingFromEnv();
  assert.deepEqual(mapping.playerRoleIds, [], "an explicitly-cleared DISCORD_PLAYER_ROLE_IDS must not fall back to the legacy var");
  delete process.env.DISCORD_PLAYER_ROLE_IDS;
  delete process.env.DISCORD_OBSERVER_ROLE_IDS;
});

// DISCORD_OBSERVER_ROLE_IDS -> DISCORD_PLAYER_ROLE_IDS rename: the new name
// takes precedence, but the old name still works standalone so an operator
// who already set it doesn't silently lose their role mapping on update.
//
// The dual-emit test that used to live here (discordRolePolicyHealth
// emitting both observerConfigured and playerConfigured) was dropped along
// with the observerConfigured field itself -- superseded by tier1-upstream's
// own full observer->player rename (2026-09-11), which updated
// docs/integrations/discord-control-bot/admin-guide.md's documented
// "Expected role policy shape" example to playerConfigured too, so no
// documented external consumer still expects the old field name.
test("discordRoleMappingFromEnv prefers DISCORD_PLAYER_ROLE_IDS but still reads the legacy DISCORD_OBSERVER_ROLE_IDS as a fallback", () => {
  assert.deepEqual(discordRoleMappingFromEnv({ DISCORD_PLAYER_ROLE_IDS: "role-a,role-b" }).playerRoleIds, ["role-a", "role-b"]);
  assert.deepEqual(discordRoleMappingFromEnv({ DISCORD_OBSERVER_ROLE_IDS: "role-legacy" }).playerRoleIds, ["role-legacy"]);
  assert.deepEqual(
    discordRoleMappingFromEnv({ DISCORD_PLAYER_ROLE_IDS: "role-new", DISCORD_OBSERVER_ROLE_IDS: "role-legacy" }).playerRoleIds,
    ["role-new"],
    "the new env var must take precedence when both are set"
  );
  assert.deepEqual(discordRoleMappingFromEnv({}).playerRoleIds, []);
});

test("keeps writes disabled by default and accepts explicit opt-in values", () => {
  delete process.env.DUNE_DISCORD_WRITES_ENABLED;
  assert.equal(discordWritesEnabled({}), false);
  process.env.DUNE_DISCORD_WRITES_ENABLED = "1";
  assert.equal(discordWritesEnabled({}), true);
  process.env.DUNE_DISCORD_WRITES_ENABLED = "true";
  assert.equal(discordWritesEnabled({}), true);
});

test("exposes only allowlisted adapter route names", () => {
  const routes = Object.values(DISCORD_ADAPTER_ROUTES);
  assert.deepEqual(routes.sort(), [
    "/api/integrations/discord/announcements",
    "/api/integrations/discord/backups/list",
    "/api/integrations/discord/broadcast",
    // catalog (Phase 1 of docs/rfc-command-discovery.md): read-only
    // metadata describing the other routes' shape/capability/tier, not
    // itself a data route -- deliberately excluded from
    // DISCORD_LIVE_ADAPTER_ROUTES (see adapter.js's own comment) but still
    // a real, allowlisted route constant here.
    "/api/integrations/discord/catalog",
    "/api/integrations/discord/db",
    "/api/integrations/discord/guilds/find",
    "/api/integrations/discord/guilds/storage",
    "/api/integrations/discord/health",
    "/api/integrations/discord/logs",
    "/api/integrations/discord/map-state",
    "/api/integrations/discord/maintenance",
    "/api/integrations/discord/ops/activity",
    "/api/integrations/discord/ops/combat",
    "/api/integrations/discord/ops/dashboard",
    "/api/integrations/discord/ops/economy",
    "/api/integrations/discord/ops/inventory",
    "/api/integrations/discord/ops/location",
    "/api/integrations/discord/ops/prometheus",
    "/api/integrations/discord/ops/resources",
    "/api/integrations/discord/ops/soc",
    "/api/integrations/discord/players/find",
    "/api/integrations/discord/players/inventory",
    "/api/integrations/discord/players/inventory-search",
    "/api/integrations/discord/players/link",
    "/api/integrations/discord/players/link/verify",
    "/api/integrations/discord/players/me",
    "/api/integrations/discord/players/storage",
    "/api/integrations/discord/players/unlink",
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

test("allows player readiness and services", async () => {
  const readiness = await discordAdapterReadiness({
    config,
    actorPayload: actor(["role-player"]),
    readinessProvider: async () => ({ ready: true, overall: "READY", issues: [] })
  });
  assert.equal(readiness.ok, true);
  assert.equal(readiness.result.ready, true);

  const services = await discordAdapterServices({
    config,
    actorPayload: actor(["role-player"]),
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
import { writeFileSync, unlinkSync } from "node:fs";
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
  const commandCalls = [];
  const mockCommandRunner = async (_config, args) => {
    commandCalls.push(args);
    if (args.join(" ") === "db list") {
      return { code: 0, stdout: "2026-08-09 12:34 dune-db-test-20260809-123400.backup\n", stderr: "" };
    }
    if (args.join(" ") === "maps list") {
      return { code: 0, stdout: "Hagga Basin  running\nDeep Desert  running\n", stderr: "" };
    }
    if (args.join(" ") === "ready") {
      return { code: 0, stdout: "Overall: READY\n", stderr: "" };
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };
  const mockDockerLogs = async (service, options) => ({
    code: 0,
    stdout: `${service} ready on 127.0.0.1:7778\n`,
    stderr: "",
    options
  });
  const mockAnnouncements = async () => ({
    settings: { joinEnabled: true, joinMessage: "Welcome {playerName}", leaveEnabled: false, leaveMessage: "Goodbye {playerName}" }
  });

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
          populationProvider: mockPopulation,
          commandRunner: mockCommandRunner,
          dockerLogsRunner: mockDockerLogs,
          announcementsProvider: mockAnnouncements
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
          const status = await (await fetch(`${base}/api/integrations/discord/status`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-player"]) }) })).json();
          assert.equal(status.ok, true);

          // Readiness
          const readiness = await (await fetch(`${base}/api/integrations/discord/readiness`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-player"]) }) })).json();
          assert.equal(readiness.ok, true);

          // Services
          const services = await (await fetch(`${base}/api/integrations/discord/services`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-player"]) }) })).json();
          assert.equal(services.ok, true);
          assert.ok(Array.isArray(services.result.services));

          // Population
          const pop = await (await fetch(`${base}/api/integrations/discord/population`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-moderator"]) }) })).json();
          assert.equal(pop.ok, true);

          const maintenance = await (await fetch(`${base}/api/integrations/discord/maintenance`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-player"]) }) })).json();
          assert.equal(maintenance.ok, true);
          assert.match(maintenance.output, /READY/);

          const logs = await (await fetch(`${base}/api/integrations/discord/logs`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-admin"]), service: "survival" }) })).json();
          assert.equal(logs.ok, true);
          assert.equal(logs.service, "survival");
          assert.equal(logs.lines.length, 1);
          assert.doesNotMatch(logs.lines[0], /127\.0\.0\.1/);

          const blockedLogs = await fetch(`${base}/api/integrations/discord/logs`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-moderator"]), service: "survival" }) });
          assert.equal(blockedLogs.status, 403);

          const mapState = await (await fetch(`${base}/api/integrations/discord/map-state`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-moderator"]) }) })).json();
          assert.equal(mapState.ok, true);
          assert.deepEqual(mapState.maps, ["Hagga Basin  running", "Deep Desert  running"]);

          const backups = await (await fetch(`${base}/api/integrations/discord/backups/list`, { headers: auth })).json();
          assert.equal(backups.ok, true);
          assert.equal(backups.backups[0].name, "dune-db-test-20260809-123400.backup");

          const announcements = await (await fetch(`${base}/api/integrations/discord/announcements`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ actor: actor(["role-moderator"]) }) })).json();
          assert.equal(announcements.ok, true);
          assert.equal(announcements.announcements.settings.joinEnabled, true);

          assert.deepEqual(commandCalls, [["ready"], ["maps", "list"], ["db", "list"]]);

          // Existing version route remains live after adding player routes
          const version = await (await fetch(`${base}/api/integrations/discord/version`, { headers: auth })).json();
          assert.equal(version.ok, true);
          assert.equal(version.version, "dev");

          // Command catalog (Phase 1 of docs/rfc-command-discovery.md) --
          // bearer-token auth only, matching health.
          const catalog = await (await fetch(`${base}/api/integrations/discord/catalog`, { headers: auth })).json();
          assert.equal(catalog.ok, true);
          assert.equal(typeof catalog.protocolVersion, "number");
          assert.ok(Array.isArray(catalog.catalog.groups));
          assert.ok(catalog.catalog.groups.length > 0);
          assert.equal((await fetch(`${base}/api/integrations/discord/catalog`)).status, 401);

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
