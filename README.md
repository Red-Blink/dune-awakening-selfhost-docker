# Dune Docker Console

![Dune Awakening Self-Host Docker cover](assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen)

Dune Docker Console is a Docker-based self-hosting package for Dune: Awakening with a built-in browser admin panel. Install it on a fresh server, open the Web UI, finish setup in the wizard, and manage players, maps, backups, updates, live tools, and server operations without living in the terminal.

This project is unofficial. It is not affiliated with, endorsed by, sponsored by, or supported by Funcom.

## Features

- Browser setup wizard for fresh self-hosted servers
- Live status, readiness, service controls, logs, backups, and updates
- Player tools for lookup, profile, inventory, crafting, progression, journey, skills, stats, history, and online activity views
- Player actions for item grants, XP, skill points, water refill, teleport, kick, and vehicle spawn
- Admin Tools with item, vehicle, skill, command history, and broadcast workflows
- Care Packages with configurable kits and automatic grant rules
- Live map marker/list view for online player and server activity
- Map management for dynamic or always-on maps, Sietches, and Deep Desert layouts
- Interactive UserEngine and UserGame editing without manually editing config files
- Memory controls, including per-map memory settings and the Memory Balancer
- Autoscaler controls for starting, stopping, and reconciling dynamic map servers
- Database browser plus database backup, restore, import, and maintenance tools
- And much more!

## Requirements

You do not need to be a Linux expert. Start with a fresh server and the installer will check the basics for you.

| What you need | Plain Explanation |
|---|---|
| A server | Ubuntu/Linux is the easiest path. Docker Desktop on Windows/WSL2 or a VM can also work. |
| Docker | You can start even if Docker is not ready yet. On supported Linux servers, the installer prepares Docker for you. |
| Funcom token | You will paste this into the browser setup wizard. |
| CPU support | The game server needs AVX/AVX2. Most modern dedicated servers and VPS plans expose this. |
| Disk space | 100 GB or more is recommended. |
| Web access | Open the Web UI on port `8088` from your browser. You can use the public address or the same-network/local address shown by the installer. |

Memory Guide:

RAM decides how many Dune map servers you can keep running comfortably. Start with the basic layout if you are unsure. Add more RAM when you want more maps online at the same time or expect heavier player activity.

| Server Layout | Recommended RAM |
|---|---:|
| Basic server for getting started | 20 GB |
| Main world plus extra story/social maps | 30 GB |
| Main world, extra maps, and Deep Desert | 40 GB |
| Many always-on maps or heavier player activity | 60 GB+ |

Forward these ports for public/internet hosting:

| Port | Protocol | Purpose |
|---|---|---|
| `8088` | TCP | Web admin setup panel |
| `31982` | TCP | Game messaging |
| `7777-7810` | UDP | Game traffic |

Keep database and internal admin ports private.

## Getting Started

Copy and paste this on a fresh Linux server:

```bash
bash -c 'set -euo pipefail; if ! command -v curl >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y ca-certificates curl tar; fi; mkdir -p "$HOME/dune-awakening-selfhost-docker"; cd "$HOME/dune-awakening-selfhost-docker"; latest_url="$(curl -fsSLI -o /dev/null -w "%{url_effective}" https://github.com/Red-Blink/dune-awakening-selfhost-docker/releases/latest)"; version="${latest_url##*/}"; curl -fsSL "https://github.com/Red-Blink/dune-awakening-selfhost-docker/archive/refs/tags/${version}.tar.gz" | tar -xz --strip-components=1; chmod +x install.sh; ./install.sh'
```

The installer downloads the latest release, prepares the server, starts the Web UI, and tells you what address to open in your browser. If you are on the same network as the server, use the same-network address. If you are connecting over the internet, use the public address and allow TCP `8088` in your firewall.

### Windows (WSL2)

See **[WSL_README.md](WSL_README.md)** for the full Windows workflow, parameters, troubleshooting, and `.wsl/` state layout.

Quick start from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

This installs **Docker Engine inside WSL** by default (not Docker Desktop on Windows). Use `-ContainerRuntime podman` to opt in to Podman inside WSL instead.

**Updates**

```powershell
.\update.ps1
.\update.ps1 -RebuildConsole      # when admin-server / web / Dockerfile changed
.\update.ps1 -RebuildOrchestrator
.\update.ps1 -FullStack
```

Open the Web UI from Windows at **http://localhost:8088**.

For Docker Desktop/WSL2 RabbitMQ overrides, see [`.env.example`](.env.example).

## Contributing & Project Notes

- Issues, fixes, and improvements are welcome.
- This project is community maintained and experimental.
- Funcom self-hosting behavior may change over time.
- Keep secrets, generated runtime files, and backups out of git.
- Do not expose the Web UI to untrusted users.

## Credits

Dune Docker Console is created and maintained by RedBlink. You are welcome to use, fork, modify, and build on this project. If you share or redistribute it, please credit RedBlink as the original developer.

## License

MIT. See [LICENSE](LICENSE).
