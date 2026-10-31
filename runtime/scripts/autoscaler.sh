#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

# shellcheck source=runtime/scripts/lib/igw-socket-health.sh
source runtime/scripts/lib/igw-socket-health.sh

# shellcheck source=runtime/scripts/lib/postgres.sh
source runtime/scripts/lib/postgres.sh

INTERVAL="${DUNE_AUTOSCALER_INTERVAL:-5}"
if ! [[ "$INTERVAL" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid DUNE_AUTOSCALER_INTERVAL; using 5 seconds." >&2
  INTERVAL=5
fi
DEMAND_INTERVAL="${DUNE_AUTOSCALER_DEMAND_INTERVAL:-2}"
if ! [[ "$DEMAND_INTERVAL" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid DUNE_AUTOSCALER_DEMAND_INTERVAL; using 2 seconds." >&2
  DEMAND_INTERVAL=2
fi
SINCE="${DUNE_AUTOSCALER_LOG_SINCE:-30s}"
NAMED_DESTINATION_SINCE="${DUNE_AUTOSCALER_NAMED_DESTINATION_LOG_SINCE:-10m}"
IDLE_SECONDS="${DUNE_AUTOSCALER_IDLE_SECONDS:-300}"
DESPAWN_GRACE_SECONDS="${DUNE_AUTOSCALER_DESPAWN_GRACE_SECONDS:-$IDLE_SECONDS}"
TRAVEL_GRACE_SECONDS="${DUNE_AUTOSCALER_TRAVEL_GRACE_SECONDS:-120}"
STATE_FILE="${DUNE_AUTOSCALER_STATE_FILE:-runtime/generated/autoscaler-idle.tsv}"
SERVER_ID_MAP_FILE="${DUNE_AUTOSCALER_SERVER_ID_MAP_FILE:-runtime/generated/autoscaler-server-ids.tsv}"
DEMAND_FILE="${DUNE_AUTOSCALER_DEMAND_FILE:-runtime/generated/autoscaler-demand.tsv}"
DEMAND_EVENT_FILE="${DUNE_AUTOSCALER_DEMAND_EVENT_FILE:-runtime/generated/autoscaler-demand-events.tsv}"
HUB_TRAVEL_FILE="${DUNE_AUTOSCALER_HUB_TRAVEL_FILE:-runtime/generated/autoscaler-hub-travel.tsv}"
HUB_TRAVEL_RETENTION_SECONDS="${DUNE_AUTOSCALER_HUB_TRAVEL_RETENTION_SECONDS:-86400}"
if ! [[ "$HUB_TRAVEL_RETENTION_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid DUNE_AUTOSCALER_HUB_TRAVEL_RETENTION_SECONDS; using 86400 seconds." >&2
  HUB_TRAVEL_RETENTION_SECONDS=86400
fi
DEEPDESERT_TRAVEL_FILE="${DUNE_AUTOSCALER_DEEPDESERT_TRAVEL_FILE:-runtime/generated/autoscaler-deepdesert-travel.tsv}"
DIRECTOR_HEAL_FILE="${DUNE_AUTOSCALER_DIRECTOR_HEAL_FILE:-runtime/generated/autoscaler-director-heal.tsv}"
SIETCH_TOPOLOGY_MAINTENANCE_FILE="${DUNE_SIETCH_TOPOLOGY_MAINTENANCE_FILE:-runtime/generated/sietch-topology-maintenance}"
SIETCH_TOPOLOGY_HEAL_GRACE_SECONDS="${DUNE_SIETCH_TOPOLOGY_HEAL_GRACE_SECONDS:-600}"
DIRECTOR_HEAL_STALE_SECONDS="${DUNE_AUTOSCALER_DIRECTOR_HEAL_STALE_SECONDS:-15}"
DIRECTOR_HEAL_COOLDOWN_SECONDS="${DUNE_AUTOSCALER_DIRECTOR_HEAL_COOLDOWN_SECONDS:-300}"
DIRECTOR_HEAL_REPUBLISH_GRACE_SECONDS="${DUNE_AUTOSCALER_DIRECTOR_HEAL_REPUBLISH_GRACE_SECONDS:-45}"
DIRECTOR_CORE_READY_GRACE_SECONDS="${DUNE_AUTOSCALER_DIRECTOR_CORE_READY_GRACE_SECONDS:-120}"
DYNAMIC_READY_HEAL_STALE_SECONDS="${DUNE_AUTOSCALER_DYNAMIC_READY_HEAL_STALE_SECONDS:-20}"
DIRECTOR_BROWSER_SCAN_SECONDS="${DUNE_AUTOSCALER_DIRECTOR_BROWSER_SCAN_SECONDS:-30}"
DYNAMIC_READY_HEAL_SCAN_SECONDS="${DUNE_AUTOSCALER_DYNAMIC_READY_HEAL_SCAN_SECONDS:-30}"
CHAT_EXCHANGE_REPAIR_SECONDS="${DUNE_AUTOSCALER_CHAT_EXCHANGE_REPAIR_SECONDS:-300}"
CHAT_EXCHANGE_REPAIR_TIMEOUT_SECONDS="${DUNE_AUTOSCALER_CHAT_EXCHANGE_REPAIR_TIMEOUT_SECONDS:-60}"
CHAT_EXCHANGE_REPAIR_PID_FILE="${DUNE_AUTOSCALER_CHAT_EXCHANGE_REPAIR_PID_FILE:-runtime/generated/autoscaler-chat-repair.pid}"
IGWO_UNAVAILABLE_SCAN_SECONDS="${DUNE_AUTOSCALER_IGWO_UNAVAILABLE_SCAN_SECONDS:-10}"
IGWO_UNAVAILABLE_COOLDOWN_SECONDS="${DUNE_AUTOSCALER_IGWO_UNAVAILABLE_COOLDOWN_SECONDS:-60}"
STALE_SERVER_STATE_SCAN_SECONDS="${DUNE_AUTOSCALER_STALE_SERVER_STATE_SCAN_SECONDS:-15}"
STALE_SERVER_STATE_COOLDOWN_SECONDS="${DUNE_AUTOSCALER_STALE_SERVER_STATE_COOLDOWN_SECONDS:-45}"
IGW_SOCKET_HEALTH_SCAN_SECONDS="${DUNE_AUTOSCALER_IGW_SOCKET_HEALTH_SCAN_SECONDS:-10}"
IGW_SOCKET_STALL_SECONDS="${DUNE_AUTOSCALER_IGW_SOCKET_STALL_SECONDS:-120}"
IGW_SOCKET_RX_QUEUE_THRESHOLD="${DUNE_AUTOSCALER_IGW_SOCKET_RX_QUEUE_THRESHOLD:-1048576}"
IGW_SOCKET_DROP_GRACE_SECONDS="${DUNE_AUTOSCALER_IGW_SOCKET_DROP_GRACE_SECONDS:-30}"
IGW_SOCKET_RECOVERY_COOLDOWN_SECONDS="${DUNE_AUTOSCALER_IGW_SOCKET_RECOVERY_COOLDOWN_SECONDS:-600}"
IGW_SOCKET_EVIDENCE_LOG="${DUNE_AUTOSCALER_IGW_SOCKET_EVIDENCE_LOG:-runtime/logs/igw-socket-watchdog.log}"

# Convert a docker-logs-style duration ("30s", "10m", "1h", or a bare integer
# already in seconds) into whole seconds, so a scan's interval can be checked
# against the log window it reads.
duration_to_seconds() {
  local value="$1"
  local amount

  [[ "$value" =~ ^([1-9][0-9]*)([smh]?)$ ]] || return 1
  amount="${BASH_REMATCH[1]}"
  case "$value" in
    *h) echo $((amount * 3600)) ;;
    *m) echo $((amount * 60)) ;;
    *) echo "$amount" ;;
  esac
}

validate_log_window() {
  local var_name="$1"
  local value="$2"
  local default_value="$3"
  local seconds

  if ! seconds="$(duration_to_seconds "$value")" || [ "$seconds" -le 1 ]; then
    echo "Invalid ${var_name}; using ${default_value}." >&2
    value="$default_value"
  fi
  echo "$value"
}

# Validate a *_SCAN_SECONDS override: fall back to the default on a
# non-numeric value (matching DUNE_AUTOSCALER_DEMAND_INTERVAL's existing
# validation above) instead of silently defeating director_heal_due's gate,
# and clamp below the scan's own log window so a bad override can't open a
# permanent detection gap instead of merely a delay.
validate_scan_seconds() {
  local var_name="$1"
  local value="$2"
  local default_value="$3"
  local window_seconds="$4"

  if ! [[ "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "Invalid ${var_name}; using ${default_value} seconds." >&2
    value="$default_value"
  fi
  if [ "$window_seconds" -gt 0 ] && [ "$value" -ge "$window_seconds" ]; then
    echo "${var_name}=${value} is >= its log window (${window_seconds}s); clamping to $((window_seconds - 1))s to avoid a permanent detection gap." >&2
    value=$((window_seconds - 1))
  fi
  echo "$value"
}

SINCE="$(validate_log_window DUNE_AUTOSCALER_LOG_SINCE "$SINCE" 30s)"
NAMED_DESTINATION_SINCE="$(validate_log_window DUNE_AUTOSCALER_NAMED_DESTINATION_LOG_SINCE "$NAMED_DESTINATION_SINCE" 10m)"
SINCE_SECONDS="$(duration_to_seconds "$SINCE")"
NAMED_DESTINATION_SINCE_SECONDS="$(duration_to_seconds "$NAMED_DESTINATION_SINCE")"

# All production scanners share one stream. The unset branch also lets isolated
# function harnesses supply their existing Docker fixtures without a daemon.
director_logs() {
  if [ -n "${DIRECTOR_LOG_CACHE_FILE:-}" ]; then
    python3 runtime/scripts/director-log-cache.py read "$DIRECTOR_LOG_CACHE_FILE" "$@"
  else
    docker logs "$@" dune-director
  fi
}

director_logs_available() {
  [ -z "${DIRECTOR_LOG_CACHE_FILE:-}" ] || director_logs --since 1s >/dev/null 2>&1
}

start_director_log_cache() {
  DIRECTOR_LOG_CACHE_DIR="$(mktemp -d runtime/generated/director-log-cache.XXXXXX)"
  DIRECTOR_LOG_CACHE_FILE="$DIRECTOR_LOG_CACHE_DIR/recent.sqlite"
  ensure_director_log_cache
  trap 'stop_director_log_cache' EXIT
  trap 'exit 143' TERM
  trap 'exit 130' INT
}

ensure_director_log_cache() {
  [ -z "${DIRECTOR_LOG_CACHE_PID:-}" ] || ! kill -0 "$DIRECTOR_LOG_CACHE_PID" 2>/dev/null || return 0
  local retention="$NAMED_DESTINATION_SINCE_SECONDS"
  [ "$retention" -ge "$SINCE_SECONDS" ] || retention="$SINCE_SECONDS"
  [ "$retention" -ge 600 ] || retention=600
  python3 runtime/scripts/director-log-cache.py follow "$DIRECTOR_LOG_CACHE_FILE" \
    --retention "$retention" --parent "$$" &
  DIRECTOR_LOG_CACHE_PID=$!
}

stop_director_log_cache() {
  kill "$DIRECTOR_LOG_CACHE_PID" 2>/dev/null || true
  wait "$DIRECTOR_LOG_CACHE_PID" 2>/dev/null || true
  rm -f "$DIRECTOR_LOG_CACHE_FILE" "$DIRECTOR_LOG_CACHE_FILE-wal" "$DIRECTOR_LOG_CACHE_FILE-shm"
  rmdir "$DIRECTOR_LOG_CACHE_DIR" 2>/dev/null || true
}
PROACTIVE_HAGGA_SCAN_SECONDS="$(validate_scan_seconds DUNE_AUTOSCALER_PROACTIVE_HAGGA_SCAN_SECONDS "${DUNE_AUTOSCALER_PROACTIVE_HAGGA_SCAN_SECONDS:-15}" 15 "$SINCE_SECONDS")"
DEEPDESERT_LOADING_SCAN_SECONDS="$(validate_scan_seconds DUNE_AUTOSCALER_DEEPDESERT_LOADING_SCAN_SECONDS "${DUNE_AUTOSCALER_DEEPDESERT_LOADING_SCAN_SECONDS:-15}" 15 "$SINCE_SECONDS")"
NAMED_DESTINATION_SCAN_SECONDS="$(validate_scan_seconds DUNE_AUTOSCALER_NAMED_DESTINATION_SCAN_SECONDS "${DUNE_AUTOSCALER_NAMED_DESTINATION_SCAN_SECONDS:-60}" 60 "$NAMED_DESTINATION_SINCE_SECONDS")"
# Deliberately its own interval, not a share of NAMED_DESTINATION_SCAN_SECONDS
# (used by the unrelated scan_named_destination_failures): a player waiting on
# a rejected story return to recover feels every second of this gate. Keep the
# default at the existing fast-follower cadence: the live credits-loop fix
# depends on recovery running before the paired synthetic story demand, so a
# longer gate can reintroduce that race. Recovery runs only in the dedicated
# fast follower, immediately before its paired travel-demand scan; the atomic
# gate prevents duplicate invocations without letting the slower main loop
# consume the recovery window.
STORY_RETURN_RECOVERY_SCAN_SECONDS="$(validate_scan_seconds DUNE_AUTOSCALER_STORY_RETURN_RECOVERY_SCAN_SECONDS "${DUNE_AUTOSCALER_STORY_RETURN_RECOVERY_SCAN_SECONDS:-2}" 2 "$NAMED_DESTINATION_SINCE_SECONDS")"
if [ "$STORY_RETURN_RECOVERY_SCAN_SECONDS" -gt 2 ]; then
  echo "DUNE_AUTOSCALER_STORY_RETURN_RECOVERY_SCAN_SECONDS=${STORY_RETURN_RECOVERY_SCAN_SECONDS} exceeds the safe credits-return window; clamping to 2s." >&2
  STORY_RETURN_RECOVERY_SCAN_SECONDS=2
fi
AUTOSCALER_STARTED_AT="$(date +%s)"

mkdir -p "$(dirname "$STATE_FILE")"
touch "$STATE_FILE"
touch "$SERVER_ID_MAP_FILE"
touch "$DEMAND_FILE"
touch "$DEMAND_EVENT_FILE"
touch "$HUB_TRAVEL_FILE"
touch "$DEEPDESERT_TRAVEL_FILE"
touch "$DIRECTOR_HEAL_FILE"

echo "=== Dune Docker autoscaler ==="
echo "Watching Director travel queues and idle dynamic servers."
echo "Interval: ${INTERVAL}s"
echo "Travel demand interval: ${DEMAND_INTERVAL}s"
echo "Log window: ${SINCE}"
echo "Named destination log window: ${NAMED_DESTINATION_SINCE}"
echo "Idle despawn grace: ${IDLE_SECONDS}s"
echo "Fresh-process maps: immediate deallocation once empty"
echo "Dynamic mode-change grace: ${DESPAWN_GRACE_SECONDS}s"
echo "Travel grace: ${TRAVEL_GRACE_SECONDS}s"
echo "Director browser heal scan: ${DIRECTOR_BROWSER_SCAN_SECONDS}s"
echo "Dynamic ready heal scan: ${DYNAMIC_READY_HEAL_SCAN_SECONDS}s"
echo "Chat exchange repair scan: ${CHAT_EXCHANGE_REPAIR_SECONDS}s"
echo "IGWO unavailable heal scan: ${IGWO_UNAVAILABLE_SCAN_SECONDS}s"
echo "Stale server-state heal scan: ${STALE_SERVER_STATE_SCAN_SECONDS}s"
echo "IGW socket health scan: ${IGW_SOCKET_HEALTH_SCAN_SECONDS}s"
echo "Proactive Hagga handoff scan: ${PROACTIVE_HAGGA_SCAN_SECONDS}s"
echo "Deep Desert loading response scan: ${DEEPDESERT_LOADING_SCAN_SECONDS}s"
echo "Named destination failure scan: ${NAMED_DESTINATION_SCAN_SECONDS}s"
echo "Story return recovery scan: ${STORY_RETURN_RECOVERY_SCAN_SECONDS}s"
echo "State file: ${STATE_FILE}"
echo

if ! docker ps --format '{{.Names}}' | grep -qx dune-director; then
  echo "dune-director is not running."
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx dune-postgres; then
  echo "dune-postgres is not running."
  exit 1
fi

hub_origin_id_for_map() {
  case "$1" in
    SH_Arrakeen) echo "SH_Arrakeen3" ;;
    SH_HarkoVillage) echo "SH_HarkoVillage4" ;;
    Story_ProcesVerbal) echo "Story_ProcesVerbal9" ;;
    *) return 1 ;;
  esac
}

hub_server_id_for_origin_id() {
  local map

  case "$1" in
    SH_Arrakeen3) map="SH_Arrakeen" ;;
    SH_HarkoVillage4) map="SH_HarkoVillage" ;;
    Story_ProcesVerbal9) map="Story_ProcesVerbal" ;;
    *) return 1 ;;
  esac

  psql_value "
    select coalesce(server_id, '')
    from dune.farm_state
    where map = '$map'
      and coalesce(server_id, '') <> ''
    order by ready desc, alive desc
    limit 1;
  "
}

