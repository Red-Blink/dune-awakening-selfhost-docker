# Web Feature Parity Plan

This plan tracks work for building a full RedBlink web admin interface around the existing Docker runtime.

Reference surface:

- Existing RedBlink command surface in `runtime/scripts/dune`, `runtime/scripts/admin-tools.sh`, `runtime/scripts/db.sh`, `runtime/scripts/db-manager.sh`, `runtime/scripts/logs.sh`, `runtime/scripts/map-modes.sh`, `runtime/scripts/sietches.sh`, `runtime/scripts/deepdesert.sh`, and update/status scripts

Architecture decision:

- Keep the native RedBlink admin service in this repo and implement web admin logic route-by-route.
- Reason: this repo already has a Docker-native CLI/runtime contract, and the existing Node backend scaffold already contains auth, CSRF, task, audit, and safe-runner primitives that can be rescued. 

Status meanings:

- Done: frontend UI, backend endpoint, real RedBlink logic, safety, error display, and test/manual verification exist.
- Partial: real work exists, but at least one acceptance requirement is missing.
- Not Implemented: no working RedBlink web feature yet.
- Blocked: a specific technical blocker prevents reliable implementation.

## Product Feature Matrix

| Feature group | web-admin frontend page/tab | web-admin backend coverage | Existing RedBlink support | Backend work required | Frontend work required | Implementation status | Test status |
|---|---|---|---|---|---|---|---|
| Status / connection / config | App shell, settings modal | `/api/v1/status`, `/api/v1/reconnect`, `/api/v1/config` | `dune status`, `dune version`, `dune doctor`, `.env`, `runtime/generated`, Docker state | Add RedBlink-compatible status payload, config read/write with schema, reconnect as runtime refresh, version/image discovery | Status bar, config/settings editor, version/runtime cards | Partial: old scaffold has basic auth/state and status wrappers, not web-admin parity | Partial: auth/runner tests only |
| Server lifecycle / Server Control | Battlegroup tab | `/api/v1/battlegroup/status`, `/exec`, `/pods`, backup upload/download/restore | `dune start`, `stop`, `restart`, `ps`, `ready`, `ports`, `doctor`, `restart-schedule`, `db backup/list/restore` | Map battlegroup actions to Docker/RedBlink tasks, backup upload/download, scheduled restart endpoints | Server Control page with task progress and confirmations | Partial: start/stop/restart/status endpoints exist, not full parity | Needed |
| Server settings | Server Settings tab | `/api/v1/server-settings`, `/raw` | `dune config`, `dune memory`, `dune maps`, `dune sietches`, `.env`, generated config files | Structured settings provider preserving unknown keys and restart impact metadata | Full settings editor, advanced raw editor with warnings | Not Implemented in parity terms | Needed |
| Players / profiles | Players tab | list, online, currency, factions, specs, templates, inventory, journey, tags, export, stats, history, vehicles, position, events, dungeons | `dune admin players`, `players --online`, `player-location`, history; direct DB available via `dune database` | Implement player DB query layer for profile/inventory/progression/history, add CLI-backed online/list fallback | Players page, profile drawer, inventory/progression/history tabs | Partial: current web lists players via CLI only | Needed |
| Player/admin actions | Players/Admin tools | Give item(s), XP, char XP, currency, faction rep, scrip, rename, delete, spec, keystones, journey/contracts, repair/refuel, teleport, RMQ actions | `dune admin grant-item`, `grant-item-id`, `grant-template`, `award-xp`, `skill-points`, `skill-module`, `refill-water`, `kick`, `clean-inventory`, `reset-progression`, `teleport`, `spawn-vehicle`, `specialization-xp`, `history` | Wrap all existing commands; implement missing DB/RMQ actions; enforce confirmations/backups where destructive | Complete Admin Tools and player action forms | Partial: current web exposes only a few CLI wrappers | Needed |
| Database | Database tab | `/tables`, `/describe`, `/sample`, `/search`, `/sql` | `dune db status/health/backup/list/import/restore/delete/auto/transfer`, `dune database status/schemas/tables/counts/columns/preview/sql/export` | RedBlink DB discovery, safe SQL classifier, backup-before-destructive, export/download endpoints | Table browser, search, SQL console, export, destructive confirmation | Partial: tables/preview wrappers exist; SQL/export are placeholder 501 | Needed |
| Logs | Logs tab | `/api/v1/logs/pods`, `/stream`, `/cheats` | `dune logs <service> [--raw]`, Docker logs, admin history | Dynamic service discovery, streaming, raw-log confirmation, cheat/admin logs if available | Log browser with pause/search/download/raw confirm | Partial: basic service logs stream exists | Needed |
| Live map | Live Map tab | `/api/v1/map/markers` | `dune servers`, `dune maps list/mode/set/reconcile`, `dune spawn/despawn`, autoscaler scripts, DB data | Implement marker/player/base queries and map control endpoints | Interactive map with overlays and safe spawn/despawn controls | Not Implemented | Needed |
| Storage | Storage tab | `/api/v1/storage`, `/{id}/items`, give item(s), owner-debug | No direct CLI; possible direct DB | Implement web-admin storage DB logic and backup/safety | Storage browser and give-item forms | Not Implemented | Needed |
| Blueprints | Blueprints tab | `/api/v1/blueprints`, export, import | No direct CLI; possible direct DB/filesystem | Implement blueprint DB/filesystem logic | Blueprint list/import/export UI | Not Implemented | Needed |
| Bases | Bases tab | `/api/v1/bases`, export | No direct CLI; possible direct DB | Implement base DB queries/export | Bases browser/export UI | Not Implemented | Needed |
| Market | Market tab | `/api/v1/market/*`, `/api/v1/market-bot/*` | No direct CLI; possible direct DB and automation scripts to add | Implement read-only market queries first; evaluate bot runtime fit | Market views and Market Automation controls | Not Implemented | Needed |
| Starter Kit | Welcome Package tab | `/api/v1/welcome-package/*` | No direct CLI | Implement welcome package config/grant/audit logic; disabled by default | Starter Kit config, grant history, retry/run | Not Implemented | Needed |
| Notifications / broadcast / chat | Player/RMQ actions | `/api/v1/notify`, `/broadcast`, `/broadcast/shutdown`, `/chat/whisper`, RMQ player actions | Some live RMQ paths exist behind `dune admin`; direct RMQ likely reusable | Add RedBlink RMQ connection discovery and safe command publisher | Broadcast/whisper forms with audit | Not Implemented | Needed |
| Updates | Update controls | `/api/v1/update/check`, `/apply` | `dune update check`, `dune update`, `dune self-update check/list/install`, `dune update auto` | Task wrappers for game/stack check/apply/list/auto/repair | Updates page with task logs and release list | Partial: basic check/apply task wrappers exist | Needed |
| Setup wizard | RedBlink-specific | Not in web admin core | `dune init`, `.env`, token file, preflight scripts, start/ready/logs | Keep setup wizard, remove host bootstrap placeholder or implement gated preview | Full first-time setup flow | Partial: scaffold exists, needs parity-safe cleanup | Needed |
| Security / audit / tasks | Cross-cutting | CORS and route handlers in web-admin | Existing web scaffold has auth/session/CSRF/task/audit/safe runner | Expand validation, path safety, Docker socket warnings, audit coverage, cancellation | Login/session state, confirmations, task logs | Partial: foundation exists but incomplete coverage | Partial: auth/runner tests only |

