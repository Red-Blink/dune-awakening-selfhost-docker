import test from "node:test";
import assert from "node:assert/strict";
import { createLoginRateLimiter, createMutationRateLimiter, resolveClientIp, createApiKeyRateLimiter } from "../src/rateLimit.js";

test("login rate limiter blocks repeated failures and resets after success", () => {
  let currentTime = 1000;
  const limiter = createLoginRateLimiter({
    maxAttempts: 3,
    globalMaxAttempts: 99,
    windowMs: 1000,
    blockMs: 5000,
    now: () => currentTime
  });

  assert.equal(limiter.check("client").allowed, true);
  assert.equal(limiter.recordFailure("client").allowed, true);
  assert.equal(limiter.recordFailure("client").allowed, true);
  assert.equal(limiter.recordFailure("client").allowed, false);
  assert.equal(limiter.check("client").allowed, false);

  currentTime += 5001;
  assert.equal(limiter.check("client").allowed, true);
  limiter.recordFailure("client");
  limiter.recordSuccess("client");
  assert.equal(limiter.check("client").allowed, true);
});

test("login rate limiter blocks aggregate failures across rotating clients", () => {
  let currentTime = 1000;
  const limiter = createLoginRateLimiter({
    maxAttempts: 99,
    globalMaxAttempts: 4,
    windowMs: 1000,
    blockMs: 5000,
    now: () => currentTime
  });

  assert.equal(limiter.recordFailure("client-a").allowed, true);
  assert.equal(limiter.recordFailure("client-b").allowed, true);
  assert.equal(limiter.recordFailure("client-c").allowed, true);
  assert.equal(limiter.recordFailure("client-d").allowed, false);
  assert.equal(limiter.check("client-e").allowed, false);

  limiter.recordSuccess("client-a");
  assert.equal(limiter.check("client-e").allowed, false);

  currentTime += 5001;
  assert.equal(limiter.check("client-e").allowed, true);
});

test("login rate limiter: a completing success relieves the shared __global__ bucket so ordinary traffic never ratchets into a console-wide lockout", () => {
  let t = 1000;
  const limiter = createLoginRateLimiter({ maxAttempts: 99, globalMaxAttempts: 3, windowMs: 60000, blockMs: 5000, now: () => t });
  // Regression for the code-review finding: recordFailure fed __global__ but
  // recordSuccess never relieved it, so metered-but-legitimate steps (the 2FA
  // two-step first POST, OAuth denials) accumulated to a 15-minute lockout of
  // ALL sign-in that nothing cleared. Now each success decrements the bucket.
  assert.equal(limiter.recordFailure("a").allowed, true); // __global__ 1
  assert.equal(limiter.recordFailure("b").allowed, true); // __global__ 2
  limiter.recordSuccess("a");                             // 2 -> 1 (relieved)
  limiter.recordFailure("d");                             // 1 -> 2
  limiter.recordSuccess("d");                             // 2 -> 1 (relieved)
  limiter.recordFailure("e");                             // 1 -> 2
  assert.equal(limiter.check("z").allowed, true, "interleaved successes keep __global__ under the cap");
  limiter.recordFailure("f");                             // 2 -> 3 => blocks at the cap
  assert.equal(limiter.check("z").allowed, false, "the block still trips once genuine failures actually reach the cap");
});

test("mutation rate limiter blocks repeated authenticated writes and resets after the window", () => {
  let currentTime = 1000;
  const limiter = createMutationRateLimiter({
    maxRequests: 2,
    globalMaxRequests: 99,
    windowMs: 1000,
    now: () => currentTime
  });

  assert.equal(limiter.check("session-a:players.add-intel").allowed, true);
  limiter.record("session-a:players.add-intel");
  assert.equal(limiter.check("session-a:players.add-intel").allowed, true);
  limiter.record("session-a:players.add-intel");
  assert.equal(limiter.check("session-a:players.add-intel").allowed, false);
  assert.equal(limiter.check("session-a:players.add-currency").allowed, true);

  currentTime += 1001;
  assert.equal(limiter.check("session-a:players.add-intel").allowed, true);
});

test("mutation rate limiter applies a global cap across rotating write scopes", () => {
  let currentTime = 1000;
  const limiter = createMutationRateLimiter({
    maxRequests: 99,
    globalMaxRequests: 3,
    windowMs: 1000,
    now: () => currentTime
  });

  assert.equal(limiter.check("session-a:players.add-intel").allowed, true);
  limiter.record("session-a:players.add-intel");
  assert.equal(limiter.check("session-a:players.add-currency").allowed, true);
  limiter.record("session-a:players.add-currency");
  assert.equal(limiter.check("session-a:database.row-update").allowed, true);
  limiter.record("session-a:database.row-update");
  assert.equal(limiter.check("session-a:players.give-item").allowed, false);

  currentTime += 1001;
  assert.equal(limiter.check("session-a:players.give-item").allowed, true);
});

// ---- resolveClientIp: X-Forwarded-For handling (review finding) ----

function fakeReq(remoteAddress, forwardedFor) {
  const headers = {};
  if (forwardedFor !== undefined) headers["x-forwarded-for"] = forwardedFor;
  return { socket: { remoteAddress }, headers };
}

test("resolveClientIp: no trusted proxies -> always the socket peer, header ignored", () => {
  assert.equal(resolveClientIp(fakeReq("203.0.113.5", "1.2.3.4"), []), "203.0.113.5");
});

test("resolveClientIp: peer NOT in the trusted list -> header ignored (negative test)", () => {
  assert.equal(resolveClientIp(fakeReq("203.0.113.5", "1.2.3.4"), ["10.0.0.1"]), "203.0.113.5");
});

