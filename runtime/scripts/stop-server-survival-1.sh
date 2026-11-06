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
GAME_PORT="$((CLIENT_PORT_BASE + 1))"
IGW_PORT="$IGW_PORT_BASE"
PARTITION_ID="${DUNE_SURVIVAL_PARTITION_ID:-1}"

# Do not clear the partition assignment unless Docker positively confirms the
# game container is gone. Ignoring an rm/daemon/permission failure here would
# make the refill queue treat a still-running map as safe to write.
containers="$(docker ps -a --format '{{.Names}}')"
if printf '%s\n' "$containers" | grep -qx dune-server-survival-1; then
  dune_container_removal_hook dune-server-survival-1 stop-server-survival-1
  docker rm -f dune-server-survival-1 >/dev/null
fi
containers="$(docker ps -a --format '{{.Names}}')"
if printf '%s\n' "$containers" | grep -qx dune-server-survival-1; then
  echo "Failed to stop dune-server-survival-1; database state was not changed." >&2
  exit 1
fi

docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
begin;
update dune.world_partition
set server_id = null
where partition_id = $PARTITION_ID;
delete from dune.farm_state
where map = 'Survival_1'
  and game_port = $GAME_PORT
  and igw_port = $IGW_PORT;
commit;
" >/dev/null
