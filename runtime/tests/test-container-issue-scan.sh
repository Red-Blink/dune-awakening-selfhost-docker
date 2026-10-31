#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
source "$repo_root/runtime/scripts/container-issue-scan.sh"

failures=0

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

# Reproduces status.sh's printf "%-26s %s" layout.
row() {
  printf '%-26s %s\n' "$1" "$2"
}

BATTLEGROUP="dune-postgres dune-rmq-admin dune-rmq-game dune-text-router dune-director dune-server-gateway dune-server-survival-1 dune-server-overmap"

# Builds the full ten-row table status.sh emits.
table() {
  local battlegroup_status="$1"
  local coordinator_status="$2"
  local orchestrator_status="${3:-Up 32 minutes}"
  local name
  for name in $BATTLEGROUP; do
    row "$name" "$battlegroup_status"
  done
  row dune-coriolis-coordinator "$coordinator_status"
  row dune-orchestrator "$orchestrator_status"
}

expect_issue() {
  local label="$1" rows="$2" enabled="$3"
  if ! container_rows_have_issue "$rows" "$enabled"; then
    fail "$label: expected an issue, got none"
  fi
}

expect_no_issue() {
  local label="$1" rows="$2" enabled="$3"
  if container_rows_have_issue "$rows" "$enabled"; then
    fail "$label: expected no issue, got one"
  fi
}

expect_no_issue "everything up" "$(table 'Up 15 hours' 'Up 15 hours')" 1

# The bug this scan was split out to fix: a coordinator the operator turned off
# held Overall at ISSUE forever, and no amount of frontend scoping could reach it.
expect_no_issue "coordinator missing but disabled" "$(table 'Up 15 hours' 'missing')" 0
expect_no_issue "coordinator stopped but disabled" "$(table 'Up 15 hours' 'stopped')" 0

# The other direction, which is why the row is not simply ignored: a coordinator
# that is supposed to be running and is not is still a fault.
expect_issue "coordinator missing while enabled" "$(table 'Up 15 hours' 'missing')" 1
expect_issue "coordinator stopped while enabled" "$(table 'Up 15 hours' 'stopped')" 1
expect_issue "coordinator missing, flag defaulted" "$(table 'Up 15 hours' 'missing')" ""

# Disabling the coordinator must not silence anything else.
expect_issue "battlegroup container missing, coordinator disabled" \
  "$(table 'missing' 'missing')" 0
expect_issue "orchestrator missing, coordinator disabled" \
  "$(table 'Up 15 hours' 'missing' 'missing')" 0

# A container name that merely starts with the coordinator's name must not
# inherit its exemption.
expect_issue "coordinator-lookalike name is not exempt" \
  "$(row dune-coriolis-coordinator-backup missing)" 0

expect_no_issue "empty table" "" 1

if [ "$failures" -ne 0 ]; then
  echo "container-issue-scan: $failures check(s) failed" >&2
  exit 1
fi

echo "container-issue-scan: all checks passed"
