import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { base32Decode, totpCode, TOTP_PERIOD_SECONDS } from "../src/auth/totp.js";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const NEW_PASSWORD = "New-Correct-Horse-9!Battery";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = createTcpServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

// The password-rotation route (POST /api/settings/admin-password) refuses to
// run at all when ADMIN_PASSWORD is env-managed -- so, unlike the other auth
// integration tests, this file must NOT set ADMIN_PASSWORD and instead read
// the console's own auto-generated initial password off disk after boot.
function startConsole(port, tempDir, extraEnv = {}) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: apiRoot,
    env: { ...process.env, DUNE_DOCKER_DIR: tempDir, ADMIN_BIND_PORT: String(port), ADMIN_SECURE_COOKIES: "0", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  return { child, logs: () => logs };
}

function readGeneratedPassword(tempDir) {
  return readFileSync(join(tempDir, "runtime", "secrets", "admin-web-password.txt"), "utf8").trim();
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

async function login(port, password) {
  const res = await api(port, "/api/auth/login", { body: { password } });
  const body = await res.json();
  return { status: res.status, cookie: cookieFrom(res), csrf: body.csrfToken, body };
}

// TOTP is opt-in (issue #665): a plain login no longer yields an enroll-scope
// session by itself. Login normally, then opt in via POST /api/auth/2fa/enable,
// which mints the same enroll-scope session the old forced-login path used to.
async function beginEnrollment(port, password) {
  const normal = await login(port, password);
  const res = await api(port, "/api/auth/2fa/enable", { cookie: normal.cookie, csrf: normal.csrf, body: { currentPassword: password } });
  const body = await res.json();
  return { status: res.status, cookie: cookieFrom(res), csrf: body.csrfToken, body };
}

function codeFor(secretBase32, offsetSteps = 0) {
  return totpCode(base32Decode(secretBase32), Math.floor(Date.now() / 1000) + offsetSteps * TOTP_PERIOD_SECONDS);
}

function currentTotpStep(period = TOTP_PERIOD_SECONDS) {
  return Math.floor(Date.now() / 1000 / period);
}

// A fixed sleep (e.g. "1.5 periods") is racy under CPU contention: a delayed
// wake-up, or a delayed request after waking, can land the freshly-computed
// code on an already-consumed or now-too-late step (reproduced as real,
// intermittent CI failures). Poll the real step counter itself instead --
// this returns only once real wall-clock time has genuinely advanced past
// `step` (the step the caller's last TOTP action actually consumed), so a
// code generated with offset 0 right after is always for a fresh step,
// regardless of how long the wait took.
async function waitForStepAfter(step) {
  while (currentTotpStep() <= step) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

test("rotating the password revokes other password sessions but keeps the acting one", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "pw-rotation-e2e-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const password = readGeneratedPassword(tempDir);
    const sessionA = await login(port, password);
    const sessionB = await login(port, password);
    assert.equal(sessionA.status, 200);
    assert.equal(sessionB.status, 200);

    const rotate = await api(port, "/api/settings/admin-password", {
      cookie: sessionA.cookie,
      csrf: sessionA.csrf,
      body: { currentPassword: password, newPassword: NEW_PASSWORD },
    });
    assert.equal(rotate.status, 200);
    const rotateBody = await rotate.json();
    assert.equal(rotateBody.sessionsRevoked, 1, "exactly the sibling session B is revoked");

    // Session A (the rotating session) still works.
    const stillA = await api(port, "/api/auth/state", { method: "GET", cookie: sessionA.cookie });
    assert.equal((await stillA.json()).authenticated, true);

    // Session B is dead.
    const deadB = await api(port, "/api/auth/state", { method: "GET", cookie: sessionB.cookie });
    assert.equal((await deadB.json()).authenticated, false);

    // The old password no longer works; the new one does.
    const oldLogin = await login(port, password);
    assert.equal(oldLogin.status, 401);
    const newLogin = await login(port, NEW_PASSWORD);
    assert.equal(newLogin.status, 200);
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("rotating the password requires the current password", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "pw-rotation-e2e-badpw-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const password = readGeneratedPassword(tempDir);
    const session = await login(port, password);
    const rotate = await api(port, "/api/settings/admin-password", {
      cookie: session.cookie,
      csrf: session.csrf,
      body: { currentPassword: "wrong", newPassword: NEW_PASSWORD },
    });
    assert.equal(rotate.status, 400);
    // The old password still works -- the rotation never applied.
    const stillOld = await login(port, password);
    assert.equal(stillOld.status, 200);
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("repeated failed rotation attempts are rate-limited, like the login route", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "pw-rotation-e2e-ratelimit-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const password = readGeneratedPassword(tempDir);
    const session = await login(port, password);
    let lastStatus;
    // The login limiter's default is 8 attempts/key before a 15-minute block;
    // fire one more than that with a wrong current password.
    for (let i = 0; i < 9; i++) {
      const rotate = await api(port, "/api/settings/admin-password", {
        cookie: session.cookie,
        csrf: session.csrf,
        body: { currentPassword: "wrong", newPassword: NEW_PASSWORD },
      });
      lastStatus = rotate.status;
    }
    assert.equal(lastStatus, 429, "the 9th consecutive failed attempt is rate-limited, not just rejected");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("rotating the password requires fresh TOTP proof when TOTP is enrolled, and does not revoke sessions on failure", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "pw-rotation-e2e-totp-"));
  const console = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
  try {
    await waitForHealth(port);
    const password = readGeneratedPassword(tempDir);
    const firstLogin = await beginEnrollment(port, password);
    const setup = await (await api(port, "/api/auth/2fa/setup", { cookie: firstLogin.cookie, csrf: firstLogin.csrf })).json();
    let step = currentTotpStep();
    const confirm = await api(port, "/api/auth/2fa/confirm", { cookie: firstLogin.cookie, csrf: firstLogin.csrf, body: { code: codeFor(setup.secret, 0) } });
    assert.equal(confirm.status, 200);

    // Normal password+TOTP login, twice -- two live sessions. TOTP's own ±1-step
    // verification window only ever accepts a step strictly greater than the
    // last one consumed, so each of these waits for a genuinely new step
    // (tracked explicitly, not guessed via a fixed sleep) before generating and
    // sending the next code.
    await waitForStepAfter(step);
    step = currentTotpStep();
    const sessionA = await api(port, "/api/auth/login", { body: { password, totpCode: codeFor(setup.secret, 0) } });
    const sessionACookie = cookieFrom(sessionA);
    const sessionABody = await sessionA.json();
    assert.equal(sessionABody.authenticated, true);

    await waitForStepAfter(step);
    step = currentTotpStep();
    const sessionB = await api(port, "/api/auth/login", { body: { password, totpCode: codeFor(setup.secret, 0) } });
    const sessionBCookie = cookieFrom(sessionB);
    assert.equal((await sessionB.json()).authenticated, true);

    // Rotation with the correct current password but NO totpCode is rejected,
    // and revokes nothing. Doesn't consume a TOTP step.
    const noTotp = await api(port, "/api/settings/admin-password", {
      cookie: sessionACookie,
      csrf: sessionABody.csrfToken,
      body: { currentPassword: password, newPassword: NEW_PASSWORD },
    });
    assert.equal(noTotp.status, 400);
    assert.equal((await noTotp.json()).totpRequired, true);
    const stillB1 = await api(port, "/api/auth/state", { method: "GET", cookie: sessionBCookie });
    assert.equal((await stillB1.json()).authenticated, true, "a failed rotation attempt revokes nothing");

    // Rotation with the correct current password AND a fresh TOTP code succeeds
    // and revokes the sibling session.
    await waitForStepAfter(step);
    const withTotp = await api(port, "/api/settings/admin-password", {
      cookie: sessionACookie,
      csrf: sessionABody.csrfToken,
      body: { currentPassword: password, newPassword: NEW_PASSWORD, totpCode: codeFor(setup.secret, 0) },
    });
    assert.equal(withTotp.status, 200);
    const stillB2 = await api(port, "/api/auth/state", { method: "GET", cookie: sessionBCookie });
    assert.equal((await stillB2.json()).authenticated, false, "the sibling session is revoked once rotation succeeds");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("rotation fails closed (503) and revokes nothing when the second-factor state file is corrupt", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "pw-rotation-e2e-corrupt-"));
  const console = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
  try {
    await waitForHealth(port);
    const password = readGeneratedPassword(tempDir);
    const firstLogin = await beginEnrollment(port, password);
    const setup = await (await api(port, "/api/auth/2fa/setup", { cookie: firstLogin.cookie, csrf: firstLogin.csrf })).json();
    const confirm = await api(port, "/api/auth/2fa/confirm", { cookie: firstLogin.cookie, csrf: firstLogin.csrf, body: { code: codeFor(setup.secret, 0) } });
    assert.equal(confirm.status, 200);

    await waitForStepAfter(currentTotpStep());
    const normalLogin = await api(port, "/api/auth/login", { body: { password, totpCode: codeFor(setup.secret, 0) } });
    const normalBody = await normalLogin.json();
    assert.equal(normalBody.authenticated, true);
    const cookie = cookieFrom(normalLogin);

    // Corrupt the second-factor file the running server reads from, in place.
    const stateFile = join(tempDir, "runtime", "generated", "console-second-factor.json");
    writeFileSync(stateFile, "{ not valid json", { mode: 0o600 });

    const rotate = await api(port, "/api/settings/admin-password", {
      cookie,
      csrf: normalBody.csrfToken,
      body: { currentPassword: password, newPassword: NEW_PASSWORD, totpCode: "000000" },
    });
    assert.equal(rotate.status, 503, "corrupt 2FA state must fail closed, never allow rotation");
    assert.equal(readGeneratedPassword(tempDir), password, "adminPasswordFile is untouched by the failed rotation");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

//  extracted the shared credential-proof preamble so rotation and
// regeneration would behave identically, and stopped at this caller's edges --
// the three pre-proof refusals audited nothing, while the sibling route routed
// the equivalent cases through its own deny(). An operator diffing the audit log
// after a credential-stuffing suspicion saw every attempt against one route and
// none against the other.
test("pre-proof refusals on the rotation route are audited with a reason and an actor", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "pw-rotation-e2e-audit-"));
  const consoleProc = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const password = readGeneratedPassword(tempDir);
    const session = await login(port, password);
    assert.equal(session.status, 200);

    // A malformed (non-object) body -- an array -- is rejected before the
    // credential proof runs. (A literal `null` is normalized to `{}` at the
    // source in readJsonBody, so it is no longer "malformed"; an array still is.)
    const malformed = await fetch(`http://127.0.0.1:${port}/api/settings/admin-password`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `asc_session=${session.cookie}`, "x-csrf-token": session.csrf },
      body: "[]",
    });
    assert.equal(malformed.status, 400);

    const auditPath = join(tempDir, "runtime", "generated", "web-admin-audit.jsonl");
    const lines = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const refusal = lines.find((l) => l.action === "settings.change-admin-password" && l.detail?.ok === false);
    assert.ok(refusal, "a pre-proof refusal is audited, not silent");
    assert.equal(refusal.detail.reason, "malformed_body");
    assert.ok(refusal.detail.userId, "the refusal names the acting principal");
    // Sanitized path, never req.url verbatim.
    assert.equal(refusal.path, "/api/settings/admin-password");
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// the SUCCESS-path audits passed raw `req`, so audit() wrote
// req.url verbatim -- query string included -- while redactValue only inspects
// `detail`. Added after a mutation pass showed reverting that fix left the file
// green: the refusal-path test above pins the sanitized path, the success path
// had nothing.
test("a successful rotation audits a sanitized path, not req.url with its query string", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "pw-rotation-e2e-sanitize-"));
  const consoleProc = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const password = readGeneratedPassword(tempDir);
    const session = await login(port, password);

    // Routing matches on url.pathname, so a query string is accepted normally --
    // which is exactly how a credential pasted into one reaches the audit log.
    const res = await fetch(`http://127.0.0.1:${port}/api/settings/admin-password?leak=SUPERSECRET`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `asc_session=${session.cookie}`, "x-csrf-token": session.csrf },
      body: JSON.stringify({ currentPassword: password, newPassword: NEW_PASSWORD }),
    });
    assert.equal(res.status, 200);

    const auditPath = join(tempDir, "runtime", "generated", "web-admin-audit.jsonl");
    const raw = readFileSync(auditPath, "utf8");
    assert.ok(!raw.includes("SUPERSECRET"), "no query-string content reaches the audit log at all");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
    for (const action of ["settings.change-admin-password", "auth.password-changed.sessions-revoked"]) {
      const row = lines.find((l) => l.action === action && l.detail?.ok !== false);
      assert.ok(row, `${action} was audited`);
      assert.equal(row.path, "/api/settings/admin-password", `${action} records the sanitized path`);
    }
  } finally {
    await stopProcess(consoleProc.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
