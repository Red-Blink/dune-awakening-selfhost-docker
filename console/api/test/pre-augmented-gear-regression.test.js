import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { giveItemToPlayer, giveItemToStorage, augmentInventoryItem } from "../src/duneDb.js";
import { validateTemplateId } from "../src/duneDb/presentation.js";
import { itemRequiresDatabaseGrant, resolveCatalogItem } from "../src/adminCatalog.js";

const AUGMENT_MELEE_DAMAGE = "T6_Augment_Melee1";
const AUGMENT_MELEE_GRIP = "T6_Augment_Melee4";
const AUGMENT_ARMOR_CONCUSSIVE = "T6_Augment_Armor1";
const AUGMENT_ACCURACY = "T6_Augment_Acuracy1";
const WEAPON_SWORD = "UniqueSword_05";
const WEAPON_LASGUN = "UniqueLasgun";

function augmentRollRow(templateId, hash) {
  return { template_id: templateId, stats: { FAugmentItemStats: [[], { StatRolls: [hash / 100] }] } };
}

function fakePlayerDb(calls) {
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("to_regprocedure")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) {
        const table = values[1];
        const names = table === "inventories"
          ? ["id", "actor_id", "max_item_count", "max_item_volume", "inventory_type"]
          : table === "actors"
            ? ["id", "class", "owner_account_id", "properties"]
            : table === "items"
              ? ["inventory_id", "template_id", "stack_size", "quality_level", "position_index", "stats"]
              : ["id"];
        return { rows: names.map((column_name) => ({ column_name })) };
      }
      if (text.includes("count(*)::int") && text.includes("dune.items")) return { rows: [{ count: 1 }] };
      if (text.includes("max(position_index)")) return { rows: [{ position_index: 2 }] };
      if (text.includes("where i.id = $1 and inv.actor_id = $2")) return { rows: [{ id: 501, stats: { FCustomizationStats: [[], {}], FItemStackAndDurabilityStats: [[], { CurrentDurability: 80, MaxDurability: 100 }] }, template_id: "UniqueSword_05" }] };
      if (text.includes("stats ? 'FAugmentItemStats'")) {
        const requested = Array.isArray(values[0]) ? values[0] : [];
        const known = new Map([
          [AUGMENT_MELEE_DAMAGE, augmentRollRow(AUGMENT_MELEE_DAMAGE, 11)],
          [AUGMENT_MELEE_GRIP, augmentRollRow(AUGMENT_MELEE_GRIP, 14)],
          [AUGMENT_ARMOR_CONCUSSIVE, augmentRollRow(AUGMENT_ARMOR_CONCUSSIVE, 21)],
          [AUGMENT_ACCURACY, augmentRollRow(AUGMENT_ACCURACY, 31)]
        ]);
        return { rows: requested.map((id, index) => known.get(id) || augmentRollRow(id, 100 + index)) };
      }
      if (text.includes("where actor_id = $1 and inventory_type = 0")) return { rows: [{ id: 7, actor_id: 123, max_item_count: 30, max_item_volume: 0 }] };
      if (text.includes("where actor_id = $1") && text.includes("order by id") && text.includes("from dune.inventories")) return { rows: [{ id: 7, actor_id: 123, max_item_count: 30, max_item_volume: 0 }] };
      if (text.includes("from dune.actors a")) return { rows: [{ actor_id: 123, account_id: 44, controller_id: 55, player_state_id: 5, online_status: "Offline" }] };
      if (text.includes("insert into dune.specialization_tracks")) return { rows: [], rowCount: 1 };
      if (text.includes("insert into dune.purchased_specialization_keystones")) return { rows: [], rowCount: Array.isArray(values[1]) ? values[1].length : 0 };
      if (text.includes("insert into dune.items")) return { rows: [{ id: 501, template_id: values[1], stack_size: values[2], quality_level: values[3], position_index: values[4], inventory_id: values[0] }] };
      if (text.includes("update dune.items set stats")) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
    transaction: async (fn) => fn(db)
  };
  return db;
}

