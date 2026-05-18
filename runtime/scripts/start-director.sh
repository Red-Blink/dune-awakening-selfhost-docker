#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -f runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env

[ -f runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env
WORLD_IMAGE_TAG="${DUNE_WORLD_IMAGE_TAG:-1960494-0-shipping}"
IMAGE="registry.funcom.com/funcom/self-hosting/seabass-server-bg-director:${WORLD_IMAGE_TAG}"

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

mkdir -p runtime/director/config
mkdir -p runtime/fake-k8s-serviceaccount

cat > runtime/director/config/director.ini <<'EOF'
[ Battlegroup ]
AuthorizationPreset = BattlegroupInternal

[ InstancingModes ]
DeepDesert_1=ClassicalInstancing

[ CB_Dungeon_Hephaestus ]
NumExtraServers = 0

[ CB_Dungeon_OldCarthag ]
NumExtraServers = 0

[ CB_Ecolab_Bronze_Green_024 ]
NumExtraServers = 0

[ CB_Ecolab_Bronze_Green_089 ]
NumExtraServers = 0

[ CB_Ecolab_Bronze_Green_136 ]
NumExtraServers = 0

[ CB_Ecolab_Bronze_Green_152 ]
NumExtraServers = 0

[ CB_Ecolab_Bronze_Green_195 ]
NumExtraServers = 0

[ CB_Overland_M_01 ]
NumExtraServers = 0

[ CB_Overland_S_04 ]
NumExtraServers = 0

[ CB_Overland_S_05 ]
NumExtraServers = 0

[ CB_Overland_S_06 ]
NumExtraServers = 0

[ CB_Overland_S_07 ]
NumExtraServers = 0

[ CB_Story_BanditFortress01 ]
NumExtraServers = 0

[ SH_Arrakeen ]
NumExtraServers = 0
MinServers = 0

[ SH_HarkoVillage ]
NumExtraServers = 0
MinServers = 0

[ DeepDesert_1 ]
NumExtraServers = 0
MinServers = 0

[ Story_ArtOfKanly ]
NumExtraServers = 0

[ Story_Faction_Outpost_Atre ]
NumExtraServers = 0

[ Story_Faction_Outpost_Hark ]
NumExtraServers = 0

[ Story_HeighlinerDungeon ]
NumExtraServers = 0
EOF

cat > runtime/fake-k8s-serviceaccount/namespace <<'EOF'
funcom-seabass-dune-docker
EOF

cat > runtime/fake-k8s-serviceaccount/token <<'EOF'
fake-token
EOF

# Same intentional trick as TextRouter for now:
# invalid CA makes IGWO init fail non-fatally instead of trying to call a missing API server.
: > runtime/fake-k8s-serviceaccount/ca.crt

chmod -R 755 runtime/fake-k8s-serviceaccount
chmod -R 755 runtime/director/config

docker network create dune-net 2>/dev/null || true
docker rm -f dune-director 2>/dev/null || true

docker run -d \
  --name dune-director \
  --network dune-net \
  --restart unless-stopped \
  -p 127.0.0.1:11717:11717/tcp \
  -v "$PWD/runtime/director/config:/etc/app/conf.d:ro" \
  -v "$PWD/runtime/fake-k8s-serviceaccount:/var/run/secrets/kubernetes.io/serviceaccount:ro" \
  -e "KUBERNETES_SERVICE_HOST=igwo.local" \
  -e "KUBERNETES_SERVICE_PORT=6443" \
  -e "KUBERNETES_SERVICE_PORT_HTTPS=6443" \
  -e "KUBERNETES_SERVICE_PATH=/var/run/secrets/kubernetes.io/serviceaccount" \
  -e "BATTLEGROUP=$BATTLEGROUP_ID" \
  -e "BATTLEGROUP_DISPLAY_NAME=$BATTLEGROUP_ID" \
  -e "BATTLEGROUP_TITLE=$SERVER_TITLE" \
  -e "BATTLEGROUP_REGION_NAME=$SERVER_REGION" \
  -e "FuncomLiveServices__ServiceAuthToken=$FUNCOM_TOKEN" \
  -e "FuncomLiveServices__RmqTlsEnabled=true" \
  -e "RMQ_HTTP_TOKEN_AUTH_SECRET=$RMQ_HTTP_TOKEN_AUTH_SECRET" \
  -e "fls-apikey=$FLS_APIKEY" \
  -e "HOST_DATACENTER_ID=${SERVER_PROVIDER:-dune-docker}" \
  -e "HOST_DATACENTER_IP_ADDRESS=$SERVER_IP" \
  -e "ASPNETCORE_URLS=http://0.0.0.0:11717" \
  -e "DOTNET_HOSTBUILDER__RELOADCONFIGONCHANGE=false" \
  -e "Database_address=dune-postgres:5432" \
  -e "Database_name=dune" \
  -e "Database_user=dune" \
  -e "Database_password=dune" \
  "$IMAGE" \
  --RMQGameHostname=dune-rmq-game \
  --RMQGamePort=5672 \
  --RMQAdminHostname=dune-rmq-admin \
  --RMQAdminPort=5672

sleep 12

docker ps --filter "name=dune-director" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo
echo "=== director logs ==="
docker logs --tail 160 dune-director
