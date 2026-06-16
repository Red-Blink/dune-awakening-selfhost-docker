#!/usr/bin/env bash
# Configure WSL DNS (/etc/wsl.conf + /etc/resolv.conf) and embedded Docker daemon DNS.
# Intended for WSL installs only; does not modify Windows or user shell profiles.
set -euo pipefail

is_wsl() {
  grep -qiE '(microsoft|wsl)' /proc/version 2>/dev/null
}

need_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    echo "WSL DNS setup needs root access, but sudo was not found." >&2
    exit 1
  fi
  if ! sudo -n true 2>/dev/null; then
    echo "WSL DNS setup needs sudo. Re-run install.ps1 to configure passwordless sudo." >&2
    exit 1
  fi
  sudo "$@"
}

append_unique_server() {
  local candidate="$1"
  shift
  local existing
  candidate="${candidate// /}"
  [ -n "$candidate" ] || return 0
  printf '%s\n' "$candidate" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || return 0
  for existing in "$@"; do
    [ "$existing" = "$candidate" ] && return 0
  done
  printf '%s' "$candidate"
}

collect_dns_servers() {
  local servers=()
  local token server win_host line

  if [ -n "${DUNE_WSL_DNS:-}" ]; then
    for token in ${DUNE_WSL_DNS//,/ }; do
      server="$(append_unique_server "$token" "${servers[@]:-}")"
      if [ -n "$server" ]; then
        servers+=("$server")
      fi
    done
  fi

  if [ -f .wsl/dns-servers.txt ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      line="${line%%#*}"
      line="${line// /}"
      server="$(append_unique_server "$line" "${servers[@]:-}")"
      if [ -n "$server" ]; then
        servers+=("$server")
      fi
    done < .wsl/dns-servers.txt
  fi

  if [ "${#servers[@]}" -eq 0 ] && [ -f /etc/resolv.conf ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        nameserver\ *)
          server="$(append_unique_server "${line#nameserver }" "${servers[@]:-}")"
          if [ -n "$server" ]; then
            servers+=("$server")
          fi
          ;;
      esac
    done < /etc/resolv.conf
  fi

  if [ "${#servers[@]}" -eq 0 ] && command -v ip >/dev/null 2>&1; then
    win_host="$(ip route show default 2>/dev/null | awk '/default/ { print $3; exit }' || true)"
    server="$(append_unique_server "$win_host" "${servers[@]:-}")"
    if [ -n "$server" ]; then
      servers+=("$server")
    fi
  fi

  if [ "${#servers[@]}" -eq 0 ]; then
    servers=(1.1.1.1 8.8.8.8)
  fi

  printf '%s\n' "${servers[@]}"
}

ensure_wsl_conf_generate_resolv_conf_disabled() {
  if [ ! -f /etc/wsl.conf ]; then
    need_sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[network]
generateResolvConf = false
EOF
    return 0
  fi

  if grep -q '^\[network\]' /etc/wsl.conf; then
    if grep -q '^generateResolvConf' /etc/wsl.conf; then
      need_sudo sed -i 's/^generateResolvConf.*/generateResolvConf = false/' /etc/wsl.conf
    else
      need_sudo sed -i '/^\[network\]/a generateResolvConf = false' /etc/wsl.conf
    fi
    return 0
  fi

  need_sudo tee -a /etc/wsl.conf >/dev/null <<'EOF'

[network]
generateResolvConf = false
EOF
}

write_resolv_conf() {
  local servers=()
  local server tmp
  mapfile -t servers < <(collect_dns_servers)

  tmp="$(mktemp)"
  {
    printf '# Managed by dune-awakening-selfhost-docker (configure-wsl-dns.sh)\n'
    printf '# WSL will not overwrite this file while generateResolvConf=false.\n'
    for server in "${servers[@]}"; do
      printf 'nameserver %s\n' "$server"
    done
    printf 'options timeout:2 attempts:3 rotate\n'
  } >"$tmp"
  need_sudo cp "$tmp" /etc/resolv.conf
  need_sudo chmod 644 /etc/resolv.conf
  rm -f "$tmp"
  echo "WSL DNS servers: ${servers[*]}"
}

configure_embedded_docker_dns() {
  if ! command -v docker >/dev/null 2>&1; then
    return 0
  fi
  if docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -qi 'docker desktop'; then
    return 0
  fi
  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
    return 0
  fi

  local servers=()
  local server daemon_dir daemon_file tmp json
  mapfile -t servers < <(collect_dns_servers)

  daemon_dir="/etc/docker"
  daemon_file="$daemon_dir/daemon.json"
  need_sudo mkdir -p "$daemon_dir"

  if [ -f "$daemon_file" ] && command -v python3 >/dev/null 2>&1; then
    tmp="$(mktemp)"
    DUNE_DAEMON_FILE="$daemon_file" DUNE_WSL_DNS="${servers[*]}" python3 - <<'PY' >"$tmp"
import json
import os
from pathlib import Path

path = Path(os.environ["DUNE_DAEMON_FILE"])
servers = [s for s in os.environ.get("DUNE_WSL_DNS", "").split() if s]
data = {}
if path.exists():
    data = json.loads(path.read_text(encoding="utf-8") or "{}")
data["dns"] = servers
print(json.dumps(data, indent=2))
PY
    need_sudo cp "$tmp" "$daemon_file"
    rm -f "$tmp"
  else
    tmp="$(mktemp)"
    {
      printf '{\n  "dns": ['
      local first=1
      for server in "${servers[@]}"; do
        if [ "$first" -eq 1 ]; then
          first=0
        else
          printf ', '
        fi
        printf '"%s"' "$server"
      done
      printf ']\n}\n'
    } >"$tmp"
    need_sudo cp "$tmp" "$daemon_file"
    rm -f "$tmp"
  fi
  need_sudo chmod 644 "$daemon_file"

  if systemctl is-active docker >/dev/null 2>&1; then
    echo "Restarting embedded Docker Engine to apply DNS settings..."
    need_sudo systemctl restart docker || true
  fi
}

verify_general_dns() {
  local probe host
  for probe in cloudflare.com example.com; do
    if getent hosts "$probe" >/dev/null 2>&1; then
      echo "WSL DNS check passed ($probe resolves)."
      return 0
    fi
  done
  echo "WSL DNS check failed: common hostnames still do not resolve inside WSL." >&2
  echo "Edit .wsl/dns-servers.txt (one IPv4 nameserver per line) and re-run install.ps1." >&2
  return 1
}

print_funcom_registry_note() {
  if getent hosts registry.funcom.com >/dev/null 2>&1; then
    echo "registry.funcom.com resolves inside WSL."
    return 0
  fi
  echo "Note: registry.funcom.com does not resolve via public DNS (this is expected)."
  echo "Funcom server images are loaded locally from Steam tarballs (docker load), not pulled from the internet."
  echo "Complete setup in the Web UI or run: runtime/scripts/update.sh install"
}

if ! is_wsl; then
  exit 0
fi

ensure_wsl_conf_generate_resolv_conf_disabled
write_resolv_conf
configure_embedded_docker_dns
verify_general_dns
print_funcom_registry_note
