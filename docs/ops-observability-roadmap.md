# Dune Ops Observability Roadmap

## 1. Purpose

This roadmap defines the staged delivery plan for Dune Ops Observability across Core bridge capabilities, database telemetry, standard operations metrics, addon UI, and end-to-end validation.

The project will follow these principles:

* **Secure by default:** no raw player, account, identity, coordinate, SQL, PromQL, token, password, or row-level data leaves Core.
* **Aggregate-only telemetry:** player and server data exposed through addon bridge actions must be summarized, counted, or grouped by low-cardinality operational states.
* **Permission-gated access:** all telemetry bridge actions require explicit addon permission approval.
* **Same-origin browser behavior:** addon UI must use the active Console origin and must not hardcode localhost, public IPs, LAN IPs, or DNS names.
* **Evidence-driven releases:** no release phase is considered complete without repeatable CLI, WebUI, security, and failure-mode evidence.
* **Industry-aligned SDLC:** release gates map to secure SDLC, application security verification, observability, and supply-chain integrity practices.

## 2. Standards Alignment

This roadmap uses the following industry standards and practices as reference models:

| Area                    | Standard / Practice     | Application to This Project                                                                                                                                                                                                                                                                                      |
| ----------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secure SDLC             | NIST SSDF               | Use security requirements, threat review, safe implementation, and verification gates before release. NIST describes SSDF as a core set of secure software development practices intended to reduce vulnerabilities and address root causes.                                                                     |
| Application Security    | OWASP ASVS              | Use explicit verification requirements for authentication, authorization, input handling, secure configuration, logging, and data protection. OWASP ASVS provides a basis for testing web application technical security controls and secure development requirements.                                           |
| Observability           | OpenTelemetry concepts  | Model telemetry as stable, low-cardinality metrics/log-derived signals, with clear separation between metrics, logs, traces, resources, attributes, and exporters. OpenTelemetry documents observability concepts and telemetry categories including metrics, logs, traces, resources, and semantic conventions. |
| Supply Chain Integrity  | SLSA                    | Track build/release provenance, branch state, reviewed changes, and artifact integrity where practical. SLSA is described as an incrementally adoptable set of supply-chain security guidelines with a common vocabulary and checklist for improving software security.                                          |
| Privacy by Design       | Internal policy gate    | Expose only minimum necessary telemetry, prohibit identity-bearing fields, and add automated forbidden-field checks to every E2E suite.                                                                                                                                                                          |
| Reliability Engineering | Release-readiness gates | Every phase must define health checks, failure-mode behavior, rollback criteria, and evidence artifacts.                                                                                                                                                                                                         |

## 3. Release Model

Each roadmap phase must pass four release gates before it can be considered complete.

### Gate A — Design Gate

Required before implementation.

Acceptance criteria:

* Scope is written.
* Data sources are identified.
* Security/privacy classification is complete.
* Bridge/API contract is defined.
* Rollback behavior is documented.
* E2E evidence plan is documented.
* No raw sensitive fields are proposed.

### Gate B — Implementation Gate

Required before PR review.

Acceptance criteria:

* Code compiles.
* Unit tests pass.
* Permission checks are enforced.
* Input validation is present.
* Missing-table/missing-column conditions are handled.
* No hardcoded public/local endpoints exist in browser-side code.
* Output schema is stable and documented.

### Gate C — Verification Gate

Required before merge.

Acceptance criteria:

* Target.

### Gate C — Verification Gate

Required before merge.

Acceptance criteria:

* Targeted unit tests pass.
* Source gate passes.
* Local CLI E2E passes.
* Public-origin CLI E2E passes where applicable.
* WebUI E2E passes where applicable.
* Privacy regression scan passes.
* Failure-mode E2E passes for expected degraded states.
* Changed-file scope matches the intended PR boundary.

### Gate D — Release Gate

Required before marking the phase released.

Acceptance criteria:

* PR merged or release artifact published.
* Evidence bundle saved.
* Known limitations documented.
* Rollback instructions documented.
* Release notes written.
* Follow-up issues opened for deferred work.
* No critical or high-severity security issue remains unresolved.

## 4. Current State

### Phase 0 — Core OPS Health Bridge Foundation

Status: **In review**

PR: `Red-Blink/dune-awakening-selfhost-docker#49`

Delivered:

