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

Both flows auto-purchase missing Crafting specialization keystones via
`ensureAugmentSlotKeystones()`.

---

## 2. FAugmentedItemStats Format

```json
{
  "FAugmentedItemStats": [
    [],
    {
      "AppliedAugments": [
        { "Name": "T6_Augment_Damage1" },
        { "Name": "T6_Augment_Melee1" }
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

- **AppliedAugments** — array of `{ "Name": "<templateId>" }` objects. IDs use the
  `T6_Augment_` prefix (e.g., `T6_Augment_Damage1`, `T6_Augment_Armor1`)
- **AppliedAugmentQualities** — parallel array of quality levels (same index)
- **AppliedAugmentRollData** — parallel array of `{ StatRolls, AppliedEffectIndices }` objects

Complete stats JSON:
```json
{
  "FCustomizationStats": [[], {}],
  "FAugmentedItemStats": [[], {
    "AppliedAugments": [{ "Name": "T6_Augment_Damage1" }],
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
Body: { itemId: 123, augments: ["T6_Augment_Damage1"], augmentQuality: 5 }
```

**Flow:**
1. Validates augment IDs, quality level
2. `requireOfflinePlayer()` — rejects online players
3. Locks item row `for update`, validates ownership
4. Extracts existing augments, deduplicates (internal cap: 20)
5. `validateAugmentsForTemplate()` — tag-based compatibility
6. `ensureAugmentSlotKeystones()` — auto-purchases Crafting spec keystones
7. `loadAugmentRollPayloads()` — inherits roll data from existing items
8. `buildAugmentedItemStats()` — generates `FAugmentedItemStats`
9. Updates `dune.items.stats`, resets `is_new` flag

### Pre-augmented grant

```
POST /api/players/:id/give-item
Body: { templateId: "AtreLMG5", quality: 5, augments: ["T6_Augment_Lmg1"], augmentQuality: 1 }
```

**Flow:**
1. `itemRequiresDatabaseGrant()` — true when augments present
2. Creates new item via `giveItemToPlayer()`
3. `ensureAugmentSlotKeystones()` — auto-purchases Crafting spec keystones
4. `loadAugmentRollPayloads()` — loads roll data from existing items, falls back to `perfectAugmentRollPayload()`
5. `buildItemStats()` — generates full stats JSON including `FAugmentedItemStats`
6. Writes to `dune.items` directly (offline path)

---

## 4. Key Functions

### `buildAugmentedItemStats(augmentIds, rollPayloads)`

Generates `FAugmentedItemStats` with parallel arrays:
```js
return [[], {
  AppliedAugments: augmentIds.map(id => ({ Name: id })),
  AppliedAugmentQualities: augmentIds.map(id => rollPayloads.get(id).quality),
  AppliedAugmentRollData: augmentIds.map(id => rollPayloads.get(id).rollData)
}];
```

### `augmentRollCount(augmentId)`

Returns roll count from `augmentCompatibilityCatalog()` using `rollCount`,
`statRollCount`, `gradeEffects`, and `effectSummary` fields. Returns `1`
if no data available. Not hardcoded.

### `perfectAugmentRollPayload(payload, augmentId)`

Generates `{ StatRolls, AppliedEffectIndices }` with all `StatRolls` set
to `1.0` (perfect rolls). Used as fallback when no existing roll data found.

### `loadAugmentRollPayloads(tx, augmentIds, qualityOverride, opts)`

Searches existing inventory items for matching augments and inherits their
`StatRolls`/`AppliedEffectIndices`. Prefers standalone augment items, then
items with matching source template, then any item with the augment applied.
Falls back to `perfectAugmentRollPayload()` if nothing found.

### `ensureAugmentSlotKeystones(tx, player, templateId, augmentIds)`

Auto-purchases missing Crafting specialization keystones via
`purchased_specialization_keystones`. Also inserts baseline Crafting track
XP in `specialization_tracks` if needed. Called by BOTH apply and grant flows.

### `augmentSlotKeystoneIdsForTemplate(templateId)`

Returns keystone IDs for augment slots:
- **Clothing**: `[42, 43]` — 2 slots
- **Melee weapons**: `[44, 45, 46]` — 3 slots
- **Ranged weapons**: `[47, 48, 49]` — 3 slots
- **Dual-type**: all 6

### `augmentTagsMatch(itemTags, augmentTags)`

Returns `true` if ANY augment tag matches ANY item tag (using `.some()`).
Not an "ALL must match" constraint — single match is sufficient.

### `augmentAllowedForTemplate(templateId, augmentId)`

Checks if an augment's tags have at least one matching item tag.
Loads tag data from `runtime/data/augment-compatibility.json`.

---

## 5. Augment Compatibility (Tag-Based)

Loaded from `runtime/data/augment-compatibility.json`. Actual augment IDs use
the `T6_Augment_` prefix:
```json
{
  "augments": {
    "T6_Augment_Damage1": { "tags": ["RangedWeapons", "MeleeWeapons"] },
    "T6_Augment_Armor1":  { "tags": ["Clothing"] }
  }
}
```

Item tags inferred via `inferredAugmentItemTags()`:
- **MeleeWeapons** — knife, sword, axe, mace, hammer, spear, kindjal
- **RangedWeapons** — pistol, rifle, shotgun, bow, crossbow, sniper
- **Clothing** — armor, stillsuit, combat gear

Matching: `augmentTagsMatch()` uses `.some()` — ANY matching tag pair is
sufficient. Augment `tags: ["RangedWeapons"]` matches an item with
`["RangedWeapons", "MeleeWeapons"]` because at least one tag overlaps.

---

## 6. Flow Comparison

| | Apply to existing | Pre-augmented grant |
|---|-------------------|---------------------|
| Endpoint | `POST /augment-item` | `POST /give-item` |
| Player state | Offline required | Offline required (DB path) |
| Keystones | Auto-purchased | Auto-purchased |
| Roll data | Inherited from inventory | Inherited from inventory, falls back to perfect |
| Item | Existing (must own) | New item created |
| Stats built via | `buildAugmentedItemStats()` | `buildItemStats()` |

Both flows call `ensureAugmentSlotKeystones()` and `loadAugmentRollPayloads()`.

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
| **Compatibility** | ANY matching tag (`.some()`) from `augment-compatibility.json` |
| **Roll count** | Dynamic from compatibility catalog, not hardcoded |

---

## 8. Files

| File | Purpose |
|------|---------|
| `console/api/src/duneDb.js` | All augment functions |
| `runtime/data/augment-compatibility.json` | Augment-to-tag mapping (T6_Augment_ prefix) |
| `console/web/src/lib/augmentEligibility.ts` | Frontend compatibility matching |
| `console/api/test/pre-augmented-gear-regression.test.js` | Regression tests |
