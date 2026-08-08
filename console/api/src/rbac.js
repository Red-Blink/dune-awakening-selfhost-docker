// Console RBAC Phase 4 — server-side role-based access control.
//
// Defines the tier ladder, capability catalog, and route-to-capability
// assignment for the web console. The capability assignments are the single
// source of truth — the UI mirrors them but the server enforces them
// authoritatively (tests prove it).

// ---- Tier ladder ----

export const TIER_RANK = {
  observer: 0,
  player: 0,
  moderator: 1,
  admin: 2,
  owner: 3,
};

// ---- Capabilities ----

export const CAPABILITIES = {
  STATUS_READ: "STATUS_READ",
  WORLD_READ: "WORLD_READ",
  WORLD_WRITE: "WORLD_WRITE",
  LOGS_READ: "LOGS_READ",
  BACKUPS_READ: "BACKUPS_READ",
  BACKUPS_WRITE: "BACKUPS_WRITE",
  DATABASE_READ: "DATABASE_READ",
  DATABASE_WRITE: "DATABASE_WRITE",
  UPDATES_READ: "UPDATES_READ",
  UPDATES_WRITE: "UPDATES_WRITE",
  SERVER_CONTROL: "SERVER_CONTROL",
  SETTINGS_WRITE: "SETTINGS_WRITE",
  ADDONS_READ: "ADDONS_READ",
  ADDONS_WRITE: "ADDONS_WRITE",
  ADMIN_TOOLS: "ADMIN_TOOLS",
  CARE_PACKAGE_GRANT: "CARE_PACKAGE_GRANT",
  PLAYER_MUTATE: "PLAYER_MUTATE",
  MAP_WRITE: "MAP_WRITE",
};

export const CAPABILITY_BY_TIER = {
  owner: Object.values(CAPABILITIES),
  admin: [
    CAPABILITIES.STATUS_READ,
    CAPABILITIES.WORLD_READ,
    CAPABILITIES.WORLD_WRITE,
    CAPABILITIES.LOGS_READ,
    CAPABILITIES.BACKUPS_READ,
    CAPABILITIES.BACKUPS_WRITE,
    CAPABILITIES.DATABASE_READ,
    CAPABILITIES.UPDATES_READ,
    CAPABILITIES.UPDATES_WRITE,
    CAPABILITIES.SERVER_CONTROL,
    CAPABILITIES.ADDONS_READ,
    CAPABILITIES.ADDONS_WRITE,
    CAPABILITIES.ADMIN_TOOLS,
    CAPABILITIES.CARE_PACKAGE_GRANT,
    CAPABILITIES.PLAYER_MUTATE,
    CAPABILITIES.MAP_WRITE,
  ],
  moderator: [
    CAPABILITIES.STATUS_READ,
    CAPABILITIES.WORLD_READ,
    CAPABILITIES.WORLD_WRITE,
    CAPABILITIES.LOGS_READ,
    CAPABILITIES.ADMIN_TOOLS,
    CAPABILITIES.PLAYER_MUTATE,
    CAPABILITIES.MAP_WRITE,
  ],
  player: [
    CAPABILITIES.STATUS_READ,
    CAPABILITIES.WORLD_READ,
  ],
  observer: [
    CAPABILITIES.STATUS_READ,
    CAPABILITIES.WORLD_READ,
  ],
};

// ---- Session tier resolution ----

export function resolveSessionTier(session) {
  if (!session) return "";
  const tier = typeof session.tier === "string" ? session.tier : "";
  if (!TIER_RANK.hasOwnProperty(tier)) return "";
  return tier;
}

export function sessionTierRank(session) {
  const tier = resolveSessionTier(session);
  return tier ? TIER_RANK[tier] : -1;
}

// ---- Capability check ----

export function requireConsoleCapability(session, capability) {
  if (session && session.tier === "owner") return true;
  if (!capability) return true;
  const tier = resolveSessionTier(session);
  if (!tier) return false;
  return CAPABILITY_BY_TIER[tier]?.includes(capability) || false;
}

export function capabilitiesForTier(tier) {
  if (!tier || !TIER_RANK.hasOwnProperty(tier)) return [];
  return CAPABILITY_BY_TIER[tier] || [];
}

