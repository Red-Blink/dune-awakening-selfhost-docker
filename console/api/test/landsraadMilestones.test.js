import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLandsraadMilestoneReconciler, normalizeLandsraadMilestonePreset, readLandsraadMilestonePreset, saveLandsraadMilestonePreset } from "../src/services/landsraadMilestones.js";

test("landsraad milestone presets validate and persist stable settings", () => {
  const root = mkdtempSync(join(tmpdir(), "landsraad-milestones-"));
  const config = { repoRoot: root, generatedDir: join(root, "runtime/generated") };
  try {
    const saved = saveLandsraadMilestonePreset(config, { enabled: true, goalAmount: 8000, thresholds: [1000, 3000, 6000] });
    assert.deepEqual(saved.thresholds, [1000, 3000, 6000]);
    assert.equal(readLandsraadMilestonePreset(config).enabled, true);
    const raw = JSON.parse(readFileSync(join(config.generatedDir, "landsraad-milestones.json"), "utf8"));
    assert.equal(raw.schemaVersion, 1);
    assert.equal(raw.goalAmount, 8000);
    assert.throws(() => normalizeLandsraadMilestonePreset({ enabled: true, goalAmount: 8000, thresholds: [3000, 3000] }), /must increase/);
    assert.throws(() => normalizeLandsraadMilestonePreset({ enabled: true, goalAmount: 8000, thresholds: [0, 3000] }), /greater than zero/);
    assert.throws(() => normalizeLandsraadMilestonePreset({ enabled: "true", goalAmount: 8000, thresholds: [1000] }), /enabled or disabled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("landsraad reconciler applies an enabled preset once per generated term", async () => {
  const root = mkdtempSync(join(tmpdir(), "landsraad-reconcile-"));
  const config = { repoRoot: root, generatedDir: join(root, "runtime/generated") };
  const db = { query: async () => ({ rows: [{ term_id: "42" }] }) };
  let applyCount = 0;
  try {
    saveLandsraadMilestonePreset(config, { enabled: true, goalAmount: 8000, thresholds: [1000, 3000] });
    const reconciler = createLandsraadMilestoneReconciler(config, {
      getDb: () => db,
      intervalMs: 10_000,
      applyPreset: async (_db, preset) => {
        applyCount += 1;
        assert.equal(preset.goalAmount, 8000);
        return { ok: true, applied: true, termId: "42" };
      }
    });
    const first = await reconciler.tick(20_000);
    const second = await reconciler.tick(40_000);
    assert.equal(first.result.applied, true);
    assert.equal(second.reason, "already-applied");
    assert.equal(applyCount, 1);
    assert.equal(readLandsraadMilestonePreset(config).lastAppliedTermId, "42");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("landsraad reconciler keeps retrying a new term until reward rows are ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "landsraad-retry-"));
  const config = { repoRoot: root, generatedDir: join(root, "runtime/generated") };
  const db = { query: async () => ({ rows: [{ term_id: "43" }] }) };
  let ready = false;
  try {
    saveLandsraadMilestonePreset(config, { enabled: true, goalAmount: 9000, thresholds: [1500, 4500] });
    const reconciler = createLandsraadMilestoneReconciler(config, {
      getDb: () => db,
      intervalMs: 10_000,
      applyPreset: async () => ready
        ? { ok: true, applied: true, termId: "43" }
        : { ok: true, applied: false, termId: "43", reason: "Rewards are still generating." }
    });
    const waiting = await reconciler.tick(20_000);
    assert.equal(waiting.result.applied, false);
    assert.equal(readLandsraadMilestonePreset(config).lastAppliedTermId, null);
    ready = true;
    const applied = await reconciler.tick(40_000);
    assert.equal(applied.result.applied, true);
    assert.equal(readLandsraadMilestonePreset(config).lastAppliedTermId, "43");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
