#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
PORT_RESERVATION_FILE="runtime/generated/spawn-port-reservations.tsv"
PORT_LOCK_FILE="runtime/generated/spawn-port-reservations.lock"
# shellcheck source=runtime/scripts/landsraad-instance-cleanup.sh
source runtime/scripts/landsraad-instance-cleanup.sh

usage() {
  cat <<'EOF'
Usage:
  dune despawn <map-name|partition-id|container-name> [--force]

Examples:
  dune despawn SH_Arrakeen
  dune despawn 23
  dune despawn dune-server-sh-arrakeen-23

A map name despawns every running dimension of that map. A partition ID or
container name despawns only that specific dimension.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ $# -lt 1 ]; then
  usage
  exit 0
fi

TARGET="$1"
FORCE=0
shift || true
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) echo "Unknown option: $arg"; usage; exit 2 ;;
  esac
done

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

container_name_for_map_partition() {
  local map="$1"
  local partition_id="$2"
  local safe_name

  safe_name="$(echo "$map-$partition_id" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')"
  printf 'dune-server-%s\n' "$safe_name"
}

rebuild_port_reservation_file() {
  local output_path="$1"
  local rows partition_id map game_port igw_port container_name

  : >"$output_path"
  rows="$(docker exec dune-postgres psql -U postgres -d dune -At -F '|' -c "
    select
      wp.partition_id,
      wp.map,
      coalesce(fs.game_port::text, ''),
      coalesce(fs.igw_port::text, '')
    from dune.world_partition wp
    left join dune.farm_state fs on fs.server_id = wp.server_id
    where coalesce(wp.server_id, '') <> ''
      and coalesce(fs.game_port::text, '') <> ''
      and coalesce(fs.igw_port::text, '') <> ''
    order by wp.partition_id;
  " 2>/dev/null || true)"

  [ -n "$rows" ] || return 0

  while IFS='|' read -r partition_id map game_port igw_port; do
    [ -n "${partition_id:-}" ] || continue
    [ -n "${map:-}" ] || continue
    [ -n "${game_port:-}" ] || continue
    [ -n "${igw_port:-}" ] || continue
    container_name="$(container_name_for_map_partition "$map" "$partition_id")"
    printf '%s\t%s\t%s\n' "$container_name" "$game_port" "$igw_port" >>"$output_path"
  done <<< "$rows"
}

ensure_runtime_state_file() {
  local path="$1"
  local label="$2"
  local dir base tmp

  dir="$(dirname "$path")"
  base="$(basename "$path")"
  mkdir -p "$dir"

  if [ ! -e "$path" ]; then
    umask 0002
    : >"$path"
    chmod 664 "$path" 2>/dev/null || true
    return 0
  fi

  if [ -r "$path" ] && [ -w "$path" ]; then
    chmod 664 "$path" 2>/dev/null || true
    return 0
  fi

  tmp="$(mktemp "$dir/.${base}.tmp.XXXXXX")"
  chmod 664 "$tmp" 2>/dev/null || true

  if [ -r "$path" ]; then
    cat "$path" >"$tmp"
  else
    rebuild_port_reservation_file "$tmp"
  fi

  mv -f "$tmp" "$path"
  chmod 664 "$path" 2>/dev/null || true
}

