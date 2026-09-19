#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

script="runtime/scripts/autoscaler.sh"

bash -n "$script"

python3 - "$script" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")

sources_start = text.index("named_destination_source_maps()")
sources_end = text.index("named_destination_source_rows()", sources_start)
sources = text[sources_start:sources_end]
assert "CB_Story_DestroyedZanovar" in sources
assert "CB_Story_OrbitalMonitor" in sources

rows_start = sources_end
rows_end = text.index("hub_travel_seen()", rows_start)
rows = text[rows_start:rows_end]
assert "dune.world_partition" in rows
assert "dune.farm_state" in rows
assert "coalesce(fs.alive, false) = true" in rows
assert 'dynamic_container_name_for_partition "$partition_id"' in rows
assert "hub_container_for_map" not in text

hub_start = text.index("hub_travel_seen()")
hub_end = text.index("deepdesert_travel_seen()", hub_start)
hub = text[hub_start:hub_end]
assert 'flock -s 9' in hub
assert 'flock -x 9' in hub
assert 'HUB_TRAVEL_RETENTION_SECONDS' in hub

replay_start = text.index("replay_hagga_travel_handoff()")
replay_end = text.index("map_uses_dedicated_scaling()", replay_start)
replay = text[replay_start:replay_end]
assert 'local origin_server_id="$3"' in replay
assert 'FLOW_ID="$flow_id" LOG_FILE="$director_log_file"' in replay
assert "ORIGIN_ID=" not in replay
assert "match.group(1) != origin_id" not in replay

scan_start = text.index("scan_named_destination_failures()")
scan_end = text.index("scan_idle_servers()", scan_start)
scan = text[scan_start:scan_end]
assert "done < <(named_destination_source_rows)" in scan
assert 'replay_hagga_travel_handoff "$flow_id" "$destination_name" "$source_server_id"' in scan
assert "for source_map in SH_Arrakeen" not in scan

assert 'Travel_To_HaggaBasin_*|Travel_To_Hagga_Basin_*' in text

rejected_start = text.index("scan_rejected_story_returns()")
rejected_end = text.index("scan_idle_servers()", rejected_start)
rejected = text[rejected_start:rejected_end]
assert "Teleport not allowed" in rejected
assert "CB_Story_(?:DestroyedZanovar|OrbitalMonitor)" in rejected
assert "completed_story.complete_condition_state = 'true'::jsonb" in rejected
assert "completed_story.story_node_id = case source_wp.map" in rejected
assert "ps.online_status = 'Offline'" in rejected
assert "dune.upgrade_map_name(target_wp.map) = dune.upgrade_map_name(tri.map)" in rejected
assert "source_fs.ready = true" in rejected
assert "source_fs.alive = true" in rejected
assert "target_fs.ready = true" in rejected
assert "target_fs.alive = true" in rejected
assert "ServerId = ([A-Za-z0-9_+\\-/]*)" in rejected
assert "ps.previous_server_partition_id = $source_partition" in rejected
assert "join dune.actors pawn on pawn.id = ps.player_pawn_id" in rejected
assert "left join dune.travel_return_info tri on tri.player_controller_id = ps.player_controller_id" in rejected
assert "dune.player_respawn_locations" in rejected
assert r"prl.\"group\" in ('BaseTotem', 'Vehicle')" in rejected
assert "candidate.candidate_count = 1" in rejected
assert "candidate.priority_rank = 1" in rejected
assert ") fallback on true" in rejected
assert "coalesce(array_agg(vehicle.id), array[]::bigint[])" in rejected
assert "when cardinality(stranded.stranded_vehicle_ids) > 0" in rejected
assert "fallback.location is not null" in rejected
assert "dune.store_recovered_vehicles_wiped_before_spawn" in rejected
assert "'RecoveredFromLostState'::dune.recoveredvehiclereason" in rejected
assert "false" in rejected
assert "pawn.partition_id = $source_partition" in rejected
assert "dune.is_player_offline('$funcom_id')" in rejected
assert "dune.admin_move_offline_player_to_partition" in rejected
assert "delete from dune.travel_return_info" not in text
assert "update dune.encrypted_player_state" not in rejected
assert '[ "$moved_account_id" = "$account_id" ] || continue' in rejected
alignment = text[text.index("scan_live_player_partition_alignment()"):text.index("scan_travel_demand()", text.index("scan_live_player_partition_alignment()"))]
assert "join dune.actors pawn" in alignment
assert "pawn.partition_id = wp.partition_id" in alignment
assert "wp.map not in ('CB_Story_DestroyedZanovar', 'CB_Story_OrbitalMonitor')" in alignment
demand = text[text.index("scan_travel_demand()"):text.index("follow_director_travel_demand()")]
assert "story_return_refusal_pattern" in demand
assert "rejected_story_demands" in demand
assert "rejected_story_demands[map_name] -= 1" in demand
fast_follow = text[text.index("follow_director_travel_demand()"):text.index("scan_igwo_unavailable_maps()")]
assert fast_follow.index("scan_rejected_story_returns") < fast_follow.index("scan_travel_demand")
main_loop = text.rindex("while true; do")
assert text.index("scan_rejected_story_returns", main_loop) < text.index("scan_named_destination_failures", main_loop)
PY

