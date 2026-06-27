#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"
HOST_ROOT_DIR="${DUNE_HOST_REPO_ROOT:-$ROOT_DIR}"

# shellcheck source=runtime/scripts/runtime-env.sh
. runtime/scripts/runtime-env.sh

STATE_FILE="runtime/generated/ip-change-restart.env"
SERVICE_NAME="dune-awakening-ip-change-restart.service"
TIMER_NAME="dune-awakening-ip-change-restart.timer"

usage() {
  cat <<'EOF'
Usage:
  dune ip-change-restart enable [interval-minutes] [notify-minutes]
  dune ip-change-restart disable
  dune ip-change-restart status
  dune ip-change-restart check-now
EOF
}

set_env_value() {
  local key="$1"
  local value="$2"
  set_env_file_value ".env" "$key" "$value" "644"
}

set_env_file_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  local mode="${4:-644}"
  local tmp

  if [ -e "$file" ] && [ ! -w "$file" ]; then
    echo "Cannot update $file because it is not writable by $(id -un)." >&2
    echo "Repair ownership from the repo root, then retry:" >&2
    echo "  sudo chown -R \"\$USER:\$USER\" .env runtime/generated runtime/secrets runtime/backups 2>/dev/null || true" >&2
    echo "  chmod -R u+rwX .env runtime/generated runtime/secrets runtime/backups 2>/dev/null || true" >&2
    return 13
  fi

  touch "$file"
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
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
  chmod "$mode" "$file" 2>/dev/null || true
}

now_stamp() {
  date '+%s'
}

format_timestamp() {
  local value="${1:-}"
  if [ -z "$value" ] || [ "$value" = "unset" ]; then
    printf '%s' "Unavailable"
    return 0
  fi

  if printf '%s' "$value" | grep -Eq '^[0-9]+$'; then
    date -d "@$value" '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null || printf '%s' "$value"
    return 0
  fi

  date -d "$value" '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null || printf '%s' "$value"
}

require_minutes() {
  local value="$1"
  local label="$2"
  local min="$3"
  local max="$4"
  if ! printf '%s' "$value" | grep -Eq '^[0-9]+$' || [ "$value" -lt "$min" ] || [ "$value" -gt "$max" ]; then
    echo "$label must be between $min and $max minutes." >&2
    exit 2
  fi
}

write_state() {
  local enabled="$1"
  local interval_minutes="$2"
  local notify_minutes="$3"
  local last_ip="$4"
  local last_check="$5"
  local last_restart="$6"
  local timer_installed="${7:-${DUNE_IP_CHANGE_RESTART_TIMER_INSTALLED:-0}}"
  local tmp

  mkdir -p runtime/generated
  tmp="${STATE_FILE}.$$"
  cat > "$tmp" <<EOF
DUNE_IP_CHANGE_RESTART_ENABLED=$enabled
DUNE_IP_CHANGE_RESTART_INTERVAL_MINUTES=$interval_minutes
DUNE_IP_CHANGE_RESTART_NOTIFY_MINUTES=$notify_minutes
DUNE_IP_CHANGE_RESTART_LAST_IP=$last_ip
DUNE_IP_CHANGE_RESTART_LAST_CHECK=$last_check
DUNE_IP_CHANGE_RESTART_LAST_RESTART=$last_restart
DUNE_IP_CHANGE_RESTART_TIMER_INSTALLED=$timer_installed
EOF
  chmod 644 "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$STATE_FILE"
}

read_state() {
  DUNE_IP_CHANGE_RESTART_ENABLED=0
  DUNE_IP_CHANGE_RESTART_INTERVAL_MINUTES=5
  DUNE_IP_CHANGE_RESTART_NOTIFY_MINUTES=1
  DUNE_IP_CHANGE_RESTART_LAST_IP=""
  DUNE_IP_CHANGE_RESTART_LAST_CHECK=""
  DUNE_IP_CHANGE_RESTART_LAST_RESTART=""
  DUNE_IP_CHANGE_RESTART_TIMER_INSTALLED=""
  if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090
    . "$STATE_FILE"
  fi
}

docker_helper_image() {
  printf '%s' "${DUNE_SYSTEMD_HELPER_IMAGE:-redblink-dune-docker-console:dev}"
}

can_manage_systemd_units() {
  [ -d /etc/systemd/system ] && [ -w /etc/systemd/system ]
}

can_manage_host_systemd_with_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  [ -S /var/run/docker.sock ] || return 1
  docker image inspect "$(docker_helper_image)" >/dev/null 2>&1 || return 1
}

