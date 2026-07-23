#!/usr/bin/env python3
"""Unit tests for the partition combat-state resolver in usersettings.py.

Run directly:
    python3 runtime/scripts/test_partition_combat_state.py

Or via unittest discovery:
    python3 -m unittest discover -s runtime/scripts -p "test_*.py"
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import usersettings  # noqa: E402


def values(
    force_pvp_all_partitions="False",
    partition_pvp_enabled="False",
    partition_pve_enabled="False",
    legacy_pvp_enabled="False",
    server_pve="True",
    security_zones_enabled="True",
):
    return {
        "force_pvp_all_partitions": force_pvp_all_partitions,
        "partition_pvp_enabled": partition_pvp_enabled,
        "partition_pve_enabled": partition_pve_enabled,
        "legacy_pvp_enabled": legacy_pvp_enabled,
        "server_pve": server_pve,
        "security_zones_enabled": security_zones_enabled,
    }


class BoolNormalizationTests(unittest.TestCase):
    def test_recognizes_true_variants(self):
        for text in ("1", "true", "True", " TRUE ", "yes", "Yes", "on", "ON"):
            self.assertTrue(usersettings.bool_or_none(text), msg=text)

    def test_recognizes_false_variants(self):
        for text in ("0", "false", "False", " FALSE ", "no", "No", "off", "OFF"):
            self.assertFalse(usersettings.bool_or_none(text), msg=text)

    def test_unknown_and_missing_values_are_none(self):
        for text in (None, "", "  ", "maybe", "null", "unset"):
            self.assertIsNone(usersettings.bool_or_none(text), msg=repr(text))


class PartitionResolverPrecedenceTests(unittest.TestCase):
    def test_partition_pvp_true_pve_false_is_pvp(self):
        result = usersettings.resolve_partition_combat_state(
            values(partition_pvp_enabled="True", partition_pve_enabled="False")
        )
        self.assertEqual(result["state"], "PVP")
        self.assertEqual(result["source"], "partition-pvp-selector")

    def test_partition_pvp_false_pve_true_is_pve(self):
        result = usersettings.resolve_partition_combat_state(
            values(partition_pvp_enabled="False", partition_pve_enabled="True")
        )
        self.assertEqual(result["state"], "PVE")
        self.assertEqual(result["source"], "partition-pve-selector")

    def test_partition_pvp_true_and_pve_true_is_conflict(self):
        result = usersettings.resolve_partition_combat_state(
            values(partition_pvp_enabled="True", partition_pve_enabled="True")
        )
        self.assertEqual(result["state"], "CONFLICT")
        self.assertEqual(result["source"], "partition-selectors")
        self.assertIn(
            "Partition is explicitly included in both PvP and PvE selectors.",
            result["warnings"],
        )

    def test_force_all_pvp_conflicts_with_partition_pve(self):
        result = usersettings.resolve_partition_combat_state(
            values(force_pvp_all_partitions="True", partition_pve_enabled="True")
        )
        self.assertEqual(result["state"], "CONFLICT")
        self.assertEqual(result["source"], "force-all-vs-partition")
        self.assertIn(
            "Global force-PvP conflicts with the partition PvE selector.",
            result["warnings"],
        )

    def test_force_all_pvp_true_no_pve_conflict_is_pvp(self):
        result = usersettings.resolve_partition_combat_state(
            values(force_pvp_all_partitions="True")
        )
        self.assertEqual(result["state"], "PVP")
        self.assertEqual(result["source"], "force-pvp-all-partitions")

    def test_legacy_pvp_true_server_pve_false_is_pvp(self):
        result = usersettings.resolve_partition_combat_state(
            values(legacy_pvp_enabled="True", server_pve="False")
        )
        self.assertEqual(result["state"], "PVP")
        self.assertEqual(result["source"], "legacy-flags")

    def test_legacy_pvp_false_server_pve_true_is_pve(self):
        result = usersettings.resolve_partition_combat_state(
            values(legacy_pvp_enabled="False", server_pve="True")
        )
        self.assertEqual(result["state"], "PVE")
        self.assertEqual(result["source"], "legacy-flags")

    def test_unresolved_configuration_is_unknown(self):
        result = usersettings.resolve_partition_combat_state(
            values(legacy_pvp_enabled="maybe", server_pve="unset")
        )
        self.assertEqual(result["state"], "UNKNOWN")
        self.assertEqual(result["source"], "unresolved")
        self.assertIn("legacy_pvp_enabled", result["unresolvedFields"])
        self.assertIn("server_pve", result["unresolvedFields"])

    def test_unresolved_does_not_default_to_pve(self):
        # legacy_pvp_enabled unresolved, server_pve True alone must NOT
        # resolve to PVE — both legacy fields must be determinable.
        result = usersettings.resolve_partition_combat_state(
            values(legacy_pvp_enabled="maybe", server_pve="True")
        )
        self.assertEqual(result["state"], "UNKNOWN")

    def test_security_zones_disabled_adds_warning_without_changing_state(self):
        result = usersettings.resolve_partition_combat_state(
            values(partition_pvp_enabled="True", security_zones_enabled="False")
        )
        self.assertEqual(result["state"], "PVP")
        self.assertFalse(result["securityZonesEnabled"])
        self.assertIn(
            "Security zones are disabled; PvP and abilities may be available everywhere.",
            result["warnings"],
        )

    def test_explicit_partition_selector_overrides_legacy_flags(self):
        # partition_pve_enabled=True should win even though legacy flags
        # would otherwise resolve to PVP.
        result = usersettings.resolve_partition_combat_state(
            values(
                partition_pve_enabled="True",
                legacy_pvp_enabled="True",
                server_pve="False",
            )
        )
        self.assertEqual(result["state"], "PVE")
        self.assertEqual(result["source"], "partition-pve-selector")

    def test_boolean_normalization_case_insensitive_with_whitespace(self):
        result = usersettings.resolve_partition_combat_state(
            values(partition_pvp_enabled="  TRUE  ", partition_pve_enabled="No")
        )
        self.assertEqual(result["state"], "PVP")


class MapAggregationTests(unittest.TestCase):
    def test_all_pvp_is_pvp(self):
        self.assertEqual(usersettings.aggregate_map_combat_state(["PVP", "PVP"]), "PVP")

    def test_all_pve_is_pve(self):
        self.assertEqual(usersettings.aggregate_map_combat_state(["PVE", "PVE"]), "PVE")

    def test_mixed_pvp_and_pve_is_mixed(self):
        self.assertEqual(usersettings.aggregate_map_combat_state(["PVP", "PVE"]), "MIXED")

    def test_any_conflict_forces_conflict(self):
        self.assertEqual(usersettings.aggregate_map_combat_state(["PVP", "CONFLICT"]), "CONFLICT")
        self.assertEqual(usersettings.aggregate_map_combat_state(["CONFLICT"]), "CONFLICT")

    def test_no_partitions_is_unknown(self):
        self.assertEqual(usersettings.aggregate_map_combat_state([]), "UNKNOWN")

    def test_all_unknown_is_unknown(self):
        self.assertEqual(usersettings.aggregate_map_combat_state(["UNKNOWN", "UNKNOWN"]), "UNKNOWN")

    def test_unknown_mixed_with_determinable_does_not_force_unknown(self):
        # One PVP + one UNKNOWN partition should still register as PVP,
        # since UNKNOWN partitions abstain from the vote rather than
        # forcing ambiguity onto the whole map.
        self.assertEqual(usersettings.aggregate_map_combat_state(["PVP", "UNKNOWN"]), "PVP")


class MetadataIndependenceTests(unittest.TestCase):
    """Confirm the resolver never reads dimension index, labels, display
    names, service/container names, or lifecycle mode — only the six
    UserGame.ini-derived fields matter."""

    def test_identical_config_different_metadata_yields_identical_state(self):
        base = values(partition_pvp_enabled="True", partition_pve_enabled="False")
        result_a = usersettings.resolve_partition_combat_state(base)
        result_b = usersettings.resolve_partition_combat_state(
            {**base, "dimension_index": 1, "label": "PvE", "display_name": "Sietch Abbir"}
        )
        self.assertEqual(result_a["state"], result_b["state"])
        self.assertEqual(result_a["source"], result_b["source"])

    def test_dimension_zero_is_not_assumed_pvp(self):
        # A dimension-0 partition configured for PVE must resolve to PVE,
        # not PVP, proving dimension index plays no role.
        result = usersettings.resolve_partition_combat_state(
            {
                **values(partition_pvp_enabled="False", partition_pve_enabled="True"),
                "dimension_index": 0,
            }
        )
        self.assertEqual(result["state"], "PVE")


if __name__ == "__main__":
    unittest.main()
