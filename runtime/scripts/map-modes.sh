#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

set -a
[ -f .env ] && . ./.env
set +a

# shellcheck source=runtime/scripts/lib/postgres.sh
source runtime/scripts/lib/postgres.sh

STATE_FILE="${DUNE_MAP_MODES_FILE:-runtime/generated/map-runtime-modes.json}"
STATE_VERSION=3
GRACE_SECONDS="${DUNE_AUTOSCALER_DESPAWN_GRACE_SECONDS:-${DUNE_AUTOSCALER_IDLE_SECONDS:-300}}"
RECONCILE_LOCK_FILE="${DUNE_ALWAYS_ON_RECONCILE_LOCK_FILE:-runtime/generated/map-modes-reconcile.lock}"
RECONCILE_STATE_FILE="${DUNE_ALWAYS_ON_RECONCILE_STATE_FILE:-runtime/generated/map-modes-reconcile.tsv}"
RECONCILE_STATE_LOCK_FILE="${DUNE_ALWAYS_ON_RECONCILE_STATE_LOCK_FILE:-runtime/generated/map-modes-reconcile-state.lock}"
SPAWN_TIMEOUT_SECONDS="${DUNE_ALWAYS_ON_SPAWN_TIMEOUT_SECONDS:-240}"
STARTUP_PRIORITY="${DUNE_ALWAYS_ON_STARTUP_PRIORITY:-SH_Arrakeen,SH_HarkoVillage,DeepDesert_1}"

positive_int_or_default() {
  local value="$1"
  local fallback="$2"

  if printf '%s' "$value" | grep -Eq '^[1-9][0-9]*$'; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$fallback"
  fi
}

nonnegative_int_or_default() {
  local value="$1"
  local fallback="$2"

  if printf '%s' "$value" | grep -Eq '^[0-9]+$'; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$fallback"
  fi
}

STARTUP_PARALLELISM="$(positive_int_or_default "${DUNE_ALWAYS_ON_STARTUP_PARALLELISM:-1}" 1)"
RECONCILE_PARALLELISM="$(positive_int_or_default "${DUNE_ALWAYS_ON_RECONCILE_PARALLELISM:-$STARTUP_PARALLELISM}" "$STARTUP_PARALLELISM")"
MAX_SPAWNS_PER_RECONCILE="$(positive_int_or_default "${DUNE_ALWAYS_ON_RECONCILE_MAX_SPAWNS:-1}" 1)"
MAX_WARMING_SERVERS="$(positive_int_or_default "${DUNE_ALWAYS_ON_RECONCILE_MAX_WARMING:-$STARTUP_PARALLELISM}" "$STARTUP_PARALLELISM")"
HOST_SAFE_PARALLELISM="$(runtime/scripts/host-memory-safety.sh recommended-parallelism 2>/dev/null || echo 1)"
if [ "${DUNE_ALWAYS_ON_HOST_MEMORY_SAFETY:-1}" != "0" ]; then
  if [ "$STARTUP_PARALLELISM" -gt "$HOST_SAFE_PARALLELISM" ]; then
    STARTUP_PARALLELISM="$HOST_SAFE_PARALLELISM"
  fi
  if [ "$RECONCILE_PARALLELISM" -gt "$HOST_SAFE_PARALLELISM" ]; then
    RECONCILE_PARALLELISM="$HOST_SAFE_PARALLELISM"
  fi
  if [ "$MAX_WARMING_SERVERS" -gt "$HOST_SAFE_PARALLELISM" ]; then
    MAX_WARMING_SERVERS="$HOST_SAFE_PARALLELISM"
  fi
fi
if [ -n "${DUNE_ALWAYS_ON_RECONCILE_MIN_SPAWN_INTERVAL_SECONDS+x}" ]; then
  MIN_SPAWN_INTERVAL_SECONDS="$(nonnegative_int_or_default "$DUNE_ALWAYS_ON_RECONCILE_MIN_SPAWN_INTERVAL_SECONDS" 30)"
elif [ "$STARTUP_PARALLELISM" -gt 1 ]; then
  MIN_SPAWN_INTERVAL_SECONDS=0
else
  MIN_SPAWN_INTERVAL_SECONDS=30
fi