release_port_reservation() {
  local container_name="$1"
  local tmp

  [ -f "$PORT_RESERVATION_FILE" ] || return 0
  tmp="$(mktemp)"
  awk -F '\t' -v target="$container_name" '$1 != target { print }' "$PORT_RESERVATION_FILE" >"$tmp"
  mv "$tmp" "$PORT_RESERVATION_FILE"
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

containers_from_map() {
  local map="$1"
  local rows partition safe_name container known_containers found=0

  rows="$(docker exec dune-postgres psql -U postgres -d dune -Atc "
    select partition_id
    from dune.world_partition
    where lower(map) = lower('${map//\'/\'\'}')
    order by partition_id;
  ")"

  if [ -z "$rows" ]; then
    return 1
  fi

  known_containers="$(docker ps -a --format '{{.Names}}')"
  while read -r partition; do
    [ -z "$partition" ] && continue
    safe_name="$(echo "$map-$partition" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')"
    container="dune-server-$safe_name"
    if grep -qx "$container" <<<"$known_containers"; then
      echo "$container"
      found=1
    fi
  done <<< "$rows"

  [ "$found" = "1" ]
}

declare -a CONTAINERS=()
if docker ps -a --format '{{.Names}}' | grep -qx "$TARGET"; then
  CONTAINERS=("$TARGET")
elif [[ "$TARGET" =~ ^[0-9]+$ ]]; then
  CONTAINER="$(container_from_partition "$TARGET" || true)"
  [ -n "$CONTAINER" ] && CONTAINERS=("$CONTAINER")
else
  mapfile -t CONTAINERS < <(containers_from_map "$TARGET" || true)
fi

if [ "${#CONTAINERS[@]}" -eq 0 ]; then
  echo "Could not find a matching spawned container for: $TARGET"
  echo
  echo "Currently known Dune server containers:"
  docker ps -a --filter "name=dune-server-" --format "  {{.Names}} - {{.Status}}"
  exit 1
fi

despawn_container() {
  local container="$1"
  local container_map="" partition_from_name="" partition_id="" server_id=""

  case "$container" in
    dune-server-survival-1|dune-server-overmap)
      echo "Refusing to despawn always-on server: $container"
      echo "Use dune restart/stop for always-on services."
      return 1
      ;;
  esac

  if [[ "$container" =~ ^dune-server-(.*)-([0-9]+)$ ]]; then
    partition_from_name="${BASH_REMATCH[2]}"
    container_map="$(psql_value "select coalesce(map, '') from dune.world_partition where partition_id = $partition_from_name limit 1;")"
    partition_id="$partition_from_name"
  fi

  if [ -n "$container_map" ] && [ "$FORCE" != "1" ] && runtime/scripts/map-modes.sh is-always-on "$container_map" >/dev/null 2>&1; then
    echo "Refusing to despawn Always On map: $container_map"
    echo "Set it back to Dynamic first, or rerun with --force. The autoscaler will respawn Always On maps."
    return 1
  fi

  if [ -n "$partition_id" ]; then
    server_id="$(psql_value "select coalesce(server_id, '') from dune.world_partition where partition_id = $partition_id limit 1;")"
  fi

  echo "Despawning: $container"
  docker rm -f "$container"
  ensure_runtime_state_file "$PORT_LOCK_FILE" "spawn port reservation lock"
  exec 9>"$PORT_LOCK_FILE"
  flock 9
  ensure_runtime_state_file "$PORT_RESERVATION_FILE" "spawn port reservation state"
  release_port_reservation "$container"

  if [ -n "$server_id" ]; then
    echo
    echo "Cleaning DB assignment for server_id: $server_id"
    docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
begin;

update dune.world_partition
set server_id = null
where server_id = '$server_id';

delete from dune.farm_state
where server_id = '$server_id';

commit;
"
  fi

  cleanup_landsraad_instance_after_shutdown "$container_map" "$partition_id"

  if [ "$container_map" = "Survival_1" ]; then
    runtime/scripts/sietches.sh sync >/dev/null 2>&1 || true
    runtime/scripts/publish-sietch-overrides.sh once >/dev/null 2>&1 || true
  fi
}

if [ "${#CONTAINERS[@]}" -gt 1 ]; then
  echo "Despawning all ${#CONTAINERS[@]} running dimensions for map: $TARGET"
fi

for CONTAINER in "${CONTAINERS[@]}"; do
  despawn_container "$CONTAINER"
done

echo
echo "Remaining Dune server containers:"
docker ps -a --filter "name=dune-server-" --format "table {{.Names}}\t{{.Status}}"
