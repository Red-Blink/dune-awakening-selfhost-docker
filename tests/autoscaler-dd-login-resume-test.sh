#!/usr/bin/env bash
# A player who logs out inside a Deep Desert dimension and returns after that dimension's idle
# server despawned is refused by the Director and queued for a partition with no server. The
# Deep Desert travel-response path never runs for a login, so the autoscaler must spawn that exact
# partition itself (#1271).
set -euo pipefail

cd "$(dirname "$0")/.."

script="runtime/scripts/autoscaler.sh"

bash -n "$script"

extract() {
  python3 - "$script" "$1" "$2" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
start = text.index(sys.argv[2])
end = text.index(sys.argv[3], start)
print(text[start:end])
PY
}

# --- static wiring -------------------------------------------------------------------------
scan="$(extract "scan_deepdesert_login_resumes()" "scan_idle_servers()")"
code="$(grep -v '^[[:space:]]*#' <<<"$scan")"
grep -q 'director_heal_due deepdesert_login_resume 5' <<<"$code"
grep -qF 'director_logs --timestamps --since 150s' <<<"$code"
grep -qF 'deepdesert_partition_spawn_in_progress "$partition_id" && continue' <<<"$code"
grep -qF 'DEEPDESERT_LOGIN_ATTEMPTED_AT[$partition_id]="$started"' <<<"$code"
grep -q 'map_is_disabled "DeepDesert_1"' <<<"$code"
# Exactly one spawn call, and it is the exact-partition form. Never the bare-map form (or any
# other argument): that picks the first unassigned dimension, not the one the player is in.
test "$(grep -c 'spawn-server\.sh' <<<"$code")" -eq 1
grep -qF 'runtime/scripts/spawn-server.sh "$partition_id" || rc=$?' <<<"$code"
# The spawn runs in the background (the fast follower must not wait for it) and is never killed:
# killing spawn-server.sh after docker run releases the port reservation of a running container.
grep -qE '^\s*\) &$' <<<"$code"
if grep -qE '\btimeout\b' <<<"$code"; then
  echo "login resume must not wrap spawn-server.sh in timeout (it would drop a live port reservation)" >&2
  exit 1
