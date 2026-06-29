#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"
HOST_ROOT_DIR="${DUNE_HOST_REPO_ROOT:-$ROOT_DIR}"

[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env
. runtime/scripts/runtime-env.sh

SERVER_TITLE="$(resolve_server_title)"
SERVER_REGION="$(resolve_server_region)"
SERVER_IP="$(resolve_server_ip)"
export SERVER_TITLE SERVER_REGION SERVER_IP

APP_ID="${STEAM_APP_ID:-4754530}"

cmd="${1:-run}"

AUTO_STATE_FILE="runtime/generated/update-auto.env"
MANUAL_STOP_FILE="runtime/generated/manual-stop.env"
AUTO_SERVICE_NAME="dune-awakening-auto-update.service"
AUTO_TIMER_NAME="dune-awakening-auto-update.timer"
AUTO_SERVICE_FILE="/etc/systemd/system/$AUTO_SERVICE_NAME"
AUTO_TIMER_FILE="/etc/systemd/system/$AUTO_TIMER_NAME"
AUTO_DEFAULT_TIME="${DUNE_AUTO_UPDATE_TIME:-05:00}"
AUTO_DEFAULT_INTERVAL_MINUTES="${DUNE_AUTO_UPDATE_INTERVAL_MINUTES:-60}"
AUTO_PENDING_FILE="runtime/generated/update-auto-pending.env"

container_running() {
  local name="$1"
  docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null | grep -qx true
}

dune_stack_has_running_services() {
  docker ps --format '{{.Names}}' 2>/dev/null \
    | grep -Eq '^dune-(postgres|rmq-admin|rmq-game|text-router|director|server-gateway|server-|autoscaler)$'
}

stop_temporary_postgres() {
  if [ "${update_started_postgres:-0}" = "1" ] && [ "${postgres_was_running:-0}" != "1" ]; then
    echo
    echo "=== Stop temporary Postgres ==="
    docker rm -f dune-postgres >/dev/null 2>&1 || true
    echo "Postgres was started only for the update and has been stopped again."
  fi
}

cleanup_update_state() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "${stack_was_stopped:-0}" = "1" ]; then
    stop_temporary_postgres
  fi
  exit "$rc"
}

trap cleanup_update_state EXIT

write_auto_state() {
  local enabled="$1"
  local interval_minutes="$2"
  local apply_enabled="${3:-${DUNE_AUTO_UPDATE_APPLY_ENABLED:-1}}"
  local notify_enabled="${4:-${DUNE_AUTO_UPDATE_NOTIFY_ENABLED:-1}}"
  local notify_minutes="${5:-${DUNE_AUTO_UPDATE_NOTIFY_MINUTES:-15}}"
  local wait_empty="${6:-${DUNE_AUTO_UPDATE_WAIT_EMPTY:-0}}"
  local max_wait_minutes="${7:-${DUNE_AUTO_UPDATE_MAX_WAIT_MINUTES:-360}}"
  local timer_installed="${8:-${DUNE_AUTO_UPDATE_TIMER_INSTALLED:-0}}"
  local tmp

  mkdir -p runtime/generated
  tmp="${AUTO_STATE_FILE}.$$"
  cat > "$tmp" <<EOF
DUNE_AUTO_UPDATE_ENABLED=$enabled
DUNE_AUTO_UPDATE_TIME=${DUNE_AUTO_UPDATE_TIME:-$AUTO_DEFAULT_TIME}
DUNE_AUTO_UPDATE_INTERVAL_MINUTES=$interval_minutes
DUNE_AUTO_UPDATE_APPLY_ENABLED=$apply_enabled
DUNE_AUTO_UPDATE_NOTIFY_ENABLED=$notify_enabled
DUNE_AUTO_UPDATE_NOTIFY_MINUTES=$notify_minutes
DUNE_AUTO_UPDATE_WAIT_EMPTY=$wait_empty
DUNE_AUTO_UPDATE_MAX_WAIT_MINUTES=$max_wait_minutes
DUNE_AUTO_UPDATE_TIMER_INSTALLED=$timer_installed
EOF
  chmod 644 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$AUTO_STATE_FILE"
}

read_auto_state() {
  DUNE_AUTO_UPDATE_ENABLED=0
  DUNE_AUTO_UPDATE_TIME="$AUTO_DEFAULT_TIME"
  DUNE_AUTO_UPDATE_INTERVAL_MINUTES="$AUTO_DEFAULT_INTERVAL_MINUTES"
  DUNE_AUTO_UPDATE_APPLY_ENABLED=1
  DUNE_AUTO_UPDATE_NOTIFY_ENABLED=1
  DUNE_AUTO_UPDATE_NOTIFY_MINUTES=15
  DUNE_AUTO_UPDATE_WAIT_EMPTY=0
  DUNE_AUTO_UPDATE_MAX_WAIT_MINUTES=360
  DUNE_AUTO_UPDATE_TIMER_INSTALLED=""
  if [ -f "$AUTO_STATE_FILE" ]; then
    # shellcheck disable=SC1090
    . "$AUTO_STATE_FILE"
  fi
}

