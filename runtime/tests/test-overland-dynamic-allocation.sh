#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
mkdir -p "$test_root/runtime/scripts" "$test_root/runtime/director/config"

cat >"$test_root/runtime/director/config/director_config.ini" <<'EOF'
[CB_Overland_S_04]
NumExtraServers=0

[CB_Overland_S_06]
NumExtraServers=0
MaxParties=1

[CB_Overland_S_07]
NumExtraServers=0
MaxParties=1

[CB_Overland_S_08]
NumExtraServers=0
MaxParties=1

[Future_Isolated_Activity]
MaxParties = 1 ; one party per dimension
EOF

python3 - "$test_root/functions.sh" <<'PY'
from pathlib import Path
import sys

source = Path("runtime/scripts/autoscaler.sh").read_text(encoding="utf-8")

def function(name, next_name):
    start = source.index(name + "() {")
    end = source.index("\n" + next_name + "() {", start)
    return source[start:end].rstrip() + "\n"

selected = [
    function("director_map_max_parties", "map_requires_isolated_party_dimension"),
    function("map_requires_isolated_party_dimension", "map_exists"),
    function("handle_demand", "handle_idle_row"),
    function("scan_travel_demand", "follow_director_travel_demand"),
]
Path(sys.argv[1]).write_text("\n".join(selected), encoding="utf-8")
PY

cat >"$test_root/runtime/scripts/spawn-server.sh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$1" >>"$SPAWN_LOG"
SH
chmod +x "$test_root/runtime/scripts/spawn-server.sh"

SPAWN_LOG="$test_root/spawns" TEST_ROOT="$test_root" bash <<'SH'
set -euo pipefail
cd "$TEST_ROOT"
source "$TEST_ROOT/functions.sh"

ASSIGNED=1
RUNNING=1
OCCUPIED=1
MAX_DIMENSIONS=5
DEDICATED=1
MODE=dynamic

demand_event_seen() { return 1; }
remember_map_demand() { :; }
remember_demand_event() { :; }
map_is_always_on() { return 1; }
map_exists() { return 0; }
map_is_disabled() { return 1; }
map_assigned_count() { echo "$ASSIGNED"; }
container_count_for_map() { echo "$RUNNING"; }
occupied_dimensions_for_map() { echo "$OCCUPIED"; }
max_dimensions_for_map() { echo "$MAX_DIMENSIONS"; }
map_uses_dedicated_scaling() { echo "$DEDICATED"; }

map_requires_isolated_party_dimension CB_Overland_S_06
map_requires_isolated_party_dimension CB_Overland_S_07
map_requires_isolated_party_dimension CB_Overland_S_08
map_requires_isolated_party_dimension Future_Isolated_Activity
if map_requires_isolated_party_dimension CB_Overland_S_04; then
  echo "shared-party map unexpectedly received isolated allocation" >&2
  exit 1
fi

: >"$SPAWN_LOG"
handle_demand CB_Overland_S_07 1 second-request request
[ "$(cat "$SPAWN_LOG")" = "CB_Overland_S_07" ]

# Smuggler's Run also needs a new dimension when another independent player
# arrives, while retaining its separate immediate fresh-process retirement.
: >"$SPAWN_LOG"
handle_demand CB_Overland_S_06 1 second-smugglers-request request
[ "$(cat "$SPAWN_LOG")" = "CB_Overland_S_06" ]

# The second dimension is warming. Repeated queue summaries must not start a
# third instance while one occupied dimension plus one waiter needs only two.
: >"$SPAWN_LOG"
RUNNING=2
handle_demand CB_Overland_S_07 1 repeated-queue queue
[ ! -s "$SPAWN_LOG" ]

# Once assigned, the same still-visible queue summary remains satisfied.
ASSIGNED=2
handle_demand CB_Overland_S_08 1 assigned-queue queue
[ ! -s "$SPAWN_LOG" ]

# Demand is capped by the configured number of dimensions.
ASSIGNED=4
RUNNING=4
OCCUPIED=4
handle_demand CB_Overland_S_08 2 capped-queue queue
[ "$(cat "$SPAWN_LOG")" = "CB_Overland_S_08" ]

