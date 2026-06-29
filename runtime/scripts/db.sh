#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"
HOST_ROOT_DIR="${DUNE_HOST_REPO_ROOT:-$ROOT_DIR}"

BACKUP_DIR_DEFAULT="runtime/backups/db"
AUTO_STATE_FILE="runtime/generated/db-backup.env"
AUTO_SERVICE_FILE="/etc/systemd/system/dune-awakening-db-backup.service"
AUTO_TIMER_FILE="/etc/systemd/system/dune-awakening-db-backup.timer"
PENDING_TRANSFER_FILE="runtime/generated/pending-character-transfers.tsv"
BATTLEGROUP_RESTORE_FILE="runtime/generated/battlegroup-restore-point.env"

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
  dune db restore <backup-file> --transfer OLD=NEW
  dune db restore <backup-file> --transfer-file <plan.tsv>
  dune db transfer OLD_FLS_ID NEW_FLS_ID
  dune db transfer --dry-run OLD_FLS_ID NEW_FLS_ID
  dune db transfer --yes OLD_FLS_ID NEW_FLS_ID
  dune db transfer --file <plan.tsv> [--dry-run]
  dune db transfer pending
  dune db transfer apply-pending
  dune db transfer clear-pending
  dune db delete <backup-file-or-name>
  dune db delete --all
  dune db auto enable <HH:MM> [retention-days] [interval-hours]
  dune db auto disable
  dune db auto status
  dune db auto retention <days>
  dune db auto retention off

Backups are written as official-style .backup files with a .backup.yaml sidecar.
Import accepts official .backup files and older dune-db-*.dump or .sql backups.
Import requires confirmation and creates a pre-import backup first.
EOF
}

redact_fls() {
  local value="$1"
  local len
  len="${#value}"
  if [ "$len" -le 10 ]; then
    printf '<redacted:%s>' "$len"
  else
    printf '%s...%s' "${value:0:4}" "${value: -4}"
  fi
}

token_payload_value() {
  local token="$1"
  local key="$2"

  TOKEN="$token" TOKEN_KEY="$key" python3 - <<'PY'
import base64
import json
import os
import sys

token = os.environ.get("TOKEN", "").strip()
key = os.environ.get("TOKEN_KEY", "").strip()
parts = token.split(".")
if len(parts) < 2 or not key:
    sys.exit(1)

payload = parts[1] + "=" * (-len(parts[1]) % 4)
try:
    data = json.loads(base64.urlsafe_b64decode(payload.encode()).decode())
except Exception:
    sys.exit(1)

value = data.get(key) or data.get(key[:1].lower() + key[1:])
if value is None:
    sys.exit(1)
print(value)
PY
}

battlegroup_host_id() {
  local battlegroup_id="$1"
  case "$battlegroup_id" in
    sh-*-*) printf '%s\n' "$battlegroup_id" | sed -E 's/^sh-([A-Za-z0-9]+)-.*$/\1/' ;;
    *) return 1 ;;
  esac
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

backup_metadata_value() {
  local backup_file="$1"
  local key="$2"
  local sidecar="${backup_file}.yaml"
  local value=""

  [ -r "$sidecar" ] || return 1
  value="$(awk -F': *' -v key="$key" '
    $1 == key {
      value = substr($0, length($1) + 2)
      sub(/^ */, "", value)
      print value
      exit
    }
  ' "$sidecar")"

  if [ -n "$value" ]; then
    printf '%s\n' "$value"
    return 0
  fi

  case "$key" in
    battlegroup_id|imported_from_battlegroup_id)
      backup_metadata_funcom_battlegroup_id "$sidecar"
      return 0
      ;;
  esac

  return 0
}

backup_metadata_funcom_battlegroup_id() {
  local sidecar="$1"

  awk '
    function clean(value) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (value ~ /^".*"$/ || value ~ /^'\''.*'\''$/) value = substr(value, 2, length(value) - 2)
      return value
    }
    function emit_candidate(value) {
      value = clean(value)
      if (value ~ /^funcom-seabass-sh-[A-Za-z0-9]+-[A-Za-z0-9]+$/) {
        sub(/^funcom-seabass-/, "", value)
      }
      if (value ~ /^sh-[A-Za-z0-9]+-[A-Za-z0-9]+$/) {
        print value
        exit
      }
    }
    /^[A-Za-z0-9_.-]+:/ {
      section = $1
      sub(/:.*/, "", section)
      next
    }
    section == "metadata" && /^  name:[[:space:]]*/ {
      value = $0
      sub(/^  name:[[:space:]]*/, "", value)
      emit_candidate(value)
    }
    section == "metadata" && /^  namespace:[[:space:]]*/ {
      value = $0
      sub(/^  namespace:[[:space:]]*/, "", value)
      emit_candidate(value)
    }
    section == "spec" && /^  name:[[:space:]]*/ {
      value = $0
      sub(/^  name:[[:space:]]*/, "", value)
      emit_candidate(value)
    }
    match($0, /sh-[A-Za-z0-9]+-[A-Za-z0-9]+/) {
      print substr($0, RSTART, RLENGTH)
      exit
    }
  ' "$sidecar"
}

current_battlegroup_id() {
  config_value runtime/generated/battlegroup.env BATTLEGROUP_ID || true
}

backup_is_external() {
  local backup_file="$1"
  local origin=""
  local imported_from=""

  origin="$(backup_metadata_value "$backup_file" backup_origin || true)"
  [ -n "$origin" ] || origin="$(backup_metadata_value "$backup_file" origin || true)"
  imported_from="$(backup_metadata_value "$backup_file" imported_from_battlegroup_id || true)"

  case "$(printf '%s' "$origin" | tr '[:upper:]' '[:lower:]')" in
    external|imported) return 0 ;;
  esac

  [ -n "$imported_from" ] && [ "$imported_from" != "unknown" ]
}