// ---- Route-to-capability assignment ----
//
// Updated 2026-08-07: revised capability ladder per operator feedback.
//
// Owner:   18/18 — full access (unchanged).
// Admin:   16/18 — operations: server control, map write, player mutate,
//          world write, care package grants, backups write, updates write,
//          addons write, admin tools, log/db/backup/update reads.
//          Excluded: SETTINGS_WRITE, DATABASE_WRITE.
// Mod:      7/18 — community management: player mutate (kick/give water),
//          world write (refill bases, manage guilds/storage), map write
//          (restart maps), admin tools (broadcast), logs read, status/read.
// Player:   2/18 — read-only: STATUS_READ + WORLD_READ.
//
// Tab visibility: Owner 16/16, Admin 15/16 (no Settings), Mod 9/16,
// Player 7/16.
//
// Ordered list of [path pattern, method, capability] where the first
// matching entry wins. Patterns use exact-match first, then regex.
// `null` capability means the route is public (no auth gate — already
// handled before the capability check in server.js).
//
// The ordering mirrors the server.js handleApi if/else chain: more
// specific paths must come before prefix matches, and regex-based
// routes (`<id>` segments) must be checked per-request.

const PUBLIC_ROUTES = new Set([
  "GET /api/health",
  "GET /api/auth/state",
  "POST /api/auth/login",
  "POST /api/auth/logout",
  "GET /api/auth/me",
  "GET /api/auth/discord/start",
  "GET /api/auth/discord/callback",
  "POST /api/auth/discord/exchange",
  "GET /api/auth/discord/error",
]);

const DISCORD_ADAPTER_PREFIX = "/api/integrations/discord/";

