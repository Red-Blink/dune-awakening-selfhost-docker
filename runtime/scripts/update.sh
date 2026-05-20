#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"

APP_ID="${STEAM_APP_ID:-4754530}"

echo "=== Dune update scaffold ==="
echo "Steam app id: $APP_ID"

cmd="${1:-run}"

AUTO_STATE_FILE="runtime/generated/update-auto.env"
AUTO_SERVICE_FILE="/etc/systemd/system/dune-awakening-auto-update.service"
AUTO_TIMER_FILE="/etc/systemd/system/dune-awakening-auto-update.timer"
AUTO_DEFAULT_TIME="${DUNE_AUTO_UPDATE_TIME:-05:00:00}"

handle_auto_update() {
  sub="${1:-status}"
  time_value="${2:-$AUTO_DEFAULT_TIME}"

  mkdir -p runtime/generated

  case "$sub" in
    enable|on)
      cat > "$AUTO_STATE_FILE" <<EOF
DUNE_AUTO_UPDATE_ENABLED=1
DUNE_AUTO_UPDATE_TIME=$time_value
EOF

      if ! command -v systemctl >/dev/null 2>&1; then
        echo "Auto-update preference saved, but systemctl was not found."
        echo "Saved: $AUTO_STATE_FILE"
        return 0
      fi

      cat > "$AUTO_SERVICE_FILE" <<EOF
[Unit]
Description=Dune Awakening self-host auto update
Wants=docker.service
After=network-online.target docker.service

[Service]
Type=oneshot
WorkingDirectory=$ROOT_DIR
ExecStart=$ROOT_DIR/runtime/scripts/dune update --yes
EOF

      cat > "$AUTO_TIMER_FILE" <<EOF
[Unit]
Description=Run Dune Awakening self-host auto update

[Timer]
OnCalendar=*-*-* $time_value
Persistent=true
RandomizedDelaySec=10m
Unit=dune-awakening-auto-update.service

[Install]
WantedBy=timers.target
EOF

      systemctl daemon-reload
      systemctl enable --now dune-awakening-auto-update.timer

      echo "Auto updates enabled."
      echo "Daily time: $time_value"
      echo "Timer: dune-awakening-auto-update.timer"
      ;;

    disable|off)
      cat > "$AUTO_STATE_FILE" <<EOF
DUNE_AUTO_UPDATE_ENABLED=0
DUNE_AUTO_UPDATE_TIME=$time_value
EOF

      if command -v systemctl >/dev/null 2>&1; then
        systemctl disable --now dune-awakening-auto-update.timer >/dev/null 2>&1 || true
        rm -f "$AUTO_SERVICE_FILE" "$AUTO_TIMER_FILE"
        systemctl daemon-reload
      fi

      echo "Auto updates disabled."
      ;;

    status)
      DUNE_AUTO_UPDATE_ENABLED=0
      DUNE_AUTO_UPDATE_TIME="$AUTO_DEFAULT_TIME"

      if [ -f "$AUTO_STATE_FILE" ]; then
        # shellcheck disable=SC1090
        . "$AUTO_STATE_FILE"
      fi

      echo "Auto updates enabled: $DUNE_AUTO_UPDATE_ENABLED"
      echo "Auto update time:      $DUNE_AUTO_UPDATE_TIME"

      if command -v systemctl >/dev/null 2>&1; then
        echo
        if systemctl list-unit-files dune-awakening-auto-update.timer --no-legend --no-pager 2>/dev/null | grep -q '^dune-awakening-auto-update.timer'; then
          timer_enabled="$(systemctl is-enabled dune-awakening-auto-update.timer 2>/dev/null || true)"
          [ -n "$timer_enabled" ] && echo "Systemd timer: $timer_enabled"
          systemctl list-timers --all dune-awakening-auto-update.timer --no-pager || true
        else
          echo "Systemd timer: not installed"
        fi
      fi
      ;;

    *)
      echo "Unknown auto-update command: $sub"
      echo "Usage:"
      echo "  dune update auto enable"
      echo "  dune update auto enable HH:MM:SS"
      echo "  dune update auto disable"
      echo "  dune update auto status"
      return 2
      ;;
  esac
}