require_auto_interval_minutes() {
  local value="$1"
  if ! printf '%s' "$value" | grep -Eq '^[0-9]+$' || [ "$value" -lt 5 ] || [ "$value" -gt 1440 ]; then
    echo "Auto-update check interval must be between 5 and 1440 minutes."
    exit 2
  fi
}

require_bool_flag() {
  local value="$1"
  local label="$2"
  if ! printf '%s' "$value" | grep -Eq '^(0|1)$'; then
    echo "$label must be 0 or 1."
    exit 2
  fi
}

require_auto_notify_minutes() {
  local value="$1"
  if ! printf '%s' "$value" | grep -Eq '^[0-9]+$' || [ "$value" -lt 1 ] || [ "$value" -gt 1440 ]; then
    echo "Auto-update notification time must be between 1 and 1440 minutes."
    exit 2
  fi
}

require_auto_max_wait_minutes() {
  local value="$1"
  if ! printf '%s' "$value" | grep -Eq '^[0-9]+$' || [ "$value" -lt 0 ] || [ "$value" -gt 10080 ]; then
    echo "Auto-update max wait must be between 0 and 10080 minutes."
    exit 2
  fi
}

can_manage_systemd_units() {
  [ -d /etc/systemd/system ] && [ -w /etc/systemd/system ]
}

write_auto_units_to() {
  local interval_minutes="$1"
  local systemd_dir="$2"
  local exec_root="$3"

  mkdir -p "$systemd_dir"
  cat > "$systemd_dir/$AUTO_SERVICE_NAME" <<EOF
[Unit]
Description=Dune Awakening self-host auto update
Wants=docker.service
After=network-online.target docker.service

[Service]
Type=oneshot
WorkingDirectory=$exec_root
ExecStart=$exec_root/runtime/scripts/update.sh auto run
EOF

  cat > "$systemd_dir/$AUTO_TIMER_NAME" <<EOF
[Unit]
Description=Run Dune Awakening self-host auto update

[Timer]
OnBootSec=5min
OnUnitActiveSec=${interval_minutes}min
AccuracySec=1min
Persistent=true
Unit=$AUTO_SERVICE_NAME

[Install]
WantedBy=timers.target
EOF
}

docker_helper_image() {
  printf '%s' "${DUNE_SYSTEMD_HELPER_IMAGE:-redblink-dune-docker-console:dev}"
}

can_manage_host_systemd_with_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  [ -S /var/run/docker.sock ] || return 1
  docker image inspect "$(docker_helper_image)" >/dev/null 2>&1 || return 1
}

install_auto_units_via_docker_host() {
  local interval_minutes="$1"
  local image
  image="$(docker_helper_image)"

  can_manage_host_systemd_with_docker || return 1
  docker run --rm --privileged --pid=host --network=host \
    -e DUNE_AUTO_UPDATE_INTERVAL_MINUTES="$interval_minutes" \
    -e DUNE_HOST_REPO_ROOT="$HOST_ROOT_DIR" \
    -v /:/host \
    --entrypoint bash \
    "$image" -lc '
      set -euo pipefail
      systemd_dir=/host/etc/systemd/system
      mkdir -p "$systemd_dir"
      cat > "$systemd_dir/dune-awakening-auto-update.service" <<EOF
[Unit]
Description=Dune Awakening self-host auto update
Wants=docker.service
After=network-online.target docker.service

[Service]
Type=oneshot
WorkingDirectory=${DUNE_HOST_REPO_ROOT}
ExecStart=${DUNE_HOST_REPO_ROOT}/runtime/scripts/update.sh auto run
EOF
      cat > "$systemd_dir/dune-awakening-auto-update.timer" <<EOF
[Unit]
Description=Run Dune Awakening self-host auto update

[Timer]
OnBootSec=5min
OnUnitActiveSec=${DUNE_AUTO_UPDATE_INTERVAL_MINUTES}min
AccuracySec=1min
Persistent=true
Unit=dune-awakening-auto-update.service

[Install]
WantedBy=timers.target
EOF
      chroot /host /bin/systemctl daemon-reload
      chroot /host /bin/systemctl enable --now dune-awakening-auto-update.timer
    '
}

disable_auto_units_via_docker_host() {
  local image
  image="$(docker_helper_image)"

  can_manage_host_systemd_with_docker || return 1
  docker run --rm --privileged --pid=host --network=host \
    -v /:/host \
    --entrypoint bash \
    "$image" -lc '
      set -euo pipefail
      chroot /host /bin/systemctl disable --now dune-awakening-auto-update.timer >/dev/null 2>&1 || true
      rm -f /host/etc/systemd/system/dune-awakening-auto-update.service /host/etc/systemd/system/dune-awakening-auto-update.timer
      chroot /host /bin/systemctl daemon-reload
    '
}

