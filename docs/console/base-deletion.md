# Base deletion

**Status:** Current | **Last Updated:** August 2026

The Bases panel can permanently delete a base and everything built or stored
on it. The action lives as a **Delete Base** row action (trash icon) in the
Bases panel, alongside Refill Generators, Refill Water, and Download as
Blueprint.

This is the most destructive single action in the console. Unlike a refill
(additive, re-runnable) a delete cannot be undone once it lands — the only
guardrails are the confirmation phrase, the danger-styled confirm dialog, and
an automatic full-database safety backup taken before any delete SQL runs.
See [Safety backup](#safety-backup) and [No queue-and-forget](#irreversibility).

## What counts as "the base"

A base is not one row — it is every `dune.actors` row reachable from its claim
actor:

- the claim actor itself (`basePermissionActor`'s resolution, the same one
  permission editing and generator/water refills already use);
- every building's actor id, via `dune.building_instances` →
  `dune.actor_fgl_entities` (`dune.buildings.id` **is** an `actors.id`);
- every placeable's actor id, via its own `owner_entity_id` chain — a
  separate FK path from building_instances', so it needs its own join.

Deleting that full set of `dune.actors` rows is what cascades away
`buildings`, `building_instances`, `placeables`, `permission_actor`,
`permission_actor_rank`, `inventories`, and items — all declared
`ON DELETE CASCADE` from `actors`. The one thing that does **not** cascade
from `actors` is the base's map marker (`dune.markers`/`dune.player_markers`,
keyed on the claim actor id but only FK-cascaded from `map_names`), which is
why the delete also calls the shipped `dune.permission_actor_destroy(bigint)`
— the same proc permission removal already uses to clear a player's marker —
before deleting the actor rows themselves.

No new stored procedure was added for this: the repo has no migrations
directory and never issues `CREATE FUNCTION` anywhere, so a delete composes
two functions the game already ships (`permission_actor_destroy` and
`dune.delete_actors(bigint[])`) inside one transaction, the same way
`mutateBasePermissions` composes the permission procedures.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `DELETE` | `/api/bases/:baseId` | Delete the base. Body: `{ confirmation: "DELETE BASE" }`. |
| `DELETE` | `/api/bases/:baseId/queued-delete` | Cancel a pending queued delete. No confirmation phrase — cancelling is reversible. |
| `GET` | `/api/bases/pending-deletes` | Pending queue, grouped by `(map, partitionId)` the same way `/api/bases/pending-refills` is. |

Deletes are audited as `bases.delete`; queued flushes as
`bases.flush-queued-delete`. Both go through the phrase-gated
`directDbMutation` helper (`"DELETE BASE"`, matching `"DISBAND GUILD"`'s
precedent) and are rate limited.

`DELETE /api/bases/:baseId` requires its own IAM action, `bases:delete`
(`console/api/src/actions.js`) — deliberately separate from `bases:mutate`,
the shared bucket every other base mutation (refills, permission edits,
cancelling a queued refill or delete) falls into. Those are all reversible;
this one isn't, so a custom policy can grant routine base management without
also granting the ability to permanently delete one. The shipped `owner`/
`admin` default policies grant `bases:*`, which already covers `bases:delete`
via wildcard, so this changes nothing about default access — it only makes
narrower, hand-authored policies (via `PUT /api/settings/iam/policy`)
possible. `DELETE /api/bases/:baseId/queued-delete` (cancelling) stays under
`bases:mutate`, same as cancelling a queued refill.

