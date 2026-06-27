import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryBalancer, dockerMemoryUpdateArgs, parseDockerStatsRow } from "../src/services/memoryBalancer.js";

test("memory balancer updates Docker swap limit with memory limit", () => {
  assert.deepEqual(dockerMemoryUpdateArgs("dune-server-overmap", 2 * 1024 ** 3), [
    "update",
    "--memory",
    "2048m",
    "--memory-swap",
    "2048m",
    "--memory-reservation",
    "2048m",
    "dune-server-overmap"
  ]);
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
