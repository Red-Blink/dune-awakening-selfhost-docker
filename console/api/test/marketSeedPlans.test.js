import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveMarketSeedPlanPath } from "../src/addonJobs.js";
import {
  BUNDLED_SEED_PLAN_ID,
  SEED_PLAN_CSV_COLUMNS,
  csvToPlanRows,
  decodeSeedPlanCsvUpload,
  exportMarketSeedPlanCsv,
  importMarketSeedPlanFromCsv,
  listMarketSeedPlans,
  marketSeedPlanSummary,
  parseCsv,
  renameMarketSeedPlan,
  setActiveMarketSeedPlan,
  stringifySeedPlanCsv
} from "../src/services/marketSeedPlans.js";

const SAMPLE_PLAN = {
  panel_version: "0.14.0-test",
  generated_at: "2026-08-01T00:00:00+00:00",
  price_multiplier: 5,
  market_bot_class: "Revy",
  unsafe_template_ids: ["NpcOnlyGun"],
  rows: [
    { template_id: "WaterBottle", display_name: "Water Bottle", kind: "resource", stack_size: 10, price: 1000, category_mask: 1, category_depth: 1, quality_level: 0, special_boost: false, listings: 4, durability_cur: 100, durability_max: 100 },
    { template_id: "Sword", display_name: "Sword", kind: "equippable", stack_size: 1, price: 2000, category_mask: 2, category_depth: 2, quality_level: 0, special_boost: false, listings: 2, durability_cur: 125, durability_max: 125 },
    { template_id: "Sword", display_name: "Sword", kind: "equippable", stack_size: 1, price: 2500, category_mask: 2, category_depth: 2, quality_level: 1, special_boost: false, listings: 2, durability_cur: 130, durability_max: 130 },
    { template_id: "T6_Augment_Example", display_name: "Example Augment", kind: "equippable", stack_size: 1, price: 800, category_mask: 3, category_depth: 2, quality_level: 1, special_boost: false, listings: 2, durability_cur: 100, durability_max: 100 },
    { template_id: "T6_Augment_Example_Schematic", display_name: "Example Augment", kind: "schematic", stack_size: 1, price: 1600, category_mask: 3, category_depth: 3, quality_level: 1, special_boost: false, listings: 2, durability_cur: 100, durability_max: 100 }
  ]
};

function makeRepo() {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-seed-plans-"));
  mkdirSync(join(repoRoot, "runtime/data"), { recursive: true });
  writeFileSync(join(repoRoot, "runtime/data/market-seed-plan.json"), JSON.stringify(SAMPLE_PLAN));
  return { repoRoot };
}

test("CSV round-trip preserves seed-plan columns and quoted names", () => {
  const csv = stringifySeedPlanCsv(SAMPLE_PLAN.rows);
  assert.match(csv, /^(\uFEFF)?template_id,display_name,/);
  const rows = csvToPlanRows(csv, SAMPLE_PLAN, SAMPLE_PLAN.unsafe_template_ids);
  assert.equal(rows.length, SAMPLE_PLAN.rows.length);
  assert.equal(rows[0].template_id, "WaterBottle");
  assert.equal(rows[0].price, 1000);
  assert.equal(rows[1].display_name, "Sword");
});

test("CSV without a quality_level expands every bundled grade for that template", () => {
  const rows = csvToPlanRows("template_id,price\nSword,4000\n", SAMPLE_PLAN, []);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.quality_level), [0, 1]);
  assert.equal(rows[0].price, 4000);
  assert.equal(rows[1].display_name, "Sword");
  assert.equal(rows[1].stack_size, 1);
});

test("CSV import rejects unsafe template ids and empty files", () => {
  assert.throws(() => csvToPlanRows("template_id,price\nNpcOnlyGun,10\n", SAMPLE_PLAN, SAMPLE_PLAN.unsafe_template_ids), /unsafe template/);
  assert.throws(() => parseCsv("\"unclosed"), /unclosed quoted field/);
});

