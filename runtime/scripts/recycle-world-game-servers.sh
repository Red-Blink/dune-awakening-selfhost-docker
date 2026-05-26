#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -f runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env
[ -f runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env

source runtime/scripts/image-tags.sh

ACTION="${1:-remove-stale}"
WORLD_IMAGE_TAG="$(resolve_world_image_tag)"
TARGET_IMAGE="registry.funcom.com/funcom/self-hosting/seabass-server:${WORLD_IMAGE_TAG}"
SERVER_ID_MAP_FILE="runtime/generated/autoscaler-server-ids.tsv"

psql_value() {
  docker exec dune-postgres psql -U postgres -d dune -Atc "$1"
}

is_world_game_container() {
  local name="$1"
  case "$name" in
    dune-server-gateway)
      return 1
      ;;
    dune-server-overmap|dune-server-survival-1)
      return 0
      ;;
    dune-server-*-*)
      if [[ "$name" =~ -([0-9]+)$ ]]; then
        return 0
      fi
      ;;
  esac
  return 1
}

remove_server_id_map() {
  local server_id="$1"
  local tmp
  [ -n "$server_id" ] || return 0
  [ -f "$SERVER_ID_MAP_FILE" ] || return 0
  [ -r "$SERVER_ID_MAP_FILE" ] || return 0
  tmp="$(mktemp)"
  awk -F '\t' -v sid="$server_id" '$1 != sid { print }' "$SERVER_ID_MAP_FILE" > "$tmp"
  cat "$tmp" > "$SERVER_ID_MAP_FILE" 2>/dev/null || true
  rm -f "$tmp"
}

cleanup_partition_assignment() {
  local partition_id="$1"
  local server_id

  [ -n "$partition_id" ] || return 0
  server_id="$(psql_value "select coalesce(server_id, '') from dune.world_partition where partition_id = $partition_id limit 1;")"

  docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
begin;
update dune.world_partition
set server_id = null
where partition_id = $partition_id;
delete from dune.farm_state
where server_id = '$server_id'
   or (
     '$server_id' = ''
     and server_id in (
       select coalesce(server_id, '')
       from dune.world_partition
       where partition_id = $partition_id
     )
   );
commit;
" >/dev/null

  remove_server_id_map "$server_id"
}

remove_container() {
  local name="$1"
  local partition_id=""

  if [[ "$name" =~ -([0-9]+)$ ]]; then
    partition_id="${BASH_REMATCH[1]}"
  fi

  echo "Removing world server container: $name"
  docker rm -f "$name" >/dev/null

  if [ -n "$partition_id" ] && docker ps --format '{{.Names}}' | grep -qx dune-postgres; then
    cleanup_partition_assignment "$partition_id"
  fi
}

remove_stale() {
  local found=0
  while IFS=$'\t' read -r name image; do
    [ -n "$name" ] || continue
    is_world_game_container "$name" || continue
    if [ "$image" != "$TARGET_IMAGE" ]; then
      found=1
      echo "Stale world server image detected: $name ($image != $TARGET_IMAGE)"
      remove_container "$name"
    fi
  done < <(docker ps -a --format '{{.Names}}\t{{.Image}}')

  if [ "$found" -eq 0 ]; then
    echo "No stale world server containers found for tag $WORLD_IMAGE_TAG."
  fi
}

stop_all() {
  local found=0
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    is_world_game_container "$name" || continue
    found=1
    remove_container "$name"
  done < <(docker ps -a --format '{{.Names}}')

  if [ "$found" -eq 0 ]; then
    echo "No world server containers found."
  fi
}

stop_noncore() {
  local found=0
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    is_world_game_container "$name" || continue
    case "$name" in
      dune-server-overmap|dune-server-survival-1)
        continue
        ;;
    esac
    found=1
    remove_container "$name"
  done < <(docker ps -a --format '{{.Names}}')

  if [ "$found" -eq 0 ]; then
    echo "No non-core world server containers found."
  fi
}

case "$ACTION" in
  remove-stale)
    remove_stale
    ;;
  stop-all)
    stop_all
    ;;
  stop-noncore)
    stop_noncore
    ;;
  *)
    echo "Usage: $0 [remove-stale|stop-all|stop-noncore]"
    exit 2
    ;;
esac
