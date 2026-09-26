import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAutoInviteAuthorizeUrl,
  createAutoInvitePendingStateStore,
  autoInviteStateCookie,
  clearAutoInviteStateCookie,
  autoInviteCompletePage
} from "../src/integrations/discord/autoInvite.js";

test("buildAutoInviteAuthorizeUrl embeds the caller-supplied client_id, redirectUri/state, and the single-consent-screen scope", () => {
  const url = new URL(buildAutoInviteAuthorizeUrl({ redirectUri: "https://mentat-link.darkdante.org/api/consoles/auto-invite/callback", state: "abc123", clientId: "1546203607807041697" }));
  assert.equal(url.origin + url.pathname, "https://discord.com/oauth2/authorize");
  assert.equal(url.searchParams.get("client_id"), "1546203607807041697");
  assert.equal(url.searchParams.get("redirect_uri"), "https://mentat-link.darkdante.org/api/consoles/auto-invite/callback");
  assert.equal(url.searchParams.get("state"), "abc123");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("permissions"), "128");
  // Design doc goal G1 -- one consent screen covers both bot-install AND
  // ownership re-verification, so both scope families must be present.
  const scopes = (url.searchParams.get("scope") || "").split(" ");
  assert.ok(scopes.includes("bot"));
  assert.ok(scopes.includes("applications.commands"));
  assert.ok(scopes.includes("identify"));
  assert.ok(scopes.includes("guilds"));
});

test("createAutoInvitePendingStateStore.issue() records MENTAT's own state value verbatim, not a freshly-minted one", () => {
  const store = createAutoInvitePendingStateStore({});
  const issued = store.issue("mentat-issued-state-value");
  assert.deepEqual(issued, { state: "mentat-issued-state-value" });
  assert.equal(store.size(), 1);
});

test("issue() rejects a non-string or empty state, and never grows the store for it", () => {
  const store = createAutoInvitePendingStateStore({});
  assert.equal(store.issue(""), null);
  assert.equal(store.issue(null), null);
  assert.equal(store.issue(undefined), null);
  assert.equal(store.size(), 0);
});

test("consume() succeeds only when state and cookie match a real, unexpired, unused entry", () => {
  let clock = 1000;
  const store = createAutoInvitePendingStateStore({ now: () => clock, ttlMs: 5000 });
  store.issue("real-state");

  assert.deepEqual(store.consume("real-state", "real-state"), { ok: true });
});

test("consume() is single-use -- a second consume of the same state fails even with the right cookie", () => {
  const store = createAutoInvitePendingStateStore({});
  store.issue("state-1");
  assert.equal(store.consume("state-1", "state-1").ok, true);
  const second = store.consume("state-1", "state-1");
  assert.equal(second.ok, false);
  assert.equal(second.reason, "missing_or_reused_state");
});

test("consume() rejects a state that was never issued", () => {
  const store = createAutoInvitePendingStateStore({});
  const result = store.consume("never-issued", "never-issued");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_or_reused_state");
});

test("consume() rejects a state/cookie mismatch -- the double-submit invariant", () => {
  const store = createAutoInvitePendingStateStore({});
  store.issue("real-state");
  const result = store.consume("real-state", "attacker-guessed-value");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "state_cookie_mismatch");
});

test("consume() rejects a missing or empty cookie value even for a real, pending state", () => {
  const store = createAutoInvitePendingStateStore({});
  store.issue("real-state");
  const result = store.consume("real-state", "");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_state_cookie");
});

test("consume() rejects an entry past its TTL", () => {
  let clock = 1000;
  const store = createAutoInvitePendingStateStore({ now: () => clock, ttlMs: 5000 });
  store.issue("real-state");
  clock += 6000;
  const result = store.consume("real-state", "real-state", clock);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stale_state");
});

