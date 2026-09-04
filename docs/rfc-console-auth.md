# RFC: Console Layered Authentication — Discord OAuth (Fixed), Optional Passkeys, Hardened Password Fallback

**Date:** 2026-08-17 (revised 2026-08-20)
**Status:** Accepted — merged via PR #170 (2026-08-18); this revision closes findings from a post-merge validation review (see §8).
**Audit:** Three Layer 1 Eight-Hat passes (two full, one targeted), upstream identity/recovery-code/upgrade-path corrections at merge review, and a 2026-08-20 four-lens post-merge validation (Technical Writer, Security Architect, UI/UX, GRC); findings summary in §8.

**Dependency note (updated for the split submission):** §2.1 (Tier 1) and part of §2.2 (Tier 2) reference `console/api/src/integrations/discord/oauth.js` and `handoff.js` — the Discord OAuth sign-in + signed-handoff tier-resolution system. That code is submitted alongside this RFC as its own stacked draft PR (base: this Tier 3 PR); §2.3 (Tier 3), the mandatory-TOTP change this RFC section otherwise documents, has no dependency on it and can be reviewed and merged independently. Sequencing is left to the maintainer's judgment.

---

## 1. Problem

The console's admin login today is a single shared password (`ADMIN_PASSWORD` or a generated secret) on both this fork and upstream, plus an optional "Sign in with Discord" path (`console/api/src/integrations/discord/oauth.js`) that resolves a tiered session via a signed handoff to the operator's own Discord bot — this second path exists only in this fork today (see the dependency note above).

Two independent, real problems exist in this area today, both confirmed against the current code, not theoretical:

**1.1 — A fail-open privilege-escalation bug in the existing Discord OAuth path.**

`resolveOAuthTier()` (`oauth.js:166-183`) falls through to a static, env-configured owner allowlist (`resolveBootstrapTier()`) whenever the bot's role-resolution handoff (`handoff.js`) returns an empty tier **for any reason** — network timeout, bot down, malformed response, or a genuine "this user has no access" denial are all indistinguishable to the caller:

```js
export function resolveBootstrapTier({ userId, guildIds, allowOwnerBootstrap, homeGuildId, ownerAllowlist = [] }) {
  if (!allowOwnerBootstrap) return "";
  if (!homeGuildId) return "";
  if (!guildIds.includes(homeGuildId)) return "";
  if (!ownerAllowlist.includes(userId)) return "";
  return "owner";
}
```

This requires four simultaneous conditions (bootstrap explicitly enabled, a home guild configured, live guild membership, and static-allowlist membership) — not "any Discord user" — but the real bug is genuine: an operator who runs with bootstrap enabled (a supported, documented configuration) and later revokes someone's Discord role, but doesn't also remember to prune the static `DISCORD_OAUTH_OWNER_ALLOWLIST` env var (no UI, no reminder, an easy miss), has that person's access silently restored to `owner` the moment the bot handoff has any hiccup at all — a bot restart, a network blip, or a deliberate DoS against the bot.

**1.2 — No hardened, non-Discord login path exists for operators who don't or can't use Discord.**

Every self-hosted operator of this project needs a working login even without any Discord integration configured (a fresh install, or a permanent choice not to run a Discord community around the server). Today, that path is the single shared password with no second factor and no recovery mechanism beyond the password itself — for an operator with no Discord and no reverse-facing TLS in their access path (a common, legitimate, permanent configuration — not just a startup-transient state), **this password is the sole thing standing between an attacker and full owner access, for the entire lifetime of the install.**

---

## 2. Architecture

Rather than replacing the password path with a single new "primary" mechanism (two earlier internal drafts of this design each tried that — one made Discord OAuth the sole primary and depended on Cloudflare Access for multi-admin identity management, the other made WebAuthn/passkeys the sole primary — both were rejected at Layer 1 audit for assuming a network/identity topology that doesn't hold for this project's actual, self-hosted, globally-diverse operator base; see §8 for the specific findings), this RFC proposes three independently-optional login tiers, so each operator's real deployment determines which one(s) they actually have:

### 2.1 Tier 1 — Discord OAuth (fixed)

**Depends on the Discord OAuth system submitted in the stacked companion PR** (see the dependency note at the top of this document). No new requirement over what that PR implements. The only change is closing the fail-open bug from §1.1:

```js
// Current (condensed for readability -- the real code at oauth.js:166-183
// spells out the bootstrap fields individually; behavior is identical):
export function createOAuthTierResolver({ bootstrap = {}, handoff = null } = {}) {
  return async function resolveOAuthTier(identity) {
    const { userId, guildIds } = identity;
    if (handoff && handoff.enabled) {
      const tier = await handoff.resolveTier({ userId, username: identity.username });
      if (tier) return tier;
    }
    return resolveBootstrapTier({ userId, guildIds, ...bootstrap });
  };
}

// Fixed: only consult the bootstrap allowlist when the handoff is not
// configured at all -- never when it's configured but the specific call failed.
export function createOAuthTierResolver({ bootstrap = {}, handoff = null } = {}) {
  return async function resolveOAuthTier(identity) {
    const { userId, guildIds } = identity;
    if (handoff && handoff.enabled) {
      // Handoff is configured: its result is authoritative. An empty
      // result means "deny" (bot unreachable, or bot said no), not
      // "fall through to the static allowlist" -- the allowlist exists
      // only to bootstrap the very first owner on an install that has
      // never configured a handoff at all, not to survive an outage
      // once one is configured.
      return handoff.resolveTier({ userId, username: identity.username });
    }
    return resolveBootstrapTier({ userId, guildIds, ...bootstrap });
  };
}
```

This is the entire authorization fix — no cache, no grace window, no new persisted state. `handoff.enabled` is already a static, boot-time-computed boolean (`handoff.js:27-33`), so the fix is a one-line change to *when* the bootstrap fallback is consulted, not a new mechanism. Three supporting requirements accompany it (added by post-merge review — see §8):

- **Fail loudly on the half-configured state.** Today, setting the handoff `secret` and `botUrl` without `homeGuildId` yields `enabled: true` but a `resolveTier()` that unconditionally returns `""` — under the fix, that misconfiguration would become "every Discord login denied, forever, indistinguishable from a bot outage." The console must instead refuse to treat the handoff as configured at boot when any of the three values is missing while another is set, logging exactly which value is absent.
- **Audit the denial reason without weakening the denial.** `handoff.js` internally distinguishes its failure modes (timeout, non-2xx, malformed body, bad signature, stale timestamp, identity mismatch, explicit no-tier) at distinct early-return points and currently discards that information. `resolveTier()` must surface a reason code **to the `audit()` log only** (`auth.handoff-denied` with the reason) — never to the authorization decision, which remains deny-on-empty regardless of reason. This keeps forensics (a bad-HMAC spoofing attempt vs. a clean deny) and operator debugging (bot down vs. role revoked) possible without reopening any fail-open path.
- **Say something actionable to the denied user.** The login failure page for this path must state that the console could not verify the user's current Discord role and that, if they administer this install, they should check that the companion bot is running — without revealing whether the specific failure was an outage or an explicit denial. A previously-working login that starts failing during a bot restart must not be indistinguishable, to the person staring at it, from revoked access with no next step.

