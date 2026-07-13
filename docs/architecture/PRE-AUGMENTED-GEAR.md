# Pre-Augmented Gear — API Reference

**Status:** Implemented in main | **Last Updated:** July 2026

---

## 1. Overview

The admin console supports augmenting weapons and armor through two API paths:

1. **Apply to existing item** — `POST /api/players/:id/augment-item`
2. **Pre-augmented grant** — `POST /api/players/:id/give-item` with `augments`

Both write to `dune.items.stats` under `FAugmentedItemStats`. The player must
be **offline**; a relog is required for the game to process the changes.

**Slot limits**: Weapons can hold up to 3 augments (requires 3 Crafting specialization keystones).
Clothing/armor can hold up to 2 augments (requires 2 Crafting specialization keystones).

---

## 2. FAugmentedItemStats Format

The stats JSONB uses **parallel arrays**, not keyed objects:

```json
{
  "FAugmentedItemStats": [
    [],
    {
      "AppliedAugments": [
        { "Name": "Augment_Damage1" },
        { "Name": "Augment_Melee1" }
      ],
      "AppliedAugmentQualities": [5, 3],
      "AppliedAugmentRollData": [
        [1.0],
        [0.85]
      ]
    }
  ]
}
```

- `AppliedAugments` — array of `{ "Name": "<templateId>" }` objects
- `AppliedAugmentQualities` — parallel array of quality levels (same index)
- `AppliedAugmentRollData` — parallel array of roll value arrays

The full `dune.items.stats` structure includes these alongside `FCustomizationStats`
and `FItemStackAndDurabilityStats`:

```json
{
  "FCustomizationStats": [[], {}],
  "FAugmentedItemStats": [[], {
    "AppliedAugments": [{ "Name": "Augment_Damage1" }],
    "AppliedAugmentQualities": [5],
    "AppliedAugmentRollData": [[1.0]]
  }],
  "FItemStackAndDurabilityStats": [[], {
    "CurrentDurability": 500,
    "MaxDurability": 500,
    "DecayedMaxDurability": 0
  }]
}
```

---

## 3. API Paths

### Apply to Existing Item

```
POST /api/players/:id/augment-item
Body: { itemId: 123, augments: ["Augment_Damage1"], augmentQuality: 5 }
```

**Flow:**
1. Validates augment IDs and quality level
2. Resolves player, requires offline
3. Locks item row `for update` — validates ownership
4. Extracts existing augments, deduplicates (max 20)
5. `validateAugmentsForTemplate()` — tag-based compatibility
6. `ensureAugmentSlotKeystones()` — auto-purchases Crafting spec keystones
7. `loadAugmentRollPayloads()` — best roll data from existing inventory items
8. `buildAugmentedItemStats()` — generates `FAugmentedItemStats`
9. Updates `dune.items.stats`, resets `is_new` flag

**Returns:** `{ ok, itemId, templateId, augments, augmentQuality, previous, slotUnlocks }`

### Pre-Augmented Grant

```
POST /api/players/:id/give-item
Body: { templateId: "AtreLMG5", quality: 5, augments: ["Augment_Lmg1"], augmentQuality: 1 }
```

**Flow:**
1. `itemRequiresDatabaseGrant()` — true when `augments.length > 0`
2. `buildItemStats()` — includes `FAugmentedItemStats` (skips roll payloads for grants)
3. `giveItemToPlayer()` — writes to `dune.items` directly (offline path)
4. If player was online, warn that a relog is required

**Differs from apply** in that it creates a NEW item, uses default roll values `[1.0]`,
and does not auto-purchase specialization keystones.

---

## 4. Key Functions

### `buildAugmentedItemStats(augmentIds, rollPayloads)`

Generates the `FAugmentedItemStats` JSON with parallel arrays:
```js
return [[], {
  AppliedAugments: augmentIds.map((id) => ({ Name: id })),
  AppliedAugmentQualities: augmentIds.map((id) => rollPayloads.get(id).quality),
  AppliedAugmentRollData: augmentIds.map((id) => rollPayloads.get(id).rollData)
}];
```

