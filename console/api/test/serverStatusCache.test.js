import test from "node:test";
import assert from "node:assert/strict";
import { createServerStatusCache } from "../src/services/serverStatusCache.js";

function build(overrides = {}) {
  let currentTime = 1000;
  const collections = { status: 0, readiness: 0 };
  const cache = createServerStatusCache({ statusCacheMs: 15000 }, {
    now: () => currentTime,
    collectStatus: async () => ({ operation: "status", stdout: `status-${++collections.status}`, stderr: "", exitCode: 0 }),
    collectReadiness: async () => ({ operation: "readiness", stdout: `readiness-${++collections.readiness}`, stderr: "", exitCode: 0 }),
    ...overrides
  });
  return {
    cache,
    collections,
    advance: (ms) => { currentTime += ms; },
    at: () => currentTime
  };
}

test("a second read inside the TTL does not re-run the command", async () => {
  const { cache, collections, advance } = build();

  const first = await cache.read("status");
  assert.equal(collections.status, 1);
  assert.equal(first.fromCache, false);

  advance(14999);
  const second = await cache.read("status");
  // The whole point: Home mounting again must not spawn another ~4s subprocess.
  assert.equal(collections.status, 1, "expected the cached entry to be reused");
  assert.equal(second.fromCache, true);
  assert.equal(second.stdout, "status-1");
});

test("a read past the TTL re-runs the command", async () => {
  const { cache, collections, advance } = build();
  await cache.read("status");
  advance(15001);
  const next = await cache.read("status");
  assert.equal(collections.status, 2);
  assert.equal(next.fromCache, false);
  assert.equal(next.stdout, "status-2");
});

// The restart lifecycle reads through this. If `fresh` did not bypass,
// isHomeActionComplete could be handed a pre-restart snapshot and call a
// restart finished before it started.
test("fresh bypasses the cache even when a fresh entry exists", async () => {
  const { cache, collections } = build();
  await cache.read("status");
  const forced = await cache.read("status", { fresh: true });
  assert.equal(collections.status, 2);
  assert.equal(forced.fromCache, false);
  assert.equal(forced.stdout, "status-2");
});

test("invalidate forces the next read to re-run", async () => {
  const { cache, collections } = build();
  await cache.read("status");
  await cache.read("readiness");
  assert.deepEqual(collections, { status: 1, readiness: 1 });

  cache.invalidate();

  // Both, not just one: a stop changes what each of them reports.
  await cache.read("status");
  await cache.read("readiness");
  assert.deepEqual(collections, { status: 2, readiness: 2 });
});

test("sampledAt is when the command ran, not when the cache was read", async () => {
  const { cache, advance } = build();
  const first = await cache.read("status");
  const sampledAt = first.sampledAt;

  advance(12000);
  const cached = await cache.read("status");
  // Home dates its freshness line from this. If it moved with the read, a
  // 12s-old snapshot would claim to be current.
  assert.equal(cached.sampledAt, sampledAt);
  assert.equal(cached.fromCache, true);
});

test("status and readiness cache independently", async () => {
  const { cache, collections } = build();
  await cache.read("status");
  await cache.read("status");
  assert.deepEqual(collections, { status: 1, readiness: 0 }, "readiness must not be collected by a status read");

  await cache.read("readiness");
  assert.deepEqual(collections, { status: 1, readiness: 1 });
});

test("concurrent reads share one in-flight command", async () => {
  // The gate is created up front, not inside collect: the cache invokes collect
  // on a microtask, so a resolver assigned from inside it is not yet defined
  // when the test tries to release it.
  let resolveCollect;
  const gate = new Promise((resolve) => { resolveCollect = resolve; });
  let collections = 0;
  const cache = createServerStatusCache({ statusCacheMs: 15000 }, {
    collectStatus: async () => {
      collections += 1;
      await gate;
      return { operation: "status", stdout: "status", stderr: "", exitCode: 0 };
    },
    collectReadiness: async () => ({ operation: "readiness", stdout: "readiness", stderr: "", exitCode: 0 })
  });

  const both = Promise.all([cache.read("status"), cache.read("status")]);
  resolveCollect();
  await both;
  assert.equal(collections, 1, "two simultaneous Home loads must not spawn two subprocesses");
});

test("a zero TTL disables caching entirely", async () => {
  const { cache, collections } = build({ cacheMs: 0 });
  await cache.read("status");
  await cache.read("status");
  assert.equal(collections.status, 2, "cacheMs 0 is the documented escape hatch");
});

test("an unknown operation throws rather than silently returning nothing", () => {
  const { cache } = build();
  assert.throws(() => cache.read("doctor"), /No status cache for operation: doctor/);
});
