import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  discordAdapterEnabled, discordAdapterErrorResponse, discordAdapterHealth,
  discordAdapterPopulation, discordAdapterReadiness, discordAdapterServices,
  discordAdapterStatus, discordWritesEnabled, DISCORD_ADAPTER_ROUTES, DISCORD_PLANNED_ADAPTER_ROUTES,
  validateDiscordActor, discordRoleMappingFromEnv
} from "./adapter.js";
import { policyError, requireDiscordCapability, requireSelfScopedCapability, DISCORD_CAPABILITIES } from "./policy.js";
import { discordStatusProvider } from "./statusProvider.js";
import { discordReadinessProvider, discordServicesProvider } from "./readOnlyProviders.js";
import {
  opsActivityProvider, opsCombatProvider, opsResourcesProvider,
  opsEconomyProvider, opsInventoryProvider, opsLocationProvider,
  opsSocProvider, opsPrometheusProvider, opsDashboardProvider
} from "./opsProvider.js";
import {
  linkPlayerProvider,
  verifyPlayerLinkProvider,
  unlinkProvider,
  whoamiProvider,
  requireLinkedPlayer
} from "./linkProvider.js";
import {
  linkAccountProvider,
  verifyAccountLinkProvider,
  unlinkAccountProvider,
  listAccountsProvider,
  setDefaultAccountProvider
} from "./multiAccountLinkProvider.js";
import { verifyActorSignature } from "./actorSignature.js";
import {
  playerInventoryProvider,
  playerStorageProvider,
  itemSearchProvider,
  inventorySearchProvider
} from "./inventoryProvider.js";
import { broadcastProvider } from "./broadcastProvider.js";
import { buildDuneArgs, runDune } from "../../runner.js";
import { initializeDiscordAdapterSchema } from "./schema.js";

const INFRA_OPERATIONS = Object.freeze({
  SERVERS: { operation: "servers", timeoutMs: 15000, capability: DISCORD_CAPABILITIES.SERVICES_READ },
  PORTS: { operation: "ports", timeoutMs: 15000, capability: DISCORD_CAPABILITIES.SERVICES_READ },
  DB: { operation: "dbStatus", timeoutMs: 15000, capability: DISCORD_CAPABILITIES.SERVICES_READ }
});

async function handleSecureInfraRoute({ key, config, json, res, actor }) {
  const op = INFRA_OPERATIONS[key];
  if (!op) throw policyError("not_found", "Unsupported infrastructure operation.", 404);
  const mapping = discordRoleMappingFromEnv();
  requireDiscordCapability(actor, mapping, op.capability);
  const result = await runDune(config, buildDuneArgs(op.operation), {
    timeoutMs: op.timeoutMs,
    allowedExitCodes: [0]
  });
  return json(res, 200, {
    ok: true,
    operation: op.operation,
    result: { output: (result.stdout || "").slice(0, 4000) }
  });
}

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

