#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

set -a
[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env
set +a
source runtime/scripts/runtime-env.sh
source runtime/scripts/fls-signals.sh

issue=0
warming=0
rmq_game_connections_cache="__unset__"
udp_check_retries="${DUNE_STATUS_UDP_CHECK_RETRIES:-3}"
udp_check_retry_sleep="${DUNE_STATUS_UDP_CHECK_RETRY_SLEEP:-0.25}"

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

value_is_known() {
  local value="${1:-}"
  [ -n "$value" ] && [ "$value" != "unknown" ]
}

is_running() {
  local name="$1"
  [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null || true)" = "true" ]
}

is_private_ipv4() {
  local ip="$1"
  printf '%s' "$ip" | grep -Eq '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)'
}

container_status() {
  local name="$1"
  if is_running "$name"; then
    docker ps --filter "name=^${name}$" --format '{{.Status}}'
  elif docker inspect "$name" >/dev/null 2>&1; then
    echo "stopped"
    issue=1
  else
    echo "missing"
    issue=1
  fi
}

check_tcp() {
  local port="$1"
  local sockets
  sockets="$(ss -lntp 2>/dev/null || true)"
  if grep -q ":$port " <<<"$sockets"; then
    echo "OK"
  else
    issue=1
    echo "MISSING"
  fi
}

container_logs_have_udp_listener() {
  local container="$1"
  local port="$2"

  [ -n "$container" ] || return 1
  is_running "$container" || return 1

  docker logs --tail 4000 "$container" 2>&1 \
    | grep -Eq "listening for (Clients|Servers) on [0-9.]+:${port}\\b"
}

udp_socket_listening() {
  local port="$1"
  local sockets
  sockets="$(ss -lnup 2>/dev/null || true)"
  grep -q ":$port " <<<"$sockets"
}

check_udp() {
  local port="$1"
  local container="${2:-}"
  local attempt

  for ((attempt = 1; attempt <= udp_check_retries; attempt++)); do
    if udp_socket_listening "$port"; then
      echo "OK"
      return
    fi
    [ "$attempt" -lt "$udp_check_retries" ] && sleep "$udp_check_retry_sleep"
  done

  if container_logs_have_udp_listener "$container" "$port"; then
    echo "OK"
    return
  fi

  issue=1
  echo "MISSING"
}

dynamic_listener_rows() {
  local containers container partition_id row map_name game_port igw_port fallback

  containers="$(docker ps --filter 'name=^dune-server-' --format '{{.Names}}' 2>/dev/null \
    | grep -Ev '^dune-server-(gateway|survival-1|overmap)$' || true)"
  [ -n "$containers" ] || return 0

  while IFS= read -r container; do
    [ -n "$container" ] || continue
    [[ "$container" =~ -([0-9]+)$ ]] || continue
    partition_id="${BASH_REMATCH[1]}"
    map_name=""
    game_port=""
    igw_port=""

    if is_running dune-postgres; then
      row="$(
        docker exec dune-postgres psql -U dune -d dune -At -F '|' -c "
          select
            coalesce(nullif(fs.map, ''), nullif(wp.map, ''), 'Partition ${partition_id}'),
            coalesce(fs.game_port::text, ''),
            coalesce(fs.igw_port::text, '')
          from dune.world_partition wp
          left join dune.farm_state fs on fs.server_id = wp.server_id
          where wp.partition_id = ${partition_id}
          limit 1;
        " 2>/dev/null || true
      )"
      IFS='|' read -r map_name game_port igw_port <<< "$row"
    fi

    if { [ -z "${game_port:-}" ] || [ -z "${igw_port:-}" ]; } && [ -f runtime/generated/spawn-port-reservations.tsv ]; then
      fallback="$(awk -F '\t' -v container="$container" '$1 == container { print $2 "|" $3; exit }' runtime/generated/spawn-port-reservations.tsv)"
      if [ -n "$fallback" ]; then
        IFS='|' read -r game_port igw_port <<< "$fallback"
      fi
    fi

    if [ -z "${map_name:-}" ]; then
      map_name="${container#dune-server-}"
      map_name="${map_name%-${partition_id}}"
    fi

    if [ -n "${game_port:-}" ]; then
      printf "%-24s %-8s %s\n" "${map_name} clients" "${game_port}/udp" "$(check_udp "$game_port" "$container")"
    fi
    if [ -n "${igw_port:-}" ]; then
      printf "%-24s %-8s %s\n" "${map_name} S2S" "${igw_port}/udp" "$(check_udp "$igw_port" "$container")"
    fi
  done <<< "$containers"
}

