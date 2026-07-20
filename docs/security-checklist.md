# Security-First Pre-Submission Checklist

## Before Writing Code

- [ ] **Threat model the feature** — What can go wrong? Who benefits from bypassing it?
- [ ] **Identify trust boundaries** — Where does data cross from untrusted to trusted?
- [ ] **Check existing patterns** — How does the codebase handle similar security concerns? (e.g., `carePackage.js` for whispers, `messageOfTheDay.js` for online checks)
- [ ] **Verify database schema** — Don't assume column names. Check `duneDb.js` or query the actual database.
- [ ] **Review upstream reference implementation** — If upstream has similar functionality, study it first.

## During Implementation

- [ ] **Validate all inputs** — Every parameter from external sources must be validated
- [ ] **Check identity before action** — Verify the actor owns the resource they're acting on
- [ ] **Verify resource state** — Don't act on offline characters, expired sessions, or stale data
- [ ] **Use transactions** — Multi-step operations must be atomic (`db.transaction()`)
- [ ] **Handle conflicts** — Don't silently overwrite. Return `409 Conflict` with clear error message
- [ ] **Inject dependencies** — Use dependency injection for testability (see `linkProvider.js` pattern)
- [ ] **Use proper persona resolution** — Never hardcode sender identities. Use `ensureCarePackageServerPersona()` or equivalent
- [ ] **Log security events** — Record link attempts, failures, and conflicts with timestamps

## Before Submission

- [ ] **Test edge cases** — Offline characters, expired codes, duplicate links, wrong user IDs
- [ ] **Test conflict scenarios** — Two users trying to link same character, same user linking two characters
- [ ] **Verify RBAC** — Use dedicated capabilities (`PLAYER_LINK_WRITE`), not generic ones (`INVENTORY_READ`)
- [ ] **Check error messages** — Don't leak internal details. Return user-friendly errors
- [ ] **Review against this checklist** — Go through every item above
- [ ] **Peer review** — Have someone else review the security implications
- [ ] **Compare with upstream** — If submitting to upstream, check their recent commits for patterns you missed

## Post-Merge

- [ ] **Monitor for abuse** — Check logs for unusual patterns
- [ ] **Update documentation** — Reflect security requirements in user guides
- [ ] **Add tests** — Ensure security edge cases are covered in test suite

## Lessons Learned (PR #91)

| What We Missed | What Upstream Added |
|----------------|---------------------|
| No online check | `player.online_status !== "Online"` → reject |
| Silent link overwrite | `409 Conflict` with `character_already_linked` error |
| Hardcoded sender persona | `ensureCarePackageServerPersona()` |
| No Funcom ID validation | Check `player.funcom_id` before whisper |
| Individual queries | `db.transaction()` for atomicity |
| Wrong capability | `PLAYER_LINK_WRITE` instead of `INVENTORY_READ` |
| Direct imports | Dependency injection for testability |
| Code-only consume | `consumePendingLink(discordUserId, code)` |

**Rule:** Every feature submission must pass this checklist. No exceptions.
