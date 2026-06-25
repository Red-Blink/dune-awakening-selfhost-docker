#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

PID_FILE="runtime/generated/network-server-state-overrides.pid"
LOG_FILE="runtime/generated/network-server-state-overrides.log"
LOG_POINTER_FILE="runtime/generated/network-server-state-overrides-current.log"
TEXT_ROUTER_LOG="runtime/text-router/director-current.log"
RMQ_TIMEOUT_SECONDS="${DUNE_NETWORK_STATE_OVERRIDE_RMQ_TIMEOUT_SECONDS:-8}"
RMQ_BINDING_CLEANUP_TIMEOUT_SECONDS="${DUNE_NETWORK_STATE_OVERRIDE_BINDING_CLEANUP_TIMEOUT_SECONDS:-2}"
STOP_RESTORE_TIMEOUT_SECONDS="${DUNE_NETWORK_STATE_OVERRIDE_STOP_RESTORE_TIMEOUT_SECONDS:-20}"
PRIORITY_MAP_TIMEOUT_SECONDS="${DUNE_NETWORK_STATE_OVERRIDE_PRIORITY_MAP_TIMEOUT_SECONDS:-8}"
BACKGROUND_MAP_TIMEOUT_SECONDS="${DUNE_NETWORK_STATE_OVERRIDE_BACKGROUND_MAP_TIMEOUT_SECONDS:-3}"
PRIORITY_MAPS="${DUNE_NETWORK_STATE_OVERRIDE_PRIORITY_MAPS:-Survival_1 Overmap DeepDesert_1}"
RMQ_USER=""
RMQ_PASSWORD=""

SOURCE_EXCHANGE="completions"
FILTER_EXCHANGE="networkServerStateFiltered"
SOURCE_FILTER_PREFIX="networkStateOverrideSource_"
SINK_QUEUE_PREFIX="serverStateSink_"
EXCLUDED_MAPS_RE="^$"

loop_pids() {
  pgrep -f "publish-network-server-state-overrides.sh loop" 2>/dev/null || true
}

loop_running() {
  [ -n "$(loop_pids)" ]
}

write_live_pidfile() {
  mkdir -p "$(dirname "$PID_FILE")"
  printf '%s\n' "$$" >"$PID_FILE"
}

clear_stale_pidfile() {
  [ -f "$PID_FILE" ] || return 0
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$PID_FILE"
  fi
}

prepare_runtime_generated_files() {
  local current_log
  mkdir -p runtime/generated

  current_log="$LOG_FILE"
  if [ -e "$current_log" ] && [ ! -w "$current_log" ]; then
    current_log="runtime/generated/network-server-state-overrides-$$.log"
  fi
  : >"$current_log"

  LOG_FILE="$current_log"
  if [ -e "$LOG_POINTER_FILE" ] && [ ! -w "$LOG_POINTER_FILE" ]; then
    rm -f "$LOG_POINTER_FILE" 2>/dev/null || true
  fi
  printf '%s\n' "$LOG_FILE" >"$LOG_POINTER_FILE" 2>/dev/null || true
}

ensure_text_router_log() {
  local container_log
  mkdir -p runtime/text-router
  container_log="$(docker exec dune-text-router sh -lc 'find /Tools/Battlegroups/TextRouter/TextRouter/logs -maxdepth 1 -type f -name "director*.log" | sort | tail -n 1' 2>/dev/null | tr -d '\r')"
  [ -n "$container_log" ] || return 1
  docker cp "dune-text-router:${container_log}" "$TEXT_ROUTER_LOG" >/dev/null
}

load_rmq_admin_creds() {
  ensure_text_router_log
  python3 - <<'PY'
from pathlib import Path
import re
import subprocess
import sys

log_path = Path("runtime/text-router/director-current.log")
patterns = [
    re.compile(r'Generated new admin credentials:\s*(bgd\.[^/\s]+\.admin)\s*/\s*([A-Za-z0-9+/=]+)'),
    re.compile(r'(bgd\.[^/\s]+\.admin)/([A-Za-z0-9+/=]+) => allow administrator'),
]
text = log_path.read_text(errors="ignore") if log_path.exists() else ""
matches = []
for pattern in patterns:
    matches = pattern.findall(text)
    if matches:
        break
if not matches:
    logs = []
    for container in ("dune-director", "dune-text-router"):
        try:
            logs.append(subprocess.check_output(
                ["docker", "logs", container],
                text=True,
                stderr=subprocess.STDOUT,
            ))
        except Exception:
            pass
    text = "\n".join(logs)
    for pattern in patterns:
        matches = pattern.findall(text)
        if matches:
            break
if not matches:
    sys.exit(1)

username, password = matches[-1]
print(username)
print(password)
PY
}

