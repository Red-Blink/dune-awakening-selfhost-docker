#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

PID_FILE="runtime/generated/deepdesert-overrides.pid"
LOG_FILE="runtime/generated/deepdesert-overrides.log"
LOG_POINTER_FILE="runtime/generated/deepdesert-overrides-current.log"
TEXT_ROUTER_LOG="runtime/text-router/director-current.log"
RMQ_TIMEOUT_SECONDS="${DUNE_DEEPDESERT_OVERRIDE_RMQ_TIMEOUT_SECONDS:-8}"
RMQ_BINDING_CLEANUP_TIMEOUT_SECONDS="${DUNE_DEEPDESERT_OVERRIDE_BINDING_CLEANUP_TIMEOUT_SECONDS:-2}"
STOP_RESTORE_TIMEOUT_SECONDS="${DUNE_DEEPDESERT_OVERRIDE_STOP_RESTORE_TIMEOUT_SECONDS:-20}"

SOURCE_EXCHANGE="completions"
SOURCE_ROUTING_KEY="server_state.DeepDesert_1"
SINK_QUEUE="serverStateSink_DeepDesert_1"
FILTER_EXCHANGE="deepdesertOverrideFilteredState"

loop_pids() {
  pgrep -f "publish-deepdesert-overrides.sh loop" 2>/dev/null || true
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
    current_log="runtime/generated/deepdesert-overrides-$$.log"
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
  local rmq_user rmq_password
  mapfile -t rmq_creds < <(load_rmq_admin_creds)
  [ "${#rmq_creds[@]}" -ge 2 ] || return 1
  rmq_user="${rmq_creds[0]}"
  rmq_password="${rmq_creds[1]}"
  timeout --kill-after=2s "${RMQ_TIMEOUT_SECONDS}s" docker exec dune-rmq-admin rabbitmqadmin -q -u "$rmq_user" -p "$rmq_password" "$@"
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

ensure_route() {
  rmq_admin declare exchange name="$FILTER_EXCHANGE" type=direct durable=true >/dev/null
  rmq_admin declare binding \
    source="$FILTER_EXCHANGE" \
    destination="$SINK_QUEUE" \
    destination_type=queue \
    routing_key="$SOURCE_ROUTING_KEY" >/dev/null
  rmq_delete_binding_exact "$SOURCE_EXCHANGE" "$SINK_QUEUE" "$SOURCE_ROUTING_KEY" >/dev/null 2>&1 || true
}

restore_route() {
  rmq_admin declare binding \
    source="$SOURCE_EXCHANGE" \
    destination="$SINK_QUEUE" \
    destination_type=queue \
    routing_key="$SOURCE_ROUTING_KEY" >/dev/null || true
  rmq_admin delete binding \
    source="$FILTER_EXCHANGE" \
    destination_type=queue \
    destination="$SINK_QUEUE" \
    properties_key="$SOURCE_ROUTING_KEY" >/dev/null 2>&1 || true
}

publish_payload() {
  local payload="$1"
  rmq_admin publish \
    exchange="$FILTER_EXCHANGE" \
    routing_key="$SOURCE_ROUTING_KEY" \
    properties='{"content_type":"Content","type":"server_state"}' \
    payload="$payload" >/dev/null
}

publish_snapshot_once() {
  python3 - <<'PY'
import json
import subprocess
import time

query = """
select wp.partition_id,
       coalesce(wp.server_id, ''),
       coalesce(host(fs.game_addr), ''),
       coalesce(fs.game_port, 0),
       coalesce(fs.ready, false),
       coalesce(fs.alive, false),
       coalesce(wp.label, '')
from dune.world_partition wp
left join dune.farm_state fs on fs.server_id = wp.server_id
where wp.map = 'DeepDesert_1'
  and coalesce(wp.server_id, '') <> ''
order by wp.dimension_index, wp.partition_id;
"""

result = subprocess.run(
    [
        "docker", "exec", "dune-postgres",
        "psql", "-U", "postgres", "-d", "dune",
        "-At", "-F", "\t", "-c", query,
    ],
    check=True,
    text=True,
    capture_output=True,
)

defaults = {
    "Difficulty": "Custom",
    "CoreSettings": {
        "serverDisplayName": "",
        "doubleDifficultyLoot": False,
    },
    "SurvivalSettings": {
        "hydrationEnabled": True,
        "sandstormEnabled": 1,
        "sandStormAutoSpawn": True,
        "sandStormCoriolisAutoSpawnEnabled": True,
        "sandStormTreasureEnabled": 1,
        "sandwormEnabled": 1,
        "sandwormSpawnType": None,
        "sandwormDangerZonesEnabled": True,
        "vehicleSandwormCollisionInteraction": False,
        "vehicleSandwormInvulnerabilitySecondsOnExit": 900,
        "vehicleSandwormInvulnerabilitySecondsOnServerRestart": 7200,
    },
    "CombatSettings": {
        "securityZonesForceEnablePvp": False,
        "areSecurityZonesEnabled": True,
        "shouldForceEnablePvpOnAllPartitions": False,
        "itemDeteriorationUpdateRate": 1,
        "vehicleDurabilityDamageMultiplier": 1,
        "inventoryDecayedMaxDurabilityThreshold": 0.2,
    },
    "HarvestingSettings": {
        "miningOutputMultiplier": 1,
        "vehicleMiningOutputMultiplier": 1,
        "securityZonesPvpResourceMultiplier": 2.5,
    },
    "PersistenceSettings": {
        "buildingBlueprintMaxExtensions": 4,
        "baseBackupMaxExtensions": 8,
    },
}

for line in result.stdout.splitlines():
    if not line.strip():
        continue
    partition_id, server_id, game_addr, game_port, ready, alive, label = line.split("\t")
    if alive.lower() not in ("t", "true", "1"):
        continue
    if not game_addr or str(game_port) == "0":
        continue
    is_ready = ready.lower() in ("t", "true", "1")
    display_name = label if is_ready else ""
    settings = json.loads(json.dumps(defaults))
    settings["CoreSettings"]["serverDisplayName"] = display_name
    payload = {
        "reportTimestamp": int(time.time()),
        "partitionId": int(partition_id),
        "serverId": server_id,
        "ready": is_ready,
        "ip": game_addr,
        "port": int(game_port or "0"),
        "loginPassword": "",
        "displayName": display_name,
        "isStartingMap": not is_ready,
        "playerHardCapOverride": -1,
        "wauCapCurve": -1,
        "players": [],
        "serverGameplaySettings": settings,
    }
    print(json.dumps(payload, separators=(",", ":")))
PY
}

start_loop() {
  mkdir -p runtime/generated
  write_live_pidfile
  trap 'rm -f "$PID_FILE"' EXIT
  local route_refresh_at=0
  ensure_route
  while true; do
    if [ "$(date +%s)" -ge "$route_refresh_at" ]; then
      ensure_route >>"$LOG_FILE" 2>&1 || true
      publish_snapshot_once >>"$LOG_FILE" 2>&1 || true
      route_refresh_at=$(( $(date +%s) + 10 ))
    fi
    sleep 1
  done
}

case "${1:-start}" in
  once)
    ensure_route
    rows="$(publish_snapshot_once || true)"
    while IFS= read -r payload; do
      [ -n "$payload" ] || continue
      publish_payload "$payload"
    done <<< "$rows"
    ;;
  start)
    clear_stale_pidfile
    if loop_running; then
      exit 0
    fi
    pkill -f "publish-deepdesert-overrides.sh loop" 2>/dev/null || true
    rm -f "$PID_FILE"
    prepare_runtime_generated_files
    setsid "$0" loop >>"$LOG_FILE" 2>&1 </dev/null &
    echo $! >"$PID_FILE"
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
    pkill -f "publish-deepdesert-overrides.sh loop" 2>/dev/null || true
    rm -f "$PID_FILE"
    timeout --kill-after=2s "${STOP_RESTORE_TIMEOUT_SECONDS}s" "$0" restore-route || true
    ;;
  restore-route)
    restore_route || true
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  *)
    echo "Usage: $0 [once|start|stop|restart]"
    exit 2
    ;;
esac
