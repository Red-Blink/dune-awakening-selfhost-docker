#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
source "$repo_root/runtime/scripts/game-server-roster.sh"

failures=0

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

expect_eq() {
  local label="$1" want="$2" got="$3"
  if [ "$want" != "$got" ]; then
    fail "$label: want [$want] got [$got]"
  fi
}

# The real dune2 layout, captured 2026-08-31: Survival_1 and DeepDesert_1 each
# have two partitions. "map|partition|db_ready", protected maps INCLUDED --
# excluding them the way map-modes.sh list does would drop Survival_1's second
# partition, which is the whole bug this section exists to fix.
DUNE2_ROWS="DeepDesert_1|8
DeepDesert_1|59
Overmap|2
SH_Arrakeen|3
SH_HarkoVillage|4
Survival_1|1
Survival_1|60"

DUNE2_ALWAYS_ON="SH_Arrakeen
SH_HarkoVillage
DeepDesert_1"

roster() {
  game_server_expected_roster "$1" "$2"
}

field() {
  printf '%s\n' "$1" | awk -F '|' -v c="$2" '{print $c}' | paste -sd, -
}

# --- container naming -------------------------------------------------------

# The protected pair have fixed names with no partition suffix; they are started
# by dedicated scripts, not spawn-server.sh. Applying the slug rule to them gives
# dune-server-survival-1-1 / dune-server-overmap-2, which do not exist.
expect_eq "survival_1 partition 1 has no suffix" \
  "dune-server-survival-1" "$(game_server_container_name Survival_1 1)"
expect_eq "overmap partition 2 has no suffix" \
  "dune-server-overmap" "$(game_server_container_name Overmap 2)"

# ...but Survival_1's other partitions ARE spawned normally and do carry it.
expect_eq "survival_1 partition 60 is slugged" \
  "dune-server-survival-1-60" "$(game_server_container_name Survival_1 60)"

expect_eq "underscore and case are slugged" \
  "dune-server-deepdesert-1-8" "$(game_server_container_name DeepDesert_1 8)"
expect_eq "leading capitals are slugged" \
  "dune-server-sh-harkovillage-4" "$(game_server_container_name SH_HarkoVillage 4)"

# Divergence guard. map-modes.sh:364-371 slugs without collapsing runs of
# dashes or trimming the ends, so for a name with adjacent non-alphanumerics it
# computes a container spawn-server.sh would never create. This asserts the
# spawn-server behaviour, which is the one docker actually sees.
expect_eq "runs of separators collapse" \
  "dune-server-foo-bar-7" "$(game_server_container_name 'Foo__Bar' 7)"
expect_eq "leading separator is trimmed" \
  "dune-server-foo-3" "$(game_server_container_name '_Foo' 3)"

# partition_id is a global nextval sequence, not a per-map index, and both
# protected ids are operator-overridable -- start-server-*.sh and
# stop-server-*.sh read these same two variables. Hardcoding 1 and 2 meant that
# on an overridden install the real partition slugged to a container nobody
# creates (a permanent NOT RUNNING) while an unrelated partition claimed the
# bare name. These four assertions are the inversion: with an override set, the
# overridden id takes the bare name and the old default is slugged like any
# ordinary partition.
(
  export DUNE_OVERMAP_PARTITION_ID=77
  expect_eq "overridden overmap id takes the bare name" \
    "dune-server-overmap" "$(game_server_container_name Overmap 77)"
  expect_eq "the old default overmap id is slugged once overridden" \
    "dune-server-overmap-2" "$(game_server_container_name Overmap 2)"
)
(
  export DUNE_SURVIVAL_PARTITION_ID=42
  expect_eq "overridden survival id takes the bare name" \
    "dune-server-survival-1" "$(game_server_container_name Survival_1 42)"
  expect_eq "the old default survival id is slugged once overridden" \
    "dune-server-survival-1-1" "$(game_server_container_name Survival_1 1)"
)

# --- roster derivation ------------------------------------------------------

full="$(roster "$DUNE2_ALWAYS_ON" "$DUNE2_ROWS")"

expect_eq "dune2 roster is seven servers" "7" "$(printf '%s\n' "$full" | grep -c .)"

# Protected pair first, then always-on in startup-priority order, partitions
# ascending within a map.
expect_eq "roster order" \
  "Survival_1,Survival_1#60,Overmap,SH_Arrakeen,SH_HarkoVillage,DeepDesert_1,DeepDesert_1#59" \
  "$(field "$full" 1)"

expect_eq "container names" \
  "dune-server-survival-1,dune-server-survival-1-60,dune-server-overmap,dune-server-sh-arrakeen-3,dune-server-sh-harkovillage-4,dune-server-deepdesert-1-8,dune-server-deepdesert-1-59" \
  "$(field "$full" 4)"

