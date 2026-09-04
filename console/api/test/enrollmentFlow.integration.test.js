import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, unlinkSync, existsSync } from "node:fs";
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

function startConsole(port, tempDir, extraEnv = {}) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: apiRoot,
    env: {
      ...process.env,
      DUNE_DOCKER_DIR: tempDir,
      ADMIN_BIND_PORT: String(port),
      ADMIN_PASSWORD: PASSWORD,
      ADMIN_SECURE_COOKIES: "0",
      CONSOLE_TOTP_ENABLED: "1", // exercise the Tier 3 flow (default is off)
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

function cookieFrom(res, name = "asc_session") {
  const entry = (res.headers.getSetCookie() || []).find((v) => v.startsWith(`${name}=`));
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

// TOTP is opt-in (issue #665): a plain password login no longer yields an
// enroll-scope session by itself. Login normally, then explicitly opt in via
// POST /api/auth/2fa/enable, which mints the same enroll-scope session
// (tier "enroll", scope "enroll") the old forced-login path used to mint
// automatically -- returns the raw fetch Response, matching what a caller of
// the old `api(port, "/api/auth/login", ...)` got back.
async function beginEnrollment(port, password = PASSWORD) {
  const login = await api(port, "/api/auth/login", { body: { password } });
  const loginBody = await login.json();
  return api(port, "/api/auth/2fa/enable", { cookie: cookieFrom(login), csrf: loginBody.csrfToken, body: { currentPassword: password } });
}

test("full enrollment: password login -> enroll -> TOTP login, with replay rejected", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "enroll-e2e-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);

    // 1. Fresh install: correct password logs in normally (TOTP is opt-in), then
    // the owner opts in from Settings -> an enrollment session, not a normal one.
    const login1 = await api(port, "/api/auth/login", { body: { password: PASSWORD } });
    assert.equal(login1.status, 200);
    assert.equal((await login1.clone().json()).authenticated, true, "plain login succeeds with no factor configured");
    const enable1 = await beginEnrollment(port);
    assert.equal(enable1.status, 200);
    const body1 = await enable1.json();
    assert.equal(body1.enrollmentRequired, true);
    assert.equal(body1.authenticated, undefined, "no normal session before enrollment completes");
    const enrollCookie = cookieFrom(enable1);
    const enrollCsrf = body1.csrfToken;
    assert.ok(enrollCookie && enrollCsrf);

    // 1b. /api/auth/state tells a reloaded page this is an enrollment session,
    //     not a signed-in one (review finding: the client rendered a console of
    //     403s otherwise).
    const state1 = await api(port, "/api/auth/state", { method: "GET", cookie: enrollCookie });
    assert.equal(state1.status, 200);
    const stateBody = await state1.json();
    assert.equal(stateBody.authenticated, true);
    assert.equal(stateBody.scope, "enroll", "/api/auth/state must expose the enrollment scope");

    // 2. The enrollment session is restricted -- a normal API is denied.
    const blocked = await api(port, "/api/auth/characters", { method: "GET", cookie: enrollCookie });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).enrollmentRequired, true);

    // 3. Setup: get the TOTP secret.
    const setup = await api(port, "/api/auth/2fa/setup", { cookie: enrollCookie, csrf: enrollCsrf });
    assert.equal(setup.status, 200);
    const { secret, otpauthUri, qrCodeDataUri } = await setup.json();
    assert.match(secret, /^[A-Z2-7]+$/);
    assert.match(otpauthUri, /^otpauth:\/\/totp\//);
    assert.match(qrCodeDataUri, /^data:image\/png;base64,/, "setup returns a renderable QR code for the setup screen");

    // 3b. A wrong code is rejected on confirm.
    const bad = await api(port, "/api/auth/2fa/confirm", { cookie: enrollCookie, csrf: enrollCsrf, body: { code: "000000" } });
    assert.equal(bad.status, 401);

    // 4. Confirm with the right code -> recovery codes shown once, session ended.
    const confirm = await api(port, "/api/auth/2fa/confirm", { cookie: enrollCookie, csrf: enrollCsrf, body: { code: codeFor(secret) } });
    assert.equal(confirm.status, 200);
    const confirmBody = await confirm.json();
    assert.equal(confirmBody.enrolled, true);
    assert.equal(confirmBody.recoveryCodes.length, 10);
    // the enrollment session is now invalid
    const afterConfirm = await api(port, "/api/auth/2fa/setup", { cookie: enrollCookie, csrf: enrollCsrf });
    assert.equal(afterConfirm.status, 403, "enrollment session is destroyed after confirm");

    // 5. Enrolled: password alone is not enough.
    const login2 = await api(port, "/api/auth/login", { body: { password: PASSWORD } });
    assert.equal(login2.status, 401);
    assert.equal((await login2.json()).totpRequired, true);

    // 5b. RFC §4: the code just used to CONFIRM enrollment cannot be reused at
    // the forced first login (its step is seeded as already-consumed).
    const confirmStepCode = codeFor(secret);
    const replayConfirm = await api(port, "/api/auth/login", { body: { password: PASSWORD, totpCode: confirmStepCode } });
    assert.equal(replayConfirm.status, 401, "the confirm-time code is rejected as a replay at first login");

    // 6. Password + the NEXT step's TOTP -> authenticated.
    const theCode = codeFor(secret, 1);
    const login3 = await api(port, "/api/auth/login", { body: { password: PASSWORD, totpCode: theCode } });
    assert.equal(login3.status, 200, "password + the next step's TOTP signs in");
    assert.equal((await login3.json()).authenticated, true);

    // 7. Replay: the SAME code cannot be reused within its step.
    const login4 = await api(port, "/api/auth/login", { body: { password: PASSWORD, totpCode: theCode } });
    assert.equal(login4.status, 401, "a TOTP code cannot be replayed");
    assert.equal((await login4.json()).totpRequired, true);
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("wrong password is rejected before any second-factor step", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "enroll-e2e-badpw-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const r = await api(port, "/api/auth/login", { body: { password: "wrong" } });
    assert.equal(r.status, 401);
    const b = await r.json();
    assert.equal(b.enrollmentRequired, undefined);
    assert.equal(b.totpRequired, undefined);
    assert.match(b.error, /Incorrect password/);
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the 2fa endpoints reject a request with no enrollment session", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "enroll-e2e-nosession-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    assert.equal((await api(port, "/api/auth/2fa/setup")).status, 403);
    assert.equal((await api(port, "/api/auth/2fa/confirm", { body: { code: "123456" } })).status, 403);
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("2fa/setup rejects a valid enrollment session that omits the CSRF token", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "enroll-e2e-csrf-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const enable = await beginEnrollment(port);
    const cookie = cookieFrom(enable);
    const csrf = (await enable.json()).csrfToken;
    // valid enroll cookie, NO csrf header -> rejected
    assert.equal((await api(port, "/api/auth/2fa/setup", { cookie })).status, 403);
    // with the csrf header -> accepted (proves the cookie itself is valid)
    assert.equal((await api(port, "/api/auth/2fa/setup", { cookie, csrf })).status, 200);
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("login fails closed (503, no session) when the second-factor state file is corrupt", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "enroll-e2e-corrupt-"));
  // plant a corrupt second-factor file before the server reads it on login
  const genDir = join(tempDir, "runtime", "generated");
  mkdirSync(genDir, { recursive: true });
  writeFileSync(join(genDir, "console-second-factor.json"), "{ not valid json", { mode: 0o600 });
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const res = await api(port, "/api/auth/login", { body: { password: PASSWORD } });
    assert.equal(res.status, 503, "corrupt 2FA state must fail closed, never grant a session");
    const body = await res.json();
    assert.equal(body.authenticated, undefined);
    assert.equal(body.enrollmentRequired, undefined);
    assert.ok(!cookieFrom(res), "no session cookie on the fail-closed path");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a second enrollment that loses the race gets 409 already_configured", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "enroll-e2e-race-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    // two independent enrollment sessions (no factor configured yet, so each
    // opt-in call yields its own enroll session)
    const la = await beginEnrollment(port);
    const ca = cookieFrom(la), sa = (await la.json()).csrfToken;
    const lb = await beginEnrollment(port);
    const cb = cookieFrom(lb), sb = (await lb.json()).csrfToken;

    const setupA = await (await api(port, "/api/auth/2fa/setup", { cookie: ca, csrf: sa })).json();
    const setupB = await (await api(port, "/api/auth/2fa/setup", { cookie: cb, csrf: sb })).json();

    // A enrolls first -> 200
    const confA = await api(port, "/api/auth/2fa/confirm", { cookie: ca, csrf: sa, body: { code: codeFor(setupA.secret) } });
    assert.equal(confA.status, 200);
    // B's confirm now loses -> 409, and B's session is ended
    const confB = await api(port, "/api/auth/2fa/confirm", { cookie: cb, csrf: sb, body: { code: codeFor(setupB.secret) } });
    assert.equal(confB.status, 409, "the losing enrollment gets already_configured");
    assert.equal((await api(port, "/api/auth/2fa/setup", { cookie: cb, csrf: sb })).status, 403, "loser's session is invalidated");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Requirement 0: with CONSOLE_TOTP_ENABLED unset, password login is unchanged single-factor", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "enroll-e2e-flagoff-"));
  const console = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "" }); // flag OFF
  try {
    await waitForHealth(port);
    const login = await api(port, "/api/auth/login", { body: { password: PASSWORD } });
    assert.equal(login.status, 200);
    const body = await login.json();
    assert.equal(body.authenticated, true, "flag off -> immediate single-factor session");
    assert.equal(body.enrollmentRequired, undefined);
    // and the enrollment endpoints are inert (no enroll session is ever issued)
    const cookie = cookieFrom(login);
    assert.equal((await api(port, "/api/auth/2fa/setup", { cookie })).status, 403);
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// The "broken upgrade" case: an operator enrolls on a newer console, then rolls
// the deployment back to an older one that cannot read the newer state format.
// The state is GOOD here -- the console is the thing that is behind -- so this
// must be distinguishable at the login surface from genuine corruption, and the
// message must never tell the operator to delete a file that holds their only
// second factor.
test("login on a console rolled back below the state's version says upgrade, never delete", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "enroll-e2e-version-"));
  const genDir = join(tempDir, "runtime", "generated");
  mkdirSync(genDir, { recursive: true });
  const statePath = join(genDir, "console-second-factor.json");
  writeFileSync(statePath, JSON.stringify({
    version: 99, epoch: 0,
    totp: { secret: Buffer.alloc(20).toString("base64"), lastUsedCounter: -1 },
    recoveryCodes: [],
  }), { mode: 0o600 });
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const res = await api(port, "/api/auth/login", { body: { password: PASSWORD } });
    assert.equal(res.status, 503, "a state file from a newer console must fail closed");
    assert.ok(!cookieFrom(res), "no session cookie on the fail-closed path");
    const { error } = await res.json();
    assert.match(error, /NEWER console version/, "the operator must be told the console is behind, not the state");
    assert.match(error, /upgrade the console/i);
    assert.doesNotMatch(error, /remove it to re-enroll/,
      "this message must never carry the corrupt-file 'delete it' remedy -- the state here is valid");
    assert.ok(existsSync(statePath), "the console must not have deleted or rewritten valid state");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// Break-glass, end to end over HTTP: the operator has lost the authenticator
// AND every recovery code, so they delete the state file on the host exactly as
// docs/console/two-factor-recovery.md instructs, and re-enroll. The watermark is
// a separate sibling file and deliberately survives -- the documented procedure
// says to leave it, because deleting it would reset rollback detection.
//
// The codes handed out by that re-enrollment must actually work. They are the
// operator's only remaining way back in the next time a device is lost, and
// nothing in normal operation would ever reveal that they had been dead on
// arrival.
test("break-glass: after deleting the state file, re-enrolled recovery codes actually work", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "enroll-e2e-breakglass-"));
  const statePath = join(tempDir, "runtime", "generated", "console-second-factor.json");
  const consoleProc = startConsole(port, tempDir);
  try {
    await waitForHealth(port);

    // Enroll, then spend one recovery code so the epoch and watermark advance.
    const l1 = await beginEnrollment(port);
    const c1 = cookieFrom(l1), s1 = (await l1.json()).csrfToken;
    const setup1 = await (await api(port, "/api/auth/2fa/setup", { cookie: c1, csrf: s1 })).json();
    const conf1 = await (await api(port, "/api/auth/2fa/confirm", { cookie: c1, csrf: s1, body: { code: codeFor(setup1.secret) } })).json();
    const spend = await api(port, "/api/auth/login", { body: { password: PASSWORD, recoveryCode: conf1.recoveryCodes[0] } });
    assert.equal(spend.status, 200, "the first recovery login should succeed");
    assert.ok(existsSync(`${statePath}.watermark`), "spending a code must have written a watermark");
  } finally {
    await stopProcess(consoleProc.child);
  }

  // Host-level break-glass: delete the state file only, leaving the watermark.
  unlinkSync(statePath);
  assert.ok(existsSync(`${statePath}.watermark`), "the documented procedure leaves the watermark in place");
  const watermark = JSON.parse(readFileSync(`${statePath}.watermark`, "utf8")).epoch;
  assert.ok(watermark > 0, "the surviving watermark is what makes this case non-trivial");

  const port2 = await getFreePort();
  const consoleProc2 = startConsole(port2, tempDir);
  try {
    await waitForHealth(port2);
    // Password login sees no factor -> a normal session (TOTP is opt-in, so a
    // deleted store does not force anything -- the operator chooses to
    // re-enroll from Settings, exactly like a fresh install).
    const l2 = await api(port2, "/api/auth/login", { body: { password: PASSWORD } });
    assert.equal((await l2.clone().json()).authenticated, true, "a deleted store logs in normally, not into forced enrollment");
    const enable2 = await beginEnrollment(port2);
    const body2 = await enable2.json();
    assert.equal(body2.enrollmentRequired, true, "opting in re-enrolls and issues a fresh code set");
    const c2 = cookieFrom(enable2), s2 = body2.csrfToken;
    const setup2 = await (await api(port2, "/api/auth/2fa/setup", { cookie: c2, csrf: s2 })).json();
    const conf2 = await (await api(port2, "/api/auth/2fa/confirm", { cookie: c2, csrf: s2, body: { code: codeFor(setup2.secret) } })).json();
    assert.equal(conf2.recoveryCodes.length, 10);

    // The moment that matters: one of those fresh codes must be accepted.
    const rescue = await api(port2, "/api/auth/login", { body: { password: PASSWORD, recoveryCode: conf2.recoveryCodes[0] } });
    const rescueBody = await rescue.json();
    assert.equal(rescue.status, 200,
      `break-glass codes were rejected (${JSON.stringify(rescueBody)}) -- the operator would be locked out with no remaining path in`);
    assert.notEqual(rescueBody.recoveryFailed, true);
  } finally {
    await stopProcess(consoleProc2.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("login with a literal null JSON body is a clean 401, never a 500", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "nullbody-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    // readJson() returns null for a literal `null` body; without the guard,
    // body.password threw a TypeError -> 500 leaking the internal error.
    const r = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "null",
    });
    assert.equal(r.status, 401, "a null body must be handled as a bad login, not crash into a 500");
  } finally { await stopProcess(console.child); rmSync(tempDir, { recursive: true, force: true }); }
});

