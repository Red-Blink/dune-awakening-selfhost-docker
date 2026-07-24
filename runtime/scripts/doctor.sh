#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env
source runtime/scripts/runtime-env.sh
source runtime/scripts/fls-signals.sh

fail=0
warn=0

ok() {
  echo "OK   $*"
}

warn_msg() {
  echo "WARN $*"
  warn=1
}

info_msg() {
  echo "INFO $*"
}

fail_msg() {
  echo "FAIL $*"
  fail=1
}

docker_size_bytes() {
  awk '
    function multiplier(unit) {
      if (unit == "kB" || unit == "KB") return 1000
      if (unit == "MB") return 1000000
      if (unit == "GB") return 1000000000
      if (unit == "TB") return 1000000000000
      if (unit == "KiB") return 1024
      if (unit == "MiB") return 1048576
      if (unit == "GiB") return 1073741824
      if (unit == "TiB") return 1099511627776
      return 1
    }
    {
      number = $0
      sub(/[A-Za-z].*$/, "", number)
      unit = $0
      sub(/^[0-9.]+/, "", unit)
      sub(/[[:space:]].*$/, "", unit)
      if (number ~ /^[0-9]+([.][0-9]+)?$/) {
        printf "%.0f\n", number * multiplier(unit)
      }
    }
  '
}

check_docker_storage() {
  local rows obsolete_output obsolete_count=0 cache_reclaim="0B" cache_bytes=0
  rows="$(docker system df --format '{{.Type}}|{{.Reclaimable}}' 2>/dev/null || true)"
  [ -n "$rows" ] || { warn_msg "Docker storage usage could not be inspected"; return; }

  obsolete_output="$(runtime/scripts/storage.sh cleanup --dry-run 2>/dev/null || true)"
  obsolete_count="$(grep -c '^WOULD REMOVE ' <<<"$obsolete_output" || true)"
  cache_reclaim="$(awk -F'|' '$1 == "Build Cache" { print $2; exit }' <<<"$rows")"
  cache_bytes="$(docker_size_bytes <<<"${cache_reclaim:-0B}")"
  obsolete_count="${obsolete_count:-0}"
  cache_bytes="${cache_bytes:-0}"

  if [ "$obsolete_count" -gt 0 ]; then
    warn_msg "Docker has ${obsolete_count} obsolete project-owned image(s) that can be cleaned"
    echo "     Preview project-owned cleanup: dune storage cleanup --dry-run"
  else
    ok "No obsolete project-owned Docker images found"
  fi
  if [ "$cache_bytes" -ge 10000000000 ]; then
    warn_msg "Docker has ${cache_reclaim} of reclaimable build cache"
    echo "     On a dedicated host: dune storage cleanup --build-cache"
  else
    ok "Reclaimable Docker build cache: ${cache_reclaim:-0B}"
  fi
}

tcp_socket_listening() {
  local port="$1"
  local sockets
  sockets="$(ss -lntp 2>/dev/null || true)"
  grep -q ":$port " <<<"$sockets"
}

udp_socket_listening() {
  local port="$1"
  local sockets
  sockets="$(ss -lnup 2>/dev/null || true)"
  grep -q ":$port " <<<"$sockets"
}

is_running() {
  local name="$1"
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$name"
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

  if tcp_socket_listening "$port"; then
    ok "$label listening on TCP $port"
  else
    fail_msg "$label not listening on TCP $port"
  fi
}

check_udp() {
  local port="$1"
  local label="$2"

  if udp_socket_listening "$port"; then
    ok "$label listening on UDP $port"
  else
    fail_msg "$label not listening on UDP $port"
  fi
}

is_wsl_host() {
  grep -qiE 'microsoft|wsl' /proc/sys/kernel/osrelease 2>/dev/null
}

