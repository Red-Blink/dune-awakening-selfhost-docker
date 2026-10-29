import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildDuneArgs } from "../src/runner.js";
import { parseBackupAutoStatus } from "../src/statusParsers.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function fixture(t, intervalHours, retentionDays) {
  const root = mkdtempSync(join(tmpdir(), "dune-backup-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "runtime/scripts");
  const generated = join(root, "runtime/generated");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(generated, { recursive: true });
  for (const file of ["db.sh", "env-file.sh", "host-file-ownership.sh"]) {
    cpSync(join(repoRoot, "runtime/scripts", file), join(scripts, file));
  }
  writeFileSync(join(generated, "db-backup.env"), [
    "DB_AUTO_BACKUP_ENABLED=1",
    "DB_AUTO_BACKUP_TIME=05:00",
    `DB_AUTO_BACKUP_INTERVAL_HOURS=${intervalHours}`,
    `DB_AUTO_BACKUP_RETENTION_DAYS=${retentionDays}`,
    ""
  ].join("\n"));
  const wrapper = join(scripts, "backup-settings-test.sh");
  // Exercise the real CLI/state/unit writers. Only privileged installation and
  // host status calls are replaced; no Docker or host systemd operation runs.
  writeFileSync(wrapper, `#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/db.sh" help >/dev/null
systemctl() { return 0; }
can_manage_systemd_units() { return 1; }
install_auto_units_via_docker_host() {
  write_auto_units_to "$1" "$PWD/units" "$PWD" "$2"
}
handle_auto_backup "$@"
`);
  return {
    run(args) {
      const result = spawnSync("bash", [wrapper, ...args], { cwd: root, encoding: "utf8", timeout: 10000 });
      assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
      return result;
    },
    timer() { return readFileSync(join(root, "units/dune-awakening-db-backup.timer"), "utf8"); }
  };
}

for (const [previous, intervalHours] of [[6, 24], [23, 24], [24, 1], [24, 168]]) {
  test(`Console backup interval changes from ${previous} to ${intervalHours} hours and survives reload`, (t) => {
    const state = fixture(t, previous, 14);
    const args = buildDuneArgs("backupAutoEnable", { time: "05:30", retentionDays: 14, intervalHours });
    state.run(args.slice(2));
    const status = parseBackupAutoStatus(state.run(["status"]));
    assert.equal(status.intervalHours, String(intervalHours));
    assert.equal(status.backupTime, "05:30");
    assert.equal(status.retentionDays, "14");
    assert.match(state.timer(), /OnCalendar=\*-\*-\* 05:30:00/);
    if (intervalHours === 24) assert.doesNotMatch(state.timer(), /OnUnitActiveSec=/);
    else assert.ok(state.timer().includes(`OnUnitActiveSec=${intervalHours}h\n`));
  });
}

for (const intervalHours of [12, 24]) {
  test(`Console can disable backup retention with a ${intervalHours}-hour interval`, (t) => {
    const state = fixture(t, 24, 14);
    state.run(buildDuneArgs("backupAutoEnable", { time: "05:30", retentionDays: 0, intervalHours }).slice(2));
    const status = parseBackupAutoStatus(state.run(["status"]));
    assert.equal(status.intervalHours, String(intervalHours));
    assert.equal(status.retentionDays, "0");
  });
}

test("CLI callers omitting interval and retention still preserve their existing settings", (t) => {
  const state = fixture(t, 6, 14);
  state.run(["enable", "05:30"]);
  const status = parseBackupAutoStatus(state.run(["status"]));
  assert.equal(status.intervalHours, "6");
  assert.equal(status.retentionDays, "14");
});
