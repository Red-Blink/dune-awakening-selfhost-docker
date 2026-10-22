#!/usr/bin/env python3
"""Exercise both real unit writers and timer re-arming without host mutations."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import unittest
import uuid


SOURCE = (Path(__file__).resolve().parents[1] / "scripts/update.sh").read_text()


def function(name):
    match = re.search(rf"^{name}\(\) \{{\n.*?^\}}$", SOURCE, re.M | re.S)
    if not match:
        raise AssertionError(f"Missing function {name}")
    return match[0]


class AutoUpdateTimerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dune-auto-timer-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.units = self.root / "units"
        self.log = self.root / "systemctl.log"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}",
                        TEST_UNITS=str(self.units), TEST_LOG=str(self.log))
        # All systemctl calls are recorded, never forwarded to the host.
        self.stub("systemctl", """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$TEST_LOG"
case "${1:-}" in
  show)
    case "$*" in
      *--property=LoadState*) echo loaded ;;
      *--property=SubState*) echo "${TEST_TIMER_STATE:-waiting}" ;;
      *--property=ActiveState*) echo "${TEST_SERVICE_STATE:-inactive}" ;;
      *--property=WorkingDirectory*) echo /fixture ;;
      *--property=ExecStart*) echo '/fixture/runtime/scripts/update.sh auto run' ;;
    esac ;;
  is-active) echo active ;;
esac
""")
        # Run the Docker helper's actual embedded Bash with only its filesystem
        # target and systemctl bridge redirected into this disposable fixture.
        self.stub("docker", """#!/usr/bin/env python3
import os, subprocess, sys
env = dict(os.environ)
args = sys.argv[1:]
for i, arg in enumerate(args[:-1]):
    if arg == '-e':
        key, value = args[i + 1].split('=', 1)
        env[key] = value
program = args[-1].replace('/host/etc/systemd/system', env['TEST_UNITS'])
program = program.replace('chroot /host /bin/systemctl', 'systemctl')
sys.exit(subprocess.run(['bash', '-c', program], env=env).returncode)
""")

    def stub(self, name, contents):
        target = self.bin / name
        target.write_text(contents)
        target.chmod(0o755)

    def run_bash(self, code, **env):
        return subprocess.run(["bash", "-eu", "-o", "pipefail", "-c", code],
                              env=dict(self.env, **env), check=True,
                              text=True, capture_output=True).stdout

    def assert_schedule(self):
        timer = (self.units / "dune-awakening-auto-update.timer").read_text()
        self.assertIn("OnActiveSec=5min\n", timer)
        self.assertIn("OnUnitInactiveSec=30min\n", timer)
        self.assertNotIn("OnBootSec=", timer)
        self.assertNotIn("OnUnitActiveSec=", timer)

    def test_direct_writer_and_resave_rearms_only_timer(self):
        names = ["write_auto_units_to", "handle_auto_update", "require_auto_interval_minutes",
                 "require_bool_flag", "require_auto_notify_minutes", "normalize_auto_notify_minutes",
                 "require_auto_max_wait_minutes"]
        code = "\n".join(function(name) for name in names)
        # Keep the real enable branch and generated units; only privileged
        # filesystem/state access is redirected. Capture the saved policy.
        code = code.replace('"/etc/systemd/system"', '"$TEST_UNITS"')
        code += """
AUTO_SERVICE_NAME=dune-awakening-auto-update.service
AUTO_TIMER_NAME=dune-awakening-auto-update.timer
HOST_ROOT_DIR=/fixture
can_manage_systemd_units() { return 0; }
ensure_auto_state_writable() { :; }
write_auto_state() { printf '%s\\n' "$*" > "$TEST_UNITS/policy"; }
handle_auto_update enable 30 1 1 30,15,10,5,1 1 30
handle_auto_update enable 30 1 1 30,15,10,5,1 1 30
"""
        self.run_bash(code)
        self.assert_schedule()
        self.assertEqual((self.units / "policy").read_text().strip(),
                         "1 30 1 1 30,15,10,5,1 1 30 1 0 0")
        calls = self.log.read_text().splitlines()
        self.assertEqual(calls.count("restart dune-awakening-auto-update.timer"), 2)
        self.assertFalse(any("stop" in call or "restart dune-awakening-auto-update.service" in call
                             for call in calls))

    def test_console_bridge_writer_rearms_only_timer(self):
        code = function("install_auto_units_via_docker_host") + """
