#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

DUNE="runtime/scripts/dune"
USERSETTINGS_PY="runtime/scripts/usersettings.py"
ADMIN_ITEMS_FILE="runtime/data/admin-items.json"
ADMIN_VEHICLES_FILE="runtime/data/admin-vehicles.json"
ADMIN_SKILL_MODULES_FILE="runtime/data/admin-skill-modules.json"
source runtime/scripts/runtime-env.sh
MENU_INTERRUPTED=0
ACTION_CANCELLED=0
MENU_CHOICE=""
MENU_ACTIVE_TTY=""
MENU_ALT_SCREEN_ACTIVE=0
MENU_CURSOR_HIDDEN=0
ADMIN_SELECTION_CANCELLED=0

restore_menu_tty() {
  if [ "${MENU_CURSOR_HIDDEN:-0}" -eq 1 ] && [ -t 2 ]; then
    printf '\033[?25h' >&2
    MENU_CURSOR_HIDDEN=0
  fi
  if [ "${MENU_ALT_SCREEN_ACTIVE:-0}" -eq 1 ] && [ -t 2 ]; then
    printf '\033[?1049l' >&2
    MENU_ALT_SCREEN_ACTIVE=0
    printf '\033[H\033[J' >&2
  fi
  if [ -n "${MENU_ACTIVE_TTY:-}" ]; then
    if [ -t 0 ] && [ -r /dev/tty ]; then
      stty "$MENU_ACTIVE_TTY" < /dev/tty 2>/dev/null || stty "$MENU_ACTIVE_TTY" 2>/dev/null || stty sane < /dev/tty 2>/dev/null || stty sane 2>/dev/null || true
    else
      stty "$MENU_ACTIVE_TTY" 2>/dev/null || stty sane 2>/dev/null || true
    fi
    MENU_ACTIVE_TTY=""
  else
    if [ -t 0 ] && [ -r /dev/tty ]; then
      stty sane < /dev/tty 2>/dev/null || stty sane 2>/dev/null || true
    else
      stty sane 2>/dev/null || true
    fi
  fi
}

cleanup_manager() {
  restore_menu_tty
}

handle_manager_int() {
  restore_menu_tty
  echo
  echo "Goodbye."
  exit 130
}

trap handle_manager_int INT
trap cleanup_manager EXIT HUP TERM

if [ -t 2 ]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[92m'
  C_YELLOW=$'\033[33m'
  C_CYAN=$'\033[36m'
else
  C_RESET=""
  C_BOLD=""
  C_DIM=""
  C_RED=""
  C_GREEN=""
  C_YELLOW=""
  C_CYAN=""
fi

info() { echo "${C_CYAN}$*${C_RESET}"; }
warn() { echo "${C_YELLOW}$*${C_RESET}"; }
error_msg() { echo "${C_RED}$*${C_RESET}"; }
ok_msg() { echo "${C_GREEN}$*${C_RESET}"; }

map_info_value() {
  local map="$1"
  local field="$2"
  "$DUNE" sietches show "$map" 2>/dev/null | awk -F': ' -v field="$field" '$1 == field { print $2; exit }'
}

map_available_partition_count() {
  local map="$1"
  "$DUNE" sietches dimensions "$map" --ids 2>/dev/null | sed '/^$/d' | wc -l | tr -d '[:space:]'
}

sanitize_prompt_value() {
  # Interactive reads can carry a trailing carriage return depending on TTY mode.
  printf '%s' "$1" | tr -d '\r'
}

sanitize_numeric_prompt_value() {
  # Drop control characters and surrounding whitespace from menu-to-prompt transitions.
  printf '%s' "$1" | tr -d '[:cntrl:]' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

prompt_positive_integer() {
  local prompt="$1"
  local __var="$2"
  local error_text="$3"
  local value=""
  local -n __out_ref="$__var"

  prompt_text "$prompt" value || return $?
  value="$(sanitize_numeric_prompt_value "$value")"
  if ! printf '%s' "$value" | grep -Eq '^[1-9][0-9]*$'; then
    error_msg "$error_text"
    return 1
  fi

  __out_ref="$value"
}

pause() {
  if [ "${ACTION_CANCELLED:-0}" -eq 1 ]; then
    ACTION_CANCELLED=0
    return
  fi
  echo
  prompt_text "Press Enter to return to menu..." _pause allow-empty >/dev/null || true
}

admin_back_to_menu() {
  ACTION_CANCELLED=1
  ADMIN_SELECTION_CANCELLED=1
}

clear_screen() {
  if [ -t 2 ]; then
    printf '\033[H\033[J' >&2
  fi
}

runtime_partition_catalog_path() {
  printf '%s' "runtime/generated/partition-catalog.json"
}

runtime_server_catalog_path() {
  printf '%s' "runtime/generated/server-catalog.json"
}

runtime_catalogs_available() {
  [ -s "$(runtime_partition_catalog_path)" ] || [ -s "$(runtime_server_catalog_path)" ]
}

battlegroup_services_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -Eq '^(dune-rmq-admin|dune-rmq-game|dune-text-router|dune-director|dune-server-gateway|dune-server-survival-1|dune-server-overmap)$'
}

show_runtime_files_status() {
  local partition_catalog server_catalog
  partition_catalog="$(runtime_partition_catalog_path)"
  server_catalog="$(runtime_server_catalog_path)"

  echo "=== Runtime Files Status ==="
  echo

  if [ -s "$partition_catalog" ]; then
    echo "OK   $partition_catalog"
  else
    echo "MISS $partition_catalog"
  fi

  if [ -s "$server_catalog" ]; then
    echo "OK   $server_catalog"
  else
    echo "MISS $server_catalog"
  fi

  echo
  if runtime_catalogs_available; then
    echo "Runtime map catalogs are present."
    echo "Map selection and memory menus should work normally."
  else
    echo "Runtime map catalogs are missing."
    echo "Map selection and some manager map actions will not work until they are rebuilt."
  fi
}

repair_runtime_files() {
  echo "=== Repair Runtime Files ==="
  echo
  echo "This rebuilds the generated map catalogs from the installed server files."
  echo "It does not run dune init or redeploy the battlegroup."
  echo
  runtime/scripts/extract-server-catalog.sh
  runtime/scripts/extract-partition-catalog.sh
  echo
  show_runtime_files_status

  if ! battlegroup_services_running; then
    echo
    echo "Battlegroup services are not running."
    echo "Starting the battlegroup now so the repaired runtime files can be used."
    echo
    "$DUNE" start
  fi
}

read_choice() {
  local prompt="${1:-Select An Option: }"
  local choice

  read -r -p "$prompt" choice || {
    echo
    echo "Exit."
    exit 0
  }

  printf '%s' "$choice"
}

prompt_text() {
  local prompt="$1"
  local __var="$2"
  local allow_empty="${3:-}"
  local value=""
  local rc
  local -n __out_ref="$__var"

  MENU_INTERRUPTED=0
  trap 'MENU_INTERRUPTED=1' INT
  set +e
  read -r -p "$prompt " value
  rc=$?
  set -e
  trap handle_manager_int INT
  if [ "$rc" -ne 0 ]; then
    if [ "$MENU_INTERRUPTED" -eq 1 ] || [ "$rc" -ge 128 ]; then
      MENU_INTERRUPTED=0
      ACTION_CANCELLED=1
      echo
      echo "Cancelled."
      return 130
    fi
    return 1
  fi

  if [ -z "$value" ] && [ "$allow_empty" != "allow-empty" ]; then
    echo "Value is required."
    return 1
  fi

  value="$(sanitize_prompt_value "$value")"
  __out_ref="$value"
}

prompt_secret() {
  local prompt="$1"
  local __var="$2"
  local allow_empty="${3:-}"
  local value=""
  local rc
  local -n __out_ref="$__var"

  MENU_INTERRUPTED=0
  trap 'MENU_INTERRUPTED=1' INT
  set +e
  read -r -s -p "$prompt " value
  rc=$?
  set -e
  trap handle_manager_int INT
  if [ "$rc" -ne 0 ]; then
    if [ "$MENU_INTERRUPTED" -eq 1 ] || [ "$rc" -ge 128 ]; then
      MENU_INTERRUPTED=0
      ACTION_CANCELLED=1
      echo
      echo "Cancelled."
      return 130
    fi
    return 1
  fi
  echo

  if [ -z "$value" ] && [ "$allow_empty" != "allow-empty" ]; then
    echo "Value is required."
    return 1
  fi

  value="$(sanitize_prompt_value "$value")"
  __out_ref="$value"
}

select_menu() {
  local title="$1"
  shift
  local options=("$@")
  local selected=0
  local key rest i
  local old_tty=""
  local read_rc
  local initialized=0

  if [ "${#options[@]}" -eq 0 ]; then
    return 1
  fi

  if [ ! -t 0 ] || [ ! -t 2 ]; then
    local choice
    echo "${C_BOLD}${C_CYAN}$title${C_RESET}" >&2
    printf '%*s\n' "${#title}" '' | tr ' ' '=' >&2
    if [ -n "${MENU_CONTEXT_TEXT:-}" ]; then
      echo >&2
      printf '%s\n' "$MENU_CONTEXT_TEXT" >&2
    fi
    echo >&2
    for i in "${!options[@]}"; do
      printf " %2d) %s\n" "$((i + 1))" "${options[$i]}" >&2
    done
    echo >&2
    choice="$(read_choice)"
    if ! printf '%s' "$choice" | grep -Eq '^[1-9][0-9]*$'; then
      return 1
    fi
    if [ "$choice" -lt 1 ] || [ "$choice" -gt "${#options[@]}" ]; then
      return 1
    fi
    MENU_CHOICE="$choice"
    return 0
  fi

  old_tty="$(stty -g < /dev/tty 2>/dev/null || stty -g 2>/dev/null || true)"
  if [ -n "$old_tty" ]; then
    MENU_ACTIVE_TTY="$old_tty"
    stty -echo -icanon min 1 time 0 < /dev/tty 2>/dev/null || stty -echo -icanon min 1 time 0 2>/dev/null || true
  fi

  while true; do
    if [ "$initialized" -eq 0 ] && [ -t 2 ]; then
      printf '\033[?1049h\033[?25l' >&2
      MENU_ALT_SCREEN_ACTIVE=1
      MENU_CURSOR_HIDDEN=1
      initialized=1
    fi
    printf '\033[H' >&2
    echo "${C_BOLD}${C_CYAN}$title${C_RESET}" >&2
    printf '%*s\n' "${#title}" '' | tr ' ' '=' >&2
    echo >&2
    if [ -n "${MENU_CONTEXT_TEXT:-}" ]; then
      printf '%s\n' "$MENU_CONTEXT_TEXT" >&2
      echo >&2
    fi
    for i in "${!options[@]}"; do
      if [ "$i" -eq "$selected" ]; then
        printf '  %s[X]%s %s%s%s\n' "$C_GREEN" "$C_RESET" "$C_BOLD" "${options[$i]}" "$C_RESET" >&2
      else
        printf '  %s[ ]%s %s\n' "$C_DIM" "$C_RESET" "${options[$i]}" >&2
      fi
    done
    echo >&2
    echo "${C_CYAN}Use Up And Down, Enter To Select. Use Back To Return.${C_RESET}" >&2
    echo "${C_GREEN}This project is free and community-supported.${C_RESET}" >&2
    echo "${C_GREEN}If it's useful to you, please consider supporting its development.${C_RESET}" >&2
    echo "${C_GREEN}Keep it alive: https://ko-fi.com/redblink${C_RESET}" >&2
    printf '\033[J' >&2

    MENU_INTERRUPTED=0
    set +e
    IFS= read -rsn1 key < /dev/tty
    read_rc=$?
    set -e
    if [ "$read_rc" -ne 0 ]; then
      restore_menu_tty
      if [ "$MENU_INTERRUPTED" -eq 1 ] || [ "$read_rc" -ge 128 ]; then
        echo
        echo "Goodbye."
        exit 130
      fi
      return 1
    fi

    case "$key" in
      "")
        restore_menu_tty
        MENU_CHOICE="$((selected + 1))"
        return 0
        ;;
      $'\x03')
        restore_menu_tty
        echo
        echo "Goodbye."
        exit 130
        ;;
      $'\x1b')
        rest=""
        IFS= read -rsn2 -t 0.1 rest < /dev/tty || true
        case "$rest" in
          "[A")
            selected=$((selected - 1))
            [ "$selected" -lt 0 ] && selected=$((${#options[@]} - 1))
            ;;
          "[B")
            selected=$((selected + 1))
            [ "$selected" -ge "${#options[@]}" ] && selected=0
            ;;
        esac
        ;;
      k|K)
        selected=$((selected - 1))
        [ "$selected" -lt 0 ] && selected=$((${#options[@]} - 1))
        ;;
      j|J)
        selected=$((selected + 1))
        [ "$selected" -ge "${#options[@]}" ] && selected=0
        ;;
    esac
  done
}

menu_or_back() {
  local title="$1"
  shift

  set +e
  select_menu "$title" "$@"
  local rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    if [ "$rc" -eq 130 ]; then
      return 130
    fi
    echo "Invalid selection." >&2
    sleep 1
    return 1
  fi

  return 0
}

confirm() {
  local prompt="$1"
  local answer

  prompt_text "$prompt [y/N]:" answer allow-empty || return $?
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

run_cmd() {
  echo

  set +e
  "$@"
  local rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    echo
    echo "Command exited with status $rc."
  fi
}

run_cmd_allow_codes() {
  local allowed_csv="$1"
  shift
  local rc

  echo

  set +e
  "$@"
  rc=$?
  set -e

  case ",$allowed_csv," in
    *,"$rc",*)
      return 0
      ;;
  esac

  echo
  echo "Command exited with status $rc."
  return "$rc"
}

run_cmd_status() {
  echo

  set +e
  "$@"
  local rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    echo
    echo "Command exited with status $rc."
  fi

  return "$rc"
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

set_env_value() {
  local key="$1"
  local value="$2"
  local tmp

  touch .env
  tmp="$(mktemp)"
  awk -F= -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    $1 == key {
      print key "=" value
      found = 1
      next
    }
    { print }
    END {
      if (!found) print key "=" value
    }
  ' .env > "$tmp"
  mv "$tmp" .env
  chmod 644 .env
}

is_ipv4() {
  printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
}

is_private_ipv4() {
  local ip="$1"
  printf '%s' "$ip" | grep -Eq '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)'
}

detect_public_ip() {
  local ip=""

  if command -v curl >/dev/null 2>&1; then
    for url in \
      "https://api.ipify.org" \
      "https://ipv4.icanhazip.com" \
      "https://ifconfig.me/ip"
    do
      ip="$(curl -fsS4 --max-time 8 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
      if is_ipv4 "$ip"; then
        printf '%s' "$ip"
        return 0
      fi
    done
  fi

  if command -v wget >/dev/null 2>&1; then
    for url in \
      "https://api.ipify.org" \
      "https://ipv4.icanhazip.com"
    do
      ip="$(wget -qO- -T 8 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
      if is_ipv4 "$ip"; then
        printf '%s' "$ip"
        return 0
      fi
    done
  fi

  return 1
}

detect_lan_ip() {
  local ip=""

  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '
      {
        for (i = 1; i <= NF; i++) {
          if ($i == "src") {
            print $(i + 1)
            exit
          }
        }
      }
    ' | tr -d '[:space:]' || true)"

    if is_private_ipv4 "$ip"; then
      printf '%s' "$ip"
      return 0
    fi
  fi

  if command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' | head -n1 || true)"
    if is_private_ipv4 "$ip"; then
      printf '%s' "$ip"
      return 0
    fi
  fi

  return 1
}

detect_player_ip_for_mode() {
  local mode="$1"

  case "$mode" in
    public) detect_public_ip ;;
    local) detect_lan_ip ;;
    *) return 1 ;;
  esac
}

