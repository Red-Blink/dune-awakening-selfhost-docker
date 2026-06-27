#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

is_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$1"
}

if ! is_running dune-postgres || ! is_running dune-rmq-game; then
  exit 0
fi

map_chat_region_sql="
case wp.map
  when 'Survival_1' then 'HaggaBasin'
  when 'Overmap' then 'Overland'
  when 'DeepDesert_1' then 'DeepDesert'
  when 'SH_Arrakeen' then 'Arrakeen'
  when 'SH_HarkoVillage' then 'HarkoVillage'
  else wp.map
end
"

declared=0
failed=0
guild_bound=0
guild_bind_failed=0
faction_bound=0
faction_bind_failed=0
map_bound=0
map_bind_failed=0
direct_bound=0
direct_bind_failed=0
notification_bound=0
notification_bind_failed=0
rmq_timeout_seconds="${CHAT_REPAIR_RMQ_TIMEOUT_SECONDS:-10}"
exchange_list_file=""
queue_list_file=""

cleanup() {
  [ -n "$exchange_list_file" ] && rm -f "$exchange_list_file"
  [ -n "$queue_list_file" ] && rm -f "$queue_list_file"
}

trap cleanup EXIT

rmq_ctl() {
  timeout --kill-after=2s "${rmq_timeout_seconds}s" docker exec dune-rmq-game rabbitmqctl -q "$@"
}

rmq_eval() {
  timeout --kill-after=2s "${rmq_timeout_seconds}s" docker exec dune-rmq-game rabbitmqctl -q eval "$1"
}

load_rmq_metadata() {
  exchange_list_file="$(mktemp)"
  queue_list_file="$(mktemp)"
  rmq_ctl list_exchanges name type durable >"$exchange_list_file" 2>/dev/null || return 1
  rmq_ctl list_queues name >"$queue_list_file" 2>/dev/null || return 1
}

exchange_exists() {
  local exchange="$1"
  local kind="$2"
  local durable="${3:-false}"

  [ -n "$exchange_list_file" ] && [ -f "$exchange_list_file" ] || return 1
  awk -F '\t' -v name="$exchange" -v type="$kind" -v durable="$durable" \
    '$1 == name && $2 == type && $3 == durable { found = 1 } END { exit found ? 0 : 1 }' "$exchange_list_file"
}

exchange_exists_any_shape() {
  local exchange="$1"

  [ -n "$exchange_list_file" ] && [ -f "$exchange_list_file" ] || return 1
  awk -F '\t' -v name="$exchange" '$1 == name { found = 1 } END { exit found ? 0 : 1 }' "$exchange_list_file"
}

queue_exists() {
  local queue="$1"

  [ -n "$queue_list_file" ] && [ -f "$queue_list_file" ] || return 1
  awk -F '\t' -v name="$queue" '$1 == name { found = 1 } END { exit found ? 0 : 1 }' "$queue_list_file"
}

