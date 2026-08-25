// Console IAM — Action catalog with 1:1 route-to-action mapping.
//
// Every console route that requires authorization maps to exactly one
// action in this catalog. Routes that are always public (health, auth
// state, login/logout, Discord OAuth) do NOT appear here — they are
// handled before the authorization gate in server.js.
//
// The catalog is the single source of truth for what permissions exist.
// The IAM policy engine and the UI editor both read from this catalog
// to know what actions can be granted or denied.
//
// Naming convention: namespace:action-name (e.g. "players:kick",
// "bases:refill-generators", "server:restart")
//
// ---- WHEN ADDING A NEW ROUTE IN server.js (hard requirement) ----
//
// 1. If the route requires authorization: add it to ROUTE_ACTIONS below
//    in the same commit. Follow the existing "METHOD /path": "ns:action"
//    format exactly — one line, alphabetically grouped by namespace.
//
// 2. If the route is always public (no IAM action needed): add the EXACT
//    path to the PUBLIC_EXACT array in test/rbacParity.test.js. The
//    parity test statically extracts every route from server.js and
//    asserts 100% coverage — a missing entry is a hard test failure.
//
// 3. Verify: `node --test test/rbacParity.test.js` must pass before push.
//    This gate enforces the requirement mechanically.

// ---- Namespaces ----

export const NAMESPACES = {
  SETUP:       "setup",
  SERVER:      "server",
  LOGS:        "logs",
  BACKUPS:     "backups",
  DATABASE:    "database",
  UPDATES:     "updates",
  SETTINGS:    "settings",
  PLAYERS:     "players",
  GUILDS:      "guilds",
  BASES:       "bases",
  MAPS:        "maps",
  SIETCHES:    "sietches",
  DEEPDESERT:  "deepdesert",
  ADMIN:       "admin",
  LANDSRAAD:   "landsraad",
  ADDONS:      "addons",
  CAREPACKAGE: "carepackage",
  STORAGE:     "storage",
  BLUEPRINTS:  "blueprints",
  VEHICLES:    "vehicles",
  EXCHANGE:    "exchange",
};

// ---- Actions: route → action mapping ----
//
// Format: { "METHOD /path": "namespace:action" }
// Routes with parameterized segments (e.g. /players/:id/...) use the
// literal path pattern from server.js; the policy engine matches
// against the normalized path.

