#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

TEXT_ROUTER_LOG="runtime/text-router/director-current.log"
CONFIG_FILE="runtime/generated/sietch-config.json"
RMQ_TIMEOUT_SECONDS="${DUNE_DEEPDESERT_STATE_RMQ_TIMEOUT_SECONDS:-8}"

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
pattern = re.compile(r'(bgd\.[^/\s]+\.admin)/([A-Za-z0-9+/=]+) => allow administrator')
text = ""
if log_path.exists():
    text = log_path.read_text(errors="ignore")
matches = pattern.findall(text)
if not matches:
    try:
        text = subprocess.check_output(
            ["docker", "logs", "dune-text-router"],
            text=True,
            stderr=subprocess.STDOUT,
        )
    except Exception:
        text = ""
    matches = pattern.findall(text)
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

publish_payload() {
  local payload="$1"
  rmq_admin publish \
    exchange="completions" \
    routing_key="server_state.DeepDesert_1" \
    properties='{"content_type":"Content","type":"server_state"}' \
    payload="$payload" >/dev/null
}

publish_snapshot_once() {
  python3 - <<'PY'
import json
import subprocess
import time
from pathlib import Path

config_path = Path("runtime/generated/sietch-config.json")
config = json.loads(config_path.read_text()) if config_path.exists() else {"partitions": {}}
partitions = config.get("partitions", {})

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
        "doubleDifficultyLoot": "False",
    },
    "CombatSettings": {
        "securityZonesForceEnablePvp": "False",
        "areSecurityZonesEnabled": "True",
        "shouldForceEnablePvpOnAllPartitions": "False",
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
    display_name = partitions.get(partition_id, {}).get("display_name", "")
    if not display_name:
        display_name = "Deep Desert" if not label else f"Deep Desert {label}"
    payload = {
        "reportTimestamp": int(time.time()),
        "partitionId": int(partition_id),
        "serverId": server_id,
        "ready": ready.lower() in ("t", "true", "1"),
        "ip": game_addr,
        "port": int(game_port or "0"),
        "loginPassword": "",
        "displayName": display_name,
        "isStartingMap": ready.lower() not in ("t", "true", "1"),
        "playerHardCapOverride": -1,
        "wauCapCurve": -1,
        "players": [],
        "serverGameplaySettings": json.loads(json.dumps(defaults)),
    }
    payload["serverGameplaySettings"]["CoreSettings"]["serverDisplayName"] = display_name
    print(json.dumps(payload, separators=(",", ":")))
PY
}

case "${1:-once}" in
  once)
    rows="$(publish_snapshot_once || true)"
    [ -n "${rows:-}" ] || exit 0
    while IFS= read -r payload; do
      [ -n "$payload" ] || continue
      publish_payload "$payload"
    done <<< "$rows"
    ;;
  *)
    echo "Usage: $0 [once]"
    exit 2
    ;;
esac