map_state() {
  local container="$1"
  local pattern="$2"
  local logs
  local partition_id=""
  local farm_ready=""

  if ! is_running "$container"; then
    issue=1
    echo "NOT RUNNING"
    return
  fi

  if [[ "$container" =~ -([0-9]+)$ ]]; then
    partition_id="${BASH_REMATCH[1]}"
  elif [ "$container" = "dune-server-survival-1" ]; then
    partition_id="1"
  elif [ "$container" = "dune-server-overmap" ]; then
    partition_id="2"
  fi

  if [ -n "$partition_id" ] && is_running dune-postgres; then
    farm_ready="$(
      docker exec dune-postgres psql -U dune -d dune -Atc "
        select coalesce(fs.ready::text, 'f')
        from dune.world_partition wp
        left join dune.farm_state fs on fs.server_id = wp.server_id
        where wp.partition_id = ${partition_id}
        limit 1;
      " 2>/dev/null | tr -d '[:space:]'
    )"
    if [[ "${farm_ready,,}" =~ ^(t|true|1|yes|y)$ ]]; then
      echo "READY"
      return
    fi
  fi

  logs="$(docker logs "$container" 2>&1 || true)"

  if grep -Eq "$pattern" <<< "$logs"; then
    echo "READY"
  elif grep -Eiq 'fatal error|segmentation fault|sigsegv|assertion failed|unhandled exception|core dumped|panic:' <<< "$logs"; then
    issue=1
    echo "ERROR"
  else
    warming=1
    echo "WARMING"
  fi
}

count_rmq_prefix() {
  local prefix="$1"

  if ! is_running dune-rmq-game; then
    echo "0"
    return
  fi

  if [ "$rmq_game_connections_cache" = "__unset__" ]; then
    rmq_game_connections_cache="$(timeout 60 docker exec dune-rmq-game rabbitmqctl list_connections user state 2>/dev/null || true)"
  fi

  printf '%s\n' "$rmq_game_connections_cache" \
    | awk -v prefix="$prefix" '$1 != "user" && index($1, prefix) == 1 && $2 == "running" { n++ } END { print n + 0 }'
}

recent_director_logs() {
  if is_running dune-director; then
    docker logs --tail 5000 dune-director 2>&1 || true
  fi
}

recent_gateway_logs() {
  if is_running dune-server-gateway; then
    docker logs --tail 5000 dune-server-gateway 2>&1 || true
  fi
}

container_env_value() {
  local container="$1"
  local key="$2"

  if ! is_running "$container"; then
    return 1
  fi

  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" 2>/dev/null \
    | awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2); exit }'
}

