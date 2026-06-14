import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { redact } from "./redact.js";

export const serviceAliases = new Map([
  ["postgres", "postgres"],
  ["rmq-admin", "rmq-admin"],
  ["rmq-game", "rmq-game"],
  ["text-router", "text-router"],
  ["tr", "text-router"],
  ["director", "director"],
  ["bgd", "director"],
  ["gateway", "gateway"],
  ["sgw", "gateway"],
  ["survival", "survival"],
  ["survival-1", "survival-1"],
  ["overmap", "overmap"],
  ["orchestrator", "orchestrator"],
  ["autoscaler", "autoscaler"]
]);

const simpleOperations = {
  status: ["status"],
  readiness: ["ready"],
  services: ["ps"],
  ports: ["ports"],
  doctor: ["doctor"],
  start: ["start"],
  stop: ["stop"],
  updateCheck: ["update", "check"],
  updateApply: ["update", "--yes"],
  updateFixSteamcmd: ["update", "fix-steamcmd"],
  updateAutoStatus: ["update", "auto", "status"],
  updateAutoDisable: ["update", "auto", "disable"],
  selfUpdateCheck: ["self-update", "check"],
  selfUpdateApply: ["self-update", "install", "latest"],
  selfUpdateList: ["self-update", "list"],
  selfUpdatePrevious: ["self-update", "install", "previous"],
  backupCreate: ["db", "backup"],
  backupList: ["db", "list"],
  backupDeleteAll: ["db", "delete", "--all"],
  backupAutoStatus: ["db", "auto", "status"],
  backupAutoDisable: ["db", "auto", "disable"],
  init: ["init"],
  restartScheduleStatus: ["restart-schedule", "status"],
  restartScheduleDisable: ["restart-schedule", "disable"],
  dbStatus: ["database", "status"],
  servers: ["servers"],
  mapsList: ["maps", "list"],
  sietchesList: ["sietches", "list"],
  deepdesertStatus: ["deepdesert", "dual", "status"],
  players: ["admin", "players", "--show-full-ids"],
  adminHistory: ["admin", "history"],
  adminItemList: ["admin", "item-list"],
  adminVehicleList: ["admin", "vehicle-list"],
  adminSkillModules: ["admin", "skill-modules"]
};

export function validateServiceName(value) {
  const raw = String(value || "").trim();
  if (/^dune-server-[a-z0-9-]+$/i.test(raw)) return raw;
  const normalized = serviceAliases.get(raw);
  if (!normalized) {
    throw new Error(`Unsupported service: ${raw}`);
  }
  return normalized;
}

