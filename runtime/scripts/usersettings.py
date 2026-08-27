#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import os
import re
import sys
import tempfile
from base64 import b64decode
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = Path(os.environ.get("DUNE_USERSETTINGS_CONFIG", str(ROOT / "runtime" / "generated" / "usersettings.json")))
PROFILE_PATH = Path(os.environ.get("DUNE_GAMEPLAY_PROFILE", str(ROOT / "runtime" / "generated" / "gameplay-profile.ini")))
SIETCH_CONFIG_PATH = Path(os.environ.get("DUNE_SIETCH_CONFIG", str(ROOT / "runtime" / "generated" / "sietch-config.json")))
LANDSRAAD_RESTART_MARKER_PATH = Path(os.environ.get("DUNE_LANDSRAAD_RESTART_MARKER", str(ROOT / "runtime" / "generated" / "landsraad-restart-required")))
PRIVATE_SETTINGS_MODE = 0o600


def configured_host_owner() -> tuple[int, int] | None:
    """Return the non-root account that should own host-managed files."""
    try:
        repo_stat = ROOT.stat()
        if repo_stat.st_uid != 0:
            return repo_stat.st_uid, repo_stat.st_gid
    except OSError:
        pass

    configured: dict[str, str] = {
        "DUNE_HOST_UID": os.environ.get("DUNE_HOST_UID", "").strip(),
        "DUNE_HOST_GID": os.environ.get("DUNE_HOST_GID", "").strip(),
    }
    env_path = ROOT / ".env"
    if not all(configured.values()):
        try:
            for raw_line in env_path.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                if key in configured and not configured[key]:
                    configured[key] = value.strip().strip("\"'")
        except OSError:
            pass

    try:
        uid = int(configured["DUNE_HOST_UID"])
        gid = int(configured["DUNE_HOST_GID"])
    except (KeyError, TypeError, ValueError):
        return None
    if uid <= 0 or gid < 0:
        return None
    return uid, gid


def apply_host_ownership(path: Path) -> None:
    """Prevent root maintenance jobs from leaving host files root-owned."""
    if os.geteuid() != 0:
        return
    owner = configured_host_owner()
    if owner is not None:
        os.chown(path, *owner)

BUILDING_SETTINGS_SECTION = "/Script/DuneSandbox.BuildingSettings"
CORIOLIS_SUBSYSTEM_SECTION = "/Script/DuneSandbox.CoriolisSubsystem"
LANDSRAAD_SETTINGS_SECTION = "/Script/DuneSandbox.LandsraadSettings"
LANDSRAAD_DATA_KEY = "Data"
LANDSRAAD_DATA_TEMPLATE = '(m_NumberOfWeeksTermRetention=4,m_NumberOfDecreesToNominate=3,m_NumberOfGuildsInHighscoreList=5,m_TermStartedMessage=(Name="LandsraadTermStarted"),m_VotingStartedMessage=(Name="LandsraadVotingStarted"),m_TaskProgressedMessage=(Name="LandsraadProgressNotification"),m_DecreeActivatedMessage=(Name="LandsraadDecreeActivated"),m_bIsPlayerVotingEnabled=True,m_bIsTerritoryControlEnabled=True,m_BoardLayouts=(/Script/DuneSandbox.BoardLayoutDataAsset\'"/Game/Dune/Systems/Landsraad/BoardLayouts/DefaultLandsraadBoardLayout.DefaultLandsraadBoardLayout"\'),m_LandsraadVotingPeriodDurationInSec=118500,m_LandsraadCycleDurationInSeconds=604800,m_LandsraadSuspendedPeriodDurationInSeconds=300,m_FirstTaskRevealDelayFromCompetitionStartInSeconds=0.000000,m_LandsraadRevealedTaskTimestampMinuteDifference=1,m_LandsraadTaskProgressUpdateFrequency=15.000000,m_LandsraadTaskDailyRevealFrequency=25.000000,m_LandsraadProgressFactionBalanceCurve=/Script/Engine.CurveFloat\'"/Game/Dune/Systems/Landsraad/Curve_LandsraadProgressFactionBalanceCurve.Curve_LandsraadProgressFactionBalanceCurve"\',m_LandsraadContractsPerVotingBlock=3,m_LandsraadContractsRepeatCooldownSeconds=14400,m_LandsraadContractsMaxActiveAmount=3,m_LandsraadContractsAbandonCooldownSeconds=2,m_LandsraadContractsDailyBonusPerDay=35,m_LandsraadContractsDailyBonusMax=35,m_LandsraadContractsDailyBonusReferenceTimestamp=1760572800,m_LandsraadContractsDailyBonusRefreshCycleLength=7200,m_LandsraadContractsTimeToShowRewardInteractiveNotification=30.000000,m_LandsraadContractsTimeToShowErrorNotification=70.000000,m_LandsraadContractsTimeToShowPendingClaimRewardTutorial=300,m_LandsraadTaskRewardsData="/Game/Dune/Systems/Landsraad/DA_TaskRewardsDataAsset.DA_TaskRewardsDataAsset",m_LandsraadHouseSelectContractDialogContentWidget="/Game/Dune/GUI/Widgets/Menus/Gameplay/PlayerMenu/Landsraad/W_LandsraadHouseSelectContractDialog.W_LandsraadHouseSelectContractDialog_C",m_LandsraadContractReportDialogContentWidget="/Game/Dune/GUI/Widgets/Menus/Gameplay/PlayerMenu/Landsraad/W_LandsraadContractReportDialog.W_LandsraadContractReportDialog_C",m_LandsraadClaimHouseRewardDialogWidget="/Game/Dune/GUI/Widgets/Menus/Gameplay/PlayerMenu/Landsraad/W_LandsraadHouseRewardClaimDialog.W_LandsraadHouseRewardClaimDialog_C",m_TaskGoalAmount=56000,m_ControlPointsPerCycle=2,m_LandsraadContractsUnlockGameplayTag=(TagName="Journey.LandsraadContractsUnlocked"),m_LandsraadContractsNewMarkerGameplayTags=(GameplayTags=((TagName="DialogueFlags.Factions.LandsraadOnboardingActive"))),m_ControlPointAreaMaterial="/Game/Dune/Systems/Landsraad/Materials/M_LandsRaadControlPointCapsule.M_LandsRaadControlPointCapsule")'
LANDSRAAD_DATA_TEMPLATE = LANDSRAAD_DATA_TEMPLATE.replace(
    "m_LandsraadVotingPeriodDurationInSec=118500,",
    "m_LandsraadVotingPeriodDurationInSec=118500,m_VotingPeriodStartBeforeCoriolisCycleInSec=118800,",
)
LANDSRAAD_DATA_FIELDS = {
    "landsraad_term_retention_weeks": ("m_NumberOfWeeksTermRetention", "4", "integer", 1, 52),
    "landsraad_decrees_to_nominate": ("m_NumberOfDecreesToNominate", "3", "integer", 1, 20),
    "landsraad_highscore_guilds": ("m_NumberOfGuildsInHighscoreList", "5", "integer", 1, 100),
    "landsraad_player_voting_enabled": ("m_bIsPlayerVotingEnabled", "True", "boolean", None, None),
    "landsraad_territory_control_enabled": ("m_bIsTerritoryControlEnabled", "True", "boolean", None, None),
    "landsraad_voting_period_seconds": ("m_LandsraadVotingPeriodDurationInSec", "118500", "integer", 60, 6048000),
    "landsraad_voting_start_before_coriolis_seconds": ("m_VotingPeriodStartBeforeCoriolisCycleInSec", "118800", "integer", 0, 6048000),
    "landsraad_cycle_duration_seconds": ("m_LandsraadCycleDurationInSeconds", "604800", "integer", 3600, 31536000),
    "landsraad_suspended_period_seconds": ("m_LandsraadSuspendedPeriodDurationInSeconds", "300", "integer", 0, 604800),
    "landsraad_first_task_reveal_delay_seconds": ("m_FirstTaskRevealDelayFromCompetitionStartInSeconds", "0", "number", 0, 604800),
    "landsraad_task_reveal_minute_difference": ("m_LandsraadRevealedTaskTimestampMinuteDifference", "1", "integer", 0, 10080),
    "landsraad_task_progress_update_seconds": ("m_LandsraadTaskProgressUpdateFrequency", "15", "number", 1, 3600),
    "landsraad_task_daily_reveal_frequency": ("m_LandsraadTaskDailyRevealFrequency", "25", "number", 1, 10080),
    "landsraad_contracts_per_voting_block": ("m_LandsraadContractsPerVotingBlock", "3", "integer", 1, 100),
    "landsraad_contract_repeat_cooldown_seconds": ("m_LandsraadContractsRepeatCooldownSeconds", "14400", "integer", 0, 2592000),
    "landsraad_max_active_contracts": ("m_LandsraadContractsMaxActiveAmount", "3", "integer", 1, 100),
    "landsraad_contract_abandon_cooldown_seconds": ("m_LandsraadContractsAbandonCooldownSeconds", "2", "integer", 0, 604800),
    "landsraad_daily_contract_bonus": ("m_LandsraadContractsDailyBonusPerDay", "35", "integer", 0, 1000000),
    "landsraad_max_daily_contract_bonus": ("m_LandsraadContractsDailyBonusMax", "35", "integer", 0, 1000000),
    "landsraad_daily_bonus_refresh_seconds": ("m_LandsraadContractsDailyBonusRefreshCycleLength", "7200", "integer", 60, 2592000),
    "landsraad_task_goal_amount": ("m_TaskGoalAmount", "56000", "integer", 1, 2147483647),
    "landsraad_control_points_per_cycle": ("m_ControlPointsPerCycle", "2", "integer", 0, 1000000),
}
STAKING_EXTENSION_ARRAY_LENGTH = 10
STAKING_EXTENSION_FIELDS = {
    "staking_unit_vertical_extension_default_times": "m_StakingUnitVerticalExtensionDefaultTimes",
    "staking_unit_extension_default_times": "m_StakingUnitExtensionDefaultTimes",
}
UNSAFE_STAKING_EXTENSION_KEYS = set(STAKING_EXTENSION_FIELDS.values())
# Engine fields whose UI is a True/False boolean but whose ini value must be
# literal "1"/"0" (the game only accepts numeric 0/1 for these, not True/False).
# Without this the console renders them as a free-text box you type "1" into,
# because there is no "toggle" branch in the frontend's SettingInput.
NUMERIC_BOOLEAN_ENGINE_FIELDS = {
    "sun_exposure_enabled",
    "sandstorm_enabled",
    "sandstorm_treasure_enabled",
    "sandworm_enabled",
    "weapon_specific_quick_melee_enabled",
    "spice_visions_enabled",
    "passenger_taxi_enabled",
    "double_difficulty_loot_enabled",
    "regenerate_per_player_loot_enabled",
}


def normalize_engine_field_value(field_id: str, value: str) -> str:
    if field_id in NUMERIC_BOOLEAN_ENGINE_FIELDS:
        return "1" if truthy(value) else "0"
    return value


FIELD_TYPE_OVERRIDES = {
    "staking_unit_vertical_extension_default_times": "number",
    "staking_unit_extension_default_times": "number",
    # Empty default (no override) would otherwise infer as "text" -- this holds a
    # float number of seconds, so force the numeric input/validation.
    "deathstill_conversion_time_override": "number",
    # Zero-valued integer defaults otherwise infer as 0/1 toggles.
    "coriolis_cycle_start_year": "integer",
    "coriolis_cycle_start_month": "integer",
    "coriolis_cycle_start_day": "integer",
    "coriolis_cycle_start_hour": "integer",
    "coriolis_cycle_start_minute": "integer",
    "coriolis_cycle_start_seed_index": "integer",
    # Derived rather than listed so the select and the 1/0 conversion cannot drift.
    **{field_id: "boolean" for field_id in NUMERIC_BOOLEAN_ENGINE_FIELDS},
}

# Bounds for the Coriolis cycle fields shipped in Funcom's UserGame.ini
# template. These five fields form a UTC calendar date and time. The server
# validates them for Web UI, API, and CLI callers.
CORIOLIS_CYCLE_START_BOUNDS = {
    "coriolis_cycle_start_year": (1, 9999),
    "coriolis_cycle_start_month": (1, 12),
    "coriolis_cycle_start_day": (1, 31),
    "coriolis_cycle_start_hour": (0, 23),
    "coriolis_cycle_start_minute": (0, 59),
}

# The game stores this as a normalized roll threshold, not as a whole-number
# percentage. Values such as 75 or 100 make the setting nonsensical and used to
# be accepted by every settings surface because generic numeric fields had no
# bounds metadata.
AUGMENT_JACKPOT_ROLL_BOUNDS = (0.0, 1.0)

# UserGame properties that older community catalogues presented as numeric
# modifiers, but which the current Funcom server build cannot consume in the
# advertised form. Keep the exact section/key pairs reserved so an old saved
# profile cannot continue leaking them into generated server or client INIs as
# unknown passthrough lines after the controls are removed from MAP_FIELDS.
RETIRED_USERGAME_FIELDS = {
    "global_xp_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_GlobalXPMultiplier", "1.0"),
    "global_fame_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_GlobalFameMultiplier", "1.0"),
    "global_progression_speed_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_GlobalProgressionSpeedMultiplier", "1.0"),
    "global_harvest_health_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_GlobalHarvestHealthMultiplier", "1.0"),
    # Funcom does have a property with this name, but it is an asset-table
    # reference inside m_MiningSettings, not a scalar DuneGameMode multiplier.
    "cutteray_hem_multiplier_per_node_tier_table": ("/Script/DuneSandbox.DuneGameMode", "CutterayHemMultiplierPerNodeTierTable", "1.0"),
    "global_damage_to_npcs_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_GlobalDamageToNpcsMultiplier", "1.0"),
}

ENGINE_FIELDS = {
    "port": ("URL", "Port", "7777"),
    "igw_port": ("URL", "IGWPort", "7888"),
    "server_display_name": ("ConsoleVariables", "Bgd.ServerDisplayName", None),
    "server_login_password": ("ConsoleVariables", "Bgd.ServerLoginPassword", None),
    "mining_output_multiplier": ("ConsoleVariables", "Dune.GlobalMiningOutputMultiplier", "1.0"),
    "vehicle_mining_output_multiplier": ("ConsoleVariables", "Dune.GlobalVehicleMiningOutputMultiplier", "1.0"),
    "pvp_resource_multiplier": ("ConsoleVariables", "SecurityZones.PvpResourceMultiplier", "2.5"),
    "vehicle_durability_damage_multiplier": ("ConsoleVariables", "dw.VehicleDurabilityDamageMultiplier", "1.0"),
    "sandstorm_enabled": ("ConsoleVariables", "Sandstorm.Enabled", "1"),
    "sandstorm_treasure_enabled": ("ConsoleVariables", "Sandstorm.Treasure.Enabled", "1"),
    "sandworm_enabled": ("ConsoleVariables", "sandworm.dune.Enabled", "1"),
    "sandworm_collision_interaction": ("ConsoleVariables", "Vehicle.SandwormCollisionInteraction", "false"),
    "sandworm_danger_zones_enabled": ("ConsoleVariables", "Sandworm.SandwormDangerZonesEnabled", "true"),
    "sandworm_invulnerability_on_exit": ("ConsoleVariables", "Vehicle.SandwormInvulnerabilitySecondsOnExit", "900.0"),
    "sandworm_invulnerability_on_restart": ("ConsoleVariables", "Vehicle.SandwormInvulnerabilitySecondsOnServerRestart", "7200.0"),
    "weapon_specific_quick_melee_enabled": ("ConsoleVariables", "Character.WeaponSpecificQuickMelee.Enabled", "0"),
    "spice_visions_enabled": ("ConsoleVariables", "SpiceAddiction.SpiceVisionsEnabled", "1"),
    "passenger_taxi_enabled": ("ConsoleVariables", "IgwTravel.AllowPassengerToUseTaxi", "0"),
    "blood_doors_enabled": ("ConsoleVariables", "Ai.BloodDoors.Enabled", "True"),
    "blood_doors_disable_blight_ecolab": ("ConsoleVariables", "Ai.BloodDoors.DisableBlightEcolab", "False"),
    "sun_exposure_enabled": ("ConsoleVariables", "Hydration.SunExposureEnabled", "1"),
    "vehicle_max_per_player": ("ConsoleVariables", "Vehicle.MaxVehiclesPerPlayer", "10"),
    "fuel_burning_multiplier": ("ConsoleVariables", "dw.FuelBurningMultiplier", "1.0"),
    "landsraad_reward_multiplier_faction_xp": ("ConsoleVariables", "dw.LandsraadMissionRewardMultiplierFactionXP", "1.0"),
    "landsraad_reward_multiplier_house_credit": ("ConsoleVariables", "dw.LandsraadMissionRewardMultiplierHouseCredit", "1.0"),
    "landsraad_reward_multiplier_specialization_xp": ("ConsoleVariables", "dw.LandsraadMissionRewardMultiplierSpecializationXP", "1.0"),
    # Empty means "no override" -- Funcom's compiled default was not recovered,
    # so this is the least assumption we can make rather than a guessed number.
    "deathstill_conversion_time_override": ("ConsoleVariables", "Deathstill.ConversionTimeOverride", ""),
    # Both defaults confirmed against the game; do not "correct" them to 1.
    "double_difficulty_loot_enabled": ("ConsoleVariables", "Dune.GiveDoubleDifficultyLoot", "0"),
    "regenerate_per_player_loot_enabled": ("ConsoleVariables", "Loot.ShouldAlwaysRegeneratePerPlayerLoot", "0"),
}

# Explanatory ini comment(s) for a field, emitted by both compiled_userengine_ini()
# (beside a surviving non-default value) and profile_engine_text() (beside the
# always-synthesized identity fields). Several fields intentionally share one tuple
# (e.g. the three mining multipliers): that comment is meant to introduce the whole
# group, not just the first key under it.
ENGINE_FIELD_INI_COMMENTS: dict[str, tuple[str, ...]] = {
    "port": (
        "The starting port that servers listen to for players. Each server",
        "will use the next available port in a sequence (7777, 7778 etc.). The range should",
        "not intersect with the IGWPort range bellow",
    ),
    "igw_port": (
        "The port that servers listen to for other servers. Each server",
        "will use the next available port in a sequence (7888, 7889 etc.). The range should",
        "not intersect with the Port range above",
    ),
    "server_display_name": (
        "Set the name of every Sietch in the battlegroup",
        "If Sietches should have different names use the battlegroup editor instead",
        "Special characters like ' and | are not allowed and double quotes should be used",
    ),
    "server_login_password": (
        "Set a password for every Sietch in the battlegroup",
        "If Sietches should have different passwords use the battlegroup editor instead",
        "Special characters like ' and | are not allowed and double quotes should be used",
    ),
    "mining_output_multiplier": ("Mining multipliers",),
    "vehicle_mining_output_multiplier": ("Mining multipliers",),
    "pvp_resource_multiplier": ("Mining multipliers",),
    "vehicle_durability_damage_multiplier": ("Durability damage multiplier for vehicles | (0 to 10)  0=off",),
    "sandstorm_enabled": ("Sandstorm and sandstorm treasure spawning settings",),
    "sandstorm_treasure_enabled": ("Sandstorm and sandstorm treasure spawning settings",),
    "sandworm_enabled": ("Sandworm settings",),
    "sandworm_collision_interaction": ("Sandworm can push/damage vehicles",),
    "sandworm_danger_zones_enabled": ("Enables dangerzones where the sandworm can attack",),
    "sandworm_invulnerability_on_exit": ("Seconds of invunerability from sandworm on specific situations",),
    "sandworm_invulnerability_on_restart": ("Seconds of invunerability from sandworm on specific situations",),
    "weapon_specific_quick_melee_enabled": ("Character, spice, travel, and AI gameplay toggles",),
    "spice_visions_enabled": ("Character, spice, travel, and AI gameplay toggles",),
    "passenger_taxi_enabled": ("Character, spice, travel, and AI gameplay toggles",),
    "blood_doors_enabled": ("Character, spice, travel, and AI gameplay toggles",),
    "blood_doors_disable_blight_ecolab": ("Character, spice, travel, and AI gameplay toggles",),
    "sun_exposure_enabled": ("Experimental: disables sun exposure/heat effects on players when set to 0.",),
    "vehicle_max_per_player": ("Experimental: maximum number of vehicles a single player may own at once.",),
    "fuel_burning_multiplier": (
        "Experimental: multiplier for fuel burn duration. Larger values increase burn time. "
        "Conservative test range 0.1-10.0 (not enforced); 1.0 is normal.",
    ),
    "landsraad_reward_multiplier_faction_xp": (
        "Experimental: Landsraad mission reward multipliers (faction XP, house credits, specialization XP).",
    ),
    "landsraad_reward_multiplier_house_credit": (
        "Experimental: Landsraad mission reward multipliers (faction XP, house credits, specialization XP).",
    ),
    "landsraad_reward_multiplier_specialization_xp": (
        "Experimental: Landsraad mission reward multipliers (faction XP, house credits, specialization XP).",
    ),
    "deathstill_conversion_time_override": ("Experimental: overrides how long a Deathstill takes to process a body, in seconds.",),
    "double_difficulty_loot_enabled": ("Experimental: double loot when the encounter difficulty is above 0.",),
    "regenerate_per_player_loot_enabled": ("Experimental: regenerate per-player loot on every container interaction.",),
}


def schema_comment_lines_by_section(comments: dict[str, tuple[str, ...]], fields: dict[str, tuple[str | None, str | None, str | None]]) -> dict[str, set[str]]:
    """Every literal "; ..." line any field's comment could produce, grouped by ini
    section. Used to recognize -- and drop -- a schema comment surviving verbatim in
    a saved profile document, since compiled_userengine_ini now regenerates that same
    comment fresh next to its value; keeping the old copy too would duplicate it."""
    result: dict[str, set[str]] = {}
    for field_id, lines in comments.items():
        spec = fields.get(field_id)
        if not spec or not spec[0]:
            continue
        result.setdefault(spec[0], set()).update(f"; {line}" for line in lines)
    return result


# All ENGINE_FIELDS share the literal ini section "ConsoleVariables", so the
# generic section-derived category logic the console uses for UserGame fields
# can't distinguish them. This gives each one an explicit, functional grouping.
ENGINE_FIELD_CATEGORIES = {
    "sandstorm_enabled": "Sandstorm",
    "sandstorm_treasure_enabled": "Sandstorm",
    "sandworm_enabled": "Sandworm",
    "sandworm_collision_interaction": "Sandworm",
    "sandworm_danger_zones_enabled": "Sandworm",
    "sandworm_invulnerability_on_exit": "Sandworm",
    "sandworm_invulnerability_on_restart": "Sandworm",
    "mining_output_multiplier": "Multipliers",
    "vehicle_mining_output_multiplier": "Multipliers",
    "pvp_resource_multiplier": "Multipliers",
    "vehicle_durability_damage_multiplier": "Multipliers",
    "fuel_burning_multiplier": "Multipliers",
    "vehicle_max_per_player": "Vehicles",
    "sun_exposure_enabled": "Environment",
    "weapon_specific_quick_melee_enabled": "Gameplay Toggles",
    "spice_visions_enabled": "Gameplay Toggles",
    "passenger_taxi_enabled": "Gameplay Toggles",
    "blood_doors_enabled": "Gameplay Toggles",
    "blood_doors_disable_blight_ecolab": "Gameplay Toggles",
    "landsraad_reward_multiplier_faction_xp": "Landsraad",
    "landsraad_reward_multiplier_house_credit": "Landsraad",
    "landsraad_reward_multiplier_specialization_xp": "Landsraad",
    "deathstill_conversion_time_override": "Environment",
    "double_difficulty_loot_enabled": "Loot",
    "regenerate_per_player_loot_enabled": "Loot",
}

