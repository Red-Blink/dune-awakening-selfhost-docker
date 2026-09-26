import { audit } from "../../audit.js";
import { DISCORD_CAPABILITIES, normalizeDiscordActor, requireDiscordCapability } from "./policy.js";
import { discordAuditEvent, discordBlockedAuditEvent } from "./audit.js";
import { discordSafeError, sanitizeDiscordPublicStatus, sanitizeDiscordValue } from "./sanitize.js";

export const DISCORD_ADAPTER_ROUTES = Object.freeze({
  HEALTH: "/api/integrations/discord/health",
  STATUS: "/api/integrations/discord/status",
  READINESS: "/api/integrations/discord/readiness",
  SERVICES: "/api/integrations/discord/services",
  POPULATION: "/api/integrations/discord/population",
  LOGS: "/api/integrations/discord/logs",
  MAP_STATE: "/api/integrations/discord/map-state",
  MAINTENANCE: "/api/integrations/discord/maintenance",
  BACKUPS_LIST: "/api/integrations/discord/backups/list",
  BROADCAST: "/api/integrations/discord/broadcast",
  ANNOUNCEMENTS: "/api/integrations/discord/announcements",
  OPS_ACTIVITY: "/api/integrations/discord/ops/activity",
  OPS_COMBAT: "/api/integrations/discord/ops/combat",
  OPS_RESOURCES: "/api/integrations/discord/ops/resources",
  OPS_ECONOMY: "/api/integrations/discord/ops/economy",
  OPS_INVENTORY: "/api/integrations/discord/ops/inventory",
  OPS_LOCATION: "/api/integrations/discord/ops/location",
  OPS_SOC: "/api/integrations/discord/ops/soc",
  OPS_PROMETHEUS: "/api/integrations/discord/ops/prometheus",
  OPS_DASHBOARD: "/api/integrations/discord/ops/dashboard",
  PLAYERS_LINK: "/api/integrations/discord/players/link",
  PLAYERS_LINK_VERIFY: "/api/integrations/discord/players/link/verify",
  PLAYERS_UNLINK: "/api/integrations/discord/players/unlink",
  PLAYERS_ME: "/api/integrations/discord/players/me",
  PLAYERS_INVENTORY: "/api/integrations/discord/players/inventory",
  PLAYERS_STORAGE: "/api/integrations/discord/players/storage",
  PLAYERS_FIND: "/api/integrations/discord/players/find",
  PLAYERS_INVENTORY_SEARCH: "/api/integrations/discord/players/inventory-search",
  GUILD_STORAGE: "/api/integrations/discord/guilds/storage",
  GUILD_FIND: "/api/integrations/discord/guilds/find",
  VERSION: "/api/integrations/discord/version",
  SERVERS: "/api/integrations/discord/servers",
  PORTS: "/api/integrations/discord/ports",
  DB: "/api/integrations/discord/db",
  // CATALOG is deliberately NOT added to DISCORD_LIVE_ADAPTER_ROUTES below.
  // It is metadata ABOUT the live routes, not itself one of them -- adding
  // it there would require commandCatalog.js's COMMAND_METADATA to have an
  // entry describing itself, which is circular and not meaningful (a
  // catalog entry for "the catalog"). Its own liveness/auth is handled
  // directly by its route.js dispatch entry (bearer-token auth only, same
  // as HEALTH) rather than the capability/tier system, since it is
  // read-only metadata about route shape, not game or player data.
  CATALOG: "/api/integrations/discord/catalog"
});

