#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

PID_FILE="runtime/generated/deepdesert-overrides.pid"
LOG_FILE="runtime/generated/deepdesert-overrides.log"
LOG_POINTER_FILE="runtime/generated/deepdesert-overrides-current.log"
TEXT_ROUTER_LOG="runtime/text-router/director-current.log"
RMQ_CREDS_FILE="runtime/generated/deepdesert-rmq-admin-creds"
RMQ_TIMEOUT_SECONDS="${DUNE_DEEPDESERT_OVERRIDE_RMQ_TIMEOUT_SECONDS:-8}"
RMQ_CREDS_TTL_SECONDS="${DUNE_DEEPDESERT_OVERRIDE_RMQ_CREDS_TTL_SECONDS:-300}"
RMQ_BINDING_CLEANUP_TIMEOUT_SECONDS="${DUNE_DEEPDESERT_OVERRIDE_BINDING_CLEANUP_TIMEOUT_SECONDS:-2}"
STOP_RESTORE_TIMEOUT_SECONDS="${DUNE_DEEPDESERT_OVERRIDE_STOP_RESTORE_TIMEOUT_SECONDS:-20}"
ROUTE_REFRESH_SECONDS="${DUNE_DEEPDESERT_OVERRIDE_ROUTE_REFRESH_SECONDS:-300}"
SNAPSHOT_REFRESH_SECONDS="${DUNE_DEEPDESERT_OVERRIDE_SNAPSHOT_REFRESH_SECONDS:-10}"
POLL_SECONDS="${DUNE_DEEPDESERT_OVERRIDE_POLL_SECONDS:-1}"

SOURCE_EXCHANGE="completions"
SOURCE_ROUTING_KEY="server_state.DeepDesert_1"
SINK_QUEUE="serverStateSink_DeepDesert_1"
FILTER_EXCHANGE="deepdesertOverrideFilteredState"

loop_pids() {
  ps -eo pid=,args= 2>/dev/null \
    | awk -v self="$$" '$1 != self && $0 ~ /(^|[[:space:]])bash[[:space:]].*publish-deepdesert-overrides[.]sh[[:space:]]+loop([[:space:]]|$)/ { print $1 }' \
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
  local now mtime line_count creds cache_tmp
  if [ -r "$RMQ_CREDS_FILE" ]; then
    now="$(date +%s)"
    mtime="$(stat -c %Y "$RMQ_CREDS_FILE" 2>/dev/null || echo 0)"
    line_count="$(wc -l < "$RMQ_CREDS_FILE" 2>/dev/null || printf '0')"
    line_count="$(printf '%s' "$line_count" | tr -cd '[:digit:]')"
    line_count="${line_count:-0}"
    if [ $((now - mtime)) -lt "$RMQ_CREDS_TTL_SECONDS" ] && [ "$line_count" -ge 2 ]; then
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
)"
  [ -n "$creds" ] || return 1
  cache_tmp="${RMQ_CREDS_FILE}.tmp.$$"
  if { printf '%s\n' "$creds" >"$cache_tmp" \
      && chmod 600 "$cache_tmp" \
      && mv -f "$cache_tmp" "$RMQ_CREDS_FILE"; } 2>/dev/null; then
    :
  else
    rm -f "$cache_tmp" 2>/dev/null || true
  fi
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
import sys
import time

sys.path.insert(0, "runtime/scripts")
import usersettings  # noqa: E402

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

usersettings_config = usersettings.load_config()