**Trade-off, stated explicitly:** once an operator configures the bot handoff, a bot outage now means "no *new* Discord-tiered logins until the bot is back," instead of "the allowlist quietly grants owner regardless of the person's real current role." Already-active sessions are unaffected (session cookies validate against the in-memory session store, never re-checked against the handoff) — only *new* logins during an outage window are affected.

#### 2.1.1 Amendment — console-native role→tier resolution (so Tier 1 works without a companion bot)

*As implemented* in the companion Tier 1 PR — this whole subsection describes shipped behavior, not a proposal.

**Why this amendment exists.** §2.1 as accepted resolves a Discord user's tier through a signed handoff to the operator's own bot, with a static owner allowlist as the only alternative. §1.2 of this same document names the operator with no bot as a first-class case — and for that operator, §2.1 gives "sign in with Discord as owner, if allowlisted" and nothing else. That is Discord *authentication* without Discord *authorization*, and it is not what an operator means by role-based access. This amendment adds a third tier source that the console evaluates itself, from the Discord roles the signed-in member actually holds.

**What the operator configures.** The same information the companion-bot setup already gathers, as manual entries in the console's Discord OAuth settings (Settings → Discord OAuth):

| Field | Required | Stored as |
|---|---|---|
| Home guild | yes | `DISCORD_HOME_GUILD_ID` (exists) |
| Owner | automatic: the Discord server's owner | (derived; `DISCORD_OAUTH_OWNER_ALLOWLIST` env-only for additional owners) |
| Admin role ID | required | `DISCORD_CONSOLE_ADMIN_ROLE_IDS` |
| Moderator role ID | optional | `DISCORD_CONSOLE_MODERATOR_ROLE_IDS` |
| Player role ID | recommended | `DISCORD_CONSOLE_PLAYER_ROLE_IDS` |
| Require Discord 2FA for tiers | optional (suggested `owner,admin`) | `DISCORD_OAUTH_REQUIRE_MFA_TIERS` |

Each role field accepts one or more Discord role IDs (17–19-digit snowflakes, comma-separated); the operator copies them from Discord with Developer Mode on, exactly as for the bot. Nothing is fetched from Discord to populate the form — listing a guild's roles requires a bot token, which the console deliberately does not hold.

**What changes at sign-in.**

1. The authorization request adds the `guilds.members.read` scope. Operators who already authorized the application under the old `identify guilds` scope are asked by Discord to re-authorize once; no other operator-visible change.
2. After identity is fetched, the console calls `GET /users/@me/guilds/{home guild}/member` with the user's own token and reads the member's `roles` array. A 403/404 (not a member) is a deny, not an error.
3. Tier resolution order, **unchanged for anyone with a handoff configured**:
   - handoff configured → the handoff is authoritative, exactly as §2.1 specifies; role mapping and allowlist are not consulted. (An operator who runs the bot keeps the bot as the single source of truth — this amendment must not create two competing answers.) The Discord-account 2FA gate (step 4) is a policy layered on top of whichever tier source answered, so it applies on the handoff path too.
   - **Invariant — separation of duties: one Discord role maps to exactly one tier.** Only admin, moderator and player are role-mappable (owner never is — see below), so the dangerous case is a role listed under admin *and* a lower tier: every holder silently becomes admin under highest-wins. Such a mapping is refused at save time by the settings API and the guided setup, and, for a hand-edited `.env`, disables Discord sign-in at boot (and refuses `/start` and the callback) with a message naming the role — never resolved silently.
   - otherwise → the **highest** tier among: `owner` if the user ID is in the owner allowlist (only when bootstrap is enabled, as today); the tier of every mapped role the member holds. Precedence owner > admin > moderator > player. A member with no mapped role and no allowlist entry is denied.
4. **Discord-account 2FA gate.** The `identify` scope already returns `mfa_enabled`. If the resolved tier is in `DISCORD_OAUTH_REQUIRE_MFA_TIERS` and the account has no 2FA, sign-in is denied with a message that says so and names the remedy (enable 2FA on the Discord account). This is the MFA story for Tier 1: it reuses the factor the user already carries for Discord rather than adding a second enrollment flow on top of OAuth. It does not, and is not meant to, prove anything about the *console's* own second factor; §2.3 remains the only place a console-held factor exists. **Opt-in**, not default-on: an existing operator signing in through owner bootstrap whose Discord account has no 2FA would otherwise lose Discord sign-in on upgrade (found by the ported end-to-end test, which models exactly that operator). The settings form suggests `owner,admin`; nothing is enforced until a value is saved.
5. The callback's early deny "Discord sign-in is enabled but owner bootstrap is disabled" becomes "no tier source is configured" (reason `no_tier_source`): it fires only when there is neither a bot handoff nor a home guild — with a home guild set there is always at least one possible tier, its owner.

**Owner is the Discord server's owner — derived, not configured.** `GET /users/@me/guilds` (the `guilds` scope already requested) marks the guild the signing-in user owns with `owner: true`, and Discord permits exactly one owner per server. The console therefore grants **owner** to whoever Discord says owns the home guild, with no configuration and no way to misassign it — which is also the strongest form of the separation-of-duties invariant above, since no role can ever confer owner. The former "owner user IDs" allowlist (`DISCORD_OAUTH_OWNER_ALLOWLIST`) is retained env-only, for back-compatibility and for the rare install that wants additional owners; it is no longer in the settings form. Precedence: guild owner > allowlisted owner > highest mapped role.

**First-run setup is a guided flow, not a settings section.** An unconfigured console shows *Set up Discord sign-in* on the sign-in page. **The admin password comes first** — only the console owner may connect Discord, because otherwise anyone who owns some Discord server could complete a round-trip and point this console at their server. The Discord application itself (client ID, secret, redirect URI) is deployment configuration, as it is for a bot: set in `.env` as a one-time deployment step (client id, secret, redirect); the setup screen shows the exact redirect URI to register and, for an install that has none, the `.env` keys to set -- it does not collect the client secret in the first-run flow. (Rotation later is available in Settings.) Then:

1. **Continue with Discord** — a real OAuth round-trip in *setup mode*: `/api/auth/discord/start?setup=1` is reachable only from an owner session and issues a pending state tagged `setup`; the callback, seeing that tag, fetches identity but **mints no tiered session and resolves no tier** — it records the operator's Discord identity and the servers they **own** (id, name; other servers are discarded) on the owner session that started it and returns to the wizard.
2. **Everything Discord can tell the console is pre-filled** — who the operator is and the server(s) they own, the single one preselected, and therefore who the Owner is. Only a server the operator **owns** is offered or can be connected.
3. **Map roles** — Admin (required), Moderator and Player, typed role IDs with the Developer-Mode instructions; optional *Require Discord 2FA for* (suggested on).
4. **Save** (`POST /api/setup/discord-finalize`) — no password again: the owner session (created by the password entered to start setup) is the proof, together with the requirement that the operator owns the chosen server. Finalize refuses to require Discord 2FA for Owner/Admin while the operator's own Discord account has 2FA off (reason `operator_mfa_missing`), so the operator cannot lock themselves out on the next restart. The console writes the same keys as the settings API and reports that a restart is required; after restart the sign-in page shows *Sign in with Discord* as the primary action with *Use the admin password instead* beneath it as the break-glass path.

The settings section remains for editing the role mapping and the 2FA option afterwards, and offers *Run setup again*.

**What does not change.** Sessions, the policy engine, the per-tier defaults, the route→action gate, the fail-closed handoff semantics of §2.1, the `handoff_misconfigured` refusal (the former `bootstrap_disabled` refusal is superseded by `no_tier_source`, step 5), PKCE, the state cookie. Every OAuth endpoint stays rate-limited, on buckets of its own: the callback shares the login limiter's per-client limits but no global lockout bucket, and `/start` is metered per client. Player linking is out of scope for this amendment.

**Trade-off, stated explicitly.** Role→tier is evaluated at sign-in only. A member whose role is removed keeps an existing session until it expires or is signed out — identical to the handoff's behaviour today (§2.1, "already-active sessions are unaffected"). Operators who need immediate revocation restart the console.

### 2.2 Tier 2 — Passkeys (opt-in, secure-context-gated)

**Partially depends on the not-yet-upstreamed Discord OAuth system**: passkeys support two explicit identity sources, never an unspecified "whatever tier system is present." A Discord-authenticated registration is keyed to that Discord user and requires live Discord tier resolution at every passkey login. A password-authenticated registration is keyed to the single built-in `local-owner` principal described below and always resolves to owner. Upstream without Discord therefore supports only `local-owner` passkeys. Gated by an explicit, operator-set config value — never auto-detected from request headers:

```
WEBAUTHN_RP_ID=console.example.com
WEBAUTHN_ORIGIN=https://console.example.com
```

Both are unset by default — byte-identical behavior to today; no passkey routes are registered. `WEBAUTHN_RP_ID` is the WebAuthn Relying Party ID, while `WEBAUTHN_ORIGIN` is the exact serialized browser origin (scheme, hostname, and non-default port, if any) passed as `expectedOrigin` during both registration and authentication verification. The server must never derive either value from `Host`, `Origin`, `Forwarded`, or other request headers. Setting only one is a boot-time configuration error; both must be present or both absent. For ordinary deployments the origin is HTTPS, while literal localhost may use an origin such as `http://localhost:8080` because browsers treat localhost as a secure context.

Setting both values **is** the operator's confirmation that a secure context (HTTPS, or literal `localhost`) exists somewhere in the access path — WebAuthn's browser APIs (`navigator.credentials.create()`/`.get()`) are unavailable outside a secure context regardless of anything server-side. The frontend must feature-detect this state (`window.isSecureContext` / `PublicKeyCredential` presence) rather than letting the raw browser API fail: on a non-secure context with WebAuthn configured, the settings panel shows registration as unavailable with an honest explanation ("passkeys require HTTPS or localhost; you are connected over plain HTTP"), and the login form's passkey branch is hidden or annotated the same way. There is no security consequence to reaching a correctly configured console over a second, non-secure URL — passkey controls are simply unavailable there — but an invalid or partial server configuration fails loudly at boot rather than producing an unexplained dead button.

**This tier is explicitly optional, not a replacement for Tier 3**, because this project's own deployment guidance for the console specifically recommends reaching it over a plain-HTTP VPN tunnel with no reverse proxy — an access pattern where WebAuthn's secure-context requirement is never satisfied. An earlier draft of this design made passkeys the sole primary login and was rejected at audit specifically because it would have broken login entirely for any operator following that exact guidance.

**Identity contract and device registration**: every session used for passkey registration must have a non-empty, server-assigned principal. Discord sessions use `discord:<userId>`. The shared-password route, which currently calls `makeSession()` with an empty `userId`, must instead create `local-owner` sessions. This does not pretend that a shared password creates individual people: all password users deliberately share one owner principal, and all of its passkeys are owner credentials. Labels distinguish devices, not humans. Any `local-owner` session may list or remove any `local-owner` passkey; operators wanting individual identity, demotion, and per-person revocation must use Discord-backed principals. Because the device list is shared, the UI must be honest about it: the passkey settings panel carries a standing note that every password-authenticated admin shares and can manage this list; removal requires confirming against the credential's label and creation date; and a passkey login that fails because its credential is no longer registered says so ("this passkey is no longer registered — it may have been removed by another administrator; sign in with password+TOTP"), rather than a generic failure.

**Registration requires fresh proof of possession, not just a live session.** Registration and removal use `self:passkey-register`/`self:passkey-remove`. The server derives the principal exclusively from the authenticated session; neither endpoint accepts a target `userId`. But a valid session cookie alone is **not** sufficient to register: a passkey is a durable credential that outlives the session that minted it, so `self:passkey-register` demands the acting session re-prove its underlying login credential immediately before the ceremony — password+TOTP re-entry for a `local-owner` session, a fresh Discord OAuth authorization round-trip for a `discord:*` session. (§2.3 already requires exactly this fresh-proof rule to *rotate* a credential; minting a new persistent credential is at least as sensitive, and without this rule a hijacked session could quietly install a device credential that survives every rotation.) Registration from a password session is additionally available only after that session has completed TOTP, including the mandatory upgrade enrollment described in §4.

**Passkey lifetime is decoupled from password/TOTP rotation — so revocation must be explicit and visible.** Rotating the Tier 3 password/TOTP does not silently revoke passkeys. Three controls make that decoupling safe instead of a persistence loophole:

1. The rotation flow **displays the current passkey list** (label, creation date, last-used date) and requires an explicit keep-or-revoke decision as part of the rotation, with **revoke-all as the default** — an operator rotating credentials in response to suspected compromise sees, and must consciously retain, every device credential that would otherwise survive the rotation.
2. A standing **"revoke all local-owner passkeys"** action lives in the passkey settings panel itself (not only inside the rotation flow), for the compromise-response case where the operator wants every device credential gone *now*, without rotating the password. It requires the same fresh proof of possession as rotation, and emits `settings.passkeys-revoked-all`.
3. Tier 3 credential rotation **always requires the current Tier 3 credential** (password+TOTP), regardless of how the acting session authenticated. A passkey assertion re-proof authorizes only passkey-scoped actions (`self:passkey-*`); it can never authorize rotating the password/TOTP it would then survive. Without this rule, an attacker holding one registered passkey could rotate the password and lock the legitimate operator out entirely.

Storage is deliberately minimal — it persists the explicit principal type but does not introduce local user accounts. Credentials live in `runtime/generated/webauthn-credentials.json` via `writeJsonAtomic()`:

```json
{
  "version": 1,
  "credentials": [
    { "principal": "local-owner", "credentialId": "...", "publicKey": "...", "signCount": 0, "label": "work laptop", "createdAt": "..." },
    { "principal": "discord:123456789", "credentialId": "...", "publicKey": "...", "signCount": 0, "label": "phone", "createdAt": "..." }
  ]
}
```

If this file exists but cannot be parsed (corruption, truncated write recovered from a bad disk), passkey login and registration **fail closed** — loudly logged at startup and surfaced in the settings panel — while Tiers 1 and 3 are unaffected; deleting the file simply unregisters all passkeys (see §3.4). Cross-tier persistence mechanics that also apply to this store — the `signCount` serialization queue and backup/restore integrity — are specified in §2.3, since they share machinery with the recovery-code store; an implementer building Tier 2 must read both sections.

A passkey login dispatches by principal type. `discord:*` re-resolves the current tier through the authoritative handoff and denies on an unavailable/empty result. `local-owner` resolves to owner because it represents the existing shared owner credential, not an individual account. Unknown principal types fail closed. The passkey ceremony endpoints (registration options/verify, authentication options/verify) parse attacker-suppliable binary (CBOR/ASN.1) from unauthenticated clients on the login path, so they sit behind the **same login rate limiter** as every other authentication endpoint (§2.3).

**Dependency**: `@simplewebauthn/server` (npm, MIT, pinned `13.3.2`, 8 well-scoped direct dependencies for CBOR/ASN.1/X.509 parsing) + `@simplewebauthn/browser` (MIT, zero dependencies, pinned to the matching major) for the registration/authentication ceremonies, using the standard `attestationType: "none"` flow with neither the library's certificate-revocation check nor its FIDO Metadata Service integration ever enabled — keeping its own network-capable code paths entirely unreached. Because that zero-egress property is configuration, not enforcement, the test suite includes a ceremony test with `globalThis.fetch` stubbed to throw, proving full registration+authentication round-trips complete with no outbound call (§6). `qrcode` (npm, MIT, zero runtime dependencies in its browser bundle, pinned) for TOTP QR rendering (Tier 3, §2.3).

### 2.3 Tier 3 — Password + TOTP (opt-in) + recovery codes (universal, dual-role)

**Correction (2026-09-02, issue #665): mandatory, forced-on-login enrollment was
reversed to owner-initiated opt-in.** Live-testing feedback from the upstream
maintainer (Red-Blink), relayed during the actual PR review this RFC's design
was submitted for: *"what if I don't want to setup 2FA? Your PRs are forcing
the users to do it... 2FA should be optional and users can opt in, from the
settings page."* This section's original argument below (single shared,
non-device-bound secret, so a compromise is total) is real and unchanged —
what changed is the conclusion drawn from it: forcing every operator through
enrollment with no way to decline is a real adoption blocker for a
self-hosted tool, and it turned out to be the wrong trade-off even though the
underlying risk analysis was sound. **What actually changed, precisely:**
`POST /api/auth/login` no longer redirects an unconfigured install into a
forced enrollment session (§4's flow below is now historical for the *login*
trigger specifically) — a correct password logs in normally regardless of
whether TOTP is configured. Enrollment is now owner-initiated via
`POST /api/auth/2fa/enable` (Settings → Two-Factor Authentication), which
requires fresh password proof and mints the exact same short-lived
enroll-scope session §4 describes; `POST /api/auth/2fa/enable`'s counterpart,
`POST /api/auth/2fa/disable` (fresh password + TOTP proof, then
`secondFactor.clear()`), is new — the RFC never previously needed a disable
path because there was no way to have opted in in the first place. Every
other mechanic in this section — TOTP parameters, recovery-code encoding,
recovery-login flow, rotation/session-invalidation, audit logging, backup/
restore guidance — is unchanged; only the trigger for *starting* enrollment
moved from automatic to explicit. Every "mandatory" in the untouched prose
below describes the state *once an operator has opted in*, not a forced
starting condition.

This tier is **not** pure emergency break-glass. For an operator with neither Tier 1 nor Tier 2 configured — no Discord community around their server, no TLS anywhere in the access path — this is their real, everyday primary login, every session, not a degraded fallback. For an operator who *does* have Tier 1 and/or Tier 2 configured, this tier correctly serves as break-glass recovery. Both roles are real and this design must be genuinely good at both, not merely tolerable in one.

This is why TOTP is **mandatory**, not optional, regardless of which role the tier is playing for a given operator: the justification is structural, not frequency-based. Tier 3 is the only tier backed by a single static, shareable, non-device-bound secret (unlike Tier 1's live Discord identity check or Tier 2's per-device passkey) — a compromised Tier 3 credential, for an operator with no Tier 1/2 configured, grants everything, unconditionally, for the entire lifetime of the install.

**TOTP parameters** (named, not left to implementation): RFC 6238, HMAC-SHA1, 6 digits, 30-second period (the interoperable defaults every mainstream authenticator app supports), 160-bit server-generated secret, with a verification window of ±1 time step to tolerate ordinary clock drift. The time step accepted to confirm enrollment is persisted with the new second-factor state and rejected by the first normal login even while it remains inside that window; this makes the §4 promise that the setup code cannot immediately be replayed implementable without imposing a global one-login-per-step restriction on the shared owner credential. The error message for a rejected code must name the most common real cause — device clock skew — and suggest checking the device's automatic time setting, instead of a bare "invalid code". *As implemented:* the server names the clock on every rejection; the enrollment screen additionally switches to a longer clock-skew explanation from the third consecutive failure.

**Second-factor state storage**: the TOTP secret and the recovery-code digest set live together in one new file, `runtime/generated/console-second-factor.json` (`{"version": 1, "totp": {...}, "recoveryCodes": [...]}`), written via the console's existing `writeJsonAtomic()` helper with file mode `0600`. This file is covered by the same backup/restore guidance as the passkey store (below), and its deletion semantics are an explicit, documented part of the design (§3.4) — not an accident.

