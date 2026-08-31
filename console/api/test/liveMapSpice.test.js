import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveMapSpice } from "../src/services/liveMapSpice.js";

function configWithArchive(archive) {
  const root = mkdtempSync(join(tmpdir(), "dune-spice-locations-test-"));
  const file = join(root, "large-spice-locations.json");
  if (archive !== undefined) writeFileSync(file, JSON.stringify(archive));
  return { spiceLocationsFile: file };
}

const noPersist = () => {};

const SAMPLE_ARCHIVE = {
  generated_at: "2026-08-21T12:03:00Z",
  dimension_index: 0,
  seeds: {
    "cor-2": {
      fields: [
        { field_id: "5007190163237080", x: 129775, y: -238525, confidence: "confirmed" },
        { field_id: "1111111111111111", x: 500, y: 500, confidence: "corroborated" }
      ]
    },
    "cor-5": { fields: [{ field_id: "9182734650192837", x: -50200, y: 118900, confidence: "confirmed" }] }
  }
};

const noLiveRows = async () => ({ capabilities: { spiceActive: false }, rows: [] });
const noFlourSandRows = async () => ({ capabilities: { flourSand: false }, rows: [] });

test("spice rows come from the archive pool regardless of live activity", async () => {
  const config = configWithArchive(SAMPLE_ARCHIVE);
  const result = await liveMapSpice(null, config, "DeepDesert", { resolveCycle: async () => ({ seed: "cor-2", nextCycleAt: null }), fetchLiveRows: noLiveRows, fetchFlourSandRows: noFlourSandRows });
  assert.equal(result.capabilities.spice, true);
  assert.equal(result.capabilities.spice_active, false);
  assert.equal(result.capabilities.flour_sand, false);
  assert.equal(result.currentSeed, "cor-2");
  assert.equal(result.generatedAt, "2026-08-21T12:03:00Z");
  const spiceRows = result.rows.filter((r) => r.type === "spice");
  assert.equal(spiceRows.length, 2);
  assert.deepEqual(spiceRows[0], { id: "5007190163237080", type: "spice", name: "Large Spice", map: "DeepDesert", x: 129775, y: -238525, z: null, confidence: "confirmed", subtype: "Large" });
});

test("spice_active prefers the archive position when a live field_id is also archived", async () => {
  const config = configWithArchive(SAMPLE_ARCHIVE);
  const fetchLiveRows = async () => ({ capabilities: { spiceActive: true }, rows: [{ field_id: "5007190163237080", map: "DeepDesert", partition_id: 8, value_remaining: 2500000, size: "Large" }] });
  const result = await liveMapSpice(null, config, "DeepDesert", { resolveCycle: async () => ({ seed: "cor-2", nextCycleAt: null }), fetchLiveRows, fetchFlourSandRows: noFlourSandRows });
  const activeRows = result.rows.filter((r) => r.type === "spice_active");
  assert.equal(activeRows.length, 1);
  assert.deepEqual(activeRows[0], { id: "5007190163237080", type: "spice_active", name: "Active Large Spice", map: "DeepDesert", x: 129775, y: -238525, z: null, confidence: "confirmed", subtype: "Large", partition_id: 8 });
  assert.equal(result.capabilities.spice_active, true);
});

test("spice_active falls back to decoding field_id when the live field isn't archived", async () => {
  const config = configWithArchive(SAMPLE_ARCHIVE);
  const fetchLiveRows = async () => ({ capabilities: { spiceActive: true }, rows: [{ field_id: "9999999999999999", map: "DeepDesert", partition_id: 59, value_remaining: 2500000, size: "Large" }] });
  const decodePosition = (fieldId) => ({ x: 42, y: -42, z: -4144 });
  const result = await liveMapSpice(null, config, "DeepDesert", { resolveCycle: async () => ({ seed: "cor-2", nextCycleAt: null }), fetchLiveRows, decodePosition, fetchFlourSandRows: noFlourSandRows });
  const activeRows = result.rows.filter((r) => r.type === "spice_active");
  assert.equal(activeRows.length, 1);
  assert.deepEqual(activeRows[0], { id: "9999999999999999", type: "spice_active", name: "Active Large Spice", map: "DeepDesert", x: 42, y: -42, z: null, confidence: "decoded", subtype: "Large", partition_id: 59 });
});

