# Dune Discord Companion Bot - Admin Guide

## Purpose

This guide is for server owners and administrators configuring the experimental read-only Discord companion bot.

The bot is not the authority. Dune Docker Console remains responsible for final authorization, safety checks, redaction, audit logging, and execution.

## No Write Actions

The experimental bot has no write-capable command surface.

The bot cannot:

- Mount or use the Docker socket.
- Write directly to Postgres.
- Run database mutations.
- Create, restore, import, or delete backups.
- Grant items, teleport, kick, refill, or mutate players.
- Mutate map state, sietch state, or Deep Desert state.
- Enable, disable, install, or remove addons.
- Send broadcasts.
- Store runtime secrets in source control, addon files, static files, logs, or image layers.

## Role Mapping

Configure Discord role IDs in both the Console adapter runtime and the bot runtime.

| Tier | Environment variable | Intended access |
|---|---|---|
| Player | `DISCORD_PLAYER_ROLE_IDS` | Readiness and services |
| Moderator | `DISCORD_MODERATOR_ROLE_IDS` | Future population, map state, backup metadata |
| Admin | `DISCORD_ADMIN_ROLE_IDS` | Detailed Status and future redacted logs |
| Owner | `DISCORD_OWNER_ROLE_IDS` | Same read-only access as admin in the experimental phase |

**This mapping is completely independent of the web console's own Discord
sign-in role mapping** (`DISCORD_CONSOLE_ADMIN_ROLE_IDS` /
`DISCORD_CONSOLE_MODERATOR_ROLE_IDS` / `DISCORD_CONSOLE_PLAYER_ROLE_IDS`,
[docs/rfc-console-auth.md §2.1.1](../../rfc-console-auth.md)). There is no
shared source of truth between the two, and no automatic sync in either
direction: a role listed here can use the bot's Discord slash commands
regardless of whether that same role can sign into the console, and vice
versa. Concretely, if you revoke someone's *console* admin access by removing
their role from `DISCORD_CONSOLE_ADMIN_ROLE_IDS`, they keep whatever access
this table's mapping still grants them until you *also* update it here — and
the reverse holds too. If an operator's role assignments change (someone is
demoted, someone leaves), update **both** mappings, not just the one you
happen to be looking at. (Tracked as
[dune-awakening-selfhost-docker#620](https://github.com/Project-Arrakis/dune-awakening-selfhost-docker/issues/620).)

For local smoke tests, placeholder values are acceptable as long as both processes use the same values.

Example:

```bash
DISCORD_PLAYER_ROLE_IDS=role-player
DISCORD_ADMIN_ROLE_IDS=role-admin
DISCORD_OWNER_ROLE_IDS=role-owner
```

For production Discord use, replace those placeholders with real Discord role IDs.

## Current Commands

| Command | Minimum role | Notes |
|---|---:|---|
| `/dune health` | Public | Shows adapter health and configured role-policy booleans. |
| `/dune status` | Public | Public redacted status output. |
| `/dune status detail` | Admin | Detailed Status output. Ephemeral by default. |
| `/dune readiness` | Player | Readiness summary. |
| `/dune services` | Player | Friendly service summary. |

## Public Status

Public status is intentionally concise. It excludes internal addresses, SSH hosts, database URLs, host paths, raw environment values, tokens, and sensitive topology.

## Detailed Status

Detailed Status is for admin/owner use only.

It may include more operational context such as parsed services, listeners, maps, issues, and capped redacted command output. It remains redacted and should be ephemeral in Discord.

## Health and Role-Policy Verification

Use health to confirm the Console adapter has role mapping loaded:

```bash
curl -i \
  -H 'Authorization: Bearer local-dev-bot-api' \
  http://127.0.0.1:8088/api/integrations/discord/health
```

Expected role policy shape:

```json
{
  "rolePolicy": {
    "playerConfigured": true,
    "moderatorConfigured": false,
    "adminConfigured": true,
    "ownerConfigured": true
  }
}
```

The values only indicate whether a tier is configured. Role IDs are not exposed.

## Common Admin Issue: 403 Authorization

If readiness, services, or detailed status returns `403`, check both sides:

1. The bot process must send the expected role ID in `actor.roleIds`.
2. The Console adapter process must be started with the matching `DISCORD_*_ROLE_IDS` value.

The smoke runner prints:

```text
actorRoleIdsSent
consoleRolePolicy
```

Use those fields to identify a mismatch.

## SOC 2 Readiness

Admins should treat this bot as a privileged operational visibility plane even though it is read-only.

Required recurring checks:

- Review role mappings monthly and before release.
- Review SOC 2 readiness workflow results weekly.
- Confirm secret scans remain passing.
- Confirm public responses do not expose internal topology.
- Document any exception with owner, risk, mitigation, and expiration.
