# Dune: Awakening Console API Reference

**Status:** Current | **Last Updated:** August 2026

Complete reference for all HTTP API endpoints in the Dune Docker Console. All endpoints require authentication (session cookie + CSRF token) unless otherwise noted.

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
- [Blueprints](#blueprints)
- [Maps & World](#maps--world)
- [Live Map](#live-map)
- [Database](#database)
- [Admin Tools](#admin-tools)
- [Care Package System](#care-package-system)
- [Addons](#addons)
- [Logs & Monitoring](#logs--monitoring)
- [Settings & Public Directory](#settings--public-directory)
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
| GET | `/api/server/shutdown-protection` | Get shutdown protection status | None |
| POST | `/api/server/shutdown-protection` | Enable/disable shutdown protection | `enabled` (boolean) |
| POST | `/api/server/shutdown-protection/remove` | Remove shutdown protection | None |

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

### Player Profile & Data

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/players/{playerId}` | Get player profile summary | `playerId` |
| GET | `/api/players/{playerId}/inventory` | Get player inventory items | `playerId` |
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
| GET | `/api/bases/{baseId}/inventory` | Get a base's stored items, rolled up by item template and by container (storage, refining, crafting, machines). Read-only | `baseId` |
| GET | `/api/bases/{baseId}/permissions` | Get a base's permission roster (Owner, Co-Owners, Associates) | `baseId` |
| POST | `/api/bases/{baseId}/system-custodian` | Transfer ownership to the detected Server or GM system custodian while preserving the roster | `baseId` |
| PUT | `/api/bases/{baseId}/permissions` | Replace a base's permission roster | `baseId`, `entries[]` (`playerId`, `rank`) |
| GET | `/api/bases/permission-candidates` | Search players eligible to be added to a roster | `q?`, `limit?` |

Each `GET /api/bases` row carries `partitionMap` and `dimensionIndex` alongside
`map` and `partition_id`. `map` is the game's own name (`HaggaBasin`) and cannot
distinguish two instances of one map; `partitionMap` is the name the rest of the
console uses (`Survival_1`), and `partition_id` identifies the single running
instance. Both are empty on a schema without `dune.world_partition`.

`GET /api/bases` reports `capabilities.basePermissions`; the permission routes are
unavailable when it is false (the schema lacks the required tables or the game's
`permission_set_player_rank` / `permission_remove_player_rank` procedures).

`PUT` takes the whole roster rather than a delta — the server diffs it against
current state and applies only the difference. `rank` is `1` Owner, `2` Co-Owner,
`3` Associate, and exactly one entry must be rank 1. `playerId` must be a player's
`player_state.player_controller_id`; any other actor id belonging to the same
account is rejected, because the game would ignore such a row. The roster size
limit comes from live server config, not a constant.

Changes reach a running map immediately — there is no restart queue, unlike the
generator refill routes above. See [base-permissions.md](base-permissions.md).

`GET /api/bases/{baseId}/inventory` covers storage containers plus refinery,
fabricator and machine inventories; generator and windtrap fuel belong to the
refill and water routes above. It is read-only — inventory writes have no path
to a running map. See [base-inventory.md](base-inventory.md).

### Storage

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/storage` | List all storage containers | None |
| GET | `/api/storage/{storageId}` | Get storage details | `storageId` |
| GET | `/api/storage/{storageId}/items` | Get storage inventory | `storageId` |
| POST | `/api/storage/{storageId}/give-item` | Add item to storage | `itemName`, `quantity`, `confirmation: "GIVE ITEM TO STORAGE"` |
| GET | `/api/storage/{storageId}/export` | Export storage as JSON | `storageId` |

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
| GET | `/api/maps/user-settings/restart-pending` | Check if restart pending | None |
| GET | `/api/maps/user-settings/values` | Get settings values | `scope`, `map?`, `partitionId?` |
| GET | `/api/maps/user-settings/raw` | Get raw settings file | `kind`, `map?`, `partitionId?` |
| POST | `/api/maps/user-settings/save` | Save user settings | `scope`, `map?`, `partitionId?`, `values`, `restart?` |
| POST | `/api/maps/user-settings/reset` | Reset to defaults | `scope`, `map?`, `partitionId?`, `confirmation: "RESTORE MAP DEFAULTS"` |
| POST | `/api/maps/user-settings/raw` | Save raw settings | `scope`, `map?`, `partitionId?`, `content` |
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

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/map/capabilities` | Get map feature capabilities | None |
| GET | `/api/map/markers` | Get map markers & configuration | `map?` (query param) |
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
| POST | `/api/database/query` | Execute SQL query | `query` (read or write) |
| POST | `/api/database/export` | Export query results | `query` (read-only SELECT/WITH/SHOW/EXPLAIN) |
| POST | `/api/database/password` | Change database password | `password` |
| GET | `/api/database/table/{table}` | Preview table | `table`, `limit?`, `offset?` |

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
| POST | `/api/settings/public-directory` | Save public directory settings | `enabled?`, `discordInvite?` |
| POST | `/api/settings/public-directory/claim` | Claim server listing | `code` |

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
