"""Exercise the real browser-heal function without touching Docker or maps."""
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("browser_state", ROOT / "runtime/scripts/director-browser-state.py")
BROWSER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BROWSER)


def declaration(stamp, capacity=0, locked=False):
    timestamp = datetime.fromtimestamp(stamp, timezone.utc).isoformat().replace("+00:00", "Z")
    return timestamp + ' [INF] Population declaration: ' + json.dumps({
        "BattlegroupMaxPlayerCapacity": capacity, "IsLocked": locked,
    })


class CapacityEvidenceTests(unittest.TestCase):
    def test_pre_repair_zero_and_single_report_cannot_escalate(self):
        for lines in ([declaration(990)], [declaration(1060)],
                      [declaration(1120), declaration(1120)]):
            self.assertFalse(BROWSER.failure_confirmed(lines, after=1000, now=1130, grace=45))

    def test_waits_for_two_reporting_cycles_after_repair(self):
        self.assertFalse(BROWSER.failure_confirmed(
            [declaration(1001), declaration(1062)], 1000, 1070, 45))
        self.assertTrue(BROWSER.failure_confirmed(
            [declaration(1060), declaration(1121)], 1000, 1130, 120))

    def test_positive_capacity_resets_failure_even_with_late_log_delivery(self):
        self.assertFalse(BROWSER.failure_confirmed(
            [declaration(1120, 60), declaration(1001), declaration(1062)], 1000, 1130, 120))
        self.assertFalse(BROWSER.failure_confirmed(
            [declaration(1001), declaration(1062, 60), declaration(1123)], 1000, 1130, 120))

    def test_missing_stale_future_locked_and_invalid_evidence_fail_closed(self):
        for lines in ([], ["not a declaration"], [declaration(1001), declaration(1062)],
                      [declaration(1120), declaration(1181)],
                      [declaration(1060), declaration(1121, locked=True)],
                      [declaration(1060), declaration(1121, capacity="0")],
                      [declaration(1060), declaration(1121, capacity=False)]):
            self.assertFalse(BROWSER.failure_confirmed(lines, 1000, 1130, 120))
        self.assertFalse(BROWSER.failure_confirmed(
            [declaration(1060), declaration(1121)], 1000, 1300, 120))

    def test_cli_does_not_emit_sensitive_log_payload(self):
        result = subprocess.run(["python3", str(ROOT / "runtime/scripts/director-browser-state.py"),
                                 "--after", "1000", "--now", "1130", "--grace", "120"],
                                input="\n".join([declaration(1060), declaration(1121)]),
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout + result.stderr, "")

    def test_real_shell_gate_rejects_a_failed_log_read_even_with_partial_evidence(self):
        source = (ROOT / "runtime/scripts/autoscaler.sh").read_text()
        function = "director_capacity_failure_confirmed() {" + source.split(
            "director_capacity_failure_confirmed() {", 1
        )[1].split("\n}\n", 1)[0] + "\n}\n"
        script = '''set -euo pipefail
DIRECTOR_HEAL_REPUBLISH_GRACE_SECONDS=120
director_logs(){ printf '%s\\n' "$REPORTS"; return "$LOG_STATUS"; }
''' + function + '\ndirector_capacity_failure_confirmed 1000 1130\n'
        for status in (0, 1):
            result = subprocess.run(["bash", "-c", script], cwd=ROOT, capture_output=True,
                                    env={**os.environ, "LOG_STATUS": str(status),
                                         "REPORTS": "\n".join([declaration(1060), declaration(1121)])})
            self.assertEqual(result.returncode, status)
            self.assertEqual(result.stdout + result.stderr, b"")