usage() {
  cat <<'EOF'
Usage:
  dune maps list
  dune maps mode
  dune maps mode <map>
  dune maps set <map> dynamic
  dune maps set <map> always-on
  dune maps set <map> overmap-active
  dune maps set <map> disabled
  dune maps reconcile
  dune maps always-on-maps

Survival_1 and Overmap are protected always-on maps and are not configurable here.
Use overmap-active explicitly for maps that should only run while Overmap has demand.
EOF
}

require_postgres() {
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-postgres; then
    echo "dune-postgres is not running."
    exit 1
  fi
}

protected_map() {
  case "$1" in
    Survival_1|Overmap|survival|survival-1|survival_1|overmap) return 0 ;;
    *) return 1 ;;
  esac
}

# Funcom resets some short-lived activity maps inside a still-running server
# process after the last player leaves or completes the activity. Some of
# those in-process resets leave stale vehicle permissions; the two credits
# story maps also intentionally crash/reinitialize and can no longer bind their
# game port. Funcom's Hyper-V deployment deallocates the pod in each case,
# so keep these maps demand-driven and allocate a fresh process per visit.
requires_fresh_process() {
  case "$1" in
    CB_Overland_S_06|CB_Story_DestroyedZanovar|CB_Story_OrbitalMonitor) return 0 ;;
    *) return 1 ;;
  esac
}

canonical_map() {
  local input="$1"
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-postgres; then
    printf '%s' "$input"
    return 0
  fi
  dune_psql -At -v ON_ERROR_STOP=1 -c "
    select map
    from dune.world_partition
    where lower(map) = lower('${input//\'/\'\'}')
    order by partition_id
    limit 1;
  " 2>/dev/null | tr -d '\r' || printf '%s' "$input"
}

ensure_state_file() {
  mkdir -p "$(dirname "$STATE_FILE")"
  if [ ! -s "$STATE_FILE" ]; then
    python3 - "$STATE_FILE" "$STATE_VERSION" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

path = Path(sys.argv[1])
payload = {
    "version": int(sys.argv[2]),
    "updated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "maps": {},
}
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
  fi

  # v3 retires legacy Always On / Overmap Active selections for maps whose
  # lifecycle now requires a fresh process per visit.  Merely masking the old
  # value at read time is insufficient: older reconciliation and publication
  # paths can consume the persisted value directly and create a spawn/despawn
  # loop.  Migrate it once, atomically, while retaining Disabled as an explicit
  # operator choice.
  if ! grep -Eq '"version"[[:space:]]*:[[:space:]]*3([,[:space:]}]|$)' "$STATE_FILE" 2>/dev/null; then
    python3 - "$STATE_FILE" "$STATE_VERSION" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

path = Path(sys.argv[1])
target_version = int(sys.argv[2])
try:
    data = json.loads(path.read_text(encoding="utf-8"))
except Exception:
    raise SystemExit(0)
if not isinstance(data, dict):
    raise SystemExit(0)
try:
    current_version = int(data.get("version", 0) or 0)
except (TypeError, ValueError):
    current_version = 0
if current_version >= target_version:
    raise SystemExit(0)

now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
maps = data.setdefault("maps", {})
for map_name in ("CB_Overland_S_06", "CB_Story_DestroyedZanovar", "CB_Story_OrbitalMonitor"):
    config = maps.get(map_name)
    if isinstance(config, dict) and config.get("mode") not in {"dynamic", "disabled"}:
        config["mode"] = "dynamic"
        config["last_mode_change_at"] = now
data["version"] = target_version
data["updated_at"] = now
tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
tmp.replace(path)
PY
  fi
}

mode_for_map() {
  local map="$1"
  ensure_state_file
  python3 - "$STATE_FILE" "$map" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
target = sys.argv[2]
try:
    data = json.loads(path.read_text(encoding="utf-8"))
except Exception:
    data = {}
mode = data.get("maps", {}).get(target, {}).get("mode", "dynamic")
if mode in {"always-on", "overmap-active", "disabled"}:
    print(mode)
else:
    print("dynamic")
PY
}

effective_mode_for_map() {
  local map="$1" mode
  mode="$(mode_for_map "$map")"
  if requires_fresh_process "$map" && [ "$mode" != "disabled" ]; then
    printf '%s\n' dynamic
  else
    printf '%s\n' "$mode"
  fi
}