// Static path→capability lookup for exact paths (without :id segments)
const EXACT_ROUTES = {
  "GET /api/setup/state": CAPABILITIES.STATUS_READ,
  "POST /api/setup/preflight": CAPABILITIES.SERVER_CONTROL,
  "POST /api/setup/write-config": CAPABILITIES.SETTINGS_WRITE,
  "POST /api/setup/save-token": CAPABILITIES.SERVER_CONTROL,
  "POST /api/setup/init": CAPABILITIES.SERVER_CONTROL,
  "GET /api/setup/tasks": CAPABILITIES.STATUS_READ,
  "GET /api/public-directory/status": CAPABILITIES.STATUS_READ,

  "GET /api/server/status": CAPABILITIES.STATUS_READ,
  "GET /api/server/performance": CAPABILITIES.STATUS_READ,
  "GET /api/server/readiness": CAPABILITIES.STATUS_READ,
  "GET /api/server/ports": CAPABILITIES.STATUS_READ,
  "GET /api/server/services": CAPABILITIES.STATUS_READ,
  "GET /api/server/doctor": CAPABILITIES.STATUS_READ,
  "POST /api/server/network-bind/fix": CAPABILITIES.SERVER_CONTROL,
  "POST /api/server/storage/cleanup-images": CAPABILITIES.SERVER_CONTROL,
  "POST /api/server/storage/cleanup-build-cache": CAPABILITIES.SERVER_CONTROL,
  "POST /api/server/start": CAPABILITIES.SERVER_CONTROL,
  "POST /api/server/stop": CAPABILITIES.SERVER_CONTROL,
  "POST /api/server/restart": CAPABILITIES.SERVER_CONTROL,
  "POST /api/server/restart-service": CAPABILITIES.SERVER_CONTROL,
  "POST /api/server/funcom-token": CAPABILITIES.SERVER_CONTROL,
  "GET /api/server/funcom-token/check": CAPABILITIES.STATUS_READ,
  "POST /api/server/title": CAPABILITIES.SERVER_CONTROL,
  "POST /api/server/config": CAPABILITIES.SERVER_CONTROL,
  "POST /api/server/restart-schedule": CAPABILITIES.SERVER_CONTROL,
  "GET /api/server/restart-schedule": CAPABILITIES.STATUS_READ,
  "POST /api/server/ip-change-restart": CAPABILITIES.SERVER_CONTROL,
  "POST /api/server/ip-change-restart/check": CAPABILITIES.SERVER_CONTROL,
  "GET /api/server/ip-change-restart": CAPABILITIES.STATUS_READ,
  "POST /api/server/shutdown-protection": CAPABILITIES.SERVER_CONTROL,
  "POST /api/server/shutdown-protection/remove": CAPABILITIES.SERVER_CONTROL,
  "GET /api/server/shutdown-protection": CAPABILITIES.STATUS_READ,

  "GET /api/logs/services": CAPABILITIES.LOGS_READ,

  "POST /api/updates/check-game": CAPABILITIES.UPDATES_WRITE,
  "POST /api/updates/apply-game": CAPABILITIES.UPDATES_WRITE,
  "POST /api/updates/fix-steamcmd": CAPABILITIES.UPDATES_WRITE,
  "POST /api/updates/check-stack": CAPABILITIES.UPDATES_WRITE,
  "POST /api/updates/apply-stack": CAPABILITIES.UPDATES_WRITE,
  "POST /api/updates/auto-game": CAPABILITIES.UPDATES_WRITE,
  "GET /api/updates/auto-game": CAPABILITIES.UPDATES_READ,
  "POST /api/updates/repair-runtime": CAPABILITIES.UPDATES_WRITE,

  "GET /api/backups": CAPABILITIES.BACKUPS_READ,
  "POST /api/backups/auto": CAPABILITIES.BACKUPS_WRITE,
  "POST /api/backups/import-external": CAPABILITIES.BACKUPS_WRITE,
  "GET /api/backups/auto": CAPABILITIES.BACKUPS_READ,
  "POST /api/backups/create": CAPABILITIES.BACKUPS_WRITE,
  "POST /api/backups/delete-all": CAPABILITIES.BACKUPS_WRITE,
  "POST /api/backups/restore": CAPABILITIES.BACKUPS_WRITE,

  "GET /api/database/status": CAPABILITIES.DATABASE_READ,
  "GET /api/database/schemas": CAPABILITIES.DATABASE_READ,
  "GET /api/database/routines": CAPABILITIES.DATABASE_READ,
  "GET /api/database/tables": CAPABILITIES.DATABASE_READ,
  "GET /api/database/search": CAPABILITIES.DATABASE_READ,
  "POST /api/database/query": CAPABILITIES.DATABASE_WRITE,
  "POST /api/database/export": CAPABILITIES.DATABASE_READ,
  "POST /api/database/password": CAPABILITIES.DATABASE_WRITE,

  "POST /api/settings/admin-password": CAPABILITIES.SETTINGS_WRITE,
  "POST /api/settings/web-port": CAPABILITIES.SETTINGS_WRITE,
  "POST /api/settings/public-directory": CAPABILITIES.SETTINGS_WRITE,
  "POST /api/settings/public-directory/claim": CAPABILITIES.SETTINGS_WRITE,
  "POST /api/settings": CAPABILITIES.SETTINGS_WRITE,
  "GET /api/settings": CAPABILITIES.STATUS_READ,

  "GET /api/players": CAPABILITIES.WORLD_READ,
  "GET /api/players/online": CAPABILITIES.WORLD_READ,
  "GET /api/players/search": CAPABILITIES.WORLD_READ,
  "POST /api/players/kick-all-online": CAPABILITIES.PLAYER_MUTATE,

  "GET /api/guilds": CAPABILITIES.WORLD_READ,

  "GET /api/bases": CAPABILITIES.WORLD_READ,
  "GET /api/bases/pending-refills": CAPABILITIES.WORLD_READ,
  "GET /api/bases/auto-refill": CAPABILITIES.WORLD_READ,
  "GET /api/bases/pending-water-refills": CAPABILITIES.WORLD_READ,
  "GET /api/bases/auto-refill-water": CAPABILITIES.WORLD_READ,
  "GET /api/bases/permission-candidates": CAPABILITIES.WORLD_READ,

  "GET /api/admin/items/catalog": CAPABILITIES.ADMIN_TOOLS,
  "GET /api/admin/items/search": CAPABILITIES.ADMIN_TOOLS,
  "GET /api/admin/items": CAPABILITIES.ADMIN_TOOLS,
  "GET /api/admin/vehicles/structured": CAPABILITIES.ADMIN_TOOLS,
  "GET /api/admin/vehicles": CAPABILITIES.ADMIN_TOOLS,
  "GET /api/admin/skill-modules": CAPABILITIES.ADMIN_TOOLS,
  "GET /api/admin/history": CAPABILITIES.ADMIN_TOOLS,
  "POST /api/admin/history/clear": CAPABILITIES.ADMIN_TOOLS,
  "GET /api/admin/character-transfer-settings": CAPABILITIES.ADMIN_TOOLS,
  "POST /api/admin/character-transfer-settings": CAPABILITIES.ADMIN_TOOLS,
  "GET /api/admin/message-of-the-day": CAPABILITIES.ADMIN_TOOLS,
  "POST /api/admin/message-of-the-day": CAPABILITIES.ADMIN_TOOLS,
  "GET /api/admin/player-announcements": CAPABILITIES.ADMIN_TOOLS,
  "POST /api/admin/player-announcements": CAPABILITIES.ADMIN_TOOLS,
  "GET /api/admin/landsraad": CAPABILITIES.WORLD_READ,
  "POST /api/admin/landsraad": CAPABILITIES.ADMIN_TOOLS,
  "POST /api/admin/landsraad/task-goal": CAPABILITIES.ADMIN_TOOLS,
  "POST /api/admin/landsraad/term-task-goals": CAPABILITIES.ADMIN_TOOLS,
  "GET /api/admin/landsraad/milestone-preset": CAPABILITIES.ADMIN_TOOLS,
  "POST /api/admin/landsraad/milestone-preset": CAPABILITIES.ADMIN_TOOLS,
  "POST /api/admin/landsraad/reward-tier": CAPABILITIES.ADMIN_TOOLS,
  "POST /api/admin/landsraad/player-contribution": CAPABILITIES.ADMIN_TOOLS,
  "POST /api/admin/broadcast": CAPABILITIES.ADMIN_TOOLS,
  "POST /api/admin/map-chat": CAPABILITIES.ADMIN_TOOLS,
  "POST /api/admin/broadcast-shutdown": CAPABILITIES.ADMIN_TOOLS,

  "GET /api/addons/community": CAPABILITIES.ADDONS_READ,
  "GET /api/addons/installed": CAPABILITIES.ADDONS_READ,
  "POST /api/addons/community/install": CAPABILITIES.ADDONS_WRITE,
  "POST /api/addons/community/update": CAPABILITIES.ADDONS_WRITE,

  "GET /api/storage": CAPABILITIES.WORLD_READ,

  "GET /api/blueprints": CAPABILITIES.WORLD_READ,
  "POST /api/blueprints/export": CAPABILITIES.WORLD_READ,
  "POST /api/blueprints/import": CAPABILITIES.WORLD_WRITE,

  "GET /api/care-package/capabilities": CAPABILITIES.ADMIN_TOOLS,
  "POST /api/care-package/config": CAPABILITIES.CARE_PACKAGE_GRANT,
  "GET /api/care-package/config": CAPABILITIES.ADMIN_TOOLS,
  "POST /api/care-package/history/clear": CAPABILITIES.CARE_PACKAGE_GRANT,
  "GET /api/care-package/grants": CAPABILITIES.ADMIN_TOOLS,
  "GET /api/care-package/history": CAPABILITIES.ADMIN_TOOLS,
  "GET /api/care-package/eligible": CAPABILITIES.ADMIN_TOOLS,
  "POST /api/care-package/grant-eligible": CAPABILITIES.CARE_PACKAGE_GRANT,
  "POST /api/care-package/run": CAPABILITIES.CARE_PACKAGE_GRANT,
  "POST /api/care-package/enable": CAPABILITIES.CARE_PACKAGE_GRANT,
  "POST /api/care-package/disable": CAPABILITIES.CARE_PACKAGE_GRANT,

  "GET /api/map/status": CAPABILITIES.WORLD_READ,
  "GET /api/map/capabilities": CAPABILITIES.WORLD_READ,
  "POST /api/map/teleport-player": CAPABILITIES.WORLD_WRITE,
  "GET /api/map/partitions": CAPABILITIES.WORLD_READ,
  "GET /api/map/markers": CAPABILITIES.WORLD_READ,
  "GET /api/map/players": CAPABILITIES.WORLD_READ,
  "GET /api/map/bases": CAPABILITIES.WORLD_READ,
  "GET /api/map/storage": CAPABILITIES.WORLD_READ,
  "GET /api/map/services": CAPABILITIES.WORLD_READ,
  "GET /api/map/overlays": CAPABILITIES.WORLD_READ,
  "POST /api/maps/mode": CAPABILITIES.MAP_WRITE,
  "POST /api/maps/settings": CAPABILITIES.MAP_WRITE,
  "POST /api/maps/runtime-settings": CAPABILITIES.MAP_WRITE,
  "GET /api/maps/runtime-settings": CAPABILITIES.WORLD_READ,
  "GET /api/maps": CAPABILITIES.WORLD_READ,
  "GET /api/maps/mode": CAPABILITIES.WORLD_READ,
  "POST /api/maps/reconcile": CAPABILITIES.MAP_WRITE,
  "POST /api/maps/spawn": CAPABILITIES.MAP_WRITE,
  "POST /api/maps/despawn": CAPABILITIES.MAP_WRITE,
  "POST /api/maps/respawn": CAPABILITIES.MAP_WRITE,
  "POST /api/maps/autoscaler": CAPABILITIES.MAP_WRITE,
  "GET /api/maps/autoscaler": CAPABILITIES.WORLD_READ,
  "POST /api/maps/memory": CAPABILITIES.MAP_WRITE,
  "POST /api/maps/memory/balancer": CAPABILITIES.MAP_WRITE,
  "GET /api/maps/memory/balancer": CAPABILITIES.WORLD_READ,
  "POST /api/maps/memory/swap": CAPABILITIES.MAP_WRITE,
  "GET /api/maps/memory/swap": CAPABILITIES.WORLD_READ,
  "GET /api/maps/memory/live": CAPABILITIES.WORLD_READ,
  "GET /api/maps/memory": CAPABILITIES.WORLD_READ,
  "GET /api/maps/spicefields": CAPABILITIES.WORLD_READ,
  "GET /api/maps/combat-state": CAPABILITIES.WORLD_READ,
  "POST /api/maps/choam-terminals": CAPABILITIES.MAP_WRITE,
  "DELETE /api/maps/choam-terminals": CAPABILITIES.MAP_WRITE,
  "GET /api/maps/choam-terminals": CAPABILITIES.WORLD_READ,
  "GET /api/maps/user-settings/schema": CAPABILITIES.WORLD_READ,
  "GET /api/maps/user-settings/restart-pending": CAPABILITIES.WORLD_READ,
  "GET /api/maps/user-settings/values": CAPABILITIES.WORLD_READ,
  "POST /api/maps/user-settings/raw": CAPABILITIES.MAP_WRITE,
  "GET /api/maps/user-settings/raw": CAPABILITIES.WORLD_READ,
  "POST /api/maps/user-settings/save": CAPABILITIES.MAP_WRITE,
  "POST /api/maps/user-settings/reset": CAPABILITIES.MAP_WRITE,
  "GET /api/maps/userengine": CAPABILITIES.WORLD_READ,
  "GET /api/maps/usergame": CAPABILITIES.WORLD_READ,
  "POST /api/maps/user-settings/materialize": CAPABILITIES.MAP_WRITE,

  "GET /api/sietches": CAPABILITIES.WORLD_READ,
  "GET /api/sietches/dimensions": CAPABILITIES.WORLD_READ,
  "POST /api/sietches/update": CAPABILITIES.MAP_WRITE,

  "GET /api/deepdesert": CAPABILITIES.WORLD_READ,
  "POST /api/deepdesert/update": CAPABILITIES.MAP_WRITE,
};

