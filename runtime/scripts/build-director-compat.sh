#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -r runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env
source runtime/scripts/image-tags.sh

world_image_tag="$(resolve_world_image_tag)"
source_image="registry.funcom.com/funcom/self-hosting/seabass-server-bg-director:${world_image_tag}"
compat_image="dune-director-compat:${world_image_tag}"
compat_revision="3"

case "$world_image_tag" in
  2048594-0-shipping)
    ;;
  *)
    printf '%s\n' "$source_image"
    exit 0
    ;;
esac

if docker image inspect "$compat_image" >/dev/null 2>&1; then
  built_from="$(docker image inspect "$compat_image" --format '{{index .Config.Labels "io.github.red-blink.dune-selfhost.source-image"}}' 2>/dev/null || true)"
  built_revision="$(docker image inspect "$compat_image" --format '{{index .Config.Labels "io.github.red-blink.dune-selfhost.compat-revision"}}' 2>/dev/null || true)"
  if [ "$built_from" = "$source_image" ] \
    && [ "$built_revision" = "$compat_revision" ]; then
    echo "Director compatibility image is ready: $compat_image" >&2
    printf '%s\n' "$compat_image"
    exit 0
  fi
fi

if ! docker image inspect "$source_image" >/dev/null 2>&1; then
  echo "Missing official Director image: $source_image" >&2
  exit 1
fi

echo "Building Director compatibility image for ${world_image_tag}..." >&2
docker build \
  --build-arg "DIRECTOR_IMAGE=$source_image" \
  --build-arg "COMPAT_REVISION=$compat_revision" \
  --file tools/director-compat-patcher/Dockerfile \
  --tag "$compat_image" \
  tools/director-compat-patcher >&2

echo "Director compatibility image is ready: $compat_image" >&2
printf '%s\n' "$compat_image"
