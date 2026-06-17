# STRIDE Threat Model Report

Generated: 2026-06-17T20:22:12.334Z
Scanner: Dune STRIDE Threat Model Scanner
Cost: free / repository-local
Scope: Experimental read-only Discord companion bot and protected Console API adapter

## Summary

- Total findings: 10
- Open findings: 2
- Mitigated findings: 8

### By STRIDE Category

| Category | Count |
|---|---:|
| Spoofing | 2 |
| Tampering | 2 |
| Repudiation | 1 |
| Information Disclosure | 2 |
| Denial of Service | 1 |
| Elevation of Privilege | 2 |

## Assets

| ID | Asset | Sensitivity |
|---|---|---|
| discord-user | Discord user/member | identity and role context |
| discord-bot | Discord companion bot | operational command client |
| console-adapter | Dune Console Discord API adapter | protected operational API |
| bot-api-token | Dune bot API token | shared service credential |
| console-runtime | Dune Docker Console runtime | server operations and status data |
| security-artifacts | Security evidence artifacts | SOC 2 readiness evidence |
| github-actions | GitHub Actions automation | CI permissions and issue automation |

## Trust Boundaries

| ID | From | To | Protocol |
|---|---|---|---|
| tb-discord-bot | Discord | Discord companion bot | Discord interactions / future client runtime |
| tb-bot-console | Discord companion bot | Console adapter | HTTP with bot API bearer token |
| tb-console-runtime | Console adapter | Dune runtime files and commands | local process/runtime access |
| tb-ci-repo | GitHub Actions | repository issues/code scanning/artifacts | GITHUB_TOKEN and workflow permissions |

## Findings

| ID | STRIDE | Severity | Status | Threat | Recommendation |
|---|---|---|---|---|---|
| STRIDE-S-001 | Spoofing | high | open | Discord actor or role spoofing across bot-to-adapter boundary | Keep final authorization in the Console adapter. Never rely on client-side Discord role checks only. |
| STRIDE-S-002 | Spoofing | high | mitigated | Bot API token disclosure or static token misuse | Continue using file-based runtime secrets and rotate the bot API token after suspected exposure. |
| STRIDE-T-001 | Tampering | critical | mitigated | Write/destructive behavior exposed through Discord command surface | Any future write behavior requires separate approval, threat model, confirmation policy, DAST cases, audit policy, and rollback plan. |
| STRIDE-T-002 | Tampering | critical | mitigated | Docker socket or privileged container access from bot | Keep the bot as an API client. Do not mount Docker socket or run privileged. |
| STRIDE-R-001 | Repudiation | medium | open | Discord-originated adapter access lacks audit evidence | Maintain structured audit events containing Discord actor, command, capability, route, result, and timestamp. |
| STRIDE-I-001 | Information Disclosure | high | mitigated | Public Discord responses expose internal topology or secrets | Keep public status minimal. Gate diagnostic details to admin/owner and prefer ephemeral Discord responses. |
| STRIDE-I-002 | Information Disclosure | medium | mitigated | Security artifacts expose sensitive runtime details | Keep generated scan artifacts in workflow artifacts, not committed source, unless explicitly reviewed and sanitized. |
| STRIDE-D-001 | Denial of Service | medium | mitigated | Discord command abuse or repeated status/log requests overload adapter/runtime | Implement command-level rate limits before production Discord deployment. Treat current state as planned mitigation, not full runtime control. |
| STRIDE-E-001 | Elevation of Privilege | high | mitigated | Observer/moderator gains admin-only diagnostic data | Keep detailed status behind admin/owner capability and enforce that check server-side. |
| STRIDE-E-002 | Elevation of Privilege | medium | mitigated | GitHub Actions issue automation over-permissioned or abused | Keep issue creation disabled on pull_request context and avoid pull_request_target for untrusted code. |

## Detailed Evidence

### STRIDE-S-001 - Discord actor or role spoofing across bot-to-adapter boundary

- STRIDE: Spoofing
- Severity: high
- Status: open
- Asset: console-adapter
- Trust boundary: tb-bot-console
- Evidence:
  - GAP: adapter validates actor context
  - PASS: backend policy exists
  - PASS: role-policy health exists without exposing IDs
- Recommendation: Keep final authorization in the Console adapter. Never rely on client-side Discord role checks only.
- SOC 2 readiness mapping: DC-SOC2-SEC-001, DC-SOC2-SEC-002, DC-SOC2-SEC-006, E-013

### STRIDE-S-002 - Bot API token disclosure or static token misuse

- STRIDE: Spoofing
- Severity: high
- Status: mitigated
- Asset: bot-api-token
- Trust boundary: tb-bot-console
- Evidence:
  - PASS: file-based token configuration
  - PASS: bearer token used for adapter calls
  - PASS: secret scanner exists
- Recommendation: Continue using file-based runtime secrets and rotate the bot API token after suspected exposure.
- SOC 2 readiness mapping: DC-SOC2-SEC-001, DC-SOC2-SEC-002, DC-SOC2-SEC-006, E-013