`bases:delete-item` is the other carve-out from that bucket — deleting one
stored item out of a container. Its reasoning is different: not blast radius,
but consent, since base inventory shipped read-only and no existing
`bases:mutate` grant could have anticipated item destruction. See
[base-inventory.md](base-inventory.md#deleting-a-stored-item).

## Why deletes are queued for a live map

This schema has no live-notify path for structural changes — the same lack of live sync
[Base inventory](base-inventory.md#deletion-does-not-require-a-stopped-map) documents for item rows: zero
triggers on `dune.buildings`/`dune.building_instances`/`dune.placeables`, and
no `pg_notify` channel for a structural despawn. A running map server
periodically flushes its own in-memory copy of a base back to Postgres, so a
raw delete against a live base's rows can be silently overwritten (resurrected)
on the very next autosave — exactly the race the generator-refill queue exists
to close for fuel writes.

Base deletion reuses that same queue machinery rather than re-solving the
problem: `baseRefillTarget` decides whether the base's partition is currently
write-safe. If it is, the delete runs immediately. If not, it is recorded in
`runtime/generated/pending-base-deletes.json` (gitignored, capped at 200
entries) and applied the next time that partition is confirmed down — the
same 5-second poll and restart-task `onMapDown` hook that flushes queued fuel
and water refills.

**One divergence from the refill queue:** at flush time, finding that the base
no longer exists counts as **success**, not a failure to retry. A refill on a
vanished base is a genuine failure — the operator's request cannot be
honored. A delete on an already-vanished base has already achieved its goal
(a player demolishing their own base while a delete sits queued is the
common case this covers), so the entry is dropped without incrementing its
attempt count or being reported as a failure.

## Safety backup

Every delete — immediate or flushed from the queue — triggers a full database
backup **before** any delete SQL runs, via the same `dune db backup` mechanism
(`DB_BACKUP_ORIGIN`) the console's raw "Database Query" tool already uses
before any destructive query. It appears on the Backups page typed **"SQL
Safety Backup"**, tagged with the origin `base-delete` (grouped into that same
display type by `services/backups.js`) so it is distinguishable in the backup
metadata from a raw-SQL-tool backup while reading the same way in the UI.

If the backup fails, the delete is never attempted — for a queued flush pass,
the entire pass aborts (every entry stays queued and is retried, backup
included, on the next tick) rather than deleting some bases without the
safety net that was supposed to cover the whole batch.

For a flush pass with several bases ready to delete at once (e.g. a whole
battlegroup restart), **one backup covers the entire batch** rather than one
per base — a full database backup is not cheap, and there is no additional
safety benefit to repeating it for bases about to be deleted moments apart in
the same write-safe window.

## Transaction atomicity

The delete itself — the `FOR UPDATE` lock on the claim actor's `actors` row,
`permission_actor_destroy`, and `delete_actors` — runs inside one Postgres
transaction. Any failure rolls back the whole thing via the console's
existing transaction helper; there is no code path where the permission layer
is torn down but the structural rows survive, or vice versa.

## Frozen while a delete is pending

<a id="irreversibility"></a>
A base with a delete queued rejects every other mutation — permission edits,
generator/water refills, enabling auto-refill — with `409`, and the auto-refill
background schedulers skip it on their scan tick. Refilling fuel or water
moments before deleting the base would be pointless and would pollute the
audit log, so queueing a delete also best-effort cancels any refill already
queued for that base. Blueprint export is deliberately **not** blocked: it is
read-only and exporting a base before it is destroyed is exactly the kind of
thing an operator might still want to do.

In the Bases panel, a base with a pending delete shows a danger-toned pill
(trash icon + cancel) in place of its Delete button, and its Refill Generators
/ Refill Water buttons gray out with a tooltip explaining why, rather than
offering a control that would just be rejected.

A separate, unrelated freeze applies to a base picked up via the game's own
base-backup tool: it is excluded from the panel entirely rather than shown
frozen, and every mutation route (including this one) rejects it with `409`.
See [base-backups.md](base-backups.md).

## Response shape

```
DELETE /api/bases/{baseId}
{ supported, backupCreated,
  result: { ok, queued?, baseId, map?, partitionId?, actorId?,
            deletedActorCount?, deletedBuildingCount?, deletedPlaceableCount? } }
```

`result.queued: true` means the delete was recorded and will apply once the
base's map is confirmed down; otherwise the delete already ran and
`deletedActorCount`/`deletedBuildingCount`/`deletedPlaceableCount` describe
what was removed.

## Related

- [vehicle-deletion.md](vehicle-deletion.md) — the same shape applied to
  vehicles, as a parallel queue rather than a shared one. A vehicle needs no
  multi-hop actor enumeration (it is already its own actor), but adds a
  vehicle-specific `dune.actor_state` guard bases have no equivalent of.
