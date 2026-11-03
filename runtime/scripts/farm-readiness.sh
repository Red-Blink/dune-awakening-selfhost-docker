#!/usr/bin/env bash

# Shared, conservative game-map readiness checks.
#
# farm_state.ready is published before the game necessarily accepts players.
# A map is travel-ready only after its own farm-ready marker has appeared and
# the current database state still reports it ready/alive. The marker is cached
# against the current container ID because noisy game logs can push the startup
# line outside a bounded log tail. A recreated container therefore has to emit
# its own marker and can never inherit readiness from an older process.
# Survival_1 also requires several consecutive director reports so an initial
# or flapping ready=true value cannot briefly appear as Ready in the Console.

# shellcheck source=runtime/scripts/lib/postgres.sh
source runtime/scripts/lib/postgres.sh

farm_ready_log_tail_lines="${DUNE_FARM_READY_LOG_TAIL_LINES:-6000}"
farm_ready_director_tail_lines="${DUNE_FARM_READY_DIRECTOR_TAIL_LINES:-10000}"
farm_ready_survival_reports="${DUNE_FARM_READY_SURVIVAL_REPORTS:-3}"
farm_ready_director_fallback_reports="${DUNE_FARM_READY_DIRECTOR_FALLBACK_REPORTS:-3}"
farm_ready_db_fallback_min_age_seconds="${DUNE_FARM_READY_DB_FALLBACK_MIN_AGE_SECONDS:-120}"
farm_ready_cache_dir="${DUNE_FARM_READY_CACHE_DIR:-runtime/generated/farm-ready-markers}"
farm_ready_docker_timeout_seconds="${DUNE_FARM_READY_DOCKER_TIMEOUT_SECONDS:-12}"

farm_docker_timeout() {
  timeout --kill-after=2s "${farm_ready_docker_timeout_seconds}s" "$@"
}

