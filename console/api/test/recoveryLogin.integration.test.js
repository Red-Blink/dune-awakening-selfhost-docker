import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { base32Decode, totpCode, TOTP_PERIOD_SECONDS } from "../src/auth/totp.js";

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

function cookieFrom(res, name = "asc_session") {
  const entry = (res.headers.getSetCookie() || []).find((v) => v.startsWith(`${name}=`));
  return entry ? entry.split(";")[0].slice(name.length + 1) : null;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 5000))]);
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

// Enroll a fresh authenticator and return { secret, recoveryCodes }.
//
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

test("recovery login: password + recovery code -> forced re-setup -> new TOTP + fresh codes", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-e2e-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const { secret: oldSecret, recoveryCodes } = await enrollFresh(port);
    assert.equal(recoveryCodes.length, 10);

    // Device lost: log in with password + a recovery code (NOT a TOTP code).
    const rec = await api(port, "/api/auth/login", { body: { password: PASSWORD, recoveryCode: recoveryCodes[2] } });
    assert.equal(rec.status, 200);
    const recBody = await rec.json();
    assert.equal(recBody.resetupRequired, true, "recovery login forces re-setup, not a normal session");
    assert.equal(recBody.authenticated, undefined);
    const cookie = cookieFrom(rec);
    const csrf = recBody.csrfToken;

    // The re-setup session is restricted like enrollment.
    assert.equal((await api(port, "/api/auth/characters", { method: "GET", cookie })).status, 403);

    // Re-set-up a new authenticator.
    const setup = await (await api(port, "/api/auth/2fa/setup", { cookie, csrf })).json();
    assert.notEqual(setup.secret, oldSecret, "a fresh TOTP secret is generated");
    const confirm = await api(port, "/api/auth/2fa/confirm", { cookie, csrf, body: { code: codeFor(setup.secret) } });
    assert.equal(confirm.status, 200);
    const confirmBody = await confirm.json();
    assert.equal(confirmBody.reconfigured, true);
    assert.equal(confirmBody.recoveryCodes.length, 10, "a fresh recovery-code set is issued");
    assert.notDeepEqual(confirmBody.recoveryCodes, recoveryCodes, "the old codes are replaced");

    // New TOTP works (next step -- the confirm-time code's step is consumed);
    // old recovery codes are all invalidated.
    const login = await api(port, "/api/auth/login", { body: { password: PASSWORD, totpCode: codeFor(setup.secret, 1) } });
    assert.equal(login.status, 200);
    assert.equal((await login.json()).authenticated, true);
    const oldCodeAttempt = await api(port, "/api/auth/login", { body: { password: PASSWORD, recoveryCode: recoveryCodes[5] } });
    assert.equal(oldCodeAttempt.status, 401, "a leftover old recovery code no longer works after re-setup");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a recovery code is single-use: the same code cannot be used twice", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-e2e-single-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const { recoveryCodes } = await enrollFresh(port);
    // First use consumes it (issues a re-setup session, which we abandon).
    const first = await api(port, "/api/auth/login", { body: { password: PASSWORD, recoveryCode: recoveryCodes[0] } });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).resetupRequired, true);
    // Second use of the SAME code is rejected.
    const second = await api(port, "/api/auth/login", { body: { password: PASSWORD, recoveryCode: recoveryCodes[0] } });
    assert.equal(second.status, 401);
    assert.equal((await second.json()).recoveryFailed, true);
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a recovery code substitutes for the TOTP factor ONLY, never the password", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-e2e-pw-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const { recoveryCodes } = await enrollFresh(port);
    // Wrong password + a valid recovery code -> rejected at the password check,
    // and the code is NOT consumed.
    const bad = await api(port, "/api/auth/login", { body: { password: "wrong", recoveryCode: recoveryCodes[0] } });
    assert.equal(bad.status, 401);
    assert.match((await bad.json()).error, /Incorrect password/);
    // The code is still usable (was not consumed by the wrong-password attempt).
    const ok = await api(port, "/api/auth/login", { body: { password: PASSWORD, recoveryCode: recoveryCodes[0] } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).resetupRequired, true);
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a malformed recovery code is rejected without a server error", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-e2e-malformed-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    await enrollFresh(port);
    const res = await api(port, "/api/auth/login", { body: { password: PASSWORD, recoveryCode: "not-a-real-code" } });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).recoveryFailed, true);
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("failed recovery-code attempts are rate-limited (recordFailure fires)", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-e2e-ratelimit-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    await enrollFresh(port);
    // Correct password + wrong recovery codes must be metered so recovery codes
    // can't be brute-forced: hammering eventually trips the 429 login limiter.
    let saw429 = false;
    for (let i = 0; i < 12; i++) {
      const r = await api(port, "/api/auth/login", { body: { password: PASSWORD, recoveryCode: `0000-0000-0000-0000-0000-0000-0000-0000-0${i}` } });
      if (r.status === 429) { saw429 = true; break; }
      assert.equal(r.status, 401, "each bad code is a 401 until the limiter trips");
    }
    assert.ok(saw429, "repeated bad recovery codes must eventually 429 -- the failure path calls recordFailure");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
