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

`POST /api/database/query` resolves to `database:query`, a read-shaped name, and accepts write SQL down the same route. Before the split that made the default admin policy's `Deny` on `database:mutate` and `database:write-config` decorative: the narrow structured cell-edit was denied while arbitrary `UPDATE`/`DELETE`/`DROP` stayed reachable through the raw-SQL path admin still held. The write half is now `database:execute`, denied to `admin` by default.

**The permission is not what enforces this.** `database:execute` is chosen by `isReadOnlySql`, which only asks whether the statement starts with a read keyword and avoids a blacklist — and every privileged mutation in this application is shaped `select dune.<fn>(...)`, which passes that test. `SELECT ... INTO` and `select 1; select fn()` pass it too. A keyword blacklist cannot be repaired to cover them (`delete` does not match `delete_actors`, and the schema ships hundreds of functions).

So the read path executes inside a `set transaction read only` transaction: **Postgres** refuses the write, whatever the classifier concluded. `database:execute` decides which path a statement takes and whether a pre-write backup is taken; the transaction is what makes the read path actually read-only (`databaseReadOnlyEnforcement.integration.test.js` covers this against a real database). The check runs before the mutation rate limiter and before the pre-write backup, so a refused caller triggers neither side effect.

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

No route resolves to `players:reset-progression` — the route resolves to `players:reset` — so that statement denies nothing at all. It was this document's own example.

`GET /api/settings/iam/policies` returns an `actions` array alongside the policies: the full catalog, sorted. Policies are hand-authored JSON with no editor UI, so that response is the vocabulary to author against.

A file at `runtime/generated/iam-policies.json` that already names a dead action is **loaded, not discarded** — the Console logs one warning per pattern at startup and keeps the operator's policy in force. Rejecting the document would silently revert their whole policy to defaults, a bigger surprise than the dead pattern.

`POST /api/settings/iam/policy/test` returns `known` alongside `allowed`. A misspelled action answers `allowed: false`, which reads as "my Deny works" — `known: false` is what distinguishes a real denial from a typo.

The policy API is owner-only under the default policy:

- `GET /api/settings/iam/policies` returns the active policy store plus `actions`, the full catalog of valid action names.
- `PUT /api/settings/iam/policy` validates and atomically saves the complete policy store to `runtime/generated/iam-policies.json`.
- `POST /api/settings/iam/policy/test` evaluates an action for a tier without changing policy, and reports whether the action exists (`known`).

Updates that remove the owner's `settings:write` access are rejected so the local-password recovery path remains available.

## The split namespaces

`players:mutate` was one action covering all 41 mutating method+path pairs under `/api/players/` — kick, ban, wipe a character's progression, delete items from their inventory, mint currency, hand out max-level specializations. It is split by consequence:

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

**`players:mutate` is no longer in the catalog, but it still means what it meant.** See [Upgrading a policy that names a removed action](#upgrading-a-policy-that-names-a-removed-action) below. Shipped defaults are unchanged — `owner` (`*`) and `admin` (`players:*`) still reach everything, and `moderator`/`player`/`observer` are untouched.

`guilds:mutate` was split for the same reason. `DELETE /api/guilds/{guildId}` is **disband** — it destroys the guild — and it shared one action with promoting a member, so a roster fix and a deletion were the same grant.

| Action | Covers |
|---|---|
| `guilds:disband` | delete the guild |
| `guilds:membership` | add a member, remove a member |
| `guilds:rank` | promote, demote |

Add and remove stay one action deliberately: two directions of the same roster knob. Both `DELETE` patterns are anchored regexes rather than prefix rules, because `/api/guilds/{id}` and `/api/guilds/{id}/members/{playerId}` share a prefix and the variable segment comes before the part that distinguishes them — the same reason `bases:delete` needs a real regex.

`blueprints:mutate` and `addons:mutate` were split on the same grounds.

| Action | Covers |
|---|---|
| `blueprints:export` | bulk export (`POST /api/blueprints/export`) |
| `blueprints:import` | import |
| `blueprints:delete` | delete one blueprint |
| `addons:remove` | uninstall an installed addon |
| `addons:toggle` | enable, disable |
| `addons:bridge` | the manifest-authorized action channel |

Bulk export is read-only in effect — it only reads each blueprint and zips the results, and `GET /api/blueprints/{id}/export` is already `blueprints:read`. It is deliberately **not** folded into `blueprints:read`: one call pulls up to 500 blueprints, so granting read access to the list is not consent to bulk extraction. No existing read grant widens.

`addons:bridge` is separate from lifecycle control because the bridge authorizes against the **installed addon's** declared permission rather than the caller — so "may enable an addon" must not imply "may run whatever that addon declared". API keys cannot reach any addon write regardless: `addons` is write-denied for keys, and the bridge refuses key principals outright.

`players:unclassified` is a fail-closed sentinel, not something to grant. The three `POST`/`DELETE`/`PATCH /api/players/` prefix rules resolve to it so that a route nobody has classified yet cannot fall through to the method-agnostic `players:read` fallback and be authorized by a read-only grant. `actionSplits.test.js` asserts no route in `server.js` actually lands on it (and likewise for `guilds:`, `blueprints:` and `addons:`), so a new route fails CI until it is given a real action.

## Upgrading a policy that names a removed action

Splitting a coarse action is not a no-op for a policy that already named one. This document teaches the idiom

```json
{ "Effect": "Deny",  "Action": ["players:mutate"] },
{ "Effect": "Allow", "Action": ["players:*"] }
```

and simply deleting `players:mutate` turns that inside out: the `Deny` matches nothing, the surviving wildcard matches all ten successors, and the upgrade converts "no player mutations" into "every player mutation" — 22 actions gained and none lost, including `addons:bridge` and `guilds:disband`.

So the removed names are kept as **aliases**. `players:mutate`, `guilds:mutate`, `blueprints:mutate` and `addons:mutate` each resolve to exactly the actions the routes that used to resolve to them now resolve to:

| Removed | Now means |
|---|---|
| `players:mutate` | `moderate`, `teleport`, `give-item`, `grant`, `reset`, `delete-item`, `edit-item`, `repair`, `recover`, `unclassified` |
| `guilds:mutate` | `disband`, `membership`, `rank`, `unclassified` |
| `blueprints:mutate` | `export`, `import`, `delete`, `unclassified` |
| `addons:mutate` | `remove`, `toggle`, `bridge`, `unclassified` |

A `Deny` on a removed name still denies everything it used to; an `Allow` still grants everything it used to. `players:kick-all` is deliberately **not** in the list — it was already its own action before the split, so an alias must not hand it over.

The asymmetry is the point:

- **On load**, a stored policy naming a removed action is accepted and keeps its meaning. The Console logs one migration notice per name at startup, listing the successors.
- **On save**, `PUT /api/settings/iam/policy` refuses it, with an error naming the successors so the edit is mechanical.

That way an upgrade never silently re-interprets a policy and never refuses to start, while the next edit forces migration. Aliases are not in the catalog: they cannot be granted to an API key, and `GET /api/settings/iam/policies` does not offer them.

## Route maintenance

When adding an authenticated API route, add its method/path mapping to `actions.js` in the same change and run:

```bash
cd console/api
node --test test/rbacParity.test.js test/policy.test.js test/auth.test.js test/databaseQueryAuthz.test.js test/policyActionValidation.test.js test/actionSplits.test.js test/databaseReadOnlyEnforcement.integration.test.js
```

Parameterized routes use the method-aware and prefix mappings at the bottom of `actions.js`. Prefer exact mappings whenever the route has a fixed path.
