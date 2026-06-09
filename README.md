# RedBlink Dune Awakening Self-Host Docker

## With Arrakis Server Console

This project packages the Dune Awakening Docker server stack together with **Arrakis Server Console**, a built-in browser admin panel for setup, operations, player tools, backups, logs, updates, and starter kits.

Arrakis Server Console helps server owners manage:

- setup, status, and readiness
- services and logs
- backups and updates
- players and admin actions
- Starter Kits
- maps, sietches, Deep Desert, memory, and autoscaler controls
- read-only database tools
- market read-only views
- live map marker/list view

This project is unofficial. It is not affiliated with, endorsed by, sponsored by, or supported by Funcom.

## Requirements

- Ubuntu Linux recommended
- Docker Engine with Docker Compose v2 plugin
- Steam/game server requirements expected by this stack
- Required game ports opened in your firewall/router
- Enough disk and RAM for your server layout
- Funcom self-host token or required game auth token
- Browser access to Arrakis Server Console

## Fresh Ubuntu Quick Start

Install basic tools:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git gnupg
```

Install Docker Engine and the Compose v2 plugin:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
newgrp docker
```

Clone and configure the stack:

```bash
git clone https://github.com/Red-Blink/dune-awakening-selfhost-docker.git
cd dune-awakening-selfhost-docker
cp .env.example .env
nano .env
```

Start the Docker server stack:

```bash
docker compose up -d
```

Start Arrakis Server Console:

```bash
docker compose -f docker-compose.web.yml up -d --build
```

Get the generated web admin password:

```bash
cat runtime/secrets/admin-web-password.txt
```

Open:

```text
http://SERVER_IP:8088
```

Replace `SERVER_IP` with your server IP address. Continue setup in the web UI.

## First-Time Web Setup

1. Open Arrakis Server Console.
2. Sign in with the generated admin password.
3. Go to **Setup**.
4. Enter or confirm required server values.
5. Save the Funcom token when prompted.
6. Run the setup/init flow.
7. Return to **Home** and wait for status/readiness checks.
8. Use **Services** and **Logs** if something is still warming up.

Readiness can take a few minutes while Docker containers, game services, and health checks start.

## Access and Ports

Game ports and the admin panel are separate concerns. Open game ports for players, but protect the web admin.

| Port | Purpose | Public exposure |
|---|---|---|
| `8088/tcp` | Arrakis Server Console web admin | Prefer local/LAN/VPN only. Do not casually expose to the whole internet. |
| `7777/udp` | Default Overmap client game port | Public game port if players connect from the internet. |
| `7778/udp` | Default Survival_1 client game port | Public game port if players connect from the internet. |
| `7888/udp` | Default Survival_1 inter-server/IGW port | Usually internal/server-to-server; expose only if your deployment requires it. |
| `7889/udp` | Default Overmap inter-server/IGW port | Usually internal/server-to-server; expose only if your deployment requires it. |
| `15432/tcp` | Local Postgres | Do not expose publicly. |
| `31982/tcp`, `31983/tcp`, `32573/tcp` | RabbitMQ/game admin internals | Do not expose publicly. |

Dynamic maps can use additional sequential game ports. Check **Home**, **Services**, or the advanced `dune ports` command after changing map settings.

For remote admin access, use a VPN such as Tailscale/WireGuard, SSH tunnel, reverse proxy with strong auth, or firewall allowlisting. Do not leave `8088/tcp` open to the public internet.

## Network IP Setup

The stack separates the local bind address from the public/client address.

- `SERVER_BIND_IP` is the local IP the Docker host listens on.
- `SERVER_IP` is the address players should connect to.
- `SERVER_IP_MODE=local` is for LAN-only servers.
- `SERVER_IP_MODE=public` is for internet/NAT/direct-public servers.

For LAN-only hosting, both addresses are normally the LAN IP:

```env
SERVER_BIND_IP=10.0.0.240
SERVER_IP_MODE=local
SERVER_IP=10.0.0.240
```

For NAT, router, OPNsense, pfSense, or home-server hosting, bind to the host LAN IP and advertise the WAN IP:

```env
SERVER_BIND_IP=10.0.0.240
SERVER_IP_MODE=public
SERVER_IP=109.150.247.52
```

