#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
ROOT_DIR="${DUNE_RUNTIME_REPO_ROOT:-$SCRIPT_ROOT}"
cd "$ROOT_DIR"

# Preserve invocation-time overrides before .env is loaded. A stale .env value
# must not replace an explicit DUNE_HOST_UID/GID supplied for a repair run.
REQUESTED_HOST_UID="${DUNE_HOST_UID:-}"
REQUESTED_HOST_GID="${DUNE_HOST_GID:-}"
CALLER_UID="$(id -u)"
CALLER_GID="$(id -g)"

[ -r .env ] && . ./.env
source "$SCRIPT_ROOT/runtime/scripts/host-paths.sh"

OWNER_UID="$(stat -c '%u' .)"
OWNER_GID="$(stat -c '%g' .)"
ENV_HOST_UID="${DUNE_HOST_UID:-}"
ENV_HOST_GID="${DUNE_HOST_GID:-}"
IMAGE="${DUNE_RUNTIME_PERMISSION_HELPER_IMAGE:-dune-orchestrator:dev}"

if [ -n "$REQUESTED_HOST_UID" ]; then
  TARGET_UID="$REQUESTED_HOST_UID"
elif [ "$OWNER_UID" != "0" ]; then
  TARGET_UID="$OWNER_UID"
elif [ "$CALLER_UID" != "0" ]; then
  TARGET_UID="$CALLER_UID"
else
  TARGET_UID="${ENV_HOST_UID:-$OWNER_UID}"
fi

if [ -n "$REQUESTED_HOST_GID" ]; then
  TARGET_GID="$REQUESTED_HOST_GID"
elif [ "$OWNER_GID" != "0" ]; then
  TARGET_GID="$OWNER_GID"
elif [ "$CALLER_GID" != "0" ]; then
  TARGET_GID="$CALLER_GID"
else
  TARGET_GID="${ENV_HOST_GID:-$OWNER_GID}"
fi

if ! [[ "$TARGET_UID" =~ ^[0-9]+$ && "$TARGET_GID" =~ ^[0-9]+$ ]]; then
  echo "Invalid host runtime ownership target: ${TARGET_UID}:${TARGET_GID}" >&2
  exit 1
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1 \
  && [ "$IMAGE" = "dune-orchestrator:dev" ] \
  && [ -f orchestrator/Dockerfile ]; then
  echo "Runtime permission helper image is missing; rebuilding $IMAGE..."
  docker build --tag "$IMAGE" orchestrator
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Cannot repair host runtime permissions: Docker image not found: $IMAGE" >&2
  echo "Build or start the orchestrator, then retry." >&2
  exit 1
fi

