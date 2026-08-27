# Vehicle Storage Contents

Status: Current.

Vehicles → Components lists every fitted module, storage modules included. This
page covers the **View Contents** button on that tab: what it reads, why it
reads it the way it does, and how cargo is deleted.

## What the button does

When a vehicle has a storage module fitted, the Components tab header carries a
single **View Contents** button. It opens an overlay showing the
vehicle's cargo hold slot by slot — the same grid/list views, capacity summary,
and per-item grade/durability/augment detail as
[base-inventory.md](base-inventory.md)'s container contents modal, whose CSS and
layout it reuses directly.

The button is one control on the header, not one per storage card. That is not
a styling preference — it follows from the data model below.

## Where a vehicle's contents actually live

`dune.vehicles.id` is the vehicle's actor id (`dune.vehicles.id == dune.actors.id`).
The populated path to its cargo is:

```
dune.vehicles.id
  └─ dune.inventories   WHERE actor_id = <vehicle id> AND inventory_type = 0
       └─ dune.items    WHERE inventory_id = <that inventory>
```

Two things about this are easy to get wrong.

**`inventories.vehicle_module_id` and `dune.vehicle_module_inventories` are
empty.** Both exist in the shipped schema, and both look like the obvious way to
reach a storage module's contents. In a real production dump
(`.claude/dune_backup.sql`) they carry **0 of 535** and **0** rows respectively.
A query that joins through either returns nothing at all. `duneDb.js`'s
`fillItemToStorage` already carried a comment saying so, confirmed live on
2026-07-31 against a spawned Buggy with a genuine `BuggyInventory_5` fitted;
`vehicleStorage` follows the same rule and its unit tests assert that neither
identifier appears in the SQL.

Note that [vehicle-deletion.md](vehicle-deletion.md)'s cascade table lists
`inventories.vehicle_module_id → vehicle_modules.id CASCADE`. That is a correct
statement about the *schema*, and it is not the path the cargo takes: the hold
is removed via `inventories.actor_id → actors.id CASCADE` when `delete_actors`
runs.

**`inventory_type = 0` is load-bearing.** The same vehicle actor also owns
inventories with `inventory_type IS NULL` — per-component holds, two or three
per vehicle in the observed data, carrying no capacity. Dropping the filter
picks one of them roughly at random and reports an empty hold.

## One hold per vehicle

There is exactly one `inventory_type = 0` row per vehicle, and its
`max_item_count` / `max_item_volume` track the fitted storage module:

| Fitted module | max_item_count / max_item_volume |
|---|---|
| *(none)* | 0 / 0 |
| `SandbikeInventory_1` | 10 / 250 |
| `SandbikeInventory_2` | 15 / 250 |
| `BuggyInventory_3` | 20 / 1500 |
| `BuggyInventory_4` | 20 / 2000 |
| `BuggyInventory_5` | 20 / 2500 |
| `OrnithopterLightInventory_4` | 10 / 500 |
| `OrnithopterMediumInventory_5` | 20 / 2000 |

So contents cannot be attributed to a particular storage module — and do not
need to be, because capacity already comes off the inventory row. This is the
whole reason the button sits on the tab header: a per-card button would open the
same contents twice on a hypothetical two-module vehicle.

Which modules count as storage is `isVehicleStorageModule()` in `duneDb.js`, a
template-id test (`/Inventory(_Unique_Capacity)?_\d+$/i`) rather than a type
column, because storage modules are catalogued per vehicle class and tier. It is
applied server-side in `listVehicles`, so each module in the list response
carries `isStorage`.

## The route

`GET /api/vehicles/{vehicleId}/storage` → `duneDb.vehicleStorage()`.

Read-only: no `directDbMutation` wrapper, no confirmation phrase, no
map-stopped safety gating — none of the reasons the base tab needs those apply
to a view that only reads. It resolves to **`vehicles:read`** through the
existing method-agnostic `"/api/vehicles/"` prefix rule in `actions.js`, so no
new RBAC action was added; `rbacParity.test.js` pins that it resolves there
rather than to `null` (which fails closed) or to a mutate action.

The query joins **through `dune.vehicles`** rather than reading
`dune.inventories` by `actor_id` directly. That is what makes a player's or a
placeable's actor id come back as `found: false` instead of quietly serving
their inventory through a vehicles-scoped route — a placeable's storage
container sits on the identical `actor_id` + `inventory_type = 0` shape, so the
join is the only thing separating them.

### Response

```json
{ "supported": true, "found": true, "vehicleId": "2008",
  "inventoryId": "2001", "maxSlots": 20, "usedSlots": 1,
  "maxVolume": 2000, "currentVolume": 243, "volumeComplete": true,
  "slots": [ { "itemId": "501", "templateId": "JasmiumCrystal",
               "name": "Jasmium Crystal", "image": "/images/items/JasmiumCrystal.png",
               "positionIndex": 5, "quantity": 162, "qualityLevel": 0,
               "currentDurability": null, "maxDurability": null, "augments": [] } ] }
```

