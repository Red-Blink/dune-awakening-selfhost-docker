# ADR-0001: Experimental Read-Only Discord Companion Bot

## Status

Accepted

## Date

2026-06-17

## Context

The Discord bot was initially discussed as a potential full-parity operator interface for Dune Docker Console. That approach creates a large security surface because it would expose high-impact operational controls through Discord.

The safer path is to start with an experimental companion bot that is read-only. This gives operators useful visibility while preserving the Console as the authority for authorization and safety checks.

## Decision

Build the Discord bot as an experimental read-only companion first.

The first release will focus on:

1. Server status.
2. Readiness.
3. Services.
4. Population.
5. Logs.
6. Map state.
7. Backup list/latest metadata.

The bot must call a protected Dune Console API adapter. It must not bypass the Console backend.

## Non-Negotiable Constraints

1. The bot must not mount the Docker socket.
2. The bot must not write directly to Postgres.
3. The bot must not directly access Postgres for destructive actions.
4. The bot must not store secrets in addon files, static files, source control, logs, or container layers.
5. The bot must not execute destructive actions.
6. The Console must remain responsible for final authorization and safety checks.
7. Logs must be capped, redacted, and role-gated.
8. Public responses must not expose internal topology, raw environment values, secrets, DB URLs, host paths, or stack traces.

## Security Considerations

The read-only approach reduces initial risk but does not remove risk entirely. Logs, population, backup metadata, and map state may still expose operationally sensitive data if mishandled.

Required controls:

- Dedicated Dune bot API token.
- Discord actor context on every request.
- Server-side capability checks.
- Public/admin response classification.
- Redaction layer for all output and errors.
- Audit events for all adapter requests, especially logs and diagnostics.
- Rate limits.
- DAST tests proving no write/destructive routes are exposed.

## SOC 2 Control Impact

Relevant controls:

```text
DC-SOC2-SEC-001
DC-SOC2-SEC-002
DC-SOC2-SEC-004
DC-SOC2-SEC-005
DC-SOC2-SEC-006
DC-SOC2-SEC-007
DC-SOC2-SEC-008
DC-SOC2-SEC-009
DC-SOC2-C-001
DC-SOC2-C-002
DC-SOC2-C-003
DC-SOC2-PI-001
DC-SOC2-P-001
```

## Consequences

### Positive

- Lower initial security risk.
- Faster path to useful operator visibility.
- Clearer testing and DAST scope.
- Avoids Discord-originated destructive actions.
- Keeps Dune Docker Console as the trusted backend authority.

### Negative / Tradeoffs

- Does not provide full WebUI parity in the initial release.
- Operators must still use the WebUI for all write/admin workflows.
- Some users may expect player or backup actions from Discord; these remain intentionally unavailable.

## Alternatives Considered

| Alternative | Reason Rejected |
| --- | --- |
| Full WebUI parity bot from day one | Too broad and high-risk for initial implementation. |
| Bot with direct Docker/Postgres access | Violates least privilege and creates major audit/security risk. |
| Static addon-only implementation | Current addon model is UI-only and cannot run a long-lived Discord bot daemon. |

## Evidence

- `docs/discord-control-bot/feature-priority.md`
- `docs/discord-control-bot/roadmap.md`
- `docs/discord-control-bot/api-adapter-contract.md`
- `docs/discord-control-bot/security-gates.md`
- `docs/discord-control-bot/soc2-control-matrix.md`