test("one-time secret responses carry Cache-Control: no-store", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "nostore-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const enable = await beginEnrollment(port);
    const cookie = cookieFrom(enable);
    const csrf = (await enable.json()).csrfToken;

    const setup = await api(port, "/api/auth/2fa/setup", { cookie, csrf });
    assert.equal(setup.status, 200);
    assert.match(setup.headers.get("cache-control") || "", /no-store/, "the TOTP secret must not be cached");

    const { secret } = await setup.json();
    const confirm = await api(port, "/api/auth/2fa/confirm", { cookie, csrf, body: { code: codeFor(secret) } });
    assert.equal(confirm.status, 200, await confirm.clone().text());
    assert.match(confirm.headers.get("cache-control") || "", /no-store/, "the one-time recovery codes must not be cached");
  } finally { await stopProcess(console.child); rmSync(tempDir, { recursive: true, force: true }); }
});

test("POST /api/auth/2fa/confirm is rate-limited per session (review finding: unlimited TOTP guessing)", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "confirm-ratelimit-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const enable = await beginEnrollment(port);
    const enableBody = await enable.json();
    assert.equal(enableBody.enrollmentRequired, true);
    const cookie = cookieFrom(enable);
    const csrf = enableBody.csrfToken;
    assert.ok(cookie && csrf);

    const setup = await api(port, "/api/auth/2fa/setup", { cookie, csrf });
    assert.equal(setup.status, 200);

    let limited = null;
    for (let i = 0; i < 12; i += 1) {
      const attempt = await api(port, "/api/auth/2fa/confirm", { cookie, csrf, body: { code: "000000" } });
      if (attempt.status === 429) { limited = { at: i, retryAfter: attempt.headers.get("retry-after") }; break; }
      assert.equal(attempt.status, 401, `attempt ${i} should be a plain rejection, not ${attempt.status}`);
    }
    assert.ok(limited, "a 12-attempt burst of wrong codes against one enrollment session must be rate-limited");
    assert.ok(Number(limited.retryAfter) > 0, "429 must carry retry-after");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
