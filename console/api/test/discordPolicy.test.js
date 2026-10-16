import assert from "node:assert/strict";
import test from "node:test";
import {
  DISCORD_CAPABILITIES,
  DISCORD_ROLE_TIERS,
  discordActorCan,
  minTierForCapability,
  requireDiscordCapability
} from "../src/integrations/discord/policy.js";

const mapping = {
  playerRoleIds: ["role-player"],
  moderatorRoleIds: ["role-moderator"],
  adminRoleIds: ["role-admin"],
  ownerRoleIds: ["role-owner"]
};

function actor(roleId) {
  return { userId: "user-1", guildId: "guild-1", channelId: "channel-1", roleIds: roleId ? [roleId] : [], username: "tester" };
}

test("OPS capabilities are granted only to admin and owner tiers", () => {
  const opsCapabilities = Object.entries(DISCORD_CAPABILITIES)
    .filter(([name]) => name.startsWith("OPS_"))
    .map(([, capability]) => capability);

  assert.equal(opsCapabilities.length, 7);
  for (const capability of opsCapabilities) {
    assert.equal(discordActorCan(actor("role-player"), mapping, capability), false);
    assert.equal(discordActorCan(actor("role-moderator"), mapping, capability), false);
    assert.equal(discordActorCan(actor("role-admin"), mapping, capability), true);
    assert.equal(discordActorCan(actor("role-owner"), mapping, capability), true);
  }
});

test("OPS capability enforcement fails closed for unprivileged actors", () => {
  assert.throws(
    () => requireDiscordCapability(actor("role-moderator"), mapping, DISCORD_CAPABILITIES.OPS_ACTIVITY_READ),
    (error) => error.code === "not_authorized" && error.statusCode === 403
  );
  assert.doesNotThrow(() =>
    requireDiscordCapability(actor("role-admin"), mapping, DISCORD_CAPABILITIES.OPS_ACTIVITY_READ)
  );
});

// minTierForCapability() (added alongside the command catalog work so a
// consumer has a real, exported way to derive "minimum tier for this
// capability" instead of hand-maintaining a second, parallel table that
// could silently drift the moment a capability is added/moved here.
test("minTierForCapability returns the lowest tier that actually grants each capability, independently cross-checked against discordActorCan", () => {
  // Cross-check against discordActorCan() directly, rather than re-reading
  // CAPABILITY_BY_TIER's shape a second time -- this is an independent
  // verification path, not a restatement of the same table.
  const roleIdForTier = { public: null, player: "role-player", moderator: "role-moderator", admin: "role-admin", owner: "role-owner" };
  for (const capability of Object.values(DISCORD_CAPABILITIES)) {
    const claimedMinTier = minTierForCapability(capability);
    assert.ok(DISCORD_ROLE_TIERS.includes(claimedMinTier), `${capability}'s minTierForCapability() result "${claimedMinTier}" is not a real tier`);

    // Every tier at or above the claimed min tier must be granted the capability.
    const claimedIndex = DISCORD_ROLE_TIERS.indexOf(claimedMinTier);
    for (let i = claimedIndex; i < DISCORD_ROLE_TIERS.length; i++) {
      const tier = DISCORD_ROLE_TIERS[i];
      assert.equal(discordActorCan(actor(roleIdForTier[tier]), mapping, capability), true,
        `minTierForCapability(${capability}) claims "${claimedMinTier}" but tier "${tier}" (>= claimed) is not actually granted the capability per discordActorCan`);
    }

    // The tier immediately below the claimed min tier must NOT be granted
    // the capability (otherwise the claimed min tier is too high/strict).
    if (claimedIndex > 0) {
      const belowTier = DISCORD_ROLE_TIERS[claimedIndex - 1];
      assert.equal(discordActorCan(actor(roleIdForTier[belowTier]), mapping, capability), false,
        `minTierForCapability(${capability}) claims "${claimedMinTier}" but the tier below it, "${belowTier}", is ALSO granted the capability per discordActorCan -- claimed min tier is too high`);
    }
  }
});

test("minTierForCapability rejects an unsupported capability string, matching discordActorCan's own validation", () => {
  assert.throws(
    () => minTierForCapability("not:a:real:capability"),
    (error) => error.code === "invalid_capability"
  );
});
