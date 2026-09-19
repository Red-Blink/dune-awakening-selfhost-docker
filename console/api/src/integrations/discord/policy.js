export const DISCORD_ROLE_TIERS = ["public", "player", "moderator", "admin", "owner"];

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
  OPS_ACTIVITY_READ: "ops:activity:read",
  OPS_COMBAT_READ: "ops:combat:read",
  OPS_RESOURCES_READ: "ops:resources:read",
  OPS_ECONOMY_READ: "ops:economy:read",
  OPS_INVENTORY_READ: "ops:inventory:read",
  OPS_SOC_READ: "ops:soc:read",
  OPS_PROMETHEUS_READ: "ops:prometheus:read",
  PLAYER_LINK_WRITE: "player-link:write",
  BROADCAST_SEND: "broadcast:send"
});

export const DISCORD_WRITE_CAPABILITIES = Object.freeze(new Set([
  DISCORD_CAPABILITIES.PLAYER_LINK_WRITE,
  DISCORD_CAPABILITIES.BROADCAST_SEND
]));

export const EXPERIMENTAL_READ_ONLY_CAPABILITIES = Object.freeze(
  new Set(Object.values(DISCORD_CAPABILITIES).filter((capability) => !DISCORD_WRITE_CAPABILITIES.has(capability)))
);

const CAPABILITY_BY_TIER = Object.freeze({
  public: new Set([DISCORD_CAPABILITIES.STATUS_READ]),
  // Renamed from "observer" -- terminology consistency with the console's own
  // session tier naming (policy.js's OBSOLETE_TIERS folded its own, separate
  // "observer" console tier into "player" earlier; this is the Discord
  // adapter's independent tier space adopting the same name for its lowest
  // real tier). Capability set is UNCHANGED -- this remains a zero-write
  // tier, per docs/rw-architecture.md Section 0's permanent invariant that
  // covers "any future Discord-side equivalent" of the console's player tier.
  player: new Set([
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
    DISCORD_CAPABILITIES.PLAYER_LINK_WRITE,
    DISCORD_CAPABILITIES.GUILD_READ
  ]),
  admin: new Set(Object.values(DISCORD_CAPABILITIES)),
  owner: new Set(Object.values(DISCORD_CAPABILITIES))
});

export function normalizeRoleMapping(value = {}) {
  return {
    // dune-awakening-selfhost-docker#748+: field renamed observer -> player
    // to match adapter.js's discordRoleMappingFromEnv() (the source mapping
    // this function normalizes). tier1-upstream's own 2026-09-11 rename
    // commit later renamed the returned TIER name itself too (see
    // discordActorTier() below) -- both the field and the tier value are
    // "player" now, nothing left half-renamed.
    playerRoleIds: normalizeStringList(value.playerRoleIds),
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
  if (normalized.playerRoleIds.some((roleId) => roleIds.has(roleId))) return "player";
  return "public";
}

export function discordActorCan(actor, mapping, capability) {
  const normalizedCapability = requiredString(capability, "capability");
  if (!Object.values(DISCORD_CAPABILITIES).includes(normalizedCapability)) throw policyError("invalid_capability", `Unsupported Discord capability: ${normalizedCapability}`);
  return CAPABILITY_BY_TIER[discordActorTier(actor, mapping)].has(normalizedCapability);
}

// Returns the lowest tier in DISCORD_ROLE_TIERS order that grants the given
// capability per CAPABILITY_BY_TIER, or null if no tier grants it.
//
// Added so commandCatalog.js can derive its per-command minimum
// tier directly from this file's real, single source of truth instead of
// hand-maintaining a second, parallel table that could silently drift the
// moment a capability is added or moved between tiers here. Any caller
// needing "what's the minimum tier for capability X" should use this
// function rather than re-deriving CAPABILITY_BY_TIER's shape elsewhere.
export function minTierForCapability(capability) {
  const normalizedCapability = requiredString(capability, "capability");
  if (!Object.values(DISCORD_CAPABILITIES).includes(normalizedCapability)) throw policyError("invalid_capability", `Unsupported Discord capability: ${normalizedCapability}`);
  for (const tier of DISCORD_ROLE_TIERS) {
    if (CAPABILITY_BY_TIER[tier]?.has(normalizedCapability)) return tier;
  }
  return null;
}

export function requireDiscordCapability(actor, mapping, capability) {
  requireExperimentalReadOnlyCapability(capability);
  if (!discordActorCan(actor, mapping, capability)) {
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
