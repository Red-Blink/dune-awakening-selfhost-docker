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

Frontend tests must cover:

- API client request/response handling
- critical pages render
- setup wizard state
- player/admin action forms
- dangerous confirmation dialogs
- log viewer redaction/search/pause behavior

## Current Verification

Current verification:

- `npm test` in `admin-server/` passes.
- `npm run build` in `web/` passes.
- Backend tests currently cover signed sessions, CSRF rejection/acceptance, service validation, command allowlist, lifecycle/status/doctor mappings, logs command validation, noninteractive update flags, backup restore/delete name validation, admin catalog validation, item/item-id/template grant validation, XP/quantity/durability bounds, skill point/module validation, teleport/vehicle argument validation, map mode/spawn/despawn/autoscaler/memory/sietch/deepdesert validation, SQL read-only/destructive detection, direct DB config discovery, identifier validation, table preview query building, player search parameterization, Live Map marker parameterization and unsupported capability responses, direct currency and faction mutation query behavior, direct inventory delete ownership validation, storage give-item validation/insert query behavior, RabbitMQ broadcast/shutdown payload validation, task creation/completion, and secret redaction.
- Phase 5B1 verification on this pass: `npm test` in `admin-server/` passed, `npm run build` in `web/` passed, and `git diff --check` passed. No live map mutation, live DB write, or live RabbitMQ broadcast was executed from the web during automated verification.
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

## Mock Mode

Mock mode is allowed only for UI development. It must be clearly separated from real mode and must not be used as evidence that a feature is Done.