origin_server_id_for_origin_id() {
  case "$1" in
    Overmap2)
      psql_value "
        select coalesce(server_id, '')
        from dune.farm_state
        where map = 'Overmap'
        limit 1;
      "
      ;;
    *)
      hub_server_id_for_origin_id "$1"
      ;;
  esac
}

publish_rmq_json() {
  local exchange="$1"
  local routing_key="$2"
  local payload_json="$3"
  local label="$4"
  local payload_b64 eval_code output

  payload_b64="$(printf '%s' "$payload_json" | base64 -w0)"
  eval_code='Payload = base64:decode(<<"'"$payload_b64"'">>), XName = rabbit_misc:r(<<"/">>, exchange, <<"'"$exchange"'">>), X = rabbit_exchange:lookup_or_die(XName), MsgId = list_to_binary("'"$label"'-" ++ integer_to_list(erlang:system_time(millisecond))), P = {list_to_atom("P_basic"), <<"application/json">>, undefined, [], undefined, undefined, undefined, undefined, undefined, MsgId, undefined, undefined, <<"fls">>, <<"dune_autoscaler">>, undefined}, Content = rabbit_basic:build_content(P, Payload), {ok, Msg} = rabbit_basic:message(XName, <<"'"$routing_key"'">>, Content), Result = rabbit_queue_type:publish_at_most_once(X, Msg), io:format("publish=~p exchange='"$exchange"' routing='"$routing_key"' label='"$label"'~n", [Result]).'
  output="$(docker exec dune-rmq-game rabbitmqctl eval "$eval_code" 2>&1)"
  if [[ "$output" != *"publish=ok"* ]]; then
    echo "ERROR failed to publish $label via exchange=$exchange routing=$routing_key"
    echo "$output"
    return 1
  fi
}

replay_hagga_travel_handoff() {
  local flow_id="$1"
  local destination_name="$2"
  local origin_server_id="$3"
  local director_log_file replay_rows

  case "$destination_name" in
    Travel_To_HaggaBasin_*|Travel_To_Hagga_Basin_*) ;;
    *) return 0 ;;
  esac

  [ -n "$origin_server_id" ] || return 0

  director_log_file="$(mktemp)"
  director_logs --since "$NAMED_DESTINATION_SINCE" > "$director_log_file" 2>/dev/null || true
  replay_rows="$(FLOW_ID="$flow_id" LOG_FILE="$director_log_file" python3 - <<'PY'
import base64
import json
import os
import re

flow_id = os.environ.get("FLOW_ID", "")
log_file = os.environ.get("LOG_FILE", "")
response_re = re.compile(r'Notified player\(s\) of travel response (\S+): (\{.*\})')
grant_re = re.compile(r'Notified player of travel grant (\S+): (\{.*\})')

rows = []

with open(log_file, encoding="utf-8", errors="replace") as f:
    for line in f:
        if flow_id not in line:
            continue
        for kind, regex, map_key in (
            ("response", response_re, "MapName"),
            ("grant", grant_re, "Map"),
        ):
            match = regex.search(line)
            if not match:
                continue
            try:
                payload = json.loads(match.group(2))
            except json.JSONDecodeError:
                continue
            if payload.get("RequestID") != flow_id:
                continue
            payload[map_key] = "HaggaBasin"
            encoded = base64.b64encode(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).decode("ascii")
            print(f"{kind}|{encoded}")
PY
  )"
  rm -f "$director_log_file"

  while IFS='|' read -r kind payload_b64; do
    [ -n "${kind:-}" ] || continue
    case "$kind" in
      response)
        publish_rmq_json "heartbeats" "$origin_server_id" "$(printf '%s' "$payload_b64" | base64 -d)" "travel-${kind}-${flow_id}" || true
        echo "REPLAY travel flow=$flow_id kind=$kind server=$origin_server_id map=HaggaBasin"
        ;;
      grant)
        publish_rmq_json "heartbeats" "$origin_server_id" "$(printf '%s' "$payload_b64" | base64 -d)" "travel-${kind}-${flow_id}" || true
        echo "REPLAY travel flow=$flow_id kind=$kind server=$origin_server_id map=HaggaBasin"
        ;;
    esac
  done <<< "$replay_rows"
}

map_uses_dedicated_scaling() {
  local map="$1"

  python3 - "$map" <<'PY'
import json
import sys
from pathlib import Path

target = sys.argv[1].lower()
catalog_path = Path("runtime/generated/server-catalog.json")

if not catalog_path.exists():
    print("0")
    raise SystemExit

try:
    catalog = json.loads(catalog_path.read_text())
except Exception:
    print("0")
    raise SystemExit

for item in catalog:
    if str(item.get("map", "")).lower() != target:
        continue
    print("1" if bool((item.get("raw") or {}).get("dedicatedScaling")) else "0")
    raise SystemExit

print("0")
PY
}

director_map_max_parties() {
  local map="$1"
  local config_path="${DUNE_DIRECTOR_CONFIG_FILE:-runtime/director/config/director_config.ini}"

  [ -r "$config_path" ] || return 1
  awk -v target="$map" '
    /^[[:space:]]*\[[^]]+\][[:space:]]*$/ {
      section = $0
      sub(/^[[:space:]]*\[/, "", section)
      sub(/\][[:space:]]*$/, "", section)
      next
    }
    section == target && /^[[:space:]]*MaxParties[[:space:]]*=/ {
      value = $0
      sub(/^[^=]*=[[:space:]]*/, "", value)
      sub(/[[:space:]]*[;#].*$/, "", value)
      sub(/[[:space:]]*$/, "", value)
      print value
      found = 1
      exit
    }
    END { if (!found) exit 1 }
  ' "$config_path"
}

map_requires_isolated_party_dimension() {
  local max_parties
  max_parties="$(director_map_max_parties "$1" 2>/dev/null)" || return 1
  [ "$max_parties" = "1" ]
}

map_exists() {
  local map="$1"
  local safe
  safe="$(printf '%s' "$map" | tr -cd 'A-Za-z0-9_')"

  [ "$(psql_value "select count(*) from dune.world_partition where lower(map) = lower('$safe');")" != "0" ]
}

map_assigned_count() {
  local map="$1"
  local safe
  safe="$(printf '%s' "$map" | tr -cd 'A-Za-z0-9_')"

  psql_value "
    select count(*)
    from dune.world_partition
    where lower(map) = lower('$safe')
      and coalesce(server_id, '') <> '';
  "
}

occupied_dimensions_for_map() {
  local map="$1"
  local safe
  safe="${map//\'/\'\'}"

  psql_value "
    select count(distinct fs.server_id)
    from dune.farm_state fs
    join dune.world_partition wp
      on wp.server_id = fs.server_id
     and lower(wp.map) = lower('$safe')
    where fs.map = '$safe'
      and coalesce(fs.server_id, '') <> ''
      and (
        -- The world server's live connection count is authoritative. Story
        -- activity player_state rows can remain Offline or point at Overmap
        -- while the player is already active inside the instance.
        coalesce(fs.connected_players, 0) > 0
        or exists (
          select 1
          from dune.player_state ps
          left join dune.actors pawn
            on pawn.id = ps.player_pawn_id
          left join dune.farm_state player_fs
            on player_fs.server_id = ps.server_id
          left join dune.world_partition previous_wp
            on previous_wp.partition_id = ps.previous_server_partition_id
          where (
            ps.server_id = fs.server_id
            or pawn.partition_id = wp.partition_id
            or (
              previous_wp.server_id = fs.server_id
              and (
                coalesce(ps.server_id, '') = ''
                or player_fs.server_id is null
                or ps.server_id <> fs.server_id
              )
            )
          )
            and (
              ps.online_status <> 'Offline'
              or (
                ps.reconnect_grace_period_end is not null
                and ps.reconnect_grace_period_end > (current_timestamp at time zone 'UTC')
              )
              or (
                ps.last_avatar_activity is not null
                and ps.last_avatar_activity > (current_timestamp - make_interval(secs => ${IDLE_SECONDS}))
              )
            )
        )
      );
  "
}

container_count_for_map() {
  local map="$1"
  local safe
  safe="$(echo "$map" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')"

  docker ps --format '{{.Names}}' | grep -Ec "^dune-server-${safe}-[0-9]+$" || true
}

max_dimensions_for_map() {
  local map="$1"
  local configured

  configured="$(python3 - "$map" <<'PY'
import json
import sys
from pathlib import Path

target = sys.argv[1]
config_path = Path("runtime/generated/sietch-config.json")
if not config_path.exists():
    raise SystemExit
config = json.loads(config_path.read_text())
value = config.get("maps", {}).get(target, {}).get("max_dimensions")
if value:
    print(value)
PY
  )"

  if [ -n "$configured" ]; then
    echo "$configured"
    return 0
  fi

  if [ "$(map_uses_dedicated_scaling "$map")" = "1" ]; then
    local dynamic_default="${DUNE_DYNAMIC_INSTANCE_MAX_DIMENSIONS:-5}"
    [[ "$dynamic_default" =~ ^[1-9][0-9]*$ ]] || dynamic_default=5
    echo "$dynamic_default"
    return 0
  fi

  psql_value "
    select count(*)
    from dune.world_partition
    where lower(map) = lower('${map//\'/\'\'}');
  "
}

ensure_dynamic_instance_partitions() {
  local map="$1"
  local wanted="$2"

  [[ "$wanted" =~ ^[1-9][0-9]*$ ]] || return 1
  timeout 20 runtime/scripts/sietches.sh ensure-pool "$map" "$wanted" >/dev/null 2>&1
}

active_dimensions_for_map() {
  local map="$1"
  local configured

  configured="$(python3 - "$map" <<'PY'
import json
import sys
from pathlib import Path

target = sys.argv[1]
config_path = Path("runtime/generated/sietch-config.json")
if not config_path.exists():
    raise SystemExit
config = json.loads(config_path.read_text())
value = config.get("maps", {}).get(target, {}).get("active_dimensions")
if value:
    print(value)
PY
  )"

  if [ -n "$configured" ]; then
    echo "$configured"
    return 0
  fi

  echo "1"
}

state_key() {
  local map="$1"
  local server_id="$2"
  printf '%s|%s' "$map" "$server_id"
}

get_idle_since() {
  local key="$1"
  awk -F '\t' -v key="$key" '$1 == key { print $2; found=1; exit } END { if (!found) exit 1 }' "$STATE_FILE"
}

set_idle_since() {
  local key="$1"
  local ts="$2"
  local tmp
  tmp="$(mktemp)"

  awk -F '\t' -v key="$key" '$1 != key { print }' "$STATE_FILE" > "$tmp"
  printf '%s\t%s\n' "$key" "$ts" >> "$tmp"
  mv "$tmp" "$STATE_FILE"
}

clear_idle_since() {
  local key="$1"
  local tmp
  tmp="$(mktemp)"

  awk -F '\t' -v key="$key" '$1 != key { print }' "$STATE_FILE" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

director_heal_get() {
  local key="$1"
  awk -F '\t' -v key="$key" '$1 == key { print $2; found=1; exit } END { if (!found) exit 1 }' "$DIRECTOR_HEAL_FILE"
}

director_heal_set() {
  local key="$1"
  local value="$2"
  local tmp

  (
    flock -x 9
    tmp="$(mktemp)"
    awk -F '\t' -v key="$key" '$1 != key { print }' "$DIRECTOR_HEAL_FILE" > "$tmp"
    printf '%s\t%s\n' "$key" "$value" >> "$tmp"
    mv "$tmp" "$DIRECTOR_HEAL_FILE"
  ) 9>"${DIRECTOR_HEAL_FILE}.lock"
}

director_heal_clear() {
  local key="$1"
  local tmp

  (
    flock -x 9
    tmp="$(mktemp)"
    awk -F '\t' -v key="$key" '$1 != key { print }' "$DIRECTOR_HEAL_FILE" > "$tmp"
    mv "$tmp" "$DIRECTOR_HEAL_FILE"
  ) 9>"${DIRECTOR_HEAL_FILE}.lock"
}

# director_heal_due inlines its own set (rather than calling director_heal_set)
# because both take the same flock -- a nested flock attempt on the same lock
# file from within an already-held lock would deadlock. The check-then-set
# sequence itself must be one atomic critical section, not two separate
# locked operations. The state file is shared by the main loop and background
# followers, so concurrent callers for any key must not both read the same
# stale timestamp and claim the same due scan.
director_heal_due() {
  local key="$1"
  local interval="$2"
  local now last tmp

  (
    flock -x 9
    now="$(date +%s)"
    last="$(director_heal_get "scan:${key}" 2>/dev/null || true)"
    if [ -n "$last" ] && [ $((now - last)) -lt "$interval" ]; then
      exit 1
    fi
    tmp="$(mktemp)"
    awk -F '\t' -v key="scan:${key}" '$1 != key { print }' "$DIRECTOR_HEAL_FILE" > "$tmp"
    printf '%s\t%s\n' "scan:${key}" "$now" >> "$tmp"
    mv "$tmp" "$DIRECTOR_HEAL_FILE"
  ) 9>"${DIRECTOR_HEAL_FILE}.lock"
}

repair_chat_exchanges_due() {
  local pid

  director_heal_due chat_exchanges "$CHAT_EXCHANGE_REPAIR_SECONDS" || return 0

  if [ -f "$CHAT_EXCHANGE_REPAIR_PID_FILE" ]; then
    pid="$(cat "$CHAT_EXCHANGE_REPAIR_PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi

  (
    timeout --kill-after=5s "${CHAT_EXCHANGE_REPAIR_TIMEOUT_SECONDS}s" runtime/scripts/repair-chat-exchanges.sh >/dev/null 2>&1 || {
      echo "WARN chat exchange repair failed"
    }
    rm -f "$CHAT_EXCHANGE_REPAIR_PID_FILE"
  ) &
  printf '%s\n' "$!" >"$CHAT_EXCHANGE_REPAIR_PID_FILE"
}

dynamic_container_name_for_partition() {
  local partition_id="$1"
  local map_name safe

  map_name="$(psql_value "
    select coalesce(map, '')
    from dune.world_partition
    where partition_id = ${partition_id}
    limit 1;
  ")"
  [ -n "$map_name" ] || return 1
  case "$map_name" in
    Survival_1|Overmap) return 1 ;;
  esac
  safe="$(echo "$map_name" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')"
  docker ps --format '{{.Names}}' | grep -E "^dune-server-${safe}-${partition_id}$" | head -n1
}

dynamic_ready_desync_heal() {
  local now cooldown_until stale_since
  local rows partition_id map_name server_id ready alive container log_tail

  director_heal_due dynamic_ready "$DYNAMIC_READY_HEAL_SCAN_SECONDS" || return 0

  cooldown_until="$(director_heal_get dynamic_ready_desync 2>/dev/null || true)"
  now="$(date +%s)"
  if [ -n "$cooldown_until" ] && [ "$now" -lt "$cooldown_until" ]; then
    return 0
  fi

  rows="$(psql_value "
    select wp.partition_id, wp.map, coalesce(fs.server_id, ''), coalesce(fs.ready::text, 'f'), coalesce(fs.alive::text, 'f')
    from dune.world_partition wp
    join dune.farm_state fs on fs.server_id = wp.server_id
    where wp.partition_id not in (1, 2)
      and coalesce(fs.alive, false) = true;
  ")"

  while IFS='|' read -r partition_id map_name server_id ready alive; do
    [ -n "${partition_id:-}" ] || continue
    [[ "${ready,,}" =~ ^(f|false|0|no|n)$ ]] || continue
    [[ "${alive,,}" =~ ^(t|true|1|yes|y)$ ]] || continue

    container="$(dynamic_container_name_for_partition "$partition_id" 2>/dev/null || true)"
    [ -n "$container" ] || continue

    log_tail="$(docker logs --since 10m "$container" 2>&1 | tail -220 || true)"
    if [[ "$log_tail" != *"Server farm is READY"* ]]; then
      continue
    fi

    stale_since="$(director_heal_get "dynamic_ready:${partition_id}" 2>/dev/null || true)"
    if [ -z "$stale_since" ]; then
      director_heal_set "dynamic_ready:${partition_id}" "$now"
      continue
    fi

    if [ $((now - stale_since)) -lt "$DYNAMIC_READY_HEAL_STALE_SECONDS" ]; then
      continue
    fi

    echo "HEAL dynamic ready desync partition=${partition_id} map=${map_name} server=${server_id} action=republish"
    # A live READY signal is authoritative when farm_state.ready is stale.
    # Republish the map state without restarting Director: restarting Director
    # also restarts Survival_1 and can create a recovery loop during startup.
    publish_state_for_map "$map_name"
    director_heal_set dynamic_ready_desync $((now + DIRECTOR_HEAL_COOLDOWN_SECONDS))
    director_heal_clear "dynamic_ready:${partition_id}"
    return 0
  done <<< "$rows"

  while IFS='|' read -r partition_id map_name server_id ready alive; do
    [ -n "${partition_id:-}" ] || continue
    if [[ "${ready,,}" =~ ^(t|true|1|yes|y)$ ]] || ! [[ "${alive,,}" =~ ^(t|true|1|yes|y)$ ]]; then
      director_heal_clear "dynamic_ready:${partition_id}"
    fi
  done <<< "$rows"
}

remember_map_demand() {
  local map="$1"
  local ts="$2"
  local tmp

  [ -n "$map" ] || return 0
  (
    flock -x 9
    tmp="$(mktemp)"
    awk -F '\t' -v map="$map" '$1 != map { print }' "$DEMAND_FILE" > "$tmp"
    printf '%s\t%s\n' "$map" "$ts" >> "$tmp"
    mv "$tmp" "$DEMAND_FILE"
  ) 9>"${DEMAND_FILE}.lock"
}

