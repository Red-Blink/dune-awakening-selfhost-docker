import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as duneDb from "../duneDb.js";

const DEFAULT_BASE_URL = "https://dunedocker.app/api/v1/servers";
const DEFAULT_HEARTBEAT_SECONDS = 30;
const MAX_BACKOFF_SECONDS = 15 * 60;
const REQUEST_TIMEOUT_MS = 10000;
const BATTLEGROUP_CORE_CONTAINERS = new Set([
  "dune-director",
  "dune-server-gateway",
  "dune-server-survival-1",
  "dune-server-overmap"
]);
const SUPPORTED_REGIONS = new Set([
  "North America",
  "Europe",
  "Asia",
  "Oceania",
  "South America"
]);

// This explicit list is the security boundary for settings sent to the public directory.
const PUBLIC_MODIFIER_SETTINGS = new Map([
  publicModifier("ConsoleVariables", "Dune.GlobalMiningOutputMultiplier", "Mining Output", "1.0", "multiplier"),
  publicModifier("ConsoleVariables", "Dune.GlobalVehicleMiningOutputMultiplier", "Vehicle Mining Output", "1.0", "multiplier"),
  publicModifier("ConsoleVariables", "SecurityZones.PvpResourceMultiplier", "PvP Resource Output", "2.5", "multiplier"),
  publicModifier("ConsoleVariables", "dw.VehicleDurabilityDamageMultiplier", "Vehicle Durability Damage", "1.0", "multiplier"),
  publicModifier("ConsoleVariables", "Sandstorm.Enabled", "Sandstorms", "1", "boolean"),
  publicModifier("ConsoleVariables", "Sandstorm.Treasure.Enabled", "Sandstorm Treasure", "1", "boolean"),
  publicModifier("ConsoleVariables", "sandworm.dune.Enabled", "Sandworms", "1", "boolean"),
  publicModifier("ConsoleVariables", "Vehicle.SandwormCollisionInteraction", "Sandworm Vehicle Collision", "false", "boolean"),
  publicModifier("ConsoleVariables", "Sandworm.SandwormDangerZonesEnabled", "Sandworm Danger Zones", "true", "boolean"),
  publicModifier("ConsoleVariables", "Vehicle.SandwormInvulnerabilitySecondsOnExit", "Vehicle Sandworm Exit Protection", "900.0", "duration"),
  publicModifier("ConsoleVariables", "Vehicle.SandwormInvulnerabilitySecondsOnServerRestart", "Vehicle Restart Protection", "7200.0", "duration"),
  publicModifier("ConsoleVariables", "Character.WeaponSpecificQuickMelee.Enabled", "Weapon Quick Melee", "0", "boolean"),
  publicModifier("ConsoleVariables", "SpiceAddiction.SpiceVisionsEnabled", "Spice Visions", "1", "boolean"),
  publicModifier("ConsoleVariables", "IgwTravel.AllowPassengerToUseTaxi", "Passenger Taxi Travel", "0", "boolean"),
  publicModifier("ConsoleVariables", "Ai.BloodDoors.Enabled", "Blood Doors", "True", "boolean"),
  publicModifier("ConsoleVariables", "Ai.BloodDoors.DisableBlightEcolab", "Blight Ecolab Blood Doors", "False", "boolean"),
  publicModifier("/Script/DuneSandbox.PvpPveSettings", "m_bShouldForceEnablePvpOnAllPartitions", "PvP On All Partitions", "False", "boolean"),
  publicModifier("/Script/DuneSandbox.SecurityZonesSubsystem", "m_bAreSecurityZonesEnabled", "Security Zones", "True", "boolean"),
  publicModifier("/DeteriorationSystem.ItemDeteriorationConstants", "UpdateRateInSeconds", "Item Deterioration Interval", "1.0", "duration"),
  publicModifier("/Script/DuneSandbox.SpiceHarvestingSystem", "m_bSpawningActive", "Spice Fields", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.SpiceHarvestingSystem", "m_bPlayerMustWitnessBloom", "Witness Spice Blooms", "False", "boolean"),
  publicModifier("/Script/DuneSandbox.FlourSandSubsystem", "m_FlourSandFieldsActivePercentage", "Active Flour Sand Fields", "1.0", "ratioPercent"),
  publicModifier("/Script/DuneSandbox.ResourceLocationSystem", "m_bIsEnabled", "Resource Locations", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.ResourceLocationSystem", "m_ResourceSpawnChance", "Resource Location Chance", "1.0", "ratioPercent"),
  publicModifier("/Script/DuneSandbox.ResourceNodeSpawner", "m_ResourceSpawnChance", "Resource Node Chance", "1.0", "ratioPercent"),
  publicModifier("/Script/DuneSandbox.SandStormConfig", "m_bAutoSpawnEnabled", "Automatic Sandstorms", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.SandStormConfig", "m_bSandStormDebrisEnabled", "Sandstorm Debris", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.SandStormConfig", "m_bCoriolisAutoSpawnEnabled", "Automatic Coriolis Storms", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.SandStormConfig", "m_bCoriolisDoesDamage", "Coriolis Storm Damage", "False", "boolean"),
  publicModifier("/Script/DuneSandbox.SandStormConfig", "m_bCoriolisTriggerShiftingSands", "Coriolis Shifting Sands", "False", "boolean"),
  publicModifier("/Script/DuneSandbox.CoriolisSubsystem", "m_CycleDurationInDays", "Coriolis Cycle", "7", "days"),
  publicModifier("/Script/DuneSandbox.CoriolisSubsystem", "m_bIsDbWipeEnabled", "Coriolis Database Wipe", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.BuildingSettings", "m_MaxNumLandclaimSegments", "Landclaim Segments", "24", "number"),
  publicModifier("/Script/DuneSandbox.BuildingSettings", "m_BuildingBlueprintMaxExtensions", "Blueprint Extensions", "16", "number"),
  publicModifier("/Script/DuneSandbox.BuildingSettings", "m_BaseBackupMaxExtensions", "Base Backup Extensions", "40", "number"),
  publicModifier("/Script/DuneSandbox.BuildingSettings", "m_bBuildingRestrictionLimitsEnabled", "Building Restriction Limits", "False", "boolean"),
  publicModifier("/Script/DuneSandbox.BuildingSettings", "m_bMitigateAllSandstormDamage", "Building Sandstorm Protection", "False", "boolean"),
  publicModifier("/Script/DuneSandbox.BuildingSettings", "m_PickupTotalDurabilityPercentageReduction", "Building Pickup Durability Loss", "0.0", "ratioPercent"),
  publicModifier("/Script/DuneSandbox.BuildingSettings", "m_bEnableStabilizationSystem", "Building Stabilization", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.BuildingSettings", "m_bEnableDestabilizationSystem", "Building Destabilization", "False", "boolean"),
  publicModifier("/Script/DuneSandbox.BuildingSettings", "m_bEnableBuildingDestructionEffects", "Building Destruction Effects", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.BuildingSettings", "m_BuildingHeightLimitInM", "Building Height Limit", "1500.000000", "meters"),
  publicModifier("/Script/DuneSandbox.BuildingSettings", "m_BuildingBlueprintRangeMultiplier", "Blueprint Range", "0.660000", "multiplier"),
  publicModifier("/Script/DuneSandbox.BuildingSettings", "m_BuildRange", "Build Range", "3000.000000", "number"),
  publicModifier("/Script/DuneSandbox.BuildingSettings", "m_bEnableBuildingNearServerBorders", "Building Near Server Borders", "False", "boolean"),
  publicModifier("/Script/DuneSandbox.BuildingSettings", "m_bCanRemoveBuildablesWithNoOwner", "Remove Ownerless Buildings", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.BuildingSettings", "m_TimeToAutomaticallyCloseDoor", "Door Auto-close", "10", "duration"),
  publicModifier("/Script/DuneSandbox.BuildingSettings", "m_DefaultRepairCostMultiplier", "Building Repair Cost", "0.25", "multiplier"),
  publicModifier("/Script/DuneSandbox.DuneSandboxGameModeBase", "m_bShouldPlayersDropLootOnDeath", "Drop Loot On Death", "False", "boolean"),
  publicModifier("/Script/DuneSandbox.DuneSandboxGameModeBase", "m_bShouldPlayersDropLootOnDefeat", "Drop Loot On Defeat", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.DuneSandboxGameModeBase", "m_bShouldPlayersLoseItemsOnDeath", "Lose Items On Death", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.DuneSandboxGameModeBase", "m_bShouldNpcDropLootOnDeath", "NPC Loot Drops", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.DuneSandboxGameModeBase", "m_DropAmountOnDefeat", "Defeat Loot Drop", "0.4", "ratioPercent"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "m_GlobalXPMultiplier", "XP Multiplier", "1.0", "multiplier"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "m_GlobalFameMultiplier", "Fame Multiplier", "1.0", "multiplier"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "m_GlobalProgressionSpeedMultiplier", "Progression Speed", "1.0", "multiplier"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "m_GuildCreationCost", "Guild Creation Cost", "1000", "number"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "SellOrderPricePercentageFee", "Exchange Sell Fee", "2.0", "percent"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "SpiceTaxAmount", "Spice Tax Amount", "0.1", "number"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "SpiceTaxInterval", "Spice Tax Interval", "3600", "duration"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "m_GlobalHarvestAmountMultiplier", "Harvest Amount", "1.0", "multiplier"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "m_GlobalHarvestHealthMultiplier", "Resource Health", "1.0", "multiplier"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "m_ItemDurabilityLossMultiplier", "Item Durability Loss", "1.0", "multiplier"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "m_WaterConsumptionRate", "Water Consumption", "1.0", "multiplier"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "m_WaterConsumptionInStormMultiplier", "Storm Water Consumption", "4.0", "multiplier"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "m_GlobalDamageToNpcsMultiplier", "Damage To NPCs", "1.0", "multiplier"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "m_GlobalDamageToPlayersMultiplier", "Damage To Players", "1.0", "multiplier"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "m_GlobalHealthMultiplier", "Player Health", "1.0", "multiplier"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "m_GlobalBuildingDamageMultiplier", "Building Damage", "1.0", "multiplier"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "m_BuildingDecayRateMultiplier", "Building Decay", "1.0", "multiplier"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "bEnableBuildingStability", "Building Stability", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "m_InventoryWeightMultiplier", "Inventory Weight", "1.0", "multiplier"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "m_PlayerStartingWater", "Starting Water", "100.0", "number"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "m_DefaultReconnectGracePeriodSeconds", "Reconnect Grace Period", "300", "duration"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "m_MaxGuildMembersAllowed", "Maximum Guild Members", "32", "number"),
  publicModifier("/Script/DuneSandbox.DuneGameMode", "m_MaxGuildsAllowed", "Maximum Guilds", "3", "number"),
  publicModifier("/Script/DuneSandbox.InventorySystemSettings", "PlayerInventoryStartingSize", "Starting Inventory Slots", "40", "number"),
  publicModifier("/Script/DuneSandbox.InventorySystemSettings", "PlayerInventoryStartingVolumeCapacity", "Starting Inventory Capacity", "225.0", "number"),
  publicModifier("/Script/DuneSandbox.SandwormSettings", "m_EnableSandwormSystem", "Sandworm System", "UseAllowList", "text"),
  publicModifier("/Script/DuneSandbox.SandwormSettings", "WormDetectionDistance", "Sandworm Detection Distance", "5000.0", "number"),
  publicModifier("/Script/DuneSandbox.SandwormSettings", "m_MinWormSpawnInternal", "Sandworm Spawn Interval", "300.0", "duration"),
  publicModifier("/Script/DuneSandbox.SandwormSettings", "m_MinDistanceBetweenSandworms", "Sandworm Minimum Distance", "3000.0", "number"),
  publicModifier("/Script/DuneSandbox.SandwormSettings", "m_SandwormQuicksandSpeedModifier", "Sandworm Quicksand Speed", "0.5", "multiplier"),
  publicModifier("/Script/DuneSandbox.SandwormSettings", "ThreatScale", "Sandworm Threat", "1.000000", "multiplier"),
  publicModifier("/Script/DuneSandbox.SandwormSettings", "m_bEnableDangerZones", "Sandworm Gameplay Danger Zones", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.SandwormSettings", "m_bEnableHibernation", "Sandworm Hibernation", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.SandwormSettings", "EnableBuildingThreatGeneration", "Building Sandworm Threat", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.ContractsSubsystem", "m_bIsEnabled", "Contracts", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.EncountersSubsystem", "m_bAreRandomEncountersEnabled", "Random Encounters", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.LandsraadSettings", "bIsLandsraadEnabled", "Landsraad", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.SpiceAddictionSubsystem", "m_bIsSpiceAddictionEnabled", "Spice Addiction", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.SpiceAddictionSubsystem", "m_bIsSpiceVisionEnabled", "Spice Vision", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.TaxationSettings", "m_bTaxationEnabled", "Taxation", "False", "boolean"),
  publicModifier("/Script/DuneSandbox.TaxationSettings", "m_TaxationCycleLengthSeconds", "Taxation Cycle", "1209600", "duration"),
  publicModifier("/Script/DuneSandbox.RespawnSettings", "m_bCrossMapRespawnDropItems", "Cross-map Respawn Item Drop", "True", "boolean"),
  publicModifier("/Script/DuneSandbox.CharacterRecustomizerSubsystem", "m_CostAmount", "Character Recustomization Cost", "5000", "number"),
  publicModifier("/Script/DuneSandbox.LootSettings", "GlobalLootRightsBehaviour", "Loot Rights", "PerPlayerChestAndNpcDrop", "text"),
  publicModifier("/Script/DuneSandbox.GuildSettings", "m_MaxPendingGuildInvitesAllowed", "Pending Guild Invites", "10", "number"),
  publicModifier("/Script/DuneSandbox.AugmentSettings", "m_JackpotRollPercentage", "Augment Jackpot Chance", "0.950000", "ratioPercent"),
  publicModifier("/Script/DuneSandbox.AugmentSettings", "m_MaxRangedWeaponAugments", "Ranged Weapon Augments", "3", "number"),
  publicModifier("/Script/DuneSandbox.AugmentSettings", "m_MaxMeleeWeaponAugments", "Melee Weapon Augments", "3", "number"),
  publicModifier("/Script/DuneSandbox.AugmentSettings", "m_MaxArmorAugments", "Armor Augments", "2", "number")
]);

export function createPublicDirectoryReporter(config, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const getDb = options.getDb || (() => options.db);
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const getBattlegroupRunning = options.getBattlegroupRunning || isBattlegroupRunning;
  const reconcileProbe = options.reconcileProbe || ((probe) => reconcilePublicProbe(config.repoRoot, probe));
  const collectPlayerPortalSnapshots = options.collectPlayerPortalSnapshots || duneDb.playerPortalSnapshots;
  const playerPortalJourneyData = options.playerPortalJourneyData || readJsonFile(
    resolve(config.repoRoot, "runtime/data/journey-tags.json"),
    {}
  );
  const playerPortalSkillData = options.playerPortalSkillData || readJsonFile(
    resolve(config.repoRoot, "runtime/data/admin-skill-modules.json"),
    []
  );
  const now = options.now || (() => Date.now());
  const random = options.random || Math.random;
  const identityPath = options.identityPath || resolve(config.secretsDir, "public-directory.json");
  const statusPath = options.statusPath || resolve(config.generatedDir, "public-directory-status.json");
  const baseUrl = String(
    options.baseUrl ||
    process.env.DUNE_PUBLIC_DIRECTORY_URL ||
    DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  const claimBaseUrl = String(
    options.claimBaseUrl ||
    process.env.DUNE_PUBLIC_DIRECTORY_CLAIM_URL ||
    baseUrl
  ).replace(/\/+$/, "");

  let timer = null;
  let running = false;
  let stopped = false;
  let failureCount = 0;
  let state = readStatus(statusPath);
  let lastPlayerPortalUploadAt = 0;
  let lastPlayerPortalRequestSignature = "";

  function start() {
    if (stopped || timer) return;
    schedule(5000 + Math.floor(random() * 10000));
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeoutFn(timer);
    timer = null;
  }

  async function tick() {
    if (stopped || running) return;
    if (timer) clearTimeoutFn(timer);
    running = true;
    timer = null;
    try {
      const settings = readDirectorySettings(config.repoRoot);
      if (!settings.enabled || settings.mode !== "public") {
        await removeRemoteListing(settings);
        failureCount = 0;
        schedule(DEFAULT_HEARTBEAT_SECONDS * 1000);
        return;
      }

      const identity = getOrCreateIdentity(identityPath);
      const snapshot = await collectDirectorySnapshot(config, getDb(), settings, {
        running: await getBattlegroupRunning()
      });
      const payload = buildHeartbeatPayload(identity, snapshot);
      const attemptedAt = new Date(now()).toISOString();
      writeState({
        enabled: true,
        mode: settings.mode,
        state: "reporting",
        serverId: identity.serverId,
        remoteListed: Boolean(state.remoteListed),
        lastAttemptAt: attemptedAt,
        lastSuccessAt: state.lastSuccessAt || null,
        nextHeartbeatAt: null,
        error: null,
        listingClaimed: state.listingClaimed === true
      });

      const receipt = await requestJson(fetchImpl, `${baseUrl}/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      let listingClaimed = typeof receipt.listingClaimed === "boolean"
        ? receipt.listingClaimed
        : state.listingClaimed === true;
      let playerPortalStatus = null;
      try {
        const claimStatus = await requestJson(fetchImpl, `${claimBaseUrl}/${encodeURIComponent(identity.serverId)}/claim-status`, {
          method: "GET",
          headers: { authorization: `Bearer ${identity.secret}` }
        });
        listingClaimed = claimStatus.claimed === true;
        playerPortalStatus = claimStatus;
      } catch {
        // Claim status is optional while the directory service is being upgraded.
      }
      if (playerPortalStatus?.playerPortalEnabled === true && Array.isArray(playerPortalStatus.requestedAccountHashes)) {
        const requested = playerPortalStatus.requestedAccountHashes
          .map((value) => String(value || "").toLowerCase())
          .filter((value) => /^[0-9a-f]{64}$/.test(value))
          .slice(0, 25)
          .sort();
        const signature = requested.join(",");
        if (requested.length && (signature !== lastPlayerPortalRequestSignature || now() - lastPlayerPortalUploadAt >= 60_000)) {
          try {
            const snapshots = await collectPlayerPortalSnapshots(
              getDb(),
              requested,
              playerPortalJourneyData,
              playerPortalSkillData
            );
            await requestJson(fetchImpl, `${claimBaseUrl}/${encodeURIComponent(identity.serverId)}/player-portal/snapshot`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${identity.secret}`,
                "content-type": "application/json"
              },
              body: JSON.stringify({ observedAt: new Date(now()).toISOString(), snapshots })
            });
            lastPlayerPortalUploadAt = now();
            lastPlayerPortalRequestSignature = signature;
          } catch {
            // Private portal sync must never interrupt the public heartbeat.
          }
        }
      } else {
        lastPlayerPortalRequestSignature = "";
      }
      const heartbeatSeconds = clampInteger(
        receipt.nextHeartbeatSeconds,
        30,
        15 * 60,
        DEFAULT_HEARTBEAT_SECONDS
      );
      const probe = normalizeProbeReceipt(receipt.probe);
      let probeState = probe?.signalingUrl ? "starting" : "unavailable";
      let probeError = null;
      try {
        if (probe?.signalingUrl) {
          await reconcileProbe({
            enabled: true,
            signalingUrl: probe.signalingUrl,
            serverId: identity.serverId,
            secret: identity.secret
          });
        } else if (state.probeEndpoint) {
          await reconcileProbe({ enabled: false });
        }
        probeState = probe?.signalingUrl ? "started" : "unavailable";
      } catch (error) {
        probeState = "error";
        probeError = safeError(error);
      }
      failureCount = 0;
      writeState({
        enabled: true,
        mode: settings.mode,
        state: !snapshot.running ? "offline" : snapshot.ready ? "online" : "degraded",
        serverId: identity.serverId,
        remoteListed: true,
        lastAttemptAt: attemptedAt,
        lastSuccessAt: new Date(now()).toISOString(),
        nextHeartbeatAt: new Date(now() + heartbeatSeconds * 1000).toISOString(),
        error: null,
        listingClaimed,
        probeEndpoint: probe?.signalingUrl || null,
        probeState,
        probeError
      });
      schedule(heartbeatSeconds * 1000);
    } catch (error) {
      failureCount += 1;
      const delaySeconds = Math.min(
        MAX_BACKOFF_SECONDS,
        DEFAULT_HEARTBEAT_SECONDS * (2 ** Math.min(failureCount - 1, 4))
      );
      writeState({
        ...state,
        enabled: true,
        state: "error",
        lastAttemptAt: new Date(now()).toISOString(),
        nextHeartbeatAt: new Date(now() + delaySeconds * 1000).toISOString(),
        error: safeError(error)
      });
      schedule(delaySeconds * 1000);
    } finally {
      running = false;
    }
  }

  async function removeRemoteListing(settings) {
    const identity = readIdentity(identityPath);
    const shouldDelete = identity && state.remoteListed !== false;
    if (shouldDelete) {
      await requestJson(fetchImpl, `${baseUrl}/${encodeURIComponent(identity.serverId)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${identity.secret}` }
      });
    }
    if (state.probeEndpoint) {
      try {
        await reconcileProbe({ enabled: false, endpoint: null });
      } catch {
        // Listing removal must not fail because local probe cleanup encountered an issue.
      }
    }
    writeState({
      enabled: settings.enabled,
      mode: settings.mode,
      state: settings.enabled ? "local-only" : "disabled",
      serverId: identity?.serverId || null,
      remoteListed: false,
      lastAttemptAt: shouldDelete ? new Date(now()).toISOString() : state.lastAttemptAt || null,
      lastSuccessAt: state.lastSuccessAt || null,
      nextHeartbeatAt: null,
      error: null,
      probeEndpoint: null,
      probeState: "disabled",
      probeError: null
    });
  }

  async function verifyClaim(code) {
    const identity = readIdentity(identityPath);
    if (!identity) throw new Error("Public server identity is not available yet.");
    const normalizedCode = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
    if (normalizedCode.length !== 12) throw new Error("Enter the 12-character claim code from DuneDocker.app.");
    const result = await requestJson(fetchImpl, `${claimBaseUrl}/${encodeURIComponent(identity.serverId)}/verify-claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${identity.secret}`
      },
      body: JSON.stringify({ code: normalizedCode })
    });
    writeState({ ...state, listingClaimed: true });
    return result;
  }

  function schedule(delayMs) {
    if (stopped) return;
    if (timer) clearTimeoutFn(timer);
    timer = setTimeoutFn(() => {
      void tick();
    }, Math.max(0, delayMs));
    timer?.unref?.();
  }

  function writeState(next) {
    state = {
      updatedAt: new Date(now()).toISOString(),
      ...next
    };
    writeJsonAtomic(statusPath, state, 0o600);
  }

  return {
    start,
    stop,
    tick,
    verifyClaim,
    publicState: () => ({ ...state })
  };
}

