export const DISCORD_ROLE_TIERS = ["public", "observer", "moderator", "admin", "owner"];

export const DISCORD_CAPABILITIES = Object.freeze({
  STATUS_READ: "status:read",
  READINESS_READ: "readiness:read",
  SERVICES_READ: "services:read",
  POPULATION_READ: "population:read",
  LOGS_READ: "logs:read",
  MAPS_READ: "maps:read",
  BACKUPS_READ: "backups:read",
  INVENTORY_READ: "inventory:read",
  STORAGE_READ: "storage:read",
  GUILD_READ: "guild:read",
  // PLAYER_LINK_WRITE is intentionally NOT part of the observer/moderator/
  // admin/owner tier ladder (see requireSelfScopedCapability() below /
  // docs/security/discord-player-link-hardening.md FINDING-LINK-2). It is a
  // self-scoped identity action, not a role-scoped visibility grant: every
  // route that checks it always passes discordUserId = actor.userId, never
  // a separate target, so any authenticated actor is always acting on their
  // own Discord-to-character link, never someone else's. Gating it by role
  // tier either over-restricts (only privileged roles could self-link,
  // defeating the self-service feature) or, at the tier it was previously
  // set to (moderator), over-grants (a large role population gets a
  // capability whose real authorization boundary is "must be this actor",
  // not "must hold this role").
  PLAYER_LINK_WRITE: "player-link:write",
  // ACCOUNT_LINK_WRITE is the FINDING-LINK-6 multi-account counterpart to
  // PLAYER_LINK_WRITE above, and is self-scoped for the same reason: every
  // multi-account route (link/verify/unlink/set-default) always passes
  // discordUserId = actor.userId, never a separate target. It is a
  // distinct capability (not a reuse of PLAYER_LINK_WRITE) so the two
  // linking flows can be enabled/disabled or audited independently.
  ACCOUNT_LINK_WRITE: "account-link:write",
  BROADCAST_SEND: "broadcast:send"
});

export const DISCORD_WRITE_CAPABILITIES = Object.freeze(new Set([
  DISCORD_CAPABILITIES.PLAYER_LINK_WRITE,
  DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE,
  DISCORD_CAPABILITIES.BROADCAST_SEND
]));

// Capabilities that are self-scoped identity actions rather than
// role-tier-gated visibility grants. requireDiscordCapability() intentionally
// does not check these against CAPABILITY_BY_TIER; callers must use
// requireSelfScopedCapability() instead, which only requires the actor to be
// a recognized Discord principal (observer tier or above) and always
// operates on that actor's own identity — see FINDING-LINK-2.
export const SELF_SCOPED_CAPABILITIES = Object.freeze(new Set([
  DISCORD_CAPABILITIES.PLAYER_LINK_WRITE,
  DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE
]));

export const EXPERIMENTAL_READ_ONLY_CAPABILITIES = Object.freeze(
  new Set(Object.values(DISCORD_CAPABILITIES).filter((capability) => !DISCORD_WRITE_CAPABILITIES.has(capability)))
);

const CAPABILITY_BY_TIER = Object.freeze({
  public: new Set([DISCORD_CAPABILITIES.STATUS_READ]),
  observer: new Set([
    DISCORD_CAPABILITIES.STATUS_READ,
    DISCORD_CAPABILITIES.READINESS_READ,
    DISCORD_CAPABILITIES.SERVICES_READ
  ]),
  moderator: new Set([
    DISCORD_CAPABILITIES.STATUS_READ,
    DISCORD_CAPABILITIES.READINESS_READ,
    DISCORD_CAPABILITIES.SERVICES_READ,
    DISCORD_CAPABILITIES.POPULATION_READ,
    DISCORD_CAPABILITIES.MAPS_READ,
    DISCORD_CAPABILITIES.BACKUPS_READ,
    DISCORD_CAPABILITIES.INVENTORY_READ,
    DISCORD_CAPABILITIES.STORAGE_READ,
    DISCORD_CAPABILITIES.GUILD_READ
    // PLAYER_LINK_WRITE removed: see SELF_SCOPED_CAPABILITIES above.
  ]),
  // Excludes SELF_SCOPED_CAPABILITIES: those are authorized via
  // requireSelfScopedCapability(), never via the tier ladder, even for
  // admin/owner — see FINDING-LINK-2 and the SELF_SCOPED_CAPABILITIES
  // comment above. discordActorCan() must not report a self-scoped
  // capability as tier-grantable for any tier.
  admin: new Set(Object.values(DISCORD_CAPABILITIES).filter((capability) => !SELF_SCOPED_CAPABILITIES.has(capability))),
  owner: new Set(Object.values(DISCORD_CAPABILITIES).filter((capability) => !SELF_SCOPED_CAPABILITIES.has(capability)))
});

