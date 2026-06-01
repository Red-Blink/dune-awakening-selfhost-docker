# Web API

The RedBlink web API is intentionally not a shell proxy. Endpoints must call allowlisted RedBlink commands, direct Postgres logic, direct RabbitMQ logic, or Docker/Compose inspection/control with validation.

Base path for the native RedBlink API: `/api`.


## Implemented / Partial Foundation Routes

| Endpoint | Method | Current purpose | Real operation |
|---|---:|---|---|
| `/api/health` | GET | Basic web service health | In-process health response |
| `/api/auth/state` | GET | Session/auth state | Secure cookie session read |
| `/api/auth/login` | POST | Local admin login | Password check, session cookie, CSRF token, audit |
| `/api/auth/logout` | POST | Logout | Session clear, audit |
| `/api/setup/state` | GET | Setup file state | Checks `.env`, token, generated files, `runtime/scripts/dune` |
| `/api/setup/preflight` | POST | Host preflight | OS/CPU/RAM/disk/Docker/runtime checks |
| `/api/setup/write-config` | POST | Write selected `.env` keys | Validated key allowlist |
| `/api/setup/save-token` | POST | Save Funcom token | Writes `runtime/secrets/funcom-token.txt` with restrictive permissions |
| `/api/setup/init` | POST | Start init task | `dune init` through task runner |
| `/api/setup/tasks` | GET | List tasks | In-memory task manager |
| `/api/setup/tasks/:id` | GET | Task status | In-memory task manager |
| `/api/setup/tasks/:id/stream` | GET | Task SSE stream | Redacted task logs |
| `/api/server/status` | GET | Server status | `dune status` |
| `/api/server/readiness` | GET | Readiness | `dune ready` |
| `/api/server/ports` | GET | Ports | `dune ports` |
| `/api/server/services` | GET | Services | `dune ps` |
| `/api/server/doctor` | GET | Doctor diagnostics | `dune doctor` |
| `/api/server/start` | POST | Start task | `dune start` |
| `/api/server/stop` | POST | Stop task | `dune stop` |
| `/api/server/restart` | POST | Restart task | `dune stop` then `dune start` |
| `/api/server/restart-service` | POST | Restart service task | `dune restart <validated-service>` |
| `/api/logs/services` | GET | Service names | Static allowlist until dynamic discovery is added |
| `/api/logs/:service` | GET | Service logs | `dune logs <validated-service>` |
| `/api/logs/:service/stream` | GET | Service log SSE stream | `dune logs <validated-service>` or validated Docker logs for dynamic `dune-server-*` containers |
| `/api/logs/:service/download` | GET | Download redacted logs | `dune logs <validated-service>` or validated Docker logs for dynamic `dune-server-*` containers |
| `/api/updates/check-game` | POST | Game update check task | `dune update check` |
| `/api/updates/apply-game` | POST | Game update task | `dune update --yes` |
| `/api/updates/check-stack` | POST | Stack update check task | `dune self-update check` |
| `/api/updates/apply-stack` | POST | Stack update task | `dune self-update install latest` |
| `/api/backups` | GET | Backup list | `dune db list` |
| `/api/backups/create` | POST | Create backup task | `dune db backup` |
| `/api/backups/restore` | POST | Restore backup task | `dune db restore <validated-backup>` |
| `/api/backups/:name` | DELETE | Delete backup task | `dune db delete <validated-backup>` |
| `/api/database/status` | GET | Direct DB health/config status | Direct PostgreSQL query using discovered RedBlink DB config |
| `/api/database/schemas` | GET | List schemas | Direct PostgreSQL `information_schema` query |
| `/api/database/tables` | GET | Database tables | Direct PostgreSQL `information_schema` / `pg_stat_user_tables` query |
| `/api/database/tables/:schema/:table/columns` | GET | Table columns | Direct PostgreSQL `information_schema.columns` query |
| `/api/database/tables/:schema/:table/preview` | GET | Preview rows | Direct PostgreSQL query with validated quoted identifiers and limit/offset parameters |
| `/api/database/tables/:schema/:table/count` | GET | Count rows | Direct PostgreSQL query with validated quoted identifiers |
| `/api/database/search` | GET | Search schemas/tables/columns | Direct PostgreSQL `information_schema.columns` query |
| `/api/database/query` | POST | Advanced SQL execution | Direct PostgreSQL query; read-only by default, destructive SQL requires confirmation phrase and pre-query `dune db backup` |
| `/api/database/export` | POST | Export read-only query results | Direct PostgreSQL read-only query returned as JSON |
| `/api/players/online` | GET | Online player list | Direct PostgreSQL query filtered by `player_state.online_status` |
| `/api/players/search` | GET | Player search | Direct PostgreSQL parameterized search over character/account/actor |
| `/api/players/:id` | GET | Player profile | Direct PostgreSQL actor/player_state/accounts query |
| `/api/players/:id/currency` | GET | Currency balances | Direct PostgreSQL `player_virtual_currency_balances` query where table exists |
| `/api/players/:id/factions` | GET | Faction reputation | Direct PostgreSQL `player_faction_reputation` query where table exists |
| `/api/players/:id/specs` | GET | Specialization tracks | Direct PostgreSQL `specialization_tracks` query |
| `/api/players/:id/progression` | GET | Progression capability report | Returns unsupported reason until schema is mapped |
| `/api/players/:id/position` | GET | Player position | Direct PostgreSQL actor transform query when transform composite is available |
| `/api/players/:id/events` | GET | Events capability report | Returns unsupported reason until schema is mapped |
| `/api/players/:id/stats` | GET | Stats capability report | Returns unsupported reason until schema is mapped |
| `/api/players/:id/history` | GET | History capability report | Returns unsupported reason until schema is mapped |
| `/api/players/:id/give-item` | POST | Give item task | `dune admin grant-item` |
| `/api/players/:id/give-items` | POST | Give multiple items | Arbitrary payload uses repeated validated `dune admin grant-item-id`; legacy template payload uses `dune admin grant-template` |
| `/api/players/:id/give-item-id` | POST | Give raw item ID task | `dune admin grant-item-id` |
| `/api/players/:id/add-xp` | POST | Add XP task | `dune admin award-xp` |
| `/api/players/:id/set-skill-points` | POST | Set unspent skill points task | `dune admin skill-points` |
| `/api/players/:id/set-skill-module` | POST | Set skill module level task | `dune admin skill-module` |
| `/api/players/:id/refill-water` | POST | Refill water task | `dune admin refill-water` |
| `/api/players/:id/kick` | POST | Kick task | `dune admin kick` |
| `/api/players/kick-all-online` | POST | Kick all online task | `dune admin kick --all-online --yes`; requires confirmation phrase `KICK ALL ONLINE PLAYERS` |
| `/api/players/:id/teleport` | POST | Teleport task | `dune admin teleport` |
| `/api/players/:id/spawn-vehicle` | POST | Spawn vehicle in front of player task | `dune admin spawn-vehicle` |
| `/api/players/:id/clean-inventory` | POST | Clean inventory task | `dune admin clean-inventory`; requires confirmation phrase `CLEAN INVENTORY` |
| `/api/players/:id/reset-progression` | POST | Reset progression task | `dune admin reset-progression`; requires confirmation phrase `RESET PROGRESSION` |
| `/api/players/:id/add-currency` | POST | Add Solaris/currency | Creates `dune db backup`, transactionally calls `dune.adjust_player_virtual_currency_balance`; requires `ADD CURRENCY` |
| `/api/players/:id/add-faction-reputation` | POST | Add faction reputation | Creates `dune db backup`, transactionally calls `dune.set_player_faction_reputation` and syncs actor faction JSON for Atreides/Harkonnen; requires `ADD FACTION REPUTATION` |
| `/api/players/:id/repair-gear` | POST | Repair carried gear | Creates `dune db backup`, requires offline player, transactionally updates item durability JSON; requires `REPAIR GEAR` |
| `/api/players/:id/refuel-vehicle` | POST | Refuel owned vehicle | Creates `dune db backup`, requires offline player and matching vehicle ownership, transactionally updates actor fuel JSON; requires `REFUEL VEHICLE` |
| `/api/players/:id/inventory/:itemId` | DELETE | Delete inventory item | Creates `dune db backup`, verifies direct player inventory ownership, transactionally calls `dune.delete_item`; requires `DELETE ITEM` |
| `/api/admin/items/search` | GET | Search admin item catalog | `dune admin item-search <q>` |
| `/api/admin/items` | GET | List admin item catalog/categories | `dune admin item-list [category]` |
| `/api/admin/vehicles` | GET | List/search vehicle catalog | `dune admin vehicle-list [q]` |
| `/api/admin/skill-modules` | GET | List/search skill module catalog | `dune admin skill-modules [q]` |
| `/api/admin/history` | GET | Admin history | `dune admin history` |
| `/api/admin/broadcast` | POST | Live admin broadcast | Publishes RedBlink `ServiceBroadcast` Generic envelope to `dune-rmq-game` `heartbeats/notifications` |
| `/api/admin/broadcast-shutdown` | POST | Shutdown broadcast | Publishes RedBlink `ServiceBroadcast` ServerShutdown envelope to `dune-rmq-game` `heartbeats/notifications`; requires `SHUTDOWN BROADCAST` |
| `/api/admin/whisper` | POST | Whisper capability response | Returns unsupported until GM courier identity and `chat.whispers` route are verified |
| `/api/map/status` | GET | Live map status bundle | `dune maps list`, `dune servers`, `dune ready`, `dune autoscaler status` |
| `/api/map/capabilities` | GET | Live map overlay capabilities | Direct PostgreSQL table/function capability detection |
| `/api/map/markers` | GET | Combined Live Map markers | Direct PostgreSQL player/vehicle/base/storage/service marker queries where schema support exists |
| `/api/map/players` | GET | Player markers | Direct PostgreSQL `actors.transform` + `player_state` query |
| `/api/map/bases` | GET | Base markers | Direct PostgreSQL building/totem actor transform query where available |
| `/api/map/storage` | GET | Storage markers | Direct PostgreSQL storage placeable actor transform query |
| `/api/map/services` | GET | Map service partitions | Direct PostgreSQL `world_partition` plus optional `farm_state` query |
| `/api/map/overlays` | GET | Overlay markers and unsupported reasons | Same direct PostgreSQL marker adapter as `/api/map/markers` |
| `/api/maps` | GET | Map list | `dune maps list` |
| `/api/maps/mode` | GET | Map mode | `dune maps mode [map]` |
| `/api/maps/mode` | POST | Set map mode | Task wrapping `dune maps set <map> <dynamic|always-on>`; requires `SET MAP MODE` |
| `/api/maps/reconcile` | POST | Reconcile always-on maps | Task wrapping `dune maps reconcile`; requires `RECONCILE MAPS` |
| `/api/maps/spawn` | POST | Spawn map/partition | Task wrapping `dune spawn <map-or-partition>`; requires `SPAWN MAP` |
| `/api/maps/despawn` | POST | Despawn map/partition/container | Task wrapping `dune despawn <target> --force`; requires `DESPAWN MAP` |
| `/api/maps/autoscaler` | GET | Autoscaler status | `dune autoscaler status` |
| `/api/maps/autoscaler` | POST | Autoscaler control | Task wrapping validated `dune autoscaler start|stop|restart|logs|status`; requires `AUTOSCALER CHANGE` |
| `/api/maps/memory` | GET | Map memory status | `dune memory status` |
| `/api/maps/memory` | POST | Set/unset map memory | Task wrapping `dune memory set|unset`; requires `SET MAP MEMORY` or `UNSET MAP MEMORY` |
| `/api/sietches` | GET | Sietch state | `dune sietches list` |
| `/api/sietches/update` | POST | Sietch settings/control | Task wrapping validated `dune sietches set-max|set-active|set-display|set-password|sync|validate|reconcile`; dangerous actions require `UPDATE SIETCHES` |
| `/api/deepdesert` | GET | Deep Desert status | `dune deepdesert dual status` |
| `/api/deepdesert/update` | POST | Deep Desert dual control | Task wrapping validated `dune deepdesert dual enable|disable|repair|bootstrap`; requires `UPDATE DEEP DESERT` |
| `/api/settings` | GET | Runtime settings state | Setup state/config summary |
| `/api/storage/:id` | GET | Storage detail | Direct PostgreSQL storage list lookup |
| `/api/storage/:id/items` | GET | Storage inventory | Direct PostgreSQL inventory query |
| `/api/storage/:id/give-item` | POST | Give item to storage | Creates `dune db backup`, validates item catalog/template and slot count, transactionally inserts into `dune.items`; requires `GIVE ITEM TO STORAGE` |
| `/api/storage/:id/export` | GET | Export storage JSON | Direct PostgreSQL inventory query |
| `/api/bases/:id` | GET | Base detail | Direct PostgreSQL base list lookup |
| `/api/bases/:id/export` | GET | Export base summary JSON | Direct PostgreSQL base query summary |
| `/api/blueprints/:id` | GET | Blueprint detail | Direct PostgreSQL blueprint list lookup |
| `/api/blueprints/:id/export` | GET | Export blueprint summary JSON | Direct PostgreSQL blueprint query summary |

## Not Done Yet


- `/api/players/:id/set-currency`
- `/api/admin/whisper` returns explicit unsupported capability response until RedBlink exposes or seeds a verified GM courier identity for `chat.whispers`
- player progression/events/stats/history deep schema mapping
- `/api/setup/install-docker`

Phase 1 cleanup must either implement these for real or remove/quarantine their frontend controls.


The full route inventory and RedBlink implementation paths are in `docs/web-feature-parity-plan.md`.