export function buildDuneArgs(operation, payload = {}) {
  if (simpleOperations[operation]) return simpleOperations[operation];

  switch (operation) {
    case "restartService":
      return ["restart", validateServiceName(payload.service)];
    case "serverTitle":
      return ["config", "title", validateServerTitle(payload.title), "--yes"];
    case "restartScheduleEnable":
      return ["restart-schedule", "enable", validateUpdateTime(payload.time || "05:00"), String(validateInteger(payload.notifyMinutes ?? 15, 1, 1440))];
    case "restartAll":
      return ["restart", "gateway"];
    case "logs":
      return ["logs", validateServiceName(payload.service)];
    case "backupRestore":
      {
        return ["db", "restore", validateBackupName(payload.backup)];
      }
    case "backupDelete":
      return ["db", "delete", validateBackupName(payload.backup)];
    case "backupAutoEnable":
      {
        const args = ["db", "auto", "enable", validateUpdateTime(payload.time || "05:00")];
        const retentionDays = validateInteger(payload.retentionDays ?? 0, 0, 3650);
        if (retentionDays > 0) args.push(String(retentionDays));
        return args;
      }
    case "backupAutoRetention":
      return ["db", "auto", "retention", String(validateInteger(payload.retentionDays, 0, 3650))];
    case "updateAutoEnable":
      return ["update", "auto", "enable", validateUpdateTime(payload.time || "05:00")];
    case "databaseTables":
      return ["database", "tables", payload.schema || "dune"];
    case "databasePreview":
      return ["database", "preview", validateTableName(payload.table), String(payload.limit || 50), String(payload.offset || 0)];
    case "databaseQuery":
      return ["database", "sql", validateSql(payload.query, Boolean(payload.allowDestructive))];
    case "databaseExport":
      return ["database", "export", validateSql(payload.query, false)];
    case "adminGiveItem":
      return ["admin", "grant-item", validatePlayerId(payload.playerId), validateItemName(payload.itemName), String(validateInteger(payload.quantity ?? 1, 1, 1000000)), String(validateDurability(1)), String(validateItemQuality(payload.quality ?? payload.grade ?? 0))];
    case "adminGiveItems":
      return ["admin", "grant-template", validatePlayerId(payload.playerId), validateTemplateName(payload.template || "scout-ornithopter-mk6")];
    case "adminGiveItemId":
      return ["admin", "grant-item-id", validatePlayerId(payload.playerId), validateItemId(payload.itemId), String(validateInteger(payload.quantity ?? 1, 1, 1000000)), String(validateDurability(1)), String(validateItemQuality(payload.quality ?? payload.grade ?? 0))];
    case "adminAddXp":
      return ["admin", "award-xp", validatePlayerId(payload.playerId), String(validateInteger(payload.amount, 1, 100000000))];
    case "adminSetSkillPoints":
      return ["admin", "skill-points", validatePlayerId(payload.playerId), String(validateInteger(payload.points, 0, 100000))];
    case "adminSetSkillModule":
      return ["admin", "skill-module", validatePlayerId(payload.playerId), validateSkillModule(payload.module), String(validateInteger(payload.level, 0, 100))];
    case "adminRefillWater":
      return ["admin", "refill-water", validatePlayerId(payload.playerId), String(validateInteger(payload.amount ?? 1000000, 1, 1000000000))];
    case "adminKick":
      return ["admin", "kick", validatePlayerId(payload.playerId), "--yes", "--force"];
    case "adminKickAllOnline":
      return ["admin", "kick", "--all-online", "--yes"];
    case "adminTeleport":
      return [
        "admin",
        "teleport",
        validatePlayerId(payload.playerId),
        String(validateNumber(payload.x, -100000000, 100000000)),
        String(validateNumber(payload.y, -100000000, 100000000)),
        String(validateNumber(payload.z, -100000000, 100000000)),
        String(validateNumber(payload.yaw || 0, -360, 360))
      ];
    case "adminSpawnVehicle":
      return ["admin", "spawn-vehicle", validatePlayerId(payload.playerId), validateVehicleId(payload.vehicleId), validateVehicleTemplate(payload.template), String(validateNumber(payload.offset ?? 1000, 0, 100000))];
    case "adminCleanInventory":
      return ["admin", "clean-inventory", validatePlayerId(payload.playerId)];
    case "adminResetProgression":
      return ["admin", "reset-progression", validatePlayerId(payload.playerId)];
    case "adminItemSearch":
      return ["admin", "item-search", validateSearchQuery(payload.q)];
    case "adminItemListCategory":
      return ["admin", "item-list", validateCatalogQuery(payload.category)];
    case "adminVehicleSearch":
      return ["admin", "vehicle-list", validateCatalogQuery(payload.q)];
    case "adminSkillModulesSearch":
      return ["admin", "skill-modules", validateCatalogQuery(payload.q)];
    case "adminSpecializationMax":
      return ["admin", "specialization-max", String(payload.character || ""), "--grant-keystones", "--yes"];
    case "mapsMode":
      return payload.map ? ["maps", "mode", validateMapName(payload.map)] : ["maps", "mode"];
    case "mapsSetMode":
      return ["maps", "set", validateMapName(payload.map), validateMapMode(payload.mode)];
    case "mapsApplySettings":
      return ["true"];
    case "mapsReconcile":
      return ["maps", "reconcile"];
    case "mapsSpawn":
      return ["spawn", validateMapOrPartition(payload.target)];
    case "mapsDespawn":
      return ["despawn", validateMapOrPartition(payload.target), "--force"];
    case "autoscalerStatus":
      return ["autoscaler", "status"];
    case "autoscalerAction":
      return ["autoscaler", validateAutoscalerAction(payload.action)];
    case "memoryStatus":
      return ["memory", "status"];
    case "memorySet":
      return ["memory", "set", validateMemoryTarget(memoryTarget(payload)), validateMemoryValue(payload.memory)];
    case "memorySetNoRestart":
      return ["memory", "set-no-restart", validateMemoryTarget(memoryTarget(payload)), validateMemoryValue(payload.memory)];
    case "memoryUnset":
      return ["memory", "unset", validateMemoryTarget(memoryTarget(payload))];
    case "sietchesShow":
      return ["sietches", "show", validateMapName(payload.map)];
    case "sietchesDimensions":
      return ["sietches", "dimensions", validateMapName(payload.map)];
    case "sietchesDimensionIds":
      return ["sietches", "dimensions", validateMapName(payload.map), "--ids"];
    case "sietchesSetMax":
      return ["sietches", "set-max", validateMapName(payload.map), String(validateInteger(payload.count, 1, 64))];
    case "sietchesSetActive":
      return ["sietches", "set-active", validateMapName(payload.map), String(validateInteger(payload.count, 1, 64))];
    case "sietchesSetDisplay":
      return ["sietches", "set-display", validatePartitionId(payload.partitionId), validateDisplayName(payload.displayName)];
    case "sietchesSetPassword":
      return ["sietches", "set-password", validatePartitionId(payload.partitionId), validateSietchPassword(payload.password ?? "")];
    case "sietchesSetSettings":
      return ["sietches", "set-settings", validatePartitionId(payload.partitionId), validateDisplayName(payload.displayName), validateSietchPassword(payload.password ?? "")];
    case "sietchesSync":
      return ["sietches", "sync"];
    case "sietchesValidate":
      return ["sietches", "validate"];
    case "sietchesReconcile":
      return ["sietches", "reconcile", validateMapName(payload.map)];
    case "deepdesertAction":
      return ["deepdesert", "dual", validateDeepDesertAction(payload.action), "--yes", ...(payload.action === "disable" ? ["--force"] : [])];
    case "userSettingsEngineValues":
      return ["usersettings", "engine-values"];
    case "userSettingsMetadata":
      return ["usersettings", "metadata"];
    case "userSettingsProfileRaw":
      return ["usersettings", "profile-raw"];
    case "userSettingsProfileWrite":
      return ["usersettings", "profile-write-b64", encodeTextArg(payload.content || "")];
    case "userSettingsProfileGameRaw":
      return ["usersettings", "profile-game-raw"];
    case "userSettingsProfileGameWrite":
      return ["usersettings", "profile-game-write-b64", encodeTextArg(payload.content || "")];
    case "userSettingsProfileEngineRaw":
      return ["usersettings", "profile-engine-raw"];
    case "userSettingsProfileEngineWrite":
      return ["usersettings", "profile-engine-write-b64", encodeTextArg(payload.content || "")];
    case "userSettingsMapValues":
      return ["usersettings", "map-values", validateMapName(payload.map)];
    case "userSettingsGlobalValues":
      return ["usersettings", "global-values"];
    case "userSettingsPartitionValues":
      return ["usersettings", "partition-values", validateMapName(payload.map), validatePartitionId(payload.partitionId)];
    case "userSettingsSave":
      return ["usersettings", "bulk-save", validateSettingsScope(payload.scope), validateMapName(payload.map || "Survival_1"), payload.partitionId ? validatePartitionId(payload.partitionId) : "", encodeJsonArg(payload.values || {})];
    case "userSettingsSaveAndRestart":
      return buildDuneArgs("userSettingsSave", payload);
    case "userSettingsResetEngineGameplay":
      return ["usersettings", "reset-engine-gameplay"];
    case "userSettingsResetGlobalGame":
      return ["usersettings", "reset-global-game"];
    case "userSettingsResetGame":
      return payload.partitionId ? ["usersettings", "reset-game", validateMapName(payload.map), validatePartitionId(payload.partitionId)] : ["usersettings", "reset-game", validateMapName(payload.map)];
    case "userSettingsResetAndRestart":
      return payload.scope === "engine"
        ? buildDuneArgs("userSettingsResetEngineGameplay", payload)
        : payload.scope === "global"
          ? buildDuneArgs("userSettingsResetGlobalGame", payload)
          : buildDuneArgs("userSettingsResetGame", payload);
    case "userSettingsRawEngine":
      return buildDuneArgs("userSettingsProfileEngineRaw", payload);
    case "userSettingsRawGame":
      return buildDuneArgs("userSettingsProfileGameRaw", payload);
    case "userSettingsRawEngineWrite":
      return buildDuneArgs("userSettingsProfileEngineWrite", payload);
    case "userSettingsRawGameWrite":
      return buildDuneArgs("userSettingsProfileGameWrite", payload);
    case "userSettingsRawAndRestart":
      return payload.scope === "profile" ? buildDuneArgs("userSettingsProfileWrite", payload) : payload.scope === "engine" ? buildDuneArgs("userSettingsRawEngineWrite", payload) : buildDuneArgs("userSettingsRawGameWrite", payload);
    case "userSettingsResetAll":
      return ["usersettings", "reset-all"];
    case "userSettingsMaterializeCurrent":
      return ["usersettings", "materialize-current"];
    default:
      throw new Error(`Unsupported operation: ${operation}`);
  }
}

