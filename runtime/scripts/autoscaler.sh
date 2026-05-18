#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

INTERVAL="${DUNE_AUTOSCALER_INTERVAL:-5}"
SINCE="${DUNE_AUTOSCALER_LOG_SINCE:-30s}"
IDLE_SECONDS="${DUNE_AUTOSCALER_IDLE_SECONDS:-300}"
STATE_FILE="${DUNE_AUTOSCALER_STATE_FILE:-runtime/generated/autoscaler-idle.tsv}"

mkdir -p "$(dirname "$STATE_FILE")"
touch "$STATE_FILE"

echo "=== Dune Docker autoscaler ==="
echo "Watching Director travel queues and idle dynamic servers."
echo "Interval: ${INTERVAL}s"
echo "Log window: ${SINCE}"
echo "Idle despawn grace: ${IDLE_SECONDS}s"
echo "State file: ${STATE_FILE}"
echo

if ! docker ps --format '{{.Names}}' | grep -qx dune-director; then
  echo "dune-director is not running."
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx dune-postgres; then
  echo "dune-postgres is not running."
  exit 1
fi

psql_value() {
  docker exec dune-postgres psql -U postgres -d dune -Atc "$1"
}

map_exists() {
  local map="$1"
  local safe
  safe="$(printf '%s' "$map" | tr -cd 'A-Za-z0-9_')"

  [ "$(psql_value "select count(*) from dune.world_partition where lower(map) = lower('$safe');")" != "0" ]
}

map_assigned_count() {
  local map="$1"
  local safe
  safe="$(printf '%s' "$map" | tr -cd 'A-Za-z0-9_')"

  psql_value "
    select count(*)
    from dune.world_partition
    where lower(map) = lower('$safe')
      and coalesce(server_id, '') <> '';
  "
}

container_count_for_map() {
  local map="$1"
  local safe
  safe="$(echo "$map" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')"

  docker ps --format '{{.Names}}' | grep -Ec "^dune-server-${safe}-[0-9]+$" || true
}

state_key() {
  local map="$1"
  local server_id="$2"
  printf '%s|%s' "$map" "$server_id"
}

get_idle_since() {
  local key="$1"
  awk -F '\t' -v key="$key" '$1 == key { print $2; found=1; exit } END { if (!found) exit 1 }' "$STATE_FILE"
}

set_idle_since() {
  local key="$1"
  local ts="$2"
  local tmp
  tmp="$(mktemp)"

  awk -F '\t' -v key="$key" '$1 != key { print }' "$STATE_FILE" > "$tmp"
  printf '%s\t%s\n' "$key" "$ts" >> "$tmp"
  mv "$tmp" "$STATE_FILE"
}

clear_idle_since() {
  local key="$1"
  local tmp
  tmp="$(mktemp)"

  awk -F '\t' -v key="$key" '$1 != key { print }' "$STATE_FILE" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

handle_demand() {
  local map="$1"
  local num="$2"

  case "$map" in
    Survival_1|Overmap)
      return 0
      ;;
  esac

  if ! map_exists "$map"; then
    echo "WARN unknown map from Director travel queue: $map"
    return 0
  fi

  local assigned
  assigned="$(map_assigned_count "$map")"

  local running
  running="$(container_count_for_map "$map")"

  if [ "$assigned" != "0" ] || [ "$running" != "0" ]; then
    echo "OK   demand map=$map num=$num already running/assigned assigned=$assigned containers=$running"
    return 0
  fi

  echo "SPAWN demand map=$map num=$num"
  runtime/scripts/spawn-server.sh "$map" || {
    echo "ERROR failed to spawn $map"
    return 0
  }
}

handle_idle_row() {
  local map="$1"
  local server_id="$2"
  local connected_players="$3"
  local ready="$4"
  local alive="$5"

  case "$map" in
    Survival_1|Overmap)
      return 0
      ;;
  esac

  local key
  key="$(state_key "$map" "$server_id")"

  if [ "$connected_players" != "0" ] || [ "$ready" != "t" ] || [ "$alive" != "t" ]; then
    clear_idle_since "$key"
    return 0
  fi

  local now since age
  now="$(date +%s)"

  if since="$(get_idle_since "$key" 2>/dev/null)"; then
    age=$((now - since))
  else
    since="$now"
    age=0
    set_idle_since "$key" "$since"
    echo "IDLE map=$map server=$server_id players=0 grace=${IDLE_SECONDS}s"
  fi

  if [ "$age" -ge "$IDLE_SECONDS" ]; then
    echo "DESPAWN idle map=$map server=$server_id idle=${age}s"
    runtime/scripts/despawn-server.sh "$map" || true
    clear_idle_since "$key"
  fi
}

scan_idle_servers() {
  docker exec dune-postgres psql -U postgres -d dune -At -F '|' -c "
    select
      map,
      server_id,
      connected_players,
      ready,
      alive
    from dune.farm_state
    where map not in ('Survival_1', 'Overmap')
      and coalesce(server_id, '') <> ''
    order by map;
  " | while IFS='|' read -r map server_id connected_players ready alive; do
    [ -z "${map:-}" ] && continue
    handle_idle_row "$map" "$server_id" "$connected_players" "$ready" "$alive"
  done
}

scan_travel_demand() {
  docker logs --since "$SINCE" dune-director 2>&1 \
    | python3 -c '
import re
import sys

pattern = re.compile(
    r"Processing travel queue for ClassicalInstancing group ([A-Za-z0-9_]+) "
    r"\(servers: \[[^\]]*\], num: ([0-9]+)\)"
)

seen = set()

for line in sys.stdin:
    match = pattern.search(line)
    if not match:
        continue

    map_name = match.group(1)
    num = int(match.group(2))

    if num <= 0:
        continue

    key = (map_name, num)
    if key in seen:
        continue

    seen.add(key)
    print(f"{map_name}|{num}")
' \
    | while IFS='|' read -r map num; do
        handle_demand "$map" "$num"
      done
}

while true; do
  scan_travel_demand
  scan_idle_servers
  sleep "$INTERVAL"
done
