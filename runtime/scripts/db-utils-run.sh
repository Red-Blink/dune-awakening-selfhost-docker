#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
[ -r runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env
source runtime/scripts/image-tags.sh
DB_UTILS_IMAGE="registry.funcom.com/funcom/self-hosting/seabass-server-db-utils:$(resolve_world_image_tag)"

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

exec \"\$@\"
" sh "$@"
