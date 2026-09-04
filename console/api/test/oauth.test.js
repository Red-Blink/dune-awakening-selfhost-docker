import test from "node:test";
import assert from "node:assert/strict";
import { createPendingStateStore, exchangeDiscordAuthCode, fetchDiscordIdentity, resolveBootstrapTier, parseDiscordAllowlist, buildAuthorizeUrl, oauthError, createOAuthTierResolver, oauthStateCookie, clearOAuthStateCookie } from "../src/integrations/discord/oauth.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

test("pending state issues single-use cookie-bound entries", () => {
  const now = [1_000_000];
  const store = createPendingStateStore({ now: () => now[0] });
  const state = store.issue().state;
  assert.ok(state && state.length > 0);
  assert.equal(store.size(), 1);

  const first = store.consume(state, state, 1_000_100);
  assert.equal(first.ok, true);
  assert.equal(store.size(), 0);

  const second = store.consume(state, state, 1_000_200);
  assert.equal(second.ok, false);
  assert.equal(second.reason, "missing_or_reused_state");
});

test("pending state: stale TTL is rejected", () => {
  const now = [1_000_000];
  const store = createPendingStateStore({ now: () => now[0], ttlMs: 10_000 });
  const state = store.issue().state;
  now[0] += 10_001;
  const result = store.consume(state, state, now[0]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stale_state");
});

test("pending state: cookie mismatch rejected and state still consumed", () => {
  const now = [1_000_000];
  const store = createPendingStateStore({ now: () => now[0] });
  const state = store.issue().state;
  const result = store.consume(state, "attacker-chosen-cookie", now[0]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "state_cookie_mismatch");
  assert.equal(store.size(), 0);
  const retried = store.consume(state, state, now[0]);
  assert.equal(retried.ok, false);
  assert.equal(retried.reason, "missing_or_reused_state");
});

test("pending state: a fresh-state flood evicts the oldest instead of permanently refusing sign-in (LRU DoS mitigation)", () => {
  const t = [1000];
  const store = createPendingStateStore({ maxEntries: 2, now: () => t[0] });
  const first = store.issue().state; t[0] += 10;
  const second = store.issue().state; t[0] += 10;
  // The table is full of two fresh, un-consumed states (the flood shape). A new
  // /discord/start still succeeds -- it evicts the OLDEST rather than 429ing
  // every future sign-in until the TTL ages the flood out.
  const third = store.issue(); t[0] += 10;
  assert.notEqual(third, null, "issue() no longer hard-fails when full of fresh states");
  // The evicted oldest state can no longer be consumed; the newer one still can.
  assert.equal(store.consume(first, first).ok, false, "the oldest in-flight state was evicted to make room");
  assert.equal(store.consume(second, second).ok, true, "newer in-flight states survive");
});

test("token exchange: missing/invalid code rejected", async () => {
  await assert.rejects(
    exchangeDiscordAuthCode({ code: "", redirectUri: "https://console.example/cb", clientId: "id", clientSecret: "sec", fetchImpl: async () => jsonResponse({}) }),
    (error) => error.code === "missing_code"
  );
});

test("token exchange: upstream non-2xx yields oauth_upstream_error", async () => {
  await assert.rejects(
    exchangeDiscordAuthCode({ code: "c", redirectUri: "u", clientId: "id", clientSecret: "sec", fetchImpl: () => jsonResponse({ error: "bad" }, 400) }),
    (error) => error.code === "oauth_upstream_error"
  );
});

test("token exchange: unreachable host yields tied-down error, not a throw", async () => {
  await assert.rejects(
    exchangeDiscordAuthCode({ code: "c", redirectUri: "u", clientId: "id", clientSecret: "sec", fetchImpl: () => { throw new Error("network"); } }),
    (error) => error.code === "discord_unreachable"
  );
});

test("token exchange: malformed / missing access_token rejected", async () => {
  await assert.rejects(
    exchangeDiscordAuthCode({ code: "c", redirectUri: "u", clientId: "id", clientSecret: "sec", fetchImpl: () => jsonResponse({}) }),
    (error) => error.code === "oauth_missing_token"
  );
  await assert.rejects(
    exchangeDiscordAuthCode({ code: "c", redirectUri: "u", clientId: "id", clientSecret: "sec", fetchImpl: () => jsonResponse({ access_token: "" }) }),
    (error) => error.code === "oauth_missing_token"
  );
});

test("token exchange: happy path returns access token", async () => {
  const token = await exchangeDiscordAuthCode({
    code: "auth-code", redirectUri: "https://x.example/api/auth/discord/callback", clientId: "client", clientSecret: "secret",
    fetchImpl: async (url, init) => {
      assert.match(String(url), /\/oauth2\/token$/);
      assert.match(String(init.headers["content-type"]), /application\/x-www-form-urlencoded/);
      assert.match(String(init.body), /code=auth-code/);
      return jsonResponse({ access_token: "tok", token_type: "Bearer", expires_in: 604800 });
    }
  });
  assert.equal(token.access_token, "tok");
});

test("identity: /users/@me + guilds resolve cleanly", async () => {
  const identity = await fetchDiscordIdentity({
    accessToken: "tok",
    fetchImpl: async (url) => {
      if (String(url).endsWith("/users/@me")) return jsonResponse({ id: "123456789012345678", username: "operator" });
      if (String(url).endsWith("/users/@me/guilds")) return jsonResponse([{ id: "987654321098765432" }, { id: "555", bad: true }]);
      throw new Error("unexpected fetch");
    }
  });
  assert.equal(identity.userId, "123456789012345678");
  assert.equal(identity.username, "operator");
  assert.deepEqual(identity.guildIds, ["987654321098765432"]);
});

test("identity: malformed user payload rejected", async () => {
  await assert.rejects(
    fetchDiscordIdentity({ accessToken: "tok", fetchImpl: () => jsonResponse({ id: "abc", username: "nope" }) }),
    (error) => error.code === "oauth_bad_identity"
  );
  await assert.rejects(
    fetchDiscordIdentity({ accessToken: "tok", fetchImpl: () => jsonResponse({ id: "123456789012345678", username: "" }) }),
    (error) => error.code === "oauth_bad_identity"
  );
});

test("identity: failed guilds lookup fails closed (no partial identity)", async () => {
  await assert.rejects(
    fetchDiscordIdentity({
      accessToken: "tok",
      fetchImpl: async (url) => {
        if (String(url).endsWith("/users/@me")) return jsonResponse({ id: "123456789012345678", username: "x" });
        return new Response("not json", { status: 500 });
      }
    }),
    (error) => ["oauth_bad_response", "oauth_upstream_error"].includes(error.code)
  );
});

test("bootstrap tier: every owner gate must pass", () => {
  const policy = { userId: "111111111111111111", guildIds: ["222222222222222222"], allowOwnerBootstrap: true, homeGuildId: "222222222222222222", ownerAllowlist: ["111111111111111111"] };
  assert.equal(resolveBootstrapTier(policy), "owner");

  assert.equal(resolveBootstrapTier({ ...policy, ownerAllowlist: undefined }), "");
  assert.equal(resolveBootstrapTier({ ...policy, allowOwnerBootstrap: false }), "");
  assert.equal(resolveBootstrapTier({ ...policy, homeGuildId: "" }), "");
  assert.equal(resolveBootstrapTier({ ...policy, guildIds: [] }), "");
  assert.equal(resolveBootstrapTier({ ...policy, ownerAllowlist: ["333333333333333333"] }), "");
  assert.equal(resolveBootstrapTier({ ...policy, ownerAllowlist: ["111111111111111111"] }), "owner");
  assert.equal(resolveBootstrapTier({ ...policy, ownerAllowlist: [] }), "", "empty allowlist is fail-closed, never 'any guild member'");
});

test("allowlist parsing: only snowflake ids survive", () => {
  assert.deepEqual(parseDiscordAllowlist("111111111111111111, foo, 222222222222222222"), ["111111111111111111", "222222222222222222"]);
  assert.deepEqual(parseDiscordAllowlist(["123"]), []);
  assert.deepEqual(parseDiscordAllowlist(""), []);
});

test("authorize URL carries identify+guilds scope and state", () => {
  const url = buildAuthorizeUrl({ clientId: "cid", redirectUri: "https://x/r", state: "st" });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("response_type"), "code");
  assert.equal(parsed.searchParams.get("scope"), "identify guilds guilds.members.read");
  assert.equal(parsed.searchParams.get("state"), "st");
  assert.equal(parsed.searchParams.get("client_id"), "cid");
});

