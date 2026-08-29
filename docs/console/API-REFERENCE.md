# Dune: Awakening Console API Reference

**Status:** Current | **Last Updated:** August 2026

Complete reference for all HTTP API endpoints in the Dune Docker Console. All endpoints require authentication unless otherwise noted — either a browser session (session cookie + CSRF token) or a scoped API key sent as `Authorization: Bearer <key>`. See [api-keys.md](api-keys.md) for how key scopes are granted and what they can never reach.

**Format:** HTTP Method | Route | Description | Parameters

---

## Table of Contents

- [Authentication & Setup](#authentication--setup)
- [Server Operations](#server-operations)
- [Updates](#updates)
- [Backups](#backups)
- [Players](#players)
- [Guilds](#guilds)
- [Bases & Storage](#bases--storage)
- [Vehicles](#vehicles)
- [Blueprints](#blueprints)
- [Maps & World](#maps--world)
- [Live Map](#live-map)
- [Database](#database)
- [Admin Tools](#admin-tools)
- [Care Package System](#care-package-system)
- [Addons](#addons)
- [Logs & Monitoring](#logs--monitoring)
- [Settings & Public Directory](#settings--public-directory)
- [API Keys](#api-keys)
- [Discord Adapter (Experimental)](#discord-adapter-experimental)
- [Implementation Details](#implementation-details)

---

## Authentication & Setup

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/auth/state` | Get authentication state and CSRF token | None |
| POST | `/api/auth/login` | Login with password | `password` (string) |
| POST | `/api/auth/logout` | Logout current session | None |
| GET | `/api/health` | Health check | None |
| GET | `/api/setup/state` | Get setup completion state | None |
| POST | `/api/setup/preflight` | Run preflight checks | None |
| POST | `/api/setup/write-config` | Write setup config | `SERVER_IP`, `SERVER_TITLE`, etc. |
| POST | `/api/setup/save-token` | Save Funcom token | `token` (string) |
| POST | `/api/setup/init` | Initialize setup | None |
| GET | `/api/setup/tasks` | List background tasks | None |
| GET | `/api/setup/tasks/{id}` | Get task status | `id` (string) |
| GET | `/api/setup/tasks/{id}/stream` | Stream task output (SSE) | `id` (string) |

---

## Server Operations

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/server/status` | Server status command | None |
| GET | `/api/server/performance` | Performance snapshot (CPU, memory, disk) | None |
| GET | `/api/server/readiness` | Service readiness check | None |
| GET | `/api/server/ports` | List service ports | None |
| GET | `/api/server/services` | List services and status | None |
| GET | `/api/server/doctor` | Run diagnostic check | None |
| POST | `/api/server/network-bind/fix` | Fix network binding issue | None |
| POST | `/api/server/storage/cleanup-images` | Clean obsolete Docker images | `confirmation: "CLEAN OBSOLETE DUNE IMAGES"` |
| POST | `/api/server/storage/cleanup-build-cache` | Clean Docker build cache | `confirmation: "CLEAN DOCKER BUILD CACHE"` |
| POST | `/api/server/start` | Start server | None |
| POST | `/api/server/stop` | Stop server | None |
| POST | `/api/server/restart` | Restart all services | None |
| POST | `/api/server/restart-service` | Restart specific service | `service` (string) |
| POST | `/api/server/title` | Set server title | `title` (string) |
| POST | `/api/server/config` | Set server config | `title?`, `mode?` ("public" \| "local") |
| POST | `/api/server/funcom-token` | Save Funcom token | `token` (string) |
| GET | `/api/server/funcom-token/check` | Check Funcom token validity | `since` (query param) |
| GET | `/api/server/restart-schedule` | Get restart schedule status | None |
| POST | `/api/server/restart-schedule` | Save restart schedule | `enabled`, `time`, `notifyMinutes?` |
| GET | `/api/server/ip-change-restart` | Get IP change restart status | None |
| POST | `/api/server/ip-change-restart` | Save IP change restart config | `enabled`, `intervalMinutes?`, `notifyMinutes?` |
| POST | `/api/server/ip-change-restart/check` | Check for IP changes now | None |
| GET | `/api/server/restart-queue` | Get restart-queue settings, defaults, active state and battlegroup online count | None |
| POST | `/api/server/restart-queue` | Save restart-queue settings (partial; merges onto the current settings) | `enabled?`, `defaultCountdownMinutes?`, `broadcastCheckpoints?`, `broadcastDurationSec?`, `recoveryGraceMinutes?`, `messages?` |
| POST | `/api/server/restart-queue/cancel` | Cancel one active countdown | `id` |
| POST | `/api/server/restart-queue/restart-now` | Execute one queued restart immediately | `id` |
| GET | `/api/server/shutdown-protection` | Get shutdown protection status | None |
| POST | `/api/server/shutdown-protection` | Enable/disable shutdown protection | `enabled` (boolean) |
| POST | `/api/server/shutdown-protection/remove` | Remove shutdown protection | None |

When the Restart Queue is enabled, the restart routes above (`/api/server/restart`,
`/api/server/restart-service`, and the map/sietch restart paths) return
**`202 { queued: true, ... }`** when a restart is queued behind a countdown and
**`409 { queued: false, error }`** on a concurrency conflict; append
`?restartQueue=immediate` to force an immediate restart. See
[restart-queue.md](restart-queue.md).

---

## Updates

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| POST | `/api/updates/check-game` | Check for game updates | `fresh?` (boolean) |
| POST | `/api/updates/apply-game` | Apply game updates | None |
| POST | `/api/updates/fix-steamcmd` | Fix SteamCMD issues | None |
| POST | `/api/updates/check-stack` | Check for stack updates | None |
| POST | `/api/updates/apply-stack` | Apply stack updates | None |
| GET | `/api/updates/auto-game` | Get auto-update status | None |
| POST | `/api/updates/auto-game` | Save auto-update config | `enabled`, `intervalMinutes`, `applyEnabled`, `notifyEnabled`, `notifyMinutes`, `waitUntilEmpty`, `maxWaitMinutes`, `confirmation` |
| POST | `/api/updates/repair-runtime` | Repair runtime installation | None |

---

## Backups

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/backups` | List all backups | None |
| POST | `/api/backups/create` | Create new backup | None |
| POST | `/api/backups/restore` | Restore from backup | `backup` (string, filename) |
| GET | `/api/backups/{backup}/download` | Download backup archive | `backup` (string) |
| DELETE | `/api/backups/{backup}` | Delete backup | `backup` (string) |
| POST | `/api/backups/delete-all` | Delete all backups | None |
| POST | `/api/backups/import-external` | Import external backup | multipart form: `backup`, `metadata` |
| GET | `/api/backups/auto` | Get auto-backup status | None |
| POST | `/api/backups/auto` | Save auto-backup config | `enabled`, `time`, `retentionDays`, `intervalHours` |

---

## Players

### Listing & Search

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/players` | List players (paginated) | `q?`, `page?`, `pageSize?`, `status?` (`all`, `online`, `offline`, or `banned`), `sortColumn?`, `sortDirection?` |
| GET | `/api/players/online` | List currently online players | `page?`, `pageSize?` |
| GET | `/api/players/search` | Search players by name/ID | `q` (required, query param) |

Player rows include `total_playtime_seconds`. The console samples `player_state.online_status` every 10 seconds and persists completed session time in `dune.console_player_playtime`; the currently active session is included from `last_login_time`. Tracking begins when this console version first runs, so time from older completed sessions cannot be reconstructed.

### Player Profile & Data

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/players/{playerId}` | Get player profile summary | `playerId` |
| GET | `/api/players/{playerId}/inventory` | Get player inventory items — backpack, character gear, loadout, and unique-gear schematics (emote containers excluded), each row tagged with `inventory_type` | `playerId` |
| GET | `/api/players/{playerId}/vehicles` | Get vehicles owned by or shared with the player, including the player's access relationship | `playerId` |
| GET | `/api/players/{playerId}/currency` | Get player currency totals | `playerId` |
| GET | `/api/players/{playerId}/solaris-coin` | Get Solaris Coin total | `playerId` |
| GET | `/api/players/{playerId}/factions` | Get faction reputation | `playerId` |
| GET | `/api/players/{playerId}/intel` | Get intel data | `playerId` |
| GET | `/api/players/{playerId}/specs` | Get skill specializations | `playerId` |
| GET | `/api/players/{playerId}/position` | Get player position on map | `playerId` |
| GET | `/api/players/{playerId}/progression` | Get level and progression | `playerId` |
| GET | `/api/players/{playerId}/vitals` | Get health/hydration/addiction | `playerId` |
| GET | `/api/players/{playerId}/crafting-recipes` | Get unlocked recipes | `playerId` |
| GET | `/api/players/{playerId}/research-items` | Get research progress | `playerId` |
| GET | `/api/players/{playerId}/journey` | Get journey node completion | `playerId` |
| GET | `/api/players/{playerId}/events` | Get player events | `playerId` (unsupported) |
| GET | `/api/players/{playerId}/stats` | Get player stats | `playerId` (unsupported) |
| GET | `/api/players/{playerId}/history` | Get player history | `playerId` (unsupported) |

### Player Mutations (Item/XP/Skills)

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| POST | `/api/players/{playerId}/give-item` | Give item by name | `itemName`, `quantity`, `durability?`, `quality?`, `grade?`, `augments?`, `augmentQuality?` |
| POST | `/api/players/{playerId}/give-items` | Give multiple items | `items[]` (array), `historyScope?`, `historyFriendly?` |
| POST | `/api/players/{playerId}/give-item-id` | Give item by template ID | `itemId`, `quantity`, `durability?`, `quality?`, `grade?`, `augments?`, `augmentQuality?` |
| POST | `/api/players/{playerId}/add-xp` | Add XP | `amount` (number) |
| POST | `/api/players/{playerId}/set-skill-points` | Set skill points | `points` (number) |
| POST | `/api/players/{playerId}/set-skill-module` | Set skill module | `module` (string), `level` (number) |
| POST | `/api/players/{playerId}/refill-water` | Refill hydration | `amount?` (number) |

### Player Actions (Kick/Teleport/Vehicles)

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| POST | `/api/players/{playerId}/kick` | Kick player from server | None |
| GET | `/api/players/{playerId}/ban` | Get persistent account-ban status | None |
| POST | `/api/players/{playerId}/ban` | Persistently ban and enforce removal of a player's FLS account | `confirmation: "BAN PLAYER"`, `reason?` |
| DELETE | `/api/players/{playerId}/ban` | Remove a persistent account ban | None |
| POST | `/api/players/{playerId}/repair-login-queue` | Fix login queue issues | `confirmation: "REPAIR LOGIN QUEUE"` |
| POST | `/api/players/{playerId}/teleport` | Teleport to coordinates | `x`, `y`, `z`, `yaw`, `online?`, `partitionId?` |
| POST | `/api/players/{playerId}/spawn-vehicle` | Spawn vehicle | `vehicleId`, `template`, `offset` |

### Player Reset/Clean Operations

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| POST | `/api/players/{playerId}/clean-inventory` | Remove invalid items | `confirmation: "CLEAN INVENTORY"` |
| POST | `/api/players/{playerId}/reset-progression` | Reset character level | `confirmation: "RESET PROGRESSION"` |

### Player Resources & Progression

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| POST | `/api/players/{playerId}/add-currency` | Add currency | `currencyId`, `amount`, `confirmation` |
| POST | `/api/players/{playerId}/add-faction-reputation` | Add faction reputation | `factionId`, `amount`, `confirmation` |
| POST | `/api/players/{playerId}/faction` | Assign Atreides, Harkonnen, or Neutral | `factionId` (`1`, `2`, or `3`), `confirmation` |
| POST | `/api/players/{playerId}/add-intel` | Add intel | `amount`, `confirmation` |
| POST | `/api/players/{playerId}/specializations/add-xp` | Add spec XP | `trackType`, `amount`, `confirmation` |
| POST | `/api/players/{playerId}/specializations/grant-max` | Max out specialization | `trackType`, `confirmation` |
| POST | `/api/players/{playerId}/specializations/reset` | Reset specialization | `trackType`, `confirmation` |
| POST | `/api/players/{playerId}/specializations/keystones/grant-all` | Grant all keystones | `confirmation` |
| POST | `/api/players/{playerId}/specializations/keystones/reset-all` | Reset all keystones | `confirmation` |
| POST | `/api/players/{playerId}/crafting-recipes/unlock` | Unlock recipe | `recipeId`, `confirmation` |
| POST | `/api/players/{playerId}/research-items/unlock` | Unlock research | `itemKey`, `confirmation` |
| POST | `/api/players/{playerId}/journey/complete` | Complete journey node | `nodeId`, `confirmation` |
| POST | `/api/players/{playerId}/journey/reset` | Reset journey node | `nodeId`, `confirmation` |
| POST | `/api/players/{playerId}/tutorials/complete` | Complete tutorial | `tutorialId`, `confirmation` |
| POST | `/api/players/{playerId}/tutorials/reset` | Reset tutorial | `tutorialId`, `confirmation` |

### Player Equipment & Maintenance

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| POST | `/api/players/{playerId}/repair-gear` | Repair all equipment | `confirmation` |
| POST | `/api/players/{playerId}/repair-vehicle-decay` | Repair vehicle decay | `thresholdPercent`, `confirmation` |
| POST | `/api/players/{playerId}/refuel-vehicle` | Refuel vehicle | `vehicleId`, `confirmation` |
| POST | `/api/players/{playerId}/augment-item` | Apply augments to item | `itemId`, `augments[]`, `augmentQuality`, `confirmation` |

### Inventory Editing

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| DELETE | `/api/players/{playerId}/inventory/{itemId}` | Delete inventory item | `confirmation: "DELETE ITEM"` |
| PATCH | `/api/players/{playerId}/inventory/{itemId}` | Modify inventory item | `confirmation: "SAVE ITEM"`, `values` (object with changes) |

### Bulk Actions

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| POST | `/api/players/kick-all-online` | Kick all online players | `confirmation` |

---

## Guilds

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/guilds` | List guilds (paginated) | `q?`, `page?`, `pageSize?`, `sortColumn?`, `sortDirection?` |
| GET | `/api/guilds/{guildId}/members` | Get guild member list | `guildId` |

---

## Bases & Storage

### Bases

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/bases` | List bases (paginated) | `q?`, `page?`, `pageSize?`, `sortColumn?`, `sortDirection?` |
| GET | `/api/bases/{baseId}/export` | Export base as blueprint | `baseId` |
| POST | `/api/bases/{baseId}/refill-generators` | Refill all base generators (queued instead if the map isn't safely writable right now) | `baseId` |
| GET | `/api/bases/pending-refills` | List queued generator refills, grouped by restart target | None |
| DELETE | `/api/bases/{baseId}/queued-refill` | Cancel a base's queued generator refill | `baseId` |
| GET | `/api/bases/auto-refill` | Get per-base auto-refill enrollment state | None |
| POST | `/api/bases/{baseId}/auto-refill` | Enable/disable auto-refill for a base | `baseId`, `enabled` |
| GET | `/api/bases/{baseId}/water` | Get a base's water storage containers (count, volume, fill %; blood volume/fill for Blood Purifiers) | `baseId` |
| POST | `/api/bases/{baseId}/refill-water` | Refill all base water storage (queued instead if the map isn't safely writable right now). Water only -- blood is never touched | `baseId` |
| GET | `/api/bases/pending-water-refills` | List queued water refills, grouped by restart target | None |
| DELETE | `/api/bases/{baseId}/queued-water-refill` | Cancel a base's queued water refill | `baseId` |
| GET | `/api/bases/auto-refill-water` | Get per-base water auto-refill enrollment state | None |
| POST | `/api/bases/{baseId}/auto-refill-water` | Enable/disable water auto-refill for a base | `baseId`, `enabled` |
| GET | `/api/bases/{baseId}/inventory` | Get a base's stored items, rolled up by item template and by container (storage, refining, crafting, other). Merged per template, not per slot | `baseId` |
| GET | `/api/bases/{baseId}/containers/{placeableId}` | Get one container's inventories and their individual slots (item id, slot number, quantity, quality, durability, applied augments with their own per-augment quality), plus `deleteSafety` and `addSafety`. Answers `found: false` when that container is not at the base | `baseId`, `placeableId` |
| DELETE | `/api/bases/{baseId}/containers/{placeableId}/items/{itemId}` | Delete an item from a plain Storage container, or part of its stack with `count`. Refused unless the owning map is verifiably and safely stopped; Crafting and Refining contents are read-only. Requires `{ confirmation: "DELETE ITEM" }` | `baseId`, `placeableId`, `itemId`, `count?` |
| POST | `/api/bases/{baseId}/containers/{placeableId}/items` | Add a new item to a plain Storage container. Always creates a new row at the next free slot — never merges into an existing stack, and the slot cannot be chosen. Refused unless the owning map is verifiably and safely stopped; Crafting and Refining contents are read-only. Requires `{ confirmation: "ADD ITEM TO CONTAINER" }` | `baseId`, `placeableId`, `itemId`\|`itemName`, `quantity`, `quality?`, `augments?`, `augmentQuality?` |
| GET | `/api/bases/{baseId}/permissions` | Get a base's permission roster (Owner, Co-Owners, Associates) | `baseId` |
| POST | `/api/bases/{baseId}/system-custodian` | Transfer ownership to the Server or detected GM system custodian while preserving the roster; provisions Server when no custodian exists | `baseId` |
| PUT | `/api/bases/{baseId}/permissions` | Replace a base's permission roster | `baseId`, `entries[]` (`playerId`, `rank`) |
| GET | `/api/bases/permission-candidates` | Search players eligible to be added to a roster | `q?`, `limit?` |
| GET | `/api/bases/{baseId}/child-access` | Every child piece (door, device) on a base plus its own root totem (`is_child=false`), each with its access level — a different 5-tier scale from the roster rank above; Sub-Fief is Associate (3) | `baseId` |
| POST | `/api/bases/{baseId}/child-access` | Set specific pieces to specific access levels (1-5); queued for the next map restart instead if the base's map is live (`result.queued`). Requires `{ updates: [{ actorId, accessLevel }], confirmation: "SET CHILD ACCESS" }` | `baseId`, `updates[]` |
| GET | `/api/bases/pending-child-access` | List queued permission changes, grouped by restart target. Each entry carries its own `updates[]` payload | None |
| DELETE | `/api/bases/{baseId}/queued-child-access` | Discard a base's queued permission changes | `baseId` |
| DELETE | `/api/bases/{baseId}` | Permanently delete a base and everything on it (queued instead if the map isn't safely writable right now); takes a full-database safety backup first. Requires `{ confirmation: "DELETE BASE" }` | `baseId` |
| GET | `/api/bases/pending-deletes` | List queued base deletes, grouped by restart target | None |
| DELETE | `/api/bases/{baseId}/queued-delete` | Cancel a base's queued delete | `baseId` |

`GET /api/bases` excludes a base that has been picked up via the game's own
base-backup tool (unclaimed and registered in `dune.base_backup_linked_actors`
— see [base-backups.md](base-backups.md)), and every mutation route below
rejects one with **409** for the same reason.

A base that is unclaimed for any *other* reason still lists, and `GET
/api/bases/{baseId}/permissions` still reads it, reporting `claimed: false`. The
two permission mutation routes reject it with **400** rather than letting the
write fail `permission_actor_rank`'s foreign key — see
[base-permissions.md](base-permissions.md).

Each `GET /api/bases` row carries `partitionMap` and `dimensionIndex` alongside
`map` and `partition_id`. `map` is the game's own name (`HaggaBasin`) and cannot
distinguish two instances of one map; `partitionMap` is the name the rest of the
console uses (`Survival_1`), and `partition_id` identifies the single running
instance. Both are empty on a schema without `dune.world_partition`.

`GET /api/bases` reports `capabilities.basePermissions`; the permission routes are
unavailable when it is false (the schema lacks the required tables or the game's
`permission_set_player_rank` / `permission_remove_player_rank` procedures).

`GET /api/bases` also reports `capabilities.baseDelete` (the schema has the tables
and the game's `permission_actor_destroy` / `delete_actors` procedures) and
`capabilities.baseDeleteQueue` (additionally has `dune.world_partition`, so a
delete against a live map can be queued instead of written immediately). The
delete route is unavailable when `baseDelete` is false; without `baseDeleteQueue`
a delete against a live map is written straight away rather than queued, matching
the refill routes' behavior on a schema without `world_partition`. See
[Base deletion](base-deletion.md).

`GET /api/bases` also reports `capabilities.baseChildAccessQueue` (child access
plus `dune.world_partition`). Without it a child-access write against a live map
is applied straight away rather than queued, matching how the refill and delete
queues degrade on an older schema. Unlike those queues this one is not about an
autosave race — the write would stick — but a running map never applies an
access level change, so queuing keeps the console from showing a level the game
does not enforce. See
[base-child-permissions.md](base-child-permissions.md).

`PUT` takes the whole roster rather than a delta — the server diffs it against
current state and applies only the difference. `rank` is `1` Owner, `2` Co-Owner,
`3` Associate, and exactly one entry must be rank 1. `playerId` must be a player's
`player_state.player_controller_id`; any other actor id belonging to the same
account is rejected, because the game would ignore such a row. The roster size
limit comes from live server config, not a constant.

Changes reach a running map immediately — there is no restart queue, unlike the
generator refill routes above. See [base-permissions.md](base-permissions.md).

`GET /api/bases/{baseId}/inventory` covers storage containers plus refinery,
fabricator, and other inventories (recycler, repair station, the base's own
Sub-Fief console); generator and windtrap fuel belong to the refill and water
routes above. Its `containers[].items[]` is merged per item template, not per
slot — `GET /api/bases/{baseId}/containers/{placeableId}` is the per-slot view,
fetched one container at a time because slots roughly triple the response.

`POST …/containers/{placeableId}/items` (Add Item to Container, upstream's own
route) is refused unless `baseRefillTarget` can verify that the owning map is
safely stopped — an unknown state fails closed, and the route repeats the
check immediately before the write. It needs `bases:add-item`, not
`bases:mutate`. The add never merges into an existing stack and always
appends to `max(position_index) + 1`; the caller cannot pick a slot.

`DELETE …/containers/{placeableId}/items/{itemId}` (and the bulk
`DELETE …/items` / `DELETE …/all-items` routes), plus
`POST …/containers/{placeableId}/give-item`, `give-items`, and `fill-item`
(this fork's own #347 work), do **not** require the owning map to be
stopped — these are pure database writes with no live-sync path to a running
map (see [base-inventory.md](base-inventory.md)'s "Deletion does not require
a stopped map" section for the live-tested evidence this rests on). They need
`bases:delete-item`/`bases:bulk-delete-items`/`bases:give-item`/
`bases:fill-item` respectively, not `bases:mutate`.

Across all of the above, only plain Storage contents are mutable; Crafting
and Refining remain read-only because active jobs can reference their item
rows. The same allowlist that keeps fuel inventories out of the read keeps
them out of every write. This tab shipped read-only, so a `bases:mutate`
grant cannot be read as consent to destroy or fabricate items in any of these
routes. See [base-inventory.md](base-inventory.md).

Both `GET /api/bases/{baseId}/water` and `GET /api/bases/{baseId}/inventory`
answer **200 with `supported: false` and a `reason`** when the detected schema
lacks a table they need, rather than an error status — the same capability shape
`/api/bases` uses. An error status from either means a genuine failure, so the
tab can offer a retry only where retrying could actually help.

### Storage

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/storage` | List all storage containers | None |
| GET | `/api/storage/{storageId}` | Get storage details | `storageId` |
| GET | `/api/storage/{storageId}/items` | Get storage inventory | `storageId` |
| POST | `/api/storage/{storageId}/give-item` | Add item to storage | `itemName`, `quantity`, `confirmation: "GIVE ITEM TO STORAGE"` |
| GET | `/api/storage/{storageId}/export` | Export storage as JSON | `storageId` |

---

## Vehicles

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/vehicles` | List all player vehicles (paginated), each with owner, shared-with roster, lowest-component condition %, fuel %, map/partition, coordinates, and per-component durability | `q?`, `page?`, `pageSize?`, `sortColumn?`, `sortDirection?` |
| GET | `/api/players/{playerId}/vehicles` | List the selected player's owned and shared vehicles using the same vehicle details | `playerId` |
| GET | `/api/vehicles/{vehicleId}/permissions` | Get a vehicle's permission roster (Owner, Co-Owners, Associates) plus the detected system custodian | `vehicleId` |
| PUT | `/api/vehicles/{vehicleId}/permissions` | Replace a vehicle's permission roster | `vehicleId`, `entries[]` (`playerId`, `rank`) |
| POST | `/api/vehicles/{vehicleId}/system-custodian` | Transfer ownership to the Server or detected GM system custodian while preserving the roster; provisions Server when no custodian exists | `vehicleId` |
| GET | `/api/vehicles/permission-candidates` | Search players eligible to be added to a vehicle roster | `q?`, `limit?` |
| GET | `/api/vehicles/{vehicleId}/storage` | Read a vehicle's cargo hold slot by slot (read-only): capacity, per-slot item, quantity, grade, durability and augments | `vehicleId` |
| DELETE | `/api/vehicles/{vehicleId}/storage/items/{itemId}` | Delete one stack from a vehicle's cargo hold, or part of it with `count`. Requires `{ confirmation: "DELETE ITEM" }` | `vehicleId`, `itemId`, `count?` |
| DELETE | `/api/vehicles/{vehicleId}/storage/items` | Delete a chosen set of whole stacks (max 200). Requires `{ confirmation: "DELETE ITEMS" }` | `vehicleId`, `itemIds[]` |
| DELETE | `/api/vehicles/{vehicleId}/storage/all-items` | Empty a vehicle's cargo hold. Requires `{ confirmation: "DELETE ALL ITEMS" }` | `vehicleId` |
| DELETE | `/api/vehicles/{vehicleId}` | Permanently delete a vehicle and everything on it (queued instead if the map isn't safely writable right now); takes a full-database safety backup first. Requires `{ confirmation: "DELETE VEHICLE" }` | `vehicleId` |
| GET | `/api/vehicles/pending-deletes` | List queued vehicle deletes, grouped by restart target | None |
| DELETE | `/api/vehicles/{vehicleId}/queued-delete` | Cancel a vehicle's queued delete | `vehicleId` |

`GET /api/vehicles` and the player-scoped list are read-only; the permission
routes share their implementation with the base permission routes -- see
[vehicle-permissions.md](vehicle-permissions.md). The system-custodian route
mirrors the base one exactly, minus the backed-up guard, since a vehicle has
no picked-up state. The delete route mirrors `DELETE /api/bases/{baseId}` --
see [vehicle-deletion.md](vehicle-deletion.md). The storage routes read and
delete the vehicle's single cargo hold -- reached through
`dune.inventories.actor_id`, not `vehicle_module_id`, which is empty in
production. Deletion needs no stopped map but refuses while the vehicle is in
`Travel`/`VehicleBackup`/`VehicleRecovery`, and is gated on `vehicles:delete-item`
/ `vehicles:bulk-delete-items` rather than `vehicles:mutate` -- see
[vehicle-storage.md](vehicle-storage.md).

`GET /api/vehicles` reports `capabilities.vehicles`; it is false (with a
`reason`) when the schema lacks the required tables (`vehicles`, `vehicle_modules`,
`actors`, `permission_actor`, `permission_actor_rank`, `player_state`,
`actor_fgl_entities`, `fgl_entities`). It also reports
`capabilities.vehicleStorage` (the schema additionally has `dune.inventories`
and `dune.items`, which is what gates the Components tab's View Contents
button), and `capabilities.vehiclePermissions` (the schema additionally has `dune.map_names`
and the game's `permission_set_player_rank` / `permission_remove_player_rank`
procedures) -- the permission routes and the Permissions tab are unavailable
when it is false. `capabilities.vehicleDelete` similarly gates the Delete
Vehicle action (`dune.vehicles`/`vehicle_modules`/`actors` plus
`permission_actor_destroy`/`delete_actors`), and `capabilities.vehicleDeleteQueue`
additionally requires `dune.world_partition` -- without it, deletes are
always immediate rather than queued when the map is live. See
[vehicle-deletion.md](vehicle-deletion.md). Sortable `sortColumn` values: `id`, `name`,
`type`, `owner`, `condition_percent`, `fuel_percent`, `map`; `q` matches vehicle
name, type, owner, map, and exact id. Response fields mirror the paginated-list
convention (`rows`, `totalCount`, unfiltered `totalVehicles`). Owner resolves from
the rank-1 permission holder, falling back to the actor's account owner; the
`shared_with` roster is the rank 2/3 holders. A component's maximum durability is
read from its own stats blob (`MaxDurability`, else the decayed cap). If no stored
maximum exists, it is inferred only when at least two non-null current-durability
observations exist for the same template; inferred rows set `maxInferred: true`.
Missing current durability remains null and is never treated as 0% or 100%.
`condition_percent` is the lowest comparable component and
`condition_estimated` reports whether an inferred maximum contributed. Fuel
capacity is likewise the highest observed current fuel for a generator template;
`fuel_percent` is null with fewer than two non-null samples, while `current_fuel`
remains available for raw display.

The player-scoped route is also read-only. Its rows include `relationship`, derived
from account ownership and permission rank: `Owner`, `Co-Owner`, `Associate`, or
`Rank N` for a future/unknown nonstandard rank.

Each row also carries a `region` sub-region name where the map has a region table
(`runtime/data/hagga-regions.json`, extracted from the game paks; Hagga Basin is
covered). It is resolved from the nearest `dune.markers.area_id` and is best-effort
— absent when marker data is unavailable. Deep Desert instead exposes its A–I/1–9
sector grid, derived client-side from coordinates.

The separate `/api/admin/vehicles*` routes under [Admin Tools](#admin-tools) are a
different, CLI-backed surface (blueprint catalog and spawning), not this Postgres
read.

---

## Market Board

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/exchange/items` | List active CHOAM exchange sell orders aggregated by item + grade (paginated): lowest price, total stock, listing count | `q?`, `page?`, `pageSize?`, `sortColumn?`, `sortDirection?`, `owner?`, `category?` |
| GET | `/api/exchange/listings` | List the individual sell orders for one item, each with a resolved seller | `templateId`, `quality?`, `owner?` |
| GET | `/api/exchange/stats` | Aggregate totals (total, bot, player listings; unique items) | None |
| GET | `/api/exchange/transactions` | Paginated completed-order activity captured from this Console release forward, plus filtered event/unit/value totals | `q?`, `page?`, `pageSize?`, `hours?` (`0`\|`24`\|`168`\|`720`\|`2160`), `party?` (`all`\|`player`\|`bot`\|`npc`), `exchangeId?` |
| GET | `/api/exchange/config` | Read the console-local bot/blacklist filter config | None |
| POST | `/api/exchange/config` | Save the bot/blacklist filter config (audited, rate-limited) | body: `includeNpcBroker`, `botOwnerIds[]`, `blacklistedOwnerIds[]` |

The board endpoints are read-only over the game's own exchange rows (the game
writes them; the console never mutates them). `GET /api/exchange/items` reports `capabilities.exchange`; it
is false (with a `reason`) when the schema lacks the required tables
(`dune_exchange_orders`, `dune_exchange_sell_orders`, `items`, `actors`,
`player_state`).

The `owner` filter selects `all` (default for `/items`), `player`, or `bot`, where
**bot** = the in-game NPC broker (unless excluded via `includeNpcBroker: false`) OR a
configured `botOwnerIds` entry, **player** = the complement, and **all** = no owner
predicate. Blacklisted owner ids are excluded on every `owner` value. `includeNpcBroker`
(default true) is the built-in broker toggle: set it false to stop classifying the
in-game broker's orders as bot. Sortable `sortColumn` values: `display_name`, `template_id`,
`category`, `quality_level`, `tier`, `lowest_price`, `total_stock`, `listing_count`;
`q` matches `display_name`, `category`, and `template_id`. `category` filters to an
exact catalog category; the response also returns `categories` — the distinct
categories present in the current owner scope (computed before the category/search
filters, so the list is stable for populating a dropdown). The response mirrors the
paginated-list convention (`rows`, `totalCount` filtered, `totalItems` unfiltered).
Because `display_name`/`category`/`tier` come from the local `admin-items.json`
catalog rather than the database, search and sort run in the service after
enrichment (a short-TTL cache of the enriched aggregate keeps interactive paging
cheap).

`GET /api/exchange/listings` requires `templateId`; `quality` and `owner` are
optional. Each row carries `owner_type` (`player`|`bot`) and a resolved `owner_name`
(via `actors.owner_account_id → player_state.character_name`, falling back to the
actor class; NPC/broker orders show the in-game broker), plus `price`, `stock`, and
`quality`.

`GET /api/exchange/transactions` reads the Console-owned
`console_market_history.transactions` table. Its installation trigger snapshots
new fulfilled rows and positive `stack_size` update deltas without changing the
game row; ordinary recorder errors are handled inside the trigger. Quantities,
prices, values, and ids that originate as PostgreSQL `bigint` are returned as
decimal strings. `capabilities.exchangeHistory` reports schema support.

`POST /api/exchange/config` is the only user-triggered write in the board surface
and persists **only** the console-local `runtime/generated/exchange-config.json`
(no game-row writes). Ids are validated as numeric owner-id strings, deduped, and length-capped.
See [exchange.md](exchange.md) for how bot listings are identified and how the
blacklist behaves.

### Market Bot (console-managed seeding / buyback)

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/exchange/market` | Market Bot status: seed-plan availability, named seed-plan list (`plans`), both schedules, and the commodity-stack catalog | None |
| GET | `/api/exchange/market/exchanges` | Discover exchanges (BIGINT ids as strings; access-pointed exchanges first) | None |
| POST | `/api/exchange/market/buyback/probe` | Read-only buyback diagnostics: total, recognized, eligible, above-threshold, unknown-template, and invalid price/stack listing counts (no backup taken) | body: `exchangeId?`, `priceMultiplier?`, `augmentMultiplier?`, `rankedArmorMultiplier?`, `rankedWeaponMultiplier?`, `buybackPercent?`, `buybackPriceBasis?`, `maxBuys?` |
| GET | `/api/exchange/market/buyback/log` | Stored Buyback Sweep Log batches (purchased and skipped listings with reasons). Batches older than 5 days are omitted; the scheduler deletes them from disk at most hourly. | None |
| POST | `/api/exchange/market/buyback/log` | Read-only dry-run classify of player sell listings (eligible first, then skip reasons; capped at 1000 stored rows with leftovers reserved); appends a log batch (no backup taken). Rate-limited. | body: same optional overrides as the probe |
| POST | `/api/exchange/market/buyback/log/clear` | Clear stored Buyback Sweep Log batches. Requires `exchange:market-write`. Rate-limited. | None |
| POST | `/api/exchange/market/buyback/schedule` | Save the buyback schedule (audited, rate-limited) | body: `enabled`, `intervalMinutes`, `exchangeId`, `priceMultiplier`, `augmentMultiplier`, `rankedArmorMultiplier`, `rankedWeaponMultiplier`, `buybackPercent`, `buybackPriceBasis`, `maxBuys` |
| POST | `/api/exchange/market/seed/schedule` | Save the market reseed schedule (audited, rate-limited) | body: `enabled`, `intervalMinutes`, `exchangeId`, `priceMultiplier`, `augmentMultiplier`, `rankedArmorMultiplier`, `rankedWeaponMultiplier`, `augmentPricing` (`discounted`\|`original`), `commodityStacks` (object of templateId → 1–20 listing counts for allowlisted commodities) |
| POST | `/api/exchange/market/buyback/run` | Run a buyback sweep now with the saved schedule (probe → backup → sweep) | None |
| POST | `/api/exchange/market/seed/run` | Run a market reseed now with the saved schedule (backup → clear bot listings → seed) | None |
| POST | `/api/exchange/market/seed/clear` | Remove the bot's NPC listings from one exchange without reseeding (probe → backup → clear; no backup when the bot has none). Player listings and pending seller payments are never touched. Requires `exchange:market-write`. Rate-limited. | body: `exchangeId?` (defaults to the saved seed schedule's exchange) |
| GET | `/api/exchange/market/plans/csv` | Download the selected (or active) seed plan as CSV | query: `planId?` |
| POST | `/api/exchange/market/plans/csv` | Upload a UTF-8 CSV as the current seeding list: creates or replaces a named custom plan and makes it active. Only the documented seed-plan columns (names and numbers) are accepted; extra columns, SQL/JSON/HTML, formulas, and non-numeric cells are rejected. The bundled plan is never overwritten. Requires `exchange:market-write`. Rate-limited. | multipart: `file` (`.csv`), `name?` (friendly name; required when creating a plan), `planId?` (existing custom plan to replace) |
| POST | `/api/exchange/market/plans/active` | Set the active seed plan used by reseed and buyback | body: `planId` (`bundled` or a custom plan id) |
| POST | `/api/exchange/market/plans/name` | Rename a custom seed plan | body: `planId`, `name` |
| GET | `/api/exchange/market/items` | Merged, display-ready bot item catalog (bundled plan rows + admin-added new items), annotated with `overridden`/`isNew`/`unsafe` per row | None |
| GET | `/api/exchange/market/items/catalog` | Item picker for "add item": `admin-items.json` filtered to allowed categories and unsafe-id-free | query: `q?`, `category?` |
| POST | `/api/exchange/market/items` | Save per-item overrides/new items/removals in one batch (audited, rate-limited). Requires `exchange:market-write`. | body: `overrides?` (object of templateId → `{enabled?, price?, listings?}`), `newItems?` (object of templateId → `{name?, price, listings, enabled?, qualityLevel?, stackSize?}`), `removedNewItems?` (array of templateId) |

The three category multipliers (`augmentMultiplier`, `rankedArmorMultiplier`,
`rankedWeaponMultiplier`) accept 1–5 (up to two decimals, default 1 = no change)
and scale prices on top of the base `priceMultiplier` for augments & augment
schematics, ranked (grade 1–5) armor including stillsuits, and ranked weapons
respectively. On the seed schedule they raise the seeded sell prices; on the
buyback schedule they reprice the reconstructed "seeded" price basis. Ready-made
augment item caps also follow the reseed schedule's `augmentPricing`
(`discounted` vs `original`) so `buybackPercent` is a percentage of what the bot
actually lists, even when the two schedules use different augment multipliers.

The seed schedule's `commodityStacks` map overrides how many full stacks of
allowlisted commodities a reseed lists (1–20, default 2). Unknown template ids
are ignored. Units per stack stay at the plan `stack_size`. The catalog of
editable items is returned on `GET /api/exchange/market` as
`commodityStackCatalog` / `commodityStackGroups`.

The `/api/exchange/market/items*` routes are a separate, per-item override layer
on top of the bundled seed plan (`runtime/generated/market-bot/items.json`, never
written back into `market-seed-plan.json`). They are merged in at read time for
both the seed run and the buyback price caps, so a disabled or repriced item
behaves the same in both jobs. New items may only reference a template id already
present in `runtime/data/admin-items.json` (never free text); `buildings`,
`contracts`, and `emotes` categories and any id in the seed plan's
`unsafe_template_ids` are rejected outright. See
[exchange.md](exchange.md#bot-items-catalog-overrides) for the full behavior.

Unlike the board above, these routes **do write the game database** through the
native Market Bot engine (`addonJobs.js` / `addonSeedJob.js`). Reads, the probe, and
dry-run log refresh require `exchange:market`; schedule saves, run-now, and log
clear require `exchange:market-write` (the admin tier's `exchange:*` covers both).
Schedules saved here are marked `source: "console"`, run unattended inside the
console API process, and do not require an addon; the seed plan is the **active**
named plan (the bundled `runtime/data/market-seed-plan.json` until the operator
imports a CSV-backed list and sets it active). `buybackPercent` is an integer
from 1 to 500. Every write is preceded by a database
backup, and buyback runs probe eligibility read-only first so idle intervals
never take a backup. See [exchange.md](exchange.md#market-bot) for behavior
details.

---

## Blueprints

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/blueprints` | List all blueprints | None |
| GET | `/api/blueprints/{blueprintId}/export` | Export single blueprint | `blueprintId` |
| POST | `/api/blueprints/export` | Bulk export blueprints | `ids[]` (array, max 500) |
| POST | `/api/blueprints/import` | Import blueprint file | multipart form: `player_id`, `file` |
| DELETE | `/api/blueprints/{blueprintId}` | Delete blueprint | `blueprintId` |

See [blueprints.md](blueprints.md) for the full import/export design.

---

## Maps & World

### Map Management

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/maps` | List all maps | None |
| GET | `/api/map/status` | Get status of all maps | None |
| GET | `/api/maps/mode` | Get map mode (static/dynamic) | `map?` (query param) |
| POST | `/api/maps/mode` | Set map mode | `map`, `mode`, `confirmation: "SET MAP MODE"` |
| POST | `/api/maps/settings` | Save map settings | `map`, `partitionId?`, `mode?`, `memory?`, `modeChanged`, `memoryChanged`, `confirmation: "SAVE MAP SETTINGS"` |
| GET | `/api/maps/runtime-settings` | Get runtime configuration | None |
| POST | `/api/maps/runtime-settings` | Save runtime configuration | `alwaysOnStartupParallelism` |
| POST | `/api/maps/reconcile` | Reconcile map state | `confirmation: "RECONCILE MAPS"` |
| POST | `/api/maps/spawn` | Spawn map server | `target`, `confirmation: "SPAWN MAP"` |
| POST | `/api/maps/despawn` | Despawn map server | `target`, `confirmation: "DESPAWN MAP"` |
| POST | `/api/maps/respawn` | Restart a map with no managed service (despawn then respawn its partition) | `target`, `confirmation: "RESTART MAP"` |

### Memory Management

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/maps/memory` | Get memory status | None |
| POST | `/api/maps/memory` | Set/unset map memory | `map`, `memory`, `action`, `confirmation` |
| GET | `/api/maps/memory/balancer` | Get memory balancer state | None |
| POST | `/api/maps/memory/balancer` | Enable/disable memory balancer | `enabled` |
| GET | `/api/maps/memory/swap` | Get memory swap status | None |
| POST | `/api/maps/memory/swap` | Enable/disable memory swap | `enabled`, `perServerGiB?`, `poolGiB?`, `swappiness?` (0-100, default 10), `confirmation` |
| GET | `/api/maps/memory/live` | Get live per-map RAM usage and, when enabled/supported, current swap usage and allowance | None |

### Autoscaler

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/maps/autoscaler` | Get autoscaler status | None |
| POST | `/api/maps/autoscaler` | Autoscaler action | `action`, `confirmation: "AUTOSCALER CHANGE"` |

### Spicefields & Trade

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/maps/spicefields` | List spicefields | None |
| PATCH | `/api/maps/spicefields/{typeId}` | Update spicefield config | `max_globally_active`, `max_globally_primed`, `is_spawning_active`, `global_spawn_weight` |
| GET | `/api/maps/choam-terminals` | Get CHOAM terminal overview | None |
| POST | `/api/maps/choam-terminals` | Install CHOAM terminals | `tradeCenterKey` |
| DELETE | `/api/maps/choam-terminals` | Remove CHOAM terminals | `tradeCenterKey` |

### Combat & User Settings

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/maps/combat-state` | Get combat state by partition | `map` (query param) |
| GET | `/api/maps/user-settings/schema` | Get user settings schema | None |
| GET | `/api/maps/user-settings/restart-pending` | Check if a Landsraad-field restart is pending | None |
| GET | `/api/maps/user-settings/deferred-pending` | Check if a "Restart later" deferred save is pending (any UserEngine/UserGame save) | None |
| GET | `/api/maps/user-settings/values` | Get settings values | `scope`, `map?`, `partitionId?` |
| GET | `/api/maps/user-settings/raw` | Get raw settings file | `kind`, `map?`, `partitionId?` |
| POST | `/api/maps/user-settings/save` | Save user settings | `scope`, `map?`, `partitionId?`, `values`, `restart?`, `deferRestart?` |
| POST | `/api/maps/user-settings/reset` | Reset to defaults | `scope`, `map?`, `partitionId?`, `confirmation: "RESTORE MAP DEFAULTS"`, `deferRestart?` |
| POST | `/api/maps/user-settings/raw` | Save raw settings | `scope`, `map?`, `partitionId?`, `content`, `deferRestart?` |
| POST | `/api/maps/user-settings/materialize` | Refresh settings | `confirmation: "REFRESH MAP SETTINGS"` |

### Engine & Game Settings

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/maps/userengine` | Get UserEngine configuration | None |
| GET | `/api/maps/usergame` | Get UserGame configuration | `map?`, `partitionId?` |

### Sietches & Deep Desert

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/sietches` | List sietches | None |
| GET | `/api/sietches/dimensions` | Get sietch dimensions | `map?`, `ids?` |
| POST | `/api/sietches/update` | Update sietch config | Various options (set-max, set-active, set-display, etc.) |
| GET | `/api/deepdesert` | Get Deep Desert status | None |
| POST | `/api/deepdesert/update` | Update Deep Desert | `action`, `confirmation: "UPDATE DEEP DESERT"` |

---

## Live Map

See [live-map.md](live-map.md) for how the panel uses these endpoints --
partition display-name resolution, the spice/POI data model, and the
Layers legend's default-settings mechanism.

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/map/capabilities` | Get map feature capabilities | None |
| GET | `/api/map/markers` | Get map markers & configuration (actors, merged with spice/POI rows; response also includes `coriolisSeed`, `coriolisNextCycleAt`) | `map?`, `partitionId?`, `static?` (`0` omits static archive/POI rows for lightweight live refreshes) |
| GET | `/api/map/spice` | Get spice/flour-sand layers (static pool, active blows, flour sand) for a map/partition | `map?`, `partitionId?` (query params) |
| GET | `/api/map/poi` | Get registry-driven POI layers (ore, scrap, flora, poi, house_representative, trainer, fortress, hazard, enemy) for a map | `map?` (query param) |
| POST | `/api/map/teleport-player` | Teleport player to map coords | `playerId`, `x`, `y`, `z`, `yaw?`, `partitionId?`, `online?` |
| GET | `/api/map/partitions` | List map partitions | None |
| GET | `/api/map/players` | Get player positions | `map?` (query param) |
| GET | `/api/map/bases` | Get base locations | `map?` (query param) |
| GET | `/api/map/storage` | Get storage locations | `map?` (query param) |
| GET | `/api/map/services` | Get service locations | `map?` (query param) |

---

## Database

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/database/status` | Database status | None |
| GET | `/api/database/schemas` | List database schemas | None |
| GET | `/api/database/tables` | List tables in schema | `schema?` (default: "dune") |
| GET | `/api/database/tables/{schema}/{table}/columns` | Get column information | `schema`, `table` |
| GET | `/api/database/tables/{schema}/{table}/preview` | Preview table data | `schema`, `table`, `limit?`, `offset?`, `filter?` |
| GET | `/api/database/tables/{schema}/{table}/count` | Get row count | `schema`, `table`, `filter?` |
| PATCH | `/api/database/tables/{schema}/{table}/row` | Update table row | `rowId`, `values` (object) |
| GET | `/api/database/search` | Search database | `q` or `term` (query param) |
| POST | `/api/database/query` | Execute SQL query | `query` (read or write) — see note below |
| POST | `/api/database/export` | Export query results | `query` (read-only SELECT/WITH/SHOW/EXPLAIN) |
| POST | `/api/database/password` | Change database password | `password` |
| GET | `/api/database/table/{table}` | Preview table | `table`, `limit?`, `offset?` |

**`/api/database/query` authorizes on the SQL, not just the route.** The route
resolves to `database:query`, which covers read-only SQL (`SELECT`, `WITH`,
`SHOW`, `EXPLAIN`). SQL the classifier reads as a write additionally requires
`database:execute`, checked inside the handler once the body is parsed; a caller
without it gets `403` before the rate-limit tick and before the pre-write backup.

**The permission is not the enforcement.** `database:execute` is selected by a
classifier that a mutating `select dune.<fn>(...)` passes — so a write can be
routed down the read path. That path executes inside a `set transaction read
only` transaction, and Postgres refuses the write whatever the classifier
concluded. The transaction is the guarantee; the action decides which path is
taken and whether a backup is made.

The default `admin` policy grants `database:query` and denies `database:execute`;
`owner` holds both. Use `/api/database/export` for read-only result export.

A body with nothing to execute — empty, whitespace, `;`, or entirely
commented-out SQL — returns `400` first. Such input does not start with a read
keyword, so without that check it classifies as a write and triggers a full
pre-write backup before the query is rejected.

---

## Admin Tools

### Item & Vehicle Catalogs

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/admin/items/catalog` | Item catalog with search | `q?`, `limit?` |
| GET | `/api/admin/items/search` | Search items | `q` (query param) |
| GET | `/api/admin/items` | List items by category | `category?` (query param) |
| GET | `/api/admin/vehicles/structured` | Get structured vehicle list | None |
| GET | `/api/admin/vehicles` | List or search vehicles | `q?` (query param) |
| GET | `/api/admin/skill-modules` | List or search skill modules | `q?` (query param) |

### History & Settings

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/admin/history` | Get admin command history | None |
| POST | `/api/admin/history/clear` | Clear admin history | `scope?` ("all" or "admin-tools") |
| GET | `/api/admin/character-transfer-settings` | Get character transfer settings | None |
| POST | `/api/admin/character-transfer-settings` | Save/restore character transfer settings | `settings?` or `restoreDefaults: true` |
| GET | `/api/admin/message-of-the-day` | Get MOTD settings | None |
| POST | `/api/admin/message-of-the-day` | Save/restore MOTD | `settings?` or `restoreDefaults: true` |
| GET | `/api/admin/player-announcements` | Get announcement settings | None |
| POST | `/api/admin/player-announcements` | Save/restore announcements | `settings?` or `restoreDefaults: true` |

### Landsraad

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/admin/landsraad` | Get Landsraad overview | None |
| GET | `/api/admin/landsraad/milestone-preset` | Get milestone preset | None |
| POST | `/api/admin/landsraad/milestone-preset` | Save milestone preset | `enabled`, `goalAmount`, `thresholds[]` |
| POST | `/api/admin/landsraad/task-goal` | Update task goal | `taskId`, `goalAmount` |
| POST | `/api/admin/landsraad/term-task-goals` | Update term task goals | `termId`, `goalAmount` |
| POST | `/api/admin/landsraad/reward-tier` | Update reward tier | `rowLocator`, `taskId`, `threshold`, `newThreshold`, `templateId`, `amount` |
| POST | `/api/admin/landsraad/player-contribution` | Set player contribution | `playerId`, `taskId`, `amount` |

### Broadcasts & Messages

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| POST | `/api/admin/broadcast` | Broadcast message to all | `title`, `body`, `durationSec` |
| POST | `/api/admin/map-chat` | Send map chat message | `mapName`, `dimension`, `body` |
| POST | `/api/admin/broadcast-shutdown` | Broadcast shutdown notice | `shutdownType`, `delayMinutes`, `confirmation: "SHUTDOWN BROADCAST"` |

---

## Care Package System

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/care-package/capabilities` | Get care package capabilities | None |
| GET | `/api/care-package/config` | Get care package configuration | None |
| POST | `/api/care-package/config` | Save care package config | Config object + `confirmation: "SAVE CARE PACKAGE"` |
| GET | `/api/care-package/grants` | Get grant history | `limit?` |
| GET | `/api/care-package/history` | Get grant history (alias) | `limit?` |
| POST | `/api/care-package/history/clear` | Clear grant history | `confirmation: "CLEAR GRANT HISTORY"` |
| GET | `/api/care-package/eligible` | Get eligible players | `ruleId?`, `onlyEligible?` |
| POST | `/api/care-package/grant-eligible` | Grant to eligible players | `confirmation` |
| POST | `/api/care-package/run` | Run care package scan | `confirmation: "RUN CARE PACKAGE SCAN"` |
| POST | `/api/care-package/grant/{playerId}` | Grant to specific player | `playerId`, `confirmation`, `kitId?` |
| POST | `/api/care-package/retry/{grantId}` | Retry failed grant | `grantId`, `confirmation` |
| POST | `/api/care-package/enable` | Enable care package | `confirmation: "ENABLE CARE PACKAGE"` |
| POST | `/api/care-package/disable` | Disable care package | `confirmation: "DISABLE CARE PACKAGE"` |

---

## Addons

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/addons/community` | Get community addon catalog | None |
| GET | `/api/addons/installed` | Get installed addons | None |
| POST | `/api/addons/community/install` | Install community addon | `id`, `approvedPermissions[]` |
| POST | `/api/addons/community/update` | Update community addon | `id`, `approvedPermissions[]` |
| POST | `/api/addons/installed/{id}/enable` | Enable addon | `id` |
| POST | `/api/addons/installed/{id}/disable` | Disable addon | `id` |
| DELETE | `/api/addons/installed/{id}` | Remove addon | `id` |
| POST | `/api/addons/installed/{id}/bridge` | Addon bridge API | `id`, `action`, payload varies |
| GET | `/api/addons/installed/{id}/content/{path}` | Get addon content file | `id`, `path` |

### Hardware Status Bridge

`server.hardware.status` requires approved `server:status` addon permission and returns the core-owned hardware snapshot documented in [Addon Hardware Status Bridge](../addons/hardware-status.md). Addon packages are never permitted to execute their own telemetry scripts.

---

## Logs & Monitoring

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/logs/services` | List available services | None |
| GET | `/api/logs/{service}` | Get service logs | `service` |
| GET | `/api/logs/{service}/stream` | Stream service logs (SSE) | `service` |
| GET | `/api/logs/{service}/download` | Download service logs | `service` |

---

## Settings & Public Directory

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| POST | `/api/settings/admin-password` | Change admin password | `currentPassword`, `newPassword` |
| POST | `/api/settings/web-port` | Change web console port | `port` (number 1-65535) |
| POST | `/api/settings` | Write config | Config object |
| GET | `/api/settings` | Get setup state | None |
| GET | `/api/public-directory/status` | Get public directory status | None |
| POST | `/api/settings/public-directory` | Save public directory and anonymous-count settings | `enabled?`, `anonymousCountEnabled?`, `discordInvite?` |
| POST | `/api/settings/public-directory/claim` | Claim server listing | `code` |

---

## IAM Policies

Per-tier Allow/Deny documents for the action catalog. Architecture and evaluation order: [../console-iam.md](../console-iam.md).

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/settings/iam/policies` | Active policy store, plus `actions`: the full sorted catalog of valid action names | None |
| PUT | `/api/settings/iam/policy` | Validate and atomically save the complete policy store | Policy store object (every tier) |
| POST | `/api/settings/iam/policy/test` | Evaluate one action for one tier without changing policy | `action`, `tier` |

`PUT` refuses two kinds of bad action name, each with its own `400` payload:

- **`unknownActions`** — the name matches nothing in the catalog. The test is
  whether a pattern matches at least one catalogued action, so wildcards remain
  legal (`players:*`, `bases:delete-*`) while near-misses that match nothing
  (`player:*`, `players:reset-*`) are rejected. This matters because the failure
  is asymmetric: a misspelled action in an `Allow` grants nothing, but in a
  `Deny` it withholds nothing while reading exactly like a restriction.
- **`deprecatedActions`** — the name is one the catalog used to have
  (`players:mutate`, `guilds:mutate`, `blueprints:mutate`, `addons:mutate`). Each
  entry carries `successors`, so the edit is mechanical. These still evaluate
  with their original meaning, so a stored policy keeps working; only saving is
  refused. See [../console-iam.md](../console-iam.md#upgrading-a-policy-that-names-a-removed-action).

`POST .../test` returns `known` alongside `allowed`. A misspelled action answers
`allowed: false`, which reads as a working `Deny`; `known: false` is what separates a
real denial from a typo.

---

## API Keys

Named, revocable bearer credentials for calling this API from outside the browser. Full feature documentation: [api-keys.md](api-keys.md).

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/settings/api-keys` | List API keys, without any secret or hash | None |
| GET | `/api/settings/api-keys/catalog` | List the namespaces a key can be scoped to, and whether each supports writes | None |
| POST | `/api/settings/api-keys` | Create a key. Returns the full key once, in `secret` | `name`, `scopes?` (map of namespace to `"read"` \| `"write"`), `expiresAt?` (ISO date or null), `rateLimitPerMinute?` (1-10000, default 60) |
| PUT | `/api/settings/api-keys/{id}` | Update a key. `scopes` replaces wholesale | `id`, `name?`, `scopes?`, `enabled?`, `expiresAt?`, `rateLimitPerMinute?` |
| DELETE | `/api/settings/api-keys/{id}` | Revoke a key permanently | `id` |

These five routes map to `settings:read` and `settings:write`, and the `settings` namespace is permanently denied to API keys — so a key can never list, create, or revoke keys, including itself. Key management is a browser-session operation only.

`POST` returns `{ key, secret }`. `secret` is the only time the full key exists outside the server; only its SHA-256 hash is stored, so a lost key must be revoked and replaced rather than recovered.

A key omitting `scopes` is created with no access at all. Unrecognised namespaces, unrecognised levels, and the permanently denied `settings`, `database` and `setup` namespaces are dropped rather than coerced — nothing falls back to `"read"`. A `"write"` level on `updates` or `addons`, whose writes are denied to keys, is stored as `"read"`.

Invalid input to the create and update routes — a blank or over-long name, or an expiry that is not a future date string — returns `400` with the reason.

Requests authenticated by a key return `401` when the credential is invalid, disabled or expired, `403` when the key's scopes do not cover the route's action, and `429` with a `retry-after` header when the key exceeds its per-minute limit. A request carrying no `Authorization` header is unaffected and uses the browser session as before.

---

## Discord Adapter (Experimental)

All Discord adapter endpoints require bearer token authentication (`DUNE_DISCORD_ADAPTER_TOKEN`) and support role-based capability checks. The adapter is disabled by default; enable with `DUNE_DISCORD_ADAPTER_ENABLED=true`.

See [../integrations/discord-integration/README.md](../integrations/discord-integration/README.md) for setup and configuration, or [../integrations/discord-control-bot/api-adapter-contract.md](../integrations/discord-control-bot/api-adapter-contract.md) for the full adapter contract.

### Health & Status

| Method | Route | Description | Capability |
|--------|-------|-------------|-----------|
| GET | `/api/integrations/discord/health` | Adapter health status | None |
| GET | `/api/integrations/discord/status` | Server status | `status:read` |
| GET | `/api/integrations/discord/readiness` | Service readiness | `readiness:read` |
| GET | `/api/integrations/discord/services` | Services list | `services:read` |
| GET | `/api/integrations/discord/population` | Player population | `population:read` |
| GET | `/api/integrations/discord/version` | Adapter version | None |
| GET | `/api/integrations/discord/servers` | Servers list | None |
| GET | `/api/integrations/discord/ports` | Ports list | None |
| GET | `/api/integrations/discord/catalog` | Command catalog (names/descriptions/capabilities/min tiers for every live route below, machine-readable) | None -- bearer token only, same as `/health`. Deliberately no per-capability check: this is read-only metadata about route/command shape, not game or player data (see `commandCatalog.js`). |

### Logs & Monitoring

| Method | Route | Description | Capability |
|--------|-------|-------------|-----------|
| GET | `/api/integrations/discord/logs` | Service logs | `logs:read` |
| GET | `/api/integrations/discord/ops/activity` | Ops activity | `ops:read` |
| GET | `/api/integrations/discord/ops/combat` | Ops combat stats | `ops:read` |
| GET | `/api/integrations/discord/ops/resources` | Ops resources | `ops:read` |
| GET | `/api/integrations/discord/ops/economy` | Ops economy | `ops:read` |

### World State (Planned)

| Method | Route | Description | Capability |
|--------|-------|-------------|-----------|
| GET | `/api/integrations/discord/map-state` | Map state | `map-state:read` |
| POST | `/api/integrations/discord/maintenance` | Maintenance mode | `maintenance:write` |
| GET | `/api/integrations/discord/backups/list` | Backup list | `backups:read` |
| POST | `/api/integrations/discord/broadcast` | Send broadcast | `broadcast:write` |
| POST | `/api/integrations/discord/announcements` | Send announcements | `announcements:write` |

### Inventory & Players

| Method | Route | Description | Capability |
|--------|-------|-------------|------------|
| POST | `/api/integrations/discord/players/link` | Link Discord to player | `player-link:write` |
| POST | `/api/integrations/discord/players/link/verify` | Verify player link | `player-link:write` |
| POST | `/api/integrations/discord/players/unlink` | Unlink Discord from player | `player-link:write` |
| GET | `/api/integrations/discord/players/me` | Get current player | `inventory:read` |
| GET | `/api/integrations/discord/players/inventory` | Get player inventory | `inventory:read` |
| GET | `/api/integrations/discord/players/storage` | Get player storage | `inventory:read` |
| GET | `/api/integrations/discord/players/find` | Find player | `players:read` |
| GET | `/api/integrations/discord/players/inventory-search` | Search inventory | `inventory:read` |

### Guilds & Data

| Method | Route | Description | Capability |
|--------|-------|-------------|------------|
| GET | `/api/integrations/discord/guilds/storage` | Get guild storage | `guilds:read` |
| GET | `/api/integrations/discord/guilds/find` | Find guild | `guilds:read` |
| POST | `/api/integrations/discord/db` | Database query (planned) | `database:read` / `database:write` |

---

## Implementation Details

### Rate Limiting
- Most mutation endpoints are rate-limited per user session and IP address
- Limits are typically 20 requests/minute per session+IP combination
- Exceeding limits returns `429 Too Many Requests`

### Confirmation Phrases
Destructive/dangerous operations require exact confirmation phrases in the request body:
- Examples: `"DELETE ITEM"`, `"SAVE ITEM"`, `"SET MAP MODE"`, `"CLEAN INVENTORY"`
- This is independent of any client-side dialog and provides server-side protection
- All required confirmations are listed in the endpoint tables above

### Error Responses
Failed requests return error objects:
```json
{
  "error": "...",
  "reason": "...",
  "details": { ... }
}
```

### Pagination
List endpoints with paginated results use these query parameters:
- `q` — search query (optional)
- `page` — page number (default: 0)
- `pageSize` — results per page (default: 20)
- `sortColumn` — column to sort by
- `sortDirection` — "asc" or "desc"

Results include:
- `totalCount` — filtered result count
- `totalXxx` — unfiltered total (e.g., `totalPlayers`, `totalBases`)

### Task Tracking
Long-running operations return task objects:
```json
{
  "task": {
    "id": "task-uuid",
    "type": "...",
    "operation": "...",
    "status": "running|completed|failed",
    ...
  }
}
```

Poll status with `GET /api/setup/tasks/{id}` or stream with `GET /api/setup/tasks/{id}/stream` (Server-Sent Events).

### Database Mutations
- Read-only: queries starting with `SELECT`, `WITH`, `SHOW`, `EXPLAIN`
- Write-capable: `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `ALTER`
- Write operations do not create automatic backups; responses always report `backupCreated: false`. Take a manual backup first if you want a rollback point before a destructive query.

### Authentication
- All endpoints except `/api/health`, `/api/auth/login`, and `/api/auth/state` require:
  - Session cookie: `asc_session`
  - CSRF token header: `x-csrf-token`
- Obtain CSRF token from `GET /api/auth/state`

### Discord Adapter Auth
- Separate from admin console authentication
- Uses bearer token: `Authorization: Bearer <DUNE_DISCORD_ADAPTER_TOKEN>`
- Token from env var `DUNE_DISCORD_ADAPTER_TOKEN` or file `DUNE_DISCORD_ADAPTER_TOKEN_FILE`
- Enforces role-based capabilities with read-only restrictions on game data

---

## Notes

- **Last generated:** 2026-07-29
- **Source:** Comprehensive scan of `console/api/src/server.js`, Discord adapter routes, and frontend API clients
- **Status:** This reference covers all currently implemented endpoints. Some Discord adapter endpoints are marked "Planned" and return stubs.
