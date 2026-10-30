#!/usr/bin/env python3
"""Unit tests for partition_stopgaps.py.

Run directly:
    python3 runtime/scripts/test_partition_stopgaps.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import partition_stopgaps

SCRIPTS = Path(__file__).resolve().parent
HIERONYMUS = "CB_Halloween_Event_Shipwreck_01"
HIERONYMUS_UMAP = "CB_Halloween_Event_Shipwreck_01.umap"


def template_rows() -> list[dict]:
    return [
        {"map": "Survival_1", "id": 1, "dimension": 0, "disable": False, "minX": 0, "minY": 0, "maxX": 1, "maxY": 1},
        {"map": "CB_Overland_M_01", "id": 24, "dimension": 0, "disable": False, "minX": 0, "minY": 0, "maxX": 1, "maxY": 1},
        {"map": "Story_HeighlinerDungeon", "id": 35, "dimension": 0, "disable": False, "minX": 0, "minY": 0, "maxX": 1, "maxY": 1},
    ]


class ApplyStopgapsTests(unittest.TestCase):
    def test_adds_missing_shipped_map_after_highest_template_id(self):
        rows, notes = partition_stopgaps.apply_stopgaps(template_rows(), {HIERONYMUS_UMAP})

        added = [row for row in rows if row["map"] == HIERONYMUS]
        self.assertEqual(len(added), 1)
        self.assertEqual(added[0]["id"], 36)
        self.assertEqual(added[0]["dimension"], 0)
        self.assertFalse(added[0]["disable"])
        self.assertEqual((added[0]["minX"], added[0]["minY"], added[0]["maxX"], added[0]["maxY"]), (0, 0, 1, 1))
        self.assertTrue(added[0]["stopgap"])
        self.assertEqual(rows[:3], template_rows())
        self.assertIn("Added stopgap partition", notes[0])

    def test_retires_once_template_lists_the_map(self):
        listed = template_rows() + [
            {"map": HIERONYMUS.lower(), "id": 36, "dimension": 0, "disable": False, "minX": 0, "minY": 0, "maxX": 1, "maxY": 1},
        ]
        rows, notes = partition_stopgaps.apply_stopgaps(listed, {HIERONYMUS_UMAP})

        self.assertEqual(rows, listed)
        self.assertIn("already lists", notes[0])

    def test_skips_when_game_build_does_not_ship_the_map(self):
        rows, notes = partition_stopgaps.apply_stopgaps(template_rows(), set())

        self.assertEqual(rows, template_rows())
        self.assertIn("does not ship", notes[0])

    def test_every_entry_names_its_own_umap(self):
        for entry in partition_stopgaps.STOPGAP_PARTITIONS:
            self.assertEqual(entry["umap"], entry["map"] + ".umap")


class CliTests(unittest.TestCase):
    def run_cli(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(SCRIPTS / "partition_stopgaps.py"), *args],
            capture_output=True, text=True, check=False,
        )

    def test_umaps_lists_each_stopgap_map_file(self):
        result = self.run_cli("umaps")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.split(), partition_stopgaps.umap_names())

    def test_apply_rewrites_catalog_that_reconcile_accepts(self):
        with tempfile.TemporaryDirectory() as tmp:
            catalog = Path(tmp) / "partition-catalog.json"
            catalog.write_text(json.dumps(template_rows(), indent=2) + "\n")

            result = self.run_cli("apply", str(catalog), HIERONYMUS_UMAP)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(HIERONYMUS, result.stderr)
            self.assertIn(HIERONYMUS, [row["map"] for row in json.loads(catalog.read_text())])

            sql = subprocess.run(
                [sys.executable, str(SCRIPTS / "generate-world-partition-reconcile-sql.py"), str(catalog)],
                capture_output=True, text=True, check=True,
            ).stdout
            self.assertIn(f"lower(map) = lower('{HIERONYMUS}')", sql)
            self.assertIn("partition_id = 36", sql)

    def test_apply_leaves_catalog_untouched_without_shipped_maps(self):
        with tempfile.TemporaryDirectory() as tmp:
            catalog = Path(tmp) / "partition-catalog.json"
            original = json.dumps(template_rows(), indent=2) + "\n"
            catalog.write_text(original)

            result = self.run_cli("apply", str(catalog))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(catalog.read_text(), original)

    def test_apply_rejects_non_array_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            catalog = Path(tmp) / "partition-catalog.json"
            catalog.write_text("{}")
            self.assertEqual(self.run_cli("apply", str(catalog)).returncode, 1)


class ExtractionWiringTests(unittest.TestCase):
    def setUp(self):
        self.script = (SCRIPTS / "extract-partition-catalog.sh").read_text()

    def test_stopgaps_apply_to_temp_catalog_before_it_is_published(self):
        apply_at = self.script.index('partition_stopgaps.py apply "$catalog_tmp"')
        self.assertLess(apply_at, self.script.index('mv -f -- "$catalog_tmp" "$catalog_output"'))
        self.assertGreater(apply_at, self.script.index('Generated partition catalog is empty.'))

    def test_pak_check_never_pulls_the_game_image(self):
        self.assertLess(
            self.script.index('docker image inspect "$game_image"'),
            self.script.index("docker run --rm --network=none --pull=never --entrypoint grep"),
        )

    def test_unreadable_image_skips_stopgaps_instead_of_failing(self):
        self.assertIn('if [ "$pak_rc" -le 1 ]; then', self.script)
        self.assertIn("skipping stopgap partitions", self.script)


if __name__ == "__main__":
    unittest.main()
