// Deny-by-default route allowlist for the `player` console tier (#1276).
//
// Operator contract: a `player` session sees only its own character, the
// bases/vehicles/storage it owns (permission rank 1, not co-owner or shared),
// and its guild including the roster. It never sees another player's
// information.
//
// This is a SECOND gate, applied after the IAM policy check in handleApi. The
// IAM policy alone is not enough: a stored policy file replaces the default
// player policy entirely, and several routes the default grants (`maps:read`,
// `players:read`, `server:read`) return fleet-wide data or host details. Every
// route listed here is either world data with no host or player detail, or is
// scoped to the caller inside its own handler or reduced by a view below. Being
// admitted does not make a route safe: /api/players/<id>/teleport-destinations
// passes the own-id check yet lists other players, which is why sub-resources
// are listed one by one. A route not listed is refused for the player tier, so
// adding a route elsewhere cannot silently expose it.
//
// Widening this list is a reviewed change: test/playerRouteAllowlist.test.js
// pins the exact set reachable by default.

const PLAYER_EXACT_GET_ROUTES = new Set([
  // Home: server health only. /api/server/status is reduced to a safe projection
  // (playerServerStatusView). /api/server/readiness and /api/map/status are NOT
  // here: they return raw CLI output / per-partition server ids and ports.
  "/api/server/status",
  "/api/server/performance",
  "/api/server/restart-history",
  // Own character and guild; the handlers scope these to the caller.
  "/api/players",
  "/api/players/online",
  "/api/players/search",
  "/api/guilds",
  // No /api/map/* routes: the player tier has no Live Map (operator decision,
  // #1276).
  // Owned assets: the handlers force the caller's own id and rank-1 access,
  // ignore any client-supplied filter and strip other players' names.
  "/api/bases",
  "/api/vehicles",
  "/api/storage",
]);

// /api/players/<id>[/<resource>] is admitted for these own-data resources only.
// The handlers check the id is the caller's own (requireOwnPlayerAccess), but
// that proves the id, not that the payload is own-scoped: teleport-destinations
// lists every other player and base owner in the partition, so it is excluded,
// as are ban and character-recovery (operator tools). A new resource is denied
// until it is added here on purpose.
const PLAYER_OWN_RESOURCES = new Set([
  "crafting-recipes", "research-items", "building-unlocks", "customizations", "journey",
  "inventory", "vehicles", "bases", "currency", "solaris-coin", "factions", "intel",
  "specs", "position", "progression", "vitals", "events", "stats", "history",
]);
// First segments that are routes of their own, not player ids.
const PLAYER_PATH_RESERVED_SEGMENTS = new Set([
  "deleted-characters",
  "list-settings",
  "online",
  "search",
  "kick-all-online",
]);

const PLAYER_ID_PREFIX = "/api/players/";
const GUILD_ROSTER_PATH = /^\/api\/guilds\/[^/]+\/members$/;

export function playerMayCall(method, path) {
  if (typeof method !== "string" || typeof path !== "string") return false;
  if (method.toUpperCase() !== "GET") return false;
  if (PLAYER_EXACT_GET_ROUTES.has(path)) return true;
  if (GUILD_ROSTER_PATH.test(path)) return true;
  if (path.startsWith(PLAYER_ID_PREFIX)) {
    const [id, resource, ...rest] = path.slice(PLAYER_ID_PREFIX.length).split("/");
    if (id === "" || PLAYER_PATH_RESERVED_SEGMENTS.has(id) || rest.length > 0) return false;
    return resource === undefined || PLAYER_OWN_RESOURCES.has(resource);
  }
  return false;
}

// Bases and vehicles list rows carry `shared_with`: the names and ranks of every
// other player with access. A player may see the assets they own, never who
// else is on them (#1276).
//
// The same view also drops what is not the caller's: totalVehicles is a count
// over every vehicle on the server, and a failed query's `reason` carries raw
// database error text.
//
// `owner` is the rank-1 holder's name, which for a vehicle re-permissioned to
// someone else is another player; every row the caller sees is theirs, so it is
// shown as "You".
export function redactSharedWith(result) {
  if (!result) return result;
  const out = { ...result };
  if (Array.isArray(result.rows)) {
    out.rows = result.rows.map((row) => {
      const next = { ...row, shared_with: [] };
      for (const key of ["owner", "owner_name"]) if (key in next) next[key] = "You";
      return next;
    });
  }
  if ("totalVehicles" in out) out.totalVehicles = Number(out.totalCount) || 0;
  if ("reason" in out) out.reason = "This list is unavailable right now.";
  return out;
}

