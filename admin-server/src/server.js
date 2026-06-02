import { createServer } from "node:http";
import { existsSync, writeFileSync, chmodSync, mkdirSync, createReadStream } from "node:fs";
import { extname, join, resolve } from "node:path";
import { loadConfig, publicConfig } from "./config.js";
import { createAuth, setSessionCookie, clearSessionCookie, json } from "./auth.js";
import { TaskManager, publicTask } from "./tasks.js";
import { preflight } from "./preflight.js";
import { buildDuneArgs, isDynamicServerService, isReadOnlySql, runDockerLogs, runDune, validateServiceName } from "./runner.js";
import { createDb } from "./db.js";
import * as duneDb from "./duneDb.js";
import { audit } from "./audit.js";
import { redact } from "./redact.js";
import { listCatalogItems, resolveCatalogItem } from "./adminCatalog.js";
import { buildBroadcastCommand, buildShutdownBroadcastCommand, publishServerCommand } from "./rmq.js";
import { enableStarterKit, grantStarterKit, retryStarterKitGrant, saveStarterKitConfig, starterKitCapabilities, starterKitConfig, starterKitHistory } from "./starterKit.js";
import { readJsonBody, safeStaticTarget } from "./httpSafety.js";

const config = loadConfig();
const auth = createAuth(config);
const tasks = new TaskManager(config);
const db = createDb(config);

