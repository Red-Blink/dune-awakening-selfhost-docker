import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync, chmodSync, mkdirSync, createReadStream, readFileSync, statfsSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { loadConfig, publicConfig } from "./config.js";
import { createAuth, setSessionCookie, clearSessionCookie, json } from "./auth.js";
import { TaskManager, publicTask } from "./tasks.js";
import { preflight } from "./preflight.js";
import { buildDuneArgs, isDynamicServerService, isReadOnlySql, parseVehicleList, runDockerLogs, runDune, validateServiceName } from "./runner.js";
import { createDb } from "./db.js";
import * as duneDb from "./duneDb.js";
import { audit, recordAdminHistory } from "./audit.js";
import { redact } from "./redact.js";
import { listCatalogItems, resolveCatalogItem } from "./adminCatalog.js";
import { buildBroadcastCommand, buildShutdownBroadcastCommand, publishServerCommand } from "./rmq.js";
import { clearCarePackageHistory, enableCarePackage, grantEligibleCarePackages, grantCarePackage, retryCarePackageGrant, runCarePackageAutoScan, saveCarePackageConfig, carePackageCapabilities, carePackageConfig, carePackageEligiblePlayers, carePackageHistory } from "./carePackage.js";
import { readJsonBody, safeStaticTarget } from "./httpSafety.js";
import { parseBackupAutoStatus, parseBackupListRows, parseMemoryStatusRows } from "./statusParsers.js";

const config = loadConfig();
const auth = createAuth(config);
const tasks = new TaskManager(config);
let db = createDb(config);
let carePackageAutoRunning = false;
let carePackageAutoLastRun = 0;
const journeyTagsData = loadJourneyTagsData();
const SWAP_MEMORY_INTERVAL_MS = 10000;
const SWAP_MEMORY_HIGH_WATERMARK = 90;
const SWAP_MEMORY_DONOR_MAX_PERCENT = 55;
const SWAP_MEMORY_EMERGENCY_DONOR_MAX_PERCENT = 70;
const SWAP_MEMORY_DONOR_POST_TRANSFER_MAX_PERCENT = 80;
const SWAP_MEMORY_CHUNK_BYTES = 1024 ** 3;
const SWAP_MEMORY_MIN_HEADROOM_BYTES = 1024 ** 3;
const swapMemoryState = {
  enabled: false,
  running: false,
  baselineLimits: new Map(),
  lastMessage: "Swap Memory is off.",
  lastAction: "",
  lastError: "",
  updatedAt: null
};

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"]
]);

