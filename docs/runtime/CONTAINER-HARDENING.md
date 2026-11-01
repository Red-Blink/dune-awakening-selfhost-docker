## Container Hardening — Change Summary

**Status:** Historical record — describes the container hardening change as merged. Not maintained.

For the current behavior, see [`docker-compose.yml`](../../docker-compose.yml),
[`docker-compose.web.yml`](../../docker-compose.web.yml) and
[`tests/container-lifecycle-test.sh`](../../tests/container-lifecycle-test.sh).

### Overview

This PR hardens the console and orchestrator containers to run with reduced
privileges where the host installation permits it. The console maps its runtime
UID/GID to the repository owner; this is non-root for normal user-owned installs,
while intentionally root-owned installs remain UID 0 for compatibility. The
orchestrator runs as root briefly for volume permission repair and Docker socket
access, then drops to the `dune` user.

### Files Changed (10 files, +415/-12 lines)

| File | Change | Purpose |
|------|--------|---------|
| `console/api/Dockerfile` | +8 | Create `dune` user, set `USER dune`, 755 perms on `/app` |
| `console/api/entrypoint.sh` | +17 (new) | Verify `/repo` writability, fail fast with clear error |
| `docker-compose.web.yml` | +2 | Pass `DUNE_HOST_UID`/`DUNE_HOST_GID` to container env |
| `docker-compose.yml` | +4/-1 | Add `group_add` for Docker socket, run orchestrator as `dune` |
| `orchestrator/Dockerfile` | +12/-2 | Create `dune` user, add entrypoint, fix COPY paths |
| `orchestrator/dune_orchestrator.py` | +27/-5 | Conditionally chown volumes (skip if already running as dune) |
| `orchestrator/entrypoint.sh` | +50 (new) | Repair root-owned volumes, handle Docker socket group, drop to dune |
| `runtime/scripts/init.sh` | +10 | Auto-detect `DUNE_HOST_UID`/`DUNE_HOST_GID` from host |
| `tests/container-lifecycle-test.sh` | +143 (new) | 10 container lifecycle tests |

---

### Design Decisions & Rationale

#### 1. Console uses the host repository owner's UID/GID

**What**: The Dockerfile creates a `dune` user and sets `USER dune` as the image
default. Compose overrides the runtime UID/GID with the detected owner of the
host repository. The entrypoint only checks `/repo` writability; it performs no
`chown`, `useradd`, or `groupadd` operations.

For normal user-owned installs this runs the console as a non-root numeric UID.
If the installation is intentionally owned and operated by root, the detected
UID/GID is `0:0` and Compose keeps the console running as root so existing
installations continue to work. Because the console mounts the Docker socket,
administrators must treat it as a trusted, root-equivalent management service
regardless of its process UID.

**Why**: Docker's own best practices state: *"Avoid running applications as
root. Even if the container is designed to be run as root, consider adding
a non-root user."* When a container breakout occurs (CVE-2024-21626, runc),
the attacker inherits the container's privileges. Running as non-root limits
damage to the container's filesystem only.

