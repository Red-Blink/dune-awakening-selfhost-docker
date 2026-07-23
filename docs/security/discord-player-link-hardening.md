# Discord Player-Link Hardening

Branch: `security/discord-player-link-hardening`

Upstream tracking: `Red-Blink/dune-awakening-selfhost-docker#100` (covers
FINDING-LINK-1, -2, -3, -5, -6). FINDING-LINK-4 is tracked separately and
already resolved-by-discussion in `Red-Blink/dune-awakening-selfhost-docker#72`.

Status: FINDING-LINK-1, FINDING-LINK-2, and FINDING-LINK-6 implemented;
FINDING-LINK-3 partially implemented (console-side, backward-compatible).
See "Remediation Status" at the end of this document. FINDING-LINK-5
reviewed and confirmed non-exploitable but not implemented (explicit scope
decision — see the finding for why).

## Purpose

Harden the Discord character-linking flow (`/dune data link` → in-game
whisper code → `/dune data verify`) against actor spoofing, excessive
authorization scope, and verification brute-forcing, and close the gap
between documented and actual multi-character/multi-account support.

This flow is the only Discord-adapter write path that currently ships
(`discordAdapterHealth()` reports
`adapterDataWrites: ["player-link", "account-link"]` — the second entry
added by FINDING-LINK-6's implementation, see below), so it is the
highest-value adapter surface to harden before any broader write-capable
work proceeds.

## Source Findings

All findings below were confirmed by direct code review against
`origin/main` (`e188c87`, synced with `upstream/main` at the same commit) in
this repository, and against `yacketrj/Arrakis-Control-Panel` `main`
(`1ea3316`) for the bot-side client and documentation.

### FINDING-LINK-1: Discord actor identity is an unauthenticated request-body claim (HIGH) — IMPLEMENTED

- **Location:** `console/api/src/integrations/discord/policy.js:59-71` (`normalizeDiscordActor`), `console/api/src/integrations/discord/routes.js:221-260` (link/verify/unlink/me routes)
- **Risk:** `actor.userId`, `actor.roleIds`, `actor.username`, `actor.guildId` are read verbatim from the JSON request body with no cryptographic binding to a real Discord interaction. The only gate on the whole adapter is a single shared bearer token (`routes.js:371-378`, `requireDiscordBotToken`) that authenticates the bot process, not the specific Discord user. Any caller holding that token can submit any `userId`/`roleIds` combination and the adapter will treat it as authentic. For the link/verify/unlink routes specifically, this means an attacker with the adapter token can link, unlink, or query the linked character for **any** Discord user ID, and can escalate their effective role tier by simply listing higher `roleIds` in the payload.
- **Recommendation:**
  1. Require Discord's own interaction signature verification (Ed25519, `X-Signature-Ed25519`/`X-Signature-Timestamp`) if the adapter is ever reachable independently of the bot process.
  2. At minimum, add a second HMAC secret (distinct from the transport bearer token) shared only between the specific bot instance and adapter, covering `(userId, guildId, channelId, roleIds, interactionId, timestamp)`, with a short freshness window (~30s) to prevent replay.
  3. Until (1) or (2) ship, treat the adapter bearer token as equivalent in sensitivity to a master credential for all linked Discord identities, not just "API access" — document this explicitly in `docs/security/` and operator secret-handling guidance.
- **Implemented:** Option 2. `console/api/src/integrations/discord/actorSignature.js` adds HMAC-SHA256 verification over `(route, userId, guildId, channelId, roleIds, interactionId)` plus a Unix timestamp, using a secret distinct from the transport bearer token (`DUNE_DISCORD_ACTOR_SECRET`/`DUNE_DISCORD_ACTOR_SECRET_FILE`), with a 30-second default freshness window (`DUNE_DISCORD_ACTOR_SIGNATURE_MAX_SKEW_SECONDS`). Wired into every POST route inside `handleDiscordAdapterRoute()` via a shared `readJson` wrapper, so no individual route handler needed to change. **Backward compatible by design:** when `DUNE_DISCORD_ACTOR_SECRET` is unset, verification no-ops and behavior is unchanged from before this fix — this lets the console ship ahead of bot-side signing support (tracked as a follow-up in `yacketrj/Arrakis-Control-Panel`). Option 1 (Discord's own Ed25519 interaction signatures) remains open as a stronger future alternative, since it wouldn't require provisioning and rotating a second shared secret. Item 3 (documenting the token as a master credential) is still open — see Known Limitations below.
- **Follow-up hardening (found during self-review, same branch):** the initial implementation signed only actor identity fields, not the route. That meant a signature captured from one legitimate, low-privilege request (e.g. a routine `status` call, which requires no special access to observe) could be replayed verbatim — with an attacker-chosen request body — against **any other route** within the freshness window, including `players/link` or `broadcast`, as long as the actor still qualified for that route's capability. Confirmed this was exploitable with a direct reproduction before fixing it. The signature now also covers the exact adapter route path (`canonicalActorSignaturePayload(actorPayload, timestamp, route)`), so a captured envelope only verifies against the specific route it was issued for. This does **not** fully eliminate replay — the exact same signed envelope (same route, same body) can still be resent verbatim within the skew window; see Known Limitations.

### FINDING-LINK-2: `player-link:write` capability requires only `moderator` tier (MEDIUM) — IMPLEMENTED

- **Location:** `console/api/src/integrations/discord/policy.js:14,34-45` (`DISCORD_CAPABILITIES.PLAYER_LINK_WRITE` in the `moderator` tier's capability set)
- **Risk:** Combined with FINDING-LINK-1, any actor payload claiming a `moderator`-mapped role ID — a much larger population than `admin`/`owner` — can exercise the identity-binding write capability. Identity-linking has a different risk profile than the other `moderator`-tier read capabilities it's grouped with (inventory/storage/backups read); it mutates a persistent binding between a Discord account and a game account, not just a read query.
- **Recommendation:** Move `PLAYER_LINK_WRITE` to require `admin` tier, or introduce a `self-link` capability that is available to any authenticated actor for their own `discordUserId` only, separate from role-tier-gated capabilities for privileged operations.
- **Implemented:** The `self-link` option, not "raise to admin" — raising the tier alone would have been wrong. Every route gating `PLAYER_LINK_WRITE` (`players/link`, `players/link/verify`, `players/unlink`) always passes `discordUserId: actor.userId`, never a separate target: this is inherently a self-service action (a player linking *their own* Discord account to *their own* character), not a privileged operation. Restricting it to `admin` would have broken that self-service feature for ordinary players. Added `SELF_SCOPED_CAPABILITIES` and `requireSelfScopedCapability()` in `policy.js`: `PLAYER_LINK_WRITE` is now removed from every tier's capability set (including `admin`/`owner`'s previously-implicit "all capabilities" grant) and instead authorized for any actor above `public` tier (i.e. any actor holding at least one configured Discord role), regardless of which specific role. `requireDiscordCapability()` now explicitly rejects `PLAYER_LINK_WRITE` with `invalid_capability` to prevent a future call site from accidentally reintroducing tier-based gating for a self-scoped action.

### FINDING-LINK-3: No rate limiting or lockout on verification attempts (MEDIUM) — PARTIALLY IMPLEMENTED

- **Location:** `console/api/src/integrations/discord/linkProvider.js:94-116` (`verifyPlayerLinkProvider`), `console/api/src/duneDb.js:4951-4959` (`consumePendingLink`)
- **Risk:** Verification codes are 6 characters from a 32-symbol alphabet (`console/api/src/integrations/discord/linkProvider.js:15,18-25`), giving ~30 bits of entropy, valid for 5 minutes, with zero attempt throttling. `consumePendingLink` is scoped to `(code, discord_user_id)`, so brute-forcing requires knowing the target's Discord ID — but that ID is itself attacker-suppliable per FINDING-LINK-1, so an attacker holding the adapter token can pick a target `discordUserId` and attempt many codes with no lockout, backoff, or alerting.
- **Recommendation:**
  1. Add per-`(discordUserId)` attempt throttling (e.g. 5 attempts per pending code, then force regeneration) to `verifyPlayerLinkProvider`.
  2. Consider increasing code length/entropy (e.g. 8 chars ≈ 40 bits) or switching to a copy-paste-friendly token if the whisper delivery channel supports longer strings without truncation.
  3. Emit an audit/log event on repeated failed verification for the same pending code so operators can detect probing.
- **Implemented:** Item 1. `verifyPlayerLinkProvider()` now checks a rate limiter (reusing `createLoginRateLimiter()` from `rateLimit.js` — the same per-key + global-aggregate lockout shape proven in `docs/security/login-rate-limit-defense.md`, rather than inventing a new limiter) keyed by `discordUserId` before ever calling `consumePendingLink()`. Defaults: 5 attempts per 5-minute window per user, 50 attempts per 5-minute window globally, 15-minute lockout once exceeded; all four tunable via `DUNE_DISCORD_LINK_VERIFY_MAX_ATTEMPTS` / `_GLOBAL_MAX_ATTEMPTS` / `_WINDOW_MS` / `_BLOCK_MS`. A locked-out request never reaches the database and never consumes the real pending link, so a legitimate user isn't punished for an attacker's guesses against their ID once they retry after the lockout window. A successful verification clears that user's failure count. Exceeding the limit returns `429 verify_rate_limited` (added as a new safe error code; no sensitive detail beyond a retry-after hint).
- **Not implemented:** Items 2 (longer codes) and 3 (audit/log event on repeated failure) remain open. Item 3 in particular would give operators visibility into probing attempts that this rate limiter silently absorbs — worth a follow-up.

### FINDING-LINK-4: Hardcoded command-auth token fallback was fixed, then reverted upstream — root cause is a two-sided synchronization gap, not a rollback mistake (HIGH — regression, tracked upstream)

- **Location:** `console/api/src/rmq.js:6,230-233` (`BUILTIN_COMMAND_AUTH_TOKEN`, `commandAuthToken()`)
- **History:** This exact issue was previously documented as `FINDING-CORE-1` in `yacketrj/Arrakis-Control-Panel:docs/security-audit/2026-07-04-comprehensive-security-audit.md` and fixed on `security/generated-command-auth-token-fix` (merged to `main` via `c079434` on 2026-06-27/28). It was then **explicitly reverted** by upstream maintainer `Red-Blink` in commit `52008a7` ("Restore built-in command auth token fallback", 2026-07-07), present on both `origin/main` and `upstream/main` (both at `e188c87`). This was already discussed and closed as **`Red-Blink/dune-awakening-selfhost-docker#72`** ("[Discussion] RabbitMQ / Command Auth Token", opened by `drkshrk`, closed 2026-07-17).
- **Root cause per maintainer (`Red-Blink`, issue #72, 2026-07-09):** the `AuthToken` field is embedded in the Dune server-command payload and validated by the **game server/director's command consumer**, not by RabbitMQ itself. A locally-generated console-side token only works if the game server consumer is configured with that *exact same* value. Today there is no mechanism to synchronize a generated token to both sides, so generating a local token unilaterally broke deployments where the game server still expected the built-in default. The maintainer's stated position: keep the built-in fallback as the safe default, and treat `DUNE_COMMAND_AUTH_TOKEN` as an "advanced override" only for operators who also update the game-server side. `RABBITMQ_ERLANG_COOKIE` (suggested in the issue as a possible alternative lever) is unrelated — it governs RabbitMQ node/CLI distribution auth, not this application-level token.
- **Risk:** `publishServerCommand()` (used for admin broadcasts, shutdown scheduling, etc.) currently falls back to a publicly known, source-controlled token whenever `DUNE_COMMAND_AUTH_TOKEN` is unset, and per the maintainer this is deliberate, not an oversight. This is not part of the whisper/link path directly (`publishCarePackageWhisper()` does not call `commandAuthToken()`), but it shares the same RMQ trust boundary and `dockerExec()`/`rabbitmqctl eval` mechanism that the whisper delivery depends on, so a compromised command channel is a plausible path to forging or disrupting whisper delivery.
- **Recommendation:** Do not re-attempt a console-only token generation fix — it will hit the same synchronization gap and likely be reverted again. The real fix, per the maintainer, requires locating where the game server/director reads its expected command-auth token and wiring a synchronized override mechanism on both the console and the game-server side (e.g. writing the generated token to a location or config the game server also reads at startup). This is out of scope for `docs/security/discord-player-link-hardening.md` specifically — track it as its own effort, cross-referencing issue #72, and do not close it as "won't fix" without addressing the two-sided sync requirement the maintainer identified. The unmerged `security/core-remove-hardcoded-command-token` branch (predates #72's discussion) should not be revived as-is since it repeats the same one-sided approach.

### FINDING-LINK-5: Whisper transport depends on Docker socket + string-templated Erlang (LOW/architectural) — REVIEWED, NOT IMPLEMENTED (out of scope for this branch)

- **Location:** `console/api/src/rmq.js:145-174` (`publishCarePackageWhisper`), `console/api/src/rmq.js:235-252` (`dockerExec`)
- **Risk:** Whisper delivery shells out to `docker exec dune-rmq-game rabbitmqctl eval "<Erlang>"`, building the Erlang term via string interpolation of base64-encoded, regex-validated fields (`validateWhisperIdentity`, `validateHexFlsId`, etc., `rmq.js:280-321`). Current input validation is reasonably strict (allowlist regexes reject the characters needed to break out of the base64 wrapper), so this is not an active injection vulnerability today, but it is architecturally fragile: every new whisper-sending feature must independently get this right, and the console process needs Docker socket access to the RMQ container, which is a broad privilege for a chat-message send.
- **Recommendation:** Replace with a proper AMQP client (e.g. `amqplib`) connecting directly to RabbitMQ over a scoped service account and TLS, removing both the Docker-socket dependency and the string-templated Erlang. Lower priority than FINDING-LINK-1 through -3 since no working exploit was found, but should be tracked as technical debt before any additional whisper-based features are added.
- **Verified no active exploit exists (this review pass):** confirmed directly that `recipientCharacterName` (validated only for length/printability, not for quote/bracket characters) cannot break out of the Erlang string literal even when it contains a deliberate breakout attempt (`"\">>), Sender = <<\"pwned"`), because the field is JSON-stringified and then base64-encoded as a whole blob before being spliced into the `evalCode` string — the base64 alphabet (`A-Za-z0-9+/=`) structurally cannot contain the `"` or `>` characters needed to break Erlang string syntax, regardless of what the pre-encoding validators allow. This confirms the finding's own characterization ("input validation is currently adequate") is accurate, not merely optimistic.
- **Explicit scope decision (this branch):** not implementing the AMQP-client rewrite here. `rmq.js`'s `dockerExec`/`rabbitmqctl eval` pattern is shared by 6 call sites across the console (`carePackage.js`, `messageOfTheDay.js`, `playerAnnouncements.js`, `broadcastProvider.js`, `server.js`, and `linkProvider.js`) — replacing it would mean adding a new runtime dependency (no AMQP client is currently a `console/api` dependency), building real connection/credential/TLS/retry management, and touching core web-admin features (server broadcast, shutdown scheduling, message-of-the-day) that have nothing to do with Discord player-linking. This is a repo-wide infrastructure change, not a player-link-scoped security fix, and doing it as a drive-by within a focused hardening PR would risk regressing unrelated, already-working functionality with no dedicated test coverage of the new transport layer. Recording this as an R2-style architectural prerequisite for a dedicated follow-up PR, per the "no active exploit, lower priority" framing already in this finding, rather than expanding this branch's scope to attempt it.

### FINDING-LINK-6: No multi-character or multi-account linking exists server-side (Design Gap, not a vulnerability) — IMPLEMENTED

> **Note:** this section's `dune.*`-qualified table names below reflect this finding's original implementation. They were subsequently moved to a project-owned `console` schema — see FINDING-LINK-SCHEMA below for why and how. Treat every `dune.discord_*` reference in this section as historical; the tables now live at `console.discord_*`.

- **Location:** `console/api/src/duneDb.js:4669-4713` (original schema migration for `dune.discord_player_links` and `dune.discord_pending_links`)
- **Original state:** `discord_player_links` has a unique index on `player_controller_id` (one Discord user per character) **and** the link is upserted keyed by `discord_user_id` alone (`duneDb.js:4762-4767`, `on conflict (discord_user_id) do update`), meaning **one Discord user can only ever have one linked character, globally, at a time.** Re-linking silently overwrites the previous link. This original single-link table and flow are unchanged by this fix and remain fully functional (see "Minimal Impact" below).
- **Bot-side drift:** `Arrakis-Control-Panel` (bot repo) commit `1ea3316` ("V2 multi-character, multi-guild Discord player linking") added client-side routes/methods (`player-links-start`, `player-links-verify`, `player-links`, `player-links-unlink`, `guild-grants-enable/disable/default`) and local SQLite mirroring, all classified as `UNMERGED_ROUTES` in `src/adapterClient.js` — but at the time this finding was written **no corresponding schema, provider, or route existed anywhere in this console repo.** These were purely aspirational client scaffolding with no backend. This fix adds a real backend, but the bot's `UNMERGED_ROUTES` classification and the route paths/payload shapes below have not been cross-checked against the bot repo's expectations — see "Not implemented" below. Conflicting doc revisions in the bot repo (`docs/user-guide.md`, unresolved `<<<<<<< HEAD` markers) claiming a Steam-connection auto-link feature remain unaddressed; no such feature exists in this codebase.
- **Recommendation (original):**
  1. Add `dune.discord_account_links` with composite unique `(discord_user_id, account_id)` instead of a single-column unique on `discord_user_id`, keeping `player_controller_id` unique per row (a character still belongs to exactly one Discord user).
  2. Add an `is_default` boolean with a partial unique index enforcing exactly one default per `discord_user_id`.
  3. Key the pending-link table on `(discord_user_id, account_id)` rather than `discord_user_id` alone so concurrent verifications for different accounts don't collide (current schema already uniques `discord_pending_links` by `discord_user_id`, which would need to change too — `duneDb.js:4709-4710`).
  4. Each additional account link still requires its own online-character whisper verification; there is no way to bulk-verify accounts the requester doesn't control, and that constraint should be preserved.
  5. Update the bot's `UNMERGED_ROUTES` classification and stale docs (`docs/user-guide.md` merge conflicts) once real routes exist, and remove the Steam-auto-link documentation claim unless it is actually built.
- **Implemented:** Items 1-4, additively, alongside (not replacing) the original single-link flow:
  1. New `dune.discord_account_links` table with composite unique `(discord_user_id, player_controller_id)` **and** a standalone unique index on `player_controller_id` alone (`duneDb.js`'s `migrateDiscordAdapterSchema()`), so a character still belongs to exactly one Discord user, but one Discord user can now hold multiple linked characters.
  2. `is_default` boolean column with a partial unique index (`where is_default`) enforcing at most one default per `discord_user_id`. The first account a user links becomes their default automatically (`linkAdditionalAccount()`); later links are not default unless `setDefaultLinkedAccount()` is called explicitly. Unlinking the current default promotes the next-oldest remaining link to default (`unlinkAdditionalAccount()`), so a user with ≥1 linked account always has exactly one default, never zero.
  3. New `dune.discord_pending_account_links` table keyed by `(discord_user_id, player_controller_id)` (with `code` as its own primary key and a standalone unique index on `player_controller_id`, mirroring the account-link table's dual-uniqueness shape), so verifying a second/third character does not collide with or cancel a still-pending verification for a different character.
  4. Preserved exactly: `linkAccountProvider()` in the new `console/api/src/integrations/discord/multiAccountLinkProvider.js` reuses the identical online-character-only, whisper-delivered verification flow as the original `linkProvider.js` (same code format, same 5-minute expiry, same "must be online" and "no active Funcom identity" checks) — there is no bulk-link or admin-assisted linking path; every additional account still requires the requester to prove control of that specific character in real time.
  - New provider functions: `linkAccountProvider`, `verifyAccountLinkProvider`, `unlinkAccountProvider`, `listAccountsProvider`, `setDefaultAccountProvider`.
  - New routes (all POST, gated by the new self-scoped `ACCOUNT_LINK_WRITE` capability — see FINDING-LINK-2's pattern, reused as a **distinct** capability rather than overloading `PLAYER_LINK_WRITE`, so the two flows can be enabled/audited independently): `/players/accounts/link`, `/players/accounts/link/verify`, `/players/accounts/unlink`, `/players/accounts/list`, `/players/accounts/set-default`.
  - New rate limiter instance for `verifyAccountLinkProvider()`, same shape as FINDING-LINK-3's but in a **separate env var namespace** (`DUNE_DISCORD_ACCOUNT_LINK_VERIFY_MAX_ATTEMPTS`/`_GLOBAL_MAX_ATTEMPTS`/`_WINDOW_MS`/`_BLOCK_MS`) so tuning or exhausting one flow's limiter never affects the other's, even for the same `discordUserId`.
- **Follow-up hardening (found during a deep re-review pass, same branch, before merge):** the initial implementation enforced "a character belongs to exactly one Discord user" only WITHIN each table separately — `discordPlayerLink()` checked `discord_player_links` for a conflicting owner, and `linkAdditionalAccount()` checked `discord_account_links`, but neither checked the OTHER table. Directly reproduced both directions of the resulting gap before fixing it: (1) a character already linked to Discord user A via the legacy single-link flow could be silently claimed by a different Discord user B via the new multi-account flow, and (2) the reverse — a character linked via the multi-account flow could be silently reclaimed by a different Discord user via the legacy single-link flow's overwrite-on-upsert behavior. Both directions let a second Discord user seize read/write access to a character's inventory, storage, and identity binding out from under its rightful linked owner, without ever needing to defeat either table's own uniqueness constraint. Fixed by adding `otherTableLinkConflict()` — both `discordPlayerLink()` and `linkAdditionalAccount()` now also check the other table for a conflicting owner (row-locked with `for update`, inside the same transaction as the existing own-table check, so the check is race-safe against a concurrent link attempt in the other table). Proven directly in the new `test/discordCrossLinkInvariant.test.js`, which exercises the real `duneDb.js` functions (not just the provider layer) against a single mock modeling both tables together.
- **Not implemented (still open):**
  - Item 5 from the original recommendation: the bot repo's `UNMERGED_ROUTES` classification, route paths, and payload shapes have **not** been reconciled with what this implementation actually built. The route paths chosen here (`/players/accounts/*`) were designed against this console repo's own conventions, not against the bot repo's pre-existing client scaffolding (`player-links-start`, `player-links-verify`, etc.) — a bot-side integration pass is required before any Discord command actually calls these new routes, and the bot's stale docs/`UNMERGED_ROUTES` comments still need updating separately in `yacketrj/Arrakis-Control-Panel`.
  - No Discord slash-command wiring exists yet in this console repo for the new routes (there is no bot process in this repository at all — commands like `/dune data accounts` referenced in the new provider's user-facing messages describe an intended bot-side UX, not something implemented here).
  - No data migration path from `discord_player_links` to `discord_account_links` was written; the two tables intentionally coexist with no automatic backfill (see "Minimal Impact").
  - The Steam-connection auto-link documentation claim in the bot repo remains unaddressed (out of scope — no such feature exists in either repo).

### FINDING-LINK-SCHEMA: Discord-linking tables were created inside the game's own `dune` schema, not a project-owned schema — IMPLEMENTED

- **Location:** `console/api/src/duneDb.js` — `migrateDiscordAdapterSchema()` and every query function touching the four linking tables (`getLinkedPlayer`, `discordPlayerLink`, `discordPlayerUnlink`, `otherTableLinkConflict`, `listLinkedAccounts`, `linkAdditionalAccount`, `unlinkAdditionalAccount`, `setDefaultLinkedAccount`, `createPendingAccountLink`, `deletePendingAccountLink`, `consumePendingAccountLink`, `createPendingLink`, `deletePendingLink`, `consumePendingLink`, `cleanupExpiredPendingLinks`).
- **Risk:** All four Discord-linking tables (`discord_player_links`, `discord_pending_links`, `discord_account_links`, `discord_pending_account_links`) were created directly inside the `dune` Postgres schema — the same schema the game server itself owns and manages (this project's Postgres container runs Funcom's own `registry.funcom.com/funcom/self-hosting/igw-postgres` image; every other table in `dune` — `accounts`, `player_state`, `guilds`, `items`, `landsraad_*`, etc. — was created by the game, not by this project). Creating tables inside a vendor-owned schema is architecturally wrong regardless of whether a naming collision has occurred yet: a future game-server upgrade could add, rename, or restructure anything in that schema with zero awareness that this project's own state lives there too, and mixing the two makes "what does this project actually own vs. what does the game own" impossible to tell at a glance from the schema alone.
- **Recommendation:** Move all project-owned state out of `dune` into a schema this project fully owns.
- **Implemented:** Added a new `console` schema (created via `create schema if not exists console`, idempotent, run at the top of `migrateDiscordAdapterSchema()`) in the *same* Postgres database — not a separate database or container. All four tables and every query referencing them were moved from `dune.*` to `console.*`. Cross-schema joins against the game's real tables (e.g. `console.discord_player_links` joined to `dune.player_state`) work exactly as before; Postgres does not require tables joined together to share a schema. Choosing a new schema in the same database (rather than a fully separate database, or moving off Postgres entirely to something like SQLite) was deliberate: this project's existing backup/restore tooling (`runtime/scripts/db.sh`, `db-manager.sh`) is `pg_dump`-based against the single `dune` *database* as a whole, schemas included — a new schema in the same database is automatically covered by that existing tooling with zero new infrastructure, new dependency, or new backup script required. A fully separate database would have required new connection-pool wiring and a new backup step; moving to SQLite would have required a new dependency and lost transactional consistency with the game's own data (e.g. restoring the game database to an earlier point would not roll back linking state kept in a separate file).
- **Data migration:** Confirmed via direct inspection of the only known live deployment that none of the four tables had any production data — `discord_player_links` was empty, and `discord_account_links`/`discord_pending_account_links` had never even been created yet (lazily created on first use, and no route had triggered that yet). Given zero data existed, `ensureConsoleSchema()` drops the old `dune.*` copies outright as part of the same migration that creates the `console` schema, rather than writing a data-preserving `ALTER ... SET SCHEMA` migration path for data that didn't exist. If you are running this migration against a deployment where these tables unexpectedly do contain data, **back it up manually first** — this migration will discard it, not migrate it.
- **Tests:** All existing tests for the linking flows (`discordAdapter.test.js`, `discordCrossLinkInvariant.test.js`, `discordLinkProvider.test.js`, `discordMultiAccountLinkProvider.test.js`) were updated in place — every mock `db.query()` matcher that string-matched `"...dune.discord_..."` now matches `"...console.discord_..."`, since these tests assert against the literal SQL text the real functions issue. No test assertions or mock *behavior* changed, only the schema-qualified table names they match against; the tests still prove the same things (ownership conflicts, rate limiting, cross-table invariants, etc.) they did before. `console/api` 609/609 passing after the change.
- **Not implemented:** No automated check yet prevents a future change from accidentally creating a new project-owned table back inside `dune` — this relies on code review, not tooling. A `tests/security-pr-checks.sh` grep-based guard (or a semgrep rule) for `create table.*\bdune\.` outside of read-only game-data query files would close this gap; tracked as a follow-up, not implemented in this pass.

## STRIDE Notes

| Category | Current Control | Gap |
| --- | --- | --- |
| Spoofing | Single shared bearer token for the whole adapter | No per-actor authentication; `userId`/`roleIds` are unauthenticated claims (LINK-1) |
| Tampering | Strict allowlist regex validation on whisper fields (`rmq.js`) | String-templated Erlang eval remains architecturally fragile (LINK-5) |
| Repudiation | No link/unlink/verify audit event was found in `linkProvider.js` beyond the pending-link/player-link tables themselves | Add structured audit events (actor, action, result, correlation ID) for link/verify/unlink, matching the pattern in the bot's `writes.js::writeAuditEvent()` |
| Information disclosure | Character-name/online-status resolution requires the character to be online | Combined with LINK-1, this becomes an online-status oracle for arbitrary character names |
| Denial of service | 5-minute code expiry limits window | No per-actor rate limit on link attempts or verify attempts (LINK-3) |
| Elevation of privilege | Capability-tier RBAC (`policy.js`) | `moderator` tier is too broad for an identity-binding write (LINK-2); tier itself is only as trustworthy as the unauthenticated `roleIds` claim (LINK-1) |

## Minimal Impact (Proposed)

- No change to the whisper message content or in-game player experience.
- No change to the `/dune data link` / `/dune data verify` / `/dune data unlink` command surface from the operator's perspective — only the trust/authorization internals change.
- FINDING-LINK-2 required no operator action: any actor holding at least one configured Discord role (`observer` and above) can still use `player-link:write` exactly as before — the fix removed the capability from the tier ladder entirely rather than moving it to a stricter tier, so no existing operator role configuration needs to change.
- FINDING-LINK-6's schema change is additive (new tables) and required no migration of existing single-character links: `discord_player_links`/`discord_pending_links` and their routes/functions are completely untouched by this fix. A Discord user's existing single link keeps working exactly as before, in parallel with the new multi-account tables, with no automatic backfill between them. A migration path (or a decision to formally deprecate the single-link flow in favor of the multi-account one) is left for a future follow-up, not this branch.
- FINDING-LINK-6 adds a new self-scoped capability (`ACCOUNT_LINK_WRITE`) rather than reusing `PLAYER_LINK_WRITE`, so no existing operator role configuration needs to change to use the new routes — any actor already authorized for `PLAYER_LINK_WRITE` (any non-`public` tier) is authorized for `ACCOUNT_LINK_WRITE` under the same rule, since both are self-scoped by the identical `requireSelfScopedCapability()` mechanism.

## Verification (This Branch)

- `npm test --prefix console/api`: 598/598 tests pass. Baseline 540
  (inherited from `main` at `0ae01dc` after #103/#104 merged) + 20
  (FINDING-LINK-1: 17 unit tests in `test/discordActorSignature.test.js`
  plus 1 end-to-end integration test in `test/discordAdapter.test.js`
  proving a spoofed actor is rejected with `403 invalid_actor_signature`
  even with a valid bearer token) + 9 (FINDING-LINK-2: 8 unit tests in
  `test/discordPolicy.test.js` plus 1 end-to-end integration test in
  `test/discordAdapter.test.js` proving a `public`-tier actor is rejected
  with `403 not_authorized` from `/players/link` while an `observer`-tier
  actor is allowed through to the provider) + 4 (FINDING-LINK-3: 3 unit
  tests in `test/discordLinkProvider.test.js` — lockout after repeated
  wrong guesses, per-`discordUserId` scoping so one user's lockout doesn't
  block another, and lockout reset on success — plus 1 end-to-end
  integration test in `test/discordAdapter.test.js` proving a real HTTP
  request sequence against `/players/link/verify` gets `429
  verify_rate_limited` on the third wrong guess) + 4 (FINDING-LINK-1
  cross-route-replay follow-up hardening, found during self-review: 3
  unit tests in `test/discordActorSignature.test.js` proving the
  canonical payload differs per route and a signature valid for one route
  is rejected for another, plus 1 end-to-end integration test in
  `test/discordAdapter.test.js` proving a signature captured from a real
  `/status` HTTP response is rejected when replayed against `/readiness`)
  + 19 (FINDING-LINK-6: 14 unit tests in the new
  `test/discordMultiAccountLinkProvider.test.js` — first-link-becomes-default,
  second link does not override the default, a character already linked to
  one Discord user cannot be linked by another, duplicate self-link is
  rejected as a conflict rather than silently duplicated, verify links
  correctly and lists alongside prior accounts, a different Discord user
  cannot consume another's pending code, unlinking a non-default account
  leaves the default untouched, unlinking the default promotes the
  next-oldest remaining account, unlinking/setting-default for an
  unlinked character returns a business error not a crash,
  `setDefaultAccountProvider` switches the default correctly, the new
  rate limiter is verified independent from the single-link flow's,
  offline-character and failed-whisper-delivery checks mirror the
  single-link flow — plus 3 unit tests in `test/discordPolicy.test.js`
  proving `ACCOUNT_LINK_WRITE` is self-scoped, distinct from
  `PLAYER_LINK_WRITE`, and follows the same
  `requireSelfScopedCapability()`/`requireDiscordCapability()` rejection
  rules — plus 2 end-to-end integration tests in
  `test/discordAdapter.test.js`: one proving a `public`-tier actor is
  rejected from `/players/accounts/link` while an `observer`-tier actor
  can reach `/players/accounts/list` and get a normal empty result, and
  one proving the account-link verify route's rate limiter is a genuinely
  separate instance from the single-link route's — exhausting the
  account-link limiter for a `discordUserId` does not block that same
  `discordUserId` on the single-link verify route) + 4 (FINDING-LINK-6
  cross-table-conflict follow-up hardening, found during a deep re-review
  pass before merge: 4 tests in the new
  `test/discordCrossLinkInvariant.test.js`, exercising the real
  `discordPlayerLink()`/`linkAdditionalAccount()` functions directly
  against a single mock db modeling both tables together — a character
  linked via the single-link flow cannot be claimed by a different
  Discord user via the multi-account flow, the reverse direction is also
  blocked, the SAME Discord user re-affirming their own character through
  the other flow is correctly NOT blocked, and linking an unrelated,
  non-conflicting character through either flow still succeeds normally).
- `npm audit --prefix console/api --audit-level=moderate`: 0 vulnerabilities
  (re-verified after FINDING-LINK-6; no new dependencies added — the new
  provider reuses `createLoginRateLimiter`, `publishCarePackageWhisper`,
  and `ensureCarePackageServerPersona` from existing modules).
- `npm run build --prefix console/web`: builds clean (no web-side changes
  in any of these findings, including FINDING-LINK-6, which is
  console-API-only; run as a regression check).
- `gitleaks detect --no-git`: no leaks.
- `trivy fs --scanners secret --severity HIGH,CRITICAL`: no findings.
- `semgrep --config auto` and `semgrep --config p/default` on all
  new/changed files (including FINDING-LINK-6's `duneDb.js` additions,
  `multiAccountLinkProvider.js`, and the `routes.js`/`adapter.js`/`policy.js`
  wiring): 0 findings.
- `ggshield secret scan pre-push`: clean.

## Remaining Verification Plan (FINDING-LINK-5 Explicitly Out of Scope)

```bash
npm test --prefix console/api
npm audit --prefix console/api --audit-level=moderate
npm run build --prefix console/web
```

Status of previously proposed targeted tests:
- ~~Actor payload with mismatched/forged `userId` is rejected once signature/HMAC verification lands (FINDING-LINK-1).~~ Done — see Verification above.
- ~~`moderator`-tier actor is denied `player-link:write` after the tier change (FINDING-LINK-2).~~ Done — see Verification above. (Note: the actual fix authorizes any non-`public` tier for this self-scoped action rather than restricting it upward to `admin`; see the FINDING-LINK-2 section for why.)
- ~~Repeated failed verification attempts trigger lockout (FINDING-LINK-3).~~ Done — see Verification above. (Item 2, longer codes, and item 3, an audit/log event on repeated failure, remain open — see the FINDING-LINK-3 section.)
- ~~`discord_account_links` composite-unique constraint allows two different `player_controller_id`s for the same `discord_user_id`, and rejects a duplicate `(discord_user_id, player_controller_id)` pair (FINDING-LINK-6).~~ Done — see Verification above (`linkAdditionalAccount()`/`linkAccountProvider()` tests).
- Remaining open item (not test-plan-blocking, but tracked): bot-side integration tests in `yacketrj/Arrakis-Control-Panel` exercising the new `/players/accounts/*` routes do not exist yet, since no bot process lives in this repository — see FINDING-LINK-6's "Not implemented" list.

## Known Limitations

- Signature verification is opt-in (`DUNE_DISCORD_ACTOR_SECRET` unset by
  default). Deployments that have not configured it remain exactly as
  exposed to FINDING-LINK-1 as before this change. Making it mandatory
  requires bot-side signing support to exist first (see Remediation Status).
- **No nonce or one-time-use enforcement.** The signature binds
  `(route, userId, guildId, channelId, roleIds, interactionId, timestamp)`
  but nothing rejects the exact same signed envelope being resent multiple
  times within the freshness window (confirmed directly: two identical
  `verifyActorSignature()` calls with the same signature both succeed).
  `interactionId` is included in the signed fields but is never checked
  for uniqueness anywhere in the codebase today — it is currently
  informational only. This means a captured valid request can be replayed
  verbatim (same route, same body) as many times as an attacker likes
  within ~30 seconds. It cannot be replayed against a *different* route or
  with a *different* body (see the route-binding fix above), which was the
  more serious gap. Closing same-route/same-body replay fully would require
  tracking consumed `interactionId`s (or a dedicated nonce) server-side
  with a bounded TTL store, which was judged out of scope for this pass —
  tracked as a follow-up.
- The signed field set (`userId`, `guildId`, `channelId`, `roleIds`,
  `interactionId`) does not cover `username` or `commandName` — these
  remain unauthenticated informational fields. They are not used for any
  authorization decision today (`discordActorTier`/`discordActorCan` only
  read `roleIds`), so this is intentional, not an oversight, but should be
  re-checked if either field is ever used for a security decision.
- This does not implement Discord's own Ed25519 interaction-signature
  verification (option 1 in the original recommendation), which would be
  stronger since it wouldn't require provisioning/rotating a second shared
  secret. Left as a future option if the adapter is ever made reachable
  independently of a single trusted bot process.
- Recommendation item 3 from the original finding (treat the bearer token
  as a master credential in operator secret-handling docs) is not yet
  reflected in `docs/security-gates.md` or operator-facing setup
  documentation outside this file.
- FINDING-LINK-2's fix authorizes `PLAYER_LINK_WRITE` for any actor above
  `public` tier, which still depends on FINDING-LINK-1's actor-authenticity
  fix (or the pre-existing bearer-token-only trust model) to mean anything
  — `requireSelfScopedCapability()` trusts `actor.roleIds` exactly as much
  as `requireDiscordCapability()` does. It does not itself verify the
  actor is who they claim to be; it only decides that, given a trusted
  actor, self-linking should not require a specific privileged role. Treat
  FINDING-LINK-1 and FINDING-LINK-2 as complementary, not independent:
  LINK-2 narrows *who is allowed to self-link* once identity is trusted;
  LINK-1 is what makes that identity trustworthy in the first place.
- `requireSelfScopedCapability()` does not verify `target == actor.userId`
  directly — it relies on every current self-scoped route already always
  passing `discordUserId: actor.userId` with no separate target parameter
  (documented in the function's own comment). If a self-scoped route is
  ever added or changed to accept a distinct target, this function must be
  revisited before that route ships, or a genuinely privileged actor could
  again act on someone else's identity.
- FINDING-LINK-3's rate limiter is in-memory (`Map`-backed, via
  `createLoginRateLimiter()`), the same as the pre-existing login rate
  limiter it reuses. Lockout state does not survive a console process
  restart and is not shared across multiple console replicas, if the
  console is ever run with more than one instance behind a load balancer.
  This matches the existing limitation already accepted for login rate
  limiting; a persisted/shared store would need to address both at once.
- FINDING-LINK-3 rate-limits by `discordUserId` only. It does not add a
  separate limit on `linkPlayerProvider()` (the code-generation side) —
  that side is already implicitly throttled by `createPendingLink()`'s
  one-pending-link-per-user uniqueness constraint (a second link request
  before the first expires returns "already pending" rather than issuing a
  new code), so a dedicated rate limiter there was judged unnecessary. If
  that uniqueness constraint is ever relaxed, this should be revisited.
- FINDING-LINK-3's limiter has no bound on the number of distinct
  `discordUserId` keys it tracks. `discordUserId` is not validated as a
  real Discord snowflake anywhere in the actor pipeline (`normalizeDiscordActor()`
  in `policy.js` only checks non-empty and ≤256 chars), and entries are
  only evicted lazily on next access to that same key
  (`createLoginRateLimiter`'s `activeAttempt()` — there is no periodic
  sweep). An attacker with the adapter bearer token (and, if
  `DUNE_DISCORD_ACTOR_SECRET` is configured, a valid actor signature) could
  submit many distinct fake `discordUserId` values to grow the limiter's
  internal `Map` without bound over time. This is not a new risk
  introduced by this fix — the pre-existing login rate limiter has the same
  characteristic keyed by remote address, which is also attacker-rotatable
  — but it is worth calling out precisely rather than only under the more
  general "in-memory" limitation above. A bounded LRU or periodic sweep
  would close this; not implemented here since it applies equally to the
  pre-existing login limiter and was judged a shared follow-up rather than
  specific to this finding.
- FINDING-LINK-6's new rate limiter (`multiAccountLinkProvider.js`) has the
  identical unbounded-key-growth characteristic described above for
  FINDING-LINK-3's limiter, since it is created via the same
  `createLoginRateLimiter()` factory. Not a new risk, but now duplicated
  across two limiter instances instead of one.
- FINDING-LINK-6 has no bot-side integration: the new routes
  (`/players/accounts/*`) exist and are tested at the console/API level
  (unit tests + HTTP-level integration tests against a mocked db), but no
  real Discord bot in `yacketrj/Arrakis-Control-Panel` has been updated to
  call them, and this branch does not touch that repository. Until that
  integration work happens, these routes are reachable but unused by any
  shipped Discord command.
- FINDING-LINK-6 does not add a limit on how many characters a single
  Discord user may link. `discord_account_links` has no cap enforced at
  the database or provider level — a user (or an attacker with valid
  verification access to many characters) could link an arbitrarily large
  number of accounts. This mirrors the original single-link flow's lack of
  any similar limit and was not identified as a requirement in the
  original finding, but is worth calling out explicitly since the
  multi-account design makes unbounded growth possible in a way the
  single-link flow structurally could not.
- FINDING-LINK-6's `unlinkAdditionalAccount()` promotes the next-oldest
  remaining link to default when the current default is removed, with no
  way for the caller to opt out of that promotion in the same call — a
  caller who wants "unlink and leave no default" must make two calls
  (`unlink`, then observe there's still a default, then decide whether to
  change it). This matches the finding's minimal-impact intent but is a
  minor UX rigidity, not a security issue.
- The cross-table ownership check (`otherTableLinkConflict()`) only guards
  the two `discord_*_links` tables — it does not extend to the two
  *pending* tables (`discord_pending_links` / `discord_pending_account_links`).
  It is possible for Discord user A to hold a pending single-link
  verification code for character X at the same time Discord user B holds
  a pending multi-account verification code for the same character X.
  This is not itself exploitable — the actual ownership decision happens
  at consume-time (`discordPlayerLink()`/`linkAdditionalAccount()`), which
  IS cross-table-checked, so whichever user's code is verified first wins
  and the second verification attempt is correctly rejected by the fix
  above. It is, at most, a minor UX confusion (two whispers in flight for
  the same character from two different Discord users), not a security
  gap, and was judged not worth the added complexity of cross-checking
  the pending tables too.

## Remediation Status

| Finding | Status | Verification |
|---------|--------|--------------|
| FINDING-LINK-1 Unauthenticated actor identity | Implemented (backward-compatible, opt-in; route-bound signature added during self-review to close cross-route replay) | `console/api` 575/575 tests pass at time of fix; gitleaks/semgrep clean |
| FINDING-LINK-2 `player-link:write` at `moderator` tier | Implemented (self-scoped, not tier-restricted) | `console/api` 567/567 tests pass at time of fix; gitleaks/semgrep clean |
| FINDING-LINK-3 No verification rate limiting | Partially implemented (rate limiting done; longer codes and audit logging still open) | `console/api` 571/571 tests pass at time of fix; gitleaks/semgrep clean |
| FINDING-LINK-4 Hardcoded command-auth token | Resolved-by-discussion upstream | See `Red-Blink/dune-awakening-selfhost-docker#72` |
| FINDING-LINK-5 Whisper transport via docker-exec/rabbitmqctl | Reviewed, confirmed non-exploitable, rewrite explicitly out of scope | Direct injection-breakout test performed (see finding); no code change proposed |
| FINDING-LINK-6 No multi-character/multi-account linking | Implemented (additive; new capability, new rate limiter, new routes; cross-table ownership check added during review; no bot-side integration yet) | `console/api` 598/598 tests pass; gitleaks/semgrep/trivy clean |
| FINDING-LINK-SCHEMA Discord-linking tables created in the game's own `dune` schema | Implemented (moved to a new project-owned `console` schema, same database; no automated regression guard yet) | `console/api` 609/609 tests pass; confirmed zero production data existed to migrate |

## Sources

- `console/api/src/integrations/discord/policy.js`
- `console/api/src/integrations/discord/linkProvider.js`
- `console/api/src/integrations/discord/multiAccountLinkProvider.js`
- `console/api/src/integrations/discord/routes.js`
- `console/api/src/integrations/discord/adapter.js`
- `console/api/src/integrations/discord/actorSignature.js`
- `console/api/src/rmq.js`
- `console/api/src/carePackage.js`
- `console/api/src/duneDb.js`
- `docs/security/generated-command-auth-token.md`
- `docs/security/login-rate-limit-defense.md`
- `Red-Blink/dune-awakening-selfhost-docker#72` ("[Discussion] RabbitMQ / Command Auth Token", closed 2026-07-17)
- `Red-Blink/dune-awakening-selfhost-docker#100` (tracking issue for FINDING-LINK-1, -2, -3, -5, -6)
- `yacketrj/Arrakis-Control-Panel:docs/security-audit/2026-07-04-comprehensive-security-audit.md`
- `yacketrj/Arrakis-Control-Panel:src/adapterClient.js` (`UNMERGED_ROUTES`)
- `yacketrj/Arrakis-Control-Panel:docs/user-guide.md` (unresolved merge conflicts referencing Steam auto-link)
