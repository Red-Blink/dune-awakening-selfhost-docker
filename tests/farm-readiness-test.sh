#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

# farm-readiness.sh, like every script that sources a library here, resolves its
# `source` lines against the repository root.
cd "$repo_root"

# The database query goes through runtime/scripts/lib/postgres.sh, which would
# otherwise pick the TCP transport wherever a psql client is installed -- the
# GitHub runner images ship one -- and dial a server that does not exist. Pinning
# the exec transport keeps the query on the path the `docker` mock below covers.
export DUNE_PSQL_TRANSPORT=exec

source "$repo_root/runtime/scripts/farm-readiness.sh"

mock_map_log=""
mock_full_map_log=""
mock_director_log=""
mock_db_state="true|true"
mock_target="abc|Survival_1"
mock_container_id="container-generation-1"
mock_director_id="director-generation-1"
mock_director_started_at="2026-09-05T13:00:00Z"
mock_container_started_at="2026-09-05T13:00:00Z"
mock_report_timestamp="2026-09-05T13:10:00.000000000Z"
mock_stale_large_tail=0
mock_now_epoch="1788614400"
test_cache_dir="$(mktemp -d)"
mock_docker_log_calls_file="$test_cache_dir/docker-log-calls"
trap 'rm -rf "$test_cache_dir"' EXIT
farm_ready_cache_dir="$test_cache_dir"
export mock_map_log mock_full_map_log mock_director_log mock_db_state mock_container_id mock_director_id mock_container_started_at mock_docker_log_calls_file

# Keep Docker as an in-process mock while preserving the production helper's
# call boundary. A separate assertion below verifies that the real helper uses
# the external timeout command.
farm_docker_timeout() {
  "$@"
}

farm_now_epoch() {
  printf '%s\n' "$mock_now_epoch"
}

docker() {
  case "${1:-} ${2:-}" in
    "inspect -f")
      if [ "${3:-}" = "{{.Id}}" ]; then
        if [ "${4:-}" = "dune-director" ]; then
          printf '%s\n' "$mock_director_id"
        else
          printf '%s\n' "$mock_container_id"
        fi
      elif [ "${3:-}" = "{{.Id}}|{{.State.StartedAt}}" ] && [ "${4:-}" = "dune-director" ]; then
        printf '%s|%s\n' "$mock_director_id" "$mock_director_started_at"
      elif [ "${3:-}" = "{{.State.StartedAt}}" ]; then
        printf '%s\n' "$mock_container_started_at"
      else
        printf 'true\n'
      fi
      ;;
    "logs --since")
      printf '%s\n' "$*" >> "$mock_docker_log_calls_file"
      # Reproduce the daemon returning an empty filtered window despite a
      # current bounded tail. Readiness must not depend on this API filter.
      ;;
    "logs --tail")
      printf '%s\n' "$*" >> "$mock_docker_log_calls_file"
      if [ "${4:-}" = "--timestamps" ] && [ "${5:-}" = "dune-director" ]; then
        local stamp="$mock_report_timestamp"
        if [ "$mock_stale_large_tail" = 1 ] && [ "${3:-}" -gt 500 ]; then
          stamp='2026-09-04T13:10:00.000000000Z'
        fi
        while IFS= read -r line; do
          printf '%s %s\n' "$stamp" "$line"
        done <<< "$mock_director_log"
      elif [ "${4:-}" = "dune-director" ]; then
        printf '%s\n' "$mock_director_log"
      else
        printf '%s\n' "$mock_map_log"
      fi
      ;;
    "logs dune-server-survival-1"|"logs dune-server-overmap")
      printf '%s\n' "$*" >> "$mock_docker_log_calls_file"
      printf '%s\n' "$mock_full_map_log"
      ;;
    "exec dune-postgres")
      if [[ "$*" == *"select server_id ||"* ]]; then
        printf '%s\n' "$mock_target"
      else
        printf '%s\n' "$mock_db_state"
      fi
      ;;
    *)
      printf 'unexpected docker invocation: %s\n' "$*" >&2
      return 1
      ;;
  esac
}

expect_not_ready() {
  if farm_partition_is_ready dune-server-survival-1 1 3; then
    echo "expected Survival_1 to remain finalizing startup" >&2
    exit 1
  fi
}

