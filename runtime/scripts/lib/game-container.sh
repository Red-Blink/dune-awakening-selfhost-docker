#!/usr/bin/env bash

# Shared game container security posture, secret-mount preparation, and
# partition binding helpers for start-server-survival-1.sh,
# start-server-overmap.sh, and spawn-server.sh (S-02, S-06, E-02).

remove_existing_game_container() {
  local name="$1" attempt existing
  [[ "$name" =~ ^[a-zA-Z0-9_-]+$ ]] || {
    echo "Invalid game container name." >&2
    return 1
  }

  # Docker can time out before a killed process delivers its exit event.
  # Retry that incomplete removal and verify the postcondition; otherwise a
  # subsequent docker run only fails with a misleading name-conflict error.
  for attempt in 1 2 3 4; do
    if ! existing="$(timeout 15 docker ps -a --filter "name=^/${name}$" --format '{{.ID}}')"; then
      echo "Cannot verify existing game container $name; refusing to launch a replacement." >&2
      return 1
    fi
    [ -n "$existing" ] || return 0
    [ "$attempt" -lt 4 ] || break

    if ! timeout 30 docker rm -f "$name" >/dev/null; then
      echo "Game container removal did not complete for $name (attempt $attempt of 3)." >&2
    fi
    sleep 2
  done

  echo "Game container $name still exists after 3 removal attempts; refusing to launch a replacement." >&2
  return 1
}

game_container_security_args() {
  if [ "${DUNE_GAME_CONTAINER_PRIVILEGED:-1}" = "1" ]; then
    printf '%s\n' \
      "--privileged" \
      "--cap-add" "SYS_ADMIN" \
      "--security-opt" "seccomp=unconfined"
  else
    printf '%s\n' \
      "--cap-add" "SYS_NICE" \
      "--cap-add" "SYS_PTRACE"
  fi
}

prepare_game_container_secret_file() (
  local safe_name="$1"
  [[ "$safe_name" =~ ^[a-zA-Z0-9_-]+$ ]] || return 1
  local secret_value
  for secret_value in "$FUNCOM_TOKEN" "$RMQ_HTTP_TOKEN_AUTH_SECRET" "$SERVER_LOGIN_PASSWORD_SECRET" "$USERNAME_SERVER_LOGIN_SECRET" "$LOGIN_PASSWORD_SKEW_SECONDS" "$FLS_APIKEY"; do
    [[ "$secret_value" != *$'\n'* && "$secret_value" != *$'\r'* ]] || { printf '%s\n' 'Invalid multiline game credential.' >&2; return 1; }
  done
  local secret_file="runtime/secrets/game-container-${safe_name}.env"
  mkdir -p runtime/secrets
  umask 077
  cat > "$secret_file" <<EOF
FuncomLiveServices__ServiceAuthToken=${FUNCOM_TOKEN}
FuncomLiveServices__RmqTlsEnabled=true
RMQ_HTTP_TOKEN_AUTH_SECRET=${RMQ_HTTP_TOKEN_AUTH_SECRET}
DUNE_SERVER_LOGIN_PASSWORD_SECRET=${SERVER_LOGIN_PASSWORD_SECRET}
DUNE_USERNAME_SERVER_LOGIN_SECRET=${USERNAME_SERVER_LOGIN_SECRET}
DUNE_LOGIN_PASSWORD_SKEW_SECONDS=${LOGIN_PASSWORD_SKEW_SECONDS}
ServerLoginPasswordSecret=${SERVER_LOGIN_PASSWORD_SECRET}
UsernameServerLoginSecret=${USERNAME_SERVER_LOGIN_SECRET}
LoginPasswordSkew=${LOGIN_PASSWORD_SKEW_SECONDS}
BackendLoginConfiguration__ServerLoginPasswordSecret=${SERVER_LOGIN_PASSWORD_SECRET}
BackendLoginConfiguration__UsernameServerLoginSecret=${USERNAME_SERVER_LOGIN_SECRET}
BackendLoginConfiguration__LoginPasswordSkew=${LOGIN_PASSWORD_SKEW_SECONDS}
BackendLoginConfiguration__ServerLoginPasswordSecretEnvironmentVariable=DUNE_SERVER_LOGIN_PASSWORD_SECRET
BackendLoginConfiguration__UsernameServerLoginSecretEnvironmentVariable=DUNE_USERNAME_SERVER_LOGIN_SECRET
BackendLoginConfiguration__LoginPasswordSkewEnvironmentVariable=DUNE_LOGIN_PASSWORD_SKEW_SECONDS
AuthenticationConfiguration__BackendLoginConfiguration__ServerLoginPasswordSecret=${SERVER_LOGIN_PASSWORD_SECRET}
AuthenticationConfiguration__BackendLoginConfiguration__UsernameServerLoginSecret=${USERNAME_SERVER_LOGIN_SECRET}
AuthenticationConfiguration__BackendLoginConfiguration__LoginPasswordSkew=${LOGIN_PASSWORD_SKEW_SECONDS}
AuthenticationConfiguration__BackendLoginConfiguration__ServerLoginPasswordSecretEnvironmentVariable=DUNE_SERVER_LOGIN_PASSWORD_SECRET
AuthenticationConfiguration__BackendLoginConfiguration__UsernameServerLoginSecretEnvironmentVariable=DUNE_USERNAME_SERVER_LOGIN_SECRET
AuthenticationConfiguration__BackendLoginConfiguration__LoginPasswordSkewEnvironmentVariable=DUNE_LOGIN_PASSWORD_SKEW_SECONDS
Secret=${USERNAME_SERVER_LOGIN_SECRET}
UsernameSecret=${USERNAME_SERVER_LOGIN_SECRET}
ServerLoginSecret=${SERVER_LOGIN_PASSWORD_SECRET}
ChecksumSecret=${SERVER_LOGIN_PASSWORD_SECRET}
BackendLoginConfiguration__Secret=${USERNAME_SERVER_LOGIN_SECRET}
BackendLoginConfiguration__UsernameSecret=${USERNAME_SERVER_LOGIN_SECRET}
BackendLoginConfiguration__ServerLoginSecret=${SERVER_LOGIN_PASSWORD_SECRET}
BackendLoginConfiguration__ChecksumSecret=${SERVER_LOGIN_PASSWORD_SECRET}
AuthenticationConfiguration__BackendLoginConfiguration__Secret=${USERNAME_SERVER_LOGIN_SECRET}
AuthenticationConfiguration__BackendLoginConfiguration__UsernameSecret=${USERNAME_SERVER_LOGIN_SECRET}
AuthenticationConfiguration__BackendLoginConfiguration__ServerLoginSecret=${SERVER_LOGIN_PASSWORD_SECRET}
AuthenticationConfiguration__BackendLoginConfiguration__ChecksumSecret=${SERVER_LOGIN_PASSWORD_SECRET}
fls-apikey=${FLS_APIKEY}
EOF
  chmod 600 "$secret_file"
  printf '%s\n' "$PWD/$secret_file"
)

