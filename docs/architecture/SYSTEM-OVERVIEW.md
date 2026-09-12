# System Architecture Overview

**Status:** Current | **Last Updated:** August 2026

This document is the whole-system engineering reference for
`dune-awakening-selfhost-docker`. It exists because the repository's
per-feature documentation (indexed in [`docs/README.md`](../README.md)) is
comprehensive but component-scoped; no single document previously described
how the pieces fit together end to end. This document does not replace any
existing component doc — it links to them. Where this document and a
linked component doc disagree, the component doc is authoritative for that
component; open an issue to reconcile the discrepancy.

Audience: engineers working on this project's code (Core, the console, the
runtime scripts, the addon platform). For an operator-facing walkthrough of
running a server day to day, see [`docs/operator-guide.md`](../operator-guide.md).

The facts below are maintained against `main` and were verified by reading the
actual source files cited. Prefer the linked component documentation and source
when an exact count or implementation detail changes.

---

## 1. Component Map

The system is composed of five independently-deployed pieces, all coordinated
by shell scripts under `runtime/scripts/`:

```
                    ┌─────────────────────────────┐
                    │   Host (Linux, Docker)       │
                    │                               │
  operator ──SSH──► │  runtime/scripts/dune  (CLI) │
                    │        │                      │
                    │        ├─► docker-compose.yml           → orchestrator (SteamCMD)
                    │        ├─► docker-compose.web.yml        → console API + web (Web UI)
                    │        ├─► docker-compose.metrics.yml     → Prometheus/Grafana/etc (opt-in)
                    │        ├─► docker-compose.public-probe*.yml → public-probe (opt-in)
                    │        └─► raw `docker run` for: Postgres, RabbitMQ, TextRouter,
                    │             BattlegroupDirector, the always-on world servers
                    │             (Survival_1, Overmap), ServerGateway, and each
                    │             dynamically-spawned map partition (Deep Desert, ...)
                    └─────────────────────────────┘
```

The always-on core path uses Compose for the `orchestrator` and web console;
the opt-in metrics and public-probe stacks also define named Compose services
in their own Compose projects. The actual gameplay containers (Postgres,
RabbitMQ, TextRouter, the Director, the Gateway, the always-on world servers,
and dynamically spawned map partitions) are started as raw `docker run`
containers by `runtime/scripts/start-all.sh` and related scripts, not by Compose.

### 1.1 The `orchestrator` container

Defined in `docker-compose.yml` (single service, `network_mode: host`,
Docker-socket bind-mounted). Built from `orchestrator/Dockerfile`
(`FROM ubuntu:24.04`, installs 32-bit compat libs required by the 32-bit
SteamCMD binary). Its entrypoint (`orchestrator/entrypoint.sh`) repairs
directory ownership for the non-root `dune` user, then drops privileges
(`runuser`/`gosu`/`setpriv`/`su`, in that preference order) before running
its default command, `dune daemon` — a Python CLI
(`orchestrator/dune_orchestrator.py`) with four subcommands: `daemon`
(sleep loop, keeps the container alive), `status`, `preflight` (disk-space
check, default minimum 25 GiB free), and `download` (installs SteamCMD on
first use, then runs it anonymously to fetch/validate the actual Dune
Awakening dedicated-server binaries into the shared `dune-server` named
volume). This container's sole job is managing the SteamCMD-installed game
binaries independently of whether the gameplay containers are running.

### 1.2 The console (`redblink-dune-docker-console`)

