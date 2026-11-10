import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";

// Matches SYSTEM_BACKUP_PASSPHRASE_DIR and SYSTEM_AUTO_STATE_FILE in
// runtime/scripts/db.sh. Outside runtime/secrets/ so the key is never archived
// inside the backups it encrypts, and a restore never overwrites it.
export const SYSTEM_BACKUP_PASSPHRASE_DIR = "runtime/system-backup";
export const SYSTEM_AUTO_STATE_FILE = "runtime/generated/system-backup-auto.env";

export function systemBackupPassphrasePaths(config) {
  const dir = resolve(config.repoRoot, SYSTEM_BACKUP_PASSPHRASE_DIR);
  return { dir, file: resolve(dir, "passphrase"), meta: resolve(dir, "passphrase.json") };
}

// Shared by manual create and the saved passphrase. Line breaks are refused
// because gpg's --passphrase-fd stops reading at the first one.
export function systemBackupPassphraseProblem(value) {
  if (typeof value !== "string" || value.length < 12) return "The passphrase must be at least 12 characters.";
  if (value.length > 1024) return "The passphrase is too long.";
  if (/[\r\n]/.test(value)) return "The passphrase cannot contain line breaks.";
  if (value.includes("\0")) return "The passphrase cannot contain null characters.";
  // A floor, not a complexity policy: the archive is downloadable, so a
  // degenerate passphrase is crackable offline however strong the KDF is.
  if (new Set(value).size < 5) return "The passphrase must use at least 5 different characters.";
  return "";
}

function writePrivateFileAtomic(path, data) {
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function saveSystemBackupPassphrase(config, passphrase, now = new Date()) {
  return withSystemBackupLock(config, () => writeSystemBackupPassphrase(config, passphrase, now));
}

function writeSystemBackupPassphrase(config, passphrase, now) {
  const { dir, file, meta } = systemBackupPassphrasePaths(config);
  const replaced = existsSync(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const savedAt = now.toISOString();
  writePrivateFileAtomic(file, passphrase);
  writePrivateFileAtomic(meta, `${JSON.stringify({ savedAt })}\n`);
  return { savedAt, replaced };
}

export function removeSystemBackupPassphrase(config) {
  return withSystemBackupLock(config, () => deleteSystemBackupPassphrase(config));
}

function deleteSystemBackupPassphrase(config) {
  const { file, meta } = systemBackupPassphrasePaths(config);
  const existed = existsSync(file);
  rmSync(file, { force: true });
  rmSync(meta, { force: true });
  return { removed: existed };
}

export function systemBackupPassphraseStatus(config) {
  const { file, meta } = systemBackupPassphrasePaths(config);
  let saved = false;
  try {
    saved = statSync(file).isFile() && statSync(file).size > 0;
  } catch {
    saved = false;
  }
  let savedAt = "";
  if (saved) {
    try {
      savedAt = String(JSON.parse(readFileSync(meta, "utf8"))?.savedAt || "");
    } catch {
      savedAt = "";
    }
  }
  return { saved, savedAt };
}

// Read directly rather than through `dune db auto-system status`, so the delete
// route can refuse cheaply without spawning a shell.
export function systemAutoBackupEnabled(config) {
  try {
    const text = readFileSync(resolve(config.repoRoot, SYSTEM_AUTO_STATE_FILE), "utf8");
    return /^SYSTEM_AUTO_ENABLED=1\s*$/m.test(text);
  } catch {
    return false;
  }
}

// Matches SYSTEM_BACKUP_LOCK_FILE in runtime/scripts/db.sh.
export const SYSTEM_BACKUP_LOCK_FILE = "runtime/backups/.system-backup.lock";

// flock locks the inherited open-file description. Keeping our descriptor open
// retains that lock after the short flock process exits, until both the secret
// and its metadata have been updated. A probe alone leaves a race with systemd.
export function withSystemBackupLock(config, action) {
  const path = resolve(config.repoRoot, SYSTEM_BACKUP_LOCK_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "a", 0o600);
  try {
    try {
      execFileSync("flock", ["-n", "-E", "75", "3"], {
        stdio: ["ignore", "ignore", "pipe", fd], timeout: 5000
      });
    } catch (error) {
      if (error?.status === 75) {
        throw Object.assign(new Error("A system backup or restore is running. Try again when it finishes."), { statusCode: 409 });
      }
      throw error;
    }
    return action();
  } finally {
    closeSync(fd);
  }
}

// True while db.sh holds the system-backup lock. A running backup has already
// read the old passphrase, so replacing it then would mislabel that archive.
// flock -n exits with -E's code only on contention; a missing flock binary or
// lock directory means nothing can be holding it.
export function systemBackupInProgress(config, run = execFileSync) {
  const lockFile = resolve(config.repoRoot, SYSTEM_BACKUP_LOCK_FILE);
  if (!existsSync(lockFile)) return false;
  try {
    run("flock", ["-n", "-E", "75", lockFile, "true"], { stdio: "ignore", timeout: 5000 });
    return false;
  } catch (error) {
    return error?.status === 75;
  }
}

export function automaticSystemBackupTotals(rows) {
  const automatic = (Array.isArray(rows) ? rows : []).filter((row) => row?.type === "Automatic Backup");
  return {
    automaticCount: automatic.length,
    automaticBytes: automatic.reduce((sum, row) => sum + (Number(row.sizeBytes) || 0), 0)
  };
}
