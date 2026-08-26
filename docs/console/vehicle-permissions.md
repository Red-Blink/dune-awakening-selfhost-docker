# Vehicle permissions

**Status:** Current | **Last Updated:** August 2026

The Vehicles panel can edit who owns a vehicle and who it is shared with. The
editor lives in the **Permissions** tab of an expanded vehicle row, alongside
the existing **Components** tab. Both the global Vehicles panel and a player's
own Vehicles tab expand through the same `VehicleTable` component, so the tab
appears in either place once the schema supports it.

Unlike generator refills, permission changes are **not** queued for a map
restart — they reach a running map immediately. See
[Why there is no queue](#why-there-is-no-queue).

Vehicle permissions share nearly all of their implementation with
[base permissions](base-permissions.md): the same `dune.permission_actor_rank`
table, the same shipped stored procedures, the same transactional roster-diff
engine (`mutatePermissionRoster` in `duneDb.js`), and the same Transfer to
Custodian action bases have. The one deliberate difference is that these
routes have no backed-up guard, because a vehicle has no equivalent of a
base being picked up. They **do** now have a delete-pending guard — see
[vehicle-deletion.md](vehicle-deletion.md) — since vehicles can have their
own queued delete now, the same way bases can.

## Ranks

Permissions are rows in `dune.permission_actor_rank`, one per player per
vehicle:

| Rank | Label | Notes |
|---:|---|---|
| 1 | Owner | Exactly one per vehicle. Shown in the **Owner** column. |
| 2 | Co-Owner | Shown in the **Shared With** column. |
| 3 | Associate | Shown in the **Shared With** column. |

Same 5/4/3 in-game decoration note as bases: the game's own panel displays
those numbers beside the labels, but no row in `permission_actor_rank` ever
holds a 4 or 5.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/vehicles/:vehicleId/permissions` | The vehicle's roster, with resolved names and rank labels, plus `systemCustodian`. |
| `PUT` | `/api/vehicles/:vehicleId/permissions` | Replace the roster. Body: `{ entries: [{ playerId, rank }] }`. |
| `POST` | `/api/vehicles/:vehicleId/system-custodian` | Transfer ownership to the reserved system custodian. No body. |
| `GET` | `/api/vehicles/permission-candidates?q=&limit=` | Player search for the add-player picker. |

`PUT` takes a **whole roster**, not a delta, applied the same way bases'
roster save is: the server diffs it against current state and applies only
the difference, skipping an unchanged row since every write emits a
notification.

Roster saves are audited as `vehicles.set-permissions`, and the custodian
transfer as `vehicles.transfer-system-custodian`; both are rate limited. No
confirmation phrase is required by either API endpoint, matching the base
roster save and its transfer route — confirmation lives entirely in the UI's
confirm dialog, and both actions are reversible from the same editor.

## What the server enforces

Client-side rules are re-checked server-side; none of them are trusted from
the request.

- **Exactly one Owner.** The outgoing Owner is demoted first, in the same
  transaction, for the same reason as bases.
- **The roster cap**, read from live server config (see below).
- **Ranks limited to 1–3**, no duplicate players.
- **Every player id must be a `player_controller_id`** — the same canonical
  check bases use, since it validates against `player_state`/
  `encrypted_player_state`, not anything vehicle-specific.
- **The vehicle must be claimed** (see below).

## An unclaimed vehicle is refused, not attempted

Same foreign key as bases: `permission_actor_rank.permission_actor_id`
references `dune.permission_actor(actor_id)`, and a vehicle can have every
structural row intact — `dune.vehicles`, `dune.actors` — with no
`permission_actor` row. The mutation route checks for that row, inside the
transaction and after taking the actor lock, and refuses with *"This vehicle
is not claimed…"* rather than letting the write reach the constraint and
surface raw PostgreSQL text to the operator.

`GET` still succeeds on such a vehicle — the roster is simply empty — and
returns `claimed: false` plus `unclaimedReason`. The tab uses those to disable
Save, Transfer, the rank controls, and the remove buttons.

## System custodian

Vehicles share the exact same reserved custodian identity bases use — see
[base-permissions.md's System custodian section](base-permissions.md#system-custodian)
for how detection works (the RedBlink `Server` persona, falling back to
Funcom's `GM` persona, matched by a stable account/controller/state/pawn
tuple) and how the transfer preserves the rest of the roster (the outgoing
Owner is demoted to Co-Owner, not removed). There is exactly one custodian per
battlegroup — the same identity Care Packages and MOTD use — so nothing about
detection or provisioning is vehicle-specific.

The one real difference from the base route:
`POST /api/vehicles/:vehicleId/system-custodian` has no backed-up guard,
because a vehicle has no picked-up/backed-up state. It does check
delete-pending now, the same as the roster save route above — see
[vehicle-deletion.md](vehicle-deletion.md#irreversibility).

## The roster cap comes from server config

Same setting bases use — `permission_max_permissions_per_actor` — since the
cap is per **permission actor**, and a vehicle is one. See
[base-permissions.md's roster cap section](base-permissions.md#the-roster-cap-comes-from-server-config)
for the full precedence explanation
(`parseEffectivePermissionLimit`, the legacy `DuneGameMode` fallback, and the
Advanced Editor footgun). Nothing about that logic is vehicle-specific.

## A vehicle is its own permission actor

Unlike a base — whose id and permission actor id differ, resolved through a
`buildings → building_instances → actor_fgl_entities → actors` chain — a
vehicle **is** its own actor:
`dune.vehicles.id = dune.actors.id = dune.permission_actor.actor_id`. There is
no separate id to resolve and no multi-hop join.

`vehiclePermissionActor` still joins through `dune.vehicles` rather than
resolving straight off `dune.actors`, even though that adds no indirection.
That join is what rejects a non-vehicle actor id — a base's, say — passed to
this route: an id with no row in `dune.vehicles` fails the join and surfaces
as the ordinary *"That vehicle was not found"* error, the same message a
genuinely nonexistent id gets.

## Why there is no queue

Same mechanism as bases: the game ships stored procedures that notify the
running server, and the console calls those rather than writing the table
directly.

- `dune.permission_set_player_rank(actor_id, player_id, rank, map_id)`
- `dune.permission_remove_player_rank(actor_id, player_id)`

See [base-permissions.md](base-permissions.md#why-there-is-no-queue) for the
full explanation of the notify channel and why direct DML is refused.

## Capability gating

The panel hides the editor unless `listVehicles` reports
`capabilities.vehiclePermissions`. That requires the same schema base
permissions do — `dune.permission_actor_rank`, `dune.permission_actor`,
`dune.actors`, `dune.player_state`, `dune.map_names`, plus both stored
procedures — probed once per list request. `listVehicles` already proves most
of those tables exist via its own `requiredTables` check, so the capability
probe only has to verify `dune.map_names` and the two procedures on top of
that.

## Related

- [base-permissions.md](base-permissions.md) — the feature this one is
  modeled on; read it first for the parts that are identical (the notify
  mechanism, search_path, write ordering, and the roster cap).
- [vehicle-deletion.md](vehicle-deletion.md) — permanently deleting a
  vehicle; the delete-pending guard these routes now check.
- [API-REFERENCE.md](API-REFERENCE.md) — full HTTP API reference.
