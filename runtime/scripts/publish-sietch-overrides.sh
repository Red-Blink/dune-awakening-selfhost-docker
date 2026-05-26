#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

PID_FILE="runtime/generated/sietch-overrides.pid"
LOG_FILE="runtime/generated/sietch-overrides.log"
LOG_POINTER_FILE="runtime/generated/sietch-overrides-current.log"
TEXT_ROUTER_LOG="runtime/text-router/director-current.log"
CONFIG_FILE="runtime/generated/sietch-config.json"

SOURCE_EXCHANGE="completions"
SOURCE_ROUTING_KEY="server_state.Survival_1"
SOURCE_FILTER_QUEUE="sietchOverrideSourceSurvival1"
SINK_QUEUE="serverStateSink_Survival_1"
FILTER_EXCHANGE="sietchOverrideFilteredState"

loop_pids() {
  pgrep -f "publish-sietch-overrides.sh loop" 2>/dev/null || true
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
    current_log="runtime/generated/sietch-overrides-$$.log"
  fi
  : >"$current_log"

  LOG_FILE="$current_log"
  echo "$LOG_FILE" >"$LOG_POINTER_FILE"
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
import sys

log_path = Path("runtime/text-router/director-current.log")
if not log_path.exists():
    sys.exit(1)

pattern = re.compile(r'(bgd\.[^/\s]+\.admin)/([A-Za-z0-9+/=]+) => allow administrator')
matches = pattern.findall(log_path.read_text(errors="ignore"))
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
  docker exec dune-rmq-admin rabbitmqadmin -q -u "$rmq_user" -p "$rmq_password" "$@"
}

