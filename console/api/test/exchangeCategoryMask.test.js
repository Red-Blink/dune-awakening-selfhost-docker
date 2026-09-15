import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GUESSED_AMMUNITION_CODE,
  RANGED_TYPE_PISTOL,
  VEHICLES_ONE_MAN,
  VEHICLES_ONE_MAN_FOLDER_MASK,
  VEHICLES_SANDCRAWLER_FOLDER_MASK,
  VEHICLES_UNIQUE_SCHEMATICS,
  VEHICLES_UNIQUE_SCHEMATICS_MASK,
  WEAPONS_AMMUNITION_MASK,
  WEAPONS_RANGED,
  WEAPONS_RANGED_FOLDER_MASK,
  WEAPONS_TOP_LEVEL,
  WEAPONS_UNIQUE_SCHEMATICS_MASK,
  applyExchangeCategoryToSeedRow,
  decodeExchangeCategoryMask,
  exchangeMaskMatches,
  isTreadwheelTemplate,
  normalizeExchangeCategory,
  packExchangeCategoryMask
} from "../src/services/exchangeCategoryMask.js";

const BUNDLED_PLAN = resolve(import.meta.dirname, "../../../runtime/data/market-seed-plan.json");

test("Maula pistol guessed mask is the ammunition folder, not Ranged Weapons", () => {
  const guessedMaula = packExchangeCategoryMask(WEAPONS_TOP_LEVEL, RANGED_TYPE_PISTOL);
  assert.equal(guessedMaula, 0x01020000);
  assert.equal(exchangeMaskMatches(guessedMaula, 2, WEAPONS_AMMUNITION_MASK, 2), true);
  assert.equal(exchangeMaskMatches(guessedMaula, 2, WEAPONS_RANGED_FOLDER_MASK, 2), false);
});

test("nests Icehunter depth-2 ranged types under Ranged Weapons", () => {
  const maula = normalizeExchangeCategory({ categoryMask: 0x01020000, categoryDepth: 2, kind: "equippable" });
  assert.deepEqual(maula, { categoryMask: 0x01010200, categoryDepth: 3 });
  assert.equal(exchangeMaskMatches(maula.categoryMask, maula.categoryDepth, WEAPONS_RANGED_FOLDER_MASK, 2), true);
  assert.equal(exchangeMaskMatches(maula.categoryMask, maula.categoryDepth, WEAPONS_AMMUNITION_MASK, 2), false);

  const karpov = normalizeExchangeCategory({ categoryMask: 0x01080000, categoryDepth: 2, kind: "equippable" });
  assert.deepEqual(karpov, { categoryMask: 0x01010800, categoryDepth: 3 });
  assert.equal(exchangeMaskMatches(karpov.categoryMask, karpov.categoryDepth, WEAPONS_RANGED_FOLDER_MASK, 2), true);

  const heavyPistol = normalizeExchangeCategory({ categoryMask: 0x01030000, categoryDepth: 2, kind: "equippable" });
  assert.deepEqual(heavyPistol, { categoryMask: 0x01010300, categoryDepth: 3 });
  assert.equal(exchangeMaskMatches(heavyPistol.categoryMask, heavyPistol.categoryDepth, WEAPONS_UNIQUE_SCHEMATICS_MASK, 2), false);
});

test("moves guessed ammunition (code 14) into the ammunition folder", () => {
  const ammo = normalizeExchangeCategory({
    categoryMask: packExchangeCategoryMask(WEAPONS_TOP_LEVEL, GUESSED_AMMUNITION_CODE),
    categoryDepth: 2,
    kind: "ammunition"
  });
  assert.deepEqual(ammo, { categoryMask: WEAPONS_AMMUNITION_MASK, categoryDepth: 2 });
  assert.equal(exchangeMaskMatches(ammo.categoryMask, ammo.categoryDepth, WEAPONS_RANGED_FOLDER_MASK, 2), false);
});

test("does not treat already-correct ammunition as a Maula pistol", () => {
  const ammo = normalizeExchangeCategory({
    categoryMask: WEAPONS_AMMUNITION_MASK,
    categoryDepth: 2,
    kind: "ammunition"
  });
  assert.deepEqual(ammo, { categoryMask: WEAPONS_AMMUNITION_MASK, categoryDepth: 2 });
});

test("leaves melee, unique schematics, and already-nested ranged rows alone", () => {
  assert.deepEqual(
    normalizeExchangeCategory({ categoryMask: 0x01000100, categoryDepth: 3, kind: "equippable" }),
    { categoryMask: 0x01000100, categoryDepth: 3 }
  );
  assert.deepEqual(
    normalizeExchangeCategory({ categoryMask: 0x01030200, categoryDepth: 3, kind: "schematic" }),
    { categoryMask: 0x01030200, categoryDepth: 3 }
  );
  assert.deepEqual(
    normalizeExchangeCategory({ categoryMask: 0x01010200, categoryDepth: 3, kind: "equippable" }),
    { categoryMask: 0x01010200, categoryDepth: 3 }
  );
  assert.deepEqual(
    normalizeExchangeCategory({ categoryMask: 67239936, categoryDepth: 2, kind: "equippable" }),
    { categoryMask: 67239936, categoryDepth: 2 }
  );
});

