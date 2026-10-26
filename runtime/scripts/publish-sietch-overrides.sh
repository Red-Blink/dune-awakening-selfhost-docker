#!/usr/bin/env bash
set -euo pipefail

# These publishers import usersettings.py and may run from root-owned systemd
# services. Never leave interpreter caches inside the operator's checkout.
export PYTHONDONTWRITEBYTECODE="${PYTHONDONTWRITEBYTECODE:-1}"

cd "$(dirname "$0")/../.."

# POSTGRES_PORT and DUNE_PSQL_TRANSPORT from here configure the Postgres seam.
# Exported because this script's snapshot queries run in embedded Python, which
# reads them from its environment; a bare `. ./.env` would keep them invisible
# to any child process.
[ -f .env ] && . ./.env
export POSTGRES_PORT DUNE_PSQL_TRANSPORT

source runtime/scripts/host-file-ownership.sh
source runtime/scripts/farm-readiness.sh

# shellcheck source=runtime/scripts/lib/postgres.sh
source runtime/scripts/lib/postgres.sh
# shellcheck source=runtime/scripts/lib/rabbitmq.sh
source runtime/scripts/lib/rabbitmq.sh

PID_FILE="runtime/generated/sietch-overrides.pid"
LOOP_TOKEN_FILE="runtime/generated/sietch-overrides.loop-token"
LOG_FILE="runtime/generated/sietch-overrides.log"
LOG_POINTER_FILE="runtime/generated/sietch-overrides-current.log"
PUBLICATION_STATE_FILE="runtime/generated/sietch-publication-state.json"
TEXT_ROUTER_LOG="runtime/text-router/director-current.log"
RMQ_CREDS_FILE="runtime/generated/sietch-rmq-admin-creds"
SHARED_RMQ_CREDS_FILES=("runtime/generated/deepdesert-rmq-admin-creds")
TIMESTAMP_LEAD_SECONDS="${DUNE_SIETCH_OVERRIDE_TIMESTAMP_LEAD_SECONDS:-0}"
RMQ_TIMEOUT_SECONDS="${DUNE_SIETCH_OVERRIDE_RMQ_TIMEOUT_SECONDS:-8}"
RMQ_BINDING_CLEANUP_TIMEOUT_SECONDS="${DUNE_SIETCH_OVERRIDE_BINDING_CLEANUP_TIMEOUT_SECONDS:-2}"
FORWARD_POLL_SECONDS="${DUNE_SIETCH_OVERRIDE_FORWARD_POLL_SECONDS:-5}"
ROUTE_REFRESH_SECONDS="${DUNE_SIETCH_OVERRIDE_ROUTE_REFRESH_SECONDS:-300}"
SNAPSHOT_REFRESH_SECONDS="${DUNE_SIETCH_OVERRIDE_SNAPSHOT_REFRESH_SECONDS:-10}"
SPICEFIELD_RECONCILE_SECONDS="${DUNE_SIETCH_SPICEFIELD_RECONCILE_SECONDS:-60}"
CREDENTIAL_LOG_TAIL_LINES="${DUNE_SIETCH_OVERRIDE_CREDENTIAL_LOG_TAIL_LINES:-20000}"
DOCKER_LOG_TIMEOUT_SECONDS="${DUNE_SIETCH_OVERRIDE_DOCKER_LOG_TIMEOUT_SECONDS:-12}"

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

write_loop_token() {
  local token="$1"
  local tmp

  mkdir -p "$(dirname "$LOOP_TOKEN_FILE")"
  tmp="$(mktemp "$(dirname "$LOOP_TOKEN_FILE")/.sietch-overrides.loop-token.tmp.XXXXXX")"
  printf '%s\n' "$token" >"$tmp"
  chmod 664 "$tmp" 2>/dev/null || true
  dune_set_host_path_owner "$tmp"
  mv -f "$tmp" "$LOOP_TOKEN_FILE"
}

