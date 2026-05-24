#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"

BACKUP_DIR_DEFAULT="runtime/backups/db"
AUTO_STATE_FILE="runtime/generated/db-backup.env"
AUTO_SERVICE_FILE="/etc/systemd/system/dune-awakening-db-backup.service"
AUTO_TIMER_FILE="/etc/systemd/system/dune-awakening-db-backup.timer"

usage() {
  cat <<'EOF'
Usage:
  dune db backup
  dune db backup <output-dir>
  dune db list
  dune db status
  dune db health
  dune db import <backup-file>
  dune db restore <backup-file>
  dune db delete <backup-file-or-name>
  dune db delete --all
  dune db auto enable <hours> [retention-days]
  dune db auto disable
  dune db auto status
  dune db auto retention <days>
  dune db auto retention off

Backups are written as official-style .backup files with a .backup.yaml sidecar.
Import accepts official .backup files and older dune-db-*.dump or .sql backups.
Import requires confirmation and creates a pre-import backup first.
EOF
}

require_postgres() {
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-postgres; then
    echo "dune-postgres is not running."
    exit 1
  fi
}

config_value() {
  local file="$1"
  local key="$2"

  [ -f "$file" ] || return 1
  awk -F= -v key="$key" '
    $1 == key {
      value = substr($0, length(key) + 2)
      gsub(/^"/, "", value)
      gsub(/"$/, "", value)
      print value
      exit
    }
  ' "$file"
}

valid_backup_basename() {
  local name="$1"
  printf '%s' "$name" | grep -Eq '^dune-db-([a-z0-9][a-z0-9_-]*__)?[0-9]{8}-[0-9]{6}\.(dump|sql)$|^[a-z0-9][a-z0-9_-]*-[0-9]{8}-[0-9]{6}\.backup$'
}

backup_timestamp_from_name() {
  local name="$1"
  case "$name" in
    *.backup)
      printf '%s' "$name" | sed -E 's/^.*-([0-9]{8}-[0-9]{6})\.backup$/\1/'
      ;;
    *)
      printf '%s' "$name" | sed -E 's/^dune-db-([a-z0-9][a-z0-9_-]*__)?([0-9]{8}-[0-9]{6})\.(dump|sql)$/\2/'
      ;;
  esac
}

backup_scope_from_name() {
  local name="$1"
  if printf '%s' "$name" | grep -Eq '^dune-db-[a-z0-9][a-z0-9_-]*__[0-9]{8}-[0-9]{6}\.(dump|sql)$'; then
    printf '%s' "$name" | sed -E 's/^dune-db-([a-z0-9][a-z0-9_-]*)__[0-9]{8}-[0-9]{6}\.(dump|sql)$/\1/'
  elif printf '%s' "$name" | grep -Eq '^[a-z0-9][a-z0-9_-]*-[0-9]{8}-[0-9]{6}\.backup$'; then
    printf '%s' "$name" | sed -E 's/^([a-z0-9][a-z0-9_-]*)-[0-9]{8}-[0-9]{6}\.backup$/\1/'
  else
    echo "legacy"
  fi
}

backup_scope_slug() {
  local rows primary count secondary

  rows="$(docker exec dune-postgres psql -U postgres -d dune -At -F '|' -c "
    select distinct map
    from dune.world_partition
    where coalesce(server_id, '') <> ''
    order by map;
  " 2>/dev/null || true)"

  count="$(printf '%s\n' "$rows" | sed '/^$/d' | wc -l | tr -d '[:space:]')"
  if [ "${count:-0}" -le 0 ]; then
    echo "all_maps"
    return 0
  fi

  primary="$(printf '%s\n' "$rows" | sed -n '1p' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/_/g; s/__*/_/g; s/^_//; s/_$//')"
  [ -n "$primary" ] || primary="all_maps"

  case "$count" in
    1)
      echo "$primary"
      ;;
    2)
      secondary="$(printf '%s\n' "$rows" | sed -n '2p' | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/_/g; s/__*/_/g; s/^_//; s/_$//')"
      [ -n "$secondary" ] || secondary="map"
      echo "${primary}_and_${secondary}"
      ;;
    *)
      echo "${primary}_plus_$((count - 1))_more"
      ;;
  esac
}