## web-admin Backend Route Parity Matrix

| web-admin routes | Feature page/group | RedBlink support now | New backend work | New frontend work | Status | Test status |
|---|---|---|---|---|---|---|
| `GET /api/v1/status`, `POST /api/v1/reconnect` | Status | `dune status`, `dune version`, Docker/runtime files | Return structured Docker/runtime/DB/RMQ/version status; refresh config/connection pools | Home status and reconnect action | Partial | Needed |
| `GET /api/v1/config`, `POST /api/v1/config` | Config | `.env`, web config, runtime path | Typed RedBlink config read/write, secret redaction, restart impact | Settings/config editor | Partial | Needed |
| `GET /api/v1/update/check`, `POST /api/v1/update/apply` | Updates | `dune update check`, `dune update` | Add game update tasks, output parser, task logs | Updates page controls | Partial | Needed |
| `GET/PUT /api/v1/server-settings`, `PUT /api/v1/server-settings/raw` | Server settings | `dune config`, `dune memory`, map/sietch scripts | Parse/edit `.env`, UserGame/UserEngine/overrides, map memory, sietch settings | Server Settings page | Not Implemented | Needed |
| `GET /api/v1/battlegroup/status`, `POST /api/v1/battlegroup/exec`, `GET /api/v1/battlegroup/pods` | Server Control | `dune status`, `start`, `stop`, `restart`, `ready`, `ps`, Docker inspect | RedBlink operation mapping and service discovery | Server Control and Services pages | Partial | Needed |
| `GET /api/v1/battlegroup/backup-files`, `GET /download`, `POST /upload`, `POST /restore` | Backups | `dune db list`, `backup`, `restore`, `import`, `delete` | Upload/download/delete/restore task endpoints with path validation | Backups page and restore dialog | Partial | Needed |
| `GET /api/v1/players`, `/online`, `/currency`, `/factions`, `/specs`, `/templates` | Players | `dune admin players`, online list; direct DB possible | Implement query layer and normalize IDs | Players lists and filters | Partial | Needed |
| `GET /api/v1/players/{id}/inventory`, `/journey`, `/tags`, `/export`, `/char-xp`, `/keystones`, `/specs`, `/vehicles`, `/position`, `/events`, `/dungeons`, `/stats`, `/solaris-history`, `/session-history`, `/stat-snapshot-history`, `/player-ids` | Player profile | `player-location`; direct DB/RMQ possible | Direct DB profile modules and export logic | Profile drawer tabs | Not Implemented | Needed |
| `POST /api/v1/players/give-item`, `/give-items`, `/grant-live`, `/give-currency`, `/give-faction-rep`, `/give-scrip`, `/award-xp`, `/award-char-xp`, `/award-intel` | Player actions | Existing CLI covers item, item-id, XP; missing currency/faction/scrip/char/intel | Wrap CLI where available; implement DB/RMQ actions where missing | Action dialogs | Partial | Needed |
| `POST /api/v1/players/rename`, `/update-tags`, `/returning-player-award`, `/dismiss-returning-player-award`, `/delete-account`, `DELETE /api/v1/players/item/{id}` | Account/item management | No direct CLI; DB possible | Direct DB mutations with backup and confirmations | Dangerous account/item dialogs | Not Implemented | Needed |
| `POST /api/v1/players/reset-spec`, `/set-faction-tier`, `/progression-unlock`, `/progression-reverse`, `/journey/complete`, `/journey/reset`, `/journey/wipe`, `/contract/complete`, `/contracts/complete`, `/contracts/reverse`, `GET /api/v1/contracts`, `GET /api/v1/progression/presets`, `POST /api/v1/players/progression/apply-preset` | Progression | `reset-progression`, specialization commands; direct DB possible | Port journey/contracts/progression DB logic and presets | Progression tools | Partial for reset/spec max only | Needed |
| `POST /api/v1/players/grant-job-skills`, `/reset-job-skills`, `/set-starter-class`, `/delete-tutorials`, `/wipe-codex`, `/grant-all-keystones`, `/reset-all-keystones`, `/grant-max-spec` | Skills/specs | `skill-points`, `skill-module`, `specialization-xp`, `specialization-max` | Wrap existing and implement missing direct DB operations | Skills/spec tools | Partial | Needed |
| `POST /api/v1/players/repair-item`, `/repair-gear`, `/repair-vehicle`, `/refuel-vehicle`, `/teleport`, `/teleport-to-player`, `GET /api/v1/players/partitions` | Gear/vehicle/world actions | `teleport`, `spawn-vehicle`, vehicle list; repair/refuel missing | Port DB/RMQ repair/refuel and partition queries | Vehicle/world action dialogs | Partial | Needed |
| `POST /api/v1/players/kick`, `/fill-water`, `/set-skill-points`, `/clean-inventory`, `/reset-progression`, `/set-skill-module`, `/give-item-live`, `/cheat-script`, `/vehicles/spawn`, `/broadcast`, `/broadcast/shutdown`, `/chat/whisper`, `POST /api/v1/notify` | RMQ live commands | CLI covers kick, water, skill points/module, clean, reset, vehicle, item; broadcast/whisper missing | Safe RMQ publisher and/or CLI wrappers | Live admin tools | Partial | Needed |
| `GET /api/v1/database/tables`, `/describe`, `/sample`, `/search`, `POST /api/v1/database/sql` | Database | `dune database` equivalent commands | SQL safety, export, destructive backup/confirmation | DB browser and Advanced SQL Console | Partial | Needed |
| `GET /api/v1/logs/pods`, `/stream`, `/cheats` | Logs | `dune logs`, Docker logs, admin history | Dynamic services and cheat/admin log source | Logs page | Partial | Needed |
| `GET /api/v1/map/markers` | Live Map | `dune servers`, map scripts, DB possible | Marker/player/base query adapter | Live Map page | Not Implemented | Needed |
| `GET /api/v1/storage`, `GET /api/v1/storage/{id}/items`, `POST /give-item`, `POST /give-items`, `GET /owner-debug` | Storage | No CLI | Port storage DB logic | Storage page | Not Implemented | Needed |
| `GET /api/v1/blueprints`, `GET /api/v1/blueprints/{id}/export`, `POST /api/v1/blueprints/import` | Blueprints | No CLI | Port blueprint DB/filesystem logic | Blueprints page | Not Implemented | Needed |
| `GET /api/v1/bases`, `GET /api/v1/bases/{id}/export` | Bases | No CLI | Port base DB/export logic | Bases page | Not Implemented | Needed |
| `GET /api/v1/market/items`, `/listings`, `/sales`, `/stats`, `/categories`, `/catalog` | Market | No CLI | Port market read query layer | Market page | Not Implemented | Needed |
| `GET/PUT /api/v1/market-bot/config`, `GET /status`, `POST /exec`, `/cleanup`, `GET /logs-ready`, `/logs` | Market Automation | No CLI | Determine bot runtime fit; port only if it works in Docker stack | Market Automation controls | Not Implemented | Needed |
| `GET/PUT /api/v1/welcome-package/config`, `GET /grants`, `POST /retry`, `/run` | Starter Kit | No CLI | Port welcome package logic and audit; disabled by default | Starter Kit page | Not Implemented | Needed |

