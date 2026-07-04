# Core Discord Adapter Security Audit Summary

**Date:** 2026-07-04
**Scope:** `yacketrj/dune-awakening-selfhost-docker-WSL` (`release/discord-adapter-readonly`)

## Summary

The modular Discord adapter follows security-first design: disabled by default,
capability-based RBAC, bearer-token auth, audit events, and output sanitization.
All 220 `console/api` tests pass.

The highest-priority finding is a hardcoded fallback command-auth token in
`console/api/src/rmq.js` and `runtime/scripts/admin-tools.sh`. This is a real
secret embedded in source code and git history and must be removed or replaced
with generated secrets.

## Scanner Results

- Trivy filesystem: 5 misconfigurations (root users, missing HEALTHCHECK,
  apt-get missing `--no-install-recommends`)
- Semgrep: 12 findings (Dockerfile root users, RegExp DoS potential in web,
  dynamic urllib in orchestrator)
- Gitleaks: 17 leaks, of which 15 are fake Discord IDs in README examples and
  2 are the hardcoded command-auth token

## Critical Finding

**FINDING-CORE-1: Hardcoded fallback command-auth token (HIGH)**
- Files: `console/api/src/rmq.js:7`, `runtime/scripts/admin-tools.sh:12`
- Token: `[REDACTED-HARDCODED-TOKEN]`
- Recommendation: Remove the fallback. Make `DUNE_COMMAND_AUTH_TOKEN` required
  or generate a unique token at first boot in the generated/secrets volume.

## Other Findings

- Core Dockerfiles run as root and lack HEALTHCHECK.
- apt-get install lacks `--no-install-recommends`.
- Potential RegExp DoS in `console/web/src/features/server/ServerPanels.tsx`.
- Dynamic urllib use in `orchestrator/dune_orchestrator.py`.
- Gitleaks false positives in `docs/discord-control-bot/README.md` examples.

## Evidence

Scanner outputs are in `.security-audit/` on this branch:
`trivy-fs.json`, `semgrep.json`, `gitleaks.json`, `gitleaks-git.json`.

## Full Report

See the comprehensive audit in the Discord bot repo:
`docs/security-audit/2026-07-04-comprehensive-security-audit.md`
