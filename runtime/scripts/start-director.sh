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
IMAGE="registry.funcom.com/funcom/self-hosting/seabass-server-bg-director:${WORLD_IMAGE_TAG}"
DIRECTOR_PORT="$(resolve_director_port)"

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

SERVER_LOGIN_PASSWORD_SECRET="$(resolve_server_login_password_secret)"
USERNAME_SERVER_LOGIN_SECRET="$(resolve_username_server_login_secret)"
LOGIN_PASSWORD_SKEW_SECONDS="$(resolve_login_password_skew_seconds)"

SERVER_TITLE="$(resolve_server_title)"
SERVER_REGION="$(resolve_server_region)"
SERVER_IP="$(resolve_server_ip)"
BATTLEGROUP_ID="$(resolve_battlegroup_id)"
DUNE_DB_PASSWORD="${DUNE_DB_PASSWORD:-dune}"
if [ -n "${DUNE_FAKE_K8S_SERVICEACCOUNT_DIR:-}" ]; then
  FAKE_K8S_SERVICEACCOUNT_DIR="$DUNE_FAKE_K8S_SERVICEACCOUNT_DIR"
else
  FAKE_K8S_SERVICEACCOUNT_DIR="$PWD/runtime/generated/dune-fake-k8s-serviceaccount-director-$$"
fi


mkdir -p runtime/director/config
mkdir -p runtime/generated/director-bundle
mkdir -p "$FAKE_K8S_SERVICEACCOUNT_DIR"

if [ -d runtime/director/config/director_config.ini ]; then
  echo "Repairing generated director config path..."
  rm -rf runtime/director/config/director_config.ini
fi

cat > runtime/director/config/director_config.ini <<'EOF'
[Battlegroup]
AuthorizationPreset=BattlegroupInternal
EOF