loop_token_is_current() {
  local token="$1"
  [ -r "$LOOP_TOKEN_FILE" ] && [ "$(cat "$LOOP_TOKEN_FILE" 2>/dev/null || true)" = "$token" ]
}

invalidate_loop_token() {
  write_loop_token "stopped-$(date +%s)-$$"
}

stop_loop_processes() {
  local pid
  invalidate_loop_token
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
  dune_set_host_path_owner "$PID_FILE"
}

clear_stale_pidfile() {
  [ -f "$PID_FILE" ] || return 0
  local pid visible_pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    # The loop may have been started from inside the Autoscaler container,
    # whose PID namespace differs from the host. Prefer the process visible
    # to this caller instead of deleting otherwise-valid ownership state.
    visible_pid="$(loop_pids | head -n 1)"
    if [ -n "$visible_pid" ]; then
      printf '%s\n' "$visible_pid" >"$PID_FILE"
      dune_set_host_path_owner "$PID_FILE"
    else
      rm -f "$PID_FILE"
    fi
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
  dune_set_host_path_owner "$current_log"

  LOG_FILE="$current_log"
  if [ -e "$LOG_POINTER_FILE" ] && [ ! -w "$LOG_POINTER_FILE" ]; then
    rm -f "$LOG_POINTER_FILE" 2>/dev/null || true
  fi
  printf '%s\n' "$LOG_FILE" >"$LOG_POINTER_FILE" 2>/dev/null || true
  dune_set_host_path_owner "$LOG_POINTER_FILE"
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
  dune_set_host_path_owner "$TEXT_ROUTER_LOG"
}

load_rmq_admin_creds() {
  local allow_shared="${1:-true}"
  local creds cache_tmp line_count shared_creds_file
  if [ -r "$RMQ_CREDS_FILE" ]; then
    line_count="$(wc -l < "$RMQ_CREDS_FILE" 2>/dev/null || printf '0')"
    line_count="$(printf '%s' "$line_count" | tr -cd '[:digit:]')"
    line_count="${line_count:-0}"
    if [ "$line_count" -ge 2 ]; then
      cat "$RMQ_CREDS_FILE"
      return 0
    fi
  fi

  # All state publishers use the same battlegroup administrator. Reuse a
  # credential cache already validated by a sibling publisher before parsing
  # historical logs, whose newest credential line may no longer be active.
  if [ "$allow_shared" = "true" ]; then
    for shared_creds_file in "${SHARED_RMQ_CREDS_FILES[@]}"; do
      [ -r "$shared_creds_file" ] || continue
      line_count="$(wc -l < "$shared_creds_file" 2>/dev/null || printf '0')"
      line_count="$(printf '%s' "$line_count" | tr -cd '[:digit:]')"
      if [ "${line_count:-0}" -ge 2 ]; then
        cat "$shared_creds_file"
        return 0
      fi
    done
  fi

  ensure_text_router_log
  creds="$(CREDENTIAL_LOG_TAIL_LINES="$CREDENTIAL_LOG_TAIL_LINES" DOCKER_LOG_TIMEOUT_SECONDS="$DOCKER_LOG_TIMEOUT_SECONDS" python3 - <<'PY'
from pathlib import Path
import os
import re
import subprocess
import sys

log_path = Path("runtime/text-router/director-current.log")
patterns = [
    re.compile(r'Generated new admin credentials:\s*(bgd\.[^/\s]+\.admin)\s*/\s*([A-Za-z0-9+/=]+)'),
    re.compile(r'(bgd\.[^/\s]+\.admin)/([A-Za-z0-9+/=]+) => allow administrator'),
]
text = ""
log_tail_lines = max(1, int(os.environ.get("CREDENTIAL_LOG_TAIL_LINES", "20000")))
docker_log_timeout = max(1, int(os.environ.get("DOCKER_LOG_TIMEOUT_SECONDS", "12")))
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
                    ["docker", "logs", "--tail", str(log_tail_lines), container],
                    text=True,
                    stderr=subprocess.STDOUT,
                    timeout=docker_log_timeout,
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
  cache_tmp="${RMQ_CREDS_FILE}.tmp.$$"
  if { printf '%s\n' "$creds" >"$cache_tmp" \
      && chmod 600 "$cache_tmp" \
      && dune_set_host_path_owner "$cache_tmp" \
      && mv -f "$cache_tmp" "$RMQ_CREDS_FILE"; } 2>/dev/null; then
    :
  else
    rm -f "$cache_tmp" 2>/dev/null || true
  fi
  printf '%s\n' "$creds"
}

