# Dune Discord Control Bot - Development Standards

## Purpose

This document defines the engineering standards for the Discord Control Bot and its Dune Console API adapter. The upstreamable scope is a read-only Discord companion that provides safe operational visibility. Full WebUI parity, moderator write commands, evidence automation, and compliance artifact generation remain separate fork-local or future work unless explicitly approved upstream.

## Core Engineering Standards

1. Keep Discord client logic separate from Dune Console API adapter logic.
2. Do not duplicate privileged WebUI backend logic inside the bot.
3. Do not add Discord write/mutation commands in the read-only release.
4. Prefer allowlists over denylists for service names, command names, file paths, and action types.
5. Use structured logging with redaction.
6. Treat all Discord inputs as untrusted.
7. Test authorization behavior before feature completeness.
8. Require PR review before merge.
9. Update setup, usage, and role-matrix documentation when behavior changes.
10. Keep generated artifacts, runtime state, passwords, tokens, and evidence bundles out of upstream PRs.

## Architecture Standards

### Required Separation of Concerns

| Layer | Responsibility | Must Not Do |
| --- | --- | --- |
| Discord Bot Client | Discord connection, slash commands, interaction UX, formatting | Final authorization, direct Docker control, direct destructive DB writes |
| Dune Console Discord API Adapter | Bot auth, server-side authorization, audit, safe read-only routing | Expose broad unauthenticated WebUI APIs |
| Existing Console Backend | Reuse WebUI read paths and safety behavior | Trust Discord client-only checks |
| Dune Stack | Existing Docker/Postgres/RabbitMQ/game services | Accept direct unreviewed bot mutations |

## Secure Coding Standards

### Input Validation

All input from Discord, HTTP requests, environment variables, files, and database queries must be validated before use.

Required patterns:

- Validate command names against allowlists.
- Validate role IDs and channel IDs as strings, never as trusted authorization claims.
- Validate service names against known service allowlists.
- Validate file paths with safe relative path helpers where file reads are required.
- Validate numeric ranges for ports, limits, counts, and timeouts.

### Output Handling

1. Redact secrets before logging or sending responses.
2. Public Discord responses must not include internal IPs, SSH hosts, DB URLs, tokens, raw `.env` values, or stack traces.
3. Admin diagnostic output must require admin/owner capability.
4. Large responses must be paginated or summarized.
5. Errors must use safe messages.
6. Discord responses must set `allowed_mentions: { parse: [] }` unless a future feature explicitly needs mentions and has a separate review.

### Command Execution

1. The bot must not use `child_process.exec` for Discord-originated actions.
2. The bot must not spawn shell commands for admin actions.
3. Backend execution must use existing Console backend wrappers.
4. If process execution is required in backend code, use fixed command paths and argument arrays; avoid shell interpolation.

### Database Access

1. The bot must not connect directly to Postgres.
2. The read-only release must not add database write behavior.
3. Any future database write feature must be separately approved, owner-only, typed-confirmed, audited, rate-limited, and backed up first where supported.
4. Do not concatenate user input into SQL statements.

### Secrets

1. Use file-based runtime secrets: `*_TOKEN_FILE`, `*_PASSWORD_FILE` where possible.
2. Do not commit `.env` files containing secrets.
3. Do not store the Discord bot token in addon files, static WebUI addon files, source files, tests, docs, logs, or container layers.
4. Do not echo secrets in Discord.
5. Do not log request bodies that may contain secrets.
6. Do not upstream generated runtime state, local evidence bundles, vulnerability artifacts, passwords, tokens, or session secrets.

## Branching and Pull Request Standards

### Branch Naming

Use descriptive branches:

```text
feature/discord-control-bot
feature/discord-api-adapter
security/discord-authz-gates
fix/discord-redaction-leak
```

### Pull Request Requirements

Every upstream PR must include:

1. Purpose summary.
2. Risk classification.
3. Test evidence.
4. Security impact statement.
5. Rollback plan.
6. Screenshots/log snippets if user-facing behavior changes.
7. Updated docs if behavior or controls change.
8. Confirmation that no generated runtime files, artifacts, passwords, or secrets are included.

Privileged future-feature PRs must also include:

1. Threat model update.
2. Authorization matrix update.
3. Confirmation matrix update.
4. Audit event mapping.
5. DAST test cases.
6. Explicit owner approval.

## Definition of Done

A feature is not done until all applicable items are complete:

```text
[ ] Code is reviewed.
[ ] Unit tests pass.
[ ] Authorization tests pass.
[ ] Redaction tests pass.
[ ] Secret scan passes.
[ ] Container checks pass if container files changed.
[ ] Documentation is updated.
[ ] Rollback path is documented.
[ ] Upstream diff excludes generated artifacts, runtime state, passwords, tokens, and local evidence bundles.
```

## Testing Standards

### Required Test Layers

| Test Type | Required For |
| --- | --- |
| Unit tests | All modules |
| Authorization matrix tests | Every command and API route |
| Redaction tests | All logging and response formatting |
| Integration tests | API adapter and bot client interaction |
| Container tests | Dockerfile and Compose changes |
| Regression tests | Every fixed security issue |

### Test Naming

Tests should describe policy intent:

```text
redacts postgres connection string in error output
rejects unmapped observer command
blocks write-capable Discord command registration
blocks Docker socket mount in bot compose
```

## Logging Standards

Use structured logs. Required fields where applicable:

```json
{
  "service": "dune-discord-companion-bot",
  "event": "command.received",
  "discordGuildId": "...",
  "discordChannelId": "...",
  "discordUserId": "...",
  "command": "/dune status",
  "result": "success|failed|blocked"
}
```

Forbidden in logs:

- Discord bot token.
- Dune bot API token.
- Admin password.
- Database password.
- Funcom token.
- Full database URL.
- Raw `.env` file content.
- Full request body for secret-bearing routes.

## Audit Standards

Every Discord-originated adapter request should emit an audit event with:

1. Source: `discord`.
2. Discord actor context.
3. Command and normalized action.
4. Target object, if any.
5. Risk level.
6. Authorization decision.
7. Result.
8. Error reason if blocked or failed.

## Release Standards

A release candidate requires:

1. Passing tests.
2. Passing secret scan.
3. Passing container checks if container files changed.
4. Release notes.
5. Rollback instructions.
6. No open critical/high security findings unless exception is approved and time-bound.

## Exception Handling

Security exceptions must include:

1. Finding ID.
2. Affected component.
3. Risk rating.
4. Reason for exception.
5. Compensating controls.
6. Owner.
7. Expiration date.
8. Review cadence.

Permanent exceptions are not allowed for critical or high-risk findings.
