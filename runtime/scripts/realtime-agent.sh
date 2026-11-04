#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

COMPOSE_FILE="docker-compose.realtime-agent.yml"
ENV_FILE="runtime/generated/realtime-agent.env"
CONTAINER="dune-realtime-agent"
PROJECT="dune-realtime-agent"
IMAGE="dune-realtime-agent:dev"

usage() {
  cat <<'EOF2'
Usage:
  realtime-agent.sh enable     build the Realtime Data position agent and start it
  realtime-agent.sh disable    stop it and remove the container and image
  realtime-agent.sh reconcile  start or stop it according to runtime/generated/realtime-agent.env
  realtime-agent.sh status

The agent (mvagent) reads live game objects from the game server processes. It
runs as root with ptrace rights and listens on 127.0.0.1:8796 only. See
docs/console/realtime.md.
EOF2
}

load_env() {
  DUNE_REALTIME_AGENT_ENABLED=false
  if [ -r "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    . "$ENV_FILE"
  fi
}

preserve_host_owner() {
  if [ "$(id -u)" = "0" ] && [[ "${DUNE_HOST_UID:-}" =~ ^[0-9]+$ ]] && [[ "${DUNE_HOST_GID:-}" =~ ^[0-9]+$ ]]; then
    chown "$DUNE_HOST_UID:$DUNE_HOST_GID" "$1"
  fi
}

write_env() {
  local enabled="$1" tmp
  mkdir -p runtime/generated
  tmp="${ENV_FILE}.tmp-$$"
  printf 'DUNE_REALTIME_AGENT_ENABLED=%s\n' "$enabled" >"$tmp"
  chmod 600 "$tmp" 2>/dev/null || true
  mv "$tmp" "$ENV_FILE"
  preserve_host_owner "$ENV_FILE"
}

compose() {
  COMPOSE_PROJECT_NAME="$PROJECT" docker compose -f "$COMPOSE_FILE" "$@"
}

start_agent() {
  compose build dune-realtime-agent
  compose up -d --force-recreate
}

stop_agent() {
  if [ -f "$COMPOSE_FILE" ] && docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    compose down --remove-orphans
  fi
}

# Seconds to wait for the agent to answer after the start (default 30).
wait_for_agent() {
  local attempt=1 limit="${DUNE_REALTIME_AGENT_WAIT_SECONDS:-30}"
  case "$limit" in ''|*[!0-9]*) limit=30 ;; esac
  while [ "$attempt" -le "$limit" ]; do
    if curl -fsS --max-time 2 http://127.0.0.1:8796/healthz >/dev/null 2>&1; then return 0; fi
    sleep 1
    attempt=$((attempt + 1))
  done
  return 1
}

status_agent() {
  load_env
  if ! docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "State: $([ "$DUNE_REALTIME_AGENT_ENABLED" = "true" ] && echo "enabled, not running" || echo "disabled")"
    return
  fi
  docker inspect "$CONTAINER" --format 'State: {{.State.Status}}'
}

case "${1:-status}" in
  enable)
    write_env true
    start_agent
    # A start that never becomes healthy is a failure, not a success: the Console
    # and the CLI must not report the agent as set up when it is not answering.
    if ! wait_for_agent; then
      echo "The agent did not answer on 127.0.0.1:8796 in time. $(status_agent)" >&2
      echo "Inspect it with: docker logs $CONTAINER" >&2
      exit 1
    fi
    status_agent
    ;;
  disable)
    write_env false
    stop_agent
    docker image rm "$IMAGE" >/dev/null 2>&1 || true
    echo "State: disabled"
    ;;
  reconcile)
    load_env
    if [ "$DUNE_REALTIME_AGENT_ENABLED" = "true" ]; then start_agent; else stop_agent; fi
    ;;
  status) status_agent ;;
  help|--help|-h) usage ;;
  *) usage >&2; exit 2 ;;
esac
