import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { totalmem } from "node:os";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync, chmodSync, mkdirSync, createReadStream, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadConfig, publicConfig, parseAllowedIps, resolvePorts } from "./config.js";
import { createAuth, setSessionCookie, clearSessionCookie, json, withSecurityHeaders } from "./auth.js";
import { createLoginRateLimiter, createMutationRateLimiter, createApiKeyRateLimiter } from "./rateLimit.js";
import { createApiKeyStore, GLOBAL_RATE_LIMIT_PER_MINUTE } from "./apiKeys.js";
import { scopeCatalog } from "./apiKeyScopes.js";
import { createBridgeRateLimiter } from "./bridgeRateLimit.js";
import { buildSelfUpdateHelperDockerArgs, detectDockerSocketGid, TaskManager, publicTask } from "./tasks.js";
import { preflight } from "./preflight.js";
import { createServerStatusCache } from "./services/serverStatusCache.js";
import { buildDuneArgs, isDynamicServerService, isReadOnlySql, parseVehicleList, runDockerLogs, runDune, validateServiceName } from "./runner.js";
import { createDb, quoteIdentifier } from "./db.js";
import * as duneDb from "./duneDb.js";
import { audit, recordAdminHistory } from "./audit.js";
import { redact } from "./redact.js";
import { buildingUnlockStatus, customizationGrantGroups, customizationGrantStatus, isBuildingUnlockItem, isCustomizationGrantItem, itemIsRankedSchematic, itemIsSchematic, itemRequiresDatabaseGrant, listBuildingUnlockItems, listCatalogItems, listCustomizationGrantItems, resolveCatalogItem, resolveFillableCatalogItem, resolveItemVolume } from "./adminCatalog.js";
import { buildBroadcastCommand, buildShutdownBroadcastCommand, publishMapChat, publishServerCommand } from "./rmq.js";
import { clearCarePackageHistory, enableCarePackage, ensureCarePackageServerPersona, grantEligibleCarePackages, grantCarePackage, retryCarePackageGrant, runCarePackageAutoScan, saveCarePackageConfig, carePackageCapabilities, carePackageConfig, carePackageEligiblePlayers, carePackageHistory } from "./carePackage.js";
import { readJsonBody, readMultipartForm } from "./httpSafety.js";
import { parseBackupAutoStatus, parseBackupListRows } from "./statusParsers.js";
import { assertInstalledAddonPermission, fetchCommunityAddons, installCommunityAddon, installedAddonContentPath, listInstalledAddons, removeInstalledAddon, setInstalledAddonEnabled, syncInstalledAddonLifecycle, updateCommunityAddon } from "./addons.js";
import { createHardwareStatusProvider, performanceSnapshot as collectPerformanceSnapshot } from "./services/performance.js";
import { serveStatic, contentTypeForPath } from "./http/staticFiles.js";
import { discoverServices } from "./services/serviceDiscovery.js";
import { createBackupDownloadArchive, enrichBackupRows, nextImportedBackupName, normalizeImportedBackupMetadata, readCurrentBattlegroupId, validBackupDownloadName } from "./services/backups.js";
import { createMemoryBalancer } from "./services/memoryBalancer.js";
import { collectContainerHealth } from "./services/containerHealth.js";
import { parseMemorySwapStatus } from "./services/memorySwap.js";
import { createDeathPoller } from "./deathPoller.js";
import { updateEnvFileValue as updateEnvValue } from "./services/envFile.js";
import { funcomAuthMismatchDetected, matchingFuncomAuthLines, saveFuncomTokenValue as writeFuncomToken, validDockerSince } from "./services/funcomAuth.js";
import { readCharacterTransferSettings, saveCharacterTransferSettings } from "./services/characterTransferSettings.js";
import { handleDiscordAdapterRoute, isDiscordAdapterRoute } from "./integrations/discord/routes.js";
import { discordAdapterEnabled } from "./integrations/discord/adapter.js";
import { initializeDiscordAdapterSchema } from "./integrations/discord/schema.js";
import { actionForRoute, ROUTE_ACTIONS } from "./actions.js";
import { evaluate, loadPolicies, getAllPolicies, setPolicies } from "./policy.js";
import { liveItemGrantOk, liveItemGrantWarning } from "./grantResults.js";
import { primeMessageOfTheDayOnlineState, readMessageOfTheDay, recordMessageOfTheDayScanFailure, restoreMessageOfTheDay, runMessageOfTheDayScan, saveMessageOfTheDay } from "./services/messageOfTheDay.js";
import { primePlayerAnnouncementOnlineState, readPlayerAnnouncements, restorePlayerAnnouncements, runPlayerAnnouncementScan, savePlayerAnnouncements } from "./services/playerAnnouncements.js";
import * as restartQueue from "./services/restartQueue.js";
import { persistSpicefieldOverride } from "./services/spicefieldOverrides.js";
import { liveMapSpice } from "./services/liveMapSpice.js";
import { liveMapPoi } from "./services/liveMapPoi.js";
import { applySavedLandsraadMilestonePreset, createLandsraadMilestoneReconciler, readLandsraadMilestonePreset, saveLandsraadMilestonePreset } from "./services/landsraadMilestones.js";
import { exportBlueprint, importBlueprint, listBlueprints, deleteBlueprint } from "./blueprints.js";
import { createZipArchive } from "./services/zipArchive.js";
import { resolveMapCombatState } from "./services/mapCombatState.js";
import { grantAddonItem } from "./addonItemGrants.js";
import { EDA_EXCHANGE_BOT_ADDON_ID, ADDON_SCHEDULER_PERMISSION, createAddonJobScheduler, probeBuybackEligibility, refreshBuybackLog, readBuybackLog, clearBuybackLog, readBuybackSchedule, saveBuybackSchedule, readSeedSchedule, saveSeedSchedule } from "./addonJobs.js";
import { createPublicDirectoryReporter, normalizeDiscordInvite, readDirectorySettings } from "./services/publicDirectory.js";
import { choamTerminalOverview, installChoamTerminals, removeChoamTerminals } from "./services/choamTerminals.js";
import { exchangeStats, listExchangeItems, listExchangeListings, readExchangeConfig, saveExchangeConfig } from "./services/exchange.js";
import { ensureExchangeHistory, listExchangeTransactions } from "./services/exchangeHistory.js";
import { listMarketExchanges, marketBotStatus, saveMarketBuybackSchedule, saveMarketSeedSchedule, decodeSeedPlanCsvUpload, exportMarketSeedPlanCsv, importMarketSeedPlanFromCsv, renameMarketSeedPlan, setActiveMarketSeedPlan } from "./services/exchangeMarket.js";
import { loadMarketSeedPlan } from "./addonSeedJob.js";
import { readMarketItemOverrides, saveMarketItemOverrides, readUnsafeTemplateIds, listBotItemCatalogPickerItems, getOverrideRow } from "./services/marketItemOverrides.js";
import { autoRefillPublicState, createAutoRefillScheduler, setBaseAutoRefill } from "./services/autoRefill.js";
import { autoRefillWaterPublicState, createAutoRefillWaterScheduler, setBaseAutoRefillWater } from "./services/autoRefillWater.js";
import { calculateAlwaysOnHostMemorySafety } from "./services/hostMemorySafety.js";
import { parseEffectiveGuildMemberLimit } from "./services/guildSettings.js";
import { parseEffectivePermissionLimit } from "./services/permissionSettings.js";
import { flushBaseRefillQueues } from "./services/baseRefillFlush.js";
import { verifyBaseBackupState } from "./services/baseBackupSafety.js";
import { banPlayer, bannedFlsIds, createPlayerBanEnforcer, playerBanFor, unbanPlayer } from "./services/playerBans.js";
import { findPlayerForLiveAction, playerIsOnlineForLiveAction } from "./playerLiveActions.js";
import { retireLegacyEdaExchangeBot } from "./services/marketBotRetirement.js";
import { readSelfUpdateStatus } from "./services/selfUpdateStatus.js";
import { createScheduledMapMessageScheduler } from "./services/scheduledMapMessages.js";
import { createQaUpdates } from "./services/qaUpdates.js";

const config = loadConfig();
const hardwareStatus = createHardwareStatusProvider({ filesystemPath: config.repoRoot });
const CONSOLE_PROCESS_STARTED_AT = Date.now();
let edaRetirement = { retired: false, addonRemoved: false, migrated: false, changed: false, backupDir: "", cleanupError: "" };
try {
  edaRetirement = retireLegacyEdaExchangeBot(config);
  if (edaRetirement.changed) {
    console.log(`EDA Exchange Bot retirement complete; Market Bot is managed under Exchange.${edaRetirement.backupDir ? ` Backup: ${edaRetirement.backupDir}` : ""}`);
  }
  if (edaRetirement.cleanupError) {
    console.warn(`EDA Exchange Bot cleanup will be retried at next startup: ${redact(edaRetirement.cleanupError)}`);
  }
} catch (error) {
  // A bad legacy schedule must not be silently discarded. Keep the old addon
  // bridge available for this process and retry the migration next startup.
  console.warn(`EDA Exchange Bot retirement deferred: ${redact(error?.message || "Unexpected error.")}`);
}
loadPolicies(config.repoRoot);
const auth = createAuth(config);
const qaUpdates = createQaUpdates(config);
const loginRateLimiter = createLoginRateLimiter();
const mutationRateLimiter = createMutationRateLimiter();
const apiKeyRateLimiter = createApiKeyRateLimiter({ globalMaxRequests: GLOBAL_RATE_LIMIT_PER_MINUTE });
// Failed bearer attempts are bucketed by client address under this cap, on a
// limiter of their own so pre-auth traffic cannot touch the per-key budget.
const API_KEY_AUTH_FAILURES_PER_MINUTE = 30;
const API_KEY_AUTH_THROTTLE_WINDOW_MS = 60 * 1000;
const apiKeyAuthFailureLimiter = createApiKeyRateLimiter({ globalMaxRequests: API_KEY_AUTH_FAILURES_PER_MINUTE * 200 });

// A capped bucket must not go silent — a sustained attacker would be
// invisible for as long as they kept trying. remoteIpOf has no
// X-Forwarded-For, so behind a proxy this is one bucket for everyone.
const apiKeyAuthThrottleNotices = new Map();

function shouldNoteApiKeyAuthThrottle(failureKey, at = Date.now()) {
  const last = apiKeyAuthThrottleNotices.get(failureKey);
  if (last && at - last < API_KEY_AUTH_THROTTLE_WINDOW_MS) return false;
  // Bounded cleanup: entries are only useful for one window, and the key space
  // is attacker-controlled, so prune whenever it grows past a sane size.
  if (apiKeyAuthThrottleNotices.size > 1000) {
    for (const [key, seen] of apiKeyAuthThrottleNotices) {
      if (at - seen >= API_KEY_AUTH_THROTTLE_WINDOW_MS) apiKeyAuthThrottleNotices.delete(key);
    }
  }
  apiKeyAuthThrottleNotices.set(failureKey, at);
  return true;
}
const apiKeys = createApiKeyStore({ file: config.apiKeysFile });
const bridgeRateLimiter = createBridgeRateLimiter();
// Deferred db read: db is assigned below and is reassignable on reconnect.
// Both flush paths go through flushQueuedGeneratorRefills/flushQueuedWaterRefills
// so a write lands in the audit log no matter which one applied it.
const tasks = new TaskManager(config, {
  onMapDown: () => flushBaseRefillQueues({
    flushGenerators: flushQueuedGeneratorRefills,
    flushWater: flushQueuedWaterRefills,
    flushDeletes: flushQueuedBaseDeletes,
    flushChildAccess: flushQueuedBaseChildAccess,
    // A background probe may have sampled the map immediately before the stop.
    // Wait for it, then perform a fresh pass while the map is positively down.
    // The task hook runs only after the requested map servers have positively
    // stopped. At that point an explicit admin delete may safely remove even
    // a stale Travel/backup/recovery row; the background poller remains
    // conservative and leaves those states queued while maps may be live.
    flushVehicleDeletes: () => flushQueuedVehicleDeletes({ forceFresh: true, allowBlockedStates: true })
  })
});
let db = createDb(config);
const publicDirectory = createPublicDirectoryReporter(config, { getDb: () => db });
let carePackageAutoRunning = false;
let carePackageAutoLastRun = 0;
let carePackageAutoNextAllowedRun = 0;
// The 5s poll and the restart-task onMapDown hook both call
// flushQueuedGeneratorRefills and can overlap; refillBaseGenerators only locks
// existing fuel rows, so an empty generator has nothing to serialize two
// concurrent inserts against without this guard.
let generatorRefillFlushRunning = false;
// Same reasoning as generatorRefillFlushRunning, for the water queue.
let waterRefillFlushRunning = false;
// Same reasoning as generatorRefillFlushRunning, for the pending-delete queue.
let baseDeleteFlushRunning = false;
// Same reasoning as generatorRefillFlushRunning, for the base permission queue.
let baseChildAccessFlushRunning = false;
// Same reasoning as baseDeleteFlushRunning, for the vehicle pending-delete queue.
let vehicleDeleteFlushPromise = null;
let messageOfTheDayAutoRunning = false;
let messageOfTheDayAutoLastRun = 0;
let messageOfTheDayAutoNextAllowedRun = 0;
let playerAnnouncementsAutoRunning = false;
let playerAnnouncementsAutoLastRun = 0;
let playerAnnouncementsAutoNextAllowedRun = 0;
let restartQueueAutoRunning = false;
let restartQueueAutoLastRun = 0;
const journeyTagsData = loadJourneyTagsData();
const memoryBalancer = createMemoryBalancer(config);
const deathPoller = createDeathPoller(config);
const POSTGRES_UNAVAILABLE_MESSAGE = "Postgres is not running or is restarting. Wait for the database service to come back online, then refresh.";
const DEFAULT_ALWAYS_ON_STARTUP_PARALLELISM = 1;
const MAX_ALWAYS_ON_STARTUP_PARALLELISM = 16;
const BACKGROUND_SCAN_FAILURE_BACKOFF_MS = Math.max(30, Number(process.env.ADMIN_BACKGROUND_SCAN_FAILURE_BACKOFF_SECONDS || 60)) * 1000;
const addonJobScheduler = createAddonJobScheduler(config, {
  getDb: () => db,
  mutationLimiter: mutationRateLimiter,
  failureBackoffMs: BACKGROUND_SCAN_FAILURE_BACKOFF_MS
});
const landsraadMilestoneReconciler = createLandsraadMilestoneReconciler(config, { getDb: () => db });
const autoRefillScheduler = createAutoRefillScheduler({
  config,
  getDb: () => db,
  duneDb,
  failureBackoffMs: BACKGROUND_SCAN_FAILURE_BACKOFF_MS
});
const autoRefillWaterScheduler = createAutoRefillWaterScheduler({
  config,
  getDb: () => db,
  duneDb,
  failureBackoffMs: BACKGROUND_SCAN_FAILURE_BACKOFF_MS
});
const playerBanEnforcer = createPlayerBanEnforcer({
  config,
  getDb: () => db,
  duneDb,
  failureBackoffMs: BACKGROUND_SCAN_FAILURE_BACKOFF_MS
});
const scheduledMapMessages = createScheduledMapMessageScheduler(config, {
  deliver: (schedule) => deliverScheduledMapMessage(schedule),
  onResult: ({ schedule, manual, ok, skipped, error, result }) => {
    const target = `${schedule.mapName}.${schedule.dimension}`;
    const command = manual ? "scheduled-map-chat-now" : "scheduled-map-chat";
    const outcome = ok ? "published" : skipped ? "skipped" : "failed";
    audit(config, null, "admin.map-chat-schedule-delivery", { id: schedule.id, target, manual, ok, skipped: Boolean(skipped), recipients: result?.recipients || 0, error: error ? redact(String(error?.message || "Unexpected error.")) : "" });
    recordAdminHistory(config, { command, target, friendly: schedule.name || "Scheduled Map Message", path: "rmq:chat.map", result: outcome, message: schedule.message });
  }
});

process.on("unhandledRejection", (error) => {
  console.error(`Unhandled background rejection: ${redact(error?.message || "Unexpected error.")}`);
});

createServer(async (req, res) => {
  if (config.allowedIps.length) {
    const remoteIp = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    if (!config.allowedIps.includes(remoteIp)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Access denied: IP not in ADMIN_ALLOWED_IPS" }));
      return;
    }
  }
  try {
    if (req.url?.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }
    serveStatic(config, req, res);
  } catch (error) {
    const payload = apiErrorPayload(error);
    json(res, payload.status, payload.body);
  }
}).listen(config.port, config.host, () => {
  console.log(`${config.appName} API listening on http://${config.host}:${config.port}`);
  if (config.host === "0.0.0.0") {
    console.warn("Warning: ADMIN_BIND_HOST is 0.0.0.0 — the Web Console is reachable on all network interfaces.");
    console.warn("Set ADMIN_BIND_HOST to a specific LAN IP and/or set ADMIN_ALLOWED_IPS to restrict access.");
  }
  if (!config.authDisabled) {
    console.log("Initial admin password is stored in runtime/secrets/admin-web-password.txt");
  }
  scheduleBootAutoStart();
  recoverRestartQueue();
  publicDirectory.start();
  if (discordAdapterEnabled(config)) {
    initializeDiscordAdapterSchema(db).catch((error) => {
      console.warn(`Discord adapter schema initialization failed: ${redact(error?.message || "Unexpected error.")}`);
    });
  }
  ensureExchangeHistory(db).catch((error) => {
    console.warn(`Market transaction recorder initialization failed: ${redact(error?.message || "Unexpected error.")}`);
  });
  migrateCoriolisRegionFields().catch((error) => {
    console.warn(`Coriolis cycle start region migration deferred: ${redact(error?.message || "Unexpected error.")}`);
  });
  runBackgroundTick("Player playtime tracker", () => duneDb.trackPlayerPlaytime(db));
});

// Reconcile periodically because a Funcom database migration can recreate the
// fulfilled-orders table and thereby remove third-party triggers. The service
// caches successful checks for five minutes, and capture failures themselves
// are isolated inside PostgreSQL so they can never reject a game transaction.
setInterval(() => {
  runBackgroundTick("Market transaction recorder", () => ensureExchangeHistory(db));
}, 5 * 60_000).unref?.();

setInterval(() => {
  runBackgroundTick("Player ban enforcement", () => playerBanEnforcer.tick());
  runBackgroundTick("Player playtime tracker", () => duneDb.trackPlayerPlaytime(db));
  runBackgroundTick("Care Package auto-grant", carePackageAutoTick);
  runBackgroundTick("Message of the Day", messageOfTheDayAutoTick);
  runBackgroundTick("Player announcements", playerAnnouncementsAutoTick);
  runBackgroundTick("Addon scheduled jobs", () => addonJobScheduler.tick());
  runBackgroundTick("Scheduled map messages", () => scheduledMapMessages.tick());
  runBackgroundTick("Landsraad milestone preset", () => landsraadMilestoneReconciler.tick());
  // Daily, but gated inside the tick like every other long-period job here.
  // Costs one small file read when no base is enrolled, and no database query.
  runBackgroundTick("Bases auto-refill", () => autoRefillScheduler.tick());
  runBackgroundTick("Bases water auto-refill", () => autoRefillWaterScheduler.tick());
  runBackgroundTick("Restart queue", restartQueueAutoTick);
}, 10000).unref?.();

setInterval(() => {
  if (!memoryBalancer.publicState().enabled) return;
  runBackgroundTick("Memory balancer", () => memoryBalancer.tick());
}, memoryBalancer.intervalMs).unref?.();

setInterval(() => {
  if (deathPoller.enabled && deathPoller.tick) runBackgroundTick("Death poller", () => deathPoller.tick());
}, deathPoller.intervalMs).unref?.();

if (deathPoller.enabled) deathPoller.init(db, config.repoRoot).catch(() => {});

// Queued generator refills apply while their map is down. This polls instead of
// hooking the restart tasks because stop-all.sh removes the Postgres container
// alongside the game servers, so there is no post-stop moment when the console
// could still write: the window it waits for is a reachable database with no
// live server on that partition, which start-all.sh opens well before the map
// servers boot. Polling also covers restarts the console never initiated
// (scheduler, IP change, CLI). Idle cost is one small file read per tick.
const generatorRefillFlushIntervalMs = Number(process.env.ADMIN_REFILL_FLUSH_INTERVAL_MS);
setInterval(() => {
  // Two independent checks in the same tick rather than two setIntervals: an
  // idle queue costs one more cheap file read, not a new timer. Each queue's
  // check must stand alone -- an early return keyed on one queue's length
  // would silently skip the other whenever only it had pending entries.
  if (duneDb.listQueuedGeneratorRefills(config.repoRoot).length) {
    runBackgroundTick("Generator refill flush", () => flushQueuedGeneratorRefills());
  }
  if (duneDb.listQueuedWaterRefills(config.repoRoot).length) {
    runBackgroundTick("Water refill flush", () => flushQueuedWaterRefills());
  }
  if (duneDb.listQueuedBaseDeletes(config.repoRoot).length) {
    runBackgroundTick("Base delete flush", () => flushQueuedBaseDeletes());
  }
  // Size check, not a full parse: this queue carries a payload and can sit
  // waiting for days -- see hasQueuedBaseChildAccess.
  if (duneDb.hasQueuedBaseChildAccess(config.repoRoot)) {
    runBackgroundTick("Base permission flush", () => flushQueuedBaseChildAccess());
  }
  if (duneDb.listQueuedVehicleDeletes(config.repoRoot).length) {
    runBackgroundTick("Vehicle delete flush", () => flushQueuedVehicleDeletes());
  }
}, Number.isFinite(generatorRefillFlushIntervalMs) && generatorRefillFlushIntervalMs > 0 ? generatorRefillFlushIntervalMs : 5000).unref?.();

// Every queued-refill write goes through here so it is audited whichever path
// triggered it: the tick above, or the restart task runner's onMapDown hook.
// These are real writes to player property, so an unaudited one is not acceptable.
async function flushQueuedGeneratorRefills() {
  if (generatorRefillFlushRunning) return { flushed: [] };
  generatorRefillFlushRunning = true;
  try {
    const result = await duneDb.flushGeneratorRefills(db, config.repoRoot);
    for (const entry of result.flushed || []) audit(config, null, "bases.flush-queued-refill", entry);
    return result;
  } finally {
    generatorRefillFlushRunning = false;
  }
}

// Same reasoning as flushQueuedGeneratorRefills, for the water queue.
async function flushQueuedWaterRefills() {
  if (waterRefillFlushRunning) return { flushed: [] };
  waterRefillFlushRunning = true;
  try {
    const result = await duneDb.flushWaterRefills(db, config.repoRoot);
    for (const entry of result.flushed || []) audit(config, null, "bases.flush-queued-water-refill", entry);
    return result;
  } finally {
    waterRefillFlushRunning = false;
  }
}

// Same reasoning as flushQueuedGeneratorRefills, for the base permission
// queue. These change who can open a player's doors, so an unaudited apply is
// not acceptable either.
async function flushQueuedBaseChildAccess() {
  if (baseChildAccessFlushRunning) return { flushed: [] };
  baseChildAccessFlushRunning = true;
  try {
    const result = await duneDb.flushBaseChildAccess(db, config.repoRoot);
    for (const entry of result.flushed || []) audit(config, null, "bases.flush-queued-child-access", entry);
    return result;
  } finally {
    baseChildAccessFlushRunning = false;
  }
}

// Same guard reasoning as flushQueuedGeneratorRefills. The one full-database
// safety backup for this pass happens inside flushBaseDeletes's onBeforeApply
// hook -- lazily, at most once, immediately before the first entry that is
// actually about to be deleted, not merely because the queue is non-empty.
async function flushQueuedBaseDeletes() {
  if (baseDeleteFlushRunning) return { flushed: [] };
  baseDeleteFlushRunning = true;
  try {
    const result = await duneDb.flushBaseDeletes(db, config.repoRoot, {
      // Matches databaseQuery's explicit mock-mode guard: this runs as a
      // background tick, not through directDbMutation, so it is not skipped
      // for free the way a request-time delete's backup call is.
      onBeforeApply: config.mockMode
        ? undefined
        : () => runDune(config, buildDuneArgs("backupCreate"), { env: { DB_BACKUP_ORIGIN: "base-delete" } })
    });
    for (const entry of result.flushed || []) audit(config, null, "bases.flush-queued-delete", entry);
    if (result.backupFailed) {
      audit(config, null, "bases.flush-queued-delete-backup-failed", { error: result.error, pending: result.pending });
    }
    return result;
  } finally {
    baseDeleteFlushRunning = false;
  }
}

// Same guard reasoning as flushQueuedBaseDeletes, for the vehicle queue.
async function flushQueuedVehicleDeletes({ forceFresh = false, allowBlockedStates = false } = {}) {
  if (vehicleDeleteFlushPromise) {
    const inFlight = await vehicleDeleteFlushPromise;
    if (!forceFresh) return inFlight;
  }
  const current = (async () => {
    const result = await duneDb.flushVehicleDeletes(db, config.repoRoot, {
      allowBlockedStates,
      onBeforeApply: config.mockMode
        ? undefined
        : () => runDune(config, buildDuneArgs("backupCreate"), { env: { DB_BACKUP_ORIGIN: "vehicle-delete" } })
    });
    for (const entry of result.flushed || []) audit(config, null, "vehicles.flush-queued-delete", entry);
    if (result.backupFailed) {
      audit(config, null, "vehicles.flush-queued-delete-backup-failed", { error: result.error, pending: result.pending });
    }
    return result;
  })();
  vehicleDeleteFlushPromise = current;
  try {
    return await current;
  } finally {
    if (vehicleDeleteFlushPromise === current) vehicleDeleteFlushPromise = null;
  }
}

function runBackgroundTick(label, fn) {
  Promise.resolve()
    .then(fn)
    .catch((error) => {
      const message = String(error?.message || "Unexpected error.");
      if (/connect|database|relation|container|rabbitmq|docker|ECONNREFUSED|ECONNRESET|Connection terminated/i.test(message)) return;
      console.error(`${label} background task failed: ${redact(message)}`);
    });
}

function scheduleBootAutoStart() {
  if (config.mockMode || process.env.ADMIN_AUTO_START_STACK_ON_BOOT === "0") return;
  setTimeout(() => {
    void maybeAutoStartStackOnBoot();
  }, 5000).unref?.();
}

function loadJourneyTagsData() {
  try {
    return JSON.parse(readFileSync(join(config.repoRoot, "runtime", "data", "journey-tags.json"), "utf8"));
  } catch {
    return { journey_node_tags: {} };
  }
}

async function maybeAutoStartStackOnBoot() {
  if (!isSetupComplete()) {
    console.log("Boot auto-start skipped because first-time setup is not complete.");
    return;
  }
  const mainContainers = [
    "dune-postgres",
    "dune-rmq-admin",
    "dune-rmq-game",
    "dune-text-router",
    "dune-director",
    "dune-server-gateway",
    "dune-server-survival-1",
    "dune-server-overmap"
  ];
  const names = await dockerPsNames().catch((error) => {
    console.error(`Boot auto-start skipped: ${redact(error?.message || "Unexpected error.")}`);
    return [];
  });
  if (mainContainers.some((name) => names.includes(name))) return;

  const child = spawn("runtime/scripts/start-all.sh", [], {
    cwd: config.repoRoot,
    shell: false,
    detached: true,
    env: { ...process.env }
  });
  child.stdout.on("data", (chunk) => process.stdout.write(`[boot-autostart] ${redact(chunk.toString())}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[boot-autostart] ${redact(chunk.toString())}`));
  child.on("error", (error) => console.error(`Boot auto-start failed: ${redact(error?.message || "Unexpected error.")}`));
  child.on("close", (code) => {
    if (code === 0) console.log("Boot auto-start completed.");
    else if (code === 2) console.log("Boot auto-start skipped because manual stop is active for this Linux boot.");
    else console.error(`Boot auto-start exited with code ${code}.`);
  });
}

function isSetupComplete() {
  return existsSync(resolve(config.repoRoot, ".env"))
    && existsSync(resolve(config.secretsDir, "funcom-token.txt"))
    && existsSync(resolve(config.generatedDir, "battlegroup.env"));
}

async function isInitializedStackPresent() {
  if (isSetupComplete()) return true;
  if (
    existsSync(resolve(config.generatedDir, "image-tags.env")) ||
    existsSync(resolve(config.generatedDir, "server-catalog.json")) ||
    existsSync(resolve(config.generatedDir, "partition-catalog.json"))
  ) return true;
  try {
    const names = await dockerPsNames();
    return names.some((name) => [
      "dune-postgres",
      "dune-rmq-admin",
      "dune-rmq-game",
      "dune-text-router",
      "dune-director",
      "dune-server-gateway",
      "dune-server-survival-1",
      "dune-server-overmap",
      "dune-orchestrator"
    ].includes(name));
  } catch {
    return false;
  }
}