forget_map_demand() {
  local map="$1"
  local tmp

  [ -n "$map" ] || return 0
  tmp="$(mktemp)"
  awk -F '\t' -v map="$map" '$1 != map { print }' "$DEMAND_FILE" > "$tmp"
  mv "$tmp" "$DEMAND_FILE"
}

recent_map_demand_age() {
  local map="$1"
  local now ts

  [ -n "$map" ] || return 1
  ts="$(awk -F '\t' -v map="$map" '$1 == map { print $2; found=1; exit } END { if (!found) exit 1 }' "$DEMAND_FILE")" || return 1
  now="$(date +%s)"
  printf '%s\n' $((now - ts))
}

map_has_recent_demand() {
  local map="$1"
  local age

  age="$(recent_map_demand_age "$map" 2>/dev/null)" || return 1
  [ "$age" -lt "$TRAVEL_GRACE_SECONDS" ]
}

demand_event_seen() {
  local event_id="$1"
  [ -n "$event_id" ] || return 1
  awk -F '\t' -v event="$event_id" '$1 == event { found=1; exit } END { exit(found ? 0 : 1) }' "$DEMAND_EVENT_FILE"
}

remember_demand_event() {
  local event_id="$1"
  local map="$2"
  local ts="$3"
  local tmp

  [ -n "$event_id" ] || return 0
  (
    flock -x 9
    tmp="$(mktemp)"
    awk -F '\t' -v now="$ts" '$3 && now - $3 < 600 { print }' "$DEMAND_EVENT_FILE" > "$tmp"
    printf '%s\t%s\t%s\n' "$event_id" "$map" "$ts" >> "$tmp"
    mv "$tmp" "$DEMAND_EVENT_FILE"
  ) 9>"${DEMAND_EVENT_FILE}.lock"
}

named_destination_source_maps() {
  printf '%s\n' \
    SH_Arrakeen \
    SH_HarkoVillage \
    Story_ProcesVerbal \
    CB_Story_DestroyedZanovar \
    CB_Story_OrbitalMonitor
}

named_destination_source_rows() {
  local map_list rows map_name partition_id server_id container

  map_list="$(named_destination_source_maps | sed "s/'/''/g; s/.*/'&'/" | paste -sd, -)"
  rows="$(psql_value "
    select wp.map || '|' || wp.partition_id || '|' || coalesce(wp.server_id, '')
    from dune.world_partition wp
    join dune.farm_state fs on fs.server_id = wp.server_id
    where wp.map in (${map_list})
      and coalesce(wp.server_id, '') <> ''
      and coalesce(fs.alive, false) = true
    order by wp.map, wp.partition_id;
  ")"

  while IFS='|' read -r map_name partition_id server_id; do
    [ -n "${map_name:-}" ] || continue
    [ -n "${partition_id:-}" ] || continue
    [ -n "${server_id:-}" ] || continue
    container="$(dynamic_container_name_for_partition "$partition_id" 2>/dev/null || true)"
    [ -n "$container" ] || continue
    printf '%s|%s|%s\n' "$map_name" "$container" "$server_id"
  done <<< "$rows"
}

hub_travel_seen() {
  local flow_id="$1"
  (
    flock -s 9
    awk -F '\t' -v flow="$flow_id" '$1 == flow { found=1; exit } END { exit(found ? 0 : 1) }' "$HUB_TRAVEL_FILE"
  ) 9>"${HUB_TRAVEL_FILE}.lock"
}

remember_hub_travel() {
  local flow_id="$1"
  local account_id="$2"
  local source_map="$3"
  local destination_map="$4"
  local ts="$5"
  local tmp cutoff

  cutoff=$((ts - HUB_TRAVEL_RETENTION_SECONDS))
  (
    flock -x 9
    tmp="$(mktemp)"
    awk -F '\t' -v flow="$flow_id" -v cutoff="$cutoff" \
      '$1 != flow && $5 ~ /^[0-9]+$/ && $5 >= cutoff { print }' "$HUB_TRAVEL_FILE" > "$tmp"
    printf '%s\t%s\t%s\t%s\t%s\n' "$flow_id" "$account_id" "$source_map" "$destination_map" "$ts" >> "$tmp"
    mv "$tmp" "$HUB_TRAVEL_FILE"
  ) 9>"${HUB_TRAVEL_FILE}.lock"
}

deepdesert_travel_seen() {
  local flow_id="$1"
  awk -F '\t' -v flow="$flow_id" '$1 == flow { found=1; exit } END { exit(found ? 0 : 1) }' "$DEEPDESERT_TRAVEL_FILE"
}

remember_deepdesert_travel() {
  local flow_id="$1"
  local player_id="$2"
  local origin_id="$3"
  local request_token="$4"
  local ts="$5"
  local last_refresh="$6"
  local target_partition="${7:-}"
  local tmp

  tmp="$(mktemp)"
  awk -F '\t' -v flow="$flow_id" '$1 != flow { print }' "$DEEPDESERT_TRAVEL_FILE" > "$tmp"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$flow_id" "$player_id" "$origin_id" "$request_token" "$ts" "$last_refresh" "$target_partition" >> "$tmp"
  mv "$tmp" "$DEEPDESERT_TRAVEL_FILE"
}

forget_deepdesert_travel() {
  local flow_id="$1"
  local tmp

  tmp="$(mktemp)"
  awk -F '\t' -v flow="$flow_id" '$1 != flow { print }' "$DEEPDESERT_TRAVEL_FILE" > "$tmp"
  mv "$tmp" "$DEEPDESERT_TRAVEL_FILE"
}

deepdesert_target_json() {
  local target_partition="${1:-}"
  local partition_clause=""
  local row

  if [ -n "$target_partition" ]; then
    [[ "$target_partition" =~ ^[0-9]+$ ]] || return 1
    partition_clause="  and wp.partition_id = $target_partition"
  fi

  row="$(dune_psql -AtF '|' -c "
select
  wp.partition_id,
  coalesce(wp.dimension_index, 0),
  coalesce(fs.game_port, 0),
  trim(leading '(' from split_part(fs.game_addr::text, ',', 1)) as game_addr,
  coalesce(fs.ready, false),
  coalesce(fs.alive, false),
  coalesce(fs.server_id, '')
from dune.world_partition wp
join dune.farm_state fs on fs.server_id = wp.server_id
where wp.map = 'DeepDesert_1'
$partition_clause
order by wp.dimension_index, wp.partition_id
limit 1;
")" || return 1
  [ -n "$row" ] || return 1

  DUNE_DEEPDESERT_TARGET_ROW="$row" python3 - <<'PY'
import json
import os

partition_id, dimension, port, ip, ready, alive, server_id = \
    os.environ["DUNE_DEEPDESERT_TARGET_ROW"].strip().split("|", 6)
print(json.dumps({
    "partition_id": int(partition_id),
    "dimension": int(dimension),
    "port": int(port),
    "ip": ip.split("/")[0],
    "ready": ready.lower() in ("t", "true", "1"),
    "alive": alive.lower() in ("t", "true", "1"),
    "server_id": server_id,
}))
PY
}

survival_partition_target_json() {
  local row

  row="$(dune_psql -AtF '|' -c "
select
  wp.partition_id,
  coalesce(wp.dimension_index, 0),
  coalesce(fs.game_port, 0),
  trim(leading '(' from split_part(fs.game_addr::text, ',', 1)) as game_addr
from dune.world_partition wp
join dune.farm_state fs on fs.server_id = wp.server_id
where wp.map = 'Survival_1'
  and fs.ready = true
  and fs.alive = true
order by wp.partition_id
limit 1;
")" || return 1
  [ -n "$row" ] || return 1

  DUNE_SURVIVAL_TARGET_ROW="$row" python3 - <<'PY'
import json
import os

partition_id, dimension, port, ip = \
    os.environ["DUNE_SURVIVAL_TARGET_ROW"].strip().split("|", 3)
print(json.dumps({
    "partition_id": int(partition_id),
    "dimension": int(dimension),
    "port": int(port),
    "ip": ip.split("/")[0],
}))
PY
}

scan_proactive_hagga_handoffs() {
  local director_log_file proactive_rows target_json

  director_heal_due proactive_hagga "$PROACTIVE_HAGGA_SCAN_SECONDS" || return 0

  target_json="$(survival_partition_target_json 2>/dev/null || true)"
  [ -n "$target_json" ] || return 0

  director_log_file="$(mktemp)"
  director_logs --since "$SINCE" > "$director_log_file" 2>/dev/null || true
  proactive_rows="$(TARGET_JSON="$target_json" LOG_FILE="$director_log_file" python3 - <<'PY'
import json
import os
import re
from datetime import datetime, timedelta, timezone

target = json.loads(os.environ["TARGET_JSON"])
log_file = os.environ["LOG_FILE"]
response_re = re.compile(r'Notified player\(s\) "([^"]+)" of travel response (SH_Arrakeen3|SH_HarkoVillage4|Overmap2): (\{.*\})')

with open(log_file, encoding="utf-8", errors="replace") as f:
    for line in f:
        match = response_re.search(line)
        if not match:
            continue
        player_id = match.group(1)
        origin_id = match.group(2)
        try:
            payload = json.loads(match.group(3))
        except json.JSONDecodeError:
            continue
        if payload.get("Code") not in (1, 8):
            continue
        if payload.get("MapName") != "Survival_1":
            continue
        flow_id = payload.get("RequestID") or ""
        if not flow_id:
            continue
        response_payload = dict(payload)
        response_payload["MapName"] = "HaggaBasin"

        grant_payload = {
            "Map": "HaggaBasin",
            "Dimension": target["dimension"],
            "PartitionId": target["partition_id"],
            "Port": target["port"],
            "Expiration": (datetime.now(timezone.utc) + timedelta(minutes=3)).isoformat().replace("+00:00", "Z"),
            "RequestToken": payload.get("QueueToken") or 0,
            "OriginId": origin_id,
            "RequestID": flow_id,
            "Players": [{"Id": player_id, "TargetDimension": target["dimension"]}],
            "Flow": 1,
            "ServerLoginToken": payload.get("ServerLoginToken") or "",
            "ReturnDimension": None,
            "Ip": target["ip"],
        }

        print("{}|{}|{}".format(
            flow_id,
            origin_id,
            json.dumps({
                "response": response_payload,
                "grant": grant_payload,
            }, separators=(",", ":"), ensure_ascii=False),
        ))
PY
  )"
  rm -f "$director_log_file"

  while IFS='|' read -r flow_id origin_id payload_json; do
    [ -n "${flow_id:-}" ] || continue
    hub_travel_seen "$flow_id" && continue

    local response_json grant_json origin_server_id
    origin_server_id="$(origin_server_id_for_origin_id "$origin_id" 2>/dev/null || true)"
    [ -n "$origin_server_id" ] || continue

    response_json="$(python3 - "$payload_json" <<'PY'
import json
import sys
payload = json.loads(sys.argv[1])
print(json.dumps(payload["response"], separators=(",", ":"), ensure_ascii=False))
PY
)"
    grant_json="$(python3 - "$payload_json" <<'PY'
import json
import sys
payload = json.loads(sys.argv[1])
print(json.dumps(payload["grant"], separators=(",", ":"), ensure_ascii=False))
PY
)"

    publish_rmq_json "heartbeats" "$origin_server_id" "$response_json" "travel-response-${flow_id}" || true
    publish_rmq_json "heartbeats" "$origin_server_id" "$grant_json" "travel-grant-${flow_id}" || true
    remember_hub_travel "$flow_id" "0" "$origin_id" "HaggaBasin" "$(date +%s)"
    echo "PROACTIVE-HAGGA flow=$flow_id origin=$origin_id server=$origin_server_id map=HaggaBasin"
  done <<< "$proactive_rows"
}

follow_director_hagga_handoffs() {
  while true; do
    python3 runtime/scripts/director-log-cache.py stream "$DIRECTOR_LOG_CACHE_FILE" --parent "$$" 2>/dev/null | TARGET_JSON="$(survival_partition_target_json 2>/dev/null || true)" python3 -u /dev/fd/3 3<<'PY' | while IFS='|' read -r flow_id origin_id payload_json; do
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone

target_json = os.environ.get("TARGET_JSON", "")
if not target_json:
    raise SystemExit(0)

target = json.loads(target_json)
response_re = re.compile(r'Notified player\(s\) "([^"]+)" of travel response (SH_Arrakeen3|SH_HarkoVillage4|Overmap2): (\{.*\})')

for line in sys.stdin:
    match = response_re.search(line)
    if not match:
        continue
    player_id = match.group(1)
    origin_id = match.group(2)
    try:
        payload = json.loads(match.group(3))
    except json.JSONDecodeError:
        continue
    if payload.get("Code") not in (1, 8):
        continue
    if payload.get("MapName") != "Survival_1":
        continue
    flow_id = payload.get("RequestID") or ""
    if not flow_id:
        continue
    response_payload = dict(payload)
    response_payload["MapName"] = "HaggaBasin"
    grant_payload = {
        "Map": "HaggaBasin",
        "Dimension": target["dimension"],
        "PartitionId": target["partition_id"],
        "Port": target["port"],
        "Expiration": (datetime.now(timezone.utc) + timedelta(minutes=3)).isoformat().replace("+00:00", "Z"),
        "RequestToken": payload.get("QueueToken") or 0,
        "OriginId": origin_id,
        "RequestID": flow_id,
        "Players": [{"Id": player_id, "TargetDimension": target["dimension"]}],
        "Flow": 1,
        "ServerLoginToken": payload.get("ServerLoginToken") or "",
        "ReturnDimension": None,
        "Ip": target["ip"],
    }
    print("{}|{}|{}".format(
        flow_id,
        origin_id,
        json.dumps({
            "response": response_payload,
            "grant": grant_payload,
        }, separators=(",", ":"), ensure_ascii=False),
    ), flush=True)
PY
      [ -n "${flow_id:-}" ] || continue
      hub_travel_seen "$flow_id" && continue

      local response_json grant_json origin_server_id
      origin_server_id="$(origin_server_id_for_origin_id "$origin_id" 2>/dev/null || true)"
      [ -n "$origin_server_id" ] || continue

      response_json="$(python3 - "$payload_json" <<'PY'
import json
import sys
payload = json.loads(sys.argv[1])
print(json.dumps(payload["response"], separators=(",", ":"), ensure_ascii=False))
PY
)"
      grant_json="$(python3 - "$payload_json" <<'PY'
import json
import sys
payload = json.loads(sys.argv[1])
print(json.dumps(payload["grant"], separators=(",", ":"), ensure_ascii=False))
PY
)"

      publish_rmq_json "heartbeats" "$origin_server_id" "$response_json" "travel-response-${flow_id}" || true
      publish_rmq_json "heartbeats" "$origin_server_id" "$grant_json" "travel-grant-${flow_id}" || true
      remember_hub_travel "$flow_id" "0" "$origin_id" "HaggaBasin" "$(date +%s)"
      echo "FOLLOW-HAGGA flow=$flow_id origin=$origin_id server=$origin_server_id map=HaggaBasin"
    done
    sleep 1
  done
}

scan_deepdesert_loading_responses() {
  local director_log_file pending_rows now

  director_heal_due deepdesert_loading "$DEEPDESERT_LOADING_SCAN_SECONDS" || return 0

  director_log_file="$(mktemp)"
  director_logs --since "$SINCE" > "$director_log_file" 2>/dev/null || true
  pending_rows="$(LOG_FILE="$director_log_file" python3 - <<'PY'
import json
import os
import re

log_file = os.environ["LOG_FILE"]
response_re = re.compile(r'Notified player\(s\) "([^"]+)" of travel response (Overmap2): (\{.*\})')

with open(log_file, encoding="utf-8", errors="replace") as f:
    for line in f:
        match = response_re.search(line)
        if not match:
            continue
        player_id = match.group(1)
        origin_id = match.group(2)
        try:
            payload = json.loads(match.group(3))
        except json.JSONDecodeError:
            continue
        if payload.get("Code") != 1:
            continue
        if payload.get("MapName") != "DeepDesert_1":
            continue
        if payload.get("ServerState") not in (0, None):
            continue
        flow_id = payload.get("RequestID") or ""
        if not flow_id:
            continue
        destination_partition = payload.get("DestinationPartitionId") or ""
        print("{}|{}|{}|{}|{}|{}".format(
            flow_id,
            player_id,
            origin_id,
            payload.get("QueueToken") or 0,
            destination_partition,
            json.dumps(payload, separators=(",", ":"), ensure_ascii=False),
        ))
PY
  )"
  rm -f "$director_log_file"

  now="$(date +%s)"
  while IFS='|' read -r flow_id player_id origin_id request_token target_partition original_response_json; do
    [ -n "${flow_id:-}" ] || continue
    deepdesert_travel_seen "$flow_id" && continue

    local origin_server_id target_json response_json
    origin_server_id="$(origin_server_id_for_origin_id "$origin_id" 2>/dev/null || true)"
    [ -n "$origin_server_id" ] || continue
    map_is_disabled "DeepDesert_1" && continue
    if [ -n "${target_partition:-}" ]; then
      target_json="$(deepdesert_target_json "$target_partition" 2>/dev/null || true)"
    else
      target_json="$(deepdesert_target_json 2>/dev/null || true)"
    fi
    if [ -z "$target_json" ] && printf '%s' "${target_partition:-}" | grep -Eq '^[0-9]+$'; then
      echo "SPAWN deepdesert-response partition=$target_partition flow=$flow_id"
      runtime/scripts/spawn-server.sh "$target_partition" || {
        echo "ERROR failed to spawn DeepDesert_1 partition=$target_partition flow=$flow_id"
        continue
      }
      target_json="$(deepdesert_target_json "$target_partition" 2>/dev/null || true)"
    fi
    if [ -z "$target_json" ] && [ -z "${target_partition:-}" ]; then
      # Older responses omit the destination. Only this response handler may
      # choose a fallback; generic map demand cannot identify the right dimension.
      runtime/scripts/spawn-server.sh DeepDesert_1 || continue
      target_json="$(deepdesert_target_json 2>/dev/null || true)"
    fi
    [ -n "$target_json" ] || continue

    response_json="$(TARGET_JSON="$target_json" RESPONSE_JSON="$original_response_json" python3 - <<'PY'
