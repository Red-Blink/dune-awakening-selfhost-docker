#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

state_file="$tmp_dir/map-runtime-modes.json"
cat >"$state_file" <<'JSON'
{
  "version": 2,
  "maps": {
    "CB_Overland_S_06": {"mode": "always-on"},
    "CB_Story_DestroyedZanovar": {"mode": "overmap-active"},
    "CB_Story_OrbitalMonitor": {"mode": "always-on"},
    "CB_Overland_S_04": {"mode": "always-on"}
  }
}
JSON

# Without a live database, canonical_map deliberately preserves the supplied
# map name.  This makes the effective-mode policy independently testable.
mkdir -p "$tmp_dir/no-docker"
cat >"$tmp_dir/no-docker/docker" <<'SH'
#!/usr/bin/env bash
exit 1
SH
chmod +x "$tmp_dir/no-docker/docker"

mode="$(DUNE_MAP_MODES_FILE="$state_file" PATH="$tmp_dir/no-docker:$PATH" \
  runtime/scripts/map-modes.sh mode CB_Overland_S_06)"
[ "$mode" = $'CB_Overland_S_06\tdynamic' ]

# Updating from v1.4.32 must repair persisted Always On / Overmap Active
# selections for every fresh-process map. Leaving a raw value behind lets an
# older/direct consumer respawn the map immediately after fresh-process idle
# handling removes it.
python3 - "$state_file" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1], encoding="utf-8"))
assert data["version"] == 3
assert data["maps"]["CB_Overland_S_06"]["mode"] == "dynamic"
assert data["maps"]["CB_Story_DestroyedZanovar"]["mode"] == "dynamic"
assert data["maps"]["CB_Story_OrbitalMonitor"]["mode"] == "dynamic"
assert data["maps"]["CB_Overland_S_04"]["mode"] == "always-on"
PY

disabled_state_file="$tmp_dir/disabled-map-runtime-modes.json"
cat >"$disabled_state_file" <<'JSON'
{"version":2,"maps":{"CB_Overland_S_06":{"mode":"disabled"}}}
JSON
DUNE_MAP_MODES_FILE="$disabled_state_file" PATH="$tmp_dir/no-docker:$PATH" \
  runtime/scripts/map-modes.sh mode CB_Overland_S_06 >/dev/null
python3 - "$disabled_state_file" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1], encoding="utf-8"))
assert data["version"] == 3
assert data["maps"]["CB_Overland_S_06"]["mode"] == "disabled"
PY

if DUNE_MAP_MODES_FILE="$state_file" PATH="$tmp_dir/no-docker:$PATH" \
  runtime/scripts/map-modes.sh is-always-on CB_Overland_S_06; then
  echo "Smuggler's Run incorrectly remained Always On" >&2
  exit 1
fi

DUNE_MAP_MODES_FILE="$state_file" PATH="$tmp_dir/no-docker:$PATH" \
  runtime/scripts/map-modes.sh requires-fresh-process CB_Overland_S_06
DUNE_MAP_MODES_FILE="$state_file" PATH="$tmp_dir/no-docker:$PATH" \
  runtime/scripts/map-modes.sh requires-fresh-process CB_Story_DestroyedZanovar
DUNE_MAP_MODES_FILE="$state_file" PATH="$tmp_dir/no-docker:$PATH" \
  runtime/scripts/map-modes.sh requires-fresh-process CB_Story_OrbitalMonitor

if DUNE_MAP_MODES_FILE="$state_file" PATH="$tmp_dir/no-docker:$PATH" \
  runtime/scripts/map-modes.sh requires-fresh-process CB_Overland_S_04; then
  echo "unrelated map was incorrectly marked fresh-process-only" >&2
  exit 1
fi

