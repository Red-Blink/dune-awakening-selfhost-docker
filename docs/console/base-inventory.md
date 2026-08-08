# Base Inventory

The **Inventory** tab on an expanded base row (Bases panel → expand a base → Power / Water / Inventory / Sub-Fief Permissions) lists everything stored at that base. It is read-only.

Backed by `GET /api/bases/{baseId}/inventory` → `duneDb.baseInventory()`.

## What counts as base inventory

Classification is an explicit `building_type` allowlist in `BASE_INVENTORY_TYPES` (`console/api/src/duneDb.js`), in four groups:

| Group | `building_type` (lowercased) → label |
|---|---|
| Storage | `storagecontainer` → Storage Container · `mediumstoragecontainer`† → Medium Storage Container (100 slots) · `genericcontainer` → **Chest** · `spicesilo` and `smallstoragecontainer`† → **Small Storage Container** |
| Refining | `smallorerefinery` · `mediumorerefinery` · `largeorerefinery`† · `smallchemicalrefinery` · `mediumchemicalrefinery` → matching names; `spicerefinery` → Spice Refinery · `mediumspicerefinery`† · `largespicerefinery`† |
| Crafting | `fabricator` → Fabricator · `survivalfabricator` · `vehiclesfabricator` · `weaponsfabricator` · `wearablesfabricator` → Garment Fabricator · plus `advancedsurvivalfabricator`†, `advancedvehiclefabricator`† (singular), `advancedweaponsfabricator`†, `advancedwearablesfabricator`† → Advanced … |
| Machines | `recycler` → Recycler · `repairstation` → Repair Station |

All suffixed `_placeable`. † marks a type not present in any database seen so far — it is in the allowlist because the game ships it, not because it has been observed in use.

Every string was verified against the shipped server paks, where each building carries a `DA_BLD_<building_type>.uasset`:

```bash
docker exec dune-server-survival-1 bash -c 'cat /home/dune/server/DuneSandbox/Content/Paks/*.pak | grep -aoE "DA_BLD_[A-Za-z0-9_]+_Placeable" | sed "s/^DA_BLD_//" | sort -u'
```

That is what caught `AdvancedVehicleFabricator_Placeable` being **singular** while its own base building, `VehiclesFabricator_Placeable`, is plural. The reverse does not hold: the extraction is lossy — `SpiceSilo_Placeable`, `SmallOreRefinery_Placeable` and `Fabricator_Placeable` all fail to appear despite being live on the same server, and a handful of results come back truncated at compression boundaries (`MediumorageContainer_Placeable`, `RepairSta_Placeable`). Presence is proof; absence is not.

`SpiceSilo_Placeable` and `SmallStorageContainer_Placeable` are both listed and both labelled "Small Storage Container": the former is the legacy name every live placement still carries (48 on production against 0 of the latter), the latter is the asset name shipped in the paks. Anything not listed is omitted rather than bucketed, matching the allowlist reasoning in `portalGeneratorFuel`'s `generator_spec` CTE — an unrecognised placeable must not acquire a group and report an invented fill level.

Generator and windtrap fuel is deliberately absent; the Power and Water tabs own it.

## Why not classify on `inventory_type`

`dune.inventories.inventory_type` almost separates these groups on its own — verified against a real dump (373 placeables, 535 inventories, 493 `dune.actor_inventories` rows):

| `inventory_type` | `component_name_hash` | What it is |
|---|---|---|
| 4 | `1264785389` | Storage containers — `StorageContainer` 45 slots, `GenericContainer` 20, `SpiceSilo` 10 |
| 12 | `710548` and `26344419` | Refinery and fabricator inventories, two per placeable (split into the Refining and Crafting groups) |
| 3 | `1264785389` | Fuel and module slots — generators, wind turbines, windtraps — **and** `Recycler` and `RepairStation` |

Keying on the type would file a 25-slot `Recycler` — which held more items than anything outside storage in the reference dump — under "fuel", alongside the oil generators the Power tab already covers. Hence the building-type allowlist.

## The second refinery inventory

Every refinery and fabricator carries **two** `inventory_type = 12` inventories:

- `component_name_hash = 710548`, `max_item_count` 5 or 10 — holds the ore and crafting inputs.
- `component_name_hash = 26344419`, `max_item_count = -1` — empty on all 44 of them in the reference dump.

