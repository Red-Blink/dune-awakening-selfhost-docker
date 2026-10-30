import assert from "node:assert/strict";
import test from "node:test";
import { actionForRoute } from "../src/actions.js";
import { evaluate } from "../src/policy.js";

// Corrected (dune-awakening-selfhost-docker#861, comprehensive wizard
// security audit, 2026-09-10) -- oauth/start and oauth/callback are now
// owner-only, not updates:read (admin-reachable). Only the owner can ever
// complete the downstream /register call this OAuth round trip exists for;
// letting a non-owner admin start it anyway served no purpose but let them
// hold a live Discord access token in the pending-registration store under
// the guise of the shared hosted-bot flow.
test("hosted-bot routes resolve to the expected actions", () => {
  assert.equal(actionForRoute("/api/integrations/discord/hosted-bot/oauth/start", "GET"), "settings:discord-bot-hosted-oauth");
  assert.equal(actionForRoute("/api/integrations/discord/hosted-bot/oauth/callback", "GET"), "settings:discord-bot-hosted-oauth");
  assert.equal(actionForRoute("/api/integrations/discord/hosted-bot/register", "POST"), "settings:discord-bot-hosted-register");
});

test("admin cannot start/callback the OAuth flow or register -- both are owner-only (settings:* denied)", () => {
  assert.equal(evaluate({ tier: "admin" }, "settings:discord-bot-hosted-oauth"), false);
  assert.equal(evaluate({ tier: "admin" }, "settings:discord-bot-hosted-register"), false);
});

test("owner can do both, with zero DEFAULT_POLICIES changes required", () => {
  assert.equal(evaluate({ tier: "owner" }, "settings:discord-bot-hosted-oauth"), true);
  assert.equal(evaluate({ tier: "owner" }, "settings:discord-bot-hosted-register"), true);
});
