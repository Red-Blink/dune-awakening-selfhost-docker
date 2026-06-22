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

container_running() {
  local name="$1"
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$name"
}

container_arg_has() {
  local container="$1"
  local pattern="$2"

  docker inspect "$container" --format '{{range .Args}}{{println .}}{{end}}' 2>/dev/null | grep -Fxq -- "$pattern"
}

container_arg_value() {
  local container="$1"
  local prefix="$2"

  docker inspect "$container" --format '{{range .Args}}{{println .}}{{end}}' 2>/dev/null \
    | awk -v prefix="$prefix" 'index($0, prefix) == 1 { print substr($0, length(prefix) + 1); exit }'
}

container_env_value() {
  local container="$1"
  local key="$2"

  docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2); exit }'
}

ss_has_udp() {
  local port="$1"
  ss -lnup 2>/dev/null | grep -Eq "[:.]${port}[[:space:]]"
}

ss_has_tcp() {
  local port="$1"
  ss -lntp 2>/dev/null | grep -Eq "[:.]${port}[[:space:]]"
}

udp_listener_addresses_for_port() {
  local port="$1"

  awk -v port="$port" '
    $0 ~ "[:.]" port "[[:space:]]" {
      local = $5
      gsub(/^\[/, "", local)
      gsub(/\]$/, "", local)
      sub(":" port "$", "", local)
      print local
    }
  ' /tmp/dune-ping-ss-udp.out 2>/dev/null | sort -u
}

check_udp_listener_bind() {
  local label="$1"
  local port="$2"
  local addresses

  addresses="$(udp_listener_addresses_for_port "$port" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  if [ -z "$addresses" ]; then
    fail_msg "$label is not listening on UDP $port"
    return 0
  fi

  if [ "$server_ip" != "$bind_ip" ] && printf '%s\n' "$addresses" | grep -Eq "(^|[[:space:]])${server_ip//./\\.}([[:space:]]|$)"; then
    fail_msg "NAT address mismatch. $label UDP $port is bound to $server_ip, but SERVER_BIND_IP resolves to $bind_ip."
    echo "     Game sockets must bind to SERVER_BIND_IP while farm_state.game_addr advertises SERVER_IP."
    return 0
  fi

  if printf '%s\n' "$addresses" | grep -Eq "(^|[[:space:]])(${bind_ip//./\\.}|0\.0\.0\.0|\*)($|[[:space:]])"; then
    ok "$label listening on UDP $port at ${addresses}"
  else
    warn_msg "$label UDP $port is listening at ${addresses}; expected $bind_ip or 0.0.0.0"
  fi
}

