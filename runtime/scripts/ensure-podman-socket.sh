#!/usr/bin/env bash
# Shared Podman socket setup for Linux/WSL. Source this file; do not execute directly.
set -euo pipefail

_ep_need_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo "$@"
  else
    echo "Podman setup needs sudo inside WSL." >&2
    return 1
  fi
}

_ep_is_wsl() {
  grep -qiE '(microsoft|wsl)' /proc/version 2>/dev/null
}

_ep_has_systemd() {
  command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]
}

_ep_wait_for_socket() {
  local path="$1"
  local attempt
  for attempt in $(seq 1 20); do
    if [ -S "$path" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

_ep_start_user_podman_socket() {
  local user uid runtime_dir
  user="${USER:-root}"
  uid="$(id -u)"
  runtime_dir="/run/user/${uid}"

  _ep_need_sudo loginctl enable-linger "$user" 2>/dev/null || true

  if [ ! -d "$runtime_dir" ]; then
    _ep_need_sudo mkdir -p "$runtime_dir" 2>/dev/null || true
    _ep_need_sudo chown "${user}:${user}" "$runtime_dir" 2>/dev/null || true
  fi

  export XDG_RUNTIME_DIR="$runtime_dir"
  if [ -S "${runtime_dir}/bus" ] || [ -d "${runtime_dir}/systemd" ]; then
    systemctl --user enable --now podman.socket 2>/dev/null || \
      systemctl --user start podman.socket 2>/dev/null || true
  fi

  if [ ! -S "${runtime_dir}/podman/podman.sock" ]; then
    _ep_need_sudo -u "$user" env XDG_RUNTIME_DIR="$runtime_dir" \
      systemctl --user enable --now podman.socket 2>/dev/null || true
  fi
}

configure_podman_for_compose() {
  if ! command -v podman >/dev/null 2>&1; then
    return 1
  fi
  if ! _ep_has_systemd; then
    return 1
  fi

  local uid user
  user="${USER:-root}"
  uid="$(id -u)"

  if getent group podman >/dev/null 2>&1; then
    _ep_need_sudo usermod -aG podman "$user" 2>/dev/null || true
  fi

  _ep_need_sudo systemctl enable --now podman.socket 2>/dev/null || true
  if _ep_wait_for_socket /run/podman/podman.sock; then
    export DOCKER_HOST='unix:///run/podman/podman.sock'
    return 0
  fi

  if _ep_is_wsl; then
    _ep_start_user_podman_socket
    if _ep_wait_for_socket "/run/user/${uid}/podman/podman.sock"; then
      export DOCKER_HOST="unix:///run/user/${uid}/podman/podman.sock"
      return 0
    fi
  fi

  return 1
}

export_podman_docker_host() {
  if [ -S /run/podman/podman.sock ]; then
    export DOCKER_HOST='unix:///run/podman/podman.sock'
    return 0
  fi
  local user_sock="/run/user/$(id -u)/podman/podman.sock"
  if [ -S "$user_sock" ]; then
    export DOCKER_HOST="unix://${user_sock}"
    return 0
  fi
  return 1
}

should_use_podman_compose() {
  [ "${CONTAINER_RUNTIME:-docker}" = "podman" ] && _ep_is_wsl && command -v podman-compose >/dev/null 2>&1
}

resolve_container_cmd() {
  CONTAINER_CMD=()
  if declare -p DOCKER >/dev/null 2>&1; then
    CONTAINER_CMD=("${DOCKER[@]}")
    return
  fi
  if [ "${CONTAINER_RUNTIME:-docker}" = "podman" ]; then
    CONTAINER_CMD=(podman)
  else
    CONTAINER_CMD=(docker)
  fi
}

verify_console_container() {
  local name="${1:-redblink-dune-docker-console}"
  local attempt
  resolve_container_cmd

  for attempt in $(seq 1 20); do
    if "${CONTAINER_CMD[@]}" ps --format '{{.Names}}' 2>/dev/null | grep -qx "$name"; then
      return 0
    fi
    sleep 1
  done

  echo "Console container '$name' is not running after startup." >&2
  "${CONTAINER_CMD[@]}" ps -a --filter "name=${name}" --format 'table {{.Names}}\t{{.Status}}' 2>/dev/null || true
  echo "Recent container logs:" >&2
  "${CONTAINER_CMD[@]}" logs --tail 30 "$name" 2>/dev/null || true
  return 1
}

remove_stale_console_container() {
  local name="${1:-redblink-dune-docker-console}"
  resolve_container_cmd

  if ! "${CONTAINER_CMD[@]}" ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$name"; then
    return
  fi
  if ! "${CONTAINER_CMD[@]}" ps --format '{{.Names}}' 2>/dev/null | grep -qx "$name"; then
    echo "Removing stopped console container: $name"
    "${CONTAINER_CMD[@]}" rm -f "$name" 2>/dev/null || true
    return
  fi
  if ! "${CONTAINER_CMD[@]}" exec "$name" true 2>/dev/null; then
    echo "Removing unhealthy console container: $name"
    "${CONTAINER_CMD[@]}" rm -f "$name" 2>/dev/null || true
  fi
}

export_console_compose_env() {
  export DUNE_HOST_REPO_ROOT="${DUNE_HOST_REPO_ROOT:-$(pwd -P)}"
  export ADMIN_BIND_HOST="${ADMIN_BIND_HOST:-0.0.0.0}"
  export ADMIN_BIND_PORT="${ADMIN_BIND_PORT:-8088}"
  export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-dune-awakening-selfhost-docker}"
}

run_compose_up() {
  local compose_file="$1"
  local service="$2"
  export_console_compose_env
  remove_stale_console_container "$service"

  if should_use_podman_compose; then
    configure_podman_for_compose 2>/dev/null || true
    export_podman_docker_host 2>/dev/null || true
    echo "Using podman-compose to start the Web UI on port ${ADMIN_BIND_PORT}."
    podman-compose -f "$compose_file" up -d --build --force-recreate "$service"
    if ! verify_console_container "$service"; then
      echo "Warning: console container verification failed; check logs above." >&2
    fi
    return
  fi

  echo "Using docker compose to start the Web UI on port ${ADMIN_BIND_PORT}."
  if declare -p DOCKER >/dev/null 2>&1; then
    "${DOCKER[@]}" compose -f "$compose_file" up -d --build --force-recreate "$service"
  else
    docker compose -f "$compose_file" up -d --build --force-recreate "$service"
  fi
  if ! verify_console_container "$service"; then
    echo "Warning: console container verification failed; check logs above." >&2
  fi
}