HOST_ROOT="${DUNE_RUNTIME_HOST_REPO_ROOT:-$(host_path "$ROOT_DIR")}"
CONTROL_PATHS=(
  .env
  runtime/generated
  runtime/logs
  runtime/backups
  runtime/secrets
  runtime/system-backup
  runtime/addons
  runtime/container
  runtime/text-router
  runtime/director/config
  runtime/server-gateway/config
  runtime/rabbitmq-admin/config
  runtime/rabbitmq-game/config
  runtime/rabbitmq-game/certs
  runtime/postgres/initdb
  runtime/postgres/bootstrap
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
    mkdir -p runtime/generated runtime/logs runtime/text-router
    chown "$TARGET_UID:$TARGET_GID" runtime
    chmod u+rwx runtime
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      [ -e "$path" ] || continue
      find "$path" -xdev \( ! -uid "$TARGET_UID" -o ! -gid "$TARGET_GID" \) \
        -exec chown -h "$TARGET_UID:$TARGET_GID" {} +
      if [ -d "$path" ]; then
        find "$path" -xdev -type d ! -perm -u+rwx -exec chmod u+rwx {} +
        find "$path" -xdev -type f ! -perm -u+rw -exec chmod u+rw {} +
      elif [ -f "$path" ]; then
        chmod u+rw "$path"
      fi
    done <<< "$CONTROL_PATHS"

    # Game processes own most Saved content. Repair only the host-managed
    # directory chain and generated UserSettings files needed by launch scripts.
    if [ -d runtime/game ]; then
      chown "$TARGET_UID:$TARGET_GID" runtime/game
      chmod u+rwx runtime/game
      for path in runtime/game/artifacts runtime/game/* runtime/game/*/Saved; do
        [ -e "$path" ] || continue
        chown "$TARGET_UID:$TARGET_GID" "$path"
        [ ! -d "$path" ] || chmod u+rwx "$path"
      done
      for path in runtime/game/*/Saved/UserSettings runtime/game/*/Saved/Config/LinuxServer; do
        [ -e "$path" ] || continue
        find "$path" -xdev \( ! -uid "$TARGET_UID" -o ! -gid "$TARGET_GID" \) \
          -exec chown -h "$TARGET_UID:$TARGET_GID" {} +
        find "$path" -xdev -type d ! -perm -u+rwx -exec chmod u+rwx {} +
        find "$path" -xdev -type f ! -perm -u+rw -exec chmod u+rw {} +
      done
    fi

    # Keep the persisted host identity aligned with the ownership target so a
    # stale nonzero value cannot undo the repair during the next startup.
    if [ -f .env ]; then
      env_tmp="$(mktemp ./.env.host-identity.XXXXXX)"
      saw_uid=0
      saw_gid=0
      while IFS= read -r env_line || [ -n "$env_line" ]; do
        case "$env_line" in
          DUNE_HOST_UID=*)
            printf "DUNE_HOST_UID=%s\n" "$TARGET_UID"
            saw_uid=1
            ;;
          DUNE_HOST_GID=*)
            printf "DUNE_HOST_GID=%s\n" "$TARGET_GID"
            saw_gid=1
            ;;
          *)
            printf "%s\n" "$env_line"
            ;;
        esac
      done < .env > "$env_tmp"
      [ "$saw_uid" = "1" ] || printf "DUNE_HOST_UID=%s\n" "$TARGET_UID" >> "$env_tmp"
      [ "$saw_gid" = "1" ] || printf "DUNE_HOST_GID=%s\n" "$TARGET_GID" >> "$env_tmp"
      chmod --reference=.env "$env_tmp"
      chown "$TARGET_UID:$TARGET_GID" "$env_tmp"
      mv -f -- "$env_tmp" .env
    fi
  '

# Verify on the host path as well as through the helper container. This catches
# rootless-Docker chown limitations and stale DUNE_RUNTIME_HOST_REPO_ROOT values
# that would otherwise make the repair appear to succeed against the wrong tree.
ownership_mismatch=""
if [ "$(stat -c '%u:%g' runtime)" != "${TARGET_UID}:${TARGET_GID}" ]; then
  ownership_mismatch="runtime"
fi
for path in "${CONTROL_PATHS[@]}"; do
  [ -z "$ownership_mismatch" ] || break
  [ -e "$path" ] || continue
  if ! mismatch="$(find "$path" -xdev \( ! -uid "$TARGET_UID" -o ! -gid "$TARGET_GID" \) -print -quit)"; then
    echo "Could not verify host runtime ownership: $path" >&2
    exit 1
  fi
  if [ -n "$mismatch" ]; then
    ownership_mismatch="$mismatch"
    break
  fi
done

if [ -n "$ownership_mismatch" ]; then
  echo "Host runtime ownership repair did not apply to: $ownership_mismatch" >&2
  echo "Expected UID:GID ${TARGET_UID}:${TARGET_GID}." >&2
  echo "Docker may be rootless, or DUNE_RUNTIME_HOST_REPO_ROOT may point at a different checkout." >&2
  echo "Repair the host paths with sudo, then rerun this command. For example:" >&2
  echo "  sudo chown -R ${TARGET_UID}:${TARGET_GID} runtime/backups runtime/generated" >&2
  exit 1
fi

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
