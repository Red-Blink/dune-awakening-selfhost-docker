# Login Rate Limit Defense

Branch: `security/login-rate-limit-defense`

## Purpose

Add aggregate login throttling so brute-force attempts cannot bypass the existing limiter simply by rotating source addresses.

This PR keeps the current in-memory rate-limit architecture and adds a global bucket alongside the existing per-client bucket. It intentionally avoids persistence or proxy-header trust changes to keep the review small.

## Source Findings

Primary source: `C:/Users/ronal/OneDrive/Downloads/security_report.pdf`

Related finding:

- DAST-H4: Login rate limiter keyed on raw socket address and easily bypassed.

Related low-severity context:

- DAST-L4: Weak minimum admin/database password policies.

## Architecture Before

- Login failures were tracked only by `req.socket.remoteAddress`.
- Each remote address had its own failure window.
- Rotating source IPs could avoid the per-address threshold.
- A successful login cleared the current client's bucket.

## Architecture After

- The limiter still tracks the existing per-client bucket.
- The limiter also tracks a global aggregate failure bucket.
- `check(key)` blocks when either the client bucket or global bucket is blocked.
- `recordFailure(key)` increments both the client bucket and the global bucket.
- `recordSuccess(key)` clears only the client bucket, so one successful login does not erase aggregate abuse history.
- The default per-client threshold remains `8`; the new default aggregate threshold is `32`.

## Minimal Impact

- No API contract changes.
- No UI changes.
- No external datastore or service dependency.
- Existing server code continues to call the same `check`, `recordFailure`, and `recordSuccess` methods.
- Persistence and proxy-aware identity can be handled in separate PRs.

## Code Evidence

- `console/api/src/rateLimit.js:3-10` adds `globalMaxAttempts` and a global bucket key.
- `console/api/src/rateLimit.js:12-18` blocks when either the client or aggregate bucket is blocked.
- `console/api/src/rateLimit.js:21-25` records failures into both buckets.
- `console/api/src/rateLimit.js:28-30` keeps success reset scoped to the current client.
- `console/api/src/rateLimit.js:32-40` preserves active blocks even after the counting window has elapsed.
- `console/api/src/rateLimit.js:43-49` applies per-bucket thresholds.

## Test Evidence

Targeted unit test:

```bash
cd /home/ronal/dune-awakening-selfhost-docker-WSL/console/api
node --test test/rateLimit.test.js
```

Result: 2 tests passed.

Full API test suite:

```bash
cd /home/ronal/dune-awakening-selfhost-docker-WSL/console/api
npm test
```

Result: 144 tests passed.

Unit coverage added:

- `console/api/test/rateLimit.test.js:5-26` keeps coverage for per-client blocking and success reset.
- `console/api/test/rateLimit.test.js:28-49` verifies aggregate failures across rotating clients trigger a global block and that a single success does not clear that global block.

## Follow-ups

- Add persisted counters if operators need protection across process restarts.
- Add explicit proxy trust configuration before using forwarded headers as rate-limit identity.
- Consider password policy improvements separately.

