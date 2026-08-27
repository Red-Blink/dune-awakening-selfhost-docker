# Console IAM Architecture

The Web Console applies an IAM action to every authenticated API route. Public authentication and health routes remain outside this gate, and Discord adapter routes continue to use their existing bearer-token and Discord capability checks.

## Authorization flow

1. `auth.js` verifies the opaque `asc_session={id}.{HMAC(id)}` cookie and loads the server-side session.
2. `actions.js` maps the request method and path to one action such as `players:read` or `server:restart`.
3. `policy.js` evaluates the session tier using explicit-deny precedence: Deny, then Allow, then default Deny.
4. An unmapped authenticated route is denied. `rbacParity.test.js` prevents new routes from being merged without a mapping.

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

The policy API is owner-only under the default policy:

- `GET /api/settings/iam/policies` returns the active policy store.
- `PUT /api/settings/iam/policy` validates and atomically saves the complete policy store to `runtime/generated/iam-policies.json`.
- `POST /api/settings/iam/policy/test` evaluates an action for a tier without changing policy.

Updates that remove the owner's `settings:write` access are rejected so the local-password recovery path remains available.

## Route maintenance

When adding an authenticated API route, add its method/path mapping to `actions.js` in the same change and run:

```bash
cd console/api
node --test test/rbacParity.test.js test/policy.test.js test/auth.test.js
```

Parameterized routes use the method-aware and prefix mappings at the bottom of `actions.js`. Prefer exact mappings whenever the route has a fixed path.
