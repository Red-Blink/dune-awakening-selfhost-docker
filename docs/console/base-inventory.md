# Base Inventory

**Status:** Current | **Last Updated:** November 2026

The **Inventory** tab on an expanded base row (Bases panel → expand a base → Power / Water / Inventory / Land Claim Editor / Sub-Fief Permissions / Base Permissions) lists everything stored at that base. Reads are a snapshot; a container's contents can be opened per slot and individual items deleted.

Backed by `GET /api/bases/{baseId}/inventory` → `duneDb.baseInventory()`, plus
`GET /api/bases/{baseId}/containers/{placeableId}` → `duneDb.baseContainerSlots()` for one container's
slots and `DELETE …/containers/{placeableId}/items/{itemId}` to remove one.

## What counts as base inventory

Classification is an explicit `building_type` allowlist in `BASE_INVENTORY_TYPES` (`console/api/src/duneDb.js`), in four groups:

| Group | `building_type` (lowercased) → label |
|---|---|
| Storage | `storagecontainer` → Storage Container · `mediumstoragecontainer`† → Medium Storage Container (100 slots) · `developer_storagecontainer` → Developer Storage Container · `genericcontainer` → **Chest** · `spicesilo` and `smallstoragecontainer`† → **Small Storage Container** |
| Refining | `smallorerefinery` · `mediumorerefinery` · `largeorerefinery`† · `smallchemicalrefinery` · `mediumchemicalrefinery` → matching names; `spicerefinery` → Spice Refinery · `mediumspicerefinery`† · `largespicerefinery`† |
| Crafting | `fabricator` → Fabricator · `survivalfabricator` · `vehiclesfabricator` · `weaponsfabricator` · `wearablesfabricator` → Garment Fabricator · plus `advanced_survivalfabricator` and `advanced_vehiclesfabricator` (literal underscore after `Advanced`, vehicles plural; both confirmed on real placed buildings), and `advancedweaponsfabricator`†, `advancedwearablesfabricator`† (no underscore) → Advanced … |
| Other | `recycler` → Recycler · `repairstation` → Repair Station · `totem_small` → **Sub-Fief Console** · `totem` → **Advanced Sub-Fief** |

All suffixed `_placeable`. † marks a type not present in any database seen so far — it is in the allowlist because the game ships it, not because it has been observed in use.

`totem_small_placeable` and `totem_placeable` are the base's own claim structure — the totem, not a building placed inside the base. It carries a real 5-slot `dune.inventories` row like everything else here, reached through the same `placeables.owner_entity_id` join with no special-casing. Confirmed directly against a live restore of `kovalt_test.backup` rather than the paks grep below (the paks extraction is known-lossy, see below): 17 `totem_placeable` and 2 `totem_small_placeable` rows, each backed by a 5-slot inventory; base 3438's `totem_placeable` held 1 item (qty 83) and came back through the production `baseInventory` query unmodified. Display names are the catalog patent's, matching every other label in this table: `Totem_Small_Patent` is "Sub-Fief Console", `Totem_Patent` is "Advanced Sub-Fief".

Every string was verified against the shipped server paks, where each building carries a `DA_BLD_<building_type>.uasset`:

```bash
docker exec dune-server-survival-1 bash -c 'cat /home/dune/server/DuneSandbox/Content/Paks/*.pak | grep -aoE "DA_BLD_[A-Za-z0-9_]+_Placeable" | sed "s/^DA_BLD_//" | sort -u'
```

That is what established the plural `VehiclesFabricator_Placeable`. The pak asset names for the Advanced Survival and Vehicles fabricators do not match the instantiated `building_type` (real placements carry `Advanced_SurvivalFabricator_Placeable` and `Advanced_VehiclesFabricator_Placeable`), so pak presence proves an asset exists, not the exact instantiated string. The reverse does not hold: the extraction is lossy — `SpiceSilo_Placeable`, `SmallOreRefinery_Placeable` and `Fabricator_Placeable` all fail to appear despite being live on the same server, and a handful of results come back truncated at compression boundaries (`MediumorageContainer_Placeable`, `RepairSta_Placeable`). Presence is proof; absence is not.

`Developer_StorageContainer_Placeable` was verified from a live server database (9 placements). It is included explicitly in the Storage page, Live Map storage markers, and this base inventory allowlist; it is not inferred from `inventory_type`.

`SpiceSilo_Placeable` and `SmallStorageContainer_Placeable` are both listed and both labelled "Small Storage Container": the former is the legacy name every live placement still carries (48 on production against 0 of the latter), the latter is the asset name shipped in the paks. Anything not listed is omitted rather than bucketed, matching the allowlist reasoning in `portalGeneratorFuel`'s `generator_spec` CTE — an unrecognised placeable must not acquire a group and report an invented fill level.

Generator fuel and windtrap filters are deliberately absent; the Power tab owns them. Stored water on windtraps is owned by the Water tab.

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

## Deleting a stored item

A container's contents overlay can delete a whole stack, or part of one. Backed by
`DELETE /api/bases/{baseId}/containers/{placeableId}/items/{itemId}` → `duneDb.deleteBaseContainerItem()`,
body `{ confirmation: "DELETE ITEM", count? }`. Omit `count` to clear the slot; pass a smaller number to
remove part of the stack. Whole-slot removal goes through the shipped `dune.delete_item(bigint)`, partial
through `dune.delete_inventory_item(bigint, bigint)`.

**A count larger than the stack is refused, not rounded down.** "Remove 400" and "remove everything" are
different requests, and the gap between them is a real race: the operator saw 500, asked for 400, and the
stack has since dropped to 300. Widening that into destroying all 300 would remove more than was ever
agreed to. The overlay is a snapshot, so this case is reachable in normal use.

**Ownership is re-resolved, never trusted.** The delete re-runs this page's claim CTEs from the base id
rather than believing the `placeableId` it was handed, and keeps the `inventory_types` allowlist join plus
`is_hologram = false` and `max_item_count >= 0`. That allowlist is what stops a delete reaching the
generator fuel and windtrap filter inventories the Power tab owns — a placeable outside
`BASE_INVENTORY_TYPES` answers "not found" even when it genuinely belongs to the base.

The row lock is `for update of i, inv`, not a bare `for update`: Postgres cannot lock a CTE reference, and
locking only the item row locks nothing once that row is gone.

`DELETE …/items/{itemId}` requires its own IAM action, **`bases:delete-item`**, separate from the
`bases:mutate` bucket every other base mutation falls into. The reason differs from
[`bases:delete`](base-deletion.md)'s: not blast radius, but consent. This tab shipped read-only, so an
operator whose hand-authored policy grants `bases:mutate` agreed to refills and permission edits and could
not have agreed to item destruction — folding this in would silently widen every existing narrow policy.
The shipped `owner`/`admin` policies grant `bases:*`, so default access is unchanged.

Both of the usual base preconditions apply: a base with a queued delete, or one picked up via the game's
base-backup tool, rejects this with `409`.

## Adding a stored item

The same overlay can put an item into a plain Storage container. Backed by
`POST /api/bases/{baseId}/containers/{placeableId}/items` → `duneDb.addBaseContainerItem()`, body
`{ confirmation: "ADD ITEM TO CONTAINER", itemId | itemName, quantity, quality?, augments?, augmentQuality? }`.
The parameter surface is `giveItemToStorage`'s, so a catalog-resolved item drops straight in — except that
`quality` is bounded 0–5 here. `giveItemToStorage` allows 0–1000000, which is an outlier: every other path
and the whole UI treat grade as 0–5.

