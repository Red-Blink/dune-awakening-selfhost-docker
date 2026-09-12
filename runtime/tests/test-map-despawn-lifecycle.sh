#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

mkdir -p "$test_root/runtime/scripts" "$test_root/runtime/generated" "$test_root/bin"
cp runtime/scripts/despawn-server.sh "$test_root/runtime/scripts/despawn-server.sh"
cp runtime/scripts/landsraad-instance-cleanup.sh "$test_root/runtime/scripts/landsraad-instance-cleanup.sh"
printf '#!/usr/bin/env bash\nexit 1\n' >"$test_root/runtime/scripts/map-modes.sh"
chmod +x "$test_root/runtime/scripts/despawn-server.sh" "$test_root/runtime/scripts/map-modes.sh"

cat >"$test_root/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "ps" ]; then
  case " $* " in
    *" --filter "*) exit 0 ;;
    *)
      printf '%s\n' \
        dune-server-cb-overland-s-08-29 \
        dune-server-cb-overland-s-08-30 \
        dune-server-cb-overland-s-08-31
      ;;
  esac
  exit 0
fi

if [ "${1:-}" = "rm" ] && [ "${2:-}" = "-f" ]; then
  printf '%s\n' "$3" >>"$DESPAWN_TEST_LOG"
  exit 0
fi

if [ "${1:-}" = "exec" ]; then
  query="${*: -1}"
  if [[ "$query" == *"delete_actors_and_respawns_on_server"* ]]; then
    printf '%s\n' "$query" >>"$LANDSRAAD_CLEANUP_LOG"
    if [ "${LANDSRAAD_CLEANUP_FAIL:-0}" = "1" ]; then
      echo "simulated Landsraad cleanup failure" >&2
      exit 42
    fi
  fi
  if [[ "$query" == *"update dune.world_partition"* ]]; then
    printf '%s\n' "$query" >>"$ASSIGNMENT_CLEANUP_LOG"
  fi
  if [[ "$query" == *"select partition_id"* && "$query" == *"lower(map)"* ]]; then
    printf '29\n30\n31\n'
  elif [[ "$query" == *"select map || '|' || partition_id"* ]]; then
    partition="$(sed -n 's/.*partition_id = \([0-9][0-9]*\).*/\1/p' <<<"$query")"
    if [ "$partition" = "28" ]; then
      printf 'CB_Overland_S_07|%s\n' "$partition"
    else
      printf 'CB_Overland_S_08|%s\n' "$partition"
    fi
  elif [[ "$query" == *"select coalesce(map"* ]]; then
    partition="$(sed -n 's/.*partition_id = \([0-9][0-9]*\).*/\1/p' <<<"$query")"
    if [ "$partition" = "28" ]; then
      printf 'CB_Overland_S_07\n'
    else
      printf 'CB_Overland_S_08\n'
    fi
  elif [[ "$query" == *"select coalesce(server_id"* ]]; then
    partition="$(sed -n 's/.*partition_id = \([0-9][0-9]*\).*/\1/p' <<<"$query")"
    printf 'server-%s\n' "$partition"
  fi
  exit 0
fi

echo "Unexpected docker invocation: $*" >&2
exit 1
SH
chmod +x "$test_root/bin/docker"

despawn_log="$test_root/despawn.log"
cleanup_log="$test_root/landsraad-cleanup.log"
assignment_log="$test_root/assignment-cleanup.log"
touch "$despawn_log"
touch "$cleanup_log"
touch "$assignment_log"
(
  cd "$test_root"
  DESPAWN_TEST_LOG="$despawn_log" LANDSRAAD_CLEANUP_LOG="$cleanup_log" ASSIGNMENT_CLEANUP_LOG="$assignment_log" PATH="$test_root/bin:$PATH" \
    runtime/scripts/despawn-server.sh CB_Overland_S_08 --force >/dev/null
)

diff -u <(printf '%s\n' \
  dune-server-cb-overland-s-08-29 \
  dune-server-cb-overland-s-08-30 \
  dune-server-cb-overland-s-08-31) "$despawn_log"