Do not bind game sockets to the public IP unless the Docker host actually owns that IP. In NAT mode, router/firewall DNAT should forward the public UDP ports to `SERVER_BIND_IP`.

For dynamic public IPs, use:

```env
SERVER_BIND_IP=10.0.0.240
SERVER_IP_MODE=public
SERVER_IP=auto
```

On startup, the stack resolves the current public IP, keeps game sockets bound to `SERVER_BIND_IP`, updates public metadata, and reconciles `dune.farm_state` so map travel advertises `SERVER_IP` while IGW traffic stays on the bind IP.

Same-LAN players connecting through the public address may need NAT reflection/hairpin NAT enabled on the router.

## Common Web Tasks

| Task | Where |
|---|---|
| Check status/readiness | Home |
| View services | Services |
| View logs | Logs |
| Create or list backups | Backups |
| Check/apply updates | Updates |
| Manage players | Players |
| Grant items, XP, water, teleport, kick, spawn vehicle | Players |
| Configure and grant Starter Kits | Starter Kit |
| Manage maps, sietches, Deep Desert, memory, autoscaler | Maps |
| Browse database safely | Database |
| View item/vehicle/skill catalogs and command history | Admin Tools |

Advanced CLI usage still exists, but normal admins should start with Arrakis Server Console. See [Advanced CLI Notes](docs/advanced-cli.md).

## Feature Status

| Status | Features |
|---|---|
| Working | Home/status/readiness, Services/logs, Backups create/list, Updates check game/stack, Database read-only browser, Players/profile/inventory, Give Item, Give Item by ID, Add XP, Set Skill Points, Refill Water, Teleport, Kick Player, Spawn Vehicle, Starter Kit manual grant, Market read-only views, Admin catalog/history |
| Partial / experimental | Broadcast publishes to RabbitMQ and logs history but does not appear in-game, Starter Kit auto-grant runs only while Arrakis Server Console is running, Live Map shows markers/list without a calibrated background map, progression/events/stats/history schema mappings are incomplete |
| Blocked / not implemented | Market automation, Whisper, verified Shutdown Broadcast delivery, blueprint/base import/delete/clone, unsafe import/restore flows without explicit confirmation |

For the full detailed matrix, see [Web Feature Parity Status](docs/web-feature-parity-status.md).

## Security Notes

Arrakis Server Console controls Docker and game admin operations. Protect it like a production admin console.

- Keep authentication enabled.
- Use a strong admin password and do not share it.
- Use a firewall, VPN, SSH tunnel, or trusted reverse proxy for remote access.
- `docker-compose.web.yml` mounts `/var/run/docker.sock`; this gives the web container powerful Docker control.
- Back up before destructive operations.
- Dangerous actions require backend confirmation phrases, not only frontend prompts.
- Do not expose Arrakis Server Console directly to the public internet.

## Troubleshooting

### Arrakis Server Console is not loading

```bash
docker compose -f docker-compose.web.yml ps
docker compose -f docker-compose.web.yml logs -f arrakis-console
```

Confirm `8088/tcp` is reachable from your browser or admin network.

### Readiness says not ready

This can be normal during startup. Open **Home**, **Services**, and **Logs** in the web UI. Give game services time to warm up before restarting anything.

### Logs are empty or stale

Use **Logs** in the web UI and refresh the selected service. If the web admin itself is the issue:

```bash
docker compose -f docker-compose.web.yml restart arrakis-console
```

### Docker disk space issue

```bash
df -h
docker system df
```

Free space carefully. Do not delete runtime backups or generated state unless you know what you are removing.

### Restart Arrakis Server Console

```bash
docker compose -f docker-compose.web.yml restart arrakis-console
```

## Documentation

- [Web Admin Deployment](docs/web-deployment.md)
- [Web UI Guide](docs/web-ui.md)
- [Web Admin Features](docs/web-admin-features.md)
- [Web API](docs/web-api.md)
- [Web Security](docs/web-security.md)
- [Web Testing](docs/web-testing.md)
- [Web Feature Parity Status](docs/web-feature-parity-status.md)
- [Advanced CLI Notes](docs/advanced-cli.md)

## License

MIT. See [LICENSE](LICENSE).