fi
# The stub below answers by partition id and cannot evaluate SQL, so pin the predicate itself: a
# partition is free when it has no server, or its server has no live farm_state row, and it is
# not blocked.
grep -qF "when coalesce(wp.server_id, '') = '' then 'free'" <<<"$code"
grep -qE "^[[:space:]]*when not exists \\($" <<<"$code"
grep -qF "where fs.server_id = wp.server_id and coalesce(fs.alive, false)" <<<"$code"
follow="$(extract "follow_director_travel_demand() {" "follow_director_travel_demand &")"
grep -q 'scan_deepdesert_login_resumes' <<<"$follow"
# Story recovery stays first; the login resume must run before generic demand handling.
story_at="$(grep -bo 'scan_rejected_story_returns' <<<"$follow" | head -n1 | cut -d: -f1)"
resume_at="$(grep -bo 'scan_deepdesert_login_resumes' <<<"$follow" | head -n1 | cut -d: -f1)"
demand_at="$(grep -bo 'scan_travel_demand' <<<"$follow" | head -n1 | cut -d: -f1)"
test "$story_at" -lt "$resume_at"
test "$resume_at" -lt "$demand_at"

# --- behaviour: which partitions does a Director log ask us to spawn? -----------------------
parser="$(extract "deepdesert_login_resume_partitions()" "scan_deepdesert_login_resumes()")"

# The Director log is not trusted: the match is bounded and every line is cut before matching.
parser_code="$(grep -v '^[[:space:]]*#' <<<"$parser")"
grep -qF '.{0,8000}?' <<<"$parser_code"
grep -qF 'line[:16384]' <<<"$parser_code"
grep -qF 'Director\] ' <<<"$parser_code"
grep -qF 'Player ([A-F0-9]+) requested WorldPartition' <<<"$parser_code"
grep -qF 'refusal.match(' <<<"$parser_code"
grep -qF "and wp.blocked = false" <<<"$code"
grep -qF "and wp.map = 'DeepDesert_1'" <<<"$code"
grep -qF 'where wp.partition_id = ${partition_id}' <<<"$code"

log="$(mktemp)"
fixture="$(mktemp -d)"
trap 'rm -f "$log"; rm -rf "$fixture"' EXIT
cat >"$log" <<'LOG'
[14:52:49 8 INF Director] Player AAAAAAAAAAAAAAAA requested WorldPartition { PartitionId = 38, ServerId = 5iQw6_4RQeGU37j062cmOw, Map = Survival_1, PartitionDefinition = {"box": {"max_x": 1, "max_y": 1, "min_x": 0, "min_y": 0}, "type": "box2d_array"}, DimensionIndex = 2, Blocked = False, Label = Barkan }. Teleport not allowed, returning to WorldPartition { PartitionId = 8, ServerId = , Map = DeepDesert_1, PartitionDefinition = {"box": {"max_x": 1, "max_y": 1, "min_x": 0, "min_y": 0}, "type": "box2d_array"}, DimensionIndex = 0, Blocked = False, Label = DeepDesert_0 }, setting return dimension to 2.
[14:52:50 8 INF Director] Player AAAAAAAAAAAAAAAA requested WorldPartition { PartitionId = 38, ServerId = 5iQw6_4RQeGU37j062cmOw, Map = Survival_1, PartitionDefinition = {"box": {"max_x": 1, "max_y": 1, "min_x": 0, "min_y": 0}, "type": "box2d_array"}, DimensionIndex = 2, Blocked = False, Label = Barkan }. Teleport not allowed, returning to WorldPartition { PartitionId = 8, ServerId = , Map = DeepDesert_1, PartitionDefinition = {"box": {"max_x": 1, "max_y": 1, "min_x": 0, "min_y": 0}, "type": "box2d_array"}, DimensionIndex = 0, Blocked = False, Label = DeepDesert_0 }, setting return dimension to 2.
[14:53:10 8 INF Director] Player BBBBBBBBBBBBBBBB requested WorldPartition { PartitionId = 38, ServerId = 5iQw6_4RQeGU37j062cmOw, Map = Survival_1, PartitionDefinition = {}, DimensionIndex = 2, Blocked = False, Label = Barkan }. Teleport not allowed, returning to WorldPartition { PartitionId = 36, ServerId = 4q3nMp9kRGW9GqpEIAHpzQ, Map = DeepDesert_1, PartitionDefinition = {}, DimensionIndex = 1, Blocked = False, Label = DeepDesert_1 }, setting return dimension to 2.
[14:53:20 8 INF Director] Player CCCCCCCCCCCCCCCC requested WorldPartition { PartitionId = 38, ServerId = 5iQw6_4RQeGU37j062cmOw, Map = Survival_1, PartitionDefinition = {}, DimensionIndex = 2, Blocked = False, Label = Barkan }. Teleport not allowed, returning to WorldPartition { PartitionId = 31, ServerId = , Map = CB_Story_OrbitalMonitor, PartitionDefinition = {}, DimensionIndex = 0, Blocked = False, Label = Story }, setting return dimension to 2.
[14:53:30 8 INF Director] Player DDDDDDDDDDDDDDDD requested WorldPartition { PartitionId = 38, ServerId = 5iQw6_4RQeGU37j062cmOw, Map = Survival_1, PartitionDefinition = {}, DimensionIndex = 2, Blocked = False, Label = Barkan }. Teleport not allowed, returning to WorldPartition { PartitionId = 40, ServerId = , Map = DeepDesert_1, PartitionDefinition = {}, DimensionIndex = 2, Blocked = False, Label = DeepDesert_2 }, setting return dimension to 2.
[14:53:40 8 INF Director] Player EEEEEEEEEEEEEEEE requested WorldPartition { PartitionId = 38, ServerId = 5iQw6_4RQeGU37j062cmOw, Map = Survival_1, PartitionDefinition = {}, DimensionIndex = 2, Blocked = False, Label = Barkan }. Teleport not allowed, returning to WorldPartition { PartitionId = 41, ServerId = deadServerId0123456789, Map = DeepDesert_1, PartitionDefinition = {}, DimensionIndex = 3, Blocked = False, Label = DeepDesert_3 }, setting return dimension to 2.
[14:55:01 8 INF Director] Some other teleport path: Teleport not allowed, returning to WorldPartition { PartitionId = 99, ServerId = , Map = DeepDesert_1, PartitionDefinition = {}, DimensionIndex = 3, Blocked = False, Label = DeepDesert_3 }, setting return dimension to 2.
[14:55:02 8 INF Chat] Chat: hi requested WorldPartition {x}. Teleport not allowed, returning to WorldPartition { PartitionId = 98, ServerId = , Map = DeepDesert_1, PartitionDefinition = {}, DimensionIndex = 3, Blocked = False, Label = DeepDesert_3 }, setting return dimension to 2.
[14:55:03 8 INF Chat] Chat: Player FFFFFFFFFFFFFFFF requested WorldPartition {x}. Teleport not allowed, returning to WorldPartition { PartitionId = 97, ServerId = , Map = DeepDesert_1, PartitionDefinition = {}, DimensionIndex = 3, Blocked = False, Label = DeepDesert_3 }, setting return dimension to 2.
[14:55:18 13 WRN Server] [60 occurrences]: Failed to process travel queue for partition 8.
LOG
# The reader returns docker-style timestamps; add them the way `--timestamps` does.
sed -E -i 's/^\[([0-9:]{8}) /2026-10-30T\1.000000000Z [\1 /' "$log"
# A refusal whose PartitionDefinition is far larger than any real one (3000 chars), and one with
# no readable timestamp (counts as now).
big_definition="$(python3 -c "print('x' * 3000)")"
printf '%s\n' "2026-10-30T14:54:00.000000000Z [14:54:00 8 INF Director] Player A1A1A1A1A1A1A1A1 requested WorldPartition { PartitionId = 38, ServerId = s, Map = Survival_1, PartitionDefinition = {$big_definition}, DimensionIndex = 2, Blocked = False, Label = Barkan }. Teleport not allowed, returning to WorldPartition { PartitionId = 42, ServerId = , Map = DeepDesert_1, PartitionDefinition = {}, DimensionIndex = 3, Blocked = False, Label = DeepDesert_3 }, setting return dimension to 2." >>"$log"
printf '%s\n' "[14:54:30 8 INF Director] Player B2B2B2B2B2B2B2B2 requested WorldPartition { PartitionId = 38, ServerId = s, Map = Survival_1, PartitionDefinition = {}, DimensionIndex = 2, Blocked = False, Label = Barkan }. Teleport not allowed, returning to WorldPartition { PartitionId = 43, ServerId = , Map = DeepDesert_1, PartitionDefinition = {}, DimensionIndex = 3, Blocked = False, Label = DeepDesert_3 }, setting return dimension to 2." >>"$log"
epoch() { date -u -d "2026-10-30T$1Z" +%s; }

# Login refusals that return to a DeepDesert_1 partition are spawn candidates, each partition once
# however many times it was refused, with the player and time of the newest refusal: 8 (twice, the
# later one wins), 36, 40, 41, 42 (a 3000-character PartitionDefinition) and 43 (no timestamp). The
# ServerId is not matched here (36 has a live server and 41 is bound to a possibly dead one); the
# database decides in the scan. Not candidates: the story map, a refusal that is not a
# "Director] Player X requested" login line (99), and chat lines a player could cause to be
# logged, with or without the Player prefix (98, 97).
partitions="$(bash -c "$parser
deepdesert_login_resume_partitions < \"$log\"")"
test "$(head -n5 <<<"$partitions")" = "8 AAAAAAAAAAAAAAAA $(epoch 14:52:50)
36 BBBBBBBBBBBBBBBB $(epoch 14:53:10)
40 DDDDDDDDDDDDDDDD $(epoch 14:53:30)
41 EEEEEEEEEEEEEEEE $(epoch 14:53:40)
42 A1A1A1A1A1A1A1A1 $(epoch 14:54:00)"
grep -qE '^43 B2B2B2B2B2B2B2B2 [0-9]+$' <<<"$partitions"
test "$(wc -l <<<"$partitions")" -eq 6

