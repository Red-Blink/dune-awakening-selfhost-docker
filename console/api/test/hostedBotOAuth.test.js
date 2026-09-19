import assert from "node:assert/strict";
import test from "node:test";
import { fetchOwnedDiscordGuilds, createPendingRegistrationStore, hostedBotOAuthStateCookie, clearHostedBotOAuthStateCookie, hostedBotRegistrationHandleCookie, hostedBotOAuthReturnPage } from "../src/integrations/discord/hostedBotOAuth.js";

test("fetchOwnedDiscordGuilds keeps only owner:true guilds and preserves id+name+owner", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/users/@me/guilds")) {
      return { ok: true, json: async () => ([
        { id: "111111111111111111", name: "Owned Guild", owner: true },
        { id: "222222222222222222", name: "Not Owned", owner: false }
      ]) };
    }
    return { ok: true, json: async () => ({ id: "999999999999999999", username: "someone" }) };
  };
  const result = await fetchOwnedDiscordGuilds({ accessToken: "tok", fetchImpl });
  assert.equal(result.userId, "999999999999999999");
  assert.deepEqual(result.guilds, [{ id: "111111111111111111", name: "Owned Guild", owner: true }]);
});

test("fetchOwnedDiscordGuilds returns an empty guilds array when the operator owns nothing", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/users/@me/guilds")) return { ok: true, json: async () => ([{ id: "1", name: "x", owner: false }]) };
    return { ok: true, json: async () => ({ id: "999999999999999999", username: "someone" }) };
  };
  const result = await fetchOwnedDiscordGuilds({ accessToken: "tok", fetchImpl });
  assert.deepEqual(result.guilds, []);
});

test("pending-registration store is single-use, TTL-bound, and capacity-capped", () => {
  let clock = 1000;
  const store = createPendingRegistrationStore({ now: () => clock, ttlMs: 5000, maxEntries: 2 });
  const first = store.issue({ accessToken: "tok-a", ownedGuildIds: ["111111111111111111"], userId: "u1" });
  assert.ok(first.handle);
  const readBack = store.consume(first.handle, first.handle);
  assert.equal(readBack.ok, true);
  assert.equal(readBack.entry.accessToken, "tok-a");

  const secondRead = store.consume(first.handle, first.handle);
  assert.equal(secondRead.ok, false, "a handle must be single-use");

  const second = store.issue({ accessToken: "tok-b", ownedGuildIds: [], userId: "u2" });
  clock += 6000;
  const expired = store.consume(second.handle, second.handle);
  assert.equal(expired.ok, false, "an entry past its TTL must be rejected");
});

test("pending-registration store rejects a handle that doesn't match the cookie value", () => {
  const store = createPendingRegistrationStore({});
  const issued = store.issue({ accessToken: "tok", ownedGuildIds: [], userId: "u1" });
  const result = store.consume(issued.handle, "some-other-cookie-value");
  assert.equal(result.ok, false);
});

test("pending-registration store enforces a capacity cap", () => {
  const store = createPendingRegistrationStore({ maxEntries: 1 });
  const first = store.issue({ accessToken: "a", ownedGuildIds: [], userId: "u1" });
  assert.ok(first);
  const second = store.issue({ accessToken: "b", ownedGuildIds: [], userId: "u2" });
  assert.equal(second, null);
});

test("hostedBotOAuthStateCookie and hostedBotRegistrationHandleCookie use distinct, path-scoped, HttpOnly cookies", () => {
  const stateCookie = hostedBotOAuthStateCookie("abc123");
  assert.match(stateCookie, /^hosted_bot_oauth_state=abc123/);
  assert.match(stateCookie, /HttpOnly/);
  assert.match(stateCookie, /Path=\/api\/integrations\/discord\/hosted-bot\/oauth\/callback/);
  const handleCookie = hostedBotRegistrationHandleCookie("xyz789", true);
  assert.match(handleCookie, /^hosted_bot_registration_handle=xyz789/);
  assert.match(handleCookie, /HttpOnly/);
  assert.notEqual(stateCookie.split("=")[0], handleCookie.split("=")[0], "the two cookies must have distinct names");
});

