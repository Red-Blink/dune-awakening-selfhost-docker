import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getFreePort, startConsole, waitForHealth, stopProcess, api, login, cookieFrom,
  readGeneratedPassword, secondFactorPath, auditLogPath,
  currentTotpStep, nextTotpCode, enroll,
} from "../test-support/consoleHarness.js";

// TOTP as an owner-initiated, opt-in control (issue #665): live-testing
// feedback from the upstream maintainer was that forcing enrollment on every
// password login with no opt-out is a real adoption blocker. Enrollment moved
// from automatic-on-login to POST /api/auth/2fa/enable (Settings -> Two-Factor
// Authentication), and this file covers that route plus its counterpart,
// POST /api/auth/2fa/disable -- there is no point offering an opt-in with no
// way back out.
describe("TOTP opt-in: enable and disable", { concurrency: 4 }, () => {

  test("enabling requires an authenticated session and the current password", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "totp-optin-auth-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const password = readGeneratedPassword(tempDir);

      // No session at all.
      const noSession = await api(port, "/api/auth/2fa/enable", { body: { currentPassword: password } });
      assert.equal(noSession.status, 401);

      // Authenticated, but the wrong password.
      const session = await login(port, { password });
      assert.equal(session.body.authenticated, true);
      const wrongPassword = await api(port, "/api/auth/2fa/enable", {
        cookie: session.cookie, csrf: session.csrf, body: { currentPassword: "not-the-password" },
      });
      assert.equal(wrongPassword.status, 400);

      // Nothing was enrolled by either refusal.
      assert.equal(existsSync(secondFactorPath(tempDir)), false, "a refused enable call must not create second-factor state");
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("enabling is refused when the TOTP feature is off or admin auth is disabled", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "totp-optin-off-"));
    const consoleProc = startConsole(port, tempDir); // CONSOLE_TOTP_ENABLED unset -> off
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const password = readGeneratedPassword(tempDir);
      const session = await login(port, { password });
      assert.equal(session.body.authenticated, true, "with the flag off, password alone still logs in");

      const res = await api(port, "/api/auth/2fa/enable", {
        cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password },
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /not available/i);
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("a correct password mints an enrollment session that /2fa/setup and /2fa/confirm accept, and it is audited", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "totp-optin-happy-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const password = readGeneratedPassword(tempDir);
      const session = await login(port, { password });
      assert.equal(session.body.authenticated, true);

      const enableRes = await api(port, "/api/auth/2fa/enable", {
        cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password },
      });
      assert.equal(enableRes.status, 200);
      const enableBody = await enableRes.json();
      assert.equal(enableBody.enrollmentRequired, true);
      assert.ok(enableBody.csrfToken);
      const enrollCookie = cookieFrom(enableRes);
      assert.ok(enrollCookie && enrollCookie !== session.cookie, "enabling swaps in a fresh session, distinct from the one that requested it");

      // /api/auth/state reports this as an enrollment-scope session.
      const state = await api(port, "/api/auth/state", { method: "GET", cookie: enrollCookie });
      assert.equal((await state.json()).scope, "enroll");

      // The mechanics from here on are exactly the pre-existing, unchanged
      // /2fa/setup + /2fa/confirm flow.
      const setup = await api(port, "/api/auth/2fa/setup", { cookie: enrollCookie, csrf: enableBody.csrfToken });
      assert.equal(setup.status, 200);

      const auditLines = readFileSync(auditLogPath(tempDir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(
        auditLines.find((l) => l.action === "settings.totp-enable-started" && l.detail?.ok === true),
        "settings.totp-enable-started was audited"
      );
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // #690: an operator running several installs sees each in their
  // authenticator app as "My Server A", "My Server B", etc. instead of
  // several indistinguishable "Dune Docker Console" entries. Read live from
  // the .env FILE (readSetupConfigValues(), server.js), not process.env --
  // docker-compose.web.yml's environment: block is a fixed console-specific
  // allowlist that doesn't (and shouldn't) carry every operator-set
  // game-server value; an earlier version of this fix baked SERVER_TITLE
  // into boot-time config via process.env, which silently never reached the
  // container for exactly that reason (found live, on a real deployment).
  test("the QR code's issuer is the operator's SERVER_TITLE when set, read live from .env", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "totp-optin-issuer-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      writeFileSync(join(tempDir, ".env"), 'SERVER_TITLE="Arrakeen Test Server"\n');
      const password = readGeneratedPassword(tempDir);
      const session = await login(port, { password });

      const enableRes = await api(port, "/api/auth/2fa/enable", {
        cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password },
      });
      const enableBody = await enableRes.json();
      const enrollCookie = cookieFrom(enableRes);

      const setup = await api(port, "/api/auth/2fa/setup", { cookie: enrollCookie, csrf: enableBody.csrfToken });
      const setupBody = await setup.json();
      const decoded = decodeURIComponent(setupBody.otpauthUri);
      assert.ok(decoded.includes("Arrakeen Test Server"), `expected the operator's SERVER_TITLE as issuer, got: ${decoded}`);
      assert.ok(!decoded.includes("Dune Docker Console"), "the generic app name must not appear once SERVER_TITLE is set");
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("the QR code's issuer falls back to the generic app name when SERVER_TITLE isn't set", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "totp-optin-issuer-fallback-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const password = readGeneratedPassword(tempDir);
      const session = await login(port, { password });

      const enableRes = await api(port, "/api/auth/2fa/enable", {
        cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password },
      });
      const enableBody = await enableRes.json();
      const enrollCookie = cookieFrom(enableRes);

      const setup = await api(port, "/api/auth/2fa/setup", { cookie: enrollCookie, csrf: enableBody.csrfToken });
      const setupBody = await setup.json();
      const decoded = decodeURIComponent(setupBody.otpauthUri);
      assert.ok(decoded.includes("Dune Docker Console"), `expected the fallback app name with no SERVER_TITLE set, got: ${decoded}`);
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("enabling is refused with 409 once a factor is already configured", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "totp-optin-already-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const { password, secret, step: confirmStep } = await enroll(port, tempDir, { assert });
      const { code } = await nextTotpCode(secret, confirmStep);
      const session = await login(port, { password, totpCode: code });
      assert.equal(session.body.authenticated, true);

      const res = await api(port, "/api/auth/2fa/enable", {
        cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password },
      });
      assert.equal(res.status, 409);
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("disabling requires fresh password + TOTP proof, then password-only login works again and a sibling session is revoked", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "totp-optin-disable-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const { password, secret, step: confirmStep } = await enroll(port, tempDir, { assert });
      let step = confirmStep;
      const nextCode = async () => {
        const r = await nextTotpCode(secret, step);
        step = r.step;
        return r.code;
      };

      const actor = await login(port, { password, totpCode: await nextCode() });
      assert.equal(actor.body.authenticated, true);
      const sibling = await login(port, { password, totpCode: await nextCode() });
      assert.equal(sibling.body.authenticated, true);

      // Missing TOTP code -> refused, nothing changed.
      const noTotp = await api(port, "/api/auth/2fa/disable", {
        cookie: actor.cookie, csrf: actor.csrf, body: { currentPassword: password },
      });
      assert.equal(noTotp.status, 400);
      assert.equal((await noTotp.json()).totpRequired, true);
      assert.equal(existsSync(secondFactorPath(tempDir)), true, "a refused disable must not remove second-factor state");

      // Correct password + fresh TOTP -> disabled.
      const disableRes = await api(port, "/api/auth/2fa/disable", {
        cookie: actor.cookie, csrf: actor.csrf, body: { currentPassword: password, totpCode: await nextCode() },
      });
      assert.equal(disableRes.status, 200);
      const disableBody = await disableRes.json();
      assert.equal(disableBody.ok, true);
      assert.equal(existsSync(secondFactorPath(tempDir)), false, "disabling removes the second-factor state entirely");

      // The acting session survives (it just proved fresh credentials);
      // the sibling, which never re-proved anything, does not.
      const actorStill = await api(port, "/api/auth/state", { method: "GET", cookie: actor.cookie });
      assert.equal((await actorStill.json()).authenticated, true, "the acting session survives its own disable call");
      const siblingStill = await api(port, "/api/auth/state", { method: "GET", cookie: sibling.cookie });
      assert.equal((await siblingStill.json()).authenticated, false, "a sibling password/TOTP session is revoked when 2FA is disabled");

      // Password alone signs in again -- no more TOTP prompt.
      const after = await api(port, "/api/auth/login", { body: { password } });
      assert.equal(after.status, 200);
      assert.equal((await after.json()).authenticated, true, "password-only login works again once 2FA is disabled");

      const auditLines = readFileSync(auditLogPath(tempDir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.ok(auditLines.find((l) => l.action === "settings.totp-disabled" && l.detail?.ok === true), "settings.totp-disabled was audited");
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("disabling is refused (400) when nothing is enrolled yet", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "totp-optin-disable-noop-"));
    const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const password = readGeneratedPassword(tempDir);
      const session = await login(port, { password });
      assert.equal(session.body.authenticated, true);

      const res = await api(port, "/api/auth/2fa/disable", {
        cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password, totpCode: "000000" },
      });
      assert.equal(res.status, 400);
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
