## Summary

Add modular read-only Discord adapter to the WebUI API. This replaces the
inline discordAdapter.js with a structured integration module and adds
comprehensive docs, tests, and launcher scripts.

## User Impact

Server operators can enable the Discord adapter (`DUNE_DISCORD_ADAPTER_ENABLED=true`)
to expose health, status, readiness, and services routes for a companion
Discord bot. The adapter is disabled by default and requires explicit
configuration.

## Security Impact

- New surface: Discord adapter API with bearer-token authentication
- Disabled by default — no exposure until operator enables it
- Role-based capability tiers (public, observer, moderator, admin, owner)
- Read-only routes only — no write mutations
- Redaction of internal IPs, paths, and secrets from API responses
- Audit event schema for future write operations
- STRIDE and abuse-case review documented in adapter contract

## Configuration

New env vars:
- `DUNE_DISCORD_ADAPTER_ENABLED` (default: false)
- `DUNE_DISCORD_ADAPTER_TOKEN` or `DUNE_DISCORD_ADAPTER_TOKEN_FILE`
- `DUNE_BOT_API_TOKEN_FILE` (also used for bot token)
- `DISCORD_OBSERVER_ROLE_IDS`, `DISCORD_ADMIN_ROLE_IDS`, `DISCORD_OWNER_ROLE_IDS`

## Adapter Routes

| Route | Method | Min Tier | Description |
|---|---|---|---|
| `/api/integrations/discord/health` | GET | token only | Health check |
| `/api/integrations/discord/status` | POST | public | Stack status |
| `/api/integrations/discord/readiness` | POST | observer | Readiness check |
| `/api/integrations/discord/services` | POST | observer | Service list |
| `/api/integrations/discord/population` | POST | moderator | Online count |
| `/api/integrations/discord/logs` | POST | admin | Log retrieval |
| `/api/integrations/discord/map-state` | POST | moderator | Map metadata |
| `/api/integrations/discord/backups/list` | POST | moderator | Backup listing |

## Tests and Evidence

- [x] Unit tests for adapter health, status, readiness, services
- [x] Unit tests for policy capability resolution
- [x] Unit tests for audit schema and redaction
- [x] Unit tests for status parsing and formatting
- [x] Route compatibility tests
- [x] Launcher script validation

## Known Limitations

- Population route requires Dune server to be running (`dune players` command)
- Logs, map-state, and backup routes are defined but not fully implemented
- No write-capable commands — read-only only

## Documentation

- `docs/discord-control-bot/README.md` — main documentation
- `docs/discord-control-bot/api-adapter-contract.md` — full API contract
- `docs/discord-control-bot/admin-guide.md` — admin setup guide
- `docs/discord-control-bot/security-gates.md` — security requirements

## Sources

- `docs/discord-control-bot/api-adapter-contract.md`
- `docs/discord-control-bot/roadmap.md`
- PR discussions in feature/discord-control-bot branch