# No duplicate containers: two rows resolving to one container would make their
# states indistinguishable.
expect_eq "container names are unique" "7" \
  "$(field "$full" 4 | tr ',' '\n' | sort -u | grep -c .)"

# The label rule is not cosmetic. ServerPanels.tsx detects a stopped battlegroup
# with /Survival_1\s+NOT RUNNING/ and /Overmap\s+NOT RUNNING/, so the lowest
# partition of a map must keep the bare name.
expect_eq "lowest partition keeps the bare label" "Survival_1" \
  "$(printf '%s\n' "$full" | awk -F '|' '$2 == "Survival_1"' | head -1 | cut -d '|' -f1)"

# A fresh install with no always-on maps configured must still report the
# protected pair -- never fewer.
minimal="$(roster "" "Overmap|2
Survival_1|1")"
expect_eq "no always-on maps still yields the protected pair" \
  "Survival_1,Overmap" "$(field "$minimal" 1)"

# An always-on map with no partition rows contributes nothing rather than a
# phantom server.
expect_eq "always-on map absent from world_partition yields no row" \
  "Survival_1,Overmap" \
  "$(field "$(roster "Nonexistent_Map" "Overmap|2
Survival_1|1")" 1)"

# Blocked partitions are excluded by the caller's SQL; a blocked row simply
# never arrives. Confirm a map whose only extra partition is withheld drops back
# to a single bare label.
expect_eq "withheld partition drops the suffix" "DeepDesert_1" \
  "$(field "$(roster "DeepDesert_1" "DeepDesert_1|8")" 1)"

# A garbled psql result must not become a phantom server.
expect_eq "non-numeric partition ids are dropped" "Survival_1" \
  "$(field "$(roster "" "Survival_1|1
Survival_1|abc
Survival_1|")" 1)"

# map-modes.sh already filters the protected pair out of its always-on list, but
# a stale list must not duplicate their partitions.
expect_eq "protected map in the always-on list is not duplicated" \
  "Survival_1,Overmap" \
  "$(field "$(roster "Survival_1
Overmap" "Overmap|2
Survival_1|1")" 1)"

# --- rendered row format ----------------------------------------------------

# Every consumer parses rows with ^(\S+)\s+(.+?)\s{2,}(.+)$ after trimming the
# line. Merely matching is not the contract -- a malformed row can still match
# and be silently MISPARSED, so these assert the extracted fields.
#
# parse_row reproduces that regex faithfully: the MAP token is the first
# whitespace-free run, and the lazy (.+?) means STATE is the shortest prefix
# before the first run of >= 2 spaces. Emits "map<TAB>state<TAB>uptime", or
# nothing when the line does not parse at all.
parse_row() {
  printf '%s\n' "$1" | awk '
    {
      line = $0
      sub(/[ \t]+$/, "", line)
      if (!match(line, /^[^ \t]+[ \t]+/)) next
      map = substr(line, 1, RLENGTH)
      sub(/[ \t]+$/, "", map)
      rest = substr(line, RLENGTH + 1)
      if (!match(rest, /[ \t][ \t]+/)) next
      state = substr(rest, 1, RSTART - 1)
      uptime = substr(rest, RSTART + RLENGTH)
      if (state == "" || uptime == "") next
      printf "%s\t%s\t%s\n", map, state, uptime
    }'
}

render_row() {
  printf '%-24s %-13s %s' "$1" "$2" "$3"
}

check_row_parses() {
  local label="$1" state="$2" uptime="$3"
  expect_eq "row [$label|$state|$uptime] parses" \
    "$(printf '%s\t%s\t%s' "$label" "$state" "$uptime")" \
    "$(parse_row "$(render_row "$label" "$state" "$uptime")")"
}

check_row_parses "Survival_1" "READY" "Up 15 hours"
check_row_parses "DeepDesert_1#59" "NOT RUNNING" "missing"
check_row_parses "SH_HarkoVillage" "WAIT" "unknown"
check_row_parses "Survival_1#60" "WARMING" "Up 3 seconds"

# Why the "#" label form exists rather than "Map partition N": a space in the
# label does not fail the regex, it silently misparses -- the map becomes the
# first word and the state becomes the rest of the label.
expect_eq "a space in the label misparses rather than failing" \
  "Survival_1" \
  "$(parse_row "$(render_row 'Survival_1 partition 60' READY 'Up 15 hours')" | cut -f1)"

# Why the uptime column is never emitted empty: container_status can return an
# empty string, and after trimming there is no >= 2-space run left, so the row
# does not parse and vanishes from the console entirely.
expect_eq "an empty uptime makes the row vanish" "" \
  "$(parse_row "$(render_row Survival_1 READY '')")"

# --- roll-up ----------------------------------------------------------------