function dockerPsNames() {
  return new Promise((resolveNames, rejectNames) => {
    const child = spawn("docker", ["ps", "--format", "{{.Names}}"], { cwd: config.repoRoot, shell: false });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), 10000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectNames);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        rejectNames(new Error(stderr.trim() || `docker ps failed with exit ${code}`));
        return;
      }
      resolveNames(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    });
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  if (path === "/api/health") return json(res, 200, { ok: true, app: config.appName });
  if (path === "/api/auth/state") {
    const session = auth.readSession(req);
    return json(res, 200, { authenticated: Boolean(session), csrfToken: session?.csrf || null, config: publicConfig(config) });
  }
  if (path === "/api/auth/login" && req.method === "POST") {
    const rateKey = loginRateLimitKey(req);
    const rate = loginRateLimiter.check(rateKey);
    if (!rate.allowed) {
      return json(res, 429, { error: "Too many sign-in attempts. Please wait a few minutes, then try again." }, { "retry-after": String(rate.retryAfterSeconds) });
    }
    const body = await readJson(req);
    if (!config.authDisabled && !auth.passwordMatches(body.password)) {
      loginRateLimiter.recordFailure(rateKey);
      return json(res, 401, { error: "Incorrect password. Please try again!" });
    }
    loginRateLimiter.recordSuccess(rateKey);
    const session = auth.makeSession();
    setSessionCookie(res, session, config);
    audit(config, req, "auth.login");
    return json(res, 200, { authenticated: true, csrfToken: session.csrf });
  }
  if (path === "/api/auth/logout" && req.method === "POST") {
    const session = auth.requireAuth(req, res);
    if (!session) return;
    clearSessionCookie(res, config);
    audit(config, req, "auth.logout");
    return json(res, 200, { ok: true });
  }
  if (isDiscordAdapterRoute(path)) {
    return handleDiscordAdapterRoute({ req, res, path, config, readJson, json, db });
  }

  // Runs BEFORE requireAuth: that couples session lookup with a CSRF check,
  // and CSRF does not apply to bearer auth. Returns null when there is no
  // bearer header so cookie requests fall through untouched; an invalid one
  // returns 401 rather than falling through, which would let a stale key ride
  // a logged-in session.
  const bearer = apiKeys.authenticate(req);
  if (bearer?.error) {
    // Rate-limited and audited by client address, mirroring /api/auth/login.
    // Brute-forcing a 256-bit secret is infeasible, but a failed credential
    // used to produce no signal at all -- nothing to alert on, nothing to see
    // afterwards. The limiter is keyed by address because a refused request
    // has no key id to attribute it to.
    // Its OWN limiter, not the per-key one: failures come from unauthenticated
    // clients, so counting them in the shared bucket let anyone with a bogus
    // header drain the ceiling and 429 every legitimate key -- reintroducing
    // the starvation the global-ceiling fix closed, from in front of the door.
    const failureKey = `apikey-auth:${remoteIpOf(req) || "unknown"}`;
    const failureRate = apiKeyAuthFailureLimiter.record(failureKey, API_KEY_AUTH_FAILURES_PER_MINUTE);
    if (!failureRate.allowed) {
      // audit() is a synchronous mkdirSync + appendFileSync carrying req.url, so a
      // row per attempt is an unbounded write for anyone who can reach the port.
      if (shouldNoteApiKeyAuthThrottle(failureKey)) {
        audit(config, req, "auth.api-key-failed", { reason: bearer.error, throttled: true, afterFailures: API_KEY_AUTH_FAILURES_PER_MINUTE });
      }
      return json(res, 429, { error: "Too many failed API key attempts. Try again shortly." }, { "retry-after": String(failureRate.retryAfterSeconds) });
    }
    audit(config, req, "auth.api-key-failed", { reason: bearer.error });
    return json(res, bearer.status, { error: bearer.error });
  }
  if (bearer) {
    const rate = apiKeyRateLimiter.record(bearer.key.id, bearer.key.rateLimitPerMinute);
    if (!rate.allowed) {
      return json(res, 429, { error: "This API key has exceeded its request limit. Try again shortly." }, { "retry-after": String(rate.retryAfterSeconds) });
    }
  }

  const session = bearer?.session || auth.requireAuth(req, res);
  if (!session) return;
  req.authSession = session;

  const action = actionForRoute(path, req.method);
  if (!action || !evaluate(session, action)) {
    return json(res, 403, { error: "Your account does not have permission to access this resource." });
  }
  // The key's own scope grid, applied on top of the policy engine. This is the
  // check that actually constrains a key (see the tier comment in apiKeys.js).
  // settings:* and database:* are denied inside allows(), so a key can never
  // reach the routes below that mint, list or revoke keys.
  if (bearer) {
    if (!apiKeys.allows(bearer.key, action)) {
      return json(res, 403, { error: "This API key is not permitted to use this endpoint." });
    }
    apiKeys.recordUse(bearer.key.id, remoteIpOf(req));
  }

  if (path === "/api/setup/state") return json(res, 200, await setupState());
  if (path === "/api/setup/preflight" && req.method === "POST") return json(res, 200, await preflight(config));
  if (path === "/api/setup/write-config" && req.method === "POST") return writeConfig(req, res);
  if (path === "/api/setup/save-token" && req.method === "POST") return saveToken(req, res);
  if (path === "/api/setup/init" && req.method === "POST") return task(req, res, "setup", "init", {});
  if (path === "/api/setup/tasks") return json(res, 200, { tasks: tasks.list().map(publicTask) });
  if (path === "/api/public-directory/status") return json(res, 200, publicDirectory.publicState());
  if (path.startsWith("/api/setup/tasks/")) return taskRoute(req, res, path);

  if (path === "/api/server/status") return cachedCommandJson(res, "status", url);
  if (path === "/api/server/performance") return json(res, 200, await collectPerformanceSnapshot(config.repoRoot));
  if (path === "/api/server/readiness") return cachedCommandJson(res, "readiness", url);
  if (path === "/api/server/ports") return commandJson(res, "ports");
  if (path === "/api/server/services") return commandJson(res, "services");
  if (path === "/api/server/doctor") return safeCommandJson(res, "doctor");
  if (path === "/api/server/network-bind/fix" && req.method === "POST") return task(req, res, "server", "networkBindFix", {});
  if (path === "/api/server/storage/cleanup-images" && req.method === "POST") {
    return confirmedTask(req, res, "storage", "storageCleanupImages", {}, "CLEAN OBSOLETE DUNE IMAGES");
  }
  if (path === "/api/server/storage/cleanup-build-cache" && req.method === "POST") {
    return confirmedTask(req, res, "storage", "storageCleanupBuildCache", {}, "CLEAN DOCKER BUILD CACHE");
  }
  if (path === "/api/server/start" && req.method === "POST") return task(req, res, "server", "start", {});
  if (path === "/api/server/stop" && req.method === "POST") return task(req, res, "server", "stop", {});
  if (path === "/api/server/restart" && req.method === "POST") return task(req, res, "server", "restartAll", {});
  if (path === "/api/server/restart-service" && req.method === "POST") {
    const body = await readJson(req);
    return task(req, res, "server", "restartService", { service: body.service });
  }
  if (path === "/api/server/funcom-token" && req.method === "POST") return saveServerFuncomToken(req, res);
  if (path === "/api/server/funcom-token/check") return funcomTokenCheckRoute(req, res, url);
  if (path === "/api/server/title" && req.method === "POST") {
    const body = await readJson(req);
    return task(req, res, "server", "serverTitle", { title: body.title });
  }
  if (path === "/api/server/config" && req.method === "POST") {
    const body = await readJson(req);
    const payload = {};
    if (body.title !== undefined) payload.title = body.title;
    if (body.mode !== undefined) payload.mode = body.mode;
    return task(req, res, "server", "serverConfig", payload);
  }
  if (path === "/api/server/restart-queue/cancel" && req.method === "POST") return restartQueueCancelRoute(req, res);
  if (path === "/api/server/restart-queue/restart-now" && req.method === "POST") return restartQueueRestartNowRoute(req, res);
  if (path === "/api/server/restart-queue" && req.method === "POST") return restartQueueSaveRoute(req, res);
  if (path === "/api/server/restart-queue") return restartQueueStatusRoute(req, res, url);
  if (path === "/api/server/restart-schedule" && req.method === "POST") return restartScheduleRoute(req, res);
  if (path === "/api/server/restart-schedule") return safeCommandJson(res, "restartScheduleStatus");
  if (path === "/api/server/ip-change-restart" && req.method === "POST") return ipChangeRestartRoute(req, res);
  if (path === "/api/server/ip-change-restart/check" && req.method === "POST") return task(req, res, "server", "ipChangeRestartCheckNow", {});
  if (path === "/api/server/ip-change-restart") return safeCommandJson(res, "ipChangeRestartStatus");
  if (path === "/api/server/shutdown-protection" && req.method === "POST") return shutdownProtectionRoute(req, res);
  if (path === "/api/server/shutdown-protection/remove" && req.method === "POST") return task(req, res, "server", "shutdownProtectionRemove", {});
  if (path === "/api/server/shutdown-protection") return safeCommandJson(res, "shutdownProtectionStatus");

  if (path === "/api/logs/services") return json(res, 200, { services: await discoverServices(config) });
  if (path.startsWith("/api/logs/")) return logsRoute(req, res, path);

  if (path === "/api/updates/check-game" && req.method === "POST") {
    const body = await readJson(req);
    // `fresh` bypasses the dedupe cache and spawns a real subprocess every
    // call. updates:check is reachable at READ level, so an API key could hold
    // it -- keys are pinned to the cached path, leaving the forced refresh to
    // the browser session that is actually sitting in front of the console.
    const fresh = body.fresh === true && !req.authSession?.apiKeyId;
    return task(req, res, "updates", "updateCheck", { fresh });
  }
  if (path === "/api/updates/apply-game" && req.method === "POST") return task(req, res, "updates", "updateApply", {});
  if (path === "/api/updates/fix-steamcmd" && req.method === "POST") return task(req, res, "updates", "updateFixSteamcmd", {});
  if (path === "/api/updates/check-stack" && req.method === "POST") return task(req, res, "updates", "selfUpdateCheck", {});
  if (path === "/api/updates/apply-stack" && req.method === "POST") return task(req, res, "updates", "selfUpdateApply", {});
  if (path === "/api/updates/qa/status") {
    try { return json(res, 200, await qaUpdates.status(req.authSession.id, { refresh: url.searchParams.get("refresh") === "1" })); }
    catch (error) { return json(res, error?.statusCode || 502, { error: redact(error?.message || "QA authorization could not be checked.") }); }
  }
  if (path === "/api/updates/qa/login" && req.method === "POST") {
    try {
      const result = await qaUpdates.start(req.authSession.id);
      audit(config, req, "updates.qa-login-started", { requestId: result.requestId });
      return json(res, 200, result);
    } catch (error) { return json(res, error?.statusCode || 502, { error: redact(error?.message || "QA authorization could not be started.") }); }
  }
  if (path === "/api/updates/qa/logout" && req.method === "POST") {
    await qaUpdates.logout(req.authSession.id);
    audit(config, req, "updates.qa-logout");
    return json(res, 200, { ok: true });
  }
  if (path === "/api/updates/qa/build") {
    try { return json(res, 200, await qaUpdates.build(req.authSession.id)); }
    catch (error) { return json(res, error?.statusCode || 502, { error: redact(error?.message || "The latest QA build could not be checked.") }); }
  }
  if (path === "/api/updates/qa/apply" && req.method === "POST") {
    try {
      const build = await qaUpdates.build(req.authSession.id);
      if (!build.ready) return json(res, 409, { error: build.reason || "The latest QA build has not passed all checks." });
      if (!build.updateAvailable) return json(res, 409, { error: "This Console already has the latest QA build." });
      audit(config, req, "updates.qa-apply", { commitSha: build.sha });
      return task(req, res, "updates", "selfUpdateQaApply", { sha: build.sha });
    } catch (error) { return json(res, error?.statusCode || 502, { error: redact(error?.message || "The QA build could not be applied.") }); }
  }
  if (path === "/api/updates/qa/reinstall-release" && req.method === "POST") {
    try {
      await qaUpdates.requireAuthorized(req.authSession.id);
      audit(config, req, "updates.qa-reinstall-release");
      return task(req, res, "updates", "selfUpdateApply", {});
    } catch (error) { return json(res, error?.statusCode || 502, { error: redact(error?.message || "The public release could not be reinstalled.") }); }
  }
  if (path === "/api/updates/stack-progress") {
    try {
      const taskStartedAt = url.searchParams.get("startedAt");
      const progress = readSelfUpdateStatus(config.repoRoot, url.searchParams.get("runId"), {
        taskStartedAt,
        consoleStartedAt: CONSOLE_PROCESS_STARTED_AT
      });
      const taskStartedAtMs = Date.parse(String(taskStartedAt || progress.startedAt || ""));
      return json(res, 200, {
        ...progress,
        consoleStartedAt: new Date(CONSOLE_PROCESS_STARTED_AT).toISOString(),
        consoleReplaced: Number.isFinite(taskStartedAtMs) && CONSOLE_PROCESS_STARTED_AT > taskStartedAtMs + 1000
      });
    } catch (error) {
      return json(res, error?.code === "INVALID_RUN_ID" ? 400 : 500, { error: redact(error?.message || "Could not read console update status.") });
    }
  }
  if (path === "/api/updates/auto-game" && req.method === "POST") return autoGameUpdateRoute(req, res);
  if (path === "/api/updates/auto-game") return safeCommandJson(res, "updateAutoStatus");
  if (path === "/api/updates/repair-runtime" && req.method === "POST") return task(req, res, "updates", "readiness", {});

  if (path === "/api/backups") return backupsListRoute(res);
  if (path === "/api/backups/auto" && req.method === "POST") return autoBackupRoute(req, res);
  if (path === "/api/backups/import-external" && req.method === "POST") return externalBackupImportRoute(req, res);
  if (path === "/api/backups/auto") return backupAutoStatusRoute(res);
  if (path === "/api/backups/create" && req.method === "POST") return task(req, res, "backup", "backupCreate", {});
  if (path === "/api/backups/delete-all" && req.method === "POST") return task(req, res, "backup", "backupDeleteAll", {});
  if (path === "/api/backups/delete-selected" && req.method === "POST") {
    const body = await readJson(req);
    return task(req, res, "backup", "backupDeleteSelected", { backups: body.backups });
  }
  if (path === "/api/backups/restore" && req.method === "POST") {
    const body = await readJson(req);
    return task(req, res, "backup", "backupRestore", { backup: body.backup, identityMode: body.identityMode });
  }
  if (path.match(/^\/api\/backups\/[^/]+\/download$/) && req.method === "GET") {
    const backup = decodeURIComponent(path.split("/").at(-2));
    return backupDownloadRoute(req, res, backup);
  }
  if (path.startsWith("/api/backups/") && req.method === "DELETE") {
    const backup = decodeURIComponent(path.split("/").pop());
    return task(req, res, "backup", "backupDelete", { backup });
  }
  if (path === "/api/database/status") return dbJson(res, () => duneDb.dbStatus(db));
  if (path === "/api/database/schemas") return dbJson(res, () => duneDb.listSchemas(db));
  if (path === "/api/database/routines") return dbJson(res, () => duneDb.listRoutines(db, url.searchParams.get("schema") || "dune", url.searchParams.get("q") || ""));
  if (path.match(/^\/api\/database\/routines\/[^/]+$/)) return dbJson(res, () => duneDb.routineDefinition(db, decodeURIComponent(path.split("/").pop())));
  if (path === "/api/database/tables") return dbJson(res, () => duneDb.listTables(db, url.searchParams.get("schema") || "dune"));
  if (path.match(/^\/api\/database\/tables\/[^/]+\/[^/]+\/columns$/)) return databaseTableRoute(req, res, path, "columns", url);
  if (path.match(/^\/api\/database\/tables\/[^/]+\/[^/]+\/preview$/)) return databaseTableRoute(req, res, path, "preview", url);
  if (path.match(/^\/api\/database\/tables\/[^/]+\/[^/]+\/count$/)) return databaseTableRoute(req, res, path, "count", url);
  if (path.match(/^\/api\/database\/tables\/[^/]+\/[^/]+\/row$/) && req.method === "PATCH") return databaseRowUpdate(req, res, path);
  if (path === "/api/database/search") return dbJson(res, () => duneDb.searchDatabase(db, url.searchParams.get("q") || url.searchParams.get("term") || ""));
  if (path.startsWith("/api/database/table/")) return dbJson(res, () => {
    const [schema, table] = decodeURIComponent(path.split("/").pop()).split(".");
    return duneDb.tablePreview(db, schema, table, url.searchParams.get("limit") || 50, url.searchParams.get("offset") || 0);
  });
  if (path === "/api/database/query" && req.method === "POST") return databaseQuery(req, res);
  if (path === "/api/database/export" && req.method === "POST") return databaseExport(req, res);
  if (path === "/api/database/password" && req.method === "POST") return databasePasswordRoute(req, res);
  if (path === "/api/settings/admin-password" && req.method === "POST") return adminPasswordRoute(req, res);
  if (path === "/api/settings/web-port" && req.method === "POST") return webPortRoute(req, res);
  if (path === "/api/settings/iam/policies" && req.method === "GET") {
    return json(res, 200, { policies: getAllPolicies() });
  }
  if (path === "/api/settings/iam/policy" && req.method === "PUT") {
    const body = await readJson(req);
    const result = setPolicies(body, config.repoRoot);
    if (!result.ok) return json(res, 400, result);
    audit(config, req, "iam.policy-set", { tiers: Object.keys(body) });
    return json(res, 200, result);
  }
  if (path === "/api/settings/api-keys/catalog" && req.method === "GET") {
    return json(res, 200, { namespaces: scopeCatalog() });
  }
  if (path === "/api/settings/api-keys" && req.method === "GET") {
    return json(res, 200, { keys: apiKeys.list() });
  }
  if (path === "/api/settings/api-keys" && req.method === "POST") return apiKeyCreateRoute(req, res);
  if (path.startsWith("/api/settings/api-keys/")) return apiKeyItemRoute(req, res, path);
  if (path === "/api/settings/iam/policy/test" && req.method === "POST") {
    const body = await readJson(req);
    const testAction = String(body?.action || "").trim();
    const testTier = String(body?.tier || "").trim();
    if (!testAction || !testTier) return json(res, 400, { error: "Both action and tier are required." });
    return json(res, 200, { action: testAction, tier: testTier, allowed: evaluate({ tier: testTier }, testAction) });
  }

  if (path === "/api/players") return dbJson(res, () => duneDb.listPlayers(db, {
    q: url.searchParams.get("q") || "",
    page: url.searchParams.get("page") || 0,
    pageSize: url.searchParams.get("pageSize") || 50,
    status: url.searchParams.get("status") || "all",
    sortColumn: url.searchParams.get("sortColumn") || "character_name",
    sortDirection: url.searchParams.get("sortDirection") || "asc",
    bannedFlsIds: bannedFlsIds(config.repoRoot)
  }));
  if (path === "/api/players/online") return dbJson(res, () => duneDb.listPlayers(db, {
    status: "online",
    page: url.searchParams.get("page") || 0,
    pageSize: url.searchParams.get("pageSize") || 200,
    bannedFlsIds: bannedFlsIds(config.repoRoot)
  }));
  if (path === "/api/players/search") return dbJson(res, () => duneDb.listPlayers(db, { q: url.searchParams.get("q") || "", bannedFlsIds: bannedFlsIds(config.repoRoot) }));
  if (path === "/api/guilds") return dbJson(res, () => duneDb.listGuilds(db, {
    q: url.searchParams.get("q") || "",
    page: url.searchParams.get("page") || 0,
    pageSize: url.searchParams.get("pageSize") || 50,
    sortColumn: url.searchParams.get("sortColumn") || "guild_name",
    sortDirection: url.searchParams.get("sortDirection") || "asc"
  }));
  if (path.match(/^\/api\/guilds\/[^/]+\/members\/[^/]+\/promote$/) && req.method === "POST") return guildPromoteRoute(req, res, path);
  if (path.match(/^\/api\/guilds\/[^/]+\/members\/[^/]+\/demote$/) && req.method === "POST") return guildDemoteRoute(req, res, path);
  if (path.match(/^\/api\/guilds\/[^/]+\/members$/) && req.method === "POST") return guildAddMemberRoute(req, res, path);
  if (path.match(/^\/api\/guilds\/[^/]+\/members\/[^/]+$/) && req.method === "DELETE") return guildRemoveMemberRoute(req, res, path);
  if (path.match(/^\/api\/guilds\/[^/]+$/) && req.method === "DELETE") return guildDisbandRoute(req, res, path);
  if (path.match(/^\/api\/guilds\/[^/]+\/members$/)) return dbJson(res, () => duneDb.guildMembers(db, decodeURIComponent(path.split("/")[3])));
  if (path === "/api/bases") return dbJson(res, () => duneDb.listBases(db, {
    q: url.searchParams.get("q") || "",
    page: url.searchParams.get("page") || 0,
    pageSize: url.searchParams.get("pageSize") || 50,
    sortColumn: url.searchParams.get("sortColumn") || "name",
    sortDirection: url.searchParams.get("sortDirection") || "asc"
  }));
  if (path === "/api/bases/pending-refills") return pendingGeneratorRefillsRoute(res);
  if (path === "/api/bases/auto-refill") return basesAutoRefillStateRoute(res);
  if (path === "/api/bases/pending-water-refills") return pendingWaterRefillsRoute(res);
  if (path === "/api/bases/auto-refill-water") return basesAutoRefillWaterStateRoute(res);
  if (path === "/api/bases/pending-deletes") return pendingBaseDeletesRoute(res);
  if (path === "/api/bases/pending-child-access") return pendingChildAccessRoute(res);
  if (path.match(/^\/api\/bases\/[^/]+\/export$/) && req.method === "GET") return baseBlueprintDownloadRoute(req, res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/refill-generators$/) && req.method === "POST") return baseRefillGeneratorsRoute(req, res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/queued-refill$/) && req.method === "DELETE") return baseCancelQueuedRefillRoute(req, res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/auto-refill$/) && req.method === "POST") return baseAutoRefillToggleRoute(req, res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/water$/) && req.method === "GET") return baseWaterRoute(res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/inventory$/) && req.method === "GET") return baseInventoryRoute(res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/containers\/[^/]+$/) && req.method === "GET") return baseContainerSlotsRoute(res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/containers\/[^/]+\/items\/[^/]+$/) && req.method === "DELETE") return baseContainerItemDeleteRoute(req, res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/containers\/[^/]+\/items$/) && req.method === "POST") return baseContainerItemAddRoute(req, res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/containers\/[^/]+\/items$/) && req.method === "DELETE") return baseContainerItemsDeleteRoute(req, res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/containers\/[^/]+\/all-items$/) && req.method === "DELETE") return baseContainerAllItemsDeleteRoute(req, res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/containers\/[^/]+\/give-item$/) && req.method === "POST") return baseContainerGiveItemRoute(req, res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/containers\/[^/]+\/give-items$/) && req.method === "POST") return baseContainerGiveItemsRoute(req, res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/containers\/[^/]+\/fill-item$/) && req.method === "POST") return baseContainerFillItemRoute(req, res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/refill-water$/) && req.method === "POST") return baseRefillWaterRoute(req, res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/queued-water-refill$/) && req.method === "DELETE") return baseCancelQueuedWaterRefillRoute(req, res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/auto-refill-water$/) && req.method === "POST") return baseAutoRefillWaterToggleRoute(req, res, path);
  if (path === "/api/bases/permission-candidates") return basePermissionCandidatesRoute(res, url);
  if (path.match(/^\/api\/bases\/[^/]+\/land-claim$/) && req.method === "GET") return baseLandClaimRoute(res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/land-claim$/) && req.method === "PUT") return baseUpdateLandClaimRoute(req, res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/permissions$/) && req.method === "GET") return basePermissionsRoute(res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/permissions$/) && req.method === "PUT") return baseSetPermissionsRoute(req, res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/child-access$/) && req.method === "GET") return baseChildAccessRoute(res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/child-access$/) && req.method === "POST") return baseSetChildAccessRoute(req, res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/queued-child-access$/) && req.method === "DELETE") return baseCancelQueuedChildAccessRoute(req, res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/system-custodian$/) && req.method === "POST") return baseSystemCustodianRoute(req, res, path);
  if (path.match(/^\/api\/bases\/[^/]+\/queued-delete$/) && req.method === "DELETE") return baseCancelQueuedDeleteRoute(req, res, path);
  if (path.match(/^\/api\/bases\/[^/]+$/) && req.method === "DELETE") return baseDeleteRoute(req, res, path);
  if (path === "/api/vehicles") return dbJson(res, () => duneDb.listVehicles(db, {
    q: url.searchParams.get("q") || "",
    page: url.searchParams.get("page") || 0,
    pageSize: url.searchParams.get("pageSize") || 50,
    sortColumn: url.searchParams.get("sortColumn") || "name",
    sortDirection: url.searchParams.get("sortDirection") || "asc"
  }));
  if (path === "/api/vehicles/pending-deletes") return pendingVehicleDeletesRoute(res);
  if (path === "/api/vehicles/permission-candidates") return vehiclePermissionCandidatesRoute(res, url);
  if (path.match(/^\/api\/vehicles\/[^/]+\/permissions$/) && req.method === "GET") return vehiclePermissionsRoute(res, path);
  if (path.match(/^\/api\/vehicles\/[^/]+\/permissions$/) && req.method === "PUT") return vehicleSetPermissionsRoute(req, res, path);
  if (path.match(/^\/api\/vehicles\/[^/]+\/system-custodian$/) && req.method === "POST") return vehicleSystemCustodianRoute(req, res, path);
  if (path.match(/^\/api\/vehicles\/[^/]+\/storage$/) && req.method === "GET") return vehicleStorageRoute(res, path);
  if (path.match(/^\/api\/vehicles\/[^/]+\/storage\/items\/[^/]+$/) && req.method === "DELETE") return vehicleStorageItemDeleteRoute(req, res, path);
  if (path.match(/^\/api\/vehicles\/[^/]+\/storage\/items$/) && req.method === "DELETE") return vehicleStorageItemsDeleteRoute(req, res, path);
  if (path.match(/^\/api\/vehicles\/[^/]+\/storage\/all-items$/) && req.method === "DELETE") return vehicleStorageAllItemsDeleteRoute(req, res, path);
  if (path.match(/^\/api\/vehicles\/[^/]+\/queued-delete$/) && req.method === "DELETE") return vehicleCancelQueuedDeleteRoute(req, res, path);
  if (path.match(/^\/api\/vehicles\/[^/]+$/) && req.method === "DELETE") return vehicleDeleteRoute(req, res, path);
  if (path === "/api/admin/items/catalog") return json(res, 200, { rows: listCatalogItems(config.repoRoot, { q: url.searchParams.get("q") || "", limit: url.searchParams.get("limit") || 500 }) });
  if (path === "/api/admin/items/search") return commandJson(res, "adminItemSearch", { q: url.searchParams.get("q") || "" });
  if (path === "/api/admin/items") return commandJson(res, url.searchParams.get("category") ? "adminItemListCategory" : "adminItemList", { category: url.searchParams.get("category") || "" });
  if (path === "/api/admin/vehicles/structured") return structuredVehiclesRoute(res);
  if (path === "/api/admin/vehicles") return commandJson(res, url.searchParams.get("q") ? "adminVehicleSearch" : "adminVehicleList", { q: url.searchParams.get("q") || "" });
  if (path === "/api/admin/skill-modules") return commandJson(res, url.searchParams.get("q") ? "adminSkillModulesSearch" : "adminSkillModules", { q: url.searchParams.get("q") || "" });
  if (path === "/api/admin/history") return commandJson(res, "adminHistory");
  if (path === "/api/admin/history/clear" && req.method === "POST") return clearAdminHistoryRoute(req, res);
  if (path === "/api/admin/character-transfer-settings") return characterTransferSettingsRoute(req, res);
  if (path === "/api/admin/message-of-the-day") return messageOfTheDayRoute(req, res);
  if (path === "/api/admin/player-announcements") return playerAnnouncementsRoute(req, res);
  if (path === "/api/admin/map-chat-schedules") return scheduledMapMessagesRoute(req, res);
  if (path === "/api/admin/landsraad") return landsraadRoute(req, res, "overview");
  if (path === "/api/admin/landsraad/task-goal") return landsraadRoute(req, res, "task-goal");
  if (path === "/api/admin/landsraad/term-task-goals") return landsraadRoute(req, res, "term-task-goals");
  if (path === "/api/admin/landsraad/milestone-preset") return landsraadRoute(req, res, "milestone-preset");
  if (path === "/api/admin/landsraad/reward-tier") return landsraadRoute(req, res, "reward-tier");
  if (path === "/api/admin/landsraad/player-contribution") return landsraadRoute(req, res, "player-contribution");
  if (path === "/api/admin/broadcast" && req.method === "POST") return broadcastRoute(req, res);
  if (path === "/api/admin/map-chat" && req.method === "POST") return mapChatRoute(req, res);
  if (path === "/api/admin/broadcast-shutdown" && req.method === "POST") return shutdownBroadcastRoute(req, res);
  if (path === "/api/addons/community") return json(res, 200, await fetchCommunityAddons());
  if (path === "/api/addons/installed") return json(res, 200, await installedAddonsRoute());
  if (path === "/api/addons/community/install" && req.method === "POST") {
    const body = await readJson(req);
    const result = await installCommunityAddon(config, body.id, { approvedPermissions: body.approvedPermissions || [] });
    audit(config, req, "addons.install", { id: result.addon.id, version: result.addon.version, permissions: result.addon.permissions, approvedPermissions: result.addon.approvedPermissions, ok: true });
    return json(res, 200, result);
  }
  if (path === "/api/addons/community/update" && req.method === "POST") {
    const body = await readJson(req);
    const result = await updateCommunityAddon(config, body.id, { approvedPermissions: body.approvedPermissions || [] });
    audit(config, req, "addons.update", { id: result.addon.id, previousVersion: result.previousVersion, version: result.addon.version, permissions: result.addon.permissions, approvedPermissions: result.addon.approvedPermissions, preservedConfiguration: result.preservedConfiguration, ok: true });
    return json(res, 200, result);
  }
  if (path.match(/^\/api\/addons\/installed\/[^/]+\/enable$/) && req.method === "POST") {
    const id = decodeURIComponent(path.split("/").at(-2));
    await syncInstalledAddonLifecycleFromCommunity();
    const result = setInstalledAddonEnabled(config, id, true);
    audit(config, req, "addons.enable", { id: result.addon.id, version: result.addon.version, ok: true });
    return json(res, 200, result);
  }
  if (path.match(/^\/api\/addons\/installed\/[^/]+\/disable$/) && req.method === "POST") {
    const id = decodeURIComponent(path.split("/").at(-2));
    const result = setInstalledAddonEnabled(config, id, false);
    audit(config, req, "addons.disable", { id: result.addon.id, version: result.addon.version, ok: true });
    return json(res, 200, result);
  }
  if (path.match(/^\/api\/addons\/installed\/[^/]+\/bridge$/) && req.method === "POST") return addonBridgeRoute(req, res, path);
  if (path.match(/^\/api\/addons\/installed\/[^/]+\/content\/.+$/) && req.method === "GET") return addonContentRoute(req, res, path);
  if (path.match(/^\/api\/addons\/installed\/[^/]+$/) && req.method === "DELETE") {
    const id = decodeURIComponent(path.split("/").pop());
    const result = removeInstalledAddon(config, id);
    audit(config, req, "addons.remove", { id, ok: true });
    return json(res, 200, result);
  }
  if (path.match(/^\/api\/players\/[^/]+\/give-item$/) && req.method === "POST") return giveSingleItemRoute(req, res, path, "adminGiveItem");
  if (path.match(/^\/api\/players\/[^/]+\/give-items$/) && req.method === "POST") return giveItemsRoute(req, res, path);
  if (path.match(/^\/api\/players\/[^/]+\/give-item-id$/) && req.method === "POST") return giveSingleItemRoute(req, res, path, "adminGiveItemId");
  if (path.match(/^\/api\/players\/[^/]+\/building-unlocks\/grant$/) && req.method === "POST") return buildingUnlockGrantRoute(req, res, path);
  if (path.match(/^\/api\/players\/[^/]+\/customizations\/grant$/) && req.method === "POST") return customizationGrantRoute(req, res, path);
  if (path.match(/^\/api\/players\/[^/]+\/add-xp$/) && req.method === "POST") return playerTask(req, res, path, "adminAddXp");
  if (path.match(/^\/api\/players\/[^/]+\/set-skill-points$/) && req.method === "POST") return playerTask(req, res, path, "adminSetSkillPoints");
  if (path.match(/^\/api\/players\/[^/]+\/set-skill-module$/) && req.method === "POST") return playerTask(req, res, path, "adminSetSkillModule");
  if (path.match(/^\/api\/players\/[^/]+\/refill-water$/) && req.method === "POST") return playerTask(req, res, path, "adminRefillWater");
  if (path.match(/^\/api\/players\/[^/]+\/kick$/) && req.method === "POST") return playerTask(req, res, path, "adminKick");
  if (path.match(/^\/api\/players\/[^/]+\/ban$/)) return playerBanRoute(req, res, path);
  if (path.match(/^\/api\/players\/[^/]+\/repair-login-queue$/) && req.method === "POST") return playerTask(req, res, path, "adminRepairLoginQueue", "REPAIR LOGIN QUEUE");
  if (path === "/api/players/kick-all-online" && req.method === "POST") return confirmedTask(req, res, "admin", "adminKickAllOnline", {}, "KICK ALL ONLINE PLAYERS");
  if (path.match(/^\/api\/players\/[^/]+\/teleport-destinations$/) && req.method === "GET") return dbPlayerRoute(res, path, duneDb.playerTeleportDestinations);
  if (path.match(/^\/api\/players\/[^/]+\/teleport$/) && req.method === "POST") return playerTeleportRoute(req, res, path);
  if (path.match(/^\/api\/players\/[^/]+\/spawn-vehicle$/) && req.method === "POST") return playerTask(req, res, path, "adminSpawnVehicle");
  if (path.match(/^\/api\/players\/[^/]+\/clean-inventory$/) && req.method === "POST") return playerTask(req, res, path, "adminCleanInventory", "CLEAN INVENTORY");
  if (path.match(/^\/api\/players\/[^/]+\/reset-progression$/) && req.method === "POST") return playerTask(req, res, path, "adminResetProgression", "RESET PROGRESSION");
  if (path.match(/^\/api\/players\/[^/]+\/add-currency$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.add-currency", "ADD CURRENCY", (playerId, body) => duneDb.addCurrency(db, playerId, body));
  if (path.match(/^\/api\/players\/[^/]+\/add-faction-reputation$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.add-faction-reputation", "ADD FACTION REPUTATION", (playerId, body) => duneDb.addFactionReputation(db, playerId, body, journeyTagsData));
  if (path.match(/^\/api\/players\/[^/]+\/repair-faction-reputation$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.repair-faction-reputation", "REPAIR FACTION REPUTATION", (playerId) => duneDb.repairFactionReputation(db, playerId, journeyTagsData));
  if (path.match(/^\/api\/players\/[^/]+\/repair-landsraad-quests$/) && req.method === "POST") return playerLandsraadQuestRepairRoute(req, res, path);
  if (path.match(/^\/api\/players\/[^/]+\/character-recovery$/) && req.method === "POST") return playerCharacterRecoveryRoute(req, res, path);
  if (path.match(/^\/api\/players\/[^/]+\/character-recovery$/) && req.method === "GET") return dbPlayerRoute(res, path, duneDb.inspectDeletedCharacterRecovery);
  if (path.match(/^\/api\/players\/[^/]+\/faction$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.assign-faction", "CHANGE PLAYER FACTION", (playerId, body) => duneDb.setPlayerFaction(db, playerId, body));
  if (path.match(/^\/api\/players\/[^/]+\/add-intel$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.add-intel", "ADD INTEL", (playerId, body) => duneDb.addIntel(db, playerId, body));
  if (path.match(/^\/api\/players\/[^/]+\/specializations\/add-xp$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.specializations.add-xp", "ADD SPECIALIZATION XP", (playerId, body) => duneDb.addSpecializationXp(db, playerId, body));
  if (path.match(/^\/api\/players\/[^/]+\/specializations\/grant-max$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.specializations.grant-max", "GRANT MAX SPECIALIZATION", (playerId, body) => duneDb.grantMaxSpecialization(db, playerId, body));
  if (path.match(/^\/api\/players\/[^/]+\/specializations\/reset$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.specializations.reset", "RESET SPECIALIZATION", (playerId, body) => duneDb.resetSpecialization(db, playerId, body));
  if (path.match(/^\/api\/players\/[^/]+\/specializations\/keystones\/grant-all$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.specializations.keystones.grant-all", "GRANT ALL KEYSTONES", (playerId) => duneDb.grantAllSpecializationKeystones(db, playerId));
  if (path.match(/^\/api\/players\/[^/]+\/specializations\/keystones\/reset-all$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.specializations.keystones.reset-all", "RESET ALL KEYSTONES", (playerId) => duneDb.resetAllSpecializationKeystones(db, playerId));
  if (path.match(/^\/api\/players\/[^/]+\/crafting-recipes\/unlock$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.crafting-recipes.unlock", "UNLOCK CRAFTING RECIPE", (playerId, body) => duneDb.unlockCraftingRecipe(db, playerId, body));
  if (path.match(/^\/api\/players\/[^/]+\/research-items\/unlock$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.research-items.unlock", "UNLOCK RESEARCH ITEM", (playerId, body) => duneDb.unlockResearchItem(db, playerId, body));
  if (path.match(/^\/api\/players\/[^/]+\/journey\/complete$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.journey.complete", "COMPLETE JOURNEY NODE", (playerId, body) => duneDb.completeJourneyNode(db, playerId, body, journeyTagsData));
  if (path.match(/^\/api\/players\/[^/]+\/journey\/reset$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.journey.reset", "RESET JOURNEY NODE", (playerId, body) => duneDb.resetJourneyNode(db, playerId, body, journeyTagsData));
  if (path.match(/^\/api\/players\/[^/]+\/tutorials\/complete$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.tutorials.complete", "COMPLETE TUTORIAL", (playerId, body) => duneDb.completeTutorial(db, playerId, body));
  if (path.match(/^\/api\/players\/[^/]+\/tutorials\/reset$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.tutorials.reset", "RESET TUTORIAL", (playerId, body) => duneDb.resetTutorial(db, playerId, body));
  if (path.match(/^\/api\/players\/[^/]+\/repair-gear$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.repair-gear", "REPAIR GEAR", (playerId) => duneDb.repairGear(db, playerId));
  if (path.match(/^\/api\/players\/[^/]+\/repair-vehicle-decay$/) && req.method === "POST") return playerVehicleDecayRepairRoute(req, res, path);
  if (path.match(/^\/api\/players\/[^/]+\/refuel-vehicle$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.refuel-vehicle", "REFUEL VEHICLE", (playerId, body) => {
    // The target vehicle id lives in the body, not the path, so it is not
    // known until after directDbMutation's readJson -- unlike the routes
    // below whose id comes from the URL, this can't pre-check into a 409
    // before the phrase/rate-limit gate. Surfaces as an ordinary 400 instead.
    if (vehicleDeletePending(Number(body?.vehicleId))) throw new Error(VEHICLE_DELETE_PENDING_MESSAGE);
    return duneDb.refuelVehicle(db, playerId, body);
  });
  if (path.match(/^\/api\/players\/[^/]+\/augment-item$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.augment-item", "APPLY AUGMENTS", (playerId, body) => duneDb.augmentInventoryItem(db, playerId, body.itemId, { augments: body.augments, augmentQuality: body.augmentQuality }));
  if (path.match(/^\/api\/players\/[^/]+\/inventory\/[^/]+$/) && req.method === "DELETE") return inventoryDeleteRoute(req, res, path);
  if (path.match(/^\/api\/players\/[^/]+\/inventory\/[^/]+$/) && req.method === "PATCH") return inventoryUpdateRoute(req, res, path);
  if (path.match(/^\/api\/players\/[^/]+\/crafting-recipes$/)) return dbPlayerRoute(res, path, duneDb.playerCraftingRecipes);
  if (path.match(/^\/api\/players\/[^/]+\/research-items$/)) return dbPlayerRoute(res, path, duneDb.playerResearchItems);
  if (path.match(/^\/api\/players\/[^/]+\/building-unlocks$/) && req.method === "GET") return buildingUnlocksRoute(res, path);
  if (path.match(/^\/api\/players\/[^/]+\/customizations$/) && req.method === "GET") return customizationGrantsRoute(res, path);
  if (path.match(/^\/api\/players\/[^/]+\/journey$/)) return dbPlayerRoute(res, path, (database, playerId) => duneDb.playerJourney(database, playerId, journeyTagsData));
  if (path.match(/^\/api\/players\/[^/]+\/inventory$/)) return dbPlayerRoute(res, path, duneDb.playerInventoryAll);
  if (path.match(/^\/api\/players\/[^/]+\/vehicles$/) && req.method === "GET") return dbPlayerRoute(res, path, (database, playerId) => duneDb.listVehicles(database, { playerId, pageSize: 200 }));
  if (path.match(/^\/api\/players\/[^/]+\/bases$/) && req.method === "GET") return dbPlayerRoute(res, path, (database, playerId) => duneDb.listBases(database, {
    playerId,
    q: url.searchParams.get("q") || "",
    page: 0,
    pageSize: 5000,
    sortColumn: url.searchParams.get("sortColumn") || "name",
    sortDirection: url.searchParams.get("sortDirection") || "asc"
  }));
  if (path.match(/^\/api\/players\/[^/]+\/currency$/)) return dbPlayerRoute(res, path, duneDb.playerCurrency);
  if (path.match(/^\/api\/players\/[^/]+\/solaris-coin$/)) return dbPlayerRoute(res, path, duneDb.playerSolarisCoinTotal);
  if (path.match(/^\/api\/players\/[^/]+\/factions$/)) return dbPlayerRoute(res, path, (database, playerId) => duneDb.playerFactions(database, playerId, journeyTagsData));
  if (path.match(/^\/api\/players\/[^/]+\/intel$/)) return dbPlayerRoute(res, path, duneDb.playerIntel);
  if (path.match(/^\/api\/players\/[^/]+\/specs$/)) return dbPlayerRoute(res, path, duneDb.playerSpecs);
  if (path.match(/^\/api\/players\/[^/]+\/position$/)) return dbPlayerRoute(res, path, duneDb.playerPosition);
  if (path.match(/^\/api\/players\/[^/]+\/progression$/)) return dbPlayerRoute(res, path, duneDb.playerProgression);
  if (path.match(/^\/api\/players\/[^/]+\/vitals$/)) return dbPlayerRoute(res, path, duneDb.playerVitals);
  if (path.match(/^\/api\/players\/[^/]+\/events$/)) return dbPlayerUnsupported(res, path, "events");
  if (path.match(/^\/api\/players\/[^/]+\/stats$/)) return dbPlayerUnsupported(res, path, "stats");
  if (path.match(/^\/api\/players\/[^/]+\/history$/)) return dbPlayerUnsupported(res, path, "history");
  if (path.match(/^\/api\/players\/[^/]+$/)) return playerProfileRoute(res, path);

  if (path === "/api/storage") return dbJson(res, () => duneDb.listStorage(db));
  if (path.match(/^\/api\/storage\/[^/]+$/)) return dbJson(res, async () => ({ storage: (await duneDb.listStorage(db)).rows.find((row) => String(row.id) === decodeURIComponent(path.split("/")[3])) || null }));
  if (path.match(/^\/api\/storage\/[^/]+\/items$/)) return dbJson(res, () => duneDb.storageItems(db, decodeURIComponent(path.split("/")[3])));
  if (path.match(/^\/api\/storage\/[^/]+\/give-item$/) && req.method === "POST") return storageGiveItemRoute(req, res, path);
  if (path.match(/^\/api\/storage\/[^/]+\/export$/)) return exportJson(res, `storage-${decodeURIComponent(path.split("/")[3])}.json`, () => duneDb.storageItems(db, decodeURIComponent(path.split("/")[3])));
  if (path === "/api/blueprints" && req.method === "GET") return dbJson(res, () => listBlueprints(db));
  if (path === "/api/blueprints/export" && req.method === "POST") return blueprintBulkExportRoute(req, res);
  if (path.match(/^\/api\/blueprints\/([^/]+)\/export$/) && req.method === "GET") return blueprintExportRoute(req, res, path);
  if (path === "/api/blueprints/import" && req.method === "POST") return blueprintImportRoute(req, res);
  if (path.match(/^\/api\/blueprints\/([^/]+)$/) && req.method === "DELETE") return blueprintsDeleteRoute(req, res, path);
  if (path === "/api/care-package/capabilities") return json(res, 200, carePackageCapabilities());
  if (path === "/api/care-package/config" && req.method === "POST") return carePackageConfigRoute(req, res);
  if (path === "/api/care-package/config") return json(res, 200, carePackageConfig(config));
  if (path === "/api/care-package/history/clear" && req.method === "POST") return carePackageClearHistoryRoute(req, res);
  if (path === "/api/care-package/grants" || path === "/api/care-package/history") return json(res, 200, carePackageHistory(config, url.searchParams.get("limit") || 100));
  if (path === "/api/care-package/eligible") return carePackageEligibleRoute(req, res);
  if (path === "/api/care-package/grant-eligible" && req.method === "POST") return carePackageGrantEligibleRoute(req, res);
  if (path === "/api/care-package/run" && req.method === "POST") return carePackageRunRoute(req, res);
  if (path.match(/^\/api\/care-package\/grant\/[^/]+$/) && req.method === "POST") return carePackageGrantRoute(req, res, path);
  if (path.match(/^\/api\/care-package\/retry\/[^/]+$/) && req.method === "POST") return carePackageRetryRoute(req, res, path);
  if (path === "/api/care-package/enable" && req.method === "POST") return carePackageEnableRoute(req, res, true);
  if (path === "/api/care-package/disable" && req.method === "POST") return carePackageEnableRoute(req, res, false);

  if (path === "/api/map/status") return mapStatusRoute(res);
  if (path === "/api/map/capabilities") return dbJson(res, () => duneDb.liveMapCapabilities(db));
  if (path === "/api/map/teleport-player" && req.method === "POST") return liveMapTeleportPlayerRoute(req, res);
  if (path === "/api/map/partitions") return dbJson(res, () => duneDb.liveMapPartitions(db));
  if (path === "/api/map/markers") return liveMapMarkersRoute(res, url);
  if (path === "/api/map/players") return dbJson(res, () => duneDb.liveMapPlayers(db, url.searchParams.get("map") || ""));
  if (path === "/api/map/bases") return dbJson(res, () => duneDb.liveMapBases(db, url.searchParams.get("map") || ""));
  if (path === "/api/map/storage") return dbJson(res, () => duneDb.liveMapStorage(db, url.searchParams.get("map") || ""));
  if (path === "/api/map/services") return dbJson(res, () => duneDb.liveMapServices(db, url.searchParams.get("map") || ""));
  if (path === "/api/map/spice") return dbJson(res, () => liveMapSpice(db, config, url.searchParams.get("map") || "", { partitionId: url.searchParams.get("partitionId") || "" }));
  if (path === "/api/map/poi") return dbJson(res, () => liveMapPoi(db, url.searchParams.get("map") || ""));
  if (path === "/api/map/overlays") return dbJson(res, () => duneDb.liveMapMarkers(db, url.searchParams.get("map") || ""));
  if (path === "/api/maps/mode" && req.method === "POST") return confirmedTask(req, res, "maps", "mapsSetMode", {}, "SET MAP MODE");
  if (path === "/api/maps/settings" && req.method === "POST") return mapSettingsRoute(req, res);
  if (path === "/api/maps/runtime-settings" && req.method === "POST") return mapsRuntimeSettingsRoute(req, res);
  if (path === "/api/maps/runtime-settings") return json(res, 200, readMapsRuntimeSettings());
  if (path === "/api/maps") return commandJson(res, "mapsList");
  if (path === "/api/maps/mode") return commandJson(res, "mapsMode", { map: url.searchParams.get("map") || "" });
  if (path === "/api/maps/reconcile" && req.method === "POST") return confirmedTask(req, res, "maps", "mapsReconcile", {}, "RECONCILE MAPS");
  if (path === "/api/maps/spawn" && req.method === "POST") return confirmedTask(req, res, "maps", "mapsSpawn", {}, "SPAWN MAP");
  if (path === "/api/maps/despawn" && req.method === "POST") return confirmedTask(req, res, "maps", "mapsDespawn", {}, "DESPAWN MAP");
  // Restart for a map with no managed service: one task that despawns then
  // respawns its partition. task() audits and validates the target for us.
  if (path === "/api/maps/respawn" && req.method === "POST") return confirmedTask(req, res, "maps", "mapsRespawn", {}, "RESTART MAP");
  if (path === "/api/maps/autoscaler" && req.method === "POST") return confirmedTask(req, res, "maps", "autoscalerAction", {}, "AUTOSCALER CHANGE");
  if (path === "/api/maps/autoscaler") return commandJson(res, "autoscalerStatus");
  if (path === "/api/maps/memory" && req.method === "POST") return memoryRoute(req, res);
  if (path === "/api/maps/memory/balancer" && req.method === "POST") return memoryBalancerRoute(req, res);
  if (path === "/api/maps/memory/balancer") return json(res, 200, memoryBalancer.publicState());
  if (path === "/api/maps/memory/swap" && req.method === "POST") return memorySwapRoute(req, res);
  if (path === "/api/maps/memory/swap") return memorySwapStatusRoute(res);
  if (path === "/api/maps/memory/live") return liveMapMemoryRoute(res);
  if (path === "/api/maps/memory") return commandJson(res, "memoryStatus");
  if (path.match(/^\/api\/maps\/spicefields\/[^/]+$/) && req.method === "PATCH") return mapsSpicefieldUpdateRoute(req, res, path);
  if (path === "/api/maps/spicefields") return dbJson(res, () => duneDb.listSpicefieldTypes(db));
  if (path === "/api/maps/combat-state") return mapCombatStateRoute(res, url);
  if (path === "/api/maps/choam-terminals" && req.method === "POST") return mapsChoamTerminalInstallRoute(req, res);
  if (path === "/api/maps/choam-terminals" && req.method === "DELETE") return mapsChoamTerminalRemoveRoute(req, res);
  if (path === "/api/maps/choam-terminals") return dbJson(res, () => choamTerminalOverview(db));
  if (path === "/api/exchange/items") return dbJson(res, () => {
    const exchangeConfig = readExchangeConfig(config.repoRoot);
    return listExchangeItems(db, {
      q: url.searchParams.get("q") || "",
      page: url.searchParams.get("page") || 0,
      pageSize: url.searchParams.get("pageSize") || 50,
      sortColumn: url.searchParams.get("sortColumn") || "display_name",
      sortDirection: url.searchParams.get("sortDirection") || "asc",
      owner: url.searchParams.get("owner") || "all",
      category: url.searchParams.get("category") || "",
      botOwnerIds: exchangeConfig.botOwnerIds,
      blacklist: exchangeConfig.blacklistedOwnerIds,
      includeNpcBroker: exchangeConfig.includeNpcBroker,
      repoRoot: config.repoRoot
    });
  });
  if (path === "/api/exchange/listings") return dbJson(res, () => {
    const exchangeConfig = readExchangeConfig(config.repoRoot);
    return listExchangeListings(db, {
      templateId: url.searchParams.get("templateId") || "",
      qualityLevel: url.searchParams.get("quality") || "",
      owner: url.searchParams.get("owner") || "all",
      botOwnerIds: exchangeConfig.botOwnerIds,
      blacklist: exchangeConfig.blacklistedOwnerIds,
      includeNpcBroker: exchangeConfig.includeNpcBroker
    });
  });
  if (path === "/api/exchange/stats") return dbJson(res, () => {
    const exchangeConfig = readExchangeConfig(config.repoRoot);
    return exchangeStats(db, { botOwnerIds: exchangeConfig.botOwnerIds, blacklist: exchangeConfig.blacklistedOwnerIds, includeNpcBroker: exchangeConfig.includeNpcBroker });
  });
  if (path === "/api/exchange/transactions") return dbJson(res, () => {
    const exchangeConfig = readExchangeConfig(config.repoRoot);
    return listExchangeTransactions(db, {
      q: url.searchParams.get("q") || "",
      page: url.searchParams.get("page") || 0,
      pageSize: url.searchParams.get("pageSize") || 50,
      hours: url.searchParams.get("hours") || 168,
      party: url.searchParams.get("party") || "all",
      exchangeId: url.searchParams.get("exchangeId") || "",
      botOwnerIds: exchangeConfig.botOwnerIds,
      blacklist: exchangeConfig.blacklistedOwnerIds,
      repoRoot: config.repoRoot
    });
  });
  if (path === "/api/exchange/config" && req.method === "GET") return json(res, 200, readExchangeConfig(config.repoRoot));
  if (path === "/api/exchange/config" && req.method === "POST") return exchangeConfigSaveRoute(req, res);
  if (path === "/api/exchange/market" && req.method === "GET") return dbJson(res, () => marketBotStatus(config, db));
  if (path === "/api/exchange/market/exchanges" && req.method === "GET") return dbJson(res, () => listMarketExchanges(db));
  if (path === "/api/exchange/market/buyback/probe" && req.method === "POST") return marketBuybackProbeRoute(req, res);
  if (path === "/api/exchange/market/buyback/log" && req.method === "GET") return marketBuybackLogRoute(req, res);
  if (path === "/api/exchange/market/buyback/log" && req.method === "POST") return marketBuybackLogRefreshRoute(req, res);
  if (path === "/api/exchange/market/buyback/log/clear" && req.method === "POST") return marketBuybackLogClearRoute(req, res);
  if (path === "/api/exchange/market/buyback/schedule" && req.method === "POST") return marketScheduleSaveRoute(req, res, "buyback");
  if (path === "/api/exchange/market/seed/schedule" && req.method === "POST") return marketScheduleSaveRoute(req, res, "seed");
  if (path === "/api/exchange/market/buyback/run" && req.method === "POST") return marketRunNowRoute(req, res, "buyback");
  if (path === "/api/exchange/market/seed/run" && req.method === "POST") return marketRunNowRoute(req, res, "seed");
  if (path === "/api/exchange/market/seed/clear" && req.method === "POST") return marketUnseedRoute(req, res);
  if (path === "/api/exchange/market/plans/csv" && req.method === "GET") return marketSeedPlanCsvDownloadRoute(req, res, url);
  if (path === "/api/exchange/market/plans/csv" && req.method === "POST") return marketSeedPlanCsvUploadRoute(req, res);
  if (path === "/api/exchange/market/plans/active" && req.method === "POST") return marketSeedPlanActiveRoute(req, res);
  if (path === "/api/exchange/market/plans/name" && req.method === "POST") return marketSeedPlanRenameRoute(req, res);
  if (path === "/api/exchange/market/items" && req.method === "GET") return marketItemsListRoute(res);
  if (path === "/api/exchange/market/items" && req.method === "POST") return marketItemsSaveRoute(req, res);
  if (path === "/api/exchange/market/items/catalog" && req.method === "GET") return marketItemsCatalogRoute(res, url);
  if (path === "/api/maps/user-settings/schema") return userSettingsSchemaRoute(res);
  if (path === "/api/maps/user-settings/restart-pending") return json(res, 200, { pending: existsSync(resolve(config.repoRoot, "runtime/generated/landsraad-restart-required")) });
  if (path === "/api/maps/user-settings/deferred-pending") return json(res, 200, readDeferredRestartPending(config));
  if (path === "/api/maps/user-settings/values") return userSettingsValuesRoute(res, url);
  if (path === "/api/maps/user-settings/raw" && req.method === "POST") return userSettingsRawWriteRoute(req, res);
  if (path === "/api/maps/user-settings/raw") return userSettingsRawRoute(res, url);
  if (path === "/api/maps/user-settings/save" && req.method === "POST") return userSettingsSaveRoute(req, res);
  if (path === "/api/maps/user-settings/reset" && req.method === "POST") return userSettingsResetRoute(req, res);
  if (path === "/api/maps/userengine") return safeCommandJson(res, "userSettingsEngineValues");
  if (path === "/api/maps/usergame") {
    const map = url.searchParams.get("map") || "Survival_1";
    const operation = map === "__global__" ? "userSettingsGlobalValues" : url.searchParams.get("partitionId") ? "userSettingsPartitionValues" : "userSettingsMapValues";
    return safeCommandJson(res, operation, { map, partitionId: url.searchParams.get("partitionId") || "1" });
  }
  if (path === "/api/maps/user-settings/materialize" && req.method === "POST") return confirmedTask(req, res, "maps", "userSettingsMaterializeCurrent", {}, "REFRESH MAP SETTINGS");
  if (path === "/api/sietches") return commandJson(res, "sietchesList");
  if (path === "/api/sietches/dimensions") return commandJson(res, url.searchParams.get("ids") === "1" ? "sietchesDimensionIds" : "sietchesDimensions", { map: url.searchParams.get("map") || "Survival_1" });
  if (path === "/api/sietches/update" && req.method === "POST") return sietchesUpdateRoute(req, res);
  if (path === "/api/deepdesert") return commandJson(res, "deepdesertStatus");
  if (path === "/api/deepdesert/update" && req.method === "POST") return deepDesertUpdateRoute(req, res);
  if (path === "/api/settings/public-directory" && req.method === "POST") return publicDirectorySettingsRoute(req, res);
  if (path === "/api/settings/public-directory/claim" && req.method === "POST") return publicDirectoryClaimRoute(req, res);
  if (path === "/api/settings" && req.method === "POST") return writeConfig(req, res);
  if (path === "/api/settings") return json(res, 200, await setupState());

  return json(res, 404, { error: "Not found" });
}

async function addonBridgeRoute(req, res, path) {
  // The bridge authorizes against the installed addon's manifest, not the
  // caller, so a key could install an addon declaring `database: write` and
  // reach arbitrary SQL. `addons` is write-denied in apiKeyScopes.js; this is
  // the second lock, so relaxing that cannot silently reopen the path.
  if (req.authSession?.apiKeyId) {
    audit(config, req, "addons.bridge", { ok: false, reason: "api-key principal" });
    return json(res, 403, { error: "API keys cannot use the addon bridge. Use a browser session." });
  }
  const id = decodeURIComponent(path.split("/").at(-2));
  if (id === EDA_EXCHANGE_BOT_ADDON_ID && edaRetirement.retired) {
    audit(config, req, "addons.bridge", { id, ok: false, reason: "Addon retired; use native Market Bot" });
    return json(res, 410, { error: "EDA Exchange Bot has been retired. Use Exchange > Market Bot in the console." });
  }
  const clientIp = (req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
  const key = `${id}:${clientIp}`;
  const limit = bridgeRateLimiter.check(key);
  if (!limit.allowed) {
    return json(res, 429, { error: `Bridge rate limit exceeded. Try again in ${limit.retryAfterSeconds}s.` });
  }
  bridgeRateLimiter.record(key);
  const body = await readJson(req);
  const action = String(body.action || "").trim();
  if (action === "leadership.players.list") {
    const addon = assertInstalledAddonPermission(config, id, "players:read");
    const result = await duneDb.addonLeadershipPlayers(db);
    audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, ok: true });
    return json(res, 200, { ok: true, result });
  }
  if (action === "ops.health.summary" || action === "ops.health.players" || action === "ops.health.farms" || action === "ops.health.summary.v2") {
    const addon = assertInstalledAddonPermission(config, id, "ops:read");
    const result = action === "ops.health.players"
      ? await duneDb.addonOpsHealthPlayers(db)
      : action === "ops.health.farms"
        ? await duneDb.addonOpsHealthFarms(db)
        : await duneDb.addonOpsHealthSummary(db);
    audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, ok: true });
    return json(res, 200, { ok: true, result });
  }
  if (action === "ops.activity.summary") {
    const addon = assertInstalledAddonPermission(config, id, "ops:read");
    const result = await duneDb.addonOpsActivitySummary(db);
    audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, ok: true });
    return json(res, 200, { ok: true, result });
  }
  if (action === "ops.resources.summary") {
    const addon = assertInstalledAddonPermission(config, id, "ops:read");
    const result = await duneDb.addonOpsResourcesSummary(db);
    audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, ok: true });
    return json(res, 200, { ok: true, result });
  }
  if (action === "ops.combat.deaths") {
    const addon = assertInstalledAddonPermission(config, id, "ops:read");
    const result = await duneDb.addonOpsCombatDeaths(db);
    audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, ok: true });
    return json(res, 200, { ok: true, result });
  }
  if (action === "ops.economy.summary") {
    const addon = assertInstalledAddonPermission(config, id, "ops:read");
    const result = await duneDb.addonOpsEconomySummary(db);
    audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, ok: true });
    return json(res, 200, { ok: true, result });
  }
  if (action === "ops.health.containers") {
    const addon = assertInstalledAddonPermission(config, id, "ops:read");
    const result = await collectContainerHealth();
    const ok = !result.error;
    audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, ok });
    return json(res, 200, { ok, result });
  }
  if (action === "server.hardware.status") {
    const addon = assertInstalledAddonPermission(config, id, "server:status");
    const result = await hardwareStatus();
    audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, sensorCount: result.temperatures.length, ok: true });
    return json(res, 200, { ok: true, result });
  }
  if (action === "admin.items.grant") {
    const addon = assertInstalledAddonPermission(config, id, "admin:grant-items");
    if (!applyMutationRateLimit(req, res, `addon:${id}:admin.items.grant`)) return;
    try {
      const result = await grantAddonItem(config, addon.id, body);
      audit(config, req, "addons.bridge", {
        id: addon.id,
        action,
        permission: addon.permission,
        requestId: result.requestId,
        playerId: result.playerId,
        itemId: result.itemId,
        quantity: result.quantity,
        quality: result.quality,
        duplicate: result.duplicate,
        ok: true
      });
      return json(res, 200, { ok: true, result });
    } catch (error) {
      audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, requestId: String(body.requestId || ""), ok: false, error: redact(error?.message || "Unexpected error.") });
      return json(res, 400, { ok: false, error: redact(error?.message || "Unexpected error.") });
    }
  }
  if (action.startsWith("scheduler.")) return addonSchedulerBridgeAction(req, res, id, action, body);
  if (action === "database.query" || action === "database.execute") {
    const query = String(body.query || "");
    const readOnly = isReadOnlySql(query);
    const requiredPermission = readOnly ? "database:read" : "database:write";
    if (action === "database.query" && !readOnly) return json(res, 400, { error: "database.query accepts read-only SQL only. Use database.execute with database:write permission for write SQL." });
    const addon = assertInstalledAddonPermission(config, id, requiredPermission);
    if (!readOnly && !applyMutationRateLimit(req, res, `addon:${id}:database.execute`)) return;
    if (!readOnly && !config.mockMode) {
      await runDune(config, buildDuneArgs("backupCreate"), { env: { DB_BACKUP_ORIGIN: `addon-${addon.id}` } });
    }
    const result = await duneDb.runSql(db, query, !readOnly);
    audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, readOnly, rowCount: result.rowCount, command: result.command, ok: true });
    return json(res, 200, { ok: true, result });
  }
  audit(config, req, "addons.bridge", { id, action, ok: false, reason: "Unsupported addon action" });
  return json(res, 400, { error: `Unsupported addon action: ${action || "unknown"}` });
}

// Typed scheduler actions: the addon UI manages a server-side schedule with
// validated parameters only. No SQL from the iframe is persisted or replayed;
// the scheduled sweep SQL is built server-side in addonJobs.js.
async function addonSchedulerBridgeAction(req, res, id, action, body) {
  if (id !== EDA_EXCHANGE_BOT_ADDON_ID) {
    audit(config, req, "addons.bridge", { id, action, ok: false, reason: "Scheduled jobs are not supported for this addon" });
    return json(res, 400, { error: "Scheduled jobs are not supported for this addon yet." });
  }
  if (action === "scheduler.schedule.get") {
    const addon = assertInstalledAddonPermission(config, id, "database:read");
    const result = readBuybackSchedule(config);
    audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, ok: true });
    return json(res, 200, { ok: true, result });
  }
  if (action === "scheduler.schedule.set") {
    const payload = body.schedule && typeof body.schedule === "object" ? body.schedule : body;
    const addon = assertInstalledAddonPermission(config, id, "database:write");
    // Unattended background writes need an explicit extra approval from the
    // server owner, so any save that leaves the schedule enabled requires
    // scheduler:server too — including field updates that omit `enabled` on an
    // already-enabled schedule. Explicitly disabling only needs database:write.
    const leavesEnabled = payload.enabled === undefined ? readBuybackSchedule(config).enabled : payload.enabled === true;
    if (leavesEnabled) assertInstalledAddonPermission(config, id, ADDON_SCHEDULER_PERMISSION);
    if (!applyMutationRateLimit(req, res, `addon:${id}:scheduler.schedule.set`)) return;
    try {
      // Bridge saves always mark the schedule addon-sourced, so scheduled runs
      // keep re-verifying the addon's approved permissions.
      const result = saveBuybackSchedule(config, payload, { source: "addon" });
      audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, enabled: result.enabled, intervalMinutes: result.intervalMinutes, exchangeId: result.exchangeId, buybackPercent: result.buybackPercent, maxBuys: result.maxBuys, ok: true });
      return json(res, 200, { ok: true, result });
    } catch (error) {
      audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, ok: false, error: redact(error?.message || "Unexpected error.") });
      return json(res, 400, { ok: false, error: redact(error?.message || "Unexpected error.") });
    }
  }
  if (action === "scheduler.probe") {
    const addon = assertInstalledAddonPermission(config, id, "database:read");
    try {
      const result = await probeBuybackEligibility(config, db, body.schedule && typeof body.schedule === "object" ? body.schedule : body);
      audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, eligible: result.eligible, exchangeId: result.exchangeId, ok: true });
      return json(res, 200, { ok: true, result });
    } catch (error) {
      audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, ok: false, error: redact(error?.message || "Unexpected error.") });
      return json(res, 400, { ok: false, error: redact(error?.message || "Unexpected error.") });
    }
  }
  if (action === "scheduler.run") {
    const addon = assertInstalledAddonPermission(config, id, "database:write");
    if (!applyMutationRateLimit(req, res, `addon:${id}:scheduler.run`)) return;
    try {
      const result = await addonJobScheduler.runNow({ trigger: "manual" });
      audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, status: result.status, eligible: result.eligible, purchased: result.purchased, ok: true });
      return json(res, 200, { ok: true, result });
    } catch (error) {
      audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, ok: false, error: redact(error?.message || "Unexpected error.") });
      return json(res, 400, { ok: false, error: redact(error?.message || "Unexpected error.") });
    }
  }
  if (action === "scheduler.seed.schedule.get") {
    const addon = assertInstalledAddonPermission(config, id, "database:read");
    const result = readSeedSchedule(config);
    audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, ok: true });
    return json(res, 200, { ok: true, result });
  }
  if (action === "scheduler.seed.schedule.set") {
    const payload = body.schedule && typeof body.schedule === "object" ? body.schedule : body;
    const addon = assertInstalledAddonPermission(config, id, "database:write");
    const leavesEnabled = payload.enabled === undefined ? readSeedSchedule(config).enabled : payload.enabled === true;
    if (leavesEnabled) assertInstalledAddonPermission(config, id, ADDON_SCHEDULER_PERMISSION);
    if (!applyMutationRateLimit(req, res, `addon:${id}:scheduler.seed.schedule.set`)) return;
    try {
      const result = saveSeedSchedule(config, payload, { source: "addon" });
      audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, enabled: result.enabled, intervalMinutes: result.intervalMinutes, exchangeId: result.exchangeId, priceMultiplier: result.priceMultiplier, ok: true });
      return json(res, 200, { ok: true, result });
    } catch (error) {
      audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, ok: false, error: redact(error?.message || "Unexpected error.") });
      return json(res, 400, { ok: false, error: redact(error?.message || "Unexpected error.") });
    }
  }
  if (action === "scheduler.seed.run") {
    const addon = assertInstalledAddonPermission(config, id, "database:write");
    if (!applyMutationRateLimit(req, res, `addon:${id}:scheduler.seed.run`)) return;
    try {
      const result = await addonJobScheduler.runNow({ trigger: "manual", job: "seed" });
      audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, status: result.status, listingCount: result.listingCount, ok: true });
      return json(res, 200, { ok: true, result });
    } catch (error) {
      audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, ok: false, error: redact(error?.message || "Unexpected error.") });
      return json(res, 400, { ok: false, error: redact(error?.message || "Unexpected error.") });
    }
  }
  audit(config, req, "addons.bridge", { id, action, ok: false, reason: "Unsupported addon action" });
  return json(res, 400, { error: `Unsupported addon action: ${action}` });
}

