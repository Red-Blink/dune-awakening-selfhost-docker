#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

INTERVAL="${DUNE_AUTOSCALER_INTERVAL:-5}"
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
DEEPDESERT_TRAVEL_FILE="${DUNE_AUTOSCALER_DEEPDESERT_TRAVEL_FILE:-runtime/generated/autoscaler-deepdesert-travel.tsv}"
DIRECTOR_HEAL_FILE="${DUNE_AUTOSCALER_DIRECTOR_HEAL_FILE:-runtime/generated/autoscaler-director-heal.tsv}"
DIRECTOR_HEAL_STALE_SECONDS="${DUNE_AUTOSCALER_DIRECTOR_HEAL_STALE_SECONDS:-15}"
DIRECTOR_HEAL_COOLDOWN_SECONDS="${DUNE_AUTOSCALER_DIRECTOR_HEAL_COOLDOWN_SECONDS:-300}"
DYNAMIC_READY_HEAL_STALE_SECONDS="${DUNE_AUTOSCALER_DYNAMIC_READY_HEAL_STALE_SECONDS:-20}"
DIRECTOR_BROWSER_SCAN_SECONDS="${DUNE_AUTOSCALER_DIRECTOR_BROWSER_SCAN_SECONDS:-30}"
DYNAMIC_READY_HEAL_SCAN_SECONDS="${DUNE_AUTOSCALER_DYNAMIC_READY_HEAL_SCAN_SECONDS:-30}"
CHAT_EXCHANGE_REPAIR_SECONDS="${DUNE_AUTOSCALER_CHAT_EXCHANGE_REPAIR_SECONDS:-15}"

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
echo "Log window: ${SINCE}"
echo "Named destination log window: ${NAMED_DESTINATION_SINCE}"
echo "Idle despawn grace: ${IDLE_SECONDS}s"
echo "Dynamic mode-change grace: ${DESPAWN_GRACE_SECONDS}s"
echo "Travel grace: ${TRAVEL_GRACE_SECONDS}s"
echo "Director browser heal scan: ${DIRECTOR_BROWSER_SCAN_SECONDS}s"
echo "Dynamic ready heal scan: ${DYNAMIC_READY_HEAL_SCAN_SECONDS}s"
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

psql_value() {
  docker exec dune-postgres psql -U postgres -d dune -Atc "$1"
}

hub_origin_id_for_map() {
  case "$1" in
    SH_Arrakeen) echo "SH_Arrakeen3" ;;
    SH_HarkoVillage) echo "SH_HarkoVillage4" ;;
    *) return 1 ;;
  esac
}

hub_server_id_for_origin_id() {
  case "$1" in
    SH_Arrakeen3) echo "mr2tVhMST9mp8k1NDnx49Q" ;;
    SH_HarkoVillage4)
      psql_value "
        select coalesce(server_id, '')
        from dune.farm_state
        where map = 'SH_HarkoVillage'
        limit 1;
      "
      ;;
    *) return 1 ;;
  esac
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
  local source_map="$2"
  local destination_name="$3"
  local director_log_file origin_id origin_server_id replay_rows

  case "$destination_name" in
    Travel_To_HaggaBasin_*|Travel_To_Hagga_Basin_*) ;;
    *) return 0 ;;
  esac

  origin_id="$(hub_origin_id_for_map "$source_map" 2>/dev/null || true)"
  [ -n "$origin_id" ] || return 0
  origin_server_id="$(origin_server_id_for_origin_id "$origin_id" 2>/dev/null || true)"
  [ -n "$origin_server_id" ] || return 0

  director_log_file="$(mktemp)"
  docker logs --since "$NAMED_DESTINATION_SINCE" dune-director > "$director_log_file" 2>&1 || true
  replay_rows="$(FLOW_ID="$flow_id" ORIGIN_ID="$origin_id" LOG_FILE="$director_log_file" python3 - <<'PY'
import base64
import json
import os
import re

flow_id = os.environ.get("FLOW_ID", "")
origin_id = os.environ.get("ORIGIN_ID", "")
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
            if match.group(1) != origin_id:
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

  psql_value "
    select count(*)
    from dune.world_partition
    where lower(map) = lower('${map//\'/\'\'}');
  "
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
  tmp="$(mktemp)"

  awk -F '\t' -v key="$key" '$1 != key { print }' "$DIRECTOR_HEAL_FILE" > "$tmp"
  printf '%s\t%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$DIRECTOR_HEAL_FILE"
}