backup_is_automatic() {
  local backup_file="$1"
  local origin=""

  origin="$(backup_metadata_value "$backup_file" backup_origin || true)"
  [ -n "$origin" ] || origin="$(backup_metadata_value "$backup_file" origin || true)"

  case "$(printf '%s' "$origin" | tr '[:upper:]' '[:lower:]')" in
    automatic|scheduled) return 0 ;;
  esac

  return 1
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
    echo "backup_origin: ${DB_BACKUP_ORIGIN:-manual}"
    echo "database: dune"
    echo "format: pg_dump_custom"
    echo "scope: $scope"
    echo "maps: ${scope_maps:-unknown}"
    echo "server_title: $(config_value .env SERVER_TITLE || echo unknown)"
    echo "server_region: $(config_value .env SERVER_REGION || echo unknown)"
    echo "server_ip_mode: $(config_value .env SERVER_IP_MODE || echo unknown)"
    echo "battlegroup_id: $(config_value runtime/generated/battlegroup.env BATTLEGROUP_ID || echo unknown)"
  } > "$sidecar_file"

  chmod 600 "$backup_file"
  chmod 644 "$sidecar_file"

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
      find "$out_dir/$name" -maxdepth 0 -type f -printf '%TY-%Tm-%Td %TH:%TM:%TS  %p\n' 2>/dev/null | sed -E 's/([0-9]{2}:[0-9]{2}:[0-9]{2})\.[0-9]+/\1/' || true
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
  local minutes
  local removed=0
  local file

  if ! validate_positive_integer "$days" || [ "$days" -le 0 ]; then
    echo "Auto backup retention is off. Old backups were not deleted."
    return 0
  fi

  if [ ! -d "$backup_dir" ]; then
    return 0
  fi

  minutes=$((days * 24 * 60))

  while IFS= read -r name; do
    [ -n "$name" ] || continue
    file="$(backup_path_for_name "$name" "$backup_dir")"
    backup_is_automatic "$file" || continue
    if find "$file" -maxdepth 0 -type f -mmin +"$minutes" -print -quit 2>/dev/null | grep -q .; then
      delete_backup_files_for_name "$name" "$backup_dir"
      removed=$((removed + 1))
    fi
  done < <(iter_valid_backup_names "$backup_dir")

  if [ "$removed" -gt 0 ]; then
    echo "Removed $removed automatic database backups older than $days days."
  else
    echo "No automatic database backups older than $days days were removed."
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

