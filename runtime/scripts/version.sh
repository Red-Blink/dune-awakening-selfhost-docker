#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

config_value() {
  local file="$1"
  local key="$2"

  [ -f "$file" ] || return 1

  awk -F= -v key="$key" '
    $1 == key {
      value = substr($0, length(key) + 2)
      gsub(/^"/, "", value)
      gsub(/"$/, "", value)
      print value
      exit
    }
  ' "$file"
}

value_is_known() {
  local value="${1:-}"
  [ -n "$value" ] && [ "$value" != "unknown" ]
}

is_running() {
  local name="$1"
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$name"
}

container_env_value() {
  local container="$1"
  local key="$2"

  if ! is_running "$container"; then
    return 1
  fi

  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" 2>/dev/null \
    | awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2); exit }'
}

first_known_value() {
  local candidate
  for candidate in "$@"; do
    if value_is_known "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

steam_build_id() {
  local app_id="$1"
  local manifest="/tmp/dune-appmanifest-${app_id}.acf"

  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-orchestrator; then
    docker compose exec -T orchestrator sh -lc "cat /srv/dune/server/steamapps/appmanifest_${app_id}.acf 2>/dev/null" > "$manifest" 2>/dev/null || true
    if [ -s "$manifest" ]; then
      awk '/"buildid"/ { gsub(/"/, "", $2); print $2; exit }' "$manifest"
      rm -f "$manifest"
      return
    fi
    rm -f "$manifest"
  fi

  echo "unknown"
}

PROJECT_VERSION="dev"
[ -f VERSION ] && PROJECT_VERSION="$(tr -d '[:space:]' < VERSION)"

GIT_BRANCH="unknown"
GIT_COMMIT="unknown"
GIT_STATE="unknown"
GIT_METADATA_AVAILABLE=0

if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  GIT_METADATA_AVAILABLE=1
  GIT_BRANCH="$(git branch --show-current 2>/dev/null || echo unknown)"
  [ -n "$GIT_BRANCH" ] || GIT_BRANCH="detached"
  GIT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  if git diff --quiet --ignore-submodules -- 2>/dev/null && git diff --cached --quiet --ignore-submodules -- 2>/dev/null; then
    GIT_STATE="clean"
  else
    GIT_STATE="dirty"
  fi
fi

STEAM_APP_ID_VALUE="$(first_known_value \
  "$(config_value .env STEAM_APP_ID 2>/dev/null || true)" \
  "${STEAM_APP_ID:-}" \
  "4754530" \
  || echo "4754530")"
SERVER_TITLE_VALUE="$(first_known_value \
  "$(config_value .env SERVER_TITLE 2>/dev/null || true)" \
  "$(container_env_value dune-director BATTLEGROUP_TITLE 2>/dev/null || true)" \
  "$(container_env_value dune-server-gateway gateway_display_name 2>/dev/null || true)" \
  || echo "unknown")"
SERVER_REGION_VALUE="$(first_known_value \
  "$(config_value .env SERVER_REGION 2>/dev/null || true)" \
  "$(container_env_value dune-director BATTLEGROUP_REGION_NAME 2>/dev/null || true)" \
  "$(container_env_value dune-server-gateway OnlineSubsystem_DatacenterId 2>/dev/null || true)" \
  || echo "unknown")"
SERVER_IP_VALUE="$(first_known_value \
  "$(resolve_server_ip 2>/dev/null || true)" \
  "$(config_value .env SERVER_IP 2>/dev/null || true)" \
  "$(container_env_value dune-director HOST_DATACENTER_IP_ADDRESS 2>/dev/null || true)" \
  "$(container_env_value dune-server-gateway HOST_DATACENTER_IP_ADDRESS 2>/dev/null || true)" \
  || echo "unknown")"
SERVER_MODE_VALUE="$(first_known_value \
  "$(config_value .env SERVER_IP_MODE 2>/dev/null || true)" \
  "${SERVER_IP_MODE:-}" \
  || true)"

if [ -z "$SERVER_MODE_VALUE" ] || [ "$SERVER_MODE_VALUE" = "unknown" ]; then
  if printf '%s' "$SERVER_IP_VALUE" | grep -Eq '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)'; then
    SERVER_MODE_VALUE="local"
  elif [ "$SERVER_IP_VALUE" != "unknown" ] && [ -n "$SERVER_IP_VALUE" ]; then
    SERVER_MODE_VALUE="public"
  else
    SERVER_MODE_VALUE="unknown"
  fi
fi

echo "=== Self-Host Stack Version ==="
printf "%-18s %s\n" "Project version:" "$PROJECT_VERSION"
if [ "$GIT_METADATA_AVAILABLE" = "1" ]; then
  printf "%-18s %s\n" "Install source:" "Git checkout"
  printf "%-18s %s\n" "Git branch:" "$GIT_BRANCH"
  printf "%-18s %s\n" "Git commit:" "$GIT_COMMIT"
  printf "%-18s %s\n" "Working tree:" "$GIT_STATE"
else
  printf "%-18s %s\n" "Install source:" "release archive / non-git install"
fi

echo
echo "=== Server config ==="
printf "%-18s %s\n" "Title:" "${SERVER_TITLE_VALUE:-unknown}"
printf "%-18s %s\n" "Region:" "${SERVER_REGION_VALUE:-unknown}"
printf "%-18s %s\n" "Mode:" "$SERVER_MODE_VALUE"
printf "%-18s %s\n" "Server IP:" "$SERVER_IP_VALUE"
printf "%-18s %s\n" "Steam app ID:" "$STEAM_APP_ID_VALUE"

echo
echo "=== Installed server build ==="
printf "%-18s %s\n" "Local build ID:" "$(steam_build_id "$STEAM_APP_ID_VALUE")"

echo
echo "=== Image tags ==="
if [ -f runtime/generated/image-tags.env ]; then
  sed -n '1,80p' runtime/generated/image-tags.env
else
  if is_running dune-director; then
    printf "%-24s %s\n" "Director image:" "$(docker inspect --format '{{.Config.Image}}' dune-director 2>/dev/null || echo unknown)"
  fi
  if is_running dune-server-gateway; then
    printf "%-24s %s\n" "Gateway image:" "$(docker inspect --format '{{.Config.Image}}' dune-server-gateway 2>/dev/null || echo unknown)"
  fi
  if is_running dune-server-overmap; then
    printf "%-24s %s\n" "Overmap image:" "$(docker inspect --format '{{.Config.Image}}' dune-server-overmap 2>/dev/null || echo unknown)"
  fi
  if is_running dune-server-survival-1; then
    printf "%-24s %s\n" "Survival_1 image:" "$(docker inspect --format '{{.Config.Image}}' dune-server-survival-1 2>/dev/null || echo unknown)"
  fi
  if ! is_running dune-director && ! is_running dune-server-gateway && ! is_running dune-server-overmap && ! is_running dune-server-survival-1; then
    echo "runtime/generated/image-tags.env not found"
  fi
fi