### STRIDE-T-001 - Write/destructive behavior exposed through Discord command surface

- STRIDE: Tampering
- Severity: critical
- Status: mitigated
- Asset: discord-bot
- Trust boundary: tb-discord-bot
- Evidence:
  - PASS: adapter writes disabled
  - PASS: adapter read-only marker
  - PASS: bot auth has no write/destructive/broadcast capability strings
- Recommendation: Any future write behavior requires separate approval, threat model, confirmation policy, DAST cases, audit policy, and rollback plan.
- SOC 2 readiness mapping: DC-SOC2-SEC-003, DC-SOC2-SEC-005, DC-SOC2-SEC-006, E-013

### STRIDE-T-002 - Docker socket or privileged container access from bot

- STRIDE: Tampering
- Severity: critical
- Status: mitigated
- Asset: discord-bot
- Trust boundary: tb-console-runtime
- Evidence:
  - PASS: no Docker socket reference in bot Docker/Compose files
  - PASS: no privileged mode in bot Docker/Compose files
- Recommendation: Keep the bot as an API client. Do not mount Docker socket or run privileged.
- SOC 2 readiness mapping: DC-SOC2-SEC-003, DC-SOC2-SEC-005, DC-SOC2-SEC-006, E-013

### STRIDE-R-001 - Discord-originated adapter access lacks audit evidence

- STRIDE: Repudiation
- Severity: medium
- Status: open
- Asset: console-adapter
- Trust boundary: tb-bot-console
- Evidence:
  - GAP: audit module exists
  - PASS: adapter/routes reference audit
- Recommendation: Maintain structured audit events containing Discord actor, command, capability, route, result, and timestamp.
- SOC 2 readiness mapping: DC-SOC2-SEC-008, DC-SOC2-SEC-006, E-013

### STRIDE-I-001 - Public Discord responses expose internal topology or secrets

- STRIDE: Information Disclosure
- Severity: high
- Status: mitigated
- Asset: console-runtime
- Trust boundary: tb-discord-bot
- Evidence:
  - PASS: sanitize/redaction module exists
  - PASS: public/diagnostic response split exists
  - PASS: bot redaction helper exists
- Recommendation: Keep public status minimal. Gate diagnostic details to admin/owner and prefer ephemeral Discord responses.
- SOC 2 readiness mapping: DC-SOC2-C-001, DC-SOC2-C-002, DC-SOC2-C-003, DC-SOC2-SEC-006, E-013

### STRIDE-I-002 - Security artifacts expose sensitive runtime details

- STRIDE: Information Disclosure
- Severity: medium
- Status: mitigated
- Asset: security-artifacts
- Trust boundary: tb-ci-repo
- Evidence:
  - PASS: security artifacts ignored by git
  - PASS: artifact directory placeholder allowed
- Recommendation: Keep generated scan artifacts in workflow artifacts, not committed source, unless explicitly reviewed and sanitized.
- SOC 2 readiness mapping: DC-SOC2-C-001, DC-SOC2-C-002, DC-SOC2-C-003, DC-SOC2-SEC-006, E-013

### STRIDE-D-001 - Discord command abuse or repeated status/log requests overload adapter/runtime

- STRIDE: Denial of Service
- Severity: medium
- Status: mitigated
- Asset: console-adapter
- Trust boundary: tb-discord-bot
- Evidence:
  - PASS: rate limits documented/planned
  - GAP: runtime rate-limit implementation present
- Recommendation: Implement command-level rate limits before production Discord deployment. Treat current state as planned mitigation, not full runtime control.
- SOC 2 readiness mapping: DC-SOC2-AV-001, DC-SOC2-AV-004, DC-SOC2-SEC-006, E-013

### STRIDE-E-001 - Observer/moderator gains admin-only diagnostic data

- STRIDE: Elevation of Privilege
- Severity: high
- Status: mitigated
- Asset: console-adapter
- Trust boundary: tb-bot-console
- Evidence:
  - PASS: admin/owner roles represented in policy/auth
  - PASS: diagnostic mode exists
  - PASS: authorization tests exist
- Recommendation: Keep detailed status behind admin/owner capability and enforce that check server-side.
- SOC 2 readiness mapping: DC-SOC2-SEC-001, DC-SOC2-SEC-005, DC-SOC2-SEC-006, E-013

### STRIDE-E-002 - GitHub Actions issue automation over-permissioned or abused

- STRIDE: Elevation of Privilege
- Severity: medium
- Status: mitigated
- Asset: github-actions
- Trust boundary: tb-ci-repo
- Evidence:
  - PASS: issue automation permission explicit
  - PASS: pull request issue sync is dry-run
  - PASS: push/schedule sync uses repository token
- Recommendation: Keep issue creation disabled on pull_request context and avoid pull_request_target for untrusted code.
- SOC 2 readiness mapping: DC-SOC2-SEC-001, DC-SOC2-SEC-005, DC-SOC2-SEC-006, E-013
