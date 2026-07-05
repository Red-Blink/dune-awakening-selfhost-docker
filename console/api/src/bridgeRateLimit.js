// Sliding-window rate limiter for the addon bridge route.
// Limits are intentionally generous: addon dashboards refresh frequently,
// so we degrade gracefully rather than hard-block legitimate use.

const WINDOW_MS = 60 * 1000;
const PER_KEY_MAX = 60;
const GLOBAL_MAX = 300;

export function createBridgeRateLimiter() {
  const requests = new Map();
  const globalRequests = [];

  function pruneGlobal(now) {
    while (globalRequests.length && globalRequests[0] <= now - WINDOW_MS) {
      globalRequests.shift();
    }
  }

  function pruneKey(key, now) {
    const entries = requests.get(key);
    if (!entries) return;
    while (entries.length && entries[0] <= now - WINDOW_MS) {
      entries.shift();
    }
    if (entries.length === 0) {
      requests.delete(key);
    }
  }

  return {
    check(key) {
      const now = Date.now();
      pruneGlobal(now);
      pruneKey(key, now);

      const entries = requests.get(key) || [];
      if (entries.length >= PER_KEY_MAX || globalRequests.length >= GLOBAL_MAX) {
        const oldest = entries.length >= PER_KEY_MAX ? entries[0] : globalRequests[0];
        const retryAfterMs = WINDOW_MS - (now - oldest);
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000))
        };
      }
      return { allowed: true };
    },
    record(key) {
      const now = Date.now();
      const entries = requests.get(key);
      if (entries) {
        entries.push(now);
      } else {
        requests.set(key, [now]);
      }
      globalRequests.push(now);
    }
  };
}