# An early farm_state.ready value must not make the Console report Ready.
mock_map_log="startup is still loading persistence"
mock_director_log='[ServerState] {"partitionId":1,"ready":true}'
expect_not_ready

# The definitive marker is necessary, but current DB readiness is still
# authoritative if the map falls out of the farm.
mock_map_log='Server farm is READY (2 server(s), 31 required), partition 1, server abc'
mock_db_state="false|true"
mock_director_log=$'[ServerState] {"partitionId":1,"ready":true}\n[ServerState] {"partitionId":1,"ready":true}\n[ServerState] {"partitionId":1,"ready":true}'
: > "$mock_docker_log_calls_file"
expect_not_ready
[ ! -s "$mock_docker_log_calls_file" ] || {
  echo "database-not-ready partitions must not scan game logs" >&2
  exit 1
}

# A transient false report resets the startup confirmation.
mock_db_state="true|true"
mock_director_log=$'[ServerState] {"partitionId":1,"ready":true}\n[ServerState] {"partitionId":1,"ready":false}\n[ServerState] {"partitionId":1,"ready":true}'
expect_not_ready

# Fewer than the configured number of reports cannot briefly flash Ready.
mock_director_log=$'[ServerState] {"partitionId":1,"ready":true}\n[ServerState] {"partitionId":1,"ready":true}'
expect_not_ready

# Exact completed arrival is stronger evidence than an extra heartbeat, but
# requests, incomplete handling and another server/partition/player are not.
arrival='Handling travel completion : TravelCompletion { FlsId = player, FlowId = flow, MapName = Survival_1, PartitionId = 1, ServerID = abc }'
handled='Handling travel completion for flow: player to Survival_1 (instancingMode=Dimension)'
mock_director_log="$arrival"
expect_not_ready
for wrong in \
  "${arrival/ServerID = abc/ServerID = old-server}" \
  "${arrival/PartitionId = 1/PartitionId = 31}" \
  "${arrival/MapName = Survival_1/MapName = Overmap}" \
  "${arrival/FlowId = flow/FlowId = another-flow}" \
  "${arrival/FlsId = player/FlsId = another-player}"; do
  mock_director_log="$wrong"$'\n'"$handled"
  expect_not_ready
done
mock_director_log="$arrival"$'\n'"$handled"
mock_db_state="false|true"
expect_not_ready
mock_db_state="true|true"
farm_partition_is_ready dune-server-survival-1 1 3
grep -Fq "logs --tail $farm_ready_director_tail_lines --timestamps dune-director" "$mock_docker_log_calls_file"
if grep -Fq 'logs --since' "$mock_docker_log_calls_file"; then
  echo "readiness must filter bounded timestamps locally" >&2
  exit 1
fi
# Consume long output fully so a valid completion does not cause SIGPIPE.
{ printf '%s\n%s\n' "$arrival" "$handled"; printf 'unrelated long log %.0s' {1..10000}; } | farm_partition_has_completed_travel 1
mock_container_id="completed-arrival-new-generation"
mock_director_log=""
expect_not_ready
mock_container_id="container-generation-1"
rm -f "$test_cache_dir/dune-server-survival-1.stable"

# Marker + current ready/alive state + three consecutive reports is Ready.
mock_director_log=$'[ServerState] {"partitionId":1,"ready":true}\n[ServerState] {"partitionId":1,"ready":true}\n[ServerState] {"partitionId":1,"ready":true}'
# Historical, unparseable and subsecond-before-start reports fail closed.
mock_container_started_at="2026-09-05T13:10:00.123456789Z"
for mock_report_timestamp in \
  '2026-09-05T13:09:59Z' \
  '2026-09-05T13:10:00.123456788Z' \
  'invalid-timestamp'; do
  expect_not_ready
done
mock_report_timestamp="2026-09-05T15:10:00.123456789+02:00"
farm_partition_is_ready dune-server-survival-1 1 3
rm -f "$test_cache_dir/dune-server-survival-1.stable"
mock_container_started_at="2026-09-05T13:00:00Z"
mock_report_timestamp="2026-09-05T13:10:00.000000000Z"
mock_stale_large_tail=1
: > "$mock_docker_log_calls_file"
farm_partition_is_ready dune-server-survival-1 1 3
grep -Fq 'logs --tail 500 --timestamps dune-director' "$mock_docker_log_calls_file"
rm -f "$test_cache_dir/dune-server-survival-1.stable"
mock_stale_large_tail=0
farm_partition_is_ready dune-server-survival-1 1 3

