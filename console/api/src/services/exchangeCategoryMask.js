// CHOAM exchange category_mask / category_depth encoding.
//
// Funcom packs four 8-bit menu indexes into category_mask:
//   bits 24-31  depth 1  GARMENTS=0 WEAPONS=1 VEHICLES=2 UTILITY=3 AUGMENTATIONS=4 MISC=5
//   bits 16-23  depth 2
//   bits  8-15  depth 3
//   bits  0-7   unused (always 0)
//
// dune.get_exchange_orders_by_mask(in_mask, in_depth) matches by prefix:
//   shift = (4 - in_depth) * 8
//   category_depth >= in_depth AND (category_mask >> shift) = (in_mask >> shift)
// so a folder listing is every row whose mask shares the folder's leading bytes.
//
// Weapons tab depth-2 folders, confirmed from Icehunter/dune-admin unique-
// schematic menu screenshots and DASH (snapetech/DuneAwakeningSelfHost) GUI
// category assets:
//   0 Melee Weapons
//   1 Ranged Weapons
//   2 Ammunition
//   3 Unique Schematics
//
// Icehunter/EDA CategoryMask() remaps melee under folder 0 at depth 3
// (short blades / long blades) but leaves each ranged type as a depth-2
// sibling: pistol=2 … lasgun=13, ammunition=14. That is the same type-code
// order Unique Schematics uses at depth 3. The in-game Weapons tab does not
// list those types at depth 2, so:
//   - Maula pistols (pistol=2) land in Ammunition, the only "ranged" family
//     sitting at depth-2 code 2, and are the only items in that folder;
//   - every other gun is invisible when browsing Ranged Weapons (depth-2
//     code 1 is empty);
//   - heavy pistols at depth-2 code 3 leak into Unique Schematics.
// Icehunter later treated those static maps as guesses and learned true
// masks from player listings (dune-admin#295). This console seeds from a
// frozen EDA plan, so it has to correct the maps itself.
//
// Nested ranged weapons reuse those unique-schematic type codes as depth-3
// indexes under Ranged Weapons (DASH observed weapons/ranged as 0x01010700).
// Ammunition guessed at code 14 moves to folder 2.
//
// Vehicles tab depth-2 folders, same Icehunter/DASH sources:
//   0 One-Man Groundcar (Sandbike and Treadwheel)
//   1 Buggy
//   2 Light Ornithopter
//   3 Medium Ornithopter
//   4 Carry-all
//   5 Sandcrawler
//   6 Unique Schematics
//
// Icehunter item-data has no items/vehicles/treadwheel path, so Lost Harvest
// Treadwheel parts were filed under sandcrawler (d2=5) using the same depth-3
// slots sandbike uses (chassis=0, hull=1, engine=2, psu=3, locomotion=4,
// utility=5). Unique Treadwheel schematics used sandcrawler's unique slot
// (d3=5 under folder 6). Funcom's CHOAM Vehicles tab puts Treadwheel with
// Sandbike under One-Man Groundcar, so those parts currently appear in
// Sandcrawler. Remap by template_id prefix Treadwheel only: physical
// equippables d2 5→0; unique schematics d3 5→0. Real Sandcrawler* rows stay.

export const WEAPONS_TOP_LEVEL = 1;
export const WEAPONS_MELEE = 0;
export const WEAPONS_RANGED = 1;
export const WEAPONS_AMMUNITION = 2;
export const WEAPONS_UNIQUE_SCHEMATICS = 3;

export const RANGED_TYPE_PISTOL = 2;
export const RANGED_TYPE_LAST = 13;
export const GUESSED_AMMUNITION_CODE = 14;

export const WEAPONS_RANGED_FOLDER_MASK = (WEAPONS_TOP_LEVEL << 24) | (WEAPONS_RANGED << 16);
export const WEAPONS_AMMUNITION_MASK = (WEAPONS_TOP_LEVEL << 24) | (WEAPONS_AMMUNITION << 16);
export const WEAPONS_UNIQUE_SCHEMATICS_MASK = (WEAPONS_TOP_LEVEL << 24) | (WEAPONS_UNIQUE_SCHEMATICS << 16);

export const VEHICLES_TOP_LEVEL = 2;
export const VEHICLES_ONE_MAN = 0;
export const VEHICLES_SANDCRAWLER = 5;
export const VEHICLES_UNIQUE_SCHEMATICS = 6;

export const VEHICLES_ONE_MAN_FOLDER_MASK = (VEHICLES_TOP_LEVEL << 24) | (VEHICLES_ONE_MAN << 16);
export const VEHICLES_SANDCRAWLER_FOLDER_MASK = (VEHICLES_TOP_LEVEL << 24) | (VEHICLES_SANDCRAWLER << 16);
export const VEHICLES_UNIQUE_SCHEMATICS_MASK = (VEHICLES_TOP_LEVEL << 24) | (VEHICLES_UNIQUE_SCHEMATICS << 16);

export function isTreadwheelTemplate(templateId) {
  return /^Treadwheel/i.test(String(templateId || "").trim());
}

