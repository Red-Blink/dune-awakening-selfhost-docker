import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLearnedPool, fieldsForLearnedSeed, recordObservedFields } from "../src/services/learnedSpiceLocations.js";

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), "dune-learned-spice-test-"));
  return join(dir, "learned-spice-locations.json");
}

test("readLearnedPool returns an empty pool for a missing file", () => {
  assert.deepEqual(readLearnedPool(join(tmpdir(), "does-not-exist-learned-spice.json")), { seeds: {} });
});

test("readLearnedPool returns an empty pool for a malformed file", () => {
  const file = tmpFile();
  writeFileSync(file, "not json");
  assert.deepEqual(readLearnedPool(file), { seeds: {} });
});

test("recordObservedFields appends new fields and readLearnedPool sees them", () => {
  const file = tmpFile();
  recordObservedFields(file, "cor-2", [
    { field_id: "1", map: "DeepDesert", size: "Medium", x: 100, y: -200, confidence: "decoded" }
  ]);
  assert.equal(existsSync(file), true);
  const pool = readLearnedPool(file);
  const fields = fieldsForLearnedSeed(pool, "cor-2");
  assert.equal(fields.length, 1);
  assert.equal(fields[0].field_id, "1");
  assert.equal(fields[0].map, "DeepDesert");
  assert.equal(fields[0].size, "Medium");
  assert.equal(fields[0].x, 100);
  assert.equal(fields[0].y, -200);
  assert.equal(fields[0].confidence, "decoded");
  assert.equal(typeof fields[0].first_seen_utc, "string");
});

test("recordObservedFields is a no-op when nothing new is observed", () => {
  const file = tmpFile();
  recordObservedFields(file, "cor-2", [{ field_id: "1", map: "DeepDesert", size: "Small", x: 1, y: 2, confidence: "decoded" }]);
  const before = readFileSync(file, "utf8");
  recordObservedFields(file, "cor-2", [{ field_id: "1", map: "DeepDesert", size: "Small", x: 1, y: 2, confidence: "decoded" }]);
  const after = readFileSync(file, "utf8");
  assert.equal(before, after);
  assert.equal(fieldsForLearnedSeed(readLearnedPool(file), "cor-2").length, 1);
});

test("recordObservedFields keeps different seeds independent", () => {
  const file = tmpFile();
  recordObservedFields(file, "cor-2", [{ field_id: "1", map: "DeepDesert", size: "Small", x: 1, y: 2, confidence: "decoded" }]);
  recordObservedFields(file, "cor-5", [{ field_id: "2", map: "HaggaBasin", size: "Small", x: 3, y: 4, confidence: "decoded" }]);
  const pool = readLearnedPool(file);
  assert.equal(fieldsForLearnedSeed(pool, "cor-2").length, 1);
  assert.equal(fieldsForLearnedSeed(pool, "cor-5").length, 1);
  assert.equal(fieldsForLearnedSeed(pool, "cor-2")[0].field_id, "1");
  assert.equal(fieldsForLearnedSeed(pool, "cor-5")[0].field_id, "2");
});

test("recordObservedFields only appends genuinely-new field_ids for a seed", () => {
  const file = tmpFile();
  recordObservedFields(file, "cor-2", [{ field_id: "1", map: "DeepDesert", size: "Small", x: 1, y: 2, confidence: "decoded" }]);
  recordObservedFields(file, "cor-2", [
    { field_id: "1", map: "DeepDesert", size: "Small", x: 1, y: 2, confidence: "decoded" },
    { field_id: "2", map: "DeepDesert", size: "Medium", x: 5, y: 6, confidence: "decoded" }
  ]);
  const fields = fieldsForLearnedSeed(readLearnedPool(file), "cor-2");
  assert.equal(fields.length, 2);
  assert.deepEqual(fields.map((field) => field.field_id).sort(), ["1", "2"]);
});