## web-admin Frontend Page Parity Matrix

| web-admin page/tab | RedBlink UI name | Current RedBlink web state | Backend dependencies | Frontend work | Status | Test status |
|---|---|---|---|---|---|---|
| App status/config shell | Home / Settings | Partial scaffold | Status/config/auth/tasks | Replace shallow dashboard with real structured data and errors | Partial | Needed |
| `BattlegroupTab` | Server Control / Services / Backups | Partial server cards | Lifecycle, Docker services, backup upload/download/restore | Split beginner-friendly pages while preserving all actions | Partial | Needed |
| `PlayersTab` | Players / Admin Tools / Inventory | Partial player list/action wrappers | Player DB modules and RMQ/CLI actions | Full player profile drawer and action dialogs | Partial | Needed |
| `DatabaseTab` | Database / Advanced SQL Console | Partial table wrappers | DB browser, SQL safety, export | Full browser/search/console/export UI | Partial | Needed |
| `LogsTab` | Logs | Partial stream | Dynamic services, raw confirm, cheat/admin logs | Viewer with pause/search/download | Partial | Needed |
| `LiveMapTab` | Live Map | Missing | Marker/player/base/map state | Map overlays and safe map controls | Not Implemented | Needed |
| `StorageTab` | Storage | Missing | Storage DB logic | Storage browser/actions | Not Implemented | Needed |
| `BlueprintsTab` | Blueprints | Missing | Blueprint import/export | Blueprint UI | Not Implemented | Needed |
| `BasesTab` | Bases | Missing | Base query/export | Bases UI | Not Implemented | Needed |
| `MarketTab` | Market / Market Automation | Missing | Market DB and optional bot | Market views and bot controls | Not Implemented | Needed |
| `WelcomePackageTab` | Starter Kit | Missing | Welcome package config/grants | Starter Kit UI | Not Implemented | Needed |
| Server Settings tab | Server Settings | Missing | RedBlink settings provider | Settings editor and raw advanced edit | Not Implemented | Needed |