declare_exchange() {
  local exchange="$1"
  local kind="$2"
  local durable="${3:-false}"

  if exchange_exists "$exchange" "$kind" "$durable"; then
    return 0
  fi

  if exchange_exists_any_shape "$exchange"; then
    rmq_eval "
X = {resource, <<\"/\">>, exchange, <<\"${exchange}\">>},
rabbit_exchange:delete(X, false, <<\"repair-chat-exchanges\">>).
" >/dev/null 2>&1 || return 1
  fi

  if rmq_eval "
X = {resource, <<\"/\">>, exchange, <<\"${exchange}\">>},
rabbit_exchange:declare(X, ${kind}, ${durable}, false, false, [], <<\"repair-chat-exchanges\">>).
" >/dev/null 2>&1; then
    printf '%s\t%s\n' "$exchange" "$kind" >>"$exchange_list_file"
    return 0
  fi

  return 1
}

bind_queue() {
  local exchange="$1"
  local routing_key="$2"
  local queue="$3"

  queue_exists "$queue" || return 0
  rmq_eval "
B = {binding,
  {resource, <<\"/\">>, exchange, <<\"${exchange}\">>},
  <<\"${routing_key}\">>,
  {resource, <<\"/\">>, queue, <<\"${queue}\">>},
  []},
rabbit_binding:add(B, <<\"repair-chat-exchanges\">>).
" >/dev/null 2>&1
}

if ! load_rmq_metadata; then
  echo "WARN failed to inspect RabbitMQ chat resources" >&2
  exit 1
fi

guild_ids="$(
  docker exec dune-postgres psql -U dune -d dune -Atc "
    select guild_id
    from dune.guilds
    where guild_id is not null
    order by guild_id;
  " 2>/dev/null || true
)"

while IFS= read -r guild_id; do
  guild_id="$(printf '%s' "$guild_id" | tr -d '[:space:]')"
  [[ "$guild_id" =~ ^[0-9]+$ ]] || continue

  exchange="chat.guild.$guild_id"
  if declare_exchange "$exchange" "fanout" "true"; then
    declared=$((declared + 1))
  else
    failed=$((failed + 1))
    echo "WARN failed to declare guild chat exchange: $exchange" >&2
  fi
done <<< "$guild_ids"

faction_ids="$(
  docker exec dune-postgres psql -U dune -d dune -Atc "
    select distinct id
    from dune.factions
    where id is not null
    union
    select distinct faction_id
    from dune.player_faction
    where faction_id is not null
    union
    select distinct faction_id
    from dune.player_faction_reputation
    where faction_id is not null
    order by 1;
  " 2>/dev/null || true
)"

while IFS= read -r faction_id; do
  faction_id="$(printf '%s' "$faction_id" | tr -d '[:space:]')"
  [[ "$faction_id" =~ ^[0-9]+$ ]] || continue

  exchange="chat.faction.$faction_id"
  if declare_exchange "$exchange" "fanout"; then
    declared=$((declared + 1))
  else
    failed=$((failed + 1))
    echo "WARN failed to declare faction chat exchange: $exchange" >&2
  fi
done <<< "$faction_ids"

if declare_exchange "chat.map" "direct" "true"; then
  declared=$((declared + 1))
else
  failed=$((failed + 1))
  echo "WARN failed to declare map chat exchange: chat.map" >&2
fi

for exchange in chat.whispers chat.proximity; do
  if declare_exchange "$exchange" "direct" "true"; then
    declared=$((declared + 1))
  else
    failed=$((failed + 1))
    echo "WARN failed to declare direct chat exchange: $exchange" >&2
  fi
done

if declare_exchange "notifications" "topic" "true"; then
  declared=$((declared + 1))
else
  failed=$((failed + 1))
  echo "WARN failed to declare notifications exchange: notifications" >&2
fi

guild_bindings="$(
  docker exec dune-postgres psql -U dune -d dune -At -F $'\t' -c "
    select distinct gm.guild_id, concat(ac.\"user\", '_queue') as queue_name
    from dune.guild_members gm
    join dune.player_state ps on ps.player_controller_id = gm.player_id
    join dune.accounts ac on ac.id = ps.account_id
    where gm.guild_id is not null
      and ps.online_status <> 'Offline'
      and coalesce(ac.\"user\", '') <> ''
    order by gm.guild_id, queue_name;
  " 2>/dev/null || true
)"

while IFS=$'\t' read -r guild_id queue_name; do
  guild_id="$(printf '%s' "$guild_id" | tr -d '[:space:]')"
  queue_name="$(printf '%s' "$queue_name" | tr -d '[:space:]')"
  [[ "$guild_id" =~ ^[0-9]+$ ]] || continue
  [[ "$queue_name" =~ ^[A-Za-z0-9_.:@#/+=-]+_queue$ ]] || continue

  exchange="chat.guild.$guild_id"
  if bind_queue "$exchange" "" "$queue_name"; then
    guild_bound=$((guild_bound + 1))
  else
    guild_bind_failed=$((guild_bind_failed + 1))
    echo "WARN failed to bind guild chat queue: $exchange -> $queue_name" >&2
  fi
done <<< "$guild_bindings"

faction_bindings="$(
  docker exec dune-postgres psql -U dune -d dune -At -F $'\t' -c "
    select distinct pf.faction_id, concat(ac.\"user\", '_queue') as queue_name
    from dune.player_faction pf
    join dune.player_state ps on ps.player_controller_id = pf.actor_id
    join dune.accounts ac on ac.id = ps.account_id
    where pf.faction_id is not null
      and ps.online_status <> 'Offline'
      and coalesce(ac.\"user\", '') <> ''
    order by pf.faction_id, queue_name;
  " 2>/dev/null || true
)"

while IFS=$'\t' read -r faction_id queue_name; do
  faction_id="$(printf '%s' "$faction_id" | tr -d '[:space:]')"
  queue_name="$(printf '%s' "$queue_name" | tr -d '[:space:]')"
  [[ "$faction_id" =~ ^[0-9]+$ ]] || continue
  [[ "$queue_name" =~ ^[A-Za-z0-9_.:@#/+=-]+_queue$ ]] || continue

  exchange="chat.faction.$faction_id"
  if bind_queue "$exchange" "" "$queue_name"; then
    faction_bound=$((faction_bound + 1))
  else
    faction_bind_failed=$((faction_bind_failed + 1))
    echo "WARN failed to bind faction chat queue: $exchange -> $queue_name" >&2
  fi
done <<< "$faction_bindings"

map_bindings="$(
  docker exec dune-postgres psql -U dune -d dune -At -F $'\t' -c "
    select distinct concat(($map_chat_region_sql), '.', coalesce(wp.dimension_index, 0)) as routing_key,
           concat(ac.\"user\", '_queue') as queue_name
    from dune.player_state ps
    join dune.accounts ac on ac.id = ps.account_id
    join dune.world_partition wp on wp.server_id = ps.server_id
    where ps.online_status <> 'Offline'
      and coalesce(ac.\"user\", '') <> ''
      and coalesce(wp.map, '') <> ''
    order by routing_key, queue_name;
  " 2>/dev/null || true
)"

while IFS=$'\t' read -r routing_key queue_name; do
  routing_key="$(printf '%s' "$routing_key" | tr -d '[:space:]')"
  queue_name="$(printf '%s' "$queue_name" | tr -d '[:space:]')"
  [[ "$routing_key" =~ ^[A-Za-z0-9_.:-]+\.[0-9]+$ ]] || continue
  [[ "$queue_name" =~ ^[A-Za-z0-9_.:@#/+=-]+_queue$ ]] || continue

  if bind_queue "chat.map" "$routing_key" "$queue_name"; then
    map_bound=$((map_bound + 1))
  else
    map_bind_failed=$((map_bind_failed + 1))
    echo "WARN failed to bind map chat queue: chat.map $routing_key -> $queue_name" >&2
  fi
done <<< "$map_bindings"

direct_bindings="$(
  docker exec dune-postgres psql -U dune -d dune -At -F $'\t' -c "
    select distinct routing_key, queue_name
    from (
      select ac.\"user\" as routing_key,
             concat(ac.\"user\", '_queue') as queue_name
      from dune.player_state ps
      join dune.accounts ac on ac.id = ps.account_id
      where ps.online_status <> 'Offline'
        and coalesce(ac.\"user\", '') <> ''
      union
      select ac.funcom_id as routing_key,
             concat(ac.\"user\", '_queue') as queue_name
      from dune.player_state ps
      join dune.accounts ac on ac.id = ps.account_id
      where ps.online_status <> 'Offline'
        and coalesce(ac.funcom_id, '') <> ''
        and coalesce(ac.\"user\", '') <> ''
    ) keys
    order by routing_key, queue_name;
  " 2>/dev/null || true
)"

while IFS=$'\t' read -r routing_key queue_name; do
  routing_key="$(printf '%s' "$routing_key" | tr -d '[:space:]')"
  queue_name="$(printf '%s' "$queue_name" | tr -d '[:space:]')"
  [[ "$routing_key" =~ ^[A-Za-z0-9_.:@#/+=-]+$ ]] || continue
  [[ "$queue_name" =~ ^[A-Za-z0-9_.:@#/+=-]+_queue$ ]] || continue

  for exchange in chat.whispers chat.proximity; do
    if bind_queue "$exchange" "$routing_key" "$queue_name"; then
      direct_bound=$((direct_bound + 1))
    else
      direct_bind_failed=$((direct_bind_failed + 1))
      echo "WARN failed to bind direct chat queue: $exchange $routing_key -> $queue_name" >&2
    fi
  done
done <<< "$direct_bindings"

notification_bindings="$(
  docker exec dune-postgres psql -U dune -d dune -At -F $'\t' -c "
    select distinct concat('player.#.', ac.funcom_id) as routing_key,
           concat(ac.\"user\", '_queue') as queue_name
    from dune.player_state ps
    join dune.accounts ac on ac.id = ps.account_id
    where ps.online_status <> 'Offline'
      and coalesce(ac.funcom_id, '') <> ''
      and coalesce(ac.\"user\", '') <> ''
    order by routing_key, queue_name;
  " 2>/dev/null || true
)"

while IFS=$'\t' read -r routing_key queue_name; do
  routing_key="$(printf '%s' "$routing_key" | tr -d '[:space:]')"
  queue_name="$(printf '%s' "$queue_name" | tr -d '[:space:]')"
  [[ "$routing_key" =~ ^player\.\#\.[A-Za-z0-9_.:@#/+=-]+$ ]] || continue
  [[ "$queue_name" =~ ^[A-Za-z0-9_.:@#/+=-]+_queue$ ]] || continue

  if bind_queue "notifications" "$routing_key" "$queue_name"; then
    notification_bound=$((notification_bound + 1))
  else
    notification_bind_failed=$((notification_bind_failed + 1))
    echo "WARN failed to bind notification queue: notifications $routing_key -> $queue_name" >&2
  fi
done <<< "$notification_bindings"

if [ "$declared" -gt 0 ]; then
  echo "Ensured chat exchanges: $declared"
fi

if [ "$guild_bound" -gt 0 ]; then
  echo "Ensured guild chat queue bindings: $guild_bound"
fi

if [ "$faction_bound" -gt 0 ]; then
  echo "Ensured faction chat queue bindings: $faction_bound"
fi

if [ "$map_bound" -gt 0 ]; then
  echo "Ensured map chat queue bindings: $map_bound"
fi

if [ "$direct_bound" -gt 0 ]; then
  echo "Ensured direct chat queue bindings: $direct_bound"
fi

if [ "$notification_bound" -gt 0 ]; then
  echo "Ensured notification queue bindings: $notification_bound"
fi

if [ "$guild_bind_failed" -gt 0 ]; then
  echo "WARN some guild chat queue bindings could not be repaired. They will be retried on the next repair pass." >&2
fi

if [ "$faction_bind_failed" -gt 0 ]; then
  echo "WARN some faction chat queue bindings could not be repaired. They will be retried on the next repair pass." >&2
fi

if [ "$map_bind_failed" -gt 0 ]; then
  echo "WARN some map chat queue bindings could not be repaired. They will be retried on the next repair pass." >&2
fi

if [ "$direct_bind_failed" -gt 0 ]; then
  echo "WARN some direct chat queue bindings could not be repaired. They will be retried on the next repair pass." >&2
fi

if [ "$notification_bind_failed" -gt 0 ]; then
  echo "WARN some notification queue bindings could not be repaired. They will be retried on the next repair pass." >&2
fi

if [ "$failed" -gt 0 ]; then
  exit 1
fi