**Every add creates a new row. It never tops up a matching stack.** Adding 300 ScrapMetal to a container
that already holds 500 leaves two rows, not one of 800. Add deliberately creates one new stack and clamps
it to the catalogued per-item stack limit instead of choosing an existing row to grow.

**The slot is not chooseable.** In a slot-capped inventory the row lands in the lowest free in-range slot;
an uncapped inventory falls back to `max(position_index) + 1`. Clicking an empty grid cell is a shortcut to
the form, not a placement target, and nothing in the UI may promise a specific slot: the empty cell's
accessible name is "Add an item to this container", and the confirm dialog's Slot line reads "Next free
slot". The response reports where it actually landed, which is a statement of fact rather than a promise.

**Capacity is refused at `count(*) >= max_item_count`.** Rows, not summed stack sizes — correct precisely
because nothing merges, so one add always consumes exactly one slot. A `max_item_count` of 0 is treated as
uncapped, matching `giveItemToStorage` and `giveItemToPlayer`; no shipped storage type has one. Because this
path deliberately places exactly one row in one slot, an item with catalogued stack data (issue yacketrj/dune-awakening-selfhost-docker#430) has an
oversized quantity **clamped to one full stack** (reported via `requested`/`clamped` and named in the
response message) rather than split across rows the way Give/Fill splits.

**Durability is left alone.** The insert calls `buildItemStats` without a durability argument, so clothing
and weapons get the usual 100/100 fallback while ore, spice and salvage get an empty stat block — which is
what real resource rows look like. Stamping `MaxDurability` onto a stack of ScrapMetal would invent state
the game never wrote, and the read path would then render a durability bar for it.

Ownership is re-resolved from the base id through the same CTE chain the delete uses, with the same
`inventory_types` allowlist, `is_hologram = false` and `max_item_count >= 0` filters — so a generator's fuel
inventory answers "not found" here too.

The row lock is `for update of inv`, taken **before** the capacity and next-slot reads. That ordering is the
whole concurrency argument: `db.transaction` issues a bare `begin`, so this runs at READ COMMITTED, where a
second adder blocks on the lock and then re-evaluates rather than aborting — its `count(*)` and occupied-slot
read are fresh statements that see the first insert. There is no unique constraint on
`(inventory_id, position_index)`, so this reasoning is the only guard; every console path that inserts into
`dune.items` takes this same lock first, and the delete's `for update of i, inv` is what serializes a delete
against an add. Reading the occupied set rather than blindly appending also keeps Add inside the slot grid
after Give has claimed the highest in-range slot.

Unlike the delete, this path sets **no** `search_path`. That line exists there because the shipped
`dune.delete_item`/`dune.delete_inventory_item` carry none of their own; the add invokes no procedure at
all, so its absence is deliberate.

`POST …/items` requires its own IAM action, **`bases:add-item`**, for the same consent reason as
`bases:delete-item` read in the other direction: a `bases:mutate` grant predates any ability to put items
into a base at all, so it cannot be read as consent to fabricate them. The same two base preconditions
apply — a queued delete or a backed-up base rejects with `409`.

## Why adding a stored item requires a stopped map

Adding is not queued: a specific inventory row may move, merge, or disappear before a deferred operation
runs. Instead, the add route refuses the write until it can verify the owning map is safely down. This is
upstream's own route (`addBaseContainerItem`, upstream PR #172) and this fork keeps its original design
rationale exactly as upstream shipped it, rather than retroactively applying this fork's own later delete/
Give/Fill findings (below) to a route this fork did not author. See "Deletion, Give, and Fill do not
require a stopped map" for why those other write paths reached a different, evidence-based conclusion for
themselves specifically.

## Deletion, Give, and Fill do not require a stopped map

None of the delete routes (`DELETE …/items/{itemId}`, Delete Selected, Delete All), nor Give or Fill
(`POST …/give-item`, `give-items`, `fill-item`, this fork's own #347 work), require the owning map to be
stopped. An earlier version of delete refused all three until it could verify a safely-stopped map, on the
theory that a running map's own in-memory/autosave state could resurrect or conflict with a row deleted
out from under it. Extensive live testing (the same investigation that produced
`docs/incidents/INC-2026-08-19-VOLUME-OVERRIDE-DOUBLE-MULTIPLIED.md`) found two things that together make
that theory wrong:

- The standalone Storage tab's own delete route (`storageRemoveItemsRoute` → `duneDb.removeItemsFromStorage`)
  has **never** gated on map state at all, and has been tested for hours and shipped without incident. This
  is the established precedent this feature now matches.
- The live game engine only reads/claims a container's item rows from Postgres **at server startup** — proven
  directly by incident `INC-2026-07-31-001`'s audit-trigger
  evidence, never mid-session. A database-side delete while the map stays running is therefore exactly as
  safe as Give/Fill's own inserts already are (see "Why Give/Fill do not require a stopped map" below): the
  change is durably correct in the database immediately, it simply is not reflected in whatever the live map
  still shows until the next restart.

- No `pg_notify` routine covers inventory or buildings. The game's 8 notify channels are guild, landsraad, party, permission, taxation, faction, vehicle_recovery, player_info.
- There are zero triggers on `dune.items`, `dune.inventories`, `dune.buildings`, `dune.placeables`.
- The RMQ command bus has no per-item edit or delete. `AddItemToInventory` addresses items by *template
  name*, and it addresses a **player**, not a base container — so it is not an escape hatch for delete,
  Give, or Fill either. Every id here is a row id.

So a running map can neither miss a delete/Give/Fill write nor resurrect a deleted row on its next
autosave. `baseContainerDeleteSafety()` in `server.js` now only enforces the Storage-vs-Crafting/Refining
group restriction below for delete — its map-liveness check was removed entirely, not merely relaxed.
`deleteSafety.safe` is therefore always `true` for a Storage-group container regardless of whether its
owning map is running. The response shape (`deleteSafety: { safe, known, map, partitionId, reason }`) is
kept as-is on every caller, so this stays a single, easy-to-find place to reintroduce a map-state check if
a real live-sync hazard is ever found for deletion specifically. Give and Fill were never gated on map
state at all (see "Why Give/Fill do not require a stopped map" below).

`addSafety`, by contrast, is upstream's own gate and is unaffected by any of the above — it still resolves
from a real liveness probe (`baseContainerAddSafety()`, `resolveBaseContainerAddSafety()`) and still
refuses the write when the map is running or unverifiable. The container GET response carries both
`deleteSafety` and `addSafety` side by side with the same shape, but they are deliberately **not**
structurally derived from one shared resolve any more — see the comment above
`BASE_CONTAINER_ADD_WORDING` in `server.js` for why the two policies are kept explicitly separate rather
than unified. The overlay disables the Add control and explains why when the map is running or its state
cannot be verified; the delete/Give/Fill controls are never disabled for this reason. Each route repeats
its own check (or lack thereof) immediately before changing the database, so a stale or hand-built request
cannot bypass the UI.

Every write covered by this document is limited to plain **Storage** containers. Refinery and fabricator
inventories are visible but read-only because the game's crafting state can reference their item rows;
removing a reserved ingredient can leave an active job pointing at an item that no longer exists, and
adding or inserting a row into a job's inventory is no safer. This restriction applies identically to Add,
delete, Give, and Fill, and is unrelated to map state.

Item identifiers remain decimal strings from the URL through the PostgreSQL query. They are `bigint` values,
and converting one to JavaScript `Number` could round an id above `Number.MAX_SAFE_INTEGER` into a different
row — unacceptable for a destructive operation.

## Response shape

```
{ supported, baseId,
  groups:     [{ key, name, containerCount, itemCount }],
  containers: [{ placeableId, name, typeName, group, usedSlots, maxSlots, currentVolume, maxVolume, itemCount,
                 items: [{ templateId, name, quantity }] }],
  items:      [{ templateId, name, image, category, quantity, containerCount,
                 containers: [{ placeableId, name, typeName, group, quantity }] }],
  totals:     { items, distinct, containers, usedSlots, maxSlots, currentVolume, maxVolume } }
```

One response backs both views, so switching between Items and Containers never refetches. Item `name`/`category` come from `adminItemMetadata()` over `runtime/data/admin-items.json`, falling back to the raw `template_id`; `image` resolves through `itemImagePath()` and falls back to `image-unavailable.png`.

`usedSlots` counts item *rows* — one stack occupies one slot — while `quantity` sums `stack_size`. Capacity is summed once per inventory, not per item row, since every row repeats its inventory's `max_item_count`.

**`currentVolume`/`maxVolume` (issue #356) are column-probed the same way `positionIndex`/`qualityLevel` are
in "Per-container slots" below** — a schema without `dune.inventories.max_item_volume` or
`dune.items.volume_override` degrades both to `0` rather than failing the tab, and the UI shows "—" instead
of a percentage, or withholds the row entirely on a per-container card, whenever `maxVolume` is `0`.
`currentVolume` sums `volume_override × stack_size` per inventory, since `volume_override` itself stores
each item's **PER-UNIT** volume, not a per-stack total (see "`volume_override` is per-unit, not per-stack"
below for why) — the same convention `giveItemToStorage`/`fillItemToStorage` use for their own volume-cap
checks (see "Both Give and Fill enforce the same slot and volume caps" below), so a displayed volume total
always agrees with what the next give/fill against that container will actually enforce.

**Why this exists instead of a backfill:** an item given via the storage give-item route before it started
recording `volume_override` (or given directly by the game engine) has a permanent `NULL` there, which
every `sum(coalesce(volume_override, 0))` query already treats as `0` — so a pre-existing container's real
volume usage was silently invisible rather than wrong. A one-time backfill script was considered and
rejected: it would mean running an `UPDATE` against every operator's live `dune.items` table on their next
pull, which is exactly the update-path risk Strict Requirement 0/26 exist to catch for a LOW-MEDIUM
accuracy gap in a capacity message, not a data-integrity or security issue. Surfacing the real, current
total directly — rather than trying to reconstruct history that was never recorded — was judged the lower-risk
fix.

**A container's `items[]` is not its stacks.** Rows sharing a template are merged into one entry, so `items.length` is the number of distinct templates and is **≤ `usedSlots`**. On the reference base, Chem Storage fills 8 slots with 3 templates, and 5 of 17 containers disagree the same way. The UI therefore says "3 distinct", never "3 stacks" — the stack count is `usedSlots`, already shown as Slots Used. The type is named `BaseInventoryEntry` rather than `…Stack` for the same reason.

This merge is deliberate and stays: `items[]` is what backs the "N distinct" label and the container search
filter, both of which genuinely mean distinct templates. The per-slot truth lives in a second response.

## Per-container slots

```
GET /api/bases/{baseId}/containers/{placeableId}
{ supported, found, baseId, placeableId, typeName, group, maxSlots, usedSlots, maxVolume, currentVolume,
  inventories: [{ inventoryId, maxSlots, usedSlots, maxVolume, currentVolume,
                  slots: [{ itemId, templateId, name, positionIndex, quantity,
                            qualityLevel, currentDurability, maxDurability,
                            augments: [{ templateId, name, qualityLevel }] }] }],
  deleteSafety: { safe, known, map, partitionId, reason },
  addSafety:    { safe, known, map, partitionId, reason } }
```

`maxVolume`/`currentVolume` follow the exact same convention as `baseInventory`'s own totals above — summed
once per inventory, column-probed, degrading to `0`/`0` on a schema without volume support.

**Fetched per container, not with the tab.** Folding slots into `baseInventory` tripled that response —
238 KB to 656 KB on the largest base in the reference dump, +176% — on a tab that loads on every base
expand and auto-refresh, while the overlay only ever shows one container. One container is under a
kilobyte.

**Slots hang off an inventory, not the container.** A placeable can back more than one surviving inventory:
`container.maxSlots` is their sum, while `position_index` is scoped to a single inventory. A flat
per-container array would collide two slot 0s on anything with two inventories.

`itemId` is `dune.items.id` — the delete target, and the only stable key, since `templateId` repeats within
a container. `currentDurability`/`maxDurability` come out of the `stats` jsonb using the same expression as
`INVENTORY_ITEM_SELECT`, so the two paths cannot disagree about where durability lives.

`positionIndex`, `qualityLevel` and the durability pair are all **column-probed**, not assumed: a missing
column is a parse-time error rather than a null, so a schema without them would 500 a container that used
to open. They come back null instead, and the grid view is withheld.

`augments` reads the same `FAugmentedItemStats` jsonb shape the add path writes
(`AppliedAugments[].Name` paired positionally with `AppliedAugmentQualities`), resolving each augment's
template id through the same item-name catalog as everything else. Always an array — empty for an
unaugmented item, never null or missing — so the frontend's "does this item have any" check is a plain
length test. A row with more augment names than qualities (or the reverse) pairs positionally and stops at
the shorter array rather than throwing; a display path degrades, it does not 500 a container that used to
open over one corrupt row.

### The contents overlay

Opened by **View Contents**, either on a container card or on any container listed under an expanded
item in the Items view — the same overlay, reached either way.

It offers two views, and **opens on Grid**:

- **Grid** lays the container out at its real capacity, one cell per slot, with empty slots marked by a
  plus. It is the closest thing to the in-game container and answers "what is in this box" at a glance.
  Each empty cell is a button that opens the add panel, labelled "Add an item to this container" — never
  naming a slot, because clicking it does not choose one. The plus itself is decorative, drawn as two
  positioned bars rather than a `+` glyph, since a glyph centres on its line box rather than its ink.
  Empty cells carry `tabIndex={-1}`: a 45-slot container holding three items would otherwise wedge 42 tab
  stops between the grid and the controls below it. Grid has no standalone Add Item control — the
  keyboard route there is the **List** toggle, then the footer button below.
- **List** is one row per slot with its slot number, quantity and a delete button. It sorts and scans
  better on a full 100-slot container, and is the automatic fallback whenever the grid is withheld.
  It enumerates *occupied* slots only, so it has no empty cell to click — which is why **Add Item**
  appears at the bottom-left of the dialog's footer, opposite Close, in this view only. Grid does not
  repeat it: its empty cells are already the add affordance, and a second control doing the same thing
  would be redundant.

**The footer's Add Item and Close are both hidden while the add panel is open**, not merely disabled — the
panel's own "Add to container" / Cancel row is the effective footer in that state, and repeating Close next
to Cancel (which already returns to the slot view) would be a second, redundant way to leave. The overlay
itself is still closable from here: the header's `×` and Escape both work throughout.

Selecting a slot — a grid cell or an item name in the list — moves its controls into a strip below,
carrying the item, its slot, grade and durability, an amount field defaulting to the whole stack, and the
delete button. A second line lists the item's augments with their own per-augment grade, present only on a
slot that actually has any — most items are unaugmented, so most selections show no second line at all.
One strip rather than a control per row: a packed 100-slot container would otherwise render a hundred
quantity inputs.

**Add Item replaces the slot region rather than stacking under it.** `ItemCatalogSelector` brings roughly
300px of its own category select, filter and scrolling grid; below an already-scrolling slot list that sum
pushed the dialog's own actions off screen. Swapping keeps the height envelope identical in both modes. The
add panel and the slot-detail strip are therefore two modes of one dialog, not two panels: opening either
closes the other, and the strip is keyed to an existing occupied slot so it could not represent an add
anyway. Both are cleared when the overlay is closed or a different container is opened.

The panel itself: a header (title, live "N / M slots used" count), a permanent note stating the two
contracts the backend enforces ("appends to the next free slot… never topped up"), the catalog picker, then
a controls row of Quantity, Grade, and — only for an item category that can carry them — Augments plus its
own Aug. Grade, all sized to match (the shared `AugmentDropdown` component ships its own slightly different
padding/border/background by default, overridden here to line up; a native `<select>` also renders a couple
px taller than a plain `<input>` at identical padding, a browser quirk fixed with an explicit height rather
than chased through padding). The catalog picker's own list view is narrower here than in its full-page
uses elsewhere (Care Package, Player give-items): Item ID and Source are dropped to fit, leaving Preview,
Item Name and Category — the dropped fields are still shown once an item is picked, in the panel's own
selected-item summary.

Every inventory shares a single scroll region, so a placeable backing two inventories does not get two
independent scrollbars.

### position_index is not trustworthy

`dune.items` has no unique constraint on `(inventory_id, position_index)`, and nothing bounds the value by
`max_item_count`. All three of these are reachable, and the grid handles each rather than dropping a slot —
an item the delete control cannot reach is the worst outcome available:

| Case | Handling |
|---|---|
| Sparse / non-contiguous | Empty cells. This is the in-game look and the point of the view. |
| Two slots claim one index | First by `(positionIndex, itemId)` takes the cell; the other is listed as unplaced. |
| Index ≥ `maxSlots` | Listed as unplaced beneath the grid. |

The grid is also withheld when capacity is 0, above a 200-cell cap, or when every `positionIndex` is null;
the list stands in and can still delete.

A stack of exactly 1 shows no quantity badge in the grid — the badge is gated on `quantity > 1`, so a
single item renders as a bare icon.

## Adding items: Give, Give Multiple, and Fill

Storage containers only — the same allowlist restriction as deletion, one section down. The overlay's
Give/Fill panel is offered whenever `group === "storage"`; it does not additionally require
`deleteSafety.safe`, unlike every delete action on this page. See "Why Give/Fill do not require a stopped
map" below for why that asymmetry is deliberate, not an oversight.

**The whole Give/Fill panel, AND the bulk-delete surface (Delete Selected, Delete All, and the per-row
multi-select checkboxes that feed Delete Selected), are hidden by default, behind one shared explicit
visibility toggle.** Added 2026-08-19 per explicit operator direction: Give/Fill is a powerful,
item-creating capability, and Delete Selected/Delete All are powerful, irreversible, multi-item destructive
capabilities — an operator who only wants to view a container's contents should not have to see (or
accidentally interact with) any of them every time a container is opened. Widened the same day to also
cover bulk delete, correcting a real oversight: the toggle originally gated only the Give/Fill panel, and
Delete Selected/Delete All continued to render whenever the container's existing `deleteAllowed` check
passed, regardless of the toggle's own state. A labeled checkbox (`Give / Fill / Delete Controls`, reusing
the app's shared `.switch-checkbox` pattern already used by Admin Tools' Daily Restart/Restart Queue
toggles) sits above the panel; it defaults to **off** every time the contents overlay is freshly opened —
the toggle's own state is not persisted across closing and reopening the overlay, or across switching to a
different container, matching every other piece of this overlay's own reset-on-open state
(`selectedSlotId`, `checkedItemIds`, `addFillMode`, `selectedItem`, `addBatch`).

