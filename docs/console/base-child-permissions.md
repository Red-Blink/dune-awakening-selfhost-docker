# Base permissions (per-piece access level)

**Status:** Current | **Last Updated:** August 2026

The Bases panel's **Base Permissions** tab lists every individual piece
(door, device, and the base's own totem) on a claimed base along with its
access level, and lets an admin set any of them to a specific level. It lives alongside the
**Sub-Fief Permissions** tab, which edits the whole-base roster instead —
see [base-permissions.md](base-permissions.md).

## A different scale from the roster

`dune.permission_actor.access_level` is a 5-tier scale, independent of the
3-tier roster rank (`permission_actor_rank.rank`, Owner/Co-Owner/Associate):

| Value | Label |
|---:|---|
| 1 | Public |
| 2 | Guild |
| 3 | Associate |
| 4 | Co-Owner |
| 5 | Owner |

**Associate (3) is "Sub-Fief"**: every top-level base actor and the
overwhelming majority of child pieces carry exactly this value — it is what a
piece gets by default, matching the base's own roster-wide access. A piece
set to any other value was deliberately opened wider (Public, Guild — even to
players not on the base's roster at all) or narrowed further (Co-Owner,
Owner) than that default.

This is confirmed against real data: a production-derived dataset (105
bases) has every one of 105 top-level actors at exactly `3`, and 1658 of 1673
child pieces also at `3`. The only deviations were 15 pieces on a single
base — Generators, a Storage Container, and Ore Refineries — all opened to
Guild (`2`), evidently so any guild member could refuel and collect from
them without being added to that base's roster individually. Three of the
five labels (Associate/Co-Owner/Owner) read the same as roster rank labels;
this is coincidental — the two scales are stored in different columns, on
different tables, and do not constrain each other.

## Every piece, not just the deviations

The list covers every `permission_actor` row tied to the base — every door
and device that carries its own access level (`is_child = true`), plus the
base's own root object, the totem (`is_child = false`, always exactly one
per base) — not only the ones that differ from Sub-Fief. Each row is
labeled with its current level, and rows that deviate from Associate get a
subtle amber highlight so they stand out among the rest without hiding
anything. Base sizes vary widely (the production-derived dataset above
ranges from single digits up to roughly 300 child pieces on the largest
base), so the list scrolls inside the tab rather than paginating.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/bases/{baseId}/child-access` | Every child piece on this base, plus its own totem, with its current access level. |
| `POST` | `/api/bases/{baseId}/child-access` | Set specific pieces to specific levels. Body: `{ updates: [{ actorId, accessLevel }] }`. Requires the confirmation phrase `SET CHILD ACCESS`. |

Like the roster editor, this calls the game's own
`dune.permission_set_access_level(actor_id, access_level)` procedure rather
than writing the table directly.

## Why this one is queued

A running map **never** picks up an `access_level` change. Unlike the roster
editor's `permission_set_player_rank`, this procedure takes no map id and its
`pg_notify` payload carries no `"Map"` field, which looked like a plausible
explanation. Live testing on DD Test1 ruled that out directly: manually
re-firing the notify with a `"Map"` field added (matching the rank procedure's
shape exactly) still had no live effect, and a player relogging didn't pick it
up either — only a **map restart** applied it. There is no way to make this
live-apply from our side; it is a limitation in the game's own server.

So a save aimed at a base whose map is currently live is **queued** rather
than written, and applied in the window where that map is confirmed down —
which is the only window where it takes effect anyway. If the map is already
down, the write goes through immediately. This is the same
`baseRefillTarget` / `world_partition` write-safety machinery the generator
refill, water refill, and base delete queues use, and the same background
flush drains it (the 5s poll, plus the restart task runner's map-down hook).

The motivation differs from those queues, though. They exist to dodge an
autosave race — a live map overwrites an immediate write. `permission_actor`
has no such race; the write would stick. Queuing here exists so the console
does not show a level the game is not enforcing: before, a save appeared to
succeed and survived a reload while the game still honored the old value,
with nothing indicating the change was inert.

While changes are queued the tab keeps showing the levels the game currently
enforces, with a `→ <level> at restart` marker on each affected piece and a
banner offering **Discard queued changes**. The Bases list surfaces the same
state without opening the row: a violet key badge in the combined queue
banner (and on each affected map's row there), plus a per-row pill with an
inline discard. Its count is **pieces, not bases** — one base with six queued
pieces is six pending writes, and a restart applies all six. Unlike the
refill and delete controls, that pill only exists while something is queued;
permissions are edited inside the expanded row, not from the actions column. Re-saving merges into the pending
entry (later save wins per piece) rather than replacing it. At flush time a
piece that has since been demolished is skipped rather than failing the whole
batch — an entry can sit queued for days, and one removed door should not
strand the rest.

Queue behavior requires `dune.world_partition` (reported as
`capabilities.baseChildAccessQueue`). Without it the console cannot tell a
running map from a stopped one, so writes stay immediate, matching how the
refill and delete queues degrade on an older schema.

`POST` accepts 1-100 updates per call and re-validates every `actorId`
against the base's *current* child pieces inside the same locked
transaction: an id that no longer resolves there (deleted, or never on this
base) is refused with "no longer children of this base," a staleness guard
against acting on an id that isn't actually part of it.

## UI

Each row shows the piece's friendly name and a segmented control of the five
levels — the same native-radio pattern as the Sub-Fief roster's rank
control, under its own class names and its own 5-option scale. Selecting a
segment only stages the change in local draft state; nothing is written
until **Save changes**, which posts every changed row in one call (harmless
to include a row already at its current level — only the rows that actually
changed are sent).

A **Type** dropdown filters the list to one master category at a time —
Sub-Fief, Storage, Refining, Crafting, Generators, Water Storage,
Pentashield, Door, or Other — not individual building types, so a base with
hundreds of pieces still narrows to a manageable choice. This is its own
categorization, not the Inventory tab's `BASE_INVENTORY_TYPES`: most child
pieces here (doors, generators, turbines, the totem) carry no inventory at
all and would all land in "other" under that map. Storage/Refining/Crafting
still borrow its curated building-type keys for consistent naming;
Generators, Water Storage, Pentashield, and Door are simple case-insensitive
substring rules ("generator"/"turbine", "water", "pentashield", "door"
anywhere in the building type), so e.g. `BloodWaterExtractionAdvanced_Placeable`
counts as Water Storage and `Choam_PentashieldSurfaceVertical_Placeable`
counts as Pentashield. Sub-Fief is different: it's not a substring rule but
the `is_child = false` row itself — the base's own totem, always exactly
one, regardless of its building type. Only categories actually present on
this base appear in the dropdown. **Select All** only checks the pieces the current filter is
showing — a piece checked earlier under a
different filter stays checked even once it scrolls out of view, but Select
All itself never reaches into pieces the filter is hiding. The **Apply**
dropdown (defaulting to Associate) plus **Apply to Selected** stages every
currently checked row — regardless of the active filter — to whichever
level is chosen, the general form of "put these back to Sub-Fief" (pick
Associate) or any other bulk change.

## Capability gating

The tab is hidden entirely unless `listBases` reports
`capabilities.baseChildAccess`, probed once per list request the same way
`basePermissions` is. That requires `dune.buildings`, `dune.building_instances`,
`dune.placeables`, `dune.permission_actor`, and the
`dune.permission_set_access_level(bigint,smallint)` procedure.

## Related

- [base-permissions.md](base-permissions.md) — the whole-base Sub-Fief
  roster editor (Owner/Co-Owner/Associate), a different scale from this page.
- [API-REFERENCE.md](API-REFERENCE.md) — full HTTP API reference.
