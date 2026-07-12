#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import sys
from base64 import b64decode
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = Path(os.environ.get("DUNE_USERSETTINGS_CONFIG", str(ROOT / "runtime" / "generated" / "usersettings.json")))
PROFILE_PATH = Path(os.environ.get("DUNE_GAMEPLAY_PROFILE", str(ROOT / "runtime" / "generated" / "gameplay-profile.ini")))
SIETCH_CONFIG_PATH = ROOT / "runtime" / "generated" / "sietch-config.json"

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
    "coriolis_cycle_duration_days": ("/Script/DuneSandbox.CoriolisSubsystem", "m_CycleDurationInDays", "7"),
    "forced_coriolis_world_seed": ("/Script/DuneSandbox.CoriolisSubsystem", "m_ForcedCoriolisWorldSeed", "-1"),
    "restart_server_on_coriolis_cycle_end": ("/Script/DuneSandbox.CoriolisSubsystem", "m_bShouldRestartServerOnCycleEnd", "True"),
    "coriolis_db_wipe_enabled": ("/Script/DuneSandbox.CoriolisSubsystem", "m_bIsDbWipeEnabled", "True"),
    "max_landclaim_segments": ("/Script/DuneSandbox.BuildingSettings", "m_MaxNumLandclaimSegments", "6"),
    "building_blueprint_max_extensions": ("/Script/DuneSandbox.BuildingSettings", "m_BuildingBlueprintMaxExtensions", "4"),
    "base_backup_max_extensions": ("/Script/DuneSandbox.BuildingSettings", "m_BaseBackupMaxExtensions", "8"),
    "base_backup_tool_time_restriction_seconds": ("/Script/DuneSandbox.BuildingSettings", "m_BaseBackupToolTimeRestrictionInSeconds", "60"),
    "building_restriction_limits_enabled": ("/Script/DuneSandbox.BuildingSettings", "m_bBuildingRestrictionLimitsEnabled", "True"),
    "mitigate_all_sandstorm_damage": ("/Script/DuneSandbox.BuildingSettings", "m_bMitigateAllSandstormDamage", "False"),
    "fallback_default_building_health": ("/Script/DuneSandbox.BuildingSettings", "m_FallbackDefaultBuildingHealth", "2500.000000"),
    "fallback_default_placeable_health": ("/Script/DuneSandbox.BuildingSettings", "m_FallbackDefaultPlaceableHealth", "400.000000"),
    "pickup_total_durability_reduction": ("/Script/DuneSandbox.BuildingSettings", "m_PickupTotalDurabilityPercentageReduction", "0.050000"),
    "building_stabilization_system_enabled": ("/Script/DuneSandbox.BuildingSettings", "m_bEnableStabilizationSystem", "True"),
    "building_destabilization_system_enabled": ("/Script/DuneSandbox.BuildingSettings", "m_bEnableDestabilizationSystem", "False"),
    "building_destruction_effects_enabled": ("/Script/DuneSandbox.BuildingSettings", "m_bEnableBuildingDestructionEffects", "True"),
    "building_height_limit_m": ("/Script/DuneSandbox.BuildingSettings", "m_BuildingHeightLimitInM", "980.000000"),
    "building_blueprint_range_multiplier": ("/Script/DuneSandbox.BuildingSettings", "m_BuildingBlueprintRangeMultiplier", "0.660000"),
    "build_range": ("/Script/DuneSandbox.BuildingSettings", "m_BuildRange", "2000.000000"),
    "building_near_server_borders_enabled": ("/Script/DuneSandbox.BuildingSettings", "m_bEnableBuildingNearServerBorders", "False"),
    "min_buildable_distance_from_server_border": ("/Script/DuneSandbox.BuildingSettings", "m_bMinBuildableDistanceFromServerBorder", "1000.000000"),
    "can_remove_buildables_with_no_owner": ("/Script/DuneSandbox.BuildingSettings", "m_bCanRemoveBuildablesWithNoOwner", "True"),
    "door_auto_close_time": ("/Script/DuneSandbox.BuildingSettings", "m_TimeToAutomaticallyCloseDoor", "10"),
    "default_building_system_modifiers": ("/Script/DuneSandbox.BuildingSettings", "m_DefaultBuildingSystemModifiers", "(m_RefundPercentage=1.000000,m_PlacementCostMultiplier=1.000000)"),
    "default_repair_cost_multiplier": ("/Script/DuneSandbox.BuildingSettings", "m_DefaultRepairCostMultiplier", "0.500000"),
    "broken_vehicle_module_armor_deduction": ("/Script/DuneSandbox.DuneSandboxGameModeBase", "m_BrokenVehicleModuleArmorDeduction", "2"),
    "players_drop_loot_on_death": ("/Script/DuneSandbox.DuneSandboxGameModeBase", "m_bShouldPlayersDropLootOnDeath", "False"),
    "players_drop_loot_on_defeat": ("/Script/DuneSandbox.DuneSandboxGameModeBase", "m_bShouldPlayersDropLootOnDefeat", "True"),
    "players_lose_items_on_death": ("/Script/DuneSandbox.DuneSandboxGameModeBase", "m_bShouldPlayersLoseItemsOnDeath", "True"),
    "npcs_drop_loot_on_death": ("/Script/DuneSandbox.DuneSandboxGameModeBase", "m_bShouldNpcDropLootOnDeath", "True"),
    "drop_amount_on_defeat": ("/Script/DuneSandbox.DuneSandboxGameModeBase", "m_DropAmountOnDefeat", "0.4"),
    "armor_mitigation_constant": ("/Script/DuneSandbox.DuneGameState", "m_ArmorMitigationConstant", "500"),
    "global_xp_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_GlobalXPMultiplier", "1.0"),
    "global_fame_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_GlobalFameMultiplier", "1.0"),
    "global_progression_speed_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_GlobalProgressionSpeedMultiplier", "1.0"),
    "guild_creation_cost": ("/Script/DuneSandbox.DuneGameMode", "m_GuildCreationCost", "1000"),
    "sell_order_price_percentage_fee": ("/Script/DuneSandbox.DuneGameMode", "SellOrderPricePercentageFee", "2.0"),
    "spice_tax_amount": ("/Script/DuneSandbox.DuneGameMode", "SpiceTaxAmount", "0.1"),
    "spice_tax_interval": ("/Script/DuneSandbox.DuneGameMode", "SpiceTaxInterval", "3600"),
    "global_harvest_amount_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_GlobalHarvestAmountMultiplier", "1.0"),
    "global_harvest_health_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_GlobalHarvestHealthMultiplier", "1.0"),
    "cutteray_hem_multiplier_per_node_tier_table": ("/Script/DuneSandbox.DuneGameMode", "CutterayHemMultiplierPerNodeTierTable", "1.0"),
    "minimum_augmentable_item_quality": ("/Script/DuneSandbox.DuneGameMode", "m_MinimumAugmentableItemQuality", "0"),
    "item_durability_loss_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_ItemDurabilityLossMultiplier", "1.0"),
    "legacy_pvp_enabled": ("/Script/DuneSandbox.DuneGameMode", "bPvPEnabled", "False"),
    "server_pve": ("/Script/DuneSandbox.DuneGameMode", "bServerPVE", "True"),
    "water_consumption_rate": ("/Script/DuneSandbox.DuneGameMode", "m_WaterConsumptionRate", "1.0"),
    "water_consumption_in_storm_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_WaterConsumptionInStormMultiplier", "4.0"),
    "global_damage_to_npcs_multiplier": ("/Script/DuneSandbox.DuneGameMode", "m_GlobalDamageToNpcsMultiplier", "1.0"),
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