export const ROUTE_ACTIONS = {
  // --- Setup ---
  "GET /api/setup/state":                      "setup:read",
  "GET /api/setup/tasks":                      "setup:read",
  "POST /api/setup/preflight":                 "setup:write",
  "POST /api/setup/write-config":              "setup:write",
  "POST /api/setup/write-oauth-config":        "setup:write",
  "POST /api/setup/save-oauth-secret":         "setup:write",
  "POST /api/setup/save-token":                "setup:write",
  "POST /api/setup/init":                      "setup:write",
  "GET /api/public-directory/status":          "setup:read",

  // --- Server ---
  "GET /api/server/status":                    "server:read",
  "GET /api/server/performance":               "server:read",
  "GET /api/server/readiness":                 "server:read",
  "GET /api/server/ports":                     "server:read",
  "GET /api/server/services":                  "server:read",
  "GET /api/server/doctor":                    "server:read",
  "GET /api/server/funcom-token/check":        "server:read",
  "GET /api/server/restart-schedule":          "server:read",
  "GET /api/server/ip-change-restart":         "server:read",
  "GET /api/server/shutdown-protection":       "server:read",
  "GET /api/server/restart-queue":             "server:read",
  "POST /api/server/start":                    "server:start",
  "POST /api/server/stop":                     "server:stop",
  "POST /api/server/restart":                  "server:restart",
  "POST /api/server/restart-service":          "server:restart-service",
  "POST /api/server/restart-queue/cancel":     "server:restart",
  "POST /api/server/restart-queue/restart-now":"server:restart",
  "POST /api/server/network-bind/fix":         "server:network-fix",
  "POST /api/server/storage/cleanup-images":   "server:storage-cleanup",
  "POST /api/server/storage/cleanup-build-cache":"server:storage-cleanup",
  "POST /api/server/funcom-token":             "server:write-config",
  "POST /api/server/title":                    "server:write-config",
  "POST /api/server/config":                   "server:write-config",
  "POST /api/server/restart-schedule":         "server:write-config",
  "POST /api/server/ip-change-restart":        "server:write-config",
  "POST /api/server/ip-change-restart/check":  "server:write-config",
  "POST /api/server/shutdown-protection":      "server:write-config",
  "POST /api/server/shutdown-protection/remove":"server:write-config",
  "POST /api/server/restart-queue":            "server:write-config",

  // --- Logs ---
  "GET /api/logs/services":                    "logs:read",

  // --- Backups ---
  "GET /api/backups":                          "backups:read",
  "GET /api/backups/auto":                     "backups:read",
  "POST /api/backups/create":                  "backups:create",
  "POST /api/backups/restore":                 "backups:restore",
  "POST /api/backups/auto":                    "backups:write-config",
  "POST /api/backups/delete-all":              "backups:delete",
  "POST /api/backups/import-external":         "backups:import",

  // --- Database ---
  "GET /api/database/status":                  "database:read",
  "GET /api/database/schemas":                 "database:read",
  "GET /api/database/routines":                "database:read",
  "GET /api/database/tables":                  "database:read",
  "GET /api/database/search":                  "database:read",
  "POST /api/database/query":                  "database:query",
  "POST /api/database/export":                 "database:export",
  "POST /api/database/password":               "database:write-config",

  // --- Updates ---
  "GET /api/updates/auto-game":                "updates:read",
  "POST /api/updates/check-game":              "updates:check",
  "POST /api/updates/apply-game":              "updates:apply",
  "POST /api/updates/fix-steamcmd":            "updates:fix",
  "POST /api/updates/check-stack":             "updates:check",
  "POST /api/updates/apply-stack":             "updates:apply",
  "GET /api/updates/qa/status":                "updates:read",
  "POST /api/updates/qa/login":                "updates:apply",
  "POST /api/updates/qa/logout":               "updates:apply",
  "GET /api/updates/qa/build":                 "updates:read",
  "POST /api/updates/qa/apply":                "updates:apply",
  "POST /api/updates/qa/reinstall-release":    "updates:apply",
  "GET /api/updates/stack-progress":            "updates:read",
  "POST /api/updates/auto-game":               "updates:write-config",
  "POST /api/updates/repair-runtime":          "updates:repair",

  // --- Settings ---
  "GET /api/settings":                         "settings:read",
  "POST /api/settings":                        "settings:write",
  "POST /api/settings/admin-password":         "settings:change-password",
  "POST /api/settings/web-port":               "settings:change-port",
  "GET /api/settings/iam/policies":            "settings:read",
  "PUT /api/settings/iam/policy":              "settings:write",
  "POST /api/settings/iam/policy/test":        "settings:read",
  "POST /api/settings/public-directory":       "settings:write",
  "POST /api/settings/public-directory/claim": "settings:write",

  // --- Players (read) ---
  "GET /api/players":                          "players:read",
  "GET /api/players/online":                   "players:read",
  "GET /api/players/search":                   "players:read",

  // --- Vehicles ---
  "GET /api/vehicles":                         "vehicles:read",
  "GET /api/vehicles/permission-candidates":   "vehicles:read",

  // --- Exchange (Market Board) — read-only board + console-local filter config ---
  "GET /api/exchange/items":                   "exchange:read",
  "GET /api/exchange/listings":                "exchange:read",
  "GET /api/exchange/stats":                   "exchange:read",
  "GET /api/exchange/transactions":            "exchange:read",
  "GET /api/exchange/config":                  "exchange:read",
  "POST /api/exchange/config":                 "exchange:write-config",

  // --- Exchange Market Bot — console-managed NPC seeding / buyback (game-DB writes) ---
  "GET /api/exchange/market":                  "exchange:market",
  "GET /api/exchange/market/exchanges":        "exchange:market",
  "GET /api/exchange/market/buyback/log":      "exchange:market",
  "POST /api/exchange/market/buyback/probe":   "exchange:market",
  "POST /api/exchange/market/buyback/log":     "exchange:market-write",
  "POST /api/exchange/market/buyback/log/clear": "exchange:market-write",
  "POST /api/exchange/market/buyback/schedule": "exchange:market-write",
  "POST /api/exchange/market/seed/schedule":   "exchange:market-write",
  "POST /api/exchange/market/buyback/run":     "exchange:market-write",
  "POST /api/exchange/market/seed/run":        "exchange:market-write",
  "POST /api/exchange/market/seed/clear":      "exchange:market-write",
  "GET /api/exchange/market/plans/csv":        "exchange:market",
  "POST /api/exchange/market/plans/csv":       "exchange:market-write",
  "POST /api/exchange/market/plans/active":    "exchange:market-write",
  "POST /api/exchange/market/plans/name":      "exchange:market-write",
  "GET /api/exchange/market/items":            "exchange:market",
  "GET /api/exchange/market/items/catalog":    "exchange:market",
  "POST /api/exchange/market/items":           "exchange:market-write",

  // --- Players (mutations) ---
  "POST /api/players/kick-all-online":         "players:kick-all",

  // --- Guilds (read) ---
  "GET /api/guilds":                           "guilds:read",

  // --- Bases (read) ---
  "GET /api/bases":                            "bases:read",
  "GET /api/bases/pending-refills":            "bases:read",
  "GET /api/bases/auto-refill":                "bases:read",
  "GET /api/bases/pending-water-refills":      "bases:read",
  "GET /api/bases/auto-refill-water":          "bases:read",
  "GET /api/bases/permission-candidates":      "bases:read",
  "GET /api/bases/pending-deletes":            "bases:read",

  // --- Storage (read) ---
  "GET /api/storage":                          "storage:read",

  // --- Blueprints (read) ---
  "GET /api/blueprints":                       "blueprints:read",

  // --- Admin Tools ---
  "GET /api/admin/items/catalog":              "admin:items:read",
  "GET /api/admin/items/search":               "admin:items:read",
  "GET /api/admin/items":                      "admin:items:read",
  "GET /api/admin/vehicles/structured":        "admin:vehicles:read",
  "GET /api/admin/vehicles":                   "admin:vehicles:read",
  "GET /api/admin/skill-modules":              "admin:skills:read",
  "GET /api/admin/history":                    "admin:history:read",
  "GET /api/admin/character-transfer-settings": "admin:transfer-settings:read",
  "GET /api/admin/message-of-the-day":         "admin:motd:read",
  "GET /api/admin/player-announcements":       "admin:announcements:read",
  "GET /api/admin/map-chat-schedules":         "admin:map-chat",
  "POST /api/admin/history/clear":             "admin:history:clear",
  "POST /api/admin/character-transfer-settings":"admin:transfer-settings:write",
  "POST /api/admin/message-of-the-day":        "admin:motd:write",
  "POST /api/admin/player-announcements":      "admin:announcements:write",
  "POST /api/admin/broadcast":                 "admin:broadcast",
  "POST /api/admin/map-chat":                  "admin:map-chat",
  "POST /api/admin/map-chat-schedules":        "admin:map-chat",
  "POST /api/admin/broadcast-shutdown":        "admin:broadcast-shutdown",

  // --- Landsraad ---
  "GET /api/admin/landsraad":                  "landsraad:read",
  "POST /api/admin/landsraad":                 "landsraad:write",
  "POST /api/admin/landsraad/task-goal":       "landsraad:write",
  "POST /api/admin/landsraad/term-task-goals": "landsraad:write",
  "GET /api/admin/landsraad/milestone-preset": "landsraad:read",
  "POST /api/admin/landsraad/milestone-preset":"landsraad:write",
  "POST /api/admin/landsraad/reward-tier":     "landsraad:write",
  "POST /api/admin/landsraad/player-contribution":"landsraad:write",

  // --- Addons ---
  "GET /api/addons/community":                 "addons:read",
  "GET /api/addons/installed":                 "addons:read",
  "POST /api/addons/community/install":        "addons:install",
  "POST /api/addons/community/update":         "addons:update",

  // --- Care Package ---
  "GET /api/care-package/capabilities":        "carepackage:read",
  "GET /api/care-package/config":              "carepackage:read",
  "GET /api/care-package/grants":              "carepackage:read",
  "GET /api/care-package/history":             "carepackage:read",
  "GET /api/care-package/eligible":            "carepackage:read",
  "POST /api/care-package/config":             "carepackage:write-config",
  "POST /api/care-package/history/clear":      "carepackage:clear-history",
  "POST /api/care-package/grant-eligible":     "carepackage:grant",
  "POST /api/care-package/run":                "carepackage:scan",
  "POST /api/care-package/enable":             "carepackage:write-config",
  "POST /api/care-package/disable":            "carepackage:write-config",

  // --- Map (Live Map) ---
  "GET /api/map/status":                       "maps:read",
  "GET /api/map/capabilities":                 "maps:read",
  "GET /api/map/partitions":                   "maps:read",
  "GET /api/map/markers":                      "maps:read",
  "GET /api/map/players":                      "maps:read",
  "GET /api/map/bases":                        "maps:read",
  "GET /api/map/storage":                      "maps:read",
  "GET /api/map/services":                     "maps:read",
  "GET /api/map/spice":                        "maps:read",
  "GET /api/map/poi":                          "maps:read",
  "GET /api/map/overlays":                     "maps:read",
  "POST /api/map/teleport-player":             "maps:teleport",

  // --- Maps ---
  "GET /api/maps":                             "maps:read",
  "GET /api/maps/mode":                        "maps:read",
  "GET /api/maps/runtime-settings":            "maps:read",
  "GET /api/maps/autoscaler":                  "maps:read",
  "GET /api/maps/memory":                      "maps:read",
  "GET /api/maps/memory/live":                 "maps:read",
  "GET /api/maps/memory/swap":                 "maps:read",
  "GET /api/maps/memory/balancer":             "maps:read",
  "GET /api/maps/spicefields":                 "maps:read",
  "GET /api/maps/combat-state":                "maps:read",
  "GET /api/maps/choam-terminals":             "maps:read",
  "GET /api/maps/user-settings/schema":        "maps:read",
  "GET /api/maps/user-settings/restart-pending":"maps:read",
  "GET /api/maps/user-settings/deferred-pending":"maps:read",
  "GET /api/maps/user-settings/values":        "maps:read",
  "GET /api/maps/user-settings/raw":           "maps:read",
  "GET /api/maps/userengine":                  "maps:read",
  "GET /api/maps/usergame":                    "maps:read",
  "POST /api/maps/spawn":                      "maps:spawn",
  "POST /api/maps/despawn":                    "maps:despawn",
  "POST /api/maps/respawn":                    "maps:restart",
  "POST /api/maps/settings":                   "maps:write-config",
  "POST /api/maps/mode":                       "maps:write-config",
  "POST /api/maps/runtime-settings":           "maps:write-config",
  "POST /api/maps/memory":                     "maps:write-config",
  "POST /api/maps/memory/swap":                "maps:write-config",
  "POST /api/maps/memory/balancer":            "maps:write-config",
  "POST /api/maps/autoscaler":                 "maps:write-config",
  "POST /api/maps/reconcile":                  "maps:reconcile",
  "POST /api/maps/user-settings/save":         "maps:write-config",
  "POST /api/maps/user-settings/reset":        "maps:write-config",
  "POST /api/maps/user-settings/raw":          "maps:write-config",
  "POST /api/maps/user-settings/materialize":  "maps:write-config",
  "POST /api/maps/choam-terminals":            "maps:write-config",
  "DELETE /api/maps/choam-terminals":          "maps:write-config",

  // --- Sietches ---
  "GET /api/sietches":                         "sietches:read",
  "GET /api/sietches/dimensions":              "sietches:read",
  "POST /api/sietches/update":                 "sietches:write",

  // --- Deep Desert ---
  "GET /api/deepdesert":                       "deepdesert:read",
  "POST /api/deepdesert/update":               "deepdesert:write",
};

