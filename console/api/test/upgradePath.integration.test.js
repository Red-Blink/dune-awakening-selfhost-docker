import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { base32Decode, totpCode, TOTP_PERIOD_SECONDS } from "../src/auth/totp.js";

// In-place upgrade tests (Requirement 0, gate  prereq 4, RFC §6 "Upgrade-path").
//
// Every other Tier 3 test boots a server against a FRESH state directory, which
// only ever exercises the fresh-install path. The distinguishing property of an
// upgrade is that the SAME state directory is carried across a code/config
// change -- so each test here starts a console the way an operator runs it
// today (single-factor password login, no TOTP state), stops it, and restarts
// it against that same directory with CONSOLE_TOTP_ENABLED=1. That restart IS
// the upgrade event, and it is the thing Requirement 0 says must be tested
// rather than assumed.

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const PASSWORD = "correct-horse-battery";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = createTcpServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

function startConsole(port, tempDir, extraEnv = {}) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: apiRoot,
    env: {
      ...process.env,
      DUNE_DOCKER_DIR: tempDir,
      ADMIN_BIND_PORT: String(port),
      ADMIN_PASSWORD: PASSWORD,
      ADMIN_SECURE_COOKIES: "0",
      ...extraEnv,
    },
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

function setCookieEntry(res, name = "asc_session") {
  return (res.headers.getSetCookie() || []).find((v) => v.startsWith(`${name}=`)) || null;
}

function cookieFrom(res, name = "asc_session") {
  const entry = setCookieEntry(res, name);
  return entry ? entry.split(";")[0].slice(name.length + 1) : null;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((r) => child.once("exit", r)),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
}