# Once confirmed, startup stability is retained for the exact map/director
# generations instead of reparsing a noisy Director log on every UI refresh.
mock_director_log=""
farm_partition_is_ready dune-server-survival-1 1 3
# A restart of either process with the same container ID invalidates proof.
mock_director_started_at="2026-09-05T13:11:00Z"
expect_not_ready
# Retained reports predating this Director process cannot replace fresh proof.
mock_director_log=$'[ServerState] {"partitionId":1,"ready":true}\n[ServerState] {"partitionId":1,"ready":true}\n[ServerState] {"partitionId":1,"ready":true}'
expect_not_ready
mock_director_log=""
mock_director_started_at="2026-09-05T13:00:00Z"
mock_container_started_at="2026-09-05T13:11:00Z"
expect_not_ready
mock_container_started_at="2026-09-05T13:00:00Z"
mock_director_id="director-generation-2"
expect_not_ready
mock_director_id="director-generation-1"
mock_director_log=$'[ServerState] {"partitionId":1,"ready":true}\n[ServerState] {"partitionId":1,"ready":true}\n[ServerState] {"partitionId":1,"ready":true}'

# A marker that rolled out of the bounded tail uses current-generation stable
# Director reports without scanning the complete noisy game log.
rm -f "$test_cache_dir/dune-server-survival-1.marker"
mock_map_log=""
mock_full_map_log='Server farm is READY (2 server(s), 31 required), partition 1, server abc'
: > "$mock_docker_log_calls_file"
farm_partition_is_ready dune-server-survival-1 1 3
if grep -Fq 'logs dune-server-survival-1' "$mock_docker_log_calls_file"; then
  echo "stable Director readiness must avoid a complete game-log scan" >&2
  exit 1
fi
mock_full_map_log=""
farm_partition_is_ready dune-server-survival-1 1 3

# Cached readiness belongs only to the exact container generation.
mock_container_id="container-generation-2"
mock_director_log=""
expect_not_ready
mock_container_id="container-generation-1"

# Non-primary maps use the same marker/current-state contract without the
# additional Survival login-stability window.
mock_map_log='Server farm is READY (2 server(s), 31 required), partition 2, server def'
farm_partition_is_ready dune-server-overmap 2 0

# Non-core maps without Director reports use an age-gated DB fallback and must
# never scan their complete noisy game logs.
mock_map_log=""
mock_director_log=""
mock_container_id="deep-desert-generation-1"
mock_container_started_at="2026-09-05T12:00:00Z"
: > "$mock_docker_log_calls_file"
farm_partition_is_ready dune-server-deepdesert-1-8 8 0
if grep -Fq 'logs dune-server-deepdesert-1-8' "$mock_docker_log_calls_file"; then
  echo "non-core DB readiness fallback must not scan complete game logs" >&2
  exit 1
fi

# A newly created non-core container cannot become ready from DB state alone.
mock_container_id="deep-desert-generation-2"
mock_container_started_at="2026-09-05T13:19:30Z"
if farm_partition_is_ready dune-server-deepdesert-1-8 8 0; then
  echo "recent non-core container must remain finalizing startup" >&2
  exit 1
fi

grep -Fq "when wp.partition_id = 1 then '\${survival_log_ready}'" "$repo_root/runtime/scripts/servers.sh"
grep -Fq "else 'false'" "$repo_root/runtime/scripts/servers.sh"
grep -Fq 'timeout --kill-after=2s "${farm_ready_docker_timeout_seconds}s" "$@"' "$repo_root/runtime/scripts/farm-readiness.sh"

heal_script="$repo_root/runtime/scripts/heal-core-ready.sh"
grep -Fq 'docker_timeout docker logs --tail "$log_tail_lines" "$container_name"' "$heal_script"
if grep -Fq 'docker logs "$container_name"' "$heal_script"; then
  echo "core readiness healing must not scan complete game logs" >&2
  exit 1
fi

echo "farm readiness retains definitive markers only for the current container generation"