director_heal_clear() {
  local key="$1"
  local tmp
  tmp="$(mktemp)"

  awk -F '\t' -v key="$key" '$1 != key { print }' "$DIRECTOR_HEAL_FILE" > "$tmp"
  mv "$tmp" "$DIRECTOR_HEAL_FILE"
}

director_heal_due() {
  local key="$1"
  local interval="$2"
  local now last

  now="$(date +%s)"
  last="$(director_heal_get "scan:${key}" 2>/dev/null || true)"
  if [ -n "$last" ] && [ $((now - last)) -lt "$interval" ]; then
    return 1
  fi
  director_heal_set "scan:${key}" "$now"
}

repair_chat_exchanges_due() {
  director_heal_due chat_exchanges "$CHAT_EXCHANGE_REPAIR_SECONDS" || return 0
  runtime/scripts/repair-chat-exchanges.sh >/dev/null 2>&1 || {
    echo "WARN chat exchange repair failed"
  }
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
    [ "$ready" = "f" ] || continue
    [ "$alive" = "t" ] || continue

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

    echo "HEAL dynamic ready desync partition=${partition_id} map=${map_name} server=${server_id}"
    if runtime/scripts/start-director.sh >/dev/null 2>&1; then
      director_heal_set dynamic_ready_desync $((now + DIRECTOR_HEAL_COOLDOWN_SECONDS))
      director_heal_clear "dynamic_ready:${partition_id}"
    else
      echo "ERROR failed to restart director during dynamic ready desync heal"
    fi
    return 0
  done <<< "$rows"

  while IFS='|' read -r partition_id map_name server_id ready alive; do
    [ -n "${partition_id:-}" ] || continue
    if [ "$ready" = "t" ] || [ "$alive" != "t" ]; then
      director_heal_clear "dynamic_ready:${partition_id}"
    fi
  done <<< "$rows"
}

remember_map_demand() {
  local map="$1"
  local ts="$2"
  local tmp

  [ -n "$map" ] || return 0
  tmp="$(mktemp)"
  awk -F '\t' -v map="$map" '$1 != map { print }' "$DEMAND_FILE" > "$tmp"
  printf '%s\t%s\n' "$map" "$ts" >> "$tmp"
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
  tmp="$(mktemp)"
  awk -F '\t' -v now="$ts" '$3 && now - $3 < 600 { print }' "$DEMAND_EVENT_FILE" > "$tmp"
  printf '%s\t%s\t%s\n' "$event_id" "$map" "$ts" >> "$tmp"
  mv "$tmp" "$DEMAND_EVENT_FILE"
}

hub_container_for_map() {
  case "$1" in
    SH_Arrakeen) echo "dune-server-sh-arrakeen-3" ;;
    SH_HarkoVillage) echo "dune-server-sh-harkovillage-4" ;;
    *) return 1 ;;
  esac
}

hub_travel_seen() {
  local flow_id="$1"
  awk -F '\t' -v flow="$flow_id" '$1 == flow { found=1; exit } END { exit(found ? 0 : 1) }' "$HUB_TRAVEL_FILE"
}

