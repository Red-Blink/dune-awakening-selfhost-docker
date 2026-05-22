#!/usr/bin/env bash
set -euo pipefail

value_is_known() {
  local value="${1:-}"
  [ -n "$value" ] && [ "$value" != "unknown" ]
}

config_value() {
  local file="$1"
  local key="$2"

  [ -f "$file" ] || return 1
  awk -F= -v key="$key" '
    $1 == key {
      value = substr($0, length(key) + 2)
      gsub(/^"/, "", value)
      gsub(/"$/, "", value)
      print value
      exit
    }
  ' "$file"
}

container_exists_any_state() {
  local name="$1"
  docker inspect "$name" >/dev/null 2>&1
}

container_env_value_any_state() {
  local container="$1"
  local key="$2"

  if ! container_exists_any_state "$container"; then
    return 1
  fi

  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" 2>/dev/null \
    | awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2); exit }'
}

any_container_env_value_matching() {
  local pattern="$1"
  local key="$2"
  local container

  while IFS= read -r container; do
    [ -n "$container" ] || continue
    if value="$(container_env_value_any_state "$container" "$key" 2>/dev/null || true)" && value_is_known "$value"; then
      printf '%s' "$value"
      return 0
    fi
  done < <(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E "$pattern" || true)

  return 1
}

log_battlegroup_id_value() {
  local log_file="$1"
  [ -f "$log_file" ] || return 1

  python3 - "$log_file" <<'PY'
import re
import sys
from pathlib import Path

log_path = Path(sys.argv[1])
text = log_path.read_text(errors="ignore")
patterns = [
    re.compile(r"bgd\.([A-Za-z0-9_-]+)\.admin"),
    re.compile(r"unique battlegroup key '([A-Za-z0-9_-]+)'"),
    re.compile(r'"SessionName":"([A-Za-z0-9_-]+)"'),
    re.compile(r'BattlegroupId=([A-Za-z0-9_-]+)'),
]

for pattern in patterns:
    matches = pattern.findall(text)
    if matches:
        print(matches[-1])
        raise SystemExit(0)

raise SystemExit(1)
PY
}

resolve_battlegroup_id_from_logs() {
  local override_log
  override_log="$({
    [ -f runtime/generated/sietch-overrides-current.log ] && cat runtime/generated/sietch-overrides-current.log
    ls -t runtime/generated/sietch-overrides*.log 2>/dev/null | head -n 1
  } | awk 'NF { print; exit }')"

  first_known_value \
    "$(log_battlegroup_id_value runtime/text-router/director-current.log 2>/dev/null || true)" \
    "$(log_battlegroup_id_value "${override_log:-runtime/generated/sietch-overrides.log}" 2>/dev/null || true)" \
    || return 1
}

first_known_value() {
  local candidate
  for candidate in "$@"; do
    if value_is_known "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

resolve_server_title() {
  first_known_value \
    "${SERVER_TITLE:-}" \
    "$(config_value .env SERVER_TITLE 2>/dev/null || true)" \
    "$(container_env_value_any_state dune-director BATTLEGROUP_TITLE 2>/dev/null || true)" \
    "$(container_env_value_any_state dune-server-gateway gateway_display_name 2>/dev/null || true)" \
    "My Dune Server"
}

resolve_server_region() {
  first_known_value \
    "${SERVER_REGION:-}" \
    "$(config_value .env SERVER_REGION 2>/dev/null || true)" \
    "$(container_env_value_any_state dune-director BATTLEGROUP_REGION_NAME 2>/dev/null || true)" \
    "$(container_env_value_any_state dune-server-gateway OnlineSubsystem_DatacenterId 2>/dev/null || true)" \
    "Europe"
}

resolve_server_ip() {
  first_known_value \
    "${SERVER_IP:-}" \
    "$(config_value .env SERVER_IP 2>/dev/null || true)" \
    "$(container_env_value_any_state dune-director HOST_DATACENTER_IP_ADDRESS 2>/dev/null || true)" \
    "$(container_env_value_any_state dune-server-gateway HOST_DATACENTER_IP_ADDRESS 2>/dev/null || true)" \
    "auto"
}

resolve_battlegroup_id() {
  first_known_value \
    "$(config_value runtime/generated/battlegroup.env BATTLEGROUP_ID 2>/dev/null || true)" \
    "$(container_env_value_any_state dune-director BATTLEGROUP 2>/dev/null || true)" \
    "$(container_env_value_any_state dune-server-gateway BATTLEGROUP 2>/dev/null || true)" \
    "$(container_env_value_any_state dune-server-overmap BATTLEGROUP 2>/dev/null || true)" \
    "$(container_env_value_any_state dune-server-survival-1 BATTLEGROUP 2>/dev/null || true)" \
    "$(any_container_env_value_matching '^dune-server-' BATTLEGROUP 2>/dev/null || true)" \
    "$(resolve_battlegroup_id_from_logs 2>/dev/null || true)" \
    "${BATTLEGROUP_ID:-}" \
    "dune-docker"
}
