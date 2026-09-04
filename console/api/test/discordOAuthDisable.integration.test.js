import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getFreePort, startConsole, waitForHealth, stopProcess, api, login,
  readGeneratedPassword, auditLogPath,
} from "../test-support/consoleHarness.js";

// #676 §6 (Tier 1 -> 3 removal) and §7 (the zero-2FA guard). Real Eight Hats
// Layer 1 findings this suite regression-pins (design doc
// docs/design/auth-settings-consolidation-l1-design-2026-09-03.md):
//   - DBA CRITICAL: "Forget this configuration entirely" must delete the
//     Client Secret FILE (runtime/secrets/discord-oauth-client-secret.txt),
//     not just clear .env keys -- it is not an .env key at all.
//   - Software Architect HIGH: discordOAuthAppConfigured is a SECOND gating
//     boolean disable must also cover, not just discordOAuthConfigured.
//   - Security Architect HIGH: the zero-2FA guard must be enforced by the
//     disable route ITSELF, not just a guided-flow UI nudge, since this same
//     route is reachable directly from the always-available fallback section.
//   - GRC CRITICAL: disable/enable/forget must each produce their own,
//     distinguishable audit log entry.
const DISCORD_ENV = {
  DISCORD_OAUTH_CLIENT_ID: "123456789012345678",
  DISCORD_OAUTH_CLIENT_SECRET: "shh-its-a-secret",
  DISCORD_OAUTH_REDIRECT_URI: "https://console.example.org/api/auth/discord/callback",
  DISCORD_HOME_GUILD_ID: "111111111111111111",
  DISCORD_CONSOLE_ADMIN_ROLE_IDS: "400000000000000002",
};

