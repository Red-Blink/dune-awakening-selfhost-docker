#!/usr/bin/env bash
# Decides whether the container table justifies Overall: ISSUE.
#
# status.sh's container_status() already sets issue=1 for a stopped or missing
# container, but it runs inside a command substitution, so that assignment dies
# with the subshell. The scan below is the live check.
#
# It is a separate file so it can be tested without running status.sh, which
# needs docker, ss and psql.

# container_rows_have_issue <rows> <coriolis_enabled>
#
# Returns 0 when at least one row justifies ISSUE.
#
# dune-coriolis-coordinator is optional: DUNE_CORIOLIS_COORDINATOR_ENABLED=0
# removes the container deliberately, and an operator who did that should not be
# left with Overall pinned to ISSUE forever. Every other row still counts,
# including dune-orchestrator -- the control plane going missing is a real
# fault, even though it is not part of the battlegroup itself.
container_rows_have_issue() {
  local rows="$1"
  local coriolis_enabled="${2:-1}"
  local row

  while IFS= read -r row; do
    [ -n "$row" ] || continue
    if [ "${row%% *}" = "dune-coriolis-coordinator" ] && [ "$coriolis_enabled" = "0" ]; then
      continue
    fi
    case "$row" in
      *missing*|*stopped*) return 0 ;;
    esac
  done <<EOF
$rows
EOF

  return 1
}
