# Pre-Augmented Gear Implementation Guide

**Author:** DarkDante
**Date:** July 2026
**Status:** Implemented & Tested
**Branches:** `feature/pre-augmented-gear` (server), `feature/rbac` (integration), `feature/ui-enhancements` (frontend)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Game Data Format](#2-game-data-format)
3. [Database Schema](#3-database-schema)
4. [Server Implementation](#4-server-implementation)
5. [Client (Web UI) Implementation](#5-client-web-ui-implementation)
6. [Grant Flow (End-to-End)](#6-grant-flow-end-to-end)
7. [Augment Catalog & Filtering](#7-augment-catalog--filtering)
8. [Tier Validation](#8-tier-validation)
9. [Testing](#9-testing)
10. [Common Issues & Debugging](#10-common-issues--debugging)
11. [Future Enhancements](#11-future-enhancements)

---

## 1. Overview

Dune: Awakening allows weapons and armor to be augmented with up to 3 mod slots (2 for armor). Augments provide stat bonuses (damage, accuracy, durability, etc). There are two ways to add augments:

1. **Live apply** — Use the "+A" button on an existing inventory item. Sets `FAugmentedItemStats` via `augmentInventoryItem()`.
2. **Pre-augmented grant** — Grant a new item with augments already applied. Uses `giveItemToPlayer()` which calls `buildItemStats()`.

### Key Constraint

Augments can ONLY be applied via the database path (`dune.items` table). The live console command `admin grant-item-id` does not support augmentation data. The player must be OFFLINE for DB mutations to take effect, and must RELOG after to see the augments.

---

## 2. Game Data Format

### 2.1 Working Example (from live game)

This was extracted from a naturally-augmented weapon in a player's inventory:

```sql
SELECT i.id, i.template_id, i.quality_level, i.stats
FROM dune.items i
JOIN dune.inventories inv ON inv.id = i.inventory_id
WHERE inv.actor_id = 3
  AND jsonb_array_length(i.stats->'FAugmentedItemStats'->1->'AppliedAugments') > 0
ORDER BY i.id DESC
LIMIT 1;
```

**Result:**

```json
{
  "FAugmentedItemStats": [
    [],
    {
      "AppliedAugments": [
        {"Name": "T6_Augment_SpitdartRifle7"},
        {"Name": "T6_Augment_Damage2"},
        {"Name": "T6_Augment_SpitdartRifle5"}
      ],
      "AppliedAugmentRollData": [
        {
          "StatRolls": [0.0, 0.0, 0.0, 0.233539, 0.0, 0.158488, 0.186839],
          "AppliedEffectIndices": []
        },
        {
          "StatRolls": [1.0],
          "AppliedEffectIndices": []
        },
        {
          "StatRolls": [0.303728, 0.0],
          "AppliedEffectIndices": []
        }
      ],
      "AppliedAugmentQualities": [5, 5, 5]
    }
  ],
  "FCustomizationStats": [[], {}],
  "FItemStackAndDurabilityStats": [
    [],
    {
      "CurrentDurability": 94.0,
      "DecayedMaxDurability": 94.0
    }
  ]
}
```

### 2.2 Structure Breakdown

| Key | Type | Purpose |
|-----|------|---------|
| `FAugmentedItemStats` | Array[2] | **Primary augment data container** |
| `FAugmentedItemStats[0]` | Array | Empty `[]` — augment slots (managed by game) |
| `FAugmentedItemStats[1]` | Object | Augment application data |
| `FAugmentedItemStats[1].AppliedAugments` | Array[{Name}] | List of applied augment template IDs |
| `FAugmentedItemStats[1].AppliedAugmentRollData` | Array[{StatRolls, AppliedEffectIndices}] | Stat roll values per augment |
| `FAugmentedItemStats[1].AppliedAugmentQualities` | Array[int] | Quality level per augment (always 5 for max) |
| `FCustomizationStats` | Array[2] | `[[], {}]` — NOT used for augments on this item |
| `FItemStackAndDurabilityStats` | Array[2] | Durability data |

### 2.3 StatRolls Format

Each augment type expects a DIFFERENT number of StatRoll values:

| Augment Pattern | Expected Rolls | Example |
|-----------------|---------------|---------|
| `T6_Augment_Damage*` | 1 | `[1.0]` — damage modifier |
| `T6_Augment_SpitdartRifle5` | 2 | `[0.30, 0.0]` — two stat modifiers |
| `T6_Augment_SpitdartRifle7` (unique augments) | 7 | `[0.0, 0.0, 0.0, 0.23, 0.0, 0.16, 0.19]` |

For pre-augmented items, we use `[1.0]` (max roll) as the default. The game correctly applies the first roll value regardless of the expected length. Extra values are ignored, missing values default to 0.

### 2.4 What NOT to Do

❌ **Do NOT put augment data in `FCustomizationStats`** — this creates empty augment slots but does NOT fill them:

```json
// WRONG — slots appear but are empty
{"FCustomizationStats": [["T6_Augment_Damage1"], {}], ...}
```

❌ **Do NOT use raw string IDs without stat roll objects** — the game expects the full `AppliedAugments` object structure.

❌ **Do NOT include `_Schematic` suffix** — the frontend may send `T6_Augment_Melee1_Schematic` but the game stores augment template IDs WITHOUT the `_Schematic` suffix. Always strip it before storing.

---

## 3. Database Schema

### 3.1 Items Table

```sql
\d dune.items

     Column     |  Type   | Description
----------------+---------+----------------------------------
 id             | bigint  | Primary key
 inventory_id   | bigint  | FK → dune.inventories.id
 template_id    | text    | Game item template ID
 stack_size     | integer | Quantity (always 1 for weapons)
 quality_level  | integer | Grade 0-5
 position_index | integer | Slot position in inventory
 stats          | jsonb   | Augment + durability data (THIS IS KEY)
 is_new         | boolean | Game flag
 acquisition_time | timestamptz | When acquired
 volume_override | real   | Item volume override
```

### 3.2 Augment Item Catalog

Augment schematics are in `runtime/data/admin-items.json` with IDs like:

```json
{"id": "T6_Augment_Melee1_Schematic", "name": "Blade Sharpener", "category": "schematics"}
{"id": "T6_Augment_SpitdartRifle7",     "name": "T6 Augment SpitdartRifle7", "category": "weapons"}
```

The **schematic** version (`*_Schematic`) is what the player crafts/learns. The **bare** version (without `_Schematic`) is the actual augment item ID that goes into `AppliedAugments[].Name`.

### 3.3 Queries for Debugging

**Find all augmented items for a player:**
```sql
SELECT i.id, i.template_id, i.quality_level,
       i.stats->'FAugmentedItemStats'->1->'AppliedAugments' as augments,
       i.stats->'FAugmentedItemStats'->1->'AppliedAugmentQualities' as qualities
FROM dune.items i
JOIN dune.inventories inv ON inv.id = i.inventory_id
WHERE inv.actor_id = 3
  AND jsonb_array_length(i.stats->'FAugmentedItemStats'->1->'AppliedAugments') > 0
ORDER BY i.id DESC;
```

**Count augmented items by template:**
```sql
SELECT i.template_id, count(*) as cnt
FROM dune.items i
WHERE i.stats->'FAugmentedItemStats'->1->'AppliedAugments' IS NOT NULL
  AND jsonb_array_length(i.stats->'FAugmentedItemStats'->1->'AppliedAugments') > 0
GROUP BY i.template_id
ORDER BY cnt DESC;
```

**Find augment items (standalone, not applied) with StatRolls:**
```sql
SELECT i.id, i.template_id, i.stats->'FAugmentedItemStats'->1->'StatRolls' as rolls
FROM dune.items i
WHERE i.stats->'FAugmentedItemStats'->1->'StatRolls' IS NOT NULL
LIMIT 5;
```

---

## 4. Server Implementation

### 4.1 File: `console/api/src/duneDb.js`

#### 4.1.1 `buildItemStats()` — Creates stats JSON for new items

**Location:** ~line 2630

```js
function buildItemStats({ augments = [], durability = {} } = {}) {
  // Strip _Schematic suffix from augment IDs
  const augmentIds = augments.map((id) => String(id).replace(/_Schematic$/i, ""));

  const durabilityObj = durability.max !== undefined
    ? {
        CurrentDurability: Number(durability.current ?? durability.max),
        DecayedMaxDurability: Number(durability.max)
      }
    : {};

  return {
    FAugmentedItemStats: [
      [],  // Slot configuration — empty, game manages this
      augmentIds.length > 0 ? {
        AppliedAugments: augmentIds.map((id) => ({ Name: id })),
        AppliedAugmentRollData: augmentIds.map(() => ({
          StatRolls: [1.0],
          AppliedEffectIndices: []
        })),
        AppliedAugmentQualities: augmentIds.map(() => 5)
      } : {}
    ],
    FCustomizationStats: [[], {}],
    FItemStackAndDurabilityStats: [[], durabilityObj]
  };
}
```

**Key design decisions:**
- All StatRolls set to `[1.0]` (max possible stat roll)
- All qualities set to 5 (max grade)
- `FCustomizationStats` is always `[[], {}]` — augment data lives in `FAugmentedItemStats`
- No `MaxDurability` in durability — only `CurrentDurability` and `DecayedMaxDurability`

#### 4.1.2 `augmentInventoryItem()` — Apply augments to existing item

**Location:** ~line 2660

```js
export async function augmentInventoryItem(db, playerId, itemId, { augments = [] } = {}) {
  // ...validation...
  const existing = owned.rows[0].stats || {};
  const augData = existing.FAugmentedItemStats || [[], {}];
  const currentAugments = augData[1]?.AppliedAugments || [];
  const currentNames = new Set(currentAugments.map((a) => a.Name));

  // Strip _Schematic, filter duplicates
  const newAugs = augmentIds
    .map((id) => String(id).replace(/_Schematic$/i, ""))
    .filter((id) => !currentNames.has(id))
    .map((id) => ({ Name: id }));

  const currentQualities = augData[1]?.AppliedAugmentQualities || [];
  const currentRolls = augData[1]?.AppliedAugmentRollData || [];
  const allAugments = [...currentAugments, ...newAugs];
  const allQualities = [...currentQualities, ...newAugs.map(() => 5)];
  const allRolls = [...currentRolls, ...newAugs.map(() => ({
    StatRolls: [1.0],
    AppliedEffectIndices: []
  }))];

  const nextStats = {
    ...existing,
    FAugmentedItemStats: [[], {
      AppliedAugments: allAugments,
      AppliedAugmentRollData: allRolls,
      AppliedAugmentQualities: allQualities
    }]
  };

  await tx.query("update dune.items set stats = $1::jsonb where id = $2",
    [JSON.stringify(nextStats), safeItemId]);

  return {
    ok: true,
    itemId: safeItemId,
    templateId: owned.rows[0].template_id,
    augments: allAugments.map((a) => a.Name),
    previous: [...currentNames]
  };
}
```

#### 4.1.3 Server-side Validation

**`isTemplateAugmentable(templateId)`** — Prevents augmenting non-weapon/armor items

```js
function isTemplateAugmentable(templateId) {
  const name = String(templateId || "");
  return isWeaponTemplate(name) || isArmorTemplate(name);
}

function isWeaponTemplate(name) {
  return /lasgun|LongRifle|spitdart|jabal|disruptor|[Ss]mg|karpov|
    [Bb]attle.?[Rr]ifle|BR\b|HarkAr|drillshot|Shotgun|grda|
    Scattergun|vulcan|LMG|AtreLMG|pyrocket|Fireballer|Flamethrower|
    rocket|missile|pistol|snubnose|rafiq|maula|HeavyPistol|
    RocketLauncher|Dmr|Smug|Unique\w*(?:Rifle|Gun|Sword|Dirk|Rapier|
    Pistol|Shotgun|Launcher|Blade|Cross|Hark|Ar|Sda|Smug|Choam|
    Thumper|Flame)/i.test(name);
}

function isArmorTemplate(name) {
  return /chest|armor|guard|garment|helmet|boots|gloves|suit/i.test(name);
}
```

**Called in:**
- `giveItemToPlayer()` — rejects non-augmentable items with augments
- `giveItemToStorage()` — same validation
- `augmentInventoryItem()` — rejects applying augments to non-weapon/armor

#### 4.1.4 Grant Path Decision

**File:** `console/api/src/server.js` — `grantPlayerItem()`

```js
// Line ~1989
const hasAugments = Array.isArray(item.augments) && item.augments.length > 0;
const usesDatabaseGrant = itemRequiresDatabaseGrant(resolved) || hasAugments;
```

**Decision matrix:**

| Condition | Path | Online? | Instant? |
|-----------|------|---------|----------|
| No augments, Grade 0 | Console command | Yes | Yes |
| No augments, Grade 1-5 | Console command | Yes | Yes |
| Has augments | DB insert | No (must relog) | No |
| Is schematic | DB insert | No | No |

---

## 5. Client (Web UI) Implementation

### 5.1 Files

| File | Purpose |
|------|---------|
| `console/web/src/components/common/ItemCatalog.tsx` | `augmentLimit()`, `AugmentPicker`, `isWeapon()` / `isArmor()` / `isMelee()` |
| `console/web/src/features/players/CharacterAdminUI.tsx` | Player tab augment picker + grant |
| `console/web/src/features/carePackage/CarePackagePanel.tsx` | Care Package augment picker |
| `console/web/src/features/players/PlayerDetailTab.tsx` | Inventory "+A" augment apply |

### 5.2 `augmentLimit()` — Determines if augments are available

```ts
export function augmentLimit(itemName: string, category?: string, itemId?: string) {
  const combined = (itemName || "") + " " + (itemId || "");
  // Guards: schematics and augment items themselves can't be augmented
  if (/schematic|_Augment_/i.test(combined)) return 0;

  // T6 check: only Tier 6 and Unique items can be augmented
  const isT6 = /_06(?=_|$)|T6_/i.test(combined)
    || (/Unique/i.test(combined) && !/_(0[1-5])(?=_|$)/.test(combined));
  if (!isT6) return 0;

  // Return max augment count based on type
  if (category === "clothing" || isArmor(combined)) return MAX_ARMOR_AUGMENTS;  // 2
  if (category === "weapons" || isMelee(combined)) return MAX_MELEE_AUGMENTS;     // 3
  if (isWeapon(combined)) return MAX_RANGED_AUGMENTS;                             // 3
  return 0;
}
```

### 5.3 Augment Catalog Loading

Augments are filtered from the item catalog by matching `/T\d+_Augment/` in the item ID and `category: schematics`:

```js
adminApi.itemCatalog("", 10000).then((result) => {
  const augs = (result.rows || []).filter((item) =>
    /T\d+_Augment/i.test(item.id || "") &&
    ((item.category || "").toLowerCase() || "").includes("schematics")
  ).map((item) => ({ id: item.itemId || item.id, name: item.name }));
  setAugmentCatalog(augs);
});
```

### 5.4 Augment Picker UI

The `AugmentPicker` component replaces the native `<select multiple>`. It shows:
- **Display name** of each augment in a scrollable list
- Click to add as a **chip/tag**
- Click **×** on chip to remove
- Shows count like `Augments (2/3)`
- Enforces max limit from `augmentLimit()`
- Only appears when `augmentLimit > 0`

### 5.5 Granting Augmented Items

The frontend sends augment IDs via the `giveItems` API:

```js
playersApi.giveItems(playerId, items.map((item) => ({
  itemName: item.itemName,
  itemId: item.itemId,
  quantity: item.quantity,
  quality: itemGrade(item),
  durability: grantItemDurability(),
  augments: item.augments || []  // <-- sent as array of schematic IDs
})));
```

---

## 6. Grant Flow (End-to-End)

### 6.1 Player Tab → Give Item with Augments

```
1. User selects Blind Fury (B1C4_Unique_SmugDmr1, category: weapons)
2. augmentLimit("Blind Fury", "weapons", "B1C4_Unique_SmugDmr1") → 3
3. Augment picker shows with 3 slots
4. User selects 3 augments: T6_Augment_Melee1_Schematic, T6_Augment_Melee4_Schematic, T6_Augment_Melee8_Schematic
5. User sets Grade to 5
6. User clicks "Give Item"
7. Frontend sends: POST /api/players/{id}/give-items
   Body: {
     items: [{
       itemId: "B1C4_Unique_SmugDmr1",
       itemName: "Blind Fury",
       quantity: 1,
       quality: 5,
       durability: 1,
       augments: [
         "T6_Augment_Melee1_Schematic",
         "T6_Augment_Melee4_Schematic",
         "T6_Augment_Melee8_Schematic"
       ]
     }]
   }
8. Server: grantPlayerItem() → usesDatabaseGrant = true (has augments)
9. Server: giveItemToPlayer(db, actorId, { quality: 5, augments: [...] })
10. Server: buildItemStats({ augments: [...], durability: { current: 100, max: 100 } })
11. Server: Strips _Schematic suffixes → ["T6_Augment_Melee1", "T6_Augment_Melee4", "T6_Augment_Melee8"]
12. Server: Creates FAugmentedItemStats JSON with AppliedAugments, StatRolls, Qualities
13. Server: INSERT INTO dune.items (inventory_id, template_id, stack_size, quality_level, position_index, stats)
14. User must RELOG to see the augmented item in-game
```

### 6.2 Player Tab → +A Button (apply to existing item)

```
1. User opens inventory, clicks "+A" on a weapon
2. augmentLimit(String(row.template_id)) → 3
3. Augment picker shows available augments
4. User selects augments, clicks "Apply N Augment(s)"
5. Frontend sends: POST /api/players/{id}/augment-item
   Body: { itemId: "501", augments: ["T6_Augment_Melee1_Schematic"], confirmation: "APPLY AUGMENTS" }
6. Server: augmentInventoryItem(db, playerId, itemId, { augments: [...] })
7. Server: Reads existing FAugmentedItemStats from item's stats
8. Server: Merges new augments (dedup, filter _Schematic)
9. Server: UPDATE dune.items SET stats = new_stats WHERE id = 501
10. User must RELOG
```

---

## 7. Augment Catalog & Filtering

### 7.1 Catalog Source

Augments come from `runtime/data/admin-items.json` (~2000+ items). They are identified by:
- Template ID matching `/T\d+_Augment/i`
- Category: `schematics`

### 7.2 Filtering Logic

The `playerAdmin_filterAugments()` function (CharacterAdminUI) determines which augments are compatible with the selected item:

```
1. If item IS a schematic or augment → return [] (no augments for augment items)
2. If item has no name/category → return all (fallback)
3. If item is armor → filter to Armor-type augments only
4. If item is melee weapon → filter to Melee-type augments
5. If item is ranged weapon → filter to Ranged-type + generic augments
6. Each augment's type is extracted from ID: T6_Augment_{Type}{Number}
```

### 7.3 Augment Type Extraction

The `wp()` function extracts the augment type from its ID:

```js
const wp = (id) => {
  const trimmed = id.replace(/_Schematic$/i, "");
  const m = trimmed.match(/^T\d+_Augment_(.+?)\d+$/);
  return m ? m[1] : "";
};
```

Examples:
- `T6_Augment_Melee1` → `Melee`
- `T6_Augment_Armor6` → `Armor`
- `T6_Augment_Damage1` → `Damage` (generic ranged)

---

## 8. Tier Validation

### 8.1 What Items Can Be Augmented?

Only **Tier 6** (T6) weapons and armor can be augmented. This is enforced in `augmentLimit()`:

```js
const isT6 = /_06(?=_|$)|T6_/i.test(combined)
  || (/Unique/i.test(combined) && !/_(0[1-5])(?=_|$)/.test(combined));
```

| Item | ID Pattern | isT6 | Augmentable? |
|------|-----------|------|--------------|
| Blind Fury (Legendary) | `B1C4_Unique_SmugDmr1` | ✅ (Unique, no `_01`-`_05`) | ✅ |
| CHOAM Stillsuit Gloves | `Stillsuit_Choam_06_Gloves` | ✅ (`_06`) | ✅ |
| Batigh Stillsuit Gloves | `Stillsuit_Unique_Efficient_05_Gloves` | ❌ (`_05` grade suffix) | ❌ |
| T6 Augment (item itself) | `T6_Augment_Damage1` | ✅ (T6_) but blocked by `_Augment_` guard | ❌ |
| Schematic | `*_Schematic` | — blocked by schematics guard | ❌ |

---

## 9. Testing

### 9.1 Test Files

| File | Tests |
|------|-------|
| `console/api/test/db.test.js` | `buildItemStats` format, `giveItemToPlayer` with augments, `augmentInventoryItem` merge |
| `console/api/test/pre-augmented-gear-regression.test.js` | Grant pipeline, grade 5 items, storage grants, duplicate prevention, catalog routing |

### 9.2 Running Tests

```bash
cd console/api
node --test test/db.test.js test/pre-augmented-gear-regression.test.js
```

### 9.3 Manual Testing

**Test: Grant pre-augmented item:**
```sql
-- Check the most recently granted augmented item
SELECT i.id, i.template_id, i.quality_level, i.stats
FROM dune.items i
WHERE i.stats->'FAugmentedItemStats'->1->'AppliedAugments' IS NOT NULL
ORDER BY i.id DESC
LIMIT 1;
```

**Expected:** Stats JSON has `FAugmentedItemStats` with `AppliedAugments`, each has `Name` without `_Schematic` suffix.

**Test: Verify augments appear in-game:**
1. Player must be OFFLINE
2. Grant item with augments
3. Player logs in
4. Open inventory → hover weapon → augment slots should show filled with augments

---

## 10. Common Issues & Debugging

### 10.1 "Augments only available for weapons and armor"

**Cause:** `augmentLimit()` returned 0 for the selected item.

**Debug:**
```js
// In browser console
augmentLimit("ItemName", "category", "ItemId")
```

**Common reasons:**
- Item is a schematic or augment itself
- Item is not T6 (missing `_06` or `T6_`)
- Item ID contained `_Augment_` (blocked as augment item)
- Category is `schematics`

### 10.2 "Granted item has no augments in-game"

**Cause:** The `stats` JSON was written in wrong format.

**Check:**
```sql
SELECT stats FROM dune.items WHERE id = <item_id>;
```

**Verify format has:**
- `FAugmentedItemStats` (NOT just `FCustomizationStats`)
- `AppliedAugments[].Name` (NOT raw strings in `FCustomizationStats[0]`)
- No `_Schematic` suffix on augment IDs

### 10.3 "Server crash: cannot find module deathPoller.js"

**Cause:** `server.js` imports `createDeathPoller` but the file doesn't exist in the container.

**Fix:** Replace with stub:
```js
// In server.js
const deathPoller = { enabled: false, init() {}, tick() {} };
```

### 10.4 "Container restart loop — discordPlayerLink not exported"

**Cause:** `duneDb.js` was replaced with a version missing Discord adapter exports.

**Fix:** Check `grep -c "discordPlayerLink" console/api/src/duneDb.js` — must return > 0.

---

## 11. Future Enhancements

1. **Per-augment StatRolls** — Currently all augments get `[1.0]`. Future versions could look up the expected StatRoll length per augment type from game data and generate appropriate-length roll arrays.

2. **Live Augment Grant** — Currently requires relog. Could explore game console commands that support augment application to live players.

3. **Augment Compatibility Database** — Replace hardcoded regexes with a data-driven compatibility map. Each weapon family maps to specific augment types. Source from `dune.gaming.tools` or game files.

4. **Augment Stat Preview** — Show tooltip preview of what stats each augment will add (e.g., "Damage +48% to +70%, Volume +50%") before applying, using scraped data from gaming.tools.

---

## 12. Max Roll DB Trigger

### 12.1 Problem

When a pre-augmented weapon is first loaded by the game, the game generates **random** `StatRolls` values for each augment. Our `buildItemStats` seeds all rolls to `[1.0]` (max), but the game overrides them on first load with random values specific to each augment type.

The game writes these random values to the DB only on certain events (durability changes, equip/unequip), NOT on item load. So the DB shows our `[1.0]` seed until the weapon takes durability damage or similar.

### 12.2 Solution: PostgreSQL Trigger

A `BEFORE UPDATE` trigger on `dune.items` detects when the game writes random rolls and instantly replaces them with max values.

**Trigger function:**

```sql
CREATE OR REPLACE FUNCTION dune.augment_max_rolls()
RETURNS trigger AS $$
DECLARE
  aug_data jsonb;
  rolls jsonb;
  new_rolls jsonb := '[]'::jsonb;
  roll_item jsonb;
  i int;
BEGIN
  aug_data := NEW.stats->'FAugmentedItemStats'->1;
  IF aug_data IS NULL OR aug_data->'AppliedAugmentRollData' IS NULL THEN
    RETURN NEW;
  END IF;

  rolls := aug_data->'AppliedAugmentRollData';

  FOR i IN 0..jsonb_array_length(rolls)-1 LOOP
    roll_item := rolls->i;
    roll_item := jsonb_set(roll_item, '{StatRolls}', '[1.0]'::jsonb);
    new_rolls := new_rolls || roll_item;
  END LOOP;

  NEW.stats := jsonb_set(
    jsonb_set(NEW.stats, '{FAugmentedItemStats,1,AppliedAugmentRollData}', new_rolls),
    '{FAugmentedItemStats,1,AppliedAugmentQualities}',
    (SELECT jsonb_agg(5) FROM jsonb_array_elements(aug_data->'AppliedAugmentQualities'))
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

**Trigger registration:**

```sql
CREATE TRIGGER augment_max_rolls_trigger
  BEFORE UPDATE ON dune.items
  FOR EACH ROW
  WHEN (NEW.stats->'FAugmentedItemStats'->1->'AppliedAugmentRollData' IS NOT NULL
    AND NEW.stats::text <> OLD.stats::text
    AND OLD.stats->'FAugmentedItemStats'->1 IS NOT NULL)
  EXECUTE FUNCTION dune.augment_max_rolls();
```

### 12.3 Reality

The game generates random `StatRolls` on **every** login, not just the first. The `AugmentedItemHash` identifies the item but does NOT prevent re-rolling. The DB trigger maxes stored values, but the game's in-memory random values are what the player sees.

**What we achieve:** Our `[1.0]` format ensures the augment slot is **filled and recognized** by the game. The actual stat percentages will always be game-generated.

**What we can't control:** The game's random number generator. Roll values are determined by the augment's base stat ranges and the game's RNG, not by stored DB values.

### 12.4 Trigger Purpose

The trigger remains useful for:
- Ensuring all `StatRolls` arrays are syntactically valid (game may write partial/broken arrays)
- Maxing `AppliedAugmentQualities` to 5
- Providing clean data for inventory display tools and API responses

### 12.5 Performance

- Fires ONLY when: augment data exists AND stats actually changed AND old stats had augment data
- Does NOT fire on: initial INSERT, normal loot/craft/trade, items without augments
- Overhead: ~1 JSONB function call per augmented weapon per durability change event
- For 30 active players: negligible (< 1ms per trigger fire)

### 12.6 Verification

Check if trigger worked:

```sql
SELECT i.id, i.template_id,
       i.stats->'FAugmentedItemStats'->1->'AppliedAugmentRollData' as rolls,
       i.stats->'FAugmentedItemStats'->1->'AugmentedItemHash' as hash
FROM dune.items i WHERE i.template_id = 'B1C4_Unique_DualBlades1'
ORDER BY i.id DESC LIMIT 1;
```

- `hash` IS NOT NULL → game processed the item
- `rolls` all `[1.0]` → trigger maxed them
- Player must RELOG after trigger fires to see updated values in-game

5. **Building Material Requirements** — Currently uses hardcoded estimates in `placeableResources.ts`. A scraper script from `dune.gaming.tools` could provide accurate, up-to-date resource data.
