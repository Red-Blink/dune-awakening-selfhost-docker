# Web Security

The web admin has host and game-server control power. Treat it as an admin-only local operations surface.

## Authentication

- The API uses a local admin password and secure session cookie.
- State-changing requests require a CSRF token from the authenticated session.
- `AUTH_DISABLED=true` is allowed only for local development.
- Login and logout are audit logged.
- `ADMIN_SECURE_COOKIES=1` or `NODE_ENV=production` adds the `Secure` flag to session cookies. Leave it off only for plain-HTTP local development.

## Command Safety

All command execution must use the safe command runner:

- no arbitrary shell commands from the frontend
- no dynamic `sh -c`
- allowlisted RedBlink operations only
- validate service names, player IDs, item IDs, map names, backup names, filenames, and paths
- enforce timeouts
- redact secrets from stdout/stderr/task logs
- write audit entries for high-risk operations
- static frontend serving is constrained to the configured build directory

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
- reject JSON request bodies larger than `ADMIN_MAX_JSON_BYTES`

Phase 5A direct DB admin mutations follow the same pattern: the API first verifies the backend confirmation phrase, creates a RedBlink DB backup with `dune db backup`, then runs a parameterized transaction. Supported write paths are Solaris/currency via `dune.adjust_player_virtual_currency_balance`, faction reputation via `dune.set_player_faction_reputation`, inventory delete via `dune.delete_item`, storage item insert into verified `dune.items`/`dune.inventories`, gear durability JSON repair, and owned vehicle fuel JSON update. If required tables/functions/columns are not detected, the endpoint returns a clear unsupported capability response instead of attempting a write.

Phase 5B2 market endpoints are read-only direct PostgreSQL queries implemented for Arrakis Server Console and require the verified `dune_exchange_*` tables. Blueprint and base full exports are read-only. Blueprint/base import, clone, and delete endpoints validate confirmation and payload shape, then return unsupported until safe graph mutation and ID remapping rules are verified. Starter Kit config/history writes are file-backed under `runtime/generated`; manual, bulk, and controlled auto-grants execute existing RedBlink `dune admin` commands with `action_player_id` and are audited/history logged.

## RabbitMQ Safety

RabbitMQ live commands must:

- use known RedBlink game/admin exchange and routing details only
- validate target player/account IDs
- audit every broadcast, whisper, kick, item grant, teleport, or live command
- avoid exposing a generic message publisher to the browser

Phase 4 web actions use the existing RedBlink `dune admin` CLI for RabbitMQ-backed live commands. Broadcast and shutdown broadcast use the verified server-command envelope and publish only to `dune-rmq-game` exchange `heartbeats`, routing key `notifications`, with `app_id=fls_backend`, `user_id=fls`, and a `ServiceBroadcast` payload. Live Phase 9B validation confirmed RabbitMQ publish success and command history logging, but no in-game display, so the web UI labels broadcast as Experimental / publish-verified only. Arrakis Server Console does not currently expose a separate courier-style `/api/v1/notify` path on exchange `notifications`; that capability requires AMQP broker credentials/config and is not enabled in this Docker web admin. The API does not expose a generic RabbitMQ publisher. Whisper still returns an explicit unsupported capability response because the web admin path depends on a GM courier persona and `chat.whispers` recipient routing that are not yet verified in RedBlink.

Whisper verification result: the web admin publishes courier chat to exchange `chat.whispers` using routing key equal to the recipient Funcom ID, AMQP type `text_chat`, and AMQP `user_id` equal to the sender GM hex FLS ID. The body includes the sender GM Funcom ID, recipient Funcom ID, and recipient character name. RedBlink does not currently seed or expose the required GM account/persona rows, sender Funcom ID, sender hex FLS ID, and verified recipient Funcom ID mapping, so the web API refuses to send whispers.

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
- scheduled restart settings: `SAVE RESTART SCHEDULE`
- automatic game update settings: `SAVE AUTO GAME UPDATES`
- restore previous stack: `RESTORE PREVIOUS STACK`
- map mode changes: `SET MAP MODE`
- map reconcile: `RECONCILE MAPS`
- map spawn: `SPAWN MAP`
- map despawn: `DESPAWN MAP`
- autoscaler control: `AUTOSCALER CHANGE`
- map memory set/unset: `SET MAP MEMORY` / `UNSET MAP MEMORY`
- materialize UserEngine/UserGame runtime files: `REFRESH MAP SETTINGS`
- Sietch live-impacting changes: `UPDATE SIETCHES`
- Deep Desert dual controls: `UPDATE DEEP DESERT`
- Starter Kit config: `SAVE STARTER KIT`
- Starter Kit enable/disable: `ENABLE STARTER KIT` / `DISABLE STARTER KIT`
- Starter Kit manual grant/retry: `GRANT STARTER KIT` / `RETRY STARTER KIT`
- Starter Kit bulk grant: `GRANT STARTER KIT TO ELIGIBLE PLAYERS`
- Starter Kit one-shot scan: `RUN STARTER KIT SCAN`
- blueprint import/clone/delete blocked paths: `IMPORT BLUEPRINT` / `CLONE BLUEPRINT` / `DELETE BLUEPRINT`
- base import/delete blocked paths: `IMPORT BASE` / `DELETE BASE`

Automatic database backup settings are validated server-side and run only through `dune db auto enable|disable`; retention `0` is treated as "no retention limit" and is not passed as an invalid manager argument. Remote SSH backup import remains disabled because the Dune Manager flow is interactive and would require SSH credential handling. UserEngine/UserGame restore defaults remains disabled because the helper can remove/write overrides without a web-managed backup/preview.

Market automation, blueprint/base graph writes, remote SSH import, UserEngine/UserGame destructive reset, and whisper are not exposed as generic command or message publishers. They return explicit unsupported responses until a verified RedBlink-compatible runtime or schema/RMQ/file mutation path exists. Starter Kit auto-grant is not a generic command runner: it is disabled by default, requires Starter Kit enabled plus `autoGrantEnabled`, uses the current player list `action_player_id`, skips players without admin action IDs, respects current-version idempotency unless repeat grants are enabled, and avoids overlapping scans.

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
- Starter Kit config changes/manual grants/bulk grants/auto scans/retries
- map/Sietch/Deep Desert changes
- blueprint/base export and blocked import/delete/clone attempts

Audit retention/rotation is not implemented yet; `runtime/generated/web-admin-audit.jsonl` should be managed by the operator or a future retention task.
