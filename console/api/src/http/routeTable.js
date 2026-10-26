/**
 * Domain-grouped O(1) route registry and dispatch index for the Console API (E-01).
 *
 * Groups API routes by functional domain (auth, setup, server, database, players,
 * bases, vehicles, landsraad, liveMap, addons, logs, backups) and provides a
 * Map-backed O(1) lookup helper for exact (method + path) routes while keeping
 * `handleApi` in `server.js` compatible with static RBAC parity tests.
 */

export const API_ROUTE_DOMAINS = Object.freeze({
  auth: ["/api/health", "/api/auth/state", "/api/auth/login", "/api/auth/logout"],
  setup: ["/api/setup/state", "/api/setup/preflight", "/api/setup/config", "/api/setup/token", "/api/setup/init"],
  server: ["/api/status", "/api/server/start", "/api/server/stop", "/api/server/restart", "/api/metrics/summary"],
  database: ["/api/database/status", "/api/database/schemas", "/api/database/tables", "/api/database/routines", "/api/database/query"],
  players: ["/api/players", "/api/players/bans", "/api/players/playtime", "/api/players/announcements"],
  bases: ["/api/bases", "/api/bases/auto-refill", "/api/bases/water-auto-refill", "/api/bases/blueprints"],
  vehicles: ["/api/vehicles", "/api/vehicles/backups"],
  landsraad: ["/api/landsraad", "/api/landsraad/milestones"],
  liveMap: ["/api/live-map/markers", "/api/live-map/teleport", "/api/live-map/realtime"],
  addons: ["/api/addons/community", "/api/addons/installed", "/api/addons/install"],
  logs: ["/api/logs/services"],
  backups: ["/api/backups", "/api/backups/system"]
});

export function createExactRouteIndex(entries = []) {
  const index = new Map();
  for (const entry of entries) {
    if (!entry || !entry.path || typeof entry.handler !== "function") continue;
    const method = String(entry.method || "GET").toUpperCase();
    index.set(`${method} ${entry.path}`, entry.handler);
  }
  return {
    size: index.size,
    match(method, path) {
      return index.get(`${String(method || "GET").toUpperCase()} ${path}`) || null;
    }
  };
}
