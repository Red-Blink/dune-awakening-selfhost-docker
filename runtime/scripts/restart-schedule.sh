#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"
HOST_ROOT_DIR="${DUNE_HOST_REPO_ROOT:-$ROOT_DIR}"

STATE_FILE="runtime/generated/restart-schedule.env"
SERVICE_NAME="dune-awakening-scheduled-restart.service"
TIMER_NAME="dune-awakening-scheduled-restart.timer"
SERVICE_FILE="/etc/systemd/system/$SERVICE_NAME"
TIMER_FILE="/etc/systemd/system/$TIMER_NAME"

usage() {
  cat <<'EOF'
Usage:
  dune restart-schedule enable <HH:MM>
  dune restart-schedule disable
  dune restart-schedule status
  dune restart-schedule run-now
EOF
}

write_state() {
  local enabled="$1"
  local time="$2"
  local timer_installed="${3:-${DUNE_SCHEDULED_RESTART_TIMER_INSTALLED:-0}}"
  local tmp

  mkdir -p runtime/generated
  tmp="${STATE_FILE}.$$"
  cat > "$tmp" <<EOF
DUNE_SCHEDULED_RESTART_ENABLED=$enabled
DUNE_SCHEDULED_RESTART_TIME=$time
DUNE_SCHEDULED_RESTART_HOURS=
DUNE_SCHEDULED_RESTART_TIMER_INSTALLED=$timer_installed
EOF
  chmod 644 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$STATE_FILE"
}

read_state() {
  DUNE_SCHEDULED_RESTART_ENABLED=0
  DUNE_SCHEDULED_RESTART_TIME=""
  DUNE_SCHEDULED_RESTART_HOURS=""
  DUNE_SCHEDULED_RESTART_TIMER_INSTALLED=""
  if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    . "$STATE_FILE"
  fi
}

require_restart_time() {
  local value="$1"
  if ! printf '%s' "$value" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]$'; then
    echo "Restart time must be HH:MM in 24-hour local server time."
    exit 2
  fi
}

can_manage_systemd_units() {
  [ -d /etc/systemd/system ] && [ -w /etc/systemd/system ]
}

write_units_to() {
  local restart_time="$1"
  local systemd_dir="$2"
  local exec_root="$3"

  mkdir -p "$systemd_dir"
  cat > "$systemd_dir/$SERVICE_NAME" <<EOF
[Unit]
Description=Dune Awakening scheduled battlegroup restart
Wants=docker.service
After=network-online.target docker.service

[Service]
Type=oneshot
WorkingDirectory=$exec_root
ExecStart=$exec_root/runtime/scripts/restart-schedule.sh run-now
EOF

  cat > "$systemd_dir/$TIMER_NAME" <<EOF
[Unit]
Description=Run Dune Awakening scheduled battlegroup restart

[Timer]
OnCalendar=*-*-* ${restart_time}:00
AccuracySec=1min
Persistent=true
Unit=dune-awakening-scheduled-restart.service

[Install]
WantedBy=timers.target
EOF
}

install_units() {
  write_units_to "$1" "/etc/systemd/system" "$HOST_ROOT_DIR"
}

docker_helper_image() {
  printf '%s' "${DUNE_SYSTEMD_HELPER_IMAGE:-arrakis-server-console:dev}"
}

can_manage_host_systemd_with_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  [ -S /var/run/docker.sock ] || return 1
  docker image inspect "$(docker_helper_image)" >/dev/null 2>&1 || return 1
}

install_units_via_docker_host() {
  local restart_time="$1"
  local image
  image="$(docker_helper_image)"

  can_manage_host_systemd_with_docker || return 1
  docker run --rm --privileged --pid=host --network=host \
    -e DUNE_SCHEDULED_RESTART_TIME="$restart_time" \
    -e DUNE_HOST_REPO_ROOT="$HOST_ROOT_DIR" \
    -v /:/host \
    --entrypoint bash \
    "$image" -lc '
      set -euo pipefail
      systemd_dir=/host/etc/systemd/system
      mkdir -p "$systemd_dir"
      cat > "$systemd_dir/dune-awakening-scheduled-restart.service" <<EOF
[Unit]
Description=Dune Awakening scheduled battlegroup restart
Wants=docker.service
After=network-online.target docker.service

[Service]
Type=oneshot
WorkingDirectory=${DUNE_HOST_REPO_ROOT}
ExecStart=${DUNE_HOST_REPO_ROOT}/runtime/scripts/restart-schedule.sh run-now
EOF
      cat > "$systemd_dir/dune-awakening-scheduled-restart.timer" <<EOF
[Unit]
Description=Run Dune Awakening scheduled battlegroup restart

[Timer]
OnCalendar=*-*-* ${DUNE_SCHEDULED_RESTART_TIME}:00
AccuracySec=1min
Persistent=true
Unit=dune-awakening-scheduled-restart.service

[Install]
WantedBy=timers.target
EOF
      chroot /host /bin/systemctl daemon-reload
      chroot /host /bin/systemctl enable --now dune-awakening-scheduled-restart.timer
    '
}

disable_units_via_docker_host() {
  local image
  image="$(docker_helper_image)"

  can_manage_host_systemd_with_docker || return 1
  docker run --rm --privileged --pid=host --network=host \
    -v /:/host \
    --entrypoint bash \
    "$image" -lc '
      set -euo pipefail
      chroot /host /bin/systemctl disable --now dune-awakening-scheduled-restart.timer >/dev/null 2>&1 || true
      chroot /host /bin/systemctl daemon-reload
    '
}