source_functions="$(python3 - "$script" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
start = text.index("named_destination_source_maps()")
end = text.index("hub_travel_seen()", start)
print(text[start:end])
PY
)"

source_rows="$(bash -c "$source_functions
psql_value() {
  printf '%s\n' \
    'CB_Story_DestroyedZanovar|31|story-server-31' \
    'CB_Story_OrbitalMonitor|32|story-server-32'
}
dynamic_container_name_for_partition() {
  printf 'dune-server-story-%s\n' \"\$1\"
}
named_destination_source_rows")"

test "$source_rows" = "CB_Story_DestroyedZanovar|dune-server-story-31|story-server-31
CB_Story_OrbitalMonitor|dune-server-story-32|story-server-32"

hub_functions="$(python3 - "$script" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
start = text.index("hub_travel_seen()")
end = text.index("deepdesert_travel_seen()", start)
print(text[start:end])
PY
)"
hub_file="$(mktemp)"
printf '%s\n' \
  $'expired\t1\tStory\tSurvival_1\t100' \
  $'recent\t2\tStory\tSurvival_1\t950' > "$hub_file"
HUB_TRAVEL_FILE="$hub_file" HUB_TRAVEL_RETENTION_SECONDS=100 bash -c "$hub_functions
remember_hub_travel new 3 Story Survival_1 1000
hub_travel_seen recent
hub_travel_seen new
! hub_travel_seen expired"
grep -q '^recent' "$hub_file"
grep -q '^new' "$hub_file"
if grep -q '^expired' "$hub_file"; then
  echo "expired hub travel entries must be pruned" >&2
  exit 1
fi

replay_function="$(python3 - "$script" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
start = text.index("replay_hagga_travel_handoff()")
end = text.index("map_uses_dedicated_scaling()", start)
print(text[start:end])
PY
)"

replay_log="$(mktemp)"
trap 'rm -f "$hub_file" "$hub_file.lock" "$replay_log"' EXIT
cat >"$replay_log" <<'LOG'
Notified player(s) of travel response CB_Story_OrbitalMonitor32: {"RequestID":"AABBCCDDEEFF00112233445566778899","MapName":"Survival_1"}
Notified player of travel grant CB_Story_OrbitalMonitor32: {"RequestID":"AABBCCDDEEFF00112233445566778899","Map":"Survival_1"}
LOG

