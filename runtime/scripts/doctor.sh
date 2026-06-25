#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env
source runtime/scripts/runtime-env.sh

fail=0
warn=0

ok() {
  echo "OK   $*"
}

warn_msg() {
  echo "WARN $*"
  warn=1
}

fail_msg() {
  echo "FAIL $*"
  fail=1
}

is_running() {
  local name="$1"
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$name"
}

is_wsl() {
  grep -qiE '(microsoft|wsl)' /proc/version /proc/sys/kernel/osrelease 2>/dev/null
}

wsl_visible_memory_gb() {
  awk '/MemTotal:/ { printf "%.0f", ($2 / 1024 / 1024) }' /proc/meminfo 2>/dev/null || true
}

docker_engine_os() {
  docker info --format '{{.OperatingSystem}}' 2>/dev/null || true
}

admin_bind_host_value() {
  local value
  value="$(config_value .env ADMIN_BIND_HOST 2>/dev/null || true)"
  printf '%s' "${value:-auto}"
}

check_file() {
  local file="$1"
  local label="$2"
  local hint="$3"

  if [ -s "$file" ]; then
    ok "$label"
  else
    fail_msg "$label missing"
    echo "     $hint"
  fi
}

check_tcp() {
  local port="$1"
  local label="$2"

  if ss -lntp 2>/dev/null | grep -q ":$port "; then
    ok "$label listening on TCP $port"
  else
    fail_msg "$label not listening on TCP $port"
  fi
}

check_udp() {
  local port="$1"
  local label="$2"

  if ss -lnup 2>/dev/null | grep -q ":$port "; then
    ok "$label listening on UDP $port"
  else
    fail_msg "$label not listening on UDP $port"
  fi
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

echo "=== Dune doctor ==="
echo

echo "=== Host tools ==="
if command -v docker >/dev/null 2>&1; then
  ok "Docker command found"
  if docker info >/dev/null 2>&1; then
    ok "Docker daemon reachable"
  else
    fail_msg "Docker daemon is not reachable"
    echo "     Start Docker and make sure your user can access /var/run/docker.sock."
  fi
else
  fail_msg "Docker command not found"
  echo "     Install Docker Engine."
fi

if docker compose version >/dev/null 2>&1; then
  ok "Docker Compose available"
else
  fail_msg "Docker Compose is not available"
  echo "     Install Docker Compose v2."
fi

echo
echo "=== WSL diagnostics ==="
if is_wsl; then
  ok "Running inside WSL"

  if pwd -P | grep -q '^/mnt/'; then
    warn_msg "Repo is stored under /mnt/*"
    echo "     Move the repo under ~/ inside WSL for better performance and safer bind mounts."
  else
    ok "Repo is stored on the WSL/Linux filesystem"
  fi

  if grep -qw avx2 /proc/cpuinfo 2>/dev/null; then
    ok "AVX2 visible inside WSL"
  elif grep -qw avx /proc/cpuinfo 2>/dev/null; then
    warn_msg "AVX visible, but AVX2 was not detected"
  else
    fail_msg "AVX/AVX2 not visible inside WSL"
  fi

  mem_gb="$(wsl_visible_memory_gb)"
  if [ -n "$mem_gb" ]; then
    if [ "$mem_gb" -ge 20 ] 2>/dev/null; then
      ok "WSL visible memory: ${mem_gb} GB"
    else
      warn_msg "WSL visible memory is low: ${mem_gb} GB"
      echo "     Increase memory in %UserProfile%\\.wslconfig. 20 GB is the practical minimum."
    fi
  fi

  docker_os="$(docker_engine_os)"
  echo "     Docker engine OS: ${docker_os:-unknown}"
  if printf '%s' "$docker_os" | grep -qi 'docker desktop'; then
    warn_msg "Docker Desktop backend detected"
    echo "     Ensure host networking is enabled in Docker Desktop settings."
  else
    ok "Native/non-Docker-Desktop Docker engine detected"
  fi

  if docker network inspect host >/dev/null 2>&1; then
    ok "Docker host network object available"
  else
    fail_msg "Docker host network object missing"
  fi

  admin_host="$(admin_bind_host_value)"
  case "$admin_host" in
    127.0.0.1|localhost)
      ok "Admin UI bind host is localhost-only: $admin_host"
      ;;
    0.0.0.0|auto|'')
      warn_msg "Admin UI may be reachable beyond localhost: ${admin_host:-auto}"
      echo "     Keep ADMIN_BIND_HOST=127.0.0.1 on WSL unless using a trusted LAN/VPN."
      ;;
    *)
      ok "Admin UI bind host is explicit: $admin_host"
      ;;
  esac
else
  ok "Not running inside WSL"
fi

echo
echo "=== Local files ==="
check_file .env ".env config" "Run: dune init"
check_file runtime/secrets/funcom-token.txt "Funcom token file" "Run: dune init, or place the token in runtime/secrets/funcom-token.txt"
check_file runtime/generated/battlegroup.env "Battlegroup config" "Run: dune init"
check_file runtime/generated/image-tags.env "Generated image tags" "Run: dune update install during init, or re-run dune init if this is a fresh install"

echo
echo "=== Containers ==="
for c in \
  dune-postgres \
  dune-rmq-admin \
  dune-rmq-game \
  dune-text-router \
  dune-director \
  dune-server-gateway \
  dune-server-survival-1 \
  dune-server-overmap
do
  if is_running "$c"; then
    ok "container $c"
  else
    fail_msg "container $c is not running"
    echo "     Try: dune start"
  fi
done