rmq_admin() {
  local rmq_user rmq_password rc allow_shared=true
  for _ in 1 2; do
    mapfile -t rmq_creds < <(load_rmq_admin_creds "$allow_shared")
    [ "${#rmq_creds[@]}" -ge 2 ] || return 1
    rmq_user="${rmq_creds[0]}"
    rmq_password="${rmq_creds[1]}"
    # The verbs on the hot paths go straight to the management API that
    # rabbitmqadmin would have called anyway; lib/rabbitmq.sh returns
    # RMQ_HTTP_UNSUPPORTED for the rest, which falls through to the exec below.
    # Either way a real failure retries once with freshly read credentials.
    # rc is captured rather than left to propagate: under `set -e` a plain
    # failure here -- a 401 from stale credentials, which is routine, since
    # these are scraped from rotating director logs -- would kill the caller
    # before either the credential refresh below or the exec fallback could
    # run. publish_payload calls this bare from a `while read` loop, so that
    # abort took the whole publisher down.
    rc=0
    dune_rmq_http_try "$rmq_user" "$rmq_password" "$@" || rc=$?
    if [ "$rc" -ne "$RMQ_HTTP_UNSUPPORTED" ]; then
      if [ "$rc" -eq 0 ]; then
        return 0
      fi
    elif timeout --kill-after=2s "${RMQ_TIMEOUT_SECONDS}s" docker exec dune-rmq-admin rabbitmqadmin -q -u "$rmq_user" -p "$rmq_password" "$@"; then
      return 0
    else
      rc=$?
    fi
    rm -f "$RMQ_CREDS_FILE"
    allow_shared=false
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
  local purge_existing="${1:-false}"

  rmq_admin declare exchange name="$FILTER_EXCHANGE" type=direct durable=true >/dev/null || return 1
  rmq_admin declare queue name="$SOURCE_FILTER_QUEUE" durable=true >/dev/null || return 1
  if [ "$purge_existing" = "true" ]; then
    rmq_admin purge queue name="$SOURCE_FILTER_QUEUE" >/dev/null || return 1
  fi
  rmq_admin declare binding \
    source="$SOURCE_EXCHANGE" \
    destination="$SOURCE_FILTER_QUEUE" \
    destination_type=queue \
    routing_key="$SOURCE_ROUTING_KEY" >/dev/null || return 1
  rmq_admin declare binding \
    source="$FILTER_EXCHANGE" \
    destination="$SINK_QUEUE" \
    destination_type=queue \
    routing_key="$SOURCE_ROUTING_KEY" >/dev/null || return 1
  # Cleanup is bounded separately so a slow rabbitmqctl cannot hold up state
  # forwarding. The next refresh will retry if the direct binding remains.
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

publish_payload() (
  local payload="$1" source="${2:-native}" prepared
  # One-shot repairs and the loop may overlap. Serialize the actual send with
  # its metadata update, not just the earlier snapshot/batch construction.
  umask 077
  mkdir -p "$(dirname "$PUBLICATION_STATE_FILE")" || return 1
  exec {publication_lock}>"${PUBLICATION_STATE_FILE}.lock" || return 1
  dune_set_host_path_owner "${PUBLICATION_STATE_FILE}.lock"
  flock -x "$publication_lock" || return 1
  prepared="$(python3 runtime/scripts/sietch_publication.py prepare "$PUBLICATION_STATE_FILE" "$source" <<<"$payload")" || return 1
  [ -n "$prepared" ] || return 0
  rmq_admin publish \
    exchange="$FILTER_EXCHANGE" \
    routing_key="$SOURCE_ROUTING_KEY" \
    properties='{"content_type":"Content","type":"server_state"}' \
    payload="$prepared" >/dev/null || return 1
  # A failed broker send must not mark an unforwarded report as authoritative.
  python3 runtime/scripts/sietch_publication.py record "$PUBLICATION_STATE_FILE" "$source" <<<"$prepared" || return 1
  dune_set_host_path_owner "$PUBLICATION_STATE_FILE"
)

heal_survival_alive_state() {
  local live_server_ids sql connections
  # The third caller of `rabbitmqctl list_connections`, and on this loop the
  # busiest: publish_snapshot_once runs every SNAPSHOT_REFRESH_SECONDS, ten by
  # default. Same seam and same fallback as ready.sh -- see the note on
  # dune_rmq_game_connections for why the credential lookup never refreshes the
  # director log itself, which this script does keep current.
  local RMQ_HTTP_TIMEOUT_SECONDS=8

  connections="$(dune_rmq_game_connections 2>/dev/null)" \
    || connections="$(timeout 8 docker exec dune-rmq-game rabbitmqctl list_connections user state 2>/dev/null)" \
    || connections=""

  live_server_ids="$(
    printf '%s\n' "$connections" \
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
  dune_psql -qAt -c "$sql" >/dev/null 2>&1 || true
}

publish_snapshot_once() {
  local rows
  local survival_log_ready="false"
  runtime/scripts/sietches.sh sync >>"$LOG_FILE" 2>&1 || {
    echo "Sietch sync failed before publish." >&2
    return 1
  }
  heal_survival_alive_state
  if survival_farm_is_ready; then
    survival_log_ready="true"
  fi
  rows="$(TIMESTAMP_LEAD_SECONDS="$TIMESTAMP_LEAD_SECONDS" SURVIVAL_LOG_READY="$survival_log_ready" python3 - <<'PY'
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, "runtime/scripts")
import usersettings  # noqa: E402
import dune_psql  # noqa: E402

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

rows_raw = dune_psql.query_tsv(query)

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
    publication = usersettings.combat_settings_for_publication(values, string_values=True)

    settings = {
        "itemDeteriorationUpdateRate": "1.0",
        "vehicleDurabilityDamageMultiplier": "1.0",
        "inventoryDecayedMaxDurabilityThreshold": "0.2",
    }
    settings.update(publication["settings"])
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


for line in rows_raw.splitlines():
    if not line.strip():
        continue
    partition_id, map_name, server_id, ready, label, game_addr, game_port = line.split("\t")
    effective_ready = ready.lower() in ("t", "true", "1")
    if partition_id == "1" and survival_log_ready:
        effective_ready = True
    identity = usersettings.merged_partition_engine_values(
        usersettings_config, "Survival_1", partition_id
    )
    display_name = str(identity.get("server_display_name") or "").strip()
    if not display_name and label:
        display_name = label if label.lower().startswith("sietch ") else f"Sietch {label}"
    password = str(identity.get("server_login_password") or "")
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
    publish_payload "$payload" snapshot
  done <<< "$rows"
}

