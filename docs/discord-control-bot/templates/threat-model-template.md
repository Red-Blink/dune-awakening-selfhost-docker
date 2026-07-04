# Threat Model: Title

## Scope

Describe the feature, command, API route, or workflow being modeled.

## Assets

| Asset | Sensitivity | Notes |
| --- | --- | --- |
| Discord bot token | Critical | Runtime secret only |
| Dune bot API token | Critical | Runtime secret only |
| Player data | Sensitive | Avoid public channel exposure |
| Admin action capability | Critical | Requires server-side authorization |
| Audit logs | Sensitive | Must avoid secrets |

## Actors

| Actor | Trust Level | Notes |
| --- | --- | --- |
| Public Discord user | Untrusted | May invoke public commands only |
| Moderator | Partially trusted | Read-only/low-risk commands |
| Admin | Trusted admin | Controlled write commands |
| Owner | Highest privilege | Destructive commands |
| Bot process | Trusted client | Not final authority |
| Dune Console API adapter | Trusted authority | Enforces policy |

## Trust Boundaries

1. Discord to bot process.
2. Bot process to Dune Console API adapter.
3. API adapter to existing Console backend.
4. Console backend to Docker/Postgres/RabbitMQ.

## Data Flows

Describe request/response flow and where authorization, validation, confirmation, and audit occur.

## STRIDE Analysis

| Category | Threat | Mitigation | Test/Evidence |
| --- | --- | --- | --- |
| Spoofing | | | |
| Tampering | | | |
| Repudiation | | | |
| Information Disclosure | | | |
| Denial of Service | | | |
| Elevation of Privilege | | | |

## Abuse Cases

1. Unprivileged user attempts privileged command.
2. Admin targets wrong player or backup.
3. User replays an old confirmation interaction.
4. Malicious input attempts SQL, shell, path, or markdown injection.
5. Error response leaks secret or internal topology.

## Required Controls

- [ ] Server-side authorization.
- [ ] Input validation.
- [ ] Output redaction.
- [ ] Rate limiting.
- [ ] Idempotency.
- [ ] Confirmation.
- [ ] Audit logging.
- [ ] Rollback or recovery path.

## SOC 2 Control Mapping

```text
DC-SOC2-
```

## Residual Risk

Describe accepted residual risk and compensating controls.

## Review

| Reviewer | Role | Date | Outcome |
| --- | --- | --- | --- |
| | | | |
