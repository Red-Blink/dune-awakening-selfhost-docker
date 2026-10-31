import os
import re
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class GameSecretsTests(unittest.TestCase):
    def run_container_removal(self, scenario, name='dune-server-survival-1'):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            executable = root / 'docker'
            executable.write_text('''#!/bin/bash
set -eu
printf '%s\\n' "$*" >> "$FIXTURE_CALLS"
case "$1" in
  ps)
    [ "$FIXTURE_SCENARIO" != daemon-error ] || exit 1
    if [ "$FIXTURE_SCENARIO" != absent ] && [ ! -f "$FIXTURE_REMOVED" ]; then
      printf 'synthetic-container-id\\n'
    fi
    ;;
  rm)
    count=0
    [ ! -f "$FIXTURE_COUNT" ] || count="$(cat "$FIXTURE_COUNT")"
    count=$((count+1))
    printf '%s' "$count" > "$FIXTURE_COUNT"
    case "$FIXTURE_SCENARIO" in
      immediate) touch "$FIXTURE_REMOVED" ;;
      delayed) [ "$count" -gt 1 ] || exit 1; touch "$FIXTURE_REMOVED" ;;
      disappeared-after-error) touch "$FIXTURE_REMOVED"; exit 1 ;;
      persistent-failure) exit 124 ;;
      false-success) exit 0 ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
''')
            executable.chmod(0o755)
            env = os.environ.copy()
            env.update(
                PATH=str(root) + os.pathsep + env['PATH'],
                FIXTURE_SCENARIO=scenario,
                FIXTURE_CALLS=str(root / 'calls'),
                FIXTURE_COUNT=str(root / 'count'),
                FIXTURE_REMOVED=str(root / 'removed'),
            )
            script = '''set -euo pipefail
source "$1/runtime/scripts/lib/game-container.sh"
# Keep tests fast and assert that every Docker operation has a time limit.
timeout() {
  case "$1:$2" in 15:docker|30:docker) shift; "$@" ;; *) return 99 ;; esac
}
sleep() { :; }
remove_existing_game_container "$2"
printf 'replacement-allowed\\n'
'''
            result = subprocess.run(['bash', '-c', script, 'test', str(ROOT), name],
                                    env=env, capture_output=True, text=True, timeout=5)
            calls = (root / 'calls').read_text().splitlines() if (root / 'calls').exists() else []
            return result, calls

    def test_missing_container_needs_no_removal(self):
        result, calls = self.run_container_removal('absent')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(c.startswith('rm ') for c in calls))

    def test_container_removal_is_verified_before_replacement(self):
        result, calls = self.run_container_removal('immediate')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum(c.startswith('rm ') for c in calls), 1)
        self.assertTrue(calls[-1].startswith('ps '))
        self.assertIn('name=^/dune-server-survival-1$', calls[-1])

    def test_delayed_exit_event_retries_removal(self):
        result, calls = self.run_container_removal('delayed')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum(c.startswith('rm ') for c in calls), 2)

    def test_removal_error_can_still_finish_asynchronously(self):
        result, calls = self.run_container_removal('disappeared-after-error')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sum(c.startswith('rm ') for c in calls), 1)

    def test_persistent_removal_failure_prevents_replacement(self):
        result, calls = self.run_container_removal('persistent-failure')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sum(c.startswith('rm ') for c in calls), 3)
        self.assertNotIn('replacement-allowed', result.stdout)
        self.assertIn('still exists after 3 removal attempts', result.stderr)

    def test_success_without_removal_does_not_allow_replacement(self):
        result, calls = self.run_container_removal('false-success')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(sum(c.startswith('rm ') for c in calls), 3)
        self.assertNotIn('replacement-allowed', result.stdout)

    def test_unreachable_docker_is_not_treated_as_missing_container(self):
        result, calls = self.run_container_removal('daemon-error')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(c.startswith('rm ') for c in calls))
        self.assertNotIn('replacement-allowed', result.stdout)

    def test_invalid_name_never_reaches_docker(self):
        result, calls = self.run_container_removal('immediate', 'invalid.*name')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, [])

    def test_all_game_launchers_require_successful_removal(self):
        for filename, target in [
            ('start-server-survival-1.sh', 'dune-server-survival-1'),
            ('start-server-overmap.sh', 'dune-server-overmap'),
            ('spawn-server.sh', '"$CONTAINER_NAME"'),
        ]:
            source = (ROOT / 'runtime/scripts' / filename).read_text()
            self.assertIn(f'\nremove_existing_game_container {target}\n', source)
            self.assertLess(source.index(f'remove_existing_game_container {target}'),
                            source.index('docker run -d'))

    def test_parallel_catalog_refresh_propagates_either_failure(self):
        source = (ROOT / 'runtime/scripts/start-all.sh').read_text()
        command = re.search(r'run_timed_step "Refreshing Map Catalogs" bash -c \'(.*?)\n\'', source, re.S).group(1)
        for first, second in [(7, 0), (0, 8), (0, 0)]:
            with tempfile.TemporaryDirectory() as tmp:
                scripts = Path(tmp) / 'runtime/scripts'
                scripts.mkdir(parents=True)
                for name, status in [('extract-server-catalog.sh', first), ('extract-partition-catalog.sh', second)]:
                    script = scripts / name
                    script.write_text(f'#!/bin/sh\ntouch "{name}.finished"\nexit {status}\n')
                    script.chmod(0o755)
                result = subprocess.run(['bash', '-c', command], cwd=tmp)
                self.assertEqual(result.returncode == 0, first == second == 0)
                self.assertEqual(len(list(Path(tmp).glob('*.finished'))), 2)

    def test_mounted_secrets_reach_child_including_hyphenated_fls_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            # Fixed dummy values only: this fixture never reads host credentials.
            fixture_path = root / 'game.env'
            fixture_path.write_text('FuncomLiveServices__ServiceAuthToken=synthetic=token\nfls-apikey=synthetic-fls\n')
            fixture_path.chmod(0o600)
            # Exercise the actual entrypoint loader, stopping before all game,
            # certificate, network and service startup operations.
            loader = (ROOT / 'runtime/container/run-server.sh').read_text().split('    install_cert', 1)[0]
            loader = loader.replace('/run/secrets/dune-game-env', str(fixture_path))
            harness = root / 'loader.sh'
            harness.write_text(loader + '''    python3 - <<'CHECK'
import os
assert os.environ['FuncomLiveServices__ServiceAuthToken'] == 'synthetic=token'
assert os.environ['fls-apikey'] == 'synthetic-fls'
CHECK
}
main "$@"
''')
            env = os.environ.copy()
            env.pop('DUNE_GAME_ENV_LOADED', None)
            subprocess.run(['bash', str(harness)], env=env, check=True, capture_output=True, text=True)

    def test_secret_writer_rejects_line_injection_and_keeps_private_modes(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = '''set -euo pipefail
source "$1/runtime/scripts/lib/game-container.sh"
cd "$2"
FUNCOM_TOKEN='synthetic=token'
RMQ_HTTP_TOKEN_AUTH_SECRET=synthetic
SERVER_LOGIN_PASSWORD_SECRET=synthetic
USERNAME_SERVER_LOGIN_SECRET=synthetic
LOGIN_PASSWORD_SKEW_SECONDS=30
FLS_APIKEY=synthetic
original_umask="$(umask)"
prepare_game_container_secret_file test >/dev/null
test "$(umask)" = "$original_umask"
test "$(stat -c %a runtime/secrets/game-container-test.env)" = 600
FUNCOM_TOKEN=$'synthetic\\nINJECTED=value'
if prepare_game_container_secret_file injected >/dev/null 2>&1; then exit 1; fi
test ! -e runtime/secrets/game-container-injected.env
game_container_security_args | grep -qx -- --privileged
DUNE_GAME_CONTAINER_PRIVILEGED=0
if game_container_security_args | grep -qx -- --privileged; then exit 1; fi
'''
            subprocess.run(['bash', '-c', script, 'test', str(ROOT), tmp], check=True, capture_output=True, text=True)


if __name__ == '__main__':
    unittest.main()