ensure_route() {
  rmq_admin declare exchange name="$FILTER_EXCHANGE" type=direct durable=true >/dev/null
  rmq_admin declare queue name="$SOURCE_FILTER_QUEUE" durable=true >/dev/null
  rmq_admin purge queue name="$SOURCE_FILTER_QUEUE" >/dev/null || true
  rmq_admin declare binding \
    source="$SOURCE_EXCHANGE" \
    destination="$SOURCE_FILTER_QUEUE" \
    destination_type=queue \
    routing_key="$SOURCE_ROUTING_KEY" >/dev/null
  rmq_admin declare binding \
    source="$FILTER_EXCHANGE" \
    destination="$SINK_QUEUE" \
    destination_type=queue \
    routing_key="$SOURCE_ROUTING_KEY" >/dev/null
  rmq_admin delete binding \
    source="$SOURCE_EXCHANGE" \
    destination_type=queue \
    destination="$SINK_QUEUE" \
    properties_key="$SOURCE_ROUTING_KEY" >/dev/null 2>&1 || true
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
  rmq_admin delete binding \
    source="$SOURCE_EXCHANGE" \
    destination_type=queue \
    destination="$SOURCE_FILTER_QUEUE" \
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
  local rows
  rows="$(python3 - <<'PY'
import json
import subprocess
import time
from pathlib import Path

config_path = Path("runtime/generated/sietch-config.json")
config = json.loads(config_path.read_text()) if config_path.exists() else {"partitions": {}}
partitions = config.get("partitions", {})

query = """
select wp.partition_id,
       wp.map,
       coalesce(wp.server_id, ''),
       coalesce(fs.ready, false),
       true as is_starting_map,
       coalesce(wp.label, '')
from dune.world_partition wp
left join dune.farm_state fs on fs.server_id = wp.server_id
where coalesce(wp.server_id, '') <> ''
  and lower(wp.map) = lower('Survival_1')
order by wp.partition_id;
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
        "doubleDifficultyLoot": "False",
    },
    "SurvivalSettings": {
        "hydrationEnabled": "True",
        "sandstormEnabled": "0",
        "sandStormAutoSpawn": "True",
        "sandStormCoriolisAutoSpawnEnabled": "True",
        "sandStormTreasureEnabled": "1",
        "sandwormEnabled": "1",
        "sandwormSpawningType": "0",
        "sandwormDangerZonesEnabled": "True",
        "vehicleSandwormCollisionInteraction": "False",
        "vehicleSandwormInvulnerabilitySecondsOnExit": "900.0",
        "vehicleSandwormInvulnerabilitySecondsOnServerRestart": "7200.0",
    },
    "CombatSettings": {
        "securityZonesForceEnablePvp": "False",
        "areSecurityZonesEnabled": "True",
        "shouldForceEnablePvpOnAllPartitions": "",
        "itemDeteriorationUpdateRate": "1.0",
        "vehicleDurabilityDamageMultiplier": "1.0",
        "inventoryDecayedMaxDurabilityThreshold": "0.2",
    },
    "HarvestingSettings": {
        "miningOutputMultiplier": "1.0",
        "vehicleMiningOutputMultiplier": "1.0",
        "securityZonesPvpResourceMultiplier": "2.5",
    },
    "PersistenceSettings": {
        "buildingBlueprintMaxExtensions": "4",
        "baseBackupMaxExtensions": "8",
    },
}

for line in result.stdout.splitlines():
    if not line.strip():
        continue
    partition_id, map_name, server_id, ready, is_starting_map, label = line.split("\t")
    cfg = partitions.get(partition_id, {})
    display_name = cfg.get("display_name", "")
    if not display_name and label:
        display_name = f"Sietch {label}"
    password = cfg.get("password", "")
    payload = {
        "reportTimestamp": int(time.time()),
        "partitionId": int(partition_id),
        "serverId": server_id,
        "ready": ready.lower() in ("t", "true", "1"),
        "displayName": display_name,
        "isStartingMap": is_starting_map.lower() in ("t", "true", "1"),
        "playerHardCapOverride": -1,
        "wauCapCurve": -1,
        "players": [],
        "serverGameplaySettings": json.loads(json.dumps(defaults)),
    }
    if password:
        payload["loginPassword"] = password
    payload["serverGameplaySettings"]["CoreSettings"]["serverDisplayName"] = display_name
    print(json.dumps(payload, separators=(",", ":")))
PY
)"

  [ -n "$rows" ] || return 0
  while IFS= read -r payload; do
    [ -n "$payload" ] || continue
    publish_payload "$payload"
  done <<< "$rows"
}

forward_batch_once() {
  local messages
  messages="$(rmq_admin --format=raw_json get queue="$SOURCE_FILTER_QUEUE" count=20 ackmode=ack_requeue_false)"
  [ "$messages" != "[]" ] || return 1

  FILTER_MESSAGES="$messages" FILTER_CONFIG_PATH="$CONFIG_FILE" python3 - <<'PY'
import json
import os
import subprocess
import time
from pathlib import Path

messages = json.loads(os.environ["FILTER_MESSAGES"])
config_path = Path(os.environ["FILTER_CONFIG_PATH"])
config = json.loads(config_path.read_text()) if config_path.exists() else {"partitions": {}}
partition_cfg = config.get("partitions", {})
label_rows_raw = subprocess.check_output([
    "docker", "exec", "dune-postgres", "psql",
    "-U", "postgres", "-d", "dune", "-At", "-F", "\t",
    "-c", "select partition_id, coalesce(label, '') from dune.world_partition where lower(map)=lower('Survival_1');"
], text=True)
label_by_partition = {}
for line in label_rows_raw.splitlines():
    if not line.strip():
        continue
    partition_id, label = line.split("\t", 1)
    label_by_partition[partition_id] = label

for message in messages:
    payload = json.loads(message["payload"])
    partition_id = str(payload.get("partitionId"))
    cfg = partition_cfg.get(partition_id, {})
    display_name = cfg.get("display_name", "")
    if not display_name:
        label = label_by_partition.get(partition_id, "")
        if label:
            display_name = f"Sietch {label}"
    password = cfg.get("password", "")
    payload["displayName"] = display_name
    if password:
        payload["loginPassword"] = password
    payload["isStartingMap"] = True
    gameplay = payload.setdefault("serverGameplaySettings", {})
    core = gameplay.setdefault("CoreSettings", {})
    core["serverDisplayName"] = display_name
    # Director drops "out of order" state updates. Make the overlaid message
    # strictly newer than the raw Survival_1 state it is replacing.
    payload["reportTimestamp"] = max(int(time.time()), int(payload.get("reportTimestamp", 0)) + 1)
    print(json.dumps(payload, separators=(",", ":")))
PY
}

start_loop() {
  mkdir -p runtime/generated
  write_live_pidfile
  trap 'rm -f "$PID_FILE"' EXIT
  local route_refresh_at=0
  ensure_route
  publish_snapshot_once >>"$LOG_FILE" 2>&1 || true
  while true; do
    if [ "$(date +%s)" -ge "$route_refresh_at" ]; then
      ensure_route >>"$LOG_FILE" 2>&1 || true
      publish_snapshot_once >>"$LOG_FILE" 2>&1 || true
      route_refresh_at=$(( $(date +%s) + 10 ))
    fi
    if rows="$(forward_batch_once)"; then
      while IFS= read -r payload; do
        [ -n "$payload" ] || continue
        publish_payload "$payload" >>"$LOG_FILE" 2>&1 || true
      done <<< "$rows"
      continue
    fi
    sleep 1
  done
}

case "${1:-start}" in
  once)
    ensure_route
    rows="$(forward_batch_once || true)"
    if [ -n "${rows:-}" ]; then
      while IFS= read -r payload; do
        [ -n "$payload" ] || continue
        publish_payload "$payload"
      done <<< "$rows"
    else
      publish_snapshot_once
    fi
    ;;
  start)
    clear_stale_pidfile
    if loop_running; then
      exit 0
    fi
    pkill -f "publish-sietch-overrides.sh loop" 2>/dev/null || true
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
    pkill -f "publish-sietch-overrides.sh loop" 2>/dev/null || true
    rm -f "$PID_FILE"
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
