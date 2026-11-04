#!/usr/bin/env bash
# Pure helpers for the "=== Game servers ===" section of status.sh.
#
# Sourced, never executed: no `cd`, no `set -e`, no top-level work, and no
# docker/psql/python. Every input arrives as a string so the whole thing is
# testable without a running battlegroup -- see
# runtime/tests/test-game-server-roster.sh.
#
# Why this exists: status.sh used to hardcode two rows (Survival_1, Overmap).
# A host runs one server per non-blocked world_partition row of every map that
# is always-on, which on a real install is several more -- including a second
# Survival_1 partition that the two hardcoded rows hid completely. Reporting
# only two made the console's Game Servers row read OK while other maps were
# still warming.
#
# The expected set is derived from CONFIGURATION, never from `docker ps`: an
# always-on map whose container is missing must be reported, not omitted.
#
# That invariant is about docker, and deliberately stops at the database. A
# configured map with no non-blocked world_partition row contributes no row at
# all, which does under-report a map that genuinely lost its partition. The
# alternative is worse: map-modes.sh's canonical_map() falls back to raw user
# input when Postgres is unreachable, so an unrecognised name can persist in
# map-runtime-modes.json -- and synthesising a row for it would manufacture a
# NOT RUNNING server from a typo and put the whole battlegroup in ISSUE. A
# phantom fault is louder and harder to diagnose than a missing line.

# Container name for a map + partition.
#
# This mirrors spawn-server.sh's slug (the name docker actually receives):
# the map and partition are slugified TOGETHER, then runs of dashes are
# collapsed and any leading/trailing dash trimmed. map-modes.sh has its own
# copy that omits the collapse/trim and can therefore compute a name that was
# never created; do not use that one here.
game_server_container_name() {
  local slug

  # The two protected partitions are brought up by dedicated scripts
  # (start-server-survival-1.sh / start-server-overmap.sh), not spawn-server.sh,
  # and carry fixed names with no partition suffix. status.sh:181-186 encodes the
  # same pairing in reverse. Applying the slug rule to them yields
  # dune-server-survival-1-1 / dune-server-overmap-2, which do not exist -- every
  # row for the two most important maps would read NOT RUNNING forever.
  #
  # Only these exact pairings are special. Survival_1's other partitions are
  # spawned normally, so partition 60 correctly slugs to
  # dune-server-survival-1-60.
  #
  # The ids are read rather than hardcoded: partition_id is a global nextval
  # sequence, not a per-map index, and both protected ids are overridable --
  # start-server-*.sh and stop-server-*.sh read these same two variables with
  # these same defaults. Hardcoding 1 and 2 meant that on an overridden install
  # the real partition slugged to a container nobody creates (a permanent
  # NOT RUNNING) while some unrelated partition claimed the bare name.
  if [ "$1" = "Survival_1" ] && [ "$2" = "${DUNE_SURVIVAL_PARTITION_ID:-1}" ]; then
    printf 'dune-server-survival-1\n'
    return 0
  fi
  if [ "$1" = "Overmap" ] && [ "$2" = "${DUNE_OVERMAP_PARTITION_ID:-2}" ]; then
    printf 'dune-server-overmap\n'
    return 0
  fi

  slug="$(printf '%s-%s' "$1" "$2" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')"
  printf 'dune-server-%s\n' "$slug"
}

# True when a map is one of the two protected always-on maps. These are never
# present in map-runtime-modes.json (map-modes.sh's `set` rejects them), so they
# have to be named explicitly rather than discovered.
game_server_map_is_protected() {
  case "$1" in
    Survival_1|Overmap) return 0 ;;
    *) return 1 ;;
  esac
}

# game_server_expected_roster <always_on_maps> <partition_rows>
#
#   always_on_maps  newline-separated map names, in startup-priority order
#                   (from `map-modes.sh always-on-maps`)
#   partition_rows  "map|partition_id|db_ready" lines for every NON-BLOCKED
#                   world_partition row, protected maps INCLUDED
#
# Emits one record per expected server:
#
#   label|map|partition_id|container|db_ready
#
# Ordering is protected pair first, then configured always-on maps in the order
# given, partitions ascending within a map.
#
# Labels: the lowest partition of a map keeps the bare map name and additional
# partitions get "#<partition>". The bare first label is not cosmetic --
# ServerPanels.tsx matches /Survival_1\s+NOT RUNNING/ and /Overmap\s+NOT RUNNING/
# to detect a stopped battlegroup, and a "Survival_1#1" label would silently
# break that.
game_server_expected_roster() {
  local always_on="$1" partition_rows="$2" map

  {
    printf 'Survival_1\nOvermap\n'
    printf '%s\n' "$always_on"
  } | while IFS= read -r map; do
    [ -n "$map" ] || continue
    game_server_rows_for_map "$map" "$partition_rows"
  done | awk -F '|' '!seen[$2 "|" $3]++'
  # The awk dedup is load-bearing, not defensive tidiness: the protected pair is
  # seeded above, so an always-on list that still names Survival_1 or Overmap
  # would otherwise emit that map's partitions twice.
}

