#!/usr/bin/env python3
"""Unit tests for the Global -> Map -> Partition (UserGame) and
Global -> Map -> Partition (UserEngine, internally Engine -> MapEngine ->
PartitionEngine) override-precedence chains in usersettings.py.

Each tier's merge function only overlays a value when that tier actually has
one stored -- an unset tier must fall through to the next broader tier's
value (or the schema default if nothing is set anywhere). These tests pin
that behavior down directly against the merge functions
(profile_global_values/profile_map_values/profile_partition_values and
profile_engine_values/profile_map_engine_values/profile_partition_engine_values),
then confirm the same precedence survives into the actually-deployed
compiled_usergame_ini()/compiled_userengine_ini() output.

Before this file, override precedence was only exercised by
profile_selftest() -- a manual CLI self-test, not run in CI -- and even
that only covered Global->Map for UserGame and both UserEngine hops; a
UserGame Partition override winning over a Map override was never verified
anywhere.

Run directly:
    python3 runtime/scripts/test_profile_override_precedence.py

Or via unittest discovery:
    python3 -m unittest discover -s runtime/scripts -p "test_*.py"
"""
from __future__ import annotations

import io
import json
import sys
import unittest
from base64 import b64encode
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import usersettings  # noqa: E402

MAP_NAME = "Survival_1"
PARTITION_ID = "3"
OTHER_PARTITION_ID = "7"


def _encode_bulk_save_payload(values: dict) -> str:
    return b64encode(json.dumps(values).encode("utf-8")).decode("ascii")


class ProfilePathTestCase(unittest.TestCase):
    """Shared PROFILE_PATH redirection so these tests never touch
    runtime/generated/gameplay-profile.ini, regardless of where this file is
    run from -- matching ProfileEngineTextTests in
    test_userengine_ini_comments.py. Only usersettings.write_profile() /
    read_profile() consult PROFILE_PATH; the merge functions used below take
    a profile dict directly and need no redirection, but write_profile() is
    used to prove a real save/reload round trip preserves precedence too."""

    def setUp(self):
        import tempfile
        self._tmpdir = tempfile.TemporaryDirectory()
        self._original_path = usersettings.PROFILE_PATH
        usersettings.PROFILE_PATH = Path(self._tmpdir.name) / "gameplay-profile.ini"

    def tearDown(self):
        usersettings.PROFILE_PATH = self._original_path
        self._tmpdir.cleanup()


class GameFieldOverridePrecedenceTests(ProfilePathTestCase):
    """UserGame.ini's Global -> Map -> Partition chain."""

    FIELD_ID = "default_reconnect_grace_period_seconds"

    def _spec(self):
        return usersettings.MAP_FIELDS[self.FIELD_ID]

    def test_unset_field_falls_through_to_schema_default_at_every_tier(self):
        _section, _key, default = self._spec()
        profile = usersettings.empty_profile()
        self.assertEqual(usersettings.profile_global_values(profile)[self.FIELD_ID], default)
        self.assertEqual(usersettings.profile_map_values(profile, MAP_NAME)[self.FIELD_ID], default)
        self.assertEqual(usersettings.profile_partition_values(profile, MAP_NAME, PARTITION_ID)[self.FIELD_ID], default)

    def test_map_overrides_global_but_not_a_different_map(self):
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "global", section, key, "2.0")
        self.assertEqual(usersettings.profile_map_values(profile, MAP_NAME)[self.FIELD_ID], "2.0")

        usersettings.profile_set_key(profile, "map", section, key, "3.0", MAP_NAME)
        self.assertEqual(usersettings.profile_map_values(profile, MAP_NAME)[self.FIELD_ID], "3.0")
        # A sibling map with no override of its own still sees the Global value.
        self.assertEqual(usersettings.profile_map_values(profile, "Survival_2")[self.FIELD_ID], "2.0")
        self.assertEqual(usersettings.profile_global_values(profile)[self.FIELD_ID], "2.0")

    def test_partition_overrides_map_but_not_a_sibling_partition(self):
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "global", section, key, "2.0")
        usersettings.profile_set_key(profile, "map", section, key, "3.0", MAP_NAME)

        # Before any Partition override, both partitions inherit the Map value.
        self.assertEqual(usersettings.profile_partition_values(profile, MAP_NAME, PARTITION_ID)[self.FIELD_ID], "3.0")
        self.assertEqual(usersettings.profile_partition_values(profile, MAP_NAME, OTHER_PARTITION_ID)[self.FIELD_ID], "3.0")

        usersettings.profile_set_key(profile, "partition", section, key, "4.0", MAP_NAME, PARTITION_ID)
        self.assertEqual(usersettings.profile_partition_values(profile, MAP_NAME, PARTITION_ID)[self.FIELD_ID], "4.0")
        # The sibling partition and the map itself are unaffected.
        self.assertEqual(usersettings.profile_partition_values(profile, MAP_NAME, OTHER_PARTITION_ID)[self.FIELD_ID], "3.0")
        self.assertEqual(usersettings.profile_map_values(profile, MAP_NAME)[self.FIELD_ID], "3.0")

    def test_compiled_ini_reflects_the_winning_tier_at_each_level(self):
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "global", section, key, "2.0")
        usersettings.profile_set_key(profile, "map", section, key, "3.0", MAP_NAME)
        usersettings.profile_set_key(profile, "partition", section, key, "4.0", MAP_NAME, PARTITION_ID)

        compiled_map_only = usersettings.compiled_usergame_ini(profile, MAP_NAME)
        self.assertIn(f"{key}=3.0", compiled_map_only)
        self.assertNotIn(f"{key}=2.0", compiled_map_only)
        self.assertNotIn(f"{key}=4.0", compiled_map_only)

        compiled_partition = usersettings.compiled_usergame_ini(profile, MAP_NAME, PARTITION_ID)
        self.assertIn(f"{key}=4.0", compiled_partition)
        self.assertNotIn(f"{key}=3.0", compiled_partition)

        compiled_sibling_partition = usersettings.compiled_usergame_ini(profile, MAP_NAME, OTHER_PARTITION_ID)
        self.assertIn(f"{key}=3.0", compiled_sibling_partition)
        self.assertNotIn(f"{key}=4.0", compiled_sibling_partition)


