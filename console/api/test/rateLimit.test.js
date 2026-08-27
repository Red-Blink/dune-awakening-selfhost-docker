import test from "node:test";
import assert from "node:assert/strict";
import { createLoginRateLimiter, createMutationRateLimiter, createApiKeyRateLimiter } from "../src/rateLimit.js";

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
