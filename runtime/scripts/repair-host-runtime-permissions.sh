#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
ROOT_DIR="${DUNE_RUNTIME_REPO_ROOT:-$SCRIPT_ROOT}"
cd "$ROOT_DIR"

[ -f .env ] && . ./.env
source "$SCRIPT_ROOT/runtime/scripts/host-paths.sh"

OWNER_UID="$(stat -c '%u' .)"
OWNER_GID="$(stat -c '%g' .)"
TARGET_UID="${DUNE_HOST_UID:-$OWNER_UID}"
TARGET_GID="${DUNE_HOST_GID:-$OWNER_GID}"
IMAGE="${DUNE_RUNTIME_PERMISSION_HELPER_IMAGE:-dune-orchestrator:dev}"

if [ "$TARGET_UID" = "0" ] && [ "$OWNER_UID" != "0" ]; then
  TARGET_UID="$OWNER_UID"
fi
if [ "$TARGET_GID" = "0" ] && [ "$OWNER_GID" != "0" ]; then
  TARGET_GID="$OWNER_GID"
fi

if ! [[ "$TARGET_UID" =~ ^[0-9]+$ && "$TARGET_GID" =~ ^[0-9]+$ ]]; then
  echo "Invalid host runtime ownership target: ${TARGET_UID}:${TARGET_GID}" >&2
  exit 1
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Cannot repair host runtime permissions: Docker image not found: $IMAGE" >&2
  echo "Build or start the orchestrator, then retry." >&2
  exit 1
fi

mkdir -p runtime/generated runtime/logs runtime/text-router

HOST_ROOT="${DUNE_RUNTIME_HOST_REPO_ROOT:-$(host_path "$ROOT_DIR")}"
CONTROL_PATHS=(
  .env
  runtime/generated
  runtime/logs
  runtime/backups
  runtime/secrets
  runtime/addons
  runtime/container
  runtime/text-router
  runtime/director/config
  runtime/server-gateway/config
  runtime/rabbitmq-admin/config
  runtime/rabbitmq-game/config
  runtime/rabbitmq-game/certs
  runtime/postgres/initdb
)

path_list="$(printf '%s\n' "${CONTROL_PATHS[@]}")"

docker run --rm \
  --user 0:0 \
  --entrypoint bash \
  -e "TARGET_UID=$TARGET_UID" \
  -e "TARGET_GID=$TARGET_GID" \
  -e "CONTROL_PATHS=$path_list" \
  -v "$HOST_ROOT:/repo" \
  -w /repo \
  "$IMAGE" -lc '
    set -euo pipefail
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      [ -e "$path" ] || continue
      find "$path" -xdev \( ! -uid "$TARGET_UID" -o ! -gid "$TARGET_GID" \) \
        -exec chown "$TARGET_UID:$TARGET_GID" {} +
    done <<< "$CONTROL_PATHS"

    # Game processes own most Saved content. Repair only the host-managed
    # directory chain and generated UserSettings files needed by launch scripts.
    if [ -d runtime/game ]; then
      chown "$TARGET_UID:$TARGET_GID" runtime/game
      for path in runtime/game/artifacts runtime/game/* runtime/game/*/Saved; do
        [ -e "$path" ] || continue
        chown "$TARGET_UID:$TARGET_GID" "$path"
      done
      for path in runtime/game/*/Saved/UserSettings; do
        [ -e "$path" ] || continue
        find "$path" -xdev \( ! -uid "$TARGET_UID" -o ! -gid "$TARGET_GID" \) \
          -exec chown "$TARGET_UID:$TARGET_GID" {} +
      done
    fi
  '

docker run --rm \
  --user "$TARGET_UID:$TARGET_GID" \
  --entrypoint bash \
  -e "CONTROL_PATHS=$path_list" \
  -v "$HOST_ROOT:/repo" \
  -w /repo \
  "$IMAGE" -lc '
    set -euo pipefail
    for dir in runtime/generated runtime/logs runtime/text-router; do
      marker="$dir/.dune-write-test"
      touch "$marker"
      rm -f "$marker"
    done
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      [ -e "$path" ] || continue
      [ -w "$path" ] || {
        echo "Host runtime path is not writable by UID:GID $(id -u):$(id -g): $path" >&2
        exit 1
      }
    done <<< "$CONTROL_PATHS"
    if [ -d runtime/game ]; then
      [ -w runtime/game ] || {
        echo "Host runtime path is not writable by UID:GID $(id -u):$(id -g): runtime/game" >&2
        exit 1
      }
      for path in runtime/game/artifacts runtime/game/* runtime/game/*/Saved runtime/game/*/Saved/UserSettings; do
        [ -e "$path" ] || continue
        [ -w "$path" ] || {
          echo "Host-managed game path is not writable by UID:GID $(id -u):$(id -g): $path" >&2
          exit 1
        }
      done
    fi
  '