export function readDirectorySettings(repoRoot, env = process.env) {
  const fileEnv = readEnvFile(resolve(repoRoot, ".env"));
  const rawEnabled = firstValue(fileEnv.DUNE_PUBLIC_DIRECTORY_ENABLED, env.DUNE_PUBLIC_DIRECTORY_ENABLED);
  const mode = String(firstValue(fileEnv.SERVER_IP_MODE, env.SERVER_IP_MODE, "local")).trim().toLowerCase();
  const discordInvite = normalizeDiscordInvite(firstValue(
    fileEnv.DUNE_PUBLIC_DIRECTORY_DISCORD_INVITE,
    env.DUNE_PUBLIC_DIRECTORY_DISCORD_INVITE,
    ""
  ));
  return {
    enabled: rawEnabled === undefined ? true : !/^(0|false|no|off|disabled)$/i.test(String(rawEnabled).trim()),
    mode,
    title: cleanText(firstValue(fileEnv.SERVER_TITLE, env.SERVER_TITLE, ""), 120),
    region: normalizeRegion(firstValue(fileEnv.SERVER_REGION, env.SERVER_REGION, "")),
    discordInvite: discordInvite || ""
  };
}

export async function collectDirectorySnapshot(
  config,
  db,
  settings = readDirectorySettings(config.repoRoot),
  options = {}
) {
  const version = readGameBuild(config.repoRoot);
  const installationKey = readDirectoryInstallationKey(config.repoRoot);
  const previousInstallationKey = readPreviousDirectoryInstallationKey(config.repoRoot, installationKey);
  if (!settings.title) throw new Error("Public directory reporting requires SERVER_TITLE.");
  if (!SUPPORTED_REGIONS.has(settings.region)) {
    throw new Error(`Public directory reporting does not support region: ${settings.region || "unknown"}.`);
  }
  if (!version) throw new Error("Public directory reporting is waiting for a detected game build.");

  const running = options.running !== false;
  let playersOnline = 0;
  let ready = false;
  let sietches = readConfiguredSietches(config.repoRoot);

  if (running && db) {
    try {
      const hasFarms = await duneDb.tableExists(db, "farm_state");
      const hasPartitions = await duneDb.tableExists(db, "world_partition");
      const hasPlayers = await duneDb.tableExists(db, "player_state");
      let farmPlayers = 0;
      let playerRows = 0;

      if (hasFarms) {
        const result = await db.query(`
          select coalesce(sum(coalesce(connected_players, 0))
            filter (where coalesce(alive, false)), 0)::int as players
          from dune.farm_state`);
        farmPlayers = Number(result.rows?.[0]?.players || 0);
      }
      if (hasPlayers) {
        const result = await db.query(`
          select count(*)::int as players
          from dune.player_state
          where coalesce(online_status::text, '') = 'Online'`);
        playerRows = Number(result.rows?.[0]?.players || 0);
      }
      if (hasFarms && hasPartitions) {
        const result = await db.query(`
          select count(*)::int as ready_maps
          from (
            select lower(wp.map) as map
            from dune.world_partition wp
            join dune.farm_state fs on fs.server_id = wp.server_id
            where lower(wp.map) in ('survival_1', 'overmap')
              and coalesce(fs.alive, false)
              and coalesce(fs.ready, false)
            group by lower(wp.map)
          ) core_maps`);
        ready = Number(result.rows?.[0]?.ready_maps || 0) === 2;
      }
      if (!sietches && hasPartitions) {
        const result = await db.query(`
          select count(*)::int as sietches
          from dune.world_partition
          where lower(map) = 'survival_1'`);
        sietches = Number(result.rows?.[0]?.sietches || 0);
      }
      playersOnline = Math.max(farmPlayers, playerRows);
    } catch {
      ready = false;
      playersOnline = 0;
    }
  }

  const capacity = readConfiguredCapacity(config.repoRoot, sietches);
  const publicMetadata = await collectPublicMetadata(config.repoRoot, db);
  return {
    name: settings.title,
    region: settings.region,
    running,
    ready,
    playersOnline: Math.min(Math.max(0, playersOnline), capacity),
    capacity,
    version,
    installationKey,
    previousInstallationKey,
    sietches: clampInteger(sietches, 0, 1000, 0),
    discordInvite: settings.discordInvite || "",
    publicMetadata
  };
}

