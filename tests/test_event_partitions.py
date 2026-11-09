#!/usr/bin/env python3
"""Seasonal map retirement follows upstream without touching existing worlds."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
EVENT_MAP = "CB_Halloween_Event_Shipwreck_01"


class EventPartitionsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        scripts = self.root / "runtime/scripts"
        scripts.mkdir(parents=True)
        generated = self.root / "runtime/generated"
        generated.mkdir()
        for name in ("extract-partition-catalog.sh", "image-tags.sh"):
            shutil.copy(ROOT / "runtime/scripts" / name, scripts / name)
        (scripts / "runtime-env.sh").write_text(
            'DUNE_COMPOSE_PROJECT_NAME=test\nresolve_server_region() { echo Test; }\n'
            'resolve_server_ip() { echo 127.0.0.1; }\n'
            'dune_compose_running_service_container() { echo test-orchestrator; }\n')
        binary = self.root / "bin"
        binary.mkdir()
        docker = binary / "docker"
        docker.write_text('#!/bin/sh\nprintf "%s\\n" "$1" >> "$CALLS"\n'
                          'case "$1" in\nexec) cat >/dev/null; cat "$FIXTURE"; exit "$EXTRACT_RESULT";;\n'
                          '*) exit 99;;\nesac\n')
        docker.chmod(0o755)
        self.fixture = self.root / "fixture.json"
        self.catalog = generated / "partition-catalog.json"
        self.calls = self.root / "calls"
        self.env = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ["PATH"],
                        FIXTURE=str(self.fixture), CALLS=str(self.calls), EXTRACT_RESULT="0")

    def extract(self, rows, code=0):
        self.fixture.write_text(json.dumps(rows))
        self.env["EXTRACT_RESULT"] = str(code)
        return subprocess.run(["bash", "runtime/scripts/extract-partition-catalog.sh"],
                              cwd=self.root, env=self.env, capture_output=True, text=True)

    def test_absent_seasonal_map_is_not_reintroduced_or_probed(self):
        rows = [{"map": "Survival_1", "id": 1, "dimension": 0}]
        result = self.extract(rows)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.catalog.read_text()), rows)
        self.assertEqual(self.calls.read_text().splitlines(), ["exec"])

    def test_upstream_event_definitions_are_preserved(self):
        for dimension, disabled in ((0, False), (2, True)):
            rows = [{"map": EVENT_MAP, "id": 41, "dimension": dimension, "disable": disabled}]
            result = self.extract(rows)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(self.catalog.read_text()), rows)

    def test_bad_or_failed_extraction_preserves_existing_catalog(self):
        original = b'[{"map":"existing-world","id":41}]\n'
        for rows, code in (([], 0), ({}, 0), (None, 0), ([{"map": "Survival_1"}], 1)):
            self.catalog.write_bytes(original)
            result = self.extract(rows, code)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(self.catalog.read_bytes(), original)
            self.assertEqual(list(self.catalog.parent.glob("*.tmp.*")), [])


if __name__ == "__main__":
    unittest.main()
