#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

DUNE="runtime/scripts/dune"
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

  prompt_text "$prompt" value || return $?
  value="$(sanitize_numeric_prompt_value "$value")"
  if ! printf '%s' "$value" | grep -Eq '^[1-9][0-9]*$'; then
    error_msg "$error_text"
    return 1
  fi

  printf -v "$__var" '%s' "$value"
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
  printf -v "$__var" '%s' "$value"
}

prompt_secret() {
  local prompt="$1"
  local __var="$2"
  local allow_empty="${3:-}"
  local value=""
  local rc

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
  printf -v "$__var" '%s' "$value"
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

  if [ ! -f .env ]; then
    echo ".env was not found. Run dune init before starting the battlegroup."
    return 1
  fi

  configured_ip="$(config_value .env SERVER_IP || true)"
  mode="$(config_value .env SERVER_IP_MODE || true)"

  if [ -z "$configured_ip" ] || [ -z "$mode" ]; then
    echo "SERVER_IP or SERVER_IP_MODE is missing from .env."
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

  if confirm "Update .env and use the new IP before starting"; then
    set_env_value SERVER_IP "$current_ip"
    echo "Updated SERVER_IP=$current_ip"
    return 0
  fi

  echo "Cancelled. Battlegroup was not started."
  return 1
}

show_config_summary() {
  echo
  echo "=== Current Configuration ==="

  if [ ! -f .env ]; then
    echo "No .env file found. Run first-time setup when you are ready."
    return
  fi

  printf "%-14s %s\n" "Title:" "$(config_value .env SERVER_TITLE || echo unknown)"
  printf "%-14s %s\n" "Region:" "$(config_value .env SERVER_REGION || echo unknown)"
  printf "%-14s %s\n" "Mode:" "$(config_value .env SERVER_IP_MODE || echo unknown)"
  printf "%-14s %s\n" "Server IP:" "$(config_value .env SERVER_IP || echo unknown)"
  printf "%-14s %s\n" "Steam app:" "$(config_value .env STEAM_APP_ID || echo unknown)"

  if [ -f runtime/generated/battlegroup.env ]; then
    printf "%-14s %s\n" "Battlegroup:" "$(config_value runtime/generated/battlegroup.env BATTLEGROUP_ID || echo unknown)"
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

set_max_dimensions_for_map() {
  local map="$1"
  local value=""

  if [ "$map" = "Overmap" ]; then
    warn "Overmap must remain at one dimension."
    return
  fi

  prompt_positive_integer "New Max Dimensions For $map:" value "Max dimensions must be a positive integer." || return

  echo
  echo "Maximum number of world partitions or servers this map can have."
  if confirm "Set max dimensions for $map to $value?"; then
    if run_cmd_status "$DUNE" sietches set-max "$map" "$value"; then
      info "This applies to future dynamic spawns and starts. Existing running containers are not restarted automatically."
    fi
  else
    echo "Cancelled."
  fi
}

set_active_dimensions_for_map() {
  local map="$1"
  local value=""

  if [ "$map" = "Overmap" ]; then
    warn "Overmap active dimensions are fixed at 1."
    return
  fi

  prompt_positive_integer "New Active Dimensions For $map:" value "Active dimensions must be a positive integer." || return

  echo
  echo "Active dimensions control how many non-dedicated dimensions should be active when supported."
  if confirm "Set active dimensions for $map to $value?"; then
    if run_cmd_status "$DUNE" sietches set-active "$map" "$value"; then
      info "This applies to future starts. Existing running containers are not restarted automatically."
    fi
  else
    echo "Cancelled."
  fi
}

choose_dimension_for_map() {
  local map="$1"
  local title="$2"
  local labels=()
  local ids=()
  local choice

  mapfile -t labels < <("$DUNE" sietches dimensions "$map" --labels)
  mapfile -t ids < <("$DUNE" sietches dimensions "$map" --ids)
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
    Survival_1) run_cmd "$DUNE" restart survival ;;
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
  echo "This restarts Survival_1, Director, and Gateway so the new name/password is republished cleanly."
  run_cmd "$DUNE" restart survival
  run_cmd "$DUNE" restart director
  run_cmd "$DUNE" restart gateway
  run_cmd runtime/scripts/publish-sietch-overrides.sh restart
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
        apply_survival_browser_change
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
      apply_survival_browser_change
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
  printf '%s' "$1" | grep -Eq '^dune-db-([a-z0-9][a-z0-9_-]*__)?[0-9]{8}-[0-9]{6}\.(dump|sql)$'
}

backup_names() {
  local backup_dir="runtime/backups/db"
  [ -d "$backup_dir" ] || return 0
  find "$backup_dir" -maxdepth 1 -type f \( -name 'dune-db-*.dump' -o -name 'dune-db-*.sql' \) -printf '%f\n' \
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

restore_backup_flow() {
  local backup

  CHOSEN_BACKUP=""
  choose_backup "Restore A Database Backup" || return
  backup="$CHOSEN_BACKUP"

  echo
  echo "Restoring a database backup will replace the current battlegroup database."
  if confirm "Restore backup '$backup'?"; then
    run_cmd env DUNE_DB_ASSUME_YES=1 "$DUNE" db restore "runtime/backups/db/$backup"
  else
    echo "Cancelled."
  fi
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
      2) run_cmd "$DUNE" ready; pause ;;
      3) run_cmd "$DUNE" version; pause ;;
      4) run_cmd "$DUNE" ps; pause ;;
      5) run_cmd "$DUNE" ports; pause ;;
      6) return ;;
    esac
  done
}