test("spice_active covers Small/Medium/Large tiers, each with its own subtype", async () => {
  const config = configWithArchive(undefined);
  const fetchLiveRows = async () => ({
    capabilities: { spiceActive: true },
    rows: [
      { field_id: "1", map: "DeepDesert", partition_id: 8, value_remaining: 2500000, size: "Large" },
      { field_id: "2", map: "DeepDesert", partition_id: 8, value_remaining: 150000, size: "Medium" },
      { field_id: "3", map: "DeepDesert", partition_id: 8, value_remaining: 5000, size: "Small" }
    ]
  });
  const decodePosition = () => ({ x: 0, y: 0, z: 0 });
  const result = await liveMapSpice(null, config, "DeepDesert", { resolveCycle: async () => ({ seed: "cor-2", nextCycleAt: null }), fetchLiveRows, decodePosition, fetchFlourSandRows: noFlourSandRows });
  const activeRows = result.rows.filter((r) => r.type === "spice_active");
  assert.deepEqual(activeRows.map((r) => r.subtype).sort(), ["Large", "Medium", "Small"]);
  assert.deepEqual(activeRows.map((r) => r.name).sort(), ["Active Large Spice", "Active Medium Spice", "Active Small Spice"]);
});

test("spice_active works with no archive file at all (decode-only self-hoster case)", async () => {
  const config = configWithArchive(undefined);
  const fetchLiveRows = async () => ({ capabilities: { spiceActive: true }, rows: [{ field_id: "9999999999999999", map: "DeepDesert", partition_id: 8, value_remaining: 2500000, size: "Large" }] });
  const decodePosition = () => ({ x: 1, y: 2, z: 3 });
  const result = await liveMapSpice(null, config, "DeepDesert", { resolveCycle: async () => ({ seed: "cor-2", nextCycleAt: null }), fetchLiveRows, decodePosition, fetchFlourSandRows: noFlourSandRows });
  assert.equal(result.capabilities.spice, false);
  assert.equal(result.capabilities.spice_active, true);
  assert.equal(result.rows.filter((r) => r.type === "spice_active").length, 1);
});

test("flour_sand rows are always decode-only, never archive-backed", async () => {
  const config = configWithArchive(SAMPLE_ARCHIVE);
  const fetchFlourSandRows = async () => ({ capabilities: { flourSand: true }, rows: [{ field_id: "7777777777777777", map: "DeepDesert", partition_id: 8, value_remaining: 60000 }] });
  const decodePosition = () => ({ x: 10, y: 20, z: -3000 });
  const result = await liveMapSpice(null, config, "DeepDesert", { resolveCycle: async () => ({ seed: "cor-2", nextCycleAt: null }), fetchLiveRows: noLiveRows, fetchFlourSandRows, decodePosition });
  const flourRows = result.rows.filter((r) => r.type === "flour_sand");
  assert.equal(flourRows.length, 1);
  assert.deepEqual(flourRows[0], { id: "7777777777777777", type: "flour_sand", name: "Flour Sand", map: "DeepDesert", x: 10, y: 20, z: null, confidence: "decoded", partition_id: 8 });
  assert.equal(result.capabilities.flour_sand, true);
});

test("flour_sand works with no archive file at all, independent of spice/spice_active", async () => {
  const config = configWithArchive(undefined);
  const fetchFlourSandRows = async () => ({ capabilities: { flourSand: true }, rows: [{ field_id: "7777777777777777", map: "DeepDesert", partition_id: 8, value_remaining: 60000 }] });
  const decodePosition = () => ({ x: 10, y: 20, z: -3000 });
  const result = await liveMapSpice(null, config, "DeepDesert", { resolveCycle: async () => ({ seed: "cor-2", nextCycleAt: null }), fetchLiveRows: noLiveRows, fetchFlourSandRows, decodePosition });
  assert.equal(result.capabilities.spice, false);
  assert.equal(result.capabilities.spice_active, false);
  assert.equal(result.capabilities.flour_sand, true);
});

