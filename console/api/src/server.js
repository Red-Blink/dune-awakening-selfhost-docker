import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync, chmodSync, mkdirSync, createReadStream, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadConfig, publicConfig } from "./config.js";
import { createAuth, setSessionCookie, clearSessionCookie, json, withSecurityHeaders } from "./auth.js";
import { createLoginRateLimiter } from "./rateLimit.js";
import { TaskManager, publicTask } from "./tasks.js";
import { preflight } from "./preflight.js";
import { buildDuneArgs, isDynamicServerService, isReadOnlySql, parseVehicleList, runDockerLogs, runDune, validateServiceName } from "./runner.js";
import { createDb, quoteIdentifier } from "./db.js";
import * as duneDb from "./duneDb.js";
import { audit, recordAdminHistory } from "./audit.js";
import { redact } from "./redact.js";
import { itemRequiresDatabaseGrant, listCatalogItems, resolveCatalogItem } from "./adminCatalog.js";
import { buildBroadcastCommand, buildShutdownBroadcastCommand, publishMapChat, publishServerCommand } from "./rmq.js";
import { clearCarePackageHistory, enableCarePackage, ensureCarePackageServerPersona, grantEligibleCarePackages, grantCarePackage, retryCarePackageGrant, runCarePackageAutoScan, saveCarePackageConfig, carePackageCapabilities, carePackageConfig, carePackageEligiblePlayers, carePackageHistory } from "./carePackage.js";
import { readJsonBody, readMultipartForm } from "./httpSafety.js";
import { parseBackupAutoStatus, parseBackupListRows } from "./statusParsers.js";
import { assertInstalledAddonPermission, fetchCommunityAddons, installCommunityAddon, installedAddonContentPath, listInstalledAddons, removeInstalledAddon, setInstalledAddonEnabled, syncInstalledAddonLifecycle } from "./addons.js";
import { performanceSnapshot as collectPerformanceSnapshot } from "./services/performance.js";
import { serveStatic, contentTypeForPath } from "./http/staticFiles.js";
import { discoverServices } from "./services/serviceDiscovery.js";
import { createBackupDownloadArchive, enrichBackupRows, nextImportedBackupName, normalizeImportedBackupMetadata, validBackupDownloadName } from "./services/backups.js";
import { createMemoryBalancer } from "./services/memoryBalancer.js";
import { updateEnvFileValue as updateEnvValue } from "./services/envFile.js";
import { funcomAuthMismatchDetected, matchingFuncomAuthLines, saveFuncomTokenValue as writeFuncomToken, validDockerSince } from "./services/funcomAuth.js";
import { readCharacterTransferSettings, saveCharacterTransferSettings } from "./services/characterTransferSettings.js";
import { handleDiscordAdapterRoute, isDiscordAdapterRoute } from "./services/discordAdapter.js";
import { primeMessageOfTheDayOnlineState, readMessageOfTheDay, restoreMessageOfTheDay, runMessageOfTheDayScan, saveMessageOfTheDay } from "./services/messageOfTheDay.js";
import { primePlayerAnnouncementOnlineState, readPlayerAnnouncements, restorePlayerAnnouncements, runPlayerAnnouncementScan, savePlayerAnnouncements } from "./services/playerAnnouncements.js";

const config = loadConfig();
const auth = createAuth(config);
const loginRateLimiter = createLoginRateLimiter();
const tasks = new TaskManager(config);
let db = createDb(config);
let carePackageAutoRunning = false;
let carePackageAutoLastRun = 0;
let messageOfTheDayAutoRunning = false;
let messageOfTheDayAutoLastRun = 0;
let playerAnnouncementsAutoRunning = false;
let playerAnnouncementsAutoLastRun = 0;
const journeyTagsData = loadJourneyTagsData();
const memoryBalancer = createMemoryBalancer(config);
const POSTGRES_UNAVAILABLE_MESSAGE = "Postgres is not running or is restarting. Wait for the database service to come back online, then refresh.";

process.on("unhandledRejection", (error) => {
  console.error(`Unhandled background rejection: ${redact(error?.message || error)}`);
});

createServer(async (req, res) => {
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
  if (!config.authDisabled) {
    console.log("Initial admin password is stored in runtime/secrets/admin-web-password.txt");
  }
  scheduleBootAutoStart();
});

setInterval(() => {
  runBackgroundTick("Care Package auto-grant", carePackageAutoTick);
  runBackgroundTick("Message of the Day", messageOfTheDayAutoTick);
  runBackgroundTick("Player announcements", playerAnnouncementsAutoTick);
}, 10000).unref?.();

setInterval(() => {
  if (!memoryBalancer.publicState().enabled) return;
  runBackgroundTick("Memory balancer", () => memoryBalancer.tick());
}, memoryBalancer.intervalMs).unref?.();

