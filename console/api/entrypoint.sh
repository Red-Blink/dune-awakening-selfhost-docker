#!/bin/bash
set -e

if [ "$(id -u)" = "0" ]; then
  target_uid="${DUNE_HOST_UID:-1000}"
  target_gid="${DUNE_HOST_GID:-1000}"

  # Ensure a group exists for the target GID
  if ! getent group "$target_gid" >/dev/null 2>&1; then
    groupadd -g "$target_gid" dune 2>/dev/null || true
  fi

  # Ensure a user exists for the target UID, with the target GID as primary group
  if ! getent passwd "$target_uid" >/dev/null 2>&1; then
    useradd -u "$target_uid" -g "$target_gid" -d /home/dune -s /bin/bash dune 2>/dev/null || true
  fi

  # Find the username for the target UID
  target_user=$(getent passwd "$target_uid" | cut -d: -f1)

  if [ -n "$target_user" ]; then
    # Repair ownership on app directory (not /repo — that's a mount, let the host own it)
    chown -R "${target_uid}:${target_gid}" /app 2>/dev/null || true

    # Drop privileges using runuser (argument-preserving, no su -c shell escaping)
    if command -v runuser >/dev/null 2>&1; then
      exec runuser -u "$target_user" -- "$@"
    fi
    if command -v gosu >/dev/null 2>&1; then
      exec gosu "$target_user" "$@"
    fi
    if command -v setpriv >/dev/null 2>&1; then
      exec setpriv --reuid="$target_uid" --regid="$target_gid" --inh-caps=-all -- "$@"
    fi
    # Last resort: su with argument forwarding (note: runs shell, but args preserved)
    exec su -s /bin/bash "$target_user" -c 'exec "$@"' -- "$@"
  fi
fi

# Not running as root — verify we can write to /repo
if ! touch /repo/.dune-write-test 2>/dev/null; then
  echo "[entrypoint] WARNING: /repo is not writable (UID $(id -u), GID $(id -g))" >&2
else
  rm -f /repo/.dune-write-test
fi

exec "$@"
