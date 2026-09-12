#!/usr/bin/env bash
set -euo pipefail

# shellcheck disable=SC1091
source runtime/scripts/memory-swap-common.sh
# shellcheck source=runtime/scripts/env-file.sh
source runtime/scripts/env-file.sh
# shellcheck source=runtime/scripts/host-file-ownership.sh
source runtime/scripts/host-file-ownership.sh
# shellcheck source=runtime/scripts/lib/secrets.sh
source runtime/scripts/lib/secrets.sh

# shellcheck disable=SC1091
source runtime/scripts/compose-project.sh
if [ -z "${DUNE_COMPOSE_PROJECT_NAME:-}" ]; then
  DUNE_COMPOSE_PROJECT_NAME="$(dune_resolve_compose_project_name "$(pwd -P)")"
  export DUNE_COMPOSE_PROJECT_NAME
fi
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$DUNE_COMPOSE_PROJECT_NAME}"

# Keep Docker's json-file logs bounded. These arguments are shared by every
# container created directly by the runtime scripts.
DUNE_DOCKER_LOG_MAX_SIZE="${DUNE_DOCKER_LOG_MAX_SIZE:-50m}"
DUNE_DOCKER_LOG_MAX_FILES="${DUNE_DOCKER_LOG_MAX_FILES:-3}"
if ! printf '%s' "$DUNE_DOCKER_LOG_MAX_SIZE" | grep -Eq '^[1-9][0-9]*[kKmMgG]$'; then
  echo "Invalid DUNE_DOCKER_LOG_MAX_SIZE=$DUNE_DOCKER_LOG_MAX_SIZE; expected a value such as 50m." >&2
  return 1
fi
if ! printf '%s' "$DUNE_DOCKER_LOG_MAX_FILES" | grep -Eq '^[1-9][0-9]*$'; then
  echo "Invalid DUNE_DOCKER_LOG_MAX_FILES=$DUNE_DOCKER_LOG_MAX_FILES; expected a positive integer." >&2
  return 1
fi
# shellcheck disable=SC2034 # Consumed by scripts that source this file.
DUNE_DOCKER_LOG_ARGS=(
  --log-driver json-file
  --log-opt "max-size=$DUNE_DOCKER_LOG_MAX_SIZE"
  --log-opt "max-file=$DUNE_DOCKER_LOG_MAX_FILES"
)

value_is_known() {
  local value="${1:-}"
  [ -n "$value" ] && [ "$value" != "unknown" ]
}

is_ipv4() {
  printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'
}

is_private_ipv4() {
  local ip="$1"
  printf '%s' "$ip" | grep -Eq '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)'
}

read_ipv4_ip_nonlocal_bind() {
  [ -r /proc/sys/net/ipv4/ip_nonlocal_bind ] || return 1
  tr -d '[:space:]' </proc/sys/net/ipv4/ip_nonlocal_bind
}

