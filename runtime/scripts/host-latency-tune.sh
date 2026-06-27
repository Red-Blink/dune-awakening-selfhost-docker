#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env
[ -r runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env

source runtime/scripts/runtime-env.sh
source runtime/scripts/image-tags.sh

WORLD_IMAGE_TAG="$(resolve_world_image_tag)"
HELPER_IMAGE="registry.funcom.com/funcom/self-hosting/seabass-server:${WORLD_IMAGE_TAG}"

run_helper() {
  local script="$1"
  docker run --rm \
    --privileged \
    --network host \
    --pid host \
    "$HELPER_IMAGE" \
    /bin/sh -lc "$script"
}

sysctl_apply() {
  local key="$1"
  local value="$2"
  local path="/proc/sys/${key//./\/}"

  if [ -w "$path" ]; then
    printf '%s' "$value" >"$path" 2>/dev/null || true
    return 0
  fi

  run_helper "if [ -w '$path' ]; then printf '%s' '$value' > '$path'; fi" >/dev/null 2>&1 || true
}

detect_default_iface() {
  ip route get 1.1.1.1 2>/dev/null | awk '
    {
      for (i = 1; i <= NF; i++) {
        if ($i == "dev") {
          print $(i + 1)
          exit
        }
      }
    }
  '
}

set_power_control_on() {
  local iface="$1"
  local path="/sys/class/net/$iface/device/power/control"

  [ -n "$iface" ] || return 0

  if [ -w "$path" ]; then
    printf '%s' on >"$path" 2>/dev/null || true
    return 0
  fi

  run_helper "if [ -w '$path' ]; then printf '%s' on > '$path'; fi" >/dev/null 2>&1 || true
}

set_cpu_governor_performance() {
  local applied=0
  local cpu gov

  for gov in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
    [ -e "$gov" ] || continue
    if [ -w "$gov" ]; then
      printf '%s' performance >"$gov" 2>/dev/null || true
      applied=1
    fi
  done

  if [ "$applied" -eq 1 ]; then
    return 0
  fi

  run_helper '
for gov in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do
  [ -e "$gov" ] || continue
  [ -w "$gov" ] || continue
  printf "%s" performance >"$gov" 2>/dev/null || true
done
' >/dev/null 2>&1 || true
}

disable_eee_if_possible() {
  local iface="$1"

  [ -n "$iface" ] || return 0

  if command -v ethtool >/dev/null 2>&1; then
    ethtool --set-eee "$iface" eee off >/dev/null 2>&1 || true
    return 0
  fi

  run_helper "if command -v ethtool >/dev/null 2>&1; then ethtool --set-eee '$iface' eee off >/dev/null 2>&1 || true; fi" >/dev/null 2>&1 || true
}

raise_tx_queue_len() {
  local iface="$1"

  [ -n "$iface" ] || return 0

  if command -v ip >/dev/null 2>&1; then
    ip link set dev "$iface" txqueuelen 10000 >/dev/null 2>&1 || true
    return 0
  fi

  run_helper "if command -v ip >/dev/null 2>&1; then ip link set dev '$iface' txqueuelen 10000 >/dev/null 2>&1 || true; fi" >/dev/null 2>&1 || true
}

main() {
  local iface

  iface="$(detect_default_iface || true)"

  sysctl_apply net.core.netdev_max_backlog 250000
  sysctl_apply net.core.somaxconn 4096
  sysctl_apply net.core.rmem_max 67108864
  sysctl_apply net.core.wmem_max 67108864
  sysctl_apply net.core.rmem_default 1048576
  sysctl_apply net.core.wmem_default 1048576
  sysctl_apply net.ipv4.udp_rmem_min 16384
  sysctl_apply net.ipv4.udp_wmem_min 16384

  set_cpu_governor_performance
  set_power_control_on "$iface"
  disable_eee_if_possible "$iface"
  raise_tx_queue_len "$iface"

  echo "Applied best-effort host latency tuning${iface:+ on $iface}."
}

main "$@"