import json
import os

target = json.loads(os.environ["TARGET_JSON"])
payload = json.loads(os.environ["RESPONSE_JSON"])
payload["ServerState"] = 2
payload["DestinationPartitionId"] = target["partition_id"]
payload["BroadcastExchange"] = f"status.DeepDesert_1.dim_{target['dimension']}"
print(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))
PY
)"

    publish_rmq_json "heartbeats" "$origin_server_id" "$response_json" "travel-response-dd-${flow_id}" || true
    remember_deepdesert_travel "$flow_id" "$player_id" "$origin_id" "$request_token" "$now" "$now" "$target_partition"
    echo "DEEPDESERT-QUEUE flow=$flow_id origin=$origin_id server=$origin_server_id state=loading"
  done <<< "$pending_rows"
}

progress_deepdesert_travel_handoffs() {
  local now line flow_id player_id origin_id request_token seen_at last_refresh target_partition

  [ -s "$DEEPDESERT_TRAVEL_FILE" ] || return 0
  now="$(date +%s)"

  while IFS=$'\t' read -r flow_id player_id origin_id request_token seen_at last_refresh target_partition; do
    [ -n "${flow_id:-}" ] || continue

    local origin_server_id target_json
    origin_server_id="$(origin_server_id_for_origin_id "$origin_id" 2>/dev/null || true)"
    if [ -z "$origin_server_id" ]; then
      forget_deepdesert_travel "$flow_id"
      continue
    fi

    if [ -n "${target_partition:-}" ]; then
      target_json="$(deepdesert_target_json "$target_partition" 2>/dev/null || true)"
    else
      target_json="$(deepdesert_target_json 2>/dev/null || true)"
    fi
    [ -n "$target_json" ] || continue

    if [ $((now - seen_at)) -gt 300 ]; then
      forget_deepdesert_travel "$flow_id"
      continue
    fi

    TARGET_JSON="$target_json" FLOW_ID="$flow_id" PLAYER_ID="$player_id" ORIGIN_ID="$origin_id" REQUEST_TOKEN="$request_token" python3 - <<'PY' > /tmp/deepdesert-progress.json
import json
import os
from datetime import datetime, timedelta, timezone

target = json.loads(os.environ["TARGET_JSON"])
flow_id = os.environ["FLOW_ID"]
player_id = os.environ["PLAYER_ID"]
origin_id = os.environ["ORIGIN_ID"]
request_token = int(os.environ.get("REQUEST_TOKEN") or "0")

if target["ready"]:
    payload = {
        "grant": {
            "Map": "DeepDesert_1",
            "Dimension": target["dimension"],
            "PartitionId": target["partition_id"],
            "Port": target["port"],
            "Expiration": (datetime.now(timezone.utc) + timedelta(minutes=3)).isoformat().replace("+00:00", "Z"),
            "RequestToken": request_token,
            "OriginId": origin_id,
            "RequestID": flow_id,
            "Players": [{"Id": player_id, "TargetDimension": target["dimension"]}],
            "Flow": 1,
            "ServerLoginToken": "",
            "ReturnDimension": None,
            "Ip": target["ip"],
        }
    }
else:
    payload = {
        "response": {
            "Code": 1,
            "OriginId": origin_id,
            "RequestID": flow_id,
            "MapName": "DeepDesert_1",
            "DestinationPartitionId": target["partition_id"],
            "QueueToken": request_token,
            "QueueState": {},
            "ServerState": 2,
            "BroadcastExchange": f"status.DeepDesert_1.dim_{target['dimension']}",
            "ServerFull": False,
            "ServerLoginToken": "",
            "RetryTime": None,
        }
    }

print(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))
PY

    if TARGET_JSON="$target_json" python3 - <<'PY'
import json, os, sys
target = json.loads(os.environ["TARGET_JSON"])
sys.exit(0 if target["ready"] else 1)
PY
    then
      local grant_json
      grant_json="$(python3 - <<'PY'
import json
from pathlib import Path
print(json.dumps(json.loads(Path("/tmp/deepdesert-progress.json").read_text())["grant"], separators=(",", ":"), ensure_ascii=False))
PY
)"
      publish_rmq_json "heartbeats" "$origin_server_id" "$grant_json" "travel-grant-dd-${flow_id}" || true
      echo "DEEPDESERT-GRANT flow=$flow_id origin=$origin_id server=$origin_server_id"
      forget_deepdesert_travel "$flow_id"
    else
      if [ $((now - last_refresh)) -ge 15 ]; then
        local response_json
        response_json="$(python3 - <<'PY'
import json
from pathlib import Path
print(json.dumps(json.loads(Path("/tmp/deepdesert-progress.json").read_text())["response"], separators=(",", ":"), ensure_ascii=False))
PY
)"
        publish_rmq_json "heartbeats" "$origin_server_id" "$response_json" "travel-response-dd-${flow_id}" || true
        remember_deepdesert_travel "$flow_id" "$player_id" "$origin_id" "$request_token" "$seen_at" "$now" "$target_partition"
        echo "DEEPDESERT-QUEUE flow=$flow_id origin=$origin_id server=$origin_server_id state=loading-refresh"
      fi
    fi
  done < "$DEEPDESERT_TRAVEL_FILE"
}

named_destination_target_map() {
  case "$1" in
    Travel_To_HaggaBasin_*|Travel_To_Hagga_Basin_*)
      echo "Survival_1"
      ;;
    Story_ProcesVerbal_ApartmentMurder|Story_ProcesVerbal_BanquetMurder|Story_ProcesVerbal_BarMurder|Travel_To_Arrakeen|*_to_Arrakeen|*_To_Arrakeen)
      echo "SH_Arrakeen"
      ;;
    *)
      return 1
      ;;
  esac
}

respawn_map_for_target_map() {
  case "$1" in
    Survival_1) echo "HaggaBasin" ;;
    SH_Arrakeen) echo "Arrakeen" ;;
    SH_HarkoVillage) echo "HarkoVillage" ;;
    Overmap) echo "Overland" ;;
    DeepDesert_1) echo "DeepDesert" ;;
    *) echo "$1" ;;
  esac
}

map_effective_player_count() {
  local map="$1"
  local safe
  safe="${map//\'/\'\'}"

  psql_value "
    select count(*)
    from dune.player_state ps
    left join dune.farm_state fs on fs.server_id = ps.server_id
    left join dune.world_partition wp on wp.partition_id = ps.previous_server_partition_id
    where (
      fs.map = '$safe'
      or (
        wp.map = '$safe'
        and (
          coalesce(ps.server_id, '') = ''
          or fs.server_id is null
          or fs.map <> '$safe'
        )
      )
    )
      and (
        ps.online_status <> 'Offline'
        or (
          ps.reconnect_grace_period_end is not null
          and ps.reconnect_grace_period_end > (current_timestamp at time zone 'UTC')
        )
        or (
          ps.last_avatar_activity is not null
          and ps.last_avatar_activity > (current_timestamp - make_interval(secs => ${IDLE_SECONDS}))
        )
      );
  "
}

map_has_active_presence() {
  local map="$1"
  [ "$(map_effective_player_count "$map" | tr -d '[:space:]')" != "0" ]
}

