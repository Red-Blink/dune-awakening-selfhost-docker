import test from "node:test";
import assert from "node:assert/strict";

import {
  TIER_RANK,
  CAPABILITIES,
  CAPABILITY_BY_TIER,
  resolveSessionTier,
  sessionTierRank,
  requireConsoleCapability,
  capabilitiesForTier,
  capabilityForRoute,
} from "../src/rbac.js";

// ---- Tier ladder ----

test("TIER_RANK maps names to integers", () => {
  assert.equal(TIER_RANK.owner, 3);
  assert.equal(TIER_RANK.admin, 2);
  assert.equal(TIER_RANK.moderator, 1);
  assert.equal(TIER_RANK.player, 0);
  assert.equal(TIER_RANK.observer, 0);
});

test("owner tier is higher than admin", () => {
  assert.ok(TIER_RANK.owner > TIER_RANK.admin);
});

test("admin tier is higher than moderator", () => {
  assert.ok(TIER_RANK.admin > TIER_RANK.moderator);
});

test("moderator tier is higher than player", () => {
  assert.ok(TIER_RANK.moderator > TIER_RANK.player);
});

// ---- resolveSessionTier ----

test("resolveSessionTier returns tier from session", () => {
  assert.equal(resolveSessionTier({ tier: "admin" }), "admin");
  assert.equal(resolveSessionTier({ tier: "owner" }), "owner");
  assert.equal(resolveSessionTier({ tier: "player" }), "player");
});

test("resolveSessionTier returns empty for null session", () => {
  assert.equal(resolveSessionTier(null), "");
  assert.equal(resolveSessionTier(undefined), "");
});

test("resolveSessionTier returns empty for unknown tier", () => {
  assert.equal(resolveSessionTier({ tier: "superuser" }), "");
  assert.equal(resolveSessionTier({ tier: "" }), "");
  assert.equal(resolveSessionTier({ tier: 123 }), "");
});

test("resolveSessionTier returns empty when tier missing", () => {
  assert.equal(resolveSessionTier({}), "");
});

// ---- sessionTierRank ----

test("sessionTierRank returns rank for valid tier", () => {
  assert.equal(sessionTierRank({ tier: "owner" }), 3);
  assert.equal(sessionTierRank({ tier: "admin" }), 2);
  assert.equal(sessionTierRank({ tier: "player" }), 0);
});

test("sessionTierRank returns -1 for invalid session", () => {
  assert.equal(sessionTierRank(null), -1);
  assert.equal(sessionTierRank({ tier: "bogus" }), -1);
});

// ---- capabilitiesForTier ----

test("capabilitiesForTier returns full list for owner", () => {
  const caps = capabilitiesForTier("owner");
  assert.ok(caps.includes(CAPABILITIES.STATUS_READ));
  assert.ok(caps.includes(CAPABILITIES.SERVER_CONTROL));
  assert.ok(caps.includes(CAPABILITIES.SETTINGS_WRITE));
  assert.equal(caps.length, Object.keys(CAPABILITIES).length);
});

test("capabilitiesForTier returns admin-level caps for admin", () => {
  const caps = capabilitiesForTier("admin");
  assert.ok(caps.includes(CAPABILITIES.STATUS_READ));
  assert.ok(caps.includes(CAPABILITIES.WORLD_READ));
  assert.ok(caps.includes(CAPABILITIES.WORLD_WRITE));
  assert.ok(caps.includes(CAPABILITIES.LOGS_READ));
  assert.ok(caps.includes(CAPABILITIES.BACKUPS_READ));
  assert.ok(caps.includes(CAPABILITIES.BACKUPS_WRITE));
  assert.ok(caps.includes(CAPABILITIES.DATABASE_READ));
  assert.ok(caps.includes(CAPABILITIES.UPDATES_READ));
  assert.ok(caps.includes(CAPABILITIES.UPDATES_WRITE));
  assert.ok(caps.includes(CAPABILITIES.SERVER_CONTROL));
  assert.ok(caps.includes(CAPABILITIES.ADDONS_READ));
  assert.ok(caps.includes(CAPABILITIES.ADDONS_WRITE));
  assert.ok(caps.includes(CAPABILITIES.ADMIN_TOOLS));
  assert.ok(caps.includes(CAPABILITIES.PLAYER_MUTATE));
  assert.ok(caps.includes(CAPABILITIES.MAP_WRITE));
  assert.ok(!caps.includes(CAPABILITIES.SETTINGS_WRITE));
  assert.ok(!caps.includes(CAPABILITIES.DATABASE_WRITE));
});