rmq_admin() {
  if [ -z "$RMQ_USER" ] || [ -z "$RMQ_PASSWORD" ]; then
    mapfile -t rmq_creds < <(load_rmq_admin_creds)
    [ "${#rmq_creds[@]}" -ge 2 ] || return 1
    RMQ_USER="${rmq_creds[0]}"
    RMQ_PASSWORD="${rmq_creds[1]}"
  fi
  timeout --kill-after=2s "${RMQ_TIMEOUT_SECONDS}s" docker exec dune-rmq-admin rabbitmqadmin -q -u "$RMQ_USER" -p "$RMQ_PASSWORD" "$@"
}

rmq_delete_binding_exact() {
  local source="$1" destination="$2" routing_key="$3"
  timeout --kill-after=1s "${RMQ_BINDING_CLEANUP_TIMEOUT_SECONDS}s" docker exec dune-rmq-admin rabbitmqctl eval "
Binding = {binding,
  {resource, <<\"/\">>, exchange, <<\"${source}\">>},
  <<\"${routing_key}\">>,
  {resource, <<\"/\">>, queue, <<\"${destination}\">>},
  []},
DeleteCallback = fun(_, _) -> ok end,
io:format(\"~p~n\", [rabbit_db_binding:delete(Binding, DeleteCallback)]).
" >/dev/null
}

server_state_maps() {
  docker exec dune-postgres psql -U postgres -d dune -Atc "
    select distinct map
    from (
      select map
      from dune.farm_state
      where coalesce(map, '') <> ''
      union
      select map
      from dune.world_partition
      where coalesce(map, '') <> ''
        and coalesce(server_id, '') <> ''
    ) active_maps
    where map !~ '${EXCLUDED_MAPS_RE}'
    order by map;
  " 2>/dev/null || true
}

server_state_maps_ordered() {
  local maps map_name priority_map
  maps="$(server_state_maps)"
  for priority_map in $PRIORITY_MAPS; do
    printf '%s\n' "$maps" | grep -Fx "$priority_map" || true
  done
  while IFS= read -r map_name; do
    [ -n "$map_name" ] || continue
    case " $PRIORITY_MAPS " in
      *" $map_name "*) continue ;;
    esac
    printf '%s\n' "$map_name"
  done <<< "$maps"
}

ensure_route_for_map() {
  local map_name="$1"
  local routing_key="server_state.${map_name}"
  local source_queue="${SOURCE_FILTER_PREFIX}${map_name}"
  local sink_queue="${SINK_QUEUE_PREFIX}${map_name}"

  rmq_admin declare exchange name="$FILTER_EXCHANGE" type=direct durable=true >/dev/null
  rmq_admin declare queue name="$source_queue" durable=true >/dev/null
  rmq_admin declare binding \
    source="$SOURCE_EXCHANGE" \
    destination="$source_queue" \
    destination_type=queue \
    routing_key="$routing_key" >/dev/null
  rmq_admin declare binding \
    source="$FILTER_EXCHANGE" \
    destination="$sink_queue" \
    destination_type=queue \
    routing_key="$routing_key" >/dev/null
  rmq_delete_binding_exact "$SOURCE_EXCHANGE" "$sink_queue" "$routing_key" >/dev/null 2>&1 || true
}

restore_route_for_map() {
  local map_name="$1"
  local routing_key="server_state.${map_name}"
  local source_queue="${SOURCE_FILTER_PREFIX}${map_name}"
  local sink_queue="${SINK_QUEUE_PREFIX}${map_name}"

  rmq_admin declare binding \
    source="$SOURCE_EXCHANGE" \
    destination="$sink_queue" \
    destination_type=queue \
    routing_key="$routing_key" >/dev/null || true
  rmq_delete_binding_exact "$FILTER_EXCHANGE" "$sink_queue" "$routing_key" >/dev/null 2>&1 || true
  rmq_delete_binding_exact "$SOURCE_EXCHANGE" "$source_queue" "$routing_key" >/dev/null 2>&1 || true
}

ensure_routes() {
  local map_name
  while IFS= read -r map_name; do
    [ -n "$map_name" ] || continue
    ensure_route_for_map "$map_name" || true
  done < <(server_state_maps_ordered)
}

restore_routes() {
  local map_name
  while IFS= read -r map_name; do
    [ -n "$map_name" ] || continue
    restore_route_for_map "$map_name"
  done < <(server_state_maps_ordered)
}

publish_payload() {
  local map_name="$1"
  local payload="$2"
  rmq_admin publish \
    exchange="$FILTER_EXCHANGE" \
    routing_key="server_state.${map_name}" \
    properties='{"content_type":"Content","type":"server_state"}' \
    payload="$payload" >/dev/null
}

forward_batch_for_map() {
  local map_name="$1"
  local source_queue="${SOURCE_FILTER_PREFIX}${map_name}"
  local messages endpoint_rows

  ensure_route_for_map "$map_name" >/dev/null 2>&1 || return 1
  messages="$(rmq_admin --format=raw_json get queue="$source_queue" count=20 ackmode=ack_requeue_false)"
  [[ "$messages" == \[* ]] || return 1
  [ "$messages" != "[]" ] || return 1

  endpoint_rows="$(docker exec dune-postgres psql -U postgres -d dune -At -F $'\t' -c "
    select coalesce(wp.partition_id::text, ''),
           fs.server_id,
           coalesce(host(fs.game_addr), ''),
           coalesce(fs.game_port, 0)
    from dune.farm_state fs
    left join dune.world_partition wp on wp.server_id = fs.server_id
    where fs.map = '${map_name//\'/\'\'}';
  ")"

  FILTER_MESSAGES="$messages" ENDPOINT_ROWS="$endpoint_rows" MAP_NAME="$map_name" python3 - <<'PY'
import json
import os
import time

messages = json.loads(os.environ["FILTER_MESSAGES"])
map_name = os.environ.get("MAP_NAME", "")
endpoints_by_partition = {}
endpoints_by_server = {}
for line in os.environ.get("ENDPOINT_ROWS", "").splitlines():
    if not line.strip():
        continue
    partition_id, server_id, game_addr, game_port = line.split("\t", 3)
    if partition_id:
        endpoints_by_partition[str(partition_id)] = (server_id, game_addr, game_port)
    if server_id:
        endpoints_by_server[server_id] = (server_id, game_addr, game_port)

for message in messages:
    payload = json.loads(message["payload"])
    partition_id = str(payload.get("partitionId", ""))
    server_id = str(payload.get("serverId", ""))
    next_server_id, game_addr, game_port = endpoints_by_server.get(
        server_id,
        endpoints_by_partition.get(partition_id, ("", "", "0")),
    )
    if next_server_id:
        payload["serverId"] = next_server_id
    if game_addr:
        payload["ip"] = game_addr
    if game_port and game_port != "0":
        payload["port"] = int(game_port)
    if map_name == "DeepDesert_1" and not payload.get("ready", False):
        payload["isStartingMap"] = True
    payload["reportTimestamp"] = max(int(time.time()), int(payload.get("reportTimestamp", 0)))
    print(json.dumps(payload, separators=(",", ":")))
PY
}

forward_once() {
  local map_name rows any=1
  while IFS= read -r map_name; do
    [ -n "$map_name" ] || continue
    if rows="$(forward_batch_for_map "$map_name")"; then
      any=0
      while IFS= read -r payload; do
        [ -n "$payload" ] || continue
        publish_payload "$map_name" "$payload"
      done <<< "$rows"
    fi
  done < <(server_state_maps_ordered)
  return "$any"
}

server_state_maps_background() {
  local map_name
  while IFS= read -r map_name; do
    [ -n "$map_name" ] || continue
    case " $PRIORITY_MAPS " in
      *" $map_name "*) continue ;;
    esac
    printf '%s\n' "$map_name"
  done < <(server_state_maps)
}

forward_map_once() {
  local map_name="$1"
  local rows

  [ -n "$map_name" ] || return 1
  if rows="$(forward_batch_for_map "$map_name")"; then
    while IFS= read -r payload; do
      [ -n "$payload" ] || continue
      publish_payload "$map_name" "$payload"
    done <<< "$rows"
  fi
}

kick_priority_maps_once() {
  local map_name
  for map_name in $PRIORITY_MAPS; do
    timeout --kill-after=2s "${PRIORITY_MAP_TIMEOUT_SECONDS}s" "$0" map "$map_name" || true
  done
}

start_loop() {
  mkdir -p runtime/generated
  write_live_pidfile
  trap 'restore_routes >/dev/null 2>&1 || true; rm -f "$PID_FILE"' EXIT
  local route_refresh_at=0
  local background_maps="" background_index=1 background_count=0 background_map=""
  for priority_map in $PRIORITY_MAPS; do
    ensure_route_for_map "$priority_map" >>"$LOG_FILE" 2>&1 || true
  done
  while true; do
    if [ "$(date +%s)" -ge "$route_refresh_at" ]; then
      ensure_routes >>"$LOG_FILE" 2>&1 || true
      background_maps="$(server_state_maps_background)"
      background_count="$(printf '%s\n' "$background_maps" | sed '/^$/d' | wc -l | tr -d '[:space:]')"
      [ "${background_count:-0}" -gt 0 ] || background_count=0
      [ "$background_index" -le "$background_count" ] || background_index=1
      route_refresh_at=$(( $(date +%s) + 10 ))
    fi

    kick_priority_maps_once >>"$LOG_FILE" 2>&1 || true

    if [ "$background_count" -gt 0 ]; then
      background_map="$(printf '%s\n' "$background_maps" | sed -n "${background_index}p")"
      if [ -n "$background_map" ]; then
        timeout --kill-after=1s "${BACKGROUND_MAP_TIMEOUT_SECONDS}s" "$0" map "$background_map" >>"$LOG_FILE" 2>&1 || true
      fi
      background_index=$(( background_index + 1 ))
      [ "$background_index" -le "$background_count" ] || background_index=1
    fi

    sleep 10
  done
}

case "${1:-start}" in
  once)
    ensure_routes
    forward_once || true
    ;;
  map)
    map_name="${2:-}"
    if [ -z "$map_name" ]; then
      echo "Usage: $0 map <map-name>"
      exit 2
    fi
    ensure_route_for_map "$map_name"
    forward_map_once "$map_name" || true
    ;;
  start)
    clear_stale_pidfile
    if loop_running; then
      kick_priority_maps_once
      exit 0
    fi
    pkill -f "publish-network-server-state-overrides.sh loop" 2>/dev/null || true
    rm -f "$PID_FILE"
    prepare_runtime_generated_files
    setsid "$0" loop >>"$LOG_FILE" 2>&1 </dev/null &
    echo $! >"$PID_FILE"
    kick_priority_maps_once
    ;;
  loop)
    prepare_runtime_generated_files
    start_loop
    ;;
  stop)
    clear_stale_pidfile
    if [ -f "$PID_FILE" ]; then
      kill "$(cat "$PID_FILE")" 2>/dev/null || true
    fi
    pkill -f "publish-network-server-state-overrides.sh loop" 2>/dev/null || true
    rm -f "$PID_FILE"
    timeout --kill-after=2s "${STOP_RESTORE_TIMEOUT_SECONDS}s" "$0" restore-routes || true
    ;;
  restore-routes)
    restore_routes || true
    ;;
  restart)
    clear_stale_pidfile
    if [ -f "$PID_FILE" ]; then
      kill "$(cat "$PID_FILE")" 2>/dev/null || true
    fi
    pkill -f "publish-network-server-state-overrides.sh loop" 2>/dev/null || true
    rm -f "$PID_FILE"
    "$0" start
    ;;
  *)
    echo "Usage: $0 [once|map <map-name>|start|stop|restart]"
    exit 2
    ;;
esac
