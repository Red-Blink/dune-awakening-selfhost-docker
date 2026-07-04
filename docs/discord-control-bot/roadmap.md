# Dune Discord Companion Bot - Detailed Prioritized Roadmap

## Roadmap Objective

Deliver an experimental Discord companion bot for Dune Docker Console that provides safe, read-only operational visibility first. The initial target is not full WebUI parity. The bot starts with server status, readiness, services, population, logs, map state, and backup list.

Dune Docker Console remains the authority for backend authorization, safety checks, redaction, audit logging, and execution. The bot must call a protected Console API and must not directly control Docker, write to Postgres, store secrets in addon/static files, or execute destructive actions.

## Guiding Principles

1. Security gates first; functionality second.
2. Experimental scope is read-only.
3. Console API owns final authorization and safety checks.
4. The bot must not mount the Docker socket.
5. The bot must not write directly to Postgres.
6. The bot must not execute destructive actions.
7. The bot must not store secrets in addon files, source control, logs, or image layers.
8. Logs must be capped, redacted, and role-gated.
9. Public responses must not expose internal topology or secrets.
10. SOC 2 readiness evidence must be produced as part of normal engineering work.

## Milestone P0.1 - Project Foundation

### Goal

Create the isolated bot workspace and security-first delivery framework.

### Deliverables

- `discord-bot/` workspace.
- Security-gates workflow.
- Feature-priority document.
- Roadmap document.
- Development standards document.
- SOC 2 control matrix.
- Hardened Dockerfile scaffold.
- Secure Compose scaffold.
- Secret scanning script.
- Redaction helper.
- Authorization model.
- Secure config contract.

### Acceptance Criteria

- Branch contains isolated bot workspace.
- Bot does not connect to Discord yet.
- Bot does not expose write commands.
- CI blocks Docker socket references in bot assets.
- CI blocks privileged container mode.
- CI requires lockfile.
- CI executes unit/security tests.
- CI runs SCA, SAST, and container scan gates.
- README states the bot is experimental and read-only first.

### Evidence

- Passing GitHub Actions run.
- Commit diff showing workspace isolation.
- Security-gates documentation.
- Local command output from `npm test`, `npm run security:secrets`, and Docker build.

## Milestone P0.2 - Engineering Standards and Governance

### Goal

Establish development practices required for secure and auditable delivery.

### Deliverables

- Branch strategy.
- PR template.
- CODEOWNERS or reviewer policy.
- Commit and PR naming conventions.
- Definition of Done.
- Security review checklist.
- Threat-model template.
- Architecture Decision Record template.
- Test strategy.
- Release checklist.

### Acceptance Criteria

- Every bot PR includes test evidence.
- Every adapter route PR includes authorization and audit tests.
- Every dependency addition passes dependency review.
- Every Docker or Compose change passes DCA checks.
- Any proposal to add write behavior requires a separate threat model and explicit approval.

### Evidence

- PR template.
- ADR template.
- Threat-model template.
- Security review checklist.

## Milestone P0.3 - Protected Console API Adapter Contract

### Goal

Define the backend API contract before implementing Discord commands.

### Deliverables

- Experimental read-only route inventory.
- Bot API token authentication model.
- Discord actor context schema.
- Role/capability policy schema.
- Audit event schema.
- Error/redaction response contract.
- Public/admin response classification.
- Explicit no-destructive-action contract.

### Acceptance Criteria

- No bot command calls broad WebUI endpoints directly.
- Every adapter route is read-only.
- Every adapter route has a capability requirement.
- Every route has safe error handling.
- Logs route is capped, redacted, and role-gated.
- Backup route exposes list/latest metadata only; no create/restore/delete.

### Evidence

- API contract document.
- Authorization matrix.
- Read-only route matrix.
- Adapter policy tests.
- Sanitization tests.
- Audit event tests.

## Milestone P0.4 - Compliance and Evidence Automation

### Goal

Make evidence generation part of normal CI and release workflows.

### Deliverables

- CI artifact retention policy.
- SBOM generation.
- Dependency vulnerability report.
- Container vulnerability report.
- Test report output.
- Security scan report output.
- Release checklist artifact.
- SOC 2 evidence index.

### Acceptance Criteria

- CI produces evidence for each release candidate.
- Evidence is mapped to SOC 2 control areas.
- Failed gates prevent merge or release.
- Exceptions require documented owner, risk, mitigation, and expiration.

### Evidence

