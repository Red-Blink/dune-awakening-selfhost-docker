# Base backups (the game's "pick up base" tool)

**Status:** Current | **Last Updated:** August 2026

The game has its own base-backup tool: a player can "pick up" a placed base,
which unclaims it so it can later be redeployed elsewhere. This is entirely
separate from the console's [Base deletion](base-deletion.md) feature and from
the Backups page's database backups — it is a game mechanic the console only
needs to *recognize*, not one it drives.

## What picking up a base actually does in the database

Investigated directly against a live restored database by placing a test base,
recording its rows, picking it up, and diffing. Picking up a base does **not**
move, delete, or serialize any of its structural rows. It does exactly two
things:

- deletes the base's `dune.permission_actor` / `dune.permission_actor_rank`
  rows — the base becomes unclaimed;
- inserts a row into `dune.base_backups` (`id`, `player_id`, the base's old
  `actor_name` as `base_backup_name`) and one `dune.base_backup_linked_actors`
  row per actor that belonged to the base (the claim actor plus every
  placeable) linking it to that `base_backups.id`.

Every `dune.buildings` / `dune.building_instances` / `dune.placeables` row for
the base is left completely intact, at its original location, with the same
health and transform it had before. There is no "packed" or serialized
representation anywhere — not in a new `dune.items` row, not in the game's own
`BaseBackupTool` item (that item is just the tool itself; its `stats` carry
only durability/customization, never base data). Redeploying presumably
re-establishes a `permission_actor` claim over the same still-existing actor
ids rather than re-materializing anything from a stored blob, though that
direction (backup → redeploy) has not been directly observed the way pick-up
has.

## Deep Desert Coriolis compatibility fix

Funcom's shipped `dune.delete_actors_and_respawns_on_server` originally
preserved actors in `Travel`, `VehicleBackup`, and `VehicleRecovery` state but
omitted `BaseBackup`. Because a saved base remains a collection of ownerless
actors in its original Deep Desert partition, Coriolis cleanup deleted those
actors. `base_backup_linked_actors.actor_id` then cascaded away, and
`base_backup_get_available_backups` could no longer discover the saved totem.
This presented as a backup disappearing from the in-game tool after a storm
while surviving ordinary Battlegroup restarts.

`runtime/scripts/patch-coriolis-base-backups.sh` now adds the missing
`BaseBackup` exclusion after every successful Funcom database update. The
patch is idempotent and edits the installed definition only when its reviewed
deletion shape still matches. An unrecognized future definition stops startup
instead of risking another destructive cleanup or blindly replacing new
Funcom logic.

The patch prevents future loss. It cannot reconstruct actors already deleted
by a storm. Recover those from a pre-storm full database backup; the normal
startup database-update step applies this compatibility patch before any world
server starts, preventing the restored backup actors from being deleted again.

One live observation from redeploying during this investigation: the base's
`permission_actor` row came back and its `base_backup_linked_actors` rows were
gone, i.e. the game does clean that table up on redeploy in at least this
case. The console's checks below still verify both signals rather than relying
on that alone (see the next section for why).

## Why the console excludes these from the Bases panel

Left unfiltered, a picked-up base still has every `buildings` /
`building_instances` / `placeables` row present, so it would show up in the
Bases panel exactly like a normal, ordinary base — just with a blank owner
column, since `GET /api/bases`'s owner resolution is already a `LEFT JOIN`.
There is nothing else distinguishing it at a glance.

`listBases` (`duneDb.js`) excludes a base only when **both** signals agree:

- it is unclaimed (no `dune.permission_actor` row for its claim actor), **and**
- its claim actor id appears in `dune.base_backup_linked_actors`.

Neither signal alone is used as the exclusion, deliberately:

- "unclaimed" alone would also hide a base that has no owner for some other,
  unrelated reason;
- "ever backup-linked" alone would risk hiding a base again after a legitimate
  redeploy, if some future case leaves its old linked-actor rows behind
  instead of cleaning them up the way the one case observed here did.

A base satisfying both is unambiguous. This exclusion is gated on
`dune.base_backup_linked_actors` existing at all (`tableExists`); on a schema
without it, `listBases` behaves exactly as it did before this feature.

## Mutation routes reject a backed-up base too