**Recovery codes**: 10 single-use, server-generated 128-bit random tokens. These are high-entropy bearer tokens, not user-chosen passwords, so the store contains `SHA-256(domain-separator || token-bytes)` rather than applying a password KDF — a stolen digest still requires a computationally infeasible 2^128 search, while verification is one cheap hash instead of ten memory-hard KDF comparisons. The full encoding, specified so that two implementations produce compatible stores:

- **Domain separator**: the ASCII string `dune-console-recovery-v1:`, prepended to the 16 raw token bytes before hashing. Only the digest of separator+token is stored; the checksum (below) is never part of the hashed input.
- **Display encoding**: the 16 token bytes hex-encoded (32 characters, shown in 8 groups of 4, e.g. `3f9a-1c…`), followed by a 2-character checksum: the first byte of `SHA-256(token-bytes)`, hex-encoded. Input is case-insensitive; dashes and whitespace are stripped before validation.
- **Checksum handling**: the checksum exists to catch transcription errors, and it is verified **client-side before submission** — a mistyped code gets an immediate "this code looks mistyped — check the highlighted characters" response without spending a rate-limited attempt, which matters most in exactly the shaky-handed break-glass emergency this path exists for. The server independently re-verifies the checksum **after** the rate limiter has counted the attempt (so a client that skips the check gets no free probing), then compares the digest against the stored set using `timingSafeEqual` over each unused entry — not a JavaScript `Set` lookup, which is not constant-time and must not be described as such. (The timing channel here is theoretical — the compared value is a digest of attacker-chosen input, behind the limiter — but the codebase already has the constant-time helper and there is no reason to make a weaker claim than the code can keep.)
- **Consumption** goes through the same serialized atomic-write queue as the passkey store. Once password and code verification succeeds, the transaction invalidates the **entire old recovery-code set** and marks the old TOTP enrollment recovery-pending before issuing the restricted re-setup session; concurrent reuse of the consumed code, any sibling from that set, or the old TOTP secret therefore fails. The recovery endpoint sits behind the existing login limiter (8 attempts/key, 32 global, 15-minute block).

**Recovery login flow, end to end** (each step previously implicit, now specified):

1. The login form carries a visible "lost access to your authenticator?" affordance on the TOTP step — the recovery path must be discoverable from the place an operator is stuck, not only documented.
2. A recovery login requires the **password plus one unused recovery code**. The code substitutes for the TOTP factor only — never for the password. A stolen recovery-code sheet alone does not log in. Successful verification atomically invalidates the full old recovery-code set and disables normal login with the old TOTP enrollment before proceeding — whoever holds the old sheet or old authenticator now holds an unusable second factor.
3. Only after that invalidation commits does the server create a **restricted re-setup session** with the same access set as §4's enrollment-only session (TOTP setup, confirmation, recovery-code display, logout — nothing else). It is not a normal owner session with a redirect; nothing outside re-setup is reachable until re-setup completes. If setup is abandoned, the operator can resume with that unexpired restricted session or use the documented host reset; old codes are never revived.
4. Completing re-setup regenerates the TOTP secret (fresh QR + text secret), generates a **fresh set of 10 recovery codes**, displays them once behind the same acknowledgment gate as §4, invalidates the re-setup session, and requires a normal password+TOTP login.
5. Registered passkeys are unaffected by recovery-code consumption (they are a different credential type), but the re-setup screen lists them, with the revoke-all control from §2.2 one click away — an operator recovering from a suspected compromise sees every other standing credential at exactly the moment they're deciding what to trust.

**Recovery-code regeneration outside an emergency** is a standing settings action (same panel as rotation), requiring the same fresh proof of possession as rotation, invalidating the entire old set, and displaying the new set once behind the acknowledgment gate. It emits `settings.recovery-codes-regenerated`.

**Session invalidation on credential rotation**: rotating the Tier 3 password/TOTP clears every **password/TOTP-authenticated** session except the one performing the rotation — passkey- and Discord-authenticated sessions are their own credential types and are cleared by their own credentials' lifecycle events instead (this is the scoped-invalidation model of §5; an earlier draft cleared every session of every type on any credential change and was rejected as collateral logout without security benefit). The acting session must re-prove the current password+TOTP immediately before the rotation is accepted — not just present an existing cookie, and, per §2.2, not substitute a passkey assertion. This closes two problems at once: legitimate concurrent password-session admins are correctly logged out (a real credential-rotation event), and a session-hijacking attacker cannot use a stolen session alone to entrench a credential rotation.

**Credential rotation procedure is an implementation deliverable, not an afterthought**: the operator documentation shipped with Tier 3 must include the exact rotation procedure (and its session-invalidation consequences) as a tested, written runbook — a rotation mechanism whose procedure exists only in this RFC is not operationally complete.

**Audit logging**: every new state-changing action gets an explicit `audit()` call, following this codebase's existing pattern (already used extensively throughout `server.js`): `settings.totp-setup`, `settings.totp-regenerated`, `settings.recovery-codes-regenerated`, `auth.recovery-code-consumed`, `auth.password-changed.sessions-revoked`, `auth.handoff-denied` (with reason code, §2.1), `auth.second-factor-reset-detected` (§3.4), `settings.passkey-registered`, `settings.passkey-removed`, `settings.passkeys-revoked-all`. The passkey events carry the credential ID and label in their payloads — a removal or registration that can't be tied to a specific device afterward is not a usable audit record for the shared `local-owner` list, where reconstructing "which device, added/removed by whom, when" is the only individual accountability the model offers.

**Backup/restore guidance** (two credential-state rollback cases this design introduces):
1. Restoring `runtime/generated/` from a backup taken before a recovery code was consumed silently un-consumes it. Documented operator guidance: after any restore, regenerate the entire recovery-code set unconditionally.
2. Restoring an old `webauthn-credentials.json` can resurrect passkeys that were removed after the backup. It does **not** create the previously claimed signature-counter lockout: restoring an older, lower server-side `signCount` still allows a later, higher authenticator counter. Documented operator guidance: after any restore, review the device list and revoke every credential whose continued possession is uncertain; for a compromise-response restore, revoke all and re-register trusted devices.

**`signCount` read-modify-write safety**: concurrent passkey logins racing on the same credential-store file need serialized reads/writes. A module-level `Promise` chain acts as a serializing queue (not a boolean lock) — each request appends its read-modify-write to the tail of the chain and awaits its own link, so concurrent requests are queued and both eventually succeed in arrival order, never rejected outright.

