#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/state"
cat > "$TEST_ROOT/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
  ps)
    printf '%s\n' \
      dune-server-survival-1 \
      dune-server-survival-1-67 \
      dune-server-survival-1-68 \
      dune-server-deepdesert-1-8
    ;;
  logs)
    printf '%s\n' '[2026.08.25-05.01.21:615]LogCoriolis: Display: Coriolis Restart Farm'
    ;;
  *) exit 2 ;;
esac
MOCK
chmod +x "$TEST_ROOT/bin/docker"

export PATH="$TEST_ROOT/bin:$PATH"
export DUNE_CORIOLIS_LIB_ONLY=1
export DUNE_CORIOLIS_STATE_FILE="$TEST_ROOT/state/coordinator.env"
export DUNE_CORIOLIS_STATE_LOCK_FILE="$TEST_ROOT/state/coordinator.lock"
export DUNE_CORIOLIS_COOLDOWN_SECONDS=300
export DUNE_CORIOLIS_GRACE_SECONDS=0
export DUNE_CORIOLIS_RETRY_SECONDS=0
export DUNE_CORIOLIS_MAX_ATTEMPTS=1
export DUNE_CORIOLIS_CLEANUP_SCRIPT="$TEST_ROOT/bin/coriolis-cleanup"

cat > "$DUNE_CORIOLIS_CLEANUP_SCRIPT" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
count_file="${DUNE_CORIOLIS_TEST_CLEANUP_COUNT:?}"
count=0
[ ! -f "$count_file" ] || count="$(cat "$count_file")"
printf '%s\n' "$((count + 1))" > "$count_file"
[ "${DUNE_CORIOLIS_TEST_CLEANUP_FAIL:-0}" != "1" ]
MOCK
chmod +x "$DUNE_CORIOLIS_CLEANUP_SCRIPT"
export DUNE_CORIOLIS_TEST_CLEANUP_COUNT="$TEST_ROOT/cleanup-count"

source "$REPO_ROOT/runtime/scripts/coriolis-coordinator.sh"

restart_count_file="$TEST_ROOT/restart-count"
perform_farm_restart() {
  local count=0
  [ ! -f "$restart_count_file" ] || count="$(cat "$restart_count_file")"
  printf '%s\n' "$((count + 1))" > "$restart_count_file"
}

scan_once
[ "$(cat "$restart_count_file")" = "1" ]
[ "$(cat "$DUNE_CORIOLIS_TEST_CLEANUP_COUNT")" = "1" ]

# A process interruption while the request is in progress must be recoverable;
# only terminal outcomes are deduplicated by the cooldown.
now_epoch="$(date +%s)"
write_state running "$now_epoch" "Interrupted request under test."
handle_restart_signal dune-server-survival-1-67
[ "$(cat "$restart_count_file")" = "2" ]
[ "$(cat "$DUNE_CORIOLIS_TEST_CLEANUP_COUNT")" = "2" ]
grep -qx 'state=succeeded' "$DUNE_CORIOLIS_STATE_FILE"
grep -qx 'message=Coriolis game-farm restart completed successfully.' "$DUNE_CORIOLIS_STATE_FILE"

# All three Sietches expose the same Funcom request, but the durable cooldown
# must collapse them (and overlapping log windows) into one farm restart.
scan_once
[ "$(cat "$restart_count_file")" = "2" ]
[ "$(cat "$DUNE_CORIOLIS_TEST_CLEANUP_COUNT")" = "2" ]

# Cleanup failure must be visible but must never block Funcom's requested
# restart. The next independent request gets another cleanup attempt.
write_state running "$(date +%s)" "Cleanup failure test."
export DUNE_CORIOLIS_TEST_CLEANUP_FAIL=1
handle_restart_signal dune-server-survival-1-68
unset DUNE_CORIOLIS_TEST_CLEANUP_FAIL
[ "$(cat "$restart_count_file")" = "3" ]
[ "$(cat "$DUNE_CORIOLIS_TEST_CLEANUP_COUNT")" = "3" ]
grep -qx 'state=succeeded' "$DUNE_CORIOLIS_STATE_FILE"
grep -qx 'message=Coriolis game-farm restart completed, but cycle data cleanup failed.' "$DUNE_CORIOLIS_STATE_FILE"

# Deep Desert is intentionally not a trigger source: the authoritative signal
# comes from Survival/Sietch processes and applies to the whole game farm.
if grep -q 'deepdesert' "$DUNE_CORIOLIS_STATE_FILE"; then
  echo "Coriolis trigger unexpectedly came from Deep Desert." >&2
  exit 1
fi

python3 - "$REPO_ROOT" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
restart = (root / "runtime/scripts/restart-game-farm.sh").read_text()
start = (root / "runtime/scripts/start-all.sh").read_text()
stop = (root / "runtime/scripts/stop-all.sh").read_text()
self_update = (root / "runtime/scripts/self-update.sh").read_text()

assert "runtime/scripts/recycle-world-game-servers.sh stop-all" in restart
assert "docker rm -f dune-server-gateway dune-director" in restart
assert "DUNE_START_KEEP_INFRA=1" in restart
assert "DUNE_CORIOLIS_GRACE_SECONDS" in (root / "runtime/scripts/coriolis-coordinator.sh").read_text()
assert "perform_cycle_data_cleanup" in (root / "runtime/scripts/coriolis-coordinator.sh").read_text()
assert "delete_markers_for_all_players" in (root / "runtime/scripts/coriolis-data-cleanup.sh").read_text()
assert "resourcefield_state" in (root / "runtime/scripts/coriolis-data-cleanup.sh").read_text()
assert "delete_actors_and_respawns_on_server" not in (root / "runtime/scripts/coriolis-data-cleanup.sh").read_text()
assert "dune-postgres dune-rmq-admin dune-rmq-game dune-text-router" in start
assert "runtime/scripts/start-coriolis-coordinator.sh" in start
assert "dune-coriolis-coordinator" in stop
assert "start-coriolis-coordinator.sh" in self_update
assert "reconcile_coriolis_coordinator_after_deploy" in self_update
assert "reconcile_coriolis_coordinator_after_deploy\n  self_update_running restarting 94" in self_update
assert "--replace-if-stack-running" in self_update
assert "dune-orchestrator|dune-autoscaler|dune-director" in (root / "runtime/scripts/start-coriolis-coordinator.sh").read_text()
assert "start-coriolis-coordinator.sh" in (root / "runtime/scripts/console.sh").read_text()
assert "start-coriolis-coordinator.sh --if-stack-running" in (root / "runtime/scripts/console.sh").read_text()
assert "--replace-if-stack-running" not in (root / "runtime/scripts/console.sh").read_text()
assert "DUNE_CORIOLIS_SAFE_DATA_CLEANUP" in (root / "runtime/scripts/start-coriolis-coordinator.sh").read_text()
entrypoint = (root / "console/api/entrypoint.sh").read_text()
assert "start-coriolis-coordinator.sh --if-stack-running" in entrypoint
assert '"dune-coriolis-coordinator": "Coriolis Coordinator"' in (root / "console/web/src/components/ReadinessTimeline.tsx").read_text()
assert "docker rm -f dune-postgres" not in restart
assert "docker rm -f dune-rmq" not in restart
assert "docker rm -f dune-text-router" not in restart
PY

echo "Coriolis coordinator tests passed."
