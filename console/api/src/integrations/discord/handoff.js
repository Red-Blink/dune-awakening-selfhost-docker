// Signed tier handoff between a companion bot and the console.
//
// A companion bot resolves a Discord user's effective console tier for
// the configured home guild and returns a signed handoff payload. The
// console verifies the HMAC before trusting any tier claim — fail-closed.
// No unsigned claim may
// ever produce a tiered session.
//
// Payload (the bot signs this shape):
//   { userId: string, guildId: string, tier: Tier, ts: number }
//
// Signature: HMAC-SHA256(sharedSecret, JSON.stringify(payload)) as hex.
//
// Max age: 30 s — a handoff is a real-time assertion, not a durable token.
// The console calls the bot anew on every login; the timestamp prevents
// replays within the window.

import { createHmac, timingSafeEqual } from "node:crypto";

const VALID_TIERS = new Set(["owner", "admin", "moderator", "player"]);
const USER_SNOWFLAKE_RE = /^\d{17,19}$/;
const MAX_HANDOFF_AGE_MS = 30_000;
const HTTP_TIMEOUT_MS = 5_000;

// ---- Public API ----

export function createHandoff(config) {
  const { secret, botUrl, homeGuildId } = config;
  // A handoff attempt is signaled by either handoff-specific value being
  // set (homeGuildId alone is legitimate bootstrap-only config and does
  // not count as an attempt). A half-configured attempt is refused at
  // boot rather than treated as live: under deny-on-empty semantics a
  // live handoff that can never resolve (e.g. missing homeGuildId, see
  // rfc-console-auth.md §2.1) would deny every Discord login forever,
  // indistinguishable from a bot outage.
  if (!secret && !botUrl) {
    return disabledHandoff();
  }
  const missing = [];
  if (!secret) missing.push("secret");
  if (!botUrl) missing.push("botUrl");
  if (!homeGuildId) missing.push("homeGuildId");
  if (missing.length > 0) {
    return { ...disabledHandoff(), misconfigured: true, missing };
  }
  // Presence alone is not enough: a typo'd scheme or garbage URL would
  // boot a live handoff that can never resolve -- the same silent-deny
  // failure mode the presence check exists to prevent.
  if (!isUsableHttpUrl(botUrl)) {
    return { ...disabledHandoff(), misconfigured: true, missing: [], invalid: ["botUrl"] };
  }
  return liveHandoff(config);
}

function isUsableHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// ---- Signature helpers (also exported for tests) ----

export function signPayload(payload, secret) {
  const json = JSON.stringify(payload);
  return createHmac("sha256", String(secret)).update(json).digest("hex");
}

export function verifyPayload(payload, signature, secret) {
  if (typeof signature !== "string" || signature.length < 16) return false;
  const expected = signPayload(payload, secret);
  return constantTimeStringEqual(expected, signature);
}

export function validatePayload(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "invalid_payload" };
  const { userId, guildId, tier, ts } = payload || {};
  if (typeof userId !== "string" || !USER_SNOWFLAKE_RE.test(userId)) return { ok: false, reason: "invalid_user_id" };
  if (typeof guildId !== "string" || !USER_SNOWFLAKE_RE.test(guildId)) return { ok: false, reason: "invalid_guild_id" };
  if (typeof tier !== "string" || !VALID_TIERS.has(tier)) return { ok: false, reason: "invalid_tier" };
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return { ok: false, reason: "invalid_timestamp" };
  return { ok: true, payload };
}

// A small negative tolerance absorbs the bot's clock being slightly AHEAD of
// the console's. The bot and console run on separate VMs; without it, even a
// ~100ms forward skew makes every freshly-signed handoff read as age < 0 and
// therefore "stale", denying ALL Discord sign-ins (the handoff is authoritative)
// until the clocks resync. maxAgeMs still bounds PAST skew/latency.
export const HANDOFF_CLOCK_SKEW_MS = 5000;
export function isFresh(payload, maxAgeMs = MAX_HANDOFF_AGE_MS, now = Date.now, skewMs = HANDOFF_CLOCK_SKEW_MS) {
  const age = now() - payload.ts;
  return age >= -skewMs && age < maxAgeMs;
}

// ---- Handoff implementation ----

function disabledHandoff() {
  return {
    enabled: false,
    async resolveTier() { return { tier: "", reason: "not_configured" }; }
  };
}

function liveHandoff(config) {
  const { secret, botUrl, homeGuildId, fetchImpl = globalThis.fetch, now = () => Date.now() } = config;

  // Resolves to { tier, reason }. reason is "" on success; on denial it
  // names the failure mode for the audit log only (rfc-console-auth.md
  // §2.1) -- callers must never branch authorization on it. Every
  // denial path returns tier: "" regardless of reason.
  async function resolveTier({ userId, username = "" } = {}) {
    if (typeof userId !== "string" || !USER_SNOWFLAKE_RE.test(userId)) {
      return { tier: "", reason: "invalid_user_id" };
    }

    let response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      response = await fetchImpl(`${botUrl}/resolve-console-tier`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ userId, guildId: homeGuildId }),
        signal: controller.signal
      });
    } catch {
      return { tier: "", reason: "unreachable" };
    } finally {
      // Always clear -- on the reject path too, or the abort timer lingers ~5s
      // (a no-op abort on a settled controller) and keeps the event loop alive;
      // during a bot outage every failed login would leak another dangling timer.
      clearTimeout(timer);
    }

    if (!response.ok) return { tier: "", reason: `http_${response.status}` };

    let body;
    try {
      body = await response.json();
    } catch {
      return { tier: "", reason: "malformed_response" };
    }

    if (!body || typeof body !== "object") return { tier: "", reason: "malformed_response" };
    const { signature, ...payload } = body;

    const payloadCheck = validatePayload(payload);
    if (!payloadCheck.ok) return { tier: "", reason: payloadCheck.reason };

    if (!verifyPayload(payloadCheck.payload, body.signature, secret)) {
      return { tier: "", reason: "bad_signature" };
    }

    if (!isFresh(payloadCheck.payload, MAX_HANDOFF_AGE_MS, now)) {
      return { tier: "", reason: "stale_handoff" };
    }

    if (payloadCheck.payload.userId !== userId) return { tier: "", reason: "user_mismatch" };
    if (payloadCheck.payload.guildId !== homeGuildId) return { tier: "", reason: "guild_mismatch" };

    return { tier: payloadCheck.payload.tier, reason: "" };
  }

  return { enabled: true, resolveTier };
}

function constantTimeStringEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length === 0) return false;
  return a.length === b.length && timingSafeEqual(a, b);
}