remember_hub_travel() {
  local flow_id="$1"
  local account_id="$2"
  local source_map="$3"
  local destination_map="$4"
  local ts="$5"
  local tmp

  tmp="$(mktemp)"
  awk -F '\t' -v flow="$flow_id" '$1 != flow { print }' "$HUB_TRAVEL_FILE" > "$tmp"
  printf '%s\t%s\t%s\t%s\t%s\n' "$flow_id" "$account_id" "$source_map" "$destination_map" "$ts" >> "$tmp"
  mv "$tmp" "$HUB_TRAVEL_FILE"
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
  DUNE_DEEPDESERT_TARGET_PARTITION="$target_partition" python3 - <<'PY'
import json
import os
import subprocess

target_partition = os.environ.get("DUNE_DEEPDESERT_TARGET_PARTITION", "").strip()
partition_clause = ""
if target_partition:
    try:
        partition_clause = f"  and wp.partition_id = {int(target_partition)}\n"
    except ValueError:
        raise SystemExit(1)

sql = f"""
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
{partition_clause}\
order by wp.dimension_index, wp.partition_id
limit 1;
"""
proc = subprocess.run(
    ["docker", "exec", "dune-postgres", "psql", "-U", "postgres", "-d", "dune", "-AtF", "|", "-c", sql],
    capture_output=True,
    text=True,
    check=False,
)
row = proc.stdout.strip()
if not row:
    raise SystemExit(1)
partition_id, dimension, port, ip, ready, alive, server_id = row.split("|", 6)
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
  python3 - <<'PY'
import json
import subprocess

sql = """
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
"""
proc = subprocess.run(
    ["docker", "exec", "dune-postgres", "psql", "-U", "postgres", "-d", "dune", "-AtF", "|", "-c", sql],
    capture_output=True,
    text=True,
    check=False,
)
row = proc.stdout.strip()
if not row:
    raise SystemExit(1)
partition_id, dimension, port, ip = row.split("|", 3)
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

  target_json="$(survival_partition_target_json 2>/dev/null || true)"
  [ -n "$target_json" ] || return 0

  director_log_file="$(mktemp)"
  docker logs --since "$SINCE" dune-director > "$director_log_file" 2>&1 || true
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
    docker logs -f --since 0s dune-director 2>&1 | TARGET_JSON="$(survival_partition_target_json 2>/dev/null || true)" python3 -u - <<'PY' | while IFS='|' read -r flow_id origin_id payload_json; do
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

  director_log_file="$(mktemp)"
  docker logs --since "$SINCE" dune-director > "$director_log_file" 2>&1 || true
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

    local origin_server_id target_json response_json
    origin_server_id="$(origin_server_id_for_origin_id "$origin_id" 2>/dev/null || true)"
    [ -n "$origin_server_id" ] || continue
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

    if ! deepdesert_travel_seen "$flow_id"; then
      remember_deepdesert_travel "$flow_id" "$player_id" "$origin_id" "$request_token" "$now" "$now" "$target_partition"
    else
      remember_deepdesert_travel "$flow_id" "$player_id" "$origin_id" "$request_token" "$now" "$now" "$target_partition"
    fi
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
    *)
      return 1
      ;;
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
  runtime/scripts/map-modes.sh reconcile || true
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

survival_fallback_target_info() {
  local home_dimension_index="$1"
  local row

  if [ -n "$home_dimension_index" ] && printf '%s' "$home_dimension_index" | grep -Eq '^[0-9]+$'; then
    row="$(psql_value "
      select
        partition_id || '|' ||
        map || '|' ||
        coalesce(dimension_index::text, '0') || '|' ||
        coalesce(server_id, '')
      from dune.world_partition
      where lower(map) = lower('Survival_1')
        and dimension_index = $home_dimension_index
      order by partition_id
      limit 1;
    ")"
    if [ -n "$row" ]; then
      echo "$row"
      return 0
    fi
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
    local desired_active current_active
    desired_active="$(active_dimensions_for_map "$map" | tr -d '[:space:]')"
    [ -n "$desired_active" ] || desired_active=1
    current_active="$assigned"
    if [ "${running:-0}" -gt "${current_active:-0}" ] 2>/dev/null; then
      current_active="$running"
    fi
    if [ "$current_active" -gt 0 ] 2>/dev/null; then
      echo "OK   demand map=$map num=$num target=existing assigned=$assigned containers=$running"
      remember_demand_event "$event_id" "$map" "$now"
      return 0
    fi

    echo "SPAWN demand map=$map num=$num target=single assigned=$assigned containers=$running"

    runtime/scripts/spawn-server.sh "$map" || {
      echo "ERROR failed to spawn $map"
      return 0
    }
    remember_demand_event "$event_id" "$map" "$now"
    return 0
  fi

  if [ -n "$event_id" ]; then
    remember_demand_event "$event_id" "$map" "$now"
  fi

  dedicated_scaling="$(map_uses_dedicated_scaling "$map")"

  if [ "$dedicated_scaling" = "1" ]; then
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
  local server_id="$2"
  local connected_players="$3"
  local effective_players="$4"
  local ready="$5"
  local alive="$6"

  case "$map" in
    Survival_1|Overmap)
      return 0
      ;;
  esac

  local key
  key="$(state_key "$map" "$server_id")"

  if [ "$connected_players" != "0" ] || [ "$effective_players" != "0" ] || [ "$ready" != "t" ] || [ "$alive" != "t" ]; then
    clear_idle_since "$key"
    return 0
  fi

  if map_has_recent_demand "$map"; then
    clear_idle_since "$key"
    return 0
  fi

  local remaining
  remaining="$(map_dynamic_grace_remaining "$map" | tr -d '[:space:]')"
  if [ "${remaining:-0}" -gt 0 ] 2>/dev/null; then
    clear_idle_since "$key"
    return 0
  fi

  if map_is_overmap_active "$map" && map_has_active_presence "Overmap"; then
    clear_idle_since "$key"
    return 0
  fi

  local now since age
  now="$(date +%s)"

  if since="$(get_idle_since "$key" 2>/dev/null)"; then
    age=$((now - since))
  else
    since="$now"
    age=0
    set_idle_since "$key" "$since"
    echo "IDLE map=$map server=$server_id players=0 effective=0 grace=${IDLE_SECONDS}s"
  fi

  if [ "$age" -ge "$IDLE_SECONDS" ]; then
    echo "DESPAWN idle map=$map server=$server_id idle=${age}s"
    runtime/scripts/despawn-server.sh "$map" || true
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
  local source_map container log_file handoff_rows

  for source_map in SH_Arrakeen SH_HarkoVillage; do
    container="$(hub_container_for_map "$source_map" 2>/dev/null || true)"
    [ -n "$container" ] || continue
    docker ps --format '{{.Names}}' | grep -qx "$container" || continue

    log_file="$(mktemp)"
    docker logs --since "$NAMED_DESTINATION_SINCE" "$container" > "$log_file" 2>&1 || true
    handoff_rows="$(SOURCE_MAP="$source_map" LOG_FILE="$log_file" python3 - <<'PY'