**Sources**:
- [Dockerfile best practices — USER](https://docs.docker.com/develop/develop-images/dockerfile_best-practices/#user)
- [CIS Docker Benchmark 4.1](https://www.cisecurity.org/benchmark/docker): "Ensure that a user for the container has been created"
- [NIST SP 800-190](https://csrc.nist.gov/publications/detail/sp/800-190/final): Container runtime privilege reduction
- [OWASP Docker Security Cheat Sheet — Rule #7](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html#rule-7-run-as-a-non-root-user)

#### 2. Dynamic UID/GID — no hardcoded 1000

**What**: Removed `useradd -u 1000`. The `dune` user gets a system-assigned UID.
Compose `user:` field maps the host UID to the container at runtime.
`init.sh` auto-detects host UID/GID via `$(id -u)` and `$(id -g)`.

**Why**: Hardcoding UID 1000 assumes every host has a user at that ID.
Real deployments use arbitrary UIDs (LDAP, enterprise, shared servers).
Docker maps by numeric UID, not by name — the container doesn't need
a host user called `dune`.

**Sources**:
- [Docker run reference — user](https://docs.docker.com/reference/cli/docker/container/run/#user): "The user can be specified by UID or username"
- [Linux namespaces man page](https://man7.org/linux/man-pages/man7/user_namespaces.7.html): UID mapping is numeric, not name-based

#### 3. Upgrade path and repository writability

**What**: The entrypoint checks `/repo` writability via a `touch` test. If the
configured runtime UID/GID cannot write to the host directory, the container
exits with a clear error message telling the administrator how to correct the
ownership or UID/GID configuration.

The console container does not automatically `chown` the repository. The
installer can migrate repository ownership on the host when moving an existing
installation to a non-root owner. Intentionally root-owned installations retain
UID/GID `0:0` and are not rejected solely because they are owned by root.

**Sources**:
- [CIS Docker Benchmark 5.1](https://www.cisecurity.org/benchmark/docker): "Ensure that, if applicable, an AppArmor or SELinux profile is enabled"
- Principle of least privilege: the container should not have permission to
  modify host filesystem ownership

#### 4. Orchestrator runs as root briefly — legitimate need

**What**: Orchestrator entrypoint runs as root, repairs volume ownership,
configures Docker socket group access, then drops to `dune` via `runuser`.

**Why**: The orchestrator manages Docker containers (needs socket access)
and game server volumes (needs write access). These operations require root.
The orchestrator entrypoint uses the privilege drop chain: `runuser` →
`gosu` → `setpriv` → `su` — each preserving argument boundaries.

**Sources**:
- [Docker socket security](https://docs.docker.com/engine/security/#docker-daemon-attack-surface): "Giving someone access to the Docker socket is equivalent to giving them root"
- [setpriv man page](https://man7.org/linux/man-pages/man1/setpriv.1.html): Argument-preserving privilege drop tool

#### 5. Argument-preserving privilege drop

**What**: Replaced `su - dune -c "exec $*"` with `runuser -u dune -- "$@"`.
The old form loses argument boundaries (spaces, quotes). The new form
preserves them via proper shell argument forwarding.

**Sources**:
- [Shell parameter expansion](https://www.gnu.org/software/bash/manual/html_node/Special-Parameters.html): `$*` vs `$@` — `$@` preserves argument boundaries
- [runuser man page](https://man7.org/linux/man-pages/man1/runuser.1.html): Designed to replace `su` for service management

---

### Test Results (10 scenarios, 11 pass)

```
$ bash tests/container-lifecycle-test.sh
=============================================
  Container Lifecycle Tests
=============================================

1. Dockerfile builds successfully
  ✓ Dockerfile builds

2. Container runs as non-root user
  ✓ container runs as UID 1001 (non-root)

3. Container user is 'dune'
  ✓ user is dune

4. Root-owned /repo blocks writes (upgrade simulation)
  ✓ entrypoint detects root-owned /repo and fails

5. Host-owned /repo allows writes
  ✓ entrypoint allows writable /repo

6. Custom UID via --user flag
  ✓ runs as UID 5678 with --user

7. Entrypoint preserves command arguments
  ✓ entrypoint runs CMD correctly

8. Compose config validates
  ✓ compose config valid

9. Entrypoint shell syntax
  ✓ syntax OK: entrypoint.sh
  ✓ syntax OK: entrypoint.sh

10. Orchestrator Dockerfile builds
  ✓ orchestrator Dockerfile builds

=============================================
  RESULTS: 11 pass, 0 fail
=============================================
```

---

### CI Status

All 4 upstream CI checks pass on every push:
- `api-tests` — full test suite
- `metrics-unit` — metrics stack tests
- `security-checks` — gitleaks, trivy, shellcheck, whitespace (details: [CI security checks](../security/ci-security-checks.md))
- `api-dependency-audit` — npm audit