async function installedAddonsRoute() {
  await syncInstalledAddonLifecycleFromCommunity();
  return listInstalledAddons(config);
}

async function syncInstalledAddonLifecycleFromCommunity() {
  try {
    syncInstalledAddonLifecycle(config, await fetchCommunityAddons());
  } catch {
    // Keep the last known local lifecycle state when the community catalog is unreachable.
  }
}

function addonContentRoute(req, res, path) {
  const parts = path.split("/");
  const id = decodeURIComponent(parts[4] || "");
  const contentPath = decodeURIComponent(parts.slice(6).join("/"));
  const target = installedAddonContentPath(config, id, contentPath);
  if (!existsSync(target)) return json(res, 404, { error: "Addon content file not found." });
  res.writeHead(200, withSecurityHeaders({
    "content-type": contentTypeForPath(target),
    "x-frame-options": "SAMEORIGIN"
  }));
  createReadStream(target).pipe(res);
}

async function liveMapMarkersRoute(res, url) {
  return dbJson(res, async () => {
    const configPayload = duneDb.liveMapConfigPayload(url.searchParams.get("map") || "");
    const activeMap = configPayload.map.actorMap || configPayload.map.key;
    const partitionId = url.searchParams.get("partitionId") || "";
    const includeStatic = url.searchParams.get("static") !== "0";
    const [markers, partitions, spice, poi] = await Promise.all([
      duneDb.liveMapMarkers(db, activeMap),
      duneDb.liveMapPartitions(db).catch(() => ({ rows: [] })),
      liveMapSpice(db, config, activeMap, { partitionId, includeStaticPool: includeStatic }).catch(() => ({ capabilities: { ...(includeStatic ? { spice: false } : {}), spice_active: false, flour_sand: false }, rows: [] })),
      includeStatic ? liveMapPoi(db, activeMap).catch(() => ({ capabilities: {}, rows: [] })) : Promise.resolve({ capabilities: {}, rows: [] })
    ]);
    return {
      ...markers,
      ...configPayload,
      capabilities: { ...markers.capabilities, ...spice.capabilities, ...poi.capabilities },
      overlays: { ...markers.overlays, spice: spice.reason || "" },
      rows: [...markers.rows, ...spice.rows, ...poi.rows],
      // Every server container reports the identical farm-wide seed and
      // cycle boundary -- resolveCoriolisCycle just prefers asking the
      // selected partitionId's own container first (more likely to actually
      // be running than a fixed default) before falling back to the
      // overmap/survival-1 default.
      coriolisSeed: spice.currentSeed || "",
      coriolisNextCycleAt: spice.nextCycleAt || "",
      partitions: partitions.rows || []
    };
  });
}

