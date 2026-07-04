# Dune Discord Control Bot - SOC 2 Readiness Control Matrix

## Important Compliance Position

This project can implement SOC 2-aligned controls and collect audit-ready evidence, but the repository itself cannot self-certify SOC 2 compliance. A SOC 2 report requires an independent examination by a qualified CPA firm against the applicable Trust Services Criteria.

For this project, the practical target is **SOC 2 readiness** for the Discord Control Bot and Dune Console Discord API Adapter.

## Recurring SOC 2 Readiness Check

The repository includes a recurring SOC 2 readiness workflow:

```text
.github/workflows/soc2-readiness-check.yml
```

The workflow runs:

- Weekly on Monday at 09:00 UTC.
- On manual `workflow_dispatch`.
- On relevant pull requests and pushes that touch Discord bot, Console adapter, SOC 2 evidence, or documentation files.

The workflow validates:

- Required SOC 2 evidence documentation exists.
- Admin, user, setup, roadmap, and project-status documentation exists.
- The bot authorization model contains only read-only capabilities.
- The Console adapter still reports `readOnly: true` and `writesEnabled: false`.
- Console Discord adapter tests pass.
- Bot tests pass.
- Bot secret scanning passes.
- Bot scaffold validation passes.
- Semgrep SAST workflow evidence exists.
- Trivy vulnerability workflow evidence exists.
- CVSS vulnerability report generation logic exists.
- STRIDE threat model workflow evidence exists.
- STRIDE report generation logic exists.

Local readiness check:

```bash
node scripts/soc2-readiness-check.mjs
```

If local Semgrep or Trivy runtimes are missing, run:

```bash
bash scripts/ensure-security-runtimes.sh
```

## Trust Services Categories in Scope

| Category | Applicability |
| --- | --- |
| Security | Primary category. Required because the bot becomes a Discord-originated operational visibility plane. |
| Availability | Applicable because bot commands and status functions depend on reliable service operation. |
| Confidentiality | Applicable because the bot may access server operational data and secrets-adjacent workflows. |
| Processing Integrity | Applicable because command responses must be accurate, complete, authorized, and redacted. |
| Privacy | Limited unless personally identifiable player/user data is processed beyond operational IDs. |

## Control Objectives

1. Prevent unauthorized Discord-originated access to operational diagnostics.
2. Protect secrets and sensitive operational data.
3. Ensure changes are reviewed, tested, and traceable.
4. Ensure any future high-risk action is separately approved, confirmed, audited, and reversible where possible.
5. Generate repeatable evidence through CI, release, and runtime logs.
6. Maintain secure development and vulnerability management practices.
7. Preserve availability through health checks, safe rollbacks, and controlled releases.
8. Maintain recurring STRIDE threat model evidence for architecture and trust-boundary changes.

## SOC 2-Aligned Control Matrix