# Free-text field descriptions shown in the console UI. Only populated for
# fields as they're documented; metadata() falls back to "" for the rest.
FIELD_DESCRIPTIONS = {
    "staking_unit_vertical_extension_default_times": "Seconds required for every vertical Staking Unit extension level (0.1-604800). Leave empty to use Funcom's progressively longer defaults.",
    "staking_unit_extension_default_times": "Seconds required for every horizontal Staking Unit extension level (0.1-604800). Leave empty to use Funcom's progressively longer defaults.",
    "server_display_name": "Display name shown for this server instance. Used as the Dimension name when the server is a Dimension server.",
    "server_login_password": "Password players must enter to join. Leave empty for no password.",
    "mining_output_multiplier": "Multiplier applied to personal mining output for all players.",
    "vehicle_mining_output_multiplier": "Multiplier applied to vehicle mining output for all players.",
    "pvp_resource_multiplier": "Multiplier applied to resource yield inside PvP zones.",
    "vehicle_durability_damage_multiplier": "Multiplier applied to durability damage taken by vehicles. Valid range 0-10; 0 = damage off.",
    "sandworm_invulnerability_on_exit": "Seconds of invulnerability granted to a vehicle after a player exits it near a sandworm.",
    "sandworm_invulnerability_on_restart": "Seconds of invulnerability granted to vehicles after a server restart, to prevent immediate sandworm attacks.",
    "sandstorm_enabled": "Toggles sandstorm spawning. 1 = ON (default), 0 = OFF.",
    "sandstorm_treasure_enabled": "Toggles sandstorm treasure spawning. 1 = ON (default), 0 = OFF.",
    "sun_exposure_enabled": "Toggles whether players take sun exposure/heat damage. True/1 = ON (default), False/0 = OFF.",
    "vehicle_max_per_player": "Maximum number of vehicles a single player is allowed to own at once. 0 = no limit.",
    "fuel_burning_multiplier": "Multiplier applied to fuel burn duration. Larger values make fuel last longer. Conservative test range 0.1-10.0 (not enforced); 1.0 is normal.",
    "landsraad_reward_multiplier_faction_xp": "Multiplier applied to Faction XP rewarded from Landsraad missions.",
    "landsraad_reward_multiplier_house_credit": "Multiplier applied to House Credits rewarded from Landsraad missions.",
    "landsraad_reward_multiplier_specialization_xp": "Multiplier applied to Specialization XP rewarded from Landsraad missions.",
    "hydration_enabled": "Master toggle for the hydration / thirst system. Off = players never get thirsty.",
    "water_consumption_rate": "How quickly players consume water.",
    "player_starting_water": "Water amount when a player spawns.",
    "item_durability_loss_multiplier": "Scales durability loss for all items. 0 = off.",
    "cross_map_respawn_drop_items": "Whether items are dropped when a player respawns on a different map.",
    "item_deterioration_rate": "Deterioration tick rate. 0 = off, 1-10 typical.",
    "water_consumption_in_storm_multiplier": "Additional water drain during sandstorms.",
    "players_drop_loot_on_defeat": "Whether a player drops loot when downed/defeated (not a full death).",
    "players_drop_loot_on_death": "Whether a player drops their inventory as loot when killed (PvP looting).",
    "base_backup_tool_time_restriction_seconds": "Cooldown before the Base Backup tool can be used again on the same base, in seconds. Funcom's default is 604800 (7 days).",
    "deathstill_conversion_time_override": "Overrides how long it takes to process a body in a Deathstill. Value is the length of the cycle in seconds.",
    "double_difficulty_loot_enabled": "Gives double loot when the encounter difficulty is above 0. Field-confirmed with dungeon loot.",
    "regenerate_per_player_loot_enabled": "Whether per-player loot is regenerated each time a player interacts with a loot container. Field-confirmed. Enabling this can make a single container farmable indefinitely.",
    "restart_server_on_coriolis_cycle_end": "Requests Funcom's farm-level restart when the Coriolis cycle ends. Dune Docker coordinates one clean restart of Director, Gateway, and every world map so all processes load the same new cycle seed, while PostgreSQL, RabbitMQ, TextRouter, the Console, and orchestration remain online.",
    "augment_jackpot_roll_percentage": "Roll threshold from 0 to 1; lower values increase the jackpot chance. The default 0.95 gives a 5% chance. This can be overridden per map or Sietch, and the public server page shows Varies when those scopes differ.",
    "max_landclaim_segments": "Maximum number of land-claim segments (flags) a player may own.",
    "building_blueprint_max_extensions": "Maximum number of times a blueprinted building can be extended.",
    "base_backup_max_extensions": "Maximum number of times a Base Backup can be extended.",
    "building_restriction_limits_enabled": "Enforces building restriction limits (e.g. disallowing construction inside dungeons/restricted areas).",
    "force_pvp_all_partitions": "If enabled, forces PvP on for every map partition regardless of each partition's individual PvP/PvE setting.",
    "security_zones_enabled": "Master toggle for Security Zones. Disable to allow PvP and combat abilities everywhere on the map (no safe zones).",
    "coriolis_auto_spawn_enabled": "Whether Coriolis storms spawn automatically on their normal cycle.",
    "coriolis_cycle_start_year": "Base year shipped in the Coriolis configuration. Normally leave this unchanged when matching a regional schedule.",
    "coriolis_cycle_start_month": "Base month (1-12) shipped in the Coriolis configuration. Normally leave this unchanged when matching a regional schedule.",
    "coriolis_cycle_start_day": "UTC calendar day of the month (1-31). Regional master schedule anchor dates: Europe, North America, and South America use day 3; Asia and Oceania use day 2.",
    "coriolis_cycle_start_hour": "UTC hour (0-23). Regional master schedules: Europe 05, North America 11, South America 08, Asia 09, and Oceania 19.",
    "coriolis_cycle_start_minute": "UTC minute (0-59) for the Coriolis cycle start.",
    "coriolis_cycle_start_seed_index": "Funcom's seed index for the base Coriolis cycle. Leave at 0 unless intentionally coordinating a different cycle seed.",
}

FIELD_LABELS = {
    "restart_server_on_coriolis_cycle_end": "Restart Game Farm At Coriolis Cycle End",
    "coriolis_cycle_start_year": "Cycle Start Year",
    "coriolis_cycle_start_month": "Cycle Start Month",
    "coriolis_cycle_start_day": "Cycle Start Day",
    "coriolis_cycle_start_hour": "Cycle Start Hour",
    "coriolis_cycle_start_minute": "Cycle Start Minute",
    "coriolis_cycle_start_seed_index": "Cycle Start Seed Index",
    "coriolis_cycle_duration_days": "Cycle Duration Days",
    "coriolis_db_wipe_enabled": "Db Wipe Enabled",
    "guild_settings_creation_cost": "Guild Creation Cost",
    "guild_settings_max_guilds_allowed": "Max Guilds Allowed",
    "guild_settings_max_guild_members_allowed": "Max Guild Members Allowed",
    "guild_settings_max_pending_invites": "Max Pending Guild Invites",
    "augment_jackpot_roll_percentage": "Augment Jackpot Roll Threshold",
}

# Maps a field id to the client-side ini filename it also must be applied to
# (players copy the exported client file into their own Saved/Config/WindowsClient/
# folder). Both client INI generators use this as an explicit allowlist: server-
# only and unknown Advanced-editor values must never be offered to players.
CLIENT_FILE_REQUIRED = {
    "vehicle_max_per_player": "Engine.ini",
    # Funcom's shipped self-host setup template explicitly requires these
    # building values to match on every player's client.
    "max_landclaim_segments": "Game.ini",
    "building_restriction_limits_enabled": "Game.ini",
    "hydration_enabled": "Game.ini",
    "water_consumption_rate": "Game.ini",
    "player_starting_water": "Game.ini",
    "item_durability_loss_multiplier": "Game.ini",
    "cross_map_respawn_drop_items": "Game.ini",
    "item_deterioration_rate": "Game.ini",
    "water_consumption_in_storm_multiplier": "Game.ini",
    "players_drop_loot_on_defeat": "Game.ini",
    "players_drop_loot_on_death": "Game.ini",
    "base_backup_tool_time_restriction_seconds": "Game.ini",
}

MAP_FIELDS = {
    "force_pvp_all_partitions": ("/Script/DuneSandbox.PvpPveSettings", "m_bShouldForceEnablePvpOnAllPartitions", "False"),
    "security_zones_enabled": ("/Script/DuneSandbox.SecurityZonesSubsystem", "m_bAreSecurityZonesEnabled", "True"),
    "default_security_zone_type": ("/Script/DuneSandbox.SecurityZonesSubsystem", "m_DefaultSecurityZoneType", '(Name="NullSec")'),
    "outlaw_criminal_score": ("/Script/DuneSandbox.SecurityZonesSubsystem", "m_OutlawCriminalScore", "5"),
    "criminal_score_lifetime_seconds": ("/Script/DuneSandbox.SecurityZonesSubsystem", "m_CriminalScoreLifeTimeInSec", "600.000000"),
    "outlaw_flag_lifetime_seconds": ("/Script/DuneSandbox.SecurityZonesSubsystem", "m_OutlawFlagLifeTimeInSec", "7200.000000"),
    "dueling_start_delay_seconds": ("/Script/DuneSandbox.SecurityZonesSubsystem", "m_DuelingStartDelayInSeconds", "5.000000"),
    "dueling_out_of_range_delay_seconds": ("/Script/DuneSandbox.SecurityZonesSubsystem", "m_DuelingOutOfRangeDelayInSeconds", "5.000000"),
    "dueling_xy_radius_units": ("/Script/DuneSandbox.SecurityZonesSubsystem", "m_DuelingXYRadiusInUnits", "2500.000000"),
    "item_deterioration_rate": ("/DeteriorationSystem.ItemDeteriorationConstants", "UpdateRateInSeconds", "1.0"),
    "spice_spawning_active": ("/Script/DuneSandbox.SpiceHarvestingSystem", "m_bSpawningActive", "True"),
    "spice_prime_rate_seconds": ("/Script/DuneSandbox.SpiceHarvestingSystem", "m_PrimeRateInSeconds", "30.000000"),
    "spice_manager_tick_rate_seconds": ("/Script/DuneSandbox.SpiceHarvestingSystem", "m_ManagerTickRateInSeconds", "5.000000"),
    "spice_manager_refresh_rate_seconds": ("/Script/DuneSandbox.SpiceHarvestingSystem", "m_ManagerRequestRefreshRateInSeconds", "90.000000"),
    "spice_global_manager_refresh_rate_seconds": ("/Script/DuneSandbox.SpiceHarvestingSystem", "m_GlobalManagerRequestRefreshRateInSeconds", "120.000000"),
    "spice_player_must_witness_bloom": ("/Script/DuneSandbox.SpiceHarvestingSystem", "m_bPlayerMustWitnessBloom", "False"),
    "spice_bloom_long_range_replication": ("/Script/DuneSandbox.SpiceHarvestingSystem", "m_bEnableSpiceBloomLongRangeReplication", "True"),
    "spice_field_long_range_replication": ("/Script/DuneSandbox.SpiceHarvestingSystem", "m_bEnableSpiceFieldLongRangeReplication", "True"),
    "spice_node_value_to_resource_ratio": ("/Script/DuneSandbox.SpiceHarvestingSystem", "m_NodeValueToSpiceResourceRatio", "10.000000"),
    "flour_sand_fields_active_percentage": ("/Script/DuneSandbox.FlourSandSubsystem", "m_FlourSandFieldsActivePercentage", "1.0"),
    "resource_location_system_enabled": ("/Script/DuneSandbox.ResourceLocationSystem", "m_bIsEnabled", "True"),
    "resource_location_spawn_chance": ("/Script/DuneSandbox.ResourceLocationSystem", "m_ResourceSpawnChance", "1.0"),
    "resource_node_spawn_chance": ("/Script/DuneSandbox.ResourceNodeSpawner", "m_ResourceSpawnChance", "1.0"),
    "sandstorm_auto_spawn_enabled": ("/Script/DuneSandbox.SandStormConfig", "m_bAutoSpawnEnabled", "True"),
    "sandstorm_debris_enabled": ("/Script/DuneSandbox.SandStormConfig", "m_bSandStormDebrisEnabled", "True"),
    "sandstorm_debris_speed": ("/Script/DuneSandbox.SandStormConfig", "m_SandStormDebrisSpeed", "3000.000000"),
    "sandstorm_player_overlap_check_interval_seconds": ("/Script/DuneSandbox.SandStormConfig", "m_PlayerOverlapCheckIntervalInSeconds", "1.000000"),
    "sandstorm_building_overlap_check_interval_seconds": ("/Script/DuneSandbox.SandStormConfig", "m_BuildingOverlapCheckIntervalInSeconds", "5.000000"),
    "sandstorm_placeable_overlap_check_interval_seconds": ("/Script/DuneSandbox.SandStormConfig", "m_PlaceableOverlapCheckIntervalInSeconds", "5.000000"),
    "sandstorm_buildables_overlap_check_interval_seconds": ("/Script/DuneSandbox.SandStormConfig", "m_BuildablesOverlapCheckIntervalInSeconds", "5.000000"),
    "sandstorm_vehicle_overlap_check_interval_seconds": ("/Script/DuneSandbox.SandStormConfig", "m_VehicleOverlapCheckIntervalInSeconds", "3.000000"),
    "sandstorm_damage_frames_per_overlap_interval": ("/Script/DuneSandbox.SandStormConfig", "m_DamageFramesPerOverlapInterval", "15"),
    "sandstorm_net_cull_distance_meters": ("/Script/DuneSandbox.SandStormConfig", "m_NetCullDistanceInMeters", "10000.000000"),
    "sandstorm_fade_distance_meters": ("/Script/DuneSandbox.SandStormConfig", "m_FadeDistanceInMeters", "9000.000000"),
    "coriolis_auto_spawn_enabled": ("/Script/DuneSandbox.SandStormConfig", "m_bCoriolisAutoSpawnEnabled", "True"),
    "coriolis_spawn_warnings_duration_hours": ("/Script/DuneSandbox.SandStormConfig", "m_CoriolisSpawnWarningsDurationInHours", "6"),
    "coriolis_stage_1_duration_seconds": ("/Script/DuneSandbox.SandStormConfig", "m_CoriolisStage1DurationInSeconds", "32400.000000"),
    "coriolis_stage_2_duration_seconds": ("/Script/DuneSandbox.SandStormConfig", "m_CoriolisStage2DurationInSeconds", "3540.000000"),
    "coriolis_stage_3_duration_seconds": ("/Script/DuneSandbox.SandStormConfig", "m_CoriolisStage3DurationSeconds", "60.000000"),
    "coriolis_stage_4_duration_seconds": ("/Script/DuneSandbox.SandStormConfig", "m_CoriolisStage4DurationSeconds", "60.000000"),
    "coriolis_stage_5_duration_seconds": ("/Script/DuneSandbox.SandStormConfig", "m_CoriolisStage5DurationSeconds", "1740.000000"),
    "coriolis_sandstorm_spawn_prevention_seconds": ("/Script/DuneSandbox.SandStormConfig", "m_CoriolisSandstormSpawnPreventionSeconds", "600.000000"),
    "coriolis_does_damage": ("/Script/DuneSandbox.SandStormConfig", "m_bCoriolisDoesDamage", "False"),
    "coriolis_trigger_shifting_sands": ("/Script/DuneSandbox.SandStormConfig", "m_bCoriolisTriggerShiftingSands", "False"),
    "coriolis_light_damage": ("/Script/DuneSandbox.SandStormConfig", "m_CoriolisLightDamage", "5.000000"),
    "coriolis_heavy_damage": ("/Script/DuneSandbox.SandStormConfig", "m_CoriolisHeavyDamage", "5000.000000"),
    "storm_cycle_duration": ("/Script/DuneSandbox.SandStormConfig", "m_StormCycleDuration", "7200"),
    "storm_duration": ("/Script/DuneSandbox.SandStormConfig", "m_StormDuration", "600"),
    "storm_warning_duration": ("/Script/DuneSandbox.SandStormConfig", "m_StormWarningDuration", "120"),
    "storm_cycle_wait": ("/Script/DuneSandbox.SandStormConfig", "m_StormCycleWait", "300"),
    "coriolis_cycle_start_year": (CORIOLIS_SUBSYSTEM_SECTION, "m_CycleStartYear", "2024"),
    "coriolis_cycle_start_month": (CORIOLIS_SUBSYSTEM_SECTION, "m_CycleStartMonth", "12"),
    "coriolis_cycle_start_day": (CORIOLIS_SUBSYSTEM_SECTION, "m_CycleStartDay", "3"),
    "coriolis_cycle_start_hour": (CORIOLIS_SUBSYSTEM_SECTION, "m_CycleStartHour", "5"),
    "coriolis_cycle_start_minute": (CORIOLIS_SUBSYSTEM_SECTION, "m_CycleStartMinute", "0"),
    "coriolis_cycle_duration_days": (CORIOLIS_SUBSYSTEM_SECTION, "m_CycleDurationInDays", "7"),
    "coriolis_cycle_start_seed_index": (CORIOLIS_SUBSYSTEM_SECTION, "m_CycleStartSeedIndex", "0"),
    "forced_coriolis_world_seed": (CORIOLIS_SUBSYSTEM_SECTION, "m_ForcedCoriolisWorldSeed", "-1"),
    "restart_server_on_coriolis_cycle_end": (CORIOLIS_SUBSYSTEM_SECTION, "m_bShouldRestartServerOnCycleEnd", "True"),
    "coriolis_db_wipe_enabled": (CORIOLIS_SUBSYSTEM_SECTION, "m_bIsDbWipeEnabled", "True"),
    "max_landclaim_segments": (BUILDING_SETTINGS_SECTION, "m_MaxNumLandclaimSegments", "6"),
    "building_blueprint_max_extensions": (BUILDING_SETTINGS_SECTION, "m_BuildingBlueprintMaxExtensions", "4"),
    "base_backup_max_extensions": (BUILDING_SETTINGS_SECTION, "m_BaseBackupMaxExtensions", "8"),
    "base_backup_tool_time_restriction_seconds": (BUILDING_SETTINGS_SECTION, "m_BaseBackupToolTimeRestrictionInSeconds", "604800"),
    "building_restriction_limits_enabled": (BUILDING_SETTINGS_SECTION, "m_bBuildingRestrictionLimitsEnabled", "True"),
    "mitigate_all_sandstorm_damage": (BUILDING_SETTINGS_SECTION, "m_bMitigateAllSandstormDamage", "False"),
    "fallback_default_building_health": (BUILDING_SETTINGS_SECTION, "m_FallbackDefaultBuildingHealth", "5000.000000"),
    "fallback_default_placeable_health": (BUILDING_SETTINGS_SECTION, "m_FallbackDefaultPlaceableHealth", "1000.000000"),
    "pickup_total_durability_reduction": (BUILDING_SETTINGS_SECTION, "m_PickupTotalDurabilityPercentageReduction", "0.0"),
    "building_stabilization_system_enabled": (BUILDING_SETTINGS_SECTION, "m_bEnableStabilizationSystem", "True"),
    "building_destabilization_system_enabled": (BUILDING_SETTINGS_SECTION, "m_bEnableDestabilizationSystem", "False"),
    "building_destruction_effects_enabled": (BUILDING_SETTINGS_SECTION, "m_bEnableBuildingDestructionEffects", "True"),
    "building_height_limit_m": (BUILDING_SETTINGS_SECTION, "m_BuildingHeightLimitInM", "1500.000000"),
    "building_blueprint_range_multiplier": (BUILDING_SETTINGS_SECTION, "m_BuildingBlueprintRangeMultiplier", "0.660000"),
    "build_range": (BUILDING_SETTINGS_SECTION, "m_BuildRange", "3000.000000"),
    "free_translate_max": (BUILDING_SETTINGS_SECTION, "m_FreeTranslateMax", "200.000000"),
    "free_rotate_max": (BUILDING_SETTINGS_SECTION, "m_FreeRotateMax", "90.000000"),
    "sand_buildup_placeables_sheltered_target_value": (BUILDING_SETTINGS_SECTION, "m_SandBuildUpPlaceablesShelteredTargetValue", "0.1"),
    "sand_buildup_placeables_unsheltered_target_value": (BUILDING_SETTINGS_SECTION, "m_SandBuildUpPlaceablesUnShelteredTargetValue", "0.3"),
    # These are native ten-element arrays. The scalar stored in the editable
    # profile is expanded into a complete duplicate-preserving array during
    # compilation; it must never be emitted directly as a one-element array.
    "staking_unit_vertical_extension_default_times": (BUILDING_SETTINGS_SECTION, "m_StakingUnitVerticalExtensionDefaultTimes", ""),
    "staking_unit_extension_default_times": (BUILDING_SETTINGS_SECTION, "m_StakingUnitExtensionDefaultTimes", ""),
    "building_near_server_borders_enabled": (BUILDING_SETTINGS_SECTION, "m_bEnableBuildingNearServerBorders", "False"),
    "min_buildable_distance_from_server_border": (BUILDING_SETTINGS_SECTION, "m_bMinBuildableDistanceFromServerBorder", "1000.000000"),
    "can_remove_buildables_with_no_owner": (BUILDING_SETTINGS_SECTION, "m_bCanRemoveBuildablesWithNoOwner", "True"),
    "door_auto_close_time": (BUILDING_SETTINGS_SECTION, "m_TimeToAutomaticallyCloseDoor", "10"),
    "default_building_system_modifiers": (BUILDING_SETTINGS_SECTION, "m_DefaultBuildingSystemModifiers", "(m_RefundPercentage=1.000000,m_PlacementCostMultiplier=1.000000)"),
    "default_repair_cost_multiplier": (BUILDING_SETTINGS_SECTION, "m_DefaultRepairCostMultiplier", "0.25"),
    "broken_vehicle_module_armor_deduction": ("/Script/DuneSandbox.DuneSandboxGameModeBase", "m_BrokenVehicleModuleArmorDeduction", "2"),
    "players_drop_loot_on_death": ("/Script/DuneSandbox.DuneSandboxGameModeBase", "m_bShouldPlayersDropLootOnDeath", "False"),
    "players_drop_loot_on_defeat": ("/Script/DuneSandbox.DuneSandboxGameModeBase", "m_bShouldPlayersDropLootOnDefeat", "True"),
    "players_lose_items_on_death": ("/Script/DuneSandbox.DuneSandboxGameModeBase", "m_bShouldPlayersLoseItemsOnDeath", "True"),
    "npcs_drop_loot_on_death": ("/Script/DuneSandbox.DuneSandboxGameModeBase", "m_bShouldNpcDropLootOnDeath", "True"),
    "drop_amount_on_defeat": ("/Script/DuneSandbox.DuneSandboxGameModeBase", "m_DropAmountOnDefeat", "0.4"),
    "armor_mitigation_constant": ("/Script/DuneSandbox.DuneGameState", "m_ArmorMitigationConstant", "500"),
    "guild_creation_cost": ("/Script/DuneSandbox.DuneGameMode", "m_GuildCreationCost", "1000"),
    "sell_order_price_percentage_fee": ("/Script/DuneSandbox.DuneGameMode", "SellOrderPricePercentageFee", "2.0"),
    "spice_tax_amount": ("/Script/DuneSandbox.DuneGameMode", "SpiceTaxAmount", "0.1"),
    "spice_tax_interval": ("/Script/DuneSandbox.DuneGameMode", "SpiceTaxInterval", "3600"),
    "global_harvest_amount_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_GlobalHarvestAmountMultiplier", "1.0"),
    "minimum_augmentable_item_quality": ("/Script/DuneSandbox.DuneGameMode", "m_MinimumAugmentableItemQuality", "0"),
    "item_durability_loss_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_ItemDurabilityLossMultiplier", "1.0"),
    "legacy_pvp_enabled": ("/Script/DuneSandbox.DuneGameMode", "bPvPEnabled", "False"),
    "server_pve": ("/Script/DuneSandbox.DuneGameMode", "bServerPVE", "True"),
    "hydration_enabled": ("/Script/DuneSandbox.HydrationSubsystem", "m_bHydrationEnabled", "True"),
    "water_consumption_rate": ("/Script/DuneSandbox.DuneGameMode", "m_WaterConsumptionRate", "1.0"),
    "water_consumption_in_storm_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_WaterConsumptionInStormMultiplier", "4.0"),
    "global_damage_to_players_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_GlobalDamageToPlayersMultiplier", "1.0"),
    "global_health_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_GlobalHealthMultiplier", "1.0"),
    "global_building_damage_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_GlobalBuildingDamageMultiplier", "1.0"),
    "building_decay_rate_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_BuildingDecayRateMultiplier", "1.0"),
    "enable_building_stability": ("/Script/DuneSandbox.DuneGameMode", "bEnableBuildingStability", "True"),
    "inventory_weight_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_InventoryWeightMultiplier", "1.0"),
    "player_starting_water": ("/Script/DuneSandbox.DuneGameMode", "m_PlayerStartingWater", "100.0"),
    "default_reconnect_grace_period_seconds": ("/Script/DuneSandbox.DuneGameMode", "m_DefaultReconnectGracePeriodSeconds", "300"),
    "cycle_duration_in_days": ("/Script/DuneSandbox.DuneGameMode", "m_CycleDurationInDays", "7"),
    "db_wipe_enabled": ("/Script/DuneSandbox.DuneGameMode", "m_bIsDbWipeEnabled", "True"),
    "max_guild_members_allowed": ("/Script/DuneSandbox.DuneGameMode", "m_MaxGuildMembersAllowed", "32"),
    "max_guilds_allowed": ("/Script/DuneSandbox.DuneGameMode", "m_MaxGuildsAllowed", "3"),
    "max_permissions_per_actor": ("/Script/DuneSandbox.DuneGameMode", "m_MaxPermissionsPerActor", "20"),
    "vehicle_quicksand_damage": ("/Script/DuneSandbox.DuneGameMode", "m_VehicleQuicksandDamage", "10.0"),
    "player_inventory_starting_size": ("/Script/DuneSandbox.InventorySystemSettings", "PlayerInventoryStartingSize", "40"),
    "player_inventory_starting_volume_capacity": ("/Script/DuneSandbox.InventorySystemSettings", "PlayerInventoryStartingVolumeCapacity", "225.0"),
    "sandworm_system": ("/Script/DuneSandbox.SandwormSettings", "m_EnableSandwormSystem", "UseAllowList"),
    "worm_detection_distance": ("/Script/DuneSandbox.SandwormSettings", "WormDetectionDistance", "5000.0"),
    "min_worm_spawn_interval": ("/Script/DuneSandbox.SandwormSettings", "m_MinWormSpawnInternal", "300.0"),
    "min_distance_between_sandworms": ("/Script/DuneSandbox.SandwormSettings", "m_MinDistanceBetweenSandworms", "3000.0"),
    "sandworm_quicksand_speed_modifier": ("/Script/DuneSandbox.SandwormSettings", "m_SandwormQuicksandSpeedModifier", "0.5"),
    "generate_sandworm_territories_from_heatmap": ("/Script/DuneSandbox.SandwormSettings", "m_bGenerateTerritoriesFromHeatMap", "True"),
    "sandworm_territory_grid_x": ("/Script/DuneSandbox.SandwormSettings", "m_SandwormTerritoryGridX", "1"),
    "sandworm_territory_grid_y": ("/Script/DuneSandbox.SandwormSettings", "m_SandwormTerritoryGridY", "1"),
    "sandworm_threat_scale": ("/Script/DuneSandbox.SandwormSettings", "ThreatScale", "1.000000"),
    "sandworm_danger_zones_game_enabled": ("/Script/DuneSandbox.SandwormSettings", "m_bEnableDangerZones", "True"),
    "sandworm_danger_zones_cooldown": ("/Script/DuneSandbox.SandwormSettings", "m_DangerZonesCooldown", "1.000000"),
    "sandworm_hibernation_enabled": ("/Script/DuneSandbox.SandwormSettings", "m_bEnableHibernation", "True"),
    "player_shooting_recoil_threat_factor": ("/Script/DuneSandbox.SandwormSettings", "PlayerShootingRecoilThreatFactor", "1.000000"),
    "npc_shooting_recoil_threat_factor": ("/Script/DuneSandbox.SandwormSettings", "NPCShootingRecoilThreatFactor", "1.650000"),
    "player_vehicle_shooting_threat_factor": ("/Script/DuneSandbox.SandwormSettings", "PlayerVehicleShootingThreatFactor", "1.000000"),
    "npc_vehicle_shooting_threat_factor": ("/Script/DuneSandbox.SandwormSettings", "NPCVehicleShootingThreatFactor", "1.000000"),
    "harvest_spice_pickup_threat_unit": ("/Script/DuneSandbox.SandwormSettings", "HarvestSpicePickupThreatUnit", "10.000000"),
    "harvest_spice_coalesce_threat_unit": ("/Script/DuneSandbox.SandwormSettings", "HarvestSpiceCoalesceThreatUnit", "10.000000"),
    "harvest_flour_sand_pickup_threat_unit": ("/Script/DuneSandbox.SandwormSettings", "HarvestFlourSandPickupThreatUnit", "10.000000"),
    "harvest_flour_sand_coalesce_threat_unit": ("/Script/DuneSandbox.SandwormSettings", "HarvestFlourSandCoalesceThreatUnit", "10.000000"),
    "default_max_threat_score": ("/Script/DuneSandbox.SandwormSettings", "DefaultMaxThreatScore", "5000.000000"),
    "max_threat_in_safezone": ("/Script/DuneSandbox.SandwormSettings", "MaxThreatInSafezone", "0.000000"),
    "walking_threat_per_sec": ("/Script/DuneSandbox.SandwormSettings", "WalkingThreatPerSec", "15.000000"),
    "running_threat_per_sec": ("/Script/DuneSandbox.SandwormSettings", "RunningThreatPerSec", "20.000000"),
    "sprinting_threat_per_sec": ("/Script/DuneSandbox.SandwormSettings", "SprintingThreatPerSec", "20.000000"),
    "crouching_threat_per_sec": ("/Script/DuneSandbox.SandwormSettings", "CrouchingThreatPerSec", "15.000000"),
    "suspending_threat_per_sec": ("/Script/DuneSandbox.SandwormSettings", "SuspendingThreatPerSec", "200.000000"),
    "dashing_threat_per_sec": ("/Script/DuneSandbox.SandwormSettings", "DashingThreatPerSec", "90.000000"),
    "shielding_threat_per_sec": ("/Script/DuneSandbox.SandwormSettings", "ShieldingThreatPerSec", "500.000000"),
    "drumsand_threat_per_sec": ("/Script/DuneSandbox.SandwormSettings", "DrumsandThreatPerSec", "200.000000"),
    "building_threat_generation_enabled": ("/Script/DuneSandbox.SandwormSettings", "EnableBuildingThreatGeneration", "True"),
    "patrol_ship_spawn_time": ("/Script/DuneSandbox.PatrolShipSettings", "m_TimeOfDayToSpawn", "18.0"),
    "patrol_ship_despawn_time": ("/Script/DuneSandbox.PatrolShipSettings", "m_TimeOfDayToDespawn", "6.0"),
    "vehicle_collision_damage_reduction_factor": ("/Script/DuneSandbox.DuneVehicleSettings", "Vehicle.CollisionDamageReductionFactor", "0.010000"),
    "vehicle_collision_damage_reduction_cooldown_speed": ("/Script/DuneSandbox.DuneVehicleSettings", "Vehicle.CollisionDamageReductionCooldownSpeed", "1.000000"),
    "vehicle_access_token_duration": ("/Script/DuneSandbox.DuneVehicleSettings", "m_VehicleAccessTokenDuration", "120.000000"),
    "last_damage_dealt_time_threshold": ("/Script/DuneSandbox.DuneVehicleSettings", "m_LastDamageDealtTimeThreshold", "1.000000"),
    "ornithopter_in_air_distance_to_ground": ("/Script/DuneSandbox.DuneVehicleSettings", "m_OrnithopterInAirDistanceToGround", "300.000000"),
    "contracts_enabled": ("/Script/DuneSandbox.ContractsSubsystem", "m_bIsEnabled", "True"),
    "contracts_igw_support_enabled": ("/Script/DuneSandbox.ContractsSubsystem", "m_bIsIgwSupportEnabled", "True"),
    "max_contract_variations": ("/Script/DuneSandbox.ContractsSubsystem", "m_MaxContractVariationsNum", "5"),
    "max_global_contracts_per_server": ("/Script/DuneSandbox.ContractsSubsystem", "m_MaxGlobalContractsNumberPerServer", "10"),
    "group_available_contracts": ("/Script/DuneSandbox.ContractsSubsystem", "m_bShouldGroupAvailableContracts", "True"),
    "min_players_for_contract_spawn": ("/Script/DuneSandbox.ContractsSubsystem", "m_MinNumOfPlayersOnServerForContractSpawn", "1"),
    "contracts_tick_rate_seconds": ("/Script/DuneSandbox.ContractsSubsystem", "m_TickRateInSec", "1.000000"),
    "contracts_initial_tick_delay_seconds": ("/Script/DuneSandbox.ContractsSubsystem", "m_InitialTickDelayInSec", "1.000000"),
    "contract_spawn_delay_seconds": ("/Script/DuneSandbox.ContractsSubsystem", "m_ContractSpawnDelayInSec", "0.000000"),
    "contract_lifetime_check_delay_seconds": ("/Script/DuneSandbox.ContractsSubsystem", "m_ContractLifetimeCheckDelayInSec", "15.000000"),
    "contract_condition_check_distance": ("/Script/DuneSandbox.ContractsSubsystem", "m_ContractConditionCheckDistance", "100"),
    "contract_go_to_location_complete_distance": ("/Script/DuneSandbox.ContractsSubsystem", "m_ContractConditionGoToLocationCompleteDistance", "10"),
    "random_encounters_enabled": ("/Script/DuneSandbox.EncountersSubsystem", "m_bAreRandomEncountersEnabled", "True"),
    "encounter_area_limits_enabled": ("/Script/DuneSandbox.EncountersSubsystem", "m_bAreEncounterAreaLimitsEnabled", "True"),
    "encounter_nodes_enabled": ("/Script/DuneSandbox.EncountersSubsystem", "m_bAreEncounterNodesEnabled", "True"),
    "lift_underground_encounter_nodes": ("/Script/DuneSandbox.EncountersSubsystem", "m_bShouldLiftUndergroundEncounterNodes", "True"),
    "random_encounter_instigation_around_players": ("/Script/DuneSandbox.EncountersSubsystem", "m_bIsRandomEncounterInstigationAroundPlayersEnabled", "True"),
    "random_encounter_instigation_whole_server": ("/Script/DuneSandbox.EncountersSubsystem", "m_bIsRandomEncounterInstigationOnWholeServerEnabled", "True"),
    "random_encounter_instigation_whole_server_forced": ("/Script/DuneSandbox.EncountersSubsystem", "m_bIsRandomEncounterInstigationOnWholeServerForced", "False"),
    "random_encounter_instigation_by_area": ("/Script/DuneSandbox.EncountersSubsystem", "m_bIsRandomEncounterInstigationByAreaEnabled", "True"),
    "landsraad_enabled": ("/Script/DuneSandbox.LandsraadSettings", "bIsLandsraadEnabled", "True"),
    "spice_addiction_enabled": ("/Script/DuneSandbox.SpiceAddictionSubsystem", "m_bIsSpiceAddictionEnabled", "True"),
    "spice_vision_enabled": ("/Script/DuneSandbox.SpiceAddictionSubsystem", "m_bIsSpiceVisionEnabled", "True"),
    "taxation_enabled": ("/Script/DuneSandbox.TaxationSettings", "m_bTaxationEnabled", "False"),
    "taxation_cycle_length_seconds": ("/Script/DuneSandbox.TaxationSettings", "m_TaxationCycleLengthSeconds", "1209600"),
    "time_to_remove_paid_invoices": ("/Script/DuneSandbox.TaxationSettings", "m_TimeToRemovePaidInvoices", "2419200"),
    "spice_per_hour": ("/Script/DuneSandbox.TaxationSettings", "m_SpicePerHour", "11.904750"),
    "payment_item_per_hour": ("/Script/DuneSandbox.TaxationSettings", "m_PaymentItemPerHour", "11.905000"),
    "cross_map_respawn_drop_items": ("/Script/DuneSandbox.RespawnSettings", "m_bCrossMapRespawnDropItems", "True"),
    "manual_respawn_disabled": ("/Script/DuneSandbox.RespawnSettings", "m_ManualRespawnDisabled", '((Name="Arrakeen"),(Name="HarkoVillage"),(Name="NPE"),(Name="Overland"),(Name="ProcesVerbal"),(Name="ArtOfKanly"))'),
    "hazard_vehicle_quicksand_damage": ("/Script/DuneSandbox.HazardsSettings", "m_VehicleQuicksandDamage", "10000.000000"),
    "hazard_sandworm_quicksand_speed_modifier": ("/Script/DuneSandbox.HazardsSettings", "m_SandwormQuicksandSpeedModifier", "0.250000"),
    "hazard_death_delay_duration": ("/Script/DuneSandbox.HazardsSettings", "m_DeathDelayDuration", "3.000000"),
    "hazard_character_max_depth_effects_delay_duration": ("/Script/DuneSandbox.HazardsSettings", "m_CharacterMaxDepthEffectsDelayDuration", "5.500000"),
    "hazard_vehicle_max_depth_effects_delay_duration": ("/Script/DuneSandbox.HazardsSettings", "m_VehicleMaxDepthEffectsDelayDuration", "5.500000"),
    "patrol_ship_spawn_settings": ("/Script/DuneSandbox.PatrolShipSubSystem", "m_SpawnTimeSettings", "(m_TimeOfDayToSpawn=18.000000,m_TimeOfDayToDespawn=6.000000)"),
    "faction_tier_lock": ("/Script/DuneSandbox.FactionSettings", "m_FactionTierLock", "2"),
    "permission_max_permissions_per_actor": ("/Script/DuneSandbox.PermissionSettings", "m_MaxPermissionsPerActor", "32"),
    "party_social_range": ("/Script/DuneSandbox.PartySettings", "m_SocialRange", "1000000.000000"),
    "taxi_disable_travel_to": ("/Script/DuneSandbox.TaxiService", "m_DisableTravelTo", "()"),
    "taxi_disable_travel_from": ("/Script/DuneSandbox.TaxiService", "m_DisableTravelFrom", "()"),
    "character_recustomizer_cost": ("/Script/DuneSandbox.CharacterRecustomizerSubsystem", "m_CostAmount", "5000"),
    "global_loot_rights_behaviour": ("/Script/DuneSandbox.LootSettings", "GlobalLootRightsBehaviour", "PerPlayerChestAndNpcDrop"),
    "guild_settings_creation_cost": ("/Script/DuneSandbox.GuildSettings", "m_GuildCreationCost", "1000"),
    "guild_settings_max_guilds_allowed": ("/Script/DuneSandbox.GuildSettings", "m_MaxGuildsAllowed", "3"),
    "guild_settings_max_guild_members_allowed": ("/Script/DuneSandbox.GuildSettings", "m_MaxGuildMembersAllowed", "32"),
    "guild_settings_max_pending_invites": ("/Script/DuneSandbox.GuildSettings", "m_MaxPendingGuildInvitesAllowed", "10"),
    "augment_jackpot_roll_percentage": ("/Script/DuneSandbox.AugmentSettings", "m_JackpotRollPercentage", "0.950000"),
    "augment_max_ranged_weapon_augments": ("/Script/DuneSandbox.AugmentSettings", "m_MaxRangedWeaponAugments", "3"),
    "augment_max_melee_weapon_augments": ("/Script/DuneSandbox.AugmentSettings", "m_MaxMeleeWeaponAugments", "3"),
    "augment_max_armor_augments": ("/Script/DuneSandbox.AugmentSettings", "m_MaxArmorAugments", "2"),
    "reveal_distributed_tech_item": ("/Script/DuneSandbox.TechKnowledgeSettings", "m_bRevealItemOnDistributedToCharacter", "False"),
}

