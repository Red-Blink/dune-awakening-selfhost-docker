// Bounds an await so a wedged dependency cannot hang the caller forever.
//
// Used on the queued-write flush paths, where the caller is a restart task: a
// flush that never settles (a stuck PostgreSQL connection, a backup process
// that never exits) would otherwise leave the battlegroup stopped indefinitely,
// with the start half never running. Failing the flush and continuing is always
// better than a restart that never finishes.
//
// This does not cancel the underlying work -- nothing here can -- it stops
// waiting on it. An abandoned flush pass that later completes cannot write to a
// map that came back up in the meantime: every queue re-observes partitions per
// entry (see entryWriteSafe), so the pass stops itself at its next entry. Its
// writes are transactional too, so a database torn down under it rolls back and
// the entries stay queued for the next pass.
export function withTimeout(promise, ms, message) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    // Never hold the process open just to enforce a timeout. The trade is that
    // the bound is not a hard guarantee: with nothing else keeping the event
    // loop alive the process exits rather than rejecting. That is the right way
    // round here -- the API server's listening socket holds the loop open in
    // every real deployment, and a bound that outlives the work it bounds would
    // keep a finished process alive for up to 30 minutes.
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}
