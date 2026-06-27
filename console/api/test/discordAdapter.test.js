import test from "node:test";
import assert from "node:assert/strict";
import {
  DISCORD_ADAPTER_ROUTES,
  discordActorTier,
  discordHealthPayload,
  handleDiscordAdapterRoute,
  isDiscordAdapterRoute,
  publicStatusSummary,
  requireDiscordCapability
} from "../src/services/discordAdapter.js";

const ENV_KEYS = [
  "DUNE_DISCORD_ADAPTER_ENABLED",
  "DUNE_DISCORD_ADAPTER_TOKEN",
  "DUNE_DISCORD_ADAPTER_TOKEN_FILE",
  "DUNE_BOT_API_TOKEN_FILE",
  "DISCORD_OBSERVER_ROLE_IDS",
  "DISCORD_ADMIN_ROLE_IDS",
  "DISCORD_OWNER_ROLE_IDS"
];

function withEnv(values, fn) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of ENV_KEYS) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    });
}

function request({ method = "GET", token = "", body = {} } = {}) {
  return {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body
  };
}

async function callRoute(path, req) {
  let response = null;
  await handleDiscordAdapterRoute({
    req,
    res: {},
    path,
    config: { mockMode: true },
    readJson: async () => req.body || {},
    json: (_res, statusCode, payload) => {
      response = { statusCode, payload };
      return response;
    }
  });
  return response;
}

test("discord adapter route matcher only accepts supported read-only routes", () => {
  assert.equal(isDiscordAdapterRoute(DISCORD_ADAPTER_ROUTES.HEALTH), true);
  assert.equal(isDiscordAdapterRoute("/api/integrations/discord/backups/delete"), false);
});

test("discord adapter is disabled by default", async () => {
  await withEnv({}, async () => {
    const response = await callRoute(DISCORD_ADAPTER_ROUTES.HEALTH, request());
    assert.equal(response.statusCode, 404);
    assert.equal(response.payload.ok, false);
  });
});

test("discord adapter requires bearer token when enabled", async () => {
  await withEnv({ DUNE_DISCORD_ADAPTER_ENABLED: "true", DUNE_DISCORD_ADAPTER_TOKEN: "secret-token" }, async () => {
    const missing = await callRoute(DISCORD_ADAPTER_ROUTES.HEALTH, request());
    assert.equal(missing.statusCode, 401);

    const invalid = await callRoute(DISCORD_ADAPTER_ROUTES.HEALTH, request({ token: "wrong-token" }));
    assert.equal(invalid.statusCode, 401);

    const ok = await callRoute(DISCORD_ADAPTER_ROUTES.HEALTH, request({ token: "secret-token" }));
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.payload.readOnly, true);
    assert.equal(ok.payload.writesEnabled, false);
  });
});

test("discord adapter returns mock read-only status when authorized", async () => {
  await withEnv({ DUNE_DISCORD_ADAPTER_ENABLED: "true", DUNE_DISCORD_ADAPTER_TOKEN: "secret-token" }, async () => {
    const response = await callRoute(DISCORD_ADAPTER_ROUTES.STATUS, request({ method: "POST", token: "secret-token" }));
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.ok, true);
    assert.equal(response.payload.operation, "status");
    assert.equal(response.payload.result.summary.overall, "Mock");
  });
});

test("public status summary omits server ip while keeping useful public fields", () => {
  const summary = publicStatusSummary(`
Overall: READY
Title: My Dune Server
Region: Europe
Mode: public
Server IP: 203.0.113.42
Battlegroup: sh-example
Population: 2/60
Autoscaler: RUNNING
Auto updates: DISABLED
`);
  assert.equal(summary.overall, "READY");
  assert.equal(summary.title, "My Dune Server");
  assert.equal(summary.population, "2/60");
  assert.equal(summary.battlegroup, "sh-example");
  assert.equal(Object.hasOwn(summary, "server_ip"), false);
});

test("role mapping is optional but enforced when configured", async () => {
  await withEnv({ DISCORD_OBSERVER_ROLE_IDS: "observer", DISCORD_ADMIN_ROLE_IDS: "admin" }, async () => {
    assert.equal(discordActorTier({ roleIds: ["observer"] }), "observer");
    assert.equal(discordActorTier({ roleIds: ["admin"] }), "admin");
    assert.doesNotThrow(() => requireDiscordCapability({ roleIds: ["observer"] }, "observer"));
    assert.throws(() => requireDiscordCapability({ roleIds: ["observer"] }, "admin"), /not authorized/i);
  });
});

test("health payload advertises only the supported read-only routes", () => {
  const payload = discordHealthPayload({ discordAdapterEnabled: true });
  assert.deepEqual(payload.routes.sort(), Object.values(DISCORD_ADAPTER_ROUTES).sort());
  assert.equal(payload.readOnly, true);
  assert.equal(payload.writesEnabled, false);
});
