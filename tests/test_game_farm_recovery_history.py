"""Run the real coordinated restart with disposable lifecycle stand-ins."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class FarmRecoveryTests(unittest.TestCase):
    def run_recovery(self, start_status=0, preflight_status=0, stopped=False):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            scripts = root / "runtime/scripts"
            scripts.mkdir(parents=True)
            generated = root / "runtime/generated"
            generated.mkdir()
            if stopped:
                (generated / "manual-stop.env").touch()
            for name in ("restart-game-farm.sh", "restart-history.sh"):
                shutil.copy(ROOT / "runtime/scripts" / name, scripts)
            stubs = ["sietches.sh", "autoscaler-control.sh", "spicefield-overrides.sh",
                     "publish-sietch-overrides.sh", "publish-deepdesert-overrides.sh",
                     "publish-network-server-state-overrides.sh", "recycle-world-game-servers.sh"]
            for name in stubs:
                path = scripts / name
                path.write_text(f'#!/bin/bash\necho "{name} $*" >> calls\n')
                path.chmod(0o700)
            (scripts / "usersettings.py").write_text(f"raise SystemExit({preflight_status})\n")
            path = scripts / "start-all.sh"
            path.write_text(f'#!/bin/bash\necho start-all >> calls\nexit {start_status}\n')
            path.chmod(0o700)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            docker = bin_dir / "docker"
            docker.write_text('#!/bin/bash\necho "docker $*" >> calls\n')
            docker.chmod(0o700)
            result = subprocess.run(["bash", str(scripts / "restart-game-farm.sh"), "stale-browser-state"],
                                    cwd=root, capture_output=True, text=True,
                                    env={**os.environ, "PATH": str(bin_dir) + os.pathsep + os.environ["PATH"],
                                         "DUNE_BATTLEGROUP_LIFECYCLE_LOCK_HELD": "1",
                                         "DUNE_RESTART_HISTORY_FILE": str(root / "history.jsonl")})
            calls = (root / "calls").read_text() if (root / "calls").exists() else ""
            history = [json.loads(line) for line in (root / "history.jsonl").read_text().splitlines()] \
                if (root / "history.jsonl").exists() else []
            return result, calls, history, (generated / "battlegroup-maintenance.env").exists()

    def test_success_records_actual_completion_and_preserves_infrastructure(self):
        result, calls, history, marker = self.run_recovery()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("recycle-world-game-servers.sh stop-all", calls)
        self.assertIn("docker rm -f dune-server-gateway dune-director", calls)
        self.assertIn("start-all", calls)
        self.assertNotIn("dune-postgres", calls)
        self.assertNotIn("dune-rmq", calls)
        self.assertEqual(len(history), 1)
        self.assertEqual((history[0]["source"], history[0]["result"]), ("Automatic", "Succeeded"))
        self.assertFalse(marker)

    def test_restart_failure_records_failure_and_preserves_exit_status(self):
        result, _, history, marker = self.run_recovery(start_status=7)
        self.assertEqual(result.returncode, 7)
        self.assertEqual(history[0]["result"], "Failed")
        self.assertFalse(marker)

    def test_preflight_failure_stops_before_services_are_touched(self):
        result, calls, history, marker = self.run_recovery(preflight_status=2)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn("stop", calls)
        self.assertEqual(history[0]["result"], "Failed")
        self.assertFalse(marker)

    def test_intentional_manual_stop_prevents_automatic_recovery(self):
        result, calls, history, marker = self.run_recovery(stopped=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(calls, "")
        self.assertEqual(history, [])
        self.assertFalse(marker)


if __name__ == "__main__":
    unittest.main()
