# Console IAM Architecture

The Web Console applies an IAM action to every authenticated API route. Public authentication and health routes remain outside this gate, and Discord adapter routes continue to use their existing bearer-token and Discord capability checks.

## Authorization flow

1. `auth.js` verifies the opaque `asc_session={id}.{HMAC(id)}` cookie and loads the server-side session.
2. `actions.js` maps the request method and path to one action such as `players:read` or `server:restart`.
3. `policy.js` evaluates the session tier using explicit-deny precedence: Deny, then Allow, then default Deny.
4. An unmapped authenticated route is denied. `rbacParity.test.js` prevents new routes from being merged without a mapping.
5. A handler whose privilege depends on the request *body* runs a second check, `requireAction`, once the body is parsed. It re-runs both gates above against a narrower action, so it can only narrow access, never widen it.

## Content-conditional actions

`actionForRoute` sees a method and a path, never a body. A route that does two things at two different blast radii therefore resolves to the safer of the two, and the handler narrows it afterwards. These actions are listed in `CONTENT_CONDITIONAL_ACTIONS` in `actions.js` so `allKnownActions()` — the set the API key scope catalog and any policy-authoring tool read — still sees them.

| Action | Route | Reached when |
|---|---|---|
| `database:execute` | `POST /api/database/query` | the SQL is not read-only |

`POST /api/database/query` resolves to `database:query`, a read-shaped name, and accepts write SQL down the same route. Before the split that made the default admin policy's `Deny` on `database:mutate` and `database:write-config` decorative: the narrow structured cell-edit was denied while arbitrary `UPDATE`/`DELETE`/`DROP` stayed reachable through the raw-SQL path admin still held. The write half is now `database:execute`, denied to `admin` by default. The check runs before the mutation rate limiter and before the pre-write backup, so a refused caller triggers neither side effect.

Adding one: put the action in `CONTENT_CONDITIONAL_ACTIONS`, call `requireAction(req, res, action)` at the top of the handler, and decide its place in the default policies. `databaseQueryAuthz.test.js` is the pattern to copy for coverage.

## API key principals

An API key is the second principal type. It authenticates with `Authorization: Bearer <key>`
before `auth.js` runs, because a bearer request carries no CSRF token and `requireAuth` would
reject it. Its scope is a per-namespace Read/Read+write map of its own, evaluated by
`apiKeys.js` on top of the action this route resolved to.

Keys carry no configurable tier. The `owner` tier in the synthesized principal exists only so
`resolveSessionTier` recognises it — `owner` is `Allow *`, so the policy check is a no-op and
the key's scope map is the single thing deciding access. `settings:*`, `database:*` and `setup:*` are
denied to every key regardless of what its stored record says, which is what keeps key
management a browser-session operation. `updates:*` and `addons:*` are write-denied rather than
denied outright, so a key can poll for updates and list addons but never install either. See [console/api-keys.md](console/api-keys.md).

Session tier and identity stay in the in-memory session store; they are not placed in the browser cookie. A Console process restart invalidates existing sessions, matching the previous session lifecycle and preventing stale role claims from surviving a restart.

## Policies

The default policies preserve full owner access and provide conservative defaults for future admin, moderator, player, and observer sessions. Password logins and `ADMIN_AUTH_DISABLED=1` create owner sessions, so existing Console installations keep their current behavior.

Policy documents use this shape:

```json
{
  "owner": {
    "version": 1,
    "tier": "owner",
    "statements": [
      { "Effect": "Allow", "Action": "*" }
    ]
  }
}
```

`Action` may be one string or an array. Exact actions, namespace wildcards such as `players:*`, and `*` are supported. Explicit Deny statements override Allow statements for every tier, including owner.

### Every action must exist

`PUT /api/settings/iam/policy` refuses a document naming an action that does not exist, listing the offenders. The test is *does this pattern match at least one action in the catalog*, so wildcards stay legal — `players:*` and `bases:delete-*` are fine, `player:*` and `players:reset-*` are refused because they match nothing.

This exists because the failure is asymmetric. A misspelled action in an **Allow** fails closed and grants nothing. The same string in a **Deny** withholds nothing while reading exactly like a restriction:

```json
{ "Effect": "Deny", "Action": ["players:reset-progression"] }
```

