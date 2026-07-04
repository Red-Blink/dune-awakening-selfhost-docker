# Dune Discord Companion Bot

## Purpose

The Dune Discord Companion Bot is an experimental, read-only Discord interface for Dune Docker Console. It gives server operators safe operational visibility from Discord without giving Discord direct control over Docker, Postgres, backups, or game-state mutation.

The Console API adapter remains the enforcement point for authentication, authorization, redaction, and audit logging. The Discord bot is a thin client: it receives slash commands, builds Discord actor context, calls the protected adapter, and renders sanitized responses.

## Current scope

Implemented commands:

| Command | Visibility | Purpose |
| --- | --- | --- |
| `/dune help` | Ephemeral | Shows safe command help. |
| `/dune version` | Ephemeral | Shows bot runtime version. |
| `/dune health` | Ephemeral | Confirms the Console Discord adapter is reachable and read-only. |
| `/dune status public` | Public channel response | Shows redacted public server status. |
| `/dune status detail` | Ephemeral | Shows admin-only diagnostic status. |
| `/dune readiness` | Ephemeral | Shows readiness summary. |
| `/dune services` | Ephemeral | Shows service health summary. |

Out of scope for this release:

- Player kick, grant, teleport, refill, or inventory mutation.
- Backup create, restore, or delete.
- Docker socket access.
- Direct database writes.
- In-game chat bridge.
- Moderator write commands.
- Runtime evidence bundles and local scan artifacts.

## Why the bot may work but not appear as a channel member

Discord slash commands can work when an application is authorized with only the `applications.commands` scope. In that state the command can be usable, but the bot user may not appear as a normal guild/channel member.

To make the bot show up as a bot member, install it with both scopes:

```text
bot applications.commands
```

The bot also needs channel permissions where commands are used:

```text
View Channel
Send Messages
Embed Links
Use Application Commands
```

If the bot has no icon/avatar, that is configured in Discord, not in this repository:

1. Open Discord Developer Portal.
2. Open the application.
3. Upload an application icon under **General Information**.
4. Upload a bot avatar under **Bot**.
5. Reinstall or restart the bot if Discord does not refresh the display immediately.

## Prerequisites

- Node.js 22 or later.
- A Discord application with a bot user.
- A Discord bot token stored in a local file.
- A Dune Console bot API token stored in a local file.
- The local Console Discord adapter running, usually on `http://127.0.0.1:8090`.

Do not commit token files, `.env` files, generated runtime files, or security artifacts.

## Local environment file

Recommended location:

```bash
$HOME/.config/dune-console/discord-bot.env
```

Example:

```bash
export DISCORD_BOT_TOKEN_FILE="$HOME/.config/dune-console/discord-bot-token.txt"
export DUNE_BOT_API_TOKEN_FILE="$HOME/.config/dune-console/dune-bot-api-token.txt"
export DUNE_CONSOLE_API_URL="http://127.0.0.1:8090"

export DISCORD_CLIENT_ID="123456789012345678"
export DISCORD_GUILD_ID="123456789012345678"

export DISCORD_OBSERVER_ROLE_IDS="123456789012345678"
export DISCORD_MODERATOR_ROLE_IDS=""
export DISCORD_ADMIN_ROLE_IDS="123456789012345678"
export DISCORD_OWNER_ROLE_IDS=""
```

The bot token file should contain only the Discord bot token. The Dune token file should contain only the Console adapter bearer token.

## Install the bot into Discord without manually finding the client ID

From the repository:

```bash
cd discord-bot
source "$HOME/.config/dune-console/discord-bot.env"
npm run discord:invite
```

The helper queries Discord using the bot token file, discovers the application/client ID, and prints an OAuth install URL with the correct scopes and permissions.

Open the generated URL in a browser and select the target Discord server.

If you already know the client ID:

```bash
node scripts/discord-install-url.mjs --client-id "123456789012345678"
```

## Discover guild, channel, and role IDs by name

After the bot is installed in the server:

```bash
cd discord-bot
source "$HOME/.config/dune-console/discord-bot.env"
npm run discord:discover -- --guild "Spice Is Power"
```

The helper prints:

- Discord application/client ID.
- Bot user ID.
- Guild ID.
- Channels visible to the bot.
- Roles visible to the bot.

To resolve one channel by name:

```bash
npm run discord:discover -- --guild "Spice Is Power" --channel "server-status"
```

Use the printed role IDs for the role mapping environment variables.

## Add the bot to a channel without manually finding channel IDs

