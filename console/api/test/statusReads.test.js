import test from "node:test";
import assert from "node:assert/strict";
import { createReadCommandCache } from "../src/services/readCommandCache.js";
import { createStatusReads } from "../src/services/statusReads.js";

const T0 = Date.UTC(2026, 9, 28, 12, 0, 0);
const STATUS = "=== Dune status ===\nOverall:     READY\nTitle:       Example Sietch\n";

// The real caches with a controllable clock, and a fake `dune` runner that
// records every command it is asked to run.
function harness({ statusTtl = 5000, statusStale = 30000, outputs = {} } = {}) {
  let now = T0;
  const clock = () => now;
  const calls = [];
  const statusCache = createReadCommandCache({ ttlMs: statusTtl, staleMs: statusStale, clock });
  const readinessCache = createReadCommandCache({ ttlMs: 2000, clock });
  const reads = createStatusReads({
    statusCache,
    readinessCache,
    argsFor: (operation) => [operation],
    runArgs: async ([operation]) => {
      calls.push(operation);
      const output = outputs[operation];
      if (output instanceof Error) throw output;
      return { stdout: output ?? (operation === "status" ? STATUS : "READY: all checks passed"), stderr: "", code: 0 };
    }
  });
  return { reads, calls, tick: (ms) => { now += ms; } };
}

const url = (query = "") => new URL(`http://console/api/server/status${query}`);

test("status is stamped with when the command ran, and a cache hit keeps that time", async () => {
  const h = harness();
  const first = await h.reads.status(url());
  assert.equal(first.sampledAt, new Date(T0).toISOString());
  assert.equal(first.fromCache, false);
  assert.equal(first.data.summary.overall, "READY");
  assert.equal(first.stdout, STATUS);

  h.tick(3000);
  const second = await h.reads.status(url());
  assert.equal(second.fromCache, true);
  assert.equal(second.sampledAt, new Date(T0).toISOString());
  assert.deepEqual(h.calls, ["status"]);
});

test("?fresh=1 re-runs status instead of answering from the cache", async () => {
  const h = harness();
  await h.reads.status(url());
  h.tick(1000);
  const fresh = await h.reads.status(url("?fresh=1"));
  assert.equal(fresh.fromCache, false);
  assert.equal(fresh.sampledAt, new Date(T0 + 1000).toISOString());
  assert.deepEqual(h.calls, ["status", "status"]);
});

test("only fresh=1 counts as fresh", async () => {
  const h = harness();
  await h.reads.status(url());
  for (const query of ["?fresh=0", "?fresh=true", "?fresh="]) {
    assert.equal((await h.reads.status(url(query))).fromCache, true, query);
  }
  assert.deepEqual(h.calls, ["status"]);
});

test("raw=0 still carries the stamp", async () => {
  const h = harness();
  const compact = await h.reads.status(url("?raw=0"), { includeRaw: false });
  assert.equal("stdout" in compact, false);
  assert.equal(compact.sampledAt, new Date(T0).toISOString());
  assert.equal(compact.fromCache, false);
});

test("readiness is stamped and honours fresh", async () => {
  const h = harness();
  const first = await h.reads.readiness(url());
  assert.deepEqual(first, {
    operation: "readiness",
    stdout: "READY: all checks passed",
    stderr: "",
    exitCode: 0,
    sampledAt: new Date(T0).toISOString(),
    fromCache: false
  });
  assert.equal((await h.reads.readiness(url())).fromCache, true);
  assert.equal((await h.reads.readiness(url("?fresh=1"))).fromCache, false);
  assert.deepEqual(h.calls, ["readiness", "readiness"]);
});

// The status cache serves a stale snapshot for up to 30s. Readiness must not:
// a caller that never sends fresh would see the pre-restart READY.
test("readiness does not ride the status cache's stale window", async () => {
  const h = harness();
  await h.reads.readiness(url());
  h.tick(2500);
  const later = await h.reads.readiness(url());
  assert.equal(later.fromCache, false);
  assert.equal(later.sampledAt, new Date(T0 + 2500).toISOString());
});

test("a failed command reports its output and exit code with no stamp", async () => {
  const failure = Object.assign(new Error("dune ready failed"), { stdout: "NOT READY: director", stderr: "boom", code: 3 });
  const h = harness({ outputs: { readiness: failure } });
  const result = await h.reads.readiness(url());
  assert.deepEqual(result, { operation: "readiness", stdout: "NOT READY: director", stderr: "boom", exitCode: 3 });
  assert.equal("sampledAt" in result, false);
});

test("a failed status command still returns a structured response, unstamped", async () => {
  const h = harness({ outputs: { status: Object.assign(new Error("docker unavailable"), { code: 2 }) } });
  const result = await h.reads.status(url());
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.equal("sampledAt" in result, false);
});

test("invalidate makes both reads run again", async () => {
  const h = harness();
  await h.reads.status(url());
  await h.reads.readiness(url());
  h.reads.invalidate();
  assert.equal((await h.reads.status(url())).fromCache, false);
  assert.equal((await h.reads.readiness(url())).fromCache, false);
  assert.deepEqual(h.calls, ["status", "readiness", "status", "readiness"]);
});

test("a status cache TTL of 0 never answers from cache", async () => {
  const h = harness({ statusTtl: 0, statusStale: 0 });
  await h.reads.status(url());
  assert.equal((await h.reads.status(url())).fromCache, false);
  assert.deepEqual(h.calls, ["status", "status"]);
});
