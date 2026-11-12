#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env

source runtime/scripts/runtime-env.sh
# shellcheck source=runtime/scripts/lib/container-lifecycle.sh
# A missing helper (a partial copy of the scripts) must never stop a stop.
source runtime/scripts/lib/container-lifecycle.sh 2>/dev/null || dune_container_removal_hook() { :; }

CLIENT_PORT_BASE="$(resolve_client_port_base)"
IGW_PORT_BASE="$(resolve_igw_port_base)"
GAME_PORT="$CLIENT_PORT_BASE"
IGW_PORT="$((IGW_PORT_BASE + 1))"
PARTITION_ID="${DUNE_OVERMAP_PARTITION_ID:-2}"

# Match the Survival stop path's positive confirmation rule. The partition is
# released only after Docker confirms the Overmap container is gone, otherwise
# a failed container removal could make a live map appear safe for DB writes.
containers="$(docker ps -a --format '{{.Names}}')"
if printf '%s\n' "$containers" | grep -qx dune-server-overmap; then
  dune_container_removal_hook dune-server-overmap stop-server-overmap
  docker rm -f dune-server-overmap >/dev/null
fi
containers="$(docker ps -a --format '{{.Names}}')"
if printf '%s\n' "$containers" | grep -qx dune-server-overmap; then
  echo "Failed to stop dune-server-overmap; database state was not changed." >&2
  exit 1
fi

docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
begin;
update dune.world_partition
set server_id = null
where partition_id = $PARTITION_ID;
delete from dune.farm_state
where map = 'Overmap'
  and game_port = $GAME_PORT
  and igw_port = $IGW_PORT;
commit;
" >/dev/null