async function liveMapTeleportPlayerRoute(req, res) {
  const body = await readJson(req);
  const playerId = String(body.playerId || "");
  const payload = {
    playerId,
    x: Number(body.x),
    y: Number(body.y),
    z: Number(body.z ?? 5000),
    yaw: Number(body.yaw || 0),
    partitionId: Number(body.partitionId || 0)
  };
  if (!Number.isFinite(payload.x) || !Number.isFinite(payload.y) || !Number.isFinite(payload.z)) {
    return json(res, 400, { error: "Valid X, Y, and Z coordinates are required." });
  }
  if (body.online === true) {
    try {
      buildDuneArgs("adminTeleport", payload);
    } catch (error) {
      return json(res, 400, { error: redact(error?.message || "Unexpected error.") });
    }
    if (!applyMutationRateLimit(req, res, "live-map.teleport.live")) return;
    audit(config, req, "live-map.teleport.live", { playerId, x: payload.x, y: payload.y, z: payload.z, partitionId: payload.partitionId });
    return json(res, 202, { path: "live", task: tasks.create("admin", "adminTeleport", payload) });
  }
  try {
    if (!applyMutationRateLimit(req, res, "live-map.teleport.offline")) return;
    const result = await duneDb.teleportOfflinePlayerToCoords(db, playerId, payload);
    audit(config, req, "live-map.teleport.offline", { playerId, supported: result.supported, x: payload.x, y: payload.y, z: payload.z, partitionId: payload.partitionId });
    return json(res, 200, { path: "offline", ...result });
  } catch (error) {
    audit(config, req, "live-map.teleport.offline", { playerId, supported: false, error: redact(error?.message || "Unexpected error.") });
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

async function commandJson(res, operation, payload = {}) {
  if (config.mockMode) return json(res, 200, mockCommand(operation));
  const args = buildDuneArgs(operation, payload);
  const result = await runDune(config, args);
  return json(res, 200, { operation, stdout: result.stdout, stderr: result.stderr, exitCode: result.code });
}

async function clearAdminHistoryRoute(req, res) {
  const body = await readJson(req).catch(() => ({}));
  const historyDir = join(config.repoRoot, "runtime/generated");
  const historyFile = join(historyDir, "admin-command-history.tsv");
  mkdirSync(historyDir, { recursive: true });
  if (body.scope === "admin-tools") {
    const current = existsSync(historyFile) ? readFileSync(historyFile, "utf8") : "";
    const next = current.split(/\r?\n/).filter((line) => line && !isAdminToolsHistoryLine(line)).join("\n");
    writeFileSync(historyFile, next ? `${next}\n` : "");
    audit(config, req, "admin.history.clear", { ok: true, scope: "admin-tools" });
    return json(res, 200, { ok: true });
  }
  writeFileSync(historyFile, "");
  writeFileSync(join(historyDir, "admin-command-audit.jsonl"), "");
  audit(config, req, "admin.history.clear", { ok: true, scope: "all" });
  return json(res, 200, { ok: true });
}

function isAdminToolsHistoryLine(line) {
  const parts = String(line || "").split("\t");
  const command = String(parts[1] || "").trim();
  const target = String(parts[2] || "").trim();
  if (/^(?:web-(?:broadcast|shutdown-broadcast|map-chat)|scheduled-map-chat(?:-now)?)$/i.test(command)) return true;
  if (/^web-hydrate-all$/i.test(command)) return true;
  if (/^KickPlayer$/i.test(command) && /^(all|\*)$/i.test(target)) return true;
  return false;
}

// status and readiness are the only two cached commands: they are the pair the
// Home panel requests on every mount and idle poll, and each costs ~4s. `status`
// keeps commandJson's throw-on-failure behaviour, `readiness` keeps
// safeCommand's swallow-and-report behaviour, so caching does not change what
// either route returns -- only how often the subprocess actually runs.
const serverStatusCache = createServerStatusCache(config, {
  collectStatus: async () => {
    const result = await runDune(config, buildDuneArgs("status", {}));
    return { operation: "status", stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
  },
  collectReadiness: () => safeCommand("readiness")
});

async function cachedCommandJson(res, operation, url) {
  if (config.mockMode) return json(res, 200, mockCommand(operation));
  const fresh = url?.searchParams?.get("fresh") === "1";
  const entry = await serverStatusCache.read(operation, { fresh });
  const { sampledAtMs, ...rest } = entry;
  void sampledAtMs;
  return json(res, 200, rest);
}

async function safeCommandJson(res, operation, payload = {}) {
  if (config.mockMode) return json(res, 200, mockCommand(operation));
  return json(res, 200, await safeCommand(operation, payload));
}

async function backupsListRoute(res) {
  const currentBattlegroupId = readCurrentBattlegroupId(config) || "Unknown";
  if (config.mockMode) return json(res, 200, { ...mockCommand("backupList"), currentBattlegroupId, rows: [] });
  const result = await runDune(config, buildDuneArgs("backupList"));
  return json(res, 200, { operation: "backupList", stdout: result.stdout, stderr: result.stderr, exitCode: result.code, currentBattlegroupId, rows: enrichBackupRows(config, parseBackupListRows(result.stdout)) });
}

async function externalBackupImportRoute(req, res) {
  const form = await readMultipartForm(req, config.maxUploadBytes);
  const backup = form.files.find((file) => file.fieldName === "backup");
  const metadata = form.files.find((file) => file.fieldName === "metadata");
  if (!backup) return json(res, 400, { error: "Select a .backup file to import." });
  if (!metadata) return json(res, 400, { error: "Select the matching .backup.yaml file to import." });

  const backupName = basename(backup.fileName || "");
  const metadataName = basename(metadata.fileName || "");
  if (!/\.backup$/i.test(backupName)) return json(res, 400, { error: "The backup file must end with .backup." });
  if (!/\.ya?ml$/i.test(metadataName)) return json(res, 400, { error: "The metadata file must end with .yaml or .yml." });
  if (!backup.content.length) return json(res, 400, { error: "The selected .backup file is empty." });
  if (!metadata.content.length) return json(res, 400, { error: "The selected metadata file is empty." });

  const backupDir = resolve(config.repoRoot, "runtime/backups/db");
  mkdirSync(backupDir, { recursive: true });
  const importedName = nextImportedBackupName(backupDir);
  const backupPath = resolve(backupDir, importedName);
  const metadataPath = `${backupPath}.yaml`;
  writeFileSync(backupPath, backup.content, { mode: 0o600 });
  writeFileSync(metadataPath, normalizeImportedBackupMetadata(config, metadata.content), { mode: 0o600 });
  chmodSync(backupPath, 0o600);
  chmodSync(metadataPath, 0o600);
  audit(config, req, "backup.import-external", { backup: importedName, sourceBackup: backupName, sourceMetadata: metadataName });

  const result = await runDune(config, buildDuneArgs("backupList"));
  const rows = enrichBackupRows(config, parseBackupListRows(result.stdout));
  return json(res, 200, { ok: true, backup: importedName, rows, row: rows.find((row) => row.name === importedName) || null });
}

async function backupDownloadRoute(req, res, backupName) {
  if (!validBackupDownloadName(backupName)) return json(res, 400, { error: "Invalid backup name." });
  const backupDir = resolve(config.repoRoot, "runtime/backups/db");
  const backupPath = resolve(backupDir, backupName);
  const metadataPath = `${backupPath}.yaml`;
  if (!backupPath.startsWith(`${backupDir}/`)) return json(res, 400, { error: "Invalid backup path." });
  if (!existsSync(backupPath)) return json(res, 404, { error: "Backup file was not found." });
  if (!existsSync(metadataPath)) return json(res, 404, { error: "Backup metadata .yaml file was not found." });

  const archiveName = `${backupName}.tar.gz`;
  const archive = createBackupDownloadArchive([
    { name: backupName, content: readFileSync(backupPath) },
    { name: `${backupName}.yaml`, content: readFileSync(metadataPath) }
  ]);
  res.writeHead(200, {
    "content-type": "application/gzip",
    "content-length": archive.length,
    "content-disposition": `attachment; filename="${archiveName.replace(/"/g, "")}"`
  });
  res.end(archive);
}

async function backupAutoStatusRoute(res) {
  if (config.mockMode) return json(res, 200, { ...mockCommand("backupAutoStatus"), status: { ok: true, enabled: false, backupTime: "05:00", intervalHours: "", retentionDays: "0", retentionLabel: "No Retention Limit", timer: "" } });
  const result = await safeCommand("backupAutoStatus");
  return json(res, 200, { ...result, status: parseBackupAutoStatus(result) });
}

async function structuredVehiclesRoute(res) {
  if (config.mockMode) return json(res, 200, { vehicles: [] });
  const result = await runDune(config, buildDuneArgs("adminVehicleList"));
  return json(res, 200, {
    vehicles: parseVehicleList(result.stdout),
    stdout: result.stdout,
    stderr: result.stderr
  });
}

async function mapStatusRoute(res) {
  if (config.mockMode) return json(res, 200, { maps: mockCommand("mapsList"), services: mockCommand("servers"), readiness: mockCommand("readiness") });
  const [maps, services, readiness, autoscaler] = await Promise.all([
    safeCommand("mapsList"),
    safeCommand("servers"),
    safeCommand("readiness"),
    safeCommand("autoscalerStatus")
  ]);
  return json(res, 200, { maps, services, readiness, autoscaler });
}

async function mapsSpicefieldUpdateRoute(req, res, path) {
  const typeId = decodeURIComponent(path.split("/").pop());
  const body = await readJson(req);
  audit(config, req, "maps.spicefields.update", { typeId, columns: Object.keys(body || {}) });
  return dbJson(res, async () => {
    const result = await duneDb.updateSpicefieldType(db, typeId, body);
    if (result.row) result.persistence = persistSpicefieldOverride(config, result.row);
    return result;
  });
}

async function mapsChoamTerminalInstallRoute(req, res) {
  const body = await readJson(req);
  if (!applyMutationRateLimit(req, res, "maps.choam-terminals.install")) return;
  audit(config, req, "maps.choam-terminals.install", { tradeCenterKey: body.tradeCenterKey });
  return dbJson(res, () => installChoamTerminals(db, body));
}

async function mapsChoamTerminalRemoveRoute(req, res) {
  const body = await readJson(req);
  if (!applyMutationRateLimit(req, res, "maps.choam-terminals.remove")) return;
  audit(config, req, "maps.choam-terminals.remove", { tradeCenterKey: body.tradeCenterKey });
  return dbJson(res, () => removeChoamTerminals(db, body));
}

async function exchangeConfigSaveRoute(req, res) {
  const body = await readJson(req);
  if (!applyMutationRateLimit(req, res, "exchange.config")) return;
  audit(config, req, "exchange.config", {
    botOwnerIds: Array.isArray(body?.botOwnerIds) ? body.botOwnerIds.length : 0,
    blacklistedOwnerIds: Array.isArray(body?.blacklistedOwnerIds) ? body.blacklistedOwnerIds.length : 0
  });
  try {
    return json(res, 200, saveExchangeConfig(config.repoRoot, body));
  } catch (error) {
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, { supported: false, ...payload.body });
  }
}

// ---- First-class Market Bot (console-managed seed/buyback) ----
//
// Same engine as the EDA Exchange Bot addon's scheduler bridge, but managed
// natively: schedules saved here are source:"console" (no installed addon or
// addon permission approval required — authorization is the RBAC action on
// these routes), and manual runs reuse the shared addonJobScheduler so a
// console-triggered sweep can never overlap an addon-scheduled one.

async function marketBuybackProbeRoute(req, res) {
  const body = await readJson(req);
  try {
    const result = await probeBuybackEligibility(config, db, body && typeof body === "object" ? body : {});
    audit(config, req, "exchange.market", { op: "buyback-probe", eligible: result.eligible, exchangeId: result.exchangeId, ok: true });
    return json(res, 200, result);
  } catch (error) {
    audit(config, req, "exchange.market", { op: "buyback-probe", ok: false, error: redact(error?.message || "Unexpected error.") });
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

async function marketBuybackLogRoute(req, res) {
  try {
    return json(res, 200, readBuybackLog(config));
  } catch (error) {
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

async function marketBuybackLogRefreshRoute(req, res) {
  if (!applyMutationRateLimit(req, res, "exchange.market.buyback.log")) return;
  const body = await readJson(req);
  try {
    const result = await refreshBuybackLog(config, db, body && typeof body === "object" ? body : {});
    audit(config, req, "exchange.market", { op: "buyback-log", listings: result.entries?.length || 0, exchangeId: result.exchangeId, ok: true });
    return json(res, 200, result);
  } catch (error) {
    audit(config, req, "exchange.market", { op: "buyback-log", ok: false, error: redact(error?.message || "Unexpected error.") });
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

async function marketBuybackLogClearRoute(req, res) {
  if (!applyMutationRateLimit(req, res, "exchange.market.buyback.log-clear")) return;
  try {
    const result = await clearBuybackLog(config);
    audit(config, req, "exchange.market", { op: "buyback-log-clear", ok: true });
    return json(res, 200, result);
  } catch (error) {
    audit(config, req, "exchange.market", { op: "buyback-log-clear", ok: false, error: redact(error?.message || "Unexpected error.") });
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

async function marketScheduleSaveRoute(req, res, job) {
  const body = await readJson(req);
  if (!applyMutationRateLimit(req, res, `exchange.market.${job}.schedule`)) return;
  const payload = body?.schedule && typeof body.schedule === "object" ? body.schedule : (body || {});
  try {
    const result = job === "seed" ? saveMarketSeedSchedule(config, payload) : saveMarketBuybackSchedule(config, payload);
    audit(config, req, "exchange.market", { op: `${job}-schedule`, enabled: result.enabled, intervalMinutes: result.intervalMinutes, exchangeId: result.exchangeId, ok: true });
    return json(res, 200, result);
  } catch (error) {
    audit(config, req, "exchange.market", { op: `${job}-schedule`, ok: false, error: redact(error?.message || "Unexpected error.") });
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

async function marketRunNowRoute(req, res, job) {
  if (!applyMutationRateLimit(req, res, `exchange.market.${job}.run`)) return;
  try {
    const result = await addonJobScheduler.runNow({ trigger: "console", job });
    audit(config, req, "exchange.market", { op: `${job}-run`, status: result.status, purchased: result.purchased, listingCount: result.listingCount, ok: true });
    return json(res, 200, result);
  } catch (error) {
    audit(config, req, "exchange.market", { op: `${job}-run`, ok: false, error: redact(error?.message || "Unexpected error.") });
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

// Manual "unseed": remove the Market Bot's own NPC listings from one exchange
// without reseeding — the clear-market ability the EDA addon had before the
// bot became console-native. Probes read-only first and backs up only when
// there is something to remove.
async function marketUnseedRoute(req, res) {
  const body = await readJson(req);
  if (!applyMutationRateLimit(req, res, "exchange.market.seed.clear")) return;
  try {
    const result = await addonJobScheduler.runNow({ trigger: "console", job: "unseed", exchangeId: body?.exchangeId });
    audit(config, req, "exchange.market", { op: "seed-clear", status: result.status, removedListings: result.removedListings, exchangeId: result.exchangeId, ok: true });
    return json(res, 200, result);
  } catch (error) {
    audit(config, req, "exchange.market", { op: "seed-clear", ok: false, error: redact(error?.message || "Unexpected error.") });
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

function marketSeedPlanCsvDownloadRoute(req, res, url) {
  try {
    const result = exportMarketSeedPlanCsv(config, url.searchParams.get("planId") || "");
    const filename = String(result.filename || "market-seed-plan.csv").replace(/[^A-Za-z0-9._-]/g, "_");
    res.writeHead(200, withSecurityHeaders({
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`
    }));
    res.end(result.csv);
  } catch (error) {
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

async function marketSeedPlanCsvUploadRoute(req, res) {
  if (!applyMutationRateLimit(req, res, "exchange.market.plans.csv")) return;
  try {
    const form = await readMultipartForm(req, Math.min(config.maxUploadBytes, 10 * 1024 * 1024));
    const file = form.files.find((entry) => entry.fieldName === "file") || form.files[0];
    if (!file?.content?.length) return json(res, 400, { error: "Select a CSV file to import as a seed plan." });
    const fileName = basename(file.fileName || "seed-plan.csv");
    const csvText = decodeSeedPlanCsvUpload(file.content, fileName);
    const result = importMarketSeedPlanFromCsv(config, {
      csvText,
      name: form.fields.name,
      planId: form.fields.planId,
      fileName
    });
    audit(config, req, "exchange.market", { op: "seed-plan-import", planId: result.id, name: result.name, rows: result.rows, ok: true });
    return json(res, 200, result);
  } catch (error) {
    audit(config, req, "exchange.market", { op: "seed-plan-import", ok: false, error: redact(error?.message || "Unexpected error.") });
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

async function marketSeedPlanActiveRoute(req, res) {
  const body = await readJson(req);
  if (!applyMutationRateLimit(req, res, "exchange.market.plans.active")) return;
  try {
    const plans = setActiveMarketSeedPlan(config, body?.planId);
    audit(config, req, "exchange.market", { op: "seed-plan-active", planId: plans.activePlanId, ok: true });
    return json(res, 200, plans);
  } catch (error) {
    audit(config, req, "exchange.market", { op: "seed-plan-active", ok: false, error: redact(error?.message || "Unexpected error.") });
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

async function marketSeedPlanRenameRoute(req, res) {
  const body = await readJson(req);
  if (!applyMutationRateLimit(req, res, "exchange.market.plans.name")) return;
  try {
    const plans = renameMarketSeedPlan(config, body?.planId, body?.name);
    audit(config, req, "exchange.market", { op: "seed-plan-rename", planId: body?.planId, name: body?.name, ok: true });
    return json(res, 200, plans);
  } catch (error) {
    audit(config, req, "exchange.market", { op: "seed-plan-rename", ok: false, error: redact(error?.message || "Unexpected error.") });
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

// Merged, display-ready view of the bot's item catalog: the bundled plan's
// rows plus any admin-added newItems, annotated with override/unsafe state.
// Unlike the seed/buyback merge (which drops unsafe/disabled rows so the bot
// never lists them), this view keeps every row visible so an admin can see
// and re-enable a disabled item.
function buildBotItemRows(plan, overrides, unsafeIds, metadata) {
  const overrideMap = overrides.overrides || {};
  const unsafeSet = new Set(unsafeIds);
  const rows = plan.rows.map((row) => {
    const o = getOverrideRow(overrideMap, row.templateId, row.qualityLevel);
    const meta = metadata.get(row.templateId);
    return {
      templateId: row.templateId,
      displayName: meta?.name || row.templateId,
      category: meta?.category || "",
      qualityLevel: row.qualityLevel,
      price: o?.price ?? row.price,
      listings: o?.listings ?? row.listings,
      enabled: o?.enabled !== false,
      overridden: Boolean(o),
      isNew: false,
      unsafe: unsafeSet.has(row.templateId)
    };
  });
  for (const [templateId, item] of Object.entries(overrides.newItems || {})) {
    rows.push({
      templateId,
      displayName: item.name,
      category: item.category,
      qualityLevel: item.qualityLevel,
      price: item.price,
      listings: item.listings,
      enabled: item.enabled !== false,
      overridden: false,
      isNew: true,
      unsafe: unsafeSet.has(templateId)
    });
  }
  return rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

async function marketItemsListRoute(res) {
  try {
    const status = await marketBotStatus(config, db);
    if (!status.capabilities.exchangeMarket) {
      return json(res, 200, { capabilities: { exchangeMarket: false }, rows: [], reason: status.reason });
    }
    const plan = loadMarketSeedPlan(config);
    const overrides = readMarketItemOverrides(config.repoRoot);
    const unsafeIds = readUnsafeTemplateIds(config.repoRoot);
    const rows = buildBotItemRows(plan, overrides, unsafeIds, duneDb.adminItemMetadata());
    return json(res, 200, { capabilities: { exchangeMarket: true }, rows });
  } catch (error) {
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

function marketItemsCatalogRoute(res, url) {
  try {
    const rows = listBotItemCatalogPickerItems(config.repoRoot, {
      q: url.searchParams.get("q") || "",
      category: url.searchParams.get("category") || ""
    });
    return json(res, 200, { rows });
  } catch (error) {
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

async function marketItemsSaveRoute(req, res) {
  const body = await readJson(req);
  if (!applyMutationRateLimit(req, res, "exchange.market.items")) return;
  const overrideCount = Object.keys(body?.overrides || {}).length;
  const newItemCount = Object.keys(body?.newItems || {}).length;
  try {
    const result = saveMarketItemOverrides(config.repoRoot, body && typeof body === "object" ? body : {});
    audit(config, req, "exchange.market", { op: "items-save", overrideCount, newItemCount, ok: true });
    return json(res, 200, result);
  } catch (error) {
    audit(config, req, "exchange.market", { op: "items-save", ok: false, error: redact(error?.message || "Unexpected error.") });
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

async function safeCommand(operation, payload = {}) {
  try {
    const args = buildDuneArgs(operation, payload);
    const result = await runDune(config, args);
    return { operation, stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
  } catch (error) {
    return { operation, stdout: redact(error.stdout || ""), stderr: redact(error.stderr || error?.message || "Unexpected error."), exitCode: error.code || 1 };
  }
}

async function databaseQuery(req, res) {
  const body = await readJson(req);
  const query = String(body.query || "");
  const readOnly = isReadOnlySql(query);
  if (!readOnly && !applyMutationRateLimit(req, res, "database.query.write")) return;
  if (!config.mockMode && !readOnly) {
    await runDune(config, buildDuneArgs("backupCreate"), { env: { DB_BACKUP_ORIGIN: "destructive-sql" } });
  }
  audit(config, req, "database.query", { readOnly, destructive: !readOnly });
  return dbJson(res, () => duneDb.runSql(db, query, true));
}

async function databaseExport(req, res) {
  const body = await readJson(req);
  const query = String(body.query || "");
  if (!isReadOnlySql(query)) {
    return json(res, 400, { error: "Export Query JSON supports read-only SELECT, WITH, SHOW, and EXPLAIN queries. Use Run Query for database writes." });
  }
  audit(config, req, "database.export", {});
  const content = await duneDb.exportRows(db, query);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": "attachment; filename=\"query-export.json\""
  });
  res.end(content);
}

async function databaseRowUpdate(req, res, path) {
  const parts = path.split("/");
  const schema = decodeURIComponent(parts[4]);
  const table = decodeURIComponent(parts[5]);
  const body = await readJson(req);
  if (!applyMutationRateLimit(req, res, `database.row-update:${schema}.${table}`)) return;
  audit(config, req, "database.row-update", { schema, table, columns: Object.keys(body.values || {}) });
  return dbJson(res, () => duneDb.updateTableRow(db, schema, table, body.rowId, body.values));
}

async function databasePasswordRoute(req, res) {
  const body = await readJson(req);
  const password = validateDatabasePassword(body.password);
  if (process.env.ADMIN_DATABASE_URL) {
    return json(res, 400, { error: "Database password changes are unavailable while ADMIN_DATABASE_URL is set. Update the connection URL instead." });
  }
  await duneDb.changeDunePassword(db, password);
  updateEnvFileValue("DUNE_DB_PASSWORD", password);
  process.env.DUNE_DB_PASSWORD = password;
  const previousDb = db;
  db = createDb(config);
  try { await previousDb.close(); } catch {}
  audit(config, req, "database.change-password", { user: "dune", password: "<redacted>" });
  return json(res, 202, { ok: true, user: "dune", task: tasks.create("server", "restartAll", {}) });
}

function validateDatabasePassword(value) {
  const password = String(value || "");
  if (password.length < 4) {
    const error = new Error("Database password must be at least 4 characters.");
    error.statusCode = 400;
    throw error;
  }
  if (password.length > 256 || /[\r\n\0]/.test(password)) {
    const error = new Error("Database password contains unsupported characters.");
    error.statusCode = 400;
    throw error;
  }
  return password;
}

async function adminPasswordRoute(req, res) {
  const body = await readJson(req);
  if (config.authDisabled) return json(res, 400, { error: "Login password changes are unavailable while admin authentication is disabled." });
  if (config.adminPasswordEnvManaged) return json(res, 400, { error: "The login password is managed by ADMIN_PASSWORD. Update the environment value instead." });
  if (!auth.passwordMatches(body.currentPassword)) return json(res, 400, { error: "Current password is incorrect." });
  const password = validateAdminPassword(body.newPassword);
  writeFileSync(config.adminPasswordFile, `${password}\n`, { mode: 0o600 });
  try {
    chmodSync(config.adminPasswordFile, 0o600);
  } catch {
    // Best effort on non-POSIX development hosts.
  }
  config.adminPassword = password;
  audit(config, req, "settings.change-admin-password", { password: "<redacted>" });
  return json(res, 200, { ok: true });
}

async function apiKeyCreateRoute(req, res) {
  const body = await readJson(req);
  const created = await apiKeys.create({
    name: body.name,
    scopes: body.scopes,
    expiresAt: body.expiresAt,
    rateLimitPerMinute: body.rateLimitPerMinute
  });
  audit(config, req, "settings.api-key-create", { id: created.key.id, name: created.key.name, scopes: created.key.scopes });
  // `secret` is the only time the full key leaves the server. It is not
  // stored -- only its hash is -- so this response cannot be reproduced.
  return json(res, 200, { key: created.key, secret: created.secret });
}

async function apiKeyItemRoute(req, res, path) {
  // decodeURIComponent throws URIError on a malformed escape (%ZZ), which
  // surfaced as a 500 from an authenticated admin route rather than the 404
  // this path already intends for an unknown id.
  let id;
  try {
    id = decodeURIComponent(path.slice("/api/settings/api-keys/".length));
  } catch {
    return json(res, 404, { error: "That API key no longer exists." });
  }
  if (!id || id.includes("/")) return json(res, 404, { error: "That API key no longer exists." });

  if (req.method === "PUT") {
    const body = await readJson(req);
    const patch = {};
    for (const field of ["name", "scopes", "enabled", "expiresAt", "rateLimitPerMinute"]) {
      if (body[field] !== undefined) patch[field] = body[field];
    }
    const updated = await apiKeys.update(id, patch);
    if (!updated) return json(res, 404, { error: "That API key no longer exists." });
    audit(config, req, "settings.api-key-update", { id: updated.id, name: updated.name, scopes: updated.scopes, enabled: updated.enabled });
    return json(res, 200, { key: updated });
  }

  if (req.method === "DELETE") {
    const revoked = await apiKeys.revoke(id);
    if (!revoked) return json(res, 404, { error: "That API key no longer exists." });
    audit(config, req, "settings.api-key-revoke", { id: revoked.id, name: revoked.name });
    return json(res, 200, { ok: true });
  }

  // No 405 branch: only PUT and DELETE resolve to an action for this prefix
  // (actions.js), so every other method returns null from actionForRoute and is
  // refused with 403 by the gate before reaching here. A 405 would be dead code
  // documenting a contract the dispatcher does not actually implement.
  return json(res, 404, { error: "That API key no longer exists." });
}

async function webPortRoute(req, res) {
  const body = await readJson(req);
  const port = validateWebPort(body.port);
  if (port !== config.port) await assertWebPortAvailable(port);
  const host = webConsoleDisplayHost(req);
  const url = `http://${host}:${port}`;
  updateEnvFileValue("ADMIN_BIND_PORT", String(port));
  process.env.ADMIN_BIND_PORT = String(port);
  audit(config, req, "settings.change-web-port", { port });
  json(res, 200, {
    ok: true,
    port,
    url,
    message: `Web Console port saved. The console is restarting now, and this page may disconnect. Open ${url} in about 10 seconds.`
  });
  if (port !== config.port) scheduleConsoleRestart(port);
}

function validateWebPort(value) {
  const text = String(value || "").trim();
  if (!/^\d+$/.test(text)) {
    const error = new Error("Web Console port must be a number between 1 and 65535.");
    error.statusCode = 400;
    throw error;
  }
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const error = new Error("Web Console port must be a number between 1 and 65535.");
    error.statusCode = 400;
    throw error;
  }
  return port;
}

function webConsoleDisplayHost(req) {
  const hostHeader = String(req.headers.host || "").trim();
  const host = hostHeader.replace(/^\[/, "").replace(/\](:\d+)?$/, "").replace(/:\d+$/, "");
  if (host && host !== "0.0.0.0") return host;
  return config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
}

function scheduleConsoleRestart(port) {
  setTimeout(() => {
    const helperName = `redblink-dune-console-restart-${Date.now()}`;
    const hostRepoRoot = process.env.DUNE_HOST_REPO_ROOT || config.repoRoot;
    const composeProjectName = process.env.DUNE_COMPOSE_PROJECT_NAME || process.env.COMPOSE_PROJECT_NAME;
    if (!composeProjectName) {
      console.error("Cannot restart the Console because the main Dune Compose project name is missing.");
      return;
    }
    const hostUid = process.env.DUNE_HOST_UID || String(process.getuid?.() ?? 0);
    const hostGid = process.env.DUNE_HOST_GID || String(process.getgid?.() ?? 0);
    const dockerSocketGid = process.env.DOCKER_SOCKET_GID || detectDockerSocketGid();
    const script = [
      "set -eu",
      "mkdir -p runtime/generated",
      "export DOCKER_SOCKET_GID=\"${DOCKER_SOCKET_GID:-$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo 0)}\"",
      `echo "[$(date -Is)] Restarting Dune Docker Console on port ${port}" >> runtime/generated/console-restart.log`,
      "docker compose -f docker-compose.web.yml build redblink-dune-docker-console >> runtime/generated/console-restart.log 2>&1",
      "docker rm -f redblink-dune-docker-console >> runtime/generated/console-restart.log 2>&1 || true",
      "docker compose -f docker-compose.web.yml up -d redblink-dune-docker-console >> runtime/generated/console-restart.log 2>&1",
      `echo "[$(date -Is)] Dune Docker Console restart command finished" >> runtime/generated/console-restart.log`
    ].join("\n");
    const child = spawn("docker", buildSelfUpdateHelperDockerArgs({
      helperName,
      hostRepoRoot,
      composeProjectName,
      helperImage: "redblink-dune-docker-console:dev",
      hostUid,
      hostGid,
      dockerSocketGid,
      extraEnv: [`ADMIN_BIND_PORT=${port}`],
      command: script
    }), {
      cwd: config.repoRoot,
      detached: true,
      stdio: "ignore",
      env: process.env
    });
    child.unref();
  }, 750);
}

function assertWebPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", (error) => {
      const message = error.code === "EADDRINUSE"
        ? `Port ${port} is already in use. Choose another Web Console port.`
        : `Port ${port} cannot be used: ${error.message}`;
      const responseError = new Error(message);
      responseError.statusCode = 400;
      reject(responseError);
    });
    server.once("listening", () => {
      server.close(() => resolve());
    });
    server.listen(port, config.host);
  });
}

function validateAdminPassword(value) {
  const password = String(value || "");
  const requirements = [
    password.length >= 13,
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password)
  ];
  if (requirements.some((passed) => !passed)) {
    const error = new Error("New password must be at least 13 characters and include lowercase letters, uppercase letters, numbers, and special symbols.");
    error.statusCode = 400;
    throw error;
  }
  if (password.length > 256 || /[\r\n\0]/.test(password)) {
    const error = new Error("New password contains unsupported characters.");
    error.statusCode = 400;
    throw error;
  }
  return password;
}

function updateEnvFileValue(key, value) {
  return updateEnvValue(config.repoRoot, key, value);
}

async function dbJson(res, fn) {
  try {
    return json(res, 200, await fn());
  } catch (error) {
    const payload = apiErrorPayload(error, error.unsupported ? 501 : 500);
    return json(res, payload.status, { supported: false, ...payload.body });
  }
}

function apiErrorPayload(error, fallbackStatus = 500) {
  const rawMessage = String(error?.message || "Unexpected error.");
  if (isPostgresUnavailableError(error, rawMessage)) {
    return {
      status: 503,
      body: { error: POSTGRES_UNAVAILABLE_MESSAGE, reason: POSTGRES_UNAVAILABLE_MESSAGE }
    };
  }
  const message = redact(friendlyJsonError(rawMessage));
  return {
    status: error?.statusCode || fallbackStatus,
    body: { error: message, reason: message }
  };
}

function isPostgresUnavailableError(error, rawMessage = "") {
  // Note: error?.code === "ECONNREFUSED" and the generic "connect
  // ECONNREFUSED" regex below already catch every real case regardless
  // of which port Postgres is configured on -- this specific-port regex
  // is effectively redundant, but is kept (now port-aware instead of
  // hardcoded to the stock port 15432) for clearer log/error matching on
  // deployments with a non-default configured Postgres port. Pass
  // config.repoRoot explicitly rather than relying on resolvePorts()'s
  // process.cwd() default coincidentally matching it -- postgres itself
  // is env-var-only so this doesn't change behavior today, but avoids
  // depending on that coincidence for any future profile-backed field.
  const postgresPort = resolvePorts(process.env, config.repoRoot).postgres;
  return error?.code === "ECONNREFUSED"
    || new RegExp(`ECONNREFUSED.*127\\.0\\.0\\.1:${postgresPort}`, "i").test(rawMessage)
    || /connect\s+ECONNREFUSED/i.test(rawMessage);
}

function friendlyJsonError(rawMessage) {
  if (/Unexpected token|Unexpected end of JSON|is not valid JSON|invalid json/i.test(rawMessage)) {
    return "The console found invalid saved data for this page. Refresh the page and try again.";
  }
  return rawMessage || "Request failed.";
}

async function exportJson(res, filename, fn) {
  try {
    const data = await fn();
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`
    });
    res.end(JSON.stringify(data, null, 2));
  } catch (error) {
    const status = error.unsupported ? 501 : 500;
    json(res, status, { supported: false, error: redact(error?.message || "Unexpected error."), reason: redact(error?.message || "Unexpected error.") });
  }
}

function parseDatabaseFilterParam(url) {
  const raw = url.searchParams.get("filter");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid filter parameter");
  }
}

function databaseTableRoute(req, res, path, action, url) {
  const parts = path.split("/");
  const schema = decodeURIComponent(parts[4]);
  const table = decodeURIComponent(parts[5]);
  if (action === "columns") return dbJson(res, () => duneDb.tableColumns(db, schema, table));
  if (action === "count") return dbJson(res, () => duneDb.tableCount(db, schema, table, parseDatabaseFilterParam(url)));
  return dbJson(res, () => duneDb.tablePreview(db, schema, table, url.searchParams.get("limit") || 50, url.searchParams.get("offset") || 0, parseDatabaseFilterParam(url)));
}

function dbPlayerRoute(res, path, fn) {
  const id = decodeURIComponent(path.split("/")[3]);
  return dbJson(res, async () => {
    await duneDb.resolvePlayerTargetCached(db, id);
    return fn(db, id);
  });
}

function dbPlayerUnsupported(res, path, feature) {
  const id = decodeURIComponent(path.split("/")[3]);
  return dbJson(res, async () => {
    await duneDb.resolvePlayerTargetCached(db, id);
    return duneDb.unsupportedPlayerFeature(db, id, feature);
  });
}

async function task(req, res, type, operation, payload) {
  try {
    buildDuneArgs(operation, payload);
  } catch (error) {
    return json(res, 400, { error: redact(error?.message || "Unexpected error.") });
  }
  if (await maybeQueueRestart(req, res, type, operation, payload)) return;
  // Any server-group task is about to change what status/readiness report, so
  // drop the cached snapshot now rather than letting Home show "Running" for a
  // full TTL after a stop.
  if (type === "server") serverStatusCache.invalidate();
  audit(config, req, `task.${operation}`, payload);
  return json(res, 202, { task: tasks.create(type, operation, payload) });
}

// Restart Queue gate. When the queue is enabled and real players are online, a
// console-triggered restart becomes a countdown instead of running immediately.
// Returns true when it has already sent the HTTP response (queued or rejected),
// false to let the caller restart as normal. An explicit `?restartQueue=immediate`
// override, a disabled queue, an empty battlegroup, or an undeterminable online
// count all fall through to an immediate restart. The countdown processor
// dispatches via tasks.create() directly, so it never re-enters this gate.
async function maybeQueueRestart(req, res, type, operation, payload) {
  const classification = restartQueue.classifyRestart(operation, payload);
  if (!classification) return false;
  let settings;
  try {
    settings = restartQueue.readSettings(config);
  } catch {
    return false;
  }
  if (!settings.enabled) return false;
  if (restartQueueImmediateRequested(req)) {
    audit(config, req, "restart-queue.override-immediate", { operation, target: classification.target });
    return false;
  }
  let online = 0;
  let battlegroupOnline = null;
  try {
    const scoped = await scopedOnlineCount(classification);
    online = scoped.online;
    battlegroupOnline = scoped.battlegroupOnline;
  } catch {
    // If we cannot read the online count the database is usually down or
    // restarting -- there are no players to protect, so let the restart proceed.
    return false;
  }
  if (online <= 0) return false;

  const decision = restartQueue.canQueue(restartQueue.readState(config).entries, classification.target, classification.mapKey);
  if (!decision.ok) {
    json(res, 409, { queued: false, error: decision.reason, state: restartQueue.publicState(config) });
    return true;
  }
  const entry = restartQueue.appendEntry(config, {
    target: classification.target,
    type,
    operation,
    payload,
    mapKey: classification.mapKey,
    mapLabel: classification.mapLabel,
    partitionId: classification.partitionId,
    map: classification.map,
    requestedBy: "web-admin",
    countdownMinutes: settings.defaultCountdownMinutes,
    now: Date.now()
  });
  audit(config, req, "restart-queue.enqueue", { operation, target: classification.target, mapLabel: classification.mapLabel, entryId: entry.id, online, battlegroupOnline });
  recordAdminHistory(config, {
    command: "web-restart-queue",
    target: classification.target === "battlegroup" ? "battlegroup" : classification.mapLabel,
    friendly: "Restart Queue",
    path: "runtime/generated/restart-queue-state.json",
    result: "queued",
    message: classification.target !== "battlegroup" && battlegroupOnline !== null && battlegroupOnline !== online
      ? `${settings.defaultCountdownMinutes}-minute countdown (${online} online on this map, ${battlegroupOnline} in the battlegroup)`
      : `${settings.defaultCountdownMinutes}-minute countdown (${online} online)`
  });
  json(res, 202, { queued: true, online, battlegroupOnline, entryId: entry.id, state: restartQueue.publicState(config) });
  return true;
}

// Online count for a restart decision, scoped to the actual target: a
// battlegroup restart affects everyone, but a map/sietch restart only affects
// players on that partition, so it must not be gated (or auto-run) by who
// happens to be online elsewhere. Always also returns the battlegroup-wide
// figure so callers can surface both ("2 online on this map, 5 in the
// battlegroup") -- for a battlegroup classification the two are the same
// query. Falls back to the battlegroup count when the target's map/partition
// can't be resolved, so an unresolvable target never silently reports 0.
async function scopedOnlineCount(classification) {
  const battlegroup = await duneDb.countOnlinePlayers(db);
  const battlegroupOnline = battlegroup.supported ? battlegroup.online : null;
  if (classification.target === "battlegroup") {
    return { online: battlegroupOnline ?? 0, battlegroupOnline };
  }
  const scoped = await duneDb.countOnlinePlayersForTarget(db, { partitionId: classification.partitionId, map: classification.map });
  return { online: scoped.supported ? scoped.online : (battlegroupOnline ?? 0), battlegroupOnline };
}

function restartQueueImmediateRequested(req) {
  try {
    const parsed = new URL(req.url, "http://localhost");
    const value = String(
      parsed.searchParams.get("restartQueue") || parsed.searchParams.get("queueMode") || parsed.searchParams.get("immediate") || ""
    ).toLowerCase();
    return value === "immediate" || value === "1" || value === "true";
  } catch {
    return false;
  }
}

// Dispatch an entry's underlying restart. Flips the write-ahead `restarting`
// marker and persists BEFORE dispatch so a mid-restart console bounce (a
// battlegroup restart takes the console container with it) never re-fires it on
// boot, then removes the entry so the section returns to idle.
async function executeRestartEntry(entry) {
  if (!entry) return;
  try {
    restartQueue.markEntryRestarting(config, entry.id);
    audit(config, null, "restart-queue.execute", { operation: entry.operation, target: entry.target, mapLabel: entry.mapLabel, entryId: entry.id });
    tasks.create(entry.type || "server", entry.operation, entry.payload || {});
    restartQueue.removeEntry(config, entry.id);
  } catch (error) {
    console.error(`Restart queue execution failed for ${entry.operation}: ${redact(error?.message || "Unexpected error.")}`);
  }
}

async function restartQueueAutoTick() {
  if (restartQueueAutoRunning) return;
  const now = Date.now();
  if (now - restartQueueAutoLastRun < 5000) return;
  let state;
  try {
    state = restartQueue.readState(config);
  } catch {
    return;
  }
  if (!state.entries.length) return;
  restartQueueAutoRunning = true;
  restartQueueAutoLastRun = now;
  try {
    const settings = restartQueue.readSettings(config);
    let battlegroupOnline = null;
    try {
      const count = await duneDb.countOnlinePlayers(db);
      battlegroupOnline = count.supported ? count.online : null;
    } catch {
      battlegroupOnline = null;
    }
    for (const entry of state.entries) {
      if (entry.status !== "counting") continue;
      // Battlegroup entries were already scoped to everyone by the query above.
      // A map entry must only look at players on that specific partition --
      // otherwise a map with nobody on it would keep counting down just
      // because players are online elsewhere in the battlegroup, and (worse)
      // a map WITH players would auto-execute the moment the battlegroup as a
      // whole happened to read zero.
      let online = battlegroupOnline;
      if (entry.target !== "battlegroup") {
        try {
          const scoped = await duneDb.countOnlinePlayersForTarget(db, { partitionId: entry.partitionId, map: entry.map });
          online = scoped.supported ? scoped.online : battlegroupOnline;
        } catch {
          online = battlegroupOnline;
        }
      }
      if (online === 0) {
        await executeRestartEntry(entry);
        continue;
      }
      for (const mark of restartQueue.checkpointsDue(entry, settings.broadcastCheckpoints, now)) {
        try {
          await restartQueue.sendWarning(config, entry, mark, settings);
          restartQueue.recordCheckpointSent(config, entry.id, mark);
        } catch (error) {
          // Leave the mark unrecorded so the next tick retries it. Infra errors
          // (RabbitMQ/container down) are expected transiently during a restart.
          const message = String(error?.message || "Unexpected error.");
          if (!/publish|rabbitmq|docker|container|ECONNREFUSED|ECONNRESET/i.test(message)) {
            console.error(`Restart queue warning failed: ${redact(message)}`);
          }
        }
      }
      if (Date.now() >= entry.restartAt) await executeRestartEntry(entry);
    }
  } finally {
    restartQueueAutoRunning = false;
  }
}

// One-time boot reconciliation of the persisted queue. See restartQueue.recover.
function recoverRestartQueue() {
  let state;
  try {
    state = restartQueue.readState(config);
  } catch {
    return;
  }
  if (!state.entries.length) return;
  const settings = restartQueue.readSettings(config);
  const result = restartQueue.recover(state, Date.now(), settings.recoveryGraceMinutes);
  restartQueue.writeState(config, result.keep);
  for (const entry of result.cleared) audit(config, null, "restart-queue.recovered-cleared", { entryId: entry.id, operation: entry.operation });
  for (const entry of result.discarded) audit(config, null, "restart-queue.recovered-discarded", { entryId: entry.id, operation: entry.operation });
  for (const entry of result.executeNow) void executeRestartEntry(entry);
  if (result.resume.length) console.log(`Restart queue resumed ${result.resume.length} countdown(s) after boot.`);
}

// `partitionId`/`map` scope `playersOnline` to a specific restart target (the
// interception dialog passes these before the admin has committed to a
// restart, so it can show "2 online on this map" instead of the battlegroup
// figure). `battlegroupPlayersOnline` is always the unscoped count -- for a
// battlegroup-wide request the two are identical -- so the UI can show both
// when they differ.
async function restartQueueStatusRoute(req, res, url) {
  const settings = restartQueue.readSettings(config);
  let online = null;
  let battlegroupOnline = null;
  let supported = true;
  try {
    const count = await duneDb.countOnlinePlayers(db);
    battlegroupOnline = count.supported ? count.online : null;
    supported = count.supported;
    online = battlegroupOnline;
  } catch {
    online = null;
    battlegroupOnline = null;
    supported = false;
  }
  const partitionId = Number(url?.searchParams?.get("partitionId") || 0);
  const map = String(url?.searchParams?.get("map") || "").trim();
  if (partitionId > 0 || map) {
    try {
      const scoped = await duneDb.countOnlinePlayersForTarget(db, { partitionId, map });
      if (scoped.supported) online = scoped.online;
    } catch {
      // Keep the battlegroup-wide fallback already assigned above.
    }
  }
  return json(res, 200, {
    settings,
    defaults: restartQueue.defaultSettings(),
    state: restartQueue.publicState(config),
    playersOnline: online,
    battlegroupPlayersOnline: battlegroupOnline,
    playersOnlineSupported: supported
  });
}

async function restartQueueSaveRoute(req, res) {
  const body = await readJson(req);
  try {
    const result = restartQueue.saveSettings(config, body);
    audit(config, req, "restart-queue.save", { enabled: result.settings.enabled, defaultCountdownMinutes: result.settings.defaultCountdownMinutes });
    recordAdminHistory(config, {
      command: "web-restart-queue",
      target: "server",
      friendly: "Restart Queue",
      path: "runtime/generated/restart-queue.json",
      result: "saved",
      message: result.settings.enabled ? "enabled" : "disabled"
    });
    return json(res, 200, { ok: true, ...result, state: restartQueue.publicState(config) });
  } catch (error) {
    return json(res, 400, { error: redact(error?.message || "Unexpected error.") });
  }
}

async function restartQueueCancelRoute(req, res) {
  const body = await readJson(req);
  const id = String(body.id || "").trim();
  if (!id) return json(res, 400, { error: "A queue entry id is required." });
  restartQueue.removeEntry(config, id);
  audit(config, req, "restart-queue.cancel", { entryId: id });
  return json(res, 200, { ok: true, state: restartQueue.publicState(config) });
}

async function restartQueueRestartNowRoute(req, res) {
  const body = await readJson(req);
  const id = String(body.id || "").trim();
  if (!id) return json(res, 400, { error: "A queue entry id is required." });
  const entry = restartQueue.readState(config).entries.find((candidate) => candidate.id === id);
  if (!entry) return json(res, 404, { error: "That restart is no longer queued." });
  audit(config, req, "restart-queue.restart-now", { entryId: id });
  await executeRestartEntry(entry);
  return json(res, 200, { ok: true, state: restartQueue.publicState(config) });
}

async function characterTransferSettingsRoute(req, res) {
  if (req.method === "GET") return json(res, 200, readCharacterTransferSettings(config));
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  const body = await readJson(req);
  try {
    const result = saveCharacterTransferSettings(config, body.settings || {}, { defaults: Boolean(body.restoreDefaults) });
    const payload = { service: "director" };
    audit(config, req, "admin.character-transfer-settings.save", { restoreDefaults: Boolean(body.restoreDefaults), settings: result.settings });
    return json(res, 202, { ok: true, settings: result.settings, path: result.path, task: tasks.create("server", "restartService", payload) });
  } catch (error) {
    return json(res, error.statusCode || 500, { error: redact(error?.message || "Unexpected error.") });
  }
}

async function messageOfTheDayRoute(req, res) {
  if (req.method === "GET") return json(res, 200, readMessageOfTheDay(config));
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  const body = await readJson(req);
  try {
    const result = body.restoreDefaults ? restoreMessageOfTheDay(config) : saveMessageOfTheDay(config, body.settings || body);
    let primedOnlinePlayers = 0;
    if (result.settings.enabled) {
      const players = await duneDb.listAllPlayers(db, { status: "online" }).catch(() => ({ rows: [] }));
      primedOnlinePlayers = primeMessageOfTheDayOnlineState(config, players.rows || []).delivered;
    }
    audit(config, req, "admin.message-of-the-day.save", { restoreDefaults: Boolean(body.restoreDefaults), enabled: result.settings.enabled, deliveryMode: result.settings.deliveryMode });
    recordAdminHistory(config, {
      command: "web-message-of-the-day",
      target: result.settings.deliveryMode,
      friendly: "Message of the Day",
      path: "runtime/generated/message-of-the-day.json",
      result: "saved",
      message: result.settings.enabled ? result.settings.message : "disabled"
    });
    return json(res, 200, {
      ok: true,
      ...result,
      status: readMessageOfTheDay(config).status,
      delivery: {
        primedOnlinePlayers,
        note: result.settings.enabled
          ? result.settings.deliveryMode === "daily"
            ? "Players who are online while this is saved will become eligible again after 24 hours."
            : result.settings.deliveryMode === "map"
              ? "Players who are online while this is saved will receive the message after their next map transfer or login."
            : "Players who are online while this is saved will receive the message after their next login."
          : "Message of the Day delivery is disabled."
      }
    });
  } catch (error) {
    audit(config, req, "admin.message-of-the-day.save", { supported: false, error: redact(error?.message || "Unexpected error.") });
    return json(res, error.statusCode || 400, { error: redact(error?.message || "Unexpected error.") });
  }
}

async function playerAnnouncementsRoute(req, res) {
  if (req.method === "GET") return json(res, 200, readPlayerAnnouncements(config));
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  const body = await readJson(req);
  try {
    const result = body.restoreDefaults ? restorePlayerAnnouncements(config) : savePlayerAnnouncements(config, body.settings || body);
    if (result.settings.joinEnabled || result.settings.leaveEnabled) {
      const players = await duneDb.listAllPlayers(db, { status: "online" }).catch(() => ({ rows: [] }));
      primePlayerAnnouncementOnlineState(config, players.rows || []);
    }
    audit(config, req, "admin.player-announcements.save", { restoreDefaults: Boolean(body.restoreDefaults), joinEnabled: result.settings.joinEnabled, leaveEnabled: result.settings.leaveEnabled });
    recordAdminHistory(config, {
      command: "web-player-announcements",
      target: "online-status",
      friendly: "Join Leave Announcements",
      path: "runtime/generated/player-announcements.json",
      result: "saved",
      message: result.settings.joinEnabled || result.settings.leaveEnabled ? "enabled" : "disabled"
    });
    return json(res, 200, { ok: true, ...result });
  } catch (error) {
    audit(config, req, "admin.player-announcements.save", { supported: false, error: redact(error?.message || "Unexpected error.") });
    return json(res, error.statusCode || 400, { error: redact(error?.message || "Unexpected error.") });
  }
}

async function landsraadRoute(req, res, action) {
  if (req.method === "GET" && action === "overview") return dbJson(res, () => duneDb.landsraadOverview(db));
  if (req.method === "GET" && action === "milestone-preset") return json(res, 200, { preset: readLandsraadMilestonePreset(config) });
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  const body = await readJson(req);
  try {
    let result;
    if (action === "task-goal") result = await duneDb.updateLandsraadTaskGoal(db, body.taskId, body.goalAmount);
    else if (action === "term-task-goals") result = await duneDb.updateLandsraadTermTaskGoals(db, body.termId, body.goalAmount);
    else if (action === "milestone-preset") {
      saveLandsraadMilestonePreset(config, body);
      result = await applySavedLandsraadMilestonePreset(config, db);
    }
    else if (action === "reward-tier") result = await duneDb.updateLandsraadRewardTier(db, body);
    else if (action === "player-contribution") result = await duneDb.setLandsraadPlayerContribution(db, body);
    else return json(res, 404, { error: "Not found" });
    audit(config, req, `admin.landsraad.${action}`, { ...body, ok: true });
    return json(res, 200, result);
  } catch (error) {
    audit(config, req, `admin.landsraad.${action}`, { ...body, ok: false, error: redact(error?.message || "Unexpected error.") });
    const payload = apiErrorPayload(error, error.unsupported ? 501 : 400);
    return json(res, payload.status, { supported: false, ...payload.body });
  }
}

async function confirmedTask(req, res, type, operation, payload, phrase) {
  const body = await readJson(req);
  if (phrase && body.confirmation !== phrase) {
    return json(res, 400, { error: `Confirmation phrase required: ${phrase}` });
  }
  return task(req, res, type, operation, { ...payload, ...body });
}

async function memoryRoute(req, res) {
  const body = await readJson(req);
  const operation = body.action === "unset" ? "memoryUnset" : "memorySet";
  const phrase = operation === "memoryUnset" ? "UNSET MAP MEMORY" : "SET MAP MEMORY";
  if (body.confirmation !== phrase) return json(res, 400, { error: `Confirmation phrase required: ${phrase}` });
  return task(req, res, "maps", operation, body);
}

async function memoryBalancerRoute(req, res) {
  const body = await readJson(req);
  const enabled = Boolean(body.enabled);
  if (enabled === memoryBalancer.publicState().enabled) return json(res, 200, memoryBalancer.publicState());

  const state = await memoryBalancer.setEnabled(enabled);
  audit(config, req, "maps.memory.balancer", { enabled });
  return json(res, 200, state);
}

async function memorySwapStatusRoute(res) {
  try {
    const result = await runDune(config, buildDuneArgs("memorySwapStatus"), { timeoutMs: 15000 });
    return json(res, 200, parseMemorySwapStatus(result.stdout));
  } catch (error) {
    return json(res, 500, { error: redact(error?.message || "Unexpected error.") });
  }
}

async function memorySwapRoute(req, res) {
  const body = await readJson(req);
  const enabled = body.enabled === true;
  const phrase = enabled ? "ENABLE MEMORY SWAP" : "DISABLE MEMORY SWAP";
  if (body.confirmation !== phrase) return json(res, 400, { error: `Confirmation phrase required: ${phrase}` });
  const operation = enabled ? "memorySwapEnable" : "memorySwapDisable";
  audit(config, req, "maps.memory.swap", { enabled, perServerGiB: body.perServerGiB, poolGiB: body.poolGiB, swappiness: body.swappiness });
  return task(req, res, "maps", operation, body);
}

// Read-only, aggregate-only PvP/PvE combat state for a map's partitions.
// Resolved from the effective UserGame.ini configuration via
// services/mapCombatState.js — never from database labels, dimension
// index, display names, or lifecycle mode. See docs on
// services/mapCombatState.js for the full contract.
async function mapCombatStateRoute(res, url) {
  const map = String(url.searchParams.get("map") || "").trim();
  if (!map) return json(res, 400, { error: "map query parameter is required." });
  return dbJson(res, async () => {
    const partitionResult = await duneDb.mapCombatPartitionRows(db, map);
    if (partitionResult.capabilities?.combatState === false) {
      return { map, mapState: "UNKNOWN", partitions: [], reason: partitionResult.reason };
    }
    const partitionRows = partitionResult.rows.map((row) => ({
      partitionId: row.partition_id,
      dimensionIndex: row.dimension_index,
      databaseLabel: row.database_label || null,
      serverId: row.server_id || "",
      ready: Boolean(row.ready),
      alive: Boolean(row.alive),
      blocked: Boolean(row.blocked)
    }));
    return resolveMapCombatState(config, map, partitionRows);
  });
}

async function mapSettingsRoute(req, res) {
  const body = await readJson(req);
  if (body.confirmation !== "SAVE MAP SETTINGS") return json(res, 400, { error: "Confirmation phrase required: SAVE MAP SETTINGS" });
  const map = String(body.map || "");
  const partitionId = String(body.partitionId || "").trim();
  const memoryChanged = Boolean(body.memoryChanged);
  const modeChanged = Boolean(body.modeChanged);
  if (!map) return json(res, 400, { error: "Map is required." });
  if (!memoryChanged && !modeChanged) return json(res, 400, { error: "No map setting changes were submitted." });
  const restart = false;
  const payload = {
    map,
    partitionId,
    mode: String(body.mode || ""),
    memory: String(body.memory || ""),
    modeChanged,
    memoryChanged,
    ...(restart ? restartPayload("map", map, partitionId) : { restartMode: "none", restartLabel: map })
  };
  audit(config, req, "maps.settings.save", { map, partitionId, modeChanged, memoryChanged, restartMode: payload.restartMode });
  return json(res, 202, { task: tasks.create("maps", "mapsApplySettings", payload) });
}

async function userSettingsSchemaRoute(res) {
  try {
    const result = await runDune(config, buildDuneArgs("userSettingsMetadata"), { timeoutMs: 8000 });
    return json(res, 200, JSON.parse(result.stdout || "{}"));
  } catch (error) {
    return json(res, 500, { error: redact(error?.message || "Unexpected error.") });
  }
}

async function userSettingsRawRoute(res, url) {
  const kind = String(url.searchParams.get("kind") || "engine");
  const map = (kind === "client-game" || kind === "client-engine") ? (url.searchParams.get("map") || "") : (url.searchParams.get("map") || "Survival_1");
  const partitionId = url.searchParams.get("partitionId") || "";
  const operation = kind === "profile"
    ? "userSettingsProfileRaw"
    : kind === "client-game"
      ? "userSettingsClientGameIni"
      : kind === "client-engine"
        ? "userSettingsClientEngineIni"
        : kind === "engine"
          ? "userSettingsRawEngine"
          : "userSettingsRawGame";
  try {
    const result = await runDune(config, buildDuneArgs(operation, { map, partitionId }), { timeoutMs: 8000, redactOutput: false });
    return json(res, 200, { content: result.stdout || "" });
  } catch (error) {
    return json(res, 500, { error: redact(error?.message || "Unexpected error.") });
  }
}

async function userSettingsValuesRoute(res, url) {
  const scope = String(url.searchParams.get("scope") || "global");
  const map = url.searchParams.get("map") || "Survival_1";
  const partitionId = url.searchParams.get("partitionId") || "";
  const operation = scope === "engine"
    ? "userSettingsEngineValues"
    : scope === "mapEngine"
      ? "userSettingsMapEngineValues"
      : scope === "partitionEngine"
        ? "userSettingsPartitionEngineValues"
    : scope === "partition"
      ? "userSettingsPartitionValues"
      : scope === "map"
        ? "userSettingsMapValues"
        : "userSettingsGlobalValues";
  try {
    const result = await runDune(config, buildDuneArgs(operation, { map, partitionId }), { timeoutMs: 8000 });
    return json(res, 200, { stdout: result.stdout || "" });
  } catch (error) {
    return json(res, 500, { error: redact(error?.message || "Unexpected error.") });
  }
}

async function userSettingsSaveRoute(req, res) {
  const body = await readJson(req);
  const payload = userSettingsTaskPayload(body);
  audit(config, req, "maps.user-settings.save", { scope: payload.scope, map: payload.map, partitionId: payload.partitionId, restartMode: payload.restartMode });
  if (body.deferRestart === true) markDeferredRestartPending(config, deferredRestartLabel(payload));
  if (await maybeQueueRestart(req, res, "maps", "userSettingsSaveAndRestart", payload)) return;
  return json(res, 202, { task: tasks.create("maps", "userSettingsSaveAndRestart", payload) });
}

async function userSettingsResetRoute(req, res) {
  const body = await readJson(req);
  if (body.confirmation !== "RESTORE MAP DEFAULTS") return json(res, 400, { error: "Confirmation phrase required: RESTORE MAP DEFAULTS" });
  const payload = userSettingsTaskPayload({ ...body, values: {} });
  audit(config, req, "maps.user-settings.reset", { scope: payload.scope, map: payload.map, partitionId: payload.partitionId, restartMode: payload.restartMode });
  if (body.deferRestart === true) markDeferredRestartPending(config, deferredRestartLabel(payload));
  if (await maybeQueueRestart(req, res, "maps", "userSettingsResetAndRestart", payload)) return;
  return json(res, 202, { task: tasks.create("maps", "userSettingsResetAndRestart", payload) });
}

async function userSettingsRawWriteRoute(req, res) {
  const body = await readJson(req);
  const payload = userSettingsTaskPayload({ ...body, values: {}, content: String(body.content || "") });
  audit(config, req, "maps.user-settings.raw-write", { scope: payload.scope, map: payload.map, partitionId: payload.partitionId, restartMode: payload.restartMode });
  if (body.deferRestart === true) markDeferredRestartPending(config, deferredRestartLabel(payload));
  if (await maybeQueueRestart(req, res, "maps", "userSettingsRawAndRestart", payload)) return;
  return json(res, 202, { task: tasks.create("maps", "userSettingsRawAndRestart", payload) });
}

function userSettingsTaskPayload(body) {
  const scope = ["engine", "mapEngine", "partitionEngine", "global", "map", "partition", "profile"].includes(String(body.scope || "")) ? String(body.scope) : "map";
  const map = String(body.map || "Survival_1");
  const partitionId = String(body.partitionId || "").trim();
  const values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : {};
  // "Restart later": the admin chose to save (and fully materialize to disk)
  // without restarting yet -- distinct from restart:false, which means the
  // change never needed a restart at all. Both end up restartMode:"none" for
  // the task executor, but only this one marks the deferred-restart-pending
  // indicator (see markDeferredRestartPending below).
  const restart = body.restart === false
    ? { restartMode: "none", restartLabel: "saved configuration" }
    : body.deferRestart === true
      ? { restartMode: "none", restartLabel: "deferred until the next battlegroup restart" }
      : restartPayload(scope, map, partitionId);
  return {
    scope,
    map,
    partitionId,
    values,
    content: String(body.content || ""),
    ...restart
  };
}

// Marker for the generic "settings saved, restart deferred" indicator (Maps
// -> Interactive Modifiers/Advanced). Mirrors the Landsraad-specific
// `landsraad-restart-required` file (set by usersettings.py, read at
// server.js:736) but is written here in Node since it applies to any
// UserEngine/UserGame save, not just Landsraad fields. One flag, not one per
// scope/map -- a second deferred save just overwrites since/label.
function deferredRestartPendingPath(config) {
  return resolve(config.repoRoot, "runtime/generated/settings-restart-pending.json");
}

function markDeferredRestartPending(config, label) {
  const path = deferredRestartPendingPath(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pending: true, since: new Date().toISOString(), label }, null, 2));
}

function readDeferredRestartPending(config) {
  try {
    const parsed = JSON.parse(readFileSync(deferredRestartPendingPath(config), "utf8"));
    if (!parsed?.pending) return { pending: false };
    return { pending: true, since: String(parsed.since || ""), label: String(parsed.label || "") };
  } catch {
    return { pending: false };
  }
}

function deferredRestartLabel(payload) {
  if (payload.scope === "engine" || payload.scope === "mapEngine" || payload.scope === "partitionEngine") return "UserEngine settings";
  if (payload.scope === "global" || payload.scope === "profile") return "UserGame settings";
  return payload.map ? `UserGame settings (${payload.map})` : "UserGame settings";
}

// UserEngine.ini (unlike UserGame.ini) is not per-map: every scope that edits
// it -- "engine" (global), and "mapEngine"/"partitionEngine" (the same file,
// just viewed/edited scoped to one map or partition for convenience) -- has
// to restart every game service to actually apply, not just the map that
// happened to be selected in the editor.
function restartPayload(scope, map, partitionId) {
  if (scope === "profile" || scope === "engine" || scope === "mapEngine" || scope === "partitionEngine" || scope === "global") {
    return { restartMode: "stack", restartLabel: "all game services" };
  }
  const normalizedMap = String(map || "").toLowerCase();
  const normalizedPartition = String(partitionId || "").trim();
  if (normalizedMap === "survival_1" && (!normalizedPartition || normalizedPartition === "1")) {
    return { restartMode: "service", service: "survival", restartLabel: "Survival_1" };
  }
  if ((normalizedMap === "overmap" || normalizedMap.startsWith("deepdesert_")) && (!normalizedPartition || normalizedPartition === "2")) {
    return { restartMode: "service", service: "overmap", restartLabel: "Deep Desert" };
  }
  if (normalizedPartition) {
    return { restartMode: "respawn", target: normalizedPartition, restartLabel: `partition ${normalizedPartition}` };
  }
  return { restartMode: "respawn", target: map, restartLabel: map };
}

async function liveMapMemoryRoute(res) {
  try {
    const snapshot = await memoryBalancer.readLiveSnapshot();
    return json(res, 200, { rows: snapshot.rows, sampledAt: snapshot.sampledAt });
  } catch (error) {
    return json(res, 200, { rows: [], sampledAt: new Date().toISOString(), error: redact(error?.message || "Unexpected error.") });
  }
}

async function autoBackupRoute(req, res) {
  const body = await readJson(req);
  const operation = body.enabled ? "backupAutoEnable" : "backupAutoDisable";
  return task(req, res, "backup", operation, body);
}

async function restartScheduleRoute(req, res) {
  const body = await readJson(req);
  const operation = body.enabled ? "restartScheduleEnable" : "restartScheduleDisable";
  return task(req, res, "server", operation, body);
}

async function ipChangeRestartRoute(req, res) {
  const body = await readJson(req);
  const operation = body.enabled ? "ipChangeRestartEnable" : "ipChangeRestartDisable";
  return task(req, res, "server", operation, body);
}

async function shutdownProtectionRoute(req, res) {
  const body = await readJson(req);
  const operation = body.enabled ? "shutdownProtectionEnable" : "shutdownProtectionDisable";
  return task(req, res, "server", operation, body);
}

async function autoGameUpdateRoute(req, res) {
  const body = await readJson(req);
  if (body.confirmation !== "SAVE AUTO GAME UPDATES") {
    return json(res, 400, { error: "Confirmation phrase required: SAVE AUTO GAME UPDATES" });
  }
  const operation = body.enabled ? "updateAutoEnable" : "updateAutoDisable";
  return task(req, res, "updates", operation, body);
}

async function sietchesUpdateRoute(req, res) {
  const body = await readJson(req);
  const operationByAction = {
    "set-max": "sietchesSetMax",
    "set-active": "sietchesSetActive",
    "set-display": "sietchesSetDisplay",
    "set-password": "sietchesSetPassword",
    "set-settings": "sietchesSetSettings",
    restart: "sietchesRestart",
    sync: "sietchesSync",
    validate: "sietchesValidate",
    reconcile: "sietchesReconcile"
  };
  const operation = operationByAction[String(body.action || "")];
  if (!operation) return json(res, 400, { error: "Unsupported sietch update action" });
  if (operation === "sietchesRestart" && body.confirmation !== "RESTART SIETCH") {
    return json(res, 400, { error: "Confirmation phrase required: RESTART SIETCH" });
  }
  const dangerous = ["sietchesSetActive", "sietchesSetDisplay", "sietchesSetPassword", "sietchesSetSettings", "sietchesReconcile"].includes(operation);
  if (dangerous && body.confirmation !== "UPDATE SIETCHES") return json(res, 400, { error: "Confirmation phrase required: UPDATE SIETCHES" });
  return task(req, res, "maps", operation, body);
}

async function deepDesertUpdateRoute(req, res) {
  const body = await readJson(req);
  if (body.confirmation !== "UPDATE DEEP DESERT") return json(res, 400, { error: "Confirmation phrase required: UPDATE DEEP DESERT" });
  return task(req, res, "maps", "deepdesertAction", body);
}

async function playerTask(req, res, path, operation, phrase = "") {
  const body = await readJson(req);
  if (phrase && body.confirmation !== phrase) {
    return json(res, 400, { error: `Confirmation phrase required: ${phrase}` });
  }
  if (!applyMutationRateLimit(req, res, `players.${operation}`)) return;
  const playerId = decodeURIComponent(path.split("/")[3]);
  const player = await resolvePlayerGrantTarget(playerId);
  if (["adminSetSkillPoints", "adminSetSkillModule"].includes(operation)) {
    if (!player.online) {
      return json(res, 409, { error: "The player must be online to change skills." });
    }
  }
  return task(req, res, "admin", operation, { ...body, playerId });
}

async function playerTeleportRoute(req, res, path) {
  const body = await readJson(req);
  if (!applyMutationRateLimit(req, res, "players.adminTeleport")) return;
  const playerId = decodeURIComponent(path.split("/")[3]);
  try {
    const payload = await duneDb.teleportPlayer(db, playerId, body);
    buildDuneArgs("adminTeleport", payload);
    audit(config, req, "task.adminTeleport", { ...payload, playerId: redact(payload.playerId) });
    return json(res, 202, { task: tasks.create("admin", "adminTeleport", payload), message: payload.message });
  } catch (error) {
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

async function playerIdentityForBan(playerId) {
  const result = await duneDb.listPlayers(db, { q: String(playerId), page: 0, pageSize: 10, includeTotals: false });
  const player = (result.rows || []).find((row) => String(row.actor_id) === String(playerId));
  if (!player) throw Object.assign(new Error("Player not found."), { statusCode: 404 });
  if (!player.fls_id) throw Object.assign(new Error("This player has no stable FLS account ID yet. Ask them to connect once before banning them."), { statusCode: 409 });
  return player;
}

async function playerProfileRoute(res, path) {
  const playerId = decodeURIComponent(path.split("/")[3]);
  return dbJson(res, async () => {
    const profile = await duneDb.playerProfile(db, playerId);
    const fallbackIdentity = profile.player || {};
    const identity = fallbackIdentity.fls_id ? fallbackIdentity : await playerIdentityForBan(playerId).catch(() => fallbackIdentity);
    const ban = playerBanFor(config.repoRoot, identity);
    profile.player = { ...profile.player, is_banned: Boolean(ban), ban: ban || null };
    return profile;
  });
}

async function playerBanRoute(req, res, path) {
  if (!["GET", "POST", "DELETE"].includes(req.method || "GET")) return json(res, 405, { error: "Method not allowed" });
  if (req.method !== "GET" && !applyMutationRateLimit(req, res, `players.${req.method === "POST" ? "ban" : "unban"}`)) return;
  const playerId = decodeURIComponent(path.split("/")[3]);
  try {
    const player = await playerIdentityForBan(playerId);
    const existing = playerBanFor(config.repoRoot, player);
    if (req.method === "GET") return json(res, 200, { ok: true, banned: Boolean(existing), ban: existing });

    if (req.method === "DELETE") {
      const result = unbanPlayer(config.repoRoot, player.fls_id);
      audit(config, req, "players.unban", { playerId, flsId: player.fls_id, characterName: player.character_name, wasBanned: result.wasBanned });
      return json(res, 200, { ...result, banned: false });
    }

    const body = await readJson(req);
    if (body.confirmation !== "BAN PLAYER") return json(res, 400, { error: "Confirmation phrase required: BAN PLAYER" });
    const result = banPlayer(config.repoRoot, player, { reason: body.reason });
    let enforcement = { enforced: false, reason: "offline" };
    if (String(player.actual_online_status || player.online_status || "").toLowerCase() === "online") {
      enforcement = await playerBanEnforcer.enforcePlayer(player);
    }
    audit(config, req, "players.ban", {
      playerId,
      flsId: player.fls_id,
      accountId: player.account_id,
      characterName: player.character_name,
      reason: result.ban.reason,
      alreadyBanned: result.alreadyBanned,
      enforcement: enforcement.enforced
    });
    return json(res, 200, { ...result, banned: true, enforcement });
  } catch (error) {
    const payload = apiErrorPayload(error, 400);
    audit(config, req, req.method === "DELETE" ? "players.unban" : "players.ban", { playerId, ok: false, error: payload.body.error });
    return json(res, payload.status, payload.body);
  }
}

async function carePackageConfigRoute(req, res) {
  const body = await readJson(req);
  if (body.confirmation !== "SAVE CARE PACKAGE") return json(res, 400, { error: "Confirmation phrase required: SAVE CARE PACKAGE" });
  try {
    const saved = saveCarePackageConfig(config, body);
    audit(config, req, "care-package.config", { supported: true, enabled: saved.enabled, version: saved.version, itemCount: saved.items.length, xp: saved.xp });
    return json(res, 200, saved);
  } catch (error) {
    audit(config, req, "care-package.config", { supported: false, error: redact(error?.message || "Unexpected error.") });
    return json(res, 400, { error: redact(error?.message || "Unexpected error.") });
  }
}

async function carePackageEnableRoute(req, res, enabled) {
  const body = await readJson(req);
  const phrase = enabled ? "ENABLE CARE PACKAGE" : "DISABLE CARE PACKAGE";
  if (body.confirmation !== phrase) return json(res, 400, { error: `Confirmation phrase required: ${phrase}` });
  try {
    const saved = enableCarePackage(config, enabled);
    audit(config, req, enabled ? "care-package.enable" : "care-package.disable", { supported: true, version: saved.version });
    return json(res, 200, saved);
  } catch (error) {
    return json(res, 400, { error: redact(error?.message || "Unexpected error.") });
  }
}

async function carePackageGrantRoute(req, res, path) {
  const playerId = decodeURIComponent(path.split("/")[4]);
  try {
    const body = await readJson(req);
    const identity = await resolveCarePackagePlayerIdentity(playerId).catch(() => ({}));
    const result = await grantCarePackage(config, playerId, { ...body, ...identity }, { db });
    audit(config, req, "care-package.grant", { supported: true, playerId, ok: result.ok, grantId: result.id });
    return json(res, result.ok ? 200 : 207, result);
  } catch (error) {
    audit(config, req, "care-package.grant", { supported: false, playerId, error: redact(error?.message || "Unexpected error.") });
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

async function carePackageEligibleRoute(req, res) {
  try {
    const params = new URL(req.url, "http://localhost").searchParams;
    const players = await duneDb.listAllPlayers(db, {});
    if (players.capabilities?.players === false) return json(res, 501, { supported: false, reason: players.reason || "Player list is unavailable" });
    return json(res, 200, carePackageEligiblePlayers(config, players.rows || [], {
      ruleId: params.get("ruleId") || "",
      onlyEligible: params.get("onlyEligible") === "1"
    }));
  } catch (error) {
    const payload = apiErrorPayload(error);
    return json(res, payload.status, { supported: false, ...payload.body });
  }
}

async function carePackageGrantEligibleRoute(req, res) {
  try {
    const players = await duneDb.listAllPlayers(db, {});
    if (players.capabilities?.players === false) return json(res, 501, { supported: false, reason: players.reason || "Player list is unavailable" });
    const result = await grantEligibleCarePackages(config, players.rows || [], await readJson(req), { db });
    audit(config, req, "care-package.grant-eligible", { supported: true, granted: result.granted, skipped: result.skipped, failed: result.failed });
    return json(res, result.failed ? 207 : 200, result);
  } catch (error) {
    audit(config, req, "care-package.grant-eligible", { supported: false, error: redact(error?.message || "Unexpected error.") });
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

async function carePackageRunRoute(req, res) {
  const body = await readJson(req);
  if (body.confirmation !== "RUN CARE PACKAGE SCAN") return json(res, 400, { error: "Confirmation phrase required: RUN CARE PACKAGE SCAN" });
  try {
    const players = await duneDb.listAllPlayers(db, {});
    if (players.capabilities?.players === false) return json(res, 501, { supported: false, reason: players.reason || "Player list is unavailable" });
    const result = await runCarePackageAutoScan(config, players.rows || [], "manual-scan", { db });
    audit(config, req, "care-package.run", { supported: true, ...result, results: undefined });
    return json(res, result.failed ? 207 : 200, result);
  } catch (error) {
    audit(config, req, "care-package.run", { supported: false, error: redact(error?.message || "Unexpected error.") });
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

async function carePackageRetryRoute(req, res, path) {
  const grantId = decodeURIComponent(path.split("/")[4]);
  try {
    const result = await retryCarePackageGrant(config, grantId, await readJson(req), { db });
    audit(config, req, "care-package.retry", { supported: true, grantId, ok: result.ok, retryGrantId: result.id });
    return json(res, result.ok ? 200 : 207, result);
  } catch (error) {
    audit(config, req, "care-package.retry", { supported: false, grantId, error: redact(error?.message || "Unexpected error.") });
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

async function carePackageClearHistoryRoute(req, res) {
  const body = await readJson(req);
  const phrase = "CLEAR GRANT HISTORY";
  if (body.confirmation !== phrase) return json(res, 400, { error: `Confirmation phrase required: ${phrase}` });
  try {
    const result = clearCarePackageHistory(config);
    audit(config, req, "care-package.history-clear", { supported: true, removed: result.removed });
    return json(res, 200, result);
  } catch (error) {
    audit(config, req, "care-package.history-clear", { supported: false, error: redact(error?.message || "Unexpected error.") });
    return json(res, 400, { error: redact(error?.message || "Unexpected error.") });
  }
}

async function resolveCarePackagePlayerIdentity(playerId) {
  const players = await duneDb.listAllPlayers(db, {});
  const rows = players.rows || [];
  const target = String(playerId || "").toLowerCase();
  const player = rows.find((row) => [row.action_player_id, row.funcom_id, row.fls_id, row.account_id, row.actor_id, row.player_pawn_id]
    .some((value) => String(value || "").toLowerCase() === target));
  if (!player) return {};
  return {
    funcomId: player.funcom_id || player.fls_id || player.action_player_id || "",
    flsId: player.fls_id || player.funcom_id || player.action_player_id || "",
    characterName: player.character_name || "",
    actorId: player.actor_id || player.player_pawn_id || "",
    onlineStatus: player.online_status || ""
  };
}

async function resolvePlayerGrantTarget(playerId) {
  const players = await duneDb.listAllPlayers(db, {});
  const rows = players.rows || [];
  const player = findPlayerForLiveAction(rows, playerId);
  if (!player) throw Object.assign(new Error("Player not found."), { statusCode: 404 });
  const actorId = String(player.actor_id || player.player_pawn_id || "");
  if (!actorId) throw Object.assign(new Error("Player has no current actor ID."), { statusCode: 409 });
  await duneDb.resolvePlayerTarget(db, actorId);
  return {
    actionId: String(player.action_player_id || player.funcom_id || player.fls_id || ""),
    actorId,
    characterName: player.character_name || "",
    online: playerIsOnlineForLiveAction(player)
  };
}

function queryParams(url, names) {
  const out = {};
  for (const name of names) out[name] = url.searchParams.get(name) || "";
  return out;
}

async function playerDbMutation(req, res, path, action, phrase, fn) {
  const playerId = decodeURIComponent(path.split("/")[3]);
  return directDbMutation(req, res, action, phrase, (body) => fn(playerId, body), { playerId });
}

async function playerLandsraadQuestRepairRoute(req, res, path) {
  const playerId = decodeURIComponent(path.split("/")[3]);
  return directDbMutation(req, res, "players.repair-landsraad-quests", "REPAIR LANDSRAAD QUESTS", async () => {
    // Diagnose first so a healthy player does not create a pointless full
    // backup. repairLandsraadQuests repeats the diagnosis and offline check
    // transactionally after the backup, so this preflight is never trusted as
    // authorization to write stale state.
    const diagnosis = await duneDb.inspectLandsraadQuestRepairs(db, playerId);
    if (!diagnosis.repairCount) return diagnosis;
    await runDune(config, buildDuneArgs("backupCreate"), { env: { DB_BACKUP_ORIGIN: "restore-safety" } });
    const result = await duneDb.repairLandsraadQuests(db, playerId);
    return { ...result, backupCreated: true };
  }, { playerId });
}

function vehicleRepairRestartCommands(target) {
  if (target.partitionMap === "Survival_1") {
    const payload = { partitionId: target.partitionId };
    return { stop: ["sietchesRestartStop", payload], start: ["sietchesRestartStart", payload] };
  }
  if (target.partitionMap === "Overmap") {
    const payload = { service: "overmap" };
    return { stop: ["restartServiceStop", payload], start: ["restartServiceStart", payload] };
  }
  const payload = { target: String(target.partitionId) };
  return { stop: ["mapsDespawn", payload], start: ["mapsSpawn", payload] };
}

function vehicleRepairTargetLabel(target) {
  return target.partitionMap || target.actorMap || `Partition ${target.partitionId}`;
}

async function runVehicleRepairRestartCommand(command) {
  const [operation, payload] = command;
  return runDune(config, buildDuneArgs(operation, payload), { timeoutMs: 30 * 60 * 1000 });
}

async function restartVehicleRepairTargets(targets) {
  const failures = [];
  for (const target of [...targets].reverse()) {
    try {
      await runVehicleRepairRestartCommand(vehicleRepairRestartCommands(target).start);
    } catch (error) {
      failures.push(`${vehicleRepairTargetLabel(target)}: ${redact(error?.message || "restart failed")}`);
    }
  }
  return failures;
}

async function playerVehicleDecayRepairRoute(req, res, path) {
  const playerId = decodeURIComponent(path.split("/")[3]);
  return directDbMutation(req, res, "players.repair-vehicle-decay", "REPAIR VEHICLE DECAY", async (body) => {
    const inspection = await duneDb.inspectVehicleDecayRepair(db, playerId, body);
    if (!inspection.eligible) return duneDb.repairVehicleDecay(db, playerId, body);
    if (!inspection.restartSupported) {
      throw new Error("Vehicle repair cannot safely verify the affected map servers on this database version.");
    }
    const unresolved = inspection.targets.filter((target) => target.partitionId > 0 && !target.partitionMap);
    if (unresolved.length) {
      throw new Error(`Vehicle repair cannot safely resolve ${unresolved.map(vehicleRepairTargetLabel).join(", ")} to a managed map server.`);
    }

    // Vehicles with no partition are stored/unloaded and safe to update. A
    // connected partition is stopped first so its in-memory vehicle state can
    // no longer overwrite PostgreSQL; only partitions stopped here are started
    // again, preserving maps that were already intentionally down.
    const runningTargets = inspection.targets.filter((target) => target.partitionId > 0 && target.connected);
    const stoppedTargets = [];
    let operationError = null;
    let result = null;
    try {
      for (const target of runningTargets) {
        await runVehicleRepairRestartCommand(vehicleRepairRestartCommands(target).stop);
        stoppedTargets.push(target);
      }
      result = await duneDb.repairVehicleDecay(db, playerId, body);
    } catch (error) {
      operationError = error;
    }

    const restartFailures = await restartVehicleRepairTargets(stoppedTargets);
    if (operationError) {
      if (restartFailures.length) {
        throw new Error(`${operationError.message} Affected map restart also failed: ${restartFailures.join("; ")}`);
      }
      throw operationError;
    }
    return {
      ...result,
      mapServersRestarted: stoppedTargets.length,
      restartedMaps: stoppedTargets.map(vehicleRepairTargetLabel),
      restartFailures,
      message: restartFailures.length
        ? `Vehicle durability was repaired, but some affected maps did not restart: ${restartFailures.join("; ")}`
        : stoppedTargets.length
          ? `Vehicle durability was repaired and ${stoppedTargets.length} affected map server${stoppedTargets.length === 1 ? " was" : "s were"} restarted.`
          : "Vehicle durability was repaired. All affected maps were already stopped."
    };
  }, { playerId });
}

async function playerCharacterRecoveryRoute(req, res, path) {
  const playerId = decodeURIComponent(path.split("/")[3]);
  return directDbMutation(req, res, "players.recover-deleted-character", "RECOVER DELETED CHARACTER", async (body) => {
    const diagnosis = await duneDb.inspectDeletedCharacterRecovery(db, playerId);
    const candidate = diagnosis.candidates.find((row) => row.characterStateId === String(body.candidateId || ""));
    if (!candidate) throw new Error("The selected deleted character state was not found. Reload Player Admin and try again.");
    if (!candidate.recoverable) throw new Error("The selected character cannot be recovered because its replacement event, original actors, or Survival partition could not be verified.");
    if (diagnosis.online) throw new Error("Deleted-character recovery requires the player to be offline.");

    await runDune(config, buildDuneArgs("backupCreate"), { env: { DB_BACKUP_ORIGIN: "restore-safety" } });
    const partitionPayload = { partitionId: candidate.partitionId };
    await runDune(config, buildDuneArgs("sietchesRestartStop", partitionPayload), { timeoutMs: 30 * 60 * 1000 });

    let result;
    let recoveryError;
    try {
      result = await duneDb.recoverDeletedCharacter(db, playerId, candidate.characterStateId);
    } catch (error) {
      recoveryError = error;
    }

    let restartError;
    try {
      await runDune(config, buildDuneArgs("sietchesRestartStart", partitionPayload), { timeoutMs: 30 * 60 * 1000 });
    } catch (error) {
      restartError = error;
    }
    if (recoveryError) throw recoveryError;
    if (restartError) {
      return {
        ...result,
        backupCreated: true,
        mapRestarted: false,
        restartError: redact(restartError?.message || "The Survival partition did not restart."),
        message: `${result.message} Recovery was saved, but the Survival partition did not restart; start it before the player reconnects.`
      };
    }
    return { ...result, backupCreated: true, mapRestarted: true };
  }, { playerId });
}

async function guildPromoteRoute(req, res, path) {
  const parts = path.split("/");
  const guildId = decodeURIComponent(parts[3]);
  const playerId = decodeURIComponent(parts[5]);
  return directDbMutation(req, res, "guilds.promote-member", null, () => duneDb.promoteGuildMember(db, guildId, playerId), { guildId, playerId });
}

async function guildDemoteRoute(req, res, path) {
  const parts = path.split("/");
  const guildId = decodeURIComponent(parts[3]);
  const playerId = decodeURIComponent(parts[5]);
  return directDbMutation(req, res, "guilds.demote-member", null, () => duneDb.demoteGuildMember(db, guildId, playerId), { guildId, playerId });
}

async function guildAddMemberRoute(req, res, path) {
  const guildId = decodeURIComponent(path.split("/")[3]);
  return directDbMutation(req, res, "guilds.add-member", null, async (body) => {
    const settings = await runDune(config, buildDuneArgs("userSettingsMapValues", { map: "Survival_1" }), { timeoutMs: 8000 });
    const maxMembers = parseEffectiveGuildMemberLimit(settings.stdout);
    return duneDb.addGuildMember(db, guildId, body.playerId, body.roleId, maxMembers);
  }, { guildId });
}

async function guildRemoveMemberRoute(req, res, path) {
  const parts = path.split("/");
  const guildId = decodeURIComponent(parts[3]);
  const playerId = decodeURIComponent(parts[5]);
  return directDbMutation(req, res, "guilds.remove-member", null, () => duneDb.removeGuildMember(db, guildId, playerId), { guildId, playerId });
}

async function guildDisbandRoute(req, res, path) {
  const guildId = decodeURIComponent(path.split("/")[3]);
  return directDbMutation(req, res, "guilds.disband", "DISBAND GUILD", () => duneDb.disbandGuild(db, guildId), { guildId });
}

async function inventoryDeleteRoute(req, res, path) {
  const parts = path.split("/");
  const playerId = decodeURIComponent(parts[3]);
  const itemId = decodeURIComponent(parts[5]);
  return directDbMutation(req, res, "players.inventory-delete", "DELETE ITEM", () => duneDb.deleteInventoryItem(db, playerId, itemId), { playerId, itemId });
}

async function inventoryUpdateRoute(req, res, path) {
  const parts = path.split("/");
  const playerId = decodeURIComponent(parts[3]);
  const itemId = decodeURIComponent(parts[5]);
  return directDbMutation(req, res, "players.inventory-update", "SAVE ITEM", (body) => duneDb.updateInventoryItem(db, playerId, itemId, body.values), { playerId, itemId });
}

async function storageGiveItemRoute(req, res, path) {
  const storageId = decodeURIComponent(path.split("/")[3]);
  return directDbMutation(req, res, "storage.give-item", "GIVE ITEM TO STORAGE", async (body) => {
    const resolved = resolveCatalogItem(config.repoRoot, body);
    // itemVolume defaults to 0 for any item without catalogued volume data
    // (most weapons/gear/schematics), which giveItemToStorage treats as
    // "skip the volume check" -- the same as it always has for those items.
    // Only items the catalog actually has a volume for (raw/refined
    // resources, components) gain the new volume enforcement.
    const itemVolume = resolved.volume || resolveItemVolume(config.repoRoot, resolved.itemId);
    return duneDb.giveItemToStorage(db, storageId, { ...body, templateId: resolved.itemId, itemVolume });
  }, { storageId });
}

function writeJsonAttachment(res, data, filename) {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`
  });
  res.end(JSON.stringify(data));
}

async function blueprintExportRoute(req, res, path) {
  const idPart = decodeURIComponent(path.split("/")[3]);
  const blueprintId = Number(idPart);
  if (!Number.isFinite(blueprintId) || blueprintId < 1) return json(res, 400, { error: "Invalid blueprint ID" });
  try {
    const data = await exportBlueprint(db, blueprintId);
    const filename = data.name ? `${sanitizeFilename(data.name, "blueprint")}.json` : `blueprint_${blueprintId}.json`;
    writeJsonAttachment(res, data, filename);
  } catch (error) {
    const status = error.unsupported ? 501 : 500;
    return json(res, status, { ok: false, error: redact(error?.message || "Unexpected error.") });
  }
}

async function baseBlueprintDownloadRoute(req, res, path) {
  const idPart = decodeURIComponent(path.split("/")[3]);
  const baseId = Number(idPart);
  if (!Number.isFinite(baseId) || baseId < 1) return json(res, 400, { error: "Invalid base ID" });
  try {
    const data = await duneDb.exportBaseAsBlueprint(db, baseId);
    const owner = sanitizeFilename(data.owner_name || "unknown_player", "unknown_player").replace(/\s+/g, "_");
    const filename = `${owner}_base_${baseId}.json`;
    writeJsonAttachment(res, data, filename);
  } catch (error) {
    const status = error.unsupported ? 501 : 500;
    return json(res, status, { ok: false, error: redact(error?.message || "Unexpected error.") });
  }
}

// A base with a delete queued is frozen from every other write: the hazard a
// queued delete exists to avoid (a live server overwriting the write before
// the flush) applies just as much to a refill or permission edit racing that
// same delete, and reasoning about ordering between independent queues is
// worse than "a base marked for deletion does not change in the meantime."
function baseDeletePending(baseId) {
  return duneDb.listQueuedBaseDeletes(config.repoRoot).some((entry) => entry.baseId === baseId);
}

const BASE_DELETE_PENDING_MESSAGE = "This base has a pending delete queued and cannot be modified. Cancel the delete first.";

// A backed-up base (picked up via the game's base-backup tool) is excluded
// from listBases -- see duneDb.baseIsBackedUp -- because it has no owner and
// its structural rows are only awaiting redeploy or eventual cleanup. A
// direct route call (or a stale bookmarked base id) must not be able to
// modify it just because it slipped past the panel's own filtering.
async function baseBackedUp(baseId) {
  return verifyBaseBackupState(duneDb, db, baseId);
}

const BASE_BACKED_UP_MESSAGE = "This base was picked up into a backup and is no longer claimed. It cannot be modified until the player redeploys it.";

// Refilling fuel/water moments before deleting the base is pointless and
// pollutes the audit log with writes about to be destroyed anyway. Best
// effort: a base with nothing queued throws, which is fine to swallow here.
// Every queue keyed on this base, so a delete does not leave writes aimed at
// rows that are about to disappear. Child access belongs here too: without it
// a queued permission change outlives its base and retries until it exhausts
// its attempts, and the route's baseDeletePending guard can be sidestepped by
// queueing the permission change first and the delete second.
function cancelPendingRefillsForBase(baseId) {
  try { duneDb.cancelQueuedGeneratorRefill(config.repoRoot, baseId); } catch {}
  try { duneDb.cancelQueuedWaterRefill(config.repoRoot, baseId); } catch {}
  try { duneDb.cancelQueuedBaseChildAccess(config.repoRoot, baseId); } catch {}
}

async function baseDeleteRoute(req, res, path) {
  const baseId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isFinite(baseId) || baseId < 1) return json(res, 400, { error: "Invalid base ID" });
  if (await baseBackedUp(baseId)) return json(res, 409, { error: BASE_BACKED_UP_MESSAGE });
  return directDbMutation(req, res, "bases.delete", "DELETE BASE", async () => {
    // Reserve the lock synchronously, before the first await: baseDeletePending
    // is a file read, and every other mutation route checks it before doing
    // any of its own work, so a request for this same base landing between
    // "resolve write-safety" and "record the queue entry" below would
    // otherwise read the queue as empty and slip through. This placeholder
    // (map/partitionId unresolved yet) closes that gap immediately; it is
    // either replaced with the real entry (queued path) or removed in the
    // finally below (immediate path, success or failure).
    duneDb.queueBaseDelete(config.repoRoot, { baseId, map: "", partitionId: 0 });
    let queued = false;
    try {
      const target = await duneDb.baseRefillTarget(db, baseId);
      // Same hazard as a refill: a live game server can rewrite its own copy
      // of this base back to Postgres before the delete is ever seen. Queue
      // it instead and let the flush tick apply it once that map is down.
      if (target.queueSupported && !target.writeSafeNow) {
        cancelPendingRefillsForBase(baseId);
        const entry = duneDb.queueBaseDelete(config.repoRoot, {
          baseId,
          map: target.map,
          partitionId: target.partitionId
        });
        queued = true;
        return { ok: true, queued: true, ...entry };
      }
      // Mandatory safety backup before any delete SQL runs, exactly like the
      // raw "Database Query" tool already does for any destructive query --
      // see databaseQuery below. If this throws, deleteBaseCompletely is
      // never called and nothing is touched.
      await runDune(config, buildDuneArgs("backupCreate"), { env: { DB_BACKUP_ORIGIN: "base-delete" } });
      const result = await duneDb.deleteBaseCompletely(db, baseId);
      // The queued path cancels these before queueing; the immediate path has
      // to do it after the rows are gone, or a queue entry outlives its base
      // and retries against ids that no longer resolve.
      cancelPendingRefillsForBase(baseId);
      return { ...result, backupCreated: true };
    } finally {
      if (!queued) {
        try { duneDb.cancelQueuedBaseDelete(config.repoRoot, baseId); } catch {}
      }
    }
  }, { baseId });
}

async function baseCancelQueuedDeleteRoute(req, res, path) {
  const baseId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isFinite(baseId) || baseId < 1) return json(res, 400, { error: "Invalid base ID" });
  return directDbMutation(req, res, "bases.cancel-queued-delete", null,
    () => duneDb.cancelQueuedBaseDelete(config.repoRoot, baseId), { baseId });
}

// Mirrors pendingGeneratorRefillsRoute.
async function pendingBaseDeletesRoute(res) {
  const pending = duneDb.listQueuedBaseDeletes(config.repoRoot);
  const targets = pending.length
    ? await duneDb.partitionRestartTargets(db).catch(() => new Map())
    : new Map();
  const byTarget = new Map();
  for (const entry of pending) {
    const map = entry.map || "Unknown";
    const key = `${map}|${entry.partitionId}`;
    const target = targets.get(entry.partitionId);
    const group = byTarget.get(key) || {
      map,
      partitionId: entry.partitionId,
      partitionMap: target?.map || "",
      dimensionIndex: target?.dimensionIndex ?? 0,
      count: 0
    };
    group.count += 1;
    byTarget.set(key, group);
  }
  return json(res, 200, {
    supported: true,
    total: pending.length,
    pending,
    byTarget: [...byTarget.values()].sort((a, b) => a.map.localeCompare(b.map) || a.partitionId - b.partitionId)
  });
}

async function baseRefillGeneratorsRoute(req, res, path) {
  const baseId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isFinite(baseId) || baseId < 1) return json(res, 400, { error: "Invalid base ID" });
  if (baseDeletePending(baseId)) return json(res, 409, { error: BASE_DELETE_PENDING_MESSAGE });
  if (await baseBackedUp(baseId)) return json(res, 409, { error: BASE_BACKED_UP_MESSAGE });
  // No confirmation phrase: refilling is additive and reversible, unlike the
  // deletes and overwrites that phrase-gate. Still rate limited and audited.
  return directDbMutation(req, res, "bases.refill-generators", null, async () => {
    const target = await duneDb.baseRefillTarget(db, baseId);
    // A live game server rewrites its own copy of a base back to Postgres on a
    // timer, so refilling a running map now can be overwritten before anyone
    // sees the fuel. Record it instead and let the flush tick apply it once
    // that map is down.
    if (target.queueSupported && !target.writeSafeNow) {
      const entry = duneDb.queueGeneratorRefill(config.repoRoot, {
        baseId,
        map: target.map,
        partitionId: target.partitionId
      });
      return { ok: true, queued: true, ...entry };
    }
    return duneDb.refillBaseGenerators(db, config.repoRoot, baseId);
  }, { baseId });
}

async function basePermissionsRoute(res, path) {
  const baseId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isFinite(baseId) || baseId < 1) return json(res, 400, { error: "Invalid base ID" });
  try {
    return json(res, 200, { supported: true, ...(await duneDb.listBasePermissions(db, baseId)) });
  } catch (error) {
    const status = error.unsupported ? 501 : 400;
    return json(res, status, { supported: false, error: redact(error?.message || "Unexpected error."), reason: redact(error?.message || "Unexpected error.") });
  }
}

async function baseLandClaimRoute(res, path) {
  const baseId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isInteger(baseId) || baseId < 1 || baseId > Number.MAX_SAFE_INTEGER) {
    return json(res, 400, { error: "Invalid base ID" });
  }
  try {
    return json(res, 200, { supported: true, ...(await duneDb.getBaseLandClaim(db, baseId)) });
  } catch (error) {
    const status = error.unsupported ? 501 : 400;
    return json(res, status, {
      supported: false,
      error: redact(error?.message || "Unexpected error."),
      reason: redact(error?.message || "Unexpected error.")
    });
  }
}

async function baseUpdateLandClaimRoute(req, res, path) {
  const baseId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isInteger(baseId) || baseId < 1 || baseId > Number.MAX_SAFE_INTEGER) {
    return json(res, 400, { error: "Invalid base ID" });
  }
  if (baseDeletePending(baseId)) return json(res, 409, { error: BASE_DELETE_PENDING_MESSAGE });
  if (await baseBackedUp(baseId)) return json(res, 409, { error: BASE_BACKED_UP_MESSAGE });
  return directDbMutation(req, res, "bases.update-land-claim", "EDIT LAND CLAIM", async (body) => {
    await runDune(config, buildDuneArgs("backupCreate"), { env: { DB_BACKUP_ORIGIN: "land-claim-editor" } });
    const result = await duneDb.updateBaseLandClaim(db, baseId, body);
    return { ...result, backupCreated: true };
  }, { baseId });
}

async function basePermissionCandidatesRoute(res, url) {
  try {
    const rows = await duneDb.basePermissionCandidates(db, {
      q: url.searchParams.get("q") || "",
      limit: url.searchParams.get("limit") || 25
    });
    return json(res, 200, { supported: true, rows });
  } catch (error) {
    const status = error.unsupported ? 501 : 400;
    return json(res, status, { supported: false, rows: [], error: redact(error?.message || "Unexpected error."), reason: redact(error?.message || "Unexpected error.") });
  }
}

// No confirmation phrase, matching the guild mutations and the refill route:
// permissions are reversible from this same editor. Still rate limited and
// audited -- this writes to player property.
//
// The cap is read from live server config on every save rather than baked in,
// exactly as guildAddMemberRoute resolves the guild member limit. Raising it is
// then a settings edit, not a release.
async function baseSetPermissionsRoute(req, res, path) {
  const baseId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isFinite(baseId) || baseId < 1) return json(res, 400, { error: "Invalid base ID" });
  if (baseDeletePending(baseId)) return json(res, 409, { error: BASE_DELETE_PENDING_MESSAGE });
  if (await baseBackedUp(baseId)) return json(res, 409, { error: BASE_BACKED_UP_MESSAGE });
  return directDbMutation(req, res, "bases.set-permissions", null, async (body) => {
    const settings = await runDune(config, buildDuneArgs("userSettingsMapValues", { map: "Survival_1" }), { timeoutMs: 8000 });
    const maxPermissions = parseEffectivePermissionLimit(settings.stdout);
    return duneDb.setBasePermissions(db, baseId, body.entries, maxPermissions);
  }, { baseId });
}

async function baseChildAccessRoute(res, path) {
  const baseId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isInteger(baseId) || baseId < 1 || baseId > Number.MAX_SAFE_INTEGER) return json(res, 400, { error: "Invalid base ID" });
  try {
    return json(res, 200, { supported: true, ...(await duneDb.listBaseChildAccess(db, baseId)) });
  } catch (error) {
    return json(res, 500, { supported: false, rows: [], error: redact(error?.message || "Unexpected error."), reason: redact(error?.message || "Unexpected error.") });
  }
}

// Queued instead of written immediately when the base's map is currently
// live. Unlike the refill queues this is not about an autosave race -- the
// write would stick -- but a running map never picks up an access_level
// change, so an immediate write leaves the console showing a level the game
// does not enforce until the next restart. Deferring to the map-down window
// keeps the two in agreement. See docs/console/base-child-permissions.md.
async function baseSetChildAccessRoute(req, res, path) {
  const baseId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isInteger(baseId) || baseId < 1 || baseId > Number.MAX_SAFE_INTEGER) return json(res, 400, { error: "Invalid base ID" });
  if (baseDeletePending(baseId)) return json(res, 409, { error: BASE_DELETE_PENDING_MESSAGE });
  if (await baseBackedUp(baseId)) return json(res, 409, { error: BASE_BACKED_UP_MESSAGE });
  return directDbMutation(req, res, "bases.set-child-access", "SET CHILD ACCESS", async (body) => {
    const target = await duneDb.baseRefillTarget(db, baseId);
    if (target.queueSupported && !target.writeSafeNow) {
      const entry = duneDb.queueBaseChildAccess(config.repoRoot, {
        baseId,
        map: target.map,
        partitionId: target.partitionId,
        updates: body.updates
      });
      return { ok: true, queued: true, ...entry };
    }
    return duneDb.setBaseChildAccessLevels(db, baseId, body.updates);
  }, { baseId });
}

async function baseCancelQueuedChildAccessRoute(req, res, path) {
  const baseId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isInteger(baseId) || baseId < 1 || baseId > Number.MAX_SAFE_INTEGER) return json(res, 400, { error: "Invalid base ID" });
  return directDbMutation(req, res, "bases.cancel-queued-child-access", null,
    () => duneDb.cancelQueuedBaseChildAccess(config.repoRoot, baseId), { baseId });
}

// Mirrors pendingWaterRefillsRoute.
async function pendingChildAccessRoute(res) {
  const pending = duneDb.listQueuedBaseChildAccess(config.repoRoot);
  const targets = pending.length
    ? await duneDb.partitionRestartTargets(db).catch(() => new Map())
    : new Map();
  const byTarget = new Map();
  for (const entry of pending) {
    const map = entry.map || "Unknown";
    const key = `${map}|${entry.partitionId}`;
    const target = targets.get(entry.partitionId);
    const group = byTarget.get(key) || {
      map,
      partitionId: entry.partitionId,
      partitionMap: target?.map || "",
      dimensionIndex: target?.dimensionIndex ?? 0,
      count: 0
    };
    group.count += 1;
    byTarget.set(key, group);
  }
  return json(res, 200, {
    supported: true,
    total: pending.length,
    pending,
    byTarget: [...byTarget.values()].sort((a, b) => a.map.localeCompare(b.map) || a.partitionId - b.partitionId)
  });
}

async function baseSystemCustodianRoute(req, res, path) {
  const baseId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isFinite(baseId) || baseId < 1) return json(res, 400, { error: "Invalid base ID" });
  if (baseDeletePending(baseId)) return json(res, 409, { error: BASE_DELETE_PENDING_MESSAGE });
  if (await baseBackedUp(baseId)) return json(res, 409, { error: BASE_BACKED_UP_MESSAGE });
  return directDbMutation(req, res, "bases.transfer-system-custodian", null, async () => {
    const settings = await runDune(config, buildDuneArgs("userSettingsMapValues", { map: "Survival_1" }), { timeoutMs: 8000 });
    const maxPermissions = parseEffectivePermissionLimit(settings.stdout);
    const custodian = await duneDb.permissionSystemCustodian(db);
    if (custodian.canCreate) await ensureCarePackageServerPersona(db);
    const transferred = await duneDb.transferBaseToSystemCustodian(db, baseId, maxPermissions);
    // A queued permission change carries no ownership snapshot, so one queued
    // against the previous owner would otherwise apply to the base after it
    // changed hands. Discard it rather than replay an authorization decision
    // that was made about a different owner.
    try { duneDb.cancelQueuedBaseChildAccess(config.repoRoot, baseId); } catch {}
    return transferred;
  }, { baseId });
}

// Vehicles are their own permission actor (dune.vehicles.id = dune.actors.id),
// so there is no base-backed-up equivalent to check here -- a vehicle has no
// "picked up" state these routes need to guard against. (It does now have a
// delete-pending state -- see vehicleDeletePending -- checked by the mutation
// routes below, not this read-only one.) The id guard matches intParam's
// contract (see baseWaterRoute/baseInventoryRoute), so a genuine failure in
// the catch is honestly ours.
async function vehiclePermissionsRoute(res, path) {
  const vehicleId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isInteger(vehicleId) || vehicleId < 1 || vehicleId > Number.MAX_SAFE_INTEGER) {
    return json(res, 400, { error: "Invalid vehicle ID" });
  }
  try {
    return json(res, 200, { supported: true, ...(await duneDb.listVehiclePermissions(db, vehicleId)) });
  } catch (error) {
    return json(res, 500, { supported: false, error: redact(error?.message || "Unexpected error."), reason: redact(error?.message || "Unexpected error.") });
  }
}