class BrowserRecoveryTests(unittest.TestCase):
    def test_background_dispatch_retains_only_lifecycle_stages_and_exit_status(self):
        source = (ROOT / "runtime/scripts/autoscaler.sh").read_text()
        function = source.split("scan_director_browser_state() {", 1)[1]
        command = re.search(r"docker exec -d dune-coriolis-coordinator bash -lc \\\n\s*'(.*?)'; then", function, re.S).group(1)
        with tempfile.TemporaryDirectory() as temp:
            scripts = Path(temp) / "runtime/scripts"
            scripts.mkdir(parents=True)
            restart = scripts / "restart-game-farm.sh"
            restart.write_text('#!/bin/bash\necho "=== Starting Director ==="\necho "private payload must not be retained"\nexit 7\n')
            restart.chmod(0o700)
            result = subprocess.run(["bash", "-c", command], cwd=temp, capture_output=True)
            self.assertEqual(result.returncode, 7)
            log = Path(temp) / "runtime/logs/browser-state-recovery.log"
            self.assertEqual(log.read_text(), "=== Starting Director ===\n")
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)

    def run_scan(self, confirmed=False, repairing=False, occupied="0", restart_status=0,
                 coordinator=True):
        source = (ROOT / "runtime/scripts/autoscaler.sh").read_text()
        function = "scan_director_browser_state() {" + source.split(
            "scan_director_browser_state() {", 1
        )[1].split("\n}\n", 1)[0] + "\n}\n"
        with tempfile.TemporaryDirectory() as temp:
            scripts = Path(temp) / "runtime/scripts"
            scripts.mkdir(parents=True)
            restart = scripts / "restart-director.sh"
            restart.write_text(f"#!/bin/bash\necho restart >> calls\nexit {restart_status}\n")
            restart.chmod(0o700)
            setup = r'''
set -euo pipefail
declare -A heal=([core_ready_since]=1 [stale_since]=1)
if [ "$REPAIRING" = 0 ]; then heal[browser_republish_at]=800; fi
clock=1000
date(){ if [ "${1:-}" = +%s ]; then echo "$clock"; else command date "$@"; fi; }
director_heal_due(){ :; }
director_logs_available(){ :; }
core_maps_ready_for_browser_heal(){ :; }
director_heal_get(){ [ -n "${heal[$1]:-}" ] && echo "${heal[$1]}"; }
director_heal_set(){ heal[$1]="$2"; }
director_heal_clear(){ unset 'heal[$1]'; }
director_live_server_rows(){ printf 'Survival_1|test-a\nOvermap|test-b\n'; }
director_latest_capacity(){ echo 0; }
director_logs_contain_live_ids(){ :; }
director_capacity_failure_confirmed(){ [ "$CONFIRMED" = 1 ]; }
docker(){
  if [ "$1" = inspect ]; then echo "$COORDINATOR"; return 0; fi
  printf '%s\n' "$*" >> calls
  return "$RESTART_STATUS"
}
publish_state_for_map(){ clock=$((clock + 20)); }
battlegroup_effective_player_count(){ echo "$OCCUPIED"; }
AUTOSCALER_STARTED_AT=0
DIRECTOR_BROWSER_SCAN_SECONDS=30
DIRECTOR_CORE_READY_GRACE_SECONDS=120
DIRECTOR_HEAL_STALE_SECONDS=15
DIRECTOR_HEAL_REPUBLISH_GRACE_SECONDS=120
DIRECTOR_HEAL_COOLDOWN_SECONDS=300
SIETCH_TOPOLOGY_MAINTENANCE_FILE=absent
SIETCH_TOPOLOGY_HEAL_GRACE_SECONDS=600
'''
            result = subprocess.run(["bash", "-c", setup + function + '''
scan_director_browser_state
echo "repair_completed=${heal[browser_republish_at]:-cleared}"
'''], cwd=temp, env={**os.environ, "REPAIRING": str(int(repairing)),
                                  "CONFIRMED": str(int(confirmed)), "OCCUPIED": occupied,
                                  "COORDINATOR": str(coordinator).lower(),
                                  "RESTART_STATUS": str(restart_status)},
                                    capture_output=True, text=True, check=True)
            return (Path(temp, "calls").exists(), result.stdout,
                    Path(temp, "calls").read_text() if Path(temp, "calls").exists() else "")

    def test_old_zero_capacity_does_not_restart_maps(self):
        restarted, _, _ = self.run_scan()
        self.assertFalse(restarted)

    def test_repair_grace_starts_after_all_publications_complete(self):
        restarted, output, _ = self.run_scan(repairing=True)
        self.assertFalse(restarted)
        self.assertIn("repair_completed=1060", output)

    def test_confirmed_failure_still_recovers_an_empty_battlegroup(self):
        restarted, _, calls = self.run_scan(confirmed=True)
        self.assertTrue(restarted)
        self.assertIn("restart-game-farm.sh stale-browser-state", calls)
        self.assertIn("exec -d dune-coriolis-coordinator", calls)
        self.assertNotIn("restart-director.sh", calls)

    def test_failed_dispatch_is_reported(self):
        restarted, output, _ = self.run_scan(confirmed=True, restart_status=1)
        self.assertTrue(restarted)
        self.assertIn("ERROR", output)

    def test_missing_coordinator_prevents_isolated_core_restart(self):
        self.assertFalse(self.run_scan(confirmed=True, coordinator=False)[0])

    def test_players_or_unknown_occupancy_prevent_disruption(self):
        for occupied in ("1", "unknown", ""):
            with self.subTest(occupied=occupied):
                self.assertFalse(self.run_scan(confirmed=True, occupied=occupied)[0])


if __name__ == "__main__":
    unittest.main()