Flat `slots` where `GET /api/bases/{baseId}/containers/{placeableId}` carries an
`inventories[]` array — a base container can back several inventories, a vehicle
cannot. Unlike the base route, each slot carries its own `image`: there is no
vehicle equivalent of the base inventory rollup that the bases tab harvests
icons from.

`volumeComplete: false` means at least one item's per-unit volume is unknown, so
`currentVolume` is a lower bound; the overlay renders it with a leading `≥`.
`volume_override` is per-unit, multiplied by the stack size — the same
correction recorded in [base-inventory.md](base-inventory.md).

### Capability degradation

`GET /api/vehicles` reports `capabilities.vehicleStorage`, probed against all
three of `dune.vehicles`, `dune.inventories` and `dune.items`. False hides the
button entirely rather than offering one that fails on click. If the route is
called anyway, a schema gap comes back as **200 with `supported: false`** and a
`reason`, not an error status — so the overlay's Retry always means a real
failure. Individual columns degrade rather than failing the view:
`items.position_index` missing drops the grid to list only,
`items.stats` missing empties durability and augments, and
`inventories.inventory_type` missing falls back to the capacity-carrying
inventory (the component holds have none).

## Deleting cargo

The overlay can destroy cargo: a per-stack trash button, a partial removal from
the selected stack, and — behind a confirm-gated toggle — Delete Selected and
Delete All. There is no add, give, or fill: base containers are the console's
supported path for *staging* items, and a vehicle hold has no such requirement.

| Route | Action | Phrase |
|---|---|---|
| `DELETE /api/vehicles/{id}/storage/items/{itemId}` | `vehicles:delete-item` | `DELETE ITEM` |
| `DELETE /api/vehicles/{id}/storage/items` | `vehicles:bulk-delete-items` | `DELETE ITEMS` |
| `DELETE /api/vehicles/{id}/storage/all-items` | `vehicles:bulk-delete-items` | `DELETE ALL ITEMS` |

Each goes through `directDbMutation`, which supplies the confirmation phrase,
per-action rate limiting, and an audit record on success *and* failure. No
database backup is taken — these are item rows, not a whole vehicle, and a full
dump per stack deleted would make the feature unusable. A vehicle with a queued
delete is refused up front with a 409.

### Why the actions are named that way

`vehicles:delete-item` and `vehicles:bulk-delete-items` mirror the base
container pair, and both are carved out of `vehicles:mutate` deliberately: the
vehicle panel shipped with no way to destroy items, so an operator whose
hand-authored policy grants `vehicles:mutate` for roster edits and refuels
cannot have consented to item destruction. Default tiers are unaffected — owner
(`*`) and admin (`vehicles:*`) still match; moderator, player, and observer hold
only `vehicles:read`.

