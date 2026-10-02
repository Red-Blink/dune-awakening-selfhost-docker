#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

COMPOSE_FILE="docker-compose.tls-front.yml"
STATE_DIR="runtime/generated/tls-front"
ENV_FILE="runtime/generated/tls-front.env"
BUILD_STATE="runtime/generated/tls-front-build.sha256"
CONTAINER="dune-tls-front"
PROJECT="dune-tls-front"
IMAGE="dune-tls-front:dev"
DEFAULT_PORT=8797

usage() {
  cat <<'EOF2'
Usage:
  tls-front.sh enable       turn the encrypted API access on and start it
  tls-front.sh disable      turn it off and stop it
  tls-front.sh reconcile    start or stop it according to runtime/generated/tls-front.env
  tls-front.sh status
  tls-front.sh fingerprint  print the key fingerprint (sha256/..., not secret)

The encrypted front door is HTTPS with its own long-lived key in front of the
unchanged Console. Clients pin the key's fingerprint: compare it with the one
shown here before you accept it. TCP port 8797 must be
allowed by the host firewall to use it from other computers.
EOF2
}

load_env() {
  DUNE_TLS_FRONT_ENABLED=false
  DUNE_TLS_FRONT_PORT="$DEFAULT_PORT"
  DUNE_TLS_FRONT_BIND="0.0.0.0"
  DUNE_TLS_FRONT_NAMES=""
  DUNE_TLS_FRONT_ALLOW=""
  if [ -r "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    . "$ENV_FILE"
  fi
  case "$DUNE_TLS_FRONT_PORT" in
    ''|*[!0-9]*) echo "Invalid DUNE_TLS_FRONT_PORT in $ENV_FILE." >&2; exit 1 ;;
  esac
}

write_env() {
  local enabled="$1" tmp
  mkdir -p runtime/generated
  tmp="${ENV_FILE}.tmp-$$"
  {
    echo "DUNE_TLS_FRONT_ENABLED=$enabled"
    echo "DUNE_TLS_FRONT_PORT=$DUNE_TLS_FRONT_PORT"
    echo "DUNE_TLS_FRONT_BIND=$DUNE_TLS_FRONT_BIND"
    echo "DUNE_TLS_FRONT_NAMES=$DUNE_TLS_FRONT_NAMES"
    echo "DUNE_TLS_FRONT_ALLOW=$DUNE_TLS_FRONT_ALLOW"
  } >"$tmp"
  chmod 600 "$tmp" 2>/dev/null || true
  mv "$tmp" "$ENV_FILE"
}

console_port() {
  local port="${ADMIN_WEB_PORT:-${ADMIN_BIND_PORT:-}}"
  if [ -z "$port" ] && [ -f .env ]; then
    port="$(awk -F= '/^(ADMIN_BIND_PORT|ADMIN_WEB_PORT)=/ {print $2; exit}' .env | tr -d '[:space:]"'\''' || true)"
  fi
  printf '%s' "${port:-8088}"
}

compose() {
  DUNE_HOST_REPO_ROOT="${DUNE_HOST_REPO_ROOT:-$(pwd -P)}" \
    DUNE_HOST_UID="${DUNE_HOST_UID:-$(id -u)}" \
    DUNE_HOST_GID="${DUNE_HOST_GID:-$(id -g)}" \
    DUNE_TLS_FRONT_PORT="$DUNE_TLS_FRONT_PORT" \
    DUNE_TLS_FRONT_BIND="$DUNE_TLS_FRONT_BIND" \
    DUNE_TLS_FRONT_NAMES="$DUNE_TLS_FRONT_NAMES" \
    DUNE_TLS_FRONT_ALLOW="$DUNE_TLS_FRONT_ALLOW" \
    DUNE_TLS_FRONT_CONSOLE_PORT="$(console_port)" \
    COMPOSE_PROJECT_NAME="$PROJECT" \
    docker compose -f "$COMPOSE_FILE" "$@"
}

start_front() {
  local current_hash saved_hash=""
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR" 2>/dev/null || true
  current_hash="$(
    sha256sum \
      runtime/tls-front/Dockerfile \
      runtime/tls-front/go.mod \
      runtime/tls-front/main.go |
      sha256sum |
      awk '{print $1}'
  )"
  [ -r "$BUILD_STATE" ] && saved_hash="$(tr -d '[:space:]' <"$BUILD_STATE")"
  if [ "$current_hash" != "$saved_hash" ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    compose build dune-tls-front
    printf '%s\n' "$current_hash" >"$BUILD_STATE"
    chmod 600 "$BUILD_STATE" 2>/dev/null || true
  fi
  compose up -d --force-recreate
}

stop_front() {
  if [ -f "$COMPOSE_FILE" ] && docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    compose down --remove-orphans
  fi
}

cert_fingerprint() {
  local cert="$STATE_DIR/front-cert.pem"
  if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    local pin
    pin="$(docker exec "$CONTAINER" /usr/local/bin/dune-tls-front -pin 2>/dev/null || true)"
    if [ -n "$pin" ]; then printf '%s\n' "$pin"; return 0; fi
  fi
  [ -r "$cert" ] || return 1
  command -v openssl >/dev/null 2>&1 || return 1
  printf 'sha256/%s\n' "$(
    openssl x509 -in "$cert" -pubkey -noout |
      openssl pkey -pubin -outform der |
      openssl dgst -sha256 -binary |
      base64 | tr '+/' '-_' | tr -d '=\n'
  )"
}

wait_for_fingerprint() {
  local attempt=1
  while [ "$attempt" -le 30 ]; do
    if cert_fingerprint 2>/dev/null; then return 0; fi
    sleep 1
    attempt=$((attempt + 1))
  done
  return 1
}

status_front() {
  load_env
  if ! docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "State: $([ "$DUNE_TLS_FRONT_ENABLED" = "true" ] && echo "enabled, not running" || echo "disabled")"
    return
  fi
  docker inspect "$CONTAINER" --format 'State: {{.State.Status}}{{if .State.Health}} health={{.State.Health.Status}}{{end}}'
  echo "Port: $DUNE_TLS_FRONT_PORT/tcp"
  echo "Fingerprint: $(cert_fingerprint 2>/dev/null || echo unknown)"
}

case "${1:-status}" in
  enable)
    load_env
    write_env true
    start_front
    wait_for_fingerprint >/dev/null || true
    status_front
    ;;
  disable)
    load_env
    write_env false
    stop_front
    echo "State: disabled"
    ;;
  reconcile)
    load_env
    if [ "$DUNE_TLS_FRONT_ENABLED" = "true" ]; then start_front; else stop_front; fi
    ;;
  status) status_front ;;
  fingerprint)
    cert_fingerprint || { echo "No fingerprint yet: the encrypted API access has not been started." >&2; exit 1; }
    ;;
  help|--help|-h) usage ;;
  *) usage >&2; exit 2 ;;
esac
