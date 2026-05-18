#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

usage() {
  cat <<'EOF'
Usage:
  dune spawn <map-name|partition-id>

Examples:
  dune spawn DeepDesert_1
  dune spawn SH_Arrakeen
  dune spawn 30

Notes:
  - Picks the first unassigned partition for a map.
  - Uses UDP 7779-7810 for client/game ports.
  - Uses UDP 7890-7921 for IGW/server-to-server ports.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] || [ $# -lt 1 ]; then
  usage
  exit 0
fi

TARGET="$1"

[ -f .env ] && . ./.env
[ -f runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env
[ -f runtime/generated/image-tags.env ] && . runtime/generated/image-tags.env

WORLD_IMAGE_TAG="${DUNE_WORLD_IMAGE_TAG:-1960494-0-shipping}"
IMAGE="registry.funcom.com/funcom/self-hosting/seabass-server:${WORLD_IMAGE_TAG}"

TOKEN_FILE="runtime/secrets/funcom-token.txt"
RMQ_SECRET_FILE="runtime/secrets/rmq-http-token-auth-secret.txt"
FLS_APIKEY_FILE="runtime/secrets/fls-apikey.txt"

for f in "$TOKEN_FILE" "$RMQ_SECRET_FILE" "$FLS_APIKEY_FILE"; do
  if [ ! -f "$f" ]; then
    echo "Missing required secret file: $f"
    exit 1
  fi
done

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

if ! docker ps --format '{{.Names}}' | grep -qx dune-postgres; then
  echo "dune-postgres is not running."
  exit 1
fi

psql_value() {
  docker exec dune-postgres psql -U postgres -d dune -Atc "$1"
}

if [[ "$TARGET" =~ ^[0-9]+$ ]]; then
  ROW="$(psql_value "
    select partition_id || '|' || map || '|' || dimension_index || '|' || coalesce(label,'') || '|' || coalesce(server_id,'')
    from dune.world_partition
    where partition_id = $TARGET
    limit 1;
  ")"
else
  SAFE_TARGET="${TARGET//\'/\'\'}"
  ROW="$(psql_value "
    select partition_id || '|' || map || '|' || dimension_index || '|' || coalesce(label,'') || '|' || coalesce(server_id,'')
    from dune.world_partition
    where lower(map) = lower('$SAFE_TARGET')
      and coalesce(server_id,'') = ''
      and blocked = false
    order by partition_id
    limit 1;
  ")"

  if [ -z "$ROW" ]; then
    ROW="$(psql_value "
      select partition_id || '|' || map || '|' || dimension_index || '|' || coalesce(label,'') || '|' || coalesce(server_id,'')
      from dune.world_partition
      where lower(map) = lower('$SAFE_TARGET')
      order by partition_id
      limit 1;
    ")"
  fi
fi

if [ -z "$ROW" ]; then
  echo "Could not find map or partition: $TARGET"
  exit 1
fi

IFS='|' read -r PARTITION_ID MAP_NAME DIMENSION_INDEX LABEL ASSIGNED_SERVER <<< "$ROW"

if [ -n "$ASSIGNED_SERVER" ]; then
  echo "Partition $PARTITION_ID ($MAP_NAME / $LABEL) is already assigned to server: $ASSIGNED_SERVER"
  exit 1
fi

safe_name="$(echo "$MAP_NAME-$PARTITION_ID" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')"
CONTAINER_NAME="dune-server-${safe_name}"

memory_for_map() {
  local map="$1"
  python3 - "$map" <<'PY'
import json
import sys
from pathlib import Path

target = sys.argv[1].lower()
catalog_path = Path("runtime/generated/server-catalog.json")

default = "3g"

if not catalog_path.exists():
    print(default)
    raise SystemExit

catalog = json.loads(catalog_path.read_text())
for item in catalog:
    if str(item.get("map", "")).lower() == target:
        mem = item.get("resources", {}).get("limits", {}).get("memory", "")
        if mem:
            print(mem.replace("Gi", "g").replace("G", "g"))
            raise SystemExit

print(default)
PY
}

MEMORY="$(memory_for_map "$MAP_NAME")"
server_index_for_map() {
  local map="$1"
  python3 - "$map" <<'SERVERINDEXPY'
import json
import sys
from pathlib import Path

target = sys.argv[1].lower()
catalog_path = Path("runtime/generated/server-catalog.json")

if not catalog_path.exists():
    print("0")
    raise SystemExit

catalog = json.loads(catalog_path.read_text())
for item in catalog:
    if str(item.get("map", "")).lower() == target:
        print(int(item.get("index", 0)) + 1)
        raise SystemExit

print("0")
SERVERINDEXPY
}

SERVER_INDEX="$(server_index_for_map "$MAP_NAME")"

if [ "$SERVER_INDEX" = "0" ]; then
  echo "Could not determine SERVER_INDEX for map: $MAP_NAME"
  echo "Make sure runtime/generated/server-catalog.json exists."
  exit 1
fi


port_is_free() {
  local port="$1"
  ! ss -lnup | grep -q ":$port "
}

pick_port() {
  local start="$1"
  local end="$2"
  local p
  for p in $(seq "$start" "$end"); do
    if port_is_free "$p"; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

GAME_PORT="$(pick_port 7779 7810 || true)"
IGW_PORT="$(pick_port 7890 7921 || true)"

if [ -z "$GAME_PORT" ] || [ -z "$IGW_PORT" ]; then
  echo "Could not find free UDP ports."
  echo "Game port range checked: 7779-7810"
  echo "IGW port range checked: 7890-7921"
  exit 1
fi

echo "Spawning dedicated server:"
echo "  map:        $MAP_NAME"
echo "  partition:  $PARTITION_ID"
echo "  dimension:  $DIMENSION_INDEX"
echo "  label:      $LABEL"
echo "  memory:     $MEMORY"
echo "  server idx: $SERVER_INDEX"
echo "  game port:  $GAME_PORT"
echo "  igw port:   $IGW_PORT"
echo "  container:  $CONTAINER_NAME"
echo

mkdir -p "runtime/game/$safe_name/Saved"
mkdir -p runtime/game/artifacts
mkdir -p runtime/fake-k8s-serviceaccount

cat > runtime/fake-k8s-serviceaccount/namespace <<EOF
funcom-seabass-$BATTLEGROUP_ID
EOF
cat > runtime/fake-k8s-serviceaccount/token <<'EOF'
fake-token
EOF
: > runtime/fake-k8s-serviceaccount/ca.crt
chmod -R 755 runtime/fake-k8s-serviceaccount

docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

docker run -d \
  --name "$CONTAINER_NAME" \
  --network host \
  --restart unless-stopped \
  --privileged \
  --cap-add SYS_ADMIN \
  --security-opt seccomp=unconfined \
  --memory "$MEMORY" \
  --memory-reservation "$MEMORY" \
  -v "$PWD/runtime/game/$safe_name/Saved:/home/dune/server/DuneSandbox/Saved" \
  -v "$PWD/runtime/game/artifacts:/home/dune/artifacts" \
  -v "$PWD/runtime/fake-k8s-serviceaccount:/var/run/secrets/kubernetes.io/serviceaccount:ro" \
  -e "POD_UID=docker-$safe_name" \
  -e "POD_NAME=${BATTLEGROUP_ID}-sg-${safe_name}-pod-${PARTITION_ID}" \
  -e "POD_IP=$MULTIHOME_IP" \
  -e "NODE_NAME=$(hostname)" \
  -e "SERVER_INDEX=$SERVER_INDEX" \
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
  "$MAP_NAME" \
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
  -stdout \
  -FullStdOutLogOutput

sleep 5

docker ps --filter "name=$CONTAINER_NAME" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo
echo "Watch logs with:"
echo "  docker logs -f $CONTAINER_NAME"
