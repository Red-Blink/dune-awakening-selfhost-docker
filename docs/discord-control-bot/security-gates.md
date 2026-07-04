# Dune Discord Control Bot - Security Gates

## Purpose

The Discord companion bot creates a Discord-accessible operational visibility surface for Dune Docker Console. The experimental scope is read-only. Security controls are release blockers, not optional hardening.

This document defines required SCA, SAST, DCA, DAST, STRIDE threat modeling, vulnerability reporting, and SOC 2 readiness controls for the bot and the Dune Console Discord API adapter.

## Gate Summary

| Gate | Scope | Blocking Conditions |
| --- | --- | --- |
| Secrets | Source, logs, images, release artifacts | Any verified token, password, private key, database URL, or Funcom token leak |
| SCA | Dependencies and licenses | Critical/high exploitable dependency with fix available, missing lockfile, disallowed license |
| SAST | Source code | Auth bypass, command injection, SQL injection, path traversal, unsafe secret logging |
| DCA | Dockerfiles, Compose, images | Docker socket in bot, privileged mode, root runtime, critical/high image CVE with fix available |
| DAST | Running API and bot flows | Unauthorized action, secret leakage, read-only bypass |
| STRIDE | Architecture, trust boundaries, assets, bot/adapter controls | Missing STRIDE report for release candidate or unresolved high-risk threat without exception |
| Authorization | Discord roles and backend policy | Client-only authorization, missing backend authorization, stale role use |
| Audit | Adapter operations | Missing audit event for role-gated adapter operations |
| Vulnerability Report | Trivy/Semgrep JSON/SARIF artifacts | Missing CVSS-ranked report for release candidate |

## SCA - Software Composition Analysis

### Required Controls

1. Dependency vulnerability scanning on every pull request.
2. Lockfile required for each package manager workspace.
3. Dependency pinning; no floating major versions in release builds.
4. SBOM generation for releases.
5. License policy checks.
6. Dependabot or Renovate for dependency update pull requests.
7. Transitive dependency visibility.
8. Dependency review for new packages.
9. CVSS-ranked vulnerability report generated from scanner artifacts.

### Blocking Conditions

- Critical exploitable vulnerability with a fixed version available.
- High exploitable vulnerability with a fixed version available and no approved exception.
- Missing lockfile when package dependencies exist.
- Disallowed license.
- Missing release SBOM.
- Missing vulnerability report artifact.

## SAST - Static Application Security Testing

### Required Controls

1. CodeQL or equivalent static analysis.
2. Semgrep CE scan on pull requests, pushes, manual dispatch, and scheduled cadence.
3. Secret scanning.
4. ShellCheck for shell scripts where shell scripts are changed.
5. SQL safety rules for raw SQL construction.
6. Command execution rules for shell/process execution.
7. Route authorization checks for the Discord API adapter.
8. Redaction checks for all logs and errors.

### Semgrep Evidence

Semgrep runs through:

```text
.github/workflows/semgrep-sast.yml
```

The workflow produces:

```text
artifacts/security/semgrep.json
artifacts/security/semgrep.sarif
artifacts/security/vulnerability-report.json
artifacts/security/vulnerability-report.md
```

SARIF is uploaded to GitHub code scanning when available. Semgrep ERROR maps to HIGH and WARNING maps to MEDIUM for issue tracking.

### High-Risk Patterns to Block

```text
child_process.exec(...)
spawn(..., { shell: true })
template-built shell commands
raw SQL concatenation from Discord/user input
file paths derived from Discord input without allowlist validation
logging request bodies, headers, environment variables, or secrets
backend routes without authorization middleware
bot-only authorization for privileged actions
```

## DCA - Docker/Container Analysis

### Required Controls

1. Dockerfile linting.
2. Container image vulnerability scanning.
3. Base image pinning.
4. Non-root container user.
5. No Docker socket mount in the bot container.
6. No privileged mode.
7. Drop Linux capabilities.
8. Read-only filesystem where practical.
9. Minimal host mounts.
10. Runtime secrets mounted as files.
11. Healthcheck required before production deployment.
12. Signed image and release SBOM.

