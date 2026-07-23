import assert from "node:assert/strict";
import test from "node:test";
import { DISCORD_ADAPTER_ROUTES, discordAdapterErrorResponse, discordAdapterHealth, discordAdapterPopulation, discordAdapterReadiness, discordAdapterServices, discordAdapterStatus, discordWritesEnabled } from "../src/integrations/discord/adapter.js";

const OLD_ENV = { ...process.env };

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

test("reports adapter health with isolated link-state writes", async () => {
  const result = await discordAdapterHealth({});
  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(result.experimental, true);
  assert.equal(result.readOnly, false);
  assert.equal(result.gameDataWritesEnabled, false);
  assert.deepEqual(result.adapterDataWrites, ["player-link", "account-link"]);
  assert.equal(result.writesEnabled, false);
  assert.deepEqual([...result.liveRoutes].sort(), [
    "/api/integrations/discord/announcements",
    "/api/integrations/discord/broadcast",
    "/api/integrations/discord/db",
    "/api/integrations/discord/guilds/find",
    "/api/integrations/discord/guilds/storage",
    "/api/integrations/discord/health",
    "/api/integrations/discord/players/accounts/link",
    "/api/integrations/discord/players/accounts/link/verify",
    "/api/integrations/discord/players/accounts/list",
    "/api/integrations/discord/players/accounts/set-default",
    "/api/integrations/discord/players/accounts/unlink",
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
  assert.ok(result.plannedRoutes.includes("/api/integrations/discord/logs"));
  assert.ok(result.plannedRoutes.includes("/api/integrations/discord/ops/activity"));
});

test("forces writes disabled even if environment attempts to enable them", () => {
  process.env.DUNE_DISCORD_WRITES_ENABLED = "true";
  assert.equal(discordWritesEnabled({ discordWritesEnabled: true }), false);
});

test("exposes only allowlisted adapter route names", () => {
  const routes = Object.values(DISCORD_ADAPTER_ROUTES);
  assert.deepEqual(routes.sort(), [
    "/api/integrations/discord/announcements",
    "/api/integrations/discord/backups/list",
    "/api/integrations/discord/broadcast",
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
    "/api/integrations/discord/players/accounts/link",
    "/api/integrations/discord/players/accounts/link/verify",
    "/api/integrations/discord/players/accounts/list",
    "/api/integrations/discord/players/accounts/set-default",
    "/api/integrations/discord/players/accounts/unlink",
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

          // Existing version route remains live after adding player routes
          const version = await (await fetch(`${base}/api/integrations/discord/version`, { headers: auth })).json();
          assert.equal(version.ok, true);
          assert.equal(version.version, "dev");

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

// Actor signature enforcement — FINDING-LINK-1
// (docs/security/discord-player-link-hardening.md): when
// DUNE_DISCORD_ACTOR_SECRET is configured, the bearer token alone is no
// longer sufficient to make requests on behalf of an arbitrary actor.
test("adapter route rejects an unsigned or spoofed actor when DUNE_DISCORD_ACTOR_SECRET is configured", async () => {
  const tokenFile = "/tmp/discord-adapter-actor-sig-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  const OLD_SECRET = process.env.DUNE_DISCORD_ACTOR_SECRET;
  process.env.DUNE_DISCORD_ACTOR_SECRET = "integration-test-actor-secret";
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-actor-sig-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-actor-sig-test-generated" };
  const mockStatus = async () => ({ ok: true, summary: { overall: "OK", region: "us", mode: "pve", population: "8/128" } });

  const { signActorPayload, ACTOR_SIGNATURE_HEADER, ACTOR_TIMESTAMP_HEADER } = await import("../src/integrations/discord/actorSignature.js");

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
        await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json, statusProvider: mockStatus });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;
          const observerActor = actor(["role-observer"]);

          // Valid bearer token but no actor signature at all: rejected even
          // though this exact request would have succeeded before
          // DUNE_DISCORD_ACTOR_SECRET was configured.
          const unsigned = await fetch(`${base}/api/integrations/discord/status`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: observerActor })
          });
          assert.equal(unsigned.status, 403);
          const unsignedBody = await unsigned.json();
          assert.equal(unsignedBody.code, "missing_actor_signature");

          // Correctly signed actor: accepted.
          const timestamp = Math.floor(Date.now() / 1000);
          const { signature } = signActorPayload(observerActor, "integration-test-actor-secret", timestamp, "/api/integrations/discord/status");
          const validSigned = await fetch(`${base}/api/integrations/discord/status`, {
            method: "POST",
            headers: {
              ...auth,
              "content-type": "application/json",
              [ACTOR_SIGNATURE_HEADER]: signature,
              [ACTOR_TIMESTAMP_HEADER]: String(timestamp)
            },
            body: JSON.stringify({ actor: observerActor })
          });
          assert.equal(validSigned.status, 200);
          const validBody = await validSigned.json();
          assert.equal(validBody.ok, true);

          // Signature was computed for a different actor (observer); an
          // attacker with the bearer token tries to reuse that signature
          // while claiming an owner role to escalate privilege. Must be
          // rejected — this is exactly the confused-deputy scenario
          // FINDING-LINK-1 describes.
          const spoofedActor = { ...observerActor, roleIds: ["role-owner"] };
          const spoofed = await fetch(`${base}/api/integrations/discord/status`, {
            method: "POST",
            headers: {
              ...auth,
              "content-type": "application/json",
              [ACTOR_SIGNATURE_HEADER]: signature,
              [ACTOR_TIMESTAMP_HEADER]: String(timestamp)
            },
            body: JSON.stringify({ actor: spoofedActor })
          });
          assert.equal(spoofed.status, 403);
          const spoofedBody = await spoofed.json();
          assert.equal(spoofedBody.code, "invalid_actor_signature");

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
    if (OLD_SECRET === undefined) delete process.env.DUNE_DISCORD_ACTOR_SECRET;
    else process.env.DUNE_DISCORD_ACTOR_SECRET = OLD_SECRET;
  }
});

