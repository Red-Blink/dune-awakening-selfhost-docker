// Layer 3 audit findings #1/#2 (HIGH): none of the 4 Discord Bot settings
// routes (GET /api/settings/discord-bot, POST .../enable, .../role-ids,
// .../regenerate-token) had ever been exercised end-to-end via a real HTTP
// request through the real server.js entrypoint -- only the underlying
// business-logic functions (discordAdapterSettings.test.js) and structural
// source-parsing checks (discordBotSettingsRoutes.test.js) covered them.
// This file closes that gap, following passwordRotation.integration.test.js's
// spawn-a-real-server-and-fetch-it pattern (the closer match here: these
// routes need a plain owner-tier admin-password session, not a Discord OAuth
// round-trip).
//
// This intentionally does NOT duplicate the one HTTP-level 403 test that
// already exists for these routes -- oauthRoutes.integration.test.js's
// "admin-tier session gets a real 403 changing Discord admin role IDs via
// POST /api/settings/discord-bot/enable" -- which needs a real admin-tier
// (non-owner) session minted via the Discord OAuth + bot-handoff harness.
// That test stays where it is; this file builds alongside it.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const ADMIN_PASSWORD = "correct-password";

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
      ADMIN_PASSWORD,
      ADMIN_SECURE_COOKIES: "0",
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  return { child, logs: () => logs };
}

async function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* not up yet */ }
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

// method defaults to GET when no body is given, POST when one is -- every
// caller below passes method explicitly anyway, this just keeps the helper
// terse for the plain-GET call sites.
function api(port, path, { method, cookie, csrf, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = `asc_session=${cookie}`;
  if (csrf) headers["x-csrf-token"] = csrf;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: method || (body !== undefined ? "POST" : "GET"),
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual"
  });
}

async function login(port, password) {
  const res = await api(port, "/api/auth/login", { method: "POST", body: { password } });
  const body = await res.json();
  return { status: res.status, cookie: cookieFrom(res), csrf: body.csrfToken, body };
}

function auditRows(tempDir) {
  try {
    return readFileSync(join(tempDir, "runtime", "generated", "web-admin-audit.jsonl"), "utf8");
  } catch {
    return "";
  }
}

const ROUTES = [
  { path: "/api/settings/discord-bot", method: "GET" },
  { path: "/api/settings/discord-bot/enable", method: "POST" },
  { path: "/api/settings/discord-bot/role-ids", method: "POST" },
  { path: "/api/settings/discord-bot/regenerate-token", method: "POST" }
];

test("an unauthenticated request to each of the 4 Discord Bot settings routes is rejected, never reaching the route handler", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "discordbot-routes-e2e-unauth-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    for (const route of ROUTES) {
      const res = await api(port, route.path, { method: route.method, body: route.method === "POST" ? {} : undefined });
      // No session cookie at all -- auth.requireAuth() denies with 401
      // (this codebase's real convention for "not signed in", distinct from
      // the 403 an authenticated-but-unauthorized session gets).
      assert.equal(res.status, 401, `${route.method} ${route.path} must reject an unauthenticated request`);
      const body = await res.json();
      assert.ok(body.error, `${route.method} ${route.path} must return an error message`);
    }
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an authenticated owner session can read, enable, update role IDs, and regenerate the token for the Discord Bot adapter end-to-end", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "discordbot-routes-e2e-owner-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await login(port, ADMIN_PASSWORD);
    assert.equal(session.status, 200);

    // GET before anything is configured: disabled, no token.
    const before = await api(port, "/api/settings/discord-bot", { method: "GET", cookie: session.cookie });
    assert.equal(before.status, 200);
    const beforeBody = await before.json();
    assert.equal(beforeBody.enabled, false);
    assert.equal(beforeBody.tokenConfigured, false);

    // POST /enable -- a genuine first enable must mint and return a token.
    const enable = await api(port, "/api/settings/discord-bot/enable", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { playerRoleIds: "111111111111111111", moderatorRoleIds: "", adminRoleIds: "" }
    });
    // Real UAT finding (2026-09-09): /enable used to also queue the
    // restart task (202) in the same request that mints the token -- it
    // now only persists config and mints the token (200), so the caller
    // (the console UI) can reveal the token before deciding when to
    // actually trigger the restart via the separate POST .../restart route.
    assert.equal(enable.status, 200, "a successful enable persists config and mints a token, without restarting yet");
    const enableBody = await enable.json();
    assert.equal(enableBody.task, undefined, "enable no longer queues the restart task itself -- see POST .../restart");
    assert.ok(enableBody.token, "a genuine first enable must return the freshly minted token");
    const firstToken = enableBody.token;

    // GET again -- state on disk (env-file-backed) must now reflect enabled.
    const afterEnable = await api(port, "/api/settings/discord-bot", { method: "GET", cookie: session.cookie });
    const afterEnableBody = await afterEnable.json();
    assert.equal(afterEnableBody.enabled, true);
    assert.equal(afterEnableBody.tokenConfigured, true);
    assert.deepEqual(afterEnableBody.roleIds.player, ["111111111111111111"]);

    // POST /role-ids -- must succeed and must NOT return a token field at all.
    const roleIds = await api(port, "/api/settings/discord-bot/role-ids", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { playerRoleIds: "111111111111111111", moderatorRoleIds: "222222222222222222", adminRoleIds: "" }
    });
    assert.equal(roleIds.status, 202);
    const roleIdsBody = await roleIds.json();
    assert.ok(roleIdsBody.task, "the response must include the queued task");
    assert.equal(roleIdsBody.token, undefined, "role-ids updates must never carry a token field");

    const afterRoleIds = await api(port, "/api/settings/discord-bot", { method: "GET", cookie: session.cookie });
    const afterRoleIdsBody = await afterRoleIds.json();
    assert.deepEqual(afterRoleIdsBody.roleIds.moderator, ["222222222222222222"]);

    // POST /regenerate-token -- owner tier, must succeed and mint a NEW token.
    const regen = await api(port, "/api/settings/discord-bot/regenerate-token", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: {}
    });
    assert.equal(regen.status, 200);
    const regenBody = await regen.json();
    assert.ok(regenBody.token, "regenerate-token must return the freshly minted token");
    assert.notEqual(regenBody.token, firstToken, "regeneration must mint a genuinely new token, not echo the old one");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// dune-awakening-selfhost-docker#872 (automated review finding on
