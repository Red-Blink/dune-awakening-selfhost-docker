#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

DUNE="runtime/scripts/dune"
USERSETTINGS_PY="runtime/scripts/usersettings.py"
source runtime/scripts/runtime-env.sh
MENU_INTERRUPTED=0
ACTION_CANCELLED=0
MENU_CHOICE=""
MENU_ACTIVE_TTY=""
MENU_ALT_SCREEN_ACTIVE=0
MENU_CURSOR_HIDDEN=0

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
    stty "$MENU_ACTIVE_TTY" < /dev/tty 2>/dev/null || stty "$MENU_ACTIVE_TTY" 2>/dev/null || stty sane < /dev/tty 2>/dev/null || stty sane 2>/dev/null || true
    MENU_ACTIVE_TTY=""
  else
    stty sane < /dev/tty 2>/dev/null || stty sane 2>/dev/null || true
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

choose_stack_release_to_install() {
  local rows=() row tag published name
  local labels=()
  local tags=()
  local choice

  set +e
  mapfile -t rows < <("$DUNE" self-update list 2>/dev/null)
  local rc=$?
  set -e

  if [ "$rc" -ne 0 ] || [ "${#rows[@]}" -eq 0 ]; then
    echo "Could not fetch stack releases from GitHub."
    echo "Make sure the detected GitHub repo is correct and that published releases exist."
    echo "If GitHub API rate limiting is the issue, set DUNE_SELF_UPDATE_TOKEN."
    return 1
  fi

  for row in "${rows[@]}"; do
    IFS=$'	' read -r tag published name <<< "$row"
    [ -n "${tag:-}" ] || continue
    tags+=("$tag")
    if [ -n "${name:-}" ]; then
      labels+=("${tag}  ${published:-unknown}  ${name}")
    else
      labels+=("${tag}  ${published:-unknown}")
    fi
  done

  [ "${#tags[@]}" -gt 0 ] || {
    echo "No published stack releases were returned."
    return 1
  }

  labels+=("Back")
  menu_or_back "Restore Stack Release" "${labels[@]}" || return 1
  choice="$MENU_CHOICE"

  if [ "$choice" -gt "${#tags[@]}" ]; then
    return 1
  fi

  CHOSEN_STACK_RELEASE_TAG="${tags[$((choice - 1))]}"
  return 0
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
    for i in "${!options[@]}"; do
      if [ "$i" -eq "$selected" ]; then
        printf '  %s[X]%s %s%s%s\n' "$C_GREEN" "$C_RESET" "$C_BOLD" "${options[$i]}" "$C_RESET" >&2
      else
        printf '  %s[ ]%s %s\n' "$C_DIM" "$C_RESET" "${options[$i]}" >&2
      fi
    done
    echo >&2
    echo "${C_CYAN}Use Up And Down, Enter To Select. Use Back To Return.${C_RESET}" >&2
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
  chmod 600 .env
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
Global UserEngine settings apply to every map and server in the battlegroup.
These values are the battlegroup-wide baseline.
Map-specific UserGame settings can customize gameplay for a single map,
but this menu controls the global defaults used everywhere.
EOF
}

