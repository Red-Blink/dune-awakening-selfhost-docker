# Feature: Pre-Augmented Gear Grant

Branch: `feature/pre-augmented-gear-grant`

## Design

This feature adds the ability to grant weapons and armor with augmentations pre-applied at grant time, and to apply augmentations to existing inventory items. Previously, augments were only grantable as standalone consumable items, requiring players to craft and slot them at an Augmentation Station in-game.

## Augmentations in Dune Awakening

Per game mechanics:
- Augmentations are crafted from blueprints/schematics found in Testing Stations
- They can only be slotted into Plastanium-tier (mk6) weapons and armor
- They are applied via an Augmentation Station (base building)
- Once attached, they cannot be removed and reduce max durability by 2% each
- The number of augmentation slots is unlocked through the Crafting Specialization tree

## Architecture

### Two Approaches

**Approach A: Grant gear with augments pre-installed**
- Extends `giveItemToPlayer()` and `giveItemToStorage()` to accept an `augments` array
- Augments are written into the game's `FAugmentedItemStats` field of the `dune.items.stats` JSONB column
- Applied augments require the rolled payload from a real standalone augment item's `FAugmentItemStats`; if that source row is missing, the console rejects the request instead of creating gear that the game renders with empty augment slots
- Example stats payload:
  ```json
  {
    "FCustomizationStats": [[], {}],
    "FAugmentedItemStats": [[], {
      "AppliedAugments": [{"Name": "T6_Augment_Melee1"}, {"Name": "T6_Augment_Damage1"}],
      "AppliedAugmentQualities": [1, 1],
      "AppliedAugmentRollData": [{"StatRolls": [0.01], "AppliedEffectIndices": []}, {"StatRolls": [0.02], "AppliedEffectIndices": []}]
    }],
    "FItemStackAndDurabilityStats": [[], {"CurrentDurability": 100, "MaxDurability": 100, "DecayedMaxDurability": 100, "DecayedDurability": 100}]
  }
  ```
- Durability values are now initialized to 100 by default on DB-granted player items
- All pre-augmented grants force the database path (cannot go through RabbitMQ live grant)
- Player inventory augment grants require the player to be offline so live server state cannot overwrite the database edit

**Approach B: Apply augments to an existing inventory item**
- New `augmentInventoryItem()` function in `duneDb.js`
- Replaces the existing item's `FAugmentedItemStats`, preserving existing durability and non-augment customization data
- Deduplicates augment IDs automatically
- New API route: `POST /api/players/:id/augment-item`

## Files Changed

### Core Library
- `console/api/src/duneDb.js`
  - Added `validateAugmentIds()`, `buildItemStats()` helpers
- Added lookup of augment item `FAugmentItemStats` so gear receives real `AppliedAugmentRollData`; requests now fail clearly when the required rolled augment payload is not present in the database
  - Added `augmentInventoryItem()` — applies augments to existing DB items
  - Extended `giveItemToPlayer()` — accepts `augments: []`, populates durability stats
  - Extended `giveItemToStorage()` — accepts `augments: []`

### Server Routes
- `console/api/src/server.js`
  - Added route: `POST /api/players/:id/augment-item` → `duneDb.augmentInventoryItem()`
  - Updated `giveSingleItemRoute()` — passes `augments` from body; forces DB path when augments present
  - Updated `grantPlayerItem()` — passes `augments` to `giveItemToPlayer()`

### Care Package
- `console/api/src/carePackage.js`
  - Updated `validateCarePackageItem()` — validates and passes through `augments` array
  - Updated `grantCarePackage()` — passes augments to DB grant path

## API Contract

### POST /api/players/:id/augment-item

```json
{
  "itemId": 501,
  "augments": ["T6_Augment_Melee1", "T6_Augment_Damage1"],
  "confirmation": "APPLY AUGMENTS"
}
```

Response:
```json
{
  "ok": true,
  "itemId": 501,
  "templateId": "UniqueSword",
  "augments": ["T6_Augment_Melee1", "T6_Augment_Damage1"],
  "previous": []
}
```

### POST /api/players/:id/give-item (with augments)

```json
{
  "itemName": "Replica Pulse-sword",
  "quantity": 1,
  "quality": 5,
  "augments": ["T6_Augment_Melee1", "T6_Augment_Melee4"]
}
```

### Care Package item (with augments)

```json
{
  "itemName": "Replica Pulse-sword",
  "quantity": 1,
  "quality": 5,
  "augments": ["T6_Augment_Melee1"]
}
```

## Security Considerations

- Augment IDs validated via `validateTemplateId()` — same regex constraints as all item template IDs: `/^[A-Za-z0-9_./:-]{1,240}$/`
- Augment arrays capped at 20 entries
- All augment-item operations require the "APPLY AUGMENTS" confirmation phrase
- Durability initialization for DB-granted items provides sensible defaults (100) — avoids undefined/null state
- No new environment variables, tokens, or secrets introduced
- All operations are audit-logged through existing audit infrastructure

## Testing

- `console/api/test/db.test.js`: 7 new tests covering:
  - Player give-item with augments populates FAugmentedItemStats
  - Player give-item with augments forces DB path on grade 0 items
  - Storage give-item with augments populates FAugmentedItemStats
  - Augment inventory item applies augment IDs to existing item
  - Augment inventory item merges with existing augments
  - Augment inventory item deduplicates augment IDs
  - Augment inventory item requires valid augment IDs

- All 266 existing tests continue to pass
- Secret keyword scan passes (no new secrets)
- Git whitespace/conflict check passes

## Limitations

- The CLI tools (`admin-tools.sh`) use RabbitMQ for live grants, which does not support pre-populated `FAugmentedItemStats`. Pre-augmented gear grants must go through the web API or direct database operations.
- Player inventory augment edits are database mutations. The target player must be offline and should log in after the edit for the game server to load the updated item stats.
- Real standalone augment rows are required because they contain the game's own rolled `FAugmentItemStats` payload. If a payload is missing, the console stops the grant/apply operation and tells the user which augment rows need real rolled stats.
