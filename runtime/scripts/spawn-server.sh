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
  - Dynamic ports are derived from the configured UserEngine Port and IGWPort values.
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
source runtime/scripts/runtime-env.sh
source runtime/scripts/image-tags.sh

WORLD_IMAGE_TAG="$(resolve_world_image_tag)"
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

SERVER_LOGIN_PASSWORD_SECRET="$(resolve_server_login_password_secret)"
USERNAME_SERVER_LOGIN_SECRET="$(resolve_username_server_login_secret)"
LOGIN_PASSWORD_SKEW_SECONDS="$(resolve_login_password_skew_seconds)"

SERVER_TITLE="$(resolve_server_title)"
SERVER_REGION="$(resolve_server_region)"
SERVER_IP="$(resolve_server_ip)"
BATTLEGROUP_ID="$(resolve_battlegroup_id)"
CLIENT_PORT_BASE="$(resolve_client_port_base)"
IGW_PORT_BASE="$(resolve_igw_port_base)"


MULTIHOME_IP="$(resolve_bind_ip)"

if ! docker ps --format '{{.Names}}' | grep -qx dune-postgres; then
  echo "dune-postgres is not running."
  exit 1
fi

psql_value() {
  docker exec dune-postgres psql -U postgres -d dune -Atc "$1"
}

purge_stale_farm_rows_for_map() {
  local map="$1"
  local safe_map
  safe_map="${map//\'/\'\'}"

  docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
begin;
delete from dune.farm_state fs
where fs.map = '$safe_map'
  and coalesce(fs.alive, false) = false
  and fs.server_id not in (
    select server_id
    from dune.world_partition
    where server_id is not null
  );
commit;
" >/dev/null
}

