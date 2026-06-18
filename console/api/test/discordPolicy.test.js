import assert from "node:assert/strict";
import test from "node:test";
import { DISCORD_CAPABILITIES, EXPERIMENTAL_READ_ONLY_CAPABILITIES, discordActorCan, discordActorTier, normalizeDiscordActor, requireDiscordCapability, requireExperimentalReadOnlyCapability } from "../src/integrations/discord/policy.js";

const mapping = {
  observerRoleIds: ["role-observer"],
  moderatorRoleIds: ["role-moderator"],
  adminRoleIds: ["role-admin"],
  ownerRoleIds: ["role-owner"]
};

function actor(roleIds = []) {
  return normalizeDiscordActor({
    guildId: "guild-1",
    channelId: "channel-1",
    userId: "user-1",
    username: "tester",
    roleIds,
    interactionId: "interaction-1",
    commandName: "/dune test"
  });
}

test("normalizes required Discord actor context", () => {
  const result = actor(["role-admin"]);
  assert.equal(result.guildId, "guild-1");
  assert.equal(result.userId, "user-1");
  assert.deepEqual(result.roleIds, ["role-admin"]);
});

test("rejects missing Discord actor context", () => {
  assert.throws(() => normalizeDiscordActor(null), /Discord actor context is required/);
});

test("maps owner above admin above moderator above observer", () => {
  assert.equal(discordActorTier(actor(["role-owner", "role-admin"]), mapping), "owner");
  assert.equal(discordActorTier(actor(["role-admin", "role-moderator"]), mapping), "admin");
  assert.equal(discordActorTier(actor(["role-moderator", "role-observer"]), mapping), "moderator");
  assert.equal(discordActorTier(actor(["role-observer"]), mapping), "observer");
  assert.equal(discordActorTier(actor([]), mapping), "public");
});

test("allows public actors to read status only", () => {
  assert.equal(discordActorCan(actor([]), mapping, DISCORD_CAPABILITIES.STATUS_READ), true);
  assert.equal(discordActorCan(actor([]), mapping, DISCORD_CAPABILITIES.READINESS_READ), false);
  assert.equal(discordActorCan(actor([]), mapping, DISCORD_CAPABILITIES.POPULATION_READ), false);
});

test("allows observer to read readiness and services", () => {
  assert.equal(discordActorCan(actor(["role-observer"]), mapping, DISCORD_CAPABILITIES.READINESS_READ), true);
  assert.equal(discordActorCan(actor(["role-observer"]), mapping, DISCORD_CAPABILITIES.SERVICES_READ), true);
  assert.equal(discordActorCan(actor(["role-observer"]), mapping, DISCORD_CAPABILITIES.LOGS_READ), false);
});

test("allows moderator to read population, map state, and backups", () => {
  assert.equal(discordActorCan(actor(["role-moderator"]), mapping, DISCORD_CAPABILITIES.POPULATION_READ), true);
  assert.equal(discordActorCan(actor(["role-moderator"]), mapping, DISCORD_CAPABILITIES.MAPS_READ), true);
  assert.equal(discordActorCan(actor(["role-moderator"]), mapping, DISCORD_CAPABILITIES.BACKUPS_READ), true);
  assert.equal(discordActorCan(actor(["role-moderator"]), mapping, DISCORD_CAPABILITIES.LOGS_READ), false);
});

test("requires admin for logs", () => {
  assert.equal(discordActorCan(actor(["role-admin"]), mapping, DISCORD_CAPABILITIES.LOGS_READ), true);
  assert.throws(() => requireDiscordCapability(actor(["role-moderator"]), mapping, DISCORD_CAPABILITIES.LOGS_READ), /not authorized/);
});

test("keeps all experimental capabilities read-only", () => {
  for (const capability of Object.values(DISCORD_CAPABILITIES)) {
    assert.equal(EXPERIMENTAL_READ_ONLY_CAPABILITIES.has(capability), true, capability);
    assert.doesNotThrow(() => requireExperimentalReadOnlyCapability(capability));
    assert.doesNotMatch(capability, /write|admin|destructive|execute|delete|restore|create|broadcast|restart|kick|grant|teleport|reset/i);
  }
});

test("rejects non-read-only capabilities", () => {
  assert.throws(() => requireExperimentalReadOnlyCapability("database:write"), /not allowed in experimental read-only mode/);
  assert.throws(() => requireExperimentalReadOnlyCapability("backups:destructive"), /not allowed in experimental read-only mode/);
});