* `ops:read` addon permission.
* `ops.health.summary` bridge action.
* Permission-gated Core addon bridge.
* Aggregate-only operational health summary.
* Unit tests for aggregate-only behavior and optional schema handling.
* Local CLI E2E validation.
* Public-origin CLI E2E validation.
* Public WebUI validation.
* Same-origin addon behavior validation.

Current response boundary:

* server farm totals
* farm ready/alive counts
* server connection totals
* player total
* connected player count
* grouped online status counts
* grouped life state counts
* grouped character state counts

Current hard exclusions:

* raw database rows
* player identifiers
* account identifiers
* character names
* Funcom/FLS identifiers
* actor IDs
* player IDs
* coordinates or locations
* SQL
* PromQL
* secrets, tokens, or passwords

Phase 0 release gate:

| Gate                | Status        |
| ------------------- | ------------- |
| Design Gate         | Passed        |
| Implementation Gate | Passed        |
| Verification Gate   | Passed        |
| Release Gate        | Pending merge |

## 5. Roadmap Phases

---

# Phase 1 — Telemetry Discovery and Classification

## Objective

Inventory all telemetry available from Dune runtime databases and classify each field before exposing any additional metric through Core.

## Deliverables

* `db-schema-inventory.json`
* `db-telemetry-catalog.md`
* `safe-query-candidates.sql`
* `forbidden-field-report.txt`
* `telemetry-classification.md`

## Scope

Discovery must capture:

* database files
* tables
* columns
* column types
* indexes
* row counts
* nullable columns
* low-cardinality candidates
* sensitive-field candidates
* safe aggregate query candidates

## Classification Categories

| Classification      | Meaning                                                               | Exposure Rule                |
| ------------------- | --------------------------------------------------------------------- | ---------------------------- |
| Safe aggregate      | Count/group/status field with no identity or location                 | May expose after review      |
| Sensitive aggregate | Useful but potentially revealing if grouped too narrowly              | Requires explicit review     |
| Unsafe raw data     | Identifier, coordinate, name, token, secret, raw row, serialized blob | Never expose                 |
| Unknown             | Meaning unclear                                                       | Do not expose until reviewed |
| Not useful          | No operational value                                                  | Do not expose                |

## Release Gates

### Design Gate

* Table and column discovery approach documented.
* Read-only DB access confirmed.
* Classification rubric approved.
* Forbidden-field list approved.
* Evidence artifact paths defined.

### Implementation Gate

* Discovery script is read-only.
* Script does not emit raw player rows.
* Script flags sensitive names, identifiers, coordinates, and serialized blobs.
* Script generates machine-readable and human-readable output.
* Script handles missing DB files gracefully.

### Verification Gate

* Runs against E2E runtime DB.
* Produces all expected artifacts.
* Emits no raw player identity data.
* Emits no raw coordinate data.
* Emits no secrets or tokens.
* Output is deterministic enough for review.

### Release Gate

* Telemetry catalog reviewed.
* Safe query candidates approved.
* Unsafe fields documented.
* Follow-up implementation issues created.

## Exit Criteria

Phase 1 is complete only when every discovered DB table/column is classified or marked unknown, and no unknown field is used in a bridge response.

---

# Phase 2 — Expanded Aggregate DB Metrics

## Objective

Convert approved safe DB telemetry into stable Core bridge actions.

## Proposed Bridge Actions

### `ops.health.summary`

Top-level dashboard summary.

Must remain fast, stable, and safe.

### `ops.health.server`

Aggregate server and farm state.

Candidate fields:

* farms total
* farms ready
* farms alive
* farms degraded
* farm variable health
* incoming connection totals
* outgoing connection totals

### `ops.health.players`

Aggregate player state only.

Candidate fields:

* player total
* connected count
* online status distribution
* life state distribution
* character state distribution
* encrypted player state availability count

No player list.

### `ops.health.storage`

Database and schema health.

Candidate fields:

* known DB count
* readable DB count
* missing DB count
* expected table presence
* missing table list
* row counts per approved table
* schema capability flags

### `ops.health.capabilities`

Feature detection endpoint.

Candidate fields:

* bridge version
* supported actions
* known table availability
* known column availability
* privacy profile version

## Release Gates

### Design Gate

* Action contracts written.
* JSON schemas drafted.
* Permission model confirmed.
* Metric naming reviewed.
* Privacy boundary reviewed.
* Expected degraded states defined.