// One vehicle's cargo hold, read-only -- so no directDbMutation wrapper and
// no confirmation phrase, same as baseContainerSlotsRoute. Same id guard as
// vehiclePermissionsRoute above, for the same reason. A schema without the
// inventory tables comes back as a 200 carrying supported:false rather than
// an error status, so the overlay's Retry always means something real.
// repoRoot is passed through only to resolve each item's catalog icon.
async function vehicleStorageRoute(res, path) {
  const vehicleId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isInteger(vehicleId) || vehicleId < 1 || vehicleId > Number.MAX_SAFE_INTEGER) {
    return json(res, 400, { error: "Invalid vehicle ID" });
  }
  try {
    // deleteSafety rides along the same way baseContainerSlotsRoute carries
    // its own: it is what lets the overlay disable and explain its delete
    // controls before the operator clicks. The authoritative refusal still
    // happens atomically inside the delete transaction.
    const storage = await duneDb.vehicleStorage(db, vehicleId, { repoRoot: config.repoRoot });
    return json(res, 200, {
      ...storage,
      deleteSafety: await duneDb.vehicleStorageDeleteSafety(db, vehicleId)
    });
  } catch (error) {
    return json(res, 500, { supported: false, error: redact(error?.message || "Unexpected error."), reason: redact(error?.message || "Unexpected error.") });
  }
}