echo
echo "=== Ports ==="
check_tcp 15432 "Postgres"
check_tcp 32573 "RabbitMQ admin"
check_tcp 31982 "RabbitMQ game"
check_tcp 31983 "RabbitMQ game HTTP"
check_tcp 5059 "TextRouter"
check_tcp 11717 "Director"
client_port_base="$(resolve_client_port_base)"
igw_port_base="$(resolve_igw_port_base)"
check_udp "$client_port_base" "Overmap clients"
check_udp "$((client_port_base + 1))" "Survival_1 clients"
check_udp "$igw_port_base" "Survival_1 server-to-server"
check_udp "$((igw_port_base + 1))" "Overmap server-to-server"

echo
echo "=== Steam server files ==="
app_id="$(config_value .env STEAM_APP_ID || true)"
app_id="${app_id:-${STEAM_APP_ID:-4754530}}"
if is_running dune-orchestrator; then
  if docker compose exec -T orchestrator test -f "/srv/dune/server/steamapps/appmanifest_${app_id}.acf" 2>/dev/null; then
    ok "Steam appmanifest found for app $app_id"
  else
    fail_msg "Steam appmanifest not found for app $app_id"
    echo "     Run first-time setup: dune init"
  fi
else
  warn_msg "dune-orchestrator is not running; cannot inspect Steam appmanifest"
fi

echo
echo "=== Database ==="
if is_running dune-postgres; then
  if docker exec dune-postgres pg_isready -U postgres -d dune >/dev/null 2>&1; then
    ok "Postgres reachable"
  else
    fail_msg "Postgres is running but not ready"
  fi

  partition_count="$(docker exec dune-postgres psql -U dune -d dune -Atc "select count(*) from world_partition;" 2>/dev/null | tr -d '[:space:]' || true)"
  if [ "${partition_count:-0}" -gt 0 ] 2>/dev/null; then
    ok "world_partition rows: $partition_count"
  else
    fail_msg "world_partition has no rows"
    echo "     Fresh init should apply canonical world partitions."
  fi
else
  fail_msg "Cannot check database because dune-postgres is not running"
fi

echo
echo "=== Sietch state ==="
if is_running dune-postgres; then
  if runtime/scripts/sietches.sh validate >/tmp/dune-doctor-sietch.out 2>/tmp/dune-doctor-sietch.err; then
    ok "Sietch generated state matches current world partitions"
  else
    fail_msg "Sietch generated state validation failed"
    sed 's/^/     /' /tmp/dune-doctor-sietch.out 2>/dev/null || true
    sed 's/^/     /' /tmp/dune-doctor-sietch.err 2>/dev/null || true
  fi
  rm -f /tmp/dune-doctor-sietch.out /tmp/dune-doctor-sietch.err
else
  warn_msg "Skipping Sietch state validation because dune-postgres is not running"
fi

echo
echo "=== RabbitMQ and service signals ==="
if is_running dune-rmq-game && docker exec dune-rmq-game rabbitmq-diagnostics -q ping >/dev/null 2>&1; then
  ok "RabbitMQ game reachable"
else
  fail_msg "RabbitMQ game is not reachable"
fi

director_logs="$(docker logs --since 15m dune-director 2>&1 || true)"
if grep -q 'Battlegroups_SendBattlegroupHeartbeat.*Request successful' <<< "$director_logs"; then
  ok "Director heartbeat to Funcom/FLS"
else
  warn_msg "Director heartbeat not seen in recent logs"
  echo "     If the stack just started, wait a few minutes and run: dune ready"
fi

if docker logs --tail 5000 dune-server-gateway 2>&1 | grep -q 'Monitoring for servers going up or down'; then
  ok "Gateway DB monitoring"
else
  warn_msg "Gateway DB monitoring not seen in recent logs"
fi

echo
echo "=== Hosting mode hints ==="
mode="$(config_value .env SERVER_IP_MODE || true)"
mode="${mode:-$(config_value runtime/generated/battlegroup.env SERVER_IP_MODE || true)}"
mode="${mode:-${SERVER_IP_MODE:-}}"
server_ip="$(config_value .env SERVER_IP || true)"
server_ip="${server_ip:-$(config_value runtime/generated/battlegroup.env SERVER_IP || true)}"
server_ip="${server_ip:-${SERVER_IP:-unknown}}"
if [ -z "$mode" ] || [ "$mode" = "unknown" ]; then
  if printf '%s' "$server_ip" | grep -Eq '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)'; then
    mode="local"
  elif [ "$server_ip" != "unknown" ] && [ -n "$server_ip" ]; then
    mode="public"
  else
    mode="unknown"
  fi
fi
case "$mode" in
  public)
    ok "Hosting mode: public"
    echo "     Make sure your firewall/router allows TCP 31982, TCP 31983, and the configured UDP game ranges."
    if is_wsl; then
      warn_msg "Public hosting from WSL has extra NAT/firewall complexity"
      echo "     Native Ubuntu, a VM, or a VPS is preferred for internet-facing hosting."
    fi
    ;;
  local)
    ok "Hosting mode: local/LAN"
    echo "     Only players on the same local network should be expected to connect."
    ;;
  *)
    warn_msg "Hosting mode is unknown"
    echo "     Check SERVER_IP_MODE in .env."
    ;;
esac

echo
if [ "$fail" -eq 0 ] && [ "$warn" -eq 0 ]; then
  echo "DOCTOR: no obvious issues found."
  exit 0
elif [ "$fail" -eq 0 ]; then
  echo "DOCTOR: warnings found. Review WARN lines above."
  exit 0
else
  echo "DOCTOR: issues found. Review FAIL lines above."
  exit 1
fi
