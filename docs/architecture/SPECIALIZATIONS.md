# Specializations — Deep Analysis & Pre-Requisites

> **Branch**: `feature/specializations`  
> **Status**: ANALYSIS | **Last Updated**: 2026-07-13

## Executive Summary

Specializations in Dune: Awakening are a multi-layered progression system spanning
6 tracks, 205 keystones, and a level-gated unlock tree. Direct DB writes are
**dangerous** — the game engine validates prerequisites on login and may crash
(P34-style) if the state is inconsistent. Before building admin tooling, we must
understand the full dependency chain.

---

## 1. Database Schema

### `dune.specialization_tracks`
| Column | Type | Purpose |
|--------|------|---------|
| `player_id` | bigint | Links to player |
| `track_type` | enum | Combat, Crafting, Exploration, Gathering, Sabotage (and possibly more) |
| `xp_amount` | integer | Total XP earned in this track |
| `level` | real | Current track level (unlocks keystones at thresholds) |

**Constraint**: `level` is derived from `xp_amount` by the game engine. Writing
a raw level without matching XP will cause desync.

### `dune.purchased_specialization_keystones`
| Column | Type | Purpose |
|--------|------|---------|
| `player_id` | bigint | Links to player |
| `keystone_id` | smallint | FK to `specialization_keystones_map.id` |

### `dune.specialization_keystones_map` (205 rows)
| Column | Type | Purpose |
|--------|------|---------|
| `id` | smallint | Keystone unique ID (1-205) |
| `name` | text | Game identifier (e.g., `Combat_CombatKeystone_SkillPoint14`) |

### `dune.specialization_refund_id`
| Column | Type | Purpose |
|--------|------|---------|
| `player_id` | bigint | Links to player |
| `refund_id` | smallint | Refund transaction ID for respec |

---

## 2. Track-Level Prerequisites (The Dependency Chain)

Keystones within each track form a **strict dependency tree**. The number
embedded in the keystone name indicates the track LEVEL required to unlock it.

### Combat Track (41 keystones)

```
SkillPoint1 → SkillPoint4 → SkillPoint8 → SkillPoint11 → ... → SkillPoint100
MaxHealth6 → MaxHealth26 → MaxHealth56 → MaxHealth77 → MaxHealth91
MaxStamina2 → MaxStamina16 → MaxStamina36 → MaxStamina66 → MaxStamina95
Hat (cosmetic unlock at max level)
```

**Key constraint**: A player with Combat level 1 CANNOT purchase MaxHealth91
directly. They must:
1. Earn XP to advance track level through each tier
2. Spend skill points at each eligible threshold
3. Purchase prerequisites before downstream keystones

### Crafting Track (41 keystones)
```
ConsumableBatchCrafting8
CraftingJackpot20 → 33 → 55 → 78 → 96
CraftingSpeedIncrease18 → 38 → 72 → 93
AugmentCraftingCostDecrease25 → 59 → 90
RecyclingJackpot16 → 35 → 69
RecyclingYield14 → 40 → 80
RefiningYield12 → 22 → 45 → 63 → 85
MaxDurabilityLossReduction5 → 28 → 48 → 66 → 83
SchematicsOnRecycling61
FragmentUpgrade52
Hat75
```

### Exploration Track (41 keystones)
```
PlayerInventorySlots1 → 25 → 50 → 77 → 100  ← MOST IMPORTANT FOR OUR BP WORK!
VehicleBoostHeatReduction3 → 15 → 30 → 59 → 90
VehicleFuelEfficiency6 → 35 → 55 → 65 → 85
VehicleHeatDissipation23 → 48 → 62 → 68 → 83 → 95
... and more
```

### Gathering Track (41 keystones)
```
YieldJackpot10 → 20 → 30 → 40 → 50 → 61 → 71 → 81 → 90 → 100
ByproductSalvage7 → 17 → 23 → 28 → 38 → 43 → 48 → 53 → 68 → 83
CompactorRange13 → 33 → 63 → 74 → 78
... and more
```

### Sabotage Track (41 keystones)
```
HeadshotDamage1 → 10 → 27 → 50 → 74 → 100
HouseCreditsBonus3 → 22 → 37 → 45 → 60 → 85
ScanningResistance12 → 32 → 55 → 69 → 98
... and more
```

---

## 3. Pre-Requisites for Granting Specializations