igw_socket_sample() {
  local container="$1"
  local port="$2"
  local port_hex rx_hex drop_count total_queue=0 total_drops=0

  [[ "$port" =~ ^[0-9]+$ ]] || return 1
  port_hex="$(printf '%04X' "$port")"

  while IFS='|' read -r rx_hex drop_count; do
    [ -n "$rx_hex" ] || continue
    rx_hex="${rx_hex^^}"
    [[ "$rx_hex" =~ ^[0-9A-F]+$ ]] || continue
    [[ "$drop_count" =~ ^[0-9]+$ ]] || drop_count=0
    total_queue=$((total_queue + 16#$rx_hex))
    total_drops=$((total_drops + drop_count))
  done < <(
    igw_socket_table "$container" \
      | awk -v port="$port_hex" '
          $2 ~ (":" port "$") {
            split($5, queue, ":")
            print queue[2] "|" $NF
          }
        '
  )

  printf '%s|%s\n' "$total_queue" "$total_drops"
}

core_container_igw_port() {
  local container="$1"

  docker inspect -f '{{range .Config.Cmd}}{{println .}}{{end}}' "$container" 2>/dev/null \
    | sed -n 's/^-ini:engine:\[URL\]:IGWPort=//p' \
    | tail -1 \
    | tr -d '\r[:space:]'
}

core_map_is_reported_ready() {
  local map="$1"
  local port="$2"
  local safe="${map//\'/\'\'}"

  [ "$(psql_value "
    select count(*)
    from dune.farm_state
    where map = '$safe'
      and igw_port = $port
      and coalesce(alive, false) = true
      and coalesce(ready, false) = true;
  " | tr -d '\r[:space:]')" != "0" ]
}

clear_igw_socket_observation() {
  local map="$1"
  local key

  for key in \
    "igw-stall:${map}" \
    "igw-last-drop:${map}" \
    "igw-queue:${map}" \
    "igw-drops:${map}" \
    "igw-generation:${map}"; do
    director_heal_clear "$key"
  done
}

record_igw_socket_evidence() {
  local level="$1"
  local map="$2"
  local container="$3"
  local generation="$4"
  local port="$5"
  local queue="$6"
  local drops="$7"
  local first_seen="$8"
  local last_drop="$9"
  local message

  mkdir -p "$(dirname "$IGW_SOCKET_EVIDENCE_LOG")"
  message="$(date -u +%Y-%m-%dT%H:%M:%SZ) level=$level map=$map container=$container generation=$generation port=$port rx_queue_bytes=$queue drops=$drops first_blocked_at=${first_seen:-none} last_drop_at=${last_drop:-none}"
  printf '%s\n' "$message" >>"$IGW_SOCKET_EVIDENCE_LOG"
  printf '%s\n' "$message"
}

scan_core_igw_socket_health() {
  local now container map port sample queue drops generation saved_generation
  local first_seen last_drop previous_queue previous_drops decision age last_recovery players
  local first_key last_drop_key queue_key drops_key generation_key recovery_key deferred_key

  director_heal_due igw_socket_health "$IGW_SOCKET_HEALTH_SCAN_SECONDS" || return 0
  now="$(date +%s)"

  while IFS='|' read -r container map; do
    first_key="igw-stall:${map}"
    last_drop_key="igw-last-drop:${map}"
    queue_key="igw-queue:${map}"
    drops_key="igw-drops:${map}"
    generation_key="igw-generation:${map}"
    recovery_key="igw-recovery:${map}"
    deferred_key="igw-recovery-deferred:${map}"

    if ! docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null | grep -qx true; then
      clear_igw_socket_observation "$map"
      continue
    fi

    generation="$(docker inspect -f '{{.State.StartedAt}}' "$container" 2>/dev/null || true)"
    saved_generation="$(director_heal_get "$generation_key" 2>/dev/null || true)"
    if [ -z "$generation" ] || [ "$generation" != "$saved_generation" ]; then
      clear_igw_socket_observation "$map"
      [ -n "$generation" ] && director_heal_set "$generation_key" "$generation"
    fi

    port="$(core_container_igw_port "$container" 2>/dev/null || true)"
    if ! [[ "$port" =~ ^[0-9]+$ ]]; then
      clear_igw_socket_observation "$map"
      continue
    fi

    # A large queue is expected while a core map is still loading and cannot
    # consume normal S2S traffic yet. Only a map that has already advertised
    # itself as ready can regress into the deadlock this watchdog repairs.
    if ! core_map_is_reported_ready "$map" "$port"; then
      clear_igw_socket_observation "$map"
      continue
    fi

    sample="$(igw_socket_sample "$container" "$port" 2>/dev/null || true)"
    IFS='|' read -r queue drops <<<"$sample"
    if ! [[ "$queue" =~ ^[0-9]+$ && "$drops" =~ ^[0-9]+$ ]]; then
      clear_igw_socket_observation "$map"
      continue
    fi

    first_seen="$(director_heal_get "$first_key" 2>/dev/null || true)"
    last_drop="$(director_heal_get "$last_drop_key" 2>/dev/null || true)"
    previous_queue="$(director_heal_get "$queue_key" 2>/dev/null || true)"
    previous_drops="$(director_heal_get "$drops_key" 2>/dev/null || true)"
    IFS='|' read -r decision first_seen last_drop < <(
      igw_socket_evidence_decision \
        "$IGW_SOCKET_RX_QUEUE_THRESHOLD" \
        "$IGW_SOCKET_STALL_SECONDS" \
        "$IGW_SOCKET_DROP_GRACE_SECONDS" \
        "$now" \
        "$first_seen" \
        "$last_drop" \
        "$previous_queue" \
        "$previous_drops" \
        "$queue" \
        "$drops"
    )

    if [ "$decision" = "clear" ]; then
      clear_igw_socket_observation "$map"
      director_heal_clear "$deferred_key"
      continue
    fi

    director_heal_set "$generation_key" "$generation"
    director_heal_set "$queue_key" "$queue"
    director_heal_set "$drops_key" "$drops"
    if [[ "$first_seen" =~ ^[0-9]+$ ]]; then
      director_heal_set "$first_key" "$first_seen"
    else
      director_heal_clear "$first_key"
    fi
    if [[ "$last_drop" =~ ^[0-9]+$ ]]; then
      director_heal_set "$last_drop_key" "$last_drop"
    else
      director_heal_clear "$last_drop_key"
    fi

    if [ "$decision" = "draining" ] || [ "$decision" = "baseline" ]; then
      director_heal_clear "$deferred_key"
      continue
    fi

    age=$((now - first_seen))
    if [ "$decision" != "recover" ]; then
      continue
    fi

    last_recovery="$(director_heal_get "$recovery_key" 2>/dev/null || true)"
    if [[ "$last_recovery" =~ ^[0-9]+$ ]] && [ $((now - last_recovery)) -lt "$IGW_SOCKET_RECOVERY_COOLDOWN_SECONDS" ]; then
      continue
    fi

    players="$(battlegroup_effective_player_count 2>/dev/null | tr -d '[:space:]' || true)"
    [[ "$players" =~ ^[0-9]+$ ]] || players="unknown"
    if [ "$players" = "unknown" ] || [ "$players" -gt 0 ]; then
      if ! director_heal_get "$deferred_key" >/dev/null 2>&1; then
        record_igw_socket_evidence DEFERRED "$map" "$container" "$generation" "$port" "$queue" "$drops" "$first_seen" "$last_drop"
        echo "DEFER confirmed IGW socket deadlock map=$map port=$port rx_queue_bytes=$queue drops=$drops stalled_seconds=$age online_players=$players action=coordinated-game-farm-restart"
        director_heal_set "$deferred_key" "$now"
      fi
      continue
    fi

    # Never replace one core map beneath a live farm. Funcom peers can retain
    # the old topology, then crash in DuneWorldPartitioner when leadership is
    # recalculated. The separate coordinator survives the Autoscaler shutdown
    # performed by restart-game-farm.sh and rebuilds every world map against
    # one consistent Director/farm generation.
    if ! docker inspect -f '{{.State.Running}}' dune-coriolis-coordinator 2>/dev/null | grep -qx true; then
      record_igw_socket_evidence BLOCKED "$map" "$container" "$generation" "$port" "$queue" "$drops" "$first_seen" "$last_drop"
      echo "ERROR deadlocked core map=$map action=coordinated-game-farm-restart coordinator=unavailable"
      continue
    fi
    record_igw_socket_evidence RECOVERING "$map" "$container" "$generation" "$port" "$queue" "$drops" "$first_seen" "$last_drop"
    echo "HEAL confirmed IGW socket deadlock map=$map port=$port rx_queue_bytes=$queue drops=$drops stalled_seconds=$age online_players=0 action=coordinated-game-farm-restart"
    if ! docker exec -d dune-coriolis-coordinator bash -lc \
      'mkdir -p runtime/logs && runtime/scripts/restart-game-farm.sh igw-socket-deadlock >> runtime/logs/igw-socket-recovery.log 2>&1'; then
      echo "ERROR deadlocked core map=$map action=coordinated-game-farm-restart request=failed"
      continue
    fi
    director_heal_set "$recovery_key" "$now"
    clear_igw_socket_observation "$map"
    director_heal_clear "$deferred_key"
    return 0
  done <<'EOF'
dune-server-survival-1|Survival_1
dune-server-overmap|Overmap
EOF
}

battlegroup_effective_player_count() {
  psql_value "
    select count(*)
    from dune.player_state ps
    where
      ps.online_status <> 'Offline'
      or (
        ps.reconnect_grace_period_end is not null
        and ps.reconnect_grace_period_end > (current_timestamp at time zone 'UTC')
      )
      or (
        ps.last_avatar_activity is not null
        and ps.last_avatar_activity > (current_timestamp - make_interval(secs => ${IDLE_SECONDS}))
      );
  "
}

map_is_always_on() {
  local map="$1"
  runtime/scripts/map-modes.sh is-always-on "$map" >/dev/null 2>&1
}

map_is_overmap_active() {
  local map="$1"
  runtime/scripts/map-modes.sh is-overmap-active "$map" >/dev/null 2>&1
}

map_is_disabled() {
  local map="$1"
  runtime/scripts/map-modes.sh is-disabled "$map" >/dev/null 2>&1
}

map_is_dynamic() {
  local map="$1" mode
  mode="$(runtime/scripts/map-modes.sh mode "$map" 2>/dev/null | awk '{ print $2 }' || true)"
  [ "$mode" = "dynamic" ]
}

map_requires_fresh_process() {
  local map="$1"
  runtime/scripts/map-modes.sh requires-fresh-process "$map" >/dev/null 2>&1
}

idle_seconds_for_map() {
  local map="$1"
  if map_requires_fresh_process "$map"; then
    # Hyper-V scales this activity down once it has no players.  Keep inbound
    # travel/reconnect protection in handle_idle_row, but add no idle timer
    # after those state checks say the process is genuinely empty.
    printf '0\n'
  else
    printf '%s\n' "$IDLE_SECONDS"
  fi
}

overmap_active_maps() {
  runtime/scripts/map-modes.sh list 2>/dev/null | awk '
    /^[[:alnum:]_:-]+[[:space:]]/ && /Current:[[:space:]]+overmap-active/ {
      print $1
    }
  '
}

map_dynamic_grace_remaining() {
  local map="$1"
  DUNE_AUTOSCALER_DESPAWN_GRACE_SECONDS="$DESPAWN_GRACE_SECONDS" runtime/scripts/map-modes.sh grace-remaining "$map" 2>/dev/null || echo 0
}

reconcile_always_on_maps() {
  DUNE_HOST_MEMORY_WAIT_STATE_DIR="runtime/generated/autoscaler-memory-waits" \
    runtime/scripts/map-modes.sh reconcile || true
}

reconcile_always_on_map() {
  local map="$1"
  [ -n "$map" ] || return 0
  DUNE_HOST_MEMORY_WAIT_STATE_DIR="runtime/generated/autoscaler-memory-waits" \
    runtime/scripts/map-modes.sh reconcile "$map" || true
}

remember_server_id_map() {
  local map="$1"
  local server_id="$2"
  local tmp

  [ -n "$map" ] || return 0
  [ -n "$server_id" ] || return 0

  tmp="$(mktemp)"
  awk -F '\t' -v sid="$server_id" '$1 != sid { print }' "$SERVER_ID_MAP_FILE" > "$tmp"
  printf '%s\t%s\n' "$server_id" "$map" >> "$tmp"
  mv "$tmp" "$SERVER_ID_MAP_FILE"
}

map_for_server_id() {
  local server_id="$1"
  awk -F '\t' -v sid="$server_id" '$1 == sid { print $2; found=1; exit } END { if (!found) exit 1 }' "$SERVER_ID_MAP_FILE"
}

assigned_server_for_map() {
  local map="$1"
  local safe
  safe="$(printf '%s' "$map" | tr -cd 'A-Za-z0-9_')"

  psql_value "
    select coalesce(server_id, '')
    from dune.world_partition
    where lower(map) = lower('$safe')
      and coalesce(server_id, '') <> ''
    order by partition_id
    limit 1;
  "
}

partition_target_info() {
  local partition_id="$1"
  psql_value "
    select
      partition_id || '|' ||
      map || '|' ||
      coalesce(dimension_index::text, '0') || '|' ||
      coalesce(server_id, '')
    from dune.world_partition
    where partition_id = $partition_id
    limit 1;
  "
}

map_for_partition() {
  local partition_id="$1"
  psql_value "
    select coalesce(map, '')
    from dune.world_partition
    where partition_id = ${partition_id}
    limit 1;
  "
}

survival_fallback_target_info() {
  local home_dimension_index="$1"

  if [ -n "$home_dimension_index" ] && printf '%s' "$home_dimension_index" | grep -Eq '^[0-9]+$'; then
    psql_value "
      select
        partition_id || '|' ||
        map || '|' ||
        coalesce(dimension_index::text, '0') || '|' ||
        coalesce(server_id, '')
      from dune.world_partition
      where lower(map) = lower('Survival_1')
      order by (case when dimension_index = $home_dimension_index then 0 else 1 end), dimension_index, partition_id
      limit 1;
    "
    return 0
  fi

  psql_value "
    select
      partition_id || '|' ||
      map || '|' ||
      coalesce(dimension_index::text, '0') || '|' ||
      coalesce(server_id, '')
    from dune.world_partition
    where lower(map) = lower('Survival_1')
    order by dimension_index, partition_id
    limit 1;
  "
}

handle_demand() {
  local map="$1"
  local num="$2"
  local event_id="${3:-}"
  local demand_source="${4:-request}"
  local instancing_mode="${5:-}"
  local dedicated_scaling
  local now

  now="$(date +%s)"
  if [ -n "$event_id" ] && demand_event_seen "$event_id"; then
    return 0
  fi
  remember_map_demand "$map" "$now"

  case "$map" in
    Survival_1|Overmap)
      return 0
      ;;
  esac

  if map_is_always_on "$map"; then
    return 0
  fi

  if ! map_exists "$map"; then
    echo "WARN unknown map from Director travel queue: $map"
    return 0
  fi

  if map_is_disabled "$map"; then
    echo "SKIP demand map=$map num=$num mode=disabled"
    return 0
  fi

  local assigned
  assigned="$(map_assigned_count "$map")"

  local running
  running="$(container_count_for_map "$map")"

  if [ "$map" = "DeepDesert_1" ]; then
    # A Dimension request may target any configured Deep Desert partition.
    # Spawning by map here races the response handler and starts the first
    # unassigned dimension even when the player requested a different one.
    echo "WAIT demand map=$map num=$num target=travel-response"
    remember_demand_event "$event_id" "$map" "$now"
    return 0
  fi

  if [ -n "$event_id" ]; then
    remember_demand_event "$event_id" "$map" "$now"
  fi

  dedicated_scaling="$(map_uses_dedicated_scaling "$map")"

  if [ "$dedicated_scaling" = "1" ]; then
    # ClassicalInstancing is the Director's authoritative indication that
    # each queued party needs separate capacity. Keep the configured policy
    # fallback for recovery paths that do not originate from a travel event.
    if [ "$instancing_mode" = "ClassicalInstancing" ] || map_requires_isolated_party_dimension "$map"; then
      local occupied max_dimensions desired capacity
      occupied="$(occupied_dimensions_for_map "$map")"
      max_dimensions="$(max_dimensions_for_map "$map")"
      [[ "$occupied" =~ ^[0-9]+$ ]] || occupied=0
      [[ "$max_dimensions" =~ ^[1-9][0-9]*$ ]] || max_dimensions=1

      # Party-isolated activity maps admit one party per dimension. A new
      # request needs one dimension in addition to those already occupied;
      # a queue summary reports every solo player still waiting. Count warming
      # containers as capacity so repeated summaries cannot fill every
      # configured dimension while the requested server is starting.
      desired=$((occupied + num))
      [ "$desired" -le "$max_dimensions" ] || desired="$max_dimensions"
      if ! ensure_dynamic_instance_partitions "$map" "$desired"; then
        echo "ERROR failed to prepare instance dimensions map=$map desired=$desired"
        return 0
      fi
      capacity="$assigned"
      [ "$running" -le "$capacity" ] || capacity="$running"

      if [ "$capacity" -ge "$desired" ]; then
        echo "OK   demand map=$map num=$num source=$demand_source capacity=$capacity desired=$desired occupied=$occupied"
        return 0
      fi

      echo "SPAWN demand map=$map num=$num source=$demand_source capacity=$capacity desired=$desired occupied=$occupied"
      runtime/scripts/spawn-server.sh "$map" || {
        echo "ERROR failed to spawn $map"
        return 0
      }
      return 0
    fi

    if [ "$assigned" != "0" ] || [ "$running" != "0" ]; then
      echo "OK   demand map=$map num=$num already running/assigned assigned=$assigned containers=$running"
      return 0
    fi

    echo "SPAWN demand map=$map num=$num"
    runtime/scripts/spawn-server.sh "$map" || {
      echo "ERROR failed to spawn $map"
      return 0
    }
    return 0
  fi

  local max_dimensions
  max_dimensions="$(max_dimensions_for_map "$map")"

  if [ "$assigned" -ge "$max_dimensions" ] 2>/dev/null || [ "$running" -ge "$max_dimensions" ] 2>/dev/null; then
    echo "WAIT demand map=$map num=$num max dimensions reached max=$max_dimensions assigned=$assigned containers=$running"
    return 0
  fi

  if [ "$assigned" != "0" ] || [ "$running" != "0" ]; then
    echo "OK   demand map=$map num=$num already running/assigned assigned=$assigned containers=$running"
    return 0
  fi

  echo "SPAWN demand map=$map num=$num"
  runtime/scripts/spawn-server.sh "$map" || {
    echo "ERROR failed to spawn $map"
    return 0
  }
}

handle_idle_row() {
  local map="$1"
  local partition_id="$2"
  local server_id="$3"
  local connected_players="$4"
  local effective_players="$5"
  local ready="$6"
  local alive="$7"

  case "$map" in
    Survival_1|Overmap)
      return 0
      ;;
  esac

  local key idle_seconds
  key="$(state_key "$map" "$server_id")"
  idle_seconds="$(idle_seconds_for_map "$map")"

  # Always On maps are owned by the reconciler, not the idle lifecycle.  The
  # old path allowed the idle scanner to tear down empty Always On dimensions
  # after the grace period while the reconciler tried to put them back.
  if ! map_is_dynamic "$map" && ! map_is_overmap_active "$map"; then
    clear_idle_since "$key"
    return 0
  fi

  if [ "$connected_players" != "0" ] || [ "$effective_players" != "0" ] || ! [[ "${ready,,}" =~ ^(t|true|1|yes|y)$ ]] || ! [[ "${alive,,}" =~ ^(t|true|1|yes|y)$ ]]; then
    # Once the destination has observed its player, the inbound allocation
    # hold has served its purpose.  Clearing it here lets a later transition
    # to genuinely empty scale down immediately instead of waiting out the
    # original travel grace period.
    if map_requires_fresh_process "$map" && { [ "$connected_players" != "0" ] || [ "$effective_players" != "0" ]; }; then
      forget_map_demand "$map"
    fi
    clear_idle_since "$key"
    return 0
  fi

  if map_has_recent_demand "$map"; then
    clear_idle_since "$key"
    return 0
  fi

  local now since age
  now="$(date +%s)"

  if ! map_requires_fresh_process "$map"; then
    local remaining mode_elapsed
    remaining="$(map_dynamic_grace_remaining "$map" | tr -d '[:space:]')"
    if [ "${remaining:-0}" -gt 0 ] 2>/dev/null; then
      # Count an already-empty map's idle time from the mode change.  Clearing
      # this state here made an Always On -> Dynamic transition wait the mode
      # grace and then a second full idle grace before it could despawn.
      if ! get_idle_since "$key" >/dev/null 2>&1; then
        mode_elapsed=$((DESPAWN_GRACE_SECONDS - remaining))
        set_idle_since "$key" $((now - mode_elapsed))
      fi
      return 0
    fi
  fi

  if map_is_overmap_active "$map" && map_has_active_presence "Overmap"; then
    clear_idle_since "$key"
    return 0
  fi

  if since="$(get_idle_since "$key" 2>/dev/null)"; then
    age=$((now - since))
  else
    since="$now"
    age=0
    set_idle_since "$key" "$since"
    echo "IDLE map=$map server=$server_id players=0 effective=0 grace=${idle_seconds}s"
  fi

  if [ "$age" -ge "$idle_seconds" ]; then
    echo "DESPAWN idle map=$map server=$server_id idle=${age}s"
    runtime/scripts/despawn-server.sh "$partition_id" || true
    clear_idle_since "$key"
  fi
}

ensure_overmap_travel_maps_prewarmed() {
  local map assigned running
  local desired_active current_active needed

  if ! map_has_active_presence "Overmap"; then
    return 0
  fi

  while IFS= read -r map; do
    [ -n "${map:-}" ] || continue
    map_is_disabled "$map" && continue
    if [ "$map" = "DeepDesert_1" ]; then
      continue
    fi
    assigned="$(map_assigned_count "$map")"
    running="$(container_count_for_map "$map")"

    if [ "$assigned" != "0" ] || [ "$running" != "0" ]; then
      continue
    fi

    echo "SPAWN overmap-active map=$map source=Overmap"
    runtime/scripts/spawn-server.sh "$map" || {
      echo "ERROR failed to spawn overmap-active map=$map source=Overmap"
    }
  done < <(overmap_active_maps)

  map="DeepDesert_1"
  map_is_overmap_active "$map" || return 0
  map_is_disabled "$map" && return 0

  assigned="$(map_assigned_count "$map")"
  running="$(container_count_for_map "$map")"
  if [ "$assigned" != "0" ] || [ "$running" != "0" ]; then
    return 0
  fi

  echo "SPAWN overmap-prewarm map=$map target=single assigned=$assigned containers=$running"
  runtime/scripts/spawn-server.sh "$map" || {
    echo "ERROR failed to prewarm map=$map source=Overmap"
    return 0
  }
}

scan_named_destination_failures() {
  local source_map container source_server_id log_file handoff_rows

  director_heal_due named_destination_failures "$NAMED_DESTINATION_SCAN_SECONDS" || return 0

  while IFS='|' read -r source_map container source_server_id; do
    [ -n "${source_map:-}" ] || continue
    [ -n "${container:-}" ] || continue
    [ -n "${source_server_id:-}" ] || continue

    log_file="$(mktemp)"
    docker logs --since "$NAMED_DESTINATION_SINCE" "$container" > "$log_file" 2>&1 || true
    handoff_rows="$(SOURCE_MAP="$source_map" LOG_FILE="$log_file" python3 - <<'PY'
import os
import re

source_map = os.environ.get("SOURCE_MAP", "")
log_file = os.environ.get("LOG_FILE", "")
request_re = re.compile(r'FlowType:"Travel", Stage:"(?:Request|Update|Grant)", PlayerId:"([^"]+)", FlowId:"([A-F0-9]+)"')
failure_re = re.compile(r'UpdateTravelDestination\(([A-Za-z0-9_]+)\) unable to find destination')

flows = {}

with open(log_file, encoding="utf-8", errors="replace") as f:
  lines = list(f)

for line in lines:
    req = request_re.search(line)
    if req:
        funcom_id = req.group(1)
        flow_id = req.group(2)
        flows.setdefault(flow_id, {"funcom_id": funcom_id, "destination": ""})
        flows[flow_id]["funcom_id"] = funcom_id
    fail = failure_re.search(line)
    if fail:
        destination = fail.group(1)
        flow_ids = [value for value in re.findall(r'\[([A-F0-9]+)\]', line) if len(value) == 32]
        if flow_ids:
            flow_id = flow_ids[-1]
            flows.setdefault(flow_id, {"funcom_id": "", "destination": destination})
            flows[flow_id]["destination"] = destination

for flow_id, payload in flows.items():
    if payload.get("funcom_id") and payload.get("destination"):
        print("{}|{}|{}|{}".format(flow_id, payload["funcom_id"], source_map, payload["destination"]))
PY
    )"
    rm -f "$log_file"

    while IFS='|' read -r flow_id funcom_id source_map destination_name; do
      [ -n "${flow_id:-}" ] || continue
      hub_travel_seen "$flow_id" && continue

      local target_map account_info account_id destination_row target_partition_id target_dimension target_server_id current_map target_respawn_map
      target_map="$(named_destination_target_map "$destination_name" 2>/dev/null || true)"
      [ -n "$target_map" ] || continue

      account_info="$(psql_value "
        select a.id || '|' || coalesce(fs.map, '')
        from dune.accounts a
        left join dune.player_state ps on ps.account_id = a.id
        left join dune.farm_state fs on fs.server_id = ps.server_id
        where a.\"user\" = '${funcom_id//\'/\'\'}'
        limit 1;
      ")"
      [ -n "$account_info" ] || continue
      IFS='|' read -r account_id current_map <<< "$account_info"
      [ -n "$account_id" ] || continue

      destination_row="$(psql_value "
        select
          wp.partition_id || '|' ||
          coalesce(wp.dimension_index::text, '0') || '|' ||
          coalesce(wp.server_id, '')
        from dune.world_partition wp
        join dune.farm_state fs on fs.server_id = wp.server_id
        where wp.map = '$target_map'
          and fs.ready = true
          and fs.alive = true
        order by wp.partition_id
        limit 1;
      ")"
      if [ -z "$destination_row" ] && ! map_is_disabled "$target_map"; then
        echo "SPAWN named-destination-target source=$source_map destination=$destination_name target=$target_map"
        runtime/scripts/spawn-server.sh "$target_map" || true
        destination_row="$(psql_value "
          select
            wp.partition_id || '|' ||
            coalesce(wp.dimension_index::text, '0') || '|' ||
            coalesce(wp.server_id, '')
          from dune.world_partition wp
          join dune.farm_state fs on fs.server_id = wp.server_id
          where wp.map = '$target_map'
            and fs.ready = true
            and fs.alive = true
          order by wp.partition_id
          limit 1;
        ")"
      fi
      [ -n "$destination_row" ] || continue
      IFS='|' read -r target_partition_id target_dimension target_server_id <<< "$destination_row"
      [ -n "$target_server_id" ] || continue
      target_respawn_map="$(respawn_map_for_target_map "$target_map")"

      psql_value "
        update dune.player_state
        set
          pending_respawn_location_id = null
        where account_id = $account_id;

        update dune.player_state
        set
          server_id = '$target_server_id',
          previous_server_partition_id = $target_partition_id,
          return_dimension_index = $target_dimension
        where account_id = $account_id;

        update dune.encrypted_player_state
        set
          pending_respawn_location_id = null
        where account_id = $account_id;

        update dune.encrypted_player_state
        set
          server_id = '$target_server_id',
          previous_server_partition_id = $target_partition_id,
          return_dimension_index = $target_dimension
        where account_id = $account_id;

        do \$\$
        declare
          respawn_identity_column text;
          respawn_identity_id bigint;
        begin
          select column_name into respawn_identity_column
          from information_schema.columns
          where table_schema = 'dune'
            and table_name = 'player_respawn_locations'
            and column_name in ('character_id', 'account_id')
          order by case column_name when 'character_id' then 0 else 1 end
          limit 1;

          if respawn_identity_column = 'character_id' then
            select id into respawn_identity_id
            from dune.player_state
            where account_id = $account_id
            limit 1;
          elsif respawn_identity_column = 'account_id' then
            respawn_identity_id := $account_id;
          end if;

          if respawn_identity_column is not null and respawn_identity_id is not null then
            execute format('delete from dune.player_respawn_locations where %I = \$1 and map = ''${target_respawn_map//\'/\'\'}''', respawn_identity_column)
            using respawn_identity_id;
          end if;
        end
        \$\$;
      " >/dev/null

      timeout 20 runtime/scripts/publish-network-server-state-overrides.sh map "$target_map" >/dev/null 2>&1 || true
      replay_hagga_travel_handoff "$flow_id" "$destination_name" "$source_server_id"

      remember_hub_travel "$flow_id" "$account_id" "$source_map" "$target_map" "$(date +%s)"
      echo "NAMED-TRAVEL account=$account_id flow=$flow_id destination=$destination_name from=$source_map to=$target_map current_map=$current_map server=$target_server_id cleaned_respawns=$target_respawn_map"
    done <<< "$handoff_rows"
  done < <(named_destination_source_rows)
}