Hiding a base from the list only stops it from being reached through the
Bases panel's own UI. A direct route call — or a stale bookmarked base id from
before it was picked up — could still act on it. `duneDb.baseIsBackedUp(db,
baseId)` runs the identical unclaimed-AND-linked check for one base id, and
every base mutation route checks it before writing, the same way each already
checks the [pending-delete lock](base-deletion.md#irreversibility):

- `DELETE /api/bases/{baseId}` (delete)
- `POST /api/bases/{baseId}/refill-generators`
- `POST /api/bases/{baseId}/refill-water`
- `PUT /api/bases/{baseId}/permissions`
- `POST /api/bases/{baseId}/system-custodian`
- `POST /api/bases/{baseId}/auto-refill` and `.../auto-refill-water` (only
  when enabling — disabling is harmless and does not race anything)

Each responds **409** with `"This base was picked up into a backup and is no
longer claimed. It cannot be modified until the player redeploys it."` Reads
(inventory, water, export-as-blueprint) are not blocked — a picked-up base's
rows are still real data, and there is no destructive or race-prone reason to
hide it from a read the way there is for a write.

Refills also reach the database without a request: from the pending-refill
queues on a map restart, and from the daily auto-refill scans. A base can be
picked up after its refill was queued or after it was enrolled, and a
picked-up base has no partition, which the queues treat as safe to write at
once. So the check is repeated on those paths too:

- `refillBaseGenerators` / `refillBaseWater` re-check `baseIsBackedUp` inside
  their write transaction and throw `"This base was picked up into a backup,
  so the refill was not applied."`. The queue flushes treat that as *no longer
  applicable* and drop the entry instead of retrying it.
- The generator and water auto-refill scans skip a backed-up base before
  reading its levels, counted as `backedUp` in the scan audit. Its enrollment
  and stall tracking are left as they were, so a redeployed base picks up
  where it left off. If the check itself fails, the base is recorded as a
  scan failure and nothing is queued.

## Export and import

The Bases page has a "Bases | Base Backups" toggle; the server-wide Base Backups
view lists every backup on the server (owner, backup name, map, pieces, placeables,
stored items) with an Export button per row, and an Import control that picks the
receiving player with an explicit Search/Clear player search (players list API). Each
player's admin view has a "Base Backups" section at the bottom of the existing
Bases tab (not a separate tab), listing that player's backups and importing to
that player; import confirmation warns if that player is online.

**How it works:** the game already moves base backups between battlegroups during
character transfer (`dune.character_transfer_export` / `character_transfer_import`).
The console reuses the same `dune._character_transfer_*` SQL helpers, scoped to
one backup instead of one character. It was verified row-for-row identical to the
game's own `character_transfer_export` against a live server database (10 bases
plus one real in-game pickup), and a typed round trip.

**What the file carries:** the backup's actors (without `partition_id`, so no map
server loads them until the player redeploys), entity components, per-placeable
permissions, building actors and pieces, placeables, the totem and land claim
segments, tax invoices, and everything stored in the base (inventories, items,
sinkcharts, stored blueprints). The owning player is a placeholder mapped to the
receiving player on import.

