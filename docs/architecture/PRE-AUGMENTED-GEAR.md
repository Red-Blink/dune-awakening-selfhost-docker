# Pre-Augmented Gear — API Reference

**Status:** Implemented in main | **Last Updated:** July 2026

---

## 1. Overview

The admin console supports augmenting weapons and armor through two endpoints:

1. **Apply to existing item** — `POST /api/players/:id/augment-item`
2. **Pre-augmented grant** — `POST /api/players/:id/give-item` with `augments`

Both write to `dune.items.stats` under `FAugmentedItemStats`. The player must be
**offline**; the API rejects online players. A relog is required after grant.

**Slot limits enforced by specialization keystones:**
- **Weapons**: up to 3 augments (Crafting keystones 44-49)
- **Clothing/armor**: up to 2 augments (Crafting keystones 42-43)

The code internally caps at 20 augments per call as a defensive bound, but the
effective limit is enforced by the keystone check.

---

## 2. FAugmentedItemStats Format

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
        { "StatRolls": [1.0], "AppliedEffectIndices": [] },
        { "StatRolls": [0.85, 0.92], "AppliedEffectIndices": [0] }
      ]
    }
  ]
}
```

- **AppliedAugments** — array of `{ "Name": "<templateId>" }` objects
- **AppliedAugmentQualities** — parallel array of quality levels (same index)
- **AppliedAugmentRollData** — parallel array of `{ StatRolls, AppliedEffectIndices }` objects

Complete stats JSON:
```json
{
  "FCustomizationStats": [[], {}],
  "FAugmentedItemStats": [[], {
    "AppliedAugments": [{ "Name": "Augment_Damage1" }],
    "AppliedAugmentQualities": [5],
    "AppliedAugmentRollData": [{ "StatRolls": [1.0], "AppliedEffectIndices": [] }]
  }],
  "FItemStackAndDurabilityStats": [[], {
    "CurrentDurability": 500,
    "MaxDurability": 500,
    "DecayedMaxDurability": 0
  }]
}
```

---

## 3. Endpoints

### Apply to existing item

```
POST /api/players/:id/augment-item
Body: { itemId: 123, augments: ["Augment_Damage1"], augmentQuality: 5 }
```

**Requires player offline.** Rejects online players.

**Flow:**
1. Validates augment IDs, quality level
2. `requireOfflinePlayer()` — rejects online players
3. Locks item row `for update`, validates ownership
4. Extracts existing augments, deduplicates (internal cap: 20)
5. `validateAugmentsForTemplate()` — tag-based compatibility check
6. `ensureAugmentSlotKeystones()` — auto-purchases Crafting spec keystones (also inserts baseline Crafting track XP)
7. `loadAugmentRollPayloads()` — inherits best roll data from existing matching items in inventory
8. `buildAugmentedItemStats()` — generates `FAugmentedItemStats`
9. Updates `dune.items.stats`, resets `is_new` flag

**Returns:** `{ ok, itemId, templateId, augments, augmentQuality, previous, slotUnlocks }`

### Pre-augmented grant

```
POST /api/players/:id/give-item
Body: { templateId: "AtreLMG5", quality: 5, augments: ["Augment_Lmg1"], augmentQuality: 1 }
```

**Requires player offline for database path.** Uses default roll values (`{ StatRolls: [1.0], AppliedEffectIndices: [] }`).
Does NOT auto-purchase specialization keystones (unlike the apply flow).

---

## 4. Key Functions

### `buildAugmentedItemStats(augmentIds, rollPayloads)`

Generates `FAugmentedItemStats` with parallel arrays. Each `rollPayloads` entry is a
`{ StatRolls, AppliedEffectIndices }` object from `perfectAugmentRollPayload()`:
```js
return [[], {
  AppliedAugments: augmentIds.map(id => ({ Name: id })),
  AppliedAugmentQualities: augmentIds.map(id => rollPayloads.get(id).quality),
  AppliedAugmentRollData: augmentIds.map(id => rollPayloads.get(id).rollData)
}];
```

### `augmentRollCount(augmentId)`

Returns the roll count for an augment by reading from `augmentCompatibilityCatalog()`.
Checks `rollCount`, `statRollCount`, `gradeEffects`, and `effectSummary` fields in order.
Returns `1` if no data is available.

### `perfectAugmentRollPayload(payload, augmentId)`

Generates a `{ StatRolls, AppliedEffectIndices }` object with all `StatRolls` set to `1`
(perfect roll). Uses `augmentRollCount()` to determine array size.

### `loadAugmentRollPayloads(tx, augmentIds, qualityOverride, { sourceTemplateId, excludeItemId })`

Searches existing inventory items for matching augments and inherits their roll data.
Preference: standalone augment items first, then items with same source template,
then any item with that augment applied. Falls back to `perfectAugmentRollPayload()`.

### `augmentSlotKeystoneIdsForTemplate(templateId)`

Returns Crafting specialization keystone IDs needed for augment slots:
- **Clothing**: `[42, 43]` — 2 slots max
- **Melee weapons**: `[44, 45, 46]` — 3 slots max
- **Ranged weapons**: `[47, 48, 49]` — 3 slots max
- **Dual-type**: all 6 keystones

### `ensureAugmentSlotKeystones(tx, player, templateId, augmentIds)`

Auto-purchases missing Crafting specialization keystones. Also inserts baseline
Crafting track XP in `specialization_tracks` if needed. Used only in the apply flow.

### `augmentAllowedForTemplate(templateId, augmentId)`

Tag-based compatibility check. Compares augment tags from `runtime/data/augment-compatibility.json`
against item type tags inferred from the template ID.

---

## 5. Augment Compatibility (Tag-Based)

Loaded from `runtime/data/augment-compatibility.json`:
```json
{
  "augments": {
    "Augment_Damage1": { "tags": ["RangedWeapons", "MeleeWeapons"] },
    "Augment_Armor1":  { "tags": ["Clothing"] }
  }
}
```

Item tags inferred via `inferredAugmentItemTags()`:
- **MeleeWeapons** — knife, sword, axe, mace, hammer, spear, kindjal, etc.
- **RangedWeapons** — pistol, rifle, shotgun, bow, crossbow, sniper, etc.
- **Clothing** — armor, stillsuit, combat gear

An augment is compatible only if ALL its tags match the item's tags.

---

## 6. Flow Differences

| | Apply to existing | Pre-augmented grant |
|---|-------------------|---------------------|
| Endpoint | `POST /augment-item` | `POST /give-item` |
| Player state | **Offline required** | **Offline required** (DB path) |
| Roll data | Inherited from inventory | Default perfect rolls |
| Keystones | Auto-purchased | Not purchased |
| Item | Existing (must own) | New item created |

---

## 7. Constraints

| Constraint | Detail |
|-----------|--------|
| **Offline required** | Both endpoints reject online players |
| **Relog required** | Game processes augment data on next login |
| **Weapons** | Up to 3 augments (Crafting keystones 44-49) |
| **Clothing** | Up to 2 augments (Crafting keystones 42-43) |
| **Internal cap** | 20 augments per call (`.slice(0, 20)`) |
| **Ownership** | Item must be in player's directly-owned inventory |
| **Compatibility** | Tag-based from `augment-compatibility.json` |
| **Roll count** | Dynamic — read from compatibility catalog |

---

## 8. Files

| File | Purpose |
|------|---------|
| `console/api/src/duneDb.js` | All augment functions |
| `runtime/data/augment-compatibility.json` | Augment-to-tag mapping |
| `console/web/src/lib/augmentEligibility.ts` | Frontend compatibility |
| `console/web/src/components/common/AugmentDropdown.tsx` | Augment picker UI |
| `console/api/test/pre-augmented-gear-regression.test.js` | Regression tests |
