// Signed tier-handoff verification (integrations/discord/handoff.js).
//
// This is a security trust boundary: with a bot handoff configured, whatever
// tier the handoff returns is authoritative. Every rejection path here is what
// stops a forged/replayed/mismatched response from minting a tiered session, so
// each one must have a test that goes RED if the check is removed. (QA audit:
// the file previously had zero tests, and the only fixture always signed
// correctly, so a broken verify would have shipped green.)

import test from "node:test";
import assert from "node:assert/strict";
import { createHandoff, signPayload, verifyPayload, validatePayload, isFresh } from "../src/integrations/discord/handoff.js";

const SECRET = "shared-handoff-secret-value-1234567890";
const USER = "200000000000000001";
const GUILD = "300000000000000001";
const NOW = 1_700_000_000_000;
const goodPayload = (over = {}) => ({ userId: USER, guildId: GUILD, tier: "admin", ts: NOW, ...over });

// A fake bot that returns a body built by `make(payload)` for a chosen payload.
function fakeBot(bodyFor) {
  return async () => ({ ok: true, async json() { return bodyFor(); } });
}
function signedBody(payload, secret = SECRET) {
  // resolveTier does `const { signature, ...payload } = body`, so the payload
  // fields live at the TOP LEVEL with the signature alongside (not nested).
  return { ...payload, signature: signPayload(payload, secret) };
}

// ---- pure functions ----

test("verifyPayload: correct signature verifies; tampered/wrong-secret/short are rejected", () => {
  const p = goodPayload();
  const sig = signPayload(p, SECRET);
  assert.equal(verifyPayload(p, sig, SECRET), true);
  assert.equal(verifyPayload(p, sig, "different-secret"), false, "wrong secret must not verify");
  assert.equal(verifyPayload({ ...p, tier: "owner" }, sig, SECRET), false, "sig is over the exact payload; tier swap must fail");
  assert.equal(verifyPayload(p, sig.slice(0, 10), SECRET), false, "a <16-char signature is rejected outright");
  assert.equal(verifyPayload(p, 12345, SECRET), false, "non-string signature rejected");
});

test("validatePayload: each malformed field yields its own reason", () => {
  assert.deepEqual(validatePayload(goodPayload()), { ok: true, payload: goodPayload() });
  assert.equal(validatePayload(goodPayload({ userId: "nope" })).reason, "invalid_user_id");
  assert.equal(validatePayload(goodPayload({ guildId: "42" })).reason, "invalid_guild_id");
  assert.equal(validatePayload(goodPayload({ tier: "superuser" })).reason, "invalid_tier");
  assert.equal(validatePayload(goodPayload({ ts: 0 })).reason, "invalid_timestamp");
  assert.equal(validatePayload(null).reason, "invalid_payload");
});

test("isFresh: within the window is fresh, beyond it is stale", () => {
  assert.equal(isFresh(goodPayload({ ts: NOW }), 30_000, () => NOW), true);
  assert.equal(isFresh(goodPayload({ ts: NOW - 29_000 }), 30_000, () => NOW), true);
  assert.equal(isFresh(goodPayload({ ts: NOW - 31_000 }), 30_000, () => NOW), false);
});

test("isFresh: a small forward clock skew (bot ahead of console) is tolerated, not treated as stale", () => {
  // Bot clock ~2s ahead -> ts is in the console's near future (age negative).
  // Before the fix age >= 0 rejected it, denying every Discord login until the
  // clocks resynced. The default skew tolerance now accepts it; large forward
  // skew beyond the tolerance is still rejected.
  assert.equal(isFresh(goodPayload({ ts: NOW + 2_000 }), 30_000, () => NOW), true);
  assert.equal(isFresh(goodPayload({ ts: NOW + 2_000 }), 30_000, () => NOW, 5_000), true);
  assert.equal(isFresh(goodPayload({ ts: NOW + 10_000 }), 30_000, () => NOW, 5_000), false, "skew beyond tolerance is still rejected");
});

// ---- resolveTier: the authoritative path, one rejection per test ----

function handoff(bodyFor) {
  return createHandoff({ secret: SECRET, botUrl: "http://bot.test", homeGuildId: GUILD, fetchImpl: fakeBot(bodyFor), now: () => NOW });
}

test("resolveTier: a correctly signed, fresh, matching handoff returns the tier", async () => {
  const h = handoff(() => signedBody(goodPayload({ tier: "admin" })));
  assert.deepEqual(await h.resolveTier({ userId: USER }), { tier: "admin", reason: "" });
});

test("resolveTier: MUTATION GUARD — a forged owner tier with a wrong-secret signature is denied", async () => {
  // If verifyPayload were broken (always true), this would mint an owner session.
  const h = handoff(() => signedBody(goodPayload({ tier: "owner" }), "attacker-secret-not-the-real-one"));
  assert.deepEqual(await h.resolveTier({ userId: USER }), { tier: "", reason: "bad_signature" });
});

test("resolveTier: tampered payload after signing → bad_signature", async () => {
  const h = handoff(() => { const b = signedBody(goodPayload({ tier: "player" })); b.tier = "owner"; return b; });
  assert.equal((await h.resolveTier({ userId: USER })).reason, "bad_signature");
});

test("resolveTier: a stale (replayed) handoff is rejected", async () => {
  const h = handoff(() => signedBody(goodPayload({ ts: NOW - 5 * 60_000 })));
  assert.equal((await h.resolveTier({ userId: USER })).reason, "stale_handoff");
});

test("resolveTier: userId / guildId mismatch is rejected", async () => {
  const hUser = handoff(() => signedBody(goodPayload({ userId: "200000000000000099" })));
  assert.equal((await hUser.resolveTier({ userId: USER })).reason, "user_mismatch");
  const hGuild = handoff(() => signedBody(goodPayload({ guildId: "300000000000000099" })));
  assert.equal((await hGuild.resolveTier({ userId: USER })).reason, "guild_mismatch");
});

test("resolveTier: invalid tier / malformed body / non-2xx / unreachable all deny with a reason", async () => {
  assert.equal((await handoff(() => signedBody(goodPayload({ tier: "root" }))).resolveTier({ userId: USER })).reason, "invalid_tier");
  assert.equal((await handoff(() => ({ nope: 1 })).resolveTier({ userId: USER })).reason, "invalid_user_id"); // a bodyless-of-fields object fails the userId check first
  const h500 = createHandoff({ secret: SECRET, botUrl: "http://bot.test", homeGuildId: GUILD, now: () => NOW, fetchImpl: async () => ({ ok: false, status: 503, async json() { return {}; } }) });
  assert.equal((await h500.resolveTier({ userId: USER })).reason, "http_503");
  const hThrow = createHandoff({ secret: SECRET, botUrl: "http://bot.test", homeGuildId: GUILD, now: () => NOW, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal((await hThrow.resolveTier({ userId: USER })).reason, "unreachable");
});

test("resolveTier: every denial returns tier:'' (never falls through to a tier)", async () => {
  for (const bodyFor of [
    () => signedBody(goodPayload(), "wrong"),
    () => signedBody(goodPayload({ ts: NOW - 10 * 60_000 })),
    () => signedBody(goodPayload({ userId: "200000000000000099" })),
    () => ({ garbage: true }),
  ]) {
    assert.equal((await handoff(bodyFor).resolveTier({ userId: USER })).tier, "", "denied handoff must yield empty tier");
  }
});
