#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

usage() {
  cat <<'EOF'
Usage:
  dune storage status
  dune storage diagnostics
  dune storage cleanup [--dry-run] [--unused-images] [--build-cache]

The default cleanup removes only obsolete Funcom/Dune game images. It never
removes containers, volumes, databases, game files, or backups.

--unused-images includes unused images across this Docker host, including
development images and images without tags. Configured startup images and
images used by any container (including stopped containers) stay protected.

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
  local output
  local -a containers=() refs=()
  if [ -f runtime/generated/experimental-tanks.json ]; then
    runtime/scripts/experimental-tanks.sh resolve Survival_1
  fi

  output="$(docker container ls -aq)" || return 1
  if [ -n "$output" ]; then mapfile -t containers <<<"$output"; fi
  if [ "${#containers[@]}" -gt 0 ]; then
    docker inspect --format '{{.Image}}' "${containers[@]}" || return 1
  fi

  mapfile -t refs < <(current_image_refs)
  if [ "${#refs[@]}" -gt 0 ]; then
    docker image inspect --format '{{.Id}}' "${refs[@]}" 2>/dev/null || true
  fi
}

cleanup_candidate_images() {
  local component scope="${1:-project}"
  if [ "$scope" = unused ]; then
    docker image ls --no-trunc --format '{{.Repository}}|{{.Tag}}|{{.ID}}'
    return
  fi
  docker image ls --no-trunc --format '{{.Repository}}|{{.Tag}}|{{.ID}}' | awk -F'|' '
    $1 ~ /^registry\.funcom\.com\/funcom\/self-hosting\/(igw-postgres|seabass-server|seabass-server-bg-director|seabass-server-db-utils|seabass-server-gateway|seabass-server-rabbitmq|seabass-server-text-router)$/ ||
    $1 == "redblink-dune-tanks" || $1 == "redblink-dune-tank-base"' || return 1
  # Let Docker filter labels once per component instead of spawning an inspect
  # process for every unrelated image during each Doctor refresh.
  for component in console orchestrator; do
    docker image ls --no-trunc \
      --filter "label=io.github.red-blink.dune-selfhost.component=$component" \
      --format '{{.Repository}}|{{.Tag}}|{{.ID}}' || return 1
  done
}

obsolete_dune_image_ids() {
  local protected_file candidates id repo tag current_build="" scope="${1:-project}"
  if [ -r runtime/generated/image-tags.env ]; then
    # shellcheck disable=SC1091
    . runtime/generated/image-tags.env
    current_build="${DUNE_WORLD_IMAGE_TAG:-}"
    current_build="${current_build%%-*}"
  fi
  declare -A seen=()
  protected_file="$(mktemp)"
  protected_image_ids | sort -u > "$protected_file" || { rm -f "$protected_file"; return 1; }
  candidates="$(cleanup_candidate_images "$scope")" || { rm -f "$protected_file"; return 1; }

  while IFS='|' read -r repo tag id; do
    [ -n "$id" ] || continue
    # Keep the installed build's tank/base images even when tanks are disabled.
    case "$repo" in
      redblink-dune-tanks|redblink-dune-tank-base)
        [ -n "$current_build" ] && [ "${tag%%-*}" = "$current_build" ] && continue
        ;;
    esac
    grep -qxF "$id" "$protected_file" && continue
    [ -z "${seen[$id]:-}" ] || continue
    seen[$id]=1
    image_tags_removable "$id" "$scope" >/dev/null || continue
    printf '%s|%s:%s\n' "$id" "$repo" "$tag"
  done <<<"$candidates"
  rm -f "$protected_file"
}

storage_status() {
  echo "=== Docker storage ==="
  docker system df
  echo
  echo "The reclaimable image figure can include obsolete Funcom releases."
  echo "Use 'dune storage cleanup --dry-run' to list project-owned candidates."
}

