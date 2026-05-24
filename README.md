# Dune Awakening Self-Host Docker

![Docker](https://img.shields.io/badge/Docker-ready-brightgreen)
![Linux](https://img.shields.io/badge/Linux-supported-brightgreen)
![Self--Hosted](https://img.shields.io/badge/Self--Hosted-yes-brightgreen)
![GitHub](https://img.shields.io/badge/GitHub-Red--Blink-blue)
![Status](https://img.shields.io/badge/Status-experimental-orange)
![License](https://img.shields.io/badge/License-MIT-brightgreen)

A RedBlink community project for running Dune: Awakening self-host servers with Docker.

This project provides a simple `dune` command and an interactive manager for running a self-host server without remembering every script.

This is an unofficial community project. It is not affiliated with, endorsed by, sponsored by, or supported by Funcom.

## Requirements

| Requirement | Notes |
|---|---|
| Linux Server | Ubuntu 24.04.4 LTS |
| Docker Engine | Required |
| Docker Compose | Required |
| Funcom Self-host token | Required |
| Disk space | 100 GB+ |
| RAM | See Guide Below |
| CPU Features | AVX and AVX2 required |

### RAM Sizing Guide

| Server Layout | Recommended RAM |
|---|---:|
| Basic Hagga Basin / Sietch Layout | 20 GB |
| Hagga Basin plus Story/Social Maps | 30 GB |
| Hagga Basin plus Story/Social Maps + Deep Desert | 40 GB |

## Install

```bash
git clone https://github.com/Red-Blink/dune-awakening-selfhost-docker.git
cd dune-awakening-selfhost-docker
sudo runtime/scripts/install-command.sh
```

Start by deploying the stack and creating the local world:

```bash
dune init
```

`dune init` is the first step. It creates the local config, saves your Funcom token, generates the battlegroup ID, deploys the stack, applies the database/world setup, and starts the services.

If `dune init` says `docker: command not found`, install Docker Engine first.

If Docker is installed but `dune init` says the Docker daemon is not reachable, make sure Docker is running and that your user can access it:

```bash
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
newgrp docker
```

After `dune init` finishes, use the friendly menu:

```bash
dune manager
```

The manager is organized around the main jobs most hosts need:

| Menu | What It Does |
|---|---|
| Battlegroup Overview | Status, readiness, version, containers, and ports |
| Battlegroup Settings | Battlegroup name, Start, Stop, Restart, Scheduled Restart, Redeploy, dynamic maps, autoscaler, database maintenance, and current config |
| Sietches | Map list, current map memory usage, and supported map settings |
| Updates | Installed versions, runtime files status/repair, stack update checks, game server update checks, and automatic game updates |
| Logs | Redacted logs for the main services |
| Advanced Tools | Diagnostics and safe low-level details |

When starting or restarting from the manager, the configured player-facing IP is checked first. If your public or LAN IP changed, the manager asks before updating `.env` and continuing.

Manager menus use a colored `[X]` selector in interactive terminals. Use Up and Down to move, Enter to select, and the explicit Back items to return. Ctrl+C exits normal menu screens cleanly; inside an input prompt it cancels the current action without saving changes. Plain numbered menus are used automatically when the terminal is not interactive.

Running `dune init` again later resets the local database/world after backing up local state.

If map containers fail immediately with `Illegal instruction (core dumped)`, the host CPU exposed to the machine is usually missing `avx` and `avx2`. This is common with misconfigured VMs. It cannot be fixed with a package inside Ubuntu; the hypervisor must expose those CPU features to the guest.

## Public vs Local/LAN

| Mode | Who can connect? | Notes |
|---|---|---|
| Public / Internet | Players over the internet | Requires public-facing network access. See the Ports section below. |
| Local / LAN | Players on the same network | No internet port forwarding expected. |

## Ports

Open or forward these ports when hosting a public / internet server:

| Port | Protocol | Purpose |
|---|---|---|
| `31982` | TCP | RabbitMQ game TLS |
| `31983` | TCP | RabbitMQ game HTTP |
| `7777` | UDP | Overmap client traffic |
| `7778` | UDP | Survival_1 client traffic |
| `7779-7810` | UDP | Dynamic map client traffic |
| `7888` | UDP | Survival_1 server-to-server traffic |
| `7889` | UDP | Overmap server-to-server traffic |
| `7890-7921` | UDP | Dynamic map server-to-server traffic |

These ports are not meant to be opened publicly:

| Port | Protocol | Purpose |
|---|---|---|
| `15432` | TCP | Postgres localhost |
| `32573` | TCP | RabbitMQ admin localhost |
| `5059` | TCP | TextRouter localhost |
| `11717` | TCP | Director localhost |

## Common Commands

| Command | Purpose |
|---|---|
| `dune manager` | Interactive control panel |
| `dune init` | Fresh setup / reset setup |
| `dune start` | Start the battlegroup and autoscaler |
| `dune stop` | Stop the battlegroup and autoscaler |
| `dune ready` | Quick OK / WAIT / FAIL readiness check |
| `dune status` | Safe dashboard summary |
| `dune doctor` | Troubleshooting checks with suggested fixes |
| `dune version` | Launcher, git, build, image, and config summary |
| `dune logs <service>` | Redacted service logs |
| `dune restart <service>` | Restart one service |

`dune ready` is the fast health check. `dune status` is the fuller dashboard.

## Logs

Default logs are redacted for common tokens and IDs:

```bash
dune logs survival
dune logs director
dune logs gateway
dune logs text-router
dune logs rmq-game
```

Raw logs are available with `--raw`, but may contain sensitive data:

```bash
dune logs director --raw
```

## Updates

```bash
dune self-update check
dune self-update install latest
dune update check
dune update
dune update --yes
dune update auto enable
dune update auto disable
dune update auto status
```

`dune self-update` is for this self-host stack itself. `dune update` is for Funcom game server files and images. Automatic updates apply only to game server updates and use a systemd timer when systemd is available.

For stack updates, publish a GitHub Release from the same commit that contains the matching `VERSION` value. The updater validates that the downloaded release tag and extracted `VERSION` file agree.
If local tracked project files were edited, the stack updater warns and still continues after backing up the current project files first.

In the manager, `Updates` also includes `Runtime Files Status` and `Repair Runtime Files`. Use these when generated map catalogs are missing and `Edit Map` cannot open the picker. The repair action rebuilds the generated catalogs from the installed server files without running `dune init`, and if the battlegroup services are not running it starts them automatically afterward.

## Autoscaler And Dynamic Maps

Always-on maps:

| Map | Status |
|---|---|
| Survival_1 | Always running |
| Overmap | Always running |

Autoscaler commands:

```bash
dune autoscaler status
dune autoscaler start
dune autoscaler stop
dune autoscaler restart
dune autoscaler logs
dune servers
```

The autoscaler starts with `dune start` so maps can be deployed automatically when players travel to dynamic regions.

Dynamic maps use the port ranges listed in the Ports section.

`Survival_1` and `Overmap` are always-on protected maps. The manager will not stop them from the dynamic maps menu.

## Database Backups

```bash
dune db backup
dune db list
dune db status
dune db delete dune-db-<scope>__YYYYMMDD-HHMMSS.dump
dune db delete dune-db-<scope>-YYYYMMDD-HHMMSS.backup
dune db delete --all
dune db import runtime/backups/db/<backup-file>.backup
dune db restore runtime/backups/db/<backup-file>.backup
dune db auto enable 12
dune db auto enable 1 7
dune db auto retention 7
dune db auto retention off
dune db auto disable
dune db auto status
```

`dune-docker` writes official-style `.backup` files with a `.backup.yaml` sidecar under `runtime/backups/db/`. These backups do not include Funcom tokens or secret files. The backup artifact keeps a scope-aware name so battlegroup and map context are still identifiable later.

Import and restore accept official Funcom-style `.backup` files plus older `dune-db-*.dump` and `.sql` backups. Import/restore replaces the current battlegroup database state, requires confirmation, and creates a pre-import backup first.

In the manager, `Import Database Backup` has two paths:

- `Import Local Backup File` prompts for a local file path, copies the selected `.backup`, `.dump`, or `.sql` file into `runtime/backups/db/`, copies `<file>.yaml` when present, then runs the normal restore confirmation flow.
- `Import Remote Backup Over SSH` prompts for the remote host or IP, SSH user, SSH port, and remote backup directory. It requires both `ssh` and `scp`, lists remote `.backup` files, copies the selected backup into `runtime/backups/db/`, copies `<file>.yaml` when present, then runs the same restore confirmation flow locally.

Automatic backups use a systemd timer when systemd is available. Optional retention keeps backups from the last X days, for example `dune db auto enable 1 7` backs up hourly and keeps the last 7 days.

In the manager, database maintenance includes `Create Database Backup`, `Import Database Backup`, `Restore A Database Backup`, `Delete A Backup`, `Delete All Backups`, and `Automatic Database Backups`. Restore and delete flows show available backups first. `Import Database Backup` supports local files and remote SSH imports, and carries the `.yaml` sidecar along when present. Deleting backups is permanent.

## Battlegroup And Sietch Settings

Change or show the battlegroup title:

```bash
dune config title
dune config title "My New Server Name"
```

Changing the title restarts only the Gateway service, which publishes the browser-facing server name.

Configure memory for maps/servers:

```bash
dune memory status
dune memory list-maps
dune memory set survival 12g
dune memory set overmap 8g
dune memory set default 8g
dune memory set DeepDesert_1 10g
dune memory unset DeepDesert_1
```

Use `dune memory list-maps` or the manager to choose from known maps instead of memorizing internal names. Changing or removing a map memory setting asks for confirmation; if that map is running, only that map restarts so the new limit can apply. Default memory applies to future spawned/restarted maps and does not restart running maps.

The manager's Sietches area lists maps from the current world partition state when Postgres is running, with the generated map catalogs as a fallback:

```bash
dune sietches list
dune sietches show Survival_1
```

Inside Sietches, use `List Maps`, `Edit Map`, and `Current Memory Usage`. The current memory view shows live memory usage for running map containers and automatically reflects dedicated maps as they spawn and despawn. In the manager, `Survival_1` supports memory, display name, and password. All other maps, including `Overmap`, are memory-only in the manager. Passwords are stored locally under `runtime/generated/` and are never displayed.

`dune sietches` still provides the backend controls for max dimensions and active dimensions, but those controls are intentionally not exposed in the manager for this version.

For `Survival_1`, display name and password changes are applied immediately by restarting `Survival_1`, `director`, and `gateway`, then republishing the browser-facing state. `Overmap` is protected and only supports memory changes. Dedicated scaling maps have active dimensions managed by the autoscaler at runtime.

If a map setting fails validation or cannot be saved, the manager does not ask to restart that map.

## Runtime Files

| Path | Purpose |
|---|---|
| `.env` | Local server settings |
| `runtime/secrets/` | Local secrets, including Funcom token |
| `runtime/generated/` | Generated battlegroup, image tags, catalogs, state |
| `runtime/backups/` | Init and database backups |

These paths are ignored by git.

If `runtime/generated/partition-catalog.json` and `runtime/generated/server-catalog.json` are missing, map-selection flows in the manager cannot build the map picker. Use `dune manager` -> `Updates` -> `Runtime Files Status` to verify, then `Repair Runtime Files` to rebuild them non-destructively. If the battlegroup is currently stopped, the repair action also starts it afterward.

## Security

Your Funcom token and service credentials are sensitive.

Do not share:

- `runtime/secrets/`
- raw logs containing `ServiceAuthToken`
- raw logs containing `GameRmqSecret`
- screenshots or dumps containing player/friend identifiers

If a token is exposed, rotate it from your Funcom self-host account page.

This repository does not include Funcom game files, Docker image tarballs, tokens, secrets, or proprietary assets. Server files and images are downloaded or loaded at runtime by the user's own environment.

## Project Identity

This project is created and maintained as a RedBlink community project.

Please keep the LICENSE and NOTICE files intact when redistributing or modifying this project.

This project is not affiliated with, endorsed by, sponsored by, or supported by Funcom.

## License

This project is licensed under the MIT License.

See LICENSE and NOTICE for details.
