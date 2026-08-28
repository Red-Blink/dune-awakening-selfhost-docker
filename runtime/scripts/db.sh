#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"
HOST_ROOT_DIR="${DUNE_HOST_REPO_ROOT:-$ROOT_DIR}"
# shellcheck source=runtime/scripts/env-file.sh
source runtime/scripts/env-file.sh

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
  dune db backup-system [output-dir]
  dune db list
  dune db list-system [output-dir]
  dune db status
  dune db health
  dune db import <backup-file>
  dune db restore <backup-file>
  dune db restore <backup-file> --adopt-backup-battlegroup
  dune db restore <backup-file> --keep-current-battlegroup
  dune db restore <backup-file> --no-safety-backup
  dune db restore <backup-file> --transfer OLD=NEW
  dune db restore <backup-file> --transfer-file <plan.tsv>
  dune db transfer OLD_FLS_ID NEW_FLS_ID
  dune db transfer --dry-run OLD_FLS_ID NEW_FLS_ID
  dune db transfer --yes OLD_FLS_ID NEW_FLS_ID
  dune db transfer --file <plan.tsv> [--dry-run]
  dune db transfer pending
  dune db transfer apply-pending
  dune db transfer clear-pending
  dune db delete <backup-file-or-name> [more-backups...]
  dune db delete --all
  dune db auto enable <HH:MM> [retention-days] [interval-hours]
  dune db auto disable
  dune db auto status
  dune db auto retention <days>
  dune db auto retention off

Backups are written as official-style .backup files with a .backup.yaml sidecar.
Import accepts official .backup files and older dune-db-*.dump or .sql backups.
Import requires confirmation and creates a pre-import backup first unless --no-safety-backup is used.
When the backup and current Battlegroup IDs differ, import requires an explicit
choice to adopt the backup identity or keep the current identity. Adopting is
the normal choice when moving the same server to new hardware; keeping the
current identity is for intentionally importing data into a different server.

dune db backup-system bundles a fresh database dump together with .env,
runtime/generated/, and runtime/secrets/ into one encrypted
dune-system-*.tar.gz.enc archive under runtime/backups/system/ (with a
matching .yaml sidecar containing no secrets, safe to read/share on its
own). Every credential is retained -- the Funcom Self-Host Service Token,
admin console password, RMQ admin credentials, and the sietch join
password are all included verbatim, not redacted or excluded. The
archive's only protection is the passphrase you set when creating it,
encrypted with AES-256 in AEAD (OCB) mode via gpg -- an authenticated
cipher mode, not just confidentiality: a corrupted or tampered archive
is rejected outright at decrypt time rather than silently producing
wrong or manipulated plaintext. You will be prompted for a passphrase
interactively (entered twice, to catch typos); for non-interactive/cron
use, set DUNE_SYSTEM_BACKUP_PASSPHRASE in the environment instead. There
is no way to recover an encrypted system backup without its passphrase --
store the passphrase somewhere durable and separate from the archive
itself (a password manager, not the same disk).

The archive is written 600 (owner read/write only) as defense in depth,
but do not rely on filesystem permissions alone -- treat a copy of this
archive as equivalent to a copy of your Funcom token the moment it leaves
this host, unless you are confident in the passphrase's strength.

To decrypt and extract (also printed in the archive's own .yaml sidecar
and on stdout when the backup is created). Enter the passphrase at the
prompt -- do not put it directly on the command line, which would expose
it to any other process on this host via `ps`/`/proc/<pid>/cmdline` for
as long as gpg is running:
  read -r -s -p "Passphrase: " p; echo
  printf '%s' "$p" | gpg --batch --yes --pinentry-mode loopback \
    --passphrase-fd 0 -d <archive> | gunzip | tar -xf -
  unset p

There is no automated restore for system backups yet: decrypt/extract as
above, restore .env / runtime/generated/ / runtime/secrets/ manually, then
use `dune db restore` for the db/ dump inside it.
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

backup_battlegroup_id() {
  local backup_file="$1"
  local value=""

  value="$(backup_metadata_value "$backup_file" imported_from_battlegroup_id || true)"
  [ -n "$value" ] || value="$(backup_metadata_value "$backup_file" battlegroup_id || true)"
  printf '%s\n' "$value"
}

validate_backup_battlegroup_token() {
  local backup_id="$1"
  local token=""
  local token_host=""
  local backup_host=""

  if ! printf '%s' "$backup_id" | grep -Eq '^sh-[A-Za-z0-9]+-[A-Za-z0-9]+$'; then
    echo "Restore stopped: backup metadata contains an invalid Battlegroup ID: $backup_id" >&2
    return 1
  fi

  token="$(tr -d '\r\n' < runtime/secrets/funcom-token.txt 2>/dev/null || true)"
  token_host="$(token_payload_value "$token" HostId 2>/dev/null || true)"
  backup_host="$(battlegroup_host_id "$backup_id" 2>/dev/null || true)"
  if [ -z "$token_host" ]; then
    echo "Restore stopped: the current Funcom token could not be validated." >&2
    echo "Save the token that belongs to the backup Battlegroup, then retry the restore." >&2
    return 1
  fi
  if [ -z "$backup_host" ] || [ "$(printf '%s' "$token_host" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$backup_host" | tr '[:upper:]' '[:lower:]')" ]; then
    echo "Restore stopped: the current Funcom token does not belong to backup Battlegroup $backup_id." >&2
    echo "Save the matching token before adopting the backup identity." >&2
    return 1
  fi
}