last_change_epoch() {
  local map="$1"
  ensure_state_file
  python3 - "$STATE_FILE" "$map" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    raw = data.get("maps", {}).get(sys.argv[2], {}).get("last_mode_change_at", "")
    if not raw:
        raise ValueError
    dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    print(int(dt.timestamp()))
except Exception:
    print("")
PY
}

set_mode() {
  local map="$1"
  local mode="$2"
  local canonical

  require_postgres
  canonical="$(canonical_map "$map")"
  if [ -z "$canonical" ] || protected_map "$canonical"; then
    echo "Map is protected or unknown and cannot be configured here: $map"
    exit 1
  fi

  case "$mode" in
    dynamic|always-on|overmap-active|disabled) ;;
    *) echo "Mode must be dynamic, always-on, overmap-active, or disabled."; exit 2 ;;
  esac

  if requires_fresh_process "$canonical" && [ "$mode" != "dynamic" ] && [ "$mode" != "disabled" ]; then
    echo "$canonical must use Dynamic mode so each completed or empty instance is deallocated before its next use." >&2
    echo "Always On and Overmap Active can reuse a Funcom process that is no longer safe to accept players." >&2
    exit 1
  fi

  ensure_state_file
  python3 - "$STATE_FILE" "$canonical" "$mode" "$STATE_VERSION" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

path = Path(sys.argv[1])
target = sys.argv[2]
mode = sys.argv[3]
state_version = int(sys.argv[4])
try:
    data = json.loads(path.read_text(encoding="utf-8"))
except Exception:
    data = {}
data["version"] = state_version
data.setdefault("maps", {})
now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
data["updated_at"] = now
data["maps"][target] = {"mode": mode, "last_mode_change_at": now}
tmp = path.with_name(f".{path.name}.tmp.{os.getpid()}")
tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
tmp.replace(path)
PY

  echo "Map mode saved: $canonical -> $mode"
  if [ "$mode" = "always-on" ]; then
    reconcile_map "$canonical"
  elif [ "$mode" = "disabled" ]; then
    echo "Map is disabled. It will not be deployed by autoscaler demand or normal spawn commands."
    despawn_map "$canonical"
  elif [ "$mode" = "overmap-active" ]; then
    echo "Map will spawn while Overmap has active players and despawn after ${GRACE_SECONDS}s idle."
  elif requires_fresh_process "$canonical"; then
    echo "Map will allocate on player demand and deallocate as soon as it becomes empty."
  else
    echo "Map remains running if already active. It is eligible for normal despawn after ${GRACE_SECONDS}s."
  fi
}

list_maps() {
  local mode memory_status state available requested reserve required swap_free
  require_postgres
  ensure_state_file
  dune_psql -At -F '|' -c "
    select
      wp.map,
      count(*) as partitions,
      count(nullif(wp.server_id, '')) as assigned,
      min(wp.partition_id) as partition_id
    from dune.world_partition wp
    where wp.map not in ('Survival_1', 'Overmap')
    group by wp.map
    order by min(wp.partition_id);
  " | while IFS='|' read -r map partitions assigned partition_id; do
    [ -n "${map:-}" ] || continue
    mode="$(effective_mode_for_map "$map")"
    printf '%-28s Current: %-14s Partitions: %-3s Assigned: %s' "$map" "$mode" "$partitions" "$assigned"
    if [ "$mode" = "always-on" ] && [ "${assigned:-0}" -eq 0 ]; then
      memory_status="$(runtime/scripts/host-memory-safety.sh map-status "$map" "$partition_id" 2>/dev/null || true)"
      state="$(structured_status_field "$memory_status" state)"
      if [ "$state" = "blocked" ] && grep -q 'reason=host-memory' <<<"$memory_status"; then
        available="$(structured_status_field "$memory_status" available_gib)"
        requested="$(structured_status_field "$memory_status" requested_gib)"
        reserve="$(structured_status_field "$memory_status" reserve_gib)"
        required="$(structured_status_field "$memory_status" required_gib)"
        swap_free="$(structured_status_field "$memory_status" swap_free_gib)"
        printf ' Block: host-memory available=%sGiB required=%sGiB requested=%sGiB reserve=%sGiB swap-free=%sGiB' "$available" "$required" "$requested" "$reserve" "$swap_free"
      fi
    fi
    printf '\n'
  done
}