**Rate limiting on this path is unchanged** — recovery-code checks are constant-memory hash operations and remain behind the existing login limiter (8 attempts/key, 32 global, 15-minute block), as do the passkey ceremony endpoints (§2.2). This project's console deployment guidance already recommends VPN-based access, which preserves real per-client source IPs. For installs behind a reverse proxy or tunnel, `CONSOLE_TRUSTED_PROXY_IPS` (implemented alongside Tier 3) lets the limiter key on the real client address reported by a listed proxy's `X-Forwarded-For`.

---

## 3. Security Model

### 3.1 Tier independence and blast radius

Each tier's compromise has a bounded, tier-specific blast radius:
- A compromised Discord account only grants what that account's real, live-checked Discord role currently allows (re-verified on every login, not cached).
- A stolen/cloned passkey grants access as its bound principal. Discord passkeys retain per-person tier/revocation semantics. `local-owner` passkeys are individually revocable devices for the shared owner principal; they intentionally do not claim per-person identity — and because they are durable credentials, both minting one and letting one survive a rotation are explicit, proof-of-possession-gated decisions (§2.2), never side effects.
- A compromised Tier 3 credential is the only one that can grant unconditional owner access on an install with no Tier 1/2 configured — which is exactly why it receives mandatory TOTP, high-entropy single-use recovery tokens, and proof-of-possession-gated rotation regardless of how often it is used.

### 3.2 No new network-topology assumption

This design was revised specifically to remove a Cloudflare-specific rate-limiting mechanism an earlier draft proposed (trusting a `CF-Connecting-IP` header behind an operator-declared trusted-proxy IP). That mechanism was rejected because this project has a large, globally-distributed self-hosted operator base, most of whom do not run Cloudflare Tunnel/Access at all. This RFC introduces zero new network-topology assumptions, no new port, no new bind address, and no new outbound network dependency of any kind — `@simplewebauthn/*` and `qrcode` are both local-computation-only (and §2.2 specifies the test that proves it).

### 3.3 Origin binding is a documented operator constraint, not a code-level gap

`WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` are a single, static, operator-chosen relying-party configuration. An operator who reaches the console via more than one hostname/IP (e.g. a VPN-internal address and a public DNS name) must choose one canonical origin for passkey purposes — consistent with this project's own existing documented preference to use exactly one consistent access path for the console. The server verifies both the RP ID and exact origin on every ceremony; neither is inferred from attacker-influenced request headers. This is WebAuthn's phishing-resistance property working as intended (a credential registered against one origin is not valid for another), not a limitation this RFC attempts to code around.

### 3.4 Credential loss, answered per credential — including total loss

Every credential this design introduces has an explicit answer to "what happens if it's lost," including the worst case:

| Lost | Recovery path | Residual consequence |
|---|---|---|
| TOTP device (codes still held) | Recovery-code login (§2.3 flow) → forced re-setup | Old recovery set invalidated; re-enroll TOTP |
| All recovery codes (TOTP still works) | Regenerate the set from settings (fresh proof of possession) | Old sheet worthless — intended |
| Password (any other factor state) | None at the login surface — `ADMIN_PASSWORD`/generated-secret management is host-side, exactly as today | Host access required, as today |
| TOTP device **and** all recovery codes | **Host-filesystem reset, and nothing less**: stop the console, delete `runtime/generated/console-second-factor.json`, restart. The install now has no TOTP state; the next password login is a normal, single-factor login (issue #665 — re-enrollment is opt-in via Settings, no longer forced), and §4's enrollment-only flow re-triggers only once the operator opens `POST /api/auth/2fa/enable` themselves. | See below — this is a deliberate, visible root of trust, not a loophole |
| `webauthn-credentials.json` deleted | All passkeys unregistered; Tier 1/3 unaffected; re-register from settings | Devices re-enroll |
| `webauthn-credentials.json` corrupted | Passkey login/registration fail closed, loudly logged at startup and shown in settings; Tier 1/3 unaffected; operator deletes/restores the file | As above |
| Tier 1 (Discord OAuth) unavailable — bot down, app revoked, unsound role mapping, Discord API outage | Sign in with the Tier 3 password in the meantime (every relevant error page already says this explicitly) | **Depends entirely on the operator actually knowing the Tier 3 password** — added by #676, which found this is the single most consequential gap in the whole table: an Owner who has only ever used Discord OAuth is one Discord outage away from total lockout with no in-browser recovery. #676's own design doc (`docs/design/auth-settings-consolidation-l1-design-2026-09-03.md`, §5/§8) is the fuller treatment — resolved there via operator awareness (a wizard confirmation step + contextual copy), not a new bypass of this table's own Password row above. **That design doc lives on a separate, still-open PR (#677 — `docs/676-auth-settings-consolidation-design`), not on this branch**; this row's summary stands on its own regardless, but the `§5/§8` cross-reference only resolves once #677 merges — GRC hat Layer 2 audit finding, do not merge this branch's PR before #677 without either merging #677 first or removing/inlining this citation. |

**The total-loss path is host filesystem access, stated out loud.** Anyone who can delete a file under `runtime/generated/` can reset the console's second factor. This is not a new weakness this design introduces — host filesystem access on a self-hosted install already implies the database, `runtime/secrets/`, and the ability to replace the console binary itself; a second factor that could *not* be reset from the host would convert every total-loss event into a permanent lockout (§2.3's dual-role framing: for many operators this is their everyday primary login) with reinstallation as the only exit. What the design owes this decision is **visibility**, not prevention: when the console starts with no TOTP state where state previously existed within the retained audit history, and whenever enrollment completes, it emits `auth.second-factor-reset-detected` / `settings.totp-setup` audit entries **and** a startup log banner — a reset the legitimate operator didn't perform is loud, not silent.

**The first-enrollment window is acknowledged, not hidden.** Between upgrading to a Tier 3-enabled build and completing §4's enrollment, anyone holding the shared password can win the race to enroll TOTP first — converting a dormant password leak into second-factor control plus operator lockout. This is bounded (it requires the full pre-upgrade credential, i.e. the attacker could already log in today) and recoverable (the legitimate operator has the host-reset path above, which the attacker's enrollment cannot revoke), but it is real, and the mitigations are deliberate: the enrollment-completion audit entry and startup banner above make a hijacked enrollment visible immediately, and the upgrade documentation must tell operators who suspect their password has ever been shared or leaked to rotate `ADMIN_PASSWORD` *before* upgrading, closing the window with the credential the attacker would need.

---

## 4. Migration Path