const mime = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"]
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
});

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
    if (!config.authDisabled && !auth.passwordMatches(body.password)) return json(res, 401, { error: "Invalid password" });
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
  if (path === "/api/server/readiness") return commandJson(res, "readiness");
  if (path === "/api/server/ports") return commandJson(res, "ports");
  if (path === "/api/server/services") return commandJson(res, "services");
  if (path === "/api/server/doctor") return commandJson(res, "doctor");
  if (path === "/api/server/start" && req.method === "POST") return task(req, res, "server", "start", {});
  if (path === "/api/server/stop" && req.method === "POST") return task(req, res, "server", "stop", {});
  if (path === "/api/server/restart" && req.method === "POST") return task(req, res, "server", "restartAll", {});
  if (path === "/api/server/restart-service" && req.method === "POST") {
    const body = await readJson(req);
    return task(req, res, "server", "restartService", { service: body.service });
  }

  if (path === "/api/logs/services") return json(res, 200, { services: await discoverServices() });
  if (path.startsWith("/api/logs/")) return logsRoute(req, res, path);

  if (path === "/api/updates/check-game" && req.method === "POST") return task(req, res, "updates", "updateCheck", {});
  if (path === "/api/updates/apply-game" && req.method === "POST") return task(req, res, "updates", "updateApply", {});
  if (path === "/api/updates/check-stack" && req.method === "POST") return task(req, res, "updates", "selfUpdateCheck", {});
  if (path === "/api/updates/apply-stack" && req.method === "POST") return task(req, res, "updates", "selfUpdateApply", {});
  if (path === "/api/updates/repair-runtime" && req.method === "POST") return task(req, res, "updates", "readiness", {});

  if (path === "/api/backups") return commandJson(res, "backupList");
  if (path === "/api/backups/create" && req.method === "POST") return task(req, res, "backup", "backupCreate", {});
  if (path === "/api/backups/restore" && req.method === "POST") {
    const body = await readJson(req);
    return task(req, res, "backup", "backupRestore", { backup: body.backup });
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
  if (path === "/api/database/search") return dbJson(res, () => duneDb.searchDatabase(db, url.searchParams.get("q") || url.searchParams.get("term") || ""));
  if (path.startsWith("/api/database/table/")) return dbJson(res, () => {
    const [schema, table] = decodeURIComponent(path.split("/").pop()).split(".");
    return duneDb.tablePreview(db, schema, table, url.searchParams.get("limit") || 50, url.searchParams.get("offset") || 0);
  });
  if (path === "/api/database/query" && req.method === "POST") return databaseQuery(req, res);
  if (path === "/api/database/export" && req.method === "POST") return databaseExport(req, res);

  if (path === "/api/players") return dbJson(res, () => duneDb.listPlayers(db, { q: url.searchParams.get("q") || "" }));
  if (path === "/api/players/online") return dbJson(res, () => duneDb.listPlayers(db, { online: true }));
  if (path === "/api/players/search") return dbJson(res, () => duneDb.listPlayers(db, { q: url.searchParams.get("q") || "" }));
  if (path === "/api/admin/items/search") return commandJson(res, "adminItemSearch", { q: url.searchParams.get("q") || "" });
  if (path === "/api/admin/items") return commandJson(res, url.searchParams.get("category") ? "adminItemListCategory" : "adminItemList", { category: url.searchParams.get("category") || "" });
  if (path === "/api/admin/vehicles") return commandJson(res, url.searchParams.get("q") ? "adminVehicleSearch" : "adminVehicleList", { q: url.searchParams.get("q") || "" });
  if (path === "/api/admin/skill-modules") return commandJson(res, url.searchParams.get("q") ? "adminSkillModulesSearch" : "adminSkillModules", { q: url.searchParams.get("q") || "" });
  if (path === "/api/admin/history") return commandJson(res, "adminHistory");
  if (path === "/api/admin/broadcast" && req.method === "POST") return broadcastRoute(req, res);
  if (path === "/api/admin/broadcast-shutdown" && req.method === "POST") return shutdownBroadcastRoute(req, res);
  if (path === "/api/admin/whisper" && req.method === "POST") return unsupportedMutation(req, res, "admin.whisper", "Whisper remains blocked: arrakis-admin publishes courier chat to exchange chat.whispers with routing key equal to the recipient Funcom ID, AMQP type text_chat, and sender user_id set to a seeded GM hex FLS ID. RedBlink does not currently seed or expose the required GM account/persona rows, sender Funcom ID, sender hex FLS ID, and verified recipient Funcom ID mapping.");
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
  if (path.match(/^\/api\/players\/[^/]+\/repair-gear$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.repair-gear", "REPAIR GEAR", (playerId) => duneDb.repairGear(db, playerId));
  if (path.match(/^\/api\/players\/[^/]+\/refuel-vehicle$/) && req.method === "POST") return playerDbMutation(req, res, path, "players.refuel-vehicle", "REFUEL VEHICLE", (playerId, body) => duneDb.refuelVehicle(db, playerId, body));
  if (path.match(/^\/api\/players\/[^/]+\/inventory\/[^/]+$/) && req.method === "DELETE") return inventoryDeleteRoute(req, res, path);
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
  if (path === "/api/bases") return dbJson(res, () => duneDb.listBases(db));
  if (path.match(/^\/api\/bases\/[^/]+$/) && req.method === "GET") return dbJson(res, async () => ({ base: (await duneDb.listBases(db)).rows.find((row) => String(row.id) === decodeURIComponent(path.split("/")[3])) || null }));
  if (path.match(/^\/api\/bases\/[^/]+\/export$/)) {
    const id = decodeURIComponent(path.split("/")[3]);
    audit(config, req, "bases.export", { id, format: "blueprint" });
    return exportJson(res, `base-${id}.blueprint.json`, () => duneDb.exportBaseAsBlueprint(db, id));
  }
  if (path.match(/^\/api\/bases\/[^/]+\/export-blueprint$/) && req.method === "POST") {
    const id = decodeURIComponent(path.split("/")[3]);
    audit(config, req, "bases.export-blueprint", { id });
    return dbJson(res, () => duneDb.exportBaseAsBlueprint(db, id));
  }
  if (path === "/api/bases/import" && req.method === "POST") return blockedImportRoute(req, res, "bases.import", "IMPORT BASE", "Base import remains blocked: safe ownership, position, entity ID remapping, and live-service collision rules are not verified for RedBlink databases.");
  if (path.match(/^\/api\/bases\/[^/]+$/) && req.method === "DELETE") return blockedImportRoute(req, res, "bases.delete", "DELETE BASE", "Base delete remains blocked: deleting a full base requires verified building/placeable/inventory/object graph deletion rules.");
  if (path === "/api/blueprints") return dbJson(res, () => duneDb.listBlueprints(db));
  if (path.match(/^\/api\/blueprints\/[^/]+$/) && req.method === "GET") return dbJson(res, async () => ({ blueprint: (await duneDb.listBlueprints(db)).rows.find((row) => String(row.id) === decodeURIComponent(path.split("/")[3])) || null }));
  if (path.match(/^\/api\/blueprints\/[^/]+\/export$/)) {
    const id = decodeURIComponent(path.split("/")[3]);
    audit(config, req, "blueprints.export", { id });
    return exportJson(res, `blueprint-${id}.json`, () => duneDb.exportBlueprintFull(db, id));
  }
  if (path === "/api/blueprints/import" && req.method === "POST") return blockedImportRoute(req, res, "blueprints.import", "IMPORT BLUEPRINT", "Blueprint import remains blocked: arrakis-admin import requires verified offline-player backpack ownership, blueprint item stat shape, and ID remapping rules that RedBlink does not expose through a safe CLI path.");
  if (path.match(/^\/api\/blueprints\/[^/]+$/) && req.method === "DELETE") return blockedImportRoute(req, res, "blueprints.delete", "DELETE BLUEPRINT", "Blueprint delete remains blocked: safe item/blueprint graph deletion rules are not verified.");
  if (path.match(/^\/api\/blueprints\/[^/]+\/clone$/) && req.method === "POST") return blockedImportRoute(req, res, "blueprints.clone", "CLONE BLUEPRINT", "Blueprint clone remains blocked: clone requires verified blueprint item creation, stat wiring, and inventory ownership rules.");

  if (path === "/api/market/capabilities") return dbJson(res, () => duneDb.marketCapabilities(db));
  if (path === "/api/market/items") return dbJson(res, () => duneDb.marketItems(db, {
    q: url.searchParams.get("q") || "",
    limit: url.searchParams.get("limit") || 500,
    offset: url.searchParams.get("offset") || 0
  }));
  if (path === "/api/market/search") return dbJson(res, () => duneDb.marketItems(db, {
    q: url.searchParams.get("q") || "",
    limit: url.searchParams.get("limit") || 100,
    offset: url.searchParams.get("offset") || 0
  }));
  if (path === "/api/market/listings") return dbJson(res, () => duneDb.marketListings(db, { templateId: url.searchParams.get("template_id") || "", owner: url.searchParams.get("owner") || "", limit: url.searchParams.get("limit") || 500, offset: url.searchParams.get("offset") || 0 }));
  if (path === "/api/market/sales") return dbJson(res, () => duneDb.marketSales(db, { limit: url.searchParams.get("limit") || 200 }));
  if (path === "/api/market/stats") return dbJson(res, () => duneDb.marketStats(db));
  if (path === "/api/market/categories") return json(res, 200, { categories: [...new Set(listCatalogItems(config.repoRoot, { limit: 2000 }).map((item) => item.category).filter(Boolean))].sort() });
  if (path === "/api/market/catalog") return json(res, 200, { rows: listCatalogItems(config.repoRoot, { q: url.searchParams.get("q") || "", limit: url.searchParams.get("limit") || 500 }) });
  if (path === "/api/market/automation/status") return json(res, 200, marketAutomationUnsupported());
  if (path === "/api/market/automation/history") return json(res, 200, { rows: [], ...marketAutomationUnsupported() });
  if (path.startsWith("/api/market/automation/") && req.method === "POST") return unsupportedMutation(req, res, `market.${path.split("/").pop()}`, marketAutomationUnsupported().reason);

  if (path === "/api/starter-kit/capabilities") return json(res, 200, starterKitCapabilities());
  if (path === "/api/starter-kit/config" && req.method === "POST") return starterKitConfigRoute(req, res);
  if (path === "/api/starter-kit/config") return json(res, 200, starterKitConfig(config));
  if (path === "/api/starter-kit/grants" || path === "/api/starter-kit/history") return json(res, 200, starterKitHistory(config, url.searchParams.get("limit") || 100));
  if (path === "/api/starter-kit/run" && req.method === "POST") return unsupportedMutation(req, res, "starter-kit.run", starterKitCapabilities().reason);
  if (path.match(/^\/api\/starter-kit\/grant\/[^/]+$/) && req.method === "POST") return starterKitGrantRoute(req, res, path);
  if (path.match(/^\/api\/starter-kit\/retry\/[^/]+$/) && req.method === "POST") return starterKitRetryRoute(req, res, path);
  if (path === "/api/starter-kit/enable" && req.method === "POST") return starterKitEnableRoute(req, res, true);
  if (path === "/api/starter-kit/disable" && req.method === "POST") return starterKitEnableRoute(req, res, false);

  if (path === "/api/map/status") return mapStatusRoute(res);
  if (path === "/api/map/capabilities") return dbJson(res, () => duneDb.liveMapCapabilities(db));
  if (path === "/api/map/markers") return dbJson(res, () => duneDb.liveMapMarkers(db, url.searchParams.get("map") || ""));
  if (path === "/api/map/players") return dbJson(res, () => duneDb.liveMapPlayers(db, url.searchParams.get("map") || ""));
  if (path === "/api/map/bases") return dbJson(res, () => duneDb.liveMapBases(db, url.searchParams.get("map") || ""));
  if (path === "/api/map/storage") return dbJson(res, () => duneDb.liveMapStorage(db, url.searchParams.get("map") || ""));
  if (path === "/api/map/services") return dbJson(res, () => duneDb.liveMapServices(db, url.searchParams.get("map") || ""));
  if (path === "/api/map/overlays") return dbJson(res, () => duneDb.liveMapMarkers(db, url.searchParams.get("map") || ""));
  if (path === "/api/maps/mode" && req.method === "POST") return confirmedTask(req, res, "maps", "mapsSetMode", {}, "SET MAP MODE");
  if (path === "/api/maps") return commandJson(res, "mapsList");
  if (path === "/api/maps/mode") return commandJson(res, "mapsMode", { map: url.searchParams.get("map") || "" });
  if (path === "/api/maps/reconcile" && req.method === "POST") return confirmedTask(req, res, "maps", "mapsReconcile", {}, "RECONCILE MAPS");
  if (path === "/api/maps/spawn" && req.method === "POST") return confirmedTask(req, res, "maps", "mapsSpawn", {}, "SPAWN MAP");
  if (path === "/api/maps/despawn" && req.method === "POST") return confirmedTask(req, res, "maps", "mapsDespawn", {}, "DESPAWN MAP");
  if (path === "/api/maps/autoscaler" && req.method === "POST") return confirmedTask(req, res, "maps", "autoscalerAction", {}, "AUTOSCALER CHANGE");
  if (path === "/api/maps/autoscaler") return commandJson(res, "autoscalerStatus");
  if (path === "/api/maps/memory" && req.method === "POST") return memoryRoute(req, res);
  if (path === "/api/maps/memory") return commandJson(res, "memoryStatus");
  if (path === "/api/sietches") return commandJson(res, "sietchesList");
  if (path === "/api/sietches/update" && req.method === "POST") return sietchesUpdateRoute(req, res);
  if (path === "/api/deepdesert") return commandJson(res, "deepdesertStatus");
  if (path === "/api/deepdesert/update" && req.method === "POST") return deepDesertUpdateRoute(req, res);
  if (path === "/api/settings" && req.method === "POST") return writeConfig(req, res);
  if (path === "/api/settings") return json(res, 200, await setupState());

  return json(res, 404, { error: "Not found" });
}

async function commandJson(res, operation, payload = {}) {
  if (config.mockMode) return json(res, 200, mockCommand(operation));
  const args = buildDuneArgs(operation, payload);
  const result = await runDune(config, args);
  return json(res, 200, { operation, stdout: result.stdout, stderr: result.stderr, exitCode: result.code });
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
    return { operation, stdout: "", stderr: redact(error.stderr || error.message || error), exitCode: error.code || 1 };
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
  const allowDestructive = Boolean(body.confirmDestructive && body.confirmation === "RUN DESTRUCTIVE SQL");
  if (!readOnly && !allowDestructive) {
    return json(res, 400, { error: "Destructive SQL requires confirmation phrase RUN DESTRUCTIVE SQL and creates a backup first." });
  }
  if (!config.mockMode && !readOnly) {
    await runDune(config, buildDuneArgs("backupCreate"));
  }
  audit(config, req, "database.query", { readOnly, destructive: !readOnly });
  return dbJson(res, () => duneDb.runSql(db, query, allowDestructive));
}

async function databaseExport(req, res) {
  const body = await readJson(req);
  audit(config, req, "database.export", {});
  const content = await duneDb.exportRows(db, body.query);
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": "attachment; filename=\"query-export.json\""
  });
  res.end(content);
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

async function sietchesUpdateRoute(req, res) {
  const body = await readJson(req);
  const operationByAction = {
    "set-max": "sietchesSetMax",
    "set-active": "sietchesSetActive",
    "set-display": "sietchesSetDisplay",
    "set-password": "sietchesSetPassword",
    sync: "sietchesSync",
    validate: "sietchesValidate",
    reconcile: "sietchesReconcile"
  };
  const operation = operationByAction[String(body.action || "")];
  if (!operation) return json(res, 400, { error: "Unsupported sietch update action" });
  const dangerous = ["sietchesSetActive", "sietchesSetDisplay", "sietchesSetPassword", "sietchesReconcile"].includes(operation);
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

async function unsupportedMutation(req, res, action, reason, phrase = "") {
  const body = await readJson(req);
  if (phrase && body.confirmation !== phrase) {
    return json(res, 400, { error: `Confirmation phrase required: ${phrase}` });
  }
  audit(config, req, action, { supported: false, reason });
  return json(res, 501, { supported: false, reason, error: reason });
}

async function blockedImportRoute(req, res, action, phrase, reason) {
  const body = await readJson(req);
  if (body.confirmation !== phrase) {
    return json(res, 400, { error: `Confirmation phrase required: ${phrase}` });
  }
  if (action.includes("import")) {
    try {
      if (action.startsWith("blueprints")) duneDb.validateBlueprintPayload(body.payload || body);
      if (action.startsWith("bases")) duneDb.validateBasePayload(body.payload || body);
    } catch (error) {
      return json(res, 400, { error: redact(error.message || error) });
    }
  }
  audit(config, req, action, { supported: false, reason });
  return json(res, 501, { supported: false, reason, error: reason });
}

async function starterKitConfigRoute(req, res) {
  const body = await readJson(req);
  if (body.confirmation !== "SAVE STARTER KIT") return json(res, 400, { error: "Confirmation phrase required: SAVE STARTER KIT" });
  try {
    const saved = saveStarterKitConfig(config, body);
    audit(config, req, "starter-kit.config", { supported: true, enabled: saved.enabled, version: saved.version, itemCount: saved.items.length, xp: saved.xp });
    return json(res, 200, saved);
  } catch (error) {
    audit(config, req, "starter-kit.config", { supported: false, error: redact(error.message || error) });
    return json(res, 400, { error: redact(error.message || error) });
  }
}

async function starterKitEnableRoute(req, res, enabled) {
  const body = await readJson(req);
  const phrase = enabled ? "ENABLE STARTER KIT" : "DISABLE STARTER KIT";
  if (body.confirmation !== phrase) return json(res, 400, { error: `Confirmation phrase required: ${phrase}` });
  try {
    const saved = enableStarterKit(config, enabled);
    audit(config, req, enabled ? "starter-kit.enable" : "starter-kit.disable", { supported: true, version: saved.version });
    return json(res, 200, saved);
  } catch (error) {
    return json(res, 400, { error: redact(error.message || error) });
  }
}

async function starterKitGrantRoute(req, res, path) {
  const playerId = decodeURIComponent(path.split("/")[4]);
  try {
    const result = await grantStarterKit(config, playerId, await readJson(req));
    audit(config, req, "starter-kit.grant", { supported: true, playerId, ok: result.ok, grantId: result.id });
    return json(res, result.ok ? 200 : 207, result);
  } catch (error) {
    audit(config, req, "starter-kit.grant", { supported: false, playerId, error: redact(error.message || error) });
    return json(res, 400, { error: redact(error.message || error) });
  }
}

async function starterKitRetryRoute(req, res, path) {
  const grantId = decodeURIComponent(path.split("/")[4]);
  try {
    const result = await retryStarterKitGrant(config, grantId, await readJson(req));
    audit(config, req, "starter-kit.retry", { supported: true, grantId, ok: result.ok, retryGrantId: result.id });
    return json(res, result.ok ? 200 : 207, result);
  } catch (error) {
    audit(config, req, "starter-kit.retry", { supported: false, grantId, error: redact(error.message || error) });
    return json(res, 400, { error: redact(error.message || error) });
  }
}

function queryParams(url, names) {
  const out = {};
  for (const name of names) out[name] = url.searchParams.get(name) || "";
  return out;
}

function marketAutomationUnsupported() {
  return {
    supported: false,
    running: false,
    enabled: false,
    mode: "none",
    reason: "Market automation is blocked: arrakis-admin uses an embedded or remote market-bot runtime with its own config, lifecycle, cleanup, and history APIs. RedBlink does not currently provide a compatible market-bot service or CLI wrapper in this Docker stack."
  };
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
    let backup = null;
    if (!config.mockMode) {
      const backupResult = await runDune(config, buildDuneArgs("backupCreate"));
      backup = { exitCode: backupResult.code, stdout: backupResult.stdout };
    }
    const result = config.mockMode ? { ok: true, mock: true } : await fn(body);
    audit(config, req, action, { ...meta, supported: true, backup, result });
    return json(res, 200, { supported: true, backupCreated: !config.mockMode, result });
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
        durability: item.durability ?? 1
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
  return json(res, ok ? 200 : 207, { ok, results });
}

async function broadcastRoute(req, res) {
  const body = await readJson(req);
  try {
    const command = buildBroadcastCommand(body);
    const result = config.mockMode ? { code: 0, stdout: "mock broadcast\n", stderr: "", args: [] } : await publishServerCommand(config, command, "web-broadcast");
    audit(config, req, "admin.broadcast", { supported: true, command });
    return json(res, 200, { supported: true, ok: true, stdout: result.stdout, stderr: result.stderr });
  } catch (error) {
    audit(config, req, "admin.broadcast", { supported: false, error: redact(error.message || error) });
    return json(res, 400, { supported: false, error: redact(error.message || error), reason: redact(error.message || error) });
  }
}

async function shutdownBroadcastRoute(req, res) {
  const body = await readJson(req);
  if (body.confirmation !== "SHUTDOWN BROADCAST") {
    return json(res, 400, { error: "Confirmation phrase required: SHUTDOWN BROADCAST" });
  }
  try {
    const command = buildShutdownBroadcastCommand(body);
    const result = config.mockMode ? { code: 0, stdout: "mock shutdown broadcast\n", stderr: "", args: [] } : await publishServerCommand(config, command, "web-shutdown-broadcast");
    audit(config, req, "admin.broadcast-shutdown", { supported: true, command });
    return json(res, 200, { supported: true, ok: true, stdout: result.stdout, stderr: result.stderr });
  } catch (error) {
    audit(config, req, "admin.broadcast-shutdown", { supported: false, error: redact(error.message || error) });
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
  return {
    config: publicConfig(config),
    files: {
      env: existsSync(resolve(config.repoRoot, ".env")),
      token: existsSync(resolve(config.secretsDir, "funcom-token.txt")),
      battlegroup: existsSync(resolve(config.generatedDir, "battlegroup.env")),
      duneScript: existsSync(config.duneScript)
    }
  };
}

async function writeConfig(req, res) {
  const body = await readJson(req);
  const allowed = ["SERVER_IP", "SERVER_TITLE", "SERVER_REGION", "SERVER_PROVIDER", "STEAM_APP_ID", "BATTLEGROUP_ID"];
  const lines = [];
  for (const key of allowed) {
    if (body[key] !== undefined) lines.push(`${key}=${quoteEnv(String(body[key]))}`);
  }
  writeFileSync(resolve(config.repoRoot, ".env"), `${lines.join("\n")}\n`, { mode: 0o600 });
  audit(config, req, "setup.write-config", { keys: Object.keys(body).filter((key) => allowed.includes(key)) });
  return json(res, 200, { ok: true });
}

async function saveToken(req, res) {
  const body = await readJson(req);
  if (!body.token || String(body.token).length < 20) return json(res, 400, { error: "Token looks too short" });
  mkdirSync(config.secretsDir, { recursive: true });
  const path = resolve(config.secretsDir, "funcom-token.txt");
  writeFileSync(path, `${String(body.token).trim()}\n`, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
  audit(config, req, "setup.save-token", { token: "<redacted>" });
  return json(res, 200, { ok: true });
}

async function readJson(req) {
  return readJsonBody(req, config.maxJsonBytes);
}

function quoteEnv(value) {
  if (/^[A-Za-z0-9_.:-]+$/.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function knownServices() {
  return ["postgres", "rmq-admin", "rmq-game", "text-router", "director", "gateway", "survival", "survival-1", "overmap", "orchestrator", "autoscaler"];
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