config_value() {
  local file="$1"
  local key="$2"

  [ -r "$file" ] || return 1
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

port_env_value() {
  local key="$1"
  local default_value="$2"
  local value="${!key:-$default_value}"

  if printf '%s' "$value" | grep -Eq '^[0-9]+$' && [ "$value" -ge 1 ] && [ "$value" -le 65535 ]; then
    printf '%s' "$value"
    return 0
  fi

  printf '%s\n' "Invalid $key=$value; expected TCP/UDP port 1-65535." >&2
  return 1
}

resolve_postgres_port() { port_env_value POSTGRES_PORT 15432; }
resolve_rmq_admin_port() { port_env_value RMQ_ADMIN_PORT 32573; }
resolve_rmq_game_port() { port_env_value RMQ_GAME_PORT 31982; }
resolve_rmq_game_http_port() { port_env_value RMQ_GAME_HTTP_PORT 31983; }
resolve_text_router_port() { port_env_value TEXT_ROUTER_PORT 5059; }
resolve_director_port() { port_env_value DIRECTOR_PORT 11717; }

normalize_generated_env_permissions() {
  local file

  for file in \
    runtime/generated/battlegroup.env \
    runtime/generated/battlegroup-restore-point.env \
    runtime/generated/db-backup.env \
    runtime/generated/ip-change-restart.env \
    runtime/generated/restart-schedule.env \
    runtime/generated/update-auto.env; do
    [ -e "$file" ] || continue
    chmod g+r,u+rw "$file" 2>/dev/null || true
  done
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

host_datacenter_id_is_valid() {
  local value="${1:-}"

  [ "${#value}" -ge 1 ] && [ "${#value}" -le 253 ] \
    && printf '%s' "$value" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$'
}

resolve_host_datacenter_id() {
  local value

  value="$(first_known_value \
    "$(config_value .env HOST_DATACENTER_ID 2>/dev/null || true)" \
    "${HOST_DATACENTER_ID:-}" \
    "$(config_value .env SERVER_PROVIDER 2>/dev/null || true)" \
    "${SERVER_PROVIDER:-}" \
    "dune-docker")"

  if ! host_datacenter_id_is_valid "$value"; then
    printf '%s\n' "Invalid HOST_DATACENTER_ID=$value; use a hostname or short ID containing only letters, numbers, dots, and hyphens." >&2
    return 1
  fi

  printf '%s' "$value"
}

resolve_server_title() {
  first_known_value     "$(config_value .env SERVER_TITLE 2>/dev/null || true)"     "${SERVER_TITLE:-}"     "$(container_env_value_any_state dune-director BATTLEGROUP_TITLE 2>/dev/null || true)"     "$(container_env_value_any_state dune-server-gateway gateway_display_name 2>/dev/null || true)"     "My Dune Server"
}

resolve_server_region() {
  first_known_value     "$(config_value .env SERVER_REGION 2>/dev/null || true)"     "${SERVER_REGION:-}"     "$(container_env_value_any_state dune-director BATTLEGROUP_REGION_NAME 2>/dev/null || true)"     "$(container_env_value_any_state dune-server-gateway OnlineSubsystem_DatacenterId 2>/dev/null || true)"     "Europe"
}

detect_public_ip() {
  local ip=""

  if command -v curl >/dev/null 2>&1; then
    for url in       "https://api.ipify.org"       "https://ipv4.icanhazip.com"       "https://ifconfig.me/ip"
    do
      ip="$(curl -fsS4 --max-time 8 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
      if is_ipv4 "$ip"; then
        printf '%s' "$ip"
        return 0
      fi
      ip="$(curl -fsS --max-time 8 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
      if is_ipv4 "$ip"; then
        printf '%s' "$ip"
        return 0
      fi
    done
  fi

  if command -v wget >/dev/null 2>&1; then
    for url in       "https://api.ipify.org"       "https://ipv4.icanhazip.com"
    do
      ip="$(wget -qO- -T 8 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
      if is_ipv4 "$ip"; then
        printf '%s' "$ip"
        return 0
      fi
    done
  fi

  return 1
}

detect_local_ip() {
  local ip=""

  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '
      {
        for (i = 1; i <= NF; i++) {
          if ($i == "src") {
            print $(i + 1)
            exit
          }
        }
      }
    ' | tr -d '[:space:]' || true)"

    if is_private_ipv4 "$ip"; then
      printf '%s' "$ip"
      return 0
    fi
  fi

  if command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | tr ' ' '
' | grep -E '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' | head -n1 || true)"
    if is_private_ipv4 "$ip"; then
      printf '%s' "$ip"
      return 0
    fi
  fi

  return 1
}

detect_docker_desktop_host_bind_ip() {
  local ip="" container=""

  command -v docker >/dev/null 2>&1 || return 1
  docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -qi 'docker desktop' || return 1

  container="$(dune_compose_running_service_container "$DUNE_COMPOSE_PROJECT_NAME" orchestrator 2>/dev/null || true)"
  if [ -n "$container" ]; then
    ip="$(docker exec "$container" sh -c "ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if(\$i==\"src\"){print \$(i+1); exit}}'" 2>/dev/null | tr -d '[:space:]' || true)"
    if is_ipv4 "$ip"; then
      printf '%s' "$ip"
      return 0
    fi
  fi

  if docker image inspect redblink-dune-docker-console:dev >/dev/null 2>&1; then
    ip="$(docker run --rm --network host --entrypoint sh redblink-dune-docker-console:dev -c "ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if(\$i==\"src\"){print \$(i+1); exit}}'" 2>/dev/null | tr -d '[:space:]' || true)"
    if is_ipv4 "$ip"; then
      printf '%s' "$ip"
      return 0
    fi
  fi

  return 1
}

detect_bind_ip() {
  local ip=""

  ip="$(detect_docker_desktop_host_bind_ip 2>/dev/null || true)"
  if is_ipv4 "$ip"; then
    printf '%s' "$ip"
    return 0
  fi

  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -o -4 addr show up scope global 2>/dev/null | awk '$2 !~ /^(lo|docker|br-|veth)/ { sub(/\/.*/, "", $4); print $4; exit }' | tr -d '[:space:]' || true)"
    if is_ipv4 "$ip"; then
      printf '%s' "$ip"
      return 0
    fi

    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' | tr -d '[:space:]' || true)"
    if is_ipv4 "$ip"; then
      printf '%s' "$ip"
      return 0
    fi
  fi

  if command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | tr ' ' '
' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n1 || true)"
    if is_ipv4 "$ip"; then
      printf '%s' "$ip"
      return 0
    fi
  fi

  return 1
}

bind_ip_is_assigned() {
  local requested="$1"
  [ -n "$requested" ] || return 1
  is_ipv4 "$requested" || return 1
  command -v ip >/dev/null 2>&1 || return 1
  ip -o -4 addr show up scope global 2>/dev/null     | awk '$2 !~ /^(lo|docker|br-|veth)/ { sub(/\/.*/, "", $4); print $4 }'     | grep -qx "$requested" && return 0

  if command -v docker >/dev/null 2>&1 \
    && docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -qi 'docker desktop'; then
    return 0
  fi

  return 1
}

resolve_server_ip_mode() {
  local mode configured

  mode="$(first_known_value "$(config_value .env SERVER_IP_MODE 2>/dev/null || true)" "${SERVER_IP_MODE:-}" || true)"
  if [ -n "$mode" ]; then
    printf '%s' "$mode"
    return 0
  fi

  configured="$(first_known_value "${SERVER_IP:-}" "$(config_value .env SERVER_IP 2>/dev/null || true)" || true)"
  if is_private_ipv4 "$configured"; then
    printf '%s' "local"
    return 0
  fi
  if is_ipv4 "$configured"; then
    printf '%s' "public"
    return 0
  fi

  printf '%s' "public"
}

resolve_server_ip() {
  local mode configured detected

  configured="$(first_known_value "$(config_value .env SERVER_IP 2>/dev/null || true)" "${SERVER_IP:-}" || true)"
  if value_is_known "$configured" && [ "$configured" != "auto" ]; then
    printf '%s' "$configured"
    return 0
  fi

  mode="$(resolve_server_ip_mode 2>/dev/null || true)"
  case "$mode" in
    local)
      detected="$(detect_local_ip 2>/dev/null || true)"
      ;;
    public|*)
      detected="$(detect_public_ip 2>/dev/null || true)"
      ;;
  esac

  first_known_value     "$detected"     "$(config_value .env SERVER_IP 2>/dev/null || true)"     "${SERVER_IP:-}"     "${DUNE_SERVER_IP_FALLBACK:-}"     "$(container_env_value_any_state dune-director HOST_DATACENTER_IP_ADDRESS 2>/dev/null || true)"     "$(container_env_value_any_state dune-server-gateway HOST_DATACENTER_IP_ADDRESS 2>/dev/null || true)"     "$(detect_bind_ip 2>/dev/null || true)"     "auto"
}

