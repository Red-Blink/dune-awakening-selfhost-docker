export function createUpdateCheckCache(config, options = {}) {
  const collect = options.collect; // required, injected by caller
  const now = options.now || Date.now;
  const cacheMs = Math.max(0, Number(options.cacheMs ?? config.updateCheckCacheMs ?? 5 * 60 * 1000));
  let cached = null;
  let inFlight = null;
  let generation = 0;

  async function read(readOptions = {}) {
    const currentTime = now();
    if (!readOptions.fresh && cached && currentTime - cached.sampledAtMs < cacheMs) {
      return { ...cached, fromCache: true };
    }
    if (inFlight?.generation === generation) {
      return inFlight.promise.then((entry) => ({ ...entry, fromCache: false }));
    }
    const collectionGeneration = generation;
    const pending = Promise.resolve().then(collect).then((result) => {
      const sampledAtMs = now();
      const entry = { ...result, sampledAtMs, sampledAt: new Date(sampledAtMs).toISOString() };
      if (collectionGeneration === generation) cached = entry;
      return entry;
    }).finally(() => {
      if (inFlight?.promise === pending) inFlight = null;
    });
    inFlight = { generation: collectionGeneration, promise: pending };
    return pending.then((entry) => ({ ...entry, fromCache: false }));
  }

  function peek() {
    const currentTime = now();
    if (cached && currentTime - cached.sampledAtMs < cacheMs) {
      return { ...cached, fromCache: true };
    }
    return null;
  }

  function invalidate() {
    generation += 1;
    cached = null;
  }
  return { read, peek, invalidate };
}