clear_dead_partition_assignment() {
  local partition_id="$1"
  local assigned_server="$2"
  local alive_state

  [ -n "$partition_id" ] || return 1
  [ -n "$assigned_server" ] || return 1

  alive_state="$(psql_value "
    select coalesce(alive::text, '')
    from dune.farm_state
    where server_id = '${assigned_server//\'/\'\'}'
    limit 1;
  ")"

  if [ "$alive_state" = "true" ]; then
    return 1
  fi

  docker exec dune-postgres psql -U postgres -d dune -v ON_ERROR_STOP=1 -c "
begin;
update dune.world_partition
set server_id = null
where partition_id = $partition_id
  and server_id = '${assigned_server//\'/\'\'}';
delete from dune.farm_state
where server_id = '${assigned_server//\'/\'\'}';
commit;
" >/dev/null

  return 0
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
  if clear_dead_partition_assignment "$PARTITION_ID" "$ASSIGNED_SERVER"; then
    ASSIGNED_SERVER=""
  else
    echo "Partition $PARTITION_ID ($MAP_NAME / $LABEL) is already assigned to server: $ASSIGNED_SERVER"
    exit 1
  fi
fi

safe_name="$(echo "$MAP_NAME-$PARTITION_ID" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')"
CONTAINER_NAME="dune-server-${safe_name}"

if [ -n "${DUNE_FAKE_K8S_SERVICEACCOUNT_DIR:-}" ]; then
  FAKE_K8S_SERVICEACCOUNT_DIR="$DUNE_FAKE_K8S_SERVICEACCOUNT_DIR"
else
  FAKE_K8S_SERVICEACCOUNT_DIR="$PWD/runtime/generated/dune-fake-k8s-serviceaccount-${safe_name}-$$"
fi

memory_for_map() {
  local map="$1"
  local map_key
  local env_key
  local configured

  map_key="$(printf '%s' "$map" | tr '[:lower:]' '[:upper:]' | sed 's/[^A-Z0-9]/_/g; s/__*/_/g; s/^_//; s/_$//')"
  env_key="DUNE_MEMORY_${map_key}"
  configured="${!env_key:-}"

  if [ -n "$configured" ]; then
    echo "$configured"
    return 0
  fi

  if [ -n "${DUNE_MEMORY_DEFAULT:-}" ]; then
    echo "$DUNE_MEMORY_DEFAULT"
    return 0
  fi

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
mapfile -t SIETCH_RUNTIME_ARGS < <(runtime/scripts/sietches.sh runtime-args "$MAP_NAME" "$PARTITION_ID" 2>/dev/null || true)
if [ "$MAP_NAME" = "Survival_1" ]; then
  if [ "$DIMENSION_INDEX" -eq 0 ]; then
    SERVER_INDEX=1
  else
    SERVER_INDEX="$((DIMENSION_INDEX + 2))"
  fi
else
  SERVER_INDEX="$PARTITION_ID"
fi


port_is_free() {
  local port="$1"
  local db_in_use

  db_in_use="$(psql_value "
    select count(*)
    from dune.farm_state
    where coalesce(alive, false) = true
      and (
        game_port = $port
        or igw_port = $port
      );
  " | tr -d '[:space:]')"

  if [ "${db_in_use:-0}" != "0" ]; then
    return 1
  fi

  ! ss -lnup 2>/dev/null | grep -q ":$port "
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

survival_reserved_dimensions() {
  python3 <<'PY'
import json
from pathlib import Path

config_path = Path("runtime/generated/sietch-config.json")
count = 1

if config_path.exists():
    try:
        config = json.loads(config_path.read_text())
        count = int(config.get("maps", {}).get("Survival_1", {}).get("max_dimensions") or 1)
    except Exception:
        count = 1

if count < 1:
    count = 1

print(count)
PY
}

if [ "$MAP_NAME" = "Survival_1" ]; then
  GAME_PORT="$((CLIENT_PORT_BASE + 1 + DIMENSION_INDEX))"
  if [ "$DIMENSION_INDEX" -eq 0 ]; then
    IGW_PORT="$IGW_PORT_BASE"
  else
    IGW_PORT="$((IGW_PORT_BASE + 1 + DIMENSION_INDEX))"
  fi

  if ! port_is_free "$GAME_PORT" || ! port_is_free "$IGW_PORT"; then
    echo "Required Survival_1 dynamic UDP ports are already in use."
    echo "Expected game port: $GAME_PORT"
    echo "Expected igw port:  $IGW_PORT"
    exit 1
  fi
else
  RESERVED_SURVIVAL_DIMS="$(survival_reserved_dimensions)"
  game_start="$((CLIENT_PORT_BASE + 1 + RESERVED_SURVIVAL_DIMS))"
  game_end="$((CLIENT_PORT_BASE + 33))"
  igw_start="$((IGW_PORT_BASE + 1 + RESERVED_SURVIVAL_DIMS))"
  igw_end="$((IGW_PORT_BASE + 33))"
  GAME_PORT="$(pick_port "$game_start" "$game_end" || true)"
  IGW_PORT="$(pick_port "$igw_start" "$igw_end" || true)"

  if [ -z "$GAME_PORT" ] || [ -z "$IGW_PORT" ]; then
    echo "Could not find free UDP ports."
    echo "Game port range checked: ${game_start}-${game_end}"
    echo "IGW port range checked: ${igw_start}-${igw_end}"
    exit 1
  fi
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
mkdir -p "$FAKE_K8S_SERVICEACCOUNT_DIR"
mkdir -p runtime/container
python3 runtime/scripts/usersettings.py materialize "$MAP_NAME" "$PWD/runtime/game/$safe_name/Saved" "$PARTITION_ID"
purge_stale_farm_rows_for_map "$MAP_NAME"

cat > "$FAKE_K8S_SERVICEACCOUNT_DIR/namespace" <<EOF
funcom-seabass-$BATTLEGROUP_ID
EOF
cat > "$FAKE_K8S_SERVICEACCOUNT_DIR/token" <<'EOF'
fake-token
EOF
: > "$FAKE_K8S_SERVICEACCOUNT_DIR/ca.crt"
chmod -R 755 "$FAKE_K8S_SERVICEACCOUNT_DIR"

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
  -v "$PWD/runtime/container:/opt/dune-local:ro" \
  -v "$FAKE_K8S_SERVICEACCOUNT_DIR:/run/secrets/kubernetes.io/serviceaccount:ro" \
  -e "POD_UID=docker-$safe_name" \
  -e "POD_NAME=${BATTLEGROUP_ID}-sg-${safe_name}-pod-${PARTITION_ID}" \
  -e "POD_IP=$MULTIHOME_IP" \
  -e "EXTERNAL_ADDRESS_OVERRIDE=$SERVER_IP" \
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
  "${SIETCH_RUNTIME_ARGS[@]}" \
  -stdout \
  -FullStdOutLogOutput

sleep 5

docker ps --filter "name=$CONTAINER_NAME" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo
echo "Watch logs with:"
echo "  docker logs -f $CONTAINER_NAME"
