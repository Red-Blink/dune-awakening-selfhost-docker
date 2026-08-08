import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itemIsRankedSchematic, itemIsSchematic, itemRequiresDatabaseGrant, listCatalogItems, resolveCatalogItem } from "../src/adminCatalog.js";

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "web-admin-catalog-"));
  mkdirSync(join(root, "runtime/data"), { recursive: true });
  writeFileSync(join(root, "runtime/data/admin-items.json"), JSON.stringify([
    { id: "PlantFiber", name: "Plant Fiber", category: "materials", source: "Resources" },
    { id: "CupOfWater", name: "Cup of Water", category: "consumables", source: "Survival" },
    { id: "ChoamHeavyLasgunSchematic", name: "Arhun K-28 Lasgun", category: "schematics", source: "Schematics" },
    { id: "ArmorPiercingAugment", name: "Armor Piercing Augment", category: "augments", source: "Items" }
  ]));
  return root;
}

test("catalog item list returns real item rows only", () => {
  const rows = listCatalogItems(fixtureRepo(), { q: "fiber" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Plant Fiber");
  assert.equal(rows[0].itemId, "PlantFiber");
  assert.equal(rows[0].category, "materials");
  assert.notEqual(rows[0].name, "category");
  assert.notEqual(rows[0].name, "source");
});

test("catalog resolver rejects duplicate display names instead of silently selecting one", () => {
  const root = fixtureRepo();
  const file = join(root, "runtime/data/admin-items.json");
  const rows = JSON.parse(readFileSync(file, "utf8"));
  rows.push({ id: "PlantFiber_Schematic", name: "Plant Fiber", category: "schematics", source: "Schematics" });
  writeFileSync(file, JSON.stringify(rows));
  assert.throws(() => resolveCatalogItem(root, { itemName: "Plant Fiber" }), /Ambiguous item name/);
  assert.equal(resolveCatalogItem(root, { itemId: "PlantFiber_Schematic" }).itemId, "PlantFiber_Schematic");
});

test("catalog resolver rejects metadata as item names", () => {
  const root = fixtureRepo();
  assert.equal(resolveCatalogItem(root, { itemName: "Plant Fiber" }).itemId, "PlantFiber");
  assert.throws(() => resolveCatalogItem(root, { itemName: "category" }), /No item found/);
  assert.throws(() => resolveCatalogItem(root, { itemName: "source" }), /No item found/);
});

test("catalog marks schematics and augments for database grants", () => {
  const root = fixtureRepo();
  assert.equal(itemRequiresDatabaseGrant(resolveCatalogItem(root, { itemName: "Arhun K-28 Lasgun" })), true);
  assert.equal(itemRequiresDatabaseGrant(resolveCatalogItem(root, { itemName: "Armor Piercing Augment" })), true);
  assert.equal(itemRequiresDatabaseGrant(resolveCatalogItem(root, { itemName: "Plant Fiber" })), false);
  assert.equal(itemRequiresDatabaseGrant(resolveCatalogItem(root, { itemId: "SchematicPattern_Sword" })), true);
  assert.equal(itemIsSchematic(resolveCatalogItem(root, { itemName: "Arhun K-28 Lasgun" })), true);
  assert.equal(itemIsSchematic(resolveCatalogItem(root, { itemName: "Armor Piercing Augment" })), false);
});

// Every normalized item stats its icon, and listCatalogItems normalizes up to
// 10,000 of them per request. Memoisation is only observable by moving the
// filesystem underneath the second lookup: it has to answer from the cache
// rather than notice a file that appeared in between.
test("item image lookups are resolved once per repo root", () => {
  const root = fixtureRepo();
  const images = join(root, "console/web/public/images/items");
  mkdirSync(images, { recursive: true });

  assert.equal(resolveCatalogItem(root, { itemId: "PlantFiber" }).image, "/images/items/image-unavailable.png");
  writeFileSync(join(images, "PlantFiber.png"), "");
  assert.equal(resolveCatalogItem(root, { itemId: "PlantFiber" }).image, "/images/items/image-unavailable.png");

  // Keyed by repo root, not global: another root resolves the same id fresh.
  const other = fixtureRepo();
  const otherImages = join(other, "console/web/public/images/items");
  mkdirSync(otherImages, { recursive: true });
  writeFileSync(join(otherImages, "PlantFiber.png"), "");
  assert.equal(resolveCatalogItem(other, { itemId: "PlantFiber" }).image, "/images/items/PlantFiber.png");
});

test("ranked physical schematics are distinguished from Grade 0 live grants", () => {
  const root = fixtureRepo();
  const schematic = resolveCatalogItem(root, { itemName: "Arhun K-28 Lasgun" });
  const normalItem = resolveCatalogItem(root, { itemName: "Plant Fiber" });
  assert.equal(itemIsRankedSchematic(schematic, 0), false);
  assert.equal(itemIsRankedSchematic(schematic, 5), true);
  assert.equal(itemIsRankedSchematic(normalItem, 5), false);
});