### Implementation Gate

* All actions require `ops:read`.
* All queries are aggregate-only.
* All table/column access is guarded.
* Missing DB/table/column returns degraded capability state, not a crash.
* Unit tests cover present, missing, and empty datasets.

### Verification Gate

* Unit tests pass.
* Local CLI E2E passes.
* Public-origin CLI E2E passes.
* Privacy scan passes against every bridge response.
* Missing-table E2E passes.
* Missing-column E2E passes.
* Empty-DB E2E passes.
* Unauthorized request fails.
* Bad CSRF request fails.
* Addon without `ops:read` fails.

### Release Gate

* API contract documented.
* Addon compatibility note written.
* Evidence bundle saved.
* Follow-up dashboard tasks opened.

## Exit Criteria

Phase 2 is complete when all approved aggregate DB metrics are available through permission-gated Core bridge actions and every response passes privacy regression scanning.

---

# Phase 3 — Standard Runtime / Ops Metrics

## Objective

Add non-game operational metrics for host, container, runtime, network, and logs.

## Metric Groups

### Container Health

* container running state
* restart count
* uptime
* healthcheck status
* image tag/digest
* exposed ports
* mount correctness

### Docker Compose Health

* expected services present
* expected services running
* unexpected orphan services
* compose project name
* published port mappings
* network attachments
* volume mounts

### Host Resource Health

* CPU load
* memory usage
* disk usage
* disk free
* inode usage
* swap usage
* filesystem read-only state

### Process Health

* server process present
* console process present
* process uptime
* listening ports
* restart indicators

### Network Health

* local Console health endpoint reachable
* public Console health endpoint reachable
* health endpoint latency
* HTTP status
* reverse proxy/TLS state where applicable
* port binding correctness

### Log-Derived Health

Aggregate counts only:

* error count by severity
* warning count
* last error timestamp
* last warning timestamp
* known fatal pattern count
* restart/crash pattern count
* auth failure count
* addon bridge failure count

Raw logs must not be exposed by default.

## Release Gates

### Design Gate

* Runtime data source approved.
* Least-privilege access plan documented.
* Host visibility risk reviewed.
* Log redaction policy written.
* Metric cardinality rules written.

### Implementation Gate

* Runtime metrics collector is read-only.
* Log metrics are aggregate-only.
* No raw log lines returned by default.
* Sensitive environment variables are excluded.
* Mount/port checks are normalized and stable.
* Host access failures degrade gracefully.

### Verification Gate

* Runtime metrics E2E passes.
* Container stopped failure-mode E2E passes.
* Public port unavailable E2E passes.
* Missing Docker socket or restricted host access degrades safely.
* Log privacy scan passes.
* No secrets or env vars exposed.

### Release Gate

* Runtime metrics documented.
* Security caveats documented.
* Rollback instructions provided.
* Addon UI tasks updated.

## Exit Criteria

Phase 3 is complete when standard runtime metrics are available without exposing raw logs, secrets, host-sensitive internals, or unbounded high-cardinality labels.

---

# Phase 4 — Unified Telemetry Contract

## Objective

Create a stable response model across DB and runtime telemetry.

## Target Shape

```json
{
  "ok": true,
  "generatedAt": "2026-07-02T00:00:00.000Z",
  "supported": true,
  "source": {
    "kind": "core-addon-bridge",
    "version": 1
  },
  "health": {
    "status": "healthy",
    "score": 100,
    "reasons": []
  },
  "server": {},
  "players": {},
  "storage": {},
  "runtime": {},
  "warnings": [],
  "errors": []
}
```

## Health Status Enum

* `healthy`
* `degraded`
* `critical`
* `unknown`
* `unsupported`

## Severity Enum

* `info`
* `warning`
* `error`
* `critical`

## Metric Naming Rules

Use stable, low-cardinality names:

* `server.farms.total`
* `server.farms.ready`
* `server.farms.alive`
* `players.total`
* `players.connected`
* `storage.databases.readable`
* `runtime.containers.running`
* `runtime.disk.freeBytes`
* `logs.errors.count`

Do not use labels containing:

* player ID
* account ID
* character name
* actor ID
* coordinate
* raw path
* raw query
* raw log line
* token
* secret

## Release Gates

### Design Gate

* Unified schema written.
* Versioning rules written.
* Backward compatibility rules written.
* Deprecation rules written.
* Error model written.

