import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  automaticSystemBackupTotals,
  removeSystemBackupPassphrase,
  saveSystemBackupPassphrase,
  systemAutoBackupEnabled,
  systemBackupInProgress,
  systemBackupPassphraseStatus,
  systemBackupPassphraseProblem,
  withSystemBackupLock
} from "../src/services/systemBackupSchedule.js";

test("a passphrase cannot contain a NUL that the shell would silently discard", () => {
  assert.notEqual(systemBackupPassphraseProblem("correct horse\0battery staple"), "");
});

test("the inherited descriptor retains the backup lock throughout a passphrase write", () => {
  const { config } = makeHost();
  withSystemBackupLock(config, () => {
    assert.equal(systemBackupInProgress(config), true);
    assert.throws(() => saveSystemBackupPassphrase(config, "correct horse battery staple"), { statusCode: 409 });
    assert.throws(() => removeSystemBackupPassphrase(config), { statusCode: 409 });
  });
  assert.equal(systemBackupInProgress(config), false);
  assert.throws(() => withSystemBackupLock(config, () => { throw new Error("write failed"); }), /write failed/);
  assert.equal(systemBackupInProgress(config), false);
});

function makeHost() {
  const root = mkdtempSync(join(tmpdir(), "system-backup-schedule-"));
  return { root, config: { repoRoot: root } };
}

test("the passphrase is stored outside runtime/secrets so archives never carry it", () => {
  const { root, config } = makeHost();
  saveSystemBackupPassphrase(config, "correct horse battery staple");
  assert.equal(existsSync(join(root, "runtime/system-backup/passphrase")), true);
  assert.equal(existsSync(join(root, "runtime/secrets")), false);
});

test("saving leaves no temp files and keeps private modes on replace", () => {
  const { root, config } = makeHost();
  const first = saveSystemBackupPassphrase(config, "correct horse battery staple", new Date("2026-11-09T10:00:00Z"));
  const second = saveSystemBackupPassphrase(config, "another long passphrase", new Date("2026-11-10T10:00:00Z"));
  assert.equal(first.replaced, false);
  assert.equal(second.replaced, true);
  const dir = join(root, "runtime/system-backup");
  assert.deepEqual(readdirSync(dir).sort(), ["passphrase", "passphrase.json"]);
  for (const name of ["passphrase", "passphrase.json"]) {
    assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, name);
  }
  assert.deepEqual(systemBackupPassphraseStatus(config), { saved: true, savedAt: "2026-11-10T10:00:00.000Z" });
});

test("status tolerates a missing or unreadable metadata file", () => {
  const { root, config } = makeHost();
  assert.deepEqual(systemBackupPassphraseStatus(config), { saved: false, savedAt: "" });
  mkdirSync(join(root, "runtime/system-backup"), { recursive: true });
  writeFileSync(join(root, "runtime/system-backup/passphrase"), "set by hand on the host");
  writeFileSync(join(root, "runtime/system-backup/passphrase.json"), "not json");
  assert.deepEqual(systemBackupPassphraseStatus(config), { saved: true, savedAt: "" });
  // An empty file is not a usable key: db.sh refuses it too.
  writeFileSync(join(root, "runtime/system-backup/passphrase"), "");
  assert.equal(systemBackupPassphraseStatus(config).saved, false);
});

test("remove reports whether anything was there", () => {
  const { config } = makeHost();
  assert.deepEqual(removeSystemBackupPassphrase(config), { removed: false });
  saveSystemBackupPassphrase(config, "correct horse battery staple");
  assert.deepEqual(removeSystemBackupPassphrase(config), { removed: true });
  assert.equal(systemBackupPassphraseStatus(config).saved, false);
});

test("the schedule is enabled only when the state file says exactly 1", () => {
  const { root, config } = makeHost();
  assert.equal(systemAutoBackupEnabled(config), false);
  mkdirSync(join(root, "runtime/generated"), { recursive: true });
  const file = join(root, "runtime/generated/system-backup-auto.env");
  for (const [text, expected] of [
    ["SYSTEM_AUTO_ENABLED=1\nSYSTEM_AUTO_KEEP=7\n", true],
    ["SYSTEM_AUTO_ENABLED=0\n", false],
    ["SYSTEM_AUTO_ENABLED=10\n", false],
    ["# SYSTEM_AUTO_ENABLED=1\n", false]
  ]) {
    writeFileSync(file, text);
    assert.equal(systemAutoBackupEnabled(config), expected, text);
  }
});

test("a held lock counts as a backup in progress; a free or missing one does not", () => {
  const { root, config } = makeHost();
  const calls = [];
  const contended = (cmd, args) => { calls.push([cmd, ...args]); const error = new Error("busy"); error.status = 75; throw error; };
  const free = (cmd, args) => { calls.push([cmd, ...args]); };
  const noFlock = () => { const error = new Error("spawn flock ENOENT"); error.code = "ENOENT"; throw error; };

  // No lock file yet: nothing has ever taken it, so flock is not even asked.
  assert.equal(systemBackupInProgress(config, contended), false);
  assert.equal(calls.length, 0);

  mkdirSync(join(root, "runtime/backups"), { recursive: true });
  writeFileSync(join(root, "runtime/backups/.system-backup.lock"), "");
  assert.equal(systemBackupInProgress(config, contended), true);
  assert.deepEqual(calls.at(-1).slice(0, 4), ["flock", "-n", "-E", "75"]);
  assert.equal(systemBackupInProgress(config, free), false);
  assert.equal(systemBackupInProgress(config, noFlock), false);
});

test("only automatic archives count toward the keep preview", () => {
  const rows = [
    { type: "Automatic Backup", sizeBytes: 100 },
    { type: "Manual Backup", sizeBytes: 1000 },
    { type: "Imported Backup", sizeBytes: 1000 },
    { type: "Automatic Backup", sizeBytes: 50 }
  ];
  assert.deepEqual(automaticSystemBackupTotals(rows), { automaticCount: 2, automaticBytes: 150 });
  assert.deepEqual(automaticSystemBackupTotals(undefined), { automaticCount: 0, automaticBytes: 0 });
});
