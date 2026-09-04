// Console "Sign in with Discord" OAuth (console RBAC, Phase 2).
//
// This module is intentionally decoupled from Express/server.js: it exposes
// a small state machine and pure helpers so unit tests can drive every
// failure path with an injected fetch stub, and server.js only wires
// routes/rate-limiting/cookies/audit around it. Nothing here trusts request
// bodies for identity or tier — the Discord /users/@me response is the
// single source of identity, and role/tier resolution is deliberately not
// performed in this phase (Phase 3's signed handoff owns that).
//
// Security posture (see docs/security/console-rbac-implementation-and-testing.md):
// - authorization-code flow with short-lived, single-use, cookie-bound state
// - access token is used once for /users/@me then discarded (never stored)
// - membership + explicit operator gates before any owner-tier session
// - fail closed: any missing/invalid input yields no session, never a partial one

import { resolveRoleTier, higherTier, mfaGateReason } from "./roleTiers.js";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";

export const DISCORD_OAUTH_BASE_URL = "https://discord.com/api/v10";
export const DISCORD_OAUTH_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
// guilds.members.read lets the console read the signed-in member's own roles
// in the home guild (rfc-console-auth.md §2.1.1). Operators who authorized
// under the older "identify guilds" scope are asked by Discord to re-authorize
// once.
export const OAUTH_SCOPES = "identify guilds guilds.members.read";
export const STATE_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING_STATES = 256;
// A single client (keyed by the caller, normally its address) may hold at most
// this many fresh, unconsumed states. Past it, that client's own oldest state
// is evicted -- never anyone else's -- so a /discord/start loop from one
// address cannot push another user's in-flight sign-in out of the table.
export const MAX_PENDING_PER_OWNER = 16;

export function oauthError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