show_auto_timer_status_via_docker() {
  local image
  image="$(docker_helper_image)"

  can_manage_host_systemd_with_docker || return 1
  docker run --rm --privileged --pid=host --network=host \
    -v /:/host \
    --entrypoint bash \
    "$image" -lc '
      set -euo pipefail
      if chroot /host /bin/systemctl list-unit-files dune-awakening-auto-update.timer --no-legend --no-pager 2>/dev/null | grep -q "^dune-awakening-auto-update.timer"; then
        timer_active="$(chroot /host /bin/systemctl is-active dune-awakening-auto-update.timer 2>/dev/null || true)"
        if [ "$timer_active" = "active" ]; then
          echo "Systemd timer: active"
        else
          echo "Systemd timer: inactive"
        fi
        chroot /host /bin/systemctl list-timers --all dune-awakening-auto-update.timer --no-pager || true
      else
        echo "Systemd timer: not installed"
      fi
    '
}

handle_auto_update() {
  sub="${1:-status}"
  interval_minutes="${2:-$AUTO_DEFAULT_INTERVAL_MINUTES}"
  apply_enabled="${3:-1}"
  notify_enabled="${4:-1}"
  notify_minutes="${5:-15}"
  wait_empty="${6:-0}"
  max_wait_minutes="${7:-360}"

  mkdir -p runtime/generated

  case "$sub" in
    enable|on)
      if printf '%s' "$interval_minutes" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]$'; then
        interval_minutes="$AUTO_DEFAULT_INTERVAL_MINUTES"
      fi
      require_auto_interval_minutes "$interval_minutes"
      require_bool_flag "$apply_enabled" "Apply update"
      require_bool_flag "$notify_enabled" "Notify players"
      require_auto_notify_minutes "$notify_minutes"
      require_bool_flag "$wait_empty" "Wait until empty"
      require_auto_max_wait_minutes "$max_wait_minutes"

      if ! command -v systemctl >/dev/null 2>&1; then
        if install_auto_units_via_docker_host "$interval_minutes"; then
          write_auto_state 1 "$interval_minutes" "$apply_enabled" "$notify_enabled" "$notify_minutes" "$wait_empty" "$max_wait_minutes" 1
          echo "Auto updates enabled."
          echo "Check interval: every $interval_minutes minutes"
          echo "Timer: $AUTO_TIMER_NAME"
          return 0
        else
          write_auto_state 1 "$interval_minutes" "$apply_enabled" "$notify_enabled" "$notify_minutes" "$wait_empty" "$max_wait_minutes" 0
          echo "Auto-update preference saved, but systemctl was not found and the host timer could not be installed through Docker."
          echo "Saved: $AUTO_STATE_FILE"
          echo "To install the timer, run this command with sudo/root:"
          echo "  runtime/scripts/update.sh auto enable $interval_minutes $apply_enabled $notify_enabled $notify_minutes $wait_empty $max_wait_minutes"
          return 1
        fi
      fi

      if ! can_manage_systemd_units; then
        if install_auto_units_via_docker_host "$interval_minutes"; then
          write_auto_state 1 "$interval_minutes" "$apply_enabled" "$notify_enabled" "$notify_minutes" "$wait_empty" "$max_wait_minutes" 1
          echo "Auto updates enabled."
          echo "Check interval: every $interval_minutes minutes"
          echo "Timer: $AUTO_TIMER_NAME"
          return 0
        else
          write_auto_state 1 "$interval_minutes" "$apply_enabled" "$notify_enabled" "$notify_minutes" "$wait_empty" "$max_wait_minutes" 0
          echo "Auto-update preference saved, but this user cannot install systemd units."
          echo "Saved: $AUTO_STATE_FILE"
          echo "To install the timer, run this command with sudo/root:"
          echo "  runtime/scripts/update.sh auto enable $interval_minutes $apply_enabled $notify_enabled $notify_minutes $wait_empty $max_wait_minutes"
          return 1
        fi
      fi

      write_auto_units_to "$interval_minutes" "/etc/systemd/system" "$HOST_ROOT_DIR"
      systemctl daemon-reload
      systemctl enable --now "$AUTO_TIMER_NAME"
      write_auto_state 1 "$interval_minutes" "$apply_enabled" "$notify_enabled" "$notify_minutes" "$wait_empty" "$max_wait_minutes" 1

      echo "Auto updates enabled."
      echo "Check interval: every $interval_minutes minutes"
      echo "Timer: $AUTO_TIMER_NAME"
      ;;

    disable|off)
      read_auto_state
      if command -v systemctl >/dev/null 2>&1 && can_manage_systemd_units; then
        systemctl disable --now "$AUTO_TIMER_NAME" >/dev/null 2>&1 || true
        rm -f "$AUTO_SERVICE_FILE" "$AUTO_TIMER_FILE"
        systemctl daemon-reload
        write_auto_state 0 "${DUNE_AUTO_UPDATE_INTERVAL_MINUTES:-$interval_minutes}" "${DUNE_AUTO_UPDATE_APPLY_ENABLED:-1}" "${DUNE_AUTO_UPDATE_NOTIFY_ENABLED:-1}" "${DUNE_AUTO_UPDATE_NOTIFY_MINUTES:-15}" "${DUNE_AUTO_UPDATE_WAIT_EMPTY:-0}" "${DUNE_AUTO_UPDATE_MAX_WAIT_MINUTES:-360}" 0
      elif can_manage_host_systemd_with_docker; then
        disable_auto_units_via_docker_host
        write_auto_state 0 "${DUNE_AUTO_UPDATE_INTERVAL_MINUTES:-$interval_minutes}" "${DUNE_AUTO_UPDATE_APPLY_ENABLED:-1}" "${DUNE_AUTO_UPDATE_NOTIFY_ENABLED:-1}" "${DUNE_AUTO_UPDATE_NOTIFY_MINUTES:-15}" "${DUNE_AUTO_UPDATE_WAIT_EMPTY:-0}" "${DUNE_AUTO_UPDATE_MAX_WAIT_MINUTES:-360}" 0
      elif [ "${DUNE_AUTO_UPDATE_TIMER_INSTALLED:-0}" != "1" ] && [ "${DUNE_AUTO_UPDATE_ENABLED:-0}" != "1" ]; then
        write_auto_state 0 "${DUNE_AUTO_UPDATE_INTERVAL_MINUTES:-$interval_minutes}" "${DUNE_AUTO_UPDATE_APPLY_ENABLED:-1}" "${DUNE_AUTO_UPDATE_NOTIFY_ENABLED:-1}" "${DUNE_AUTO_UPDATE_NOTIFY_MINUTES:-15}" "${DUNE_AUTO_UPDATE_WAIT_EMPTY:-0}" "${DUNE_AUTO_UPDATE_MAX_WAIT_MINUTES:-360}" 0
      else
        echo "Auto updates could not be disabled because the host timer cannot be managed from this environment."
        return 1
      fi

      echo "Auto updates disabled."
      ;;

    status)
      read_auto_state

      echo "Auto updates enabled: $DUNE_AUTO_UPDATE_ENABLED"
      echo "Auto update time:      $DUNE_AUTO_UPDATE_TIME"
      echo "Check interval minutes: ${DUNE_AUTO_UPDATE_INTERVAL_MINUTES:-$AUTO_DEFAULT_INTERVAL_MINUTES}"
      echo "Apply updates:        ${DUNE_AUTO_UPDATE_APPLY_ENABLED:-1}"
      echo "Notify players:       ${DUNE_AUTO_UPDATE_NOTIFY_ENABLED:-1}"
      echo "Notify minutes:       ${DUNE_AUTO_UPDATE_NOTIFY_MINUTES:-15}"
      echo "Wait until empty:     ${DUNE_AUTO_UPDATE_WAIT_EMPTY:-0}"
      echo "Max wait minutes:     ${DUNE_AUTO_UPDATE_MAX_WAIT_MINUTES:-360}"
      if [ -f "$AUTO_PENDING_FILE" ]; then
        # shellcheck disable=SC1090
        . "$AUTO_PENDING_FILE"
        echo "Pending build:        ${DUNE_AUTO_UPDATE_PENDING_BUILD:-unknown}"
        echo "Pending since:        ${DUNE_AUTO_UPDATE_PENDING_SINCE:-unknown}"
      fi

      if [ "${DUNE_AUTO_UPDATE_TIMER_INSTALLED:-}" = "1" ]; then
        echo
        if [ "${DUNE_AUTO_UPDATE_ENABLED:-0}" = "1" ]; then
          echo "Systemd timer: active"
        else
          echo "Systemd timer: inactive"
        fi
      elif command -v systemctl >/dev/null 2>&1; then
        echo
        if systemctl list-unit-files "$AUTO_TIMER_NAME" --no-legend --no-pager 2>/dev/null | grep -q "^$AUTO_TIMER_NAME"; then
          timer_active="$(systemctl is-active "$AUTO_TIMER_NAME" 2>/dev/null || true)"
          if [ "$timer_active" = "active" ]; then
            echo "Systemd timer: active"
          else
            echo "Systemd timer: inactive"
          fi
          systemctl list-timers --all "$AUTO_TIMER_NAME" --no-pager || true
        else
          echo "Systemd timer: not installed"
        fi
      else
        echo
        show_auto_timer_status_via_docker || echo "Systemd timer: not installed"
      fi
      ;;

    run)
      run_auto_update_policy
      ;;

    *)
      echo "Unknown auto-update command: $sub"
      echo "Usage:"
      echo "  dune update auto enable [interval-minutes] [apply 0|1] [notify 0|1] [notify-minutes] [wait-empty 0|1] [max-wait-minutes]"
      echo "  dune update auto disable"
      echo "  dune update auto status"
      echo "  dune update auto run"
      return 2
      ;;
  esac
}

