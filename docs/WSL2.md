# WSL2 Ubuntu Guide

This fork adds explicit WSL2 checks for Dune Docker Console. WSL2 is useful for local testing, LAN validation, and development. For a long-running public server, native Ubuntu on bare metal, a real VM, or a VPS is preferred.

## Supported modes

### Recommended: native Docker Engine inside WSL Ubuntu

Use this mode when you want the full stack to behave closest to native Linux.

Requirements:

- WSL2 Ubuntu
- systemd enabled in WSL
- Docker Engine installed inside the Ubuntu distribution
- Repo stored under the WSL Linux filesystem, such as `~/dune-awakening-selfhost-docker-WSL`

Enable systemd inside WSL:

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

Then run from PowerShell:

```powershell
wsl --shutdown
```

Restart Ubuntu and verify:

```bash
systemctl is-system-running || true
docker info
docker compose version
```

### Supported: Docker Desktop with WSL integration

Docker Desktop can work, but host networking must be enabled.

Docker Desktop steps:

1. Open Docker Desktop.
2. Go to **Settings**.
3. Go to **Resources**.
4. Select **Network**.
5. Enable **Host networking**.
6. Apply and restart Docker Desktop.

Validate inside WSL Ubuntu:

```bash
docker info
docker run --rm --network host alpine:3.20 true
```

## Recommended `.wslconfig`

Create or update this Windows file:

```text
%UserProfile%\.wslconfig
```

Recommended starting point:

```ini
[wsl2]
memory=32GB
processors=8
swap=16GB
localhostForwarding=true
```

Then run from PowerShell:

```powershell
wsl --shutdown
```

Adjust memory and CPU values to match your hardware. The Dune stack is memory-heavy; 20 GB is the practical minimum for a basic layout, while 40 GB is a better target for main world plus Deep Desert testing.

## Filesystem placement

Keep the repo inside the WSL Linux filesystem:

```bash
cd ~
git clone https://github.com/yacketrj/dune-awakening-selfhost-docker-WSL.git
cd dune-awakening-selfhost-docker-WSL
```

Avoid running from Windows-mounted paths such as:

```text
/mnt/c/Users/<you>/...
```

Windows-mounted paths are slower and can produce bind-mount and permission edge cases for Linux containers.

## CPU feature check

The game server needs AVX/AVX2 exposed inside WSL:

```bash
grep -m1 -E 'avx|avx2' /proc/cpuinfo
grep -m1 -o 'avx2' /proc/cpuinfo
```

If AVX/AVX2 is missing, check BIOS virtualization settings, CPU support, Windows virtualization features, and whether another hypervisor layer is masking CPU flags.

## Recommended local `.env`

For native Docker Engine inside WSL:

```env
SERVER_IP_MODE=local
SERVER_IP=auto
SERVER_BIND_IP=
ADMIN_BIND_HOST=127.0.0.1
ADMIN_BIND_PORT=8088
ADMIN_AUTH_DISABLED=0
```

For Docker Desktop with WSL integration, start with the same values. If RabbitMQ connectivity fails from game containers, set explicit WSL/Docker host overrides:

```env
DUNE_RMQ_GAME_HOST=<WSL_BIND_IP>
DUNE_RMQ_ADMIN_HOST=<WSL_BIND_IP>
```

Find the WSL bind IP:

```bash
ip -4 addr show eth0 | awk '/inet / {print $2}' | cut -d/ -f1
```

## Public/LAN hosting notes

WSL public hosting is fragile because traffic may cross Windows firewall rules, WSL NAT or mirrored networking, Docker host networking, and router/NAT forwarding. For public hosting, prefer native Ubuntu, a VM, or a VPS.

Required public ports:

| Port | Protocol | Purpose |
|---|---|---|
| `8088` | TCP | Web admin setup panel |
| `31982` | TCP | Game messaging |
| `7777-7810` | UDP | Game traffic |

Keep database and internal admin ports private.

## Validation commands

Run these after install:

```bash
dune doctor
dune ready
dune ports
docker ps --filter "name=dune-"
```

WSL-specific checks in `dune doctor` report:

- WSL detection
- AVX/AVX2 visibility
- Memory available to WSL
- Repo path under `/mnt/*`
- Docker Desktop vs native Docker Engine
- Host networking availability
- Admin bind host safety
