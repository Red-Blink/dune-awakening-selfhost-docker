#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env

[ -r runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env
source runtime/scripts/host-paths.sh
source runtime/scripts/runtime-env.sh
source runtime/scripts/image-tags.sh
source runtime/scripts/sietch-login-password-args.sh
source runtime/scripts/fake-k8s-serviceaccount.sh

# shellcheck source=runtime/scripts/lib/postgres.sh
source runtime/scripts/lib/postgres.sh
# shellcheck source=runtime/scripts/lib/game-container.sh
source runtime/scripts/lib/game-container.sh
IMAGE="$(resolve_game_server_image)"

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
DUNE_DB_PASSWORD="${DUNE_DB_PASSWORD:-dune}"
CLIENT_PORT_BASE="$(resolve_client_port_base)"
IGW_PORT_BASE="$(resolve_igw_port_base)"
POSTGRES_PORT="$(resolve_postgres_port)"
RMQ_ADMIN_PORT="$(resolve_rmq_admin_port)"
RMQ_GAME_PORT="$(resolve_rmq_game_port)"
DIRECTOR_PORT="$(resolve_director_port)"
GAME_PORT="$CLIENT_PORT_BASE"
IGW_PORT="$((IGW_PORT_BASE + 1))"
MEMORY="${DUNE_MEMORY_OVERMAP:-$(default_memory_for_map Overmap)}"
PARTITION_ID="${DUNE_OVERMAP_PARTITION_ID:-2}"
FAKE_K8S_SERVICEACCOUNT_DIR="$(fake_k8s_serviceaccount_dir overmap)"


MULTIHOME_IP="$(resolve_bind_ip)"
RMQ_GAME_HOST="$(resolve_rmq_game_host)"
RMQ_ADMIN_HOST="$(resolve_rmq_admin_host)"
mapfile -t GAME_EXTERNAL_ADDRESS_ENV < <(game_external_address_override_env_args)
validate_game_external_address_override_env_args "${GAME_EXTERNAL_ADDRESS_ENV[@]}"

bind_partition_to_live_server() {
  bind_core_partition_to_live_server "$@"
}

mkdir -p runtime/game/overmap/Saved
mkdir -p runtime/game/artifacts
mkdir -p runtime/container
prepare_fake_k8s_serviceaccount "$FAKE_K8S_SERVICEACCOUNT_DIR" funcom-seabass-dune-docker

mapfile -t SIETCH_RUNTIME_ARGS < <(runtime/scripts/sietches.sh runtime-args Overmap "$PARTITION_ID" 2>/dev/null || true)
mapfile -t LOG_RUNTIME_ARGS < <(full_stdout_log_args)

# GHSA-fc89-h24v-6j3x (issue #252): move ServerLoginPassword/ServerPassword
# from docker run positional arguments to environment variables -- see
# sietch-login-password-args.sh for the full rationale and the shared
# implementation used identically by all three launcher scripts.
declare -a SIETCH_LOGIN_PASSWORD_ARGS
declare -a SIETCH_RUNTIME_ARGS_FILTERED
sietch_login_password_docker_args SIETCH_RUNTIME_ARGS SIETCH_LOGIN_PASSWORD_ARGS SIETCH_RUNTIME_ARGS_FILTERED
SIETCH_RUNTIME_ARGS=("${SIETCH_RUNTIME_ARGS_FILTERED[@]}")

runtime/scripts/network-addresses.sh reconcile >/dev/null 2>&1 || true

docker rm -f dune-server-overmap 2>/dev/null || true
runtime/scripts/repair-map-settings-permissions.sh overmap
python3 runtime/scripts/usersettings.py materialize Overmap "$PWD/runtime/game/overmap/Saved" "$PARTITION_ID"

dune_psql -v ON_ERROR_STOP=1 -c "
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

ensure_host_latency_tuned
mapfile -t MEMORY_SWAP_ARGS < <(memory_swap_docker_args "$MEMORY")
mapfile -t GAME_CONTAINER_SECURITY_ARGS < <(game_container_security_args)
GAME_SECRET_ENV_FILE="$(prepare_game_container_secret_file overmap)"

docker run -d \
  "${DUNE_DOCKER_LOG_ARGS[@]}" \
  --name dune-server-overmap \
  --network host \
  --restart unless-stopped \
  "${GAME_CONTAINER_SECURITY_ARGS[@]}" \
  --memory "$MEMORY" \
  "${MEMORY_SWAP_ARGS[@]}" \
  --memory-reservation "$MEMORY" \
  -v "$(host_path "$PWD/runtime/game/overmap/Saved"):/home/dune/server/DuneSandbox/Saved" \
  -v "$(host_path "$PWD/runtime/game/artifacts"):/home/dune/artifacts" \
  -v "$(host_path "$PWD/runtime/container"):/opt/dune-local:ro" \
  -v "$(host_path "$FAKE_K8S_SERVICEACCOUNT_DIR"):/run/secrets/kubernetes.io/serviceaccount:ro" \
  -v "$(host_path "$GAME_SECRET_ENV_FILE"):/run/secrets/dune-game-env:ro" \
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
  -e "FuncomLiveServices__RmqTlsEnabled=true" \
  "${SIETCH_LOGIN_PASSWORD_ARGS[@]}" \
  "$IMAGE" \
  /opt/dune-local/run-server.sh \
  Overmap \
  "-FarmRegion=$SERVER_REGION" \
  "-ini:engine:[FuncomLiveServices]:ServiceAuthToken=$FUNCOM_TOKEN" \
  -RMQGameTlsEnabled=true \
  "ServerName=$BATTLEGROUP_ID" \
  "-MultiHome=$MULTIHOME_IP" \
  -DatabaseName=dune \
  "-DatabaseHost=127.0.0.1:${POSTGRES_PORT}" \
  -DatabaseUser=dune \
  "-DatabasePassword=$DUNE_DB_PASSWORD" \
  "-PartitionIndex=$PARTITION_ID" \
  "-ini:engine:[URL]:Port=$GAME_PORT" \
  "-ini:engine:[URL]:IGWPort=$IGW_PORT" \
  "-battlegroup-director-url=127.0.0.1:${DIRECTOR_PORT}" \
  "--RMQGameHostname=$RMQ_GAME_HOST" \
  "--RMQGamePort=${RMQ_GAME_PORT}" \
  "--RMQAdminHostname=$RMQ_ADMIN_HOST" \
  "--RMQAdminPort=${RMQ_ADMIN_PORT}" \
  "${SIETCH_RUNTIME_ARGS[@]}" \
  "${LOG_RUNTIME_ARGS[@]}"

prune_legacy_fake_k8s_serviceaccounts

sleep 20

if live_server_id="$(bind_partition_to_live_server "$PARTITION_ID" Overmap "$GAME_PORT" "$IGW_PORT" 20 2)"; then
  echo "Bound Overmap partition $PARTITION_ID to server_id: $live_server_id"
fi
runtime/scripts/network-addresses.sh reconcile >/dev/null 2>&1 || true

docker ps --filter "name=dune-server-overmap" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo
echo "=== overmap logs ==="
docker logs --tail 180 dune-server-overmap