show_host_timer_status_via_docker() {
  local image
  image="$(docker_helper_image)"

  can_manage_host_systemd_with_docker || return 1
  docker run --rm --privileged --pid=host --network=host \
    -v /:/host \
    --entrypoint bash \
    "$image" -lc '
      set -euo pipefail
      if chroot /host /bin/systemctl list-unit-files dune-awakening-scheduled-restart.timer --no-legend --no-pager 2>/dev/null | grep -q "^dune-awakening-scheduled-restart.timer"; then
        timer_active="$(chroot /host /bin/systemctl is-active dune-awakening-scheduled-restart.timer 2>/dev/null || true)"
        if [ "$timer_active" = "active" ]; then
          echo "Systemd timer:           active"
        else
          echo "Systemd timer:           inactive"
        fi
        chroot /host /bin/systemctl list-timers --all dune-awakening-scheduled-restart.timer --no-pager || true
      else
        echo "Systemd timer:           not installed"
      fi
    '
}

enable_schedule() {
  local restart_time="$1"

  require_restart_time "$restart_time"

  if ! command -v systemctl >/dev/null 2>&1; then
    if install_units_via_docker_host "$restart_time"; then
      write_state 1 "$restart_time" 1
      echo "Scheduled restart enabled."
      echo "Restart time: $restart_time"
      echo "Timer: $TIMER_NAME"
      return 0
    else
      echo "Scheduled restart preference saved, but systemctl was not found and the host timer could not be installed through Docker."
      echo "Saved: $STATE_FILE"
      echo "To install the timer, run this command with sudo/root:"
      echo "  runtime/scripts/restart-schedule.sh enable $restart_time"
      return 1
    fi
  fi

  if ! can_manage_systemd_units; then
    if install_units_via_docker_host "$restart_time"; then
      write_state 1 "$restart_time" 1
      echo "Scheduled restart enabled."
      echo "Restart time: $restart_time"
      echo "Timer: $TIMER_NAME"
      return 0
    else
      echo "Scheduled restart preference saved, but this user cannot install systemd units."
      echo "Saved: $STATE_FILE"
      echo "To install the timer, run this command with sudo/root:"
      echo "  runtime/scripts/restart-schedule.sh enable $restart_time"
      return 1
    fi
  fi

  install_units "$restart_time"
  systemctl daemon-reload
  systemctl enable --now "$TIMER_NAME"
  write_state 1 "$restart_time" 1

  echo "Scheduled restart enabled."
  echo "Restart time: $restart_time"
  echo "Timer: $TIMER_NAME"
}

disable_schedule() {
  read_state
  if command -v systemctl >/dev/null 2>&1 && can_manage_systemd_units; then
    systemctl disable --now "$TIMER_NAME" >/dev/null 2>&1 || true
    systemctl daemon-reload
    write_state 0 "${DUNE_SCHEDULED_RESTART_TIME:-}" 1
  elif can_manage_host_systemd_with_docker; then
    disable_units_via_docker_host
    write_state 0 "${DUNE_SCHEDULED_RESTART_TIME:-}" 1
  elif [ "${DUNE_SCHEDULED_RESTART_TIMER_INSTALLED:-0}" != "1" ] && [ "${DUNE_SCHEDULED_RESTART_ENABLED:-0}" != "1" ]; then
    write_state 0 "${DUNE_SCHEDULED_RESTART_TIME:-}" 0
  else
    echo "Scheduled restart could not be disabled because the host timer cannot be managed from this environment."
    return 1
  fi

  echo "Scheduled restart disabled."
}

show_status() {
  read_state
  local enabled_text="false"
  local timer_installed="${DUNE_SCHEDULED_RESTART_TIMER_INSTALLED:-}"

  if [ "${DUNE_SCHEDULED_RESTART_ENABLED:-0}" = "1" ]; then
    enabled_text="true"
  fi
  if [ -z "$timer_installed" ] && [ "${DUNE_SCHEDULED_RESTART_ENABLED:-0}" = "1" ]; then
    timer_installed=1
  fi

  echo "Scheduled restart enabled: $enabled_text"
  echo "Restart time:             ${DUNE_SCHEDULED_RESTART_TIME:-unset}"
  if [ -n "${DUNE_SCHEDULED_RESTART_HOURS:-}" ]; then
    echo "Restart interval hours:   ${DUNE_SCHEDULED_RESTART_HOURS}"
  fi

  if [ "$timer_installed" = "1" ]; then
    if [ "$enabled_text" = "true" ]; then
      echo
      echo "Systemd timer:           active"
    else
      echo
      echo "Systemd timer:           inactive"
    fi
    return 0
  fi

  if command -v systemctl >/dev/null 2>&1; then
    echo
    if systemctl list-unit-files "$TIMER_NAME" --no-legend --no-pager 2>/dev/null | grep -q "^$TIMER_NAME"; then
      timer_active="$(systemctl is-active "$TIMER_NAME" 2>/dev/null || true)"
      if [ "$timer_active" = "active" ]; then
        echo "Systemd timer:           active"
      else
        echo "Systemd timer:           inactive"
      fi
      systemctl list-timers --all "$TIMER_NAME" --no-pager || true
    else
      echo "Systemd timer:           not installed"
    fi
  else
    echo
    show_host_timer_status_via_docker || echo "Systemd timer:           not installed"
  fi
}

run_now() {
  echo "=== Scheduled battlegroup restart ==="
  echo "Stopping battlegroup..."
  runtime/scripts/stop-all.sh
  echo
  echo "Starting battlegroup..."
  runtime/scripts/start-all.sh
}

cmd="${1:-status}"

case "$cmd" in
  enable|on)
    enable_schedule "${2:-}"
    ;;
  disable|off)
    disable_schedule
    ;;
  status)
    show_status
    ;;
  run-now)
    run_now
    ;;
  *)
    usage
    exit 2
    ;;
esac