# Empty or irrelevant input yields nothing and must not fail under set -e / pipefail.
test -z "$(bash -c "set -euo pipefail; $parser
printf '' | deepdesert_login_resume_partitions")"
test -z "$(bash -c "set -euo pipefail; $parser
printf 'unrelated line\n' | deepdesert_login_resume_partitions")"

# A crafted or very long line must not stall the fast follower that runs this parse: the match is
# bounded and each line is cut to 16 KiB. 800 KB of repeated openers with no closer finished in
# well under a second here; allow a generous 10 s.
long_line="$(python3 -c "print('[14:00:00 1 INF Director] Player AAAAAAAAAAAAAAAA requested WorldPartition { ' * 10000)")"
start_ns="$(date +%s%N)"
test -z "$(printf '%s\n' "$long_line" | timeout 10 bash -c "$parser
deepdesert_login_resume_partitions")"
elapsed_ms=$(( ($(date +%s%N) - start_ns) / 1000000 ))
test "$elapsed_ms" -lt 5000

# --- behaviour: the scan only spawns a free, unstarted, not-recently-tried, enabled partition ---
scan_fn="$(extract "scan_deepdesert_login_resumes()" "scan_idle_servers()")"
mkdir -p "$fixture/runtime/scripts"
cat >"$fixture/runtime/scripts/spawn-server.sh" <<'SPAWN'
#!/usr/bin/env bash
printf 'SPAWNED %s\n' "$*" >>"$SPAWN_LOG"
case "${SPAWN_MODE:-ok}" in
  ok) exit 0 ;;
  slow) sleep 1; exit 0 ;;
  fail) exit 3 ;;