verify_player_ip_before_battlegroup_action() {
  local configured_ip
  local mode
  local current_ip
  configured_ip="$(resolve_server_ip)"
  mode="$(first_known_value "$(config_value .env SERVER_IP_MODE 2>/dev/null || true)" "${SERVER_IP_MODE:-}" || true)"

  if [ -z "$mode" ] || [ "$mode" = "unknown" ]; then
    if value_is_known "$configured_ip"; then
      if is_private_ipv4 "$configured_ip"; then
        mode="local"
      else
        mode="public"
      fi
    fi
  fi

  if ! value_is_known "$configured_ip" || [ -z "$mode" ] || [ "$mode" = "unknown" ]; then
    echo "Could not resolve the player-facing IP or IP mode from the current config/runtime state."
    if confirm "Continue anyway"; then
      return 0
    fi
    echo "Cancelled. Battlegroup was not started."
    return 1
  fi

  echo
  echo "Checking player-facing IP before starting the battlegroup..."
  current_ip="$(detect_player_ip_for_mode "$mode" || true)"

  if [ -z "$current_ip" ]; then
    echo
    echo "Could not detect the current player-facing IP."
    if confirm "Continue with configured IP $configured_ip"; then
      return 0
    fi
    echo "Cancelled. Battlegroup was not started."
    return 1
  fi

  if [ "$current_ip" = "$configured_ip" ]; then
    echo "OK player-facing IP is unchanged: $configured_ip"
    return 0
  fi

  cat <<EOF

The battlegroup player-facing IP appears to have changed.

Configured IP: $configured_ip
Current IP:    $current_ip
Mode:          $mode
EOF

  set_env_value SERVER_IP "$current_ip"
  echo "Updated SERVER_IP=$current_ip"
  echo "Continuing with the detected player-facing IP."
  return 0
}

persist_runtime_identity_snapshot() {
  local battlegroup_id server_title server_region server_ip existing_battlegroup_id

  battlegroup_id="$(resolve_battlegroup_id 2>/dev/null || true)"
  server_title="$(resolve_server_title 2>/dev/null || true)"
  server_region="$(resolve_server_region 2>/dev/null || true)"
  server_ip="$(resolve_server_ip 2>/dev/null || true)"
  existing_battlegroup_id="$(config_value runtime/generated/battlegroup.env BATTLEGROUP_ID 2>/dev/null || true)"

  if { [ -z "$battlegroup_id" ] || [ "$battlegroup_id" = "unknown" ] || [ "$battlegroup_id" = "dune-docker" ]; } \
    && [ -n "$existing_battlegroup_id" ] \
    && [ "$existing_battlegroup_id" != "unknown" ] \
    && [ "$existing_battlegroup_id" != "dune-docker" ]; then
    battlegroup_id="$existing_battlegroup_id"
  fi

  mkdir -p runtime/generated
  {
    printf 'BATTLEGROUP_ID=%q\n' "${battlegroup_id:-dune-docker}"
    printf 'SERVER_TITLE=%q\n' "${server_title:-My Dune Server}"
    printf 'SERVER_REGION=%q\n' "${server_region:-Europe}"
    printf 'SERVER_IP=%q\n' "${server_ip:-auto}"
  } > runtime/generated/battlegroup.env
  chmod 664 runtime/generated/battlegroup.env 2>/dev/null || true
}

show_config_summary() {
  echo
  echo "=== Current Configuration ==="

  local title region mode server_ip steam_app battlegroup

  title="$(resolve_server_title)"
  region="$(resolve_server_region)"
  server_ip="$(resolve_server_ip)"
  steam_app="$(first_known_value "$(config_value .env STEAM_APP_ID 2>/dev/null || true)" "${STEAM_APP_ID:-}" "4754530" || echo "4754530")"
  battlegroup="$(first_known_value \
    "$(config_value runtime/generated/battlegroup.env BATTLEGROUP_ID 2>/dev/null || true)" \
    "$(container_env_value_any_state dune-director BATTLEGROUP 2>/dev/null || true)" \
    "$(container_env_value_any_state dune-server-gateway BATTLEGROUP 2>/dev/null || true)" \
    "$(container_env_value_any_state dune-server-overmap BATTLEGROUP 2>/dev/null || true)" \
    "$(container_env_value_any_state dune-server-survival-1 BATTLEGROUP 2>/dev/null || true)" \
    || true)"
  mode="$(first_known_value "$(config_value .env SERVER_IP_MODE 2>/dev/null || true)" "${SERVER_IP_MODE:-}" || true)"
  if [ -z "$mode" ] || [ "$mode" = "unknown" ]; then
    if value_is_known "$server_ip"; then
      if is_private_ipv4 "$server_ip"; then
        mode="local"
      else
        mode="public"
      fi
    else
      mode="unknown"
    fi
  fi

  printf "%-14s %s\n" "Title:" "${title:-unknown}"
  printf "%-14s %s\n" "Region:" "${region:-unknown}"
  printf "%-14s %s\n" "Mode:" "$mode"
  printf "%-14s %s\n" "Server IP:" "${server_ip:-unknown}"
  printf "%-14s %s\n" "Steam app:" "$steam_app"
  if [ -n "$battlegroup" ]; then
    printf "%-14s %s\n" "Battlegroup:" "$battlegroup"
  else
    printf "%-14s %s\n" "Battlegroup:" "not generated yet"
  fi
}

show_image_tags() {
  echo
  echo "=== Generated Image Tags ==="

  if [ -f runtime/generated/image-tags.env ]; then
    sed -n '1,80p' runtime/generated/image-tags.env
  else
    echo "runtime/generated/image-tags.env does not exist yet."
  fi
}

show_battlegroup_id() {
  echo
  echo "=== Battlegroup ID ==="

  if [ -f runtime/generated/battlegroup.env ]; then
    config_value runtime/generated/battlegroup.env BATTLEGROUP_ID || echo "Could not read battlegroup ID."
  else
    echo "runtime/generated/battlegroup.env does not exist yet."
  fi
}

show_world_partition_count() {
  echo
  echo "=== World Partition Count ==="

  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-postgres; then
    echo "dune-postgres is not running."
    return
  fi

  docker exec dune-postgres psql -U dune -d dune -c "select count(*) as world_partition_rows from world_partition;"
}

show_current_memory_usage() {
  local containers=()
  local container
  local stats_line
  local name
  local mem_usage
  local map
  local partition_id
  local db_row
  local label
  local dim

  mapfile -t containers < <(docker ps --format '{{.Names}}' 2>/dev/null | grep '^dune-server-' || true)

  echo
  echo "=== Current Memory Usage ==="

  if [ "${#containers[@]}" -eq 0 ]; then
    echo "No game server containers are currently running."
    return
  fi

  printf "%-24s %-12s %-12s %s\n" "MAP" "PARTITION" "MEMORY" "CONTAINER"

  for container in "${containers[@]}"; do
    stats_line="$(docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}' "$container" 2>/dev/null | head -n1 || true)"
    [ -n "$stats_line" ] || continue

    name="${stats_line%%$'\t'*}"
    mem_usage="${stats_line#*$'\t'}"
    map="Unknown"
    partition_id="-"

    case "$name" in
      dune-server-survival-1)
        map="Survival_1"
        partition_id="1"
        ;;
      dune-server-overmap)
        map="Overmap"
        partition_id="2"
        ;;
      *)
        if [[ "$name" =~ -([0-9]+)$ ]]; then
          partition_id="${BASH_REMATCH[1]}"
          if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-postgres; then
            db_row="$(docker exec dune-postgres psql -U postgres -d dune -At -F $'\t' -c "select map,coalesce(label,''),coalesce(dimension_index::text,'') from dune.world_partition where partition_id = ${partition_id} limit 1;" 2>/dev/null || true)"
            if [ -n "$db_row" ]; then
              IFS=$'\t' read -r map label dim <<< "$db_row"
              if [ -n "$label" ]; then
                map="${map} (${label})"
              elif [ -n "$dim" ]; then
                map="${map} (dim ${dim})"
              fi
            fi
          fi
        fi
        ;;
    esac

    printf "%-24s %-12s %-12s %s\n" "$map" "$partition_id" "$mem_usage" "$name"
  done
}

follow_dune_logs() {
  local target="$1"

  echo
  echo "Following logs for: $target"
  echo "Press Ctrl+C to stop following logs and return to the manager."
  echo

  set +e
  trap ':' INT
  bash -c 'trap - INT; exec "$@"' bash "$DUNE" logs "$target"
  local rc=$?
  trap - INT
  set -e

  if [ "$rc" -ne 0 ] && [ "$rc" -ne 130 ]; then
    echo
    echo "Log command exited with status $rc."
  fi
}

show_header() {
  echo "Dune Awakening Self-Host Docker Manager"
  echo "======================================="
  echo
  echo "Choose a category. Direct CLI commands like 'dune ready' still work normally."
  echo
}

not_available_yet() {
  local feature="$1"
  local reason="$2"

  echo
  echo "Not Available Yet: $feature"
  echo "$reason"
}

choose_sietch_map() {
  local choice
  local maps=()
  local labels=()

  mapfile -t maps < <("$DUNE" sietches --names)
  if [ "${#maps[@]}" -eq 0 ]; then
    echo "No maps found."
    return 1
  fi

  labels=("${maps[@]}" "Back")
  menu_or_back "Pick Map" "${labels[@]}" || return 1
  choice="$MENU_CHOICE"
  if [ "$choice" -eq "${#labels[@]}" ]; then
    return 1
  fi

  CHOSEN_SIETCH_MAP="${maps[$((choice - 1))]}"
  [ -n "$CHOSEN_SIETCH_MAP" ] || return 1
}

change_memory_for_map() {
  local map="$1"
  local memory_value

  echo
  prompt_text "Memory Value For $map, Example 8g Or 4096m:" memory_value || return

  echo
  echo "If this map is currently running, the relevant map container may restart so the new limit can apply."
  if confirm "Change memory for $map to $memory_value?"; then
    run_cmd env DUNE_MEMORY_ASSUME_YES=1 "$DUNE" memory set "$map" "$memory_value"
  else
    echo "Cancelled."
  fi
}

remove_memory_for_map() {
  local map="$1"
  echo
  echo "If this map is currently running, the relevant map container may restart so the change can apply."
  if confirm "Remove memory override for $map?"; then
    run_cmd env DUNE_MEMORY_ASSUME_YES=1 "$DUNE" memory unset "$map"
  else
    echo "Cancelled."
  fi
}

restore_builtin_memory_defaults() {
  local changes=()
  local line kind target value

  mapfile -t changes < <(python3 - <<'PY'
import json
import re
from pathlib import Path

env = {}
env_path = Path(".env")
if env_path.exists():
    for raw in env_path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip()

catalog = []
catalog_path = Path("runtime/generated/server-catalog.json")
if catalog_path.exists():
    try:
        catalog = json.loads(catalog_path.read_text())
    except Exception:
        catalog = []

def normalize(name: str) -> str:
    return re.sub(r"[^A-Z0-9]+", "_", name.upper()).strip("_")

seen_keys = set()
for row in catalog:
    name = str(row.get("map", "")).strip()
    if not name:
        continue
    env_key = f"DUNE_MEMORY_{normalize(name)}"
    if env_key in env:
        print(f"map\t{name}\t{env[env_key]}")
        seen_keys.add(env_key)

if "DUNE_MEMORY_DEFAULT" in env:
    print(f"default\tdefault\t{env['DUNE_MEMORY_DEFAULT']}")
    seen_keys.add("DUNE_MEMORY_DEFAULT")

for key, value in env.items():
    if key.startswith("DUNE_MEMORY_") and key not in seen_keys:
        print(f"raw\t{key}\t{value}")
PY
  )

  if [ "${#changes[@]}" -eq 0 ]; then
    echo "No custom memory settings are configured."
    return
  fi

  echo
  echo "This will remove custom memory overrides and restore built-in per-map defaults."
  echo
  for line in "${changes[@]}"; do
    IFS=$'\t' read -r kind target value <<< "$line"
    case "$kind" in
      map) printf "%s\n" "  $target: $value -> catalog default" ;;
      default) printf "%s\n" "  global default: $value -> removed" ;;
      raw) printf "%s\n" "  $target: $value -> removed" ;;
    esac
  done
  echo

  if ! confirm "Restore built-in memory defaults now?"; then
    echo "Cancelled."
    return
  fi

  for line in "${changes[@]}"; do
    IFS=$'\t' read -r kind target value <<< "$line"
    case "$kind" in
      map)
        run_cmd env DUNE_MEMORY_ASSUME_YES=1 "$DUNE" memory unset "$target"
        ;;
      default)
        run_cmd env DUNE_MEMORY_ASSUME_YES=1 "$DUNE" memory unset default
        ;;
      raw)
        python3 - "$target" <<'PY'
import sys
from pathlib import Path

target = sys.argv[1]
env_path = Path(".env")
if not env_path.exists():
    raise SystemExit(0)

lines = env_path.read_text().splitlines()
filtered = [line for line in lines if not line.startswith(f"{target}=")]
output = "\n".join(filtered)
if output:
    output += "\n"
env_path.write_text(output)
PY
        echo "Removed $target"
        ;;
    esac
  done
}

set_max_dimensions_for_map() {
  local map="$1"
  local max_dimensions=""

  if [ "$map" = "Overmap" ]; then
    warn "Overmap must remain at one dimension."
    return
  fi

  prompt_text "New Max Dimensions For $map:" max_dimensions || return
  max_dimensions="$(sanitize_numeric_prompt_value "$max_dimensions")"
  if ! printf '%s' "$max_dimensions" | grep -Eq '^[1-9][0-9]*$'; then
    error_msg "Max dimensions must be a positive integer."
    return 1
  fi

  echo
  echo "Maximum number of world partitions or servers this map can have."
  if confirm "Set max dimensions for $map to $max_dimensions?"; then
    if run_cmd_status "$DUNE" sietches set-max "$map" "$max_dimensions"; then
      info "This applies to future dynamic spawns and starts. Existing running containers are not restarted automatically."
    fi
  else
    echo "Cancelled."
  fi
}

set_active_dimensions_for_map() {
  local map="$1"
  local active_dimensions=""
  local max_dimensions=""

  if [ "$map" = "Overmap" ]; then
    warn "Overmap active dimensions are fixed at 1."
    return
  fi

  prompt_text "New Active Dimensions For $map:" active_dimensions || return
  active_dimensions="$(sanitize_numeric_prompt_value "$active_dimensions")"
  if ! printf '%s' "$active_dimensions" | grep -Eq '^[1-9][0-9]*$'; then
    error_msg "Active dimensions must be a positive integer."
    return 1
  fi
  max_dimensions="$(map_info_value "$map" "Max dimensions")"
  max_dimensions="$(sanitize_numeric_prompt_value "$max_dimensions")"
  if printf '%s' "$max_dimensions" | grep -Eq '^[1-9][0-9]*$' && [ "$active_dimensions" -gt "$max_dimensions" ]; then
    error_msg "Max dimensions for $map are currently $max_dimensions. Increase max dimensions first if you want more active dimensions."
    return 1
  fi

  echo
  echo "Active dimensions control how many non-dedicated dimensions should be active when supported."
  if confirm "Set active dimensions for $map to $active_dimensions?"; then
    if run_cmd_status "$DUNE" sietches set-active "$map" "$active_dimensions"; then
      info "Active dimensions are reconciled immediately. Extra dimensions may spawn or stop now to match the requested count."
    fi
  else
    echo "Cancelled."
  fi
}

declare -A USERSETTINGS_VALUES

load_usersettings_values() {
  local scope="$1"
  shift
  local rows=()
  local row key value

  USERSETTINGS_VALUES=()
  case "$scope" in
    engine)
      mapfile -t rows < <(python3 "$USERSETTINGS_PY" engine-values 2>/dev/null || true)
      ;;
    map)
      mapfile -t rows < <(python3 "$USERSETTINGS_PY" map-values "$1" 2>/dev/null || true)
      ;;
    partition)
      mapfile -t rows < <(python3 "$USERSETTINGS_PY" partition-values "$1" "$2" 2>/dev/null || true)
      ;;
    *)
      return 1
      ;;
  esac

  for row in "${rows[@]}"; do
    IFS=$'\t' read -r key value <<< "$row"
    [ -n "${key:-}" ] || continue
    USERSETTINGS_VALUES["$key"]="$value"
  done
}

usersettings_value() {
  local key="$1"
  printf '%s' "${USERSETTINGS_VALUES[$key]:-unknown}"
}

userengine_about_text() {
  cat <<'EOF'
; Settings in these config files will be applied to every server in the battlegroup
; If you need to override different settings for different servers, use the partition editor instead
EOF
}

usergame_about_text() {
  cat <<'EOF'
; Settings in these config files will be applied only to this partition, and they will override the UserEngine settings.
EOF
}

refresh_usersettings_runtime_files() {
  if ! python3 "$USERSETTINGS_PY" materialize-current >/dev/null 2>&1; then
    warn "Saved the override, but could not refresh the current UserEngine.ini/UserGame.ini files."
    warn "This usually means an old runtime file has restrictive ownership or permissions."
  fi
}

save_userengine_field() {
  local field_id="$1"
  local value="$2"
  if run_cmd_status python3 "$USERSETTINGS_PY" engine-set "$field_id" "$value"; then
    refresh_usersettings_runtime_files
    ok_msg "Global UserEngine setting updated."
    info "Running map server containers keep the old values until they are restarted."
  fi
}

