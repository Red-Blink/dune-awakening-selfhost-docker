# Security Evidence Bundle

Generated: 2026-06-17T20:22:12.363Z
Scope: Experimental read-only Discord companion bot and Console API adapter

## Compliance Position

SOC 2 readiness evidence bundle; not a SOC 2 report or certification assertion.

## Readiness Result

- Status: passed
- Command: node scripts/soc2-readiness-check.mjs
- Output: SOC 2 readiness check passed. Evidence files, runtimes, issue tracking, vulnerability tracking, STRIDE output, STRIDE issue tracking, evidence bundle, automation validation, and read-only safety markers are present.

## Evidence Summary

- Required evidence present: 19
- Required evidence missing: 0
- Optional evidence present: 4
- Optional evidence missing: 0

## Vulnerability Summary

- Total findings: 0
- Critical: 0
- High: 0
- Medium: 0

## STRIDE Summary

- Total findings: 10
- Open: 2
- Mitigated: 8

## Evidence Inventory

| Type | Required | Exists | Path | Description |
|---|---:|---:|---|---|
| workflow | yes | yes | .github/workflows/discord-bot-security-gates.yml | Discord bot security gates workflow |
| workflow | yes | yes | .github/workflows/soc2-readiness-check.yml | SOC 2 readiness workflow |
| workflow | yes | yes | .github/workflows/semgrep-sast.yml | Semgrep SAST workflow |
| workflow | yes | yes | .github/workflows/trivy-vulnerability-scan.yml | Trivy vulnerability workflow |
| workflow | yes | yes | .github/workflows/stride-threat-scan.yml | STRIDE threat scan workflow |
| script | yes | yes | scripts/soc2-readiness-check.mjs | SOC 2 readiness local gate |
| script | yes | yes | scripts/generate-vulnerability-report.mjs | CVSS-ranked vulnerability report generator |
| script | yes | yes | scripts/sync-vulnerability-issues.mjs | Vulnerability issue lifecycle sync |
| script | yes | yes | scripts/generate-stride-report.mjs | Repository-local STRIDE scanner |
| script | yes | yes | scripts/sync-stride-issues.mjs | STRIDE issue lifecycle sync |
| script | yes | yes | scripts/validate-security-automation.mjs | Security automation regression validator |
| script | yes | yes | scripts/ensure-security-runtimes.sh | Local security runtime bootstrap |
| documentation | yes | yes | docs/discord-control-bot/soc2-control-matrix.md | SOC 2 readiness control matrix |
| documentation | yes | yes | docs/discord-control-bot/security-gates.md | Security gates documentation |
| documentation | yes | yes | docs/discord-control-bot/issue-tracking-policy.md | Issue tracking policy |
| template | yes | yes | .github/ISSUE_TEMPLATE/vulnerability-remediation.yml | Vulnerability remediation issue template |
| template | yes | yes | .github/ISSUE_TEMPLATE/threat-remediation.yml | STRIDE threat remediation issue template |
| template | yes | yes | .github/ISSUE_TEMPLATE/security-exception.yml | Security exception issue template |
| template | yes | yes | .github/ISSUE_TEMPLATE/access-review.yml | Access review issue template |
| artifact | no | yes | artifacts/security/vulnerability-report.json | Generated vulnerability report JSON |
| artifact | no | yes | artifacts/security/vulnerability-report.md | Generated vulnerability report Markdown |
| artifact | no | yes | artifacts/security/stride-report.json | Generated STRIDE report JSON |
| artifact | no | yes | artifacts/security/stride-report.md | Generated STRIDE report Markdown |

## Control Evidence Mapping

| Control | Status | Objective | Files |
|---|---|---|---|
| DC-SOC2-SEC-001 | present | Access control | yes:discord-bot/src/security/authorization.ts<br>yes:console/api/src/integrations/discord/policy.js<br>yes:console/api/test/discordPolicy.test.js |
| DC-SOC2-SEC-002 | present | Backend authority | yes:console/api/src/integrations/discord/routes.js<br>yes:console/api/src/integrations/discord/adapter.js<br>yes:docs/discord-control-bot/api-adapter-contract.md |
| DC-SOC2-SEC-003 | present | Read-only scope | yes:discord-bot/src/security/authorization.ts<br>yes:console/api/src/integrations/discord/adapter.js<br>yes:discord-bot/scripts/validate-scaffold.mjs |
| DC-SOC2-SEC-004 | present | Secret protection | yes:discord-bot/scripts/check-secrets.mjs<br>yes:discord-bot/src/security/redaction.ts<br>yes:console/api/src/integrations/discord/sanitize.js |
| DC-SOC2-SEC-006 | present | Vulnerability management | yes:.github/workflows/semgrep-sast.yml<br>yes:.github/workflows/trivy-vulnerability-scan.yml<br>yes:scripts/generate-vulnerability-report.mjs<br>yes:scripts/sync-vulnerability-issues.mjs |
| DC-SOC2-SEC-008 | present | Auditability | yes:console/api/src/integrations/discord/audit.js<br>yes:console/api/test/discordAudit.test.js<br>yes:docs/discord-control-bot/issue-tracking-policy.md |
| DC-SOC2-C-001 | present | Confidentiality/redaction | yes:console/api/src/integrations/discord/sanitize.js<br>yes:console/api/src/integrations/discord/statusProvider.js<br>yes:console/api/test/discordStatusProvider.test.js |
| E-013 | present | Threat model evidence | yes:scripts/generate-stride-report.mjs<br>yes:.github/workflows/stride-threat-scan.yml<br>yes:artifacts/security/stride-report.md |
| E-016 | present | CVSS vulnerability evidence | yes:scripts/generate-vulnerability-report.mjs<br>yes:artifacts/security/vulnerability-report.md |
| E-017 | present | STRIDE artifact evidence | yes:artifacts/security/stride-report.json<br>yes:artifacts/security/stride-report.md<br>yes:scripts/sync-stride-issues.mjs |