// ---------------------------------------------------------------------------
// Vehicle cargo deletion.
//
// Unlike the base container delete family there is no route-level safety
// pre-check here. The base version's baseContainerDeleteSafety(baseId) call
// is documented dead code on those routes -- the group always defaults to
// "storage", so the branch can never fire, and the real check happens
// atomically downstream. This mirrors the working half of that design without
// the wart: duneDb.resolveVehicleCargoHold takes the lock and refuses a
// blocked vehicle inside the transaction, and vehicleStorageDeleteSafety is
// carried on the READ so the UI can gate ahead of the click.
//
// No safety backup either, unlike vehicleDeleteRoute: these are item rows, not
// a whole vehicle.
// ---------------------------------------------------------------------------

// Matches bigintParam's contract rather than Number()'ing: an item id past
// Number.MAX_SAFE_INTEGER silently rounds, and a destructive request that
// retargets a different row is the worst failure mode available here.
function validVehicleStorageItemId(itemId) {
  return /^[1-9][0-9]*$/.test(itemId) && BigInt(itemId) <= 9223372036854775807n;
}

function parseVehicleStoragePath(path) {
  const vehicleId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isInteger(vehicleId) || vehicleId < 1 || vehicleId > Number.MAX_SAFE_INTEGER) return null;
  return vehicleId;
}

async function vehicleStorageItemDeleteRoute(req, res, path) {
  const vehicleId = parseVehicleStoragePath(path);
  const itemId = decodeURIComponent(path.split("/")[6]);
  if (vehicleId === null || !validVehicleStorageItemId(itemId)) {
    return json(res, 400, { error: "Invalid vehicle or item ID" });
  }
  if (vehicleDeletePending(vehicleId)) return json(res, 409, { error: VEHICLE_DELETE_PENDING_MESSAGE });
  return directDbMutation(req, res, "vehicles.storage-item-delete", "DELETE ITEM", async (body) => {
    const count = body?.count === undefined || body?.count === null ? null : Number(body.count);
    return duneDb.deleteVehicleStorageItem(db, vehicleId, itemId, { count });
  }, { vehicleId, itemId });
}

async function vehicleStorageItemsDeleteRoute(req, res, path) {
  const vehicleId = parseVehicleStoragePath(path);
  if (vehicleId === null) return json(res, 400, { error: "Invalid vehicle ID" });
  if (vehicleDeletePending(vehicleId)) return json(res, 409, { error: VEHICLE_DELETE_PENDING_MESSAGE });
  return directDbMutation(req, res, "vehicles.storage-items-delete", "DELETE ITEMS", async (body) => {
    return duneDb.deleteMultipleVehicleStorageItems(db, vehicleId, body?.itemIds);
  }, { vehicleId });
}

async function vehicleStorageAllItemsDeleteRoute(req, res, path) {
  const vehicleId = parseVehicleStoragePath(path);
  if (vehicleId === null) return json(res, 400, { error: "Invalid vehicle ID" });
  if (vehicleDeletePending(vehicleId)) return json(res, 409, { error: VEHICLE_DELETE_PENDING_MESSAGE });
  return directDbMutation(req, res, "vehicles.storage-all-items-delete", "DELETE ALL ITEMS", async () => {
    return duneDb.deleteAllVehicleStorageItems(db, vehicleId);
  }, { vehicleId });
}

async function vehiclePermissionCandidatesRoute(res, url) {
  try {
    const rows = await duneDb.vehiclePermissionCandidates(db, {
      q: url.searchParams.get("q") || "",
      limit: url.searchParams.get("limit") || 25
    });
    return json(res, 200, { supported: true, rows });
  } catch (error) {
    return json(res, 500, { supported: false, rows: [], error: redact(error?.message || "Unexpected error."), reason: redact(error?.message || "Unexpected error.") });
  }
}

// No confirmation phrase, matching baseSetPermissionsRoute: reversible from
// this same editor. Still rate limited and audited -- this writes to player
// property. The cap is read from live server config on every save, same as
// the base route.
async function vehicleSetPermissionsRoute(req, res, path) {
  const vehicleId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isInteger(vehicleId) || vehicleId < 1 || vehicleId > Number.MAX_SAFE_INTEGER) {
    return json(res, 400, { error: "Invalid vehicle ID" });
  }
  if (vehicleDeletePending(vehicleId)) return json(res, 409, { error: VEHICLE_DELETE_PENDING_MESSAGE });
  return directDbMutation(req, res, "vehicles.set-permissions", null, async (body) => {
    const settings = await runDune(config, buildDuneArgs("userSettingsMapValues", { map: "Survival_1" }), { timeoutMs: 8000 });
    const maxPermissions = parseEffectivePermissionLimit(settings.stdout);
    return duneDb.setVehiclePermissions(db, vehicleId, body.entries, maxPermissions);
  }, { vehicleId });
}

// No backed-up guard (a vehicle has no such state), but it does check
// delete-pending now -- transferring ownership on a vehicle about to be
// destroyed is exactly the kind of write the pending-delete freeze exists to
// avoid racing.
async function vehicleSystemCustodianRoute(req, res, path) {
  const vehicleId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isInteger(vehicleId) || vehicleId < 1 || vehicleId > Number.MAX_SAFE_INTEGER) {
    return json(res, 400, { error: "Invalid vehicle ID" });
  }
  if (vehicleDeletePending(vehicleId)) return json(res, 409, { error: VEHICLE_DELETE_PENDING_MESSAGE });
  return directDbMutation(req, res, "vehicles.transfer-system-custodian", null, async () => {
    const settings = await runDune(config, buildDuneArgs("userSettingsMapValues", { map: "Survival_1" }), { timeoutMs: 8000 });
    const maxPermissions = parseEffectivePermissionLimit(settings.stdout);
    const custodian = await duneDb.permissionSystemCustodian(db);
    if (custodian.canCreate) await ensureCarePackageServerPersona(db);
    return duneDb.transferVehicleToSystemCustodian(db, vehicleId, maxPermissions);
  }, { vehicleId });
}

// Mirrors baseDeletePending: a vehicle with a delete queued is frozen from
// every other write, for the same reason -- the hazard the queue exists to
// avoid (a live server overwriting the write before the flush) applies just
// as much to a permission edit or refuel racing that same delete.
function vehicleDeletePending(vehicleId) {
  return duneDb.listQueuedVehicleDeletes(config.repoRoot).some((entry) => entry.vehicleId === vehicleId);
}

const VEHICLE_DELETE_PENDING_MESSAGE = "This vehicle has a pending delete queued and cannot be modified. Cancel the delete first.";

// Mirrors baseDeleteRoute. No baseBackedUp equivalent to check -- a vehicle
// has no "picked up" state.
async function vehicleDeleteRoute(req, res, path) {
  const vehicleId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isInteger(vehicleId) || vehicleId < 1 || vehicleId > Number.MAX_SAFE_INTEGER) {
    return json(res, 400, { error: "Invalid vehicle ID" });
  }
  return directDbMutation(req, res, "vehicles.delete", "DELETE VEHICLE", async () => {
    // Reserve the lock synchronously, before the first await -- same
    // race-closing reasoning as baseDeleteRoute's placeholder queue entry.
    duneDb.queueVehicleDelete(config.repoRoot, { vehicleId, map: "", partitionId: 0 });
    let queued = false;
    try {
      const target = await duneDb.vehicleWriteTarget(db, vehicleId);
      if (target.queueSupported && !target.writeSafeNow) {
        const entry = duneDb.queueVehicleDelete(config.repoRoot, {
          vehicleId,
          map: target.map,
          partitionId: target.partitionId
        });
        queued = true;
        return { ok: true, queued: true, ...entry };
      }
      // Mandatory safety backup before any delete SQL runs, exactly like
      // baseDeleteRoute. If this throws, deleteVehicleCompletely is never
      // called and nothing is touched.
      await runDune(config, buildDuneArgs("backupCreate"), { env: { DB_BACKUP_ORIGIN: "vehicle-delete" } });
      const result = await duneDb.deleteVehicleCompletely(db, vehicleId);
      return { ...result, backupCreated: true };
    } finally {
      if (!queued) {
        try { duneDb.cancelQueuedVehicleDelete(config.repoRoot, vehicleId); } catch {}
      }
    }
  }, { vehicleId });
}

async function vehicleCancelQueuedDeleteRoute(req, res, path) {
  const vehicleId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isInteger(vehicleId) || vehicleId < 1 || vehicleId > Number.MAX_SAFE_INTEGER) {
    return json(res, 400, { error: "Invalid vehicle ID" });
  }
  return directDbMutation(req, res, "vehicles.cancel-queued-delete", null,
    () => duneDb.cancelQueuedVehicleDelete(config.repoRoot, vehicleId), { vehicleId });
}

// Mirrors pendingBaseDeletesRoute.
async function pendingVehicleDeletesRoute(res) {
  const pending = duneDb.listQueuedVehicleDeletes(config.repoRoot);
  const targets = pending.length
    ? await duneDb.partitionRestartTargets(db).catch(() => new Map())
    : new Map();
  const byTarget = new Map();
  for (const entry of pending) {
    const map = entry.map || "Unknown";
    const key = `${map}|${entry.partitionId}`;
    const target = targets.get(entry.partitionId);
    const group = byTarget.get(key) || {
      map,
      partitionId: entry.partitionId,
      partitionMap: target?.map || "",
      dimensionIndex: target?.dimensionIndex ?? 0,
      count: 0
    };
    group.count += 1;
    byTarget.set(key, group);
  }
  return json(res, 200, {
    supported: true,
    total: pending.length,
    pending,
    byTarget: [...byTarget.values()].sort((a, b) => a.map.localeCompare(b.map) || a.partitionId - b.partitionId)
  });
}

async function baseCancelQueuedRefillRoute(req, res, path) {
  const baseId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isFinite(baseId) || baseId < 1) return json(res, 400, { error: "Invalid base ID" });
  return directDbMutation(req, res, "bases.cancel-queued-refill", null,
    () => duneDb.cancelQueuedGeneratorRefill(config.repoRoot, baseId), { baseId });
}

// Grouped per (map, partition) so the Bases banner, the Maps panel badges, and
// the battlegroup buttons all read the same counts from one call. Grouping by
// map alone is not enough: a Sietch partition of Survival_1 needs its own
// container restarted, which restarting the map's primary service would not do.
//
// Each group also carries the partition's world_partition identity, resolved
// here rather than stored on the queue entry: the entry's own map name comes
// from dune.actors and is a different namespace (see partitionRestartTargets),
// resolving live keeps entries queued before this existed working, and it cannot
// go stale if a partition is reassigned.
async function pendingGeneratorRefillsRoute(res) {
  const pending = duneDb.listQueuedGeneratorRefills(config.repoRoot);
  // Counts must still render when the database is unreachable -- which is
  // precisely when a battlegroup is down and the queue matters most.
  const targets = pending.length
    ? await duneDb.partitionRestartTargets(db).catch(() => new Map())
    : new Map();
  const byTarget = new Map();
  for (const entry of pending) {
    const map = entry.map || "Unknown";
    const key = `${map}|${entry.partitionId}`;
    const target = targets.get(entry.partitionId);
    const group = byTarget.get(key) || {
      map,
      partitionId: entry.partitionId,
      partitionMap: target?.map || "",
      dimensionIndex: target?.dimensionIndex ?? 0,
      count: 0
    };
    group.count += 1;
    byTarget.set(key, group);
  }
  return json(res, 200, {
    supported: true,
    total: pending.length,
    pending,
    byTarget: [...byTarget.values()].sort((a, b) => a.map.localeCompare(b.map) || a.partitionId - b.partitionId)
  });
}

// Enrollment state for the Bases panel's auto-refill toggle. Like the pending
// counts above, this still answers when the database is unreachable: the
// enrollment list is a file, and only `supported` needs a live connection.
async function basesAutoRefillStateRoute(res) {
  const supported = await duneDb.supportsGeneratorRefillQueue(db).catch(() => false);
  return json(res, 200, { supported, ...autoRefillPublicState(config.repoRoot) });
}

// Console-owned configuration rather than a database mutation, so this follows
// the settings routes (plain handler plus an explicit audit) instead of
// directDbMutation's confirmation-phrase machinery.
async function baseAutoRefillToggleRoute(req, res, path) {
  const baseId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isFinite(baseId) || baseId < 1) return json(res, 400, { error: "Invalid base ID" });
  const body = await readJson(req);
  if (typeof body.enabled !== "boolean") {
    return json(res, 400, { error: "Auto-refill enabled must be true or false." });
  }
  // Only enabling is blocked -- turning auto-refill off is harmless and does
  // not race a pending delete the way a new automated write would.
  if (body.enabled && baseDeletePending(baseId)) return json(res, 409, { error: BASE_DELETE_PENDING_MESSAGE });
  if (body.enabled && await baseBackedUp(baseId)) return json(res, 409, { error: BASE_BACKED_UP_MESSAGE });
  // Checked on the server too, not just hidden in the UI. Without
  // dune.world_partition a queued refill cannot wait for a safe window, so an
  // automated refill would write straight into a possibly-live base.
  if (body.enabled && !(await duneDb.supportsGeneratorRefillQueue(db).catch(() => false))) {
    return json(res, 501, {
      error: "Auto-refill needs the pending-refill queue, which requires dune.world_partition on this database."
    });
  }
  try {
    const result = setBaseAutoRefill(config.repoRoot, baseId, body.enabled);
    audit(config, req, "bases.auto-refill", { baseId, enabled: result.enabled, total: result.total });
    return json(res, 200, result);
  } catch (error) {
    return json(res, 400, { ok: false, error: redact(error?.message || "Unexpected error.") });
  }
}

async function baseWaterRoute(res, path) {
  const baseId = Number(decodeURIComponent(path.split("/")[3]));
  // Same reasoning as baseInventoryRoute: match intParam so bad input stays a
  // 400 and the catch is left to genuine failures.
  if (!Number.isInteger(baseId) || baseId < 1 || baseId > Number.MAX_SAFE_INTEGER) {
    return json(res, 400, { error: "Invalid base ID" });
  }
  try {
    // A schema that cannot back this comes through as a 200 carrying
    // supported:false, the same capability shape listBases and baseInventory
    // use -- so an error status here means only a real failure, and the tab's
    // Retry always has something it could fix.
    return json(res, 200, await duneDb.baseWater(db, baseId));
  } catch (error) {
    return json(res, 500, { supported: false, error: redact(error?.message || "Unexpected error."), reason: redact(error?.message || "Unexpected error.") });
  }
}

// Read-only, so no directDbMutation wrapper and no confirmation phrase.
// repoRoot is passed through only to resolve each item's catalog icon.
async function baseInventoryRoute(res, path) {
  const baseId = Number(decodeURIComponent(path.split("/")[3]));
  // Matches intParam's contract rather than just isFinite: 4.5 and 1e20 both
  // clear a finite/>=1 check and then throw inside baseInventory. Rejecting
  // them here keeps bad client input on 400 and leaves the catch below for
  // failures that are genuinely ours.
  if (!Number.isInteger(baseId) || baseId < 1 || baseId > Number.MAX_SAFE_INTEGER) {
    return json(res, 400, { error: "Invalid base ID" });
  }
  try {
    // A schema without the inventory tables comes back as a 200 carrying
    // supported:false, the same capability shape listBases uses -- only a real
    // failure is an error status, so the tab's retry always means something.
    return json(res, 200, await duneDb.baseInventory(db, baseId, { repoRoot: config.repoRoot }));
  } catch (error) {
    // Nothing reaching here is the caller's fault: the id is already validated
    // and an unsupported schema returns a 200 above, so what is left is a query
    // or connection failure.
    return json(res, 500, { supported: false, error: redact(error?.message || "Unexpected error."), reason: redact(error?.message || "Unexpected error.") });
  }
}

// One container's slots, fetched when the contents modal opens rather than
// folded into baseInventoryRoute -- see baseContainerSlots for why (slots
// roughly triple that response, on a tab that loads per base expand).
async function baseContainerSlotsRoute(res, path) {
  const parts = path.split("/");
  const baseId = Number(decodeURIComponent(parts[3]));
  const placeableId = Number(decodeURIComponent(parts[5]));
  // Same intParam-matching validation baseInventoryRoute uses, for both ids.
  for (const id of [baseId, placeableId]) {
    if (!Number.isInteger(id) || id < 1 || id > Number.MAX_SAFE_INTEGER) {
      return json(res, 400, { error: "Invalid base or container ID" });
    }
  }
  try {
    const slots = await duneDb.baseContainerSlots(db, baseId, placeableId);
    // deleteSafety and addSafety are deliberately resolved via two separate
    // functions with two separate policies (see baseContainerAddSafety's own
    // comment above) -- not one shared resolve the way this used to work,
    // since Add (upstream's route) still requires a stopped map and
    // Delete/Give/Fill (this fork's #347 work) no longer do. deleteSafety
    // keeps its name rather than being generalised: it is read across the
    // API client, the tab, four test files and two docs pages, and an
    // additive twin buys everything a rename would without needing a
    // lockstep frontend/backend deploy.
    return json(res, 200, {
      ...slots,
      deleteSafety: baseContainerDeleteSafety(baseId, slots.group),
      addSafety: await baseContainerAddSafety(baseId, slots.group)
    });
  } catch (error) {
    return json(res, 500, { supported: false, error: redact(error?.message || "Unexpected error."), reason: redact(error?.message || "Unexpected error.") });
  }
}

// Add and Delete are gated by two DELIBERATELY DIFFERENT policies, not one
// shared decision tree, and that is intentional -- not an oversight left
// over from a merge. Add is upstream's own route (`addBaseContainerItem`,
// upstream PR #172) and keeps upstream's original map-safety requirement
// exactly as upstream designed it: a specific inventory row may move,
// merge, or disappear before a deferred operation runs, so upstream chose
// to refuse the write until the owning map is verified safely stopped.
// Delete/Give/Fill (this fork's own #347 work, below) removed that same
// requirement after live testing (corrected 2026-08-19, see
// baseContainerDeleteSafety's own comment) found the underlying premise
// does not hold for this fork's implementation: the live game engine only
// reads/claims a container's item rows from Postgres at server startup, so
// a database-side write while the map stays running is durably correct
// immediately and simply invisible in-game until the next restart -- not a
// live-sync hazard. Rather than retroactively impose that finding onto
// upstream's own route (which upstream's own docs and design rationale
// still assume the opposite), the two policies are kept explicitly separate
// here, one per route family, so a future re-sync with upstream does not
// have to re-litigate which one is "right" -- they are both right, for the
// route each one governs.