test("nextCycleAt passes through from the resolved cycle", async () => {
  const config = configWithArchive(SAMPLE_ARCHIVE);
  const result = await liveMapSpice(null, config, "DeepDesert", { resolveCycle: async () => ({ seed: "cor-2", nextCycleAt: "2026-08-25T05:00:00.000Z" }), fetchLiveRows: noLiveRows, fetchFlourSandRows: noFlourSandRows });
  assert.equal(result.nextCycleAt, "2026-08-25T05:00:00.000Z");
});

test("map and partitionId are passed through to resolveCycle so it can route to the selected server", async () => {
  const config = configWithArchive(SAMPLE_ARCHIVE);
  let seenArgs = null;
  const resolveCycle = async (args) => { seenArgs = args; return { seed: "cor-2", nextCycleAt: null }; };
  await liveMapSpice(null, config, "DeepDesert", { resolveCycle, partitionId: "59", fetchLiveRows: noLiveRows, fetchFlourSandRows: noFlourSandRows });
  assert.deepEqual(seenArgs, { map: "DeepDesert", partitionId: "59" });
});

test("no rows of any type when the current seed can't be resolved", async () => {
  const config = configWithArchive(SAMPLE_ARCHIVE);
  const result = await liveMapSpice(null, config, "DeepDesert", { resolveCycle: async () => ({ seed: null, nextCycleAt: null }), fetchLiveRows: noLiveRows, fetchFlourSandRows: noFlourSandRows });
  assert.equal(result.capabilities.spice, false);
  assert.equal(result.capabilities.spice_active, false);
  assert.equal(result.capabilities.flour_sand, false);
  assert.equal(result.currentSeed, "");
  assert.equal(result.nextCycleAt, "");
});

test("Hagga Basin has no archive pool (the archive is Deep-Desert-only) but does get real live spice_active/flour_sand", async () => {
  const config = configWithArchive(SAMPLE_ARCHIVE);
  const fetchLiveRows = async (db, map) => {
    assert.equal(map, "HaggaBasin");
    return { capabilities: { spiceActive: true }, rows: [{ field_id: "8044227649088548", map: "HaggaBasin", partition_id: 1, value_remaining: 5000, size: "Small" }] };
  };
  const fetchFlourSandRows = async (db, map) => {
    assert.equal(map, "HaggaBasin");
    return { capabilities: { flourSand: true }, rows: [{ field_id: "7617665411863667", map: "HaggaBasin", partition_id: 1, value_remaining: 60000 }] };
  };
  const decodePosition = () => ({ x: 273444, y: 95644, z: 1829 });
  const result = await liveMapSpice(null, config, "HaggaBasin", { resolveCycle: async () => ({ seed: "cor-2", nextCycleAt: null }), fetchLiveRows, fetchFlourSandRows, decodePosition });
  assert.equal(result.capabilities.spice, false);
  assert.equal(result.capabilities.spice_active, true);
  assert.equal(result.capabilities.flour_sand, true);
  assert.equal(result.rows.filter((r) => r.type === "spice").length, 0);
  const activeRows = result.rows.filter((r) => r.type === "spice_active");
  assert.equal(activeRows.length, 1);
  assert.equal(activeRows[0].map, "HaggaBasin");
  const flourRows = result.rows.filter((r) => r.type === "flour_sand");
  assert.equal(flourRows.length, 1);
  assert.equal(flourRows[0].map, "HaggaBasin");
  assert.equal(result.currentSeed, "cor-2");
});