test("oauthError carries a status code for routes", () => {
  const error = oauthError("no_access", "nope", 403);
  assert.equal(error.statusCode, 403);
  assert.equal(error.code, "no_access");
});


// ---- §2.1.1: console-native role -> tier, and the Discord-account 2FA gate ----

const HOME = "300000000000000001";
const ROLES = { owner: ["400000000000000001"], admin: ["400000000000000002"], moderator: ["400000000000000003"], player: ["400000000000000004"] };
function identity(overrides = {}) {
  return { userId: "200000000000000001", username: "op", guildIds: [HOME], roleIds: [], mfaEnabled: true, ...overrides };
}

test("roles: the highest mapped role the member holds decides the tier", async () => {
  const resolve = createOAuthTierResolver({ bootstrap: { homeGuildId: HOME }, roleTiers: ROLES });
  assert.deepEqual(await resolve(identity({ roleIds: ["400000000000000004", "400000000000000003"] })), { tier: "moderator", source: "roles", reason: "" });
  assert.deepEqual(await resolve(identity({ roleIds: ["400000000000000002"] })), { tier: "admin", source: "roles", reason: "" });
});

test("roles: no mapped role and no allowlist entry is a deny", async () => {
  const resolve = createOAuthTierResolver({ bootstrap: { homeGuildId: HOME }, roleTiers: ROLES });
  const r = await resolve(identity({ roleIds: ["999999999999999999"] }));
  assert.equal(r.tier, ""); assert.equal(r.reason, "not_authorized");
});

