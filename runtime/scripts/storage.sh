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
      registry.funcom.com/funcom/self-hosting/seabass-server-db-utils "$world_tag" \
      registry.funcom.com/funcom/self-hosting/seabass-server-gateway "$world_tag" \
      registry.funcom.com/funcom/self-hosting/seabass-server-rabbitmq "$world_tag" \
      registry.funcom.com/funcom/self-hosting/seabass-server-text-router "$world_tag"
  fi
  if [ -n "$postgres_tag" ]; then
    printf '%s:%s\n' registry.funcom.com/funcom/self-hosting/igw-postgres "$postgres_tag"
  fi

  # These tags are operational dependencies even when the containers currently
  # using their older image IDs are still running. Startup and host-side repair
  # scripts launch short-lived helpers from these exact references.
  printf '%s\n' \
    "dune-orchestrator:dev" \
    "redblink-dune-docker-console:dev"
}

protected_image_ids() {
  local -a containers=() refs=()
  if [ -f runtime/generated/experimental-tanks.json ]; then
    runtime/scripts/experimental-tanks.sh resolve Survival_1
  fi

  mapfile -t containers < <(docker container ls -aq)
  if [ "${#containers[@]}" -gt 0 ]; then
    docker inspect --format '{{.Image}}' "${containers[@]}" 2>/dev/null || true
  fi

  mapfile -t refs < <(current_image_refs)
  if [ "${#refs[@]}" -gt 0 ]; then
    docker image inspect --format '{{.Id}}' "${refs[@]}" 2>/dev/null || true
  fi
}

cleanup_candidate_images() {
  local component
  docker image ls --no-trunc --format '{{.Repository}}|{{.Tag}}|{{.ID}}' | awk -F'|' '
    $1 ~ /^registry\.funcom\.com\/funcom\/self-hosting\/(igw-postgres|seabass-server|seabass-server-bg-director|seabass-server-db-utils|seabass-server-gateway|seabass-server-rabbitmq|seabass-server-text-router)$/ ||
    $1 == "redblink-dune-tanks" || $1 == "redblink-dune-tank-base"'
  # Let Docker filter labels once per component instead of spawning an inspect
  # process for every unrelated image during each Doctor refresh.
  for component in console orchestrator; do
    docker image ls --no-trunc \
      --filter "label=io.github.red-blink.dune-selfhost.component=$component" \
      --format '{{.Repository}}|{{.Tag}}|{{.ID}}'
  done
}

obsolete_dune_image_ids() {
  local protected_file id repo tag current_build=""
  if [ -r runtime/generated/image-tags.env ]; then
    # shellcheck disable=SC1091
    . runtime/generated/image-tags.env
    current_build="${DUNE_WORLD_IMAGE_TAG:-}"
    current_build="${current_build%%-*}"
  fi
  declare -A seen=()
  protected_file="$(mktemp)"
  protected_image_ids | sort -u > "$protected_file"

  while IFS='|' read -r repo tag id; do
    # Keep the installed build's tank/base images even when tanks are disabled.
    case "$repo" in
      redblink-dune-tanks|redblink-dune-tank-base)
        [ -n "$current_build" ] && [ "${tag%%-*}" = "$current_build" ] && continue
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

remove_obsolete_image() {
  local id="$1" ref current_build=""
  local -a refs=()
  if [ -r runtime/generated/image-tags.env ]; then
    # shellcheck disable=SC1091
    . runtime/generated/image-tags.env
    current_build="${DUNE_WORLD_IMAGE_TAG:-}"
    current_build="${current_build%%-*}"
  fi
  # Recheck protection immediately before removing tags. Docker also refuses
  # removal when a container has started using the image in the meantime.
  if protected_image_ids | grep -qxF "$id"; then
    return 1
  fi
  mapfile -t refs < <(docker image inspect --format '{{range .RepoTags}}{{println .}}{{end}}' "$id" | sed '/^$/d')
  for ref in "${refs[@]}"; do
    case "$ref" in
      redblink-dune-tank-base:"${current_build}-"*|redblink-dune-tanks:"${current_build}-"*)
        [ -z "$current_build" ] || return 1
        ;;
    esac
    case "$ref" in
      registry.funcom.com/funcom/self-hosting/*|redblink-dune-tank-base:*|redblink-dune-tanks:*|redblink-dune-docker-console:*|dune-orchestrator:*) ;;
      *) return 1 ;;
    esac
  done
  if [ "${#refs[@]}" -gt 0 ]; then
    docker image rm "${refs[@]}" >/dev/null
  else
    docker image rm "$id" >/dev/null
  fi
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
    elif remove_obsolete_image "$id"; then
      echo "REMOVED $ref"
      removed=$((removed + 1))
    else
      echo "SKIPPED $ref (protected, shared with another project, or Docker could not remove it)"
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