scan_rejected_story_returns() {
  local director_log_file rejected_rows completed_rows

  director_heal_due rejected_story_returns "$STORY_RETURN_RECOVERY_SCAN_SECONDS" || return 0

  director_log_file="$(mktemp)"
  director_logs --timestamps --since "$NAMED_DESTINATION_SINCE" > "$director_log_file" 2>/dev/null || true
  rejected_rows="$(LOG_FILE="$director_log_file" python3 - <<'PY'
import os
import re

log_file = os.environ["LOG_FILE"]
login_re = re.compile(
    r'Handling LoginRequest request in LoginRequest \{ RequestID = ([A-F0-9]+), '
    r'Player = Player \{ Id = ([A-F0-9]+), TargetDimension = ([0-9]+) \}'
)
refusal_re = re.compile(
    r'Player ([A-F0-9]+) requested WorldPartition \{ '
    r'PartitionId = ([0-9]+), ServerId = ([A-Za-z0-9_+\-/]+), Map = (Survival_1|Overmap), .*?'
    r'DimensionIndex = ([0-9]+), .*?\}\. Teleport not allowed, returning to WorldPartition \{ '
    r'PartitionId = ([0-9]+), ServerId = ([A-Za-z0-9_+\-/]*), '
    r'Map = (CB_Story_(?:DestroyedZanovar|OrbitalMonitor)), .*?'
    r'DimensionIndex = ([0-9]+), .*?\}, setting return dimension to ([0-9]+)\.'
)

pending_logins = {}

with open(log_file, encoding="utf-8", errors="replace") as f:
    for line in f:
        login = login_re.search(line)
        if login:
            request_id, player_id, target_dimension = login.groups()
            pending_logins[player_id] = (request_id, target_dimension)
            continue

        refusal = refusal_re.search(line)
        if not refusal:
            continue

        (
            player_id,
            target_partition,
            target_server,
            target_map,
            target_dimension,
            source_partition,
            source_server,
            source_map,
            source_dimension,
            return_dimension,
        ) = refusal.groups()
        login = pending_logins.get(player_id)
        if not login or login[1] != target_dimension or return_dimension != target_dimension:
            continue

        print("|".join((
            login[0],
            player_id,
            target_partition,
            target_server,
            target_map,
            target_dimension,
            source_partition,
            source_server,
            source_map,
            source_dimension,
        )))
PY
  )"
  rm -f "$director_log_file"

  # Completed credits maps mark the player offline before the client submits
  # its next LoginRequest. Recover during that window so the Director sees the
  # pawn in the game-owned return destination on the first request; otherwise
  # suppressing the synthetic story demand correctly prevents the loop but
  # leaves the client waiting on a queue it must cancel manually.
  #
  # The normal final-scene flow returns through Overland before the player
  # continues to Hagga. travel_return_info is authoritative when present. A
  # legacy player can be missing that row, but overmap_players still preserves
  # the exact Overland position; use that rather than inventing Survival_1 and
  # skipping the game's normal vehicle-aware Overland handoff.
  completed_rows="$(psql_value "
    select
      'COMPLETED-' || ps.account_id || '-' || source_wp.partition_id || '|' ||
      a.\"user\" || '|' ||
      target_wp.partition_id || '|' ||
      target_wp.server_id || '|' ||
      target_wp.map || '|' ||
      coalesce(target_wp.dimension_index, 0) || '|' ||
      source_wp.partition_id || '|' ||
      source_wp.server_id || '|' ||
      source_wp.map || '|' ||
      coalesce(source_wp.dimension_index, 0)
    from dune.accounts a
    join dune.player_state ps on ps.account_id = a.id
    join dune.actors pawn on pawn.id = ps.player_pawn_id
    join dune.world_partition source_wp
      on source_wp.partition_id = pawn.partition_id
     and source_wp.map in ('CB_Story_DestroyedZanovar', 'CB_Story_OrbitalMonitor')
     and coalesce(source_wp.server_id, '') <> ''
    join dune.farm_state source_fs
      on source_fs.server_id = source_wp.server_id
     and source_fs.ready = true
     and source_fs.alive = true
    join dune.journey_story_node completed_story
      on completed_story.character_id = ps.id
     and completed_story.story_node_id = case source_wp.map
       when 'CB_Story_DestroyedZanovar' then 'DA_MQ_TheGreatConventionPt3.DestroyedZanovar'
       when 'CB_Story_OrbitalMonitor' then 'DA_MQ_TheGreatConventionPt3.FourtyFears'
     end
     and completed_story.complete_condition_state = 'true'::jsonb
    left join dune.travel_return_info tri
      on tri.player_controller_id = ps.player_controller_id
    left join dune.overmap_players op
      on op.player_id = ps.player_pawn_id
    join dune.world_partition target_wp
      on dune.upgrade_map_name(target_wp.map) = dune.upgrade_map_name(
        case
          when op.player_id is not null then 'Overmap'
          else tri.map
        end
      )
     and coalesce(target_wp.dimension_index, 0) = case
       when op.player_id is not null then 0
       else coalesce(ps.return_dimension_index, 0)
     end
     and coalesce(target_wp.server_id, '') <> ''
    join dune.farm_state target_fs
      on target_fs.server_id = target_wp.server_id
     and target_fs.ready = true
     and target_fs.alive = true
    where ps.online_status = 'Offline';
  ")"
  if [ -n "$completed_rows" ]; then
    rejected_rows="${completed_rows}${rejected_rows:+$'\n'}${rejected_rows}"
  fi

  while IFS='|' read -r request_id funcom_id target_partition target_server target_map target_dimension source_partition source_server source_map _source_dimension; do
    [ -n "${request_id:-}" ] || continue
    hub_travel_seen "$request_id" && continue

    local account_id source_server_predicate initial_source_predicate official_overmap_row
    source_server_predicate="false"
    initial_source_predicate="ps.previous_server_partition_id = $source_partition"
    if [ -n "$source_server" ]; then
      source_server_predicate="ps.server_id = '$source_server'"
      initial_source_predicate="($source_server_predicate or $initial_source_predicate)"
    fi

    # A post-credits login can still name the player's last Survival target
    # even though the completed mission's normal continuation is Overland.
    # Prefer Overmap only when the exact story completion, pawn source, saved
    # Overland position, and ready destination all agree. This preserves the
    # game's Overland -> Hagga vehicle flow instead of skipping it.
    official_overmap_row="$(psql_value "
      select
        target_wp.partition_id || '|' ||
        target_wp.server_id || '|' ||
        target_wp.map || '|' ||
        coalesce(target_wp.dimension_index, 0)
      from dune.accounts a
      join dune.player_state ps on ps.account_id = a.id
      join dune.actors pawn
        on pawn.id = ps.player_pawn_id
       and pawn.partition_id = $source_partition
      join dune.world_partition source_wp
        on source_wp.partition_id = pawn.partition_id
       and source_wp.map = '$source_map'
      join dune.journey_story_node completed_story
        on completed_story.character_id = ps.id
       and completed_story.story_node_id = case source_wp.map
         when 'CB_Story_DestroyedZanovar' then 'DA_MQ_TheGreatConventionPt3.DestroyedZanovar'
         when 'CB_Story_OrbitalMonitor' then 'DA_MQ_TheGreatConventionPt3.FourtyFears'
       end
       and completed_story.complete_condition_state = 'true'::jsonb
      join dune.overmap_players op on op.player_id = ps.player_pawn_id
      join dune.world_partition target_wp on target_wp.map = 'Overmap'
      join dune.farm_state target_fs
        on target_fs.server_id = target_wp.server_id
       and target_fs.ready = true
       and target_fs.alive = true
      where a.\"user\" = '$funcom_id'
      order by target_wp.partition_id
      limit 1;
    ")"
    if [ -n "$official_overmap_row" ]; then
      IFS='|' read -r target_partition target_server target_map target_dimension <<< "$official_overmap_row"
    fi

    account_id="$(psql_value "
      select a.id
      from dune.accounts a
      join dune.player_state ps on ps.account_id = a.id
      join dune.world_partition target_wp
        on target_wp.partition_id = $target_partition
       and target_wp.server_id = '$target_server'
       and target_wp.map = '$target_map'
       and coalesce(target_wp.dimension_index, 0) = $target_dimension
      join dune.farm_state target_fs
        on target_fs.server_id = target_wp.server_id
       and target_fs.ready = true
       and target_fs.alive = true
      where a.\"user\" = '$funcom_id'
        and (ps.server_id = '$target_server' or $initial_source_predicate)
      limit 1;
    ")"
    [ -n "$account_id" ] || continue

    local recovery_result moved_row moved_account_id recovery_source traveling_actor_count traveling_vehicle_count moved_partition
    recovery_result="$(psql_value "
      set search_path to dune, public;
      with eligible as (
        select
          ps.account_id,
          ps.player_pawn_id,
          case
            when target_wp.map = 'Overmap' and op.player_id is not null then row(
              op.overmap_location,
              (pawn.transform).rotation
            )::dune.transform
            when tri.player_controller_id is not null then tri.transform
          end as return_transform,
          case
            when target_wp.map = 'Overmap' and op.player_id is not null then 'saved-overmap'
            when tri.player_controller_id is not null then 'saved-return'
          end as recovery_source,
          coalesce(op.has_polar_psu, false) as has_polar_psu,
          (
            select count(*)
            from dune.get_traveling_actor_ids(ps.player_pawn_id)
          ) as traveling_actor_count,
          (
            select count(*)
            from dune.get_traveling_actor_ids(ps.player_pawn_id) traveling(id, is_instigator, level)
            join dune.vehicles vehicle on vehicle.id = traveling.id
          ) as traveling_vehicle_count
        from dune.player_state ps
        join dune.actors pawn on pawn.id = ps.player_pawn_id
        left join dune.travel_return_info tri on tri.player_controller_id = ps.player_controller_id
        left join dune.overmap_players op on op.player_id = ps.player_pawn_id
        join dune.world_partition target_wp
          on target_wp.partition_id = $target_partition
         and target_wp.server_id = '$target_server'
         and target_wp.map = '$target_map'
         and coalesce(target_wp.dimension_index, 0) = $target_dimension
        join dune.farm_state target_fs
          on target_fs.server_id = target_wp.server_id
         and target_fs.ready = true
         and target_fs.alive = true
        where ps.account_id = $account_id
          and pawn.partition_id = $source_partition
          and (
            (
              target_wp.map = 'Overmap'
              and op.overmap_location is not null
            )
            or
            (
              tri.player_controller_id is not null
              and dune.upgrade_map_name(tri.map) = dune.upgrade_map_name(target_wp.map)
            )
          )
          and dune.is_player_offline('$funcom_id')
      )
      select eligible.account_id || '|' || eligible.recovery_source || '|' ||
        eligible.traveling_actor_count || '|' || eligible.traveling_vehicle_count || '|' ||
        coalesce(length(overmap_saved.saved::text), 0)
      from eligible
      cross join lateral (
        select coalesce(
          array_agg(moved_actor.out_id::text || ':' || moved_actor.out_actor_state),
          array[]::text[]
        ) as invalid_states
        from dune.update_traveling_actor_tree(
          eligible.player_pawn_id,
          eligible.return_transform,
          dune.upgrade_map_name('$target_map'),
          $target_dimension,
          $target_partition
        ) moved_actor
      ) travel_move
      cross join lateral (
        select case
          when '$target_map' = 'Overmap' then dune.overmap_save_player_survival_data(
            eligible.player_pawn_id,
            eligible.has_polar_psu,
            (eligible.return_transform).location
          )
          else null
        end as saved
      ) overmap_saved
      where cardinality(travel_move.invalid_states) = 0;
    ")"
    moved_row="$(tail -n 1 <<< "$recovery_result")"
    IFS='|' read -r moved_account_id recovery_source traveling_actor_count traveling_vehicle_count _overmap_saved <<< "$moved_row"
    [ "$moved_account_id" = "$account_id" ] || continue

    moved_partition="$(psql_value "
      select pawn.partition_id
      from dune.player_state ps
      join dune.actors pawn on pawn.id = ps.player_pawn_id
      where ps.account_id = $account_id
      limit 1;
    ")"
    [ "$moved_partition" = "$target_partition" ] || continue

    remember_hub_travel "$request_id" "$account_id" "$source_map" "$target_map" "$(date +%s)"
    echo "STORY-RETURN account=$account_id request=$request_id action=moved-travel-tree location=$recovery_source traveling_actors=${traveling_actor_count:-0} traveling_vehicles=${traveling_vehicle_count:-0} from=$source_map partition=$source_partition to=$target_map partition=$target_partition dimension=$target_dimension"
  done <<< "$rejected_rows"
}

# A player who logs out inside a Deep Desert dimension and returns after that dimension's idle
# server despawned is refused by the Director and queued for a partition that has no server. The
# Deep Desert travel-response handler only runs for Overmap travel flows, never for a login, and
# bare DeepDesert_1 demand deliberately never spawns, so nothing would ever start that partition
# and the client would wait forever (#1271). Print "<partition id> <player FLS id> <epoch>" for
# each DeepDesert_1 partition a Director login refusal says the player must return to, once per
# partition, using the newest refusal. The ServerId is not matched here: whether that server is
# really alive is decided against the database, which also covers a partition still bound to a
# crashed server.
# The Director log is not a trust boundary we control, so the match is anchored on the Director's
# own line prefix and the "Player <FLS id> requested WorldPartition" shape (a chat line that
# quotes the phrase does not match), every line is cut to 16 KiB first, and the text between the
# two WorldPartition blocks is bounded (a real PartitionDefinition is a few hundred characters),
# so a long or crafted line cannot stall the fast follower that runs this. A line without a
# readable timestamp counts as "now".
declare -A DEEPDESERT_LOGIN_SPAWNED_AT=()
declare -A DEEPDESERT_LOGIN_ATTEMPTED_AT=()
deepdesert_login_resume_partitions() {
  python3 -c '
import calendar
import re
import sys
import time

refusal = re.compile(
    r"^(?:(\S+) )?\[[0-9:]+ [0-9]+ [A-Z]+ Director\] "
    r"Player ([A-F0-9]+) requested WorldPartition \{.{0,8000}?\}\. "
    r"Teleport not allowed, returning to WorldPartition \{ "
    r"PartitionId = ([0-9]+), ServerId = [A-Za-z0-9_+/-]*, Map = DeepDesert_1,"
)
seen = {}
for line in sys.stdin:
    match = refusal.match(line[:16384])
    if not match:
        continue
    try:
        epoch = calendar.timegm(time.strptime(match.group(1)[:19], "%Y-%m-%dT%H:%M:%S"))
    except (TypeError, ValueError):
        epoch = int(time.time())
    partition_id = match.group(3)
    if partition_id not in seen or epoch >= seen[partition_id][1]:
        seen[partition_id] = (match.group(2), epoch)
for partition_id, (player_id, epoch) in seen.items():
    print(partition_id, player_id, epoch)
'
}

