# Documentation Index

This folder mirrors the repo's own structure: component docs live under a folder
named for the component they document (`console/`, `runtime/`, `addons/`), while
docs that span the whole product or are pure assets stay at this root
(`screenshots.md`). Cross-cutting concerns (`security/`, `incidents/`) get their
own top-level folders.

Docs marked **Historical record** describe a point-in-time state (a branch, a PR,
an issue) and are not kept up to date — read them for context, not as current
reference. Everything else is marked **Current** and is expected to stay accurate.

## Adding a new doc

1. **Pick the folder by what the doc documents, not what kind of doc it is.**
   If it explains a piece of `console/api` or `console/web`, it goes in
   `docs/console/`. If it explains something under `runtime/`, it goes in
   `docs/runtime/`. Addon-platform behavior goes in `docs/addons/`. Only use
   `docs/security/` or `docs/incidents/` for concerns that cut across
   components (a vulnerability class, a post-incident review) rather than a
   single feature. Don't add a new top-level folder for one document — put it
   in the closest existing one.
2. **Decide Current vs Historical up front**, and put the line right after the
   H1, matching the existing docs:
   - Living reference that should be kept accurate as code changes:
     `**Status:** Current | **Last Updated:** <Month Year>`
   - A frozen snapshot of a PR, branch, or issue — a test report, a change
     summary, implementation notes — goes in `docs/archive/` with:
     `**Status:** Historical record — describes the state at <PR/branch/issue>. Not maintained.`
     Add a pointer to the current doc that superseded it, if one exists.
3. **Add one line to this index**, in the matching section above: a link, one
   sentence of purpose, and the status word. A doc with no line here is
   effectively invisible — this file is the only thing every other doc is
   guaranteed to be reachable from.
4. **Cross-link the doc's nearest relatives** (the feature doc it complements,
   the security review of the same code path, the API reference section that
   covers its endpoints) directly in the doc body, not just in this index.

## Architecture

A deliberate exception to this file's own "don't add a new top-level
folder for one document" rule above: a whole-system overview doesn't
belong to any single existing folder (`console/`, `runtime/`, `addons/`)
by nature, so it gets its own.

- [architecture/SYSTEM-OVERVIEW.md](architecture/SYSTEM-OVERVIEW.md) — Current. Whole-system engineering architecture reference: component map, the console's API/web/data layers, the `dune` CLI and Compose-project-name resolution, runtime state directories, and the Discord-integration split. Start here for a code-level overview before diving into a single component's docs.

## Console (`console/api`, `console/web`)

- [API-REFERENCE.md](console/API-REFERENCE.md) — Current. Full HTTP API reference for every console endpoint.
- [api-keys.md](console/api-keys.md) — Current. Named, revocable API keys for external callers: scopes that default to no access, given per namespace as Read/Read+write or as an explicit list of actions, the `settings`/`database`/`setup` namespaces no key can ever reach and the write-denied `updates` and `addons`, hash-only storage with a one-time reveal, and per-key expiry, disable and rate limits.
- [blueprints.md](console/blueprints.md) — Current. Blueprint import/export developer documentation.
- [PRE-AUGMENTED-GEAR.md](console/PRE-AUGMENTED-GEAR.md) — Current. API reference for granting gear with augments pre-applied.
- [generator-fuel-burn-rates.md](console/generator-fuel-burn-rates.md) — Current. Per-generator fuel burn constants and where they live in code.
- [generator-refill-caps.md](console/generator-refill-caps.md) — Current. Refill-generators endpoint behavior and per-type fuel caps.
- [base-permissions.md](console/base-permissions.md) — Current. Editing base ownership and sharing: ranks, the config-driven roster cap, and why the change needs no map restart.
- [base-child-permissions.md](console/base-child-permissions.md) — Current. The Base Permissions tab: the per-piece access-level scale (Public/Guild/Associate/Co-Owner/Owner), why Associate is "Sub-Fief," setting individual pieces to a specific level, and the pending-permission queue for a live map.
- [vehicle-permissions.md](console/vehicle-permissions.md) — Current. Editing vehicle ownership and sharing: the same roster engine as base permissions, including the Transfer to Custodian action.
- [base-inventory.md](console/base-inventory.md) — Current. The base Inventory tab: which placeables count as storage, the two inventories every refinery carries, per-slot container contents, and the Give/Fill/Delete container actions (none of which require a stopped map).
- [vehicle-storage.md](console/vehicle-storage.md) — Current. The Vehicles → Components View Contents overlay: which module counts as storage, why a vehicle's cargo hangs off its actor id rather than the (empty) `vehicle_module_id` link, and why the view is read-only.
- [base-deletion.md](console/base-deletion.md) — Current. Permanently deleting a base: what "the base" means for enumeration, the pending-delete queue for a live map, the mandatory pre-delete safety backup, and why a pending delete freezes every other mutation on that base.
- [vehicle-deletion.md](console/vehicle-deletion.md) — Current. Permanently deleting a vehicle: the FK cascade closure verified against a real schema dump, its own parallel pending-delete queue, and the vehicle-specific `dune.actor_state` guard bases have no equivalent of.
- [base-backups.md](console/base-backups.md) — Current. What the game's own "pick up base" tool actually does in the database, why the Bases panel excludes a picked-up base, and the Coriolis compatibility patch that preserves saved Deep Desert base actors.
- [database-backups.md](console/database-backups.md) — Current. Safe database restore behavior when the backup and current deployment use different Battlegroup IDs.
- [restart-queue.md](console/restart-queue.md) — Current. The Restart Queue toggle: player-aware countdowns with in-game warnings, the two broadcast variants, concurrency rules, crash recovery, the "Restart later" deferred-restart option, and the join-lock limitation.
- [exchange.md](console/exchange.md) — Current. The read-only Market Board: aggregated-by-item CHOAM exchange listings, seller resolution, how bot listings are identified, the bot/blacklist filter config, the Market Bot seed/buyback engine, and the Bot items tab's per-item catalog overrides.
- [live-map.md](console/live-map.md) — Current. The Live Map panel: partition display-name resolution, the actor/spice/POI marker data model (static archive + live decode + self-learning pool, the registry-driven POI framework), the Layers legend's hide-if-empty and default-settings mechanism, and Coriolis seed/countdown resolution.