function encodeJsonArg(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function encodeTextArg(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function validateSettingsScope(value) {
  const raw = String(value || "").trim();
  if (["engine", "global", "map", "partition", "profile"].includes(raw)) return raw;
  throw new Error(`Unsupported settings scope: ${raw}`);
}

export function runDune(config, args, options = {}) {
  if (!existsSync(config.duneScript)) {
    return Promise.reject(new Error(`Missing dune command: ${config.duneScript}`));
  }

  let command = config.duneScript;
  let commandArgs = args;
  if (args[0] === "usersettings") {
    command = "python3";
    commandArgs = [`${config.repoRoot}/runtime/scripts/usersettings.py`, ...args.slice(1)];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: config.repoRoot,
      shell: false,
      detached: true,
      env: { ...process.env, ...(options.env || {}), DUNE_ADMIN_ASSUME_YES: "1", DUNE_DB_ASSUME_YES: "1", DUNE_MEMORY_ASSUME_YES: "1" }
    });
    const timeout = setTimeout(() => killProcessTree(child), options.timeoutMs || config.commandTimeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = redact(chunk.toString());
      stdout += text;
      options.onLine?.(text, "stdout");
    });
    child.stderr.on("data", (chunk) => {
      const text = redact(chunk.toString());
      stderr += text;
      options.onLine?.(text, "stderr");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const result = { code, signal, stdout, stderr, args: commandArgs };
      const allowedExitCodes = options.allowedExitCodes || [0];
      if (allowedExitCodes.includes(code)) resolve(result);
      else reject(Object.assign(new Error(`dune ${args.join(" ")} failed with exit ${code}`), result));
    });
  });
}