usergame_about_text() {
  local map="$1"
  local partition_id="${2:-}"
  cat <<EOF
Global UserEngine settings apply to every map and server in the battlegroup.
These values are the battlegroup-wide baseline.
Map-specific UserGame settings can customize gameplay for a single map,
but this menu controls the gameplay overrides used for ${map}${partition_id:+ partition $partition_id}.
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
    menu_or_back "Edit UserEngine (Global Defaults)"       "Port  Current: $(usersettings_value port)"       "IGWPort  Current: $(usersettings_value igw_port)"       "Mining Output Multiplier  Current: $(usersettings_value mining_output_multiplier)"       "Vehicle Mining Multiplier  Current: $(usersettings_value vehicle_mining_output_multiplier)"       "PvP Resource Multiplier  Current: $(usersettings_value pvp_resource_multiplier)"       "Vehicle Durability Damage  Current: $(usersettings_value vehicle_durability_damage_multiplier)"       "Sandstorm Enabled  Current: $(usersettings_value sandstorm_enabled)"       "Sandstorm Treasure Enabled  Current: $(usersettings_value sandstorm_treasure_enabled)"       "Sandworm Enabled  Current: $(usersettings_value sandworm_enabled)"       "Sandworm Collision Interaction  Current: $(usersettings_value sandworm_collision_interaction)"       "Sandworm Danger Zones Enabled  Current: $(usersettings_value sandworm_danger_zones_enabled)"       "Sandworm Invulnerability On Exit  Current: $(usersettings_value sandworm_invulnerability_on_exit)"       "Sandworm Invulnerability On Restart  Current: $(usersettings_value sandworm_invulnerability_on_restart)"       "Back" || return
    MENU_CONTEXT_TEXT=""
    choice="$MENU_CHOICE"

    case "$choice" in
      1) edit_userengine_port_field port "Port"; pause ;;
      2) edit_userengine_port_field igw_port "IGWPort"; pause ;;
      3) edit_userengine_numeric_field mining_output_multiplier "New mining output multiplier (example: 1.0 or 10.0, /back to cancel):" float; pause ;;
      4) edit_userengine_numeric_field vehicle_mining_output_multiplier "New vehicle mining multiplier (example: 1.0 or 10.0, /back to cancel):" float; pause ;;
      5) edit_userengine_numeric_field pvp_resource_multiplier "New PvP resource multiplier (example: 2.5, /back to cancel):" float; pause ;;
      6) edit_userengine_numeric_field vehicle_durability_damage_multiplier "New vehicle durability damage multiplier (example: 1.0, /back to cancel):" float; pause ;;
      7) edit_userengine_boolean_field sandstorm_enabled "Set Sandstorm" "Enabled (1)" "Disabled (0)" "1" "0"; pause ;;
      8) edit_userengine_boolean_field sandstorm_treasure_enabled "Set Sandstorm Treasure" "Enabled (1)" "Disabled (0)" "1" "0"; pause ;;
      9) edit_userengine_boolean_field sandworm_enabled "Set Sandworm" "Enabled (1)" "Disabled (0)" "1" "0"; pause ;;
      10) edit_userengine_boolean_field sandworm_collision_interaction "Set Sandworm Collision Interaction" "True" "False" "true" "false"; pause ;;
      11) edit_userengine_boolean_field sandworm_danger_zones_enabled "Set Sandworm Danger Zones" "True" "False" "true" "false"; pause ;;
      12) edit_userengine_numeric_field sandworm_invulnerability_on_exit "Seconds of sandworm invulnerability on exit (/back to cancel):" float; pause ;;
      13) edit_userengine_numeric_field sandworm_invulnerability_on_restart "Seconds of sandworm invulnerability after restart (/back to cancel):" float; pause ;;
      14) return ;;
    esac
  done
}

