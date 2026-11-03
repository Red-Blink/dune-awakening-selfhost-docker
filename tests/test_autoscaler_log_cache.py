import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import selectors
import shutil
import subprocess
import tempfile
import time
import unittest
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("director_cache", ROOT / "runtime/scripts/director-log-cache.py")
CACHE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CACHE)


def line(stamp, message):
    return datetime.fromtimestamp(stamp, timezone.utc).isoformat().replace("+00:00", "Z") + " " + message


class CacheTests(unittest.TestCase):
    def run_core_gate(self, commands):
        source = (ROOT / 'runtime/scripts/autoscaler.sh').read_text()
        function = source.split('core_maps_ready_for_browser_heal() {', 1)[1].split('\n}\n', 1)[0]
        with tempfile.TemporaryDirectory() as temp:
            scripts = Path(temp) / 'runtime/scripts'
            scripts.mkdir(parents=True)
            shutil.copyfile(ROOT / 'runtime/scripts/filter-container-logs.py', scripts / 'filter-container-logs.py')
            harness = '''set -euo pipefail
generation=2026-09-05T13:00:00Z
mode=bounded
farm_ready_director_fallback_reports=3
farm_partition_has_stable_director_reports() {
  [ "$mode" = director ] || return 1
  [ "$2" = 3 ] || return 1
  printf '%s\\n' "$3" >>director-proof-calls
}
director_heal_get() { [ -f "$1" ] && cat "$1"; }
director_heal_set() { printf '%s' "$2" >"$1"; }
timeout() { shift 2; "$@"; }
docker() {
  if [ "$1" = inspect ]; then printf 'true|%s\\n' "$generation"; return; fi
  printf '%s\\n' "$*" >>log-calls
  [[ "$*" == *--timestamps* ]] || return 1
  if [ "$mode" = missing ] || [ "$mode" = director ] || { [ "$mode" = rotated ] && [[ "$*" == *"--tail 5000"* ]]; }; then
    echo 'ordinary runtime log'; return
  fi
  local stamp="$generation"
  [ "$mode" != prior ] || stamp=2026-09-05T13:00:00Z
  case "$*" in
    *survival-1*) echo "$stamp Server farm is READY for partition 1, running" ;;
    *overmap*) echo "$stamp Server farm is READY for partition 2, running" ;;
  esac
}
'''
            harness += 'core_maps_ready_for_browser_heal() {' + function + '\n}\n' + commands
            result = subprocess.run(['bash', '-c', harness], cwd=temp, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout.strip().splitlines()

    def test_core_ready_proof_survives_noisy_logs_only_for_same_process(self):
        result = self.run_core_gate('''
core_maps_ready_for_browser_heal || exit 10
initial_calls=$(wc -l <log-calls)
mode=missing
core_maps_ready_for_browser_heal || exit 11
[ "$(wc -l <log-calls)" = "$initial_calls" ] || exit 12
generation=2026-09-05T14:00:00Z
if core_maps_ready_for_browser_heal; then exit 13; fi
mode=prior
if core_maps_ready_for_browser_heal; then exit 15; fi
mode=bounded
core_maps_ready_for_browser_heal || exit 14
echo pass
''')
        self.assertEqual(result, ['pass'])

    def test_core_ready_cold_lookup_uses_current_generation_when_tail_rotated(self):
        result = self.run_core_gate('''
mode=rotated
core_maps_ready_for_browser_heal || exit 10
grep -q 'logs --timestamps --tail 1000 dune-server-overmap' log-calls || exit 11
echo pass
''')
        self.assertEqual(result, ['pass'])

    def test_core_ready_uses_canonical_native_reports_when_startup_line_is_gone(self):
        result = self.run_core_gate('''
mode=director
core_maps_ready_for_browser_heal || exit 10
grep -q dune-server-survival-1 director-proof-calls || exit 11
grep -q dune-server-overmap director-proof-calls || exit 12
echo pass
''')
        self.assertEqual(result, ['pass'])

    def test_stream_waits_for_startup_and_reconnect_without_old_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'cache.sqlite'
            process = subprocess.Popen(['python3', str(ROOT / 'runtime/scripts/director-log-cache.py'),
                                        'stream', str(path), '--parent', str(os.getpid())],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)
            try:
                time.sleep(0.4)
                self.assertIsNone(process.poll())
                db = CACHE.connect(path)
                try:
                    db.execute("insert into state values (1,?,'first',1)", (time.time(),))
                    CACHE.append(db, [line(time.time(), 'historical')])
                    db.commit()
                    time.sleep(0.5)
                    CACHE.append(db, [line(time.time(), 'live')])
                    db.commit()
                    self.assertTrue(selector.select(timeout=3))
                    self.assertEqual(process.stdout.readline().strip(), 'live')
                    db.execute('update state set connected=0')
                    db.commit()
                    time.sleep(0.5)
                    self.assertIsNone(process.poll())
                    db.execute('delete from logs')
                    db.execute("update state set connected=1,generation='second',heartbeat=?", (time.time(),))
                    CACHE.append(db, [line(time.time(), 'new historical')])
                    db.commit()
                    time.sleep(0.5)
                    CACHE.append(db, [line(time.time(), 'new live')])
                    db.commit()
                    self.assertTrue(selector.select(timeout=3))
                    self.assertEqual(process.stdout.readline().strip(), 'new live')
                finally:
                    db.close()
            finally:
                process.terminate()
                process.wait(timeout=5)
                process.stdout.close()
                process.stderr.close()
                selector.close()

    def test_unavailable_evidence_cannot_trigger_browser_restart(self):
        source = (ROOT / 'runtime/scripts/autoscaler.sh').read_text()
        function = source.split('scan_director_browser_state() {', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(function.index('if ! director_logs_available;'), function.index('core_maps_ready_for_browser_heal'))
        script = 'scan_director_browser_state() {' + function + '\n}\n'
        script += '''
director_heal_due(){ return 0; }
director_logs_available(){ return 1; }
director_heal_clear(){ :; }
core_maps_ready_for_browser_heal(){ echo unexpected; exit 1; }
DIRECTOR_BROWSER_SCAN_SECONDS=30
scan_director_browser_state
'''
        result = subprocess.run(['bash', '-c', script], capture_output=True, text=True, check=True)
        self.assertEqual(result.stdout, '')

    def test_hagga_stream_parser_has_separate_program_and_log_input(self):
        source = (ROOT / 'runtime/scripts/autoscaler.sh').read_text()
        function = source.split('follow_director_hagga_handoffs() {', 1)[1].split('scan_deepdesert_loading_responses()', 1)[0]
        self.assertIn('director-log-cache.py stream', function)
        self.assertIn('python3 -u /dev/fd/3', function)
        code = function.split("3<<'PY'", 1)[1].split('\nPY\n', 1)[0].split('\n', 1)[1]
        target = {'partition_id': 1, 'dimension': 0, 'port': 7778, 'ip': '127.0.0.1'}
        payload = {'Code': 1, 'MapName': 'Survival_1', 'RequestID': 'flow-test'}
        event = 'Notified player(s) "test-player" of travel response SH_Arrakeen3: ' + json.dumps(payload)
        result = subprocess.run(['python3', '-c', code], input=event + '\n', text=True, capture_output=True,
                                env={**os.environ, 'TARGET_JSON': json.dumps(target)}, check=True)
        flow, origin, body = result.stdout.strip().split('|', 2)
        self.assertEqual((flow, origin), ('flow-test', 'SH_Arrakeen3'))
        self.assertEqual(json.loads(body)['grant']['PartitionId'], 1)

    def test_windows_preserve_order_timestamps_and_exact_pairs(self):
        db = CACHE.connect(":memory:")
        self.addCleanup(db.close)
        db.execute("insert into state values (1,1000,'director-a',1)")
        CACHE.append(db, [line(399, "expired"), line(980, "request"), line(981, "refusal"), line(970, "older delivered later")])
        self.assertEqual(CACHE.snapshot(db, 30, now=1000), ["request", "refusal", "older delivered later"])
        self.assertEqual(CACHE.snapshot(db, 10, now=1000), [])
        self.assertTrue(CACHE.snapshot(db, 30, True, now=1000)[0].endswith(" request"))
        with self.assertRaises(RuntimeError):
            CACHE.snapshot(db, 30, now=1016)
        db.execute("update state set connected=0")
        with self.assertRaises(RuntimeError):
            CACHE.snapshot(db, 30, now=1000)

    def test_invalid_duration_and_log_lines(self):
        for value in ("0s", "-1m", "nan", "10d"):
            with self.assertRaises(ValueError):
                CACHE.seconds(value)
        self.assertEqual(CACHE.seconds("10m"), 600)
        db = CACHE.connect(":memory:")
        self.addCleanup(db.close)
        CACHE.append(db, ["Docker connection failed", "bad timestamp"])
        self.assertEqual(db.execute("select count(*) from logs").fetchone()[0], 0)

    def test_one_follower_many_reads_and_replacement(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            mock = folder / "docker"
            mock.write_text("""#!/usr/bin/env python3
import os, pathlib, sys, time
root = pathlib.Path(os.environ['CACHE_TEST_ROOT'])
with (root / 'calls').open('a') as log:
    log.write(' '.join(sys.argv[1:]) + '\\n')
if sys.argv[1] == 'inspect':
    print((root / 'generation').read_text().strip() + ' true')
elif sys.argv[1] == 'logs':
    assert '--follow' in sys.argv and '--timestamps' in sys.argv
    assert '--since' in sys.argv
    print((root / sys.argv[-1]).read_text(), end='', flush=True)
    while True:
        time.sleep(0.1)
else:
    sys.exit(1)
""", encoding="utf-8")
            mock.chmod(0o755)
            (folder / "generation").write_text("first")
            (folder / "first").write_text(line(time.time(), "request then refusal") + "\n")
            (folder / "second").write_text(line(time.time(), "new generation") + "\n")
            env = {**os.environ, "PATH": str(folder) + os.pathsep + os.environ["PATH"], "CACHE_TEST_ROOT": temp}
            path = folder / "cache.sqlite"
            process = subprocess.Popen(["python3", str(ROOT / "runtime/scripts/director-log-cache.py"), "follow", str(path), "--parent", str(os.getpid())], env=env)
            try:
                def wait_for(expected):
                    deadline = time.monotonic() + 12
                    while time.monotonic() < deadline:
                        try:
                            with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
                                if CACHE.snapshot(db, 600) == [expected]:
                                    return
                        except (sqlite3.Error, RuntimeError):
                            pass
                        time.sleep(0.1)
                    self.fail("Follower did not publish expected generation")

                wait_for("request then refusal")
                for _ in range(20):
                    with sqlite3.connect(path) as db:
                        self.assertEqual(CACHE.snapshot(db, 30), ["request then refusal"])
                calls = (folder / "calls").read_text().splitlines()
                self.assertEqual(sum(call.startswith("logs ") for call in calls), 1)
                (folder / "generation").write_text("second")
                wait_for("new generation")
                calls = (folder / "calls").read_text().splitlines()
                self.assertEqual(sum(call.startswith("logs ") for call in calls), 2)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            finally:
                process.terminate()
                process.wait(timeout=8)
            with sqlite3.connect(path) as db:
                with self.assertRaises(RuntimeError):
                    CACHE.snapshot(db, 30)


if __name__ == "__main__":
    unittest.main()
