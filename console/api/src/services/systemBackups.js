import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { formatBackupSize, parseBackupMetadata } from "./backups.js";

// Matches SYSTEM_BACKUP_DIR_DEFAULT in runtime/scripts/db.sh.
export const SYSTEM_BACKUP_DIR = "runtime/backups/system";

// db.sh builds archive_id as "dune-system-$ts-$nonce" where ts is YYYYMMDD-HHMMSS
// and nonce is "$$-$RANDOM". The .yaml sidecar is the same name plus a suffix, and
// is deliberately accepted here so one download route can serve both: the sidecar
// holds no secrets and is useful on its own.
const SYSTEM_BACKUP_NAME = /^dune-system-[0-9]{8}-[0-9]{6}-[0-9]+-[0-9]+\.tar\.gz\.enc(\.yaml)?$/;

export function validSystemBackupName(name) {
  return SYSTEM_BACKUP_NAME.test(String(name || ""));
}

// Download serves the sidecar too, but delete must not: a sidecar name reached
// the shell, which rejects it, surfacing as a failed task instead of a 400.
export function validSystemArchiveName(name) {
  const value = String(name || "");
  return SYSTEM_BACKUP_NAME.test(value) && !value.endsWith(".yaml");
}

export function systemBackupDir(config) {
  return resolve(config.repoRoot, SYSTEM_BACKUP_DIR);
}

// The archive and its sidecar are one backup in two files, so the download
// serves them as one. The sidecar is skipped when absent rather than treated as
// an error: an archive copied in by hand may arrive without one, and refusing to
// download it then would be worse than downloading what exists.
export function systemBackupBundleMembers(config, archiveName) {
  const directory = systemBackupDir(config);
  const members = [];
  for (const name of [archiveName, `${archiveName}.yaml`]) {
    const filePath = resolve(directory, name);
    if (!filePath.startsWith(`${directory}/`)) continue;
    if (!existsSync(filePath)) continue;
    members.push({ name, path: filePath, size: statSync(filePath).size });
  }
  return members;
}

export function listSystemBackups(config) {
  const directory = systemBackupDir(config);
  if (!existsSync(directory)) return [];

  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const rows = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // Only the archives themselves; sidecars are read as metadata below, and
    // *.partial.* staging files are a backup still being written.
    if (!validSystemBackupName(entry.name) || entry.name.endsWith(".yaml")) continue;

    let sizeBytes = 0;
    try {
      sizeBytes = statSync(resolve(directory, entry.name)).size;
    } catch {
      continue;
    }

    const metadata = readSystemBackupMetadata(directory, entry.name);
    const origin = String(metadata.backup_origin || "").trim().toLowerCase();
    rows.push({
      name: entry.name,
      createdAt: metadata.created_at || "",
      origin: metadata.backup_origin || "unknown",
      // Same vocabulary the database table uses (enrichBackupRows), from the
      // same sidecar field, so the two tables read alike.
      type: systemBackupType(origin),
      // Nothing imports system archives yet, so this reads "Local" today. It
      // is derived rather than hardcoded so an import path that writes
      // backup_origin: external lights it up without touching this file.
      source: /^(external|imported)$/.test(origin) ? "External" : "Local",
      encryption: metadata.encryption || "unknown",
      serverTitle: metadata.server_title || "Unknown",
      battlegroupId: metadata.battlegroup_id || "Unknown",
      hasSidecar: existsSync(resolve(directory, `${entry.name}.yaml`)),
      sizeBytes,
      size: formatBackupSize(sizeBytes)
    });
  }

  // Newest first, keyed on the timestamp embedded in the FILENAME rather than the
  // sidecar's created_at. The name is always present and always the same shape,
  // whereas a missing sidecar would otherwise compare "" against an ISO date --
  // and a filename sorts above any date string, floating unreadable entries to
  // the top.
  return rows.sort((a, b) => b.name.localeCompare(a.name));
}

function systemBackupType(origin) {
  if (/^(external|imported)$/.test(origin)) return "Imported Backup";
  if (/^(automatic|scheduled)$/.test(origin)) return "Automatic Backup";
  if (!origin) return "Unknown";
  return "Manual Backup";
}

function readSystemBackupMetadata(directory, name) {
  const sidecar = resolve(directory, `${name}.yaml`);
  if (!existsSync(sidecar)) return {};
  try {
    return parseBackupMetadata(readFileSync(sidecar, "utf8"));
  } catch {
    return {};
  }
}