save_usergame_field() {
  local map="$1"
  local field_id="$2"
  local value="$3"
  local partition_id="${4:-}"
  if [ -n "$partition_id" ]; then
    if run_cmd_status python3 "$USERSETTINGS_PY" partition-set "$map" "$partition_id" "$field_id" "$value"; then
      refresh_usersettings_runtime_files
      ok_msg "UserGame setting updated for $map partition $partition_id."
      restart_partition_if_requested "$map" "$partition_id"
    fi
    return
  fi
  if run_cmd_status python3 "$USERSETTINGS_PY" map-set "$map" "$field_id" "$value"; then
    refresh_usersettings_runtime_files
    ok_msg "Map-specific UserGame setting updated for $map."
    info "Running containers for $map keep the old values until that map is restarted or respawned."
  fi
}

prompt_usersettings_number() {
  local prompt="$1"
  local kind="$2"
  local value=""

  while true; do
    read -r -p "$prompt " value || { USERSETTINGS_INPUT_CANCELLED=1; return; }
    value="$(printf '%s' "$value" | tr -d '[:cntrl:]' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    case "$value" in
      ""|"/back")
        USERSETTINGS_INPUT_CANCELLED=1
        USERSETTINGS_INPUT_VALUE=""
        return
        ;;
    esac
    case "$kind" in
      int)
        if printf '%s' "$value" | grep -Eq '^[0-9]+$'; then
          USERSETTINGS_INPUT_CANCELLED=0
          USERSETTINGS_INPUT_VALUE="$value"
          return
        fi
        echo "Please enter a whole number."
        ;;
      float)
        if printf '%s' "$value" | grep -Eq '^[0-9]+([.][0-9]+)?$'; then
          USERSETTINGS_INPUT_CANCELLED=0
          USERSETTINGS_INPUT_VALUE="$value"
          return
        fi
        echo "Please enter a numeric value."
        ;;
      *)
        USERSETTINGS_INPUT_CANCELLED=1
        return
        ;;
    esac
  done
}

choose_usersettings_boolean() {
  local title="$1"
  local current="$2"
  local true_label="$3"
  local false_label="$4"
  local true_value="$5"
  local false_value="$6"
  local choice

  MENU_CONTEXT_TEXT="Current: $current"
  menu_or_back "$title" "$true_label" "$false_label" "Back" || { MENU_CONTEXT_TEXT=""; return 1; }
  MENU_CONTEXT_TEXT=""
  choice="$MENU_CHOICE"

  case "$choice" in
    1) CHOSEN_BOOL_VALUE="$true_value"; return 0 ;;
    2) CHOSEN_BOOL_VALUE="$false_value"; return 0 ;;
    *) return 1 ;;
  esac
}

edit_userengine_numeric_field() {
  local field_id="$1"
  local prompt="$2"
  local kind="$3"

  prompt_usersettings_number "$prompt" "$kind"
  if [ "${USERSETTINGS_INPUT_CANCELLED:-0}" = "1" ]; then
    info "No changes made."
    return
  fi
  save_userengine_field "$field_id" "$USERSETTINGS_INPUT_VALUE"
}

edit_userengine_port_field() {
  local field_id="$1"
  local title="$2"

  echo
  echo "$title"
  echo "; The port that servers listen to for other servers. Each server"
  echo "; will use the next available port in a sequence (7888, 7889 etc.). The range should"
  echo "; not intersect with the Port range above."
  echo
  prompt_usersettings_number "New value (/back to cancel):" int
  if [ "${USERSETTINGS_INPUT_CANCELLED:-0}" = "1" ]; then
    info "No changes made."
    return
  fi
  save_userengine_field "$field_id" "$USERSETTINGS_INPUT_VALUE"
}

edit_usergame_numeric_field() {
  local map="$1"
  local field_id="$2"
  local prompt="$3"
  local kind="$4"
  local partition_id="${5:-}"

  prompt_usersettings_number "$prompt" "$kind"
  if [ "${USERSETTINGS_INPUT_CANCELLED:-0}" = "1" ]; then
    info "No changes made."
    return
  fi
  save_usergame_field "$map" "$field_id" "$USERSETTINGS_INPUT_VALUE" "$partition_id"
}

edit_usergame_text_field() {
  local map="$1"
  local field_id="$2"
  local prompt="$3"
  local partition_id="${4:-}"
  local value=""

  prompt_text "$prompt" value allow-empty || return
  value="$(sanitize_prompt_value "$value")"
  if [ -z "$value" ] || [ "$value" = "/back" ]; then
    info "No changes made."
    return
  fi
  save_usergame_field "$map" "$field_id" "$value" "$partition_id"
}

edit_userengine_boolean_field() {
  local field_id="$1"
  local title="$2"
  local true_label="$3"
  local false_label="$4"
  local true_value="$5"
  local false_value="$6"
  local current

  current="$(usersettings_value "$field_id")"
  echo
  choose_usersettings_boolean "$title" "$current" "$true_label" "$false_label" "$true_value" "$false_value" || {
    info "No changes made."
    return
  }
  save_userengine_field "$field_id" "$CHOSEN_BOOL_VALUE"
}

edit_usergame_boolean_field() {
  local map="$1"
  local field_id="$2"
  local title="$3"
  local true_label="$4"
  local false_label="$5"
  local true_value="$6"
  local false_value="$7"
  local partition_id="${8:-}"
  local current

  current="$(usersettings_value "$field_id")"
  echo
  choose_usersettings_boolean "$title" "$current" "$true_label" "$false_label" "$true_value" "$false_value" || {
    info "No changes made."
    return
  }
  save_usergame_field "$map" "$field_id" "$CHOSEN_BOOL_VALUE" "$partition_id"
}

edit_usergame_config_field() {
  local map="$1"
  local partition_id="$2"
  local field_id="$3"
  local label="$4"
  local kind="$5"

  case "$kind" in
    bool)
      edit_usergame_boolean_field "$map" "$field_id" "Set $label" "True" "False" "True" "False" "$partition_id"
      ;;
    bool-lower)
      edit_usergame_boolean_field "$map" "$field_id" "Set $label" "true" "false" "true" "false" "$partition_id"
      ;;
    int)
      edit_usergame_numeric_field "$map" "$field_id" "New $label (/back to cancel):" int "$partition_id"
      ;;
    float)
      edit_usergame_numeric_field "$map" "$field_id" "New $label (/back to cancel):" float "$partition_id"
      ;;
    text)
      edit_usergame_text_field "$map" "$field_id" "New $label (/back to cancel):" "$partition_id"
      ;;
  esac
}

edit_userengine_config_field() {
  local field_id="$1"
  local label="$2"
  local kind="$3"

  case "$kind" in
    bool)
      edit_userengine_boolean_field "$field_id" "Set $label" "True" "False" "True" "False"
      ;;
    bool-lower)
      edit_userengine_boolean_field "$field_id" "Set $label" "true" "false" "true" "false"
      ;;
    int)
      edit_userengine_numeric_field "$field_id" "New $label (/back to cancel):" int
      ;;
    float)
      edit_userengine_numeric_field "$field_id" "New $label (/back to cancel):" float
      ;;
    text)
      local value=""
      prompt_text "New $label (/back to cancel):" value allow-empty || return
      value="$(sanitize_prompt_value "$value")"
      if [ -z "$value" ] || [ "$value" = "/back" ]; then
        info "No changes made."
        return
      fi
      save_userengine_field "$field_id" "$value"
      ;;
  esac
}

edit_userengine_category_menu() {
  local title="$1"
  shift
  local entries=("$@")
  local labels=()
  local entry field_id label kind choice

  while true; do
    load_usersettings_values engine

    labels=()
    for entry in "${entries[@]}"; do
      IFS='|' read -r field_id label kind <<< "$entry"
      labels+=("$label  Current: $(usersettings_value "$field_id")")
    done
    labels+=("Back")

    MENU_CONTEXT_TEXT="$(userengine_about_text)"
    menu_or_back "$title" "${labels[@]}" || return
    MENU_CONTEXT_TEXT=""
    choice="$MENU_CHOICE"
    if [ "$choice" -gt "${#entries[@]}" ]; then
      return
    fi

    entry="${entries[$((choice - 1))]}"
    IFS='|' read -r field_id label kind <<< "$entry"
    edit_userengine_config_field "$field_id" "$label" "$kind"
    pause
  done
}

edit_usergame_category_menu() {
  local map="$1"
  local partition_id="$2"
  local title="$3"
  shift 3
  local entries=("$@")
  local labels=()
  local entry field_id label kind choice

  while true; do
    if [ -n "$partition_id" ]; then
      load_usersettings_values partition "$map" "$partition_id"
    else
      load_usersettings_values map "$map"
    fi

    labels=()
    for entry in "${entries[@]}"; do
      IFS='|' read -r field_id label kind <<< "$entry"
      labels+=("$label  Current: $(usersettings_value "$field_id")")
    done
    labels+=("Back")

    MENU_CONTEXT_TEXT="$(usergame_about_text "$map" "$partition_id")"
    menu_or_back "$title" "${labels[@]}" || return
    MENU_CONTEXT_TEXT=""
    choice="$MENU_CHOICE"
    if [ "$choice" -gt "${#entries[@]}" ]; then
      return
    fi

    entry="${entries[$((choice - 1))]}"
    IFS='|' read -r field_id label kind <<< "$entry"
    edit_usergame_config_field "$map" "$partition_id" "$field_id" "$label" "$kind"
    pause
  done
}

reset_all_usersettings() {
  echo
  echo "This removes all custom UserEngine and UserGame overrides."
  echo "The battlegroup will go back to the built-in default values."
  echo "Running maps keep their current values until they are restarted."
  if run_cmd_status python3 "$USERSETTINGS_PY" reset-all; then
    refresh_usersettings_runtime_files
    ok_msg "All UserEngine/UserGame overrides were removed."
    info "Restart running maps to apply the default values again."
  fi
}

edit_userengine_menu() {
  local choice

  while true; do
    load_usersettings_values engine
    MENU_CONTEXT_TEXT="$(userengine_about_text)"
    menu_or_back "Edit UserEngine (Global Defaults)" \
      "Port  Current: $(usersettings_value port)" \
      "IGWPort  Current: $(usersettings_value igw_port)" \
      "Engine Console Variables" \
      "PvP / Security" \
      "Storms / Building" \
      "Progression / Economy" \
      "Harvesting / Crafting" \
      "Survival / Combat" \
      "World / Guilds / Vehicles" \
      "Inventory / Sandworms / Patrol Ships" \
      "Back" || return
    MENU_CONTEXT_TEXT=""
    choice="$MENU_CHOICE"

    case "$choice" in
      1) edit_userengine_port_field port "Port"; pause ;;
      2) edit_userengine_port_field igw_port "IGWPort"; pause ;;
      3)
        edit_userengine_category_menu "UserEngine Console Variables" \
          "mining_output_multiplier|Mining Output Multiplier|float" \
          "vehicle_mining_output_multiplier|Vehicle Mining Multiplier|float" \
          "pvp_resource_multiplier|PvP Resource Multiplier|float" \
          "vehicle_durability_damage_multiplier|Vehicle Durability Damage|float" \
          "sandstorm_enabled|Sandstorm Enabled|bool-lower" \
          "sandstorm_treasure_enabled|Sandstorm Treasure Enabled|bool-lower" \
          "sandworm_enabled|Sandworm Enabled|bool-lower" \
          "sandworm_collision_interaction|Sandworm Collision Interaction|bool-lower" \
          "sandworm_danger_zones_enabled|Sandworm Danger Zones Enabled|bool-lower" \
          "sandworm_invulnerability_on_exit|Sandworm Invulnerability On Exit|float" \
          "sandworm_invulnerability_on_restart|Sandworm Invulnerability On Restart|float"
        ;;
      4)
        edit_userengine_category_menu "UserEngine PvP / Security" \
          "force_pvp_all_partitions|Force PvP On All Partitions|bool" \
          "security_zones_enabled|Security Zones Enabled|bool" \
          "legacy_pvp_enabled|Legacy bPvPEnabled|bool" \
          "server_pve|Server PvE|bool"
        ;;
      5)
        edit_userengine_category_menu "UserEngine Storms / Building" \
          "coriolis_auto_spawn_enabled|Coriolis Storm Enabled|bool" \
          "storm_cycle_duration|Storm Cycle Duration|int" \
          "storm_duration|Storm Duration|int" \
          "storm_warning_duration|Storm Warning Duration|int" \
          "storm_cycle_wait|Storm Cycle Wait|int" \
          "max_landclaim_segments|Max Landclaim Segments|int" \
          "building_blueprint_max_extensions|Building Blueprint Max Extensions|int" \
          "base_backup_max_extensions|Base Backup Max Extensions|int" \
          "building_restriction_limits_enabled|Building Restriction Limits Enabled|bool"
        ;;
      6)
        edit_userengine_category_menu "UserEngine Progression / Economy" \
          "global_xp_multiplier|Global XP Multiplier|float" \
          "global_fame_multiplier|Global Fame Multiplier|float" \
          "global_progression_speed_multiplier|Global Progression Speed Multiplier|float" \
          "guild_settings_creation_cost|Guild Creation Cost|int" \
          "sell_order_price_percentage_fee|Sell Order Price Percentage Fee|float" \
          "spice_tax_amount|Spice Tax Amount|float" \
          "spice_tax_interval|Spice Tax Interval|int"
        ;;
      7)
        edit_userengine_category_menu "UserEngine Harvesting / Crafting" \
          "global_harvest_amount_multiplier|Global Harvest Amount Multiplier|float" \
          "global_harvest_health_multiplier|Global Harvest Health Multiplier|float" \
          "cutteray_hem_multiplier_per_node_tier_table|Cutteray Hem Multiplier Per Node Tier Table|float" \
          "minimum_augmentable_item_quality|Minimum Augmentable Item Quality|int" \
          "item_durability_loss_multiplier|Item Durability Loss Multiplier|float" \
          "item_deterioration_rate|Item Deterioration Rate|float"
        ;;
      8)
        edit_userengine_category_menu "UserEngine Survival / Combat" \
          "water_consumption_rate|Water Consumption Rate|float" \
          "water_consumption_in_storm_multiplier|Water Consumption In Storm Multiplier|float" \
          "global_damage_to_npcs_multiplier|Global Damage To NPCs Multiplier|float" \
          "global_damage_to_players_multiplier|Global Damage To Players Multiplier|float" \
          "global_health_multiplier|Global Health Multiplier|float" \
          "global_building_damage_multiplier|Global Building Damage Multiplier|float" \
          "building_decay_rate_multiplier|Building Decay Rate Multiplier|float" \
          "enable_building_stability|Enable Building Stability|bool" \
          "inventory_weight_multiplier|Inventory Weight Multiplier|float" \
          "player_starting_water|Player Starting Water|float" \
          "default_reconnect_grace_period_seconds|Default Reconnect Grace Period Seconds|int"
        ;;
      9)
        edit_userengine_category_menu "UserEngine World / Guilds / Vehicles" \
          "cycle_duration_in_days|Cycle Duration In Days|int" \
          "db_wipe_enabled|DB Wipe Enabled|bool" \
          "guild_settings_max_guild_members_allowed|Max Guild Members Allowed|int" \
          "guild_settings_max_guilds_allowed|Max Guilds Allowed|int" \
          "guild_settings_max_pending_invites|Max Pending Guild Invites|int" \
          "max_permissions_per_actor|Max Permissions Per Actor|int" \
          "vehicle_quicksand_damage|Vehicle Quicksand Damage|float"
        ;;
      10)
        edit_userengine_category_menu "UserEngine Inventory / Sandworms / Patrol Ships" \
          "player_inventory_starting_size|Player Inventory Starting Size|int" \
          "player_inventory_starting_volume_capacity|Player Inventory Starting Volume Capacity|float" \
          "sandworm_system|Sandworm System|text" \
          "worm_detection_distance|Worm Detection Distance|float" \
          "min_worm_spawn_interval|Min Worm Spawn Interval|float" \
          "min_distance_between_sandworms|Min Distance Between Sandworms|float" \
          "sandworm_quicksand_speed_modifier|Sandworm Quicksand Speed Modifier|float" \
          "patrol_ship_spawn_time|Patrol Ship Spawn Time|float" \
          "patrol_ship_despawn_time|Patrol Ship Despawn Time|float"
        ;;
      11) return ;;
    esac
  done
}

