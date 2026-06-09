# Arrakis Server Console Productization Plan

This plan keeps Arrakis Server Console moving toward a friendly web admin panel while avoiding unsafe or speculative feature work. Each phase should preserve existing working admin actions, hide raw CLI/JSON behind advanced troubleshooting controls, and keep unsupported features clearly marked.

## Phase 12A: UI Presentation Cleanup and Low-Risk UX Fixes

Goal: remove the remaining "CLI wrapper" feel from normal workflows without changing command behavior.

- Home: structured identity and health cards, better population/listener parsing, responsive layout, raw status/readiness only in collapsed advanced diagnostics.
- Setup: better spacing and a structured Review step with identity, network, auth/token, maps/services, and warnings.
- Server Control: friendly service restart selector, grouped readiness checks, friendly port/listener rows, clearer doctor warnings, less visible technical output.
- Services: friendly service names and compact side-by-side actions.
- Players: structured player summary and capability badges only by default, raw profile data collapsed.
- Admin Tools: player selector, structured catalog/history displays, less cramped global tools. Keep broadcast experimental.
- Live Map: friendlier marker labels and Hagga Basin map background; marker placement remains approximate until coordinate calibration is verified.
- Logs: friendly service names and remove redundant free-text service field.
- Settings: structured runtime/file checklist only by default.

## Phase 12B: Server Control Improvements, Scheduled Restarts, Server Title Update, Redeploy Flow

Goal: add operational controls only where existing RedBlink manager behavior is clear and testable.

- Inspect `runtime/scripts/dune`, `runtime/scripts/manager.sh`, setup scripts, and compose behavior.
- Scheduled restarts: implemented through `dune restart-schedule status|enable|disable`. The web UI saves the manager preference, validates a daily HH:MM local server time, and reports whether the systemd timer is installed.
- Server title update: implement only if the stack has a safe config write/apply path and restart requirements are explicit.
- Redeploy: implement only if existing CLI provides a safe redeploy/update command. Otherwise link users to Setup/Updates and document the intended flow.
- Add audit events and confirmations for any disruptive action.

## Phase 12C: Admin Tools and Starter Kit Interactive Selectors

Goal: replace free-text workflows with selectors and structured result tables.

- Admin player selector from Players API using character name, online status, DB actor ID, and Admin action ID.
- Item selector/search from the structured `runtime/data/admin-items.json` catalog endpoint with category/template display. Normal user flows must select an actual catalog row, not arbitrary text.
- Structured command history table.
- Starter Kit item picker/table with quantity and durability/quality controls, plus collapsed manual/raw override.
- Specialization XP and faction unlock flow only after verifying exact RedBlink admin tooling or DB/RMQ semantics.

## Phase 12D: Live Map and Maps/UserEngine/UserGame Configuration

Goal: make map operations understandable without exposing raw command text.

- Live Map: complete coordinate calibration for the Hagga Basin background image before presenting marker placement as exact.
- Friendly marker names for vehicles/classes; raw class paths only in details/tooltips.
- Maps page: map table and edit panel for mode, memory, name/password, and safe per-map settings.
- Inspect manager support for global UserEngine, per-map UserGame overrides, memory defaults, second map/survival support, and revert-to-default flows.
- UserEngine/UserGame read-only previews are exposed through `runtime/scripts/usersettings.py engine-values`, `map-values`, and `partition-values`. Write/reset controls remain disabled because `usersettings.py` can write config/runtime files directly but does not create backups or preview restart impact for the web UI.
- Phase 12 follow-up exposes a calmer Maps page: dynamic map list first, selected-map edit panel second, and no dumped all-at-once panels. Memory set remains active only through the existing validated `dune memory set` route. Current configured memory is shown from `dune memory status`. Survival dimension/name/password controls, Deep Desert dual-desert writes, UserEngine/UserGame writes, live Docker memory usage, restore memory defaults, and revert UserSettings remain planned because they need restart-impact previews, confirmation design, audit logging, and rollback behavior.

## Phase 12E: Backups Automation, Remote SSH Import, Character Transfer/Account Takeover Analysis

Goal: improve backup UX while keeping destructive DB operations safe.

- Backups table with row-level restore/delete and automatic initial load.
- Auto-backup settings are implemented through `dune db auto status|enable|disable`. The web UI validates interval/retention and reports when host/systemd permissions prevent timer installation.
- Remote SSH import remains disabled. The manager flow is interactive (`ssh`/`scp` host, user, port, path prompts), so the web wrapper still needs key-only credential selection, remote preview, no secret logging, progress reporting, and audit logging.
- Character transfer/account takeover: analyze schema, ownership, account identity, and recovery risks before implementation. Keep blocked until backup, preview, transaction, and rollback requirements are defined.

## Phase 12F: Updates Dashboard, Auto Game Updates, Stack Rollback

Goal: make update state visible and safe.

- Auto-load game and stack update checks into status cards.
- Expose update buttons only when an update is available or when a manual re-check is requested.
- Auto game updates are implemented through `dune update auto status|enable|disable`. The web UI validates `HH:MM:SS`, requires `SAVE AUTO GAME UPDATES`, and reports timer state.
- Previous stack release listing is implemented through `dune self-update list`; restore uses `dune self-update install previous` and requires `RESTORE PREVIOUS STACK`.

## Phase 12G: Remaining Player/Admin Features

Goal: close remaining parity gaps without guessing.

- Faction unlock and specialization XP progression flow after verified CLI/DB/RMQ path.
- Progression/events/stats/history mappings after schema confirmation.
- Whisper only after GM/courier identity and recipient routing are verified.
- Shutdown broadcast only after non-destructive envelope verification and explicit safety design.
- Blueprint/base import/delete/clone only after full object graph, ownership, ID remapping, backup, and transaction behavior are verified.

## Current Implementation Notes

- Broadcast remains Partial/Experimental: RabbitMQ publish and history logging are verified, but in-game display is not working/verified.
- Starter Kit auto-grant is partial: it runs as a web-admin scanner, not a standalone durable service.
- Market automation remains blocked until a RedBlink-compatible market automation runtime exists.
- Live Map includes the Hagga Basin background, but marker placement is still approximate because the exact world-coordinate transform is not verified.
- Phase 12A2 completed low-risk selector/table cleanup for Home, Setup, Server Control, Services, Players, Admin Tools, Live Map, Starter Kit, Backups, Logs, Updates, and Settings. Remaining 12B-12F backend-heavy items are intentionally deferred until CLI behavior and safety requirements are verified.
- Phase 12A corrective follow-up replaced loose status/readiness/ports/item parsing with stricter parser behavior and a structured item catalog endpoint. Deferred work remains focused on deeper manager-backed features, not parser guesswork.
- Phase 12 manager feature pass added web controls for automatic database backup settings, scheduled restart settings, automatic game update settings, previous stack release listing/restore, configured map memory display, and read-only UserEngine/UserGame previews. Remote SSH backup import and UserEngine/UserGame writes remain disabled for exact safety reasons listed above.
