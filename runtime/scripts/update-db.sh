#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -r runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env
source runtime/scripts/image-tags.sh
WORLD_IMAGE_TAG="$(resolve_world_image_tag)"

IMAGE="registry.funcom.com/funcom/self-hosting/seabass-server-db-utils:${WORLD_IMAGE_TAG}"
CONTAINER_NAME="dune-db-update"
TIMEOUT_SECONDS="${DUNE_DB_UPDATE_TIMEOUT_SECONDS:-300}"
SUCCESS_MARKER_REGEX='Database is already up to date|User-data encryption:'
FAILURE_MARKER_REGEX='Traceback \(most recent call last\)|ERROR|CRITICAL|FATAL'
QUIESCENT_SUCCESS_AFTER_SECONDS="${DUNE_DB_UPDATE_QUIESCENT_SUCCESS_AFTER_SECONDS:-20}"
ORPHAN_AUDIT_DIR="runtime/generated/db-orphan-audits"
ORPHAN_BACKUP_ON_DETECT="${DUNE_DB_BACKUP_ON_ORPHAN_DETECT:-1}"

audit_db_orphans() {
  local summary detailed ts report_file total
  mkdir -p "$ORPHAN_AUDIT_DIR"

  summary="$(bash runtime/scripts/db-orphan-audit.sh summary 2>/dev/null || true)"
  [ -n "$summary" ] || return 0

  total="$(printf '%s\n' "$summary" | awk -F '\t' '{ sum += ($2 + 0) } END { print sum + 0 }')"
  if [ "${total:-0}" -le 0 ]; then
    return 0
  fi

  ts="$(date +%Y%m%d-%H%M%S)"
  report_file="$ORPHAN_AUDIT_DIR/orphans-$ts.tsv"
  bash runtime/scripts/db-orphan-audit.sh export "$report_file" >/dev/null 2>&1 || true

  echo "=== Database orphan audit before updater ==="
  printf '%s\n' "$summary" | awk -F '\t' '{ printf "  %-40s %s\n", $1 ":", $2 }'
  echo "Detailed report: $report_file"

  if [ "$ORPHAN_BACKUP_ON_DETECT" = "1" ]; then
    echo "Orphaned player/account rows were detected before the DB updater."
    echo "Creating a safety backup before running updater cleanup."
    bash runtime/scripts/db.sh backup runtime/backups/db >/dev/null
  fi
}

echo "=== Running Dune DB update/migration ==="
echo "Image: $IMAGE"

audit_db_orphans

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

docker run -d \
  --name "$CONTAINER_NAME" \
  --network dune-net \
  --entrypoint sh \
  "$IMAGE" \
  -lc '
set -e

mkdir -p /tmp/pg17/bin
ln -sf /usr/bin/psql /tmp/pg17/bin/psql
ln -sf /usr/bin/pg_dump /tmp/pg17/bin/pg_dump
ln -sf /usr/bin/pg_restore /tmp/pg17/bin/pg_restore
ln -sf /usr/bin/pg_isready /tmp/pg17/bin/pg_isready

python -u /root/PSQL/updatedb.py \
  --host dune-postgres:5432 \
  --project-database dune \
  --project-user dune \
  --project-password dune \
  --admin-user postgres \
  --admin-password postgres \
  --admin-database postgres \
  --postgres-installation /tmp/pg17 \
  --ignore-backup-failure \
  --unattended \
  > /tmp/dune-db-update.log 2>&1
'

start_ts="$(date +%s)"
last_logs=""

db_update_sessions_active() {
  local count
  count="$(docker exec dune-postgres psql -U postgres -d postgres -Atc "
    select count(*)
    from pg_stat_activity
    where pid <> pg_backend_pid()
      and (
        application_name = 'psql'
        or left(query, 32) in (
          'select pid, application_name, use',
          'select count(*) from pg_stat_acti'
        ) = false
      )
      and datname in ('dune', 'postgres')
      and usename in ('dune', 'postgres')
      and state <> 'idle';
  " 2>/dev/null | tr -d '[:space:]')"
  [ "${count:-0}" -gt 0 ]
}

db_update_schema_looks_valid() {
  local row
  row="$(docker exec dune-postgres psql -U dune -d dune -AtF '|' -c "
    select coalesce(dune.get_schema_version()::text, ''), coalesce((select name from dune.applied_patches order by date desc limit 1), '');
  " 2>/dev/null | head -n1 | tr -d '\r')"
  [ -n "$row" ] || return 1
  local schema_version latest_patch
  IFS='|' read -r schema_version latest_patch <<< "$row"
  [ -n "${schema_version:-}" ] && [ -n "${latest_patch:-}" ]
}

while true; do
  now_ts="$(date +%s)"
  elapsed="$((now_ts - start_ts))"
  running="$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo false)"
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$CONTAINER_NAME" 2>/dev/null || echo 1)"
  last_logs="$(docker exec "$CONTAINER_NAME" sh -lc 'cat /tmp/dune-db-update.log 2>/dev/null || true' 2>/dev/null || true)"

  if printf '%s\n' "$last_logs" | grep -Eq "$FAILURE_MARKER_REGEX"; then
    echo "$last_logs"
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    echo "Database update failed."
    exit 1
  fi

  if [ "$running" != "true" ]; then
    echo "$last_logs"
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    if [ "$exit_code" = "0" ]; then
      exit 0
    fi
    echo "Database update exited with status $exit_code."
    exit 1
  fi

  if printf '%s\n' "$last_logs" | grep -Eq "$SUCCESS_MARKER_REGEX"; then
    echo "$last_logs"
    echo "Database update completed, stopping stale helper container."
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    exit 0
  fi

  if [ "$elapsed" -ge "$QUIESCENT_SUCCESS_AFTER_SECONDS" ] \
    && ! db_update_sessions_active \
    && db_update_schema_looks_valid; then
    echo "$last_logs"
    echo "Database update helper became quiescent with valid schema state; stopping stale helper container."
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    exit 0
  fi

  if [ "$elapsed" -ge "$TIMEOUT_SECONDS" ]; then
    echo "$last_logs"
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
    echo "Database update timed out after ${TIMEOUT_SECONDS}s."
    exit 1
  fi

  sleep 2
done
