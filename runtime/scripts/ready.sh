#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

fail=0
wait=0

is_running() {
  local name="$1"
  docker ps --format '{{.Names}}' | grep -qx "$name"
}

mark_ok() {
  echo "OK   $*"
}

mark_wait() {
  echo "WAIT $*"
  wait=1
}

mark_fail() {
  echo "FAIL $*"
  fail=1
}

check_container() {
  local name="$1"

  if is_running "$name"; then
    mark_ok "container $name"
  else
    mark_fail "container $name"
  fi
}

check_tcp() {
  local port="$1"
  local label="$2"
  local container="${3:-}"

  if ss -lntp | grep -q ":$port "; then
    mark_ok "TCP $port $label"
  elif [ -n "$container" ] && is_running "$container"; then
    mark_wait "TCP $port $label"
    echo "     $container is running, but the listener is not open yet."
  else
    mark_fail "TCP $port $label"
  fi
}

check_udp() {
  local port="$1"
  local label="$2"
  local container="${3:-}"

  if ss -lnup | grep -q ":$port "; then
    mark_ok "UDP $port $label"
  elif [ -n "$container" ] && is_running "$container"; then
    mark_wait "UDP $port $label"
    echo "     $container is running, but the game port is not open yet."
  else
    mark_fail "UDP $port $label"
  fi
}

container_logs() {
  local container="$1"
  docker logs "$container" 2>&1 || true
}

logs_have_fatal() {
  local logs="$1"

  grep -Eiq \
    'fatal error|segmentation fault|sigsegv|assertion failed|unhandled exception|core dumped|panic:' \
    <<< "$logs"
}

logs_have_illegal_instruction() {
  local logs="$1"
  grep -Eiq 'illegal instruction' <<< "$logs"
}

cpu_has_flag() {
  local flag="$1"
  grep -Eq "(^| )${flag}( |$)" /proc/cpuinfo 2>/dev/null
}

check_log_ready() {
  local container="$1"
  local pattern="$2"
  local ok_label="$3"
  local wait_label="$4"
  local hint="$5"
  local logs

  if ! is_running "$container"; then
    mark_fail "$ok_label"
    echo "     $container is not running."
    return
  fi

  logs="$(container_logs "$container")"

  if grep -Eq "$pattern" <<< "$logs"; then
    mark_ok "$ok_label"
  elif logs_have_fatal "$logs"; then
    mark_fail "$ok_label"
    echo "     $container logged a fatal-looking startup error."
    if logs_have_illegal_instruction "$logs"; then
      if ! cpu_has_flag avx || ! cpu_has_flag avx2; then
        echo "     The host CPU exposed to this machine is missing AVX/AVX2."
        echo "     Dune dedicated servers require those CPU features and can crash immediately without them."
        echo "     If this is a VM, enable host CPU passthrough or expose AVX and AVX2 to the guest."
      else
        echo "     The game binary hit an illegal CPU instruction during startup."
      fi
    fi
  else
    mark_wait "$wait_label"
    echo "     $hint"
  fi
}

check_game_server_ready() {
  local container="$1"
  local label="$2"
  local pattern="${3:-Server farm is READY}"

  check_log_ready \
    "$container" \
    "$pattern" \
    "$label ready" \
    "$label warming" \
    "This is normal after init/start/restart; game maps can take several minutes to finish loading."
}

game_server_rmq_connections_ready() {
  local attempt

  for attempt in 1 2 3; do
    if docker exec dune-rmq-game rabbitmqctl list_connections user state 2>/dev/null | grep -q '^sg\..*running'; then
      return 0
    fi

    if [ "$attempt" -lt 3 ]; then
      sleep 2
    fi
  done

  return 1
}

echo "=== Container checks ==="
for c in \
  dune-postgres \
  dune-rmq-admin \
  dune-rmq-game \
  dune-text-router \
  dune-director \
  dune-server-gateway \
  dune-server-survival-1 \
  dune-server-overmap
do
  check_container "$c"