**What it does not carry** (same as the game's own transfer): the base's BaseTotem
respawn point, and inventories that belong to an item (a weapon's own internal
inventory) — none held items on a live server when checked.

**Import behavior:** Import creates a NEW backup for the receiving player; the
original backup is untouched; importing the same file twice gives two independent
backups. The receiving player redeploys it with the in-game base backup tool. Raw
player ids that only mean something on the source server (`base_backups.last_edited_by_player_id`,
`placeables`/`building_instances.last_placed_by_player_id`, `permission_actor.edited_by_player_id`)
are set to the receiving player; `buildings.owner_id` is cleared; a stored blueprint's
creator is dropped. The receiving player sees the backup in their base backup tool after
their next login: an online player must log out and back in (confirmed in-game). Import is
allowed while they are online, and the confirmation and result both say so.

**Exactness rules:**

(a) entries never pass through JavaScript numbers — Postgres renders the export
and the import sends the uploaded text back as jsonb, because game payloads can
carry 64-bit integers `JSON.parse` would round;

(b) jsonb drops array lower bounds and the game writes 0-based arrays
(`base_backup_get_available_backups` hard-codes
`landclaim_original_global_location[0..2]`). Each exported row whose array
columns are not 1-based carries its bounds in its entry data under the key
`"__lb"` (e.g. `{"__lb": {"transform": 0}}`); `jsonb_populate_record` ignores
that key. On import, each table's rows are staged in a temporary table, the
recorded bounds are restored row by row (only 0 or 1 accepted), then rows are
inserted. This covers every array column including sinkcharts.marker_hash_ids
and bases whose stored blueprints mix 0-based and 1-based rows. Rotation/position
values round-trip bit-exact; the only difference is -0 becoming +0, which is the
same rotation.

### Downloading a live base as a base backup

On the Bases page, each base's **Download Base** button opens a choice:

- **Blueprint**: the layout only, as before.
- **Base Backup**: the whole base in the same file format as an exported backup,
  importable from Base Backups for any player.

The base doesn't need to be picked up first, and nothing about it changes. The
export only reads, in one repeatable-read snapshot, and its only writes go to
temporary tables. The file reflects the base as of the map server's last save.

It contains what the game's pickup (`base_backup_save_from_totem`) would take:

- the totem;
- the placeables the totem owns that have buildable support;
- the building pieces the totem owns.

It leaves out what a pickup destroys or leaves behind:

- the totem's own permission rows and tax invoices;
- owned placeables with no buildable support.

Every actor is exported in the `BaseBackup` state a pickup leaves it in.
Building actors are exported the way a pickup recreates them. They keep their
class, map, transform and dimension, and get default properties and no entity:
the live entity holds only transient health and weather state. The backup record
is built from the totem: its name comes from the totem's permission actor, and
its owner is the totem's rank-1 member, which is how the game defines the owner.
A base with only co-owners has no owner.

This was verified against a copy of a live server. For each of 9 owned bases, the
live export matched the game's own pickup followed by a backup export, entry for
entry. The database was unchanged afterwards.

An ownerless base is refused (download it as a blueprint instead). A picked-up base
is refused too: export it from Base Backups. Both checks run again inside the
export's snapshot, so a base picked up mid-export gets the same 409.

**Version info recorded in every file (top-level fields):**

- format: `"dune-base-backup"`
- version: `1`
- game: `{ build, steamBuildId, patchesChecksum, appliedPatchesCount, latestPatches[] }`
- console: `{ version, buildId }`
- exportedAt
- source: `{ backupId, name, rawName, map, totemType, ownerName, counts }`; a live-base export adds `kind: "live-base"` and `baseId`, with `backupId: null`
- ownerPlaceholderTransferId
- entries

On import a missing or mismatched `patchesChecksum` returns **409** code
`"version_mismatch"` with both versions; the UI then offers "Import Anyway",
which resends with `allow_version_mismatch=1` and the result carries a warning.
Future format versions go through `upgradeEnvelope()` in `console/api/src/baseBackups.js`.

**Timeouts:** each export/import runs in one transaction with a per-statement
limit of 120 s (override with `ADMIN_BASE_BACKUP_STATEMENT_TIMEOUT_MS`, clamped
100 ms - 10 min; now wired through docker-compose.web.yml so it works in a
standard install). The console pool's own 15 s client-side query timeout
(`ADMIN_DB_QUERY_TIMEOUT_MS`) also applies per statement. A timeout returns **504**
code `"timeout"` naming the step (e.g. `"inserting building pieces"`), elapsed
time and which limit fired; an import is rolled back completely. The UI shows
an "Import Timed Out"/"Export Timed Out" panel with those details as visible text
that stays until dismissed. The largest measured base (589 pieces, 199 items)
exported in about 1.6 s and imported in about 0.8 s.

**Permissions:**
- Listing uses `bases:read`.
- Downloading a base backup file is its own action, `bases:export-backup`. It covers
  both an existing backup and a live base's Base Backup download. The file carries
  every item stored in the base and imports as a whole base on any server, so no
  `bases:read` grant covers it. The blueprint download stays `bases:read`.
- Import is its own action, `bases:import-backup`.
- Owner reaches both by default; lower tiers require explicit grants.
- Both actions are in `LEVEL_EXCLUDED_ACTIONS`, so a key stored as
  `{"bases":"write"}` doesn't get them; they must be named explicitly.
- Both downloads are rate limited (as admin changes are) and audited as
  `base-backups.export`.

**Known game bug noted during this work:** Funcom's `dune.base_backup_save_from_totem`
picks the totem's FGL entity without filtering `slot_name`; totems have `"Actor"`
and `"ContainerInventory"` slots, so it can back up the totem alone. The in-game
pickup does not appear to use it; the console does not call it.

**Import validation:** every entry kind must be allowlisted; exactly one backup
record whose player_id is the owner placeholder; at least one totem; every actor
must be linked to the backup; every reference column must point inside the file
at the right kind of entry. The owner placeholder (which becomes the receiving
player) may only be referenced by the backup record's player_id and a permission
rank's player_id — so a file cannot attach inventories, items, permissions or
placeables to the receiving player's own character. Imported actors get
partition_id NULL and state 'BaseBackup' (no map loads them until the player
redeploys), buildings.owner_id is cleared, and non-zero raw player ids
(`base_backups.last_edited_by_player_id`, `placeables`/`building_instances.last_placed_by_player_id`,
`permission_actor.edited_by_player_id`) become the receiving player. Invalid files
return **400** code `"invalid_file"`. The capability probe also checks that the
game's `_charactertransferentrykind` enum has every entry kind used.

**Editing owner, name and map:** each row on the Base Backups view (and in a player's
Bases tab) has an Edit button: rename the backup, reassign it to another player through the
same Search/Clear player search, move it to another map, or any combination. `PUT /api/base-backups/{id}` changes
`base_backups.player_id` (the game's backup tool lists a player's backups by exactly that)
and `base_backups.base_backup_name`; a reassign also sets `last_edited_by_player_id` to the
new owner, as an import does. A rename or reassign does not touch the base itself.

- The **current owner must be offline** (409 `owner_online` otherwise). The in-game tool
  caches its backup list per session, and a redeploy from that stale list after a reassign
  would take its map and partition from the new owner (`base_backup_finish_placing` reads
  them from `base_backups.player_id`). The new owner only needs to log out and back in.
- Names are 1-23 characters (the longest claim name seen on a live server; the game's own
  limit is unknown), may not start with `##` (the game's placeholder for an unnamed
  claim) and may not contain control characters.
- The row is locked for the change; if the backup was redeployed or recycled in-game
  meanwhile, the request is a 404 and nothing is written.
- **Moving to another map.** The game only lets a backup be redeployed on the map it was
  saved on, which it reads from the totem actor's `actors.map`
  (`base_backup_get_available_backups`). A move therefore rewrites `map` on every actor
  linked to the backup and clears their `partition_id`, since a partition belongs to the old
  map. Imported backups have no partition either, and they redeploy normally. Redeploying
  overwrites map, partition and dimension with the placing player's anyway
  (`base_backup_finish_placing`). Only maps where a claim totem has actually been placed on
  this server are offered (400 `invalid_map` otherwise), since social hubs and dungeons
  never allow building. The list response carries them as `maps`.
- Permission: `bases:edit-backup` (owner-only by default), excluded from API-key
  levels like import. Every change is audit-logged as `base-backups.edit` with the before
  and after values.

**Deleting a backup:** each row also has a Delete button. It permanently deletes the base
and everything stored in it, using the game's own `dune.base_backup_delete`. That function
deletes every actor linked to the backup (the foreign keys take the pieces, placeables,
totem, land claim, storage and items with them), then the backup row.

- Same bar as deleting a live base: `DELETE /api/base-backups/{id}` requires
  `{ confirmation: "DELETE BACKUP" }`, and a **full database backup is taken first**. If
  that backup fails, nothing is deleted.
- The current owner must be offline (409 `owner_online`). A stale in-game list could
  otherwise try to redeploy a backup that no longer exists. That is checked once before
  the safety backup, so a blocked delete fails fast, and again under the row lock.
- In one transaction, the delete verifies that the backup row and all its links are gone;
  otherwise it rolls back. A backup redeployed meanwhile is a 404.
- An imported copy is independent: deleting the original leaves it intact.
- Permission: `bases:delete-backup` (owner-only by default), audit-logged as
  `base-backups.delete`.

**CI coverage:** `console/api/test/baseBackups.test.js` (mocked) and
`console/api/test/baseBackups.integration.test.js` (real PostgreSQL with
hand-written stand-ins for the Funcom helpers in
`console/api/test-support/baseBackupFixture.js`); web:
`console/web/src/features/bases/BaseBackupsView.test.tsx`.
