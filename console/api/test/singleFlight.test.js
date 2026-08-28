import test from "node:test";
import assert from "node:assert/strict";
import { createSingleFlight } from "../src/services/singleFlight.js";

// A controllable pass: resolve/reject it by hand so the interleavings under
// test are deterministic rather than timing-dependent.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("a plain caller defers to the in-flight pass instead of starting a second one", async () => {
  const gate = deferred();
  let runs = 0;
  const flush = createSingleFlight(() => { runs += 1; return gate.promise; });

  const first = flush();
  const second = flush();
  gate.resolve({ flushed: ["a"] });

  assert.deepEqual(await first, { flushed: ["a"] });
  // The in-flight pass reports its own result to its own caller; the tick is
  // told only that one is already running.
  assert.deepEqual(await second, { flushed: [], alreadyRunning: true });
  assert.equal(runs, 1);
});

// The whole point of the change: the old boolean guard returned an empty
// result here, so the restart hook's flush silently did nothing whenever the
// 5s tick happened to be mid-pass.
test("a forceFresh caller waits for the in-flight pass and then runs its own", async () => {
  const gates = [deferred(), deferred()];
  let runs = 0;
  const flush = createSingleFlight(() => gates[runs++].promise);

  const tick = flush();
  const hook = flush({ forceFresh: true });

  gates[0].resolve({ flushed: ["stale"] });
  assert.deepEqual(await tick, { flushed: ["stale"] });

  gates[1].resolve({ flushed: ["fresh"] });
  assert.deepEqual(await hook, { flushed: ["fresh"] });
  assert.equal(runs, 2);
});

test("passes never overlap, even with several forceFresh callers", async () => {
  let active = 0;
  let peak = 0;
  const flush = createSingleFlight(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return { flushed: [] };
  });

  await Promise.all([
    flush(),
    flush({ forceFresh: true }),
    flush({ forceFresh: true }),
    flush({ forceFresh: true })
  ]);
  assert.equal(peak, 1);
});

// A waiting caller must not inherit someone else's error: the forceFresh
// caller still has to get its own pass, and the failing pass reports to the
// caller that actually started it.
test("a rejected pass is reported to its own caller and does not block the next", async () => {
  const gates = [deferred(), deferred()];
  let runs = 0;
  const flush = createSingleFlight(() => gates[runs++].promise);

  const failing = flush();
  const hook = flush({ forceFresh: true });

  gates[0].reject(new Error("database is restarting"));
  await assert.rejects(() => failing, /database is restarting/);

  gates[1].resolve({ flushed: ["fresh"] });
  assert.deepEqual(await hook, { flushed: ["fresh"] });
});

test("a plain caller never inherits the rejection of a pass it did not start", async () => {
  const gate = deferred();
  let runs = 0;
  const flush = createSingleFlight(() => { runs += 1; return gate.promise; });

  const failing = flush();
  const second = flush();
  gate.reject(new Error("boom"));

  await assert.rejects(() => failing, /boom/);
  assert.deepEqual(await second, { flushed: [], alreadyRunning: true });
  assert.equal(runs, 1);
});

test("a later call starts a new pass once the chain has drained", async () => {
  let runs = 0;
  const flush = createSingleFlight(async () => ({ flushed: [runs++] }));

  assert.deepEqual(await flush(), { flushed: [0] });
  assert.deepEqual(await flush(), { flushed: [1] });
  assert.equal(runs, 2);
});

// withTimeout unrefs its timer so a pending timeout never holds the process
// open in production. That means a test whose only pending work is a wedged
// promise plus that timer lets the event loop drain, and the runner tears the
// file down mid-suite ("cancelledByParent"). These tests hold it open instead
// of weakening the production behaviour.
function keepEventLoopAlive() {
  const handle = setInterval(() => {}, 1000);
  return () => clearInterval(handle);
}

// Without a bound here the restart task's stop->flush->start sequence can wait
// forever on a wedged pass, leaving the battlegroup down with no start half.
test("a forceFresh caller gives up waiting on a wedged pass instead of hanging", async () => {
  const wedged = deferred();
  let runs = 0;
  const flush = createSingleFlight(() => { runs += 1; return wedged.promise; }, { waitTimeoutMs: 20 });
  const release = keepEventLoopAlive();

  flush().catch(() => {});
  await assert.rejects(() => flush({ forceFresh: true }), /has still not finished after/);
  release();
  // Deliberately does NOT start its own pass: the wedged one may still hold a
  // transaction open, and overlapping passes is the hazard the guard prevents.
  assert.equal(runs, 1);

  wedged.resolve({ flushed: [] });
});

// The tick fires every 5s with no re-entry guard of its own. If a plain caller
// waited out the bound, a wedged pass would leave a waiter, a timer and a
// permanent handler on the never-settling promise behind on every single fire.
test("a plain caller behind a wedged pass returns immediately, without waiting out the bound", async () => {
  const wedged = deferred();
  let runs = 0;
  const flush = createSingleFlight(() => { runs += 1; return wedged.promise; }, { waitTimeoutMs: 20_000 });
  const release = keepEventLoopAlive();

  flush().catch(() => {});
  // A 20s bound: anything that waits it out cannot finish inside this test.
  for (let i = 0; i < 25; i += 1) {
    assert.deepEqual(await flush(), { flushed: [], alreadyRunning: true });
  }
  assert.equal(runs, 1, "a plain caller must never start its own pass");
  release();

  wedged.resolve({ flushed: [] });
});

test("the wait bound never applies to a pass this call started itself", async () => {
  const flush = createSingleFlight(
    async () => { await new Promise((resolve) => setTimeout(resolve, 60)); return { flushed: ["slow"] }; },
    { waitTimeoutMs: 20 });

  assert.deepEqual(await flush({ forceFresh: true }), { flushed: ["slow"] });
});
