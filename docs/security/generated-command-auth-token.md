# Generated Command Auth Token

Branch: `security/generated-command-auth-token`

## Purpose

Remove the shared built-in RabbitMQ server-command auth token and generate a deployment-local secret on first use.

This keeps the existing command channel behavior but changes the default secret source from public source code to `runtime/secrets/command-auth-token.txt`.

## Source Findings

Primary source: `C:/Users/ronal/OneDrive/Downloads/security_report.pdf`

Related finding:

- SAST-H3: Hardcoded built-in RabbitMQ command auth token.

Related low-severity context:

- SAST-L4 notes that command publishing paths should share the same hardening direction.

## Architecture Before

- `console/api/src/rmq.js` contained a public built-in token constant.
- `runtime/scripts/admin-tools.sh` contained the same public built-in token constant.
- If `DUNE_COMMAND_AUTH_TOKEN` and `runtime/secrets/command-auth-token.txt` were absent, both paths used the source-controlled fallback.
- Every deployment without an override therefore shared the same command-channel secret.

## Architecture After

- `DUNE_COMMAND_AUTH_TOKEN` remains the highest-precedence explicit override.
- If `runtime/secrets/command-auth-token.txt` exists and is non-empty, both Node and shell paths reuse it.
- If no token exists, the Node path creates a random 32-byte base64url token and writes it with `0600` permissions.
- If no token exists, the shell path creates a random 32-byte hex token with `openssl rand -hex 32` and writes it with `0600` permissions.
- The public built-in token constant is removed from source.

## Minimal Impact

- Existing deployments with `DUNE_COMMAND_AUTH_TOKEN` keep working.
- Existing deployments with `runtime/secrets/command-auth-token.txt` keep working.
- New deployments generate a local secret automatically instead of failing closed or requiring extra setup.
- RabbitMQ publish payload shape and routing are unchanged.

## Code Evidence

- `console/api/src/rmq.js:7-8` defines the container name and token byte count without a built-in token value.
- `console/api/src/rmq.js:229-245` resolves env override, reuses the secret file, or creates a new `0600` secret.
- `runtime/scripts/admin-tools.sh:10-11` keeps the same shared token file path.
- `runtime/scripts/admin-tools.sh:133-149` resolves env override and secret-file reuse before generation.
- `runtime/scripts/admin-tools.sh:152-162` generates a local token with `openssl rand -hex 32` and writes it with `0600` permissions.
- `.env.example:67-69` documents that the file is read or created locally.

## Test Evidence

Targeted shell assertion:

```bash
cd /home/ronal/dune-awakening-selfhost-docker-WSL
bash runtime/tests/test-command-auth-token.sh
```

Result:

```text
PASS: command auth token is generated instead of built in
```

Syntax checks:

```bash
bash -n runtime/scripts/admin-tools.sh runtime/tests/test-command-auth-token.sh
```

Result: passed.

API unit tests:

```bash
cd /home/ronal/dune-awakening-selfhost-docker-WSL/console/api
npm test
```

Result: 145 tests passed.

Unit coverage added:

- `console/api/test/rmq.test.js:113-133` verifies the Node path generates, stores, chmods, and reuses a local token.
- `console/api/test/rmq.test.js:135-150` verifies `DUNE_COMMAND_AUTH_TOKEN` remains an explicit override and does not create a file.

Static source check:

```bash
grep -RIn -- 'Nu6VmPWUMvdPMeB7qErr\|BUILTIN_COMMAND_AUTH_TOKEN' console/api/src runtime/scripts .env.example
```

Result: no matches.

## Follow-ups

- Consider adding a rotation command that regenerates the token and restarts dependent services.
- Continue hardening RabbitMQ TLS and management exposure in separate PRs.