- SBOM artifact.
- SCA report.
- SAST report.
- DCA report.
- DAST report once runtime exists.
- Test reports.
- Release approval record.

## Milestone P1.1 - Bot Client Skeleton

### Goal

Add Discord connection without administrative or destructive functionality.

### Deliverables

- `discord.js` dependency.
- Discord client bootstrap.
- Slash command registration framework.
- Interaction handler.
- Secure logger.
- Rate-limit middleware.
- Safe error formatter.
- `/dune help` command.
- `/dune version` command.

### Acceptance Criteria

- Bot starts with file-based secrets.
- Bot does not log tokens.
- Bot exposes no write commands.
- Bot replies only with sanitized responses.
- Bot handles Discord errors without leaking stack traces.

### Evidence

- Unit tests.
- Redaction tests.
- Secret scan output.
- Local runtime smoke output.

## Milestone P1.2 - Read-Only Status, Readiness, and Services

### Goal

Deliver the first useful read-only operational commands.

### Deliverables

- `/dune status`.
- `/dune health`.
- `/dune readiness`.
- `/dune services`.
- `/dune service status`.
- Public/admin response split.
- Sanitized status output.
- Diagnostic mode for admin/owner only.

### Acceptance Criteria

- Public status does not expose internal IPs, SSH hosts, DB URLs, tokens, raw environment values, or host paths.
- Admin diagnostic status requires admin/owner capability.
- Backend adapter enforces capability checks.
- Service names are validated against an allowlist or backend-safe source.
- Errors are redacted.

### Evidence

- Unit tests.
- Authorization matrix tests.
- DAST auth tests once adapter runs.

## Milestone P1.3 - Read-Only Population and Logs

### Goal

Expose useful server visibility without allowing moderation or mutation.

### Deliverables

- `/dune population`.
- `/dune players online` summary.
- `/dune logs service:<service>`.
- Log line caps.
- Log redaction.
- Role-gated detailed output.

### Acceptance Criteria

- Player details are not posted in public channels unless explicitly configured.
- Population summary can be public-safe.
- Detailed player visibility requires moderator/admin/owner.
- Logs require moderator/admin/owner.
- Logs are capped, redacted, and never include secrets, tokens, raw `.env`, DB URLs, or internal paths.

### Evidence

- Unit tests.
- Authorization tests.
- Redaction tests.
- Response-size tests.

## Milestone P1.4 - Read-Only Map State and Backups

### Goal

Complete the experimental read-only companion scope.

### Deliverables

- `/dune map status`.
- `/dune sietches status`.
- `/dune deepdesert status`.
- `/dune backups list`.
- `/dune backups latest`.

### Acceptance Criteria

- Map state is read-only.
- Backup output is metadata-only.
- No backup create, restore, delete, import, or delete-all endpoints are exposed.
- Backup paths are not exposed in public Discord responses.
- Responses are capped and paginated.

### Evidence

- Route tests.
- Authorization tests.
- Sanitization tests.

## Milestone P2 - Operational Hardening

### Goal

Improve safety and usability before considering any non-read-only behavior.

### Deliverables

- Bot heartbeat dashboard.
- Alerting for status/readiness changes.
- Alerting for backup failure or stale backups.
- Per-command rate limits.
- Public/admin channel mapping.
- WebUI management surface for role/channel mapping.
- Emergency disable flag for all Discord-originated requests.
- SOC 2 evidence review.

### Acceptance Criteria

- Alerts are deduplicated and rate-limited.
- Bot failure does not affect WebUI.
- Evidence package maps to SOC 2 readiness controls.
- Emergency disable can block all bot-originated calls.

## Milestone P3 - Future Review Gate

### Goal

Decide whether to remain read-only or propose limited non-destructive admin conveniences.

### Rule

No write, destructive, credential, database mutation, addon mutation, player mutation, map mutation, or Docker/service lifecycle action may be added without:

1. Separate approval.
2. Threat model update.
3. SOC 2 control matrix update.
4. DAST cases.
5. Confirmation policy.
6. Audit policy.
7. Rollback plan.

Future moderator commands and two-way chat are explicitly post-read-only roadmap candidates. They are not part of the experimental read-only release and require their own design review before implementation.

## Milestone P4 - Guarded Game Moderator Commands

### Goal

Evaluate whether trusted game moderators should receive a controlled command surface for in-game moderation actions through Discord and/or an approved in-game command bridge.

Example moderator use cases under consideration:

```text
/kick playerid
/spawn vehicle
```

