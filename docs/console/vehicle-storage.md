# Vehicle Storage Contents

Status: Current.

Vehicles → Components lists every fitted module, storage modules included. This
page covers the **View Contents** button on that tab: what it reads, why it
reads it the way it does, and why it is read-only.

## What the button does

When a vehicle has a storage module fitted, the Components tab header carries a
single **View Contents** button. It opens a read-only overlay showing the
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

## Why read-only

No add, delete, give, or fill. The base tab's equivalents exist because base
containers are the console's supported path for staging items; a vehicle's hold
had no such requirement, and every mutation would need its own safety gating and
RBAC action. If that changes, `baseContainerSlots`' mutation siblings are the
model to follow — including their map-stopped `addSafety` policy.

Note also that inventory has **no live-sync path** at all: no `pg_notify`
channel and no triggers cover `dune.items`, so contents reflect the last state
written to the database. See [base-inventory.md](base-inventory.md) for the same
caveat on the base side.

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
- `console/api/test/vehicleRouteStatus.test.js` — the id guard, the 400/500
  split, that the route stays read-only, and that it is registered ahead of the
  bare `/api/vehicles/{id}` route.
- `console/web/src/features/vehicles/VehicleStorageOverlay.test.tsx` and
  `VehiclesPanel.test.tsx` — the overlay's states and close paths, and that the
  button appears only with both a fitted storage module and the capability.