if [ "$cmd" = "auto" ]; then
  handle_auto_update "${2:-status}" "${3:-$AUTO_DEFAULT_TIME}"
  exit $?
fi

if [ "$cmd" = "check" ] || [ "$cmd" = "status" ]; then
  echo
  echo "=== Check Steam for available update ==="

  docker compose exec -T -e APP_ID="$APP_ID" orchestrator bash -lc '
set -euo pipefail

STEAMCMD_SH=/srv/dune/steam/steamcmd.sh
STEAMCMD_BIN=/srv/dune/steam/linux32/steamcmd
INSTALL_DIR=/srv/dune/server
APP_ID="${APP_ID:-4754530}"
APPINFO="/tmp/dune-appinfo-${APP_ID}.txt"
MANIFEST="${INSTALL_DIR}/steamapps/appmanifest_${APP_ID}.acf"

if [ -x "$STEAMCMD_SH" ]; then
  STEAMCMD="$STEAMCMD_SH"
elif [ -x "$STEAMCMD_BIN" ]; then
  STEAMCMD="$STEAMCMD_BIN"
else
  echo "SteamCMD not found or not executable: $STEAMCMD_SH"
  exit 2
fi

echo "Steam app id: $APP_ID"
echo "Install dir:  $INSTALL_DIR"

"$STEAMCMD" \
  +@sSteamCmdForcePlatformType linux \
  +login anonymous \
  +app_info_update 1 \
  +app_info_print "$APP_ID" \
  +quit > "$APPINFO" 2>&1

remote_build="$(
  awk '\''
    /"branches"/ { branches=1 }
    branches && /"public"/ { public_branch=1 }
    public_branch && /"buildid"/ {
      gsub(/"/, "", $2)
      print $2
      exit
    }
  '\'' "$APPINFO"
)"

if [ -z "$remote_build" ]; then
  remote_build="$(
    awk '\''
      /"buildid"/ {
        gsub(/"/, "", $2)
        print $2
        exit
      }
    '\'' "$APPINFO"
  )"
fi

if [ -z "$remote_build" ]; then
  echo "Could not parse remote build id from SteamCMD output."
  echo "Last SteamCMD output:"
  tail -n 80 "$APPINFO" || true
  exit 2
fi

local_build="none"
if [ -f "$MANIFEST" ]; then
  local_build="$(
    awk '\''
      /"buildid"/ {
        gsub(/"/, "", $2)
        print $2
        exit
      }
    '\'' "$MANIFEST"
  )"
  [ -n "$local_build" ] || local_build="unknown"
fi

echo "Local build:  $local_build"
echo "Remote build: $remote_build"

if [ "$local_build" != "none" ] && [ "$local_build" != "unknown" ] && [ "$local_build" = "$remote_build" ]; then
  echo "No update available."
  exit 0
fi

echo "Update available."
exit 100
'

  exit $?
fi

skip_preflight=0

if [ "$cmd" = "--yes" ] || [ "$cmd" = "-y" ]; then
  assume_yes=1
  cmd="run"
elif [ "$cmd" = "install" ] || [ "$cmd" = "bootstrap" ]; then
  assume_yes=1
  skip_preflight=1
  cmd="install"
else
  assume_yes=0
fi

if [ "$cmd" != "run" ] && [ "$cmd" != "apply" ] && [ "$cmd" != "install" ]; then
  echo "Unknown update command: $cmd"
  echo "Usage:"
  echo "  dune update"
  echo "  dune update check"
  echo "  dune update --yes"
  echo "  dune update install"
  echo "  dune update auto enable"
  echo "  dune update auto disable"
  echo "  dune update auto status"
  exit 2
fi

if [ "$skip_preflight" = "1" ]; then
  echo
  echo "=== Bootstrap/install mode ==="
  echo "Skipping update availability check because init needs assets/images/db setup even if Steam is already current."
else
  echo
  echo "=== Pre-flight: check Steam for available update ==="
  set +e
  "$0" check
  check_rc=$?
  set -e

  case "$check_rc" in
    0)
      echo
      echo "No update available. Nothing changed."
      exit 0
      ;;
    100)
      echo
      echo "Update is available."
      ;;
    *)
      echo
      echo "Update check failed with exit code: $check_rc"
      exit "$check_rc"
      ;;
  esac
