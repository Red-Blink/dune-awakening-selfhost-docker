#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env

[ -r runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env
source runtime/scripts/host-paths.sh
source runtime/scripts/runtime-env.sh
source runtime/scripts/image-tags.sh
WORLD_IMAGE_TAG="$(resolve_world_image_tag)"
IMAGE="registry.funcom.com/funcom/self-hosting/seabass-server:${WORLD_IMAGE_TAG}"

TOKEN_FILE="runtime/secrets/funcom-token.txt"
RMQ_SECRET_FILE="runtime/secrets/rmq-http-token-auth-secret.txt"
FLS_APIKEY_FILE="runtime/secrets/fls-apikey.txt"

FUNCOM_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
RMQ_HTTP_TOKEN_AUTH_SECRET="$(tr -d '\r\n' < "$RMQ_SECRET_FILE")"
FLS_APIKEY="$(tr -d '\r\n' < "$FLS_APIKEY_FILE")"

SERVER_LOGIN_PASSWORD_SECRET="$(resolve_server_login_password_secret)"
USERNAME_SERVER_LOGIN_SECRET="$(resolve_username_server_login_secret)"
LOGIN_PASSWORD_SKEW_SECONDS="$(resolve_login_password_skew_seconds)"

SERVER_TITLE="$(resolve_server_title)"
SERVER_REGION="$(resolve_server_region)"
SERVER_IP="$(resolve_server_ip)"
BATTLEGROUP_ID="$(resolve_battlegroup_id)"
CLIENT_PORT_BASE="$(resolve_client_port_base)"
IGW_PORT_BASE="$(resolve_igw_port_base)"
GAME_PORT="$CLIENT_PORT_BASE"
IGW_PORT="$((IGW_PORT_BASE + 1))"
MEMORY="${DUNE_MEMORY_OVERMAP:-$(default_memory_for_map Overmap)}"
PARTITION_ID="${DUNE_OVERMAP_PARTITION_ID:-2}"
if [ -n "${DUNE_FAKE_K8S_SERVICEACCOUNT_DIR:-}" ]; then
  FAKE_K8S_SERVICEACCOUNT_DIR="$DUNE_FAKE_K8S_SERVICEACCOUNT_DIR"
else
  FAKE_K8S_SERVICEACCOUNT_DIR="$PWD/runtime/generated/dune-fake-k8s-serviceaccount-overmap-$$"
fi


MULTIHOME_IP="$(resolve_bind_ip)"
RMQ_GAME_HOST="$(resolve_rmq_game_host)"
RMQ_ADMIN_HOST="$(resolve_rmq_admin_host)"
mapfile -t GAME_EXTERNAL_ADDRESS_ENV < <(game_external_address_override_env_args)

psql_value() {
  docker exec dune-postgres psql -U postgres -d dune -Atc "$1"
}

bind_partition_to_live_server() {
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
      docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
begin;
update dune.world_partition
set server_id = '$live_server_id'
where partition_id = $partition_id;
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

mkdir -p runtime/game/overmap/Saved
mkdir -p runtime/game/artifacts
mkdir -p "$FAKE_K8S_SERVICEACCOUNT_DIR"
mkdir -p runtime/container
python3 runtime/scripts/usersettings.py materialize Overmap "$PWD/runtime/game/overmap/Saved" "$PARTITION_ID"

cat > "$FAKE_K8S_SERVICEACCOUNT_DIR/namespace" <<'EOF'
funcom-seabass-dune-docker
EOF
cat > "$FAKE_K8S_SERVICEACCOUNT_DIR/token" <<'EOF'
fake-token
EOF
: > "$FAKE_K8S_SERVICEACCOUNT_DIR/ca.crt"
chmod -R 755 "$FAKE_K8S_SERVICEACCOUNT_DIR"

mapfile -t SIETCH_RUNTIME_ARGS < <(runtime/scripts/sietches.sh runtime-args Overmap "$PARTITION_ID" 2>/dev/null || true)
mapfile -t LOG_RUNTIME_ARGS < <(full_stdout_log_args)
runtime/scripts/network-addresses.sh reconcile >/dev/null 2>&1 || true

docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
begin;
delete from dune.farm_state
where map = 'Overmap'
  and coalesce(alive, false) = false
  and server_id not in (
    select server_id
    from dune.world_partition
    where coalesce(server_id, '') <> ''
  );
commit;
" >/dev/null

docker rm -f dune-server-overmap 2>/dev/null || true

docker run -d \
  --name dune-server-overmap \
  --network host \
  --restart unless-stopped \
  --privileged \
  --cap-add SYS_ADMIN \
  --security-opt seccomp=unconfined \
  --memory "$MEMORY" \
  --memory-reservation "$MEMORY" \
  -v "$(host_path "$PWD/runtime/game/overmap/Saved"):/home/dune/server/DuneSandbox/Saved" \
  -v "$(host_path "$PWD/runtime/game/artifacts"):/home/dune/artifacts" \
  -v "$(host_path "$PWD/runtime/container"):/opt/dune-local:ro" \
  -v "$(host_path "$FAKE_K8S_SERVICEACCOUNT_DIR"):/run/secrets/kubernetes.io/serviceaccount:ro" \
  -e "POD_UID=docker-overmap" \
  -e "POD_NAME=${BATTLEGROUP_ID}-sg-overmap-pod-2" \
  -e "POD_IP=$MULTIHOME_IP" \
  "${GAME_EXTERNAL_ADDRESS_ENV[@]}" \
  -e "NODE_NAME=$(hostname)" \
  -e "SERVER_INDEX=2" \
  -e "FARM_NAME=$BATTLEGROUP_ID" \
  -e "BATTLEGROUP_NAME=$BATTLEGROUP_ID" \
  -e "BATTLEGROUP=$BATTLEGROUP_ID" \
  -e "BATTLEGROUP_DISPLAY_NAME=$BATTLEGROUP_ID" \
  -e "BATTLEGROUP_TITLE=$SERVER_TITLE" \
  -e "FC_CRASHREPORTER_LOGS=/home/dune/server/DuneSandbox/Saved/CrashReporterLogs" \
  -e "FuncomLiveServices__ServiceAuthToken=$FUNCOM_TOKEN" \
  -e "FuncomLiveServices__RmqTlsEnabled=true" \
  -e "RMQ_HTTP_TOKEN_AUTH_SECRET=$RMQ_HTTP_TOKEN_AUTH_SECRET" \
  -e "DUNE_SERVER_LOGIN_PASSWORD_SECRET=$SERVER_LOGIN_PASSWORD_SECRET" \
  -e "DUNE_USERNAME_SERVER_LOGIN_SECRET=$USERNAME_SERVER_LOGIN_SECRET" \
  -e "DUNE_LOGIN_PASSWORD_SKEW_SECONDS=$LOGIN_PASSWORD_SKEW_SECONDS" \
  -e "ServerLoginPasswordSecret=$SERVER_LOGIN_PASSWORD_SECRET" \
  -e "UsernameServerLoginSecret=$USERNAME_SERVER_LOGIN_SECRET" \
  -e "LoginPasswordSkew=$LOGIN_PASSWORD_SKEW_SECONDS" \
  -e "BackendLoginConfiguration__ServerLoginPasswordSecret=$SERVER_LOGIN_PASSWORD_SECRET" \
  -e "BackendLoginConfiguration__UsernameServerLoginSecret=$USERNAME_SERVER_LOGIN_SECRET" \
  -e "BackendLoginConfiguration__LoginPasswordSkew=$LOGIN_PASSWORD_SKEW_SECONDS" \
  -e "BackendLoginConfiguration__ServerLoginPasswordSecretEnvironmentVariable=DUNE_SERVER_LOGIN_PASSWORD_SECRET" \
  -e "BackendLoginConfiguration__UsernameServerLoginSecretEnvironmentVariable=DUNE_USERNAME_SERVER_LOGIN_SECRET" \
  -e "BackendLoginConfiguration__LoginPasswordSkewEnvironmentVariable=DUNE_LOGIN_PASSWORD_SKEW_SECONDS" \
  -e "AuthenticationConfiguration__BackendLoginConfiguration__ServerLoginPasswordSecret=$SERVER_LOGIN_PASSWORD_SECRET" \
  -e "AuthenticationConfiguration__BackendLoginConfiguration__UsernameServerLoginSecret=$USERNAME_SERVER_LOGIN_SECRET" \
  -e "AuthenticationConfiguration__BackendLoginConfiguration__LoginPasswordSkew=$LOGIN_PASSWORD_SKEW_SECONDS" \
  -e "AuthenticationConfiguration__BackendLoginConfiguration__ServerLoginPasswordSecretEnvironmentVariable=DUNE_SERVER_LOGIN_PASSWORD_SECRET" \
  -e "AuthenticationConfiguration__BackendLoginConfiguration__UsernameServerLoginSecretEnvironmentVariable=DUNE_USERNAME_SERVER_LOGIN_SECRET" \
  -e "AuthenticationConfiguration__BackendLoginConfiguration__LoginPasswordSkewEnvironmentVariable=DUNE_LOGIN_PASSWORD_SKEW_SECONDS" \
  -e "Secret=$USERNAME_SERVER_LOGIN_SECRET" \
  -e "UsernameSecret=$USERNAME_SERVER_LOGIN_SECRET" \
  -e "ServerLoginSecret=$SERVER_LOGIN_PASSWORD_SECRET" \
  -e "ChecksumSecret=$SERVER_LOGIN_PASSWORD_SECRET" \
  -e "BackendLoginConfiguration__Secret=$USERNAME_SERVER_LOGIN_SECRET" \
  -e "BackendLoginConfiguration__UsernameSecret=$USERNAME_SERVER_LOGIN_SECRET" \
  -e "BackendLoginConfiguration__ServerLoginSecret=$SERVER_LOGIN_PASSWORD_SECRET" \
  -e "BackendLoginConfiguration__ChecksumSecret=$SERVER_LOGIN_PASSWORD_SECRET" \
  -e "AuthenticationConfiguration__BackendLoginConfiguration__Secret=$USERNAME_SERVER_LOGIN_SECRET" \
  -e "AuthenticationConfiguration__BackendLoginConfiguration__UsernameSecret=$USERNAME_SERVER_LOGIN_SECRET" \
  -e "AuthenticationConfiguration__BackendLoginConfiguration__ServerLoginSecret=$SERVER_LOGIN_PASSWORD_SECRET" \
  -e "AuthenticationConfiguration__BackendLoginConfiguration__ChecksumSecret=$SERVER_LOGIN_PASSWORD_SECRET" \
  -e "fls-apikey=$FLS_APIKEY" \
  "$IMAGE" \
  /opt/dune-local/run-server.sh \
  Overmap \
  "-FarmRegion=$SERVER_REGION" \
  "-ini:engine:[FuncomLiveServices]:ServiceAuthToken=$FUNCOM_TOKEN" \
  -RMQGameTlsEnabled=true \
  "ServerName=$BATTLEGROUP_ID" \
  "-MultiHome=$MULTIHOME_IP" \
  -DatabaseName=dune \
  -DatabaseHost=127.0.0.1:15432 \
  -DatabaseUser=dune \
  -DatabasePassword=dune \
  "-PartitionIndex=$PARTITION_ID" \
  "-ini:engine:[URL]:Port=$GAME_PORT" \
  "-ini:engine:[URL]:IGWPort=$IGW_PORT" \
  -battlegroup-director-url=127.0.0.1:11717 \
  "--RMQGameHostname=$RMQ_GAME_HOST" \
  --RMQGamePort=31982 \
  "--RMQAdminHostname=$RMQ_ADMIN_HOST" \
  --RMQAdminPort=32573 \
  "${SIETCH_RUNTIME_ARGS[@]}" \
  "${LOG_RUNTIME_ARGS[@]}"

sleep 20

if live_server_id="$(bind_partition_to_live_server "$PARTITION_ID" Overmap "$GAME_PORT" "$IGW_PORT" 20 2)"; then
  echo "Bound Overmap partition $PARTITION_ID to server_id: $live_server_id"
fi
runtime/scripts/network-addresses.sh reconcile >/dev/null 2>&1 || true

docker ps --filter "name=dune-server-overmap" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo
echo "=== overmap logs ==="
docker logs --tail 180 dune-server-overmap
