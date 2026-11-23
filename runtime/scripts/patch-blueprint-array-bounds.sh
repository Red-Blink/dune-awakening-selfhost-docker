#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

patch_sql="runtime/sql/patch-blueprint-array-bounds.sql"

if [ ! -r "$patch_sql" ]; then
  echo "Missing blueprint array-bound compatibility patch: $patch_sql" >&2
  exit 1
fi
if ! docker inspect -f '{{.State.Running}}' dune-postgres 2>/dev/null | grep -qx true; then
  echo "Cannot repair Console blueprint format: dune-postgres is not running." >&2
  exit 1
fi

echo "Checking Console-imported blueprint array bounds..."
docker exec -i dune-postgres psql \
  -h 127.0.0.1 \
  -p 5432 \
  -U postgres \
  -d dune \
  -v ON_ERROR_STOP=1 \
  -X \
  -f - < "$patch_sql"
