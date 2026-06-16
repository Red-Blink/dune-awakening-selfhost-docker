#!/usr/bin/env bash
# Docker Desktop WSL integration helpers. Source this file; do not execute directly.

_dd_wsl_need_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo "$@"
  else
    echo "Docker Desktop setup needs sudo inside WSL." >&2
    return 1
  fi
}

_dd_wsl_has_systemd() {
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

is_docker_desktop_daemon() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -qi 'docker desktop'
}

print_docker_desktop_integration_help() {
  echo "Docker Desktop WSL integration is not active in this distribution." >&2
  echo "" >&2
  echo "Fix it from Windows:" >&2
  echo "  1. Start Docker Desktop and wait until the engine is running." >&2
  echo "  2. Settings -> General -> enable 'Use the WSL 2 based engine'." >&2
  echo "  3. Settings -> Resources -> WSL Integration -> enable this distro." >&2
  echo "  4. If WSL Integration is missing, switch to Linux containers from the Docker tray icon." >&2
  echo "  5. Verify: docker info --format '{{.OperatingSystem}}' (should mention Docker Desktop)." >&2
  echo "" >&2
  echo "Guide: https://docs.docker.com/desktop/features/wsl/" >&2
  echo "Local: WSL_README.md in this repository." >&2
}

ensure_docker_desktop_cli() {
  if ! command -v docker >/dev/null 2>&1; then
    print_docker_desktop_integration_help
    return 1
  fi
  if ! is_docker_desktop_daemon; then
    print_docker_desktop_integration_help
    return 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose is not available through Docker Desktop in this WSL distro." >&2
    echo "Update Docker Desktop and confirm WSL integration is enabled." >&2
    return 1
  fi
  return 0
}

disable_embedded_docker_engine() {
  if ! is_docker_desktop_daemon; then
    return 0
  fi
  if ! _dd_wsl_has_systemd; then
    return 0
  fi
  if ! systemctl list-unit-files docker.service >/dev/null 2>&1; then
    return 0
  fi
  if systemctl is-active docker >/dev/null 2>&1; then
    echo "Stopping embedded Docker Engine (using Docker Desktop instead)..."
    _dd_wsl_need_sudo systemctl stop docker || true
  fi
  if systemctl is-enabled docker >/dev/null 2>&1; then
    echo "Disabling embedded Docker Engine service..."
    _dd_wsl_need_sudo systemctl disable docker || true
  fi
}

ensure_wsl_dns() {
  if [ ! -f runtime/scripts/configure-wsl-dns.sh ]; then
    return 0
  fi
  echo "Configuring WSL DNS (/etc/wsl.conf, /etc/resolv.conf)..."
  bash runtime/scripts/configure-wsl-dns.sh
}

verify_wsl_dns_for_docker() {
  local probe_ok=0
  if getent hosts cloudflare.com >/dev/null 2>&1 || getent hosts example.com >/dev/null 2>&1; then
    probe_ok=1
  fi
  if [ "$probe_ok" -eq 0 ]; then
    echo "WSL DNS does not resolve common hostnames. Docker pulls may fail." >&2
    echo "Re-run install.ps1 or add nameservers to .wsl/dns-servers.txt (one per line)." >&2
    return 1
  fi
  if ! getent hosts registry.funcom.com >/dev/null 2>&1; then
    echo "registry.funcom.com is not reachable via DNS (expected on public networks)."
    echo "Funcom images are loaded from Steam tarballs with docker load, not pulled from the registry."
  fi
  return 0
}
