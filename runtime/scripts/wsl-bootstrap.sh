#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

step() {
  printf '\n==> %s\n' "$1"
}

is_wsl() {
  grep -qiE '(microsoft|wsl)' /proc/version 2>/dev/null
}

need_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    echo "This step needs root access inside WSL, but sudo was not found." >&2
    exit 1
  fi
  if ! sudo -n true 2>/dev/null; then
    echo "sudo requires a password, but the Windows installer cannot prompt inside WSL." >&2
    echo "Re-run install.ps1 so it can configure passwordless sudo for your WSL user." >&2
    exit 1
  fi
  sudo "$@"
}

run_apt_get() {
  export DEBIAN_FRONTEND=noninteractive
  if command -v stdbuf >/dev/null 2>&1; then
    need_sudo stdbuf -oL -eL apt-get "$@"
  else
    need_sudo apt-get "$@"
  fi
}

has_systemd() {
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

ensure_podman_packages() {
  command -v apt-get >/dev/null 2>&1 || return 0
  step "Updating package lists (apt-get update)..."
  echo "Downloading Debian package indexes (first run can take several minutes)..."
  run_apt_get update
  echo "Package lists updated."
  step "Installing Podman packages (podman, podman-compose, podman-docker)..."
  echo "Installing packages; download and setup progress appears below..."
  run_apt_get install -y podman podman-compose podman-docker
  step "Podman packages installed."
}

ensure_podman_socket() {
  has_systemd || return 0
  if [ -f runtime/scripts/ensure-podman-socket.sh ]; then
    # shellcheck disable=SC1091
    . runtime/scripts/ensure-podman-socket.sh
    step "Configuring Podman socket for WSL..."
    if configure_podman_for_compose; then
      step "Podman socket is ready at ${DOCKER_HOST:-podman socket}."
      return 0
    fi
  fi
  step "Enabling Podman socket via systemd..."
  need_sudo systemctl enable --now podman.socket || true
  step "Podman socket is enabled."
}

ensure_docker_service() {
  has_systemd || return 0
  step "Ensuring Docker Engine service is enabled..."
  need_sudo systemctl enable --now docker || true
  if getent group docker >/dev/null 2>&1 && [ -n "${USER:-}" ] && [ "$USER" != root ]; then
    need_sudo usermod -aG docker "$USER" 2>/dev/null || true
  fi
  if docker info >/dev/null 2>&1; then
    step "Docker Engine is running."
    return 0
  fi
  echo "Docker Engine is installed but not reachable yet." >&2
  echo "install.sh will finish Docker setup." >&2
}

bootstrap_docker() {
  step "Container runtime: Docker Engine (default for WSL)."
  if docker info >/dev/null 2>&1; then
    echo "Docker is available."
    ensure_docker_service
    return
  fi
  echo "Docker is not running yet; install.sh will install and start Docker Engine."
}

bootstrap_podman() {
  step "Container runtime: Podman (opt-in)."
  if podman info >/dev/null 2>&1; then
    echo "Podman is available."
    ensure_podman_packages
    ensure_podman_socket
    return
  fi
  if docker info >/dev/null 2>&1; then
    echo "Docker is available; skipping Podman package install."
    return
  fi
  echo "No container runtime detected yet; installing Podman packages."
  ensure_podman_packages
  ensure_podman_socket
}

step "WSL bootstrap starting."

if ! is_wsl; then
  echo "wsl-bootstrap.sh is intended to run inside WSL." >&2
  exit 1
fi

step "Checking systemd..."
if ! has_systemd; then
  echo "systemd is not running inside WSL." >&2
  echo "Enable it in /etc/wsl.conf with:" >&2
  echo "  [boot]" >&2
  echo "  systemd=true" >&2
  echo "Then restart WSL from Windows: wsl --shutdown" >&2
  exit 1
fi
echo "systemd is running."

export DUNE_HOST_REPO_ROOT="$(pwd -P)"
step "Repository root: $DUNE_HOST_REPO_ROOT"

RUNTIME="${DUNE_CONTAINER_RUNTIME:-docker}"
step "Configured container runtime: $RUNTIME"

case "$RUNTIME" in
  podman) bootstrap_podman ;;
  *) bootstrap_docker ;;
esac

step "WSL bootstrap finished."

exit 0