// Regex-based segment patterns (checked after exact match fails)
const REGEX_ROUTES = [
  // Logs service prefix
  ["/api/logs/", "GET", CAPABILITIES.LOGS_READ],

  // Database parameterized
  ["/api/database/routines/", "GET", CAPABILITIES.DATABASE_READ],
  ["/api/database/tables/", "GET", CAPABILITIES.DATABASE_READ],
  ["/api/database/tables/", "PATCH", CAPABILITIES.DATABASE_WRITE],
  ["/api/database/table/", "GET", CAPABILITIES.DATABASE_READ],

  // Blueprints parameterized
  ["/api/blueprints/", "GET", CAPABILITIES.WORLD_READ],
  ["/api/blueprints/", "DELETE", CAPABILITIES.WORLD_WRITE],

  // Storage parameterized (id + subpaths)
  ["/api/storage/", "GET", CAPABILITIES.WORLD_READ],
  ["/api/storage/", "POST", CAPABILITIES.WORLD_WRITE],

  // Bases parameterized
  ["/api/bases/", "GET", CAPABILITIES.WORLD_READ],
  ["/api/bases/", "POST", CAPABILITIES.WORLD_WRITE],
  ["/api/bases/", "DELETE", CAPABILITIES.WORLD_WRITE],
  ["/api/bases/", "PUT", CAPABILITIES.WORLD_WRITE],

  // Guilds parameterized
  ["/api/guilds/", "GET", CAPABILITIES.WORLD_READ],
  ["/api/guilds/", "POST", CAPABILITIES.WORLD_WRITE],
  ["/api/guilds/", "DELETE", CAPABILITIES.WORLD_WRITE],

  // Players parameterized (GET = read, mutations = PLAYER_MUTATE)
  ["/api/players/", "GET", CAPABILITIES.WORLD_READ],
  ["/api/players/", "POST", CAPABILITIES.PLAYER_MUTATE],
  ["/api/players/", "DELETE", CAPABILITIES.PLAYER_MUTATE],
  ["/api/players/", "PATCH", CAPABILITIES.PLAYER_MUTATE],

  // Addons parameterized
  ["/api/addons/", "GET", CAPABILITIES.ADDONS_READ],
  ["/api/addons/", "POST", CAPABILITIES.ADDONS_WRITE],
  ["/api/addons/", "DELETE", CAPABILITIES.ADDONS_WRITE],

  // Backups parameterized (name/download + delete)
  ["/api/backups/", "GET", CAPABILITIES.BACKUPS_READ],
  ["/api/backups/", "DELETE", CAPABILITIES.BACKUPS_WRITE],

  // Maps parameterized (spicefields/:id PATCH)
  ["/api/maps/spicefields/", "PATCH", CAPABILITIES.MAP_WRITE],

  // Care package parameterized (grant/:playerId, retry/:grantId)
  ["/api/care-package/grant/", "POST", CAPABILITIES.CARE_PACKAGE_GRANT],
  ["/api/care-package/retry/", "POST", CAPABILITIES.CARE_PACKAGE_GRANT],

  // Setup tasks/:id
  ["/api/setup/tasks/", "GET", CAPABILITIES.STATUS_READ],
];

