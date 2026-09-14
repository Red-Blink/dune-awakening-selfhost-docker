import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  GUESSED_AMMUNITION_CODE,
  RANGED_TYPE_PISTOL,
  WEAPONS_AMMUNITION_MASK,
  WEAPONS_RANGED,
  WEAPONS_RANGED_FOLDER_MASK,
  WEAPONS_TOP_LEVEL,
  WEAPONS_UNIQUE_SCHEMATICS_MASK,
  applyExchangeCategoryToSeedRow,
  decodeExchangeCategoryMask,
  exchangeMaskMatches,
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