# Other dedicated-scaling maps retain their existing single-instance policy.
: >"$SPAWN_LOG"
ASSIGNED=1
RUNNING=1
OCCUPIED=1
handle_demand CB_Overland_S_04 1 unrelated-request request
[ ! -s "$SPAWN_LOG" ]

# Director-classified party instances scale even when the local Director
# configuration does not carry a map-specific MaxParties override. This
# covers the difficulty-selectable Testing Stations, Old Quarry, and story
# activities without maintaining another hardcoded map list.
for map in \
  CB_Ecolab_Bronze_Green_024 \
  CB_Ecolab_Bronze_Green_089 \
  CB_Ecolab_Bronze_Green_136 \
  CB_Ecolab_Bronze_Green_152 \
  CB_Ecolab_Bronze_Green_195 \
  CB_Dungeon_ThePit \
  CB_Story_BanditFortress01; do
  : >"$SPAWN_LOG"
  handle_demand "$map" 1 "classical-$map" request ClassicalInstancing
  [ "$(cat "$SPAWN_LOG")" = "$map" ]
done

# Dimension-routed and ordinary dedicated requests must retain their existing
# allocation behavior; a running instance remains sufficient for those.
: >"$SPAWN_LOG"
handle_demand CB_Dungeon_ThePit 1 dimension-request request Dimension
[ ! -s "$SPAWN_LOG" ]
: >"$SPAWN_LOG"
handle_demand CB_Dungeon_ThePit 1 unspecified-request request
[ ! -s "$SPAWN_LOG" ]

# Verify request and queue records carry their source into the allocator.
: >"$SPAWN_LOG"
cat >"$TEST_ROOT/director.log" <<'EOF'
2026-09-08T20:00:00.000000000Z Received travel request for 1 player(s) to CB_Overland_S_07 (instancingMode=ClassicalInstancing)
2026-09-08T20:00:01.000000000Z Received travel request for 1 player(s) to CB_Overland_S_07 (instancingMode=ClassicalInstancing)
2026-09-08T20:00:02.000000000Z Processing travel queue for ClassicalInstancing group CB_Overland_S_08 (servers: [29 (server-a)], num: 1)
2026-09-08T20:00:03.000000000Z Received travel request for 1 player(s) to CB_Overland_S_06 (instancingMode=ClassicalInstancing)
2026-09-08T20:00:04.000000000Z Processing travel queue for ClassicalInstancing group CB_Overland_S_06 (servers: [28 (server-b)], num: 1)
2026-09-08T20:00:05.000000000Z Received travel request for 1 player(s) to CB_Dungeon_ThePit (instancingMode=ClassicalInstancing)
2026-09-08T20:00:06.000000000Z Received travel request for 1 player(s) to DeepDesert_1 (instancingMode=Dimension)
EOF
handle_demand() { printf '%s|%s|%s|%s\n' "$1" "$2" "$4" "$5" >>"$SPAWN_LOG"; }
docker() { cat "$TEST_ROOT/director.log"; }
SINCE=30s
scan_travel_demand
diff -u <(printf '%s\n' \
  'CB_Overland_S_07|1|request|ClassicalInstancing' \
  'CB_Overland_S_07|1|request|ClassicalInstancing' \
  'CB_Overland_S_08|1|queue|ClassicalInstancing' \
  'CB_Overland_S_06|1|request|ClassicalInstancing' \
  'CB_Dungeon_ThePit|1|request|ClassicalInstancing' \
  'DeepDesert_1|1|request|Dimension') "$SPAWN_LOG"

grep -q 'docker logs --timestamps --since "$SINCE" dune-director' "$TEST_ROOT/functions.sh"
SH

python3 - <<'PY'
import configparser
from pathlib import Path
import re

script = Path("runtime/scripts/start-director.sh").read_text(encoding="utf-8")
matches = re.findall(r"cat >>? runtime/director/config/director_config.ini <<'EOF'\n(.*?)\nEOF", script, re.S)
assert matches, "Director configuration blocks were not found"
config = configparser.ConfigParser()
config.read_string("\n".join(matches))
for map_name in ("CB_Overland_S_06", "CB_Overland_S_07", "CB_Overland_S_08"):
    assert config.getint(map_name, "MaxParties") == 1
    assert config.getint(map_name, "NumExtraServers") == 0
PY

echo "dynamic activity demand scales one isolated party dimension at a time"