edit_usergame_menu() {
  local map="$1"
  local partition_id="${2:-}"
  local choice
  local title_suffix

  if [ -z "$partition_id" ]; then
    error_msg "Select a dimension/partition before editing UserGame."
    return 1
  fi

  while true; do
    title_suffix="$map"
    [ -n "$partition_id" ] && title_suffix="$map (Partition $partition_id)"
    MENU_CONTEXT_TEXT="$(usergame_about_text "$map" "$partition_id")"
    menu_or_back "Edit UserGame: $title_suffix" \
      "PvP / Security" \
      "Storms / Building" \
      "Progression / Economy" \
      "Harvesting / Crafting" \
      "Survival / Combat" \
      "World / Guilds / Vehicles" \
      "Inventory / Sandworms / Patrol Ships" \
      "Back" || return
    MENU_CONTEXT_TEXT=""
    choice="$MENU_CHOICE"

    case "$choice" in
      1)
        edit_usergame_category_menu "$map" "$partition_id" "UserGame PvP / Security: $title_suffix" \
          "partition_pvp_enabled|Partition PvP Enabled|bool" \
          "partition_pve_enabled|Partition PvE Enabled|bool" \
          "security_zones_enabled|Security Zones Enabled|bool" \
          "legacy_pvp_enabled|Legacy bPvPEnabled|bool" \
          "server_pve|Server PvE|bool"
        ;;
      2)
        edit_usergame_category_menu "$map" "$partition_id" "UserGame Storms / Building: $title_suffix" \
          "coriolis_auto_spawn_enabled|Coriolis Storm Enabled|bool" \
          "storm_cycle_duration|Storm Cycle Duration|int" \
          "storm_duration|Storm Duration|int" \
          "storm_warning_duration|Storm Warning Duration|int" \
          "storm_cycle_wait|Storm Cycle Wait|int" \
          "max_landclaim_segments|Max Landclaim Segments|int" \
          "building_blueprint_max_extensions|Building Blueprint Max Extensions|int" \
          "base_backup_max_extensions|Base Backup Max Extensions|int" \
          "building_restriction_limits_enabled|Building Restriction Limits Enabled|bool"
        ;;
      3)
        edit_usergame_category_menu "$map" "$partition_id" "UserGame Progression / Economy: $title_suffix" \
          "global_xp_multiplier|Global XP Multiplier|float" \
          "global_fame_multiplier|Global Fame Multiplier|float" \
          "global_progression_speed_multiplier|Global Progression Speed Multiplier|float" \
          "guild_settings_creation_cost|Guild Creation Cost|int" \
          "sell_order_price_percentage_fee|Sell Order Price Percentage Fee|float" \
          "spice_tax_amount|Spice Tax Amount|float" \
          "spice_tax_interval|Spice Tax Interval|int"
        ;;
      4)
        edit_usergame_category_menu "$map" "$partition_id" "UserGame Harvesting / Crafting: $title_suffix" \
          "global_harvest_amount_multiplier|Global Harvest Amount Multiplier|float" \
          "global_harvest_health_multiplier|Global Harvest Health Multiplier|float" \
          "cutteray_hem_multiplier_per_node_tier_table|Cutteray Hem Multiplier Per Node Tier Table|float" \
          "minimum_augmentable_item_quality|Minimum Augmentable Item Quality|int" \
          "item_durability_loss_multiplier|Item Durability Loss Multiplier|float" \
          "item_deterioration_rate|Item Deterioration Rate|float"
        ;;
      5)
        edit_usergame_category_menu "$map" "$partition_id" "UserGame Survival / Combat: $title_suffix" \
          "water_consumption_rate|Water Consumption Rate|float" \
          "water_consumption_in_storm_multiplier|Water Consumption In Storm Multiplier|float" \
          "global_damage_to_npcs_multiplier|Global Damage To NPCs Multiplier|float" \
          "global_damage_to_players_multiplier|Global Damage To Players Multiplier|float" \
          "global_health_multiplier|Global Health Multiplier|float" \
          "global_building_damage_multiplier|Global Building Damage Multiplier|float" \
          "building_decay_rate_multiplier|Building Decay Rate Multiplier|float" \
          "enable_building_stability|Enable Building Stability|bool" \
          "inventory_weight_multiplier|Inventory Weight Multiplier|float" \
          "player_starting_water|Player Starting Water|float" \
          "default_reconnect_grace_period_seconds|Default Reconnect Grace Period Seconds|int"
        ;;
      6)
        edit_usergame_category_menu "$map" "$partition_id" "UserGame World / Guilds / Vehicles: $title_suffix" \
          "cycle_duration_in_days|Cycle Duration In Days|int" \
          "db_wipe_enabled|DB Wipe Enabled|bool" \
          "guild_settings_max_guild_members_allowed|Max Guild Members Allowed|int" \
          "guild_settings_max_guilds_allowed|Max Guilds Allowed|int" \
          "guild_settings_max_pending_invites|Max Pending Guild Invites|int" \
          "max_permissions_per_actor|Max Permissions Per Actor|int" \
          "vehicle_quicksand_damage|Vehicle Quicksand Damage|float"
        ;;
      7)
        edit_usergame_category_menu "$map" "$partition_id" "UserGame Inventory / Sandworms / Patrol Ships: $title_suffix" \
          "player_inventory_starting_size|Player Inventory Starting Size|int" \
          "player_inventory_starting_volume_capacity|Player Inventory Starting Volume Capacity|float" \
          "sandworm_system|Sandworm System|text" \
          "worm_detection_distance|Worm Detection Distance|float" \
          "min_worm_spawn_interval|Min Worm Spawn Interval|float" \
          "min_distance_between_sandworms|Min Distance Between Sandworms|float" \
          "sandworm_quicksand_speed_modifier|Sandworm Quicksand Speed Modifier|float" \
          "patrol_ship_spawn_time|Patrol Ship Spawn Time|float" \
          "patrol_ship_despawn_time|Patrol Ship Despawn Time|float"
        ;;
      8) return ;;
    esac
  done
}

map_memory_override_present() {
  local map="$1"
  local key
  key="DUNE_MEMORY_$(printf '%s' "$map" | tr '[:lower:]' '[:upper:]' | sed 's/[^A-Z0-9]/_/g; s/__*/_/g; s/^_//; s/_$//')"
  [ -f .env ] || return 1
  grep -q "^${key}=" .env
}

map_is_dedicated_scaling() {
  [ "$(map_info_value "$1" "Type")" = "Dedicated Scaling" ]
}

map_supports_active_dimensions() {
  local map="$1"
  case "$map" in
    Survival_1|DeepDesert_1) return 0 ;;
  esac
  [ "$map" != "Overmap" ] && ! map_is_dedicated_scaling "$map"
}

show_map_dimension_details() {
  local map="$1"
  run_cmd "$DUNE" sietches dimensions "$map"
}

choose_dimension_for_map() {
  local map="$1"
  local title="$2"
  local labels=()
  local ids=()
  local choice

  mapfile -t labels < <("$DUNE" sietches dimensions "$map" --active-only --labels)
  mapfile -t ids < <("$DUNE" sietches dimensions "$map" --active-only --ids)
  if [ "${#ids[@]}" -eq 0 ]; then
    echo "No dimensions found for $map."
    return 1
  fi

  labels+=("Back")
  menu_or_back "$title" "${labels[@]}" || return 1
  choice="$MENU_CHOICE"
  if [ "$choice" -eq "${#labels[@]}" ]; then
    return 1
  fi

  CHOSEN_PARTITION_ID="${ids[$((choice - 1))]}"
}

restart_partition_if_requested() {
  local map="$1"
  local partition_id="$2"
  local safe container

  case "$map" in
    Survival_1) container="dune-server-survival-1" ;;
    Overmap) container="dune-server-overmap" ;;
    *)
      safe="$(echo "$map-$partition_id" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')"
      container="dune-server-$safe"
      ;;
  esac

  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$container" || return

  echo
  echo "The relevant map must restart for this change to apply."
  if ! confirm "Restart $map partition $partition_id now?"; then
    info "Saved. The change will apply next time this map or dimension starts."
    return
  fi

  case "$map" in
    Survival_1)
      if [ "$partition_id" = "1" ]; then
        run_cmd "$DUNE" restart survival
      else
        run_cmd "$DUNE" despawn "$partition_id"
        run_cmd "$DUNE" spawn "$partition_id"
      fi
      ;;
    Overmap) run_cmd "$DUNE" restart overmap ;;
    *)
      run_cmd "$DUNE" despawn "$partition_id"
      run_cmd "$DUNE" spawn "$partition_id"
      ;;
  esac
}

apply_survival_browser_change() {
  echo
  echo "Applying Survival_1 browser changes now."
  echo "This republishes the browser-facing sietch state without respawning servers."
  run_cmd runtime/scripts/publish-sietch-overrides.sh restart
  run_cmd runtime/scripts/publish-sietch-overrides.sh once
}

apply_survival_partition_change() {
  local partition_id="$1"

  if [ "$partition_id" = "1" ]; then
    apply_survival_browser_change
    return
  fi

  echo
  echo "Applying Survival_1 dimension browser changes now."
  echo "This republishes the selected dimension without changing its server id."
  run_cmd runtime/scripts/publish-sietch-overrides.sh restart
  run_cmd runtime/scripts/publish-sietch-overrides.sh once
}

set_display_name_for_map() {
  local map="$1"
  local partition_id display_name

  CHOSEN_PARTITION_ID=""
  choose_dimension_for_map "$map" "Pick Dimension For Display Name On $map" || return
  partition_id="$CHOSEN_PARTITION_ID"

  prompt_text "New Display Name:" display_name || return
  if confirm "Set display name for $map partition $partition_id to '$display_name'?"; then
    if run_cmd_status "$DUNE" sietches set-display "$partition_id" "$display_name"; then
      if [ "$map" = "Survival_1" ]; then
        apply_survival_partition_change "$partition_id"
      else
        restart_partition_if_requested "$map" "$partition_id"
      fi
    fi
  else
    echo "Cancelled."
  fi
}

set_password_for_map() {
  local map="$1"
  local partition_id password

  CHOSEN_PARTITION_ID=""
  choose_dimension_for_map "$map" "Pick Dimension For Password On $map" || return
  partition_id="$CHOSEN_PARTITION_ID"

  prompt_secret "New Password (leave empty to clear):" password allow-empty || return
  if [ -n "$password" ]; then
    confirm_text="Set password for $map partition $partition_id?"
  else
    confirm_text="Clear password for $map partition $partition_id?"
  fi
  if confirm "$confirm_text"; then
    echo
    echo ">>> dune sietches set-password $partition_id"
    echo
    set +e
    SIETCH_PASSWORD="$password" "$DUNE" sietches set-password "$partition_id"
    local rc=$?
    set -e
    if [ "$rc" -ne 0 ]; then
      echo
      echo "Command exited with status $rc."
      return
    fi
    if [ "$map" = "Survival_1" ]; then
      apply_survival_partition_change "$partition_id"
    else
      restart_partition_if_requested "$map" "$partition_id"
    fi
  else
    echo "Cancelled."
  fi
}

edit_survival_dimension_menu() {
  local partition_id="$1"
  local choice

  while true; do
    MENU_CONTEXT_TEXT=""
    menu_or_back "Survival_1 Dimension $partition_id Actions" \
      "Edit UserGame" \
      "Set Display Name" \
      "Set Password" \
      "Back" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) edit_usergame_menu Survival_1 "$partition_id" ;;
      2) set_display_name_for_partition Survival_1 "$partition_id"; pause ;;
      3) set_password_for_partition Survival_1 "$partition_id"; pause ;;
      4) return ;;
    esac
  done
}

set_display_name_for_partition() {
  local map="$1"
  local partition_id="$2"
  local display_name

  prompt_text "New Display Name:" display_name || return
  if confirm "Set display name for $map partition $partition_id to '$display_name'?"; then
    if run_cmd_status "$DUNE" sietches set-display "$partition_id" "$display_name"; then
      if [ "$map" = "Survival_1" ]; then
        apply_survival_partition_change "$partition_id"
      else
        restart_partition_if_requested "$map" "$partition_id"
      fi
    fi
  else
    echo "Cancelled."
  fi
}

set_password_for_partition() {
  local map="$1"
  local partition_id="$2"
  local password
  local confirm_text

  prompt_secret "New Password (leave empty to clear):" password allow-empty || return
  if [ -n "$password" ]; then
    confirm_text="Set password for $map partition $partition_id?"
  else
    confirm_text="Clear password for $map partition $partition_id?"
  fi
  if confirm "$confirm_text"; then
    echo
    echo ">>> dune sietches set-password $partition_id"
    echo
    set +e
    SIETCH_PASSWORD="$password" "$DUNE" sietches set-password "$partition_id"
    local rc=$?
    set -e
    if [ "$rc" -ne 0 ]; then
      echo
      echo "Command exited with status $rc."
      return
    fi
    if [ "$map" = "Survival_1" ]; then
      apply_survival_partition_change "$partition_id"
    else
      restart_partition_if_requested "$map" "$partition_id"
    fi
  else
    echo "Cancelled."
  fi
}

redeploy_battlegroup_flow() {
  echo
  echo "Redeploy runs dune init again."
  echo "This creates a fresh local world and resets the local Postgres database."
  echo "Existing local config/state is backed up first, but players should treat this as a reset."
  echo
  if confirm "Continue to dune init"; then
    run_cmd "$DUNE" init
  else
    echo "Cancelled."
  fi
}

valid_backup_basename() {
  printf '%s' "$1" | grep -Eq '^dune-db-([a-z0-9][a-z0-9_-]*__)?[0-9]{8}-[0-9]{6}\.(dump|sql)$|^[a-z0-9][a-z0-9_-]*-[0-9]{8}-[0-9]{6}\.backup$'
}

backup_names() {
  local backup_dir="runtime/backups/db"
  [ -d "$backup_dir" ] || return 0
  find "$backup_dir" -maxdepth 1 -type f \( -name 'dune-db-*.dump' -o -name 'dune-db-*.sql' -o -name '*.backup' \) -printf '%f\n' \
    | while IFS= read -r name; do
        valid_backup_basename "$name" && printf '%s\n' "$name"
      done \
    | sort
}

backup_count() {
  backup_names | sed '/^$/d' | wc -l | tr -d '[:space:]'
}

backup_label() {
  local name="$1"
  local path="runtime/backups/db/$name"
  local size modified

  size="$(stat -c '%s bytes' "$path" 2>/dev/null || echo unknown)"
  modified="$(stat -c '%y' "$path" 2>/dev/null | cut -d. -f1 || echo unknown)"
  printf '%s  %s  %s' "$name" "$modified" "$size"
}

copy_backup_sidecar_if_present() {
  local source_file="$1"
  local destination_dir="$2"
  local sidecar_source

  sidecar_source="${source_file}.yaml"
  if [ -f "$sidecar_source" ]; then
    cp -p -- "$sidecar_source" "$destination_dir/$(basename "$sidecar_source")"
  fi
}

clear_backup_sidecar_if_missing() {
  local source_file="$1"
  local destination_file="$2"

  if [ ! -f "${source_file}.yaml" ] && [ -f "${destination_file}.yaml" ]; then
    rm -f -- "${destination_file}.yaml"
  fi
}

choose_backup() {
  local title="$1"
  local names=()
  local labels=()
  local name choice

  mapfile -t names < <(backup_names)
  if [ "${#names[@]}" -eq 0 ]; then
    echo "No database backups found."
    return 1
  fi

  for name in "${names[@]}"; do
    labels+=("$(backup_label "$name")")
  done
  labels+=("Back")

  menu_or_back "$title" "${labels[@]}" || return 1
  choice="$MENU_CHOICE"
  if [ "$choice" -eq "${#labels[@]}" ]; then
    return 1
  fi

  CHOSEN_BACKUP="${names[$((choice - 1))]}"
}

restore_specific_backup_path() {
  local backup_path="$1"
  local backup_name="${2:-$(basename "$backup_path")}"
  local transfer_args=()

  echo
  echo "Restoring a database backup will replace the current battlegroup database."
  echo "Do not let players create new characters until the restore is verified."
  echo "Normal case: players keep the same account and no transfer is needed."
  echo "Use character transfer only for players whose FLS/Funcom account changed."
  if confirm "Restore backup '$backup_name'?"; then
    collect_transfer_args transfer_args
    run_cmd env DUNE_DB_ASSUME_YES=1 "$DUNE" db restore "$backup_path" "${transfer_args[@]}"
  else
    echo "Cancelled."
  fi
}