test("archive and a learned entry with the same field_id collide -- archive's position/confidence wins", async () => {
  const archiveConfig = configWithArchive({
    generated_at: "2026-08-22T00:00:00Z",
    seeds: { "cor-2": { fields: [{ field_id: "42", x: 999, y: 999, confidence: "confirmed" }] } }
  });
  const learnedRoot = mkdtempSync(join(tmpdir(), "dune-learned-spice-locations-test-"));
  const learnedFile = join(learnedRoot, "learned-spice-locations.json");
  writeFileSync(learnedFile, JSON.stringify({ seeds: { "cor-2": { fields: [{ field_id: "42", map: "DeepDesert", size: "Large", x: 1, y: 1, confidence: "decoded" }] } } }));
  const config = { ...archiveConfig, learnedSpiceLocationsFile: learnedFile };
  const result = await liveMapSpice(null, config, "", { resolveCycle: async () => ({ seed: "cor-2", nextCycleAt: null }), fetchLiveRows: noLiveRows, fetchFlourSandRows: noFlourSandRows, persistObservedFields: noPersist });
  const spiceRows = result.rows.filter((r) => r.type === "spice");
  assert.equal(spiceRows.length, 1);
  assert.equal(spiceRows[0].x, 999);
  assert.equal(spiceRows[0].y, 999);
  assert.equal(spiceRows[0].confidence, "confirmed");
});

test("a learned-only pool entry (no archive at all) shows up with its own map/subtype", async () => {
  const config = configWithArchive(undefined);
  const learnedRoot = mkdtempSync(join(tmpdir(), "dune-learned-spice-locations-test-"));
  const learnedFile = join(learnedRoot, "learned-spice-locations.json");
  writeFileSync(learnedFile, JSON.stringify({ seeds: { "cor-2": { fields: [{ field_id: "77", map: "HaggaBasin", size: "Small", x: 10, y: 20, confidence: "decoded" }] } } }));
  config.learnedSpiceLocationsFile = learnedFile;
  const result = await liveMapSpice(null, config, "", { resolveCycle: async () => ({ seed: "cor-2", nextCycleAt: null }), fetchLiveRows: noLiveRows, fetchFlourSandRows: noFlourSandRows, persistObservedFields: noPersist });
  const spiceRows = result.rows.filter((r) => r.type === "spice");
  assert.equal(spiceRows.length, 1);
  assert.deepEqual(spiceRows[0], { id: "77", type: "spice", name: "Small Spice", map: "HaggaBasin", x: 10, y: 20, z: null, confidence: "decoded", subtype: "Small" });
  assert.equal(result.capabilities.spice, true);
});

test("pool rows are filtered to the requested map", async () => {
  const config = configWithArchive(undefined);
  const learnedRoot = mkdtempSync(join(tmpdir(), "dune-learned-spice-locations-test-"));
  const learnedFile = join(learnedRoot, "learned-spice-locations.json");
  writeFileSync(learnedFile, JSON.stringify({
    seeds: { "cor-2": { fields: [
      { field_id: "1", map: "DeepDesert", size: "Small", x: 1, y: 1, confidence: "decoded" },
      { field_id: "2", map: "HaggaBasin", size: "Small", x: 2, y: 2, confidence: "decoded" }
    ] } }
  }));
  config.learnedSpiceLocationsFile = learnedFile;
  const result = await liveMapSpice(null, config, "HaggaBasin", { resolveCycle: async () => ({ seed: "cor-2", nextCycleAt: null }), fetchLiveRows: noLiveRows, fetchFlourSandRows: noFlourSandRows, persistObservedFields: noPersist });
  const spiceRows = result.rows.filter((r) => r.type === "spice");
  assert.equal(spiceRows.length, 1);
  assert.equal(spiceRows[0].id, "2");
});

test("live-only refreshes omit the static pool while retaining active fields", async () => {
  const config = configWithArchive(SAMPLE_ARCHIVE);
  const fetchLiveRows = async () => ({ capabilities: { spiceActive: true }, rows: [{ field_id: "5007190163237080", map: "DeepDesert", partition_id: 8, value_remaining: 2500000, size: "Large" }] });
  const result = await liveMapSpice(null, config, "DeepDesert", {
    includeStaticPool: false,
    resolveCycle: async () => ({ seed: "cor-2", nextCycleAt: null }),
    fetchLiveRows,
    fetchFlourSandRows: noFlourSandRows,
    decodePosition: () => ({ x: 42, y: 24, z: 0 }),
    persistObservedFields: noPersist
  });
  assert.equal(result.rows.some((row) => row.type === "spice"), false);
  assert.equal(result.rows.some((row) => row.type === "spice_active"), true);
  assert.equal(result.rows.find((row) => row.type === "spice_active")?.x, 129775);
  assert.equal("spice" in result.capabilities, false);
});

