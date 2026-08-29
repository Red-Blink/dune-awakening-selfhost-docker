# API Keys

**Status:** Current | **Last Updated:** August 2026

Named, revocable credentials for calling the Console HTTP API from outside the browser — a
Grafana panel, a Discord bot, a community stats site, a monitoring script. Managed from the
**API Keys** section at the bottom of the Settings page.

Before this existed, the only credential was the admin login password, which mints an
owner-tier browser session with full access to all 21 IAM namespaces. Handing that to an
integration also hands it the ability to restart the server, mutate the database, and change
the password. An API key is scoped to exactly what you grant it, and nothing else.

Related: [console-iam.md](../console-iam.md) for the underlying action catalog and policy
engine, [API-REFERENCE.md](API-REFERENCE.md) for the management endpoints.

## Using a key

```bash
curl -H "Authorization: Bearer dak_7f3c1a9b_xK2p9vRmQ4tLbN8wZfH3jY6cD1sA5eU7gT0nB" \
  http://localhost:8088/api/players
```

Keys use the same `Authorization: Bearer` header as the Discord adapter. No cookie and no
CSRF token are involved: CSRF protects against a hostile page riding an ambient credential,
and a bearer token is not ambient — nothing attaches it to a request automatically.

A request with no `Authorization` header is unaffected and continues to use the browser
session. A request with a `Bearer` credential that is invalid, disabled or expired is refused
with `401` and does **not** fall back to cookie authentication.

## Scopes

Each key carries one access level per namespace:

| Level | Grants |
|---|---|
| **None** (default) | Nothing. This is what every namespace starts at. |
| **Read** | Every read-shaped action in the namespace. |
| **Read+write** | Every action in the namespace, including destructive ones. |

A new key is created with **no scopes at all** and can reach nothing until permissions are
deliberately granted, one namespace at a time. There is no bulk-grant control — that is a
deliberate omission, not a missing feature.

The level is stored, not an expanded list of actions, so a read-shaped route added in a later
release is covered by an existing Read grant without every key needing to be re-saved.

### Per-action scopes

A namespace may hold an **explicit list of actions** instead of a level. `players: "write"` grants
all twelve player actions at once — kicking, banning, wiping progression, deleting inventory —
which is exactly what the per-consequence action split was meant to make separable. A list grants
only what it names:

```json
{
  "name": "moderation bot",
  "scopes": {
    "players": ["players:read", "players:moderate"],
    "server":  "read"
  }
}
```

That key can kick and ban, and cannot reset progression, delete an inventory row, grant currency
or spawn a vehicle. The two forms mix freely across namespaces.

A list carries no implicit floor: listing only `players:moderate` does **not** also grant
`players:read`. Name every action you want.

**The trade-off is the mirror of the paragraph above.** A level auto-covers actions added in a
later release; a list does not. A read route added next version is reachable by `players: "read"`
and *not* by `["players:read"]` — that is the point of opting into a fixed set, but it means a
list needs revisiting when the catalog grows. Levels stay the right default for broad, trusted
keys; lists are for keys you want tightly bounded.

Unrecognised entries are dropped rather than coerced: an action that does not exist, or belongs to
another namespace, or is a write action in a write-denied namespace, is removed. If nothing
survives, the namespace becomes None — never a fallback to Read. A complete list is stored as a
list and is *not* collapsed into `"write"`, because the two mean different things going forward.

Denied namespaces (`settings`, `database`, `setup`) cannot be reached by naming their actions
individually; the namespace denial is checked before the scope lookup.

In the Settings UI, each namespace gains a fourth **Custom** segment that opens a checklist of
that namespace's actions. Switching to Custom seeds the list from whatever the namespace already
grants, so moving Read+write to Custom starts with everything ticked and you remove what you don't
want. A namespace with only one action (`logs`) offers no Custom segment, for the same reason one
with no write actions offers no Read+write: it would be another name for Read.

A Custom row with nothing ticked grants nothing and does not count towards the "grant at least one
namespace" rule, so Create stays disabled until something is selected.

