#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

fail=0

check_container() {
  local name="$1"
  if docker ps --format '{{.Names}}' | grep -qx "$name"; then
    echo "OK   container $name"
  else
    echo "FAIL container $name"
    fail=1
  fi
}

check_udp() {
  local port="$1"
  local label="$2"
  if ss -lnup | grep -q ":$port "; then
    echo "OK   UDP $port $label"
  else
    echo "FAIL UDP $port $label"
    fail=1
  fi
}

check_tcp() {
  local port="$1"
  local label="$2"
  if ss -lntp | grep -q ":$port "; then
    echo "OK   TCP $port $label"
  else
    echo "FAIL TCP $port $label"
    fail=1
  fi
}

check_log() {
  local container="$1"
  local pattern="$2"
  local label="$3"
  local logs

  # Avoid pipefail/SIGPIPE false negatives when grep -q exits early.
  logs="$(docker logs "$container" 2>&1 || true)"

  if grep -Eq "$pattern" <<< "$logs"; then
    echo "OK   $label"
  else
    echo "FAIL $label"
    fail=1
  fi
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
check_tcp 15432 "Postgres localhost"
check_tcp 32573 "RabbitMQ admin localhost"
check_tcp 31982 "RabbitMQ game public"
check_tcp 5059  "TextRouter localhost"
check_tcp 11717 "Director localhost"

check_udp 7777 "Overmap clients"
check_udp 7778 "Survival_1 clients"
check_udp 7888 "Survival_1 S2S"
check_udp 7889 "Overmap S2S"

echo
echo "=== Readiness log checks ==="
check_log dune-server-survival-1 "Server farm is READY .*partition 1" "Survival_1 ready"
check_log dune-server-overmap "Server farm is READY .*partition 2" "Overmap ready"
check_log dune-director "Battlegroups_SendBattlegroupHeartbeat.*Request successful" "Director FLS heartbeat"
check_log dune-server-gateway "Monitoring for servers going up or down" "Gateway monitoring DB"

echo
echo "=== RabbitMQ game users ==="
if docker exec dune-rmq-game rabbitmqctl list_connections user state 2>/dev/null | grep -q '^sg\..*running'; then
  echo "OK   game server sg.* RMQ connections"
else
  echo "FAIL game server sg.* RMQ connections"
  fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "READY: Dune Awakening Self-Host Docker stack looks healthy."
else
  echo "NOT READY: one or more checks failed."
fi

exit "$fail"
