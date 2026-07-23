#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

TEXT_ROUTER_LOG="runtime/text-router/director-current.log"
CONFIG_FILE="runtime/generated/sietch-config.json"
RMQ_TIMEOUT_SECONDS="${DUNE_DEEPDESERT_STATE_RMQ_TIMEOUT_SECONDS:-8}"

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
import sys
import time
from pathlib import Path

sys.path.insert(0, "runtime/scripts")
import usersettings  # noqa: E402

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

usersettings_config = usersettings.load_config()


def combat_settings_for_partition(partition_id: str) -> dict:
    """Resolve this partition's PvP/PvE combat state via the canonical
    resolver (the same merged UserGame.ini logic used by
    `usersettings.py partition-values`), instead of publishing a single
    hard-coded CombatSettings block for every partition.

    Only fields with a known, real source are published. When the
    partition's combat state cannot be determined (UNKNOWN/CONFLICT), the
    PvP/PvE-affecting fields are omitted entirely rather than publishing a
    guessed value, so downstream consumers cannot mistake an unresolved
    state for an accurate partition-specific reading.
    """
    values = usersettings.merged_partition_values(
        usersettings_config, "DeepDesert_1", str(partition_id)
    )
    resolved = usersettings.resolve_partition_combat_state(values)

    settings = {
        "Difficulty": "Custom",
        "CoreSettings": {
            "serverDisplayName": "",
            "doubleDifficultyLoot": "False",
        },
        "CombatSettings": {
            "areSecurityZonesEnabled": "True" if resolved["securityZonesEnabled"] else "False",
        },
    }

    if resolved["state"] in ("PVP", "PVE"):
        # shouldForceEnablePvpOnAllPartitions reflects the actual resolved
        # force-all flag only when it is what determined this partition's
        # state; otherwise it is left unset rather than defaulted to False,
        # since a wrong "False" would misrepresent a force-all-PvP server.
        settings["CombatSettings"]["shouldForceEnablePvpOnAllPartitions"] = (
            "True" if resolved["source"] == "force-pvp-all-partitions" else "False"
        )
    # When state is CONFLICT or UNKNOWN, PvP/PvE-affecting fields are
    # intentionally omitted — see docstring above.

    return settings


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
    combat_settings = combat_settings_for_partition(partition_id)
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
        "serverGameplaySettings": combat_settings,
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