forward_batch_once() {
  local messages
  if ! messages="$(rmq_admin --format=raw_json get queue="$SOURCE_FILTER_QUEUE" count=20 ackmode=ack_requeue_false)"; then
    return 1
  fi
  [ -n "$messages" ] && [ "$messages" != "[]" ] || return 1

  local survival_log_ready="false"
  if survival_farm_is_ready; then
    survival_log_ready="true"
  fi

  FILTER_MESSAGES="$messages" SURVIVAL_LOG_READY="$survival_log_ready" python3 - <<'PY'
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, "runtime/scripts")
import usersettings  # noqa: E402
import dune_psql  # noqa: E402

messages = json.loads(os.environ["FILTER_MESSAGES"])
survival_log_ready = os.environ.get("SURVIVAL_LOG_READY", "").lower() in ("1", "true", "t", "yes")
partition_rows_raw = dune_psql.query_tsv("""
      select wp.partition_id,
             coalesce(wp.label, ''),
             coalesce(host(fs.game_addr), ''),
             coalesce(fs.game_port, 0)
      from dune.world_partition wp
      left join dune.farm_state fs on fs.server_id = wp.server_id
      where lower(wp.map)=lower('Survival_1');
    """)
label_by_partition = {}
endpoint_by_partition = {}
for line in partition_rows_raw.splitlines():
    if not line.strip():
        continue
    partition_id, label, game_addr, game_port = line.split("\t", 3)
    label_by_partition[partition_id] = label
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
    publication = usersettings.combat_settings_for_publication(values)
    return publication["settings"].get("shouldForceEnablePvpOnAllPartitions")


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
    identity = usersettings.merged_partition_engine_values(
        usersettings_config, "Survival_1", partition_id
    )
    display_name = str(identity.get("server_display_name") or "").strip()
    if not display_name:
        label = label_by_partition.get(partition_id, "")
        if label:
            display_name = label if label.lower().startswith("sietch ") else f"Sietch {label}"
    password = str(identity.get("server_login_password") or "")
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

