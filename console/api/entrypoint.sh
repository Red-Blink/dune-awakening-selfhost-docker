#!/bin/bash
set -e

if [ "$(id -u)" = "0" ]; then
  target_uid="${DUNE_HOST_UID:-0}"
  target_gid="${DUNE_HOST_GID:-0}"

  # If caller explicitly requested root (UID 0), stay root.
  if [ "$target_uid" = "0" ] && [ "$target_gid" = "0" ]; then
    echo "[entrypoint] Running as root (DUNE_HOST_UID=0, DUNE_HOST_GID=0)"
    exec "$@"
  fi

  # Ensure group exists for target GID
  if ! getent group "$target_gid" >/dev/null 2>&1; then
    groupadd -g "$target_gid" dune 2>/dev/null || true
  fi

  # Ensure user exists for target UID
  if ! getent passwd "$target_uid" >/dev/null 2>&1; then
    useradd -u "$target_uid" -g "$target_gid" -d /home/dune -s /bin/bash dune 2>/dev/null || true
  fi

  target_user=$(getent passwd "$target_uid" | cut -d: -f1)

  if [ -n "$target_user" ]; then
    chown -R "${target_uid}:${target_gid}" /app 2>/dev/null || true

    if command -v runuser >/dev/null 2>&1; then
      exec runuser -u "$target_user" -- "$@"
    fi
    if command -v gosu >/dev/null 2>&1; then
      exec gosu "$target_user" "$@"
    fi
    if command -v setpriv >/dev/null 2>&1; then
      exec setpriv --reuid="$target_uid" --regid="$target_gid" --inh-caps=-all -- "$@"
    fi
    exec su -s /bin/bash "$target_user" -c 'exec "$@"' -- "$@"
  fi
fi

if ! touch /repo/.dune-write-test 2>/dev/null; then
  echo "[entrypoint] WARNING: /repo is not writable (UID $(id -u), GID $(id -g))" >&2
else
  rm -f /repo/.dune-write-test
fi

exec "$@"