export function buildHeartbeatPayload(identity, snapshot) {
  const payload = {
    serverId: identity.serverId,
    secret: identity.secret,
    publicMode: true,
    name: snapshot.name,
    region: snapshot.region,
    running: Boolean(snapshot.running),
    ready: Boolean(snapshot.ready),
    playersOnline: snapshot.playersOnline,
    capacity: snapshot.capacity,
    version: snapshot.version,
    sietches: snapshot.sietches,
    discordInvite: snapshot.discordInvite || "",
    publicMetadata: snapshot.publicMetadata || {},
    personalizedPingEnabled: true
  };
  if (snapshot.installationKey) payload.installationKey = snapshot.installationKey;
  if (snapshot.previousInstallationKey) payload.previousInstallationKey = snapshot.previousInstallationKey;
  return payload;
}

export async function collectPublicMetadata(repoRoot, db) {
  const modifiers = readPublicModifiers(resolve(repoRoot, "runtime/generated/gameplay-profile.ini"));
  let progression = { characters: 0, averageLevel: 0, highestLevel: 0 };
  if (db) {
    try {
      const result = await duneDb.addonLeadershipPlayers(db);
      const levels = (result.rows || []).map((row) => Number(row.level) || 0);
      if (result?.capabilities?.players) {
        progression = {
          characters: levels.length,
          averageLevel: levels.length ? Math.round(levels.reduce((sum, level) => sum + level, 0) / levels.length) : 0,
          highestLevel: levels.length ? Math.max(...levels) : 0
        };
      }
    } catch {
      // Public directory reporting must remain healthy if progression is unavailable.
    }
  }
  return { modifiers, progression };
}