resolve_bind_ip() {
  local requested existing detected

  requested="$(first_known_value "${SERVER_BIND_IP:-}" "$(config_value .env SERVER_BIND_IP 2>/dev/null || true)" || true)"
  if bind_ip_is_assigned "$requested"; then
    printf '%s' "$requested"
    return 0
  fi

  existing="$(first_known_value \
    "$(container_env_value_any_state dune-server-survival-1 POD_IP 2>/dev/null || true)" \
    "$(container_env_value_any_state dune-server-overmap POD_IP 2>/dev/null || true)" \
    "$(any_container_env_value_matching '^dune-server-' POD_IP 2>/dev/null || true)" \
    || true)"
  if bind_ip_is_assigned "$existing"; then
    printf '%s' "$existing"
    return 0
  fi

  detected="$(detect_bind_ip 2>/dev/null || true)"
  if is_ipv4 "$detected"; then
    printf '%s' "$detected"
    return 0
  fi

  printf '%s' "127.0.0.1"
}

resolve_advertised_ip() {
  resolve_server_ip
}

resolve_game_listen_ip() {
  resolve_bind_ip
}

resolve_game_addr_ip() {
  resolve_advertised_ip
}

resolve_igw_addr_ip() {
  resolve_game_listen_ip
}

tcp_endpoint_reachable() {
  local host="$1"
  local port="$2"

  value_is_known "$host" || return 1
  printf '%s' "$port" | grep -Eq '^[0-9]+$' || return 1

  if command -v python3 >/dev/null 2>&1; then
    python3 -c '
import socket
import sys

try:
    connection = socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=0.5)