### Implementation Gate

* All bridge actions return consistent metadata.
* All warnings/errors follow common shape.
* Health score calculation is deterministic.
* Unknown/degraded states are explicit.
* Schema snapshots are added to tests.

### Verification Gate

* Schema validation passes.
* Backward compatibility test passes.
* Degraded-state test passes.
* Unsupported-state test passes.
* Privacy scan passes.

### Release Gate

* Contract documentation published.
* Addon dashboard updated to contract.
* Release note identifies schema version.

## Exit Criteria

Phase 4 is complete when all telemetry actions share the same envelope, health semantics, and privacy enforcement.

---

# Phase 5 — Addon Dashboard MVP

## Objective

Build the first production-quality Dune Ops Observability dashboard against stable Core bridge actions.

## Dashboard Sections

### Overview

* overall health status
* generated timestamp
* server status
* player population
* DB/storage status
* runtime status
* active warnings/errors

### Server

* farm counts
* ready/alive status
* connection totals
* degradation reasons

### Players

Aggregate only:

* total players
* connected players
* online status distribution
* life state distribution
* character state distribution

No player list.

### Storage

* database readability
* expected table presence
* missing tables
* row count health
* schema capability flags

### Runtime

* container state
* restart count
* uptime
* mount correctness
* port status
* disk/memory/cpu summary

### Alerts

* critical conditions
* degraded conditions
* warning conditions
* last detected time
* recommended operator action

## Release Gates

### Design Gate

* UI wireframe completed.
* Same-origin route behavior documented.
* Empty/loading/error states defined.
* Accessibility baseline defined.
* No raw data display areas proposed.

### Implementation Gate

* Same-origin bridge client implemented.
* No hardcoded endpoint scan passes.
* Loading/error/degraded states implemented.
* Refresh behavior implemented.
* No player list or raw logs added.

### Verification Gate

* Local WebUI E2E passes.
* Public WebUI E2E passes.
* Same-origin validation passes.
* Browser console has no fatal errors.
* Addon iframe/content route works.
* Privacy scan passes against rendered payload.

### Release Gate

* Screenshots captured.
* Operator usage notes written.
* Known limitations documented.
* Addon version tagged.

## Exit Criteria

Phase 5 is complete when the addon dashboard renders all approved bridge telemetry from local and public Console origins without hardcoded endpoints or raw sensitive data.

---

# Phase 6 — Full Observability and Operator Workflow

## Objective

Move from telemetry display to actionable operations.

## Features

* health score trends
* warning history
* degraded condition explanations
* recommended remediation
* evidence bundle export
* release validation report
* operator checklist
* optional retention of aggregate snapshots

## Release Gates

### Design Gate

* Snapshot retention rules written.
* Data minimization review completed.
* Operator workflows documented.
* Export format documented.

### Implementation Gate

* Snapshots are aggregate-only.
* Exports exclude raw logs and player data.
* Retention is bounded.
* Operator recommendations are deterministic and explainable.

### Verification Gate

* Snapshot E2E passes.
* Export E2E passes.
* Retention cleanup E2E passes.
* Privacy scan passes on stored/exported artifacts.

### Release Gate

* Operator documentation published.
* Support/troubleshooting notes written.
* Release marked stable.

## Exit Criteria

Phase 6 is complete when the dashboard supports reliable operator triage without requiring direct DB access, shell access, or raw logs for normal health assessment.

---

## 6. Required E2E Suites

Every phase must add or update E2E coverage.

### Core Bridge E2E

Validates:

* auth required
* CSRF required
* `ops:read` required
* bridge action works
* aggregate-only result
* no forbidden fields
* missing tables handled
* missing columns handled
* empty DB handled

### Public-Origin Browser E2E

Validates:

* public URL works
* same-origin fetch works
* addon iframe works
* no hardcoded localhost
* no hardcoded public IP
* auth flow works
* bridge result renders

### Runtime Ops E2E

Validates:

* container mount correctness
* published ports
* health endpoint
* service status
* disk/memory collection
* log aggregation

### Privacy Regression E2E

Every serialized response and rendered payload must be scanned for:

* `player_controller_id`
* `account_id`
* `character_name`
* `funcom_id`
* `fls_id`
* `actor_id`
* `player_id`
* `x_coord`
* `y_coord`
* `z_coord`
* `location`
* `position`
* `rows`
* `select`
* `promql`
* `password`
* `token`