[ "$(grep -c 'delete_actors_and_respawns_on_server' "$cleanup_log")" = "3" ]
for partition_id in 29 30 31; do
  grep -Eq "row\(dune.upgrade_map_name\('CB_Overland_S_08'\), ${partition_id}::bigint" "$cleanup_log"
done
grep -q 'null::text\[\]' "$cleanup_log"
grep -q '^  false$' "$cleanup_log"

: >"$despawn_log"
: >"$cleanup_log"
(
  cd "$test_root"
  DESPAWN_TEST_LOG="$despawn_log" LANDSRAAD_CLEANUP_LOG="$cleanup_log" ASSIGNMENT_CLEANUP_LOG="$assignment_log" PATH="$test_root/bin:$PATH" \
    runtime/scripts/despawn-server.sh 30 --force >/dev/null
)
[ "$(cat "$despawn_log")" = "dune-server-cb-overland-s-08-30" ]
[ "$(grep -c 'delete_actors_and_respawns_on_server' "$cleanup_log")" = "1" ]
grep -Eq "row\(dune.upgrade_map_name\('CB_Overland_S_08'\), 30::bigint" "$cleanup_log"

: >"$despawn_log"
: >"$cleanup_log"
: >"$assignment_log"
cleanup_failure_log="$test_root/cleanup-failure.log"
(
  cd "$test_root"
  DESPAWN_TEST_LOG="$despawn_log" LANDSRAAD_CLEANUP_LOG="$cleanup_log" ASSIGNMENT_CLEANUP_LOG="$assignment_log" LANDSRAAD_CLEANUP_FAIL=1 PATH="$test_root/bin:$PATH" \
    runtime/scripts/despawn-server.sh 28 --force >/dev/null 2>"$cleanup_failure_log"
)
[ "$(cat "$despawn_log")" = "dune-server-cb-overland-s-07-28" ]
grep -q 'update dune.world_partition' "$assignment_log"
grep -q 'delete from dune.farm_state' "$assignment_log"
grep -q 'delete_actors_and_respawns_on_server' "$cleanup_log"
grep -q "dune.upgrade_map_name('CB_Overland_S_07')" "$cleanup_log"
grep -q 'Warning: transient Landsraad actor cleanup failed' "$cleanup_failure_log"

source runtime/scripts/landsraad-instance-cleanup.sh
s07_sql="$(landsraad_instance_cleanup_sql CB_Overland_S_07 28)"
grep -q "dune.upgrade_map_name('CB_Overland_S_07')" <<<"$s07_sql"
grep -q '28::bigint' <<<"$s07_sql"
if landsraad_instance_cleanup_sql CB_Overland_S_06 26 >/dev/null 2>&1; then
  echo "non-Landsraad map unexpectedly received disposable-instance cleanup" >&2
  exit 1
fi
if landsraad_instance_cleanup_sql CB_Overland_S_08 '29; delete from dune.actors' >/dev/null 2>&1; then
  echo "invalid partition unexpectedly received cleanup SQL" >&2
  exit 1
fi

python3 - <<'PY'
from pathlib import Path

source = Path("runtime/scripts/autoscaler.sh").read_text(encoding="utf-8")
body = source.split("handle_idle_row() {", 1)[1].split("ensure_overmap_travel_maps_prewarmed() {", 1)[0]

mode_guard = 'if ! map_is_dynamic "$map" && ! map_is_overmap_active "$map"; then'
player_guard = 'if [ "$connected_players" != "0" ] || [ "$effective_players" != "0" ]'
assert body.index(mode_guard) < body.index(player_guard), "Always On maps must leave idle handling before timers run"
assert 'set_idle_since "$key" $((now - mode_elapsed))' in body
assert 'runtime/scripts/despawn-server.sh "$partition_id"' in body
assert 'runtime/scripts/despawn-server.sh "$map"' not in body

