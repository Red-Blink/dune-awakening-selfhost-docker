# Specializations — Feature Specification

> **Branch**: `feature/specializations`  
> **Status**: PLANNING | **Target**: Player Tab → Specializations sub-tab

## Overview

Dune: Awakening uses a specialization system where players allocate keystones
across tracks (Combat, Survival, etc.) to unlock passive bonuses and abilities.
Admins need tooling to view, modify, and reset player specializations.

## Database Schema

| Table | Key Columns |
|-------|-------------|
| `dune.specialization_tracks` | `player_id`, `track_type`, `xp_amount`, `level` |
| `dune.purchased_specialization_keystones` | `player_id`, `keystone_id` |
| `dune.specialization_keystones_map` | Keystone definitions/reference |
| `dune.specialization_refund_id` | Refund tracking |

## Planned Features

- [ ] **View** specialization tracks and keystones per player
- [ ] **Grant XP** to specific tracks
- [ ] **Set level** directly
- [ ] **Unlock keystones** individually or by track
- [ ] **Reset/refund** specializations
- [ ] **UI integration** — new sub-tab in CharacterAdminUI

## APIs Needed

- `GET /api/players/:id/specializations` — list tracks and keystones
- `POST /api/players/:id/specializations/xp` — grant XP to track
- `POST /api/players/:id/specializations/keystone` — purchase keystone
- `POST /api/players/:id/specializations/reset` — refund and reset

## References

- `runtime/data/admin-items.json` — item catalog (may include spec-related items)
- `dune.specialization_tracks` — live data on e2e-clean stack