test("does not nest depth-2 schematic or other non-equippable rows under Ranged Weapons", () => {
  const uniqueFolder = { categoryMask: WEAPONS_UNIQUE_SCHEMATICS_MASK, categoryDepth: 2 };
  const schematic = normalizeExchangeCategory({ ...uniqueFolder, kind: "schematic" });
  assert.deepEqual(schematic, uniqueFolder);
  assert.equal(
    exchangeMaskMatches(schematic.categoryMask, schematic.categoryDepth, WEAPONS_UNIQUE_SCHEMATICS_MASK, 2),
    true
  );
  assert.equal(
    exchangeMaskMatches(schematic.categoryMask, schematic.categoryDepth, WEAPONS_RANGED_FOLDER_MASK, 2),
    false
  );

  for (const kind of ["schematic", "resource", "utility", "consumable", "cartography"]) {
    assert.deepEqual(
      normalizeExchangeCategory({ categoryMask: 0x01080000, categoryDepth: 2, kind }),
      { categoryMask: 0x01080000, categoryDepth: 2 }
    );
  }

  assert.deepEqual(
    normalizeExchangeCategory({ categoryMask: 0x01030000, categoryDepth: 2 }),
    { categoryMask: 0x01030000, categoryDepth: 2 }
  );
  assert.deepEqual(
    applyExchangeCategoryToSeedRow({
      category_mask: 0x01030000,
      category_depth: 2,
      kind: "schematic"
    }),
    { category_mask: 0x01030000, category_depth: 2, kind: "schematic" }
  );
});

test("normalization is idempotent", () => {
  const first = normalizeExchangeCategory({ categoryMask: 0x01020000, categoryDepth: 2, kind: "equippable" });
  const second = normalizeExchangeCategory({ ...first, kind: "equippable" });
  assert.deepEqual(second, first);
  const ammo = normalizeExchangeCategory({ categoryMask: 0x010e0000, categoryDepth: 2, kind: "ammunition" });
  assert.deepEqual(normalizeExchangeCategory({ ...ammo, kind: "ammunition" }), ammo);
});

test("applyExchangeCategoryToSeedRow preserves snake_case and camelCase", () => {
  assert.equal(applyExchangeCategoryToSeedRow({ category_mask: 0x01020000, category_depth: 2, kind: "equippable" }).category_mask, 0x01010200);
  assert.equal(applyExchangeCategoryToSeedRow({ categoryMask: 0x01020000, categoryDepth: 2, kind: "equippable" }).categoryMask, 0x01010200);
});

test("bundled seed plan: ranged weapons nest under Ranged Weapons and Maula is not alone there", () => {
  const plan = JSON.parse(readFileSync(BUNDLED_PLAN, "utf8"));
  const maula = plan.rows.find((row) => row.template_id === "ChoamSda2" && row.kind === "equippable");
  const karpov = plan.rows.find((row) => row.template_id === "HarkAr2" && row.kind === "equippable");
  const ammo = plan.rows.find((row) => row.template_id === "Ammo" && row.kind === "ammunition");
  const uniqueMaulaSchematic = plan.rows.find((row) => row.template_id === "Schematic_UniqueMaulaPistol");
  const sword = plan.rows.find((row) => row.template_id === "CHOAMSword_0" && row.kind === "equippable");

  assert.equal(maula.category_mask, 0x01010200);
  assert.equal(maula.category_depth, 3);
  assert.equal(karpov.category_mask, 0x01010800);
  assert.equal(karpov.category_depth, 3);
  assert.equal(ammo.category_mask, WEAPONS_AMMUNITION_MASK);
  assert.equal(ammo.category_depth, 2);
  assert.equal(uniqueMaulaSchematic.category_mask, 0x01030200);
  assert.equal(uniqueMaulaSchematic.category_depth, 3);
  assert.equal(sword.category_mask, 0x01000100);
  assert.equal(sword.category_depth, 3);

  const rangedWeapons = plan.rows.filter((row) => (
    row.kind === "equippable"
    && !/^T\d+_Augment_/i.test(row.template_id)
    && exchangeMaskMatches(row.category_mask, row.category_depth, WEAPONS_RANGED_FOLDER_MASK, 2)
  ));
  const rangedTemplates = new Set(rangedWeapons.map((row) => row.template_id));
  assert.ok(rangedTemplates.has("ChoamSda2"));
  assert.ok(rangedTemplates.has("HarkAr2"));
  assert.ok(rangedTemplates.has("HarkHeavyPistol5"));
  assert.ok(rangedTemplates.size > 1, "Ranged Weapons must contain more than Maula pistols");

  const ammunitionEquippables = plan.rows.filter((row) => (
    row.kind === "equippable"
    && exchangeMaskMatches(row.category_mask, row.category_depth, WEAPONS_AMMUNITION_MASK, 2)
  ));
  assert.equal(ammunitionEquippables.length, 0, "physical guns must not list under Ammunition");

  const decodedMaula = decodeExchangeCategoryMask(maula.category_mask);
  assert.equal(decodedMaula.depth2, WEAPONS_RANGED);
});