test("resolveClientIp: trusted appending proxy -> the RIGHTMOST entry, never the client-controlled leftmost", () => {
  // nginx's proxy_add_x_forwarded_for turns a spoofed leftmost into
  // "evil, <realpeer>": trusting [0] would key the limiter on the attacker's
  // chosen value (bypass) or a victim's IP (lockout). The rightmost is the one
  // the trusted proxy itself appended.
  assert.equal(resolveClientIp(fakeReq("10.0.0.1", "1.1.1.1, 203.0.113.9"), ["10.0.0.1"]), "203.0.113.9");
});

test("resolveClientIp: trusted proxy, single forwarded entry -> that entry", () => {
  assert.equal(resolveClientIp(fakeReq("10.0.0.1", "203.0.113.9"), ["10.0.0.1"]), "203.0.113.9");
});

test("resolveClientIp: trusted proxy, no forwarded header -> falls back to the socket peer", () => {
  assert.equal(resolveClientIp(fakeReq("10.0.0.1", undefined), ["10.0.0.1"]), "10.0.0.1");
});

test("api key rate limiter grants exactly the configured number of requests", () => {
  // Regression: record() used to increment before checking `count >= max`, so a
  // key counted the in-flight request against its own limit and got max-1. At
  // the documented minimum of 1 that meant zero requests, forever.
  for (const limit of [1, 2, 3, 60]) {
    const limiter = createApiKeyRateLimiter({ now: () => 1000 });
    let allowed = 0;
    for (let attempt = 0; attempt < limit + 3; attempt += 1) {
      if (limiter.record(`key-${limit}`, limit).allowed) allowed += 1;
    }
    assert.equal(allowed, limit, `a key configured for ${limit}/min was allowed ${allowed}`);
  }
});

test("api key rate limiter refuses with a retry-after and resets after the window", () => {
  let currentTime = 1000;
  const limiter = createApiKeyRateLimiter({ now: () => currentTime });

  assert.equal(limiter.record("key", 2).allowed, true);
  assert.equal(limiter.record("key", 2).allowed, true);

  const refused = limiter.record("key", 2);
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterSeconds > 0 && refused.retryAfterSeconds <= 60, `got ${refused.retryAfterSeconds}`);

  currentTime += 60 * 1000;
  assert.equal(limiter.record("key", 2).allowed, true, "the window did not reset");
});

test("a refused api key request consumes neither its own nor the global budget", () => {
  // A request that is already over the limit must not extend the window or eat
  // into the shared ceiling other keys depend on.
  let currentTime = 1000;
  const limiter = createApiKeyRateLimiter({ globalMaxRequests: 3, now: () => currentTime });

  assert.equal(limiter.record("noisy", 1).allowed, true);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal(limiter.record("noisy", 1).allowed, false);
  }
  // The noisy key spent 1 of the global 3, not 11.
  assert.equal(limiter.record("other", 5).allowed, true);
  assert.equal(limiter.record("other", 5).allowed, true);
  assert.equal(limiter.record("third", 5).allowed, false, "global ceiling should now be reached");
});

test("api key limiter keeps separate budgets per key", () => {
  const limiter = createApiKeyRateLimiter({ now: () => 1000 });
  assert.equal(limiter.record("a", 1).allowed, true);
  assert.equal(limiter.record("a", 1).allowed, false);
  assert.equal(limiter.record("b", 1).allowed, true, "one key exhausting its limit blocked another");
});

test("the shared api key ceiling stays above the per-key maximum", async () => {
  // At 6000 against a per-key max of 10000, one key at its documented limit
  // could exhaust the shared bucket alone and 429 every other key.
  const { MAX_RATE_LIMIT_PER_MINUTE, GLOBAL_RATE_LIMIT_PER_MINUTE } = await import("../src/apiKeys.js");
  assert.ok(GLOBAL_RATE_LIMIT_PER_MINUTE > MAX_RATE_LIMIT_PER_MINUTE,
    `global ceiling ${GLOBAL_RATE_LIMIT_PER_MINUTE} must exceed the per-key maximum ${MAX_RATE_LIMIT_PER_MINUTE}`);

  // A key running flat out at the maximum leaves room for others.
  const limiter = createApiKeyRateLimiter({ globalMaxRequests: GLOBAL_RATE_LIMIT_PER_MINUTE, now: () => 1000 });
  for (let i = 0; i < MAX_RATE_LIMIT_PER_MINUTE; i += 1) limiter.record("noisy", MAX_RATE_LIMIT_PER_MINUTE);
  assert.equal(limiter.record("noisy", MAX_RATE_LIMIT_PER_MINUTE).allowed, false, "the noisy key should hit its own limit");
  assert.equal(limiter.record("victim", 60).allowed, true, "another key was starved by the noisy one");
});

// ---- review finding: the OAuth callback limiter must not share a global
// lockout bucket -- anonymous junk callbacks from a few addresses were able to
// 429 every user's Discord sign-in for 15 minutes. ----
test("login rate limiter with globalMaxAttempts: Infinity never trips a cross-client lockout", () => {
  let currentTime = 1000;
  const limiter = createLoginRateLimiter({ maxAttempts: 8, globalMaxAttempts: Infinity, windowMs: 1000, blockMs: 5000, now: () => currentTime });
  for (let i = 0; i < 200; i += 1) limiter.recordFailure(`attacker-${i}`);
  assert.equal(limiter.check("victim").allowed, true, "distinct clients' failures must not lock a fresh client out");
  // The per-client bucket is untouched by that choice.
  for (let i = 0; i < 8; i += 1) limiter.recordFailure("victim");
  assert.equal(limiter.check("victim").allowed, false);
});
