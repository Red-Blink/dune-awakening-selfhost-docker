#!/usr/bin/env bash

# Correlated player count for an outer farm_state fs/world_partition wp row.
# Shared by allocation, idle recycling and manual despawn: central server IDs
# can lag a pawn entering a story, and reconnect/activity grace is protective.
dune_game_player_count_sql() {
  local seconds="${1:-300}"
  [[ "$seconds" =~ ^[0-9]+$ ]] || return 2
  cat <<EOF
    select count(*) as effective_players
    from dune.player_state ps
    left join dune.actors pawn on pawn.id = ps.player_pawn_id
    left join dune.farm_state pfs on pfs.server_id = ps.server_id
    where (
      ps.server_id = fs.server_id
      or (wp.partition_id is not null and pawn.partition_id = wp.partition_id)
      or (
        wp.partition_id is not null
        and ps.previous_server_partition_id = wp.partition_id
        and (coalesce(ps.server_id, '') = '' or pfs.server_id is null or ps.server_id <> fs.server_id)
      )
    ) and (
      ps.online_status <> 'Offline'
      or ps.reconnect_grace_period_end > (current_timestamp at time zone 'UTC')
      or ps.last_avatar_activity > (current_timestamp - make_interval(secs => $seconds))
    )
EOF
}

dune_require_empty_game_server() {
  local container="$1" partition_id="$2" server_id="$3" check_recent_activity="${4:-1}"
  local counts connected effective logs
  if ! [[ "$partition_id" =~ ^[0-9]+$ ]] || [ -z "$server_id" ]; then
    echo "Cannot verify player presence for $container. Use --force only if you intend to disconnect players." >&2
    return 1
  fi
  if ! counts="$(DUNE_PSQL_TIMEOUT_SECONDS=10 dune_psql -v ON_ERROR_STOP=1 -At -F '|' -c "
    select fs.connected_players, ep.effective_players as guarded_players
    from dune.world_partition wp
    join dune.farm_state fs on fs.server_id = wp.server_id
    cross join lateral ($(dune_game_player_count_sql "${DUNE_AUTOSCALER_IDLE_SECONDS:-300}")) ep
    where wp.partition_id = $partition_id and wp.server_id = '${server_id//\'/\'\'}';
  " 2>/dev/null)" || ! [[ "$counts" =~ ^[0-9]+\|[0-9]+$ ]]; then
    echo "Cannot verify player presence for $container. Use --force only if you intend to disconnect players." >&2
    return 1
  fi
  IFS='|' read -r connected effective <<< "$counts"
  if [ "$connected" -gt 0 ] || [ "$effective" -gt 0 ]; then
    echo "Refusing to despawn $container: $connected connected player(s), $effective active or reconnecting player(s). Use --force to disconnect them." >&2
    return 1
  fi
  # The Autoscaler already observed its idle/reconnect/inbound-travel policy.
  # Keep the live database recheck, but do not add a second 60-second timer to
  # fresh-process activities after their last player has left.
  [ "$check_recent_activity" != "0" ] || return 0
  if ! logs="$(docker logs --since 60s --tail 4000 "$container" 2>&1)"; then
    echo "Cannot verify recent gameplay for $container. Use --force to override." >&2
    return 1
  fi
  if grep -Eq 'LogResourceNode:.*Unable to mine|LogNetPlayerMovement:.*ServerMove|LogNet:.*(Login request|Join succeeded)|FlowType:"Travel"' <<< "$logs"; then
    echo "Refusing to despawn $container: recent gameplay or travel was recorded. Wait for the instance to become idle, or use --force to disconnect players." >&2
    return 1
  fi
}