Defined in `docker-compose.web.yml` (`name:
dune-awakening-selfhost-docker`, a project name fixed for this file only,
independent of the main stack's resolved Compose project name — see §3).
Built from `console/api/Dockerfile`, `network_mode: host`, runs as
`${DUNE_HOST_UID}:${DUNE_HOST_GID}` (non-root by default), bind-mounts the
whole repo at `/repo` and the Docker socket. This is the Web UI — see §2.

### 1.3 The metrics stack (opt-in)

Defined in `docker-compose.metrics.yml`, run as a *separate* Compose
project (`${DUNE_COMPOSE_PROJECT_NAME}-metrics`) via `dune metrics`. Four
services: `dune-prometheus`, `dune-node-exporter`, `dune-cadvisor`,
`dune-postgres-exporter`. Prometheus publishes only on `127.0.0.1` by
default. See
[`docs/runtime/E2E-METRICS-TESTING.md`](../runtime/E2E-METRICS-TESTING.md).

### 1.4 The public probe (opt-in)

Defined in `docker-compose.public-probe.yml` (a small Go program,
`runtime/public-probe/main.go`, hardened: `read_only`, `cap_drop: [ALL]`,
`no-new-privileges`) plus a `docker-compose.public-probe-host.yml` overlay
that switches it to `network_mode: host`. Requires three mandatory env vars
(`DUNE_PUBLIC_PROBE_SERVER_ID`, `_SECRET`, `_SIGNAL_URL`). This is the
mechanism backing the DuneDocker.app public server directory heartbeat —
see the root [`README.md`](../../README.md), "Public Server Directory." On
native Linux it confines direct ICE candidates to UDP `32000-32015`; when that
range is not permitted through the host and upstream network, the website's
relay path remains available.

### 1.5 The gameplay containers (raw `docker run`, not Compose)

Started/stopped/restarted by `runtime/scripts/start-all.sh` /
`stop-all.sh` / the `dune restart <target>` dispatch in
`runtime/scripts/dune`. In dependency order: Postgres → RabbitMQ →
TextRouter → BattlegroupDirector → the always-on world servers
(`Survival_1`, `Overmap`) → ServerGateway → dynamically-spawned/despawned
map partitions (via `dune spawn` / `dune despawn`). An Autoscaler process
(`runtime/scripts/autoscaler.sh`) runs continuously to spawn/despawn
dynamic maps based on demand signals it tracks under
`runtime/generated/autoscaler-*`.

---

## 2. The console (`console/api` + `console/web`)

### 2.1 API (`console/api/`)

- **Runtime:** plain Node.js (`engines.node >= 18.19.0`), **no HTTP
  framework** — `src/server.js` is a monolithic dispatcher built directly
  on Node's `node:http` module. The only production dependency is `pg`
  (`console/api/package.json`).
- **Entrypoint:** `src/server.js` (`npm start` → `node src/server.js`).
- **Test framework:** Node's built-in `node --test` (`npm test`), with tests
  under `console/api/test/`. Integration tests (suffixed
  `.integration.test.js`) spin up isolated per-test Postgres databases via
  `console/api/test-support/pgIntegrationDb.js` and must run at
  `--test-concurrency=1` (CI enforces this,
  `.github/workflows/ci.yml`).
- **Key source modules** (non-exhaustive; see the file for the full list):
  `auth.js` (session/cookie auth), `policy.js` (IAM policy evaluation),
  `actions.js` (route→action mapping), `duneDb.js` (the large game-data
  query/mutation layer — the single largest source file in the repo),
  `db.js` (the Postgres connection pool), `addons.js` (the addon
  manager), `config.js` (env/secret loading), plus the `services/` and
  `integrations/discord/` directories (the latter is the Discord adapter —
  see §5).

### 2.2 Web (`console/web/`)

- **Stack:** React 19 + TypeScript, built with Vite 8
  (`npm run build` → `tsc -b && vite build`). No router or state-management
  library; a single hand-written stylesheet.
- **Test framework:** Vitest (`npm test` → `vitest run`).
- **Structure:** `src/api/` (typed HTTP client modules, one per backend
  feature area), `src/features/` (one directory per Web UI feature area),
  `src/components/` (shared UI), `src/lib/` (utilities).

### 2.3 Authentication and authorization

Full detail: [`docs/console-iam.md`](../console-iam.md) (current, and the
authoritative source for this subsection).

Authorization is a four-step pipeline invoked per request inside
`server.js`, not framework middleware:

1. `auth.requireAuth()` — verifies an HMAC-signed opaque session cookie
   (`asc_session`, 12h sliding expiry, `HttpOnly; SameSite=Lax`); for any
   mutating request it also requires a matching `x-csrf-token` header.
   Session state (identity, tier) lives only in an in-process `Map`, never
   in the cookie itself — a Console process restart invalidates every
   session by design.
2. `actionForRoute()` (`actions.js`) — maps the HTTP method + path to one
   IAM action string.
3. `policy.evaluate()` (`policy.js`) — evaluates the session's tier
   against JSON policy documents with explicit **Deny > Allow > default
   Deny** precedence (AWS-IAM-style).
4. An authenticated route with no action mapping is denied by default; a
   dedicated test (`test/rbacParity.test.js`) prevents merging a new route
   with no mapping.

Five tiers are defined: `owner`, `admin`, `moderator`, `player`,
`observer` (`policy.js`). Password login and `ADMIN_AUTH_DISABLED=1` both
always produce an `owner`-tier session. Policy documents persist to
`runtime/generated/iam-policies.json` (mode `0600`) via an atomic write; a
policy update that would strip the `owner` tier's `settings:write` action
is rejected outright — the deliberate anti-lockout guard.

**This IAM gate does not cover the Discord adapter.** Discord-originated
requests use a separate bearer-token + Discord-role-based capability check
(`console/api/src/integrations/discord/policy.js`) with its own five-tier
list (`public`, `observer`, `moderator`, `admin`, `owner`) — see §5.

### 2.4 Data layer

The console maintains exactly one Postgres connection pool inside its own
process (`db.js`, built on `pg`). The console and the dedicated game
server both write to the same `dune` schema, but they are separate OS
processes — the closed-source game server establishes its own connection
to Postgres independently; it does not share this repo's in-process `pg`
pool object. The `dune` schema is the game-world schema, populated
primarily by the closed-source dedicated server itself (`dune.accounts`,
`dune.actors`, `dune.player_state`, `dune.landsraad_*`, world-partition
tables, etc.). A small number of console-authored tables also live in
this schema.

Backups of this database are covered by the `pg_dump`-based backup
pipeline — see
[`docs/console/database-backups.md`](../console/database-backups.md).

### 2.5 Addon platform

Implemented in `console/api/src/addons.js`. Community addons are fetched
from `https://raw.githubusercontent.com/Red-Blink/dune-docker-addons/main/index.json`,
verified by SHA-256 against the addon's manifest, and validated against a
fixed, hardcoded permission allowlist
(`ALLOWED_ADDON_PERMISSIONS`, e.g. `players:read`,
`files:addon-data`, `rewards:grant`, `players:message`, `database:write`,
`admin:grant-items`, `broadcast:send` — see the source
for the exact, current full list). An optional
`DUNE_SELF_UPDATE_TOKEN` (GitHub token), if configured, is attached to
the catalog index/manifest fetch only — it is never sent with the addon
archive download and never reaches installed-addon runtime code. An addon's
manifest (`addon.json`, `schemaVersion: 1`, `type: "ui"` only) declares
the permissions it wants; **installing an addon does not grant those
permissions** — an operator must explicitly approve each permission
before an addon can use it (`requireApprovedPermissions()`), and updates
require re-approval of any newly-requested permission. See
[`docs/addons/addon-item-grants.md`](../addons/addon-item-grants.md),
[`docs/addons/addon-scheduled-jobs.md`](../addons/addon-scheduled-jobs.md),
[`docs/addons/hardware-status.md`](../addons/hardware-status.md), and
[`docs/security/addon-provenance.md`](../security/addon-provenance.md)
for the developer-facing contract in full.

**Known documentation gap:** there is no document describing the
operator-facing click-path for browsing, installing, enabling, or
approving permissions for an addon in the Web UI (the UI exists at
`console/web/src/features/addons/`, but its actual navigation flow is not
written down anywhere in `docs/`). Do not assume a specific UI flow when
answering operator questions about this — verify against the running
`console/web` UI, or file a documentation issue.

---

## 3. The `dune` CLI and Compose-project-name resolution

`runtime/scripts/dune` is the primary operational entry point once a
server is installed — the Web UI calls into the same underlying scripts,
but every capability is also available directly from the CLI. It dispatches
on its first argument to one of a few dozen subcommands (`init`, `start`, `stop`,
`status`, `ps`, `servers`, `spawn`, `despawn`, `autoscaler`, `ports`,
`ready`, `logs`, `restart <target>`, `stop-service`, `console`/`web`,
`metrics`, `update`, `self-update`, `restart-schedule`,
`ip-change-restart`, `shutdown-protection`, `version`, `doctor`,
`storage`, `network`, `db`, `db-manage`/`database`, `secrets`,
`config`/`server`, `memory`, `memory-swap`, `sietches`, `maps`,
`deepdesert`, `admin`), each delegating to a dedicated script under
`runtime/scripts/`. Run `dune help` for the exact, current usage text — it
is generated from the same source this document was verified against and
will not drift from it the way a duplicated list in this document
eventually would.

Two behaviors are load-bearing enough to call out explicitly here because
they are easy to miss reading any single script in isolation:

### 3.1 Compose project name resolution (`runtime/scripts/compose-project.sh`)

Every invocation of `dune` resolves one Compose project name before doing
anything else, in this order: an explicit `DUNE_COMPOSE_PROJECT_NAME` env
var, then `COMPOSE_PROJECT_NAME`, then either of those keys already
persisted in `.env`, then live Docker inspection (does exactly one
Compose-project prefix currently own a complete set of the five expected
named volumes — `dune-server`, `dune-steam`, `dune-cache`,
`dune-generated`, `dune-work` — and does that match what's actually
running). If the running project doesn't match, or more than one complete
volume set exists, resolution **errors out** rather than guessing — this
is the safety mechanism that prevents a directory rename from silently
orphaning an operator's existing game-data volumes. This is also why this
project's Compose files deliberately do not hardcode a project `name:`
(with the sole, narrow exception of `docker-compose.web.yml`, which fixes
its own project name independently of the main stack's resolved name).

### 3.2 `VERSION`-driven Git-state self-repair

On every `dune` invocation except `init`/`help`, `auto_repair_stack_git_state()`
checks whether the `VERSION` file itself has an uncommitted diff and, if
so, treats `VERSION`'s content as the ground truth for what commit the
checkout *should* be at: it resolves the Git tag matching `VERSION`
(fetching it from `origin` if not present locally) and, if `HEAD` doesn't
match that tag's commit, backs up the working tree to a timestamped
tarball under `runtime/backups/self-update/` and force-resets
(`git reset --hard`) to the tagged commit. This exists to self-heal a
checkout that drifted from its installed `VERSION` (e.g. after an
interrupted self-update) — it is not a general-purpose safety net for
arbitrary local changes, since it only ever activates on a diff to the
`VERSION` file specifically.

---

## 4. Runtime state directories

Confirmed via `.gitignore` and cross-referenced against every script that
reads/writes them. All are relative to the repo root.

| Directory | Git-ignored? | Contents |
|---|---|---|
| `runtime/secrets/` | Yes | Operator credentials: Funcom Self-Host Service Token, FLS API key, RabbitMQ HTTP token-auth secret, command-auth token, the console's own auto-generated admin password. Created empty by `dune init`. |
| `runtime/generated/` | Yes | Ephemeral/derived state written by running scripts: battlegroup identity, image-tag resolution, per-partition port reservations, map/sietch/Deep-Desert config, systemd-timer state (auto-update, restart-schedule, IP-change-restart, shutdown-protection), the IAM policy store (`iam-policies.json`), the admin command audit log. Created empty by `dune init`. |
| `runtime/backups/` | Yes | `db/` (database backups), `self-update/` (both the CLI's own Git-state-repair tarballs and `self-update.sh`'s own backups), `system/` (encrypted full-system archives from `dune db backup-system`). |
| `runtime/data/` | No (shipped in the repo) | Static reference/lookup JSON shipped with the repo for `dune admin` item/vehicle/skill-module/XP-event-tag lookups — not operator-generated. |
| `runtime/defaults/` | No (shipped in the repo) | `UserEngine.ini`, `UserGame.ini` — default engine config templates referenced by the multi-server documentation and `usersettings.py`. |

`.env` is also git-ignored and holds the resolved Compose project name plus
every operator-set configuration value (see `.env.example` for the full,
commented list of every supported variable, grouped by feature area).

---

## 5. Discord integration — two distinct components

**Do not conflate these two.** [`docs/README.md`](../README.md) documents
this split explicitly, and it matters architecturally:

1. **The Discord adapter** (`console/api/src/integrations/discord/`) — a
   built-in, disabled-by-default, bearer-token-protected
   HTTP surface the console exposes for a companion Discord bot to read
   server status/population/etc., and, if `DUNE_DISCORD_WRITES_ENABLED=1`
   is set, to perform a narrow set of gated write actions (see
   `broadcastProvider.js`). This is the **operator-facing, current**
   integration — see
   [`docs/integrations/discord-integration/README.md`](../integrations/discord-integration/README.md)
   for the full route list and RBAC config.
2. **The `discord-control-bot`** — a separate, explicitly **experimental,
   internal, read-only** companion bot project. Its own admin guide states
   plainly that it "is not the authority" and cannot mount the Docker
   socket, write to Postgres, mutate players/maps/addons, or send
   broadcasts. See
   [`docs/integrations/discord-control-bot/admin-guide.md`](../integrations/discord-control-bot/admin-guide.md).

A separate design document,
[`docs/rw-architecture.md`](../rw-architecture.md), describes a
write-command architecture for Discord (two-phase preview/execute with
nonces) — check that document's own status line for whether it describes
shipped behavior or a still-open design at the time you're reading it.

---

## 6. Security and compliance tooling

Enforced at commit time (`.pre-commit-config.yaml`): `gitleaks`,
`ggshield` (GitGuardian), `trivy` (secret-scan only), `semgrep`
(`p/default`), plus a repo-specific `tests/security-pr-checks.sh` scoped to
`console/`, `runtime/`, `docker-compose*`, and `.env` changes. Enforced in
CI (`.github/workflows/ci.yml`): `security-checks`, `api-dependency-audit`
(`npm audit --audit-level=high` for `console/api`), and a `release-gate`
job that requires all other CI jobs to succeed. See
[`docs/security/`](../security/) for the individual
security review/hardening documents, most of which are marked **Historical
record** (point-in-time PR evidence) even where the control they describe
is still in force — read [`docs/README.md`](../README.md)'s Security
section for which is which.

---

## Related documents

- [`docs/README.md`](../README.md) — the documentation index; start here
  for anything not covered in this overview.
- [`docs/console-iam.md`](../console-iam.md) — authorization pipeline detail.
- [`docs/console/API-REFERENCE.md`](../console/API-REFERENCE.md) — full HTTP endpoint reference.
- [`docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md`](../runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md) — running multiple battlegroups behind one public IPv4.
- [`docs/operator-guide.md`](../operator-guide.md) — end-user/operator walkthrough.