first_known_value() {
  local candidate
  for candidate in "$@"; do
    if value_is_known "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

latest_number_from_director_logs() {
  local key="$1"
  grep -o "\"$key\":[0-9.]*" <<< "$director_logs" \
    | tail -n1 \
    | awk -F: '{ print $2 }'
}

signal_state() {
  local pattern="$1"
  local ok_label="$2"
  local wait_label="$3"

  if grep -q "$pattern" <<< "$director_logs"; then
    echo "$ok_label"
  else
    warming=1
    echo "$wait_label"
  fi
}

director_log_has() {
  local pattern="$1"
  grep -Eq "$pattern" <<< "$director_logs"
}

autoscaler_state() {
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-autoscaler; then
    echo "RUNNING"
  else
    echo "STOPPED"
  fi
}

auto_update_state() {
  local state_file="runtime/generated/update-auto.env"
  local DUNE_AUTO_UPDATE_ENABLED=0
  local DUNE_AUTO_UPDATE_TIME="${DUNE_AUTO_UPDATE_TIME:-05:00:00}"

  if [ -f "$state_file" ]; then
    # shellcheck disable=SC1090
    . "$state_file"
  fi

  if [ "${DUNE_AUTO_UPDATE_ENABLED:-0}" = "1" ]; then
    echo "ENABLED at ${DUNE_AUTO_UPDATE_TIME:-05:00:00}"
  else
    echo "DISABLED"
  fi
}

resolved_title="$(first_known_value \
  "$(config_value .env SERVER_TITLE 2>/dev/null || true)" \
  "${SERVER_TITLE:-}" \
  "$(container_env_value dune-director BATTLEGROUP_TITLE 2>/dev/null || true)" \
  "$(container_env_value dune-server-gateway gateway_display_name 2>/dev/null || true)" \
  || true)"
resolved_region="$(first_known_value \
  "$(config_value .env SERVER_REGION 2>/dev/null || true)" \
  "${SERVER_REGION:-}" \
  "$(container_env_value dune-director BATTLEGROUP_REGION_NAME 2>/dev/null || true)" \
  "$(container_env_value dune-server-gateway OnlineSubsystem_DatacenterId 2>/dev/null || true)" \
  || true)"
resolved_server_ip="$(first_known_value \
  "$(resolve_server_ip 2>/dev/null || true)" \
  "$(config_value .env SERVER_IP 2>/dev/null || true)" \
  "${SERVER_IP:-}" \
  "$(container_env_value dune-director HOST_DATACENTER_IP_ADDRESS 2>/dev/null || true)" \
  "$(container_env_value dune-server-gateway HOST_DATACENTER_IP_ADDRESS 2>/dev/null || true)" \
  || true)"
resolved_battlegroup_id="$(first_known_value \
  "$(resolve_battlegroup_id 2>/dev/null || true)" \
  "$(container_env_value dune-director BATTLEGROUP 2>/dev/null || true)" \
  "$(container_env_value dune-server-gateway BATTLEGROUP 2>/dev/null || true)" \
  "${BATTLEGROUP_ID:-}" \
  || true)"
display_mode="$(first_known_value \
  "${SERVER_IP_MODE:-}" \
  "$(config_value .env SERVER_IP_MODE 2>/dev/null || true)" \
  || true)"

if [ -z "$display_mode" ] || [ "$display_mode" = "unknown" ]; then
  if value_is_known "$resolved_server_ip"; then
    if is_private_ipv4 "$resolved_server_ip"; then
      display_mode="local"
    else
      display_mode="public"
    fi
  else
    display_mode="unknown"
  fi
fi

director_logs="$(recent_director_logs)"
gateway_logs="$(recent_gateway_logs)"

container_rows=""
for c in \
  dune-postgres \
  dune-rmq-admin \
  dune-rmq-game \
  dune-text-router \
  dune-director \
  dune-server-gateway \
  dune-server-survival-1 \
  dune-server-overmap \
  dune-orchestrator
do
  container_rows="${container_rows}$(printf "%-26s %s" "$c" "$(container_status "$c")")"$'\n'
done

postgres_port="$(resolve_postgres_port)"
rmq_admin_port="$(resolve_rmq_admin_port)"
rmq_game_port="$(resolve_rmq_game_port)"
rmq_game_http_port="$(resolve_rmq_game_http_port)"
text_router_port="$(resolve_text_router_port)"
director_port="$(resolve_director_port)"
postgres_tcp="$(check_tcp "$postgres_port")"
rmq_admin_tcp="$(check_tcp "$rmq_admin_port")"
rmq_game_tcp="$(check_tcp "$rmq_game_port")"
rmq_game_http_tcp="$(check_tcp "$rmq_game_http_port")"
text_router_tcp="$(check_tcp "$text_router_port")"
director_tcp="$(check_tcp "$director_port")"
client_port_base="$(resolve_client_port_base)"
igw_port_base="$(resolve_igw_port_base)"
overmap_client_port="$client_port_base"
survival_client_port="$((client_port_base + 1))"
survival_s2s_port="$igw_port_base"
overmap_s2s_port="$((igw_port_base + 1))"
overmap_udp="$(check_udp "$overmap_client_port" "dune-server-overmap")"
survival_udp="$(check_udp "$survival_client_port" "dune-server-survival-1")"
survival_s2s_udp="$(check_udp "$survival_s2s_port" "dune-server-survival-1")"
overmap_s2s_udp="$(check_udp "$overmap_s2s_port" "dune-server-overmap")"
dynamic_listeners="$(dynamic_listener_rows)"
if grep -q ' MISSING$' <<< "$dynamic_listeners"; then
  issue=1
fi

partition_count="unknown"
if is_running dune-postgres; then
  partition_count="$(docker exec dune-postgres psql -U dune -d dune -Atc "select count(*) from world_partition;" 2>/dev/null | tr -d '[:space:]' || true)"
  if [ "${partition_count:-0}" -le 0 ] 2>/dev/null; then
    issue=1
  fi
else
  issue=1
fi

survival_state="$(map_state dune-server-survival-1 'Server farm is READY .*partition 1')"
overmap_state="$(map_state dune-server-overmap 'Server farm is READY .*partition 2')"

active="$(latest_number_from_director_logs 'BattlegroupCurrentActive' || true)"
database_active=""
if is_running dune-postgres; then
  database_active="$(docker exec dune-postgres psql -U dune -d dune -Atc "
    select case
      when to_regclass('dune.actors') is null or to_regclass('dune.player_state') is null then null
      else (
        select count(distinct a.id)::text
        from dune.actors a
        left join dune.player_state ps on ps.account_id = a.owner_account_id
        left join dune.accounts ac on ac.id = ps.account_id
        where a.class ilike '%PlayerCharacter%'
          and coalesce(ps.online_status::text, '') = 'Online'
          and (
            not exists (
              select 1
              from information_schema.columns
              where table_schema = 'dune'
                and table_name = 'player_state'
                and column_name = 'player_pawn_id'
            )
            or ps.player_pawn_id is null
            or ps.player_pawn_id = 0
            or ps.player_pawn_id = a.id
          )
          and coalesce(ac.\"user\", '') <> 'A5C0DE5E12A00001'
          and coalesce(ac.\"user\", '') <> 'A5C0DE5E12A00002'
          and coalesce(ac.funcom_id, '') <> 'Server#0001'
          and coalesce(ac.funcom_id, '') <> 'MessageOfTheDay#0001'
          and coalesce(ps.character_name, '') <> 'Server'
          and coalesce(ps.character_name, '') <> 'Message of the Day'
      )
    end;
  " 2>/dev/null | tr -d '[:space:]' || true)"
fi
if [ "${database_active:-}" -ge 0 ] 2>/dev/null; then
  if ! [ "${active:-}" -ge 0 ] 2>/dev/null || [ "$database_active" -gt "${active:-0}" ]; then
    active="$database_active"
  fi
fi
capacity="$(latest_number_from_director_logs 'BattlegroupMaxPlayerCapacity' || true)"
configured_capacity="$(awk '
  function flush_section(    effective_update, effective_cap) {
    if (section == "" || section == "Server" || section == "Battlegroup" || section == "InstancingModes") {
      return
    }

    effective_update = section_update
    if (effective_update == "") {
      effective_update = default_update
    }

    effective_cap = section_cap
    if (effective_cap == "") {
      effective_cap = default_cap
    }

    if (effective_update == "true" && effective_cap ~ /^[0-9]+$/) {
      sum += effective_cap
    }
  }

  /^\[/ {
    flush_section()
    section = $0
    gsub(/^\[|\]$/, "", section)
    section_update = ""
    section_cap = ""
    next
  }

  /^ShouldUpdatePlayerCountOnFls=/ {
    value = substr($0, index($0, "=") + 1)
    gsub(/[[:space:]]+$/, "", value)
    if (section == "Server") {
      default_update = tolower(value)
    } else {
      section_update = tolower(value)
    }
    next
  }

  /^PlayerHardCap=/ {
    value = substr($0, index($0, "=") + 1)
    gsub(/[[:space:]]+$/, "", value)
    if (section == "Server") {
      default_cap = value
    } else {
      section_cap = value
    }
    next
  }

  END {
    flush_section()
    print sum + 0
  }
' runtime/director/config/director_config.ini 2>/dev/null || true)"

if ! [ "${capacity:-0}" -gt 0 ] 2>/dev/null && [ "${configured_capacity:-0}" -gt 0 ] 2>/dev/null; then
  capacity="$configured_capacity"
fi

if director_fls_logs_ready "$director_logs"; then
  heartbeat_state="OK"
else
  heartbeat_state="WAIT"
fi

if director_fls_logs_ready "$director_logs"; then
  population_state="OK"
else
  population_state="WAIT"
fi

if director_log_has 'Battlegroups_DeclareMaxPlayerCapacities.*Request successful'; then
  capacity_state="OK"
elif director_fls_logs_ready "$director_logs"; then
  capacity_state="OK"
else
  capacity_state="WAIT"
fi

if is_running dune-server-gateway && grep -Eq 'Monitoring for servers going up or down|Starting gateway for battlegroup' <<< "$gateway_logs"; then
  gateway_db_state="OK"
else
  gateway_db_state="WAIT"
  warming=1
fi

population="${active:-unknown}/${capacity:-unknown}"

main_stack_stopped=0
if ! is_running dune-postgres \
  && ! is_running dune-rmq-admin \
  && ! is_running dune-rmq-game \
  && ! is_running dune-text-router \
  && ! is_running dune-director \
  && ! is_running dune-server-gateway \
  && ! is_running dune-server-survival-1 \
  && ! is_running dune-server-overmap; then
  main_stack_stopped=1
fi

case "$container_rows" in
  *missing*|*stopped*) issue=1 ;;
esac

for listener_state in \
  "$postgres_tcp" \
  "$rmq_admin_tcp" \
  "$rmq_game_tcp" \
  "$rmq_game_http_tcp" \
  "$text_router_tcp" \
  "$director_tcp" \
  "$overmap_udp" \
  "$survival_udp" \
  "$survival_s2s_udp" \
  "$overmap_s2s_udp"
do
  [ "$listener_state" = "OK" ] || issue=1
done

case "$survival_state:$overmap_state" in
  *ERROR*|*NOT\ RUNNING*) issue=1 ;;
  *WARMING*) warming=1 ;;
esac

[ "$heartbeat_state" = "OK" ] || warming=1
[ "$population_state" = "OK" ] || warming=1
[ "$capacity_state" = "OK" ] || warming=1
[ "$gateway_db_state" = "OK" ] || warming=1

overall="READY"
if [ "$main_stack_stopped" -eq 1 ]; then
  overall="STOPPED"
elif [ "$issue" -ne 0 ]; then
  overall="ISSUE"
elif [ "$warming" -ne 0 ]; then
  overall="WARMING"
fi

echo "=== Dune status ==="
echo "Overall:     $overall"
echo "Title:       ${resolved_title:-unknown}"
echo "Region:      ${resolved_region:-unknown}"
echo "Mode:        $display_mode"
echo "Server IP:   ${resolved_server_ip:-unknown}"
echo "Battlegroup: ${resolved_battlegroup_id:-unknown}"
echo "Population:  $population"
echo

echo "=== Containers ==="
printf "%-26s %s\n" "SERVICE" "STATUS"
printf "%s" "$container_rows"

echo
echo "=== Listeners ==="
printf "%-24s %-8s %s\n" "CHECK" "PORT" "STATUS"
printf "%-24s %-8s %s\n" "Postgres localhost" "${postgres_port}/tcp" "$postgres_tcp"
printf "%-24s %-8s %s\n" "RabbitMQ admin" "${rmq_admin_port}/tcp" "$rmq_admin_tcp"
printf "%-24s %-8s %s\n" "RabbitMQ game" "${rmq_game_port}/tcp" "$rmq_game_tcp"
printf "%-24s %-8s %s\n" "RabbitMQ game HTTP" "${rmq_game_http_port}/tcp" "$rmq_game_http_tcp"
printf "%-24s %-8s %s\n" "TextRouter" "${text_router_port}/tcp" "$text_router_tcp"
printf "%-24s %-8s %s\n" "Director" "${director_port}/tcp" "$director_tcp"
printf "%-24s %-8s %s\n" "Overmap clients" "${overmap_client_port}/udp" "$overmap_udp"
printf "%-24s %-8s %s\n" "Survival_1 clients" "${survival_client_port}/udp" "$survival_udp"
printf "%-24s %-8s %s\n" "Survival_1 S2S" "${survival_s2s_port}/udp" "$survival_s2s_udp"
printf "%-24s %-8s %s\n" "Overmap S2S" "${overmap_s2s_port}/udp" "$overmap_s2s_udp"
printf "%s" "$dynamic_listeners"

echo
echo "=== Database ==="
echo "World partitions: ${partition_count:-unknown}"

echo
echo "=== Game servers ==="
printf "%-12s %-12s %s\n" "MAP" "STATE" "UPTIME"
printf "%-12s %-12s %s\n" "Survival_1" "$survival_state" "$(container_status dune-server-survival-1)"
printf "%-12s %-12s %s\n" "Overmap" "$overmap_state" "$(container_status dune-server-overmap)"
echo
echo "Note: after a sietch becomes READY, it can still take a bit of time to show up again in the in-game server browser."

echo
echo "=== Automation ==="
echo "Autoscaler:   $(autoscaler_state)"
echo "Auto updates: $(auto_update_state)"

echo
echo "=== RabbitMQ game connections ==="
if is_running dune-rmq-game; then
  echo "RabbitMQ connection details: Checked by readiness"
else
  echo "RabbitMQ game is not running"
fi

echo
echo "=== Funcom/FLS summary ==="
echo "Director heartbeat:       $heartbeat_state"
echo "Population declaration:   $population_state"
echo "Max capacity declaration: $capacity_state"
echo "Gateway DB monitoring:    $gateway_db_state"

echo
echo "Tip: use 'dune ready' for pass/wait/fail readiness checks."
echo "Tip: use 'dune doctor' for troubleshooting suggestions."