choose_import_battlegroup_action() {
  local backup_file="$1"
  local requested_action="${2:-}"
  local backup_id=""
  local current_id=""
  local answer=""

  IMPORT_BATTLEGROUP_ACTION="keep-current"
  backup_id="$(backup_battlegroup_id "$backup_file")"
  current_id="$(current_battlegroup_id)"

  if [ -z "$backup_id" ] || [ "$backup_id" = "unknown" ]; then
    if [ "$requested_action" = "adopt-backup" ]; then
      echo "Restore stopped: backup metadata has no usable Battlegroup ID to adopt." >&2
      echo "Use --keep-current-battlegroup only if this backup is intentionally being imported into the current server." >&2
      return 1
    fi
    echo "Battlegroup identity: backup metadata has no usable Battlegroup ID; keeping the current identity."
    return 0
  fi
  if [ -z "$current_id" ] || [ "$current_id" = "unknown" ]; then
    echo "Restore stopped: the current Docker Battlegroup ID is unavailable, so identity continuity cannot be verified." >&2
    return 1
  fi
  if [ "$backup_id" = "$current_id" ]; then
    echo "Battlegroup identity: backup already matches $current_id."
    IMPORT_BATTLEGROUP_ACTION="matching"
    return 0
  fi

  echo "Battlegroup identity mismatch detected:"
  echo "  Current Docker Battlegroup: $current_id"
  echo "  Backup Battlegroup:        $backup_id"

  if [ -z "$requested_action" ]; then
    if [ "${DUNE_DB_ASSUME_YES:-0}" = "1" ]; then
      echo "Restore stopped before making changes: choose --adopt-backup-battlegroup or --keep-current-battlegroup." >&2
      return 1
    fi
    echo "Adopt the backup identity when moving the same server to new hardware."
    echo "Keep the current identity only when intentionally importing data into a different server."
    read -r -p "Identity choice: [a]dopt backup / [k]eep current / [c]ancel: " answer
    case "$answer" in
      a|A|adopt|ADOPT) requested_action="adopt-backup" ;;
      k|K|keep|KEEP) requested_action="keep-current" ;;
      *) echo "Import cancelled."; return 1 ;;
    esac
  fi

  case "$requested_action" in
    adopt-backup)
      validate_backup_battlegroup_token "$backup_id" || return 1
      IMPORT_BATTLEGROUP_ACTION="adopt-backup"
      echo "Battlegroup identity: the matching Funcom token was verified; the backup identity will be adopted."
      ;;
    keep-current)
      IMPORT_BATTLEGROUP_ACTION="keep-current"
      echo "WARNING: keeping $current_id. Characters associated with $backup_id may not appear in game."
      ;;
    *)
      echo "Unknown Battlegroup identity choice: $requested_action" >&2
      return 1
      ;;
  esac
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

validate_live_dune_database_for_backup() {
  local partition_count

  if ! partition_count="$(
    docker exec dune-postgres psql -U postgres -d dune -Atqc \
      "select count(*) from dune.world_partition;" 2>/dev/null
  )"; then
    echo "Backup validation failed: the expected dune.world_partition table is unavailable." >&2
    return 1
  fi

  partition_count="$(printf '%s' "$partition_count" | tr -d '[:space:]')"
  if ! [[ "$partition_count" =~ ^[0-9]+$ ]] || [ "$partition_count" -lt 1 ]; then
    echo "Backup validation failed: the Dune database has no world partitions." >&2
    return 1
  fi
}

validate_custom_backup_archive_in_container() {
  local container_file="$1"

  if ! docker exec dune-postgres pg_restore -l "$container_file" 2>/dev/null | awk '
    /[[:space:]]SCHEMA[[:space:]]+-[[:space:]]+dune([[:space:]]|$)/ { has_schema = 1 }
    /[[:space:]]TABLE[[:space:]]+dune[[:space:]]+world_partition([[:space:]]|$)/ { has_table = 1 }
    /[[:space:]]TABLE DATA[[:space:]]+dune[[:space:]]+world_partition([[:space:]]|$)/ { has_data = 1 }
    END { exit !(has_schema && has_table && has_data) }
  '; then
    echo "Backup validation failed: archive does not contain the expected Dune schema and world partition data." >&2
    return 1
  fi
}

validate_custom_backup_file() {
  local backup_file="$1"
  local tmp_file="/tmp/dune-db-validate-$$-${RANDOM}.backup"
  local result=0

  if ! docker cp "$backup_file" "dune-postgres:$tmp_file" >/dev/null; then
    echo "Backup validation failed: could not copy archive into PostgreSQL for inspection." >&2
    return 1
  fi

  validate_custom_backup_archive_in_container "$tmp_file" || result=$?
  docker exec dune-postgres rm -f "$tmp_file" >/dev/null 2>&1 || true
  return "$result"
}