// Guild roster for a player: names and roles only, not internal controller ids.
export function guildRosterForSession(session, result) {
  if (session?.tier !== "player" || !result || !Array.isArray(result.rows)) return result;
  return { ...result, rows: result.rows.map((m) => ({ character_name: m?.character_name ?? "", role_id: m?.role_id ?? "" })) };
}

// Pawn actor id of the session's linked character, or null when it is not a
// positive safe integer (unlinked, or the "0" getLinkedPlayer falls back to).
export function ownPawnId(linked) {
  const id = Number(linked?.player_pawn_id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Options for duneDb.listBases / listVehicles for a player session. Everything
// the client could use to widen the scope (playerId, access) is fixed here;
// only paging, sort and search pass through, and page size is capped.
export function ownedListOptions(linked, query) {
  const playerId = ownPawnId(linked);
  if (playerId === null) return null;
  const size = Number(query?.pageSize);
  return {
    playerId,
    access: "owner",
    q: typeof query?.q === "string" ? query.q : "",
    page: query?.page ?? 0,
    includeGenerators: false,
    pageSize: Number.isSafeInteger(size) && size >= 1 && size <= 200 ? size : 50,
    // shared_with would order the caller's rows by how many other players have access.
    sortColumn: query?.sortColumn && query.sortColumn !== "shared_with" ? query.sortColumn : "name",
    sortDirection: query?.sortDirection || "asc",
    ...(query?.status ? { status: query.status } : {}),
  };
}

// /api/server/status for a player: overall state, title, region, mode,
// population and the per-map game server states. Everything else the CLI prints
// (raw stdout, server ip, battlegroup id, container names, listener ports,
// RabbitMQ and FLS details) is dropped.
export function playerServerStatusView(body) {
  const data = body?.data || {};
  const summary = data.summary || {};
  return {
    schemaVersion: body?.schemaVersion ?? 1,
    ok: body?.ok === true,
    data: {
      summary: { overall: summary.overall ?? null, title: summary.title ?? null, region: summary.region ?? null, mode: summary.mode ?? null, population: summary.population ?? null },
      gameServers: Array.isArray(data.gameServers) ? data.gameServers.map((g) => ({ map: g?.map ?? null, status: g?.status ?? null, uptime: g?.uptime ?? null })) : [],
    },
  };
}

// Body of GET /api/bases | /api/vehicles | /api/storage for a `player` session.
// Dependencies are injected so the whole handler runs under test against a real
// database without a running server. `notLinked` is returned (not thrown) for an
// unlinked character; a linked one whose pawn id is not a positive integer gets `notSpawned` instead.
export async function playerOwnedAssetsBody({ duneDb, db, session, path, query, linkInstructions }) {
  const linked = await duneDb.getLinkedPlayer(db, session.userId);
  const options = ownedListOptions(linked, query);
  if (!linked) {
    return { capabilities: {}, totalCount: 0, rows: [], notLinked: true, reason: linkInstructions.reason, linkInstructions };
  }
  // Linked, but no spawned character yet (pawn id missing or "0"): linking again would not help.
  if (!options) {
    return { capabilities: {}, totalCount: 0, rows: [], notSpawned: true, reason: "Your character hasn't entered the world yet, so there is nothing to list." };
  }
  if (path === "/api/storage") return redactSharedWith(await duneDb.listOwnedStorage(db, linked.player_controller_id));
  const result = path === "/api/bases" ? await duneDb.listBases(db, options) : await duneDb.listVehicles(db, options);
  return redactSharedWith(result);
}

// The `access` filter for /api/players/<id>/bases|vehicles: a player always gets
// owner-only, whatever the query asked for; other tiers keep the requested value.
export function effectiveAccess(session, requested) {
  return session?.tier === "player" ? "owner" : requested;
}

// Player-tier view of a bases/vehicles list; other tiers get the result untouched.
export function ownedViewForSession(session, result) {
  return session?.tier === "player" ? redactSharedWith(result) : result;
}

// Status body for a session: players get the reduced projection.
export function statusBodyForSession(session, body) {
  return session?.tier === "player" ? playerServerStatusView(body) : body;
}