grep -q 'Fresh-process maps: immediate deallocation once empty' runtime/scripts/autoscaler.sh
grep -q "printf '0\\\\n'" runtime/scripts/autoscaler.sh
grep -q 'idle_seconds="$(idle_seconds_for_map "$map")"' runtime/scripts/autoscaler.sh
grep -q 'if ! map_requires_fresh_process "$map"; then' runtime/scripts/autoscaler.sh
grep -q 'runtime/scripts/despawn-server.sh "$partition_id"' runtime/scripts/autoscaler.sh
grep -q 'const requiresFreshProcess = isFreshProcessMap(rowName);' \
  console/web/src/features/maps/MapsPanel.tsx
grep -q 'retired as soon as it becomes empty' console/web/src/features/maps/MapsPanel.tsx
grep -q 'DEMAND_INTERVAL="${DUNE_AUTOSCALER_DEMAND_INTERVAL:-2}"' runtime/scripts/autoscaler.sh
grep -q '^follow_director_travel_demand &$' runtime/scripts/autoscaler.sh
grep -q '^follow_fresh_process_lifecycle &$' runtime/scripts/autoscaler.sh
grep -q 'ClassicalInstancing|Dimension' runtime/scripts/autoscaler.sh
grep -A22 'match = classical_pattern.search' runtime/scripts/autoscaler.sh \
  | grep -q '"CB_Story_OrbitalMonitor"'
grep -q "fresh-process) map_filter=\"and fs.map in ('CB_Overland_S_06', 'CB_Story_DestroyedZanovar', 'CB_Story_OrbitalMonitor')\"" runtime/scripts/autoscaler.sh
grep -q "standard) map_filter=\"and fs.map not in ('CB_Overland_S_06', 'CB_Story_DestroyedZanovar', 'CB_Story_OrbitalMonitor')\"" runtime/scripts/autoscaler.sh
grep -q 'forget_map_demand "$map"' runtime/scripts/autoscaler.sh
grep -A14 '^reconcile_all()' runtime/scripts/map-modes.sh \
  | grep -q 'effective_mode_for_map'
grep -q 'runtime/scripts/map-modes.sh always-on-maps' \
  runtime/scripts/publish-network-server-state-overrides.sh

main_loop="$(sed -n '/^while true; do$/,/^done$/p' runtime/scripts/autoscaler.sh | tail -n 30)"
if grep -q 'scan_travel_demand' <<<"$main_loop"; then
  echo "travel demand scan is still blocked behind the maintenance loop" >&2
  exit 1
fi

python3 - <<'PY'
from pathlib import Path

source = Path("runtime/scripts/autoscaler.sh").read_text()
body = source.split("handle_idle_row() {", 1)[1].split("ensure_overmap_travel_maps_prewarmed() {", 1)[0]
guards = [
    'if [ "$connected_players" != "0" ] || [ "$effective_players" != "0" ]',
    'if map_has_recent_demand "$map"; then',
    'if [ "$age" -ge "$idle_seconds" ]; then',
    'runtime/scripts/despawn-server.sh "$partition_id"',
]
positions = [body.index(guard) for guard in guards]
if positions != sorted(positions):
    raise SystemExit("player/travel protections must run before immediate deallocation")
PY

# The lifecycle correction must use Funcom's official image by default.  Stale
# compatibility flags from an earlier release are intentionally ignored.
resolved="$({
  DUNE_WORLD_IMAGE_TAG=2064155-0-shipping \
  DUNE_VEHICLE_PERMISSION_RESET_FIX_ENABLED=true \
  bash -c 'source runtime/scripts/image-tags.sh; resolve_game_server_image'
})"
[ "$resolved" = 'registry.funcom.com/funcom/self-hosting/seabass-server:2064155-0-shipping' ]

if rg -n 'vehicle-permission-reset|vehicle-fix' \
  runtime/scripts patches tests --glob '!smugglers-run-fresh-process-test.sh'; then
  echo "obsolete binary compatibility path is still referenced" >&2
  exit 1
fi

echo "Smuggler's Run uses a fresh official-image process after each idle visit"