online_player_count() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-postgres || {
    echo 0
    return 0
  }

  docker exec dune-postgres psql -U dune -d dune -Atc "
    select greatest(
      coalesce((select sum(coalesce(connected_players, 0)) from dune.farm_state where coalesce(alive, false)), 0),
      coalesce((select count(*) from dune.player_state where coalesce(online_status::text, '') = 'Online'), 0)
    );
  " 2>/dev/null | tr -d '[:space:]' || echo 0
}

write_auto_pending() {
  local build="$1"
  local first_seen="$2"
  local notified="$3"
  local tmp

  mkdir -p runtime/generated
  tmp="${AUTO_PENDING_FILE}.$$"
  cat >"$tmp" <<EOF
DUNE_AUTO_UPDATE_PENDING_BUILD=$build
DUNE_AUTO_UPDATE_PENDING_SINCE=$first_seen
DUNE_AUTO_UPDATE_PENDING_NOTIFIED=$notified
EOF
  chmod 644 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$AUTO_PENDING_FILE"
}

run_auto_update_policy() {
  read_auto_state
  [ "${DUNE_AUTO_UPDATE_ENABLED:-0}" = "1" ] || {
    echo "Auto updates are disabled."
    return 0
  }

  local check_log check_rc remote_build now first_seen notified players age_seconds max_wait_seconds
  check_log="$(mktemp)"
  set +e
  "$0" check >"$check_log" 2>&1
  check_rc=$?
  set -e
  cat "$check_log"

  case "$check_rc" in
    0)
      rm -f "$AUTO_PENDING_FILE" "$check_log"
      echo "No auto-update action needed."
      return 0
      ;;
    100)
      ;;
    *)
      rm -f "$check_log"
      echo "Auto update check failed with exit code: $check_rc"
      return "$check_rc"
      ;;
  esac

  if [ "${DUNE_AUTO_UPDATE_APPLY_ENABLED:-1}" != "1" ]; then
    rm -f "$check_log"
    echo "Update is available, but automatic apply is disabled."
    return 0
  fi

  remote_build="$(awk -F: '/Remote build:/ { gsub(/^[[:space:]]+/, "", $2); print $2; exit }' "$check_log")"
  remote_build="${remote_build:-unknown}"
  rm -f "$check_log"

  now="$(date +%s)"
  first_seen="$now"
  notified=0
  if [ -f "$AUTO_PENDING_FILE" ]; then
    # shellcheck disable=SC1090
    . "$AUTO_PENDING_FILE"
    if [ "${DUNE_AUTO_UPDATE_PENDING_BUILD:-}" = "$remote_build" ]; then
      first_seen="${DUNE_AUTO_UPDATE_PENDING_SINCE:-$now}"
      notified="${DUNE_AUTO_UPDATE_PENDING_NOTIFIED:-0}"
    fi
  fi

  if [ "${DUNE_AUTO_UPDATE_NOTIFY_ENABLED:-1}" = "1" ] && [ "$notified" != "1" ]; then
    runtime/scripts/dune admin broadcast-restart-warning "${DUNE_AUTO_UPDATE_NOTIFY_MINUTES:-15}" || true
    notified=1
  fi
  write_auto_pending "$remote_build" "$first_seen" "$notified"

  if [ "${DUNE_AUTO_UPDATE_WAIT_EMPTY:-0}" = "1" ]; then
    players="$(online_player_count)"
    players="${players:-0}"
    max_wait_seconds="$((${DUNE_AUTO_UPDATE_MAX_WAIT_MINUTES:-360} * 60))"
    age_seconds="$((now - first_seen))"
    if [ "$players" -gt 0 ] 2>/dev/null && { [ "$max_wait_seconds" -eq 0 ] || [ "$age_seconds" -lt "$max_wait_seconds" ]; }; then
      echo "Update is pending, but $players player(s) are online. Waiting for the server to empty."
      return 0
    fi
    if [ "$players" -gt 0 ] 2>/dev/null; then
      echo "Max wait reached with $players player(s) online; applying update now."
    else
      echo "Server is empty; applying pending update."
    fi
  elif [ "${DUNE_AUTO_UPDATE_NOTIFY_ENABLED:-1}" = "1" ]; then
    echo "Waiting ${DUNE_AUTO_UPDATE_NOTIFY_MINUTES:-15} minute(s) after player warning before applying update."
    sleep "$((DUNE_AUTO_UPDATE_NOTIFY_MINUTES * 60))"
  fi

  "$0" --yes
  rm -f "$AUTO_PENDING_FILE"
}