# Records for a single map, partitions ascending. Rows whose partition id is not
# numeric are dropped: a garbled psql result must not become a phantom server.
game_server_rows_for_map() {
  local map="$1" rows="$2" row_map pid first=1 label
  local sorted

  sorted="$(printf '%s\n' "$rows" | sort -t '|' -k1,1 -k2,2n)"

  while IFS='|' read -r row_map pid; do
    [ -n "$row_map" ] || continue
    [ "$row_map" = "$map" ] || continue
    case "$pid" in
      ''|*[!0-9]*) continue ;;
    esac
    if [ "$first" = "1" ]; then
      label="$map"
      first=0
    else
      label="$map#$pid"
    fi
    printf '%s|%s|%s|%s\n' "$label" "$map" "$pid" "$(game_server_container_name "$map" "$pid")"
  done <<EOF
$sorted
EOF
}

# The eight battlegroup services, as status.sh prints them in its container
# table. dune-orchestrator and dune-coriolis-coordinator are excluded for the
# same reasons as everywhere else: control plane, and optional.
GAME_SERVER_CORE_CONTAINERS="dune-postgres dune-rmq-admin dune-rmq-game dune-text-router dune-director dune-server-gateway dune-server-survival-1 dune-server-overmap"

# Is the battlegroup fully up? Reads the container table that has already been
# built rather than asking docker again: the first version called is_running per
# service, and each of those is a docker inspect -- eight of them added ~1.3s to
# every status read.
#
# A row counts as up only if its status carries no down word, so a paused
# container does not read as running.
game_server_core_stack_up() {
  printf '%s\n' "$1" | awk -v names="$GAME_SERVER_CORE_CONTAINERS" '
    BEGIN { total = split(names, want, " "); for (i = 1; i <= total; i++) need[want[i]] = 1 }
    {
      line = tolower($0)
      if (($1 in need) && line !~ /missing|stopped|exited|dead|paused|not running/) up[$1] = 1
    }
    END { seen = 0; for (k in up) seen++; print (seen == total) ? 1 : 0 }
  '
}

# Seconds since the most recently started core container came up, read from
# status.sh's "name|state|status" docker snapshot. Empty when any core container
# is not up or the age cannot be parsed, so callers fail safe to "not recent".
game_server_core_youngest_age() {
  printf '%s\n' "$1" | awk -F '|' -v names="$GAME_SERVER_CORE_CONTAINERS" '
    BEGIN { total = split(names, want, " "); for (i = 1; i <= total; i++) need[want[i]] = 1 }
    ($1 in need) {
      s = $3
      if (s !~ /^Up /) { bad = 1; next }
      sub(/^Up /, "", s); sub(/ \(.*$/, "", s)
      if (s ~ /^Less than a second/) age = 0
      else if (s ~ /^About a minute/) age = 60
      else if (s ~ /^About an hour/) age = 3600
      else {
        split(s, part, " "); n = part[1] + 0; unit = part[2]
        if (part[1] !~ /^[0-9]+$/) { bad = 1; next }
        if (unit ~ /^second/) age = n
        else if (unit ~ /^minute/) age = n * 60
        else if (unit ~ /^hour/) age = n * 3600
        else age = 86400
      }
      seen++
      if (min == "" || age < min) min = age
    }
    END { if (!bad && seen == total) print min }
  '
}

# How long after the core stack comes up an unspawned always-on map still reads
# QUEUED. Mirrors gameServerWarmupGraceMs in ServerPanels.tsx: the autoscaler
# spawns maps a batch at a time, so the window scales with the number of
# batches -- 4 minutes each, at least 10, at most 45.
game_server_queue_grace_seconds() {
  local maps="${1:-0}" concurrency="${2:-1}" batches grace
  case "$maps" in ''|*[!0-9]*) maps=0 ;; esac
  case "$concurrency" in ''|*[!0-9]*|0) concurrency=1 ;; esac
  batches=$(( (maps + concurrency - 1) / concurrency ))
  grace=$(( batches * 240 ))
  [ "$grace" -ge 600 ] || grace=600
  [ "$grace" -le 2700 ] || grace=2700
  printf '%s\n' "$grace"
}

# State for an expected map server whose container does not exist.
#
#   WAIT         the core stack is not fully up, so nothing can spawn it yet
#   QUEUED       the stack came up within the grace window and the autoscaler
#                has not reached it -- the same idea as the Maps tab's Queued.
#                The autoscaler only starts near the end of start-all.sh, so
#                this is time-based rather than a check for the autoscaler.
#   NOT RUNNING  the stack has been up past the grace window and it is still
#                absent, which is a fault whatever the reason
game_server_absent_state() {
  if [ "${1:-0}" != "1" ]; then
    printf 'WAIT\n'
  elif [ "${2:-0}" = "1" ]; then
    printf 'QUEUED\n'
  else
    printf 'NOT RUNNING\n'
  fi
}

# Roll-up over the RENDERED section body.
#
# status.sh builds the rows inside a command substitution, so any issue=/warming=
# assignment made while rendering them dies with the subshell -- the same trap
# documented in container-issue-scan.sh. The parent shell must call these on the
# finished text instead.
#
# The tokens deliberately mirror summarizeGameServers in ServerPanels.tsx so the
# shell's Overall: verdict and the console's health pill cannot disagree.
game_server_rows_have_issue() {
  local upper
  upper="$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
  case "$upper" in
    *ERROR*|*"NOT RUNNING"*|*MISSING*) return 0 ;;
  esac
  return 1
}

game_server_rows_have_warming() {
  local upper
  upper="$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
  case "$upper" in
    *WARMING*|*WAIT*|*QUEUED*) return 0 ;;
  esac
  return 1
}