backup_db() {
  local out_dir="${1:-$BACKUP_DIR_DEFAULT}"
  local ts
  local scope
  local scope_maps
  local artifact_id
  local server_title
  local server_slug
  local backup_file
  local sidecar_file
  local staged_backup_file
  local staged_sidecar_file
  local tmp_file

  if [ -x runtime/scripts/battlegroup-identity.sh ]; then
    if ! runtime/scripts/battlegroup-identity.sh ensure; then
      echo "WARNING: The database backup will continue, but its Battlegroup ID metadata will be recorded as unknown." >&2
      echo "Repair the identity before restarting the battlegroup: runtime/scripts/battlegroup-identity.sh ensure" >&2
    fi
  else
    echo "WARNING: Battlegroup identity validation is unavailable; backup metadata may record an unknown ID." >&2
  fi
  require_postgres
  mkdir -p "$out_dir"

  ts="$(date +%Y%m%d-%H%M%S)"
  scope="$(backup_scope_slug)"
  [ -n "$scope" ] || scope="all_maps"
  scope_maps="$(backup_scope_maps)"
  server_title="$(config_value .env SERVER_TITLE || true)"
  [ -n "$server_title" ] || server_title="Dune Server"
  server_slug="$(printf '%s' "$server_title" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')"
  [ -n "$server_slug" ] || server_slug="dune-server"
  artifact_id="$server_slug"
  # Market Bot backups carry their origin in the filename so a plain ls of the
  # backup directory shows what minted them (the sidecar's backup_origin is
  # authoritative but not visible without opening it), e.g.
  # kovalt-sietch-market-bot-buyback-20260819-020000.backup
  case "${DB_BACKUP_ORIGIN:-manual}" in
    market-bot-*|vehicle-delete)
      artifact_id="$server_slug-$(printf '%s' "${DB_BACKUP_ORIGIN}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')"
      ;;
  esac
  backup_file="$out_dir/$artifact_id-$ts.backup"
  sidecar_file="$backup_file.yaml"
  staged_backup_file="$backup_file.partial.$$"
  staged_sidecar_file="$sidecar_file.partial.$$"
  tmp_file="/tmp/$artifact_id-$ts.backup"

  echo "Creating database backup..."
  if ! validate_live_dune_database_for_backup; then
    echo "Backup was not created. Existing backup files were left unchanged." >&2
    return 1
  fi
  if ! docker exec dune-postgres pg_dump -U postgres -d dune -Fc -f "$tmp_file"; then
    docker exec dune-postgres rm -f "$tmp_file" >/dev/null 2>&1 || true
    echo "Backup was not created because pg_dump failed." >&2
    return 1
  fi
  if ! validate_custom_backup_archive_in_container "$tmp_file"; then
    docker exec dune-postgres rm -f "$tmp_file" >/dev/null 2>&1 || true
    echo "Backup was rejected before publication. Existing backup files were left unchanged." >&2
    return 1
  fi
  if ! docker cp "dune-postgres:$tmp_file" "$staged_backup_file" >/dev/null; then
    docker exec dune-postgres rm -f "$tmp_file" >/dev/null 2>&1 || true
    command rm -f -- "$staged_backup_file" "$staged_sidecar_file"
    echo "Backup was not created because the archive could not be copied from PostgreSQL." >&2
    return 1
  fi
  docker exec dune-postgres rm -f "$tmp_file" >/dev/null 2>&1 || true

  if [ ! -s "$staged_backup_file" ]; then
    command rm -f -- "$staged_backup_file" "$staged_sidecar_file"
    echo "Backup validation failed: copied archive is empty." >&2
    return 1
  fi

  if ! {
    echo "artifact_id: $artifact_id"
    echo "backup_file: $(basename "$backup_file")"
    echo "created_at: $(date -Iseconds)"
    echo "backup_origin: ${DB_BACKUP_ORIGIN:-manual}"
    echo "database: dune"
    echo "format: pg_dump_custom"
    echo "scope: $scope"
    echo "maps: ${scope_maps:-unknown}"
    echo "server_title: $server_title"
    echo "server_region: $(config_value .env SERVER_REGION || echo unknown)"
    echo "server_ip_mode: $(config_value .env SERVER_IP_MODE || echo unknown)"
    echo "battlegroup_id: $(config_value runtime/generated/battlegroup.env BATTLEGROUP_ID || echo unknown)"
  } > "$staged_sidecar_file"; then
    command rm -f -- "$staged_backup_file" "$staged_sidecar_file"
    echo "Backup was not created because its metadata could not be written." >&2
    return 1
  fi

  if ! chmod 600 "$staged_backup_file" || ! chmod 644 "$staged_sidecar_file"; then
    command rm -f -- "$staged_backup_file" "$staged_sidecar_file"
    echo "Backup was not created because its file permissions could not be secured." >&2
    return 1
  fi
  if ! mv -f -- "$staged_backup_file" "$backup_file"; then
    command rm -f -- "$staged_backup_file" "$staged_sidecar_file"
    echo "Backup was not created because the validated archive could not be published." >&2
    return 1
  fi
  if ! mv -f -- "$staged_sidecar_file" "$sidecar_file"; then
    command rm -f -- "$backup_file" "$staged_sidecar_file"
    echo "Backup was not created because its metadata could not be published." >&2
    return 1
  fi

  echo "Backup written:"
  echo "  $backup_file"
  echo "Sidecar:"
  echo "  $sidecar_file"

  LAST_DB_BACKUP_FILE="$backup_file"
  LAST_DB_BACKUP_SIDECAR_FILE="$sidecar_file"

  if [ "${DB_BACKUP_PRUNE_AFTER_SUCCESS:-0}" = "1" ]; then
    prune_old_db_backups "$out_dir" "${DB_AUTO_BACKUP_RETENTION_DAYS:-0}"
  fi

  # Market Bot schedules mint backups unattended before every write, so they
  # are capped by count after every successful Market Bot backup. Other
  # origins (manual, automatic, safety) are never candidates.
  case "${DB_BACKUP_ORIGIN:-manual}" in
    market-bot-*)
      prune_market_bot_backups "$out_dir"
      ;;
    vehicle-delete)
      prune_vehicle_delete_backups "$out_dir"
      ;;
    base-delete)
      prune_base_delete_backups "$out_dir"
      ;;
  esac
}

