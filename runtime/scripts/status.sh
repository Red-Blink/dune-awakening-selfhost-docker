#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

set -a
[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env
set +a
source runtime/scripts/runtime-env.sh
source runtime/scripts/fls-signals.sh
source runtime/scripts/farm-readiness.sh
source runtime/scripts/container-issue-scan.sh
source runtime/scripts/game-server-roster.sh
# shellcheck source=runtime/scripts/lib/postgres.sh
source runtime/scripts/lib/postgres.sh
# shellcheck source=runtime/scripts/lib/rabbitmq.sh
source runtime/scripts/lib/rabbitmq.sh

issue=0
warming=0
rmq_game_connections_cache="__unset__"
udp_check_retries="${DUNE_STATUS_UDP_CHECK_RETRIES:-3}"
udp_check_retry_sleep="${DUNE_STATUS_UDP_CHECK_RETRY_SLEEP:-0.25}"
docker_timeout_seconds="${DUNE_STATUS_DOCKER_TIMEOUT_SECONDS:-12}"
log_tail_lines="${DUNE_STATUS_LOG_TAIL_LINES:-4000}"

docker_timeout() {
  timeout --kill-after=2s "${docker_timeout_seconds}s" "$@"
}

# As in ready.sh: the database checks run through lib/postgres.sh, which
# docker_timeout cannot wrap, so the seam takes the budget itself. These two
# queries carried no watchdog when they were `docker exec`s; giving them the
# one the rest of this script already uses is the point of stating it here.
DUNE_PSQL_TIMEOUT_SECONDS="$docker_timeout_seconds"

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

tcp_sockets_snapshot="__unset__"
udp_sockets_snapshot="__unset__"

check_tcp() {
  local port="$1"
  if [ "$tcp_sockets_snapshot" = "__unset__" ]; then
    tcp_sockets_snapshot="$(ss -lntp 2>/dev/null || true)"
  fi
  if grep -q ":$port " <<<"$tcp_sockets_snapshot"; then
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

  docker_timeout docker logs --tail "$log_tail_lines" "$container" 2>&1 \
    | grep -Eq "listening for (Clients|Servers) on [0-9.]+:${port}\\b"
}

udp_socket_listening() {
  local port="$1"
  if [ "$udp_sockets_snapshot" = "__unset__" ]; then
    udp_sockets_snapshot="$(ss -lnup 2>/dev/null || true)"
  fi
  if grep -q ":$port " <<<"$udp_sockets_snapshot"; then
    return 0
  fi
  # Refresh once on miss so retry loops observe newly bound sockets.
  udp_sockets_snapshot="$(ss -lnup 2>/dev/null || true)"
  grep -q ":$port " <<<"$udp_sockets_snapshot"
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
  local containers container partition_id row map_name game_port igw_port fallback all_partition_rows=""

  containers="$(docker ps --filter 'name=^dune-server-' --format '{{.Names}}' 2>/dev/null \
    | grep -Ev '^dune-server-(gateway|survival-1|overmap)$' || true)"
  [ -n "$containers" ] || return 0

  if is_running dune-postgres; then
    all_partition_rows="$(
      dune_psql_app -At -F '|' -c "
        select
          wp.partition_id::text,
          coalesce(nullif(fs.map, ''), nullif(wp.map, ''), 'Partition ' || wp.partition_id::text),
          coalesce(fs.game_port::text, ''),
          coalesce(fs.igw_port::text, '')
        from dune.world_partition wp
        left join dune.farm_state fs on fs.server_id = wp.server_id;
      " 2>/dev/null || true
    )"
  fi

  while IFS= read -r container; do
    [ -n "$container" ] || continue
    [[ "$container" =~ -([0-9]+)$ ]] || continue
    partition_id="${BASH_REMATCH[1]}"
    map_name=""
    game_port=""
    igw_port=""

    if [ -n "$all_partition_rows" ]; then
      row="$(printf '%s\n' "$all_partition_rows" | awk -F '|' -v pid="$partition_id" '$1 == pid { print $2 "|" $3 "|" $4; exit }')"
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
  local logs
  local partition_id=""
  local required_reports="0"

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

  if [ "$partition_id" = "1" ]; then
    required_reports="$farm_ready_survival_reports"
  fi

  if [ -n "$partition_id" ] && farm_partition_is_ready "$container" "$partition_id" "$required_reports"; then
    echo "READY"
    return
  fi

  # Bounded: crash markers land at the end of the log, and an unbounded read
  # across every always-on map is the single largest cost in this section.
  logs="$(docker_timeout docker logs --tail "$log_tail_lines" "$container" 2>&1 || true)"

  if grep -Eiq 'fatal error|segmentation fault|sigsegv|assertion failed|unhandled exception|core dumped|panic:' <<< "$logs"; then
    issue=1
    echo "ERROR"
  else
    warming=1
    echo "WARMING"
  fi
}