class RetiredModifierAndCoriolisMetadataTests(ProfilePathTestCase):
    RETIRED_IDS = {
        "global_xp_multiplier",
        "global_fame_multiplier",
        "global_progression_speed_multiplier",
        "global_harvest_health_multiplier",
        "cutteray_hem_multiplier_per_node_tier_table",
        "global_damage_to_npcs_multiplier",
    }

    def test_retired_controls_are_absent_from_schema_and_generated_ini(self):
        self.assertTrue(self.RETIRED_IDS.isdisjoint(usersettings.MAP_FIELDS))
        profile = usersettings.parse_profile_text(
            "[Global:/Script/DuneSandbox.DuneGameMode]\n"
            "m_GlobalXPMultiplier=100.0\n"
            "m_GlobalDamageToNpcsMultiplier=1000.0\n"
            "UnknownCommunitySetting=keep\n"
        )
        compiled = usersettings.compiled_usergame_ini(profile, MAP_NAME)
        client = usersettings.client_game_ini(profile, MAP_NAME)
        for retired in ("m_GlobalXPMultiplier", "m_GlobalDamageToNpcsMultiplier"):
            self.assertNotIn(retired, compiled)
            self.assertNotIn(retired, client)
        self.assertIn("UnknownCommunitySetting=keep", compiled)
        self.assertNotIn("UnknownCommunitySetting=keep", client)

    def test_saving_profile_removes_only_retired_keys(self):
        profile = usersettings.parse_profile_text(
            "[Global:/Script/DuneSandbox.DuneGameMode]\n"
            "m_GlobalFameMultiplier=3.0\n"
            "m_DefaultReconnectGracePeriodSeconds=600\n"
        )
        usersettings.write_profile(profile)
        saved = usersettings.PROFILE_PATH.read_text(encoding="utf-8")
        self.assertNotIn("m_GlobalFameMultiplier", saved)
        self.assertIn("m_DefaultReconnectGracePeriodSeconds=600", saved)

    def test_coriolis_restart_metadata_names_its_map_process_scope(self):
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(usersettings.metadata(), 0)
        payload = json.loads(output.getvalue())
        field = next(row for row in payload["game"] if row["id"] == "restart_server_on_coriolis_cycle_end")
        self.assertEqual(field["label"], "Restart Game Farm At Coriolis Cycle End")
        self.assertIn("all processes load the same new cycle seed", field["description"])
        self.assertIn("PostgreSQL", field["description"])

    def test_coriolis_cycle_start_fields_are_exposed_with_bounds_and_context(self):
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(usersettings.metadata(), 0)
        payload = json.loads(output.getvalue())
        fields = {row["id"]: row for row in payload["game"]}
        expected = {
            "coriolis_cycle_start_year": ("m_CycleStartYear", "2024", 1, 9999),
            "coriolis_cycle_start_month": ("m_CycleStartMonth", "12", 1, 12),
            "coriolis_cycle_start_day": ("m_CycleStartDay", "3", 1, 7),
            "coriolis_cycle_start_hour": ("m_CycleStartHour", "5", 0, 23),
            "coriolis_cycle_start_minute": ("m_CycleStartMinute", "0", 0, 59),
        }
        for field_id, (key, default, minimum, maximum) in expected.items():
            with self.subTest(field_id=field_id):
                field = fields[field_id]
                self.assertEqual(field["section"], usersettings.CORIOLIS_SUBSYSTEM_SECTION)
                self.assertEqual(field["key"], key)
                self.assertEqual(field["default"], default)
                self.assertEqual(field["type"], "integer")
                self.assertEqual(field["minimum"], minimum)
                self.assertEqual(field["maximum"], maximum)
        self.assertIn("1=Sunday", fields["coriolis_cycle_start_day"]["description"])
        self.assertIn("UTC hour", fields["coriolis_cycle_start_hour"]["description"])
        self.assertEqual(fields["coriolis_cycle_start_seed_index"]["key"], "m_CycleStartSeedIndex")
        self.assertEqual(fields["coriolis_cycle_start_seed_index"]["type"], "integer")

    def test_coriolis_region_hours_match_field_description(self):
        # CORIOLIS_REGION_HOURS is the authoritative table (used by
        # migrate_coriolis_region_hour); the field's own description is the text an
        # admin actually reads. Parse the description independently of the dict's own
        # construction, so a typo in either place is a real test failure instead of the
        # same mistake checking itself.
        description = usersettings.FIELD_DESCRIPTIONS["coriolis_cycle_start_hour"]
        segment = description.split(":", 1)[1].strip().rstrip(".")
        described = {}
        for chunk in segment.split(","):
            chunk = chunk.strip()
            if chunk.startswith("and "):
                chunk = chunk[4:]
            region, hour = chunk.rsplit(" ", 1)
            described[region] = int(hour)
        self.assertEqual(described, usersettings.CORIOLIS_REGION_HOURS)

    def test_coriolis_region_hours_match_the_console_frontend_table(self):
        # console/web/src/features/maps/MapsPanel.tsx keeps its own copy (documented as
        # such at CORIOLIS_REGION_HOURS's definition here) because the toggle's
        # inference renders without a round trip; only the migration write is
        # server-side. Parse the frontend's literal object directly so the two tables
        # cannot drift without a test noticing.
        import re
        frontend_path = Path(__file__).resolve().parents[2] / "console" / "web" / "src" / "features" / "maps" / "MapsPanel.tsx"
        text = frontend_path.read_text(encoding="utf-8")
        match = re.search(r"CORIOLIS_REGION_HOURS: Record<string, number> = \{(.*?)\};", text, re.DOTALL)
        self.assertIsNotNone(match, "CORIOLIS_REGION_HOURS literal not found in MapsPanel.tsx -- update this test's pattern if it was reshaped")
        frontend_table = {region: int(hour) for region, hour in re.findall(r'"([^"]+)":\s*(\d+)', match.group(1))}
        self.assertEqual(frontend_table, usersettings.CORIOLIS_REGION_HOURS)

    def test_coriolis_cycle_start_components_are_validated(self):
        profile = usersettings.empty_profile()
        for field_id, value in (
            ("coriolis_cycle_start_year", "0"),
            ("coriolis_cycle_start_month", "13"),
            ("coriolis_cycle_start_day", "8"),
            ("coriolis_cycle_start_hour", "24"),
            ("coriolis_cycle_start_minute", "60"),
            ("coriolis_cycle_start_minute", "1.5"),
        ):
            with self.subTest(field_id=field_id, value=value), self.assertRaises(SystemExit):
                usersettings.set_profile_field(profile, "global", "", "", field_id, value)

    def test_coriolis_cycle_start_values_compile_into_usergame(self):
        profile = usersettings.empty_profile()
        usersettings.set_profile_field(profile, "global", "", "", "coriolis_cycle_start_hour", "22")
        usersettings.set_profile_field(profile, "global", "", "", "coriolis_cycle_start_minute", "30")
        rendered = usersettings.compiled_usergame_ini(profile, MAP_NAME)
        self.assertIn("m_CycleStartHour=22", rendered)
        self.assertIn("m_CycleStartMinute=30", rendered)

    def test_landsraad_coriolis_offset_is_exposed_and_kept_on_one_data_line(self):
        field = usersettings.LANDSRAAD_DATA_FIELDS["landsraad_voting_start_before_coriolis_seconds"]
        self.assertEqual(field[:2], ("m_VotingPeriodStartBeforeCoriolisCycleInSec", "118800"))
        self.assertIn("m_VotingPeriodStartBeforeCoriolisCycleInSec=118800", usersettings.LANDSRAAD_DATA_TEMPLATE)

        profile = usersettings.empty_profile()
        usersettings.set_profile_field(
            profile,
            "global",
            "",
            "",
            "landsraad_voting_start_before_coriolis_seconds",
            "122400",
        )
        rendered = usersettings.compiled_usergame_ini(profile, MAP_NAME)
        data_lines = [line for line in rendered.splitlines() if line.startswith("Data=(")]
        self.assertEqual(len(data_lines), 1)
        self.assertIn("m_VotingPeriodStartBeforeCoriolisCycleInSec=122400", data_lines[0])

    def test_legacy_dunegamemode_cycle_and_wipe_fields_are_hidden_behind_coriolis(self):
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(usersettings.metadata(), 0)
        payload = json.loads(output.getvalue())
        ids = {row["id"] for row in payload["game"]}
        self.assertNotIn("cycle_duration_in_days", ids)
        self.assertNotIn("db_wipe_enabled", ids)
        fields = {row["id"]: row for row in payload["game"]}
        self.assertEqual(fields["coriolis_cycle_duration_days"]["label"], "Cycle Duration Days")
        self.assertEqual(fields["coriolis_db_wipe_enabled"]["label"], "Db Wipe Enabled")

    def test_saving_the_canonical_coriolis_field_compiles_into_both_sections(self):
        # cycle_duration_in_days (legacy DuneGameMode) is hidden from the editor,
        # but compiled_usergame_ini still writes it alongside the canonical
        # CoriolisSubsystem key -- via sync_legacy_values() backfilling
        # profile_map_values(), not by mirroring the raw saved profile -- so any
        # code path still reading the legacy key keeps seeing the new value.
        profile = usersettings.empty_profile()
        usersettings.set_profile_field(profile, "global", "", "", "coriolis_cycle_duration_days", "3")
        rendered = usersettings.compiled_usergame_ini(profile, MAP_NAME)
        self.assertIn(f"[{usersettings.CORIOLIS_SUBSYSTEM_SECTION}]\nm_CycleDurationInDays=3", rendered)
        self.assertIn("[/Script/DuneSandbox.DuneGameMode]\nm_CycleDurationInDays=3", rendered)

    def test_an_existing_legacy_only_value_still_surfaces_through_the_canonical_field(self):
        legacy_section, legacy_key, _default = usersettings.MAP_FIELDS["db_wipe_enabled"]
        profile = usersettings.parse_profile_text(
            f"[Global:{legacy_section}]\n{legacy_key}=False\n"
        )
        values = usersettings.profile_map_values(profile, MAP_NAME)
        self.assertEqual(values["coriolis_db_wipe_enabled"], "False")

    def _assert_explicit_canonical_save_wins_over_stale_legacy(self, legacy_field, canonical_field, stale_legacy_value):
        # Presence, not a value-vs-default comparison, must decide the winner: a stale
        # legacy value must never outrank a canonical value the admin explicitly saved,
        # even when that explicit save happens to equal the canonical schema default --
        # sync_legacy_values() used to read that case as "canonical was never touched"
        # and let the legacy value silently win.
        legacy_section, legacy_key, legacy_default = usersettings.MAP_FIELDS[legacy_field]
        _canonical_section, _canonical_key, canonical_default = usersettings.MAP_FIELDS[canonical_field]
        self.assertNotEqual(stale_legacy_value, legacy_default, "the injected legacy value must be non-default to represent a real explicit legacy override")
        profile = usersettings.parse_profile_text(f"[Global:{legacy_section}]\n{legacy_key}={stale_legacy_value}\n")
        usersettings.set_profile_field(profile, "global", "", "", canonical_field, canonical_default)
        values = usersettings.profile_global_values(profile)
        self.assertEqual(values[canonical_field], canonical_default)
        rendered = usersettings.compiled_usergame_ini(profile, MAP_NAME)
        self.assertNotIn(f"{legacy_key}={stale_legacy_value}", rendered)

    def test_explicit_canonical_save_wins_over_stale_legacy_coriolis_value(self):
        # db_wipe_enabled's canonical default is "True"; give the profile a stale
        # explicit legacy value ("False") and an explicit canonical save that equals
        # the canonical default ("True") -- the exact production shape from the PR
        # review's H5 repro.
        self._assert_explicit_canonical_save_wins_over_stale_legacy("db_wipe_enabled", "coriolis_db_wipe_enabled", "False")

    def test_explicit_canonical_save_wins_over_stale_legacy_guild_value(self):
        # Same bug, pre-existing on the guild aliases before this branch touched them --
        # see the PR callout: a deployment with a stale legacy guild cap silently
        # overriding an explicit canonical save sees its effective cap change once this
        # lands, and that is the intended fix, not a regression.
        self._assert_explicit_canonical_save_wins_over_stale_legacy("max_guild_members_allowed", "guild_settings_max_guild_members_allowed", "20")

    def test_conflicting_legacy_and_canonical_values_both_present_resolve_to_canonical_and_warn(self):
        legacy_section, legacy_key, _legacy_default = usersettings.MAP_FIELDS["cycle_duration_in_days"]
        profile = usersettings.parse_profile_text(f"[Global:{legacy_section}]\n{legacy_key}=3\n")
        usersettings.set_profile_field(profile, "global", "", "", "coriolis_cycle_duration_days", "14")
        values = usersettings.profile_global_values(profile)
        self.assertEqual(values["coriolis_cycle_duration_days"], "14")
        rendered = usersettings.compiled_usergame_ini(profile, MAP_NAME)
        self.assertIn(f"{legacy_key}=14", rendered)
        self.assertNotIn(f"{legacy_key}=3\n", rendered)
        warnings = usersettings.legacy_alias_conflict_warnings(profile, "global")
        self.assertEqual(len(warnings), 1)
        self.assertIn("m_CycleDurationInDays=3", warnings[0])
        self.assertIn("m_CycleDurationInDays=14", warnings[0])
        # Both sides share the same ini key name -- the section is what actually tells an
        # admin which block to go edit; without it "m_CycleDurationInDays=3" vs "=14" reads
        # as two values for the same setting with no way to tell them apart.
        self.assertIn(legacy_section, warnings[0])
        self.assertIn(usersettings.CORIOLIS_SUBSYSTEM_SECTION, warnings[0])

    def test_raw_editor_legacy_conflict_warning_names_both_sections(self):
        # _advanced_editor_legacy_field_warnings is the raw/Advanced-editor counterpart to
        # legacy_alias_conflict_warnings above -- previously only run manually via
        # profile_selftest(), not CI. Both sides share the same ini key name (the whole
        # reason they're aliased), so the section is what actually tells an admin which
        # block to go edit; pin that it's present, not just the key/value pair.
        sections = usersettings.parse_profile_text(
            "[Global:/Script/DuneSandbox.DuneGameMode]\nm_MaxGuildMembersAllowed=5\n"
            "[Global:/Script/DuneSandbox.GuildSettings]\nm_MaxGuildMembersAllowed=32\n"
        ).get("sections", [])
        warnings = usersettings._advanced_editor_legacy_field_warnings(sections)
        self.assertEqual(len(warnings), 1)
        self.assertIn("m_MaxGuildMembersAllowed=5", warnings[0])
        self.assertIn("m_MaxGuildMembersAllowed=32", warnings[0])
        self.assertIn("/Script/DuneSandbox.DuneGameMode", warnings[0])
        self.assertIn("/Script/DuneSandbox.GuildSettings", warnings[0])

    def test_bulk_save_prints_a_warning_for_a_legacy_canonical_conflict(self):
        legacy_section, legacy_key, _legacy_default = usersettings.MAP_FIELDS["cycle_duration_in_days"]
        usersettings.write_profile(usersettings.parse_profile_text(f"[Global:{legacy_section}]\n{legacy_key}=3\n"))
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(usersettings.bulk_save("global", MAP_NAME, "", _encode_bulk_save_payload({"coriolis_cycle_duration_days": "14"})), 0)
        self.assertIn("USERSETTINGS_WARNING:", output.getvalue())
        self.assertIn("m_CycleDurationInDays", output.getvalue())

    def test_bulk_save_prints_no_warning_when_only_the_canonical_field_is_saved(self):
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(usersettings.bulk_save("global", MAP_NAME, "", _encode_bulk_save_payload({"coriolis_cycle_duration_days": "14"})), 0)
        self.assertNotIn("USERSETTINGS_WARNING:", output.getvalue())


