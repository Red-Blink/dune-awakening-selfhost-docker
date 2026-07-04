# Dune Discord Companion Bot - Issue Tracking Policy

## Purpose

This policy defines how repository issues support SOC 2 readiness evidence for the experimental read-only Discord companion bot and Console adapter.

Issue tracking is not itself a SOC 2 certification requirement. SOC 2 readiness does require evidence that changes, vulnerabilities, threats, exceptions, access reviews, and incidents are identified, owned, reviewed, remediated, and traceable. Repository issues provide that evidence trail.

## Issue Types

| Issue type | Template | SOC 2 readiness purpose |
|---|---|---|
| Bug | `.github/ISSUE_TEMPLATE/bug-report.yml` | Defect tracking, remediation evidence, regression evidence |
| Feature request | `.github/ISSUE_TEMPLATE/feature-request.yml` | Change-management evidence and security impact review |
| Vulnerability remediation | `.github/ISSUE_TEMPLATE/vulnerability-remediation.yml` | Vulnerability management and CVSS remediation tracking |
| STRIDE threat remediation | `.github/ISSUE_TEMPLATE/threat-remediation.yml` | Threat-model remediation and risk treatment tracking |
| Security exception | `.github/ISSUE_TEMPLATE/security-exception.yml` | Time-bound risk acceptance and compensating controls |
| SOC 2 evidence gap | `.github/ISSUE_TEMPLATE/soc2-evidence-gap.yml` | Missing/stale evidence remediation |
| Access review | `.github/ISSUE_TEMPLATE/access-review.yml` | Monthly and release-candidate access review evidence |

## Minimum Fields

Every security, SOC 2, vulnerability, threat, or exception issue must include:

- Owner.
- Severity or risk impact.
- Target due date or expiration date.
- Remediation plan.
- Evidence links.
- Closure criteria.

## Public Issue Hygiene

Do not place the following in public issues:

- Secrets or tokens.
- Raw `.env` content.
- Database URLs.
- Private keys.
- Sensitive private IP/topology details.
- Exploit details that materially increase risk.
- Player personal data.

Use GitHub Security Advisories for sensitive security disclosures.

## Required Tracking Cadence

| Activity | Cadence | Issue requirement |
|---|---:|---|
| Access review | Monthly and before release candidate | Open an `Access review` issue and close it with evidence |
| SOC 2 evidence review | Monthly and before release candidate | Open `SOC 2 evidence gap` issues for missing/stale evidence |
| Vulnerability review | Every Trivy/Semgrep/Dependabot finding requiring action | Open or auto-sync `Vulnerability remediation` issues for non-trivial findings |
| STRIDE threat review | Every STRIDE scan with open medium/high/critical findings | Open or auto-sync `STRIDE threat remediation` issues |
| Security exceptions | As needed | Open `Security exception`; must include expiration and compensating controls |
| Release readiness | Every release candidate | Link related issues in release checklist |

## Automated Issue Sync

The repository includes automation for recurring security finding lifecycle tracking:

| Finding source | Script | Auto-created issue type | Auto-close behavior |
|---|---|---|---|
| Trivy/Semgrep vulnerability report | `scripts/sync-vulnerability-issues.mjs` | Vulnerability remediation | Closes resolved auto-tracked findings when they disappear from the latest report |
| STRIDE threat model report | `scripts/sync-stride-issues.mjs` | STRIDE threat remediation | Closes resolved auto-tracked threats when they are no longer open in the latest report |

Both sync scripts use stable hidden markers to prevent duplicate issues:

```text
dune-vuln-key:<hash>
dune-stride-key:<hash>
```

## Closure Rules

Issues may be closed only when one of these is true:

1. Fixed and linked to a commit or PR.
2. Risk accepted through a time-bound security exception.
3. Duplicate of another issue.
4. Not applicable with documented rationale.
5. Transferred to a more appropriate tracker with a durable link.
6. Auto-tracked finding is no longer present or no longer open in the latest scanner report.

## SOC 2 Readiness Mapping

| SOC 2 area | Issue evidence |
|---|---|
| Change management | Feature/bug issues linked to PRs and tests |
| Risk assessment | Severity, impact, threat category, and exception fields |
| Vulnerability management | CVSS, scanner source, fix version, remediation issue |
| Threat management | STRIDE category, asset, trust boundary, mitigation, and closure evidence |
| Access control | Access review issue evidence |
| Monitoring | Scheduled readiness and scanner workflow issues/findings |
| Incident response | Security issue or advisory plus follow-up remediation issues |

## Current Project Scope

The Discord companion bot remains read-only. Any issue proposing write, destructive, database mutation, player mutation, map mutation, addon mutation, credential, or Docker/service lifecycle behavior must be labeled for future review and must not be implemented without separate approval, threat model update, DAST cases, audit policy, and rollback plan.