# One snapshot of every container, taken before the game-server rows are built.
# container_status() costs two or three docker calls per row, and it can return
# an EMPTY string when a container stops between its two reads -- an empty
# UPTIME column makes the row fail the consumers' row regex and vanish from the
# console entirely.
container_state_snapshot=""

load_container_state_snapshot() {
  container_state_snapshot="$(docker ps -a --format '{{.Names}}|{{.State}}|{{.Status}}' 2>/dev/null || true)"
}

snapshot_uptime_for() {
  local name="$1" row status
  row="$(printf '%s\n' "$container_state_snapshot" | awk -F '|' -v n="$name" '$1 == n {print; exit}')"
  if [ -z "$row" ]; then
    printf 'missing\n'
    return 0
  fi
  status="$(printf '%s' "$row" | cut -d '|' -f3-)"
  printf '%s\n' "${status:-unknown}"
}

# State for one expected map server.
#
# A configured always-on map whose container does not exist yet is usually
# waiting its turn rather than broken: the autoscaler brings always-on maps up
# only a few at a time. game_server_absent_state reports those as WAIT or
# QUEUED, which summarizeGameServers treats as warming. NOT RUNNING is reserved
# for a container that exists but is not running, or one still absent once the
# stack has been up past the queue grace window.
game_server_state_for() {
  local container="$1" uptime="$2"

  # Absence is taken from the snapshot rather than a per-container docker
  # inspect: map_state's is_running already does its own inspect, so probing
  # here too cost two extra docker calls for every expected map.
  if [ "$uptime" = "missing" ]; then
    game_server_absent_state "${core_stack_up:-0}" "${game_server_queue_open:-0}"
    return 0
  fi

  map_state "$container"
}

# The uptime column for an always-on map still absent past the grace window.
# Host-memory safety holding it back is the one cause the operator can act on
# directly, so it gets the same reading the Maps tab shows. Keeps "missing" so
# the row still rolls up as an issue.
game_server_missing_reason() {
  local memory_status available required
  memory_status="$(runtime/scripts/host-memory-safety.sh map-status "$1" "$2" 2>/dev/null || true)"
  case "$memory_status" in
    "state=blocked reason=host-memory "*)
      available="$(printf '%s\n' "$memory_status" | sed -n 's/.*available_gib=\([0-9]*\).*/\1/p')"
      required="$(printf '%s\n' "$memory_status" | sed -n 's/.*required_gib=\([0-9]*\).*/\1/p')"
      printf 'missing - waiting for host memory (%s GiB free, %s GiB needed)\n' "${available:-?}" "${required:-?}"
      ;;
    *) printf 'missing\n' ;;
  esac
}