// already-merged #748): API-REFERENCE.md documents playerRoleIds/
// moderatorRoleIds/adminRoleIds as optional on both /enable and
// /role-ids, implying a caller can update one tier at a time --
// but the route used to treat "field omitted from the body" the same
// as "field explicitly cleared," silently wiping the other tiers.
test("POST /enable and /role-ids preserve a tier's existing role IDs when that field is omitted from the request body, not wipe it", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "discordbot-routes-e2e-omitted-field-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await login(port, ADMIN_PASSWORD);

    // Seed all 3 tiers via a genuine first enable that sends every field.
    await api(port, "/api/settings/discord-bot/enable", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { playerRoleIds: "111111111111111111", moderatorRoleIds: "222222222222222222", adminRoleIds: "" }
    });

    // Now update ONLY adminRoleIds via /role-ids -- omitting playerRoleIds
    // and moderatorRoleIds entirely from the body (not sending them as
    // empty strings, genuinely absent keys), matching what a caller
    // following the documented "optional" contract would do.
    const roleIds = await api(port, "/api/settings/discord-bot/role-ids", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { adminRoleIds: "333333333333333333" }
    });
    assert.equal(roleIds.status, 202);

    const after = await (await api(port, "/api/settings/discord-bot", { method: "GET", cookie: session.cookie })).json();
    assert.deepEqual(after.roleIds.player, ["111111111111111111"], "player role IDs must survive a request that never mentioned that field");
    assert.deepEqual(after.roleIds.moderator, ["222222222222222222"], "moderator role IDs must survive a request that never mentioned that field");
    assert.deepEqual(after.roleIds.admin, ["333333333333333333"], "the field actually present in the body must still apply");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// Code-review finding on the fix above (dune-awakening-selfhost-docker#872
// fix PR): the new `"field" in body` checks throw a TypeError when the
// parsed JSON body is a valid-but-non-object value (readJsonBody() only
// special-cases a genuinely EMPTY body as `{}`), which previously leaked a
// raw 500 instead of degrading gracefully like the old `body.field` access
// did on the same inputs.
test("POST /enable and /role-ids degrade gracefully (no 500) when the request body is valid JSON but not an object", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "discordbot-routes-e2e-non-object-body-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await login(port, ADMIN_PASSWORD);

    // Seed all 3 tiers so a subsequent non-object body can be checked for
    // "preserved existing state," not just "didn't 500."
    await api(port, "/api/settings/discord-bot/enable", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { playerRoleIds: "111111111111111111", moderatorRoleIds: "", adminRoleIds: "" }
    });

    for (const primitiveBody of [123, "not-an-object", true, null]) {
      const res = await api(port, "/api/settings/discord-bot/role-ids", {
        method: "POST",
        cookie: session.cookie,
        csrf: session.csrf,
        body: primitiveBody
      });
      assert.notEqual(res.status, 500, `body ${JSON.stringify(primitiveBody)} must not crash the route handler`);
      assert.equal(res.status, 202, `body ${JSON.stringify(primitiveBody)} should be treated as no fields present, not an error`);
    }

    const after = await (await api(port, "/api/settings/discord-bot", { method: "GET", cookie: session.cookie })).json();
    assert.deepEqual(after.roleIds.player, ["111111111111111111"], "a non-object body must not wipe existing role IDs");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// Code-review finding, round 2 (dune-awakening-selfhost-docker#872 fix PR):
