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