done

echo
echo "=== Listener checks ==="
check_tcp 15432 "Postgres localhost" "dune-postgres"
check_tcp 32573 "RabbitMQ admin localhost" "dune-rmq-admin"
check_tcp 31982 "RabbitMQ game public" "dune-rmq-game"
check_tcp 5059  "TextRouter localhost" "dune-text-router"
check_tcp 11717 "Director localhost" "dune-director"

check_udp 7777 "Overmap clients" "dune-server-overmap"
check_udp 7778 "Survival_1 clients" "dune-server-survival-1"
check_udp 7888 "Survival_1 S2S" "dune-server-survival-1"
check_udp 7889 "Overmap S2S" "dune-server-overmap"

echo
echo "=== Database world partition checks ==="
if is_running dune-postgres; then
  partition_count="$(docker exec dune-postgres psql -U dune -d dune -Atc "select count(*) from world_partition;" 2>/dev/null | tr -d '[:space:]' || true)"
  partition_count="${partition_count:-0}"

  if [ "$partition_count" -gt 0 ]; then
    mark_ok "world_partition rows: $partition_count"
  else
    mark_fail "world_partition rows: 0"
    echo "     Fresh init needs canonical world partitions. Run:"
    echo "       runtime/scripts/generate-world-partitions-sql.sh"
    echo "       docker exec -i dune-postgres psql -U dune -d dune < runtime/generated/reset-world-partitions.sql"
  fi
else
  mark_fail "world_partition check"
  echo "     dune-postgres is not running."
fi

echo
echo "=== Readiness log checks ==="
check_game_server_ready dune-server-survival-1 "Survival_1" "Server farm is READY .*partition 1"
check_game_server_ready dune-server-overmap "Overmap" "Server farm is READY .*partition 2"

check_log_ready \
  dune-director \
  "Battlegroups_SendBattlegroupHeartbeat.*Request successful" \
  "Director FLS heartbeat" \
  "Director FLS heartbeat pending" \
  "Director is running, but the FLS heartbeat has not appeared yet."

check_log_ready \
  dune-server-gateway \
  "Monitoring for servers going up or down" \
  "Gateway monitoring DB" \
  "Gateway DB monitoring pending" \
  "Gateway is running, but DB monitoring has not appeared yet."

echo
echo "=== Dynamic game map checks ==="
dynamic_found=0
while IFS= read -r c; do
  [ -n "$c" ] || continue

  case "$c" in
    dune-server-gateway|dune-server-survival-1|dune-server-overmap)
      continue
      ;;
  esac

  dynamic_found=1
  check_game_server_ready "$c" "$c"
done < <(docker ps --format '{{.Names}}' | grep '^dune-server-' || true)

if [ "$dynamic_found" -eq 0 ]; then
  echo "OK   no dynamic game maps currently running"
fi

echo
echo "=== RabbitMQ game users ==="
if game_server_rmq_connections_ready; then
  mark_ok "game server sg.* RMQ connections"
elif is_running dune-server-survival-1 || is_running dune-server-overmap; then
  mark_wait "game server sg.* RMQ connections"
  echo "     Game server containers are running, but RMQ game connections are still warming."
else
  mark_fail "game server sg.* RMQ connections"
fi

echo
if [ "$fail" -eq 0 ] && [ "$wait" -eq 0 ]; then
  echo "READY: Dune Awakening Self-Host Docker stack looks healthy."
  echo
  echo "Note: after local READY, the in-game server browser may still take a few minutes"
  echo "to show population and sietch availability while Funcom/FLS and the client refresh."
  exit 0
elif [ "$fail" -eq 0 ]; then
  echo "WARMING: required containers are up; one or more services/maps are still starting."
  echo "Run again in a few minutes:"
  echo "  dune ready"
  echo
  echo "After READY, population and sietch availability may still take a few minutes"
  echo "to appear in the in-game server browser."
  exit 2
else
  echo "NOT READY: one or more required checks failed."
  exit 1
fi