if [ -s runtime/generated/director-character-transfer.ini ]; then
  awk '
    /^\[/ { next }
    /^[[:space:]]*(;|#|$)/ { print; next }
    { print }
  ' runtime/generated/director-character-transfer.ini >> runtime/director/config/director_config.ini
fi

cat >> runtime/director/config/director_config.ini <<'EOF'

[InstancingModes]
Overmap=SingleServer
Survival_1=Dimension
DeepDesert_1=Dimension

[Server]
PlayerHardCap=40
ShouldUpdatePlayerCountOnFls=false
ForceLock=false
DauCap=1000000
WauCap=3360
HbsCap=1000000
AllowGroupTravel=false
ScalingResourceTarget=ServerSetScale

[Overmap]
PlayerHardCap=1000

[Survival_1]
PlayerHardCap=60
ShouldUpdatePlayerCountOnFls=true
NpeGrantDurationInMinutes=90

[DeepDesert_1]
PlayerHardCap=80
QueueFailMap=Overmap
QueueFailLocation=-32289.657183, -138433.689956, 500.000000

[CB_Dungeon_Hephaestus]
NumExtraServers=0

[CB_Dungeon_OldCarthag]
NumExtraServers=0

[CB_Ecolab_Bronze_Green_024]
NumExtraServers=0

[CB_Ecolab_Bronze_Green_089]
NumExtraServers=0

[CB_Ecolab_Bronze_Green_136]
NumExtraServers=0

[CB_Ecolab_Bronze_Green_152]
NumExtraServers=0

[CB_Ecolab_Bronze_Green_195]
NumExtraServers=0

[CB_Overland_M_01]
NumExtraServers=0

[CB_Overland_S_04]
NumExtraServers=0

[CB_Overland_S_05]
NumExtraServers=0

[CB_Overland_S_06]
NumExtraServers=0

[CB_Overland_S_07]
NumExtraServers=0

[CB_Overland_S_08]
NumExtraServers=0

[CB_Story_BanditFortress01]
NumExtraServers=0

[CB_Dungeon_ThePit]
NumExtraServers=0

[SH_Arrakeen]
PlayerHardCap=80
ShouldUpdatePlayerCountOnFls=false
AllowGroupTravel=false
NumExtraServers=0
MinServers=0

[SH_HarkoVillage]
PlayerHardCap=80
ShouldUpdatePlayerCountOnFls=false
AllowGroupTravel=false
NumExtraServers=0
MinServers=0

[Story_ArtOfKanly]
PlayerHardCap=30
ShouldUpdatePlayerCountOnFls=false
AllowGroupTravel=false
NumExtraServers=0

[Story_Faction_Outpost_Atre]
PlayerHardCap=1
ShouldUpdatePlayerCountOnFls=false
AllowGroupTravel=false
KeepPartiesTogether=false
NumExtraServers=0

[Story_Faction_Outpost_Hark]
PlayerHardCap=1
ShouldUpdatePlayerCountOnFls=false
AllowGroupTravel=false
KeepPartiesTogether=false
NumExtraServers=0

[Story_HeighlinerDungeon]
PlayerHardCap=1
ShouldUpdatePlayerCountOnFls=false
AllowGroupTravel=false
KeepPartiesTogether=false
NumExtraServers=0
EOF

if [ -s runtime/generated/director-deepdesert-dual.ini ]; then
  cat runtime/generated/director-deepdesert-dual.ini >> runtime/director/config/director_config.ini
fi

cat >> runtime/director/config/director_config.ini <<EOF

[AuthenticationConfiguration]
DefaultScheme=BackendLogin
DefaultAuthenticateScheme=BackendLogin
DefaultChallengeScheme=BackendLogin
AuthenticationScheme=BackendLogin
RequireAuthenticatedSignIn=false

[BackendLoginConfiguration]
Secret=$USERNAME_SERVER_LOGIN_SECRET
UsernameServerLoginSecret=$USERNAME_SERVER_LOGIN_SECRET
ServerLoginPasswordSecret=$SERVER_LOGIN_PASSWORD_SECRET
ServerLoginPasswordSecretEnvironmentVariable=DUNE_SERVER_LOGIN_PASSWORD_SECRET
UsernameServerLoginSecretEnvironmentVariable=DUNE_USERNAME_SERVER_LOGIN_SECRET
LoginPasswordSkewEnvironmentVariable=DUNE_LOGIN_PASSWORD_SKEW_SECONDS
LoginPasswordSkew=$LOGIN_PASSWORD_SKEW_SECONDS

[AuthenticationConfiguration:BackendLoginConfiguration]
Secret=$USERNAME_SERVER_LOGIN_SECRET
UsernameServerLoginSecret=$USERNAME_SERVER_LOGIN_SECRET
ServerLoginPasswordSecret=$SERVER_LOGIN_PASSWORD_SECRET
ServerLoginPasswordSecretEnvironmentVariable=DUNE_SERVER_LOGIN_PASSWORD_SECRET
UsernameServerLoginSecretEnvironmentVariable=DUNE_USERNAME_SERVER_LOGIN_SECRET
LoginPasswordSkewEnvironmentVariable=DUNE_LOGIN_PASSWORD_SKEW_SECONDS
LoginPasswordSkew=$LOGIN_PASSWORD_SKEW_SECONDS

[AuthenticationConfiguration:SchemeMap:BackendLogin]
Secret=$USERNAME_SERVER_LOGIN_SECRET
UsernameServerLoginSecret=$USERNAME_SERVER_LOGIN_SECRET
ServerLoginPasswordSecret=$SERVER_LOGIN_PASSWORD_SECRET
ServerLoginPasswordSecretEnvironmentVariable=DUNE_SERVER_LOGIN_PASSWORD_SECRET
UsernameServerLoginSecretEnvironmentVariable=DUNE_USERNAME_SERVER_LOGIN_SECRET
LoginPasswordSkewEnvironmentVariable=DUNE_LOGIN_PASSWORD_SKEW_SECONDS
LoginPasswordSkew=$LOGIN_PASSWORD_SKEW_SECONDS

[AuthenticationConfiguration:SchemeMap:BackendLogin:BackendLoginConfiguration]
Secret=$USERNAME_SERVER_LOGIN_SECRET
UsernameServerLoginSecret=$USERNAME_SERVER_LOGIN_SECRET
ServerLoginPasswordSecret=$SERVER_LOGIN_PASSWORD_SECRET
ServerLoginPasswordSecretEnvironmentVariable=DUNE_SERVER_LOGIN_PASSWORD_SECRET
UsernameServerLoginSecretEnvironmentVariable=DUNE_USERNAME_SERVER_LOGIN_SECRET
LoginPasswordSkewEnvironmentVariable=DUNE_LOGIN_PASSWORD_SKEW_SECONDS
LoginPasswordSkew=$LOGIN_PASSWORD_SKEW_SECONDS

[ServerAuthenticationSecrets]
UsernameServerLoginSecret="$USERNAME_SERVER_LOGIN_SECRET"
ServerLoginPasswordSecret="$SERVER_LOGIN_PASSWORD_SECRET"
EOF

cat > "$FAKE_K8S_SERVICEACCOUNT_DIR/namespace" <<'EOF'
funcom-seabass-dune-docker
EOF

cat > "$FAKE_K8S_SERVICEACCOUNT_DIR/token" <<'EOF'
fake-token
EOF

# Same intentional trick as TextRouter for now:
# invalid CA makes IGWO init fail non-fatally instead of trying to call a missing API server.
: > "$FAKE_K8S_SERVICEACCOUNT_DIR/ca.crt"

chmod -R 755 "$FAKE_K8S_SERVICEACCOUNT_DIR"
chmod 755 runtime/director/config
chmod 600 runtime/director/config/director_config.ini

if [ ! -f runtime/director/config/director_config.ini ]; then
  echo "Failed to prepare director config file: runtime/director/config/director_config.ini"
  exit 1
fi

docker network create dune-net 2>/dev/null || true
docker rm -f dune-director 2>/dev/null || true

docker run -d \
  "${DUNE_DOCKER_LOG_ARGS[@]}" \
  --name dune-director \
  --network dune-net \
  --restart unless-stopped \
  -p "127.0.0.1:${DIRECTOR_PORT}:11717/tcp" \
  -v "$(host_path "$PWD/runtime/director/config/director_config.ini"):/Tools/Battlegroups/Director/BattlegroupDirector/director_config.ini:ro" \
  -v "$(host_path "$PWD/runtime/generated/director-bundle"):/opt/dune-director-bundle" \
  -v "$(host_path "$FAKE_K8S_SERVICEACCOUNT_DIR"):/run/secrets/kubernetes.io/serviceaccount:ro" \
  -e "DOTNET_BUNDLE_EXTRACT_BASE_DIR=/opt/dune-director-bundle" \
  -e "KUBERNETES_SERVICE_HOST=igwo.local" \
  -e "KUBERNETES_SERVICE_PORT=6443" \
  -e "KUBERNETES_SERVICE_PORT_HTTPS=6443" \
  -e "KUBERNETES_SERVICE_PATH=/run/secrets/kubernetes.io/serviceaccount" \
  -e "BATTLEGROUP=$BATTLEGROUP_ID" \
  -e "BATTLEGROUP_DISPLAY_NAME=$BATTLEGROUP_ID" \
  -e "BATTLEGROUP_TITLE=$SERVER_TITLE" \
  -e "BATTLEGROUP_REGION_NAME=$SERVER_REGION" \
  -e "FuncomLiveServices__ServiceAuthToken=$FUNCOM_TOKEN" \
  -e "FuncomLiveServices__RmqTlsEnabled=true" \
  -e "RMQ_HTTP_TOKEN_AUTH_SECRET=$RMQ_HTTP_TOKEN_AUTH_SECRET" \
  -e "AuthenticationConfiguration__DefaultScheme=BackendLogin" \
  -e "AuthenticationConfiguration__DefaultAuthenticateScheme=BackendLogin" \
  -e "AuthenticationConfiguration__DefaultChallengeScheme=BackendLogin" \
  -e "AuthenticationConfiguration__AuthenticationScheme=BackendLogin" \
  -e "AuthenticationConfiguration__RequireAuthenticatedSignIn=false" \
  -e "DUNE_SERVER_LOGIN_PASSWORD_SECRET=$SERVER_LOGIN_PASSWORD_SECRET" \
  -e "DUNE_USERNAME_SERVER_LOGIN_SECRET=$USERNAME_SERVER_LOGIN_SECRET" \
  -e "DUNE_LOGIN_PASSWORD_SKEW_SECONDS=$LOGIN_PASSWORD_SKEW_SECONDS" \
  -e "BackendLoginConfiguration__Secret=$USERNAME_SERVER_LOGIN_SECRET" \
  -e "BackendLoginConfiguration__UsernameServerLoginSecret=$USERNAME_SERVER_LOGIN_SECRET" \
  -e "BackendLoginConfiguration__ServerLoginPasswordSecret=$SERVER_LOGIN_PASSWORD_SECRET" \
  -e "BackendLoginConfiguration__ServerLoginPasswordSecretEnvironmentVariable=DUNE_SERVER_LOGIN_PASSWORD_SECRET" \
  -e "BackendLoginConfiguration__UsernameServerLoginSecretEnvironmentVariable=DUNE_USERNAME_SERVER_LOGIN_SECRET" \
  -e "BackendLoginConfiguration__LoginPasswordSkewEnvironmentVariable=DUNE_LOGIN_PASSWORD_SKEW_SECONDS" \
  -e "BackendLoginConfiguration__LoginPasswordSkew=$LOGIN_PASSWORD_SKEW_SECONDS" \
  -e "AuthenticationConfiguration__BackendLoginConfiguration__Secret=$USERNAME_SERVER_LOGIN_SECRET" \
  -e "AuthenticationConfiguration__BackendLoginConfiguration__UsernameServerLoginSecret=$USERNAME_SERVER_LOGIN_SECRET" \
  -e "AuthenticationConfiguration__BackendLoginConfiguration__ServerLoginPasswordSecret=$SERVER_LOGIN_PASSWORD_SECRET" \
  -e "AuthenticationConfiguration__BackendLoginConfiguration__ServerLoginPasswordSecretEnvironmentVariable=DUNE_SERVER_LOGIN_PASSWORD_SECRET" \
  -e "AuthenticationConfiguration__BackendLoginConfiguration__UsernameServerLoginSecretEnvironmentVariable=DUNE_USERNAME_SERVER_LOGIN_SECRET" \
  -e "AuthenticationConfiguration__BackendLoginConfiguration__LoginPasswordSkewEnvironmentVariable=DUNE_LOGIN_PASSWORD_SKEW_SECONDS" \
  -e "AuthenticationConfiguration__BackendLoginConfiguration__LoginPasswordSkew=$LOGIN_PASSWORD_SKEW_SECONDS" \
  -e "AuthenticationConfiguration__SchemeMap__BackendLogin__Secret=$USERNAME_SERVER_LOGIN_SECRET" \
  -e "AuthenticationConfiguration__SchemeMap__BackendLogin__UsernameServerLoginSecret=$USERNAME_SERVER_LOGIN_SECRET" \
  -e "AuthenticationConfiguration__SchemeMap__BackendLogin__ServerLoginPasswordSecret=$SERVER_LOGIN_PASSWORD_SECRET" \
  -e "AuthenticationConfiguration__SchemeMap__BackendLogin__ServerLoginPasswordSecretEnvironmentVariable=DUNE_SERVER_LOGIN_PASSWORD_SECRET" \
  -e "AuthenticationConfiguration__SchemeMap__BackendLogin__UsernameServerLoginSecretEnvironmentVariable=DUNE_USERNAME_SERVER_LOGIN_SECRET" \
  -e "AuthenticationConfiguration__SchemeMap__BackendLogin__LoginPasswordSkewEnvironmentVariable=DUNE_LOGIN_PASSWORD_SKEW_SECONDS" \
  -e "AuthenticationConfiguration__SchemeMap__BackendLogin__LoginPasswordSkew=$LOGIN_PASSWORD_SKEW_SECONDS" \
  -e "AuthenticationConfiguration__SchemeMap__BackendLogin__BackendLoginConfiguration__Secret=$USERNAME_SERVER_LOGIN_SECRET" \
  -e "AuthenticationConfiguration__SchemeMap__BackendLogin__BackendLoginConfiguration__UsernameServerLoginSecret=$USERNAME_SERVER_LOGIN_SECRET" \
  -e "AuthenticationConfiguration__SchemeMap__BackendLogin__BackendLoginConfiguration__ServerLoginPasswordSecret=$SERVER_LOGIN_PASSWORD_SECRET" \
  -e "AuthenticationConfiguration__SchemeMap__BackendLogin__BackendLoginConfiguration__ServerLoginPasswordSecretEnvironmentVariable=DUNE_SERVER_LOGIN_PASSWORD_SECRET" \
  -e "AuthenticationConfiguration__SchemeMap__BackendLogin__BackendLoginConfiguration__UsernameServerLoginSecretEnvironmentVariable=DUNE_USERNAME_SERVER_LOGIN_SECRET" \
  -e "AuthenticationConfiguration__SchemeMap__BackendLogin__BackendLoginConfiguration__LoginPasswordSkewEnvironmentVariable=DUNE_LOGIN_PASSWORD_SKEW_SECONDS" \
  -e "AuthenticationConfiguration__SchemeMap__BackendLogin__BackendLoginConfiguration__LoginPasswordSkew=$LOGIN_PASSWORD_SKEW_SECONDS" \
  -e "fls-apikey=$FLS_APIKEY" \
  -e "HOST_DATACENTER_ID=${SERVER_PROVIDER:-dune-docker}" \
  -e "HOST_DATACENTER_IP_ADDRESS=$SERVER_IP" \
  -e "ASPNETCORE_URLS=http://0.0.0.0:11717" \
  -e "DOTNET_HOSTBUILDER__RELOADCONFIGONCHANGE=false" \
  -e "Database_address=dune-postgres:5432" \
  -e "Database_name=dune" \
  -e "Database_user=dune" \
  -e "Database_password=$DUNE_DB_PASSWORD" \
  "$IMAGE" \
  --RMQGameHostname=dune-rmq-game \
  --RMQGamePort=5672 \
  --RMQAdminHostname=dune-rmq-admin \
  --RMQAdminPort=5672

sleep 12

docker ps --filter "name=dune-director" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo
echo "=== director logs ==="
if ! docker logs --tail 160 dune-director; then
  echo "Director logs are not available from Docker."
  echo
  echo "=== director container state ==="
  docker inspect dune-director --format 'Status={{.State.Status}} ExitCode={{.State.ExitCode}} OOMKilled={{.State.OOMKilled}} RestartCount={{.RestartCount}} Started={{.State.StartedAt}} Finished={{.State.FinishedAt}} Error={{.State.Error}}' 2>/dev/null || true
fi
