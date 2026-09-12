#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo_root"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || { echo "SKIP: docker not available"; exit 0; }
[ -f docker-compose.web.yml ] || fail "docker-compose.web.yml not found"

# Real invocation, no live container -- proves docker-compose.web.yml is
# still valid, the expected service name resolves, and setting the same
# env vars recreate_discord_adapter_env() writes actually flow into the
# resolved config, without needing a running Docker daemon beyond `compose
# config`'s own static resolution.
service="$(docker compose -f docker-compose.web.yml config --services 2>/dev/null | grep -E '^redblink-dune-docker-console$' | head -n1 || true)"
[ -n "$service" ] || fail "expected service 'redblink-dune-docker-console' not found in docker-compose.web.yml"

tmp_env="$(mktemp)"
trap 'rm -f "$tmp_env"' EXIT
cp .env "$tmp_env" 2>/dev/null || touch "$tmp_env"
{
  echo "DUNE_DISCORD_ADAPTER_ENABLED=true"
  echo "DUNE_DISCORD_ADAPTER_TOKEN_FILE=runtime/secrets/discord-adapter-token.txt"
  echo "DISCORD_PLAYER_ROLE_IDS=111111111111111111"
} >> "$tmp_env"

# shellcheck disable=SC2046 # word splitting here is deliberate: this turns
# each "KEY=VALUE" line into a separate argument to `env`, exactly the
# space-separated form `env` requires to set multiple variables at once.
resolved="$(env $(grep -v '^#' "$tmp_env" | xargs -d '\n' -I{} echo {}) docker compose -f docker-compose.web.yml config 2>/dev/null || true)"
[ -n "$resolved" ] || fail "docker compose config produced no output with Discord adapter env vars set"
echo "$resolved" | grep -q "DUNE_DISCORD_ADAPTER_ENABLED" || fail "resolved compose config did not include DUNE_DISCORD_ADAPTER_ENABLED -- check docker-compose.web.yml's environment: passthrough for this variable"
echo "$resolved" | grep -q "DUNE_DISCORD_ADAPTER_TOKEN_FILE" || fail "resolved compose config did not include DUNE_DISCORD_ADAPTER_TOKEN_FILE -- Step 0 of this task must add this line to docker-compose.web.yml's environment: block, or the token file path this feature writes to .env never reaches the running container"
echo "$resolved" | grep -q "DISCORD_PLAYER_ROLE_IDS" || fail "resolved compose config did not include DISCORD_PLAYER_ROLE_IDS -- Step 0 of this task must add this line to docker-compose.web.yml's environment: block, or player role IDs never reach the running container"

echo "OK: docker-compose.web.yml resolves correctly with Discord adapter env vars set"

# Finding 1 (CRITICAL, final review): an existing operator who has ONLY the
# legacy DISCORD_OBSERVER_ROLE_IDS set (no DISCORD_PLAYER_ROLE_IDS at all --
# it didn't exist before this feature) must not silently lose that role
# mapping. docker-compose.web.yml's DISCORD_PLAYER_ROLE_IDS entry now uses
# nested interpolation ("${DISCORD_PLAYER_ROLE_IDS:-${DISCORD_OBSERVER_ROLE_IDS:-}}")
# so the resolved container env falls back to the legacy value when the new
# key is genuinely absent from .env.
legacy_only_env="$(mktemp)"
trap 'rm -f "$tmp_env" "$legacy_only_env"' EXIT
cp .env "$legacy_only_env" 2>/dev/null || touch "$legacy_only_env"
{
  echo "DISCORD_OBSERVER_ROLE_IDS=999999999999999999"
} >> "$legacy_only_env"
# shellcheck disable=SC2046
legacy_resolved="$(env $(grep -v '^#' "$legacy_only_env" | xargs -d '\n' -I{} echo {}) docker compose -f docker-compose.web.yml config 2>/dev/null || true)"
[ -n "$legacy_resolved" ] || fail "docker compose config produced no output with only the legacy DISCORD_OBSERVER_ROLE_IDS set"
echo "$legacy_resolved" | grep -q "DISCORD_PLAYER_ROLE_IDS: \"999999999999999999\"" || fail "Finding 1 regression: DISCORD_PLAYER_ROLE_IDS did not fall back to the legacy DISCORD_OBSERVER_ROLE_IDS value when only the legacy var was set -- an existing operator would silently lose that role mapping on update"

echo "OK: DISCORD_PLAYER_ROLE_IDS falls back to legacy DISCORD_OBSERVER_ROLE_IDS when only the legacy var is set (Finding 1)"