test("persistObservedFields is called with exactly the newly active rows when the seed resolves", async () => {
  const config = configWithArchive(undefined);
  const fetchLiveRows = async () => ({ capabilities: { spiceActive: true }, rows: [{ field_id: "5", map: "DeepDesert", partition_id: 8, value_remaining: 5000, size: "Small" }] });
  const decodePosition = () => ({ x: 11, y: 22, z: 33 });
  const calls = [];
  const persistObservedFields = (...args) => calls.push(args);
  await liveMapSpice(null, config, "DeepDesert", { resolveCycle: async () => ({ seed: "cor-2", nextCycleAt: null }), fetchLiveRows, fetchFlourSandRows: noFlourSandRows, decodePosition, persistObservedFields });
  assert.equal(calls.length, 1);
  const [file, seed, fields] = calls[0];
  assert.equal(file, config.learnedSpiceLocationsFile);
  assert.equal(seed, "cor-2");
  assert.deepEqual(fields, [{ field_id: "5", map: "DeepDesert", size: "Small", x: 11, y: 22, confidence: "decoded" }]);
});

test("persistObservedFields is not called when the current seed can't be resolved", async () => {
  const config = configWithArchive(undefined);
  const calls = [];
  const persistObservedFields = (...args) => calls.push(args);
  await liveMapSpice(null, config, "DeepDesert", { resolveCycle: async () => ({ seed: null, nextCycleAt: null }), fetchLiveRows: noLiveRows, fetchFlourSandRows: noFlourSandRows, persistObservedFields });
  assert.equal(calls.length, 0);
});

// End-to-end guard for the dune2 regression: once resolveCoriolisCycle
// reports the logged seed as expired it hands back a null seed plus
// staleSince, and none of the previous cycle's pool may survive that.
test("an expired Coriolis seed serves no static pool and records nothing", async () => {
  const config = configWithArchive(SAMPLE_ARCHIVE);
  const persisted = [];
  const liveRows = async () => ({ rows: [{ field_id: "5007190163237080", size: "Large", map: "DeepDesert", partition_id: 59 }] });
  const result = await liveMapSpice(null, config, "DeepDesert", {
    resolveCycle: async () => ({ seed: null, nextCycleAt: null, staleSince: "2026-08-25T11:00:00.000Z" }),
    fetchLiveRows: liveRows,
    fetchFlourSandRows: noFlourSandRows,
    persistObservedFields: (file, seed, fields) => persisted.push({ seed, fields })
  });
  assert.equal(result.currentSeed, "");
  assert.equal(result.seedStaleSince, "2026-08-25T11:00:00.000Z");
  assert.equal(result.rows.filter((r) => r.type === "spice").length, 0);
  assert.equal(result.capabilities.spice, false);
  // Active fields still render -- they come from Postgres, not the seed.
  assert.equal(result.rows.filter((r) => r.type === "spice_active").length, 1);
  assert.deepEqual(persisted, []);
});

test("a live seed still reports no staleSince", async () => {
  const config = configWithArchive(SAMPLE_ARCHIVE);
  const result = await liveMapSpice(null, config, "DeepDesert", {
    resolveCycle: async () => ({ seed: "cor-2", nextCycleAt: "2999-01-01T05:00:00.000Z", staleSince: null }),
    fetchLiveRows: noLiveRows,
    fetchFlourSandRows: noFlourSandRows,
    persistObservedFields: noPersist
  });
  assert.equal(result.seedStaleSince, "");
  assert.equal(result.rows.filter((r) => r.type === "spice").length, 2);
});
