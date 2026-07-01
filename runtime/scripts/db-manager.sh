#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env
source runtime/scripts/runtime-env.sh

PG_CONTAINER="${DUNE_PG_CONTAINER:-dune-postgres}"
PG_USER="${DUNE_DB_USER:-dune}"
PG_PASSWORD="${DUNE_DB_PASSWORD:-dune}"
PG_DB="${DUNE_DB_NAME:-}"
PG_PORT="${DUNE_DB_PORT:-$(resolve_postgres_port)}"
EXPORT_DIR="runtime/generated/db-exports"

usage() {
  cat <<'EOF'
Usage:
  runtime/scripts/db-manager.sh
  runtime/scripts/db-manager.sh status
  runtime/scripts/db-manager.sh schemas
  runtime/scripts/db-manager.sh tables [schema]
  runtime/scripts/db-manager.sh counts [schema]
  runtime/scripts/db-manager.sh columns <schema.table>
  runtime/scripts/db-manager.sh preview <schema.table> [limit] [offset]
  runtime/scripts/db-manager.sh sql <query>
  runtime/scripts/db-manager.sh export <query>
EOF
}

has_container() {
  docker exec "$PG_CONTAINER" true >/dev/null 2>&1
}

detect_db() {
  local db
  if [ -n "$PG_DB" ]; then
    printf '%s' "$PG_DB"
    return 0
  fi
  if has_container; then
    for db in dune postgres; do
      if docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" psql -U "$PG_USER" -d "$db" -Atc "select 1;" >/dev/null 2>&1; then
        printf '%s' "$db"
        return 0
      fi
    done
  else
    for db in dune postgres; do
      if PGPASSWORD="$PG_PASSWORD" psql -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d "$db" -Atc "select 1;" >/dev/null 2>&1; then
        printf '%s' "$db"
        return 0
      fi
    done
  fi
  return 1
}

psql_run() {
  local db="$1"
  shift
  if has_container; then
    docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" psql -U "$PG_USER" -d "$db" "$@"
  else
    PGPASSWORD="$PG_PASSWORD" psql -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d "$db" "$@"
  fi
}

pg_dump_backup() {
  local db="$1"
  local out
  mkdir -p runtime/backups/db
  out="runtime/backups/db/manual-db-manager-$(date +%Y%m%d-%H%M%S).dump"
  if has_container; then
    docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$db" -Fc > "$out"
  else
    PGPASSWORD="$PG_PASSWORD" pg_dump -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d "$db" -Fc > "$out"
  fi
  echo "$out"
}

sql_is_destructive() {
  printf '%s' "$1" | tr '\n' ' ' | grep -Eiq '(^|[[:space:];])(delete|truncate|drop|alter|create|update[[:space:]][^;]*($|;))[[:space:]]'
}

sql_update_without_where() {
  printf '%s' "$1" | tr '\n' ' ' | grep -Eiq '(^|[[:space:];])update[[:space:]]' && ! printf '%s' "$1" | tr '\n' ' ' | grep -Eiq '[[:space:]]where[[:space:]]'
}

confirm_destructive() {
  local sql="$1" answer db="$2"
  if sql_is_destructive "$sql" || sql_update_without_where "$sql"; then
    echo "This SQL may change or destroy data/schema."
    echo "A database backup will be created before running it."
    read -r -p "Type RUN DESTRUCTIVE SQL to continue: " answer
    [ "$answer" = "RUN DESTRUCTIVE SQL" ] || { echo "Cancelled."; return 1; }
    echo "Backup: $(pg_dump_backup "$db")"
  fi
}

quote_ident_pair() {
  local value="$1"
  if ! printf '%s' "$value" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*[.][A-Za-z_][A-Za-z0-9_]*$'; then
    echo "Expected schema.table using identifier characters only." >&2
    return 1
  fi
  printf '%s' "$value"
}

cmd_status() {
  local db
  db="$(detect_db)" || { echo "Could not connect to PostgreSQL as $PG_USER."; return 1; }
  psql_run "$db" -Atc "select current_user || '|' || current_database();" | awk -F '|' '{ printf "Connected to PostgreSQL as %s.\nDatabase: %s\n", $1, $2 }'
}

cmd_schemas() {
  local db
  db="$(detect_db)" || { echo "Could not connect to PostgreSQL as $PG_USER."; return 1; }
  psql_run "$db" -P pager=off -c "select schema_name from information_schema.schemata order by schema_name;"
}

