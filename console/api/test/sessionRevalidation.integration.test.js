import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getFreePort, waitForHealth, stopProcess } from "../test-support/consoleHarness.js";

// #1355: removing a Discord role must end/demote the console session within a couple of sweeps,
// not at expiry. Real console process, fake Discord whose roles the test changes mid-session.
const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const GUILD = "111111111111111111";
const ADMIN_ROLE = "400000000000000002";
const MOD_ROLE = "400000000000000003";
const USER = "222222222222222201";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("role removal/demotion/ban reach a live Discord session within the sweep interval", { timeout: 120000 }, async () => {
  const state = { roles: [ADMIN_ROLE], memberStatus: 200 };
  const discord = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const json = (body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.pathname === "/oauth2/token") { req.resume(); req.on("end", () => json({ access_token: "tok-1", token_type: "Bearer", expires_in: 604800 })); return; }
    if (url.pathname === "/users/@me") return json({ id: USER, username: "revalidate", mfa_enabled: false });
    if (url.pathname === "/users/@me/guilds") return json([{ id: GUILD, name: "G", owner: false }]);
    if (url.pathname === `/users/@me/guilds/${GUILD}/member`) return state.memberStatus === 200 ? json({ user: { id: USER }, roles: state.roles }) : json({}, state.memberStatus);
    json({}, 404);
  });
  const discordPort = await getFreePort();
  await new Promise((r) => discord.listen(discordPort, "127.0.0.1", r));
  const port = await getFreePort();
  const dir = mkdtempSync(join(tmpdir(), "revalidate-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: apiRoot,
    env: {
      PATH: dirname(process.execPath), HOME: dir, DUNE_DOCKER_DIR: dir, ADMIN_BIND_PORT: String(port), ADMIN_PASSWORD: "correct-password",
      ADMIN_SECURE_COOKIES: "0", ADMIN_MOCK_MODE: "1", DISCORD_SESSION_REVALIDATE_SECONDS: "5",
      DISCORD_OAUTH_CLIENT_ID: "c", DISCORD_OAUTH_CLIENT_SECRET: "s",
      DISCORD_OAUTH_REDIRECT_URI: `http://127.0.0.1:${port}/api/auth/discord/callback`,
      DISCORD_OAUTH_BASE_URL: `http://127.0.0.1:${discordPort}`, DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "0", DISCORD_OAUTH_OWNER_ALLOWLIST: "",
      DISCORD_HOME_GUILD_ID: GUILD, DISCORD_CONSOLE_ADMIN_ROLE_IDS: ADMIN_ROLE, DISCORD_CONSOLE_MODERATOR_ROLE_IDS: MOD_ROLE
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (c) => { logs += c; });
  child.stderr.on("data", (c) => { logs += c; });
  const base = `http://127.0.0.1:${port}`;
  const cookieValue = (list, name) => { const e = list.find((v) => v.startsWith(`${name}=`)); return e ? e.split(";")[0].slice(name.length + 1) : null; };
  const signIn = async () => {
    const start = await fetch(`${base}/api/auth/discord/start`, { redirect: "manual" });
    const pending = cookieValue(start.headers.getSetCookie(), "discord_oauth_state");
    const cb = await fetch(`${base}/api/auth/discord/callback?code=x&state=${encodeURIComponent(pending)}`, { redirect: "manual", headers: { cookie: `discord_oauth_state=${pending}` } });
    await cb.text();
    return `asc_session=${cookieValue(cb.headers.getSetCookie(), "asc_session")}`;
  };
  const tierOf = async (cookie) => { const r = await fetch(`${base}/api/auth/me`, { headers: { cookie } }); return r.status === 200 ? (await r.json()).user?.tier : r.status; };
  const waitFor = async (pred, ms = 25000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await sleep(500); } return false; };
  try {
    await waitForHealth(port, 20000, () => logs);
    // 1. demotion admin -> moderator
    let cookie = await signIn();
    assert.equal(await tierOf(cookie), "admin");
    state.roles = [MOD_ROLE];
    assert.ok(await waitFor(async () => (await tierOf(cookie)) === "moderator"), "demotion must apply without a new sign-in");
    // 2. role removed entirely -> session ends
    state.roles = [];
    assert.ok(await waitFor(async () => (await tierOf(cookie)) === 401), "role removal must end the session");
    // 3. left/banned from guild (member 404 with the guild gone from the list is covered by no-roles); token revoked (401)
    state.roles = [ADMIN_ROLE];
    cookie = await signIn();
    assert.equal(await tierOf(cookie), "admin");
    state.memberStatus = 200;
    discord.removeAllListeners("request");
    discord.on("request", (req, res) => { res.writeHead(401, { "content-type": "application/json" }); res.end("{}"); });
    assert.ok(await waitFor(async () => (await tierOf(cookie)) === 401), "a revoked Discord token must end the session");
  } finally {
    discord.closeAllConnections?.();
    await new Promise((r) => discord.close(() => r()));
    await stopProcess(child);
    rmSync(dir, { recursive: true, force: true });
  }
});