function tempCatalogWithAugments() {
  const root = mkdtempSync(join(tmpdir(), "augment-regression-"));
  const dataDir = join(root, "runtime", "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "admin-items.json"), JSON.stringify([
    { id: WEAPON_SWORD, name: "Replica Pulse-sword", category: "weapons", source: "Weapons" },
    { id: WEAPON_LASGUN, name: "Arhun K-28 Lasgun", category: "weapons", source: "Weapons" },
    { id: AUGMENT_MELEE_DAMAGE, name: "Blade Sharpener", category: "weapons", source: "Augments" },
    { id: AUGMENT_MELEE_GRIP, name: "Aggressive Grip Adjuster", category: "weapons", source: "Augments" },
    { id: AUGMENT_ARMOR_CONCUSSIVE, name: "Concussive Dampening", category: "weapons", source: "Augments" },
    { id: AUGMENT_ACCURACY, name: "Precision Barrel Adjuster", category: "weapons", source: "Augments" },
    { id: `${AUGMENT_MELEE_DAMAGE}_Schematic`, name: "Blade Sharpener", category: "schematics", source: "Schematics" }
  ]));
  return root;
}

test("augment regression: grant pipeline composes valid JSONB", async () => {
  const calls = [];
  const db = fakePlayerDb(calls);
  const repoRoot = tempCatalogWithAugments();
  try {
    const result = await giveItemToPlayer(db, 123, {
      templateId: WEAPON_SWORD,
      quantity: 1,
      quality: 0,
      augments: [AUGMENT_MELEE_DAMAGE, AUGMENT_MELEE_GRIP]
    });
    assert.ok(result.ok);
    assert.deepEqual(result.augments, [AUGMENT_MELEE_DAMAGE, AUGMENT_MELEE_GRIP]);
    assert.equal(result.inserted.template_id, WEAPON_SWORD);
    const insert = calls.find((c) => c.text.includes("insert into dune.items"));
    const stats = JSON.parse(insert.values[5]);
    assert.deepEqual(stats.FCustomizationStats, [[], {}]);
    assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugments, [{ Name: AUGMENT_MELEE_DAMAGE }, { Name: AUGMENT_MELEE_GRIP }]);
    assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugmentQualities, [1, 1]);
    assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugmentRollData, [{ StatRolls: [1], AppliedEffectIndices: [] }, { StatRolls: [1], AppliedEffectIndices: [] }]);
    assert.equal(stats.FItemStackAndDurabilityStats[1].CurrentDurability, 100);
    assert.equal(stats.FItemStackAndDurabilityStats[1].MaxDurability, 100);
    assert.deepEqual(result.slotUnlocks.keystoneIds, [44, 45, 46]);
    assert.ok(calls.some((c) => c.text.includes("insert into dune.purchased_specialization_keystones")));
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("augment regression: grant grade 5 item with augments", async () => {
  const calls = [];
  const db = fakePlayerDb(calls);
  const repoRoot = tempCatalogWithAugments();
  try {
    const result = await giveItemToPlayer(db, 123, {
      templateId: WEAPON_SWORD,
      quantity: 1,
      quality: 5,
      augments: [AUGMENT_MELEE_DAMAGE]
    });
    assert.equal(result.inserted.quality_level, 5);
    const insert = calls.find((c) => c.text.includes("insert into dune.items"));
    const stats = JSON.parse(insert.values[5]);
    assert.deepEqual(stats.FCustomizationStats, [[], {}]);
    assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugments, [{ Name: AUGMENT_MELEE_DAMAGE }]);
    assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugmentQualities, [1]);
    assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugmentRollData, [{ StatRolls: [1], AppliedEffectIndices: [] }]);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

