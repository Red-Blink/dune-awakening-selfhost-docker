// Concurrent identical read-only calls share one underlying call. Nothing is
// kept once the call settles, so every later request still sees current data.
//
// bump() starts a new generation: a call that began before a write must not be
// handed to a request that arrived after it, or that request would read data
// older than its own write. Callers bump when a state-changing request starts
// and again when it has finished.
export function createInFlightShare() {
  const running = new Map();
  let generation = 0;
  return {
    share(key, load) {
      const slot = `${generation}:${key}`;
      const existing = running.get(slot);
      if (existing) return existing;
      const promise = Promise.resolve().then(load).finally(() => {
        if (running.get(slot) === promise) running.delete(slot);
      });
      running.set(slot, promise);
      return promise;
    },
    bump() {
      generation += 1;
    }
  };
}