render_game_server_rows() {
  local label map pid container state uptime rows survival_uptime overmap_uptime

  rows="$(
    while IFS='|' read -r label map pid container; do
      [ -n "$label" ] || continue
      uptime="$(snapshot_uptime_for "$container")"
      state="$(game_server_state_for "$container" "$uptime")"
      # summarizeGameServers scans the WHOLE row for MISSING, so leaving the
      # uptime as "missing" on a queued map would raise Needs Review anyway and
      # defeat the point of WAIT.
      if [ "$state" = "WAIT" ]; then
        uptime="pending"
      elif [ "$state" = "QUEUED" ]; then
        uptime="queued"
      elif [ "$state" = "NOT RUNNING" ] && [ "$uptime" = "missing" ]; then
        uptime="$(game_server_missing_reason "$map" "$pid")"
      fi
      printf '%-24s %-13s %s\n' "$label" "$state" "${uptime:-unknown}"
    done <<INNER
$(game_server_expected_roster "$game_server_always_on" "$game_server_partitions")
INNER
  )"

  # The invariant: never emit fewer rows than the two hardcoded ones this
  # section used to have. An empty roster means the partition roster could not
  # be read (Postgres down), not that there are no map servers.
  if [ -z "$rows" ]; then
    survival_uptime="$(snapshot_uptime_for dune-server-survival-1)"
    overmap_uptime="$(snapshot_uptime_for dune-server-overmap)"
    rows="$(
      printf '%-24s %-13s %s\n' \
        Survival_1 "$(game_server_state_for dune-server-survival-1 "$survival_uptime")" "$survival_uptime" \
        Overmap "$(game_server_state_for dune-server-overmap "$overmap_uptime")" "$overmap_uptime"
    )"
  fi

  printf '%s\n' "$rows"
}

count_rmq_prefix() {
  local prefix="$1"

  if ! is_running dune-rmq-game; then
    echo "0"
    return
  fi

  # As in ready.sh, through the management API where it can answer, and through
  # the same exec as before where it cannot. Cached either way, so a full status
  # run costs one lookup rather than one per prefix counted.
  if [ "$rmq_game_connections_cache" = "__unset__" ]; then
    local RMQ_HTTP_TIMEOUT_SECONDS=10
    rmq_game_connections_cache="$(dune_rmq_game_connections 2>/dev/null)" \
      || rmq_game_connections_cache="$(timeout 60 docker exec dune-rmq-game rabbitmqctl list_connections user state 2>/dev/null || true)"
  fi

  printf '%s\n' "$rmq_game_connections_cache" \
    | awk -v prefix="$prefix" '$1 != "user" && index($1, prefix) == 1 && $2 == "running" { n++ } END { print n + 0 }'
}

recent_director_logs() {
  if is_running dune-director; then
    docker_timeout docker logs --tail "$log_tail_lines" dune-director 2>&1 || true
  fi
}

