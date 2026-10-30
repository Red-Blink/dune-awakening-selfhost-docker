import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildingUnlockStatus, customizationGrantGroups, customizationGrantStatus, isFillableItem, itemImagePath, itemIsRankedSchematic, itemIsSchematic, itemRequiresDatabaseGrant, listBuildingUnlockItems, listCatalogItems, listCustomizationGrantItems, resolveCatalogItem, resolveFillableCatalogItem, resolveItemStackSize, resolveItemVolume } from "../src/adminCatalog.js";

const REAL_REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "web-admin-catalog-"));
  mkdirSync(join(root, "runtime/data"), { recursive: true });
  writeFileSync(join(root, "runtime/data/admin-items.json"), JSON.stringify([
    { id: "PlantFiber", name: "Plant Fiber", category: "materials", source: "Resources" },
    { id: "CupOfWater", name: "Cup of Water", category: "consumables", source: "Survival" },
    { id: "ChoamHeavyLasgunSchematic", name: "Arhun K-28 Lasgun", category: "schematics", source: "Schematics" },
    { id: "ArmorPiercingAugment", name: "Armor Piercing Augment", category: "augments", source: "Items" },
    { id: "SteelBar", name: "Steel Ingot", category: "resources", source: "Resources", group: "refined_resource", volume: 1.0, stackSize: 500 },
    { id: "T6RefinedResourceA", name: "Plastanium Ingot", category: "resources", source: "Resources", group: "refined_resource", volume: 1.0 },
    { id: "FremenComponent1", name: "EMF Generator", category: "resources", source: "Resources", group: "component", volume: 1.0 },
    { id: "AzuriteOre", name: "Copper Ore", category: "resources", source: "Resources", group: "raw_resource", volume: 0.2 },
    { id: "BasicLighting_Patent", name: "Basic Lighting", category: "buildings", source: "BuildingSets" },
    { id: "Developer_Storage_Container_Patent", name: "Developer Storage Container", category: "buildings", source: "BuildingSets" },
    { id: "B1C3_Atre_Maula_Pistol", name: "Atreides Pistol", category: "customizations", source: "Customizations" },
    { id: "B1C3_Hark_Maula_Pistol", name: "Harkonnen Pistol", category: "customizations", source: "Customizations" },
    { id: "MTX_B1C3_Smuggler_Kindjal_Variant", name: "Smuggler Kindjal", category: "customizations", source: "Customizations" },
    { id: "MTX_B1C2_DuneManCoverallsSetVariant_Top", name: "Dune Man Jacket", category: "customizations", source: "Customizations" },
    { id: "MTX_Fremen_FedaykinArmor_SetVariant", name: "Aegis of an Unwalked Path", category: "customizations", source: "Customizations", requiredDlc: "Filmic Archive", requiredSteamDlc: "4857580" },
    { id: "MTX_Atre_CaladanTrenchcoat_SetVariant", name: "Caladan Stormcoat", category: "customizations", source: "Customizations", requiredDlc: "Filmic Archive", requiredSteamDlc: "4857580" },
    { id: "MTX_Sard_Scout_SetVariant", name: "Sardaukar Velites Armor", category: "customizations", source: "Customizations", requiredDlc: "Filmic Archive", requiredSteamDlc: "4857580" },
    { id: "Unrelated_Swatch", name: "Unrelated Swatch", category: "customizations", source: "Customizations" }
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

test("customization grants use the four curated sets and report pending tokens", () => {
  const root = fixtureRepo();
  const items = listCustomizationGrantItems(root);
  assert.equal(items.length, 7);
  assert.deepEqual(customizationGrantGroups(root), [
    { id: "halloween-2026", name: "Halloween 2026", count: 0 },
    { id: "atreides", name: "Atreides", count: 1 },
    { id: "harkonnen", name: "Harkonnen", count: 1 },
    { id: "smuggler", name: "Smuggler", count: 1 },
    { id: "dune-man", name: "Dune Man", count: 1 },
    { id: "filmic-archive", name: "Filmic Archive", count: 3 }
  ]);
  assert.equal(customizationGrantStatus("B1C3_Atre_Maula_Pistol", { pending: ["B1C3_Atre_Maula_Pistol"] }), "Pending");
  assert.equal(customizationGrantStatus("B1C3_Atre_Maula_Pistol", { pending: [] }), "Available");
});

test("Halloween cosmetics are direct unlocks and never appear as inventory templates", () => {
  const event = listCustomizationGrantItems(REAL_REPO_ROOT).filter((item) => item.groupId === "halloween-2026");
  assert.deepEqual(event.map((item) => item.itemId).sort(), [
    "Halloween2026_PlagueDoctorMask_Hood", "Halloween2026_PlagueDoctorMask_NoHood",
    "Halloween2026_Radsuit_Variant", "Swatch_Halloween2026"
  ]);
  assert.ok(event.every((item) => item.directUnlock));
  const inventory = listCatalogItems(REAL_REPO_ROOT, { q: "Halloween", limit: 10000 });
  assert.ok(!inventory.some((item) => event.some((cosmetic) => cosmetic.itemId === item.itemId)));
  assert.equal(customizationGrantStatus(event[0].itemId, { owned: [event[0].itemId] }), "Unlocked");
});

test("catalog preserves DLC ownership metadata for grant warnings", () => {
  const item = resolveCatalogItem(fixtureRepo(), { itemId: "MTX_Fremen_FedaykinArmor_SetVariant" });
  assert.equal(item.requiredDlc, "Filmic Archive");
  assert.equal(item.requiredSteamDlc, "4857580");
  assert.equal(item.entitlementControlled, true);
});

test("catalog identifies Lost Harvest and other entitlement-controlled MTX grants", () => {
  const root = fixtureRepo();
  const duneMan = resolveCatalogItem(root, { itemId: "MTX_B1C2_DuneManCoverallsSetVariant_Top" });
  assert.equal(duneMan.requiredDlc, "Lost Harvest");
  assert.equal(duneMan.requiredSteamDlc, "3596900");
  assert.equal(duneMan.entitlementControlled, true);

  const ordinary = resolveCatalogItem(root, { itemId: "BasicLighting_Patent" });
  assert.equal(ordinary.entitlementControlled, undefined);
});

test("real catalog uses the corrected Dune Man Set 2 patent ID", () => {
  const unlocks = listBuildingUnlockItems(REAL_REPO_ROOT);
  const duneManSets = unlocks.filter((item) => ["MTX_Neut_DesertMechanicSet_Patent", "MTX_Neut_DesertMechanicSet02_Patent"].includes(item.itemId));
  assert.equal(duneManSets.length, 2);
  for (const item of duneManSets) {
    assert.equal(item.requiredDlc, "Lost Harvest");
    assert.equal(item.requiredSteamDlc, "3596900");
    assert.equal(item.entitlementControlled, true);
  }
  assert.equal(unlocks.some((item) => item.itemId === "MTX_Neut_DesertMechanicSet_02_Patent"), false);
  assert.equal(unlocks.find((item) => item.itemId === "MTX_Atre_BreakfastRoomSet_Patent")?.entitlementControlled, true);
});

test("real catalog exposes only verified Filmic Archive grant tokens through their correct flows", () => {
  const unlocks = listBuildingUnlockItems(REAL_REPO_ROOT);
  assert.deepEqual(
    unlocks.filter((item) => item.requiredSteamDlc === "4857580").map((item) => item.itemId).sort(),
    ["MTX_SardaukarFightingDummy_Patent", "MTX_SardaukarDecorationSet_Patent", "MTX_Sardaukar_BuildingSet_Patent"].sort()
  );

  const customizations = listCustomizationGrantItems(REAL_REPO_ROOT);
  assert.deepEqual(
    customizations.filter((item) => item.groupId === "filmic-archive").map((item) => item.itemId).sort(),
    ["MTX_Atre_CaladanTrenchcoat_SetVariant", "MTX_Fremen_FedaykinArmor_SetVariant", "MTX_Sard_Scout_SetVariant"].sort()
  );

  for (const itemId of ["Emote_Sardaukar_Kneel", "Emote_Sardaukar_BloodWipe"]) {
    const item = resolveCatalogItem(REAL_REPO_ROOT, { itemId });
    assert.equal(item.category, "emotes");
    assert.equal(item.source, "Emotes");
    assert.equal(item.requiredSteamDlc, "4857580");
  }

  for (const entitlementOnlyId of ["Atreides_Light_Set_Torso", "Harkonnen_Heavy_Set_Torso", "Sardaukar_Broadsword", "Sardaukar_Disruptor"]) {
    assert.equal(JSON.parse(readFileSync(join(REAL_REPO_ROOT, "runtime/data/admin-items.json"), "utf8")).some((item) => item.id === entitlementOnlyId), false);
  }
});

test("real catalog exposes the verified Ixian Icon patent through building unlocks", () => {
  // The exact token is present in build 2160922's CDT_BaseItems. The item
  // listing names it Ixian Icon and links it to A Sign from Above:
  // https://dune.gaming.tools/items/mtx_ixiantotem_patent
  const id = "MTX_IxianTotem_Patent";
  const matches = listBuildingUnlockItems(REAL_REPO_ROOT).filter((item) => item.itemId === id);
  assert.equal(matches.length, 1);
  const item = matches[0];
  assert.equal(item.name, "Ixian Icon");
  assert.equal(item.category, "buildings");
  assert.equal(item.source, "BuildingSets");
  assert.equal(item.group, "Special & Promotional");
  assert.equal(item.experimental, false);
  assert.equal(item.entitlementControlled, true); // Preserve the existing MTX handling.
  assert.equal(item.requiredDlc, undefined);
  assert.equal(item.requiredSteamDlc, undefined);
  assert.equal(resolveCatalogItem(REAL_REPO_ROOT, { itemName: "Ixian Icon" }).itemId, id);
  assert.equal(listCatalogItems(REAL_REPO_ROOT, { q: "Ixian Icon" }).some((row) => row.itemId === id), false);
  assert.equal(buildingUnlockStatus(id, { owned: ["MTX_IxianTotem"] }), "Owned");
  assert.equal(buildingUnlockStatus(id, { pending: [id] }), "Pending");
});

test("real catalog exposes all seven native Halloween event building unlocks", () => {
  // Verified against build 2162777 CDT_BaseItems/DT_ItemTableBuildables
  // and ST_Localization_Buildings. Keep the native VacumBodies spelling.
  const expected = {
    MTX_HalloweenEvent_Crucifixion_Patent: "Decussate Cross",
    MTX_HalloweenEvent_Fleshtube_Patent: "Flesh Sculpting Displays",
    MTX_HalloweenEvent_LightPole_Patent: "Jury-Rigged Light Stand",
    MTX_HalloweenEvent_RadiationCrate_Patent: "Sealed Radiation Containment Chest",
    MTX_HalloweenEvent_RottingCorpse_Patent: "Cadaverous Decorations",
    MTX_HalloweenEvent_Skeleton_Patent: "Osseous Decorations",
    MTX_HalloweenEvent_VacumBodies_Patent: "Vacuum-Sealed Body Display"
  };
  const raw = JSON.parse(readFileSync(join(REAL_REPO_ROOT, "runtime/data/admin-items.json"), "utf8"));
  const unlocks = listBuildingUnlockItems(REAL_REPO_ROOT);
  for (const [id, name] of Object.entries(expected)) {
    assert.equal(raw.filter((item) => item.id === id).length, 1, id);
    const item = unlocks.find((row) => row.itemId === id);
    assert.ok(item, id);
    assert.equal(item.name, name);
    assert.equal(item.category, "buildings");
    assert.equal(item.source, "BuildingSets");
    assert.equal(item.group, "Special & Promotional");
    assert.equal(item.experimental, false);
    assert.equal(item.entitlementControlled, true);
    assert.equal(item.requiredDlc, undefined);
    assert.equal(item.requiredSteamDlc, undefined);
    assert.equal(resolveCatalogItem(REAL_REPO_ROOT, { itemName: name }).itemId, id);
    assert.equal(listCatalogItems(REAL_REPO_ROOT, { q: id }).length, 0);
    assert.equal(buildingUnlockStatus(id, { owned: [id.replace(/_Patent$/, "")] }), "Owned");
    assert.equal(buildingUnlockStatus(id, { pending: [id] }), "Pending");
  }
});

test("building patent tokens are isolated while Developer Storage remains available to shared item selectors", () => {
  const root = fixtureRepo();
  assert.equal(listCatalogItems(root, { q: "lighting" }).length, 0);
  const sharedDeveloperStorage = listCatalogItems(root, { q: "developer storage" });
  assert.equal(sharedDeveloperStorage.length, 1);
  assert.equal(sharedDeveloperStorage[0].itemId, "Developer_Storage_Container_Patent");

  const unlocks = listBuildingUnlockItems(root);
  assert.equal(unlocks.length, 2);
  assert.equal(unlocks.find((row) => row.itemId === "BasicLighting_Patent")?.group, "Furniture & Decorations");
  assert.equal(unlocks.find((row) => row.itemId === "Developer_Storage_Container_Patent")?.experimental, true);
  assert.equal(buildingUnlockStatus("BasicLighting_Patent", { owned: ["BasicLighting"], pending: [] }), "Owned");
  assert.equal(buildingUnlockStatus("BasicLighting_Patent", { owned: [], pending: ["BasicLighting_Patent"] }), "Pending");
  assert.equal(buildingUnlockStatus("BasicLighting_Patent", { owned: [], pending: [] }), "Available");
  assert.equal(buildingUnlockStatus("BasicLighting_Patent", { owned: [], pending: [], supported: false }), "Unknown");
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

// The id becomes both a filesystem path and an <img src>. normalizeItem's id
// regex admits "." and "/", and baseInventory passes a raw template_id with no
// validation, so this is the only thing standing between a crafted id and a
// path outside the public directory.
test("item image ids cannot escape the images directory", () => {
  const root = fixtureRepo();
  mkdirSync(join(root, "console/web/public/images/items"), { recursive: true });
  // images/items sits five levels below the repo root, so this is the depth a
  // crafted id needs to land back on it. The file has to genuinely exist or the
  // assertion passes for the wrong reason -- an unreadable path and a rejected
  // one both come back unavailable.
  writeFileSync(join(root, "secret.png"), "");

  const unavailable = "/images/items/image-unavailable.png";
  for (const id of ["../../../../../secret", "..\\..\\..\\..\\..\\secret", "images/items/../../secret", "..", ".", "", "a/b"]) {
    const resolved = itemImagePath(root, id);
    assert.equal(resolved, unavailable, `id ${JSON.stringify(id)} must not resolve`);
    // Belt and braces: whatever comes back is also a URL, so it must never
    // carry path structure even if it did point at something real.
    assert.ok(!resolved.includes(".."), `id ${JSON.stringify(id)} leaked traversal into the URL`);
  }

  // The ordinary path is untouched.
  writeFileSync(join(root, "console/web/public/images/items/PlantFiber.png"), "");
  assert.equal(itemImagePath(root, "PlantFiber"), "/images/items/PlantFiber.png");
});

test("ranked physical schematics are distinguished from Grade 0 live grants", () => {
  const root = fixtureRepo();
  const schematic = resolveCatalogItem(root, { itemName: "Arhun K-28 Lasgun" });
  const normalItem = resolveCatalogItem(root, { itemName: "Plant Fiber" });
  assert.equal(itemIsRankedSchematic(schematic, 0), false);
  assert.equal(itemIsRankedSchematic(schematic, 5), true);
  assert.equal(itemIsRankedSchematic(normalItem, 5), false);
});

test("resolveFillableCatalogItem accepts refined resources", () => {
  const root = fixtureRepo();
  const item = resolveFillableCatalogItem(root, { itemId: "SteelBar" });
  assert.equal(item.group, "refined_resource");
  assert.equal(item.volume, 1.0);
});

test("resolveFillableCatalogItem accepts components", () => {
  const root = fixtureRepo();
  const item = resolveFillableCatalogItem(root, { itemId: "FremenComponent1" });
  assert.equal(item.group, "component");
});

test("resolveFillableCatalogItem accepts raw resources", () => {
  const root = fixtureRepo();
  const item = resolveFillableCatalogItem(root, { itemId: "AzuriteOre" });
  assert.equal(item.group, "raw_resource");
  assert.equal(item.volume, 0.2);
});

// Regression guard for the finding in resolveFillableCatalogItem's own
// comment (found during post-merge review of upstream PR #182, 2026-08-20:
// the comment previously claimed "today's 19 fillable items" -- stale, the
// real count is 99 once raw_resource was added to FILLABLE_GROUPS). The
// runtime safety check (throws on missing/zero volume) already covers this
// at request time, but this test catches a bad catalog edit at CI time
// instead of waiting for an operator to trip the runtime error -- and keeps
// the comment's "not currently triggerable" claim honest as the catalog
// grows.
test("every real, currently-fillable catalog item has a non-zero catalogued volume", () => {
  const items = JSON.parse(readFileSync(join(REAL_REPO_ROOT, "runtime/data/admin-items.json"), "utf8"));
  const missing = items
    .filter((item) => isFillableItem(item))
    .filter((item) => !(Number(item.volume) > 0))
    .map((item) => item.id);
  assert.deepEqual(missing, [],
    `${missing.length} fillable-group item(s) have no catalogued volume and would fail resolveFillableCatalogItem() at request time: ${missing.join(", ")}`);
});

test("resolveFillableCatalogItem rejects untagged/unfillable items", () => {
  const root = fixtureRepo();
  // CupOfWater deliberately carries no `group` in the fixture -- PlantFiber
  // is intentionally NOT used here since it is a real raw_resource in the
  // production catalog (see runtime/data/admin-items.json) and reusing it
  // as the "should be rejected" case would misleadingly suggest raw
  // resources are unfillable, which is no longer true.
  assert.throws(
    () => resolveFillableCatalogItem(root, { itemId: "CupOfWater" }),
    /Item type not allowed for fill/
  );
});

test("resolveFillableCatalogItem rejects unknown item ids", () => {
  const root = fixtureRepo();
  assert.throws(
    () => resolveFillableCatalogItem(root, { itemId: "NonExistentItem" }),
    /Item type not allowed for fill/
  );
});

// Found during code review (2026-08-19): every downstream volume-cap check
// (giveItemToBaseContainer/fillItemToBaseContainer/
// giveMultipleItemsToBaseContainer) treats itemVolume <= 0 as "not
// volume-tracked, skip the cap" -- correct for the standalone Storage tab's
// much broader catalog, but wrong for this narrower, fillable-only surface,
// where every real item is expected to carry real volume data. A catalog
// entry missing `volume` (or explicitly set to 0) must be rejected HERE,
// not silently allowed through to bypass a container's volume cap.
test("resolveFillableCatalogItem rejects a fillable-group item with no catalogued volume", () => {
  const root = fixtureRepo();
  const file = join(root, "runtime/data/admin-items.json");
  const rows = JSON.parse(readFileSync(file, "utf8"));
  rows.push({ id: "NoVolumeComponent", name: "No Volume Component", category: "resources", source: "Resources", group: "component" });
  writeFileSync(file, JSON.stringify(rows));
  assert.throws(
    () => resolveFillableCatalogItem(root, { itemId: "NoVolumeComponent" }),
    /missing catalogued volume data/
  );
});

test("resolveFillableCatalogItem rejects a fillable-group item with volume explicitly 0", () => {
  const root = fixtureRepo();
  const file = join(root, "runtime/data/admin-items.json");
  const rows = JSON.parse(readFileSync(file, "utf8"));
  rows.push({ id: "ZeroVolumeComponent", name: "Zero Volume Component", category: "resources", source: "Resources", group: "component", volume: 0 });
  writeFileSync(file, JSON.stringify(rows));
  assert.throws(
    () => resolveFillableCatalogItem(root, { itemId: "ZeroVolumeComponent" }),
    /missing catalogued volume data/
  );
});

test("resolveItemVolume returns volume for catalogued items", () => {
  const root = fixtureRepo();
  assert.equal(resolveItemVolume(root, "SteelBar"), 1.0);
  assert.equal(resolveItemVolume(root, "PlantFiber"), 0);
});

test("resolveItemVolume returns 0 for unknown templates", () => {
  const root = fixtureRepo();
  assert.equal(resolveItemVolume(root, "NonExistent"), 0);
});

test("resolveItemStackSize returns the catalogued per-item max stack size", () => {
  const root = fixtureRepo();
  assert.equal(resolveItemStackSize(root, "SteelBar"), 500);
  assert.equal(resolveItemStackSize(root, "PlantFiber"), 0);
  assert.equal(resolveItemStackSize(root, "NonExistent"), 0);
});

// L2 audit (Security hat): only a real positive-integer number counts as
// curated stack data -- a string "500", a boolean, a float, or a negative
// value must be rejected outright rather than silently coerced (true would
// otherwise coerce to a max stack of 1 and shred every give into 1-unit
// rows).
test("resolveItemStackSize rejects non-integer-number stackSize values instead of coercing them", () => {
  const root = mkdtempSync(join(tmpdir(), "web-admin-catalog-strict-"));
  mkdirSync(join(root, "runtime/data"), { recursive: true });
  writeFileSync(join(root, "runtime/data/admin-items.json"), JSON.stringify([
    { id: "StringStack", name: "String Stack", category: "resources", source: "Resources", stackSize: "500" },
    { id: "BoolStack", name: "Bool Stack", category: "resources", source: "Resources", stackSize: true },
    { id: "FloatStack", name: "Float Stack", category: "resources", source: "Resources", stackSize: 0.5 },
    { id: "NegativeStack", name: "Negative Stack", category: "resources", source: "Resources", stackSize: -5 }
  ]));
  assert.equal(resolveItemStackSize(root, "StringStack"), 0);
  assert.equal(resolveItemStackSize(root, "BoolStack"), 0);
  assert.equal(resolveItemStackSize(root, "FloatStack"), 0);
  assert.equal(resolveItemStackSize(root, "NegativeStack"), 0);
  assert.equal(resolveCatalogItem(root, { itemId: "StringStack" }).stackSize, undefined);
  assert.equal(resolveCatalogItem(root, { itemId: "BoolStack" }).stackSize, undefined);
});

test("resolveCatalogItem passes stackSize through for catalogued items", () => {
  const root = fixtureRepo();
  assert.equal(resolveCatalogItem(root, { itemId: "SteelBar" }).stackSize, 500);
  assert.equal(resolveCatalogItem(root, { itemId: "PlantFiber" }).stackSize, undefined);
});

// Seeded-value provenance, externally re-verified 2026-08-20 against
// dune.gaming.tools's own item data feed (cdn-hosted.gaming.tools/dune/data,
// the maxStackSize field, not just the rendered page) after an operator
// challenge: MelangeSpice 500 and both lubricants 100 were already correct.
// Oil and SpicedFuelCell were WRONG at 499 -- GENERATOR_TYPES' refill
// "stackSize" is a refill-policy value (possibly a deliberate margin below
// the true cap), not the engine's real per-item limit; the external source
// confirms the true limit for both is 500, matching addonSeedJob.js's
// pre-existing value (see issue #432, which tracked this exact
// contradiction before it was externally resolved).
test("real catalog carries the verified stack sizes for the seeded items", () => {
  assert.equal(resolveItemStackSize(REAL_REPO_ROOT, "MelangeSpice"), 500);
  assert.equal(resolveItemStackSize(REAL_REPO_ROOT, "Oil"), 500);
  assert.equal(resolveItemStackSize(REAL_REPO_ROOT, "SpicedFuelCell"), 500);
  assert.equal(resolveItemStackSize(REAL_REPO_ROOT, "WindTurbineLubricant1"), 100);
  assert.equal(resolveItemStackSize(REAL_REPO_ROOT, "WindTurbineLubricant2"), 100);
});

// T2MuaddibComponent ("Muad'Dib Corpse" -- Muad'Dib is Fremen for kangaroo
// mouse) is a corpse-type item and doesn't stack, matching the same pattern
// as Mouse_Corpse/Corpse (both externally confirmed stackSize 1, see #431's
// stack-size/resource-type correlation analysis). Operator-stated from the
// live game (2026-08-20, issue #441) after the item 404'd against the
// external source used to verify the rest of this catalog.
test("real catalog carries the verified stack size for T2MuaddibComponent", () => {
  assert.equal(resolveItemStackSize(REAL_REPO_ROOT, "T2MuaddibComponent"), 1);
});

// Bulk curation (2026-08-20, issue #431): all 91 remaining externally
// resolvable raw_resource/refined_resource/component items, seeded from
// dune.gaming.tools's maxStackSize field the same way the original five
// were. One spot-check per outlier bucket the correlation analysis found
// (base-inventory.md's curation note), plus one ordinary 500-default item
// per group -- not all 91, to keep this test a drift sentinel rather than a
// second copy of the data file.
test("bulk-curated catalog carries the verified stack size for a representative item per bucket", () => {
  // 500 default, one per group
  assert.equal(resolveItemStackSize(REAL_REPO_ROOT, "AzuriteOre"), 500); // raw_resource
  assert.equal(resolveItemStackSize(REAL_REPO_ROOT, "SteelBar"), 500); // refined_resource
  assert.equal(resolveItemStackSize(REAL_REPO_ROOT, "FremenComponent1"), 500); // component
  // Outliers
  assert.equal(resolveItemStackSize(REAL_REPO_ROOT, "Mouse_Corpse"), 1);
  assert.equal(resolveItemStackSize(REAL_REPO_ROOT, "Corpse"), 1);
  assert.equal(resolveItemStackSize(REAL_REPO_ROOT, "FuelCanister"), 1);
  assert.equal(resolveItemStackSize(REAL_REPO_ROOT, "WindTrapFilter1"), 5);
  assert.equal(resolveItemStackSize(REAL_REPO_ROOT, "FlourSand"), 1000);
  assert.equal(resolveItemStackSize(REAL_REPO_ROOT, "SpiceResidue"), 1000);
  assert.equal(resolveItemStackSize(REAL_REPO_ROOT, "SpiceSand"), 2500);
});

// Coverage sentinel: every raw_resource/refined_resource/component item
// must now carry a curated stackSize EXCEPT the two still awaiting live-game
// verification (issue #441). Catches a future catalog edit silently
// dropping a curated value, or a new item added to these groups without
// stackSize curation being remembered.
test("every fillable-group item has a curated stackSize except the two still under verification", () => {
  const items = JSON.parse(readFileSync(join(REAL_REPO_ROOT, "runtime/data/admin-items.json"), "utf8"));
  const stillUnverified = new Set(["T4ShieldWallComponent", "ExperimentalWindTurbineComponent"]);
  const missing = items
    .filter((item) => ["raw_resource", "refined_resource", "component"].includes(item.group))
    .filter((item) => !stillUnverified.has(item.id))
    .filter((item) => !(Number.isInteger(item.stackSize) && item.stackSize > 0))
    .map((item) => item.id);
  assert.deepEqual(missing, []);
});

// Volume placeholder correction (issue #440, 2026-08-20): every
// refined_resource/component item's `volume` was stuck at exactly 1.0, a
// value that was never actually measured (raw_resource items, individually
// measured from the start, all independently agreed with the same external
// source used here -- 19/19 exact matches including fractional values like
// 0.08 and 0.4, which is the corroboration that made trusting this source
// for volume, not just stackSize, reasonable). Spot-check one item per
// distinct corrected value.
test("real catalog carries corrected volumes for previously-placeholder refined/component items", () => {
  assert.equal(resolveItemVolume(REAL_REPO_ROOT, "SteelBar"), 0.5);
  assert.equal(resolveItemVolume(REAL_REPO_ROOT, "CopperBar"), 0.25);
  assert.equal(resolveItemVolume(REAL_REPO_ROOT, "IronBar"), 0.4);
  assert.equal(resolveItemVolume(REAL_REPO_ROOT, "AluminiumBar"), 0.7);
  assert.equal(resolveItemVolume(REAL_REPO_ROOT, "DuraluminumRod"), 0.9);
  assert.equal(resolveItemVolume(REAL_REPO_ROOT, "T6RefinedResourceB"), 0.6);
  assert.equal(resolveItemVolume(REAL_REPO_ROOT, "FremenComponent1"), 0.1);
  assert.equal(resolveItemVolume(REAL_REPO_ROOT, "SpicedFuelCell"), 0.2);
  assert.equal(resolveItemVolume(REAL_REPO_ROOT, "Plastone"), 0.2);
  assert.equal(resolveItemVolume(REAL_REPO_ROOT, "FuelCanister"), 2);
  assert.equal(resolveItemVolume(REAL_REPO_ROOT, "FuelCanister_Medium"), 3.3333333);
  assert.equal(resolveItemVolume(REAL_REPO_ROOT, "FuelCanister_Large"), 5);
  // T6RefinedResourceA (Plastanium Ingot) is the one item genuinely at 1.0
  // -- confirmed correct, not a placeholder (see #430's original spot check).
  assert.equal(resolveItemVolume(REAL_REPO_ROOT, "T6RefinedResourceA"), 1.0);
});

// Coverage sentinel: no raw_resource/refined_resource/component item may
// carry the old 1.0 placeholder except the one confirmed-genuine exception.
// Catches a future catalog edit reintroducing the never-measured default.
test("no fillable-group item still carries the 1.0 volume placeholder, except confirmed-genuine or still-unresolved items", () => {
  const items = JSON.parse(readFileSync(join(REAL_REPO_ROOT, "runtime/data/admin-items.json"), "utf8"));
  // T6RefinedResourceA is genuinely 1.0 (confirmed, not a placeholder). The
  // other three never got external volume data at all (404'd -- see #441,
  // closed without further pursuit) and are correctly untouched.
  const excluded = new Set(["T6RefinedResourceA", "T2MuaddibComponent", "T4ShieldWallComponent", "ExperimentalWindTurbineComponent"]);
  const stillPlaceholder = items
    .filter((item) => ["raw_resource", "refined_resource", "component"].includes(item.group))
    .filter((item) => !excluded.has(item.id))
    .filter((item) => Number(item.volume) === 1.0)
    .map((item) => item.id);
  assert.deepEqual(stillPlaceholder, []);
});