// Layer 3 audit finding (CRITICAL): mirrors oauth.js's own already-fixed,
// already-pinned regression test ("oauth state cookie is always Secure").
// hostedBotOAuthStateCookie()/clearHostedBotOAuthStateCookie() used to accept
// a `secure` parameter that every real call site fed with config.secureCookies
// -- false by default (docker-compose.web.yml's ADMIN_SECURE_COOKIES:-0) on
// every fresh install. SameSite=None without Secure is rejected outright by
// every modern browser (not just weaker), so this hosted-bot OAuth flow's
// state cookie never survived the Discord redirect on any default install.
test("hosted-bot OAuth state cookie is always Secure: SameSite=None mandates Secure, independent of ADMIN_SECURE_COOKIES", () => {
  const set = hostedBotOAuthStateCookie("abc123");
  assert.match(set, /SameSite=None/);
  assert.match(set, /;\s*Secure/);
  assert.match(set, /HttpOnly/);
  assert.match(clearHostedBotOAuthStateCookie(), /SameSite=None/);
  assert.match(clearHostedBotOAuthStateCookie(), /;\s*Secure/);
});

// Layer 3 audit finding (HIGH): discordJsonRequest() (used by
// fetchOwnedDiscordGuilds during the hosted-bot OAuth callback) used to be a
// bare `await fetchImpl(...)` with no bound at all -- unlike oauth.js's
// near-identical helper, which passes an AbortController-derived signal
// specifically to prevent a Discord brownout hanging the request for
// undici's multi-minute default. A real 5s wait to prove the abort actually
// fires isn't worth the wall-clock cost this suite doesn't otherwise pay
// anywhere -- this confirms the wiring directly: every request this
// function makes now carries a real AbortSignal, which is the mechanism the
// timeout depends on.
test("fetchOwnedDiscordGuilds requests carry a real AbortSignal, so a hung Discord response can actually be aborted", async () => {
  const signals = [];
  const fetchImpl = async (url, init) => {
    signals.push(init?.signal);
    if (url.includes("/users/@me/guilds")) return { ok: true, json: async () => [] };
    return { ok: true, json: async () => ({ id: "999999999999999999", username: "someone" }) };
  };
  await fetchOwnedDiscordGuilds({ accessToken: "tok", fetchImpl });
  assert.equal(signals.length, 2, "both the identity and guilds calls must go through discordJsonRequest");
  for (const signal of signals) {
    assert.ok(signal instanceof AbortSignal, "every Discord request must carry a real AbortSignal, not none at all");
    assert.equal(signal.aborted, false, "the signal must not already be aborted for a fast, successful response");
  }
});

test("hostedBotOAuthReturnPage embeds the owned-guilds list as JSON the SPA can read via sessionStorage, and never embeds a token", () => {
  const guilds = [{ id: "111111111111111111", name: "Test Guild", owner: true }];
  const page = hostedBotOAuthReturnPage(guilds);
  // Final integration review (CRITICAL): must write to sessionStorage, not
  // a plain `window` property -- a plain property is lost the instant the
  // page's own `window.location.replace("/")` (below) performs a real,
  // full-document navigation into a brand-new window. See
  // discordHostedBotApi.test.ts (console/web) for the test that actually
  // crosses that navigation boundary end to end.
  assert.match(page, /sessionStorage\.setItem\(\s*["']hostedBotOwnedGuilds["']/);
  assert.match(page, /window\.location\.replace\(\s*["']\/["']\s*\)/);
  assert.doesNotMatch(page, /window\.__hostedBotOwnedGuilds__/, "must not use the old, broken window-property mechanism");
  assert.match(page, /Test Guild/);
  assert.doesNotMatch(page, /accessToken|access_token/i, "the return page must never embed the raw Discord token");
});