# Spawn exactly the partition the player must return to. Never the bare-map form, which picks the
# first unassigned dimension and races the travel-response handler for a different player.
#
# What actually prevents a double spawn of one partition is the per-partition flock inside
# spawn-server.sh (a second caller prints "Spawn already in progress" and exits 0); this scan
# looks at the same lock so that a spawn that is still binding (about a minute) is neither
# repeated nor mistaken for a stuck one. The database and container checks only avoid pointless
# calls. spawn-server.sh also clears a partition still bound to a dead server, so a dead binding
# counts as free here. A refusal older than this scan's own last spawn of that partition has
# already been served and is ignored, so a refusal that is still inside the log window cannot
# respawn a partition that has since idled out.
#
# The spawn runs in the background with no timeout: it waits for the server to bind (tens of
# seconds) and this runs in the fast follower, which must keep serving Survival_1/Overmap
# allocation demand. There is deliberately no kill: terminating spawn-server.sh after docker run
# but before it finishes would release the port reservation of a running container. The existing
# travel-response spawn has no timeout either.
scan_deepdesert_login_resumes() {
  local logs partitions partition_id player_id refused_at partition_state started

  director_heal_due deepdesert_login_resume 5 || return 0

  if ! logs="$(director_logs --timestamps --since 150s 2>/dev/null)"; then
    director_heal_due deepdesert_login_resume_reader 60 \
      && echo "WARN Deep Desert login resume scan could not read the Director log"
    return 0
  fi
  # Almost every pass has nothing to do: skip the parser unless a Deep Desert refusal is present.
  case "$logs" in
    *"returning to WorldPartition { PartitionId = "*"Map = DeepDesert_1,"*) ;;
    *) return 0 ;;
  esac
  # The window is a little over two cooldowns so one failed spawn is retried while the refusal is
  # still readable. A refusal missed for longer than that is recovered by the next login attempt.
  partitions="$(printf '%s\n' "$logs" | deepdesert_login_resume_partitions || true)"
  [ -n "$partitions" ] || return 0

  if map_is_disabled "DeepDesert_1"; then
    director_heal_due deepdesert_login_resume_disabled 60 \
      && echo "SKIP deepdesert-login-resume reason=map-disabled"
    return 0
  fi

  while read -r partition_id player_id refused_at; do
    [[ "$partition_id" =~ ^[0-9]+$ ]] || continue
    [[ "$refused_at" =~ ^[0-9]+$ ]] || refused_at="$(date +%s)"
    # Already served by a spawn of ours that happened after this refusal.
    if [ -n "${DEEPDESERT_LOGIN_SPAWNED_AT[$partition_id]:-}" ] \
        && [ "$refused_at" -le "${DEEPDESERT_LOGIN_SPAWNED_AT[$partition_id]}" ]; then
      continue
    fi
    # A spawn that is still running (binding takes about a minute) is not stuck and not to be
    # repeated; spawn-server.sh holds this lock for its whole run.
    deepdesert_partition_spawn_in_progress "$partition_id" && continue
    # Re-checked against the database, not the log: the log line can be minutes old. Free means
    # no server is bound, or the bound server has no live farm_state row (a crashed server).
    partition_state="$(psql_value "
      select case
        when coalesce(wp.server_id, '') = '' then 'free'
        when not exists (
          select 1 from dune.farm_state fs
          where fs.server_id = wp.server_id and coalesce(fs.alive, false)
        ) then 'free'
        else 'taken'
      end
      from dune.world_partition wp
      where wp.partition_id = ${partition_id}
        and wp.map = 'DeepDesert_1'
        and wp.blocked = false
      limit 1;
    " 2>/dev/null || true)"
    if [ "$partition_state" = "taken" ]; then
      # A successful command alone does not prove a server bound (the spawn
      # command also returns zero when another spawn owns the lock). Only
      # consume the refusal after the database confirms a live assignment.
      if [ -n "${DEEPDESERT_LOGIN_ATTEMPTED_AT[$partition_id]:-}" ]; then
        DEEPDESERT_LOGIN_SPAWNED_AT[$partition_id]="${DEEPDESERT_LOGIN_ATTEMPTED_AT[$partition_id]}"
      fi
      continue
    fi
    [ "$partition_state" = "free" ] || continue
    # With no spawn running, a container for this partition that is not bound to it is a spawn
    # that did not finish binding. Do not stack another one on top; say so, because nothing else
    # will.
    if [ -n "$(dynamic_container_name_for_partition "$partition_id" 2>/dev/null || true)" ]; then
      director_heal_due "deepdesert_login_skip_${partition_id}" 60 \
        && echo "SKIP deepdesert-login-resume partition=$partition_id reason=container-present-unbound player=$player_id"
      continue
    fi
    # One spawn attempt per partition per cooldown, even if the spawn fails.
    director_heal_due "deepdesert_login_spawn_${partition_id}" 60 || continue

    echo "SPAWN deepdesert-login-resume partition=$partition_id player=$player_id"
    started="$(date +%s)"
    DEEPDESERT_LOGIN_ATTEMPTED_AT[$partition_id]="$started"
    (
      # spawn-server.sh exits 0 for "Spawn already in progress" as well, so the exit code says
      # whether it ran to completion, not whether this call started the server.
      rc=0
      runtime/scripts/spawn-server.sh "$partition_id" || rc=$?
      if [ "$rc" -eq 0 ]; then
        echo "DONE deepdesert-login-resume partition=$partition_id rc=0 elapsed=$(( $(date +%s) - started ))s"
      else
        echo "ERROR failed to spawn DeepDesert_1 partition=$partition_id for login resume rc=$rc elapsed=$(( $(date +%s) - started ))s"
      fi
    ) &
  done <<< "$partitions"
}

# True when spawn-server.sh currently holds this partition's spawn lock. A missing lock file, or
# any failure to open it, means "not in progress" so a broken lock path can never block a spawn.
deepdesert_partition_spawn_in_progress() {
  local lock_file="runtime/generated/spawn-partition-${1}.lock" rc=0

  [ -e "$lock_file" ] || return 1
  ( exec 7>"$lock_file" || exit 2; flock -n 7 ) 2>/dev/null || rc=$?
  [ "$rc" -eq 1 ]
}

scan_idle_servers() {
  local scope="${1:-standard}"
  local map_filter

  case "$scope" in
    fresh-process) map_filter="and fs.map in ('CB_Overland_S_06', 'CB_Story_DestroyedZanovar', 'CB_Story_OrbitalMonitor')" ;;
    standard) map_filter="and fs.map not in ('CB_Overland_S_06', 'CB_Story_DestroyedZanovar', 'CB_Story_OrbitalMonitor')" ;;
    *) echo "WARN invalid idle scan scope: $scope" >&2; return 1 ;;
  esac

  dune_psql -At -F '|' -c "
    select
      fs.map,
      wp.partition_id,
      fs.server_id,
      fs.connected_players,
      coalesce(ep.effective_players, 0) as effective_players,
      fs.ready,
      fs.alive
    from dune.farm_state fs
    left join dune.world_partition wp on wp.server_id = fs.server_id
    left join lateral (
      select count(*) as effective_players
      from dune.player_state ps
      left join dune.actors pawn on pawn.id = ps.player_pawn_id
      left join dune.farm_state pfs on pfs.server_id = ps.server_id
      where (
        ps.server_id = fs.server_id
        or (
          wp.partition_id is not null
          and pawn.partition_id = wp.partition_id
        )
        or (
          wp.partition_id is not null
          and ps.previous_server_partition_id = wp.partition_id
          and (
            coalesce(ps.server_id, '') = ''
            or pfs.server_id is null
            or ps.server_id <> fs.server_id
          )
        )
      )
        and (
          ps.online_status <> 'Offline'
          or (
            ps.reconnect_grace_period_end is not null
            and ps.reconnect_grace_period_end > (current_timestamp at time zone 'UTC')
          )
          or (
            ps.last_avatar_activity is not null
            and ps.last_avatar_activity > (current_timestamp - make_interval(secs => ${IDLE_SECONDS}))
          )
        )
    ) ep on true
    where fs.map not in ('Survival_1', 'Overmap')
      $map_filter
      and coalesce(fs.server_id, '') <> ''
    order by map;
  " | while IFS='|' read -r map partition_id server_id connected_players effective_players ready alive; do
    [ -z "${map:-}" ] && continue
    [ -z "${partition_id:-}" ] && continue
    remember_server_id_map "$map" "$server_id"
    handle_idle_row "$map" "$partition_id" "$server_id" "$connected_players" "$effective_players" "$ready" "$alive"
  done
}

# Hyper-V scales short-lived activity pods independently of unrelated
# battlegroup maintenance.  Do the same for fresh-process-only Docker maps so
# neither allocation nor empty deallocation waits behind a recovery command.
follow_fresh_process_lifecycle() {
  while true; do
    scan_idle_servers fresh-process || echo "WARN fresh-process lifecycle scan failed; retrying"
    sleep "$DEMAND_INTERVAL"
  done
}

scan_reconnect_demand() {
  dune_psql -At -F '|' -c "
    select
      ps.account_id,
      coalesce(ps.server_id, ''),
      coalesce(ps.previous_server_partition_id::text, ''),
      coalesce(ps.home_dimension_index::text, '')
    from dune.player_state ps
    left join dune.farm_state fs on fs.server_id = ps.server_id
    where (
        (
          coalesce(ps.server_id, '') <> ''
          and fs.server_id is null
        )
         or (
          coalesce(ps.server_id, '') = ''
          and ps.previous_server_partition_id is not null
        )
      )
      and (
        ps.online_status <> 'Offline'
        or (
          ps.reconnect_grace_period_end is not null
          and ps.reconnect_grace_period_end > (now() at time zone 'utc')
        )
      );
  " | while IFS='|' read -r account_id stale_server_id previous_partition_id home_dimension_index; do
    local target_row target_partition_id target_map target_dimension target_server_id running fallback_row old_server_id

    [ -n "${account_id:-}" ] || continue
    old_server_id="$stale_server_id"
    target_row=""

    if [ -n "$previous_partition_id" ]; then
      target_row="$(partition_target_info "$previous_partition_id")"
    fi

    if [ -z "$target_row" ]; then
      target_row="$(survival_fallback_target_info "$home_dimension_index")"
    fi

    [ -n "$target_row" ] || continue
    IFS='|' read -r target_partition_id target_map target_dimension target_server_id <<< "$target_row"
    [ -n "$target_partition_id" ] || continue

    if [ -z "$target_server_id" ]; then
      if [ "$target_map" = "Survival_1" ] || [ "$target_map" = "Overmap" ]; then
        target_row="$(partition_target_info "$target_partition_id")"
        IFS='|' read -r target_partition_id target_map target_dimension target_server_id <<< "$target_row"
      else
        if map_is_disabled "$target_map"; then
          echo "SKIP reconnect partition=$target_partition_id map=$target_map account=$account_id mode=disabled"
          continue
        fi
        if map_is_dynamic "$target_map"; then
          echo "SKIP reconnect partition=$target_partition_id map=$target_map account=$account_id mode=dynamic"
          continue
        fi
        running="$(container_count_for_map "$target_map")"
        if [ "$running" = "0" ]; then
          echo "SPAWN reconnect partition=$target_partition_id map=$target_map account=$account_id"
          runtime/scripts/spawn-server.sh "$target_partition_id" || {
            echo "ERROR failed to spawn reconnect partition=$target_partition_id map=$target_map"
            continue
          }
        fi
        target_row="$(partition_target_info "$target_partition_id")"
        IFS='|' read -r target_partition_id target_map target_dimension target_server_id <<< "$target_row"
      fi
    fi

    [ -n "$target_server_id" ] || continue

    if [ "$target_server_id" != "$old_server_id" ] || [ "$previous_partition_id" != "$target_partition_id" ] || [ "$target_dimension" != "$home_dimension_index" ]; then
      psql_value "
        update dune.encrypted_player_state
        set
          server_id = '$target_server_id',
          previous_server_partition_id = $target_partition_id,
          return_dimension_index = $target_dimension
        where account_id = $account_id;
      " >/dev/null
      echo "REMAP reconnect account=$account_id map=$target_map partition=$target_partition_id from=${old_server_id:-<empty>} to=$target_server_id"
      remember_server_id_map "$target_map" "$target_server_id"
    fi
  done
}

scan_live_player_partition_alignment() {
  dune_psql -At -F '|' -c "
    select
      ps.account_id,
      ps.server_id,
      wp.partition_id,
      coalesce(wp.dimension_index, 0),
      coalesce(ps.previous_server_partition_id::text, '')
    from dune.player_state ps
    join dune.world_partition wp on wp.server_id = ps.server_id
    join dune.actors pawn
      on pawn.id = ps.player_pawn_id
     and pawn.partition_id = wp.partition_id
    where ps.online_status <> 'Offline'
      and coalesce(ps.server_id, '') <> ''
      and wp.map not in ('CB_Story_DestroyedZanovar', 'CB_Story_OrbitalMonitor')
      and (
        ps.previous_server_partition_id is distinct from wp.partition_id
        or ps.return_dimension_index is distinct from wp.dimension_index
      );
  " | while IFS='|' read -r account_id server_id partition_id dimension_index previous_partition_id; do
    [ -n "${account_id:-}" ] || continue
    [ -n "${server_id:-}" ] || continue
    [ -n "${partition_id:-}" ] || continue

    psql_value "
      update dune.player_state
      set
        previous_server_partition_id = $partition_id,
        return_dimension_index = $dimension_index
      where account_id = $account_id;

      update dune.encrypted_player_state
      set
        previous_server_partition_id = $partition_id,
        return_dimension_index = $dimension_index
      where account_id = $account_id;
    " >/dev/null

    echo "ALIGN live account=$account_id partition=$partition_id server=$server_id from=${previous_partition_id:-<empty>}"
  done
}

scan_travel_demand() {
  local demand_rows

  demand_rows="$(
    # Timestamps make otherwise identical player requests distinct while
    # keeping the same log occurrence stable across overlapping scan windows.
    director_logs --timestamps --since "$SINCE" 2>/dev/null | python3 -c '
import hashlib
import re
import sys

story_return_refusal_pattern = re.compile(
    r"Teleport not allowed, returning to WorldPartition \{ .*?"
    r"Map = (CB_Story_(?:DestroyedZanovar|OrbitalMonitor)),"
)

classical_pattern = re.compile(
    r"Processing travel queue for ClassicalInstancing group ([A-Za-z0-9_]+) "
    r"\(servers: \[[^\]]*\], num: ([0-9]+)\)"
)
request_pattern = re.compile(
    r"Received travel request for ([0-9]+) player\(s\) to ([A-Za-z0-9_]+) "
    r"\(instancingMode=(ClassicalInstancing|Dimension)\)"
)

seen = set()
rejected_story_demands = {}

for line in sys.stdin:
    refusal = story_return_refusal_pattern.search(line)
    if refusal:
        map_name = refusal.group(1)
        rejected_story_demands[map_name] = rejected_story_demands.get(map_name, 0) + 1
        continue

    match = classical_pattern.search(line)
    if match:
        map_name = match.group(1)
        num = int(match.group(2))
        instancing_mode = "ClassicalInstancing"
        if map_name == "DeepDesert_1":
            continue
        # Fresh-process maps are handled from their original request below.
        # Repeated queue summaries can arrive after the player is already
        # connected and must not recreate a completed inbound-travel hold.
        if map_name in {
            "CB_Overland_S_06",
            "CB_Story_DestroyedZanovar",
            "CB_Story_OrbitalMonitor",
        }:
            continue
    else:
        match = request_pattern.search(line)
        if not match:
            continue
        num = int(match.group(1))
        map_name = match.group(2)
        instancing_mode = match.group(3)

        # A login refusal for a pawn left in either credits story map is
        # immediately followed by a generic Director demand for that same
        # map. It is return traffic, not legitimate inbound story demand.
        # Starting capacity for it races the offline recovery and lets the
        # stale story grant move the pawn back after recovery reached Hagga.
        if rejected_story_demands.get(map_name, 0) > 0:
            rejected_story_demands[map_name] -= 1
            continue

    if num <= 0:
        continue

    event_id = hashlib.sha1(line.encode("utf-8", errors="replace")).hexdigest()
    key = event_id
    if key in seen:
        continue

    seen.add(key)
    source = "queue" if classical_pattern.search(line) else "request"
    print(f"{event_id}|{map_name}|{num}|{source}|{instancing_mode}")
'
  )"

  while IFS='|' read -r event_id map num demand_source instancing_mode; do
    [ -n "${map:-}" ] || continue
    handle_demand "$map" "$num" "$event_id" "$demand_source" "$instancing_mode"
  done <<< "$demand_rows"
}

