#!/usr/bin/env bash
set -euo pipefail
dune_wsl_user="$(printf '%s' '__USER_B64__' | base64 -d 2>/dev/null || printf '%s' '__USER_B64__' | base64 --decode)"
dune_wsl_pass="$(printf '%s' '__PASS_B64__' | base64 -d 2>/dev/null || printf '%s' '__PASS_B64__' | base64 --decode)"
if [ -z "$dune_wsl_user" ]; then
  echo "Decoded WSL username is empty." >&2
  exit 1
fi
if ! id "$dune_wsl_user" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$dune_wsl_user"
fi
echo "$dune_wsl_user:$dune_wsl_pass" | chpasswd
if getent group sudo >/dev/null 2>&1; then
  usermod -aG sudo "$dune_wsl_user"
elif getent group wheel >/dev/null 2>&1; then
  usermod -aG wheel "$dune_wsl_user"
fi
if getent group docker >/dev/null 2>&1; then
  usermod -aG docker "$dune_wsl_user"
fi
if getent group podman >/dev/null 2>&1; then
  usermod -aG podman "$dune_wsl_user"
fi
sudoers_file="/etc/sudoers.d/90-dune-install-${dune_wsl_user}"
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$dune_wsl_user" > "$sudoers_file"
chmod 440 "$sudoers_file"
if command -v visudo >/dev/null 2>&1; then
  visudo -cf "$sudoers_file"
fi
if grep -q '^\[user\]' /etc/wsl.conf 2>/dev/null; then
  if grep -q '^default=' /etc/wsl.conf; then
    sed -i "s/^default=.*/default=$dune_wsl_user/" /etc/wsl.conf
  else
    sed -i "/^\[user\]/a default=$dune_wsl_user" /etc/wsl.conf
  fi
else
  printf '\n[user]\ndefault=%s\n' "$dune_wsl_user" >> /etc/wsl.conf
fi
