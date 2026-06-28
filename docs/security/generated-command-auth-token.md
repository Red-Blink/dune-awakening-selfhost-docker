# Generated Command Auth Token

Branch: `security/generated-command-auth-token-fix`

## Purpose

Remove the shared built-in RabbitMQ server-command auth token and generate a deployment-local secret on first use.

The command channel behavior stays the same: admin tools and the WebUI still send the `Version`, `AuthToken`, and `MessageContent` envelope to the existing RabbitMQ route. The default token source changes from public source code to `runtime/secrets/command-auth-token.txt`.

## Source Findings

- Upstream `Red-Blink/dune-awakening-selfhost-docker` `main` at `1bb72c5027b5fbab4cbf4ae7d0328a8793539a0a` still contains the static fallback in `console/api/src/rmq.js` and `runtime/scripts/admin-tools.sh`.
- Fork tracking issue: `yacketrj/dune-awakening-selfhost-docker-WSL#66`.
- Related upstream history: `Red-Blink/dune-awakening-selfhost-docker#22` attempted this class of fix but was closed unmerged.

## Architecture Before

- `console/api/src/rmq.js` contained a public built-in token constant.
- `runtime/scripts/admin-tools.sh` contained the same public built-in token constant.
- If `DUNE_COMMAND_AUTH_TOKEN` and `runtime/secrets/command-auth-token.txt` were absent, both paths used the source-controlled fallback.
- Every deployment without an override therefore shared the same command-channel secret.

## Architecture After

- `DUNE_COMMAND_AUTH_TOKEN` remains the highest-precedence explicit override.
- If `runtime/secrets/command-auth-token.txt` exists and is non-empty, both Node and shell paths reuse it.
- If no token exists, the Node path creates a random 32-byte base64url token and writes it with `0600` permissions.
- If no token exists, the shell path creates a random 32-byte hex token with `openssl rand -hex 32`, falling back to Python `secrets.token_hex(32)` when OpenSSL is unavailable.
- The public built-in token constant is removed from source.

## STRIDE Notes

- Spoofing: deployment-local tokens remove a public shared credential that could authenticate forged server-command payloads.
- Tampering: generated files use `0600` permissions to limit local modification to the owning user.
- Repudiation: existing admin audit and history output stay unchanged.
- Information disclosure: the token is not printed in command output; RabbitMQ error output continues to redact `AuthToken`.
- Denial of service: no routing or payload schema changes are introduced.
- Elevation of privilege: explicit `DUNE_COMMAND_AUTH_TOKEN` override remains available for operators who manage secrets externally.

## Minimal Impact

- Existing deployments with `DUNE_COMMAND_AUTH_TOKEN` keep working.
- Existing deployments with `runtime/secrets/command-auth-token.txt` keep working.
- New deployments generate a local secret automatically instead of requiring extra setup.
- RabbitMQ publish payload shape and routing are unchanged.

## Verification Plan

Run from the repository root:

```bash
bash -n runtime/scripts/admin-tools.sh runtime/tests/test-command-auth-token.sh
bash runtime/tests/test-command-auth-token.sh
npm test --prefix console/api
npm audit --prefix console/api --audit-level=moderate
npm run build --prefix console/web
git diff --check
```

Run a source secret scan after committing or from a clean export so dependency folders and local runtime secrets are excluded:

```bash
git archive --format=tar HEAD | tar -xf - -C /tmp/dune-gitleaks-source
gitleaks detect --no-git --source /tmp/dune-gitleaks-source --redact
```

## Verification Results

Validation was run from the staged source tree for this branch.

- `bash -n runtime/scripts/admin-tools.sh runtime/tests/test-command-auth-token.sh`: passed.
- `bash runtime/tests/test-command-auth-token.sh`: passed.
- `npm test --prefix console/api`: 183 tests passed.
- `npm audit --prefix console/api --audit-level=moderate`: 0 vulnerabilities.
- `npm audit --prefix console/web --audit-level=moderate`: 0 vulnerabilities.
- `npm run build --prefix console/web`: passed.
- `git diff --cached --check`: passed.
- `gitleaks detect --no-git --source <staged export> --redact --exit-code 1`: no leaks found.
- `trivy fs --scanners secret --exit-code 1 --severity HIGH,CRITICAL <staged export>`: passed.
- `semgrep --config p/secrets` on changed files: 0 findings.
- `semgrep --config p/security-audit` on changed runtime command files: 0 findings.

Full Trivy misconfiguration scanning still reports pre-existing Dockerfile HIGH findings outside this PR:

- `DS-0002` non-root container users in `console/api/Dockerfile` and `orchestrator/Dockerfile`; tracked in fork issues `#34`, `#36`, and open upstream PR `Red-Blink/dune-awakening-selfhost-docker#13`.
- `DS-0029` missing `--no-install-recommends` in `orchestrator/Dockerfile`; tracked in fork issue `#67`.

## Review Notes

- This change does not rotate existing deployment secrets. Operators who already created `runtime/secrets/command-auth-token.txt` or set `DUNE_COMMAND_AUTH_TOKEN` should rotate them through their normal secret management process if exposure is suspected.
- This change does not claim SOC 2 certification. It provides evidence useful for secret-management and change-control review.
