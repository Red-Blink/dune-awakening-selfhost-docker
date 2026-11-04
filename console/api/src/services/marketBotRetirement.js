import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  EDA_EXCHANGE_BOT_ADDON_ID,
  buybackSchedulePath,
  legacyBuybackSchedulePath,
  legacySeedSchedulePath,
  normalizeBuybackSchedule,
  normalizeSeedSchedule,
  seedSchedulePath
} from "../addonJobs.js";
import { removeInstalledAddon } from "../addons.js";

const RETIREMENT_VERSION = 1;

export async function retireLegacyEdaExchangeBot(config, options = {}) {
  const now = options.now || (() => new Date());
  const removeAddon = options.removeAddon || removeInstalledAddon;
  const coreDir = resolve(config.repoRoot, "runtime/generated/market-bot");
  const installedDir = resolve(config.repoRoot, "runtime/addons/installed", EDA_EXCHANGE_BOT_ADDON_ID);
  const legacyJobsDir = resolve(config.repoRoot, "runtime/addons/jobs", EDA_EXCHANGE_BOT_ADDON_ID);
  const markerPath = resolve(coreDir, "eda-retirement.json");
  const hadInstalledAddon = existsSync(installedDir);
  const hadLegacyJobs = existsSync(legacyJobsDir);
  const previousMarker = readObject(markerPath);
  const hadCoreBuyback = existsSync(buybackSchedulePath(config));
  const hadCoreSeed = existsSync(seedSchedulePath(config));
  const migrated = !hadCoreBuyback || !hadCoreSeed;
  const migratedAt = now().toISOString();
  let backupDir = previousMarker.backupDir || "";

  // Build and validate both schedules before creating core state or removing
  // anything. A malformed legacy file leaves the addon and its files intact.
  const buyback = hadCoreBuyback
    ? coreScheduleForRetirement(buybackSchedulePath(config), normalizeBuybackSchedule, "buyback")
    : scheduleForMigration(
      legacyBuybackSchedulePath(config),
      normalizeBuybackSchedule,
      "buyback"
    );
  const seed = hadCoreSeed
    ? coreScheduleForRetirement(seedSchedulePath(config), normalizeSeedSchedule, "seed")
    : scheduleForMigration(
      legacySeedSchedulePath(config),
      normalizeSeedSchedule,
      "seed"
    );

  if (
    previousMarker.version === RETIREMENT_VERSION
    && previousMarker.addonRemoved === true
    && !hadInstalledAddon
    && !hadLegacyJobs
    && hadCoreBuyback
    && hadCoreSeed
    && readObject(buybackSchedulePath(config)).source === "console"
    && readObject(seedSchedulePath(config)).source === "console"
  ) {
    return {
      retired: true,
      addonRemoved: true,
      migrated: false,
      changed: false,
      backupDir,
      cleanupError: ""
    };
  }

  if (!backupDir && (hadInstalledAddon || hadLegacyJobs)) {
    const absoluteBackupDir = retirementBackupPath(config, migratedAt);
    mkdirSync(absoluteBackupDir, { recursive: true, mode: 0o700 });
    if (hadInstalledAddon) cpSync(installedDir, resolve(absoluteBackupDir, "installed-addon"), { recursive: true });
    if (hadLegacyJobs) cpSync(legacyJobsDir, resolve(absoluteBackupDir, "jobs"), { recursive: true });
    backupDir = relativeRuntimePath(config, absoluteBackupDir);
  }

  if (!existsSync(coreDir)) {
    const stageDir = `${coreDir}.migrating-${process.pid}`;
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true, mode: 0o700 });
    try {
      writeJsonAtomic(resolve(stageDir, "buyback.json"), { ...buyback, source: "console" });
      writeJsonAtomic(resolve(stageDir, "seed.json"), { ...seed, source: "console" });
      writeJsonAtomic(resolve(stageDir, "eda-retirement.json"), {
        version: RETIREMENT_VERSION,
        migratedAt,
        legacyAddonFound: hadInstalledAddon,
        legacySchedulesFound: hadLegacyJobs,
        addonRemoved: false,
        backupDir
      });
      mkdirSync(dirname(coreDir), { recursive: true });
      renameSync(stageDir, coreDir);
    } catch (error) {
      rmSync(stageDir, { recursive: true, force: true });
      throw error;
    }
  } else {
    // Existing core schedules win over legacy values. Write both normalized
    // files before cleanup so a directory that previously contained only one
    // native schedule becomes a complete, console-owned state store.
    writeJsonAtomic(buybackSchedulePath(config), buyback);
    writeJsonAtomic(seedSchedulePath(config), seed);
  }

  let addonRemoved = !hadInstalledAddon;
  let cleanupError = "";
  try {
    if (hadInstalledAddon) {
      await removeAddon(config, EDA_EXCHANGE_BOT_ADDON_ID);
      addonRemoved = true;
    } else if (hadLegacyJobs) {
      rmSync(legacyJobsDir, { recursive: true, force: true });
    }
  } catch (error) {
    cleanupError = safeErrorMessage(error);
  }

  writeJsonAtomic(markerPath, {
    ...previousMarker,
    version: RETIREMENT_VERSION,
    migratedAt: previousMarker.migratedAt || migratedAt,
    legacyAddonFound: previousMarker.legacyAddonFound === true || hadInstalledAddon,
    legacySchedulesFound: previousMarker.legacySchedulesFound === true || hadLegacyJobs,
    addonRemoved,
    backupDir,
    ...(cleanupError ? { cleanupError } : { cleanupError: "" })
  });

  return {
    retired: true,
    addonRemoved,
    migrated,
    changed: migrated || (hadInstalledAddon && addonRemoved) || (hadLegacyJobs && !existsSync(legacyJobsDir)),
    backupDir,
    cleanupError
  };
}

function scheduleForMigration(path, normalize, label) {
  if (!existsSync(path)) return { ...normalize({}, {}), source: "console" };
  const raw = readRequiredObject(path, `Legacy EDA ${label} schedule`);
  try {
    return { ...normalize(raw, raw), source: "console" };
  } catch (error) {
    throw new Error(`Legacy EDA ${label} schedule is invalid: ${safeErrorMessage(error)}`);
  }
}

function coreScheduleForRetirement(path, normalize, label) {
  const raw = readRequiredObject(path, `Core Market Bot ${label} schedule`);
  try {
    return { ...normalize(raw, raw), source: "console" };
  } catch (error) {
    throw new Error(`Core Market Bot ${label} schedule is invalid: ${safeErrorMessage(error)}`);
  }
}

function readRequiredObject(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} could not be read: ${safeErrorMessage(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

function readObject(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : "Unexpected error.";
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function retirementBackupPath(config, isoTimestamp) {
  const stamp = isoTimestamp.replace(/[:.]/g, "-");
  return resolve(config.repoRoot, "runtime/backups/market-bot-eda-retirement", stamp);
}

function relativeRuntimePath(config, path) {
  const prefix = `${resolve(config.repoRoot)}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}
