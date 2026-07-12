# Discord Adapter — Setup and Configuration

The Dune Docker Console includes a built-in Discord adapter that lets you
connect a companion Discord bot for server monitoring and management.

## What the Adapter Does

The adapter exposes a set of API routes that a Discord bot (or any bearer-token
authenticated client) can call to get server status and data. It is:

- **Disabled by default** — must be explicitly enabled
- **Read-only** — all routes provide data, none modify the server
- **Bearer-token protected** — every request requires a shared secret token
- **Role-gated** — you can restrict which Discord roles can access which data

## Quick Enable (3 Steps)

### 1. Add Environment Variables

Add these to the console's `docker-compose.web.yml`:

```yaml
environment:
  DUNE_DISCORD_ADAPTER_ENABLED: "true"
  DUNE_BOT_API_TOKEN_FILE: /repo/runtime/secrets/bot-api-token.txt
  DISCORD_OBSERVER_ROLE_IDS: "role-id-1,role-id-2"
  DISCORD_ADMIN_ROLE_IDS: "role-id-1"
```

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
  "enabled": true,
  "readOnly": true,
  "writesEnabled": false,
  "routes": ["/api/integrations/discord/health", ...]
}
```

## Routes

| Route | Method | Description | Access |
|-------|--------|-------------|--------|
| `/api/integrations/discord/health` | GET | Adapter health and route listing | Public |
| `/api/integrations/discord/status` | POST | Server status with maps, containers, listeners | Observer |
| `/api/integrations/discord/readiness` | POST | Readiness checks (containers, ports, DB) | Observer |
| `/api/integrations/discord/services` | POST | Service container state | Observer |
| `/api/integrations/discord/population` | POST | Player count (aggregate only) | Observer |
| `/api/integrations/discord/version` | GET | Dune stack version | Observer |
| `/api/integrations/discord/servers` | POST | Game server partitions | Observer |
| `/api/integrations/discord/ports` | POST | Network port status | Observer |
| `/api/integrations/discord/db` | POST | Database health | Observer |

## RBAC Configuration

The adapter supports tiered role-based access. Configure these env vars:

| Variable | Description |
|----------|-------------|
| `DISCORD_OBSERVER_ROLE_IDS` | Can access all read-only routes |
| `DISCORD_ADMIN_ROLE_IDS` | Can access diagnostic mode on status/readiness |
| `DISCORD_MODERATOR_ROLE_IDS` | Can access population and map data |

Role IDs are comma-separated Discord role IDs (18-digit numbers). These must
match the roles configured on the Discord bot side.

## Security

- **Adapter is disabled by default** — no routes exposed until enabled
- **Bearer token required** — every request must include `Authorization: Bearer <token>`
- **Constant-time token comparison** — prevents timing attacks
- **Output sanitization** — removes internal IPs, credentials, connection strings
- **No write access** — all routes are read-only

## Companion Bot

This adapter is designed to work with the [Dune Discord Bot](https://github.com/yacketrj/dune-awakening-selfhost-discordbot),
which provides 25 slash commands organized into 6 groups:

| Group | Commands |
|-------|----------|
| `core` | about, ping, help |
| `server` | health, status, summary, readiness, services |
| `data` | population, backups, maps |
| `ops` | activity, combat, resources, economy, inventory, location, soc, prometheus, dashboard |
| `admin` | doctor, cooldowns, latency, events, broadcast |
| `infra` | version, servers, ports, db |

See the bot's [User Guide](https://github.com/yacketrj/dune-awakening-selfhost-discordbot/blob/main/docs/user-guide.md)
and [Admin Guide](https://github.com/yacketrj/dune-awakening-selfhost-discordbot/blob/main/docs/admin-guide.md)
for setup instructions.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Adapter returns 404 | `DUNE_DISCORD_ADAPTER_ENABLED` not set to `true` |
| Adapter returns 401 | Token mismatch between console and bot |
| Adapter returns 503 | Token file not found or empty |
| Status returns empty | Console can't reach Docker (check socket mount) |
| "not authorized" | Role IDs don't match between console and bot config |

## Sources

- [Bot Repository](https://github.com/yacketrj/dune-awakening-selfhost-discordbot)
- [Adapter Contract](api-adapter-contract.md)
- [Discord Developer Portal](https://discord.com/developers/applications)
