#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -f runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env

[ -f runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env
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
GAME_PORT="$((CLIENT_PORT_BASE + 1))"
IGW_PORT="$IGW_PORT_BASE"
MEMORY="${DUNE_MEMORY_SURVIVAL_1:-12g}"
PARTITION_ID="${DUNE_SURVIVAL_PARTITION_ID:-1}"
if [ -n "${DUNE_FAKE_K8S_SERVICEACCOUNT_DIR:-}" ]; then
  FAKE_K8S_SERVICEACCOUNT_DIR="$DUNE_FAKE_K8S_SERVICEACCOUNT_DIR"
else
  FAKE_K8S_SERVICEACCOUNT_DIR="$PWD/runtime/generated/dune-fake-k8s-serviceaccount-survival-1-$$"
fi


MULTIHOME_IP="$(resolve_bind_ip)"

mkdir -p runtime/game/survival-1/Saved
mkdir -p runtime/game/artifacts
mkdir -p "$FAKE_K8S_SERVICEACCOUNT_DIR"
mkdir -p runtime/container
python3 runtime/scripts/usersettings.py materialize Survival_1 "$PWD/runtime/game/survival-1/Saved" "$PARTITION_ID"

cat > "$FAKE_K8S_SERVICEACCOUNT_DIR/namespace" <<'EOF'
funcom-seabass-dune-docker
EOF
cat > "$FAKE_K8S_SERVICEACCOUNT_DIR/token" <<'EOF'
fake-token
EOF
: > "$FAKE_K8S_SERVICEACCOUNT_DIR/ca.crt"
chmod -R 755 "$FAKE_K8S_SERVICEACCOUNT_DIR"

mapfile -t SIETCH_RUNTIME_ARGS < <(runtime/scripts/sietches.sh runtime-args Survival_1 "$PARTITION_ID" 2>/dev/null || true)

docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
begin;
delete from dune.farm_state
where map = 'Survival_1'
  and coalesce(alive, false) = false
  and server_id not in (
    select server_id
    from dune.world_partition
    where coalesce(server_id, '') <> ''
  );
commit;
" >/dev/null

docker rm -f dune-server-survival-1 2>/dev/null || true

docker run -d \
  --name dune-server-survival-1 \
  --network host \
  --restart unless-stopped \
  --privileged \
  --cap-add SYS_ADMIN \
  --security-opt seccomp=unconfined \
  --memory "$MEMORY" \
  --memory-reservation "$MEMORY" \
  -v "$PWD/runtime/game/survival-1/Saved:/home/dune/server/DuneSandbox/Saved" \
  -v "$PWD/runtime/game/artifacts:/home/dune/artifacts" \
  -v "$PWD/runtime/container:/opt/dune-local:ro" \
  -v "$FAKE_K8S_SERVICEACCOUNT_DIR:/run/secrets/kubernetes.io/serviceaccount:ro" \
  -e "POD_UID=docker-survival-1" \
  -e "POD_NAME=${BATTLEGROUP_ID}-sg-survival-1-pod-1" \
  -e "POD_IP=$MULTIHOME_IP" \
  -e "EXTERNAL_ADDRESS_OVERRIDE=$SERVER_IP" \
  -e "NODE_NAME=$(hostname)" \
  -e "SERVER_INDEX=1" \
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
  Survival_1 \
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
  --RMQGameHostname=127.0.0.1 \
  --RMQGamePort=31982 \
  --RMQAdminHostname=127.0.0.1 \
  --RMQAdminPort=32573 \
  "${SIETCH_RUNTIME_ARGS[@]}" \
  -stdout \
  -FullStdOutLogOutput

sleep 20

docker ps --filter "name=dune-server-survival-1" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo
echo "=== survival logs ==="
docker logs --tail 180 dune-server-survival-1
