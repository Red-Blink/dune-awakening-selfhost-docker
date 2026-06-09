#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

usage() {
  cat <<'EOF'
Usage:
  dune config title
  dune config title "New Server Name" [--yes] [--no-restart]
EOF
}

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

current_server_title() {
  local title=""

  for title in \
    "$(config_value .env SERVER_TITLE 2>/dev/null || true)" \
    "$(container_env_value dune-director BATTLEGROUP_TITLE 2>/dev/null || true)" \
    "$(container_env_value dune-server-gateway gateway_display_name 2>/dev/null || true)"
  do
    if value_is_known "$title"; then
      printf '%s' "$title"
      return 0
    fi
  done

  printf '%s' "unknown"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local tmp

  touch .env
  tmp="$(mktemp)"

  awk -F= -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    $1 == key {
      gsub(/"/, "\\\"", value)
      print key "=\"" value "\""
      found = 1
      next
    }
    { print }
    END {
      if (!found) {
        gsub(/"/, "\\\"", value)
        print key "=\"" value "\""
      }
    }
  ' .env > "$tmp"

  mv "$tmp" .env
  chmod 644 .env
}

cmd="${1:-help}"

case "$cmd" in
  title)
    shift || true
    assume_yes=0
    restart_services=1
    title_parts=()

    while [ "$#" -gt 0 ]; do
      case "$1" in
        --yes|-y)
          assume_yes=1
          ;;
        --no-restart)
          restart_services=0
          ;;
        *)
          title_parts+=("$1")
          ;;
      esac
      shift
    done

    if [ "${#title_parts[@]}" -eq 0 ]; then
      echo "Current server title: $(current_server_title)"
      exit 0
    fi

    new_title="${title_parts[*]}"
    if [ -z "$new_title" ]; then
      echo "Server title cannot be empty."
      exit 1
    fi

    cat <<EOF
Changing the server title requires restarting the service(s) that publish
the server name to the in-game server browser.

New title: $new_title

This will restart:
  - director
  - gateway
EOF

    if [ "$restart_services" = "0" ]; then
      cat <<'EOF'

--no-restart was provided. The title will be saved, but no services will restart.
To apply it later, run:
  dune restart director
  dune restart gateway
EOF
    fi

    echo
    if [ "$assume_yes" != "1" ]; then
      read -r -p "Continue? [y/N]: " answer
      case "$answer" in
        y|Y|yes|YES) ;;
        *) echo "Cancelled. No changes were made."; exit 1 ;;
      esac
    fi

    set_env_value SERVER_TITLE "$new_title"
    echo "Updated server title: $new_title"

    # Director and Gateway both publish battlegroup metadata. Restart both so
    # title changes republish immediately without relying on stale cached env.
    if [ "$restart_services" = "1" ]; then
      echo
      echo "Restarting director and gateway so the new title can be published..."
      runtime/scripts/dune restart director
      runtime/scripts/dune restart gateway
    fi

    echo
    echo "Title change complete."
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    echo "Unknown config command: $cmd"
    usage
    exit 2
    ;;
esac
