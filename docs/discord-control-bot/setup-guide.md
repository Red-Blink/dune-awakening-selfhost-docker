# Dune Discord Companion Bot - Setup Guide

## Scope

This setup path validates the read-only Discord companion bot command layer and protected Console adapter without requiring manual edits to core Console files.

The actual network Discord client is still deferred. Use the smoke runner to validate command behavior before connecting to Discord.

## Prerequisites

- Dune Docker Console repository checked out.
- Node.js 22 for local smoke testing.
- A local Dune bot API token file.
- Console API reachable on `127.0.0.1:8088` or the configured admin bind port.
- Semgrep and Trivy for local security/SOC 2 readiness scans.

## Install Local Security Runtimes

From the repository root:

```bash
bash scripts/ensure-security-runtimes.sh
```

The script checks for:

```text
node
npm
curl
tar
docker
semgrep
trivy
```

It installs Semgrep if missing using the first available method:

1. `pipx install semgrep`
2. `uv tool install semgrep`
3. Python user install of `pipx`, then `pipx install semgrep`
4. Docker wrapper fallback using `semgrep/semgrep`

It installs Trivy if missing using:

1. Homebrew when available.
2. Latest GitHub release tarball into `$HOME/.local/bin` on Linux/macOS.

If `$HOME/.local/bin` is not on your shell PATH, add it:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Create Local Bot API Token

```bash
mkdir -p "$HOME/.config/dune-console"
printf '%s\n' 'local-dev-bot-api' > "$HOME/.config/dune-console/dune-bot-api-token.txt"
chmod 600 "$HOME/.config/dune-console/dune-bot-api-token.txt"
```

Use a real random token outside local testing.

## Start Console Adapter

From `console/api`:

```bash
DUNE_DOCKER_DIR="$HOME/dune-awakening-selfhost-docker-WSL" \
DUNE_BOT_API_TOKEN_FILE="$HOME/.config/dune-console/dune-bot-api-token.txt" \
DISCORD_OBSERVER_ROLE_IDS=role-observer \
DISCORD_ADMIN_ROLE_IDS=role-admin \
DISCORD_OWNER_ROLE_IDS=role-owner \
npm run start:discord-adapter
```

If runtime secrets are root-owned, use `sudo env` while preserving the same variables:

```bash
sudo env \
  PATH="$PATH" \
  HOME="$HOME" \
  DUNE_DOCKER_DIR="$HOME/dune-awakening-selfhost-docker-WSL" \
  DUNE_BOT_API_TOKEN_FILE="$HOME/.config/dune-console/dune-bot-api-token.txt" \
  DISCORD_OBSERVER_ROLE_IDS=role-observer \
  DISCORD_ADMIN_ROLE_IDS=role-admin \
  DISCORD_OWNER_ROLE_IDS=role-owner \
  npm run start:discord-adapter
```

## Smoke Test Bot Commands

From `discord-bot`:

```bash
npm ci --ignore-scripts

export DUNE_CONSOLE_API_URL=http://127.0.0.1:8088
export DUNE_BOT_API_TOKEN_FILE="$HOME/.config/dune-console/dune-bot-api-token.txt"
export DISCORD_GUILD_ID=local-guild
export DISCORD_OBSERVER_ROLE_IDS=role-observer
export DISCORD_ADMIN_ROLE_IDS=role-admin
export DISCORD_OWNER_ROLE_IDS=role-owner

npm run smoke:health
npm run smoke:status
npm run smoke:readiness
npm run smoke:services
npm run smoke:status-detail
```

## Expected Smoke Test Result

Each command should return `status: 200`.

The smoke output also includes:

```text
actorRoleIdsSent
consoleRolePolicy
```

Use those fields to verify the bot and Console adapter share the same role mapping.

## Test Gates

Run Console adapter tests:

```bash
cd ~/dune-awakening-selfhost-docker-WSL/console/api
npm ci --ignore-scripts
node --test test/discord*.test.js
```

Run bot gates:

```bash
cd ~/dune-awakening-selfhost-docker-WSL/discord-bot
npm ci --ignore-scripts
npm test
npm run security:secrets
npm run build
```

Run SOC 2 readiness check:

```bash
cd ~/dune-awakening-selfhost-docker-WSL
node scripts/soc2-readiness-check.mjs
```

If Semgrep or Trivy are missing, run:

```bash
bash scripts/ensure-security-runtimes.sh
node scripts/soc2-readiness-check.mjs
```

## Local Vulnerability Report

After Trivy is installed, generate filesystem scan input and the CVSS-ranked report:

```bash
mkdir -p artifacts/security
trivy fs --scanners vuln,secret,misconfig --format json --output artifacts/security/trivy-fs.json .
node scripts/generate-vulnerability-report.mjs
```

Read:

```text
artifacts/security/vulnerability-report.md
artifacts/security/vulnerability-report.json
```

## Smoke Test Troubleshooting

### 403 on Readiness or Services

The observer role is not aligned.

Check:

- `actorRoleIdsSent` includes `role-observer`.
- `consoleRolePolicy.observerConfigured` is `true`.
- The Console adapter was started with `DISCORD_OBSERVER_ROLE_IDS=role-observer`.

### 403 on Detailed Status

The admin role is not aligned.

Check:

- `actorRoleIdsSent` includes `role-admin`.
- `consoleRolePolicy.adminConfigured` is `true`.
- The Console adapter was started with `DISCORD_ADMIN_ROLE_IDS=role-admin`.

### 500 Missing Dune Command

Start the Console adapter with the repository root set:

```bash
DUNE_DOCKER_DIR="$HOME/dune-awakening-selfhost-docker-WSL"
```

### Permission Denied on Runtime Secrets

Use `sudo env` for local testing if existing runtime secrets are root-owned. Keep `DUNE_BOT_API_TOKEN_FILE` pointing at `$HOME/.config/dune-console/dune-bot-api-token.txt`.