function toUnsignedMask(value) {
  return Math.trunc(Number(value) || 0) >>> 0;
}

export function decodeExchangeCategoryMask(mask) {
  const value = toUnsignedMask(mask);
  return {
    depth1: (value >>> 24) & 0xff,
    depth2: (value >>> 16) & 0xff,
    depth3: (value >>> 8) & 0xff,
    depth4: value & 0xff
  };
}

export function packExchangeCategoryMask(depth1 = 0, depth2 = 0, depth3 = 0, depth4 = 0) {
  return ((depth1 & 0xff) << 24) | ((depth2 & 0xff) << 16) | ((depth3 & 0xff) << 8) | (depth4 & 0xff);
}

// Same predicate Funcom uses in dune.get_exchange_orders_by_mask.
export function exchangeMaskMatches(orderMask, orderDepth, filterMask, filterDepth) {
  const depth = Math.trunc(Number(filterDepth) || 0);
  if (Math.trunc(Number(orderDepth) || 0) < depth) return false;
  const shift = (4 - depth) * 8;
  return (toUnsignedMask(orderMask) >>> shift) === (toUnsignedMask(filterMask) >>> shift);
}

function normalizeTreadwheelVehicleCategory(decoded, mask, depth, itemKind, templateId) {
  if (!isTreadwheelTemplate(templateId)) {
    return { categoryMask: mask, categoryDepth: depth };
  }

  // Physical parts were filed under Sandcrawler. Keep the depth-3 slot.
  if (itemKind === "equippable" && decoded.depth2 === VEHICLES_SANDCRAWLER) {
    return {
      categoryMask: packExchangeCategoryMask(VEHICLES_TOP_LEVEL, VEHICLES_ONE_MAN, decoded.depth3, decoded.depth4),
      categoryDepth: depth
    };
  }

  // Unique schematics use Vehicles d2=6; Icehunter used sandcrawler's d3=5.
  if (
    itemKind === "schematic"
    && decoded.depth2 === VEHICLES_UNIQUE_SCHEMATICS
    && decoded.depth3 === VEHICLES_SANDCRAWLER
  ) {
    return {
      categoryMask: packExchangeCategoryMask(VEHICLES_TOP_LEVEL, VEHICLES_UNIQUE_SCHEMATICS, VEHICLES_ONE_MAN),
      categoryDepth: depth
    };
  }

  return { categoryMask: mask, categoryDepth: depth };
}

export function normalizeExchangeCategory({ categoryMask, categoryDepth, kind, templateId } = {}) {
  const mask = toUnsignedMask(categoryMask);
  const depth = Math.trunc(Number(categoryDepth) || 0);
  const decoded = decodeExchangeCategoryMask(mask);
  const itemKind = String(kind || "").toLowerCase();

  if (decoded.depth1 === VEHICLES_TOP_LEVEL) {
    return normalizeTreadwheelVehicleCategory(decoded, mask, depth, itemKind, templateId);
  }

  if (decoded.depth1 !== WEAPONS_TOP_LEVEL) {
    return { categoryMask: mask, categoryDepth: depth };
  }

  if (itemKind === "ammunition" || (depth === 2 && decoded.depth2 === GUESSED_AMMUNITION_CODE && decoded.depth3 === 0)) {
    return { categoryMask: WEAPONS_AMMUNITION_MASK, categoryDepth: 2 };
  }

  // Unique schematics and already-nested melee/ranged rows stay put.
  if (depth >= 3) return { categoryMask: mask, categoryDepth: depth };

  // Physical guns only. Unique Schematics is Weapons depth-2 code 3
  // (0x01030000); remapping every code 2–13 would pull a custom schematic
  // out of that folder into Ranged Weapons subtype 3.
  if (
    itemKind === "equippable"
    && depth === 2
    && decoded.depth3 === 0
    && decoded.depth2 >= RANGED_TYPE_PISTOL
    && decoded.depth2 <= RANGED_TYPE_LAST
  ) {
    return {
      categoryMask: packExchangeCategoryMask(WEAPONS_TOP_LEVEL, WEAPONS_RANGED, decoded.depth2),
      categoryDepth: 3
    };
  }

  return { categoryMask: mask, categoryDepth: depth };
}

export function applyExchangeCategoryToSeedRow(row) {
  if (!row || typeof row !== "object") return row;
  const hasSnake = Object.prototype.hasOwnProperty.call(row, "category_mask")
    || Object.prototype.hasOwnProperty.call(row, "category_depth");
  const normalized = normalizeExchangeCategory({
    categoryMask: row.category_mask ?? row.categoryMask,
    categoryDepth: row.category_depth ?? row.categoryDepth,
    kind: row.kind,
    templateId: row.template_id ?? row.templateId
  });
  if (hasSnake) {
    return { ...row, category_mask: normalized.categoryMask, category_depth: normalized.categoryDepth };
  }
  return { ...row, categoryMask: normalized.categoryMask, categoryDepth: normalized.categoryDepth };
}
