// Real HTTP coverage for the saved-passphrase and schedule routes. Spawns the
// real src/server.js (same harness as systemBackupImportRoute.integration.test.js)
// so server.js's own wiring is proven, not just the service functions it calls.
// No Postgres and no gpg: none of these routes touch either.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 21000 + ((process.pid + 11) % 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSPHRASE = "correct horse battery staple 42";

function makeRepoRoot() {
  const repoRoot = mkdtempSync(join(tmpdir(), "dune-system-schedule-http-"));
  mkdirSync(join(repoRoot, "runtime/backups/system"), { recursive: true });
  mkdirSync(join(repoRoot, "runtime/generated"), { recursive: true });
  mkdirSync(join(repoRoot, "console/web/dist"), { recursive: true });
  writeFileSync(join(repoRoot, "VERSION"), "test\n");
  return repoRoot;
}

function startServer(repoRoot) {
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: API_ROOT,
    env: {
      ...process.env,
      DUNE_DOCKER_DIR: repoRoot,
      ADMIN_AUTH_DISABLED: "1",
      ADMIN_BIND_HOST: "127.0.0.1",
      ADMIN_BIND_PORT: String(PORT),
      ADMIN_STATIC_DIR: join(repoRoot, "console/web/dist")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  const ready = new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error(`API did not start listening.\n${output}`)), 20000);
    const poll = setInterval(async () => {
      try {
        const response = await fetch(`${BASE}/api/health`);
        if (response.ok) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolveReady();
        }
      } catch {
        // Not listening yet.
      }
    }, 150);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      clearInterval(poll);
      rejectReady(new Error(`API exited with code ${code} before listening.\n${output}`));
    });
  });
  return { child, ready, getOutput: () => output };
}

async function stopServer(child) {
  if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolveExit) => child.once("exit", resolveExit));
}

function flockAvailable() {
  try {
    execFileSync("flock", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function waitForLockHeld(lockPath) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      execFileSync("flock", ["-n", "-E", "75", lockPath, "true"], { stdio: "ignore" });
    } catch (error) {
      if (error?.status === 75) return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("the test lock holder never took the lock");
}

async function waitForLockFree(lockPath) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      execFileSync("flock", ["-n", "-E", "75", lockPath, "true"], { stdio: "ignore" });
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  throw new Error("the test lock holder never released the lock");
}

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : {} };
}

test("the saved passphrase is write-only, private, never audited, and guarded on removal", { timeout: 60000 }, async () => {
  const repoRoot = makeRepoRoot();
  const { child, ready, getOutput } = startServer(repoRoot);
  const passphraseFile = join(repoRoot, "runtime/system-backup/passphrase");
  try {
    await ready;

    // Refused before anything is written.
    let result = await call("PUT", "/api/backups/system/passphrase", { passphrase: PASSPHRASE, passphraseConfirm: `${PASSPHRASE}x` });
    assert.equal(result.status, 400, result.text);
    result = await call("PUT", "/api/backups/system/passphrase", { passphrase: "aaaaaaaaaaaaaaaa", passphraseConfirm: "aaaaaaaaaaaaaaaa" });
    assert.equal(result.status, 400, result.text);
    assert.equal(existsSync(passphraseFile), false);

    // Enabling and saved-passphrase create both need a saved passphrase.
    result = await call("POST", "/api/backups/system/auto", { enabled: true, time: "04:30", intervalHours: 24, keep: 7 });
    assert.equal(result.status, 400, result.text);
    result = await call("POST", "/api/backups/system/create", { useSavedPassphrase: true });
    assert.equal(result.status, 400, result.text);

    result = await call("PUT", "/api/backups/system/passphrase", { passphrase: PASSPHRASE, passphraseConfirm: PASSPHRASE });
    assert.equal(result.status, 200, `${result.text}\n${getOutput()}`);
    assert.equal(result.json.saved, true);
    assert.equal(result.json.replaced, false);
    assert.doesNotMatch(result.text, new RegExp(PASSPHRASE));

    assert.equal(readFileSync(passphraseFile, "utf8"), PASSPHRASE);
    assert.equal(statSync(passphraseFile).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(passphraseFile)).mode & 0o777, 0o700);
    const meta = JSON.parse(readFileSync(join(repoRoot, "runtime/system-backup/passphrase.json"), "utf8"));
    assert.equal(meta.savedAt, result.json.savedAt);
    assert.deepEqual(Object.keys(meta), ["savedAt"]);

    // Status says it is saved, and no response ever carries it back.
    const status = await call("GET", "/api/backups/system/auto");
    assert.equal(status.status, 200, status.text);
    assert.equal(status.json.status.passphraseSaved, true);
    assert.equal(status.json.status.passphraseSavedAt, meta.savedAt);
    assert.equal(status.json.status.automaticCount, 0);
    assert.doesNotMatch(status.text, new RegExp(PASSPHRASE));

    // While a system backup holds the lock it has already read the passphrase,
    // so neither replacing nor removing it is allowed until it finishes.
    if (flockAvailable()) {
      const lockPath = join(repoRoot, "runtime/backups/.system-backup.lock");
      writeFileSync(lockPath, "");
      // Its own process group: killing flock alone leaves the `sleep` child
      // holding the inherited lock fd.
      const holder = spawn("flock", [lockPath, "sleep", "30"], { stdio: "ignore", detached: true });
      try {
        await waitForLockHeld(lockPath);
        result = await call("PUT", "/api/backups/system/passphrase", { passphrase: `${PASSPHRASE}?`, passphraseConfirm: `${PASSPHRASE}?` });
        assert.equal(result.status, 409, result.text);
        result = await call("DELETE", "/api/backups/system/passphrase");
        assert.equal(result.status, 409, result.text);
        assert.equal(readFileSync(passphraseFile, "utf8"), PASSPHRASE);
      } finally {
        const exited = new Promise((resolveExit) => holder.once("exit", resolveExit));
        try { process.kill(-holder.pid, "SIGTERM"); } catch { /* already gone */ }
        await exited;
        await waitForLockFree(lockPath);
      }
    }

    result = await call("PUT", "/api/backups/system/passphrase", { passphrase: `${PASSPHRASE}!`, passphraseConfirm: `${PASSPHRASE}!` });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.json.replaced, true);

    // A schedule that is on keeps its key.
    writeFileSync(join(repoRoot, "runtime/generated/system-backup-auto.env"), "SYSTEM_AUTO_ENABLED=1\nSYSTEM_AUTO_TIME=04:30\n");
    result = await call("DELETE", "/api/backups/system/passphrase");
    assert.equal(result.status, 409, result.text);
    assert.equal(existsSync(passphraseFile), true);

    writeFileSync(join(repoRoot, "runtime/generated/system-backup-auto.env"), "SYSTEM_AUTO_ENABLED=0\nSYSTEM_AUTO_TIME=04:30\n");
    result = await call("DELETE", "/api/backups/system/passphrase");
    assert.equal(result.status, 200, result.text);
    assert.equal(result.json.removed, true);
    assert.equal(existsSync(passphraseFile), false);
    assert.equal(existsSync(join(repoRoot, "runtime/system-backup/passphrase.json")), false);

    const auditLog = readFileSync(join(repoRoot, "runtime/generated/web-admin-audit.jsonl"), "utf8");
    assert.match(auditLog, /backup\.system-passphrase\.save/);
    assert.match(auditLog, /backup\.system-passphrase\.remove/);
    assert.doesNotMatch(auditLog, /correct horse/);
  } finally {
    await stopServer(child);
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
