# Windows / WSL Install Guide

This guide covers the PowerShell installers for running Dune Docker Console on **Windows via WSL2**. Container workloads run **inside the WSL distro** (Docker Engine installed in WSL by default). This does **not** use Docker Desktop or Podman Desktop on Windows.

## Overview

| Item | Location / name |
|------|-----------------|
| Windows installer | [`install.ps1`](install.ps1) |
| Windows updater | [`update.ps1`](update.ps1) |
| WSL install state | `.wsl/install.json` (gitignored) |
| WSL distro data | `.wsl/distro/Debian_Dune/` (default) |
| Default WSL distro name | `Debian_Dune` |
| Default container runtime | **Docker Engine** inside WSL |
| Web UI (from Windows) | **http://localhost:8088** |

Flow:

1. `install.ps1` provisions WSL2 Debian as `Debian_Dune`, creates your Linux user, enables systemd.
2. `wsl-bootstrap.sh` prepares the chosen container runtime inside WSL.
3. `install.sh` installs Docker (or Podman if opted in), builds the console container, and starts the Web UI.

## Prerequisites

- Windows 10/11 with **WSL2** enabled
- This repository cloned to a Windows path (e.g. `D:\workspace\dune-awakening-selfhost-docker`)
- PowerShell 5.1+

## Quick start

From the repository root in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

On first run you will be prompted for a **WSL username and password** (unless you pass `-WslUser` / `-WslPassword`).

Open the Web UI from **Windows**:

```
http://localhost:8088
```

Use `localhost`, not the WSL internal IP (e.g. `172.x.x.x`). WSL2 forwards the port to Windows when the console container is running.

## install.ps1

Main Windows installer. Run from the repo root.

### Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `-WslDistro` | `Debian_Dune` | Registered WSL distribution name (`wsl -l`) |
| `-WslDistroDir` | `.wsl/distro/Debian_Dune` | Where WSL stores the distro (under repo) |
| `-WslUser` | (prompt) | Linux user created inside WSL |
| `-WslPassword` | (prompt) | Password for that user (never saved to disk) |
| `-WorkspaceDir` | `.` | Repo mount path inside WSL; use `.wsl/workspace` for a nested clone |
| `-ContainerRuntime` | `docker` | `docker` or `podman` — engine **inside WSL** |
| `-RepoUrl` | GitHub URL | Used when `-WorkspaceDir .wsl/workspace` clones the repo |
| `-SkipWslInstall` | off | Skip WSL package install if distro already exists |
| `-Update` | off | Git pull only (same as `update.ps1` default) |

### Examples

```powershell
# First install with explicit credentials
.\install.ps1 -WslUser local -WslPassword 'your-secure-password'

# Opt in to Podman inside WSL instead of Docker
.\install.ps1 -ContainerRuntime podman

# Re-run after clone (reads .wsl/install.json)
.\install.ps1

# Git pull only
.\install.ps1 -Update
```

### What install.ps1 does

1. Creates `.wsl/` for local state (gitignored).
2. Installs/registers Debian WSL as `Debian_Dune` under `.wsl/distro/`.
3. Creates the WSL user, passwordless sudo for install tasks, enables **systemd** in `/etc/wsl.conf`.
4. Runs `wsl-bootstrap.sh` then `install.sh` inside WSL with `DUNE_CONTAINER_RUNTIME` set.
5. Writes `.wsl/install.json` and prints the admin password + **http://localhost:8088**.

## update.ps1

Pulls latest git changes. Container rebuild is **optional**.

```powershell
.\update.ps1                      # git pull only
.\update.ps1 -RebuildConsole      # rebuild Web UI container
.\update.ps1 -RebuildOrchestrator # rebuild orchestrator
.\update.ps1 -FullStack           # both rebuilds
```

Uses `containerRuntime` from `.wsl/install.json` (default `docker`).

## .wsl/install.json

Written by `install.ps1`. Example fields:

| Field | Purpose |
|-------|---------|
| `wslDistro` | WSL distribution name |
| `wslDistroInstallDir` | Windows path to distro root |
| `wslUser` | Linux install user |
| `containerRuntime` | `docker` or `podman` |
| `repoRootWindows` / `repoRootWsl` | Repository paths |
| `workspaceDirWsl` | Where `install.sh` runs |
| `installedAt` | ISO timestamp |

The WSL password is **never** stored.

## Container runtime

### Docker (default)

- Docker Engine is installed **inside WSL** via `install.sh` (get.docker.com).
- Uses `docker compose` and `/var/run/docker.sock`.
- Does not require Docker Desktop on Windows.

### Podman (opt-in)

```powershell
.\install.ps1 -ContainerRuntime podman
```

Uses Podman packages, socket setup, and `podman-compose` on WSL. Only choose this if you have a specific reason; Docker is the supported default.

### Switching runtimes

```powershell
# Move to Docker
.\install.ps1 -ContainerRuntime docker

# Stay on Podman
.\install.ps1 -ContainerRuntime podman
```

You may need to remove a stale console container once when switching:

```bash
docker rm -f redblink-dune-docker-console    # or podman rm -f ...
```

## Accessing the Web UI

| From | URL |
|------|-----|
| Windows browser | **http://localhost:8088** |
| Inside WSL only | `http://127.0.0.1:8088` or WSL eth IP |

The installer prints an admin password from `runtime/secrets/admin-web-password.txt`.

## Troubleshooting

### localhost:8088 does not load

1. Check the container inside WSL:

   ```bash
   docker ps
   # or: podman ps
   ```

2. If missing, start manually:

   ```bash
   cd /mnt/d/path/to/dune-awakening-selfhost-docker
   export ADMIN_BIND_HOST=0.0.0.0 ADMIN_BIND_PORT=8088
   docker compose -f docker-compose.web.yml up -d --build --force-recreate redblink-dune-docker-console
   ```

3. Wait for the image build to finish (first run can take several minutes).

### sudo: a password is required

Re-run `.\install.ps1` so it can configure passwordless sudo for the install user (`enable-wsl-install-sudo.sh`).

### systemd not running

Ensure `/etc/wsl.conf` contains:

```ini
[boot]
systemd=true
```

Then from Windows: `wsl --shutdown`, reopen WSL, run `install.ps1` again.

### Stale container name

```bash
docker rm -f redblink-dune-docker-console
```

### WSL logs

Install steps are appended to `.wsl/install.log`.

## Related files

| File | Role |
|------|------|
| [`install.sh`](install.sh) | Linux installer (called from WSL) |
| [`runtime/scripts/wsl-bootstrap.sh`](runtime/scripts/wsl-bootstrap.sh) | WSL preflight + runtime prep |
| [`runtime/scripts/ensure-podman-socket.sh`](runtime/scripts/ensure-podman-socket.sh) | Compose startup helpers (Docker and Podman paths) |
| [`docker-compose.web.yml`](docker-compose.web.yml) | Web UI service definition |

For Linux server installs (non-Windows), use [`install.sh`](install.sh) directly — see the main [README.md](README.md).
