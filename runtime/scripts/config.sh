#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

usage() {
  cat <<'EOF'
Usage:
  dune config title
  dune config title "New Server Name" [--yes] [--no-restart]
  dune config server-settings [--title "New Server Name"] [--mode public|local] [--yes] [--no-restart]
EOF
}

. runtime/scripts/runtime-env.sh

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

set_env_file_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  local mode="${4:-644}"
  local tmp

  mkdir -p "$(dirname "$file")"
  touch "$file"
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
  ' "$file" > "$tmp"

  mv "$tmp" "$file"
  chmod "$mode" "$file" 2>/dev/null || true
}

set_env_value() {
  local key="$1"
  local value="$2"

  set_env_file_value .env "$key" "$value" 644
}

set_generated_env_value() {
  local key="$1"
  local value="$2"

  [ -f runtime/generated/battlegroup.env ] || return 0
  set_env_file_value runtime/generated/battlegroup.env "$key" "$value" 664
}

normalize_server_mode() {
  local mode
  mode="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  case "$mode" in
    public|local)
      printf '%s' "$mode"
      ;;
    *)
      echo "Server mode must be public or local." >&2
      return 1
      ;;
  esac
}

detect_server_ip_for_mode() {
  local mode="$1"
  local ip=""

  case "$mode" in
    local)
      ip="$(detect_local_ip 2>/dev/null || true)"
      ;;
    public)
      ip="$(detect_public_ip 2>/dev/null || true)"
      ;;
  esac

  if ! is_ipv4 "$ip"; then
    echo "Could not detect a ${mode} server IP." >&2
    return 1
  fi

  printf '%s' "$ip"
}

save_server_mode() {
  local mode="$1"
  local ip="$2"

  set_env_value SERVER_IP_MODE "$mode"
  set_env_value SERVER_IP "$ip"
  set_generated_env_value SERVER_IP_MODE "$mode"
  set_generated_env_value SERVER_IP "$ip"
  echo "Updated server mode: $mode"
  echo "Updated server IP: $ip"
}

restart_running_publish_services() {
  local restarted=0

  echo
  if is_running dune-director; then
    echo "Restarting director so the updated server settings can be published..."
    runtime/scripts/dune restart director
    restarted=1
  fi
  if is_running dune-server-gateway; then
    echo "Restarting gateway so the updated server settings can be published..."
    runtime/scripts/dune restart gateway
    restarted=1
  fi
  if [ "$restarted" = "0" ]; then
    echo "Director and Gateway are stopped, so no services were restarted."
    echo "The saved settings will apply the next time the server starts."
  fi
}

restart_running_game_services() {
  local restarted=0

  echo
  if is_running dune-server-survival-1; then
    echo "Restarting Survival_1 so the updated network addresses can be used..."
    runtime/scripts/dune restart survival
    restarted=1
  fi
  if is_running dune-server-overmap; then
    echo "Restarting Overmap so the updated network addresses can be used..."
    runtime/scripts/dune restart overmap
    restarted=1
  fi
  if [ "$restarted" = "0" ]; then
    echo "Survival_1 and Overmap are stopped, so no game servers were restarted."
    echo "The saved network settings will apply the next time the server starts."
  fi
}

restart_running_network_services() {
  restart_running_publish_services
  restart_running_game_services
  runtime/scripts/network-addresses.sh reconcile || true
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
Changing the server title updates the service(s) that publish the server
name to the in-game server browser if they are already running.

New title: $new_title

Stopped services will stay stopped.
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
    set_generated_env_value SERVER_TITLE "$new_title"
    echo "Updated server title: $new_title"

    # Director and Gateway both publish battlegroup metadata. Restart only the
    # services that are already running so config saves do not start a stopped stack.
    if [ "$restart_services" = "1" ]; then
      restart_running_publish_services
    fi

    echo
    echo "Title change complete."
    ;;
  server-settings)
    shift || true
    assume_yes=0
    restart_services=1
    new_title=""
    new_mode=""

    while [ "$#" -gt 0 ]; do
      case "$1" in
        --title)
          shift || true
          new_title="${1:-}"
          ;;
        --mode)
          shift || true
          new_mode="$(normalize_server_mode "${1:-}")"
          ;;
        --yes|-y)
          assume_yes=1
          ;;
        --no-restart)
          restart_services=0
          ;;
        *)
          echo "Unknown server settings option: $1"
          usage
          exit 2
          ;;
      esac
      shift || true
    done

    if [ -z "$new_title" ] && [ -z "$new_mode" ]; then
      echo "No server settings were provided."
      exit 1
    fi
    if [ -n "$new_title" ]; then
      if [ "${#new_title}" -gt 80 ]; then
        echo "Server title must be 80 characters or fewer."
        exit 1
      fi
      case "$new_title" in
        *$'\n'*|*$'\r'*)
          echo "Server title cannot contain line breaks."
          exit 1
          ;;
      esac
    fi

    detected_ip=""
    if [ -n "$new_mode" ]; then
      detected_ip="$(detect_server_ip_for_mode "$new_mode")"
    fi

    cat <<EOF
Changing server settings updates the service(s) that publish the server
details to the in-game server browser if they are already running.

EOF
    [ -n "$new_title" ] && echo "New title: $new_title"
    if [ -n "$new_mode" ]; then
      echo "New mode:  $new_mode"
      echo "New IP:    $detected_ip"
    fi

    cat <<'EOF'

Stopped services will stay stopped.
EOF

    if [ "$restart_services" = "0" ]; then
      cat <<'EOF'

--no-restart was provided. The settings will be saved, but no services will restart.
To apply them later, run:
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

    if [ -n "$new_title" ]; then
      set_env_value SERVER_TITLE "$new_title"
      set_generated_env_value SERVER_TITLE "$new_title"
      echo "Updated server title: $new_title"
    fi
    if [ -n "$new_mode" ]; then
      save_server_mode "$new_mode" "$detected_ip"
      runtime/scripts/network-addresses.sh reconcile || true
      runtime/scripts/local-loopback-optimize.sh || true
    fi

    if [ "$restart_services" = "1" ]; then
      if [ -n "$new_mode" ]; then
        restart_running_network_services
      else
        restart_running_publish_services
      fi
    fi

    echo
    echo "Server settings change complete."
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
