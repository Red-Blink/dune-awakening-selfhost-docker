#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

PID_FILE="runtime/generated/sietch-overrides.pid"
LOG_FILE="runtime/generated/sietch-overrides.log"
LOG_POINTER_FILE="runtime/generated/sietch-overrides-current.log"
TEXT_ROUTER_LOG="runtime/text-router/director-current.log"
CONFIG_FILE="runtime/generated/sietch-config.json"
RMQ_CREDS_FILE="runtime/generated/sietch-rmq-admin-creds"
TIMESTAMP_LEAD_SECONDS="${DUNE_SIETCH_OVERRIDE_TIMESTAMP_LEAD_SECONDS:-0}"
RMQ_TIMEOUT_SECONDS="${DUNE_SIETCH_OVERRIDE_RMQ_TIMEOUT_SECONDS:-8}"
RMQ_CREDS_TTL_SECONDS="${DUNE_SIETCH_OVERRIDE_RMQ_CREDS_TTL_SECONDS:-300}"
FORWARD_POLL_SECONDS="${DUNE_SIETCH_OVERRIDE_FORWARD_POLL_SECONDS:-5}"
ROUTE_REFRESH_SECONDS="${DUNE_SIETCH_OVERRIDE_ROUTE_REFRESH_SECONDS:-300}"
SNAPSHOT_REFRESH_SECONDS="${DUNE_SIETCH_OVERRIDE_SNAPSHOT_REFRESH_SECONDS:-10}"
SPICEFIELD_RECONCILE_SECONDS="${DUNE_SIETCH_SPICEFIELD_RECONCILE_SECONDS:-60}"

SOURCE_EXCHANGE="completions"
SOURCE_ROUTING_KEY="server_state.Survival_1"
SOURCE_FILTER_QUEUE="sietchOverrideSourceSurvival1"
SINK_QUEUE="serverStateSink_Survival_1"
FILTER_EXCHANGE="sietchOverrideFilteredState"

loop_pids() {
  ps -eo pid=,args= 2>/dev/null \
    | awk -v self="$$" '$1 != self && $0 ~ /(^|[[:space:]])bash[[:space:]].*publish-sietch-overrides[.]sh[[:space:]]+loop([[:space:]]|$)/ { print $1 }' \
    || true
}

loop_running() {
  [ -n "$(loop_pids)" ]
}

stop_loop_processes() {
  local pid
  clear_stale_pidfile
  if [ -f "$PID_FILE" ]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ]; then
      kill -- "-$pid" 2>/dev/null || true
      kill "$pid" 2>/dev/null || true
    fi
  fi
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    kill -- "-$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
  done < <(loop_pids)
  sleep 1
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    kill -9 -- "-$pid" 2>/dev/null || true
    kill -9 "$pid" 2>/dev/null || true
  done < <(loop_pids)
  rm -f "$PID_FILE"
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

print_status() {
  clear_stale_pidfile
  if [ -f "$PID_FILE" ]; then
    printf 'running pid=%s log=%s\n' "$(cat "$PID_FILE" 2>/dev/null || true)" "$(cat "$LOG_POINTER_FILE" 2>/dev/null || printf '%s' "$LOG_FILE")"
  elif loop_running; then
    printf 'orphan-running pid=%s log=%s\n' "$(loop_pids | tr '\n' ',' | sed 's/,$//')" "$(cat "$LOG_POINTER_FILE" 2>/dev/null || printf '%s' "$LOG_FILE")"
  else
    printf 'stopped\n'
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
  if [ -e "$LOG_POINTER_FILE" ] && [ ! -w "$LOG_POINTER_FILE" ]; then
    rm -f "$LOG_POINTER_FILE" 2>/dev/null || true
  fi
  printf '%s\n' "$LOG_FILE" >"$LOG_POINTER_FILE" 2>/dev/null || true
}

