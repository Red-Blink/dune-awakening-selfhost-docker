import os
import re
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class GameSecretsTests(unittest.TestCase):
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
            secret = root / 'game.env'
            secret.write_text('FuncomLiveServices__ServiceAuthToken=synthetic=token\nfls-apikey=synthetic-fls\n')
            # Exercise the actual entrypoint loader, stopping before all game,
            # certificate, network and service startup operations.
            loader = (ROOT / 'runtime/container/run-server.sh').read_text().split('    install_cert', 1)[0]
            loader = loader.replace('/run/secrets/dune-game-env', str(secret))
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