if [ "$cmd" = "auto" ]; then
  handle_auto_update "${2:-status}" "${3:-$AUTO_DEFAULT_INTERVAL_MINUTES}" "${4:-1}" "${5:-1}" "${6:-15}" "${7:-0}" "${8:-360}"
  exit $?
fi

if [ "$cmd" = "fix-steamcmd" ]; then
  docker compose exec -T -e APP_ID="$APP_ID" orchestrator bash -lc '
set -euo pipefail
APP_ID="${APP_ID:-4754530}"
MANIFEST="/srv/dune/server/steamapps/appmanifest_${APP_ID}.acf"
if [ -f "$MANIFEST" ]; then
  rm -f "$MANIFEST"
  echo "SteamCMD app manifest removed. It will be regenerated on the next game update."
else
  echo "SteamCMD app manifest was already absent. The next game update will generate it."
fi
'
  exit $?
fi

if [ "$cmd" = "fix-install-dir" ]; then
  docker compose exec -T -u root orchestrator sh -lc '
set -eu
mkdir -p /srv/dune/server /srv/dune/steam /srv/dune/cache /srv/dune/generated /home/dune/.steam
chown -R dune:dune /srv/dune /home/dune
runuser -u dune -- sh -lc "
  touch /srv/dune/server/.dune-write-test &&
  rm -f /srv/dune/server/.dune-write-test &&
  touch /srv/dune/steam/.dune-write-test &&
  rm -f /srv/dune/steam/.dune-write-test