createServer(async (req, res) => {
  try {
    if (req.url?.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    json(res, error.statusCode || 500, { error: redact(error.message || error) });
  }
}).listen(config.port, config.host, () => {
  console.log(`${config.appName} API listening on http://${config.host}:${config.port}`);
  if (!config.authDisabled) {
    console.log("Initial admin password is stored in runtime/secrets/admin-web-password.txt");
  }
  scheduleBootAutoStart();
});

setInterval(() => {
  void carePackageAutoTick();
}, 10000).unref?.();

setInterval(() => {
  if (!swapMemoryState.enabled) return;
  void runSwapMemoryTick();
}, SWAP_MEMORY_INTERVAL_MS).unref?.();

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
    const body = await readJson(req);
    if (!config.authDisabled && !auth.passwordMatches(body.password)) return json(res, 401, { error: "Incorrect password. Please try again!" });
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
  if (path === "/api/server/performance") return json(res, 200, await performanceSnapshot());
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
  if (path === "/api/server/restart-schedule" && req.method === "POST") return restartScheduleRoute(req, res);
  if (path === "/api/server/restart-schedule") return safeCommandJson(res, "restartScheduleStatus");

  if (path === "/api/logs/services") return json(res, 200, { services: await discoverServices() });
  if (path.startsWith("/api/logs/")) return logsRoute(req, res, path);

  if (path === "/api/updates/check-game" && req.method === "POST") return task(req, res, "updates", "updateCheck", {});
  if (path === "/api/updates/apply-game" && req.method === "POST") return task(req, res, "updates", "updateApply", {});
  if (path === "/api/updates/fix-steamcmd" && req.method === "POST") return task(req, res, "updates", "updateFixSteamcmd", {});
  if (path === "/api/updates/check-stack" && req.method === "POST") return task(req, res, "updates", "selfUpdateCheck", {});
  if (path === "/api/updates/apply-stack" && req.method === "POST") return task(req, res, "updates", "selfUpdateApply", {});
  if (path === "/api/updates/auto-game" && req.method === "POST") return autoGameUpdateRoute(req, res);
  if (path === "/api/updates/restore-previous-stack" && req.method === "POST") return previousStackRestoreRoute(req, res);
  if (path === "/api/updates/auto-game") return safeCommandJson(res, "updateAutoStatus");
  if (path === "/api/updates/previous-stack") return safeCommandJson(res, "selfUpdateList");
  if (path === "/api/updates/repair-runtime" && req.method === "POST") return task(req, res, "updates", "readiness", {});

  if (path === "/api/backups") return backupsListRoute(res);
  if (path === "/api/backups/auto" && req.method === "POST") return autoBackupRoute(req, res);
  if (path === "/api/backups/import-external" && req.method === "POST") return externalBackupImportRoute(req, res);
  if (path === "/api/backups/import-remote" && req.method === "POST") return remoteBackupImportRoute(req, res);
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
  if (path === "/api/admin/broadcast" && req.method === "POST") return broadcastRoute(req, res);
  if (path === "/api/admin/broadcast-shutdown" && req.method === "POST") return shutdownBroadcastRoute(req, res);
  if (path === "/api/admin/whisper" && req.method === "POST") return whisperRoute(req, res);
  if (path.match(/^\/api\/players\/[^/]+\/give-item$/) && req.method === "POST") return playerTask(req, res, path, "adminGiveItem");
  if (path.match(/^\/api\/players\/[^/]+\/give-items$/) && req.method === "POST") return giveItemsRoute(req, res, path);
  if (path.match(/^\/api\/players\/[^/]+\/give-item-id$/) && req.method === "POST") return playerTask(req, res, path, "adminGiveItemId");
  if (path.match(/^\/api\/players\/[^/]+\/add-xp$/) && req.method === "POST") return playerTask(req, res, path, "adminAddXp");
  if (path.match(/^\/api\/players\/[^/]+\/set-skill-points$/) && req.method === "POST") return playerTask(req, res, path, "adminSetSkillPoints");
  if (path.match(/^\/api\/players\/[^/]+\/set-skill-module$/) && req.method === "POST") return playerTask(req, res, path, "adminSetSkillModule");
  if (path.match(/^\/api\/players\/[^/]+\/refill-water$/) && req.method === "POST") return playerTask(req, res, path, "adminRefillWater");
  if (path.match(/^\/api\/players\/[^/]+\/kick$/) && req.method === "POST") return playerTask(req, res, path, "adminKick");
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
  if (path === "/api/maps/memory/swap" && req.method === "POST") return swapMemoryRoute(req, res);
  if (path === "/api/maps/memory/swap") return json(res, 200, publicSwapMemoryState());
  if (path === "/api/maps/memory/live") return liveMapMemoryRoute(res);
  if (path === "/api/maps/memory") return commandJson(res, "memoryStatus");
  if (path === "/api/maps/user-settings/schema") return userSettingsSchemaRoute(res);
  if (path === "/api/maps/user-settings/raw" && req.method === "POST") return userSettingsRawWriteRoute(req, res);
  if (path === "/api/maps/user-settings/raw") return userSettingsRawRoute(res, url);
  if (path === "/api/maps/user-settings/save" && req.method === "POST") return userSettingsSaveRoute(req, res);
  if (path === "/api/maps/user-settings/reset" && req.method === "POST") return userSettingsResetRoute(req, res);
  if (path === "/api/maps/userengine") return safeCommandJson(res, "userSettingsEngineValues");
  if (path === "/api/maps/usergame") return safeCommandJson(res, url.searchParams.get("partitionId") ? "userSettingsPartitionValues" : "userSettingsMapValues", { map: url.searchParams.get("map") || "Survival_1", partitionId: url.searchParams.get("partitionId") || "1" });
  if (path === "/api/maps/user-settings/materialize" && req.method === "POST") return confirmedTask(req, res, "maps", "userSettingsMaterializeCurrent", {}, "REFRESH MAP SETTINGS");
  if (path === "/api/maps/user-settings/restore-defaults" && req.method === "POST") return userSettingsRestoreDefaultsRoute(req, res);
  if (path === "/api/sietches") return commandJson(res, "sietchesList");
  if (path === "/api/sietches/dimensions") return commandJson(res, url.searchParams.get("ids") === "1" ? "sietchesDimensionIds" : "sietchesDimensions", { map: url.searchParams.get("map") || "Survival_1" });
  if (path === "/api/sietches/update" && req.method === "POST") return sietchesUpdateRoute(req, res);
  if (path === "/api/deepdesert") return commandJson(res, "deepdesertStatus");
  if (path === "/api/deepdesert/update" && req.method === "POST") return deepDesertUpdateRoute(req, res);
  if (path === "/api/settings" && req.method === "POST") return writeConfig(req, res);
  if (path === "/api/settings") return json(res, 200, await setupState());

  return json(res, 404, { error: "Not found" });
}

let previousCpuSample = null;

async function performanceSnapshot() {
  const cpu = readCpuUsagePercent();
  const memory = readMemoryUsage();
  const disk = readDiskUsage(config.repoRoot);
  const uptimeSeconds = readHostUptimeSeconds();
  return {
    cpuPercent: cpu,
    memory,
    disk,
    uptimeSeconds,
    uptime: formatUptime(uptimeSeconds),
    sampledAt: new Date().toISOString()
  };
}