export function normalizeRoleMapping(value = {}) {
  return {
    observerRoleIds: normalizeStringList(value.observerRoleIds),
    moderatorRoleIds: normalizeStringList(value.moderatorRoleIds),
    adminRoleIds: normalizeStringList(value.adminRoleIds),
    ownerRoleIds: normalizeStringList(value.ownerRoleIds)
  };
}

export function normalizeDiscordActor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw policyError("missing_actor", "Discord actor context is required.");
  const actor = {
    guildId: requiredString(value.guildId, "actor.guildId"),
    channelId: requiredString(value.channelId, "actor.channelId"),
    userId: requiredString(value.userId, "actor.userId"),
    username: requiredString(value.username, "actor.username"),
    roleIds: normalizeStringList(value.roleIds),
    interactionId: optionalString(value.interactionId),
    commandName: optionalString(value.commandName)
  };
  return actor;
}

export function discordActorTier(actor, mapping) {
  const roleIds = new Set(normalizeStringList(actor?.roleIds));
  const normalized = normalizeRoleMapping(mapping);
  if (normalized.ownerRoleIds.some((roleId) => roleIds.has(roleId))) return "owner";
  if (normalized.adminRoleIds.some((roleId) => roleIds.has(roleId))) return "admin";
  if (normalized.moderatorRoleIds.some((roleId) => roleIds.has(roleId))) return "moderator";
  if (normalized.observerRoleIds.some((roleId) => roleIds.has(roleId))) return "observer";
  return "public";
}

export function discordActorCan(actor, mapping, capability) {
  const normalizedCapability = requiredString(capability, "capability");
  if (!Object.values(DISCORD_CAPABILITIES).includes(normalizedCapability)) throw policyError("invalid_capability", `Unsupported Discord capability: ${normalizedCapability}`);
  return CAPABILITY_BY_TIER[discordActorTier(actor, mapping)].has(normalizedCapability);
}

export function requireDiscordCapability(actor, mapping, capability) {
  requireExperimentalReadOnlyCapability(capability);
  if (SELF_SCOPED_CAPABILITIES.has(capability)) {
    throw policyError(
      "invalid_capability",
      `${capability} is self-scoped; use requireSelfScopedCapability(), not requireDiscordCapability().`
    );
  }
  if (!discordActorCan(actor, mapping, capability)) {
    throw policyError("not_authorized", `Discord actor is not authorized for ${capability}.`, 403);
  }
}

// Authorizes a self-scoped capability (see SELF_SCOPED_CAPABILITIES above).
// Unlike requireDiscordCapability(), this never checks role tier against a
// visibility grant — it only requires the actor to be a recognized Discord
// principal (at least "observer" tier; "public" callers, who have no
// configured role at all, are rejected) and relies on every self-scoped
// route already always operating on actor.userId, never a separate target,
// to keep the action scoped to the caller's own identity. If a self-scoped
// route is ever changed to accept a target different from actor.userId,
// this function must be revisited — it does not itself enforce "target ==
// actor.userId" because no current caller has a separate target parameter.
export function requireSelfScopedCapability(actor, mapping, capability) {
  requireExperimentalReadOnlyCapability(capability);
  if (!SELF_SCOPED_CAPABILITIES.has(capability)) {
    throw policyError(
      "invalid_capability",
      `${capability} is not self-scoped; use requireDiscordCapability() instead.`
    );
  }
  if (discordActorTier(actor, mapping) === "public") {
    throw policyError("not_authorized", `Discord actor is not authorized for ${capability}.`, 403);
  }
}

export function requireExperimentalReadOnlyCapability(capability) {
  const normalizedCapability = requiredString(capability, "capability");
  if (DISCORD_WRITE_CAPABILITIES.has(normalizedCapability)) return;
  if (!EXPERIMENTAL_READ_ONLY_CAPABILITIES.has(normalizedCapability)) {
    throw policyError("not_read_only", `Capability is not allowed in experimental read-only mode: ${normalizedCapability}`, 403);
  }
}

export function policyError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function requiredString(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw policyError("invalid_actor", `${name} is required.`);
  if (text.length > 256) throw policyError("invalid_actor", `${name} is too long.`);
  return text;
}

function optionalString(value) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 256) : "";
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, 100);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 100);
  return [];
}
