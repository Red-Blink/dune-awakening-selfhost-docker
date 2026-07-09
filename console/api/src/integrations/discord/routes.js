import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  discordAdapterEnabled, discordAdapterErrorResponse, discordAdapterHealth,
  discordAdapterPopulation, discordAdapterReadiness, discordAdapterServices,
  discordAdapterStatus, DISCORD_ADAPTER_ROUTES, DISCORD_PLANNED_ADAPTER_ROUTES
} from "./adapter.js";
import { policyError } from "./policy.js";
import { discordStatusProvider } from "./statusProvider.js";
import { discordReadinessProvider, discordServicesProvider } from "./readOnlyProviders.js";
import { broadcastProvider } from "./broadcastProvider.js";

async function defaultPopulationProvider(config) {
  try {
    const status = await discordStatusProvider(config);
    const population = status?.population;
    if (population !== undefined) return parsePopulationValue(population);

    // Fallback: scan raw status for population-like fields
    if (status && typeof status === "object") {
      for (const [key, val] of Object.entries(status)) {
        if (/pop/i.test(key) && typeof val === "string") {
          return parsePopulationValue(val);
        }
        if (typeof val === "object" && val !== null) {
          for (const [k2, v2] of Object.entries(val)) {
            if (/pop/i.test(k2) && typeof v2 === "string") {
              return parsePopulationValue(v2);
            }
          }
        }
      }
    }
    return { onlinePlayers: "unknown", totalPlayers: "unknown", aggregate: true, detailsSuppressed: true };
  } catch {
    return { onlinePlayers: "unknown", totalPlayers: "unknown", aggregate: true, detailsSuppressed: true };
  }
}

function parsePopulationValue(value = "") {
  const text = String(value).trim();
  const match = text.match(/(\d+)\s*\/?\s*(\d+)/);
  if (match) return { onlinePlayers: Number(match[1]), totalPlayers: match[2] ? Number(match[2]) : 0, aggregate: true, detailsSuppressed: true };
  const num = Number(text);
  if (Number.isFinite(num)) return { onlinePlayers: num, totalPlayers: 0, aggregate: true, detailsSuppressed: true };
  return { onlinePlayers: "unknown", totalPlayers: "unknown", aggregate: true, detailsSuppressed: true };
}

export function isDiscordAdapterRoute(path) {
  return Object.values(DISCORD_ADAPTER_ROUTES).includes(path);
}

export async function handleDiscordAdapterRoute({ req, res, path, config, readJson, json, statusProvider, readinessProvider, servicesProvider, populationProvider }) {
  const safeStatusProvider = typeof statusProvider === "function" ? statusProvider : () => discordStatusProvider(config);
  const safeReadinessProvider = typeof readinessProvider === "function" ? readinessProvider : () => discordReadinessProvider(config);
  const safeServicesProvider = typeof servicesProvider === "function" ? servicesProvider : () => discordServicesProvider(config);
  const safePopulationProvider = typeof populationProvider === "function" ? populationProvider : () => defaultPopulationProvider(config);
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
        statusProvider: safeStatusProvider
      }));
    }

    if (path === DISCORD_ADAPTER_ROUTES.READINESS && req.method === "POST") {
      const body = await readJson(req);
      return json(res, 200, await discordAdapterReadiness({
        config,
        actorPayload: body.actor,
        readinessProvider: safeReadinessProvider
      }));
    }

    if (path === DISCORD_ADAPTER_ROUTES.SERVICES && req.method === "POST") {
      const body = await readJson(req);
      return json(res, 200, await discordAdapterServices({
        config,
        actorPayload: body.actor,
        servicesProvider: safeServicesProvider
      }));
    }

    if (path === DISCORD_ADAPTER_ROUTES.POPULATION && req.method === "POST") {
      const body = await readJson(req);
      return json(res, 200, await discordAdapterPopulation({
        config,
        actorPayload: body.actor,
        populationProvider: safePopulationProvider
      }));
    }

    // OPS observability routes (planned — bridge integration pending)
    const OPS_PATHS = [
      DISCORD_ADAPTER_ROUTES.OPS_ACTIVITY,
      DISCORD_ADAPTER_ROUTES.OPS_COMBAT,
      DISCORD_ADAPTER_ROUTES.OPS_RESOURCES,
      DISCORD_ADAPTER_ROUTES.OPS_ECONOMY,
      DISCORD_ADAPTER_ROUTES.OPS_INVENTORY,
      DISCORD_ADAPTER_ROUTES.OPS_LOCATION,
      DISCORD_ADAPTER_ROUTES.OPS_SOC,
      DISCORD_ADAPTER_ROUTES.OPS_PROMETHEUS,
      DISCORD_ADAPTER_ROUTES.OPS_DASHBOARD
    ];

    if (OPS_PATHS.includes(path) && req.method === "POST") {
      const body = await readJson(req);
      return json(res, 200, {
        ok: true,
        status: "planned",
        route: path,
        message: "OPS observability route is planned. Bridge integration pending. See yacketrj/dune-ops-observability-addon.",
        actor: body.actor ? { userId: body.actor.userId } : null
      });
    }

    // Broadcast route — sends message to in-game players
    if (path === DISCORD_ADAPTER_ROUTES.BROADCAST && req.method === "POST") {
      const body = await readJson(req);
      const result = await broadcastProvider(config, { message: body.message });
      return json(res, 200, result);
    }

    // Announcements route
    if (path === DISCORD_ADAPTER_ROUTES.ANNOUNCEMENTS && req.method === "POST") {
      const body = await readJson(req);
      return json(res, 200, {
        ok: true,
        status: "planned",
        route: path,
        announcements: [],
        message: "Announcements route is planned. Requires game server event bridge."
      });
    }

    // Backups route — returns metadata from dune db list
    if (path === DISCORD_ADAPTER_ROUTES.BACKUPS_LIST && req.method === "GET") {
      return json(res, 200, {
        ok: true,
        route: path,
        backups: [],
        message: "Backups route is planned. Requires dune db list integration."
      });
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
