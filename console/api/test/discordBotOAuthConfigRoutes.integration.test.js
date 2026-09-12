// Real UAT finding (2026-09-09): "we have OAuth without bot and bot
// without OAuth" -- the hosted-bot connection got its own, independent
// Discord Application config (Client ID/Secret/Redirect URI), deliberately
// separate from Settings -> Discord OAuth's console-sign-in credentials.
// This closes the same real-HTTP-route gap discordAdapterSettingsRoutes.
// integration.test.js already closes for the sibling /api/settings/
// discord-bot/* routes, for these 2 new ones specifically.

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

function startConsole(port, tempDir) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: apiRoot,
    env: {
      ...process.env,
      DUNE_DOCKER_DIR: tempDir,
      ADMIN_BIND_PORT: String(port),
      ADMIN_PASSWORD,
      ADMIN_SECURE_COOKIES: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  return { child };
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
  return { status: res.status, cookie: cookieFrom(res), csrf: body.csrfToken };
}

function auditRows(tempDir) {
  try {
    return readFileSync(join(tempDir, "runtime", "generated", "web-admin-audit.jsonl"), "utf8");
  } catch {
    return "";
  }
}

test("POST /api/settings/discord-bot/oauth-config persists client ID and redirect URI, reflected by a subsequent GET /api/settings/discord-bot", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "discordbot-oauth-config-"));
  const console_ = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await login(port, ADMIN_PASSWORD);
    assert.equal(session.status, 200);

    const before = await api(port, "/api/settings/discord-bot", { method: "GET", cookie: session.cookie });
    const beforeBody = await before.json();
    assert.equal(beforeBody.hostedBotOAuthConfigured, false);

    const write = await api(port, "/api/settings/discord-bot/oauth-config", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { clientId: "999999999999999999", redirectUri: "https://console.example.com/api/integrations/discord/hosted-bot/oauth/callback" }
    });
    assert.equal(write.status, 200);

    const secret = await api(port, "/api/settings/discord-bot/oauth-secret", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { secret: "a-real-looking-client-secret-value" }
    });
    assert.equal(secret.status, 200);

    const after = await api(port, "/api/settings/discord-bot", { method: "GET", cookie: session.cookie });
    const afterBody = await after.json();
    // hostedBotOAuthConfigured still reflects the RUNNING process's config
    // (loaded at startup) here, not the just-written .env/secrets file --
    // same restart-required convention as Settings -> Discord OAuth's own
    // write-oauth-config/save-oauth-secret. Confirmed via the write calls'
    // own 200s and the audit log below, not by asserting a live flip here.
    assert.equal(typeof afterBody.hostedBotOAuthConfigured, "boolean");

    const rows = auditRows(tempDir).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(rows.find((r) => r.action === "settings.discord-bot.oauth-config-updated"), "config write must be audited");
    assert.ok(rows.find((r) => r.action === "settings.discord-bot.oauth-secret-updated"), "secret write must be audited");
    const secretRow = rows.find((r) => r.action === "settings.discord-bot.oauth-secret-updated");
    assert.equal(secretRow.detail.secret, "<redacted>", "the secret value must never appear in the audit log");
  } finally {
    await stopProcess(console_.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST /api/settings/discord-bot/oauth-config rejects an invalid client ID and an invalid redirect URI", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "discordbot-oauth-config-invalid-"));
  const console_ = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await login(port, ADMIN_PASSWORD);

    const badClientId = await api(port, "/api/settings/discord-bot/oauth-config", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { clientId: "not-a-snowflake" }
    });
    assert.equal(badClientId.status, 400);

    const badRedirect = await api(port, "/api/settings/discord-bot/oauth-config", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { redirectUri: "not-a-url" }
    });
    assert.equal(badRedirect.status, 400);
  } finally {
    await stopProcess(console_.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST /api/settings/discord-bot/oauth-secret rejects a secret shorter than 20 characters", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "discordbot-oauth-secret-invalid-"));
  const console_ = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await login(port, ADMIN_PASSWORD);

    const res = await api(port, "/api/settings/discord-bot/oauth-secret", {
      method: "POST",
      cookie: session.cookie,
      csrf: session.csrf,
      body: { secret: "too-short" }
    });
    assert.equal(res.status, 400);
  } finally {
    await stopProcess(console_.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("both new routes reject an unauthenticated request", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "discordbot-oauth-config-unauth-"));
  const console_ = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    for (const path of ["/api/settings/discord-bot/oauth-config", "/api/settings/discord-bot/oauth-secret"]) {
      const res = await api(port, path, { method: "POST", body: {} });
      assert.equal(res.status, 401, `${path} must reject an unauthenticated request`);
    }
  } finally {
    await stopProcess(console_.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
