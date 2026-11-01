# Dune: Awakening Console API Reference

**Status:** Current | **Last Updated:** November 2026

Complete reference for all HTTP API endpoints in the Dune Docker Console. All endpoints require authentication unless otherwise noted (the exceptions are listed under [Authentication](#authentication)) — either a browser session (session cookie + CSRF token) or a scoped API key sent as `Authorization: Bearer <key>`. See [api-keys.md](api-keys.md) for how key scopes are granted and what they can never reach. For the database these endpoints read and write — the encryption view layer, the notify channels that decide whether a write reaches a running map server, and the capability probes that make an endpoint report a feature as unsupported rather than fail — see [DATABASE.md](../architecture/DATABASE.md).

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
- [Market Board](#market-board)
- [Blueprints](#blueprints)
- [Maps & World](#maps--world)
- [Live Map](#live-map)
- [Realtime Data](#realtime-data)
- [Database](#database)
- [Admin Tools](#admin-tools)
- [Care Package System](#care-package-system)
- [Addons](#addons)
- [Logs & Monitoring](#logs--monitoring)
- [Settings & Public Directory](#settings--public-directory)
- [Localization (i18n)](#localization-i18n)
- [IAM Policies](#iam-policies)
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
| POST | `/api/setup/write-config` | Write setup config | `SERVER_IP?`, `SERVER_IP_MODE?`, `SERVER_TITLE?`, `SERVER_REGION?`, `HOST_DATACENTER_ID?` (letters, digits, dots and hyphens, max 253; 400 if invalid), `SERVER_PROVIDER?`, `STEAM_APP_ID?`, `BATTLEGROUP_ID?`. Other keys are ignored |
| POST | `/api/setup/save-token` | Save Funcom token | `token` (string, at least 20 characters) |
| POST | `/api/setup/init` | Initialize setup | None |
| GET | `/api/setup/tasks` | List background tasks | None |
| GET | `/api/setup/tasks/{id}` | Get task status | `id` (string) |
| GET | `/api/setup/tasks/{id}/stream` | Stream task output (SSE) | `id` (string) |

---

## Server Operations

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/server/status` | Structured server status and command diagnostics | `raw?` (`0` omits legacy command output), `fresh?` (`1` skips cached snapshots) |
| GET | `/api/server/performance` | Performance snapshot (CPU, memory, disk) | None |
| GET | `/api/server/restart-history` | Recent restart rows (newest first, at most 100) and `lastBattlegroupRestart` | None |
| GET | `/api/server/readiness` | Service readiness check | `fresh?` (`1` skips cached snapshots) |
| GET | `/api/server/ports` | List service ports | None |
| GET | `/api/server/services` | List services and status | None |
| GET | `/api/server/doctor` | Run diagnostic check | None |
| POST | `/api/server/network-bind/fix` | Fix network binding issue | None |
| POST | `/api/server/storage/cleanup-images` | Clean obsolete Docker images | `confirmation: "CLEAN OBSOLETE DUNE IMAGES"` |
| POST | `/api/server/storage/cleanup-build-cache` | Clean Docker build cache | `confirmation: "CLEAN DOCKER BUILD CACHE"` |
| POST | `/api/server/start` | Start server | None |
| POST | `/api/server/stop` | Stop server | None |
| POST | `/api/server/restart` | Restart all services | None |
| POST | `/api/server/restart-service` | Restart specific service | `service` (`postgres`, `rmq-admin`, `rmq-game`, `text-router`/`tr`, `director`/`bgd`, `gateway`/`sgw`, `survival`, `survival-1`, `overmap`, `orchestrator`, `autoscaler`, `coriolis`, or a `dune-server-<name>` container name; 400 otherwise) |
| POST | `/api/server/title` | Set server title | `title` (1-80 characters, no line breaks) |
| POST | `/api/server/config` | Set server config | `title?` (as `/api/server/title`), `mode?` (`public` \| `local`); at least one is required |
| POST | `/api/server/funcom-token` | Save Funcom token and restart all services (returns 202 with a task) | `token` (string, at least 20 characters) |
| GET | `/api/server/funcom-token/check` | Check Funcom token validity | `since?` (query: log window such as `10m` or `2h`, or an ISO-8601 UTC timestamp; default `5m`, also used for invalid values) |
| GET | `/api/server/restart-schedule` | Get restart schedule status | None |
| POST | `/api/server/restart-schedule` | Save restart schedule | `enabled` (boolean; false disables and ignores the rest), `time?` (`HH:MM`, default `05:00`), `notifyMinutes?` (integer 1-1440, default 15) |
| GET | `/api/server/ip-change-restart` | Get IP change restart status | None |
| POST | `/api/server/ip-change-restart` | Save IP change restart config | `enabled`, `intervalMinutes?` (integer 1-1440, default 5), `notifyMinutes?` (integer 0-60, default 1) |
| POST | `/api/server/ip-change-restart/check` | Check for IP changes now | None |
| GET | `/api/server/restart-queue` | Get restart-queue settings, defaults, active state and battlegroup online count | `partitionId?`, `map?` (query; either scopes `playersOnline` to that map or partition; `battlegroupPlayersOnline` stays battlegroup-wide) |
| POST | `/api/server/restart-queue` | Save restart-queue settings (partial; merges onto the current settings) | `enabled?`, `defaultCountdownMinutes?` (1-1440), `broadcastCheckpoints?` (up to 12 values of 1-1440), `broadcastDurationSec?` (1-3600), `recoveryGraceMinutes?` (0-1440), `messages?` (`{battlegroup,map}.{title,body}`; title max 80, body max 500) |
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

### Structured Server Status

`GET /api/server/status` returns a stable, versioned object for integrations. Use `data` instead of parsing command output:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "data": {
    "summary": {
      "overall": "READY",
      "title": "My Dune Server",
      "region": "Europe",
      "mode": "public",
      "serverIp": "203.0.113.10",
      "battlegroup": "sh-example",
      "population": { "current": 4, "capacity": 60 }
    },
    "containers": [{ "name": "dune-postgres", "status": "Up 2 hours" }],
    "listeners": [{ "name": "Postgres localhost", "port": 15432, "protocol": "TCP", "status": "OK" }],
    "database": { "worldPartitions": 36 },
    "gameServers": [{ "map": "Survival_1", "status": "READY", "uptime": "Up 2 hours" }],
    "automation": { "autoscaler": "RUNNING", "autoUpdates": "DISABLED" },
    "rabbitmq": { "directorConnections": 1, "gameServerConnections": 2, "textRouterConnections": 1, "details": null },
    "fls": { "directorHeartbeat": "OK", "populationDeclaration": "OK", "maxCapacityDeclaration": "OK", "gatewayDbMonitoring": "OK" }
  }
}
```

Unavailable numeric and boolean values are `null`, and unavailable collections are empty arrays. `ok` reports whether the underlying status command completed successfully; health is reported separately in `data.summary.overall`. The legacy `operation`, `stdout`, `stderr`, and `exitCode` fields remain available for command diagnostics and backward compatibility. Add `?raw=0` to omit those legacy fields and return only the compact structured response. Status snapshots are cached briefly and refreshed in the background so frequent integration polling does not repeatedly block on the same host checks. Add `?fresh=1` to wait for a current reading instead. Responses carry `sampledAt`, when the command actually ran (a cached answer keeps its original time), and `fromCache`; both are absent when the command failed. Starting, stopping or restarting the Battlegroup discards cached snapshots. `/api/server/readiness` takes the same `fresh` parameter and returns the same two fields.

---

## Updates

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| POST | `/api/updates/check-game` | Check for game updates | `fresh?` (boolean) |
| POST | `/api/updates/apply-game` | Apply game updates | None |
| POST | `/api/updates/fix-steamcmd` | Fix SteamCMD issues | None |
| POST | `/api/updates/install-assets` | Install game files and images only, without touching the database | None |
| POST | `/api/console/reload` | Recreate the Console container so it reads a changed `.env` (no image rebuild) | None |
| GET | `/api/updates/qa/status` | QA Tester Login state for this browser session and the installed channel (`release` or `qa`) | `refresh?` (`1` re-checks with the QA service) |
| POST | `/api/updates/qa/login` | Start a Discord-gated QA Tester Login (device flow). Returns `requestId` and an `authorizeUrl` to open | None |
| POST | `/api/updates/qa/logout` | End this session's QA Tester Login | None |
| GET | `/api/updates/qa/build` | Latest QA pre-release build (`sha`, `ready`, `updateAvailable`, `commitsAheadOfRelease`). 403 unless the QA login is authorized | None |
| POST | `/api/updates/qa/apply` | Install the latest QA build as a task. 409 if the build has not passed all checks or is already installed | None |
| POST | `/api/updates/qa/reinstall-release` | Reinstall the public release (leave the QA channel) as a task. Needs an authorized QA login | None |
| GET | `/api/updates/stack-progress` | Progress of a running Console self-update; `consoleReplaced` is true once the Console process was replaced. 400 on a bad `runId` | `runId` (query, required UUID; 400 if missing or invalid), `startedAt?` (query, ISO timestamp of the task start) |
| POST | `/api/updates/check-stack` | Check for stack updates | None |
| POST | `/api/updates/apply-stack` | Apply stack updates | None |
| GET | `/api/updates/auto-game` | Get auto-update status | None |
| POST | `/api/updates/auto-game` | Save auto-update config | `confirmation: "SAVE AUTO GAME UPDATES"`, `enabled` (boolean; false disables and ignores the rest), `intervalMinutes?` (5-1440, default 60), `applyEnabled?` (default true), `notifyEnabled?` (default true), `notifyMinutes?` (1-12 unique descending minute marks of 1-1440, array or comma string; default `15,10,5,1`), `waitUntilEmpty?` (default false), `maxWaitMinutes?` (0-10080, default 360), `updateConsole?` (boolean, default false), `manageTanks?` (boolean, default false) |
| POST | `/api/updates/repair-runtime` | Repair runtime installation | None |

Successful game checks are cached for 30 minutes in
`runtime/generated/game-update-check.json`, including across Console restarts.
Authenticated browser requests may pass `fresh: true` to force a live Steam
query; API keys always use the shared cached path.

---

## Backups

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/backups` | List all backups | None |
| POST | `/api/backups/create` | Create new backup | None |
| POST | `/api/backups/restore` | Restore from backup | `backup` (string, filename), `identityMode?` (`adopt-backup` or `keep-current`) |
| GET | `/api/backups/{backup}/download` | Download backup archive (dump + metadata) | `backup` (string) |
| DELETE | `/api/backups/{backup}` | Delete backup | `backup` (string) |
| POST | `/api/backups/delete-all` | Delete all backups | None |
| POST | `/api/backups/delete-selected` | Delete the named database backups | `backups` (1-100 file names) |
| POST | `/api/backups/import-external` | Import external backup | multipart form: `backup`, `metadata` |
| GET | `/api/backups/system` | List encrypted system backups (archive + non-secret sidecar fields) | None |
| POST | `/api/backups/system/create` | Create an encrypted system backup (database + `.env` + `runtime/generated` + `runtime/secrets`). Requires `backups:create-system` | `passphrase` (string, 12-1024 chars, at least 5 different characters) |
| POST | `/api/backups/system/import` | Upload a system backup: the `.tar` the download produces, or a bare `.tar.gz.enc`. Body is the file itself, streamed to disk. Requires `backups:import-system` | `filename?` (query; a name is minted if absent or invalid), `onConflict?` (query: `overwrite` or `rename`; without it an existing name returns 409 with `conflict`); the body is the raw file |
| GET | `/api/backups/system/{name}/download` | Download a system backup as one uncompressed `.tar` holding the encrypted archive and its `.yaml` sidecar. Add `?raw=1` for the bare archive, or name the sidecar directly to fetch it alone. Streamed, never buffered. Requires `backups:download-system` | `name` (string), `raw` (optional) |
| DELETE | `/api/backups/system/{name}` | Delete a system backup and its `.yaml` sidecar. Requires `backups:delete-system` | `name` (string) |
| POST | `/api/backups/system/delete-selected` | Delete the named system backups. Requires `backups:delete-system` | `backups` (string array) |
| POST | `/api/backups/system/delete-all` | Delete every system backup. Requires `backups:delete-system` | None |
| POST | `/api/backups/system/{name}/restore` | Restore a system backup: database, `.env`, `runtime/generated`, `runtime/secrets`. Dry run unless `apply` is set. **An apply is refused with 409 unless the same caller has successfully previewed this archive** (see below). Does not restart the stack. Requires `backups:restore-system` | `name` (string), `passphrase` (12-1024 chars), `apply` (optional), `identityMode` (optional: `adopt-backup` or `keep-current`), `auditLogMode` (optional: `adopt-backup` or `keep-current`) |
| GET | `/api/backups/auto` | Get auto-backup status | None |
| POST | `/api/backups/auto` | Save auto-backup config | `enabled` (boolean; false disables and ignores the rest), `time?` (`HH:MM`, default `05:00`), `retentionDays?` (integer 0-3650, default 0 = no limit), `intervalHours?` (integer 1-168, default 24) |

See [database-backups.md](database-backups.md) for the difference between a plain
backup and a system backup, the passphrase and Battlegroup-identity rules the
`system/*` and `restore` routes above enforce, and how to move an archive to a
new host.

### Preview before apply is enforced by the API

A system restore replaces `.env`, `runtime/secrets/`, `runtime/generated/` and the
database. `apply` is therefore refused with **409** unless the *same* caller has
already run a preview of that archive that **succeeded**:

- Send the restore with `apply` omitted (or false) and wait for the task to
  finish. A preview that fails authorizes nothing.
- Then send it again with `apply: true`.

The preview is remembered against the calling session or API key, the archive's
name, and a hash of the archive's bytes. An apply is refused when the archive
changed after the preview (409, "changed after it was previewed"), when the
preview has expired (409, "expired"), or when it was another caller who
previewed. A successful restore consumes the preview, so a repeated apply needs
a fresh one; a *failed* restore does not, so a retry does not need one.

`identityMode` and `auditLogMode` may be chosen at apply time even when the
preview did not carry them — the preview is what reveals that a choice is
needed. Changing an answer the preview already carried is refused.

The window is `ADMIN_RESTORE_PREVIEW_TTL_MS` (default 15 minutes, floor 1 minute,
ceiling 2 hours). Previews are held in memory, so restarting the console clears
them.

---

## Players

### Listing & Search

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/players` | List players (paginated). Set `recentOnly=1` to keep online players and hide offline players beyond the configured inactivity threshold. | `q?`, `page?`, `pageSize?` (1-200, default 50), `status?` (`all`, `online`, `offline`, or `banned`), `sortColumn?`, `sortDirection?`, `recentOnly?` (`1`) |
| GET | `/api/players/list-settings` | Read the Active Players visibility threshold (`null`/Never by default) and whether the current session may change it | None |
| POST | `/api/players/list-settings` | Change the inactivity threshold; `null` means Never | `inactiveWeeks` (whole number from 1 to 8, or `null`) |
| GET | `/api/players/online` | List currently online players | `page?`, `pageSize?` |
| GET | `/api/players/search` | Search players by name/ID | `q?` (query param; omitted lists the first page of all players) |
| GET | `/api/players/deleted-characters` | List deleted characters holding bases or vehicles, plus unattributed orphaned assets. See [deleted-characters.md](deleted-characters.md) | None |

Player rows include `total_playtime_seconds`. The console samples `player_state.online_status` every 10 seconds and persists completed session time in `dune.console_player_playtime`; the currently active session is included from `last_login_time`. Tracking begins when this console version first runs, so time from older completed sessions cannot be reconstructed.

### Player Profile & Data

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/players/{playerId}` | Get player profile summary | `playerId` |
| GET | `/api/players/{playerId}/inventory` | Get player inventory items — backpack, character gear, loadout, and unique-gear schematics (emote containers excluded), each row tagged with `inventory_type` | `playerId` |
| GET | `/api/players/{playerId}/vehicles` | Get vehicles owned by or shared with the player, including the player's access relationship. Returns at most 200 rows. Optional `?access=owner\|coowner` narrows the list: `owner` is a vehicle the player's account owns or where they hold roster rank 1; `coowner` is roster rank 2 on a vehicle their account does not own (default and any other value: all roster ranks; guild/public piece access is not per-player and is never listed). The filter narrows what is returned; it is not an authorization control, and `players:read` still gates the route | `playerId` |
| GET | `/api/players/{playerId}/bases` | List the bases the player holds a roster rank on (one request, capped at 5,000 rows), with the player's access relationship. Optional `?access=owner\|coowner` narrows to rank 1 / rank 2 (default and any other value: all roster ranks; guild/public access is per-piece, so it is not listed here), and the totals follow the filter. Also accepts `q`, `sortColumn`, `sortDirection` | `playerId`, `q?`, `access?` (`owner` or `coowner`), `sortColumn?`, `sortDirection?` |
| GET | `/api/players/{playerId}/currency` | Get player currency totals | `playerId` |
| GET | `/api/players/{playerId}/solaris-coin` | Get Solaris Coin total | `playerId` |
| GET | `/api/players/{playerId}/factions` | Get faction reputation | `playerId` |
| GET | `/api/players/{playerId}/intel` | Get intel data | `playerId` |
| GET | `/api/players/{playerId}/specs` | Get skill specializations. Each `skillModules` row carries the raw `skill_points_spent` (the game stores a cumulative point *cost*, not a rank) plus `max_level` from the catalog and the `level` resolved against that module's `pointLadder` in `runtime/data/admin-skill-modules.json` — read `level` for the rank | `playerId` |
| GET | `/api/players/{playerId}/position` | Get player position on map | `playerId` |
| GET | `/api/players/{playerId}/progression` | Get level and progression | `playerId` |
| GET | `/api/players/{playerId}/vitals` | Get health/hydration/addiction | `playerId` |
| GET | `/api/players/{playerId}/crafting-recipes` | Get unlocked recipes | `playerId` |
| GET | `/api/players/{playerId}/research-items` | Get research progress | `playerId` |
| GET | `/api/players/{playerId}/journey` | Get journey node completion | `playerId` |
| GET | `/api/players/{playerId}/events` | Get player events | `playerId` (unsupported) |
| GET | `/api/players/{playerId}/stats` | Get player stats | `playerId` (unsupported) |
| GET | `/api/players/{playerId}/history` | Get player history | `playerId` (unsupported) |
| GET | `/api/players/{playerId}/teleport-destinations` | Safe teleport destinations for this player: other players and bases in the player's current partition | `playerId` |
| GET | `/api/players/{playerId}/building-unlocks` | Building Sets catalog with the player's per-set status, plus `capabilities` | `playerId` |
| GET | `/api/players/{playerId}/character-recovery` | Deleted-character recovery candidates for the account, and whether the player is online | `playerId` |

### Player Mutations (Item/XP/Skills)

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| POST | `/api/players/{playerId}/give-item` | Give item by name | `itemName`, `quantity?` (integer 1-1000000, default 1), `quality?` or `grade?` (integer 0-5), `augments?` (array, max 20; player must be offline), `augmentQuality?` (integer 1-5, default 1) |
| POST | `/api/players/{playerId}/give-items` | Give multiple items | `items[]` (1-25 entries, each as give-item or give-item-id), `historyScope?` (`admin-tools` records Admin Tools history), `historyFriendly?` (history label). Without `items` the legacy bundle grant runs, taking `template?` (only `scout-ornithopter-mk6`) |
| POST | `/api/players/{playerId}/give-item-id` | Give item by template ID | `itemId`, `quantity?` (integer 1-1000000, default 1), `quality?` or `grade?` (integer 0-5), `augments?` (array, max 20; player must be offline), `augmentQuality?` (integer 1-5, default 1) |
| POST | `/api/players/{playerId}/add-xp` | Add XP | `amount` (integer 1-100000000) |
| POST | `/api/players/{playerId}/set-skill-points` | Set skill points | `points` (integer 0-100000; player must be online, else 409) |
| POST | `/api/players/{playerId}/set-skill-module` | Set skill module | `module` (string, 1-120 characters), `level` (integer 0-100); player must be online, else 409 |
| POST | `/api/players/{playerId}/refill-water` | Refill hydration | `amount?` (integer 1-1000000000, default 1000000) |
| GET | `/api/players/{playerId}/customizations` | Cosmetic catalog and current status | `playerId` |
| POST | `/api/players/{playerId}/customizations/grant` | Grant a cosmetic or set | `itemId` or `groupId` (`all` grants every group), `confirmation: "GRANT CUSTOMIZATIONS"` |

The Halloween 2026 set contains the Derelict Recovery Suit, both plague doctor
mask variants, and the Halloween swatch. These four entries unlock directly in
the character's customization list and require the player to be fully offline.
They report `Unlocked`; repeated requests preserve the existing list and skip
duplicates. Other sets retain their inventory-token delivery and entitlement
requirements. The response separates `unlocked` from `delivered` and
`requested`; per-entry `ownershipVerified` applies only to direct event unlocks.
These customization IDs are excluded from the general inventory catalog.

### Player Actions (Kick/Teleport/Vehicles)

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| POST | `/api/players/{playerId}/kick` | Kick player from server | None |
| GET | `/api/players/{playerId}/ban` | Get persistent account-ban status | None |
| POST | `/api/players/{playerId}/ban` | Persistently ban and enforce removal of a player's FLS account | `confirmation: "BAN PLAYER"`, `reason?` (max 500 characters) |
| DELETE | `/api/players/{playerId}/ban` | Remove a persistent account ban | None |
| POST | `/api/players/{playerId}/repair-login-queue` | Fix login queue issues | `confirmation: "REPAIR LOGIN QUEUE"` |
| POST | `/api/players/{playerId}/teleport` | Teleport to coordinates, a player or a base | `mode?` (`coordinates` default, `player`, or `base`), `x`, `y`, `z` (numbers within ±100000000; coordinates mode), `destinationId` (player or base id; `player` and `base` modes, same map only), `partitionId?` (online: must be the player's current partition; offline: required, coordinates mode only) |
| POST | `/api/players/{playerId}/spawn-vehicle` | Spawn vehicle | `vehicleId`, `template`, `offset?` (number 0-100000, default 1000) |

### Player Reset/Clean Operations

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| POST | `/api/players/{playerId}/clean-inventory` | Remove invalid items | `confirmation: "CLEAN INVENTORY"` |
| POST | `/api/players/{playerId}/reset-progression` | Reset character level | `confirmation: "RESET PROGRESSION"` |

### Player Resources & Progression

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| POST | `/api/players/{playerId}/add-currency` | Add currency | `currencyId?` (default 0 = Solaris; 1 = House Credit), `amount` (non-zero integer within ±1000000000000; negative subtracts), `confirmation: "ADD CURRENCY"` |
| POST | `/api/players/{playerId}/add-faction-reputation` | Add faction reputation | `factionId` (integer 1-32767), `amount` (non-zero integer within ±12474), `confirmation: "ADD FACTION REPUTATION"` |
| POST | `/api/players/{playerId}/faction` | Assign Atreides, Harkonnen, or Neutral | `factionId` (`1` Atreides, `2` Harkonnen, `3` Neutral), `confirmation: "CHANGE PLAYER FACTION"` |
| POST | `/api/players/{playerId}/add-intel` | Add intel | `amount` (integer 1-1000000000; the balance is capped at 2779), `confirmation: "ADD INTEL"` |
| POST | `/api/players/{playerId}/specializations/add-xp` | Add spec XP | `trackType` (`Combat`, `Crafting`, `Exploration`, `Gathering` or `Sabotage`; case-insensitive), `amount` (non-zero integer within ±44182), `confirmation: "ADD SPECIALIZATION XP"` |
| POST | `/api/players/{playerId}/specializations/grant-max` | Max out specialization | `trackType` (as add-xp), `confirmation: "GRANT MAX SPECIALIZATION"` |
| POST | `/api/players/{playerId}/specializations/reset` | Reset specialization | `trackType` (as add-xp), `confirmation: "RESET SPECIALIZATION"` |
| POST | `/api/players/{playerId}/specializations/keystones/grant-all` | Grant all keystones | `confirmation: "GRANT ALL KEYSTONES"` |
| POST | `/api/players/{playerId}/specializations/keystones/reset-all` | Reset all keystones | `confirmation: "RESET ALL KEYSTONES"` |
| POST | `/api/players/{playerId}/crafting-recipes/unlock` | Unlock recipe | `recipeId`, `confirmation: "UNLOCK CRAFTING RECIPE"` |
| POST | `/api/players/{playerId}/research-items/unlock` | Unlock research | `itemKey`, `confirmation: "UNLOCK RESEARCH ITEM"` |
| POST | `/api/players/{playerId}/journey/complete` | Complete journey node | `nodeId` (max 500 characters), `confirmation: "COMPLETE JOURNEY NODE"` |
| POST | `/api/players/{playerId}/journey/reset` | Reset journey node | `nodeId`, `confirmation: "RESET JOURNEY NODE"` |
| POST | `/api/players/{playerId}/tutorials/complete` | Complete tutorial | `tutorialId` (integer 1-32767), `confirmation: "COMPLETE TUTORIAL"` |
| POST | `/api/players/{playerId}/tutorials/reset` | Reset tutorial | `tutorialId` (integer 1-32767), `confirmation: "RESET TUTORIAL"` |
| POST | `/api/players/{playerId}/building-unlocks/grant` | Grant one Building Set. No-op if already owned or pending; `status` is `Delivered` (online) or `Pending` | `itemId`, `confirmation: "GRANT BUILDING UNLOCK"` |
| POST | `/api/players/{playerId}/repair-faction-reputation` | Resynchronise faction reputation and vendor access. The player must be offline | `confirmation: "REPAIR FACTION REPUTATION"` |
| POST | `/api/players/{playerId}/repair-landsraad-quests` | Repair stuck Landsraad quests. Diagnoses first and takes a full-database backup only when a repair is needed. The player must be offline | `confirmation: "REPAIR LANDSRAAD QUESTS"` |
| POST | `/api/players/{playerId}/character-recovery` | Recover a replaced (deleted) character: takes a safety backup, stops the Survival partition, restores, then restarts it (`mapRestarted`, `restartError`). The player must be offline | `candidateId`, `confirmation: "RECOVER DELETED CHARACTER"` |

### Player Equipment & Maintenance

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| POST | `/api/players/{playerId}/repair-gear` | Repair all equipment | `confirmation: "REPAIR GEAR"` |
| POST | `/api/players/{playerId}/repair-vehicle-decay` | Repair vehicle decay. The player must be offline. Any running map partition holding an affected vehicle is stopped, repaired, then restarted (`mapServersRestarted`, `restartedMaps`, `restartFailures`) | `thresholdPercent?` (number 1-100, default 50), `confirmation: "REPAIR VEHICLE DECAY"` |
| POST | `/api/players/{playerId}/refuel-vehicle` | Refuel vehicle | `vehicleId` (vehicle actor id owned by the player), `confirmation: "REFUEL VEHICLE"` |
| POST | `/api/players/{playerId}/augment-item` | Apply augments to item | `itemId` (inventory item id), `augments[]` (1-20 augment template ids), `augmentQuality?` (integer 1-5, default 1), `confirmation: "APPLY AUGMENTS"` |

### Inventory Editing

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| DELETE | `/api/players/{playerId}/inventory/{itemId}` | Delete inventory item | `confirmation: "DELETE ITEM"` |
| PATCH | `/api/players/{playerId}/inventory/{itemId}` | Modify inventory item | `confirmation: "SAVE ITEM"`, `values` (object; editable keys `stack_size`, `quality_level`, `position_index`, `current_durability`; others are ignored; `max_durability` is rejected) |

### Bulk Actions

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| POST | `/api/players/kick-all-online` | Kick all online players | `confirmation: "KICK ALL ONLINE PLAYERS"` |

---

## Guilds

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/guilds` | List guilds (paginated) | `q?`, `page?`, `pageSize?`, `sortColumn?`, `sortDirection?` |
| GET | `/api/guilds/{guildId}/members` | Get guild member list | `guildId` |
| POST | `/api/guilds/{guildId}/members` | Add a player to a guild. Enforces the live server member limit; refused if the player is already in a guild or the faction is incompatible | `playerId`, `roleId?` (1-99, default 1; never creates a second Leader) |
| DELETE | `/api/guilds/{guildId}/members/{playerId}` | Remove a member. Refused for the guild leader | `guildId`, `playerId` |
| POST | `/api/guilds/{guildId}/members/{playerId}/promote` | Promote one rank: Member to Officer, Officer to Leader (the current Leader is demoted). A Leader answers `alreadyLeader: true`. Online players may need to relog | `guildId`, `playerId` |
| POST | `/api/guilds/{guildId}/members/{playerId}/demote` | Demote an Officer to Member. Refused for the Leader and for a plain Member | `guildId`, `playerId` |
| DELETE | `/api/guilds/{guildId}` | Disband a guild; its member rows go with it | `guildId`, `confirmation: "DISBAND GUILD"` |

---

## Bases & Storage

### Bases

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/bases` | List bases (paginated) | `q?`, `page?`, `pageSize?`, `sortColumn?`, `sortDirection?` |
| GET | `/api/bases/{baseId}/export` | Export base as blueprint | `baseId` |
| GET | `/api/bases/{baseId}/export-backup` | Export a live (not picked-up) base as a base backup file, importable with `POST /api/base-backups/import` (`bases:export-backup`; rate limited, audited). Read-only; 409 `no_owner` for an ownerless base, 409 `picked_up` for a picked-up one. See [base-backups.md](base-backups.md#downloading-a-live-base-as-a-base-backup) | `baseId`; 400 bad id, 404 unknown base or no totem, 501 unsupported, 503 timeout |
| POST | `/api/bases/{baseId}/refill-generators` | Refill all base generators and windtrap filters (queued instead if the map isn't safely writable right now). Windtrap filters keep their current tier, capped at 5. Returns "No generators, wind turbines or windtraps were found at this base" if none exist | `baseId` |
| GET | `/api/bases/pending-refills` | List queued generator refills, grouped by restart target | None |
| DELETE | `/api/bases/{baseId}/queued-refill` | Cancel a base's queued generator refill | `baseId` |
| GET | `/api/bases/auto-refill` | Get per-base auto-refill enrollment state | None |
| POST | `/api/bases/{baseId}/auto-refill` | Enable/disable auto-refill for a base | `baseId`, `enabled` |
| GET | `/api/bases/auto-refill/settings` | Get the threshold and scan interval for both auto-refill subsystems, with the source (`console`/`env`/`default`), reset value, and range of each | None |
| POST | `/api/bases/auto-refill/settings` | Save auto-refill thresholds/intervals. A number sets, `null` resets to the env/default layer, an omitted key is unchanged. Rate limited; requires `bases:write-config`, not `bases:mutate` | At least one of `thresholdPercent?`, `windtrapThresholdPercent?`, `waterThresholdPercent?` (1-99), `intervalHours?`, `waterIntervalHours?` (1-168). Whole numbers; `null` resets to the env/default layer, an omitted key is unchanged |
| GET | `/api/bases/{baseId}/water` | Get a base's water storage containers (count, volume, fill %; blood volume/fill for Blood Purifiers) | `baseId` |
| POST | `/api/bases/{baseId}/refill-water` | Refill all base water storage (queued instead if the map isn't safely writable right now). Water only -- blood is never touched | `baseId` |
| GET | `/api/bases/pending-water-refills` | List queued water refills, grouped by restart target | None |
| DELETE | `/api/bases/{baseId}/queued-water-refill` | Cancel a base's queued water refill | `baseId` |
| GET | `/api/bases/auto-refill-water` | Get per-base water auto-refill enrollment state | None |
| POST | `/api/bases/{baseId}/auto-refill-water` | Enable/disable water auto-refill for a base | `baseId`, `enabled` |
| GET | `/api/bases/{baseId}/inventory` | Get a base's stored items, rolled up by item template and by container (storage, refining, crafting, other). Merged per template, not per slot | `baseId` |
| GET | `/api/bases/{baseId}/containers/{placeableId}` | Get one container's inventories and their individual slots (item id, slot number, quantity, quality, durability, applied augments with their own per-augment quality), plus `deleteSafety` and `addSafety`. Answers `found: false` when that container is not at the base | `baseId`, `placeableId` |
| DELETE | `/api/bases/{baseId}/containers/{placeableId}/items/{itemId}` | Delete an item from a plain Storage container, or part of its stack with `count`. Refused unless the owning map is verifiably and safely stopped; Crafting and Refining contents are read-only. Requires `{ confirmation: "DELETE ITEM" }` | `baseId`, `placeableId`, `itemId`, `count?` |
| POST | `/api/bases/{baseId}/containers/{placeableId}/items` | Add a new item to a plain Storage container. Always creates a new row at the next free slot — never merges into an existing stack, and the slot cannot be chosen. Refused unless the owning map is verifiably and safely stopped; Crafting and Refining contents are read-only. Requires `{ confirmation: "ADD ITEM TO CONTAINER" }` | `baseId`, `placeableId`, `itemId`\|`itemName`, `quantity?` (1-1000000, default 1; clamped to the item's stack limit), `quality?` (0-5, default 0), `augments?`, `augmentQuality?`, `confirmation: "ADD ITEM TO CONTAINER"` |
| DELETE | `/api/bases/{baseId}/containers/{placeableId}/items` | Delete a chosen set of whole stacks from a plain Storage container. Does not need a stopped map | `baseId`, `placeableId`, `itemIds[]` (1-200 ids), `confirmation: "DELETE ITEMS"` |
| DELETE | `/api/bases/{baseId}/containers/{placeableId}/all-items` | Empty a plain Storage container (the item list is read inside the transaction) | `baseId`, `placeableId`, `confirmation: "DELETE ALL ITEMS"` |
| POST | `/api/bases/{baseId}/containers/{placeableId}/give-item` | Add one item to a plain Storage container. Catalog restricted to raw_resource, refined_resource and component items. Does not need a stopped map | `itemName`\|`itemId`, `quantity?` (1), `quality?`, `augments?`, `augmentQuality?`, `confirmation: "GIVE ITEM TO STORAGE"` |
| POST | `/api/bases/{baseId}/containers/{placeableId}/give-items` | Add 1-50 items in one transaction (same catalog restriction) | `items[]` (each as give-item), `confirmation: "GIVE ITEMS TO STORAGE"` |
| POST | `/api/bases/{baseId}/containers/{placeableId}/fill-item` | Fill a container with one item; `quantity: 0` fills to capacity. Clamped by free slots, volume and per-item stack size | same fields as give-item, `confirmation: "FILL ITEM TO STORAGE"` |
| GET | `/api/bases/{baseId}/land-claim` | A base's land claim: Sub-Fief segments, vertical level, `maxVerticalLevel`. 501 if the schema lacks the tables | `baseId` |
| PUT | `/api/bases/{baseId}/land-claim` | Expand a land claim (expansion only). Takes a full-database backup first (`backupCreated: true`). 409 for a queued delete or a backed-up base | `addSegments[]?` (`{x,y}` whole numbers within ±128, max 100, no duplicates, edge-connected, not 0,0), `verticalLevel?` (0-5, cannot be lowered; at least one of the two is required), `confirmation: "EDIT LAND CLAIM"` |
| GET | `/api/bases/{baseId}/permissions` | Get a base's permission roster (Owner, Co-Owners, Associates) | `baseId` |
| POST | `/api/bases/{baseId}/system-custodian` | Transfer ownership to the Server or detected GM system custodian while preserving the roster; provisions Server when no custodian exists | `baseId` |
| PUT | `/api/bases/{baseId}/permissions` | Replace a base's permission roster | `baseId`, `entries[]` (`playerId`, `rank`) |
| GET | `/api/bases/permission-candidates` | Search players eligible to be added to a roster | `q?`, `limit?` |
| GET | `/api/bases/{baseId}/child-access` | Every child piece (door, device) on a base plus its own root totem (`is_child=false`), each with its access level — a different 5-tier scale from the roster rank above; Sub-Fief is Associate (3) | `baseId` |
| POST | `/api/bases/{baseId}/child-access` | Set specific pieces to specific access levels (1-5); queued for the next map restart instead if the base's map is live (`result.queued`). Requires `{ updates: [{ actorId, accessLevel }], confirmation: "SET CHILD ACCESS" }` | `baseId`, `updates[]` (1-100 entries of `{ actorId, accessLevel }`, `accessLevel` 1-5), `confirmation: "SET CHILD ACCESS"` |
| GET | `/api/bases/pending-child-access` | List queued permission changes, grouped by restart target. Each entry carries its own `updates[]` payload | None |
| DELETE | `/api/bases/{baseId}/queued-child-access` | Discard a base's queued permission changes | `baseId` |
| DELETE | `/api/bases/{baseId}` | Permanently delete a base and everything on it (queued instead if the map isn't safely writable right now); takes a full-database safety backup first. Requires `{ confirmation: "DELETE BASE" }` | `baseId` |
| GET | `/api/bases/pending-deletes` | List queued base deletes, grouped by restart target | None |
| DELETE | `/api/bases/{baseId}/queued-delete` | Cancel a base's queued delete | `baseId` |
| GET | `/api/base-backups` | List the game's base backups (picked-up bases) optionally for one player; includes a `supported` flag, `missing[]` when schema support is incomplete, and `maps[]` (maps a backup can be moved to) | `playerId?` (player pawn id, to list one player's backups); returns 404 if playerId is not a player |
| GET | `/api/base-backups/{backupId}/export` | Download one base backup as a JSON file (attachment named `<owner>_<backup>_base-backup_<id>.json`; `bases:export-backup`; rate limited, audited) | `backupId`; 400 bad id, 404 unknown backup, 501 unsupported, 503 timeout |
| PUT | `/api/base-backups/{backupId}` | Reassign a picked-up base to another player, rename it and/or move it to another map (`bases:edit-backup`). The current owner must be offline | JSON `{ ownerPlayerId?, name?, map? }` (`ownerPlayerId` is a player pawn id; `name` 1-23 characters, not starting with `##`; `map` one of the list response's `maps`); 400 invalid_name / invalid_map / no_change, 404 backup or player not found, 409 owner_online or invalid_target, 501 unsupported, 503 timeout |
| DELETE | `/api/base-backups/{backupId}` | Permanently delete a picked-up base and everything stored in it (`bases:delete-backup`). Takes a full-database safety backup first; the current owner must be offline | JSON `{ confirmation: "DELETE BACKUP" }`; 400 confirmation_required, 404 not_found, 409 owner_online, 501 unsupported (no `dune.base_backup_delete`), 503 timeout |
| POST | `/api/base-backups/import` | Import a base backup file as a new backup for a player | Multipart form: `player_id` (pawn id), `file`, optional `allow_version_mismatch=1`; 400 invalid_file / invalid player_id / unsupported_version, 404 player not found, 409 version_mismatch or invalid_target (player has no controller), 501 unsupported, 503 timeout |

Base backups are the backups created when a player picks up a base with the
game's own tool. See [Base backups](base-backups.md#export-and-import) for
import/export details.

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
Sub-Fief console); generator fuel and windtrap filters belong to the refill route
above, and stored water belongs to the water route. Its `containers[].items[]` is merged per item template, not per
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
| POST | `/api/storage/{storageId}/give-item` | Add item to storage | `itemName`\|`itemId`, `quantity?` (1-1000000, default 1), `quality?`, `augments?`, `augmentQuality?`, `confirmation: "GIVE ITEM TO STORAGE"` |
| GET | `/api/storage/{storageId}/export` | Export storage as JSON | `storageId` |

---

## Vehicles

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/vehicles` | List all player vehicles (paginated), each with owner, shared-with roster, lowest-component condition %, fuel %, map/partition, coordinates, and per-component durability. `status` narrows the list: `owned` (has an owner or is in `Travel`, not put away), `recovery` (Stored for Recovery), `backup` (Vehicle Backup), `unowned` (no owner, not put away or in `Travel`), or `all` (default) | `q?`, `page?`, `pageSize?`, `sortColumn?`, `sortDirection?`, `status?` |
| GET | `/api/players/{playerId}/vehicles` | List the selected player's owned and shared vehicles using the same vehicle details. Accepts the same optional `?access=owner\|coowner` filter and 200-row cap | `playerId`, `access?` (`owner`\|`coowner`) |
| GET | `/api/vehicles/{vehicleId}/permissions` | Get a vehicle's permission roster (Owner, Co-Owners, Associates) plus the detected system custodian | `vehicleId` |
| PUT | `/api/vehicles/{vehicleId}/permissions` | Replace a vehicle's permission roster | `vehicleId`, `entries[]` (`playerId`, `rank`) |
| POST | `/api/vehicles/{vehicleId}/system-custodian` | Transfer ownership to the Server or detected GM system custodian while preserving the roster; provisions Server when no custodian exists | `vehicleId` |
| GET | `/api/vehicles/permission-candidates` | Search players eligible to be added to a vehicle roster | `q?`, `limit?` |
| GET | `/api/vehicles/{vehicleId}/storage` | Read a vehicle's cargo hold slot by slot (read-only): capacity, per-slot item, quantity, grade, durability and augments | `vehicleId` |
| DELETE | `/api/vehicles/{vehicleId}/storage/items/{itemId}` | Delete one stack from a vehicle's cargo hold, or part of it with `count`. Requires `{ confirmation: "DELETE ITEM" }` | `vehicleId`, `itemId`, `count?` |
| DELETE | `/api/vehicles/{vehicleId}/storage/items` | Delete a chosen set of whole stacks (max 200). Requires `{ confirmation: "DELETE ITEMS" }` | `vehicleId`, `itemIds[]` |
| DELETE | `/api/vehicles/{vehicleId}/storage/all-items` | Empty a vehicle's cargo hold. Requires `{ confirmation: "DELETE ALL ITEMS" }` | `vehicleId` |
| DELETE | `/api/vehicles/{vehicleId}` | Permanently delete a vehicle and everything on it (queued instead if the map isn't safely writable right now); takes a full-database safety backup first. Requires `{ confirmation: "DELETE VEHICLE" }` | `vehicleId` |
| DELETE | `/api/vehicles/{vehicleId}/stored` | Permanently delete a vehicle that is Stored for Recovery; refused for any other state and while its owner is online. Takes a full-database safety backup first. Requires `{ confirmation: "DELETE STORED VEHICLE" }` and both the `vehicles:delete` and `vehicles:stored-delete` actions | `vehicleId` |
| GET | `/api/vehicles/pending-deletes` | List queued vehicle deletes, grouped by restart target | None |
| DELETE | `/api/vehicles/{vehicleId}/queued-delete` | Cancel a vehicle's queued delete | `vehicleId` |

`GET /api/vehicles` and the player-scoped list are read-only; the permission
routes share their implementation with the base permission routes -- see
[vehicle-permissions.md](vehicle-permissions.md). The system-custodian route
mirrors the base one exactly, minus the backed-up guard: a vehicle's stored
states (`VehicleBackup`, `VehicleRecovery`) are actor lifecycle states rather
than an unclaimed base. The delete route mirrors `DELETE /api/bases/{baseId}`
and refuses those states and `Travel`; `DELETE /api/vehicles/{vehicleId}/stored`
is the separate, separately-permissioned delete for a `VehicleRecovery` vehicle --
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
always immediate rather than queued when the map is live.
`capabilities.vehicleStoredDelete` gates the Delete Stored Vehicle action; it
needs `vehicleDelete` plus `dune.actors.state`, `dune.recovered_vehicles`
(`vehicle_id`, `character_id`, `time_stored`, `reason`) and `dune.player_state`
(`id`, `account_id`, `character_name`, `online_status`). See
[vehicle-deletion.md](vehicle-deletion.md). Sortable `sortColumn` values: `id`, `name`,
`type`, `owner`, `condition_percent`, `fuel_percent`, `map`; `q` matches vehicle
name, type, owner, map, and exact id. Response fields mirror the paginated-list
convention (`rows`, `totalCount`, unfiltered `totalVehicles`). Owner resolves from
the rank-1 permission holder, falling back to the actor's account owner and then,
for a stored vehicle, to the character on its `dune.recovered_vehicles` or
`dune.backup_vehicles` record (the game clears the roster when it stores one). Each
row carries `lifecycle_state`; a `VehicleRecovery` row also carries `stored_at` and
`stored_reason` (`Normal`, `Migrated`, `RecoveredFromLostState`), which are null
otherwise. The
`shared_with` roster is the rank 2/3 holders. A component's maximum durability uses
a verified game-data override when one is available, then its own stats blob
(`MaxDurability`, else the decayed cap). If no known or stored maximum exists, it
is inferred only when at least two non-null current-durability observations exist
for the same template; inferred rows set `maxInferred: true`.
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
sector grid as the `sector` field, derived from each row's coordinates.
`partition_id` remains null when Funcom has not deployed the vehicle into a
current world partition; it is never rewritten as the nonexistent partition 0.
When available, `lifecycle_state` explains these records (`Travel`,
`VehicleBackup`, or `VehicleRecovery`) so clients can label them as in transit
or stored rather than spawned.

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
| POST | `/api/exchange/config` | Save the bot/blacklist filter config (audited, rate-limited) | body: `includeNpcBroker?` (default true), `botOwnerIds?[]`, `blacklistedOwnerIds?[]` (numeric id strings, max 1000 each; an omitted list is saved as empty) |

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
| POST | `/api/exchange/market/buyback/schedule` | Save the buyback schedule (audited, rate-limited) | body (all optional, merged over the saved schedule; may be wrapped as `{ schedule: {...} }`): `enabled?`, `intervalMinutes?` (10-1440, default 30), `exchangeId?` (required before `enabled: true`), `priceMultiplier?` (integer 1-100, default 5), `augmentMultiplier?`, `rankedArmorMultiplier?`, `rankedWeaponMultiplier?` (1-5), `buybackPercent?` (integer 1-500, default 60), `buybackPriceBasis?` (`seeded`\|`average`\|`lowest`, default `seeded`), `maxBuys?` (integer 1-5000, default 500) |
| POST | `/api/exchange/market/seed/schedule` | Save the market reseed schedule (audited, rate-limited) | body (all optional, merged over the saved schedule; may be wrapped as `{ schedule: {...} }`): `enabled?`, `intervalMinutes?` (10-1440, default 15), `exchangeId?` (required before `enabled: true`), `priceMultiplier?` (integer 1-100, default 5), `augmentMultiplier?`, `rankedArmorMultiplier?`, `rankedWeaponMultiplier?` (1-5), `augmentPricing?` (`discounted`\|`original`, default `discounted`), `commodityStacks?` (object of templateId → integer 1-20 for allowlisted commodities; unknown ids ignored) |
| POST | `/api/exchange/market/buyback/run` | Run a buyback sweep now with the saved schedule (probe → backup → sweep) | None |
| POST | `/api/exchange/market/seed/run` | Run a market reseed now with the saved schedule (backup → clear bot listings → seed) | None |
| POST | `/api/exchange/market/seed/clear` | Remove the bot's NPC listings from one exchange without reseeding (probe → backup → clear; no backup when the bot has none). Player listings and pending seller payments are never touched. Requires `exchange:market-write`. Rate-limited. | body: `exchangeId?` (defaults to the saved seed schedule's exchange) |
| POST | `/api/exchange/market/settings` | Save bot-wide Market Bot settings. `safetyBackups: false` skips the pre-write backup for buyback, reseed, and clear runs (scheduled and manual) and requires `confirmation: "DISABLE MARKET BOT BACKUPS"`; re-enabling needs no phrase. Current settings are returned as `settings` by `GET /api/exchange/market`. Requires `exchange:market-write`. Audited, rate-limited. | body: `safetyBackups?` (boolean; omitted keeps the current value), `confirmation?` (`DISABLE MARKET BOT BACKUPS`, required only when turning backups off) |
| GET | `/api/exchange/market/plans/csv` | Download the selected (or active) seed plan as CSV | query: `planId?` |
| POST | `/api/exchange/market/plans/csv` | Upload a UTF-8 CSV as the current seeding list: creates or replaces a named custom plan and makes it active. Only the documented seed-plan columns (names and numbers) are accepted; extra columns, SQL/JSON/HTML, formulas, and non-numeric cells are rejected. The bundled plan is never overwritten. Requires `exchange:market-write`. Rate-limited. | multipart: `file` (`.csv`), `name?` (friendly name; required when creating a plan), `planId?` (existing custom plan to replace) |
| POST | `/api/exchange/market/plans/active` | Set the active seed plan used by reseed and buyback | body: `planId` (`bundled` or a custom plan id) |
| POST | `/api/exchange/market/plans/name` | Rename a custom seed plan | body: `planId`, `name` |
| GET | `/api/exchange/market/items` | Merged, display-ready bot item catalog (bundled plan rows + admin-added new items), annotated with `overridden`/`isNew`/`unsafe` per row | None |
| GET | `/api/exchange/market/items/catalog` | Item picker for "add item": `admin-items.json` filtered to allowed categories and unsafe-id-free | query: `q?`, `category?` |
| POST | `/api/exchange/market/items` | Save per-item overrides/new items/removals in one batch (audited, rate-limited). Requires `exchange:market-write`. | body: `overrides?` (object of templateId → qualityLevel `0`-`5` → `{enabled?, price? (1-999999999), listings? (integer 1-99)}`; an empty patch removes the override), `newItems?` (object of templateId → `{name?, price (1-999999999), listings (integer 1-99), enabled?, qualityLevel? (0-5), stackSize?}`; ids already in the bundled plan are rejected), `removedNewItems?` (array of templateId) |

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
native Market Bot engine (`addonJobs.js` / `addonSeedJob.js`). Reads and the probe
require `exchange:market`; the dry-run log refresh, schedule saves, run-now, and
log clear require `exchange:market-write` (the admin tier's `exchange:*` covers both).
Schedules saved here are marked `source: "console"`, run unattended inside the
console API process, and do not require an addon; the seed plan is the **active**
named plan (the bundled `runtime/data/market-seed-plan.json` until the operator
imports a CSV-backed list and sets it active). `buybackPercent` is an integer
from 1 to 500. Every write is preceded by a database
backup unless Safety Backups are turned off (`POST /api/exchange/market/settings`), and buyback runs probe eligibility read-only first so idle intervals
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
| GET | `/api/blueprints/community` | Browse the public community Blueprint catalog (502 if unreachable) | `q?` (max 100 characters), `set?` (max 60 characters), `sort?` (`newest`\|`popular`\|`downloads`, default `newest`), `limit?` (1-60, default 20), `offset?` (0-1000000, default 0) |
| GET | `/api/blueprints/community/{id}/preview` | Preview image for one community Blueprint (cached 5 minutes) | `id` |
| POST | `/api/blueprints/community/{id}/install` | Install a community Blueprint for a player (writes the Solido item and Blueprint rows; needs `blueprints:import`) | `id`, `playerId` (player pawn id) |

See [blueprints.md](blueprints.md) for the full import/export design.

---

## Maps & World

### Map Management

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/maps` | List all maps | `raw?` (`0` omits legacy command output) |
| GET | `/api/map/status` | Get structured status of all maps | `raw?` (`0` omits legacy command output) |
| GET | `/api/maps/mode` | Get map mode (static/dynamic) | `map?` (query param) |
| POST | `/api/maps/mode` | Set map mode | `map`, `mode` (`dynamic`\|`always-on`\|`overmap-active`\|`disabled`), `confirmation: "SET MAP MODE"` |
| POST | `/api/maps/settings` | Save map settings | `map`, `partitionId?`, `mode?` (as `/api/maps/mode`; used when `modeChanged`), `memory?` (e.g. `12G`; used when `memoryChanged`), `modeChanged?`, `memoryChanged?` (at least one must be true, else 400), `confirmation: "SAVE MAP SETTINGS"` |
| GET | `/api/maps/runtime-settings` | Get runtime configuration | None |
| POST | `/api/maps/runtime-settings` | Save runtime configuration. 400 unless `hostMemoryProtectionEnabled` is a boolean | `alwaysOnStartupParallelism`, `hostMemoryProtectionEnabled` (required boolean), `hostMemoryReserveGiB?` (whole GB below physical RAM; `null` or empty for Automatic) |
| POST | `/api/maps/reconcile` | Reconcile map state | `confirmation: "RECONCILE MAPS"` |
| POST | `/api/maps/spawn` | Spawn map server | `target`, `confirmation: "SPAWN MAP"` |
| POST | `/api/maps/despawn` | Despawn map server | `target`, `confirmation: "DESPAWN MAP"` |
| POST | `/api/maps/respawn` | Restart a map with no managed service (despawn then respawn its partition) | `target`, `confirmation: "RESTART MAP"` |

### Structured Map Status

`GET /api/map/status` returns `schemaVersion`, `ok`, and a `data` object with these integration-ready fields:

- `data.maps`: map configuration rows with `map`, `mode`, numeric `partitions`, and numeric `assigned` values.
- `data.partitions`: partition rows with numeric IDs and ports, nullable booleans for `ready` and `alive`, and a derived `status`.
- `data.readiness`: overall readiness plus a `checks` array of `{ section, status, label }` objects.
- `data.autoscaler`: the Autoscaler state, container name, and container status.

The existing `maps`, `services`, `readiness`, and `autoscaler` command result objects remain available for backward compatibility. Each contains its raw `stdout`, `stderr`, and `exitCode`; new integrations should consume `data` instead and use `?raw=0` for a smaller response. `GET /api/maps` follows the same contract: typed map rows are available under `data.maps`, while its legacy command fields remain present unless `?raw=0` is supplied.

### Memory Management

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/maps/memory` | Get memory status | None |
| POST | `/api/maps/memory` | Set/unset map memory | `map` or `partitionId`, `memory` (number + `M`/`G`, e.g. `12G`; not used for unset), `action?` (`unset`; anything else sets), `confirmation` (`SET MAP MEMORY`, or `UNSET MAP MEMORY` for unset) |
| GET | `/api/maps/memory/balancer` | Get memory balancer state | None |
| POST | `/api/maps/memory/balancer` | Enable/disable memory balancer | `enabled` |
| GET | `/api/maps/memory/swap` | Get memory swap status | None |
| POST | `/api/maps/memory/swap` | Enable/disable memory swap | `enabled` (only `true` enables), `perServerGiB?` (integer 1-16, default 2), `poolGiB` (integer 0-32; required when enabling), `swappiness?` (integer 0-100, default 10), `confirmation` (`ENABLE MEMORY SWAP`, or `DISABLE MEMORY SWAP` when disabling) |
| GET | `/api/maps/memory/live` | Get live per-map RAM usage and, when enabled/supported, current swap usage and allowance | None |

### Autoscaler

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/maps/autoscaler` | Get autoscaler status | None |
| POST | `/api/maps/autoscaler` | Autoscaler action | `action` (`status`\|`start`\|`stop`\|`restart`\|`logs`), `confirmation: "AUTOSCALER CHANGE"` |

### Spicefields & Trade

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/maps/spicefields` | List spicefields | None |
| PATCH | `/api/maps/spicefields/{typeId}` | Update spicefield config | `typeId` (path, positive integer); at least one of `max_globally_active?`, `max_globally_primed?` (integers 0-10000), `is_spawning_active?` (boolean), `global_spawn_weight?` (number 0-100000) |
| GET | `/api/maps/choam-terminals` | Get CHOAM terminal overview | None |
| POST | `/api/maps/choam-terminals` | Install CHOAM terminals | `tradeCenterKey` |
| DELETE | `/api/maps/choam-terminals` | Remove CHOAM terminals | `tradeCenterKey` |
| GET | `/api/maps/choam-terminals/capture` | Preview where a terminal would sit if placed at a character's position (saves nothing). Polled — see below | `tradeCenterKey`, `playerId`, and on follow-up polls `afterSerial`, `afterX`, `afterY`, `afterZ`, `afterYaw` (query params) |
| POST | `/api/maps/choam-terminals/position` | Save a custom terminal position for a trade post | `tradeCenterKey`, `x`, `y`, `z`, `yaw`, `sourcePlayerId?`, `applyNow?` |
| DELETE | `/api/maps/choam-terminals/position` | Clear a custom position and fall back to the shipped default | `tradeCenterKey` |

A custom position is bounded to its trade post: `CHOAM_POSITION_RADIUS_UU` (default 5000 uu / 50 m)
horizontally and `CHOAM_POSITION_VERTICAL_UU` (default 2000 uu) vertically, measured from the
shipped default rather than from any previously saved override. Saving only changes what the next
install writes — an already-installed terminal must be removed and reinstalled to move.

`capture` derives the placement from a standing character: the terminal root sits 15 uu below the
character's `z` (the Blueprint's mesh-component offset; a pawn's stored `z` is at ground level),
and the terminal's yaw is the character's facing minus 90° (the console mesh fronts on local +Y
while a pawn faces local +X). It requires `players:read`, not `maps:read`, because it returns a
live player position.

**`capture` is polled, not awaited.** `dune.actors` lags live movement, and repeated reads inside
that lag return identical *stale* values — so a position that has stopped changing is not
necessarily current. Freshness is established from `dune.actors.serial`, a periodic row heartbeat
(~60 s) that rewrites the row with the live position even when the character has not moved. The
first call returns `{ ready: false, serial }`; the client passes that `serial` and position back as
`afterSerial`/`afterX`/`afterY`/`afterZ`/`afterYaw` and keeps polling. Once `serial` advances the
row is current by construction: if the position it wrote matches the baseline the response is
`ready` (the character held still across the write), otherwise `state: "moving"` and the caller
re-baselines. Expect up to ~2 minutes.

`applyNow: true` on a save also moves any already-installed terminals for that post, removing and
reinstalling them **in a single transaction** so a failed install cannot leave the post with no
terminal. Without it the save only changes what the next install writes, and the response carries
`reinstallRequired: true`. A restart of that terminal's map is still required for either to appear in-game.

### Combat & User Settings

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/maps/combat-state` | Get combat state by partition | `map` (query param) |
| GET | `/api/maps/user-settings/schema` | Get user settings schema | None |
| GET | `/api/maps/user-settings/restart-pending` | Check if a Landsraad-field restart is pending | None |
| GET | `/api/maps/user-settings/deferred-pending` | Check if a "Restart later" deferred save is pending (any UserEngine/UserGame save) | None |
| GET | `/api/maps/user-settings/values` | Get settings values | `scope?` (default `global`; `engine`\|`mapEngine`\|`partitionEngine`\|`global`\|`map`\|`partition`\|`serverCustomGlobal`\|`serverCustomMap`\|`serverCustomPartition`), `map?` (default `Survival_1`), `partitionId?` (for partition scopes) |
| GET | `/api/maps/user-settings/raw` | Get raw settings file | `kind?` (default `engine`; `engine`\|`profile`\|`client-game`\|`client-engine`; any other value reads UserGame), `map?` (default `Survival_1`), `partitionId?` |
| POST | `/api/maps/user-settings/save` | Save user settings | `scope?` (default `map`, also used for unknown values; the values listed for `/values`, plus `profile`), `map?` (default `Survival_1`), `partitionId?`, `values?` (object), `restart?` (`false` skips the restart), `deferRestart?` (`true` defers it) |
| POST | `/api/maps/user-settings/reset` | Reset to defaults | `scope?` (as save), `map?` (default `Survival_1`), `partitionId?`, `confirmation: "RESTORE MAP DEFAULTS"`, `deferRestart?` |
| POST | `/api/maps/user-settings/raw` | Save raw settings | `scope?` (default `map`; `profile` and `engine` select those files, anything else writes UserGame), `map?`, `partitionId?`, `content` (string), `deferRestart?` |
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
| GET | `/api/sietches/dimensions` | Get sietch dimensions | `map?` (default `Survival_1`), `ids?` (`1` returns ids only) |
| POST | `/api/sietches/update` | Update sietch config | `action` plus its fields. `set-max`, `set-active`: `map`, `count` (1-64). `set-display`: `partitionId`, `displayName`. `set-password`: `partitionId`, `password?`. `set-settings`: `partitionId`, `displayName`, `password?`. `restart`: `partitionId`. `reconcile`: `map`. `sync`, `validate`: nothing. `confirmation`: `UPDATE SIETCHES` for `set-active`, `set-display`, `set-password`, `set-settings` and `reconcile`; `RESTART SIETCH` for `restart`; none otherwise |
| GET | `/api/deepdesert` | Get Deep Desert status | None |
| POST | `/api/deepdesert/update` | Update Deep Desert | `action` (`enable`\|`disable`\|`bootstrap`\|`repair`; required unless `instances` is sent), `instances?` (integer 1-3; when sent `action` is ignored), `thirdRole?` (`pve`\|`pvp`, default `pve`; used with `instances`), `confirmation: "UPDATE DEEP DESERT"` |

---

## Live Map

See [live-map.md](live-map.md) for how the panel uses these endpoints --
partition display-name resolution, the spice/POI data model, the
Layers legend's default-settings mechanism, and what `coriolisLayout`
drives: the WebGL renderer that draws the Deep Desert's own cartography
meshes, and the conditions under which it falls back to the flat image.

Coordinate-bearing Deep Desert marker rows include a `sector` field such as
`"F6"`. It is `null` when a coordinate lies outside the A1–I9 grid. This applies
to the combined marker response and the dedicated player, base, storage, spice,
and POI responses, so announcement tools and bots do not need to duplicate the
coordinate conversion.

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/map/capabilities` | Get map feature capabilities | None |
| GET | `/api/map/markers` | Get map markers & configuration (actors, merged with spice/POI rows; response also includes `coriolisSeed`, `coriolisNextCycleAt`, `coriolisSeedStaleSince`, and `coriolisLayout`) | `map?`, `partitionId?`, `static?` (`0` omits static archive/POI rows for lightweight live refreshes) |
| GET | `/api/map/spice` | Get spice/flour-sand layers (static pool, active blows, flour sand) for a map/partition | `map?`, `partitionId?` (query params) |
| GET | `/api/map/poi` | Get registry-driven POI layers (ore, scrap, flora, poi, house_representative, trainer, fortress, hazard, enemy) for a map | `map?` (query param) |
| POST | `/api/map/teleport-player` | Teleport a player to coordinates in the player's current ready partition; this never starts a dynamic map or crosses partitions | `playerId`, `x`, `y`, `z?` (default 5000), `yaw?` (default 0), `partitionId?` (omitted or 0 = player's current partition), `online?` (`true` = live teleport, otherwise offline path) |
| GET | `/api/map/partitions` | List live-map partitions, including `alive` and `ready` runtime state for stopped dynamic maps | None |
| GET | `/api/map/players` | Get player positions | `map?` (query param) |
| GET | `/api/map/bases` | Get base locations | `map?` (query param) |
| GET | `/api/map/storage` | Get storage locations | `map?` (query param) |
| GET | `/api/map/services` | Get service locations | `map?` (query param) |
| GET | `/api/map/overlays` | Live-map marker rows for a map (the raw rows, without the spice/POI merge that `/api/map/markers` adds) | `map?` (query param) |

---

## Realtime Data

Live sandworms, vehicles, NPCs, civilians, storms and Coriolis state from the optional MapViewer3D position agent (see [realtime.md](realtime.md)). All three routes need `realtime:read`; player objects are included only when the caller also holds `players:read`.

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/realtime/healthz` | Position-agent health. 503 `{ available: false }` when the agent is not running | None |
| GET | `/api/realtime/objects` | Snapshot of live objects (plus players with `players:read`) | None |
| GET | `/api/realtime/stream` | Server-sent events (`snap`, `pos`), re-authorised every 10 seconds. 429 beyond 4 open streams per principal or 16 in total | None |

---

## Database

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/database/status` | Database status | None |
| GET | `/api/database/schemas` | List database schemas | None |
| GET | `/api/database/routines` | List functions and procedures in a schema (at most 500) | `schema?` (default: "dune"), `q?` |
| GET | `/api/database/routines/{oid}` | Source definition of one routine | `oid` (numeric routine OID) |
| GET | `/api/database/tables` | List tables in schema | `schema?` (default: "dune"), `approximate?` (`1` returns estimated row counts) |
| GET | `/api/database/tables/{schema}/{table}/columns` | Get column information | `schema`, `table` |
| GET | `/api/database/tables/{schema}/{table}/preview` | Preview table data | `schema`, `table`, `limit?` (1-10000, default 50), `offset?`, `filter?` (query: JSON filter tree, max 20 terms) |
| GET | `/api/database/tables/{schema}/{table}/count` | Get row count | `schema`, `table`, `filter?` (query: JSON filter tree, max 20 terms) |
| PATCH | `/api/database/tables/{schema}/{table}/row` | Update table row | `rowId` (`__rowid` from the preview), `values` (object) |
| GET | `/api/database/search` | Search database | `q` or `term` (query param) |
| POST | `/api/database/query` | Execute SQL query | `query` (read or write) — see note below |
| POST | `/api/database/export` | Export query results | `query` (read-only SELECT/WITH/SHOW/EXPLAIN) |
| POST | `/api/database/password` | Change the database password and restart all services (202 with a task). 400 while `ADMIN_DATABASE_URL` is set | `password` (4-256 characters) |
| GET | `/api/database/table/{schema.table}` | Preview table | `schema.table` (one path segment), `limit?`, `offset?` |

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

Character transfer settings are persisted and applied through Director's live settings API without restarting services. POST returns `200` with `applied: true` after verifying the effective settings; it does not create a restart task. If persistence succeeds but live application cannot be confirmed, POST returns `503` explaining that the settings remain saved and can be retried. GET includes `applied` (`true` when confirmed, `false` when settings differ, or `null` when Director cannot be checked).

### Landsraad

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/admin/landsraad` | Get Landsraad overview | None |
| GET | `/api/admin/landsraad/milestone-preset` | Get milestone preset | None |
| POST | `/api/admin/landsraad/milestone-preset` | Save milestone preset | `enabled`, `goalAmount`, `thresholds[]` |
| POST | `/api/admin/landsraad/task-goal` | Update task goal | `taskId`, `goalAmount` |
| POST | `/api/admin/landsraad/term-task-goals` | Update term task goals | `termId`, `goalAmount` |
| POST | `/api/admin/landsraad/reward-tier` | Update reward tier | `rowLocator` (`(page,tuple)` text from the overview), `taskId`, `threshold`, `newThreshold?` (defaults to `threshold`), `templateId` (1-256 characters), `amount` |
| POST | `/api/admin/landsraad/player-contribution` | Set player contribution | `playerId`, `taskId`, `amount` |

### Broadcasts & Messages

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| POST | `/api/admin/broadcast` | Broadcast message to all | `body` or `message` (1-500 characters), `title?` (max 80, default `Admin Broadcast`), `durationSec?` (1-3600, default 30), `texts?[]` (1-10 entries of `Key`, `Title`, `Body`; replaces `title` and `body`) |
| POST | `/api/admin/map-chat` | Send map chat message | `body` or `message` (1-500 characters), `mapName?` or `region?` (default `HaggaBasin`), `dimension?` (0-9999, default 0) |
| POST | `/api/admin/broadcast-shutdown` | Broadcast shutdown notice | `confirmation: "SHUTDOWN BROADCAST"`, `shutdownType?` (`Restart` default, `Maintenance` or `Update`), `delayMinutes?` (0-1440, default 15), `frequency?` (1-3600, default 60), `duration?` (1-3600, default 30), `cancel?` (boolean) |
| GET | `/api/admin/map-chat-schedules` | List scheduled map chat messages | None |
| POST | `/api/admin/map-chat-schedules` | Save, delete or run a scheduled map message (400 on any other `action`) | `action` (`save` default, `delete` or `run`; else 400). Save, flat or under `schedule`: `id?` (omit to create; max 100 schedules), `name?` (max 80), `enabled?` (default true), `mapName?` (default `HaggaBasin`; `AllMaps` targets every map with players), `dimension?` (0-9999, default 0), `message` (1-500; required when creating), `frequency?` (`daily` default or `weekly`), `daysOfWeek?` (integers 0-6, 0 = Sunday; required for weekly), `time?` (`HH:MM`, default `09:00`), `timezone?` (IANA name, default `UTC`). Delete and run: `id` |

---

## Care Package System

Automatic scans return skipped-player results without adding routine skips to grant history. When history reaches 8 MiB, background maintenance compacts it to the latest 500 non-skip records within a 4 MiB budget. Existing oversized files are streamed rather than loaded into memory in full. Older display records are removed, not rotated into additional archives.

Successful and partially delivered grants are preserved as compact eligibility receipts independently of display history. These receipts and first-online claims are included in self-update backups; history cleanup does not reset eligibility or authorize duplicate rewards.

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/care-package/capabilities` | Get care package capabilities | None |
| GET | `/api/care-package/config` | Get care package configuration | None |
| POST | `/api/care-package/config` | Save care package config | Config object + `confirmation: "SAVE CARE PACKAGE"` |
| GET | `/api/care-package/grants` | Get grant history | `limit?` |
| GET | `/api/care-package/history` | Get grant history (alias) | `limit?` |
| POST | `/api/care-package/history/clear` | Clear grant history | `confirmation: "CLEAR GRANT HISTORY"` |
| GET | `/api/care-package/eligible` | Get eligible players | `ruleId?`, `onlyEligible?` (`1` returns only eligible players) |
| POST | `/api/care-package/grant-eligible` | Grant to eligible players | `confirmation: "GRANT CARE PACKAGE TO ELIGIBLE PLAYERS"` |
| POST | `/api/care-package/run` | Run care package scan | `confirmation: "RUN CARE PACKAGE SCAN"` |
| POST | `/api/care-package/grant/{playerId}` | Grant to specific player | `playerId`, `confirmation: "GRANT CARE PACKAGE"`, `kitId?` (defaults to the active kit), `source?` (default `manual`; other values default to the auto-grant kit) |
| POST | `/api/care-package/retry/{grantId}` | Retry failed grant | `grantId`, `confirmation: "RETRY CARE PACKAGE"` |
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

### Player Identity Bridge

`players.identity.list` requires an approved `players:read` addon permission. It returns the minimal player identity data needed to correlate addon events: `name`, `actorId`, `controllerId`, `accountId`, `funcomId`, `flsId`, `platformId`, `platformName`, `status`, and `map`. Addons do not need direct access to the Console player REST endpoints.

### Addon Runtime Bridge

`players.summary.list` and `players.progression.get` provide typed player and
supported progression data under `players:read`. `addon.storage.*` provides
versioned addon-scoped JSON storage under `files:addon-data`.
`rewards.deliver`, `rewards.status`, and `rewards.list` provide persistent,
idempotent reward delivery under `rewards:grant`. `players.message.*` provides
queued private messages under `players:message`. See
[Addon Runtime API](../addons/addon-runtime-api.md) for payloads and delivery
semantics.

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
| POST | `/api/settings/server-startup` | Choose whether the Battlegroup starts automatically when the Console boots | `autoStartBattlegroup` (boolean) |
| GET | `/api/settings/experimental-tanks` | Experimental Tanks state, plus `queuedEntryId` and `queuedEnabled` when a change is queued behind the restart queue | None |
| POST | `/api/settings/experimental-tanks` | Enable or disable Experimental Tanks (restarts Hagga) as a task | `enabled` (boolean), `confirmRestart: true` |
| GET | `/api/settings/encrypted-api` | Encrypted API access state (`available`, `enabled`, `running`, `state`, `health`, `port`, `fingerprint`); no secret. See [encrypted-api.md](encrypted-api.md) | None |
| POST | `/api/settings/encrypted-api` | Turn the HTTPS front door on or off. Helper-script failures return 502. Audited | `enabled` (boolean) |
| POST | `/api/settings/console-access/confirm` | Confirm a pending `ADMIN_ALLOWED_IPS` review. 409 if the list would block the caller or the review is stale | `confirmed: true`, `fingerprint` |

---

## Localization (i18n)

`settings:write` is the owner tier only under the default policy. The two read routes are public, and the `mesh` routes authenticate with signed headers from an enrolled peer instead of a session.

| Method | Route | Description | Parameters |
|--------|-------|-------------|------------|
| GET | `/api/i18n/languages` | Language catalog and status. **Public: no session or key** | None |
| GET | `/api/i18n/translations` | Reviewed UI-phrase translations for one language. **Public** | `lang?` (default `EN`; 400 if unsupported) |
| POST | `/api/i18n/translate` | Translate and cache reviewed UI phrases (400 with `rejectedUnreviewedCount` for any phrase that is not reviewed). `settings:write` | `lang?` (default `EN`; 400 if unsupported), `texts[]` (first 250 are used) |
| POST | `/api/i18n/key` | Store the DeepL API key encrypted at rest. `settings:write` | `apiKey` (10-256 characters) |
| DELETE | `/api/i18n/key` | Remove the stored DeepL key. `settings:write` | None |
| POST | `/api/i18n/settings` | Save peer-sync mesh settings. `settings:write` | `peerSyncEnabled?`, `peers?[]`, `replacePeers?`, `meshEnrollmentKey?`, `generateMeshEnrollmentKey?`, `triggerPeerSync?` |
| POST | `/api/i18n/sync-all` | Pull peer packs, then translate every database language. `settings:write` | `languages?[]` |
| POST | `/api/i18n/suggestions` | Submit a community translation correction (`community:suggest-translation`, available to every tier; 201 receipt, 502 on delivery failure) | `lang`, `source`, `translation` (max 1800 characters), `credit?` (max 60) |
| GET | `/api/i18n/mesh/manifest` | Peer-mesh manifest as an encrypted envelope. 403 when peer sync is disabled or the headers do not verify | None |
| GET | `/api/i18n/mesh/pack` | Peer-mesh language pack (same authentication) | `lang` (query; any supported language except `EN`) |
| POST | `/api/i18n/mesh/push` | Peer-mesh pack push (same authentication) | `envelope` |

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

A key omitting `scopes` is created with no access at all. Unrecognised namespaces, unrecognised levels, and the permanently denied `settings`, `database`, `setup` and `community` namespaces are dropped rather than coerced — nothing falls back to `"read"`. A `"write"` level on `updates` or `addons`, whose writes are denied to keys, is stored as `"read"`.

Invalid input to the create and update routes — a blank or over-long name, or an expiry that is not a future date string — returns `400` with the reason.

Requests authenticated by a key return `401` when the credential is invalid, disabled or expired, `403` when the key's scopes do not cover the route's action, and `429` with a `retry-after` header when the key exceeds its per-minute limit (or, for failed credentials, when a client address exceeds 30 rejected attempts a minute). A request carrying no `Authorization` header is unaffected and uses the browser session as before.

---

## Discord Adapter (Experimental)

All Discord adapter endpoints require the adapter bearer token (`DUNE_DISCORD_ADAPTER_TOKEN`). The adapter is disabled by default (404 `adapter_disabled`); enable with `DUNE_DISCORD_ADAPTER_ENABLED=true`.

Only `health`, `catalog`, `version` and `backups/list` are `GET`, and they need the bearer token alone. Every other route is `POST` with an `actor` object in the JSON body (`guildId`, `channelId`, `userId`, `username`, `roleIds`, optional `interactionId` and `commandName`). The actor's role tier decides which capability the route may use. The Capability column lists the capability each route checks. Discord role tiers map to capabilities in `integrations/discord/policy.js`.

See [../integrations/discord-integration/README.md](../integrations/discord-integration/README.md) for setup and configuration, or [../integrations/discord-control-bot/api-adapter-contract.md](../integrations/discord-control-bot/api-adapter-contract.md) for the full adapter contract.

### Health & Status

| Method | Route | Description | Capability |
|--------|-------|-------------|-----------|
| GET | `/api/integrations/discord/health` | Adapter health, live and planned route lists, role-policy configuration and `protocolVersion` | None (bearer token only) |
| GET | `/api/integrations/discord/version` | Console version | None (bearer token only) |
| GET | `/api/integrations/discord/catalog` | Command catalog (names, descriptions, capabilities and minimum tiers for every live route, machine-readable). Read-only metadata about route shape, not game or player data (see `commandCatalog.js`) | None (bearer token only) |
| POST | `/api/integrations/discord/status` | Server status | `status:read` (`logs:read` when the body sends `diagnostic: true`) |
| POST | `/api/integrations/discord/readiness` | Service readiness | `readiness:read` |
| POST | `/api/integrations/discord/services` | Services list | `services:read` |
| POST | `/api/integrations/discord/population` | Aggregate player population (no per-player detail) | `population:read` |
| POST | `/api/integrations/discord/servers` | Server list (`dune servers` output) | `services:read` |
| POST | `/api/integrations/discord/ports` | Port list (`dune ports` output) | `services:read` |
| POST | `/api/integrations/discord/db` | Database status (runs the `dbStatus` command; it does not accept a query) | `services:read` |

### Logs & Monitoring

| Method | Route | Description | Capability |
|--------|-------|-------------|-----------|
| POST | `/api/integrations/discord/logs` | Last 50 sanitized log lines for one service (`service` in the body) | `logs:read` |
| POST | `/api/integrations/discord/ops/activity` | Ops activity | `ops:activity:read` |
| POST | `/api/integrations/discord/ops/combat` | Ops combat stats | `ops:combat:read` |
| POST | `/api/integrations/discord/ops/resources` | Ops resources | `ops:resources:read` |
| POST | `/api/integrations/discord/ops/economy` | Ops economy | `ops:economy:read` |
| POST | `/api/integrations/discord/ops/inventory` | Ops inventory | `ops:inventory:read` |
| POST | `/api/integrations/discord/ops/soc` | Ops SOC summary | `ops:soc:read` |
| POST | `/api/integrations/discord/ops/prometheus` | Ops Prometheus metrics | `ops:prometheus:read` |

Ops responses are bounded by `DUNE_OPS_QUERY_TIMEOUT_MS` (default 5000) and `DUNE_OPS_MAX_RESPONSE_BYTES` (default 65536). `ops/location` and `ops/dashboard` are declared but planned: they answer 404.

### World State

| Method | Route | Description | Capability |
|--------|-------|-------------|-----------|
| POST | `/api/integrations/discord/map-state` | Map list | `maps:read` |
| POST | `/api/integrations/discord/maintenance` | Runs the readiness check (it does not change maintenance mode) | `readiness:read` |
| GET | `/api/integrations/discord/backups/list` | Backup list (metadata only, at most 100 rows) | None (bearer token only) |
| POST | `/api/integrations/discord/broadcast` | Send an in-game broadcast (`message`, truncated to 200 characters). 403 `writes_disabled` unless `DUNE_DISCORD_WRITES_ENABLED` is true; the stock `docker-compose.web.yml` does not forward that variable | `broadcast:send` |
| POST | `/api/integrations/discord/announcements` | Read the player-announcement settings | `maps:read` |

### Inventory & Players

| Method | Route | Description | Capability |
|--------|-------|-------------|------------|
| POST | `/api/integrations/discord/players/link` | Link Discord to player | `player-link:write` |
| POST | `/api/integrations/discord/players/link/verify` | Verify player link | `player-link:write` |
| POST | `/api/integrations/discord/players/unlink` | Unlink Discord from player | `player-link:write` |
| POST | `/api/integrations/discord/players/me` | Get the linked player | `inventory:read` |
| POST | `/api/integrations/discord/players/inventory` | Get the linked player's inventory | `inventory:read` |
| POST | `/api/integrations/discord/players/storage` | Get the linked player's storage | `storage:read` |
| POST | `/api/integrations/discord/players/find` | Search items across the linked player's holdings | `inventory:read` |
| POST | `/api/integrations/discord/players/inventory-search` | Search inventory | `inventory:read` |

### Guilds

| Method | Route | Description | Capability |
|--------|-------|-------------|------------|
| POST | `/api/integrations/discord/guilds/storage` | Get guild storage | `guild:read` |
| POST | `/api/integrations/discord/guilds/find` | Search items across the linked player's guild | `guild:read` |

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
- Write SQL (anything that needs `database:execute`) takes a full-database safety backup (origin `destructive-sql`) before it runs. The query response carries no `backupCreated` field.

### Authentication
- All endpoints except `/api/health`, `/api/auth/login`, and `/api/auth/state` require:
  - Session cookie: `asc_session`
  - CSRF token header: `x-csrf-token`
- Obtain CSRF token from `GET /api/auth/state`
- A scoped API key (`Authorization: Bearer dak_...`) replaces the cookie and CSRF token; see [api-keys.md](api-keys.md).
- Exceptions: the Discord adapter (`/api/integrations/discord/*`, its own bearer token), the public i18n reads (`GET /api/i18n/languages` and `/translations`), and the signed peer-mesh i18n routes (`/api/i18n/mesh/*`).

### Discord Adapter Auth
- Separate from admin console authentication
- Uses bearer token: `Authorization: Bearer <DUNE_DISCORD_ADAPTER_TOKEN>`
- Token from env var `DUNE_DISCORD_ADAPTER_TOKEN` or file `DUNE_DISCORD_ADAPTER_TOKEN_FILE`. The stock `docker-compose.web.yml` forwards the env var but not `DUNE_DISCORD_ADAPTER_TOKEN_FILE`, so the file form needs a Compose override.
- Enforces role-based capabilities per actor; game-data writes are disabled, and the only writes are `players/link`, `players/link/verify`, `players/unlink` (adapter-local) and `broadcast` (needs `DUNE_DISCORD_WRITES_ENABLED`, not forwarded by the stock compose file)

---

## Notes

- **Source of truth:** the route dispatch in `console/api/src/server.js` (`handleApi`), `console/api/src/services/i18nService.js` and `console/api/src/integrations/discord/routes.js`. The permission each route needs is in `console/api/src/actions.js`.
- **Coverage:** every route those files dispatch is listed here. When you add a route, add its row in the same change.
