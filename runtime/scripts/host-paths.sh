#!/usr/bin/env bash

# Convert repository paths used inside RedBlink Dune Docker Console (/repo) to the
# real host path that the Docker daemon needs for bind mounts. Host CLI runs
# keep using $PWD unchanged.
host_path() {
  local path="$1"
  local container_root="${DUNE_CONTAINER_REPO_ROOT:-$PWD}"
  local host_root="${DUNE_HOST_REPO_ROOT:-$PWD}"

  if [ -z "${DUNE_HOST_REPO_ROOT:-}" ] && [ "$PWD" = "/repo" ]; then
    echo "DUNE_HOST_REPO_ROOT is not set, so Docker bind mounts cannot be prepared safely." >&2
    echo "Restart the Web UI with DUNE_HOST_REPO_ROOT set to the host repository path." >&2
    return 1
  fi

  if [ "$path" = "$container_root" ]; then
    printf '%s\n' "$host_root"
  elif [ "${path#"$container_root/"}" != "$path" ]; then
    printf '%s/%s\n' "$host_root" "${path#"$container_root/"}"
  elif [ "${path#/}" != "$path" ]; then
    printf '%s\n' "$path"
  else
    printf '%s/%s\n' "$host_root" "$path"
  fi
}