expect_issue() {
  if ! game_server_rows_have_issue "$2"; then fail "$1: expected an issue"; fi
}
expect_no_issue() {
  if game_server_rows_have_issue "$2"; then fail "$1: expected no issue"; fi
}
expect_warming() {
  if ! game_server_rows_have_warming "$2"; then fail "$1: expected warming"; fi
}
expect_no_warming() {
  if game_server_rows_have_warming "$2"; then fail "$1: expected no warming"; fi
}

ALL_READY="$(printf '%-24s %-13s %s\n' Survival_1 READY 'Up 15 hours' Overmap READY 'Up 15 hours')"
expect_no_issue "all ready" "$ALL_READY"
expect_no_warming "all ready" "$ALL_READY"

expect_issue "not running" "$(printf '%-24s %-13s %s\n' Survival_1 'NOT RUNNING' missing)"
expect_issue "error" "$(printf '%-24s %-13s %s\n' Survival_1 ERROR 'Up 2 minutes')"
expect_warming "warming" "$(printf '%-24s %-13s %s\n' Survival_1 WARMING 'Up 9 seconds')"

# A not-yet-spawned always-on map is not a fault: it reads WAIT, which is
# warming rather than an issue. Rendering it NOT RUNNING would put Overall:
# ISSUE on every clean boot.
expect_warming "wait is warming" "$(printf '%-24s %-13s %s\n' SH_Arrakeen WAIT unknown)"
expect_no_issue "wait is not an issue" "$(printf '%-24s %-13s %s\n' SH_Arrakeen WAIT unknown)"

# The uptime column carries container_status output, which is lowercase.
expect_issue "lowercase missing in the uptime column" \
  "$(printf '%-24s %-13s %s\n' SH_Arrakeen 'NOT RUNNING' missing)"

# Why status.sh writes "pending" rather than "missing" in a WAIT row's uptime
# column: this roll-up and summarizeGameServers both scan the WHOLE row, so a
# queued map would raise an issue on the uptime alone and WAIT would achieve
# nothing. These two assertions are the reason that substitution exists.
expect_no_issue "queued map with a pending uptime is not an issue" \
  "$(printf '%-24s %-13s %s\n' SH_Arrakeen WAIT pending)"
expect_issue "the same row with a missing uptime WOULD be an issue" \
  "$(printf '%-24s %-13s %s\n' SH_Arrakeen WAIT missing)"

# core_stack_up reads the container table rather than asking docker, so it is
# testable here. Rows are status.sh's "%-26s %s" layout.
core_row() { printf '%-26s %s\n' "$1" "$2"; }
core_table() {
  local status="$1" name
  for name in $GAME_SERVER_CORE_CONTAINERS; do core_row "$name" "$status"; done
}

expect_eq "every core container up" "1" "$(game_server_core_stack_up "$(core_table 'Up 15 hours')")"
expect_eq "every core container missing" "0" "$(game_server_core_stack_up "$(core_table missing)")"
expect_eq "empty table is not up" "0" "$(game_server_core_stack_up "")"

# One down is enough, and the orchestrator being up must not make up for it --
# counting the printed rows rather than the eight names is exactly how the
# original container bug worked.
core_table_with() {
  # The full table with one service replaced, plus any extra rows.
  local name="$1" status="$2"
  shift 2
  core_table 'Up 15 hours' | grep -v "^${name} "
  [ -n "$status" ] && core_row "$name" "$status"
  while [ "$#" -gt 0 ]; do core_row "$1" 'Up 15 hours'; shift; done
  return 0
}

expect_eq "one core container down" "0" \
  "$(game_server_core_stack_up "$(core_table_with dune-director missing)")"

# The orchestrator and coordinator being up must not make up for a missing core
# service -- counting printed rows rather than the eight names is exactly how
# the original container bug worked.
expect_eq "extra containers do not substitute for a missing one" "0" \
  "$(game_server_core_stack_up "$(core_table_with dune-postgres '' dune-orchestrator dune-coriolis-coordinator)")"

# A paused container is not serving, so it must not count as up.
expect_eq "a paused core container is not up" "0" \
  "$(game_server_core_stack_up "$(core_table_with dune-rmq-game 'Up 3 hours (Paused)')")"

# An always-on map with no container is pending while the battlegroup is still
# coming up, queued while the stack is up but inside the grace window, and a
# fault after that. Reading NOT RUNNING as soon as the core stack was up made a
# Start report success while the autoscaler was still spawning maps.
expect_eq "absent map while the stack is still starting is pending" \
  "WAIT" "$(game_server_absent_state 0 0)"
expect_eq "absent map with the stack down stays pending inside the window" \
  "WAIT" "$(game_server_absent_state 0 1)"
expect_eq "absent map inside the grace window is queued" \
  "QUEUED" "$(game_server_absent_state 1 1)"