test("roles: only count for members of the home guild", async () => {
  const resolve = createOAuthTierResolver({ bootstrap: { homeGuildId: HOME }, roleTiers: ROLES });
  const r = await resolve(identity({ guildIds: ["300000000000000009"], roleIds: ["400000000000000001"] }));
  assert.equal(r.tier, "");
});

test("roles + allowlist: the stronger of the two wins", async () => {
  const resolve = createOAuthTierResolver({
    bootstrap: { homeGuildId: HOME, allowOwnerBootstrap: true, ownerAllowlist: ["200000000000000001"] },
    roleTiers: ROLES
  });
  const r = await resolve(identity({ roleIds: ["400000000000000004"] }));
  assert.equal(r.tier, "owner"); assert.equal(r.source, "bootstrap");
});

test("handoff configured: authoritative, roles are NOT consulted", async () => {
  const handoff = { enabled: true, async resolveTier() { return { tier: "", reason: "denied" }; } };
  const resolve = createOAuthTierResolver({ bootstrap: { homeGuildId: HOME }, roleTiers: ROLES, handoff });
  const r = await resolve(identity({ roleIds: ["400000000000000001"] }));
  assert.equal(r.tier, ""); assert.equal(r.source, "handoff");
});

test("handoff path ALSO enforces the console-side 2FA gate (regression: was silently skipped on the handoff branch)", async () => {
  // The bot returns admin, but the operator requires Discord 2FA for admin and
  // the user has it disabled -> denied with the would-be tier recorded. Before
  // the fix, mfaGateReason ran only on the non-handoff branch, so the gate was
  // silently unenforced for exactly the installs that run a handoff.
  const handoff = { enabled: true, async resolveTier() { return { tier: "admin" }; } };
  const resolve = createOAuthTierResolver({ bootstrap: { homeGuildId: HOME }, roleTiers: ROLES, handoff, requireMfaTiers: ["owner", "admin"] });
  const denied = await resolve(identity({ mfaEnabled: false }));
  assert.equal(denied.tier, ""); assert.equal(denied.source, "handoff");
  assert.equal(denied.reason, "mfa_required"); assert.equal(denied.deniedTier, "admin");
  // Same user WITH Discord 2FA on is granted the bot's tier.
  const ok = await resolve(identity({ mfaEnabled: true }));
  assert.equal(ok.tier, "admin"); assert.equal(ok.reason, "");
});