SYSTEM_BACKUP_DIR_DEFAULT="runtime/backups/system"
# gpg's --s2k-count accepts 1024..65011712; 65011712 is the maximum
# allowed value, giving comparable KDF work factor to this backup
# format's previous PBKDF2 iteration count.
SYSTEM_BACKUP_S2K_COUNT=65011712
# Isolated, disposable GNUPGHOME per invocation -- never the operator's
# own ~/.gnupg. This is symmetric passphrase encryption only (no keys
# ever created, imported, or retained), but gpg still writes a keybox/
# trustdb/agent socket into its home directory on first use; using a
# private, per-invocation directory (removed by the same cleanup path
# as every other staging artifact) avoids ever touching or depending on
# an operator's real GnuPG state.

# Ephemeral, process-scoped scratch directories that are fully regenerated
# on every container start and never carry state worth restoring. Excluded
# purely to avoid churn/bloat, not for secrecy -- everything else under
# runtime/generated/ and runtime/secrets/ is retained verbatim. This
# archive intentionally retains every credential (Funcom token, admin
# password, RMQ admin creds, sietch join password, etc.) rather than
# attempting to selectively redact/exclude them -- encryption (below) is
# the only access control, not field-level redaction, so there is no
# secret-shaped value this backup can silently miss.
system_backup_ephemeral_exclude_patterns() {
  cat <<'EOF'
dune-fake-k8s-serviceaccount-*
EOF
}

# Resolves the passphrase used to encrypt/decrypt a system backup.
# DUNE_SYSTEM_BACKUP_PASSPHRASE lets automation (cron, CI, systemd timers)
# supply it non-interactively; an interactive operator is prompted twice
# (entry + confirmation) so a typo does not silently produce an archive
# nobody can ever decrypt. Never echoes the passphrase, never logs it.
resolve_system_backup_passphrase() {
  local first=""
  local second=""

  if [ -n "${DUNE_SYSTEM_BACKUP_PASSPHRASE:-}" ]; then
    printf '%s' "$DUNE_SYSTEM_BACKUP_PASSPHRASE"
    return 0
  fi

  if [ ! -t 0 ]; then
    echo "No passphrase available: not running interactively and DUNE_SYSTEM_BACKUP_PASSPHRASE is not set." >&2
    return 1
  fi

  read -r -s -p "Set a passphrase to encrypt this system backup: " first
  echo >&2
  [ -n "$first" ] || { echo "Passphrase cannot be empty." >&2; return 1; }
  read -r -s -p "Confirm passphrase: " second
  echo >&2
  if [ "$first" != "$second" ]; then
    echo "Passphrases did not match. System backup was not created." >&2
    return 1
  fi
  printf '%s' "$first"
}

