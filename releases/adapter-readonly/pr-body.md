# Add modular read-only Discord adapter integration

## Summary

Add modular read-only Discord adapter to the WebUI API. Replaces inline `discordAdapter.js` with structured integration modules, comprehensive docs, tests, and launcher scripts.

## User Impact

Server operators can enable the Discord adapter (`DUNE_DISCORD_ADAPTER_ENABLED=true`) to expose health, status, readiness, and services routes for a companion Discord bot.

## Security Impact

- Command surface: new read-only adapter routes
- RBAC or authorization: capability-based RBAC on every route
- Secret handling: bearer-token authentication required
- Data crossing Discord/bot/WebUI boundaries: sanitized read-only responses
- Network exposure: adapter disabled by default

## Least Privilege

- Discord adapter disabled by default
- Bearer-token authentication
- Capability-based access control
- All routes read-only

## Tests and Evidence

- [ ] Adapter unit tests
- [ ] Route authorization tests
- [ ] Redaction tests
- [ ] Docker build
- [ ] Trivy filesystem
- [ ] Trivy image
- [ ] `npm audit --audit-level=moderate` (where applicable)

## Known Limitations

- Write-capable routes are not included; planned in future train.

## Sources

- `docs/discord-control-bot/api-adapter-contract.md`
- `docs/discord-control-bot/roadmap.md`