### `augmentAllowedForTemplate(templateId, augmentId)`

Tag-based compatibility check. Loads augment tags from `runtime/data/augment-compatibility.json`,
compares against item tags inferred from the template ID.

### `augmentSlotKeystoneIdsForTemplate(templateId)`

Returns the Crafting specialization keystone IDs needed for augment slots:
- **Clothing**: `[42, 43]` — 2 slots max
- **Melee weapons**: `[44, 45, 46]` — 3 slots max
- **Ranged weapons**: `[47, 48, 49]` — 3 slots max
- **Dual-type**: all 6 keystones

### `ensureAugmentSlotKeystones(tx, player, templateId, augmentIds)`

Auto-purchases missing specialization keystones via `purchased_specialization_keystones`.
Also inserts a baseline Crafting track entry in `specialization_tracks` if needed.

### `loadAugmentRollPayloads(tx, augmentIds, qualityOverride, { sourceTemplateId, excludeItemId })`

Loads best roll data from existing items in the player's inventory. Prefers items
matching the source template. Falls back to perfect rolls (`[1.0]`) if none found.

### `augmentRollCount(augmentId)`

Returns the number of stat rolls for a given augment (hardcoded lookup).

### `validateAugmentsForTemplate(templateId, augmentIds)`

Validates all augments are compatible with the item template via `augmentAllowedForTemplate`.

### `buildItemStats({ templateId, augments, durability, rollPayloads })`

Builds the full `dune.items.stats` JSONB. If augments are present, adds `FAugmentedItemStats`.
Used by the pre-augmented grant flow.

### `extractAugmentIdsFromStats(stats)`

Extracts existing augment IDs from `FAugmentedItemStats.AppliedAugments`.

---

## 5. Augment Compatibility

Augment compatibility is tag-based, loaded from `runtime/data/augment-compatibility.json`:

```json
{
  "augments": {
    "Augment_Damage1": { "tags": ["RangedWeapons", "MeleeWeapons"] },
    "Augment_Armor1":  { "tags": ["Clothing"] }
  }
}
```

Item tags are inferred from the template ID via `inferredAugmentItemTags()`:
- `MeleeWeapons` — knife, sword, axe, mace, hammer, spear, kindjal, etc.
- `RangedWeapons` — pistol, rifle, shotgun, bow, crossbow, sniper, etc.
- `Clothing` — armor, stillsuit, combat gear

An augment is compatible only if **all** its tags match the item's tags.
`Ch5_` prefix is stripped from template IDs before matching.

---

## 6. Constraints

| Constraint | Detail |
|-----------|--------|
| **Offline required** | Both apply and grant require the player to be offline |
| **Relog required** | Game processes augment data on next login |
| **Weapon slots** | Up to 3 augments (requires Crafting keystones 44-46 or 47-49) |
| **Clothing slots** | Up to 2 augments (requires Crafting keystones 42-43) |
| **Max per call** | 20 augments (truncated via `.slice(0, 20)`) |
| **Ownership** | Item must be in player's directly-owned inventory |
| **Compatibility** | Tag-based from `augment-compatibility.json` |
| **Roll inheritance** | Apply flow inherits best rolls from existing matching items |

---

## 7. Files

| File | Purpose |
|------|---------|
| `console/api/src/duneDb.js` | All augment functions (26 total) |
| `runtime/data/augment-compatibility.json` | Augment-to-tag mapping |
| `console/web/src/lib/augmentEligibility.ts` | Frontend compatibility matching |
| `console/web/src/components/common/AugmentDropdown.tsx` | Augment picker UI |
| `console/api/test/pre-augmented-gear-regression.test.js` | Regression tests |

---

## 8. Testing

```bash
cd console/api
node --test test/pre-augmented-gear-regression.test.js
```
