import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { discordAdapterEnabled, discordAdapterErrorResponse, discordAdapterHealth, discordAdapterReadiness, discordAdapterServices, discordAdapterStatus, DISCORD_ADAPTER_ROUTES } from "./adapter.js";
import { policyError } from "./policy.js";

export function isDiscordAdapterRoute(path) {
  return Object.values(DISCORD_ADAPTER_ROUTES).includes(path);
}

export async function handleDiscordAdapterRoute({ req, res, path, config, readJson, json, statusProvider, readinessProvider, servicesProvider }) {
  try {
    if (!discordAdapterEnabled(config)) throw policyError("adapter_disabled", "Discord adapter is disabled.", 404);
    requireDiscordBotToken(req, config);

    if (path === DISCORD_ADAPTER_ROUTES.HEALTH && req.method === "GET") {
      return json(res, 200, await discordAdapterHealth(config));
    }

    if (path === DISCORD_ADAPTER_ROUTES.STATUS && req.method === "POST") {
      const body = await readJson(req);
      return json(res, 200, await discordAdapterStatus({
        config,
        actorPayload: body.actor,
        diagnostic: Boolean(body.diagnostic),
        statusProvider
      }));
    }

    if (path === DISCORD_ADAPTER_ROUTES.READINESS && req.method === "POST") {
      const body = await readJson(req);
      return json(res, 200, await discordAdapterReadiness({
        config,
        actorPayload: body.actor,
        readinessProvider
      }));
    }

    if (path === DISCORD_ADAPTER_ROUTES.SERVICES && req.method === "POST") {
      const body = await readJson(req);
      return json(res, 200, await discordAdapterServices({
        config,
        actorPayload: body.actor,
        servicesProvider
      }));
    }

    throw policyError("not_found", "Discord adapter route not found.", 404);
  } catch (error) {
    const response = discordAdapterErrorResponse(error);
    return json(res, response.statusCode, response.body);
  }
}

export function requireDiscordBotToken(req, config) {
  const expected = readDiscordBotApiToken(config);
  if (!expected) throw policyError("bot_token_not_configured", "Adapter credential is not configured.", 503);

  const actual = bearerToken(req?.headers?.authorization || req?.headers?.Authorization || "");
  if (!actual) throw policyError("missing_bot_token", "Missing adapter credential.", 401);
  if (!constantTimeStringEqual(actual, expected)) throw policyError("invalid_bot_token", "Invalid adapter credential.", 401);
}

export function readDiscordBotApiToken(config) {
  const tokenFile = process.env.DUNE_BOT_API_TOKEN_FILE || config?.discordBotApiTokenFile || "";
  if (!tokenFile) return "";
  try {
    return readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

function bearerToken(value) {
  const parts = String(value || "").split(/\s+/);
  return parts.length === 2 && /^Bearer$/i.test(parts[0]) ? parts[1].trim() : "";
}

function constantTimeStringEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual));
  const expectedBuffer = Buffer.from(String(expected));
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