PARTITION_FIELDS = {
    "partition_pvp_enabled": (None, None, "False"),
    "partition_pve_enabled": (None, None, "False"),
    **MAP_FIELDS,
}

PARTITION_ENGINE_FIELDS = {
    "server_display_name": ENGINE_FIELDS["server_display_name"],
    "server_login_password": ENGINE_FIELDS["server_login_password"],
}

PROTECTED_ENGINE_FIELDS = {"server_display_name", "server_login_password"}
RESET_PRESERVED_ENGINE_FIELDS = {"port", "igw_port", "server_display_name", "server_login_password"}
PROFILE_HEADER_ORDER = {"Engine": 0, "Global": 1, "Map": 2, "Partition": 3}
LEGACY_GUILD_FIELD_ALIASES = {
    "guild_creation_cost": "guild_settings_creation_cost",
    "max_guilds_allowed": "guild_settings_max_guilds_allowed",
    "max_guild_members_allowed": "guild_settings_max_guild_members_allowed",
}


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


def atomic_write_text(path: Path, content: str, mode: int = 0o664) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.parent / f".{path.name}.tmp.{os.getpid()}"
    tmp_path.write_text(content, encoding="utf-8")
    try:
        tmp_path.chmod(mode)
    except OSError:
        pass
    tmp_path.replace(path)
    try:
        path.chmod(mode)
    except OSError:
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


def write_profile(profile: dict) -> None:
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
    if len(parts) >= 4 and parts[0] == "Partition":
        return {"scope": "Partition", "map": canonical_map(parts[1]), "partition": parts[2], "ini_section": ":".join(parts[3:])}
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
    if scope == "partition":
        return f"Partition:{canonical_map(map_name)}:{partition_id}:{section}"
    raise SystemExit(f"Unknown profile scope: {scope}")