# Creates one encrypted system backup archive (.tar.gz.enc) covering:
#   - a fresh database dump (via backup_db, written directly into out_dir
#     so the caller's requested output directory is honored end-to-end,
#     not just for the final archive)
#   - .env, runtime/generated/, and runtime/secrets/ -- retained verbatim,
#     including every credential. Nothing is redacted or excluded on the
#     basis of being a secret; the archive's confidentiality comes
#     entirely from AES-256-CBC encryption below, gated on the passphrase
#     the operator supplies.
# The plaintext tar is never written to disk unencrypted outside a
# private (mktemp -d, mode 700) staging directory that is removed by an
# explicit, unconditional cleanup at every single exit path -- this
# function does not rely on a RETURN/EXIT trap, because `set -e` aborting
# out of a function does not reliably fire one (verified: an unguarded
# failing command inside a function called as a plain statement, not as
# part of an && / || list, skips a `trap ... RETURN` entirely).
backup_system() {
  local out_dir="${1:-$SYSTEM_BACKUP_DIR_DEFAULT}"
  local ts
  local nonce
  local stage_dir=""
  local db_dump_dir=""
  local db_dump_file=""
  local db_dump_sidecar=""
  local archive_id
  local plain_tar=""
  local archive_file
  local sidecar_file
  local staged_archive=""
  local staged_sidecar=""
  local passphrase
  local gnupg_home=""

  # Every failure path below calls this before returning, so a plaintext
  # DB dump or staging directory never survives a failed run -- the only
  # thing this function is ever allowed to leave behind on disk is either
  # nothing, or a fully-formed encrypted archive. This is called instead
  # of relying on a RETURN/EXIT trap: `set -e` aborting out of a function
  # (via an unguarded failing command, called as a plain statement rather
  # than as part of an && / || list) does not reliably fire a trap set
  # inside that same function -- verified directly against this exact
  # pattern before choosing this explicit-cleanup-on-every-path design.
  backup_system_cleanup_on_failure() {
    [ -z "$stage_dir" ] || rm -rf -- "$stage_dir"
    [ -z "$plain_tar" ] || rm -f -- "$plain_tar"
    [ -z "$staged_archive" ] || rm -f -- "$staged_archive"
    [ -z "$staged_sidecar" ] || rm -f -- "$staged_sidecar"
    [ -z "$db_dump_dir" ] || rm -rf -- "$db_dump_dir"
    [ -z "$gnupg_home" ] || rm -rf -- "$gnupg_home"
  }

  passphrase="$(resolve_system_backup_passphrase)" || return 1

  require_postgres
  mkdir -p "$out_dir"
  chmod 700 "$out_dir" 2>/dev/null || true

  ts="$(date +%Y%m%d-%H%M%S)"
  nonce="$$-$RANDOM"
  archive_id="dune-system-$ts-$nonce"

  # backup_db() names its output using only second-resolution timestamps
  # (shared, unrelated to this feature, load-bearing for `dune db list`'s
  # naming/validation regex elsewhere in this file -- not something this
  # function should change). Two backup_db() calls landing in the same
  # wall-clock second would otherwise compute the IDENTICAL destination
  # path and silently overwrite each other before backup_system() ever
  # reads the result back -- independently reproduced: two concurrent
  # `dune db backup-system` invocations produced two distinct, correctly
  # unique encrypted archives that both silently contained the SAME
  # database dump content, with no error or indication anywhere. Giving
  # backup_db() a private, per-invocation directory (named after this
  # archive's own already-unique id) makes that collision structurally
  # impossible: no two invocations can ever share a destination
  # directory, regardless of what filename backup_db() computes inside it.
  db_dump_dir="$out_dir/.dune-db-dump-$archive_id"
  if ! mkdir -p "$db_dump_dir"; then
    echo "System backup was not created because a database-dump staging directory could not be created." >&2
    return 1
  fi
  chmod 700 "$db_dump_dir" 2>/dev/null || true

  echo "Creating database dump for system backup..."
  LAST_DB_BACKUP_FILE=""
  LAST_DB_BACKUP_SIDECAR_FILE=""
  if ! backup_db "$db_dump_dir"; then
    backup_system_cleanup_on_failure
    echo "System backup was not created because the database dump failed." >&2
    return 1
  fi
  db_dump_file="$LAST_DB_BACKUP_FILE"
  db_dump_sidecar="$LAST_DB_BACKUP_SIDECAR_FILE"
  if [ -z "$db_dump_file" ] || [ ! -f "$db_dump_file" ]; then
    backup_system_cleanup_on_failure
    echo "System backup was not created because the database dump could not be located." >&2
    return 1
  fi

  if ! stage_dir="$(mktemp -d)"; then
    backup_system_cleanup_on_failure
    echo "System backup was not created because a staging directory could not be created." >&2
    return 1
  fi
  if ! chmod 700 "$stage_dir"; then
    backup_system_cleanup_on_failure
    echo "System backup was not created because the staging directory could not be secured." >&2
    return 1
  fi

  if ! mkdir -p "$stage_dir/db"; then
    backup_system_cleanup_on_failure
    echo "System backup was not created because staging failed." >&2
    return 1
  fi
  if ! cp -a -- "$db_dump_file" "$stage_dir/db/"; then
    backup_system_cleanup_on_failure
    echo "System backup was not created because the database dump could not be staged." >&2
    return 1
  fi
  if [ -n "$db_dump_sidecar" ] && [ -f "$db_dump_sidecar" ]; then
    if ! cp -a -- "$db_dump_sidecar" "$stage_dir/db/"; then
      backup_system_cleanup_on_failure
      echo "System backup was not created because the database dump sidecar could not be staged." >&2
      return 1
    fi
  fi

  if [ -f .env ]; then
    if ! cp -a -- .env "$stage_dir/env"; then
      backup_system_cleanup_on_failure
      echo "System backup was not created because .env could not be staged." >&2
      return 1
    fi
  fi

  if [ -d runtime/generated ]; then
    if ! mkdir -p "$stage_dir/generated"; then
      backup_system_cleanup_on_failure
      echo "System backup was not created because staging failed." >&2
      return 1
    fi
    # tar pipe, not rsync: rsync is not installed by install.sh or in the
    # console container image (confirmed directly against both) -- this
    # feature must not introduce a dependency that only happens to be
    # present on a CI runner. tar is already a hard dependency of this
    # same function (used a few lines below to build the plaintext
    # archive), so a tar-to-tar pipe reuses a tool this feature already
    # requires instead of adding a new one. `--exclude` preserves the
    # same ephemeral-directory exclusion rsync's flag provided.
    if ! tar -C runtime/generated --exclude='dune-fake-k8s-serviceaccount-*' -cf - . \
        | tar -C "$stage_dir/generated" -xf -; then
      backup_system_cleanup_on_failure
      echo "System backup was not created because runtime/generated/ could not be staged." >&2
      return 1
    fi
  fi

  if [ -d runtime/secrets ]; then
    if ! mkdir -p "$stage_dir/secrets"; then
      backup_system_cleanup_on_failure
      echo "System backup was not created because staging failed." >&2
      return 1
    fi
    if ! tar -C runtime/secrets -cf - . | tar -C "$stage_dir/secrets" -xf -; then
      backup_system_cleanup_on_failure
      echo "System backup was not created because runtime/secrets/ could not be staged." >&2
      return 1
    fi
  fi

  if ! plain_tar="$(mktemp)"; then
    backup_system_cleanup_on_failure
    echo "System backup was not created because a temporary file could not be created." >&2
    return 1
  fi
  if ! chmod 600 "$plain_tar"; then
    backup_system_cleanup_on_failure
    echo "System backup was not created because the temporary archive could not be secured." >&2
    return 1
  fi
  if ! tar -cf "$plain_tar" -C "$stage_dir" .; then
    backup_system_cleanup_on_failure
    echo "System backup was not created because the archive could not be written." >&2
    return 1
  fi
  rm -rf -- "$stage_dir"
  stage_dir=""

  archive_file="$out_dir/$archive_id.tar.gz.enc"
  sidecar_file="$archive_file.yaml"
  staged_archive="$archive_file.partial.$$"
  staged_sidecar="$sidecar_file.partial.$$"

  # --passphrase-fd N, not putting the passphrase in argv: the latter
  # would make it visible to any co-resident process/user via `ps`/
  # `/proc/<pid>/cmdline` for the process's lifetime -- the exact
  # GHSA-fc89-h24v-6j3x exposure class this account's own security
  # history already flagged and fixed elsewhere (see
  # docs/security/audit-2026-07-04.md).
  #
  # gpg's own AES-256-OCB (--aead-algo OCB --force-aead) is used instead
  # of openssl's AES-256-CBC: CBC provides confidentiality only, with no
  # integrity/authenticity check -- a corrupted or maliciously modified
  # archive silently decrypts to garbage (or worse) with no error.
  # `openssl enc`'s CLI cannot do any AEAD cipher at all (confirmed
  # directly: `openssl enc -aes-256-gcm` -> "AEAD ciphers not
  # supported", a permanent CLI-level policy, not a version gap -- the
  # same limitation already documented for this repo's secrets library).
  # gpg's OCB mode is AEAD and rejects tampered/corrupted ciphertext
  # outright at decrypt time (verified directly: a single flipped byte
  # anywhere in the ciphertext makes gpg exit non-zero with "WARNING:
  # encrypted message has been manipulated!" and writes no output file).
  #
  # A private, per-invocation GNUPGHOME (never the operator's own
  # ~/.gnupg) is required because gpg writes a keybox/trustdb into its
  # home directory even for pure symmetric-passphrase encryption with no
  # keys ever created or imported.
  if ! gnupg_home="$(mktemp -d)"; then
    backup_system_cleanup_on_failure
    echo "System backup was not created because a private GnuPG home could not be created." >&2
    return 1
  fi
  if ! chmod 700 "$gnupg_home"; then
    backup_system_cleanup_on_failure
    echo "System backup was not created because the private GnuPG home could not be secured." >&2
    return 1
  fi

  local passphrase_fd
  if ! exec {passphrase_fd}<<< "$passphrase"; then
    backup_system_cleanup_on_failure
    echo "System backup was not created because the passphrase could not be prepared for encryption." >&2
    return 1
  fi
  if ! gzip -c "$plain_tar" | GNUPGHOME="$gnupg_home" gpg --batch --yes \
      --pinentry-mode loopback --passphrase-fd "$passphrase_fd" \
      --s2k-digest-algo SHA256 --s2k-count "$SYSTEM_BACKUP_S2K_COUNT" \
      --symmetric --cipher-algo AES256 --aead-algo OCB --force-aead \
      -o "$staged_archive"; then
    exec {passphrase_fd}<&- 2>/dev/null || true
    backup_system_cleanup_on_failure
    echo "System backup was not created because encryption failed." >&2
    return 1
  fi
  exec {passphrase_fd}<&-
  rm -rf -- "$gnupg_home"
  gnupg_home=""
  rm -f -- "$plain_tar"
  plain_tar=""

  if ! {
    echo "artifact_id: $archive_id"
    echo "backup_file: $(basename "$archive_file")"
    echo "created_at: $(date -Iseconds)"
    echo "backup_origin: ${DB_BACKUP_ORIGIN:-manual}"
    echo "encryption: aes-256-ocb-gpg-aead"
    echo "s2k_digest: sha256"
    echo "s2k_count: $SYSTEM_BACKUP_S2K_COUNT"
    echo "includes_secrets: true"
    echo "db_backup_file: $(basename "$db_dump_file")"
    echo "server_title: $(config_value .env SERVER_TITLE || echo unknown)"
    echo "server_region: $(config_value .env SERVER_REGION || echo unknown)"
    echo "battlegroup_id: $(config_value runtime/generated/battlegroup.env BATTLEGROUP_ID || echo unknown)"
    echo "decrypt_note: >-"
    echo "  Do not pass the passphrase on the command line -- it would be"
    echo "  visible to other processes via ps/proc for as long as gpg runs."
    echo "  Enter it at a prompt instead. gpg will reject this archive"
    echo "  outright (nonzero exit, no output written) if it has been"
    echo "  corrupted or tampered with -- this format is authenticated,"
    echo "  not just encrypted."
    echo "decrypt_command: |-"
    echo "  read -r -s -p \"Passphrase: \" p; echo"
    echo "  printf '%s' \"\$p\" | gpg --batch --yes --pinentry-mode loopback \\"
    echo "    --passphrase-fd 0 -d $(basename "$archive_file") | gunzip | tar -xf -"
    echo "  unset p"
  } > "$staged_sidecar"; then
    backup_system_cleanup_on_failure
    echo "System backup was not created because its metadata could not be written." >&2
    return 1
  fi

  chmod 600 "$staged_archive" || true
  chmod 600 "$staged_sidecar" || true

  if ! mv -f -- "$staged_archive" "$archive_file"; then
    backup_system_cleanup_on_failure
    echo "System backup was not created because the archive could not be published." >&2
    return 1
  fi
  staged_archive=""
  if ! mv -f -- "$staged_sidecar" "$sidecar_file"; then
    rm -f -- "$archive_file"
    backup_system_cleanup_on_failure
    echo "System backup was not created because its metadata could not be published." >&2
    return 1
  fi
  staged_sidecar=""

  # The plaintext DB dump that backup_db() wrote into its own private,
  # per-invocation directory is now safely duplicated, encrypted, inside
  # the published archive above -- remove that whole directory so nothing
  # unencrypted survives next to the encrypted archive, defeating the
  # entire point of encrypting it.
  rm -rf -- "$db_dump_dir"
  db_dump_dir=""
  db_dump_file=""
  db_dump_sidecar=""

  echo "Encrypted system backup written:"
  echo "  $archive_file"
  echo "Sidecar (no secrets, safe to read):"
  echo "  $sidecar_file"
  echo
  echo "This archive includes runtime/secrets/ (Funcom token, admin password, RMQ"
  echo "admin credentials, etc.) and .env, encrypted with the passphrase you just set."
  echo "There is no way to recover this archive's contents without that passphrase --"
  echo "store it somewhere durable (a password manager), separately from the archive."
  echo
  echo "To decrypt and extract, enter the passphrase at the prompt -- do not put it"
  echo "on the command line, which would expose it to other processes on this host."
  echo "gpg will reject this archive outright (nonzero exit, no output written) if"
  echo "it has been corrupted or tampered with -- this format is authenticated:"
  echo "  read -r -s -p \"Passphrase: \" p; echo"
  echo "  printf '%s' \"\$p\" | gpg --batch --yes --pinentry-mode loopback \\"
  echo "    --passphrase-fd 0 -d $(basename "$archive_file") | gunzip | tar -xf -"
  echo "  unset p"
}

