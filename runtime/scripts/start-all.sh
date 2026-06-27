#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

[ -f .env ] && . ./.env
[ -r runtime/generated/battlegroup.env ] && . runtime/generated/battlegroup.env

source runtime/scripts/runtime-env.sh

set -a
if [ -f .env ]; then
  . ./.env
fi
set +a

run_timed_step() {
  local label="$1"
  shift
  local start
  local end
  local elapsed

  start="$(date +%s)"
  echo
  echo "=== $label ==="
  "$@"
  end="$(date +%s)"
  elapsed=$((end - start))
  echo "Finished: $label (${elapsed}s)"
}

MANUAL_STOP_FILE="runtime/generated/manual-stop.env"

if [ -f "$MANUAL_STOP_FILE" ] && [ "${DUNE_IGNORE_MANUAL_STOP:-0}" != "1" ]; then
  marker_boot_id="$(awk -F= '$1 == "DUNE_MANUAL_STOP_BOOT_ID" { print substr($0, length($1) + 2); exit }' "$MANUAL_STOP_FILE" 2>/dev/null || true)"
  current_boot_id="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || true)"
  if [ -n "$marker_boot_id" ] && [ -n "$current_boot_id" ] && [ "$marker_boot_id" != "$current_boot_id" ]; then
    rm -f "$MANUAL_STOP_FILE"
  else
    echo "Manual stop is active for this Linux boot. Refusing to start the Dune stack automatically."
    echo "To start intentionally, run: runtime/scripts/dune start"
    exit 2
  fi
fi

if [ "${DUNE_START_SKIP_POSTGRES_START:-0}" = "1" ] \
  && docker inspect -f '{{.State.Running}}' dune-postgres 2>/dev/null | grep -qx true; then
  echo
  echo "=== Starting Postgres ==="
  echo "Postgres is already running from fresh install bootstrap; keeping it online."
else
  run_timed_step "Starting Postgres" runtime/scripts/start-postgres.sh
fi

if [ "${DUNE_START_SKIP_DB_UPDATE:-0}" = "1" ]; then
  echo
  echo "=== Ensuring Database Is Up To Date ==="
  echo "Database update already completed during fresh install bootstrap; skipping duplicate migration pass."
else
  run_timed_step "Ensuring Database Is Up To Date" runtime/scripts/update-db.sh
fi

run_timed_step "Reconciling Network Advertisement Addresses" bash -c '
runtime/scripts/network-addresses.sh reconcile || {
  echo "Network address reconciliation could not run yet. Startup will retry after game servers register."
}
'

run_timed_step "Synchronizing Sietch State" bash -c '
runtime/scripts/sietches.sh sync || {
  echo "Sietch state sync failed. Refusing to start with stale Sietch state."
  exit 1
}
'

run_timed_step "Recycling Stale World Servers" runtime/scripts/recycle-world-game-servers.sh remove-stale

run_timed_step "Clearing Non-Core World Servers" runtime/scripts/recycle-world-game-servers.sh stop-noncore

run_timed_step "Starting RabbitMQ" runtime/scripts/start-rabbitmq.sh

run_timed_step "Starting TextRouter" runtime/scripts/start-text-router.sh

run_timed_step "Starting Director" runtime/scripts/start-director.sh

run_timed_step "Starting Survival_1" runtime/scripts/start-server-survival-1.sh

run_timed_step "Starting Overmap" runtime/scripts/start-server-overmap.sh

run_timed_step "Repairing Chat Exchanges" bash -c '
runtime/scripts/repair-chat-exchanges.sh || {
  echo "Guild chat exchange repair could not complete. Guild chat may be unavailable until the next repair pass."
}
'

run_timed_step "Rechecking Network Advertisement Addresses" bash -c '
runtime/scripts/network-addresses.sh reconcile || {
  echo "Network address reconciliation could not complete. Run: runtime/scripts/network-addresses.sh status"
}
'

run_timed_step "Starting Sietch Override Publisher" bash -c '
runtime/scripts/publish-sietch-overrides.sh restart || {
  echo "Sietch override publisher did not start. Survival_1 custom browser names/passwords will not republish."
}
'

run_timed_step "Starting Deep Desert Warm-Up Publisher" bash -c '
runtime/scripts/publish-deepdesert-overrides.sh restart || {
  echo "Deep Desert warm-up publisher did not start. Deep Desert may show offline instead of loading while warming."
}
'

run_timed_step "Starting Network Server-State Publisher" bash -c '
runtime/scripts/publish-network-server-state-overrides.sh restart || {
  echo "Network server-state publisher did not start. Non-Survival maps may advertise the local bind IP until the next restart."
}
'

if [ -f runtime/generated/director-deepdesert-dual.ini ]; then
  echo
  echo "=== Dual Deep Desert Override Present ==="
  echo "Deep Desert dual-mode config detected. Selector names/Kanly remain client/backend-controlled."
fi

run_timed_step "Starting ServerGateway" runtime/scripts/start-server-gateway.sh

run_timed_step "Applying Local Public-IP Loopback Optimization" bash -c '
runtime/scripts/local-loopback-optimize.sh || {
  echo "Local public-IP loopback optimization could not be applied. Public clients are unaffected; same-host clients may need NAT hairpin support."
}
'

run_timed_step "Publishing Survival Sietch State" bash -c '
runtime/scripts/publish-sietch-overrides.sh once || {
  echo "Could not publish the latest Survival_1 browser state snapshot."
}
'

run_timed_step "Publishing Deep Desert Warm-Up State" bash -c '
runtime/scripts/publish-deepdesert-overrides.sh once || {
  echo "Could not publish the latest Deep Desert warm-up snapshot."
}
'

run_timed_step "Publishing Network Server-State Snapshot" bash -c '
runtime/scripts/publish-network-server-state-overrides.sh once || {
  echo "Could not publish the latest non-Survival network server-state snapshot."
}
'

if [ -f runtime/generated/director-deepdesert-dual.ini ]; then
  echo
  echo "=== Dual Deep Desert Note ==="
  echo "Deep Desert dual-mode gameplay config is active. Selector names/Kanly remain cosmetic."
fi

run_timed_step "Starting Autoscaler" bash -c '
runtime/scripts/start-autoscaler.sh || {
  echo "Autoscaler did not start. Dynamic maps will not spawn automatically."
  echo "Check with: dune autoscaler status"
}
'

echo
echo "=== Scheduling Deferred Dimension Reconcile ==="
(
  exec runtime/scripts/deferred-reconcile.sh
) >/tmp/dune-deferred-reconcile.log 2>&1 &


echo
echo "=== Final quick status ==="
docker ps --filter "name=dune-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

echo
echo "=== Required TCP listeners ==="
ss -lntp | grep -E ':(15432|31982|31983|32573|5059|11717)' || true

client_port_base="$(resolve_client_port_base)"
igw_port_base="$(resolve_igw_port_base)"
echo
echo "=== Required UDP listeners ==="
ss -lnup | grep -E ":(${client_port_base}|$((client_port_base + 1))|${igw_port_base}|$((igw_port_base + 1)))" || true

cat <<'EOF'

Started. Notes:
- Survival_1 can take several minutes to become fully READY.
- Overmap can also take a few minutes.
- Optional maps are reconciled only after Survival_1 and Overmap reach READY.
- Autoscaler will still spawn optional maps on demand.
- Autoscaler starts with the battlegroup so dynamic maps can spawn on demand.
- Use runtime/scripts/status.sh after startup to check readiness.
EOF