def find_profile_section(profile: dict, scope: str, section: str, map_name: str = "", partition_id: str = "", create: bool = False) -> dict | None:
    target_scope = {"engine": "Engine", "global": "Global", "map": "Map", "partition": "Partition"}[scope]
    target_map = canonical_map(map_name) if map_name else ""
    target_partition = str(partition_id or "")
    for block in profile.get("sections", []):
        if block.get("scope") != target_scope or block.get("ini_section") != section:
            continue
        if target_scope == "Map" and block.get("map") != target_map:
            continue
        if target_scope == "Partition" and (block.get("map") != target_map or str(block.get("partition", "")) != target_partition):
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
    if left.startswith(("+", "-", ".")):
        prefix = left[0]
        left = left[1:]
    return prefix, left.strip(), right.strip()


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
        if prefix == "+":
            if current_prefix == "+" and current_value == value:
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


def profile_remove_key(profile: dict, scope: str, section: str, key: str, map_name: str = "", partition_id: str = "", prefixes: set[str] | None = None) -> None:
    block = find_profile_section(profile, scope, section, map_name, partition_id)
    if not block:
        return
    allowed_prefixes = prefixes
    out = []
    for raw in block.get("lines", []):
        parsed = split_ini_assignment(raw)
        if parsed:
            prefix, left, _ = parsed
            if left == key and (allowed_prefixes is None or prefix in allowed_prefixes):
                continue
        out.append(raw)
    block["lines"] = out


def mirror_legacy_guild_profile_field(profile: dict, scope: str, map_name: str, partition_id: str, field_id: str, value: str) -> None:
    canonical_field = LEGACY_GUILD_FIELD_ALIASES.get(field_id)
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


def sync_legacy_guild_values(values: dict[str, str]) -> dict[str, str]:
    for legacy_field, canonical_field in LEGACY_GUILD_FIELD_ALIASES.items():
        legacy_default = str(MAP_FIELDS[legacy_field][2])
        canonical_default = str(MAP_FIELDS[canonical_field][2])
        legacy_value = str(values.get(legacy_field, legacy_default))
        canonical_value = str(values.get(canonical_field, canonical_default))
        if legacy_value != legacy_default and canonical_value == canonical_default:
            values[canonical_field] = legacy_value
        elif canonical_value != canonical_default and legacy_value == legacy_default:
            values[legacy_field] = canonical_value
    return values


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
                set_profile_field(profile, "partition", map_name, str(partition_id), field_id, str(value))
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
    if scope == "engine":
        if field_id not in ENGINE_FIELDS:
            raise SystemExit(f"Unknown engine field: {field_id}")
        if field_id in PROTECTED_ENGINE_FIELDS:
            return
        spec = ENGINE_FIELDS[field_id]
        if spec[0] and spec[1]:
            profile_set_key(profile, "engine", spec[0], spec[1], value)
        return

    if scope == "global":
        if field_id not in MAP_FIELDS:
            raise SystemExit(f"Unknown global UserGame field: {field_id}")
        spec = MAP_FIELDS[field_id]
        if spec[0] and spec[1]:
            profile_set_key(profile, "global", spec[0], spec[1], value)
            mirror_legacy_guild_profile_field(profile, "global", "", "", field_id, value)
        return

    if scope == "map":
        if field_id not in MAP_FIELDS:
            raise SystemExit(f"Unknown map field: {field_id}")
        spec = MAP_FIELDS[field_id]
        if spec[0] and spec[1]:
            profile_set_key(profile, "map", spec[0], spec[1], value, map_name=map_name)
            mirror_legacy_guild_profile_field(profile, "map", map_name, "", field_id, value)
        return

    if scope == "partition":
        if field_id not in PARTITION_FIELDS and field_id not in PARTITION_ENGINE_FIELDS:
            raise SystemExit(f"Unknown partition field: {field_id}")
        target_map = canonical_map(map_name or "Survival_1")
        target_partition = str(partition_id or "").strip()
        if not target_partition:
            raise SystemExit("Partition save requires a partition id.")
        if field_id in PARTITION_ENGINE_FIELDS:
            spec = PARTITION_ENGINE_FIELDS[field_id]
            if spec[0] and spec[1]:
                if value == "":
                    profile_remove_key(profile, "partition", spec[0], spec[1], target_map, target_partition)
                else:
                    profile_set_key(profile, "partition", spec[0], spec[1], value, target_map, target_partition)
            return
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
            mirror_legacy_guild_profile_field(profile, "partition", target_map, target_partition, field_id, value)
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
    return sync_legacy_guild_values(values)