write_units_to() {
  local interval_minutes="$1"
  local systemd_dir="$2"
  local exec_root="$3"

  mkdir -p "$systemd_dir"
  cat > "$systemd_dir/$SERVICE_NAME" <<EOF
[Unit]
Description=Dune Awakening public IP change restart monitor
Wants=docker.service
After=network-online.target docker.service

[Service]
Type=oneshot
WorkingDirectory=$exec_root
ExecStart=$exec_root/runtime/scripts/ip-change-restart.sh check-now
EOF

  cat > "$systemd_dir/$TIMER_NAME" <<EOF
[Unit]
Description=Check Dune Awakening public IP for changes

[Timer]
OnActiveSec=30s
OnBootSec=2min
OnUnitActiveSec=${interval_minutes}min
AccuracySec=30s
Persistent=true
Unit=$SERVICE_NAME

[Install]
WantedBy=timers.target
EOF
}

install_units_via_docker_host() {
  local interval_minutes="$1"
  local image
  image="$(docker_helper_image)"

  can_manage_host_systemd_with_docker || return 1
  docker run --rm --privileged --pid=host --network=host \
    -e DUNE_IP_CHANGE_RESTART_INTERVAL_MINUTES="$interval_minutes" \
    -e DUNE_HOST_REPO_ROOT="$HOST_ROOT_DIR" \
    -v /:/host \
    --entrypoint bash \
    "$image" -lc '
      set -euo pipefail
      systemd_dir=/host/etc/systemd/system
      mkdir -p "$systemd_dir"
      cat > "$systemd_dir/dune-awakening-ip-change-restart.service" <<EOF
[Unit]
Description=Dune Awakening public IP change restart monitor
Wants=docker.service
After=network-online.target docker.service

[Service]
Type=oneshot
WorkingDirectory=${DUNE_HOST_REPO_ROOT}
ExecStart=${DUNE_HOST_REPO_ROOT}/runtime/scripts/ip-change-restart.sh check-now
EOF
      cat > "$systemd_dir/dune-awakening-ip-change-restart.timer" <<EOF
[Unit]
Description=Check Dune Awakening public IP for changes

[Timer]
OnActiveSec=30s
OnBootSec=2min
OnUnitActiveSec=${DUNE_IP_CHANGE_RESTART_INTERVAL_MINUTES}min
AccuracySec=30s
Persistent=true
Unit=dune-awakening-ip-change-restart.service

[Install]
WantedBy=timers.target
EOF
      chroot /host /bin/systemctl daemon-reload
      chroot /host /bin/systemctl enable dune-awakening-ip-change-restart.timer
      chroot /host /bin/systemctl restart dune-awakening-ip-change-restart.timer
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
      chroot /host /bin/systemctl disable --now dune-awakening-ip-change-restart.timer >/dev/null 2>&1 || true
      chroot /host /bin/systemctl daemon-reload
    '
}

timer_status() {
  if command -v systemctl >/dev/null 2>&1; then
    if systemctl list-unit-files "$TIMER_NAME" --no-legend --no-pager 2>/dev/null | grep -q "^$TIMER_NAME"; then
      systemctl is-active "$TIMER_NAME" 2>/dev/null || true
      return 0
    fi
    if systemctl status "$TIMER_NAME" --no-pager >/dev/null 2>&1; then
      systemctl is-active "$TIMER_NAME" 2>/dev/null || true
      return 0
    fi
  fi
  echo "not installed"
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
      if chroot /host /bin/systemctl list-unit-files dune-awakening-ip-change-restart.timer --no-legend --no-pager 2>/dev/null | grep -q "^dune-awakening-ip-change-restart.timer"; then
        chroot /host /bin/systemctl is-active dune-awakening-ip-change-restart.timer 2>/dev/null || true
      else
        echo "not installed"
      fi
    '
}

baseline_ip() {
  first_known_value \
    "$(config_value .env SERVER_IP 2>/dev/null || true)" \
    "$(config_value runtime/generated/battlegroup.env SERVER_IP 2>/dev/null || true)" \
    "${DUNE_IP_CHANGE_RESTART_LAST_IP:-}" \
    || true
}

restart_stack_after_ip_change() {
  local old_ip="$1"
  local new_ip="$2"
  local notify_minutes="$3"

  set_env_value SERVER_IP "$new_ip"
  set_env_value SERVER_IP_MODE "public"
  if [ -f runtime/generated/battlegroup.env ]; then
    set_env_file_value runtime/generated/battlegroup.env SERVER_IP "$new_ip" "664"
    set_env_file_value runtime/generated/battlegroup.env SERVER_IP_MODE "public" "664"
  fi
  echo "Updated SERVER_IP from ${old_ip:-unknown} to $new_ip."

  if [ "$notify_minutes" -gt 0 ]; then
    echo "Publishing best-effort in-game restart warning..."
    runtime/scripts/dune admin broadcast-restart-warning "$notify_minutes" || true
  fi

  echo "Restarting battlegroup to advertise the new public IP..."
  runtime/scripts/stop-all.sh
  runtime/scripts/start-all.sh
}

