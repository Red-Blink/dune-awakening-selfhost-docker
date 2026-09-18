#!/usr/bin/env bash

# Atomically remove one key from a shell-style environment file, so the reader
# falls back to its built-in default. Shares the lock and the replace-by-mv
# discipline with set_env_file_value; a key that is not present is not an error.
unset_env_file_value() {
  local file="$1"
  local key="$2"
  local dir base lock tmp lock_fd existing_owner mode

  [ -f "$file" ] || return 0
  dir="$(dirname "$file")"
  base="$(basename "$file")"
  lock="${file}.lock"

  touch "$lock"
  chmod 666 "$lock" 2>/dev/null || true
  if command -v flock >/dev/null 2>&1; then
    exec {lock_fd}>>"$lock"
    flock -x "$lock_fd"
  fi

  if [ ! -w "$file" ]; then
    echo "Cannot update $file because it is not writable by $(id -un)." >&2
    if [ -n "${lock_fd:-}" ]; then
      flock -u "$lock_fd"
      exec {lock_fd}>&-
    fi
    return 13
  fi

  mode="$(stat -c '%a' "$file" 2>/dev/null || echo 644)"
  existing_owner="$(stat -c '%u:%g' "$file" 2>/dev/null || true)"
  tmp="$(mktemp "$dir/.${base}.XXXXXX")"
  if ! awk -F= -v key="$key" '$1 != key' "$file" > "$tmp"; then
    rm -f "$tmp"
    if [ -n "${lock_fd:-}" ]; then
      flock -u "$lock_fd"
      exec {lock_fd}>&-
    fi
    return 1
  fi

  chmod "$mode" "$tmp" 2>/dev/null || true
  if [ "$(id -u)" -eq 0 ] && [ -n "$existing_owner" ]; then
    chown "$existing_owner" "$tmp" 2>/dev/null || true
  fi
  mv -f "$tmp" "$file"
  if [ -n "${lock_fd:-}" ]; then
    flock -u "$lock_fd"
    exec {lock_fd}>&-
  fi
}

# Atomically update one key in a shell-style environment file. A separate,
# stable lock file protects the read/modify/write sequence even though the
# destination itself is replaced with mv(1).
set_env_file_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  local mode="${4:-644}"
  local style="${5:-plain}"
  local dir base lock tmp lock_fd existing_owner

  dir="$(dirname "$file")"
  base="$(basename "$file")"
  lock="${file}.lock"
  mkdir -p "$dir"

  touch "$lock"
  chmod 666 "$lock" 2>/dev/null || true
  if command -v flock >/dev/null 2>&1; then
    exec {lock_fd}>>"$lock"
    flock -x "$lock_fd"
  fi

  if [ -e "$file" ] && [ ! -w "$file" ]; then
    echo "Cannot update $file because it is not writable by $(id -un)." >&2
    echo "Repair ownership from the repo root, then retry:" >&2
    echo "  sudo chown \"\$USER:\$USER\" $file" >&2
    echo "  chmod u+rw $file" >&2
    if [ -n "${lock_fd:-}" ]; then
      flock -u "$lock_fd"
      exec {lock_fd}>&-
    fi
    return 13
  fi

  existing_owner=""
  if [ -e "$file" ]; then
    existing_owner="$(stat -c '%u:%g' "$file" 2>/dev/null || true)"
  else
    : > "$file"
  fi
  tmp="$(mktemp "$dir/.${base}.XXXXXX")"
  if ! awk -F= -v key="$key" -v value="$value" -v style="$style" '
    function rendered(v) {
      if (style == "quoted") {
        gsub(/"/, "\\\"", v)
        return "\"" v "\""
      }
      return v
    }
    BEGIN { found = 0 }
    $1 == key {
      print key "=" rendered(value)
      found = 1
      next
    }
    { print }
    END {
      if (!found) print key "=" rendered(value)
    }
  ' "$file" > "$tmp"; then
    rm -f "$tmp"
    if [ -n "${lock_fd:-}" ]; then
      flock -u "$lock_fd"
      exec {lock_fd}>&-
    fi
    return 1
  fi

  chmod "$mode" "$tmp" 2>/dev/null || true
  # A host timer may still run as root on installations created by an older
  # release. Preserve the destination owner so its atomic replacement cannot
  # make the console user's runtime configuration unwritable.
  if [ "$(id -u)" -eq 0 ] && [ -n "$existing_owner" ]; then
    chown "$existing_owner" "$tmp" 2>/dev/null || true
  fi
  mv -f "$tmp" "$file"
  if [ -n "${lock_fd:-}" ]; then
    flock -u "$lock_fd"
    exec {lock_fd}>&-
  fi
}