expect_eq "absent map past the grace window is a fault" \
  "NOT RUNNING" "$(game_server_absent_state 1 0)"
expect_eq "absent map with no window reading is a fault" \
  "NOT RUNNING" "$(game_server_absent_state 1)"
# Unset/garbage must fail safe to pending rather than crying wolf mid-start.
expect_eq "absent map with no stack reading is pending" \
  "WAIT" "$(game_server_absent_state)"

# The states differ in the roll-up, which is the whole point of the split.
expect_no_issue "a pending map is not an issue" \
  "$(printf '%-24s %-13s %s\n' SH_Arrakeen "$(game_server_absent_state 0 0)" pending)"
expect_no_issue "a queued map is not an issue" \
  "$(printf '%-24s %-13s %s\n' SH_Arrakeen "$(game_server_absent_state 1 1)" queued)"
expect_warming "a queued map is warming" \
  "$(printf '%-24s %-13s %s\n' SH_Arrakeen "$(game_server_absent_state 1 1)" queued)"
expect_issue "a map absent past the window is an issue" \
  "$(printf '%-24s %-13s %s\n' SH_Arrakeen "$(game_server_absent_state 1 0)" missing)"
expect_issue "a memory-blocked map past the window is an issue" \
  "$(printf '%-24s %-13s %s\n' SH_Arrakeen 'NOT RUNNING' 'missing - waiting for host memory (3 GiB free, 9 GiB needed)')"

# Youngest core container age, from status.sh's "name|state|status" snapshot.
snap_row() { printf '%s|running|%s\n' "$1" "$2"; }
core_snapshot() {
  # Every core container at $1, with dune-server-gateway (started last) at $2.
  local name
  for name in $GAME_SERVER_CORE_CONTAINERS; do
    if [ "$name" = "dune-server-gateway" ]; then snap_row "$name" "$2"; else snap_row "$name" "$1"; fi
  done
}
expect_eq "age is the youngest core container" "180" \
  "$(game_server_core_youngest_age "$(core_snapshot 'Up 2 hours' 'Up 3 minutes')")"
expect_eq "seconds parse" "45" \
  "$(game_server_core_youngest_age "$(core_snapshot 'Up 2 hours' 'Up 45 seconds')")"
expect_eq "less than a second parses" "0" \
  "$(game_server_core_youngest_age "$(core_snapshot 'Up 2 hours' 'Up Less than a second')")"
expect_eq "about a minute parses" "60" \
  "$(game_server_core_youngest_age "$(core_snapshot 'Up 2 hours' 'Up About a minute')")"
expect_eq "a health suffix is ignored" "300" \
  "$(game_server_core_youngest_age "$(core_snapshot 'Up 2 hours (healthy)' 'Up 5 minutes (healthy)')")"
expect_eq "days are old" "86400" \
  "$(game_server_core_youngest_age "$(core_snapshot 'Up 3 days' 'Up 2 weeks')")"
expect_eq "a core container that is not up gives no age" "" \
  "$(game_server_core_youngest_age "$(core_snapshot 'Up 2 hours' 'Exited (0) 3 minutes ago')")"
expect_eq "a missing core container gives no age" "" \
  "$(game_server_core_youngest_age "$(core_snapshot 'Up 2 hours' 'Up 3 minutes' | grep -v '^dune-director|')")"
expect_eq "an unparseable status gives no age" "" \
  "$(game_server_core_youngest_age "$(core_snapshot 'Up 2 hours' 'Up soon')")"
expect_eq "non-core containers do not count" "7200" \
  "$(game_server_core_youngest_age "$(core_snapshot 'Up 2 hours' 'Up 2 hours'; snap_row dune-autoscaler 'Up 10 seconds')")"
expect_eq "empty snapshot gives no age" "" "$(game_server_core_youngest_age "")"

# Grace window: 4 minutes per batch, floor 10, cap 45.
expect_eq "few maps get the floor" "600" "$(game_server_queue_grace_seconds 4 2)"
expect_eq "batches scale the window" "960" "$(game_server_queue_grace_seconds 8 2)"
expect_eq "a partial batch rounds up" "1200" "$(game_server_queue_grace_seconds 9 2)"
expect_eq "the window is capped" "2700" "$(game_server_queue_grace_seconds 40 1)"
expect_eq "bad concurrency reads as one" "960" "$(game_server_queue_grace_seconds 4 0)"
expect_eq "no reading gets the floor" "600" "$(game_server_queue_grace_seconds)"

expect_no_issue "empty section" ""
expect_no_warming "empty section" ""

if [ "$failures" -ne 0 ]; then
  echo "game-server-roster: $failures check(s) failed" >&2
  exit 1
fi

echo "game-server-roster: all checks passed"