test("capabilitiesForTier returns moderation caps for moderator", () => {
  const caps = capabilitiesForTier("moderator");
  assert.ok(caps.includes(CAPABILITIES.STATUS_READ));
  assert.ok(caps.includes(CAPABILITIES.WORLD_READ));
  assert.ok(caps.includes(CAPABILITIES.WORLD_WRITE));
  assert.ok(caps.includes(CAPABILITIES.LOGS_READ));
  assert.ok(caps.includes(CAPABILITIES.ADMIN_TOOLS));
  assert.ok(caps.includes(CAPABILITIES.PLAYER_MUTATE));
  assert.ok(caps.includes(CAPABILITIES.MAP_WRITE));
  assert.ok(!caps.includes(CAPABILITIES.SERVER_CONTROL));
  assert.ok(!caps.includes(CAPABILITIES.BACKUPS_READ));
  assert.ok(!caps.includes(CAPABILITIES.DATABASE_READ));
  assert.ok(!caps.includes(CAPABILITIES.SETTINGS_WRITE));
  assert.ok(!caps.includes(CAPABILITIES.CARE_PACKAGE_GRANT));
});

test("capabilitiesForTier returns read-only caps for player", () => {
  const caps = capabilitiesForTier("player");
  assert.ok(caps.includes(CAPABILITIES.STATUS_READ));
  assert.ok(caps.includes(CAPABILITIES.WORLD_READ));
  assert.ok(!caps.includes(CAPABILITIES.LOGS_READ));
  assert.ok(!caps.includes(CAPABILITIES.SERVER_CONTROL));
  assert.ok(!caps.includes(CAPABILITIES.PLAYER_MUTATE));
});

test("capabilitiesForTier returns empty for invalid tier", () => {
  assert.deepEqual(capabilitiesForTier("bogus"), []);
  assert.deepEqual(capabilitiesForTier(""), []);
});

// ---- requireConsoleCapability ----

test("requireConsoleCapability allows owner for every capability", () => {
  for (const cap of Object.values(CAPABILITIES)) {
    assert.equal(requireConsoleCapability({ tier: "owner" }, cap), true, `owner denied ${cap}`);
  }
});

test("requireConsoleCapability allows admin for admin-level caps", () => {
  assert.equal(requireConsoleCapability({ tier: "admin" }, CAPABILITIES.STATUS_READ), true);
  assert.equal(requireConsoleCapability({ tier: "admin" }, CAPABILITIES.WORLD_READ), true);
  assert.equal(requireConsoleCapability({ tier: "admin" }, CAPABILITIES.WORLD_WRITE), true);
  assert.equal(requireConsoleCapability({ tier: "admin" }, CAPABILITIES.LOGS_READ), true);
  assert.equal(requireConsoleCapability({ tier: "admin" }, CAPABILITIES.SERVER_CONTROL), true);
  assert.equal(requireConsoleCapability({ tier: "admin" }, CAPABILITIES.PLAYER_MUTATE), true);
  assert.equal(requireConsoleCapability({ tier: "admin" }, CAPABILITIES.BACKUPS_WRITE), true);
  assert.equal(requireConsoleCapability({ tier: "admin" }, CAPABILITIES.ADDONS_WRITE), true);
});

test("requireConsoleCapability denies admin for owner-only caps", () => {
  assert.equal(requireConsoleCapability({ tier: "admin" }, CAPABILITIES.SETTINGS_WRITE), false);
  assert.equal(requireConsoleCapability({ tier: "admin" }, CAPABILITIES.DATABASE_WRITE), false);
});

test("requireConsoleCapability allows admin to grant care packages", () => {
  assert.equal(requireConsoleCapability({ tier: "admin" }, CAPABILITIES.CARE_PACKAGE_GRANT), true);
});