Discord channel access is controlled by channel permissions. The helper resolves the guild and channel by name and can create a permission overwrite for the bot user.

Dry run first:

```bash
cd discord-bot
source "$HOME/.config/dune-console/discord-bot.env"
npm run discord:channel -- --guild "Spice Is Power" --channel "server-status"
```

If the selected guild/channel are correct, apply the permission overwrite:

```bash
npm run discord:channel -- --guild "Spice Is Power" --channel "server-status" --execute
```

The helper grants the bot user:

```text
View Channel
Send Messages
Embed Links
Use Application Commands
```

If Discord returns a permissions error, either grant the bot role **Manage Channels** temporarily and rerun the helper, or add the same channel permissions manually in Discord channel settings.

## Start the local stack

From the repository root:

```bash
sh discord-bot/scripts/run-local-discord-stack.sh
```

Expected runtime markers:

```text
slash_commands_registered
gateway_open
gateway_ready
```

The bot identifies with an online presence of `Watching Arrakis status`. That presence helps confirm the bot user is connected, but the bot still must be installed with the `bot` scope and have channel permissions to appear as a visible member.

## Usage guide

Basic checks:

```text
/dune help
/dune version
/dune health
```

Public status:

```text
/dune status public
```

Admin-only diagnostic status:

```text
/dune status detail
```

Operational summaries:

```text
/dune readiness
/dune services
```

Most responses are ephemeral to reduce channel noise and avoid leaking operational details. `/dune status public` is the public channel-safe command.

## Role matrix

The backend adapter enforces capabilities. Discord role names are not trusted authorization claims; Discord sends role IDs, and those IDs must be mapped in the local environment.

| Bot role tier | Environment variable | Capabilities | Current commands |
| --- | --- | --- | --- |
| Public / no mapped role | none | `status:read` public-safe only | `/dune health`, `/dune status public`, `/dune help`, `/dune version` |
| Observer | `DISCORD_OBSERVER_ROLE_IDS` | `status:read`, `readiness:read`, `services:read` | Public commands plus `/dune readiness`, `/dune services` |
| Moderator | `DISCORD_MODERATOR_ROLE_IDS` | Observer capabilities plus future read-only population/map/backup visibility | Same as Observer in current release unless future read-only routes are enabled |
| Admin | `DISCORD_ADMIN_ROLE_IDS` | Moderator capabilities plus `logs:read` / diagnostic visibility | `/dune status detail` plus lower-tier commands |
| Owner | `DISCORD_OWNER_ROLE_IDS` | Admin-equivalent for current read-only release | `/dune status detail` plus lower-tier commands |

Current release contains no write-capable Discord commands. Future write/moderator commands must be separately approved, disabled by default, threat-modeled, audited, and guarded by explicit backend authorization.

## Troubleshooting

### Slash command works, but bot is not visible as a channel member

Likely cause: the app was installed with only `applications.commands` scope.

Fix:

```bash
cd discord-bot
source "$HOME/.config/dune-console/discord-bot.env"
npm run discord:invite
```

Open the generated URL and install with `bot applications.commands` scopes. Then grant the bot channel permissions with `npm run discord:channel` or through Discord channel settings.

### Bot has no icon

Upload the application icon and bot avatar in Discord Developer Portal. This is Discord-side application configuration.

### `/dune health` fails

Check the local adapter:

```bash
TOKEN="$(cat "$HOME/.config/dune-console/dune-bot-api-token.txt")"
curl -i -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8090/api/integrations/discord/health
```

### Commands do not update

Guild slash commands usually update quickly, but stale Discord clients can cache command menus. Restart the Discord client and confirm the runtime logs show `slash_commands_registered`.

### Permission denied for `/dune readiness` or `/dune services`

Run discovery and confirm the mapped role IDs match the user roles Discord sends:

```bash
cd discord-bot
source "$HOME/.config/dune-console/discord-bot.env"
npm run discord:discover -- --guild "Spice Is Power"
```

Then update the role mapping variables in `discord-bot.env`.

## Validation

From `discord-bot/`:

```bash
npm test
npm run security:secrets
npm run build
```

From `console/api/`:

```bash
node --test test/discord*.test.js
```

## Security notes

- The bot does not mount the Docker socket.
- The bot does not connect directly to Postgres.
- The bot does not execute destructive commands.
- Responses are redacted and mention-safe.
- Runtime secrets remain local files and must not be committed.
- Generated artifacts and local runtime state are fork-local and must not be sent upstream.
