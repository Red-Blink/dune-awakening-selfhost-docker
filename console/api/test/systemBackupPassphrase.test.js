import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskManager, publicTask } from "../src/tasks.js";
import { redactValue } from "../src/redact.js";

const PASSPHRASE = "correct-horse-battery-staple-9931";
const posixOnly = { skip: process.platform === "win32" ? "needs a POSIX shell for the fake dune script" : false };

// A real fake `dune` that records exactly what it was handed. Asserting against
// this beats mocking: it proves what the spawned process actually receives.
function makeManager() {
  const dir = mkdtempSync(join(tmpdir(), "system-passphrase-"));
  const duneScript = join(dir, "dune");
  const argvLog = join(dir, "argv.txt");
  const envLog = join(dir, "env.txt");
  writeFileSync(duneScript, [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `printf '%s\\n' "$@" > ${JSON.stringify(argvLog)}`,
    `env > ${JSON.stringify(envLog)}`,
    "exit 0"
  ].join("\n"));
  chmodSync(duneScript, 0o755);
  const manager = new TaskManager({ duneScript, repoRoot: dir, taskRetention: 20, commandTimeoutMs: 15000 });
  return { manager, argvLog, envLog };
}

function waitForTask(manager, id) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const task = manager.get(id);
      if (task && ["succeeded", "failed"].includes(task.status)) return resolve(task);
      if (Date.now() - started > 12000) return reject(new Error("task did not settle"));
      setTimeout(tick, 15);
    };
    tick();
  });
}

test("the passphrase reaches the child as an env var and never as an argument", posixOnly, async () => {
  const { manager, argvLog, envLog } = makeManager();
  const created = manager.create("backup", "backupSystemCreate", {}, { env: { DUNE_SYSTEM_BACKUP_PASSPHRASE: PASSPHRASE } });
  await waitForTask(manager, created.id);

  assert.ok(existsSync(argvLog), "the fake dune script should have run");
  const argv = readFileSync(argvLog, "utf8");
  const env = readFileSync(envLog, "utf8");

  // argv is what shows up in ps / /proc/<pid>/cmdline and in the task result.
  assert.ok(!argv.includes(PASSPHRASE), `passphrase leaked into argv: ${argv}`);
  assert.match(argv, /backup-system/);
  assert.match(env, new RegExp(`DUNE_SYSTEM_BACKUP_PASSPHRASE=${PASSPHRASE}`));
});

test("the passphrase is never stored on the task the API hands back", posixOnly, async () => {
  const { manager } = makeManager();
  const created = manager.create("backup", "backupSystemCreate", {}, { env: { DUNE_SYSTEM_BACKUP_PASSPHRASE: PASSPHRASE } });
  const settled = await waitForTask(manager, created.id);

  // publicTask() is the serialization boundary for every /api/setup/tasks poll,
  // and this.tasks retains the task for taskRetention afterwards.
  assert.ok(!JSON.stringify(publicTask(settled)).includes(PASSPHRASE));
  assert.ok(!JSON.stringify(publicTask(created)).includes(PASSPHRASE));
  assert.ok(!JSON.stringify(manager.get(created.id)).includes(PASSPHRASE));
  assert.ok(!JSON.stringify(manager.list()).includes(PASSPHRASE));
});

test("a task carrying no env is unaffected", posixOnly, async () => {
  const { manager, envLog } = makeManager();
  const created = manager.create("backup", "backupCreate", {});
  await waitForTask(manager, created.id);
  assert.ok(!readFileSync(envLog, "utf8").includes("DUNE_SYSTEM_BACKUP_PASSPHRASE"));
});

// Defence in depth for the audit path: the passphrase should never be put in a
// payload at all, but if one ever is, the key must be masked. "passphrase"
// matches none of password/token/secret/credential on its own.
test("redactValue masks a passphrase key", () => {
  const redacted = redactValue({ passphrase: PASSPHRASE, nested: { passphrase: PASSPHRASE } });
  assert.equal(redacted.passphrase, "<redacted>");
  assert.equal(redacted.nested.passphrase, "<redacted>");
  assert.ok(!JSON.stringify(redacted).includes(PASSPHRASE));
});
