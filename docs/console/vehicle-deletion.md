# Vehicle deletion

**Status:** Current | **Last Updated:** November 2026

The Vehicles panel can permanently delete a vehicle and everything fitted or
stored on it. The action lives as a **Delete Vehicle** row action (trash icon)
in the global Vehicles panel, alongside the expand chevron into
Components/Permissions. It is not (yet) available on a player's own Vehicles
tab — see [Scope](#scope).

This is the most destructive single action the console offers for a vehicle.
Unlike a permission edit or a refuel (reversible, or at worst re-runnable) a
delete cannot be undone once it lands — the only guardrails are the
confirmation phrase, the danger-styled confirm dialog, and an automatic
full-database safety backup taken before any delete SQL runs. See
[Safety backup](#safety-backup) and
[Frozen while a delete is pending](#irreversibility).

## What counts as "the vehicle"

Unlike a base — whose id and permission actor id differ, resolved through a
`buildings → building_instances → actor_fgl_entities → actors` chain — a
vehicle **is** its own actor: `dune.vehicles.id = dune.actors.id`. There is no
multi-hop actor enumeration the way base deletion needs for buildings and
placeables; deleting a vehicle is deleting exactly one `dune.actors` row, plus
whatever the game's own declared foreign keys cascade from it.

Verified against a real production schema dump (`.claude/dune_backup.sql`)
and confirmed live in a rolled-back transaction before this feature was
written:

| Constraint | Action |
|---|---|
| `dune.vehicles.id` → `dune.actors.id` | `CASCADE` |
| `dune.vehicle_modules.vehicle_id` → `dune.vehicles.id` | `CASCADE` |
| `dune.inventories.vehicle_module_id` → `dune.vehicle_modules.id` | `CASCADE` |
| `dune.backup_vehicles.vehicle_id` → `dune.vehicles.id` | `CASCADE` |
| `dune.recovered_vehicles.vehicle_id` → `dune.vehicles.id` | `CASCADE` |
| `dune.overmap_players.vehicle_id` → `dune.actors.id` | `SET NULL` |

Deleting the vehicle's `dune.actors` row cascades away `vehicles`,
`vehicle_modules`, their `inventories` and `items`, and any
`backup_vehicles`/`recovered_vehicles` record.

One caveat on the `vehicle_module_id` row above: it is a real constraint, but
it is not the path a vehicle's cargo actually takes. That link is **empty in
production** (0 of 535 inventories in a real dump) — the cargo hold hangs off
`dune.inventories.actor_id`, so it is removed by the `actors` cascade on the
line above it, not by this one. See
[vehicle-storage.md](vehicle-storage.md). Nothing about the delete changes;
the closure is the same either way. As with a base, the one thing
that does **not** cascade from `actors` is the vehicle's map marker
(`dune.markers`/`dune.player_markers`, keyed on the claim actor id but only
FK-cascaded from `map_names`) — this repo previously had no confirmation that
vehicles even receive such markers in practice, but the delete still calls
`dune.permission_actor_destroy(bigint)` first regardless, for the same reason
base deletion does: a `DELETE` matching zero rows is a harmless no-op, and
skipping the call on the assumption that vehicles never get one would be the
kind of assumption that is wrong exactly once.

No new stored procedure was added: the same two shipped functions base
deletion uses (`dune.permission_actor_destroy` and `dune.delete_actors(bigint[])`)
are generic over any actor id, not base-specific, and are composed inside one
transaction the same way `deleteBaseCompletely` composes them.

## A vehicle-specific lifecycle guard

Funcom's own vehicle cleanup procedure — `dune.delete_actors_and_respawns_on_server`,
invoked by the game's Deep Desert Coriolis-storm mechanism, see
[base-backups.md](base-backups.md) — refuses to delete a vehicle whose
actor lifecycle state is `Travel`, `VehicleBackup`, or `VehicleRecovery`: states
meaning the vehicle is mid-overmap-transit with a player attached, or stashed
pending recovery. Admin deletion honors the same exclusion, transcribed from
that procedure rather than invented for this feature — a base has no
equivalent state to check, so this has no base-side counterpart. The check is
stored by patch 1.5 in `dune.actors.state`. The Console retains a compatibility
adapter for the former `dune.actor_state` table; a schema exposing neither
form simply skips the guard rather than breaking.

The refusal names the state with the label the Vehicles list shows for it
(In Transit, Vehicle Backup, Stored for Recovery) rather than the raw enum
value. The list marks Delete as unavailable on such a row, with a shorter
tooltip that leads with the same label; the button stays focusable
(`aria-disabled`) so the reason can be read from the keyboard. A Stored for
Recovery row is the exception where the server supports the stored delete
below: there the button is enabled and opens that dialog instead. The recovery
wording deliberately does not say "until its owner recovers it" -- an expired
`Normal` recovery may never be recoverable.

### Stored vehicles still have an owner

Putting a vehicle into recovery destroys its permission roster
(`store_recovered_vehicles_wiped_before_spawn` calls `permission_actor_destroy`
so stored vehicles stop counting toward the vehicle limit) and clears
`actors.owner_account_id`. The owner is kept in
`dune.recovered_vehicles.character_id` instead, a `player_state.id`;
`dune.backup_vehicles` records its owner the same way. `listVehicles` falls
back to both, so a stored vehicle shows the player it is held for rather than
reading as unowned. `Normal` recoveries can only be restored in-game within the
server's restore time limit; `Migrated` and `RecoveredFromLostState` ones (see
`dune.move_vehicles_in_lost_state_to_recovery`) do not expire. That limit is a
game-server setting and is not in the database, so the Console reports how long
ago a vehicle was stored and never whether it has expired.

### Deleting a stored vehicle

`DELETE /api/vehicles/:vehicleId/stored` is the one override of the guard. It
deletes a vehicle only when its state is `VehicleRecovery` -- `Travel` and
`VehicleBackup` still refuse, and an ordinary vehicle is sent back to the
normal route -- and only while no character on the owning account is online
(any status other than `Offline` refuses, `LoggingOut` included). Any character
on the account can restore the vehicle in-game, and a running game server keeps
its own copy of an online player's recovery list (`store_recovered_vehicle`
notifies `vehicle_recovery_notify_channel`) that a direct delete does not
update. The owner check runs under the same `actors` row lock
`restore_recovered_vehicle` needs, so a restore cannot slip in between the check
and the delete. The other half of that race -- the owner logging in between
the check and the commit -- is closed by locking the account's character rows
`FOR SHARE` before reading their status: a login is an update of
`online_status`, so it waits, and a login already in flight is seen. It is
never queued: a stored vehicle is on no map partition. If the vehicle still had
an ordinary delete queued from when it was on a map, that entry is dropped once
the stored delete succeeds. The recovery record goes with the vehicle through
its `ON DELETE CASCADE`.

The "owner is online" refusal names the character. A caller without
`players:read` is told only that the vehicle cannot be deleted right now, since
who is connected is player information.

This is not the same operation as the game's own cleanup: Funcom's procedure
**recovers** a vehicle (via `store_recovered_vehicles_wiped_before_spawn`)
before removing it from the live map. The admin Delete Vehicle action is a
hard delete — there is no recovery step.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `DELETE` | `/api/vehicles/:vehicleId` | Delete the vehicle. Body: `{ confirmation: "DELETE VEHICLE" }`. |
| `DELETE` | `/api/vehicles/:vehicleId/stored` | Delete a vehicle that is Stored for Recovery. Body: `{ confirmation: "DELETE STORED VEHICLE" }`. Refused while its owner is online. |
| `DELETE` | `/api/vehicles/:vehicleId/queued-delete` | Cancel a pending queued delete. No confirmation phrase — cancelling is reversible. |
| `GET` | `/api/vehicles/pending-deletes` | Pending queue, grouped by `(map, partitionId)`, the same shape `/api/bases/pending-deletes` returns. |

Deletes are audited as `vehicles.delete`; queued flushes as
`vehicles.flush-queued-delete`. Both go through the phrase-gated
`directDbMutation` helper (`"DELETE VEHICLE"`, matching `"DELETE BASE"`'s
precedent) and are rate limited.

`DELETE /api/vehicles/:vehicleId` requires its own IAM action,
`vehicles:delete` (`console/api/src/actions.js`) — deliberately separate from
`vehicles:mutate`, the shared bucket every other vehicle mutation (roster
save, custodian transfer, refuel, repair) falls into. Those are all
reversible; this one isn't, so a custom policy can grant routine vehicle
management without also granting the ability to permanently delete one.
Unlike bases, vehicles have no `"DELETE /api/vehicles/"` prefix rule in
`REGEX_ACTIONS_BY_METHOD` for the route to fall through to, so this needed its
own explicit pattern entry in `REGEX_ACTIONS_BY_METHOD_PATTERN` — without it,
the route would have silently resolved to the read-only `vehicles:read`
fallback (the same class of gap the system-custodian transfer route closed
earlier; see `vehicle-permissions.md`). `DELETE /api/vehicles/:vehicleId/queued-delete`
(cancelling) stays under `vehicles:mutate`, and needed the same explicit
pattern treatment for the same reason.

`DELETE /api/vehicles/:vehicleId/stored` requires `vehicles:stored-delete`
**and** `vehicles:delete`, audited as `vehicles.stored-delete`. The second
check means a custom policy written as Deny `vehicles:delete` plus Allow
`vehicles:*` cannot reach the stored delete either. No API-key level covers
`vehicles:stored-delete`; a key has to name it explicitly (see
[api-keys.md](api-keys.md)). The route runs a preflight (the vehicle exists, is
in recovery, and its owner is offline) before the safety backup, so a request
that will be refused does not cost a backup. It is separate from `vehicles:delete` so a
policy that lets someone clear junk vehicles does not also let them take a
recoverable vehicle away from a player. The name is `stored-delete`, not
`delete-stored`, so no wildcard written against `vehicles:delete...` can reach
it. An infix wildcard such as `vehicles:*delete*` names every delete on purpose
and does grant it; no action name could prevent that. `GET /api/vehicles` reports `capabilities.vehicleStoredDelete`, which
additionally needs `dune.actors.state`, `dune.recovered_vehicles`
(`vehicle_id`, `character_id`, `time_stored`, `reason`) and `dune.player_state`
(`id`, `account_id`, `character_name`, `online_status`).

## Why deletes are queued for a live map

Vehicles' structural tables have no live-notify path any more than a base's
do: `dune.vehicles`/`dune.vehicle_modules` carry no trigger and no
`pg_notify` channel for a structural despawn, unlike `permission_actor_rank`
writes, which the shipped `permission_set_player_rank`/`permission_remove_player_rank`
procedures do notify on (see [vehicle-permissions.md](vehicle-permissions.md#why-there-is-no-queue)).
A running map server periodically flushes its own in-memory copy of a
vehicle back to Postgres, so a raw delete against a live vehicle's rows can be
silently overwritten (resurrected) on the very next autosave — the same race
the base-delete queue exists to close.

For vehicles the argument is if anything stronger than for bases:
`permission_actor_destroy` **does** call `pg_notify`, telling any listening
map server "permissions destroyed" for that actor, while `delete_actors` does
not notify anything. Running the pair against a live map without a
write-safety gate would tell the server one thing happened while silently
pulling the structural row out from under it — worse than simply doing
nothing, since the server is now told about a change to state it does not
know has vanished.

Vehicle deletion reuses the base-delete queue's shape rather than re-solving
the problem, but as its own parallel queue — vehicles had **no** existing
delete-pending/backed-up infrastructure before this feature, unlike bases:
`vehicleWriteTarget` decides whether the vehicle's partition is currently
write-safe (reusing `vehiclePermissionActor` for location, since a vehicle is
already its own actor with no separate resolver needed). If it is, the delete
runs immediately. If not, it is recorded in
`runtime/generated/pending-vehicle-deletes.json` (gitignored, its own cap of
200 entries — vehicles are far more numerous than bases, so this cap is
tracked independently) and applied the next time that partition is confirmed
down — the same 5-second poll and restart-task `onMapDown` hook that flushes
the other queued writes, extended with its own independent vehicle-delete leg.

The restart hook runs the flush as a *fresh* pass and ignores the retry
backoff, for the reasons given in
[base-deletion.md](base-deletion.md#why-deletes-are-queued-for-a-live-map): a
pass already in flight observed the map as live, and a blocked entry is inside
its retry window most of the time. The 5s poll reuses an in-flight result and
keeps backing off.

**Same divergence as the base queue:** at flush time, finding that the
vehicle no longer exists counts as **success**, not a failure to retry.

## Safety backup

Every delete — immediate or flushed from the queue — triggers a full database
backup **before** any delete SQL runs, exactly as base deletion does (see
[base-deletion.md](base-deletion.md#safety-backup)), tagged with the origin
`vehicle-delete`. If the backup fails, the delete is never attempted — for a
queued flush pass, the entire pass aborts and every entry stays queued,
retried (backup included) on the next tick. One backup covers an entire flush
pass, not one per vehicle.

## Transaction atomicity

The delete itself — the `FOR UPDATE` lock on the vehicle's `actors` row, the
`actor_state` guard, `permission_actor_destroy`, and `delete_actors` — runs
inside one Postgres transaction. Any failure rolls back the whole thing; there
is no code path where the permission layer is torn down but the structural
rows survive, or vice versa.

## Frozen while a delete is pending

<a id="irreversibility"></a>
A vehicle with a delete queued rejects every other mutation — permission edits,
the system-custodian transfer, refueling — with `409`. Repairing vehicle
decay (a bulk, per-player action with no single vehicle id) is deliberately
**not** blocked, mirroring the choice to leave blueprint export enabled
during a pending base delete: it is a lower-blast-radius, reversible action,
and there is no single-vehicle route to guard it on.

In the Vehicles panel, a vehicle with a pending delete shows a danger-toned
pill (trash icon + cancel) in place of its Delete button, and the
Permissions tab's Save/Transfer/rank/remove controls disable with a tooltip
explaining why, the same way they already do for an unclaimed vehicle.

## Scope

Delete Vehicle is offered on the global Vehicles panel and, per row, in
Players → Deleted Characters ([deleted-characters.md](deleted-characters.md)).
A player's own Vehicles tab has no delete, matching how Delete Base never
reached a player-scoped Bases tab. Unlike the
system-custodian transfer button — which reaches both the global panel and a
player's own Vehicles tab — `VehicleTable`'s delete props are optional and
default off, so `PlayerVehiclesTab`'s mount point is unaffected until they are
deliberately wired through there too.

## Response shape

```
DELETE /api/vehicles/{vehicleId}
{ supported, backupCreated,
  result: { ok, queued?, vehicleId, map?, partitionId?, actorId?,
            deletedModuleCount? } }
```

`result.queued: true` means the delete was recorded and will apply once the
vehicle's map is confirmed down; otherwise the delete already ran and
`deletedModuleCount` describes how many `vehicle_modules` rows were removed
along with it.
