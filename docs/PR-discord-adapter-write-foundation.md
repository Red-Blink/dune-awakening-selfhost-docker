## Summary

Write-safety foundation for the Discord adapter. **Future train — not yet implemented.**
This PR establishes the planning baseline and entry criteria for introducing
write-capable Discord adapter routes.

## Entry Criteria (not yet met)

- [ ] Read-only adapter (release/discord-adapter-readonly) merged and stable
- [ ] Upstream approves write-capable adapter contract
- [ ] STRIDE and abuse-case review completed

## When Implemented

Required foundation:
- Write routes disabled by default (`DUNE_DISCORD_WRITES_ENABLED=false`)
- Write-specific RBAC that observer roles do not inherit
- Capability discovery before route execution
- Confirmation primitives for write operations
- Idempotency key generation and enforcement
- Audit event publishing for all write operations
- Write adapter timeout and retry rules
- Redaction tests for previews, failures, and audit output

## Security Impact (future)

- All write paths disabled by default — no execution risk until explicitly enabled
- Dedicated write capability tiers (write-admin, write-owner)
- Confirmation cannot be bypassed
- Audit trail for every write operation
- Ephemeral Discord responses for write results

## Sources

- `docs/discord-control-bot/roadmap.md` (on release/discord-adapter-readonly)
- `docs/discord-control-bot/api-adapter-contract.md`