class ClientGameIniAllowlistTests(ProfilePathTestCase):
    def test_exports_only_nondefault_client_required_fields(self):
        profile = usersettings.parse_profile_text(
            "[Global:/Script/DuneSandbox.DuneGameMode]\n"
            "m_WaterConsumptionRate=2.0\n"
            "m_DefaultReconnectGracePeriodSeconds=900\n"
            "UnknownCommunitySetting=keep-server-only\n\n"
            f"[Global:{usersettings.LANDSRAAD_SETTINGS_SECTION}]\n"
            f"{usersettings.LANDSRAAD_DATA_KEY}={usersettings.LANDSRAAD_DATA_TEMPLATE}\n\n"
            f"[Global:{usersettings.DEEPDESERT_MATCHMAKER_SECTION}]\n"
            f"+{usersettings.DEEPDESERT_MATCHMAKER_KEY}=2.000000\n\n"
            f"[Global:{usersettings.BUILDING_SETTINGS_SECTION}]\n"
            "m_MaxNumLandclaimSegments=20\n"
            "m_bBuildingRestrictionLimitsEnabled=False\n"
            "m_BaseBackupToolTimeRestrictionInSeconds=60\n"
            "m_StakingUnitExtensionDefaultTimes=2\n"
        )

        rendered = usersettings.client_game_ini(profile, MAP_NAME)

        self.assertIn("m_WaterConsumptionRate=2.0", rendered)
        self.assertIn("m_MaxNumLandclaimSegments=20", rendered)
        self.assertIn("m_bBuildingRestrictionLimitsEnabled=False", rendered)
        self.assertIn("m_BaseBackupToolTimeRestrictionInSeconds=60", rendered)
        self.assertNotIn("m_DefaultReconnectGracePeriodSeconds", rendered)
        self.assertNotIn("UnknownCommunitySetting", rendered)
        self.assertNotIn(usersettings.LANDSRAAD_SETTINGS_SECTION, rendered)
        self.assertNotIn(usersettings.DEEPDESERT_MATCHMAKER_SECTION, rendered)
        self.assertNotIn("m_StakingUnitExtensionDefaultTimes", rendered)

    def test_uses_winning_map_and_partition_values_for_required_fields(self):
        section, key, _default = usersettings.MAP_FIELDS["water_consumption_rate"]
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "global", section, key, "2.0")
        usersettings.profile_set_key(profile, "map", section, key, "3.0", MAP_NAME)
        usersettings.profile_set_key(profile, "partition", section, key, "4.0", MAP_NAME, PARTITION_ID)

        self.assertIn(f"{key}=2.0", usersettings.client_game_ini(profile, ""))
        self.assertIn(f"{key}=3.0", usersettings.client_game_ini(profile, MAP_NAME))
        self.assertIn(f"{key}=4.0", usersettings.client_game_ini(profile, MAP_NAME, PARTITION_ID))
        self.assertNotIn(f"{key}=4.0", usersettings.client_game_ini(profile, MAP_NAME, OTHER_PARTITION_ID))

    def test_omits_client_required_fields_at_their_defaults(self):
        rendered = usersettings.client_game_ini(usersettings.empty_profile(), MAP_NAME)
        for field_id, filename in usersettings.CLIENT_FILE_REQUIRED.items():
            if filename != "Game.ini":
                continue
            _section, key, _default = usersettings.MAP_FIELDS[field_id]
            self.assertNotIn(f"{key}=", rendered)


