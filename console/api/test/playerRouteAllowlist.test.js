import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ROUTE_ACTIONS, actionForRoute } from "../src/actions.js";
import { evaluate } from "../src/policy.js";
import { playerMayCall } from "../src/playerScope.js";

// Operator contract (#1276): a `player` session sees only its own character,
// the bases/vehicles/storage it owns, and its guild including the roster. It
// never sees another player's information. The allowlist is a second gate on
// top of the IAM policy so that a stored policy file cannot widen it.

const LEAKS = [
  "/api/map/players",
  "/api/map/poi",
  "/api/map/spice",
  "/api/map/partitions",
  "/api/map/capabilities",
  "/api/players/deleted-characters",
  "/api/map/bases",
  "/api/map/storage",
  "/api/map/markers",
  "/api/map/overlays",
  "/api/map/services",
  "/api/maps/user-settings/raw",
  "/api/maps/user-settings/values",
  "/api/maps/userengine",
  "/api/maps/usergame",
  "/api/maps/choam-terminals/capture",
  "/api/server/doctor",
  "/api/server/ports",
  "/api/server/services",
  "/api/server/funcom-token/check",
  "/api/maps/memory",
  "/api/maps/autoscaler",
  "/api/server/readiness",
  "/api/map/status",
  "/api/players/abc123/teleport-destinations",
  "/api/players/abc123/ban",
  "/api/players/abc123/character-recovery",
  "/api/players/abc123/unknown-new-resource",
  "/api/players/abc123/inventory/extra",
];

for (const path of LEAKS) {
  test(`player may not GET ${path}`, () => {
    assert.equal(playerMayCall("GET", path), false);
  });
}

const OWN_DATA = [
  "/api/server/status",
  "/api/players",
  "/api/players/online",
  "/api/players/search",
  "/api/players/abc123",
  "/api/players/abc123/inventory",
  "/api/guilds",
  "/api/guilds/42/members",
];

for (const path of OWN_DATA) {
  test(`player may GET ${path} (handler scopes it)`, () => {
    assert.equal(playerMayCall("GET", path), true);
  });
}

test("player may never use a non-GET method on any route", () => {
  for (const key of Object.keys(ROUTE_ACTIONS)) {
    const [, path] = key.split(" ", 2);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(playerMayCall(method, path), false, `${method} ${path}`);
    }
  }
});

test("unknown and malformed paths are denied", () => {
  for (const path of ["", "/", "/api", "/api/unknown", "/api/map/", "api/players", "/API/players", "/api/players/", "/api/players//deleted-characters"]) {
    assert.equal(playerMayCall("GET", path), false, path);
  }
});

test("reserved player sub-paths are denied in every spelling", () => {
  for (const path of ["/api/players/deleted-characters", "/api/players/deleted-characters/", "/api/players/deleted-characters/x", "/api/players/list-settings", "/api/players/list-settings/"]) {
    assert.equal(playerMayCall("GET", path), false, path);
  }
});

test("the allowlist never grants a route the IAM policy denies the player tier", () => {
  // Independent of the allowlist: derive reachability from the real policy.
  for (const [key, action] of Object.entries(ROUTE_ACTIONS)) {
    const [method, path] = key.split(" ", 2);
    if (playerMayCall(method, path)) {
      assert.ok(evaluate({ tier: "player" }, action), `${key} -> ${action}`);
      assert.equal(actionForRoute(path, method), action);
    }
  }
});

test("every exact route a player can reach by policy is either allowed on purpose or denied on purpose", () => {
  const reachable = Object.entries(ROUTE_ACTIONS)
    .filter(([, action]) => evaluate({ tier: "player" }, action))
    .map(([key]) => key.split(" ", 2)[1]);
  const allowed = reachable.filter((path) => playerMayCall("GET", path));
  // Pinned so that widening the allowlist is a visible, reviewed change.
  assert.deepEqual(allowed.sort(), [
    "/api/bases",
    "/api/guilds",
    "/api/players",
    "/api/players/online",
    "/api/players/search",
    "/api/server/performance",
    "/api/server/restart-history",
    "/api/server/status",
    "/api/storage",
    "/api/vehicles",
  ]);
});

test("the request gate applies the allowlist after the IAM check", () => {
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const gate = src.indexOf("!action || !evaluate(session, action)");
  assert.ok(gate > 0, "IAM gate not found");
  const after = src.slice(gate, gate + 900);
  assert.match(after, /session\.tier === "player" && !playerMayCall\(req\.method, path\)/);
});

test("only the exact guild roster path is open, not other guild routes", () => {
  for (const path of ["/api/guilds/42", "/api/guilds/42/members/extra", "/api/guilds/a/b/members", "/api/guilds//members", "/api/guilds/42/members/", "/api/guilds/42/storage"]) {
    assert.equal(playerMayCall("GET", path), false, path);
  }
});

