import assert from "node:assert/strict";
import test from "node:test";
import { actionForRoute } from "../src/actions.js";
import { evaluate } from "../src/policy.js";

test("Discord Bot settings routes resolve to the expected actions", () => {
  // Audit finding #6 (LOW): GET must resolve to an action admin already
  // holds via an existing wildcard (updates:*), not settings:read (denied
  // to admin by the settings:* Deny wildcard) -- otherwise admin can
  // blindly mutate this feature's state via the POST routes below but
  // can never read it back first.
  assert.equal(actionForRoute("/api/settings/discord-bot", "GET"), "updates:read");
  assert.equal(actionForRoute("/api/settings/discord-bot/enable", "POST"), "updates:apply");
  assert.equal(actionForRoute("/api/settings/discord-bot/role-ids", "POST"), "updates:apply");
  assert.equal(actionForRoute("/api/settings/discord-bot/regenerate-token", "POST"), "settings:discord-bot-regenerate-token");
  // Real UAT finding (2026-09-09): the restart trigger split out of
  // /enable and /role-ids -- same action as both.
  assert.equal(actionForRoute("/api/settings/discord-bot/restart", "POST"), "updates:apply");
  // Real UAT finding (2026-09-09, "I see no path to remove the bot") --
  // owner-only, same tier restriction as regenerate-token, via its own
  // distinct action name.
  assert.equal(actionForRoute("/api/settings/discord-bot/disable", "POST"), "settings:discord-bot-disable");
  // Corrected (dune-awakening-selfhost-docker#859, comprehensive wizard
  // security audit, 2026-09-10) -- SUPERSEDES the original 2026-09-09
  // reasoning below, kept for context on why the bug existed:
  // "the hosted-bot connection's own, independent Discord Application
  // config -- prerequisite setup, not a destructive/credential-invalidating
  // action, so updates:apply (admin reachable) not owner-only." That
  // framing missed the actual exploit chain: an admin substituting these
  // credentials (their own Discord Application + an attacker-controlled
  // redirectUri) is exactly the class of credential-replacement action
  // every OTHER route in this flow already treats as owner-only
  // (regenerate-token, disable, /register) -- the owner later completing
  // a real Discord consent flow against the hijacked config hands their
  // actual Discord identity/access token to whoever substituted it.
  assert.equal(actionForRoute("/api/settings/discord-bot/oauth-config", "POST"), "settings:discord-bot-oauth-config");
  assert.equal(actionForRoute("/api/settings/discord-bot/oauth-secret", "POST"), "settings:discord-bot-oauth-secret");
  // Real UAT finding (2026-09-10): the 3-step wizard's early choice-persist.
  assert.equal(actionForRoute("/api/settings/discord-bot/choice", "POST"), "updates:apply");
});

// Upstream-port structural difference (dune-awakening-selfhost-docker
// wizard-port to tier1-upstream, same finding as oauthRoutes.integration.
// test.js's "admin-tier session gets a real 403 changing Discord admin role
// IDs" test): the comment this test's name is drawn from ("already has
// updates:apply via self-update") is a fork-main assumption that does not
// hold on tier1-upstream. tier1-upstream's own policy.js CROWN_JEWEL_DENY_
// ACTIONS list includes "updates:apply"/"updates:fix"/"updates:repair" as
// owner-only, explicitly denied to admin -- a real, deliberate, STRICTER
// security posture than fork main's, not a bug to "fix" by weakening the
// real policy. Concretely, on tier1-upstream admin cannot enable the
// Discord adapter, edit its role IDs, trigger its restart, or persist the
// deployment choice either (all four routes resolve to updates:apply per
// the route-mapping test above) -- only owner can perform any write action
// in this feature there, not just the two (regenerate-token, disable) fork
// main scoped to owner-only. Asserting the real, current behavior here
// rather than the fork-main assumption; this structural difference is
// flagged explicitly in the upstream PR body per Requirement 19(c).
test("admin cannot enable the Discord adapter on tier1-upstream (updates:apply is owner-only there) and cannot regenerate its token either (settings:* denied)", () => {
  assert.equal(evaluate({ tier: "admin" }, "updates:apply"), false);
  assert.equal(evaluate({ tier: "admin" }, "settings:discord-bot-regenerate-token"), false);
});

test("admin cannot disable the Discord adapter (settings:* denied, same as regenerate-token)", () => {
  assert.equal(evaluate({ tier: "admin" }, "settings:discord-bot-disable"), false);
});

test("admin can read the Discord Bot settings state (updates:* Allow wildcard), unlike settings:read which is denied", () => {
  assert.equal(evaluate({ tier: "admin" }, "updates:read"), true);
  assert.equal(evaluate({ tier: "admin" }, "settings:read"), false);
});

test("owner can do both", () => {
  assert.equal(evaluate({ tier: "owner" }, "updates:apply"), true);
  assert.equal(evaluate({ tier: "owner" }, "settings:discord-bot-regenerate-token"), true);
});

test("owner can disable the Discord adapter", () => {
  assert.equal(evaluate({ tier: "owner" }, "settings:discord-bot-disable"), true);
});

// dune-awakening-selfhost-docker#859: admin must not be able to substitute
// the hosted-bot Discord Application's Client ID/Secret/Redirect URI --
// this was the CRITICAL finding (a hijack + Discord-identity-theft chain).
test("admin cannot configure the hosted-bot OAuth client (settings:* denied, same as regenerate-token/disable)", () => {
  assert.equal(evaluate({ tier: "admin" }, "settings:discord-bot-oauth-config"), false);
  assert.equal(evaluate({ tier: "admin" }, "settings:discord-bot-oauth-secret"), false);
});

test("owner can configure the hosted-bot OAuth client", () => {
  assert.equal(evaluate({ tier: "owner" }, "settings:discord-bot-oauth-config"), true);
  assert.equal(evaluate({ tier: "owner" }, "settings:discord-bot-oauth-secret"), true);
});