edit_usergame_menu() {
  local map="$1"
  local partition_id="${2:-}"
  local choice

  while true; do
    if [ -n "$partition_id" ]; then
      load_usersettings_values partition "$map" "$partition_id"
      MENU_CONTEXT_TEXT="$(usergame_about_text "$map" "$partition_id")"
      menu_or_back "Edit UserGame: $map${partition_id:+ (Dimension $partition_id)}"         "Partition PvP Enabled  Current: $(usersettings_value partition_pvp_enabled)"         "Security Zones Enabled  Current: $(usersettings_value security_zones_enabled)"         "Item Deterioration Rate  Current: $(usersettings_value item_deterioration_rate)"         "Coriolis Storm Enabled  Current: $(usersettings_value coriolis_auto_spawn_enabled)"         "Max Landclaim Segments  Current: $(usersettings_value max_landclaim_segments)"         "Building Blueprint Max Extensions  Current: $(usersettings_value building_blueprint_max_extensions)"         "Base Backup Max Extensions  Current: $(usersettings_value base_backup_max_extensions)"         "Building Restriction Limits Enabled  Current: $(usersettings_value building_restriction_limits_enabled)"         "Back" || return
      MENU_CONTEXT_TEXT=""
      choice="$MENU_CHOICE"

      case "$choice" in
        1) edit_usergame_boolean_field "$map" partition_pvp_enabled "Set Partition PvP" "Enabled" "Disabled" "True" "False" "$partition_id"; pause ;;
        2) edit_usergame_boolean_field "$map" security_zones_enabled "Set Security Zones" "True" "False" "True" "False" "$partition_id"; pause ;;
        3) edit_usergame_numeric_field "$map" item_deterioration_rate "New deterioration rate (0-10, 0 disables, /back to cancel):" float "$partition_id"; pause ;;
        4) edit_usergame_boolean_field "$map" coriolis_auto_spawn_enabled "Set Coriolis Storm Auto Spawn" "True" "False" "True" "False" "$partition_id"; pause ;;
        5) edit_usergame_numeric_field "$map" max_landclaim_segments "Maximum landclaim segments (/back to cancel):" int "$partition_id"; pause ;;
        6) edit_usergame_numeric_field "$map" building_blueprint_max_extensions "Building blueprint max extensions (/back to cancel):" int "$partition_id"; pause ;;
        7) edit_usergame_numeric_field "$map" base_backup_max_extensions "Base backup max extensions (/back to cancel):" int "$partition_id"; pause ;;
        8) edit_usergame_boolean_field "$map" building_restriction_limits_enabled "Set Building Restriction Limits" "True" "False" "True" "False" "$partition_id"; pause ;;
        9) return ;;
      esac
    else
      load_usersettings_values map "$map"
      MENU_CONTEXT_TEXT="$(usergame_about_text "$map" "$partition_id")"
      menu_or_back "Edit UserGame: $map${partition_id:+ (Dimension $partition_id)}"         "Security Zones Enabled  Current: $(usersettings_value security_zones_enabled)"         "Item Deterioration Rate  Current: $(usersettings_value item_deterioration_rate)"         "Coriolis Storm Enabled  Current: $(usersettings_value coriolis_auto_spawn_enabled)"         "Max Landclaim Segments  Current: $(usersettings_value max_landclaim_segments)"         "Building Blueprint Max Extensions  Current: $(usersettings_value building_blueprint_max_extensions)"         "Base Backup Max Extensions  Current: $(usersettings_value base_backup_max_extensions)"         "Building Restriction Limits Enabled  Current: $(usersettings_value building_restriction_limits_enabled)"         "Back" || return
      MENU_CONTEXT_TEXT=""
      choice="$MENU_CHOICE"

      case "$choice" in
        1) edit_usergame_boolean_field "$map" security_zones_enabled "Set Security Zones" "True" "False" "True" "False"; pause ;;
        2) edit_usergame_numeric_field "$map" item_deterioration_rate "New deterioration rate (0-10, 0 disables, /back to cancel):" float; pause ;;
        3) edit_usergame_boolean_field "$map" coriolis_auto_spawn_enabled "Set Coriolis Storm Auto Spawn" "True" "False" "True" "False"; pause ;;
        4) edit_usergame_numeric_field "$map" max_landclaim_segments "Maximum landclaim segments (/back to cancel):" int; pause ;;
        5) edit_usergame_numeric_field "$map" building_blueprint_max_extensions "Building blueprint max extensions (/back to cancel):" int; pause ;;
        6) edit_usergame_numeric_field "$map" base_backup_max_extensions "Base backup max extensions (/back to cancel):" int; pause ;;
        7) edit_usergame_boolean_field "$map" building_restriction_limits_enabled "Set Building Restriction Limits" "True" "False" "True" "False"; pause ;;
        8) return ;;
      esac
    fi
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
  echo "This restarts Survival_1, Director, Gateway, and the sietch override publisher so the new name/password is republished cleanly."
  run_cmd "$DUNE" restart survival
  run_cmd "$DUNE" restart director
  run_cmd "$DUNE" restart gateway
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
  echo "This respawns the selected Survival_1 dimension and republishes the sietch overrides."
  run_cmd "$DUNE" despawn "$partition_id"
  run_cmd "$DUNE" spawn "$partition_id"
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

  echo
  echo "Restoring a database backup will replace the current battlegroup database."
  if confirm "Restore backup '$backup_name'?"; then
    run_cmd env DUNE_DB_ASSUME_YES=1 "$DUNE" db restore "$backup_path"
  else
    echo "Cancelled."
  fi
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
  choose_backup "Restore A Database Backup" || return
  backup="$CHOSEN_BACKUP"

  restore_specific_backup_path "runtime/backups/db/$backup" "$backup"
}

