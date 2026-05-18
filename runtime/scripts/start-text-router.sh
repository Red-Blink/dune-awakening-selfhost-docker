#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -f runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env

[ -f runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env
WORLD_IMAGE_TAG="${DUNE_WORLD_IMAGE_TAG:-1960494-0-shipping}"
IMAGE="registry.funcom.com/funcom/self-hosting/seabass-server-text-router:${WORLD_IMAGE_TAG}"

TOKEN_FILE="runtime/secrets/funcom-token.txt"
RMQ_SECRET_FILE="runtime/secrets/rmq-http-token-auth-secret.txt"

if [ ! -s "$TOKEN_FILE" ]; then
  echo "Missing Funcom token file: $TOKEN_FILE"
  exit 1
fi

if [ ! -s "$RMQ_SECRET_FILE" ]; then
  openssl rand -hex 32 > "$RMQ_SECRET_FILE"
  chmod 600 "$RMQ_SECRET_FILE"
fi

FUNCOM_TOKEN="$(tr -d '\r\n' < "$TOKEN_FILE")"
RMQ_HTTP_TOKEN_AUTH_SECRET="$(tr -d '\r\n' < "$RMQ_SECRET_FILE")"

SERVER_TITLE="${SERVER_TITLE:-My Dune Server}"
SERVER_REGION="${SERVER_REGION:-Europe Test}"
SERVER_IP="${SERVER_IP:-auto}"
BATTLEGROUP_ID="${BATTLEGROUP_ID:-dune-docker}"

if [ "$SERVER_IP" = "auto" ]; then
  SERVER_IP="$(curl -4fsSL https://api.ipify.org || echo 127.0.0.1)"
fi

mkdir -p runtime/fake-k8s-serviceaccount

cat > runtime/fake-k8s-serviceaccount/namespace <<'EOF'
funcom-seabass-dune-docker
EOF

cat > runtime/fake-k8s-serviceaccount/token <<'EOF'
fake-token
EOF

# Intentionally keep this empty for now.
# With this Funcom build, an invalid Kubernetes CA causes IGWO init to fail non-fatally,
# while a valid CA makes the app try to call igwo.local:6443 and crash unless we provide a compatibility API.
: > runtime/fake-k8s-serviceaccount/ca.crt

chmod -R 755 runtime/fake-k8s-serviceaccount

docker network create dune-net 2>/dev/null || true
docker rm -f dune-text-router 2>/dev/null || true

echo "Waiting for game RabbitMQ TLS listener..."
for i in $(seq 1 60); do
  if docker exec dune-rmq-game rabbitmq-diagnostics -q listeners 2>/dev/null | grep -q "5672.*amqp/ssl"; then
    echo "Game RabbitMQ TLS listener is ready."
    break
  fi
  sleep 2
done

echo "Waiting for game RabbitMQ AMQPS login path..."
for i in $(seq 1 60); do
  if timeout 3 bash -lc 'cat < /dev/null > /dev/tcp/127.0.0.1/31982' 2>/dev/null; then
    echo "Host port 31982 is reachable."
    break
  fi
  sleep 2
done

docker run -d \
  --name dune-text-router \
  --network dune-net \
  --restart unless-stopped \
  -p 127.0.0.1:5059:5059/tcp \
  -v "$PWD/runtime/fake-k8s-serviceaccount:/var/run/secrets/kubernetes.io/serviceaccount:ro" \
  -e "KUBERNETES_SERVICE_HOST=igwo.local" \
  -e "KUBERNETES_SERVICE_PORT=6443" \
  -e "KUBERNETES_SERVICE_PORT_HTTPS=6443" \
  -e "BATTLEGROUP=$BATTLEGROUP_ID" \
  -e "BATTLEGROUP_DISPLAY_NAME=$SERVER_TITLE" \
  -e "BATTLEGROUP_REGION_NAME=$SERVER_REGION" \
  -e "FuncomLiveServices__ServiceAuthToken=$FUNCOM_TOKEN" \
  -e "FuncomLiveServices__RmqTlsEnabled=true" \
  -e "RMQ_HTTP_TOKEN_AUTH_SECRET=$RMQ_HTTP_TOKEN_AUTH_SECRET" \
  -e "BATTLEGROUP_LANGUAGE=en-US" \
  -e "HOST_DATACENTER_ID=${SERVER_PROVIDER:-dune-docker}" \
  -e "HOST_DATACENTER_IP_ADDRESS=$SERVER_IP" \
  -e "ASPNETCORE_URLS=http://0.0.0.0:5059" \
  -e "DOTNET_HOSTBUILDER__RELOADCONFIGONCHANGE=false" \
  -e "Database_address=dune-postgres:5432" \
  -e "Database_name=dune" \
  -e "Database_user=dune" \
  -e "Database_password=dune" \
  "$IMAGE" \
  --RMQAdminHostname=dune-rmq-admin \
  --RMQAdminPort=5672 \
  --RMQGameHostname=dune-rmq-game \
  --RMQGamePort=5672

sleep 8

docker ps --filter "name=dune-text-router" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo
echo "=== text-router logs ==="
docker logs --tail 120 dune-text-router