test("requireConsoleCapability allows moderator for moderator-level caps", () => {
  assert.equal(requireConsoleCapability({ tier: "moderator" }, CAPABILITIES.STATUS_READ), true);
  assert.equal(requireConsoleCapability({ tier: "moderator" }, CAPABILITIES.WORLD_READ), true);
  assert.equal(requireConsoleCapability({ tier: "moderator" }, CAPABILITIES.LOGS_READ), true);
  assert.equal(requireConsoleCapability({ tier: "moderator" }, CAPABILITIES.ADMIN_TOOLS), true);
  assert.equal(requireConsoleCapability({ tier: "moderator" }, CAPABILITIES.PLAYER_MUTATE), true);
});

test("requireConsoleCapability denies moderator for admin-level caps", () => {
  assert.equal(requireConsoleCapability({ tier: "moderator" }, CAPABILITIES.SERVER_CONTROL), false);
  assert.equal(requireConsoleCapability({ tier: "moderator" }, CAPABILITIES.BACKUPS_READ), false);
  assert.equal(requireConsoleCapability({ tier: "moderator" }, CAPABILITIES.DATABASE_READ), false);
  assert.equal(requireConsoleCapability({ tier: "moderator" }, CAPABILITIES.SETTINGS_WRITE), false);
  assert.equal(requireConsoleCapability({ tier: "moderator" }, CAPABILITIES.CARE_PACKAGE_GRANT), false);
});

test("requireConsoleCapability allows player for read-only caps", () => {
  assert.equal(requireConsoleCapability({ tier: "player" }, CAPABILITIES.STATUS_READ), true);
  assert.equal(requireConsoleCapability({ tier: "player" }, CAPABILITIES.WORLD_READ), true);
});

test("requireConsoleCapability denies player for anything beyond read", () => {
  assert.equal(requireConsoleCapability({ tier: "player" }, CAPABILITIES.LOGS_READ), false);
  assert.equal(requireConsoleCapability({ tier: "player" }, CAPABILITIES.SERVER_CONTROL), false);
  assert.equal(requireConsoleCapability({ tier: "player" }, CAPABILITIES.PLAYER_MUTATE), false);
});

test("requireConsoleCapability denies invalid session", () => {
  assert.equal(requireConsoleCapability(null, CAPABILITIES.STATUS_READ), false);
  assert.equal(requireConsoleCapability({ tier: "bogus" }, CAPABILITIES.STATUS_READ), false);
});

test("requireConsoleCapability allows any tier when no capability required", () => {
  assert.equal(requireConsoleCapability({ tier: "player" }, null), true);
  assert.equal(requireConsoleCapability({ tier: "player" }, undefined), true);
  assert.equal(requireConsoleCapability(null, null), true);
});

// ---- capabilityForRoute: public routes ----

test("capabilityForRoute returns null for public routes", () => {
  assert.equal(capabilityForRoute("/api/health", "GET"), null);
  assert.equal(capabilityForRoute("/api/auth/state", "GET"), null);
  assert.equal(capabilityForRoute("/api/auth/login", "POST"), null);
  assert.equal(capabilityForRoute("/api/auth/logout", "POST"), null);
  assert.equal(capabilityForRoute("/api/auth/me", "GET"), null);
  assert.equal(capabilityForRoute("/api/auth/discord/start", "GET"), null);
  assert.equal(capabilityForRoute("/api/auth/discord/callback", "GET"), null);
});

// ---- capabilityForRoute: discord adapter ----

test("capabilityForRoute returns bot read stub for discord adapter routes", () => {
  const result = capabilityForRoute("/api/integrations/discord/status", "POST");
  assert.ok(result instanceof Set || Array.isArray(result));
});

// ---- capabilityForRoute: exact match routes ----

test("capabilityForRoute resolves exact-match routes", () => {
  assert.equal(capabilityForRoute("/api/server/status", "GET"), CAPABILITIES.STATUS_READ);
  assert.equal(capabilityForRoute("/api/server/start", "POST"), CAPABILITIES.SERVER_CONTROL);
  assert.equal(capabilityForRoute("/api/server/restart", "POST"), CAPABILITIES.SERVER_CONTROL);
  assert.equal(capabilityForRoute("/api/players", "GET"), CAPABILITIES.WORLD_READ);
  assert.equal(capabilityForRoute("/api/players/online", "GET"), CAPABILITIES.WORLD_READ);
  assert.equal(capabilityForRoute("/api/backups", "GET"), CAPABILITIES.BACKUPS_READ);
  assert.equal(capabilityForRoute("/api/backups/create", "POST"), CAPABILITIES.BACKUPS_WRITE);
  assert.equal(capabilityForRoute("/api/database/status", "GET"), CAPABILITIES.DATABASE_READ);
  assert.equal(capabilityForRoute("/api/database/query", "POST"), CAPABILITIES.DATABASE_WRITE);
  assert.equal(capabilityForRoute("/api/settings/admin-password", "POST"), CAPABILITIES.SETTINGS_WRITE);
});