### Trivy Evidence

Trivy runs through:

```text
.github/workflows/trivy-vulnerability-scan.yml
```

The workflow scans:

```text
repository filesystem
Discord bot container image
```

The workflow produces:

```text
artifacts/security/trivy-fs.json
artifacts/security/trivy-fs.sarif
artifacts/security/trivy-discord-bot-image.json
artifacts/security/vulnerability-report.json
artifacts/security/vulnerability-report.md
```

The vulnerability report ranks findings by CVSS and includes CVE/NVD URLs when CVE IDs are present.

### Blocking Conditions

- Bot container mounts `/var/run/docker.sock`.
- Bot container uses `privileged: true`.
- Bot container runs as root without an approved exception.
- Critical/high image vulnerability with a fixed version available and no approved exception.
- Secret baked into image layer.
- Broad writable host mount.
- Floating base image in release Dockerfile.

## STRIDE - Threat Modeling

### Required Controls

1. Free repository-local STRIDE scan runs on pull requests, pushes, manual dispatch, and scheduled cadence.
2. Threat report identifies assets, trust boundaries, STRIDE categories, severity, status, evidence, recommendation, and SOC 2 readiness mapping.
3. Open high/critical threats require remediation issue or security exception before release candidate.
4. Threat model output is retained as a workflow artifact.

### STRIDE Evidence

STRIDE runs through:

```text
.github/workflows/stride-threat-scan.yml
```

The workflow produces:

```text
artifacts/security/stride-report.json
artifacts/security/stride-report.md
```

The scanner is free and repository-local:

```text
scripts/generate-stride-report.mjs
```

### STRIDE Categories Covered

```text
Spoofing
Tampering
Repudiation
Information Disclosure
Denial of Service
Elevation of Privilege
```

## DAST - Dynamic Application Security Testing

### Required Controls

1. Authenticated scan of Discord API adapter endpoints.
2. Unauthenticated access tests.
3. Authorization matrix tests for Observer, Moderator, Admin, Owner.
4. Secret leakage tests against API responses and logs.
5. Error redaction tests.
6. API fuzzing for user-controlled fields.
7. Read-only scope enforcement tests.
8. Rate-limit tests before production Discord deployment.

### Blocking Conditions

- Privileged or role-gated endpoint works without valid bot API token.
- User can exceed Discord role capability.
- Secret appears in response, logs, or Discord message.
- Command injection or path traversal is possible.
- Missing rate limits before production Discord deployment.

## Required Runtime Controls

1. Dedicated Dune bot API token separate from WebUI admin password.
2. Server-side Discord actor authorization.
3. Command-level rate limits before production Discord deployment.
4. Structured audit events.
5. Central redaction library.
6. Public/admin response classification.
7. Emergency kill switch for Discord-originated requests before production Discord deployment.
8. Experimental scope remains read-only.

## Minimum Release Criteria

A release candidate may not ship unless all of the following are true:

```text
[BLOCK] No verified secrets in source, logs, images, or release artifacts.
[BLOCK] No critical/high exploitable dependency vulnerabilities with fixed versions available.
[BLOCK] No critical/high SAST findings without approved exception.
[BLOCK] Bot image does not run as root.
[BLOCK] Bot image does not mount Docker socket.
[BLOCK] Bot image is not privileged.
[BLOCK] Authorization matrix tests pass.
[BLOCK] Redaction tests pass.
[BLOCK] Semgrep workflow runs and uploads artifacts.
[BLOCK] Trivy workflow runs and uploads CVSS-ranked vulnerability report.
[BLOCK] STRIDE workflow runs and uploads threat model report.
[BLOCK] SOC 2 readiness check passes.
[BLOCK] Release image has SBOM and is signed before production deployment.
```