# Synthetic Global-scope fields for Dual Deep Desert's PvP/PvE partition selectors: value is
# a partition id, add/remove touch only that exact `+m_Pvp/PveEnabledPartitions=<value>` array
# line (see profile_remove_key's value= match) -- never a blanket clear, since Global scope is
# one shared section for the whole battlegroup and could hold unrelated admin-added entries.
GLOBAL_ARRAY_FIELD_IDS = {
    "global_pvp_enabled_partition_add", "global_pvp_enabled_partition_remove",
    "global_pve_enabled_partition_add", "global_pve_enabled_partition_remove",
}

DEEPDESERT_MATCHMAKER_SECTION = "/Script/DuneSandbox.MatchmakerEventsSettings"
DEEPDESERT_MATCHMAKER_KEY = "m_BattlegroupsAllMapSettings"
DEEPDESERT_MATCHMAKER_FIRST_OF_GROUP = '(MapName="DeepDesert_1",MapSettings=(SelectionRule="FirstOfGroup",MaxPlayerCapacity=100,IsStartingMap=False))'
DEEPDESERT_MATCHMAKER_HOME_DIMENSION = '(MapName="DeepDesert_1",MapSettings=(SelectionRule="HomeDimension",MaxPlayerCapacity=100,IsStartingMap=False))'

PARTITION_FIELDS = {
    "partition_pvp_enabled": (None, None, "False"),
    "partition_pve_enabled": (None, None, "False"),
    **MAP_FIELDS,
}

SCOPED_ENGINE_FIELDS = {
    key: spec for key, spec in ENGINE_FIELDS.items()
    if key not in {"port", "igw_port", "server_display_name", "server_login_password"}
}
MAP_ENGINE_FIELDS = dict(SCOPED_ENGINE_FIELDS)
PARTITION_ENGINE_FIELDS = {
    "server_display_name": ENGINE_FIELDS["server_display_name"],
    "server_login_password": ENGINE_FIELDS["server_login_password"],
    **SCOPED_ENGINE_FIELDS,
}

PROTECTED_ENGINE_FIELDS = {"server_display_name", "server_login_password"}


def known_keys_by_section(fields: dict[str, tuple[str | None, str | None, str | None]]) -> dict[str, set[str]]:
    known: dict[str, set[str]] = {}
    for section, key, _ in fields.values():
        if section and key:
            known.setdefault(section, set()).add(key)
    return known


# Which ini sections are legitimate for each engine-family scope, derived from the
# schema itself (not hand-listed) so a future field added under a new section is
# automatically allowed here without a second edit.
ENGINE_ALLOWED_SECTIONS_BY_SCOPE = {
    "Engine": set(known_keys_by_section(ENGINE_FIELDS)),
    "MapEngine": set(known_keys_by_section(MAP_ENGINE_FIELDS)),
    "PartitionEngine": set(known_keys_by_section(PARTITION_ENGINE_FIELDS)),
}
# Section names that only ever appear in Engine-family schemas (URL/ConsoleVariables) --
# no GLOBAL/MAP/PARTITION UserGame field ever uses either name. The Advanced UserGame.ini
# tab's raw editor has no section allowlist of its own (UserGame's schema uses too many
# distinct /Script/... section names to enumerate), so this narrow denylist is what stops
# UserEngine content -- now rendered with the same Global/Map/Partition header vocabulary
# as UserGame, see ENGINE_HEADER_DISPLAY_NAMES below -- from being silently accepted if
# pasted into the wrong tab.
ENGINE_EXCLUSIVE_INI_SECTIONS = set().union(*ENGINE_ALLOWED_SECTIONS_BY_SCOPE.values())
RESET_PRESERVED_ENGINE_FIELDS = {"port", "igw_port", "server_display_name", "server_login_password"}
PROFILE_HEADER_ORDER = {
    "Engine": 0,
    "Global": 1,
    "MapEngine": 2,
    "Map": 3,
    "PartitionEngine": 4,
    "Partition": 5,
}
ENGINE_PROFILE_SCOPES = {"Engine", "MapEngine", "PartitionEngine"}
# The Advanced UserEngine.ini tab displays/accepts UserGame's Global/Map/Partition
# vocabulary for readability, translated to/from the internal Engine/MapEngine/
# PartitionEngine tags at the profile_engine_text()/profile_engine_write_encoded()
# boundary only -- internal storage (and every already-saved gameplay-profile.ini)
# keeps using the internal tags, never touched by this translation.
ENGINE_HEADER_DISPLAY_NAMES = {"Engine": "Global", "MapEngine": "Map", "PartitionEngine": "Partition"}
ENGINE_HEADER_INTERNAL_NAMES = {v: k for k, v in ENGINE_HEADER_DISPLAY_NAMES.items()}
# Derived from ENGINE_HEADER_DISPLAY_NAMES's own values rather than hardcoded, so a
# future tier added to that dict can't silently drift out of sync with this regex.
_ENGINE_DISPLAY_HEADER_RE = re.compile(
    r"^\[(" + "|".join(re.escape(name) for name in ENGINE_HEADER_DISPLAY_NAMES.values()) + r"):(.*)\]$"
)
# Legacy DuneGameMode keys that a newer, canonical field also writes to a
# different section under the same effective setting. Showing both in the
# structured editor gives admins two controls for one effective setting and
# makes the legacy value silently win in some cases, so metadata() hides the
# legacy id and mirror_legacy_profile_field()/sync_legacy_values() keep the
# legacy ini key and any already-saved legacy value in sync with the canonical
# one instead.
LEGACY_FIELD_ALIASES = {
    "guild_creation_cost": "guild_settings_creation_cost",
    "max_guilds_allowed": "guild_settings_max_guilds_allowed",
    "max_guild_members_allowed": "guild_settings_max_guild_members_allowed",
    "cycle_duration_in_days": "coriolis_cycle_duration_days",
    "db_wipe_enabled": "coriolis_db_wipe_enabled",
}

# UTC regional master schedules for coriolis_cycle_start_hour and
# coriolis_cycle_start_day. These are the authoritative copies --
# console/web/src/features/maps/MapsPanel.tsx keeps its own copies in sync
# (checked by test_coriolis_region_hours_match_field_description and
# test_coriolis_region_days_match_field_description in
# test_profile_override_precedence.py) because the console frontend renders
# each Match Region toggle's inference without a round trip, but the only
# scope-mutating write happens here, from migrate_coriolis_region_fields.
CORIOLIS_REGION_HOURS = {
    "Europe": 5,
    "North America": 11,
    "South America": 8,
    "Asia": 9,
    "Oceania": 19,
}
CORIOLIS_REGION_DAYS = {
    "Europe": 3,
    "North America": 3,
    "South America": 3,
    "Asia": 2,
    "Oceania": 2,
}
# Every region key must resolve on both tables, or a region migrates one
# field but not the other with no way for an admin to tell that happened --
# migrate_coriolis_region_fields relies on this to treat "unmapped" as a
# single yes/no question asked once, not per field.
assert set(CORIOLIS_REGION_HOURS) == set(CORIOLIS_REGION_DAYS)
CORIOLIS_REGION_MIGRATION_FIELDS = (
    ("coriolis_cycle_start_hour", CORIOLIS_REGION_HOURS),
    ("coriolis_cycle_start_day", CORIOLIS_REGION_DAYS),
)


def migrate_coriolis_region_fields(region: str) -> str:
    """One-time, idempotent global-scope migration: for each of
    coriolis_cycle_start_hour/_day, if this deployment's region has a known
    regional value and the field has never been explicitly saved (the ini key
    is absent, not merely equal to the schema default -- those are different
    questions, see sync_legacy_values for the same distinction made the wrong
    way once already), write the region's value once. Both fields are read
    and written in a single profile pass so a startup that needs to migrate
    both never leaves one written and the other not from a race or a crash
    between two separate read-modify-write cycles. Safe to call on every
    startup: idempotent by key presence per field, so it can never loop or
    re-fire once a key exists, regardless of what value it holds.
    """
    if region not in CORIOLIS_REGION_HOURS:
        return "skip:unmapped-region"
    profile = read_profile()
    migrated = []
    for field_id, region_table in CORIOLIS_REGION_MIGRATION_FIELDS:
        section, ini_key, _ = MAP_FIELDS[field_id]
        if profile_get_key(profile, "global", section, ini_key) is not None:
            continue
        regional_value = region_table[region]
        set_profile_field(profile, "global", "", "", field_id, str(regional_value))
        migrated.append(f"{field_id}={regional_value}")
    if not migrated:
        return "skip:already-present"
    write_profile(profile)
    return "migrated:" + ",".join(migrated)


def field_spec(field_id: str):
    if field_id in ENGINE_FIELDS:
        return ENGINE_FIELDS[field_id]
    if field_id in MAP_FIELDS:
        return MAP_FIELDS[field_id]
    if field_id in PARTITION_FIELDS:
        return PARTITION_FIELDS[field_id]
    return None


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        return {"engine": {}, "maps": {}, "partitions": {}}
    try:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"engine": {}, "maps": {}, "partitions": {}}
    config.setdefault("engine", {})
    config.setdefault("maps", {})
    config.setdefault("partitions", {})
    return config


def atomic_write_text(path: Path, content: str, mode: int = PRIVATE_SETTINGS_MODE) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        # NamedTemporaryFile creates with 0600, so password-bearing content is
        # never briefly exposed between creation and chmod.
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.tmp.",
            delete=False,
        ) as tmp:
            tmp.write(content)
            tmp.flush()
            os.fsync(tmp.fileno())
            tmp_path = Path(tmp.name)
        tmp_path.chmod(mode)
        apply_host_ownership(tmp_path)
        tmp_path.replace(path)
        path.chmod(mode)
        apply_host_ownership(path)
    finally:
        if "tmp_path" in locals() and tmp_path.exists():
            tmp_path.unlink()


def secure_managed_settings_permissions() -> None:
    """Restrict settings files that can contain server credentials.

    The game must consume its login password in clear text, so filesystem
    access control is the protection boundary. This also upgrades files made
    by older releases before any command reads or rewrites them.
    """
    game_root = Path(os.environ.get("DUNE_USERSETTINGS_GAME_ROOT", str(ROOT / "runtime" / "game")))
    candidates = [CONFIG_PATH, PROFILE_PATH, SIETCH_CONFIG_PATH]
    candidates.extend(game_root.glob("*/Saved/UserSettings/UserEngine.ini"))
    candidates.extend(game_root.glob("*/Saved/UserSettings/UserGame.ini"))
    for path in candidates:
        try:
            if path.is_file():
                path.chmod(PRIVATE_SETTINGS_MODE)
        except OSError:
            # Read-only mounts are still safe to inspect, and the caller will
            # report a useful error if it later needs to update the file.
            pass


def save_config(config: dict) -> None:
    atomic_write_text(CONFIG_PATH, json.dumps(config, indent=2, sort_keys=True) + "\n")


def empty_profile() -> dict:
    return {"preamble": [], "sections": []}


def parse_profile_text(text: str) -> dict:
    profile = empty_profile()
    current = None
    for raw in text.splitlines():
        stripped = raw.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            header = stripped[1:-1]
            scope = parse_profile_header(header)
            current = {"header": header, **scope, "lines": []}
            profile["sections"].append(current)
            continue
        if current is None:
            profile["preamble"].append(raw)
        else:
            current["lines"].append(raw)
    return profile


def read_profile() -> dict:
    if not PROFILE_PATH.exists():
        return seed_profile_from_legacy_config()
    return parse_profile_text(PROFILE_PATH.read_text(encoding="utf-8", errors="replace"))


def read_profile_text() -> str:
    if PROFILE_PATH.exists():
        return PROFILE_PATH.read_text(encoding="utf-8", errors="replace")
    return serialize_profile(seed_profile_from_legacy_config())


def preflight_persisted_settings() -> int:
    """Validate the saved source of truth without silently seeding defaults."""
    if PROFILE_PATH.exists():
        try:
            profile = parse_profile_text(PROFILE_PATH.read_text(encoding="utf-8", errors="replace"))
        except OSError as error:
            print(f"Gameplay settings profile is not readable: {error}", file=sys.stderr)
            return 1
    elif CONFIG_PATH.exists():
        try:
            config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            print(f"Legacy gameplay settings are not readable: {error}", file=sys.stderr)
            return 1
        if not isinstance(config, dict):
            print("Legacy gameplay settings must contain a JSON object.", file=sys.stderr)
            return 1
        profile = seed_profile_from_legacy_config()
    else:
        print("No persisted gameplay settings source was found.", file=sys.stderr)
        print("Refusing a scheduled restart instead of starting maps with defaults.", file=sys.stderr)
        return 1

    try:
        validate_profile_port_ranges(profile)
    except (TypeError, ValueError) as error:
        print(f"Gameplay settings validation failed: {error}", file=sys.stderr)
        return 1
    print("Gameplay settings preflight passed.")
    return 0


def write_profile(profile: dict) -> None:
    strip_retired_usergame_profile_lines(profile)
    prune_empty_profile_sections(profile)
    atomic_write_text(PROFILE_PATH, serialize_profile(profile))


def write_profile_text(content: str) -> None:
    PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)
    parse_profile_text(content)
    atomic_write_text(PROFILE_PATH, content if content.endswith("\n") else content + "\n")


def serialize_profile(profile: dict) -> str:
    lines: list[str] = []
    lines.extend(profile.get("preamble", []))
    for section in sorted_profile_sections(profile.get("sections", [])):
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(f"[{section['header']}]")
        lines.extend(section.get("lines", []))
    return "\n".join(lines).rstrip() + "\n"


def prune_empty_profile_sections(profile: dict) -> None:
    profile["sections"] = [
        section for section in profile.get("sections", [])
        if any(str(line).strip() for line in section.get("lines", []))
    ]


def strip_retired_usergame_profile_lines(profile: dict) -> None:
    """Remove retired catalogue keys from UserGame-family profile blocks.

    Engine-family blocks are deliberately ignored: a custom ConsoleVariable
    with the same text is a different namespace and must remain untouched.
    """
    retired = known_keys_by_section(RETIRED_USERGAME_FIELDS)
    for block in profile.get("sections", []):
        if block.get("scope") in ENGINE_PROFILE_SCOPES:
            continue
        section = str(block.get("ini_section", ""))
        keys = retired.get(section, set())
        if not keys:
            continue
        block["lines"] = [
            raw for raw in block.get("lines", [])
            if not ((parsed := split_ini_assignment(raw)) and parsed[1] in keys)
        ]


def sorted_profile_sections(sections: list[dict]) -> list[dict]:
    return sorted(
        sections,
        key=lambda section: (
            PROFILE_HEADER_ORDER.get(str(section.get("scope", "")), 99),
            str(section.get("map", "")),
            int(section.get("partition") or 0) if str(section.get("partition", "")).isdigit() else str(section.get("partition", "")),
            str(section.get("ini_section", "")),
        ),
    )


def parse_profile_header(header: str) -> dict:
    parts = header.split(":")
    if len(parts) >= 2 and parts[0] == "Global":
        return {"scope": "Global", "map": "", "partition": "", "ini_section": ":".join(parts[1:])}
    if len(parts) >= 3 and parts[0] == "Map":
        return {"scope": "Map", "map": canonical_map(parts[1]), "partition": "", "ini_section": ":".join(parts[2:])}
    if len(parts) >= 3 and parts[0] == "MapEngine":
        return {"scope": "MapEngine", "map": canonical_map(parts[1]), "partition": "", "ini_section": ":".join(parts[2:])}
    if len(parts) >= 4 and parts[0] == "Partition":
        return {"scope": "Partition", "map": canonical_map(parts[1]), "partition": parts[2], "ini_section": ":".join(parts[3:])}
    if len(parts) >= 4 and parts[0] == "PartitionEngine":
        return {"scope": "PartitionEngine", "map": canonical_map(parts[1]), "partition": parts[2], "ini_section": ":".join(parts[3:])}
    if len(parts) >= 2 and parts[0] == "Engine":
        return {"scope": "Engine", "map": "", "partition": "", "ini_section": ":".join(parts[1:])}
    return {"scope": "Raw", "map": "", "partition": "", "ini_section": header}