import os
import re

source_map = os.environ.get("SOURCE_MAP", "")
log_file = os.environ.get("LOG_FILE", "")
request_re = re.compile(r'FlowType:"Travel", Stage:"(?:Request|Update|Grant)", PlayerId:"([^"]+)", FlowId:"([A-F0-9]+)"')
failure_re = re.compile(r'UpdateTravelDestination\((Travel_To_[A-Za-z0-9_]+)\) unable to find destination')

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

      local target_map account_id destination_row target_partition_id target_dimension target_server_id current_map
      target_map="$(named_destination_target_map "$destination_name" 2>/dev/null || true)"
      [ -n "$target_map" ] || continue

      account_id="$(psql_value "select id from dune.accounts where \"user\" = '${funcom_id//\'/\'\'}' limit 1;")"
      [ -n "$account_id" ] || continue

      current_map="$(psql_value "
        select coalesce(fs.map, '')
        from dune.player_state ps
        left join dune.farm_state fs on fs.server_id = ps.server_id
        where ps.account_id = $account_id
        limit 1;
      ")"

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
      [ -n "$destination_row" ] || continue
      IFS='|' read -r target_partition_id target_dimension target_server_id <<< "$destination_row"
      [ -n "$target_server_id" ] || continue

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

        delete from dune.travel_return_info
        where player_controller_id in (
          select id
          from dune.actors
          where owner_account_id = $account_id
            and class = '/Game/Dune/Characters/Player/BP_DunePlayerController.BP_DunePlayerController_C'
        );

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
            execute format('delete from dune.player_respawn_locations where %I = \$1 and map = ''HaggaBasin''', respawn_identity_column)
            using respawn_identity_id;
          end if;
        end
        \$\$;
      " >/dev/null

      replay_hagga_travel_handoff "$flow_id" "$source_map" "$destination_name"

      remember_hub_travel "$flow_id" "$account_id" "$source_map" "$target_map" "$(date +%s)"
      echo "NAMED-TRAVEL account=$account_id flow=$flow_id destination=$destination_name from=$source_map to=$target_map current_map=$current_map server=$target_server_id cleaned_respawns=HaggaBasin"
    done <<< "$handoff_rows"
  done
}