except OSError:
    raise SystemExit(1)
else:
    connection.close()
' "$host" "$port" >/dev/null 2>&1
    return $?
  fi

  if command -v timeout >/dev/null 2>&1; then
    # shellcheck disable=SC2016 # $1/$2 are intentionally expanded by the child bash.
    timeout 1 bash -c 'exec 3<>"/dev/tcp/$1/$2"' _ "$host" "$port" >/dev/null 2>&1
    return $?
  fi

  return 1
}

resolve_rmq_game_host() {
  local configured resolved_bind_ip game_port

  configured="$(first_known_value "${DUNE_RMQ_GAME_HOST:-}" "$(config_value .env DUNE_RMQ_GAME_HOST 2>/dev/null || true)" || true)"
  if value_is_known "$configured"; then
    printf '%s' "$configured"
    return 0
  fi

  if command -v docker >/dev/null 2>&1 \
    && docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -qi 'docker desktop'; then
    resolve_advertised_ip
    return 0
  fi

  game_port="$(resolve_rmq_game_port)"
  if tcp_endpoint_reachable "127.0.0.1" "$game_port"; then
    printf '%s' "127.0.0.1"
    return 0
  fi

  # Some native-Linux Docker hosts publish 0.0.0.0 ports on their assigned
  # interface but do not make the same port reachable through loopback. Game
  # containers use host networking, so the resolved bind address is the
  # stable local route to that published broker endpoint on those systems.
  resolved_bind_ip="$(resolve_game_listen_ip 2>/dev/null || true)"
  if value_is_known "$resolved_bind_ip" && [ "$resolved_bind_ip" != "127.0.0.1" ]; then
    printf '%s' "$resolved_bind_ip"
    return 0
  fi

  printf '%s' "127.0.0.1"
}

resolve_rmq_admin_host() {
  local configured

  configured="$(first_known_value "${DUNE_RMQ_ADMIN_HOST:-}" "$(config_value .env DUNE_RMQ_ADMIN_HOST 2>/dev/null || true)" || true)"
  if value_is_known "$configured"; then
    printf '%s' "$configured"
    return 0
  fi

  if command -v docker >/dev/null 2>&1 \
    && docker info --format '{{.OperatingSystem}}' 2>/dev/null | grep -qi 'docker desktop'; then
    resolve_rmq_game_host
    return 0
  fi

  # The admin broker is intentionally published on loopback only. Keep it
  # independent from the game broker, which may need the host bind address.
  printf '%s' "127.0.0.1"
}