show_mode() {
  local map="${1:-}"
  if [ -z "$map" ]; then
    list_maps
    return 0
  fi
  map="$(canonical_map "$map")"
  printf '%s\t%s\n' "$map" "$(effective_mode_for_map "$map")"
}

structured_status_field() {
  local line="$1"
  local field="$2"

  awk -v field="$field" '{
    for (i = 1; i <= NF; i++) {
      if ($i ~ ("^" field "=")) {
        sub("^[^=]*=", "", $i)
        print $i
        exit
      }
    }
  }' <<<"$line"
}

container_name_for_map_partition() {
  local map="$1"
  local partition_id="$2"

  printf 'dune-server-%s-%s\n' \
    "$(printf '%s' "$map" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g')" \
    "$partition_id"
}

container_age_seconds() {
  local container="$1"
  local started

  started="$(docker inspect -f '{{.State.StartedAt}}' "$container" 2>/dev/null || true)"
  [ -n "$started" ] || { echo 0; return 0; }
  python3 - "$started" <<'PY'
from datetime import datetime, timezone
import sys

raw = sys.argv[1]
try:
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    started = datetime.fromisoformat(raw)
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    print(max(0, int((datetime.now(timezone.utc) - started).total_seconds())))
except Exception:
    print(0)
PY
}

reconcile_state_get() {
  local key="$1"
  [ -f "$RECONCILE_STATE_FILE" ] || return 1
  awk -F '\t' -v key="$key" '$1 == key { print $2; found=1; exit } END { if (!found) exit 1 }' "$RECONCILE_STATE_FILE"
}

reconcile_state_set() {
  local key="$1"
  local value="$2"
  local dir tmp lock_fd

  dir="$(dirname "$RECONCILE_STATE_FILE")"
  mkdir -p "$dir"
  exec {lock_fd}>"$RECONCILE_STATE_LOCK_FILE"
  flock "$lock_fd"
  tmp="$(mktemp "$dir/.reconcile-state.XXXXXX")"
  if [ -f "$RECONCILE_STATE_FILE" ]; then
    awk -F '\t' -v key="$key" '$1 != key { print }' "$RECONCILE_STATE_FILE" >"$tmp"
  fi
  printf '%s\t%s\n' "$key" "$value" >>"$tmp"
  mv "$tmp" "$RECONCILE_STATE_FILE"
  exec {lock_fd}>&-
}

recent_spawn_blocking() {
  local now last elapsed

  [ "${MIN_SPAWN_INTERVAL_SECONDS:-0}" -gt 0 ] 2>/dev/null || return 1
  now="$(date +%s)"
  last="$(reconcile_state_get last_spawn_at 2>/dev/null || true)"
  [ -n "$last" ] || return 1
  elapsed=$((now - last))
  [ "$elapsed" -lt "$MIN_SPAWN_INTERVAL_SECONDS" ]
}

warming_always_on_count() {
  local rows map partition_id server_id container logs warming=0

  rows="$(dune_psql -At -F '|' -c "
    select wp.map, wp.partition_id, wp.server_id
    from dune.world_partition wp
    left join dune.farm_state fs on fs.server_id = wp.server_id
    where coalesce(wp.server_id, '') <> ''
      and wp.map not in ('Survival_1', 'Overmap')
      and coalesce(fs.alive, false) = true
      and coalesce(fs.ready, false) = false
    order by wp.partition_id;
  " 2>/dev/null || true)"

  while IFS='|' read -r map partition_id server_id; do
    [ -n "${map:-}" ] && [ -n "${partition_id:-}" ] && [ -n "${server_id:-}" ] || continue
    container="$(container_name_for_map_partition "$map" "$partition_id")"

    # farm_state.ready can remain false after any world server is travel-ready.
    # Count only a live container that has not logged readiness; stale database
    # assignments and log-confirmed ready servers must not block the next map.
    docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -qx true || continue
    logs="$(timeout --kill-after=2s 12s docker logs --tail 4000 "$container" 2>&1 || true)"
    if awk -v identity="partition $partition_id, server $server_id," '
      index($0, "Server farm is READY") && index($0, identity) { found=1; exit }
      END { exit !found }
    ' <<<"$logs"; then
      continue
    fi
    warming=$((warming + 1))
  done <<<"$rows"

  printf '%s\n' "$warming"
}

