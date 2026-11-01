#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

REASON="${1:-manual}"
LOCK_FILE="${DUNE_BATTLEGROUP_LIFECYCLE_LOCK_FILE:-runtime/generated/battlegroup-lifecycle.lock}"
MAINTENANCE_FILE="${DUNE_BATTLEGROUP_MAINTENANCE_FILE:-runtime/generated/battlegroup-maintenance.env}"

mkdir -p runtime/generated
if [ "${DUNE_BATTLEGROUP_LIFECYCLE_LOCK_HELD:-0}" != "1" ]; then
  if flock -n -E 75 -o "$LOCK_FILE" env DUNE_BATTLEGROUP_LIFECYCLE_LOCK_HELD=1 "$0" "$@"; then
    exit 0
  else
    rc=$?
    [ "$rc" -ne 75 ] || echo "Another battlegroup lifecycle operation is already running." >&2
    exit "$rc"
  fi
fi
if [ -f runtime/generated/manual-stop.env ]; then
  echo "Manual stop is active; refusing to restart the game farm automatically." >&2
  exit 2
fi

history_started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
history_epoch="$(date +%s)"
history_source=Runtime
history_reason="Game Farm Restart"
case "$REASON" in
  igw-socket-deadlock|stale-browser-state)
    history_source=Automatic
    history_reason="Stalled Game Server Recovery"
    ;;
esac

cleanup() {
  local rc=$? result=Failed finished
  rm -f "$MAINTENANCE_FILE"
  [ "$rc" -ne 0 ] || result=Succeeded
  finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  runtime/scripts/restart-history.sh record battlegroup "Game Farm" "$history_source" \
    "$history_reason" "$result" "$history_started" "$finished" \
    "$(( $(date +%s) - history_epoch ))" || true
  return "$rc"
}
trap cleanup EXIT
{
  printf 'reason=%s\n' "$(printf '%s' "$REASON" | tr '\r\n=' '   ' | cut -c1-80)"
  printf 'started_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'pid=%s\n' "$$"
} > "$MAINTENANCE_FILE"
chmod 600 "$MAINTENANCE_FILE"

echo "=== Coordinated game-farm restart ($REASON) ==="
echo "Validating and materializing saved gameplay settings..."
runtime/scripts/sietches.sh preflight
python3 runtime/scripts/usersettings.py preflight
python3 runtime/scripts/usersettings.py materialize-current

echo "Stopping autoscaler and state publishers..."
runtime/scripts/autoscaler-control.sh stop || true
runtime/scripts/publish-sietch-overrides.sh stop || true
runtime/scripts/spicefield-overrides.sh stop || true
runtime/scripts/publish-deepdesert-overrides.sh stop || true
runtime/scripts/publish-network-server-state-overrides.sh stop || true

echo "Stopping all world map processes..."
runtime/scripts/recycle-world-game-servers.sh stop-all || true

echo "Stopping game-farm coordination services..."
docker rm -f dune-server-gateway dune-director 2>/dev/null || true

echo "Starting a clean game farm while retaining PostgreSQL, RabbitMQ, TextRouter, Console, and orchestration..."
DUNE_START_KEEP_INFRA=1 \
DUNE_START_FOREGROUND_DEFERRED_RECONCILE=1 \
DUNE_IGNORE_MANUAL_STOP=1 \
DUNE_BATTLEGROUP_LIFECYCLE_LOCK_HELD=1 \
  runtime/scripts/start-all.sh

echo "Coordinated game-farm restart completed."