esac
SPAWN
chmod +x "$fixture/runtime/scripts/spawn-server.sh"

# Leaves the scan's stdout in $fixture/scan.out, the calls the stubs saw in $fixture/spawn.log and
# $fixture/logs.args, and the timing in $fixture/timing.
run_scan() {
  # $1 database state for partition 8, $2 for 40, $3 for 36 ("free", "taken" or "" for no row),
  # $4 running container name for partition 8, $5 partitions whose cooldown is held (space
  # separated), $6 map disabled (yes|no), $7 spawn stub mode (ok|slow|fail), $8 log reader (ok|fail),
  # $9 epoch of this scan's own earlier spawn of partition 8 (or empty), $10 spawn lock on 8 (free|held)
  : >"$fixture/spawn.log"; : >"$fixture/logs.args"; : >"$fixture/scan.out"
  (
    cd "$fixture"
    export SPAWN_LOG="$fixture/spawn.log" LOG_ARGS="$fixture/logs.args" LOG_FILE="$log" \
      STATE8="$1" STATE40="$2" STATE36="$3" CONTAINER8="$4" HELD="$5" DISABLED="$6" SPAWN_MODE="$7" READER="$8" \
      SPAWNED_AT8="${9:-}" LOCK8="${10:-free}"
    mkdir -p runtime/generated
    if [ "$LOCK8" = held ]; then
      flock -x runtime/generated/spawn-partition-8.lock sleep 1 &
      sleep 0.3
    fi
    bash -c "set -euo pipefail
$parser
$scan_fn
declare -A DEEPDESERT_LOGIN_SPAWNED_AT=()
declare -A DEEPDESERT_LOGIN_ATTEMPTED_AT=()
[ -z \"\$SPAWNED_AT8\" ] || DEEPDESERT_LOGIN_SPAWNED_AT[8]=\"\$SPAWNED_AT8\"
director_heal_due() {
  case \" \$HELD \" in *\" \${1#deepdesert_login_spawn_} \"*) return 1 ;; esac
  return 0
}
director_logs() { printf '%s\n' \"\$*\" >>\"\$LOG_ARGS\"; [ \"\$READER\" = ok ] || return 1; cat \"\$LOG_FILE\"; }
map_is_disabled() { [ \"\$DISABLED\" = yes ]; }
# Answer by partition id, and only for the query shape the scan is supposed to ask.
psql_value() {
  case \"\$1\" in *\"wp.map = 'DeepDesert_1'\"*\"wp.blocked = false\"*) ;; *) return 0 ;; esac
  case \"\$1\" in
    *\"partition_id = 8\"*) printf '%s' \"\$STATE8\" ;;
    *\"partition_id = 36\"*) printf '%s' \"\$STATE36\" ;;
    *\"partition_id = 40\"*) printf '%s' \"\$STATE40\" ;;
  esac
}
dynamic_container_name_for_partition() { [ \"\$1\" = 8 ] && printf '%s' \"\$CONTAINER8\"; return 0; }
t0=\$(date +%s%N)
scan_deepdesert_login_resumes
t1=\$(date +%s%N)
wait
t2=\$(date +%s%N)
printf 'scan_ms=%s total_ms=%s\n' \$(( (t1 - t0) / 1000000 )) \$(( (t2 - t0) / 1000000 )) >timing
if [ \"\${REPEAT_SCAN:-0}\" = 1 ]; then
  # The test cooldown stub allows another attempt; production waits 60s.
  export SPAWN_MODE=ok
  scan_deepdesert_login_resumes
  wait
  test \"\$(grep -c '^SPAWNED 8$' \"\$SPAWN_LOG\")\" -eq 2
  export STATE8=taken
  scan_deepdesert_login_resumes
  wait
  export STATE8=free
  scan_deepdesert_login_resumes
  wait
  test \"\$(grep -c '^SPAWNED 8$' \"\$SPAWN_LOG\")\" -eq 2
fi"
    wait
  ) >"$fixture/scan.out"
}
spawned() { sed -n 's/^SPAWN deepdesert-login-resume partition=\([0-9]*\) .*/\1/p' "$fixture/scan.out" | sort -n | paste -sd' ' -; }
field() { sed -n "s/.*$1=\([0-9]*\).*/\1/p" "$fixture/timing"; }

# 8, 36 and 40 are refused; 36 has a live server. 8 and 40 are free and idle, so each is spawned
# once, with the player that was refused to it, and the spawn script saw exactly those calls.
run_scan free free taken "" "" no ok ok
test "$(spawned)" = "8 40"
grep -qF 'SPAWN deepdesert-login-resume partition=8 player=AAAAAAAAAAAAAAAA' "$fixture/scan.out"
grep -qF 'SPAWN deepdesert-login-resume partition=40 player=DDDDDDDDDDDDDDDD' "$fixture/scan.out"
test "$(sort "$fixture/spawn.log" | paste -sd'|' -)" = "SPAWNED 40|SPAWNED 8"
# Success is reported as a completion line with an exit code, never as an ERROR.
test "$(grep -c '^DONE deepdesert-login-resume partition=[0-9]* rc=0 ' "$fixture/scan.out")" -eq 2
! grep -q '^ERROR' "$fixture/scan.out"
# The log is read with timestamps and the documented 150 s window.
grep -qx -- '--timestamps --since 150s' "$fixture/logs.args"

# Candidates 41, 42 and 43 are reported by the parser too, but their rows are not in the stub
# database, so only 8 and 40 are ever spawned above. A refusal older than this scan's own earlier
# spawn of that partition has already been served and must not respawn it after an idle despawn;
# a newer one must.
run_scan free free taken "" "" no ok ok "$(epoch 14:53:00)"
test "$(spawned)" = "40"
run_scan free free taken "" "" no ok ok "$(epoch 14:52:00)"
test "$(spawned)" = "8 40"

# A spawn that is still running holds spawn-server.sh's partition lock: it is neither repeated nor
# reported as stuck, and the other partition is unaffected.
run_scan free free taken dune-server-deepdesert-1-8 "" no ok ok "" held
test "$(spawned)" = "40"
! grep -q 'container-present-unbound' "$fixture/scan.out"

# The database decides per partition: 8 free and 40 already taken (a race with the travel-response
# path) spawns only 8, and the reverse spawns only 40. A partition with no row is left alone.
run_scan free taken taken "" "" no ok ok; test "$(spawned)" = "8"
run_scan taken free taken "" "" no ok ok; test "$(spawned)" = "40"
run_scan "" free taken "" "" no ok ok; test "$(spawned)" = "40"

# A container for the partition that is not bound to it must not be stacked, and the skip must be
# visible to the operator.
run_scan free free taken dune-server-deepdesert-1-8 "" no ok ok
test "$(spawned)" = "40"
grep -qF 'SKIP deepdesert-login-resume partition=8 reason=container-present-unbound' "$fixture/scan.out"

# The cooldown is per partition: holding 8 must not suppress 40, and vice versa.
run_scan free free taken "" "8" no ok ok; test "$(spawned)" = "40"
run_scan free free taken "" "40" no ok ok; test "$(spawned)" = "8"
run_scan free free taken "" "8 40" no ok ok; test -z "$(spawned)"

# An operator-disabled Deep Desert is never spawned, and the operator can see why.
run_scan free free taken "" "" yes ok ok
test -z "$(spawned)"
grep -qF 'SKIP deepdesert-login-resume reason=map-disabled' "$fixture/scan.out"

# A failing spawn is reported with its exit code and never as a completion.
run_scan free free taken "" "" no fail ok
test "$(spawned)" = "8 40"
test "$(grep -c '^ERROR failed to spawn DeepDesert_1 partition=[0-9]* for login resume rc=3 ' "$fixture/scan.out")" -eq 2
! grep -q '^DONE' "$fixture/scan.out"

# A failed attempt must not consume the refusal: retry it after the cooldown.
# Once the DB confirms a live assignment, that same old refusal stays consumed
# even if the server later idles out. All four scans share the actual arrays.
REPEAT_SCAN=1 run_scan free taken taken "" "" no fail ok

# The spawn is backgrounded: the scan returns while a slow spawn (1 s here, tens of seconds for
# real) is still running, so the fast follower keeps serving other players' allocation demand.
run_scan free free taken "" "" no slow ok
test "$(field scan_ms)" -lt 500
test "$(field total_ms)" -ge 900

# An unreadable Director log is a warning and no spawn, never a crash of the follower.
run_scan free free taken "" "" no ok fail
test -z "$(spawned)"
grep -qF 'WARN Deep Desert login resume scan could not read the Director log' "$fixture/scan.out"

echo "autoscaler deep desert login resume checks passed"