def profile_global_values(profile: dict) -> dict[str, str]:
    values = {key: spec[2] for key, spec in MAP_FIELDS.items()}
    for key, spec in MAP_FIELDS.items():
        section, ini_key, _ = spec
        if not section or not ini_key:
            continue
        global_value = profile_get_key(profile, "global", section, ini_key)
        if global_value is not None:
            values[key] = global_value
    return sync_legacy_guild_values(values)


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
    values["partition_pvp_enabled"] = "True" if profile_array_contains(
        profile, "partition", "/Script/DuneSandbox.PvpPveSettings", "m_PvpEnabledPartitions", target_partition, target_map, target_partition
    ) else values.get("partition_pvp_enabled", "False")
    values["partition_pve_enabled"] = "True" if profile_array_contains(
        profile, "partition", "/Script/DuneSandbox.PvpPveSettings", "m_PveEnabledPartitions", target_partition, target_map, target_partition
    ) else values.get("partition_pve_enabled", "False")
    return sync_legacy_guild_values(values)


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


def profile_partition_engine_values(profile: dict, map_name: str, partition_id: str) -> dict[str, str]:
    target_map = canonical_map(map_name)
    target_partition = str(partition_id)
    values = profile_engine_values(profile)
    for key, spec in PARTITION_ENGINE_FIELDS.items():
        section, ini_key, _ = spec
        if not section or not ini_key:
            continue
        partition_value = profile_get_key(profile, "partition", section, ini_key, target_map, target_partition)
        if partition_value is not None:
            values[key] = partition_value
    return values


def merged_partition_engine_values(config: dict, map_name: str, partition_id: str) -> dict[str, str]:
    return profile_partition_engine_values(read_profile(), map_name, partition_id)


