#!/usr/bin/env bash
set -euo pipefail
target_user='__USER__'
sudoers_file="/etc/sudoers.d/90-dune-install-${target_user}"
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$target_user" > "$sudoers_file"
chmod 440 "$sudoers_file"
if command -v visudo >/dev/null 2>&1; then
  visudo -cf "$sudoers_file"
fi