farm_cache_ready_marker() {
  local container="$1"
  local partition_id="$2"
  local container_id="$3"
  local cache_file tmp_file

  [[ "$container" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
  mkdir -p "$farm_ready_cache_dir" 2>/dev/null || return 1
  cache_file="$farm_ready_cache_dir/${container}.marker"
  tmp_file="${cache_file}.tmp.$$"
  printf '%s|%s\n' "$container_id" "$partition_id" > "$tmp_file" 2>/dev/null || return 1
  mv -f "$tmp_file" "$cache_file" 2>/dev/null
}

farm_cached_ready_marker_matches() {
  local container="$1"
  local partition_id="$2"
  local container_id="$3"
  local cache_file cached=""

  [[ "$container" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
  cache_file="$farm_ready_cache_dir/${container}.marker"
  [ -r "$cache_file" ] || return 1
  IFS= read -r cached < "$cache_file" || true
  [ "$cached" = "${container_id}|${partition_id}" ]
}

farm_cache_stable_reports() {
  local container="$1"
  local partition_id="$2"
  local container_id="$3"
  local director_id="$4"
  local cache_file tmp_file

  [[ "$container" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
  mkdir -p "$farm_ready_cache_dir" 2>/dev/null || return 1
  cache_file="$farm_ready_cache_dir/${container}.stable"
  tmp_file="${cache_file}.tmp.$$"
  printf '%s|%s|%s\n' "$container_id" "$director_id" "$partition_id" > "$tmp_file" 2>/dev/null || return 1
  mv -f "$tmp_file" "$cache_file" 2>/dev/null
}

farm_cached_stable_reports_match() {
  local container="$1"
  local partition_id="$2"
  local container_id="$3"
  local director_id="$4"
  local cache_file cached=""

  [[ "$container" =~ ^[A-Za-z0-9_.-]+$ ]] || return 1
  cache_file="$farm_ready_cache_dir/${container}.stable"
  [ -r "$cache_file" ] || return 1
  IFS= read -r cached < "$cache_file" || true
  [ "$cached" = "${container_id}|${director_id}|${partition_id}" ]
}

farm_container_logs_have_ready_marker() {
  local container="$1"
  local partition_id="$2"
  local scope="${3:-tail}"
  local pattern

  pattern="Server farm is READY .*partition ${partition_id}([,[:space:]]|$)"
  if [ "$scope" = "all" ]; then
    # Process substitution makes the match authoritative even when grep exits
    # early and Docker receives SIGPIPE. This keeps a one-time full-log lookup
    # fast without pipefail turning a successful match into a false negative.
    grep -E -m 1 "$pattern" < <(farm_docker_timeout docker logs "$container" 2>&1) >/dev/null
  else
    grep -E -m 1 "$pattern" \
      < <(farm_docker_timeout docker logs --tail "$farm_ready_log_tail_lines" "$container" 2>&1) >/dev/null
  fi
}

farm_container_has_recent_ready_marker() {
  local container="$1"
  local partition_id="$2"
  local container_id

  container_id="$(docker inspect -f '{{.Id}}' "$container" 2>/dev/null)"
  [ -n "$container_id" ] || return 1

  if farm_cached_ready_marker_matches "$container" "$partition_id" "$container_id"; then
    return 0
  fi

  if farm_container_logs_have_ready_marker "$container" "$partition_id"; then
    farm_cache_ready_marker "$container" "$partition_id" "$container_id" || true
    return 0
  fi

  return 1
}

farm_container_has_ready_marker() {
  local container="$1"
  local partition_id="$2"
  local container_id

  if farm_container_has_recent_ready_marker "$container" "$partition_id"; then
    return 0
  fi

  container_id="$(docker inspect -f '{{.Id}}' "$container" 2>/dev/null)"
  [ -n "$container_id" ] || return 1

  # The Console may first inspect a map after the marker has already rolled out
  # of the bounded tail. Time-limit a scan of the current container's complete
  # log; a hit is cached, so subsequent status refreshes remain cheap and stable.
  if farm_container_logs_have_ready_marker "$container" "$partition_id" all; then
    farm_cache_ready_marker "$container" "$partition_id" "$container_id" || true
    return 0
  fi

  return 1
}

farm_partition_db_ready() {
  local partition_id="$1"
  local state

  state="$(
    psql_app_value "
      select concat(coalesce(fs.ready, false)::text, '|', coalesce(fs.alive, false)::text)
      from dune.world_partition wp
      left join dune.farm_state fs on fs.server_id = wp.server_id
      where wp.partition_id = ${partition_id}
      limit 1;
    " 2>/dev/null | tr -d '[:space:]'
  )"
  [ "$state" = "true|true" ] || [ "$state" = "t|t" ]
}

farm_now_epoch() {
  date +%s
}

farm_noncore_db_ready_age_sufficient() {
  local container="$1"
  local started_at started_epoch now_epoch age

  case "$container" in
    dune-server-survival-1|dune-server-overmap) return 1 ;;
  esac

  started_at="$(docker inspect -f '{{.State.StartedAt}}' "$container" 2>/dev/null)"
  [ -n "$started_at" ] || return 1
  started_epoch="$(date -d "$started_at" +%s 2>/dev/null)"
  now_epoch="$(farm_now_epoch)"
  [[ "$started_epoch" =~ ^[0-9]+$ && "$now_epoch" =~ ^[0-9]+$ ]] || return 1
  age=$((now_epoch - started_epoch))
  [ "$age" -ge "$farm_ready_db_fallback_min_age_seconds" ]
}

farm_partition_has_completed_travel() {
  local partition_id="$1" target server_id map_name
  target="$(psql_app_value "select server_id || '|' || map from dune.world_partition where partition_id = ${partition_id};" 2>/dev/null | tr -d '\r')" || return 1
  IFS='|' read -r server_id map_name <<< "$target"
  [ -n "$server_id" ] && [ -n "$map_name" ] || return 1
  python3 -c '
import re, sys
partition, server, destination = sys.argv[1:]
arrivals = set()
for line in sys.stdin.read().splitlines():
    if "Handling travel completion : TravelCompletion {" in line:
        fields = dict(re.findall(r"(FlsId|FlowId|MapName|PartitionId|ServerID) = ([^,}\s]+)", line))
        if fields.get("PartitionId") == partition and fields.get("ServerID") == server and fields.get("MapName") == destination:
            if fields.get("FlowId") and fields.get("FlsId"):
                arrivals.add((fields["FlowId"], fields["FlsId"]))
    match = re.search(r"Handling travel completion for ([^: ]+): ([^ ]+) to ([^ ]+) \(instancingMode=", line)
    if match and match[3] == destination and (match[1], match[2]) in arrivals:
        sys.exit(0)
sys.exit(1)
' "$partition_id" "$server_id" "$map_name"
}

farm_partition_has_stable_director_reports() {
  local partition_id="$1"
  local required_reports="${2:-1}"
  local container="${3:-}"
  local container_id="" director_id="" container_started_at="" director_started_at=""
  local reports report_count director_logs

  [ "$required_reports" -gt 0 ] 2>/dev/null || return 0

  if [ -n "$container" ]; then
    container_id="$(docker inspect -f '{{.Id}}' "$container" 2>/dev/null)"
    director_id="$(docker inspect -f '{{.Id}}|{{.State.StartedAt}}' dune-director 2>/dev/null)"
    director_started_at="${director_id#*|}"
    container_started_at="$(docker inspect -f '{{.State.StartedAt}}' "$container" 2>/dev/null)"
    # Host/Docker restarts retain container IDs. Cached reports from the old
    # process must not establish readiness for the new map or Director.
    if [ -n "$container_id" ] && [ -n "$container_started_at" ]; then
      container_id="${container_id}|${container_started_at}"
    else
      container_id=""
    fi
    if [ -n "$container_id" ] && [ -n "$director_id" ] \
      && farm_cached_stable_reports_match \
        "$container" "$partition_id" "$container_id" "$director_id"; then
      return 0
    fi
  fi

  director_logs="$(
      if [ -n "$container_started_at" ]; then
        # Some Docker log stores return an empty --since window even though
        # their bounded tail contains current reports. Filter Docker's own
        # timestamps locally, retaining the exact map-generation boundary.
        farm_docker_timeout docker logs --tail "$farm_ready_director_tail_lines" \
          --timestamps dune-director 2>&1 \
          | python3 runtime/scripts/filter-container-logs.py "$container_started_at" "$director_started_at"
      else
        farm_docker_timeout docker logs --tail "$farm_ready_director_tail_lines" dune-director 2>&1
      fi
  )" || return 1

  # A damaged/rotated Docker log index can return only historical records for
  # a large tail while the recent tail is intact. Retry a smaller bounded read
  # only when no current-generation evidence survived. Keep the same timestamp
  # filter and fail closed; never substitute historical reports or DB state.
  if [ -n "$container_started_at" ] && [ -z "$director_logs" ]; then
    local fallback_tail
    for fallback_tail in 1000 500; do
      [ "$farm_ready_director_tail_lines" -gt "$fallback_tail" ] 2>/dev/null || continue
      director_logs="$(
        farm_docker_timeout docker logs --tail "$fallback_tail" --timestamps dune-director 2>&1 \
          | python3 runtime/scripts/filter-container-logs.py "$container_started_at" "$director_started_at"
      )" || return 1
      [ -z "$director_logs" ] || break
    done
  fi

  # A completed arrival proves this exact current-generation server accepts
  # players. Do not keep showing Loading while waiting for extra heartbeats.
  # The caller still requires ready/alive DB state; never trust another server,
  # a request alone, or a completion from before this container was created.
  if [ -n "$container_started_at" ] && [[ "$director_logs" == *"Handling travel completion : TravelCompletion {"* ]] \
    && printf '%s\n' "$director_logs" | farm_partition_has_completed_travel "$partition_id"; then
    farm_cache_stable_reports "$container" "$partition_id" "$container_id" "$director_id" || true
    return 0
  fi

  reports="$(printf '%s\n' "$director_logs" \
      | grep -F "\"partitionId\":${partition_id}," \
      | sed -n 's/.*"ready":\(true\|false\).*/\1/p' \
      | tail -n "$required_reports"
  )"
  report_count="$(grep -c . <<<"$reports" || true)"
  [ "$report_count" -eq "$required_reports" ] || return 1
  grep -Fqx false <<<"$reports" && return 1

  if [ -n "$container_id" ] && [ -n "$director_id" ]; then
    farm_cache_stable_reports \
      "$container" "$partition_id" "$container_id" "$director_id" || true
  fi
  return 0
}

farm_partition_is_ready() {
  local container="$1"
  local partition_id="$2"
  local required_reports="${3:-0}"

  docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -qx true || return 1
  docker inspect -f '{{.State.Running}}' dune-postgres 2>/dev/null | grep -qx true || return 1
  farm_partition_db_ready "$partition_id" || return 1
  if farm_container_has_recent_ready_marker "$container" "$partition_id"; then
    farm_partition_has_stable_director_reports \
      "$partition_id" "$required_reports" "$container"
    return
  fi

  # Extremely noisy game logs can roll the one-time farm-ready marker out of
  # the bounded tail within seconds. Prefer current-container Director reports
  # over repeatedly scanning the complete multi-gigabyte Docker log. The
  # report window starts at this container generation, so stale reports from a
  # replaced map cannot satisfy readiness.
  if farm_partition_has_stable_director_reports \
    "$partition_id" "$farm_ready_director_fallback_reports" "$container"; then
    return 0
  fi

  # Deep Desert and some instanced maps do not publish ServerState records to
  # Director on every game build. For non-core maps only, a sufficiently old
  # current container plus ready/alive database state is the bounded fallback.
  # Survival and Overmap never use this shortcut because they own login/travel.
  if farm_noncore_db_ready_age_sufficient "$container"; then
    return 0
  fi

  case "$container" in
    dune-server-survival-1|dune-server-overmap) ;;
    *) return 1 ;;
  esac

  # Retain the historical lookup for installations whose Director log does not
  # contain enough current-generation reports. A successful lookup is cached.
  farm_container_has_ready_marker "$container" "$partition_id" || return 1
  farm_partition_has_stable_director_reports \
    "$partition_id" "$required_reports" "$container"
}

survival_farm_is_ready() {
  farm_partition_is_ready dune-server-survival-1 1 "$farm_ready_survival_reports"
}

overmap_farm_is_ready() {
  farm_partition_is_ready dune-server-overmap 2 0
}
