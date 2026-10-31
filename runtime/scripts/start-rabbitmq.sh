#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env

[ -r runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env
source runtime/scripts/host-paths.sh
source runtime/scripts/runtime-env.sh
source runtime/scripts/image-tags.sh
source runtime/scripts/generated-file-paths.sh
WORLD_IMAGE_TAG="$(resolve_world_image_tag)"
IMAGE="registry.funcom.com/funcom/self-hosting/seabass-server-rabbitmq:${WORLD_IMAGE_TAG}"
RMQ_ADMIN_PORT="$(resolve_rmq_admin_port)"
RMQ_ADMIN_HTTP_PORT="$(resolve_rmq_admin_http_port)"
RMQ_GAME_PORT="$(resolve_rmq_game_port)"
RMQ_GAME_HTTP_PORT="$(resolve_rmq_game_http_port)"
# Host-side loopback mirror of the game RabbitMQ management endpoint. The
# container-side management port remains 15672. Keeping the host port
# configurable lets multi-VM deployments maintain a globally unique host-port
# namespace while preserving the stock single-server default.
RMQ_GAME_LOCAL_HTTP_PORT="$(resolve_rmq_game_local_http_port)"

mkdir -p runtime/rabbitmq-admin/config
mkdir -p runtime/rabbitmq-game/config
mkdir -p runtime/rabbitmq-game/certs

for generated_file in \
  runtime/rabbitmq-admin/config/rabbitmq.conf \
  runtime/rabbitmq-admin/config/enabled_plugins \
  runtime/rabbitmq-game/config/rabbitmq.conf \
  runtime/rabbitmq-game/config/enabled_plugins \
  runtime/rabbitmq-game/certs/key.pem \
  runtime/rabbitmq-game/certs/cert.pem \
  runtime/rabbitmq-game/certs/cacert.pem
do
  repair_generated_file_path "$generated_file"
done

cat > runtime/rabbitmq-admin/config/rabbitmq.conf <<'EOF'
listeners.tcp.default = 5672
management.tcp.port = 15672
loopback_users.guest = false

auth_backends.1 = cache
auth_cache.cache_ttl = 5000
auth_cache.cached_backend = http

auth_http.http_method   = post
auth_http.user_path     = http://dune-text-router:5059/v0/auth/user
auth_http.vhost_path    = http://dune-text-router:5059/v0/auth/vhost
auth_http.resource_path = http://dune-text-router:5059/v0/auth/resource
auth_http.topic_path    = http://dune-text-router:5059/v0/auth/topic
EOF

cat > runtime/rabbitmq-game/config/rabbitmq.conf <<'EOF'
listeners.tcp = none
listeners.ssl.default = 5672

ssl_options.cacertfile = /etc/rabbitmq/cacert.pem
ssl_options.certfile   = /etc/rabbitmq/cert.pem
ssl_options.keyfile    = /etc/rabbitmq/key.pem
ssl_options.verify     = verify_none
ssl_options.fail_if_no_peer_cert = false

management.tcp.port = 15672
loopback_users.guest = false

auth_backends.1 = cache
auth_cache.cache_ttl = 5000
auth_cache.cached_backend = http

auth_http.http_method   = post
auth_http.user_path     = http://dune-text-router:5059/v0/auth/user
auth_http.vhost_path    = http://dune-text-router:5059/v0/auth/vhost
auth_http.resource_path = http://dune-text-router:5059/v0/auth/resource
auth_http.topic_path    = http://dune-text-router:5059/v0/auth/topic
EOF

if [ ! -f runtime/rabbitmq-game/certs/key.pem ]; then
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout runtime/rabbitmq-game/certs/key.pem \
    -out runtime/rabbitmq-game/certs/cert.pem \
    -days 365 \
    -subj "/CN=dune-rmq-game"

  cp runtime/rabbitmq-game/certs/cert.pem runtime/rabbitmq-game/certs/cacert.pem
fi

chmod 755 runtime/rabbitmq-game runtime/rabbitmq-game/certs runtime/rabbitmq-game/config
chmod 644 runtime/rabbitmq-game/certs/*.pem
cat > runtime/rabbitmq-admin/config/enabled_plugins <<'EOF'
[rabbitmq_management,rabbitmq_prometheus,rabbitmq_auth_backend_http,rabbitmq_auth_backend_cache].
EOF

cat > runtime/rabbitmq-game/config/enabled_plugins <<'EOF'
[rabbitmq_management,rabbitmq_prometheus,rabbitmq_auth_backend_http,rabbitmq_auth_backend_cache].
EOF

chmod 644 runtime/rabbitmq-game/config/rabbitmq.conf
chmod 644 runtime/rabbitmq-admin/config/rabbitmq.conf
chmod 644 runtime/rabbitmq-game/config/enabled_plugins
chmod 644 runtime/rabbitmq-admin/config/enabled_plugins

docker network create dune-net 2>/dev/null || true
docker rm -f dune-rmq-admin dune-rmq-game 2>/dev/null || true

# The management API is published on loopback, exactly as it already is for
# dune-rmq-game below. lib/rabbitmq.sh publishes and polls the hot paths through
# it, which is what keeps those calls from having to be a container exec each.
# Until this container is recreated with the mapping the seam simply falls back,
# so the change is safe to roll out before the next start-rabbitmq.sh run.
RMQ_ERL_ARGS="${DUNE_RMQ_ERL_ARGS:-+S 2:2 +sbwt none +sbwtdcpu none +sbwtdio none}"
RMQ_GAME_HTTP_BIND_IP="${RMQ_GAME_HTTP_BIND_IP:-127.0.0.1}"

docker run -d \
  "${DUNE_DOCKER_LOG_ARGS[@]}" \
  --name dune-rmq-admin \
  --network dune-net \
  --restart unless-stopped \
  --health-cmd "rabbitmq-diagnostics -q ping" \
  --health-interval 30s \
  --health-timeout 10s \
  --health-retries 3 \
  -e "RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS=${RMQ_ERL_ARGS}" \
  -p "127.0.0.1:${RMQ_ADMIN_PORT}:5672" \
  -p "127.0.0.1:${RMQ_ADMIN_HTTP_PORT}:15672/tcp" \
  -v "$(host_path "$PWD/runtime/rabbitmq-admin/config/rabbitmq.conf"):/etc/rabbitmq/rabbitmq.conf:ro" \
  -v "$(host_path "$PWD/runtime/rabbitmq-admin/config/enabled_plugins"):/etc/rabbitmq/enabled_plugins:ro" \
  "$IMAGE"
docker run -d \
  "${DUNE_DOCKER_LOG_ARGS[@]}" \
  --name dune-rmq-game \
  --network dune-net \
  --restart unless-stopped \
  --health-cmd "rabbitmq-diagnostics -q ping" \
  --health-interval 30s \
  --health-timeout 10s \
  --health-retries 3 \
  -e "RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS=${RMQ_ERL_ARGS}" \
  -p "${RMQ_GAME_PORT}:5672/tcp" \
  -p "127.0.0.1:${RMQ_GAME_LOCAL_HTTP_PORT}:15672/tcp" \
  -p "${RMQ_GAME_HTTP_BIND_IP}:${RMQ_GAME_HTTP_PORT}:15672/tcp" \
  -v "$(host_path "$PWD/runtime/rabbitmq-game/config/rabbitmq.conf"):/etc/rabbitmq/rabbitmq.conf:ro" \
  -v "$(host_path "$PWD/runtime/rabbitmq-game/config/enabled_plugins"):/etc/rabbitmq/enabled_plugins:ro" \
  -v "$(host_path "$PWD/runtime/rabbitmq-game/certs/cacert.pem"):/etc/rabbitmq/cacert.pem:ro" \
  -v "$(host_path "$PWD/runtime/rabbitmq-game/certs/cert.pem"):/etc/rabbitmq/cert.pem:ro" \
  -v "$(host_path "$PWD/runtime/rabbitmq-game/certs/key.pem"):/etc/rabbitmq/key.pem:ro" \
  "$IMAGE"

sleep 8

wait_for_rabbitmq() {
  local container="$1"
  local attempt

  echo "Waiting for $container..."
  for attempt in $(seq 1 36); do
    if timeout 10 docker exec "$container" rabbitmq-diagnostics -q ping; then
      return 0
    fi
    sleep 5
  done

  echo "$container did not become ready in time."
  docker logs --tail 120 "$container" 2>&1 || true
  return 1
}

wait_for_rabbitmq dune-rmq-admin
wait_for_rabbitmq dune-rmq-game

docker ps --filter "name=dune-rmq" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
