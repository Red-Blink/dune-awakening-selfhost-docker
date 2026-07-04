# Local Test: Discord Adapter and Bot Command Smoke

## Purpose

Validate the experimental read-only Discord adapter and the bot command layer without connecting to Discord.

The adapter is disabled by default and requires a dedicated Dune bot API token.

## Create Local Bot API Token

Use a local development value only. Keep it outside `runtime/secrets` when that directory is root-owned.

```bash
mkdir -p "$HOME/.config/dune-console"
printf '%s\n' 'local-dev-bot-api' > "$HOME/.config/dune-console/dune-bot-api-token.txt"
chmod 600 "$HOME/.config/dune-console/dune-bot-api-token.txt"
```

## Start API with Adapter Enabled

From `console/api`:

```bash
DUNE_DOCKER_DIR="$HOME/dune-awakening-selfhost-docker-WSL" \
DUNE_BOT_API_TOKEN_FILE="$HOME/.config/dune-console/dune-bot-api-token.txt" \
npm run start:discord-adapter
```

This wrapper enables the adapter and applies the small server hook automatically. You do not need to hand-edit `src/server.js`.

If runtime secrets are root-owned, run the same command through `sudo env` while preserving the two path variables.

## Test Health

```bash
curl -i \
  -H 'Authorization: Bearer local-dev-bot-api' \
  http://127.0.0.1:8088/api/integrations/discord/health
```

Expected:

```json
{
  "ok": true,
  "service": "dune-console-discord-adapter",
  "experimental": true,
  "readOnly": true,
  "writesEnabled": false,
  "liveRoutes": [
    "/api/integrations/discord/health",
    "/api/integrations/discord/status",
    "/api/integrations/discord/readiness",
    "/api/integrations/discord/services"
  ]
}
```

## Test Public Redacted Status

```bash
curl -i \
  -H 'Authorization: Bearer local-dev-bot-api' \
  -H 'Content-Type: application/json' \
  -d '{"actor":{"guildId":"local","channelId":"local","userId":"local","username":"local","roleIds":[],"commandName":"/dune status"},"diagnostic":false}' \
  http://127.0.0.1:8088/api/integrations/discord/status
```

Expected:

- `200 OK`.
- `ok: true`.
- Concise status summary only.
- No raw container names.
- No raw listener ports.
- No connection strings.
- No host paths.
- No secret material.

## Test Detailed Redacted Status

Diagnostic status requires an admin/owner Discord role.

```bash
curl -i \
  -H 'Authorization: Bearer local-dev-bot-api' \
  -H 'Content-Type: application/json' \
  -d '{"actor":{"guildId":"local","channelId":"local","userId":"local","username":"local-admin","roleIds":["role-admin"],"commandName":"/dune status detail"},"diagnostic":true}' \
  http://127.0.0.1:8088/api/integrations/discord/status
```

Expected:

- `200 OK`.
- Detailed but redacted status.
- Includes a capped `redactedOutput` field.
- No secrets or raw connection strings.

## Test Readiness and Services

Observer role or higher is required.

```bash
curl -i \
  -H 'Authorization: Bearer local-dev-bot-api' \
  -H 'Content-Type: application/json' \
  -d '{"actor":{"guildId":"local","channelId":"local","userId":"local","username":"local-observer","roleIds":["role-observer"],"commandName":"/dune readiness"}}' \
  http://127.0.0.1:8088/api/integrations/discord/readiness
```

```bash
curl -i \
  -H 'Authorization: Bearer local-dev-bot-api' \
  -H 'Content-Type: application/json' \
  -d '{"actor":{"guildId":"local","channelId":"local","userId":"local","username":"local-observer","roleIds":["role-observer"],"commandName":"/dune services"}}' \
  http://127.0.0.1:8088/api/integrations/discord/services
```

## Bot Command Smoke

From `discord-bot`:

```bash
export DUNE_CONSOLE_API_URL=http://127.0.0.1:8088
export DUNE_BOT_API_TOKEN_FILE="$HOME/.config/dune-console/dune-bot-api-token.txt"
export DISCORD_GUILD_ID=local-guild
export DISCORD_OBSERVER_ROLE_IDS=role-observer
export DISCORD_ADMIN_ROLE_IDS=role-admin
export DISCORD_OWNER_ROLE_IDS=role-owner

npm run smoke:health
npm run smoke:status
npm run smoke:readiness
npm run smoke:services
npm run smoke:status-detail
```

## Negative Tests

Invalid adapter credential:

```bash
curl -i -H 'Authorization: Bearer wrong' http://127.0.0.1:8088/api/integrations/discord/health
```

Expected: `401` with `invalid_bot_token`.

Missing adapter credential:

```bash
curl -i http://127.0.0.1:8088/api/integrations/discord/health
```

Expected: `401` with `missing_bot_token`.

Public actor attempting detailed status:

```bash
curl -i \
  -H 'Authorization: Bearer local-dev-bot-api' \
  -H 'Content-Type: application/json' \
  -d '{"actor":{"guildId":"local","channelId":"local","userId":"local","username":"local","roleIds":[],"commandName":"/dune status detail"},"diagnostic":true}' \
  http://127.0.0.1:8088/api/integrations/discord/status
```

Expected: `403` with an authorization error.