# Allocation demand must not wait behind maintenance scans that may publish
# network state or run bounded recovery commands.  Hyper-V has a dedicated
# allocator watching this queue; keep the Docker equivalent independent too.
follow_director_travel_demand() {
  while true; do
    # Recover exact credits-return refusals before considering the generic
    # map demand emitted by the Director for the same login attempt.
    scan_rejected_story_returns || echo "WARN story return scan failed; retrying"
    scan_deepdesert_login_resumes || echo "WARN Deep Desert login resume scan failed; retrying"
    scan_travel_demand || echo "WARN travel demand scan failed; retrying"
    sleep "$DEMAND_INTERVAL"
  done
}

scan_igwo_unavailable_maps() {
  local rows now map event_id last_seen assigned running

  director_heal_due igwo_unavailable "$IGWO_UNAVAILABLE_SCAN_SECONDS" || return 0
  now="$(date +%s)"

  rows="$(
    director_logs --since "$NAMED_DESTINATION_SINCE" 2>/dev/null | python3 -c '
import hashlib
import re
import sys

pattern = re.compile(r"Trying to change the number of instances for map ([A-Za-z0-9_]+) but IGWO is unavailable")
seen = set()

for line in sys.stdin:
    match = pattern.search(line)
    if not match:
        continue
    map_name = match.group(1)
    event_id = hashlib.sha1(line.encode("utf-8", errors="replace")).hexdigest()
    key = (map_name, event_id)
    if key in seen:
        continue
    seen.add(key)
    print(f"{event_id}|{map_name}")
'
  )"

  while IFS='|' read -r event_id map; do
    [ -n "${map:-}" ] || continue
    demand_event_seen "igwo:${event_id}" && continue

    last_seen="$(director_heal_get "igwo:${map}" 2>/dev/null || true)"
    if [ -n "$last_seen" ] && [ $((now - last_seen)) -lt "$IGWO_UNAVAILABLE_COOLDOWN_SECONDS" ]; then
      remember_demand_event "igwo:${event_id}" "$map" "$now"
      continue
    fi

    if map_is_disabled "$map"; then
      echo "SKIP igwo-unavailable map=$map mode=disabled"
      remember_demand_event "igwo:${event_id}" "$map" "$now"
      continue
    fi

    if map_is_always_on "$map"; then
      echo "HEAL igwo-unavailable map=$map mode=always-on"
      reconcile_always_on_map "$map"
    elif map_is_overmap_active "$map" && ! map_has_active_presence "Overmap"; then
      assigned="$(map_assigned_count "$map")"
      running="$(container_count_for_map "$map")"
      echo "SKIP igwo-unavailable map=$map mode=overmap-active overmap=idle assigned=$assigned containers=$running"
      forget_map_demand "$map"
    elif map_is_dynamic "$map"; then
      assigned="$(map_assigned_count "$map")"
      running="$(container_count_for_map "$map")"
      echo "SKIP igwo-unavailable map=$map mode=dynamic assigned=$assigned containers=$running"
    else
      echo "HEAL igwo-unavailable map=$map mode=dynamic-demand"
      handle_demand "$map" 1 "igwo:${event_id}"
    fi

    publish_state_for_map "$map"
    director_heal_set "igwo:${map}" "$now"
    remember_demand_event "igwo:${event_id}" "$map" "$now"
  done <<< "$rows"
}

publish_state_for_map() {
  local map="$1"

  [ -n "$map" ] || return 0
  case "$map" in
    Survival_1)
      timeout 20 runtime/scripts/network-addresses.sh reconcile >/dev/null 2>&1 || true
      timeout 20 runtime/scripts/publish-sietch-overrides.sh once >/dev/null 2>&1 || true
      ;;
    Overmap)
      timeout 20 runtime/scripts/network-addresses.sh reconcile >/dev/null 2>&1 || true
      timeout 20 runtime/scripts/publish-network-server-state-overrides.sh restart >/dev/null 2>&1 || true
      timeout 20 runtime/scripts/publish-network-server-state-overrides.sh map "$map" >/dev/null 2>&1 || true
      ;;
    DeepDesert_1)
      timeout 20 runtime/scripts/network-addresses.sh reconcile >/dev/null 2>&1 || true
      timeout 20 runtime/scripts/publish-deepdesert-overrides.sh once >/dev/null 2>&1 || true
      timeout 20 runtime/scripts/publish-network-server-state-overrides.sh restart >/dev/null 2>&1 || true
      timeout 20 runtime/scripts/publish-network-server-state-overrides.sh map "$map" >/dev/null 2>&1 || true
      ;;
    *)
      timeout 20 runtime/scripts/network-addresses.sh reconcile >/dev/null 2>&1 || true
      timeout 20 runtime/scripts/publish-network-server-state-overrides.sh map "$map" >/dev/null 2>&1 || true
      ;;
  esac
}

supervise_sietch_override_publisher() {
  while true; do
    # Keep the filtered Survival_1 stream in the Autoscaler's PID namespace so
    # an unexpected publisher exit is noticed and restarted immediately. The
    # publisher's EXIT cleanup restores the native route during the short gap.
    runtime/scripts/publish-sietch-overrides.sh loop || true
    echo "HEAL sietch-state-publisher action=restart"
    sleep 2
  done
}

scan_stale_server_state() {
  local rows now event_id partition_id map last_seen

  director_heal_due stale_server_state "$STALE_SERVER_STATE_SCAN_SECONDS" || return 0
  now="$(date +%s)"

  rows="$(
    director_logs --since "$SINCE" 2>/dev/null | python3 -c '
import hashlib
import re
import sys

partition_pattern = re.compile(r"Failed to process travel queue for partition ([0-9]+)")
stale_pattern = re.compile(r"The last server state.s reportTimestamp is older than 60 seconds!")
pending_partition = None
seen = set()

for line in sys.stdin:
    partition_match = partition_pattern.search(line)
    if partition_match:
        pending_partition = partition_match.group(1)
        continue
    if pending_partition and stale_pattern.search(line):
        event_id = hashlib.sha1(f"{pending_partition}:{line}".encode("utf-8", errors="replace")).hexdigest()
        key = (pending_partition, event_id)
        if key not in seen:
            seen.add(key)
            print(f"{event_id}|{pending_partition}")
        pending_partition = None
'
  )"

  while IFS='|' read -r event_id partition_id; do
    [ -n "${partition_id:-}" ] || continue
    demand_event_seen "stale-state:${event_id}" && continue

    last_seen="$(director_heal_get "stale-state:${partition_id}" 2>/dev/null || true)"
    if [ -n "$last_seen" ] && [ $((now - last_seen)) -lt "$STALE_SERVER_STATE_COOLDOWN_SECONDS" ]; then
      remember_demand_event "stale-state:${event_id}" "$partition_id" "$now"
      continue
    fi

    map="$(map_for_partition "$partition_id" | tr -d '\r[:space:]')"
    [ -n "$map" ] || continue
    echo "HEAL stale-server-state partition=${partition_id} map=${map}"
    publish_state_for_map "$map"
    director_heal_set "stale-state:${partition_id}" "$now"
    remember_demand_event "stale-state:${event_id}" "$map" "$now"
  done <<< "$rows"
}

scan_unscoped_stale_server_state() {
  local count now last_seen map

  director_heal_due unscoped_stale_server_state "$STALE_SERVER_STATE_SCAN_SECONDS" || return 0
  now="$(date +%s)"

  count="$(
    director_logs --since "$SINCE" 2>/dev/null | python3 -c '
import re
import sys

stale_pattern = re.compile(r"The last server state.s reportTimestamp is older than 60 seconds!")
print(sum(1 for line in sys.stdin if stale_pattern.search(line)))
'
  )"

  [ "${count:-0}" -gt 0 ] || return 0

  last_seen="$(director_heal_get unscoped_stale_state 2>/dev/null || true)"
  if [ -n "$last_seen" ] && [ $((now - last_seen)) -lt "$STALE_SERVER_STATE_COOLDOWN_SECONDS" ]; then
    return 0
  fi

  echo "HEAL unscoped-stale-server-state occurrences=${count} maps=Survival_1,Overmap,DeepDesert_1"
  for map in Survival_1 Overmap DeepDesert_1; do
    publish_state_for_map "$map"
  done
  director_heal_set unscoped_stale_state "$now"
}

director_live_server_rows() {
  dune_psql -At -F '|' -c "
    select map, server_id
    from dune.farm_state
    where map in ('Survival_1', 'Overmap', 'DeepDesert_1')
      and ready = true
      and alive = true
      and coalesce(server_id, '') <> ''
    order by map;
  " 2>/dev/null || true
}

director_latest_capacity() {
  director_logs --since 10m 2>/dev/null \
    | python3 -c '
import json
import re
import sys

pattern = re.compile(r"Population declaration: (\{.*\})")
capacity = ""

for line in sys.stdin:
    match = pattern.search(line)
    if not match:
        continue
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError:
        continue
    capacity = str(payload.get("BattlegroupMaxPlayerCapacity", ""))

if capacity:
    print(capacity)
'
}

director_logs_contain_live_ids() {
  local rows="$1"
  local logs
  local missing=0

  # Director serializes some server ID characters as JSON Unicode escapes
  # (for example, "+" becomes "\\u002B"). Normalize those escapes before
  # comparing log text with the literal IDs stored in farm_state.
  logs="$(
    director_logs --since 10m 2>/dev/null \
      | python3 runtime/scripts/decode-log-unicode-escapes.py \
      || true
  )"
  while IFS='|' read -r map server_id; do
    [ -n "${server_id:-}" ] || continue
    if [[ "$logs" != *"$server_id"* ]]; then
      missing=1
      break
    fi
  done <<< "$rows"

  [ "$missing" -eq 0 ]
}

core_maps_ready_for_browser_heal() {
  local container partition state running started_at logs

  while IFS='|' read -r container partition; do
    state="$(docker inspect -f '{{.State.Running}}|{{.State.StartedAt}}' "$container" 2>/dev/null || true)"
    IFS='|' read -r running started_at <<<"$state"
    [ "$running" = "true" ] || return 1
    [ -n "${started_at:-}" ] || return 1

    # Docker retains logs across restarts of the same named container. Looking
    # at the unbounded tail can therefore find a READY marker from the previous
    # process and let browser healing restart Director while the replacement
    # core server is still loading. Only accept readiness emitted by the
    # container's current process generation.
    logs="$(timeout --kill-after=2s 12s docker logs --since "$started_at" --tail 5000 "$container" 2>&1 || true)"
    grep -Eq "Server farm is READY .*partition ${partition}([,[:space:]]|$)" <<<"$logs" || return 1
  done <<'EOF'
dune-server-survival-1|1
dune-server-overmap|2
EOF
}

scan_director_browser_state() {
  local rows ready_count capacity now first_seen core_ready_since last_restart age since_restart
  local republish_at republish_age online_players restart_deferred

  director_heal_due browser_state "$DIRECTOR_BROWSER_SCAN_SECONDS" || return 0

  # Missing log evidence is not proof of stale publication. In particular,
  # never let a failed/reconnecting follower trigger a disruptive farm heal.
  if ! director_logs_available; then
    director_heal_clear stale_since
    director_heal_clear browser_republish_at
    director_heal_clear browser_restart_deferred
    return 0
  fi

  # Capacity can legitimately remain zero while the core maps are still
  # registering during stack startup or after a controlled Director refresh.
  # Restarting Director in that window also restarts Survival_1, which can
  # create a self-sustaining recovery loop on memory-constrained hosts.
  if ! core_maps_ready_for_browser_heal; then
    director_heal_clear stale_since
    director_heal_clear core_ready_since
    director_heal_clear browser_republish_at
    director_heal_clear browser_restart_deferred
    return 0
  fi

  now="$(date +%s)"
  if [ $((now - AUTOSCALER_STARTED_AT)) -lt "$DIRECTOR_CORE_READY_GRACE_SECONDS" ]; then
    director_heal_clear stale_since
    director_heal_clear core_ready_since
    director_heal_clear browser_republish_at
    director_heal_clear browser_restart_deferred
    return 0
  fi
  if core_ready_since="$(director_heal_get core_ready_since 2>/dev/null)"; then
    age=$((now - core_ready_since))
  else
    director_heal_set core_ready_since "$now"
    return 0
  fi
  if [ "$age" -lt "$DIRECTOR_CORE_READY_GRACE_SECONDS" ]; then
    director_heal_clear stale_since
    director_heal_clear browser_republish_at
    director_heal_clear browser_restart_deferred
    return 0
  fi

  # Sietch reconciliation temporarily changes the live partition set while
  # Director/FLS catches up. Do not mistake that controlled publication delay
  # for stale browser state and launch a disruptive Director restart.
  if [ -f "$SIETCH_TOPOLOGY_MAINTENANCE_FILE" ]; then
    marker_mtime="$(stat -c %Y "$SIETCH_TOPOLOGY_MAINTENANCE_FILE" 2>/dev/null || printf '0')"
    marker_age=$(( $(date +%s) - marker_mtime ))
    if [ "$marker_age" -ge 0 ] && [ "$marker_age" -lt "$SIETCH_TOPOLOGY_HEAL_GRACE_SECONDS" ]; then
      director_heal_clear stale_since
      director_heal_clear browser_republish_at
      director_heal_clear browser_restart_deferred
      return 0
    fi
    rm -f "$SIETCH_TOPOLOGY_MAINTENANCE_FILE" 2>/dev/null || true
  fi

  rows="$(director_live_server_rows)"
  ready_count="$(printf '%s\n' "$rows" | sed '/^$/d' | wc -l | tr -d '[:space:]')"
  [ "${ready_count:-0}" -ge 2 ] || {
    director_heal_clear stale_since
    director_heal_clear browser_republish_at
    director_heal_clear browser_restart_deferred
    return 0
  }

  capacity="$(director_latest_capacity 2>/dev/null || true)"
  if [ "${capacity:-}" != "0" ] && director_logs_contain_live_ids "$rows"; then
    director_heal_clear stale_since
    director_heal_clear browser_republish_at
    director_heal_clear browser_restart_deferred
    director_heal_clear browser_restart_pending
    return 0
  fi

  if first_seen="$(director_heal_get stale_since 2>/dev/null)"; then
    age=$((now - first_seen))
  else
    director_heal_set stale_since "$now"
    age=0
  fi

  if [ "$age" -lt "$DIRECTOR_HEAL_STALE_SECONDS" ]; then
    return 0
  fi

  # A stale FLS/browser declaration is often recoverable by republishing the
  # authoritative state already held by the running core maps. Try that first
  # and give Director time to confirm it before recreating any container.
  # This keeps transient Funcom publication stalls invisible to connected
  # players and reserves the disruptive recovery for a confirmed failure.
  if republish_at="$(director_heal_get browser_republish_at 2>/dev/null)"; then
    republish_age=$((now - republish_at))
    if [ "$republish_age" -lt "$DIRECTOR_HEAL_REPUBLISH_GRACE_SECONDS" ]; then
      return 0
    fi
  else
    echo "HEAL director stale browser state action=republish capacity=${capacity:-unknown} ready_maps=$ready_count"
    publish_state_for_map Survival_1
    publish_state_for_map Overmap
    publish_state_for_map DeepDesert_1
    director_heal_set browser_republish_at "$now"
    return 0
  fi

  if last_restart="$(director_heal_get last_restart 2>/dev/null)"; then
    since_restart=$((now - last_restart))
    if [ "$since_restart" -lt "$DIRECTOR_HEAL_COOLDOWN_SECONDS" ]; then
      return 0
    fi
  fi

  # Restarting Director also replaces Survival_1. Never run that disruptive
  # recovery while a player is active (or while occupancy cannot be proved).
  # Republishing above remains safe to perform while players are connected;
  # the restart will be retried automatically after the battlegroup is empty.
  online_players="$(battlegroup_effective_player_count 2>/dev/null | tr -d '[:space:]' || true)"
  if ! [[ "$online_players" =~ ^[0-9]+$ ]]; then
    online_players="unknown"
  fi
  if [ "$online_players" = "unknown" ] || [ "$online_players" -gt 0 ]; then
    restart_deferred="$(director_heal_get browser_restart_deferred 2>/dev/null || true)"
    if [ -z "$restart_deferred" ]; then
      echo "DEFER director stale browser state action=restart online_players=$online_players"
      director_heal_set browser_restart_deferred "$now"
    fi
    return 0
  fi

  echo "HEAL director stale browser state action=restart capacity=${capacity:-unknown} ready_maps=$ready_count republish_age=$republish_age"
  runtime/scripts/restart-director.sh >/dev/null 2>&1 || {
    echo "ERROR failed to restart director during stale browser state heal"
    return 0
  }
  director_heal_set last_restart "$now"
  director_heal_clear stale_since
  director_heal_clear browser_republish_at
  director_heal_clear browser_restart_deferred
}

start_director_log_cache
follow_director_hagga_handoffs &
follow_director_travel_demand &
follow_fresh_process_lifecycle &
supervise_sietch_override_publisher &
reconcile_always_on_maps
repair_chat_exchanges_due

while true; do
  ensure_director_log_cache
  reconcile_always_on_maps
  scan_deepdesert_loading_responses
  ensure_overmap_travel_maps_prewarmed
  repair_chat_exchanges_due
  scan_core_igw_socket_health
  scan_igwo_unavailable_maps
  scan_stale_server_state
  scan_unscoped_stale_server_state
  progress_deepdesert_travel_handoffs
  scan_proactive_hagga_handoffs
  scan_named_destination_failures
  scan_idle_servers
  scan_reconnect_demand
  scan_live_player_partition_alignment
  dynamic_ready_desync_heal
  scan_director_browser_state
  sleep "$INTERVAL"
done