class StakingExtensionArrayTests(ProfilePathTestCase):
    """Staking timers are ten-element native arrays, exposed as one safe scalar."""

    FIELD_ID = "staking_unit_extension_default_times"
    KEY = "m_StakingUnitExtensionDefaultTimes"

    def assert_complete_array(self, rendered: str, value: str):
        lines = rendered.splitlines()
        self.assertEqual(lines.count(f"!{self.KEY}=ClearArray"), 1)
        self.assertEqual(lines.count(f".{self.KEY}={value}"), usersettings.STAKING_EXTENSION_ARRAY_LENGTH)
        self.assertFalse(any(line.startswith((f"{self.KEY}=", f"+{self.KEY}=", f"-{self.KEY}=")) for line in lines))

    def test_blank_value_preserves_funcom_packaged_defaults(self):
        rendered = usersettings.compiled_usergame_ini(usersettings.empty_profile(), MAP_NAME)
        self.assertNotIn(self.KEY, rendered)

    def test_scalar_is_compiled_as_a_complete_duplicate_preserving_array(self):
        profile = usersettings.empty_profile()
        usersettings.set_profile_field(profile, "global", "", "", self.FIELD_ID, "2")
        self.assert_complete_array(usersettings.compiled_usergame_ini(profile, MAP_NAME), "2.000000")
        self.assertNotIn(self.KEY, usersettings.client_game_ini(profile, MAP_NAME))

    def test_map_and_partition_precedence_selects_one_complete_array(self):
        profile = usersettings.empty_profile()
        usersettings.set_profile_field(profile, "global", "", "", self.FIELD_ID, "2")
        usersettings.set_profile_field(profile, "map", MAP_NAME, "", self.FIELD_ID, "3")
        usersettings.set_profile_field(profile, "partition", MAP_NAME, PARTITION_ID, self.FIELD_ID, "4")
        self.assert_complete_array(usersettings.compiled_usergame_ini(profile, MAP_NAME), "3.000000")
        self.assert_complete_array(usersettings.compiled_usergame_ini(profile, MAP_NAME, PARTITION_ID), "4.000000")
        self.assert_complete_array(usersettings.compiled_usergame_ini(profile, MAP_NAME, OTHER_PARTITION_ID), "3.000000")

    def test_saving_cleans_legacy_array_fragments(self):
        profile = usersettings.parse_profile_text(
            f"[Global:{usersettings.BUILDING_SETTINGS_SECTION}]\n"
            f"{self.KEY}=1\n-{self.KEY}=60.000000\n.{self.KEY}=120.000000\n"
        )
        usersettings.set_profile_field(profile, "global", "", "", self.FIELD_ID, "2")
        self.assertEqual(profile["sections"][0]["lines"], [f"{self.KEY}=2.000000"])
        self.assert_complete_array(usersettings.compiled_usergame_ini(profile, MAP_NAME), "2.000000")

    def test_invalid_or_dangerously_extreme_values_are_rejected(self):
        for value in ("0", "nan", "604801"):
            with self.subTest(value=value), self.assertRaises(SystemExit):
                usersettings.normalize_staking_extension_seconds(value)