cmd_tables() {
  local schema="${1:-dune}" db
  db="$(detect_db)" || { echo "Could not connect to PostgreSQL as $PG_USER."; return 1; }
  psql_run "$db" -P pager=off -c "select table_schema, table_name from information_schema.tables where table_type='BASE TABLE' and table_schema='${schema//\'/\'\'}' order by table_name;"
}

cmd_counts() {
  local schema="${1:-dune}" db
  db="$(detect_db)" || { echo "Could not connect to PostgreSQL as $PG_USER."; return 1; }
  psql_run "$db" -P pager=off -c "
    select table_schema, table_name,
      (xpath('/row/c/text()', query_to_xml(format('select count(*) c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint as row_count
    from information_schema.tables
    where table_type='BASE TABLE' and table_schema='${schema//\'/\'\'}'
    order by table_name;"
}

cmd_columns() {
  local table db schema name
  table="$(quote_ident_pair "${1:-}")" || return 1
  schema="${table%%.*}"
  name="${table#*.}"
  db="$(detect_db)" || { echo "Could not connect to PostgreSQL as $PG_USER."; return 1; }
  psql_run "$db" -P pager=off -c "select column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema='$schema' and table_name='$name' order by ordinal_position;"
}

cmd_preview() {
  local table limit="${2:-25}" offset="${3:-0}" db
  table="$(quote_ident_pair "${1:-}")" || return 1
  [[ "$limit" =~ ^[0-9]+$ ]] || { echo "Limit must be numeric." >&2; return 1; }
  [[ "$offset" =~ ^[0-9]+$ ]] || { echo "Offset must be numeric." >&2; return 1; }
  db="$(detect_db)" || { echo "Could not connect to PostgreSQL as $PG_USER."; return 1; }
  psql_run "$db" -P pager=off -c "select * from $table limit $limit offset $offset;"
}

cmd_sql() {
  local sql="${1:-}" db
  [ -n "$sql" ] || { echo "SQL is required." >&2; return 1; }
  db="$(detect_db)" || { echo "Could not connect to PostgreSQL as $PG_USER."; return 1; }
  confirm_destructive "$sql" "$db" || return 1
  psql_run "$db" -P pager=off -v ON_ERROR_STOP=1 -c "$sql"
}

cmd_export() {
  local sql="${1:-}" db out
  [ -n "$sql" ] || { echo "SQL is required." >&2; return 1; }
  db="$(detect_db)" || { echo "Could not connect to PostgreSQL as $PG_USER."; return 1; }
  mkdir -p "$EXPORT_DIR"
  out="$EXPORT_DIR/query-$(date +%Y%m%d-%H%M%S).csv"
  psql_run "$db" -v ON_ERROR_STOP=1 -c "\\copy ($sql) to stdout with csv header" > "$out"
  echo "Exported CSV: $out"
}

interactive() {
  local choice table limit offset sql schema db
  cmd_status || return 1
  while true; do
    echo
    echo "Database Management"
    echo "1) List schemas"
    echo "2) List tables"
    echo "3) Show table row counts"
    echo "4) Inspect table columns/types"
    echo "5) Preview rows"
    echo "6) Run custom SQL"
    echo "7) Export query to CSV"
    echo "0) Back"
    read -r -p "Selection: " choice
    case "$choice" in
      1) cmd_schemas || true ;;
      2) read -r -p "Schema [dune]: " schema; cmd_tables "${schema:-dune}" || true ;;
      3) read -r -p "Schema [dune]: " schema; cmd_counts "${schema:-dune}" || true ;;
      4) read -r -p "Table (schema.table): " table; cmd_columns "$table" || true ;;
      5) read -r -p "Table (schema.table): " table; read -r -p "Limit [25]: " limit; read -r -p "Offset [0]: " offset; cmd_preview "$table" "${limit:-25}" "${offset:-0}" || true ;;
      6) read -r -p "SQL: " sql; cmd_sql "$sql" || true ;;
      7) read -r -p "SELECT SQL: " sql; cmd_export "$sql" || true ;;
      0|"") return 0 ;;
      *) echo "Unknown selection." ;;
    esac
  done
}

case "${1:-}" in
  -h|--help|help) usage ;;
  ""|menu) interactive ;;
  status) cmd_status ;;
  schemas) cmd_schemas ;;
  tables) shift; cmd_tables "${1:-dune}" ;;
  counts) shift; cmd_counts "${1:-dune}" ;;
  columns) shift; cmd_columns "${1:-}" ;;
  preview) shift; cmd_preview "${1:-}" "${2:-25}" "${3:-0}" ;;
  sql) shift; cmd_sql "$*" ;;
  export) shift; cmd_export "$*" ;;
  *) usage >&2; exit 2 ;;
esac
