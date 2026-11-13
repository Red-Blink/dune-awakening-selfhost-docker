#!/usr/bin/env python3
"""Exercise the real update-check shell and metadata subprocess without Docker/Steam."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "runtime/scripts/update.sh").read_text()
HELPERS = SOURCE[SOURCE.index("positive_integer_or_default() {"):SOURCE.index("container_running() {")]
CHECK = SOURCE[SOURCE.index('if [ "$cmd" = "check" ]'):SOURCE.index("skip_preflight=0")]


class UpdateCheckRetryTest(unittest.TestCase):
    def check(self, scenarios, expected, attempts=None, retry_sleep="5", delays=None):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            (work / "bin").mkdir()
            (work / "server/steamapps").mkdir(parents=True)
            (work / "server/steamapps/appmanifest_4754530.acf").write_text('"buildid" "42"\n')
            (work / "scenarios.json").write_text(json.dumps(scenarios))
            # Execute the actual inner shell, translating only its fixed fixture paths.
            (work / "bin/docker").write_text('''#!/usr/bin/env python3
import json, os, pathlib, subprocess, sys
p = pathlib.Path(os.environ["MOCK_WORK"])
if "bash" not in sys.argv:
    if "PREVIOUS_LINES=" not in " ".join(sys.argv): print("0")
    sys.exit(0)
n = int((p / "attempts").read_text()) + 1 if (p / "attempts").exists() else 1
(p / "attempts").write_text(str(n))
s = json.loads((p / "scenarios.json").read_text())[n - 1]
if "docker_rc" in s:
    print(s.get("output", "container unavailable"))
    sys.exit(s["docker_rc"])
if s.get("missing_steamcmd"): (p / "steamcmd.sh").unlink()
script = sys.argv[-1].replace("/srv/dune/steam/steamcmd.sh", str(p / "steamcmd.sh"))
script = script.replace("/srv/dune/steam/linux32/steamcmd", str(p / "missing"))
script = script.replace("/srv/dune/server", str(p / "server"))
script = script.replace("/tmp/dune-appinfo-", str(p / "appinfo-"))
env = dict(os.environ, MOCK_SCENARIO=json.dumps(s))
sys.exit(subprocess.run(["bash", "-c", script], env=env).returncode)
''')
            (work / "bin/timeout").write_text('''#!/usr/bin/env python3
import json, os, sys
s = json.loads(os.environ["MOCK_SCENARIO"])
if "build" in s: print('"branches"\\n"public"\\n"buildid" "' + str(s["build"]) + '"')
else: print(s.get("output", "Steam returned empty metadata"))
sys.exit(s.get("rc", 0))
''')
            (work / "bin/sleep").write_text('#!/bin/sh\nprintf "%s\\n" "$1" >> "$MOCK_WORK/delays"\n')
            (work / "steamcmd.sh").write_text("#!/bin/sh\nexit 99\n")
            for executable in [*(work / "bin").iterdir(), work / "steamcmd.sh"]:
                executable.chmod(0o700)
            script = 'set -euo pipefail\nAPP_ID=4754530\ncmd=check\n'
            script += f'source "{ROOT}/runtime/scripts/steamcmd-signals.sh"\n' + HELPERS + CHECK
            env = dict(os.environ, PATH=f'{work}/bin:' + os.environ["PATH"], MOCK_WORK=str(work),
                       DUNE_STEAMCMD_CHECK_MAX_ATTEMPTS=str(attempts or len(scenarios)),
                       DUNE_STEAMCMD_CHECK_RETRY_SLEEP=retry_sleep)
            result = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
            self.assertEqual(int((work / "attempts").read_text()), len(scenarios), result.stdout)
            actual_delays = (work / "delays").read_text().splitlines() if (work / "delays").exists() else []
            self.assertEqual(actual_delays, delays if delays is not None else ["5"] * (len(scenarios) - 1))
            self.assertEqual((work / "server/steamapps/appmanifest_4754530.acf").read_text(), '"buildid" "42"\n')
            return result.stdout

    def test_empty_then_current(self):
        self.check([{}, {"build": 42}], 0)

    def test_empty_then_update_available(self):
        self.check([{}, {"build": 43}], 100)

    def test_metadata_failures_exhaust_as_public_failure(self):
        for failure in [{}, {"rc": 124}, {"rc": 137}, {"rc": 1, "output": "Info request returned Timeout"}]:
            with self.subTest(failure=failure):
                output = self.check([failure, failure], 2)
                self.assertIn("failed after 2 attempts", output)

    def test_timeout_and_nonzero_recover(self):
        for code in [124, 137, 1]:
            with self.subTest(code=code):
                self.check([{"rc": code}, {"build": 42}], 0)

    def test_complete_metadata_at_shutdown_timeout(self):
        for code in [124, 137]:
            with self.subTest(code=code):
                self.check([{"rc": code, "build": 42}], 0)

    def test_fatal_container_failure_is_not_retried(self):
        self.check([{"docker_rc": 1}], 1, attempts=2)

    def test_missing_steamcmd_is_not_retried(self):
        self.check([{"missing_steamcmd": True}], 2, attempts=2)

    def test_content_host_retry_is_preserved(self):
        self.check([{"docker_rc": 2, "output": "Error: Could not resolve host cache1-blv2.valve.org"}, {"build": 42}], 0)

    def test_custom_retry_delay_is_capped(self):
        self.check([{}, {}, {"build": 42}], 0, retry_sleep="100", delays=["100", "120"])


if __name__ == "__main__":
    unittest.main()