// discordRoleMappingFromEnv() never validated .env-sourced role IDs against
// SNOWFLAKE_PATTERN (this UI predates that validator) -- a legacy or
// manually-edited .env entry that doesn't match the pattern must not block
// a request that never touches that tier. Seeds an invalid value directly
// via the process env (bypassing the API's own validator entirely, the way
// a manually-edited .env file would).
test("POST /role-ids does not re-validate a legacy, already-invalid .env role-ID value for a tier the request never mentions", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "discordbot-routes-e2e-legacy-invalid-roleids-"));
  const console = startConsole(port, tempDir, { DISCORD_PLAYER_ROLE_IDS: "not-a-real-snowflake" });
  try {
    await waitForHealth(port);
    const session = await login(port, ADMIN_PASSWORD);

    const before = await (await api(port, "/api/settings/discord-bot", { method: "GET", cookie: session.cookie })).json();
    assert.deepEqual(before.roleIds.player, ["not-a-real-snowflake"], "the legacy invalid value should be readable as-is");

    // Only touch adminRoleIds -- playerRoleIds is never mentioned in the body.
    const res = await api(port, "/api/settings/discord-bot/role-ids", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { adminRoleIds: "222222222222222222" }
    });
    assert.equal(res.status, 202, "an update that never touches the tier with the legacy invalid value must not 400");

    const after = await (await api(port, "/api/settings/discord-bot", { method: "GET", cookie: session.cookie })).json();
    assert.deepEqual(after.roleIds.player, ["not-a-real-snowflake"], "the legacy invalid value must survive untouched");
    assert.deepEqual(after.roleIds.admin, ["222222222222222222"], "the field actually present in the body must still apply");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// Real UAT finding (2026-09-09, "I see no path to remove the bot"): this
// feature previously had no way back to "never configured" once enabled.
test("POST /api/settings/discord-bot/disable fully resets an enabled adapter back to never-configured, and is recorded in the real audit log", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "discordbot-routes-e2e-disable-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await login(port, ADMIN_PASSWORD);
    assert.equal(session.status, 200);

    const enable = await api(port, "/api/settings/discord-bot/enable", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { playerRoleIds: "111111111111111111", moderatorRoleIds: "", adminRoleIds: "", deploymentChoice: "hosted" }
    });
    assert.equal(enable.status, 200);

    const disable = await api(port, "/api/settings/discord-bot/disable", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: {}
    });
    assert.equal(disable.status, 200);
    assert.deepEqual(await disable.json(), { ok: true });

    const after = await api(port, "/api/settings/discord-bot", { method: "GET", cookie: session.cookie });
    const afterBody = await after.json();
    assert.equal(afterBody.enabled, false, "a disabled adapter must report enabled: false");
    assert.equal(afterBody.tokenConfigured, false, "the token must be gone, not just the enabled flag flipped");
    assert.equal(afterBody.deploymentChoice, null, "the deployment choice must be fully cleared, not left as 'hosted'");
    assert.deepEqual(afterBody.roleIds.player, [], "role IDs must be cleared, not left over from the prior enable");

    const rows = auditRows(tempDir).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const disableRow = rows.find((r) => r.action === "settings.discord-bot.disabled");
    assert.ok(disableRow, "a successful disable must write a settings.discord-bot.disabled audit row");
    assert.equal(disableRow.path, "/api/settings/discord-bot/disable");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// Real UAT finding (2026-09-09): /enable and /role-ids no longer trigger the