// Cross-route replay rejection — FINDING-LINK-1 hardening. A signature that
// covered only actor identity fields (not the route) could be captured from
// one legitimate request (e.g. a routine "status" call, which requires no
// special privilege to observe) and replayed verbatim against a completely
// different, more sensitive route within the freshness window. Proves the
// route-bound signature closes that gap: the same actor + signature +
// timestamp that is valid for /status must be rejected for /readiness.
test("a signature valid for one route is rejected when replayed against a different route", async () => {
  const { signActorPayload, ACTOR_SIGNATURE_HEADER, ACTOR_TIMESTAMP_HEADER } = await import("../src/integrations/discord/actorSignature.js");
  const tokenFile = "/tmp/discord-adapter-cross-route-replay-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  const OLD_SECRET = process.env.DUNE_DISCORD_ACTOR_SECRET;
  process.env.DUNE_DISCORD_ACTOR_SECRET = "cross-route-test-secret";
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-cross-route-replay-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-cross-route-replay-test-generated" };
  const mockStatus = async () => ({ ok: true, summary: { overall: "OK", region: "us", mode: "pve", population: "8/128" } });
  const mockReadiness = async () => ({ ready: true, overall: "READY", issues: [] });

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
        await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json, statusProvider: mockStatus, readinessProvider: mockReadiness });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;
          const observerActor = actor(["role-observer"]);
          const timestamp = Math.floor(Date.now() / 1000);
          const { signature } = signActorPayload(observerActor, "cross-route-test-secret", timestamp, "/api/integrations/discord/status");
          const headers = {
            ...auth,
            "content-type": "application/json",
            [ACTOR_SIGNATURE_HEADER]: signature,
            [ACTOR_TIMESTAMP_HEADER]: String(timestamp)
          };

          // The signature is valid for /status...
          const statusResponse = await fetch(`${base}/api/integrations/discord/status`, {
            method: "POST",
            headers,
            body: JSON.stringify({ actor: observerActor })
          });
          assert.equal(statusResponse.status, 200);

          // ...but must be rejected when replayed against /readiness, even
          // though the actor, timestamp, and signature bytes are identical
          // and still within the freshness window.
          const readinessResponse = await fetch(`${base}/api/integrations/discord/readiness`, {
            method: "POST",
            headers,
            body: JSON.stringify({ actor: observerActor })
          });
          assert.equal(readinessResponse.status, 403);
          const readinessBody = await readinessResponse.json();
          assert.equal(readinessBody.code, "invalid_actor_signature");

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
    if (OLD_SECRET === undefined) delete process.env.DUNE_DISCORD_ACTOR_SECRET;
    else process.env.DUNE_DISCORD_ACTOR_SECRET = OLD_SECRET;
  }
});