function readAuditEntries(tempDir) {
  if (!existsSync(auditLogPath(tempDir))) return [];
  return readFileSync(auditLogPath(tempDir), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// readSetupConfigValues() (used by the forget route's own pre-wipe audit
// logging) reads .env the FILE directly -- it is not process.env. DISCORD_ENV
// above is passed as literal process env vars (the simplest way to make
// config.discordOAuthConfigured true at boot for most of this suite), which
// never actually populates .env on its own. Tests exercising anything that
// reads the FILE (the "leaves every other key untouched" and "recoverable"
// assertions) must pre-seed it explicitly, mirroring what a real deployment's
// own docker-compose env_file (or the wizard writing it directly) would have
// already done before such an install ever reached this state.
function writeDiscordEnvFile(tempDir) {
  writeFileSync(join(tempDir, ".env"), [
    `DISCORD_OAUTH_CLIENT_ID=${DISCORD_ENV.DISCORD_OAUTH_CLIENT_ID}`,
    `DISCORD_OAUTH_REDIRECT_URI="${DISCORD_ENV.DISCORD_OAUTH_REDIRECT_URI}"`,
    `DISCORD_HOME_GUILD_ID=${DISCORD_ENV.DISCORD_HOME_GUILD_ID}`,
    `DISCORD_CONSOLE_ADMIN_ROLE_IDS=${DISCORD_ENV.DISCORD_CONSOLE_ADMIN_ROLE_IDS}`,
  ].join("\n") + "\n");
}

describe("Discord OAuth disable / enable / forget (#676 §6)", { concurrency: 4 }, () => {
  test("disable requires an authenticated session and the current password", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "discord-disable-auth-"));
    const consoleProc = startConsole(port, tempDir, DISCORD_ENV);
    try {
      await waitForHealth(port, 20000, consoleProc.logs);

      const noSession = await api(port, "/api/settings/discord-oauth/disable", { body: {} });
      assert.equal(noSession.status, 401);

      const password = readGeneratedPassword(tempDir);
      const session = await login(port, { password });
      assert.equal(session.body.authenticated, true);

      const wrongPassword = await api(port, "/api/settings/discord-oauth/disable", {
        cookie: session.cookie, csrf: session.csrf, body: { currentPassword: "not-the-password" },
      });
      assert.equal(wrongPassword.status, 400);

      // Nothing was disabled by the refusal.
      const state = await (await api(port, "/api/auth/state", { method: "GET" })).json();
      assert.equal(state.config.discordOAuthConfigured, true);
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("disable refuses when Discord OAuth is not configured", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "discord-disable-unconfigured-"));
    const consoleProc = startConsole(port, tempDir, {});
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const password = readGeneratedPassword(tempDir);
      const session = await login(port, { password });

      const res = await api(port, "/api/settings/discord-oauth/disable", {
        cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password },
      });
      assert.equal(res.status, 400);
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("disable sets DISCORD_OAUTH_DISABLED=1, leaves every other .env key untouched, and produces its own audit entry", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "discord-disable-fields-"));
    writeDiscordEnvFile(tempDir);
    const consoleProc = startConsole(port, tempDir, DISCORD_ENV);
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const password = readGeneratedPassword(tempDir);
      const session = await login(port, { password });

      const res = await api(port, "/api/settings/discord-oauth/disable", {
        cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password },
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));
      assert.equal(body.restartRequired, true);

      const env = readFileSync(join(tempDir, ".env"), "utf8");
      assert.match(env, /^DISCORD_OAUTH_DISABLED="?1"?$/m);
      // Soft-disable preserves config -- the env vars this process started
      // with aren't themselves in .env, but the route must not have written
      // any of the other Discord OAuth keys to an empty value.
      for (const key of ["DISCORD_OAUTH_CLIENT_ID", "DISCORD_HOME_GUILD_ID", "DISCORD_CONSOLE_ADMIN_ROLE_IDS"]) {
        assert.doesNotMatch(env, new RegExp(`^${key}=""?$`, "m"), `${key} must not have been cleared by disable`);
      }

      const entries = readAuditEntries(tempDir);
      const entry = entries.find((e) => e.action === "settings.discord-oauth-disabled" && e.detail?.ok === true);
      assert.ok(entry, "expected a settings.discord-oauth-disabled audit entry");
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("enable requires no fresh proof -- just an authenticated session -- but does require CSRF", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "discord-enable-noproof-"));
    const consoleProc = startConsole(port, tempDir, { ...DISCORD_ENV, DISCORD_OAUTH_DISABLED: "1" });
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const password = readGeneratedPassword(tempDir);
      const session = await login(port, { password });

      // No CSRF token: refused (standard session-mutation gate, not this
      // route's own logic) -- confirms "no fresh proof" was never
      // implemented as "no auth/CSRF required."
      const noCsrf = await api(port, "/api/settings/discord-oauth/enable", { cookie: session.cookie, body: {} });
      assert.equal(noCsrf.status, 403);

      // No currentPassword in the body at all -- must still succeed, unlike disable/forget.
      const res = await api(port, "/api/settings/discord-oauth/enable", { cookie: session.cookie, csrf: session.csrf, body: {} });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));

      const env = readFileSync(join(tempDir, ".env"), "utf8");
      assert.match(env, /^DISCORD_OAUTH_DISABLED="?0"?$/m);
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("enable refuses when Discord OAuth is not currently disabled", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "discord-enable-notdisabled-"));
    const consoleProc = startConsole(port, tempDir, DISCORD_ENV);
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const password = readGeneratedPassword(tempDir);
      const session = await login(port, { password });

      const res = await api(port, "/api/settings/discord-oauth/enable", { cookie: session.cookie, csrf: session.csrf, body: {} });
      assert.equal(res.status, 400);
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("forget requires fresh proof, deletes the Client Secret FILE (not just an .env key), clears every field, and logs recoverable (non-secret) fields", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "discord-forget-"));
    writeDiscordEnvFile(tempDir);
    const consoleProc = startConsole(port, tempDir, DISCORD_ENV);
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const password = readGeneratedPassword(tempDir);
      const session = await login(port, { password });

      // Save a secret via the real route first, so there is a real file on
      // disk to prove gets deleted (DISCORD_OAUTH_CLIENT_SECRET as an env var
      // alone never creates runtime/secrets/discord-oauth-client-secret.txt).
      const saveSecret = await api(port, "/api/setup/save-oauth-secret", {
        cookie: session.cookie, csrf: session.csrf, body: { secret: "a-real-saved-secret-value", overwrite: true },
      });
      assert.equal(saveSecret.status, 200);
      const secretPath = join(tempDir, "runtime", "secrets", "discord-oauth-client-secret.txt");
      assert.ok(existsSync(secretPath), "test setup: the secret file must exist before forget is exercised");

      const noProof = await api(port, "/api/settings/discord-oauth/forget", { cookie: session.cookie, csrf: session.csrf, body: {} });
      assert.equal(noProof.status, 400, "forget must demand the current password, same as disable");

      const res = await api(port, "/api/settings/discord-oauth/forget", {
        cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password },
      });
      const body = await res.json();
      assert.equal(res.status, 200, JSON.stringify(body));

      assert.equal(existsSync(secretPath), false, "the Client Secret file must be deleted, not just an .env key cleared");
      const env = readFileSync(join(tempDir, ".env"), "utf8");
      for (const key of ["DISCORD_OAUTH_CLIENT_ID", "DISCORD_HOME_GUILD_ID", "DISCORD_CONSOLE_ADMIN_ROLE_IDS"]) {
        assert.match(env, new RegExp(`^${key}=""?$`, "m"), `${key} must be cleared by forget`);
      }
      assert.match(env, /^DISCORD_OAUTH_DISABLED="?0"?$/m, "forget returns to \"never configured,\" not \"configured but disabled\"");

      const entries = readAuditEntries(tempDir);
      const entry = entries.find((e) => e.action === "settings.discord-oauth-forgotten" && e.detail?.ok === true);
      assert.ok(entry, "expected a settings.discord-oauth-forgotten audit entry");
      assert.equal(entry.detail.recoverable.guildId, "111111111111111111");
      assert.equal(entry.detail.recoverable.adminRoleIds, "400000000000000002");
      // Never the secret itself.
      assert.equal(JSON.stringify(entry).includes("a-real-saved-secret-value"), false);
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("forget refuses when nothing is configured or disabled", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "discord-forget-unconfigured-"));
    const consoleProc = startConsole(port, tempDir, {});
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const password = readGeneratedPassword(tempDir);
      const session = await login(port, { password });

      const res = await api(port, "/api/settings/discord-oauth/forget", {
        cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password },
      });
      assert.equal(res.status, 400);
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // #676 §6.2 (Architect HIGH): discordOAuthAppConfigured is a second gating
  // boolean the disable route must also cover -- confirmed live against the
  // real routes it gates, not just the config computation in isolation.
  //
  // Like every other .env-driven Settings change in this codebase, config is
  // computed once at process boot from process.env, and .env itself is only
  // ever loaded into the process's real environment by the deployment's own
  // env_file/shell wrapper (outside this app entirely -- confirmed no dotenv
  // or equivalent runs inside config.js/server.js). A bare restart of THIS
  // test harness (which spawns node directly, no such wrapper) cannot pick up
  // a bare .env-file change either, for that same, pre-existing, unrelated
  // reason -- this test restarts with DISCORD_OAUTH_DISABLED passed
  // explicitly, exercising the actual thing this change is responsible for
  // (config.js's gating logic, both booleans) rather than re-testing this
  // repo's separate, already-established .env-loading deployment model.
  test("discordOAuthAppConfigured is also gated -- the setup-mode OAuth start route is refused once DISCORD_OAUTH_DISABLED is set", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "discord-disable-appconfigured-"));
    let consoleProc = startConsole(port, tempDir, DISCORD_ENV);
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const password = readGeneratedPassword(tempDir);
      const session = await login(port, { password });

      const before = await api(port, "/api/auth/discord/start?setup=1", { method: "GET", cookie: session.cookie });
      assert.equal(before.status, 302, "setup-mode start must work before disable");

      const disableRes = await api(port, "/api/settings/discord-oauth/disable", { cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password } });
      assert.equal(disableRes.status, 200);
      const env = readFileSync(join(tempDir, ".env"), "utf8");
      assert.match(env, /^DISCORD_OAUTH_DISABLED="?1"?$/m, "test setup: disable must have written the flag before restarting with it");

      await stopProcess(consoleProc.child);
      consoleProc = startConsole(port, tempDir, { ...DISCORD_ENV, DISCORD_OAUTH_DISABLED: "1" });
      await waitForHealth(port, 20000, consoleProc.logs);
      // Sessions are in-memory and do not survive a restart -- a fresh login
      // is real setup here, not a shortcut around it.
      const newSession = await login(port, { password });

      const after = await api(port, "/api/auth/discord/start?setup=1", { method: "GET", cookie: newSession.cookie });
      // Setup-mode's own gate (server.js) responds 400 ("no Discord
      // application yet") for !discordOAuthAppConfigured specifically --
      // distinct from the plain sign-in branch's 404 for !discordOAuthConfigured.
      // Either way, the real point this test pins is that IT NO LONGER
      // ISSUES A REAL OAUTH REDIRECT (302) once soft-disabled.
      assert.equal(after.status, 400, "setup-mode start must be refused once soft-disabled and restarted, even though the original Client ID/Secret/etc env vars are still present");
      assert.notEqual(after.status, 302);
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // #676 §7 (Security Architect + UI/UX convergent HIGH): the zero-2FA guard
  // must be enforced by /api/auth/2fa/disable itself, not only a guided-flow
  // UI, since this exact route is reachable directly from the always-
  // available fallback section too.
  describe("zero-2FA guard on TOTP disable when Discord OAuth is configured", () => {
    test("refuses with a distinguishable warning when Discord's own MFA does not cover the acting tier", async () => {
      const port = await getFreePort();
      const tempDir = mkdtempSync(join(tmpdir(), "discord-zerofa-warn-"));
      const consoleProc = startConsole(port, tempDir, { ...DISCORD_ENV, CONSOLE_TOTP_ENABLED: "1", DISCORD_OAUTH_REQUIRE_MFA_TIERS: "" });
      try {
        await waitForHealth(port, 20000, consoleProc.logs);
        const password = readGeneratedPassword(tempDir);
        let session = await login(port, { password });
        await api(port, "/api/auth/2fa/enable", { cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password } });
        // Enrollment itself is out of scope for this test (covered by
        // totpOptIn.integration.test.js) -- this route only needs
        // secondFactor.isConfigured() to be false here, which it is (enable
        // only mints an enroll session, never completes enrollment on its own).

        const disable = await api(port, "/api/auth/2fa/disable", { cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password } });
        // Not enrolled (never confirmed), so this specifically exercises the
        // guard's placement relative to requireEnrolled:true's own 400 --
        // the guard must fire FIRST, before requireFreshTier3Proof's "no
        // second factor" refusal, so the warning is distinguishable.
        const body = await disable.json();
        assert.equal(disable.status, 409, JSON.stringify(body));
        assert.equal(body.zeroFactorWarning, true);

        // Layer 2 audit finding (QA hat, CRITICAL): this "warn" test alone
        // never proved the acknowledgeNoOtherFactor:true bypass actually
        // works -- confirmed empirically that a broken/disabled bypass
        // (renamed condition, always-false check) still left the ENTIRE
        // suite green. Resubmit the identical request, acknowledged, and
        // assert the guard is skipped this time (falling through to
        // requireFreshTier3Proof's own "not enrolled" 400 in this fixture,
        // never a second 409).
        const acknowledged = await api(port, "/api/auth/2fa/disable", {
          cookie: session.cookie, csrf: session.csrf,
          body: { currentPassword: password, acknowledgeNoOtherFactor: true },
        });
        const acknowledgedBody = await acknowledged.json();
        assert.notEqual(acknowledged.status, 409, JSON.stringify(acknowledgedBody));
        assert.notEqual(acknowledgedBody.zeroFactorWarning, true, JSON.stringify(acknowledgedBody));
      } finally {
        await stopProcess(consoleProc.child);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test("does not warn when Discord's own MFA already covers the acting tier", async () => {
      const port = await getFreePort();
      const tempDir = mkdtempSync(join(tmpdir(), "discord-zerofa-covered-"));
      const consoleProc = startConsole(port, tempDir, { ...DISCORD_ENV, CONSOLE_TOTP_ENABLED: "1", DISCORD_OAUTH_REQUIRE_MFA_TIERS: "owner,admin" });
      try {
        await waitForHealth(port, 20000, consoleProc.logs);
        const password = readGeneratedPassword(tempDir);
        const session = await login(port, { password });

        const disable = await api(port, "/api/auth/2fa/disable", { cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password } });
        const body = await disable.json();
        // Falls through to requireFreshTier3Proof's own "not configured"
        // refusal (400), never the zero-factor warning (409) -- proving the
        // guard did not fire when Discord's MFA already covers this tier.
        // Asserted as the specific expected status (not just "not 409" --
        // Layer 2 audit finding, QA hat LOW) so an unrelated regression
        // (e.g. a 500) can't hide behind a technically-true assertion.
        assert.equal(disable.status, 400, JSON.stringify(body));
      } finally {
        await stopProcess(consoleProc.child);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test("does not warn when Discord OAuth is not configured at all -- password-only 2FA-off is the ordinary state", async () => {
      const port = await getFreePort();
      const tempDir = mkdtempSync(join(tmpdir(), "discord-zerofa-none-"));
      const consoleProc = startConsole(port, tempDir, { CONSOLE_TOTP_ENABLED: "1" });
      try {
        await waitForHealth(port, 20000, consoleProc.logs);
        const password = readGeneratedPassword(tempDir);
        const session = await login(port, { password });

        const disable = await api(port, "/api/auth/2fa/disable", { cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password } });
        const body = await disable.json();
        assert.equal(disable.status, 400, JSON.stringify(body));
      } finally {
        await stopProcess(consoleProc.child);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  // #676 §10 (QA HIGH): the new /disable route shares credentialProofRateLimiter
  // with password rotation and TOTP disable -- this exact bucket-sharing
  // pattern was the site of a previously-fixed real DoS bug in this file.
  test("disable shares its rate-limit bucket with password rotation -- exhausting one blocks the other", async () => {
    const port = await getFreePort();
    const tempDir = mkdtempSync(join(tmpdir(), "discord-disable-ratelimit-"));
    const consoleProc = startConsole(port, tempDir, DISCORD_ENV);
    try {
      await waitForHealth(port, 20000, consoleProc.logs);
      const password = readGeneratedPassword(tempDir);
      const session = await login(port, { password });

      // Exhaust the shared bucket via repeated failed password rotation attempts.
      let lastStatus = 0;
      for (let i = 0; i < 10; i++) {
        const res = await api(port, "/api/settings/admin-password", {
          cookie: session.cookie, csrf: session.csrf, body: { currentPassword: "wrong", newPassword: "Whatever-Doesnt-Matter-123" },
        });
        lastStatus = res.status;
        if (lastStatus === 429) break;
      }
      assert.equal(lastStatus, 429, "expected the shared credential-proof limiter to trip");

      // The SAME bucket must now also block a correctly-credentialed disable call.
      const disable = await api(port, "/api/settings/discord-oauth/disable", {
        cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password },
      });
      assert.equal(disable.status, 429, "the disable route must share the exhausted bucket, not a fresh independent one");
    } finally {
      await stopProcess(consoleProc.child);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Layer 2 audit finding (Network/Security Architect/Cloud Security hats,
  // convergent HIGH): config.discordOAuthConfigured/AppConfigured are
  // boot-time snapshots, so a naive fix would leave Discord sign-in fully
  // functional in this SAME still-running process until an actual restart
  // completes -- and that restart is triggered by a separate, best-effort
  // client call that can be lost entirely (closed tab, dropped connection).
  // These tests prove the cutoff is immediate and in-process, independent of
  // any restart ever happening: no second process, no waiting, no polling.
  describe("disable/forget cut off Discord sign-in immediately, before any restart (#676 follow-up)", () => {
    test("disable: the start route refuses in the SAME process, immediately after disable succeeds -- no restart needed", async () => {
      const port = await getFreePort();
      const tempDir = mkdtempSync(join(tmpdir(), "discord-disable-immediate-"));
      const consoleProc = startConsole(port, tempDir, DISCORD_ENV);
      try {
        await waitForHealth(port, 20000, consoleProc.logs);
        const password = readGeneratedPassword(tempDir);
        const session = await login(port, { password });

        // Before disable: Discord sign-in is live -- a real 302 to Discord.
        const before = await api(port, "/api/auth/discord/start", { method: "GET" });
        assert.equal(before.status, 302, "expected Discord sign-in to be live before disabling it");

        const disable = await api(port, "/api/settings/discord-oauth/disable", {
          cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password },
        });
        assert.equal(disable.status, 200, JSON.stringify(await disable.json()));

        // Immediately after, in this SAME process (no restart triggered, no
        // wait) -- Discord sign-in must already be refused.
        const after = await api(port, "/api/auth/discord/start", { method: "GET" });
        assert.equal(after.status, 404, "Discord sign-in must be cut off in-process, not only after a future restart");
      } finally {
        await stopProcess(consoleProc.child);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test("forget: the start route also refuses immediately, in-process", async () => {
      const port = await getFreePort();
      const tempDir = mkdtempSync(join(tmpdir(), "discord-forget-immediate-"));
      const consoleProc = startConsole(port, tempDir, DISCORD_ENV);
      try {
        await waitForHealth(port, 20000, consoleProc.logs);
        writeDiscordEnvFile(tempDir);
        const password = readGeneratedPassword(tempDir);
        const session = await login(port, { password });

        const forget = await api(port, "/api/settings/discord-oauth/forget", {
          cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password },
        });
        assert.equal(forget.status, 200, JSON.stringify(await forget.json()));

        const after = await api(port, "/api/auth/discord/start", { method: "GET" });
        assert.equal(after.status, 404);
      } finally {
        await stopProcess(consoleProc.child);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test("enable: restores in-process immediately too, reversing a disable before its restart ever ran", async () => {
      const port = await getFreePort();
      const tempDir = mkdtempSync(join(tmpdir(), "discord-enable-immediate-"));
      const consoleProc = startConsole(port, tempDir, DISCORD_ENV);
      try {
        await waitForHealth(port, 20000, consoleProc.logs);
        const password = readGeneratedPassword(tempDir);
        const session = await login(port, { password });

        await api(port, "/api/settings/discord-oauth/disable", {
          cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password },
        });
        const disabledCheck = await api(port, "/api/auth/discord/start", { method: "GET" });
        assert.equal(disabledCheck.status, 404);

        const enable = await api(port, "/api/settings/discord-oauth/enable", {
          cookie: session.cookie, csrf: session.csrf, body: {},
        });
        assert.equal(enable.status, 200, JSON.stringify(await enable.json()));

        const reEnabledCheck = await api(port, "/api/auth/discord/start", { method: "GET" });
        assert.equal(reEnabledCheck.status, 302, "enable must restore Discord sign-in in-process too, not only after a restart");
      } finally {
        await stopProcess(consoleProc.child);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    // Layer 3 audit finding (#676 follow-up): the setup-mode start route
    // (?setup=1, used by the embedded wizard's own "active"/"authorize"
    // step links) is a THIRD real gate point alongside the plain start and
    // callback routes above, and was missed when the in-process cutoff flag
    // was added -- it kept issuing real 302s to Discord during the
    // disable/forget restart window.
    test("disable: the setup-mode start route (?setup=1) also refuses immediately, in-process", async () => {
      const port = await getFreePort();
      const tempDir = mkdtempSync(join(tmpdir(), "discord-disable-setup-mode-"));
      const consoleProc = startConsole(port, tempDir, DISCORD_ENV);
      try {
        await waitForHealth(port, 20000, consoleProc.logs);
        const password = readGeneratedPassword(tempDir);
        const session = await login(port, { password });

        const before = await api(port, "/api/auth/discord/start?setup=1", { method: "GET", cookie: session.cookie });
        assert.equal(before.status, 302, "expected the setup-mode round-trip to be live before disabling Discord OAuth");

        await api(port, "/api/settings/discord-oauth/disable", {
          cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password },
        });

        const after = await api(port, "/api/auth/discord/start?setup=1", { method: "GET", cookie: session.cookie });
        assert.equal(after.status, 400, "the setup-mode round-trip must be cut off in-process too, not only the plain start/callback routes");
      } finally {
        await stopProcess(consoleProc.child);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    // Layer 3 audit finding (#676 follow-up): Forget also set
    // discordOAuthSoftDisabledInProcess, which is the SAME flag Enable's own
    // "is it disabled" check reads -- so calling Enable during Forget's
    // restart window silently reversed the wipe with zero credential proof,
    // using config.discordOAuthClientSecret still cached at boot and
    // unaffected by the secret file Forget just deleted.
    test("enable cannot reverse a forget -- a real forget can only be undone by setting Discord OAuth up again", async () => {
      const port = await getFreePort();
      const tempDir = mkdtempSync(join(tmpdir(), "discord-forget-enable-"));
      const consoleProc = startConsole(port, tempDir, DISCORD_ENV);
      try {
        await waitForHealth(port, 20000, consoleProc.logs);
        writeDiscordEnvFile(tempDir);
        const password = readGeneratedPassword(tempDir);
        const session = await login(port, { password });

        const forget = await api(port, "/api/settings/discord-oauth/forget", {
          cookie: session.cookie, csrf: session.csrf, body: { currentPassword: password },
        });
        assert.equal(forget.status, 200, JSON.stringify(await forget.json()));

        const enable = await api(port, "/api/settings/discord-oauth/enable", {
          cookie: session.cookie, csrf: session.csrf, body: {},
        });
        const enableBody = await enable.json();
        assert.equal(enable.status, 400, JSON.stringify(enableBody));

        const after = await api(port, "/api/auth/discord/start", { method: "GET" });
        assert.equal(after.status, 404, "Discord sign-in must stay cut off -- enable must not have silently reversed the forget");
      } finally {
        await stopProcess(consoleProc.child);
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