// ---- Add (upstream's addBaseContainerItem route only) ----

const BASE_CONTAINER_ADD_WORDING = {
  group: "Adding items is available only for Storage containers. Crafting and Refining contents are read-only to protect active jobs.",
  unsupported: "The console cannot verify that this base's map is safely stopped, so adding items is disabled.",
  running: "adding stored items",
  failed: "The console could not verify that this base's map is safely stopped, so adding items is disabled."
};

// Resolves the live-map state for the add-item safety check only. Delete
// below does not call this -- see baseContainerDeleteSafety.
async function resolveBaseContainerAddSafety(baseId, group = "storage") {
  if (group && group !== "storage") return { groupOk: false };
  try {
    const target = await duneDb.baseRefillTarget(db, baseId);
    return {
      groupOk: true,
      known: Boolean(target.queueSupported),
      writeSafeNow: Boolean(target.queueSupported) && Boolean(target.writeSafeNow),
      map: target.map || "",
      partitionId: target.partitionId || 0,
      threw: false
    };
  } catch {
    return { groupOk: true, known: false, writeSafeNow: false, map: "", partitionId: 0, threw: true };
  }
}

async function baseContainerAddSafety(baseId, group = "storage") {
  const resolved = await resolveBaseContainerAddSafety(baseId, group);
  const wording = BASE_CONTAINER_ADD_WORDING;
  if (!resolved.groupOk) {
    return { safe: false, known: true, map: "", partitionId: 0, reason: wording.group };
  }
  const map = resolved.map || "";
  const partitionId = resolved.partitionId || 0;
  if (!resolved.known) {
    return {
      safe: false,
      known: false,
      map: resolved.threw ? "" : map,
      partitionId: resolved.threw ? 0 : partitionId,
      reason: resolved.threw ? wording.failed : wording.unsupported
    };
  }
  if (!resolved.writeSafeNow) {
    const location = `${map || "This base's map"}${partitionId ? ` · Partition ${partitionId}` : ""}`;
    return { safe: false, known: true, map, partitionId, reason: `${location} is running. Stop that map before ${wording.running}.` };
  }
  return { safe: true, known: true, map, partitionId, reason: "" };
}

// ---- Delete/Give/Fill (this fork's #347 work) ----
//
// Historical note (found during manual testing, corrected 2026-08-19): this
// used to also require the owning map to be verified safely stopped before
// allowing a delete, on the theory that a running map's own autosave could
// resurrect or conflict with a row deleted out-of-band. That theory does not
// hold in practice -- confirmed via the same hours of live testing that
// established the standalone Storage tab's own delete route
// (storageRemoveItemsRoute/removeItemsFromStorage), which has never gated on
// map state at all. The live game server's own in-memory/encrypted state is
// only ever refreshed from Postgres at map start, not re-read mid-session --
// so a database-side delete while the map is running is exactly as safe as
// Give/Fill's own inserts already are: durably correct in the database
// immediately, simply not reflected in-game (or, for a delete, not removed
// from what the live map still shows) until the next restart. This function
// now only enforces the Storage-vs-Crafting/Refining group restriction,
// which is a real, still-current concern (an active crafting job can
// reference a Refining/Crafting inventory's item rows) -- kept as its own
// function, and `deleteSafety` kept as the response shape every caller
// already expects, so this stays a single, easy-to-find place if a real
// live-sync hazard is ever found and the map-state check needs to come back.
//
// Found during code review (2026-08-19): every mutation-route caller below
// (baseContainerItemDeleteRoute, baseContainerItemsDeleteRoute,
// baseContainerAllItemsDeleteRoute) calls this with only `baseId`, so
// `group` always defaults to "storage" and the `group !== "storage"` branch
// below can never actually fire from any of them -- misleading, dead code
// at those three call sites specifically (harmless, not a real gap: every
// one of them still goes on to call a duneDb function --
// deleteBaseContainerItem/deleteMultipleBaseContainerItems/
// deleteAllBaseContainerItems -- that re-verifies the same group
// restriction itself, atomically, inside resolveOwnedStorageContainer or
// its own equivalent check, so a non-storage container is still correctly
// rejected either way). Only baseContainerSlotsRoute (below) passes a real,
// already-known group and gets a real answer from this check -- that
// caller uses the result purely for display (whether the UI should show
// delete as available), not as a gate before a mutation. Left unchanged
// rather than "fixed" to add a real group check to the three mutation
// routes above: doing so would mean fetching the container's group via an
// extra, non-authoritative query before every delete purely to produce a
// slightly friendlier error message on a path the atomic downstream check
// already covers correctly -- not worth the added round trip for a
// pre-check whose verdict was never actually load-bearing.
function baseContainerDeleteSafety(baseId, group = "storage") {
  if (group && group !== "storage") {
    return {
      safe: false,
      known: true,
      map: "",
      partitionId: 0,
      reason: "Item deletion is available only for Storage containers. Crafting and Refining contents are read-only to protect active jobs."
    };
  }
  return { safe: true, known: true, map: "", partitionId: 0, reason: "" };
}

// Phrase-gated, unlike the refills above: this destroys a player's stored item
// and there is no undo short of a database restore.
//
// Deliberately not queued: inventory rows can change before a deferred delete
// is applied. Instead, deletion is allowed only when the owning map is known to
// be safely down. The safety check is repeated here immediately before the
// write; disabling the UI alone is never a security or consistency boundary.
async function baseContainerItemDeleteRoute(req, res, path) {
  const parts = path.split("/");
  const baseId = Number(decodeURIComponent(parts[3]));
  const placeableId = Number(decodeURIComponent(parts[5]));
  const itemId = decodeURIComponent(parts[7]);
  for (const id of [baseId, placeableId]) {
    if (!Number.isInteger(id) || id < 1 || id > Number.MAX_SAFE_INTEGER) {
      return json(res, 400, { error: "Invalid base, container, or item ID" });
    }
  }
  if (!/^[1-9][0-9]*$/.test(itemId) || BigInt(itemId) > 9223372036854775807n) {
    return json(res, 400, { error: "Invalid base, container, or item ID" });
  }
  if (baseDeletePending(baseId)) return json(res, 409, { error: BASE_DELETE_PENDING_MESSAGE });
  if (await baseBackedUp(baseId)) return json(res, 409, { error: BASE_BACKED_UP_MESSAGE });
  return directDbMutation(req, res, "bases.container-item-delete", "DELETE ITEM", async (body) => {
    const count = body?.count === undefined || body?.count === null ? null : Number(body.count);
    const safety = await baseContainerDeleteSafety(baseId);
    if (!safety.safe) throw new Error(safety.reason);
    const result = await duneDb.deleteBaseContainerItem(db, baseId, placeableId, itemId, { count });
    return { ...result, deleteSafety: safety };
  }, { baseId, placeableId, itemId });
}

// Phrase-gated despite being additive, unlike the refills below. An item that
// lands in a player's storage is an economy write with no in-game undo, and
// storage.give-item already sets the precedent that item creation carries a
// phrase. The phrase is deliberately distinct from "GIVE ITEM TO STORAGE" so a
// client replaying a give-item body cannot satisfy this gate.
//
// Same stopped-map rule as the delete above (upstream's original design,
// preserved for this route only -- see baseContainerAddSafety's own comment
// for why this route keeps the map check while Give/Fill/Delete below do
// not), re-checked inside the mutation immediately before the write for the
// same reason: disabling the UI alone is never a security or consistency
// boundary.
async function baseContainerItemAddRoute(req, res, path) {
  const parts = path.split("/");
  const baseId = Number(decodeURIComponent(parts[3]));
  const placeableId = Number(decodeURIComponent(parts[5]));
  for (const id of [baseId, placeableId]) {
    if (!Number.isInteger(id) || id < 1 || id > Number.MAX_SAFE_INTEGER) {
      return json(res, 400, { error: "Invalid base or container ID" });
    }
  }
  if (baseDeletePending(baseId)) return json(res, 409, { error: BASE_DELETE_PENDING_MESSAGE });
  if (await baseBackedUp(baseId)) return json(res, 409, { error: BASE_BACKED_UP_MESSAGE });
  return directDbMutation(req, res, "bases.container-item-add", "ADD ITEM TO CONTAINER", async (body) => {
    const safety = await baseContainerAddSafety(baseId);
    if (!safety.safe) throw new Error(safety.reason);
    // Spread order matters: the catalog-resolved id must win over whatever
    // templateId the client sent alongside an itemName.
    const resolved = resolveCatalogItem(config.repoRoot, body);
    const result = await duneDb.addBaseContainerItem(db, baseId, placeableId, { ...body, templateId: resolved.itemId });
    return { ...result, addSafety: safety };
  }, { baseId, placeableId });
}

// Same phrase-gate as baseContainerItemDeleteRoute above -- deletes several
// whole stacks (identified by itemIds in the body) from one storage
// container in a single confirmation, instead of one confirmation per item.
// Ownership is re-verified inside deleteMultipleBaseContainerItems itself
// (claim-CTE, storage-group only); this route only validates the path
// segments and applies the same pending-delete/backed-up/storage-group
// guards every other base container mutation route already applies (no
// map-liveness check -- see baseContainerDeleteSafety's own comment for why
// that check was removed 2026-08-19).
function parseBaseContainerPath(path) {
  const parts = path.split("/");
  const baseId = Number(decodeURIComponent(parts[3]));
  const placeableId = Number(decodeURIComponent(parts[5]));
  for (const id of [baseId, placeableId]) {
    if (!Number.isInteger(id) || id < 1 || id > Number.MAX_SAFE_INTEGER) return null;
  }
  return { baseId, placeableId };
}

async function baseContainerItemsDeleteRoute(req, res, path) {
  const parsed = parseBaseContainerPath(path);
  if (!parsed) return json(res, 400, { error: "Invalid base or container ID" });
  const { baseId, placeableId } = parsed;
  if (baseDeletePending(baseId)) return json(res, 409, { error: BASE_DELETE_PENDING_MESSAGE });
  if (await baseBackedUp(baseId)) return json(res, 409, { error: BASE_BACKED_UP_MESSAGE });
  return directDbMutation(req, res, "bases.container-items-delete", "DELETE ITEMS", async (body) => {
    const safety = await baseContainerDeleteSafety(baseId);
    if (!safety.safe) throw new Error(safety.reason);
    const result = await duneDb.deleteMultipleBaseContainerItems(db, baseId, placeableId, body?.itemIds);
    return { ...result, deleteSafety: safety };
  }, { baseId, placeableId });
}

// Same phrase-gate -- clears every item currently in one storage container
// in a single confirmation. The item list to delete is read fresh inside
// deleteAllBaseContainerItems's own transaction, not passed in by this
// route, so a stale client-side snapshot can never narrow or widen what
// "all" means. No map-liveness check -- see baseContainerDeleteSafety's own
// comment for why that check was removed 2026-08-19.
async function baseContainerAllItemsDeleteRoute(req, res, path) {
  const parsed = parseBaseContainerPath(path);
  if (!parsed) return json(res, 400, { error: "Invalid base or container ID" });
  const { baseId, placeableId } = parsed;
  if (baseDeletePending(baseId)) return json(res, 409, { error: BASE_DELETE_PENDING_MESSAGE });
  if (await baseBackedUp(baseId)) return json(res, 409, { error: BASE_BACKED_UP_MESSAGE });
  return directDbMutation(req, res, "bases.container-all-items-delete", "DELETE ALL ITEMS", async () => {
    const safety = await baseContainerDeleteSafety(baseId);
    if (!safety.safe) throw new Error(safety.reason);
    const result = await duneDb.deleteAllBaseContainerItems(db, baseId, placeableId);
    return { ...result, deleteSafety: safety };
  }, { baseId, placeableId });
}

// Give/Fill are pure inserts -- no existing row is ever touched. Per
// INC-2026-07-31-001, inserted rows are simply not visible in-game until the
// Survival server restarts; that is a visibility gap, not a live-sync
// hazard. baseContainerDeleteSafety's own map-liveness check was removed
// 2026-08-19 for the same reason (see its comment) -- neither Give/Fill nor
// Delete require a stopped map now (Add, above, is the one exception that
// still does -- it is upstream's own route/design, kept as upstream shipped
// it).
//
// Ownership verification previously happened here, via a separate,
// unlocked baseContainerOwnedStorageId() call to baseContainerSlots()
// *before* opening the write transaction, then handed the bare placeableId
// into giveItemToStorage/fillItemToStorage/giveMultipleItemsToStorage's own
// actor_id-only lookup (`order by id limit 1`, no group filter, no
// multi-inventory guard). Found during code review (2026-08-19): that was a
// real TOCTOU gap (ownership/group verified in one query, the row resolved
// and written in a later, completely separate transaction, with nothing
// preventing the base's ownership or the container's group from changing in
// between) and a real multi-inventory ambiguity gap (that actor_id lookup
// silently picks whichever inventory row sorts first if a storage-group
// placeable is ever found to back more than one qualifying inventory,
// instead of throwing the way resolveOwnedStorageContainer already does for
// Delete). baseContainerOwnedStorageId() is removed; each route below now
// calls giveItemToBaseContainer/fillItemToBaseContainer/
// giveMultipleItemsToBaseContainer directly with (baseId, placeableId),
// which resolve ownership, lock the row, and write in one atomic
// transaction via resolveOwnedStorageContainer -- exactly like Delete
// already does.
async function baseContainerGiveItemRoute(req, res, path) {
  const parsed = parseBaseContainerPath(path);
  if (!parsed) return json(res, 400, { error: "Invalid base or container ID" });
  const { baseId, placeableId } = parsed;
  if (baseDeletePending(baseId)) return json(res, 409, { error: BASE_DELETE_PENDING_MESSAGE });
  if (await baseBackedUp(baseId)) return json(res, 409, { error: BASE_BACKED_UP_MESSAGE });
  return directDbMutation(req, res, "bases.container-give-item", "GIVE ITEM TO STORAGE", async (body) => {
    // Restricted to raw_resource/refined_resource/component (issue #347
    // follow-up, per explicit operator direction, found via a real catalog
    // item -- "Robe of the Sisterhood" -- appearing in the Give combobox
    // despite being clothing): this Base Inventory tab's Give action is
    // scoped the same as Fill, using resolveFillableCatalogItem() instead of
    // the unrestricted resolveCatalogItem(). This does NOT apply to the
    // older, standalone Storage tab's own Give Item action
    // (storageGiveItemRoute), which intentionally keeps accepting any
    // catalog item -- a separate, pre-existing feature this change does not
    // touch.
    const resolved = resolveFillableCatalogItem(config.repoRoot, body);
    const itemVolume = resolved.volume || resolveItemVolume(config.repoRoot, resolved.itemId);
    return duneDb.giveItemToBaseContainer(db, baseId, placeableId, { ...body, templateId: resolved.itemId, itemVolume });
  }, { baseId, placeableId });
}

async function baseContainerGiveItemsRoute(req, res, path) {
  const parsed = parseBaseContainerPath(path);
  if (!parsed) return json(res, 400, { error: "Invalid base or container ID" });
  const { baseId, placeableId } = parsed;
  if (baseDeletePending(baseId)) return json(res, 409, { error: BASE_DELETE_PENDING_MESSAGE });
  if (await baseBackedUp(baseId)) return json(res, 409, { error: BASE_BACKED_UP_MESSAGE });
  return directDbMutation(req, res, "bases.container-give-items", "GIVE ITEMS TO STORAGE", async (body) => {
    // Length checked BEFORE any per-item processing -- mirrors giveItemsRoute's
    // own guard (server.js:3701). Found during PR #349's own Layer 3 audit
    // (Security hat): resolveCatalogItem/resolveItemVolume each do a
    // synchronous readFileSync+JSON.parse of the ~2600-item admin catalog per
    // call, so validating the 50-item cap only inside
    // giveMultipleItemsToBaseContainer (after every item below had already
    // been resolved against the catalog) let an oversized batch force tens
    // of seconds of synchronous, event-loop-blocking file I/O before ever
    // being rejected -- a real, trivially reachable DoS against every other
    // console user's request, not just this one's.
    if (!Array.isArray(body?.items) || body.items.length < 1 || body.items.length > 50) {
      throw new Error("Give Multiple Items requires 1-50 items");
    }
    // Same raw_resource/refined_resource/component restriction as
    // baseContainerGiveItemRoute above -- see its comment for why.
    const items = body.items.map((item) => {
      const resolved = resolveFillableCatalogItem(config.repoRoot, item);
      const itemVolume = resolved.volume || resolveItemVolume(config.repoRoot, resolved.itemId);
      return { ...item, templateId: resolved.itemId, itemVolume };
    });
    return duneDb.giveMultipleItemsToBaseContainer(db, baseId, placeableId, { items });
  }, { baseId, placeableId });
}

async function baseContainerFillItemRoute(req, res, path) {
  const parsed = parseBaseContainerPath(path);
  if (!parsed) return json(res, 400, { error: "Invalid base or container ID" });
  const { baseId, placeableId } = parsed;
  if (baseDeletePending(baseId)) return json(res, 409, { error: BASE_DELETE_PENDING_MESSAGE });
  if (await baseBackedUp(baseId)) return json(res, 409, { error: BASE_BACKED_UP_MESSAGE });
  return directDbMutation(req, res, "bases.container-fill-item", "FILL ITEM TO STORAGE", async (body) => {
    const resolved = resolveFillableCatalogItem(config.repoRoot, body);
    const itemVolume = resolved.volume || resolveItemVolume(config.repoRoot, resolved.itemId);
    return duneDb.fillItemToBaseContainer(db, config.repoRoot, baseId, placeableId, { ...body, templateId: resolved.itemId, itemVolume });
  }, { baseId, placeableId });
}

// Mirrors baseRefillGeneratorsRoute: no confirmation phrase (additive and
// reversible), queued instead of written immediately when the base's map is
// currently live.
async function baseRefillWaterRoute(req, res, path) {
  const baseId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isFinite(baseId) || baseId < 1) return json(res, 400, { error: "Invalid base ID" });
  if (baseDeletePending(baseId)) return json(res, 409, { error: BASE_DELETE_PENDING_MESSAGE });
  if (await baseBackedUp(baseId)) return json(res, 409, { error: BASE_BACKED_UP_MESSAGE });
  return directDbMutation(req, res, "bases.refill-water", null, async () => {
    const target = await duneDb.baseRefillTarget(db, baseId);
    if (target.queueSupported && !target.writeSafeNow) {
      const entry = duneDb.queueWaterRefill(config.repoRoot, {
        baseId,
        map: target.map,
        partitionId: target.partitionId
      });
      return { ok: true, queued: true, ...entry };
    }
    return duneDb.refillBaseWater(db, baseId);
  }, { baseId });
}

async function baseCancelQueuedWaterRefillRoute(req, res, path) {
  const baseId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isFinite(baseId) || baseId < 1) return json(res, 400, { error: "Invalid base ID" });
  return directDbMutation(req, res, "bases.cancel-queued-water-refill", null,
    () => duneDb.cancelQueuedWaterRefill(config.repoRoot, baseId), { baseId });
}

// Mirrors pendingGeneratorRefillsRoute.
async function pendingWaterRefillsRoute(res) {
  const pending = duneDb.listQueuedWaterRefills(config.repoRoot);
  const targets = pending.length
    ? await duneDb.partitionRestartTargets(db).catch(() => new Map())
    : new Map();
  const byTarget = new Map();
  for (const entry of pending) {
    const map = entry.map || "Unknown";
    const key = `${map}|${entry.partitionId}`;
    const target = targets.get(entry.partitionId);
    const group = byTarget.get(key) || {
      map,
      partitionId: entry.partitionId,
      partitionMap: target?.map || "",
      dimensionIndex: target?.dimensionIndex ?? 0,
      count: 0
    };
    group.count += 1;
    byTarget.set(key, group);
  }
  return json(res, 200, {
    supported: true,
    total: pending.length,
    pending,
    byTarget: [...byTarget.values()].sort((a, b) => a.map.localeCompare(b.map) || a.partitionId - b.partitionId)
  });
}

// Mirrors basesAutoRefillStateRoute, gated on supportsWaterRefillQueue rather
// than supportsGeneratorRefillQueue -- water refill needs none of the
// item-insert columns the generator capability check requires.
async function basesAutoRefillWaterStateRoute(res) {
  const supported = await duneDb.supportsWaterRefillQueue(db).catch(() => false);
  return json(res, 200, { supported, ...autoRefillWaterPublicState(config.repoRoot) });
}

// Mirrors baseAutoRefillToggleRoute.
async function baseAutoRefillWaterToggleRoute(req, res, path) {
  const baseId = Number(decodeURIComponent(path.split("/")[3]));
  if (!Number.isFinite(baseId) || baseId < 1) return json(res, 400, { error: "Invalid base ID" });
  const body = await readJson(req);
  if (typeof body.enabled !== "boolean") {
    return json(res, 400, { error: "Auto-refill enabled must be true or false." });
  }
  // Only enabling is blocked -- see baseAutoRefillToggleRoute.
  if (body.enabled && baseDeletePending(baseId)) return json(res, 409, { error: BASE_DELETE_PENDING_MESSAGE });
  if (body.enabled && await baseBackedUp(baseId)) return json(res, 409, { error: BASE_BACKED_UP_MESSAGE });
  if (body.enabled && !(await duneDb.supportsWaterRefillQueue(db).catch(() => false))) {
    return json(res, 501, {
      error: "Auto-refill needs the pending water-refill queue, which requires dune.world_partition on this database."
    });
  }
  try {
    const result = setBaseAutoRefillWater(config.repoRoot, baseId, body.enabled);
    audit(config, req, "bases.auto-refill-water", { baseId, enabled: result.enabled, total: result.total });
    if (!result.newlyEnabled) return json(res, 200, result);

    try {
      const initialCheck = await autoRefillWaterScheduler.scanNow(baseId);
      return json(res, 200, { ...result, initialCheck });
    } catch (error) {
      // Enrollment was saved successfully. Report the failed first check
      // separately so the UI does not falsely switch the toggle back off; the
      // normal daily scheduler remains armed and will retry it.
      return json(res, 200, {
        ...result,
        initialCheck: {
          status: "fail",
          detail: redact(error?.message || "Unexpected error."),
          checked: 0,
          queued: 0,
          failures: 1
        }
      });
    }
  } catch (error) {
    return json(res, 400, { ok: false, error: redact(error?.message || "Unexpected error.") });
  }
}

async function blueprintBulkExportRoute(req, res) {
  try {
    const body = await readJson(req);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number))];
    if (!ids.length || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) return json(res, 400, { error: "Select at least one valid blueprint to export." });
    if (ids.length > 500) return json(res, 400, { error: "A maximum of 500 blueprints can be exported at once." });

    const usedNames = new Set();
    const entries = [];
    for (const id of ids) {
      const data = await exportBlueprint(db, id);
      const baseName = sanitizeFilename(data.name || `blueprint_${id}`, `blueprint_${id}`).replace(/\.json$/i, "") || `blueprint_${id}`;
      let filename = `${baseName}.json`;
      let suffix = 2;
      while (usedNames.has(filename.toLowerCase())) filename = `${baseName}_${suffix++}.json`;
      usedNames.add(filename.toLowerCase());
      entries.push({ name: filename, content: Buffer.from(`${JSON.stringify(data, null, 2)}\n`, "utf8") });
    }

    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/T/, "-").slice(0, 15);
    const archive = createZipArchive(entries);
    res.writeHead(200, withSecurityHeaders({
      "content-type": "application/zip",
      "content-length": String(archive.length),
      "content-disposition": `attachment; filename="blueprints-${stamp}.zip"`
    }));
    res.end(archive);
  } catch (error) {
    const status = error.unsupported ? 501 : 500;
    return json(res, status, { ok: false, error: redact(error?.message || "Unexpected error.") });
  }
}

async function blueprintImportRoute(req, res) {
  try {
    const { fields, files } = await readMultipartForm(req, 32 << 20);
    const playerIdStr = String(fields.player_id || "");
    const playerPawnId = Number(playerIdStr);
    if (!Number.isFinite(playerPawnId) || playerPawnId < 1) return json(res, 400, { error: "Invalid player_id" });
    const fileEntry = Array.isArray(files) ? files.find((f) => f.fieldName === "file" && f.fileName) : files;
    if (!fileEntry) return json(res, 400, { error: "Blueprint file required" });
    const fileContent = typeof fileEntry.content !== "undefined" ? fileEntry.content : (typeof fileEntry === "string" ? fileEntry : fileEntry.toString("utf-8"));
    let blueprintFile;
    try {
      blueprintFile = JSON.parse(fileContent);
    } catch {
      return json(res, 400, { error: "Invalid blueprint JSON" });
    }
    const hasInstances = Array.isArray(blueprintFile.instances) && blueprintFile.instances.length > 0;
    const hasPlaceables = Array.isArray(blueprintFile.placeables) && blueprintFile.placeables.length > 0;
    const hasPentashields = Array.isArray(blueprintFile.pentashields) && blueprintFile.pentashields.length > 0;
    if (!hasInstances && !hasPlaceables && !hasPentashields) {
      return json(res, 400, { error: "Blueprint has no instances, placeables, or pentashields" });
    }
    const result = await importBlueprint(db, playerPawnId, blueprintFile, fileEntry.fileName || "");
    audit(config, req, "blueprints.import", { playerPawnId, result });
    return json(res, 200, result);
  } catch (error) {
    if (error.unsupported) return json(res, 501, { supported: false, error: redact(error?.message || "Unexpected error.") });
    return json(res, 500, { ok: false, error: redact(error?.message || "Unexpected error.") });
  }
}

function sanitizeFilename(s, fallback = "export") {
  return String(s).replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, "_").trim() || fallback;
}

async function blueprintsDeleteRoute(req, res, path) {
  const match = path.match(/^\/api\/blueprints\/([^/]+)$/);
  const id = Number(match[1]);
  if (!Number.isFinite(id) || id < 1) return json(res, 400, { ok: false, error: "Invalid blueprint ID" });
  try {
    const result = await deleteBlueprint(db, id);
    audit(config, req, "blueprints.delete", { blueprintId: id, result });
    return json(res, result.ok ? 200 : 404, result);
  } catch (error) {
    if (error.unsupported) return json(res, 501, { supported: false, error: redact(error?.message || "Unexpected error.") });
    return json(res, 500, { ok: false, error: redact(error?.message || "Unexpected error.") });
  }
}

async function directDbMutation(req, res, action, phrase, fn, meta = {}) {
  const body = await readJson(req);
  if (phrase && body.confirmation !== phrase) {
    return json(res, 400, { error: `Confirmation phrase required: ${phrase}` });
  }
  if (!applyMutationRateLimit(req, res, action)) return;
  try {
    const result = config.mockMode ? { ok: true, mock: true } : await fn(body);
    audit(config, req, action, { ...meta, supported: true, result });
    // Every caller before base deletion leaves result.backupCreated unset, so
    // this defaults to false exactly as it did when the field was hardcoded.
    return json(res, 200, { supported: true, backupCreated: Boolean(result?.backupCreated), result });
  } catch (error) {
    const status = error.unsupported ? 501 : 400;
    audit(config, req, action, { ...meta, supported: false, error: redact(error?.message || "Unexpected error.") });
    return json(res, status, { supported: false, error: redact(error?.message || "Unexpected error."), reason: redact(error?.message || "Unexpected error.") });
  }
}

async function giveItemsRoute(req, res, path) {
  const body = await readJson(req);
  const playerId = decodeURIComponent(path.split("/")[3]);
  if (!Array.isArray(body.items)) {
    if (!applyMutationRateLimit(req, res, "players.give-items")) return;
    await resolvePlayerGrantTarget(playerId);
    return task(req, res, "admin", "adminGiveItems", { ...body, playerId });
  }
  if (body.items.length < 1 || body.items.length > 25) return json(res, 400, { error: "Give Multiple Items requires 1-25 items" });
  if (!applyMutationRateLimit(req, res, "players.give-items")) return;

  const results = [];
  const target = await resolvePlayerGrantTarget(playerId);
  for (const [index, item] of body.items.entries()) {
    try {
      results.push({ index, ...(await grantPlayerItem(playerId, item, target)) });
    } catch (error) {
      results.push({ index, ok: false, item, error: redact(error?.message || "Unexpected error.") });
    }
  }
  const ok = results.every((result) => result.ok);
  // A clamped grant (per-item stack limit x free-slot budget, issue #430)
  // must reach the operator: the Players UI shows this route's top-level
  // message when present, and would otherwise report unconditional success
  // for a partial delivery (L2 audit, Architect hat H-1).
  const clampMessages = results
    .map((entry) => (entry?.result?.clamped && entry?.result?.message ? String(entry.result.message) : null))
    .filter(Boolean);
  audit(config, req, "players.give-items", { playerId, count: body.items.length, ok, results });
  if (body.historyScope === "admin-tools") {
    const friendly = body.historyFriendly || "Grant Items";
    recordAdminHistory(config, { command: "web-hydrate-all", target: "all", friendly, path: "players.give-items", result: ok ? "published" : "failed", message: `${friendly} for ${playerId}` });
  }
  return json(res, ok ? 200 : 207, { ok, results, message: clampMessages.length > 0 ? clampMessages.join(" ") : undefined });
}

async function giveSingleItemRoute(req, res, path, operation) {
  const body = await readJson(req);
  const playerId = decodeURIComponent(path.split("/")[3]);
  if (!applyMutationRateLimit(req, res, operation === "adminGiveItemId" ? "players.give-item-id" : "players.give-item")) return;
  let target;
  try {
    target = await resolvePlayerGrantTarget(playerId);
  } catch (error) {
    return json(res, error?.statusCode || 400, { ok: false, error: redact(error?.message || "Unexpected error.") });
  }
  if (body.quality === undefined && body.grade === undefined) {
    const resolved = operation === "adminGiveItemId"
      ? resolveCatalogItem(config.repoRoot, { itemId: body.itemId })
      : resolveCatalogItem(config.repoRoot, { itemName: body.itemName });
    if (!itemRequiresDatabaseGrant(resolved) && !(body.augments && body.augments.length > 0)) {
      return task(req, res, "admin", operation, { ...body, playerId });
    }
  }
  const item = operation === "adminGiveItemId"
    ? { itemId: body.itemId, quantity: body.quantity, quality: body.quality, grade: body.grade, durability: body.durability, augments: body.augments, augmentQuality: body.augmentQuality }
    : { itemName: body.itemName, quantity: body.quantity, quality: body.quality, grade: body.grade, durability: body.durability, augments: body.augments, augmentQuality: body.augmentQuality };
  try {
    const result = await grantPlayerItem(playerId, item, target);
    audit(config, req, operation === "adminGiveItemId" ? "players.give-item-id" : "players.give-item", { playerId, ok: result.ok, result });
    return json(res, result.ok ? 200 : 207, result);
  } catch (error) {
    audit(config, req, operation === "adminGiveItemId" ? "players.give-item-id" : "players.give-item", { playerId, ok: false, error: redact(error?.message || "Unexpected error.") });
    return json(res, 400, { ok: false, error: redact(error?.message || "Unexpected error.") });
  }
}

function buildingUnlocksRoute(res, path) {
  const playerId = decodeURIComponent(path.split("/")[3]);
  return dbJson(res, async () => {
    const state = await duneDb.playerBuildingUnlockState(db, playerId);
    const supported = Boolean(state.capabilities?.buildingUnlockOwnership);
    return {
      capabilities: state.capabilities,
      rows: listBuildingUnlockItems(config.repoRoot).map((item) => ({
        ...item,
        status: buildingUnlockStatus(item.itemId, { ...state, supported })
      }))
    };
  });
}

async function buildingUnlockGrantRoute(req, res, path) {
  const playerId = decodeURIComponent(path.split("/")[3]);
  const body = await readJson(req);
  if (body.confirmation !== "GRANT BUILDING UNLOCK") return json(res, 400, { error: "Confirmation phrase mismatch" });
  if (!applyMutationRateLimit(req, res, "players.building-unlocks.grant")) return;

  try {
    const resolved = resolveCatalogItem(config.repoRoot, { itemId: body.itemId });
    if (!isBuildingUnlockItem(resolved)) throw new Error("Select a verified entry from the Building Sets catalog.");
    const target = await resolvePlayerGrantTarget(playerId);
    if (!config.mockMode && !target.actorId) throw new Error("A database actor ID is required to verify building-set ownership.");

    if (target.actorId) {
      const state = await duneDb.playerBuildingUnlockState(db, target.actorId);
      if (!state.capabilities?.buildingUnlockOwnership) {
        throw new Error("This game database cannot verify building-set ownership, so the grant was not attempted.");
      }
      const status = buildingUnlockStatus(resolved.itemId, {
        ...state,
        supported: true
      });
      if (status === "Owned" || status === "Pending") {
        audit(config, req, "players.building-unlocks.grant", { playerId, itemId: resolved.itemId, status, ok: true, noOp: true });
        return json(res, 200, { ok: true, status, alreadyOwned: status === "Owned", alreadyPending: status === "Pending", item: resolved });
      }
    }

    const result = await grantPlayerItem(playerId, { itemId: resolved.itemId, quantity: 1 }, target);
    const status = result.ok ? (target.online ? "Processing" : "Pending") : "Available";
    audit(config, req, "players.building-unlocks.grant", { playerId, itemId: resolved.itemId, status, ok: result.ok });
    return json(res, result.ok ? 200 : 207, { ok: result.ok, status, item: resolved, result });
  } catch (error) {
    audit(config, req, "players.building-unlocks.grant", { playerId, itemId: body.itemId, ok: false, error: redact(error?.message || "Unexpected error.") });
    return json(res, 400, { ok: false, error: redact(error?.message || "Unexpected error.") });
  }
}

async function customizationGrantsRoute(res, path) {
  const playerId = decodeURIComponent(path.split("/")[3]);
  try {
    const state = await duneDb.playerCustomizationGrantState(db, playerId);
    return json(res, 200, {
      capabilities: state.capabilities,
      groups: customizationGrantGroups(config.repoRoot),
      rows: listCustomizationGrantItems(config.repoRoot).map((item) => ({
        ...item,
        status: customizationGrantStatus(item.itemId, state)
      }))
    });
  } catch (error) {
    return json(res, 400, { error: redact(error?.message || "Unexpected error.") });
  }
}

async function customizationGrantRoute(req, res, path) {
  const playerId = decodeURIComponent(path.split("/")[3]);
  const body = await readJson(req);
  if (body.confirmation !== "GRANT CUSTOMIZATIONS") return json(res, 400, { error: "Confirmation phrase mismatch" });
  if (!applyMutationRateLimit(req, res, "players.customizations.grant")) return;

  try {
    const catalog = listCustomizationGrantItems(config.repoRoot);
    const groups = new Set(customizationGrantGroups(config.repoRoot).map((group) => group.id));
    let selected;
    if (body.itemId) {
      const resolved = resolveCatalogItem(config.repoRoot, { itemId: body.itemId });
      if (!isCustomizationGrantItem(resolved) || !catalog.some((item) => item.itemId === resolved.itemId)) {
        throw new Error("Select a verified entry from the Customizations catalog.");
      }
      selected = catalog.filter((item) => item.itemId === resolved.itemId);
    } else if (body.groupId === "all") {
      selected = catalog;
    } else if (groups.has(String(body.groupId || ""))) {
      selected = catalog.filter((item) => item.groupId === body.groupId);
    } else {
      throw new Error("Select a verified customization group.");
    }
    if (selected.length === 0) throw new Error("The selected customization group is empty.");

    const target = await resolvePlayerGrantTarget(playerId);
    const state = target.actorId
      ? await duneDb.playerCustomizationGrantState(db, target.actorId)
      : { capabilities: { customizationPending: false }, pending: [] };
    const results = [];
    for (const item of selected) {
      if (customizationGrantStatus(item.itemId, state) === "Pending") {
        results.push({ itemId: item.itemId, name: item.name, groupId: item.groupId, ok: true, status: "Pending", skipped: true });
        continue;
      }
      try {
        const result = await grantPlayerItem(playerId, { itemId: item.itemId, quantity: 1 }, target);
        results.push({ itemId: item.itemId, name: item.name, groupId: item.groupId, ok: result.ok, status: result.ok ? (target.online ? "Processing" : "Pending") : "Available", result });
      } catch (error) {
        results.push({ itemId: item.itemId, name: item.name, groupId: item.groupId, ok: false, status: "Available", error: redact(error?.message || "Unexpected error.") });
      }
    }
    const ok = results.every((result) => result.ok);
    const granted = results.filter((result) => result.ok && !result.skipped).length;
    const skipped = results.filter((result) => result.skipped).length;
    const failed = results.filter((result) => !result.ok).length;
    audit(config, req, "players.customizations.grant", { playerId, itemId: body.itemId || null, groupId: body.groupId || null, granted, skipped, failed, ok, results });
    return json(res, ok ? 200 : 207, { ok, granted, skipped, failed, results });
  } catch (error) {
    audit(config, req, "players.customizations.grant", { playerId, itemId: body.itemId || null, groupId: body.groupId || null, ok: false, error: redact(error?.message || "Unexpected error.") });
    return json(res, 400, { ok: false, error: redact(error?.message || "Unexpected error.") });
  }
}