fi

if [ "$assume_yes" != "1" ]; then
  echo
  read -r -p "Apply update now? This will stop game servers and update files/images. [y/N] " answer
  case "$answer" in
    y|Y|yes|YES)
      ;;
    *)
      echo "Update cancelled. Nothing changed."
      exit 0
      ;;
  esac
fi

echo
echo "=== Stop game servers before update ==="
docker rm -f dune-server-overmap dune-server-survival-1 2>/dev/null || true

echo
echo "=== Download/update server files with SteamCMD ==="

steam_attempt=1
steam_max_attempts="${DUNE_STEAMCMD_MAX_ATTEMPTS:-3}"
steam_retry_sleep="${DUNE_STEAMCMD_RETRY_SLEEP:-20}"
steam_ok=0

while [ "$steam_attempt" -le "$steam_max_attempts" ]; do
  echo
  echo "SteamCMD install attempt $steam_attempt/$steam_max_attempts..."

  set +e
  docker compose exec -T -e APP_ID="$APP_ID" orchestrator dune download
  steam_rc=$?
  set -e

  if [ "$steam_rc" -eq 0 ]; then
    steam_ok=1
    break
  fi

  echo
  if [ "$steam_attempt" -eq 1 ]; then
    echo "SteamCMD first-run bootstrap did not complete the app install on this attempt."
    echo "This can happen while SteamCMD updates and restarts itself."
  else
    echo "SteamCMD failed with exit code $steam_rc."
  fi

  if [ "$steam_attempt" -lt "$steam_max_attempts" ]; then
    if [ "$steam_attempt" -eq 1 ]; then
      echo "Retrying app install in ${steam_retry_sleep}s..."
    else
      echo "Retrying in ${steam_retry_sleep}s..."
    fi
    sleep "$steam_retry_sleep"
  fi

  steam_attempt=$((steam_attempt + 1))
done

if [ "$steam_ok" != "1" ]; then
  echo
  echo "SteamCMD failed after $steam_max_attempts attempts."
  echo "You can retry safely with:"
  echo "  runtime/scripts/update.sh install"
  exit 1
fi

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
if [ "$cmd" = "install" ]; then
  echo "=== Start fresh Postgres for install/bootstrap ==="
  runtime/scripts/start-postgres.sh
  echo
fi

echo "=== Run database update/migration ==="
runtime/scripts/update-db.sh

if [ "$cmd" = "install" ]; then
  echo
  echo "=== Apply canonical world partitions ==="
  runtime/scripts/generate-world-partitions-sql.sh

  partition_sql="runtime/generated/reset-world-partitions.sql"

  if [ ! -s "$partition_sql" ]; then
    echo "Generated partition SQL is missing or empty: $partition_sql"
    exit 1
  fi

  partition_count="$(grep -c '^insert into dune.world_partition' "$partition_sql" || true)"

  if [ "$partition_count" -le 0 ]; then
    echo "Generated partition SQL contains no world_partition inserts."
    exit 1
  fi

  echo "Applying $partition_count world partitions..."
  docker exec -i dune-postgres psql -U dune -d dune < "$partition_sql"

  echo
  echo "=== Verify world partitions ==="
  docker exec dune-postgres psql -U dune -d dune -c "
select count(*) as world_partition_rows from world_partition;
"

  actual_count="$(docker exec dune-postgres psql -U dune -d dune -Atc "select count(*) from world_partition;" | tr -d '[:space:]')"

  if [ "${actual_count:-0}" -le 0 ]; then
    echo "world_partition is still empty after applying generated SQL."
    exit 1
  fi

  echo "World partitions ready: $actual_count rows"
fi

echo
echo "=== Refresh generated map catalogs ==="
runtime/scripts/extract-partition-catalog.sh
runtime/scripts/extract-server-catalog.sh

echo
if [ "$cmd" = "install" ]; then
  echo "Install/bootstrap step finished."
  echo "The caller can now start the Dune stack."
else
  echo "Update finished."
  echo
  echo "Restarting Dune stack..."
  runtime/scripts/start-all.sh
fi