run_spawn_server() {
  local partition_id="$1"
  shift || true

  if [ "${SPAWN_TIMEOUT_SECONDS:-0}" -gt 0 ] 2>/dev/null; then
    timeout --kill-after=10s "${SPAWN_TIMEOUT_SECONDS}s" runtime/scripts/spawn-server.sh "$partition_id" "$@"
  else
    runtime/scripts/spawn-server.sh "$partition_id" "$@"
  fi
}

spawn_gate_allows() {
  local map="$1"
  local partition_id="$2"
  local warming

  if [ -n "${DUNE_HOST_MEMORY_WAIT_STATE_DIR:-}" ]; then
    if ! runtime/scripts/host-memory-safety.sh check-map-throttled "$map" "$partition_id"; then
      return 1
    fi
  elif ! runtime/scripts/host-memory-safety.sh check-map "$map" "$partition_id"; then
    return 1
  fi

  if recent_spawn_blocking; then
    echo "WAIT always-on map=$map partition=$partition_id spawn-throttle=${MIN_SPAWN_INTERVAL_SECONDS}s"
    return 1
  fi

  warming="$(warming_always_on_count)"
  if [ "${warming:-0}" -ge "${MAX_WARMING_SERVERS:-1}" ] 2>/dev/null; then
    echo "WAIT always-on map=$map partition=$partition_id warming=${warming} max=${MAX_WARMING_SERVERS}"
    return 1
  fi

  return 0
}

adopt_live_unassigned_server() {
  local map="$1"
  local partition_id="$2"

  dune_psql -At -v ON_ERROR_STOP=1 -c "
with candidate as (
  select fs.server_id
  from dune.farm_state fs
  cross join (
    select count(*) as live_unassigned
    from dune.farm_state live
    where live.map = '${map//\'/\'\'}'
      and coalesce(live.alive, false) = true
      and coalesce(live.server_id, '') <> ''
      and not exists (
        select 1
        from dune.world_partition assigned
        where assigned.server_id = live.server_id
      )
  ) counts
  where fs.map = '${map//\'/\'\'}'
    and coalesce(fs.alive, false) = true
    and coalesce(fs.server_id, '') <> ''
    and counts.live_unassigned = 1
    and not exists (
      select 1
      from dune.world_partition assigned
      where assigned.server_id = fs.server_id
    )
  order by fs.ready desc, fs.server_id
  limit 1
)
update dune.world_partition wp
set server_id = candidate.server_id
from candidate
where wp.partition_id = $partition_id
  and coalesce(wp.server_id, '') = ''
returning wp.server_id;
  " 2>/dev/null | tr -d '\r[:space:]' || true
}

assigned_server_for_partition() {
  local partition_id="$1"

  dune_psql -At -c "
    select coalesce(server_id, '')
    from dune.world_partition
    where partition_id = $partition_id
    limit 1;
  " 2>/dev/null | tr -d '\r[:space:]' || true
}

reconcile_map() {
  local map="$1"
  local rows assigned running container age adopted spawned=0

  require_postgres
  rows="$(dune_psql -At -F '|' -c "
    select partition_id, coalesce(server_id, '')
    from dune.world_partition
    where map = '${map//\'/\'\'}'
      and coalesce(blocked, false) = false
    order by partition_id;
  ")"

  if [ -z "$rows" ]; then
    echo "No non-blocked partitions found for map: $map"
    return 1
  fi

  while IFS='|' read -r partition_id assigned; do
    [ -n "${partition_id:-}" ] || continue
    container="$(container_name_for_map_partition "$map" "$partition_id")"
    running="$(docker ps --format '{{.Names}}' | grep -Ec "^${container}$" || true)"
    if [ -n "$assigned" ]; then
      echo "OK   always-on map=$map partition=$partition_id"
      continue
    fi
    if [ "$running" != "0" ]; then
      adopted="$(adopt_live_unassigned_server "$map" "$partition_id")"
      assigned="$(assigned_server_for_partition "$partition_id")"
      if [ -n "$assigned" ]; then
        echo "REPAIR always-on map=$map partition=$partition_id adopted=${adopted:-$assigned}"
        continue
      fi
      age="$(container_age_seconds "$container")"
      if [ "${age:-0}" -lt 60 ] 2>/dev/null; then
        echo "WAIT always-on map=$map partition=$partition_id container=$container assigning"
        continue
      fi
      echo "REPAIR always-on map=$map partition=$partition_id restarting unassigned container=$container"
      spawn_gate_allows "$map" "$partition_id" || continue
      if run_spawn_server "$partition_id" --force; then
        reconcile_state_set last_spawn_at "$(date +%s)"
        spawned=$((spawned + 1))
      else
        echo "WARN always-on map=$map partition=$partition_id spawn failed or timed out"
      fi
      [ "$spawned" -lt "$MAX_SPAWNS_PER_RECONCILE" ] || break
      continue
    fi
    spawn_gate_allows "$map" "$partition_id" || continue
    echo "SPAWN always-on map=$map partition=$partition_id"
    if run_spawn_server "$partition_id"; then
      reconcile_state_set last_spawn_at "$(date +%s)"
      spawned=$((spawned + 1))
    else
      echo "WARN always-on map=$map partition=$partition_id spawn failed or timed out"
    fi
    [ "$spawned" -lt "$MAX_SPAWNS_PER_RECONCILE" ] || break
  done <<< "$rows"
}