class EngineFieldOverridePrecedenceTests(ProfilePathTestCase):
    """UserEngine.ini's Global -> Map -> Partition chain (internally
    Engine -> MapEngine -> PartitionEngine; the Advanced tab displays these
    with the same Global/Map/Partition words UserGame uses, see
    ENGINE_HEADER_DISPLAY_NAMES, but the underlying merge functions below are
    keyed by the internal names)."""

    FIELD_ID = "mining_output_multiplier"

    def _spec(self):
        return usersettings.ENGINE_FIELDS[self.FIELD_ID]

    def test_unset_field_falls_through_to_schema_default_at_every_tier(self):
        _section, _key, default = self._spec()
        profile = usersettings.empty_profile()
        self.assertEqual(usersettings.profile_engine_values(profile)[self.FIELD_ID], default)
        self.assertEqual(usersettings.profile_map_engine_values(profile, MAP_NAME)[self.FIELD_ID], default)
        self.assertEqual(usersettings.profile_partition_engine_values(profile, MAP_NAME, PARTITION_ID)[self.FIELD_ID], default)

    def test_map_overrides_global_but_not_a_different_map(self):
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "engine", section, key, "2.0")
        self.assertEqual(usersettings.profile_map_engine_values(profile, MAP_NAME)[self.FIELD_ID], "2.0")

        usersettings.profile_set_key(profile, "map_engine", section, key, "3.0", MAP_NAME)
        self.assertEqual(usersettings.profile_map_engine_values(profile, MAP_NAME)[self.FIELD_ID], "3.0")
        self.assertEqual(usersettings.profile_map_engine_values(profile, "Survival_2")[self.FIELD_ID], "2.0")
        self.assertEqual(usersettings.profile_engine_values(profile)[self.FIELD_ID], "2.0")

    def test_partition_overrides_map_but_not_a_sibling_partition(self):
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "engine", section, key, "2.0")
        usersettings.profile_set_key(profile, "map_engine", section, key, "3.0", MAP_NAME)

        self.assertEqual(usersettings.profile_partition_engine_values(profile, MAP_NAME, PARTITION_ID)[self.FIELD_ID], "3.0")
        self.assertEqual(usersettings.profile_partition_engine_values(profile, MAP_NAME, OTHER_PARTITION_ID)[self.FIELD_ID], "3.0")

        usersettings.profile_set_key(profile, "partition_engine", section, key, "4.0", MAP_NAME, PARTITION_ID)
        self.assertEqual(usersettings.profile_partition_engine_values(profile, MAP_NAME, PARTITION_ID)[self.FIELD_ID], "4.0")
        self.assertEqual(usersettings.profile_partition_engine_values(profile, MAP_NAME, OTHER_PARTITION_ID)[self.FIELD_ID], "3.0")
        self.assertEqual(usersettings.profile_map_engine_values(profile, MAP_NAME)[self.FIELD_ID], "3.0")

    def test_compiled_ini_reflects_the_winning_tier_at_each_level(self):
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "engine", section, key, "2.0")
        usersettings.profile_set_key(profile, "map_engine", section, key, "3.0", MAP_NAME)
        usersettings.profile_set_key(profile, "partition_engine", section, key, "4.0", MAP_NAME, PARTITION_ID)

        compiled_global = usersettings.compiled_userengine_ini(profile)
        self.assertIn(f"{key}=2.0", compiled_global)

        compiled_map_only = usersettings.compiled_userengine_ini(profile, MAP_NAME)
        self.assertIn(f"{key}=3.0", compiled_map_only)
        self.assertNotIn(f"{key}=2.0", compiled_map_only)
        self.assertNotIn(f"{key}=4.0", compiled_map_only)

        compiled_partition = usersettings.compiled_userengine_ini(profile, MAP_NAME, PARTITION_ID)
        self.assertIn(f"{key}=4.0", compiled_partition)
        self.assertNotIn(f"{key}=3.0", compiled_partition)

        compiled_sibling_partition = usersettings.compiled_userengine_ini(profile, MAP_NAME, OTHER_PARTITION_ID)
        self.assertIn(f"{key}=3.0", compiled_sibling_partition)
        self.assertNotIn(f"{key}=4.0", compiled_sibling_partition)

    def test_precedence_survives_a_real_save_and_reload_round_trip(self):
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "engine", section, key, "2.0")
        usersettings.profile_set_key(profile, "map_engine", section, key, "3.0", MAP_NAME)
        usersettings.profile_set_key(profile, "partition_engine", section, key, "4.0", MAP_NAME, PARTITION_ID)
        usersettings.write_profile(profile)

        reloaded = usersettings.read_profile()
        self.assertEqual(usersettings.profile_engine_values(reloaded)[self.FIELD_ID], "2.0")
        self.assertEqual(usersettings.profile_map_engine_values(reloaded, MAP_NAME)[self.FIELD_ID], "3.0")
        self.assertEqual(usersettings.profile_partition_engine_values(reloaded, MAP_NAME, PARTITION_ID)[self.FIELD_ID], "4.0")