despawn = Path("runtime/scripts/despawn-server.sh").read_text(encoding="utf-8")
cleanup = Path("runtime/scripts/landsraad-instance-cleanup.sh").read_text(encoding="utf-8")
assert 'CB_Overland_S_07|CB_Overland_S_08' in cleanup
assert "dune.upgrade_map_name('$world_map')" in cleanup
assert despawn.index('docker rm -f "$container"') < despawn.index('cleanup_landsraad_instance_after_shutdown "$container_map" "$partition_id"')
assert despawn.index('update dune.world_partition') < despawn.index('cleanup_landsraad_instance_after_shutdown "$container_map" "$partition_id"')

recycle = Path("runtime/scripts/recycle-world-game-servers.sh").read_text(encoding="utf-8")
remove = recycle.split("remove_container() {", 1)[1].split("remove_stale() {", 1)[0]
assert remove.index('docker rm -f "$name"') < remove.index('cleanup_partition_assignment "$partition_id"')
assignment = recycle.split("cleanup_partition_assignment() {", 1)[1].split("remove_container() {", 1)[0]
assert assignment.index('update dune.world_partition') < assignment.index('cleanup_landsraad_instance_after_shutdown "$map_name" "$partition_id"')

spawn = Path("runtime/scripts/spawn-server.sh").read_text(encoding="utf-8")
assert 'landsraad-instance-cleanup.sh' not in spawn
assert 'landsraad_instance_cleanup_sql' not in spawn
assert 'delete_actors_and_respawns_on_server' not in spawn

scan = source.split("scan_idle_servers() {", 1)[1].split("# Hyper-V scales", 1)[0]
assert "wp.partition_id" in scan
assert "read -r map partition_id server_id" in scan
PY

python3 - "$test_root/handle-idle-row.sh" <<'PY'
from pathlib import Path
import sys

source = Path("runtime/scripts/autoscaler.sh").read_text(encoding="utf-8")
function = "handle_idle_row() {" + source.split("handle_idle_row() {", 1)[1].split("ensure_overmap_travel_maps_prewarmed() {", 1)[0]
Path(sys.argv[1]).write_text(function, encoding="utf-8")
PY

cat >"$test_root/runtime/scripts/despawn-server.sh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$1" >>"$AUTOSCALER_DESPAWN_LOG"
SH
chmod +x "$test_root/runtime/scripts/despawn-server.sh"

AUTOSCALER_DESPAWN_LOG="$despawn_log" TEST_ROOT="$test_root" bash <<'SH'
set -euo pipefail

declare -A idle_state=()
MODE="always-on"
REMAINING=0
NOW=1000
DESPAWN_GRACE_SECONDS=300

state_key() { printf '%s|%s\n' "$1" "$2"; }
idle_seconds_for_map() { echo 300; }
clear_idle_since() { unset 'idle_state[$1]'; }
get_idle_since() { [ -n "${idle_state[$1]+x}" ] && echo "${idle_state[$1]}"; }
set_idle_since() { idle_state[$1]="$2"; }
map_is_dynamic() { [ "$MODE" = "dynamic" ]; }
map_is_overmap_active() { [ "$MODE" = "overmap-active" ]; }
map_requires_fresh_process() { return 1; }
map_has_recent_demand() { return 1; }
map_dynamic_grace_remaining() { echo "$REMAINING"; }
map_has_active_presence() { return 1; }
forget_map_demand() { :; }
date() { echo "$NOW"; }

source "$TEST_ROOT/handle-idle-row.sh"
cd "$TEST_ROOT"

: >"$AUTOSCALER_DESPAWN_LOG"
handle_idle_row CB_Overland_S_08 29 server-29 0 0 true true
[ ! -s "$AUTOSCALER_DESPAWN_LOG" ]
[ -z "${idle_state[CB_Overland_S_08|server-29]+x}" ]

MODE="dynamic"
REMAINING=300
handle_idle_row CB_Overland_S_08 29 server-29 0 0 true true
[ "${idle_state[CB_Overland_S_08|server-29]}" = "1000" ]

NOW=1300
REMAINING=0
handle_idle_row CB_Overland_S_08 29 server-29 0 0 true true
[ "$(cat "$AUTOSCALER_DESPAWN_LOG")" = "29" ]
SH

echo "map despawn drains every requested dimension and idle cleanup stays partition-scoped"