reconcile_job_pids=()

wait_for_reconcile_slot() {
  local first_pid

  while [ "${#reconcile_job_pids[@]}" -ge "$RECONCILE_PARALLELISM" ]; do
    first_pid="${reconcile_job_pids[0]}"
    wait "$first_pid" || true
    reconcile_job_pids=("${reconcile_job_pids[@]:1}")
  done
}

wait_for_reconcile_jobs() {
  local pid

  for pid in "${reconcile_job_pids[@]}"; do
    wait "$pid" || true
  done
  reconcile_job_pids=()
}

reconcile_maps() {
  local map

  if [ "$#" -eq 0 ]; then
    return 0
  fi

  if [ "$RECONCILE_PARALLELISM" -le 1 ]; then
    for map in "$@"; do
      [ -n "$map" ] || continue
      reconcile_map "$map"
    done
    return 0
  fi

  echo "Reconciling always-on maps with parallelism=${RECONCILE_PARALLELISM}, max-warming=${MAX_WARMING_SERVERS}, min-spawn-interval=${MIN_SPAWN_INTERVAL_SECONDS}s"
  reconcile_job_pids=()
  for map in "$@"; do
    [ -n "$map" ] || continue
    wait_for_reconcile_slot
    (
      reconcile_map "$map"
    ) &
    reconcile_job_pids+=("$!")
  done
  wait_for_reconcile_jobs
}

despawn_map() {
  local map="$1"
  local rows partition_id assigned running

  require_postgres
  rows="$(dune_psql -At -F '|' -c "
    select partition_id, coalesce(server_id, '')
    from dune.world_partition
    where map = '${map//\'/\'\'}'
    order by partition_id;
  ")"

  while IFS='|' read -r partition_id assigned; do
    [ -n "${partition_id:-}" ] || continue
    running="$(docker ps --format '{{.Names}}' | grep -Ec "^$(container_name_for_map_partition "$map" "$partition_id")$" || true)"
    if [ -z "$assigned" ] && [ "$running" = "0" ]; then
      continue
    fi
    echo "DESPAWN disabled map=$map partition=$partition_id"
    runtime/scripts/despawn-server.sh "$partition_id" --force || true
  done <<< "$rows"
}

# Machine-readable roster for status reporting.  Emits:
#
#   concurrency <n>
#   map <MapName>
#
# Deliberately read-only.  It must NOT call require_postgres, canonical_map or
# ensure_state_file: ensure_state_file WRITES $STATE_FILE (it creates the file
# and runs the v1->v2 migration), and status.sh polls this every few seconds --
# a read path must never mutate runtime state.  For the same reason callers must
# not use `is-always-on` in a loop; each invocation is a docker exec plus python
# and writes state.
#
# The effective-mode downgrade is reproduced here without mode_for_map: only
# persisted "always-on" maps are selected, and that is never "disabled", so
# effective_mode_for_map's rule collapses to requires_fresh_process alone.
always_on_maps() {
  local map

  printf 'concurrency %s\n' "$MAX_WARMING_SERVERS"
  [ -s "$STATE_FILE" ] || return 0

  while read -r map; do
    [ -n "$map" ] || continue
    protected_map "$map" && continue
    requires_fresh_process "$map" && continue
    printf 'map %s\n' "$map"
  done < <(always_on_names_from_state 2>/dev/null || true)
}