backup_scope_maps() {
  docker exec dune-postgres psql -U postgres -d dune -At -F ',' -c "
    select string_agg(map, ',' order by map)
    from (
      select distinct map
      from dune.world_partition
      where coalesce(server_id, '') <> ''
    ) maps;
  " 2>/dev/null | tr -d '\r' || true
}

backup_dir_abs() {
  local dir="${1:-$BACKUP_DIR_DEFAULT}"
  mkdir -p "$dir"
  (cd "$dir" && pwd -P)
}

resolve_backup_name() {
  local input="$1"
  local backup_dir="${2:-$BACKUP_DIR_DEFAULT}"
  local backup_abs
  local input_dir
  local name
  local stem
  local matches=()

  if [ -z "$input" ]; then
    echo "Missing backup file."
    return 1
  fi

  backup_abs="$(backup_dir_abs "$backup_dir")"

  case "$input" in
    */*)
      input_dir="$(cd "$(dirname "$input")" 2>/dev/null && pwd -P || true)"
      if [ "$input_dir" != "$backup_abs" ]; then
        echo "Refusing to delete outside the database backup directory: $input"
        return 1
      fi
      name="$(basename "$input")"
      ;;
    *)
      name="$input"
      ;;
  esac

  if ! valid_backup_basename "$name"; then
    stem="${name%.*}"
    if [ "$stem" = "$name" ]; then
      while IFS= read -r candidate; do
        [ -n "$candidate" ] || continue
        if [ "${candidate%.*}" = "$name" ]; then
          matches+=("$candidate")
        fi
      done < <(iter_valid_backup_names "$backup_dir")
      case "${#matches[@]}" in
        1)
          printf '%s' "${matches[0]}"
          return 0
          ;;
        0)
          echo "Not a valid database backup file: $name"
          echo "Accepted: dune-db-<scope>__YYYYMMDD-HHMMSS.dump|sql or <artifact-id>-YYYYMMDD-HHMMSS.backup"
          return 1
          ;;
        *)
          echo "Backup name is ambiguous: $name"
          printf 'Matches:\n'
          printf '  %s\n' "${matches[@]}"
          return 1
          ;;
      esac
    fi
    echo "Not a valid database backup file: $name"
    echo "Accepted: dune-db-<scope>__YYYYMMDD-HHMMSS.dump|sql or <artifact-id>-YYYYMMDD-HHMMSS.backup"
    return 1
  fi

  printf '%s' "$name"
}

backup_path_for_name() {
  local name="$1"
  local backup_dir="${2:-$BACKUP_DIR_DEFAULT}"
  printf '%s/%s' "$backup_dir" "$name"
}

delete_backup_files_for_name() {
  local name="$1"
  local backup_dir="${2:-$BACKUP_DIR_DEFAULT}"
  local file
  local ts
  local scope
  local meta

  file="$(backup_path_for_name "$name" "$backup_dir")"
  ts="$(backup_timestamp_from_name "$name")"
  scope="$(backup_scope_from_name "$name")"
  meta="$backup_dir/dune-db-$scope""__""$ts.meta"

  if [ ! -f "$file" ]; then
    echo "Backup file does not exist: $file"
    return 1
  fi

  command rm -f -- "$file"
  [ -f "$file.yaml" ] && command rm -f -- "$file.yaml"
  [ -f "$meta" ] && command rm -f -- "$meta"
  return 0
}

iter_valid_backup_names() {
  local backup_dir="${1:-$BACKUP_DIR_DEFAULT}"

  [ -d "$backup_dir" ] || return 0

  find "$backup_dir" -maxdepth 1 -type f \( -name 'dune-db-*.dump' -o -name 'dune-db-*.sql' -o -name '*.backup' \) -printf '%f\n' \
    | while IFS= read -r name; do
        if valid_backup_basename "$name"; then
          printf '%s\n' "$name"
        fi
      done
}

backup_db() {
  local out_dir="${1:-$BACKUP_DIR_DEFAULT}"
  local ts
  local scope
  local scope_maps
  local artifact_id
  local backup_file
  local sidecar_file
  local tmp_file

  require_postgres
  mkdir -p "$out_dir"

  ts="$(date +%Y%m%d-%H%M%S)"
  scope="$(backup_scope_slug)"
  [ -n "$scope" ] || scope="all_maps"
  scope_maps="$(backup_scope_maps)"
  artifact_id="dune-db-$scope"
  backup_file="$out_dir/$artifact_id-$ts.backup"
  sidecar_file="$backup_file.yaml"
  tmp_file="/tmp/$artifact_id-$ts.backup"

  echo "Creating database backup..."
  docker exec dune-postgres pg_dump -U postgres -d dune -Fc -f "$tmp_file"
  docker cp "dune-postgres:$tmp_file" "$backup_file"
  docker exec dune-postgres rm -f "$tmp_file" >/dev/null 2>&1 || true

  {
    echo "artifact_id: $artifact_id"
    echo "backup_file: $(basename "$backup_file")"
    echo "created_at: $(date -Iseconds)"
    echo "database: dune"
    echo "format: pg_dump_custom"
    echo "scope: $scope"
    echo "maps: ${scope_maps:-unknown}"
    echo "server_title: $(config_value .env SERVER_TITLE || echo unknown)"
    echo "server_region: $(config_value .env SERVER_REGION || echo unknown)"
    echo "server_ip_mode: $(config_value .env SERVER_IP_MODE || echo unknown)"
    echo "battlegroup_id: $(config_value runtime/generated/battlegroup.env BATTLEGROUP_ID || echo unknown)"
  } > "$sidecar_file"

  chmod 600 "$backup_file" "$sidecar_file"

  echo "Backup written:"
  echo "  $backup_file"
  echo "Sidecar:"
  echo "  $sidecar_file"

  if [ "${DB_BACKUP_PRUNE_AFTER_SUCCESS:-0}" = "1" ]; then
    prune_old_db_backups "$out_dir" "${DB_AUTO_BACKUP_RETENTION_DAYS:-0}"
  fi
}

list_backups() {
  local out_dir="${1:-$BACKUP_DIR_DEFAULT}"

  echo "=== Database backups ==="
  if [ -d "$out_dir" ]; then
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      find "$out_dir/$name" -maxdepth 0 -type f -printf '%TY-%Tm-%Td %TH:%TM  %p\n' 2>/dev/null || true
    done < <(iter_valid_backup_names "$out_dir" | sort)
  else
    echo "No backup directory found: $out_dir"
  fi
}

delete_backup() {
  local target="${1:-}"
  local name
  local file

  if [ "$target" = "--all" ]; then
    delete_all_backups
    return
  fi

  name="$(resolve_backup_name "$target" "$BACKUP_DIR_DEFAULT")" || exit 1
  file="$(backup_path_for_name "$name" "$BACKUP_DIR_DEFAULT")"

  if [ ! -f "$file" ]; then
    echo "Backup file does not exist: $file"
    exit 1
  fi

  if [ "${DUNE_DB_ASSUME_YES:-0}" != "1" ]; then
    read -r -p "Delete backup '$name'? [y/N]: " answer
    case "$answer" in
      y|Y|yes|YES) ;;
      *) echo "Delete cancelled."; exit 1 ;;
    esac
  fi

  delete_backup_files_for_name "$name" "$BACKUP_DIR_DEFAULT"
  echo "Deleted backup: $name"
}

delete_all_backups() {
  local backup_dir="$BACKUP_DIR_DEFAULT"
  local names
  local count
  local deleted=0

  if [ ! -d "$backup_dir" ]; then
    echo "No backup directory found: $backup_dir"
    return 0
  fi

  names="$(iter_valid_backup_names "$backup_dir" | sort || true)"
  count="$(printf '%s\n' "$names" | sed '/^$/d' | wc -l | tr -d '[:space:]')"

  if [ "${count:-0}" -eq 0 ]; then
    echo "No database backups found in: $backup_dir"
    return 0
  fi

  echo "Backup directory: $backup_dir"
  echo "Database backups found: $count"
  if [ "${DUNE_DB_ASSUME_YES:-0}" != "1" ]; then
    read -r -p "Delete ALL database backups? Type DELETE to confirm: " answer
    if [ "$answer" != "DELETE" ]; then
      echo "Delete cancelled."
      exit 1
    fi
  fi

  while IFS= read -r name; do
    [ -n "$name" ] || continue
    delete_backup_files_for_name "$name" "$backup_dir"
    deleted=$((deleted + 1))
  done <<< "$names"

  echo "Deleted $deleted database backups."
}

prune_old_db_backups() {
  local backup_dir="${1:-$BACKUP_DIR_DEFAULT}"
  local days="${2:-0}"
  local removed=0
  local file

  if ! validate_positive_integer "$days" || [ "$days" -le 0 ]; then
    echo "Auto backup retention is off. Old backups were not deleted."
    return 0
  fi

  if [ ! -d "$backup_dir" ]; then
    return 0
  fi

  while IFS= read -r name; do
    [ -n "$name" ] || continue
    file="$(backup_path_for_name "$name" "$backup_dir")"
    if find "$file" -maxdepth 0 -type f -mtime +"$days" -print -quit 2>/dev/null | grep -q .; then
      delete_backup_files_for_name "$name" "$backup_dir"
      removed=$((removed + 1))
    fi
  done < <(iter_valid_backup_names "$backup_dir")

  if [ "$removed" -gt 0 ]; then
    echo "Removed $removed database backups older than $days days."
  else
    echo "No database backups older than $days days were removed."
  fi
}

status_db() {
  require_postgres

  echo "=== Database status ==="
  docker exec dune-postgres psql -U dune -d dune -c "
select current_database() as database, current_user as user;
"
  docker exec dune-postgres psql -U dune -d dune -c "
select count(*) as world_partition_rows from world_partition;
"
}

health_db() {
  require_postgres

  echo "=== Database health ==="
  docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -P pager=off -c "
with required_columns as (
  select 'dune'::text as table_schema, 'world_partition'::text as table_name, 'partition_id'::text as column_name
  union all select 'dune', 'world_partition', 'map'
  union all select 'dune', 'world_partition', 'dimension_index'
  union all select 'dune', 'world_partition', 'server_id'
  union all select 'dune', 'world_partition', 'blocked'
  union all select 'dune', 'world_partition', 'label'
),
column_health as (
  select
    rc.table_schema,
    rc.table_name,
    rc.column_name,
    exists (
      select 1
      from information_schema.columns c
      where c.table_schema = rc.table_schema
        and c.table_name = rc.table_name
        and c.column_name = rc.column_name
    ) as present
  from required_columns rc
),
summary as (
  select
    exists (
      select 1
      from information_schema.tables
      where table_schema = 'dune'
        and table_name = 'world_partition'
    ) as world_partition_exists,
    coalesce((select count(*) from dune.world_partition), 0) as world_partition_rows,
    coalesce((select count(*) from dune.world_partition where partition_id is null), 0) as null_partition_id_rows,
    coalesce((select count(*) from dune.world_partition where map is null or btrim(map) = ''), 0) as blank_map_rows,
    coalesce((select count(*) from dune.world_partition where dimension_index is null), 0) as null_dimension_rows,
    coalesce((select count(*) from dune.world_partition where partition_definition is null), 0) as null_partition_definition_rows,
    coalesce((
      select count(*)
      from (
        select partition_id
        from dune.world_partition
        group by partition_id
        having count(*) > 1
      ) dup
    ), 0) as duplicate_partition_ids,
    coalesce((
      select count(*)
      from (
        select map, dimension_index
        from dune.world_partition
        group by map, dimension_index
        having count(*) > 1
      ) dup
    ), 0) as duplicate_map_dimension_rows
),
overall as (
  select
    case
      when not summary.world_partition_exists then 'UNHEALTHY'
      when exists (select 1 from column_health where not present) then 'UNHEALTHY'
      when summary.world_partition_rows <= 0 then 'UNHEALTHY'
      when summary.null_partition_id_rows > 0 then 'UNHEALTHY'
      when summary.blank_map_rows > 0 then 'UNHEALTHY'
      when summary.null_dimension_rows > 0 then 'UNHEALTHY'
      when summary.null_partition_definition_rows > 0 then 'UNHEALTHY'
      when summary.duplicate_partition_ids > 0 then 'UNHEALTHY'
      when summary.duplicate_map_dimension_rows > 0 then 'UNHEALTHY'
      else 'HEALTHY'
    end as database_health
  from summary
)
select 'database_health' as check_name, database_health as result
from overall
union all
select 'world_partition_table', case when world_partition_exists then 'present' else 'missing' end
from summary
union all
select 'world_partition_rows', world_partition_rows::text
from summary
union all
select 'missing_required_columns', count(*)::text
from column_health
where not present
union all
select 'missing_column ' || column_name, 'missing'
from column_health
where not present
union all
select 'null_partition_id_rows', null_partition_id_rows::text
from summary
union all
select 'blank_map_rows', blank_map_rows::text
from summary
union all
select 'null_dimension_rows', null_dimension_rows::text
from summary
union all
select 'null_partition_definition_rows', null_partition_definition_rows::text
from summary
union all
select 'duplicate_partition_ids', duplicate_partition_ids::text
from summary
union all
select 'duplicate_map_dimension_rows', duplicate_map_dimension_rows::text
from summary
order by check_name;
"
}

stop_db_dependents() {
  echo "Stopping services that depend on the database..."
  docker ps --format '{{.Names}}' | grep '^dune-server-' | xargs -r docker rm -f || true
  docker rm -f dune-server-gateway dune-director dune-text-router 2>/dev/null || true
}

recreate_dune_database() {
  echo "Recreating dune database..."
  docker exec dune-postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "
select pg_terminate_backend(pid)
from pg_stat_activity
where datname = 'dune'
  and pid <> pg_backend_pid();
"
  docker exec dune-postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "drop database if exists dune;"
  docker exec dune-postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "create database dune owner dune;"
}

import_db() {
  local backup_file="${1:-}"
  local restore_after
  local tmp_file
  local ext

  if [ -z "$backup_file" ]; then
    usage
    exit 2
  fi

  if [ ! -f "$backup_file" ]; then
    echo "Backup file not found: $backup_file"
    exit 1
  fi

  case "$backup_file" in
    *.backup|*.dump|*.sql) ;;
    *)
      echo "Unsupported backup format: $backup_file"
      exit 1
      ;;
  esac

  require_postgres

  echo "WARNING: importing a database backup replaces current battlegroup database state."
  echo "A pre-import backup will be created first."
  if [ "${DUNE_DB_ASSUME_YES:-0}" != "1" ]; then
    read -r -p "Continue with import? [y/N]: " answer
    case "$answer" in
      y|Y|yes|YES) ;;
      *) echo "Import cancelled."; exit 1 ;;
    esac
  fi

  backup_db "$BACKUP_DIR_DEFAULT"
  stop_db_dependents
  recreate_dune_database

  ext="${backup_file##*.}"
  tmp_file="/tmp/dune-db-import-$(date +%Y%m%d-%H%M%S).$ext"
  docker cp "$backup_file" "dune-postgres:$tmp_file"

  echo "Restoring database..."
  case "$backup_file" in
    *.backup|*.dump)
      docker exec dune-postgres pg_restore -U postgres -d dune "$tmp_file"
      ;;
    *.sql)
      docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -f "$tmp_file"
      ;;
    *)
      docker exec dune-postgres rm -f "$tmp_file" >/dev/null 2>&1 || true
      echo "Unsupported backup format: $backup_file"
      exit 1
      ;;
  esac
  docker exec dune-postgres rm -f "$tmp_file" >/dev/null 2>&1 || true

  echo "Database import finished."
  read -r -p "Restart Dune stack now? [y/N]: " restore_after
  case "$restore_after" in
    y|Y|yes|YES) runtime/scripts/start-all.sh ;;
    *) echo "Services remain stopped. Start them with: dune start" ;;
  esac
}

validate_positive_integer() {
  local value="$1"
  printf '%s' "$value" | grep -Eq '^[1-9][0-9]*$'
}

can_manage_systemd_units() {
  [ -d /etc/systemd/system ] && [ -w /etc/systemd/system ]
}

load_auto_state() {
  DB_AUTO_BACKUP_ENABLED="${DB_AUTO_BACKUP_ENABLED:-0}"
  DB_AUTO_BACKUP_INTERVAL_HOURS="${DB_AUTO_BACKUP_INTERVAL_HOURS:-24}"
  DB_AUTO_BACKUP_RETENTION_DAYS="${DB_AUTO_BACKUP_RETENTION_DAYS:-0}"
  DB_AUTO_BACKUP_DIR="${DB_AUTO_BACKUP_DIR:-$BACKUP_DIR_DEFAULT}"

  if [ -f "$AUTO_STATE_FILE" ]; then
    # shellcheck disable=SC1090
    . "$AUTO_STATE_FILE"
  fi

  DB_AUTO_BACKUP_ENABLED="${DB_AUTO_BACKUP_ENABLED:-0}"
  DB_AUTO_BACKUP_INTERVAL_HOURS="${DB_AUTO_BACKUP_INTERVAL_HOURS:-24}"
  DB_AUTO_BACKUP_RETENTION_DAYS="${DB_AUTO_BACKUP_RETENTION_DAYS:-0}"
  DB_AUTO_BACKUP_DIR="${DB_AUTO_BACKUP_DIR:-$BACKUP_DIR_DEFAULT}"
}

write_auto_state() {
  local enabled="$1"
  local hours="$2"
  local retention_days="${3:-0}"
  local tmp_file

  mkdir -p runtime/generated
  tmp_file="${AUTO_STATE_FILE}.tmp.$$"
  cat > "$tmp_file" <<EOF
DB_AUTO_BACKUP_ENABLED=$enabled
DB_AUTO_BACKUP_INTERVAL_HOURS=$hours
DB_AUTO_BACKUP_RETENTION_DAYS=$retention_days
DB_AUTO_BACKUP_DIR=$BACKUP_DIR_DEFAULT
EOF
  chmod 600 "$tmp_file" 2>/dev/null || true
  mv -f "$tmp_file" "$AUTO_STATE_FILE"
}

validate_hours() {
  local hours="$1"
  validate_positive_integer "$hours"
}

auto_backup_enable() {
  local hours="${1:-}"
  local retention_days="${2:-}"

  if [ -z "$hours" ]; then
    echo "Missing backup interval."
    echo "Usage: dune db auto enable <hours>"
    exit 2
  fi

  if ! validate_hours "$hours"; then
    echo "Invalid interval: $hours"
    echo "Use a positive integer number of hours, for example:"
    echo "  dune db auto enable 6"
    exit 1
  fi

  load_auto_state

  if [ -n "$retention_days" ]; then
    if ! validate_positive_integer "$retention_days"; then
      echo "Invalid retention days: $retention_days"
      echo "Use a positive integer number of days, for example:"
      echo "  dune db auto enable 6 14"
      exit 1
    fi
  else
    retention_days="${DB_AUTO_BACKUP_RETENTION_DAYS:-0}"
  fi

  write_auto_state 1 "$hours" "$retention_days"

  if ! command -v systemctl >/dev/null 2>&1; then
    echo "Auto DB backup preference saved, but systemctl was not found."
    echo "Saved: $AUTO_STATE_FILE"
    return 0
  fi

  if ! can_manage_systemd_units; then
    echo "Auto DB backup preference saved, but this user cannot install systemd units."
    echo "Saved: $AUTO_STATE_FILE"
    echo "To install the timer, run this command with sudo/root:"
    echo "  runtime/scripts/dune db auto enable $hours${retention_days:+ $retention_days}"
    return 0
  fi

  cat > "$AUTO_SERVICE_FILE" <<EOF
[Unit]
Description=Dune Awakening battlegroup database backup
Wants=docker.service
After=network-online.target docker.service

[Service]
Type=oneshot
WorkingDirectory=$ROOT_DIR
Environment=DB_BACKUP_PRUNE_AFTER_SUCCESS=1
EnvironmentFile=$ROOT_DIR/runtime/generated/db-backup.env
ExecStart=$ROOT_DIR/runtime/scripts/dune db backup
EOF

  cat > "$AUTO_TIMER_FILE" <<EOF
[Unit]
Description=Run Dune Awakening battlegroup database backup

[Timer]
OnBootSec=15m
OnUnitActiveSec=${hours}h
Persistent=true
RandomizedDelaySec=10m
Unit=dune-awakening-db-backup.service

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now dune-awakening-db-backup.timer

  echo "Auto DB backups enabled."
  echo "Interval: every $hours hours"
  if [ "${retention_days:-0}" -gt 0 ] 2>/dev/null; then
    echo "Retention: keep backups from the last $retention_days days"
  else
    echo "Retention: off"
  fi
  echo "Timer: dune-awakening-db-backup.timer"
}

auto_backup_disable() {
  local hours
  local retention_days

  load_auto_state
  hours="${DB_AUTO_BACKUP_INTERVAL_HOURS:-24}"
  retention_days="${DB_AUTO_BACKUP_RETENTION_DAYS:-0}"

  write_auto_state 0 "$hours" "$retention_days"

  if command -v systemctl >/dev/null 2>&1 && can_manage_systemd_units; then
    systemctl disable --now dune-awakening-db-backup.timer >/dev/null 2>&1 || true
    rm -f "$AUTO_SERVICE_FILE" "$AUTO_TIMER_FILE"
    systemctl daemon-reload
  fi

  echo "Auto DB backups disabled."
}

auto_backup_status() {
  load_auto_state

  echo "=== Automatic database backups ==="
  if [ "${DB_AUTO_BACKUP_ENABLED:-0}" = "1" ]; then
    echo "Enabled:          true"
  else
    echo "Enabled:          false"
  fi
  echo "Interval hours:   ${DB_AUTO_BACKUP_INTERVAL_HOURS:-24}"
  if [ "${DB_AUTO_BACKUP_RETENTION_DAYS:-0}" -gt 0 ] 2>/dev/null; then
    echo "Retention:        ${DB_AUTO_BACKUP_RETENTION_DAYS} days"
  else
    echo "Retention:        off"
  fi
  echo "Backup directory: ${DB_AUTO_BACKUP_DIR:-$BACKUP_DIR_DEFAULT}"

  if command -v systemctl >/dev/null 2>&1; then
    echo
    if systemctl list-unit-files dune-awakening-db-backup.timer --no-legend --no-pager 2>/dev/null | grep -q '^dune-awakening-db-backup.timer'; then
      timer_enabled="$(systemctl is-enabled dune-awakening-db-backup.timer 2>/dev/null || true)"
      [ -n "$timer_enabled" ] && echo "Systemd timer:   $timer_enabled"
      systemctl list-timers --all dune-awakening-db-backup.timer --no-pager || true
    else
      echo "Systemd timer:   not installed"
    fi
  fi

  echo
  echo "=== Recent database backups ==="
  if [ -d "${DB_AUTO_BACKUP_DIR:-$BACKUP_DIR_DEFAULT}" ]; then
    find "${DB_AUTO_BACKUP_DIR:-$BACKUP_DIR_DEFAULT}" -maxdepth 1 -type f \( -name 'dune-db-*.dump' -o -name 'dune-db-*.sql' \) -printf '%TY-%Tm-%Td %TH:%TM  %p\n' | sort | tail -n 5 || true
  else
    echo "No backup directory found: ${DB_AUTO_BACKUP_DIR:-$BACKUP_DIR_DEFAULT}"
  fi
}

auto_backup_retention() {
  local value="${1:-}"

  load_auto_state

  case "$value" in
    "")
      echo "Missing retention value."
      echo "Usage: dune db auto retention <days>"
      echo "       dune db auto retention off"
      exit 2
      ;;
    off|OFF|0)
      write_auto_state "${DB_AUTO_BACKUP_ENABLED:-0}" "${DB_AUTO_BACKUP_INTERVAL_HOURS:-24}" 0
      echo "Auto backup retention disabled. Old backups will not be deleted automatically."
      ;;
    *)
      if ! validate_positive_integer "$value"; then
        echo "Invalid retention days: $value"
        echo "Use a positive integer number of days, or: dune db auto retention off"
        exit 1
      fi
      write_auto_state "${DB_AUTO_BACKUP_ENABLED:-0}" "${DB_AUTO_BACKUP_INTERVAL_HOURS:-24}" "$value"
      echo "Auto backup retention set to $value days."
      ;;
  esac
}

handle_auto_backup() {
  local sub="${1:-status}"

  case "$sub" in
    enable|on)
      auto_backup_enable "${2:-}" "${3:-}"
      ;;
    disable|off)
      auto_backup_disable
      ;;
    status)
      auto_backup_status
      ;;
    retention)
      auto_backup_retention "${2:-}"
      ;;
    *)
      echo "Unknown DB auto-backup command: $sub"
      echo "Usage:"
      echo "  dune db auto enable <hours>"
      echo "  dune db auto disable"
      echo "  dune db auto status"
      echo "  dune db auto retention <days>"
      echo "  dune db auto retention off"
      exit 2
      ;;
  esac
}

cmd="${1:-help}"

case "$cmd" in
  backup)
    backup_db "${2:-$BACKUP_DIR_DEFAULT}"
    ;;
  list)
    list_backups "${2:-$BACKUP_DIR_DEFAULT}"
    ;;
  status)
    status_db
    ;;
  health)
    health_db
    ;;
  import|restore)
    import_db "${2:-}"
    ;;
  delete)
    delete_backup "${2:-}"
    ;;
  auto)
    handle_auto_backup "${2:-status}" "${3:-}" "${4:-}"
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    echo "Unknown db command: $cmd"
    usage
    exit 2
    ;;
esac
