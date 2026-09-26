// hostedBotOAuth.js -- the "Connect to hosted bot" OAuth purpose. Deliberately
// a sibling to oauth.js (console-login OAuth), not a modification of it: this
// flow's callback must keep the `owner` field Discord returns per guild
// (oauth.js's own fetchDiscordIdentity() discards it, since console-login
// only ever needs guild-membership, not ownership), and needs its own cookie
// names/paths so the two flows can never be confused mid-flight.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { constantTimeStringEqual } from "./oauth.js";

export const HOSTED_BOT_DISCORD_API_BASE_URL = "https://discord.com/api/v10";
export const HOSTED_BOT_REGISTRATION_TTL_MS = 10 * 60 * 1000;
export const HOSTED_BOT_MAX_PENDING_REGISTRATIONS = 256;

// Layer 3 audit finding (HIGH): this was a bare `await fetchImpl(...)` with
// no bound at all, unlike oauth.js's near-identical discordJsonRequest()
// (5s timeout, added specifically because a discord.com brownout or an
// operator's egress-drop firewall would otherwise hang the request for
// undici's multi-minute default -- a real DoS on the auth path, per that
// file's own comment). This flow's /users/@me and /users/@me/guilds calls
// during the hosted-bot OAuth callback had the identical exposure. Same
// 5s bound, same AbortController pattern; this file's own simpler
// Error+code/statusCode convention kept rather than switching to oauth.js's
// oauthError() helper.
const DISCORD_HTTP_TIMEOUT_MS = 5_000;
async function discordJsonRequest(url, init, { fetchImpl, label }) {
  let response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCORD_HTTP_TIMEOUT_MS);
  try {
    response = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    throw Object.assign(new Error(`Discord ${label} request failed.`), { code: "discord_unreachable", statusCode: 502 });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw Object.assign(new Error(`Discord rejected the ${label} request (HTTP ${response.status}).`), { code: "oauth_upstream_error", statusCode: 502 });
  }
  return response.json();
}

// fetchOwnedDiscordGuilds: a sibling to oauth.js's fetchDiscordIdentity(),
// kept separate because this one deliberately KEEPS the `owner` field
// Discord's own /users/@me/guilds response carries per guild -- the
// console-login flow's fetchDiscordIdentity() discards it, since login only
// ever needs membership, not ownership. Discord's `owner: true` means the
// literal Discord "Server Owner" for that guild, not merely an admin.
export async function fetchOwnedDiscordGuilds({ accessToken, apiBaseUrl = HOSTED_BOT_DISCORD_API_BASE_URL, fetchImpl = globalThis.fetch }) {
  const [user, guilds] = await Promise.all([
    discordJsonRequest(`${apiBaseUrl}/users/@me`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
    }, { fetchImpl, label: "identity" }),
    discordJsonRequest(`${apiBaseUrl}/users/@me/guilds`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
    }, { fetchImpl, label: "guilds" })
  ]);
  const userId = String(user?.id || "");
  const ownedGuilds = Array.isArray(guilds)
    ? guilds
        .filter((guild) => guild && guild.owner === true && /^\d{17,19}$/.test(String(guild.id || "")))
        .map((guild) => ({ id: String(guild.id), name: String(guild.name || "Unknown"), owner: true }))
    : [];
  return { userId, guilds: ownedGuilds };
}

// createPendingRegistrationStore: the token-custody fix from the L1 audit's
// CRITICAL finding. Modeled directly on oauth.js's own createPendingStateStore
// -- same shape (Map, capacity cap, TTL, single-use-on-read), but this store
// holds a live Discord access token + the caller's owned-guild IDs + userId,
// not a PKCE verifier. The browser only ever holds the returned `handle`
// (in a dedicated cookie, via hostedBotRegistrationHandleCookie below) --
// never the token itself.
export function createPendingRegistrationStore({
  now = () => Date.now(),
  ttlMs = HOSTED_BOT_REGISTRATION_TTL_MS,
  maxEntries = HOSTED_BOT_MAX_PENDING_REGISTRATIONS
} = {}) {
  const pending = new Map();

  function issue({ accessToken, ownedGuildIds, userId }) {
    if (pending.size >= maxEntries) return null;
    const handle = randomBytes(24).toString("base64url");
    pending.set(handle, { createdAt: now(), used: false, accessToken, ownedGuildIds, userId });
    return { handle };
  }

  function consume(handle, cookieValue, timestamp = now()) {
    if (typeof handle !== "string" || handle.length === 0 || handle.length > 128) {
      return { ok: false, reason: "invalid_handle" };
    }
    if (typeof cookieValue !== "string" || cookieValue.length === 0) {
      return { ok: false, reason: "missing_handle_cookie" };
    }
    const entry = pending.get(handle);
    pending.delete(handle);
    if (!entry || entry.used) return { ok: false, reason: "missing_or_reused_handle" };
    if (!constantTimeStringEqual(handle, cookieValue)) return { ok: false, reason: "handle_cookie_mismatch" };
    if (timestamp - entry.createdAt > ttlMs) return { ok: false, reason: "stale_handle" };
    entry.used = true;
    return { ok: true, entry };
  }

  return { issue, consume, size: () => pending.size };
}