## Runtime (`runtime/`)

- [CONTAINER-HARDENING.md](runtime/CONTAINER-HARDENING.md) — Current. Summary of container hardening changes.
- [E2E-METRICS-TESTING.md](runtime/E2E-METRICS-TESTING.md) — Current. End-to-end validation procedure for the metrics stack (`runtime/metrics`).
- [MULTI-SERVER-SINGLE-PUBLIC-IP.md](runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md) — Current. Executive overview and detailed SOP for running multiple isolated battlegroups behind one public IPv4, including full per-instance port profiles, NAT/hairpin requirements, UserEngine configuration, validation, rollback, and the `multi-server-config.py` automation helper.

## Addons

- [addon-item-grants.md](addons/addon-item-grants.md) — Current. The `admin:grant-items` permissioned addon item grant flow.
- [addon-scheduled-jobs.md](addons/addon-scheduled-jobs.md) — Current. Market Bot scheduler and EDA retirement compatibility.
- [hardware-status.md](addons/hardware-status.md) — Current. Permissioned, core-owned host telemetry for addon dashboards.

## Discord Integrations

Two overlapping doc sets — start with whichever matches your role:

- [discord-integration/README.md](integrations/discord-integration/README.md) — Current, **operator-facing**. Adapter overview, setup, routes, and RBAC.
  - [admin-guide.md](integrations/discord-integration/admin-guide.md) — Walkthrough for getting the bot running on your server.
  - [faq.md](integrations/discord-integration/faq.md) — Frequently asked questions.
  - [troubleshooting.md](integrations/discord-integration/troubleshooting.md) — Common problems and fixes.
- [discord-control-bot/admin-guide.md](integrations/discord-control-bot/admin-guide.md) — Current, **internal**. Admin guide for the experimental read-only companion bot.
  - [setup-guide.md](integrations/discord-control-bot/setup-guide.md) — Validating the command layer and adapter without a live Discord connection.
  - [user-guide.md](integrations/discord-control-bot/user-guide.md) — Command reference for end users.
  - [api-adapter-contract.md](integrations/discord-control-bot/api-adapter-contract.md) — The protected server-side adapter contract.

## Security

All four docs below describe controls that are still in force; they are marked
historical because they read as point-in-time PR records, not because the
control itself is stale.

- [addon-provenance.md](security/addon-provenance.md) — Historical record. Community addon discovery and code-signing threat model.
- [generated-command-auth-token.md](security/generated-command-auth-token.md) — Historical record. Command auth token generation hardening.
- [login-rate-limit-defense.md](security/login-rate-limit-defense.md) — Historical record. Login rate limiting defense.
- [pre-augmented-gear-grant.md](security/pre-augmented-gear-grant.md) — Historical record. Security review of the pre-augmented gear grant path — see [PRE-AUGMENTED-GEAR.md](console/PRE-AUGMENTED-GEAR.md) for current reference.

## Incidents

- [INC-2026-07-24-STEAMCMD-CDN-OUTAGE.md](incidents/INC-2026-07-24-STEAMCMD-CDN-OUTAGE.md) — Historical record. Post-incident case study: SteamCMD content-host failure.

## Archive

Frozen PR/issue evidence, kept for history. Not maintained; see the linked
current doc for anything still accurate today.

- [blueprints-report.md](archive/blueprints-report.md) — Historical record. Feature spec and test report for PR #80 — see [blueprints.md](console/blueprints.md).
- [PR-EVIDENCE-ADDON-METRICS-SUPPORT.md](archive/PR-EVIDENCE-ADDON-METRICS-SUPPORT.md) — Historical record. PR evidence for the addon metrics stack — see [E2E-METRICS-TESTING.md](runtime/E2E-METRICS-TESTING.md).
- [R1-METRICS-STACK-IMPLEMENTATION-NOTES.md](archive/R1-METRICS-STACK-IMPLEMENTATION-NOTES.md) — Historical record. Implementation notes for issue #82 — see [E2E-METRICS-TESTING.md](runtime/E2E-METRICS-TESTING.md).

## Other

- [operator-guide.md](operator-guide.md) — Current. End-user/operator guide: Web UI feature tour, bases, backups, updates, community addons (including a stated documentation gap on the addon-install UI flow), the Public Server Directory, Discord integration, and multi-server hosting. Cross-links the feature docs above rather than duplicating them.
- [screenshots.md](screenshots.md) — Current. Whole-product screenshot gallery, linked from the root [README](../README.md).