collect_transfer_args() {
  local __var="$1"
  local -n __out="$__var"
  local choice pair plan_file
  __out=()
  echo
  echo "Character transfers are only for players whose account identity changed."
  echo "If players are logging in with the same account as before, choose No."
  echo
  if ! confirm "Add character transfer mapping after import/restore?"; then
    return 0
  fi
  while true; do
    menu_or_back "Character Transfers After Import/Restore" \
      "Add old_fls=new_fls Pair (Changed Account Only)" \
      "Use Local Transfer Plan TSV" \
      "Continue" || return 0
    choice="$MENU_CHOICE"
    case "$choice" in
      1)
        prompt_text "Transfer Pair old_fls=new_fls:" pair || continue
        if [[ "$pair" != *=* ]]; then
          error_msg "Expected old_fls=new_fls."
          continue
        fi
        __out+=("--transfer" "$pair")
        ;;
      2)
        prompt_text "Local Transfer Plan TSV Path:" plan_file || continue
        if [ ! -f "$plan_file" ]; then
          error_msg "File not found: $plan_file"
          continue
        fi
        __out+=("--transfer-file" "$plan_file")
        ;;
      3) return 0 ;;
    esac
  done
}

import_local_backup_file_flow() {
  local source_path source_dir source_name destination_dir destination_path

  destination_dir="runtime/backups/db"
  mkdir -p "$destination_dir"

  echo
  prompt_text "Local Backup File Path:" source_path || return
  source_path="$(sanitize_prompt_value "$source_path")"
  if [ ! -f "$source_path" ]; then
    error_msg "Backup file not found: $source_path"
    return 1
  fi

  source_name="$(basename "$source_path")"
  if ! valid_backup_basename "$source_name"; then
    error_msg "Unsupported backup filename: $source_name"
    echo "Accepted: dune-db-<scope>__YYYYMMDD-HHMMSS.dump|sql or <artifact-id>-YYYYMMDD-HHMMSS.backup"
    return 1
  fi

  destination_path="$destination_dir/$source_name"
  if [ "$source_path" != "$destination_path" ]; then
    if [ -e "$destination_path" ] && ! confirm "Overwrite existing local backup '$source_name'?"; then
      echo "Cancelled."
      return 1
    fi
    clear_backup_sidecar_if_missing "$source_path" "$destination_path"
    cp -p -- "$source_path" "$destination_path"
    copy_backup_sidecar_if_present "$source_path" "$destination_dir"
  fi

  restore_specific_backup_path "$destination_path" "$source_name"
}

remote_backup_rows() {
  local remote_host="$1"
  local remote_user="$2"
  local remote_port="$3"
  local remote_dir="$4"
  local escaped_remote_dir

  escaped_remote_dir="$(printf "%s" "$remote_dir" | sed "s/'/'\\\\''/g")"
  ssh -p "$remote_port" -o ConnectTimeout=10 "$remote_user@$remote_host" \
    "find '$escaped_remote_dir' -maxdepth 2 -type f -name '*.backup' -printf '%f\t%p\n' | sort"
}

choose_remote_backup() {
  local remote_host="$1"
  local remote_user="$2"
  local remote_port="$3"
  local remote_dir="$4"
  local rows=()
  local names=()
  local paths=()
  local labels=()
  local row name path choice

  set +e
  mapfile -t rows < <(remote_backup_rows "$remote_host" "$remote_user" "$remote_port" "$remote_dir" 2>/dev/null)
  local rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    error_msg "Could not list remote backups over SSH."
    return 1
  fi

  for row in "${rows[@]}"; do
    IFS=$'\t' read -r name path <<< "$row"
    [ -n "${name:-}" ] || continue
    [ -n "${path:-}" ] || continue
    valid_backup_basename "$name" || continue
    names+=("$name")
    paths+=("$path")
    labels+=("$name  $path")
  done

  if [ "${#names[@]}" -eq 0 ]; then
    echo "No remote .backup files were found."
    return 1
  fi

  labels+=("Back")
  menu_or_back "Import Remote Backup Over SSH" "${labels[@]}" || return 1
  choice="$MENU_CHOICE"
  if [ "$choice" -eq "${#labels[@]}" ]; then
    return 1
  fi

  CHOSEN_REMOTE_BACKUP_NAME="${names[$((choice - 1))]}"
  CHOSEN_REMOTE_BACKUP_PATH="${paths[$((choice - 1))]}"
}

copy_remote_backup_to_local() {
  local remote_host="$1"
  local remote_user="$2"
  local remote_port="$3"
  local remote_path="$4"
  local destination_dir="runtime/backups/db"
  local remote_ref remote_yaml_ref local_path escaped_remote_path

  mkdir -p "$destination_dir"
  escaped_remote_path="$(printf "%s" "$remote_path" | sed "s/'/'\\\\''/g")"
  remote_ref="$remote_user@$remote_host:'$escaped_remote_path'"
  local_path="$destination_dir/$(basename "$remote_path")"

  if [ -e "$local_path" ] && ! confirm "Overwrite existing local backup '$(basename "$local_path")'?"; then
    echo "Cancelled."
    return 1
  fi

  scp -P "$remote_port" -p "$remote_ref" "$destination_dir/" || return 1

  remote_yaml_ref="$remote_user@$remote_host:'$escaped_remote_path.yaml'"
  rm -f -- "$local_path.yaml"
  scp -P "$remote_port" -p "$remote_yaml_ref" "$destination_dir/" >/dev/null 2>&1 || true

  COPIED_REMOTE_BACKUP_PATH="$local_path"
}

import_remote_backup_over_ssh_flow() {
  local remote_host remote_user remote_port remote_dir

  if ! command -v ssh >/dev/null 2>&1; then
    error_msg "ssh is required for remote database import."
    return 1
  fi
  if ! command -v scp >/dev/null 2>&1; then
    error_msg "scp is required for remote database import."
    return 1
  fi

  echo
  prompt_text "Remote Host Or IP:" remote_host || return
  prompt_text "SSH User:" remote_user || return
  prompt_text "SSH Port:" remote_port || return
  remote_port="$(sanitize_numeric_prompt_value "$remote_port")"
  if ! printf '%s' "$remote_port" | grep -Eq '^[1-9][0-9]*$'; then
    error_msg "SSH port must be a positive integer."
    return 1
  fi
  prompt_text "Remote Backup Directory:" remote_dir || return

  if ! ssh -p "$remote_port" -o ConnectTimeout=10 "$remote_user@$remote_host" "test -d '$(printf "%s" "$remote_dir" | sed "s/'/'\\\\''/g")'"; then
    error_msg "Remote backup directory does not exist or could not be accessed."
    return 1
  fi

  CHOSEN_REMOTE_BACKUP_NAME=""
  CHOSEN_REMOTE_BACKUP_PATH=""
  choose_remote_backup "$remote_host" "$remote_user" "$remote_port" "$remote_dir" || return

  if ! copy_remote_backup_to_local "$remote_host" "$remote_user" "$remote_port" "$CHOSEN_REMOTE_BACKUP_PATH"; then
    error_msg "Remote backup copy failed."
    return 1
  fi

  restore_specific_backup_path "$COPIED_REMOTE_BACKUP_PATH" "$(basename "$COPIED_REMOTE_BACKUP_PATH")"
}

import_remote_database_menu() {
  local choice
  while true; do
    menu_or_back "Import Database Backup" \
      "Import Remote Backup Over SSH" \
      "Import Local Backup File" \
      "Back" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) import_remote_backup_over_ssh_flow; return ;;
      2) import_local_backup_file_flow; return ;;
      3) return ;;
    esac
  done
}

restore_backup_flow() {
  local backup

  CHOSEN_BACKUP=""
  if ! choose_backup "Restore A Database Backup"; then
    return 0
  fi
  backup="$CHOSEN_BACKUP"

  restore_specific_backup_path "runtime/backups/db/$backup" "$backup"
}

delete_backup_flow() {
  local backup

  CHOSEN_BACKUP=""
  if ! choose_backup "Delete A Backup"; then
    return 0
  fi
  backup="$CHOSEN_BACKUP"

  echo
  if confirm "Delete backup '$backup'? This cannot be undone."; then
    run_cmd env DUNE_DB_ASSUME_YES=1 "$DUNE" db delete "runtime/backups/db/$backup"
  else
    echo "Cancelled."
  fi
}

delete_all_backups_flow() {
  local count answer

  count="$(backup_count)"
  if [ "${count:-0}" -eq 0 ]; then
    echo "No database backups found."
    return
  fi

  echo
  echo "Database backups found: $count"
  prompt_text "Delete ALL database backups? Type DELETE to confirm:" answer allow-empty || return
  if [ "$answer" = "DELETE" ]; then
    run_cmd env DUNE_DB_ASSUME_YES=1 "$DUNE" db delete --all
  else
    echo "Cancelled."
  fi
}

admin_items_available() {
  if [ ! -r "$ADMIN_ITEMS_FILE" ]; then
    error_msg "Missing readable item dataset: $ADMIN_ITEMS_FILE"
    echo "Admin Tools requires the vendored item dataset."
    return 1
  fi
}

admin_validate_quantity() {
  local quantity="$1"
  if ! printf '%s' "$quantity" | grep -Eq '^[1-9][0-9]*$'; then
    error_msg "Quantity must be a positive integer."
    return 1
  fi
}

admin_validate_durability() {
  local durability="$1"
  python3 - "$durability" <<'PY'
import sys
try:
    value = float(sys.argv[1])
except ValueError:
    raise SystemExit(1)
raise SystemExit(0 if 0 <= value <= 1 else 1)
PY
}

admin_item_category_rows() {
  python3 - "$ADMIN_ITEMS_FILE" <<'PY'
import json
import sys
from collections import Counter

items_path = sys.argv[1]
with open(items_path, encoding="utf-8") as f:
    items = json.load(f)

counts = Counter(str(item.get("category") or "uncategorized") for item in items)
print("Templates\ttemplates\t1")
for category, count in sorted(counts.items(), key=lambda row: row[0].casefold()):
    label = category[:1].upper() + category[1:]
    print(f"{label}\t{category}\t{count}")
PY
}

admin_items_by_category_rows() {
  local category="$1"
  python3 - "$ADMIN_ITEMS_FILE" "$category" <<'PY'
import json
import sys

items_path, category = sys.argv[1], sys.argv[2]
wanted = category.casefold()

if wanted == "templates":
    print("\t".join(["TEMPLATE_SCOUT_ORNITHOPTER_MK6", "Scout Ornithopter Mk6", "Templates", "Template"]))
    raise SystemExit(0)

with open(items_path, encoding="utf-8") as f:
    items = json.load(f)

rows = [
    item for item in items
    if str(item.get("category") or "uncategorized").casefold() == wanted
]

for item in sorted(rows, key=lambda value: (str(value.get("source") or "").casefold(), str(value.get("name") or "").casefold())):
    category_value = str(item.get("category") or "")
    category_label = category_value[:1].upper() + category_value[1:]
    fields = [
        str(item.get("id") or ""),
        str(item.get("name") or ""),
        category_label,
        str(item.get("source") or ""),
    ]
    print("\t".join(field.replace("\t", " ") for field in fields))
PY
}

admin_vehicle_rows() {
  python3 - "$ADMIN_VEHICLES_FILE" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1], encoding="utf-8"))
for row in rows:
    print("\t".join([
        str(row.get("id") or ""),
        str(row.get("actor_class") or ""),
        ", ".join(str(t) for t in row.get("templates") or []),
    ]))
PY
}

admin_vehicle_template_rows() {
  local vehicle_id="$1"
  python3 - "$ADMIN_VEHICLES_FILE" "$vehicle_id" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1], encoding="utf-8"))
wanted = sys.argv[2].casefold()
for row in rows:
    if str(row.get("id") or "").casefold() == wanted:
        for template in row.get("templates") or []:
            print(str(template))
        raise SystemExit(0)
raise SystemExit(1)
PY
}

admin_skill_module_rows() {
  python3 - "$ADMIN_SKILL_MODULES_FILE" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1], encoding="utf-8"))
for row in sorted(rows, key=lambda r: (str(r.get("category") or ""), str(r.get("name") or ""))):
    print("\t".join([
        str(row.get("id") or ""),
        str(row.get("name") or ""),
        str(row.get("category") or ""),
        str(row.get("maxLevel") or 1),
    ]))
PY
}

