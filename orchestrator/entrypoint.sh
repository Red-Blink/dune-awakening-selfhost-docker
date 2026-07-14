#!/bin/bash
set -e

echo "[entrypoint] Running as root - preparing mounted runtime directories"

# Upgrade path: repair root-owned volumes from previous installs.
# This allows existing root-owned deployments to migrate to non-root.
WRITABLE_DIRS=(
  /srv/dune/server
  /srv/dune/steam
  /srv/dune/generated
  /srv/dune/cache
  /home/dune/.steam
  /work
)

for dir in "${WRITABLE_DIRS[@]}"; do
  mkdir -p "$dir"
  current_owner="$(stat -c '%u:%g' "$dir" 2>/dev/null || echo 'unknown')"
  if [ "$current_owner" != "$(id -u dune):$(id -g dune)" ]; then
    echo "[entrypoint] Repairing $dir ownership ($current_owner -> dune:dune)"
    if ! chown -R dune:dune "$dir"; then
      echo "[entrypoint] ERROR: could not repair ownership for $dir" >&2
      exit 1
    fi
  fi
done

for dir in "${WRITABLE_DIRS[@]}"; do
  marker="$dir/.dune-write-test"
  if ! runuser -u dune -- sh -c 'touch "$1" && rm -f "$1"' sh "$marker"; then
    echo "[entrypoint] ERROR: $dir is not writable by the dune runtime user." >&2
    echo "[entrypoint] Check the volume mount and host filesystem permissions, then recreate the orchestrator." >&2
    exit 1
  fi
done

# Handle Docker socket group
if [ -z "${DOCKER_SOCKET_GID:-}" ] && [ -S /var/run/docker.sock ] && command -v stat >/dev/null 2>&1; then
  DOCKER_SOCKET_GID="$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo '')"
fi

if [ -n "${DOCKER_SOCKET_GID:-}" ] && [ "${DOCKER_SOCKET_GID}" != "0" ]; then
  SOCK_GROUP="docker-socket-gid-${DOCKER_SOCKET_GID}"
  if ! getent group "$SOCK_GROUP" >/dev/null 2>&1; then
    groupadd -g "$DOCKER_SOCKET_GID" "$SOCK_GROUP" 2>/dev/null || true
  fi
  if getent group "$SOCK_GROUP" >/dev/null 2>&1; then
    usermod -aG "$SOCK_GROUP" dune 2>/dev/null || true
    echo "[entrypoint] Added dune to group $SOCK_GROUP (GID=$DOCKER_SOCKET_GID) for Docker socket access"
  fi
fi

if getent group docker >/dev/null 2>&1; then
  usermod -aG docker dune 2>/dev/null || true
fi

echo "[entrypoint] Dropping privileges to dune user"

# Argument-preserving privilege drop (not su -c — that loses boundaries)
if command -v runuser >/dev/null 2>&1; then
  exec runuser -u dune -- "$@"
fi
if command -v gosu >/dev/null 2>&1; then
  exec gosu dune "$@"
fi
if command -v setpriv >/dev/null 2>&1; then
  exec setpriv --reuid=dune --regid=dune --inh-caps=-all -- "$@"
fi
exec su -s /bin/bash dune -c 'exec "$@"' -- "$@"
