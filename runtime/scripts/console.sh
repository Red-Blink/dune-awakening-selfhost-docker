#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

WEB_COMPOSE="docker-compose.web.yml"
WEB_SERVICE="redblink-dune-docker-console"
PROJECT_NAME="${DUNE_COMPOSE_PROJECT_NAME:-dune-awakening-selfhost-docker}"
HOST_ROOT="${DUNE_HOST_REPO_ROOT:-$(pwd -P)}"

usage() {
  cat <<'EOF'
Usage:
  dune console restart
  dune console status

Commands:
  restart   Rebuild and restart the Dune Docker Console safely.
  status    Show the Dune Docker Console container and URL.
EOF
}

detect_web_console_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i=1; i<=NF; i++) if ($i == "src") { print $(i + 1); exit } }' || true)"
  fi
  if [ -z "$ip" ] && command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -Ev '^(127\.|169\.254\.|172\.17\.|172\.18\.|172\.19\.|172\.2[0-9]\.|172\.3[0-1]\.)' | head -n1 || true)"
  fi
  printf '%s' "${ip:-127.0.0.1}"
}

web_console_port() {
  local port="${ADMIN_BIND_PORT:-}"
  if [ -z "$port" ] && [ -f .env ]; then
    port="$(awk -F= '/^ADMIN_BIND_PORT=/ {print $2; exit}' .env | tr -d '[:space:]"'\''' || true)"
  fi
  printf '%s' "${port:-8088}"
}

print_url() {
  echo "Open Dune Docker Console in your browser:"
  echo "  http://$(detect_web_console_ip):$(web_console_port)"
}

persist_env_value() {
  local key="$1"
  local value="$2"
  local env_file=".env"
  local tmp_file

  touch "$env_file"
  tmp_file="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    $0 ~ "^" key "=" {
      print key "=" value
      found = 1
      next
    }
    { print }
    END {
      if (!found) {
        print key "=" value
      }
    }
  ' "$env_file" >"$tmp_file"
  mv "$tmp_file" "$env_file"
}

prepare_docker_socket_gid() {
  if [ -z "${DOCKER_SOCKET_GID:-}" ] && [ -S /var/run/docker.sock ] && command -v stat >/dev/null 2>&1; then
    DOCKER_SOCKET_GID="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || true)"
  fi
  export DOCKER_SOCKET_GID="${DOCKER_SOCKET_GID:-0}"
  persist_env_value DOCKER_SOCKET_GID "$DOCKER_SOCKET_GID"
}

prepare_host_user_ids() {
  export DUNE_HOST_UID="${DUNE_HOST_UID:-$(id -u)}"
  export DUNE_HOST_GID="${DUNE_HOST_GID:-$(id -g)}"
}

require_compose() {
  if [ ! -f "$WEB_COMPOSE" ]; then
    echo "Missing $WEB_COMPOSE. Run this from the repo root."
    exit 1
  fi
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is not available."
    exit 1
  fi
}

restart_console() {
  require_compose
  prepare_docker_socket_gid
  prepare_host_user_ids
  mkdir -p runtime/generated
  echo "Rebuilding Dune Docker Console..."
  COMPOSE_PROJECT_NAME="$PROJECT_NAME" DUNE_HOST_REPO_ROOT="$HOST_ROOT" docker compose -f "$WEB_COMPOSE" build "$WEB_SERVICE"
  echo "Replacing Dune Docker Console container..."
  docker rm -f "$WEB_SERVICE" >/dev/null 2>&1 || true
  COMPOSE_PROJECT_NAME="$PROJECT_NAME" DUNE_HOST_REPO_ROOT="$HOST_ROOT" docker compose -f "$WEB_COMPOSE" up -d "$WEB_SERVICE"
  echo "Dune Docker Console restarted."
  print_url
}

status_console() {
  require_compose
  prepare_docker_socket_gid
  prepare_host_user_ids
  docker ps -a --filter "name=^/${WEB_SERVICE}$" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
  print_url
}

cmd="${1:-help}"
case "$cmd" in
  restart|rebuild)
    restart_console
    ;;
  status|url)
    status_console
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    echo "Unknown console command: $cmd"
    usage
    exit 1
    ;;
esac
