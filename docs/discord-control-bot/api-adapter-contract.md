# Dune Console Discord API Adapter Contract

## Purpose

The Discord API Adapter is the protected server-side boundary between the experimental Discord companion bot and Dune Docker Console.

The initial adapter scope is read-only:

- Server status.
- Readiness.
- Services.
- Population.
- Logs.
- Map state.
- Backup list/latest metadata.

The bot must not call broad WebUI routes directly. It must call adapter routes that understand Discord actor context and enforce capability policy server-side.

## Design Requirements

1. The bot authenticates with a dedicated Dune bot API token, not the WebUI admin password.
2. Every request includes Discord actor context.
3. Every route enforces server-side capability authorization.
4. Public-safe responses must not expose internal IPs, SSH hosts, DB URLs, tokens, raw `.env`, stack traces, host paths, or backup filesystem paths.
5. The initial adapter exposes read-only routes only.
6. No destructive, write, credential, Docker lifecycle, database mutation, backup mutation, player mutation, addon mutation, or map mutation routes are in scope.
7. The adapter reuses existing Dune Console backend functions rather than duplicating privileged logic inside the bot.

## Explicitly Forbidden in Experimental Scope

1. Docker socket access from the bot.
2. Direct Postgres access from the bot.
3. Direct Postgres writes from any bot flow.
4. Backup create, restore, delete, import, or delete-all.
5. Player grants, kicks, teleport, refills, resets, or inventory mutation.
6. Broadcasts and shutdown broadcasts.
7. Map, sietch, or deep desert mutations.
8. Addon install, enable, disable, or remove.
9. Secret-setting workflows.
10. Any destructive action.

## Authentication

### Header

```http
Authorization: Bearer <dune-bot-api-token>
```

The token must be loaded by the bot from `DUNE_BOT_API_TOKEN_FILE` and validated server-side by the adapter.

### Rejected Patterns

- WebUI admin password as bot token.
- Discord bot token as Dune API token.
- Browser session cookie as bot auth.
- Query-string token.

## Required Actor Context

Every bot request must include a Discord actor context object.

```json
{
  "actor": {
    "guildId": "123456789",
    "channelId": "234567890",
    "userId": "345678901",
    "username": "admin-user",
    "roleIds": ["456789012"],
    "interactionId": "567890123",
    "commandName": "/dune status"
  }
}
```

## Role Tiers

| Tier | Intended Use |
| --- | --- |
| public | Basic non-sensitive status only. |
| observer | Low-risk status/readiness visibility. |
| moderator | Population, map state, backup metadata, and limited operational visibility. |
| admin | Logs and diagnostic read-only visibility. |
| owner | Reserved for future review; no owner-only write routes in experimental scope. |

## Experimental Capability Model

| Capability | Description | Minimum Tier |
| --- | --- | --- |
| `status:read` | Basic health/status visibility | public |
| `readiness:read` | Readiness checks | observer |
| `services:read` | Service list/status | observer |
| `population:read` | Population summary and online count | moderator |
| `logs:read` | Capped, redacted service logs | admin |
| `maps:read` | Map, sietch, and deep desert read-only status | moderator |
| `backups:read` | Backup list/latest metadata | moderator |

## Response Classification

| Class | Description | Allowed Fields |
| --- | --- | --- |
| public | Safe in public Discord channels. | High-level status, no internal topology. |
| moderator | Safe for moderator/admin channels. | Population and operational metadata with sensitive values removed. |
| admin | Safe only in admin channels or ephemeral admin responses. | Capped logs and diagnostics, always redacted. |

## Initial Adapter Routes

### `GET /api/integrations/discord/health`

Purpose: bot connectivity check.

Capability: `status:read`.

Response:

```json
{
  "ok": true,
  "service": "dune-console-discord-adapter",
  "experimental": true,
  "readOnly": true
}
```

### `POST /api/integrations/discord/status`

Purpose: sanitized stack status for Discord.

Capability: `status:read`.

### `POST /api/integrations/discord/readiness`

Purpose: readiness checks.

Capability: `readiness:read`.

### `POST /api/integrations/discord/services`

Purpose: service list and service status summary.

Capability: `services:read`.

Requirement: service names must come from an allowlist or backend-safe source.

### `POST /api/integrations/discord/population`

Purpose: population summary and online player count.

Capability: `population:read`.

Requirement: public output should be count-only unless detailed output is explicitly role-gated.

### `POST /api/integrations/discord/logs`

Purpose: capped, redacted service logs.

Capability: `logs:read`.

Requirements:

1. Service name validation.
2. Line limit.
3. Redaction.
4. Admin-channel or ephemeral response recommended.
5. No raw `.env`, tokens, DB URLs, host paths, or stack traces.

### `POST /api/integrations/discord/map-state`

Purpose: map, sietch, and deep desert read-only state.

Capability: `maps:read`.

### `POST /api/integrations/discord/backups/list`

Purpose: backup list/latest metadata.

Capability: `backups:read`.

Requirements:

1. No backup create/restore/delete/import/delete-all.
2. No raw filesystem paths in public responses.
3. Output capped and paginated.

## Audit Event Requirements

Every adapter request should be auditable. Read-only requests may use lower-risk audit records, but logs and detailed diagnostics should always be audited.

Required fields:

```json
{
  "source": "discord",
  "discordGuildId": "...",
  "discordChannelId": "...",
  "discordUserId": "...",
  "discordUsername": "...",
  "command": "/dune logs",
  "action": "logs.read",
  "capability": "logs:read",
  "risk": "low|medium",
  "targetType": "service|server|map|backup|population",
  "targetId": "...",
  "result": "success|failed|blocked"
}
```

## Error Contract

Errors must be redacted and safe to display.

```json
{
  "ok": false,
  "error": "Not authorized for logs:read.",
  "code": "not_authorized"
}
```

Forbidden in errors:

- Raw stack traces.
- Raw SQL errors containing secrets.
- Raw environment variables.
- Discord or Dune tokens.
- Internal DB URLs.
- Funcom token values.
- Internal IPs or SSH hosts.
- Raw host paths.

## DAST Requirements

The adapter must have runtime tests for:

1. Missing token rejected.
2. Invalid token rejected.
3. Missing actor rejected.
4. Unauthorized role rejected.
5. Public status sanitizes internal topology.
6. Diagnostic/log output requires admin capability.
7. Logs are capped and redacted.
8. Backup routes are metadata-only.
9. No write/destructive adapter routes are exposed.
10. Secret-like values are redacted from errors and audit details.
