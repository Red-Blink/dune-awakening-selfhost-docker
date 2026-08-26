# Operator Guide

**Status:** Current | **Last Updated:** August 2026

This is the end-user (server operator) guide to running a Dune: Awakening
server with this project. It assumes you have already completed
installation — see the root [`README.md`](../README.md) for the one-line
installer command and the Requirements/Ports tables. This guide picks up
after that: what the Web UI lets you do, and where to go for detail on
each feature.

This document links to the existing, current feature documentation rather
than duplicating it — where a linked page and this guide ever disagree,
the linked page is authoritative for that feature.

For an engineering-level architecture reference (how the pieces fit
together in code), see
[`docs/architecture/SYSTEM-OVERVIEW.md`](architecture/SYSTEM-OVERVIEW.md)
instead of this guide.

---

## 1. Signing in

After installation, the installer prints the Web UI's URL and a
generated admin password. This single shared password logs you in as the
`owner` tier — the highest privilege level. See
[`docs/console-iam.md`](console-iam.md) if you plan to configure
additional roles/policies rather than sharing the owner password.

**Lost or forgot the password?** It is persisted at
`runtime/secrets/admin-web-password.txt` on the host — read it directly
from there (e.g. `cat runtime/secrets/admin-web-password.txt`) rather than
re-running the installer, which will not restore an original password
once it has been changed via the Settings page's Login Password section.

**Do not expose the Web UI port (`8088` by default) to untrusted users.**
Only forward it to trusted administrators — see the root README's Ports
table.

---

## 2. Web UI feature tour

The screenshots gallery ([`docs/screenshots.md`](screenshots.md)) shows
every major panel; the list below matches its section order and links to
the feature documentation that exists for each area. A "—" in the
Further reading column means the panel is self-explanatory from the Web
UI itself and has no separate written doc yet — file a documentation
issue if you get stuck on one of those.

| Panel | What it's for | Further reading |
|---|---|---|
| Home | Dashboard/overview | — |
| Server Control | Start/stop/restart the server and individual services | [`docs/console/restart-queue.md`](console/restart-queue.md) |
| Players | Player management, kick/ban, inventory actions | [`docs/console/API-REFERENCE.md`](console/API-REFERENCE.md) (Players section) |
| Care Package | Scheduled/manual player reward grants | — |
| Admin Tools | GM/admin toolbox: item grants, XP/skill grants, teleport, broadcasts, scheduled restarts | [`docs/console/restart-queue.md`](console/restart-queue.md) |
| Live Map | Real-time map/player activity view | — |
| Maps | Per-map mode configuration (dynamic / always-on / disabled) | — |
| Landsraad | The in-game faction/political system | — |
| Database | Schema/table browsing, SQL preview/export | — |
| Backups | Database and base backups | §4 below, [`docs/console/database-backups.md`](console/database-backups.md) |
| Updates | Game-server content updates | §5 below |
| Bases (accessed by expanding a base row) | Power, Water, Inventory, Sub-Fief Permissions, Base Permissions tabs | [`docs/console/base-inventory.md`](console/base-inventory.md), [`docs/console/base-permissions.md`](console/base-permissions.md), [`docs/console/base-child-permissions.md`](console/base-child-permissions.md), [`docs/console/base-deletion.md`](console/base-deletion.md) |
| Exchange | Read-only view of the game's live CHOAM market listings | [`docs/console/exchange.md`](console/exchange.md) |
| Addons | Browse, install, enable, and approve permissions for Community Addons | §6 below |
| Settings | Public Server Directory claim, Web Console port, login password | §7 below |

---

## 3. Bases: power, storage, permissions, and deletion

Expanding a base row in the Bases panel gives you these tabs (plus a Land
Claim Editor not covered here):

- **Power** — refill generators/water up to a per-generator-type cap
  ([`docs/console/generator-refill-caps.md`](console/generator-refill-caps.md),
  [`docs/console/generator-fuel-burn-rates.md`](console/generator-fuel-burn-rates.md)).
  Refills are queued and applied on the next safe window — they do not
  necessarily take effect the instant you click.
- **Water** — same refill mechanism as Power, for water-producing devices.
- **Inventory** — a read-only snapshot of everything stored at the base,
  with the ability to open a container and delete individual items. See
  [`docs/console/base-inventory.md`](console/base-inventory.md) for what
  counts as "storage" and the stopped-map safety boundary for deletions.