async function grantPlayerItem(playerId, item, target) {
  const resolved = item.itemId ? resolveCatalogItem(config.repoRoot, { itemId: item.itemId }) : resolveCatalogItem(config.repoRoot, item);
  const operation = resolved.itemId ? "adminGiveItemId" : "adminGiveItem";
  const hasExplicitGrade = item.quality !== undefined || item.grade !== undefined;
  const selectedGrade = hasExplicitGrade ? validateGrantGrade(item.quality ?? item.grade) : undefined;
  const selectedAugmentGrade = item.augmentQuality === undefined ? 1 : validateAugmentGrantGrade(item.augmentQuality);
  const schematic = itemIsSchematic(resolved);
  const rankedSchematic = itemIsRankedSchematic(resolved, selectedGrade);
  const usesDatabaseGrant = rankedSchematic || (!schematic && (!target.online || (selectedGrade !== undefined && selectedGrade > 0) || itemRequiresDatabaseGrant(resolved) || (item.augments && item.augments.length > 0)));
  const databaseGrade = hasExplicitGrade ? selectedGrade : 0;
  const payload = {
    playerId: target.actionId || playerId,
    itemId: resolved.itemId,
    itemName: item.itemName,
    quantity: item.quantity ?? 1,
    quality: hasExplicitGrade ? selectedGrade : undefined,
    durability: 1,
    augments: item.augments || [],
    augmentQuality: selectedAugmentGrade
  };
  const liveAugmentRefreshWarning = "Augments were written to the database. If the player was online, the weapon may need a relog before the augment slots appear in-game.";
  if (schematic && !rankedSchematic && !config.mockMode && !target.online) {
    throw new Error("Grade 0 physical schematic grants require the player to be online so delivery can be verified by the game server. Grades 1-5 use the database grant path.");
  }
  if (usesDatabaseGrant) {
    if (!config.mockMode && !target.actorId) throw new Error("A database actor ID is required to grant graded items, schematics, and augments");
    if (!config.mockMode && payload.augments.length > 0 && target.online) {
      throw new Error("Pre-augmented item grants require the player to be offline. Grade 0 items with no augments can be granted while the player is online. Item Grades 1-5 or Augment Grades 1-5 require the player to be offline.");
    }
    const result = config.mockMode
      ? { ok: true, inserted: { template_id: resolved.itemId || payload.itemName, stack_size: payload.quantity, quality_level: databaseGrade } }
      : await duneDb.giveItemToPlayer(db, target.actorId, {
          templateId: resolved.itemId || "",
          itemName: payload.itemName,
          quantity: payload.quantity,
          quality: databaseGrade,
          augments: payload.augments,
          augmentQuality: payload.augmentQuality
        });
    return {
      ok: true,
      operation: "dbGiveItemToPlayer",
      item: { ...payload, quality: databaseGrade },
      result,
      warning: result?.requiresRelog
        ? (rankedSchematic
            ? "The ranked schematic was written to the database. The player must relog before it appears with the selected grade."
            : (payload.augments.length > 0 ? liveAugmentRefreshWarning : "The item was written to the database. The player must relog before it appears correctly."))
        : undefined
    };
  }
  const command = buildDuneArgs(operation, payload);
  if (config.mockMode) return { ok: true, operation, command };
  const result = await runDune(config, command);
  const warning = liveItemGrantWarning(result);
  return {
    ok: liveItemGrantOk(result),
    operation,
    item: payload,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.code,
    warning: warning || undefined
  };
}

async function augmentNewestPlayerItemWithRetry(actorId, templateId, options) {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const result = await duneDb.augmentNewestPlayerItem(db, actorId, templateId, options);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 650));
      const state = await duneDb.playerItemAugmentState(db, actorId, result.itemId, options.augments || []);
      if (state.ok) return { ...result, verified: true };
      lastError = new Error(`${templateId} augment patch was overwritten or incomplete; retrying`);
    } catch (error) {
      lastError = error;
      if (!/new inventory row was not found/i.test(String(error?.message || "Unexpected error."))) throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw lastError;
}

function validateGrantGrade(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.trunc(n) !== n || n < 0 || n > 5) throw new Error("Expected item grade 0-5");
  return n;
}

function validateAugmentGrantGrade(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.trunc(n) !== n || n < 1 || n > 5) throw new Error("Expected augment grade 1-5");
  return n;
}

async function broadcastRoute(req, res) {
  const body = await readJson(req);
  const message = body.body ?? body.message;
  try {
    const command = buildBroadcastCommand({ ...body, message });
    const result = config.mockMode ? { code: 0, stdout: "mock broadcast\n", stderr: "", args: [] } : await publishServerCommand(config, command, "web-broadcast");
    audit(config, req, "admin.broadcast", { supported: true, command });
    recordAdminHistory(config, { command: "web-broadcast", target: "all", friendly: body.title || "Broadcast", path: "rmq:heartbeats/notifications", result: "published", message });
    return json(res, 200, { supported: true, ok: true, stdout: result.stdout, stderr: result.stderr, note: "Broadcast was published to RabbitMQ." });
  } catch (error) {
    audit(config, req, "admin.broadcast", { supported: false, error: redact(error?.message || "Unexpected error.") });
    recordAdminHistory(config, { command: "web-broadcast", target: "all", friendly: body.title || "Broadcast", path: "rmq:heartbeats/notifications", result: "blocked", message });
    return json(res, 400, { supported: false, error: redact(error?.message || "Unexpected error."), reason: redact(error?.message || "Unexpected error.") });
  }
}

async function mapChatRoute(req, res) {
  const body = await readJson(req);
  const message = body.body ?? body.message;
  const mapName = body.mapName || body.region || "HaggaBasin";
  const dimension = body.dimension ?? 0;
  try {
    const result = await deliverMapChatMessage(mapName, dimension, message);
    const target = `${mapName}.${dimension}`;
    audit(config, req, "admin.map-chat", { supported: true, target, recipients: result.recipients });
    recordAdminHistory(config, { command: "web-map-chat", target, friendly: "Map Chat", path: "rmq:chat.map", result: "published", message });
    return json(res, 200, { supported: true, ok: true, stdout: result.stdout, stderr: result.stderr || "", note: `Map chat message was sent to ${result.recipients} online player${result.recipients === 1 ? "" : "s"}.`, recipients: result.recipients });
  } catch (error) {
    const reason = redact(String(error?.message || "Unexpected error.").replaceAll("Care Package message whisper", "Map chat"));
    audit(config, req, "admin.map-chat", { supported: false, error: reason });
    recordAdminHistory(config, { command: "web-map-chat", target: `${mapName}.${dimension}`, friendly: "Map Chat", path: "rmq:chat.map", result: "blocked", message });
    return json(res, 400, { supported: false, error: reason, reason });
  }
}

async function deliverMapChatMessage(mapName, dimension, message) {
  const recipients = config.mockMode ? [{ queue: "mock-player_queue" }] : await mapChatRecipients(mapName, dimension);
  if (!recipients.length) throw new Error("No online players are currently subscribed to that map.");
  const sender = config.mockMode ? { funcomId: "Server#4242", hexFlsId: "5E121CE000000001" } : await ensureCarePackageServerPersona(db);
  const result = config.mockMode
    ? { code: 0, stdout: "mock map chat\n", stderr: "", args: [] }
    : await publishMapChat(config, {
        mapName,
        dimension,
        message,
        senderFuncomId: sender.funcomId,
        senderHexFlsId: sender.hexFlsId
      });
  return { ...result, recipients: recipients.length };
}

async function deliverScheduledMapMessage(schedule) {
  if (schedule.mapName !== "AllMaps") return deliverMapChatMessage(schedule.mapName, schedule.dimension, schedule.message);
  const services = await duneDb.liveMapServices(db);
  const targets = [];
  const seen = new Set();
  for (const row of services.rows || []) {
    if (!Boolean(row.alive || row.ready) || Number(row.connected_players || 0) < 1) continue;
    const mapName = mapChatRegionForServerMap(row.map);
    const dimension = Number(row.dimension_index || 0);
    const key = `${mapName}|${dimension}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ mapName, dimension });
  }
  if (!targets.length) throw new Error("No online players are currently subscribed to any map.");
  let recipients = 0;
  const output = [];
  for (const target of targets) {
    try {
      const result = await deliverMapChatMessage(target.mapName, target.dimension, schedule.message);
      recipients += result.recipients;
      if (result.stdout) output.push(result.stdout);
    } catch (error) {
      if (!/No online players/i.test(String(error?.message || ""))) throw error;
    }
  }
  if (!recipients) throw new Error("No online players are currently subscribed to any map.");
  return { code: 0, stdout: output.join("\n"), stderr: "", recipients };
}

function mapChatRegionForServerMap(map) {
  const value = String(map || "").trim();
  const aliases = { Survival_1: "HaggaBasin", Overmap: "Overland", DeepDesert_1: "DeepDesert", SH_Arrakeen: "Arrakeen", SH_HarkoVillage: "HarkoVillage" };
  return aliases[value] || value.replace(/^SH_/, "").replace(/^CB_Story_/, "").replace(/^CB_Dungeon_/, "").replace(/^DLC_Story_/, "");
}

async function scheduledMapMessagesRoute(req, res) {
  if (req.method === "GET") return json(res, 200, scheduledMapMessages.list());
  const body = await readJson(req);
  const action = String(body.action || "save").trim().toLowerCase();
  try {
    if (action === "save") {
      const schedule = scheduledMapMessages.save(body.schedule || body);
      audit(config, req, "admin.map-chat-schedule-save", { id: schedule.id, enabled: schedule.enabled, mapName: schedule.mapName, dimension: schedule.dimension, frequency: schedule.frequency, time: schedule.time, timezone: schedule.timezone });
      return json(res, 200, { ok: true, schedule, ...scheduledMapMessages.list() });
    }
    if (action === "delete") {
      const result = scheduledMapMessages.remove(body.id);
      audit(config, req, "admin.map-chat-schedule-delete", result);
      return json(res, 200, { ok: true, ...result, ...scheduledMapMessages.list() });
    }
    if (action === "run") {
      const result = await scheduledMapMessages.runNow(body.id);
      return json(res, 200, { ok: true, result, ...scheduledMapMessages.list() });
    }
    throw new Error("Scheduled message action must be save, delete, or run.");
  } catch (error) {
    const reason = redact(String(error?.message || "Unexpected error."));
    return json(res, 400, { error: reason, reason });
  }
}

async function mapChatRecipients(mapName, dimension) {
  if (!await duneDb.tableExists(db, "player_state") || !await duneDb.tableExists(db, "accounts") || !await duneDb.tableExists(db, "world_partition")) return [];
  const playerStateColumns = await duneDb.columnsFor(db, "player_state");
  const accountColumns = await duneDb.columnsFor(db, "accounts");
  let playerStateIdentityColumn = "";
  let accountIdentityColumn = "";
  if (playerStateColumns.has("account_id") && accountColumns.has("id")) {
    playerStateIdentityColumn = "account_id";
    accountIdentityColumn = "id";
  } else if (playerStateColumns.has("character_id") && accountColumns.has("character_id")) {
    playerStateIdentityColumn = "character_id";
    accountIdentityColumn = "character_id";
  } else if (playerStateColumns.has("character_id") && accountColumns.has("id")) {
    playerStateIdentityColumn = "character_id";
    accountIdentityColumn = "id";
  }
  if (!playerStateIdentityColumn || !accountIdentityColumn || !accountColumns.has("user") || !playerStateColumns.has("server_id")) return [];
  const maps = mapChatServerMaps(mapName);
  const dim = Number(dimension || 0);
  const values = [...maps, dim];
  const mapPlaceholders = maps.map((_, index) => `$${index + 1}`).join(",");
  const onlineCondition = playerStateColumns.has("online_status") ? "coalesce(ps.online_status::text, 'Offline') <> 'Offline'" : "true";
  const result = await db.query(`
    select distinct concat(ac."user", '_queue') as queue,
           coalesce(ac."user", '') as fls_id,
           coalesce(ac.funcom_id, '') as funcom_id
    from dune.player_state ps
    join dune.accounts ac on ac.${quoteIdentifier(accountIdentityColumn)} = ps.${quoteIdentifier(playerStateIdentityColumn)}
    join dune.world_partition wp on wp.server_id = ps.server_id
    where ${onlineCondition}
      and coalesce(ac."user", '') <> ''
      and wp.map in (${mapPlaceholders})
      and coalesce(wp.dimension_index, 0) = $${maps.length + 1}
    order by queue`, values);
  return (result.rows || []).map((row) => ({
    queue: String(row.queue || "").trim(),
    flsId: String(row.fls_id || "").trim(),
    funcomId: String(row.funcom_id || "").trim()
  })).filter((row) => row.queue);
}

function mapChatServerMaps(mapName) {
  const value = String(mapName || "").trim();
  const aliases = {
    HaggaBasin: ["Survival_1"],
    Overland: ["Overmap"],
    DeepDesert: ["DeepDesert_1"],
    Arrakeen: ["SH_Arrakeen"],
    HarkoVillage: ["SH_HarkoVillage"]
  };
  return aliases[value] || [value];
}

async function shutdownBroadcastRoute(req, res) {
  const body = await readJson(req);
  if (body.confirmation !== "SHUTDOWN BROADCAST") {
    recordAdminHistory(config, { command: "web-shutdown-broadcast", target: "all", friendly: "Shutdown broadcast publish test", path: "rmq:heartbeats/notifications", result: "blocked", message: "missing confirmation" });
    return json(res, 400, { error: "Confirmation phrase required: SHUTDOWN BROADCAST" });
  }
  try {
    const command = buildShutdownBroadcastCommand(body);
    const result = config.mockMode ? { code: 0, stdout: "mock shutdown broadcast\n", stderr: "", args: [] } : await publishServerCommand(config, command, "web-shutdown-broadcast");
    audit(config, req, "admin.broadcast-shutdown", { supported: true, command });
    recordAdminHistory(config, { command: "web-shutdown-broadcast", target: "all", friendly: "Shutdown broadcast publish test", path: "rmq:heartbeats/notifications", result: "published", message: `${body.shutdownType || "Restart"} in ${body.delayMinutes || 15} minutes` });
    return json(res, 200, { supported: true, ok: true, stdout: result.stdout, stderr: result.stderr, note: "Shutdown broadcast publish succeeded, but in-game visibility is unverified." });
  } catch (error) {
    audit(config, req, "admin.broadcast-shutdown", { supported: false, error: redact(error?.message || "Unexpected error.") });
    recordAdminHistory(config, { command: "web-shutdown-broadcast", target: "all", friendly: "Shutdown broadcast publish test", path: "rmq:heartbeats/notifications", result: "blocked", message: `${body.shutdownType || "Restart"} in ${body.delayMinutes || 15} minutes` });
    return json(res, 400, { supported: false, error: redact(error?.message || "Unexpected error."), reason: redact(error?.message || "Unexpected error.") });
  }
}

function taskRoute(req, res, path) {
  const parts = path.split("/");
  const id = parts[4];
  const taskObj = tasks.get(id);
  if (!taskObj) return json(res, 404, { error: "Task not found" });
  if (parts[5] === "stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify(publicTask(taskObj))}\n\n`);
    const unsubscribe = tasks.subscribe(id, (data) => res.write(data));
    req.on("close", unsubscribe);
    return;
  }
  return json(res, 200, { task: publicTask(taskObj) });
}

async function logsRoute(req, res, path) {
  const parts = path.split("/");
  const service = validateServiceName(parts[3]);
  if (parts[4] === "download") {
    try {
      const result = await readLogs(service, { timeoutMs: 30000 });
      const filename = `dune-${service}-logs.txt`.replace(/[^A-Za-z0-9._-]/g, "_");
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`
      });
      res.end(result.stdout || result.stderr || "");
    } catch (error) {
      json(res, 500, { error: redact(error.stdout || error?.message || "Unexpected error.") });
    }
    return;
  }
  if (parts[4] === "stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const controller = new AbortController();
    const disconnected = () => controller.abort();
    res.once("close", disconnected);
    try {
      await readLogs(service, {
        follow: true,
        timeoutMs: 30 * 60 * 1000,
        captureOutput: false,
        signal: controller.signal,
        onLine: (line) => {
          if (!res.destroyed) res.write(`data: ${JSON.stringify({ line })}\n\n`);
        }
      });
    } catch (error) {
      if (!res.destroyed) res.write(`event: error\ndata: ${JSON.stringify({ error: redact(error.message) })}\n\n`);
    } finally {
      res.off("close", disconnected);
      if (!res.destroyed && !res.writableEnded) res.end();
    }
    return;
  }
  let output = "";
  try {
    await readLogs(service, {
      timeoutMs: 5000,
      onLine: (line) => { output += line; }
    });
  } catch (error) {
    if (!output) output = redact(error.stdout || error.message || "");
  }
  return json(res, 200, { operation: "logs", stdout: output, stderr: "", exitCode: 0 });
}

function readLogs(service, options) {
  // The web Logs page needs historical tail output as well as optional follow mode.
  // RedBlink's `dune logs <service>` is optimized for CLI streaming and may not
  // return historical lines before the HTTP timeout. Use docker logs here with
  // strict service/container validation in runner.js.
  return runDockerLogs(service, options);
}

async function setupState() {
  const env = existsSync(resolve(config.repoRoot, ".env"));
  const token = existsSync(resolve(config.secretsDir, "funcom-token.txt"));
  const battlegroup = existsSync(resolve(config.generatedDir, "battlegroup.env"));
  const initialized = await isInitializedStackPresent();
  return {
    config: publicConfig(config),
    serverConfig: readSetupConfigValues(),
    publicDirectory: publicDirectorySettings(),
    files: {
      env,
      token,
      battlegroup,
      complete: (env && token && battlegroup) || initialized,
      initialized,
      duneScript: existsSync(config.duneScript)
    }
  };
}

function publicDirectorySettings() {
  const settings = readDirectorySettings(config.repoRoot);
  const reporter = publicDirectory.publicState();
  return {
    available: settings.mode === "public",
    enabled: settings.mode === "public" && settings.enabled,
    anonymousCountEnabled: settings.anonymousCountEnabled,
    discordInvite: settings.discordInvite,
    mode: settings.mode,
    state: reporter.state || (settings.mode === "public" ? "pending" : "local-only"),
    lastSuccessAt: reporter.lastSuccessAt || null,
    error: reporter.error || null,
    probeEndpoint: reporter.probeEndpoint || null,
    probeState: reporter.probeState || (settings.enabled ? "pending" : "disabled"),
    probeError: reporter.probeError || null
  };
}

function readSetupConfigValues() {
  const allowed = ["SERVER_IP", "SERVER_IP_MODE", "SERVER_TITLE", "SERVER_REGION", "SERVER_PROVIDER", "STEAM_APP_ID", "BATTLEGROUP_ID"];
  const values = {};
  for (const file of [resolve(config.repoRoot, ".env"), resolve(config.generatedDir, "battlegroup.env")]) {
    if (!existsSync(file)) continue;
    for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
      const parsed = parseEnvLine(rawLine);
      if (!parsed || !allowed.includes(parsed.key) || values[parsed.key] !== undefined) continue;
      values[parsed.key] = parsed.value;
    }
  }
  return values;
}

// One-time, idempotent migration: for each of coriolis_cycle_start_hour and
// _day, if this deployment's SERVER_REGION has a known regional value and the
// field has never been explicitly saved, write it once. Deliberately
// server-side and global-scope-only, not driven by the Maps UI -- an earlier
// version fired this from a frontend effect keyed off "field still at its
// schema default", which could not tell "never saved" from "explicitly saved
// to the default" (looped forever on a Europe deployment, whose region hour
// equals the default -- coriolis_cycle_start_day's default equals the
// region value for 3 of 5 regions, so this class of bug is not a one-region
// edge case here) and pinned whichever scope an admin happened to have open
// (breaking Global -> Map -> Partition inheritance). Idempotency here is by
// ini-key presence per field (checked in Python), never by value, so it is
// safe to call on every startup. Both fields are migrated in one Python
// invocation/profile write -- see migrate_coriolis_region_fields -- so a
// startup that needs to migrate both can't leave one written and the other
// not. Mirrors the fire-and-forget migration pattern already used for
// initializeDiscordAdapterSchema/ensureExchangeHistory below.
async function migrateCoriolisRegionFields() {
  const region = readSetupConfigValues().SERVER_REGION || "";
  if (!region) return;
  const result = await runDune(config, buildDuneArgs("userSettingsMigrateCoriolisRegionFields", { region }), { timeoutMs: 8000 });
  const [status, detail] = String(result.stdout || "").trim().split(":");
  if (status !== "migrated") return;
  audit(config, null, "maps.user-settings.auto-migrate", { scope: "global", fields: detail, region });
  markDeferredRestartPending(config, "Coriolis cycle start settings (region default)");
}

function readEnvFileValue(key) {
  const file = resolve(config.repoRoot, ".env");
  if (!existsSync(file)) return "";
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const parsed = parseEnvLine(rawLine);
    if (parsed?.key === key) return parsed.value;
  }
  return "";
}

function readMapsRuntimeSettings() {
  const raw = readEnvFileValue("DUNE_ALWAYS_ON_STARTUP_PARALLELISM") || process.env.DUNE_ALWAYS_ON_STARTUP_PARALLELISM || "";
  const parsed = Number(raw);
  const protectionEnabled = (readEnvFileValue("DUNE_ALWAYS_ON_HOST_MEMORY_SAFETY") || process.env.DUNE_ALWAYS_ON_HOST_MEMORY_SAFETY || "1") !== "0";
  const configuredReserve = readEnvFileValue("DUNE_ALWAYS_ON_HOST_MEMORY_RESERVE_GIB") || process.env.DUNE_ALWAYS_ON_HOST_MEMORY_RESERVE_GIB || "";
  const safety = calculateAlwaysOnHostMemorySafety(
    totalmem(),
    configuredReserve
  );
  const automaticSafety = calculateAlwaysOnHostMemorySafety(totalmem());
  const safeMaximum = protectionEnabled
    ? Math.min(MAX_ALWAYS_ON_STARTUP_PARALLELISM, safety.recommendedParallelism)
    : MAX_ALWAYS_ON_STARTUP_PARALLELISM;
  const value = Number.isInteger(parsed) && parsed >= 1
    ? Math.min(parsed, safeMaximum)
    : DEFAULT_ALWAYS_ON_STARTUP_PARALLELISM;
  return {
    alwaysOnStartupParallelism: value,
    configuredAlwaysOnStartupParallelism: Number.isInteger(parsed) && parsed >= 1 ? parsed : value,
    defaultAlwaysOnStartupParallelism: DEFAULT_ALWAYS_ON_STARTUP_PARALLELISM,
    maxAlwaysOnStartupParallelism: safeMaximum,
    configured: Boolean(raw),
    hostMemoryProtectionEnabled: protectionEnabled,
    hostMemorySafetyLimited: protectionEnabled && Number.isInteger(parsed) && parsed > safeMaximum,
    physicalMemoryGiB: safety.physicalMemoryGiB,
    hostMemoryReserveGiB: safety.reserveGiB,
    automaticHostMemoryReserveGiB: automaticSafety.reserveGiB,
    hostMemoryReserveConfigured: Boolean(configuredReserve)
  };
}

async function mapsRuntimeSettingsRoute(req, res) {
  const body = await readJson(req);
  const value = Number(body.alwaysOnStartupParallelism);
  const protectionEnabled = body.hostMemoryProtectionEnabled;
  const reserveValue = body.hostMemoryReserveGiB;
  if (typeof protectionEnabled !== "boolean") {
    return json(res, 400, { error: "Host memory protection must be enabled or disabled explicitly." });
  }
  const automaticReserve = reserveValue === null || reserveValue === "" || reserveValue === undefined;
  const reserveGiB = automaticReserve ? null : Number(reserveValue);
  const physicalMemoryGiB = calculateAlwaysOnHostMemorySafety(totalmem()).physicalMemoryGiB;
  if (!automaticReserve && (!Number.isInteger(reserveGiB) || reserveGiB < 1 || reserveGiB >= physicalMemoryGiB)) {
    return json(res, 400, { error: `Physical RAM reserve must be a whole number from 1 to ${Math.max(1, physicalMemoryGiB - 1)} GB, or Automatic.` });
  }
  const safety = calculateAlwaysOnHostMemorySafety(totalmem(), automaticReserve ? "" : String(reserveGiB));
  const safeMaximum = protectionEnabled
    ? Math.min(MAX_ALWAYS_ON_STARTUP_PARALLELISM, safety.recommendedParallelism)
    : MAX_ALWAYS_ON_STARTUP_PARALLELISM;
  if (!Number.isInteger(value) || value < 1 || value > safeMaximum) {
    return json(res, 400, { error: `Always-on startup parallelism must be a whole number from 1 to ${safeMaximum} with these protection settings.` });
  }
  updateEnvFileValue("DUNE_ALWAYS_ON_STARTUP_PARALLELISM", String(value));
  updateEnvFileValue("DUNE_ALWAYS_ON_HOST_MEMORY_SAFETY", protectionEnabled ? "1" : "0");
  updateEnvFileValue("DUNE_ALWAYS_ON_HOST_MEMORY_RESERVE_GIB", automaticReserve ? "" : String(reserveGiB));
  process.env.DUNE_ALWAYS_ON_STARTUP_PARALLELISM = String(value);
  process.env.DUNE_ALWAYS_ON_HOST_MEMORY_SAFETY = protectionEnabled ? "1" : "0";
  process.env.DUNE_ALWAYS_ON_HOST_MEMORY_RESERVE_GIB = automaticReserve ? "" : String(reserveGiB);
  audit(config, req, "maps.runtime-settings", {
    DUNE_ALWAYS_ON_STARTUP_PARALLELISM: value,
    DUNE_ALWAYS_ON_HOST_MEMORY_SAFETY: protectionEnabled ? 1 : 0,
    DUNE_ALWAYS_ON_HOST_MEMORY_RESERVE_GIB: automaticReserve ? "automatic" : reserveGiB
  });
  return json(res, 200, readMapsRuntimeSettings());
}

function parseEnvLine(line) {
  const text = String(line || "").trim();
  if (!text || text.startsWith("#")) return null;
  const index = text.indexOf("=");
  if (index <= 0) return null;
  const key = text.slice(0, index).trim();
  let value = text.slice(index + 1).trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

async function carePackageAutoTick() {
  if (carePackageAutoRunning) return;
  if (Date.now() < carePackageAutoNextAllowedRun) return;
  let kit;
  try {
    kit = carePackageConfig(config);
  } catch (error) {
    console.error(`Care Package auto-grant config read failed: ${redact(error?.message || "Unexpected error.")}`);
    return;
  }
  const hasEnabledRule = Array.isArray(kit.autoGrantRules) && kit.autoGrantRules.some((rule) => rule.enabled);
  if (!kit.enabled || !hasEnabledRule) return;
  const intervalMs = Math.max(60, Number(kit.autoGrantIntervalSeconds) || 60) * 1000;
  if (Date.now() - carePackageAutoLastRun < intervalMs) return;
  carePackageAutoRunning = true;
  carePackageAutoLastRun = Date.now();
  try {
    const players = await duneDb.listAllPlayers(db, {});
    if (players.capabilities?.players === false) return;
    const result = await runCarePackageAutoScan(config, players.rows || [], "auto", { db });
    if (result.granted || result.failed) {
      console.log(`Care Package auto-grant scan: granted=${result.granted || 0} skipped=${result.skipped || 0} failed=${result.failed || 0}`);
    }
    if (result.granted || result.skipped || result.failed) {
      audit(config, null, "care-package.auto-scan", { supported: true, granted: result.granted || 0, skipped: result.skipped || 0, failed: result.failed || 0 });
    }
    carePackageAutoNextAllowedRun = 0;
  } catch (error) {
    carePackageAutoNextAllowedRun = Date.now() + BACKGROUND_SCAN_FAILURE_BACKOFF_MS;
    console.error(`Care Package auto-grant scan failed: ${redact(error?.message || "Unexpected error.")}`);
  } finally {
    carePackageAutoRunning = false;
  }
}

async function messageOfTheDayAutoTick() {
  if (messageOfTheDayAutoRunning) return;
  const now = Date.now();
  if (now < messageOfTheDayAutoNextAllowedRun || now - messageOfTheDayAutoLastRun < 10000) return;
  let settings;
  try {
    settings = readMessageOfTheDay(config).settings;
  } catch (error) {
    messageOfTheDayAutoNextAllowedRun = Date.now() + BACKGROUND_SCAN_FAILURE_BACKOFF_MS;
    console.error(`Message of the Day config read failed: ${redact(error?.message || "Unexpected error.")}`);
    return;
  }
  if (!settings.enabled || !String(settings.message || "").trim()) return;
  messageOfTheDayAutoRunning = true;
  messageOfTheDayAutoLastRun = now;
  try {
    const players = await duneDb.listAllPlayers(db, { status: "online" });
    if (players.capabilities?.players === false) return;
    const result = await runMessageOfTheDayScan(config, players.rows || [], { db });
    if (result.sent || result.failed) {
      console.log(`Message of the Day scan: sent=${result.sent || 0} failed=${result.failed || 0}`);
      audit(config, null, "message-of-the-day.auto-scan", { supported: true, sent: result.sent || 0, failed: result.failed || 0 });
    }
    messageOfTheDayAutoNextAllowedRun = 0;
  } catch (error) {
    messageOfTheDayAutoNextAllowedRun = Date.now() + BACKGROUND_SCAN_FAILURE_BACKOFF_MS;
    const message = String(error?.message || "Unexpected error.");
    try {
      recordMessageOfTheDayScanFailure(config, error);
    } catch (statusError) {
      console.error(`Message of the Day failure status could not be saved: ${redact(statusError.message || statusError)}`);
    }
    console.error(`Message of the Day scan failed; retrying after backoff: ${redact(message)}`);
  } finally {
    messageOfTheDayAutoRunning = false;
  }
}

async function playerAnnouncementsAutoTick() {
  if (playerAnnouncementsAutoRunning) return;
  const now = Date.now();
  if (now < playerAnnouncementsAutoNextAllowedRun || now - playerAnnouncementsAutoLastRun < 10000) return;
  let settings;
  try {
    settings = readPlayerAnnouncements(config).settings;
  } catch (error) {
    playerAnnouncementsAutoNextAllowedRun = Date.now() + BACKGROUND_SCAN_FAILURE_BACKOFF_MS;
    console.error(`Player announcement config read failed: ${redact(error?.message || "Unexpected error.")}`);
    return;
  }
  if (!settings.joinEnabled && !settings.leaveEnabled) return;
  playerAnnouncementsAutoRunning = true;
  playerAnnouncementsAutoLastRun = now;
  try {
    const players = await duneDb.listAllPlayers(db, { status: "online" });
    if (players.capabilities?.players === false) return;
    const result = await runPlayerAnnouncementScan(config, players.rows || [], { db });
    if (result.joined || result.left || result.sent || result.failed) {
      console.log(`Player announcement scan: joined=${result.joined || 0} left=${result.left || 0} sent=${result.sent || 0} failed=${result.failed || 0} skipped_no_recipients=${result.skippedNoRecipients || 0}`);
      audit(config, null, "player-announcements.auto-scan", { supported: true, joined: result.joined || 0, left: result.left || 0, sent: result.sent || 0, failed: result.failed || 0, skippedNoRecipients: result.skippedNoRecipients || 0 });
    }
    playerAnnouncementsAutoNextAllowedRun = 0;
  } catch (error) {
    playerAnnouncementsAutoNextAllowedRun = Date.now() + BACKGROUND_SCAN_FAILURE_BACKOFF_MS;
    const message = String(error?.message || "Unexpected error.");
    if (/connect|database|relation|container|rabbitmq|docker|ECONNREFUSED/i.test(message)) return;
    console.error(`Player announcement scan failed: ${redact(message)}`);
  } finally {
    playerAnnouncementsAutoRunning = false;
  }
}

async function writeConfig(req, res) {
  const body = await readJson(req);
  const allowed = ["SERVER_IP", "SERVER_IP_MODE", "SERVER_TITLE", "SERVER_REGION", "SERVER_PROVIDER", "STEAM_APP_ID", "BATTLEGROUP_ID"];
  for (const key of allowed) {
    if (body[key] !== undefined) updateEnvFileValue(key, String(body[key]));
  }
  audit(config, req, "setup.write-config", { keys: Object.keys(body).filter((key) => allowed.includes(key)) });
  return json(res, 200, { ok: true });
}

async function publicDirectorySettingsRoute(req, res) {
  const body = await readJson(req);
  const hasEnabled = Object.hasOwn(body, "enabled");
  const hasDiscordInvite = Object.hasOwn(body, "discordInvite");
  const hasAnonymousCountEnabled = Object.hasOwn(body, "anonymousCountEnabled");
  if (!hasEnabled && !hasDiscordInvite && !hasAnonymousCountEnabled) {
    return json(res, 400, { error: "No public listing setting was provided." });
  }
  if (hasEnabled && typeof body.enabled !== "boolean") {
    return json(res, 400, { error: "Server listing enabled must be true or false." });
  }
  if (hasAnonymousCountEnabled && typeof body.anonymousCountEnabled !== "boolean") {
    return json(res, 400, { error: "Anonymous server count enabled must be true or false." });
  }
  const current = readDirectorySettings(config.repoRoot);
  if ((hasEnabled || hasDiscordInvite) && current.mode !== "public") {
    return json(res, 409, { error: "Server listing is available only when the server is running in public mode." });
  }
  let discordInvite = current.discordInvite;
  if (hasDiscordInvite) {
    discordInvite = normalizeDiscordInvite(body.discordInvite);
    if (discordInvite === null) {
      return json(res, 400, { error: "Enter a valid discord.gg or discord.com/invite link." });
    }
    updateEnvFileValue("DUNE_PUBLIC_DIRECTORY_DISCORD_INVITE", discordInvite);
  }
  if (hasEnabled) {
    updateEnvFileValue("DUNE_PUBLIC_DIRECTORY_ENABLED", body.enabled ? "true" : "false");
  }
  if (hasAnonymousCountEnabled) {
    updateEnvFileValue("DUNE_ANONYMOUS_SERVER_COUNT_ENABLED", body.anonymousCountEnabled ? "true" : "false");
  }
  audit(config, req, "settings.public-directory", {
    enabled: hasEnabled ? body.enabled : current.enabled,
    anonymousCountEnabled: hasAnonymousCountEnabled ? body.anonymousCountEnabled : current.anonymousCountEnabled,
    discordInviteConfigured: Boolean(discordInvite)
  });
  await publicDirectory.tick();
  return json(res, 200, { ok: true, publicDirectory: publicDirectorySettings() });
}

async function publicDirectoryClaimRoute(req, res) {
  const body = await readJson(req);
  const code = String(body.code || "").trim();
  if (!code) return json(res, 400, { error: "Enter the claim code from DuneDocker.app." });
  try {
    const result = await publicDirectory.verifyClaim(code);
    audit(config, req, "settings.public-directory.claim", { claimed: true, roleAssigned: result.roleAssigned === true });
    return json(res, 200, {
      ok: true,
      claimed: true,
      message: "Listing Claimed Successfully"
    });
  } catch (error) {
    return json(res, 400, { error: error?.message || "Unexpected error." });
  }
}

async function saveToken(req, res) {
  const body = await readJson(req);
  writeFuncomToken(config, body.token);
  audit(config, req, "setup.save-token", { token: "<redacted>" });
  return json(res, 200, { ok: true });
}

async function saveServerFuncomToken(req, res) {
  const body = await readJson(req);
  writeFuncomToken(config, body.token);
  audit(config, req, "server.save-funcom-token", { token: "<redacted>" });
  return json(res, 202, { task: tasks.create("server", "restartAll", {}) });
}

async function funcomTokenCheckRoute(req, res, url) {
  const since = validDockerSince(url.searchParams.get("since")) || "5m";
  const logs = await Promise.all([
    runDockerLogs("director", { since, tail: 600, timeoutMs: 10000 }).catch((error) => ({ stdout: "", stderr: error?.message || "Unexpected error." })),
    runDockerLogs("gateway", { since, tail: 600, timeoutMs: 10000 }).catch((error) => ({ stdout: "", stderr: error?.message || "Unexpected error." }))
  ]);
  const text = logs.map((result) => `${result.stdout || ""}\n${result.stderr || ""}`).join("\n");
  const mismatch = funcomAuthMismatchDetected(text);
  return json(res, 200, {
    ok: !mismatch,
    mismatch,
    checkedSince: since,
    details: mismatch ? matchingFuncomAuthLines(text) : ""
  });
}

async function readJson(req) {
  return readJsonBody(req, config.maxJsonBytes);
}

function mockCommand(operation) {
  return { operation, stdout: `Mock ${operation} output\n`, stderr: "", exitCode: 0 };
}

// Best-effort client address, IPv4-mapped IPv6 unwrapped. No X-Forwarded-For
// handling, matching every other limiter here -- behind a reverse proxy this
// records the proxy, not the caller. Per-key limits are unaffected: they key
// on the key id, not on this.
function remoteIpOf(req) {
  return (req?.socket?.remoteAddress || "").replace(/^::ffff:/, "") || null;
}

function loginRateLimitKey(req) {
  return req.socket?.remoteAddress || "unknown";
}

function applyMutationRateLimit(req, res, scope) {
  const sessionId = req.authSession?.id || "anonymous";
  const remoteIp = (req.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
  const key = `${scope}:${sessionId}:${remoteIp}`;
  const limit = mutationRateLimiter.check(key);
  if (!limit.allowed) {
    json(res, 429, { error: `Too many admin changes. Wait ${limit.retryAfterSeconds}s, then try again.` }, { "retry-after": String(limit.retryAfterSeconds) });
    return false;
  }
  mutationRateLimiter.record(key);
  return true;
}