recent_gateway_logs() {
  if is_running dune-server-gateway; then
    docker_timeout docker logs --tail "$log_tail_lines" dune-server-gateway 2>&1 || true
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
  local DUNE_AUTO_UPDATE_INTERVAL_MINUTES="${DUNE_AUTO_UPDATE_INTERVAL_MINUTES:-60}"

  if [ -f "$state_file" ]; then
    # shellcheck disable=SC1090
    . "$state_file"
  fi

  if [ "${DUNE_AUTO_UPDATE_ENABLED:-0}" = "1" ]; then
    echo "ENABLED every ${DUNE_AUTO_UPDATE_INTERVAL_MINUTES:-60} minutes"
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
  dune-coriolis-coordinator
do
  container_rows="${container_rows}$(printf "%-26s %s" "$c" "$(container_status "$c")")"$'\n'
done
orchestrator_container="$(dune_compose_running_service_container "$DUNE_COMPOSE_PROJECT_NAME" orchestrator 2>/dev/null || true)"
container_rows="${container_rows}$(printf "%-26s %s" "dune-orchestrator" "$(container_status "${orchestrator_container:-dune-orchestrator}")")"$'\n'

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
  # Counts what the Game servers roster below counts: non-blocked rows only.
  # Counting blocked rows here let the Database line and the roster disagree
  # with no explanation of why. Schema-qualified for the same reason the roster
  # query is -- unqualified it resolves only because the role name happens to
  # match the schema name.
  partition_count="$(psql_app_value "select count(*) from dune.world_partition where coalesce(blocked, false) = false;" 2>/dev/null | tr -d '[:space:]' || true)"
  if [ "${partition_count:-0}" -le 0 ] 2>/dev/null; then
    issue=1
  fi
else
  issue=1
fi

# Expected map servers come from CONFIGURATION, never from docker: an always-on
# map whose container is missing has to be reported, not quietly omitted.
#
# Three subprocesses total, independent of how many maps are configured.
game_server_always_on=""
game_server_concurrency=""
game_server_partitions=""
game_server_roster_unavailable=0

game_server_roster_raw="$(runtime/scripts/map-modes.sh always-on-maps 2>/dev/null || true)"
game_server_concurrency="$(printf '%s\n' "$game_server_roster_raw" | awk '$1 == "concurrency" { print $2; exit }')"
game_server_always_on="$(printf '%s\n' "$game_server_roster_raw" | awk '$1 == "map" { print $2 }')"

# Protected maps are deliberately NOT excluded here. map-modes.sh's own listing
# filters them out, and copying that would drop Survival_1's second partition --
# the very server the two hardcoded rows used to hide.
if is_running dune-postgres; then
  game_server_partitions="$(dune_psql_app -At -F '|' -c "
    select wp.map, wp.partition_id
    from dune.world_partition wp
    where coalesce(wp.blocked, false) = false
      and coalesce(wp.map, '') <> ''
    order by wp.map, wp.partition_id;
  " 2>/dev/null || true)"
fi
if [ -z "$game_server_partitions" ]; then
  game_server_roster_unavailable=1
fi

# Is the battlegroup itself fully up? Used to tell a map that has not been
# spawned yet from one that is genuinely missing. Derived from the container
# table already built above -- asking docker again cost eight inspects.
core_stack_up="$(game_server_core_stack_up "$container_rows")"

load_container_state_snapshot
# Whether an absent always-on map can still be waiting on the autoscaler.
game_server_queue_open=0
game_server_core_age="$(game_server_core_youngest_age "$container_state_snapshot")"
if [ -n "$game_server_core_age" ] && [ "$game_server_core_age" -lt "$(game_server_queue_grace_seconds \
  "$(game_server_expected_roster "$game_server_always_on" "$game_server_partitions" | grep -c .)" \
  "$game_server_concurrency")" ]; then
  game_server_queue_open=1
fi
game_server_rows="$(render_game_server_rows)"

active="$(latest_number_from_director_logs 'BattlegroupCurrentActive' || true)"
database_active=""
if is_running dune-postgres; then
  database_active="$(psql_app_value "
    select case
      when to_regclass('dune.actors') is null or to_regclass('dune.player_state') is null then null
      else (
        select count(distinct a.id)::text
        from dune.actors a
        left join dune.player_state ps on ps.account_id = a.owner_account_id
        left join dune.accounts ac on ac.id = ps.account_id
        where a.class ilike '%PlayerCharacter%'
          and a.id <> 900000103
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

coriolis_enabled="$(first_known_value "$(config_value .env DUNE_CORIOLIS_COORDINATOR_ENABLED 2>/dev/null || true)" "${DUNE_CORIOLIS_COORDINATOR_ENABLED:-}" "1")"
if container_rows_have_issue "$container_rows" "$coriolis_enabled"; then
  issue=1
fi

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

# map_state sets issue/warming itself, but it runs inside a command
# substitution while the rows are rendered, so those assignments die with the
# subshell -- the same trap documented in container-issue-scan.sh. Roll the
# finished rows up here instead, keeping ERROR ahead of WARMING.
if game_server_rows_have_issue "$game_server_rows"; then
  issue=1
elif game_server_rows_have_warming "$game_server_rows"; then
  warming=1
fi

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
printf "%-24s %-13s %s\n" "MAP" "STATE" "UPTIME"
printf '%s\n' "$game_server_rows"
if [ "$game_server_roster_unavailable" = "1" ]; then
  echo "Note: map roster unavailable (dune-postgres not running); showing the core maps only."
else
  echo "Note: $(printf '%s\n' "$game_server_rows" | grep -c .) always-on map servers expected, starting ${game_server_concurrency:-1} at a time."
fi
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
