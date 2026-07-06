# Dune Discord Companion Bot - User Guide

## Purpose

The Dune Discord Companion Bot gives safe read-only visibility into Dune Docker Console from Discord.

It does not perform server mutations, player actions, database writes, backup restores, or Docker control actions.

## Commands

| Command | Who can use it | What it shows |
|---|---:|---|
| `/dune health` | Public | Whether the Console adapter is online and read-only. |
| `/dune status` | Public | Public Status summary for the server. |
| `/dune status detail` | Admin/Owner | Detailed Status with additional redacted diagnostics. |
| `/dune readiness` | Observer+ | Whether server components appear ready. |
| `/dune services` | Observer+ | Friendly service status summary. |

## Public Status

`/dune status` is safe for public or semi-public operational channels.

It may show:

- Overall status.
- Server title.
- Region.
- Mode.
- Population.
- Map readiness.
- General issue summary.

It does not show:

- Internal SSH hosts.
- Internal IPs.
- Database URLs.
- Tokens or secrets.
- Raw host paths.
- Raw Docker/container internals.

## Detailed Status

`/dune status detail` provides more detail for administrators.

It may show:

- Parsed service state.
- Parsed listener checks with redaction.
- Map state.
- Issue list.
- Capped redacted command output.

Detailed Status is intended to be ephemeral and should not be posted into public channels.

## Readiness

`/dune readiness` shows whether the server appears ready for players.

A readiness issue does not always mean the server is broken. For example, a map may be warming or a listener may need a short period to appear after startup.

## Services

`/dune services` shows a friendly summary of important services.

Instead of exposing raw container details, the bot uses user-facing labels such as Database, Gateway, Survival, Overmap, and Orchestrator.

## If a Command Is Denied

A `not_authorized` response means your Discord role does not map to the required bot capability.

Ask a server admin to verify:

- Your Discord role.
- The bot role mapping.
- The Console adapter role mapping.

## Safety Expectations

The bot is read-only. It cannot grant items, restart services, restore backups, mutate players, edit maps, send broadcasts, or change server settings.
