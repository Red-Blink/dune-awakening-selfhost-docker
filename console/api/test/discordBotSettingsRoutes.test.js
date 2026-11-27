// Structural tests for the Discord Bot Settings routes' audit-finding
// fixes (#1 CRITICAL, #2 HIGH). server.js is an entrypoint -- importing it
// starts a listener -- so, following baseContainerMutationRoutes.test.js's
// precedent, these routes are read as source and their real guard logic is
// asserted against the actual string literals in the file, not
// reimplemented and tested in isolation (which would only prove the
// test's own copy is correct, not the shipped route). The underlying pure
// decision functions these routes call (applyDiscordBotEnableRequest,
// discordAdminRoleIdsChanged) are fully exercised with real behavioral
// tests in discordAdapterSettings.test.js -- this file only proves the
// route handlers actually wire those functions in, correctly.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const serverSource = readFileSync(resolve(repoRoot, "console/api/src/server.js"), "utf8");

function routeBody(startMarker) {
  const start = serverSource.indexOf(startMarker);
  assert.notEqual(start, -1, `route starting with ${JSON.stringify(startMarker)} not found in server.js`);
  const next = serverSource.indexOf("\n  if (path ===", start + startMarker.length);
  assert.notEqual(next, -1, "could not find the start of the next route to bound this one");
  return serverSource.slice(start, next);
}

const enableRoute = () => routeBody('if (path === "/api/settings/discord-bot/enable" && req.method === "POST")');
const roleIdsRoute = () => routeBody('if (path === "/api/settings/discord-bot/role-ids" && req.method === "POST")');

test("Discord Bot settings routes are still dispatched from handleApi", () => {
  assert.match(serverSource, /if \(path === "\/api\/settings\/discord-bot" && req\.method === "GET"\)/);
  assert.match(serverSource, /if \(path === "\/api\/settings\/discord-bot\/enable" && req\.method === "POST"\)/);
  assert.match(serverSource, /if \(path === "\/api\/settings\/discord-bot\/role-ids" && req\.method === "POST"\)/);
  assert.match(serverSource, /if \(path === "\/api\/settings\/discord-bot\/regenerate-token" && req\.method === "POST"\)/);
});

// Audit finding #1 (CRITICAL): /enable must route through
// applyDiscordBotEnableRequest() -- which only mints a fresh token on a
// genuine first enable -- rather than calling enableDiscordBotAdapter()
// (always mints) unconditionally.
test("the /enable route calls applyDiscordBotEnableRequest, not enableDiscordBotAdapter directly", () => {
  const body = enableRoute();
  assert.match(body, /applyDiscordBotEnableRequest\(/, "/enable must use the token-safe wrapper");
  assert.doesNotMatch(body, /enableDiscordBotAdapter\(/, "/enable must not call enableDiscordBotAdapter() directly -- that always mints a fresh token");
});

// Audit finding #1 (CRITICAL): the response must only include `token` when
// applyDiscordBotEnableRequest actually minted one -- never unconditionally.
test("the /enable route only includes `token` in its response when a token was actually minted", () => {
  const body = enableRoute();
  assert.doesNotMatch(body, /\btoken\s*,?\s*}\)\s*;/, "must not unconditionally spread/return a possibly-undefined token field");
  assert.match(body, /tokenMinted/, "the route must branch on whether a token was actually minted");
});

// Audit finding #2 (HIGH): both /enable and /role-ids must gate a change
// to the admin role-ID mapping behind owner tier.
test("the /enable route requires owner tier to change admin-tier Discord role mappings", () => {
  const body = enableRoute();
  assert.match(body, /discordAdminRoleIdsChanged\(/, "/enable must check whether the admin role-ID set is actually changing");
  assert.match(body, /session\.tier\s*!==\s*"owner"/, "/enable must gate an admin role-ID change behind owner tier");
  assert.match(body, /403/, "/enable must reject a non-owner admin role-ID change with 403");
});

test("the /role-ids route requires owner tier to change admin-tier Discord role mappings", () => {
  const body = roleIdsRoute();
  assert.match(body, /discordAdminRoleIdsChanged\(/, "/role-ids must check whether the admin role-ID set is actually changing");
  assert.match(body, /session\.tier\s*!==\s*"owner"/, "/role-ids must gate an admin role-ID change behind owner tier");
  assert.match(body, /403/, "/role-ids must reject a non-owner admin role-ID change with 403");
});

// Audit finding #6 (LOW): GET must use updates:read (verified against the
// real actions.js mapping in discordAdapterSettingsPolicy.test.js) so
// admin -- who can already mutate this feature's state via updates:apply
// -- can also read it back.
test("the GET route is dispatched before the general session/action IAM gate would otherwise be needed for its own POST siblings", () => {
  // Sanity check only: confirm the GET handler itself doesn't hardcode a
  // second, redundant tier check -- the IAM gate (actions.js + policy.js)
  // is the single source of truth for read access, per this codebase's
  // existing pattern (see the top-of-handleApi `evaluate(session, action)`
  // gate, which already runs before any of these route bodies).
  const start = serverSource.indexOf('if (path === "/api/settings/discord-bot" && req.method === "GET")');
  assert.notEqual(start, -1);
  const next = serverSource.indexOf("\n  if (path ===", start + 10);
  const body = serverSource.slice(start, next);
  assert.doesNotMatch(body, /session\.tier/, "GET must rely on the IAM action gate (updates:read), not an ad hoc in-route tier check");
});
