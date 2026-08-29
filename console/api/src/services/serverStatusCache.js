import { createUpdateCheckCache } from "./updateCheckCache.js";

// `status` and `readiness` each shell out to runtime/scripts/status.sh, which
// inspects every container, port and the database. Measured on a live host they
// cost ~3.8s apiece and the Home panel asks for both in parallel on every mount
// and every idle poll, so an operator tab-hopping to Home paid ~4s and two
// subprocess trees each time.
//
// createUpdateCheckCache is a generic TTL cache despite its update-flavoured
// name: it dedupes in-flight collects, stamps sampledAt, and supports
// generation-based invalidate(). Reused here rather than reimplemented.
export function createServerStatusCache(config, options = {}) {
  const cacheMs = options.cacheMs ?? config.statusCacheMs;
  const now = options.now;
  const build = (collect) => createUpdateCheckCache(config, { collect, cacheMs, ...(now ? { now } : {}) });

  const caches = {
    status: build(options.collectStatus),
    readiness: build(options.collectReadiness)
  };

  function read(operation, readOptions = {}) {
    const cache = caches[operation];
    if (!cache) throw new Error(`No status cache for operation: ${operation}`);
    return cache.read(readOptions);
  }

  // Called after anything that changes server state. Without it Home could
  // report "Running" for a full TTL after a stop, which is worse than the slow
  // read this cache exists to avoid.
  function invalidate() {
    for (const cache of Object.values(caches)) cache.invalidate();
  }

  return { read, invalidate };
}
