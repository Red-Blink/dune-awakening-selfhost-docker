// autoInvite.js -- Core-side integration for the fully-automated hosted-bot
// auto-invite flow (dune-awakening-selfhost-docker#832's design, Phase 6,
// docs/design/hosted-bot-auto-invite-and-role-picker-l1-design-2026-09-10.md
// §4.1/§4.4/§4.5). Deliberately a SIBLING to hostedBotOAuth.js's existing
// "Connect to hosted bot" flow, not a modification of it -- both coexist
// until this new flow is confirmed working end-to-end (§9 Option B); this
// file's own routes/cookies use distinct names so the two flows can never
// be confused mid-flight, matching hostedBotOAuth.js's own stated
// convention for why IT is a sibling of oauth.js.
import { constantTimeStringEqual } from "./oauth.js";

const AUTO_INVITE_DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";

// One consent screen (design doc goal G1): bot install + applications.commands
// (matching the existing invite link's own scope) PLUS identify+guilds (new
// -- lets mentat independently re-verify guild ownership after this single
// consent, the same load-bearing security property /register's own flow
// already depends on). permissions=128 matches the existing static
// MENTAT_BOT_INVITE_URL's own value exactly -- not a new permission grant.
//
// clientId is a caller-supplied parameter (dune-awakening-selfhost-docker#903),
// not a bare module constant -- pass config.autoInviteDiscordClientId, which
// defaults to Sahir Venn's Discord Application (the correct value for every
// real deployment of this fork) but is env-overridable for a self-hoster
// running their own hosted-bot backend, matching every other hosted-bot
// config value's own pattern.
export function buildAutoInviteAuthorizeUrl({ redirectUri, state, clientId }) {
  const url = new URL(AUTO_INVITE_DISCORD_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", "bot applications.commands identify guilds");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("permissions", "128");
  return url.toString();
}

const AUTO_INVITE_PENDING_TTL_MS = 20 * 60 * 1000;
const AUTO_INVITE_MAX_PENDING = 256;

// createAutoInvitePendingStateStore: Core's OWN copy of "this state was
// issued by this console, still pending" -- consumed exactly once by
// /auto-invite/complete (design doc §4.5, hostedBotAutoInvitePendingStates).
// Deliberately NOT oauth.js's createPendingStateStore() reused as-is: this
// store never needs PKCE (Core itself never exchanges a code in this flow
// -- that happens entirely on mentat's side, see the design doc's own
// "why state alone, no PKCE, on the mentat leg" reasoning, §4.5), so a
// dedicated, simpler shape avoids carrying unused challenge/verifier
// fields through code that will never read them.
//
// TTL is deliberately generous (20 minutes, not the shorter windows
// elsewhere in this flow) -- per the design doc's own §4.5 note, this
// store must survive the FULL owner-confirmation wait (mentat's own
// pendingOwnerConfirmations store uses 15 minutes) plus slack for this
// console's own return-leg processing, not the much shorter 2-minute
// autoInviteSessions TTL that bounds mentat's OWN first-leg window.
// issue() takes MENTAT's own state value as input (returned by mentat-link's
// /auto-invite/start proxy call), rather than generating a fresh one of its
// own -- unlike the OLD flow's PKCE-based store, this one's state value is
// the SAME string that round-trips all the way through Discord's own
// consent screen and back through mentat's signed redirect (design doc
// §4.1's sequence diagram: "window.open(discord authorize URL,
// state=<mentat's state>, popup)"). Recording THAT exact value as the
// double-submit-cookie pair (rather than minting an unrelated second
// value Core would then need to separately correlate with mentat's) is
// simpler and no less secure: an attacker would need to forge a cookie
// matching a state value that ALSO exists as a genuine entry in this
// store, which only happens for a state this route itself actually
// issued via a real call to mentat-link.
export function createAutoInvitePendingStateStore({
  now = () => Date.now(),
  ttlMs = AUTO_INVITE_PENDING_TTL_MS,
  maxEntries = AUTO_INVITE_MAX_PENDING
} = {}) {
  const pending = new Map();

  function issue(state) {
    if (typeof state !== "string" || state.length === 0) return null;
    if (pending.size >= maxEntries) return null;
    pending.set(state, { createdAt: now(), used: false });
    return { state };
  }

  function consume(state, cookieValue, timestamp = now()) {
    if (typeof state !== "string" || state.length === 0 || state.length > 128) {
      return { ok: false, reason: "invalid_state" };
    }
    if (typeof cookieValue !== "string" || cookieValue.length === 0) {
      return { ok: false, reason: "missing_state_cookie" };
    }
    const entry = pending.get(state);
    pending.delete(state);
    if (!entry || entry.used) return { ok: false, reason: "missing_or_reused_state" };
    if (!constantTimeStringEqual(state, cookieValue)) return { ok: false, reason: "state_cookie_mismatch" };
    if (timestamp - entry.createdAt > ttlMs) return { ok: false, reason: "stale_state" };
    entry.used = true;
    return { ok: true };
  }

  return { issue, consume, size: () => pending.size };
}

// Distinct cookie name/path from hostedBotOAuthStateCookie() (the OLD
// flow's own state cookie) -- same reasoning as this file's own header
// comment: the two flows must never be confusable mid-flight. SameSite=Lax
// (not None, unlike the old flow's cookie): this cookie is read back on
// /auto-invite/complete, reached via a normal top-level browser navigation
// FROM mentat-link's bounce page (a client-side window.location assignment,
// the same category of navigation as clicking a same-site link) -- not a
// direct cross-site redirect from Discord itself the way the old flow's
// /oauth/callback is, so Lax is sufficient here.
export function autoInviteStateCookie(value, secure = true) {
  const securePart = secure ? "; Secure" : "";
  return `auto_invite_state=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/api/integrations/discord/hosted-bot/auto-invite; Max-Age=1200${securePart}`;
}

export function clearAutoInviteStateCookie(secure = true) {
  const securePart = secure ? "; Secure" : "";
  return `auto_invite_state=; HttpOnly; SameSite=Lax; Path=/api/integrations/discord/hosted-bot/auto-invite; Max-Age=0${securePart}`;
}

// Round 4 (dune-awakening-selfhost-docker#876, design doc §13). Layer 2
// audit finding: the new confirmation-status poll route only ever checked
// that confirmationId was non-empty, with no binding to the specific
// session/console that legitimately received it from /auto-invite/complete
// -- unlike EVERY other step of this flow, which double-submit-cookies its
// own opaque value (state above, handle in hostedBotOAuth.js). A GET
// request with no CSRF protection of its own, carrying only a valid
// session cookie (asc_session is SameSite=Lax, which DOES ride along on a
// cross-site top-level navigation, e.g. a crafted link or auto-redirecting
// page -- just not on cross-site subresource loads), could otherwise let
// an attacker who separately staged/knows a confirmationId (their own
// guild's, or one that leaked) trick a logged-in operator's browser into
// persisting an unrelated guild's connection into THIS console via
// persistHostedBotConnectedGuild() -- contradicting that function's own
// documented precondition that guildId is already verified against the
// caller's own owned-guild set before it's ever called. Same double-
// submit-cookie mechanism as autoInviteStateCookie above closes this: the
// cookie is set ONLY by /complete, when the browser is trusted to have
// its own legitimately-received confirmationId, and /confirmation-status
// then requires the presented value to match it.
export function autoInviteConfirmationIdCookie(value, secure = true) {
  const securePart = secure ? "; Secure" : "";
  return `auto_invite_confirmation_id=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/api/integrations/discord/hosted-bot/auto-invite; Max-Age=1200${securePart}`;
}

export function clearAutoInviteConfirmationIdCookie(secure = true) {
  const securePart = secure ? "; Secure" : "";
  return `auto_invite_confirmation_id=; HttpOnly; SameSite=Lax; Path=/api/integrations/discord/hosted-bot/auto-invite; Max-Age=0${securePart}`;
}

// autoInviteCompletePage: the popup's own return page (design doc §4.1:
// "Core-->>Op: Small return page (mirrors existing hostedBotOAuthReturnPage()),
// auto-closes popup"). Deliberately DIFFERENT closing behavior from
// hostedBotOAuthReturnPage() above: that one does a full top-level
// window.location.replace("/") because the OLD flow's own OAuth round trip
// is NOT a popup; THIS flow's whole point (design doc goal G1) is a SINGLE
// popup covering bot-invite + ownership verification, so its own return
// leg must close the popup and hand the outcome back to the opener, not
// navigate the popup itself anywhere.
//
// Uses postMessage rather than openBotInviteWindow()'s existing bare
// `.closed`-poll pattern -- that mechanism can only tell the opener "the
// popup closed," with no way to carry WHICH outcome (ok/guildName/reason/
// reclaimed) occurred. The visible on-page text is deliberately a FIXED,
// generic string (never guildName/reason interpolated into raw HTML) --
// the real outcome data only ever reaches the opener via the JSON-encoded
// postMessage payload, which Core's own React app renders using JSX's own
// auto-escaping, sidestepping any HTML-escaping-discipline risk here
// entirely rather than relying on getting it right in this template
// string. postMessage's targetOrigin is this page's own window.location.origin
// (never "*") -- the opener is always this exact same console origin.
// Round 4 (dune-awakening-selfhost-docker#876, design doc §13, issue #879):
// confirmationId added to this postMessage payload -- this popup self-closes
// ~1.2s after loading, so this is the ONLY hop where the opener window can
// ever pick up the value it needs to later poll
// /api/integrations/discord/hosted-bot/auto-invite/confirmation-status.
export function autoInviteCompletePage({ ok, guildName = "", reason = "", reclaimed = false, confirmationId = "" }) {
  const payload = { ok: Boolean(ok), guildName: String(guildName), reason: String(reason), reclaimed: Boolean(reclaimed), confirmationId: String(confirmationId) };
  const safeJson = JSON.stringify(payload).replace(/</g, "\\u003c");
  const message = ok ? "Request sent — check Discord to confirm the connection." : "Could not connect. Check the console for details.";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Connecting…</title></head><body><p>${message}</p><noscript><p>Close this window and return to the console.</p></noscript><script>
var result = ${safeJson};
try {
  if (window.opener) {
    window.opener.postMessage({ type: "hosted-bot-auto-invite-complete", result: result }, window.location.origin);
  }
} catch (e) {}
setTimeout(function () { window.close(); }, 1200);
</script></body></html>`;
}