list_system_backups() {
  local out_dir="${1:-$SYSTEM_BACKUP_DIR_DEFAULT}"

  echo "=== System backups (encrypted) ==="
  if [ -d "$out_dir" ]; then
    find "$out_dir" -maxdepth 1 -type f -name '*.tar.gz.enc' -printf '%TY-%Tm-%Td %TH:%TM:%TS  %p\n' 2>/dev/null | sed -E 's/([0-9]{2}:[0-9]{2}:[0-9]{2})\.[0-9]+/\1/' | sort || true
  else
    echo "No system backup directory found: $out_dir"
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
  local answer
  local -a names=()

  if [ "$target" = "--all" ]; then
    delete_all_backups
    return
  fi

  [ "$#" -gt 0 ] || { echo "Missing backup name." >&2; exit 2; }
  for target in "$@"; do
    name="$(resolve_backup_name "$target" "$BACKUP_DIR_DEFAULT")" || exit 1
    file="$(backup_path_for_name "$name" "$BACKUP_DIR_DEFAULT")"
    [ -f "$file" ] || { echo "Backup file does not exist: $file"; exit 1; }
    if [[ " ${names[*]} " != *" $name "* ]]; then names+=("$name"); fi
  done

  if [ "${DUNE_DB_ASSUME_YES:-0}" != "1" ]; then
    read -r -p "Delete ${#names[@]} selected backup(s)? [y/N]: " answer
    case "$answer" in
      y|Y|yes|YES) ;;
      *) echo "Delete cancelled."; exit 1 ;;
    esac
  fi

  for name in "${names[@]}"; do
    delete_backup_files_for_name "$name" "$BACKUP_DIR_DEFAULT"
    echo "Deleted backup: $name"
  done
  echo "Deleted ${#names[@]} selected database backup(s)."
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