def profile_header(scope: str, section: str, map_name: str = "", partition_id: str = "") -> str:
    if scope == "engine":
        return f"Engine:{section}"
    if scope == "global":
        return f"Global:{section}"
    if scope == "map":
        return f"Map:{canonical_map(map_name)}:{section}"
    if scope == "map_engine":
        return f"MapEngine:{canonical_map(map_name)}:{section}"
    if scope == "partition":
        return f"Partition:{canonical_map(map_name)}:{partition_id}:{section}"
    if scope == "partition_engine":
        return f"PartitionEngine:{canonical_map(map_name)}:{partition_id}:{section}"
    raise SystemExit(f"Unknown profile scope: {scope}")


def find_profile_section(profile: dict, scope: str, section: str, map_name: str = "", partition_id: str = "", create: bool = False) -> dict | None:
    target_scope = {
        "engine": "Engine",
        "global": "Global",
        "map": "Map",
        "map_engine": "MapEngine",
        "partition": "Partition",
        "partition_engine": "PartitionEngine",
    }[scope]
    target_map = canonical_map(map_name) if map_name else ""
    target_partition = str(partition_id or "")
    for block in profile.get("sections", []):
        if block.get("scope") != target_scope or block.get("ini_section") != section:
            continue
        if target_scope in {"Map", "MapEngine"} and block.get("map") != target_map:
            continue
        if target_scope in {"Partition", "PartitionEngine"} and (block.get("map") != target_map or str(block.get("partition", "")) != target_partition):
            continue
        return block
    if not create:
        return None
    block = {
        "header": profile_header(scope, section, target_map, target_partition),
        "scope": target_scope,
        "map": target_map,
        "partition": target_partition,
        "ini_section": section,
        "lines": [],
    }
    profile.setdefault("sections", []).append(block)
    return block


def split_ini_assignment(line: str) -> tuple[str, str, str] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith((";", "#")) or "=" not in stripped:
        return None
    left, right = stripped.split("=", 1)
    left = left.strip()
    prefix = ""
    if left.startswith(("+", "-", ".", "!")):
        prefix = left[0]
        left = left[1:]
    return prefix, left.strip(), right.strip()


def split_unreal_struct(value: str) -> list[str]:
    raw = value.strip()
    if raw.startswith("(") and raw.endswith(")"):
        raw = raw[1:-1]
    parts: list[str] = []
    start = 0
    depth = 0
    quote = ""
    escaped = False
    for index, char in enumerate(raw):
        if escaped:
            escaped = False
            continue
        if char == "\\" and quote:
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = ""
            continue
        if char in {'"', "'"}:
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth = max(0, depth - 1)
        elif char == "," and depth == 0:
            parts.append(raw[start:index].strip())
            start = index + 1
    tail = raw[start:].strip()
    if tail:
        parts.append(tail)
    return parts