test("importing a named CSV creates a custom plan, makes it active, and is what seed/buyback resolve", () => {
  const { repoRoot } = makeRepo();
  try {
    const config = { repoRoot };
    const csv = stringifySeedPlanCsv([SAMPLE_PLAN.rows[0]]);
    const imported = importMarketSeedPlanFromCsv(config, { csvText: csv, name: "Cheap Water", fileName: "water.csv" });
    assert.equal(imported.name, "Cheap Water");
    assert.equal(imported.rows, 1);
    assert.equal(imported.active, true);
    assert.equal(imported.id, "cheap-water");

    const listed = listMarketSeedPlans(config);
    assert.equal(listed.activePlanId, "cheap-water");
    assert.equal(listed.items.length, 2);
    assert.equal(listed.items.find((item) => item.id === "cheap-water")?.active, true);

    const summary = marketSeedPlanSummary(config);
    assert.equal(summary.available, true);
    assert.equal(summary.source, "custom");
    assert.equal(summary.rows, 1);
    assert.equal(summary.name, "Cheap Water");

    assert.match(resolveMarketSeedPlanPath(config), /runtime\/generated\/market-bot\/plans\/cheap-water\.json$/);
    const stored = JSON.parse(readFileSync(join(repoRoot, "runtime/generated/market-bot/plans/cheap-water.json"), "utf8"));
    assert.equal(stored.rows[0].template_id, "WaterBottle");
    assert.equal(stored.rows[0].stack_size, 10);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("setActiveMarketSeedPlan switches back to the bundled catalog", () => {
  const { repoRoot } = makeRepo();
  try {
    const config = { repoRoot };
    importMarketSeedPlanFromCsv(config, {
      csvText: stringifySeedPlanCsv([SAMPLE_PLAN.rows[0]]),
      name: "Cheap Water"
    });
    const listed = setActiveMarketSeedPlan(config, BUNDLED_SEED_PLAN_ID);
    assert.equal(listed.activePlanId, BUNDLED_SEED_PLAN_ID);
    assert.match(resolveMarketSeedPlanPath(config), /runtime\/data\/market-seed-plan\.json$/);
    assert.equal(marketSeedPlanSummary(config).source, "bundled");
    assert.equal(marketSeedPlanSummary(config).rows, SAMPLE_PLAN.rows.length);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("renameMarketSeedPlan updates the friendly name without changing the active id", () => {
  const { repoRoot } = makeRepo();
  try {
    const config = { repoRoot };
    const imported = importMarketSeedPlanFromCsv(config, {
      csvText: stringifySeedPlanCsv([SAMPLE_PLAN.rows[0]]),
      name: "Cheap Water"
    });
    const listed = renameMarketSeedPlan(config, imported.id, "Weekend Sale");
    const renamed = listed.items.find((item) => item.id === imported.id);
    assert.equal(renamed?.name, "Weekend Sale");
    assert.equal(listed.activePlanId, imported.id);
    assert.throws(() => renameMarketSeedPlan(config, BUNDLED_SEED_PLAN_ID, "Nope"), /cannot be changed/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("exporting CSV then re-importing onto the same named plan replaces its rows", () => {
  const { repoRoot } = makeRepo();
  try {
    const config = { repoRoot };
    importMarketSeedPlanFromCsv(config, {
      csvText: stringifySeedPlanCsv([SAMPLE_PLAN.rows[0]]),
      name: "My List"
    });
    const exported = exportMarketSeedPlanCsv(config, BUNDLED_SEED_PLAN_ID);
    assert.match(exported.filename, /market-seed-bundled\.csv$/);
    assert.ok(exported.csv.includes("WaterBottle"));

    const replaced = importMarketSeedPlanFromCsv(config, {
      csvText: stringifySeedPlanCsv([SAMPLE_PLAN.rows[1]]),
      name: "My List",
      planId: "my-list"
    });
    assert.equal(replaced.id, "my-list");
    assert.equal(replaced.rows, 1);
    const stored = JSON.parse(readFileSync(join(repoRoot, "runtime/generated/market-bot/plans/my-list.json"), "utf8"));
    assert.equal(stored.rows[0].template_id, "Sword");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("importing an augment schematic also pulls the matching bundled augment item", () => {
  const csv = "template_id,quality_level,kind\nT6_Augment_Example_Schematic,1,schematic\n";
  const rows = csvToPlanRows(csv, SAMPLE_PLAN, []);
  assert.ok(rows.some((row) => row.template_id === "T6_Augment_Example_Schematic"));
  assert.ok(rows.some((row) => row.template_id === "T6_Augment_Example" && row.quality_level === 1));
});

test("CSV import stores only seed-plan columns and fills names from the bundled plan", () => {
  const shipped = { rows: [{ ...SAMPLE_PLAN.rows[0], notes: "DROP TABLE items", extra: { sql: "1=1" } }] };
  const rows = csvToPlanRows("template_id,price\nWaterBottle,1500\n", shipped, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].display_name, "Water Bottle");
  assert.equal(rows[0].price, 1500);
  assert.deepEqual(Object.keys(rows[0]).sort(), [...SEED_PLAN_CSV_COLUMNS].sort());
  assert.equal("notes" in rows[0], false);
  assert.equal("extra" in rows[0], false);
});

test("CSV import rejects extra columns, SQL payloads, formulas, and non-numeric cells", () => {
  assert.throws(() => csvToPlanRows("template_id,price,notes\nWaterBottle,10,keep\n", SAMPLE_PLAN, []), /unsupported column/);
  assert.throws(
    () => csvToPlanRows("template_id,price\nWaterBottle'; DROP TABLE items;--,10\n", SAMPLE_PLAN, []),
    /invalid template_id/
  );
  assert.throws(() => csvToPlanRows("template_id,price\nDROP,10\n", SAMPLE_PLAN, []), /invalid template_id/);
  assert.throws(() => csvToPlanRows("template_id,price\nWaterBottle,10 OR 1=1\n", SAMPLE_PLAN, []), /invalid price/);
  assert.throws(() => csvToPlanRows("template_id,price\nWaterBottle,10; DROP\n", SAMPLE_PLAN, []), /invalid price/);
  assert.throws(() => csvToPlanRows("template_id,price\nWaterBottle,1e6\n", SAMPLE_PLAN, []), /invalid price/);
  assert.throws(() => csvToPlanRows("template_id,stack_size,price\nWaterBottle,10; DROP,1000\n", SAMPLE_PLAN, []), /invalid stack_size/);
  assert.throws(() => csvToPlanRows("template_id,kind,price\nWaterBottle,not-a-kind,1000\n", SAMPLE_PLAN, []), /invalid kind/);
  assert.throws(
    () => csvToPlanRows("template_id,display_name,price\nWaterBottle,=1+1,1000\n", SAMPLE_PLAN, []),
    /display_name/
  );
  assert.throws(
    () => csvToPlanRows("INSERT INTO items VALUES ('WaterBottle',10);\n", SAMPLE_PLAN, []),
    /SQL script/
  );
  assert.throws(() => csvToPlanRows("{\"rows\":[]}\n", SAMPLE_PLAN, []), /JSON or HTML/);
  assert.throws(() => csvToPlanRows("<html><body>template_id</body></html>\n", SAMPLE_PLAN, []), /JSON or HTML/);
  assert.throws(() => csvToPlanRows("template_id,price\nWaterBottle\u0000,10\n", SAMPLE_PLAN, []), /binary data/);
  assert.throws(
    () => decodeSeedPlanCsvUpload(Buffer.from("template_id,price\nWaterBottle,10\n"), "plan.sql"),
    /CSV files/
  );
  assert.throws(
    () => decodeSeedPlanCsvUpload(Buffer.from([0xff, 0xfe, 0x74, 0x00]), "plan.csv"),
    /UTF-8/
  );
  assert.throws(
    () => decodeSeedPlanCsvUpload(Buffer.from("template_id,price\nWaterBottle,\x00\n", "utf8"), "plan.csv"),
    /binary data/
  );
});

test("CSV import accepts apostrophes, durability tenths, and the bundled catalog round-trip", () => {
  const named = csvToPlanRows("template_id,display_name,price\nWaterBottle,Abulurd's Rapture,10\n", SAMPLE_PLAN, []);
  assert.equal(named[0].display_name, "Abulurd's Rapture");
  const durable = csvToPlanRows("template_id,durability_cur,durability_max,price\nWaterBottle,188.0,188.0,1000\n", SAMPLE_PLAN, []);
  assert.equal(durable[0].durability_cur, 188);
  assert.equal(durable[0].durability_max, 188);

  const bundledPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../runtime/data/market-seed-plan.json");
  const bundled = JSON.parse(readFileSync(bundledPath, "utf8"));
  const rows = csvToPlanRows(stringifySeedPlanCsv(bundled.rows), bundled, bundled.unsafe_template_ids || []);
  assert.equal(rows.length, bundled.rows.length);
  assert.deepEqual(Object.keys(rows[0]).sort(), [...SEED_PLAN_CSV_COLUMNS].sort());
});