test("mfa gate: a gated tier without Discord 2FA is denied, with the tier it would have had recorded for audit", async () => {
  const resolve = createOAuthTierResolver({ bootstrap: { homeGuildId: HOME }, roleTiers: ROLES, requireMfaTiers: ["owner", "admin"] });
  const r = await resolve(identity({ roleIds: ["400000000000000002"], mfaEnabled: false }));
  assert.equal(r.tier, ""); assert.equal(r.reason, "mfa_required"); assert.equal(r.deniedTier, "admin");
  const ok = await resolve(identity({ roleIds: ["400000000000000004"], mfaEnabled: false }));
  assert.equal(ok.tier, "player", "ungated tiers are unaffected");
});

test("fetchDiscordIdentity reads member roles and mfa_enabled; a 404 member is simply no roles", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/users/@me")) return new Response(JSON.stringify({ id: "200000000000000001", username: "op", mfa_enabled: true }), { status: 200, headers: { "content-type": "application/json" } });
    if (String(url).endsWith("/users/@me/guilds")) return new Response(JSON.stringify([{ id: HOME }]), { status: 200, headers: { "content-type": "application/json" } });
    if (String(url).endsWith(`/users/@me/guilds/${HOME}/member`)) return new Response(JSON.stringify({ roles: ["400000000000000002", "bad"] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 500 });
  };
  const id = await fetchDiscordIdentity({ accessToken: "t", homeGuildId: HOME, apiBaseUrl: "https://api.test", fetchImpl });
  assert.deepEqual(id.roleIds, ["400000000000000002"]); assert.equal(id.mfaEnabled, true);
  assert.deepEqual(id.guilds, [{ id: HOME, name: "", owner: false }]); assert.deepEqual(id.ownedGuildIds, []);
  assert.ok(calls.some((u) => u.endsWith(`/guilds/${HOME}/member`)));

  const fetch404 = async (url) => String(url).endsWith("/member")
    ? new Response(JSON.stringify({ message: "Unknown Member", code: 10007 }), { status: 404, headers: { "content-type": "application/json" } })
    : fetchImpl(url);
  const id2 = await fetchDiscordIdentity({ accessToken: "t", homeGuildId: HOME, apiBaseUrl: "https://api.test", fetchImpl: fetch404 });
  assert.deepEqual(id2.roleIds, []);
});


test("owner is the Discord server's owner: derived from the guild list, above any role", async () => {
  const resolve = createOAuthTierResolver({ bootstrap: { homeGuildId: HOME }, roleTiers: ROLES });
  const r = await resolve(identity({ ownedGuildIds: [HOME], roleIds: ["400000000000000004"] }));
  assert.deepEqual(r, { tier: "owner", source: "guild-owner", reason: "" });
  // Owning a DIFFERENT guild confers nothing here.
  const other = await resolve(identity({ ownedGuildIds: ["300000000000000009"], roleIds: ["400000000000000004"] }));
  assert.equal(other.tier, "player");
});

test("no role can confer owner: an 'owner' key in the mapping is ignored", async () => {
  const resolve = createOAuthTierResolver({ bootstrap: { homeGuildId: HOME }, roleTiers: { ...ROLES, owner: ["400000000000000004"] } });
  const r = await resolve(identity({ roleIds: ["400000000000000004"] }));
  assert.equal(r.tier, "player");
});

test("pending state carries its purpose: a setup state is consumed as setup, a login state as login", () => {
  const store = createPendingStateStore();
  const setup = store.issue(undefined, { purpose: "setup", sessionId: "sess-1" });
  const login = store.issue();
  assert.deepEqual({ ...store.consume(setup.state, setup.state), verifier: "x" }, { ok: true, verifier: "x", purpose: "setup", sessionId: "sess-1" });
  assert.equal(store.consume(login.state, login.state).purpose, "login");
});

test("fetchDiscordIdentity marks owned guilds and keeps guild names for the setup picker", async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/users/@me")) return new Response(JSON.stringify({ id: "200000000000000001", username: "op" }), { status: 200, headers: { "content-type": "application/json" } });
    if (String(url).endsWith("/users/@me/guilds")) return new Response(JSON.stringify([{ id: HOME, name: "Fleetyard", owner: true }, { id: "300000000000000009", name: "Other", owner: false }]), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ roles: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const id = await fetchDiscordIdentity({ accessToken: "t", homeGuildId: HOME, apiBaseUrl: "https://api.test", fetchImpl });
  assert.deepEqual(id.ownedGuildIds, [HOME]);
  assert.deepEqual(id.guilds.map((g) => g.name), ["Fleetyard", "Other"]);
});

