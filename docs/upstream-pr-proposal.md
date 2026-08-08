# Upstream PR Proposal — Revised (v2, 2026-08-08)

**Base:** Red-Blink/dune-awakening-selfhost-docker v1.3.84
**Fork:** yacketrj/dune-awakening-selfhost-docker

---

## What changed from v1

Per upstream review feedback, this revision:
- Proposes **only two independent PRs** (not seven tranches)
- Documents **exact auth behavior** for the RBAC session model
- **Reverts** the `secureCookies` default change (stays upstream's `NODE_ENV` heuristic)
- **Removes** expression indexes on Funcom tables (needs separate evidence)
- **Removes** the unverified PlayerLinkPrompt (use in-game verified flow)
- **Splits** the external-bot signed handoff into a separate design item
- **Defers** the IAM policy editor UI, player scoping migration, OAuth setup UI, and tooling

Two PRs are ready for review:

---

## PR 1: RBAC Foundation — IAM Policy Engine, Tiered Sessions, Route Gating

**Branch:** `tranche-1-rbac-foundation` (7 files, +1602/-14)
**Diff:** IAM engine (3 new), tiered auth.js, evaluate() gate in server.js, 2 test files

### What it does

Adds an IAM policy engine, tiered session cookies, and route-level access
control to the console. **Zero behavioral change** by default — no policy
restricts any route; every action returns `true` for all tiers.

The engine is additive infrastructure. An operator who never creates an IAM
policy sees identical console behavior to v1.3.84.

### Files

| File | Change | Description |
|------|--------|-------------|
| `actions.js` | NEW (379 lines) | 1:1 route-to-action mapping across 19 namespaces. Every existing console route is cataloged. |
| `policy.js` | NEW (245 lines) | IAM-style policy evaluation: explicit-deny precedence, wildcard matching (`server:*`, `players:read`), matchAction resolver. |
| `rbac.js` | NEW (421 lines) | Tier-based capability resolution: `owner`/`admin`/`moderator`/`player`/`observer` tiers, `resolveSessionTier`, `resolveAllowedActions`. |
| `auth.js` | MODIFIED (+83/-14) | HMAC-signed JSON-bundle session cookies (see below). |
| `server.js` | MODIFIED (+29) | `evaluate()` gate on every authenticated route; IAM policy API (GET/PUT/POST). |
| `rbac.test.js` | NEW (281 lines) | Policy evaluation: allow/deny, wildcards, explicit-deny precedence. |
| `rbacParity.test.js` | NEW (164 lines) | Static analysis: mechanically enforces that every route in `handleApi` has an IAM action or documented public-route exemption. |

### Auth behavior — complete reference

#### Session format

```json
// Cookie payload (base64url-encoded JSON, HMAC-signed)
{
  "id": "random-32-byte-base64url",
  "tier": "owner|admin|moderator|player|observer",
  "userId": "Discord-snowflake-or-empty-string",
  "exp": 1786249032807,    // epoch ms, sliding 12-hour window
  "iat": 1786205832807     // epoch ms, absolute 7-day max
}

// Cookie: asc_session=<base64url(payload)>.<base64url(HMAC-SHA256(secret, payload))>
```

The cookie value is `{base64url(payload)}.{signature}` — a dot-delimited
two-part token. The signature covers the full payload, preventing tampering
with tier, userId, or expiry.

#### Session creation

- **Password login** (`POST /api/auth/login`): `makeSession()` called with no
  arguments → defaults to `tier: "owner"`, `userId: ""`, `username: ""`.
- **Discord OAuth callback** (future PR): `makeSession({ tier, userId,
  username, guildId })` with the resolved tier and Discord identity.
- Session stored in an in-memory `Map` (not persisted to disk or database).

#### Legacy session compatibility

v1.3.84 uses plain session IDs: `cookie = {id}.{HMAC(id)}`. The upgrade
path works as follows:

1. `readSession` splits on the **last** dot (not the first), because JSON
   payloads contain dots in the base64url-encoded JSON.
2. If the cookie parses as JSON (starts with `eyJ`), it's a RBAC cookie →
   decode tier, userId, exp, iat from the payload.
3. If JSON parsing fails (`catch`), the cookie is treated as a legacy
   plain-ID cookie → `tier = "owner"`, `userId = ""`.
4. If the in-memory session is gone (restart, eviction) but the cookie is
   signature-valid, a **new session is synthesized** from the cookie
   payload — tier and userId are preserved from the cookie, not defaulted.
   The `iat` field from the cookie payload is used as the session creation
   timestamp, so the 7-day absolute max age is checked against the original
   login time, not the restart time.
5. A **pre-RBAC cookie** (plain ID, no JSON payload) that survives a restart
   is signature-valid and is upgraded to a `owner`-tier session. This matches
   the existing v1.3.84 behavior (all sessions are de-facto owner).

**The key guarantee**: a restart never promotes anyone to a higher tier. The
tier is carried in the cryptographically-signed cookie payload, not in the
in-memory Map. An attacker who modifies the payload invalidates the signature.

#### Revocation mechanisms

| Trigger | Method | Granularity |
|---------|--------|-------------|
| Logout (`POST /api/auth/logout`) | `sessions.delete(id)`, `Set-Cookie: asc_session=; Max-Age=0` | Single session |
| Password change | In-memory Map is cleared entirely on console restart (the `restartAll` task restarts the container) | All sessions |
| Session expiry (12 hours since last activity) | `session.expiresAt < now()` check in `readSession` | Per-session, sliding |
| Absolute max age (7 days since `iat`) | `now() - iat > 7 * 24 * 60 * 60 * 1000` check in `readSession` | Per-session, absolute |
| Policy edit (IAM policy changed) | Not required — `evaluate()` reads current policies from in-memory Map on every request | Per-request, immediate |
| Tier change (Discord role removed) | Not enforced by the session itself. The 12-hour sliding window provides natural re-auth. The external-bot handoff (separate PR) can provide shorter lifetimes. | N/A |

#### Password-change invalidation

When the admin password is changed (`POST /api/settings/admin-password`), the
`restartAll` task restarts the console container. The in-memory session Map
is wiped. All existing cookies become invalid at the container level (new
container = new process = empty Map). Users must re-authenticate with the
new password.

If the operator changes the password but does NOT restart (unlikely in
practice — the API endpoint triggers a restart), existing sessions remain
valid until their 12-hour sliding window expires.

#### Policy/tier invalidation

Policies are stored in-memory (a `Map` in the `policy.js` module). A policy
edit via `PUT /api/settings/iam/policy` updates the Map immediately.
`evaluate(session, action)` is called on **every authenticated request** and
reads the current policy set — no session cache, no stale policy window.

If a user's tier is downgraded (e.g. Discord role removed), the existing
session cookie still carries the old tier until the session expires (max
12 hours). This is an accepted trade-off: per-request tier resolution via an
external service would introduce latency and a network dependency on every
console request.

#### Logout behavior

`POST /api/auth/logout`:
1. Requires valid session (CSRF token)
2. Deletes session from in-memory Map
3. Sets `asc_session` cookie with `Max-Age=0` to clear the browser cookie
4. Audit record: `auth.logout`

#### Restart behavior

On container restart (the console process exits and Docker starts a new one):
- All in-memory sessions are lost
- All in-memory policies are lost (policies are loaded from files on boot via
  `loadPolicies` if a persistence mechanism is added — currently policies
  exist only in memory and must be re-created after restart)
- Signature-valid cookies are upgraded as described in "Legacy session
  compatibility" above
- The `iat` field in the cookie prevents indefinite session reuse: a cookie
  older than 7 days absolute is rejected even if signature-valid

#### CSRF behavior

`requireAuth(req, res)` checks:
1. Session is valid (signature, not expired, not >7 days old)
2. For non-GET/HEAD/OPTIONS methods: `X-CSRF-Token` header must match
   `session.csrf` (a 24-byte random value created with each session)
3. `ADMIN_AUTH_DISABLED=1` bypasses all CSRF checks

The CSRF token is available to the frontend via `POST /api/auth/login`
(response body includes `csrfToken`) and `GET /api/auth/state` (for
already-authenticated users).

#### `ADMIN_AUTH_DISABLED` behavior

When `ADMIN_AUTH_DISABLED=1`:
- `readSession(req)` returns a synthetic `owner`-tier session with `id: "dev"`
- No cookie is required; no password is checked; no CSRF is enforced
- All IAM `evaluate()` calls return `true` (the dev session has `tier: "owner"`)
- This is identical to v1.3.84's `ADMIN_AUTH_DISABLED` behavior

#### Bootstrap / recovery path

**Permanent local-password recovery**: Password login is always available at
`POST /api/auth/login` regardless of whether Discord OAuth is configured.
The admin password is stored in `runtime/secrets/admin-web-password.txt` and
can be read directly from the host filesystem. There is no scenario where
Discord OAuth configuration locks the operator out of the console.

**Last-owner / self-lockout protection**: The IAM policy editor (future PR,
deferred) will enforce that at least one `owner`-level policy statement exists
before accepting a policy update. This prevents an operator from accidentally
removing all owner access. Until the editor ships, policies must be edited
via the raw API — the operator is expected to understand the consequences.

**First-boot**: On first boot, the console generates a random admin password
in `runtime/secrets/admin-web-password.txt`. The operator reads this file
and signs in. No IAM policies exist yet → all actions are unrestricted.

### SecureCookies

**Unchanged from upstream.** The console uses the existing `NODE_ENV` heuristic:
- `ADMIN_SECURE_COOKIES` unset + `NODE_ENV === "production"` → `Secure` flag on
- `ADMIN_SECURE_COOKIES=1` → `Secure` flag on
- `ADMIN_SECURE_COOKIES=0` → `Secure` flag off
- `ADMIN_SECURE_COOKIES` unset + not production → `Secure` flag off

This matches v1.3.84 Compose defaults (`ADMIN_SECURE_COOKIES=0`). An
HTTPS-by-default migration is a separate coordinated change.

### Test coverage

- `rbac.test.js` (281 lines): policy evaluation engine — exact match,
  wildcard (`server:*`), namespace wildcard, explicit deny, action `*`, tier
  resolution, `resolveSessionTier`, edge cases
- `rbacParity.test.js` (164 lines): static source-code analysis — parses
  `server.js`'s `handleApi` function and asserts every route has an IAM action
  in `ROUTE_ACTIONS` or a documented public-route exemption. **This test
  mechanically blocks any future route addition without an IAM action.**
- `auth.test.js`: existing upstream tests continue to pass; session tier
  propagation and expiry are covered

### Strict Requirement 0

- **No behavioral change without policies**: the IAM engine is installed but
  dormant. `evaluate()` returns `true` for all actions when no policies exist.
- **Legacy cookie upgrade**: pre-RBAC cookies with valid HMAC are upgraded to
  `owner`-tier sessions. No operator is logged out mid-upgrade.
- **Restart resilience**: cookie payload carries tier and expiry — a restart
  does not promote anyone or require re-authentication before the original
  expiry.
- **No new required env vars**: `ADMIN_SECURE_COOKIES` and `ADMIN_AUTH_DISABLED`
  are existing upstream env vars. No new env vars are introduced by this PR.
- **No database migration**: policies are in-memory (future persistence is a
  separate concern). No schema changes.

---

## PR 2: Discord OPS Providers — Real Data with Endpoint Authorization

**Branch:** `tranche-ops-providers` (to be built)
**Base:** independent of RBAC (can ship before or after)

### What it does

Replaces placeholder OPS route responses with real duneDb queries, and adds
**actor/capability enforcement, query timeouts, row limits, and response-size
limits** to every OPS endpoint.

### Endpoint authorization model

Every OPS endpoint enforces:

| Control | Mechanism | Default |
|---------|-----------|---------|
| Actor identity | Required `X-Discord-Actor` header with user ID; validated against the configured guild | 403 if missing/invalid |
| Capability check | `policy.js` evaluate — each OPS action requires a named capability (e.g. `ops:resources:read`) | 403 if unauthorized |
| Query timeout | `statement_timeout` per query, configured via `DUNE_OPS_QUERY_TIMEOUT_MS` | 5,000 ms |
| Row limit | `LIMIT` clause on every aggregate query, configured via `DUNE_OPS_MAX_ROWS` | 500 |
| Response size | `Content-Length` check before response write; truncated with `X-Truncated: true` header if exceeded | 64 KB |
| Privacy | No player PII (character names, coordinates, inventory contents) in aggregate responses | Structural |

### Files

| File | Description |
|------|-------------|
| `opsProvider.js` | Real duneDb queries for activity/combat/resources/economy with authorization, timeouts, limits |
| `inventoryProvider.js` | Aggregate inventory stats with privacy-preserving output |
| `routes.js` | OPS route handlers with actor validation and capability enforcement |
| `duneDb.js` additions | `addonOpsActivitySummary`, `addonOpsResourcesSummary`, `addonOpsCombatDeaths`, `addonOpsEconomySummary` query functions |
| Tests | Provider shape contracts, route authorization, timeout/limit behavior |

### Independence from RBAC

The OPS providers use a **self-contained capability check** that does not
depend on the console's IAM engine. The capability model is:

```
ops:activity:read    ops:resources:read    ops:combat:read
ops:economy:read     ops:inventory:read    ops:soc:read
ops:prometheus:read
```

If PR 1 (RBAC) is merged first, the OPS providers integrate with the
console's IAM engine via `policy.js`. If shipped standalone, they use an
inline capability check that matches the same model.

### Strict Requirement 0

- Feature-gated behind `DUNE_DISCORD_ADAPTER_ENABLED` (default: `false`).
  No adapter → no OPS routes → zero behavioral change.
- Queries are additive — no schema changes, no data modification.
- Timeouts and limits protect the database under all load conditions.

---

## Deferred Items (separate, future PRs)

| Item | Reason for deferral |
|------|---------------------|
| IAM policy editor UI | Requires finalized RBAC engine; UI-only, no rush |
| Discord OAuth sign-in | Depends on RBAC; must address guild-membership ≠ Owner, local-password recovery, last-owner protection |
| External-bot signed handoff | Separate trust boundary — needs its own design and security review |
| Player scoping + link migration | Requires atomic migration plan, deduplication, no indefinite UNION; use in-game verified flow |
| Expression indexes on Funcom tables | Needs EXPLAIN evidence, size/write impact, compatibility per feedback item 7 |
| OAuth setup UI | Needs automated test suite before opening per feedback item 9 |
| Tooling (semgrep, gitleaks, ggshield) | Separate PRs by concern; pinned SHAs, minimal permissions |
| Storage UI fixes | Separate PR |
| Sietch display names | Separate PR |
| Operational documentation | Separate PR |
| SecureCookies migration | Coordinated, separate change |

---

## Expected diff stats

| PR | Files | Lines |
|----|-------|-------|
| PR 1: RBAC Foundation | 7 | +1602/-14 |
| PR 2: Discord OPS Providers | ~8 | ~600 (estimated) |

---

## Contact

Questions or discussion: open an issue on `yacketrj/dune-awakening-selfhost-docker`.
