# Dune Awakening Self-Host Docker

Experimental Docker-native launcher for Dune: Awakening self-host server components.

This project replaces the normal local/k3s-style setup with Docker containers and a simple `dune` command wrapper.

## Current working stack

Core services:

- Postgres
- RabbitMQ admin
- RabbitMQ game TLS
- TextRouter
- Director
- ServerGateway

Always-on game servers:

- Overmap
- Survival_1

Dedicated/on-demand maps are not fully automated yet. The current MVP starts the minimal always-on farm and leaves future work for dynamic map spawning.

## Requirements

- Linux server/VPS
- Docker Engine
- Docker Compose
- UFW or equivalent firewall
- Valid Funcom self-host token
- At least 100 GB free disk space recommended
- 20 GB+ RAM recommended for normal use

## Ports

Public ports:

- TCP 31982: RabbitMQ game TLS
- UDP 7777-7810: Game servers

Localhost-only ports:

- TCP 15432: Postgres
- TCP 32573: RabbitMQ admin
- TCP 5059: TextRouter
- TCP 11717: Director

## Setup

Clone the repo:

```bash
git clone https://github.com/Red-Blink/dune-awakening-selfhost-docker.git
cd dune-awakening-selfhost-docker
```

Install the command wrapper:

```bash
sudo runtime/scripts/install-command.sh
```

Run first-time setup:

```bash
dune init
```

`dune init` will ask for:

- Server name
- Region: `Europe Test` or `North America Test`
- Server/player-facing IP, or `auto`
- Steam app ID, default `3104830`
- Funcom self-host token

The Funcom token input is hidden while typing/pasting.

During initialization, the tool will:

1. Save local configuration to `.env`.
2. Save the Funcom token to `runtime/secrets/funcom-token.txt`.
3. Generate the battlegroup ID using Funcom's self-host world-name format.
4. Save the generated battlegroup ID to `runtime/generated/battlegroup.env`.
5. Start the orchestrator container.
6. Download/update server files with SteamCMD.
7. Load Funcom Docker image tarballs.
8. Detect image tags.
9. Run database setup/update.
10. Start the Docker stack.

Do not commit `.env`, `runtime/secrets/`, `runtime/generated/`, or runtime game data.

## Common commands

Open the interactive manager:

```bash
dune manager
```

Start the stack:

```bash
dune start
```

Stop the stack:

```bash
dune stop
```

Check readiness:

```bash
dune ready
```

Show full status:

```bash
dune status
```

Show ports/listeners:

```bash
dune ports
```

Show containers:

```bash
dune ps
```

Follow logs:

```bash
dune logs survival
dune logs overmap
dune logs director
dune logs gateway
dune logs text-router
dune logs rmq-game
```

Restart individual services:

```bash
dune restart survival
dune restart overmap
dune restart director
dune restart gateway
dune restart text-router
```

## Interactive manager

The Linux interactive manager is available with:

```bash
dune manager
```

It provides a menu for:

- First-time init
- Start/stop/update
- Status/ready/ports
- Restarting key services
- Following logs
- Opening a shell inside the orchestrator container

This is the Docker/Linux equivalent of the normal battlegroup management menu, without Hyper-V or Windows PowerShell.

## Updating

Run:

```bash
dune update
```

Current behavior:

1. Stops Overmap and Survival_1.
2. Runs SteamCMD `app_update`.
3. Loads Funcom image tarballs.
4. Detects updated Docker image tags.
5. Runs DB migration/update.

After update, restart services manually:

```bash
dune restart text-router
dune restart director
dune restart gateway
dune restart survival
dune restart overmap
```

Automatic restarts after update are planned.

## Generated local files

`dune init` creates local files that should not be committed:

```text
.env
runtime/secrets/funcom-token.txt
runtime/generated/battlegroup.env
runtime/generated/image-tags.env
```

The generated battlegroup file looks like:

```env
BATTLEGROUP_ID=sh-<hostid>-<suffix>
```

The format follows Funcom's setup logic:

```text
sh-<token HostId lowercase>-<6 lowercase letters>
```

## Important design notes

The Docker image should contain the orchestrator code, not baked-in old game files. Game server files and Funcom image tarballs are downloaded and updated at runtime into persistent volumes.

The battlegroup ID is generated during `dune init` from the Funcom self-host token's `HostId`, matching Funcom's world-name format.

The current MVP is a Docker-native minimal self-host stack. It starts the core services plus Overmap and Survival_1 as always-on servers.

## Current limitations

- Dedicated/on-demand maps are not automated yet.
- The fake Kubernetes service account/IGWO behavior is a compatibility workaround.
- Update flow is scaffolded but still needs real-world testing after an actual upstream update.
- Automatic service restart after update is not implemented yet.
- This is experimental and should not be treated as production-ready.