// Self-scoped capability enforcement — FINDING-LINK-2
// (docs/security/discord-player-link-hardening.md): player-link:write is
// no longer tier-gated at all; it authorizes any recognized Discord
// principal to act on their own identity, and rejects an actor with no
// configured role (public tier) regardless of what they claim as userId.
test("player-link route rejects a public-tier actor and allows an observer-tier actor", async () => {
  const tokenFile = "/tmp/discord-adapter-self-scoped-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-self-scoped-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-self-scoped-test-generated" };

  // Minimal permissive db stub: satisfies migrateDiscordAdapterSchema()'s
  // DDL calls and resolvePlayerByName()'s lookup query. Returns no rows for
  // the player lookup so linkPlayerProvider() itself returns a normal "no
  // player found" business result for the observer-tier case — the point
  // of this test is proving the actor never reaches that far when
  // unauthorized, not exercising the full link/whisper flow.
  const db = {
    transaction: (fn) => fn(db),
    async query() {
      return { rows: [], rowCount: 0 };
    }
  };

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
        await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json, db });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;

          // Public tier (no configured role at all) must be rejected, even
          // with a valid bearer token, even though PLAYER_LINK_WRITE is a
          // self-scoped capability meant to be broadly available.
          const publicActor = { guildId: "guild-1", channelId: "channel-1", userId: "public-user", username: "no-role", roleIds: [] };
          const publicResponse = await fetch(`${base}/api/integrations/discord/players/link`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: publicActor, characterName: "Chani" })
          });
          assert.equal(publicResponse.status, 403);
          const publicBody = await publicResponse.json();
          assert.equal(publicBody.code, "not_authorized");

          // Observer tier (any recognized principal) is authorized for
          // this self-scoped action — the request proceeds into
          // linkPlayerProvider() and returns a normal business result
          // (no player found, since the db stub returns no rows) rather
          // than a 403.
          const observerActor = actor(["role-observer"]);
          const observerResponse = await fetch(`${base}/api/integrations/discord/players/link`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: observerActor, characterName: "Chani" })
          });
          assert.equal(observerResponse.status, 200);
          const observerBody = await observerResponse.json();
          assert.equal(observerBody.ok, false);
          assert.match(observerBody.error, /No player found/i);

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
  }
});

// Verification rate limiting — FINDING-LINK-3
// (docs/security/discord-player-link-hardening.md): repeated wrong-code
// guesses against /players/link/verify for one discordUserId must
// eventually be rejected with 429, not left unthrottled.
test("player-link verify route rate limits repeated wrong-code attempts for one discordUserId", async () => {
  const { resetVerifyRateLimiterForTests } = await import("../src/integrations/discord/linkProvider.js");
  const { createLoginRateLimiter } = await import("../src/rateLimit.js");
  resetVerifyRateLimiterForTests(createLoginRateLimiter({ maxAttempts: 2, globalMaxAttempts: 99, windowMs: 60000, blockMs: 60000 }));

  const tokenFile = "/tmp/discord-adapter-verify-rate-limit-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-verify-rate-limit-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-verify-rate-limit-test-generated" };
  const db = {
    transaction: (fn) => fn(db),
    async query() {
      return { rows: [], rowCount: 0 };
    }
  };

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
        await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json, db });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;
          const observerActor = actor(["role-observer"]);
          const verifyOnce = () => fetch(`${base}/api/integrations/discord/players/link/verify`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: observerActor, code: "ACP-WRONG" })
          });

          const first = await verifyOnce();
          assert.equal(first.status, 200);
          const firstBody = await first.json();
          assert.equal(firstBody.ok, false);

          const second = await verifyOnce();
          assert.equal(second.status, 200);

          const third = await verifyOnce();
          assert.equal(third.status, 429);
          const thirdBody = await third.json();
          assert.equal(thirdBody.code, "verify_rate_limited");

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
  }
});