bind_core_partition_to_live_server() {
  local partition_id="$1"
  local map_name="$2"
  local game_port="$3"
  local igw_port="$4"
  local tries="${5:-30}"
  local sleep_seconds="${6:-2}"
  local live_server_id="" i

  for i in $(seq 1 "$tries"); do
    live_server_id="$(psql_value "
      select coalesce(server_id, '')
      from dune.farm_state
      where map = '${map_name//\'/\'\'}'
        and game_port = $game_port
        and igw_port = $igw_port
        and coalesce(alive, false) = true
      order by ready desc, server_id
      limit 1;
    " | tr -d '\r[:space:]')"

    if [ -n "$live_server_id" ]; then
      dune_psql -v ON_ERROR_STOP=1 -c "
begin;
update dune.world_partition
set server_id = '$live_server_id'
where partition_id = $partition_id;
create temporary table dune_rebound_stale_accounts(account_id bigint primary key) on commit drop;
insert into dune_rebound_stale_accounts(account_id)
select distinct ps.account_id
from dune.player_state ps
left join dune.farm_state fs on fs.server_id = ps.server_id
where ps.previous_server_partition_id = $partition_id
  and ps.account_id is not null
  and coalesce(ps.character_state::text, '') <> 'Deleted'
  and coalesce(ps.server_id, '') <> '$live_server_id'
  and (
    coalesce(ps.server_id, '') = ''
    or fs.server_id is null
    or (
      fs.map = '${map_name//\'/\'\'}'
      and fs.game_port = $game_port
      and fs.igw_port = $igw_port
      and fs.server_id <> '$live_server_id'
    )
  );
with target as (
  select partition_id, coalesce(dimension_index, 0) as dimension_index
  from dune.world_partition
  where partition_id = $partition_id
)
update dune.player_state ps
set
  server_id = '$live_server_id',
  previous_server_partition_id = target.partition_id,
  home_dimension_index = target.dimension_index,
  return_dimension_index = target.dimension_index
from target
where ps.account_id in (select account_id from dune_rebound_stale_accounts);
with target as (
  select partition_id, coalesce(dimension_index, 0) as dimension_index
  from dune.world_partition
  where partition_id = $partition_id
)
update dune.encrypted_player_state eps
set
  server_id = '$live_server_id',
  previous_server_partition_id = target.partition_id,
  return_dimension_index = target.dimension_index
from target
where eps.account_id in (select account_id from dune_rebound_stale_accounts);
delete from dune.farm_state
where map = '${map_name//\'/\'\'}'
  and server_id <> '$live_server_id'
  and game_port = $game_port
  and igw_port = $igw_port;
commit;
" >/dev/null
      printf '%s' "$live_server_id"
      return 0
    fi

    sleep "$sleep_seconds"
  done

  return 1
}
