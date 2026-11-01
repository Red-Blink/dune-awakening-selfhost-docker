#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

script="runtime/scripts/autoscaler.sh"

bash -n "$script"

grep -Fq 'core_maps_ready_for_browser_heal()' "$script"
grep -Fq 'dune-server-survival-1|1' "$script"
grep -Fq 'dune-server-overmap|2' "$script"
grep -Fq 'Server farm is READY .*partition ${partition}' "$script"
grep -Fq 'DIRECTOR_CORE_READY_GRACE_SECONDS="${DUNE_AUTOSCALER_DIRECTOR_CORE_READY_GRACE_SECONDS:-120}"' "$script"
grep -Fq 'DIRECTOR_HEAL_REPUBLISH_GRACE_SECONDS="${DUNE_AUTOSCALER_DIRECTOR_HEAL_REPUBLISH_GRACE_SECONDS:-120}"' "$script"
grep -Fq "AUTOSCALER_STARTED_AT=\"\$(date +%s)\"" "$script"
grep -Fq "docker logs --since \"\$started_at\" --tail 5000 \"\$container\"" "$script"

python3 - "$script" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
scan = text.index("scan_director_browser_state()")
core_gate = text.index("if ! core_maps_ready_for_browser_heal; then", scan)
startup_grace = text.index('now - AUTOSCALER_STARTED_AT', core_gate)
core_grace = text.index('if [ "$age" -lt "$DIRECTOR_CORE_READY_GRACE_SECONDS" ]; then', core_gate)
stale_eval = text.index('rows="$(director_live_server_rows)"', scan)
republish = text.index('action=republish', stale_eval)
restart = text.index('echo "HEAL director stale browser state', scan)
restart = text.index('action=coordinated-game-farm-restart', restart)

assert core_gate < startup_grace < core_grace < stale_eval < republish < restart

scan_end = text.index("follow_director_hagga_handoffs", scan)
scan_body = text[scan:scan_end]
assert "publish_state_for_map Survival_1" in scan_body
assert "publish_state_for_map Overmap" in scan_body
assert "publish_state_for_map DeepDesert_1" in scan_body
assert 'republish_age\" -lt \"$DIRECTOR_HEAL_REPUBLISH_GRACE_SECONDS' in scan_body
assert "battlegroup_effective_player_count" in scan_body
assert "browser_restart_deferred" in scan_body
assert "browser_restart_pending" in scan_body
assert 'director_heal_set browser_restart_pending "$now"' not in scan_body
assert "director_heal_clear browser_restart_pending" in scan_body
assert 'online_players="unknown"' in scan_body
assert scan_body.index("action=republish") < scan_body.index("restart-game-farm.sh")
online_guard = scan_body.index('online_players="$(battlegroup_effective_player_count')
defer_guard = scan_body.index('if [ "$online_players" = "unknown" ] || [ "$online_players" -gt 0 ]; then')
assert online_guard < defer_guard < scan_body.index("restart-game-farm.sh")
assert "restart-director.sh" not in scan_body
assert 'if [ -n "$restart_pending" ]' not in scan_body

core_ready = text.index("core_maps_ready_for_browser_heal()")
core_ready_end = text.index("scan_director_browser_state()", core_ready)
core_ready_body = text[core_ready:core_ready_end]
assert "{{.State.StartedAt}}" in core_ready_body
assert 'docker logs --since "$started_at"' in core_ready_body

dynamic_start = text.index("dynamic_ready_desync_heal()")
dynamic_end = text.index("remember_map_demand()", dynamic_start)
dynamic_body = text[dynamic_start:dynamic_end]
assert 'publish_state_for_map "$map_name"' in dynamic_body
assert "restart-director.sh" not in dynamic_body
PY

echo "autoscaler recovery waits for ready core maps and republishes stale dynamic state without restart"
