import test from "node:test";
import assert from "node:assert/strict";
import { createUpdateCheckCache } from "../src/services/updateCheckCache.js";

test("update check cache reuses a completed result within the TTL", async () => {
  let currentTime = 1000;
  let collections = 0;
  const cache = createUpdateCheckCache({}, {
    cacheMs: 10000,
    now: () => currentTime,
    collect: async () => ({ code: 0, stdout: `build-${++collections}` })
  });

  const first = await cache.read();
  assert.equal(collections, 1);
  assert.equal(first.fromCache, false);

  currentTime += 5000;
  const cached = await cache.read();
  assert.equal(collections, 1);
  assert.equal(cached.fromCache, true);
  assert.equal(cached.stdout, "build-1");

  currentTime += 5001;
  const refreshed = await cache.read();
  assert.equal(collections, 2);
  assert.equal(refreshed.fromCache, false);
  assert.equal(refreshed.stdout, "build-2");
});

test("update check cache coalesces overlapping and forced reads onto one in-flight collection", async () => {
  let release;
  let collections = 0;
  const cache = createUpdateCheckCache({}, {
    collect: () => {
      collections += 1;
      return new Promise((resolve) => { release = resolve; });
    }
  });

  const first = cache.read();
  const overlapping = cache.read({ fresh: true });
  await Promise.resolve();
  assert.equal(collections, 1);

  release({ code: 0, stdout: "build-result" });
  const firstResult = await first;
  const overlappingResult = await overlapping;

  assert.equal(firstResult.stdout, "build-result");
  assert.equal(overlappingResult.stdout, "build-result");
  assert.equal(firstResult.code, overlappingResult.code);
});

test("update check cache does not cache a rejected collection", async () => {
  let collections = 0;
  let shouldReject = true;
  const cache = createUpdateCheckCache({}, {
    collect: async () => {
      collections += 1;
      if (shouldReject) {
        throw new Error("steamcmd timeout");
      }
      return { code: 0, stdout: "build-success" };
    }
  });

  await assert.rejects(() => cache.read(), /steamcmd timeout/);
  assert.equal(collections, 1);

  shouldReject = false;
  const result = await cache.read();
  assert.equal(collections, 2);
  assert.equal(result.stdout, "build-success");
});

test("invalidate clears the cached result and forces the next read to recollect", async () => {
  let collections = 0;
  const cache = createUpdateCheckCache({}, {
    cacheMs: 10000,
    collect: async () => ({ code: 0, stdout: `build-${++collections}` })
  });

  const first = await cache.read();
  assert.equal(collections, 1);

  cache.invalidate();

  const second = await cache.read();
  assert.equal(collections, 2);
  assert.equal(second.stdout, "build-2");
});