// restart themselves -- POST .../restart is the separate, explicit call the
// console UI now makes once the operator has seen the token (for /enable)
// or acknowledged the change (for /role-ids). This closes the same
// real-HTTP-route gap for the new route that the tests above already close
// for /enable, /role-ids, and /regenerate-token.
test("POST /api/settings/discord-bot/restart queues the discordAdapterApply task and is recorded in the real audit log", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "discordbot-routes-e2e-restart-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await login(port, ADMIN_PASSWORD);
    assert.equal(session.status, 200);

    const restart = await api(port, "/api/settings/discord-bot/restart", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: {}
    });
    assert.equal(restart.status, 202, "a successful restart trigger must return 202 (task queued)");
    const restartBody = await restart.json();
    assert.ok(restartBody.task, "the response must include the queued task");
    assert.equal(restartBody.task.operation, "discordAdapterApply");

    // Layer 3 audit finding (CRITICAL): this test used to stop at "the task
    // was queued with the right operation name" -- it never checked the task
    // actually ran successfully. runner.js's buildDuneArgs() had no case for
    // "discordAdapterApply" at all, so the queued task ALWAYS failed with
    // "Unsupported operation: discordAdapterApply" the moment it executed,
    // silently, with this exact assertion set still green (the .env write
    // and in-process mirror that make the settings page look correct happen
    // synchronously, before this task is even queued -- see
    // adapterSettings.js). This test's own sandbox has no real
    // runtime/scripts/dune (DUNE_DOCKER_DIR points at a bare tempDir), so it
    // cannot verify a real container recreate succeeds -- but it CAN verify
    // the operation is actually recognized by polling to a terminal task
    // state and asserting the failure, if any, is an infra-availability
    // one ("Missing dune command"), never the code-level "Unsupported
    // operation" this bug produced.
    const deadline = Date.now() + 5000;
    let finalTask = restartBody.task;
    while (Date.now() < deadline && (finalTask.status === "queued" || finalTask.status === "running")) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const poll = await api(port, `/api/setup/tasks/${finalTask.id}`, { method: "GET", cookie: session.cookie });
      finalTask = (await poll.json()).task;
    }
    assert.notEqual(finalTask.status, "queued", "the task must have started running within the poll window");
    assert.ok(
      !finalTask.errorMessage || !/Unsupported operation/.test(finalTask.errorMessage),
      `discordAdapterApply must be a recognized operation -- got: ${finalTask.errorMessage}`
    );

    const rows = auditRows(tempDir).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const restartRow = rows.find((r) => r.action === "settings.discord-bot.restart");
    assert.ok(restartRow, "a successful restart trigger must write a settings.discord-bot.restart audit row");
    assert.equal(restartRow.path, "/api/settings/discord-bot/restart");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// Real UAT finding (2026-09-10): the 3-step wizard redesign's step 1 ("Add
// bot to Discord") needs deploymentChoice persisted immediately on picking
// "Hosted bot" -- before role IDs or the adapter is enabled -- so the
// hosted-bot OAuth routes' deploymentChoice gate passes in time.
test("POST /api/settings/discord-bot/choice persists deploymentChoice without enabling the adapter or queuing a restart", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "discordbot-routes-e2e-choice-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await login(port, ADMIN_PASSWORD);
    assert.equal(session.status, 200);

    const write = await api(port, "/api/settings/discord-bot/choice", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { deploymentChoice: "hosted" }
    });
    assert.equal(write.status, 200, "no task queued -- 200, not 202");
    assert.deepEqual(await write.json(), { ok: true });

    const after = await api(port, "/api/settings/discord-bot", { method: "GET", cookie: session.cookie });
    const afterBody = await after.json();
    assert.equal(afterBody.deploymentChoice, "hosted");
    assert.equal(afterBody.enabled, false, "must not enable the adapter");
    assert.equal(afterBody.tokenConfigured, false, "must not mint a token");

    const rows = auditRows(tempDir).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(rows.find((r) => r.action === "settings.discord-bot.choice-updated"), "must be audited");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST /api/settings/discord-bot/choice rejects an invalid deploymentChoice value", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "discordbot-routes-e2e-choice-invalid-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await login(port, ADMIN_PASSWORD);

    const write = await api(port, "/api/settings/discord-bot/choice", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { deploymentChoice: "not-a-real-choice" }
    });
    assert.equal(write.status, 400);
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST /api/settings/discord-bot/enable returns a real 400 over the wire for an invalid Discord role ID, not just from the pure validator", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "discordbot-routes-e2e-badinput-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await login(port, ADMIN_PASSWORD);

    const res = await api(port, "/api/settings/discord-bot/enable", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { playerRoleIds: "not-a-role-id", moderatorRoleIds: "", adminRoleIds: "" }
    });
    assert.equal(res.status, 400, "an invalid role-ID format must be rejected with 400 over the real HTTP route");
    const body = await res.json();
    assert.match(body.error || "", /Invalid Discord role ID/i);

    // The invalid request must not have enabled the adapter as a side effect.
    const state = await api(port, "/api/settings/discord-bot", { method: "GET", cookie: session.cookie });
    assert.equal((await state.json()).enabled, false, "a rejected request must not partially apply");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// Task 2 (hosted-bot console-initiated OAuth registration plan), fix round