export const DISCORD_LIVE_ADAPTER_ROUTES = Object.freeze([
  DISCORD_ADAPTER_ROUTES.HEALTH,
  DISCORD_ADAPTER_ROUTES.STATUS,
  DISCORD_ADAPTER_ROUTES.READINESS,
  DISCORD_ADAPTER_ROUTES.SERVICES,
  DISCORD_ADAPTER_ROUTES.POPULATION,
  DISCORD_ADAPTER_ROUTES.OPS_ACTIVITY,
  DISCORD_ADAPTER_ROUTES.OPS_COMBAT,
  DISCORD_ADAPTER_ROUTES.OPS_RESOURCES,
  DISCORD_ADAPTER_ROUTES.OPS_ECONOMY,
  DISCORD_ADAPTER_ROUTES.OPS_INVENTORY,
  DISCORD_ADAPTER_ROUTES.OPS_SOC,
  DISCORD_ADAPTER_ROUTES.OPS_PROMETHEUS,
  DISCORD_ADAPTER_ROUTES.LOGS,
  DISCORD_ADAPTER_ROUTES.MAP_STATE,
  DISCORD_ADAPTER_ROUTES.MAINTENANCE,
  DISCORD_ADAPTER_ROUTES.BACKUPS_LIST,
  DISCORD_ADAPTER_ROUTES.BROADCAST,
  DISCORD_ADAPTER_ROUTES.ANNOUNCEMENTS,
  DISCORD_ADAPTER_ROUTES.PLAYERS_LINK,
  DISCORD_ADAPTER_ROUTES.PLAYERS_LINK_VERIFY,
  DISCORD_ADAPTER_ROUTES.PLAYERS_UNLINK,
  DISCORD_ADAPTER_ROUTES.PLAYERS_ME,
  DISCORD_ADAPTER_ROUTES.PLAYERS_INVENTORY,
  DISCORD_ADAPTER_ROUTES.PLAYERS_STORAGE,
  DISCORD_ADAPTER_ROUTES.PLAYERS_FIND,
  DISCORD_ADAPTER_ROUTES.PLAYERS_INVENTORY_SEARCH,
  DISCORD_ADAPTER_ROUTES.GUILD_STORAGE,
  DISCORD_ADAPTER_ROUTES.GUILD_FIND,
  DISCORD_ADAPTER_ROUTES.VERSION,
  DISCORD_ADAPTER_ROUTES.SERVERS,
  DISCORD_ADAPTER_ROUTES.PORTS,
  DISCORD_ADAPTER_ROUTES.DB
]);

export const DISCORD_PLANNED_ADAPTER_ROUTES = Object.freeze(
  Object.values(DISCORD_ADAPTER_ROUTES).filter((route) => !DISCORD_LIVE_ADAPTER_ROUTES.includes(route))
);

export function discordAdapterEnabled(config) {
  return process.env.DUNE_DISCORD_ADAPTER_ENABLED === "true" || config?.discordAdapterEnabled === true;
}

export function discordWritesEnabled(config) {
  const value = process.env.DUNE_DISCORD_WRITES_ENABLED ?? config?.discordWritesEnabled;
  return value === true || value === 1 || /^(?:1|true)$/i.test(String(value || "").trim());
}

export function discordRoleMappingFromEnv(env = process.env) {
  return {
    // DISCORD_OBSERVER_ROLE_IDS is the pre-rename name -- read as a
    // fallback only, so an operator who already set it keeps working
    // across this update without a manual migration step (Requirement 0).
    // DISCORD_PLAYER_ROLE_IDS takes precedence whenever both are set.
    //
    // Audit finding #3 (HIGH): this must distinguish "key present but
    // explicitly empty" from "key genuinely absent" -- `||` treats an
    // empty string as falsy, so an operator who clears
    // DISCORD_PLAYER_ROLE_IDS (writes "") via the new Settings UI to
    // revoke access would otherwise silently fall through to a stale,
    // non-empty legacy DISCORD_OBSERVER_ROLE_IDS, believing access was
    // revoked when it wasn't.
    playerRoleIds: csv(env.DISCORD_PLAYER_ROLE_IDS !== undefined ? env.DISCORD_PLAYER_ROLE_IDS : env.DISCORD_OBSERVER_ROLE_IDS),
    moderatorRoleIds: csv(env.DISCORD_MODERATOR_ROLE_IDS),
    adminRoleIds: csv(env.DISCORD_ADMIN_ROLE_IDS),
    ownerRoleIds: csv(env.DISCORD_OWNER_ROLE_IDS)
  };
}

export function discordRolePolicyHealth(mapping = discordRoleMappingFromEnv()) {
  return {
    // dune-awakening-selfhost-docker#872 (automated review finding on
    // already-merged #748): playerConfigured is a rename of the field
    // this endpoint used to call observerConfigured. The equivalent
    // env-var rename (DISCORD_OBSERVER_ROLE_IDS -> DISCORD_PLAYER_ROLE_IDS)
    // correctly kept a legacy-fallback read, but this JSON field's own
    // rename shipped with no back-compat alias -- a real, documented
    // external contract break: docs/integrations/discord-control-bot/
    // admin-guide.md's own "Expected role policy shape" example and
    // 403-troubleshooting steps instruct checking
    // `rolePolicy.observerConfigured` directly, and that repo's own
    // smoke-runner-style consumers read this exact field. Emit both so
    // neither an old nor a new consumer silently misreads a
    // correctly-configured Player role as unconfigured.
    observerConfigured: mapping.playerRoleIds.length > 0,
    playerConfigured: mapping.playerRoleIds.length > 0,
    moderatorConfigured: mapping.moderatorRoleIds.length > 0,
    adminConfigured: mapping.adminRoleIds.length > 0,
    ownerConfigured: mapping.ownerRoleIds.length > 0
  };
}

export function validateDiscordActor(actorPayload) {
  return normalizeDiscordActor(actorPayload);
}