"
df -h /srv/dune/server /srv/dune/steam /srv/dune/cache
echo "Dune install directories are writable."
'
  exit $?
fi

fix_steamcmd_manifest() {
  docker compose exec -T -e APP_ID="$APP_ID" orchestrator bash -lc '
set -euo pipefail
APP_ID="${APP_ID:-4754530}"
MANIFEST="/srv/dune/server/steamapps/appmanifest_${APP_ID}.acf"
if [ -f "$MANIFEST" ]; then
  rm -f "$MANIFEST"
  echo "SteamCMD app manifest removed. It will be regenerated on the next game update attempt."
else
  echo "SteamCMD app manifest was already absent. The next game update attempt will generate it."
fi
'
}

if [ "$cmd" = "check" ] || [ "$cmd" = "status" ]; then
  echo
  echo "=== Check Steam for available update ==="

  docker compose exec -T -e APP_ID="$APP_ID" orchestrator bash -lc '
set -euo pipefail

STEAMCMD_SH=/srv/dune/steam/steamcmd.sh
STEAMCMD_BIN=/srv/dune/steam/linux32/steamcmd
INSTALL_DIR=/srv/dune/server
APP_ID="${APP_ID:-4754530}"
APPINFO="/tmp/dune-appinfo-${APP_ID}.txt"
MANIFEST="${INSTALL_DIR}/steamapps/appmanifest_${APP_ID}.acf"

if [ -x "$STEAMCMD_SH" ]; then
  STEAMCMD="$STEAMCMD_SH"
elif [ -x "$STEAMCMD_BIN" ]; then
  STEAMCMD="$STEAMCMD_BIN"
else
  echo "SteamCMD not found or not executable: $STEAMCMD_SH"
  exit 2
fi

echo "Steam app id: $APP_ID"
echo "Install dir:  $INSTALL_DIR"

"$STEAMCMD" \
  +@sSteamCmdForcePlatformType linux \
  +login anonymous \
  +app_info_update 1 \
  +app_info_print "$APP_ID" \
  +quit > "$APPINFO" 2>&1

remote_build="$(
  awk '\''
    /"branches"/ { branches=1 }
    branches && /"public"/ { public_branch=1 }
    public_branch && /"buildid"/ {
      gsub(/"/, "", $2)
      print $2
      exit
    }
  '\'' "$APPINFO"
)"

if [ -z "$remote_build" ]; then
  remote_build="$(
    awk '\''
      /"buildid"/ {
        gsub(/"/, "", $2)
        print $2
        exit
      }
    '\'' "$APPINFO"
  )"
fi

if [ -z "$remote_build" ]; then
  echo "Could not parse remote build id from SteamCMD output."
  echo "Last SteamCMD output:"
  tail -n 80 "$APPINFO" || true
  exit 2
fi

local_build="none"
if [ -f "$MANIFEST" ]; then
  local_build="$(
    awk '\''
      /"buildid"/ {
        gsub(/"/, "", $2)
        print $2
        exit
      }
    '\'' "$MANIFEST"
  )"
  [ -n "$local_build" ] || local_build="unknown"
fi

echo "Local build:  $local_build"
echo "Remote build: $remote_build"

