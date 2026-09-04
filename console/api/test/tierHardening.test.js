import test from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/policy.js";
import { actionForRoute } from "../src/actions.js";

// Pins the over-restrictive tier model: admin operates the live server and
// moderates players but can change nothing persistent, deploy nothing, destroy
// no data, and touch no economy. Regression guard for the RBAC hardening
// -- before this, admin was owner-minus-a-couple-things.
const can = (tier, action) => evaluate({ tier }, action);

// --- Admin is DENIED every "compromise or destroy the deployment" action ---
const ADMIN_FORBIDDEN = [
  "server:write-credentials", "server:write-config",
  "settings:write", "settings:change-password", "settings:change-port", "settings:regenerate-recovery-codes",
  "database:write-config", "database:mutate", "database:export",
  "updates:apply", "updates:fix", "updates:repair", "updates:write-config",
  "backups:restore", "backups:import", "backups:delete", "backups:write-config",
  "addons:install", "addons:update", "addons:mutate",
  "setup:write",
  "players:mutate",
  "carepackage:grant", "carepackage:write-config",
  "admin:transfer-settings:write",
  "exchange:market", "exchange:market-write", "exchange:write-config",
  "maps:write-config",
];
for (const action of ADMIN_FORBIDDEN) {
  test(`admin is DENIED ${action}`, () => assert.equal(can("admin", action), false));
}

// --- Admin can still OPERATE the server and MODERATE players ---
const ADMIN_ALLOWED = [
  "server:read", "server:start", "server:stop", "server:restart",
  "server:restart-service", "server:network-fix", "server:storage-cleanup",
  "players:read", "players:kick-all", "players:moderate", "players:teleport",
  "maps:spawn", "maps:despawn", "maps:teleport", "maps:restart", "maps:reconcile",
  "admin:broadcast", "admin:map-chat",
  "backups:create", "backups:read", "database:read", "database:query",
  "logs:read", "updates:check", "updates:read", "updates:self-check", "setup:read", "addons:read",
  // carepackage:read is read-only visibility, same as every other namespace
  // -- only the economy-write actions above are denied (review finding: this
  // was missing from admin's explicit Allow list entirely, an accidental
  // regression from the old carepackage:* wildcard, not an intended narrowing).
  "carepackage:read",
];
for (const action of ADMIN_ALLOWED) {
  test(`admin CAN ${action}`, () => assert.equal(can("admin", action), true));
}

// --- Moderator gains individual moderation, no economy/config/lifecycle ---
test("moderator can act on individual griefers (kick/ban/teleport) + mass kick", () => {
  for (const a of ["players:moderate", "players:teleport", "players:kick-all"]) assert.equal(can("moderator", a), true, a);
});
test("moderator cannot mutate economy, restart the server, take backups, or edit config", () => {
  for (const a of ["players:mutate", "server:restart", "backups:create", "maps:write-config"]) assert.equal(can("moderator", a), false, a);
});

// --- Observer folded into player (live-testing decision): it was a strict
// subset of player with no real distinct purpose, and unreachable via
// Discord role mapping. "observer" is no longer a recognized tier at all. ---
test("observer is no longer a recognized tier -- fails closed like any other unrecognized string", () => {
  for (const a of ["server:read", "players:read", "bases:read", "logs:read", "database:read"]) assert.equal(can("observer", a), false, a);
});

// --- Player is a tight read-only self-service set (server/players/guilds/maps) ---
test("player reads only server health, players, guilds, and the live map", () => {
  for (const a of ["server:read", "players:read", "guilds:read", "maps:read"]) assert.equal(can("player", a), true, a);
});
test("player cannot read the broad game world or write anything", () => {
  for (const a of ["bases:read", "storage:read", "blueprints:read", "vehicles:read", "exchange:read", "landsraad:read", "sietches:read", "deepdesert:read", "backups:read", "database:read"]) assert.equal(can("player", a), false, `read ${a}`);
  for (const a of ["players:moderate", "server:restart", "maps:write-config"]) assert.equal(can("player", a), false, `write ${a}`);
});

// --- Owner keeps the crown jewels ---
test("owner retains every owner-only action", () => {
  for (const a of ["server:write-credentials", "updates:apply", "backups:restore", "database:mutate", "addons:install", "players:mutate", "settings:write"]) assert.equal(can("owner", a), true, a);
});

// --- The moderation catalog split routes correctly ---
// Merge-conflict finding (upstream-main-base sync): players:mutate no longer
// exists as a route-resolvable action at all -- upstream's real main had
// independently gone further than this repo's own kick/ban split and
// classified every mutating player route into its own narrow action
// (actionSplits.test.js's EXPECTED table is the authoritative, exhaustive
// spec). kick/ban/unban also renamed here from the two separate
// players:kick/players:ban this repo used to have to the single
// players:moderate name upstream's main already uses for all three.
test("player moderation routes resolve to their own narrow actions, never the retired players:mutate", () => {
  assert.equal(actionForRoute("/api/players/abc/kick", "POST"), "players:moderate");
  assert.equal(actionForRoute("/api/players/abc/ban", "POST"), "players:moderate");
  assert.equal(actionForRoute("/api/players/abc/ban", "DELETE"), "players:moderate");
  assert.equal(actionForRoute("/api/players/abc/teleport", "POST"), "players:teleport");
  assert.equal(actionForRoute("/api/players/abc/give-item", "POST"), "players:give-item");
  assert.equal(actionForRoute("/api/players/abc/add-currency", "POST"), "players:grant");
  assert.equal(actionForRoute("/api/players/abc/reset-progression", "POST"), "players:reset");
});

// --- Funcom token + IP change resolve to the owner-only credential action ---
test("Funcom token and IP change are server:write-credentials (owner-only, both paths)", () => {
  assert.equal(actionForRoute("/api/server/funcom-token", "POST"), "server:write-credentials");
  assert.equal(actionForRoute("/api/server/ip-change-restart", "POST"), "server:write-credentials");
  assert.equal(actionForRoute("/api/setup/save-token", "POST"), "server:write-credentials");
  assert.equal(can("admin", "server:write-credentials"), false);
  assert.equal(can("owner", "server:write-credentials"), true);
});
