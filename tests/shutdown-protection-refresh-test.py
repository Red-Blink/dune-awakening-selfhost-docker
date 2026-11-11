#!/usr/bin/env python3
"""Exercise shutdown-unit refresh without touching host systemd or Docker."""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'runtime/scripts/shutdown-protection.sh').read_text()


def function(name):
    return name + '() {' + SOURCE.split(name + '() {', 1)[1].split('\n}\n', 1)[0] + '\n}\n'


class RefreshTests(unittest.TestCase):
    def run_refresh(self, enabled=1, mode='host', failure=''):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        state = root / 'state.env'
        saved = f'DUNE_SHUTDOWN_PROTECTION_ENABLED={enabled}\nDUNE_SHUTDOWN_PROTECTION_INSTALLED=1\n'
        state.write_text(saved)
        functions = ''.join(function(n) for n in ('read_state', 'unit_content',
                                                    'install_unit_via_docker_host', 'refresh_protection'))
        # Execute the Docker helper's real inner script, redirecting its only
        # host-directory reference to the fixture. Both systemctl and chroot
        # are shell stubs, so no real host service can be invoked.
        harness = r'''
STATE_FILE="$1/state.env"
SERVICE_NAME=dune-awakening-shutdown-protection.service
SERVICE_FILE="$1/unit.service"
HOST_ROOT_DIR=/srv/dune
fixture="$1"
mode="$2"
failure="$3"
can_manage_systemd_units() { [ "$mode" = host ]; }
docker_helper_image() { echo fixture-image; }
can_manage_host_systemd_with_docker() { [ "$mode" = docker ]; }
install_unit() { unit_content "$HOST_ROOT_DIR" > "$SERVICE_FILE"; }
systemctl() {
  echo "$*" >> "$fixture/calls"
  if [ "$1" = "$failure" ]; then return 42; fi
  if [ "$1" = enable ] && [ "${2:-}" = --now ]; then touch "$fixture/active"; fi
}
chroot() { shift 2; systemctl "$@"; }
docker() {
  local content="" script=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -e) content="${2#DUNE_SHUTDOWN_UNIT_CONTENT=}"; shift 2 ;;
      -lc) script="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  script="${script//\/host\/etc\/systemd\/system/$fixture\/helper}"
  export fixture failure DUNE_SHUTDOWN_UNIT_CONTENT="$content"
  export -f systemctl chroot
  bash -c "$script"
}
refresh_protection
'''
        result = subprocess.run(['bash', '-euc', functions + harness, 'fixture', str(root), mode, failure],
                                text=True, capture_output=True)
        self.assertEqual(state.read_text(), saved, 'refresh changed saved protection settings')
        return root, result

    def test_disabled_does_nothing(self):
        root, result = self.run_refresh(enabled=0)
        self.assertEqual(result.returncode, 0)
        self.assertFalse((root / 'calls').exists())
        self.assertFalse((root / 'unit.service').exists())

    def test_host_refresh_installs_without_starting_stopped_services(self):
        root, result = self.run_refresh()
        self.assertEqual(result.returncode, 0, result.stderr)
        # Starting this unit also pulls in Wants=docker.service. A host update
        # must preserve an operator's decision to keep Docker stopped.
        self.assertFalse((root / 'active').exists())
        self.assertNotIn('--now', (root / 'calls').read_text())
        self.assertIn('Conflicts=shutdown.target', (root / 'unit.service').read_text())
        self.assertNotIn('restart', (root / 'calls').read_text())

    def test_enable_failure_is_reported_and_preserves_state(self):
        root, result = self.run_refresh(failure='enable')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('service refreshed', result.stdout)
        self.assertFalse((root / 'active').exists())

    def test_reload_failure_cannot_report_success(self):
        root, result = self.run_refresh(failure='daemon-reload')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('service refreshed', result.stdout)
        self.assertNotIn('enable', (root / 'calls').read_text())

    def test_docker_helper_uses_same_unit_and_arms_protection(self):
        host, host_result = self.run_refresh()
        root, result = self.run_refresh(mode='docker')
        self.assertEqual(host_result.returncode, 0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((host / 'unit.service').read_text(),
                         (root / 'helper/dune-awakening-shutdown-protection.service').read_text())
        self.assertTrue((root / 'active').exists())

    def test_docker_helper_failure_is_nonzero_without_disabling_policy(self):
        _, result = self.run_refresh(mode='docker', failure='daemon-reload')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('service refreshed', result.stdout)

    def test_unavailable_host_management_reports_failure(self):
        _, result = self.run_refresh(mode='unavailable')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('could not be refreshed', result.stdout)


if __name__ == '__main__':
    unittest.main()