image_tags_removable() {
  local id="$1" ref current_build="" scope="${2:-project}"
  local -a refs=()
  if [ -r runtime/generated/image-tags.env ]; then
    # shellcheck disable=SC1091
    . runtime/generated/image-tags.env
    current_build="${DUNE_WORLD_IMAGE_TAG:-}"
    current_build="${current_build%%-*}"
  fi
  local output
  output="$(docker image inspect --format '{{range .RepoTags}}{{println .}}{{end}}' "$id")" || return 1
  mapfile -t refs < <(sed '/^$/d' <<<"$output")
  for ref in "${refs[@]}"; do
    case "$ref" in
      redblink-dune-tank-base:"${current_build}-"*|redblink-dune-tanks:"${current_build}-"*)
        [ -z "$current_build" ] || return 1
        ;;
    esac
    case "$ref" in
      registry.funcom.com/funcom/self-hosting/*|redblink-dune-tank-base:*|redblink-dune-tanks:*|redblink-dune-docker-console:*|dune-orchestrator:*) ;;
      *) [ "$scope" = unused ] || return 1 ;;
    esac
  done
  printf '%s\n' "${refs[@]}"
}

remove_obsolete_image() {
  local id="$1" output protected scope="${2:-project}"
  local -a refs=()
  # Recheck all protection immediately before deletion, including aliases.
  protected="$(protected_image_ids)" || return 1
  if grep -qxF "$id" <<<"$protected"; then return 1; fi
  output="$(image_tags_removable "$id" "$scope")" || return 1
  mapfile -t refs < <(sed '/^$/d' <<<"$output")
  if [ "${#refs[@]}" -gt 0 ]; then
    docker image rm "${refs[@]}" >/dev/null
  else
    docker image rm "$id" >/dev/null
  fi
}

docker_size_bytes() {
  awk '
    function multiplier(unit) {
      if (unit == "kB" || unit == "KB") return 1000
      if (unit == "MB") return 1000000
      if (unit == "GB") return 1000000000
      if (unit == "TB") return 1000000000000
      if (unit == "KiB") return 1024
      if (unit == "MiB") return 1048576
      if (unit == "GiB") return 1073741824
      if (unit == "TiB") return 1099511627776
      return 1
    }
    {
      number = $0; sub(/[A-Za-z].*$/, "", number)
      unit = $0; sub(/^[0-9.]+/, "", unit); sub(/[[:space:]].*$/, "", unit)
      if (number ~ /^[0-9]+([.][0-9]+)?$/) printf "%.0f\n", number * multiplier(unit)
    }'
}

# One report for Doctor and post-cleanup verification. Do not report a clean
# result when Docker cannot provide fresh storage accounting.
storage_diagnostics() {
  local rows candidates count cache bytes image_reclaim image_estimate=""
  rows="$(docker system df --format '{{.Type}}|{{.Reclaimable}}')" || return 1
  cache="$(awk -F'|' '$1 == "Build Cache" { print $2; exit }' <<<"$rows")"
  [ -n "$cache" ] || return 1
  bytes="$(docker_size_bytes <<<"$cache")"
  [ -n "$bytes" ] || return 1
  candidates="$(obsolete_dune_image_ids unused)" || return 1
  count="$(grep -c . <<<"$candidates" || true)"
  image_reclaim="$(awk -F'|' '$1 == "Images" { split($2, parts, " "); print parts[1]; exit }' <<<"$rows")"
  if [[ "$image_reclaim" =~ ^[0-9]+([.][0-9]+)?[A-Za-z]+$ ]]; then
    image_estimate=" (up to ${image_reclaim})"
  fi
  if [ "$count" -gt 0 ]; then
    echo "WARN Docker has ${count} unused image(s) that can be cleaned${image_estimate}"
  else
    echo "OK   No unused Docker images eligible for cleanup"
  fi
  if [ "$bytes" -ge 10000000000 ]; then
    echo "WARN Docker has ${cache} of reclaimable build cache"
  else
    echo "OK   Reclaimable Docker build cache: ${cache}"
  fi
}

cleanup_storage() {
  local dry_run=0 build_cache=0 row id ref removed=0 scope=project candidates
  shift || true
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dry-run) dry_run=1 ;;
      --build-cache) build_cache=1 ;;
      --unused-images) scope=unused ;;
      *) echo "Unknown storage cleanup option: $1" >&2; usage; exit 2 ;;
    esac
    shift
  done

  candidates="$(obsolete_dune_image_ids "$scope")" || return 1
  echo "=== Docker image cleanup ($scope) ==="
  while IFS= read -r row; do
    [ -n "$row" ] || continue
    id="${row%%|*}"
    ref="${row#*|}"
    if [ "$dry_run" = "1" ]; then
      echo "WOULD REMOVE $ref ($id)"
    elif remove_obsolete_image "$id" "$scope"; then
      echo "REMOVED $ref"
      removed=$((removed + 1))
    else
      echo "SKIPPED $ref (protected, shared with another project, or Docker could not remove it)"
    fi
  done <<<"$candidates"

  if [ "$removed" -eq 0 ] && [ "$dry_run" = "0" ]; then
    echo "No eligible Docker images were removed."
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
  if [ "$dry_run" = "0" ]; then
    local report
    report="$(storage_diagnostics)" || { echo "Could not verify storage after cleanup." >&2; return 1; }
    while IFS= read -r row; do printf 'STORAGE_RESULT %s\n' "$row"; done <<<"$report"
  fi
}

require_docker
cmd="${1:-status}"
case "$cmd" in
  status) storage_status ;;
  diagnostics) storage_diagnostics ;;
  cleanup) cleanup_storage "$@" ;;
  help|--help|-h) usage ;;
  *) echo "Unknown storage command: $cmd" >&2; usage; exit 2 ;;
esac
