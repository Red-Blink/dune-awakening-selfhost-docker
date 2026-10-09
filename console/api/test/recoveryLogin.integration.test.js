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

// Regression test for the exact sequence Red-Blink reported on upstream PR
// #201 (2026-09-06): two outstanding recovery sessions, opened with two
// different recovery codes, both complete "confirm" -- the first legitimately
// replaces the authenticator, and the second (now stale) must NOT be able to
// silently overwrite it. Before the fix both confirms returned 200 and the
// first replacement authenticator stopped working; a resurrected/older
// session effectively "won" by confirming last.
test("a second recovery code is rejected once one is already pending, and the old authenticator is dead in the meantime", async () => {
  // Rewritten for the atomic-invalidation fix (review finding, upstream PR
  // #201, 2026-09-08): the OLD version of this test opened two resetup
  // sessions from two different recovery codes and only caught the second at
  // commit() time (stale_generation). That whole scenario is now
  // structurally impossible -- the first successful recovery-code
  // consumption wipes every sibling code atomically, so a second code is
  // rejected immediately, never mints a session at all. This test covers
  // both halves of the RFC's atomic-invalidation promise Red-Blink's report
  // named directly: sibling-code rejection, and the old TOTP being dead for
  // normal login during the pending window (not just after commit()).
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-e2e-concurrent-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const { secret: oldSecret, recoveryCodes } = await enrollFresh(port);

    const recA = await api(port, "/api/auth/login", { body: { password: PASSWORD, recoveryCode: recoveryCodes[0] } });
    assert.equal(recA.status, 200);
    const recABody = await recA.json();
    assert.equal(recABody.resetupRequired, true);
    const cookieA = cookieFrom(recA);
    const csrfA = recABody.csrfToken;

    // A DIFFERENT, still-unused sibling code must be rejected outright --
    // Red-Blink's exact repro: "another recovery code can create a second
    // resetup session."
    const recB = await api(port, "/api/auth/login", { body: { password: PASSWORD, recoveryCode: recoveryCodes[1] } });
    assert.equal(recB.status, 401, "a sibling recovery code must be rejected once a recovery is already pending");
    const recBBody = await recB.json();
    assert.equal(recBBody.resetupRequired, undefined, "no second resetup session may be minted");
    assert.equal(cookieFrom(recB), null, "no session cookie may be issued for the rejected sibling code");

    // The OLD authenticator's TOTP must also be dead for normal login RIGHT
    // NOW -- before session A ever confirms a replacement -- not just after.
    // Red-Blink's exact repro: "the old authenticator can still perform a
    // normal login during recovery."
    const loginWithOldMidRecovery = await api(port, "/api/auth/login", { body: { password: PASSWORD, totpCode: codeFor(oldSecret) } });
    assert.notEqual(loginWithOldMidRecovery.status, 200, "the old authenticator must not log in normally while a recovery is pending");

    // Session A completes its replacement -- the legitimate path.
    const setupA = await (await api(port, "/api/auth/2fa/setup", { cookie: cookieA, csrf: csrfA })).json();
    const confirmA = await api(port, "/api/auth/2fa/confirm", { cookie: cookieA, csrf: csrfA, body: { code: codeFor(setupA.secret) } });
    assert.equal(confirmA.status, 200, "the recovery session must succeed");
    const confirmABody = await confirmA.json();
    assert.equal(confirmABody.reconfigured, true);

    // The new authenticator works...
    const loginWithA = await api(port, "/api/auth/login", { body: { password: PASSWORD, totpCode: codeFor(setupA.secret, 1) } });
    assert.equal(loginWithA.status, 200);
    assert.equal((await loginWithA.json()).authenticated, true);

    // ...and the old one is still dead afterward too (different code path --
    // "invalid" now that a real, different secret is live, rather than
    // "recovery_pending" -- but still never a login).
    const loginWithOldAfter = await api(port, "/api/auth/login", { body: { password: PASSWORD, totpCode: codeFor(oldSecret) } });
    assert.notEqual(loginWithOldAfter.status, 200, "the old authenticator must not work after replacement either");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// #578 review finding: requireFreshTier3Proof (password rotation, recovery-
// code regeneration, TOTP enable/disable) only special-cased a "replay"
// verify.reason -- a "recovery_pending" result (reachable via a standing
// session that logged in BEFORE a recovery started, then tries the old
// authenticator code DURING the pending window) fell through to the generic
// "check your device's clock" message, sending the operator toward a futile
// troubleshooting path instead of the actual situation.
test("a standing session's own credential-proof actions report the accurate mid-recovery message, not a clock-skew one", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-e2e-standing-session-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const { secret: oldSecret, recoveryCodes } = await enrollFresh(port);

    // A normal, already-authenticated session, logged in BEFORE any recovery
    // starts -- unaffected by consumeRecoveryCode(), which only mints a new
    // resetup session for its own caller. Offset 1: offset 0 was already
    // consumed by enrollFresh()'s own /2fa/confirm call and would replay.
    const standing = await api(port, "/api/auth/login", { body: { password: PASSWORD, totpCode: codeFor(oldSecret, 1) } });
    assert.equal(standing.status, 200);
    const standingCookie = cookieFrom(standing);
    const standingCsrf = (await standing.json()).csrfToken;

    // A different actor starts a recovery, wiping every sibling code and
    // marking the factor recovery-pending.
    const rec = await api(port, "/api/auth/login", { body: { password: PASSWORD, recoveryCode: recoveryCodes[0] } });
    assert.equal(rec.status, 200);

    // The standing session tries a credential-proof action (recovery-code
    // regeneration -- admin-password rotation isn't usable here, this file's
    // own startConsole() sets ADMIN_PASSWORD, which refuses rotation outright
    // before ever reaching requireFreshTier3Proof) using the OLD, still-known
    // authenticator code -- requireFreshTier3Proof's verifyTotpToken() call
    // now returns reason "recovery_pending".
    const regenerate = await api(port, "/api/auth/2fa/recovery-codes/regenerate", {
      cookie: standingCookie, csrf: standingCsrf,
      body: { currentPassword: PASSWORD, totpCode: codeFor(oldSecret, 1) },
    });
    assert.equal(regenerate.status, 400);
    const regenerateBody = await regenerate.json();
    assert.match(regenerateBody.error, /mid-recovery/i, "must name the actual situation, not a clock-skew message");
    assert.doesNotMatch(regenerateBody.error, /clock/i, "must not send the operator troubleshooting a clock problem they don't have");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the recovery-pending state persists across a process restart", async () => {
  // Red-Blink explicitly asked for this: the atomic invalidation must be a
  // real, persisted store write, not in-memory-only state a restart would
  // silently lose (which would resurrect the old TOTP secret and let a
  // second sibling code succeed again).
  const port1 = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-e2e-restart-"));
  let running = startConsole(port1, tempDir);
  try {
    await waitForHealth(port1);
    const { secret: oldSecret, recoveryCodes } = await enrollFresh(port1);

    const rec = await api(port1, "/api/auth/login", { body: { password: PASSWORD, recoveryCode: recoveryCodes[0] } });
    assert.equal(rec.status, 200);

    await stopProcess(running.child);
    running = null;

    const port2 = await getFreePort();
    running = startConsole(port2, tempDir);
    await waitForHealth(port2);

    // After the restart, on a fresh in-memory session store: the old
    // authenticator is still dead...
    const loginWithOld = await api(port2, "/api/auth/login", { body: { password: PASSWORD, totpCode: codeFor(oldSecret) } });
    assert.notEqual(loginWithOld.status, 200, "recovery-pending must survive a restart, not reset to a working old authenticator");

    // ...and a second sibling code is still rejected.
    const recB = await api(port2, "/api/auth/login", { body: { password: PASSWORD, recoveryCode: recoveryCodes[1] } });
    assert.equal(recB.status, 401, "sibling-code rejection must survive a restart too");
  } finally {
    await stopProcess(running.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a normal session created BEFORE recovery re-setup is revoked once the re-setup completes", async () => {
  // The resetup half of Red-Blink's session-lifecycle report (review
  // finding, upstream PR #201, 2026-09-08) -- the enrollment half is covered
  // in enrollmentFlow.integration.test.js.
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "recovery-e2e-session-revoke-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const { secret, recoveryCodes } = await enrollFresh(port);

    // A normal, already-authenticated session using the real (soon-to-be-
    // replaced) authenticator -- e.g. a different browser tab, present
    // before the recovery flow even starts. Offset by one step: enrollFresh()
    // already consumed the current step's code to confirm enrollment, and
    // replay prevention forbids reusing it (same reasoning as the offset used
    // elsewhere in this suite after a confirm).
    const preLogin = await api(port, "/api/auth/login", { body: { password: PASSWORD, totpCode: codeFor(secret, 1) } });
    assert.equal(preLogin.status, 200);
    const preCookie = cookieFrom(preLogin);
    const meBefore = await api(port, "/api/auth/me", { method: "GET", cookie: preCookie });
    assert.equal(meBefore.status, 200, "the pre-recovery session must be genuinely valid before this test proceeds");

    // A separate recovery-code login opens a resetup session and completes
    // authenticator replacement, entirely independent of the cookie above.
    const rec = await api(port, "/api/auth/login", { body: { password: PASSWORD, recoveryCode: recoveryCodes[0] } });
    assert.equal(rec.status, 200);
    const recBody = await rec.json();
    const resetupCookie = cookieFrom(rec);
    const setup = await (await api(port, "/api/auth/2fa/setup", { cookie: resetupCookie, csrf: recBody.csrfToken })).json();
    const confirm = await api(port, "/api/auth/2fa/confirm", { cookie: resetupCookie, csrf: recBody.csrfToken, body: { code: codeFor(setup.secret) } });
    assert.equal(confirm.status, 200);
    assert.equal((await confirm.json()).reconfigured, true);

    // The cookie from BEFORE the recovery must now be dead -- this is
    // exactly the attack Red-Blink described: a session hijacked before the
    // operator noticed and recovered must not survive the recovery.
    const meAfter = await api(port, "/api/auth/me", { method: "GET", cookie: preCookie });
    assert.equal(meAfter.status, 401, "a session that predates the authenticator replacement must not survive it");
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