// Multi-account routes — FINDING-LINK-6
// (docs/security/discord-player-link-hardening.md): additive to the
// single-link routes above, gated by its own self-scoped capability
// (ACCOUNT_LINK_WRITE), not by reusing PLAYER_LINK_WRITE.
test("account-link routes reject a public-tier actor and allow an observer-tier actor to link and list accounts", async () => {
  const tokenFile = "/tmp/discord-adapter-multi-account-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-multi-account-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-multi-account-test-generated" };

  const player = { player_controller_id: "42", player_pawn_id: "84", character_name: "Chani", online_status: "Online", funcom_id: "Chani#1234" };
  const accounts = [];
  const db = {
    transaction: (fn) => fn(db),
    async query(text, values = []) {
      if (text.includes("from dune.player_state ps") && text.includes("lower(ps.character_name)")) {
        return { rows: [player], rowCount: 1 };
      }
      if (text.includes("from dune.discord_account_links dal")) {
        const rows = accounts.filter((a) => a.discordUserId === values[0]).map((a) => ({
          discord_user_id: a.discordUserId,
          player_controller_id: a.playerControllerId,
          is_default: a.isDefault,
          character_name: player.character_name,
          player_pawn_id: player.player_pawn_id,
          online_status: player.online_status
        }));
        return { rows, rowCount: rows.length };
      }
      if (text.includes("for update")) return { rows: [], rowCount: 0 };
      if (text.includes("select 1 from dune.discord_account_links")) return { rows: [], rowCount: 0 };
      if (text.includes("insert into dune.discord_account_links")) {
        accounts.push({ discordUserId: values[0], playerControllerId: values[1], isDefault: Boolean(values[2]) });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };

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
        await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json, db });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;

          // Public tier is rejected for the account-link route, same as the
          // single-link route — ACCOUNT_LINK_WRITE is self-scoped but still
          // requires a recognized principal (observer tier or above).
          const publicActor = { guildId: "guild-1", channelId: "channel-1", userId: "public-user", username: "no-role", roleIds: [] };
          const publicResponse = await fetch(`${base}/api/integrations/discord/players/accounts/link`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: publicActor, characterName: "Chani" })
          });
          assert.equal(publicResponse.status, 403);
          const publicBody = await publicResponse.json();
          assert.equal(publicBody.code, "not_authorized");

          // Observer tier is authorized: the list route reaches
          // listAccountsProvider without a 403 and returns a normal empty
          // result for a user with no linked accounts yet.
          const observerActor = actor(["role-observer"]);
          const listResponse = await fetch(`${base}/api/integrations/discord/players/accounts/list`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: observerActor })
          });
          assert.equal(listResponse.status, 200);
          const listBody = await listResponse.json();
          assert.equal(listBody.ok, true);
          assert.deepEqual(listBody.accounts, []);

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
  }
});

// Rate limiting for the multi-account verify route — mirrors the
// single-link route's rate-limit test, but proves it uses a SEPARATE
// limiter instance so exhausting one flow's allowance never affects the
// other (FINDING-LINK-6's "Minimal Impact" design decision).
test("account-link verify route rate limits independently from the single-link verify route", async () => {
  const { resetVerifyRateLimiterForTests } = await import("../src/integrations/discord/linkProvider.js");
  const { resetAccountLinkVerifyRateLimiterForTests } = await import("../src/integrations/discord/multiAccountLinkProvider.js");
  const { createLoginRateLimiter } = await import("../src/rateLimit.js");
  resetVerifyRateLimiterForTests(createLoginRateLimiter({ maxAttempts: 99, globalMaxAttempts: 999, windowMs: 60000, blockMs: 60000 }));
  resetAccountLinkVerifyRateLimiterForTests(createLoginRateLimiter({ maxAttempts: 2, globalMaxAttempts: 99, windowMs: 60000, blockMs: 60000 }));

  const tokenFile = "/tmp/discord-adapter-multi-account-rate-limit-test-token.txt";
  writeFileSync(tokenFile, "server-test-token");
  const testConfig = { discordBotApiTokenFile: tokenFile, discordAdapterEnabled: true, auditLog: "/tmp/discord-adapter-multi-account-rate-limit-test-audit.jsonl", generatedDir: "/tmp/discord-adapter-multi-account-rate-limit-test-generated" };
  const db = {
    transaction: (fn) => fn(db),
    async query() {
      return { rows: [], rowCount: 0 };
    }
  };

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
        await handleDiscordAdapterRoute({ req, res, path, config: testConfig, readJson, json, db });
      });
      const auth = { authorization: "Bearer server-test-token" };

      server.listen(async () => {
        try {
          const base = `http://127.0.0.1:${server.address().port}`;
          const observerActor = actor(["role-observer"]);

          const verifyAccountOnce = () => fetch(`${base}/api/integrations/discord/players/accounts/link/verify`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: observerActor, code: "ACP-WRONG" })
          });
          const verifySingleOnce = () => fetch(`${base}/api/integrations/discord/players/link/verify`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json" },
            body: JSON.stringify({ actor: observerActor, code: "ACP-WRONG" })
          });

          assert.equal((await verifyAccountOnce()).status, 200);
          assert.equal((await verifyAccountOnce()).status, 200);
          const thirdAccount = await verifyAccountOnce();
          assert.equal(thirdAccount.status, 429);
          const thirdAccountBody = await thirdAccount.json();
          assert.equal(thirdAccountBody.code, "verify_rate_limited");

          // The single-link verify route (separate limiter, and configured
          // with a much higher allowance above) is unaffected by the
          // account-link route's lockout for the same discordUserId.
          const singleAfterAccountLockout = await verifySingleOnce();
          assert.equal(singleAfterAccountLockout.status, 200);

          server.close();
          resolve();
        } catch (e) { server.close(); reject(e); }
      });
    });
  } finally {
    try { unlinkSync(tokenFile); } catch {}
  }
});