// ---- Regex / parameterized route mappings ----
//
// For routes with dynamic segments (e.g. /players/:id/kick),
// the policy engine checks these prefix patterns. Order matters —
// more specific patterns must come first.

export const REGEX_ACTIONS = [
  // Setup tasks
  ["/api/setup/tasks/", "setup:read"],

  // Logs
  ["/api/logs/", "logs:read"],

  // Database (parameterized)
  ["/api/database/routines/", "database:read"],
  ["/api/database/tables/", "database:read"],
  ["/api/database/table/", "database:read"],

  // Backups (parameterized)
  ["/api/backups/", "backups:read"],

  // Players (parameterized) — ordered: mutations before reads
  ["/api/players/", "players:read"],

  // Guilds (parameterized)
  ["/api/guilds/", "guilds:read"],

  // Bases (parameterized)
  ["/api/bases/", "bases:read"],

  // Vehicles (parameterized)
  ["/api/vehicles/", "vehicles:read"],

  // Storage (parameterized)
  ["/api/storage/", "storage:read"],

  // Blueprints (parameterized)
  ["/api/blueprints/", "blueprints:read"],

  // Addons (parameterized)
  ["/api/addons/installed/", "addons:read"],

  // Care Package (parameterized)
  ["/api/care-package/grant/", "carepackage:grant"],
  ["/api/care-package/retry/", "carepackage:grant"],

  // Maps spicefields
  ["/api/maps/spicefields/", "maps:read"],
];

