#!/usr/bin/env python3
"""Exercise the scheduler's real Bash functions with deterministic timestamps."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "runtime/scripts/db.sh").read_text()


def function(name):
    return name + "() {" + SOURCE.split(name + "() {", 1)[1].split("\n}\n", 1)[0] + "\n}\n"


HELPERS = "\n".join(function(name) for name in (
    "system_auto_initial_epoch", "system_auto_next_epoch", "system_auto_due",
    "system_auto_timer_text", "system_auto_service_text"))


def bash(code, timezone="UTC"):
    return subprocess.check_output(
        ["bash", "-euc", HELPERS + code], text=True,
        env={**os.environ, "TZ": timezone}).strip()


class TimingTests(unittest.TestCase):
    def test_backup_lock_remains_writable_by_console_after_root_maintenance(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory)
            uid = 1000 if os.geteuid() == 0 else os.geteuid()
            gid = 1000 if os.geteuid() == 0 else os.getegid()
            if os.geteuid() == 0:
                os.chown(fixture, uid, gid)
            scripts = fixture / "runtime/scripts"
            scripts.mkdir(parents=True)
            (scripts / "host-file-ownership.sh").write_text(
                (ROOT / "runtime/scripts/host-file-ownership.sh").read_text())
            subprocess.run(["bash", "-euc", function("acquire_system_backup_lock") +
                            'SYSTEM_BACKUP_LOCK_FILE=runtime/backups/.system-backup.lock; '
                            'acquire_system_backup_lock'], cwd=fixture, check=True)
            lock = fixture / "runtime/backups/.system-backup.lock"
            self.assertEqual(lock.stat().st_mode & 0o777, 0o600)
            self.assertEqual(lock.stat().st_uid, uid)
            # When run in the root test container, exercise the actual handoff
            # to a separate non-root process, not just a mode/owner assertion.
            identity = {"user": uid, "group": gid, "extra_groups": []} if os.geteuid() == 0 else {}
            subprocess.run(["flock", "-n", str(lock), "true"], check=True, **identity)

    def test_first_run_uses_next_local_clock(self):
        self.assertEqual(bash('now=$(date -d "2026-11-10 16:00" +%s); '
                              'date -u -d "@$(system_auto_initial_epoch 04:30 "$now")" +%FT%R'),
                         "2026-11-11T04:30")

    def test_non_daily_intervals_preserve_anchor_across_midnight(self):
        for hours in (1, 5, "08", 12, 36, 48, 168):
            with self.subTest(hours=hours):
                self.assertEqual(bash(f'a=$(date -d "2026-11-10 22:15" +%s); '
                                      f'n=$(system_auto_next_epoch "$a" "$a" {hours}); '
                                      'echo $((n-a))'), str(int(hours) * 3600))

    def test_missed_wake_remains_due_after_restart(self):
        self.assertEqual(bash('load_system_auto_state() { SYSTEM_AUTO_ENABLED=1; '
                              'SYSTEM_AUTO_ANCHOR_EPOCH=1000000000; SYSTEM_AUTO_INTERVAL_HOURS=168; }; '
                              'load_system_auto_last_run() { SYSTEM_AUTO_LAST_RUN_EPOCH=1000000000; }; '
                              'system_auto_due && echo due'), "due")

    def test_daily_wake_cannot_run_weekly_backup_early(self):
        self.assertEqual(bash('load_system_auto_state() { SYSTEM_AUTO_ENABLED=1; '
                              'SYSTEM_AUTO_ANCHOR_EPOCH=1000000000; SYSTEM_AUTO_INTERVAL_HOURS=168; }; '
                              'load_system_auto_last_run() { SYSTEM_AUTO_LAST_RUN_EPOCH=1000000000; }; '
                              'date() { echo 1000086400; }; '
                              'if system_auto_due; then echo early; else echo skipped; fi'), "skipped")

    def test_disabled_schedule_never_runs(self):
        self.assertEqual(bash('load_system_auto_state() { SYSTEM_AUTO_ENABLED=0; }; '
                              'if system_auto_due; then echo run; else echo skipped; fi'), "skipped")

    def test_daily_keeps_local_clock_across_dst(self):
        self.assertEqual(bash('a=$(date -d "2026-10-31 04:30" +%s); '
                              'n=$(system_auto_next_epoch "$a" "$a" 24); '
                              'date -d "@$n" +%FT%R; echo $((n-a))',
                              "America/New_York"), "2026-11-01T04:30\n90000")

    def test_daily_spring_forward_keeps_clock_and_skips_nonexistent_time(self):
        self.assertEqual(bash('a=$(date -d "2026-03-07 04:30" +%s); '
                              'n=$(system_auto_next_epoch "$a" "$a" 24); '
                              'date -d "@$n" +%FT%R; echo $((n-a))',
                              "America/New_York"), "2026-03-08T04:30\n82800")
        self.assertEqual(bash('a=$(date -d "2026-03-07 02:30" +%s); '
                              'date -d "@$(system_auto_next_epoch "$a" "$a" 24)" +%FT%R',
                              "America/New_York"), "2026-03-09T02:30")

    def test_normalizing_date_versions_cannot_shift_backup_clock(self):
        self.assertEqual(bash('date() { '
                              'if [ "${1:-}" = -d ] && [ "${2:-}" = "2026-03-08 02:30" ]; then '
                              'command date -d "2026-03-08 03:30" +%s; '
                              'else command date "$@"; fi; }; '
                              'a=$(date -d "2026-03-07 02:30" +%s); '
                              'date -d "@$(system_auto_next_epoch "$a" "$a" 24)" +%FT%R',
                              "America/New_York"), "2026-03-09T02:30")

    def test_timer_condition_guards_hourly_wake(self):
        timer = bash('SYSTEM_AUTO_UNIT=dune-test; system_auto_timer_text 22:15 168')
        self.assertIn("OnCalendar=*-*-* *:15:00", timer)
        self.assertNotIn("OnUnitActiveSec", timer)
        daily = bash('SYSTEM_AUTO_UNIT=dune-test; system_auto_timer_text 22:15 24')
        self.assertIn("OnCalendar=*-*-* 22:15:00", daily)
        service = bash('system_auto_service_text image /srv/dune 1000 1000 988 test-image')
        self.assertIn("ExecCondition=/usr/bin/env bash /srv/dune/runtime/scripts/db.sh auto-system due", service)


if __name__ == "__main__":
    unittest.main()
