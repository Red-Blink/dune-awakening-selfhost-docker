#!/usr/bin/env bash
set -euo pipefail

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

  container="$(docker ps --filter name='^/dune-orchestrator$' --format '{{.Names}}' 2>/dev/null | head -n1 || true)"
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
  if is_ipv4 "$existing"; then
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

resolve_rmq_game_host() {
  local configured

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

  printf '%s' "127.0.0.1"
}

resolve_rmq_admin_host() {
  local configured

  configured="$(first_known_value "${DUNE_RMQ_ADMIN_HOST:-}" "$(config_value .env DUNE_RMQ_ADMIN_HOST 2>/dev/null || true)" || true)"
  if value_is_known "$configured"; then
    printf '%s' "$configured"
    return 0
  fi

  resolve_rmq_game_host
}

ensure_host_latency_tuned() {
  local stamp="runtime/generated/host-latency-tune.stamp"
  local interval="${DUNE_HOST_LATENCY_TUNE_INTERVAL_SECONDS:-300}"
  local now last elapsed

  [ "${DUNE_HOST_LATENCY_TUNE:-1}" = "1" ] || return 0
  [ -x runtime/scripts/host-latency-tune.sh ] || return 0
  mkdir -p runtime/generated

  now="$(date +%s)"
  last="$(cat "$stamp" 2>/dev/null || true)"
  if [ -n "$last" ] && [ "$last" -gt 0 ] 2>/dev/null; then
    elapsed=$((now - last))
    [ "$elapsed" -lt "$interval" ] && return 0
  fi

  if timeout --kill-after=2s "${DUNE_HOST_LATENCY_TUNE_TIMEOUT_SECONDS:-30}s" runtime/scripts/host-latency-tune.sh >/tmp/dune-host-latency-tune.log 2>&1; then
    printf '%s\n' "$now" >"$stamp"
  else
    echo "WARN host latency tuning did not complete; continuing startup. See /tmp/dune-host-latency-tune.log" >&2
  fi
}

game_external_address_override_env_args() {
  local mode bind_ip advertised_ip

  [ "${DUNE_DISABLE_GAME_EXTERNAL_ADDRESS_OVERRIDE:-0}" = "1" ] && return 0

  mode="$(resolve_server_ip_mode 2>/dev/null || true)"
  bind_ip="$(resolve_game_listen_ip)"
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

resolve_server_login_password_secret() {
  local path="runtime/secrets/server-login-password-secret.txt"
  ensure_secret_file "$path" 32
  tr -d '\r\n' < "$path"
}

resolve_username_server_login_secret() {
  local path="runtime/secrets/username-server-login-secret.txt"
  ensure_secret_file "$path" 32
  tr -d '\r\n' < "$path"
}

resolve_login_password_skew_seconds() {
  first_known_value \
    "${DUNE_LOGIN_PASSWORD_SKEW_SECONDS:-}" \
    "$(config_value .env DUNE_LOGIN_PASSWORD_SKEW_SECONDS 2>/dev/null || true)" \
    "300"
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