test("/api/auth/me reports no allowed actions for a session whose tier the policy engine rejects", async () => {
  const { resolveAllowedActions, resolveSessionTier } = await import("../src/policy.js");
  for (const session of [{}, { tier: "" }, { tier: "root" }, { tier: undefined }, null]) {
    assert.deepEqual(resolveAllowedActions(resolveSessionTier(session)), [], JSON.stringify(session));
  }
  assert.ok(resolveAllowedActions(resolveSessionTier({ tier: "owner" })).length > 0);
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(src, /resolveAllowedActions\(resolveSessionTier\(session\)\)/);
  assert.doesNotMatch(src, /resolveAllowedActions\(session\.tier \|\| "owner"\)/);
});

test("every own-data player sub-resource is admitted, and only those", () => {
  for (const r of ["crafting-recipes", "research-items", "building-unlocks", "customizations", "journey", "inventory", "vehicles", "bases", "currency", "solaris-coin", "factions", "intel", "specs", "position", "progression", "vitals", "events", "stats", "history"]) {
    assert.equal(playerMayCall("GET", `/api/players/42/${r}`), true, r);
  }
  for (const r of ["teleport-destinations", "ban", "character-recovery", "give-item", "x"]) assert.equal(playerMayCall("GET", `/api/players/42/${r}`), false, r);
});

test("the server status a player gets has no raw output, addresses, containers or ports", async () => {
  const { playerServerStatusView } = await import("../src/playerScope.js");
  const body = {
    stdout: "Server IP: 1.2.3.4", stderr: "", exitCode: 0, schemaVersion: 1, ok: true,
    data: {
      summary: { overall: "READY", title: "T", region: "R", mode: "M", serverIp: "1.2.3.4", battlegroup: "sh-secret", population: { current: 1, max: 180 } },
      containers: [{ name: "dune-postgres" }], listeners: [{ name: "pg", port: 5432 }],
      gameServers: [{ map: "Survival_1", status: "Ready", uptime: "1h", serverId: "srv-9", gamePort: 7777 }],
      rabbitmq: { details: "amqp://x" }, fls: { gatewayDbMonitoring: "x" }, database: { worldPartitions: 3 },
    },
  };
  const out = playerServerStatusView(body);
  const text = JSON.stringify(out);
  for (const leak of ["1.2.3.4", "sh-secret", "dune-postgres", "5432", "srv-9", "7777", "amqp", "stdout", "worldPartitions"]) assert.ok(!text.includes(leak), leak);
  assert.equal(out.ok, true);
  assert.equal(out.data.summary.overall, "READY");
  assert.deepEqual(out.data.gameServers, [{ map: "Survival_1", status: "Ready", uptime: "1h" }]);
  assert.deepEqual(playerServerStatusView(null).data.gameServers, []);
  const src = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(src, /json\(res, 200, statusBodyForSession\(session, body\)\)/);
  const { statusBodyForSession } = await import("../src/playerScope.js");
  assert.equal(statusBodyForSession({ tier: "admin" }, body), body, "operators keep the full status");
  assert.ok(!JSON.stringify(statusBodyForSession({ tier: "player" }, body)).includes("1.2.3.4"));
});

test("HEAD, OPTIONS and lower-case verbs are never admitted for the player tier", () => {
  for (const method of ["HEAD", "OPTIONS", "TRACE", "CONNECT", "", undefined, null]) assert.equal(playerMayCall(method, "/api/players"), false, String(method));
  assert.equal(playerMayCall("get", "/api/players"), true, "verbs are case-insensitive, as Node delivers them upper-case");
});

test("every reserved player path segment is denied on its own and with a sub-path", () => {
  for (const seg of ["deleted-characters", "list-settings", "kick-all-online"]) {
    assert.equal(playerMayCall("GET", `/api/players/${seg}`), false, seg);
    assert.equal(playerMayCall("GET", `/api/players/${seg}/inventory`), false, seg);
  }
  assert.equal(playerMayCall("GET", "/api/players/online/inventory"), false);
  assert.equal(playerMayCall("GET", "/api/players/42/inventory/"), false);
  assert.equal(playerMayCall("GET", "/api/players/%2e%2e/bases"), true, "percent-encoded id is just an id; the handler's own-id check refuses it");
});

test("the player tier holds exactly this action set, so a policy over-grant is a visible change", async () => {
  const { resolveAllowedActions } = await import("../src/policy.js");
  assert.deepEqual([...resolveAllowedActions("player")].sort(), [
    "bases:read", "guilds:read", "players:read", "server:read", "storage:read", "vehicles:read",
  ].sort());
});
