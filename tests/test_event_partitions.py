#!/usr/bin/env python3
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("events", ROOT / "runtime/scripts/supplement-event-partitions.py")
events = importlib.util.module_from_spec(spec)
spec.loader.exec_module(events)


class EventPartitionsTest(unittest.TestCase):
    def setUp(self):
        self.rows = [{"map": "CB_Overland_M_01", "id": 24, "dimension": 0}]

    def test_present_assets_add_one_sequence_allocated_partition(self):
        with patch.object(events.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as run:
            rows = events.supplement(self.rows, "example/server:current")
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0], self.rows[0])
        self.assertEqual(rows[1], {
            "map": events.EVENT_MAP, "id": None, "dimension": 0, "disable": False,
            "minX": 0, "minY": 0, "maxX": 1, "maxY": 1,
        })
        args = run.call_args.args[0]
        for flag in ("--rm", "--pull=never", "--network=none", "--read-only", "--cap-drop=ALL", "--user=dune"):
            self.assertIn(flag, args)
        self.assertIn("example/server:current", args)
        with patch.object(events.subprocess, "run") as run:
            self.assertEqual(events.supplement(rows, "image"), rows)
            run.assert_not_called()

    def test_native_entry_wins_including_disabled_and_other_dimensions(self):
        for dimension in (0, 2):
            rows = self.rows + [{"map": events.EVENT_MAP.lower(), "id": 99,
                                 "dimension": dimension, "disable": True, "minX": -5}]
            with patch.object(events.subprocess, "run") as run:
                self.assertEqual(events.supplement(rows, "image"), rows)
                run.assert_not_called()

    def test_missing_assets_skip_fallback(self):
        with patch.object(events.subprocess, "run", return_value=subprocess.CompletedProcess([], 1)):
            self.assertEqual(events.supplement(self.rows, "image"), self.rows)

    def test_inspection_failure_does_not_silently_publish_missing_map(self):
        for code in (2, 125, 127):
            with patch.object(events.subprocess, "run", return_value=subprocess.CompletedProcess([], code)):
                with self.assertRaises(RuntimeError):
                    events.supplement(self.rows, "image")
        with patch.object(events.subprocess, "run", side_effect=subprocess.TimeoutExpired("docker", 60)):
            with self.assertRaises(subprocess.TimeoutExpired):
                events.supplement(self.rows, "image")

    def test_empty_or_invalid_catalog_cannot_be_replaced_by_event_only(self):
        for rows in ([], {}, None):
            with self.assertRaises(ValueError):
                events.supplement(rows, "image")

    def test_real_archive_guard_and_absent_index(self):
        # Execute the actual probe shell against a tiny local archive fixture.
        with patch.object(events.subprocess, "run", return_value=subprocess.CompletedProcess([], 1)) as run:
            events.supplement(self.rows, "image")
        script = run.call_args.args[0][-1]
        with tempfile.TemporaryDirectory() as tmp:
            index = Path(tmp) / "map.utoc"
            script = script.replace("/home/dune/server/DuneSandbox/Content/Paks/pakchunk170-LinuxServer.utoc", str(index))
            for data, expected in ((None, 1), (b"unrelated.umap\x00", 1),
                                   (b"\x00CB_Halloween_Event_Shipwreck_01.umap\x00", 0)):
                if data is not None:
                    index.write_bytes(data)
                self.assertEqual(subprocess.run(["sh", "-c", script]).returncode, expected)

    def test_extractor_publishes_supplement_atomically(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            scripts = root / "runtime/scripts"
            scripts.mkdir(parents=True)
            generated = root / "runtime/generated"
            generated.mkdir()
            for name in ("extract-partition-catalog.sh", "supplement-event-partitions.py", "image-tags.sh"):
                shutil.copy(ROOT / "runtime/scripts" / name, scripts / name)
            (scripts / "runtime-env.sh").write_text(
                'DUNE_COMPOSE_PROJECT_NAME=test\nresolve_server_region() { echo Test; }\n'
                'resolve_server_ip() { echo 127.0.0.1; }\n'
                'dune_compose_running_service_container() { echo test-orchestrator; }\n')
            binary = root / "bin"
            binary.mkdir()
            docker = binary / "docker"
            docker.write_text('#!/bin/sh\ncase "$1" in\n'
                              'exec) cat >/dev/null; cat "$FIXTURE";;\n'
                              'run) exit "$PROBE_RESULT";;\n'
                              '*) exit 99;;\nesac\n')
            docker.chmod(0o755)
            fixture = root / "fixture.json"
            fixture.write_text(json.dumps(self.rows))
            catalog = generated / "partition-catalog.json"
            env = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ["PATH"],
                       FIXTURE=str(fixture), DUNE_GAME_SERVER_IMAGE="test-image", PROBE_RESULT="0")
            result = subprocess.run(["bash", str(scripts / "extract-partition-catalog.sh")],
                                    env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            published = catalog.read_bytes()
            self.assertEqual(json.loads(published)[-1]["map"], events.EVENT_MAP)
            env["PROBE_RESULT"] = "125"
            result = subprocess.run(["bash", str(scripts / "extract-partition-catalog.sh")],
                                    env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(catalog.read_bytes(), published)
            self.assertEqual(list(generated.glob("*.tmp.*")), [])


if __name__ == "__main__":
    unittest.main()