ensure_host_latency_tuned() {
  local stamp="runtime/generated/host-latency-tune.stamp"
  local interval="${DUNE_HOST_LATENCY_TUNE_INTERVAL_SECONDS:-300}"
  local now last elapsed latency_log

  [ "${DUNE_HOST_LATENCY_TUNE:-1}" = "1" ] || return 0
  [ -x runtime/scripts/host-latency-tune.sh ] || return 0
  mkdir -p runtime/generated

  now="$(date +%s)"
  last="$(cat "$stamp" 2>/dev/null || true)"
  if [ -n "$last" ] && [ "$last" -gt 0 ] 2>/dev/null; then
    elapsed=$((now - last))
    [ "$elapsed" -lt "$interval" ] && return 0
  fi

  latency_log="$(mktemp "${TMPDIR:-/tmp}/dune-host-latency-tune.XXXXXX.log")" || {
    echo "WARN could not create a temporary host latency tuning log; continuing startup." >&2
    return 0
  }
  if timeout --kill-after=2s "${DUNE_HOST_LATENCY_TUNE_TIMEOUT_SECONDS:-30}s" runtime/scripts/host-latency-tune.sh >"$latency_log" 2>&1; then
    rm -f "$latency_log"
    printf '%s\n' "$now" >"$stamp"
    dune_set_host_path_owner "$stamp"
  else
    dune_set_host_path_owner "$latency_log"
    echo "WARN host latency tuning did not complete; continuing startup. See $latency_log" >&2
  fi
}

game_external_address_override_env_args() {
  local mode advertised_ip

  [ "${DUNE_DISABLE_GAME_EXTERNAL_ADDRESS_OVERRIDE:-0}" = "1" ] && return 0

  mode="$(resolve_server_ip_mode 2>/dev/null || true)"
  advertised_ip="$(resolve_advertised_ip)"

  if [ "$mode" != "public" ] && [ "${DUNE_ALLOW_GAME_EXTERNAL_ADDRESS_OVERRIDE:-0}" != "1" ]; then
    return 0
  fi

  if ! is_ipv4 "$advertised_ip" || [ "$advertised_ip" = "auto" ]; then
    return 0
  fi

  # run-server.sh turns this into -ExternalAddress while preserving -MultiHome
  # as the local bind IP. NAT/public hosts need both: bind locally, advertise
  # publicly in server-state messages consumed by the in-game browser.
  printf '%s\n' -e "EXTERNAL_ADDRESS_OVERRIDE=$advertised_ip"
}

validate_game_external_address_override_env_args() {
  local mode advertised_ip bind_ip nonlocal_bind arg found=0

  [ "${DUNE_DISABLE_GAME_EXTERNAL_ADDRESS_OVERRIDE:-0}" = "1" ] && return 0

  mode="$(resolve_server_ip_mode 2>/dev/null || true)"
  [ "$mode" = "public" ] || return 0

  advertised_ip="$(resolve_advertised_ip)"
  if ! is_ipv4 "$advertised_ip" || [ "$advertised_ip" = "auto" ]; then
    echo "Public mode requires a valid SERVER_IP before starting game containers." >&2
    echo "Set SERVER_IP to your public IPv4, or switch SERVER_IP_MODE=local for LAN-only hosting." >&2
    return 1
  fi

  bind_ip="$(resolve_bind_ip)"
  nonlocal_bind="$(read_ipv4_ip_nonlocal_bind 2>/dev/null || true)"
  if [ "${DUNE_ALLOW_PUBLIC_IP_NONLOCAL_BIND:-0}" != "1" ] \
    && [ "$nonlocal_bind" = "1" ] \
    && is_ipv4 "$bind_ip" \
    && is_private_ipv4 "$bind_ip" \
    && [ "$advertised_ip" != "$bind_ip" ]; then
    echo "Public NAT mode detected, but net.ipv4.ip_nonlocal_bind=1 on this host." >&2
    echo "This can make game client UDP sockets bind to SERVER_IP=$advertised_ip instead of SERVER_BIND_IP=$bind_ip." >&2
    echo "For NAT/double NAT, forwarded UDP packets land on $bind_ip, so the game sockets must bind there." >&2
    echo "Run: sudo sysctl -w net.ipv4.ip_nonlocal_bind=0" >&2
    echo "Then restart the stack. To bypass this guard intentionally, set DUNE_ALLOW_PUBLIC_IP_NONLOCAL_BIND=1." >&2
    return 1
  fi

  for arg in "$@"; do
    if [ "$arg" = "EXTERNAL_ADDRESS_OVERRIDE=$advertised_ip" ]; then
      found=1
      break
    fi
  done

  if [ "$found" != "1" ]; then
    echo "Public mode would start a game container without EXTERNAL_ADDRESS_OVERRIDE=$advertised_ip." >&2
    echo "Refusing to start because clients may receive private LAN addresses for map travel." >&2
    echo "Unset DUNE_DISABLE_GAME_EXTERNAL_ADDRESS_OVERRIDE or fix SERVER_IP/SERVER_IP_MODE, then retry." >&2
    return 1
  fi
}

