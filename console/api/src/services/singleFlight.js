import { withTimeout } from "./withTimeout.js";

// Serializes a background flush so two passes never overlap, without making a
// concurrent caller a silent no-op.
//
// Each queue in server.js is driven by both the 5s tick and the restart's
// onMapDown hook. A boolean guard serializes correctly but returns an empty
// result to whichever caller arrives second -- and when that is the hook, the
// one moment the queue can actually be written is skipped.
//
// forceFresh callers (the hook) wait for the in-flight pass, then run their own.
// Plain callers (the tick) return immediately: the running pass reports for
// itself when it finishes, so waiting would buy the tick nothing and cost it
// everything -- the tick fires every 5s with no re-entry guard of its own, so a
// wedged pass would otherwise leave one waiter, one timer and a permanent
// handler on the never-settling promise behind on every fire.
//
// waitTimeoutMs bounds only the wait for someone else's pass, never one this
// call started. On timeout a forceFresh caller throws rather than starting its
// own anyway: the stuck pass may still hold a transaction open, and overlapping
// passes is the hazard this exists to prevent.
export function createSingleFlight(run, { waitTimeoutMs = 0 } = {}) {
  // Tail of the serialized chain. Every fresh pass links onto whatever is
  // already running, so N concurrent forceFresh callers produce N passes in
  // sequence rather than N passes at once.
  let tail = null;

  // Options reach run() so a pass can be parameterised (allowBlockedStates,
  // ignoreRetryBackoff). Only a forceFresh caller starts a pass, so a pass
  // always runs under the options of the caller that asked for it.
  return async function flush(options = {}) {
    const { forceFresh = false } = options;
    const observed = tail;
    if (observed) {
      // O(1) for the tick: attach nothing to a promise that may never settle.
      if (!forceFresh) return { flushed: [], alreadyRunning: true };
      // Never inherit another caller's rejection: the pass that failed reports
      // to its own caller, and a forceFresh caller still needs its own run.
      await withTimeout(
        observed.then((value) => value, () => null),
        waitTimeoutMs,
        `A queued-write flush that started earlier has still not finished after ${Math.max(1, Math.round(waitTimeoutMs / 1000))}s.`);
    }
    // Another forceFresh caller may have linked onto the chain while we were
    // awaiting above; queue behind it rather than racing it.
    const next = (tail && tail !== observed ? tail.then(() => {}, () => {}) : Promise.resolve())
      .then(() => run(options));
    tail = next;
    try {
      return await next;
    } finally {
      if (tail === next) tail = null;
    }
  };
}
