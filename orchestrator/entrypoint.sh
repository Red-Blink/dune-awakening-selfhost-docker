#!/bin/bash
set -e

echo "[entrypoint] Running as root — repairing permissions on mounted runtime directories"

# Repair ownership on volumes that may be root-owned from previous installs
for dir in /srv/dune/server /srv/dune/steam /srv/dune/generated /srv/dune/cache /home/dune/.steam; do
  mkdir -p "$dir"
  if [ "$(stat -c '%U' "$dir" 2>/dev/null || echo '')" != "dune" ]; then
    echo "[entrypoint] chown dune:dune $dir"
    chown -R dune:dune "$dir" 2>/dev/null || echo "[entrypoint] WARNING: could not chown $dir"
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
