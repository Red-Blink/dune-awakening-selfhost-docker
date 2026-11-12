#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

test_root="$(mktemp -d)"
container="dune-autoscaler-occupancy-test-$$"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  rm -rf "$test_root"
}
trap cleanup EXIT

python3 - "$test_root/function.sh" <<'PY'
from pathlib import Path
import sys

source = Path("runtime/scripts/autoscaler.sh").read_text(encoding="utf-8")
start = source.index("occupied_dimensions_for_map() {")
end = source.index("\ncontainer_count_for_map() {", start)
scan_start = source.index("scan_idle_servers() {")
scan_end = source.index("\n# Hyper-V scales", scan_start)
Path(sys.argv[1]).write_text(source[start:end].rstrip() + "\n" + source[scan_start:scan_end] + "\n", encoding="utf-8")
PY

docker run -d --rm \
  --name "$container" \
  -e POSTGRES_PASSWORD=postgres \
  postgres:17-alpine >/dev/null

ready=0
for _ in $(seq 1 60); do
  # A fresh official PostgreSQL container starts a temporary server for initdb,
  # stops it, then starts the final server. Waiting on pg_isready alone can
  # catch that temporary process and race its intentional shutdown on the next
  # psql call. Require both readiness markers, as the bootstrap integration
  # test does, before treating the disposable database as stable.
  ready_markers="$(docker logs "$container" 2>&1 | grep -c 'database system is ready to accept connections' || true)"
  if [ "$ready_markers" -ge 2 ] \
    && docker exec "$container" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "Disposable PostgreSQL did not reach its final ready state." >&2
  docker logs "$container" >&2 || true
  exit 1
fi

docker exec -i "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
create schema dune;

create table dune.farm_state (
  server_id text primary key,
  map text not null,
  connected_players integer not null default 0,
  ready boolean not null default true,
  alive boolean not null default true
);

create table dune.world_partition (
  partition_id bigint primary key,
  server_id text,
  map text not null
);

create table dune.actors (
  id bigint primary key,
  partition_id bigint
);

create table dune.player_state (
  player_pawn_id bigint,
  server_id text,
  previous_server_partition_id bigint,
  online_status text,
  reconnect_grace_period_end timestamp without time zone,
  last_avatar_activity timestamp without time zone
);

insert into dune.farm_state (server_id, map) values
  ('overmap-server', 'Overmap'),
  ('hephaestus-story-server', 'CB_Story_Hephaestus'),
  ('hephaestus-server', 'CB_Dungeon_Hephaestus');

insert into dune.world_partition (partition_id, server_id, map) values
  (1, 'overmap-server', 'Overmap'),
  (5, 'hephaestus-story-server', 'CB_Story_Hephaestus'),
  (14, 'hephaestus-server', 'CB_Dungeon_Hephaestus');

insert into dune.actors (id, partition_id) values
  (101, 14),
  (102, 5);

-- This is the reported travel shape: only the pawn has reached Hephaestus;
-- player_state still names the source server and source partition.
insert into dune.player_state (
  player_pawn_id,
  server_id,
  previous_server_partition_id,
  online_status
) values
  (101, 'overmap-server', 1, 'Online'),
  (102, 'overmap-server', 1, 'Online');
SQL

CONTAINER="$container" FUNCTION_FILE="$test_root/function.sh" bash <<'SH'
set -euo pipefail

psql_value() {
  docker exec "$CONTAINER" psql -U postgres -d postgres -Atc "$1"
}

IDLE_SECONDS=300
source runtime/scripts/lib/game-presence.sh
source "$FUNCTION_FILE"

# The pawn's authoritative partition must reserve the first isolated instance
# even while player_state still points at the source server.
[ "$(occupied_dimensions_for_map CB_Dungeon_Hephaestus | tr -d '[:space:]')" = "1" ]
[ "$(occupied_dimensions_for_map CB_Story_Hephaestus | tr -d '[:space:]')" = "1" ]

# The server connection counter remains authoritative when the story map has
# left the central player row at Offline with no reconnect/activity grace.
docker exec "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "update dune.player_state set online_status = 'Offline';
      update dune.farm_state set connected_players = 1
      where map in ('CB_Dungeon_Hephaestus', 'CB_Story_Hephaestus');" >/dev/null
[ "$(occupied_dimensions_for_map CB_Dungeon_Hephaestus | tr -d '[:space:]')" = "1" ]
[ "$(occupied_dimensions_for_map CB_Story_Hephaestus | tr -d '[:space:]')" = "1" ]

# A genuinely empty server and stale offline pawn must not hold capacity.
docker exec "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "update dune.farm_state set connected_players = 0;" >/dev/null
[ "$(occupied_dimensions_for_map CB_Dungeon_Hephaestus | tr -d '[:space:]')" = "0" ]
[ "$(occupied_dimensions_for_map CB_Story_Hephaestus | tr -d '[:space:]')" = "0" ]

# Recent activity retains capacity during the established idle grace window.
docker exec "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -c "update dune.player_state set last_avatar_activity = current_timestamp;" >/dev/null
[ "$(occupied_dimensions_for_map CB_Dungeon_Hephaestus | tr -d '[:space:]')" = "1" ]
[ "$(occupied_dimensions_for_map CB_Story_Hephaestus | tr -d '[:space:]')" = "1" ]

# Zero idle grace remains a supported setting; stale Offline rows do not hold
# an instance when its most recent activity predates this query.
IDLE_SECONDS=0
[ "$(occupied_dimensions_for_map CB_Story_Hephaestus | tr -d '[:space:]')" = "0" ]
IDLE_SECONDS=300

# The idle scan must choose one deterministic READY spare, while counting
# live native connections even when central player rows are absent.
docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
insert into dune.farm_state(server_id,map,connected_players,ready) values
 ('bandit-busy','CB_Story_BanditFortress01',1,true),
 ('bandit-warming','CB_Story_BanditFortress01',0,false),
 ('bandit-spare','CB_Story_BanditFortress01',0,true),
 ('bandit-extra','CB_Story_BanditFortress01',0,true);
insert into dune.world_partition(partition_id,server_id,map) values
 (27,'bandit-busy','CB_Story_BanditFortress01'),
 (43,'bandit-warming','CB_Story_BanditFortress01'),
 (44,'bandit-spare','CB_Story_BanditFortress01'),
 (45,'bandit-extra','CB_Story_BanditFortress01');
SQL
dune_psql() { docker exec "$CONTAINER" psql -U postgres -d postgres "$@"; }
remember_server_id_map() { :; }
ensure_isolated_story_spare() { :; }
handle_idle_row() { printf '%s|%s|%s|%s\n' "$1" "$2" "$8" "$9"; }
scan_output="$(scan_idle_servers standard)"
for partition in 27 43 44 45; do
  grep -qx "CB_Story_BanditFortress01|$partition|44|1" <<< "$scan_output"
done
SH

echo "Autoscaler counts live server connections and pawn-resident players in isolated activity dimensions."