test("augment regression: storage grant with augments", async () => {
  const calls = [];
  const db = fakePlayerDb(calls);
  const result = await giveItemToStorage(db, 222, {
    templateId: WEAPON_SWORD,
    quantity: 1,
    quality: 0,
    augments: [AUGMENT_MELEE_DAMAGE]
  });
  assert.deepEqual(result.augments, [AUGMENT_MELEE_DAMAGE]);
  const stats = JSON.parse(calls.find((c) => c.text.includes("insert into dune.items")).values[5]);
  assert.deepEqual(stats.FCustomizationStats, [[], {}]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugments, [{ Name: AUGMENT_MELEE_DAMAGE }]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugmentQualities, [1]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugmentRollData, [{ StatRolls: [1], AppliedEffectIndices: [] }]);
  assert.equal(stats.FItemStackAndDurabilityStats[1].CurrentDurability, 100);
  assert.equal(stats.FItemStackAndDurabilityStats[1].MaxDurability, 100);
  assert.ok(!result.slotUnlocks);
});

test("augment regression: apply to existing item preserves durability", async () => {
  const calls = [];
  const db = fakePlayerDb(calls);
  const result = await augmentInventoryItem(db, 123, 501, {
    augments: [AUGMENT_MELEE_DAMAGE, AUGMENT_MELEE_GRIP]
  });
  assert.deepEqual(result.augments, [AUGMENT_MELEE_DAMAGE, AUGMENT_MELEE_GRIP]);
  assert.deepEqual(result.previous, []);
  const update = calls.find((c) => c.text.includes("update dune.items set stats"));
  const stats = JSON.parse(update.values[0]);
  assert.equal(stats.FItemStackAndDurabilityStats[1].CurrentDurability, 80);
  assert.equal(stats.FItemStackAndDurabilityStats[1].MaxDurability, 100);
  assert.deepEqual(stats.FCustomizationStats, [[], {}]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugments, [{ Name: AUGMENT_MELEE_DAMAGE }, { Name: AUGMENT_MELEE_GRIP }]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugmentQualities, [1, 1]);
  assert.deepEqual(stats.FAugmentedItemStats[1].AppliedAugmentRollData, [{ StatRolls: [1], AppliedEffectIndices: [] }, { StatRolls: [1], AppliedEffectIndices: [] }]);
});

test("augment regression: augment ID validation rejects unsafe input", async () => {
  assert.doesNotThrow(() => validateTemplateId("T6_Augment_Melee1"));
  assert.doesNotThrow(() => validateTemplateId("UniqueSword_05"));
  assert.throws(() => validateTemplateId(""), /Invalid/);
  assert.throws(() => validateTemplateId("bad;injection"), /Invalid/);
  assert.throws(() => validateTemplateId("DROP TABLE"), /Invalid/);
  assert.throws(() => validateTemplateId("a".repeat(241)), /Invalid/);
});

test("augment regression: empty augments array is valid and does not create FAugmentedItemStats", async () => {
  const calls = [];
  const db = fakePlayerDb(calls);
  const result = await giveItemToPlayer(db, 123, { templateId: WEAPON_SWORD, quantity: 1, quality: 0 });
  assert.equal(result.augments, undefined);
  const stats = JSON.parse(calls.find((c) => c.text.includes("insert into dune.items")).values[5]);
  assert.deepEqual(stats.FCustomizationStats, [[], {}]);
  assert.equal(stats.FAugmentedItemStats, undefined);
});

