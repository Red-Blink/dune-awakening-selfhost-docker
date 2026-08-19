# Dune: Awakening Docker - Self-Hosted Server Console

![Dune Awakening Self-Host Docker cover](assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen) [![DuneDocker.app](https://img.shields.io/badge/Website-DuneDocker.app-f47fff)](https://dunedocker.app/)

Dune Docker Console is a Docker-based Dune: Awakening dedicated server manager for Linux, Windows/WSL2, and virtual machines. It provides guided installation and a browser admin panel for managing players, maps, backups, updates, and server operations without living in the terminal.

This is an unofficial community project and is not affiliated with, endorsed by, sponsored by, or supported by Funcom.

The project is experimental, and Funcom self-hosting behavior may change over time.

## What You Can Do

- Set up and manage the server from your browser
- Monitor status, logs, readiness, backups, and updates
- Manage players, inventories, progression, rewards, vehicles, and admin actions
- Control maps, Sietches, Deep Desert layouts, and live map activity
- Configure memory, autoscaling, and game settings
- Manage databases, bases, storage, and player blueprints
- Extend the console with optional Community Addons

See the [Screenshots Gallery](docs/screenshots.md) for a closer look.

## Requirements

You do not need to be a Linux expert. The installer checks the basics and prepares Docker on supported Linux systems.

| What&nbsp;You&nbsp;Need | Recommendation |
|---|---|
| Server | A fresh 64-bit Ubuntu server is the recommended and easiest option. Other Linux distributions, Docker Desktop on Windows/WSL2, and virtual machines are also supported. |
| Docker | The installer prepares Docker on supported Linux systems if it is not already available. |
| CPU | AVX/AVX2 support |
| Memory | Start with 20 GB RAM; use 30–40 GB or more for additional always-on maps |
| Storage | 200 GB or more |
| Funcom token | Entered securely during browser setup |

<details>
<summary>Memory & CPU Guidance</summary>

RAM determines how many Dune map servers can run comfortably. Start with the basic layout if you are unsure and add more RAM for additional always-on maps or heavier player activity.

The official Survival server commonly keeps roughly 10–12 GB resident even with no players online; a single idle snapshot is not by itself a memory leak. In `docker stats`, CPU is measured in CPU-core units: `100%` means one fully used logical CPU.

| Server Layout | Recommended RAM |
|---|---:|
| Basic server for getting started | 20 GB |
| Main world plus extra story/social maps | 30 GB |
| Main world, extra maps, and Deep Desert | 40 GB |
| Many always-on maps or heavier player activity | 60 GB+ |

</details>

For public/internet hosting, forward these ports:

| Port | Protocol | Purpose |
|---|---|---|
| `8088` | TCP | Web admin panel; allow access only for trusted administrators |
| `31982-31983` | TCP | Game Messaging |
| `7777-7810` | UDP | Game Traffic |

Keep database and internal admin ports private. Do not expose the Web UI to untrusted users.

## Installation

Run the installer from a regular user account with `sudo` access, not while logged in as `root`. The installer requests administrator access only when required.

Copy and paste this command on a fresh Linux server:

```sh
sh -c 'set -eu; echo "==> Setting up Dune Docker Console..."; if command -v curl >/dev/null 2>&1; then _download() { curl -fsSL "$1"; }; _download_progress() { curl -fSL "$1"; }; _download_effective_url() { curl -fsSLI -o /dev/null -w "%{url_effective}" "$1"; }; elif command -v wget >/dev/null 2>&1; then _download() { wget -qO- "$1"; }; _download_progress() { wget -O- "$1"; }; _download_effective_url() { wget -qS --spider "$1" 2>&1 | grep -i "^ *Location:" | tail -1 | awk "{print \$2}"; }; else echo "==> Neither curl nor wget found. Installing prerequisites..."; if command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y ca-certificates curl tar; elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y curl tar; elif command -v yum >/dev/null 2>&1; then sudo yum install -y curl tar; elif command -v zypper >/dev/null 2>&1; then sudo zypper install -y curl tar; elif command -v pacman >/dev/null 2>&1; then sudo pacman -Sy --noconfirm curl tar; elif command -v apk >/dev/null 2>&1; then sudo apk add --no-cache curl tar; elif command -v xbps-install >/dev/null 2>&1; then sudo xbps-install -Sy curl tar; else echo "Could not detect package manager. Please install curl or wget manually." >&2; exit 1; fi; _download() { curl -fsSL "$1"; }; _download_progress() { curl -fSL "$1"; }; _download_effective_url() { curl -fsSLI -o /dev/null -w "%{url_effective}" "$1"; }; fi; mkdir -p "$HOME/dune-awakening-selfhost-docker"; cd "$HOME/dune-awakening-selfhost-docker"; echo "==> Finding the latest release..."; latest_url="$(_download_effective_url https://github.com/Red-Blink/dune-awakening-selfhost-docker/releases/latest)"; version="${latest_url##*/}"; echo "==> Downloading dune-awakening-selfhost-docker ${version}..."; _download_progress "https://github.com/Red-Blink/dune-awakening-selfhost-docker/archive/refs/tags/${version}.tar.gz" | tar -xz --strip-components=1; chmod +x install.sh; echo "==> Starting the installer..."; ./install.sh'
```

The installer downloads the latest release, starts the Web UI, and tells you which address to open. Complete the remaining setup in your browser.

On Alpine Linux, the installer uses the distribution's Docker and Docker Compose packages and starts Docker through OpenRC. If the community repository is unavailable, the installer asks before changing repository configuration.

## Public Server Directory

[DuneDocker.app](https://dunedocker.app/) helps public server owners showcase their communities and helps players find the right server. Each listing provides a live server page with status, player count, region, Sietches, personalized latency, and an optional Discord community link.

Owners can claim their listing directly from the Console Settings page to verify ownership, manage their public profile and Discord invite, and promote their server through the directory. Public listings can be enabled or disabled at any time.

Local and LAN-only servers are never listed. For transparency, installations contribute only an anonymous server count by default—never server names, addresses, players, or settings—and this can be disabled separately in Settings.

## Community Addons

Community Addons provide optional tools that can be installed and managed from the Web UI. Addons declare their permissions before installation, and updates preserve their settings and require approval for any new permissions.

Developers can start with the [Official Addon Template](https://github.com/Red-Blink/dune-docker-addon-template).

## Help and Documentation

- [Official Website](https://dunedocker.app/) — Project information, installation guidance, FAQ, and server directory
- [Discord Community](https://discord.gg/duneawakeningdocker) — Support, updates, addons, and community discussion
- [Documentation](docs/README.md) — Technical and feature documentation
- [Support the Project](https://ko-fi.com/redblink) — Help support development, testing, and infrastructure

## Contributing

Issues, fixes, and improvements are welcome. Keep secrets, generated runtime files, and backups out of Git, and never expose the Web UI to untrusted users.

## Credits and License

Dune Docker Console is led and maintained by RedBlink with contributions from the community. Please credit RedBlink as the original developer when sharing or redistributing the project.

**Free and open source under the [MIT License](LICENSE).**