# How many Market Bot backups survive a prune. Market Bot backups are matched
# by the sidecar's backup_origin (market-bot-seed / market-bot-buyback /
# market-bot-unseed), not the filename, so unlabeled backups written by older
# releases are cleaned up too.
MARKET_BOT_BACKUP_KEEP="${DUNE_MARKET_BOT_BACKUP_KEEP:-5}"
VEHICLE_DELETE_BACKUP_KEEP="${DUNE_VEHICLE_DELETE_BACKUP_KEEP:-10}"
BASE_DELETE_BACKUP_KEEP="${DUNE_BASE_DELETE_BACKUP_KEEP:-10}"

backup_origin_value() {
  local backup_file="$1"
  local origin=""

  origin="$(backup_metadata_value "$backup_file" backup_origin || true)"
  [ -n "$origin" ] || origin="$(backup_metadata_value "$backup_file" origin || true)"
  printf '%s' "$origin"
}

backup_is_market_bot() {
  case "$(backup_origin_value "$1" | tr '[:upper:]' '[:lower:]')" in
    market-bot-*) return 0 ;;
    *) return 1 ;;
  esac
}

backup_is_vehicle_delete() {
  case "$(backup_origin_value "$1" | tr '[:upper:]' '[:lower:]' | tr '_' '-')" in
    vehicle-delete) return 0 ;;
    *) return 1 ;;
  esac
}

backup_is_base_delete() {
  case "$(backup_origin_value "$1" | tr '[:upper:]' '[:lower:]' | tr '_' '-')" in
    base-delete) return 0 ;;
    *) return 1 ;;
  esac
}

prune_vehicle_delete_backups() {
  local backup_dir="${1:-$BACKUP_DIR_DEFAULT}"
  local keep="${2:-$VEHICLE_DELETE_BACKUP_KEEP}"
  local removed=0
  local index=0
  local name

  validate_positive_integer "$keep" || return 0
  [ -d "$backup_dir" ] || return 0

  while IFS= read -r name; do
    [ -n "$name" ] || continue
    index=$((index + 1))
    [ "$index" -gt "$keep" ] || continue
    if delete_backup_files_for_name "$name" "$backup_dir" >/dev/null; then
      removed=$((removed + 1))
    fi
  done < <(
    iter_valid_backup_names "$backup_dir" \
      | while IFS= read -r candidate; do
          [ -n "$candidate" ] || continue
          backup_is_vehicle_delete "$(backup_path_for_name "$candidate" "$backup_dir")" || continue
          printf '%s\t%s\n' "$(backup_timestamp_from_name "$candidate")" "$candidate"
        done \
      | sort -r \
      | cut -f2-
  )

  if [ "$removed" -gt 0 ]; then
    echo "Pruned $removed Vehicle Delete backup(s); the newest $keep are kept."
  fi
}