export function readPublicModifiers(path) {
  if (!existsSync(path)) return {};
  const collected = new Map();
  let section = "";
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      section = publicModifierSection(line.slice(1, -1));
      continue;
    }
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    const setting = PUBLIC_MODIFIER_SETTINGS.get(publicModifierKey(section, key));
    if (!setting) continue;
    const value = line.slice(equals + 1).trim().replace(/^"|"$/g, "");
    if (!value || publicModifierValuesEqual(value, setting.defaultValue, setting.format)) continue;
    const formatted = formatPublicModifierValue(value, setting.format);
    if (!formatted) continue;
    if (!collected.has(setting.label)) collected.set(setting.label, new Set());
    collected.get(setting.label).add(formatted);
  }
  return Object.fromEntries([...collected].map(([label, readings]) => {
    const values = [...readings];
    if (values.length === 1) return [label, values[0]];
    const visible = values.slice(0, 3).join(", ");
    return [label, `Varies: ${visible}${values.length > 3 ? ` +${values.length - 3}` : ""}`];
  }));
}

function publicModifier(section, key, label, defaultValue, format) {
  return [publicModifierKey(section, key), { label, defaultValue, format }];
}

function publicModifierKey(section, key) {
  return `${section}\u0000${key}`;
}

function publicModifierSection(header) {
  const parts = header.split(":");
  if (parts[0] === "Engine" || parts[0] === "Global") return parts.slice(1).join(":");
  if (parts[0] === "Map" || parts[0] === "MapEngine") return parts.slice(2).join(":");
  if (parts[0] === "Partition" || parts[0] === "PartitionEngine") return parts.slice(3).join(":");
  return "";
}