// Deliberately a distinct name/path from oauth.js's own oauthStateCookie
// (Path=/api/auth/discord/callback) -- the two flows must never be
// confusable mid-flight, and this flow's own callback lives at a different
// path.
//
// Layer 3 audit finding (CRITICAL): unlike oauth.js's own oauthStateCookie()
// (which hardcodes Secure unconditionally, with its own comment explaining
// why), these two functions used to accept a `secure` parameter and gated
// the Secure attribute on it -- and docker-compose.web.yml's own default,
// ADMIN_SECURE_COOKIES:-0, means config.secureCookies (the value every real
// call site passed in) is false on every fresh install using documented
// defaults. SameSite=None without Secure is not just weaker; per the Cookie
// spec (and confirmed in every modern browser) it is REJECTED outright --
// the cookie is never even stored, so this hosted-bot OAuth flow's state
// cookie never survives the Discord->console redirect on any default
// install. Same root-cause class as this org's own documented incident
// (a SameSite=Lax state cookie silently dropped across a cross-site
// redirect, Strict Requirement 19(e)) -- fixed the same way oauth.js
// already was: Secure is no longer conditional for a SameSite=None cookie.
export function hostedBotOAuthStateCookie(value) {
  return `hosted_bot_oauth_state=${encodeURIComponent(value)}; HttpOnly; SameSite=None; Path=/api/integrations/discord/hosted-bot/oauth/callback; Max-Age=600; Secure`;
}

export function clearHostedBotOAuthStateCookie() {
  return `hosted_bot_oauth_state=; HttpOnly; SameSite=None; Path=/api/integrations/discord/hosted-bot/oauth/callback; Max-Age=0; Secure`;
}

// The registration-handle cookie is scoped to the whole /api/integrations/discord/hosted-bot/
// path (not just /callback) since /register (a different route under the
// same prefix) must also be able to read it.
export function hostedBotRegistrationHandleCookie(value, secure = true) {
  const securePart = secure ? "; Secure" : "";
  return `hosted_bot_registration_handle=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/api/integrations/discord/hosted-bot; Max-Age=600${securePart}`;
}

export function clearHostedBotRegistrationHandleCookie(secure = true) {
  const securePart = secure ? "; Secure" : "";
  return `hosted_bot_registration_handle=; HttpOnly; SameSite=Lax; Path=/api/integrations/discord/hosted-bot; Max-Age=0${securePart}`;
}

// hostedBotOAuthReturnPage: a sibling to server.js's own oauthReturnPage(),
// which takes no arguments and embeds nothing. This one MUST embed the
// owned-guilds list (id/name/owner only -- never the token, never the
// handle, which is already in a cookie the SPA doesn't need to read
// directly) so the SPA can render the guild picker without a second round
// trip. JSON.stringify + a basic HTML-escape on the whole blob defends
// against a guild name containing `</script>` (Discord guild names are
// free text, not snowflakes).
//
// Final integration review (CRITICAL): this used to stash the list on a
// plain `window.__hostedBotOwnedGuilds__` property before calling
// `window.location.replace("/")`. That's a full document navigation -- the
// SPA loads into a brand-new `window`, so a property set on THIS window is
// already gone before the SPA's own reader ever runs. `sessionStorage` is
// the fix: it's keyed by origin, not by `window`, so it survives a
// same-origin navigation like this one. It still never carries the Discord
// access token or the registration handle -- only the same safe
// {id,name,owner} list the old mechanism carried. The value is assigned to
// a local variable first and re-serialized via the browser's own
// JSON.stringify before being handed to sessionStorage.setItem (which only
// accepts strings) -- this avoids manually double-escaping `safeJson`
// (already a JSON string) into a second string literal.
//
// Fix round 2 (Priority 3): the sessionStorage.setItem call itself is
// wrapped in try/catch, matching the guard readOwnedGuilds() (the read
// side, discordHostedBotApi.ts) already has. In any browser context where
// storage access throws (blocked/partitioned third-party-ish storage in
// some private-browsing modes, storage quota, etc.), an unguarded
// sessionStorage.setItem would throw INSIDE this inline script, which
// aborts the script before the following window.location.replace("/") --
// stranding the operator on a blank callback page with no way forward
// except the <noscript> fallback link (which requires JS to be disabled
// entirely, not just storage). The navigation must always happen
// regardless of whether the stash succeeded; readOwnedGuilds() already
// degrades to [] on a missing/malformed value, so a failed stash here just
// means an empty guild picker on the other side, not a stranded page.
export function hostedBotOAuthReturnPage(ownedGuilds) {
  const safeJson = JSON.stringify(ownedGuilds || []).replace(/</g, "\\u003c");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Connect to hosted bot</title></head><body><noscript><a href="/">Return to the console</a></noscript><script>var hostedBotOwnedGuilds = ${safeJson}; try { sessionStorage.setItem("hostedBotOwnedGuilds", JSON.stringify(hostedBotOwnedGuilds)); } catch (e) {} window.location.replace("/");</script></body></html>`;
}