// ---- Method-aware regex patterns ----
//
// These check both method AND prefix. Used when the same path prefix
// has different actions depending on HTTP method.

export const REGEX_ACTIONS_BY_METHOD = {
  "POST /api/players/":    "players:mutate",
  "DELETE /api/players/":  "players:mutate",
  "PATCH /api/players/":   "players:mutate",

  "POST /api/guilds/":     "guilds:mutate",
  "DELETE /api/guilds/":   "guilds:mutate",

  "POST /api/bases/":      "bases:mutate",
  "DELETE /api/bases/":    "bases:mutate",
  "PUT /api/bases/":       "bases:mutate",

  "PUT /api/vehicles/":    "vehicles:mutate",

  "POST /api/storage/":    "storage:mutate",

  "POST /api/addons/":     "addons:mutate",
  "DELETE /api/addons/":   "addons:mutate",

  "PATCH /api/maps/spicefields/": "maps:write-config",

  "DELETE /api/backups/":  "backups:delete",

  "POST /api/blueprints/": "blueprints:mutate",
  "DELETE /api/blueprints/":"blueprints:mutate",

  "PATCH /api/database/tables/": "database:mutate",
};

// ---- Parameterized route actions (regex, not prefix) ----
//
// REGEX_ACTIONS_BY_METHOD only tests a startsWith prefix, which cannot tell
// "/api/bases/{id}" (the base itself) apart from "/api/bases/{id}/queued-
// delete" (a sub-resource under it) — both start with the same
// "/api/bases/" prefix, since the variable segment comes before, not after,
// the part that would distinguish them. Routes that need that distinction
// go here instead, tested as a real regex before the prefix fallback.
export const REGEX_ACTIONS_BY_METHOD_PATTERN = [
  // DELETE /api/bases/{baseId} — the actual, irreversible base delete.
  // Deliberately its own action rather than the shared bases:mutate bucket
  // every other base mutation uses (refills, permission edits, cancelling
  // a queued refill/delete) — those are all reversible; this is not, so an
  // operator's policy should be able to grant one without the other. Every
  // other bases DELETE route (queued-refill, queued-water-refill, queued-
  // delete — all cancellations) still falls through to the
  // "DELETE /api/bases/" prefix rule above, unaffected.
  { method: "DELETE", pattern: /^\/api\/bases\/[^/]+$/, action: "bases:delete" },
  // DELETE /api/bases/{baseId}/containers/{placeableId}/items/{itemId} —
  // destroying one stored item. Its own action for a different reason than
  // bases:delete above: not blast radius, but consent. Base inventory shipped
  // read-only, so an operator whose hand-authored policy grants bases:mutate
  // agreed to refills and permission edits and could not have agreed to item
  // destruction — folding this into that bucket would silently widen every
  // existing narrow policy. The shipped owner/admin policies grant bases:*,
  // so default access is unchanged.
  { method: "DELETE", pattern: /^\/api\/bases\/[^/]+\/containers\/[^/]+\/items\/[^/]+$/, action: "bases:delete-item" },
  // POST /api/bases/{baseId}/containers/{placeableId}/items — creating one
  // stored item. Own action for the same consent reason as bases:delete-item
  // above, read in the other direction: a bases:mutate grant predates any
  // ability to put items into a base at all, so it cannot be read as consent
  // to fabricate them. Note this entry is also what keeps the route off the
  // "POST /api/bases/" → bases:mutate prefix rule; without it the route would
  // resolve to bases:mutate silently rather than failing closed.
  { method: "POST", pattern: /^\/api\/bases\/[^/]+\/containers\/[^/]+\/items$/, action: "bases:add-item" },
  // DELETE /api/bases/{baseId}/containers/{placeableId}/items — deleting
  // several selected stacks in one call, and .../all-items — clearing every
  // item in the container. Same consent argument as bases:delete-item above,
  // same narrow action so a policy granting bases:delete-item does not
  // silently also grant bulk/delete-all destruction (and vice versa) without
  // being written that way on purpose.
  //
  // Named bases:bulk-delete-items rather than the more obvious
  // bases:delete-items deliberately (issue #351, found during PR #349's own
  // Layer 3 audit, Architect hat): policy.js's matchAction() supports a
  // "prefix-*" wildcard style where "bases:delete-item*" matches ANY action
  // starting with that string, including "bases:delete-items" -- so a
  // hand-authored policy using that wildcard style near bases:delete-item
  // (e.g. intending "just delete-item, with room to grow") would have
  // silently and non-obviously also granted bulk/delete-all destruction.
  // bases:bulk-delete-items shares no string prefix with bases:delete-item,
  // so no "-*" wildcard pattern can match both. No shipped default policy
  // used the old name (this action was still unreleased when found), so this
  // is a rename with zero migration impact, not a breaking change for any
  // operator's existing hand-authored policy.
  { method: "DELETE", pattern: /^\/api\/bases\/[^/]+\/containers\/[^/]+\/items$/, action: "bases:bulk-delete-items" },
  { method: "DELETE", pattern: /^\/api\/bases\/[^/]+\/containers\/[^/]+\/all-items$/, action: "bases:bulk-delete-items" },
  // POST /api/bases/{baseId}/containers/{placeableId}/give-item(s) and
  // fill-item — adding items to a Storage-group container. Own actions for
  // the same reason bases:delete-item is its own action: base inventory
  // shipped read-only, so bases:mutate (refills, permission edits) was never
  // agreed to cover item creation either. Kept separate from each other
  // (give-item vs fill-item) rather than one combined "bases:add-item" so a
  // policy author can grant/revoke them independently, even though, as of
  // 2026-08-19, Give and Fill are both restricted to the same
  // raw_resource/refined_resource/component groups (FILLABLE_GROUPS) --
  // Give previously accepted any catalog item, corrected after a real
  // catalog item ("Robe of the Sisterhood", clothing) showed up in the Give
  // combobox despite being out of scope for this feature.
  { method: "POST", pattern: /^\/api\/bases\/[^/]+\/containers\/[^/]+\/give-item$/, action: "bases:give-item" },
  { method: "POST", pattern: /^\/api\/bases\/[^/]+\/containers\/[^/]+\/give-items$/, action: "bases:give-item" },
  { method: "POST", pattern: /^\/api\/bases\/[^/]+\/containers\/[^/]+\/fill-item$/, action: "bases:fill-item" },
  // POST /api/vehicles/{vehicleId}/system-custodian — transfer to the reserved
  // Server/GM custodian. Unlike bases (which has a blanket "POST /api/bases/"
  // -> bases:mutate prefix rule that already covers its own system-custodian
  // route), REGEX_ACTIONS_BY_METHOD has no "POST /api/vehicles/" entry, so
  // without this line the route would fall through the method-aware tier
  // entirely and resolve via the method-agnostic REGEX_ACTIONS fallback
  // ("/api/vehicles/" -> vehicles:read) -- silently authorizing an ownership
  // transfer under a read-only grant. Named narrowly, rather than adding a
  // broad "POST /api/vehicles/" prefix rule, so any future POST vehicle route
  // still fails closed until it is deliberately added here.
  { method: "POST", pattern: /^\/api\/vehicles\/[^/]+\/system-custodian$/, action: "vehicles:mutate" }
];