// 1: the reviewer's finding was that everything verifying the new
// deploymentChoice persistence path was either a direct-function-call unit
// test (discordAdapterSettings.test.js, which bypasses server.js entirely)
// or a manual code trace -- nothing exercised the real /enable and
// /role-ids route handlers (server.js) over an actual HTTP request. This
// closes that gap for both routes, in this file's own real-server pattern.
test("POST /api/settings/discord-bot/enable persists deploymentChoice over the real HTTP route, reflected by a subsequent GET", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "discordbot-routes-e2e-choice-enable-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await login(port, ADMIN_PASSWORD);
    assert.equal(session.status, 200);

    const enable = await api(port, "/api/settings/discord-bot/enable", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { playerRoleIds: "111111111111111111", moderatorRoleIds: "", adminRoleIds: "", deploymentChoice: "hosted" }
    });
    assert.equal(enable.status, 200);

    const after = await api(port, "/api/settings/discord-bot", { method: "GET", cookie: session.cookie });
    const afterBody = await after.json();
    assert.equal(afterBody.deploymentChoice, "hosted", "a real POST /enable with deploymentChoice must be reflected by a subsequent GET, not just by direct function calls");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST /api/settings/discord-bot/role-ids persists a changed deploymentChoice over the real HTTP route, without touching the live token", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "discordbot-routes-e2e-choice-roleids-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await login(port, ADMIN_PASSWORD);

    // First enable (self-hosted), same as the main end-to-end test above.
    const enable = await api(port, "/api/settings/discord-bot/enable", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { playerRoleIds: "111111111111111111", moderatorRoleIds: "", adminRoleIds: "", deploymentChoice: "self-hosted" }
    });
    assert.equal(enable.status, 200);

    // Now switch the choice to hosted via /role-ids -- this route must
    // never rotate the live token (see updateDiscordBotRoleIds()'s own
    // comment in adapterSettings.js).
    const roleIds = await api(port, "/api/settings/discord-bot/role-ids", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { playerRoleIds: "111111111111111111", moderatorRoleIds: "", adminRoleIds: "", deploymentChoice: "hosted" }
    });
    assert.equal(roleIds.status, 202);
    assert.equal((await roleIds.json()).token, undefined, "role-ids updates must never carry a token field");

    const after = await api(port, "/api/settings/discord-bot", { method: "GET", cookie: session.cookie });
    const afterBody = await after.json();
    assert.equal(afterBody.deploymentChoice, "hosted", "a real POST /role-ids with deploymentChoice must be reflected by a subsequent GET");
    assert.equal(afterBody.tokenConfigured, true, "changing deploymentChoice via /role-ids must not disturb the already-configured token");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a successful POST /api/settings/discord-bot/enable is recorded in the real audit log", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "discordbot-routes-e2e-audit-"));
  const console = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await login(port, ADMIN_PASSWORD);

    const res = await api(port, "/api/settings/discord-bot/enable", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { playerRoleIds: "111111111111111111", moderatorRoleIds: "", adminRoleIds: "" }
    });
    assert.equal(res.status, 200);

    const rows = auditRows(tempDir).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const enableRow = rows.find((r) => r.action === "settings.discord-bot.enable");
    assert.ok(enableRow, "a successful enable must write a settings.discord-bot.enable audit row");
    assert.equal(enableRow.detail.playerCount, 1);
    assert.equal(enableRow.path, "/api/settings/discord-bot/enable");
    // redactValue() (redact.js) redacts ANY field whose key matches
    // /password|token|secret|credential/i, unconditionally -- including a
    // boolean like tokenMinted, which is not itself sensitive. This is the
    // real, deliberately conservative behavior (over-redaction is the safe
    // failure mode for a key that merely contains "token"), not a bug --
    // pin it here so a change to that behavior doesn't silently regress
    // into leaking something that WAS meant to be redacted.
    assert.equal(enableRow.detail.tokenMinted, "<redacted>", "the audit log must never show an unredacted value for a token-named field, even a boolean");
  } finally {
    await stopProcess(console.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
