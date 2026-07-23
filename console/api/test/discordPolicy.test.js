import assert from "node:assert/strict";
import test from "node:test";
import {
  DISCORD_CAPABILITIES,
  SELF_SCOPED_CAPABILITIES,
  discordActorCan,
  discordActorTier,
  requireDiscordCapability,
  requireSelfScopedCapability
} from "../src/integrations/discord/policy.js";

const mapping = {
  observerRoleIds: ["role-observer"],
  moderatorRoleIds: ["role-moderator"],
  adminRoleIds: ["role-admin"],
  ownerRoleIds: ["role-owner"]
};

function actor(roleIds = []) {
  return { userId: "user-1", guildId: "guild-1", channelId: "channel-1", roleIds, username: "tester" };
}

test("PLAYER_LINK_WRITE is a self-scoped capability, not tier-gated", () => {
  assert.ok(SELF_SCOPED_CAPABILITIES.has(DISCORD_CAPABILITIES.PLAYER_LINK_WRITE));
});

// FINDING-LINK-2 (docs/security/discord-player-link-hardening.md):
// player-link:write previously lived in the "moderator" tier's capability
// set, which is disproportionate for an identity-binding action, but also
// wrong in the other direction — every route that checks it always passes
// discordUserId = actor.userId, so it needs to work for ANY authenticated
// actor linking their own account, not be restricted to a privileged tier.
test("requireDiscordCapability rejects PLAYER_LINK_WRITE entirely — self-scoped capabilities must use requireSelfScopedCapability", () => {
  const ownerActor = actor(["role-owner"]);
  assert.throws(
    () => requireDiscordCapability(ownerActor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE),
    (error) => error.code === "invalid_capability"
  );
});

test("discordActorCan never grants PLAYER_LINK_WRITE via the tier ladder, even for admin/owner", () => {
  // discordActorCan() itself is tier-only; PLAYER_LINK_WRITE is
  // intentionally absent from every tier's Set (including admin/owner,
  // which use Set(Object.values(DISCORD_CAPABILITIES)) elsewhere in the
  // module for other capabilities — this capability was carved out).
  const adminActor = actor(["role-admin"]);
  const ownerActor = actor(["role-owner"]);
  assert.equal(discordActorCan(adminActor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE), false);
  assert.equal(discordActorCan(ownerActor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE), false);
});

test("requireSelfScopedCapability allows any recognized principal (observer tier) to link their own account", () => {
  const observerActor = actor(["role-observer"]);
  assert.doesNotThrow(() => requireSelfScopedCapability(observerActor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE));
});

test("requireSelfScopedCapability allows moderator/admin/owner tiers too (self-scoped, not restricted upward)", () => {
  for (const roleId of ["role-moderator", "role-admin", "role-owner"]) {
    const roleActor = actor([roleId]);
    assert.doesNotThrow(() => requireSelfScopedCapability(roleActor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE));
  }
});

test("requireSelfScopedCapability rejects an actor with no configured role at all (public tier)", () => {
  const publicActor = actor([]);
  assert.equal(discordActorTier(publicActor, mapping), "public");
  assert.throws(
    () => requireSelfScopedCapability(publicActor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE),
    (error) => error.code === "not_authorized" && error.statusCode === 403
  );
});

test("requireSelfScopedCapability rejects a tier-gated capability like STATUS_READ", () => {
  const observerActor = actor(["role-observer"]);
  assert.throws(
    () => requireSelfScopedCapability(observerActor, mapping, DISCORD_CAPABILITIES.STATUS_READ),
    (error) => error.code === "invalid_capability"
  );
});

test("requireDiscordCapability still works normally for ordinary tier-gated capabilities", () => {
  const observerActor = actor(["role-observer"]);
  assert.doesNotThrow(() => requireDiscordCapability(observerActor, mapping, DISCORD_CAPABILITIES.STATUS_READ));
  const publicActor = actor([]);
  assert.throws(
    () => requireDiscordCapability(publicActor, mapping, DISCORD_CAPABILITIES.READINESS_READ),
    (error) => error.code === "not_authorized"
  );
});

// FINDING-LINK-6 (docs/security/discord-player-link-hardening.md):
// ACCOUNT_LINK_WRITE is a distinct self-scoped capability from
// PLAYER_LINK_WRITE, not a reuse of it, so the two linking flows can be
// authorized/audited independently.
test("ACCOUNT_LINK_WRITE is self-scoped and distinct from PLAYER_LINK_WRITE", () => {
  assert.ok(SELF_SCOPED_CAPABILITIES.has(DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE));
  assert.notEqual(DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE);
});

test("requireDiscordCapability rejects ACCOUNT_LINK_WRITE entirely — must use requireSelfScopedCapability", () => {
  const ownerActor = actor(["role-owner"]);
  assert.throws(
    () => requireDiscordCapability(ownerActor, mapping, DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE),
    (error) => error.code === "invalid_capability"
  );
});

test("requireSelfScopedCapability allows any recognized principal to use ACCOUNT_LINK_WRITE, and rejects public tier", () => {
  const observerActor = actor(["role-observer"]);
  assert.doesNotThrow(() => requireSelfScopedCapability(observerActor, mapping, DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE));
  const publicActor = actor([]);
  assert.throws(
    () => requireSelfScopedCapability(publicActor, mapping, DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE),
    (error) => error.code === "not_authorized" && error.statusCode === 403
  );
});