class PartitionEngineValuesManyCommandTests(ProfilePathTestCase):
    """`partition-engine-values-many` backs both sietches.sh's display-name
    resolution (dimensions()/runtime_args()) and the console API's
    resolvePartitionDisplayNamesFromRuntime -- one profile read resolving
    server_display_name (Bgd.ServerDisplayName) for several partitions at
    once. It must apply the exact same partition -> map -> global precedence
    as the singular partition-engine-values command, not a simplified or
    stale copy of it."""

    FIELD_ID = "server_display_name"

    def _spec(self):
        return usersettings.ENGINE_FIELDS[self.FIELD_ID]

    def _run_command(self, map_name, partition_ids):
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            usersettings.partition_engine_values_many_command(map_name, partition_ids)
        return json.loads(buffer.getvalue())

    def test_resolves_distinct_partitions_in_one_call(self):
        # server_display_name is deliberately excluded from SCOPED_ENGINE_FIELDS
        # (see usersettings.py:516-519), so unlike most engine fields it has no
        # per-map override tier -- only global (every Sietch in the battlegroup)
        # and per-partition (the battlegroup editor / "sietches set-display"),
        # matching the UserEngine.ini comment ("Set the name of every Sietch in
        # the battlegroup ... use the battlegroup editor instead" for per-Sietch
        # names). This asserts partition vs. global, not partition vs. map.
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "engine", section, key, "Battlegroup Wide Name")
        usersettings.profile_set_key(profile, "partition_engine", section, key, "Named Sietch", MAP_NAME, PARTITION_ID)
        usersettings.write_profile(profile)

        result = self._run_command(MAP_NAME, [PARTITION_ID, OTHER_PARTITION_ID])

        # The partition with its own override wins over the battlegroup-wide name...
        self.assertEqual(result[PARTITION_ID][self.FIELD_ID], "Named Sietch")
        # ...while its sibling, with no override of its own, still falls
        # through to the global name rather than coming back empty.
        self.assertEqual(result[OTHER_PARTITION_ID][self.FIELD_ID], "Battlegroup Wide Name")

    def test_matches_the_singular_command_for_the_same_partition(self):
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "engine", section, key, "Global Name")
        usersettings.profile_set_key(profile, "partition_engine", section, key, "Partition Name", MAP_NAME, PARTITION_ID)
        usersettings.write_profile(profile)

        result = self._run_command(MAP_NAME, [PARTITION_ID, OTHER_PARTITION_ID])
        reloaded = usersettings.read_profile()

        self.assertEqual(
            result[PARTITION_ID][self.FIELD_ID],
            usersettings.profile_partition_engine_values(reloaded, MAP_NAME, PARTITION_ID)[self.FIELD_ID],
        )
        self.assertEqual(
            result[OTHER_PARTITION_ID][self.FIELD_ID],
            usersettings.profile_partition_engine_values(reloaded, MAP_NAME, OTHER_PARTITION_ID)[self.FIELD_ID],
        )
        # Sanity: the sibling with no partition override actually fell through
        # to the global name, so this isn't trivially true for both sides.
        self.assertEqual(result[OTHER_PARTITION_ID][self.FIELD_ID], "Global Name")

    def test_a_name_set_via_sietches_set_display_is_visible_in_bulk(self):
        # `sietches set-display` writes into this exact field via
        # `usersettings.py partition-engine-set ... server_display_name`
        # (see runtime/scripts/sietches.sh) -- simulate that write directly
        # through the same profile API rather than shelling out.
        section, key, _default = self._spec()
        profile = usersettings.empty_profile()
        usersettings.profile_set_key(profile, "partition_engine", section, key, "The Kulon Show", MAP_NAME, PARTITION_ID)
        usersettings.write_profile(profile)

        result = self._run_command(MAP_NAME, [PARTITION_ID])
        self.assertEqual(result[PARTITION_ID][self.FIELD_ID], "The Kulon Show")


if __name__ == "__main__":
    unittest.main()