def combat_settings_for_partition(partition_id: str) -> dict:
    """Resolve this partition's PvP/PvE combat state via the canonical
    resolver (the same merged UserGame.ini logic used by
    `usersettings.py partition-values`), instead of publishing a single
    hard-coded CombatSettings block for every Deep Desert partition.

    This mirrors publish-deepdesert-state.sh's and publish-sietch-overrides.sh's
    identical fix. This script was the third, previously-unfixed sibling
    publisher with this exact bug: it publishes to the SAME RabbitMQ
    target (completions/server_state.DeepDesert_1, via the
    deepdesertOverrideFilteredState filter exchange) as
    publish-deepdesert-state.sh, and spawn-server.sh runs both scripts
    back-to-back at Deep Desert startup (state.sh then overrides.sh) --
    so this script's previously-generic, identical-for-every-partition
    payload was silently overwriting the correct, per-partition-resolved
    payload publish-deepdesert-state.sh had just published moments
    earlier. Only fields with a known, real source are published here;
    when the partition's combat state cannot be determined
    (UNKNOWN/CONFLICT), the PvP/PvE-affecting fields are omitted entirely
    rather than publishing a guessed value.
    """
    values = usersettings.merged_partition_values(
        usersettings_config, "DeepDesert_1", str(partition_id)
    )
    resolved = usersettings.resolve_partition_combat_state(values)

    # Field values are serialized as strings ("True"/"False"), matching
    # publish-deepdesert-state.sh's and publish-sietch-overrides.sh's
    # snapshot-publish convention for this exact field set (see #106 for
    # the pre-existing, deliberately-not-fixed-here string/bool
    # inconsistency between the snapshot-publish and forward-relay code
    # paths in the Sietch script -- this function only needs to match its
    # own snapshot-publish sibling, not resolve that separate finding).
    settings = {
        "areSecurityZonesEnabled": "True" if resolved["securityZonesEnabled"] else "False",
        "itemDeteriorationUpdateRate": "1.0",
        "vehicleDurabilityDamageMultiplier": "1.0",
        "inventoryDecayedMaxDurabilityThreshold": "0.2",
    }
    if resolved["state"] in ("PVP", "PVE"):
        # shouldForceEnablePvpOnAllPartitions reflects the actual resolved
        # force-all flag only when it is what determined this partition's
        # state; otherwise it is omitted rather than defaulted to False,
        # since a wrong False would misrepresent a force-all-PvP server.
        settings["shouldForceEnablePvpOnAllPartitions"] = (
            "True" if resolved["source"] == "force-pvp-all-partitions" else "False"
        )
    # When state is CONFLICT or UNKNOWN, PvP/PvE-affecting fields are
    # intentionally omitted rather than publishing a guessed value.
    return settings


def gameplay_settings_for_partition(partition_id: str, display_name: str) -> dict:
    return {
        "Difficulty": "Custom",
        "CoreSettings": {
            "serverDisplayName": display_name,
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
        "CombatSettings": combat_settings_for_partition(partition_id),
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
        "serverGameplaySettings": gameplay_settings_for_partition(partition_id, display_name),
    }
    print(json.dumps(payload, separators=(",", ":")))
PY
}

start_loop() {
  mkdir -p runtime/generated
  write_live_pidfile
  trap 'rm -f "$PID_FILE"' EXIT
  local route_refresh_at=0
  local snapshot_refresh_at=0
  local rows payload
  ensure_route
  while true; do
    if [ "$(date +%s)" -ge "$route_refresh_at" ]; then
      ensure_route >>"$LOG_FILE" 2>&1 || true
      route_refresh_at=$(( $(date +%s) + ROUTE_REFRESH_SECONDS ))
    fi
    if [ "$(date +%s)" -ge "$snapshot_refresh_at" ]; then
      rows="$(publish_snapshot_once 2>>"$LOG_FILE" || true)"
      while IFS= read -r payload; do
        [ -n "$payload" ] || continue
        publish_payload "$payload" >>"$LOG_FILE" 2>&1 || true
      done <<< "$rows"
      snapshot_refresh_at=$(( $(date +%s) + SNAPSHOT_REFRESH_SECONDS ))
    fi
    sleep "$POLL_SECONDS"
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
    timeout --kill-after=2s "${STOP_RESTORE_TIMEOUT_SECONDS}s" "$0" restore-route || true
    ;;
  restore-route)
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
