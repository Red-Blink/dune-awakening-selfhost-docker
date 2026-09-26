#!/usr/bin/env python3
"""Regression coverage for the "Spice Fields" category exposed by
usersettings.py's `metadata` command (the real JSON payload the console
frontend's Custom Settings -> Spice Fields section consumes).

The category name is a hardcoded string literal duplicated independently in
two places -- ENGINE_FIELD_CATEGORIES here, and MapsPanel.tsx's own filter
(`field.category === "Spice Fields"`) -- with no shared constant between the
Python schema and the TypeScript frontend. If they ever drift (a typo, a
rename on one side only), the frontend section silently renders empty
(filtered to zero fields) rather than erroring, so this failure mode
produces no visible error anywhere. This test closes the Python-side half of
that gap: it invokes the real `metadata` CLI command (not a reimplementation
of its logic) and asserts the 9 known SpiceHarvestingSystem fields are both
present under the "game" scope and tagged with the exact category string the
frontend filters on.

Run directly:
    python3 runtime/scripts/test_spicefield_settings_schema.py
"""
from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "usersettings.py"

# Must match MapsPanel.tsx's own filter literal exactly:
#   const spiceFieldSettings = (schema?.game || []).filter((field) => field.category === "Spice Fields");
EXPECTED_CATEGORY = "Spice Fields"

EXPECTED_FIELD_IDS = {
    "spice_spawning_active",
    "spice_prime_rate_seconds",
    "spice_manager_tick_rate_seconds",
    "spice_manager_refresh_rate_seconds",
    "spice_global_manager_refresh_rate_seconds",
    "spice_player_must_witness_bloom",
    "spice_bloom_long_range_replication",
    "spice_field_long_range_replication",
    "spice_node_value_to_resource_ratio",
}


class SpiceFieldSchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "metadata"],
            capture_output=True,
            text=True,
            check=True,
        )
        cls.schema = json.loads(result.stdout)

    def test_all_nine_spice_fields_present_in_game_scope(self):
        game_field_ids = {field["id"] for field in self.schema["game"]}
        missing = EXPECTED_FIELD_IDS - game_field_ids
        self.assertFalse(missing, f"expected these spice fields under scope 'game', not found: {missing}")

    def test_all_nine_spice_fields_carry_the_exact_frontend_category_string(self):
        by_id = {field["id"]: field for field in self.schema["game"]}
        wrong_category = {
            field_id: by_id[field_id]["category"]
            for field_id in EXPECTED_FIELD_IDS
            if field_id in by_id and by_id[field_id]["category"] != EXPECTED_CATEGORY
        }
        self.assertFalse(
            wrong_category,
            "these spice fields have a category that doesn't match MapsPanel.tsx's "
            f"filter literal {EXPECTED_CATEGORY!r} -- the frontend section would "
            f"silently render empty for them: {wrong_category}",
        )

    def test_no_other_game_scope_field_accidentally_carries_the_spice_category(self):
        # Guards the inverse drift direction: a copy/paste error that tags an
        # unrelated field as "Spice Fields" would make it wrongly appear in
        # the dedicated section (and, since userGameFields excludes this
        # category, silently disappear from the plain UserGame tab too).
        mistagged = [
            field["id"] for field in self.schema["game"]
            if field["category"] == EXPECTED_CATEGORY and field["id"] not in EXPECTED_FIELD_IDS
        ]
        self.assertFalse(mistagged, f"unexpected field(s) tagged {EXPECTED_CATEGORY!r}: {mistagged}")

    def test_spawning_active_description_warns_that_the_setting_is_unreliable(self):
        by_id = {field["id"]: field for field in self.schema["game"]}
        description = by_id["spice_spawning_active"]["description"].lower()
        self.assertIn("did not reliably stop", description)
        self.assertIn("do not rely", description)


if __name__ == "__main__":
    unittest.main()
