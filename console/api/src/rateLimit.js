export function createLoginRateLimiter(options = {}) {
  const {
    maxAttempts = 8,
    globalMaxAttempts = 32,
    windowMs = 15 * 60 * 1000,
    blockMs = 15 * 60 * 1000,
    now = () => Date.now()
  } = options;
  const attempts = new Map();
  const globalKey = "__global__";

  function check(key) {
    const timestamp = now();
    const blocked = [activeAttempt(key, timestamp), activeAttempt(globalKey, timestamp)]
      .filter((current) => current?.blockedUntil && current.blockedUntil > timestamp)
      .map((current) => Math.ceil((current.blockedUntil - timestamp) / 1000));
    if (blocked.length) return { allowed: false, retryAfterSeconds: Math.max(...blocked) };
    return { allowed: true, retryAfterSeconds: 0 };
  }

  function recordFailure(key) {
    const timestamp = now();
    increment(key, maxAttempts, timestamp);
    increment(globalKey, globalMaxAttempts, timestamp);
    return check(key);
  }

  function recordSuccess(key) {
    attempts.delete(key);
  }

  function activeAttempt(key, timestamp) {
    const current = attempts.get(key);
    if (!current) return null;
    if (current.blockedUntil && current.blockedUntil > timestamp) return current;
    if (current.firstAttemptAt + windowMs <= timestamp) {
      attempts.delete(key);
      return null;
    }
    return current;
  }

  function increment(key, limit, timestamp) {
    const current = activeAttempt(key, timestamp);
    const next = !current || current.firstAttemptAt + windowMs <= timestamp
      ? { count: 1, firstAttemptAt: timestamp, blockedUntil: 0 }
      : { ...current, count: current.count + 1 };
    if (next.count >= limit) next.blockedUntil = timestamp + blockMs;
    attempts.set(key, next);
  }

  return { check, recordFailure, recordSuccess };
}

export function createMutationRateLimiter(options = {}) {
  const {
    maxRequests = 20,
    globalMaxRequests = 200,
    windowMs = 60 * 1000,
    now = () => Date.now()
  } = options;
  const requests = new Map();
  const globalKey = "__global_mutations__";

  function check(key) {
    const timestamp = now();
    const current = activeRequest(key, timestamp);
    const global = activeRequest(globalKey, timestamp);
    const retryAfterSeconds = Math.ceil(windowMs / 1000);
    if (current && current.count >= maxRequests) {
      return { allowed: false, retryAfterSeconds: retryAfter(current, timestamp, retryAfterSeconds) };
    }
    if (global && global.count >= globalMaxRequests) {
      return { allowed: false, retryAfterSeconds: retryAfter(global, timestamp, retryAfterSeconds) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  function record(key) {
    const timestamp = now();
    increment(key, timestamp);
    increment(globalKey, timestamp);
    return check(key);
  }

  function activeRequest(key, timestamp) {
    const current = requests.get(key);
    if (!current) return null;
    if (current.firstRequestAt + windowMs <= timestamp) {
      requests.delete(key);
      return null;
    }
    return current;
  }

  function increment(key, timestamp) {
    const current = activeRequest(key, timestamp);
    const next = current
      ? { ...current, count: current.count + 1 }
      : { count: 1, firstRequestAt: timestamp };
    requests.set(key, next);
  }

  function retryAfter(current, timestamp, fallback) {
    return Math.max(1, Math.ceil((current.firstRequestAt + windowMs - timestamp) / 1000) || fallback);
  }

  return { check, record };
}

// Per-key API limiter. Unlike the two limiters above, the cap is not fixed at
// construction -- each API key carries its own rateLimitPerMinute, so the
// limit is passed per check() call. Applied to every key-authenticated
// request, reads included: an unbounded polling loop is the likelier accident
// than a burst of writes.
export function createApiKeyRateLimiter(options = {}) {
  const {
    // Callers should pass this explicitly, derived from the per-key maximum --
    // see GLOBAL_RATE_LIMIT_PER_MINUTE in apiKeys.js. This default only applies
    // to standalone construction and is set above that maximum for the same
    // reason: a single key must not be able to exhaust the shared ceiling.
    globalMaxRequests = 20000,
    // Used when a caller passes a non-numeric limit. `count >= undefined` is
    // false, so without this a malformed limit would read as "unlimited" --
    // failing open on the one control that bounds an automated caller.
    fallbackMaxRequests = 60,
    windowMs = 60 * 1000,
    now = () => Date.now()
  } = options;
  const requests = new Map();
  const globalKey = "__global_api_keys__";

  function resolveLimit(maxRequests) {
    const limit = Math.floor(Number(maxRequests));
    return Number.isFinite(limit) && limit > 0 ? limit : fallbackMaxRequests;
  }

  function check(key, maxRequests) {
    const timestamp = now();
    const limit = resolveLimit(maxRequests);
    const retryAfterSeconds = Math.ceil(windowMs / 1000);
    const current = activeRequest(key, timestamp);
    if (current && current.count >= limit) {
      return { allowed: false, retryAfterSeconds: retryAfter(current, timestamp, retryAfterSeconds) };
    }
    const global = activeRequest(globalKey, timestamp);
    if (global && global.count >= globalMaxRequests) {
      return { allowed: false, retryAfterSeconds: retryAfter(global, timestamp, retryAfterSeconds) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  // Checks BEFORE incrementing, so a key configured for N requests gets N, not
  // N-1. Incrementing first and then testing `count >= maxRequests` counted the
  // in-flight request against its own limit, which made rateLimitPerMinute: 1
  // -- the documented minimum -- allow zero requests and 429 forever.
  //
  // A refused request also does not increment: being over the limit should not
  // extend the window or consume the shared global budget.
  function record(key, maxRequests) {
    const verdict = check(key, maxRequests);
    if (!verdict.allowed) return verdict;
    const timestamp = now();
    increment(key, timestamp);
    increment(globalKey, timestamp);
    return verdict;
  }

  function activeRequest(key, timestamp) {
    const current = requests.get(key);
    if (!current) return null;
    if (current.firstRequestAt + windowMs <= timestamp) {
      requests.delete(key);
      return null;
    }
    return current;
  }

  function increment(key, timestamp) {
    const current = activeRequest(key, timestamp);
    requests.set(key, current ? { ...current, count: current.count + 1 } : { count: 1, firstRequestAt: timestamp });
  }

  function retryAfter(current, timestamp, fallback) {
    return Math.max(1, Math.ceil((current.firstRequestAt + windowMs - timestamp) / 1000) || fallback);
  }

  return { check, record };
}
