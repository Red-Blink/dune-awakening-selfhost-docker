#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

cd "$(dirname "$0")/../.."
[ -r runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env
source runtime/scripts/image-tags.sh
DB_UTILS_IMAGE="registry.funcom.com/funcom/self-hosting/seabass-server-db-utils:$(resolve_world_image_tag)"
PARTITION_PRESET="${PARTITION_PRESET:-full_battlegroup}"

echo "Initializing Dune database with partition preset: ${PARTITION_PRESET}"

docker run --rm \
  --network dune-net \
  --entrypoint sh \
  "$DB_UTILS_IMAGE" \
  -lc "
set -e

mkdir -p /tmp/pg17/bin
ln -sf /usr/bin/psql /tmp/pg17/bin/psql
ln -sf /usr/bin/pg_dump /tmp/pg17/bin/pg_dump
ln -sf /usr/bin/pg_restore /tmp/pg17/bin/pg_restore
ln -sf /usr/bin/pg_isready /tmp/pg17/bin/pg_isready

python -u /root/PSQL/initdb.py \
  --host dune-postgres:5432 \
  --project-database dune \
  --project-user dune \
  --project-password dune \
  --admin-user postgres \
  --admin-password postgres \
  --admin-database postgres \
  --postgres-installation /tmp/pg17 \
  --unattended \
  --partition-preset '${PARTITION_PRESET}'
"

echo
echo "Database initialization finished."

echo
echo "Checking schema/version tables..."
docker exec dune-postgres psql -U dune -d dune -c "\\dt" | head -80