function api(port, path, { method = "POST", cookie, csrf, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = `asc_session=${cookie}`;
  if (csrf) headers["x-csrf-token"] = csrf;
  return fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
}

function codeFor(secretBase32, offsetSteps = 0) {
  const secret = base32Decode(secretBase32);
  return totpCode(secret, Math.floor(Date.now() / 1000) + offsetSteps * TOTP_PERIOD_SECONDS);
}

const secondFactorPath = (tempDir) => join(tempDir, "runtime", "generated", "console-second-factor.json");

// TOTP is opt-in (issue #665, RFC §4 revised): live-testing feedback from the
// upstream maintainer was that forcing enrollment with no opt-out is a real
// adoption blocker for a self-hosted admin tool. Flipping CONSOLE_TOTP_ENABLED
// on an EXISTING single-factor install must not, by itself, change how that
// operator logs in -- the flag only makes the feature available in Settings.
// Enrollment stays exactly as available and exactly as functional as before;
// only the trigger moved from automatic to owner-initiated.
test("in-place upgrade: an existing single-factor install keeps logging in with the password alone, and can opt into TOTP afterwards", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "upgrade-e2e-"));
  let running = null;
  try {
    // ---- Before the upgrade: the install an operator is actually running today.
    const portBefore = await getFreePort();
    running = startConsole(portBefore, tempDir, { CONSOLE_TOTP_ENABLED: "0" });
    await waitForHealth(portBefore);

    const legacyLogin = await api(portBefore, "/api/auth/login", { body: { password: PASSWORD } });
    assert.equal(legacyLogin.status, 200);
    const legacyBody = await legacyLogin.json();
    assert.equal(legacyBody.authenticated, true, "pre-upgrade: the password alone signs in");
    assert.equal(legacyBody.enrollmentRequired, undefined, "pre-upgrade: no enrollment is demanded");
    const legacyCookie = cookieFrom(legacyLogin);
    assert.ok(legacyCookie);

    // That session is a real, working session before the upgrade.
    assert.equal((await api(portBefore, "/api/auth/me", { method: "GET", cookie: legacyCookie })).status, 200);
    assert.equal(existsSync(secondFactorPath(tempDir)), false, "pre-upgrade: no second-factor state exists");

    await stopProcess(running.child);
    running = null;

    // ---- The upgrade: same state directory, flag now on.
    const portAfter = await getFreePort();
    running = startConsole(portAfter, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    await waitForHealth(portAfter);

    // Sessions are in-memory, so the pre-upgrade session does not survive the
    // restart regardless -- unrelated to the opt-in change, just a fact about
    // process restarts.
    const carriedOver = await api(portAfter, "/api/auth/me", { method: "GET", cookie: legacyCookie });
    assert.equal(carriedOver.status, 401, "the pre-upgrade session does not survive a restart");

    // The upgrade itself is invisible at the login surface: turning the flag on
    // with no factor configured logs the operator straight in, exactly as
    // before. This is the whole point of #665 -- no forced detour, no opt-out
    // to hunt for.
    const upgradeLogin = await api(portAfter, "/api/auth/login", { body: { password: PASSWORD } });
    assert.equal(upgradeLogin.status, 200);
    const upgradeBody = await upgradeLogin.json();
    assert.equal(upgradeBody.authenticated, true, "post-upgrade with the flag on: password alone still signs in");
    assert.equal(upgradeBody.enrollmentRequired, undefined, "post-upgrade: enrollment is never forced");
    const normalCookie = cookieFrom(upgradeLogin);
    const normalCsrf = upgradeBody.csrfToken;
    assert.ok(normalCookie && normalCsrf);
    // No restricted enrollment scope -- unlike the enroll session further down,
    // this is a normal session.
    const normalState = await api(portAfter, "/api/auth/state", { method: "GET", cookie: normalCookie });
    assert.equal((await normalState.json()).scope, null, "a plain post-upgrade login is a normal session, not an enrollment one");

    // The feature is available, though: the operator can opt in from Settings.
    const enableRes = await api(portAfter, "/api/auth/2fa/enable", { cookie: normalCookie, csrf: normalCsrf, body: { currentPassword: PASSWORD } });
    assert.equal(enableRes.status, 200);
    const enableBody = await enableRes.json();
    assert.equal(enableBody.enrollmentRequired, true, "opting in mints the same enroll-scope session the old forced path used to");
    const enrollCookie = cookieFrom(enableRes);
    const enrollCsrf = enableBody.csrfToken;
    assert.ok(enrollCookie && enrollCsrf);

    // The enrollment session reaches nothing but enrollment. /me and /logout are
    // the two deliberate exceptions (ENROLL_ALLOWED in server.js) so the frontend
    // can render the enrollment screen and the operator can always back out.
    const blocked = await api(portAfter, "/api/auth/characters", { method: "GET", cookie: enrollCookie });
    assert.equal(blocked.status, 403, "a real console route is denied to an enrollment session");
    assert.equal((await blocked.json()).enrollmentRequired, true);
    assert.equal((await api(portAfter, "/api/auth/me", { method: "GET", cookie: enrollCookie })).status, 200,
      "/me stays reachable during enrollment so the UI can render the enrollment state");

    // Enroll.
    const setup = await api(portAfter, "/api/auth/2fa/setup", { cookie: enrollCookie, csrf: enrollCsrf });
    assert.equal(setup.status, 200);
    const { secret } = await setup.json();
    const confirm = await api(portAfter, "/api/auth/2fa/confirm", { cookie: enrollCookie, csrf: enrollCsrf, body: { code: codeFor(secret) } });
    assert.equal(confirm.status, 200);
    const confirmBody = await confirm.json();
    assert.equal(confirmBody.enrolled, true);
    assert.equal(confirmBody.recoveryCodes.length, 10, "the operator is handed exactly 10 recovery codes, once");

    // Now that TOTP is actually configured, the password alone is no longer
    // enough -- this part of the RFC is unchanged, only how you get here moved.
    const passwordOnly = await api(portAfter, "/api/auth/login", { body: { password: PASSWORD } });
    assert.equal(passwordOnly.status, 401, "post-enrollment: the password alone is rejected");
    assert.equal((await passwordOnly.json()).totpRequired, true);

    const full = await api(portAfter, "/api/auth/login", { body: { password: PASSWORD, totpCode: codeFor(secret, 1) } });
    assert.equal(full.status, 200, "post-enrollment: password + TOTP signs in");
    assert.equal((await full.json()).authenticated, true);
  } finally {
    await stopProcess(running?.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("rollback: turning the flag back off on an enrolled install restores single-factor login and preserves the second-factor state", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "upgrade-e2e-rollback-"));
  let running = null;
  try {
    // Upgrade and enroll.
    const portOn = await getFreePort();
    running = startConsole(portOn, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    await waitForHealth(portOn);

    const login = await api(portOn, "/api/auth/login", { body: { password: PASSWORD } });
    const loginBody = await login.json();
    assert.equal(loginBody.authenticated, true, "TOTP is opt-in: plain login succeeds with no factor configured");
    const enableRes = await api(portOn, "/api/auth/2fa/enable", { cookie: cookieFrom(login), csrf: loginBody.csrfToken, body: { currentPassword: PASSWORD } });
    const body = await enableRes.json();
    assert.equal(body.enrollmentRequired, true);
    const setup = await api(portOn, "/api/auth/2fa/setup", { cookie: cookieFrom(enableRes), csrf: body.csrfToken });
    const { secret } = await setup.json();
    const confirm = await api(portOn, "/api/auth/2fa/confirm", { cookie: cookieFrom(enableRes), csrf: body.csrfToken, body: { code: codeFor(secret) } });
    assert.equal(confirm.status, 200);
    const stateBefore = readFileSync(secondFactorPath(tempDir), "utf8");

    await stopProcess(running.child);
    running = null;

    // ---- Roll the flag back off, same state directory.
    const portOff = await getFreePort();
    running = startConsole(portOff, tempDir, { CONSOLE_TOTP_ENABLED: "0" });
    await waitForHealth(portOff);

    const rolledBack = await api(portOff, "/api/auth/login", { body: { password: PASSWORD } });
    assert.equal(rolledBack.status, 200, "rollback: the password alone signs in again");
    assert.equal((await rolledBack.json()).authenticated, true);

    // The enrolled state is left intact, so flipping the flag on again does not
    // strand the operator in a re-enrollment they have no recovery codes for.
    assert.equal(readFileSync(secondFactorPath(tempDir), "utf8"), stateBefore,
      "rollback preserves the second-factor state byte-for-byte");
  } finally {
    await stopProcess(running?.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("upgrade path: the enrollment session is short-lived and non-renewable (RFC §4, 10 minutes)", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "upgrade-e2e-ttl-"));
  const running = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
  try {
    await waitForHealth(port);
    const login = await api(port, "/api/auth/login", { body: { password: PASSWORD } });
    const loginBody = await login.json();
    assert.equal(loginBody.authenticated, true, "TOTP is opt-in: plain login succeeds with no factor configured");
    const enableRes = await api(port, "/api/auth/2fa/enable", { cookie: cookieFrom(login), csrf: loginBody.csrfToken, body: { currentPassword: PASSWORD } });
    assert.equal((await enableRes.clone().json()).enrollmentRequired, true);

    const entry = setCookieEntry(enableRes);
    assert.ok(entry, "an enrollment session cookie is set");
    const maxAge = /max-age=(\d+)/i.exec(entry);
    assert.ok(maxAge, "the enrollment cookie carries an explicit Max-Age");
    assert.equal(Number(maxAge[1]), 600,
      "the enrollment session is capped at the RFC's 10 minutes, not the normal session lifetime");
  } finally {
    await stopProcess(running.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("upgrade path: an abandoned enrollment restarts with a REGENERATED secret, and the abandoned one cannot confirm", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "upgrade-e2e-interrupted-"));
  const running = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
  try {
    await waitForHealth(port);

    // Each "attempt" is a normal login (TOTP is opt-in) followed by opting in.
    async function beginEnrollment() {
      const login = await api(port, "/api/auth/login", { body: { password: PASSWORD } });
      const loginBody = await login.json();
      return api(port, "/api/auth/2fa/enable", { cookie: cookieFrom(login), csrf: loginBody.csrfToken, body: { currentPassword: PASSWORD } });
    }

    // First attempt: get a secret, then walk away without confirming.
    const first = await beginEnrollment();
    const firstBody = await first.json();
    const firstSetup = await api(port, "/api/auth/2fa/setup", { cookie: cookieFrom(first), csrf: firstBody.csrfToken });
    const { secret: abandonedSecret } = await firstSetup.json();

    // Second attempt: a fresh enrollment session -- nothing was ever confirmed,
    // so isConfigured() is still false and a second /2fa/enable call succeeds.
    const second = await beginEnrollment();
    const secondBody = await second.json();
    assert.equal(secondBody.enrollmentRequired, true, "an abandoned enrollment leaves no committed state");
    const secondCookie = cookieFrom(second);
    const secondSetup = await api(port, "/api/auth/2fa/setup", { cookie: secondCookie, csrf: secondBody.csrfToken });
    const { secret: liveSecret } = await secondSetup.json();

    assert.notEqual(liveSecret, abandonedSecret,
      "RFC §4: restarting enrollment regenerates the secret, so a stale authenticator entry cannot silently linger");

    // The abandoned secret's code must not confirm the live enrollment -- otherwise
    // an operator who scanned the first QR would end up with an entry that appears
    // to work and then stops.
    const wrong = await api(port, "/api/auth/2fa/confirm", { cookie: secondCookie, csrf: secondBody.csrfToken, body: { code: codeFor(abandonedSecret) } });
    assert.equal(wrong.status, 401, "a code from the abandoned secret cannot confirm the live enrollment");

    // The live secret does confirm.
    const right = await api(port, "/api/auth/2fa/confirm", { cookie: secondCookie, csrf: secondBody.csrfToken, body: { code: codeFor(liveSecret) } });
    assert.equal(right.status, 200);
    assert.equal((await right.json()).enrolled, true);
  } finally {
    await stopProcess(running.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
