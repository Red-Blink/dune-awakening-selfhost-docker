#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

if ! docker ps --format '{{.Names}}' | grep -qx dune-postgres; then
  echo "dune-postgres is not running."
  exit 1
fi

echo "=== Dune server partitions ==="
docker exec dune-postgres psql -U postgres -d dune -P pager=off -c "
select
  wp.partition_id,
  wp.map,
  wp.dimension_index as dim,
  wp.label,
  case
    when coalesce(wp.server_id, '') = '' then ''
    else wp.server_id
  end as assigned_server,
  coalesce(fs.game_port::text, '') as game_port,
  coalesce(fs.igw_port::text, '') as igw_port,
  coalesce(fs.ready::text, '') as ready,
  coalesce(fs.alive::text, '') as alive
from dune.world_partition wp
left join dune.farm_state fs on fs.server_id = wp.server_id
order by wp.partition_id;
"

echo
echo "=== Map summary ==="
docker exec dune-postgres psql -U postgres -d dune -P pager=off -c "
select
  wp.map,
  count(*) as partitions,
  min(wp.partition_id) as first_id,
  max(wp.partition_id) as last_id,
  count(nullif(wp.server_id, '')) as assigned
from dune.world_partition wp
group by wp.map
order by min(wp.partition_id);
"