async function liveMapMarkersRoute(res, url) {
  const configPayload = duneDb.liveMapConfigPayload(url.searchParams.get("map") || "");
  const [markers, partitions] = await Promise.all([
    duneDb.liveMapMarkers(db, configPayload.map.actorMap || configPayload.map.key),
    duneDb.liveMapPartitions(db).catch(() => ({ rows: [] }))
  ]);
  return json(res, 200, {
    ...markers,
    ...configPayload,
    partitions: partitions.rows || []
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
    return json(res, 400, { error: redact(error.message || error) });
  }
}

function readCpuUsagePercent() {
  const line = readFileSync("/proc/stat", "utf8").split(/\r?\n/).find((row) => row.startsWith("cpu "));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map((value) => Number(value) || 0);
  const idle = (values[3] || 0) + (values[4] || 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const current = { idle, total };
  if (!previousCpuSample) {
    previousCpuSample = current;
    return null;
  }
  const totalDelta = current.total - previousCpuSample.total;
  const idleDelta = current.idle - previousCpuSample.idle;
  previousCpuSample = current;
  if (totalDelta <= 0) return null;
  return roundPercent(((totalDelta - idleDelta) / totalDelta) * 100);
}

function readMemoryUsage() {
  const rows = Object.fromEntries(readFileSync("/proc/meminfo", "utf8").split(/\r?\n/).map((line) => {
    const match = line.match(/^([^:]+):\s+(\d+)/);
    return match ? [match[1], Number(match[2]) * 1024] : null;
  }).filter(Boolean));
  const total = rows.MemTotal || 0;
  const available = rows.MemAvailable || 0;
  const used = Math.max(0, total - available);
  return {
    usedBytes: used,
    totalBytes: total,
    availableBytes: available,
    percent: total ? roundPercent((used / total) * 100) : null
  };
}

function readDiskUsage(path) {
  const stats = statfsSync(path || ".");
  const total = Number(stats.blocks) * Number(stats.bsize);
  const free = Number(stats.bavail) * Number(stats.bsize);
  const used = Math.max(0, total - free);
  return {
    usedBytes: used,
    totalBytes: total,
    freeBytes: free,
    percent: total ? roundPercent((used / total) * 100) : null
  };
}

function readHostUptimeSeconds() {
  const value = readFileSync("/proc/uptime", "utf8").trim().split(/\s+/)[0];
  return Math.max(0, Math.floor(Number(value) || 0));
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m`;
}

function roundPercent(value) {
  return Math.round(value * 10) / 10;
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
  return json(res, 200, { operation: "backupList", stdout: result.stdout, stderr: result.stderr, exitCode: result.code, rows: enrichBackupRows(parseBackupListRows(result.stdout)) });
}

function enrichBackupRows(rows) {
  return rows.map((row) => {
    const metadata = readBackupMetadata(row.name);
    const origin = String(metadata.backup_origin || metadata.origin || "").trim().toLowerCase();
    const battlegroupId = String(metadata.imported_from_battlegroup_id || metadata.battlegroup_id || "").trim();
    const enriched = { ...row, battlegroupId: battlegroupId || "Unknown" };
    if (/^(automatic|scheduled)$/.test(origin)) return { ...enriched, type: "Automatic Backup" };
    if (/^(restore-safety|restore_safety|restore safety)$/.test(origin)) return { ...enriched, type: "Restore Safety Backup" };
    if (/^(pre-update|pre_update|preupdate)$/.test(origin)) return { ...enriched, type: "Pre-update Backup" };
    if (/^(destructive-sql|destructive_sql|destructive sql|sql-safety|sql_safety)$/.test(origin)) return { ...enriched, type: "SQL Safety Backup" };
    if (/^(external|imported)$/.test(origin)) return { ...enriched, type: "Imported Backup", source: "External" };
    return enriched;
  });
}

function readBackupMetadata(name) {
  if (!/^[A-Za-z0-9_.-]+\.(backup|dump|sql)$/i.test(String(name || ""))) return {};
  const metadataPath = resolve(config.repoRoot, "runtime/backups/db", `${name}.yaml`);
  if (!existsSync(metadataPath)) return {};
  try {
    return Object.fromEntries(readFileSync(metadataPath, "utf8").split(/\r?\n/).map((line) => {
      const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
      return match ? [match[1], match[2].trim()] : null;
    }).filter(Boolean));
  } catch {
    return {};
  }
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
  writeFileSync(metadataPath, normalizeImportedBackupMetadata(metadata.content), { mode: 0o600 });
  chmodSync(backupPath, 0o600);
  chmodSync(metadataPath, 0o600);
  audit(config, req, "backup.import-external", { backup: importedName, sourceBackup: backupName, sourceMetadata: metadataName });

  const result = await runDune(config, buildDuneArgs("backupList"));
  const rows = enrichBackupRows(parseBackupListRows(result.stdout));
  return json(res, 200, { ok: true, backup: importedName, rows, row: rows.find((row) => row.name === importedName) || null });
}

function normalizeImportedBackupMetadata(content) {
  const metadata = parseBackupMetadata(content);
  const currentBattlegroupId = readCurrentBattlegroupId();
  const originalBattlegroupId = String(metadata.battlegroup_id || "").trim();
  if (originalBattlegroupId && currentBattlegroupId && originalBattlegroupId !== currentBattlegroupId && !metadata.imported_from_battlegroup_id) {
    metadata.imported_from_battlegroup_id = originalBattlegroupId;
  }
  metadata.backup_origin = "external";
  metadata.imported_at = new Date().toISOString();
  return stringifyBackupMetadata(metadata);
}

function parseBackupMetadata(content) {
  return Object.fromEntries(String(content || "").split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    return match ? [match[1], match[2].trim()] : null;
  }).filter(Boolean));
}

function stringifyBackupMetadata(metadata) {
  return `${Object.entries(metadata).map(([key, value]) => `${key}: ${String(value || "")}`).join("\n")}\n`;
}

function readCurrentBattlegroupId() {
  try {
    const text = readFileSync(resolve(config.generatedDir, "battlegroup.env"), "utf8");
    return text.match(/^BATTLEGROUP_ID=(.*)$/m)?.[1]?.replace(/\\ /g, " ").trim() || "";
  } catch {
    return "";
  }
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
  const archive = gzipSync(createTarArchive([
    { name: backupName, content: readFileSync(backupPath) },
    { name: `${backupName}.yaml`, content: readFileSync(metadataPath) }
  ]));
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

function nextImportedBackupName(backupDir) {
  const now = new Date();
  for (let offset = 0; offset < 86400; offset += 1) {
    const candidateDate = new Date(now.getTime() + offset * 1000);
    const stamp = [
      candidateDate.getFullYear(),
      String(candidateDate.getMonth() + 1).padStart(2, "0"),
      String(candidateDate.getDate()).padStart(2, "0")
    ].join("") + "-" + [
      String(candidateDate.getHours()).padStart(2, "0"),
      String(candidateDate.getMinutes()).padStart(2, "0"),
      String(candidateDate.getSeconds()).padStart(2, "0")
    ].join("");
    const name = `imported-backup-${stamp}.backup`;
    if (!existsSync(resolve(backupDir, name)) && !existsSync(resolve(backupDir, `${name}.yaml`))) return name;
  }
  throw new Error("Could not allocate imported backup filename.");
}

function validBackupDownloadName(name) {
  return /^dune-db-([a-z0-9][a-z0-9_-]*__)?[0-9]{8}-[0-9]{6}\.(dump|sql)$/i.test(name) ||
    /^[a-z0-9][a-z0-9_-]*-[0-9]{8}-[0-9]{6}\.backup$/i.test(name);
}

function createTarArchive(files) {
  const blocks = [];
  for (const file of files) {
    const header = Buffer.alloc(512, 0);
    writeTarString(header, 0, 100, file.name);
    writeTarOctal(header, 100, 8, 0o600);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, file.content.length);
    writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
    header.fill(32, 148, 156);
    header[156] = 48;
    writeTarString(header, 257, 6, "ustar");
    writeTarString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeTarOctal(header, 148, 8, checksum);
    blocks.push(header, file.content);
    const padding = (512 - (file.content.length % 512)) % 512;
    if (padding) blocks.push(Buffer.alloc(padding, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

function writeTarString(buffer, offset, length, value) {
  buffer.write(String(value).slice(0, length - 1), offset, length, "utf8");
}

function writeTarOctal(buffer, offset, length, value) {
  const text = value.toString(8).padStart(length - 1, "0").slice(0, length - 1);
  buffer.write(text, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
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

async function discoverServices() {
  const services = new Set(knownServices());
  if (config.mockMode) return [...services].sort();
  try {
    const result = await runDune(config, buildDuneArgs("services"), { timeoutMs: 8000 });
    for (const name of parseServiceNames(result.stdout)) services.add(name);
  } catch {
    // Fall back to the static allowlist when Docker is not reachable.
  }
  return [...services].sort();
}

function parseServiceNames(text) {
  const names = [];
  const aliases = new Map([
    ["dune-postgres", "postgres"],
    ["dune-rmq-admin", "rmq-admin"],
    ["dune-rmq-game", "rmq-game"],
    ["dune-text-router", "text-router"],
    ["dune-director", "director"],
    ["dune-server-gateway", "gateway"],
    ["dune-server-survival-1", "survival-1"],
    ["dune-server-overmap", "overmap"],
    ["dune-orchestrator", "orchestrator"],
    ["dune-autoscaler", "autoscaler"]
  ]);
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^names\s+/i.test(trimmed)) continue;
    const name = trimmed.split(/\s+/)[0];
    if (aliases.has(name)) {
      names.push(aliases.get(name));
    } else if (/^dune-server-[a-z0-9-]+$/i.test(name)) {
      names.push(name);
    }
  }
  return names;
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
  const envPath = resolve(config.repoRoot, ".env");
  const current = existsSync(envPath) ? readFileSync(envPath, "utf8").split(/\r?\n/) : [];
  const line = `${key}=${quoteEnv(String(value))}`;
  let found = false;
  const next = current.map((existing) => {
    if (existing.match(new RegExp(`^${key}=`))) {
      found = true;
      return line;
    }
    return existing;
  });
  if (!found) next.push(line);
  writeFileSync(envPath, `${next.filter((entry, index) => entry !== "" || index < next.length - 1).join("\n")}\n`, { mode: 0o644 });
  try { chmodSync(envPath, 0o644); } catch {}
}

async function dbJson(res, fn) {
  try {
    return json(res, 200, await fn());
  } catch (error) {
    const status = error.unsupported ? 501 : 500;
    return json(res, status, { supported: false, error: redact(error.message || error), reason: redact(error.message || error), details: error.details || undefined });
  }
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

async function swapMemoryRoute(req, res) {
  const body = await readJson(req);
  const enabled = Boolean(body.enabled);
  if (enabled === swapMemoryState.enabled) return json(res, 200, publicSwapMemoryState());

  swapMemoryState.enabled = enabled;
  swapMemoryState.lastError = "";
  swapMemoryState.updatedAt = new Date().toISOString();

  if (enabled) {
    swapMemoryState.baselineLimits.clear();
    swapMemoryState.lastMessage = "Swap Memory is monitoring running maps";
    await captureSwapMemoryBaseline();
    void runSwapMemoryTick();
  } else {
    swapMemoryState.lastMessage = "Restoring configured memory limits.";
    await restoreSwapMemoryBaseline();
    swapMemoryState.baselineLimits.clear();
    swapMemoryState.lastMessage = "Swap Memory is off. Configured memory limits are active.";
  }

  audit(config, req, "maps.memory.swap", { enabled });
  return json(res, 200, publicSwapMemoryState());
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
  const restart = modeChanged && Boolean(body.running);
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
    const result = await runDune(config, buildDuneArgs(operation, { map, partitionId }), { timeoutMs: 8000 });
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
    const rows = await readLiveMapMemoryRows();
    return json(res, 200, { rows, sampledAt: new Date().toISOString() });
  } catch (error) {
    return json(res, 200, { rows: [], sampledAt: new Date().toISOString(), error: redact(error.message || error) });
  }
}

async function readLiveMapMemoryRows() {
  const stdout = await runProcessText("docker", ["stats", "--no-stream", "--format", "{{json .}}"], 10000);
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map(parseDockerStatsRow).filter(Boolean);
}

async function captureSwapMemoryBaseline() {
  const rows = await readLiveMapMemoryRows().catch(() => []);
  for (const row of rows) {
    if (row.limitBytes > 0 && !swapMemoryState.baselineLimits.has(row.container)) {
      swapMemoryState.baselineLimits.set(row.container, row.limitBytes);
    }
  }
}

async function restoreSwapMemoryBaseline() {
  const configuredLimits = await configuredMemoryLimitsByContainer().catch(() => new Map());
  const restoreTargets = new Map(swapMemoryState.baselineLimits);
  for (const [container, limitBytes] of configuredLimits.entries()) {
    restoreTargets.set(container, limitBytes);
  }
  for (const [container, limitBytes] of restoreTargets.entries()) {
    if (limitBytes > 0) {
      await dockerUpdateMemoryLimit(container, limitBytes).catch((error) => {
        swapMemoryState.lastError = redact(error.message || error);
      });
    }
  }
  swapMemoryState.updatedAt = new Date().toISOString();
}

async function runSwapMemoryTick() {
  if (!swapMemoryState.enabled || swapMemoryState.running) return;
  swapMemoryState.running = true;
  try {
    const rows = (await readLiveMapMemoryRows()).filter((row) => row.usedBytes > 0 && row.limitBytes > 0);
    for (const row of rows) {
      if (!swapMemoryState.baselineLimits.has(row.container)) swapMemoryState.baselineLimits.set(row.container, row.limitBytes);
    }
    const target = rows.filter((row) => row.percent >= SWAP_MEMORY_HIGH_WATERMARK).sort((a, b) => b.percent - a.percent)[0];
    if (!target) {
      swapMemoryState.lastMessage = "Swap Memory is monitoring running maps";
      swapMemoryState.lastAction = "";
      swapMemoryState.lastError = "";
      swapMemoryState.updatedAt = new Date().toISOString();
      return;
    }

    const donor = selectSwapMemoryDonor(rows, target);

    if (!donor) {
      swapMemoryState.lastMessage = `${target.map} is above ${SWAP_MEMORY_HIGH_WATERMARK}% memory, but no running map has enough spare memory to donate safely`;
      swapMemoryState.lastAction = "";
      swapMemoryState.lastError = "";
      swapMemoryState.updatedAt = new Date().toISOString();
      return;
    }

    const donorLimit = donor.limitBytes - SWAP_MEMORY_CHUNK_BYTES;
    const targetLimit = target.limitBytes + SWAP_MEMORY_CHUNK_BYTES;
    await dockerUpdateMemoryLimit(target.container, targetLimit);
    await dockerUpdateMemoryLimit(donor.container, donorLimit);
    swapMemoryState.lastMessage = `Moved 1 GB from ${donor.map} to ${target.map}`;
    swapMemoryState.lastAction = `${donor.container} -> ${target.container}`;
    swapMemoryState.lastError = "";
    swapMemoryState.updatedAt = new Date().toISOString();
  } catch (error) {
    swapMemoryState.lastError = redact(error.message || error);
    swapMemoryState.lastMessage = "Swap Memory could not rebalance memory.";
    swapMemoryState.updatedAt = new Date().toISOString();
  } finally {
    swapMemoryState.running = false;
  }
}

async function configuredMemoryLimitsByContainer() {
  const [rows, result] = await Promise.all([
    readLiveMapMemoryRows(),
    runDune(config, buildDuneArgs("memoryStatus"), { timeoutMs: 10000 })
  ]);
  const configuredRows = parseMemoryStatusRows(result.stdout || "");
  const byMap = new Map(configuredRows.map((row) => [String(row.map), parseMemorySettingBytes(row.memory)]).filter(([, bytes]) => bytes > 0));
  const limits = new Map();
  for (const row of rows) {
    const key = memoryTargetForContainer(row.container);
    const configured = byMap.get(key);
    if (configured > 0) limits.set(row.container, configured);
  }
  return limits;
}

function memoryTargetForContainer(container) {
  if (container === "dune-server-survival-1") return "Survival_1";
  const survivalPartition = String(container || "").match(/^dune-server-survival-1-(\d+)$/);
  if (survivalPartition) return `Survival_1:${survivalPartition[1]}`;
  if (container === "dune-server-overmap") return "Overmap";
  return mapFromContainerName(container);
}

function parseMemorySettingBytes(value) {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)\s*([KMGT]i?B|[KMGT]B?|[kmgt]i?b|[kmgt]b?)/);
  return match ? parseDockerBytes(`${match[1]}${match[2]}`) : 0;
}

function selectSwapMemoryDonor(rows, target) {
  const candidates = rows
    .filter((row) => row.container !== target.container)
    .filter((row) => row.limitBytes - SWAP_MEMORY_CHUNK_BYTES >= minimumSwapLimit(row))
    .filter((row) => percentAfterMemoryDonation(row) <= SWAP_MEMORY_DONOR_POST_TRANSFER_MAX_PERCENT);
  const normal = candidates
    .filter((row) => row.percent <= SWAP_MEMORY_DONOR_MAX_PERCENT)
    .sort((a, b) => a.percent - b.percent || b.limitBytes - a.limitBytes)[0];
  if (normal) return normal;
  return candidates
    .filter((row) => row.percent <= SWAP_MEMORY_EMERGENCY_DONOR_MAX_PERCENT)
    .sort((a, b) => a.percent - b.percent || b.limitBytes - a.limitBytes)[0] || null;
}

function percentAfterMemoryDonation(row) {
  const nextLimit = row.limitBytes - SWAP_MEMORY_CHUNK_BYTES;
  return nextLimit > 0 ? (row.usedBytes / nextLimit) * 100 : 100;
}

function minimumSwapLimit(row) {
  return Math.max(row.usedBytes + SWAP_MEMORY_MIN_HEADROOM_BYTES, Math.ceil(row.usedBytes * 1.25), SWAP_MEMORY_CHUNK_BYTES);
}

async function dockerUpdateMemoryLimit(container, limitBytes) {
  await runProcessText("docker", ["update", "--memory", dockerMemoryArg(limitBytes), "--memory-reservation", dockerMemoryArg(limitBytes), container], 15000);
}

function dockerMemoryArg(bytes) {
  return `${Math.max(256, Math.round(bytes / (1024 ** 2)))}m`;
}

function publicSwapMemoryState() {
  return {
    enabled: swapMemoryState.enabled,
    running: swapMemoryState.running,
    lastMessage: swapMemoryState.lastMessage,
    lastAction: swapMemoryState.lastAction,
    lastError: swapMemoryState.lastError,
    updatedAt: swapMemoryState.updatedAt
  };
}

function parseDockerStatsRow(line) {
  try {
    const row = JSON.parse(line);
    const name = String(row.Name || row.Container || "");
    if (!name.startsWith("dune-server-")) return null;
    const memory = parseMemoryUsage(row.MemUsage || row.MemUsageBytes || "");
    return {
      container: name,
      map: mapFromContainerName(name),
      usedBytes: memory.usedBytes,
      limitBytes: memory.limitBytes,
      percent: Number.parseFloat(String(row.MemPerc || "").replace("%", "")) || memory.percent || 0,
      raw: String(row.MemUsage || "")
    };
  } catch {
    return null;
  }
}

function parseMemoryUsage(value) {
  const [usedRaw, limitRaw] = String(value || "").split("/").map((part) => part.trim());
  const usedBytes = parseDockerBytes(usedRaw);
  const limitBytes = parseDockerBytes(limitRaw);
  return {
    usedBytes,
    limitBytes,
    percent: limitBytes > 0 ? roundPercent((usedBytes / limitBytes) * 100) : 0
  };
}

function parseDockerBytes(value) {
  const match = String(value || "").match(/^([\d.]+)\s*([KMGTPE]?i?B)?$/i);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1]) || 0;
  const unit = String(match[2] || "B").toLowerCase();
  const multipliers = { b: 1, kb: 1000, kib: 1024, mb: 1000 ** 2, mib: 1024 ** 2, gb: 1000 ** 3, gib: 1024 ** 3, tb: 1000 ** 4, tib: 1024 ** 4 };
  return Math.round(amount * (multipliers[unit] || 1));
}

function mapFromContainerName(name) {
  if (name === "dune-server-survival-1") return "Survival_1";
  if (/^dune-server-survival-1-\d+$/.test(name)) return `Survival_1 partition ${name.split("-").pop()}`;
  if (name === "dune-server-overmap") return "Overmap";
  return name.replace(/^dune-server-/, "");
}

function runProcessText(command, args, timeoutMs = 10000) {
  return new Promise((resolveText, rejectText) => {
    const child = spawn(command, args, { cwd: config.repoRoot, shell: false });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", rejectText);
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveText(stdout);
      else rejectText(new Error(stderr.trim() || `${command} ${args.join(" ")} failed with exit ${code}`));
    });
  });
}

async function autoBackupRoute(req, res) {
  const body = await readJson(req);
  const operation = body.enabled ? "backupAutoEnable" : "backupAutoDisable";
  return task(req, res, "backup", operation, body);
}

async function remoteBackupImportRoute(req, res) {
  const body = await readJson(req);
  const reason = "Remote SSH backup import remains disabled in the web UI: the Dune Manager flow is interactive and asks for SSH host/user/port/path before running scp. A safe web wrapper needs key-only credential selection, remote preview, no secret logging, and restore preflight coverage.";
  audit(config, req, "backup.import-remote", {
    supported: false,
    reason,
    host: body.host ? "<redacted-host>" : "",
    user: body.user ? "<redacted-user>" : "",
    path: body.path ? "<redacted-path>" : ""
  });
  return json(res, 501, { supported: false, reason, error: reason });
}

async function restartScheduleRoute(req, res) {
  const body = await readJson(req);
  const operation = body.enabled ? "restartScheduleEnable" : "restartScheduleDisable";
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

async function previousStackRestoreRoute(req, res) {
  const body = await readJson(req);
  if (body.confirmation !== "RESTORE PREVIOUS STACK") {
    return json(res, 400, { error: "Confirmation phrase required: RESTORE PREVIOUS STACK" });
  }
  return task(req, res, "updates", "selfUpdatePrevious", body);
}

async function userSettingsRestoreDefaultsRoute(req, res) {
  const body = await readJson(req);
  const reason = "Restore map defaults remains disabled in the web UI: usersettings.py reset-all can remove overrides, but it does not create a backup or preview which UserEngine/UserGame files will change. Web exposure needs backup-before-write and restart impact handling first.";
  audit(config, req, "maps.user-settings.restore-defaults", { supported: false, reason, requested: body.confirmation === "RESTORE MAP DEFAULTS" });
  return json(res, 501, { supported: false, reason, error: reason });
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
    return json(res, 400, { error: redact(error.message || error) });
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
    return json(res, 500, { supported: false, error: redact(error.message || error), reason: redact(error.message || error) });
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
    return json(res, 400, { error: redact(error.message || error), reason: redact(error.message || error) });
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
    return json(res, 400, { error: redact(error.message || error), reason: redact(error.message || error) });
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
    return json(res, 400, { error: redact(error.message || error) });
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
    actorId: player.actor_id || player.player_pawn_id || ""
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
  for (const [index, item] of body.items.entries()) {
    try {
      const resolved = item.itemId ? { itemId: item.itemId } : resolveCatalogItem(config.repoRoot, item);
      const operation = resolved.itemId ? "adminGiveItemId" : "adminGiveItem";
      const payload = {
        playerId,
        itemId: resolved.itemId,
        itemName: item.itemName,
        quantity: item.quantity ?? 1,
        quality: item.quality ?? item.grade ?? item.durability ?? 1,
        durability: 1
      };
      const command = buildDuneArgs(operation, payload);
      if (config.mockMode) {
        results.push({ index, ok: true, operation, command });
      } else {
        const result = await runDune(config, command);
        results.push({ index, ok: true, operation, item: payload, stdout: result.stdout, stderr: result.stderr, exitCode: result.code });
      }
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

async function whisperRoute(req, res) {
  const body = await readJson(req);
  const reason = "Whisper remains blocked: the web admin publishes courier chat to exchange chat.whispers with routing key equal to the recipient Funcom ID, AMQP type text_chat, and sender user_id set to a seeded GM hex FLS ID. RedBlink does not currently seed or expose the required GM account/persona rows, sender Funcom ID, sender hex FLS ID, and verified recipient Funcom ID mapping.";
  audit(config, req, "admin.whisper", { supported: false, reason, playerId: body.playerId });
  recordAdminHistory(config, { command: "web-whisper", target: body.playerId || "-", friendly: "Whisper blocked", path: "rmq:chat.whispers", result: "blocked", message: body.message });
  return json(res, 501, { supported: false, reason, error: reason });
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

async function writeConfig(req, res) {
  const body = await readJson(req);
  const allowed = ["SERVER_IP", "SERVER_IP_MODE", "SERVER_TITLE", "SERVER_REGION", "SERVER_PROVIDER", "STEAM_APP_ID", "BATTLEGROUP_ID"];
  const lines = [];
  for (const key of allowed) {
    if (body[key] !== undefined) lines.push(`${key}=${quoteEnv(String(body[key]))}`);
  }
  writeFileSync(resolve(config.repoRoot, ".env"), `${lines.join("\n")}\n`, { mode: 0o644 });
  audit(config, req, "setup.write-config", { keys: Object.keys(body).filter((key) => allowed.includes(key)) });
  return json(res, 200, { ok: true });
}

async function saveToken(req, res) {
  const body = await readJson(req);
  saveFuncomTokenValue(body.token);
  audit(config, req, "setup.save-token", { token: "<redacted>" });
  return json(res, 200, { ok: true });
}

async function saveServerFuncomToken(req, res) {
  const body = await readJson(req);
  saveFuncomTokenValue(body.token);
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

function validDockerSince(value) {
  const text = String(value || "").trim();
  if (/^\d+[smhdw]$/i.test(text)) return text;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/i.test(text)) return text;
  return "";
}

function funcomAuthMismatchDetected(text) {
  return isFuncomAuthMismatchText(text);
}

function matchingFuncomAuthLines(text) {
  return String(text || "").split(/\r?\n/)
    .filter((line) => isFuncomAuthMismatchText(line))
    .slice(-20)
    .join("\n");
}

function isFuncomAuthMismatchText(text) {
  const value = String(text || "");
  if (!value) return false;
  if (/Invalid Authorization to manage SelfHosted Battlegroup/i.test(value)) return true;
  if (/ACCESS_DENIED|AccessDenied|access denied|invalid authorization|Unauthorized/i.test(value)) {
    return /Battlegroup|SelfHosted|Funcom|FuncomLiveServices/i.test(value);
  }
  if (/(?:HTTP|status|statusCode|response|code)[^,\n]*(?:401|403)\b/i.test(value)) {
    return /Battlegroup|SelfHosted|Funcom|FuncomLiveServices/i.test(value);
  }
  return false;
}

function saveFuncomTokenValue(token) {
  if (!token || String(token).length < 20) {
    const error = new Error("Token looks too short");
    error.statusCode = 400;
    throw error;
  }
  mkdirSync(config.secretsDir, { recursive: true });
  const path = resolve(config.secretsDir, "funcom-token.txt");
  writeFileSync(path, `${String(token).trim()}\n`, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
}

async function readJson(req) {
  return readJsonBody(req, config.maxJsonBytes);
}

async function readMultipartForm(req, maxBytes) {
  const contentType = String(req.headers["content-type"] || "");
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) {
    const error = new Error("Expected multipart/form-data upload.");
    error.statusCode = 400;
    throw error;
  }
  const body = await readRawBody(req, maxBytes);
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const files = [];
  let cursor = body.indexOf(boundaryBuffer);
  while (cursor >= 0) {
    cursor += boundaryBuffer.length;
    if (body[cursor] === 45 && body[cursor + 1] === 45) break;
    if (body[cursor] === 13 && body[cursor + 1] === 10) cursor += 2;
    const next = body.indexOf(boundaryBuffer, cursor);
    if (next < 0) break;
    let part = body.slice(cursor, next);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) part = part.slice(0, -2);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd > 0) {
      const headers = part.slice(0, headerEnd).toString("utf8");
      const disposition = headers.split(/\r?\n/).find((line) => /^content-disposition:/i.test(line)) || "";
      const fieldName = disposition.match(/\bname="([^"]*)"/i)?.[1] || "";
      const fileName = disposition.match(/\bfilename="([^"]*)"/i)?.[1] || "";
      if (fieldName && fileName) files.push({ fieldName, fileName, content: part.slice(headerEnd + 4) });
    }
    cursor = next;
  }
  return { files };
}

async function readRawBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const error = new Error(`Upload exceeds ${maxBytes} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function quoteEnv(value) {
  if (/^[A-Za-z0-9_.:-]+$/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function knownServices() {
  return ["postgres", "rmq-admin", "rmq-game", "text-router", "director", "gateway", "survival-1", "overmap", "orchestrator", "autoscaler"];
}

function mockCommand(operation) {
  return { operation, stdout: `Mock ${operation} output\n`, stderr: "", exitCode: 0 };
}

function serveStatic(req, res) {
  let path = new URL(req.url || "/", "http://localhost").pathname;
  const target = safeStaticTarget(config.staticDir, path);
  if (!existsSync(target)) {
    json(res, 200, { app: config.appName, message: "Frontend is not built yet. Run npm install && npm run build in web/." });
    return;
  }
  res.writeHead(200, { "content-type": mime.get(extname(target)) || "application/octet-stream" });
  createReadStream(target).pipe(res);
}