test("moves Treadwheel equippables from Sandcrawler into One-Man Groundcar", () => {
  const chassis = normalizeExchangeCategory({
    categoryMask: 0x02050000,
    categoryDepth: 3,
    kind: "equippable",
    templateId: "TreadwheelChassis_4"
  });
  assert.deepEqual(chassis, { categoryMask: 0x02000000, categoryDepth: 3 });
  assert.equal(exchangeMaskMatches(chassis.categoryMask, chassis.categoryDepth, VEHICLES_ONE_MAN_FOLDER_MASK, 2), true);
  assert.equal(exchangeMaskMatches(chassis.categoryMask, chassis.categoryDepth, VEHICLES_SANDCRAWLER_FOLDER_MASK, 2), false);

  const engine = normalizeExchangeCategory({
    categoryMask: 0x02050200,
    categoryDepth: 3,
    kind: "equippable",
    templateId: "TreadwheelEngine_4"
  });
  assert.equal(engine.categoryMask, 0x02000200);

  const boost = normalizeExchangeCategory({
    categoryMask: 0x02050500,
    categoryDepth: 3,
    kind: "equippable",
    templateId: "TreadwheelBoost_Unique_LessHeat_4"
  });
  assert.equal(boost.categoryMask, 0x02000500);
  assert.equal(isTreadwheelTemplate("TreadwheelChassis_4"), true);
  assert.equal(isTreadwheelTemplate("SandcrawlerChassis_6"), false);
});

test("moves Treadwheel unique schematics to the One-Man unique slot", () => {
  const schematic = normalizeExchangeCategory({
    categoryMask: 0x02060500,
    categoryDepth: 3,
    kind: "schematic",
    templateId: "TreadwheelEngine_Unique_Speed_4_Schematic"
  });
  assert.deepEqual(schematic, { categoryMask: 0x02060000, categoryDepth: 3 });
  assert.equal(exchangeMaskMatches(schematic.categoryMask, schematic.categoryDepth, VEHICLES_UNIQUE_SCHEMATICS_MASK, 2), true);
  assert.equal(exchangeMaskMatches(schematic.categoryMask, schematic.categoryDepth, VEHICLES_SANDCRAWLER_FOLDER_MASK, 2), false);
  const decoded = decodeExchangeCategoryMask(schematic.categoryMask);
  assert.equal(decoded.depth2, VEHICLES_UNIQUE_SCHEMATICS);
  assert.equal(decoded.depth3, VEHICLES_ONE_MAN);
});

test("leaves real Sandcrawler parts and unique schematics alone", () => {
  assert.deepEqual(
    normalizeExchangeCategory({
      categoryMask: 0x02050000,
      categoryDepth: 3,
      kind: "equippable",
      templateId: "SandcrawlerChassis_6"
    }),
    { categoryMask: 0x02050000, categoryDepth: 3 }
  );
  assert.deepEqual(
    normalizeExchangeCategory({
      categoryMask: 0x02060500,
      categoryDepth: 3,
      kind: "schematic",
      templateId: "SandcrawlerEngine_Unique_Speed_06_Schematic"
    }),
    { categoryMask: 0x02060500, categoryDepth: 3 }
  );
});

test("does not remap Treadwheel without kind, or with the wrong kind", () => {
  assert.deepEqual(
    normalizeExchangeCategory({ categoryMask: 0x02050000, categoryDepth: 3, templateId: "TreadwheelChassis_4" }),
    { categoryMask: 0x02050000, categoryDepth: 3 }
  );
  assert.deepEqual(
    normalizeExchangeCategory({
      categoryMask: 0x02050000,
      categoryDepth: 3,
      kind: "schematic",
      templateId: "TreadwheelChassis_4"
    }),
    { categoryMask: 0x02050000, categoryDepth: 3 }
  );
  assert.deepEqual(
    normalizeExchangeCategory({
      categoryMask: 0x02060500,
      categoryDepth: 3,
      kind: "equippable",
      templateId: "TreadwheelBoost_Unique_LessHeat_4_Schematic"
    }),
    { categoryMask: 0x02060500, categoryDepth: 3 }
  );
});