export async function handleDiscordAdapterRoute({ req, res, path, config, readJson: readJsonBody, json, db, statusProvider, readinessProvider, servicesProvider, populationProvider }) {
  const safeStatusProvider = typeof statusProvider === "function" ? statusProvider : () => discordStatusProvider(config);
  const safeReadinessProvider = typeof readinessProvider === "function" ? readinessProvider : () => discordReadinessProvider(config);
  const safeServicesProvider = typeof servicesProvider === "function" ? servicesProvider : () => discordServicesProvider(config);
  const safePopulationProvider = typeof populationProvider === "function" ? populationProvider : () => defaultPopulationProvider(config);

  // Reads the JSON body for a Discord adapter POST route and, when
  // DUNE_DISCORD_ACTOR_SECRET is configured, verifies that body.actor
  // carries a valid HMAC signature before any route handler trusts
  // actor.userId/actor.roleIds. See actorSignature.js (FINDING-LINK-1).
  // No-ops (verification only, no behavior change) when no secret is
  // configured, preserving today's behavior for unmigrated bots.
  async function readJson(request) {
    const body = await readJsonBody(request);
    verifyActorSignature({ actorPayload: body?.actor, headers: request.headers, config, route: path });
    return body;
  }
  try {
    if (!discordAdapterEnabled(config)) throw policyError("adapter_disabled", "Discord adapter is disabled.", 404);
    requireDiscordBotToken(req, config);

    if (path.startsWith("/api/integrations/discord/players/") || path.startsWith("/api/integrations/discord/guilds/")) {
      if (!db) throw policyError("database_unavailable", "Discord player data is unavailable.", 503);
      await initializeDiscordAdapterSchema(db);
    }

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

    // OPS observability routes — wired to provider stubs
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

    const OPS_PROVIDERS = {
      [DISCORD_ADAPTER_ROUTES.OPS_ACTIVITY]: opsActivityProvider,
      [DISCORD_ADAPTER_ROUTES.OPS_COMBAT]: opsCombatProvider,
      [DISCORD_ADAPTER_ROUTES.OPS_RESOURCES]: opsResourcesProvider,
      [DISCORD_ADAPTER_ROUTES.OPS_ECONOMY]: opsEconomyProvider,
      [DISCORD_ADAPTER_ROUTES.OPS_INVENTORY]: opsInventoryProvider,
      [DISCORD_ADAPTER_ROUTES.OPS_LOCATION]: opsLocationProvider,
      [DISCORD_ADAPTER_ROUTES.OPS_SOC]: opsSocProvider,
      [DISCORD_ADAPTER_ROUTES.OPS_PROMETHEUS]: opsPrometheusProvider,
      [DISCORD_ADAPTER_ROUTES.OPS_DASHBOARD]: opsDashboardProvider,
    };

    if (OPS_PATHS.includes(path) && req.method === "POST") {
      const body = await readJson(req);
      const provider = OPS_PROVIDERS[path];
      if (provider) {
        return json(res, 200, await provider(config));
      }
      return json(res, 200, { ok: false, error: `OPS provider not found for: ${path}` });
    }

    // Broadcast route — gated behind write enablement, actor identity, and admin/owner capability.
    if (path === DISCORD_ADAPTER_ROUTES.BROADCAST && req.method === "POST") {
      if (!discordWritesEnabled(config)) throw policyError("writes_disabled", "Write operations are not enabled.", 403);
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      const mapping = discordRoleMappingFromEnv();
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.BROADCAST_SEND);
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

    const mapping = discordRoleMappingFromEnv();

    // Players link
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_LINK && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireSelfScopedCapability(actor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE);
      return json(res, 200, await linkPlayerProvider(db, config, {
        discordUserId: actor.userId,
        characterName: body.characterName
      }));
    }

    // Players link verify
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_LINK_VERIFY && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireSelfScopedCapability(actor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE);
      return json(res, 200, await verifyPlayerLinkProvider(db, {
        discordUserId: actor.userId,
        code: body.code
      }));
    }

    // Players unlink
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_UNLINK && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireSelfScopedCapability(actor, mapping, DISCORD_CAPABILITIES.PLAYER_LINK_WRITE);
      return json(res, 200, await unlinkProvider(db, {
        discordUserId: actor.userId
      }));
    }

    // Multi-account: link an additional character (FINDING-LINK-6).
    // Distinct from PLAYERS_LINK above: this is additive (a Discord user
    // may hold several linked characters at once) rather than overwrite,
    // and uses its own capability/rate limiter — see
    // multiAccountLinkProvider.js and docs/security/discord-player-link-hardening.md.
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_LINK && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireSelfScopedCapability(actor, mapping, DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE);
      return json(res, 200, await linkAccountProvider(db, config, {
        discordUserId: actor.userId,
        characterName: body.characterName
      }));
    }

    // Multi-account: verify a pending additional-account link
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_LINK_VERIFY && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireSelfScopedCapability(actor, mapping, DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE);
      return json(res, 200, await verifyAccountLinkProvider(db, {
        discordUserId: actor.userId,
        code: body.code
      }));
    }

    // Multi-account: unlink one additional character (does not affect the
    // legacy single-link flow's discord_player_links entry, if any).
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_UNLINK && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireSelfScopedCapability(actor, mapping, DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE);
      return json(res, 200, await unlinkAccountProvider(db, {
        discordUserId: actor.userId,
        playerControllerId: body.playerControllerId
      }));
    }

    // Multi-account: list all characters linked to the calling Discord user
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_LIST && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireSelfScopedCapability(actor, mapping, DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE);
      return json(res, 200, await listAccountsProvider(db, {
        discordUserId: actor.userId
      }));
    }

    // Multi-account: change which linked character is the default
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_ACCOUNTS_SET_DEFAULT && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireSelfScopedCapability(actor, mapping, DISCORD_CAPABILITIES.ACCOUNT_LINK_WRITE);
      return json(res, 200, await setDefaultAccountProvider(db, {
        discordUserId: actor.userId,
        playerControllerId: body.playerControllerId
      }));
    }

    // Players me
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_ME && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.INVENTORY_READ);
      return json(res, 200, await whoamiProvider(db, {
        discordUserId: actor.userId
      }));
    }

    // Players inventory
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_INVENTORY && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.INVENTORY_READ);
      const linked = await requireLinkedPlayer(db, actor.userId);
      return json(res, 200, await playerInventoryProvider(db, {
        playerPawnId: linked.player_pawn_id,
        characterName: linked.character_name
      }));
    }

    // Players storage
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_STORAGE && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.STORAGE_READ);
      const linked = await requireLinkedPlayer(db, actor.userId);
      const scope = body.scope || "owned";
      if (scope !== "owned" && scope !== "guild") {
        throw policyError("invalid_scope", 'Storage scope must be "owned" or "guild".');
      }
      return json(res, 200, await playerStorageProvider(db, {
        playerControllerId: linked.player_controller_id,
        scope
      }));
    }

    // Players find (item search in containers)
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_FIND && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.INVENTORY_READ);
      const linked = await requireLinkedPlayer(db, actor.userId);
      const scope = body.scope || "owned";
      if (scope !== "owned" && scope !== "guild") {
        throw policyError("invalid_scope", 'Search scope must be "owned" or "guild".');
      }
      return json(res, 200, await itemSearchProvider(db, {
        playerControllerId: linked.player_controller_id,
        query: body.query,
        scope
      }));
    }

    // Players inventory search
    if (path === DISCORD_ADAPTER_ROUTES.PLAYERS_INVENTORY_SEARCH && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.INVENTORY_READ);
      const linked = await requireLinkedPlayer(db, actor.userId);
      return json(res, 200, await inventorySearchProvider(db, {
        playerPawnId: linked.player_pawn_id,
        query: body.query
      }));
    }

    // Guild storage
    if (path === DISCORD_ADAPTER_ROUTES.GUILD_STORAGE && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.GUILD_READ);
      const linked = await requireLinkedPlayer(db, actor.userId);
      return json(res, 200, await playerStorageProvider(db, {
        playerControllerId: linked.player_controller_id,
        scope: "guild"
      }));
    }

    // Guild find (item search in guild containers)
    if (path === DISCORD_ADAPTER_ROUTES.GUILD_FIND && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      requireDiscordCapability(actor, mapping, DISCORD_CAPABILITIES.GUILD_READ);
      const linked = await requireLinkedPlayer(db, actor.userId);
      return json(res, 200, await itemSearchProvider(db, {
        playerControllerId: linked.player_controller_id,
        query: body.query,
        scope: "guild"
      }));
    }

    if (path === DISCORD_ADAPTER_ROUTES.SERVERS && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      return handleSecureInfraRoute({ key: "SERVERS", config, json, res, actor });
    }
    if (path === DISCORD_ADAPTER_ROUTES.PORTS && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      return handleSecureInfraRoute({ key: "PORTS", config, json, res, actor });
    }
    if (path === DISCORD_ADAPTER_ROUTES.DB && req.method === "POST") {
      const body = await readJson(req);
      const actor = validateDiscordActor(body.actor);
      return handleSecureInfraRoute({ key: "DB", config, json, res, actor });
    }

    if (path === DISCORD_ADAPTER_ROUTES.VERSION && req.method === "GET") {
      return json(res, 200, { ok: true, version: config.version || "dev" });
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
  const directToken = process.env.DUNE_DISCORD_ADAPTER_TOKEN || config?.discordAdapterToken || "";
  if (directToken) return String(directToken).trim();
  const tokenFile = process.env.DUNE_DISCORD_ADAPTER_TOKEN_FILE || process.env.DUNE_BOT_API_TOKEN_FILE || config?.discordAdapterTokenFile || config?.discordBotApiTokenFile || "";
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
