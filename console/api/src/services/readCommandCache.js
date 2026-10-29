export function createReadCommandCache({ ttlMs = 2000, staleMs = 0, maxEntries = 128, clock = Date.now } = {}) {
  const entries = new Map();
  // Bumped by invalidate(). A collect that started before the bump sampled the
  // world before whatever invalidated it, so its result must not be stored.
  let generation = 0;

  function prune(now) {
    for (const [key, entry] of entries) {
      if (!entry.promise && (entry.staleUntil ?? entry.expiresAt) <= now) entries.delete(key);
    }
    if (entries.size >= maxEntries) {
      for (const [key, entry] of entries) {
        if (!entry.promise) entries.delete(key);
        if (entries.size < maxEntries) break;
      }
    }
  }

  function hit(entry) {
    return { value: entry.value, sampledAtMs: entry.sampledAtMs, fromCache: true };
  }

  function start(key, work, previous = null) {
    const collectionGeneration = generation;
    const promise = Promise.resolve().then(work).then((value) => {
      const sampledAtMs = clock();
      if (entries.get(key)?.promise === promise) {
        if (collectionGeneration === generation && ttlMs > 0) {
          const expiresAt = sampledAtMs + ttlMs;
          entries.set(key, { value, sampledAtMs, expiresAt, staleUntil: expiresAt + staleMs });
        } else {
          entries.delete(key);
        }
      }
      return { value, sampledAtMs, fromCache: false };
    }, (error) => {
      if (entries.get(key)?.promise === promise) {
        if (previous && collectionGeneration === generation) entries.set(key, previous);
        else entries.delete(key);
      }
      throw error;
    });
    entries.set(key, { ...(previous || {}), promise });
    return promise;
  }

  // Like run(), but also says when the value was collected. A cache hit keeps
  // the original sampledAtMs, so a stale snapshot is never dated as current.
  async function runStamped(key, work, { fresh = false } = {}) {
    const now = clock();
    const existing = entries.get(key);
    // Readiness transitions must await the current collection, not a previous
    // Ready snapshot. Keep coalescing concurrent readers even in fresh mode.
    if (fresh && existing?.promise) return existing.promise;
    if (!fresh && existing && existing.expiresAt > now) return hit(existing);
    if (!fresh && existing && existing.staleUntil > now && Object.hasOwn(existing, "value")) {
      if (!existing.promise) {
        const previous = { value: existing.value, sampledAtMs: existing.sampledAtMs, expiresAt: existing.expiresAt, staleUntil: existing.staleUntil };
        // Keep status polling responsive while one shared refresh runs. A
        // failed background refresh retains the bounded previous snapshot and
        // must not create an unhandled rejection in the API process.
        void start(key, work, previous).catch(() => {});
      }
      return hit(existing);
    }
    if (existing?.promise) return existing.promise;

    prune(now);
    return start(key, work);
  }

  async function run(key, work, options = {}) {
    return (await runStamped(key, work, options)).value;
  }

  // For anything that changes what the cached commands would report. An
  // in-flight collect stays joinable but loses the stale snapshot it was serving.
  function invalidate() {
    generation += 1;
    for (const [key, entry] of entries) {
      if (entry.promise) entries.set(key, { promise: entry.promise });
      else entries.delete(key);
    }
  }

  return { run, runStamped, invalidate };
}