replay_output="$(REPLAY_LOG="$replay_log" bash -c "$replay_function
docker() { cat \"\$REPLAY_LOG\"; }
publish_rmq_json() { printf 'PUBLISHED|%s|%s\n' \"\$2\" \"\$3\"; }
NAMED_DESTINATION_SINCE=10m
replay_hagga_travel_handoff AABBCCDDEEFF00112233445566778899 Travel_To_HaggaBasin_EndCredits story-server-32")"

test "$(grep -c '^PUBLISHED|story-server-32|' <<<"$replay_output")" -eq 2
test "$(grep -cF '"MapName":"HaggaBasin"' <<<"$replay_output")" -eq 1
test "$(grep -cF '"Map":"HaggaBasin"' <<<"$replay_output")" -eq 1

rejected_function="$(python3 - "$script" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
start = text.index("scan_rejected_story_returns()")
end = text.index("scan_idle_servers()", start)
print(text[start:end])
PY
)"

rejected_log="$(mktemp)"
rejected_sql="$(mktemp)"
rejected_seen="$(mktemp)"
trap 'rm -f "$hub_file" "$hub_file.lock" "$replay_log" "$rejected_log" "$rejected_sql" "$rejected_seen"' EXIT
cat >"$rejected_log" <<'LOG'
2026-09-18T10:39:04Z [10:39:04 9 INF Main] Handling LoginRequest request in LoginRequest { RequestID = 0335A8724B8F8F5B0DB6908CCE7CEFCC, Player = Player { Id = 745EF36C1E46811A, TargetDimension = 1 }, IsCancellation = False, PasswordOrToken =  }. Looking for player partition
2026-09-18T10:39:04Z [10:39:04 9 INF Main] Player 745EF36C1E46811A requested WorldPartition { PartitionId = 31, ServerId = targetServer31, Map = Survival_1, PartitionDefinition = {"box": {}}, DimensionIndex = 1, Blocked = False, Label = Alraab }. Teleport not allowed, returning to WorldPartition { PartitionId = 133, ServerId = , Map = CB_Story_OrbitalMonitor, PartitionDefinition = {"box": {}}, DimensionIndex = 0, Blocked = False, Label = OrbitalMonitor_0 }, setting return dimension to 1.
LOG

rejected_output="$(REJECTED_LOG="$rejected_log" REJECTED_SQL="$rejected_sql" REJECTED_SEEN="$rejected_seen" bash -c "$rejected_function
docker() { cat \"\$REJECTED_LOG\"; }
hub_travel_seen() { grep -qx \"\$1\" \"\$REJECTED_SEEN\"; }
remember_hub_travel() { printf '%s\\n' \"\$1\" >> \"\$REJECTED_SEEN\"; }
director_heal_due() { return 0; }
psql_value() {
  printf '%s\\n' \"\$1\" >> \"\$REJECTED_SQL\"
  case \"\$1\" in
    *"'COMPLETED-'"*) printf 'COMPLETED-42-133|745EF36C1E46811A|31|targetServer31|Survival_1|1|133|storyServer133|CB_Story_OrbitalMonitor|0\\n' ;;
    *'select a.id'*) printf '42\\n' ;;
    *'admin_move_offline_player_to_partition'*) printf 'SET\\n42|owned-respawn|1\\n' ;;
  esac
}
NAMED_DESTINATION_SINCE=10m
NAMED_DESTINATION_SCAN_SECONDS=60
scan_rejected_story_returns
scan_rejected_story_returns")"

test "$(grep -c '^STORY-RETURN account=42 request=0335A8724B8F8F5B0DB6908CCE7CEFCC ' <<<"$rejected_output")" -eq 1
test "$(grep -c '^STORY-RETURN account=42 request=COMPLETED-42-133 ' <<<"$rejected_output")" -eq 1
grep -Fq 'action=moved-pawn' <<< "$rejected_output"
grep -Fq 'location=owned-respawn' <<< "$rejected_output"
grep -Fq 'recovered_vehicles=1' <<< "$rejected_output"
grep -Fq "server_id = 'targetServer31'" "$rejected_sql"
grep -Fq "ps.server_id = 'targetServer31' or ps.previous_server_partition_id = 133" "$rejected_sql"
grep -Fq 'pawn.partition_id = 133' "$rejected_sql"
grep -Fq "dune.is_player_offline('745EF36C1E46811A')" "$rejected_sql"
grep -Fq 'dune.admin_move_offline_player_to_partition' "$rejected_sql"
grep -Fq 'dune.player_respawn_locations' "$rejected_sql"
grep -Fq 'candidate.candidate_count = 1' "$rejected_sql"
grep -Fq 'candidate.priority_rank = 1' "$rejected_sql"
grep -Fq ') fallback on true' "$rejected_sql"
grep -Fq 'coalesce(array_agg(vehicle.id), array[]::bigint[])' "$rejected_sql"
grep -Fq 'when cardinality(stranded.stranded_vehicle_ids) > 0' "$rejected_sql"
grep -Fq 'dune.store_recovered_vehicles_wiped_before_spawn' "$rejected_sql"
if grep -Fq "eligible.recovery_source = 'owned-respawn'" "$rejected_sql"; then
  echo "all stranded story vehicles must be sent to Vehicle Recovery" >&2
  exit 1
fi
if grep -Fq 'delete from dune.travel_return_info' "$rejected_sql"; then
  echo "story return recovery must preserve the game-owned return record" >&2
  exit 1
fi

# A rejected credits return produces a generic story-map demand immediately
# after the refusal. Suppress exactly that synthetic demand while preserving a
# later legitimate inbound request for the same map.
demand_function="$(python3 - "$script" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
start = text.index("scan_travel_demand()")
end = text.index("follow_director_travel_demand()", start)
print(text[start:end])
PY
)"
demand_log="$(mktemp)"
trap 'rm -f "$hub_file" "$hub_file.lock" "$replay_log" "$rejected_log" "$rejected_sql" "$rejected_seen" "$demand_log"' EXIT
cat >"$demand_log" <<'LOG'
2026-09-19T12:33:58Z Player A requested WorldPartition { PartitionId = 1, ServerId = hagga, Map = Survival_1, DimensionIndex = 0 }. Teleport not allowed, returning to WorldPartition { PartitionId = 32, ServerId = , Map = CB_Story_OrbitalMonitor, DimensionIndex = 0 }, setting return dimension to 0.
2026-09-19T12:33:58Z Received travel request for 1 player(s) to CB_Story_OrbitalMonitor (instancingMode=ClassicalInstancing)
2026-09-19T12:40:00Z Received travel request for 1 player(s) to CB_Story_OrbitalMonitor (instancingMode=ClassicalInstancing)
2026-09-19T12:40:01Z Received travel request for 1 player(s) to CB_Story_DestroyedZanovar (instancingMode=ClassicalInstancing)
LOG
demand_output="$(DEMAND_LOG="$demand_log" bash -c "$demand_function
docker() { cat \"\$DEMAND_LOG\"; }
handle_demand() { printf 'HANDLE|%s|%s|%s|%s\\n' \"\$1\" \"\$2\" \"\$4\" \"\$5\"; }
SINCE=10m
scan_travel_demand")"
test "$(grep -c '^HANDLE|CB_Story_OrbitalMonitor|1|request|ClassicalInstancing$' <<<"$demand_output")" -eq 1
test "$(grep -c '^HANDLE|CB_Story_DestroyedZanovar|1|request|ClassicalInstancing$' <<<"$demand_output")" -eq 1

# Exercise live alignment against production-shaped pawn ownership. Story
# players are never aligned over their saved return destination, and metadata
# is aligned only when the pawn actually belongs to that server partition.
if [ -n "${DUNE_TEST_POSTGRES_CONTAINER:-}" ]; then
  alignment_result="$(python3 - "$script" <<'PY' | docker exec -i "$DUNE_TEST_POSTGRES_CONTAINER" psql -X -v ON_ERROR_STOP=1 -U postgres -d dune -Atq -F '|'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
query = text.split('scan_live_player_partition_alignment() {', 1)[1].split('-c "', 1)[1].split('\n  " | while', 1)[0]
for old, new in (
    ("dune.player_state", "test_align_player_state"),
    ("dune.world_partition", "test_align_world_partition"),
    ("dune.actors", "test_align_actors"),
):
    query = query.replace(old, new)
print("begin;")
print("create temp table test_align_player_state (account_id bigint, player_pawn_id bigint, server_id text, previous_server_partition_id bigint, return_dimension_index integer, online_status text);")
print("create temp table test_align_world_partition (server_id text, partition_id bigint, map text, dimension_index integer);")
print("create temp table test_align_actors (id bigint, partition_id bigint);")
print("insert into test_align_world_partition values ('story-server', 133, 'CB_Story_OrbitalMonitor', 0), ('hagga-server', 31, 'Survival_1', 1), ('normal-server', 3, 'SH_Arrakeen', 0);")
print("insert into test_align_actors values (102, 133), (103, 3), (104, 31);")
print("insert into test_align_player_state values (2, 102, 'story-server', 31, 1, 'Online'), (3, 103, 'normal-server', 31, 1, 'Online'), (4, 104, 'normal-server', 31, 1, 'Online');")
print(query)
print("rollback;")
PY
  )"
  grep -qx '3|normal-server|3|0|31' <<< "$alignment_result"
  if grep -Eq '^(2|4)\|' <<< "$alignment_result"; then
    echo "live alignment must skip story maps and pawn/server disagreement" >&2
    exit 1
  fi
fi

echo "autoscaler preserves story return state and moves eligible offline pawns"