def print_rows(rows: dict[str, str], order: dict[str, tuple[str | None, str | None, str]]) -> int:
    for key in order:
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
        return {
            "scope": scope,
            "id": field_id,
            "section": section or "",
            "key": key or "",
            "default": "" if default is None else str(default),
            "type": infer_field_type(default),
        }

    payload = {
        "engine": [row("engine", key, spec) for key, spec in ENGINE_FIELDS.items()],
        "game": [row("game", key, spec) for key, spec in MAP_FIELDS.items()],
        "partition": [row("partition", key, spec) for key, spec in PARTITION_FIELDS.items()],
        "partitionEngine": [row("partitionEngine", key, spec) for key, spec in PARTITION_ENGINE_FIELDS.items()],
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
        if field_id not in MAP_FIELDS:
            raise SystemExit(f"Unknown map field: {field_id}")
        map_name = canonical_map(name or "")
        target_scope = "global" if map_name in {"", "Global"} else "map"
        set_profile_field(profile, target_scope, map_name, "", field_id, value)
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
    set_profile_field(profile, "partition", map_name, str(partition_id), field_id, value)
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


def userengine_ini_text(values: dict[str, str]) -> str:
    lines = [
        "; UserEngine.ini managed by Docker.",
        "; Values here apply to all maps unless overridden by UserEngine.ini.",
        "",
        "; Settings in these config files will be applied to every server in the battlegroup",
        "; If you need to override different settings for different servers, use the battlegroup editor instead",
        "",
        "[URL]",
        "; The starting port that servers listen to for players. Each server",
        "; will use the next available port in a sequence (7777, 7778 etc.). The range should",
        "; not intersect with the IGWPort range bellow",
        f"Port={values.get('port', ENGINE_FIELDS['port'][2])}",
        "; The port that servers listen to for other servers. Each server",
        "; will use the next available port in a sequence (7888, 7889 etc.). The range should",
        "; not intersect with the Port range above",
        f"IGWPort={values.get('igw_port', ENGINE_FIELDS['igw_port'][2])}",
        "",
        "[ConsoleVariables]",
        "; Set the name of every Sietch in the battlegroup",
        "; If Sietches should have different names use the battlegroup editor instead",
        "; Special characters like ' and | are not allowed and double quotes should be used",
    ]

    display_name = values.get("server_display_name", "")
    if display_name:
        lines.append(f"Bgd.ServerDisplayName={quote_ini_string(display_name)}")
    else:
        lines.append(';Bgd.ServerDisplayName="My Arrakis, My Dune"')

    lines.extend([
        "",
        "; Set a password for every Sietch in the battlegroup",
        "; If Sietches should have different passwords use the battlegroup editor instead",
        "; Special characters like ' and | are not allowed and double quotes should be used",
    ])

    login_password = values.get("server_login_password", "")
    if login_password:
        lines.append(f"Bgd.ServerLoginPassword={quote_ini_string(login_password)}")
    else:
        lines.append(';Bgd.ServerLoginPassword="Sandworm"')

    lines.extend([
        "",
        "; Mining multipliers",
        f"Dune.GlobalMiningOutputMultiplier={values.get('mining_output_multiplier', ENGINE_FIELDS['mining_output_multiplier'][2])}",
        f"Dune.GlobalVehicleMiningOutputMultiplier={values.get('vehicle_mining_output_multiplier', ENGINE_FIELDS['vehicle_mining_output_multiplier'][2])}",
        f"SecurityZones.PvpResourceMultiplier={values.get('pvp_resource_multiplier', ENGINE_FIELDS['pvp_resource_multiplier'][2])}",
        "",
        "; Durability damage multiplier for vehicles | (0 to 10)  0=off",
        f"dw.VehicleDurabilityDamageMultiplier={values.get('vehicle_durability_damage_multiplier', ENGINE_FIELDS['vehicle_durability_damage_multiplier'][2])}",
        "",
        "; Sandstorm and sandstorm treasure spawning settings",
        f"Sandstorm.Enabled={values.get('sandstorm_enabled', ENGINE_FIELDS['sandstorm_enabled'][2])}",
        f"Sandstorm.Treasure.Enabled={values.get('sandstorm_treasure_enabled', ENGINE_FIELDS['sandstorm_treasure_enabled'][2])} ",
        "",
        "; Sandworm settings",
        f"sandworm.dune.Enabled={values.get('sandworm_enabled', ENGINE_FIELDS['sandworm_enabled'][2])}",
        "; Sandworm can push/damage vehicles",
        f"Vehicle.SandwormCollisionInteraction={values.get('sandworm_collision_interaction', ENGINE_FIELDS['sandworm_collision_interaction'][2])}",
        "; Enables dangerzones where the sandworm can attack",
        f"Sandworm.SandwormDangerZonesEnabled={values.get('sandworm_danger_zones_enabled', ENGINE_FIELDS['sandworm_danger_zones_enabled'][2])}",
        "; Seconds of invunerability from sandworm on specific situations",
        f"Vehicle.SandwormInvulnerabilitySecondsOnExit={values.get('sandworm_invulnerability_on_exit', ENGINE_FIELDS['sandworm_invulnerability_on_exit'][2])}",
        f"Vehicle.SandwormInvulnerabilitySecondsOnServerRestart={values.get('sandworm_invulnerability_on_restart', ENGINE_FIELDS['sandworm_invulnerability_on_restart'][2])}",
        "",
        "; Character, spice, travel, and AI gameplay toggles",
        f"Character.WeaponSpecificQuickMelee.Enabled={values.get('weapon_specific_quick_melee_enabled', ENGINE_FIELDS['weapon_specific_quick_melee_enabled'][2])}",
        f"SpiceAddiction.SpiceVisionsEnabled={values.get('spice_visions_enabled', ENGINE_FIELDS['spice_visions_enabled'][2])}",
        f"IgwTravel.AllowPassengerToUseTaxi={values.get('passenger_taxi_enabled', ENGINE_FIELDS['passenger_taxi_enabled'][2])}",
        f"Ai.BloodDoors.Enabled={values.get('blood_doors_enabled', ENGINE_FIELDS['blood_doors_enabled'][2])}",
        f"Ai.BloodDoors.DisableBlightEcolab={values.get('blood_doors_disable_blight_ecolab', ENGINE_FIELDS['blood_doors_disable_blight_ecolab'][2])}",
    ])
    return "\n".join(lines) + "\n"


def write_userengine_ini(path: Path, values: dict[str, str]) -> None:
    atomic_write_text(path, userengine_ini_text(values))


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


def known_keys_by_section(fields: dict[str, tuple[str | None, str | None, str | None]]) -> dict[str, set[str]]:
    known: dict[str, set[str]] = {}
    for section, key, _ in fields.values():
        if section and key:
            known.setdefault(section, set()).add(key)
    return known


def append_profile_unknown_lines(target: dict[str, list[str]], profile: dict, scopes: list[tuple[str, str, str]], known: dict[str, set[str]]) -> None:
    for scope, map_name, partition_id in scopes:
        for block in profile.get("sections", []):
            if block.get("scope") != {"engine": "Engine", "global": "Global", "map": "Map", "partition": "Partition"}[scope]:
                continue
            if scope == "map" and block.get("map") != canonical_map(map_name):
                continue
            if scope == "partition" and (block.get("map") != canonical_map(map_name) or str(block.get("partition", "")) != str(partition_id)):
                continue
            section = str(block.get("ini_section", ""))
            for raw in block.get("lines", []):
                parsed = split_ini_assignment(raw)
                if parsed:
                    prefix, left, _ = parsed
                    if not prefix and left in known.get(section, set()):
                        continue
                    if prefix == "+" and section == "/Script/DuneSandbox.PvpPveSettings" and left in {"m_PvpEnabledPartitions", "m_PveEnabledPartitions"}:
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


def compiled_userengine_ini(profile: dict, map_name: str = "", partition_id: str | None = None) -> str:
    values = profile_partition_engine_values(profile, map_name, str(partition_id)) if map_name and partition_id else profile_engine_values(profile)
    section_lines: dict[str, list[str]] = {}
    for field_id, spec in ENGINE_FIELDS.items():
        section, key, default = spec
        if not section or not key:
            continue
        value = values.get(field_id, "" if default is None else str(default))
        if value == "" and default is None:
            continue
        if field_id in {"server_display_name", "server_login_password"} and value:
            value = quote_ini_string(value)
        section_lines.setdefault(section, []).append(f"{key}={value}")
    append_profile_unknown_lines(section_lines, profile, [("engine", "", "")], known_keys_by_section(ENGINE_FIELDS))
    return render_ini_sections(section_lines, [
        "; UserEngine.ini managed by Docker.",
        "; Values here apply to all maps unless overridden by UserEngine.ini.",
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
        section_lines.setdefault(section, []).append(f"{key}={values.get(field_id, default)}")
        if section == "/Script/DuneSandbox.PvpPveSettings" and key == "m_bShouldForceEnablePvpOnAllPartitions" and target_partition:
            if truthy(values.get("partition_pvp_enabled", "False")):
                section_lines[section].append(f"+m_PvpEnabledPartitions={target_partition}")
            if truthy(values.get("partition_pve_enabled", "False")):
                section_lines[section].append(f"+m_PveEnabledPartitions={target_partition}")
    scopes = [("global", "", ""), ("map", target_map, "")]
    if target_partition:
        scopes.append(("partition", target_map, target_partition))
    known = known_keys_by_section(MAP_FIELDS)
    known.setdefault("/Script/DuneSandbox.PvpPveSettings", set()).update({"m_PvpEnabledPartitions", "m_PveEnabledPartitions"})
    append_profile_unknown_lines(section_lines, profile, scopes, known)
    return render_ini_sections(section_lines, [
        "; UserGame.ini managed by Docker.",
        "; Edit this single file for all map and partition UserGame settings.",
        "; Docker applies the correct values to each server when maps start or restart.",
    ])


def client_game_ini(profile: dict, map_name: str, partition_id: str | None = None) -> str:
    target_map = canonical_map(map_name) if str(map_name or "").strip() else ""
    target_partition = str(partition_id or "")
    section_lines: dict[str, list[str]] = {}
    replace_indexes: dict[tuple[str, str, str], int] = {}

    def block_applies(block: dict) -> bool:
        scope = block.get("scope")
        if scope == "Global":
            return True
        if scope == "Map":
            return bool(target_map) and block.get("map") == target_map
        if scope == "Partition":
            return bool(target_map and target_partition) and block.get("map") == target_map and str(block.get("partition", "")) == target_partition
        return False

    for block in sorted_profile_sections(profile.get("sections", [])):
        if not block_applies(block):
            continue
        section = str(block.get("ini_section", ""))
        if not section:
            continue
        entries = section_lines.setdefault(section, [])
        for raw in block.get("lines", []):
            parsed = split_ini_assignment(raw)
            if not parsed:
                entries.append(raw)
                continue
            prefix, key, _ = parsed
            if key.startswith("Bgd."):
                continue
            if prefix:
                entries.append(raw)
                continue
            replacement_key = (section, prefix, key)
            previous_index = replace_indexes.get(replacement_key)
            if previous_index is None:
                replace_indexes[replacement_key] = len(entries)
                entries.append(raw)
            else:
                entries[previous_index] = raw

    target_label = "global UserGame" if not target_map else target_map if not target_partition else f"{target_map} partition {target_partition}"
    return render_ini_sections(section_lines, [
        "; Game.ini for the Dune: Awakening client.",
        f"; Generated from Docker UserGame.ini values for {target_label}.",
        "; Copy these sections into Saved/Config/WindowsClient/Game.ini while the game is closed.",
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
    for field_id, value in values.items():
        if not isinstance(field_id, str):
            raise SystemExit("Settings field names must be strings.")
        serialized = str(value)
        if "\x00" in serialized:
            raise SystemExit(f"{field_id} contains an invalid NUL character.")
        if scope == "engine":
            set_profile_field(profile, "engine", "", "", field_id, serialized)
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
    game_profile = {
        "preamble": [
            "; UserGame.ini managed by Docker.",
            "; Edit this single file for all map and partition UserGame settings.",
            "; Docker applies the correct values to each server when maps start or restart.",
        ],
        "sections": [block for block in profile.get("sections", []) if block.get("scope") != "Engine"],
    }
    return serialize_profile(game_profile)


def profile_engine_text() -> str:
    return userengine_ini_text(profile_engine_values(read_profile()))


def profile_game_write_encoded(encoded_content: str) -> int:
    try:
        content = b64decode(encoded_content.encode("ascii")).decode("utf-8")
    except ValueError as exc:
        raise SystemExit("Invalid UserGame profile payload.") from exc
    incoming = parse_profile_text(content)
    if any(block.get("scope") == "Engine" for block in incoming.get("sections", [])):
        raise SystemExit("UserGame.ini cannot contain Engine scoped sections.")
    for block in incoming.get("sections", []):
        if block.get("scope") == "Raw":
            section = str(block.get("ini_section", ""))
            block.update({
                "header": profile_header("global", section),
                "scope": "Global",
                "map": "",
                "partition": "",
                "ini_section": section,
            })
    profile = read_profile()
    profile["preamble"] = incoming.get("preamble", [])
    profile["sections"] = [block for block in profile.get("sections", []) if block.get("scope") == "Engine"] + incoming.get("sections", [])
    write_profile(profile)
    return 0


def profile_engine_write_encoded(encoded_content: str) -> int:
    try:
        content = b64decode(encoded_content.encode("ascii")).decode("utf-8")
    except ValueError as exc:
        raise SystemExit("Invalid UserEngine payload.") from exc
    parsed = parse_profile_text(content)
    engine_sections = []
    for block in parsed.get("sections", []):
        scope = block.get("scope")
        if scope != "Raw":
            if scope != "Engine":
                raise SystemExit("UserEngine.ini can only contain normal UserEngine or Engine scoped sections.")
            engine_sections.append(block)
            continue
        section = str(block.get("ini_section", ""))
        engine_sections.append({
            "header": profile_header("engine", section),
            "scope": "Engine",
            "map": "",
            "partition": "",
            "ini_section": section,
            "lines": block.get("lines", []),
        })
    profile = read_profile()
    incoming = {"preamble": [], "sections": engine_sections}
    validate_profile_port_ranges(incoming)
    profile["sections"] = [block for block in profile.get("sections", []) if block.get("scope") != "Engine"] + incoming.get("sections", [])
    write_profile(profile)
    return 0


def profile_selftest() -> int:
    text = """; keep me
[Global:/Script/DuneSandbox.DuneGameMode]
m_GlobalXPMultiplier=1.0
m_MaxGuildMembersAllowed=5
UnknownGlobal=abc

[Map:Survival_1:/Script/DuneSandbox.DuneGameMode]
m_GlobalXPMultiplier=2.0

[Partition:Survival_1:3:/Script/DuneSandbox.PvpPveSettings]
+m_PvpEnabledPartitions=3
CustomPartitionKey=True

[Engine:ConsoleVariables]
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
    if profile_map_values(reparsed, "Survival_1")["global_xp_multiplier"] != "2.0":
        raise SystemExit("Map override did not win over global profile value.")
    compiled_game = compiled_usergame_ini(reparsed, "Survival_1", "3")
    compiled_engine = compiled_userengine_ini(reparsed)
    if "[Global:" in compiled_game or "[Map:" in compiled_game or "[Partition:" in compiled_game or "[Engine:" in compiled_engine:
        raise SystemExit("Compiled runtime INI contains scoped profile headers.")
    if "+m_PvpEnabledPartitions=3" not in compiled_game:
        raise SystemExit("Partition PvP array line was not compiled.")
    if "[/Script/DuneSandbox.GuildSettings]" not in compiled_game or "m_MaxGuildMembersAllowed=5" not in compiled_game:
        raise SystemExit("Legacy guild member limit was not mirrored to GuildSettings.")
    if "UnknownGlobal=abc" not in compiled_game or "CustomPartitionKey=True" not in compiled_game:
        raise SystemExit("Compiled UserGame dropped unknown profile lines.")
    if "UnknownEngine=xyz" not in compiled_engine:
        raise SystemExit("Compiled UserEngine dropped unknown profile lines.")
    client_game = client_game_ini(reparsed, "Survival_1", "3")
    if "[Global:" in client_game or "[Map:" in client_game or "[Partition:" in client_game:
        raise SystemExit("Client Game.ini export contains scoped Docker profile headers.")
    if "m_GlobalXPMultiplier=2.0" not in client_game or "UnknownGlobal=abc" not in client_game or "CustomPartitionKey=True" not in client_game:
        raise SystemExit("Client Game.ini export dropped applicable saved UserGame values.")
    if "m_MaxNumLandclaimSegments=" in client_game:
        raise SystemExit("Client Game.ini export included unsaved UserGame defaults.")
    profile_set_key(reparsed, "global", "ConsoleVariables", "Bgd.ServerDisplayName", quote_ini_string("Do Not Export"))
    profile_set_key(reparsed, "global", "ConsoleVariables", "Bgd.ServerLoginPassword", quote_ini_string("Do Not Export"))
    bgd_filtered_client_game = client_game_ini(reparsed, "Survival_1", "3")
    if "Bgd.ServerDisplayName=" in bgd_filtered_client_game or "Bgd.ServerLoginPassword=" in bgd_filtered_client_game:
        raise SystemExit("Client Game.ini export included BGD identity values.")
    if profile_engine_values(reparsed)["vehicle_mining_output_multiplier"] != "10":
        raise SystemExit("Plain UserEngine raw section did not feed interactive engine values.")
    profile_set_key(reparsed, "global", "/Script/DuneSandbox.DuneGameMode", "m_GlobalFameMultiplier", "3.0")
    if "UnknownGlobal=abc" not in serialize_profile(reparsed):
        raise SystemExit("Interactive profile update dropped unknown keys.")
    profile_set_key(reparsed, "global", "/Script/DuneSandbox.BuildingSettings", "m_BaseBackupToolTimeRestrictionInSeconds", "60")
    if profile_map_values(reparsed, "Survival_1")["base_backup_tool_time_restriction_seconds"] != "60":
        raise SystemExit("Base backup tool time restriction did not feed interactive map values.")
    if "m_BaseBackupToolTimeRestrictionInSeconds=60" not in compiled_usergame_ini(reparsed, "Survival_1", "3"):
        raise SystemExit("Base backup tool time restriction did not compile from interactive profile update.")
    if infer_runtime_target(Path("/tmp/runtime/game/survival-1-34/Saved")) != ("Survival_1", "34"):
        raise SystemExit("Dynamic Survival runtime folder was not inferred.")
    if infer_runtime_target(Path("/tmp/runtime/game/deepdesert-1-58/Saved")) != ("DeepDesert_1", "58"):
        raise SystemExit("Dynamic Deep Desert runtime folder was not inferred.")
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
        for key in PARTITION_ENGINE_FIELDS:
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


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        return 2

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
    if command == "profile-game-write-b64" and len(argv) == 3:
        return profile_game_write_encoded(argv[2])
    if command == "profile-engine-raw":
        sys.stdout.write(profile_engine_text())
        return 0
    if command == "profile-engine-write-b64" and len(argv) == 3:
        return profile_engine_write_encoded(argv[2])
    if command == "profile-selftest":
        return profile_selftest()
    if command == "engine-values":
        return print_rows(merged_engine_values(config), ENGINE_FIELDS)
    if command == "global-values":
        return print_rows(merged_global_values(config), MAP_FIELDS)
    if command == "map-values" and len(argv) == 3:
        return print_rows(merged_map_values(config, canonical_map(argv[2])), MAP_FIELDS)
    if command == "partition-values" and len(argv) == 4:
        return print_rows(merged_partition_values(config, canonical_map(argv[2]), argv[3]), PARTITION_FIELDS)
    if command == "partition-engine-values" and len(argv) == 4:
        return print_rows(merged_partition_engine_values(config, canonical_map(argv[2]), argv[3]), PARTITION_ENGINE_FIELDS)
    if command == "engine-set" and len(argv) == 4:
        return set_field("engine", None, argv[2], argv[3])
    if command == "map-set" and len(argv) == 5:
        return set_field("map", argv[2], argv[3], argv[4])
    if command == "partition-set" and len(argv) == 6:
        return set_partition_field(argv[2], argv[3], argv[4], argv[5])
    if command == "partition-engine-set" and len(argv) == 6:
        return set_partition_engine_field(argv[2], argv[3], argv[4], argv[5])
    if command == "reset-all":
        return reset_all()
    if command == "reset-engine-gameplay":
        return reset_engine_gameplay()
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
    if command == "materialize-current":
        return materialize_current_runtime_files()
    if command == "materialize" and len(argv) == 4:
        return materialize(argv[2], argv[3])
    if command == "materialize" and len(argv) == 5:
        return materialize(argv[2], argv[3], argv[4])

    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
