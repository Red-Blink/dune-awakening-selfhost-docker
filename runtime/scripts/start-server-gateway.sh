#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -f runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env

[ -f runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env
WORLD_IMAGE_TAG="${DUNE_WORLD_IMAGE_TAG:-1960494-0-shipping}"
IMAGE="registry.funcom.com/funcom/self-hosting/seabass-server-gateway:${WORLD_IMAGE_TAG}"

TOKEN_FILE="runtime/secrets/funcom-token.txt"
RMQ_SECRET_FILE="runtime/secrets/rmq-http-token-auth-secret.txt"
FLS_APIKEY_FILE="runtime/secrets/fls-apikey.txt"

if [ ! -s "$TOKEN_FILE" ]; then
  echo "Missing Funcom token file: $TOKEN_FILE"
  exit 1
fi

if [ ! -s "$RMQ_SECRET_FILE" ]; then
  openssl rand -hex 32 > "$RMQ_SECRET_FILE"
  chmod 600 "$RMQ_SECRET_FILE"
fi

if [ ! -s "$FLS_APIKEY_FILE" ]; then
  openssl rand -hex 16 > "$FLS_APIKEY_FILE"
  chmod 600 "$FLS_APIKEY_FILE"
fi

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

mkdir -p runtime/server-gateway/config

docker network create dune-net 2>/dev/null || true
docker rm -f dune-server-gateway 2>/dev/null || true

docker run -d \
  --name dune-server-gateway \
  --network dune-net \
  --restart unless-stopped \
  -v "$PWD/runtime/server-gateway/config:/etc/app/conf.d:ro" \
  -e "FuncomLiveServices__ServiceAuthToken=$FUNCOM_TOKEN" \
  -e "FuncomLiveServices__RmqTlsEnabled=true" \
  -e "FuncomLiveServices__BattlegroupAuthorizationPreset=BattlegroupInternal" \
  -e "RMQ_HTTP_TOKEN_AUTH_SECRET=$RMQ_HTTP_TOKEN_AUTH_SECRET" \
  -e "fls-apikey=$FLS_APIKEY" \
  -e "gateway_farm_api_key=$FLS_APIKEY" \
  -e "HOST_DATACENTER_ID=${SERVER_PROVIDER:-dune-docker}" \
  -e "HOST_DATACENTER_IP_ADDRESS=$SERVER_IP" \
  -e "BATTLEGROUP=$BATTLEGROUP_ID" \
  -e "BATTLEGROUP_DISPLAY_NAME=$BATTLEGROUP_ID" \
  -e "BATTLEGROUP_TITLE=$SERVER_TITLE" \
  -e "DuneDatabaseInterfacePSQL_DatabaseHost=dune-postgres:5432" \
  -e "DuneDatabaseInterfacePSQL_DatabaseName=dune" \
  -e "DuneDatabaseInterfacePSQL_DatabaseUser=dune" \
  -e "DuneDatabaseInterfacePSQL_DatabasePassword=dune" \
  -e "OnlineSubsystem_ServerName=$BATTLEGROUP_ID" \
  -e "gateway_display_name=$SERVER_TITLE" \
  -e "OnlineSubsystem_DatacenterId=$SERVER_REGION" \
  "$IMAGE" \
  python \
  -m service \
  -c ./service/configs/service.conf \
  --RMQGameHostname="$SERVER_IP" \
  --RMQGamePort=31982

sleep 12

docker ps --filter "name=dune-server-gateway" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo
echo "=== server-gateway logs ==="
docker logs --tail 180 dune-server-gateway
