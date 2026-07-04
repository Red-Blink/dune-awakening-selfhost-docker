# Dune Discord Companion Bot - Project Status

## Current Status

The Discord companion bot is in an experimental read-only integration phase.

The current implementation includes a dependency-free Discord runtime, guild slash-command registration, Gateway interaction handling, and protected Console adapter calls without enabling any write, destructive, database mutation, Docker control, or addon mutation behavior.

## Completed

| Area | Status | Evidence |
|---|---|---|
| Isolated bot workspace | Complete | `discord-bot/` |
| Protected Console adapter scaffold | Complete | `console/api/src/integrations/discord/` |
| Bot API token auth | Complete | Adapter route tests |
| Discord actor authorization | Complete | Policy and route tests |
| Discord runtime client | Complete | `discord-bot/scripts/discord-runtime.mjs` |
| Guild slash-command registration | Complete | `discord-bot/scripts/discord-runtime.mjs` |
| Interaction handler | Complete | `discord-bot/scripts/discord-runtime.mjs` |
| Public redacted status | Complete | Status provider tests |
| Detailed redacted status | Complete | Admin-only diagnostic tests |
| Readiness route | Complete | Adapter and provider tests |
| Services route | Complete | Adapter and provider tests |
| Bot command smoke runner | Complete | `discord-bot/scripts/command-smoke.mjs` |
| No-write bot capability model | Complete | `discord-bot/src/security/authorization.ts` |
| Secret scanning | Complete | `discord-bot/scripts/check-secrets.mjs` |
| Semgrep SAST workflow | Complete | `.github/workflows/semgrep-sast.yml` |
| Trivy vulnerability workflow | Complete | `.github/workflows/trivy-vulnerability-scan.yml` |
| CVSS vulnerability report generator | Complete | `scripts/generate-vulnerability-report.mjs` |
| Repository-local STRIDE scanner | Complete | `scripts/generate-stride-report.mjs` |
| Repository-local SBOM generator | Complete | `scripts/generate-sbom.mjs` |
| SOC 2 readiness matrix | Complete | `docs/discord-control-bot/soc2-control-matrix.md` |
| Scheduled SOC 2 readiness check | Complete | `.github/workflows/soc2-readiness-check.yml` |

## Current Live Routes

| Route | Role Requirement | Purpose | Write Capable |
|---|---:|---|---:|
| `GET /api/integrations/discord/health` | Bot API token | Adapter health and role-policy status | No |
| `POST /api/integrations/discord/status` | Public for normal mode; Admin for diagnostic mode | Public redacted status or detailed redacted status | No |
| `POST /api/integrations/discord/readiness` | Observer | Server readiness summary | No |
| `POST /api/integrations/discord/services` | Observer | Friendly service summary | No |

## Current Bot Commands

| Command | Minimum Role | Output |
|---|---:|---|
| `/dune health` | Public | Adapter health |
| `/dune status public` | Public | Public redacted status output |
| `/dune status detail` | Admin | Detailed redacted diagnostic output |
| `/dune readiness` | Observer | Readiness summary |
| `/dune services` | Observer | Service summary |
| `/dune help` | Public | Safe command help |
| `/dune version` | Public | Bot version |

## Validation Status

Latest local validation reported:

- Console Discord adapter tests: 37 passing, 0 failing.
- Bot tests: 3 passing, 0 failing.
- Bot secret scan: passing after runtime-assembled redaction fixtures.
- Bot scaffold validation: passing after narrowing validation to capability literals.
- Live HTTP checks: status, readiness, services, and detailed status returned `200 OK` with matching role policy.
- Discord runtime syntax is checked by bot scaffold validation.

New CI evidence added:

- Semgrep CE SAST workflow on pull request, push, manual dispatch, and weekly schedule.
- Trivy filesystem and Discord bot image scan workflow on pull request, push, manual dispatch, and weekly schedule.
- CVSS-ranked vulnerability report with CVE/NVD URLs when CVE IDs are present.
- STRIDE threat model report workflow and issue tracking.
- SBOM generation workflow.

## Roadmap

### P0 - Foundation and Governance

Status: mostly complete.

Completed items include the isolated bot workspace, security gates, redaction tests, authorization tests, protected adapter docs, Semgrep workflow, Trivy workflow, STRIDE reporting, SBOM generation, vulnerability reporting, SOC 2 readiness matrix, scheduled readiness workflow, and setup/admin/user documentation.

### P1 - Read-Only Operational Visibility

Status: in progress.

Completed:

- Health.
- Public redacted status.
- Admin detailed redacted status.
- Readiness.
- Services.
- Real Discord client connection.
- Guild slash-command registration.
- Interaction handler.
- Safe help/version commands.

Remaining:

- Population summary.
- Logs with cap/redaction/role gate.
- Map state.
- Backup list/latest metadata.
- Command-level rate limits.

### P2 - Operational Hardening

Status: not started.

Planned:

- Rate limits.
- Alerting.
- Bot heartbeat.
- Public/admin channel mapping.
- Emergency disable flag.
- Evidence retention policy.
- Image signing for release candidates.

### P3 - Future Review Gate

Status: blocked by design.

No write, destructive, credential, database mutation, addon mutation, player mutation, map mutation, or Docker/service lifecycle command may be added without a separate threat model, approval, DAST cases, audit policy, and rollback plan.

## SOC 2 Readiness Position

This project maintains SOC 2-aligned readiness evidence. It does not claim SOC 2 certification or produce a SOC 2 report. A formal SOC 2 report requires an independent CPA examination.

The recurring readiness workflow checks documentation, safety markers, tests, secret scanning, Semgrep/Trivy workflow presence, vulnerability report generation logic, and scaffold validation on a weekly cadence and on relevant repository changes.