**Correction (2026-09-02, issue #665): the bullet below describing forced
enrollment "on first password authentication after upgrade" is historical —
see §2.3's correction note for what actually ships.** An in-place upgrade to
a build with `CONSOLE_TOTP_ENABLED=1` is now invisible at the login surface:
an existing single-factor install keeps logging in with the password alone,
exactly as before, and the operator opts into everything described below
(the 10-minute enrollment session, the acknowledgment-gated recovery-code
display, the forced re-login afterward) from Settings, on their own
schedule, via `POST /api/auth/2fa/enable`. The mechanics of the enrollment
session itself — its scope, TTL, and the confirm/acknowledge/re-login
sequence — are unchanged; only the sentence "on first password
authentication after upgrade" is no longer true.

- **Tier 1 fix has no upgrade-path complexity**: it's a behavior correction to already-optional, already-Discord-OAuth-configured installs only. An operator who has never configured Discord OAuth is completely unaffected.
- **`WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` both unset (default) is byte-identical to today**: no new routes registered, no new file created, zero behavior change for any operator who doesn't opt in. A partial pair is rejected at boot.
- **Tier 3's hardening is not gated behind an opt-in**. On first password authentication after upgrade, an installation with no TOTP state receives a **10-minute, non-renewable, enrollment-only session**. That session can access only TOTP setup, confirmation, recovery-code display/download, and logout; any other console request from it receives a redirect to the enrollment screen (not a bare 403), with one line of explanation: a security upgrade requires two-factor setup before continuing. The login screen itself carries the same line post-upgrade, so login leading into setup is explained, not surprising. Successful TOTP confirmation atomically creates the `local-owner` second-factor state, including the accepted enrollment time step described in §2.3, then displays the recovery codes once — behind an explicit **"I have saved these codes" acknowledgment** that must be given before the display can be dismissed — then invalidates the enrollment session and requires a normal password+TOTP login. The transition screen says to wait for the authenticator's next code because the persisted enrollment step cannot be reused for that login. Existing ordinary sessions are in-memory and disappear when the upgraded console process starts. This makes "mandatory" true immediately without locking out an operator before enrollment.
- **Interrupted enrollment is recoverable, and restart is clean**: until confirmation commits, no TOTP state is considered active and the operator can restart enrollment with the password — a restart **regenerates the TOTP secret**, and the restarted setup screen says so explicitly ("if you scanned a previous QR code for this console, delete that entry from your authenticator — it is no longer valid"), so an abandoned first attempt cannot leave a silently-wrong authenticator entry behind. Once committed, recovery codes are already persisted before the success response is sent.
- **No existing config key is renamed or removed.**

---

## 5. What This Replaces

| Current | After |
|---|---|
| *(fork-only, see dependency note above)* Discord OAuth silently falls through to a static owner allowlist on any handoff failure | Handoff failure denies access (with an audited reason code and an actionable user-facing message); allowlist only applies to a brand-new install with no handoff configured at all |
| Single shared password, no second factor, no recovery path | Password + mandatory TOTP from the first post-upgrade login + 10 single-use high-entropy recovery codes with a specified, discoverable recovery flow |
| No non-Discord device-bound login option | Optional, TLS-gated passkeys bound either to a Discord person or the explicitly shared `local-owner` principal, with proof-of-possession-gated registration |
| No session invalidation on any credential change | Scoped invalidation (only sessions of the rotated credential type) + fresh proof of the current Tier 3 credential required from the acting session |

---

## 6. Test Strategy

| Layer | What it tests | File |
|-------|---------------|------|
| Unit — Tier 1 fix | `handoff.test.js`'s two existing "falls back to bootstrap" tests: one (`handoff configured but failing`) is rewritten to assert denial; the other (`handoff never configured`) is re-verified unchanged, since that case is intentionally preserved. New: boot-time rejection of the half-configured handoff state; reason codes reach `audit()` but never the authorization result | `console/api/test/handoff.test.js` |
| Unit — passkey ceremonies | Registration/authentication success and failure paths, using `@simplewebauthn/server`'s own known-good test fixtures; exact expected-origin and RP-ID enforcement (including rejecting either mismatch and partial configuration at boot); fresh proof-of-possession required before registration; ceremony endpoints observe the login limiter; zero-egress proof with `globalThis.fetch` stubbed to throw | new `console/api/test/passkeyCeremonies.test.js` |
| Unit — signCount safety | Concurrent-request queueing behavior; replay/rollback detection; restoring a lower stored counter accepts the authenticator's later higher counter | new `console/api/test/passkeySignCount.test.js` |
| Unit — recovery codes | 128-bit generation and hex+checksum encoding round-trip; checksum rejection (server-side, after the limiter counts the attempt); domain-separated digest storage; `timingSafeEqual` membership comparison; single-use atomic consumption; full-set invalidation on consumption and on regeneration | new `console/api/test/recoveryCodes.test.js` |
| Integration — recovery login | Password+code (never code alone) → old TOTP and the full old recovery set disabled before a restricted re-setup session is issued → nothing outside re-setup reachable → forced TOTP re-enrollment → new code set issued once | extends `auth.test.js` |
| Integration — session scoping | A credential-type-scoped rotation clears only password/TOTP sessions, leaves passkey/Discord sessions untouched, and requires fresh proof of the current Tier 3 credential from the acting session — including rejecting a passkey assertion as that proof | extends `auth.test.js` |
| Upgrade-path | Fresh and existing password installs receive only an enrollment session (10-minute TTL, blocked requests redirect to enrollment) until TOTP confirmation; interrupted enrollment restarts with a regenerated secret; the accepted enrollment time step cannot be reused for the first normal login; post-confirmation password-only login is rejected; recovery-code display requires acknowledgment; WebAuthn configured mid-lifecycle enables `local-owner` passkeys without inventing individual identities | extends existing upgrade-path test conventions |
| Frontend | Login form's passkey/password branching and the recovery-code affordance on the TOTP step; non-secure-context detection states (registration unavailable message, hidden/annotated login branch); settings-panel passkey list/add/remove including the shared-list note, removal confirmation, and revoke-all; TOTP+recovery-code setup screen (QR + text-fallback secret shown together, save-acknowledgment gate, clock-skew guidance after repeated failures) | `console/web` Vitest suite |

---

## 7. Not in Scope

- **Removing the password/Tier 3 path entirely.** Not possible for this project's operator base — many self-hosted installs have no Discord community and no reverse-facing TLS, and Tier 3 must remain a fully legitimate, permanent, first-class login path for them, not a state to be designed out of existence.
- **Any Cloudflare-specific mechanism of any kind.**
- **A generic, proxy-aware fix for the shared-rate-limit-bucket problem** behind an HTTP-terminating reverse proxy/tunnel — real, deferred, separate work.
- **Multi-instance/clustered console deployment** — this console is, and remains, single-process; both new mechanisms (in-memory sessions, the passkey credential store) are designed against that existing architecture, not a future clustered one.
- **A local per-person admin-account system.** The only non-Discord principal is the explicit shared `local-owner`; the design does not infer individual humans from a shared password. Discord OAuth remains the source for per-person identity and tiering.
- **Preventing a host-filesystem second-factor reset** (§3.4) — host access already transcends the console's own auth on a self-hosted install; the design makes the reset visible, not impossible.

---

## 8. Audit Record

**Upstream follow-up review corrections (2026-08-20):** review of this revision found four remaining implementation gaps and corrected them before merge: the exact WebAuthn expected origin is now operator-pinned alongside the RP ID and partial configuration fails at boot; recovery invalidates the old TOTP enrollment and full old code set before issuing a restricted session; the accepted enrollment TOTP step is persisted so the no-immediate-reuse promise is enforceable; and the incorrect claim that restoring a lower server-side passkey counter causes lockout was replaced with the real restore risk, resurrection of revoked credentials.

**Post-merge validation corrections (2026-08-20):** after merge, a four-lens validation (Technical Writer, Security Architect, UI/UX, GRC — dispatched as independent workers; explicitly *not* a full eight-hat pass, and the eventual implementation still owes Architect/Network/Cloud-Security/DBA/QA review under the normal layered-audit process) reviewed the merged text and re-verified its code-fact claims against the real fork sources. Findings register and STRIDE report: yacketrj/dune-awakening-selfhost-docker#398. This revision incorporates the corrections; the substantive ones:

- **Passkey persistence made explicit and gated** (§2.2): fresh proof of possession now required to register; rotation shows the passkey list with revoke-all as default; a standing revoke-all action exists outside the rotation flow; and rotation always requires the current password+TOTP, so a registered passkey can never authorize rotating the credential it would then survive.
- **Total credential loss answered** (§3.4): a per-credential loss matrix, including the host-filesystem reset path for the TOTP+recovery-codes worst case, its trust rationale, and the visibility (audit + startup banner) that makes an unexpected reset loud. The first-enrollment race window is acknowledged with its bounds and mitigations.
- **Recovery flow fully specified** (§2.3): login-form discoverability, password+code (never code alone), restricted re-setup session, full-set invalidation, passkey visibility at recovery time, and a standing regeneration action.
- **Implementability parameters pinned** (§2.2–§2.3, §4): TOTP parameters, domain-separator literal, recovery-code encoding and checksum handling (client-side pre-check, server-side post-limiter re-check, `timingSafeEqual` comparison — replacing an incorrect "constant-time `Set` lookup" claim), second-factor storage file and mode, enrollment-session TTL, and the enrollment/redirect/acknowledgment UX states.
- **Tier 1 fix hardened operationally** (§2.1): boot-time rejection of the half-configured handoff state (which the deny-on-empty fix would otherwise turn into a silent permanent deny), audited denial reason codes that never influence the authorization result, and a specified, actionable denial message.
- **Internal contradiction resolved** (§2.3 vs §5/§6): rotation clears every *password/TOTP-authenticated* session except the acting one — the credential-type-scoped model §5 and §6 already described; §2.3's broader "every session" wording was the error.

**Upstream review corrections (2026-08-18)** — these were caught by the upstream maintainer's review, **not** by the three Layer 1 passes below, which had converged on the replaced designs (the scrypt scheme had in fact been examined and rated resolved by the targeted third pass; the identity and upgrade-path gaps appear in no pass's findings at all). Per this project's own review discipline, an internal audit's conclusions are a hypothesis until independently confirmed — this merge review was that confirmation, and it found real gaps:

- Defined `discord:<id>` and `local-owner` as the only passkey principal types. This replaces the under-specified fallback to "whatever tier system is present" and acknowledges that the existing shared-password path has no per-person identity.
- Replaced ten potentially memory-exhausting scrypt comparisons with one constant-memory SHA-256 lookup over a server-generated 128-bit recovery token. Password-KDF guidance is not applicable to uniformly random bearer tokens.
- Replaced indefinite legacy-password exemption with a restricted, mandatory first-login TOTP enrollment flow.

**Layer 1 Eight-Hat Findings (three passes: two full, one targeted against the final pre-submission revision):**

- **Architect:** GO with the layered, tier-independent model over either single-primary alternative considered first; flagged and resolved a wrong precedent citation for the signCount concurrency fix (corrected to the existing pre-`await`-reservation pattern already used elsewhere in this codebase, not a whole-job lock).
- **Security:** GO with Tier 1's fix as a minimal, stateless correction (no caching, no new stale-privilege window); found and required a fix for a session-scoping regression (an earlier draft's design let a stolen session rotate the break-glass credential without losing its own access — closed by requiring fresh proof-of-possession from the acting session).
- **GRC:** GO; required explicit `audit()` coverage for every new state-changing action, and that audit findings be preserved in a retrievable artifact (an earlier draft's own audit findings were never committed anywhere) — the per-finding traceability table lives in the fork's internal L1 design document (`docs/design/console-layered-auth-l1-design-2026-08-17.md`, historical — superseded on the revised points by this document and by the corrections recorded above), not in this RFC, which carries this summary register.
- **Network:** GO with Tier 2 as opt-in/TLS-gated rather than a sole primary, specifically because WebAuthn's secure-context requirement is incompatible with this project's own documented plain-HTTP-over-VPN console access guidance; confirmed no new network-topology assumption is introduced.
- **Cloud Security:** GO after confirming a Cloudflare-Access-dependent multi-admin-identity design (an earlier draft) doesn't achieve its own stated goal, since Access gates reachability before the console's own login ever runs; confirmed `@simplewebauthn/*` and `qrcode` introduce zero outbound network dependency as used.
- **UI:** GO after requiring concrete dependency naming (no "TBD, confirm at implementation" for new libraries) and requiring a text-fallback (not QR-only) presentation for the TOTP secret during setup.
- **DBA:** GO with a deliberately minimal new persisted file (principal identifier and credential material, but no persisted tier assignment); required explicit backup/restore guidance for recovery-code consumption and passkey revocation-state rollback, neither prior draft had addressed.
- **QA:** GO with named, file:line-specific existing tests that must change (not just new tests to add) — an earlier draft's audit found two passing tests that assert the exact fail-open behavior being removed, and this was not called out until a dedicated review pass caught it.

Three design iterations preceded this RFC, each corrected by direct Layer 1 audit findings (a Discord-primary-plus-Cloudflare-Access design, then a passkey-sole-primary design) before arriving at the layered model presented here. This document presents the resulting design as revised by upstream review and post-merge validation; the fork's issues yacketrj/dune-awakening-selfhost-docker#331 (design lineage), yacketrj/dune-awakening-selfhost-docker#398 (post-merge findings), and yacketrj/dune-awakening-selfhost-docker#357 (documentation reconciliation) hold the retrievable history.
