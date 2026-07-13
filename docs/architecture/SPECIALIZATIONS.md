# Specializations — Deep Analysis & Pre-Requisites

> **Branch**: `feature/specializations`  
> **Status**: ANALYSIS — updated with method.gg data | **Last Updated**: 2026-07-13

## Executive Summary

Specializations are an end-game progression system introduced in Chapter 3 of
Dune: Awakening. They are **NOT** accessible to new players — a 10-step unlock
chain must be completed first. Specializations consume two resources: XP
(time-gated behind daily Landsraad missions) and **Spice Melange** (for trait
purchases). Direct DB writes are extremely dangerous — the game engine
validates progression state on login and mismatches cause P34 crashes.

**Maxing one tree takes ~70 days and ~750 Spice. All five trees: ~350 days
and ~3,750 Spice.** This is the most deeply gated progression system in the
game.

---

## 1. Database Schema

### `dune.specialization_tracks`
| Column | Type | Purpose |
|--------|------|---------|
| `player_id` | bigint | Links to player |
| `track_type` | enum | Combat, Crafting, Exploration, Gathering, Sabotage |
| `xp_amount` | integer | Total XP earned in this track |
| `level` | real | Current track level (game engine computes from XP) |

### `dune.purchased_specialization_keystones`
| Column | Type | Purpose |
|--------|------|---------|
| `player_id` | bigint | Links to player |
| `keystone_id` | smallint | FK to `specialization_keystones_map.id` |

### `dune.specialization_keystones_map` (205 rows)
| Column | Type | Purpose |
|--------|------|---------|
| `id` | smallint | Keystone unique ID (1-205) |
| `name` | text | e.g., `Combat_CombatKeystone_SkillPoint14` |

### `dune.specialization_refund_id`
| Column | Type | Purpose |
|--------|------|---------|
| `player_id` | bigint | Links to player |
| `refund_id` | smallint | Refund transaction ID |

---

## 2. Track Structure (205 traits across 5 tracks)

### Combat (41 traits)
```
SkillPoint1 → 4 → 8 → 11 → 14 → 18 → 21 → 24 → 28 → 31 → 34 → 38 → 41 →
44 → 48 → 51 → 54 → 58 → 61 → 64 → 68 → 71 → 74 → 79 → 82 → 85 → 89 →
93 → 97 → 100
MaxHealth6 → 26 → 56 → 77 → 91
MaxStamina2 → 16 → 36 → 66 → 95
Hat (cosmetic at max)
```

### Crafting (41 traits)
```
ConsumableBatchCrafting8
CraftingJackpot20 → 33 → 55 → 78 → 96
CraftingSpeedIncrease18 → 38 → 72 → 93
AugmentCraftingCostDecrease25 → 59 → 90
RecyclingJackpot16 → 35 → 69
RecyclingYield14 → 40 → 80
RefiningYield12 → 22 → 45 → 63 → 85
MaxDurabilityLossReduction5 → 28 → 48 → 66 → 83
SchematicsOnRecycling61 | FragmentUpgrade52 | Hat75
ArmoirAugmentSlots10 → 42  (unlocks 2nd augment slot!)
MeleeWeaponAugmentSlots3 → 32 → 88
RangedWeaponAugmentSlots1 → 33 → 87
```

### Exploration (41 traits)
```
PlayerInventorySlots1 → 25 → 50 → 77 → 100  ← DIRECTLY RELEVANT to blueprints!
VehicleBoostHeatReduction3 → 15 → 30 → 59 → 90
VehicleFuelEfficiency6 → 35 → 55 → 65 → 85
VehicleHeatDissipation23 → 48 → 62 → 68 → 83 → 95
VehicleSpeedBonus20
ScanningRange17 → 71
SurveyTimeDecrease13
ClimbingStaminaBonus42
WormThreatReduction74 → 98
LootPoolAlterations40 | FogOfWarRadius38
```

### Gathering (41 traits)
```
YieldJackpot10 → 20 → 30 → 40 → 50 → 61 → 71 → 81 → 90 → 100
ByproductSalvage7 → 17 → 23 → 28 → 38 → 43 → 48 → 53 → 68 → 83
CompactorRange13 → 33 → 63 → 74 → 78
CompactorThreat8 → 25 → 65 → 86 → 96
ToolPowerCostReduction5 → 45 → 93
PickupYield15 → 55 | BonusBlood3 | BonusWater2
```

### Sabotage (41 traits)
```
HeadshotDamage1 → 10 → 27 → 50 → 74 → 100
HouseCreditsBonus3 → 22 → 37 → 45 → 60 → 85
ScanningResistance12 → 32 → 55 → 69 → 98
LandsraadBribeCost17 → 29 → 58 → 78 → 90 → 95
LandsraadContribution19 → 43 → 53 → 72 → 88
RecognitionSpeedReduction15 → 65
ReducedScannedTime24 → 35 → 48 → 63 → 81
```

---

## 3. The Unlock Chain (10 Steps to Access)

Specializations are NOT available to new players. The full unlock chain:

```
1.  Start A New Beginning quest chain
2.  Progress to Find the Fremen (7 challenge rooms)
3.  Reach The Great Convention (Act 4)
4.  Choose a faction — Atreides or Harkonnen
5.  Earn Faction Level 5 via faction quests
    ├── Anvil starter quests
    ├── Helius Gate (Atreides) or Riftwatch (Harkonnen)
    └── Faction Level shown on Inventory screen
6.  Speak to House Representative
    ├── Thufir Hawat (Arrakeen) for Atreides
    └── Piter de Vries (Harko Village) for Harkonnen
7.  Receive "House Operator" title (dialog-triggered, not a DB flag)
8.  Join a Faction-aligned Guild
9.  Gain Landsraad Mission access (L key, 35 missions/week cap)
10. Landsraad Missions award specialization XP (5/day, 625 XP/day max)
```

