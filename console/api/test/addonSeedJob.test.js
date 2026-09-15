import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EDA_EXCHANGE_BOT_ADDON_ID, buildBotListingCountSql, buildMarketSeedSql, buildMarketUnseedSql, createListedMarketUnitPrice, loadMarketSeedPlan, normalizeSeedSchedule, seedRowCategoryMultiplier, seedRowListingCount, COMMODITY_STACK_CATALOG, COMMODITY_STACK_DEFAULT, COMMODITY_STACK_MAX } from "../src/addonSeedJob.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

const SEED_PLAN = {
  panel_version: "test",
  price_multiplier: 5,
  rows: [
    { template_id: "T6_Augment_Armor1", display_name: "Concussive Dampening", kind: "equippable", stack_size: 1, price: 28000000, category_mask: 2, category_depth: 2, quality_level: 3, listings: 2, durability_cur: 192, durability_max: 192 },
    { template_id: "T6_Augment_Mystery1", display_name: "Uncatalogued Augment", kind: "equippable", stack_size: 1, price: 19000000, category_mask: 2, category_depth: 2, quality_level: 1, listings: 2, durability_cur: 184, durability_max: 184 },
    { template_id: "T6_Augment_Armor1_Schematic", display_name: "Concussive Dampening", kind: "schematic", stack_size: 1, price: 2800000, category_mask: 3, category_depth: 2, quality_level: 3, listings: 2, durability_cur: 192, durability_max: 192 },
    { template_id: "Sword", display_name: "Sword", kind: "equippable", stack_size: 1, price: 2000, category_mask: 2, category_depth: 2, quality_level: 0, listings: 2, durability_cur: 110, durability_max: 110 }
  ]
};

const AUGMENT_CATALOG = {
  augments: {
    T6_Augment_Armor1: {
      name: "Concussive Dampening",
      gradeEffects: {
        1: ["Concussive Mitigation +1.75% - +2.25%", "Energy Mitigation -1%"],
        3: ["Concussive Mitigation +3.25% - +4%", "Energy Mitigation -1%"]
      }
    }
  }
};

function makeRepoRoot({ plan = SEED_PLAN, catalog = AUGMENT_CATALOG } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-seed-job-"));
  const webDir = join(repoRoot, "runtime/addons/installed", EDA_EXCHANGE_BOT_ADDON_ID, "web");
  mkdirSync(webDir, { recursive: true });
  writeFileSync(join(webDir, "market-seed-plan.json"), JSON.stringify(plan));
  if (catalog) {
    mkdirSync(join(repoRoot, "runtime/data"), { recursive: true });
    writeFileSync(join(repoRoot, "runtime/data/augment-compatibility.json"), JSON.stringify(catalog));
  }
  return repoRoot;
}

function statsByTemplate(plan) {
  return new Map(plan.rows.map((row) => [`${row.templateId}:${row.kind}`, JSON.parse(row.itemStats)]));
}