// ---- Action resolution ----
//
// Returns the action string for a given route path and HTTP method.
// Returns null for public routes (no authorization needed).

export function actionForRoute(path, method) {
  if (!path || !method) return null;
  const routeMethod = typeof method === "string" ? method.toUpperCase() : String(method || "");
  const exactKey = `${routeMethod} ${path}`;

  // Exact match
  if (ROUTE_ACTIONS.hasOwnProperty(exactKey)) return ROUTE_ACTIONS[exactKey];

  // Parameterized pattern match (checked before the prefix fallback below,
  // so a route needing a real regex to distinguish itself from a sibling
  // sub-resource wins over the coarser startsWith bucket).
  for (const { method: m, pattern, action } of REGEX_ACTIONS_BY_METHOD_PATTERN) {
    if (routeMethod === m && pattern.test(path)) return action;
  }

  // Method-aware regex match (ordered first — more specific)
  for (const [key, action] of Object.entries(REGEX_ACTIONS_BY_METHOD)) {
    const [m, prefix] = key.split(" ", 2);
    if (routeMethod === m && path.startsWith(prefix)) return action;
  }

  // Method-agnostic regex match
  for (const [prefix, action] of REGEX_ACTIONS) {
    if (path.startsWith(prefix)) return action;
  }

  // Unknown route — return null. server.js's `!action || !evaluate(...)`
  // check fails CLOSED on null: every tier, owner included, gets denied
  // rather than allowed. A new route is invisible to every policy until it is
  // added here, not silently open to the top tier.
  return null;
}