delete_backup_flow() {
  local backup

  CHOSEN_BACKUP=""
  choose_backup "Delete A Backup" || return
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
      6) advanced_menu ;;
      7) echo "Goodbye."; exit 0 ;;
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
  local choice restart_hours
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
              scheduled_restart_hours=""
              echo
              prompt_text "Restart Every How Many Hours:" scheduled_restart_hours || { pause; continue; }
              scheduled_restart_hours="$(sanitize_numeric_prompt_value "$scheduled_restart_hours")"
              if ! printf '%s' "$scheduled_restart_hours" | grep -Eq '^[1-9][0-9]*$'; then
                error_msg "Hours must be a positive integer."
                pause
                continue
              fi
              if confirm "Enable scheduled restart every $scheduled_restart_hours hour(s)?"; then
                run_cmd sudo "$DUNE" restart-schedule enable "$scheduled_restart_hours"
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
      6) run_cmd "$DUNE" autoscaler logs; pause ;;
      7) return ;;
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
      8) run_cmd "$DUNE" db health; pause ;;
      9) run_cmd "$DUNE" db status; pause ;;
      10) return ;;
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
        prompt_text "Backup Interval In Hours:" backup_hours || { pause; continue; }
        prompt_text "Keep Backups For How Many Days? Leave Blank For No Automatic Cleanup:" retention_days allow-empty || { pause; continue; }
        if [ -z "$backup_hours" ]; then
          echo "Backup interval is required."
        elif [ -n "$retention_days" ]; then
          run_cmd sudo "$DUNE" db auto enable "$backup_hours" "$retention_days"
        else
          run_cmd sudo "$DUNE" db auto enable "$backup_hours"
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
      2) edit_userengine_menu ;;
      3)
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
      4)
        if confirm "Revert all UserEngine and UserGame overrides to defaults?"; then
          reset_all_usersettings
        else
          echo "Cancelled."
        fi
        pause
        ;;
      5) show_current_memory_usage; pause ;;
      6) run_cmd "$DUNE" memory status; pause ;;
      7) restore_builtin_memory_defaults; pause ;;
      8) return ;;
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
      7) return ;;
    esac
  done
}

edit_overmap_menu() {
  local choice
  local memory
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
      3) show_map_dimension_details Overmap; pause ;;
      4) return ;;
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

    if map_is_dedicated_scaling "$map"; then
      menu_or_back "Edit Map: $map" \
        "Memory Limit  Current: ${memory:-unknown}" \
        "Remove Memory Override" \
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
        3) show_map_dimension_details "$map"; pause ;;
        4) return ;;
      esac
      continue
    fi

    if [ "$supports_active" -eq 1 ]; then
      menu_or_back "Edit Map: $map" \
        "Memory Limit  Current: ${memory:-unknown}" \
        "Remove Memory Override" \
        "Max Dimensions  Current: ${max:-unknown}" \
        "Active Dimensions  Current: ${active:-unknown}" \
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
        5) show_map_dimension_details "$map"; pause ;;
        6) return ;;
      esac
      continue
    fi

    menu_or_back "Edit Map: $map" \
      "Memory Limit  Current: ${memory:-unknown}" \
      "Remove Memory Override" \
      "Max Dimensions  Current: ${max:-unknown}" \
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
      4) show_map_dimension_details "$map"; pause ;;
      5) return ;;
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
      "Restore Previous Stack" \
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
        if choose_stack_release_to_install; then
          echo
          if confirm "Install stack release '$CHOSEN_STACK_RELEASE_TAG' now?"; then
            run_cmd "$DUNE" self-update install "$CHOSEN_STACK_RELEASE_TAG"
          else
            echo "Cancelled."
          fi
        else
          echo "Cancelled."
        fi
        pause
        ;;
      6)
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
      7) automatic_updates_menu ;;
      8) return ;;
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
      "Back" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) run_cmd docker compose exec orchestrator bash; pause ;;
      2) run_cmd "$DUNE" doctor; pause ;;
      3) return ;;
    esac
  done
}

main_menu