if [ "$local_build" != "none" ] && [ "$local_build" != "unknown" ] && [ "$local_build" = "$remote_build" ]; then
  echo "No update available."
  exit 0
fi

echo "Update available."
exit 100
'

  exit $?
fi

skip_preflight=0

if [ "$cmd" = "--yes" ] || [ "$cmd" = "-y" ]; then
  assume_yes=1
  cmd="run"
elif [ "$cmd" = "install" ] || [ "$cmd" = "bootstrap" ]; then
  assume_yes=1
  skip_preflight=1
  cmd="install"
else
  assume_yes=0
fi

if [ "$cmd" != "run" ] && [ "$cmd" != "apply" ] && [ "$cmd" != "install" ]; then
  echo "Unknown update command: $cmd"
  echo "Usage:"
  echo "  dune update"
  echo "  dune update check"
  echo "  dune update --yes"
  echo "  dune update install"
  echo "  dune update fix-steamcmd"
  echo "  dune update fix-install-dir"
  echo "  dune update auto enable"
  echo "  dune update auto disable"
  echo "  dune update auto status"
  exit 2
fi

if [ "$skip_preflight" = "1" ]; then
  echo
  echo "=== Bootstrap/install mode ==="
  echo "Skipping update availability check because init needs assets/images/db setup even if Steam is already current."
else
  echo
  echo "=== Pre-flight: check Steam for available update ==="
  set +e
  "$0" check
  check_rc=$?
  set -e

  case "$check_rc" in
    0)
      echo
      echo "No update available. Nothing changed."
      exit 0
      ;;
    100)
      echo
      echo "Update is available."
      ;;
    *)
      echo
      echo "Update check failed with exit code: $check_rc"
      exit "$check_rc"
      ;;
  esac
fi

if [ "$assume_yes" != "1" ]; then
  echo
  read -r -p "Apply update now? This will stop game servers and update files/images. [y/N] " answer
  case "$answer" in
    y|Y|yes|YES)
      ;;
    *)
      echo "Update cancelled. Nothing changed."
      exit 0
      ;;
  esac
fi

postgres_was_running=0
update_started_postgres=0
stack_was_stopped=0

if container_running dune-postgres; then
  postgres_was_running=1
fi

if [ -f "$MANUAL_STOP_FILE" ] || ! dune_stack_has_running_services; then
  stack_was_stopped=1
fi

echo
echo "=== Check Docker volume free space ==="
docker compose exec -T \
  -e DUNE_MIN_FREE_GB="${DUNE_MIN_FREE_GB:-25}" \
  -e DUNE_SKIP_DISK_CHECK="${DUNE_SKIP_DISK_CHECK:-}" \
  orchestrator dune preflight

if [ "$cmd" != "install" ]; then
  if [ "$postgres_was_running" != "1" ]; then
    echo
    echo "=== Start Postgres for update backup ==="
    runtime/scripts/start-postgres.sh
    update_started_postgres=1
  fi

  echo
  echo "=== Create pre-update database backup ==="
  DB_BACKUP_ORIGIN=pre-update runtime/scripts/db.sh backup
fi

echo
echo "=== Stop game servers before update ==="
runtime/scripts/recycle-world-game-servers.sh stop-all

echo
echo "=== Download/update server files with SteamCMD ==="

steam_attempt=1
steam_max_attempts="${DUNE_STEAMCMD_MAX_ATTEMPTS:-3}"
steam_retry_sleep="${DUNE_STEAMCMD_RETRY_SLEEP:-20}"
steam_ok=0
steam_manifest_fix_applied=0
steam_install_dir_hint=0

while [ "$steam_attempt" -le "$steam_max_attempts" ]; do
  echo
  echo "SteamCMD install attempt $steam_attempt/$steam_max_attempts..."

  steam_log="$(mktemp)"
  set +e
  docker compose exec -T -e APP_ID="$APP_ID" orchestrator dune download 2>&1 | tee "$steam_log"
  steam_rc=$?
  set -e

  if [ "$steam_rc" -eq 0 ]; then
    steam_ok=1
    rm -f "$steam_log"
    break
  fi

  echo
  if grep -Eiq "force_install_dir|install[[:space:]_-]*dir|install folder|permission denied|disk write failure|not enough disk|no space left" "$steam_log"; then
    steam_install_dir_hint=1
  fi

  if [ "$steam_manifest_fix_applied" = "0" ] && grep -Eiq "App '[^']+' state is 0x6|appmanifest_${APP_ID}\.acf|SteamCMD cache/metadata is stale" "$steam_log"; then
    echo "Detected a common SteamCMD cache error while downloading the server files."
    echo "Applying the automatic SteamCMD fix now, then retrying the update."
    fix_steamcmd_manifest
    steam_manifest_fix_applied=1
  else
    if [ "$steam_attempt" -eq 1 ]; then
      echo "SteamCMD first-run bootstrap did not complete the app install on this attempt."
      echo "This can happen while SteamCMD updates and restarts itself."
    else
      echo "SteamCMD failed with exit code $steam_rc."
    fi
  fi
  rm -f "$steam_log"

  if [ "$steam_attempt" -lt "$steam_max_attempts" ]; then
    if [ "$steam_attempt" -eq 1 ]; then
      echo "Retrying app install in ${steam_retry_sleep}s..."
    else
      echo "Retrying in ${steam_retry_sleep}s..."
    fi
    sleep "$steam_retry_sleep"
  fi

  steam_attempt=$((steam_attempt + 1))