function publicModifierValuesEqual(value, defaultValue, format) {
  if (format === "boolean") {
    const left = modifierBoolean(value);
    const right = modifierBoolean(defaultValue);
    return left !== null && right !== null && left === right;
  }
  if (["multiplier", "number", "ratioPercent", "percent", "duration", "days", "meters"].includes(format)) {
    const left = Number(value);
    const right = Number(defaultValue);
    return Number.isFinite(left) && Number.isFinite(right) && left === right;
  }
  return value.trim().toLowerCase() === defaultValue.trim().toLowerCase();
}

function formatPublicModifierValue(value, format) {
  if (format === "boolean") {
    const enabled = modifierBoolean(value);
    return enabled === null ? "" : enabled ? "Enabled" : "Disabled";
  }
  if (format === "text") return value.slice(0, 80);
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  const readable = number.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (format === "multiplier") return `${readable}x`;
  if (format === "ratioPercent") return `${(number * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
  if (format === "percent") return `${readable}%`;
  if (format === "duration") return formatPublicDuration(number);
  if (format === "days") return `${readable} ${number === 1 ? "day" : "days"}`;
  if (format === "meters") return `${readable} m`;
  return readable;
}

function modifierBoolean(value) {
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function formatPublicDuration(seconds) {
  if (seconds >= 86400 && seconds % 86400 === 0) return `${seconds / 86400} ${seconds === 86400 ? "day" : "days"}`;
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600} ${seconds === 3600 ? "hour" : "hours"}`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} ${seconds === 60 ? "minute" : "minutes"}`;
  return `${seconds.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${seconds === 1 ? "second" : "seconds"}`;
}

export function normalizeDiscordInvite(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.length > 160) return null;
  try {
    const invite = new URL(raw);
    const hostname = invite.hostname.toLowerCase();
    if (
      invite.protocol !== "https:" ||
      invite.port ||
      invite.username ||
      invite.password ||
      invite.search ||
      invite.hash
    ) return null;
    const parts = invite.pathname.split("/").filter(Boolean);
    let code = "";
    if (hostname === "discord.gg" && parts.length === 1) {
      [code] = parts;
    } else if (
      (hostname === "discord.com" || hostname === "www.discord.com") &&
      parts.length === 2 &&
      parts[0].toLowerCase() === "invite"
    ) {
      code = parts[1];
    } else {
      return null;
    }
    if (!/^[A-Za-z0-9_-]{2,100}$/.test(code)) return null;
    return `https://discord.gg/${code}`;
  } catch {
    return null;
  }
}