// ---- Pending-state store ----
export function createPendingStateStore({
  now = () => Date.now(),
  ttlMs = STATE_TTL_MS,
  maxEntries = MAX_PENDING_STATES,
  maxPerOwner = MAX_PENDING_PER_OWNER
} = {}) {
  const pending = new Map();

  // `purpose` is "login" (mint a tiered session) or "setup" (first-run wizard:
  // fetch identity only, mint nothing, hand the guild list back to the owner
  // session identified by `sessionId`). It travels with the pending state so a
  // login-purpose callback can never be replayed as setup or vice versa.
  function issue(random = randomBytes, { purpose = "login", sessionId = "", owner = "" } = {}) {
    // Evict used and expired entries before the size check. Without this, an
    // unauthenticated flood of /discord/start requests that never complete a
    // callback fills the table permanently (entries are only marked used /
    // aged out inside consume(), which such a flood never reaches) -> issue()
    // returns null forever -> Discord sign-in DoS until the process restarts.
    const cutoff = now();
    for (const [key, entry] of pending) {
      if (entry.used || cutoff - entry.createdAt > ttlMs) pending.delete(key);
    }
    // Per-owner cap first: a client already holding maxPerOwner fresh states
    // recycles its own oldest one. This is what stops one address from evicting
    // anyone else -- the store has no other notion of who asked.
    const evictOldest = (predicate) => {
      let oldestKey; let oldestAt = Infinity;
      for (const [key, entry] of pending) {
        if (predicate(entry) && entry.createdAt < oldestAt) { oldestAt = entry.createdAt; oldestKey = key; }
      }
      if (oldestKey !== undefined) pending.delete(oldestKey);
      return oldestKey !== undefined;
    };
    if (owner) {
      let held = 0;
      for (const entry of pending.values()) if (entry.owner === owner) held += 1;
      if (held >= maxPerOwner) evictOldest((entry) => entry.owner === owner);
    }
    if (pending.size >= maxEntries) {
      // Still full after evicting used/expired means the table is full of FRESH,
      // not-yet-completed states from many owners. Rather than reject every new
      // sign-in until the TTL ages them out (the hard DoS this guards against),
      // evict the oldest state of whichever owner holds the MOST -- a
      // distributed flood pays with its own states first -- and only fall back
      // to the globally oldest when every owner holds one.
      const counts = new Map();
      for (const entry of pending.values()) counts.set(entry.owner, (counts.get(entry.owner) || 0) + 1);
      let heaviest = ""; let heaviestCount = 0;
      for (const [who, count] of counts) if (count > heaviestCount) { heaviestCount = count; heaviest = who; }
      if (!(heaviestCount > 1 && evictOldest((entry) => entry.owner === heaviest))) evictOldest(() => true);
    }
    const state = random(16).toString("base64url");
    const verifier = random(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    pending.set(state, { createdAt: now(), used: false, verifier, challenge, purpose, sessionId, owner });
    return { state, challenge };
  }

  // PKCE-enabled consume: returns code_verifier on success.
  function consume(state, cookieValue, timestamp = now()) {
    if (typeof state !== "string" || state.length === 0 || state.length > 128) {
      return { ok: false, reason: "invalid_state" };
    }
    if (typeof cookieValue !== "string" || cookieValue.length === 0) {
      return { ok: false, reason: "missing_pending_cookie" };
    }
    const entry = pending.get(state);
    pending.delete(state);
    if (!entry || entry.used) return { ok: false, reason: "missing_or_reused_state" };
    if (!constantTimeStringEqual(state, cookieValue)) return { ok: false, reason: "state_cookie_mismatch" };
    if (timestamp - entry.createdAt > ttlMs) return { ok: false, reason: "stale_state" };
    entry.used = true;
    return { ok: true, verifier: entry.verifier, purpose: entry.purpose || "login", sessionId: entry.sessionId || "" };
  }

  return { issue, consume, size: () => pending.size };
}

function constantTimeStringEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length === 0) return false;
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- Discord HTTP helpers (injected fetchImpl for tests) ----
const DISCORD_HTTP_TIMEOUT_MS = 5_000;
async function discordJsonRequest(url, init, { fetchImpl, label }) {
  let response;
  // Bound every outbound Discord call (parity with handoff.js). Without this a
  // discord.com brownout or an operator's egress-drop firewall hangs the whole
  // request for undici's multi-minute default -- a real DoS on the auth path.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCORD_HTTP_TIMEOUT_MS);
  try {
    response = await fetchImpl(url, { ...init, signal: controller.signal });
    clearTimeout(timer);
  } catch {
    clearTimeout(timer);
    throw oauthError("discord_unreachable", `Discord ${label} request failed.`, 502);
  }
  if (!response.ok) {
    const rejected = oauthError("oauth_upstream_error", `Discord rejected the ${label} request (HTTP ${response.status}).`, 502);
    rejected.upstreamStatus = response.status; // callers may treat 403/404 as "not a member", never as "sign-in failed"
    throw rejected;
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw oauthError("oauth_bad_response", `Discord returned a malformed ${label} response.`, 502);
  }
  if (payload === null || payload === undefined || (typeof payload !== "object")) {
    throw oauthError("oauth_bad_response", `Discord returned a malformed ${label} response.`, 502);
  }
  return payload;
}

