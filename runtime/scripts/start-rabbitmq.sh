#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env

[ -r runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env
source runtime/scripts/host-paths.sh
source runtime/scripts/image-tags.sh
WORLD_IMAGE_TAG="$(resolve_world_image_tag)"
IMAGE="registry.funcom.com/funcom/self-hosting/seabass-server-rabbitmq:${WORLD_IMAGE_TAG}"
RMQ_GAME_HTTP_BIND="${RMQ_GAME_HTTP_BIND:-127.0.0.1}"

mkdir -p runtime/rabbitmq-admin/config
mkdir -p runtime/rabbitmq-game/config
mkdir -p runtime/rabbitmq-game/certs

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

docker run -d \
  --name dune-rmq-admin \
  --network dune-net \
  --restart unless-stopped \
  -p 127.0.0.1:32573:5672 \
  -v "$(host_path "$PWD/runtime/rabbitmq-admin/config/rabbitmq.conf"):/etc/rabbitmq/rabbitmq.conf:ro" \
  -v "$(host_path "$PWD/runtime/rabbitmq-admin/config/enabled_plugins"):/etc/rabbitmq/enabled_plugins:ro" \
  "$IMAGE"

docker run -d \
  --name dune-rmq-game \
  --network dune-net \
  --restart unless-stopped \
  -p 31982:5672/tcp \
  -p 127.0.0.1:15672:15672/tcp \
  -p "${RMQ_GAME_HTTP_BIND}:31983:15672/tcp" \
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