test("Treadwheel vehicle remap is idempotent", () => {
  const first = normalizeExchangeCategory({
    categoryMask: 0x02050000,
    categoryDepth: 3,
    kind: "equippable",
    templateId: "TreadwheelChassis_4"
  });
  assert.deepEqual(
    normalizeExchangeCategory({ ...first, kind: "equippable", templateId: "TreadwheelChassis_4" }),
    first
  );
  const schematic = normalizeExchangeCategory({
    categoryMask: 0x02060500,
    categoryDepth: 3,
    kind: "schematic",
    templateId: "TreadwheelEngine_Unique_Speed_4_Schematic"
  });
  assert.deepEqual(
    normalizeExchangeCategory({ ...schematic, kind: "schematic", templateId: "TreadwheelEngine_Unique_Speed_4_Schematic" }),
    schematic
  );
});

test("applyExchangeCategoryToSeedRow remaps Treadwheel from template_id", () => {
  assert.equal(
    applyExchangeCategoryToSeedRow({
      template_id: "TreadwheelChassis_4",
      category_mask: 0x02050000,
      category_depth: 3,
      kind: "equippable"
    }).category_mask,
    0x02000000
  );
  assert.equal(
    applyExchangeCategoryToSeedRow({
      templateId: "TreadwheelEngine_Unique_Speed_4_Schematic",
      categoryMask: 0x02060500,
      categoryDepth: 3,
      kind: "schematic"
    }).categoryMask,
    0x02060000
  );
});

test("bundled seed plan: Treadwheel is under One-Man Groundcar, not Sandcrawler", () => {
  const plan = JSON.parse(readFileSync(BUNDLED_PLAN, "utf8"));
  const chassis = plan.rows.find((row) => row.template_id === "TreadwheelChassis_4" && row.kind === "equippable");
  const engine = plan.rows.find((row) => row.template_id === "TreadwheelEngine_4" && row.kind === "equippable");
  const schematic = plan.rows.find((row) => row.template_id === "TreadwheelEngine_Unique_Speed_4_Schematic");
  const sandcrawler = plan.rows.find((row) => row.template_id === "SandcrawlerChassis_6" && row.kind === "equippable");
  const sandcrawlerSchematic = plan.rows.find((row) => row.template_id === "SandcrawlerEngine_Unique_Speed_06_Schematic");
  const sandbike = plan.rows.find((row) => row.template_id === "SandbikeChassis_1" && row.kind === "equippable");

  assert.equal(chassis.category_mask, 0x02000000);
  assert.equal(chassis.category_depth, 3);
  assert.equal(engine.category_mask, 0x02000200);
  assert.equal(schematic.category_mask, 0x02060000);
  assert.equal(schematic.category_depth, 3);
  assert.equal(sandcrawler.category_mask, 0x02050000);
  assert.equal(sandcrawlerSchematic.category_mask, 0x02060500);
  assert.equal(sandbike.category_mask, 0x02000000);

  const treadwheelEquippables = plan.rows.filter((row) => (
    row.kind === "equippable" && isTreadwheelTemplate(row.template_id)
  ));
  assert.ok(treadwheelEquippables.length > 0);
  for (const row of treadwheelEquippables) {
    assert.equal(
      exchangeMaskMatches(row.category_mask, row.category_depth, VEHICLES_ONE_MAN_FOLDER_MASK, 2),
      true,
      `${row.template_id} must list under One-Man Groundcar`
    );
    assert.equal(
      exchangeMaskMatches(row.category_mask, row.category_depth, VEHICLES_SANDCRAWLER_FOLDER_MASK, 2),
      false,
      `${row.template_id} must not list under Sandcrawler`
    );
  }

  const sandcrawlerEquippables = plan.rows.filter((row) => (
    row.kind === "equippable"
    && exchangeMaskMatches(row.category_mask, row.category_depth, VEHICLES_SANDCRAWLER_FOLDER_MASK, 2)
  ));
  assert.ok(sandcrawlerEquippables.some((row) => row.template_id.startsWith("Sandcrawler")));
  assert.equal(sandcrawlerEquippables.filter((row) => isTreadwheelTemplate(row.template_id)).length, 0);

  const uniqueTreadwheel = plan.rows.filter((row) => (
    row.kind === "schematic" && isTreadwheelTemplate(row.template_id)
  ));
  for (const row of uniqueTreadwheel) {
    const decoded = decodeExchangeCategoryMask(row.category_mask);
    assert.equal(decoded.depth2, VEHICLES_UNIQUE_SCHEMATICS);
    assert.equal(decoded.depth3, VEHICLES_ONE_MAN);
  }
});