| Namespace | Read grants | Read+write additionally grants |
|---|---|---|
| `players` | `players:read` | `delete-item`, `edit-item`, `give-item`, `grant`, `kick-all`, `moderate`, `recover`, `repair`, `reset`, `teleport`, `unclassified` |
| `bases` | `bases:read` | `add-item`, `bulk-delete-items`, `delete`, `delete-item`, `fill-item`, `give-item`, `mutate` |
| `vehicles` | `vehicles:read` | `bulk-delete-items`, `delete`, `delete-item`, `mutate` |
| `guilds` | `guilds:read` | `disband`, `membership`, `rank`, `unclassified` |
| `storage` | `storage:read` | `mutate` |
| `blueprints` | `blueprints:read` | `delete`, `export`, `import`, `unclassified` |
| `exchange` | `exchange:market`, `exchange:read` | `market-write`, `write-config` |
| `maps` | `maps:read` | `despawn`, `reconcile`, `restart`, `spawn`, `teleport`, `write-config` |
| `sietches` | `sietches:read` | `write` |
| `deepdesert` | `deepdesert:read` | `write` |
| `landsraad` | `landsraad:read` | `write` |
| `server` | `server:read` | `network-fix`, `restart`, `restart-service`, `start`, `stop`, `storage-cleanup`, `write-config` |
| `logs` | `logs:read` | *nothing — no write action exists* |
| `backups` | `backups:read` | `create`, `delete`, `import`, `restore`, `write-config` |
| `updates` | `updates:check`, `updates:read` | *nothing — write actions are denied to keys* |
| `carepackage` | `carepackage:read` | `clear-history`, `grant`, `scan`, `write-config` |
| `addons` | `addons:read` | *nothing — write actions are denied to keys* |
| `admin` | `admin:announcements:read`, `admin:history:read`, `admin:items:read`, `admin:motd:read`, `admin:skills:read`, `admin:transfer-settings:read`, `admin:vehicles:read` | `announcements:write`, `broadcast`, `broadcast-shutdown`, `history:clear`, `map-chat`, `motd:write`, `transfer-settings:write` |

`logs`, `updates` and `addons` render a two-segment control (None / Read), not three. `logs`
has no write action at all; the other two have several, but they are denied to keys — see
below. All three are read from the action catalog rather than hardcoded, so a future `logs`
write action makes the third segment appear on its own.

### Two read exceptions

Two actions are POST-shaped but read-only in effect, and are reachable by a **Read** grant:

- **`exchange:market`** — `GET /api/exchange/market`, `/market/exchanges`, `/market/buyback/log`,
  and `POST /market/buyback/probe`, which inspects buyback state without writing. Without it,
  `exchange: read` returns almost nothing and a read-only market dashboard is impossible. The
  write side remains `exchange:market-write`.
- **`updates:check`** — `POST /api/updates/check-game`. Spawns a check but applies nothing,
  and the result is absorbed by a cache, so a monitoring key can answer "is a game update
  available" without being able to install it. `POST /api/updates/check-stack` is deliberately
  *not* covered — it is a separate action, `updates:self-check`, classified as a write; see
  below.

`carepackage:scan` is deliberately *not* one of these: `POST /api/care-package/run` actually
runs a grant cycle. The verb-shaped name is not the test; what the route does is.

### What a key can never reach

Three namespaces are **denied outright** at every level — `settings`, `database` and `setup`.
They are not offered in the UI, and the check runs before the scope lookup, so hand-editing
`runtime/secrets/api-keys.json` to add them changes nothing.

- `settings` — a key can never mint, list, or revoke another key, including itself. Key
  management stays a browser-session operation.
- `database` — a key can never query, export, or mutate the game database directly.
- `setup` — `setup:write` rewrites `.env` and can re-run initialization, and `setup:read`
  exposes the configuration that describes the deployment. Unlike `updates` below, there is no
  half of it worth granting.

Two more namespaces are **write-denied** rather than denied outright — their reads are
grantable, their writes are unreachable at any level:

- `updates` — `updates:read` and `updates:check` let a monitoring integration answer "is a
  game update available", while `apply`, `fix`, `repair` and `write-config` (which can
  self-update the console) stay out of reach. `POST /api/updates/check-stack` is a separate
  action, `updates:self-check`, and is **not** reachable by a key: unlike the game check it is
  not cached, so every call would spawn a subprocess.
- `addons` — `addons:read` lists installed addons. The writes are denied because
  `POST /api/addons/installed/{id}/bridge` authorizes each action against the *installed
  addon's* manifest permission, never the caller's. A key holding `addons` at write level could install
  an addon declaring `database: write`, enable it, and run arbitrary SQL through it, straight
  past the `database` denial above. The bridge additionally refuses any key principal
  outright, so relaxing this denial cannot silently reopen that path.

A stored `"write"` level on a write-denied namespace degrades to read rather than being
honoured, both when saving and when authorizing, so a hand-edited store cannot promote it.

## Transport