battlegroup_settings_menu() {
  local choice
  while true; do
    menu_or_back "Battlegroup Settings" \
      "Change Name" \
      "Start" \
      "Stop" \
      "Restart" \
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
            run_cmd "$DUNE" stop
            run_cmd "$DUNE" start
          fi
        else
          echo "Cancelled."
        fi
        pause
        ;;
      5) redeploy_battlegroup_flow; pause ;;
      6) dynamic_maps_menu ;;
      7) database_maintenance_menu ;;
      8) show_config_summary; pause ;;
      9) return ;;
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
      "Run Database Backup Now" \
      "Restore A Database Backup" \
      "List Database Backups" \
      "Delete A Backup" \
      "Delete All Backups" \
      "Automatic Database Backups" \
      "Database Status" \
      "Back" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) run_cmd "$DUNE" db backup; pause ;;
      2) restore_backup_flow; pause ;;
      3) run_cmd "$DUNE" db list; pause ;;
      4) delete_backup_flow; pause ;;
      5) delete_all_backups_flow; pause ;;
      6) automatic_database_backups_menu ;;
      7) run_cmd "$DUNE" db status; pause ;;
      8) return ;;
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
          run_cmd "$DUNE" db auto enable "$backup_hours" "$retention_days"
        else
          run_cmd "$DUNE" db auto enable "$backup_hours"
        fi
        pause
        ;;
      2) run_cmd "$DUNE" db auto disable; pause ;;
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
      "Edit Map" \
      "Current Memory Usage" \
      "Show Memory Settings" \
      "Set Default Memory" \
      "Remove Default Memory Setting" \
      "Back" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) run_cmd "$DUNE" sietches list; pause ;;
      2)
        CHOSEN_SIETCH_MAP=""
        choose_sietch_map || true
        if [ -n "$CHOSEN_SIETCH_MAP" ]; then
          edit_sietch_menu "$CHOSEN_SIETCH_MAP"
        else
          pause
        fi
        ;;
      3) show_current_memory_usage; pause ;;
      4) run_cmd "$DUNE" memory status; pause ;;
      5)
        echo
        prompt_text "Default Memory Value, Example 8g Or 4096m:" memory_value || { pause; continue; }
        if confirm "Set default memory to $memory_value?"; then
          run_cmd env DUNE_MEMORY_ASSUME_YES=1 "$DUNE" memory set default "$memory_value"
        else
          echo "Cancelled."
        fi
        pause
        ;;
      6)
        if confirm "Remove default memory setting?"; then
          run_cmd env DUNE_MEMORY_ASSUME_YES=1 "$DUNE" memory unset default
        else
          echo "Cancelled."
        fi
        pause
        ;;
      7) return ;;
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
  local memory display password
  while true; do
    memory="$(map_info_value Survival_1 "Memory")"
    display="$(map_info_value Survival_1 "Display name")"
    password="$(map_info_value Survival_1 "Password")"

    menu_or_back "Survival_1 Actions" \
      "Memory Limit  Current: ${memory:-unknown}" \
      "Set Display Name  Current: ${display:-unknown}" \
      "Set Password  Current: ${password:-unknown}" \
      "Back To Map List" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) change_memory_for_map Survival_1; pause ;;
      2) set_display_name_for_map Survival_1; pause ;;
      3) set_password_for_map Survival_1; pause ;;
      4) return ;;
    esac
  done
}

edit_overmap_menu() {
  local choice
  local memory
  while true; do
    memory="$(map_info_value Overmap "Memory")"

    menu_or_back "Overmap Actions" \
      "Memory Limit  Current: ${memory:-unknown}" \
      "Back To Map List" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) change_memory_for_map Overmap; pause ;;
      2) return ;;
    esac
  done
}

edit_dedicated_scaling_menu() {
  local map="$1"
  local choice
  local memory

  while true; do
    memory="$(map_info_value "$map" "Memory")"

    menu_or_back "$map Actions" \
      "Memory Limit  Current: ${memory:-unknown}" \
      "Back To Map List" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) change_memory_for_map "$map"; pause ;;
      2) return ;;
    esac
  done
}

updates_menu() {
  local choice
  while true; do
    menu_or_back "Updates" \
      "Check Update" \
      "Apply Update" \
      "Enable Automatic Updates" \
      "Disable Automatic Updates" \
      "Automatic Update Status" \
      "Back" || return
    choice="$MENU_CHOICE"

    case "$choice" in
      1) run_cmd "$DUNE" update check; pause ;;
      2) run_cmd "$DUNE" update; pause ;;
      3) run_cmd "$DUNE" update auto enable; pause ;;
      4) run_cmd "$DUNE" update auto disable; pause ;;
      5) run_cmd "$DUNE" update auto status; pause ;;
      6) return ;;
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