ensure_text_router_log() {
  local tail_lines
  mkdir -p runtime/text-router
  tail_lines="${DUNE_TEXT_ROUTER_LOG_TAIL_LINES:-4000}"
  case "$tail_lines" in ''|*[!0-9]*) tail_lines=4000 ;; esac
  docker exec dune-text-router sh -lc '
    log="$(find /Tools/Battlegroups/TextRouter/TextRouter/logs -maxdepth 1 -type f -name "director*.log" | sort | tail -n 1)"
    [ -n "$log" ] || exit 1
    tail -n "$1" "$log"
  ' sh "$tail_lines" > "$TEXT_ROUTER_LOG"
}

load_rmq_admin_creds() {
  local now mtime creds
  if [ -f "$RMQ_CREDS_FILE" ]; then
    now="$(date +%s)"
    mtime="$(stat -c %Y "$RMQ_CREDS_FILE" 2>/dev/null || echo 0)"
    if [ $((now - mtime)) -lt "$RMQ_CREDS_TTL_SECONDS" ] && [ "$(wc -l < "$RMQ_CREDS_FILE" | tr -d '[:space:]')" -ge 2 ]; then
      cat "$RMQ_CREDS_FILE"
      return 0
    fi
  fi

  ensure_text_router_log
  creds="$(python3 - <<'PY'
from pathlib import Path
import re
import subprocess
import sys

log_path = Path("runtime/text-router/director-current.log")
patterns = [
    re.compile(r'Generated new admin credentials:\s*(bgd\.[^/\s]+\.admin)\s*/\s*([A-Za-z0-9+/=]+)'),
    re.compile(r'(bgd\.[^/\s]+\.admin)/([A-Za-z0-9+/=]+) => allow administrator'),
]
text = ""
if log_path.exists():
    text = log_path.read_text(errors="ignore")
matches = []
for pattern in patterns:
    matches = pattern.findall(text)
    if matches:
        break
if not matches:
    try:
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
    except Exception:
        text = ""
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
)"
  [ -n "$creds" ] || return 1
  printf '%s\n' "$creds" >"$RMQ_CREDS_FILE"
  chmod 600 "$RMQ_CREDS_FILE" 2>/dev/null || true
  printf '%s\n' "$creds"
}

rmq_admin() {
  local rmq_user rmq_password attempt rc
  for attempt in 1 2; do
    mapfile -t rmq_creds < <(load_rmq_admin_creds)
    [ "${#rmq_creds[@]}" -ge 2 ] || return 1
    rmq_user="${rmq_creds[0]}"
    rmq_password="${rmq_creds[1]}"
    if timeout --kill-after=2s "${RMQ_TIMEOUT_SECONDS}s" docker exec dune-rmq-admin rabbitmqadmin -q -u "$rmq_user" -p "$rmq_password" "$@"; then
      return 0
    fi
    rc=$?
    rm -f "$RMQ_CREDS_FILE"
  done
  return "$rc"
}

rmq_delete_binding_exact() {
  local source="$1" destination="$2" routing_key="$3"
  timeout --kill-after=2s "${RMQ_TIMEOUT_SECONDS}s" docker exec dune-rmq-admin rabbitmqctl eval "
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
  rmq_delete_binding_exact "$SOURCE_EXCHANGE" "$SINK_QUEUE" "$SOURCE_ROUTING_KEY" >/dev/null 2>&1 || true
}

restore_route() {
  rmq_admin declare binding \
    source="$SOURCE_EXCHANGE" \
    destination="$SINK_QUEUE" \
    destination_type=queue \
    routing_key="$SOURCE_ROUTING_KEY" >/dev/null || true
  rmq_delete_binding_exact "$FILTER_EXCHANGE" "$SINK_QUEUE" "$SOURCE_ROUTING_KEY" >/dev/null 2>&1 || true
  rmq_delete_binding_exact "$SOURCE_EXCHANGE" "$SOURCE_FILTER_QUEUE" "$SOURCE_ROUTING_KEY" >/dev/null 2>&1 || true
}

publish_payload() {
  local payload="$1"
  rmq_admin publish \
    exchange="$FILTER_EXCHANGE" \
    routing_key="$SOURCE_ROUTING_KEY" \
    properties='{"content_type":"Content","type":"server_state"}' \
    payload="$payload" >/dev/null
}