publish_once() {
  local rows="" keep_route=false rc=0

  # A one-shot repair may run after the long-lived publisher has died. In
  # that case it must not leave Survival_1 diverted into an unconsumed queue:
  # restore the native route after publishing the repaired snapshot. When the
  # loop is healthy it remains the route owner and keeps the filter in place.
  if loop_running; then
    keep_route=true
  fi

  ensure_route true || return 1
  rows="$(forward_batch_once || true)"
  if [ -n "$rows" ]; then
    while IFS= read -r payload; do
      [ -n "$payload" ] || continue
      publish_payload "$payload" || rc=1
    done <<< "$rows"
  else
    publish_snapshot_once || rc=1
  fi

  if [ "$keep_route" != "true" ]; then
    restore_route || rc=1
  fi
  return "$rc"
}

cleanup_loop() {
  local loop_token="$1"

  loop_token_is_current "$loop_token" || return 0
  # If the publisher exits unexpectedly, fail open to the game's native
  # Survival_1 server-state stream instead of leaving the Director subscribed
  # to an exchange that no process is feeding.
  restore_route >>"$LOG_FILE" 2>&1 || true
  rm -f "$PID_FILE" "$LOOP_TOKEN_FILE"
}

start_loop() {
  local loop_token

  mkdir -p runtime/generated
  loop_token="$(date +%s)-$$-${RANDOM:-0}"
  write_loop_token "$loop_token"
  write_live_pidfile
  # Expand the token while installing the trap. Function-local variables are
  # no longer in scope when Bash runs an EXIT trap after start_loop returns.
  # shellcheck disable=SC2064
  trap "cleanup_loop $(printf '%q' "$loop_token")" EXIT
  local route_refresh_at=0
  local snapshot_refresh_at=0
  local spicefield_reconcile_at=0
  if ! ensure_route true; then
    echo "ERROR sietch-state-publisher initialization failed: RabbitMQ route unavailable" >&2
    return 1
  fi
  route_refresh_at=$(( $(date +%s) + ROUTE_REFRESH_SECONDS ))
  publish_snapshot_once >>"$LOG_FILE" 2>&1 || true
  while true; do
    if ! loop_token_is_current "$loop_token"; then
      echo "A newer Sietch publisher generation took ownership; stopping this loop." >>"$LOG_FILE"
      return 0
    fi
    if [ "$(date +%s)" -ge "$route_refresh_at" ]; then
      ensure_route false >>"$LOG_FILE" 2>&1 || true
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

if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

case "${1:-start}" in
  once)
    publish_once
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