check_game_container_pinning() {
  local container
  local cpuset
  local found=0

  command -v docker >/dev/null 2>&1 || return 0

  while IFS= read -r container; do
    [ -n "$container" ] || continue
    [ "$container" = "dune-server-gateway" ] && continue
    cpuset="$(docker inspect -f '{{.HostConfig.CpusetCpus}}' "$container" 2>/dev/null || true)"
    if [ -n "$cpuset" ] && [ "$cpuset" != "<no value>" ]; then
      warn_msg "Game container CPU pinning detected: $container cpuset=$cpuset"
      found=1
    fi
  done < <(docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^dune-server-' || true)

  if [ "$found" -eq 0 ]; then
    ok "No active game container CPU pinning detected"
  fi
}

check_deepdesert_mode() {
  local mode

  [ -x runtime/scripts/map-modes.sh ] || return 0
  mode="$(runtime/scripts/map-modes.sh mode DeepDesert_1 2>/dev/null | awk 'NF { print $NF; exit }' || true)"

  if [ "$mode" = "always-on" ]; then
    info_msg "DeepDesert_1 is always-on; ensure the host has enough dedicated headroom for vehicle timing"
  elif [ -n "$mode" ]; then
    ok "DeepDesert_1 map mode: $mode"
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
echo "=== Docker storage ==="
if docker info >/dev/null 2>&1; then
  check_docker_storage
else
  warn_msg "Skipping Docker storage checks because the daemon is not reachable"
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
postgres_port="$(resolve_postgres_port)"
rmq_admin_port="$(resolve_rmq_admin_port)"
rmq_game_port="$(resolve_rmq_game_port)"
rmq_game_http_port="$(resolve_rmq_game_http_port)"
text_router_port="$(resolve_text_router_port)"
director_port="$(resolve_director_port)"
check_tcp "$postgres_port" "Postgres"
check_tcp "$rmq_admin_port" "RabbitMQ admin"
check_tcp "$rmq_game_port" "RabbitMQ game"
check_tcp "$rmq_game_http_port" "RabbitMQ game HTTP"
check_tcp "$text_router_port" "TextRouter"
check_tcp "$director_port" "Director"
client_port_base="$(resolve_client_port_base)"
igw_port_base="$(resolve_igw_port_base)"
check_udp "$client_port_base" "Overmap clients"
check_udp "$((client_port_base + 1))" "Survival_1 clients"
check_udp "$igw_port_base" "Survival_1 server-to-server"
check_udp "$((igw_port_base + 1))" "Overmap server-to-server"

echo
echo "=== Host latency and vehicle timing ==="
if is_wsl_host; then
  warn_msg "WSL2 host detected"
  echo "     Fast vehicle movement can be more sensitive to WSL2 scheduling/network jitter; a full Linux VM or native Linux is preferred for busy servers."
else
  ok "Host is not detected as WSL2"
fi
check_game_container_pinning
check_deepdesert_mode

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
if director_fls_logs_ready "$director_logs"; then
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
    echo "     Make sure your firewall/router allows TCP ${rmq_game_port}, TCP ${rmq_game_http_port}, and the configured UDP game ranges."
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

advertised_ip="$(resolve_advertised_ip)"
bind_ip="$(resolve_bind_ip)"
nonlocal_bind="$(read_ipv4_ip_nonlocal_bind 2>/dev/null || true)"
if [ "$mode" = "public" ] \
  && is_ipv4 "$advertised_ip" \
  && is_ipv4 "$bind_ip" \
  && is_private_ipv4 "$bind_ip" \
  && [ "$advertised_ip" != "$bind_ip" ] \
  && [ "$nonlocal_bind" = "1" ]; then
  warn_msg "Public IP bind risk detected: net.ipv4.ip_nonlocal_bind=1 with SERVER_IP=$advertised_ip and SERVER_BIND_IP=$bind_ip"
  echo "     In NAT/double NAT, game sockets must bind to SERVER_BIND_IP while advertising SERVER_IP."
  echo "     Run: dune network fix"
fi

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