can_manage_host_systemd_with_docker() { return 0; }
docker_helper_image() { echo fixture; }
HOST_ROOT_DIR=/fixture
install_auto_units_via_docker_host 30
"""
        self.run_bash(code)
        self.assert_schedule()
        self.assertEqual(self.log.read_text().splitlines(), [
            "daemon-reload", "enable --now dune-awakening-auto-update.timer",
            "restart dune-awakening-auto-update.timer"])

    def test_console_bridge_warns_about_exhausted_timer(self):
        code = function("show_auto_timer_status_via_docker") + """
can_manage_host_systemd_with_docker() { return 0; }
docker_helper_image() { echo fixture; }
HOST_ROOT_DIR=/fixture
AUTO_DEFAULT_INTERVAL_MINUTES=60
show_auto_timer_status_via_docker
"""
        for state in ["inactive", "failed"]:
            output = self.run_bash(code, TEST_TIMER_STATE="elapsed", TEST_SERVICE_STATE=state)
            self.assertIn("no future check scheduled", output)
        for state in ["active", "activating", "deactivating"]:
            output = self.run_bash(code, TEST_TIMER_STATE="elapsed", TEST_SERVICE_STATE=state)
            self.assertNotIn("no future check scheduled", output)

    @unittest.skipUnless(os.environ.get("DUNE_TEST_USER_SYSTEMD") == "1",
                         "Opt-in smoke test requires a local user systemd manager")
    def test_real_timer_repeats_after_long_job_and_reactivation(self):
        # These unique runtime-only user units never invoke Docker or the real
        # updater. Link the generated unit files to retain them across stops.
        # Accelerate the generated schedule to seconds, keeping its anchors.
        unit = f"dune-auto-timer-test-{uuid.uuid4().hex}"
        runs = self.root / "runs"

        def control(*args):
            return subprocess.run(["systemctl", "--user", *args], check=True,
                                  text=True, capture_output=True)

        def cleanup():
            subprocess.run(["systemctl", "--user", "--runtime", "disable", "--now",
                            f"{unit}.timer", f"{unit}.service"],
                           text=True, capture_output=True)
            subprocess.run(["systemctl", "--user", "reset-failed", f"{unit}.timer", f"{unit}.service"],
                           text=True, capture_output=True)

        self.addCleanup(cleanup)
        project = self.root / "project"
        script = project / "runtime/scripts/update.sh"
        script.parent.mkdir(parents=True)
        script.write_text(f"#!/bin/sh\nprintf 'run\\n' >> '{runs}'\nsleep 2\n")
        script.chmod(0o755)
        code = function("write_auto_units_to") + f"""
AUTO_SERVICE_NAME={unit}.service
AUTO_TIMER_NAME={unit}.timer
write_auto_units_to 30 "$TEST_UNITS" "{project}"
"""
        self.run_bash(code)
        timer = self.units / f"{unit}.timer"
        timer.write_text(timer.read_text().replace("OnActiveSec=5min", "OnActiveSec=1s")
                         .replace("OnUnitInactiveSec=30min", "OnUnitInactiveSec=1s")
                         .replace("AccuracySec=1min", "AccuracySec=10ms"))
        control("--runtime", "link", str(timer), str(self.units / f"{unit}.service"))
        control("start", f"{unit}.timer")

        def await_runs(count):
            deadline = time.monotonic() + 12
            while time.monotonic() < deadline:
                if runs.exists() and len(runs.read_text().splitlines()) >= count:
                    return
                time.sleep(0.1)
            self.fail(f"Timer did not reach {count} activations")

        await_runs(2)  # Job exceeds its repeat interval but the timer re-arms.
        control("stop", f"{unit}.timer", f"{unit}.service")
        count = len(runs.read_text().splitlines())
        time.sleep(2)  # Previous completion + interval is now in the past.
        control("start", f"{unit}.timer")
        await_runs(count + 1)


if __name__ == "__main__":
    unittest.main()
