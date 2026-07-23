#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

usage() {
  cat <<'EOF'
Usage:
  dune storage status
  dune storage cleanup [--dry-run] [--build-cache]

The default cleanup removes only obsolete Funcom/Dune game images. It never
removes containers, volumes, databases, game files, or backups.

--build-cache also removes unused Docker build cache. Docker protects cache
used by active builds, but the default builder is shared, so this option can
affect build cache from other projects on the same host.
EOF
}

require_docker() {
  command -v docker >/dev/null 2>&1 || { echo "Docker is not installed." >&2; exit 1; }
  docker info >/dev/null 2>&1 || { echo "Docker daemon is not reachable." >&2; exit 1; }
}

current_image_refs() {
  local world_tag="" postgres_tag=""
  if [ -r runtime/generated/image-tags.env ]; then
    # shellcheck disable=SC1091
    . runtime/generated/image-tags.env
    world_tag="${DUNE_WORLD_IMAGE_TAG:-}"
    postgres_tag="${DUNE_POSTGRES_IMAGE_TAG:-}"
  fi

  if [ -n "$world_tag" ]; then
    printf '%s:%s\n' \
      registry.funcom.com/funcom/self-hosting/seabass-server "$world_tag" \
      registry.funcom.com/funcom/self-hosting/seabass-server-bg-director "$world_tag" \
      dune-director-compat "$world_tag" \
      registry.funcom.com/funcom/self-hosting/seabass-server-db-utils "$world_tag" \
      registry.funcom.com/funcom/self-hosting/seabass-server-gateway "$world_tag" \
      registry.funcom.com/funcom/self-hosting/seabass-server-rabbitmq "$world_tag" \
      registry.funcom.com/funcom/self-hosting/seabass-server-text-router "$world_tag"
  fi
  if [ -n "$postgres_tag" ]; then
    printf '%s:%s\n' registry.funcom.com/funcom/self-hosting/igw-postgres "$postgres_tag"
  fi
}

protected_image_ids() {
  local container ref

  while IFS= read -r container; do
    [ -n "$container" ] || continue
    docker inspect --format '{{.Image}}' "$container" 2>/dev/null || true
  done < <(docker container ls -aq)

  while IFS= read -r ref; do
    [ -n "$ref" ] || continue
    docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true
  done < <(current_image_refs)
}

cleanup_candidate_images() {
  docker image ls --no-trunc --format '{{.Repository}}|{{.Tag}}|{{.ID}}'
  docker image ls --no-trunc \
    --filter label=io.github.red-blink.dune-selfhost.component \
    --format '{{.Repository}}|{{.Tag}}|{{.ID}}'
}

obsolete_dune_image_ids() {
  local protected_file id repo tag
  declare -A seen=()
  protected_file="$(mktemp)"
  protected_image_ids | sort -u > "$protected_file"

  while IFS='|' read -r repo tag id; do
    case "$repo" in
      registry.funcom.com/funcom/self-hosting/igw-postgres|\
      registry.funcom.com/funcom/self-hosting/seabass-server|\
      registry.funcom.com/funcom/self-hosting/seabass-server-bg-director|\
      dune-director-compat|\
      registry.funcom.com/funcom/self-hosting/seabass-server-db-utils|\
      registry.funcom.com/funcom/self-hosting/seabass-server-gateway|\
      registry.funcom.com/funcom/self-hosting/seabass-server-rabbitmq|\
      registry.funcom.com/funcom/self-hosting/seabass-server-text-router) ;;
      *)
        if ! docker image inspect --format '{{index .Config.Labels "io.github.red-blink.dune-selfhost.component"}}' "$id" 2>/dev/null \
          | grep -Eq '^(console|orchestrator)$'; then
          continue
        fi
        ;;
    esac
    grep -qxF "$id" "$protected_file" && continue
    [ -z "${seen[$id]:-}" ] || continue
    seen[$id]=1
    printf '%s|%s:%s\n' "$id" "$repo" "$tag"
  done < <(cleanup_candidate_images)
  rm -f "$protected_file"
}

storage_status() {
  echo "=== Docker storage ==="
  docker system df
  echo
  echo "The reclaimable image figure can include obsolete Funcom releases."
  echo "Use 'dune storage cleanup --dry-run' to list project-owned candidates."
}

cleanup_storage() {
  local dry_run=0 build_cache=0 row id ref removed=0
  shift || true
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=1 ;;
      --build-cache) build_cache=1 ;;
      *) echo "Unknown storage cleanup option: $1" >&2; usage; exit 2 ;;
    esac
    shift
  done

  echo "=== Obsolete Dune game images ==="
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    id="${row%%|*}"
    ref="${row#*|}"
    if [ "$dry_run" = "1" ]; then
      echo "WOULD REMOVE $ref ($id)"
    elif docker image rm "$id" >/dev/null; then
      echo "REMOVED $ref"
      removed=$((removed + 1))
    else
      echo "SKIPPED $ref (Docker reports it is still in use)"
    fi
  done < <(obsolete_dune_image_ids)

  if [ "$removed" -eq 0 ] && [ "$dry_run" = "0" ]; then
    echo "No obsolete Dune game images were removed."
  fi

  if [ "$build_cache" = "1" ]; then
    echo
    echo "=== Unused Docker build cache ==="
    if [ "$dry_run" = "1" ]; then
      echo "WOULD RUN docker builder prune --force --all"
    else
      echo "This builder may be shared with other projects on this Docker host."
      docker builder prune --force --all
    fi
  fi
}

require_docker
cmd="${1:-status}"
case "$cmd" in
  status) storage_status ;;
  cleanup) cleanup_storage "$@" ;;
  help|--help|-h) usage ;;
  *) echo "Unknown storage command: $cmd" >&2; usage; exit 2 ;;
esac
