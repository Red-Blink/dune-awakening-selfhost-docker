export function createUpdateCheckCache(config, options = {}) {
  const collect = options.collect; // required, injected by caller
  const now = options.now || Date.now;
  const cacheMs = Math.max(0, Number(options.cacheMs ?? config.updateCheckCacheMs ?? 5 * 60 * 1000));
  let cached = null;
  let inFlight = null;

  async function read(readOptions = {}) {
    const currentTime = now();
    if (!readOptions.fresh && cached && currentTime - cached.sampledAtMs < cacheMs) {
      return { ...cached, fromCache: true };
    }
    if (inFlight) return inFlight.then((entry) => ({ ...entry, fromCache: false }));
    inFlight = Promise.resolve().then(collect).then((result) => {
      const sampledAtMs = now();
      cached = { ...result, sampledAtMs, sampledAt: new Date(sampledAtMs).toISOString() };
      return cached;
    }).finally(() => { inFlight = null; });
    return inFlight.then((entry) => ({ ...entry, fromCache: false }));
  }

  function invalidate() { cached = null; }
  return { read, invalidate };
}
