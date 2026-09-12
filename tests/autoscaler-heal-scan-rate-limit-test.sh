#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

script="runtime/scripts/autoscaler.sh"

bash -n "$script"

grep -Fq 'director_heal_due proactive_hagga "$PROACTIVE_HAGGA_SCAN_SECONDS"' "$script"
grep -Fq 'director_heal_due deepdesert_loading "$DEEPDESERT_LOADING_SCAN_SECONDS"' "$script"
grep -Fq 'director_heal_due named_destination_failures "$NAMED_DESTINATION_SCAN_SECONDS"' "$script"
grep -Fq 'PROACTIVE_HAGGA_SCAN_SECONDS="$(validate_scan_seconds DUNE_AUTOSCALER_PROACTIVE_HAGGA_SCAN_SECONDS "${DUNE_AUTOSCALER_PROACTIVE_HAGGA_SCAN_SECONDS:-15}" 15 "$SINCE_SECONDS")"' "$script"
grep -Fq 'DEEPDESERT_LOADING_SCAN_SECONDS="$(validate_scan_seconds DUNE_AUTOSCALER_DEEPDESERT_LOADING_SCAN_SECONDS "${DUNE_AUTOSCALER_DEEPDESERT_LOADING_SCAN_SECONDS:-15}" 15 "$SINCE_SECONDS")"' "$script"
grep -Fq 'NAMED_DESTINATION_SCAN_SECONDS="$(validate_scan_seconds DUNE_AUTOSCALER_NAMED_DESTINATION_SCAN_SECONDS "${DUNE_AUTOSCALER_NAMED_DESTINATION_SCAN_SECONDS:-60}" 60 "$NAMED_DESTINATION_SINCE_SECONDS")"' "$script"

# validate_scan_seconds must reject a non-numeric override (e.g. a duration
# string like other vars in this file use) instead of silently defeating the
# gate, and must clamp an interval that reaches or exceeds its log window.
python3 - "$script" <<'PY'
from pathlib import Path
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
start = text.index("validate_scan_seconds()")
end = text.index("\n}\n", start)
body = text[start:end]

assert 'if ! [[ "$value" =~ ^[1-9][0-9]*$ ]]; then' in body
assert 'value="$default_value"' in body
assert '[ "$value" -ge "$window_seconds" ]' in body
assert "value=$((window_seconds - 1))" in body
PY

# Static check: the gate must be the first non-"local" statement in each
# scan function, so a revert or a gate moved after the docker-logs/side-effect
# work it's meant to guard would fail this assertion. Function bodies are
# bounded by the next top-level function definition (rather than a bare
# "\n}\n", which an embedded Python/awk heredoc could coincidentally contain
# at column 0) so this doesn't silently mis-bound a truncated body.
python3 - "$script" <<'PY'
from pathlib import Path
import re
import sys

