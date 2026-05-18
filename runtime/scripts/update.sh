#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

APP_ID="${STEAM_APP_ID:-3104830}"

echo "=== Dune update scaffold ==="
echo "Steam app id: $APP_ID"

echo
echo "=== Stop game servers before update ==="
docker rm -f dune-server-overmap dune-server-survival-1 2>/dev/null || true

echo
echo "=== Download/update server files with SteamCMD ==="
docker compose exec -T orchestrator bash -lc "
set -euo pipefail

STEAMCMD=/srv/dune/steam/linux32/steamcmd

if [ ! -x \"\$STEAMCMD\" ]; then
  echo \"SteamCMD not found or not executable: \$STEAMCMD\"
  exit 1
fi

\"\$STEAMCMD\" +force_install_dir /srv/dune/server +login anonymous +app_update ${APP_ID} validate +quit
"

echo
echo "=== Load updated Funcom image tarballs ==="
docker compose exec -T orchestrator bash -lc '
set -euo pipefail
find /srv/dune/server/images -type f \( -name "*.tar" -o -name "*.tar.gz" -o -name "*.tgz" \) | sort | while read -r tar; do
  echo ">>> docker load -i $tar"
  docker load -i "$tar"
done
'

echo
echo "=== Detect loaded image tags ==="
runtime/scripts/detect-image-tags.sh

echo
echo "=== Current tags ==="
cat runtime/generated/image-tags.env

echo
echo "=== Run database update/migration ==="
runtime/scripts/update-db.sh

cat <<'EOF'

Update finished.

Next manual steps for now:
  1. Restart core services if image tags changed:
       dune restart text-router
       dune restart director
       dune restart gateway
  2. Restart always-on game servers:
       dune restart survival
       dune restart overmap

Soon this command can restart services automatically after a successful update.
EOF
