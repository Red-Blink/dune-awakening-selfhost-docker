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
IMAGE="registry.funcom.com/funcom/self-hosting/seabass-server-text-router:${WORLD_IMAGE_TAG}"
TEXT_ROUTER_PORT="$(resolve_text_router_port)"

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

SERVER_TITLE="$(resolve_server_title)"
SERVER_REGION="$(resolve_server_region)"
SERVER_IP="$(resolve_server_ip)"
BATTLEGROUP_ID="$(resolve_battlegroup_id)"
DUNE_DB_PASSWORD="${DUNE_DB_PASSWORD:-dune}"
if [ -n "${DUNE_FAKE_K8S_SERVICEACCOUNT_DIR:-}" ]; then
  FAKE_K8S_SERVICEACCOUNT_DIR="$DUNE_FAKE_K8S_SERVICEACCOUNT_DIR"
else
  FAKE_K8S_SERVICEACCOUNT_DIR="$PWD/runtime/generated/dune-fake-k8s-serviceaccount-text-router-$$"
fi


mkdir -p "$FAKE_K8S_SERVICEACCOUNT_DIR"

cat > "$FAKE_K8S_SERVICEACCOUNT_DIR/namespace" <<'EOF'
funcom-seabass-dune-docker
EOF

cat > "$FAKE_K8S_SERVICEACCOUNT_DIR/token" <<'EOF'
fake-token
EOF

# Intentionally keep this empty for now.
# With this Funcom build, an invalid Kubernetes CA causes IGWO init to fail non-fatally,
# while a valid CA makes the app try to call igwo.local:6443 and crash unless we provide a compatibility API.
: > "$FAKE_K8S_SERVICEACCOUNT_DIR/ca.crt"

chmod -R 755 "$FAKE_K8S_SERVICEACCOUNT_DIR"

docker network create dune-net 2>/dev/null || true
docker rm -f dune-text-router 2>/dev/null || true

echo "Waiting for game RabbitMQ TLS listener..."
rmq_tls_ready=0
for i in $(seq 1 60); do
  if timeout 5 docker exec dune-rmq-game rabbitmq-diagnostics -q listeners 2>/dev/null | grep -q "5672.*amqp/ssl"; then
    echo "Game RabbitMQ TLS listener is ready."
    rmq_tls_ready=1
    break
  fi
  sleep 2
done

if [ "$rmq_tls_ready" != "1" ]; then
  echo "Game RabbitMQ TLS listener was not confirmed before TextRouter start."
  echo "Continuing anyway; TextRouter will retry RabbitMQ while starting."
fi

docker run -d \
  --name dune-text-router \
  --network dune-net \
  --restart unless-stopped \
  -p "127.0.0.1:${TEXT_ROUTER_PORT}:5059/tcp" \
  -v "$(host_path "$FAKE_K8S_SERVICEACCOUNT_DIR"):/run/secrets/kubernetes.io/serviceaccount:ro" \
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
  -e "Database_password=$DUNE_DB_PASSWORD" \
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