This milestone is exploratory. It must not be implemented as raw command passthrough from Discord to the game server. Console API must remain the execution authority, and every action must be authorized, validated, audited, rate-limited, and reversible where practical.

### Candidate Deliverables

- Moderator role/capability model separate from observer/admin/owner visibility roles.
- Dedicated capability names for each moderator action, for example `player:kick` or `vehicle:spawn`.
- Strict target validation by immutable player ID or backend-resolved player identity.
- Command allowlist; no arbitrary console command passthrough.
- Reason codes and optional moderator notes for player-impacting actions.
- Confirmation flow for disruptive actions.
- Cooldowns and abuse-rate controls per moderator, command, and target.
- Full audit events with actor, Discord user, mapped game moderator identity, command, target, reason, timestamp, and result.
- Emergency kill switch for all moderator command execution.
- Dry-run/test mode for validation before live enablement.

### Acceptance Criteria

- Moderator commands are disabled by default.
- Every command has a server-side capability requirement.
- Discord role checks are not trusted as the only authorization layer.
- Raw command strings cannot be supplied by users.
- Player IDs, vehicle IDs, and enum arguments are validated against backend-safe sources.
- All moderator actions produce tamper-evident audit records.
- Failed authorization and failed validation attempts are logged safely.
- Abuse controls prevent command spam or repeated targeting.
- Security review confirms no path to Docker, database, addon, credential, or host-level mutation.

### Evidence

- Threat model for moderator actions.
- Updated SOC 2 control matrix.
- Authorization matrix tests.
- Audit event tests.
- DAST authorization and misuse tests.
- Operator runbook.
- Approved security exception for any high-risk action that cannot be made reversible.

## Milestone P5 - Two-Way Discord and In-Game Chat Bridge

### Goal

Design an opt-in chat bridge that lets in-game players and Discord users communicate across a mapped channel without requiring everyone to be in the same client.

Target behavior:

```text
Discord -> Game Chat
A message sent in an approved Discord channel appears in the mapped in-game chat channel.

Game Chat -> Discord
A message sent in an approved in-game chat channel appears in the mapped Discord channel.
```

This bridge is for chat only. It must not become a command injection path, moderation bypass, or raw console command relay.

### Candidate Deliverables

- Discord channel to in-game chat channel mapping.
- Direction controls: Discord-to-game, game-to-Discord, or bidirectional.
- Message identity format, for example `[Discord] Name:` and `[Game] Player:`.
- Abuse controls: rate limits, message length caps, attachment policy, mention suppression, and flood protection.
- Mention and markdown sanitization before sending Discord content in-game.
- In-game formatting sanitization before sending game chat to Discord.
- Optional allowlist for Discord roles and in-game channels.
- Optional profanity/spam/moderation filter hook.
- Loop prevention so bridged messages are not echoed back repeatedly.
- Audit/logging for bridged messages without storing secrets or unnecessary personal data.
- Admin-visible health/status for the bridge.
- Emergency disable flag for chat bridge only.

### Acceptance Criteria

- Chat bridge is disabled by default.
- Channel mappings are explicit and auditable.
- Bot never forwards Discord bot tokens, environment values, internal URLs, or host paths.
- Discord mentions are suppressed or safely escaped before in-game delivery.
- In-game chat cannot trigger Discord slash commands or bot admin actions.
- Discord messages cannot trigger in-game admin/moderator commands.
- Bridge respects configured directionality.
- Message loops are prevented.
- Rate limits and caps protect both Discord and the game server.
- Operators can disable the bridge without disabling the WebUI.

### Evidence

- Chat bridge architecture decision record.
- Updated STRIDE model covering spoofing, tampering, repudiation, information disclosure, denial of service, and elevation of privilege.
- Channel mapping tests.
- Sanitization tests.
- Loop-prevention tests.
- Abuse-rate tests.
- Operator runbook.

## Roadmap Exit Criteria for Experimental Release

The experimental read-only release is complete when:

1. Status, readiness, services, population, logs, map state, and backup list are available through Discord.
2. Every command maps to a read-only capability and role requirement.
3. No write or destructive route exists in the bot or adapter.
4. Logs are capped, redacted, and role-gated.
5. Public responses do not leak internal topology or secrets.
6. SCA, SAST, DCA, DAST, secret scanning, and adapter tests pass.
7. SOC 2 readiness evidence exists for the experimental release.
8. The bot can be disabled without impacting WebUI.