A key is a bearer credential: anything that can read the request can replay it. Unlike the
session cookie it sits alongside, a key is long-lived and does not rotate, so **treat the
network path as part of its security**.

The console binds plain HTTP. If it is reachable beyond localhost, put it behind something
that encrypts:

- A reverse proxy terminating TLS (Caddy's automatic HTTPS is the least work), or
- A private network — WireGuard or Tailscale — which encrypts at the network layer with no
  certificates to manage.

`ADMIN_ALLOWED_IPS` is not encryption, but it narrows who can reach the endpoint at all and
composes with either of the above. It is worth setting even behind TLS.

## Storage and recovery

Keys live in `runtime/secrets/api-keys.json`, mode `0600`, written atomically. Only a
SHA-256 hash of the secret is stored, over a domain-separated input
(`dune-console-api-key-v1:`), following the precedent in
[rfc-console-auth.md](../rfc-console-auth.md) §2.3 — a password KDF is the wrong tool for a
high-entropy bearer token.

**The full key is displayed exactly once, at creation.** It cannot be recovered afterwards. A
lost key must be revoked and replaced.

Unlike browser sessions, which are held in memory and cleared by a console restart, keys are
persisted and survive restarts — that is the point of them. Revocation therefore deletes from
the file, not just from memory.

## Lifecycle

- **Expiry** — optional, per key, and must be in the future: a past date is refused rather than
  minting a key that fails its first call. Send it as a date string (`2027-01-31`) or a full
  ISO timestamp — a bare number is refused, because reading it as milliseconds turned an
  epoch-**seconds** value into a 1970 expiry. The console picks the last instant of the chosen
  day in the operator's own timezone. An expired key is refused with `401` and shown as Expired
  in the list until it is deleted.
- **Enable / disable** — a temporary off switch that keeps the key and its scopes. A disabled
  key is refused with `401`.
- **Revoke** — permanent. Confirmed through a dialog, and audited.
- **Last used** — timestamp and client address, shown in the list so an unused key is obvious
  before you revoke it.

Last-used data is buffered in memory and flushed at most once every 60 seconds, rather than
writing on every request. A hard crash loses up to 60 seconds of last-used history; nothing
else about a key is buffered.

## Rate limiting

Each key carries its own per-minute request limit (default 60, range 1–10000), applied to
**every** request it makes, reads included — an unbounded polling loop is a likelier accident
than a burst of writes. Exceeding it returns `429` with a `retry-after` header. A separate
global ceiling caps all key traffic together.

Failed credentials are counted separately, bucketed by client address rather than by key
(a refused request has no key to attribute), and every failure is written to the audit log as
`auth.api-key-failed`. Brute-forcing a 256-bit secret is infeasible; the point is that an
attempt leaves a trace to alert on.

A key holding `updates: read` is pinned to the cached update check — it cannot force the
uncached path that spawns a subprocess per call. That stays with the browser session.

Like every other limiter in the console, this has no `X-Forwarded-For` awareness. Behind a
reverse proxy the per-key limits still work correctly, because they key on the key id rather
than on an address; only the recorded last-used IP is affected.

## What the server enforces

- A key's access is its scope grid and nothing else. Keys carry no configurable IAM tier — the
  `owner` tier in the synthesized principal exists only because the policy engine denies any
  principal without a recognised tier, and `owner` is `Allow *`, which makes that check a no-op.
  It is not a second permission control, and a `tier` field appearing in a stored key record
  changes nothing.
- Authentication runs before the session gate, so a bearer request never reaches the CSRF check.
- An unrecognised namespace, an unrecognised level, or a misspelled level such as `"readonly"`
  normalizes to None. Nothing falls back to Read.
- A `"write"` level on a namespace whose writes are denied (`updates`, `addons`) or that has
  no write action (`logs`) is stored and evaluated as Read, never as write.
- Updating a key replaces its scopes wholesale. Omitting a namespace revokes it; there is no
  merge that could leave a stale grant behind.
- An unreadable key store fails closed — no key authenticates — and logs a warning.
- Every audited action records the acting principal — `{"type":"api-key","id":"..."}` for a
  key, `{"type":"session","tier":"..."}` for the browser. The browser session id is
  deliberately never written: it is half of the `asc_session` cookie value.
- Create, update and revoke are written to the audit log
  (`runtime/generated/web-admin-audit.jsonl`) as `settings.api-key-create`,
  `settings.api-key-update` and `settings.api-key-revoke`, recording the key id, name and
  scopes. Key material is never logged.