export async function exchangeDiscordAuthCode({
  code,
  redirectUri,
  clientId,
  clientSecret,
  codeVerifier,
  apiBaseUrl = DISCORD_OAUTH_BASE_URL,
  fetchImpl = globalThis.fetch
}) {
  if (typeof code !== "string" || code.length === 0 || code.length > 1024) {
    throw oauthError("missing_code", "Missing Discord authorization code.", 400);
  }
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code: code.trim(),
    redirect_uri: redirectUri
  });
  if (codeVerifier) params.set("code_verifier", codeVerifier);
  const token = await discordJsonRequest(`${apiBaseUrl}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString()
  }, { fetchImpl, label: "token" });
  if (typeof token.access_token !== "string" || token.access_token.length === 0 || token.access_token.length > 1000) {
    throw oauthError("oauth_missing_token", "Discord token response did not include an access token.", 502);
  }
  return token;
}

export async function fetchDiscordIdentity({ accessToken, homeGuildId = "", apiBaseUrl = DISCORD_OAUTH_BASE_URL, fetchImpl = globalThis.fetch }) {
  const [user, guilds] = await Promise.all([
    discordJsonRequest(`${apiBaseUrl}/users/@me`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
    }, { fetchImpl, label: "identity" }),
    discordJsonRequest(`${apiBaseUrl}/users/@me/guilds`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
    }, { fetchImpl, label: "guilds" })
  ]);
  const userId = String(user?.id || "");
  const username = String(user?.username || "");
  // Discord's newer display name (global_name) is what users recognize
  // ("Dark Dante"); fall back to the legacy username handle if absent.
  const displayName = String(user?.global_name || user?.username || "").slice(0, 64);
  if (!/^\d{17,19}$/.test(userId)) {
    throw oauthError("oauth_bad_identity", "Discord identity response is missing a valid user id.", 502);
  }
  if (username.length === 0 || username.length > 64) {
    throw oauthError("oauth_bad_identity", "Discord identity response is missing a username.", 502);
  }
  // Partial guild objects from /users/@me/guilds carry `owner: true` for the
  // guild the user owns (exactly one owner per guild, by Discord's rule) --
  // this is how the console decides Owner, with no configuration.
  const guildList = (Array.isArray(guilds) ? guilds : [])
    .map((guild) => ({ id: String(guild?.id || ""), name: String(guild?.name || "").slice(0, 100), owner: guild?.owner === true }))
    .filter((guild) => /^\d{17,19}$/.test(guild.id));
  const guildIds = guildList.map((guild) => guild.id);
  const ownedGuildIds = guildList.filter((guild) => guild.owner).map((guild) => guild.id);
  const mfaEnabled = user?.mfa_enabled === true;
  // Member roles for the home guild, from the user's own token. Only asked for
  // when a home guild is configured and the user is in it; a 403/404 here means
  // "not a member" and yields no roles rather than failing sign-in.
  let roleIds = [];
  if (/^\d{17,19}$/.test(homeGuildId) && guildIds.includes(homeGuildId)) {
    try {
      const member = await discordJsonRequest(`${apiBaseUrl}/users/@me/guilds/${homeGuildId}/member`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
      }, { fetchImpl, label: "member" });
      roleIds = Array.isArray(member?.roles) ? member.roles.map((id) => String(id)).filter((id) => /^\d{17,19}$/.test(id)) : [];
    } catch (error) {
      if (error?.upstreamStatus !== 403 && error?.upstreamStatus !== 404) throw error;
    }
  }
  return { userId, username, displayName, guildIds, guilds: guildList, ownedGuildIds, roleIds, mfaEnabled };
}

// ---- Tier decision (Phase 3: signed handoff, authoritative when configured) ----
// Phase 2 resolveBootstrapTier is kept as a pure first-owner-bootstrap
// function — it only ever produces "owner" or "" and applies only to
// installs that have never configured a handoff at all. When the handoff
// is configured its result is authoritative: an empty result means deny
// (bot unreachable, or bot said no), never "fall through to the static
// allowlist" (rfc-console-auth.md §1.1/§2.1 — the previous fallthrough
// silently restored owner access from a stale allowlist entry whenever
// the bot had any hiccup).
export function resolveBootstrapTier({ userId, guildIds, allowOwnerBootstrap, homeGuildId, ownerAllowlist = [] }) {
  if (!allowOwnerBootstrap) return "";
  if (!homeGuildId) return "";
  if (!guildIds.includes(homeGuildId)) return "";
  if (!ownerAllowlist.includes(userId)) return "";
  return "owner";
}

// Resolves to { tier, source, reason }. source is "handoff" or
// "bootstrap"; reason is "" on success and names the denial cause for
// the audit log only — it must never influence the authorization
// decision, which is tier-empty-means-deny regardless of reason.
export function createOAuthTierResolver({ bootstrap = {}, handoff = null, roleTiers = null, requireMfaTiers = [] } = {}) {
  return async function resolveOAuthTier(identity) {
    const { userId, guildIds, roleIds = [], ownedGuildIds = [], mfaEnabled = false } = identity;

    // A configured handoff stays authoritative (§2.1): the bot is the single
    // source of truth for operators who run one, and this resolver must never
    // produce a second, competing answer beside it.
    if (handoff && handoff.enabled) {
      const { tier, reason } = await handoff.resolveTier({ userId, username: identity.username });
      if (!tier) return { tier: "", source: "handoff", reason: reason || "denied" };
      // The bot is authoritative for WHICH tier, but the operator's console-side
      // 2FA gate (DISCORD_OAUTH_REQUIRE_MFA_TIERS) is a separate policy layered
      // on top of that tier, not a competing tier source -- so it must apply on
      // the handoff path too. Otherwise the gate is silently unenforced for
      // exactly the production installs that run a handoff (the recommended
      // path), and a user with Discord 2FA disabled is granted owner/admin the
      // operator meant to deny. identity.mfaEnabled is available here.
      const mfaReason = mfaGateReason(tier, mfaEnabled, requireMfaTiers);
      if (mfaReason) return { tier: "", source: "handoff", reason: mfaReason, deniedTier: tier };
      return { tier, source: "handoff", reason: "" };
    }

    const bootstrapTier = resolveBootstrapTier({
      userId,
      guildIds,
      allowOwnerBootstrap: bootstrap.allowOwnerBootstrap || false,
      homeGuildId: bootstrap.homeGuildId || "",
      ownerAllowlist: bootstrap.ownerAllowlist || []
    });
    // Roles count only for members of the home guild; fetchDiscordIdentity
    // already returns no roles otherwise, but the membership check is repeated
    // here so the decision does not depend on how identity was assembled.
    const inHomeGuild = Boolean(bootstrap.homeGuildId) && guildIds.includes(bootstrap.homeGuildId);
    // Owner = the Discord server's owner (§2.1.1), derived from Discord itself.
    const guildOwnerTier = inHomeGuild && ownedGuildIds.includes(bootstrap.homeGuildId) ? "owner" : "";
    const roleTier = inHomeGuild ? resolveRoleTier(roleIds, roleTiers) : "";
    const tier = higherTier(guildOwnerTier, higherTier(bootstrapTier, roleTier));
    const source = guildOwnerTier ? "guild-owner" : (tier === roleTier && roleTier ? "roles" : "bootstrap");
    if (!tier) return { tier: "", source, reason: "not_authorized" };

    // Discord-account 2FA gate (§2.1.1 item 4): reuses the factor the user
    // already carries for Discord instead of adding an enrollment on top of OAuth.
    const mfaReason = mfaGateReason(tier, mfaEnabled, requireMfaTiers);
    if (mfaReason) return { tier: "", source, reason: mfaReason, deniedTier: tier };
    return { tier, source, reason: "" };
  };
}

export function parseDiscordAllowlist(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return list.map((item) => String(item || "").trim()).filter((item) => /^\d{17,19}$/.test(item));
}

export function buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge, prompt }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES,
    state
  });
  if (codeChallenge) {
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  // prompt=none asks Discord to complete SILENTLY when the user is already
  // signed in to Discord and has authorized these scopes (no visible screen).
  // If it can't, Discord returns ?error=login_required|consent_required|
  // interaction_required (no code), which the callback retries interactively.
  // Omitted -> Discord's default (interactive) flow.
  if (prompt) params.set("prompt", prompt);
  return `${DISCORD_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

// The pending OAuth state is bound to a short-lived, path-scoped cookie so a
// third-party site cannot start a login and complete it in a victim's
// browser (login CSRF). SameSite=None; Secure + HttpOnly; cleared after the callback.
export function oauthStateCookie(value) {
  // SameSite=None is required so the cookie survives the cross-site
  // Discord -> console callback redirect (a SameSite=Lax cookie is dropped on
  // that top-level navigation -- a real past incident). SameSite=None in turn
  // *mandates* Secure, so this cookie is ALWAYS Secure, independent of
  // ADMIN_SECURE_COOKIES: Discord OAuth therefore requires an HTTPS-terminating
  // front end. Emitting SameSite=None without Secure (the old behavior when
  // ADMIN_SECURE_COOKIES=0, the shipped default) made browsers drop the cookie
  // and broke every Discord sign-in.
  return `discord_oauth_state=${encodeURIComponent(value)}; HttpOnly; SameSite=None; Path=/api/auth/discord/callback; Max-Age=600; Secure`;
}

export function clearOAuthStateCookie() {
  return `discord_oauth_state=; HttpOnly; SameSite=None; Path=/api/auth/discord/callback; Max-Age=0; Secure`;
}
