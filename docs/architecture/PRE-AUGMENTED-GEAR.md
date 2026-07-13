# Pre-Augmented Gear — Architecture & Implementation Guide

**Status:** Implemented in main | **Last Updated:** July 2026

---

## 1. Overview

The admin console supports applying augments to weapons and armor via the database
path. Augments provide stat bonuses and are stored in `dune.items.stats` under
`FAugmentedItemStats`. Items can receive augments in two ways:

1. **Live apply** — `POST /api/players/:id/augment-item` updates an existing item's stats
2. **Pre-augmented grant** — `POST /api/players/:id/give-item` with `augments` in the body

Both paths require the player to be **offline** (database-only write).
A relog is required after the grant for the game to process the changes.

---

## 2. Key Functions (in `duneDb.js`)

### `augmentInventoryItem(db, playerId, itemId, { augments, augmentQuality })`

Applies augments to an existing inventory item via DB transaction.

**Flow:**
1. Validates augment IDs and quality level
2. Resolves player mutation target, requires offline
3. Locks item row `for update`, validates ownership
4. Extracts existing augments, deduplicates with new ones (max 20)
5. `validateAugmentsForTemplate()` — tag-based compatibility check
6. `ensureAugmentSlotKeystones()` — auto-purchases spec keystones if missing
7. `loadAugmentRollPayloads()` — pulls best roll data from existing items
8. `buildAugmentedItemStats()` — generates FAugmentedItemStats JSON
9. Updates `dune.items.stats` and resets `is_new` flag

**Returns:** `{ ok, itemId, templateId, augments, augmentQuality, previous, slotUnlocks }`

### `buildItemStats({ templateId, augments, durability, rollPayloads })`

Builds a complete item stats JSONB object including augment data.

**Flow:**
1. Normalizes durability stats (`CurrentDurability`, `MaxDurability`)
2. Calls `normalizeAugmentableBaseStats()` for base structure
3. If augments exist, calls `buildAugmentedItemStats()`

### `augmentAllowedForTemplate(templateId, augmentId)`

Tag-based compatibility check. Loads augment tags from `runtime/data/augment-compatibility.json`
and compares against inferred item tags (weapon type, armor slot, etc.).

**Returns:** `true` if the augment's tags match the item's tags.

### `augmentSlotKeystoneIdsForTemplate(templateId)`

Returns the specialization keystone IDs required for augment slots:
- **Clothing**: `[42, 43]` (ArmoirAugmentSlots10, 42)
- **Melee weapons**: `[44, 45, 46]` (MeleeWeaponAugmentSlots3, 32, 88)
- **Ranged weapons**: `[47, 48, 49]` (RangedWeaponAugmentSlots1, 33, 87)
- **Dual-type weapons**: all 6 keystones

### `ensureAugmentSlotKeystones(tx, player, templateId, augmentIds)`

Auto-purchases the specialization keystones needed for augment slots if the
player doesn't already have them. Inserts rows into `dune.purchased_specialization_keystones`.

### `loadAugmentRollPayloads(tx, augmentIds, qualityOverride, { sourceTemplateId, excludeItemId })`

Loads the best roll data for each augment from existing items in the player's
inventory. Prefers items with matching source template. Falls back to perfect
rolls (`[1.0]`) if no existing data found.

### `buildAugmentedItemStats(augmentIds, rollPayloads)`

Generates the `FAugmentedItemStats` JSONB structure:
```json
{
  "AppliedAugments": [
    { "TemplateId": "Augment_Damage1", "QualityLevel": 5 }
  ],
  "AppliedAugmentRollData": {
    "Augment_Damage1": [1.0]
  },
  "AppliedAugmentQualities": {
    "Augment_Damage1": 5
  }
}
```

### `extractAugmentIdsFromStats(stats)`

Extracts augment template IDs from existing `FAugmentedItemStats`.

### `augmentRollCount(augmentId)`

Returns the number of stat rolls for a given augment template (hardcoded lookup).

---

## 3. Augment Compatibility (Tag-Based)

Augment compatibility is determined by matching **item tags** against **augment tags**.
Tags are loaded from `runtime/data/augment-compatibility.json` at startup.