export async function isBattlegroupRunning(getRunningContainers = runningContainerNames) {
  try {
    const running = new Set(await getRunningContainers());
    return [...BATTLEGROUP_CORE_CONTAINERS].some((name) => running.has(name));
  } catch {
    return false;
  }
}

export function getOrCreateIdentity(path) {
  const current = readIdentity(path);
  if (current) return current;
  const identity = {
    serverId: randomUUID(),
    secret: randomBytes(32).toString("base64url")
  };
  writeJsonAtomic(path, identity, 0o600);
  return identity;
}

async function runningContainerNames() {
  const output = await execFileOutput("docker", ["ps", "--format", "{{.Names}}"], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"]
  });
  return output.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

export function readConfiguredCapacity(repoRoot, configuredSietches = readConfiguredSietches(repoRoot)) {
  const path = resolve(repoRoot, "runtime/director/config/director_config.ini");
  if (!existsSync(path)) return 60;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  let section = "";
  let defaultCap = 60;
  let defaultUpdates = true;
  let sectionCap = null;
  let sectionUpdates = null;
  let total = 0;

  const flush = () => {
    if (!section || ["Server", "Battlegroup", "InstancingModes"].includes(section)) return;
    const updates = sectionUpdates ?? defaultUpdates;
    const cap = sectionCap ?? defaultCap;
    if (updates && Number.isInteger(cap) && cap > 0) {
      const dimensions = section.toLowerCase() === "survival_1"
        ? clampInteger(configuredSietches, 1, 1000, 1)
        : 1;
      total += cap * dimensions;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      flush();
      section = sectionMatch[1];
      sectionCap = null;
      sectionUpdates = null;
      continue;
    }
    const [key, rawValue] = line.split("=", 2);
    if (!rawValue) continue;
    const value = rawValue.trim();
    if (key === "PlayerHardCap") {
      const parsed = Number(value);
      if (section === "Server") defaultCap = parsed;
      else sectionCap = parsed;
    } else if (key === "ShouldUpdatePlayerCountOnFls") {
      const parsed = /^true$/i.test(value);
      if (section === "Server") defaultUpdates = parsed;
      else sectionUpdates = parsed;
    }
  }
  flush();
  return clampInteger(total || defaultCap, 1, 10000, 60);
}

