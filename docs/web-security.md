# Web Security

The web admin has host and game-server control power. Treat it as an admin-only local operations surface.

## Authentication

- The API uses a local admin password and secure session cookie.
- State-changing requests require a CSRF token from the authenticated session.
- `AUTH_DISABLED=true` is allowed only for local development.
- Login and logout are audit logged.

## Command Safety

All command execution must use the safe command runner:

- no arbitrary shell commands from the frontend
- no dynamic `sh -c`
- allowlisted RedBlink operations only
- validate service names, player IDs, item IDs, map names, backup names, filenames, and paths
- enforce timeouts
- redact secrets from stdout/stderr/task logs
- write audit entries for high-risk operations

Allowed command families are RedBlink `runtime/scripts/dune` operations and narrowly scoped Docker inspection/control where needed.

## Direct Database Safety

Direct Postgres features must:

- discover connection details from the RedBlink Docker/runtime environment
- use parameterized queries where available
- validate schema/table names against database metadata
- create a backup before destructive mutations unless an existing safe RedBlink command already does so
- require explicit confirmation for destructive SQL
- support read-only mode
- redact secrets and sensitive tokens from logs

Phase 5A direct DB admin mutations follow the same pattern: the API first verifies the backend confirmation phrase, creates a RedBlink DB backup with `dune db backup`, then runs a parameterized transaction. Supported write paths are Solaris/currency via `dune.adjust_player_virtual_currency_balance`, faction reputation via `dune.set_player_faction_reputation`, inventory delete via `dune.delete_item`, storage item insert into verified `dune.items`/`dune.inventories`, gear durability JSON repair, and owned vehicle fuel JSON update. If required tables/functions/columns are not detected, the endpoint returns a clear unsupported capability response instead of attempting a write.

## RabbitMQ Safety

RabbitMQ live commands must:

- use known RedBlink game/admin exchange and routing details only
- validate target player/account IDs
- audit every broadcast, whisper, kick, item grant, teleport, or live command
- avoid exposing a generic message publisher to the browser


Destructive live actions require backend confirmation phrases in addition to frontend confirmation:

- kick all online: `KICK ALL ONLINE PLAYERS`
- clean inventory: `CLEAN INVENTORY`
- reset progression: `RESET PROGRESSION`
- add currency: `ADD CURRENCY`
- add faction reputation: `ADD FACTION REPUTATION`
- repair gear: `REPAIR GEAR`
- refuel vehicle: `REFUEL VEHICLE`
- inventory delete: `DELETE ITEM`
- storage give item: `GIVE ITEM TO STORAGE`
- shutdown broadcast: `SHUTDOWN BROADCAST`
- map mode changes: `SET MAP MODE`
- map reconcile: `RECONCILE MAPS`
- map spawn: `SPAWN MAP`
- map despawn: `DESPAWN MAP`
- autoscaler control: `AUTOSCALER CHANGE`
- map memory set/unset: `SET MAP MEMORY` / `UNSET MAP MEMORY`
- Sietch live-impacting changes: `UPDATE SIETCHES`
- Deep Desert dual controls: `UPDATE DEEP DESERT`

## Live Map Safety

Live Map endpoints are read-only. Marker overlays use direct PostgreSQL reads with parameterized optional map filters and return explicit capability/unsupported reasons when expected tables or transform columns are unavailable. The frontend plots raw world coordinates only; it does not invent markers or assume a verified image calibration.

## Docker Socket Risk

Container mode may require mounting `/var/run/docker.sock`. That grants broad control over the host Docker daemon. Documentation and compose comments must warn that this is powerful and should be exposed only to trusted admins.

## Host Bootstrap

Host-level bootstrap such as Docker installation is disabled by default.

If `ALLOW_HOST_BOOTSTRAP=true` is set:

- every command must be displayed before execution
- explicit confirmation is required
- Ubuntu/Debian must be supported first
- unsupported systems must show manual instructions only

## Audit Log

Audit logging is required for:

- login/logout
- setup/config changes
- start/stop/restart
- updates
- backup/restore/import/delete
- admin player actions
- SQL execution
- file upload/download/restore
- RabbitMQ live commands