// ---- OAuth state cookie is always Secure (review finding) ----

test("oauth state cookie is always Secure: SameSite=None mandates Secure, independent of ADMIN_SECURE_COOKIES", () => {
  const set = oauthStateCookie("abc123");
  assert.match(set, /SameSite=None/);
  assert.match(set, /;\s*Secure/);
  assert.match(set, /HttpOnly/);
  // Old call sites pass config.secureCookies as a 2nd arg; a falsy value must
  // NOT be able to drop Secure (that dropped the cookie and broke every
  // Discord sign-in on the default ADMIN_SECURE_COOKIES=0 deploy).
  assert.match(oauthStateCookie("abc123", false), /;\s*Secure/);
  assert.match(clearOAuthStateCookie(), /SameSite=None/);
  assert.match(clearOAuthStateCookie(false), /;\s*Secure/);
});

// ---- pending-state store evicts expired entries (finding #6) ----

test("pending state store prunes EXPIRED entries at the top of issue(), independently of the LRU path", () => {
  const now = [1000];
  const store = createPendingStateStore({ now: () => now[0], ttlMs: 10_000, maxEntries: 2 });
  store.issue();
  store.issue();
  now[0] += 10_001; // both age past the TTL, never consumed
  const revived = store.issue();
  assert.notEqual(revived, null, "expired, never-consumed entries are pruned, so issuing works again");
  assert.equal(typeof revived.state, "string");
  assert.equal(store.size(), 1, "the two expired states were pruned (not merely LRU-evicted one at a time)");
});

// ---- buildAuthorizeUrl: prompt=none silent attempt (finding: silent re-auth) ----

test("buildAuthorizeUrl adds prompt=none only when asked, for a silent re-auth attempt", () => {
  const silent = buildAuthorizeUrl({ clientId: "c", redirectUri: "https://x/cb", state: "s", codeChallenge: "ch", prompt: "none" });
  assert.match(silent, /[?&]prompt=none(&|$)/);
  const interactive = buildAuthorizeUrl({ clientId: "c", redirectUri: "https://x/cb", state: "s", codeChallenge: "ch" });
  assert.doesNotMatch(interactive, /prompt=/);
});

// ---- review finding: a /discord/start flood from ONE client evicted OTHER
// users' fresh pending states (the store had no notion of who asked). ----
test("pending state: one owner's flood recycles only its own states, never another user's", () => {
  const now = [1_000_000];
  const store = createPendingStateStore({ now: () => now[0], maxEntries: 32, maxPerOwner: 4 });
  const victim = store.issue(undefined, { owner: "victim-ip" }).state;
  now[0] += 1;
  for (let i = 0; i < 300; i += 1) { store.issue(undefined, { owner: "attacker-ip" }); now[0] += 1; }
  assert.ok(store.size() <= 5, `attacker held ${store.size() - 1} states, cap is 4`);
  const result = store.consume(victim, victim, now[0]);
  assert.equal(result.ok, true, "the victim's earlier state must survive a single-owner flood");
});

test("pending state: when the table is full, the heaviest owner pays first", () => {
  const now = [1_000_000];
  const store = createPendingStateStore({ now: () => now[0], maxEntries: 8, maxPerOwner: 100 });
  const victim = store.issue(undefined, { owner: "victim-ip" }).state;   // oldest entry overall
  now[0] += 1;
  for (let i = 0; i < 7; i += 1) { store.issue(undefined, { owner: "flooder" }); now[0] += 1; }
  assert.equal(store.size(), 8);
  store.issue(undefined, { owner: "flooder" }); // full: evicts the flooder's own oldest, not the victim's
  assert.equal(store.consume(victim, victim, now[0]).ok, true);
});

test("pending state: anonymous (unowned) issuing still cannot grow past maxEntries", () => {
  const store = createPendingStateStore({ maxEntries: 4 });
  for (let i = 0; i < 10; i += 1) store.issue();
  assert.equal(store.size(), 4);
});
