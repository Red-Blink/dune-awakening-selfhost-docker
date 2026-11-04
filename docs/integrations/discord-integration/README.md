# Discord Adapter — Setup and Configuration

**Status:** Current | **Last Updated:** November 2026

> **Which Discord docs do I want?** This folder (`discord-integration/`) is the
> **operator-facing** set — start here if you are setting up Discord on your server.
> The sibling folder [`discord-control-bot/`](../discord-control-bot/api-adapter-contract.md)
> holds the console-side adapter contract plus historical bot prototype guides.
> The adapter code and the live command catalog (`GET /api/integrations/discord/catalog`)
> are authoritative; where any doc disagrees with them, they win.

The Dune Docker Console includes a built-in Discord adapter that lets you
connect a companion Discord bot for server monitoring and management.

## What the Adapter Does

The adapter exposes a set of API routes that a Discord bot (or any bearer-token
authenticated client) can call to get server status and data. It is:

- **Disabled by default** — must be explicitly enabled
- **Read-mostly** — routes return data; the only writes are (a) player-link
  bookkeeping in the console's own `dune.discord_player_links` and
  `dune.discord_pending_links` tables (linking also whispers a verification code
  to the online player) and (b) `/broadcast`, which is disabled unless
  `DUNE_DISCORD_WRITES_ENABLED=true`. No route mutates other game data.
- **Bearer-token protected** — every request requires a shared secret token
- **Role-gated** — you can restrict which Discord roles can access which data

## Quick Enable (3 Steps)

### 1. Set Environment Variables

Set these in the repo's `.env`. `docker-compose.web.yml` already forwards them to
the console, so do not add them to the compose file a second time (duplicate keys
make Compose reject the file):

```bash
DUNE_DISCORD_ADAPTER_ENABLED=true
DUNE_BOT_API_TOKEN_FILE=/repo/runtime/secrets/bot-api-token.txt
DISCORD_OBSERVER_ROLE_IDS=role-id-1,role-id-2
DISCORD_ADMIN_ROLE_IDS=role-id-1
```

Instead of the token file you can set `DUNE_DISCORD_ADAPTER_TOKEN`; it takes
precedence over the file. The stock compose file forwards only these two token
variables.

### 2. Create the Token File

```bash
mkdir -p runtime/secrets
echo -n "your-random-token-here" > runtime/secrets/bot-api-token.txt
chmod 600 runtime/secrets/bot-api-token.txt
```

### 3. Rebuild the Console

```bash
docker compose -f docker-compose.web.yml up -d --build redblink-dune-docker-console
```

## Verify It's Working

```bash
TOKEN=$(cat runtime/secrets/bot-api-token.txt)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8088/api/integrations/discord/health
```