No route resolves to `players:reset-progression` — the real action is `players:mutate`, which covers every player mutation at once — so that statement denied nothing at all. It was this document's own example until 2026-08-28.

`GET /api/settings/iam/policies` returns an `actions` array alongside the policies: the full catalog, sorted. Policies are hand-authored JSON with no editor UI, so that response is the vocabulary to author against.

A file at `runtime/generated/iam-policies.json` that already names a dead action is **loaded, not discarded** — the Console logs one warning per pattern at startup and keeps the operator's policy in force. Rejecting the document would silently revert their whole policy to defaults, a bigger surprise than the dead pattern.

`POST /api/settings/iam/policy/test` returns `known` alongside `allowed`. A misspelled action answers `allowed: false`, which reads as "my Deny works" — `known: false` is what distinguishes a real denial from a typo.

The policy API is owner-only under the default policy:

- `GET /api/settings/iam/policies` returns the active policy store plus `actions`, the full catalog of valid action names.
- `PUT /api/settings/iam/policy` validates and atomically saves the complete policy store to `runtime/generated/iam-policies.json`.
- `POST /api/settings/iam/policy/test` evaluates an action for a tier without changing policy, and reports whether the action exists (`known`).

Updates that remove the owner's `settings:write` access are rejected so the local-password recovery path remains available.

## The players and guilds actions

`players:mutate` was one action covering all 41 mutating method+path pairs under `/api/players/` — kick, ban, wipe a character's progression, delete items from their inventory, mint currency, hand out max-level specializations. It was split on 2026-08-29, grouped by consequence:

| Action | Covers |
|---|---|
| `players:moderate` | kick, ban, unban |
| `players:teleport` | teleport |
| `players:give-item` | give-item(s), give-item-id, augment-item, spawn-vehicle |
| `players:grant` | currency, XP, intel, faction reputation, faction, skill points/module, building & customization & recipe & research unlocks, specialization XP/grant-max/keystones, journey & tutorial completion |
| `players:reset` | reset-progression, clean-inventory, journey/tutorials/specializations/keystones resets |
| `players:delete-item` | delete one inventory row |
| `players:edit-item` | edit one inventory row in place |
| `players:repair` | gear, faction reputation, landsraad quests, login queue, vehicle decay, refuel, refill water |
| `players:recover` | character recovery |

**`players:mutate` no longer exists.** A hand-authored policy still naming it is refused by `PUT /api/settings/iam/policy` and warned about at startup, rather than silently continuing to mean something narrower than intended. Replace it with the narrower actions you actually want. Policies using `players:*` are unaffected, as are the shipped defaults — `owner` (`*`) and `admin` (`players:*`) still reach everything, and `moderator`/`player`/`observer` are unchanged.

`guilds:mutate` was split the same day and for the same reason. `DELETE /api/guilds/{guildId}` is **disband** — it destroys the guild — and it shared one action with promoting a member, so a roster fix and a deletion were the same grant.

| Action | Covers |
|---|---|
| `guilds:disband` | delete the guild |
| `guilds:membership` | add a member, remove a member |
| `guilds:rank` | promote, demote |

Add and remove stay one action deliberately: two directions of the same roster knob. Both `DELETE` patterns are anchored regexes rather than prefix rules, because `/api/guilds/{id}` and `/api/guilds/{id}/members/{playerId}` share a prefix and the variable segment comes before the part that distinguishes them — the same reason `bases:delete` needs a real regex.

`players:unclassified` is a fail-closed sentinel, not something to grant. The three `POST`/`DELETE`/`PATCH /api/players/` prefix rules resolve to it so that a route nobody has classified yet cannot fall through to the method-agnostic `players:read` fallback and be authorized by a read-only grant. `actionSplits.test.js` asserts no route in `server.js` actually lands on it (`guilds:unclassified` likewise), so a new route fails CI until it is given a real action.

## Route maintenance

When adding an authenticated API route, add its method/path mapping to `actions.js` in the same change and run:

```bash
cd console/api
node --test test/rbacParity.test.js test/policy.test.js test/auth.test.js test/databaseQueryAuthz.test.js test/policyActionValidation.test.js test/actionSplits.test.js
```

Parameterized routes use the method-aware and prefix mappings at the bottom of `actions.js`. Prefer exact mappings whenever the route has a fixed path.
