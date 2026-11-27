// #1355: live re-validation of Discord-derived console sessions.
//
// A session's tier is fixed at sign-in. Without this, removing someone's Discord role (or
// kicking them from the guild) leaves their console session working until it expires. This
// keeps each session's Discord access token in memory only (never persisted, never logged)
// and re-resolves identity + tier on a short interval:
//   - tier changed       -> session tier updated in place (a demotion takes effect at once)
//   - token rejected (401/403/404) or no tier (role removed, left the guild)
//     -> revoked on the second consecutive sweep (a one-off Discord blip must not sign people out)
//   - Discord or the handoff unreachable (network, 5xx, handoff "unreachable") -> keep the
//     session for up to `staleGraceMs`, then revoke. An outage must neither lock everyone out
//     at once nor let a removed user ride it out indefinitely.
// Sessions with no token held (e.g. persisted across a restart) cannot be re-checked, so they
// are revoked at the first sweep: fail closed.
export function createSessionRevalidator({
  auth, fetchIdentity, resolveTier, intervalMs, staleGraceMs = 5 * 60 * 1000,
  now = Date.now, audit = () => {}, setTimer = setInterval, clearTimer = clearInterval
}) {
  const tokens = new Map(); // session id -> { accessToken, lastOkAt }
  let timer = null;
  let running = false;

  const remember = (sessionId, accessToken) => {
    if (sessionId && accessToken) tokens.set(sessionId, { accessToken, lastOkAt: now() });
  };

  // oauth.js tags a Discord HTTP rejection with `upstreamStatus`; anything without it
  // (network error, timeout, malformed body) is treated as transient.
  const upstream = (error) => Number(error?.upstreamStatus);
  const isRevoked = (error) => [401, 403, 404].includes(upstream(error));
  // A handoff answer that means "the bot could not answer", not "the bot said no".
  const handoffOutage = (reason) => reason === "unreachable" || reason === "malformed_response" || reason === "http_429" || /^http_5\d\d$/.test(String(reason));
  // One strike per denial; two in a row revoke. Returns "kept" or the revoke result.
  const strike = (entry, held, reason) => {
    held.denials = (held.denials || 0) + 1;
    return held.denials >= 2 ? revoke(entry, reason) : "kept";
  };

  async function checkOne(entry) {
    const held = tokens.get(entry.id);
    if (!held) return revoke(entry, "no_token_held");
    let identity;
    try {
      identity = await fetchIdentity(held.accessToken);
    } catch (error) {
      // 401/403 can also be an IP ban or a missing scope, so it takes two in a row like any denial.
      if (isRevoked(error)) return strike(entry, held, "token_revoked");
      return transient(entry, held, "discord_unreachable");
    }
    let resolved;
    try {
      resolved = await resolveTier(identity);
    } catch {
      return transient(entry, held, "resolver_error");
    }
    if (!resolved?.tier) {
      if (identity?.roleLookupFailed) return transient(entry, held, "role_lookup_failed"); // Discord outage, not a removed role
      if (resolved?.source === "handoff" && handoffOutage(resolved.reason)) return transient(entry, held, "handoff_unreachable");
      return strike(entry, held, resolved?.reason || "no_longer_authorized");
    }
    held.denials = 0;
    held.lastOkAt = now();
    if (resolved.tier !== entry.tier && auth.setSessionTier(entry.id, resolved.tier)) {
      audit("auth.session.tier-changed", { userId: entry.userId, from: entry.tier, to: resolved.tier });
    }
    return "ok";
  }

  function transient(entry, held, reason) {
    if (now() - held.lastOkAt > staleGraceMs) return revoke(entry, `${reason}_grace_exceeded`);
    return "kept";
  }

  function revoke(entry, reason) {
    auth.invalidateSession(entry.id);
    tokens.delete(entry.id);
    audit("auth.session.revoked", { userId: entry.userId, tier: entry.tier, reason });
    return "revoked";
  }

  async function sweep() {
    if (running) return;
    running = true;
    try {
      const live = auth.listSessions().filter((s) => s.userId && !s.scope);
      const liveIds = new Set(live.map((s) => s.id));
      for (const id of tokens.keys()) if (!liveIds.has(id)) tokens.delete(id); // expired/signed out
      for (const entry of live) {
        try { await checkOne(entry); } catch { /* one bad session never stops the sweep */ }
      }
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer || !(intervalMs > 0)) return;
    timer = setTimer(() => { sweep(); }, intervalMs);
    timer.unref?.();
  }
  function stop() { if (timer) { clearTimer(timer); timer = null; } }

  return { remember, sweep, start, stop, _tokens: tokens };
}
