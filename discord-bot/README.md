# Dune Discord Companion Bot

Experimental read-only Discord companion for Dune Docker Console.

Full setup, installation, usage, troubleshooting, and role matrix:

```text
docs/discord-control-bot/README.md
```

## Current Command Surface

| Discord command | Minimum role | Visibility | Writes |
|---|---:|---|---:|
| `/dune health` | Public | Ephemeral | No |
| `/dune status public` | Public | Public | No |
| `/dune status detail` | Admin | Ephemeral | No |
| `/dune readiness` | Observer | Ephemeral | No |
| `/dune services` | Observer | Ephemeral | No |
| `/dune help` | Public | Ephemeral | No |
| `/dune version` | Public | Ephemeral | No |

## Setup Helpers

Generate an install URL with the correct `bot` and `applications.commands` scopes:

```bash
npm run discord:invite
```

Discover application, guild, channel, and role IDs by name:

```bash
npm run discord:discover -- --guild "Spice Is Power"
```

Grant channel access by guild/channel name. Dry run first:

```bash
npm run discord:channel -- --guild "Spice Is Power" --channel "server-status"
```

Apply the channel permission overwrite:

```bash
npm run discord:channel -- --guild "Spice Is Power" --channel "server-status" --execute
```

## Bot Visibility in Discord

If slash commands work but the bot is not listed as a channel member, the application was likely installed with only the `applications.commands` scope. Reinstall it with `bot applications.commands` by using `npm run discord:invite`, then grant channel access with `npm run discord:channel` or through Discord channel settings.

If the bot has no icon/avatar, upload the application icon and bot avatar in Discord Developer Portal.

## Local Runtime

The local stack launcher uses the Console adapter on port `8090` and starts the Discord runtime:

```bash
sh discord-bot/scripts/run-local-discord-stack.sh
```

Expected runtime markers:

```text
slash_commands_registered
gateway_open
gateway_ready
```

The bot identifies with an online presence of `Watching Arrakis status`.

## Role Model

| Tier | Capabilities |
|---|---|
| Public | Public-safe status/help/version/health |
| Observer | `status:read`, `readiness:read`, `services:read` |
| Moderator | Observer capabilities plus future read-only population/map/backup visibility |
| Admin | Moderator capabilities plus diagnostic visibility |
| Owner | Same read-only capability set as Admin |

The bot-side authorization model intentionally contains no write, destructive, broadcast, database-write, player-admin, map-write, addon-admin, or settings-admin capabilities.

## Local Checks

```bash
cd discord-bot
npm ci --ignore-scripts
npm test
npm run security:secrets
npm run build
```

From `console/api`:

```bash
node --test test/discord*.test.js
```

## Security Constraints

1. The bot is a Discord client, not the authority.
2. Dune Docker Console remains responsible for final authorization, safety checks, redaction, audit logging, and execution.
3. The bot must call a protected Console API.
4. The bot must not mount `/var/run/docker.sock`.
5. The bot must not write directly to Postgres.
6. The bot must not execute destructive actions.
7. Discord write/admin actions remain disabled and out of scope for the experimental release.
