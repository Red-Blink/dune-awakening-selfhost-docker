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
const WEAPON_SWORD = "UniqueSword";
const WEAPON_LASGUN = "UniqueLasgun";

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
      if (text.includes("where i.id = $1 and inv.actor_id = $2")) return { rows: [{ id: 501, stats: { FCustomizationStats: [[], {}], FItemStackAndDurabilityStats: [[], { CurrentDurability: 80, MaxDurability: 100 }] }, template_id: "UniqueSword" }] };
      if (text.includes("where actor_id = $1 and inventory_type = 0")) return { rows: [{ id: 7, actor_id: 123, max_item_count: 30, max_item_volume: 0 }] };
      if (text.includes("where actor_id = $1") && text.includes("order by id") && text.includes("from dune.inventories")) return { rows: [{ id: 7, actor_id: 123, max_item_count: 30, max_item_volume: 0 }] };
      if (text.includes("from dune.actors a")) return { rows: [{ actor_id: 123, account_id: 44, controller_id: 55, player_state_id: 5, online_status: "Offline" }] };
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
    assert.deepEqual(stats.FCustomizationStats[0], [AUGMENT_MELEE_DAMAGE, AUGMENT_MELEE_GRIP]);
    assert.equal(stats.FItemStackAndDurabilityStats[1].CurrentDurability, 100);
    assert.equal(stats.FItemStackAndDurabilityStats[1].MaxDurability, 100);
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
    assert.deepEqual(stats.FCustomizationStats[0], [AUGMENT_MELEE_DAMAGE]);
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
  const stats = JSON.parse(calls.find((c) => c.text.includes("insert")).values[5]);
  assert.deepEqual(stats.FCustomizationStats[0], [AUGMENT_MELEE_DAMAGE]);
  assert.deepEqual(stats.FItemStackAndDurabilityStats[1], {});
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
  assert.deepEqual(stats.FCustomizationStats[0], [AUGMENT_MELEE_DAMAGE, AUGMENT_MELEE_GRIP]);
});

test("augment regression: augment ID validation rejects unsafe input", async () => {
  assert.doesNotThrow(() => validateTemplateId("T6_Augment_Melee1"));
  assert.doesNotThrow(() => validateTemplateId("UniqueSword_05"));
  assert.throws(() => validateTemplateId(""), /Invalid/);
  assert.throws(() => validateTemplateId("bad;injection"), /Invalid/);
  assert.throws(() => validateTemplateId("DROP TABLE"), /Invalid/);
  assert.throws(() => validateTemplateId("a".repeat(241)), /Invalid/);
});

test("augment regression: empty augments array is valid and produces empty FCustomizationStats", async () => {
  const calls = [];
  const db = fakePlayerDb(calls);
  const result = await giveItemToPlayer(db, 123, { templateId: WEAPON_SWORD, quantity: 1, quality: 0 });
  assert.equal(result.augments, undefined);
  const stats = JSON.parse(calls.find((c) => c.text.includes("insert")).values[5]);
  assert.deepEqual(stats.FCustomizationStats, [[], {}]);
});

test("augment regression: augments capped at 20 entries", async () => {
  const calls = [];
  const db = fakePlayerDb(calls);
  const thirtyAugments = Array.from({ length: 30 }, (_, i) => `T6_Augment_Test${i}`);
  const result = await giveItemToPlayer(db, 123, { templateId: WEAPON_SWORD, quantity: 1, quality: 0, augments: thirtyAugments });
  const stats = JSON.parse(calls.find((c) => c.text.includes("insert")).values[5]);
  assert.equal(stats.FCustomizationStats[0].length, 20);
  assert.equal(result.augments.length, 20);
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
      if (text.includes("where i.id = $1 and inv.actor_id = $2")) return { rows: [{ id: 502, stats: { FCustomizationStats: [[AUGMENT_MELEE_DAMAGE], {}], FItemStackAndDurabilityStats: [[], { CurrentDurability: 90 }] }, template_id: "UniqueSword" }] };
      if (text.includes("from dune.actors a")) return { rows: [{ actor_id: 123, account_id: 44, controller_id: 55, player_state_id: 5, online_status: "Offline" }] };
      if (text.includes("update dune.items set stats")) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
    transaction: async (fn) => fn(db)
  };
  const result = await augmentInventoryItem(db, 123, 502, { augments: [AUGMENT_MELEE_DAMAGE] });
  assert.deepEqual(result.augments, [AUGMENT_MELEE_DAMAGE]);
  assert.deepEqual(result.previous, [AUGMENT_MELEE_DAMAGE]);
});
