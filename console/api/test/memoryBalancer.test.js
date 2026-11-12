import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyContainerSwapStats, collectContainerSwapStats, createDockerStatsSampler, createMemoryBalancer, dockerMemoryUpdateArgs, parseContainerSwapStats, parseDockerStatsRow, readMemorySwapAllowanceBytes } from "../src/services/memoryBalancer.js";

test("memory balancer updates Docker swap limit with memory limit", () => {
  assert.deepEqual(dockerMemoryUpdateArgs("dune-server-overmap", 2 * 1024 ** 3), [
    "update",
    "--memory",
    "2048m",
    "--memory-swap",
    "4096m",
    "--memory-reservation",
    "2048m",
    "dune-server-overmap"
  ]);
});

test("memory balancer preserves the configured emergency swap allowance", () => {
  assert.deepEqual(dockerMemoryUpdateArgs("dune-server-overmap", 2 * 1024 ** 3, 2 * 1024 ** 3), [
    "update", "--memory", "2048m", "--memory-swap", "4096m", "--memory-reservation", "2048m", "dune-server-overmap"
  ]);
});

test("memory balancer reads only validated enabled swap settings", () => {
  const root = mkdtempSync(join(tmpdir(), "dune-memory-swap-env-"));
  writeFileSync(join(root, ".env"), "DUNE_MEMORY_SWAP_ENABLED=1\nDUNE_MEMORY_SWAP_PER_SERVER_GIB=2\n");
  assert.equal(readMemorySwapAllowanceBytes({ repoRoot: root }), 2 * 1024 ** 3);
  writeFileSync(join(root, ".env"), "DUNE_MEMORY_SWAP_ENABLED=0\nDUNE_MEMORY_SWAP_PER_SERVER_GIB=12\n");
  assert.equal(readMemorySwapAllowanceBytes({ repoRoot: root }), 0);
  rmSync(root, { recursive: true, force: true });
});

test("memory balancer parses docker stats rows", () => {
  const row = parseDockerStatsRow(JSON.stringify({
    Name: "dune-server-overmap",
    MemUsage: "1.5GiB / 2GiB",
    MemPerc: "75.00%"
  }));
  assert.equal(row.container, "dune-server-overmap");
  assert.equal(row.map, "Overmap");
  assert.equal(row.percent, 75);
});

test("memory balancer canonicalizes DeepDesert containers", () => {
  const row = parseDockerStatsRow(JSON.stringify({
    Name: "dune-server-deepdesert-1-8",
    MemUsage: "3GiB / 16GiB",
    MemPerc: "18.75%"
  }));
  assert.equal(row.container, "dune-server-deepdesert-1-8");
  assert.equal(row.map, "DeepDesert_1");
});

test("memory sampler parses cgroup v2 and v1 swap counters", () => {
  assert.deepEqual(parseContainerSwapStats("v2|2147483648|4294967296\n"), {
    supported: true,
    cgroupVersion: 2,
    usedBytes: 2 * 1024 ** 3,
    limitBytes: 4 * 1024 ** 3
  });
  assert.deepEqual(parseContainerSwapStats("v1|10737418240|12884901888|13958643712|16106127360\n"), {
    supported: true,
    cgroupVersion: 1,
    usedBytes: 2 * 1024 ** 3,
    limitBytes: 2 * 1024 ** 3
  });
  assert.equal(parseContainerSwapStats("v2|not-a-number|2147483648").supported, false);
});

test("live memory sampler enriches RAM rows with current container swap", async () => {
  const row = { container: "dune-server-overmap", usedBytes: 10 * 1024 ** 3, limitBytes: 13 * 1024 ** 3 };
  const sampler = createDockerStatsSampler({}, {
    collect: async () => [row],
    collectSwap: async () => new Map([[row.container, parseContainerSwapStats("v2|2147483648|2147483648")]])
  });
  const snapshot = await sampler.read();
  assert.equal(snapshot.rows[0].swapSupported, true);
  assert.equal(snapshot.rows[0].swapUsedBytes, 2 * 1024 ** 3);
  assert.equal(snapshot.rows[0].swapLimitBytes, 2 * 1024 ** 3);
});

test("swap collector is disabled with managed memory swap and ignores stopped-container races", async () => {
  const root = mkdtempSync(join(tmpdir(), "dune-memory-swap-sampler-"));
  const rows = [{ container: "dune-server-overmap" }, { container: "dune-server-survival-1" }];
  writeFileSync(join(root, ".env"), "DUNE_MEMORY_SWAP_ENABLED=0\n");
  let calls = 0;
  assert.equal((await collectContainerSwapStats({ repoRoot: root }, rows, { run: async () => { calls += 1; } })).size, 0);
  assert.equal(calls, 0);

  writeFileSync(join(root, ".env"), "DUNE_MEMORY_SWAP_ENABLED=1\nDUNE_MEMORY_SWAP_PER_SERVER_GIB=2\n");
  const collected = await collectContainerSwapStats({ repoRoot: root }, rows, { run: async (container) => {
    calls += 1;
    if (container.endsWith("survival-1")) throw new Error("container stopped");
    return "v2|1073741824|2147483648";
  } });
  assert.equal(calls, 2);
  assert.equal(collected.size, 1);
  assert.equal(collected.get("dune-server-overmap").usedBytes, 1024 ** 3);
  rmSync(root, { recursive: true, force: true });
});

