#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -f runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env

[ -f runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env
WORLD_IMAGE_TAG="${DUNE_WORLD_IMAGE_TAG:-1960494-0-shipping}"
IMAGE="registry.funcom.com/funcom/self-hosting/seabass-server:${WORLD_IMAGE_TAG}"

TOKEN_FILE="runtime/secrets/funcom-token.txt"
RMQ_SECRET_FILE="runtime/secrets/rmq-http-token-auth-secret.txt"
FLS_APIKEY_FILE="runtime/secrets/fls-apikey.txt"

FUNCOM_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
RMQ_HTTP_TOKEN_AUTH_SECRET="$(tr -d '\r\n' < "$RMQ_SECRET_FILE")"
FLS_APIKEY="$(tr -d '\r\n' < "$FLS_APIKEY_FILE")"

SERVER_TITLE="${SERVER_TITLE:-My Dune Server}"
SERVER_REGION="${SERVER_REGION:-Europe Test}"
SERVER_IP="${SERVER_IP:-auto}"
BATTLEGROUP_ID="${BATTLEGROUP_ID:-dune-docker}"

if [ "$SERVER_IP" = "auto" ]; then
  SERVER_IP="$(curl -4fsSL https://api.ipify.org || echo 127.0.0.1)"
fi

MULTIHOME_IP="${SERVER_BIND_IP:-auto}"
if [ "$MULTIHOME_IP" = "auto" ]; then
  MULTIHOME_IP="$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
fi

mkdir -p runtime/game/overmap/Saved
mkdir -p runtime/game/artifacts
mkdir -p runtime/fake-k8s-serviceaccount

cat > runtime/fake-k8s-serviceaccount/namespace <<'EOF'
funcom-seabass-dune-docker
EOF
cat > runtime/fake-k8s-serviceaccount/token <<'EOF'
fake-token
EOF
: > runtime/fake-k8s-serviceaccount/ca.crt
chmod -R 755 runtime/fake-k8s-serviceaccount

docker rm -f dune-server-overmap 2>/dev/null || true

docker run -d \
  --name dune-server-overmap \
  --network host \
  --restart unless-stopped \
  --privileged \
  --cap-add SYS_ADMIN \
  --security-opt seccomp=unconfined \
  --memory 2g \
  --memory-reservation 2g \
  -v "$PWD/runtime/game/overmap/Saved:/home/dune/server/DuneSandbox/Saved" \
  -v "$PWD/runtime/game/artifacts:/home/dune/artifacts" \
  -v "$PWD/runtime/fake-k8s-serviceaccount:/var/run/secrets/kubernetes.io/serviceaccount:ro" \
  -e "POD_UID=docker-overmap" \
  -e "POD_NAME=${BATTLEGROUP_ID}-sg-overmap-pod-2" \
  -e "POD_IP=$MULTIHOME_IP" \
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
  -e "fls-apikey=$FLS_APIKEY" \
  "$IMAGE" \
  /home/dune/run.sh \
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
  -PartitionIndex=2 \
  "-ini:engine:[URL]:Port=7777" \
  "-ini:engine:[URL]:IGWPort=7889" \
  -battlegroup-director-url=127.0.0.1:11717 \
  --RMQGameHostname=127.0.0.1 \
  --RMQGamePort=31982 \
  --RMQAdminHostname=127.0.0.1 \
  --RMQAdminPort=32573 \
  -stdout \
  -FullStdOutLogOutput

sleep 20

docker ps --filter "name=dune-server-overmap" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo
echo "=== overmap logs ==="
docker logs --tail 180 dune-server-overmap