export function readGameBuild(repoRoot) {
  const env = readEnvFile(resolve(repoRoot, "runtime/generated/image-tags.env"));
  const tag = String(env.DUNE_WORLD_IMAGE_TAG || "").trim();
  const match = tag.match(/^([A-Za-z0-9._+]+?)(?:-\d+-shipping)?$/i);
  return match?.[1] || "";
}

export function readDirectoryInstallationKey(repoRoot) {
  const generated = readEnvFile(resolve(repoRoot, "runtime/generated/battlegroup.env"));
  const configured = readEnvFile(resolve(repoRoot, ".env"));
  const battlegroupId = String(firstValue(generated.BATTLEGROUP_ID, configured.BATTLEGROUP_ID, "")).trim();
  return directoryKeyForBattlegroup(battlegroupId);
}

export function readPreviousDirectoryInstallationKey(repoRoot, currentKey = readDirectoryInstallationKey(repoRoot)) {
  const restorePoint = readEnvFile(resolve(repoRoot, "runtime/generated/battlegroup-restore-point.env"));
  const previousKey = directoryKeyForBattlegroup(restorePoint.PREVIOUS_BATTLEGROUP_ID);
  const adoptedKey = directoryKeyForBattlegroup(restorePoint.ADOPTED_BATTLEGROUP_ID);
  return previousKey && adoptedKey === currentKey && previousKey !== currentKey ? previousKey : "";
}