capture_current_account_identities() {
  local snapshot
  snapshot="runtime/generated/pre-restore-account-identities-$(date +%Y%m%d-%H%M%S).tsv"
  mkdir -p "$(dirname "$snapshot")"

  docker exec dune-postgres psql -U postgres -d dune -At -F $'\t' -c "
    select
      coalesce(e.\"user\", ''),
      coalesce(e.platform_id, ''),
      coalesce(e.platform_name, ''),
      coalesce(dune.decrypt_user_data(e.encrypted_funcom_id), '')
    from dune.encrypted_accounts e
    where coalesce(e.\"user\", '') <> ''
      and coalesce(e.platform_id, '') <> ''
    order by e.platform_id, e.id;
  " > "$snapshot"
  chmod 600 "$snapshot" 2>/dev/null || true

  if [ -s "$snapshot" ]; then
    echo "Captured current Docker account identities for automatic restore relink: $snapshot" >&2
    printf '%s' "$snapshot"
  else
    rm -f "$snapshot"
    echo "No current Docker account identities found for automatic restore relink." >&2
    printf ''
  fi
}

adopt_backup_battlegroup_id() {
  local backup_file="$1"
  local backup_battlegroup_id=""
  local current_id=""
  local server_title=""
  local server_region=""
  local server_ip=""
  local server_ip_mode=""
  local ts

  backup_battlegroup_id="$(backup_metadata_value "$backup_file" imported_from_battlegroup_id || true)"
  [ -n "$backup_battlegroup_id" ] || backup_battlegroup_id="$(backup_metadata_value "$backup_file" battlegroup_id || true)"
  current_id="$(current_battlegroup_id)"

  if [ -z "$backup_battlegroup_id" ] || [ "$backup_battlegroup_id" = "unknown" ]; then
    echo "Adopt backup battlegroup: backup metadata has no usable battlegroup ID."
    return 0
  fi
  if [ -z "$current_id" ] || [ "$current_id" = "unknown" ]; then
    echo "Adopt backup battlegroup: current Docker battlegroup ID is not available."
    return 0
  fi
  if [ "$backup_battlegroup_id" = "$current_id" ]; then
    echo "Adopt backup battlegroup: Docker already uses $backup_battlegroup_id."
    return 0
  fi

  mkdir -p runtime/generated
  ts="$(date -Iseconds)"
  {
    printf 'PREVIOUS_BATTLEGROUP_ID=%q\n' "$current_id"
    printf 'ADOPTED_BATTLEGROUP_ID=%q\n' "$backup_battlegroup_id"
    printf 'ADOPTED_AT=%q\n' "$ts"
    printf 'BACKUP_FILE=%q\n' "$(basename "$backup_file")"
  } > "$BATTLEGROUP_RESTORE_FILE"
  chmod 664 "$BATTLEGROUP_RESTORE_FILE" 2>/dev/null || true

  server_title="$(config_value runtime/generated/battlegroup.env SERVER_TITLE || true)"
  server_region="$(config_value runtime/generated/battlegroup.env SERVER_REGION || true)"
  server_ip="$(config_value runtime/generated/battlegroup.env SERVER_IP || true)"
  server_ip_mode="$(config_value runtime/generated/battlegroup.env SERVER_IP_MODE || true)"

  {
    printf 'BATTLEGROUP_ID=%q\n' "$backup_battlegroup_id"
    [ -n "$server_title" ] && printf 'SERVER_TITLE=%q\n' "$server_title"
    [ -n "$server_region" ] && printf 'SERVER_REGION=%q\n' "$server_region"
    [ -n "$server_ip" ] && printf 'SERVER_IP=%q\n' "$server_ip"
    [ -n "$server_ip_mode" ] && printf 'SERVER_IP_MODE=%q\n' "$server_ip_mode"
  } > runtime/generated/battlegroup.env
  chmod 664 runtime/generated/battlegroup.env 2>/dev/null || true

  echo "Adopt backup battlegroup: $current_id -> $backup_battlegroup_id"
  echo "Battlegroup rollback point saved: $BATTLEGROUP_RESTORE_FILE"
}

auto_relink_restored_accounts() {
  local snapshot="${1:-}"
  local container_snapshot="/tmp/dune-pre-restore-account-identities.tsv"

  if [ -z "$snapshot" ] || [ ! -s "$snapshot" ]; then
    echo "Automatic account relink: no pre-restore Docker identities were captured."
    return 0
  fi

  echo "Automatic account relink: matching restored accounts by Steam ID, then Funcom display ID."
  docker cp "$snapshot" "dune-postgres:$container_snapshot"
  docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 <<SQL
create temp table current_docker_identity (
  current_user text,
  platform_id text,
  platform_name text,
  funcom_id text
) on commit drop;
\\copy current_docker_identity from '$container_snapshot' with (format text, delimiter E'\\t', null '')

create temp table unique_current_platform as
select min(current_user) as current_user, platform_id, min(platform_name) as platform_name, min(funcom_id) as funcom_id
from current_docker_identity
where coalesce(current_user, '') <> ''
  and coalesce(platform_id, '') <> ''
group by platform_id
having count(distinct current_user) = 1;

create temp table unique_current_funcom as
select min(current_user) as current_user, lower(funcom_id) as funcom_key, min(platform_name) as platform_name, min(funcom_id) as funcom_id
from current_docker_identity
where coalesce(current_user, '') <> ''
  and coalesce(funcom_id, '') <> ''
group by lower(funcom_id)
having count(distinct current_user) = 1;

create temp table account_relink_candidates (
  id bigint,
  old_user text,
  new_user text,
  platform_id text,
  new_platform_name text,
  new_funcom_id text,
  match_type text
) on commit drop;

insert into account_relink_candidates
select
  e.id,
  e."user" as old_user,
  c.current_user as new_user,
  e.platform_id,
  c.platform_name as new_platform_name,
  c.funcom_id as new_funcom_id,
  'steam_id' as match_type
from dune.encrypted_accounts e
join unique_current_platform c on c.platform_id = e.platform_id
where coalesce(e."user", '') <> ''
  and e."user" <> c.current_user;

insert into account_relink_candidates
select
  e.id,
  e."user" as old_user,
  c.current_user as new_user,
  e.platform_id,
  c.platform_name as new_platform_name,
  c.funcom_id as new_funcom_id,
  'funcom_display_id' as match_type
from dune.encrypted_accounts e
join unique_current_funcom c on c.funcom_key = lower(dune.decrypt_user_data(e.encrypted_funcom_id))
where coalesce(e."user", '') <> ''
  and e."user" <> c.current_user
  and not exists (
    select 1
    from account_relink_candidates existing
    where existing.id = e.id
  );

do \$\$
declare
  conflict_count integer;
  relink_count integer;
begin
  select count(*)
  into conflict_count
  from account_relink_candidates c
  where exists (
    select 1
    from dune.encrypted_accounts e2
    where e2."user" = c.new_user
      and e2.id <> c.id
  );

  if conflict_count > 0 then
    raise notice 'Automatic account relink skipped % account(s) because the target current FLS ID already exists in the restored database.', conflict_count;
  end if;

  for conflict_count in
    select count(*) from account_relink_candidates where match_type = 'steam_id'
  loop
    raise notice 'Automatic account relink Steam ID matches=%', conflict_count;
  end loop;

  for conflict_count in
    select count(*) from account_relink_candidates where match_type = 'funcom_display_id'
  loop
    raise notice 'Automatic account relink Funcom display ID fallback matches=%', conflict_count;
  end loop;

  update dune.encrypted_accounts e
  set
    "user" = c.new_user,
    encrypted_funcom_id = case
      when coalesce(c.new_funcom_id, '') <> '' then dune.encrypt_user_data(c.new_funcom_id)
      else e.encrypted_funcom_id
    end,
    platform_name = coalesce(nullif(c.new_platform_name, ''), e.platform_name)
  from account_relink_candidates c
  where e.id = c.id
    and not exists (
      select 1
      from dune.encrypted_accounts e2
      where e2."user" = c.new_user
        and e2.id <> c.id
    );

  get diagnostics relink_count = row_count;
  raise notice 'Automatic account relink complete. Relinked accounts=%', relink_count;
end
\$\$;
SQL
  docker exec dune-postgres rm -f "$container_snapshot" >/dev/null 2>&1 || true
}

detect_funcom_token_battlegroup_mismatch() {
  local logs=""
  local attempt
  local auth_pattern='ACCESS_DENIED|AccessDenied|access denied|Invalid Authorization to manage SelfHosted Battlegroup|invalid authorization|Unauthorized|HTTP[^[:cntrl:]]*(401|403)|status[^[:cntrl:]]*(401|403)|statusCode[^[:cntrl:]]*(401|403)|response[^[:cntrl:]]*(401|403)|code[^[:cntrl:]]*(401|403)'
  local funcom_context_pattern='Battlegroup|SelfHosted|Funcom|FuncomLiveServices'
  local previous_battlegroup=""
  local adopted_battlegroup=""
  local token=""
  local token_host=""
  local adopted_host=""

  previous_battlegroup="$(config_value "$BATTLEGROUP_RESTORE_FILE" PREVIOUS_BATTLEGROUP_ID 2>/dev/null || true)"
  adopted_battlegroup="$(config_value "$BATTLEGROUP_RESTORE_FILE" ADOPTED_BATTLEGROUP_ID 2>/dev/null || true)"
  if [ -n "$previous_battlegroup" ] && [ -n "$adopted_battlegroup" ] && [ "$previous_battlegroup" != "$adopted_battlegroup" ]; then
    token="$(tr -d '\r\n' < runtime/secrets/funcom-token.txt 2>/dev/null || true)"
    token_host="$(token_payload_value "$token" HostId 2>/dev/null || true)"
    adopted_host="$(battlegroup_host_id "$adopted_battlegroup" 2>/dev/null || true)"

    if [ -n "$token_host" ] && [ -n "$adopted_host" ] && [ "$(printf '%s' "$token_host" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$adopted_host" | tr '[:upper:]' '[:lower:]')" ]; then
      echo "Attention Required: Funcom token mismatch detected."
      echo "Current token HostId: $token_host"
      echo "Restored Battlegroup ID: $adopted_battlegroup"
      echo "Please update your Funcom token to the one used by the restored Battlegroup ID from Server Controls."
      return 1
    fi

    echo "Notice: Restored backup adopted a different Battlegroup ID."
    echo "Previous Docker Battlegroup ID: $previous_battlegroup"
    echo "Restored Battlegroup ID: $adopted_battlegroup"
    echo "Current token HostId matches the restored Battlegroup prefix. Continuing unless Funcom returns an authorization error."
  fi

  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    logs="$(
      {
        docker logs --since 10m dune-director 2>&1 || true
        docker logs --since 10m dune-server-gateway 2>&1 || true
      }
    )"

    if grep -Eiq "$auth_pattern" <<< "$logs" && grep -Eiq "$funcom_context_pattern" <<< "$logs"; then
      echo "Funcom authorization log match:"
      grep -Ei "$auth_pattern|$funcom_context_pattern" <<< "$logs" | tail -20 || true
      echo "Attention Required: Funcom token mismatch detected. Please update your token to match the one used with the previous Battlegroup ID from the Server Controls."
      return 1
    fi

    [ "$attempt" -eq 12 ] || sleep 10
  done

  return 0
}

import_db() {
  local backup_file="${1:-}"
  local backup_name
  local restore_after
  local identity_snapshot=""
  local tmp_file
  local ext
  shift || true
  local transfer_args=()
  local transfer_plan=""
  local transfer_file=""
  local arg

  while [ "$#" -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --transfer)
        [ -n "${2:-}" ] || { echo "Missing value for --transfer OLD=NEW"; exit 2; }
        transfer_args+=("${2}")
        shift 2
        ;;
      --transfer-file)
        [ -n "${2:-}" ] || { echo "Missing value for --transfer-file"; exit 2; }
        transfer_file="$2"
        shift 2
        ;;
      --adopt-backup-battlegroup)
        echo "--adopt-backup-battlegroup is no longer needed. External backup restores adopt the backup battlegroup automatically when needed."
        shift
        ;;
      *)
        echo "Unknown import/restore option: $arg"
        exit 2
        ;;
    esac
  done

  if [ -z "$backup_file" ]; then
    usage
    exit 2
  fi

  case "$backup_file" in
    */*) ;;
    *)
      backup_name="$(resolve_backup_name "$backup_file" "$BACKUP_DIR_DEFAULT")" || exit 1
      backup_file="$(backup_path_for_name "$backup_name" "$BACKUP_DIR_DEFAULT")"
      ;;
  esac

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
  identity_snapshot="$(capture_current_account_identities)"

  echo "WARNING: importing a database backup replaces current battlegroup database state."
  echo "A pre-import backup will be created first."
  echo "Do not create new characters after restore/import until character data is verified."
  echo "Character transfer is only for players whose FLS/Funcom account changed."
  if [ "${DUNE_DB_ASSUME_YES:-0}" != "1" ]; then
    read -r -p "Continue with import? [y/N]: " answer
    case "$answer" in
      y|Y|yes|YES) ;;
      *) echo "Import cancelled."; exit 1 ;;
    esac
  fi

  DB_BACKUP_ORIGIN=restore-safety backup_db "$BACKUP_DIR_DEFAULT"
  if backup_is_external "$backup_file"; then
    adopt_backup_battlegroup_id "$backup_file"
  fi

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

  adapt_imported_battlegroup "$backup_file"
  auto_relink_restored_accounts "$identity_snapshot"

  echo "Database import finished."

  if [ "${#transfer_args[@]}" -gt 0 ] || [ -n "$transfer_file" ]; then
    mkdir -p runtime/generated
    transfer_plan="runtime/generated/import-transfer-plan-$(date +%Y%m%d-%H%M%S).tsv"
    : > "$transfer_plan"
    for pair in "${transfer_args[@]}"; do
      case "$pair" in
        *=*) printf '%s\t%s\t%s\n' "${pair%%=*}" "${pair#*=}" "restore/import --transfer" >> "$transfer_plan" ;;
        *) echo "Invalid --transfer value, expected OLD=NEW: $pair"; exit 2 ;;
      esac
    done
    if [ -n "$transfer_file" ]; then
      if [ ! -f "$transfer_file" ]; then
        echo "Transfer file not found: $transfer_file"
        exit 1
      fi
      cat "$transfer_file" >> "$transfer_plan"
    fi
    echo
    echo "Applying post-import character transfer plan..."
    DUNE_DB_ASSUME_YES=1 runtime/scripts/db.sh transfer --file "$transfer_plan" --yes --no-backup || {
      echo "Post-import transfer plan did not fully apply."
      echo "Missing new-account rows, if any, were saved to: $PENDING_TRANSFER_FILE"
    }
  fi

  if [ "${DUNE_DB_ASSUME_YES:-0}" = "1" ]; then
    echo "Restarting Dune stack..."
    runtime/scripts/start-all.sh
    echo "Dune stack restart completed."
    detect_funcom_token_battlegroup_mismatch
  else
    read -r -p "Restart Dune stack now? [y/N]: " restore_after
    case "$restore_after" in
      y|Y|yes|YES) runtime/scripts/start-all.sh; echo "Dune stack restart completed."; detect_funcom_token_battlegroup_mismatch ;;
      *) echo "Services remain stopped. Start them with: dune start" ;;
    esac
  fi
}

adapt_imported_battlegroup() {
  local backup_file="$1"
  local old_battlegroup_id=""
  local new_battlegroup_id=""

  old_battlegroup_id="$(backup_metadata_value "$backup_file" imported_from_battlegroup_id || true)"
  [ -n "$old_battlegroup_id" ] || old_battlegroup_id="$(backup_metadata_value "$backup_file" battlegroup_id || true)"
  new_battlegroup_id="$(current_battlegroup_id)"

  if [ -z "$old_battlegroup_id" ] || [ "$old_battlegroup_id" = "unknown" ]; then
    echo "Battlegroup remap: no source battlegroup ID found in backup metadata."
    return 0
  fi
  if [ -z "$new_battlegroup_id" ] || [ "$new_battlegroup_id" = "unknown" ]; then
    echo "Battlegroup remap: current Docker battlegroup ID is not available."
    return 0
  fi
  if [ "$old_battlegroup_id" = "$new_battlegroup_id" ]; then
    echo "Battlegroup remap: backup already matches Docker battlegroup ID."
    return 0
  fi

  echo "Battlegroup remap: $old_battlegroup_id -> $new_battlegroup_id"
  docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 \
    -v old_battlegroup_id="$old_battlegroup_id" \
    -v new_battlegroup_id="$new_battlegroup_id" <<'SQL'
select set_config('dune.old_battlegroup_id', :'old_battlegroup_id', false);
select set_config('dune.new_battlegroup_id', :'new_battlegroup_id', false);
do $$
declare
  r record;
  affected bigint;
  total bigint := 0;
  old_id text := current_setting('dune.old_battlegroup_id', true);
  new_id text := current_setting('dune.new_battlegroup_id', true);
begin
  old_id := coalesce(old_id, '');
  new_id := coalesce(new_id, '');
  if old_id = '' or new_id = '' or old_id = new_id then
    raise notice 'Battlegroup remap skipped.';
    return;
  end if;

  for r in
    select table_schema, table_name, column_name, data_type
    from information_schema.columns
    where table_schema = 'dune'
      and data_type in ('text', 'character varying', 'character', 'json', 'jsonb')
    order by table_name, ordinal_position
  loop
    if r.data_type in ('json', 'jsonb') then
      execute format(
        'update %I.%I set %I = replace(%I::text, %L, %L)::%s where %I::text like %L',
        r.table_schema, r.table_name, r.column_name,
        r.column_name, old_id, new_id, r.data_type,
        r.column_name, '%' || old_id || '%'
      );
    else
      execute format(
        'update %I.%I set %I = replace(%I, %L, %L) where %I like %L',
        r.table_schema, r.table_name, r.column_name,
        r.column_name, old_id, new_id,
        r.column_name, '%' || old_id || '%'
      );
    end if;
    get diagnostics affected = row_count;
    if affected > 0 then
      total := total + affected;
      raise notice 'Battlegroup remap updated %.%.% rows=%', r.table_schema, r.table_name, r.column_name, affected;
    end if;
  end loop;

  raise notice 'Battlegroup remap complete. Updated rows=%', total;
end $$;
SQL
}

transfer_function_check() {
  local missing
  missing="$(docker exec dune-postgres psql -U postgres -d dune -At -c "
    with required(schema_name, function_name, args) as (
      values
        ('dune','set_account_as_takeoverable','text,text'),
        ('dune','can_takeover_account','text'),
        ('dune','takeover_account','text,text')
    )
    select string_agg(function_name || '(' || args || ')', ', ')
    from required r
    where to_regprocedure(r.schema_name || '.' || r.function_name || '(' || r.args || ')') is null;
  " | tr -d '\r')"
  if [ -n "$missing" ]; then
    echo "Missing required DB transfer function(s): $missing"
    exit 1
  fi
}

fls_exists() {
  local fls="$1"
  [ "$(docker exec dune-postgres psql -U postgres -d dune -At -c "
    select count(*)
    from dune.encrypted_accounts
    where "user" = '${fls//\'/\'\'}';
  " | tr -d '[:space:]')" != "0" ]
}

fls_character_count() {
  local fls="$1"
  docker exec dune-postgres psql -U postgres -d dune -At -c "
    select count(*)
    from dune.encrypted_accounts e
    left join dune.player_state ps on ps.account_id = e.id
    left join dune.encrypted_player_state eps on eps.account_id = e.id
    left join dune.actors a on a.owner_account_id = e.id and a.class ilike '%PlayerCharacter%'
    where e."user" = '${fls//\'/\'\'}'
      and (ps.account_id is not null or eps.account_id is not null or a.id is not null);
  " 2>/dev/null | tr -d '[:space:]' || echo "unknown"
}

append_pending_transfer() {
  local old="$1"
  local new="$2"
  local note="${3:-missing new account row}"
  mkdir -p "$(dirname "$PENDING_TRANSFER_FILE")"
  if [ ! -f "$PENDING_TRANSFER_FILE" ] || ! awk -F '\t' -v old="$old" -v new="$new" '$1 == old && $2 == new { found=1 } END { exit(found ? 0 : 1) }' "$PENDING_TRANSFER_FILE"; then
    printf '%s\t%s\t%s\n' "$old" "$new" "$note" >> "$PENDING_TRANSFER_FILE"
  fi
}

transfer_sql_apply() {
  local old="$1"
  local new="$2"
  docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
begin;
select dune.set_account_as_takeoverable('${old//\'/\'\'}', '${new//\'/\'\'}');
do \$\$
begin
  if not dune.can_takeover_account('${new//\'/\'\'}') then
    raise exception 'can_takeover_account returned false';
  end if;
end
\$\$;
select dune.takeover_account('${old//\'/\'\'}', '${new//\'/\'\'}');
do \$\$
begin
  if not exists (
    select 1
    from dune.encrypted_accounts e
    left join dune.player_state ps on ps.account_id = e.id
    left join dune.actors a on a.owner_account_id = e.id and a.class ilike '%PlayerCharacter%'
    where e."user" = '${new//\'/\'\'}'
      and (ps.account_id is not null or a.id is not null)
  ) then
    raise exception 'post-transfer character lookup for new FLS failed';
  end if;
end
\$\$;
commit;
"
}

load_transfer_plan() {
  local file="$1"
  python3 - "$file" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    parts = raw.split("\t")
    if len(parts) < 2 or not parts[0].strip() or not parts[1].strip():
        print(f"ERROR\t{lineno}\tInvalid transfer line: expected old_fls_id<TAB>new_fls_id<TAB>optional_note")
        continue
    note = parts[2].strip() if len(parts) > 2 else ""
    print(f"ROW\t{lineno}\t{parts[0].strip()}\t{parts[1].strip()}\t{note}")
PY
}

run_transfer_plan() {
  local plan_file="$1"
  local dry_run="$2"
  local assume_yes="$3"
  local no_backup="$4"
  local applied=0 skipped=0 failed=0 pending=0 line kind lineno old new note chars
  local rows

  require_postgres
  transfer_function_check
  rows="$(load_transfer_plan "$plan_file")"
  if printf '%s\n' "$rows" | grep -q '^ERROR'; then
    printf '%s\n' "$rows" | sed 's/^ERROR\t/Line /'
    exit 1
  fi
  if [ -z "$(printf '%s\n' "$rows" | sed '/^$/d')" ]; then
    echo "Transfer plan is empty."
    return 0
  fi

  if [ "$dry_run" != "1" ] && [ "$no_backup" != "1" ]; then
    backup_db "$BACKUP_DIR_DEFAULT"
  elif [ "$dry_run" != "1" ] && [ "$no_backup" = "1" ]; then
    echo "WARNING: --no-backup disables the default pre-transfer database backup."
    if [ "$assume_yes" != "1" ]; then
      read -r -p "Type NO BACKUP to continue: " chars
      [ "$chars" = "NO BACKUP" ] || { echo "Transfer cancelled."; exit 1; }
    fi
  fi

  while IFS=$'\t' read -r kind lineno old new note; do
    [ "$kind" = "ROW" ] || continue
    echo
    echo "Transfer line $lineno: $(redact_fls "$old") -> $(redact_fls "$new") ${note:+($note)}"

    if ! fls_exists "$old"; then
      echo "SKIP old FLS does not exist after restore/import."
      skipped=$((skipped + 1))
      continue
    fi
    if ! fls_exists "$new"; then
      echo "PENDING new FLS row does not exist. Have the new account log in once, then run: dune db transfer apply-pending"
      append_pending_transfer "$old" "$new" "new account must log in once"
      pending=$((pending + 1))
      continue
    fi

    char_count="$(fls_character_count "$new")"
    if [ "$char_count" != "0" ]; then
      echo "WARNING: new account appears non-empty (character/state rows: $char_count)."
      if [ "$assume_yes" != "1" ] && [ "$dry_run" != "1" ]; then
        read -r -p "Continue this identity-changing transfer? [y/N]: " answer
        case "$answer" in y|Y|yes|YES) ;; *) echo "Transfer cancelled."; failed=$((failed + 1)); break ;; esac
      fi
    fi

    if [ "$dry_run" = "1" ]; then
      echo "DRY RUN would call set_account_as_takeoverable, can_takeover_account, takeover_account."
      skipped=$((skipped + 1))
      continue
    fi

    if [ "$assume_yes" != "1" ]; then
      read -r -p "Apply transfer $(redact_fls "$old") -> $(redact_fls "$new")? [y/N]: " answer
      case "$answer" in y|Y|yes|YES) ;; *) echo "Transfer cancelled."; failed=$((failed + 1)); break ;; esac
    fi

    if transfer_sql_apply "$old" "$new"; then
      echo "APPLIED transfer $(redact_fls "$old") -> $(redact_fls "$new")"
      applied=$((applied + 1))
    else
      echo "FAILED transfer on line $lineno. Stopping."
      failed=$((failed + 1))
      break
    fi
  done <<< "$rows"

  echo
  echo "Transfer summary: applied=$applied skipped=$skipped failed=$failed pending=$pending"
  [ "$failed" -eq 0 ] && [ "$pending" -eq 0 ]
}

transfer_command() {
  local dry_run=0 assume_yes="${DUNE_DB_ASSUME_YES:-0}" no_backup=0 file="" sub="${1:-}"
  local plan

  case "$sub" in
    pending)
      if [ -s "$PENDING_TRANSFER_FILE" ]; then
        while IFS=$'\t' read -r old new note; do
          [ -n "${old:-}" ] || continue
          printf '%s\t%s\t%s\n' "$(redact_fls "$old")" "$(redact_fls "$new")" "$note"
        done < "$PENDING_TRANSFER_FILE"
      else
        echo "No pending character transfers."
      fi
      return 0
      ;;
    apply-pending)
      [ -s "$PENDING_TRANSFER_FILE" ] || { echo "No pending character transfers."; return 0; }
      if run_transfer_plan "$PENDING_TRANSFER_FILE" 0 "$assume_yes" 0; then
        rm -f "$PENDING_TRANSFER_FILE"
        echo "All pending transfers applied; pending file cleared."
        return 0
      fi
      return 1
      ;;
    clear-pending)
      if [ "$assume_yes" != "1" ]; then
        read -r -p "Clear pending transfer file? [y/N]: " answer
        case "$answer" in y|Y|yes|YES) ;; *) echo "Cancelled."; return 1 ;; esac
      fi
      rm -f "$PENDING_TRANSFER_FILE"
      echo "Pending transfer file cleared."
      return 0
      ;;
  esac

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=1; shift ;;
      --yes|-y) assume_yes=1; shift ;;
      --no-backup) no_backup=1; shift ;;
      --file)
        [ -n "${2:-}" ] || { echo "Missing --file path."; exit 2; }
        file="$2"; shift 2
        ;;
      --*) echo "Unknown transfer option: $1"; exit 2 ;;
      *) break ;;
    esac
  done

  if [ -n "$file" ]; then
    [ -f "$file" ] || { echo "Transfer plan file not found: $file"; exit 1; }
    run_transfer_plan "$file" "$dry_run" "$assume_yes" "$no_backup"
    return $?
  fi

  if [ "$#" -ne 2 ]; then
    echo "Usage: dune db transfer [--dry-run] [--yes] OLD_FLS_ID NEW_FLS_ID"
    exit 2
  fi
  mkdir -p runtime/generated
  plan="runtime/generated/transfer-plan-single-$$.tsv"
  printf '%s\t%s\tmanual\n' "$1" "$2" > "$plan"
  run_transfer_plan "$plan" "$dry_run" "$assume_yes" "$no_backup"
  rm -f "$plan"
}

validate_positive_integer() {
  local value="$1"
  printf '%s' "$value" | grep -Eq '^[1-9][0-9]*$'
}

can_manage_systemd_units() {
  [ -d /etc/systemd/system ] && [ -w /etc/systemd/system ]
}

docker_helper_image() {
  printf '%s' "${DUNE_SYSTEMD_HELPER_IMAGE:-redblink-dune-docker-console:dev}"
}

can_manage_host_systemd_with_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  [ -S /var/run/docker.sock ] || return 1
  docker image inspect "$(docker_helper_image)" >/dev/null 2>&1 || return 1
}

load_auto_state() {
  DB_AUTO_BACKUP_ENABLED="${DB_AUTO_BACKUP_ENABLED:-0}"
  DB_AUTO_BACKUP_TIME="${DB_AUTO_BACKUP_TIME:-05:00}"
  DB_AUTO_BACKUP_INTERVAL_HOURS="${DB_AUTO_BACKUP_INTERVAL_HOURS:-24}"
  DB_AUTO_BACKUP_RETENTION_DAYS="${DB_AUTO_BACKUP_RETENTION_DAYS:-0}"
  DB_AUTO_BACKUP_DIR="${DB_AUTO_BACKUP_DIR:-$BACKUP_DIR_DEFAULT}"

  if [ -r "$AUTO_STATE_FILE" ]; then
    # shellcheck disable=SC1090
    . "$AUTO_STATE_FILE"
  fi

  DB_AUTO_BACKUP_ENABLED="${DB_AUTO_BACKUP_ENABLED:-0}"
  DB_AUTO_BACKUP_TIME="${DB_AUTO_BACKUP_TIME:-05:00}"
  DB_AUTO_BACKUP_INTERVAL_HOURS="${DB_AUTO_BACKUP_INTERVAL_HOURS:-24}"
  DB_AUTO_BACKUP_RETENTION_DAYS="${DB_AUTO_BACKUP_RETENTION_DAYS:-0}"
  DB_AUTO_BACKUP_DIR="${DB_AUTO_BACKUP_DIR:-$BACKUP_DIR_DEFAULT}"
}

write_auto_state() {
  local enabled="$1"
  local backup_time="$2"
  local retention_days="${3:-0}"
  local interval_hours="${4:-24}"
  local tmp_file

  mkdir -p runtime/generated
  tmp_file="${AUTO_STATE_FILE}.tmp.$$"
  cat > "$tmp_file" <<EOF
DB_AUTO_BACKUP_ENABLED=$enabled
DB_AUTO_BACKUP_TIME=$backup_time
DB_AUTO_BACKUP_INTERVAL_HOURS=$interval_hours
DB_AUTO_BACKUP_RETENTION_DAYS=$retention_days
DB_AUTO_BACKUP_DIR=$BACKUP_DIR_DEFAULT
EOF
  chmod 644 "$tmp_file" 2>/dev/null || true
  mv -f "$tmp_file" "$AUTO_STATE_FILE"
}

validate_backup_time() {
  local backup_time="$1"
  printf '%s' "$backup_time" | grep -Eq '^([01][0-9]|2[0-3]):[0-5][0-9]$'
}

validate_interval_hours() {
  local interval_hours="$1"
  printf '%s' "$interval_hours" | grep -Eq '^[0-9]+$' && [ "$interval_hours" -ge 1 ] && [ "$interval_hours" -le 168 ]
}

write_auto_units_to() {
  local backup_time="$1"
  local systemd_dir="$2"
  local exec_root="$3"
  local interval_hours="${4:-24}"

  mkdir -p "$systemd_dir"
  cat > "$systemd_dir/dune-awakening-db-backup.service" <<EOF
[Unit]
Description=Dune Awakening battlegroup database backup
Wants=docker.service
After=network-online.target docker.service

[Service]
Type=oneshot
WorkingDirectory=$exec_root
Environment=DB_BACKUP_PRUNE_AFTER_SUCCESS=1
Environment=DB_BACKUP_ORIGIN=automatic
EnvironmentFile=$exec_root/runtime/generated/db-backup.env
ExecStart=$exec_root/runtime/scripts/dune db backup
EOF

  cat > "$systemd_dir/dune-awakening-db-backup.timer" <<EOF
[Unit]
Description=Run Dune Awakening battlegroup database backup

[Timer]
OnCalendar=*-*-* ${backup_time}:00
EOF
  if [ "$interval_hours" != "24" ]; then
    cat >> "$systemd_dir/dune-awakening-db-backup.timer" <<EOF
OnUnitActiveSec=${interval_hours}h
EOF
  fi
  cat >> "$systemd_dir/dune-awakening-db-backup.timer" <<EOF
Persistent=true
Unit=dune-awakening-db-backup.service

[Install]
WantedBy=timers.target
EOF
}

install_auto_units_via_docker_host() {
  local backup_time="$1"
  local interval_hours="${2:-24}"
  local image
  image="$(docker_helper_image)"

  can_manage_host_systemd_with_docker || return 1
  docker run --rm --privileged --pid=host --network=host \
    -e DB_AUTO_BACKUP_TIME="$backup_time" \
    -e DB_AUTO_BACKUP_INTERVAL_HOURS="$interval_hours" \
    -e DUNE_HOST_REPO_ROOT="$HOST_ROOT_DIR" \
    -v /:/host \
    --entrypoint bash \
    "$image" -lc '
      set -euo pipefail
      systemd_dir=/host/etc/systemd/system
      mkdir -p "$systemd_dir"
      cat > "$systemd_dir/dune-awakening-db-backup.service" <<EOF
[Unit]
Description=Dune Awakening battlegroup database backup
Wants=docker.service
After=network-online.target docker.service

[Service]
Type=oneshot
WorkingDirectory=${DUNE_HOST_REPO_ROOT}
Environment=DB_BACKUP_PRUNE_AFTER_SUCCESS=1
Environment=DB_BACKUP_ORIGIN=automatic
EnvironmentFile=${DUNE_HOST_REPO_ROOT}/runtime/generated/db-backup.env
ExecStart=${DUNE_HOST_REPO_ROOT}/runtime/scripts/dune db backup
EOF
      cat > "$systemd_dir/dune-awakening-db-backup.timer" <<EOF
[Unit]
Description=Run Dune Awakening battlegroup database backup

[Timer]
OnCalendar=*-*-* ${DB_AUTO_BACKUP_TIME}:00
EOF
      if [ "${DB_AUTO_BACKUP_INTERVAL_HOURS}" != "24" ]; then
        cat >> "$systemd_dir/dune-awakening-db-backup.timer" <<EOF
OnUnitActiveSec=${DB_AUTO_BACKUP_INTERVAL_HOURS}h
EOF
      fi
      cat >> "$systemd_dir/dune-awakening-db-backup.timer" <<EOF
Persistent=true
Unit=dune-awakening-db-backup.service

[Install]
WantedBy=timers.target
EOF
      chroot /host /bin/systemctl daemon-reload
      chroot /host /bin/systemctl enable --now dune-awakening-db-backup.timer
    '
}

disable_auto_units_via_docker_host() {
  local image
  image="$(docker_helper_image)"

  can_manage_host_systemd_with_docker || return 1
  docker run --rm --privileged --pid=host --network=host \
    -v /:/host \
    --entrypoint bash \
    "$image" -lc '
      set -euo pipefail
      chroot /host /bin/systemctl disable --now dune-awakening-db-backup.timer >/dev/null 2>&1 || true
      rm -f /host/etc/systemd/system/dune-awakening-db-backup.service /host/etc/systemd/system/dune-awakening-db-backup.timer
      chroot /host /bin/systemctl daemon-reload
    '
}

show_auto_timer_status_via_docker_host() {
  local image
  image="$(docker_helper_image)"

  can_manage_host_systemd_with_docker || return 1
  docker run --rm --privileged --pid=host --network=host \
    -v /:/host \
    --entrypoint bash \
    "$image" -lc '
      set -euo pipefail
      if chroot /host /bin/systemctl list-unit-files dune-awakening-db-backup.timer --no-legend --no-pager 2>/dev/null | grep -q "^dune-awakening-db-backup.timer"; then
        timer_enabled="$(chroot /host /bin/systemctl is-enabled dune-awakening-db-backup.timer 2>/dev/null || true)"
        [ -n "$timer_enabled" ] && echo "Systemd timer:   $timer_enabled"
        chroot /host /bin/systemctl list-timers --all dune-awakening-db-backup.timer --no-pager || true
      else
        echo "Systemd timer:   not installed"
      fi
    '
}

auto_backup_enable() {
  local backup_time="${1:-}"
  local retention_days="${2:-}"
  local interval_hours="${3:-}"

  if [ -z "$backup_time" ]; then
    echo "Missing backup time."
    echo "Usage: dune db auto enable <HH:MM>"
    exit 2
  fi

  if ! validate_backup_time "$backup_time"; then
    echo "Invalid backup time: $backup_time"
    echo "Use 24-hour local server time, for example:"
    echo "  dune db auto enable 05:00"
    exit 1
  fi

  load_auto_state

  if [ -n "$retention_days" ]; then
    if ! validate_positive_integer "$retention_days"; then
      echo "Invalid retention days: $retention_days"
      echo "Use a positive integer number of days, for example:"
      echo "  dune db auto enable 05:00 14"
      echo "Use 0 to disable retention when setting an interval:"
      echo "  dune db auto enable 05:00 0 12"
      exit 1
    fi
  else
    retention_days="${DB_AUTO_BACKUP_RETENTION_DAYS:-0}"
  fi

  if [ -n "$interval_hours" ]; then
    if ! validate_interval_hours "$interval_hours"; then
      echo "Invalid interval hours: $interval_hours"
      echo "Use a whole number from 1 to 168, for example:"
      echo "  dune db auto enable 05:00 14 12"
      exit 1
    fi
  else
    interval_hours="${DB_AUTO_BACKUP_INTERVAL_HOURS:-24}"
  fi

  write_auto_state 1 "$backup_time" "$retention_days" "$interval_hours"

  if ! command -v systemctl >/dev/null 2>&1; then
    if install_auto_units_via_docker_host "$backup_time" "$interval_hours"; then
      echo "Auto DB backups enabled."
      echo "Backup time: $backup_time"
      echo "Interval: every $interval_hours hours"
      echo "Timer: dune-awakening-db-backup.timer"
      return 0
    fi
    echo "Auto DB backup preference saved, but systemctl was not found."
    echo "Saved: $AUTO_STATE_FILE"
    return 0
  fi

  if ! can_manage_systemd_units; then
    if install_auto_units_via_docker_host "$backup_time" "$interval_hours"; then
      echo "Auto DB backups enabled."
      echo "Backup time: $backup_time"
      echo "Interval: every $interval_hours hours"
      echo "Timer: dune-awakening-db-backup.timer"
      return 0
    fi
    echo "Auto DB backup preference saved, but this user cannot install systemd units."
    echo "Saved: $AUTO_STATE_FILE"
    echo "To install the timer, run this command with sudo/root:"
    echo "  runtime/scripts/dune db auto enable $backup_time $retention_days $interval_hours"
    return 0
  fi

  write_auto_units_to "$backup_time" "/etc/systemd/system" "$ROOT_DIR" "$interval_hours"

  systemctl daemon-reload
  systemctl enable --now dune-awakening-db-backup.timer

  echo "Auto DB backups enabled."
  echo "Backup time: $backup_time"
  echo "Interval: every $interval_hours hours"
  if [ "${retention_days:-0}" -gt 0 ] 2>/dev/null; then
    echo "Retention: keep backups from the last $retention_days days"
  else
    echo "Retention: off"
  fi
  echo "Timer: dune-awakening-db-backup.timer"
}

auto_backup_disable() {
  local backup_time
  local retention_days
  local interval_hours

  load_auto_state
  backup_time="${DB_AUTO_BACKUP_TIME:-05:00}"
  retention_days="${DB_AUTO_BACKUP_RETENTION_DAYS:-0}"
  interval_hours="${DB_AUTO_BACKUP_INTERVAL_HOURS:-24}"

  write_auto_state 0 "$backup_time" "$retention_days" "$interval_hours"

  if command -v systemctl >/dev/null 2>&1 && can_manage_systemd_units; then
    systemctl disable --now dune-awakening-db-backup.timer >/dev/null 2>&1 || true
    rm -f "$AUTO_SERVICE_FILE" "$AUTO_TIMER_FILE"
    systemctl daemon-reload
  elif can_manage_host_systemd_with_docker; then
    disable_auto_units_via_docker_host
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
  echo "Backup time:      ${DB_AUTO_BACKUP_TIME:-05:00}"
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
  else
    echo
    show_auto_timer_status_via_docker_host || echo "Systemd timer:   not installed"
  fi

  echo
  echo "=== Recent database backups ==="
  if [ -d "${DB_AUTO_BACKUP_DIR:-$BACKUP_DIR_DEFAULT}" ]; then
    find "${DB_AUTO_BACKUP_DIR:-$BACKUP_DIR_DEFAULT}" -maxdepth 1 -type f \( -name 'dune-db-*.dump' -o -name 'dune-db-*.sql' -o -name '*.backup' \) -printf '%TY-%Tm-%Td %TH:%TM  %p\n' | sort | tail -n 5 || true
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
      write_auto_state "${DB_AUTO_BACKUP_ENABLED:-0}" "${DB_AUTO_BACKUP_TIME:-05:00}" 0 "${DB_AUTO_BACKUP_INTERVAL_HOURS:-24}"
      echo "Auto backup retention disabled. Old backups will not be deleted automatically."
      ;;
    *)
      if ! validate_positive_integer "$value"; then
        echo "Invalid retention days: $value"
        echo "Use a positive integer number of days, or: dune db auto retention off"
        exit 1
      fi
      write_auto_state "${DB_AUTO_BACKUP_ENABLED:-0}" "${DB_AUTO_BACKUP_TIME:-05:00}" "$value" "${DB_AUTO_BACKUP_INTERVAL_HOURS:-24}"
      echo "Auto backup retention set to $value days."
      ;;
  esac
}

handle_auto_backup() {
  local sub="${1:-status}"

  case "$sub" in
    enable|on)
      auto_backup_enable "${2:-}" "${3:-}" "${4:-}"
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
      echo "  dune db auto enable <HH:MM>"
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
    shift || true
    import_db "$@"
    ;;
  transfer)
    shift || true
    transfer_command "$@"
    ;;
  delete)
    delete_backup "${2:-}"
    ;;
  auto)
    handle_auto_backup "${2:-status}" "${3:-}" "${4:-}" "${5:-}"
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