**This toggle does NOT gate the single-item delete strip** — the per-row trash icon next to each item, or
the selected-slot detail panel's own Remove/Delete-stack button. That is a single, already-visible-item,
one-click action, not a bulk or item-creating one, and stays exactly as exposed as it was before this
toggle existed.

Turning the toggle **on** requires acknowledging an explicit confirm dialog first — it does not silently
reveal anything. The dialog restates the restart-visibility fact the in-panel warning banner already
states (see "Why Give/Fill do not require a stopped map" below and `INC-2026-07-31-001`), adds an
explicit, actionable recommendation to configure an automated **Daily Restart** from **Admin Tools →
Schedule Server Restart → Daily Restart** so given/filled items do not sit invisible in-game indefinitely,
and — since widening the toggle to also cover bulk delete — states plainly that Delete Selected and Delete
All are also revealed by this same toggle and are irreversible. The dialog's own `warning` field
additionally restates Fill's documented position_index collision risk (see "Give fills from the high
end..." below). Declining the dialog leaves the toggle off and everything it gates hidden. Turning the
toggle back **off** is instant and asks nothing — hiding a capability is never the risky direction, only
revealing it is.

Clicking an item already in the container (see "Clicking an item already in the container..." below) reveals
the panel through this same confirm-and-warn path if it is currently hidden, with that item already
pre-filled — the click is not a silent bypass of the toggle's own confirmation.