function directoryKeyForBattlegroup(value) {
  const battlegroupId = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(battlegroupId) || /^(unknown|dune-docker)$/i.test(battlegroupId)) return "";
  return createHash("sha256")
    .update(`dunedocker-directory-installation-v1\0${battlegroupId}`)
    .digest("hex");
}

function readConfiguredSietches(repoRoot) {
  try {
    const value = JSON.parse(readFileSync(resolve(repoRoot, "runtime/generated/sietch-config.json"), "utf8"));
    return Number(value?.maps?.Survival_1?.active_dimensions || 0);
  } catch {
    return 0;
  }
}

function normalizeRegion(value) {
  const raw = cleanText(value, 80).replace(/\s+Test$/i, "");
  for (const region of SUPPORTED_REGIONS) {
    if (region.toLowerCase() === raw.toLowerCase()) return region;
  }
  return raw;
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function readJsonFile(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function readIdentity(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!/^[0-9a-f-]{36}$/i.test(String(value?.serverId || ""))) return null;
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(String(value?.secret || ""))) return null;
    return { serverId: value.serverId, secret: value.secret };
  } catch {
    return null;
  }
}

function readStatus(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return {
      updatedAt: safeStatusText(value.updatedAt, 40),
      enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
      mode: safeStatusText(value.mode, 20),
      state: safeStatusText(value.state, 30),
      serverId: /^[0-9a-f-]{36}$/i.test(String(value.serverId || "")) ? value.serverId : null,
      remoteListed: typeof value.remoteListed === "boolean" ? value.remoteListed : undefined,
      listingClaimed: typeof value.listingClaimed === "boolean" ? value.listingClaimed : undefined,
      lastAttemptAt: safeStatusText(value.lastAttemptAt, 40),
      lastSuccessAt: safeStatusText(value.lastSuccessAt, 40),
      nextHeartbeatAt: safeStatusText(value.nextHeartbeatAt, 40),
      error: safeStatusText(value.error, 240),
      probeEndpoint: normalizeSignalingUrl(value.probeEndpoint),
      probeState: safeStatusText(value.probeState, 30),
      probeError: safeStatusText(value.probeError, 240)
    };
  } catch {
    return {};
  }
}

function normalizeProbeReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.mode !== "webrtc") return null;
  const signalingUrl = normalizeSignalingUrl(value.signalingUrl);
  return signalingUrl ? { mode: "webrtc", signalingUrl } : null;
}

function normalizeSignalingUrl(value) {
  try {
    const endpoint = new URL(String(value || "").trim());
    if (
      endpoint.protocol !== "https:" ||
      endpoint.hostname !== "dunedocker.app" ||
      endpoint.port ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== "/api/v1/probes" ||
      endpoint.search ||
      endpoint.hash
    ) return null;
    return endpoint.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

export async function reconcilePublicProbe(repoRoot, probe, runCommand = execFileOutput) {
  const script = resolve(repoRoot, "runtime", "scripts", "public-probe.sh");
  if (!probe?.enabled) {
    await runCommand(script, ["stop"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return;
  }
  const signalingUrl = normalizeSignalingUrl(probe.signalingUrl);
  if (!signalingUrl) throw new Error("Public probe signaling URL is invalid.");
  if (!/^[0-9a-f-]{36}$/i.test(String(probe.serverId || ""))) {
    throw new Error("Public probe server identity is invalid.");
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(String(probe.secret || ""))) {
    throw new Error("Public probe credential is invalid.");
  }
  writeProbeEnv(repoRoot, {
    signalingUrl,
    serverId: probe.serverId,
    secret: probe.secret
  });
  await runCommand(script, ["reconcile"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function execFileOutput(file, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, { ...options, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise(stdout || "");
    });
  });
}

function writeProbeEnv(repoRoot, probe) {
  const path = resolve(repoRoot, "runtime", "generated", "public-probe.env");
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, [
    "DUNE_PUBLIC_PROBE_ENABLED=true",
    `DUNE_PUBLIC_PROBE_SERVER_ID=${probe.serverId}`,
    `DUNE_PUBLIC_PROBE_SECRET=${probe.secret}`,
    `DUNE_PUBLIC_PROBE_SIGNAL_URL=${probe.signalingUrl}`,
    ""
  ].join("\n"), { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch {}
}

async function requestJson(fetchImpl, url, options) {
  if (typeof fetchImpl !== "function") throw new Error("Public directory HTTP client is unavailable.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok) {
      throw new Error(`Public directory returned HTTP ${response.status}.`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function writeJsonAtomic(path, value, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  chmodSync(temporaryPath, mode);
  renameSync(temporaryPath, path);
  try { chmodSync(path, mode); } catch {}
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function cleanText(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function safeStatusText(value, maxLength) {
  if (value === undefined || value === null) return null;
  return cleanText(value, maxLength) || null;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function safeError(error) {
  const message = String(error?.name === "AbortError" ? "Public directory request timed out." : error?.message || error);
  return cleanText(message, 240);
}
