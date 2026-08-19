import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readMarketItemOverrides,
  saveMarketItemOverrides,
  readUnsafeTemplateIds,
  readBaseMarketTemplateIds,
  mergeMarketSeedPlanWithOverrides,
  mergeBuybackSeedPlanWithOverrides,
  listBotItemCatalogPickerItems
} from "../src/services/marketItemOverrides.js";

function withRepo(run) {
  const repo = mkdtempSync(join(tmpdir(), "market-item-overrides-"));
  try {
    return run(repo);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function seedAdminItems(repo, items) {
  mkdirSync(join(repo, "runtime/data"), { recursive: true });
  writeFileSync(join(repo, "runtime/data/admin-items.json"), JSON.stringify(items));
}

function seedPlanFile(repo, { unsafeTemplateIds = [] } = {}) {
  mkdirSync(join(repo, "runtime/data"), { recursive: true });
  writeFileSync(join(repo, "runtime/data/market-seed-plan.json"), JSON.stringify({
    price_multiplier: 1,
    rows: [{ template_id: "Existing1", price: 10, quality_level: 0 }],
    unsafe_template_ids: unsafeTemplateIds
  }));
}

test("readMarketItemOverrides returns empty defaults when no file exists", () => {
  withRepo((repo) => {
    assert.deepEqual(readMarketItemOverrides(repo), { overrides: {}, newItems: {} });
  });
});

test("readUnsafeTemplateIds returns [] when no plan file exists, and the plan's list when present", () => {
  withRepo((repo) => {
    assert.deepEqual(readUnsafeTemplateIds(repo), []);
    seedPlanFile(repo, { unsafeTemplateIds: ["BadItem1"] });
    assert.deepEqual(readUnsafeTemplateIds(repo), ["BadItem1"]);
  });
});

test("readBaseMarketTemplateIds reads both bundled and normalized row keys", () => {
  withRepo((repo) => {
    seedPlanFile(repo);
    assert.deepEqual(readBaseMarketTemplateIds(repo), ["Existing1"]);
  });
});

test("saveMarketItemOverrides validates and persists an override keyed by quality level, round-tripping through readMarketItemOverrides", () => {
  withRepo((repo) => {
    seedPlanFile(repo);
    const saved = saveMarketItemOverrides(repo, { overrides: { Existing1: { 0: { price: 500, listings: 3, enabled: true } } } });
    assert.deepEqual(saved.overrides.Existing1["0"], { price: 500, listings: 3, enabled: true });
    assert.deepEqual(readMarketItemOverrides(repo).overrides.Existing1["0"], { price: 500, listings: 3, enabled: true });
    const raw = JSON.parse(readFileSync(join(repo, "runtime/generated/market-bot/items.json"), "utf8"));
    assert.equal(raw.overrides.Existing1["0"].price, 500);
  });
});

test("saveMarketItemOverrides keeps separate grades of the same template independent", () => {
  withRepo((repo) => {
    seedPlanFile(repo);
    saveMarketItemOverrides(repo, { overrides: { Existing1: { 0: { price: 500 } } } });
    const saved = saveMarketItemOverrides(repo, { overrides: { Existing1: { 3: { price: 900 } } } });
    assert.equal(saved.overrides.Existing1["0"].price, 500);
    assert.equal(saved.overrides.Existing1["3"].price, 900);
  });
});

test("saveMarketItemOverrides rejects an out-of-range price and listings count, and an invalid quality level key", () => {
  withRepo((repo) => {
    seedPlanFile(repo);
    assert.throws(() => saveMarketItemOverrides(repo, { overrides: { Existing1: { 0: { price: -5 } } } }), /price/);
    assert.throws(() => saveMarketItemOverrides(repo, { overrides: { Existing1: { 0: { listings: 0 } } } }), /listings/);
    assert.throws(() => saveMarketItemOverrides(repo, { overrides: { Existing1: { 0: { listings: 100 } } } }), /listings/);
    assert.throws(() => saveMarketItemOverrides(repo, { overrides: { Existing1: { 9: { price: 10 } } } }), /quality level/);
  });
});

test("saveMarketItemOverrides hard-blocks unsafe template ids from being edited or added", () => {
  withRepo((repo) => {
    seedPlanFile(repo, { unsafeTemplateIds: ["Existing1"] });
    assert.throws(() => saveMarketItemOverrides(repo, { overrides: { Existing1: { 0: { enabled: false } } } }), /unsafe/);
    seedAdminItems(repo, [{ id: "Unsafe2", name: "Unsafe Two", category: "weapons", source: "Weapons" }]);
    const plan = JSON.parse(readFileSync(join(repo, "runtime/data/market-seed-plan.json"), "utf8"));
    plan.unsafe_template_ids.push("Unsafe2");
    writeFileSync(join(repo, "runtime/data/market-seed-plan.json"), JSON.stringify(plan));
    assert.throws(() => saveMarketItemOverrides(repo, { newItems: { Unsafe2: { price: 10, listings: 1 } } }), /unsafe/);
  });
});

test("saveMarketItemOverrides only accepts new items that resolve in admin-items.json, and blocks excluded categories", () => {
  withRepo((repo) => {
    seedPlanFile(repo);
    seedAdminItems(repo, [
      { id: "GoodWeapon", name: "Good Weapon", category: "weapons", source: "Weapons" },
      { id: "SomeBuilding", name: "Some Building", category: "buildings", source: "BuildingSets" }
    ]);
    assert.throws(() => saveMarketItemOverrides(repo, { newItems: { NotInCatalog: { price: 10, listings: 1 } } }), /not found/);
    assert.throws(() => saveMarketItemOverrides(repo, { newItems: { SomeBuilding: { price: 10, listings: 1 } } }), /excluded category/);
    const saved = saveMarketItemOverrides(repo, { newItems: { GoodWeapon: { price: 250, listings: 2, qualityLevel: 3 } } });
    assert.equal(saved.newItems.GoodWeapon.name, "Good Weapon");
    assert.equal(saved.newItems.GoodWeapon.category, "weapons");
    assert.equal(saved.newItems.GoodWeapon.price, 250);
    assert.equal(saved.newItems.GoodWeapon.qualityLevel, 3);
  });
});

test("saveMarketItemOverrides rejects a base-plan item even when it has no existing override", () => {
  withRepo((repo) => {
    seedPlanFile(repo);
    seedAdminItems(repo, [{ id: "Existing1", name: "Existing One", category: "weapons", source: "Weapons" }]);
    assert.throws(
      () => saveMarketItemOverrides(repo, { newItems: { Existing1: { price: 250, listings: 2 } } }),
      /already in the base catalog/);
  });
});

test("saveMarketItemOverrides removes a single grade's override when its patch normalizes empty, and supports removedNewItems", () => {
  withRepo((repo) => {
    seedPlanFile(repo);
    seedAdminItems(repo, [{ id: "GoodWeapon", name: "Good Weapon", category: "weapons", source: "Weapons" }]);
    saveMarketItemOverrides(repo, { overrides: { Existing1: { 0: { price: 500 }, 3: { price: 900 } } } });
    const cleared = saveMarketItemOverrides(repo, { overrides: { Existing1: { 0: {} } } });
    assert.equal(cleared.overrides.Existing1["0"], undefined);
    assert.equal(cleared.overrides.Existing1["3"].price, 900);

    saveMarketItemOverrides(repo, { newItems: { GoodWeapon: { price: 100, listings: 1 } } });
    const afterRemoval = saveMarketItemOverrides(repo, { removedNewItems: ["GoodWeapon"] });
    assert.equal(afterRemoval.newItems.GoodWeapon, undefined);
  });
});

test("mergeMarketSeedPlanWithOverrides applies overrides per grade, not per template, drops disabled and unsafe rows, and appends new items", () => {
  const plan = {
    sourceMultiplier: 1,
    rows: [
      { templateId: "A", price: 10, listings: 1, stackSize: 1, categoryMask: 0, categoryDepth: 0, qualityLevel: 0, kind: "equippable" },
      { templateId: "A", price: 20, listings: 1, stackSize: 1, categoryMask: 0, categoryDepth: 0, qualityLevel: 3, kind: "equippable" },
      { templateId: "B", price: 20, listings: 2, stackSize: 1, categoryMask: 0, categoryDepth: 0, qualityLevel: 0, kind: "equippable" },
      { templateId: "Unsafe", price: 30, listings: 1, stackSize: 1, categoryMask: 0, categoryDepth: 0, qualityLevel: 0, kind: "equippable" }
    ]
  };
  const overrides = {
    overrides: { A: { 0: { price: 999 } }, B: { 0: { enabled: false } } },
    newItems: { NewOne: { price: 55, listings: 4, stackSize: 1, categoryMask: 0, categoryDepth: 0, qualityLevel: 1, kind: "equippable", enabled: true, durabilityCur: 100, durabilityMax: 100 } }
  };
  const merged = mergeMarketSeedPlanWithOverrides(plan, overrides, ["Unsafe"]);
  const aRows = merged.rows.filter((row) => row.templateId === "A");
  assert.equal(aRows.find((row) => row.qualityLevel === 0).price, 999);
  assert.equal(aRows.find((row) => row.qualityLevel === 3).price, 20, "grade 3 must be untouched by the grade-0 override");
  assert.deepEqual(merged.rows.map((row) => row.templateId).sort(), ["A", "A", "NewOne"]);
  assert.equal(merged.rows.find((row) => row.templateId === "NewOne").listings, 4);
});

test("mergeBuybackSeedPlanWithOverrides applies price overrides per grade and appends new items without a listings field", () => {
  const plan = {
    sourceMultiplier: 1,
    rows: [
      { templateId: "A", displayName: "A", price: 10, qualityLevel: 0, categoryMask: 0, kind: "equippable" },
      { templateId: "A", displayName: "A", price: 20, qualityLevel: 2, categoryMask: 0, kind: "equippable" }
    ]
  };
  const overrides = {
    overrides: { A: { 0: { price: 777 } } },
    newItems: { NewOne: { name: "New One", price: 88, qualityLevel: 0, categoryMask: 0, kind: "equippable", enabled: true } }
  };
  const merged = mergeBuybackSeedPlanWithOverrides(plan, overrides, []);
  assert.equal(merged.rows.find((row) => row.templateId === "A" && row.qualityLevel === 0).price, 777);
  assert.equal(merged.rows.find((row) => row.templateId === "A" && row.qualityLevel === 2).price, 20);
  assert.equal(merged.rows.find((row) => row.templateId === "NewOne").price, 88);
});

test("listBotItemCatalogPickerItems excludes base-plan, buildings/contracts/emotes, and unsafe ids", () => {
  withRepo((repo) => {
    seedPlanFile(repo, { unsafeTemplateIds: ["UnsafeWeapon"] });
    seedAdminItems(repo, [
      { id: "GoodWeapon", name: "Good Weapon", category: "weapons", source: "Weapons" },
      { id: "Existing1", name: "Existing Weapon", category: "weapons", source: "Weapons" },
      { id: "UnsafeWeapon", name: "Unsafe Weapon", category: "weapons", source: "Weapons" },
      { id: "SomeBuilding", name: "Some Building", category: "buildings", source: "BuildingSets" },
      { id: "SomeContract", name: "Some Contract", category: "contracts", source: "Contracts" },
      { id: "SomeEmote", name: "Some Emote", category: "emotes", source: "Emotes" }
    ]);
    const rows = listBotItemCatalogPickerItems(repo, {});
    const ids = rows.map((row) => row.itemId).sort();
    assert.deepEqual(ids, ["GoodWeapon"]);
  });
});
