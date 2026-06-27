import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildDuneArgs, runDune } from "../runner.js";
import { redact, redactValue } from "../redact.js";

export const DISCORD_ADAPTER_ROUTES = Object.freeze({
  HEALTH: "/api/integrations/discord/health",
  STATUS: "/api/integrations/discord/status",
  READINESS: "/api/integrations/discord/readiness",
  SERVICES: "/api/integrations/discord/services"
});

const ROLE_TIERS = Object.freeze({
  public: 0,
  observer: 1,
  admin: 2
});

export function isDiscordAdapterRoute(path) {
  return Object.values(DISCORD_ADAPTER_ROUTES).includes(path);
}

export function discordAdapterEnabled(config = {}) {
  return process.env.DUNE_DISCORD_ADAPTER_ENABLED === "true" || config.discordAdapterEnabled === true;
}

export async function handleDiscordAdapterRoute({ req, res, path, config, readJson, json }) {
  try {
    if (!discordAdapterEnabled(config)) return json(res, 404, { ok: false, code: "adapter_disabled", error: "Discord adapter is disabled." });
    requireDiscordAdapterToken(req, config);

    if (path === DISCORD_ADAPTER_ROUTES.HEALTH && req.method === "GET") {
      return json(res, 200, discordHealthPayload(config));
    }

    if (path === DISCORD_ADAPTER_ROUTES.STATUS && req.method === "POST") {
      const body = await readJson(req).catch(() => ({}));
      const diagnostic = Boolean(body.diagnostic);
      requireDiscordCapability(body.actor, diagnostic ? "admin" : "public");
      return json(res, 200, await discordCommandPayload(config, "status", { diagnostic }));
    }

    if (path === DISCORD_ADAPTER_ROUTES.READINESS && req.method === "POST") {
      const body = await readJson(req).catch(() => ({}));
      requireDiscordCapability(body.actor, "observer");
      return json(res, 200, await discordCommandPayload(config, "readiness"));
    }

    if (path === DISCORD_ADAPTER_ROUTES.SERVICES && req.method === "POST") {
      const body = await readJson(req).catch(() => ({}));
      requireDiscordCapability(body.actor, "observer");
      return json(res, 200, await discordCommandPayload(config, "services"));
    }

    return json(res, 404, { error: "Discord adapter route not found." });
  } catch (error) {
    const statusCode = Number(error.statusCode || 500);
    return json(res, statusCode >= 400 && statusCode <= 599 ? statusCode : 500, discordSafeError(error));
  }
}

export function discordHealthPayload(config = {}) {
  return {
    ok: true,
    service: "dune-console-discord-adapter",
    enabled: discordAdapterEnabled(config),
    experimental: true,
    readOnly: true,
    writesEnabled: false,
    routes: Object.values(DISCORD_ADAPTER_ROUTES)
  };
}

export async function discordCommandPayload(config, operation, options = {}) {
  if (config.mockMode) {
    return {
      ok: true,
      operation,
      result: options.diagnostic ? { output: `Mock ${operation} output\n` } : { summary: { overall: "Mock" } }
    };
  }
  const result = await runDune(config, buildDuneArgs(operation));
  const output = redact(`${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`);
  return {
    ok: Number(result.code || 0) === 0,
    operation,
    exitCode: Number(result.code || 0),
    result: operation === "status" && !options.diagnostic
      ? { summary: publicStatusSummary(output) }
      : { output: trimDiscordOutput(output) }
  };
}

export function requireDiscordAdapterToken(req, config = {}) {
  const expected = readDiscordAdapterToken(config);
  if (!expected) throw discordError("adapter_token_not_configured", "Discord adapter token is not configured.", 503);
  const actual = bearerToken(req?.headers?.authorization || req?.headers?.Authorization || "");
  if (!actual) throw discordError("missing_adapter_token", "Missing Discord adapter bearer token.", 401);
  if (!constantTimeStringEqual(actual, expected)) throw discordError("invalid_adapter_token", "Invalid Discord adapter bearer token.", 401);
}

export function readDiscordAdapterToken(config = {}) {
  const direct = process.env.DUNE_DISCORD_ADAPTER_TOKEN || config.discordAdapterToken || "";
  if (direct) return String(direct).trim();
  const tokenFile = process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE || process.env.DUNE_BOT_API_TOKEN_FILE || config.discordAdapterTokenFile || "";
  if (!tokenFile) return "";
  try {
    return readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

export function requireDiscordCapability(actor, minimumTier) {
  const mapping = discordRoleMappingFromEnv();
  if (!mapping.hasConfiguredRoles) return;
  const tier = discordActorTier(actor, mapping);
  if (ROLE_TIERS[tier] < ROLE_TIERS[minimumTier]) {
    throw discordError("not_authorized", `Discord actor is not authorized for ${minimumTier} access.`, 403);
  }
}

export function discordRoleMappingFromEnv(env = process.env) {
  const observerRoleIds = csv(env.DISCORD_OBSERVER_ROLE_IDS);
  const adminRoleIds = [...csv(env.DISCORD_ADMIN_ROLE_IDS), ...csv(env.DISCORD_OWNER_ROLE_IDS)];
  return {
    observerRoleIds,
    adminRoleIds,
    hasConfiguredRoles: observerRoleIds.length > 0 || adminRoleIds.length > 0
  };
}

export function discordActorTier(actor, mapping = discordRoleMappingFromEnv()) {
  const roleIds = new Set(Array.isArray(actor?.roleIds) ? actor.roleIds.map((roleId) => String(roleId)) : csv(actor?.roleIds));
  if (mapping.adminRoleIds.some((roleId) => roleIds.has(roleId))) return "admin";
  if (mapping.observerRoleIds.some((roleId) => roleIds.has(roleId))) return "observer";
  return "public";
}

export function publicStatusSummary(output) {
  const values = parseStatusValues(output);
  return redactValue({
    overall: values.overall || "",
    title: values.title || "",
    region: values.region || "",
    mode: values.mode || "",
    population: values.population || "",
    battlegroup: values.battlegroup || "",
    automation: {
      autoscaler: values.autoscaler || "",
      autoUpdates: values.auto_updates || ""
    }
  });
}

function parseStatusValues(output) {
  const values = {};
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const match = rawLine.match(/^\s*([^:=]{2,80})\s*[:=]\s*(.+)$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase().replace(/\s+/g, "_");
    values[key] = match[2].trim();
  }
  return values;
}

function trimDiscordOutput(output) {
  const text = String(output || "").trim();
  if (text.length <= 12000) return text;
  return `${text.slice(0, 12000)}\n... output trimmed ...`;
}

function bearerToken(value) {
  const parts = String(value || "").trim().split(/\s+/);
  return parts.length === 2 && /^Bearer$/i.test(parts[0]) ? parts[1] : "";
}

function constantTimeStringEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual));
  const expectedBuffer = Buffer.from(String(expected));
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function discordSafeError(error) {
  return {
    ok: false,
    code: String(error.code || "discord_adapter_error"),
    error: redact(error.message || error)
  };
}

function discordError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function csv(value) {
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean).slice(0, 100);
}