heal_survival_alive_state() {
  local live_server_ids sql

  live_server_ids="$(
    timeout 8 docker exec dune-rmq-game rabbitmqctl list_connections user state 2>/dev/null \
      | awk '$1 ~ /^sg[.]/ && $2 == "running" { split($1, parts, "."); if (length(parts) >= 2) print parts[length(parts) - 1] }' \
      | sort -u
  )" || true

  [ -n "$live_server_ids" ] || return 0

  sql="$(LIVE_SERVER_IDS="$live_server_ids" python3 - <<'PY'
import os

ids = [line.strip() for line in os.environ.get("LIVE_SERVER_IDS", "").splitlines() if line.strip()]
if not ids:
    raise SystemExit(0)

def quote(value):
    return "'" + value.replace("'", "''") + "'"

values = ", ".join(f"({quote(server_id)})" for server_id in ids)
print(f"""
with live_server(server_id) as (
  values {values}
)
update dune.farm_state fs
set alive = true
from live_server ls
where fs.server_id = ls.server_id
  and fs.map = 'Survival_1'
  and fs.ready = true
  and fs.alive = false
  and exists (
    select 1
    from dune.world_partition wp
    where wp.server_id = fs.server_id
      and wp.map = 'Survival_1'
  );
""")
PY
)"

  [ -n "$sql" ] || return 0
  docker exec dune-postgres psql -U postgres -d dune -qAt -c "$sql" >/dev/null 2>&1 || true
}

publish_snapshot_once() {
  local rows
  local survival_log_ready="false"
  runtime/scripts/sietches.sh sync >>"$LOG_FILE" 2>&1 || {
    echo "Sietch sync failed before publish." >&2
    return 1
  }
  heal_survival_alive_state
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-server-survival-1; then
    if docker logs dune-server-survival-1 2>&1 | grep -Eq 'Server farm is READY .*partition 1'; then
      survival_log_ready="true"
    fi
  fi
  rows="$(TIMESTAMP_LEAD_SECONDS="$TIMESTAMP_LEAD_SECONDS" SURVIVAL_LOG_READY="$survival_log_ready" python3 - <<'PY'
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, "runtime/scripts")
import usersettings  # noqa: E402

config_path = Path("runtime/generated/sietch-config.json")
config = json.loads(config_path.read_text()) if config_path.exists() else {"partitions": {}}
partitions = config.get("partitions", {})
timestamp_lead = int(os.environ.get("TIMESTAMP_LEAD_SECONDS", "0"))
survival_log_ready = os.environ.get("SURVIVAL_LOG_READY", "").lower() in ("1", "true", "t", "yes")

