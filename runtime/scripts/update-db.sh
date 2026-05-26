#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env
source runtime/scripts/image-tags.sh
WORLD_IMAGE_TAG="$(resolve_world_image_tag)"

IMAGE="registry.funcom.com/funcom/self-hosting/seabass-server-db-utils:${WORLD_IMAGE_TAG}"

echo "=== Running Dune DB update/migration ==="
echo "Image: $IMAGE"

docker run --rm \
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

python /root/PSQL/updatedb.py \
  --host dune-postgres:5432 \
  --project-database dune \
  --project-user dune \
  --project-password dune \
  --admin-user postgres \
  --admin-password postgres \
  --admin-database postgres \
  --postgres-installation /tmp/pg17 \
  --ignore-backup-failure \
  --unattended
'