check_now() {
  read_state
  local mode current previous checked_at restarted_at notify_minutes interval_minutes
  interval_minutes="${DUNE_IP_CHANGE_RESTART_INTERVAL_MINUTES:-5}"
  notify_minutes="${DUNE_IP_CHANGE_RESTART_NOTIFY_MINUTES:-1}"
  checked_at="$(now_stamp)"

  mode="$(resolve_server_ip_mode 2>/dev/null || true)"
  if [ "$mode" != "public" ]; then
    echo "Public IP change restart skipped: SERVER_IP_MODE is ${mode:-unknown}, not public."
    write_state "${DUNE_IP_CHANGE_RESTART_ENABLED:-0}" "$interval_minutes" "$notify_minutes" "${DUNE_IP_CHANGE_RESTART_LAST_IP:-}" "$checked_at" "${DUNE_IP_CHANGE_RESTART_LAST_RESTART:-}" "${DUNE_IP_CHANGE_RESTART_TIMER_INSTALLED:-0}"
    return 0
  fi

  current="$(detect_public_ip 2>/dev/null || true)"
  if ! is_ipv4 "$current"; then
    echo "Public IP change restart check failed: could not detect current public IPv4." >&2
    write_state "${DUNE_IP_CHANGE_RESTART_ENABLED:-0}" "$interval_minutes" "$notify_minutes" "${DUNE_IP_CHANGE_RESTART_LAST_IP:-}" "$checked_at" "${DUNE_IP_CHANGE_RESTART_LAST_RESTART:-}" "${DUNE_IP_CHANGE_RESTART_TIMER_INSTALLED:-0}"
    return 1
  fi

  previous="$(baseline_ip)"
  if [ -z "$previous" ] || [ "$previous" = "auto" ] || ! is_ipv4 "$previous"; then
    write_state "${DUNE_IP_CHANGE_RESTART_ENABLED:-0}" "$interval_minutes" "$notify_minutes" "$current" "$checked_at" "${DUNE_IP_CHANGE_RESTART_LAST_RESTART:-}" "${DUNE_IP_CHANGE_RESTART_TIMER_INSTALLED:-0}"
    echo "Public IP baseline initialized: $current"
    return 0
  fi

  if [ "$current" = "$previous" ]; then
    if [ "$(config_value .env SERVER_IP 2>/dev/null || true)" = "$current" ] && [ -f runtime/generated/battlegroup.env ]; then
      set_env_file_value runtime/generated/battlegroup.env SERVER_IP "$current" "664"
      set_env_file_value runtime/generated/battlegroup.env SERVER_IP_MODE "public" "664"
    fi
    write_state "${DUNE_IP_CHANGE_RESTART_ENABLED:-0}" "$interval_minutes" "$notify_minutes" "$current" "$checked_at" "${DUNE_IP_CHANGE_RESTART_LAST_RESTART:-}" "${DUNE_IP_CHANGE_RESTART_TIMER_INSTALLED:-0}"
    echo "Public IP unchanged: $current"
    return 0
  fi

  echo "Public IP changed: $previous -> $current"
  restarted_at="$(now_stamp)"
  write_state "${DUNE_IP_CHANGE_RESTART_ENABLED:-0}" "$interval_minutes" "$notify_minutes" "$current" "$checked_at" "$restarted_at" "${DUNE_IP_CHANGE_RESTART_TIMER_INSTALLED:-0}"
  restart_stack_after_ip_change "$previous" "$current" "$notify_minutes"
}