text = Path(sys.argv[1]).read_text(encoding="utf-8")
function_def_re = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{', re.MULTILINE)

checks = [
    ("scan_proactive_hagga_handoffs()",
     'director_heal_due proactive_hagga "$PROACTIVE_HAGGA_SCAN_SECONDS" || return 0'),
    ("scan_deepdesert_loading_responses()",
     'director_heal_due deepdesert_loading "$DEEPDESERT_LOADING_SCAN_SECONDS" || return 0'),
    ("scan_named_destination_failures()",
     'director_heal_due named_destination_failures "$NAMED_DESTINATION_SCAN_SECONDS" || return 0'),
]

for fn, gate_line in checks:
    start = text.index(fn)
    next_def = function_def_re.search(text, start + len(fn))
    end = next_def.start() if next_def else len(text)
    body = text[start:end]
    lines = [l.strip() for l in body.splitlines() if l.strip()]
    non_local = [l for l in lines[1:] if not l.startswith("local ")]
    assert non_local, f"{fn}: function body has no statements after locals"
    assert non_local[0] == gate_line, (
        f"{fn}: expected gate as first statement, got {non_local[0]!r}"
    )

# scan_deepdesert_loading_responses must skip an already-seen flow before its
# first side effect (publish_rmq_json), matching its siblings' dedup pattern
# -- otherwise the same log line, re-detected within the scan's own log
# window, causes a duplicate publish to the origin game server.
start = text.index("scan_deepdesert_loading_responses()")
next_def = function_def_re.search(text, start + len("scan_deepdesert_loading_responses()"))
body = text[start:next_def.start() if next_def else len(text)]
assert 'deepdesert_travel_seen "$flow_id" && continue' in body
assert body.index('deepdesert_travel_seen "$flow_id" && continue') < body.index("publish_rmq_json")
PY

# Dynamic check: director_heal_due itself must actually rate-limit (return
# non-zero within the interval, fire again once it has elapsed), and calling
# a real gated scan function (not just director_heal_due generically) must
# suppress its own expensive `docker logs` work on a second call within the
# interval. Everything before the background-follower/main-loop tail is pure
# function/variable definitions, so it's safe to source in isolation once
# state files are redirected to a scratch directory and the script's own
# repo-root `cd` (meant for direct execution, not sourcing) is stripped.
tail_line=""
if ! tail_line="$(grep -n '^follow_director_hagga_handoffs &' "$script" | head -n1 | cut -d: -f1)"; then
  echo "could not find main-loop tail marker in $script" >&2
  exit 1
fi
[ -n "$tail_line" ] || { echo "could not find main-loop tail marker in $script" >&2; exit 1; }

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

defs_file="$work_dir/autoscaler-defs.sh"
sed -n "1,$((tail_line - 1))p" "$script" | sed '/^cd "\$(dirname "\$0")\/\.\.\/\.\."$/d' > "$defs_file"

(
  set -euo pipefail
  export DUNE_AUTOSCALER_STATE_FILE="$work_dir/idle.tsv"
  export DUNE_AUTOSCALER_SERVER_ID_MAP_FILE="$work_dir/server-ids.tsv"
  export DUNE_AUTOSCALER_DEMAND_FILE="$work_dir/demand.tsv"
  export DUNE_AUTOSCALER_DEMAND_EVENT_FILE="$work_dir/demand-events.tsv"
  export DUNE_AUTOSCALER_HUB_TRAVEL_FILE="$work_dir/hub-travel.tsv"
  export DUNE_AUTOSCALER_DEEPDESERT_TRAVEL_FILE="$work_dir/deepdesert-travel.tsv"
  export DUNE_AUTOSCALER_DIRECTOR_HEAL_FILE="$work_dir/director-heal.tsv"

  # The script's own top-level preflight requires `docker ps` to list
  # dune-director/dune-postgres or it exits 1. Also serves
  # scan_named_destination_failures's own `docker ps` call (its hub
  # containers, matching hub_container_for_map's real outputs) and counts
  # every `docker logs` invocation so the call-site check below can prove
  # the gate actually suppresses the expensive work, not just that
  # director_heal_due's own state file logic works in isolation.
  docker_calls_log="$work_dir/docker-calls.log"
  : > "$docker_calls_log"
  docker() {
    echo "$*" >> "$docker_calls_log"
    case "$1" in
      ps) printf 'dune-director\ndune-postgres\ndune-server-sh-arrakeen-3\ndune-server-sh-harkovillage-4\ndune-server-story-procesverbal-9\n' ;;
      logs) : ;;
    esac
  }

  # shellcheck source=/dev/null
  source "$defs_file" >/dev/null

  if ! director_heal_due rate_limit_smoke_test 100; then
    echo "expected first director_heal_due call to be due" >&2
    exit 1
  fi

  if director_heal_due rate_limit_smoke_test 100; then
    echo "expected second director_heal_due call within the interval to be gated" >&2
    exit 1
  fi

  director_heal_set "scan:rate_limit_smoke_test" "$(( $(date +%s) - 200 ))"
  if ! director_heal_due rate_limit_smoke_test 100; then
    echo "expected director_heal_due to fire again once the interval elapsed" >&2
    exit 1
  fi

  # Real call-site check: scan_named_destination_failures reads 3 hub
  # containers per invocation (one `docker logs` each). A due first call
  # must reach all 3; an immediate second call within the interval must be
  # suppressed before any of them.
  scan_named_destination_failures
  logs_after_first="$(grep -c '^logs ' "$docker_calls_log" || true)"
  [ "$logs_after_first" -eq 3 ] || {
    echo "expected 3 'docker logs' calls after the first scan_named_destination_failures call, got $logs_after_first" >&2
    exit 1
  }

  scan_named_destination_failures
  logs_after_second="$(grep -c '^logs ' "$docker_calls_log" || true)"
  [ "$logs_after_second" -eq 3 ] || {
    echo "expected 'docker logs' call count to stay at 3 after a second scan_named_destination_failures call within the interval (the gate should have suppressed it before any docker logs call), got $logs_after_second" >&2
    exit 1
  }
)

echo "autoscaler gates proactive-hagga, deep-desert-loading, and named-destination heal scans behind director_heal_due; director_heal_due itself rate-limits correctly; and scan_named_destination_failures's real docker-logs work is actually suppressed on a second call within the interval"
