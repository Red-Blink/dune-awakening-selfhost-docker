# Web Testing

This document tracks how to verify the RedBlink web admin while feature parity is built.

## Automated Test Requirements

Backend tests must cover:

- command allowlist
- service validation
- path validation
- secret redaction
- auth middleware
- CSRF protection for state-changing requests
- task lifecycle
- task log streaming redaction
- Docker status parsing
- database connection discovery
- backup/restore task creation
- admin command wrappers
- SQL destructive detection
- direct DB mutation capability/ownership checks
- RabbitMQ broadcast payload validation
- map/sietch/deepdesert CLI argument validation
- Live Map marker query validation
- market query builder validation
- Starter Kit config/manual grant validation
- blueprint/base export and blocked import payload validation
- secure cookie configuration
- JSON body size limits and static path safety

Frontend tests must cover:

- API client request/response handling
- critical pages render
- setup wizard state
- player/admin action forms
- dangerous confirmation dialogs
- log viewer redaction/search/pause behavior

There is no dedicated frontend test harness in the repo yet. Phase 6 keeps frontend verification to `npm run build`; adding Vitest/Playwright coverage is a future task and should be done deliberately rather than bolted on during hardening.

## Current Verification

Current verification:

- `npm test` in `admin-server/` passes.
- `npm run build` in `web/` passes.
- Backend tests currently cover signed sessions, secure-cookie configuration, CSRF rejection/acceptance, service validation, command allowlist, lifecycle/status/doctor mappings, logs command validation, noninteractive update flags, backup restore/delete name validation, admin catalog validation, item/item-id/template grant validation, XP/quantity/durability bounds, skill point/module validation, teleport/vehicle argument validation, map mode/spawn/despawn/autoscaler/memory/sietch/deepdesert validation, SQL read-only/destructive detection, direct DB config discovery, identifier validation, table preview query building, player search parameterization, Live Map marker parameterization and unsupported capability responses, direct currency and faction mutation query behavior, direct inventory delete ownership validation, storage give-item validation/insert query behavior, market query validation, blueprint/base read-only export validation, blueprint/base blocked import payload validation, Starter Kit config validation, RabbitMQ broadcast/shutdown payload validation and publish label validation, task creation/completion, and secret redaction.
- Phase 5B2 verification on this pass: `npm test` in `admin-server/` passed and `npm run build` in `web/` passed. No live market write, live Starter Kit grant, blueprint/base import/delete, or whisper publish was run in automated verification.
- Phase 6 verification should run `npm test` in `admin-server/`, `npm run build` in `web/`, and `git diff --check`.
- Phase 5B1 verification on the previous pass: `npm test` in `admin-server/` passed, `npm run build` in `web/` passed, and `git diff --check` passed. No live map mutation, live DB write, or live RabbitMQ broadcast was executed from the web during automated verification.
- Phase 3 live read-only DB smoke check connected to `127.0.0.1:15432` as `dune`, detected 179 Dune tables, listed 1 player, and verified storage/base/blueprint list queries plus actor `82` inventory/currency/faction/spec reads. No writes were run.
- `docker compose -f docker-compose.web.yml config` passed previously.
- HTTP bind smoke test could not run inside the sandbox because binding returned `EPERM`.


## Manual Verification Pattern

For every feature promoted to Done, add a note with:

- web page/component used
- API endpoint called
- RedBlink command, SQL, Docker, or RabbitMQ operation executed
- whether a backup was created
- confirmation prompt used for destructive actions
- expected output or state change

## Optional Live Smoke Checks

Do not run destructive checks by default. On a live admin host, verify Phase 5B2 with authenticated web/API calls or the matching UI pages:

- status: load Home and Server Control, then run `GET /api/server/status`
- DB connect: load Database, then `GET /api/database/status`
- players list and inventory read: load Players, select a player, open inventory
- market read: load Market items/listings/stats and confirm data or a clear missing-table capability reason
- Starter Kit dry/manual review: load Starter Kit config/history; do not click Grant unless intentionally testing a live player grant
- blueprint export: load Blueprints and download one full JSON export where schema supports it
- base export: load Bases and download one base-as-blueprint JSON export where schema supports it
- broadcast: use Admin Tools broadcast only with a safe test message and only on a test server; record RabbitMQ publish separately from actual in-game visibility because Phase 8 live testing saw publish success without visible delivery
- command history: after broadcast/shutdown/whisper tests, refresh Admin Tools command history and confirm a safe `web-broadcast`, `web-shutdown-broadcast`, or `web-whisper` row appears
- whisper: confirm `/api/admin/whisper` returns unsupported until GM courier identity/routing is configured

For the full checklist, use `docs/web-smoke-checklist.md`.

## Mock Mode

Mock mode is allowed only for UI development. It must be clearly separated from real mode and must not be used as evidence that a feature is Done.