**Key insight**: Steps 1-8 cannot be bypassed with DB writes. They involve
NPC interactions, quest flags, dialog triggers, and guild membership — all
game-engine authoritative.

---

## 4. Resource Economy

### Specialization XP

| Property | Value |
|----------|-------|
| Source | Landsraad Missions ONLY |
| Daily cap | 5 missions/day |
| XP per day max | 625 XP (with 5 Mnemonic Recollections) |
| Weekly cap | 35 missions |

**XP Curve** (cumulative per level, source: method.gg):

| Level | XP | Level | XP | Level | XP |
|-------|-----|-------|-----|-------|-----|
| 1 | 100 | 25 | 4,561 | 75 | 28,582 |
| 5 | 553 | 34 | 7,419 | 90 | 37,942 |
| 10 | 1,264 | 50 | 14,167 | 100 | 44,182 |

### Spice Melange (Trait Currency)

**Traits are purchased with Spice Melange, NOT skill points.** This was a key
misunderstanding in the initial analysis. Skill points are used for the main
Skills tree, which is a separate system.

| Property | Value |
|----------|-------|
| Cost per trait | Variable, increases deeper in tree |
| Cost to max one tree | ~750 Spice Melange |
| Cost to max all 5 trees | ~3,750 Spice Melange |
| Time to max one tree | ~70 days |
| Time to max all 5 trees | ~350 days |

**Passives** (small bonuses) are awarded free with each level. Only **Traits**
(the large keystone nodes) cost Spice.

---

## 5. Directly Relevant to Our Existing Features

### Blueprints + Exploration Tree

The Exploration track includes `PlayerInventorySlots1 → 25 → 50 → 77 → 100`.
These keystones **directly increase `dune.inventories.max_item_count`**. Our
blueprint import slot check already reads `max_item_count` from the inventory
table — this automatically adapts if a player has exploration traits.

### Spice Grant (Already Working)

Our Give Item system can already grant Spice Melange to players since it's
just another inventory item. This is the one piece of the specialization
puzzle that IS safe to manipulate from the admin console.

---

## 6. Pre-Requisites for DB Write Operations

### 6.1 XP Grant (HIGH RISK)

If we write `xp_amount` to `specialization_tracks`, we MUST also write the
correct `level` using the XP curve. Mismatch = P34 crash on login.

**What we now know**: The exact XP curve (section 4). We can compute
`level = lookupLevel(xp_amount)` using the table from method.gg.

**Still unknown**: Does the game engine overwrite the `level` column on
login? If it recomputes from XP, our writes are safe. If it uses `level` as
authoritative AND recomputes, we risk desync.

### 6.2 Trait Purchase (HIGH RISK)

Writing to `purchased_specialization_keystones` requires:
1. Player has sufficient track level (XP curve)
2. All prerequisite traits are purchased (parent-first order)
3. Player actually possesses the Spice Melange (we can grant it via Give Item)
4. Player is offline

**Still unknown**: Does the game engine validate prerequisite order on login?
Will it delete invalid keystones? Or crash?

### 6.3 Faction Level / Reputation (EXTREME RISK)

Writing to `player_faction_reputation` may:
- Bypass quest flags needed for Landsraad access
- Cause NPC dialog state desync
- Soft-lock progression (can't get "House Operator" title without quest chain)

**Recommendation**: Do not touch faction tables.

---

## 7. Feasibility Assessment

### Safe (Read-Only)

| Feature | Risk |
|---------|------|
| View specialization levels per track | None |
| View purchased traits | None |
| View faction/reputation | None |
| View Landsraad mission progress | None |
| **Grant Spice Melange via Give Item** | None (already works) |
| XP progress display (XP curve in code) | None |

### High Risk (Needs Testing)

| Feature | Risk |
|---------|------|
| Grant XP to track | HIGH — must validate level consistency |
| Unlock traits directly | HIGH — prerequisite chain + spice cost |

### Do Not Attempt

| Feature | Risk |
|---------|------|
| Set faction level/reputation | EXTREME — breaks quest/NPC state |
| Bypass Landsraad access | EXTREME — compound unlock required |
| Force specialization unlock | EXTREME — 10-step chain required |

---

## 8. Relevant DB Tables (Complete)

| Table | Purpose |
|-------|---------|
| `dune.specialization_tracks` | XP + level per track per player |
| `dune.purchased_specialization_keystones` | Which traits purchased |
| `dune.specialization_keystones_map` | 205 trait definitions |
| `dune.specialization_refund_id` | Refund tracking |
| `dune.player_faction` | Faction choice (1=Atreides, 2=Harkonnen, 3=None, 4=Smuggler) |
| `dune.player_faction_reputation` | Reputation amount |
| `dune.factions` | Faction definitions |
| `dune.landsraad_tasks` | Mission catalog |
| `dune.landsraad_task_progress` | Player mission status |
| `dune.landsraad_task_player_contributions` | Per-player progress |

---

## 9. Next Steps

1. **Phase 1**: Read-only specialization viewer in Player tab
2. **Phase 1b**: XP progress bar using the known XP curve
3. **Phase 2**: Test XP grant on a sacrificial offline player account
   - Write `xp_amount = 1000` and `level = lookupLevel(1000)`
   - Log player in, observe if game engine overwrites or accepts
4. **Phase 3**: If Phase 2 succeeds, test trait grant
5. **Spice grant**: Already available via Give Item — no code needed

---

*Sources: method.gg specialization guide, dune.* DB inspection, DefaultGame.ini*