The bulk action is **not** `vehicles:delete-items`. `policy.js`'s `-*` wildcard
means a policy written as `vehicles:delete-item*` to grant single-stack deletion
would silently grant bulk as well (issue #351, found on the base side). The two
names share no prefix a wildcard can bridge.

The neighbouring `vehicles:delete` — destroying a whole vehicle — is a separate
action in both directions: granting cargo deletion never implies it, and
granting it never implies cargo deletion. Both directions are pinned in
`policy.test.js`.

### The blocked-state guard

Unlike base containers, cargo deletion refuses while the vehicle is in
`Travel`, `VehicleBackup`, or `VehicleRecovery`, reusing the same
`vehicleBlockedDeleteState` guard whole-vehicle delete already applies.

This was measured before it was adopted: in a real dump, 35 of 91 vehicles sit
in those states and **every one of them has an empty hold** — all 44 cargo
stacks live on vehicles with no `dune.actor_state` row. So the guard blocks
nothing that exists today. It is there to avoid racing the game's own
stash/recovery flow if that ever stops being true.

The check runs **inside the delete transaction, after the `FOR UPDATE` lock**,
in `resolveVehicleCargoHold`. A route-level pre-check would be a TOCTOU gap
dressed as a safety feature; `vehicleStorageDeleteSafety` on the read exists
only so the overlay can disable and explain its controls ahead of the click.

### Resolve, lock, verify

`resolveVehicleCargoHold(tx, vehicleId)` takes `tx`, not `db`, so the lock and
the deletes are one atomic unit. Four rules are carried over from the base
implementation, each of which cost this repo a real bug:

- **`set local search_path to dune, public` first.** `dune.delete_item` and
  `dune.delete_inventory_item` reference their tables unqualified and carry no
  `SET search_path` of their own, so against any role but `dune` they raise
  `relation "items" does not exist` — aborting the transaction before the
  raw-delete fallback can run.
- **Never `SELECT DISTINCT` with `FOR UPDATE`.** Postgres rejects the
  combination outright. The base version shipped that way and 500'd on every
  real invocation, undetected because the mocked tests pattern-match query text
  and never parse SQL. The DISTINCT lives in a CTE; the lock is taken on the
  join back to `dune.inventories`.
- **Throw on more than one hold, never `rows[0]`.** A silent success that
  leaves items behind in a second hold is worse than a loud failure. (The
  *read* path still takes the first — a display degrading is fine where a
  destructive path guessing is not.)
- **`bigintParam` for every item id.** An id past `Number.MAX_SAFE_INTEGER`
  rounds under `Number()`, and on a destructive route that means silently
  targeting a different row.

Each delete then verifies: the shipped procedure runs, the row is checked, a
raw `delete … and inventory_id = $2` fallback runs if it survived, and a final
check confirms it is gone — all re-scoped on the resolved inventory so the
fallback cannot escape it. A partial removal goes through
`dune.delete_inventory_item`, whose `NULL` return means *rejected* rather than
*no-op*, and the resulting stack is re-read and compared.

An explicit count larger than the stack is **refused, never rounded down to
"delete it all"**: the caller saw 500, asked for 400, and the stack has since
dropped to 300 — widening that would destroy more than was ever agreed to. Only
an omitted count means "the whole slot".

Bulk deletes dedupe ids after normalizing them, cap the batch at 200, and reuse
the base family's `auditDetailSelectFragment` and `finishDeletingLockedItems`,
which are already inventory-id generic. Delete-all reads its list fresh inside
the transaction that deletes it, so "all" always means what is present at lock
time, never a stale client snapshot.

### No stopped map, but a restart caveat

Deletion does **not** require the map to be stopped, matching base container
deletes. The row is gone from the database immediately; if the engine had
already claimed and loaded that row into its live state, the running map keeps
showing it until the next restart.

That is a visibility limitation, not a hazard. Inventory has **no live-sync
path** at all: no `pg_notify` channel covers it (the game's channels are guild,
landsraad, party, permission, taxation, faction, vehicle_recovery, player_info),
there are zero triggers on `dune.items`, and the RMQ command bus has no per-item
edit or delete. See [base-inventory.md](base-inventory.md) for the same caveat
on the base side.

A delete also **frees** a `position_index` rather than claiming one, so it
cannot hit the Give/Fill collision recorded in
`INC-2026-08-19-GIVE-FILL-POSITION-INDEX-COLLISION` — that incident is about
inserts racing the engine for a slot.

## Tests

- `console/api/test/db.test.js` — `vehicleStorage` unit cases against a mocked
  `db.query`: the join clauses, the `inventory_type = 0` filter, the absence of
  `vehicle_module_id`, `found: false`, per-relation capability probing, column
  degradation, augment pairing, and volume accumulation. Plus
  `isVehicleStorageModule` over every shipped module id.
- `console/api/test/vehicleStorage.integration.test.js` — real PostgreSQL, with
  the schema and its `CHECK`/FK constraints transcribed from
  `.claude/dune_backup.sql` with line citations. Seeds decoy component holds, a
  second vehicle, and a placeable container on the same link shape, and asserts
  none of them leak.
- `console/api/test/vehicleRouteStatus.test.js` — the read route's id guard, the
  400/500 split, that it stays read-only, and that it is registered ahead of the
  bare `/api/vehicles/{id}` route.
- `console/api/test/vehicleStorageMutationRoutes.test.js` — source-text: every
  delete route is dispatched, requires its confirmation phrase, audits under its
  own action, checks `vehicleDeletePending` before mutating, validates its path
  segments, takes no backup, and never `Number()`s the item id. Plus that the
  blocked-state guard sits after the `FOR UPDATE` lock inside the transaction
  and not in the routes.
- `console/api/test/vehicleStorageDelete.integration.test.js` — real PostgreSQL,
  sharing `test-support/vehicleStorageFixture.js` with the read test above. This
  is the load-bearing file: whole-slot and partial deletes, a bigint item id
  past `Number.MAX_SAFE_INTEGER`, another vehicle's and a component hold's items
  being unreachable, a placeable's container being unreachable, every blocked
  state refusing and then succeeding once cleared, and that what the overlay
  lists is exactly what Delete All removes.
- `console/api/test/policy.test.js` / `rbacParity.test.js` — each route resolves
  to its own action; cargo deletion is withheld from a `vehicles:mutate`-only
  policy; single-stack deletion carries neither bulk nor whole-vehicle delete;
  and no `-*` wildcard bridges the pair.
- `console/web/src/features/vehicles/VehicleStorageOverlay.test.tsx` and
  `VehiclesPanel.test.tsx` — the overlay's states and close paths, that the
  button appears only with both a fitted storage module and the capability, and
  the whole delete surface: refetch-not-optimistic, declined confirms calling
  nothing, the partial `count` and amount reset, controls disabled with an
  explanation on a blocked state, and the bulk toggle's reveal/hide/reset.