test("augment regression: weapons are capped at three compatible augments", async () => {
  const calls = [];
  const db = fakePlayerDb(calls);
  await assert.rejects(
    () => giveItemToPlayer(db, 123, { templateId: WEAPON_SWORD, quantity: 1, quality: 0, augments: ["T6_Augment_Melee1", "T6_Augment_Melee2", "T6_Augment_Melee3", "T6_Augment_Melee4"] }),
    /supports up to 3 augment/
  );
  const result = await giveItemToPlayer(db, 123, { templateId: WEAPON_SWORD, quantity: 1, quality: 0, augments: ["T6_Augment_Melee1", "T6_Augment_Melee2", "T6_Augment_Melee3"] });
  const stats = JSON.parse(calls.find((c) => c.text.includes("insert into dune.items")).values[5]);
  assert.equal(stats.FAugmentedItemStats[1].AppliedAugments.length, 3);
  assert.equal(stats.FAugmentedItemStats[1].AppliedAugmentQualities.length, 3);
  assert.equal(stats.FAugmentedItemStats[1].AppliedAugmentRollData.length, 3);
  assert.equal(result.augments.length, 3);
});

test("augment regression: catalog routing detects augments for DB grant", () => {
  const root = tempCatalogWithAugments();
  try {
    assert.equal(itemRequiresDatabaseGrant(resolveCatalogItem(root, { itemId: AUGMENT_MELEE_DAMAGE })), true);
    assert.equal(itemRequiresDatabaseGrant(resolveCatalogItem(root, { itemId: AUGMENT_ARMOR_CONCUSSIVE })), true);
    assert.equal(itemRequiresDatabaseGrant(resolveCatalogItem(root, { itemId: WEAPON_SWORD })), false);
    assert.equal(itemRequiresDatabaseGrant(resolveCatalogItem(root, { itemId: `${AUGMENT_MELEE_DAMAGE}_Schematic` })), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("augment regression: prevent duplicate augment application", async () => {
  const calls = [];
  const db = {
    query: async (text, values = []) => {
      calls.push({ text, values });
      if (text.includes("to_regclass")) return { rows: [{ exists: true }] };
      if (text.includes("to_regprocedure")) return { rows: [{ exists: true }] };
      if (text.includes("information_schema.columns")) {
        const table = values[1];
        const names = table === "inventories"
          ? ["id", "actor_id", "max_item_count", "max_item_volume", "inventory_type"]
          : table === "actors"
            ? ["id", "class", "owner_account_id", "properties"]
            : table === "items"
              ? ["inventory_id", "template_id", "stack_size", "quality_level", "position_index", "stats"]
              : ["id"];
        return { rows: names.map((column_name) => ({ column_name })) };
      }
      if (text.includes("stats ? 'FAugmentItemStats'")) return { rows: [augmentRollRow(AUGMENT_MELEE_DAMAGE, 11)] };
      if (text.includes("where i.id = $1 and inv.actor_id = $2")) return { rows: [{ id: 502, stats: { FCustomizationStats: [[], {}], FAugmentedItemStats: [[], { AppliedAugments: [AUGMENT_MELEE_DAMAGE], AppliedAugmentQualities: [1], AppliedAugmentRollData: [{ StatRolls: [] }] }], FItemStackAndDurabilityStats: [[], { CurrentDurability: 90 }] }, template_id: "UniqueSword_05" }] };
      if (text.includes("from dune.actors a")) return { rows: [{ actor_id: 123, account_id: 44, controller_id: 55, player_state_id: 5, online_status: "Offline" }] };
      if (text.includes("insert into dune.specialization_tracks")) return { rows: [], rowCount: 1 };
      if (text.includes("insert into dune.purchased_specialization_keystones")) return { rows: [], rowCount: Array.isArray(values[1]) ? values[1].length : 0 };
      if (text.includes("update dune.items set stats")) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
    transaction: async (fn) => fn(db)
  };
  const result = await augmentInventoryItem(db, 123, 502, { augments: [AUGMENT_MELEE_DAMAGE] });
  assert.deepEqual(result.augments, [AUGMENT_MELEE_DAMAGE]);
  assert.deepEqual(result.previous, [AUGMENT_MELEE_DAMAGE]);
  assert.deepEqual(result.slotUnlocks.keystoneIds, [44, 45, 46]);
});