done

if [ "$steam_ok" != "1" ]; then
  echo
  echo "SteamCMD failed after $steam_max_attempts attempts."
  if [ "$steam_install_dir_hint" = "1" ]; then
    echo
    echo "The SteamCMD output points to an install directory, permission, or disk-space problem."
    echo "The Dune server files are installed inside the orchestrator at:"
    echo "  /srv/dune/server"
    echo
    echo "Recommended repair:"
    echo "  docker exec -u root dune-orchestrator sh -lc 'chown -R dune:dune /srv/dune /home/dune'"
    echo "  docker exec dune-orchestrator df -h /srv/dune/server /srv/dune/steam /srv/dune/cache"
  fi
  echo
  echo "Most common fresh-install causes:"
  echo "  - Docker volume storage has too little free disk space."
  echo "  - Docker volumes were restored or created with the wrong owner."
  echo "  - Steam temporarily rejected the anonymous depot request."
  echo "  - SteamCMD cache/metadata is stale after a Steam-side app change."
  echo
  echo "Useful checks:"
  echo "  docker exec dune-orchestrator df -h /srv/dune/server /srv/dune/steam /srv/dune/cache"
  echo "  docker exec dune-orchestrator tail -n 80 /home/dune/Steam/logs/stderr.txt"
  echo
  echo "You can retry safely with:"
  echo "  runtime/scripts/update.sh install"
  exit 1
fi

echo
echo "=== Load updated Funcom image tarballs ==="
docker compose exec -T orchestrator bash -lc '
set -euo pipefail
find /srv/dune/server/images -type f \( -name "*.tar" -o -name "*.tar.gz" -o -name "*.tgz" \) | sort | while read -r tar; do
  echo ">>> docker load -i $tar"
  docker load -i "$tar"
done
'

echo
echo "=== Detect loaded image tags ==="
runtime/scripts/detect-image-tags.sh

echo
echo "=== Current tags ==="
cat runtime/generated/image-tags.env

echo
if [ "$cmd" = "install" ]; then
  echo "=== Start fresh Postgres for install/bootstrap ==="
  runtime/scripts/start-postgres.sh
  echo
fi

echo "=== Run database update/migration ==="
runtime/scripts/update-db.sh

if [ "$cmd" = "install" ]; then
  echo
  echo "=== Apply canonical world partitions ==="
  runtime/scripts/generate-world-partitions-sql.sh

  partition_sql="runtime/generated/reset-world-partitions.sql"

  if [ ! -s "$partition_sql" ]; then
    echo "Generated partition SQL is missing or empty: $partition_sql"
    exit 1
  fi

  partition_count="$(grep -c '^insert into dune.world_partition' "$partition_sql" || true)"

  if [ "$partition_count" -le 0 ]; then
    echo "Generated partition SQL contains no world_partition inserts."
    exit 1
  fi

  echo "Applying $partition_count world partitions..."
  docker exec -i dune-postgres psql -U dune -d dune < "$partition_sql"

  echo
  echo "=== Verify world partitions ==="
  docker exec dune-postgres psql -U dune -d dune -c "
select count(*) as world_partition_rows from world_partition;
"

  actual_count="$(docker exec dune-postgres psql -U dune -d dune -Atc "select count(*) from world_partition;" | tr -d '[:space:]')"

  if [ "${actual_count:-0}" -le 0 ]; then
    echo "world_partition is still empty after applying generated SQL."
    exit 1
  fi

  echo "World partitions ready: $actual_count rows"
fi

echo
echo "=== Refresh generated map catalogs ==="
runtime/scripts/extract-partition-catalog.sh
runtime/scripts/extract-server-catalog.sh
echo "Generated map catalogs refreshed."

echo
if [ "$cmd" = "install" ]; then
  echo "Install/bootstrap step finished."
  echo "The caller can now start the Dune stack."
elif [ "$stack_was_stopped" = "1" ]; then
  echo "Update finished."
  echo
  echo "The battlegroup was stopped before the update, so it will remain stopped."
  stop_temporary_postgres
else
  echo "Update finished."
  echo
  echo "Restarting Dune stack..."
  runtime/scripts/start-all.sh
fi