// Bumped only when the command-catalog contract itself changes in a way
// that could break an older bot's assumptions (e.g. a field is removed or
// its meaning changes) -- NOT bumped for ordinary route additions, which
// are additive and always safe for a bot that doesn't yet know about them.
// See commandCatalog.js and docs/rfc-command-discovery.md §3.4.
//
// Bumped 1 -> 2 alongside commandCatalog.js's own CATALOG_VERSION: a
// subcommand's `route` (a single string) became `routes` (an array),
// needed to correctly represent 3 (group, subcommand) pairs that
// genuinely fan out to two backing adapter routes each (upstream PR #171
// review). No live consumer exists yet to break (Phase 2/3 bot-side
// generator is still unimplemented), so this is forward hygiene per this
// comment's own stated policy, not a fix for an active breakage.
export const DISCORD_CATALOG_PROTOCOL_VERSION = 2;

export async function discordAdapterHealth(config) {
  return {
    ok: true,
    service: "dune-console-discord-adapter",
    enabled: discordAdapterEnabled(config),
    experimental: true,
    readOnly: false,
    gameDataWritesEnabled: false,
    adapterDataWrites: ["player-link"],
    writesEnabled: discordWritesEnabled(config),
    routes: DISCORD_LIVE_ADAPTER_ROUTES,
    liveRoutes: DISCORD_LIVE_ADAPTER_ROUTES,
    plannedRoutes: DISCORD_PLANNED_ADAPTER_ROUTES,
    rolePolicy: discordRolePolicyHealth(),
    protocolVersion: DISCORD_CATALOG_PROTOCOL_VERSION
  };
}

export async function discordAdapterStatus({ config, actorPayload, diagnostic = false, statusProvider }) {
  const actor = validateDiscordActor(actorPayload);
  const capability = diagnostic ? DISCORD_CAPABILITIES.LOGS_READ : DISCORD_CAPABILITIES.STATUS_READ;
  const mapping = discordRoleMappingFromEnv();
  requireDiscordCapability(actor, mapping, capability);

  try {
    const rawStatus = typeof statusProvider === "function" ? await statusProvider({ diagnostic }) : {};
    const result = diagnostic ? sanitizeDiscordValue(rawStatus) : sanitizeDiscordPublicStatus(rawStatus);
    audit(config, null, "discord.status", discordAuditEvent({
      actor,
      action: "discord.status",
      capability,
      risk: diagnostic ? "medium" : "low",
      targetType: "server",
      result: "success"
    }));
    return { ok: true, result };
  } catch (error) {
    audit(config, null, "discord.status", discordBlockedAuditEvent({
      actor,
      action: "discord.status",
      capability,
      reason: error.message || "status failed"
    }));
    throw error;
  }
}

export async function discordAdapterReadiness({ config, actorPayload, readinessProvider }) {
  return discordAdapterReadOnlyOperation({
    config,
    actorPayload,
    provider: readinessProvider,
    capability: DISCORD_CAPABILITIES.READINESS_READ,
    action: "discord.readiness",
    targetType: "server"
  });
}

export async function discordAdapterServices({ config, actorPayload, servicesProvider }) {
  return discordAdapterReadOnlyOperation({
    config,
    actorPayload,
    provider: servicesProvider,
    capability: DISCORD_CAPABILITIES.SERVICES_READ,
    action: "discord.services",
    targetType: "services"
  });
}

export async function discordAdapterPopulation({ config, actorPayload, populationProvider }) {
  return discordAdapterReadOnlyOperation({
    config,
    actorPayload,
    provider: populationProvider,
    capability: DISCORD_CAPABILITIES.POPULATION_READ,
    action: "discord.population",
    targetType: "population"
  });
}

async function discordAdapterReadOnlyOperation({ config, actorPayload, provider, capability, action, targetType }) {
  const actor = validateDiscordActor(actorPayload);
  const mapping = discordRoleMappingFromEnv();
  requireDiscordCapability(actor, mapping, capability);

  try {
    const rawResult = typeof provider === "function" ? await provider() : {};
    const result = sanitizeDiscordValue(rawResult);
    audit(config, null, action, discordAuditEvent({
      actor,
      action,
      capability,
      risk: "low",
      targetType,
      result: "success"
    }));
    return { ok: true, result };
  } catch (error) {
    audit(config, null, action, discordBlockedAuditEvent({
      actor,
      action,
      capability,
      reason: error.message || `${action} failed`
    }));
    throw error;
  }
}

export function discordAdapterErrorResponse(error) {
  const statusCode = Number(error?.statusCode || 500);
  return {
    statusCode: Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 500,
    body: discordSafeError(error)
  };
}

function csv(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}
