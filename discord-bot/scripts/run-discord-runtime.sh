#!/usr/bin/env sh
set -eu

ENV_FILE="${DUNE_DISCORD_ENV_FILE:-$HOME/.config/dune-console/discord-bot.env}"

if [ ! -f "$ENV_FILE" ]; then
  cat >&2 <<EOF
Missing Discord bot environment file: $ENV_FILE

Create it with stable non-secret settings, for example:

  mkdir -p "$HOME/.config/dune-console"
  chmod 700 "$HOME/.config/dune-console"
  cat > "$ENV_FILE" <<'ENVEOF'
export DISCORD_BOT_TOKEN_FILE="$HOME/.config/dune-console/discord-bot-token.txt"
export DUNE_BOT_API_TOKEN_FILE="$HOME/.config/dune-console/dune-bot-api-token.txt"
export DUNE_CONSOLE_API_URL="http://127.0.0.1:8088"
export DISCORD_CLIENT_ID="1516816812006969494"
export DISCORD_GUILD_ID="replace-with-server-id"
export DISCORD_OBSERVER_ROLE_IDS="replace-with-observer-role-id"
export DISCORD_ADMIN_ROLE_IDS="replace-with-admin-role-id"
export DISCORD_OWNER_ROLE_IDS="replace-with-owner-role-id"
ENVEOF
  chmod 600 "$ENV_FILE"
EOF
  exit 2
fi

# shellcheck disable=SC1090
. "$ENV_FILE"

required_var() {
  eval "value=\${$1:-}"
  if [ -z "$value" ]; then
    echo "Missing required environment variable after sourcing $ENV_FILE: $1" >&2
    exit 2
  fi
}

required_var DISCORD_BOT_TOKEN_FILE
required_var DUNE_BOT_API_TOKEN_FILE
required_var DUNE_CONSOLE_API_URL
required_var DISCORD_CLIENT_ID
required_var DISCORD_GUILD_ID

exec node scripts/discord-runtime.mjs