usersettings_engine_value() {
  local key="$1"
  local fallback="$2"
  local value

  value="$(python3 runtime/scripts/usersettings.py engine-values 2>/dev/null | awk -F '\t' -v key="$key" '$1 == key { print $2; exit }' || true)"
  if value_is_known "$value"; then
    printf '%s' "$value"
    return 0
  fi

  python3 - "$key" "$fallback" <<'PY2'
import json
import sys
from pathlib import Path

key = sys.argv[1]
fallback = sys.argv[2]
path = Path("runtime/generated/usersettings.json")
if not path.exists():
    print(fallback)
    raise SystemExit

try:
    config = json.loads(path.read_text())
except Exception:
    print(fallback)
    raise SystemExit
value = str(config.get("engine", {}).get(key, "")).strip()
if not value:
    print(fallback)
    raise SystemExit

print(value)
PY2
}

resolve_client_port_base() {
  usersettings_engine_value port 7777
}

resolve_igw_port_base() {
  usersettings_engine_value igw_port 7888
}

default_memory_for_map() {
  case "${1,,}" in
    survival|survival-1|survival_1) printf '%s' "16g" ;;
    overmap) printf '%s' "3g" ;;
    deepdesert|deepdesert-1|deepdesert_1) printf '%s' "16g" ;;
    dlc_story_lostharvest_ecolaba|dlc-story-lostharvest-ecolaba) printf '%s' "2g" ;;
    dlc_story_lostharvest_ecolabb|dlc-story-lostharvest-ecolabb) printf '%s' "2g" ;;
    dlc_story_lostharvest_forgottenlab|dlc-story-lostharvest-forgottenlab) printf '%s' "2g" ;;
    *) printf '%s' "3g" ;;
  esac
}

memory_env_key_for_map() {
  local map="$1"
  local normalized

  normalized="$(printf '%s' "$map" | tr '[:lower:]' '[:upper:]' | sed 's/[^A-Z0-9]/_/g; s/__*/_/g; s/^_//; s/_$//')"
  printf 'DUNE_MEMORY_%s\n' "$normalized"
}

effective_memory_for_map() {
  local map="$1"
  local partition="${2:-}"
  local partition_key map_key configured recommended

  if [ -n "$partition" ]; then
    partition_key="DUNE_MEMORY_PARTITION_${partition}"
    configured="${!partition_key:-}"
    if [ -n "$configured" ]; then
      printf '%s\n' "$configured"
      return 0
    fi
  fi

  map_key="$(memory_env_key_for_map "$map")"
  configured="${!map_key:-}"
  if [ -n "$configured" ]; then
    printf '%s\n' "$configured"
    return 0
  fi

  if [ -n "${DUNE_MEMORY_DEFAULT:-}" ]; then
    printf '%s\n' "$DUNE_MEMORY_DEFAULT"
    return 0
  fi

  recommended="$(default_memory_for_map "$map")"
  case "${map,,}" in
    survival_1|deepdesert_1|overmap)
      printf '%s\n' "$recommended"
      return 0
      ;;
  esac
  if [ "$recommended" != "3g" ]; then
    printf '%s\n' "$recommended"
    return 0
  fi

  python3 - "$map" <<'PY'
import json
import sys
from pathlib import Path

target = sys.argv[1].lower()
catalog_path = Path("runtime/generated/server-catalog.json")

if catalog_path.exists():
    try:
        catalog = json.loads(catalog_path.read_text())
    except Exception:
        catalog = []
    for item in catalog:
        if str(item.get("map", "")).lower() != target:
            continue
        memory = item.get("resources", {}).get("limits", {}).get("memory", "")
        if memory:
            print(str(memory).replace("Gi", "g").replace("G", "g"))
            raise SystemExit

print("3g")
PY
}

full_stdout_log_args() {
  if [ "${DUNE_FULL_STDOUT_LOG_OUTPUT:-0}" = "1" ]; then
    printf '%s\n' -stdout -FullStdOutLogOutput
  else
    printf '%s\n' -stdout
  fi
}

