# Windows / WSL Install Guide

**New here?** Follow the [simple checklist](#start-here-simple-checklist) first. If anything fails, the installer prints numbered steps — do them in order, then run `install.ps1` again.

This guide covers the PowerShell installers for running Dune Docker Console on **Windows via WSL2**. Container workloads are started **from inside** the `Debian_Dune` WSL distro using **Docker Desktop** via WSL integration (recommended by Docker for WSL). Containers and images appear in the **Docker Desktop UI**. Advanced opt-in: embedded Docker Engine (`-ContainerRuntime docker`) or Podman.

## Start here (simple checklist)

Do these in order. Use **Run as administrator** for PowerShell when possible.

1. **Install [Docker Desktop](https://www.docker.com/products/docker-desktop/)** for Windows and start it. Wait until it says running (whale icon in the system tray).
2. **Turn on WSL integration** in Docker Desktop: Settings (gear) → General → **Use the WSL 2 based engine** → Resources → **WSL Integration** → enable **`Debian_Dune`** → Apply & restart.
3. **Open PowerShell as Administrator** (Start menu → type PowerShell → right-click → Run as administrator).
4. **Go to this project folder** (where `install.ps1` lives):

   ```powershell
   cd D:\path\to\dune-awakening-selfhost-docker
   ```

5. **Run the installer:**

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

6. When it finishes, **open in your browser:** http://localhost:8088  
   Use **localhost** only — not a `172.x.x.x` address.
7. **Sign in** with the password the installer prints and complete the setup wizard.

**Something broke?** Read the yellow/green boxes the installer printed. Full help is below in [Troubleshooting](#troubleshooting). Log file: `.wsl/install.log`.

## Overview

| Item | Location / name |
|------|-----------------|
| Windows installer | [`install.ps1`](install.ps1) |
| Windows updater | [`update.ps1`](update.ps1) |
| WSL install state | `.wsl/install.json` (gitignored) |
| WSL distro data | `.wsl/distro/Debian_Dune/` (default) |
| Default WSL distro name | `Debian_Dune` |
| Default container runtime | **Docker Desktop** (required unless you opt in to embedded Engine or Podman) |
| Docker Desktop UI | Containers/images visible when using the `docker-desktop` backend |
| Web UI (from Windows) | **http://localhost:8088** |

Flow:

1. `install.ps1` provisions WSL2 Debian as `Debian_Dune`, creates your Linux user, enables systemd.
2. If Docker Desktop is installed: verify WSL integration for `Debian_Dune` (one-time in Docker Desktop settings).
3. `wsl-bootstrap.sh` prepares the chosen container runtime (Desktop integration, embedded Engine, or Podman).
4. When switching to Docker Desktop, embedded `docker.service` inside WSL is stopped/disabled automatically.
5. `install.sh` builds the console container and starts the Web UI.

## Prerequisites

- Windows 10/11 with **WSL2** enabled
- This repository cloned to a Windows path (e.g. `D:\workspace\dune-awakening-selfhost-docker`)
- PowerShell 5.1+
- **[Docker Desktop](https://www.docker.com/products/docker-desktop/)** for Windows with the WSL 2 backend — [WSL integration docs](https://docs.docker.com/desktop/features/wsl/)

If Docker Desktop is not installed, `install.ps1` stops with download instructions instead of installing Docker Engine inside WSL automatically.

## Quick start

From the repository root in PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

On first run you will be prompted for a **WSL username and password** (unless you pass `-WslUser` / `-WslPassword`).

If Docker Desktop is installed, enable WSL integration for `Debian_Dune` before or when the installer prompts you (see [Docker Desktop WSL integration](#docker-desktop-wsl-integration-one-time-setup) below).

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
| `-ContainerRuntime` | *(auto)* | See [Container runtime](#container-runtime) |
| `-RepoUrl` | GitHub URL | Used when `-WorkspaceDir .wsl/workspace` clones the repo |
| `-SkipWslInstall` | off | Skip WSL package install if distro already exists |
| `-Update` | off | Git pull only (same as `update.ps1` default) |

**`-ContainerRuntime` values**

| Value | Meaning |
|-------|---------|
| *(auto)* | **Docker Desktop** via WSL integration (`docker-desktop`); installer stops if Desktop is missing |
| `docker-desktop` | Force Docker Desktop backend (containers visible in Docker Desktop UI) |
| `docker` | **Opt-in only:** embedded Docker Engine inside WSL (not visible in Docker Desktop UI) |
| `podman` | Podman inside WSL |

### Examples

```powershell
# First install with explicit credentials
.\install.ps1 -WslUser local -WslPassword 'your-secure-password'

# Force embedded Docker Engine in WSL (opt out of Docker Desktop)
.\install.ps1 -ContainerRuntime docker

# Force Docker Desktop backend explicitly
.\install.ps1 -ContainerRuntime docker-desktop

# Opt in to Podman inside WSL instead of Docker
.\install.ps1 -ContainerRuntime podman

# Re-run after clone (reads .wsl/install.json)
.\install.ps1

# Git pull only
.\install.ps1 -Update
```

### What install.ps1 does

1. Creates `.wsl/` for local state (gitignored).
2. Checks Windows/WSL2 support and installs WSL if needed.
3. Installs/registers Debian WSL as `Debian_Dune` under `.wsl/distro/`.
4. Creates the WSL user, passwordless sudo for install tasks, enables **systemd** in `/etc/wsl.conf`.
5. Auto-detects Docker Desktop and selects the `docker-desktop` backend when available.
6. Verifies Docker Desktop WSL integration for `Debian_Dune` when using `docker-desktop`.
7. Runs `wsl-bootstrap.sh` then `install.sh` inside WSL with `DUNE_CONTAINER_RUNTIME` set.
8. Stops/disables embedded `docker.service` when migrating to Docker Desktop.
9. Writes `.wsl/install.json` and prints the admin password + **http://localhost:8088**.

## update.ps1

Pulls latest git changes. Container rebuild is **optional**.

```powershell
.\update.ps1                      # git pull only
.\update.ps1 -RebuildConsole      # rebuild Web UI container
.\update.ps1 -RebuildOrchestrator # rebuild orchestrator
.\update.ps1 -FullStack           # both rebuilds
```

Uses `containerRuntime` from `.wsl/install.json` (default `docker` or `docker-desktop` after install).

## .wsl/install.json

Written by `install.ps1`. Example fields:

| Field | Purpose |
|-------|---------|
| `wslDistro` | WSL distribution name |
| `wslDistroInstallDir` | Windows path to distro root |
| `wslUser` | Linux install user |
| `containerRuntime` | `docker-desktop`, `docker`, or `podman` |
| `repoRootWindows` / `repoRootWsl` | Repository paths |
| `workspaceDirWsl` | Where `install.sh` runs |
| `installedAt` | ISO timestamp |

The WSL password is **never** stored.

## Container runtime

### Docker Desktop (default — required on Windows)

- **Required** for the default Windows/WSL install path.
- If Docker Desktop is not detected, `install.ps1` stops and points you to [download Docker Desktop](https://www.docker.com/products/docker-desktop/).
- Uses Docker Desktop’s daemon via **WSL integration** — containers and images show in the Docker Desktop UI.
- Does **not** install `docker-ce` inside WSL via get.docker.com on the default path.
- Stops/disables embedded `docker.service` if it was running from a prior install.
- Requires one-time WSL integration setup (below).

### Embedded Docker Engine (advanced opt-in)

```powershell
.\install.ps1 -ContainerRuntime docker
```

- Only when you **explicitly** pass `-ContainerRuntime docker`.
- Installs Docker Engine **inside WSL** via `install.sh` (get.docker.com).
- Uses `docker compose` and `/var/run/docker.sock` on the in-WSL daemon.
- **Separate** from Docker Desktop — containers will **not** appear in the Docker Desktop UI.
- Not used automatically when Docker Desktop is missing.

### Podman (opt-in)

```powershell
.\install.ps1 -ContainerRuntime podman
```

Uses Podman packages, socket setup, and `podman-compose` on WSL. Only choose this if you have a specific reason.

### Docker Desktop WSL integration (one-time setup)

Required when using the `docker-desktop` backend:

1. Install and **start Docker Desktop**; wait until the engine is running.
2. **Settings → General → Use the WSL 2 based engine** (enabled).
3. **Settings → Resources → WSL Integration → enable `Debian_Dune`**.
4. If the WSL Integration tab is missing: Docker tray icon → **Switch to Linux containers**.
5. Verify from PowerShell:

   ```powershell
   wsl -d Debian_Dune -- docker info --format '{{.OperatingSystem}}'
   ```

   Expected output contains `Docker Desktop`.

Official guide: https://docs.docker.com/desktop/features/wsl/

### Switching runtimes

```powershell
# Use Docker Desktop (default)
.\install.ps1 -ContainerRuntime docker-desktop

# Use embedded Docker Engine in WSL
.\install.ps1 -ContainerRuntime docker

# Use Podman
.\install.ps1 -ContainerRuntime podman
```

When switching, you may need to remove a stale console container once:

```bash
docker rm -f redblink-dune-docker-console    # or podman rm -f ...
```

If moving from embedded Docker to Docker Desktop, the installer stops embedded `dockerd` automatically. To do it manually:

```bash
sudo systemctl stop docker
sudo systemctl disable docker
```

## Accessing the Web UI

| From | URL |
|------|-----|
| Windows browser | **http://localhost:8088** |
| Inside WSL only | `http://127.0.0.1:8088` or WSL eth IP |
| Docker Desktop UI | Containers / Images tabs (when using `docker-desktop`) |

The installer prints an admin password from `runtime/secrets/admin-web-password.txt`.

## Troubleshooting

### Docker Desktop not installed

`install.ps1` does not fall back to embedded Docker Engine on the default path. Install Docker Desktop:

1. Download from [docker.com/products/docker-desktop](https://www.docker.com/products/docker-desktop/)
2. Install and start Docker Desktop
3. Complete [WSL integration setup](#docker-desktop-wsl-integration-one-time-setup)
4. Re-run `.\install.ps1`

### Containers not visible in Docker Desktop

1. Confirm runtime is `docker-desktop` in `.wsl/install.json` (or re-run `.\install.ps1` without `-ContainerRuntime docker`).
2. Enable WSL integration for **`Debian_Dune`** in Docker Desktop → Settings → Resources → WSL Integration.
3. Check embedded dockerd is not still running inside WSL:

   ```bash
   systemctl status docker
   ```

   If active, run `.\install.ps1` again or stop/disable manually (see [Switching runtimes](#switching-runtimes)).
4. Confirm Docker Desktop is in **Linux containers** mode (tray icon).
5. Verify integration:

   ```powershell
   wsl -d Debian_Dune -- docker info --format '{{.OperatingSystem}}'
   ```

### Docker Desktop WSL integration failed

Follow the steps in [Docker Desktop WSL integration](#docker-desktop-wsl-integration-one-time-setup). The installer prints self-help with links when integration is missing. See also https://docs.docker.com/desktop/features/wsl/

### Both Docker Desktop and embedded Engine were running

This causes split visibility — Desktop shows only its own daemon’s containers. Re-run `.\install.ps1` to migrate to Docker Desktop (embedded `docker.service` is stopped/disabled). Or manually:

```bash
sudo systemctl stop docker
sudo systemctl disable docker
```

Then enable WSL integration and re-run the installer.

### Players stuck on Connecting (Docker Desktop networking)

If your server appears in the in-game browser but players get stuck on **Connecting**, Windows may be routing traffic through the wrong virtual network adapter.

This often happens when Hyper-V, VMware, WSL2, or Docker Desktop create multiple virtual adapters — especially when **VMware Bridge Protocol** is enabled on the wrong adapter.

#### Expected setup on Docker Desktop + WSL

A common working configuration:

| Role | Typical IP | Notes |
|------|------------|--------|
| Game server **bind** (`SERVER_BIND_IP`) | Docker Desktop host-network IP, e.g. `192.168.65.3` | Where game sockets listen (auto-detected via [`runtime-env.sh`](runtime/scripts/runtime-env.sh) on Docker Desktop) |
| Server **advertised** to clients (`SERVER_IP`) | WSL/Linux IP, e.g. `172.x.x.x` | What clients use to connect |
| RabbitMQ | Reachable on the WSL/Linux side | See `DUNE_RMQ_*` overrides in [`.env.example`](.env.example) if needed |

The installer and runtime scripts try to detect Docker Desktop bind IPs automatically. If routing is wrong, fix adapters first (below), then verify IPs.

#### Fix Windows network adapters

When you run `install.ps1` **as Administrator** with the Docker Desktop runtime, it automatically **disables VMware Bridge Protocol** on Hyper-V `vEthernet` adapters (including **vEthernet (Default Switch)**) if that binding is enabled.

Manual fix if you are not elevated, VMware is not installed, or the automatic step could not run:

1. Open **Control Panel → Network and Internet → Network Connections** (or `ncpa.cpl`).
2. Right-click **vEthernet (Default Switch)** → **Properties**.
3. **Uncheck VMware Bridge Protocol** (if present) → **OK**.
4. Repeat for other virtual adapters if VMware/Hyper-V conflicts persist — VMware Bridge should not be bound to adapters used by Docker Desktop/WSL unless you know you need it.
5. **Restart Docker Desktop**.
6. Restart WSL from PowerShell:

   ```powershell
   wsl --shutdown
   ```

7. Start the Dune Docker stack again (Web UI setup wizard or `./runtime/scripts/dune` commands).

#### Verify routing (inside WSL)

From your repo directory in WSL:

```bash
ip -4 route get 1.1.1.1

docker run --rm --network host --entrypoint sh redblink-dune-docker-console:dev \
  -c 'ip -4 route get 1.1.1.1'
```

Compare the `src` IPs. The host-network container route should reflect the Docker Desktop bind path; the WSL route should reflect the Linux side used for advertised connectivity and RabbitMQ.

#### Restart game services (inside WSL)

If routing looks correct after the restarts above:

```bash
runtime/scripts/start-rabbitmq.sh
./runtime/scripts/dune restart director
./runtime/scripts/dune restart gateway
./runtime/scripts/dune restart text-router
./runtime/scripts/dune restart survival
./runtime/scripts/dune restart overmap
```

#### Readiness checks

```bash
./runtime/scripts/dune ready
```

Confirm:

- `dune-rmq-game` is running
- `dune-rmq-admin` is running
- Survival and Overmap logs show **listening for Clients**
- No repeated **RMQ runnable failed** errors

Once those are clean, try joining again.

For bind/advertise IP overrides, see [`.env.example`](.env.example) (`SERVER_BIND_IP`, `SERVER_IP`, `DUNE_RMQ_GAME_HOST`, `DUNE_RMQ_ADMIN_HOST`).

### localhost:8088 does not load

The console uses a **published Docker port** (`8088:8088`), not host networking, so Windows can open http://localhost:8088 through Docker Desktop.

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

### `registry.funcom.com: no such host` / boot auto-start exit 125

This usually means **Funcom images are not loaded yet**, not that your internet is broken.

- `registry.funcom.com/...` is the **local tag name** for images shipped inside the Steam self-host package.
- They are loaded with `docker load` from tarballs (via the Web UI setup wizard or `runtime/scripts/update.sh install`), **not** pulled from a public registry.
- When Postgres or game images are missing, `docker run` tries to pull and fails with `lookup registry.funcom.com: no such host`.

**Fix**

1. Open http://localhost:8088 and complete first-time setup (downloads Steam files and loads images), **or** inside WSL:

   ```bash
   cd /mnt/d/path/to/dune-awakening-selfhost-docker
   runtime/scripts/update.sh install
   ```

2. Confirm images exist:

   ```bash
   docker images | grep registry.funcom.com
   ```

**WSL DNS** (only affects name resolution inside WSL; Docker Desktop uses its own VM DNS):

- `install.ps1` configures `/etc/wsl.conf` (`generateResolvConf=false`) and `/etc/resolv.conf` using your Windows DNS servers.
- Override: create `.wsl/dns-servers.txt` in the repo (one IPv4 nameserver per line), then re-run `.\install.ps1`.
- Embedded Docker Engine (`-ContainerRuntime docker`) also gets matching DNS in `/etc/docker/daemon.json`.

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
| [`runtime/scripts/configure-wsl-dns.sh`](runtime/scripts/configure-wsl-dns.sh) | WSL `/etc/wsl.conf` + `/etc/resolv.conf` and embedded Docker DNS |
| [`runtime/scripts/docker-desktop-wsl.sh`](runtime/scripts/docker-desktop-wsl.sh) | Docker Desktop WSL integration helpers |
| [`runtime/scripts/ensure-podman-socket.sh`](runtime/scripts/ensure-podman-socket.sh) | Compose startup helpers (Docker and Podman paths) |
| [`docker-compose.web.yml`](docker-compose.web.yml) | Web UI service definition |

For Linux server installs (non-Windows), use [`install.sh`](install.sh) directly — see the main [README.md](README.md).
