#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

script="runtime/scripts/autoscaler.sh"

# Structural regression guard: every scan_* function must either be gated
# behind director_heal_due, or be explicitly, deliberately listed here as an
# exception with a one-line reason. This is a living inventory, not just a
# test -- a future scan_* function added without either the gate or a
# conscious addition to this allowlist fails CI, instead of silently
# reproducing the class of oversight that originally caused dune-autoscaler
# to burn 80.99% of a core on one deployment (three ungated heal scans
# re-running expensive docker-logs+python3 work on every main-loop tick).
#
# Known, deliberate exceptions as of this test's authoring:
#   scan_travel_demand           - runs from its own dedicated DEMAND_INTERVAL
#                                   (default 2s) loop, not the main INTERVAL
#                                   loop; gating it at a multi-second interval
#                                   would delay real player travel-demand
#                                   detection, a responsiveness regression
#                                   worse than its CPU cost. Left ungated
#                                   deliberately; a proper fix would replace
#                                   its periodic --since snapshot with a
#                                   continuous `docker logs -f` follower
#                                   (like follow_director_hagga_handoffs
#                                   already does), not a naive gate.
#   scan_idle_servers             - not part of this fix's scope; each call
#   scan_reconnect_demand           is comparatively cheap (indexed SQL, not
#   scan_live_player_partition_      docker-logs+python3-regex over a large
#     alignment                     window); tracked as a separate follow-up.
KNOWN_UNGATED_SCANS="scan_travel_demand scan_idle_servers scan_reconnect_demand scan_live_player_partition_alignment"

python3 - "$script" "$KNOWN_UNGATED_SCANS" <<'PY'
import re
import sys

path, known_ungated_raw = sys.argv[1], sys.argv[2]
known_ungated = set(known_ungated_raw.split())

text = open(path, encoding="utf-8").read()
fn_re = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{', re.MULTILINE)
all_starts = sorted((m.start(), m.group(1)) for m in fn_re.finditer(text))
scan_fns = [name for _, name in all_starts if name.startswith("scan_")]
assert scan_fns, "found no scan_* functions at all -- check the regex/anchor still matches this file's style"

starts = {name: start for start, name in all_starts}
unexpectedly_ungated = []
stale_allowlist_entries = set(known_ungated)

for name in scan_fns:
    start = starts[name]
    idx = next(i for i, (s, _) in enumerate(all_starts) if s == start)
    end = all_starts[idx + 1][0] if idx + 1 < len(all_starts) else len(text)
    body = text[start:end]
    gated = "director_heal_due" in body

    if gated:
        continue
    if name in known_ungated:
        stale_allowlist_entries.discard(name)
        continue
    unexpectedly_ungated.append(name)

assert not unexpectedly_ungated, (
    "the following scan_* function(s) are not gated behind director_heal_due "
    "and are not in this test's documented allowlist -- either add the gate, "
    "or add the function to KNOWN_UNGATED_SCANS in this test with a one-line "
    f"reason: {unexpectedly_ungated}"
)
assert not stale_allowlist_entries, (
    "the following scan_* function(s) are listed in this test's allowlist as "
    "deliberately ungated but are no longer scan_* functions in the script "
    f"(renamed, removed, or now gated) -- update the allowlist: {stale_allowlist_entries}"
)
PY

echo "autoscaler scan_* gating inventory matches the documented allowlist (no new ungated scan slipped in unnoticed)"
