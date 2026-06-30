#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

source runtime/scripts/runtime-env.sh

fail=0
wait=0
docker_timeout_seconds="${DUNE_READY_DOCKER_TIMEOUT_SECONDS:-12}"
log_tail_lines="${DUNE_READY_LOG_TAIL_LINES:-4000}"

docker_timeout() {
  timeout --kill-after=2s "${docker_timeout_seconds}s" "$@"
}

is_running() {
  local name="$1"
  docker_timeout docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null | grep -qx true
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

container_logs_have_udp_listener() {
  local container="$1"
  local port="$2"

  [ -n "$container" ] || return 1
  is_running "$container" || return 1

  docker_timeout docker logs --tail "$log_tail_lines" "$container" 2>&1 \
    | grep -Eq "listening for (Clients|Servers) on [0-9.]+:${port}\\b"
}

check_udp() {
  local port="$1"
  local label="$2"
  local container="${3:-}"

  if ss -lnup | grep -q ":$port "; then
    mark_ok "UDP $port $label"
  elif container_logs_have_udp_listener "$container" "$port"; then
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
  docker_timeout docker logs --tail "$log_tail_lines" "$container" 2>&1 || true
}

container_partition_id() {
  local container="$1"
  if [[ "$container" =~ -([0-9]+)$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

partition_map_and_server() {
  local partition_id="$1"

  [ -n "$partition_id" ] || return 1
  docker_timeout docker exec dune-postgres psql -U dune -d dune -Atc "
    select map || '|' || coalesce(server_id, '')
    from dune.world_partition
    where partition_id = $partition_id
    limit 1;
  " 2>/dev/null || true
}

server_effective_players() {
  local server_id="$1"

  [ -n "$server_id" ] || {
    echo "0"
    return 0
  }

  docker_timeout docker exec dune-postgres psql -U dune -d dune -Atc "
    select count(*)
    from dune.player_state
    where server_id = '${server_id//\'/\'\'}'
      and (
        online_status <> 'Offline'
        or (
          reconnect_grace_period_end is not null
          and reconnect_grace_period_end > (current_timestamp at time zone 'UTC')
        )
        or (
          last_avatar_activity is not null
          and last_avatar_activity > (current_timestamp - interval '5 minutes')
        )
      );
  " 2>/dev/null | tr -d '[:space:]'
}

partition_effective_players() {
  local partition_id="$1"
  local server_id="$2"
  local safe_server_id

  safe_server_id="${server_id//\'/\'\'}"

  [ -n "$partition_id" ] || {
    echo "0"
    return 0
  }

  docker_timeout docker exec dune-postgres psql -U dune -d dune -Atc "
    select count(*)
    from dune.player_state ps
    left join dune.farm_state fs on fs.server_id = ps.server_id
    where (
      ps.server_id = '$safe_server_id'
      or (
        ps.previous_server_partition_id = $partition_id
        and (
          coalesce(ps.server_id, '') = ''
          or fs.server_id is null
          or ps.server_id <> '$safe_server_id'
        )
      )
    )
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
      );
  " 2>/dev/null | tr -d '[:space:]'
}

map_has_recent_travel_demand() {
  local map_name="$1"

  [ -n "$map_name" ] || return 1
  is_running dune-director || return 1

  docker_timeout docker logs --since 5m dune-director 2>&1 \
    | grep -Fq "Processing travel queue for ClassicalInstancing group ${map_name} "
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
  local partition_id=""
  local farm_ready=""

  if [[ "$container" =~ -([0-9]+)$ ]]; then
    partition_id="${BASH_REMATCH[1]}"
  elif [ "$container" = "dune-server-survival-1" ]; then
    partition_id="1"
  elif [ "$container" = "dune-server-overmap" ]; then
    partition_id="2"
  fi

  if [ -n "$partition_id" ] && is_running dune-postgres; then
    farm_ready="$(
      docker_timeout docker exec dune-postgres psql -U dune -d dune -Atc "
        select coalesce(fs.ready::text, 'f')
        from dune.world_partition wp
        left join dune.farm_state fs on fs.server_id = wp.server_id
        where wp.partition_id = ${partition_id}
        limit 1;
      " 2>/dev/null | tr -d '[:space:]'
    )"
    if [ "$farm_ready" = "t" ]; then
      mark_ok "$label ready"
      return
    fi
  fi

  check_log_ready \
    "$container" \
    "$pattern" \
    "$label ready" \
    "$label warming" \
    "This is normal after init/start/restart; game maps can take several minutes to finish loading."
}

game_server_rmq_connections_ready() {
  local attempt

  for attempt in 1 2; do
    if timeout 7 docker exec dune-rmq-game rabbitmqctl list_connections user state 2>/dev/null \
      | awk '$1 ~ /^sg[.]/ && $2 == "running" { found=1 } END { exit(found ? 0 : 1) }'; then
      return 0
    fi

    if [ "$attempt" -lt 2 ]; then
      sleep 1
    fi
  done

  return 1
}

director_fls_ready() {
  local logs

  if ! is_running dune-director; then
    return 1
  fi

  logs="$(docker_timeout docker logs --tail 3000 dune-director 2>&1 || true)"

  if grep -q 'Battlegroups_SendBattlegroupHeartbeat.*Request successful' <<< "$logs"; then
    return 0
  fi

  if grep -Eq 'Population declaration: .*"IsLocked":false' <<< "$logs"; then
    return 0
  fi

  if grep -q 'RMQ connection successful.*Initiating heartbeat' <<< "$logs"; then
    return 0
  fi

  return 1
}

partition_mismatch_hint_needed() {
  local logs

  logs="$(
    {
      docker_timeout docker logs --since 10m dune-server-survival-1 2>&1 || true
      docker_timeout docker logs --since 10m dune-server-overmap 2>&1 || true
    }
  )"

  grep -Eq 'Invalid PartitionId|has no partition definition|thinks farm size is|waiting for persistence to finish initial load' <<< "$logs"
}

heal_core_readiness_if_possible() {
  is_running dune-postgres || return 0

  if ! is_running dune-server-survival-1 && ! is_running dune-server-overmap; then
    return 0
  fi

  bash runtime/scripts/heal-core-ready.sh all >/dev/null 2>&1 || true
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
check_tcp 31983 "RabbitMQ game HTTP local" "dune-rmq-game"
check_tcp 5059  "TextRouter localhost" "dune-text-router"
check_tcp 11717 "Director localhost" "dune-director"

client_port_base="$(resolve_client_port_base)"
igw_port_base="$(resolve_igw_port_base)"
check_udp "$client_port_base" "Overmap clients" "dune-server-overmap"
check_udp "$((client_port_base + 1))" "Survival_1 clients" "dune-server-survival-1"
check_udp "$igw_port_base" "Survival_1 S2S" "dune-server-survival-1"
check_udp "$((igw_port_base + 1))" "Overmap S2S" "dune-server-overmap"

echo
echo "=== Database world partition checks ==="
if is_running dune-postgres; then
  partition_count="$(docker_timeout docker exec dune-postgres psql -U dune -d dune -Atc "select count(*) from world_partition;" 2>/dev/null | tr -d '[:space:]' || true)"
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

heal_core_readiness_if_possible

echo
echo "=== Readiness log checks ==="
check_game_server_ready dune-server-survival-1 "Survival_1" "Server farm is READY .*partition 1"
check_game_server_ready dune-server-overmap "Overmap" "Server farm is READY .*partition 2"

if director_fls_ready; then
  mark_ok "Director FLS population"
elif is_running dune-director; then
  mark_wait "Director FLS heartbeat pending"
  echo "     Director is running, but FLS population/heartbeat confirmation has not appeared yet."
else
  mark_fail "Director FLS heartbeat"
fi

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
  partition_id="$(container_partition_id "$c")"
  partition_row="$(partition_map_and_server "$partition_id")"
  map_name=""
  server_id=""
  if [ -n "$partition_row" ]; then
    IFS='|' read -r map_name server_id <<< "$partition_row"
  fi

  if [ "$map_name" = "Survival_1" ]; then
    check_game_server_ready "$c" "$c"
    continue
  fi

  farm_ready="f"
  if [ -n "$server_id" ]; then
    farm_ready="$(docker_timeout docker exec dune-postgres psql -U dune -d dune -Atc "
      select coalesce(ready::text, 'f')
      from dune.farm_state
      where server_id = '${server_id//\'/\'\'}'
      limit 1;
    " 2>/dev/null | tr -d '[:space:]')"
    farm_ready="${farm_ready:-f}"
  fi

  if [ "$farm_ready" = "t" ]; then
    check_game_server_ready "$c" "$c"
    continue
  fi

  connected_players="0"
  if [ -n "$server_id" ]; then
    connected_players="$(docker_timeout docker exec dune-postgres psql -U dune -d dune -Atc "
      select coalesce(connected_players::text, '0')
      from dune.farm_state
      where server_id = '${server_id//\'/\'\'}'
      limit 1;
    " 2>/dev/null | tr -d '[:space:]')"
    connected_players="${connected_players:-0}"
  fi

  effective_players="$(partition_effective_players "$partition_id" "$server_id")"
  effective_players="${effective_players:-0}"

  if [ "$connected_players" = "0" ] && [ "$effective_players" = "0" ] && ! map_has_recent_travel_demand "$map_name"; then
    mark_ok "$c idle"
    continue
  fi

  check_game_server_ready "$c" "$c"
done < <(docker_timeout docker ps --format '{{.Names}}' | grep '^dune-server-' || true)

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
  if partition_mismatch_hint_needed; then
    echo "Possible runtime partition mismatch detected."
    echo "If maps stay WARMING after an update, open Dune Docker Console and use Updates repair actions."
    echo
  fi
  echo "After READY, population and sietch availability may still take a few minutes"
  echo "to appear in the in-game server browser."
  exit 2
else
  echo "NOT READY: one or more required checks failed."
  exit 1
fi