def unreal_struct_values(value: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for part in split_unreal_struct(value):
        if "=" not in part:
            continue
        key, member_value = part.split("=", 1)
        values[key.strip()] = member_value.strip()
    return values


def update_unreal_struct(value: str, member: str, member_value: str) -> str:
    parts = split_unreal_struct(value)
    updated = False
    for index, part in enumerate(parts):
        if "=" not in part:
            continue
        key, _ = part.split("=", 1)
        if key.strip() == member:
            parts[index] = f"{member}={member_value}"
            updated = True
            break
    if not updated:
        parts.append(f"{member}={member_value}")
    return f"({','.join(parts)})"


def normalize_landsraad_data_value(field_id: str, value: str) -> str:
    _, _, field_type, minimum, maximum = LANDSRAAD_DATA_FIELDS[field_id]
    raw = str(value).strip()
    if field_type == "boolean":
        if raw.lower() not in {"true", "false", "1", "0", "yes", "no", "on", "off"}:
            raise SystemExit(f"{field_id} must be True or False.")
        return "True" if truthy(raw) else "False"
    try:
        number = int(raw) if field_type == "integer" else float(raw)
    except ValueError as exc:
        raise SystemExit(f"{field_id} must be a valid number.") from exc
    if minimum is not None and number < minimum:
        raise SystemExit(f"{field_id} must be at least {minimum}.")
    if maximum is not None and number > maximum:
        raise SystemExit(f"{field_id} must be at most {maximum}.")
    if field_type == "integer":
        return str(number)
    return format(number, ".6f").rstrip("0").rstrip(".") or "0"


def normalize_coriolis_cycle_start_value(field_id: str, value: str) -> str:
    minimum, maximum = CORIOLIS_CYCLE_START_BOUNDS[field_id]
    raw = str(value).strip()
    if not re.fullmatch(r"-?\d+", raw):
        raise SystemExit(f"{FIELD_LABELS[field_id]} must be a whole number.")
    number = int(raw)
    if number < minimum or number > maximum:
        raise SystemExit(f"{FIELD_LABELS[field_id]} must be between {minimum} and {maximum}.")
    return str(number)


def normalize_augment_jackpot_roll_percentage(value: str) -> str:
    raw = str(value or "").strip()
    try:
        number = float(raw)
    except ValueError as exc:
        raise SystemExit("Augment Jackpot Roll Threshold must be a number between 0 and 1.") from exc
    minimum, maximum = AUGMENT_JACKPOT_ROLL_BOUNDS
    if not math.isfinite(number) or number < minimum or number > maximum:
        raise SystemExit("Augment Jackpot Roll Threshold must be between 0 and 1.")
    return raw


def landsraad_data_for_scope(profile: dict, scope: str, map_name: str = "", partition_id: str = "") -> str:
    value = profile_get_key(profile, scope, LANDSRAAD_SETTINGS_SECTION, LANDSRAAD_DATA_KEY, map_name, partition_id)
    if not value:
        return LANDSRAAD_DATA_TEMPLATE
    current_parts = split_unreal_struct(value)
    current_members = unreal_struct_values(value)
    for part in split_unreal_struct(LANDSRAAD_DATA_TEMPLATE):
        if "=" not in part:
            continue
        member = part.split("=", 1)[0].strip()
        if member not in current_members:
            current_parts.append(part)
    return f"({','.join(current_parts)})"


def landsraad_virtual_values(data: str) -> dict[str, str]:
    members = unreal_struct_values(data)
    return {
        field_id: members.get(member, default)
        for field_id, (member, default, _field_type, _minimum, _maximum) in LANDSRAAD_DATA_FIELDS.items()
    }


def profile_get_key(profile: dict, scope: str, section: str, key: str, map_name: str = "", partition_id: str = "") -> str | None:
    block = find_profile_section(profile, scope, section, map_name, partition_id)
    if not block:
        return None
    for raw in reversed(block.get("lines", [])):
        parsed = split_ini_assignment(raw)
        if not parsed:
            continue
        prefix, left, right = parsed
        if not prefix and left == key:
            return right.strip().strip('"')
    return None


def profile_get_raw_key(profile: dict, section: str, key: str) -> str | None:
    for block in profile.get("sections", []):
        if block.get("scope") != "Raw" or block.get("ini_section") != section:
            continue
        for raw in reversed(block.get("lines", [])):
            parsed = split_ini_assignment(raw)
            if not parsed:
                continue
            prefix, left, right = parsed
            if not prefix and left == key:
                return right.strip().strip('"')
    return None


def profile_array_contains(profile: dict, scope: str, section: str, key: str, value: str, map_name: str = "", partition_id: str = "") -> bool:
    block = find_profile_section(profile, scope, section, map_name, partition_id)
    if not block:
        return False
    for raw in block.get("lines", []):
        parsed = split_ini_assignment(raw)
        if not parsed:
            continue
        prefix, left, right = parsed
        if prefix == "+" and left == key and right == str(value):
            return True
    return False


def profile_set_key(profile: dict, scope: str, section: str, key: str, value: str, map_name: str = "", partition_id: str = "", prefix: str = "") -> None:
    # Every field-write path (bulk_save, legacy-config migration, guild-field
    # aliasing, staking-extension sync) funnels through this one function to
    # build a "key=value" line -- guard it here so none of those callers can
    # smuggle a newline/NUL that breaks out of the line into a new key or
    # [Section] once compiled_userengine_ini/compiled_usergame_ini render it.
    if "\n" in value or "\r" in value or "\x00" in value:
        raise SystemExit(f"{section}.{key} may not contain a newline or NUL character.")
    block = find_profile_section(profile, scope, section, map_name, partition_id, create=True)
    target_left = f"{prefix}{key}"
    target_index = None
    for index, raw in enumerate(block["lines"]):
        parsed = split_ini_assignment(raw)
        if not parsed:
            continue
        current_prefix, current_key, current_value = parsed
        if current_key != key:
            continue
        if prefix:
            if current_prefix == prefix and current_value == value:
                target_index = index
                break
            continue
        if current_prefix == prefix:
            target_index = index
    line = f"{target_left}={value}"
    if target_index is None:
        block["lines"].append(line)
    else:
        block["lines"][target_index] = line


def profile_remove_key(profile: dict, scope: str, section: str, key: str, map_name: str = "", partition_id: str = "", prefixes: set[str] | None = None, value: str | None = None) -> None:
    """Removes every line matching `key` (and, if given, restricted to `prefixes` and/or the
    exact `value`). Passing `value` turns this into an exact-entry removal for array-style
    `+key=value` lines -- e.g. Global-scope toggles (Dual Deep Desert's PvP/PvE partition
    selectors) use it to remove only the one entry they own, leaving any other value for the
    same key untouched, since a blanket prefix-only clear would delete unrelated entries
    sharing that one shared section."""
    block = find_profile_section(profile, scope, section, map_name, partition_id)
    if not block:
        return
    allowed_prefixes = prefixes
    out = []
    for raw in block.get("lines", []):
        parsed = split_ini_assignment(raw)
        if parsed:
            prefix, left, right = parsed
            if left == key and (allowed_prefixes is None or prefix in allowed_prefixes) and (value is None or right == str(value)):
                continue
        out.append(raw)
    block["lines"] = out


def strip_unsafe_staking_extension_lines(lines: list[str]) -> list[str]:
    """Remove raw staking-array fragments before rebuilding a complete array.

    Older releases exposed these array properties as scalar integer settings and
    emitted '-' directives for every packaged value. That can leave the arrays
    empty and crash the native server when a Staking Unit is deployed. Never
    materialize those legacy fragments directly into runtime configs.
    """
    safe: list[str] = []
    for raw in lines:
        parsed = split_ini_assignment(raw)
        if parsed and parsed[1] in UNSAFE_STAKING_EXTENSION_KEYS:
            continue
        safe.append(raw)
    return safe


def normalize_staking_extension_seconds(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if not re.fullmatch(r"(?:\d+(?:\.\d*)?|\.\d+)", text):
        raise SystemExit("Staking Unit extension time must be a number of seconds.")
    seconds = float(text)
    if seconds < 0.1 or seconds > 604800:
        raise SystemExit("Staking Unit extension time must be between 0.1 and 604800 seconds.")
    return f"{seconds:.6f}"


def append_safe_staking_extension_arrays(section_lines: dict[str, list[str]], values: dict[str, str]) -> None:
    for field_id, key in STAKING_EXTENSION_FIELDS.items():
        value = normalize_staking_extension_seconds(values.get(field_id, ""))
        if not value:
            continue
        entries = section_lines.setdefault(BUILDING_SETTINGS_SECTION, [])
        entries.append(f"!{key}=ClearArray")
        entries.extend(f".{key}={value}" for _ in range(STAKING_EXTENSION_ARRAY_LENGTH))


def mirror_legacy_profile_field(profile: dict, scope: str, map_name: str, partition_id: str, field_id: str, value: str) -> None:
    canonical_field = LEGACY_FIELD_ALIASES.get(field_id)
    if not canonical_field:
        return
    spec = MAP_FIELDS.get(canonical_field)
    if not spec or not spec[0] or not spec[1]:
        return
    if scope == "global":
        profile_set_key(profile, "global", spec[0], spec[1], value)
    elif scope == "map":
        profile_set_key(profile, "map", spec[0], spec[1], value, map_name=map_name)
    elif scope == "partition":
        profile_set_key(profile, "partition", spec[0], spec[1], value, canonical_map(map_name or "Survival_1"), str(partition_id or ""))


def _legacy_alias_scopes(scope: str, map_name: str = "", partition_id: str = "") -> list[tuple[str, str, str]]:
    """Scope chain to probe for LEGACY_FIELD_ALIASES presence, ordered least to most
    specific -- mirrors exactly what profile_global_values/profile_map_values/
    profile_partition_values merge for these fields (all of which live in MAP_FIELDS,
    never PARTITION_FIELDS, so global/map/partition is the complete chain)."""
    scopes = [("global", "", "")]
    if scope in ("map", "partition"):
        scopes.append(("map", map_name, ""))
    if scope == "partition":
        scopes.append(("partition", map_name, partition_id))
    return scopes


def _field_explicitly_present(profile: dict, field_id: str, scopes: list[tuple[str, str, str]]) -> bool:
    section, ini_key, _ = MAP_FIELDS[field_id]
    if not section or not ini_key:
        return False
    return any(profile_get_key(profile, s, section, ini_key, m, p) is not None for s, m, p in scopes)


def _effective_field_value(profile: dict, field_id: str, scopes: list[tuple[str, str, str]]) -> str:
    section, ini_key, default = MAP_FIELDS[field_id]
    value = str(default)
    for s, m, p in scopes:
        found = profile_get_key(profile, s, section, ini_key, m, p)
        if found is not None:
            value = found
    return value


def sync_legacy_values(profile: dict, values: dict[str, str], scope: str, map_name: str = "", partition_id: str = "") -> dict[str, str]:
    """Resolve each LEGACY_FIELD_ALIASES pair by presence, not by comparing values to
    their schema defaults. A value-comparison approach cannot distinguish "never saved"
    from "explicitly saved to a value that happens to equal the default", which let a
    stale legacy value silently outrank an admin's deliberate canonical save whenever
    that save happened to be the default (see legacy_alias_conflict_warnings for the
    admin-visible counterpart on the structured save path)."""
    scopes = _legacy_alias_scopes(scope, map_name, partition_id)
    for legacy_field, canonical_field in LEGACY_FIELD_ALIASES.items():
        legacy_default = str(MAP_FIELDS[legacy_field][2])
        canonical_default = str(MAP_FIELDS[canonical_field][2])
        if _field_explicitly_present(profile, canonical_field, scopes):
            # Canonical wins whenever it has been explicitly saved, regardless of value.
            values[legacy_field] = values.get(canonical_field, canonical_default)
        elif _field_explicitly_present(profile, legacy_field, scopes):
            values[canonical_field] = values.get(legacy_field, legacy_default)
        # Neither present: both fields stay at their already-seeded defaults.
    return values


def legacy_alias_conflict_warnings(profile: dict, scope: str, map_name: str = "", partition_id: str = "") -> list[str]:
    """Structured-save-path counterpart to _advanced_editor_legacy_field_warnings (the
    raw/Advanced editor's version of this same check): both the legacy and canonical id
    for one effective setting have been explicitly saved with different values.
    sync_legacy_values() resolves that silently in canonical's favor -- this is what lets
    an admin actually see it happened, the same way the raw editor already can."""
    if scope not in ("global", "map", "partition"):
        return []
    scopes = _legacy_alias_scopes(scope, map_name, partition_id)
    warnings = []
    for legacy_field, canonical_field in LEGACY_FIELD_ALIASES.items():
        if not (_field_explicitly_present(profile, legacy_field, scopes) and _field_explicitly_present(profile, canonical_field, scopes)):
            continue
        legacy_value = _effective_field_value(profile, legacy_field, scopes)
        canonical_value = _effective_field_value(profile, canonical_field, scopes)
        if legacy_value == canonical_value:
            continue
        legacy_section, legacy_key, _legacy_default = MAP_FIELDS[legacy_field]
        canonical_section, canonical_key, _canonical_default = MAP_FIELDS[canonical_field]
        # Both fields share the same ini key name (that's the whole reason they're aliased),
        # so the section is what actually tells an admin which block to go edit.
        warnings.append(
            f"legacy field [{legacy_section}] {legacy_key}={legacy_value} conflicts with the "
            f"canonical field [{canonical_section}] {canonical_key}={canonical_value} -- the canonical value is used."
        )
    return warnings


def seed_profile_from_legacy_config() -> dict:
    profile = empty_profile()
    profile["preamble"] = [
        "; UserGame.ini managed by Docker.",
        "; Edit this single file for all map and partition UserGame settings.",
        "; Docker applies the correct values to each server when maps start or restart.",
    ]
    config = load_config()
    for field_id, value in config.get("engine", {}).items():
        if field_id in PROTECTED_ENGINE_FIELDS:
            continue
        spec = ENGINE_FIELDS.get(field_id)
        if spec and spec[0] and spec[1]:
            profile_set_key(profile, "engine", spec[0], spec[1], str(value))
    for map_name, values in config.get("maps", {}).items():
        for field_id, value in values.items():
            spec = MAP_FIELDS.get(field_id)
            if spec and spec[0] and spec[1]:
                profile_set_key(profile, "map", spec[0], spec[1], str(value), map_name=canonical_map(map_name))
    for partition_id, entry in config.get("partitions", {}).items():
        map_name = canonical_map(str(entry.get("map") or "Survival_1"))
        for field_id, value in entry.get("userengine", {}).items():
            if field_id in PARTITION_ENGINE_FIELDS:
                set_profile_field(profile, "partition_engine", map_name, str(partition_id), field_id, str(value))
        for field_id, value in entry.get("usergame", {}).items():
            set_profile_field(profile, "partition", map_name, str(partition_id), field_id, str(value))
    return profile


def read_ini_value(path: Path, section: str | None, key: str | None) -> str | None:
    if not section or not key or not path.exists():
        return None
    current_section = None
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    for raw in lines:
        stripped = raw.strip()
        if not stripped or stripped.startswith(";") or stripped.startswith("#"):
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            current_section = stripped[1:-1]
            continue
        if current_section == section and "=" in stripped:
            left, right = stripped.split("=", 1)
            if left.strip() == key:
                return right.strip().strip('"')
    return None


def read_ini_array_contains(path: Path, section: str, key: str, value: str) -> bool:
    if not path.exists():
        return False
    current_section = None
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return False
    wanted_keys = {key, f"+{key}"}
    for raw in lines:
        stripped = raw.strip()
        if not stripped or stripped.startswith(";") or stripped.startswith("#"):
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            current_section = stripped[1:-1]
            continue
        if current_section == section and "=" in stripped:
            left, right = stripped.split("=", 1)
            if left.strip() in wanted_keys and right.strip() == str(value):
                return True
    return False


def read_ini_array_key_present(path: Path, section: str, keys: set[str]) -> bool:
    """Return whether any positive entry for one of ``keys`` exists.

    Unreal's partition selector is an allow-list: once a PvP/PvE selector
    array is present, an unlisted partition uses the PvE/default side of the
    split instead of falling back to the older map-wide PvP compatibility
    flags.  Presence therefore matters independently of membership.
    """
    if not path.exists():
        return False
    current_section = None
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return False
    wanted_keys = keys | {f"+{key}" for key in keys}
    for raw in lines:
        stripped = raw.strip()
        if not stripped or stripped.startswith((";", "#")):
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            current_section = stripped[1:-1]
            continue
        if current_section == section and "=" in stripped:
            left, _right = stripped.split("=", 1)
            if left.strip() in wanted_keys:
                return True
    return False


def update_ini_key(path: Path, section: str, key: str, value: str, append_prefix: str = "") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = path.with_suffix(path.suffix + ".lock")
    lock_path.touch(exist_ok=True)
    import fcntl

    with lock_path.open("r+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        if path.exists():
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        else:
            lines = []

        current_section = None
        section_start = None
        section_end = None
        target_index = None
        target_key = f"{append_prefix}{key}"

        for index, raw in enumerate(lines):
            stripped = raw.strip()
            if stripped.startswith("[") and stripped.endswith("]"):
                if current_section == section and section_end is None:
                    section_end = index
                current_section = stripped[1:-1]
                if current_section == section:
                    section_start = index
                continue
            if current_section == section and "=" in stripped and not stripped.startswith((";", "#")):
                left = stripped.split("=", 1)[0].strip()
                if left == target_key or (not append_prefix and left == key):
                    target_index = index

        if current_section == section and section_end is None:
            section_end = len(lines)

        new_line = f"{target_key}={value}"
        if target_index is not None:
            lines[target_index] = new_line
        elif section_start is not None:
            insert_at = section_end if section_end is not None else len(lines)
            lines.insert(insert_at, new_line)
        else:
            if lines and lines[-1].strip():
                lines.append("")
            lines.extend([f"[{section}]", new_line])

        atomic_write_text(path, "\n".join(lines) + "\n")


def remove_ini_array_key(path: Path, section: str, key: str) -> None:
    if not path.exists():
        return
    import fcntl

    lock_path = path.with_suffix(path.suffix + ".lock")
    lock_path.touch(exist_ok=True)
    with lock_path.open("r+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        current_section = None
        out = []
        for raw in lines:
            stripped = raw.strip()
            if stripped.startswith("[") and stripped.endswith("]"):
                current_section = stripped[1:-1]
                out.append(raw)
                continue
            if current_section == section and "=" in stripped and not stripped.startswith((";", "#")):
                left = stripped.split("=", 1)[0].strip()
                if left in {key, f"+{key}"}:
                    continue
            out.append(raw)
        atomic_write_text(path, "\n".join(out) + "\n")


def remove_ini_key(path: Path, section: str, key: str) -> None:
    if not path.exists():
        return
    import fcntl

    lock_path = path.with_suffix(path.suffix + ".lock")
    lock_path.touch(exist_ok=True)
    with lock_path.open("r+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        current_section = None
        out = []
        for raw in lines:
            stripped = raw.strip()
            if stripped.startswith("[") and stripped.endswith("]"):
                current_section = stripped[1:-1]
                out.append(raw)
                continue
            if current_section == section and "=" in stripped and not stripped.startswith((";", "#")):
                left = stripped.split("=", 1)[0].strip()
                if left == key:
                    continue
            out.append(raw)
        atomic_write_text(path, "\n".join(out) + "\n")


def canonical_map(value: str) -> str:
    target = value.strip().lower()
    aliases = {
        "survival": "Survival_1",
        "survival-1": "Survival_1",
        "survival_1": "Survival_1",
        "deepdesert": "DeepDesert_1",
        "deepdesert-1": "DeepDesert_1",
        "deepdesert_1": "DeepDesert_1",
        "overmap": "Overmap",
    }
    if target in aliases:
        return aliases[target]
    return value


def max_survival_dimensions() -> int:
    if SIETCH_CONFIG_PATH.exists():
        config = json.loads(SIETCH_CONFIG_PATH.read_text(encoding="utf-8"))
        value = config.get("maps", {}).get("Survival_1", {}).get("max_dimensions")
        try:
            parsed = int(value)
            if parsed > 0:
                return parsed
        except (TypeError, ValueError):
            pass
    return 4


def validate_port_ranges(config: dict, field_id: str, value: str) -> None:
    try:
        candidate = int(value)
    except ValueError as exc:
        raise SystemExit(f"{field_id} must be a positive integer.") from exc
    if candidate <= 0:
        raise SystemExit(f"{field_id} must be a positive integer.")

    engine = dict(config.get("engine", {}))
    engine[field_id] = str(candidate)
    client_start = int(engine.get("port") or ENGINE_FIELDS["port"][2])
    igw_start = int(engine.get("igw_port") or ENGINE_FIELDS["igw_port"][2])
    end_offset = max_survival_dimensions()
    client_end = client_start + end_offset
    igw_end = igw_start + end_offset
    if not (client_end < igw_start or igw_end < client_start):
        raise SystemExit(
            f"Configured Port range {client_start}-{client_end} intersects with IGWPort range {igw_start}-{igw_end}."
        )


def validate_profile_port_ranges(profile: dict) -> None:
    engine = profile_engine_values(profile)
    try:
        client_start = int(engine.get("port") or ENGINE_FIELDS["port"][2])
        igw_start = int(engine.get("igw_port") or ENGINE_FIELDS["igw_port"][2])
    except ValueError as exc:
        raise SystemExit("Port and IGWPort must be positive integers.") from exc
    if client_start <= 0 or igw_start <= 0:
        raise SystemExit("Port and IGWPort must be positive integers.")
    end_offset = max_survival_dimensions()
    client_end = client_start + end_offset
    igw_end = igw_start + end_offset
    if not (client_end < igw_start or igw_end < client_start):
        raise SystemExit(
            f"Configured Port range {client_start}-{client_end} intersects with IGWPort range {igw_start}-{igw_end}."
        )


def set_profile_field(profile: dict, scope: str, map_name: str, partition_id: str, field_id: str, value: str) -> None:
    if field_id in LANDSRAAD_DATA_FIELDS:
        if scope != "global":
            raise SystemExit("Landsraad schedule and contract modifiers must use global scope.")
        member = LANDSRAAD_DATA_FIELDS[field_id][0]
        normalized = normalize_landsraad_data_value(field_id, value)
        current = landsraad_data_for_scope(profile, "global")
        profile_set_key(
            profile,
            "global",
            LANDSRAAD_SETTINGS_SECTION,
            LANDSRAAD_DATA_KEY,
            update_unreal_struct(current, member, normalized),
        )
        return
    if scope == "engine":
        if field_id not in ENGINE_FIELDS:
            raise SystemExit(f"Unknown engine field: {field_id}")
        if field_id in PROTECTED_ENGINE_FIELDS:
            return
        spec = ENGINE_FIELDS[field_id]
        if spec[0] and spec[1]:
            profile_set_key(profile, "engine", spec[0], spec[1], normalize_engine_field_value(field_id, value))
        return

    if scope == "map_engine":
        if field_id not in MAP_ENGINE_FIELDS:
            raise SystemExit(f"Unknown map engine field: {field_id}")
        spec = MAP_ENGINE_FIELDS[field_id]
        if spec[0] and spec[1]:
            if value == "":
                profile_remove_key(profile, "map_engine", spec[0], spec[1], map_name)
            else:
                profile_set_key(profile, "map_engine", spec[0], spec[1], normalize_engine_field_value(field_id, value), map_name)
        return

    if scope == "partition_engine":
        if field_id not in PARTITION_ENGINE_FIELDS:
            raise SystemExit(f"Unknown partition engine field: {field_id}")
        target_map = canonical_map(map_name or "Survival_1")
        target_partition = str(partition_id or "").strip()
        if not target_partition:
            raise SystemExit("Partition engine save requires a partition id.")
        spec = PARTITION_ENGINE_FIELDS[field_id]
        if spec[0] and spec[1]:
            if field_id in {"server_display_name", "server_login_password"}:
                profile_remove_key(profile, "partition", spec[0], spec[1], target_map, target_partition)
            if value == "":
                profile_remove_key(profile, "partition_engine", spec[0], spec[1], target_map, target_partition)
            else:
                profile_set_key(profile, "partition_engine", spec[0], spec[1], normalize_engine_field_value(field_id, value), target_map, target_partition)
        return

    if field_id in STAKING_EXTENSION_FIELDS:
        if scope not in {"global", "map", "partition"}:
            raise SystemExit("Staking Unit extension time must use global, map, or partition scope.")
        normalized = normalize_staking_extension_seconds(value)
        target_map = canonical_map(map_name or "Survival_1") if scope != "global" else ""
        target_partition = str(partition_id or "").strip() if scope == "partition" else ""
        if scope == "partition" and not target_partition:
            raise SystemExit("Partition save requires a partition id.")
        key = STAKING_EXTENSION_FIELDS[field_id]
        profile_remove_key(
            profile,
            scope,
            BUILDING_SETTINGS_SECTION,
            key,
            target_map,
            target_partition,
        )
        if normalized:
            profile_set_key(
                profile,
                scope,
                BUILDING_SETTINGS_SECTION,
                key,
                normalized,
                target_map,
                target_partition,
            )
        return

    if field_id in CORIOLIS_CYCLE_START_BOUNDS:
        value = normalize_coriolis_cycle_start_value(field_id, value)
    if field_id == "augment_jackpot_roll_percentage":
        value = normalize_augment_jackpot_roll_percentage(value)

    if scope == "global":
        if field_id in GLOBAL_ARRAY_FIELD_IDS:
            partition_value = str(value or "").strip()
            if not partition_value:
                return
            array_key = "m_PvpEnabledPartitions" if "pvp" in field_id else "m_PveEnabledPartitions"
            if field_id.endswith("_add"):
                profile_set_key(profile, "global", "/Script/DuneSandbox.PvpPveSettings", array_key, partition_value, prefix="+")
            else:
                profile_remove_key(profile, "global", "/Script/DuneSandbox.PvpPveSettings", array_key, prefixes={"+"}, value=partition_value)
            return
        if field_id not in MAP_FIELDS:
            raise SystemExit(f"Unknown global UserGame field: {field_id}")
        spec = MAP_FIELDS[field_id]
        if spec[0] and spec[1]:
            profile_set_key(profile, "global", spec[0], spec[1], value)
            mirror_legacy_profile_field(profile, "global", "", "", field_id, value)
        return

    if scope == "map":
        if field_id not in MAP_FIELDS:
            raise SystemExit(f"Unknown map field: {field_id}")
        spec = MAP_FIELDS[field_id]
        if spec[0] and spec[1]:
            profile_set_key(profile, "map", spec[0], spec[1], value, map_name=map_name)
            mirror_legacy_profile_field(profile, "map", map_name, "", field_id, value)
        return

    if scope == "partition":
        if field_id not in PARTITION_FIELDS:
            raise SystemExit(f"Unknown partition field: {field_id}")
        target_map = canonical_map(map_name or "Survival_1")
        target_partition = str(partition_id or "").strip()
        if not target_partition:
            raise SystemExit("Partition save requires a partition id.")
        if field_id == "partition_pvp_enabled":
            profile_remove_key(profile, "partition", "/Script/DuneSandbox.PvpPveSettings", "m_PvpEnabledPartitions", target_map, target_partition, {"+"})
            if truthy(value):
                profile_set_key(profile, "partition", "/Script/DuneSandbox.PvpPveSettings", "m_PvpEnabledPartitions", target_partition, target_map, target_partition, "+")
            return
        if field_id == "partition_pve_enabled":
            profile_remove_key(profile, "partition", "/Script/DuneSandbox.PvpPveSettings", "m_PveEnabledPartitions", target_map, target_partition, {"+"})
            if truthy(value):
                profile_set_key(profile, "partition", "/Script/DuneSandbox.PvpPveSettings", "m_PveEnabledPartitions", target_partition, target_map, target_partition, "+")
            return
        spec = MAP_FIELDS.get(field_id)
        if spec and spec[0] and spec[1]:
            profile_set_key(profile, "partition", spec[0], spec[1], value, target_map, target_partition)
            mirror_legacy_profile_field(profile, "partition", target_map, target_partition, field_id, value)
        return

    raise SystemExit("Unknown settings scope.")


def profile_engine_values(profile: dict) -> dict[str, str]:
    values = {key: spec[2] for key, spec in ENGINE_FIELDS.items() if spec[2] is not None}
    for key, spec in ENGINE_FIELDS.items():
        section, ini_key, _ = spec
        if not section or not ini_key:
            continue
        profile_value = profile_get_key(profile, "engine", section, ini_key)
        if profile_value is None:
            profile_value = profile_get_raw_key(profile, section, ini_key)
        if profile_value is not None:
            values[key] = profile_value
    return values


def profile_map_values(profile: dict, map_name: str) -> dict[str, str]:
    target_map = canonical_map(map_name)
    values = {key: spec[2] for key, spec in MAP_FIELDS.items()}
    for key, spec in MAP_FIELDS.items():
        section, ini_key, _ = spec
        if not section or not ini_key:
            continue
        global_value = profile_get_key(profile, "global", section, ini_key)
        if global_value is not None:
            values[key] = global_value
        map_value = profile_get_key(profile, "map", section, ini_key, target_map)
        if map_value is not None:
            values[key] = map_value
    global_data = profile_get_key(profile, "global", LANDSRAAD_SETTINGS_SECTION, LANDSRAAD_DATA_KEY)
    values.update(landsraad_virtual_values(global_data or LANDSRAAD_DATA_TEMPLATE))
    return sync_legacy_values(profile, values, "map", target_map)


def profile_global_values(profile: dict) -> dict[str, str]:
    values = {key: spec[2] for key, spec in MAP_FIELDS.items()}
    for key, spec in MAP_FIELDS.items():
        section, ini_key, _ = spec
        if not section or not ini_key:
            continue
        global_value = profile_get_key(profile, "global", section, ini_key)
        if global_value is not None:
            values[key] = global_value
    global_data = profile_get_key(profile, "global", LANDSRAAD_SETTINGS_SECTION, LANDSRAAD_DATA_KEY)
    values.update(landsraad_virtual_values(global_data or LANDSRAAD_DATA_TEMPLATE))
    return sync_legacy_values(profile, values, "global")


def profile_partition_array_selector_active(profile: dict, section: str, key: str, target_map: str, target_partition: str) -> bool:
    """True when `target_partition`'s own id appears in a `+key=` array under `section`, at
    ANY scope that ends up merged into that partition's compiled UserGame.ini -- mirrors the
    exact scope list compiled_usergame_ini() merges (global, then this map, then this
    partition). Global-scope entries (e.g. Dual Deep Desert's PvP partition selector) are
    invisible to a Partition-scope-only check, which would otherwise leave this "configured"
    reading permanently disagreeing with the post-compile "materialized" reading."""
    return (
        profile_array_contains(profile, "global", section, key, target_partition)
        or profile_array_contains(profile, "map", section, key, target_partition, target_map)
        or profile_array_contains(profile, "partition", section, key, target_partition, target_map, target_partition)
    )


def profile_partition_selector_mode_active(profile: dict, target_map: str, target_partition: str) -> bool:
    section = "/Script/DuneSandbox.PvpPveSettings"
    selector_keys = {"m_PvpEnabledPartitions", "m_PveEnabledPartitions"}
    blocks = (
        find_profile_section(profile, "global", section),
        find_profile_section(profile, "map", section, target_map),
        find_profile_section(profile, "partition", section, target_map, target_partition),
    )
    for block in blocks:
        for raw in (block or {}).get("lines", []):
            parsed = split_ini_assignment(raw)
            if parsed and parsed[0] in {"", "+"} and parsed[1] in selector_keys:
                return True
    return False


def profile_partition_values(profile: dict, map_name: str, partition_id: str) -> dict[str, str]:
    target_map = canonical_map(map_name)
    target_partition = str(partition_id)
    values = {key: spec[2] for key, spec in PARTITION_FIELDS.items()}
    values.update(profile_map_values(profile, target_map))
    for key, spec in MAP_FIELDS.items():
        section, ini_key, _ = spec
        if not section or not ini_key:
            continue
        partition_value = profile_get_key(profile, "partition", section, ini_key, target_map, target_partition)
        if partition_value is not None:
            values[key] = partition_value
    values["partition_pvp_enabled"] = "True" if profile_partition_array_selector_active(
        profile, "/Script/DuneSandbox.PvpPveSettings", "m_PvpEnabledPartitions", target_map, target_partition
    ) else values.get("partition_pvp_enabled", "False")
    values["partition_pve_enabled"] = "True" if profile_partition_array_selector_active(
        profile, "/Script/DuneSandbox.PvpPveSettings", "m_PveEnabledPartitions", target_map, target_partition
    ) else values.get("partition_pve_enabled", "False")
    values["partition_selector_mode_active"] = "True" if profile_partition_selector_mode_active(
        profile, target_map, target_partition
    ) else "False"
    return sync_legacy_values(profile, values, "partition", target_map, target_partition)


def profile_section_lines(profile: dict, scope: str, section: str, map_name: str = "", partition_id: str = "") -> list[str]:
    block = find_profile_section(profile, scope, section, map_name, partition_id)
    return list(block.get("lines", [])) if block else []


def merged_engine_values(config: dict) -> dict[str, str]:
    return profile_engine_values(read_profile())


def merged_map_values(config: dict, map_name: str) -> dict[str, str]:
    return profile_map_values(read_profile(), map_name)


def merged_global_values(config: dict) -> dict[str, str]:
    return profile_global_values(read_profile())


def merged_partition_values(config: dict, map_name: str, partition_id: str) -> dict[str, str]:
    return profile_partition_values(read_profile(), map_name, partition_id)


def profile_map_engine_values(profile: dict, map_name: str) -> dict[str, str]:
    target_map = canonical_map(map_name)
    values = profile_engine_values(profile)
    for key, spec in MAP_ENGINE_FIELDS.items():
        section, ini_key, _ = spec
        if not section or not ini_key:
            continue
        map_value = profile_get_key(profile, "map_engine", section, ini_key, target_map)
        if map_value is not None:
            values[key] = map_value
    return values


def profile_partition_engine_values(profile: dict, map_name: str, partition_id: str) -> dict[str, str]:
    target_map = canonical_map(map_name)
    target_partition = str(partition_id)
    values = profile_map_engine_values(profile, target_map)
    for key, spec in PARTITION_ENGINE_FIELDS.items():
        section, ini_key, _ = spec
        if not section or not ini_key:
            continue
        partition_value = profile_get_key(profile, "partition_engine", section, ini_key, target_map, target_partition)
        # Preserve existing per-Sietch names and passwords written before scoped engine profiles existed.
        if partition_value is None and key in {"server_display_name", "server_login_password"}:
            partition_value = profile_get_key(profile, "partition", section, ini_key, target_map, target_partition)
        if partition_value is not None:
            values[key] = partition_value
    return values


def merged_map_engine_values(config: dict, map_name: str) -> dict[str, str]:
    return profile_map_engine_values(read_profile(), map_name)


def merged_partition_engine_values(config: dict, map_name: str, partition_id: str) -> dict[str, str]:
    return profile_partition_engine_values(read_profile(), map_name, partition_id)


def print_rows(rows: dict[str, str], order: dict) -> int:
    for key in order:
        print(f"{key}\t{rows.get(key, '')}")
    return 0


def print_usergame_rows(rows: dict[str, str], order: dict) -> int:
    print_rows(rows, order)
    for key in LANDSRAAD_DATA_FIELDS:
        print(f"{key}\t{rows.get(key, '')}")
    return 0


def infer_field_type(default: str | None) -> str:
    value = str(default or "").strip()
    if value.lower() in {"true", "false"}:
        return "boolean"
    if value.lower() in {"0", "1"}:
        return "toggle"
    try:
        int(value)
        return "integer"
    except ValueError:
        pass
    try:
        float(value)
        return "number"
    except ValueError:
        return "text"


def metadata() -> int:
    def row(scope: str, field_id: str, spec: tuple[str | None, str | None, str | None]) -> dict:
        section, key, default = spec
        minimum, maximum = CORIOLIS_CYCLE_START_BOUNDS.get(field_id, (None, None))
        if field_id == "augment_jackpot_roll_percentage":
            minimum, maximum = AUGMENT_JACKPOT_ROLL_BOUNDS
        return {
            "scope": scope,
            "id": field_id,
            "section": section or "",
            "key": key or "",
            "default": "" if default is None else str(default),
            "type": FIELD_TYPE_OVERRIDES.get(field_id, infer_field_type(default)),
            "clientFile": CLIENT_FILE_REQUIRED.get(field_id, ""),
            "category": ENGINE_FIELD_CATEGORIES.get(field_id, ""),
            "description": FIELD_DESCRIPTIONS.get(field_id, ""),
            "label": FIELD_LABELS.get(field_id, ""),
            "minimum": minimum,
            "maximum": maximum,
        }

    # A login password has no public default and is managed by the Sietch
    # identity controls, not the generic settings editor. Keep it completely
    # out of stdout instead of relying on an empty placeholder value.
    public_engine_fields = {
        key: spec for key, spec in ENGINE_FIELDS.items()
        if key != "server_login_password"
    }
    public_partition_engine_fields = {
        key: spec for key, spec in PARTITION_ENGINE_FIELDS.items()
        if key != "server_login_password"
    }
    # Keep legacy DuneGameMode keys readable and compilable for existing
    # profiles, but expose only their canonical counterparts (GuildSettings,
    # CoriolisSubsystem) in the structured editor. See LEGACY_FIELD_ALIASES.
    public_game_fields = {
        key: spec for key, spec in MAP_FIELDS.items()
        if key not in LEGACY_FIELD_ALIASES
    }
    public_partition_fields = {
        key: spec for key, spec in PARTITION_FIELDS.items()
        if key not in LEGACY_FIELD_ALIASES
    }
    payload = {
        "engine": [row("engine", key, spec) for key, spec in public_engine_fields.items()],
        "mapEngine": [row("mapEngine", key, spec) for key, spec in MAP_ENGINE_FIELDS.items()],
        "game": [row("game", key, spec) for key, spec in public_game_fields.items()],
        "partition": [row("partition", key, spec) for key, spec in public_partition_fields.items()],
        "partitionEngine": [row("partitionEngine", key, spec) for key, spec in public_partition_engine_fields.items()],
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def set_field(scope: str, name: str | None, field_id: str, value: str) -> int:
    config = load_config()
    profile = read_profile()
    if scope == "engine":
        if field_id not in ENGINE_FIELDS:
            raise SystemExit(f"Unknown engine field: {field_id}")
        if field_id in {"port", "igw_port"}:
            validate_port_ranges(config, field_id, value)
        set_profile_field(profile, "engine", "", "", field_id, value)
        validate_profile_port_ranges(profile)
    else:
        if field_id not in MAP_FIELDS and field_id not in GLOBAL_ARRAY_FIELD_IDS:
            raise SystemExit(f"Unknown map field: {field_id}")
        map_name = canonical_map(name or "")
        target_scope = "global" if map_name in {"", "Global"} else "map"
        if field_id in GLOBAL_ARRAY_FIELD_IDS and target_scope != "global":
            raise SystemExit(f"{field_id} may only be set at Global scope.")
        set_profile_field(profile, target_scope, map_name, "", field_id, value)
    write_profile(profile)
    return 0


def unset_map_field(name: str, field_id: str) -> int:
    if field_id not in MAP_FIELDS:
        raise SystemExit(f"Unknown map field: {field_id}")
    section, key, _default = MAP_FIELDS[field_id]
    if not section or not key:
        raise SystemExit(f"Map field cannot be removed directly: {field_id}")
    profile = read_profile()
    map_name = canonical_map(name)
    target_scope = "global" if map_name in {"", "Global"} else "map"
    profile_remove_key(profile, target_scope, section, key, map_name=map_name)
    write_profile(profile)
    return 0


def set_dual_deepdesert_matchmaker(enabled: bool) -> int:
    """Manage only the two exact Unreal array entries owned by Dual Deep Desert.

    ``HomeDimension`` is what carries the selected dimension through Director
    matchmaking.  The paired ``-FirstOfGroup`` line removes the engine's
    default Deep Desert rule without clearing or rewriting settings for any
    other map.
    """
    profile = read_profile()
    for prefix, value in (
        ("-", DEEPDESERT_MATCHMAKER_FIRST_OF_GROUP),
        ("+", DEEPDESERT_MATCHMAKER_HOME_DIMENSION),
    ):
        profile_remove_key(
            profile,
            "global",
            DEEPDESERT_MATCHMAKER_SECTION,
            DEEPDESERT_MATCHMAKER_KEY,
            prefixes={prefix},
            value=value,
        )
    if enabled:
        profile_set_key(
            profile,
            "global",
            DEEPDESERT_MATCHMAKER_SECTION,
            DEEPDESERT_MATCHMAKER_KEY,
            DEEPDESERT_MATCHMAKER_FIRST_OF_GROUP,
            prefix="-",
        )
        profile_set_key(
            profile,
            "global",
            DEEPDESERT_MATCHMAKER_SECTION,
            DEEPDESERT_MATCHMAKER_KEY,
            DEEPDESERT_MATCHMAKER_HOME_DIMENSION,
            prefix="+",
        )
    write_profile(profile)
    return 0


def set_partition_field(map_name: str, partition_id: str, field_id: str, value: str) -> int:
    if field_id not in PARTITION_FIELDS:
        raise SystemExit(f"Unknown partition field: {field_id}")
    profile = read_profile()
    set_profile_field(profile, "partition", map_name, str(partition_id), field_id, value)
    write_profile(profile)
    return 0


def set_partition_engine_field(map_name: str, partition_id: str, field_id: str, value: str) -> int:
    if field_id not in PARTITION_ENGINE_FIELDS:
        raise SystemExit(f"Unknown partition engine field: {field_id}")
    profile = read_profile()
    set_profile_field(profile, "partition_engine", map_name, str(partition_id), field_id, value)
    write_profile(profile)
    return 0


def reset_all() -> int:
    if CONFIG_PATH.exists():
        CONFIG_PATH.unlink()
    if PROFILE_PATH.exists():
        PROFILE_PATH.unlink()
    return 0


def reset_engine_gameplay() -> int:
    profile = read_profile()
    for key, spec in ENGINE_FIELDS.items():
        if key in RESET_PRESERVED_ENGINE_FIELDS:
            continue
        if spec[0] and spec[1]:
            profile_remove_key(profile, "engine", spec[0], spec[1])
    write_profile(profile)
    return 0


def reset_scoped_engine(map_name: str, partition_id: str | None = None) -> int:
    profile = read_profile()
    target_map = canonical_map(map_name)
    scope = "partition_engine" if partition_id else "map_engine"
    fields = PARTITION_ENGINE_FIELDS if partition_id else MAP_ENGINE_FIELDS
    target_partition = str(partition_id or "")
    for spec in fields.values():
        if spec[0] and spec[1]:
            profile_remove_key(profile, scope, spec[0], spec[1], target_map, target_partition)
    write_profile(profile)
    return 0


def reset_game(map_name: str, partition_id: str | None = None) -> int:
    profile = read_profile()
    target_map = canonical_map(map_name)
    if partition_id:
        target_partition = str(partition_id)
        profile["sections"] = [
            block for block in profile.get("sections", [])
            if not (block.get("scope") == "Partition" and block.get("map") == target_map and str(block.get("partition", "")) == target_partition)
        ]
    else:
        profile["sections"] = [
            block for block in profile.get("sections", [])
            if not (block.get("scope") == "Map" and block.get("map") == target_map)
        ]
    write_profile(profile)
    return 0


def reset_global_game() -> int:
    profile = read_profile()
    profile["sections"] = [
        block for block in profile.get("sections", [])
        if block.get("scope") != "Global"
    ]
    write_profile(profile)
    return 0


def quote_ini_string(value: str) -> str:
    raw = value.strip()
    if len(raw) >= 2 and raw[0] == '"' and raw[-1] == '"':
        return raw
    escaped = raw.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def truthy(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


def write_usergame_ini(path: Path, values: dict[str, str], partition_id: str | None = None) -> None:
    lines = [
        "; Settings in these config files will be applied to every server in the battlegroup",
        "; If you need to override different settings for different servers, use the battlegroup editor instead",
        "; Advanced community-documented fields below are emitted for Docker Saved/UserSettings use.",
    ]
    current_section = None
    for field_id, spec in MAP_FIELDS.items():
        section, key, default = spec
        if not section or not key:
            continue
        if section != current_section:
            lines.extend(["", f"[{section}]"])
            current_section = section
        lines.append(f"{key}={values.get(field_id, default)}")
        if section == "/Script/DuneSandbox.PvpPveSettings" and key == "m_bShouldForceEnablePvpOnAllPartitions":
            lines.append("; Partition-scoped PvP/PvE selectors. The web UI writes these automatically from the selected dimension.")
            if partition_id:
                if truthy(values.get("partition_pvp_enabled", "False")):
                    lines.append(f"+m_PvpEnabledPartitions={partition_id}")
                else:
                    lines.append(";+m_PvpEnabledPartitions=1")
                    lines.append(";+m_PvpEnabledPartitions=2")
            else:
                lines.append(";+m_PvpEnabledPartitions=1")
                lines.append(";+m_PvpEnabledPartitions=2")
            lines.append("; Explicitly enable PVE for specific partitions. Example:")
            if partition_id and truthy(values.get("partition_pve_enabled", "False")):
                lines.append(f"+m_PveEnabledPartitions={partition_id}")
            else:
                lines.append(";+m_PveEnabledPartitions=1")

    atomic_write_text(path, "\n".join(lines) + "\n")


def append_profile_unknown_lines(target: dict[str, list[str]], profile: dict, scopes: list[tuple[str, str, str]], known: dict[str, set[str]], schema_comment_lines: dict[str, set[str]] | None = None) -> None:
    scope_names = {
        "engine": "Engine",
        "global": "Global",
        "map": "Map",
        "map_engine": "MapEngine",
        "partition": "Partition",
        "partition_engine": "PartitionEngine",
    }
    for scope, map_name, partition_id in scopes:
        for block in profile.get("sections", []):
            if block.get("scope") != scope_names[scope]:
                continue
            if scope in {"map", "map_engine"} and block.get("map") != canonical_map(map_name):
                continue
            if scope in {"partition", "partition_engine"} and (
                block.get("map") != canonical_map(map_name)
                or str(block.get("partition", "")) != str(partition_id)
            ):
                continue
            section = str(block.get("ini_section", ""))
            reserved_comments = (schema_comment_lines or {}).get(section, set())
            for raw in block.get("lines", []):
                if raw.strip() in reserved_comments:
                    # The field loop now regenerates this exact comment fresh next
                    # to its value when that value survives; keeping the copy
                    # stored in the profile too would duplicate it.
                    continue
                parsed = split_ini_assignment(raw)
                if parsed:
                    prefix, left, _ = parsed
                    if not prefix and left in known.get(section, set()):
                        continue
                target.setdefault(section, []).append(raw)


def render_ini_sections(section_lines: dict[str, list[str]], leading_comments: list[str]) -> str:
    lines = list(leading_comments)
    for section, entries in section_lines.items():
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(f"[{section}]")
        lines.extend(entries)
    return "\n".join(lines).rstrip() + "\n"


def field_value_is_default(field_id: str, value: str, default) -> bool:
    """True when a saved value matches the schema default, ignoring boolean spelling
    (a field stored as "1" is not a change from a "True" default)."""
    default_str = "" if default is None else str(default)
    if value == default_str:
        return True
    if value == "" or default_str == "":
        return False
    if FIELD_TYPE_OVERRIDES.get(field_id, infer_field_type(default)) == "boolean":
        return truthy(value) == truthy(default_str)
    return False


def compiled_userengine_ini(profile: dict, map_name: str = "", partition_id: str | None = None) -> str:
    if map_name and partition_id:
        values = profile_partition_engine_values(profile, map_name, str(partition_id))
    elif map_name:
        values = profile_map_engine_values(profile, map_name)
    else:
        values = profile_engine_values(profile)
    section_lines: dict[str, list[str]] = {}
    last_comment: dict[str, tuple[str, ...]] = {}
    emitted_comment_lines: dict[str, set[str]] = {}
    for field_id, spec in ENGINE_FIELDS.items():
        section, key, default = spec
        if not section or not key:
            continue
        value = values.get(field_id, "" if default is None else str(default))
        if value == "" and default is None:
            continue
        # Only settings that differ from the default are written -- the game falls
        # back to its own compiled default for anything omitted. [URL] is per-server
        # identity rather than a tunable, so it is always emitted.
        if section != "URL" and field_value_is_default(field_id, value, default):
            continue
        if field_id in {"server_display_name", "server_login_password"} and value:
            value = quote_ini_string(value)
        # A field's comment is emitted directly beside its value -- not sourced
        # from the raw profile document -- so it can never survive without the
        # value it explains. Several fields intentionally share one comment tuple
        # (e.g. the three mining multipliers); only show it once per run of those.
        comment = ENGINE_FIELD_INI_COMMENTS.get(field_id)
        if comment and last_comment.get(section) != comment:
            section_lines.setdefault(section, []).extend(f"; {line}" for line in comment)
            last_comment[section] = comment
            emitted_comment_lines.setdefault(section, set()).update(f"; {line}" for line in comment)
        section_lines.setdefault(section, []).append(f"{key}={value}")
    scopes = [("engine", "", "")]
    if map_name:
        scopes.append(("map_engine", canonical_map(map_name), ""))
    if map_name and partition_id:
        scopes.append(("partition_engine", canonical_map(map_name), str(partition_id)))
    # Reserved comment lines are scoped to what THIS run actually re-emitted above
    # (emitted_comment_lines), not the full static schema table -- a field sitting at
    # its default never gets its value or comment written here, so a comment the admin
    # manually kept next to it must not be treated as reserved either, or it's deleted
    # with nothing regenerated to replace it (the bug this replaced: the old static
    # per-field-name table reserved a field's comment text unconditionally, even on a
    # run where that field's default meant nothing was ever (re)emitted for it).
    reserved_lines_by_section = {section: set(lines) for section, lines in emitted_comment_lines.items()}
    # Also reserve the identity fields' commented-out placeholder VALUE lines (not
    # just their explanatory comments, already covered above) -- otherwise a
    # placeholder saved back verbatim through the Advanced tab's round trip (see
    # ENGINE_IDENTITY_RESERVED_CV_LINES) leaks into the actual deployed ini as a
    # stray line, even though profile_engine_text() correctly hides it from the editor.
    reserved_lines_by_section["ConsoleVariables"] = reserved_lines_by_section.get("ConsoleVariables", set()) | ENGINE_IDENTITY_RESERVED_CV_LINES
    append_profile_unknown_lines(
        section_lines, profile, scopes, known_keys_by_section(ENGINE_FIELDS),
        reserved_lines_by_section,
    )
    return render_ini_sections(section_lines, [
        "; UserEngine.ini managed by Docker.",
        "; Global values are resolved with map and partition overrides for this server.",
    ])


def compiled_usergame_ini(profile: dict, map_name: str, partition_id: str | None = None) -> str:
    target_map = canonical_map(map_name)
    target_partition = str(partition_id or "")
    values = profile_partition_values(profile, target_map, target_partition) if target_partition else profile_map_values(profile, target_map)
    section_lines: dict[str, list[str]] = {}
    for field_id, spec in MAP_FIELDS.items():
        section, key, default = spec
        if not section or not key:
            continue
        if field_id in STAKING_EXTENSION_FIELDS:
            continue
        value = values.get(field_id, default)
        # Same rule as UserEngine: defaults are normally left out so the game uses
        # its own. Mixed PvP/PvE layouts are the exception: once partition selector
        # arrays are present, False is an active instruction rather than an omitted
        # default. Emit it explicitly into every partition's materialized INI so
        # Overmap/Kanly and the game servers advertise the same mixed-mode state.
        selector_mode_requires_explicit_force_flag = (
            field_id == "force_pvp_all_partitions"
            and target_partition
            and profile_partition_selector_mode_active(profile, target_map, target_partition)
        )
        if selector_mode_requires_explicit_force_flag or not field_value_is_default(field_id, str(value), default):
            section_lines.setdefault(section, []).append(f"{key}={value}")
        if section == "/Script/DuneSandbox.PvpPveSettings" and key == "m_bShouldForceEnablePvpOnAllPartitions" and target_partition:
            if truthy(values.get("partition_pvp_enabled", "False")):
                section_lines.setdefault(section, []).append(f"+m_PvpEnabledPartitions={target_partition}")
            if truthy(values.get("partition_pve_enabled", "False")):
                section_lines.setdefault(section, []).append(f"+m_PveEnabledPartitions={target_partition}")
    scopes = [("global", "", ""), ("map", target_map, "")]
    if target_partition:
        scopes.append(("partition", target_map, target_partition))
    # Treat retired controls as known-but-not-emitted. This suppresses stale
    # lines from profiles written by older releases without allowing unrelated
    # custom Advanced-editor values to be dropped.
    known = known_keys_by_section({**MAP_FIELDS, **RETIRED_USERGAME_FIELDS})
    known.setdefault("/Script/DuneSandbox.PvpPveSettings", set()).update({"m_PvpEnabledPartitions", "m_PveEnabledPartitions"})
    append_profile_unknown_lines(section_lines, profile, scopes, known)
    pvp_pve_section = "/Script/DuneSandbox.PvpPveSettings"
    if pvp_pve_section in section_lines:
        # A Global-scoped array line can now duplicate the same value emitted
        # structurally by the partition toggle above; collapse exact repeats
        # rather than writing the same +m_Pvp/PveEnabledPartitions line twice.
        seen: set[str] = set()
        deduped: list[str] = []
        for line in section_lines[pvp_pve_section]:
            if line in seen:
                continue
            seen.add(line)
            deduped.append(line)
        section_lines[pvp_pve_section] = deduped
    if BUILDING_SETTINGS_SECTION in section_lines:
        section_lines[BUILDING_SETTINGS_SECTION] = strip_unsafe_staking_extension_lines(
            section_lines[BUILDING_SETTINGS_SECTION]
        )
    append_safe_staking_extension_arrays(section_lines, values)
    return render_ini_sections(section_lines, [
        "; UserGame.ini managed by Docker.",
        "; Edit this single file for all map and partition UserGame settings.",
        "; Docker applies the correct values to each server when maps start or restart.",
    ])


def client_game_ini(profile: dict, map_name: str, partition_id: str | None = None) -> str:
    target_map = canonical_map(map_name) if str(map_name or "").strip() else ""
    target_partition = str(partition_id or "")
    if target_map and target_partition:
        values = profile_partition_values(profile, target_map, target_partition)
    elif target_map:
        values = profile_map_values(profile, target_map)
    else:
        values = profile_global_values(profile)

    section_lines: dict[str, list[str]] = {}
    for field_id, spec in MAP_FIELDS.items():
        if CLIENT_FILE_REQUIRED.get(field_id) != "Game.ini":
            continue
        section, key, default = spec
        if not section or not key:
            continue
        default_str = "" if default is None else str(default)
        value = str(values.get(field_id, default_str))
        if field_value_is_default(field_id, value, default):
            continue
        section_lines.setdefault(section, []).append(f"{key}={value}")

    target_label = "global UserGame" if not target_map else target_map if not target_partition else f"{target_map} partition {target_partition}"
    return render_ini_sections(section_lines, [
        "; Game.ini for the Dune: Awakening client.",
        f"; Client-required settings generated from Docker UserGame.ini values for {target_label}.",
        "; Merge these sections into Saved/Config/WindowsClient/Game.ini while the game is closed.",
        "; Only settings changed from the default and known to require client configuration are listed.",
        "; Remove keys from an earlier copy when they are no longer listed here.",
    ])


def client_engine_ini(profile: dict, map_name: str = "", partition_id: str | None = None) -> str:
    target_map = canonical_map(map_name) if str(map_name or "").strip() else ""
    target_partition = str(partition_id or "")
    if target_map and target_partition:
        values = profile_partition_engine_values(profile, target_map, target_partition)
    elif target_map:
        values = profile_map_engine_values(profile, target_map)
    else:
        values = profile_engine_values(profile)

    section_lines: dict[str, list[str]] = {}
    for field_id, spec in ENGINE_FIELDS.items():
        if CLIENT_FILE_REQUIRED.get(field_id) != "Engine.ini":
            continue
        section, key, default = spec
        if not section or not key:
            continue
        default_str = "" if default is None else str(default)
        value = values.get(field_id, default_str)
        if value == default_str:
            continue
        section_lines.setdefault(section, []).append(f"{key}={value}")

    target_label = "global UserEngine" if not target_map else target_map if not target_partition else f"{target_map} partition {target_partition}"
    return render_ini_sections(section_lines, [
        "; Engine.ini for the Dune: Awakening client.",
        f"; Client-required settings generated from Docker UserEngine.ini values for {target_label}.",
        "; Merge these sections into Saved/Config/WindowsClient/Engine.ini while the game is closed.",
        "; Only settings changed from the default and known to require client configuration are listed.",
        "; Remove keys from an earlier generated copy when they are no longer listed here.",
    ])


def write_compiled_userengine(path: Path, profile: dict, map_name: str = "", partition_id: str | None = None) -> None:
    atomic_write_text(path, compiled_userengine_ini(profile, map_name, partition_id))


def write_compiled_usergame(path: Path, profile: dict, map_name: str, partition_id: str | None = None) -> None:
    atomic_write_text(path, compiled_usergame_ini(profile, map_name, partition_id))


def safe_runtime_dir_name(map_name: str, partition_id: str) -> str:
    raw = f"{map_name}-{partition_id}".lower()
    chars: list[str] = []
    previous_dash = False
    for char in raw:
        if char.isalnum():
            chars.append(char)
            previous_dash = False
        else:
            if not previous_dash:
                chars.append("-")
                previous_dash = True
    return "".join(chars).strip("-")


def saved_dir_for(map_name: str, partition_id: str | None = None) -> Path:
    game_root = Path(os.environ.get("DUNE_USERSETTINGS_GAME_ROOT", str(ROOT / "runtime" / "game")))
    target_map = canonical_map(map_name)
    if target_map == "Survival_1" and str(partition_id or "1") == "1":
        return game_root / "survival-1" / "Saved"
    if target_map == "Overmap":
        return game_root / "overmap" / "Saved"
    if partition_id:
        return game_root / safe_runtime_dir_name(target_map, str(partition_id)) / "Saved"
    return game_root / safe_runtime_dir_name(target_map, "global") / "Saved"


def infer_runtime_target(saved_dir: Path) -> tuple[str, str | None] | None:
    runtime_name = saved_dir.parent.name
    if runtime_name == "survival-1":
        return ("Survival_1", "1")
    if runtime_name == "overmap":
        return ("Overmap", "2")
    survival_match = re.fullmatch(r"survival-1-(\d+)", runtime_name)
    if survival_match:
        return ("Survival_1", survival_match.group(1))
    deep_desert_match = re.fullmatch(r"deepdesert-1-(\d+)", runtime_name)
    if deep_desert_match:
        return ("DeepDesert_1", deep_desert_match.group(1))
    return None


def live_userengine_path(partition_id: str | None = None, map_name: str = "Survival_1") -> Path:
    return saved_dir_for(map_name, partition_id or "1") / "UserSettings" / "UserEngine.ini"


def live_usergame_path(map_name: str, partition_id: str) -> Path:
    return saved_dir_for(map_name, partition_id) / "UserSettings" / "UserGame.ini"


def read_raw(kind: str, map_name: str | None = None, partition_id: str | None = None) -> int:
    if kind == "engine":
        path = live_userengine_path(partition_id, canonical_map(map_name or "Survival_1"))
    elif kind == "game":
        target_map = canonical_map(map_name or "Survival_1")
        target_partition = partition_id or ("1" if target_map == "Survival_1" else "2" if target_map in {"Overmap", "DeepDesert_1"} else "")
        path = live_usergame_path(target_map, target_partition)
    else:
        raise SystemExit("Unknown raw kind.")
    if path.exists():
        sys.stdout.write(path.read_text(encoding="utf-8", errors="replace"))
    return 0


def write_raw(kind: str, content: str, map_name: str | None = None, partition_id: str | None = None) -> int:
    if kind == "engine":
        path = live_userengine_path(partition_id, canonical_map(map_name or "Survival_1"))
    elif kind == "game":
        target_map = canonical_map(map_name or "Survival_1")
        target_partition = partition_id or ("1" if target_map == "Survival_1" else "2" if target_map in {"Overmap", "DeepDesert_1"} else "")
        path = live_usergame_path(target_map, target_partition)
    else:
        raise SystemExit("Unknown raw kind.")
    atomic_write_text(path, content)
    return 0


def decode_payload(encoded: str) -> dict:
    try:
        raw = b64decode(encoded.encode("ascii")).decode("utf-8")
        payload = json.loads(raw)
    except (ValueError, json.JSONDecodeError) as exc:
        raise SystemExit("Invalid settings payload.") from exc
    if not isinstance(payload, dict):
        raise SystemExit("Settings payload must be an object.")
    return payload


def bulk_save(scope: str, map_name: str, partition_id: str, encoded_values: str) -> int:
    values = decode_payload(encoded_values)
    target_map = canonical_map(map_name or "Survival_1")
    target_partition = str(partition_id or "").strip()
    profile = read_profile()
    landsraad_changed = False
    for field_id, value in values.items():
        if not isinstance(field_id, str):
            raise SystemExit("Settings field names must be strings.")
        serialized = str(value)
        if "\x00" in serialized:
            raise SystemExit(f"{field_id} contains an invalid NUL character.")
        if "\n" in serialized or "\r" in serialized:
            # A newline here would break out of this field's "key=value" line in the
            # generated ini and let the rest of the string inject arbitrary keys or
            # a new [Section] once written by compiled_userengine_ini/compiled_usergame_ini.
            raise SystemExit(f"{field_id} may not contain a newline.")
        landsraad_changed = landsraad_changed or field_id == "landsraad_enabled" or field_id in LANDSRAAD_DATA_FIELDS
        if scope == "engine":
            set_profile_field(profile, "engine", "", "", field_id, serialized)
        elif scope == "mapEngine":
            set_profile_field(profile, "map_engine", target_map, "", field_id, serialized)
        elif scope == "partitionEngine":
            set_profile_field(profile, "partition_engine", target_map, target_partition, field_id, serialized)
        elif scope == "global":
            set_profile_field(profile, "global", "", "", field_id, serialized)
        elif scope == "partition":
            set_profile_field(profile, "partition", target_map, target_partition, field_id, serialized)
        elif scope == "map":
            set_profile_field(profile, "map", target_map, "", field_id, serialized)
        else:
            raise SystemExit("Unknown settings scope.")
    if scope == "engine":
        validate_profile_port_ranges(profile)
    write_profile(profile)
    for message in legacy_alias_conflict_warnings(profile, scope, target_map, target_partition):
        print(f"USERSETTINGS_WARNING: {message}")
    if landsraad_changed:
        atomic_write_text(LANDSRAAD_RESTART_MARKER_PATH, "Landsraad UserGame settings changed.\n", 0o664)
    return 0


def raw_write_encoded(kind: str, encoded_content: str, map_name: str | None = None, partition_id: str | None = None) -> int:
    try:
        content = b64decode(encoded_content.encode("ascii")).decode("utf-8")
    except ValueError as exc:
        raise SystemExit("Invalid raw INI payload.") from exc
    return write_raw(kind, content, map_name, partition_id)


def profile_write_encoded(encoded_content: str) -> int:
    try:
        content = b64decode(encoded_content.encode("ascii")).decode("utf-8")
    except ValueError as exc:
        raise SystemExit("Invalid profile payload.") from exc
    write_profile_text(content)
    return 0


def profile_game_text() -> str:
    profile = read_profile()
    strip_retired_usergame_profile_lines(profile)
    game_profile = {
        "preamble": [
            "; UserGame.ini managed by Docker.",
            "; Edit this single file for all map and partition UserGame settings.",
            "; Docker applies the correct values to each server when maps start or restart.",
        ],
        "sections": [block for block in profile.get("sections", []) if block.get("scope") not in ENGINE_PROFILE_SCOPES],
    }
    return serialize_profile(game_profile)


# Single source of truth for each identity field's "no value set" placeholder line --
# read by both the synthesis in profile_engine_text() and the reserved-lines set
# below, so the two can never quote different text for the same field.
ENGINE_IDENTITY_PLACEHOLDER_LINES = {
    "server_display_name": ';Bgd.ServerDisplayName="My Arrakis, My Dune"',
    "server_login_password": ';Bgd.ServerLoginPassword="Sandworm"',
}
# Derived from ENGINE_FIELDS rather than hardcoded a second time, so the ini key
# spellings here can't drift from the schema's own.
ENGINE_IDENTITY_CV_KEYS = {ENGINE_FIELDS[field_id][1] for field_id in ENGINE_IDENTITY_PLACEHOLDER_LINES}
# Every literal line the identity synthesis below can produce for an UNSET field --
# its explanatory comments and its commented-out placeholder value. These need their
# own exact-match filter because split_ini_assignment() returns None for any line
# starting with ";" (by design, since comments aren't assignments), so the
# ENGINE_IDENTITY_CV_KEYS check alone never catches them once they've been saved back
# verbatim through a real round trip, letting them duplicate on every subsequent read.
# Reuses schema_comment_lines_by_section() (the same helper compiled_userengine_ini()
# uses for its own comment de-dup) rather than re-deriving the comment text by hand,
# scoped to just these two fields' comments via a filtered input dict.
ENGINE_IDENTITY_RESERVED_CV_LINES = schema_comment_lines_by_section(
    {field_id: ENGINE_FIELD_INI_COMMENTS[field_id] for field_id in ENGINE_IDENTITY_PLACEHOLDER_LINES if field_id in ENGINE_FIELD_INI_COMMENTS},
    ENGINE_FIELDS,
).get("ConsoleVariables", set()) | set(ENGINE_IDENTITY_PLACEHOLDER_LINES.values())


def _is_engine_identity_cv_line(raw: str) -> bool:
    if raw.strip() in ENGINE_IDENTITY_RESERVED_CV_LINES:
        return True
    parsed = split_ini_assignment(raw)
    return bool(parsed and parsed[1] in ENGINE_IDENTITY_CV_KEYS)


def profile_engine_text() -> str:
    # Port/IGWPort and the two Bgd.* identity fields are server identity, not
    # tunables -- the "Restore Defaults" confirm dialog promises these four are
    # always preserved, so they're synthesized fresh from schema every time
    # (matching compiled_userengine_ini's own URL exception). Everything else is a
    # sparse pass-through of what's actually stored, matching profile_game_text().
    profile = read_profile()
    values = profile_engine_values(profile)

    def commented(field_id: str) -> list[str]:
        comment = ENGINE_FIELD_INI_COMMENTS.get(field_id)
        return [f"; {line}" for line in comment] if comment else []

    url_lines: list[str] = []
    for field_id in ("port", "igw_port"):
        _section, key, default = ENGINE_FIELDS[field_id]
        url_lines.extend(commented(field_id))
        url_lines.append(f"{key}={values.get(field_id, default)}")

    display_name = values.get("server_display_name") or ""
    login_password = values.get("server_login_password") or ""
    identity_cv_lines = [
        *commented("server_display_name"),
        f"Bgd.ServerDisplayName={quote_ini_string(display_name)}" if display_name
            else ENGINE_IDENTITY_PLACEHOLDER_LINES["server_display_name"],
        "",
        *commented("server_login_password"),
        f"Bgd.ServerLoginPassword={quote_ini_string(login_password)}" if login_password
            else ENGINE_IDENTITY_PLACEHOLDER_LINES["server_login_password"],
    ]

    console_variable_lines = [
        raw
        for block in profile.get("sections", [])
        if block.get("scope") == "Engine" and block.get("ini_section") == "ConsoleVariables"
        for raw in block.get("lines", [])
    ]
    other_cv_lines = [
        raw for idx, raw in enumerate(console_variable_lines)
        if not _is_engine_identity_cv_line(raw)
        # A blank line touching identity content on either side is the identity
        # synthesis's own separator, not spacing an admin added between their own
        # custom entries -- without this, a blank line saved back verbatim as part
        # of an identity round trip gets treated as "other" content, and the render
        # below adds its own separator blank line ahead of it, growing by one line
        # on every save/read cycle. Only blanks adjacent to identity content are
        # dropped; a blank line between two unrelated custom cvars is preserved.
        and not (
            not raw.strip()
            and any(
                _is_engine_identity_cv_line(console_variable_lines[j])
                for j in (idx - 1, idx + 1) if 0 <= j < len(console_variable_lines)
            )
        )
    ]

    # MapEngine/PartitionEngine sections get no synthesis (unlike the four global
    # identity fields above) -- pure sparse pass-through, matching how UserGame's
    # Map/Partition tiers already behave in profile_game_text().
    other_sections = [
        block for block in profile.get("sections", [])
        if (block.get("scope") == "Engine" and block.get("ini_section") not in {"URL", "ConsoleVariables"})
        or block.get("scope") in {"MapEngine", "PartitionEngine"}
    ]

    # URL is placed first explicitly rather than via serialize_profile()'s generic
    # alphabetical tie-break (both sections share scope "Engine", so "ConsoleVariables"
    # would otherwise sort ahead of "URL") -- Port/IGWPort should always be the first
    # thing an admin sees. Any other custom Engine section still gets the normal sort.
    ordered_sections = [
        {"header": profile_header("engine", "URL"), "scope": "Engine", "map": "", "partition": "",
         "ini_section": "URL", "lines": url_lines},
        {"header": profile_header("engine", "ConsoleVariables"), "scope": "Engine", "map": "", "partition": "",
         "ini_section": "ConsoleVariables", "lines": identity_cv_lines + ([""] if other_cv_lines else []) + other_cv_lines},
    ] + sorted_profile_sections(other_sections)

    lines = [
        "; UserEngine.ini managed by Docker.",
        "; Edit this single file for all map and partition UserEngine settings.",
        "; Docker applies the correct values to each server when maps start or restart.",
    ]
    for section in ordered_sections:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append(f"[{_display_engine_header(section['header'], section['scope'])}]")
        lines.extend(section.get("lines", []))
    return "\n".join(lines).rstrip() + "\n"


def _display_engine_header(header: str, scope: str) -> str:
    _tier, _, rest = header.partition(":")
    return f"{ENGINE_HEADER_DISPLAY_NAMES.get(scope, scope)}:{rest}"


def _internal_engine_header_text(content: str) -> str:
    out_lines = []
    for line in content.splitlines():
        match = _ENGINE_DISPLAY_HEADER_RE.match(line.strip())
        if match:
            tier, rest = match.groups()
            out_lines.append(f"[{ENGINE_HEADER_INTERNAL_NAMES[tier]}:{rest}]")
        else:
            out_lines.append(line)
    return "\n".join(out_lines)


def replace_profile_game_sections(profile: dict, incoming: dict) -> None:
    profile["preamble"] = incoming.get("preamble", [])
    profile["sections"] = [
        block for block in profile.get("sections", [])
        if block.get("scope") in ENGINE_PROFILE_SCOPES
    ] + incoming.get("sections", [])


def replace_profile_engine_sections(profile: dict, engine_sections: list[dict]) -> None:
    profile["sections"] = [
        block for block in profile.get("sections", [])
        if block.get("scope") not in ENGINE_PROFILE_SCOPES
    ] + engine_sections


def _advanced_editor_block_label(block: dict) -> str:
    scope = block.get("scope")
    if scope == "Global":
        return "Global"
    if scope == "Map":
        return f"Map {block.get('map')}"
    if scope == "Partition":
        return f"{block.get('map')} partition {block.get('partition')}"
    if scope == "Engine":
        return "Engine"
    if scope == "MapEngine":
        return f"Map {block.get('map')} Engine"
    if scope == "PartitionEngine":
        return f"{block.get('map')} partition {block.get('partition')} Engine"
    return str(scope or "")


def _advanced_editor_duplicate_key_warnings(sections: list[dict]) -> list[str]:
    """Flag a key assigned more than once in the same saved section -- last-line-wins
    is normal INI behavior, but the earlier value(s) otherwise vanish from the
    compiled output with no trace they were ever submitted."""
    warnings: list[str] = []
    for block in sections:
        where = _advanced_editor_block_label(block)
        seen: dict[str, list[str]] = {}
        for raw in block.get("lines", []):
            parsed = split_ini_assignment(raw)
            if not parsed:
                continue
            prefix, left, right = parsed
            if prefix:
                continue
            seen.setdefault(left, []).append(right)
        for key, values in seen.items():
            if len(values) > 1:
                dropped = ", ".join(values[:-1])
                warnings.append(
                    f"{where}: {key} was set {len(values)} times; only the last value "
                    f"({values[-1]}) applies -- earlier value(s) ({dropped}) were dropped."
                )
    return warnings


def _advanced_editor_pvp_pve_warnings(sections: list[dict]) -> list[str]:
    """Flag manually-set +m_Pvp/PveEnabledPartitions lines with wording matched to which
    mechanism can actually change that scope's value: Dual Deep Desert only ever touches
    Global scope, the per-partition PvP/PvE toggle only ever touches Partition scope, and
    nothing structurally manages Map scope for these two keys.

    One message per (scope block, key) -- not per value -- so a section listing several
    partition ids produces one sentence naming all of them instead of one near-identical
    sentence per id (this repeated badly enough during live testing to be worth avoiding)."""
    warnings: list[str] = []
    pvp_section = "/Script/DuneSandbox.PvpPveSettings"
    for block in sections:
        if str(block.get("ini_section", "")) != pvp_section:
            continue
        scope = block.get("scope")
        where = _advanced_editor_block_label(block)
        values_by_key: dict[str, list[str]] = {}
        for raw in block.get("lines", []):
            parsed = split_ini_assignment(raw)
            if not parsed:
                continue
            prefix, left, right = parsed
            if prefix != "+" or left not in {"m_PvpEnabledPartitions", "m_PveEnabledPartitions"}:
                continue
            values_by_key.setdefault(left, []).append(right)
        for key, values in values_by_key.items():
            kind = "PvP" if key == "m_PvpEnabledPartitions" else "PvE"
            single = len(values) == 1
            if scope == "Global":
                consequence = f"If Dual Deep Desert is toggled it could affect {'this setting' if single else 'these settings'}."
            elif scope == "Partition":
                consequence = f"this partition's PvP/PvE toggle could change {'this' if single else 'these'} the next time it's switched."
            elif scope == "Map":
                consequence = f"this applies to every partition in {block.get('map')}; nothing clears it automatically."
            else:
                consequence = "review this manually -- its scope isn't automatically managed."
            if single:
                warnings.append(f"{where}: +{key}={values[0]} ({kind} partition selector) -- {consequence}")
            else:
                warnings.append(f"{where}: +{key} has {len(values)} {kind} entries ({', '.join(values)}) -- {consequence}")
    return warnings


def _advanced_editor_find_scoped_key_value(sections: list[dict], reference_block: dict, section: str, key: str) -> str | None:
    for block in sections:
        if block.get("ini_section") != section or block.get("scope") != reference_block.get("scope"):
            continue
        if block.get("map") != reference_block.get("map") or block.get("partition") != reference_block.get("partition"):
            continue
        # Last-assignment-wins, same as profile_get_key -- a key set twice in one saved
        # block resolves to its last line, so the earlier line must never be returned here.
        for raw in reversed(block.get("lines", [])):
            parsed = split_ini_assignment(raw)
            if parsed and not parsed[0] and parsed[1] == key:
                return parsed[2]
    return None


def _advanced_editor_legacy_field_warnings(sections: list[dict]) -> list[str]:
    """Flag the case sync_legacy_values() (~1024) resolves silently: a non-default
    legacy field overriding a canonical field explicitly set to its own default. The
    canonical field's explicit line is then also dropped by the known-key filter in
    append_profile_unknown_lines(), so without this warning the admin has no way to know
    their explicit default was superseded."""
    warnings: list[str] = []
    for block in sections:
        section = str(block.get("ini_section", ""))
        where = _advanced_editor_block_label(block)
        for legacy_field, canonical_field in LEGACY_FIELD_ALIASES.items():
            legacy_spec = MAP_FIELDS[legacy_field]
            canonical_spec = MAP_FIELDS[canonical_field]
            if section != legacy_spec[0]:
                continue
            legacy_value = _advanced_editor_find_scoped_key_value(sections, block, legacy_spec[0], legacy_spec[1])
            if legacy_value is None or legacy_value == str(legacy_spec[2]):
                continue
            canonical_value = _advanced_editor_find_scoped_key_value(sections, block, canonical_spec[0], canonical_spec[1])
            if canonical_value is not None and canonical_value == str(canonical_spec[2]):
                # Both fields share the same ini key name (that's the whole reason they're
                # aliased) -- name the section too, or an admin has no way to tell which
                # block to go edit.
                warnings.append(
                    f"{where}: legacy field [{legacy_spec[0]}] {legacy_spec[1]}={legacy_value} overrides "
                    f"the explicit default you set on [{canonical_spec[0]}] {canonical_spec[1]}={canonical_value} "
                    f"-- the canonical value was dropped."
                )
    return warnings


def profile_game_write_encoded(encoded_content: str) -> int:
    try:
        content = b64decode(encoded_content.encode("ascii")).decode("utf-8")
    except ValueError as exc:
        raise SystemExit("Invalid UserGame profile payload.") from exc
    incoming = parse_profile_text(content)
    if any(block.get("scope") in ENGINE_PROFILE_SCOPES for block in incoming.get("sections", [])):
        raise SystemExit("UserGame.ini cannot contain Engine scoped sections.")
    for block in incoming.get("sections", []):
        section = str(block.get("ini_section", ""))
        # Global/Map/Partition are now rendered by the UserEngine Advanced tab too (see
        # ENGINE_HEADER_DISPLAY_NAMES), so a scope check alone no longer catches UserEngine
        # content pasted into this tab by mistake -- URL/ConsoleVariables are section names
        # no genuine UserGame field ever uses, so rejecting them here is safe and closes
        # that gap without needing a full section allowlist for UserGame's own content.
        if section in ENGINE_EXCLUSIVE_INI_SECTIONS:
            raise SystemExit(f'UserGame.ini cannot contain a "{section}" section.')
        if block.get("scope") == "Raw":
            block.update({
                "header": profile_header("global", section),
                "scope": "Global",
                "map": "",
                "partition": "",
                "ini_section": section,
            })
    warnings = (
        _advanced_editor_duplicate_key_warnings(incoming.get("sections", []))
        + _advanced_editor_pvp_pve_warnings(incoming.get("sections", []))
        + _advanced_editor_legacy_field_warnings(incoming.get("sections", []))
    )
    profile = read_profile()
    replace_profile_game_sections(profile, incoming)
    write_profile(profile)
    for message in warnings:
        print(f"USERSETTINGS_WARNING: {message}")
    return 0


def _validate_engine_section(scope: str, section: str, existing_sections_by_scope: dict[str, set[str]]) -> None:
    # A section name the schema doesn't use for this scope is allowed only if it was
    # already present in the stored profile before this save -- otherwise a pasted
    # UserGame section (now indistinguishable by header vocabulary alone) could reach
    # compiled_userengine_ini() as an injected section, and URL could be smuggled into a
    # MapEngine/PartitionEngine scope where it has never legitimately existed. Grandfathering
    # in pre-existing names (legal to save before this allowlist existed) keeps an unmodified
    # resubmit of a legacy custom section from blocking the whole document.
    if section in ENGINE_ALLOWED_SECTIONS_BY_SCOPE[scope] or section in existing_sections_by_scope.get(scope, set()):
        return
    raise SystemExit(f'UserEngine.ini cannot contain a "{section}" section.')


def profile_engine_write_encoded(encoded_content: str) -> int:
    try:
        content = b64decode(encoded_content.encode("ascii")).decode("utf-8")
    except ValueError as exc:
        raise SystemExit("Invalid UserEngine payload.") from exc
    content = _internal_engine_header_text(content)
    parsed = parse_profile_text(content)
    profile = read_profile()
    existing_sections_by_scope: dict[str, set[str]] = {}
    for block in profile.get("sections", []):
        scope = block.get("scope")
        if scope in ENGINE_PROFILE_SCOPES:
            existing_sections_by_scope.setdefault(scope, set()).add(str(block.get("ini_section", "")))
    engine_sections = []
    for block in parsed.get("sections", []):
        scope = block.get("scope")
        if scope != "Raw":
            if scope not in ENGINE_PROFILE_SCOPES:
                raise SystemExit("UserEngine.ini can only contain normal UserEngine or Engine scoped sections.")
            section = str(block.get("ini_section", ""))
            _validate_engine_section(scope, section, existing_sections_by_scope)
            engine_sections.append(block)
            continue
        section = str(block.get("ini_section", ""))
        _validate_engine_section("Engine", section, existing_sections_by_scope)
        engine_sections.append({
            "header": profile_header("engine", section),
            "scope": "Engine",
            "map": "",
            "partition": "",
            "ini_section": section,
            "lines": block.get("lines", []),
        })
    incoming = {"preamble": [], "sections": engine_sections}
    validate_profile_port_ranges(incoming)
    warnings = _advanced_editor_duplicate_key_warnings(engine_sections)
    replace_profile_engine_sections(profile, incoming.get("sections", []))
    write_profile(profile)
    for message in warnings:
        print(f"USERSETTINGS_WARNING: {message}")
    return 0


def profile_selftest() -> int:
    text = """; keep me
[Global:/Script/DuneSandbox.DuneGameMode]
m_GlobalXPMultiplier=1.0
m_DefaultReconnectGracePeriodSeconds=300
m_MaxGuildMembersAllowed=5
UnknownGlobal=abc

[Global:/Script/DuneSandbox.GuildSettings]
m_MaxGuildMembersAllowed=32

[Global:/Script/DuneSandbox.PvpPveSettings]
+m_PvpEnabledPartitions=3
+m_PvpEnabledPartitions=7
+m_PveEnabledPartitions=9

[Map:Survival_1:/Script/DuneSandbox.DuneGameMode]
m_GlobalXPMultiplier=2.0
m_DefaultReconnectGracePeriodSeconds=600

[Map:Survival_1:/Script/DuneSandbox.PvpPveSettings]
+m_PvpEnabledPartitions=15

[MapEngine:Survival_1:ConsoleVariables]
Sandstorm.Enabled=0
CustomMapEngineValue=keep-map

[Partition:Survival_1:3:/Script/DuneSandbox.PvpPveSettings]
+m_PvpEnabledPartitions=3
+m_PvpEnabledPartitions=42
CustomPartitionKey=True

[Partition:Survival_1:3:ConsoleVariables]
Bgd.ServerLoginPassword="legacy-password"

[PartitionEngine:Survival_1:3:ConsoleVariables]
sandworm.dune.Enabled=0
CustomPartitionEngineValue=keep-partition

[Engine:ConsoleVariables]
; Sandworm settings
Dune.GlobalMiningOutputMultiplier=1.0
UnknownEngine=xyz

[ConsoleVariables]
Dune.GlobalVehicleMiningOutputMultiplier=10
"""
    profile = parse_profile_text(text)
    serialized = serialize_profile(profile)
    reparsed = parse_profile_text(serialized)
    if "UnknownGlobal=abc" not in serialized or "UnknownEngine=xyz" not in serialized:
        raise SystemExit("Profile round trip dropped unknown keys.")
    if profile_map_values(reparsed, "Survival_1")["default_reconnect_grace_period_seconds"] != "600":
        raise SystemExit("Map override did not win over global profile value.")
    if profile_partition_engine_values(reparsed, "Survival_1", "3").get("server_login_password") != "legacy-password":
        raise SystemExit("Legacy partition password did not feed scoped UserEngine values.")
    identity_profile = parse_profile_text(serialized)
    set_profile_field(identity_profile, "partition_engine", "Survival_1", "3", "server_login_password", "")
    if "Bgd.ServerLoginPassword=" in serialize_profile(identity_profile):
        raise SystemExit("Clearing a partition password left a legacy value behind.")
    compiled_game = compiled_usergame_ini(reparsed, "Survival_1", "3")
    compiled_engine = compiled_userengine_ini(reparsed)
    compiled_map_engine = compiled_userengine_ini(reparsed, "Survival_1")
    compiled_partition_engine = compiled_userengine_ini(reparsed, "Survival_1", "3")
    if "[Global:" in compiled_game or "[Map:" in compiled_game or "[Partition:" in compiled_game or "[Engine:" in compiled_engine:
        raise SystemExit("Compiled runtime INI contains scoped profile headers.")
    if "+m_PvpEnabledPartitions=3" not in compiled_game:
        raise SystemExit("Partition PvP array line was not compiled.")
    if "+m_PvpEnabledPartitions=7" not in compiled_game or "+m_PveEnabledPartitions=9" not in compiled_game:
        raise SystemExit("Global-scoped Advanced editor PvP/PvE array lines were not compiled.")
    if "m_bShouldForceEnablePvpOnAllPartitions=False" not in compiled_game:
        raise SystemExit("Partition selector mode did not materialize its explicit force-PvP-all=False guard.")
    if compiled_game.count("+m_PvpEnabledPartitions=3") != 1:
        raise SystemExit("Global and partition-toggle PvP array lines for the same value were not deduplicated.")
    # The seed profile above has BOTH a legacy DuneGameMode value (5) and an explicit
    # canonical GuildSettings value (32) at global scope. Presence, not a value-vs-default
    # comparison, must pick the winner (see sync_legacy_values) -- canonical wins, and
    # since 32 is also both fields' shared schema default, neither section emits the key.
    if "m_MaxGuildMembersAllowed=5" in compiled_game:
        raise SystemExit("A stale legacy guild member limit leaked into the compiled UserGame.ini over an explicit canonical value.")
    if profile_map_values(reparsed, "Survival_1")["guild_settings_max_guild_members_allowed"] != "32":
        raise SystemExit("An explicit canonical guild member limit did not win over a conflicting legacy value.")
    if not any("m_MaxGuildMembersAllowed=5" in w and "m_MaxGuildMembersAllowed=32" in w for w in legacy_alias_conflict_warnings(reparsed, "global")):
        raise SystemExit("A conflicting legacy/canonical guild member limit did not raise a warning.")
    if "UnknownGlobal=abc" not in compiled_game or "CustomPartitionKey=True" not in compiled_game:
        raise SystemExit("Compiled UserGame dropped unknown profile lines.")
    if "m_GlobalXPMultiplier=" in compiled_game:
        raise SystemExit("Retired unsupported UserGame field leaked into compiled runtime INI.")
    if "UnknownEngine=xyz" not in compiled_engine:
        raise SystemExit("Compiled UserEngine dropped unknown profile lines.")
    if ENGINE_FIELDS["deathstill_conversion_time_override"][2] != "" or "Deathstill.ConversionTimeOverride=" in compiled_engine:
        raise SystemExit("Unconfirmed Deathstill conversion default was emitted as a server override.")
    # Sandstorm.Enabled was never set at global scope, so it sits at its schema
    # default there (1) -- compiled_userengine_ini() only writes non-default values
    # (see field_value_is_default()), so it must be OMITTED from the global ini
    # entirely, not written as "=1". The map-level override (0) differs from that
    # default, so it must still be written for that map's compiled ini.
    if "Sandstorm.Enabled=" in compiled_engine:
        raise SystemExit("Default-valued global UserEngine field was written despite matching the schema default.")
    if "Sandstorm.Enabled=0" not in compiled_map_engine:
        raise SystemExit("Map UserEngine override did not win over the global value.")
    if "sandworm.dune.Enabled=0" not in compiled_partition_engine:
        raise SystemExit("Partition UserEngine override was not compiled.")
    if "CustomMapEngineValue=keep-map" not in compiled_map_engine:
        raise SystemExit("Advanced map UserEngine value was not compiled.")
    if "CustomPartitionEngineValue=keep-partition" not in compiled_partition_engine:
        raise SystemExit("Advanced partition UserEngine value was not compiled.")
    if "Sandstorm.Enabled=" in compiled_game or "sandworm.dune.Enabled=" in compiled_game:
        raise SystemExit("Scoped UserEngine values leaked into UserGame.ini.")
    client_game = client_game_ini(reparsed, "Survival_1", "3")
    if "[Global:" in client_game or "[Map:" in client_game or "[Partition:" in client_game:
        raise SystemExit("Client Game.ini export contains scoped Docker profile headers.")
    for server_only in ("m_DefaultReconnectGracePeriodSeconds", "UnknownGlobal", "CustomPartitionKey", "m_GlobalXPMultiplier"):
        if server_only in client_game:
            raise SystemExit(f"Server-only UserGame value leaked into client Game.ini export: {server_only}")
    profile_set_key(reparsed, "global", BUILDING_SETTINGS_SECTION, "m_MaxNumLandclaimSegments", "20")
    profile_set_key(reparsed, "global", BUILDING_SETTINGS_SECTION, "m_bBuildingRestrictionLimitsEnabled", "False")
    matched_building_client_game = client_game_ini(reparsed, "Survival_1", "3")
    if "m_MaxNumLandclaimSegments=20" not in matched_building_client_game:
        raise SystemExit("Client-required landclaim segment limit did not carry into the client Game.ini export.")
    if "m_bBuildingRestrictionLimitsEnabled=False" not in matched_building_client_game:
        raise SystemExit("Client-required building restriction setting did not carry into the client Game.ini export.")
    profile_set_key(reparsed, "global", "ConsoleVariables", "Bgd.ServerDisplayName", quote_ini_string("Do Not Export"))
    profile_set_key(reparsed, "global", "ConsoleVariables", "Bgd.ServerLoginPassword", quote_ini_string("Do Not Export"))
    bgd_filtered_client_game = client_game_ini(reparsed, "Survival_1", "3")
    if "Bgd.ServerDisplayName=" in bgd_filtered_client_game or "Bgd.ServerLoginPassword=" in bgd_filtered_client_game:
        raise SystemExit("Client Game.ini export included BGD identity values.")
    if profile_engine_values(reparsed)["vehicle_mining_output_multiplier"] != "10":
        raise SystemExit("Plain UserEngine raw section did not feed interactive engine values.")
    profile_set_key(reparsed, "global", "/Script/DuneSandbox.DuneGameMode", "m_DefaultReconnectGracePeriodSeconds", "900")
    if "UnknownGlobal=abc" not in serialize_profile(reparsed):
        raise SystemExit("Interactive profile update dropped unknown keys.")
    profile_set_key(reparsed, "global", "/Script/DuneSandbox.BuildingSettings", "m_BaseBackupToolTimeRestrictionInSeconds", "60")
    if profile_map_values(reparsed, "Survival_1")["base_backup_tool_time_restriction_seconds"] != "60":
        raise SystemExit("Base backup tool time restriction did not feed interactive map values.")
    if "m_BaseBackupToolTimeRestrictionInSeconds=60" not in compiled_usergame_ini(reparsed, "Survival_1", "3"):
        raise SystemExit("Base backup tool time restriction did not compile from interactive profile update.")
    if "m_BaseBackupToolTimeRestrictionInSeconds=60" not in client_game_ini(reparsed, "Survival_1", "3"):
        raise SystemExit("Base backup tool time restriction did not carry into the client Game.ini export.")
    if CLIENT_FILE_REQUIRED.get("base_backup_tool_time_restriction_seconds") != "Game.ini":
        raise SystemExit("Base backup tool time restriction is not flagged as requiring a client Game.ini update.")
    if profile_map_values(reparsed, "Survival_1")["building_restriction_limits_enabled"] != "True":
        raise SystemExit("Building restriction limits did not default to enabled when unset.")
    profile_set_key(reparsed, "global", BUILDING_SETTINGS_SECTION, "m_bBuildingRestrictionLimitsEnabled", "False")
    if profile_map_values(reparsed, "Survival_1")["building_restriction_limits_enabled"] != "False":
        raise SystemExit("An explicit disabled building restriction limit was overwritten by the default.")
    if "m_bBuildingRestrictionLimitsEnabled=False" not in compiled_usergame_ini(reparsed, "Survival_1", "3"):
        raise SystemExit("An explicit disabled building restriction limit did not compile.")
    set_profile_field(reparsed, "global", "", "", "landsraad_cycle_duration_seconds", "1209600")
    set_profile_field(reparsed, "global", "", "", "landsraad_player_voting_enabled", "False")
    landsraad_data = profile_get_key(reparsed, "global", LANDSRAAD_SETTINGS_SECTION, LANDSRAAD_DATA_KEY) or ""
    landsraad_members = unreal_struct_values(landsraad_data)
    if landsraad_members.get("m_LandsraadCycleDurationInSeconds") != "1209600":
        raise SystemExit("Landsraad cycle duration did not update the managed Data structure.")
    if landsraad_members.get("m_bIsPlayerVotingEnabled") != "False":
        raise SystemExit("Landsraad voting toggle did not update the managed Data structure.")
    if "m_LandsraadTaskRewardsData" not in landsraad_members or "m_ControlPointAreaMaterial" not in landsraad_members:
        raise SystemExit("Landsraad modifier update dropped required internal Data members.")
    if profile_global_values(reparsed)["landsraad_cycle_duration_seconds"] != "1209600":
        raise SystemExit("Managed Landsraad Data did not feed global modifier values.")

    advanced_game = parse_profile_text(serialize_profile({
        "preamble": ["; Advanced UserGame round trip"],
        "sections": [
            block for block in reparsed.get("sections", [])
            if block.get("scope") not in ENGINE_PROFILE_SCOPES
        ],
    }))
    replace_profile_game_sections(reparsed, advanced_game)
    advanced_engine = parse_profile_text(
        "[Engine:ConsoleVariables]\nUnknownEngine=still-here\n"
        "[MapEngine:Survival_1:ConsoleVariables]\nCustomMapEngineValue=keep-map\n"
        "[PartitionEngine:Survival_1:3:ConsoleVariables]\nCustomPartitionEngineValue=keep-partition\n"
    )
    replace_profile_engine_sections(reparsed, advanced_engine.get("sections", []))
    advanced_round_trip = serialize_profile(reparsed)
    if "UnknownGlobal=abc" not in advanced_round_trip or "CustomPartitionKey=True" not in advanced_round_trip:
        raise SystemExit("Advanced INI round trip dropped existing UserGame values.")
    if "CustomMapEngineValue=keep-map" not in advanced_round_trip or "CustomPartitionEngineValue=keep-partition" not in advanced_round_trip:
        raise SystemExit("Advanced INI round trip dropped scoped UserEngine values that were resubmitted.")
    # A stale scoped section that is NOT resubmitted must be dropped, not preserved --
    # this is the correctness fix replace_profile_engine_sections needed once it started
    # stripping all of ENGINE_PROFILE_SCOPES instead of just "Engine".
    stale_drop = parse_profile_text("[Engine:ConsoleVariables]\nUnknownEngine=still-here\n")
    replace_profile_engine_sections(reparsed, stale_drop.get("sections", []))
    stale_dropped = serialize_profile(reparsed)
    if "CustomMapEngineValue=keep-map" in stale_dropped or "CustomPartitionEngineValue=keep-partition" in stale_dropped:
        raise SystemExit("Stale scoped UserEngine section was not dropped on save.")
    preserved_landsraad = profile_get_key(reparsed, "global", LANDSRAAD_SETTINGS_SECTION, LANDSRAAD_DATA_KEY) or ""
    if unreal_struct_values(preserved_landsraad).get("m_LandsraadCycleDurationInSeconds") != "1209600":
        raise SystemExit("Advanced INI round trip dropped the Landsraad Data structure.")
    try:
        set_profile_field(reparsed, "global", "", "", "landsraad_cycle_duration_seconds", "59")
        raise SystemExit("Invalid Landsraad cycle duration was accepted.")
    except SystemExit as exc:
        if str(exc) == "Invalid Landsraad cycle duration was accepted.":
            raise
    building_defaults = profile_map_values(parse_profile_text(""), "Survival_1")
    expected_building_defaults = {
        "build_range": "3000.000000",
        "building_height_limit_m": "1500.000000",
        "free_translate_max": "200.000000",
        "free_rotate_max": "90.000000",
        "default_repair_cost_multiplier": "0.25",
        "pickup_total_durability_reduction": "0.0",
        "base_backup_tool_time_restriction_seconds": "604800",
        "fallback_default_building_health": "5000.000000",
        "fallback_default_placeable_health": "1000.000000",
        "building_destabilization_system_enabled": "False",
        "sand_buildup_placeables_sheltered_target_value": "0.1",
        "sand_buildup_placeables_unsheltered_target_value": "0.3",
        "max_landclaim_segments": "6",
        "building_blueprint_max_extensions": "4",
        "base_backup_max_extensions": "8",
        "building_restriction_limits_enabled": "True",
    }
    for field_id, expected in expected_building_defaults.items():
        if building_defaults.get(field_id) != expected:
            raise SystemExit(f"Building modifier default is incorrect for {field_id}.")
    legacy_staking = parse_profile_text(
        f"[Global:{BUILDING_SETTINGS_SECTION}]\n"
        "m_StakingUnitExtensionDefaultTimes=2\n"
        "-m_StakingUnitExtensionDefaultTimes=60.000000\n"
        "m_StakingUnitVerticalExtensionDefaultTimes=3\n"
        "+m_StakingUnitVerticalExtensionDefaultTimes=120.000000\n"
    )
    compiled_staking = compiled_usergame_ini(legacy_staking, "Survival_1")
    expected_staking_values = {
        "m_StakingUnitExtensionDefaultTimes": "2.000000",
        "m_StakingUnitVerticalExtensionDefaultTimes": "3.000000",
    }
    rendered_lines = compiled_staking.splitlines()
    for key, expected in expected_staking_values.items():
        if rendered_lines.count(f"!{key}=ClearArray") != 1:
            raise SystemExit(f"Safe staking array did not clear the packaged values exactly once: {key}")
        if rendered_lines.count(f".{key}={expected}") != STAKING_EXTENSION_ARRAY_LENGTH:
            raise SystemExit(f"Safe staking array did not preserve all extension levels: {key}")
        if any(line.startswith((f"{key}=", f"+{key}=", f"-{key}=")) for line in rendered_lines):
            raise SystemExit(f"Unsafe legacy staking array syntax was materialized: {key}")
        if key in client_game_ini(legacy_staking, "Survival_1"):
            raise SystemExit(f"Server-only staking array leaked into client Game.ini export: {key}")
    cleaned_staking = parse_profile_text(
        f"[Global:{BUILDING_SETTINGS_SECTION}]\n"
        "m_StakingUnitExtensionDefaultTimes=1\n"
        "-m_StakingUnitExtensionDefaultTimes=60.000000\n"
        ".m_StakingUnitExtensionDefaultTimes=120.000000\n"
    )
    set_profile_field(cleaned_staking, "global", "", "", "staking_unit_extension_default_times", "2")
    cleaned_lines = cleaned_staking["sections"][0]["lines"]
    if cleaned_lines != ["m_StakingUnitExtensionDefaultTimes=2.000000"]:
        raise SystemExit("Saving a staking duration did not clean legacy array fragments from the editable profile.")
    for invalid_staking_value in ("0", "nan", "604801"):
        try:
            normalize_staking_extension_seconds(invalid_staking_value)
        except SystemExit:
            pass
        else:
            raise SystemExit(f"Invalid staking duration was accepted: {invalid_staking_value}")
    if any(key in compiled_usergame_ini(parse_profile_text(""), "Survival_1") for key in UNSAFE_STAKING_EXTENSION_KEYS):
        raise SystemExit("Fresh UserGame compilation overrides the packaged staking arrays.")
    if infer_runtime_target(Path("/tmp/runtime/game/survival-1-34/Saved")) != ("Survival_1", "34"):
        raise SystemExit("Dynamic Survival runtime folder was not inferred.")
    if infer_runtime_target(Path("/tmp/runtime/game/deepdesert-1-58/Saved")) != ("DeepDesert_1", "58"):
        raise SystemExit("Dynamic Deep Desert runtime folder was not inferred.")

    if "+m_PvpEnabledPartitions=42" not in compiled_game:
        raise SystemExit("A Partition-scope PvP array line with no matching structured emission was still silently dropped.")
    if "+m_PvpEnabledPartitions=15" not in compiled_game:
        raise SystemExit("Map-scoped PvP array line was not compiled into the partition's UserGame.ini.")
    if "; Sandworm settings" not in compiled_engine:
        raise SystemExit("A manually-kept UserEngine comment next to a default-valued field was still deleted.")

    dup_sections = parse_profile_text(
        "[Global:/Script/DuneSandbox.DuneGameMode]\nm_MaxGuildsAllowed=1\nm_MaxGuildsAllowed=2\n"
    ).get("sections", [])
    dup_warnings = _advanced_editor_duplicate_key_warnings(dup_sections)
    if not any("m_MaxGuildsAllowed was set 2 times" in w and "(1)" in w and "(2)" in w for w in dup_warnings):
        raise SystemExit("Duplicate-key Advanced Editor warning did not fire correctly.")

    legacy_warnings = _advanced_editor_legacy_field_warnings(reparsed.get("sections", []))
    if not any("m_MaxGuildMembersAllowed=5 overrides" in w for w in legacy_warnings):
        raise SystemExit("Legacy guild-alias override warning did not fire.")

    # Regression: _advanced_editor_find_scoped_key_value must use the LAST assignment of a
    # duplicated key (matching profile_get_key's last-wins semantics), not the first -- the
    # canonical field below is set twice, non-default then default, so a first-match read
    # would see "99" and wrongly conclude the explicit default was never set, suppressing
    # the legacy-alias-override warning this whole mechanism exists to raise.
    last_wins_sections = parse_profile_text(
        "[Global:/Script/DuneSandbox.DuneGameMode]\nm_MaxGuildMembersAllowed=5\n"
        "[Global:/Script/DuneSandbox.GuildSettings]\nm_MaxGuildMembersAllowed=99\nm_MaxGuildMembersAllowed=32\n"
    ).get("sections", [])
    last_wins_warnings = _advanced_editor_legacy_field_warnings(last_wins_sections)
    if not any("m_MaxGuildMembersAllowed=5 overrides" in w and "m_MaxGuildMembersAllowed=32" in w for w in last_wins_warnings):
        raise SystemExit("Legacy guild-alias warning used the first assignment of a duplicated canonical key instead of the last-wins effective value.")

    pvp_scope_warnings = _advanced_editor_pvp_pve_warnings(reparsed.get("sections", []))
    global_warning = next((w for w in pvp_scope_warnings if w.startswith("Global:")), None)
    partition_warning = next((w for w in pvp_scope_warnings if w.startswith("Survival_1 partition 3:")), None)
    map_warning = next((w for w in pvp_scope_warnings if w.startswith("Map Survival_1:")), None)
    if not global_warning or "Dual Deep Desert" not in global_warning:
        raise SystemExit("Global-scope PvP warning did not mention Dual Deep Desert.")
    if not partition_warning or "partition's PvP/PvE toggle" not in partition_warning:
        raise SystemExit("Partition-scope PvP warning did not mention the per-partition toggle.")
    if not map_warning or "nothing clears it automatically" not in map_warning:
        raise SystemExit("Map-scope PvP warning was not framed as an FYI.")
    if "Dual Deep Desert" in partition_warning or "PvP/PvE toggle" in global_warning:
        raise SystemExit("PvP warning wording was not scope-specific -- it named the wrong mechanism.")
    if "2 PvP entries (3, 7)" not in global_warning:
        raise SystemExit("Multiple Global-scope PvP values were not aggregated into a single warning.")
    if "2 PvP entries (3, 42)" not in partition_warning:
        raise SystemExit("Multiple Partition-scope PvP values were not aggregated into a single warning.")
    if sum(1 for w in pvp_scope_warnings if w.startswith("Global:") and "m_PvpEnabledPartitions" in w) != 1:
        raise SystemExit("Global-scope m_PvpEnabledPartitions values leaked into more than one warning line.")

    toggle_profile = parse_profile_text("")
    set_profile_field(toggle_profile, "global", "", "", "global_pvp_enabled_partition_add", "8")
    set_profile_field(toggle_profile, "global", "", "", "global_pvp_enabled_partition_add", "55")
    set_profile_field(toggle_profile, "global", "", "", "global_pvp_enabled_partition_add", "8")
    toggle_serialized = serialize_profile(toggle_profile)
    if toggle_serialized.count("+m_PvpEnabledPartitions=8") != 1:
        raise SystemExit("global_pvp_enabled_partition_add was not idempotent.")
    if "+m_PvpEnabledPartitions=55" not in toggle_serialized:
        raise SystemExit("global_pvp_enabled_partition_add did not add the entry.")
    set_profile_field(toggle_profile, "global", "", "", "global_pvp_enabled_partition_remove", "8")
    toggle_after_remove = serialize_profile(toggle_profile)
    if "+m_PvpEnabledPartitions=8" in toggle_after_remove:
        raise SystemExit("global_pvp_enabled_partition_remove did not remove the exact value.")
    if "+m_PvpEnabledPartitions=55" not in toggle_after_remove:
        raise SystemExit("global_pvp_enabled_partition_remove touched an unrelated entry -- it must be exact-value only.")

    pve_toggle_profile = parse_profile_text("")
    set_profile_field(pve_toggle_profile, "global", "", "", "global_pve_enabled_partition_add", "9")
    set_profile_field(pve_toggle_profile, "global", "", "", "global_pve_enabled_partition_add", "60")
    set_profile_field(pve_toggle_profile, "global", "", "", "global_pve_enabled_partition_add", "9")
    pve_toggle_serialized = serialize_profile(pve_toggle_profile)
    if pve_toggle_serialized.count("+m_PveEnabledPartitions=9") != 1:
        raise SystemExit("global_pve_enabled_partition_add was not idempotent.")
    if "+m_PveEnabledPartitions=60" not in pve_toggle_serialized:
        raise SystemExit("global_pve_enabled_partition_add did not add the entry.")
    set_profile_field(pve_toggle_profile, "global", "", "", "global_pve_enabled_partition_remove", "9")
    pve_toggle_after_remove = serialize_profile(pve_toggle_profile)
    if "+m_PveEnabledPartitions=9" in pve_toggle_after_remove:
        raise SystemExit("global_pve_enabled_partition_remove did not remove the exact value.")
    if "+m_PveEnabledPartitions=60" not in pve_toggle_after_remove:
        raise SystemExit("global_pve_enabled_partition_remove touched an unrelated entry -- it must be exact-value only.")

    # Regression coverage for the Dual Deep Desert PvP/PvE scope bugs found in review:
    # (1) force_pvp_all_partitions must stay Map-scoped so it can't leak into another map's
    #     Global-scope setting, and (2) the PvE partition must resolve to PVE via its own
    #     explicit Global selector even when an unrelated legacy override would otherwise
    #     force it to PvP/CONFLICT through the legacy-field fallback rules.
    dual_regression_profile = parse_profile_text(
        "[Global:/Script/DuneSandbox.PvpPveSettings]\n"
        "m_bShouldForceEnablePvpOnAllPartitions=True\n"
        "[Global:/Script/DuneSandbox.DuneGameMode]\n"
        "bPvPEnabled=True\n"
        "bServerPVE=False\n"
    )
    set_profile_field(dual_regression_profile, "map", "DeepDesert_1", "", "force_pvp_all_partitions", "False")
    set_profile_field(dual_regression_profile, "global", "", "", "global_pvp_enabled_partition_add", "58")
    set_profile_field(dual_regression_profile, "global", "", "", "global_pve_enabled_partition_add", "12")
    other_map_values = profile_map_values(dual_regression_profile, "Survival_1")
    if other_map_values.get("force_pvp_all_partitions") != "True":
        raise SystemExit("force_pvp_all_partitions at Map:DeepDesert_1 leaked into Survival_1's resolved value.")
    pve_state = resolve_partition_combat_state(profile_partition_values(dual_regression_profile, "DeepDesert_1", "12"))
    if pve_state["state"] != "PVE":
        raise SystemExit(f"Deep Desert PvE partition did not resolve to PVE despite an explicit selector (got {pve_state['state']}).")
    pvp_state = resolve_partition_combat_state(profile_partition_values(dual_regression_profile, "DeepDesert_1", "58"))
    if pvp_state["state"] != "PVP":
        raise SystemExit(f"Deep Desert PvP partition did not resolve to PVP despite an explicit selector (got {pvp_state['state']}).")

    print("profile selftest ok")
    return 0


def materialize_current_runtime_files() -> int:
    profile = read_profile()
    game_root = Path(os.environ.get("DUNE_USERSETTINGS_GAME_ROOT", str(ROOT / "runtime" / "game")))
    partition_catalog_path = SIETCH_CONFIG_PATH.parent / "partition-catalog.json"
    if not game_root.exists():
        return 0

    targets: list[tuple[str, Path, str | None]] = []

    overmap_dir = game_root / "overmap" / "Saved"
    if overmap_dir.exists():
        targets.append(("Overmap", overmap_dir, "2"))

    survival_dir = game_root / "survival-1" / "Saved"
    if survival_dir.exists():
        targets.append(("Survival_1", survival_dir, "1"))

    catalog_rows = []
    if partition_catalog_path.exists():
        try:
            catalog_rows = json.loads(partition_catalog_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            catalog_rows = []

    seen_paths = {path.resolve() for _, path, _ in targets if path.exists()}
    for row in catalog_rows:
        map_name = str(row.get("map", "")).strip()
        partition_id = str(row.get("id", "")).strip()
        if not map_name or not partition_id:
            continue
        saved_dir = game_root / safe_runtime_dir_name(map_name, partition_id) / "Saved"
        if not saved_dir.exists():
            continue
        resolved = saved_dir.resolve()
        if resolved in seen_paths:
            continue
        targets.append((canonical_map(map_name), saved_dir, partition_id))
        seen_paths.add(resolved)

    for saved_dir in game_root.glob("*/Saved"):
        if not saved_dir.is_dir():
            continue
        resolved = saved_dir.resolve()
        if resolved in seen_paths:
            continue
        inferred = infer_runtime_target(saved_dir)
        if not inferred:
            continue
        map_name, partition_id = inferred
        targets.append((map_name, saved_dir, partition_id))
        seen_paths.add(resolved)

    expected_engine_paths: set[Path] = set()

    for map_name, saved_dir, partition_id in targets:
        user_settings_dir = saved_dir / "UserSettings"
        user_settings_dir.mkdir(parents=True, exist_ok=True)
        engine_path = user_settings_dir / "UserEngine.ini"
        game_path = user_settings_dir / "UserGame.ini"
        expected_engine_paths.add(engine_path.resolve())
        write_compiled_userengine(engine_path, profile, canonical_map(map_name), partition_id)
        write_compiled_usergame(game_path, profile, canonical_map(map_name), partition_id)

    for engine_path in game_root.glob("*/Saved/UserSettings/UserEngine.ini"):
        if engine_path.resolve() in expected_engine_paths:
            continue
        for key in ("server_display_name", "server_login_password"):
            spec = ENGINE_FIELDS[key]
            remove_ini_key(engine_path, spec[0], spec[1])
    return 0


def materialize(map_name: str, saved_dir: str, partition_id: str | None = None) -> int:
    profile = read_profile()
    target_map = canonical_map(map_name)
    user_settings_dir = Path(saved_dir) / "UserSettings"
    user_settings_dir.mkdir(parents=True, exist_ok=True)
    engine_path = user_settings_dir / "UserEngine.ini"
    game_path = user_settings_dir / "UserGame.ini"
    write_compiled_userengine(engine_path, profile, target_map, str(partition_id) if partition_id else None)
    write_compiled_usergame(game_path, profile, target_map, str(partition_id) if partition_id else None)
    return 0


# ─── Partition combat-state resolver ────────────────────────────────────────
#
# Resolves the effective PvP/PvE combat state of a map partition from the
# same merged UserGame.ini configuration fields that generate the partition
# runtime files (see `merged_partition_values` / PARTITION_FIELDS above).
#
# This resolver intentionally does NOT use database dimension indexes,
# database labels, display names, service names, container names, or
# lifecycle modes as inputs. Those remain descriptive metadata only and are
# attached by callers (e.g. the Console API) alongside this resolver's
# output, never as a substitute for it.

PARTITION_COMBAT_STATES = ("PVP", "PVE", "CONFLICT", "UNKNOWN")
MAP_COMBAT_STATES = ("PVP", "PVE", "MIXED", "CONFLICT", "UNKNOWN")

# Fields compared between the persisted profile ("configured") and the
# materialized runtime UserGame.ini ("materialized") to detect drift/pending
# restarts. Order is not significant.
COMBAT_STATE_FIELDS = (
    "force_pvp_all_partitions",
    "partition_selector_mode_active",
    "partition_pvp_enabled",
    "partition_pve_enabled",
    "legacy_pvp_enabled",
    "server_pve",
    "security_zones_enabled",
)


def bool_or_none(value) -> bool | None:
    """Tri-state boolean normalization.

    Recognizes 1/true/yes/on as True and 0/false/no/off as False
    (case-insensitive, surrounding whitespace ignored). Anything else
    (including None/empty) returns None so that callers can distinguish
    "explicitly false" from "unknown/unsupported" rather than silently
    coercing incomplete configuration into a false reading.
    """
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return None


def resolve_partition_combat_state(values: dict) -> dict:
    """Resolve a single partition's PvP/PvE combat state.

    `values` must contain (or omit, for UNKNOWN) the keys:
      force_pvp_all_partitions, partition_selector_mode_active,
      partition_pvp_enabled, partition_pve_enabled,
      legacy_pvp_enabled, server_pve, security_zones_enabled

    Returns a dict with keys: state, source, securityZonesEnabled, warnings,
    unresolvedFields. `state` is one of PARTITION_COMBAT_STATES.

    Precedence (highest to lowest):
      1. partition_pvp_enabled AND partition_pve_enabled       -> CONFLICT
      2. force_pvp_all_partitions AND partition_pve_enabled    -> CONFLICT
      3. force_pvp_all_partitions                              -> PVP
      4. partition_pvp_enabled                                 -> PVP
      5. partition_pve_enabled                                 -> PVE
      6. selector mode active, partition not otherwise listed  -> PVE
      7. legacy_pvp_enabled AND NOT server_pve                 -> PVP
      8. NOT legacy_pvp_enabled AND server_pve                 -> PVE
      9. otherwise                                              -> UNKNOWN

    Explicit partition selectors (rules 1, 2, 4, 5) always take precedence
    over the legacy compatibility fields (rules 6, 7). Unresolved (None)
    values never satisfy a positive comparison, so missing/unsupported
    configuration cannot be mistaken for an explicit selection.
    """
    force_all_pvp = bool_or_none(values.get("force_pvp_all_partitions"))
    selector_mode_active = bool_or_none(values.get("partition_selector_mode_active"))
    partition_pvp = bool_or_none(values.get("partition_pvp_enabled"))
    partition_pve = bool_or_none(values.get("partition_pve_enabled"))
    legacy_pvp = bool_or_none(values.get("legacy_pvp_enabled"))
    server_pve = bool_or_none(values.get("server_pve"))
    security_zones_enabled = bool_or_none(values.get("security_zones_enabled"))

    unresolved_fields = [
        key for key, raw in (
            ("force_pvp_all_partitions", values.get("force_pvp_all_partitions")),
            ("partition_selector_mode_active", values.get("partition_selector_mode_active")),
            ("partition_pvp_enabled", values.get("partition_pvp_enabled")),
            ("partition_pve_enabled", values.get("partition_pve_enabled")),
            ("legacy_pvp_enabled", values.get("legacy_pvp_enabled")),
            ("server_pve", values.get("server_pve")),
            ("security_zones_enabled", values.get("security_zones_enabled")),
        )
        if bool_or_none(raw) is None
    ]

    warnings: list[str] = []

    if partition_pvp is True and partition_pve is True:
        return {
            "state": "CONFLICT",
            "source": "partition-selectors",
            "securityZonesEnabled": bool(security_zones_enabled),
            "warnings": ["Partition is explicitly included in both PvP and PvE selectors."],
            "unresolvedFields": unresolved_fields,
        }

    if force_all_pvp is True and partition_pve is True:
        return {
            "state": "CONFLICT",
            "source": "force-all-vs-partition",
            "securityZonesEnabled": bool(security_zones_enabled),
            "warnings": ["Global force-PvP conflicts with the partition PvE selector."],
            "unresolvedFields": unresolved_fields,
        }

    if security_zones_enabled is False:
        warnings.append("Security zones are disabled; PvP and abilities may be available everywhere.")

    if force_all_pvp is True:
        return {
            "state": "PVP",
            "source": "force-pvp-all-partitions",
            "securityZonesEnabled": bool(security_zones_enabled),
            "warnings": warnings,
            "unresolvedFields": unresolved_fields,
        }

    if partition_pvp is True:
        return {
            "state": "PVP",
            "source": "partition-pvp-selector",
            "securityZonesEnabled": bool(security_zones_enabled),
            "warnings": warnings,
            "unresolvedFields": unresolved_fields,
        }

    if partition_pve is True:
        return {
            "state": "PVE",
            "source": "partition-pve-selector",
            "securityZonesEnabled": bool(security_zones_enabled),
            "warnings": warnings,
            "unresolvedFields": unresolved_fields,
        }

    if selector_mode_active is True:
        return {
            "state": "PVE",
            "source": "partition-selector-default",
            "securityZonesEnabled": bool(security_zones_enabled),
            "warnings": warnings,
            "unresolvedFields": unresolved_fields,
        }

    if legacy_pvp is True and server_pve is False:
        return {
            "state": "PVP",
            "source": "legacy-flags",
            "securityZonesEnabled": bool(security_zones_enabled),
            "warnings": warnings,
            "unresolvedFields": unresolved_fields,
        }

    if legacy_pvp is False and server_pve is True:
        return {
            "state": "PVE",
            "source": "legacy-flags",
            "securityZonesEnabled": bool(security_zones_enabled),
            "warnings": warnings,
            "unresolvedFields": unresolved_fields,
        }

    return {
        "state": "UNKNOWN",
        "source": "unresolved",
        "securityZonesEnabled": bool(security_zones_enabled),
        "warnings": warnings,
        "unresolvedFields": unresolved_fields,
    }


def combat_settings_for_publication(values: dict, string_values: bool = False) -> dict:
    """Return only combat fields supported by the Funcom state payload.

    Partition selector membership is intentionally not folded into
    shouldForceEnablePvpOnAllPartitions: that field describes the global
    force-all switch, not whether this particular partition resolved to PvP.
    The resolved state is returned alongside the supported settings for UI,
    diagnostics, and tests that need the full distinction.
    """
    resolved = resolve_partition_combat_state(values)

    def output_bool(value: bool):
        if string_values:
            return "True" if value else "False"
        return value

    settings = {
        "areSecurityZonesEnabled": output_bool(resolved["securityZonesEnabled"]),
    }
    if resolved["state"] in ("PVP", "PVE"):
        settings["shouldForceEnablePvpOnAllPartitions"] = output_bool(
            resolved["source"] == "force-pvp-all-partitions"
        )
    return {"resolved": resolved, "settings": settings}


def aggregate_map_combat_state(partition_states: list) -> str:
    """Aggregate independently-resolved partition states into a map state.

      every partition PVP                -> PVP
      every partition PVE                 -> PVE
      at least one PVP and one PVE        -> MIXED
      any partition CONFLICT              -> CONFLICT
      no configured/determinable states   -> UNKNOWN

    UNKNOWN partitions are excluded from the PVP/PVE/MIXED vote (they are
    "undeterminable", not a vote for either side) but do not by themselves
    force the map to UNKNOWN unless every partition is UNKNOWN.
    """
    if not partition_states:
        return "UNKNOWN"
    if any(state == "CONFLICT" for state in partition_states):
        return "CONFLICT"
    determinable = {state for state in partition_states if state in ("PVP", "PVE")}
    if not determinable:
        return "UNKNOWN"
    if determinable == {"PVP"}:
        return "PVP"
    if determinable == {"PVE"}:
        return "PVE"
    return "MIXED"


def materialized_partition_combat_values(map_name: str, partition_id: str) -> dict | None:
    """Read the effective combat-relevant fields from the live/materialized
    UserGame.ini for a partition, if that runtime file exists. Returns None
    when no materialized file is present (e.g. the partition has never been
    started), which callers must not treat as UNKNOWN/false — it simply
    means there is nothing materialized to compare against yet.
    """
    target_map = canonical_map(map_name)
    path = live_usergame_path(target_map, str(partition_id))
    if not path.exists():
        return None

    pvp_pve_section = "/Script/DuneSandbox.PvpPveSettings"
    game_mode_section = "/Script/DuneSandbox.DuneGameMode"
    security_zones_section = "/Script/DuneSandbox.SecurityZonesSubsystem"

    force_all = read_ini_value(path, pvp_pve_section, "m_bShouldForceEnablePvpOnAllPartitions")
    partition_pvp = read_ini_array_contains(path, pvp_pve_section, "m_PvpEnabledPartitions", str(partition_id))
    partition_pve = read_ini_array_contains(path, pvp_pve_section, "m_PveEnabledPartitions", str(partition_id))
    selector_mode_active = read_ini_array_key_present(
        path, pvp_pve_section, {"m_PvpEnabledPartitions", "m_PveEnabledPartitions"}
    )
    legacy_pvp = read_ini_value(path, game_mode_section, "bPvPEnabled")
    server_pve = read_ini_value(path, game_mode_section, "bServerPVE")
    security_zones = read_ini_value(path, security_zones_section, "m_bAreSecurityZonesEnabled")

    return {
        "force_pvp_all_partitions": force_all if force_all is not None else "False",
        "partition_selector_mode_active": "True" if selector_mode_active else "False",
        "partition_pvp_enabled": "True" if partition_pvp else "False",
        "partition_pve_enabled": "True" if partition_pve else "False",
        "legacy_pvp_enabled": legacy_pvp if legacy_pvp is not None else "False",
        "server_pve": server_pve if server_pve is not None else "True",
        "security_zones_enabled": security_zones if security_zones is not None else "True",
    }


def partition_combat_state_payload(map_name: str, partition_id: str, profile: dict | None = None) -> dict:
    """Build one structured combat-state result without reloading config."""
    target_map = canonical_map(map_name)
    target_partition = str(partition_id)

    configured_values = profile_partition_values(profile if profile is not None else read_profile(), target_map, target_partition)
    configured_result = resolve_partition_combat_state(configured_values)

    materialized_values = materialized_partition_combat_values(target_map, target_partition)
    materialized_result = resolve_partition_combat_state(materialized_values) if materialized_values is not None else None

    configuration_drift = materialized_values is not None and any(
        bool_or_none(materialized_values.get(field)) != bool_or_none(configured_values.get(field))
        for field in COMBAT_STATE_FIELDS
    )

    return {
        "map": target_map,
        "partitionId": target_partition,
        "configuredState": configured_result["state"],
        "configuredSource": configured_result["source"],
        "materializedState": materialized_result["state"] if materialized_result else None,
        "materializedSource": materialized_result["source"] if materialized_result else None,
        "securityZonesEnabled": configured_result["securityZonesEnabled"],
        "restartRequired": configuration_drift,
        "configurationDrift": configuration_drift,
        "warnings": configured_result["warnings"],
        "unresolvedFields": configured_result["unresolvedFields"],
    }


def partition_combat_state_command(map_name: str, partition_id: str) -> int:
    """Print a structured combat-state result for one partition."""
    payload = partition_combat_state_payload(map_name, partition_id, read_profile())
    print(json.dumps(payload, separators=(",", ":")))
    return 0


def partition_combat_states_command(map_name: str, partition_ids: list[str]) -> int:
    """Resolve several partitions in one process and one profile read path."""
    profile = read_profile()
    target_map = canonical_map(map_name)
    partitions = [
        partition_combat_state_payload(target_map, partition_id, profile)
        for partition_id in partition_ids
    ]
    payload = {
        "map": target_map,
        "mapState": aggregate_map_combat_state(
            [partition["configuredState"] for partition in partitions]
        ),
        "partitions": partitions,
    }
    print(json.dumps(payload, separators=(",", ":")))
    return 0


def partition_engine_values_many_command(map_name: str, partition_ids: list[str]) -> int:
    """Resolve effective per-partition engine values (e.g. server_display_name) for
    several partitions in one process and one profile read path."""
    profile = read_profile()
    target_map = canonical_map(map_name)
    result = {
        str(partition_id): profile_partition_engine_values(profile, target_map, partition_id)
        for partition_id in partition_ids
    }
    print(json.dumps(result, separators=(",", ":")))
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        return 2

    secure_managed_settings_permissions()
    command = argv[1]
    config = load_config()

    if command == "metadata":
        return metadata()
    if command == "profile-raw":
        sys.stdout.write(read_profile_text())
        return 0
    if command == "profile-write-b64" and len(argv) == 3:
        return profile_write_encoded(argv[2])
    if command == "profile-game-raw":
        sys.stdout.write(profile_game_text())
        return 0
    if command == "client-game-ini" and len(argv) == 2:
        sys.stdout.write(client_game_ini(read_profile(), ""))
        return 0
    if command == "client-game-ini" and len(argv) == 3:
        sys.stdout.write(client_game_ini(read_profile(), argv[2]))
        return 0
    if command == "client-game-ini" and len(argv) == 4:
        sys.stdout.write(client_game_ini(read_profile(), argv[2], argv[3]))
        return 0
    if command == "client-engine-ini" and len(argv) == 2:
        sys.stdout.write(client_engine_ini(read_profile()))
        return 0
    if command == "client-engine-ini" and len(argv) == 3:
        sys.stdout.write(client_engine_ini(read_profile(), argv[2]))
        return 0
    if command == "client-engine-ini" and len(argv) == 4:
        sys.stdout.write(client_engine_ini(read_profile(), argv[2], argv[3]))
        return 0
    if command == "profile-game-write-b64" and len(argv) == 3:
        return profile_game_write_encoded(argv[2])
    if command == "profile-engine-raw":
        sys.stdout.write(profile_engine_text())
        return 0
    if command == "profile-engine-write-b64" and len(argv) == 3:
        return profile_engine_write_encoded(argv[2])
    if command == "profile-selftest":
        return profile_selftest()
    if command == "preflight":
        return preflight_persisted_settings()
    if command == "engine-values":
        return print_rows(merged_engine_values(config), ENGINE_FIELDS)
    if command == "map-engine-values" and len(argv) == 3:
        return print_rows(merged_map_engine_values(config, canonical_map(argv[2])), MAP_ENGINE_FIELDS)
    if command == "global-values":
        return print_usergame_rows(merged_global_values(config), MAP_FIELDS)
    if command == "map-values" and len(argv) == 3:
        return print_usergame_rows(merged_map_values(config, canonical_map(argv[2])), MAP_FIELDS)
    if command == "partition-values" and len(argv) == 4:
        return print_usergame_rows(merged_partition_values(config, canonical_map(argv[2]), argv[3]), PARTITION_FIELDS)
    if command == "partition-combat-state" and len(argv) == 4:
        return partition_combat_state_command(argv[2], argv[3])
    if command == "partition-combat-states" and len(argv) >= 4:
        return partition_combat_states_command(argv[2], argv[3:])
    if command == "partition-engine-values" and len(argv) == 4:
        return print_rows(merged_partition_engine_values(config, canonical_map(argv[2]), argv[3]), PARTITION_ENGINE_FIELDS)
    if command == "partition-engine-values-many" and len(argv) >= 4:
        return partition_engine_values_many_command(argv[2], argv[3:])
    if command == "engine-set" and len(argv) == 4:
        return set_field("engine", None, argv[2], argv[3])
    if command == "map-set" and len(argv) == 5:
        return set_field("map", argv[2], argv[3], argv[4])
    if command == "map-unset" and len(argv) == 4:
        return unset_map_field(argv[2], argv[3])
    if command == "dual-deepdesert-matchmaker" and len(argv) == 3 and argv[2] in {"enable", "disable"}:
        return set_dual_deepdesert_matchmaker(argv[2] == "enable")
    if command == "partition-set" and len(argv) == 6:
        return set_partition_field(argv[2], argv[3], argv[4], argv[5])
    if command == "partition-engine-set" and len(argv) == 6:
        return set_partition_engine_field(argv[2], argv[3], argv[4], argv[5])
    if command == "reset-all":
        return reset_all()
    if command == "reset-engine-gameplay":
        return reset_engine_gameplay()
    if command == "reset-map-engine" and len(argv) == 3:
        return reset_scoped_engine(argv[2])
    if command == "reset-partition-engine" and len(argv) == 4:
        return reset_scoped_engine(argv[2], argv[3])
    if command == "reset-global-game":
        return reset_global_game()
    if command == "reset-game" and len(argv) == 3:
        return reset_game(argv[2])
    if command == "reset-game" and len(argv) == 4:
        return reset_game(argv[2], argv[3])
    if command == "raw-engine" and len(argv) == 2:
        return read_raw("engine")
    if command == "raw-game" and len(argv) == 3:
        return read_raw("game", argv[2])
    if command == "raw-game" and len(argv) == 4:
        return read_raw("game", argv[2], argv[3])
    if command == "raw-engine-write":
        return write_raw("engine", sys.stdin.read())
    if command == "raw-game-write" and len(argv) == 3:
        return write_raw("game", sys.stdin.read(), argv[2])
    if command == "raw-game-write" and len(argv) == 4:
        return write_raw("game", sys.stdin.read(), argv[2], argv[3])
    if command == "raw-engine-write-b64" and len(argv) == 3:
        return raw_write_encoded("engine", argv[2])
    if command == "raw-game-write-b64" and len(argv) == 4:
        return raw_write_encoded("game", argv[3], argv[2])
    if command == "raw-game-write-b64" and len(argv) == 5:
        return raw_write_encoded("game", argv[4], argv[2], argv[3])
    if command == "bulk-save" and len(argv) == 6:
        return bulk_save(argv[2], argv[3], argv[4], argv[5])
    if command == "migrate-coriolis-region-fields" and len(argv) == 3:
        print(migrate_coriolis_region_fields(argv[2]))
        return 0
    if command == "materialize-current":
        return materialize_current_runtime_files()
    if command == "materialize" and len(argv) == 4:
        return materialize(argv[2], argv[3])
    if command == "materialize" and len(argv) == 5:
        return materialize(argv[2], argv[3], argv[4])

    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
