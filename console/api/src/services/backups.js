import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

export function enrichBackupRows(config, rows) {
  return rows.map((row) => {
    const metadata = readBackupMetadata(config, row.name);
    const sizeBytes = readBackupSize(config, row.name);
    const origin = String(metadata.backup_origin || metadata.origin || "").trim().toLowerCase();
    const battlegroupId = String(metadata.imported_from_battlegroup_id || metadata.battlegroup_id || "").trim();
    const enriched = { ...row, battlegroupId: battlegroupId || "Unknown", sizeBytes, size: formatBackupSize(sizeBytes) };
    if (/^(automatic|scheduled)$/.test(origin)) return { ...enriched, type: "Automatic Backup" };
    if (/^(restore-safety|restore_safety|restore safety)$/.test(origin)) return { ...enriched, type: "Restore Safety Backup" };
    if (/^(pre-update|pre_update|preupdate)$/.test(origin)) return { ...enriched, type: "Pre-update Backup" };
    if (/^(destructive-sql|destructive_sql|destructive sql|sql-safety|sql_safety)$/.test(origin)) return { ...enriched, type: "SQL Safety Backup" };
    if (/^(external|imported)$/.test(origin)) return { ...enriched, type: "Imported Backup", source: "External" };
    return enriched;
  });
}

export function readBackupSize(config, name) {
  if (!/^[A-Za-z0-9_.-]+\.(backup|dump|sql)$/i.test(String(name || ""))) return 0;
  try {
    return statSync(resolve(config.repoRoot, "runtime/backups/db", name)).size;
  } catch {
    return 0;
  }
}

export function formatBackupSize(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "Unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 ? 0 : size >= 10 ? 1 : 2;
  return `${size.toFixed(precision).replace(/\.0+$|(\.\d*[1-9])0+$/, "$1")} ${units[unitIndex]}`;
}

export function readBackupMetadata(config, name) {
  if (!/^[A-Za-z0-9_.-]+\.(backup|dump|sql)$/i.test(String(name || ""))) return {};
  const metadataPath = resolve(config.repoRoot, "runtime/backups/db", `${name}.yaml`);
  if (!existsSync(metadataPath)) return {};
  try {
    return parseBackupMetadata(readFileSync(metadataPath, "utf8"));
  } catch {
    return {};
  }
}

export function normalizeImportedBackupMetadata(config, content) {
  const metadata = parseBackupMetadata(content);
  const currentBattlegroupId = readCurrentBattlegroupId(config);
  const originalBattlegroupId = String(metadata.battlegroup_id || "").trim();
  if (originalBattlegroupId && currentBattlegroupId && originalBattlegroupId !== currentBattlegroupId && !metadata.imported_from_battlegroup_id) {
    metadata.imported_from_battlegroup_id = originalBattlegroupId;
  }
  metadata.backup_origin = "external";
  metadata.imported_at = new Date().toISOString();
  return stringifyBackupMetadata(metadata);
}

export function parseBackupMetadata(content) {
  const text = String(content || "");
  const metadata = Object.fromEntries(text.split(/\r?\n/).map((line) => {
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    return match ? [match[1], match[2].trim()] : null;
  }).filter(Boolean));
  const funcomBattlegroupId = extractFuncomBattlegroupId(text);
  if (funcomBattlegroupId && !metadata.battlegroup_id) metadata.battlegroup_id = funcomBattlegroupId;
  return metadata;
}

export function stringifyBackupMetadata(metadata) {
  return `${Object.entries(metadata).map(([key, value]) => `${key}: ${String(value || "")}`).join("\n")}\n`;
}

export function extractFuncomBattlegroupId(content) {
  const text = String(content || "");
  const candidates = [];
  const lines = text.split(/\r?\n/);
  let topLevelSection = "";

  for (const rawLine of lines) {
    const rootMatch = rawLine.match(/^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/);
    if (rootMatch) {
      topLevelSection = rootMatch[1];
      continue;
    }

    if (topLevelSection === "metadata") {
      const nameMatch = rawLine.match(/^  name:\s*(.+)$/);
      if (nameMatch) candidates.push(cleanYamlScalar(nameMatch[1]));

      const namespaceMatch = rawLine.match(/^  namespace:\s*(.+)$/);
      if (namespaceMatch) {
        const namespace = cleanYamlScalar(namespaceMatch[1]);
        const battlegroupMatch = namespace.match(/(?:^|-)funcom-seabass-(sh-[A-Za-z0-9]+-[A-Za-z0-9]+)$/i) ||
          namespace.match(/^funcom-seabass-(sh-[A-Za-z0-9]+-[A-Za-z0-9]+)$/i);
        if (battlegroupMatch) candidates.push(battlegroupMatch[1]);
      }
    }

    if (topLevelSection === "spec") {
      const specNameMatch = rawLine.match(/^  name:\s*(.+)$/);
      if (specNameMatch) candidates.push(cleanYamlScalar(specNameMatch[1]));
    }
  }

  const fallback = text.match(/\bsh-[A-Za-z0-9]+-[A-Za-z0-9]+\b/);
  if (fallback) candidates.push(fallback[0]);

  return candidates.find((value) => /^sh-[A-Za-z0-9]+-[A-Za-z0-9]+$/.test(value)) || "";
}

function cleanYamlScalar(value) {
  const trimmed = String(value || "").trim();
  const quoted = trimmed.match(/^(['"])(.*)\1$/);
  return (quoted ? quoted[2] : trimmed).trim();
}

export function readCurrentBattlegroupId(config) {
  try {
    const text = readFileSync(resolve(config.generatedDir, "battlegroup.env"), "utf8");
    return text.match(/^BATTLEGROUP_ID=(.*)$/m)?.[1]?.replace(/\\ /g, " ").trim() || "";
  } catch {
    return "";
  }
}

export function validBackupDownloadName(name) {
  return /^dune-db-([a-z0-9][a-z0-9_-]*__)?[0-9]{8}-[0-9]{6}\.(dump|sql)$/i.test(name) ||
    /^[a-z0-9][a-z0-9_-]*-[0-9]{8}-[0-9]{6}\.backup$/i.test(name);
}

export function createBackupDownloadArchive(files) {
  return gzipSync(createTarArchive(files));
}

export function nextImportedBackupName(backupDir) {
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
