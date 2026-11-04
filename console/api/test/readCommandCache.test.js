import test from "node:test";
import assert from "node:assert/strict";
import { createReadCommandCache } from "../src/services/readCommandCache.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("fresh status readers never receive cached Ready and share the current refresh", async () => {
  let now = 1000;
  const cache = createReadCommandCache({ ttlMs: 100, staleMs: 500, clock: () => now });
  await cache.run("readiness", async () => "Ready");
  for (const time of [1050, 1200]) {
    now = time;
    const gate = deferred();
    let runs = 0;
    const work = () => { runs += 1; return gate.promise; };
    const first = cache.run("readiness", work, { fresh: true });
    const second = cache.run("readiness", work, { fresh: true });
    gate.resolve("Loading");
    assert.deepEqual(await Promise.all([first, second]), ["Loading", "Loading"]);
    assert.equal(runs, 1);
  }
});

test("fresh reads wait for an existing background refresh instead of returning stale Ready", async () => {
  let now = 1000;
  const cache = createReadCommandCache({ ttlMs: 100, staleMs: 500, clock: () => now });
  await cache.run("readiness", async () => "Ready");
  now = 1100;
  const gate = deferred();
  assert.equal(await cache.run("readiness", () => gate.promise), "Ready");
  const current = cache.run("readiness", () => { throw new Error("must share refresh"); }, { fresh: true });
  gate.resolve("Loading");
  assert.equal(await current, "Loading");
});

test("concurrent readers share one in-flight command and its result", async () => {
  const gate = deferred();
  const cache = createReadCommandCache();
  let runs = 0;
  const work = () => { runs += 1; return gate.promise; };

  const readers = [cache.run("ready", work), cache.run("ready", work), cache.run("ready", work)];
  gate.resolve({ stdout: "READY" });

  assert.deepEqual(await Promise.all(readers), [
    { stdout: "READY" },
    { stdout: "READY" },
    { stdout: "READY" }
  ]);
  assert.equal(runs, 1);
});

test("a short-lived result cache absorbs sequential browser refreshes", async () => {
  let now = 1000;
  let runs = 0;
  const cache = createReadCommandCache({ ttlMs: 2000, clock: () => now });
  const work = async () => ({ run: ++runs });

  assert.deepEqual(await cache.run("status", work), { run: 1 });
  now = 2999;
  assert.deepEqual(await cache.run("status", work), { run: 1 });
  now = 3000;
  assert.deepEqual(await cache.run("status", work), { run: 2 });
});

test("different command arguments never share a result", async () => {
  const cache = createReadCommandCache();
  let runs = 0;
  const work = async () => ++runs;

  assert.equal(await cache.run('["maps","one"]', work), 1);
  assert.equal(await cache.run('["maps","two"]', work), 2);
});

test("failed commands are not cached and can be retried", async () => {
  const cache = createReadCommandCache();
  let runs = 0;

  await assert.rejects(() => cache.run("ready", async () => {
    runs += 1;
    throw new Error("Docker is busy");
  }), /Docker is busy/);

  assert.equal(await cache.run("ready", async () => ++runs), 2);
});

test("stale readers return immediately while one background refresh runs", async () => {
  let now = 1000;
  let runs = 0;
  const gate = deferred();
  const cache = createReadCommandCache({ ttlMs: 100, staleMs: 500, clock: () => now });

  assert.deepEqual(await cache.run("status", async () => ({ run: ++runs })), { run: 1 });
  now = 1100;
  const staleReaders = await Promise.all([
    cache.run("status", () => { runs += 1; return gate.promise; }),
    cache.run("status", () => { runs += 1; return gate.promise; })
  ]);
  assert.deepEqual(staleReaders, [{ run: 1 }, { run: 1 }]);
  assert.equal(runs, 2);

  gate.resolve({ run: 2 });
  await gate.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await cache.run("status", async () => ({ run: ++runs })), { run: 2 });
  assert.equal(runs, 2);
});

test("failed background refresh retains the bounded stale snapshot", async () => {
  let now = 1000;
  let runs = 0;
  const cache = createReadCommandCache({ ttlMs: 100, staleMs: 500, clock: () => now });

  assert.equal(await cache.run("status", async () => ++runs), 1);
  now = 1100;
  assert.equal(await cache.run("status", async () => {
    runs += 1;
    throw new Error("Docker is busy");
  }), 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await cache.run("status", async () => ++runs), 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 3);
});

test("sampledAtMs is when the command ran, not when the cache was read", async () => {
  let now = 1000;
  const cache = createReadCommandCache({ ttlMs: 100, staleMs: 500, clock: () => now });

  const first = await cache.runStamped("status", async () => "out");
  assert.deepEqual(first, { value: "out", sampledAtMs: 1000, fromCache: false });

  now = 1050;
  assert.deepEqual(await cache.runStamped("status", async () => "other"), { value: "out", sampledAtMs: 1000, fromCache: true });

  // Stale window: still the original sample time while a refresh runs behind it.
  now = 1300;
  assert.deepEqual(await cache.runStamped("status", async () => "newer"), { value: "out", sampledAtMs: 1000, fromCache: true });
});

test("invalidate forces the next read to re-run", async () => {
  let runs = 0;
  const cache = createReadCommandCache({ ttlMs: 60_000 });
  assert.equal(await cache.run("status", async () => ++runs), 1);
  cache.invalidate();
  assert.equal(await cache.run("status", async () => ++runs), 2);
});

test("invalidate drops a stale snapshot instead of serving it", async () => {
  let now = 1000;
  let runs = 0;
  const cache = createReadCommandCache({ ttlMs: 100, staleMs: 500, clock: () => now });
  assert.equal(await cache.run("status", async () => ++runs), 1);
  now = 1100;
  // Inside the stale window a plain read would answer 1, but a stop landed in between.
  cache.invalidate();
  assert.equal(await cache.run("status", async () => ++runs), 2);
});

test("invalidate discards a collect that started before it", async () => {
  const cache = createReadCommandCache({ ttlMs: 60_000 });
  const gate = deferred();
  let runs = 0;
  const inFlight = cache.run("status", async () => { runs += 1; await gate.promise; return runs; });
  cache.invalidate();
  gate.resolve();
  // Callers that asked before the change still get its answer...
  assert.equal(await inFlight, 1);
  // ...but it is not kept for the next reader.
  assert.equal(await cache.run("status", async () => ++runs), 2);
});

test("a failed refresh after invalidate does not restore the old snapshot", async () => {
  let now = 1000;
  let runs = 0;
  const cache = createReadCommandCache({ ttlMs: 100, staleMs: 500, clock: () => now });
  assert.equal(await cache.run("status", async () => ++runs), 1);
  now = 1100;
  const gate = deferred();
  // Starts a background refresh and answers from the stale snapshot.
  assert.equal(await cache.run("status", () => gate.promise), 1);
  cache.invalidate();
  gate.reject(new Error("Docker is busy"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await cache.run("status", async () => ++runs), 2);
});

test("a zero TTL caches nothing but still coalesces concurrent readers", async () => {
  const cache = createReadCommandCache({ ttlMs: 0 });
  const gate = deferred();
  let runs = 0;
  const work = () => { runs += 1; return gate.promise; };
  const readers = [cache.run("status", work), cache.run("status", work)];
  gate.resolve("out");
  assert.deepEqual(await Promise.all(readers), ["out", "out"]);
  assert.equal(await cache.run("status", async () => { runs += 1; return "again"; }), "again");
  assert.equal(runs, 2);
});
