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
source runtime/scripts/fake-k8s-serviceaccount.sh
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
HOST_DATACENTER_ID_VALUE="$(resolve_host_datacenter_id)"
BATTLEGROUP_ID="$(resolve_battlegroup_id)"
DUNE_DB_PASSWORD="${DUNE_DB_PASSWORD:-dune}"
FAKE_K8S_SERVICEACCOUNT_DIR="$(fake_k8s_serviceaccount_dir director)"


mkdir -p runtime/director/config
mkdir -p runtime/generated/director-bundle
mkdir -p "$FAKE_K8S_SERVICEACCOUNT_DIR"

repair_generated_file_path runtime/director/config/director_config.ini

cat > runtime/director/config/director_config.ini <<'EOF'
[Battlegroup]
AuthorizationPreset=BattlegroupInternal
; Refresh each Sietch's browser heartbeat independently of settings changes.
; The Director default is 28800 seconds; its separate battlegroup heartbeat
; does not refresh the per-partition timestamp sent by this update path.
FlsServerHeartbeatUpdateFrequencySeconds=60
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
MaxParties=1

[CB_Overland_S_07]
NumExtraServers=0
MaxParties=1

[CB_Overland_S_08]
NumExtraServers=0
MaxParties=1

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

# Keep the public directory's capacity source independent from the live
# Director bind mount. Self-updates and Console rebuilds can safely retain this
# secret-free snapshot without copying Director authentication material.
DIRECTOR_CAPACITY_SNAPSHOT="runtime/generated/director-capacity.ini"
repair_generated_file_path "$DIRECTOR_CAPACITY_SNAPSHOT"
capacity_snapshot_tmp="$(mktemp runtime/generated/.director-capacity.ini.tmp.XXXXXX)"
awk '
  /^\[[^]]+\]$/ { print; next }
  /^(PlayerHardCap|ShouldUpdatePlayerCountOnFls)=/ { print }
' runtime/director/config/director_config.ini > "$capacity_snapshot_tmp"
chmod 600 "$capacity_snapshot_tmp"
mv -f "$capacity_snapshot_tmp" "$DIRECTOR_CAPACITY_SNAPSHOT"

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

prepare_fake_k8s_serviceaccount "$FAKE_K8S_SERVICEACCOUNT_DIR" funcom-seabass-dune-docker
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
  -e "HOST_DATACENTER_ID=$HOST_DATACENTER_ID_VALUE" \
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

prune_legacy_fake_k8s_serviceaccounts

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