**Item tags** are inferred from the template ID:
- `MeleeWeapons` — template contains melee weapon patterns
- `RangedWeapons` — template contains ranged weapon patterns
- `Clothing` — template contains armor/clothing patterns
- `Ch5_` prefix stripping for unique item templates

**Augment tags** are defined in the compatibility catalog. An augment is compatible
if ALL of its tags match the item's tags.

### `augmentCompatibilityCatalog()`

Loads and caches `runtime/data/augment-compatibility.json`. Returns:
```json
{
  "augments": {
    "Augment_Damage1": { "tags": ["RangedWeapons", "MeleeWeapons"] },
    "Augment_Armor1": { "tags": ["Clothing"] }
  }
}
```

### `inferredAugmentItemTags(templateId)`

Returns item tags based on template ID pattern matching. Handles:
- Weapon type detection (melee vs ranged)
- Ch5_ prefix stripping
- Armor/clothing identification

---

## 4. Grant Flow

### Live Apply (`/api/players/:id/augment-item`)

```
POST { itemId: 123, augments: ["Augment_Damage1", "Augment_Melee1"], augmentQuality: 5 }

→ validateAugmentIds() — deduplicate, normalize
→ requireOfflinePlayer() — must be offline
→ tx: select item for update (ownership check)
→ validateAugmentsForTemplate() — tag matching
→ ensureAugmentSlotKeystones() — auto-buy spec keystones
→ loadAugmentRollPayloads() — best rolls from inventory
→ buildAugmentedItemStats() — generate JSONB
→ update dune.items.stats
```

### Pre-Augmented Grant (`/api/players/:id/give-item`)

```
POST { templateId: "AtreLMG5", quality: 5, augments: ["Augment_Lmg1"], augmentQuality: 1 }

→ itemRequiresDatabaseGrant() — true if augments present
→ buildItemStats() — includes FAugmentedItemStats
→ giveItemToPlayer() — writes to dune.items
```

---

## 5. Stats JSON Structure

```json
{
  "FCustomizationStats": [[], {}],
  "FAugmentedItemStats": [[], {
    "AppliedAugments": [
      { "TemplateId": "Augment_Damage1", "QualityLevel": 5 }
    ],
    "AppliedAugmentRollData": {
      "Augment_Damage1": [1.0]
    },
    "AppliedAugmentQualities": {
      "Augment_Damage1": 5
    }
  }],
  "FItemStackAndDurabilityStats": [[], {
    "CurrentDurability": 500,
    "MaxDurability": 500,
    "DecayedMaxDurability": 0
  }]
}
```

---

## 6. Constraints

| Constraint | Detail |
|-----------|--------|
| **Offline only** | `requireOfflinePlayer()` — DB writes during online play are rejected |
| **Relog required** | Game processes augment data on next login |
| **Max augments** | 20 (truncated via `.slice(0, 20)`) |
| **Ownership** | Item must be in player's directly-owned inventory (`inventory_type = 0`) |
| **Compatibility** | Tag-based: augment tags must match item tags |
| **Slot keystones** | Auto-purchased via specialization tracks if missing |
| **Roll inheritance** | Best rolls from existing matching items in inventory |

---

## 7. Relevant Files

| File | Purpose |
|------|---------|
| `console/api/src/duneDb.js` | All 26 augment functions |
| `runtime/data/augment-compatibility.json` | Augment-to-tag mapping |
| `console/web/src/lib/augmentEligibility.ts` | Frontend compatibility matching |
| `console/web/src/components/common/AugmentDropdown.tsx` | Augment picker UI |
| `console/web/src/features/players/CharacterAdminUI.tsx` | "+A" button integration |
| `console/web/src/features/carePackage/CarePackagePanel.tsx` | Care Package augment selection |
| `console/api/test/pre-augmented-gear-regression.test.js` | Regression test suite |

---

## 8. Testing

```bash
cd console/api
node --test test/pre-augmented-gear-regression.test.js
```

Tests cover: stats generation, augmentability checks, weapon type detection,
compatibility filtering, roll counts, apply validation, care package grant,
live apply, and regression tests for previously fixed bugs.
