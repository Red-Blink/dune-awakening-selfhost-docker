#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

target="${1:-all}"

is_running() {
  local name="$1"
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$name"
}

heal_partition_ready() {
  local partition_id="$1"
  local map_name="$2"
  local container_name="$3"
  local ready_pattern="$4"
  local row server_id ready alive farm_id outgoing_s2s incoming_s2s

  is_running dune-postgres || return 0
  is_running "$container_name" || return 0

  row="$(
    docker exec dune-postgres psql -U postgres -d dune -At -F '|' -c "
      select coalesce(wp.server_id, ''),
             coalesce(fs.ready::text, 'f'),
             coalesce(fs.alive::text, 'f'),
             coalesce(fs.farm_id, ''),
             coalesce(fs.outgoing_s2s_connections, 0),
             coalesce(fs.incoming_s2s_connections, 0)
      from dune.world_partition wp
      left join dune.farm_state fs on fs.server_id = wp.server_id
      where wp.partition_id = ${partition_id}
      limit 1;
    " 2>/dev/null || true
  )"

  [ -n "$row" ] || return 0
  IFS='|' read -r server_id ready alive farm_id outgoing_s2s incoming_s2s <<< "$row"
  [ -n "${server_id:-}" ] || return 0

  if [ "$ready" = "t" ] || [ "$ready" = "true" ]; then
    return 0
  fi

  if ! docker logs "$container_name" 2>&1 | grep -Eq "$ready_pattern"; then
    # Recent dedicated-server builds do not always emit or persist the old
    # READY marker for Survival_1, even after the farm row is fully connected.
    # Treat assigned, alive core partitions with both S2S directions as ready.
    if { [ "$alive" = "t" ] || [ "$alive" = "true" ]; } \
      && [ -n "$farm_id" ] \
      && [ "${outgoing_s2s:-0}" -gt 0 ] 2>/dev/null \
      && [ "${incoming_s2s:-0}" -gt 0 ] 2>/dev/null; then
      :
    else
      return 0
    fi
  fi

  docker exec dune-postgres psql -U postgres -d dune -qAt -c "
    update dune.farm_state
    set ready = true,
        alive = true
    where server_id = '${server_id//\'/\'\'}'
      and map = '${map_name//\'/\'\'}';
  " >/dev/null 2>&1 || true
}

case "$target" in
  all)
    heal_partition_ready 1 "Survival_1" "dune-server-survival-1" 'Server farm is READY .*partition 1'
    heal_partition_ready 2 "Overmap" "dune-server-overmap" 'Server farm is READY .*partition 2'
    ;;
  1|Survival_1|survival|survival-1|survival_1)
    heal_partition_ready 1 "Survival_1" "dune-server-survival-1" 'Server farm is READY .*partition 1'
    ;;
  2|Overmap|overmap)
    heal_partition_ready 2 "Overmap" "dune-server-overmap" 'Server farm is READY .*partition 2'
    ;;
  *)
    echo "Unknown core map target: $target" >&2
    exit 1
    ;;
esac
