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
  BACKUPS_LIST: "/api/integrations/discord/backups/list"
});

export const DISCORD_LIVE_ADAPTER_ROUTES = Object.freeze([
  DISCORD_ADAPTER_ROUTES.HEALTH,
  DISCORD_ADAPTER_ROUTES.STATUS,
  DISCORD_ADAPTER_ROUTES.READINESS,
  DISCORD_ADAPTER_ROUTES.SERVICES
]);

export const DISCORD_PLANNED_ADAPTER_ROUTES = Object.freeze(
  Object.values(DISCORD_ADAPTER_ROUTES).filter((route) => !DISCORD_LIVE_ADAPTER_ROUTES.includes(route))
);

export function discordAdapterEnabled(config) {
  return process.env.DUNE_DISCORD_ADAPTER_ENABLED === "true" || config?.discordAdapterEnabled === true;
}

export function discordWritesEnabled(_config) {
  // Experimental companion bot is intentionally read-only.
  return false;
}

export function discordRoleMappingFromEnv(env = process.env) {
  return {
    observerRoleIds: csv(env.DISCORD_OBSERVER_ROLE_IDS),
    moderatorRoleIds: csv(env.DISCORD_MODERATOR_ROLE_IDS),
    adminRoleIds: csv(env.DISCORD_ADMIN_ROLE_IDS),
    ownerRoleIds: csv(env.DISCORD_OWNER_ROLE_IDS)
  };
}

export function discordRolePolicyHealth(mapping = discordRoleMappingFromEnv()) {
  return {
    observerConfigured: mapping.observerRoleIds.length > 0,
    moderatorConfigured: mapping.moderatorRoleIds.length > 0,
    adminConfigured: mapping.adminRoleIds.length > 0,
    ownerConfigured: mapping.ownerRoleIds.length > 0
  };
}

export function validateDiscordActor(actorPayload) {
  return normalizeDiscordActor(actorPayload);
}

export async function discordAdapterHealth(config) {
  return {
    ok: true,
    service: "dune-console-discord-adapter",
    enabled: discordAdapterEnabled(config),
    experimental: true,
    readOnly: true,
    writesEnabled: false,
    routes: DISCORD_LIVE_ADAPTER_ROUTES,
    liveRoutes: DISCORD_LIVE_ADAPTER_ROUTES,
    plannedRoutes: DISCORD_PLANNED_ADAPTER_ROUTES,
    rolePolicy: discordRolePolicyHealth()
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