test("consume() deletes the entry from the map even when it fails validation (state/cookie mismatch), so it can never be retried", () => {
  const store = createAutoInvitePendingStateStore({});
  store.issue("real-state");
  store.consume("real-state", "wrong-cookie");
  assert.equal(store.size(), 0, "the entry must be removed on read regardless of outcome, matching the OAuth pending-state store's own TOCTOU-safe pattern");
  const retry = store.consume("real-state", "real-state");
  assert.equal(retry.ok, false, "a state can never be consumed twice, even if the first attempt used a wrong cookie");
});

test("consume() rejects an oversized state string before ever touching the map", () => {
  const store = createAutoInvitePendingStateStore({});
  const oversized = "x".repeat(129);
  const result = store.consume(oversized, oversized);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_state");
});

test("issue() enforces a capacity cap", () => {
  const store = createAutoInvitePendingStateStore({ maxEntries: 1 });
  assert.deepEqual(store.issue("state-a"), { state: "state-a" });
  assert.equal(store.issue("state-b"), null);
});

test("autoInviteStateCookie and clearAutoInviteStateCookie use a distinct name/path from the OLD hosted-bot OAuth flow's own state cookie", () => {
  const cookie = autoInviteStateCookie("some-state-value", true);
  assert.match(cookie, /^auto_invite_state=some-state-value/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\/api\/integrations\/discord\/hosted-bot\/auto-invite/);
  assert.match(cookie, /Secure/);
  assert.doesNotMatch(cookie, /^hosted_bot_oauth_state=/, "must not collide with the old flow's own state cookie name");

  const cleared = clearAutoInviteStateCookie(true);
  assert.match(cleared, /^auto_invite_state=;/);
  assert.match(cleared, /Max-Age=0/);
});

test("autoInviteStateCookie omits Secure when secureCookies is false", () => {
  const cookie = autoInviteStateCookie("x", false);
  assert.doesNotMatch(cookie, /Secure/);
});

test("autoInviteCompletePage never interpolates guildName/reason into the visible page text -- only into the JSON postMessage payload", () => {
  const page = autoInviteCompletePage({ ok: true, guildName: "Fleetyard <script>alert(1)</script>", reason: "", reclaimed: false });
  // The visible <p> text must be the fixed, generic string -- never the
  // caller-supplied guildName -- so there is no HTML-escaping-discipline
  // burden on this template at all.
  assert.match(page, /<p>Request sent — check Discord to confirm the connection\.<\/p>/);
  assert.doesNotMatch(page, /<p>[^<]*Fleetyard/, "guildName must never appear in the visible page text");
  // The real value only ever reaches the opener via the JSON payload, which
  // Core's own React app renders through JSX's auto-escaping.
  assert.match(page, /"guildName":"Fleetyard/);
});

test("autoInviteCompletePage escapes '<' inside the JSON payload so it can never break out of the inline <script> block", () => {
  const page = autoInviteCompletePage({ ok: false, guildName: "", reason: "</script><script>alert(1)</script>" });
  assert.doesNotMatch(page, /reason":"<\/script>/, "a raw '</script>' must never appear unescaped inside the inline script block");
  assert.match(page, /\\u003c\/script>/, "the '<' must be escaped so the HTML tokenizer can never recognize a real closing </script> tag");
});

test("autoInviteCompletePage posts to window.location.origin, never a wildcard '*' targetOrigin", () => {
  const page = autoInviteCompletePage({ ok: true, guildName: "Fleetyard" });
  assert.match(page, /postMessage\(\{[^}]*\},\s*window\.location\.origin\)/s);
  assert.doesNotMatch(page, /postMessage\([^)]*["']\*["']\)/);
});

test("autoInviteCompletePage renders a distinct message for ok:false vs ok:true", () => {
  const failure = autoInviteCompletePage({ ok: false, reason: "owner_changed" });
  assert.match(failure, /Could not connect/);
  const success = autoInviteCompletePage({ ok: true });
  assert.match(success, /Request sent/);
});