admin_online_player_rows() {
  docker exec dune-postgres psql -U dune -d dune -At -F $'\t' -c "
    select
      coalesce(nullif(a.\"user\", ''), nullif(a.funcom_id, '')) as fls_id,
      ps.account_id,
      coalesce(nullif(ps.character_name, ''), '<unknown>') as character_name,
      coalesce(ps.online_status::text, '') as online_status,
      coalesce(fs.map, wp.map, '') as map,
      coalesce(ps.server_id, '') as server_id
    from dune.player_state ps
    left join dune.accounts a on a.id = ps.account_id
    left join dune.farm_state fs on fs.server_id = ps.server_id
    left join dune.world_partition wp on wp.partition_id = ps.previous_server_partition_id
    where ps.online_status <> 'Offline'
      or (
        ps.reconnect_grace_period_end is not null
        and ps.reconnect_grace_period_end > (current_timestamp at time zone 'UTC')
      )
      or (
        ps.last_avatar_activity is not null
        and ps.last_avatar_activity > (current_timestamp - interval '5 minutes')
      )
    order by lower(coalesce(nullif(ps.character_name, ''), ps.account_id::text));
  " 2>/dev/null || true
}

admin_known_player_rows() {
  docker exec dune-postgres psql -U dune -d dune -At -F $'\t' -c "
    select
      coalesce(nullif(a.\"user\", ''), nullif(a.funcom_id, '')) as fls_id,
      ps.account_id,
      coalesce(nullif(ps.character_name, ''), '<unknown>') as character_name,
      coalesce(ps.online_status::text, '') as online_status,
      coalesce(fs.map, wp.map, '') as map,
      coalesce(ps.server_id, '') as server_id
    from dune.player_state ps
    left join dune.accounts a on a.id = ps.account_id
    left join dune.farm_state fs on fs.server_id = ps.server_id
    left join dune.world_partition wp on wp.partition_id = ps.previous_server_partition_id
    where coalesce(nullif(a.\"user\", ''), nullif(a.funcom_id, '')) <> ''
    order by
      case when ps.online_status <> 'Offline' then 0 else 1 end,
      lower(coalesce(nullif(ps.character_name, ''), ps.account_id::text));
  " 2>/dev/null || true
}

admin_specialization_online_player_rows() {
  docker exec dune-postgres psql -U postgres -d dune -At -F $'\t' -c "
    select
      coalesce(ps.player_pawn_id, a.id) as actor_id,
      coalesce(nullif(ps.character_name, ''), '<unknown>') as character_name,
      ps.account_id,
      coalesce(ps.online_status::text, '') as online_status,
      coalesce(fs.map, wp.map, '') as map,
      coalesce(ps.server_id, '') as server_id
    from dune.player_state ps
    left join dune.actors a on a.id = ps.player_pawn_id
    left join dune.farm_state fs on fs.server_id = ps.server_id
    left join dune.world_partition wp on wp.partition_id = ps.previous_server_partition_id
    where coalesce(ps.player_pawn_id, a.id) is not null
      and (a.id is null or a.class ilike '%PlayerCharacter%')
      and (
        ps.online_status <> 'Offline'
        or (
          ps.reconnect_grace_period_end is not null
          and ps.reconnect_grace_period_end > (current_timestamp at time zone 'UTC')
        )
        or (
          ps.last_avatar_activity is not null
          and ps.last_avatar_activity > (current_timestamp - interval '5 minutes')
        )
      )
    order by character_name, actor_id;
  " 2>/dev/null || true
}

admin_choose_player() {
  local rows=()
  local choice row fls_id account_id character_name online_status map_name server_id manual_id
  local i

  ADMIN_SELECTION_CANCELLED=0

  if ! docker inspect -f '{{.State.Running}}' dune-postgres 2>/dev/null | grep -qx 'true'; then
    error_msg "Postgres container is not running, so online players cannot be listed."
    prompt_text "Enter Player FLS ID manually, * for all online players, or 0 to go back:" manual_id || return 1
    manual_id="$(sanitize_numeric_prompt_value "$manual_id")"
    if [ "$manual_id" = "0" ]; then
      admin_back_to_menu
      return 0
    fi
    ADMIN_SELECTED_PLAYER_ID="$manual_id"
    ADMIN_SELECTED_PLAYER_LABEL="$manual_id"
    return 0
  fi

  mapfile -t rows < <(admin_online_player_rows)

  echo
  echo "Select Online Player"
  echo "===================="
  echo
  if [ "${#rows[@]}" -eq 0 ]; then
    echo "No online players found."
    echo
  else
    for i in "${!rows[@]}"; do
      IFS=$'\t' read -r fls_id account_id character_name online_status map_name server_id <<< "${rows[$i]}"
      printf '%s) %s\n' "$((i + 1))" "$character_name"
      printf '   FLS ID: %s\n' "${fls_id:-unknown}"
      printf '   local account id: %s\n' "$account_id"
      printf '   status: %s\n' "${online_status:-unknown}"
      [ -z "${map_name:-}" ] || printf '   map: %s\n' "$map_name"
      [ -z "${server_id:-}" ] || printf '   server: %s\n' "$server_id"
      echo
    done
  fi
  echo "A) All online players (*)"
  echo "M) Manual FLS ID"
  echo "0) Back"
  echo

  prompt_text "Player Selection:" choice || return 1
  choice="$(sanitize_numeric_prompt_value "$choice")"
  case "$choice" in
    0)
      admin_back_to_menu
      return 0
      ;;
    A|a)
      ADMIN_SELECTED_PLAYER_ID="*"
      ADMIN_SELECTED_PLAYER_LABEL="All online players (*)"
      return 0
      ;;
    M|m)
      prompt_text "Player FLS ID, or * for all online players:" manual_id || return 1
      ADMIN_SELECTED_PLAYER_ID="$manual_id"
      ADMIN_SELECTED_PLAYER_LABEL="$manual_id"
      return 0
      ;;
  esac

  if ! printf '%s' "$choice" | grep -Eq '^[1-9][0-9]*$' || [ "$choice" -gt "${#rows[@]}" ]; then
    error_msg "Invalid player selection."
    return 1
  fi

  row="${rows[$((choice - 1))]}"
  IFS=$'\t' read -r fls_id account_id character_name online_status map_name server_id <<< "$row"
  if [ -z "${fls_id:-}" ]; then
    error_msg "Selected player has no FLS id in dune.accounts."
    echo "Use Manual FLS ID if you know it."
    return 1
  fi
  ADMIN_SELECTED_PLAYER_ID="$fls_id"
  ADMIN_SELECTED_PLAYER_LABEL="$character_name ($fls_id)"
}

admin_grant_item_flow() {
  local player_id player_label choice quantity durability
  local category_rows=()
  local item_rows=()
  local row item_id item_name item_category item_source category_label category_name category_count

  admin_items_available || return 1

  ADMIN_SELECTED_PLAYER_ID=""
  ADMIN_SELECTED_PLAYER_LABEL=""
  admin_choose_player || return
  [ "${ADMIN_SELECTION_CANCELLED:-0}" -eq 0 ] || return 0
  player_id="$ADMIN_SELECTED_PLAYER_ID"
  player_label="$ADMIN_SELECTED_PLAYER_LABEL"

  echo
  mapfile -t category_rows < <(admin_item_category_rows)
  if [ "${#category_rows[@]}" -eq 0 ]; then
    echo "No item categories found in $ADMIN_ITEMS_FILE"
    return 1
  fi

  echo
  echo "Select Item Category"
  echo "===================="
  echo
  local i
  for i in "${!category_rows[@]}"; do
    IFS=$'\t' read -r category_label category_name category_count <<< "${category_rows[$i]}"
    printf '%s) %s (%s)\n' "$((i + 1))" "$category_label" "$category_count"
  done
  echo "0) Back"
  echo

  prompt_text "Category Number:" choice || return
  choice="$(sanitize_numeric_prompt_value "$choice")"
  if [ "$choice" = "0" ]; then
    ACTION_CANCELLED=1
    return 0
  fi
  if ! printf '%s' "$choice" | grep -Eq '^[1-9][0-9]*$' || [ "$choice" -gt "${#category_rows[@]}" ]; then
    error_msg "Invalid category selection."
    return 1
  fi

  row="${category_rows[$((choice - 1))]}"
  IFS=$'\t' read -r category_label category_name category_count <<< "$row"

  mapfile -t item_rows < <(admin_items_by_category_rows "$category_name")
  if [ "${#item_rows[@]}" -eq 0 ]; then
    echo "No items found in category: $category_name"
    return 1
  fi

  echo
  echo "Select Item From $category_label"
  echo "==============================="
  echo
  for i in "${!item_rows[@]}"; do
    IFS=$'\t' read -r item_id item_name item_category item_source <<< "${item_rows[$i]}"
    printf '%s) %s\n' "$((i + 1))" "$item_name"
    printf '   category: %s\n' "$item_category"
    printf '   source: %s\n' "$item_source"
    echo
  done
  echo "0) Back"
  echo

  prompt_text "Item Number:" choice || return
  choice="$(sanitize_numeric_prompt_value "$choice")"
  if [ "$choice" = "0" ]; then
    ACTION_CANCELLED=1
    return 0
  fi
  if ! printf '%s' "$choice" | grep -Eq '^[1-9][0-9]*$' || [ "$choice" -gt "${#item_rows[@]}" ]; then
    error_msg "Invalid item selection."
    return 1
  fi

  row="${item_rows[$((choice - 1))]}"
  IFS=$'\t' read -r item_id item_name item_category item_source <<< "$row"

  if [ "$item_id" = "TEMPLATE_SCOUT_ORNITHOPTER_MK6" ]; then
    echo
    echo "Grant template now?"
    echo "  Player: $player_label"
    echo "  PlayerId: $player_id"
    echo "  Template: Scout Ornithopter Mk6"
    echo "  Components:"
    echo "    1x Scout Ornithopter Chassis Mk6"
    echo "    1x Scout Ornithopter Cockpit Mk6"
    echo "    1x Scout Ornithopter Engine Mk6"
    echo "    1x Scout Ornithopter Generator Mk6"
    echo "    1x Scout Ornithopter Hull Mk6"
    echo "    4x Scout Ornithopter Wing Mk6"
    echo "    1x Scout Ornithopter Thruster Mk6"
    echo "    1x Scout Ornithopter Storage Mk4"
    echo "    5x Large Vehicle Fuel Cell"
    echo "    1x Welding Torch Mk5"
    echo

    if confirm "Publish this live template grant"; then
      run_cmd "$DUNE" admin grant-template "$player_id" scout-ornithopter-mk6
    else
      echo "Cancelled."
    fi
    return 0
  fi

  prompt_text "Quantity [1]:" quantity allow-empty || return
  quantity="$(sanitize_numeric_prompt_value "${quantity:-}")"
  quantity="${quantity:-1}"
  admin_validate_quantity "$quantity" || return 1

  prompt_text "Durability [1.0]:" durability allow-empty || return
  durability="$(sanitize_numeric_prompt_value "${durability:-}")"
  durability="${durability:-1.0}"
  if ! admin_validate_durability "$durability"; then
    error_msg "Durability must be a number between 0 and 1."
    return 1
  fi

  echo
  echo "Grant item now?"
  echo "  Player: $player_label"
  echo "  PlayerId: $player_id"
  echo "  Item: $item_name"
  echo "  Category: $item_category"
  echo "  Source: $item_source"
  echo "  Quantity: $quantity"
  echo "  Durability: $durability"
  echo

  if confirm "Publish this live item grant"; then
    run_cmd "$DUNE" admin grant-item-id "$player_id" "$item_id" "$quantity" "$durability"
  else
    echo "Cancelled."
  fi
}

admin_tools_menu() {
  local choice
  while true; do
    menu_or_back "Admin Tools" \
      "Grant Item" \
      "Player Lookup / Location" \
      "Kick Player" \
      "Give XP" \
      "Set Skill Points" \
      "Set Skill Level" \
      "Refill Water" \
      "Teleport Player" \
      "Spawn Vehicle" \
      "Clean Inventory" \
      "Reset Progression" \
      "Grant Specialization XP" \
      "Command History" \
      "Back" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) admin_run_flow admin_grant_item_flow ;;
      2) admin_run_flow admin_player_location_flow ;;
      3) admin_run_flow admin_kick_player_flow ;;
      4) admin_run_flow admin_simple_number_flow "Give XP" award-xp "Experience amount" 1 100000000 ;;
      5) admin_run_flow admin_simple_number_flow "Set Skill Points" skill-points "Skill points" 0 100000 ;;
      6) admin_run_flow admin_skill_module_flow ;;
      7) admin_run_flow admin_simple_number_flow "Refill Water" refill-water "Water amount" 1 1000000;;
      8) admin_run_flow admin_teleport_flow ;;
      9) admin_run_flow admin_spawn_vehicle_flow ;;
      10) admin_run_flow admin_destructive_flow "Clean Inventory" clean-inventory ;;
      11) admin_run_flow admin_destructive_flow "Reset Progression" reset-progression ;;
      12) admin_run_flow admin_specialization_xp_flow ;;
      13) admin_run_flow run_cmd "$DUNE" admin history ;;
      14) return ;;
    esac
  done
}

admin_run_flow() {
  set +e
  "$@"
  local rc=$?
  set -e
  if [ "$rc" -ne 0 ] && [ "${ACTION_CANCELLED:-0}" -ne 1 ]; then
    echo
    echo "Admin action returned status $rc."
  fi
  pause
  return 0
}

admin_player_location_flow() {
  local player_id
  ADMIN_SELECTED_PLAYER_ID=""
  ADMIN_SELECTED_PLAYER_LABEL=""
  admin_choose_player || return
  [ "${ADMIN_SELECTION_CANCELLED:-0}" -eq 0 ] || return 0
  player_id="$ADMIN_SELECTED_PLAYER_ID"
  [ "$player_id" != "*" ] || { error_msg "Player lookup requires a specific player."; return 1; }
  run_cmd "$DUNE" admin player-location "$player_id"
}

admin_simple_number_flow() {
  local title="$1" command="$2" prompt="$3"
  local min_value="${4:--2147483648}" max_value="${5:-2147483647}"
  local player_id amount
  ADMIN_SELECTED_PLAYER_ID=""
  ADMIN_SELECTED_PLAYER_LABEL=""
  admin_choose_player || return 1
  [ "${ADMIN_SELECTION_CANCELLED:-0}" -eq 0 ] || return 0
  player_id="$ADMIN_SELECTED_PLAYER_ID"
  prompt_text "$prompt:" amount || return 1
  amount="$(sanitize_numeric_prompt_value "$amount")"
  if ! printf '%s' "$amount" | grep -Eq '^-?[0-9]+$'; then
    error_msg "$prompt must be an integer."
    return 1
  fi
  if [ "$amount" -lt "$min_value" ] || [ "$amount" -gt "$max_value" ]; then
    error_msg "$prompt must be between $min_value and $max_value."
    return 1
  fi
  echo
  echo "$title now?"
  echo "  Player: $ADMIN_SELECTED_PLAYER_LABEL"
  echo "  Amount: $amount"
  echo
  if confirm "Publish $title"; then
    run_cmd env DUNE_ADMIN_ASSUME_YES=1 "$DUNE" admin "$command" "$player_id" "$amount"
  else
    echo "Cancelled."
  fi
}

admin_skill_module_flow() {
  local player_id module level choice row module_id module_name module_category max_level
  local rows=()
  ADMIN_SELECTED_PLAYER_ID=""
  ADMIN_SELECTED_PLAYER_LABEL=""
  admin_choose_player || return
  [ "${ADMIN_SELECTION_CANCELLED:-0}" -eq 0 ] || return 0
  player_id="$ADMIN_SELECTED_PLAYER_ID"
  if [ ! -r "$ADMIN_SKILL_MODULES_FILE" ]; then
    error_msg "Missing skill module catalog: $ADMIN_SKILL_MODULES_FILE"
    return 1
  fi
  mapfile -t rows < <(admin_skill_module_rows)
  echo
  echo "Select Skill Module"
  echo "==================="
  echo
  local i
  for i in "${!rows[@]}"; do
    IFS=$'\t' read -r module_id module_name module_category max_level <<< "${rows[$i]}"
    printf '%s) %s [%s]\n' "$((i + 1))" "$module_name" "$module_category"
    printf '   id: %s, max level: %s\n' "$module_id" "$max_level"
  done
  echo "0) Back"
  echo
  prompt_text "Skill Module Number:" choice || return
  choice="$(sanitize_numeric_prompt_value "$choice")"
  if [ "$choice" = "0" ]; then
    ACTION_CANCELLED=1
    return 0
  fi
  if ! printf '%s' "$choice" | grep -Eq '^[1-9][0-9]*$' || [ "$choice" -gt "${#rows[@]}" ]; then
    error_msg "Invalid skill module selection."
    return 1
  fi
  row="${rows[$((choice - 1))]}"
  IFS=$'\t' read -r module_id module_name module_category max_level <<< "$row"
  module="$module_id"
  prompt_text "Level:" level || return
  level="$(sanitize_numeric_prompt_value "$level")"
  if ! printf '%s' "$level" | grep -Eq '^[0-9]+$'; then
    error_msg "Level must be a non-negative integer."
    return 1
  fi
  if [ "$level" -gt "$max_level" ]; then
    error_msg "Level must be between 0 and $max_level for $module_name."
    return 1
  fi
  echo
  echo "Set skill level now?"
  echo "  Player: $ADMIN_SELECTED_PLAYER_LABEL"
  echo "  Module: $module_name [$module_category]"
  echo "  Raw id: $module"
  echo "  Level: $level"
  echo
  if confirm "Publish skill level update"; then
    run_cmd env DUNE_ADMIN_ASSUME_YES=1 "$DUNE" admin skill-module "$player_id" "$module" "$level"
  else
    echo "Cancelled."
  fi
}

admin_specialization_xp_flow() {
  local character choice track level xp grant_keystones dry_run unlock_faction actor_id account_id online_status map_name server_id row args=()
  local tracks=("Crafting" "Gathering" "Exploration" "Combat" "Sabotage")
  local rows=() i

  if ! docker inspect -f '{{.State.Running}}' dune-postgres 2>/dev/null | grep -qx 'true'; then
    error_msg "Postgres container is not running, so online players cannot be listed."
    return 1
  fi

  mapfile -t rows < <(admin_specialization_online_player_rows)
  if [ "${#rows[@]}" -eq 0 ]; then
    echo "No online players with a resolvable PlayerCharacter pawn were found."
    return 1
  fi

  echo
  echo "Select Online Player"
  echo "===================="
  echo
  for i in "${!rows[@]}"; do
    IFS=$'\t' read -r actor_id character account_id online_status map_name server_id <<< "${rows[$i]}"
    printf '%s) %s\n' "$((i + 1))" "$character"
    printf '   actor id: %s\n' "$actor_id"
    printf '   local account id: %s\n' "$account_id"
    printf '   status: %s\n' "${online_status:-unknown}"
    [ -z "${map_name:-}" ] || printf '   map: %s\n' "$map_name"
    [ -z "${server_id:-}" ] || printf '   server: %s\n' "$server_id"
    echo
  done
  echo "0) Back"
  echo

  prompt_text "Player Number:" choice || return
  choice="$(sanitize_numeric_prompt_value "$choice")"
  if [ "$choice" = "0" ]; then
    ACTION_CANCELLED=1
    return 0
  fi
  if ! printf '%s' "$choice" | grep -Eq '^[1-9][0-9]*$' || [ "$choice" -gt "${#rows[@]}" ]; then
    error_msg "Invalid player selection."
    return 1
  fi

  row="${rows[$((choice - 1))]}"
  IFS=$'\t' read -r actor_id character account_id online_status map_name server_id <<< "$row"
  [ -n "${actor_id:-}" ] || { error_msg "Selected player has no pawn actor id."; return 1; }

  echo
  echo "Specialization Track"
  echo "===================="
  echo
  echo "1) All tracks"
  local i
  for i in "${!tracks[@]}"; do
    printf '%s) %s\n' "$((i + 2))" "${tracks[$i]}"
  done
  echo "0) Back"
  echo
  prompt_text "Track Selection [1]:" choice allow-empty || return
  choice="$(sanitize_numeric_prompt_value "${choice:-1}")"
  choice="${choice:-1}"
  if [ "$choice" = "0" ]; then
    ACTION_CANCELLED=1
    return 0
  fi
  if [ "$choice" = "1" ]; then
    args+=(--all)
    track="All tracks"
  elif printf '%s' "$choice" | grep -Eq '^[2-6]$'; then
    track="${tracks[$((choice - 2))]}"
    args+=(--track "$track")
  else
    error_msg "Invalid track selection."
    return 1
  fi

  prompt_text "Level [100]:" level allow-empty || return
  level="$(sanitize_numeric_prompt_value "${level:-100}")"
  level="${level:-100}"
  if ! printf '%s' "$level" | grep -Eq '^[0-9]+$' || [ "$level" -gt 100 ]; then
    error_msg "Level must be an integer between 0 and 100."
    return 1
  fi

  prompt_text "XP amount [44182]:" xp allow-empty || return
  xp="$(sanitize_numeric_prompt_value "${xp:-44182}")"
  xp="${xp:-44182}"
  if ! printf '%s' "$xp" | grep -Eq '^[0-9]+$'; then
    error_msg "XP amount must be a non-negative integer."
    return 1
  fi

  if confirm "Grant all specialization keystones too"; then
    grant_keystones=1
    args+=(--grant-keystones)
  else
    grant_keystones=0
  fi

  echo
  echo "Faction Unlock"
  echo "=============="
  echo
  echo "Specialization may require the faction journey to be unlocked."
  echo "1) Do not change faction"
  echo "2) Unlock Atreides"
  echo "3) Unlock Harkonnen"
  echo "0) Back"
  echo
  prompt_text "Faction Selection [1]:" choice allow-empty || return
  choice="$(sanitize_numeric_prompt_value "${choice:-1}")"
  choice="${choice:-1}"
  case "$choice" in
    0)
      ACTION_CANCELLED=1
      return 0
      ;;
    1)
      unlock_faction=""
      ;;
    2)
      unlock_faction="Atreides"
      args+=(--unlock-faction "$unlock_faction")
      ;;
    3)
      unlock_faction="Harkonnen"
      args+=(--unlock-faction "$unlock_faction")
      ;;
    *)
      error_msg "Invalid faction selection."
      return 1
      ;;
  esac

  if confirm "Dry run only"; then
    dry_run=1
    args+=(--dry-run)
  else
    dry_run=0
  fi

  echo
  echo "Apply specialization database update?"
  echo "  Player: $character"
  echo "  Actor id: $actor_id"
  echo "  Track: $track"
  echo "  Level: $level"
  echo "  XP amount: $xp"
  echo "  Grant keystones: $([ "$grant_keystones" = "1" ] && echo yes || echo no)"
  echo "  Unlock faction journey: ${unlock_faction:-no}"
  echo "  Dry run: $([ "$dry_run" = "1" ] && echo yes || echo no)"
  echo
  if confirm "Continue with specialization update"; then
    run_cmd env DUNE_ADMIN_ASSUME_YES=1 "$DUNE" admin specialization-xp "$character" "${args[@]}" --level "$level" --xp "$xp" --actor-id "$actor_id"
  else
    echo "Cancelled."
  fi
}