const BOT_READ_STUB = new Set(["ADMIN_READ", "ADMIN_WRITE"]);

export function capabilityForRoute(path, method) {
  if (!path || !method) return null;

  const routeMethod = typeof method === "string" ? method.toUpperCase() : String(method || "");

  // Discord adapter routes are handled by the bot's own authorization
  if (path.startsWith(DISCORD_ADAPTER_PREFIX)) return BOT_READ_STUB;

  const exactKey = `${routeMethod} ${path}`;
  if (PUBLIC_ROUTES.has(exactKey)) return null;

  if (EXACT_ROUTES.hasOwnProperty(exactKey)) return EXACT_ROUTES[exactKey];

  // Regex/parameterized route matching (order matters)
  for (const [prefix, capMethod, cap] of REGEX_ROUTES) {
    if (path.startsWith(prefix) && routeMethod === capMethod) {
      return cap;
    }
  }

  // Logs route with service name (matches /api/logs/anything)
  if (path.startsWith("/api/logs/") && routeMethod === "GET") return CAPABILITIES.LOGS_READ;

  // Default: allow owner-tier (already checked via requireConsoleCapability),
  // deny other tiers by returning ADMIN_TOOLS as a high-capability default.
  // Unknown routes should never reach this point in practice.
  return CAPABILITIES.SERVER_CONTROL;
}