### Failure-Mode E2E

Simulate:

* missing DB file
* missing table
* missing column
* empty table
* addon lacks `ops:read`
* unauthenticated request
* bad CSRF token
* container stopped
* public port unavailable
* missing Docker/host access
* unreadable logs

## 7. PR Sequencing

### PR 1 — Core Bridge Foundation

Status: **Open**

Scope:

* `ops:read`
* `ops.health.summary`
* aggregate DB health
* tests

### PR 2 — Telemetry Discovery Tooling

Scope:

* DB schema inventory script
* telemetry catalog generator
* forbidden-field report
* safe query candidate output
* no runtime bridge expansion yet

### PR 3 — Expanded DB Telemetry Bridge Actions

Scope:

* `ops.health.server`
* `ops.health.players`
* `ops.health.storage`
* `ops.health.capabilities`
* schema tests
* privacy E2E

### PR 4 — Runtime Ops Metrics Bridge

Scope:

* container status
* mount status
* port status
* host resource summary
* log-derived aggregate counts
* runtime failure-mode E2E

### PR 5 — Addon Dashboard MVP

Scope:

* overview dashboard
* same-origin bridge client
* server/player/storage cards
* alert panel
* public-origin WebUI E2E

### PR 6 — Full Operator Workflow

Scope:

* trend snapshots
* evidence bundle export
* operator recommendations
* bounded retention
* stable release documentation

## 8. Global Release Gates

No PR should be marked ready unless all applicable checks pass.

### Required Checks

* branch current with upstream
* changed-file scope verified
* unit tests pass
* targeted tests pass
* local CLI E2E passes
* public-origin CLI E2E passes where applicable
* WebUI E2E passes where applicable
* privacy regression scan passes
* failure-mode E2E passes
* no hardcoded endpoint scan passes
* documentation updated
* rollback path documented

### Required Evidence

Evidence should be saved under:

```text
~/dune-work/evidence/ops-observability/<phase-or-pr-name>/
```

Each evidence bundle should contain:

* command log
* git state
* changed-file list
* test output
* E2E output
* WebUI validation notes
* privacy scan output
* failure-mode output
* known limitations

## 9. Non-Negotiable Security Rules

The following must never be exposed through addon bridge responses, dashboard UI, evidence bundles, or exported reports:

* raw player rows
* player IDs
* account IDs
* character names
* Funcom/FLS identifiers
* actor IDs
* coordinates
* exact positions
* raw serialized blobs
* SQL text
* PromQL text
* tokens
* passwords
* secrets
* raw logs by default
* unbounded high-cardinality labels

## 10. Decision Log

| Decision                                          | Rationale                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| Use Core bridge instead of direct addon DB access | Keeps local DB/runtime access controlled and permission-gated.              |
| Use aggregate-only DB telemetry                   | Prevents player identity and location exposure.                             |
| Separate DB metrics from runtime ops metrics      | Different data sources, risk profiles, and failure modes.                   |
| Use same-origin browser behavior                  | Prevents localhost/public-IP regressions and supports reverse proxy access. |
| Add privacy regression scanning to every phase    | Prevents accidental sensitive-field leakage.                                |
| Build telemetry catalog before expanding metrics  | Avoids exposing unknown or unsafe DB fields.                                |
| Require release gates for every PR                | Keeps development evidence-driven and reviewable.                           |

## 11. Immediate Next Actions

1. Keep PR #49 focused on Core bridge foundation.
2. Create PR #50 or equivalent for telemetry discovery tooling.
3. Generate the DB schema inventory and telemetry catalog from the E2E runtime.
4. Classify every discovered table/column before adding new bridge actions.
5. Expand bridge actions only after safe aggregate metrics are approved.
6. Build the addon dashboard after the bridge contract stabilizes.

## 12. Definition of Done

The roadmap is complete when:

* all approved DB telemetry is cataloged and classified;
* all safe metrics are exposed through permission-gated bridge actions;
* standard runtime ops metrics are available without raw logs or secrets;
* addon UI renders telemetry through same-origin bridge calls;
* local and public E2E suites pass;
* privacy regression scans pass for every response and export;
* release evidence is captured for every phase;
* operator documentation exists for deployment, troubleshooting, rollback, and validation.