**Give and Fill share one item picker and one quantity field, switched by a `Give`/`Fill` mode toggle —
not two separate panels.** An earlier version rendered a full combobox+quantity+button row for Give and a
second, visually identical one for Fill, stacked vertically. Once Give and Fill were restricted to the
same three item groups (below), the two rows showed identical candidate items with nothing explaining
when to use which — reported directly by a real operator as confusing. The current layout is one shared
`ItemCatalogCombobox` + quantity `input`, with a `Give`/`Fill` segmented toggle (the same visual pattern as
the contents overlay's own List/Grid toggle) selecting which action the shared row submits to and which
action-specific affordance renders beneath it:
- **Give mode** shows "Add to Batch" and the queued-items list — Give's batch capability (below) is fed by
  the shared fields instead of its own dedicated ones.
- **Fill mode** shows "Fill Amount" and "Fill to Capacity" — Fill's capacity sentinel (below) is unchanged.

**Switching modes resets the quantity field to that mode's own default (`1` for Give, `100` for Fill), but
persists the selected item.** Any item valid in one mode is valid in the other (both filter to the same
`FILLABLE_GROUPS`), so there is nothing to gain by clearing the selection on a mode switch — it previously
forced an operator who glanced at Fill and switched back to Give to re-search the same item. The quantity
field still resets on every switch (a half-typed Give quantity must never be silently submitted as a Fill
quantity, or vice versa), and a queued Give batch is **not** cleared by switching to Fill and back — an
operator should be able to check Fill without losing in-progress batch work.

**Below the toggle sits one lightly-bordered mode-hint group and, below that, one bordered warning
banner** — never more than two notice elements at once, in either mode. The mode-hint group
(`.bases-inventory-mode-group`) pairs a single muted caption line ("Give inserts one or more new stacks…Fill tops up
one item toward capacity…") with the toggle itself, using the neutral `--border` token and the
`--panel-muted` background rather than the warning's amber `--warning` token, so it reads as low-weight
context rather than a second alert. The warning banner (`.bases-inventory-restart-warning`) always states
the restart requirement (see "Why Give/Fill do not require a stopped map" below); while Fill mode is
selected it appends a trailing sentence covering the Fill-specific position_index risk (see "Give fills
from the high end…" below) to that *same* element rather than opening a second box. This shape is the
result of two rounds of real operator feedback after the initial consolidation — the first shipped with
three separately-stacked notice elements (a paragraph, the restart warning, and Fill's collision warning
as its own second bordered box), the second fixed the *content* but left a visual mismatch between the
unboxed mode-hint caption and the two bordered controls around it. Both are folded into the description
above rather than kept as a history; see the git log for `BaseInventoryTab.tsx` if the blow-by-blow is
ever needed.

**Clicking an item already in the container also populates the Give/Fill combobox with that same item.**
Giving more of something already sitting in the container previously required re-typing/re-searching its
exact name in the combobox from scratch, even with the operator looking right at it in the Grid or List
view. Clicking a Grid cell or a List row's item name now populates `selectedItem` with that slot's item
**in addition to** the existing "select this slot for the delete strip" behavior the same click already
performs — it is not a second, separate click target, and it does not change `addFillMode` or
`quantityText`; the item lands in whichever mode (Give or Fill) is currently active, and the quantity
field is left exactly as the operator last set it. Resolved against the real, already-loaded catalog (the
same `loadFullCatalog()` cache `ItemCatalogCombobox` itself uses, exported specifically for this) rather
than fabricated from the slot's own name/`templateId` alone, so the populated selection carries the item's
real `group`/`image` fields. Silently a no-op — the click still performs its existing delete-selection
behavior regardless — for an item that is not in `FILLABLE_GROUPS` (e.g. a weapon or schematic sitting in
a container some other way) or is not present in the loaded catalog at all; the combobox could never have
accepted that item either. **Corrected 2026-08-19** to also account for the visibility toggle above: if
Give/Fill is currently hidden, a click on an otherwise-eligible item reveals it through the same
confirm-and-warn dialog the toggle itself uses, with that item already pre-filled once the operator
confirms — the click is not a silent bypass of the toggle's own confirmation, and a decline leaves both the
panel hidden and the item unselected.

| Action | Route | Backend function | Confirmation phrase |
|---|---|---|---|
| Give one item | `POST …/containers/{placeableId}/give-item` | `duneDb.giveItemToBaseContainer()` | `GIVE ITEM TO STORAGE` |
| Give several items in one call | `POST …/containers/{placeableId}/give-items` | `duneDb.giveMultipleItemsToBaseContainer()` | `GIVE ITEMS TO STORAGE` |
| Fill with a raw/refined resource or component | `POST …/containers/{placeableId}/fill-item` | `duneDb.fillItemToBaseContainer()` | `FILL ITEM TO STORAGE` |

**Corrected 2026-08-19** (code-review follow-up, issue #347): these three
functions used to be `giveItemToStorage()`/`giveMultipleItemsToStorage()`/
`fillItemToStorage()` — the same functions the standalone Storage tab's own
routes still use — resolving their target inventory by a bare, unscoped
`actor_id` lookup with no ownership re-check and no guard against a
container backing more than one qualifying inventory. That was a real
TOCTOU gap (ownership/group verified in a separate, unlocked query, then
written in a completely separate transaction) and a real multi-inventory
ambiguity gap for these three Bases-scoped routes specifically. Give/Fill
now resolve ownership, lock the row, and write in one atomic transaction
via `resolveOwnedStorageContainer()` — the same claim-CTE path Delete
already used — through three new, Bases-scoped functions
(`giveItemToBaseContainer`/`fillItemToBaseContainer`/
`giveMultipleItemsToBaseContainer`, the last renamed from
`giveMultipleItemsToStorage`, which never had a standalone-tab caller in
the first place). `giveItemToStorage()` is unchanged and still used by
the standalone Storage tab's own `storageGiveItemRoute`
(`POST /api/storage/{storageId}/give-item`), which operates on an
operator-supplied storage id directly and has no base+placeable
ownership chain to verify.

**Corrected 2026-08-20** (post-merge review of upstream PR #182): the
paragraph above previously also claimed `fillItemToStorage()` is "still
used by the standalone Storage tab's own routes" -- verified directly
against `server.js` (`grep -n "fillItemToStorage(" console/api/src/server.js`
returns nothing) that this was never true: there is no
`POST /api/storage/{storageId}/fill-item` route, and no other route
calls `fillItemToStorage()` either. The function is fully implemented
and unit-tested in `duneDb.js`, but unreachable via any real HTTP
route today -- the standalone Storage tab only has a Give action, not
a Fill action. Any operator or future contributor reading the previous
wording would reasonably believe the Storage tab supports Fill; it
does not.

**Both Give and Fill are restricted to raw resources, refined resources, and components only.**
`baseContainerGiveItemRoute`/`baseContainerGiveItemsRoute`/`baseContainerFillItemRoute` all resolve items
through `resolveFillableCatalogItem()`, requiring the item's `group` to be `raw_resource`,
`refined_resource`, or `component` (`FILLABLE_GROUPS` in `adminCatalog.js`). The Give and Fill comboboxes'
client-side filter (`ItemCatalogCombobox`'s `filterGroups` prop) matches this exactly, so the picker never
even offers an item the server would reject; the server independently re-enforces it rather than trusting
the client to have filtered correctly. An earlier version let Give accept any catalog item at all via the
unrestricted `resolveCatalogItem()` — found via a real catalog item, "Robe of the Sisterhood" (clothing),
appearing in the Give combobox — and was narrowed to match Fill's existing restriction, since container
Give/Give Multiple was never meant to hand out weapons, clothing, or schematics. **This restriction applies
only to this Base Inventory tab's Give/Give Multiple actions** — the older, separate, standalone Storage
tab's own "Give Item" action (`storageGiveItemRoute`) is unaffected and still accepts any catalog item,
unchanged.

**Give Multiple is one transaction, capped at 50 distinct items.** Every check `giveItemToBaseContainer`
performs (slot cap, volume cap, high-end position selection) is repeated fresh for each item in the batch,
so item 3 correctly sees the slots/volume/positions items 1 and 2 already consumed within the same call.

**Corrected 2026-08-19** (code-review follow-up, issue #347): this used to say each check was re-queried
against the database after every single item's insert. `giveMultipleItemsToBaseContainer` now fetches the
container's current slot count, volume total, and occupied position-index set **once**, up front, and tracks
all three in memory as the batch inserts rows, instead of re-querying per item — the same round-trip
reduction the bulk-delete functions above already had (`finishDeletingLockedItems`), applied here to bulk
give. This is safe under the same guarantee bulk-delete already relies on: `resolveOwnedStorageContainer`'s
`for update of inv` lock is held for the whole transaction, and every other mutation path in this file takes
that same lock before touching `dune.items`, so nothing else can insert/delete rows in this inventory between
the initial read and the batch's own inserts. Round-trips drop from ~3-4 per item (~150-300 for a 50-item
batch) to ~4 total plus one insert per item (~54 for the same batch).

### Give fills from the high end of a container; Fill does not (and cannot)

**A real, confirmed collision risk, not a hypothetical** (see
`docs/incidents/INC-2026-08-19-GIVE-FILL-POSITION-INDEX-COLLISION.md` for the full writeup): the live game
engine only reads/claims a container's `dune.items` rows at server startup, never mid-session
(`INC-2026-07-31-001`), but a player can move or add an item into the same container **in-game while the
map keeps running** at any time. If a console insert and a live in-game action land on the same
`position_index`, one of the two rows loses on the next restart — permanently unclaimed and unusable
in-game, though not deleted or corrupted. This was directly reproduced and traced end-to-end through
`dune.item_audit_log`, not inferred.

**Give and Give Multiple mitigate this** (per explicit operator direction): `nextHighPositionIndex()` in
`duneDb.js` picks the **highest unused slot below `max_item_count`** instead of the lowest-next-free slot
the old convention used. In-game additions/moves typically fill a container low-to-high starting from slot
0, so inserting from the high end reduces — does not eliminate — the chance of colliding with a slot the
engine is about to claim. A genuinely full or nearly-full container can still collide; this is a
mitigation, not a guarantee. Falls back to the old lowest-next-free convention when `max_item_count` is 0
(unknown/uncapped on this schema), since there is no known high end to start from.

**Fill does not get this mitigation, by design.** Fill exists to top up a container toward its real
capacity — the same low-to-high direction the engine already fills in — so there is no meaningful "far end"
left once Fill has done its job; the high-end approach that helps Give simply does not apply. Per explicit
operator direction, Fill instead ships with an in-UI warning shown while Fill mode is selected (see "Give
and Fill share one item picker..." above) stating this risk directly, and the incident document above is
the canonical reference for an operator who wants the full mechanism. This is treated as an accepted,
documented limitation, not an open bug.

**Neither Give nor Fill ever rejects a request just because it would exceed the container's remaining
volume.** Per explicit operator direction (found during manual UI review of #347): an earlier version threw
`"Storage is full by volume"` and inserted nothing at all, forcing the operator to guess a smaller quantity
and retry. Both functions now **clamp the requested quantity down to whatever actually fits** and insert
that instead — asking for 500 of an item that only has room for 375 gives 375, not 0. The response always
reports `requested`, `given`, and `clamped` (`clamped: true` whenever `given < requested`), and the UI
surfaces exactly that outcome (`"Only 375 of the requested 500 x X fit and was given to the container."`)
rather than silently implying the full request succeeded. **Slot count** works differently depending on
whether the item has catalogued stack data (issue yacketrj/dune-awakening-selfhost-docker#430): for an item with **no** `stackSize` in
`admin-items.json`, a single give/fill still consumes exactly one slot regardless of quantity, so "no slots
left" genuinely cannot be partially satisfied and remains a hard rejection (`"Storage is full by item slot
count"`). For an item **with** catalogued stack data (e.g. `MelangeSpice` at 500/stack), an oversized
quantity is **split across multiple rows of at most one full stack each** — the game engine itself enforces
per-item stack limits (the generator-refill path always respected them; give/fill now does too), so each
stack row consumes its own slot, and the split completes in **one action** bounded by the container's real
capacity (remaining slots/volume) — full stacks plus one final remainder stack, per explicit operator
direction (2026-08-20). A 1,000-row runaway backstop (shared across a whole Give Multiple batch) exists
solely to stop pathological transactions (e.g. 1,000,000 units of a 1-per-stack item); realistic
operations never reach it. The response
carries `stacks` (row count) and `insertedStacks` (all rows) alongside the pre-existing `inserted` (the
first row), plus `clampReason` distinguishing WHY a shortfall happened — `"volume"` and `"slots"` mean the
container's real capacity bound it (final), `"stack-rows"` means only the per-operation cap did (the
container has room; repeating the action adds more) — and a human-readable `message` stating the outcome,
which the standalone Storage tab renders directly. Fill-to-capacity reports `clamped` **only** for the
`"stack-rows"` case: a fill bounded by real capacity genuinely is "as much as fit". A genuinely full
container is still the same hard rejection as before. Volume itself is still a hard rejection in the one
case clamping cannot help: truly zero room left, where even 1 unit does not fit.

**Slot placement (post-review fix):** Give keeps claiming the highest free in-range slots per row (the
2026-08-19 collision mitigation). Fill, player Give, and the single-row Add Item action — which previously
used `max(position_index) + 1` — now claim the **lowest free in-range** slots for a slot-capped inventory
from a one-time occupied-set read (the same pigeonhole-guarded pattern Give Multiple's
`claimPositionIndex` uses), because after any high-end Give, `max + 1` starts **at** `max_item_count` and
would write outside the engine's slot grid. Give also claims from the same one-time occupied-set read now
(replacing its per-row `generate_series` re-query — one round trip per operation instead of two per stack
row under the inventory lock). Uncapped inventories keep `max + 1`, which cannot go out of range.

**Curating `stackSize` values:** every value added to `admin-items.json` must have a **stated, verified
source**, preferably an independent, external reference (see below) rather than another in-repo system's
own policy value — read the limit from the live game (hover an item's full stack in-game, or observe the
largest naturally-occurring `stack_size` for that template in a real world database) and record where the
number came from in the PR/commit that adds it. A wrong value silently mis-splits or over-clamps every
future grant of that item — this happened for real: `Oil`/`SpicedFuelCell` were initially seeded at 499,
copied from the generator-refill table (`GENERATOR_TYPES`), and were **wrong**. An operator challenge
(2026-08-20) to validate against an external source — [dune.gaming.tools](https://dune.gaming.tools)'s own
item data feed, the `maxStackSize` field, not just its rendered page — found the true limit for both is
**500**, matching `addonSeedJob.js`'s pre-existing (and, it turns out, correct) value; see issue yacketrj/dune-awakening-selfhost-docker#432, which
had already flagged this exact contradiction before it was externally resolved. The refill table's 499 is a
refill *policy* value, not necessarily the engine's real cap, and was left unchanged (changing an
already-live, already-tested system is its own separately-verified decision, not a data-correction one).
Current provenance of the five seeded items, all confirmed against dune.gaming.tools's `maxStackSize` field
as of 2026-08-20: `MelangeSpice` 500, `Oil` 500, `SpicedFuelCell` 500, both lubricants 100.

**Stack size correlates strongly with resource type, not per-item uniqueness** — an operator hypothesis
tested 2026-08-20 by externally resolving all 96 (of 99) `raw_resource`/`refined_resource`/`component`
catalog items against the same source. **500 is the default for 82/96 (85%)**, spanning raw ore, refined
ingots, and components uniformly — no per-category split. The outliers, all semantically coherent: 1 for
non-stackable corpse/bulky-canister items (`Mouse_Corpse`, `Corpse`, all 3 `FuelCanister` sizes, and
`T2MuaddibComponent` — "Muad'Dib Corpse", Muad'Dib being Fremen for kangaroo mouse, operator-stated
2026-08-20 after the item 404'd against the external source), 5 for all 4 `WindTrapFilter` tiers, 100 for
the two lubricants, and 1000–2500 for bulk sand/residue raw materials (`FlourSand`, `SpiceResidue`,
`SpiceSand`). Three items (`T4ShieldWallComponent`, `ExperimentalWindTurbineComponent`, and originally
`T2MuaddibComponent` before the operator statement above) 404 against the external source and were never
individually verified further (issue yacketrj/dune-awakening-selfhost-docker#441, closed 2026-08-20 per explicit operator direction — not pursued).
This made bulk curation cheap: all 91 remaining externally-resolved items were curated 2026-08-20 (issue
yacketrj/dune-awakening-selfhost-docker#431), so **every `raw_resource`/`refined_resource`/`component` item now has a `stackSize` except those two**
— 97 of 99 items resolved.

**The same external check found `volume`, not just `stackSize`, was systematically wrong for most
`refined_resource`/`component` items** (issue yacketrj/dune-awakening-selfhost-docker#440, fixed 2026-08-20): every one of 70 items whose in-repo
`volume` was exactly `1.0` was wrong — a placeholder that was apparently never replaced with a real
measurement — except `T6RefinedResourceA` (genuinely 1.0). `raw_resource` items were unaffected (0/19
mismatched; all were individually measured from the start). Corroboration for trusting the external source
on volume, not just stack size: those 19 raw-resource values, several with non-round fractional volumes
(0.08, 0.4, …), matched the external source exactly. All 70 were bulk-corrected; real values range from 0.1
(most components, a 10x understatement at the old 1.0) up to 5 (large fuel canisters).

**Give Multiple's batch-clamping design is deliberately left-to-right, not best-effort.** Once one item in
the batch does not fully fit (clamped, or reduced all the way to zero), the batch **stops there** —
`giveMultipleItemsToBaseContainer` does not skip ahead to try whether a later, smaller item in the same batch
might have had room. This is a design choice for predictability, not a limitation: an operator reading a
per-item breakdown top-to-bottom should be able to reason about "gave everything up to X, then stopped,"
rather than "gave some subset of the batch in an order that does not match what was typed." Like the
single-item functions, **the batch never throws just because it hit a capacity limit** — it returns
`ok: true` with `results: [...]`, one entry per requested item, each carrying `requested`/`given`/`clamped`/
`attempted`/`reason`. An item never reached because an earlier one already stopped the batch is still
present in `results`, with `attempted: false`, so the response always accounts for every requested item,
not just the ones that got a row inserted. This is a real backend contract change from an earlier version,
which threw on hitting a cap and relied on the transaction rolling back to prove no partial inserts
happened — the current version has no rollback to reason about, because a capacity limit is no longer an
error condition, and the response's `results` array is the accounting instead.

**Fill offers two distinct actions, not one quantity field with a hidden meaning.** "Fill Amount" sends the
operator's typed quantity (clamped as above if it does not fully fit). "Fill to Capacity" sends the
`quantity: 0` sentinel `fillItemToBaseContainer` (and the standalone Storage tab's `fillItemToStorage`, which
it shares this convention with) has always supported — insert as much as fits in whatever volume
remains, in one call — but that sentinel was unreachable from any UI before this fix, since both this tab's
own quantity field and the standalone Storage tab's clamp to a minimum of 1. `requested` is `null` in a
Fill-to-Capacity response (there was never a specific number to compare against); the UI reports the real
`given` count directly (`"4,200 x SteelBar was filled into the container (as much as fit)."`).

**Both Give and Fill enforce the same slot and volume caps.** An earlier version of `giveItemToStorage`
checked only slot count — an operator could give an item whose declared volume exceeded a container's
remaining volume, and because that give never recorded a `volume_override`, every later `fillItemToStorage`
volume check against the same container silently undercounted real usage. Fixed to match `fillItemToStorage`'s
volume accounting exactly (`volume_override` on an inserted row is the item's declared **per-unit** volume —
see "`volume_override` is per-unit, not per-stack" immediately below for why it is not the stack's total).

### `volume_override` is per-unit, not per-stack

**A real, live in-game bug, not a design choice.** `dune.items.volume_override` is stored as
the item's PER-UNIT volume, and every volume total (the running total `giveItemToBaseContainer`/
`fillItemToBaseContainer`/`giveMultipleItemsToBaseContainer` check against a container's `max_item_volume`
on this tab, the standalone Storage tab's own `giveItemToStorage` checking the same thing (`fillItemToStorage`
exists in `duneDb.js` and follows the same convention, but has no live HTTP route today -- see the Give/Fill
route table above), and every read-side total in `baseInventory`, the standalone Storage tab's `listStorage`, and
`baseContainerSlots`) is computed as `volume_override × stack_size`, summed across rows.

An earlier version of this code stored `volume_override` as the stack's **total** volume
(`perUnitVolume × stackSize`) instead, on the theory that this kept the console's own internal volume sums
simpler (`sum(volume_override)` directly, no multiplication needed). That theory was wrong: the live game
engine treats a non-null `volume_override` as a **per-unit** value and multiplies it by `stack_size` itself
when computing the volume it displays in-game. Storing the pre-multiplied total made the engine multiply by
`stack_size` a **second** time, inflating the displayed in-game volume by a factor of `stack_size` — a real,
confirmed example: a 9540-unit Mouse Corpse stack (real per-unit volume `5.0`, real total `47700`) had
`volume_override` wrongly stored as `47700` and displayed in-game as `47700 × 9540 ≈ 455,057,984`. See
`docs/incidents/INC-2026-08-19-VOLUME-OVERRIDE-DOUBLE-MULTIPLIED.md` for the full root-cause writeup,
including the `dune.item_audit_log` evidence that every genuinely in-game-created item row (never touched
by the console) always carries a `NULL` `volume_override` — proving a non-null value is exclusively a
console-side convention, and that the engine's own real convention for it is per-unit.

**Existing data repair:** `console/api/scripts/repair-volume-override.mjs` recomputes every already-affected
row's `volume_override` from the current `runtime/data/admin-items.json` catalog (dry-run by default,
`--apply` to write). An operator who used Give/Fill before this fix should run it once after updating.

**Give and Fill use a compact type-to-search item picker (`ItemCatalogCombobox`), not a raw "item name or
ID" text field.** Found during manual UI review of #347: the original plain text input required already
knowing the exact template id or exact in-game name, offered no way to discover what is actually in the
catalog, and did not filter anything as the operator typed — typing was just raw text sent straight to the
server on submit. Search and the results list are name-only: the catalog id (e.g. `"Oil"` for the in-game
"Fuel Cell") is a backend concept the operator never needs to see or type, and Give/Fill both submit the
selected item's real `itemId` under the hood regardless. Give and Fill share one combobox instance (see
"Give and Fill share one item picker..." above), filtered to `FILLABLE_GROUPS` client-side in both modes,
matching the server's own `resolveFillableCatalogItem()` check, so the picker never even offers an item the
server would reject.

## Why Give/Fill do not require a stopped map

**Neither Give/Fill nor Delete require a stopped map** (see "Deletion, Give, and Fill do not require a
stopped map" above for why deletion's requirement changed 2026-08-19) — but the underlying reasoning for
Give/Fill specifically predates
that change and still holds independently: **Give and Fill only ever insert a brand-new `dune.items` row**,
and inserting a new row cannot conflict with, overwrite, or be raced by whatever the live game engine is
doing with the *existing* rows in that same inventory. There is nothing running-map state can invalidate
about a row that did not exist a moment ago — this was true even back when Delete still required a stopped
map, which is why Give/Fill never gated on map state in the first place.

The tradeoff this creates: a given/filled item is **not visible in-game until the Survival server
restarts** — the game engine only claims newly-inserted `dune.items` rows at process startup (incident
`INC-2026-07-31-001`). A
deleted item shares a version of the same limitation in the other direction: the database row is gone
immediately, but if the engine had already claimed and loaded that row into its own live state, the live
map keeps showing it until the next restart. The console UI states the Give/Fill restart requirement
directly above the panel every time it is shown, matching the standalone Storage tab's own "Apply Fills
(Restart Survival)" note — this page deliberately does not offer an inline restart button of its own;
Server Control and Bases already own that action, and duplicating a player-disconnecting restart trigger in
a third place was judged riskier than one extra tab switch.

## Removing items in bulk: Delete Selected and Delete All

Both are Storage-group-only and require `deleteSafety.safe`, identically to the single-item delete above —
neither is a separate code path with its own, looser safety check.

**In the console UI, both buttons (and the per-row multi-select checkboxes that feed Delete Selected) are
additionally hidden behind the same `Give / Fill / Delete Controls` visibility toggle Give/Fill uses** — see
"Adding items: Give, Give Multiple, and Fill" above for the toggle's full behavior. This is a UI-only gate,
not a second backend safety check: the routes and their `deleteSafety`/ownership checks below are unchanged
and unaware the toggle exists. Widened onto bulk delete 2026-08-19, the same day the toggle first shipped,
correcting a real oversight — the toggle originally gated only the Give/Fill panel, and these two buttons
continued to render whenever `deleteAllowed` was true regardless of the toggle's own state. The single-item
delete strip (the per-row trash icon, and the selected-slot detail panel's own Remove/Delete-stack button)
is **not** gated by this toggle and stays exactly as exposed as it was before the toggle existed.

| Action | Route | Backend function | Confirmation phrase |
|---|---|---|---|
| Delete several checked items | `DELETE …/containers/{placeableId}/items` (body: `{ itemIds }`) | `duneDb.deleteMultipleBaseContainerItems()` | `DELETE ITEMS` |
| Delete every item in the container | `DELETE …/containers/{placeableId}/all-items` | `duneDb.deleteAllBaseContainerItems()` | `DELETE ALL ITEMS` |

**Ownership is re-resolved once per batch, not once per item** — both share a `resolveOwnedStorageContainer()`
helper that runs the same claim-CTE/allowlist/`is_hologram`/`max_item_count >= 0` resolution the single-item
delete uses. Ownership is checked once, the resulting inventory row locked (`for update of inv`) for the
duration of the whole batch.

**Corrected 2026-08-19** (code-review follow-up, issue #347): this used to say Give/Fill deliberately used a
different, unscoped, actor_id-only lookup instead of this same helper (on the theory that shape had no group
filter and could otherwise reach a Refining/Crafting inventory). That was true of the standalone Storage
tab's `giveItemToStorage`/`fillItemToStorage` at the time, and still is — but the Bases-scoped
`giveItemToBaseContainer`/`fillItemToBaseContainer`/`giveMultipleItemsToBaseContainer` now share this exact
`resolveOwnedStorageContainer()` helper too, closing a real TOCTOU gap and multi-inventory ambiguity gap
those three had (see "Adding items: Give, Give Multiple, and Fill" above for the full functions table).

**This query was completely broken against a real database from the moment it was introduced** (issue
#353): it combined `SELECT DISTINCT` with `FOR UPDATE OF inv`, which Postgres flatly rejects
(`FOR UPDATE is not allowed with DISTINCT clause`) — every real call to Delete Selected and Delete All
would have 500'd in production. (At the time this was found, Give/Fill did not yet call this query at all —
they used their own, separate actor_id-only lookup; they were brought onto this same query, and so onto
this same fix, later — see the correction immediately above.) This was invisible to every
mocked unit test in `db.test.js`, since the fake `db.query()` those tests use never actually parses SQL —
it only pattern-matches the query *text*, so a syntactically invalid query and a valid one with the same
substrings are indistinguishable to that kind of test. It was found only once a real-HTTP integration test
(issue #353's own fix, `baseContainerMutationRoutes.integration.test.js`) exercised these routes against
a real, isolated PostgreSQL database rather than a mock — the exact gap that issue existed to close. Fixed
by resolving the `DISTINCT` candidate set in its own CTE first, then joining back to the real
`dune.inventories` row purely to take the lock — `FOR UPDATE` only ever applies to that final, non-`DISTINCT`
join, which Postgres allows. This is also the reason every base-container mutation route (not just the two
this section covers) now has real HTTP-level integration coverage rather than the source-text-pattern
assertions `baseContainerMutationRoutes.test.js` was previously limited to.

**The batch itself is resolved and verified with a fixed, small number of set-based round-trips, not one
pair of round-trips per item.** Found during PR #349's own Layer 3 audit (DBA and Security hats
independently, issue #352, HIGH severity): the original version of both functions looped per item — a
`select … for update`, the `dune.delete_item(bigint)` call, an `exists` check, and a conditional fallback
`delete` — worst case ~800 sequential statements for a 200-item batch, all while the container's inventory
row lock was held for the entire duration, blocking any concurrent Give/Fill/Delete against the *same*
container for that whole window. `dune.delete_item(bigint)` is a shipped stored procedure taking exactly
one id, so the N calls to it are irreducible — but everything around those N calls is now batched: one
set-based `select … where id = any($1::bigint[]) and inventory_id = $2 for update` resolves the whole
requested set at once (Delete Selected) or the whole container at once (Delete All), and one set-based
`select`/fallback `delete` pair (shared by both functions as `finishDeletingLockedItems()`) verifies and
cleans up every row `dune.delete_item` left behind, instead of one pair per row. Round-trips drop from
~4N to ~N+2 for a batch of N items — a 200-item Delete Selected now costs ~202 statements instead of ~800,
and the container is only locked for that shorter window.

**If a storage-group container is ever found to back more than one qualifying inventory, both functions
refuse to guess and throw, rather than silently picking one and leaving items behind in the other.** This
page's own "Slots hang off an inventory, not the container" section above documents that a placeable can
back more than one surviving inventory as a general schema fact — the read path (`baseContainerSlots`)
already sums across every qualifying inventory a placeable has for exactly this reason. Give/Fill resolve
their target inventory with `order by id limit 1`, deterministically picking the lowest id if more than one
ever exists (single-item delete has no such ambiguity — it resolves by the specific `itemId` it was given,
whose `inventory_id` is already known). The two bulk functions instead throw
`"This container backs N separate inventories, which this action does not support yet. Please report this
so it can be fixed."` — found during this feature's own Layer 3 review that an earlier version had no
`ORDER BY`/`LIMIT` at all and took whichever row Postgres's planner returned first, which could have
silently cleared the wrong inventory. No storage-group
building type is currently known to carry more than one qualifying inventory (unlike Refining/Crafting's
documented `inventory_type = 12` pair — see "Why not classify on `inventory_type`" above, where Storage's
`inventory_type = 4` rows were confirmed single per placeable in the same reference dump), so this throw is
not expected to fire in practice; it exists so a future patch that changes that would be caught loudly
instead of corrupting data silently.

**Delete Selected skips items that no longer exist rather than erroring the whole batch** — an item deleted
by a player between when the operator's overlay last refreshed and when they clicked Delete Selected is
silently excluded from `removed[]`, and the response message states how many of the requested items were
actually found (`"N of M requested item(s) were deleted from the database"`). Delete All reads its item
list fresh inside the same transaction that deletes them, so "all" always means everything actually present
at the moment the container's row is locked, never a possibly-stale list the overlay fetched moments
earlier.

**Each entry in `removed[]` carries the same audit-detail fields the single-item delete's own
`destroyedState` does** — `positionIndex`, `qualityLevel`, `currentDurability`, `maxDurability` — not just
`itemId`/`templateId`/`count`. Found missing during PR #349's own Layer 3 audit (issue #350): without
these, a bulk-destroyed pristine legendary logs in the admin audit trail identically to a bulk-destroyed
broken common of the same template, which matters most for exactly this feature (bulk, irreversible,
multi-item destruction). Both bulk functions select these columns with the same column-probed fragment
`deleteBaseContainerItem` already uses (`auditDetailSelectFragment()`), so a schema missing
`position_index`/`quality_level`/`stats` degrades every field to `null`/`0` rather than failing the delete —
it never re-queries for them separately, and it never fails a batch just because a field is unavailable on
a given schema.

**`Developer_StorageContainer_Placeable` is not special-cased by any of this.** It is already in the
Storage group's building-type allowlist (see the table near the top of this doc) and is already reachable
by Give/Fill/Delete the same way any other Storage container is — it happens to only be obtainable by an
operator granting `Developer_Storage_Container_Patent` to a player via Players → Building Sets → "Show
Experimental," but nothing about that origin changes how this page treats the resulting placeable. A
dedicated test locks this in so a future change cannot silently carve it out.
