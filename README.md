# Dune Docker Console

![Dune Awakening Self-Host Docker cover](assets/cover.png)

![Docker](https://img.shields.io/badge/Docker-Ready-brightgreen) ![Linux](https://img.shields.io/badge/Linux-Supported-brightgreen) ![WSL2](https://img.shields.io/badge/WSL2-Supported-brightgreen) ![Self--Hosted](https://img.shields.io/badge/Self--Hosted-Yes-brightgreen) ![Status](https://img.shields.io/badge/Status-Experimental-orange) ![License](https://img.shields.io/badge/License-MIT-brightgreen)

Dune Docker Console is a Docker-based self-hosting package for Dune: Awakening with a built-in browser admin panel. Install it on a fresh server, open the Web UI, finish setup in the wizard, and manage players, maps, backups, updates, live tools, and server operations without living in the terminal.

This project is unofficial. It is not affiliated with, endorsed by, sponsored by, or supported by Funcom.

## Community & Support

Need help, want to follow updates, or want to discuss features, addons, and self-hosting?

Join our fast growing Discord: [Dune: Awakening Docker](https://discord.gg/9pQqytu6BU)

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
- WSL2-focused installer and doctor checks for host networking, AVX/AVX2 visibility, WSL memory, and Windows-mounted paths
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
| Web access | Open the Web UI on port `8088` from your browser. WSL defaults to localhost-first access for safety. |

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

## WSL2 Ubuntu Setup

This fork includes WSL2-specific install guidance and diagnostics. WSL2 is a good target for local testing and LAN validation. For a stable public/internet server, native Ubuntu on bare metal, a real VM, or a VPS is still preferred.

Supported WSL modes:

1. **Native Docker Engine inside WSL Ubuntu** — recommended for the full stack.
2. **Docker Desktop with WSL integration** — supported only when Docker Desktop host networking is enabled.

Minimum WSL checks:

```bash
grep -qiE '(microsoft|wsl)' /proc/version /proc/sys/kernel/osrelease && echo "WSL detected"
grep -m1 -o 'avx2' /proc/cpuinfo
docker info
docker compose version
docker run --rm --network host alpine:3.20 true
```

Recommended Windows `%UserProfile%\.wslconfig`:

```ini
[wsl2]
memory=32GB
processors=8
swap=16GB
localhostForwarding=true
```

After changing `.wslconfig`, run this from PowerShell:

```powershell
wsl --shutdown
```

Store the repo in the WSL Linux filesystem, not under `/mnt/c`:

```bash
cd ~
git clone https://github.com/yacketrj/dune-awakening-selfhost-docker-WSL.git
cd dune-awakening-selfhost-docker-WSL
```

For Docker Desktop, host networking must be enabled:

1. Open Docker Desktop.
2. Go to **Settings**.
3. Go to **Resources**.
4. Select **Network**.
5. Enable **Host networking**.
6. Apply and restart Docker Desktop.

See the detailed WSL guide in [`docs/WSL2.md`](docs/WSL2.md).

## Getting Started

For this WSL-focused fork:

```bash
cd ~
git clone https://github.com/yacketrj/dune-awakening-selfhost-docker-WSL.git
cd dune-awakening-selfhost-docker-WSL
chmod +x install.sh
./install.sh
```

The installer prepares Docker when possible, checks the WSL environment, starts the Web UI, and tells you what address to open in your browser. If you are on WSL, start with the localhost address. If you deliberately expose the Web UI to the LAN, keep authentication enabled and restrict access to trusted admins.

After the Web UI starts, run:

```bash
dune doctor
```

The doctor command checks containers, ports, Steam server files, database state, RabbitMQ, hosting mode, and WSL-specific conditions.

## Docker Socket Access

The Web UI uses the local Docker socket so it can start, stop, update, and inspect the server containers. This is powerful host-level access, so only expose the Web UI to trusted admins.

If setup says the Docker socket is permission denied, run this from the repo root:

```bash
DOCKER_SOCKET_GID="$(stat -c '%g' /var/run/docker.sock)" dune console restart
```

On a normal Linux install this is usually detected automatically. The command above is mainly for custom Docker setups where the socket group differs from the default container groups.

## Community Addons

Dune Docker Console includes a Community Addons area for extra tools built by the community. Server owners can discover, install, enable, and remove addons from the Web UI without replacing the main console.

Addons are designed to let the community experiment with new panels, reports, helpers, and server-owner workflows while keeping the core console clean. Each addon declares what it needs before it is installed, so server owners can review permissions first.

Have an idea you want to build for Dune Docker Console? Start with the official addon template:

```text
https://github.com/Red-Blink/dune-docker-addon-template
```

The template gives addon developers a ready-to-use structure, examples, validation, and GitHub release packaging. Build your addon in its own repo, publish a release, then submit it to the community addons list when it is ready for others to try.

## Contributing & Project Notes

- Issues, fixes, and improvements are welcome.
- This project is community maintained and experimental.
- Funcom self-hosting behavior may change over time.
- Keep secrets, generated runtime files, and backups out of git.
- Do not expose the Web UI to untrusted users.
- On WSL, keep the repo under the Linux filesystem and run `dune doctor` before troubleshooting individual game services.

## Credits

Dune Docker Console is created and maintained by RedBlink. You are welcome to use, fork, modify, and build on this project. If you share or redistribute it, please credit RedBlink as the original developer.

## License

MIT. See [LICENSE](LICENSE).