## RedBlink CLI Coverage Inventory

| RedBlink command family | Useful for web feature groups | Coverage notes |
|---|---|---|
| `dune status`, `version`, `doctor`, `ready`, `ports`, `ps`, `servers` | Home, Server Control, Services, Live Map | Good operational base; needs structured parsing and Docker inspect enrichment. |
| `dune start`, `stop`, `restart <service>` | Server Control | Good base; long-running calls must be background tasks. |
| `dune logs <service> [--raw]` | Logs | Good base; service allowlist and dynamic discovery required. |
| `dune update`, `dune self-update`, `dune update auto`, `dune restart-schedule` | Updates, scheduled restart | Good base; release listing and auto status need endpoint wrappers. |
| `dune db ...` | Backups, restore, transfer | Good base; upload/download/delete and strong confirmation needed. |
| `dune database ...` | Database browser | Good base; SQL/export safety layer needed. |
| `dune admin players`, `--online`, item, XP, water, kick, skill, teleport, vehicle, specialization, history | Players/Admin Tools | Good base for live actions; missing many web admin DB/RMQ features. |
| `dune maps`, `sietches`, `deepdesert`, `autoscaler`, `spawn`, `despawn` | Maps, Sietches, Live Map | Good base; needs safe web wrappers and state visualization. |
| `dune config`, `memory` | Server Settings | Useful but not enough; raw config parsing required. |

## Phase 1 Scope Boundary

Phase 1 is not feature parity. It is the foundation required to implement parity safely:

- Keep/rescue auth, secure session cookie, CSRF, task manager, audit log, safe command runner, secret redaction.
- Remove or quarantine UI controls that call placeholder `501` endpoints.
- Add route inventory docs and status tracking.
- Add RedBlink runtime detection, Docker/DB/RMQ discovery scaffolding with real status checks.
- Add tests for runner allowlist, service validation, path validation, redaction, auth/CSRF, task lifecycle, and DB discovery.

No page or route will be marked Done until it satisfies the acceptance rule in `docs/web-feature-parity-status.md`.