admin_teleport_flow() {
  local player_id x y z yaw
  ADMIN_SELECTED_PLAYER_ID=""
  ADMIN_SELECTED_PLAYER_LABEL=""
  admin_choose_player || return
  [ "${ADMIN_SELECTION_CANCELLED:-0}" -eq 0 ] || return 0
  player_id="$ADMIN_SELECTED_PLAYER_ID"
  [ "$player_id" != "*" ] || { error_msg "Teleport requires a specific player."; return 1; }
  prompt_text "X:" x || return
  prompt_text "Y:" y || return
  prompt_text "Z:" z || return
  prompt_text "Yaw [blank for default]:" yaw allow-empty || return
  if confirm "Publish teleport command"; then
    if [ -n "$yaw" ]; then
      run_cmd env DUNE_ADMIN_ASSUME_YES=1 "$DUNE" admin teleport "$player_id" "$x" "$y" "$z" "$yaw"
    else
      run_cmd env DUNE_ADMIN_ASSUME_YES=1 "$DUNE" admin teleport "$player_id" "$x" "$y" "$z"
    fi
  else
    echo "Cancelled."
  fi
}

admin_spawn_vehicle_flow() {
  local player_id class_name template choice row actor templates template_choice
  local rows=() template_rows=()
  ADMIN_SELECTED_PLAYER_ID=""
  ADMIN_SELECTED_PLAYER_LABEL=""
  admin_choose_player || return
  [ "${ADMIN_SELECTION_CANCELLED:-0}" -eq 0 ] || return 0
  player_id="$ADMIN_SELECTED_PLAYER_ID"
  [ "$player_id" != "*" ] || { error_msg "Vehicle spawn requires a specific player."; return 1; }
  if [ ! -r "$ADMIN_VEHICLES_FILE" ]; then
    error_msg "Missing vehicle catalog: $ADMIN_VEHICLES_FILE"
    return 1
  fi
  mapfile -t rows < <(admin_vehicle_rows)
  echo
  echo "Select Vehicle"
  echo "=============="
  echo
  local i
  for i in "${!rows[@]}"; do
    IFS=$'\t' read -r class_name actor templates <<< "${rows[$i]}"
    printf '%s) %s\n' "$((i + 1))" "$class_name"
    printf '   templates: %s\n' "$templates"
  done
  echo "0) Back"
  echo
  prompt_text "Vehicle Number:" choice || return
  choice="$(sanitize_numeric_prompt_value "$choice")"
  if [ "$choice" = "0" ]; then
    ACTION_CANCELLED=1
    return 0
  fi
  if ! printf '%s' "$choice" | grep -Eq '^[1-9][0-9]*$' || [ "$choice" -gt "${#rows[@]}" ]; then
    error_msg "Invalid vehicle selection."
    return 1
  fi
  row="${rows[$((choice - 1))]}"
  IFS=$'\t' read -r class_name actor templates <<< "$row"

  mapfile -t template_rows < <(admin_vehicle_template_rows "$class_name")
  echo
  echo "Select Template For $class_name"
  echo "==============================="
  echo
  for i in "${!template_rows[@]}"; do
    printf '%s) %s\n' "$((i + 1))" "${template_rows[$i]}"
  done
  echo "0) Back"
  echo
  prompt_text "Template Number:" template_choice || return
  template_choice="$(sanitize_numeric_prompt_value "$template_choice")"
  if [ "$template_choice" = "0" ]; then
    ACTION_CANCELLED=1
    return 0
  fi
  if ! printf '%s' "$template_choice" | grep -Eq '^[1-9][0-9]*$' || [ "$template_choice" -gt "${#template_rows[@]}" ]; then
    error_msg "Invalid template selection."
    return 1
  fi
  template="${template_rows[$((template_choice - 1))]}"
  echo
  echo "Spawn vehicle in front of player now?"
  echo "  Player: $ADMIN_SELECTED_PLAYER_LABEL"
  echo "  Vehicle: $class_name"
  echo "  Template: $template"
  echo "  Position: about 4 meters in front of the player"
  echo
  if confirm "Publish vehicle spawn command"; then
    run_cmd env DUNE_ADMIN_ASSUME_YES=1 "$DUNE" admin spawn-vehicle "$player_id" "$class_name" "$template"
  else
    echo "Cancelled."
  fi
}

admin_destructive_flow() {
  local title="$1" command="$2" player_id
  ADMIN_SELECTED_PLAYER_ID=""
  ADMIN_SELECTED_PLAYER_LABEL=""
  admin_choose_player || return
  [ "${ADMIN_SELECTION_CANCELLED:-0}" -eq 0 ] || return 0
  player_id="$ADMIN_SELECTED_PLAYER_ID"
  echo
  echo "$title is destructive."
  echo "  Player: $ADMIN_SELECTED_PLAYER_LABEL"
  echo
  if confirm "Continue to $title"; then
    run_cmd env DUNE_ADMIN_ASSUME_YES=1 "$DUNE" admin "$command" "$player_id"
  else
    echo "Cancelled."
  fi
}

admin_kick_player_flow() {
  local player_id player_label choice row fls_id account_id character_name online_status map_name server_id
  local rows=() using_known=0 i

  ADMIN_SELECTED_PLAYER_ID=""
  ADMIN_SELECTED_PLAYER_LABEL=""

  ADMIN_SELECTION_CANCELLED=0
  if ! docker inspect -f '{{.State.Running}}' dune-postgres 2>/dev/null | grep -qx 'true'; then
    error_msg "Postgres container is not running, so online players cannot be listed."
    echo "Kick normally requires an online player. Start the stack or use the CLI with a known FLS id."
    return 1
  fi

  mapfile -t rows < <(admin_online_player_rows)
  if [ "${#rows[@]}" -eq 0 ]; then
    using_known=1
    mapfile -t rows < <(admin_known_player_rows)
  fi
  if [ "${#rows[@]}" -eq 0 ]; then
    echo "No known players found."
    return 1
  fi

  echo
  if [ "$using_known" -eq 1 ]; then
    echo "Select Known Player"
    echo "==================="
    echo
    warn "No online players were detected. Kick usually only works for online players."
  else
    echo "Select Online Player To Kick"
    echo "============================"
    echo
  fi
  for i in "${!rows[@]}"; do
    IFS=$'\t' read -r fls_id account_id character_name online_status map_name server_id <<< "${rows[$i]}"
    printf '%s) %s\n' "$((i + 1))" "$character_name"
    printf '   FLS ID: %s\n' "${fls_id:-unknown}"
    printf '   local account id: %s\n' "$account_id"
    printf '   status: %s\n' "${online_status:-unknown}"
    [ -z "${map_name:-}" ] || printf '   map: %s\n' "$map_name"
    [ -z "${server_id:-}" ] || printf '   server: %s\n' "$server_id"
    echo
  done
  echo "0) Back"
  echo

  prompt_text "Player Number:" choice || return 1
  choice="$(sanitize_numeric_prompt_value "$choice")"
  if [ "$choice" = "0" ]; then
    ACTION_CANCELLED=1
    return 0
  fi
  if ! printf '%s' "$choice" | grep -Eq '^[1-9][0-9]*$' || [ "$choice" -gt "${#rows[@]}" ]; then
    error_msg "Invalid player selection."
    return 1
  fi

  row="${rows[$((choice - 1))]}"
  IFS=$'\t' read -r player_id account_id character_name online_status map_name server_id <<< "$row"
  if [ -z "${player_id:-}" ]; then
    error_msg "Selected player has no FLS id; KickPlayer requires FLS PlayerId."
    return 1
  fi
  player_label="$character_name ($player_id)"

  echo "Kick player now?"
  echo "  Player: $player_label"
  echo "  PlayerId: $player_id"
  echo "  Status: ${online_status:-unknown}"
  [ -z "${map_name:-}" ] || echo "  Map: $map_name"
  if [ "${online_status:-Offline}" = "Offline" ]; then
    warn "This player is not currently online; the runtime command may not disconnect anyone."
  fi
  echo "  Command: KickPlayer"
  echo "  Reason: not supported by the runtime command"
  echo
  if confirm "Publish KickPlayer now"; then
    if [ "${online_status:-Offline}" = "Offline" ]; then
      run_cmd "$DUNE" admin kick "$player_id" --yes --force --label "$player_label"
    else
      run_cmd "$DUNE" admin kick "$player_id" --yes --label "$player_label"
    fi
  else
    echo "Cancelled."
  fi
}

main_menu() {
  local choice
  while true; do
    set +e
    select_menu "Dune Awakening Self-Host Docker Manager" \
      "Battlegroup Overview" \
      "Battlegroup Settings" \
      "Sietches" \
      "Updates" \
      "Logs" \
      "Admin Tools" \
      "Advanced Tools" \
      "Exit"
    local rc=$?
    set -e
    if [ "$rc" -ne 0 ]; then
      echo "Goodbye."
      exit 0
    fi
    choice="$MENU_CHOICE"

    case "$choice" in
      1) battlegroup_overview_menu ;;
      2) battlegroup_settings_menu ;;
      3) sietches_menu ;;
      4) updates_menu ;;
      5) logs_menu ;;
      6) admin_tools_menu ;;
      7) advanced_menu ;;
      8) echo "Goodbye."; exit 0 ;;
    esac
  done
}

battlegroup_overview_menu() {
  local choice
  while true; do
    menu_or_back "Battlegroup Overview" \
      "Safe Dashboard" \
      "Readiness Check" \
      "Version" \
      "Containers" \
      "Ports" \
      "Back" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) run_cmd "$DUNE" status; pause ;;
      2) run_cmd_allow_codes "0,2" "$DUNE" ready; pause ;;
      3) run_cmd "$DUNE" version; pause ;;
      4) run_cmd "$DUNE" ps; pause ;;
      5) run_cmd "$DUNE" ports; pause ;;
      6) return ;;
    esac
  done
}

battlegroup_settings_menu() {
  local choice scheduled_restart_time
  while true; do
    menu_or_back "Battlegroup Settings" \
      "Change Name" \
      "Start" \
      "Stop" \
      "Restart" \
      "Scheduled Restart" \
      "Redeploy" \
      "Dynamic Maps And Autoscaler" \
      "Database Maintenance" \
      "Show Current Configuration" \
      "Back" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1)
        echo
        run_cmd "$DUNE" config title
        echo
        prompt_text "New Name:" new_title || { pause; continue; }
        echo
        echo "Changing the battlegroup name requires restarting Gateway so the new name can be published."
        if confirm "Change name to '$new_title'?"; then
          run_cmd "$DUNE" config title "$new_title" --yes
        else
          echo "Cancelled."
        fi
        pause
        ;;
      2)
        if verify_player_ip_before_battlegroup_action; then
          persist_runtime_identity_snapshot
          run_cmd "$DUNE" start
        fi
        pause
        ;;
      3)
        echo
        echo "WARNING: stopping removes the running Dune service containers. Players will be disconnected."
        if confirm "Stop"; then
          run_cmd "$DUNE" stop
        else
          echo "Cancelled."
        fi
        pause
        ;;
      4)
        echo
        echo "Restart will stop and start the battlegroup. Players will be disconnected."
        if confirm "Continue"; then
          if verify_player_ip_before_battlegroup_action; then
            persist_runtime_identity_snapshot
            run_cmd "$DUNE" stop
            run_cmd "$DUNE" start
          fi
        else
          echo "Cancelled."
        fi
        pause
        ;;
      5)
        while true; do
          menu_or_back "Scheduled Restart" \
            "Status" \
            "Enable" \
            "Disable" \
            "Back" || break
          choice="$MENU_CHOICE"

          case "$choice" in
            1) run_cmd "$DUNE" restart-schedule status; pause ;;
            2)
              scheduled_restart_time=""
              echo
              prompt_text "Daily Restart Time (HH:MM):" scheduled_restart_time || { pause; continue; }
              scheduled_restart_time="$(trim "$scheduled_restart_time")"
              if ! printf '%s' "$scheduled_restart_time" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]$'; then
                error_msg "Restart time must be HH:MM in 24-hour local server time."
                pause
                continue
              fi
              if confirm "Enable scheduled restart daily at $scheduled_restart_time?"; then
                run_cmd sudo "$DUNE" restart-schedule enable "$scheduled_restart_time"
              else
                echo "Cancelled."
              fi
              pause
              ;;
            3)
              echo
              if confirm "Disable scheduled restart?"; then
                run_cmd sudo "$DUNE" restart-schedule disable
              else
                echo "Cancelled."
              fi
              pause
              ;;
            4) break ;;
          esac
        done
        ;;
      6) redeploy_battlegroup_flow; pause ;;
      7) dynamic_maps_menu ;;
      8) database_maintenance_menu ;;
      9) show_config_summary; pause ;;
      10) return ;;
    esac
  done
}

dynamic_maps_menu() {
  local choice
  while true; do
    menu_or_back "Dynamic Maps And Autoscaler" \
      "Autoscaler Status" \
      "Start Autoscaler" \
      "Stop Autoscaler" \
      "Restart Autoscaler" \
      "Show Running Maps" \
      "Configure Maps" \
      "Dual Deep Desert PvP/PvE" \
      "Show Autoscaler Logs" \
      "Back" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) run_cmd "$DUNE" autoscaler status; pause ;;
      2) run_cmd "$DUNE" autoscaler start; pause ;;
      3) run_cmd "$DUNE" autoscaler stop; pause ;;
      4) run_cmd "$DUNE" autoscaler restart; pause ;;
      5)
        echo
        echo "Survival_1  Always-On Protected"
        echo "Overmap     Always-On Protected"
        run_cmd "$DUNE" servers
        pause
        ;;
      6) configure_maps_menu ;;
      7) dual_deepdesert_menu ;;
      8) run_cmd "$DUNE" autoscaler logs; pause ;;
      9) return ;;
    esac
  done
}

configure_maps_menu() {
  local rows=() labels=() maps=() row map choice mode sub
  while true; do
    mapfile -t rows < <("$DUNE" maps list 2>/dev/null || true)
    labels=()
    maps=()
    for row in "${rows[@]}"; do
      [ -n "$row" ] || continue
      map="$(awk '{print $1}' <<< "$row")"
      maps+=("$map")
      labels+=("$row")
    done
    labels+=("Back")
    menu_or_back "Configure Maps" "${labels[@]}" || return
    choice="$MENU_CHOICE"
    if [ "$choice" -eq "${#labels[@]}" ]; then
      return
    fi
    map="${maps[$((choice - 1))]}"
    mode="$("$DUNE" maps mode "$map" | awk '{print $2}')"
    while true; do
      menu_or_back "$map" \
        "Change To Dynamic" \
        "Change To Always On" \
        "Change To Overmap Active" \
        "Change To Disabled" \
        "Show Running Partitions" \
        "Back" || break
      sub="$MENU_CHOICE"
      case "$sub" in
        1) run_cmd "$DUNE" maps set "$map" dynamic; pause; break ;;
        2) run_cmd "$DUNE" maps set "$map" always-on; pause; break ;;
        3) run_cmd "$DUNE" maps set "$map" overmap-active; pause; break ;;
        4) run_cmd "$DUNE" maps set "$map" disabled; pause; break ;;
        5) run_cmd "$DUNE" sietches dimensions "$map"; pause ;;
        6) break ;;
      esac
    done
  done
}