test("capabilityForRoute resolves admin-tools routes", () => {
  assert.equal(capabilityForRoute("/api/admin/items/catalog", "GET"), CAPABILITIES.ADMIN_TOOLS);
  assert.equal(capabilityForRoute("/api/admin/history/clear", "POST"), CAPABILITIES.ADMIN_TOOLS);
  assert.equal(capabilityForRoute("/api/admin/broadcast", "POST"), CAPABILITIES.ADMIN_TOOLS);
});

test("capabilityForRoute resolves care-package routes", () => {
  assert.equal(capabilityForRoute("/api/care-package/config", "GET"), CAPABILITIES.ADMIN_TOOLS);
  assert.equal(capabilityForRoute("/api/care-package/config", "POST"), CAPABILITIES.CARE_PACKAGE_GRANT);
  assert.equal(capabilityForRoute("/api/care-package/grant-eligible", "POST"), CAPABILITIES.CARE_PACKAGE_GRANT);
});

test("capabilityForRoute method is case-insensitive", () => {
  assert.equal(capabilityForRoute("/api/server/status", "get"), CAPABILITIES.STATUS_READ);
  assert.equal(capabilityForRoute("/api/server/status", "GET"), CAPABILITIES.STATUS_READ);
});

// ---- capabilityForRoute: regex routes ----

test("capabilityForRoute resolves regex-based routes (players)", () => {
  assert.equal(capabilityForRoute("/api/players/12345", "GET"), CAPABILITIES.WORLD_READ);
  assert.equal(capabilityForRoute("/api/players/12345/inventory", "GET"), CAPABILITIES.WORLD_READ);
  assert.equal(capabilityForRoute("/api/players/12345/give-item", "POST"), CAPABILITIES.PLAYER_MUTATE);
  assert.equal(capabilityForRoute("/api/players/12345/kick", "POST"), CAPABILITIES.PLAYER_MUTATE);
});

test("capabilityForRoute resolves regex-based routes (bases)", () => {
  assert.equal(capabilityForRoute("/api/bases/42", "GET"), CAPABILITIES.WORLD_READ);
  assert.equal(capabilityForRoute("/api/bases/42/export", "GET"), CAPABILITIES.WORLD_READ);
  assert.equal(capabilityForRoute("/api/bases/42/refill-generators", "POST"), CAPABILITIES.WORLD_WRITE);
});

test("capabilityForRoute resolves regex-based routes (guilds)", () => {
  assert.equal(capabilityForRoute("/api/guilds/42/members", "GET"), CAPABILITIES.WORLD_READ);
  assert.equal(capabilityForRoute("/api/guilds/42/members", "POST"), CAPABILITIES.WORLD_WRITE);
  assert.equal(capabilityForRoute("/api/guilds/42/members/99", "DELETE"), CAPABILITIES.WORLD_WRITE);
});

test("capabilityForRoute resolves regex-based routes (database)", () => {
  assert.equal(capabilityForRoute("/api/database/routines/test_fn", "GET"), CAPABILITIES.DATABASE_READ);
  assert.equal(capabilityForRoute("/api/database/tables/dune/players/columns", "GET"), CAPABILITIES.DATABASE_READ);
});

test("capabilityForRoute resolves regex-based routes (addons)", () => {
  assert.equal(capabilityForRoute("/api/addons/installed/test-id", "GET"), CAPABILITIES.ADDONS_READ);
  assert.equal(capabilityForRoute("/api/addons/installed/test-id/enable", "POST"), CAPABILITIES.ADDONS_WRITE);
  assert.equal(capabilityForRoute("/api/addons/installed/test-id", "DELETE"), CAPABILITIES.ADDONS_WRITE);
});
