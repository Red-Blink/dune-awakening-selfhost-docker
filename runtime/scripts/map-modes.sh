#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

STATE_FILE="${DUNE_MAP_MODES_FILE:-runtime/generated/map-runtime-modes.json}"
GRACE_SECONDS="${DUNE_AUTOSCALER_DESPAWN_GRACE_SECONDS:-${DUNE_AUTOSCALER_IDLE_SECONDS:-300}}"

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

Survival_1 and Overmap are protected always-on maps and are not configurable here.
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

canonical_map() {
  local input="$1"
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-postgres; then
    printf '%s' "$input"
    return 0
  fi
  docker exec dune-postgres psql -U postgres -d dune -At -v ON_ERROR_STOP=1 -c "
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
    python3 - "$STATE_FILE" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

path = Path(sys.argv[1])
payload = {
    "version": 1,
    "updated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "maps": {},
}
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
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

  ensure_state_file
  python3 - "$STATE_FILE" "$canonical" "$mode" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

path = Path(sys.argv[1])
target = sys.argv[2]
mode = sys.argv[3]
try:
    data = json.loads(path.read_text(encoding="utf-8"))
except Exception:
    data = {}
data["version"] = 1
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
  else
    echo "Map remains running if already active. It is eligible for normal despawn after ${GRACE_SECONDS}s."
  fi
}

list_maps() {
  require_postgres
  ensure_state_file
  docker exec dune-postgres psql -U postgres -d dune -At -F '|' -c "
    select
      wp.map,
      count(*) as partitions,
      count(nullif(wp.server_id, '')) as assigned
    from dune.world_partition wp
    where wp.map not in ('Survival_1', 'Overmap')
    group by wp.map
    order by min(wp.partition_id);
  " | while IFS='|' read -r map partitions assigned; do
    [ -n "${map:-}" ] || continue
    printf '%-28s Current: %-14s Partitions: %-3s Assigned: %s\n' "$map" "$(mode_for_map "$map")" "$partitions" "$assigned"
  done
}

show_mode() {
  local map="${1:-}"
  if [ -z "$map" ]; then
    list_maps
    return 0
  fi
  map="$(canonical_map "$map")"
  printf '%s\t%s\n' "$map" "$(mode_for_map "$map")"
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

adopt_live_unassigned_server() {
  local map="$1"
  local partition_id="$2"

  docker exec dune-postgres psql -U postgres -d dune -At -v ON_ERROR_STOP=1 -c "
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

  docker exec dune-postgres psql -U postgres -d dune -At -c "
    select coalesce(server_id, '')
    from dune.world_partition
    where partition_id = $partition_id
    limit 1;
  " 2>/dev/null | tr -d '\r[:space:]' || true
}

reconcile_map() {
  local map="$1"
  local rows assigned running container age adopted

  require_postgres
  rows="$(docker exec dune-postgres psql -U postgres -d dune -At -F '|' -c "
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
      runtime/scripts/spawn-server.sh "$partition_id" --force
      continue
    fi
    echo "SPAWN always-on map=$map partition=$partition_id"
    runtime/scripts/spawn-server.sh "$partition_id"
  done <<< "$rows"
}

despawn_map() {
  local map="$1"
  local rows partition_id assigned running

  require_postgres
  rows="$(docker exec dune-postgres psql -U postgres -d dune -At -F '|' -c "
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

reconcile_all() {
  require_postgres
  ensure_state_file
  python3 - "$STATE_FILE" <<'PY' | while read -r map; do
import json
import sys
from pathlib import Path

try:
    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
except Exception:
    data = {}
for map_name, cfg in sorted(data.get("maps", {}).items()):
    if cfg.get("mode") == "always-on":
        print(map_name)
PY
    [ -n "$map" ] || continue
    protected_map "$map" && continue
    reconcile_map "$map"
  done
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
  reconcile) reconcile_all ;;
  is-always-on)
    map="$(canonical_map "${2:-}")"
    [ "$(mode_for_map "$map")" = "always-on" ]
    ;;
  is-overmap-active)
    map="$(canonical_map "${2:-}")"
    [ "$(mode_for_map "$map")" = "overmap-active" ]
    ;;
  is-disabled)
    map="$(canonical_map "${2:-}")"
    [ "$(mode_for_map "$map")" = "disabled" ]
    ;;
  grace-remaining)
    map="$(canonical_map "${2:-}")"
    dynamic_grace_remaining "$map"
    ;;
  help|--help|-h) usage ;;
  *) echo "Unknown maps command: $cmd"; usage; exit 2 ;;
esac
