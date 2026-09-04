import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getFreePort, startConsole, waitForHealth, stopProcess, api, login, cookieFrom,
  readGeneratedPassword, secondFactorPath, auditLogPath,
  codeForStep, currentTotpStep, nextTotpCode, enroll,
} from "../test-support/consoleHarness.js";

const REGENERATE_PATH = "/api/auth/2fa/recovery-codes/regenerate";

// Hands out successive TOTP codes, tracking the last step the server consumed so
// each hop takes the free one-step look-ahead when one is available and sleeps
// only when it is not. Chaining the step through here -- rather than
// re-reading the clock between hops -- is also what closes the original flake:
// a re-read can land below the consumed step and hand back an already-spent code.
function totpChain(secret, startStep) {
  let consumed = startStep;
  return async () => {
    const { code, step } = await nextTotpCode(secret, consumed);
    consumed = step;
    return code;
  };
}

// Run concurrently, bounded. Each test owns its port, temp dir and
// console process, so there is no shared state -- and the file was the suite's
// critical path at ~10 minutes, almost all of it idle TOTP waits.
//
// This is only safe because the timing is now deterministic: nextTotpCode
// targets an ABSOLUTE step derived from the last consumed one and re-reads the
// clock after any wait, so CPU contention can delay a hop but cannot hand back
// a code for an already-spent step. The earlier fixed-sleep harness had no such
// guarantee, which is why concurrency would have been reckless there.
describe("recovery-code regeneration", { concurrency: 4 }, () => {

  test("regenerating recovery codes with password + fresh TOTP issues a new set, invalidates the old one, audits, and revokes no sessions", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const { password, secret, enrollmentCodes, step: confirmStep } = await enroll(port, tempDir, { assert });
      const nextCode = totpChain(secret, confirmStep);
      const before = JSON.parse(readFileSync(secondFactorPath(tempDir), "utf8"));
      let step = confirmStep;

      // Two live password/TOTP sessions: the actor and a sibling. Each normal
      // login consumes a step, so each needs a genuinely fresh one.
      const actor = await login(port, { password, totpCode: await nextCode() });
      assert.equal(actor.body.authenticated, true);

      const sibling = await login(port, { password, totpCode: await nextCode() });
      assert.equal(sibling.body.authenticated, true);

      const res = await api(port, REGENERATE_PATH, {
        cookie: actor.cookie,
        csrf: actor.csrf,
        body: { currentPassword: password, totpCode: await nextCode() },
      });
      assert.equal(res.status, 200);
      const parsed = await res.json();
      assert.equal(parsed.ok, true);
      assert.equal(parsed.recoveryCodes.length, 10, "a full fresh set is returned once");
      for (const code of parsed.recoveryCodes) {
        assert.ok(!enrollmentCodes.includes(code), "no code from the enrollment set is reissued");
      }

      // Compared against the pre-rotation state. `length === 10` was a
      // tautology -- it holds identically before and after, so it could not tell
      // "rotated" from "untouched" -- and the comment above it claimed a check on
      // the TOTP secret that nothing actually performed.
      const state = JSON.parse(readFileSync(secondFactorPath(tempDir), "utf8"));
      assert.equal(state.totp.secret, before.totp.secret, "the TOTP secret is untouched -- this rotates recovery codes only");
      // The counter legitimately advances: every verification consumes a step
      // and persists it, which IS the replay protection. It must never go
      // backwards, though -- that would re-open an already-spent step.
      assert.ok(state.totp.lastUsedCounter >= before.totp.lastUsedCounter, "the TOTP replay counter never moves backwards");
      assert.notDeepStrictEqual(state.recoveryCodes, before.recoveryCodes, "the stored digests were actually replaced");
      assert.equal(state.recoveryCodes.length, 10, "with a full fresh set");

      // Unlike password rotation (RFC §2.3/§5), regenerating recovery codes is
      // not a rotation of the login credential and revokes no sibling session.
      const siblingStill = await api(port, "/api/auth/state", { method: "GET", cookie: sibling.cookie });
      assert.equal((await siblingStill.json()).authenticated, true, "the sibling password/TOTP session survives");

      const auditLines = readFileSync(auditLogPath(tempDir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(
        auditLines.find((l) => l.action === "settings.recovery-codes-regenerated"),
        "settings.recovery-codes-regenerated was written to the audit log"
      );

      // An old code is dead: recovery login with it is rejected. (Recovery login
      // uses password + code and consumes no TOTP step, so this needs no wait.)
      const oldCode = await login(port, { password, recoveryCode: enrollmentCodes[0] });
      assert.equal(oldCode.status, 401, "an invalidated recovery code is rejected as bad credentials, not merely non-200");
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("regeneration requires the current password AND a fresh TOTP code, and changes nothing on failure", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-proof-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const { password, secret, enrollmentCodes, step: confirmStep } = await enroll(port, tempDir, { assert });
      const nextCode = totpChain(secret, confirmStep);
      const before = JSON.parse(readFileSync(secondFactorPath(tempDir), "utf8"));

      const actor = await login(port, { password, totpCode: await nextCode() });
      assert.equal(actor.body.authenticated, true);

      // No TOTP code at all -> refused, and told which factor is missing.
      const noTotp = await api(port, REGENERATE_PATH, {
        cookie: actor.cookie, csrf: actor.csrf, body: { currentPassword: password },
      });
      assert.equal(noTotp.status, 400);
      assert.equal((await noTotp.json()).totpRequired, true);

      // Wrong password (with a valid code) -> refused.
      const wrongPassword = await api(port, REGENERATE_PATH, {
        cookie: actor.cookie, csrf: actor.csrf, body: { currentPassword: "not-the-password", totpCode: await nextCode() },
      });
      assert.equal(wrongPassword.status, 400);

      // Neither failure touched the stored set: the enrollment codes still work.
      const state = JSON.parse(readFileSync(secondFactorPath(tempDir), "utf8"));
      // "intact" means the same digests, not merely ten of them.
      assert.deepStrictEqual(state.recoveryCodes, before.recoveryCodes, "a refused regeneration leaves the stored set byte-identical");
      const recovery = await login(port, { password, recoveryCode: enrollmentCodes[0] });
      assert.equal(recovery.status, 200, "an original recovery code still works after refused regeneration attempts");
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Containment regression: /api/auth/2fa/setup and /confirm ARE reachable from a
  // restricted setup-scope session (they are in ENROLL_ALLOWED); this third
  // /api/auth/2fa/* path deliberately is NOT. Asserted explicitly so nobody
  // pattern-matches "all 2fa routes are enrollment routes" and adds it to that
  // allowlist -- which would let a re-setup session mint codes and stop there.
  test("a restricted enrollment-scope session cannot reach the regenerate route", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-scope-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const password = readGeneratedPassword(tempDir);
      // TOTP is opt-in (issue #665): plain login is now a normal session, so an
      // enroll-scope session must be requested explicitly via /api/auth/2fa/enable.
      const normal = await login(port, { password });
      assert.equal(normal.body.authenticated, true);
      const enableRes = await api(port, "/api/auth/2fa/enable", { cookie: normal.cookie, csrf: normal.csrf, body: { currentPassword: password } });
      const enableBody = await enableRes.json();
      assert.equal(enableBody.enrollmentRequired, true);
      const enrollSession = { cookie: cookieFrom(enableRes), csrf: enableBody.csrfToken };

      const res = await api(port, REGENERATE_PATH, {
        cookie: enrollSession.cookie, csrf: enrollSession.csrf, body: { currentPassword: password, totpCode: "000000" },
      });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).enrollmentRequired, true);
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("regeneration is refused when two-factor is not enabled on this console", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-off-"));
    const consoleProc = startConsole(port, tempDir);
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const password = readGeneratedPassword(tempDir);
      const session = await login(port, { password });
      assert.equal(session.body.authenticated, true, "with the flag off, password alone logs in");

      const res = await api(port, REGENERATE_PATH, {
        cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password },
      });
      assert.equal(res.status, 400);
      const parsed = await res.json();
      assert.ok(parsed.error, "the refusal explains itself rather than 404ing");
      assert.equal(parsed.ok, undefined, "no success payload accompanies a refusal");
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // The settings UI drives its "this credential action needs an authenticator
  // code" branching off this flag. Tested here rather than in a ninth
  // copy of this harness ( item 1) because it gates the same Tier 3
  // credential surface these tests already stand up.
  test("/api/auth/me reports secondFactorEnrolled:false before enrollment and true after", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-flag-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const { password, secret, step: confirmStep } = await enroll(port, tempDir, { assert });
      const nextCode = totpChain(secret, confirmStep);

      const session = await login(port, { password, totpCode: await nextCode() });
      assert.equal(session.body.authenticated, true);

      const me = await (await api(port, "/api/auth/me", { method: "GET", cookie: session.cookie })).json();
      assert.equal(me.secondFactorEnrolled, true, "an enrolled console reports the flag");
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("/api/auth/me reports secondFactorEnrolled:false when the TOTP flag is off", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-flag-off-"));
    const consoleProc = startConsole(port, tempDir);
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const password = readGeneratedPassword(tempDir);
      const session = await login(port, { password });
      assert.equal(session.body.authenticated, true);

      const me = await (await api(port, "/api/auth/me", { method: "GET", cookie: session.cookie })).json();
      assert.equal(me.secondFactorEnrolled, false, "never asks the UI for a code the server would ignore");
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ---- the route's own authentication, independent of registration order ----

  // Every other test in this file supplies a cookie + CSRF token, so nothing
  // pinned that the route needs a session AT ALL. Its only protection used to be
  // its physical position below the central gate; moving the registration line
  // made it answer unauthenticated POSTs with live recovery codes while this
  // whole file stayed green. These two assert the guarantee directly.
  test("the regenerate route rejects a request with no session cookie", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-nocookie-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const { password, secret, step } = await enroll(port, tempDir, { assert });
      const nextCode = totpChain(secret, step);

      const res = await api(port, REGENERATE_PATH, {
        body: { currentPassword: password, totpCode: await nextCode() },
      });
      assert.equal(res.status, 401, "no cookie must not reach the handler's credential check");

      const state = JSON.parse(readFileSync(secondFactorPath(tempDir), "utf8"));
      assert.equal(state.recoveryCodes.length, 10, "an unauthenticated attempt changes nothing");
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("the regenerate route rejects an authenticated request with no CSRF token", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-nocsrf-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const { password, secret, step: confirmStep } = await enroll(port, tempDir, { assert });
      const nextCode = totpChain(secret, confirmStep);
      const actor = await login(port, { password, totpCode: await nextCode() });
      assert.equal(actor.body.authenticated, true);

      const res = await api(port, REGENERATE_PATH, {
        cookie: actor.cookie, // deliberately no csrf
        body: { currentPassword: password, totpCode: await nextCode() },
      });
      assert.equal(res.status, 403, "a valid cookie without a CSRF token is refused");
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ---- the TOTP verification branch ----

  // Deleting verifyTotpToken and its guard used to leave this whole file green:
  // no test ever submitted a CORRECT password with a BAD code, so the verifier's
  // failure path was never reached. Both cases below do.
  test("regeneration is refused for a wrong authenticator code and for a replayed one", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-totpfail-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const { password, secret, enrollmentCodes, step: confirmStep } = await enroll(port, tempDir, { assert });
      const nextCode = totpChain(secret, confirmStep);
      const actor = await login(port, { password, totpCode: await nextCode() });
      assert.equal(actor.body.authenticated, true);

      // Correct password, DEFINITELY wrong code -- derived from the real one so
      // it can never coincidentally be valid, unlike a hardcoded "000000".
      const real = await nextCode();
      const wrong = String((Number(real[0]) + 1) % 10) + real.slice(1);
      const badCode = await api(port, REGENERATE_PATH, {
        cookie: actor.cookie, csrf: actor.csrf,
        body: { currentPassword: password, totpCode: wrong },
      });
      assert.equal(badCode.status, 400);
      assert.equal((await badCode.json()).totpRequired, true, "a wrong code is a second-factor failure, not a password failure");

      // The same code twice: the second attempt is a replay and must be refused
      // even though the code was valid moments earlier.
      const fresh = await nextCode();
      const first = await api(port, REGENERATE_PATH, {
        cookie: actor.cookie, csrf: actor.csrf,
        body: { currentPassword: password, totpCode: fresh },
      });
      assert.equal(first.status, 200, "the first use of a fresh code succeeds");
      const replay = await api(port, REGENERATE_PATH, {
        cookie: actor.cookie, csrf: actor.csrf,
        body: { currentPassword: password, totpCode: fresh },
      });
      assert.equal(replay.status, 400, "the same code cannot be spent twice");
      assert.equal((await replay.json()).totpRequired, true);

      // The refused attempts changed nothing beyond the one successful rotation.
      const recovery = await login(port, { password, recoveryCode: enrollmentCodes[0] });
      assert.notEqual(recovery.status, 200, "the enrollment set was replaced by the one successful call");
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("regeneration fails closed (503) when the second-factor state file is corrupt", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-corrupt-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const { password, secret, step: confirmStep } = await enroll(port, tempDir, { assert });
      const nextCode = totpChain(secret, confirmStep);
      const actor = await login(port, { password, totpCode: await nextCode() });
      assert.equal(actor.body.authenticated, true);

      // A corrupt file must never read as "no second factor configured" -- that
      // would be a 2FA bypass, which secondFactorStore.js warns about explicitly.
      writeFileSync(secondFactorPath(tempDir), "{ not valid json", { mode: 0o600 });
      const res = await api(port, REGENERATE_PATH, {
        cookie: actor.cookie, csrf: actor.csrf,
        body: { currentPassword: password, totpCode: "123456" },
      });
      assert.equal(res.status, 503, "an unreadable store fails closed, it does not fall through to 400/200");

      const auditLines = readFileSync(auditLogPath(tempDir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const failure = auditLines.find((l) => l.action === "settings.recovery-codes-regenerated" && l.detail?.ok === false);
      assert.ok(failure, "the fail-closed path is audited, not silent");
      assert.equal(failure.detail.reason, "second_factor_unavailable");
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ---- regeneration heals a detected rollback ----

  // The console's own startup banner and recovery-login error tell the operator to
  // "regenerate recovery codes from Settings" after a rollback is detected. Before
  // this fix, doing exactly that returned 10 codes into a still-poisoned state and
  // the first one used was wiped unread -- the remedy was a trap.
  test("regenerating after a restored-backup rollback issues codes that actually work", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-heal-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const { password, secret, enrollmentCodes, step: confirmStep } = await enroll(port, tempDir, { assert });
      const nextCode = totpChain(secret, confirmStep);
      const filePath = secondFactorPath(tempDir);
      const preConsumption = readFileSync(filePath, "utf8");
      assert.equal(JSON.parse(preConsumption).epoch, 0);

      // Spend a code for real: epoch and watermark both advance to 1.
      const spend = await login(port, { password, recoveryCode: enrollmentCodes[0] });
      assert.equal(spend.status, 200);
      assert.equal(JSON.parse(readFileSync(filePath, "utf8")).epoch, 1);

      // Restore the main store alone, leaving the watermark at 1 -- the exact
      // single-file-restore case  exists to catch. State epoch is now 0 < 1.
      writeFileSync(filePath, preConsumption, { mode: 0o600 });

      const actor = await login(port, { password, totpCode: await nextCode() });
      assert.equal(actor.body.authenticated, true, "TOTP login is unaffected by a rollback");

      const res = await api(port, REGENERATE_PATH, {
        cookie: actor.cookie, csrf: actor.csrf,
        body: { currentPassword: password, totpCode: await nextCode() },
      });
      assert.equal(res.status, 200);
      const newCodes = (await res.json()).recoveryCodes;
      assert.equal(newCodes.length, 10);

      // The healing itself: epoch must now be ABOVE the watermark, not merely
      // one greater than a stale value.
      assert.ok(JSON.parse(readFileSync(filePath, "utf8")).epoch > 1, "regeneration lifts the epoch past the watermark");

      // The real assertion: a brand-new code logs in instead of being wiped unread.
      const useNew = await login(port, { password, recoveryCode: newCodes[0] });
      assert.equal(useNew.status, 200, "a freshly regenerated code works after a healed rollback");
      assert.notEqual(
        JSON.parse(readFileSync(filePath, "utf8")).recoveryCodes.length, 0,
        "the set was consumed normally, not wiped as a rollback"
      );
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ---- hardening ----

  test("every refusal is audited with a reason and an actor, and a malformed body is a 400 not a 500", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-audit-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const { password, secret, step: confirmStep } = await enroll(port, tempDir, { assert });
      const nextCode = totpChain(secret, confirmStep);
      const actor = await login(port, { password, totpCode: await nextCode() });
      assert.equal(actor.body.authenticated, true);

      // A malformed (non-object) body -- an array. (A literal `null` used to
      // dereference to a 500; readJsonBody now normalizes null to `{}` at the
      // source, so an array is the remaining "malformed" shape the guard catches.)
      const malformed = await fetch(`http://127.0.0.1:${port}${REGENERATE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `asc_session=${actor.cookie}`, "x-csrf-token": actor.csrf },
        body: "[]",
      });
      assert.equal(malformed.status, 400, "a malformed body is a client error, not a server error");
      assert.ok(!/Cannot read properties/.test((await malformed.json()).error), "no internal JS error text reaches the client");

      const badPw = await api(port, REGENERATE_PATH, {
        cookie: actor.cookie, csrf: actor.csrf,
        body: { currentPassword: "not-the-password", totpCode: "123456" },
      });
      assert.equal(badPw.status, 400);

      const lines = readFileSync(auditLogPath(tempDir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const failures = lines.filter((l) => l.action === "settings.recovery-codes-regenerated" && l.detail?.ok === false);
      assert.ok(failures.length >= 2, "refusals are audited, not silent -- an unaudited route cannot distinguish 'nobody tried' from 'someone tried 500 times'");
      assert.ok(failures.some((l) => l.detail.reason === "malformed_body"));
      assert.ok(failures.some((l) => l.detail.reason === "bad_password"));
      for (const line of failures) {
        assert.ok(line.detail.userId, "each audited refusal names the acting principal");
        assert.ok(line.detail.tier, "each audited refusal names the acting tier");
      }
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("a successful regeneration records healedRollback and forbids caching of the codes", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-heal-audit-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const { password, secret, step: confirmStep } = await enroll(port, tempDir, { assert });
      const nextCode = totpChain(secret, confirmStep);
      const actor = await login(port, { password, totpCode: await nextCode() });

      const res = await api(port, REGENERATE_PATH, {
        cookie: actor.cookie, csrf: actor.csrf,
        body: { currentPassword: password, totpCode: await nextCode() },
      });
      assert.equal(res.status, 200);
      // The one plaintext copy of a bearer credential must not be storable by any
      // proxy or browser cache in the path.
      assert.match(res.headers.get("cache-control") || "", /no-store/);

      const lines = readFileSync(auditLogPath(tempDir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const ok = lines.find((l) => l.action === "settings.recovery-codes-regenerated" && l.detail?.ok === true);
      assert.ok(ok, "the success is audited");
      assert.equal(ok.detail.count, 10);
      assert.equal(ok.detail.healedRollback, false, "a routine rotation is distinguishable from the rollback remedy");
      assert.ok(ok.detail.userId, "the success names the acting principal");
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // The reason the credential-proof limiter is a separate bucket: exhausting it
  // from an authenticated session must not lock the operator out of /api/auth/login,
  // which is the only route back in.
  test("exhausting the credential-proof limiter does not block sign-in", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-limiter-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const { password, secret, step: confirmStep } = await enroll(port, tempDir, { assert });
      const nextCode = totpChain(secret, confirmStep);
      const actor = await login(port, { password, totpCode: await nextCode() });
      assert.equal(actor.body.authenticated, true);

      let sawBlock = false;
      for (let i = 0; i < 12; i++) {
        const res = await api(port, REGENERATE_PATH, {
          cookie: actor.cookie, csrf: actor.csrf,
          body: { currentPassword: "wrong-password", totpCode: "123456" },
        });
        if (res.status === 429) { sawBlock = true; break; }
      }
      assert.ok(sawBlock, "the credential-proof route is still throttled");

      const stillIn = await login(port, { password, totpCode: await nextCode() });
      assert.equal(stillIn.body.authenticated, true, "sign-in survives an exhausted credential-proof bucket");
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Pins requireFreshTier3Proof's `requireEnrolled` parameter -- the one real
  // behavioural difference between the two credential routes. Password
  // rotation skips TOTP when no factor exists (nothing to prove yet); this
  // route has nothing to regenerate and must refuse.
  //
  // Reached the way an operator actually reaches it: enroll, keep the session
  // live, then perform the RFC 3.4 host reset that deletes the second-factor
  // state out from under it. A mutation flipping the flag to false left the
  // whole file green before this existed.
  test("regeneration refuses when the flag is on but the factor was cleared under a live session", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-cleared-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const { password, secret, step: confirmStep } = await enroll(port, tempDir, { assert });
      const nextCode = totpChain(secret, confirmStep);
      const actor = await login(port, { password, totpCode: await nextCode() });
      assert.equal(actor.body.authenticated, true);

      // The documented total-loss reset (RFC 3.4), performed while a normal
      // password/TOTP session is still live.
      rmSync(secondFactorPath(tempDir), { force: true });

      const res = await api(port, REGENERATE_PATH, {
        cookie: actor.cookie, csrf: actor.csrf,
        body: { currentPassword: password, totpCode: "123456" },
      });
      assert.equal(res.status, 400, "no factor means nothing to regenerate -- refuse, do not skip the second factor");
      assert.match((await res.json()).error, /No second factor is set up/);

      const lines = readFileSync(auditLogPath(tempDir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const refusal = lines.find((l) => l.action === "settings.recovery-codes-regenerated" && l.detail?.reason === "not_configured");
      assert.ok(refusal, "the refusal is audited with its reason, not silent");
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 's whole point was that /me distinguishes "unknown" from "not enrolled".
  // Until now only the CLIENT side was tested, against a mocked API -- so the
  // server never actually had to emit the flag. Found while mutation-testing
  // 's rename of the local that shadowed the 503 helper: breaking the wire
  // field left every suite green.
  test("/api/auth/me reports secondFactorUnavailable when the store is unreadable", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "recovery-regen-e2e-unavail-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const { password, secret, step: confirmStep } = await enroll(port, tempDir, { assert });
      const nextCode = totpChain(secret, confirmStep);
      const actor = await login(port, { password, totpCode: await nextCode() });
      assert.equal(actor.body.authenticated, true);

      writeFileSync(secondFactorPath(tempDir), "{ not valid json", { mode: 0o600 });

      const me = await (await api(port, "/api/auth/me", { method: "GET", cookie: actor.cookie })).json();
      assert.equal(me.secondFactorUnavailable, true, "an unreadable store is reported as unknown");
      assert.equal(me.secondFactorEnrolled, false, "and never as enrolled -- the store contract is fail-closed");
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