test("swap enrichment leaves unsupported rows explicit instead of estimating", () => {
  const rows = applyContainerSwapStats([{ container: "dune-server-overmap", usedBytes: 1 }], new Map());
  assert.deepEqual(rows[0], {
    container: "dune-server-overmap",
    usedBytes: 1,
    swapUsedBytes: 0,
    swapLimitBytes: 0,
    swapSupported: false
  });
});

test("live memory sampler caches completed Docker stats collections", async () => {
  let currentTime = 1000;
  let collections = 0;
  const sampler = createDockerStatsSampler({}, {
    cacheMs: 10000,
    now: () => currentTime,
    collect: async () => [{ container: `sample-${++collections}` }]
  });

  const first = await sampler.read();
  currentTime += 5000;
  const cached = await sampler.read();
  assert.equal(collections, 1);
  assert.strictEqual(cached, first);

  currentTime += 5001;
  const refreshed = await sampler.read();
  assert.equal(collections, 2);
  assert.notStrictEqual(refreshed, first);
});

test("live memory sampler coalesces overlapping and forced collections", async () => {
  let release;
  let collections = 0;
  const sampler = createDockerStatsSampler({}, {
    collect: () => {
      collections += 1;
      return new Promise((resolve) => { release = resolve; });
    }
  });

  const first = sampler.read();
  const overlapping = sampler.read({ fresh: true });
  await Promise.resolve();
  assert.equal(collections, 1);
  release([{ container: "dune-server-overmap" }]);
  assert.strictEqual(await overlapping, await first);

  const forced = sampler.read({ fresh: true });
  await Promise.resolve();
  assert.equal(collections, 2);
  release([{ container: "dune-server-survival-1" }]);
  await forced;
});

test("memory balancer persists enabled state across restarts", async () => {
  const root = mkdtempSync(join(tmpdir(), "dune-memory-balancer-"));
  const generatedDir = join(root, "runtime/generated");
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(join(generatedDir, "memory-balancer.json"), JSON.stringify({ enabled: true }));

  const balancer = createMemoryBalancer({ repoRoot: root, generatedDir });
  assert.equal(balancer.publicState().enabled, true);

  await balancer.setEnabled(false);
  assert.equal(JSON.parse(readFileSync(join(generatedDir, "memory-balancer.json"), "utf8")).enabled, false);

  rmSync(root, { recursive: true, force: true });
});

for (const failure of [false, true]) {
  test(`memory limit diagnostics record ${failure ? "failure without secrets" : "each completed receiver and donor change"}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "dune-memory-diagnostics-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "memory-balancer.json"), JSON.stringify({ enabled: true }));
    const gib = 1024 ** 3;
    const rows = [
      { container: "dune-server-survival-1", map: "Survival_1", usedBytes: 9.5 * gib, limitBytes: 10 * gib, percent: 95 },
      { container: "dune-server-overmap", map: "Overmap", usedBytes: gib, limitBytes: 5 * gib, percent: 20 }
    ];
    const events = [], applied = [];
    const balancer = createMemoryBalancer({ repoRoot: root, generatedDir: root }, {
      sampler: { read: async () => ({ rows }) },
      writeDiagnostic: event => events.push(event),
      applyMemoryLimit: async (container, limit) => {
        applied.push([container, limit]);
        if (failure) throw new Error("private-error-password=do-not-log");
      }
    });
    await balancer.tick();
    assert.deepEqual(events.map(event => event.outcome), failure ? ["requested", "failed"] : ["requested", "applied", "requested", "applied"]);
    assert.equal(events[0].previousLimitBytes, 10 * gib);
    assert.equal(events[0].limitBytes, 11 * gib);
    assert.equal(events[0].reason, "rebalance-receiver");
    assert.ok(events.every(event => Number.isFinite(Date.parse(event.at)) && event.durationMs >= 0));
    assert.doesNotMatch(JSON.stringify(events), /private-error|password|do-not-log/);
    assert.equal(applied.length, failure ? 1 : 2);
    if (!failure) {
      assert.equal(events[2].reason, "rebalance-donor");
      assert.equal(events[2].previousLimitBytes, 5 * gib);
      assert.equal(events[2].limitBytes, 4 * gib);
    }
  });
}

test("diagnostic sink failure cannot prevent a memory transfer", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "dune-memory-diagnostics-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "memory-balancer.json"), JSON.stringify({ enabled: true }));
  const gib = 1024 ** 3, applied = [];
  const balancer = createMemoryBalancer({ repoRoot: root, generatedDir: root }, {
    sampler: { read: async () => ({ rows: [
      { container: "dune-server-survival-1", map: "Survival_1", usedBytes: 9.5 * gib, limitBytes: 10 * gib, percent: 95 },
      { container: "dune-server-overmap", map: "Overmap", usedBytes: gib, limitBytes: 5 * gib, percent: 20 }
    ] }) },
    writeDiagnostic() { throw new Error("sink unavailable"); },
    applyMemoryLimit: async (...args) => applied.push(args)
  });
  await balancer.tick();
  assert.equal(applied.length, 2);
  assert.equal(balancer.publicState().lastError, "");
});
