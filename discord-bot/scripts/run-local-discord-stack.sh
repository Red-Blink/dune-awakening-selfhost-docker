#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
BOT_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$BOT_DIR/.." && pwd)"
API_DIR="$REPO_ROOT/console/api"
ENV_FILE="${DUNE_DISCORD_ENV_FILE:-$HOME/.config/dune-console/discord-bot.env}"
ADAPTER_HOST="${ADMIN_BIND_HOST:-127.0.0.1}"
ADAPTER_PORT="${ADMIN_BIND_PORT:-8090}"
ADAPTER_URL="http://$ADAPTER_HOST:$ADAPTER_PORT"
LOG_DIR="${DUNE_DISCORD_LOG_DIR:-/tmp/dune-discord-stack}"
ADAPTER_LOG="$LOG_DIR/adapter.log"
BOT_LOG="$LOG_DIR/bot.log"

mkdir -p "$LOG_DIR"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE" >&2
  echo "Create it first, including DISCORD_BOT_TOKEN_FILE, DUNE_BOT_API_TOKEN_FILE, DISCORD_CLIENT_ID, and DISCORD_GUILD_ID." >&2
  exit 1
fi

# shellcheck disable=SC1090
. "$ENV_FILE"

: "${DISCORD_BOT_TOKEN_FILE:?Missing DISCORD_BOT_TOKEN_FILE in $ENV_FILE}"
: "${DUNE_BOT_API_TOKEN_FILE:?Missing DUNE_BOT_API_TOKEN_FILE in $ENV_FILE}"
: "${DISCORD_CLIENT_ID:?Missing DISCORD_CLIENT_ID in $ENV_FILE}"
: "${DISCORD_GUILD_ID:?Missing DISCORD_GUILD_ID in $ENV_FILE}"

if [ ! -f "$DISCORD_BOT_TOKEN_FILE" ]; then
  echo "Missing Discord bot token file: $DISCORD_BOT_TOKEN_FILE" >&2
  exit 1
fi

if [ ! -f "$DUNE_BOT_API_TOKEN_FILE" ]; then
  echo "Missing Console bot API token file: $DUNE_BOT_API_TOKEN_FILE" >&2
  exit 1
fi

printf 'Stopping old Discord bot runtime if present...\n'
pkill -f 'discord-runtime.mjs' 2>/dev/null || true

printf 'Freeing adapter port %s if a stale adapter owns it...\n' "$ADAPTER_PORT"
fuser -k "$ADAPTER_PORT/tcp" 2>/dev/null || true

printf 'Starting Console adapter on %s...\n' "$ADAPTER_URL"
(
  cd "$API_DIR"
  env \
    DUNE_DOCKER_DIR="$REPO_ROOT" \
    DUNE_BOT_API_TOKEN_FILE="$DUNE_BOT_API_TOKEN_FILE" \
    DISCORD_OBSERVER_ROLE_IDS="${DISCORD_OBSERVER_ROLE_IDS:-role-observer}" \
    DISCORD_MODERATOR_ROLE_IDS="${DISCORD_MODERATOR_ROLE_IDS:-role-moderator}" \
    DISCORD_ADMIN_ROLE_IDS="${DISCORD_ADMIN_ROLE_IDS:-role-admin}" \
    DISCORD_OWNER_ROLE_IDS="${DISCORD_OWNER_ROLE_IDS:-role-owner}" \
    ADMIN_BIND_HOST="$ADAPTER_HOST" \
    ADMIN_BIND_PORT="$ADAPTER_PORT" \
    npm run start:discord-adapter
) >"$ADAPTER_LOG" 2>&1 &
ADAPTER_PID="$!"

cleanup() {
  kill "$ADAPTER_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

printf 'Waiting for adapter health...\n'
TOKEN="$(cat "$DUNE_BOT_API_TOKEN_FILE")"
i=0
while [ "$i" -lt 40 ]; do
  if curl -fsS -H "Authorization: Bearer $TOKEN" "$ADAPTER_URL/api/integrations/discord/health" >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 0.5
done

if [ "$i" -ge 40 ]; then
  echo "Adapter did not become healthy at $ADAPTER_URL" >&2
  echo "Adapter log: $ADAPTER_LOG" >&2
  tail -80 "$ADAPTER_LOG" >&2 || true
  exit 1
fi

printf 'Adapter healthy: %s\n' "$ADAPTER_URL"
printf 'Starting Discord bot. Logs: %s and %s\n' "$BOT_LOG" "$ADAPTER_LOG"
printf 'Use Ctrl+C to stop both processes.\n'

cd "$BOT_DIR"
export DISCORD_BOT_TOKEN_FILE
export DUNE_BOT_API_TOKEN_FILE
export DUNE_CONSOLE_API_URL="$ADAPTER_URL"
export DISCORD_CLIENT_ID
export DISCORD_GUILD_ID
export DISCORD_OBSERVER_ROLE_IDS="${DISCORD_OBSERVER_ROLE_IDS:-role-observer}"
export DISCORD_MODERATOR_ROLE_IDS="${DISCORD_MODERATOR_ROLE_IDS:-role-moderator}"
export DISCORD_ADMIN_ROLE_IDS="${DISCORD_ADMIN_ROLE_IDS:-role-admin}"
export DISCORD_OWNER_ROLE_IDS="${DISCORD_OWNER_ROLE_IDS:-role-owner}"

node scripts/discord-runtime.mjs 2>&1 | tee "$BOT_LOG"