# The base-delete twin. A queued base delete takes one of these before every
# apply attempt, and a base that cannot be deleted (picked up into a backup,
# say) retries until the 7-day age limit -- so without a count cap this origin
# alone can mint hundreds of full-database dumps for a single queued request.
prune_base_delete_backups() {
  local backup_dir="${1:-$BACKUP_DIR_DEFAULT}"
  local keep="${2:-$BASE_DELETE_BACKUP_KEEP}"
  local removed=0
  local index=0
  local name

  validate_positive_integer "$keep" || return 0
  [ -d "$backup_dir" ] || return 0

  while IFS= read -r name; do
    [ -n "$name" ] || continue
    index=$((index + 1))
    [ "$index" -gt "$keep" ] || continue
    if delete_backup_files_for_name "$name" "$backup_dir" >/dev/null; then
      removed=$((removed + 1))
    fi
  done < <(
    iter_valid_backup_names "$backup_dir"       | while IFS= read -r candidate; do
          [ -n "$candidate" ] || continue
          backup_is_base_delete "$(backup_path_for_name "$candidate" "$backup_dir")" || continue
          printf '%s	%s
' "$(backup_timestamp_from_name "$candidate")" "$candidate"
        done       | sort -r       | cut -f2-
  )

  if [ "$removed" -gt 0 ]; then
    echo "Pruned $removed Base Delete backup(s); the newest $keep are kept."
  fi
}

# Keep only the newest $keep Market Bot backups (by the timestamp embedded in
# the backup name, which is stable even if file mtimes were touched). Runs
# after every successful Market Bot backup; count-based rather than age-based
# because unattended seed/buyback schedules mint backups indefinitely.
prune_market_bot_backups() {
  local backup_dir="${1:-$BACKUP_DIR_DEFAULT}"
  local keep="${2:-$MARKET_BOT_BACKUP_KEEP}"
  local removed=0
  local index=0
  local name

  validate_positive_integer "$keep" || return 0
  [ -d "$backup_dir" ] || return 0

  while IFS= read -r name; do
    [ -n "$name" ] || continue
    index=$((index + 1))
    [ "$index" -gt "$keep" ] || continue
    if delete_backup_files_for_name "$name" "$backup_dir" >/dev/null; then
      removed=$((removed + 1))
    fi
  done < <(
    iter_valid_backup_names "$backup_dir" \
      | while IFS= read -r candidate; do
          [ -n "$candidate" ] || continue
          backup_is_market_bot "$(backup_path_for_name "$candidate" "$backup_dir")" || continue
          printf '%s\t%s\n' "$(backup_timestamp_from_name "$candidate")" "$candidate"
        done \
      | sort -r \
      | cut -f2-
  )

  if [ "$removed" -gt 0 ]; then
    echo "Pruned $removed Market Bot backup(s); the newest $keep are kept."
  fi
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

  set_env_file_value runtime/generated/battlegroup.env BATTLEGROUP_ID "$backup_battlegroup_id" 664
  [ -z "$server_title" ] || set_env_file_value runtime/generated/battlegroup.env SERVER_TITLE "$server_title" 664 quoted
  [ -z "$server_region" ] || set_env_file_value runtime/generated/battlegroup.env SERVER_REGION "$server_region" 664 quoted
  [ -z "$server_ip" ] || set_env_file_value runtime/generated/battlegroup.env SERVER_IP "$server_ip" 664
  [ -z "$server_ip_mode" ] || set_env_file_value runtime/generated/battlegroup.env SERVER_IP_MODE "$server_ip_mode" 664

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
  local create_safety_backup=1
  shift || true
  local transfer_args=()
  local transfer_plan=""
  local transfer_file=""
  local battlegroup_action=""
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
        [ -z "$battlegroup_action" ] || { echo "Choose only one Battlegroup identity option."; exit 2; }
        battlegroup_action="adopt-backup"
        shift
        ;;
      --keep-current-battlegroup)
        [ -z "$battlegroup_action" ] || { echo "Choose only one Battlegroup identity option."; exit 2; }
        battlegroup_action="keep-current"
        shift
        ;;
      --no-safety-backup)
        create_safety_backup=0
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

  case "$backup_file" in
    *.backup|*.dump)
      echo "Validating database backup before restore..."
      if ! validate_custom_backup_file "$backup_file"; then
        echo "Restore aborted before any database changes were made." >&2
        exit 1
      fi
      ;;
  esac

  choose_import_battlegroup_action "$backup_file" "$battlegroup_action" || exit 1

  identity_snapshot="$(capture_current_account_identities)"

  echo "WARNING: importing a database backup replaces current battlegroup database state."
  if [ "$create_safety_backup" = "1" ]; then
    echo "A pre-import backup will be created first."
  else
    echo "No pre-import safety backup will be created."
  fi
  echo "Do not create new characters after restore/import until character data is verified."
  echo "Character transfer is only for players whose FLS/Funcom account changed."
  if [ "${DUNE_DB_ASSUME_YES:-0}" != "1" ]; then
    read -r -p "Continue with import? [y/N]: " answer
    case "$answer" in
      y|Y|yes|YES) ;;
      *) echo "Import cancelled."; exit 1 ;;
    esac
  fi

  if [ "$create_safety_backup" = "1" ]; then
    DB_BACKUP_ORIGIN=restore-safety backup_db "$BACKUP_DIR_DEFAULT"
  fi
  if [ "$IMPORT_BATTLEGROUP_ACTION" = "adopt-backup" ]; then
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
  docker run --rm --user 0:0 --privileged --pid=host --network=host \
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
  docker run --rm --user 0:0 --privileged --pid=host --network=host \
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
  docker run --rm --user 0:0 --privileged --pid=host --network=host \
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
  backup-system)
    backup_system "${2:-$SYSTEM_BACKUP_DIR_DEFAULT}"
    ;;
  list)
    list_backups "${2:-$BACKUP_DIR_DEFAULT}"
    ;;
  list-system)
    list_system_backups "${2:-$SYSTEM_BACKUP_DIR_DEFAULT}"
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
    shift || true
    delete_backup "$@"
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