scan_idle_servers() {
  docker exec dune-postgres psql -U postgres -d dune -At -F '|' -c "
    select
      fs.map,
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
      left join dune.farm_state pfs on pfs.server_id = ps.server_id
      where (
        ps.server_id = fs.server_id
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
      and coalesce(fs.server_id, '') <> ''
    order by map;
  " | while IFS='|' read -r map server_id connected_players effective_players ready alive; do
    [ -z "${map:-}" ] && continue
    remember_server_id_map "$map" "$server_id"
    handle_idle_row "$map" "$server_id" "$connected_players" "$effective_players" "$ready" "$alive"
  done
}

scan_reconnect_demand() {
  docker exec dune-postgres psql -U postgres -d dune -At -F '|' -c "
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
  docker exec dune-postgres psql -U postgres -d dune -At -F '|' -c "
    select
      ps.account_id,
      ps.server_id,
      wp.partition_id,
      coalesce(wp.dimension_index, 0),
      coalesce(ps.previous_server_partition_id::text, '')
    from dune.player_state ps
    join dune.world_partition wp on wp.server_id = ps.server_id
    where ps.online_status <> 'Offline'
      and coalesce(ps.server_id, '') <> ''
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
    docker logs --since "$SINCE" dune-director 2>&1 | python3 -c '
import hashlib
import re
import sys

classical_pattern = re.compile(
    r"Processing travel queue for ClassicalInstancing group ([A-Za-z0-9_]+) "
    r"\(servers: \[[^\]]*\], num: ([0-9]+)\)"
)
dimension_request_pattern = re.compile(
    r"Received travel request for ([0-9]+) player\(s\) to ([A-Za-z0-9_]+) "
    r"\(instancingMode=Dimension\)"
)

seen = set()

for line in sys.stdin:
    match = classical_pattern.search(line)
    if match:
        map_name = match.group(1)
        num = int(match.group(2))
        if map_name == "DeepDesert_1":
            continue
    else:
        match = dimension_request_pattern.search(line)
        if not match:
            continue
        num = int(match.group(1))
        map_name = match.group(2)

    if num <= 0:
        continue

    event_id = hashlib.sha1(line.encode("utf-8", errors="replace")).hexdigest()
    key = event_id
    if key in seen:
        continue

    seen.add(key)
    print(f"{event_id}|{map_name}|{num}")
'
  )"

  while IFS='|' read -r event_id map num; do
    [ -n "${map:-}" ] || continue
    handle_demand "$map" "$num" "$event_id"
  done <<< "$demand_rows"
}

director_live_server_rows() {
  docker exec dune-postgres psql -U postgres -d dune -At -F '|' -c "
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
  docker logs --since 10m dune-director 2>&1 \
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

  logs="$(docker logs --since 10m dune-director 2>&1 || true)"
  while IFS='|' read -r map server_id; do
    [ -n "${server_id:-}" ] || continue
    if [[ "$logs" != *"$server_id"* ]]; then
      missing=1
      break
    fi
  done <<< "$rows"

  [ "$missing" -eq 0 ]
}

scan_director_browser_state() {
  local rows ready_count capacity now first_seen last_restart age since_restart

  director_heal_due browser_state "$DIRECTOR_BROWSER_SCAN_SECONDS" || return 0

  rows="$(director_live_server_rows)"
  ready_count="$(printf '%s\n' "$rows" | sed '/^$/d' | wc -l | tr -d '[:space:]')"
  [ "${ready_count:-0}" -ge 2 ] || {
    director_heal_clear stale_since
    return 0
  }

  capacity="$(director_latest_capacity 2>/dev/null || true)"
  now="$(date +%s)"

  if [ "${capacity:-}" != "0" ] && director_logs_contain_live_ids "$rows"; then
    director_heal_clear stale_since
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

  if last_restart="$(director_heal_get last_restart 2>/dev/null)"; then
    since_restart=$((now - last_restart))
    if [ "$since_restart" -lt "$DIRECTOR_HEAL_COOLDOWN_SECONDS" ]; then
      return 0
    fi
  fi

  echo "HEAL director stale browser state capacity=${capacity:-unknown} ready_maps=$ready_count"
  runtime/scripts/start-director.sh >/dev/null 2>&1 || {
    echo "ERROR failed to restart director during stale browser state heal"
    return 0
  }
  director_heal_set last_restart "$now"
  director_heal_clear stale_since
}

follow_director_hagga_handoffs &
reconcile_always_on_maps
repair_chat_exchanges_due

while true; do
  reconcile_always_on_maps
  repair_chat_exchanges_due
  scan_deepdesert_loading_responses
  ensure_overmap_travel_maps_prewarmed
  scan_travel_demand
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