test("pins bot-sold augment items to bottom-20% stat rolls", () => {
  const repoRoot = makeRepoRoot();
  try {
    const plan = loadMarketSeedPlan({ repoRoot });
    const stats = statsByTemplate(plan);

    // Roll count follows the widest gradeEffects list in the catalog (2 lines).
    assert.deepEqual(stats.get("T6_Augment_Armor1:equippable").FAugmentItemStats, [[], { StatRolls: [0.2, 0.2], AppliedEffectIndices: [] }]);
    // Catalog miss still pins a single bottom-of-range roll.
    assert.deepEqual(stats.get("T6_Augment_Mystery1:equippable").FAugmentItemStats, [[], { StatRolls: [0.2], AppliedEffectIndices: [] }]);
    // Schematics and non-augment items carry durability stats only.
    assert.equal(stats.get("T6_Augment_Armor1_Schematic:schematic").FAugmentItemStats, undefined);
    assert.equal(stats.get("Sword:equippable").FAugmentItemStats, undefined);
    for (const parsed of stats.values()) {
      assert.ok(Array.isArray(parsed.FItemStackAndDurabilityStats));
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("pins a single bottom-20% roll when the augment catalog is missing", () => {
  const repoRoot = makeRepoRoot({ catalog: null });
  try {
    const plan = loadMarketSeedPlan({ repoRoot });
    const stats = statsByTemplate(plan);
    assert.deepEqual(stats.get("T6_Augment_Armor1:equippable").FAugmentItemStats, [[], { StatRolls: [0.2], AppliedEffectIndices: [] }]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("rejects augment schematic grades with no matching augmentation item", () => {
  const plan = {
    ...SEED_PLAN,
    rows: [
      ...SEED_PLAN.rows,
      { template_id: "T6_Augment_Armor1_Schematic", display_name: "Concussive Dampening", kind: "schematic", stack_size: 1, price: 1900000, category_mask: 3, category_depth: 2, quality_level: 1, listings: 2, durability_cur: 184, durability_max: 184 }
    ]
  };
  const repoRoot = makeRepoRoot({ plan });
  try {
    assert.throws(
      () => loadMarketSeedPlan({ repoRoot }),
      /unsupported augment schematic grade: T6_Augment_Armor1_Schematic quality 1/
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("unseed SQL clears only the bot's own orders and reports removal counts", () => {
  const sql = buildMarketUnseedSql("42");
  // Targets the bot's 'Revy' actor on the requested exchange only.
  assert.match(sql, /SELECT id INTO v_owner_id FROM dune\.actors WHERE class = 'Revy' LIMIT 1;/);
  assert.match(sql, /v_exchange_id := 42;/);
  assert.match(sql, /DELETE FROM dune\.dune_exchange_orders WHERE owner_id = v_owner_id AND exchange_id = v_exchange_id;/);
  // Counts what it removed for the run result.
  assert.match(sql, /GET DIAGNOSTICS v_removed = ROW_COUNT;/);
  assert.match(sql, /INSERT INTO market_unseed_result/);
  assert.match(sql, /SELECT removed_listings, removed_items, exchange_id FROM market_unseed_result;/);
  // Unseed never reseeds and never opens its own transaction (executeUnseedRun
  // wraps it in db.transaction, like the seed run).
  assert.doesNotMatch(sql, /INSERT INTO dune\.items/);
  assert.doesNotMatch(sql, /INSERT INTO dune\.dune_exchange_orders/);
  assert.doesNotMatch(sql, /^BEGIN;/m);
  assert.doesNotMatch(sql, /^COMMIT;/m);
});

test("unseed SQL builders reject malformed exchange ids", () => {
  for (const bad of ["", "0", "-1", "abc", "1; DROP TABLE dune.items", "9223372036854775808"]) {
    assert.throws(() => buildMarketUnseedSql(bad), /positive whole number/);
    assert.throws(() => buildBotListingCountSql(bad), /positive whole number/);
  }
  // BIGINT max is still accepted as a decimal string.
  assert.match(buildBotListingCountSql("9223372036854775807"), /o\.exchange_id = 9223372036854775807/);
});

test("seed SQL still clears the bot's listings before seeding after the clear was shared with unseed", () => {
  const repoRoot = makeRepoRoot();
  try {
    const plan = loadMarketSeedPlan({ repoRoot });
    const sql = buildMarketSeedSql(plan, { enabled: true, exchangeId: "7", priceMultiplier: 5 });
    assert.match(sql, /DELETE FROM dune\.dune_exchange_orders WHERE owner_id = v_owner_id AND exchange_id = v_exchange_id;/);
    // The seed path's clear does not report counts into the unseed result table.
    assert.doesNotMatch(sql, /market_unseed_result/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("seed SQL embeds the pinned augment roll payload", () => {
  const repoRoot = makeRepoRoot();
  try {
    const plan = loadMarketSeedPlan({ repoRoot });
    const sql = buildMarketSeedSql(plan, { enabled: true, exchangeId: "7", priceMultiplier: 5 });
    assert.match(sql, /"StatRolls":\[0\.2,0\.2\]/);
    assert.match(sql, /"FItemStackAndDurabilityStats"/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("discounted augment pricing (the default) undercuts patterns in the seed SQL", () => {
  const repoRoot = makeRepoRoot();
  try {
    const plan = loadMarketSeedPlan({ repoRoot });
    const sql = buildMarketSeedSql(plan, { enabled: true, exchangeId: "7", priceMultiplier: 5 });
    // Half the 2.8M schematic at the same grade.
    assert.match(sql, /'T6_Augment_Armor1',1,1400000,/);
    // No pattern listed: the 19M item price falls back to the same 20x scale.
    assert.match(sql, /'T6_Augment_Mystery1',1,950000,/);
    // Schematics and non-augment rows keep their plan prices.
    assert.match(sql, /'T6_Augment_Armor1_Schematic',1,2800000,/);
    assert.match(sql, /'Sword',1,2000,/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("original augment pricing keeps the plan's augment item prices", () => {
  const repoRoot = makeRepoRoot();
  try {
    const plan = loadMarketSeedPlan({ repoRoot });
    const sql = buildMarketSeedSql(plan, { enabled: true, exchangeId: "7", priceMultiplier: 5, augmentPricing: "original" });
    assert.match(sql, /'T6_Augment_Armor1',1,28000000,/);
    assert.match(sql, /'T6_Augment_Mystery1',1,19000000,/);
    assert.match(sql, /'T6_Augment_Armor1_Schematic',1,2800000,/);
    // The stat roll pin is not a pricing choice: it applies in both modes.
    assert.match(sql, /"StatRolls":\[0\.2,0\.2\]/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("plan-scoped market pricing reuses one schematic index across rows", () => {
  const repoRoot = makeRepoRoot();
  try {
    const plan = loadMarketSeedPlan({ repoRoot });
    const listedUnitPrice = createListedMarketUnitPrice(plan, {
      priceMultiplier: 5,
      augmentPricing: "discounted"
    });
    const byTemplate = new Map(plan.rows.map((row) => [row.templateId, row]));
    assert.equal(listedUnitPrice(byTemplate.get("T6_Augment_Armor1")), 1400000);
    assert.equal(listedUnitPrice(byTemplate.get("T6_Augment_Mystery1")), 950000);
    assert.equal(listedUnitPrice(byTemplate.get("T6_Augment_Armor1_Schematic")), 2800000);
    assert.equal(listedUnitPrice(byTemplate.get("Sword")), 2000);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

// Realistic category masks: the exchange stores its top-level category in the
// mask's high byte (0 = armor/garments, 1 = weapons, 4 = augments).
const CATEGORY_PLAN = {
  panel_version: "test",
  price_multiplier: 5,
  rows: [
    { template_id: "Combat_Heavy_Unique_Top_06", display_name: "Bulwark Chest", kind: "equippable", stack_size: 1, price: 8000000, category_mask: 65792, category_depth: 3, quality_level: 3, listings: 1, durability_cur: 192, durability_max: 192 },
    { template_id: "Combat_Heavy_Unique_Top_06", display_name: "Bulwark Chest", kind: "equippable", stack_size: 1, price: 5500000, category_mask: 65792, category_depth: 3, quality_level: 0, listings: 1, durability_cur: 180, durability_max: 180 },
    { template_id: "Combat_Heavy_Unique_Top_06_Schematic", display_name: "Bulwark Chest", kind: "schematic", stack_size: 1, price: 700000, category_mask: 327936, category_depth: 3, quality_level: 2, listings: 1, durability_cur: 100, durability_max: 100 },
    { template_id: "UniqueDualBlades_6", display_name: "Burning Blades", kind: "equippable", stack_size: 1, price: 9600000, category_mask: 16777216, category_depth: 3, quality_level: 4, listings: 1, durability_cur: 196, durability_max: 196 },
    { template_id: "T6_Augment_Armor1", display_name: "Concussive Dampening", kind: "equippable", stack_size: 1, price: 28000000, category_mask: 67239936, category_depth: 2, quality_level: 3, listings: 1, durability_cur: 192, durability_max: 192 },
    { template_id: "T6_Augment_Armor1_Schematic", display_name: "Concussive Dampening", kind: "schematic", stack_size: 1, price: 2800000, category_mask: 67371520, category_depth: 3, quality_level: 3, listings: 1, durability_cur: 100, durability_max: 100 },
    { template_id: "WaterBottle", display_name: "Water Bottle", kind: "resource", stack_size: 10, price: 1000, category_mask: 84017152, category_depth: 2, quality_level: 0, listings: 1 }
  ]
};

test("category multipliers scale seeded prices on top of the base multiplier", () => {
  const repoRoot = makeRepoRoot({ plan: CATEGORY_PLAN });
  try {
    const plan = loadMarketSeedPlan({ repoRoot });
    const sql = buildMarketSeedSql(plan, {
      enabled: true,
      exchangeId: "7",
      priceMultiplier: 5,
      augmentMultiplier: 2,
      rankedArmorMultiplier: 3,
      rankedWeaponMultiplier: 1.5
    });
    // Ranked armor grade 3: 8M base -> 3x = 24M.
    assert.match(sql, /'Combat_Heavy_Unique_Top_06',1,24000000,/);
    // Grade-0 stock of the same armor keeps the base multiplier alone.
    assert.match(sql, /'Combat_Heavy_Unique_Top_06',1,5500000,/);
    // Ranked armor schematics belong to the armor category too: 700k -> 2.1M.
    assert.match(sql, /'Combat_Heavy_Unique_Top_06_Schematic',1,2100000,/);
    // Ranked weapon grade 4 at a fractional 1.5x: 9.6M -> 14.4M.
    assert.match(sql, /'UniqueDualBlades_6',1,14400000,/);
    // Discounted augment item (half its 2.8M pattern = 1.4M) then 2x = 2.8M,
    // and the pattern itself doubles to 5.6M — the augment multiplier
    // preserves the "patterns cost twice the bottom-roll item" relationship.
    assert.match(sql, /'T6_Augment_Armor1',1,2800000,/);
    assert.match(sql, /'T6_Augment_Armor1_Schematic',1,5600000,/);
    // Rows outside the three categories are untouched.
    assert.match(sql, /'WaterBottle',10,1000,/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("seed rows resolve their category multiplier by augment template and exchange category", () => {
  const multipliers = { augmentMultiplier: 2, rankedArmorMultiplier: 3, rankedWeaponMultiplier: 4 };
  // Augments and augment schematics match by template, whatever the mask.
  assert.equal(seedRowCategoryMultiplier({ templateId: "T6_Augment_Melee4", qualityLevel: 2, categoryMask: 67239936 }, multipliers), 2);
  assert.equal(seedRowCategoryMultiplier({ templateId: "T6_Augment_Melee4_Schematic", qualityLevel: 1, categoryMask: 67371520 }, multipliers), 2);
  // Ranked armor: mask high byte 0 at grade >= 1, including stillsuits.
  assert.equal(seedRowCategoryMultiplier({ templateId: "Stillsuit_Unique_Armored_06_Mask", qualityLevel: 1, categoryMask: 131072 }, multipliers), 3);
  // Grade-0 stock keeps the base multiplier.
  assert.equal(seedRowCategoryMultiplier({ templateId: "Stillsuit_Unique_Armored_06_Mask", qualityLevel: 0, categoryMask: 131072 }, multipliers), 1);
  // Ranked weapons: mask high byte 1.
  assert.equal(seedRowCategoryMultiplier({ templateId: "UniqueDualBlades_6", qualityLevel: 5, categoryMask: 16777216 }, multipliers), 4);
  // Ranked rows in other top-level categories (for example vehicles) are untouched.
  assert.equal(seedRowCategoryMultiplier({ templateId: "Sandbike_Treads_Mk6", qualityLevel: 2, categoryMask: 33554432 }, multipliers), 1);
  // Schedules without the fields behave as a neutral 1x.
  assert.equal(seedRowCategoryMultiplier({ templateId: "UniqueDualBlades_6", qualityLevel: 5, categoryMask: 16777216 }, {}), 1);
});

test("seed schedule normalizes category multipliers within 1-5x", () => {
  const defaults = normalizeSeedSchedule({});
  assert.deepEqual([defaults.augmentMultiplier, defaults.rankedArmorMultiplier, defaults.rankedWeaponMultiplier], [1, 1, 1]);

  const set = normalizeSeedSchedule({ augmentMultiplier: 2.5, rankedArmorMultiplier: 5, rankedWeaponMultiplier: 1.339 });
  assert.deepEqual([set.augmentMultiplier, set.rankedArmorMultiplier, set.rankedWeaponMultiplier], [2.5, 5, 1.34]);

  // Saves that omit the fields (for example through the addon bridge) keep the stored values.
  const kept = normalizeSeedSchedule({ intervalMinutes: 20 }, set);
  assert.deepEqual([kept.augmentMultiplier, kept.rankedArmorMultiplier, kept.rankedWeaponMultiplier], [2.5, 5, 1.34]);

  assert.throws(() => normalizeSeedSchedule({ augmentMultiplier: 0.5 }), /Seed schedule augmentMultiplier must be a number from 1 to 5/);
  assert.throws(() => normalizeSeedSchedule({ rankedArmorMultiplier: 6 }), /rankedArmorMultiplier must be a number from 1 to 5/);
  assert.throws(() => normalizeSeedSchedule({ rankedWeaponMultiplier: "big" }), /rankedWeaponMultiplier must be a number from 1 to 5/);
});

test("loadMarketSeedPlan remaps Treadwheel vehicle masks before seeding", () => {
  const repoRoot = makeRepoRoot({
    plan: {
      panel_version: "test",
      price_multiplier: 5,
      rows: [
        { template_id: "TreadwheelChassis_4", display_name: "Treadwheel Chassis Mk4", kind: "equippable", stack_size: 1, price: 6500, category_mask: 0x02050000, category_depth: 3, quality_level: 0, listings: 2, durability_cur: 100, durability_max: 100 },
        { template_id: "TreadwheelEngine_Unique_Speed_4_Schematic", display_name: "Swift Treadwheel Engine Mk4", kind: "schematic", stack_size: 1, price: 4000, category_mask: 0x02060500, category_depth: 3, quality_level: 0, listings: 2, durability_cur: 100, durability_max: 100 },
        { template_id: "SandcrawlerChassis_6", display_name: "Sandcrawler Chassis Mk6", kind: "equippable", stack_size: 1, price: 8000, category_mask: 0x02050000, category_depth: 3, quality_level: 0, listings: 2, durability_cur: 100, durability_max: 100 }
      ]
    }
  });
  try {
    const plan = loadMarketSeedPlan({ repoRoot });
    const byId = Object.fromEntries(plan.rows.map((row) => [row.templateId, row]));
    assert.equal(byId.TreadwheelChassis_4.categoryMask, 0x02000000);
    assert.equal(byId.TreadwheelChassis_4.categoryDepth, 3);
    assert.equal(byId.TreadwheelEngine_Unique_Speed_4_Schematic.categoryMask, 0x02060000);
    assert.equal(byId.SandcrawlerChassis_6.categoryMask, 0x02050000);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("loadMarketSeedPlan remaps Icehunter depth-2 ranged masks before seeding", () => {
  const repoRoot = makeRepoRoot({
    plan: {
      panel_version: "test",
      price_multiplier: 5,
      rows: [
        { template_id: "ChoamSda2", display_name: "Maula Pistol", kind: "equippable", stack_size: 1, price: 6500, category_mask: 0x01020000, category_depth: 2, quality_level: 0, listings: 2, durability_cur: 100, durability_max: 100 },
        { template_id: "HarkAr2", display_name: "Karpov 38", kind: "equippable", stack_size: 1, price: 8000, category_mask: 0x01080000, category_depth: 2, quality_level: 0, listings: 2, durability_cur: 100, durability_max: 100 },
        { template_id: "Ammo", display_name: "Light Darts", kind: "ammunition", stack_size: 100, price: 50, category_mask: 0x010e0000, category_depth: 2, quality_level: 0, listings: 2, durability_cur: 100, durability_max: 100 },
        { template_id: "Schematic_UniqueMaulaPistol", display_name: "Way of the Fallen", kind: "schematic", stack_size: 1, price: 4000, category_mask: 0x01030200, category_depth: 3, quality_level: 0, listings: 2, durability_cur: 100, durability_max: 100 }
      ]
    }
  });
  try {
    const plan = loadMarketSeedPlan({ repoRoot });
    const byId = Object.fromEntries(plan.rows.map((row) => [row.templateId, row]));
    assert.equal(byId.ChoamSda2.categoryMask, 0x01010200);
    assert.equal(byId.ChoamSda2.categoryDepth, 3);
    assert.equal(byId.HarkAr2.categoryMask, 0x01010800);
    assert.equal(byId.Ammo.categoryMask, 0x01020000);
    assert.equal(byId.Ammo.categoryDepth, 2);
    assert.equal(byId.Schematic_UniqueMaulaPistol.categoryMask, 0x01030200);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("bundled plan: the three categories cover exactly the ranked rows", () => {
  const plan = JSON.parse(readFileSync(resolve(REPO_ROOT, "runtime/data/market-seed-plan.json"), "utf8"));
  // Distinct primes make the resolved category unambiguous.
  const multipliers = { augmentMultiplier: 2, rankedArmorMultiplier: 3, rankedWeaponMultiplier: 5 };
  const counts = { 1: 0, 2: 0, 3: 0, 5: 0 };
  for (const row of plan.rows) {
    const resolved = seedRowCategoryMultiplier(
      { templateId: row.template_id, qualityLevel: row.quality_level, categoryMask: row.category_mask },
      multipliers
    );
    counts[resolved] += 1;
    if (row.quality_level >= 1) {
      assert.notEqual(resolved, 1, `${row.template_id} grade ${row.quality_level} must belong to a category`);
    } else if (!/^T\d+_Augment_/i.test(row.template_id)) {
      assert.equal(resolved, 1, `${row.template_id} grade 0 must keep the base multiplier`);
    }
  }
  assert.equal(counts[2], 775, "augment items and supported augment schematics");
  assert.equal(counts[3], 435, "ranked armor including stillsuits and radiation suits");
  assert.equal(counts[5], 400, "ranked weapons");
  assert.equal(counts[1], plan.rows.length - 775 - 435 - 400, "everything else keeps the base multiplier");
});

test("bundled plan lists augment schematics only at supported item grades", () => {
  const plan = JSON.parse(readFileSync(resolve(REPO_ROOT, "runtime/data/market-seed-plan.json"), "utf8"));
  const itemGrades = new Set(plan.rows
    .filter((row) => row.kind === "equippable" && /^T\d+_Augment_/i.test(row.template_id))
    .map((row) => `${row.template_id}\0${row.quality_level}`));
  const patterns = plan.rows.filter((row) => row.kind === "schematic" && /^T\d+_Augment_/i.test(row.template_id));

  for (const row of patterns) {
    const itemTemplateId = row.template_id.replace(/_Schematic$/, "");
    assert.ok(
      itemGrades.has(`${itemTemplateId}\0${row.quality_level}`),
      `${row.template_id} quality ${row.quality_level} must have a matching augmentation item`
    );
  }

  const shieldBreakerGrades = patterns
    .filter((row) => row.template_id === "T6_Augment_smg3_Schematic")
    .map((row) => row.quality_level);
  assert.deepEqual(shieldBreakerGrades, [2, 3, 4, 5]);
});

test("seed schedule normalizes the augment pricing choice", () => {
  assert.equal(normalizeSeedSchedule({}).augmentPricing, "discounted");
  assert.equal(normalizeSeedSchedule({ augmentPricing: "original" }).augmentPricing, "original");
  assert.equal(normalizeSeedSchedule({ augmentPricing: "junk" }).augmentPricing, "discounted");
  // Saves that omit the field (for example through the addon bridge) keep the stored choice.
  assert.equal(normalizeSeedSchedule({}, { augmentPricing: "original" }).augmentPricing, "original");
  assert.equal(normalizeSeedSchedule({ intervalMinutes: 20 }, { augmentPricing: "original" }).augmentPricing, "original");
});

test("seed schedule normalizes commodity stack overrides", () => {
  assert.deepEqual(normalizeSeedSchedule({}).commodityStacks, {});
  const set = normalizeSeedSchedule({ commodityStacks: { Oil: 10, SpicedFuelCell: 8 } });
  assert.deepEqual(set.commodityStacks, { Oil: 10, SpicedFuelCell: 8 });
  const kept = normalizeSeedSchedule({ intervalMinutes: 20 }, set);
  assert.deepEqual(kept.commodityStacks, { Oil: 10, SpicedFuelCell: 8 });
  const replaced = normalizeSeedSchedule({ commodityStacks: { Oil: 3 } }, set);
  assert.deepEqual(replaced.commodityStacks, { Oil: 3 });
  const dropped = normalizeSeedSchedule({ commodityStacks: { Oil: 10, NotARealItem: 9, Sword: 4 } });
  assert.deepEqual(dropped.commodityStacks, { Oil: 10 });
  assert.throws(() => normalizeSeedSchedule({ commodityStacks: { Oil: 0 } }), /commodityStacks.Oil must be an integer from 1 to 20/);
  assert.throws(() => normalizeSeedSchedule({ commodityStacks: { Oil: COMMODITY_STACK_MAX + 1 } }), /commodityStacks.Oil/);
  assert.throws(() => normalizeSeedSchedule({ commodityStacks: [] }), /commodityStacks must be an object/);
});

test("seed SQL lists overridden commodity stacks without changing other rows", () => {
  const plan = {
    panel_version: "test",
    price_multiplier: 5,
    rows: [
      { template_id: "Oil", display_name: "Fuel Cell", kind: "resource", stack_size: 500, price: 250, category_mask: 1, category_depth: 1, quality_level: 0, listings: 2 },
      { template_id: "WaterBottle", display_name: "Water Bottle", kind: "resource", stack_size: 10, price: 1000, category_mask: 1, category_depth: 1, quality_level: 0, listings: 2 }
    ]
  };
  const repoRoot = makeRepoRoot({ plan });
  try {
    const loaded = loadMarketSeedPlan({ repoRoot });
    assert.equal(seedRowListingCount(loaded.rows[0], {}), 2);
    assert.equal(seedRowListingCount(loaded.rows[0], { commodityStacks: { Oil: 10 } }), 10);
    assert.equal(seedRowListingCount(loaded.rows[1], { commodityStacks: { Oil: 10 } }), 2);
    const sql = buildMarketSeedSql(loaded, { enabled: true, exchangeId: "7", priceMultiplier: 5, commodityStacks: { Oil: 10 } });
    assert.match(sql, /'Oil',500,250,1,1,0,'resource',10,/);
    assert.match(sql, /'WaterBottle',10,1000,1,1,0,'resource',2,/);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("commodity stack catalog matches the bundled plan", () => {
  const plan = JSON.parse(readFileSync(resolve(REPO_ROOT, "runtime/data/market-seed-plan.json"), "utf8"));
  const byTemplate = new Map(plan.rows.map((row) => [row.template_id, row]));
  const seen = new Set();
  for (const item of COMMODITY_STACK_CATALOG) {
    assert.equal(seen.has(item.templateId), false, `duplicate catalog entry ${item.templateId}`);
    seen.add(item.templateId);
    const row = byTemplate.get(item.templateId);
    assert.ok(row, `${item.templateId} (${item.label}) must exist in the bundled seed plan`);
    assert.equal(row.stack_size, item.stackSize, `${item.templateId} stack_size`);
    assert.equal(row.listings, COMMODITY_STACK_DEFAULT, `${item.templateId} default listings`);
    assert.notEqual(row.kind, "equippable", `${item.templateId} should be a stacking commodity, not gear`);
    assert.notEqual(row.kind, "schematic", `${item.templateId} should be a stacking commodity, not a schematic`);
  }
});

test("bundled plan carries the original augment ladder with patterns to discount against", () => {
  const plan = JSON.parse(readFileSync(resolve(REPO_ROOT, "runtime/data/market-seed-plan.json"), "utf8"));
  const originalLadder = { 1: 19000000, 2: 23500000, 3: 28000000, 4: 33000000, 5: 37500000 };
  const schematics = new Set(
    plan.rows
      .filter((row) => row.kind === "schematic" && row.template_id.startsWith("T6_Augment"))
      .map((row) => `${row.template_id}:${row.quality_level}`)
  );
  let items = 0;
  const itemOnly = [];
  for (const row of plan.rows) {
    if (row.kind !== "equippable" || !row.template_id.startsWith("T6_Augment")) continue;
    assert.equal(row.price, originalLadder[row.quality_level], `${row.template_id} grade ${row.quality_level} should sit on the original ladder`);
    items += 1;
    if (!schematics.has(`${row.template_id}_Schematic:${row.quality_level}`)) itemOnly.push(row.template_id);
  }
  assert.ok(items >= 300, `expected hundreds of augment item rows, got ${items}`);
  // Everything except the known item-only augment discounts against its own pattern.
  assert.deepEqual([...new Set(itemOnly)], ["T6_Augment_Damage2"]);
});

test("bundled plan lists the Tactical Radiation Suit at stock and grades 1-5", () => {
  const plan = JSON.parse(readFileSync(resolve(REPO_ROOT, "runtime/data/market-seed-plan.json"), "utf8"));
  const rows = plan.rows
    .filter((row) => row.template_id === "Radiation_Suit_T6_Unique_Armored" && row.kind === "equippable")
    .sort((a, b) => a.quality_level - b.quality_level);
  assert.deepEqual(rows.map((row) => row.quality_level), [0, 1, 2, 3, 4, 5]);
  // T6 grade conventions: durability climbs 180 -> 200 in steps of 4, grade 1
  // shares the stock price, and higher grades ramp toward ~2x.
  assert.deepEqual(rows.map((row) => row.durability_cur), [180, 184, 188, 192, 196, 200]);
  assert.deepEqual(rows.map((row) => row.price), [5500000, 5500000, 6900000, 8300000, 9600000, 11000000]);
});

test("bundled plan lists two full stacks of iodine pills", () => {
  const plan = JSON.parse(readFileSync(resolve(REPO_ROOT, "runtime/data/market-seed-plan.json"), "utf8"));
  const rows = plan.rows.filter((row) => row.template_id === "AntiRadiationPill");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "consumable");
  assert.equal(rows[0].listings, 2);
  assert.equal(rows[0].stack_size, 20);
  assert.equal(rows[0].price, 800);
});
