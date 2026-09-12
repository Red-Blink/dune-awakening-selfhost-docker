import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { waitForLog } from "../test-support/consoleHarness.js";

import { base32Decode, totpCode, TOTP_PERIOD_SECONDS } from "../src/auth/totp.js";

// Issue , end to end through the real login route: a recovery code that
// looks valid again only because its backing file was restored to an older
// state must be rejected, wipe the entire (now-untrustworthy) code set, and
// be visible in the audit log under its own event name -- not just covered
// at the secondFactorStore.js unit level.

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const PASSWORD = "correct-horse-battery";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = createTcpServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

function startConsole(port, tempDir) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: apiRoot,
    env: { ...process.env, DUNE_DOCKER_DIR: tempDir, ADMIN_BIND_PORT: String(port), ADMIN_PASSWORD: PASSWORD, ADMIN_SECURE_COOKIES: "0", CONSOLE_TOTP_ENABLED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  return { child, logs: () => logs };
}

async function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("console did not become healthy in time");
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 5000))]);
}

function cookieFrom(res, name = "asc_session") {
  const entry = (res.headers.getSetCookie() || []).find((v) => v.startsWith(`${name}=`));
  return entry ? entry.split(";")[0].slice(name.length + 1) : null;
}

function api(port, path, { method = "POST", cookie, csrf, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = `asc_session=${cookie}`;
  if (csrf) headers["x-csrf-token"] = csrf;
  return fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
}

function codeFor(secretBase32, offsetSteps = 0) {
  return totpCode(base32Decode(secretBase32), Math.floor(Date.now() / 1000) + offsetSteps * TOTP_PERIOD_SECONDS);
}

// TOTP is opt-in (issue #665): a plain login no longer yields an enroll-scope
// session by itself. Login normally, then opt in via POST /api/auth/2fa/enable.
async function enrollFresh(port) {
  const login = await api(port, "/api/auth/login", { body: { password: PASSWORD } });
  const loginBody = await login.json();
  const enable = await api(port, "/api/auth/2fa/enable", { cookie: cookieFrom(login), csrf: loginBody.csrfToken, body: { currentPassword: PASSWORD } });
  const cookie = cookieFrom(enable);
  const csrf = (await enable.json()).csrfToken;
  const setup = await (await api(port, "/api/auth/2fa/setup", { cookie, csrf })).json();
  const confirm = await api(port, "/api/auth/2fa/confirm", { cookie, csrf, body: { code: codeFor(setup.secret) } });
  const body = await confirm.json();
  return { secret: setup.secret, recoveryCodes: body.recoveryCodes };
}

function secondFactorFilePath(tempDir) {
  return join(tempDir, "runtime", "generated", "console-second-factor.json");
}

function auditLogPath(tempDir) {
  return join(tempDir, "runtime", "generated", "web-admin-audit.jsonl");
}

test("restoring the second-factor file to a pre-consumption state: the next recovery code is rejected, the whole set is wiped, and it's audited distinctly", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "restore-detect-e2e-"));
  const consoleProc = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const { recoveryCodes } = await enrollFresh(port);
    assert.equal(recoveryCodes.length, 10);

    const filePath = secondFactorFilePath(tempDir);
    const preConsumptionState = readFileSync(filePath, "utf8");
    assert.equal(JSON.parse(preConsumptionState).epoch, 0, "epoch 0 immediately after enrollment");

    // Spend one code for real. This bumps epoch to 1 and the watermark to 1,
    // and forces the resetup flow (unrelated to this test -- ignored below).
    const spend = await api(port, "/api/auth/login", { body: { password: PASSWORD, recoveryCode: recoveryCodes[0] } });
    assert.equal(spend.status, 200);
    assert.equal((await spend.json()).resetupRequired, true);
    assert.equal(JSON.parse(readFileSync(filePath, "utf8")).epoch, 1);

    // Simulate a restore: an operator or backup tool replaces the file with
    // its pre-consumption content. The watermark file is untouched and still
    // says 1 -- exactly the scenario this feature targets (see the module
    // header in secondFactorStore.js for what it does and doesn't catch).
    writeFileSync(filePath, preConsumptionState, { mode: 0o600 });
    assert.equal(JSON.parse(readFileSync(filePath, "utf8")).recoveryCodes.length, 10, "the restored file shows all 10 codes as unused again");

    // A DIFFERENT code from the original set -- one that really was never
    // spent -- is still rejected. The whole set is untrustworthy, not just
    // the resurrected one.
    const afterRestore = await api(port, "/api/auth/login", { body: { password: PASSWORD, recoveryCode: recoveryCodes[1] } });
    assert.equal(afterRestore.status, 401);
    const afterRestoreBody = await afterRestore.json();
    assert.equal(afterRestoreBody.recoveryFailed, true);
    assert.match(afterRestoreBody.error, /restored from an older backup/);

    // The store wiped the set rather than accept or plain-reject.
    assert.equal(JSON.parse(readFileSync(filePath, "utf8")).recoveryCodes.length, 0);

    // The distinct audit event landed, not just a generic auth.login failure.
    const auditLines = readFileSync(auditLogPath(tempDir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const resetEvent = auditLines.find((l) => l.action === "auth.second-factor-reset-detected");
    assert.ok(resetEvent, "auth.second-factor-reset-detected was written to the audit log");
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a stale-looking file at boot logs an informational warning without blocking startup", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "restore-detect-boot-"));
  let consoleProc = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const { secret, recoveryCodes } = await enrollFresh(port);
    const filePath = secondFactorFilePath(tempDir);
    const preConsumptionState = readFileSync(filePath, "utf8");

    const spend = await api(port, "/api/auth/login", { body: { password: PASSWORD, recoveryCode: recoveryCodes[0] } });
    assert.equal(spend.status, 200);

    // Restore the pre-consumption content, then start a genuinely FRESH
    // process against it -- this exercises checkForRollback()'s one-shot,
    // read-only boot check, distinct from the mutating check inside
    // consumeRecoveryCode() the test above exercises.
    await stopProcess(consoleProc.child);
    writeFileSync(filePath, preConsumptionState, { mode: 0o600 });
    consoleProc = startConsole(port, tempDir);
    await waitForHealth(port);

    // Poll rather than assert immediately: /api/health answering does not mean
    // the startup banner has been flushed and delivered to our stdout handler.
    assert.ok(
      await waitForLog(consoleProc.logs, /second-factor state file appears older/),
      `the informational banner is logged at boot. Console output:\n${consoleProc.logs()}`
    );

    // Confirms the check is genuinely non-blocking: TOTP login (unaffected by
    // this mechanism by design) still works against the restored file, using
    // the ORIGINAL enrollment secret since the restored content predates the
    // resetup the earlier spend would otherwise have triggered. offsetSteps:1
    // guarantees a step past the one already consumed during enrollment
    // confirm (both happen within the same real-time window otherwise).
    const login = await api(port, "/api/auth/login", { body: { password: PASSWORD, totpCode: codeFor(secret, 1) } });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).authenticated, true);
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