Expected response:
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
  "routes": ["/api/integrations/discord/health", ...],
  "liveRoutes": [...],
  "plannedRoutes": [...],
  "rolePolicy": { "observerConfigured": true, ... },
  "protocolVersion": 2
}
```

## Routes

Every route requires the bearer token. "Access" is the minimum role tier the
request's `actor` needs (see RBAC below). POST routes take an `actor` object in
the body.

| Route | Method | Description | Access |
|-------|--------|-------------|--------|
| `/api/integrations/discord/health` | GET | Adapter health and route listing | Bearer token only |
| `/api/integrations/discord/catalog` | GET | Machine-readable command catalog (authoritative route and tier list) | Bearer token only |
| `/api/integrations/discord/version` | GET | Dune stack version | Bearer token only |
| `/api/integrations/discord/backups/list` | GET | Backup metadata (no paths) | Bearer token only |
| `/api/integrations/discord/status` | POST | Public status summary; `diagnostic: true` returns detailed output | Public (diagnostic: Admin) |
| `/api/integrations/discord/readiness` | POST | Readiness checks | Observer |
| `/api/integrations/discord/services` | POST | Service container state | Observer |
| `/api/integrations/discord/maintenance` | POST | Readiness output | Observer |
| `/api/integrations/discord/servers` | POST | Game server partitions | Observer |
| `/api/integrations/discord/ports` | POST | Network port status | Observer |
| `/api/integrations/discord/db` | POST | Database health | Observer |
| `/api/integrations/discord/population` | POST | Player count (aggregate only) | Moderator |
| `/api/integrations/discord/map-state` | POST | Map state | Moderator |
| `/api/integrations/discord/announcements` | POST | Recent in-game announcements | Moderator |
| `/api/integrations/discord/players/link`, `/players/link/verify`, `/players/unlink` | POST | Link a Discord user to a character (writes link tables, whispers a code) | Moderator |
| `/api/integrations/discord/players/me`, `/players/inventory`, `/players/find`, `/players/inventory-search` | POST | Linked player's identity, inventory and item search | Moderator |
| `/api/integrations/discord/players/storage`, `/guilds/storage`, `/guilds/find` | POST | Owned or guild storage and search for the linked player | Moderator |
| `/api/integrations/discord/logs` | POST | Capped, redacted service logs | Admin |
| `/api/integrations/discord/ops/activity`, `/ops/combat`, `/ops/resources`, `/ops/economy`, `/ops/inventory`, `/ops/soc`, `/ops/prometheus` | POST | Operational summaries | Admin |
| `/api/integrations/discord/broadcast` | POST | In-game broadcast (needs `DUNE_DISCORD_WRITES_ENABLED`) | Admin |

## RBAC Configuration

The adapter supports tiered role-based access. Configure these env vars on the
console:

| Variable | Tier and what it can reach |
|----------|----------------------------|
| `DISCORD_OBSERVER_ROLE_IDS` | Observer: status, readiness, services, maintenance, servers, ports, db |
| `DISCORD_MODERATOR_ROLE_IDS` | Moderator: everything Observer can, plus population, map state, announcements, player link, inventory, storage and guild routes |
| `DISCORD_ADMIN_ROLE_IDS` | Admin: everything, including diagnostic status, logs, `ops/*` and broadcast |
| `DISCORD_OWNER_ROLE_IDS` | Owner: same access as Admin |

An actor with none of these roles is "public" and can only call `/status`
without `diagnostic`. If no role IDs are configured at all, every caller is
public.

Role IDs are comma-separated Discord role IDs (18-digit numbers). The role IDs
the bot sends in `actor.roleIds` must match these values.

### Broadcast

`/broadcast` is also gated by `DUNE_DISCORD_WRITES_ENABLED`, and only an actor
holding a role in the console's `DISCORD_ADMIN_ROLE_IDS` or
`DISCORD_OWNER_ROLE_IDS` may use it. On the stock `docker-compose.web.yml`,
`DUNE_DISCORD_WRITES_ENABLED` is not forwarded to the container, so `/broadcast`
stays disabled (403 `writes_disabled`) even if `.env` sets the flag.

## Security

- **Adapter is disabled by default** — no routes exposed until enabled
- **Bearer token required** — every request must include `Authorization: Bearer <token>`
- **Constant-time token comparison** — prevents timing attacks
- **Output sanitization** — removes internal IPs, credentials, connection strings
- **No game-data writes** — the only writes are player-link bookkeeping and the opt-in `/broadcast`

## Companion Bot

This adapter is designed to work with the [Dune Discord Bot](https://github.com/yacketrj/dune-awakening-selfhost-discordbot),
which is maintained outside this repository. See that repository's README for
its current command list, and the console's
`GET /api/integrations/discord/catalog` route for the commands and minimum tiers
the console supports.

See the bot's [User Guide](https://github.com/yacketrj/dune-awakening-selfhost-discordbot/blob/main/docs/user-guide.md)
and [Admin Guide](https://github.com/yacketrj/dune-awakening-selfhost-discordbot/blob/main/docs/admin-guide.md)
for setup instructions. The bot-side variables used in this folder
(`DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DUNE_CONSOLE_API_URL` and similar) are
read only by the bot, never by the console.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Adapter returns 404 | `DUNE_DISCORD_ADAPTER_ENABLED` not set to `true` |
| Adapter returns 401 | Token mismatch between console and bot |
| Adapter returns 503 | No token configured, or the token file is missing or empty |
| Status returns empty | Console can't reach Docker (check socket mount) |
| "not authorized" | Role IDs don't match between console and bot config |

## Sources

- [Bot Repository](https://github.com/yacketrj/dune-awakening-selfhost-discordbot)
- [Adapter Contract](../discord-control-bot/api-adapter-contract.md)
- [Discord Developer Portal](https://discord.com/developers/applications)