The query filters `inv.max_item_count >= 0`, which drops the second one. That agrees with the hash split on every row and avoids depending on `dune.actor_inventories`; it also keeps a slot bar from dividing by a negative capacity.

## Container names

`dune.permission_actor.actor_name` holds `'##' || building_type` for any placeable a player has never renamed, and whatever the player typed otherwise (real examples from the dump: "Ore Storage", "Aluminum Refinery", "Refinery Output NO ORES"). The query strips the `##`-prefixed defaults and `'None'`, exactly as `listStorage` does, and returns `""`; the frontend falls back to `<type name> #<placeable id>`.

The game stores **no** display name for a placeable *type*, so the type labels in `BASE_INVENTORY_TYPES` are this console's own. Where a `building_type` disagrees with the player-facing name, the catalog patent in `runtime/data/admin-items.json` wins — it is the same source the console already uses for item names.

`SpiceSilo_Placeable` is the case that matters. Its patent is named **"Small Storage Container"**, and the data agrees: across the 40 of them in the reference dump, 195 of 198 item rows were *not* spice — clothing, tools, ingots, bloodsacks. It is a general-purpose 10-slot container, and "Spice Silo" is only the internal blueprint name (`BP_SpiceSiloContainer`). The tab labels it "Small Storage Container".

Every label was ultimately read off the in-game build menu. Two would have been guessed wrong from the data alone, and both are worth recording:

**`GenericContainer_Placeable` is "Chest", not "Medium Storage Container".** Its 20 slots sit exactly between the confirmed 10-slot Small and 45-slot Storage Container, so the capacity ladder argues convincingly for "medium" — and is wrong. The real Medium Storage Container is a separate building with **100 slots**, which puts it *above* Storage Container rather than between.

**The fabricators are nine buildings, not five.** The plain and Advanced variants coexist in the build menu. The catalog cannot be taken at face value here: `SurvivalFabricator_Patent` is *named* "Advanced Survival Fabricator Patent" while a distinct `AdvancedSurvivalFabricator_Patent` carries the same display name, so one of the two entries is simply wrong. Reading the duplicate as "there is only an advanced tier" produces four wrong labels.

`SpiceRefinery_Placeable` is plain "Spice Refinery"; Medium and Large are separate buildables, unlike the size-prefixed ore refineries.

## Why read-only

Base inventory writes have no live-sync path:

- No `pg_notify` routine covers inventory or buildings. The game's 8 notify channels are guild, landsraad, party, permission, taxation, faction, vehicle_recovery, player_info.
- There are zero triggers on `dune.items`, `dune.inventories`, `dune.buildings`, `dune.placeables`.
- The RMQ command bus has no per-item edit or delete. `AddItemToInventory` addresses items by *template name*; every id here is a row id.

So an edit could not reach a running map without a relog or a map restart. The tab states this inline rather than offering writes that would silently not apply.

## Response shape

```
{ supported, baseId,
  groups:     [{ key, name, containerCount, itemCount }],
  containers: [{ placeableId, name, typeName, group, usedSlots, maxSlots, itemCount,
                 items: [{ templateId, name, quantity }] }],
  items:      [{ templateId, name, image, category, quantity, containerCount,
                 containers: [{ placeableId, name, typeName, group, quantity }] }],
  totals:     { items, distinct, containers, usedSlots, maxSlots } }
```

One response backs both views, so switching between Items and Containers never refetches. Item `name`/`category` come from `adminItemMetadata()` over `runtime/data/admin-items.json`, falling back to the raw `template_id`; `image` resolves through `itemImagePath()` and falls back to `image-unavailable.png`.

`usedSlots` counts item *rows* — one stack occupies one slot — while `quantity` sums `stack_size`. Capacity is summed once per inventory, not per item row, since every row repeats its inventory's `max_item_count`.

**A container's `items[]` is not its stacks.** Rows sharing a template are merged into one entry, so `items.length` is the number of distinct templates and is **≤ `usedSlots`**. On the reference base, Chem Storage fills 8 slots with 3 templates, and 5 of 17 containers disagree the same way. The UI therefore says "3 distinct", never "3 stacks" — the stack count is `usedSlots`, already shown as Slots Used. The type is named `BaseInventoryEntry` rather than `…Stack` for the same reason.
