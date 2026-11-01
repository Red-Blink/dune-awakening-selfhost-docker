# Dune Console Discord API Adapter Contract

**Status:** Current | **Last Updated:** November 2026

## Purpose

The Discord API Adapter is the protected server-side boundary between a Discord companion bot (maintained outside this repository) and Dune Docker Console. Operator setup is in [discord-integration/README.md](../discord-integration/README.md).

The adapter is read-mostly. Its live routes cover:

- Server status, readiness, services, maintenance (readiness output), version, servers, ports and database health.
- Population, map state, announcements and backup list metadata.
- Capped, redacted service logs.
- Operational summaries (`ops/activity`, `combat`, `resources`, `economy`, `inventory`, `soc`, `prometheus`).
- Player link, unlink, identity, inventory, storage and item search, and guild storage and search for a linked player.
- An opt-in in-game broadcast.

The authoritative route list, minimum tier per command and parameters come from `GET /api/integrations/discord/catalog` (bearer token only, `protocolVersion` 2). The health response also reports `liveRoutes` and `plannedRoutes`.

The bot must not call broad WebUI routes directly. It must call adapter routes that understand Discord actor context and enforce capability policy server-side.

## Design Requirements

1. The bot authenticates with a dedicated Dune bot API token, not the WebUI admin password.
2. Every route except `health`, `catalog`, `version` and `backups/list` takes Discord actor context and enforces capability authorization server-side.
3. Public-safe responses must not expose internal IPs, SSH hosts, DB URLs, tokens, raw `.env`, stack traces, host paths, or backup filesystem paths.
4. The only writes are:
   - Player-link bookkeeping in the console's own `dune.discord_player_links` and `dune.discord_pending_links` tables (`player-link:write`, moderator and above). Linking also whispers a verification code to the online player.
   - `POST /broadcast` (`broadcast:send`, admin and owner), available only when `DUNE_DISCORD_WRITES_ENABLED` is true on the console. `health` reports this as `writesEnabled`.
5. No other game-data mutation, destructive action, credential, Docker lifecycle, backup mutation, player mutation, addon mutation or map mutation route exists.
6. The adapter reuses existing Dune Console backend functions rather than duplicating privileged logic inside the bot.

## Out of Scope

1. Docker socket access from the bot.
2. Direct Postgres access from the bot.
3. Backup create, restore, delete, import, or delete-all.
4. Player grants, kicks, teleport, refills, resets, or inventory mutation.
5. Map, sietch, or deep desert mutations.
6. Addon install, enable, disable, or remove.
7. Secret-setting workflows.

## Authentication

### Header

```http
Authorization: Bearer <dune-bot-api-token>
```

Every route, including `health` and `catalog`, requires the token. The console reads it from `DUNE_DISCORD_ADAPTER_TOKEN`, then `DUNE_DISCORD_ADAPTER_TOKEN_FILE`, then `DUNE_BOT_API_TOKEN_FILE`. Without a configured token the adapter answers 503. A missing or wrong token answers 401. A disabled adapter answers 404.

### Rejected Patterns

- WebUI admin password as bot token.
- Discord bot token as Dune API token.
- Browser session cookie as bot auth.
- Query-string token.

## Required Actor Context

Every bot request to an actor-taking route (see Design Requirements) must include a Discord actor context object.

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
| observer | Status, readiness, services and infrastructure checks. |
| moderator | Observer plus population, map state, announcements, player link and linked-player inventory, storage and guild routes. |
| admin | Everything, including diagnostic status, logs, `ops/*` and broadcast. |
| owner | Same capabilities as admin. |

A request whose actor holds none of the configured role IDs is public. If no role IDs are configured, every actor is public.

## Capability Model

Defined in `console/api/src/integrations/discord/policy.js`.

| Capability | Description | Minimum Tier |
| --- | --- | --- |
| `status:read` | Basic status | public |
| `readiness:read` | Readiness checks, maintenance route | observer |
| `services:read` | Service list/status, `servers`, `ports`, `db` | observer |
| `population:read` | Population summary and online count | moderator |
| `maps:read` | Map state and announcements | moderator |
| `backups:read` | Backup list metadata (the route itself is bearer-only) | moderator |
| `inventory:read` | Linked player identity, inventory and item search | moderator |
| `storage:read` | Linked player storage | moderator |
| `guild:read` | Guild storage and search | moderator |
| `player-link:write` | Link, verify and unlink | moderator |
| `logs:read` | Capped, redacted service logs; diagnostic status | admin |
| `ops:activity:read`, `ops:combat:read`, `ops:resources:read`, `ops:economy:read`, `ops:inventory:read`, `ops:soc:read`, `ops:prometheus:read` | `ops/*` routes | admin |
| `broadcast:send` | In-game broadcast (also needs `DUNE_DISCORD_WRITES_ENABLED`) | admin |

## Response Classification

| Class | Description | Allowed Fields |
| --- | --- | --- |
| public | Safe in public Discord channels. | High-level status, no internal topology. |
| moderator | Safe for moderator/admin channels. | Population and operational metadata with sensitive values removed. |
| admin | Safe only in admin channels or ephemeral admin responses. | Capped logs and diagnostics, always redacted. |

## Adapter Routes

Routes below are described in detail. Routes not detailed here (`maintenance`, `announcements`, `version`, `servers`, `ports`, `db`, `ops/*`, `broadcast`, `players/*`, `guilds/*`) are listed with their command, capability and parameters by `GET /api/integrations/discord/catalog`.

### `GET /api/integrations/discord/health`

Purpose: bot connectivity check.

Authorization: bearer token only; no actor and no capability check.

Response:

```json
{
  "ok": true,
  "service": "dune-console-discord-adapter",
  "enabled": true,
  "experimental": true,
  "readOnly": false,
  "gameDataWritesEnabled": false,
  "adapterDataWrites": ["player-link"],
  "writesEnabled": false,
  "routes": ["..."],
  "liveRoutes": ["..."],
  "plannedRoutes": ["..."],
  "rolePolicy": {
    "observerConfigured": true,
    "moderatorConfigured": false,
    "adminConfigured": true,
    "ownerConfigured": false
  },
  "protocolVersion": 2
}
```

### `GET /api/integrations/discord/catalog`

Purpose: machine-readable command catalog (group, subcommand, capability, minimum tier and parameters for every live route).

Authorization: bearer token only. It describes route shape, not game or player data.

### `POST /api/integrations/discord/status`

Purpose: sanitized stack status for Discord.

Capability: `status:read`; with `diagnostic: true`, `logs:read`.

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

### `GET /api/integrations/discord/backups/list`

Purpose: backup list metadata (up to 100 rows).

Authorization: bearer token only. The route takes no actor and does not currently enforce `backups:read`.

Requirements:

1. No backup create/restore/delete/import/delete-all.
2. No raw filesystem paths in responses.
3. Output capped.

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
9. The only write routes are player link/verify/unlink and `broadcast`; broadcast is rejected unless writes are enabled and the actor is admin or owner.
10. Secret-like values are redacted from errors and audit details.
