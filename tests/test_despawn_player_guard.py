"""Run the real despawn CLI against a synthetic database and Docker daemon."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class DespawnGuardTests(unittest.TestCase):
    def run_despawn(self, target='27', force=False, idle_confirmed=False, **signals):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        scripts = root / 'runtime/scripts'
        (scripts / 'lib').mkdir(parents=True)
        (root / 'runtime/generated').mkdir()
        for relative in ('despawn-server.sh', 'landsraad-instance-cleanup.sh',
                         'lib/postgres.sh', 'lib/ports.sh', 'lib/game-presence.sh'):
            if (ROOT / 'runtime/scripts' / relative).exists():
                shutil.copyfile(ROOT / 'runtime/scripts' / relative, scripts / relative)
        (scripts / 'map-modes.sh').write_text('#!/bin/sh\nexit 1\n')
        (scripts / 'map-modes.sh').chmod(0o755)
        (scripts / 'lib/container-lifecycle.sh').write_text(
            'dune_container_removal_hook() { echo "$1" >> "$FIXTURE/hooks"; }\n')
        binary = root / 'bin'
        binary.mkdir()
        docker = binary / 'docker'
        docker.write_text('''#!/usr/bin/env python3
import os,re,sys
from pathlib import Path
a=sys.argv[1:]
if a[0]=='ps':
 print('dune-server-cb-story-banditfortress01-27\\ndune-server-cb-story-banditfortress01-44\\ndune-postgres')
elif a[0]=='rm':
 with open(Path(os.environ['FIXTURE'])/'removed','a') as f:f.write(a[-1]+'\\n')
elif a[0]=='logs':
 if os.environ.get('LOG_FAIL')=='1':sys.exit(42)
 print(os.environ.get('GAME_LOG',''))
elif a[0]=='exec':
 q=a[-1]
 if 'guarded_players' in q:
  if os.environ.get('DB_FAIL')=='1':sys.exit(42)
  match=re.search(r'partition_id = ([0-9]+)',q)
  pid=match.group(1) if match else '27'
  counter=Path(os.environ['FIXTURE'])/('checks-'+pid)
  checks=int(counter.read_text()) if counter.exists() else 0
  counter.write_text(str(checks+1))
  presence=os.environ.get('PRESENCE_'+pid,os.environ.get('PRESENCE','0|0'))
  print(os.environ.get('PRESENCE_AFTER_PREFLIGHT',presence) if checks else presence)
 elif "select map || '|' || partition_id" in q:
  pid=re.search(r'partition_id = ([0-9]+)',q).group(1)
  print('CB_Story_BanditFortress01|'+pid)
 elif 'select coalesce(map' in q: print('CB_Story_BanditFortress01')
 elif 'select coalesce(server_id' in q: print('fixture-server')
 elif 'select partition_id' in q and 'lower(map)' in q: print('27\\n44')
else: sys.exit(1)
''')
        docker.chmod(0o755)
        environment = {**os.environ, 'FIXTURE': str(root), 'DUNE_PSQL_TRANSPORT': 'exec',
                       'PATH': str(binary) + ':' + os.environ['PATH'], **signals}
        args = ['bash', str(scripts / 'despawn-server.sh'), target]
        if force:
            args.append('--force')
        if idle_confirmed:
            args.append('--idle-confirmed')
        result = subprocess.run(args, env=environment, cwd=root, text=True, capture_output=True)
        removed = (root / 'removed').read_text().splitlines() if (root / 'removed').exists() else []
        hooks = (root / 'hooks').read_text().splitlines() if (root / 'hooks').exists() else []
        return result, removed, hooks

    def assert_refused(self, **signals):
        result, removed, hooks = self.run_despawn(**signals)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(removed, [])
        self.assertEqual(hooks, [])
        return result

    def test_live_connections_protect_instance(self):
        self.assert_refused(PRESENCE='2|0')

    def test_pawn_presence_protects_instance_with_zero_director_count(self):
        self.assert_refused(PRESENCE='0|1')

    def test_recent_gameplay_protects_instance_and_is_not_printed(self):
        result = self.assert_refused(GAME_LOG='LogResourceNode: Error: Unable to mine BP_Door_05_MiniGame_C player-private-data')
        self.assertNotIn('player-private-data', result.stdout + result.stderr)

    def test_unavailable_or_unknown_presence_fails_closed(self):
        for signals in ({'DB_FAIL': '1'}, {'PRESENCE': ''}, {'PRESENCE': 'bad'}, {'LOG_FAIL': '1'}):
            with self.subTest(signals=signals):
                self.assert_refused(**signals)

    def test_empty_instance_can_be_removed(self):
        result, removed, _ = self.run_despawn()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(removed, ['dune-server-cb-story-banditfortress01-27'])

    def test_force_explicitly_overrides_presence(self):
        result, removed, _ = self.run_despawn(force=True, PRESENCE='5|2', LOG_FAIL='1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(removed), 1)

    def test_map_batch_is_checked_before_removing_any_instance(self):
        self.assert_refused(target='CB_Story_BanditFortress01', PRESENCE_27='0|0', PRESENCE_44='0|1')

    def test_force_cannot_remove_an_unrelated_container(self):
        self.assert_refused(target='dune-postgres', force=True)

    def test_autoscaler_idle_hint_still_refuses_newly_connected_players(self):
        self.assert_refused(idle_confirmed=True, PRESENCE='1|1')

    def test_player_arriving_after_preflight_is_rechecked_before_stop(self):
        self.assert_refused(PRESENCE='0|0', PRESENCE_AFTER_PREFLIGHT='1|1')

    def test_confirmed_idle_does_not_add_grace_to_finished_fresh_process(self):
        result, removed, _ = self.run_despawn(idle_confirmed=True, GAME_LOG='LogNetPlayerMovement: ServerMove')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(removed), 1)


if __name__ == '__main__':
    unittest.main()