### 3.1 Prerequisite #1: XP → Level Mapping
We must NOT write `xp_amount` or `level` directly. The game engine computes
`level` from `xp_amount` using an XP curve. We need to discover this curve
(either from game binaries or by observing natural progression).

**What we DON'T know yet**:
- XP required per level (exponential? linear?)
- Maximum level per track
- Whether `level` is stored as integer or float (schema says `real`)

### 3.2 Prerequisite #2: Skill Points
Players earn **skill points** from character level-ups. These are spent to
purchase keystones. We cannot grant a keystone if the player has 0 skill points.

**What we DON'T know yet**:
- Where skill points are stored (separate table? `player_state` column?)
- How many skill points per character level
- Whether skill points are shared across all tracks or per-track

### 3.3 Prerequisite #3: Keystone Purchase Order
Within a track, keystones form a dependency tree. The game engine validates that
ALL prerequisites are purchased before allowing a downstream keystone.

**Example**: To grant `Combat_CombatKeystone_SkillPoint100`, the player must
already have purchased `SkillPoint1`, `SkillPoint4`, `SkillPoint8`, ... all the
way up to `SkillPoint97`. That's 29 prerequisite keystones!

**What we DON'T know yet**:
- Exact parent-child relationships (the keystone name numbers suggest linear
  progression, but some may be branching)
- Whether crossing tracks requires prerequisites (e.g., does Combat allow
  Crafting keystones without Crafting XP?)

### 3.4 Prerequisite #4: Player Must Be OFFLINE
Same constraint as augments and blueprints — specialization data is game-engine
authoritative. DB writes during online play will be overwritten or crash.

### 3.5 Prerequisite #5: Refund/Respec Mechanism
The `specialization_refund_id` table suggests a formal respec flow. We must
understand this flow before building a "reset" feature.

### 3.6 Prerequisite #6: Game Engine Validation on Login
The game server validates specialization state on player login. Inconsistent
state (keystone purchased without prerequisite, XP/level mismatch) may cause:
- Silent correction (game deletes invalid keystones)
- P34 crash (same as blueprint preview)
- Player rollback (state reverted to last valid snapshot)

---

## 4. What We CAN Do First (Low Risk)

### Phase 1: Read-Only View
- `GET /api/players/:id/specializations` — list tracks with XP/level + purchased keystones
- Display in Player tab as a read-only panel (CharacterAdminUI sub-tab)
- Zero DB writes, zero risk of corrupting game state

### Phase 2: XP Grant (if we discover the curve)
- `POST /api/players/:id/specializations/xp` — grant XP to a specific track
- ONLY if we can compute the correct `level` from `xp_amount`
- Player must be offline

### Phase 3: Keystone Grant (if we validate prerequisites)
- `POST /api/players/:id/specializations/keystone`
- Must verify: player has sufficient track level, has skill points, has prerequisites
- Player must be offline

### Phase 4: Reset/Refund (if we understand the refund flow)
- `POST /api/players/:id/specializations/reset`

---

## 5. Unknowns Requiring Investigation

| # | Question | How to Answer |
|---|----------|---------------|
| 1 | XP curve: how much XP per level? | Observe a player leveling up naturally, or extract from game binaries |
| 2 | Skill points: where stored, how many per level? | Check `player_state` columns, observe in-game |
| 3 | Keystone dependency tree: exact parent-child mapping | The keystone name numbers suggest linear progression; verify with in-game observation |
| 4 | Cross-track prerequisites: can you buy Combat keystones with 0 Combat XP? | In-game test |
| 5 | Track type enum values: is it just the 5 seen, or more? | Check PostgreSQL enum definition |
| 6 | Refund flow: what happens to XP when you respec? | In-game test or game binary analysis |
| 7 | Online behavior: do DB writes persist after login? | Test with a sacrificial player account |

---

## 6. Conclusion

**We cannot safely write to specialization tables today.** The game engine is
the authority for progression state. Unlike items (which are inert objects),
specializations are a live numeric progression system with multi-layered
validation.

The correct approach is:
1. Build the read-only view first (safe, useful immediately)
2. Discover the XP curve and keystone dependencies through observation
3. Build write operations only after validating against the game engine

This is fundamentally different from blueprints (items in a bag) and augments
(stats on items). Specializations are a **progression state machine** that we
must respect, not bypass.

