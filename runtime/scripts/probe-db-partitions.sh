#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

echo "=== Tables/columns that look partition/map/server related ==="
docker exec dune-postgres psql -U postgres -d dune -Atc "
select table_schema || '.' || table_name || ' | ' || string_agg(column_name, ', ' order by ordinal_position)
from information_schema.columns
where table_schema not in ('pg_catalog','information_schema')
  and (
    lower(table_name) like '%partition%'
    or lower(table_name) like '%server%'
    or lower(table_name) like '%map%'
    or lower(column_name) like '%partition%'
    or lower(column_name) like '%server%'
    or lower(column_name) like '%map%'
  )
group by table_schema, table_name
order by table_schema, table_name;
"

echo
echo "=== Candidate table samples ==="
docker exec dune-postgres psql -U postgres -d dune -Atc "
select table_schema || '.' || table_name
from information_schema.tables
where table_schema not in ('pg_catalog','information_schema')
  and table_type='BASE TABLE'
order by table_schema, table_name;
" | while read -r tbl; do
  cols="$(docker exec dune-postgres psql -U postgres -d dune -Atc "
    select string_agg(column_name, ',')
    from information_schema.columns
    where table_schema = split_part('$tbl','.',1)
      and table_name = split_part('$tbl','.',2)
  ")"

  case "$cols" in
    *map*|*Map*|*partition*|*Partition*|*server*|*Server*)
      echo
      echo "--- $tbl ---"
      docker exec dune-postgres psql -U postgres -d dune -c "select * from $tbl limit 5;" || true
      ;;
  esac
done