enable_monitor() {
  local interval_minutes="${1:-5}"
  local notify_minutes="${2:-1}"
  local current baseline
  require_minutes "$interval_minutes" "Check interval" 1 1440
  require_minutes "$notify_minutes" "Notification time" 0 60

  current="$(detect_public_ip 2>/dev/null || true)"
  if ! is_ipv4 "$current"; then
    echo "Could not detect the current public IPv4. The monitor was not enabled." >&2
    return 1
  fi
  read_state
  baseline="$(baseline_ip)"
  if [ -z "$baseline" ] || [ "$baseline" = "auto" ] || ! is_ipv4 "$baseline"; then
    baseline="$current"
  fi

  if command -v systemctl >/dev/null 2>&1 && can_manage_systemd_units; then
    write_units_to "$interval_minutes" "/etc/systemd/system" "$HOST_ROOT_DIR"
    systemctl daemon-reload
    systemctl enable "$TIMER_NAME"
    systemctl restart "$TIMER_NAME"
    write_state 1 "$interval_minutes" "$notify_minutes" "$baseline" "$(now_stamp)" "${DUNE_IP_CHANGE_RESTART_LAST_RESTART:-}" 1
  elif install_units_via_docker_host "$interval_minutes"; then
    write_state 1 "$interval_minutes" "$notify_minutes" "$baseline" "$(now_stamp)" "${DUNE_IP_CHANGE_RESTART_LAST_RESTART:-}" 1
  else
    write_state 1 "$interval_minutes" "$notify_minutes" "$baseline" "$(now_stamp)" "${DUNE_IP_CHANGE_RESTART_LAST_RESTART:-}" 0
    echo "Public IP change restart preference saved, but the host timer could not be installed."
    echo "Run this command with sudo/root to install it:"
    echo "  runtime/scripts/ip-change-restart.sh enable $interval_minutes $notify_minutes"
    return 1
  fi

  echo "Public IP change restart enabled."
  echo "Check interval:          $interval_minutes minutes"
  echo "In-game notice:          $notify_minutes minutes"
  echo "Current public IP:       $current"
  echo "Advertised public IP:    $baseline"
  echo "Timer:                   $TIMER_NAME"
}

disable_monitor() {
  read_state
  if command -v systemctl >/dev/null 2>&1 && can_manage_systemd_units; then
    systemctl disable --now "$TIMER_NAME" >/dev/null 2>&1 || true
    systemctl daemon-reload
    write_state 0 "${DUNE_IP_CHANGE_RESTART_INTERVAL_MINUTES:-5}" "${DUNE_IP_CHANGE_RESTART_NOTIFY_MINUTES:-1}" "${DUNE_IP_CHANGE_RESTART_LAST_IP:-}" "${DUNE_IP_CHANGE_RESTART_LAST_CHECK:-}" "${DUNE_IP_CHANGE_RESTART_LAST_RESTART:-}" 1
  elif can_manage_host_systemd_with_docker; then
    disable_units_via_docker_host
    write_state 0 "${DUNE_IP_CHANGE_RESTART_INTERVAL_MINUTES:-5}" "${DUNE_IP_CHANGE_RESTART_NOTIFY_MINUTES:-1}" "${DUNE_IP_CHANGE_RESTART_LAST_IP:-}" "${DUNE_IP_CHANGE_RESTART_LAST_CHECK:-}" "${DUNE_IP_CHANGE_RESTART_LAST_RESTART:-}" 1
  else
    write_state 0 "${DUNE_IP_CHANGE_RESTART_INTERVAL_MINUTES:-5}" "${DUNE_IP_CHANGE_RESTART_NOTIFY_MINUTES:-1}" "${DUNE_IP_CHANGE_RESTART_LAST_IP:-}" "${DUNE_IP_CHANGE_RESTART_LAST_CHECK:-}" "${DUNE_IP_CHANGE_RESTART_LAST_RESTART:-}" 0
  fi

  echo "Public IP change restart disabled."
}

show_status() {
  read_state
  local enabled_text="false"
  local timer
  [ "${DUNE_IP_CHANGE_RESTART_ENABLED:-0}" = "1" ] && enabled_text="true"
  timer="$(timer_status)"
  if [ "$timer" = "not installed" ]; then
    timer="$(show_host_timer_status_via_docker 2>/dev/null || echo "not installed")"
  fi

  echo "Public IP change restart enabled: $enabled_text"
  echo "Check interval:                   ${DUNE_IP_CHANGE_RESTART_INTERVAL_MINUTES:-5} minutes"
  echo "In-game notice:                   ${DUNE_IP_CHANGE_RESTART_NOTIFY_MINUTES:-1} minutes"
  echo "Last known public IP:             ${DUNE_IP_CHANGE_RESTART_LAST_IP:-Unavailable}"
  echo "Last check:                       $(format_timestamp "${DUNE_IP_CHANGE_RESTART_LAST_CHECK:-}")"
  echo "Last restart:                     $(format_timestamp "${DUNE_IP_CHANGE_RESTART_LAST_RESTART:-}")"
  echo "Systemd timer:                    $timer"
}

cmd="${1:-status}"
case "$cmd" in
  enable|on)
    read_state
    enable_monitor "${2:-${DUNE_IP_CHANGE_RESTART_INTERVAL_MINUTES:-5}}" "${3:-${DUNE_IP_CHANGE_RESTART_NOTIFY_MINUTES:-1}}"
    ;;
  disable|off)
    disable_monitor
    ;;
  status)
    show_status
    ;;
  check-now)
    check_now
    ;;
  *)
    usage
    exit 2
    ;;
esac