function killProcessTree(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Process already exited.
    }
  }
}

export function runDockerLogs(service, options = {}) {
  const container = dockerContainerForLogService(service);
  const args = ["logs", "--tail", String(options.tail || 400)];
  if (options.since) args.push("--since", String(options.since));
  if (options.follow) args.push("-f");
  args.push(container);

  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      shell: false,
      env: { ...process.env }
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs || 30000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = redact(chunk.toString());
      stdout += text;
      options.onLine?.(text, "stdout");
    });
    child.stderr.on("data", (chunk) => {
      const text = redact(chunk.toString());
      stderr += text;
      options.onLine?.(text, "stderr");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const result = { code, signal, stdout, stderr, args: ["docker", ...args] };
      if (code === 0 || signal === "SIGTERM") resolve(result);
      else reject(Object.assign(new Error(`docker ${args.join(" ")} failed with exit ${code}`), result));
    });
  });
}

export function parseVehicleList(stdout = "") {
  const vehicles = [];
  let current = null;
  for (const rawLine of String(stdout).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const actorMatch = line.match(/^actor:\s*(.+)$/i);
    if (actorMatch && current) {
      current.actor = actorMatch[1].trim();
      continue;
    }
    const templatesMatch = line.match(/^templates:\s*(.*)$/i);
    if (templatesMatch && current) {
      current.templates = templatesMatch[1].split(",").map((part) => part.trim()).filter(Boolean);
      continue;
    }
    if (/^[A-Za-z][A-Za-z0-9_-]+$/.test(line)) {
      current = { id: line, name: line, actor: "", templates: [] };
      vehicles.push(current);
    }
  }
  return vehicles;
}