- **Sub-Fief Permissions** — edit who owns the base and who it's shared
  with. Unlike generator refills, permission changes apply to a running
  map immediately, with no restart required. See
  [`docs/console/base-permissions.md`](console/base-permissions.md).
- **Base Permissions** — a separate list of every individual piece (door,
  device) on the base with its own access level, with the ability to set
  any of them to a specific level; pieces that deviate from the base's
  Sub-Fief default are highlighted. Unlike Sub-Fief Permissions above,
  these do **not** apply to a running map: the game never picks up a
  per-piece access level change while the map is up, so a save against a
  live map is queued and written at that map's next restart. See
  [`docs/console/base-child-permissions.md`](console/base-child-permissions.md).

**Deleting a base** is a separate, row-level action (trash icon) — it is
permanent and irreversible. The console shows a danger-styled confirmation
dialog you must click through, and automatically takes a full database
backup before running the delete. See
[`docs/console/base-deletion.md`](console/base-deletion.md) for exactly
what "the base" means for this operation and why a pending delete freezes
other mutations on that base.

**A base can also disappear from the panel because of the game's own
"pick up base" mechanic**, not because the console deleted anything. A
picked-up base is excluded from the Bases panel and every mutation route
on it (delete, refill, permissions, custodian, auto-refill) returns an
error until the player redeploys it in-game; reads (inventory viewing,
water level, blueprint export) still work. See
[`docs/console/base-backups.md`](console/base-backups.md) — despite the
similar name, this is unrelated to the database Backups page described
next.

---

## 4. Backups

Two unrelated things share the word "backup" in this project — know which
one you need:

1. **Database backups** (the Backups page) — a real backup/restore of the
   whole Postgres database. **If you restore a backup into a deployment
   whose Battlegroup ID differs from the backup's**, the console requires
   you to explicitly choose **Adopt Backup ID** (moving the same server to
   new hardware) or **Keep Current ID** (importing data into a different
   server — characters tied to the backup's ID may not appear in-game).
   An unattended restore with mismatched IDs fails safely before touching
   the database unless one of these is supplied. See
   [`docs/console/database-backups.md`](console/database-backups.md) for
   the full decision matrix and the `dune db restore` CLI equivalents.
2. **The in-game "pick up base" mechanic** — not a console feature at all;
   see §3 above and
   [`docs/console/base-backups.md`](console/base-backups.md).

---

## 5. Updates

There are two independent update mechanisms, both driven from the CLI or
the Web UI's Updates panel — do not confuse them:

- **`dune update`** — updates the **game server** itself (the SteamCMD
  content Funcom ships). Subcommands: `check`, `install`,
  `fix-steamcmd`, `fix-install-dir`, and an unattended option,
  `dune update auto enable [interval-minutes] ...` / `disable` /
  `status`, backed by a systemd timer that runs 5 minutes after boot and
  then repeats on a rolling interval (default: every 60 minutes,
  configurable via the first argument to `auto enable`).
- **`dune self-update`** (alias `dune stack-update`) — updates **this
  repository/stack itself** (fetching a new GitHub release of
  `dune-awakening-selfhost-docker`). Subcommands: `check`, `list`,
  `install [latest|<tag>]`. As of this writing, self-update has no
  automated/scheduled equivalent to `dune update auto` — it is a manual,
  operator-triggered action.

---

## 6. Community Addons

The root README describes the capability: "Community Addons provide
optional tools that can be installed and managed from the Web UI. Addons
declare their permissions before installation, and updates preserve their
settings and require approval for any new permissions." Addon developers
can start from the
[Official Addon Template](https://github.com/Red-Blink/dune-docker-addon-template).

An addon can only ever request a permission from a fixed, platform-defined
list (things like read-only player/database access, granting items,
restarting the server, or sending broadcasts) — it cannot invent new
capabilities. Installing an addon does **not** automatically grant it any
requested permission; you approve each permission explicitly, and an
addon update that adds a new permission request needs your approval again
before it can use it.

> **Documentation gap, stated explicitly rather than guessed at:** as of
> this writing, no document in this repository describes the exact
> click-by-click Web UI flow for browsing, installing, enabling, or
> approving permissions for a Community Addon. If you need this, use the
> Web UI directly (the feature lives under the Addons/Settings area) or
> file a documentation issue.
> The developer-facing side of the addon contract (manifest format,
> permission list, provenance/integrity checks) is documented in
> [`docs/addons/addon-item-grants.md`](addons/addon-item-grants.md),
> [`docs/addons/addon-scheduled-jobs.md`](addons/addon-scheduled-jobs.md),
> [`docs/addons/hardware-status.md`](addons/hardware-status.md), and
> [`docs/security/addon-provenance.md`](security/addon-provenance.md).

---

## 7. Public Server Directory (DuneDocker.app)

[DuneDocker.app](https://dunedocker.app/) is an optional public listing
service. From the **Console Settings page** you can:

- Claim your server's listing to verify ownership.
- Manage your public profile and Discord invite link.
- Enable or disable the public listing at any time.

Local and LAN-only servers are never listed. By default, installations
contribute only an anonymous server count (never server names, addresses,
players, or settings) to the directory even if you don't claim a listing;
this anonymous count can also be disabled separately in Settings. There is
no dedicated deep-dive document for this feature beyond the root
[`README.md`](../README.md)'s "Public Server Directory" section and this
summary — treat those two as the complete current documentation for it.

---

## 8. Discord integration

Two separate things exist under the "Discord" name — use the right one:

- **The Discord adapter** (current, operator-facing) — lets you connect a
  companion Discord bot,
  [`yacketrj/dune-awakening-selfhost-discordbot`](https://github.com/yacketrj/dune-awakening-selfhost-discordbot),
  for server monitoring; its slash commands are organized into 6 groups
  (`core`, `server`, `data`, `ops`, `admin`, `infra`) — see the linked
  README below for the current, authoritative command list and count. The
  adapter is disabled by default, read-only unless you separately enable
  write commands, bearer-token protected, and role-gated. Start with
  [`docs/integrations/discord-integration/README.md`](integrations/discord-integration/README.md);
  the guided, screenshot-illustrated walkthrough is
  [`docs/integrations/discord-integration/admin-guide.md`](integrations/discord-integration/admin-guide.md);
  common problems are in
  [`docs/integrations/discord-integration/troubleshooting.md`](integrations/discord-integration/troubleshooting.md)
  and [`docs/integrations/discord-integration/faq.md`](integrations/discord-integration/faq.md).
- **The `discord-control-bot`** — a separate, **experimental, internal,
  read-only** companion project. It cannot write to your database, mutate
  players/maps/addons, or send broadcasts — the console remains the sole
  authority for any action it triggers. Only use this if you specifically
  need it; start with
  [`docs/integrations/discord-control-bot/admin-guide.md`](integrations/discord-control-bot/admin-guide.md).

---

## 9. Running multiple servers behind one public IP

If you want to run more than one independent battlegroup (e.g. separate
production and test servers) sharing a single public IPv4 address, this
requires one isolated VM per battlegroup (each with its own Docker daemon
and a fully distinct set of host ports) plus matching router/NAT rules.
This is a real, supported, but advanced configuration with a dedicated
automation helper:

```sh
python3 runtime/scripts/multi-server-config.py plan --instances 3
```

See [`docs/runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md`](runtime/MULTI-SERVER-SINGLE-PUBLIC-IP.md)
for the full port-profile tables, the non-negotiable no-port-overlap rule,
and the `plan` / `apply` / `verify` workflow. Do not attempt this by
manually editing `.env` port variables without reading that document first
— the port-overlap constraints are stricter than normal OS socket rules.

---

## 10. Getting help

- [Official Website](https://dunedocker.app/) — project info, FAQ, server directory.
- [Discord Community](https://discord.gg/duneawakeningdocker) — support and discussion.
- [`docs/README.md`](README.md) — the full documentation index, including
  every feature/security/incident document referenced above.
- GitHub Issues on this repository — bug reports and documentation gaps
  (including the addon-UI gap noted in §6).

---

## Related documents

- [`docs/architecture/SYSTEM-OVERVIEW.md`](architecture/SYSTEM-OVERVIEW.md) — engineering architecture reference.
- [`docs/README.md`](README.md) — full documentation index.
