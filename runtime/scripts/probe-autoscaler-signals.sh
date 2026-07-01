#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env
source runtime/scripts/runtime-env.sh

DIRECTOR_PORT="$(resolve_director_port)"

echo "=== Director HTTP quick probe ==="
for path in \
  / \
  /swagger \
  /swagger/index.html \
  /health \
  /metrics \
  /api \
  /api/status \
  /status \
  /servers \
  /serverstats \
  /farm \
  /farms \
  /partitions \
  /travel \
  /queues
do
  echo
  echo "--- GET http://127.0.0.1:${DIRECTOR_PORT}${path} ---"
  curl -fsS --max-time 3 "http://127.0.0.1:${DIRECTOR_PORT}${path}" 2>&1 | head -60 || true
done

echo
echo "=== Director recent log lines with route/API/travel/server/queue words ==="
docker logs dune-director 2>&1 \
  | grep -Ei "api|http|route|travel|queue|server|partition|spawn|scale|dedicated|director" \
  | tail -200 || true

echo
echo "=== DB tables likely related to travel/queues/sessions/server demand ==="
docker exec dune-postgres psql -U postgres -d dune -Atc "
select table_schema || '.' || table_name || ' | ' || string_agg(column_name, ', ' order by ordinal_position)
from information_schema.columns
where table_schema not in ('pg_catalog','information_schema')
  and (
    lower(table_name) like '%travel%'
    or lower(table_name) like '%queue%'
    or lower(table_name) like '%session%'
    or lower(table_name) like '%server%'
    or lower(table_name) like '%partition%'
    or lower(table_name) like '%transfer%'
    or lower(table_name) like '%instance%'
    or lower(table_name) like '%farm%'
    or lower(column_name) like '%travel%'
    or lower(column_name) like '%queue%'
    or lower(column_name) like '%session%'
    or lower(column_name) like '%server%'
    or lower(column_name) like '%partition%'
    or lower(column_name) like '%transfer%'
    or lower(column_name) like '%instance%'
    or lower(column_name) like '%farm%'
  )
group by table_schema, table_name
order by table_schema, table_name;
"

echo
echo "=== Candidate table samples ==="
for tbl in \
  dune.farm_state \
  dune.world_partition \
  dune.travel_return_info \
  dune.player_state \
  dune.encrypted_player_state \
  dune.active_server_ids \
  dune.spicefield_server_availability
do
  echo
  echo "--- $tbl ---"
  docker exec dune-postgres psql -U postgres -d dune -P pager=off -c "select * from $tbl limit 20;" || true
done