export function isDynamicServerService(service) {
  return /^dune-server-[a-z0-9-]+$/i.test(String(service || ""));
}

export function dockerContainerForLogService(service) {
  const raw = String(service || "").trim();
  const normalized = validateServiceName(raw);
  const containers = new Map([
    ["postgres", "dune-postgres"],
    ["rmq-admin", "dune-rmq-admin"],
    ["rmq-game", "dune-rmq-game"],
    ["text-router", "dune-text-router"],
    ["director", "dune-director"],
    ["gateway", "dune-server-gateway"],
    ["survival", "dune-server-survival-1"],
    ["survival-1", "dune-server-survival-1"],
    ["overmap", "dune-server-overmap"],
    ["orchestrator", "dune-orchestrator"],
    ["autoscaler", "dune-autoscaler"]
  ]);
  if (containers.has(normalized)) return containers.get(normalized);
  if (/^dune-server-[a-z0-9-]+$/i.test(normalized)) return normalized;
  throw new Error(`Docker log access is not configured for service: ${raw}`);
}

function validateServerTitle(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("Server title cannot be empty");
  if (raw.length > 80) throw new Error("Server title must be 80 characters or fewer");
  if (/[\r\n]/.test(raw)) throw new Error("Server title cannot contain line breaks");
  return raw;
}

function validatePlayerId(value) {
  const raw = String(value || "");
  if (raw === "*" || /^[A-Za-z0-9_:#.-]{1,128}$/.test(raw)) return raw;
  throw new Error("Invalid player id");
}

function validateInteger(value, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Expected integer ${min}-${max}`);
  return n;
}

function validateNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Expected number ${min}-${max}`);
  return n;
}

function validateItemName(value) {
  const raw = String(value || "").trim();
  if (raw && raw.length <= 200 && !/[\r\n]/.test(raw)) return raw;
  throw new Error("Invalid item name");
}

function validateItemId(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_./:-]{1,240}$/.test(raw)) return raw;
  throw new Error("Invalid item id");
}

function validateDurability(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error("Expected durability 0-1");
  return n;
}

function validateItemQuality(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 5 || Math.trunc(n) !== n) throw new Error("Expected item grade 0-5");
  return n;
}

function validateTemplateName(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "scout-ornithopter-mk6") return raw;
  throw new Error("Unsupported item bundle template");
}

function validateSkillModule(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_./:-]{1,200}$/.test(raw) || (raw.length > 0 && raw.length <= 120 && !/[\r\n]/.test(raw))) return raw;
  throw new Error("Invalid skill module");
}

