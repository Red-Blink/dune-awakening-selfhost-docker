#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env
[ -f .env ] && . ./.env
source runtime/scripts/runtime-env.sh

psql_exec() {
  docker exec -i dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 "$@"
}

postgres_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-postgres
}

farm_state_exists() {
  psql_exec -Atc "select to_regclass('dune.farm_state') is not null;" 2>/dev/null | grep -qx t
}

reconcile_farm_state_addresses() {
  local advertised_ip igw_ip

  advertised_ip="$(resolve_game_addr_ip)"
  igw_ip="$(resolve_igw_addr_ip)"

  if ! is_ipv4 "$advertised_ip"; then
    echo "Cannot reconcile farm_state addresses: advertised IP is not IPv4: $advertised_ip" >&2
    return 1
  fi
  if ! is_ipv4 "$igw_ip"; then
    echo "Cannot reconcile farm_state addresses: IGW advertised IP is not IPv4: $igw_ip" >&2
    return 1
  fi
  if ! postgres_running; then
    echo "Cannot reconcile farm_state addresses: dune-postgres is not running." >&2
    return 1
  fi
  if ! farm_state_exists; then
    echo "Cannot reconcile farm_state addresses: dune.farm_state does not exist yet." >&2
    return 1
  fi

  psql_exec <<SQL >/dev/null
create table if not exists dune.network_address_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table dune.network_address_config owner to dune;
grant select, insert, update, delete on dune.network_address_config to dune;

insert into dune.network_address_config (key, value, updated_at)
values
  ('game_addr_ip', '$advertised_ip', now()),
  ('igw_addr_ip', '$igw_ip', now())
on conflict (key) do update
set value = excluded.value,
    updated_at = now();

create or replace function dune.normalize_farm_state_addresses()
returns trigger
language plpgsql
as \$\$
declare
  configured_game_addr text;
  configured_igw_addr text;
begin
  select value into configured_game_addr
  from dune.network_address_config
  where key = 'game_addr_ip';

  select value into configured_igw_addr
  from dune.network_address_config
  where key = 'igw_addr_ip';

  if configured_game_addr is not null then
    new.game_addr := (configured_game_addr || '/0')::inet;
  end if;

  if configured_igw_addr is not null then
    new.igw_addr := (configured_igw_addr || '/0')::inet;
  end if;

  return new;
end;
\$\$;

alter function dune.normalize_farm_state_addresses() owner to dune;
grant execute on function dune.normalize_farm_state_addresses() to dune;

drop trigger if exists normalize_farm_state_addresses on dune.farm_state;
create trigger normalize_farm_state_addresses
before insert or update of game_addr, igw_addr
on dune.farm_state
for each row
execute function dune.normalize_farm_state_addresses();

update dune.farm_state
set game_addr = ('$advertised_ip/0')::inet,
    igw_addr = ('$igw_ip/0')::inet
where host(game_addr) is distinct from '$advertised_ip'
   or host(igw_addr) is distinct from '$igw_ip';
SQL

  echo "farm_state addresses reconciled: game_addr=${advertised_ip}/0 igw_addr=${igw_ip}/0"
}

status_farm_state_addresses() {
  local advertised_ip igw_ip

  advertised_ip="$(resolve_game_addr_ip)"
  igw_ip="$(resolve_igw_addr_ip)"
  echo "Resolved game address IP: $advertised_ip"
  echo "Resolved IGW address IP:  $igw_ip"

  if ! postgres_running || ! farm_state_exists; then
    echo "dune.farm_state is not available."
    return 1
  fi

  psql_exec -At -F $'\t' -c "
    select map, coalesce(host(game_addr), ''), game_port, coalesce(host(igw_addr), ''), igw_port, ready, alive
    from dune.farm_state
    order by map, game_port, igw_port;
  "
}

case "${1:-reconcile}" in
  reconcile|apply|install)
    reconcile_farm_state_addresses
    ;;
  status)
    status_farm_state_addresses
    ;;
  *)
    echo "Usage: $0 [reconcile|status]" >&2
    exit 2
    ;;
esac