function runBackgroundTick(label, fn) {
  Promise.resolve()
    .then(fn)
    .catch((error) => {
      const message = String(error?.message || error);
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
    console.error(`Boot auto-start skipped: ${redact(error.message || error)}`);
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
  child.on("error", (error) => console.error(`Boot auto-start failed: ${redact(error.message || error)}`));
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
    return handleDiscordAdapterRoute({ req, res, path, config, readJson, json });
  }

  const session = auth.requireAuth(req, res);
  if (!session) return;

  if (path === "/api/setup/state") return json(res, 200, await setupState());
  if (path === "/api/setup/preflight" && req.method === "POST") return json(res, 200, await preflight(config));
  if (path === "/api/setup/write-config" && req.method === "POST") return writeConfig(req, res);
  if (path === "/api/setup/save-token" && req.method === "POST") return saveToken(req, res);
  if (path === "/api/setup/init" && req.method === "POST") return task(req, res, "setup", "init", {});
  if (path === "/api/setup/tasks") return json(res, 200, { tasks: tasks.list().map(publicTask) });
  if (path.startsWith("/api/setup/tasks/")) return taskRoute(req, res, path);

  if (path === "/api/server/status") return commandJson(res, "status");
  if (path === "/api/server/performance") return json(res, 200, await collectPerformanceSnapshot(config.repoRoot));
  if (path === "/api/server/readiness") return safeCommandJson(res, "readiness");
  if (path === "/api/server/ports") return commandJson(res, "ports");
  if (path === "/api/server/services") return commandJson(res, "services");
  if (path === "/api/server/doctor") return safeCommandJson(res, "doctor");
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

  if (path === "/api/updates/check-game" && req.method === "POST") return task(req, res, "updates", "updateCheck", {});
  if (path === "/api/updates/apply-game" && req.method === "POST") return task(req, res, "updates", "updateApply", {});
  if (path === "/api/updates/fix-steamcmd" && req.method === "POST") return task(req, res, "updates", "updateFixSteamcmd", {});
  if (path === "/api/updates/check-stack" && req.method === "POST") return task(req, res, "updates", "selfUpdateCheck", {});
  if (path === "/api/updates/apply-stack" && req.method === "POST") return task(req, res, "updates", "selfUpdateApply", {});
  if (path === "/api/updates/auto-game" && req.method === "POST") return autoGameUpdateRoute(req, res);
  if (path === "/api/updates/auto-game") return safeCommandJson(res, "updateAutoStatus");
  if (path === "/api/updates/repair-runtime" && req.method === "POST") return task(req, res, "updates", "readiness", {});

  if (path === "/api/backups") return backupsListRoute(res);
  if (path === "/api/backups/auto" && req.method === "POST") return autoBackupRoute(req, res);
  if (path === "/api/backups/import-external" && req.method === "POST") return externalBackupImportRoute(req, res);
  if (path === "/api/backups/auto") return backupAutoStatusRoute(res);
  if (path === "/api/backups/create" && req.method === "POST") return task(req, res, "backup", "backupCreate", {});
  if (path === "/api/backups/delete-all" && req.method === "POST") return task(req, res, "backup", "backupDeleteAll", {});
  if (path === "/api/backups/restore" && req.method === "POST") {
    const body = await readJson(req);
    return task(req, res, "backup", "backupRestore", { backup: body.backup });
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

  if (path === "/api/players") return dbJson(res, () => duneDb.listPlayers(db, { q: url.searchParams.get("q") || "" }));
  if (path === "/api/players/online") return dbJson(res, () => duneDb.listPlayers(db, { online: true }));
  if (path === "/api/players/search") return dbJson(res, () => duneDb.listPlayers(db, { q: url.searchParams.get("q") || "" }));
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
  if (path.match(/^\/api\/players\/[^/]+\/add-xp$/) && req.method === "POST") return playerTask(req, res, path, "adminAddXp");
  if (path.match(/^\/api\/players\/[^/]+\/set-skill-points$/) && req.method === "POST") return playerTask(req, res, path, "adminSetSkillPoints");
  if (path.match(/^\/api\/players\/[^/]+\/set-skill-module$/) && req.method === "POST") return playerTask(req, res, path, "adminSetSkillModule");
  if (path.match(/^\/api\/players\/[^/]+\/refill-water$/) && req.method === "POST") return playerTask(req, res, path, "adminRefillWater");
  if (path.match(/^\/api\/players\/[^/]+\/kick$/) && req.method === "POST") return playerTask(req, res, path, "adminKick");
  if (path.match(/^\/api\/players\/[^/]+\/repair-login-queue$/) && req.method === "POST") return playerTask(req, res, path, "adminRepairLoginQueue", "REPAIR LOGIN QUEUE");
  if (path === "/api/players/kick-all-online" && req.method === "POST") return confirmedTask(req, res, "admin", "adminKickAllOnline", {}, "KICK ALL ONLINE PLAYERS");
  if (path.match(/^\/api\/players\/[^/]+\/teleport$/) && req.method === "POST") return playerTask(req, res, path, "adminTeleport");
  if (path.match(/^\/api\/players\/[^/]+\/spawn-vehicle$/) && req.method === "POST") return playerTask(req, res, path, "adminSpawnVehicle");
  if (path.match(/^\/api\/players\/[^/]+\/clean-inventory$/) && req.method === "POST") return playerTask(req, res, path, "adminCleanInventory", "CLEAN INVENTORY");
  if (path.match(/^\/api\/players\/[^/]+\/reset-progression$/) && req.method === "POST") return playerTask(req, res, path, "adminResetProgression", "RESET PROGRESSION");
  if (path.match(/^\/api\/players\/[^/]+\/add-currency$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.add-currency", "ADD CURRENCY", (playerId, body) => duneDb.addCurrency(db, playerId, body));
  if (path.match(/^\/api\/players\/[^/]+\/add-faction-reputation$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.add-faction-reputation", "ADD FACTION REPUTATION", (playerId, body) => duneDb.addFactionReputation(db, playerId, body));
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
  if (path.match(/^\/api\/players\/[^/]+\/refuel-vehicle$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.refuel-vehicle", "REFUEL VEHICLE", (playerId, body) => duneDb.refuelVehicle(db, playerId, body));
  if (path.match(/^\/api\/players\/[^/]+\/inventory\/[^/]+$/) && req.method === "DELETE") return inventoryDeleteRoute(req, res, path);
  if (path.match(/^\/api\/players\/[^/]+\/crafting-recipes$/)) return dbPlayerRoute(res, path, duneDb.playerCraftingRecipes);
  if (path.match(/^\/api\/players\/[^/]+\/research-items$/)) return dbPlayerRoute(res, path, duneDb.playerResearchItems);
  if (path.match(/^\/api\/players\/[^/]+\/journey$/)) return dbPlayerRoute(res, path, (database, playerId) => duneDb.playerJourney(database, playerId, journeyTagsData));
  if (path.match(/^\/api\/players\/[^/]+\/inventory$/)) return dbPlayerRoute(res, path, duneDb.playerInventory);
  if (path.match(/^\/api\/players\/[^/]+\/currency$/)) return dbPlayerRoute(res, path, duneDb.playerCurrency);
  if (path.match(/^\/api\/players\/[^/]+\/factions$/)) return dbPlayerRoute(res, path, duneDb.playerFactions);
  if (path.match(/^\/api\/players\/[^/]+\/specs$/)) return dbPlayerRoute(res, path, duneDb.playerSpecs);
  if (path.match(/^\/api\/players\/[^/]+\/position$/)) return dbPlayerRoute(res, path, duneDb.playerPosition);
  if (path.match(/^\/api\/players\/[^/]+\/progression$/)) return dbPlayerUnsupported(res, path, "progression");
  if (path.match(/^\/api\/players\/[^/]+\/events$/)) return dbPlayerUnsupported(res, path, "events");
  if (path.match(/^\/api\/players\/[^/]+\/stats$/)) return dbPlayerUnsupported(res, path, "stats");
  if (path.match(/^\/api\/players\/[^/]+\/history$/)) return dbPlayerUnsupported(res, path, "history");
  if (path.match(/^\/api\/players\/[^/]+$/)) return dbPlayerRoute(res, path, duneDb.playerProfile);

  if (path === "/api/storage") return dbJson(res, () => duneDb.listStorage(db));
  if (path.match(/^\/api\/storage\/[^/]+$/)) return dbJson(res, async () => ({ storage: (await duneDb.listStorage(db)).rows.find((row) => String(row.id) === decodeURIComponent(path.split("/")[3])) || null }));
  if (path.match(/^\/api\/storage\/[^/]+\/items$/)) return dbJson(res, () => duneDb.storageItems(db, decodeURIComponent(path.split("/")[3])));
  if (path.match(/^\/api\/storage\/[^/]+\/give-item$/) && req.method === "POST") return storageGiveItemRoute(req, res, path);
  if (path.match(/^\/api\/storage\/[^/]+\/export$/)) return exportJson(res, `storage-${decodeURIComponent(path.split("/")[3])}.json`, () => duneDb.storageItems(db, decodeURIComponent(path.split("/")[3])));
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
  if (path === "/api/map/overlays") return dbJson(res, () => duneDb.liveMapMarkers(db, url.searchParams.get("map") || ""));
  if (path === "/api/maps/mode" && req.method === "POST") return confirmedTask(req, res, "maps", "mapsSetMode", {}, "SET MAP MODE");
  if (path === "/api/maps/settings" && req.method === "POST") return mapSettingsRoute(req, res);
  if (path === "/api/maps") return commandJson(res, "mapsList");
  if (path === "/api/maps/mode") return commandJson(res, "mapsMode", { map: url.searchParams.get("map") || "" });
  if (path === "/api/maps/reconcile" && req.method === "POST") return confirmedTask(req, res, "maps", "mapsReconcile", {}, "RECONCILE MAPS");
  if (path === "/api/maps/spawn" && req.method === "POST") return confirmedTask(req, res, "maps", "mapsSpawn", {}, "SPAWN MAP");
  if (path === "/api/maps/despawn" && req.method === "POST") return confirmedTask(req, res, "maps", "mapsDespawn", {}, "DESPAWN MAP");
  if (path === "/api/maps/autoscaler" && req.method === "POST") return confirmedTask(req, res, "maps", "autoscalerAction", {}, "AUTOSCALER CHANGE");
  if (path === "/api/maps/autoscaler") return commandJson(res, "autoscalerStatus");
  if (path === "/api/maps/memory" && req.method === "POST") return memoryRoute(req, res);
  if (path === "/api/maps/memory/balancer" && req.method === "POST") return memoryBalancerRoute(req, res);
  if (path === "/api/maps/memory/balancer") return json(res, 200, memoryBalancer.publicState());
  if (path === "/api/maps/memory/live") return liveMapMemoryRoute(res);
  if (path === "/api/maps/memory") return commandJson(res, "memoryStatus");
  if (path === "/api/maps/user-settings/schema") return userSettingsSchemaRoute(res);
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
  if (path === "/api/settings" && req.method === "POST") return writeConfig(req, res);
  if (path === "/api/settings") return json(res, 200, await setupState());

  return json(res, 404, { error: "Not found" });
}

async function addonBridgeRoute(req, res, path) {
  const id = decodeURIComponent(path.split("/").at(-2));
  const body = await readJson(req);
  const action = String(body.action || "").trim();
  if (action === "leadership.players.list") {
    const addon = assertInstalledAddonPermission(config, id, "players:read");
    const result = await duneDb.addonLeadershipPlayers(db);
    audit(config, req, "addons.bridge", { id: addon.id, action, permission: addon.permission, ok: true });
    return json(res, 200, { ok: true, result });
  }
  if (action === "database.query" || action === "database.execute") {
    const query = String(body.query || "");
    const readOnly = isReadOnlySql(query);
    const requiredPermission = readOnly ? "database:read" : "database:write";
    if (action === "database.query" && !readOnly) return json(res, 400, { error: "database.query accepts read-only SQL only. Use database.execute with database:write permission for write SQL." });
    const addon = assertInstalledAddonPermission(config, id, requiredPermission);
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
    const [markers, partitions] = await Promise.all([
      duneDb.liveMapMarkers(db, configPayload.map.actorMap || configPayload.map.key),
      duneDb.liveMapPartitions(db).catch(() => ({ rows: [] }))
    ]);
    return {
      ...markers,
      ...configPayload,
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
      return json(res, 400, { error: redact(error.message || error) });
    }
    audit(config, req, "live-map.teleport.live", { playerId, x: payload.x, y: payload.y, z: payload.z, partitionId: payload.partitionId });
    return json(res, 202, { path: "live", task: tasks.create("admin", "adminTeleport", payload) });
  }
  try {
    const result = await duneDb.teleportOfflinePlayerToCoords(db, playerId, payload);
    audit(config, req, "live-map.teleport.offline", { playerId, supported: result.supported, x: payload.x, y: payload.y, z: payload.z, partitionId: payload.partitionId });
    return json(res, 200, { path: "offline", ...result });
  } catch (error) {
    audit(config, req, "live-map.teleport.offline", { playerId, supported: false, error: redact(error.message || error) });
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
  if (/^web-(broadcast|shutdown-broadcast)$/i.test(command)) return true;
  if (/^web-hydrate-all$/i.test(command)) return true;
  if (/^KickPlayer$/i.test(command) && /^(all|\*)$/i.test(target)) return true;
  return false;
}

async function safeCommandJson(res, operation, payload = {}) {
  if (config.mockMode) return json(res, 200, mockCommand(operation));
  return json(res, 200, await safeCommand(operation, payload));
}

async function backupsListRoute(res) {
  if (config.mockMode) return json(res, 200, { ...mockCommand("backupList"), rows: [] });
  const result = await runDune(config, buildDuneArgs("backupList"));
  return json(res, 200, { operation: "backupList", stdout: result.stdout, stderr: result.stderr, exitCode: result.code, rows: enrichBackupRows(config, parseBackupListRows(result.stdout)) });
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

async function safeCommand(operation, payload = {}) {
  try {
    const args = buildDuneArgs(operation, payload);
    const result = await runDune(config, args);
    return { operation, stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
  } catch (error) {
    return { operation, stdout: redact(error.stdout || ""), stderr: redact(error.stderr || error.message || error), exitCode: error.code || 1 };
  }
}

async function databaseQuery(req, res) {
  const body = await readJson(req);
  const query = String(body.query || "");
  const readOnly = isReadOnlySql(query);
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
    const composeProjectName = process.env.DUNE_COMPOSE_PROJECT_NAME || process.env.COMPOSE_PROJECT_NAME || "dune-awakening-selfhost-docker";
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
    const child = spawn("docker", [
      "run",
      "--rm",
      "-d",
      "--name", helperName,
      "--network", "host",
      "-v", `${hostRepoRoot}:/repo`,
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      "-e", `ADMIN_BIND_PORT=${port}`,
      "-e", `DUNE_HOST_REPO_ROOT=${hostRepoRoot}`,
      "-e", `COMPOSE_PROJECT_NAME=${composeProjectName}`,
      "-e", `DUNE_COMPOSE_PROJECT_NAME=${composeProjectName}`,
      "-e", `DOCKER_SOCKET_GID=${process.env.DOCKER_SOCKET_GID || ""}`,
      "-w", "/repo",
      "redblink-dune-docker-console:dev",
      "sh", "-lc", script
    ], {
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
  const rawMessage = String(error?.message || error || "");
  if (isPostgresUnavailableError(error, rawMessage)) {
    return {
      status: 503,
      body: { error: POSTGRES_UNAVAILABLE_MESSAGE, reason: POSTGRES_UNAVAILABLE_MESSAGE }
    };
  }
  const message = redact(friendlyJsonError(rawMessage));
  return {
    status: error?.statusCode || fallbackStatus,
    body: { error: message, reason: message, details: error?.details || undefined }
  };
}

function isPostgresUnavailableError(error, rawMessage = "") {
  return error?.code === "ECONNREFUSED"
    || /ECONNREFUSED.*127\.0\.0\.1:15432/i.test(rawMessage)
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
    json(res, status, { supported: false, error: redact(error.message || error), reason: redact(error.message || error), details: error.details || undefined });
  }
}

function databaseTableRoute(req, res, path, action, url) {
  const parts = path.split("/");
  const schema = decodeURIComponent(parts[4]);
  const table = decodeURIComponent(parts[5]);
  if (action === "columns") return dbJson(res, () => duneDb.tableColumns(db, schema, table));
  if (action === "count") return dbJson(res, () => duneDb.tableCount(db, schema, table));
  return dbJson(res, () => duneDb.tablePreview(db, schema, table, url.searchParams.get("limit") || 50, url.searchParams.get("offset") || 0));
}

function dbPlayerRoute(res, path, fn) {
  const id = decodeURIComponent(path.split("/")[3]);
  return dbJson(res, () => fn(db, id));
}

function dbPlayerUnsupported(res, path, feature) {
  const id = decodeURIComponent(path.split("/")[3]);
  return dbJson(res, () => duneDb.unsupportedPlayerFeature(db, id, feature));
}

async function task(req, res, type, operation, payload) {
  try {
    buildDuneArgs(operation, payload);
  } catch (error) {
    return json(res, 400, { error: redact(error.message || error) });
  }
  audit(config, req, `task.${operation}`, payload);
  return json(res, 202, { task: tasks.create(type, operation, payload) });
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
    return json(res, error.statusCode || 500, { error: redact(error.message || error) });
  }
}

async function messageOfTheDayRoute(req, res) {
  if (req.method === "GET") return json(res, 200, readMessageOfTheDay(config));
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  const body = await readJson(req);
  try {
    const result = body.restoreDefaults ? restoreMessageOfTheDay(config) : saveMessageOfTheDay(config, body.settings || body);
    if (result.settings.enabled) {
      const players = await duneDb.listPlayers(db, { online: true }).catch(() => ({ rows: [] }));
      primeMessageOfTheDayOnlineState(config, players.rows || []);
    }
    audit(config, req, "admin.message-of-the-day.save", { restoreDefaults: Boolean(body.restoreDefaults), enabled: result.settings.enabled });
    recordAdminHistory(config, {
      command: "web-message-of-the-day",
      target: "login",
      friendly: "Message of the Day",
      path: "runtime/generated/message-of-the-day.json",
      result: "saved",
      message: result.settings.enabled ? result.settings.message : "disabled"
    });
    return json(res, 200, { ok: true, ...result });
  } catch (error) {
    audit(config, req, "admin.message-of-the-day.save", { supported: false, error: redact(error.message || error) });
    return json(res, error.statusCode || 400, { error: redact(error.message || error) });
  }
}

async function playerAnnouncementsRoute(req, res) {
  if (req.method === "GET") return json(res, 200, readPlayerAnnouncements(config));
  if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
  const body = await readJson(req);
  try {
    const result = body.restoreDefaults ? restorePlayerAnnouncements(config) : savePlayerAnnouncements(config, body.settings || body);
    if (result.settings.joinEnabled || result.settings.leaveEnabled) {
      const players = await duneDb.listPlayers(db, { online: true }).catch(() => ({ rows: [] }));
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
    audit(config, req, "admin.player-announcements.save", { supported: false, error: redact(error.message || error) });
    return json(res, error.statusCode || 400, { error: redact(error.message || error) });
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
    return json(res, 500, { error: redact(error.message || error) });
  }
}

async function userSettingsRawRoute(res, url) {
  const kind = String(url.searchParams.get("kind") || "engine");
  const map = url.searchParams.get("map") || "Survival_1";
  const partitionId = url.searchParams.get("partitionId") || "";
  const operation = kind === "profile" ? "userSettingsProfileRaw" : kind === "engine" ? "userSettingsRawEngine" : "userSettingsRawGame";
  try {
    const result = await runDune(config, buildDuneArgs(operation, { map, partitionId }), { timeoutMs: 8000, redactOutput: false });
    return json(res, 200, { content: result.stdout || "" });
  } catch (error) {
    return json(res, 500, { error: redact(error.message || error) });
  }
}

async function userSettingsSaveRoute(req, res) {
  const body = await readJson(req);
  const payload = userSettingsTaskPayload(body);
  audit(config, req, "maps.user-settings.save", { scope: payload.scope, map: payload.map, partitionId: payload.partitionId, restartMode: payload.restartMode });
  return json(res, 202, { task: tasks.create("maps", "userSettingsSaveAndRestart", payload) });
}

async function userSettingsResetRoute(req, res) {
  const body = await readJson(req);
  if (body.confirmation !== "RESTORE MAP DEFAULTS") return json(res, 400, { error: "Confirmation phrase required: RESTORE MAP DEFAULTS" });
  const payload = userSettingsTaskPayload({ ...body, values: {} });
  audit(config, req, "maps.user-settings.reset", { scope: payload.scope, map: payload.map, partitionId: payload.partitionId, restartMode: payload.restartMode });
  return json(res, 202, { task: tasks.create("maps", "userSettingsResetAndRestart", payload) });
}

async function userSettingsRawWriteRoute(req, res) {
  const body = await readJson(req);
  const payload = userSettingsTaskPayload({ ...body, values: {}, content: String(body.content || "") });
  audit(config, req, "maps.user-settings.raw-write", { scope: payload.scope, map: payload.map, partitionId: payload.partitionId, restartMode: payload.restartMode });
  return json(res, 202, { task: tasks.create("maps", "userSettingsRawAndRestart", payload) });
}

function userSettingsTaskPayload(body) {
  const scope = ["engine", "global", "map", "partition", "profile"].includes(String(body.scope || "")) ? String(body.scope) : "map";
  const map = String(body.map || "Survival_1");
  const partitionId = String(body.partitionId || "").trim();
  const values = body.values && typeof body.values === "object" && !Array.isArray(body.values) ? body.values : {};
  return {
    scope,
    map,
    partitionId,
    values,
    content: String(body.content || ""),
    ...restartPayload(scope, map, partitionId)
  };
}

function restartPayload(scope, map, partitionId) {
  if (scope === "profile") return { restartMode: "stack", restartLabel: "all game services" };
  if (scope === "engine") return { restartMode: "stack", restartLabel: "all game services" };
  if (scope === "global") return { restartMode: "stack", restartLabel: "all game services" };
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
    const rows = await memoryBalancer.readLiveRows();
    return json(res, 200, { rows, sampledAt: new Date().toISOString() });
  } catch (error) {
    return json(res, 200, { rows: [], sampledAt: new Date().toISOString(), error: redact(error.message || error) });
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
    sync: "sietchesSync",
    validate: "sietchesValidate",
    reconcile: "sietchesReconcile"
  };
  const operation = operationByAction[String(body.action || "")];
  if (!operation) return json(res, 400, { error: "Unsupported sietch update action" });
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
  const playerId = decodeURIComponent(path.split("/")[3]);
  return task(req, res, "admin", operation, { ...body, playerId });
}

async function carePackageConfigRoute(req, res) {
  const body = await readJson(req);
  if (body.confirmation !== "SAVE CARE PACKAGE") return json(res, 400, { error: "Confirmation phrase required: SAVE CARE PACKAGE" });
  try {
    const saved = saveCarePackageConfig(config, body);
    audit(config, req, "care-package.config", { supported: true, enabled: saved.enabled, version: saved.version, itemCount: saved.items.length, xp: saved.xp });
    return json(res, 200, saved);
  } catch (error) {
    audit(config, req, "care-package.config", { supported: false, error: redact(error.message || error) });
    return json(res, 400, { error: redact(error.message || error) });
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
    return json(res, 400, { error: redact(error.message || error) });
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
    audit(config, req, "care-package.grant", { supported: false, playerId, error: redact(error.message || error) });
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

async function carePackageEligibleRoute(req, res) {
  try {
    const params = new URL(req.url, "http://localhost").searchParams;
    const players = await duneDb.listPlayers(db, {});
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
    const players = await duneDb.listPlayers(db, {});
    if (players.capabilities?.players === false) return json(res, 501, { supported: false, reason: players.reason || "Player list is unavailable" });
    const result = await grantEligibleCarePackages(config, players.rows || [], await readJson(req), { db });
    audit(config, req, "care-package.grant-eligible", { supported: true, granted: result.granted, skipped: result.skipped, failed: result.failed });
    return json(res, result.failed ? 207 : 200, result);
  } catch (error) {
    audit(config, req, "care-package.grant-eligible", { supported: false, error: redact(error.message || error) });
    const payload = apiErrorPayload(error, 400);
    return json(res, payload.status, payload.body);
  }
}

async function carePackageRunRoute(req, res) {
  const body = await readJson(req);
  if (body.confirmation !== "RUN CARE PACKAGE SCAN") return json(res, 400, { error: "Confirmation phrase required: RUN CARE PACKAGE SCAN" });
  try {
    const players = await duneDb.listPlayers(db, {});
    if (players.capabilities?.players === false) return json(res, 501, { supported: false, reason: players.reason || "Player list is unavailable" });
    const result = await runCarePackageAutoScan(config, players.rows || [], "manual-scan", { db });
    audit(config, req, "care-package.run", { supported: true, ...result, results: undefined });
    return json(res, result.failed ? 207 : 200, result);
  } catch (error) {
    audit(config, req, "care-package.run", { supported: false, error: redact(error.message || error) });
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
    audit(config, req, "care-package.retry", { supported: false, grantId, error: redact(error.message || error) });
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
    audit(config, req, "care-package.history-clear", { supported: false, error: redact(error.message || error) });
    return json(res, 400, { error: redact(error.message || error) });
  }
}

async function resolveCarePackagePlayerIdentity(playerId) {
  const players = await duneDb.listPlayers(db, {});
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
  const players = await duneDb.listPlayers(db, {}).catch(() => ({ rows: [] }));
  const rows = players.rows || [];
  const target = String(playerId || "").toLowerCase();
  const player = rows.find((row) => [row.action_player_id, row.funcom_id, row.fls_id, row.account_id, row.actor_id, row.player_pawn_id]
    .some((value) => String(value || "").toLowerCase() === target));
  return {
    actionId: String(player?.action_player_id || player?.funcom_id || player?.fls_id || playerId || ""),
    actorId: String(player?.actor_id || player?.player_pawn_id || (/^\d+$/.test(String(playerId || "")) ? playerId : "") || ""),
    characterName: player?.character_name || "",
    online: String(player?.online_status || "").toLowerCase() === "online"
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

async function inventoryDeleteRoute(req, res, path) {
  const parts = path.split("/");
  const playerId = decodeURIComponent(parts[3]);
  const itemId = decodeURIComponent(parts[5]);
  return directDbMutation(req, res, "players.inventory-delete", "DELETE ITEM", () => duneDb.deleteInventoryItem(db, playerId, itemId), { playerId, itemId });
}

async function storageGiveItemRoute(req, res, path) {
  const storageId = decodeURIComponent(path.split("/")[3]);
  return directDbMutation(req, res, "storage.give-item", "GIVE ITEM TO STORAGE", async (body) => {
    const resolved = resolveCatalogItem(config.repoRoot, body);
    return duneDb.giveItemToStorage(db, storageId, { ...body, templateId: resolved.itemId });
  }, { storageId });
}

async function directDbMutation(req, res, action, phrase, fn, meta = {}) {
  const body = await readJson(req);
  if (phrase && body.confirmation !== phrase) {
    return json(res, 400, { error: `Confirmation phrase required: ${phrase}` });
  }
  try {
    const result = config.mockMode ? { ok: true, mock: true } : await fn(body);
    audit(config, req, action, { ...meta, supported: true, result });
    return json(res, 200, { supported: true, backupCreated: false, result });
  } catch (error) {
    const status = error.unsupported ? 501 : 400;
    audit(config, req, action, { ...meta, supported: false, error: redact(error.message || error) });
    return json(res, status, { supported: false, error: redact(error.message || error), reason: redact(error.message || error), details: error.details || undefined });
  }
}

async function giveItemsRoute(req, res, path) {
  const body = await readJson(req);
  const playerId = decodeURIComponent(path.split("/")[3]);
  if (!Array.isArray(body.items)) {
    return task(req, res, "admin", "adminGiveItems", { ...body, playerId });
  }
  if (body.items.length < 1 || body.items.length > 25) return json(res, 400, { error: "Give Multiple Items requires 1-25 items" });

  const results = [];
  const target = await resolvePlayerGrantTarget(playerId);
  for (const [index, item] of body.items.entries()) {
    try {
      results.push({ index, ...(await grantPlayerItem(playerId, item, target)) });
    } catch (error) {
      results.push({ index, ok: false, item, error: redact(error.message || error) });
    }
  }
  const ok = results.every((result) => result.ok);
  audit(config, req, "players.give-items", { playerId, count: body.items.length, ok, results });
  if (body.historyScope === "admin-tools") {
    const friendly = body.historyFriendly || "Grant Items";
    recordAdminHistory(config, { command: "web-hydrate-all", target: "all", friendly, path: "players.give-items", result: ok ? "published" : "failed", message: `${friendly} for ${playerId}` });
  }
  return json(res, ok ? 200 : 207, { ok, results });
}

async function giveSingleItemRoute(req, res, path, operation) {
  const body = await readJson(req);
  const playerId = decodeURIComponent(path.split("/")[3]);
  if (body.quality === undefined && body.grade === undefined) {
    const resolved = operation === "adminGiveItemId"
      ? resolveCatalogItem(config.repoRoot, { itemId: body.itemId })
      : resolveCatalogItem(config.repoRoot, { itemName: body.itemName });
    if (!itemRequiresDatabaseGrant(resolved)) {
      return task(req, res, "admin", operation, { ...body, playerId });
    }
  }
  const item = operation === "adminGiveItemId"
    ? { itemId: body.itemId, quantity: body.quantity, quality: body.quality, grade: body.grade, durability: body.durability }
    : { itemName: body.itemName, quantity: body.quantity, quality: body.quality, grade: body.grade, durability: body.durability };
  try {
    const target = await resolvePlayerGrantTarget(playerId);
    const result = await grantPlayerItem(playerId, item, target);
    audit(config, req, operation === "adminGiveItemId" ? "players.give-item-id" : "players.give-item", { playerId, ok: result.ok, result });
    return json(res, result.ok ? 200 : 207, result);
  } catch (error) {
    audit(config, req, operation === "adminGiveItemId" ? "players.give-item-id" : "players.give-item", { playerId, ok: false, error: redact(error.message || error) });
    return json(res, 400, { ok: false, error: redact(error.message || error) });
  }
}

async function grantPlayerItem(playerId, item, target) {
  const resolved = item.itemId ? { itemId: item.itemId } : resolveCatalogItem(config.repoRoot, item);
  const operation = resolved.itemId ? "adminGiveItemId" : "adminGiveItem";
  const hasExplicitGrade = item.quality !== undefined || item.grade !== undefined;
  const selectedGrade = hasExplicitGrade ? validateGrantGrade(item.quality ?? item.grade) : undefined;
  const usesDatabaseGrant = (selectedGrade !== undefined && selectedGrade > 0) || itemRequiresDatabaseGrant(resolved);
  const databaseGrade = hasExplicitGrade ? selectedGrade : 0;
  const payload = {
    playerId: target.actionId || playerId,
    itemId: resolved.itemId,
    itemName: item.itemName,
    quantity: item.quantity ?? 1,
    quality: hasExplicitGrade ? selectedGrade : undefined,
    durability: 1
  };
  if (usesDatabaseGrant) {
    if (!config.mockMode && !target.actorId) throw new Error("A database actor ID is required to grant graded items, schematics, and augments");
    const result = config.mockMode
      ? { ok: true, inserted: { template_id: resolved.itemId || payload.itemName, stack_size: payload.quantity, quality_level: databaseGrade } }
      : await duneDb.giveItemToPlayer(db, target.actorId, {
          templateId: resolved.itemId || "",
          itemName: payload.itemName,
          quantity: payload.quantity,
          quality: databaseGrade
        });
    return { ok: true, operation: "dbGiveItemToPlayer", item: { ...payload, quality: databaseGrade }, result };
  }
  const command = buildDuneArgs(operation, payload);
  if (config.mockMode) return { ok: true, operation, command };
  const result = await runDune(config, command);
  return { ok: true, operation, item: payload, stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
}

function validateGrantGrade(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.trunc(n) !== n || n < 0 || n > 5) throw new Error("Expected item grade 0-5");
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
    audit(config, req, "admin.broadcast", { supported: false, error: redact(error.message || error) });
    recordAdminHistory(config, { command: "web-broadcast", target: "all", friendly: body.title || "Broadcast", path: "rmq:heartbeats/notifications", result: "blocked", message });
    return json(res, 400, { supported: false, error: redact(error.message || error), reason: redact(error.message || error) });
  }
}

async function mapChatRoute(req, res) {
  const body = await readJson(req);
  const message = body.body ?? body.message;
  const mapName = body.mapName || body.region || "HaggaBasin";
  const dimension = body.dimension ?? 0;
  try {
    const persona = await ensureCarePackageServerPersona(db);
    const recipients = config.mockMode ? [{ queue: "mock-player_queue" }] : await mapChatRecipients(mapName, dimension);
    if (!recipients.length) throw new Error("No online players are currently subscribed to that map.");
    const results = [];
    for (const recipient of recipients) {
      results.push(config.mockMode
        ? { code: 0, stdout: "mock map chat\n", stderr: "", args: [] }
        : await publishMapChat(config, {
            mapName,
            dimension,
            message,
            senderFuncomId: persona.funcomId,
            senderHexFlsId: persona.hexFlsId,
            recipientQueue: recipient.queue
          }));
    }
    const target = `${mapName}.${dimension}`;
    audit(config, req, "admin.map-chat", { supported: true, target, recipients: recipients.length });
    recordAdminHistory(config, { command: "web-map-chat", target, friendly: "Map Chat", path: "rmq:chat.map/direct", result: "published", message });
    return json(res, 200, { supported: true, ok: true, stdout: results.map((result) => result.stdout).join("\n"), stderr: results.map((result) => result.stderr).filter(Boolean).join("\n"), note: `Map chat message was sent to ${recipients.length} online player${recipients.length === 1 ? "" : "s"}.`, recipients: recipients.length });
  } catch (error) {
    const reason = redact(String(error.message || error).replaceAll("Care Package message whisper", "Map chat"));
    audit(config, req, "admin.map-chat", { supported: false, error: reason });
    recordAdminHistory(config, { command: "web-map-chat", target: `${mapName}.${dimension}`, friendly: "Map Chat", path: "rmq:chat.map", result: "blocked", message });
    return json(res, 400, { supported: false, error: reason, reason });
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
    select distinct concat(ac."user", '_queue') as queue
    from dune.player_state ps
    join dune.accounts ac on ac.${quoteIdentifier(accountIdentityColumn)} = ps.${quoteIdentifier(playerStateIdentityColumn)}
    join dune.world_partition wp on wp.server_id = ps.server_id
    where ${onlineCondition}
      and coalesce(ac."user", '') <> ''
      and wp.map in (${mapPlaceholders})
      and coalesce(wp.dimension_index, 0) = $${maps.length + 1}
    order by queue`, values);
  return (result.rows || []).map((row) => ({ queue: String(row.queue || "").trim() })).filter((row) => row.queue);
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
    audit(config, req, "admin.broadcast-shutdown", { supported: false, error: redact(error.message || error) });
    recordAdminHistory(config, { command: "web-shutdown-broadcast", target: "all", friendly: "Shutdown broadcast publish test", path: "rmq:heartbeats/notifications", result: "blocked", message: `${body.shutdownType || "Restart"} in ${body.delayMinutes || 15} minutes` });
    return json(res, 400, { supported: false, error: redact(error.message || error), reason: redact(error.message || error) });
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
      json(res, 500, { error: redact(error.stdout || error.message || error) });
    }
    return;
  }
  if (parts[4] === "stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    try {
      await readLogs(service, {
        follow: true,
        timeoutMs: 30 * 60 * 1000,
        onLine: (line) => res.write(`data: ${JSON.stringify({ line })}\n\n`)
      });
    } catch (error) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: redact(error.message) })}\n\n`);
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
  let kit;
  try {
    kit = carePackageConfig(config);
  } catch (error) {
    console.error(`Care Package auto-grant config read failed: ${redact(error.message || error)}`);
    return;
  }
  const hasEnabledRule = Array.isArray(kit.autoGrantRules) && kit.autoGrantRules.some((rule) => rule.enabled);
  if (!kit.enabled || !hasEnabledRule) return;
  const intervalMs = Math.max(60, Number(kit.autoGrantIntervalSeconds) || 60) * 1000;
  if (Date.now() - carePackageAutoLastRun < intervalMs) return;
  carePackageAutoRunning = true;
  carePackageAutoLastRun = Date.now();
  try {
    const players = await duneDb.listPlayers(db, {});
    if (players.capabilities?.players === false) return;
    const result = await runCarePackageAutoScan(config, players.rows || [], "auto", { db });
    if (result.granted || result.failed) {
      console.log(`Care Package auto-grant scan: granted=${result.granted || 0} skipped=${result.skipped || 0} failed=${result.failed || 0}`);
    }
    if (result.granted || result.skipped || result.failed) {
      audit(config, null, "care-package.auto-scan", { supported: true, granted: result.granted || 0, skipped: result.skipped || 0, failed: result.failed || 0 });
    }
  } catch (error) {
    console.error(`Care Package auto-grant scan failed: ${redact(error.message || error)}`);
  } finally {
    carePackageAutoRunning = false;
  }
}

async function messageOfTheDayAutoTick() {
  if (messageOfTheDayAutoRunning) return;
  if (Date.now() - messageOfTheDayAutoLastRun < 10000) return;
  messageOfTheDayAutoRunning = true;
  messageOfTheDayAutoLastRun = Date.now();
  try {
    const players = await duneDb.listPlayers(db, { online: true });
    if (players.capabilities?.players === false) return;
    const result = await runMessageOfTheDayScan(config, players.rows || [], { db });
    if (result.sent || result.failed) {
      console.log(`Message of the Day scan: sent=${result.sent || 0} failed=${result.failed || 0}`);
      audit(config, null, "message-of-the-day.auto-scan", { supported: true, sent: result.sent || 0, failed: result.failed || 0 });
    }
  } catch (error) {
    const message = String(error.message || error);
    if (/connect|database|relation|container|rabbitmq|docker|ECONNREFUSED/i.test(message)) return;
    console.error(`Message of the Day scan failed: ${redact(message)}`);
  } finally {
    messageOfTheDayAutoRunning = false;
  }
}

async function playerAnnouncementsAutoTick() {
  if (playerAnnouncementsAutoRunning) return;
  if (Date.now() - playerAnnouncementsAutoLastRun < 10000) return;
  playerAnnouncementsAutoRunning = true;
  playerAnnouncementsAutoLastRun = Date.now();
  try {
    const players = await duneDb.listPlayers(db, { online: true });
    if (players.capabilities?.players === false) return;
    const result = await runPlayerAnnouncementScan(config, players.rows || [], { db });
    if (result.joined || result.left || result.sent || result.failed) {
      console.log(`Player announcement scan: joined=${result.joined || 0} left=${result.left || 0} sent=${result.sent || 0} failed=${result.failed || 0} skipped_no_recipients=${result.skippedNoRecipients || 0}`);
      audit(config, null, "player-announcements.auto-scan", { supported: true, joined: result.joined || 0, left: result.left || 0, sent: result.sent || 0, failed: result.failed || 0, skippedNoRecipients: result.skippedNoRecipients || 0 });
    }
  } catch (error) {
    const message = String(error.message || error);
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
    runDockerLogs("director", { since, tail: 600, timeoutMs: 10000 }).catch((error) => ({ stdout: "", stderr: error.message || String(error) })),
    runDockerLogs("gateway", { since, tail: 600, timeoutMs: 10000 }).catch((error) => ({ stdout: "", stderr: error.message || String(error) }))
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

function loginRateLimitKey(req) {
  return req.socket?.remoteAddress || "unknown";
}
