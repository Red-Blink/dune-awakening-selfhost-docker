#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

usage() {
  cat <<'EOF'
Usage:
  dune despawn <map-name|partition-id|container-name>

Examples:
  dune despawn SH_Arrakeen
  dune despawn 23
  dune despawn dune-server-sh-arrakeen-23
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ $# -lt 1 ]; then
  usage
  exit 0
fi

TARGET="$1"

case "${TARGET,,}" in
  overmap|dune-server-overmap)
    echo "Refusing to despawn always-on server: dune-server-overmap"
    echo "Use dune restart/stop for always-on services."
    exit 1
    ;;
  survival|survival-1|dune-server-survival-1)
    echo "Refusing to despawn always-on server: dune-server-survival-1"
    echo "Use dune restart/stop for always-on services."
    exit 1
    ;;
esac

psql_value() {
  docker exec dune-postgres psql -U postgres -d dune -Atc "$1"
}

container_from_partition() {
  local partition_id="$1"
  local row map safe_name
  row="$(psql_value "
    select map || '|' || partition_id
    from dune.world_partition
    where partition_id = $partition_id
    limit 1;
  ")"

  if [ -z "$row" ]; then
    return 1
  fi

  IFS='|' read -r map partition <<< "$row"
  safe_name="$(echo "$map-$partition" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')"
  echo "dune-server-$safe_name"
}

container_from_map() {
  local map="$1"
  local safe_map rows row partition safe_name container

  rows="$(docker exec dune-postgres psql -U postgres -d dune -Atc "
    select partition_id
    from dune.world_partition
    where lower(map) = lower('${map//\'/\'\'}')
    order by partition_id;
  ")"

  if [ -z "$rows" ]; then
    return 1
  fi

  while read -r partition; do
    [ -z "$partition" ] && continue
    safe_name="$(echo "$map-$partition" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')"
    container="dune-server-$safe_name"
    if docker ps -a --format '{{.Names}}' | grep -qx "$container"; then
      echo "$container"
      return 0
    fi
  done <<< "$rows"

  return 1
}

if docker ps -a --format '{{.Names}}' | grep -qx "$TARGET"; then
  CONTAINER="$TARGET"
elif [[ "$TARGET" =~ ^[0-9]+$ ]]; then
  CONTAINER="$(container_from_partition "$TARGET" || true)"
else
  CONTAINER="$(container_from_map "$TARGET" || true)"
fi

if [ -z "${CONTAINER:-}" ]; then
  echo "Could not find a matching spawned container for: $TARGET"
  echo
  echo "Currently known Dune server containers:"
  docker ps -a --filter "name=dune-server-" --format "  {{.Names}} - {{.Status}}"
  exit 1
fi

case "$CONTAINER" in
  dune-server-survival-1|dune-server-overmap)
    echo "Refusing to despawn always-on server: $CONTAINER"
    echo "Use dune restart/stop for always-on services."
    exit 1
    ;;
esac

PARTITION_ID=""
if [[ "$CONTAINER" =~ -([0-9]+)$ ]]; then
  PARTITION_ID="${BASH_REMATCH[1]}"
fi

SERVER_ID=""
if [ -n "$PARTITION_ID" ]; then
  SERVER_ID="$(psql_value "select coalesce(server_id, '') from dune.world_partition where partition_id = $PARTITION_ID limit 1;")"
fi

echo "Despawning: $CONTAINER"
docker rm -f "$CONTAINER"

if [ -n "$SERVER_ID" ]; then
  echo
  echo "Cleaning DB assignment for server_id: $SERVER_ID"
  docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
begin;

update dune.world_partition
set server_id = null
where server_id = '$SERVER_ID';

delete from dune.farm_state
where server_id = '$SERVER_ID';

commit;
"
fi

echo
echo "Remaining Dune server containers:"
docker ps -a --filter "name=dune-server-" --format "table {{.Names}}\t{{.Status}}"