# Shared by always_on_maps and reconcile_all: the persisted always-on names in
# startup-priority order.  Pure read of $STATE_FILE; a missing or corrupt file
# yields nothing rather than failing.
always_on_names_from_state() {
  python3 - "$STATE_FILE" "$STARTUP_PRIORITY" <<'PY'
import json
import sys
from pathlib import Path

# Emit LF regardless of platform: the shell callers read these with `read -r`,
# and a translated CRLF would leave a trailing CR on every name, silently
# defeating the protected_map / requires_fresh_process filters.
try:
    sys.stdout.reconfigure(newline="\n")
except Exception:
    pass

try:
    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
except Exception:
    data = {}
priority = [item.strip() for item in sys.argv[2].split(",") if item.strip()]
priority_index = {name: index for index, name in enumerate(priority)}
always_on = [
    map_name
    for map_name, cfg in data.get("maps", {}).items()
    if cfg.get("mode") == "always-on"
]
for map_name in sorted(always_on, key=lambda name: (priority_index.get(name, len(priority)), name)):
    print(map_name)
PY
}

reconcile_all() {
  local maps=() map

  require_postgres
  ensure_state_file
  while read -r map; do
    [ -n "$map" ] || continue
    protected_map "$map" && continue
    # The persisted candidate list can contain a mode retired by a newer
    # lifecycle policy.  Never reconcile it unless the effective policy still
    # agrees that it is Always On.
    [ "$(effective_mode_for_map "$map")" = "always-on" ] || continue
    maps+=("$map")
  done < <(always_on_names_from_state)

  reconcile_maps "${maps[@]}"
}

reconcile_selected() {
  local maps=() map

  if [ "$#" -eq 0 ]; then
    reconcile_all
    return
  fi

  require_postgres
  ensure_state_file
  for map in "$@"; do
    [ -n "$map" ] || continue
    map="$(canonical_map "$map")"
    protected_map "$map" && continue
    if [ "$(effective_mode_for_map "$map")" != "always-on" ]; then
      echo "SKIP always-on reconcile map=$map mode=$(effective_mode_for_map "$map")"
      continue
    fi
    maps+=("$map")
  done

  reconcile_maps "${maps[@]}"
}

with_reconcile_lock() {
  mkdir -p "$(dirname "$RECONCILE_LOCK_FILE")"
  exec 8>"$RECONCILE_LOCK_FILE"
  if ! flock -n 8; then
    echo "WAIT always-on reconcile already running"
    return 0
  fi
  reconcile_selected "$@"
}

dynamic_grace_remaining() {
  local map="$1"
  local changed now elapsed
  changed="$(last_change_epoch "$map")"
  [ -n "$changed" ] || { echo 0; return 0; }
  now="$(date +%s)"
  elapsed=$((now - changed))
  if [ "$elapsed" -lt "$GRACE_SECONDS" ]; then
    echo $((GRACE_SECONDS - elapsed))
  else
    echo 0
  fi
}

cmd="${1:-help}"
case "$cmd" in
  list) list_maps ;;
  mode) shift || true; show_mode "${1:-}" ;;
  set)
    if [ $# -ne 3 ]; then usage; exit 2; fi
    set_mode "$2" "$3"
    ;;
  reconcile) shift || true; with_reconcile_lock "$@" ;;
  is-always-on)
    map="$(canonical_map "${2:-}")"
    [ "$(effective_mode_for_map "$map")" = "always-on" ]
    ;;
  is-overmap-active)
    map="$(canonical_map "${2:-}")"
    [ "$(effective_mode_for_map "$map")" = "overmap-active" ]
    ;;
  is-disabled)
    map="$(canonical_map "${2:-}")"
    [ "$(effective_mode_for_map "$map")" = "disabled" ]
    ;;
  requires-fresh-process)
    map="$(canonical_map "${2:-}")"
    requires_fresh_process "$map"
    ;;
  grace-remaining)
    map="$(canonical_map "${2:-}")"
    dynamic_grace_remaining "$map"
    ;;
  always-on-maps) always_on_maps ;;
  help|--help|-h) usage ;;
  *) echo "Unknown maps command: $cmd"; usage; exit 2 ;;
esac
