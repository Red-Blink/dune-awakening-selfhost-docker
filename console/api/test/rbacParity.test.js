// Dispatcher parity test — statically parses server.js's handleApi if/else
// chain and asserts that every route branch has an IAM action assignment
// in actions.js (ROUTE_ACTIONS, REGEX_ACTIONS, REGEX_ACTIONS_BY_METHOD).
// A new route without an action fails this test.
//
// This is the load-bearing gate from §8.1 of the RBAC design doc.
// Updated 2026-08-07: now checks actions.js instead of rbac.js.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { actionForRoute, ROUTE_ACTIONS, REGEX_ACTIONS, REGEX_ACTIONS_BY_METHOD, REGEX_ACTIONS_BY_METHOD_PATTERN } from "../src/actions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(__dirname, "../src/server.js"), "utf8");

// Extract all path+method combinations from the handleApi if/else chain.
// The function starts with "async function handleApi(req, res)" and uses
// flat if/else by path. We look for patterns like:
//   if (path === "/api/foo") return ...
//   if (path === "/api/foo" && req.method === "GET") return ...
function extractRoutes(source) {
  const routes = [];

  // find handleApi body — from "async function handleApi" to end of function
  const funcMatch = source.match(/async function handleApi\(req,\s*res\)\s*\{/);
  if (!funcMatch) return routes;
  const start = funcMatch.index + funcMatch[0].length;

  // Extract the function body by tracking brace depth
  let depth = 1;
  let end = start;
  for (let i = start; i < source.length && depth > 0; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) { end = i; break; }
  }
  const body = source.slice(start, end);

  // Match route patterns in the if/else chain
  // Pattern 1: if (path === "PATH") return ...
  // Pattern 2: if (path === "PATH" && req.method === "METHOD") return ...
  const pathMethodRegex = /path\s*===\s*"([^"]+)"\s*(?:&&\s*req\.method\s*===\s*"([^"]+)")?/g;
  let match;
  while ((match = pathMethodRegex.exec(body)) !== null) {
    const path = match[1];
    const method = match[2] || "*";
    routes.push({ path, method });
  }

  // Also match template literal paths: path === `/api/logs/${service}`
  const templateRegex = /path\s*===\s*`([^`]+)`/g;
  while ((match = templateRegex.exec(body)) !== null) {
    const path = match[1];
    // template literal with ${...} means regex pattern
    if (path.includes("${")) {
      // Extract base prefix before any ${}
      const prefix = path.split("${")[0] || "/api/";
      routes.push({ path: prefix.endsWith("/") ? prefix : prefix + "/", method: "*", isPrefix: true });
    } else {
      routes.push({ path, method: "*" });
    }
  }

  // Also match `path.startsWith("/api/...")` patterns
  const startsWithRegex = /path\.startsWith\("([^"]+)"\)/g;
  while ((match = startsWithRegex.exec(body)) !== null) {
    const prefix = match[1];
    routes.push({ path: prefix.endsWith("/") ? prefix : prefix + "/", method: "*", isPrefix: true });
  }

  return routes;
}

const ALL_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];

function methodsToCheck(route) {
  if (route.method && route.method !== "*") return [route.method];
  return ALL_METHODS;
}

function isCovered(route) {
  // Discord adapter routes are handled separately, outside the IAM model
  const DISCORD_PREFIX = "/api/integrations/discord/";
  if (route.path.startsWith(DISCORD_PREFIX)) return true;

  // Public routes return null from actionForRoute — those are expected
  const PUBLIC_EXACT = ["/api/health", "/api/auth/state", "/api/auth/login", "/api/auth/logout", "/api/auth/me", "/api/auth/characters", "/api/auth/discord/start", "/api/auth/discord/callback", "/api/auth/discord/exchange"];
  if (PUBLIC_EXACT.includes(route.path)) return true;

  for (const method of methodsToCheck(route)) {
    // Check exact match first
    const action = actionForRoute(route.path, method);
    if (action) return true;

    // Check method-aware regex patterns
    for (const [key] of Object.entries(REGEX_ACTIONS_BY_METHOD)) {
      const [m, prefix] = key.split(" ", 2);
      if (method === m && route.path.startsWith(prefix)) return true;
    }

    // Check method-agnostic regex patterns
    for (const [prefix] of REGEX_ACTIONS) {
      if (route.path.startsWith(prefix)) return true;
    }
  }
  return false;
}

test("parity: every non-adapter route in handleApi has an IAM action", () => {
  const routes = extractRoutes(serverSrc);

  assert.ok(routes.length > 50, `Expected >50 routes, found ${routes.length}`);

  const uncovered = [];

  for (const route of routes) {
    if (!isCovered(route)) {
      uncovered.push(`${route.method} ${route.path}`);
    }
  }

  if (uncovered.length > 0) {
    const message = [
      `${uncovered.length} route(s) have no IAM action assignment:\n  ${uncovered.join('\n  ')}`,
      `\nactions.js ROUTE_ACTIONS must be updated when routes are added.`,
    ].join('\n');
    assert.fail(message);
  }
});

test("parity: all IAM actions reference known namespaces", () => {
  const validNamespaces = new Set([
    "setup", "server", "logs", "backups", "database", "updates", "settings",
    "players", "guilds", "bases", "maps", "sietches", "deepdesert", "admin",
    "landsraad", "addons", "carepackage", "storage", "blueprints", "vehicles",
    "exchange"
  ]);
  for (const action of Object.values(ROUTE_ACTIONS)) {
    if (typeof action !== "string") continue;
    const ns = action.includes(":") ? action.split(":")[0] : action;
    assert.ok(validNamespaces.has(ns), `Unknown namespace in action: ${action}`);
  }
});

test("parity: all REGEX_ACTIONS entries reference known namespaces", () => {
  const validNamespaces = new Set([
    "setup", "server", "logs", "backups", "database", "updates", "settings",
    "players", "guilds", "bases", "maps", "sietches", "deepdesert", "admin",
    "landsraad", "addons", "carepackage", "storage", "blueprints", "vehicles",
    "exchange"
  ]);
  for (const [, action] of REGEX_ACTIONS) {
    if (typeof action !== "string") continue;
    const ns = action.includes(":") ? action.split(":")[0] : action;
    assert.ok(validNamespaces.has(ns), `Unknown namespace in regex action: ${action}`);
  }
  for (const action of Object.values(REGEX_ACTIONS_BY_METHOD)) {
    if (typeof action !== "string") continue;
    const ns = action.includes(":") ? action.split(":")[0] : action;
    assert.ok(validNamespaces.has(ns), `Unknown namespace in method action: ${action}`);
  }
  for (const { action } of REGEX_ACTIONS_BY_METHOD_PATTERN) {
    if (typeof action !== "string") continue;
    const ns = action.includes(":") ? action.split(":")[0] : action;
    assert.ok(validNamespaces.has(ns), `Unknown namespace in pattern action: ${action}`);
  }
});

test("parity: DELETE /api/bases/{baseId} resolves to bases:delete, distinct from other bases DELETE routes", () => {
  assert.equal(actionForRoute("/api/bases/12858", "DELETE"), "bases:delete");
  // Sibling sub-resource DELETEs must stay in the shared, reversible bucket
  // -- only the base delete itself gets its own action.
  assert.equal(actionForRoute("/api/bases/12858/queued-delete", "DELETE"), "bases:mutate");
  assert.equal(actionForRoute("/api/bases/12858/queued-refill", "DELETE"), "bases:mutate");
  assert.equal(actionForRoute("/api/bases/12858/queued-water-refill", "DELETE"), "bases:mutate");
});

test("parity: base container give/fill/bulk-delete routes resolve to their own narrow actions, not bases:mutate", () => {
  // Same consent argument as bases:delete-item: base inventory shipped
  // read-only, so an operator's existing bases:mutate grant (refills,
  // permission edits) must not silently widen to cover item creation or
  // bulk/delete-all destruction just because these routes share the
  // /api/bases/ prefix.
  assert.equal(actionForRoute("/api/bases/12858/containers/42/give-item", "POST"), "bases:give-item");
  assert.equal(actionForRoute("/api/bases/12858/containers/42/give-items", "POST"), "bases:give-item");
  assert.equal(actionForRoute("/api/bases/12858/containers/42/fill-item", "POST"), "bases:fill-item");
  assert.equal(actionForRoute("/api/bases/12858/containers/42/items", "DELETE"), "bases:bulk-delete-items");
  assert.equal(actionForRoute("/api/bases/12858/containers/42/all-items", "DELETE"), "bases:bulk-delete-items");
  // The existing single-item delete route must be unaffected by these new
  // sibling routes/regexes.
  assert.equal(actionForRoute("/api/bases/12858/containers/42/items/99", "DELETE"), "bases:delete-item");
});

test("parity: POST vehicle system-custodian transfer resolves to vehicles:mutate, not the read-only fallback", () => {
  // Regression guard: REGEX_ACTIONS_BY_METHOD has no "POST /api/vehicles/"
  // entry, so without a REGEX_ACTIONS_BY_METHOD_PATTERN entry this route
  // would fall through to the method-agnostic "/api/vehicles/" ->
  // vehicles:read rule, silently authorizing an ownership transfer under a
  // read-only grant.
  assert.equal(actionForRoute("/api/vehicles/2048/system-custodian", "POST"), "vehicles:mutate");
  assert.notEqual(actionForRoute("/api/vehicles/2048/system-custodian", "POST"), "vehicles:read");
});

test("parity: DELETE vehicle resolves to vehicles:delete, not the read-only fallback", () => {
  // Regression guard, same shape as the system-custodian one above: no
  // "DELETE /api/vehicles/" prefix rule exists in REGEX_ACTIONS_BY_METHOD,
  // so without the pattern entry this would fall through to
  // "/api/vehicles/" -> vehicles:read, silently authorizing an irreversible
  // delete under a read-only grant.
  assert.equal(actionForRoute("/api/vehicles/2048", "DELETE"), "vehicles:delete");
  assert.notEqual(actionForRoute("/api/vehicles/2048", "DELETE"), "vehicles:read");
});

test("parity: DELETE vehicle queued-delete cancel resolves to vehicles:mutate, not the read-only fallback", () => {
  assert.equal(actionForRoute("/api/vehicles/2048/queued-delete", "DELETE"), "vehicles:mutate");
  assert.notEqual(actionForRoute("/api/vehicles/2048/queued-delete", "DELETE"), "vehicles:read");
});

test("parity: GET vehicle pending-deletes resolves to vehicles:read", () => {
  assert.equal(actionForRoute("/api/vehicles/pending-deletes", "GET"), "vehicles:read");
});