query = """
select wp.partition_id,
       wp.map,
       coalesce(wp.server_id, ''),
       coalesce(fs.ready, false),
       coalesce(wp.label, ''),
       coalesce(host(fs.game_addr), ''),
       coalesce(fs.game_port, 0)
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

usersettings_config = usersettings.load_config()


def combat_settings_for_partition(partition_id: str) -> dict:
    """Resolve this partition's PvP/PvE combat state via the canonical
    resolver (the same merged UserGame.ini logic used by
    `usersettings.py partition-values`) instead of publishing a single
    hard-coded CombatSettings block for every Survival_1 partition/Sietch.

    PvP/PvE-affecting fields are omitted entirely when the partition's
    combat state cannot be determined (UNKNOWN/CONFLICT), rather than
    publishing a guessed value.
    """
    values = usersettings.merged_partition_values(
        usersettings_config, "Survival_1", str(partition_id)
    )
    resolved = usersettings.resolve_partition_combat_state(values)

    settings = {
        "areSecurityZonesEnabled": "True" if resolved["securityZonesEnabled"] else "False",
        "itemDeteriorationUpdateRate": "1.0",
        "vehicleDurabilityDamageMultiplier": "1.0",
        "inventoryDecayedMaxDurabilityThreshold": "0.2",
    }
    if resolved["state"] in ("PVP", "PVE"):
        settings["shouldForceEnablePvpOnAllPartitions"] = (
            "True" if resolved["source"] == "force-pvp-all-partitions" else "False"
        )
    return settings


def gameplay_settings_for_partition(partition_id: str) -> dict:
    return {
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
        "CombatSettings": combat_settings_for_partition(partition_id),
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
    partition_id, map_name, server_id, ready, label, game_addr, game_port = line.split("\t")
    effective_ready = ready.lower() in ("t", "true", "1")
    if partition_id == "1" and survival_log_ready:
        effective_ready = True
    cfg = partitions.get(partition_id, {})
    display_name = cfg.get("display_name", "")
    if not display_name and label:
        display_name = label if label.lower().startswith("sietch ") else f"Sietch {label}"
    password = cfg.get("password", "")
    payload = {
        "reportTimestamp": int(time.time()) + timestamp_lead,
        "partitionId": int(partition_id),
        "serverId": server_id,
        "ready": effective_ready,
        "displayName": display_name,
        "isStartingMap": True,
        "playerHardCapOverride": -1,
        "wauCapCurve": -1,
        "players": [],
        "serverGameplaySettings": gameplay_settings_for_partition(partition_id),
    }
    if game_addr:
        payload["ip"] = game_addr
    if game_port and game_port != "0":
        payload["port"] = int(game_port)
    payload["loginPassword"] = password if password else ""
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

  local survival_log_ready="false"
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-server-survival-1; then
    if docker logs dune-server-survival-1 2>&1 | grep -Eq 'Server farm is READY .*partition 1'; then
      survival_log_ready="true"
    fi
  fi

  FILTER_MESSAGES="$messages" FILTER_CONFIG_PATH="$CONFIG_FILE" SURVIVAL_LOG_READY="$survival_log_ready" python3 - <<'PY'
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, "runtime/scripts")
import usersettings  # noqa: E402

messages = json.loads(os.environ["FILTER_MESSAGES"])
config_path = Path(os.environ["FILTER_CONFIG_PATH"])
config = json.loads(config_path.read_text()) if config_path.exists() else {"partitions": {}}
partition_cfg = config.get("partitions", {})
survival_log_ready = os.environ.get("SURVIVAL_LOG_READY", "").lower() in ("1", "true", "t", "yes")
label_rows_raw = subprocess.check_output([
    "docker", "exec", "dune-postgres", "psql",
    "-U", "postgres", "-d", "dune", "-At", "-F", "\t",
    "-c", "select partition_id, coalesce(label, '') from dune.world_partition where lower(map)=lower('Survival_1');"
], text=True)
endpoint_rows_raw = subprocess.check_output([
    "docker", "exec", "dune-postgres", "psql",
    "-U", "postgres", "-d", "dune", "-At", "-F", "\t",
    "-c", """
      select wp.partition_id,
             coalesce(host(fs.game_addr), ''),
             coalesce(fs.game_port, 0)
      from dune.world_partition wp
      left join dune.farm_state fs on fs.server_id = wp.server_id
      where lower(wp.map)=lower('Survival_1');
    """
], text=True)
label_by_partition = {}
for line in label_rows_raw.splitlines():
    if not line.strip():
        continue
    partition_id, label = line.split("\t", 1)
    label_by_partition[partition_id] = label
endpoint_by_partition = {}
for line in endpoint_rows_raw.splitlines():
    if not line.strip():
        continue
    partition_id, game_addr, game_port = line.split("\t", 2)
    endpoint_by_partition[partition_id] = (game_addr, game_port)

usersettings_config = usersettings.load_config()


def resolved_force_all_pvp_flag(partition_id: str):
    """Resolve shouldForceEnablePvpOnAllPartitions from the canonical
    resolver rather than silently defaulting a missing field to False.
    Returns None when the partition's combat state cannot be determined,
    so the caller can omit the field entirely instead of guessing."""
    values = usersettings.merged_partition_values(
        usersettings_config, "Survival_1", str(partition_id)
    )
    resolved = usersettings.resolve_partition_combat_state(values)
    if resolved["state"] not in ("PVP", "PVE"):
        return None
    return resolved["source"] == "force-pvp-all-partitions"


latest_by_partition = {}
for message in messages:
    payload = json.loads(message["payload"])
    partition_id = str(payload.get("partitionId"))
    if not partition_id or partition_id == "None":
        continue
    current = latest_by_partition.get(partition_id)
    if current is None or int(payload.get("reportTimestamp", 0) or 0) >= int(current.get("reportTimestamp", 0) or 0):
        latest_by_partition[partition_id] = payload

base_timestamp = int(time.time())
for offset, partition_id in enumerate(sorted(latest_by_partition, key=lambda value: (0, int(value)) if value.isdigit() else (1, value))):
    payload = latest_by_partition[partition_id]
    if partition_id == "1" and survival_log_ready:
        payload["ready"] = True
    cfg = partition_cfg.get(partition_id, {})
    display_name = cfg.get("display_name", "")
    if not display_name:
        label = label_by_partition.get(partition_id, "")
        if label:
            display_name = label if label.lower().startswith("sietch ") else f"Sietch {label}"
    password = cfg.get("password", "")
    game_addr, game_port = endpoint_by_partition.get(partition_id, ("", "0"))
    if game_addr:
        payload["ip"] = game_addr
    if game_port and game_port != "0":
        payload["port"] = int(game_port)
    payload["displayName"] = display_name
    payload["loginPassword"] = password if password else ""
    payload["isStartingMap"] = True
    gameplay = payload.setdefault("serverGameplaySettings", {})
    core = gameplay.setdefault("CoreSettings", {})
    core["serverDisplayName"] = display_name
    combat = gameplay.setdefault("CombatSettings", {})
    if combat.get("shouldForceEnablePvpOnAllPartitions") in ("", None):
        resolved_flag = resolved_force_all_pvp_flag(partition_id)
        if resolved_flag is not None:
            combat["shouldForceEnablePvpOnAllPartitions"] = resolved_flag
        else:
            combat.pop("shouldForceEnablePvpOnAllPartitions", None)
    payload["reportTimestamp"] = max(base_timestamp + offset, int(payload.get("reportTimestamp", 0) or 0) + 1)
    print(json.dumps(payload, separators=(",", ":")))
PY
}

start_loop() {
  mkdir -p runtime/generated
  write_live_pidfile
  trap 'rm -f "$PID_FILE"' EXIT
  local route_refresh_at=0
  local snapshot_refresh_at=0
  local spicefield_reconcile_at=0
  ensure_route
  publish_snapshot_once >>"$LOG_FILE" 2>&1 || true
  while true; do
    if [ "$(date +%s)" -ge "$route_refresh_at" ]; then
      ensure_route >>"$LOG_FILE" 2>&1 || true
      route_refresh_at=$(( $(date +%s) + ROUTE_REFRESH_SECONDS ))
    fi
    if [ "$(date +%s)" -ge "$snapshot_refresh_at" ]; then
      publish_snapshot_once >>"$LOG_FILE" 2>&1 || true
      snapshot_refresh_at=$(( $(date +%s) + SNAPSHOT_REFRESH_SECONDS ))
    fi
    if [ "${SPICEFIELD_RECONCILE_SECONDS:-0}" -gt 0 ] 2>/dev/null && [ "$(date +%s)" -ge "$spicefield_reconcile_at" ]; then
      runtime/scripts/spicefield-overrides.sh reconcile >>"$LOG_FILE" 2>&1 || true
      spicefield_reconcile_at=$(( $(date +%s) + SPICEFIELD_RECONCILE_SECONDS ))
    fi
    if rows="$(forward_batch_once)"; then
      while IFS= read -r payload; do
        [ -n "$payload" ] || continue
        publish_payload "$payload" >>"$LOG_FILE" 2>&1 || true
      done <<< "$rows"
      sleep "$FORWARD_POLL_SECONDS"
      continue
    fi
    sleep "$FORWARD_POLL_SECONDS"
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
      loop_pids | head -n 1 >"$PID_FILE"
      exit 0
    fi
    stop_loop_processes
    prepare_runtime_generated_files
    setsid "$0" loop >>"$LOG_FILE" 2>&1 </dev/null &
    echo $! >"$PID_FILE"
    ;;
  loop)
    prepare_runtime_generated_files
    start_loop
    ;;
  stop)
    stop_loop_processes
    restore_route || true
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  status)
    print_status
    ;;
  *)
    echo "Usage: $0 [once|start|stop|restart|status]"
    exit 2
    ;;
esac