ini_value() {
  local file="$1"
  local key="$2"

  [ -f "$file" ] || return 1
  awk -F= -v key="$key" '
    $1 == key {
      value = substr($0, length(key) + 2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      gsub(/^"/, "", value)
      gsub(/"$/, "", value)
      print value
      exit
    }
  ' "$file"
}

docker_available() {
  docker ps >/dev/null 2>&1
}

print_row() {
  printf '%-22s %-14s %s\n' "$1" "$2" "$3"
}

server_ip="$(resolve_server_ip)"
bind_ip="$(resolve_bind_ip)"
mode="$(resolve_server_ip_mode 2>/dev/null || printf '%s' unknown)"
title="$(resolve_server_title)"
region="$(resolve_server_region)"
battlegroup="$(resolve_battlegroup_id)"
client_port_base="$(resolve_client_port_base)"
igw_port_base="$(resolve_igw_port_base)"
overmap_game_port="$client_port_base"
survival_game_port="$((client_port_base + 1))"
survival_igw_port="$igw_port_base"
overmap_igw_port="$((igw_port_base + 1))"

echo "=== Dune Ping / Server Browser Diagnostics ==="
echo
print_row "Title" "$title" ""
print_row "Region" "$region" ""
print_row "Battlegroup" "$battlegroup" ""
print_row "IP mode" "$mode" ""
print_row "Advertised IP" "$server_ip" ""
print_row "Local bind IP" "$bind_ip" ""
echo

if [ "$mode" = "public" ] && is_private_ipv4 "$bind_ip" && [ "$server_ip" != "$bind_ip" ]; then
  echo "Network mode: public/NAT"
  warn_msg "Public mode advertises $server_ip while game UDP is bound on private host IP $bind_ip."
  echo "     This is valid only when the router/firewall forwards the public UDP ports to $bind_ip."
  echo "     A blank in-game ping usually means the client cannot reach ${server_ip}:${survival_game_port}/udp or ${server_ip}:${overmap_game_port}/udp."
elif is_private_ipv4 "$server_ip" && [ "$mode" = "public" ]; then
  fail_msg "Public mode is configured but advertised IP is private: $server_ip"
else
  echo "Network mode: $mode"
fi

echo
echo "=== Expected endpoints ==="
print_row "Overmap game" "${overmap_game_port}/udp" "advertised as ${server_ip}:${overmap_game_port}"
print_row "Survival_1 game" "${survival_game_port}/udp" "advertised as ${server_ip}:${survival_game_port}"
print_row "Survival_1 IGW" "${survival_igw_port}/udp" "server-to-server on ${bind_ip}:${survival_igw_port}"
print_row "Overmap IGW" "${overmap_igw_port}/udp" "server-to-server on ${bind_ip}:${overmap_igw_port}"
print_row "RabbitMQ game" "31982/tcp" "advertised to services as ${server_ip}:31982"
print_row "RabbitMQ game HTTP" "31983/tcp" "local management endpoint"

echo
echo "=== Local listeners ==="
if ss -lnup >/tmp/dune-ping-ss-udp.out 2>/tmp/dune-ping-ss-udp.err; then
  for item in \
    "Overmap game:$overmap_game_port" \
    "Survival_1 game:$survival_game_port" \
    "Survival_1 IGW:$survival_igw_port" \
    "Overmap IGW:$overmap_igw_port"
  do
    label="${item%%:*}"
    port="${item##*:}"
    check_udp_listener_bind "$label" "$port"
  done
else
  warn_msg "Cannot inspect UDP listeners with ss: $(tr '\n' ' ' </tmp/dune-ping-ss-udp.err)"
fi
rm -f /tmp/dune-ping-ss-udp.out /tmp/dune-ping-ss-udp.err

if ss -lntp >/tmp/dune-ping-ss-tcp.out 2>/tmp/dune-ping-ss-tcp.err; then
  for item in "RabbitMQ game:31982" "RabbitMQ game HTTP local:31983"; do
    label="${item%%:*}"
    port="${item##*:}"
    if grep -Eq "[:.]${port}[[:space:]]" /tmp/dune-ping-ss-tcp.out; then
      ok "$label listening on TCP $port"
    else
      fail_msg "$label is not listening on TCP $port"
    fi
  done
else
  warn_msg "Cannot inspect TCP listeners with ss: $(tr '\n' ' ' </tmp/dune-ping-ss-tcp.err)"
fi
rm -f /tmp/dune-ping-ss-tcp.out /tmp/dune-ping-ss-tcp.err

echo
echo "=== Generated INI values ==="
survival_ini="runtime/game/survival-1/Saved/UserSettings/UserEngine.ini"
overmap_ini="runtime/game/overmap/Saved/UserSettings/UserEngine.ini"
for item in \
  "Survival_1:$survival_ini" \
  "Overmap:$overmap_ini"
do
  map="${item%%:*}"
  file="${item#*:}"
  if [ ! -f "$file" ]; then
    warn_msg "$map UserEngine.ini missing: $file"
    continue
  fi
  ini_port="$(ini_value "$file" Port || true)"
  ini_igw="$(ini_value "$file" IGWPort || true)"
  if [ "$ini_port" = "$client_port_base" ]; then
    ok "$map UserEngine base Port=$ini_port"
  else
    fail_msg "$map UserEngine base Port=$ini_port expected $client_port_base"
  fi
  if [ "$ini_igw" = "$igw_port_base" ]; then
    ok "$map UserEngine base IGWPort=$ini_igw"
  else
    fail_msg "$map UserEngine base IGWPort=$ini_igw expected $igw_port_base"
  fi
done
echo "     Final per-map ports are applied by startup command-line overrides and checked below."

echo
echo "=== Running container arguments ==="
if docker_available; then
  for item in \
    "dune-server-overmap:Overmap:$overmap_game_port:$overmap_igw_port" \
    "dune-server-survival-1:Survival_1:$survival_game_port:$survival_igw_port"
  do
    container="${item%%:*}"
    rest="${item#*:}"
    map="${rest%%:*}"
    rest="${rest#*:}"
    expected_port="${rest%%:*}"
    expected_igw="${rest##*:}"
    if ! container_running "$container"; then
      fail_msg "$container is not running"
      continue
    fi
    if container_arg_has "$container" "-ini:engine:[URL]:Port=$expected_port"; then
      ok "$map container uses Port=$expected_port"
    else
      fail_msg "$map container does not use expected Port=$expected_port"
    fi
    if container_arg_has "$container" "-ini:engine:[URL]:IGWPort=$expected_igw"; then
      ok "$map container uses IGWPort=$expected_igw"
    else
      fail_msg "$map container does not use expected IGWPort=$expected_igw"
    fi
    pod_ip="$(container_env_value "$container" POD_IP || true)"
    external_override="$(container_env_value "$container" EXTERNAL_ADDRESS_OVERRIDE || true)"
    multihome="$(container_arg_value "$container" -MultiHome= || true)"
    [ "$pod_ip" = "$bind_ip" ] && ok "$map container POD_IP=$pod_ip" || fail_msg "$map container POD_IP=$pod_ip expected $bind_ip"
    [ "$multihome" = "$bind_ip" ] && ok "$map container MultiHome=$multihome" || fail_msg "$map container MultiHome=$multihome expected $bind_ip"
    if [ -n "$external_override" ] && [ "$server_ip" != "$bind_ip" ]; then
      fail_msg "$map container has dangerous EXTERNAL_ADDRESS_OVERRIDE=$external_override while bind IP is $bind_ip"
    elif [ -n "$external_override" ]; then
      warn_msg "$map container has EXTERNAL_ADDRESS_OVERRIDE=$external_override; this is only safe because bind and advertised IP match."
    else
      ok "$map container has no EXTERNAL_ADDRESS_OVERRIDE"
    fi
  done

  if container_running dune-server-gateway; then
    gateway_host="$(container_arg_value dune-server-gateway --RMQGameHostname= || true)"
    gateway_port="$(container_arg_value dune-server-gateway --RMQGamePort= || true)"
    gateway_http_port="$(container_arg_value dune-server-gateway --RMQGameHttpPort= || true)"
    [ "$gateway_host" = "$server_ip" ] && ok "Gateway advertises RMQ host $gateway_host" || fail_msg "Gateway RMQ host is $gateway_host expected $server_ip"
    [ "$gateway_port" = "31982" ] && ok "Gateway advertises RMQ game port 31982" || fail_msg "Gateway RMQ game port is $gateway_port expected 31982"
    [ "$gateway_http_port" = "31983" ] && ok "Gateway uses RMQ HTTP port 31983" || fail_msg "Gateway RMQ HTTP port is $gateway_http_port expected 31983"
  else
    fail_msg "dune-server-gateway is not running"
  fi
else
  warn_msg "Docker is not reachable; skipped container argument checks."
fi

echo
echo "=== Database advertised server endpoints ==="
if container_running dune-postgres; then
  rows="$(docker exec dune-postgres psql -U postgres -d dune -At -F $'\t' -c "
    select map, coalesce(host(game_addr), ''), game_port, coalesce(host(igw_addr), ''), igw_port, ready, alive
    from dune.farm_state
    where map in ('Overmap', 'Survival_1')
    order by map, game_port;
  " 2>/dev/null || true)"
  if [ -z "$rows" ]; then
    fail_msg "No Overmap/Survival_1 rows found in dune.farm_state"
  else
    while IFS=$'\t' read -r map game_addr game_port igw_addr igw_port ready alive; do
      [ -n "$map" ] || continue
      echo "  $map game=${game_addr}:${game_port} igw=${igw_addr}:${igw_port} ready=$ready alive=$alive"
      expected_game="$overmap_game_port"
      expected_igw="$overmap_igw_port"
      [ "$map" = "Survival_1" ] && expected_game="$survival_game_port" && expected_igw="$survival_igw_port"
      [ "$game_addr" = "$server_ip" ] && ok "$map farm_state game_addr=$game_addr" || fail_msg "$map farm_state game_addr=$game_addr expected $server_ip"
      [ "$igw_addr" = "$bind_ip" ] && ok "$map farm_state igw_addr=$igw_addr" || fail_msg "$map farm_state igw_addr=$igw_addr expected $bind_ip"
      [ "$game_port" = "$expected_game" ] && ok "$map farm_state game_port=$game_port" || fail_msg "$map farm_state game_port=$game_port expected $expected_game"
      [ "$igw_port" = "$expected_igw" ] && ok "$map farm_state igw_port=$igw_port" || fail_msg "$map farm_state igw_port=$igw_port expected $expected_igw"
      [ "$ready" = "t" ] && [ "$alive" = "t" ] && ok "$map farm_state ready/alive" || warn_msg "$map farm_state ready=$ready alive=$alive"
    done <<< "$rows"
  fi
else
  warn_msg "dune-postgres is not running; skipped farm_state checks."
fi

echo
echo "=== External reachability note ==="
if [ "$mode" = "public" ]; then
  echo "Repo-side checks cannot prove that the public internet can reach your router/firewall UDP forwards."
  echo "For non-blank ping, external clients must be able to reach:"
  echo "  ${server_ip}:${overmap_game_port}/udp"
  echo "  ${server_ip}:${survival_game_port}/udp"
  echo "Also forward the IGW UDP ports for server-to-server traffic:"
  echo "  ${server_ip}:${survival_igw_port}/udp"
  echo "  ${server_ip}:${overmap_igw_port}/udp"
else
  echo "Local/LAN mode advertises a private IP. Clients outside the LAN should not be expected to ping or join it."
fi

echo
if [ "$fail" -eq 0 ] && [ "$warn" -eq 0 ]; then
  echo "PING DIAGNOSTICS: repo-side endpoint configuration looks valid."
elif [ "$fail" -eq 0 ]; then
  echo "PING DIAGNOSTICS: warnings found. Review WARN lines above."
else
  echo "PING DIAGNOSTICS: failures found. Review FAIL lines above."
fi

[ "$fail" -eq 0 ]