function validateVehicleId(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_./:-]{1,160}$/.test(raw)) return raw;
  throw new Error("Invalid vehicle id");
}

function validateVehicleTemplate(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_./:-]{1,160}$/.test(raw)) return raw;
  throw new Error("Invalid vehicle template");
}

function validateMapName(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_:-]{1,80}$/.test(raw)) return raw;
  throw new Error("Invalid map name");
}

function validateMapMode(value) {
  const raw = String(value || "").trim();
  if (raw === "dynamic" || raw === "always-on") return raw;
  throw new Error("Map mode must be dynamic or always-on");
}

function validateMapOrPartition(value) {
  const raw = String(value || "").trim();
  if (/^[A-Za-z0-9_:-]{1,80}$/.test(raw)) return raw;
  throw new Error("Invalid map or partition target");
}

function validateAutoscalerAction(value) {
  const raw = String(value || "").trim();
  if (["status", "start", "stop", "restart", "logs"].includes(raw)) return raw;
  throw new Error("Unsupported autoscaler action");
}

function validateMemoryTarget(value) {
  const raw = String(value || "").trim();
  if (raw === "default" || /^[A-Za-z0-9_:-]{1,80}$/.test(raw)) return raw;
  throw new Error("Invalid memory target");
}

function memoryTarget(payload = {}) {
  const map = String(payload.map || "");
  const partitionId = String(payload.partitionId || "").trim();
  if (partitionId) return `partition:${validatePartitionId(partitionId)}`;
  return map;
}

function validateMemoryValue(value) {
  const raw = String(value || "").trim();
  if (/^[1-9][0-9]*[mMgG]$/.test(raw)) return raw;
  throw new Error("Invalid memory value");
}

function validatePartitionId(value) {
  return String(validateInteger(value, 1, 1000000));
}

function validateDisplayName(value) {
  const raw = String(value || "").trim();
  if (raw.length <= 80 && !/[\r\n]/.test(raw)) return raw;
  throw new Error("Invalid display name");
}

function validateSietchPassword(value) {
  const raw = String(value || "");
  if (raw.length <= 80 && !/[\r\n\t]/.test(raw)) return raw;
  throw new Error("Invalid sietch password");
}

function validateDeepDesertAction(value) {
  const raw = String(value || "").trim();
  if (["enable", "disable", "bootstrap", "repair"].includes(raw)) return raw;
  throw new Error("Unsupported Deep Desert action");
}

function validateUpdateTime(value) {
  const raw = String(value || "").trim();
  if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(raw)) return raw;
  throw new Error("Auto update time must be HH:MM");
}

function validateSearchQuery(value) {
  const raw = String(value || "").trim();
  if (raw.length >= 2 && raw.length <= 120 && !/[\r\n]/.test(raw)) return raw;
  throw new Error("Search query must be 2-120 characters");
}

function validateCatalogQuery(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.length <= 120 && !/[\r\n]/.test(raw)) return raw;
  throw new Error("Catalog query is invalid");
}

function validateTableName(value) {
  const raw = String(value || "");
  if (/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return raw;
  throw new Error("Invalid table name");
}

function validateBackupName(value) {
  const raw = String(value || "");
  if (/^[A-Za-z0-9._-]+$/.test(raw) && !raw.includes("..")) return raw;
  throw new Error("Invalid backup name");
}

export function isReadOnlySql(query) {
  const raw = String(query || "").trim();
  return /^(select|with|show|explain)\b/i.test(raw) && !/\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy\s+.*\s+from)\b/i.test(raw);
}

function validateSql(query, allowDestructive) {
  const raw = String(query || "").trim();
  if (!raw || raw.length > 100000) throw new Error("Invalid SQL query");
  if (!allowDestructive && !isReadOnlySql(raw)) throw new Error("Only read-only SQL is allowed without destructive confirmation");
  return raw;
}
