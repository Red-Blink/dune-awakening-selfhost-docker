"""Exercise the autoscaler's real idle/demand paths with synthetic state."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / 'runtime/scripts/autoscaler.sh').read_text()


def function(name):
    return name + '() {' + SOURCE.split(name + '() {', 1)[1].split('\n}\n', 1)[0] + '\n}\n'


class StorySpareTests(unittest.TestCase):
    def run_idle(self, partition=44, occupied=1, isolated=1, fresh=0, cap=5, dedicated=1):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / 'runtime/scripts'
            scripts.mkdir(parents=True)
            despawn = scripts / 'despawn-server.sh'
            despawn.write_text('#!/bin/sh\necho "$1" >> removed\n')
            despawn.chmod(0o755)
            code = function('handle_idle_row') + r'''
state_key() { echo fixture; }
idle_seconds_for_map() { echo 0; }
map_is_dynamic() { return 0; }
map_is_overmap_active() { return 1; }
map_requires_fresh_process() { [ "$FRESH" = 1 ]; }
map_requires_isolated_party_dimension() { [ "$ISOLATED" = 1 ]; }
map_uses_dedicated_scaling() { echo "$DEDICATED"; }
max_dimensions_for_map() { echo "$CAP"; }
map_has_recent_demand() { return 1; }
map_dynamic_grace_remaining() { echo 0; }
get_idle_since() { echo 1; }
set_idle_since() { :; }
clear_idle_since() { :; }
forget_map_demand() { :; }
IDLE_SECONDS=300
DESPAWN_GRACE_SECONDS=300
handle_idle_row CB_Story_BanditFortress01 "$PARTITION" server 0 0 true true 44 "$OCCUPIED"
'''
            result = subprocess.run(['bash', '-euc', code], cwd=root, text=True, capture_output=True,
                                    env={**os.environ, 'FRESH': str(fresh), 'ISOLATED': str(isolated),
                                         'CAP': str(cap), 'PARTITION': str(partition), 'OCCUPIED': str(occupied),
                                         'DEDICATED': str(dedicated)})
            self.assertEqual(result.returncode, 0, result.stderr)
            return (root / 'removed').read_text() if (root / 'removed').exists() else ''

    def test_one_empty_spare_survives_while_sibling_occupied(self):
        self.assertEqual(self.run_idle(), '')

    def test_excess_spare_can_be_recycled(self):
        self.assertEqual(self.run_idle(partition=45), '45\n')

    def test_last_player_leaving_releases_spare(self):
        self.assertEqual(self.run_idle(occupied=0), '44\n')

    def test_configured_cap_is_respected(self):
        self.assertEqual(self.run_idle(cap=1), '44\n')

    def test_shared_party_maps_do_not_gain_standby_instances(self):
        self.assertEqual(self.run_idle(isolated=0), '44\n')

    def test_disabled_dedicated_scaling_does_not_retain_spare(self):
        self.assertEqual(self.run_idle(dedicated=0), '44\n')

    def test_fresh_process_activities_still_retire_when_empty(self):
        self.assertEqual(self.run_idle(fresh=1), '44\n')

    def test_warming_spare_and_caps_prevent_repeated_allocations(self):
        for assigned, occupied, cap, isolated, fresh, dedicated, mode, expected in (
            (1, 1, 5, 1, 0, 1, 1, True),
            (2, 1, 5, 1, 0, 1, 1, False),
            (0, 0, 5, 1, 0, 1, 1, False),
            (1, 1, 1, 1, 0, 1, 1, False),
            (1, 1, 5, 0, 0, 1, 1, False),
            (1, 1, 5, 1, 1, 1, 1, False),
            (1, 1, 5, 1, 0, 0, 1, False),
            (1, 1, 5, 1, 0, 1, 0, False),
        ):
            with self.subTest(assigned=assigned, occupied=occupied, cap=cap,
                              isolated=isolated, fresh=fresh, dedicated=dedicated, mode=mode):
                code = function('ensure_isolated_story_spare') + f'''
map_requires_isolated_party_dimension() {{ [ {isolated} = 1 ]; }}
map_requires_fresh_process() {{ [ {fresh} = 1 ]; }}
map_uses_dedicated_scaling() {{ echo {dedicated}; }}
map_is_dynamic() {{ [ {mode} = 1 ]; }}
map_is_overmap_active() {{ return 1; }}
max_dimensions_for_map() {{ echo {cap}; }}
handle_demand() {{ printf '%s|%s|%s|%s|%s' "$@"; }}
ensure_isolated_story_spare CB_Story_BanditFortress01 {assigned} {occupied}
'''
                result = subprocess.run(['bash', '-euc', code], text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(bool(result.stdout), expected)
                if expected:
                    self.assertIn('spare|ClassicalInstancing', result.stdout)


if __name__ == '__main__':
    unittest.main()
