#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

# Starts the deferred dimension reconcile so that it OUTLIVES the console.
#
# It used to be a background job of start-all.sh, which the console runs inside
# its own container. `dune console reload` is `docker rm -f` on that container,
# so anything start-all backgrounded died with it -- and the reconcile is a wait
# that can legitimately run for minutes while Survival_1 warms up. A system
# restore reloads the console seconds after starting the stack, so the wait was
# killed every time and the second Sietch of a multi-dimension map never
# spawned. Nothing reported it: the wait prints nothing until it finishes, and
# deferred-reconcile.sh calls the reconcile with `|| true`.
#
# The helper is a detached container, so a console recreate cannot reach it. It
# needs the repo and the docker socket because the reconcile spawns game
# servers, and it needs the host-path translation environment because
# spawn-server.sh refuses to build bind mounts without it.

LOG_FILE="runtime/generated/deferred-reconcile.log"
HELPER_NAME="${DUNE_DEFERRED_RECONCILE_CONTAINER:-dune-deferred-reconcile}"

run_in_process() {
  mkdir -p runtime/generated
  (
    exec runtime/scripts/deferred-reconcile.sh
  ) >"$LOG_FILE" 2>&1 &
}

helper_image() {
  printf '%s' "${DUNE_SYSTEMD_HELPER_IMAGE:-redblink-dune-docker-console:dev}"
}

mkdir -p runtime/generated

image="$(helper_image)"
host_root="${DUNE_HOST_REPO_ROOT:-$(pwd -P)}"

# A host CLI run has no console image and no container to be killed by, so the
# original in-process job is correct there. Falling back rather than skipping
# keeps `dune start` from silently losing the reconcile on those hosts.
if ! command -v docker >/dev/null 2>&1 || ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "Scheduling deferred dimension reconcile in-process (no console helper image)."
  run_in_process
  exit 0
fi

# One at a time. A previous run still waiting would otherwise race this one into
# spawning the same partition twice.
docker rm -f "$HELPER_NAME" >/dev/null 2>&1 || true

if ! docker run -d --rm --name "$HELPER_NAME" \
  --network host \
  --user "${DUNE_HOST_UID:-0}:${DUNE_HOST_GID:-0}" \
  --group-add "${DOCKER_SOCKET_GID:-0}" \
  -v "$host_root:/repo" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -w /repo \
  -e HOME=/tmp/dune-deferred-home \
  -e DUNE_HOST_REPO_ROOT="$host_root" \
  -e DUNE_CONTAINER_REPO_ROOT=/repo \
  -e DUNE_DOCKER_DIR=/repo \
  -e DUNE_HOST_UID="${DUNE_HOST_UID:-0}" \
  -e DUNE_HOST_GID="${DUNE_HOST_GID:-0}" \
  -e DOCKER_SOCKET_GID="${DOCKER_SOCKET_GID:-0}" \
  -e COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-}" \
  -e DUNE_COMPOSE_PROJECT_NAME="${DUNE_COMPOSE_PROJECT_NAME:-}" \
  --entrypoint bash \
  "$image" -lc "runtime/scripts/deferred-reconcile.sh > $LOG_FILE 2>&1" >/dev/null 2>&1; then
  echo "Could not start the deferred reconcile helper; running it in-process instead." >&2
  run_in_process
  exit 0
fi

echo "Deferred dimension reconcile running as container $HELPER_NAME (survives a console reload)."
