# Dune Discord Companion Bot - Feature Priority Plan

## Product Goal

Build an experimental Discord companion bot for Dune Docker Console that starts read-only and provides safe operational visibility for server operators.

The initial bot is not a full WebUI replacement. It is a companion interface for status, readiness, and service visibility. Dune Docker Console remains the authority for backend authorization, safety checks, redaction, audit logging, and execution.

## Initial Upstream Scope

| Domain | Initial Commands / Functions | Risk |
| --- | --- | --- |
| Status | `/dune status public`, `/dune status detail`, `/dune health`, `/dune version` | Low/Medium due diagnostic split |
| Readiness | `/dune readiness` | Low |
| Services | `/dune services` | Low/Medium |
| Help | `/dune help` | Low |
| Setup helpers | OAuth install URL, guild/channel/role discovery, channel permission helper | Medium due Discord permission changes |

## Out of Scope for the Experimental Upstream Bot

The following are explicitly out of scope until the read-only bot is stable, reviewed, and separately approved:

1. Docker socket mounting.
2. Direct database access from the bot process.
3. Backup create, restore, delete, or delete-all.
4. Player grants, teleport, kick, refill, reset progression, or inventory mutation.
5. Broadcasts and shutdown broadcasts.
6. Map, sietch, or deep desert mutation.
7. Addon install, enable, disable, or remove.
8. Credential-setting workflows.
9. Any destructive action.
10. Fork-local evidence automation, generated scan outputs, and local runtime state.

## Priority Model

| Priority | Meaning |
| --- | --- |
| P0 | Foundational security, protected Console API contract, redaction, and authorization tests. |
| P1 | Experimental read-only companion bot: status, health, readiness, and services. |
| P2 | Operational hardening: pagination, redaction tuning, rate limits, audit review, role/channel mapping UI, alerting. |
| P3 | Separately approved non-destructive admin conveniences, if any, after a security review. |
| P4 | Future platform evolution. Full WebUI parity remains a long-term option, not the current delivery target. |

## P0 - Security Foundation and Delivery Gates

These must be implemented before connecting the bot to Discord or exposing adapter routes.

1. Dedicated branch and isolated bot workspace.
2. Secure configuration contract for Discord and Console credentials.
3. Redaction library for sensitive output, connection strings, host paths, and sensitive headers.
4. Discord actor context model: guild ID, channel ID, user ID, username, roles, command, interaction ID.
5. Role-to-capability authorization model.
6. Read-only capability enforcement for experimental routes.
7. Audit event schema for Discord-originated adapter requests.
8. Rate-limit and idempotency design for slash commands.
9. Architecture documentation that prohibits Docker socket access and direct database writes from the bot.
10. Setup helpers that avoid manual ID hunting.

## P1 - Experimental Read-Only Bot

The first working bot release should expose only read-only commands.

| Domain | Commands / Functions | Required Control |
| --- | --- | --- |
| Health | `/dune health`, `/dune version` | Public-safe sanitized output |
| Status | `/dune status public`, `/dune status detail` | Public/admin response split |
| Readiness | `/dune readiness` | Observer capability |
| Services | `/dune services` | Observer capability, no raw Docker access |
| Setup | `discord:invite`, `discord:discover`, `discord:channel` | Local operator execution only; no credential output |

## P2 - Operational Hardening

1. Public/admin channel classification.
2. Response pagination and message-size enforcement.
3. Per-command rate limits.
4. Audit review command or export.
5. Bot heartbeat and health dashboard.
6. Role/channel mapping management in WebUI.
7. Alerting for status changes, backup failures, and readiness degradation.
8. Emergency disable flag for all Discord-originated calls.

## P3 - Separately Approved Non-Destructive Enhancements

These require explicit approval and updated threat modeling:

1. Scheduled status posts.
2. Maintenance notice posts to Discord only, not in-game broadcast.
3. Owner-only diagnostic bundles with strict redaction.

## Non-Negotiable Security Requirements

1. The bot container must not mount `/var/run/docker.sock`.
2. The bot must not execute destructive actions.
3. The bot must not directly write to the database.
4. The bot must not store credentials in addon files, browser-delivered files, source control, logs, or container layers.
5. Backend authorization must be enforced server-side, not only in the Discord client.
6. The Console API must remain responsible for final authorization and safety checks.
7. Public Discord responses must not expose internal IPs, SSH targets, database URLs, raw environment files, stack traces, or host paths.
8. Logs must be capped, redacted, and role-gated if log visibility is added later.
9. Generated artifacts and local runtime state must not be included in upstream PRs.
