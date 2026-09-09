#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

timeout_seconds="${DUNE_DEFERRED_RECONCILE_TIMEOUT_SECONDS:-900}"
poll_seconds="${DUNE_DEFERRED_RECONCILE_POLL_SECONDS:-5}"
deadline=$(( $(date +%s) + timeout_seconds ))

is_running() {
  local name="$1"
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$name"
}

db_bool_true() {
  [[ "${1,,}" =~ ^(t|true|1|yes|y)$ ]]
}

partition_ready() {
  local partition_id="$1"
  docker exec dune-postgres psql -U dune -d dune -Atc "
    select coalesce(fs.ready::text, 'f')
    from dune.world_partition wp
    left join dune.farm_state fs on fs.server_id = wp.server_id
    where wp.partition_id = ${partition_id}
    limit 1;
  " 2>/dev/null | tr -d '[:space:]'
}

wait_for_core_ready() {
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! is_running dune-postgres || ! is_running dune-server-survival-1 || ! is_running dune-server-overmap; then
      sleep "$poll_seconds"
      continue
    fi

    if db_bool_true "$(partition_ready 1)" && db_bool_true "$(partition_ready 2)"; then
      return 0
    fi

    sleep "$poll_seconds"
  done

  return 1
}

wait_for_core_ready || {
  echo "Deferred reconcile skipped: Survival_1/Overmap did not reach READY within ${timeout_seconds}s." >&2
  exit 0
}

# Each step is non-fatal -- one failure must not cost the others -- but a
# bare `|| true` also hid them completely. A reconcile that refuses because
# Postgres is down looked exactly like one that ran and found nothing to do.
step() {
  local label="$1"
  shift
  local rc=0
  "$@" || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "Deferred reconcile: $label ok."
  else
    echo "Deferred reconcile: $label FAILED with exit $rc." >&2
  fi
}

step "spice-field overrides" runtime/scripts/spicefield-overrides.sh apply
step "Survival_1 dimensions" runtime/scripts/sietches.sh reconcile Survival_1
if runtime/scripts/map-modes.sh is-always-on DeepDesert_1 >/dev/null 2>&1; then
  step "DeepDesert_1 dimensions" runtime/scripts/sietches.sh reconcile DeepDesert_1
else
  echo "Deferred reconcile skipped DeepDesert_1 because its map mode is not always-on."
fi
step "sietch override publish" runtime/scripts/publish-sietch-overrides.sh once
