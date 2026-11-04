#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

test_root="$(mktemp -d)"
container="dune-event-partition-test-$$"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$test_root"
}
trap cleanup EXIT

docker run -d --rm --network none --name "$container" \
  -e POSTGRES_PASSWORD=local-test -e POSTGRES_DB=dune postgres:17-alpine >/dev/null
for _ in $(seq 1 60); do
  ready="$(docker logs "$container" 2>&1 | grep -c 'database system is ready to accept connections' || true)"
  if [ "$ready" -ge 2 ] && docker exec "$container" pg_isready -U postgres -d dune >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
query() {
  docker exec "$container" psql -X -U postgres -d dune -v ON_ERROR_STOP=1 -Atc "$1"
}
query 'create schema dune;
create table dune.world_partition (
 partition_id serial primary key, server_id text, map text not null,
 partition_definition jsonb, dimension_index integer, blocked boolean, label text
);
insert into dune.world_partition values
 (24, null, '\''CB_Overland_M_01'\'', '\''{}'\'', 0, false, null),
 (38, '\''keep-server'\'', '\''Custom_Map'\'', '\''{}'\'', 0, true, '\''Keep Me'\'');' >/dev/null

cat >"$test_root/catalog.json" <<'JSON'
[
 {"map":"CB_Overland_M_01","id":24,"dimension":0},
 {"map":"CB_Halloween_Event_Shipwreck_01","id":null,"dimension":0,"disable":false,"minX":0,"minY":0,"maxX":1,"maxY":1}
]
JSON
apply_catalog() {
  DUNE_RESERVED_PARTITION_IDS=39,40 python3 runtime/scripts/generate-world-partition-reconcile-sql.py \
    "$test_root/catalog.json" >"$test_root/reconcile.sql"
  docker exec -i "$container" psql -X -U postgres -d dune -v ON_ERROR_STOP=1 \
    <"$test_root/reconcile.sql" >/dev/null
}
apply_catalog
[ "$(query "select partition_id from dune.world_partition where map='CB_Halloween_Event_Shipwreck_01'")" = 41 ]
[ "$(query "select dimension_index || '|' || blocked || '|' || (partition_definition->'box'->>'max_x') from dune.world_partition where partition_id=41")" = '0|false|1' ]
[ "$(query "select server_id || '|' || blocked || '|' || label from dune.world_partition where partition_id=38")" = 'keep-server|true|Keep Me' ]
apply_catalog
[ "$(query 'select count(*) from dune.world_partition')" = 3 ]

# Existing/manual definitions survive, even if disabled, assigned or customized.
query "update dune.world_partition set server_id='event-server', blocked=true, label='Custom Event', partition_definition='{\"custom\":true}' where partition_id=41" >/dev/null
apply_catalog
[ "$(query "select server_id || '|' || blocked || '|' || label || '|' || (partition_definition->>'custom') from dune.world_partition where partition_id=41")" = 'event-server|true|Custom Event|true' ]

# Funcom later supplies a different canonical ID and box: preserve the existing
# dimension instead of duplicating it or breaking references to its current ID.
python3 - "$test_root/catalog.json" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1]); rows = json.loads(p.read_text())
rows[1].update(id=99, maxX=2)
p.write_text(json.dumps(rows))
PY
apply_catalog
[ "$(query "select count(*) from dune.world_partition where map='CB_Halloween_Event_Shipwreck_01'")" = 1 ]
[ "$(query "select label from dune.world_partition where partition_id=41")" = 'Custom Event' ]

# Asset removal stops adding new entries; additive reconcile keeps saved state.
python3 - "$test_root/catalog.json" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1]); p.write_text(json.dumps(json.loads(p.read_text())[:1]))
PY
apply_catalog
[ "$(query 'select count(*) from dune.world_partition')" = 3 ]

# A fresh/partially migrated database must allocate above native IDs inserted
# earlier in the same transaction, even when its serial sequence starts at 1.
query 'truncate dune.world_partition restart identity' >/dev/null
cat >"$test_root/catalog.json" <<'JSON'
[
 {"map":"CB_Overland_M_01","id":24,"dimension":0},
 {"map":"CB_Halloween_Event_Shipwreck_01","id":null,"dimension":0}
]
JSON
python3 runtime/scripts/generate-world-partition-reconcile-sql.py "$test_root/catalog.json" >"$test_root/fresh.sql"
docker exec -i "$container" psql -X -U postgres -d dune -v ON_ERROR_STOP=1 <"$test_root/fresh.sql" >/dev/null
[ "$(query "select partition_id from dune.world_partition where map='CB_Halloween_Event_Shipwreck_01'")" = 25 ]
echo 'PASS: event partition allocation, repeated reconcile, custom state and upstream takeover'