| Control ID | Trust Category | Control Objective | Implementation Requirement | Evidence |
| --- | --- | --- | --- | --- |
| DC-SOC2-SEC-001 | Security | Only authorized Discord users can access role-gated diagnostics. | Server-side role-to-capability authorization in Dune Console API adapter. | Authorization matrix tests, API adapter tests, audit logs, STRIDE report. |
| DC-SOC2-SEC-002 | Security | Bot cannot bypass backend authority. | Bot acts only as client; backend enforces final authorization, safety, redaction, and audit. | Architecture docs, code review, route tests, STRIDE report. |
| DC-SOC2-SEC-003 | Security | No destructive actions exist in experimental bot scope. | Bot and adapter expose read-only routes only. | Route inventory, capability tests, scaffold validation, STRIDE report. |
| DC-SOC2-SEC-004 | Security | Secrets are protected from disclosure. | File-based secrets, no secrets in source/logs/static files/images. | Secret scan reports, redaction tests, image scan results. |
| DC-SOC2-SEC-005 | Security | Containers run with least privilege. | Non-root bot container, no Docker socket, no privileged mode, dropped capabilities. | Dockerfile, Compose review, DCA scan output, STRIDE report. |
| DC-SOC2-SEC-006 | Security | Vulnerabilities are identified before release. | SCA, SAST, DCA, DAST, Semgrep, Trivy, STRIDE, and secret gates block critical/high issues. | CI results, Semgrep report, Trivy report, STRIDE report, CVSS vulnerability report, exception register. |
| DC-SOC2-SEC-007 | Security | Sensitive outputs are redacted. | Central redaction library for logs, errors, Discord responses. | Redaction tests, code review, DAST tests, STRIDE report. |
| DC-SOC2-SEC-008 | Security | Discord-originated access is traceable. | Structured audit events for adapter operations. | Audit logs, audit schema, test fixtures, STRIDE report. |
| DC-SOC2-SEC-009 | Security | Production changes are reviewed. | Pull requests require review, tests, security impact, and rollback plan. | PR records, branch protection evidence. |
| DC-SOC2-SEC-010 | Security | Dependency risk is managed. | Lockfile, dependency review, automated dependency scanning, Trivy filesystem scans. | package-lock, SCA report, Trivy report, Dependabot/Renovate PRs. |
| DC-SOC2-SEC-011 | Security | Command injection is prevented. | No shell execution in bot; backend uses safe wrappers and fixed arguments; Semgrep checks high-risk code patterns. | Semgrep SAST results, code review, injection tests, STRIDE report. |
| DC-SOC2-SEC-012 | Security | SQL misuse is controlled. | Experimental bot has no SQL route; future SQL access requires separate threat model. | Capability inventory, route tests, STRIDE report. |
| DC-SOC2-SEC-013 | Security | Abuse is controlled. | Future rate limits required before production Discord deployment. | Roadmap, rate-limit tests when implemented, STRIDE report. |
| DC-SOC2-SEC-014 | Security | Role mapping is regularly reviewed. | Role-policy health reports configured tiers without exposing role IDs. | Health output, access review record, STRIDE report. |
| DC-SOC2-AV-001 | Availability | Bot process health is monitored. | Docker healthcheck and bot heartbeat before production Discord deployment. | Container health output, heartbeat logs, STRIDE report. |
| DC-SOC2-AV-002 | Availability | Bot can fail without breaking WebUI. | Bot isolated from WebUI execution path. | Architecture docs, integration tests, STRIDE report. |
| DC-SOC2-AV-003 | Availability | Releases are reversible. | Rollback plan and pinned image releases. | Release checklist, versioned image tags. |
| DC-SOC2-AV-004 | Availability | Failures are safely handled. | Error redaction and graceful Discord/API error handling. | Error handling tests, logs, STRIDE report. |
| DC-SOC2-C-001 | Confidentiality | Internal topology is not exposed publicly. | Public responses hide internal IPs, SSH hosts, DB URLs, service internals. | Response tests, DAST output, STRIDE report. |
| DC-SOC2-C-002 | Confidentiality | Detailed Status requires elevated role. | Diagnostic commands require admin or owner role. | Authorization tests, STRIDE report. |
| DC-SOC2-C-003 | Confidentiality | Logs avoid sensitive payloads. | No raw request body logging for secret-bearing or admin commands. | Code review, Semgrep results, log samples, STRIDE report. |
| DC-SOC2-PI-001 | Processing Integrity | Responses reflect intended command scope. | Each command maps to one read-only adapter route and capability. | Command route tests, smoke tests, STRIDE report. |
| DC-SOC2-PI-002 | Processing Integrity | Future write behavior is gated. | No write route until separate approval, threat model, confirmation policy, DAST, audit policy, and rollback plan exist. | Roadmap P3 gate, ADR, STRIDE report. |
| DC-SOC2-P-001 | Privacy | Player/user data exposure is minimized. | Public channel responses avoid sensitive player details; detailed lookups remain future role-gated scope. | Data classification matrix, response tests, STRIDE report. |
| DC-SOC2-P-002 | Privacy | Discord actor data is used only for audit and authorization. | Audit schema limits Discord data to operational metadata. | Audit schema, privacy review, STRIDE report. |

## Evidence Register

