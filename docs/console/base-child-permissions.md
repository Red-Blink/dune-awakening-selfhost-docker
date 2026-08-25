# Base permissions (per-piece access level)

**Status:** Current | **Last Updated:** August 2026

The Bases panel's **Base Permissions** tab lists every individual piece
(door, device) on a claimed base along with its access level, and lets an
admin set any of them to a specific level. It lives alongside the
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

The list covers every `is_child=true` `permission_actor` row on the base —
every door and device that carries its own access level — not only the ones
that differ from Sub-Fief. Each row is labeled with its current level, and
rows that deviate from Associate get a subtle amber highlight so they stand
out among the rest without hiding anything. Base sizes vary widely (the
production-derived dataset above ranges from single digits up to roughly
300 child pieces on the largest base), so the list scrolls inside the tab
rather than paginating.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/bases/{baseId}/child-access` | Every child piece on this base, with its current access level. |
| `POST` | `/api/bases/{baseId}/child-access` | Set specific pieces to specific levels. Body: `{ updates: [{ actorId, accessLevel }] }`. Requires the confirmation phrase `SET CHILD ACCESS`. |

Like the roster editor, this calls the game's own
`dune.permission_set_access_level(actor_id, access_level)` procedure rather
than writing the table directly, so a running map is notified immediately —
no restart required, and no queue.

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
until **Save changes**, which posts every changed row in one call. A
**Reset Selected** action (with **Select All**) stages the checked rows back
to Associate without a network round-trip, for the common case of "put
these back to normal" (harmless to include rows already at Associate — only
the rows that actually changed are sent on Save).

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