ensure_secret_file() {
  local path="$1"
  local bytes="$2"

  if [ ! -s "$path" ]; then
    mkdir -p "$(dirname "$path")"
    openssl rand -hex "$bytes" > "$path"
    chmod 600 "$path"
  fi
}

# resolve_server_login_password_secret / resolve_username_server_login_secret
#
# Stage 2 of the age-based secrets library rollout -- wires these two
# secrets to optional age-based at-rest encryption (see
# runtime/scripts/lib/secrets.sh's own header comment for the key
# hierarchy and on-disk format). Strictly opt-in: an operator who
# never sets DUNE_KEK_FILE/DUNE_AGE_IDENTITY_FILE sees the exact
# same behavior as before this stage existed -- read the plain
# runtime/secrets/*.txt file, generating it via ensure_secret_file if
# absent.
#
# dune_secrets_read_secret is the source of truth for migration state.
# It is called even when backend variables are unset because migration
# artifacts may outlive configuration (for example after a restore or
# environment-file mistake). Any such migrated-but-broken state fails
# closed; plaintext is generated only when there is no migration history
# and no legacy value on a genuinely fresh install.
_resolve_stage2_secret() {
  local name="$1"
  local legacy_path="runtime/secrets/${name}.txt"

  local value rc=0
  value="$(dune_secrets_read_secret "$name" "$legacy_path")" || rc=$?
  if [ "$rc" = "0" ]; then
    printf '%s' "$value"
    return 0
  fi

  if dune_secrets_has_migration_artifacts "$name"; then
    return "$rc"
  fi

  ensure_secret_file "$legacy_path" 32
  tr -d '\r\n' < "$legacy_path"
}

resolve_server_login_password_secret() {
  _resolve_stage2_secret "server-login-password-secret"
}

resolve_username_server_login_secret() {
  _resolve_stage2_secret "username-server-login-secret"
}

resolve_login_password_skew_seconds() {
  first_known_value \
    "${DUNE_LOGIN_PASSWORD_SKEW_SECONDS:-}" \
    "$(config_value .env DUNE_LOGIN_PASSWORD_SKEW_SECONDS 2>/dev/null || true)" \
    "300"
}

resolve_battlegroup_id() {
  local candidate
  for candidate in \
    "$(config_value runtime/generated/battlegroup.env BATTLEGROUP_ID 2>/dev/null || true)" \
    "$(container_env_value_any_state dune-director BATTLEGROUP 2>/dev/null || true)" \
    "$(container_env_value_any_state dune-server-gateway BATTLEGROUP 2>/dev/null || true)" \
    "$(container_env_value_any_state dune-server-overmap BATTLEGROUP 2>/dev/null || true)" \
    "$(container_env_value_any_state dune-server-survival-1 BATTLEGROUP 2>/dev/null || true)" \
    "$(any_container_env_value_matching '^dune-server-' BATTLEGROUP 2>/dev/null || true)" \
    "$(resolve_battlegroup_id_from_logs 2>/dev/null || true)" \
    "${BATTLEGROUP_ID:-}"
  do
    if battlegroup_id_is_valid "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

battlegroup_id_is_valid() {
  printf '%s' "${1:-}" | grep -Eq '^sh-[A-Za-z0-9]+-[A-Za-z0-9]+$'
}

battlegroup_host_id() {
  local value="${1:-}"
  battlegroup_id_is_valid "$value" || return 1
  printf '%s\n' "$value" | sed -E 's/^sh-([A-Za-z0-9]+)-.*$/\1/'
}

funcom_token_host_id() {
  local token_file="${1:-runtime/secrets/funcom-token.txt}"
  [ -s "$token_file" ] || return 1
  TOKEN_FILE="$token_file" python3 - <<'PY'
import base64
import json
import os
from pathlib import Path

try:
    token = Path(os.environ["TOKEN_FILE"]).read_text().strip()
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    data = json.loads(base64.urlsafe_b64decode(payload.encode()).decode())
    host_id = data.get("HostId") or data.get("hostId") or data.get("host_id")
    if not host_id:
        raise ValueError("missing HostId")
    print(str(host_id))
except Exception:
    raise SystemExit(1)
PY
}