dual_deepdesert_menu() {
  local choice
  while true; do
    menu_or_back "Dual Deep Desert PvP/PvE" \
      "Status" \
      "Enable" \
      "Disable" \
      "Bootstrap Routing Fix" \
      "Back" || return
    choice="$MENU_CHOICE"
    case "$choice" in
      1) run_cmd "$DUNE" deepdesert dual status; pause ;;
      2) run_cmd "$DUNE" deepdesert dual enable; pause ;;
      3)
        if confirm "Disable Dual Deep Desert PvP/PvE now?"; then
          run_cmd "$DUNE" deepdesert dual disable --force --yes
        else
          echo "Cancelled."
        fi
        pause
        ;;
      4) run_cmd "$DUNE" deepdesert dual bootstrap; pause ;;
      5) return ;;
    esac
  done
}

database_maintenance_menu() {
  local choice
  while true; do
    menu_or_back "Database Maintenance" \
      "Create Database Backup" \
      "Import Database Backup" \
      "Restore A Database Backup" \
      "List Database Backups" \
      "Delete A Backup" \
      "Delete All Backups" \
      "Automatic Database Backups" \
      "Character Transfer / Account Takeover" \
      "Database Health Check" \
      "Database Status" \
      "Back" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) run_cmd "$DUNE" db backup; pause ;;
      2) import_remote_database_menu; pause ;;
      3) restore_backup_flow; pause ;;
      4) run_cmd "$DUNE" db list; pause ;;
      5) delete_backup_flow; pause ;;
      6) delete_all_backups_flow; pause ;;
      7) automatic_database_backups_menu ;;
      8) character_transfer_menu ;;
      9) run_cmd "$DUNE" db health; pause ;;
      10) run_cmd "$DUNE" db status; pause ;;
      11) return ;;
    esac
  done
}

character_transfer_menu() {
  local choice old new plan
  while true; do
    menu_or_back "Character Transfer / Account Takeover" \
      "Run Single Transfer" \
      "Run Transfer Plan File" \
      "Show Pending Transfers" \
      "Apply Pending Transfers" \
      "Clear Pending Transfers" \
      "Back" || return
    choice="$MENU_CHOICE"
    case "$choice" in
      1)
        prompt_text "Old FLS ID:" old || { pause; continue; }
        prompt_text "New FLS ID:" new || { pause; continue; }
        run_cmd "$DUNE" db transfer "$old" "$new"
        pause
        ;;
      2)
        prompt_text "Transfer Plan TSV Path:" plan || { pause; continue; }
        run_cmd "$DUNE" db transfer --file "$plan"
        pause
        ;;
      3) run_cmd "$DUNE" db transfer pending; pause ;;
      4) run_cmd "$DUNE" db transfer apply-pending; pause ;;
      5) run_cmd "$DUNE" db transfer clear-pending; pause ;;
      6) return ;;
    esac
  done
}

automatic_database_backups_menu() {
  local choice
  while true; do
    menu_or_back "Automatic Database Backups" \
      "Enable Automatic Backups" \
      "Disable Automatic Backups" \
      "Show Automatic Backup Status" \
      "Set Automatic Backup Retention" \
      "Disable Automatic Backup Retention" \
      "Back" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1)
        echo
        prompt_text "Daily Backup Time (HH:MM):" backup_time || { pause; continue; }
        prompt_text "Keep Backups For How Many Days? Leave Blank For No Automatic Cleanup:" retention_days allow-empty || { pause; continue; }
        if [ -z "$backup_time" ]; then
          echo "Backup time is required."
        elif ! printf '%s' "$backup_time" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]$'; then
          echo "Backup time must be HH:MM in 24-hour local server time."
        elif [ -n "$retention_days" ]; then
          run_cmd sudo "$DUNE" db auto enable "$backup_time" "$retention_days"
        else
          run_cmd sudo "$DUNE" db auto enable "$backup_time"
        fi
        pause
        ;;
      2) run_cmd sudo "$DUNE" db auto disable; pause ;;
      3) run_cmd "$DUNE" db auto status; pause ;;
      4)
        echo
        prompt_text "Keep Backups For How Many Days:" retention_days || { pause; continue; }
        run_cmd "$DUNE" db auto retention "$retention_days"
        pause
        ;;
      5) run_cmd "$DUNE" db auto retention off; pause ;;
      6) return ;;
    esac
  done
}

sietches_menu() {
  local choice
  while true; do
    menu_or_back "Sietches" \
      "List Maps" \
      "Validate / Status" \
      "Reconcile / Repair State" \
      "Edit UserEngine" \
      "Edit Map" \
      "Revert All UserSettings To Defaults" \
      "Current Memory Usage" \
      "Show Memory Settings" \
      "Restore Built-In Memory Defaults" \
      "Back" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) run_cmd "$DUNE" sietches list; pause ;;
      2) run_cmd "$DUNE" sietches validate; pause ;;
      3)
        if confirm "Reconcile live Sietch dimensions and republish browser state now?"; then
          run_cmd "$DUNE" sietches reconcile Survival_1
          run_cmd "$DUNE" sietches reconcile DeepDesert_1
          run_cmd "$DUNE" sietches sync
          run_cmd "$DUNE" sietches validate
          run_cmd runtime/scripts/publish-sietch-overrides.sh once
        else
          echo "Cancelled."
        fi
        pause
        ;;
      4) edit_userengine_menu ;;
      5)
        if ! runtime_catalogs_available; then
          echo
          error_msg "Runtime map catalogs are missing."
          echo "Open Updates -> Runtime Files Status for details."
          echo "Then run Updates -> Repair Runtime Files to rebuild them."
          pause
          continue
        fi
        CHOSEN_SIETCH_MAP=""
        choose_sietch_map || true
        if [ -n "$CHOSEN_SIETCH_MAP" ]; then
          edit_sietch_menu "$CHOSEN_SIETCH_MAP"
        else
          pause
        fi
        ;;
      6)
        if confirm "Revert all UserEngine and UserGame overrides to defaults?"; then
          reset_all_usersettings
        else
          echo "Cancelled."
        fi
        pause
        ;;
      7) show_current_memory_usage; pause ;;
      8) run_cmd "$DUNE" memory status; pause ;;
      9) restore_builtin_memory_defaults; pause ;;
      10) return ;;
    esac
  done
}

edit_sietch_menu() {
  local map="$1"

  case "$map" in
    Survival_1) edit_survival_menu ;;
    Overmap) edit_overmap_menu ;;
    *) edit_dedicated_scaling_menu "$map" ;;
  esac
}

edit_survival_menu() {
  local choice
  local memory max active
  local memory_override=0
  while true; do
    memory="$(map_info_value Survival_1 "Memory")"
    max="$(map_info_value Survival_1 "Max dimensions")"
    active="$(map_info_value Survival_1 "Active dimensions")"
    memory_override=0
    if map_memory_override_present Survival_1; then
      memory_override=1
    fi

    menu_or_back "Survival_1 Actions" \
      "Memory Limit  Current: ${memory:-unknown}" \
      "Remove Memory Override" \
      "Max Dimensions  Current: ${max:-unknown}" \
      "Active Dimensions  Current: ${active:-unknown}" \
      "Edit A Dimension" \
      "Show Dimension Details" \
      "Validate / Repair Sietch State" \
      "Back To Map List" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) change_memory_for_map Survival_1; pause ;;
      2)
        if [ "$memory_override" -eq 1 ]; then
          remove_memory_for_map Survival_1
        else
          info "No memory override is currently set for Survival_1."
        fi
        pause
        ;;
      3) set_max_dimensions_for_map Survival_1; pause ;;
      4) set_active_dimensions_for_map Survival_1; pause ;;
      5)
        CHOSEN_PARTITION_ID=""
        choose_dimension_for_map Survival_1 "Pick Dimension To Edit On Survival_1" || { pause; continue; }
        edit_survival_dimension_menu "$CHOSEN_PARTITION_ID"
        ;;
      6) show_map_dimension_details Survival_1; pause ;;
      7)
        run_cmd "$DUNE" sietches reconcile Survival_1
        run_cmd "$DUNE" sietches sync
        run_cmd "$DUNE" sietches validate
        run_cmd runtime/scripts/publish-sietch-overrides.sh once
        pause
        ;;
      8) return ;;
    esac
  done
}

edit_overmap_menu() {
  local choice
  local memory
  local partition_id
  local memory_override=0
  while true; do
    memory="$(map_info_value Overmap "Memory")"
    memory_override=0
    if map_memory_override_present Overmap; then
      memory_override=1
    fi

    menu_or_back "Overmap Actions" \
      "Memory Limit  Current: ${memory:-unknown}" \
      "Remove Memory Override" \
      "Edit UserGame Partition" \
      "Show Dimension Details" \
      "Back To Map List" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) change_memory_for_map Overmap; pause ;;
      2)
        if [ "$memory_override" -eq 1 ]; then
          remove_memory_for_map Overmap
        else
          info "No memory override is currently set for Overmap."
        fi
        pause
        ;;
      3)
        CHOSEN_PARTITION_ID=""
        choose_dimension_for_map Overmap "Pick Partition To Edit On Overmap" || { pause; continue; }
        partition_id="$CHOSEN_PARTITION_ID"
        edit_usergame_menu Overmap "$partition_id"
        ;;
      4) show_map_dimension_details Overmap; pause ;;
      5) return ;;
    esac
  done
}

edit_dedicated_scaling_menu() {
  local map="$1"
  local choice
  local memory max active
  local memory_override=0
  local supports_active=0

  while true; do
    memory="$(map_info_value "$map" "Memory")"
    max="$(map_info_value "$map" "Max dimensions")"
    active="$(map_info_value "$map" "Active dimensions")"

    memory_override=0
    if map_memory_override_present "$map"; then
      memory_override=1
    fi
    supports_active=0
    if map_supports_active_dimensions "$map"; then
      supports_active=1
    fi

    if [ "$supports_active" -eq 1 ]; then
      menu_or_back "Edit Map: $map" \
        "Memory Limit  Current: ${memory:-unknown}" \
        "Remove Memory Override" \
        "Max Dimensions  Current: ${max:-unknown}" \
        "Active Dimensions  Current: ${active:-unknown}" \
        "Edit A Partition UserGame" \
        "Show Dimension Details" \
        "Back To Map List" || return
      choice="$MENU_CHOICE"

      case "$choice" in
        1) change_memory_for_map "$map"; pause ;;
        2)
          if [ "$memory_override" -eq 1 ]; then
            remove_memory_for_map "$map"
          else
            info "No memory override is currently set for $map."
          fi
          pause
        ;;
        3) set_max_dimensions_for_map "$map"; pause ;;
        4) set_active_dimensions_for_map "$map"; pause ;;
        5)
          CHOSEN_PARTITION_ID=""
          choose_dimension_for_map "$map" "Pick Partition To Edit On $map" || { pause; continue; }
          edit_usergame_menu "$map" "$CHOSEN_PARTITION_ID"
          ;;
        6) show_map_dimension_details "$map"; pause ;;
        7) return ;;
      esac
      continue
    fi

    if map_is_dedicated_scaling "$map"; then
      menu_or_back "Edit Map: $map" \
        "Memory Limit  Current: ${memory:-unknown}" \
        "Remove Memory Override" \
        "Edit UserGame Partition" \
        "Show Dimension Details" \
        "Back To Map List" || return
      choice="$MENU_CHOICE"

      case "$choice" in
        1) change_memory_for_map "$map"; pause ;;
        2)
          if [ "$memory_override" -eq 1 ]; then
            remove_memory_for_map "$map"
          else
            info "No memory override is currently set for $map."
          fi
          pause
          ;;
        3)
          CHOSEN_PARTITION_ID=""
          choose_dimension_for_map "$map" "Pick Partition To Edit On $map" || { pause; continue; }
          edit_usergame_menu "$map" "$CHOSEN_PARTITION_ID"
          ;;
        4) show_map_dimension_details "$map"; pause ;;
        5) return ;;
      esac
      continue
    fi

    menu_or_back "Edit Map: $map" \
      "Memory Limit  Current: ${memory:-unknown}" \
      "Remove Memory Override" \
      "Max Dimensions  Current: ${max:-unknown}" \
      "Edit A Partition UserGame" \
      "Show Dimension Details" \
      "Back To Map List" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) change_memory_for_map "$map"; pause ;;
      2)
        if [ "$memory_override" -eq 1 ]; then
          remove_memory_for_map "$map"
        else
          info "No memory override is currently set for $map."
        fi
        pause
        ;;
      3) set_max_dimensions_for_map "$map"; pause ;;
      4)
        CHOSEN_PARTITION_ID=""
        choose_dimension_for_map "$map" "Pick Partition To Edit On $map" || { pause; continue; }
        edit_usergame_menu "$map" "$CHOSEN_PARTITION_ID"
        ;;
      5) show_map_dimension_details "$map"; pause ;;
      6) return ;;
    esac
  done
}

updates_menu() {
  local choice rc
  while true; do
    menu_or_back "Updates" \
      "Show Installed Versions" \
      "Runtime Files Status" \
      "Repair Runtime Files" \
      "Check Stack Update" \
      "Check Game Server Update" \
      "Automatic Updates" \
      "Back" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) run_cmd "$DUNE" version; pause ;;
      2) show_runtime_files_status; pause ;;
      3)
        echo
        if confirm "Repair runtime files now?"; then
          run_cmd repair_runtime_files
        else
          echo "Cancelled."
        fi
        pause
        ;;
      4)
        echo
        set +e
        "$DUNE" self-update check
        rc=$?
        set -e
        if [ "$rc" -eq 100 ]; then
          echo
          if confirm "Install the latest stack version now?"; then
            run_cmd "$DUNE" self-update install latest
          fi
        elif [ "$rc" -ne 0 ] && [ "$rc" -ne 2 ]; then
          echo
          echo "Command exited with status $rc."
        fi
        pause
        ;;
      5)
        echo
        set +e
        "$DUNE" update check
        rc=$?
        set -e
        if [ "$rc" -eq 100 ]; then
          echo
          if confirm "Install the latest game server update now?"; then
            run_cmd "$DUNE" update
          fi
        elif [ "$rc" -ne 0 ]; then
          echo
          echo "Command exited with status $rc."
        fi
        pause
        ;;
      6) automatic_updates_menu ;;
      7) return ;;
    esac
  done
}

automatic_updates_menu() {
  local choice
  while true; do
    menu_or_back "Automatic Updates" \
      "Status" \
      "Enable" \
      "Disable" \
      "Back" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) run_cmd "$DUNE" update auto status; pause ;;
      2) run_cmd sudo "$DUNE" update auto enable; pause ;;
      3) run_cmd sudo "$DUNE" update auto disable; pause ;;
      4) return ;;
    esac
  done
}

logs_menu() {
  local choice
  while true; do
    menu_or_back "Logs" \
      "Survival_1 Logs" \
      "Overmap Logs" \
      "Director Logs" \
      "Gateway Logs" \
      "TextRouter Logs" \
      "RabbitMQ Game Logs" \
      "Autoscaler Logs" \
      "Back" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) follow_dune_logs survival; pause ;;
      2) follow_dune_logs overmap; pause ;;
      3) follow_dune_logs director; pause ;;
      4) follow_dune_logs gateway; pause ;;
      5) follow_dune_logs text-router; pause ;;
      6) follow_dune_logs rmq-game; pause ;;
      7) run_cmd "$DUNE" autoscaler logs; pause ;;
      8) return ;;
    esac
  done
}

advanced_menu() {
  local choice
  while true; do
    menu_or_back "Advanced Tools" \
      "Shell Inside Orchestrator" \
      "Run Doctor Diagnostics" \
      "Database Management" \
      "Back" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) run_cmd docker compose exec orchestrator bash; pause ;;
      2) run_cmd "$DUNE" doctor; pause ;;
      3) run_cmd runtime/scripts/db-manager.sh; pause ;;
      4) return ;;
    esac
  done
}

main_menu