| Evidence ID | Evidence Artifact | Owner | Frequency | Related Controls |
| --- | --- | --- | --- | --- |
| E-001 | GitHub Actions security gate result | Engineering | Every PR/push | SEC-006, SEC-009 |
| E-002 | Secret scan output | Engineering | Every PR/push | SEC-004, SEC-007 |
| E-003 | SCA dependency report | Engineering | Every PR/push/release | SEC-006, SEC-010 |
| E-004 | Semgrep SAST report | Engineering | Every PR/push/weekly/manual | SEC-006, SEC-011, C-003 |
| E-005 | Trivy filesystem and image scan report | Engineering | Every PR/push/weekly/manual | SEC-005, SEC-006, SEC-010 |
| E-006 | DAST report | Engineering/Security | Release candidate | SEC-001, SEC-003, SEC-012, C-001 |
| E-007 | Unit and authorization test results | Engineering | Every PR/push | SEC-001, SEC-003 |
| E-008 | Release checklist | Release owner | Every release | SEC-009, AV-003 |
| E-009 | SBOM | Release owner | Every release | SEC-006, SEC-010 |
| E-010 | Image signature/provenance | Release owner | Every release | SEC-006, AV-003 |
| E-011 | Audit log samples | System owner | Monthly / release candidate | SEC-008, PI-001 |
| E-012 | Exception register | Security owner | As needed, reviewed monthly | SEC-006 |
| E-013 | Threat model / STRIDE report | Security owner | Major design change / weekly / PR | SEC-001, SEC-002, C-001, AV-004 |
| E-014 | Access/role mapping review | System owner | Monthly / before release | SEC-001, C-002 |
| E-015 | Scheduled SOC 2 readiness workflow result | Engineering/Security | Weekly / manual / PR | SEC-004, SEC-006, SEC-009, C-001, PI-001 |
| E-016 | CVSS-ranked vulnerability report with CVE/NVD URLs | Engineering/Security | Every Trivy/Semgrep workflow run / release candidate | SEC-006, SEC-010 |
| E-017 | Repository-local STRIDE JSON/Markdown artifacts | Security owner | Every PR/push/weekly/manual | SEC-001, SEC-002, SEC-003, SEC-006, C-001, AV-004 |

## Required SOC 2 Readiness Workflows

### Change Management

1. All changes must go through pull request review.
2. PRs must include purpose, risk, tests, security impact, and rollback plan.
3. Security-sensitive PRs must update threat model and control matrix.
4. Failed gates block merge.
5. Exceptions must be documented and time-bound.

### Access Control

1. Discord roles must map to least-privilege capabilities.
2. Experimental scope is read-only.
3. Server-side authorization must be enforced by the Dune Console API adapter.
4. Bot API token must be separate from WebUI admin password.
5. Role mapping must be reviewed regularly.

### Vulnerability Management

1. SCA, SAST, DCA, DAST, Semgrep, Trivy, STRIDE, and secret scanning run in CI/CD.
2. Critical/high findings block release unless formally excepted.
3. Exceptions require owner, expiration, mitigation, and compensating controls.
4. Dependency updates are tracked and reviewed.
5. Vulnerability reports must include CVSS ranking and relevant CVE/NVD URLs when scanner data provides CVE IDs.
6. STRIDE open high/critical threats require remediation issue or documented exception before release candidate.

### Incident Response

1. Suspected token exposure requires immediate token rotation.
2. Bot adapter can be disabled by removing `DUNE_DISCORD_ADAPTER_ENABLED=true`.
3. Audit logs must identify Discord actor, action, target, result, and timestamp where available.
4. Security incidents produce post-incident review and regression tests.

### Availability and Resilience

1. Bot healthcheck required before production Discord deployment.
2. Bot failure must not impact WebUI.
3. Release rollback path must be documented.
4. Runtime errors must be redacted and handled gracefully.

## Open SOC 2 Gaps

These are not satisfied by code alone and require operational ownership:

1. Formal risk assessment.
2. Formal access review cadence.
3. Incident response procedure ownership.
4. Evidence retention policy.
5. Change approval authority.
6. Vendor/dependency management policy.
7. Independent audit readiness review.
8. CPA examination if a SOC 2 report is required.
9. Rate limits before production Discord deployment.
10. Runtime Discord client monitoring and alerting.

## Compliance Statement Template

Use this language in project materials:

```text
The Discord Control Bot is designed with SOC 2-aligned security, availability, confidentiality, processing integrity, and privacy controls. The project maintains audit-ready evidence through CI/CD security gates, structured audit logs, release artifacts, documented control mappings, and repository-local STRIDE threat model reports. This does not constitute a SOC 2 report or certification; formal SOC 2 compliance requires an independent examination by a qualified CPA firm.
```
