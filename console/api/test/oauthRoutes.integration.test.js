import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { signPayload } from "../src/integrations/discord/handoff.js";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const repoRoot = dirname(dirname(apiRoot));
const HOME_GUILD = "111111111111111111";
const ADMIN_ROLE = "400000000000000002";
const MOD_ROLE = "400000000000000003";
const PLAYER_ROLE = "400000000000000004";
const USER_ID = "222222222222222222";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

// Minimal fake Discord API: token exchange, /users/@me, /users/@me/guilds.
// A code of "notmember" simulates a user outside the designated home guild.
function startFakeDiscord(port) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/oauth2/token") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const code = new URLSearchParams(body).get("code") || "";
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: `token-${code}`, token_type: "Bearer", expires_in: 604800 }));
      });
      return;
    }
    if (url.pathname === "/users/@me") {
      const auth = String(req.headers.authorization || "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: USER_ID, username: "fleetyard-operator", mfa_enabled: auth.includes("token-mfa") || auth.includes("guildowner-mfa") }));
      return;
    }
    // Member endpoint (guilds.members.read): roles are chosen by the code so a
    // test can sign in "as" a moderator, an admin, or a member with no mapped role.
    if (url.pathname === `/users/@me/guilds/${HOME_GUILD}/member`) {
      const auth = String(req.headers.authorization || "");
      const roles = auth.includes("token-moderator") ? [MOD_ROLE]
        : auth.includes("token-admin") ? [ADMIN_ROLE, PLAYER_ROLE]
        : auth.includes("token-mfa") ? [ADMIN_ROLE]
        : auth.includes("token-norole") ? ["999999999999999999"]
        : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ user: { id: USER_ID }, roles }));
      return;
    }
    if (url.pathname === "/users/@me/guilds") {
      const nonMember = String(req.headers.authorization || "").includes("token-notmember");
      res.writeHead(200, { "content-type": "application/json" });
      const isOwner = String(req.headers.authorization || "").includes("token-guildowner");
      res.end(JSON.stringify(nonMember ? [{ id: "123456789012345678", name: "Elsewhere" }] : [{ id: HOME_GUILD, name: "Fleetyard", owner: isOwner }, { id: "123456789012345678", name: "Elsewhere" }]));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

function startConsole(consolePort, discordPort, tempDir, extraEnv = {}) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: apiRoot,
    env: {
      ...process.env,
      DUNE_DOCKER_DIR: tempDir,
      ADMIN_BIND_PORT: String(consolePort),
      ADMIN_PASSWORD: "correct-password",
      ADMIN_SECURE_COOKIES: "0",
      DISCORD_OAUTH_CLIENT_ID: "client-id",
      DISCORD_OAUTH_CLIENT_SECRET: "client-secret",
      DISCORD_OAUTH_REDIRECT_URI: `http://127.0.0.1:${consolePort}/api/auth/discord/callback`,
      DISCORD_OAUTH_BASE_URL: `http://127.0.0.1:${discordPort}`,
      DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "1",
      DISCORD_OAUTH_OWNER_ALLOWLIST: USER_ID,
      DISCORD_HOME_GUILD_ID: HOME_GUILD,
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  return { child, logs: () => logs };
}

async function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("console did not become healthy in time");
}

function sessionCookieValue(setCookies, name) {
  const entry = (Array.isArray(setCookies) ? setCookies : [setCookies]).find((value) => value.startsWith(`${name}=`));
  return entry ? entry.split(";")[0].slice(name.length + 1) : null;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]);
}

function closeDiscordServer(server) {
  try {
    server.closeAllConnections?.();
  } catch {
    // best effort
  }
  return new Promise((resolve) => server.close(() => resolve()));
}

test("Discord OAuth sign-in flow works end-to-end through the real server", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-e2e-"));
  const console = startConsole(consolePort, discordPort, tempDir);
  const discordServer = await startFakeDiscord(discordPort);
  let sessionValue = null;
  let pendingStateValue = null;
  try {
    await waitForHealth(consolePort);

    const serverState = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/state`)).json();
    assert.equal(serverState.config.discordOAuthConfigured, true, "public state must advertise Discord OAuth once configured");

    const startResponse = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    assert.equal(startResponse.status, 302);
    assert.match(startResponse.headers.get("location") || "", /^https:\/\/discord\.com\/oauth2\/authorize/, `unexpected redirect: ${startResponse.headers.get("location")}`);
    const startCookies = startResponse.headers.getSetCookie().length ? startResponse.headers.getSetCookie() : [];
    pendingStateValue = sessionCookieValue(startCookies, "discord_oauth_state");
    assert.ok(pendingStateValue, "start must set the pending-state cookie");

    const callback = await fetch(
      `http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=validcode&state=${encodeURIComponent(pendingStateValue)}`,
      { redirect: "manual", headers: { cookie: `discord_oauth_state=${pendingStateValue}` } }
    );
    assert.equal(callback.status, 200, "valid login should mint a session");
    const callbackBody = await callback.text();
    assert.match(callbackBody, /window\.location\.replace\("\/"\)/, "callback must return the HTML return page so the browser lands back on the console");
    sessionValue = sessionCookieValue(callback.headers.getSetCookie(), "asc_session");
    assert.ok(sessionCookieValue, "callback must set the session cookie");

    const me = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/me`, {
      headers: { cookie: `asc_session=${sessionValue}` }
    })).json();
    assert.equal(me.user.tier, "owner");
    assert.equal(me.user.id, USER_ID);
    assert.equal(me.user.username, "fleetyard-operator");
  } finally {
    await stopProcess(console.child);
    await closeDiscordServer(discordServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Discord OAuth callback denies a user outside the home guild", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-e2e-deny-"));
  const console = startConsole(consolePort, discordPort, tempDir);
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    const pendingStateValue = sessionCookieValue(start.headers.getSetCookie() || [], "discord_oauth_state");

    const callback = await fetch(
      `http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=notmember&state=${encodeURIComponent(pendingStateValue)}`,
      { redirect: "manual", headers: { cookie: `discord_oauth_state=${pendingStateValue}` } }
    );
    assert.equal(callback.status, 403, "non-member must be denied");
    assert.match(callback.headers.get("content-type") || "", /text\/html/, "callback failures render an HTML page, not raw JSON");
    const denyBody = await callback.text();
    assert.match(denyBody, /not authorized/i);
    assert.match(denyBody, /href="\/"/, "denial page must link back to the console sign-in");
    assert.ok(!callback.headers.getSetCookie().some((c) => c.startsWith("asc_session=")), "denial must not set a session cookie");
  } finally {
    await stopProcess(console.child);
    await closeDiscordServer(discordServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Discord OAuth start returns 404 when OAuth is not configured", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-e2e-unconfigured-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: apiRoot,
    env: {
      ...process.env,
      DUNE_DOCKER_DIR: tempDir,
      ADMIN_BIND_PORT: String(consolePort),
      ADMIN_PASSWORD: "correct-password",
      ADMIN_SECURE_COOKIES: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForHealth(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    assert.equal(start.status, 404);
    const state = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/state`)).json();
    assert.equal(state.config.discordOAuthConfigured, false);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---- Tier 1: handoff-configured callback behavior ----

const HANDOFF_SECRET = "e2e-handoff-shared-secret";

function startFakeBot(port, { tier = "admin", secret = HANDOFF_SECRET } = {}) {
  const server = createServer((req, res) => {
    if (new URL(req.url, "http://localhost").pathname === "/resolve-console-tier") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const { userId, guildId } = JSON.parse(body || "{}");
        const payload = { userId, guildId, tier, ts: Date.now() };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ...payload, signature: signPayload(payload, secret) }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

test("handoff configured but bot unreachable denies with the HTML error page -- even with a permissive allowlist", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const deadBotPort = await getFreePort(); // freed immediately -- nothing listens
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-e2e-handoff-down-"));
  const console = startConsole(consolePort, discordPort, tempDir, {
    DISCORD_BOT_HANDOFF_SECRET: HANDOFF_SECRET,
    DISCORD_BOT_HANDOFF_URL: `http://127.0.0.1:${deadBotPort}`
  });
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    const pendingStateValue = sessionCookieValue(start.headers.getSetCookie() || [], "discord_oauth_state");

    const callback = await fetch(
      `http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=validcode&state=${encodeURIComponent(pendingStateValue)}`,
      { redirect: "manual", headers: { cookie: `discord_oauth_state=${pendingStateValue}` } }
    );
    assert.equal(callback.status, 403, "handoff failure must deny -- never fall through to the bootstrap allowlist");
    assert.match(callback.headers.get("content-type") || "", /text\/html/);
    const body = await callback.text();
    assert.match(body, /could not verify your current Discord role/i);
    assert.match(body, /href="\/"/, "error page must link back to sign-in");
    assert.ok(!callback.headers.getSetCookie().some((c) => c.startsWith("asc_session=")), "no session may be minted");

    const auditRows = readFileSync(join(tempDir, "runtime", "generated", "web-admin-audit.jsonl"), "utf8");
    assert.match(auditRows, /"auth\.handoff-denied"/, "denial must be recorded under auth.handoff-denied");
    assert.match(auditRows, /"reason":"unreachable"/, "audit row must carry the reason code");
  } finally {
    await stopProcess(console.child);
    await closeDiscordServer(discordServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("handoff configured with bootstrap disabled completes sign-in via the bot (gate no longer requires bootstrap)", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const botPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-e2e-handoff-up-"));
  const console = startConsole(consolePort, discordPort, tempDir, {
    DISCORD_BOT_HANDOFF_SECRET: HANDOFF_SECRET,
    DISCORD_BOT_HANDOFF_URL: `http://127.0.0.1:${botPort}`,
    DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "",
    DISCORD_OAUTH_OWNER_ALLOWLIST: ""
  });
  const discordServer = await startFakeDiscord(discordPort);
  const botServer = await startFakeBot(botPort, { tier: "admin" });
  try {
    await waitForHealth(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    const pendingStateValue = sessionCookieValue(start.headers.getSetCookie() || [], "discord_oauth_state");

    const callback = await fetch(
      `http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=validcode&state=${encodeURIComponent(pendingStateValue)}`,
      { redirect: "manual", headers: { cookie: `discord_oauth_state=${pendingStateValue}` } }
    );
    assert.equal(callback.status, 200, "handoff-backed sign-in must complete without owner bootstrap");
    const sessionValue = sessionCookieValue(callback.headers.getSetCookie(), "asc_session");
    assert.ok(sessionValue, "callback must set the session cookie");

    const me = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/me`, {
      headers: { cookie: `asc_session=${sessionValue}` }
    })).json();
    assert.equal(me.user.tier, "admin", "tier must come from the bot handoff, not the bootstrap allowlist");
  } finally {
    await stopProcess(console.child);
    await closeDiscordServer(discordServer);
    await closeDiscordServer(botServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});


test("a working bot handoff is not blocked by a stale, unsound DISCORD_CONSOLE_*_ROLE_IDS mapping (review finding)", async () => {
  // .env.example documents role-mapping env vars as "ignored entirely when a
  // bot handoff is configured" -- but roleMappingUnsound() used to be checked
  // unconditionally in both /start and the callback, so leftover conflicting
  // role-ID env vars from before switching to handoff mode disabled Discord
  // sign-in entirely, even though the handoff path never reads them.
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const botPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-e2e-handoff-staleroles-"));
  const console = startConsole(consolePort, discordPort, tempDir, {
    DISCORD_BOT_HANDOFF_SECRET: HANDOFF_SECRET,
    DISCORD_BOT_HANDOFF_URL: `http://127.0.0.1:${botPort}`,
    DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "",
    DISCORD_OAUTH_OWNER_ALLOWLIST: "",
    DISCORD_CONSOLE_ADMIN_ROLE_IDS: ADMIN_ROLE,
    DISCORD_CONSOLE_MODERATOR_ROLE_IDS: ADMIN_ROLE,
  });
  const discordServer = await startFakeDiscord(discordPort);
  const botServer = await startFakeBot(botPort, { tier: "admin" });
  try {
    await waitForHealth(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    assert.equal(start.status, 302, "a working handoff must not be blocked by a stale role-mapping conflict it never reads");
    const pendingStateValue = sessionCookieValue(start.headers.getSetCookie() || [], "discord_oauth_state");

    const callback = await fetch(
      `http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=validcode&state=${encodeURIComponent(pendingStateValue)}`,
      { redirect: "manual", headers: { cookie: `discord_oauth_state=${pendingStateValue}` } }
    );
    assert.equal(callback.status, 200, "handoff-backed sign-in must complete despite the stale role-mapping conflict");
    const sessionValue = sessionCookieValue(callback.headers.getSetCookie(), "asc_session");
    assert.ok(sessionValue, "callback must set the session cookie");
    const me = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/me`, {
      headers: { cookie: `asc_session=${sessionValue}` }
    })).json();
    assert.equal(me.user.tier, "admin", "tier must come from the bot handoff, not the (ignored) role mapping");
  } finally {
    await stopProcess(console.child);
    await closeDiscordServer(discordServer);
    await closeDiscordServer(botServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an anonymous callback request with no valid pending state gets the generic invalid/expired page, never internal misconfiguration detail (review finding)", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-cb-anon-noleak-"));
  // Half-configured handoff: handoff.misconfigured is true for the whole
  // process. Before the fix, an anonymous request with no state/cookie at all
  // (never started an OAuth flow) still received this specific
  // "bot handoff is only partially configured" page instead of the generic
  // "invalid or expired" message, because the misconfiguration check ran
  // before the consumed.ok check.
  const console = startConsole(consolePort, discordPort, tempDir, {
    DISCORD_BOT_HANDOFF_SECRET: "a".repeat(32),
    DISCORD_BOT_HANDOFF_URL: "",
  });
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const callback = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/callback`, { redirect: "manual" });
    assert.equal(callback.status, 400, "an anonymous request with no pending state must get the generic invalid/expired response");
    const body = await callback.text();
    assert.match(body, /invalid or expired/i);
    assert.doesNotMatch(body, /bot handoff is only partially configured/i, "must not disclose internal misconfiguration state to a request with no valid pending state");
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

// ---- §2.1.1: console-native role -> tier, enforcement, and the opt-in 2FA gate ----

async function signInWithCode(consolePort, code) {
  const startResponse = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
  const pendingStateValue = sessionCookieValue(startResponse.headers.getSetCookie(), "discord_oauth_state");
  const callback = await fetch(
    `http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=${code}&state=${encodeURIComponent(pendingStateValue)}`,
    { redirect: "manual", headers: { cookie: `discord_oauth_state=${pendingStateValue}` } }
  );
  const body = await callback.text();
  return { status: callback.status, body, sessionValue: sessionCookieValue(callback.headers.getSetCookie(), "asc_session") };
}

const ROLE_ENV = {
  DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "0",
  DISCORD_OAUTH_OWNER_ALLOWLIST: "",
  DISCORD_CONSOLE_ADMIN_ROLE_IDS: ADMIN_ROLE,
  DISCORD_CONSOLE_MODERATOR_ROLE_IDS: MOD_ROLE,
  DISCORD_CONSOLE_PLAYER_ROLE_IDS: PLAYER_ROLE,
};

test("roles: a member holding the mapped moderator role signs in as moderator, and the policy gate holds", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-roles-"));
  const console = startConsole(consolePort, discordPort, tempDir, ROLE_ENV);
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const r = await signInWithCode(consolePort, "moderator");
    assert.equal(r.status, 200, r.body.slice(0, 200));
    const me = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/me`, { headers: { cookie: `asc_session=${r.sessionValue}` } })).json();
    assert.equal(me.user.tier, "moderator");
    assert.ok(me.allowedActions.includes("players:read"));
    assert.ok(!me.allowedActions.includes("settings:read"), "a moderator must not see settings");
    // Enforcement is server-side: the settings API refuses this session.
    const settings = await fetch(`http://127.0.0.1:${consolePort}/api/settings`, { headers: { cookie: `asc_session=${r.sessionValue}` } });
    assert.equal(settings.status, 403);
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

test("roles: the highest mapped role wins (admin + player -> admin)", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-roles-"));
  const console = startConsole(consolePort, discordPort, tempDir, ROLE_ENV);
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const r = await signInWithCode(consolePort, "admin");
    assert.equal(r.status, 200, r.body.slice(0, 200));
    const me = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/me`, { headers: { cookie: `asc_session=${r.sessionValue}` } })).json();
    assert.equal(me.user.tier, "admin");
    // #584: a successful sign-in's audit row used to omit userId entirely --
    // every OTHER branch of this callback (denials/failures) already named
    // it, so a granted session could not be attributed to who actually
    // signed in.
    const auditLines = readFileSync(join(tempDir, "runtime", "generated", "web-admin-audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const success = auditLines.find((l) => l.action === "auth.oauth.callback" && l.detail?.ok === true);
    assert.equal(success?.detail?.userId, USER_ID, "the successful sign-in's audit row must name who signed in");
    assert.equal(success?.detail?.tier, "admin");
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

test("roles: a home-guild member with no mapped role is denied, with no session", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-roles-"));
  const console = startConsole(consolePort, discordPort, tempDir, ROLE_ENV);
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const r = await signInWithCode(consolePort, "norole");
    assert.equal(r.status, 403);
    assert.match(r.body, /not authorized to sign in/);
    assert.equal(r.sessionValue, null);
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

test("2FA gate: opt-in; when set, an admin without Discord 2FA is refused and told why, and one with it is admitted", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-mfa-"));
  const console = startConsole(consolePort, discordPort, tempDir, { ...ROLE_ENV, DISCORD_OAUTH_REQUIRE_MFA_TIERS: "owner,admin" });
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const denied = await signInWithCode(consolePort, "admin");        // admin role, mfa_enabled false
    assert.equal(denied.status, 403);
    assert.match(denied.body, /two-factor authentication on your Discord account/);
    assert.match(denied.body, /admin access/);
    assert.equal(denied.sessionValue, null);
    const admitted = await signInWithCode(consolePort, "mfa");        // admin role, mfa_enabled true
    assert.equal(admitted.status, 200, admitted.body.slice(0, 200));
    const me = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/me`, { headers: { cookie: `asc_session=${admitted.sessionValue}` } })).json();
    assert.equal(me.user.tier, "admin");
    // Ungated tier is unaffected by the gate.
    const mod = await signInWithCode(consolePort, "moderator");
    assert.equal(mod.status, 200);
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

test("guild chosen, no roles mapped: only the server owner can sign in; a plain member is denied", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-owneronly-"));
  const console = startConsole(consolePort, discordPort, tempDir, { DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "0", DISCORD_OAUTH_OWNER_ALLOWLIST: "" });
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const member = await signInWithCode(consolePort, "admin");
    assert.equal(member.status, 403); assert.match(member.body, /not authorized to sign in/);
    const owner = await signInWithCode(consolePort, "guildowner");
    assert.equal(owner.status, 200, owner.body.slice(0, 200));
    const me = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/me`, { headers: { cookie: `asc_session=${owner.sessionValue}` } })).json();
    assert.equal(me.user.tier, "owner");
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

// ---- separation of duties: one Discord role, one tier ----

test("SoD: a hand-edited .env mapping one role to owner AND admin disables Discord sign-in, naming the role", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-sod-"));
  const console = startConsole(consolePort, discordPort, tempDir, { ...ROLE_ENV, DISCORD_CONSOLE_MODERATOR_ROLE_IDS: ADMIN_ROLE });
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    assert.equal(start.status, 403, "must not even send the user to Discord");
    const body = await start.text();
    assert.match(body, /two different access levels/);
    assert.match(body, new RegExp(`role ${ADMIN_ROLE} is mapped to admin and moderator`));
    // Password sign-in is unaffected.
    const login = await fetch(`http://127.0.0.1:${consolePort}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct-password" }) });
    assert.equal(login.status, 200);
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

test("SoD: the settings API refuses to save a mapping that gives one role two tiers, including against already-saved fields", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-sod-save-"));
  const console = startConsole(consolePort, discordPort, tempDir, ROLE_ENV);
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const login = await fetch(`http://127.0.0.1:${consolePort}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct-password" }) });
    const { csrfToken } = await login.json();
    const cookie = `asc_session=${sessionCookieValue(login.headers.getSetCookie(), "asc_session")}`;
    const post = (payload) => fetch(`http://127.0.0.1:${consolePort}/api/setup/write-oauth-config`, { method: "POST", headers: { "content-type": "application/json", cookie, "x-csrf-token": csrfToken }, body: JSON.stringify(payload) });

    // Same role submitted for owner and admin in one request.
    const same = await post({ DISCORD_CONSOLE_MODERATOR_ROLE_IDS: ADMIN_ROLE, DISCORD_CONSOLE_ADMIN_ROLE_IDS: ADMIN_ROLE });
    assert.equal(same.status, 400);
    assert.match((await same.json()).error, /Owner is never a role/);

    // Save a sound admin mapping, then try to add that role as owner in a SEPARATE request.
    assert.equal((await post({ DISCORD_CONSOLE_ADMIN_ROLE_IDS: ADMIN_ROLE })).status, 200);
    const partial = await post({ DISCORD_CONSOLE_MODERATOR_ROLE_IDS: ADMIN_ROLE });
    assert.equal(partial.status, 400, "a partial update must be checked against the fields it did not touch");
    assert.match((await partial.json()).error, new RegExp(`role ${ADMIN_ROLE} is mapped to admin and moderator`));

    // A distinct moderator role is fine; an owner-role key is simply not a thing.
    assert.equal((await post({ DISCORD_CONSOLE_MODERATOR_ROLE_IDS: "400000000000000009" })).status, 200);
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

// #587: validateOAuthWriteConfigKey() validates a TRIMMED copy of every
// submitted value, but the write path used to persist the raw, untrimmed
// value to .env -- a value that passed validation (trailing whitespace
// doesn't fail the snowflake regex against a TRIMMED copy) could then be
// written padded, silently disabling Discord OAuth after the next restart
// (a snowflake with trailing whitespace never equals Discord's real one).
test("writeOAuthConfig persists the trimmed value, not the raw submitted one", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-write-trim-"));
  const console = startConsole(consolePort, discordPort, tempDir, ROLE_ENV);
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const login = await fetch(`http://127.0.0.1:${consolePort}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct-password" }) });
    const { csrfToken } = await login.json();
    const cookie = `asc_session=${sessionCookieValue(login.headers.getSetCookie(), "asc_session")}`;
    const post = (payload) => fetch(`http://127.0.0.1:${consolePort}/api/setup/write-oauth-config`, { method: "POST", headers: { "content-type": "application/json", cookie, "x-csrf-token": csrfToken }, body: JSON.stringify(payload) });

    const paddedGuildId = "300000000000000007  "; // valid snowflake, trailing whitespace
    const res = await post({ DISCORD_HOME_GUILD_ID: paddedGuildId });
    assert.equal(res.status, 200, "a value that trims to a valid snowflake must be accepted");

    const env = readFileSync(join(tempDir, ".env"), "utf8");
    assert.match(env, /^DISCORD_HOME_GUILD_ID="?300000000000000007"?$/m, "the persisted value must be trimmed");
    assert.doesNotMatch(env, /300000000000000007  /, "the padded, untrimmed value must never reach .env");
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});


// ---- owner is the Discord server's owner; the guided setup round-trip ----

test("owner derivation: the server's owner is Owner even with only a player role; owning another server is nothing", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-owner-"));
  const console = startConsole(consolePort, discordPort, tempDir, ROLE_ENV);
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const r = await signInWithCode(consolePort, "guildowner");
    assert.equal(r.status, 200, r.body.slice(0, 200));
    const me = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/me`, { headers: { cookie: `asc_session=${r.sessionValue}` } })).json();
    assert.equal(me.user.tier, "owner");
    assert.ok(me.allowedActions.includes("settings:read"));
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

async function passwordOwnerSession(consolePort) {
  const login = await fetch(`http://127.0.0.1:${consolePort}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct-password" }) });
  const { csrfToken } = await login.json();
  return { cookie: `asc_session=${sessionCookieValue(login.headers.getSetCookie(), "asc_session")}`, csrfToken };
}

test("guided setup: an owner's setup-mode round-trip captures identity + guilds, mints NO session, and only an owner may start it", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-setup-"));
  // App configured (id/secret/redirect) but NO home guild yet -- the state the wizard is in at step 2.
  const console = startConsole(consolePort, discordPort, tempDir, { DISCORD_HOME_GUILD_ID: "", DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "0", DISCORD_OAUTH_OWNER_ALLOWLIST: "" });
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    // Login-mode start is refused without a guild; setup-mode start is not.
    assert.equal((await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start?setup=1`, { redirect: "manual" })).status, 401, "anonymous may not start setup");

    const owner = await passwordOwnerSession(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start?setup=1`, { redirect: "manual", headers: { cookie: owner.cookie } });
    assert.equal(start.status, 302);
    const state = sessionCookieValue(start.headers.getSetCookie(), "discord_oauth_state");
    const cb = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=guildowner&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { cookie: `discord_oauth_state=${state}` } });
    assert.equal(cb.status, 200);
    assert.match(await cb.text(), /discordSetup=done/);
    assert.equal(sessionCookieValue(cb.headers.getSetCookie(), "asc_session"), null, "setup mode must mint no session");

    const identity = await (await fetch(`http://127.0.0.1:${consolePort}/api/setup/discord-identity`, { headers: { cookie: owner.cookie } })).json();
    assert.equal(identity.user.id, USER_ID);
    assert.deepEqual(identity.guilds.map((g) => [g.name, g.owner]), [["Fleetyard", true]], "only owned servers are exposed to setup");
    // A stranger's session sees nothing.
    assert.equal((await fetch(`http://127.0.0.1:${consolePort}/api/setup/discord-identity`)).status, 401);
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});


test("guided setup: anonymous cannot start; the owner round-trip mints no session; finalize needs no password but requires an owned server", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-setupfin-"));
  const console = startConsole(consolePort, discordPort, tempDir, { DISCORD_HOME_GUILD_ID: "", DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "0", DISCORD_OAUTH_OWNER_ALLOWLIST: "" });
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    assert.equal((await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start?setup=1`, { redirect: "manual" })).status, 401, "no password, no Discord round-trip");

    const owner = await passwordOwnerSession(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start?setup=1`, { redirect: "manual", headers: { cookie: owner.cookie } });
    assert.equal(start.status, 302);
    const state = sessionCookieValue(start.headers.getSetCookie(), "discord_oauth_state");
    const cb = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=guildowner&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { cookie: `discord_oauth_state=${state}` } });
    assert.equal(cb.status, 200);
    assert.equal(sessionCookieValue(cb.headers.getSetCookie(), "asc_session"), null, "setup mode mints no session");

    const H = { cookie: owner.cookie, "x-csrf-token": owner.csrfToken, "content-type": "application/json" };
    const identity = await (await fetch(`http://127.0.0.1:${consolePort}/api/setup/discord-identity`, { headers: H })).json();
    assert.deepEqual(identity.guilds.map((g) => [g.name, g.owner]), [["Fleetyard", true]], "only owned servers are exposed to setup");
    const fin = (body) => fetch(`http://127.0.0.1:${consolePort}/api/setup/discord-finalize`, { method: "POST", headers: H, body: JSON.stringify(body) });

    // No password: the owner session is the proof, plus guild ownership. A
    // server not in the owned list the console captured is refused.
    let r = await fin({ guildId: "123456789012345678", adminRoleIds: ADMIN_ROLE });
    assert.equal(r.status, 400); assert.match((await r.json()).error, /Choose one of your Discord servers/);
    r = await fin({ guildId: HOME_GUILD, adminRoleIds: ADMIN_ROLE, moderatorRoleIds: ADMIN_ROLE });
    assert.equal(r.status, 400, "separation of duties applies here too");
    // This owner's OWN Discord account has no 2FA (mfa_enabled=false), so
    // asking to REQUIRE 2FA for owner/admin would lock them out of Discord
    // sign-in after the restart -- finalize must refuse that combination and
    // leave the captured identity intact for a retry.
    r = await fin({ guildId: HOME_GUILD, adminRoleIds: ADMIN_ROLE, playerRoleIds: PLAYER_ROLE, requireMfa: true });
    const lockoutBody = await r.json();
    assert.equal(r.status, 400, JSON.stringify(lockoutBody)); assert.match(lockoutBody.error, /two-factor/i);
    // Clearing the requirement is the correct path for an owner without 2FA.
    r = await fin({ guildId: HOME_GUILD, adminRoleIds: ADMIN_ROLE, playerRoleIds: PLAYER_ROLE, requireMfa: false });
    const okText = await r.text();
    assert.equal(r.status, 200, okText);
    const ok = JSON.parse(okText);
    assert.equal(ok.guild.name, "Fleetyard"); assert.equal(ok.owner.id, USER_ID); assert.equal(ok.restartRequired, true);
    // The sign-in page now reports "configured -- restart pending" (not the
    // setup entry), so an operator between finalize and restart is not looped.
    const afterState = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/state`)).json();
    assert.equal(afterState.config.discordSetupPendingRestart, true);
    const env = readFileSync(join(tempDir, ".env"), "utf8");
    assert.match(env, new RegExp(`^DISCORD_HOME_GUILD_ID="?${HOME_GUILD}"?$`, "m"));
    assert.match(env, new RegExp(`^DISCORD_CONSOLE_ADMIN_ROLE_IDS="?${ADMIN_ROLE}"?$`, "m"));
    assert.match(env, /^DISCORD_OAUTH_REQUIRE_MFA_TIERS=""?$/m, "an owner without Discord 2FA cannot require it");
    // The captured identity is consumed; the owner session itself lives on.
    assert.equal((await fetch(`http://127.0.0.1:${consolePort}/api/setup/discord-identity`, { headers: H })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${consolePort}/api/auth/me`, { headers: H })).status, 200);
    // Anonymous finalize is refused outright (owner session required).
    assert.equal((await fetch(`http://127.0.0.1:${consolePort}/api/setup/discord-finalize`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

// ---- C1 regression: the auth-config routes are OWNER-only ----
// A Discord admin/moderator session must NOT be able to rewrite the console's
// own auth config or self-restart -- gating these on setup:write (which admin
// holds) was an admin->owner privilege escalation.

test("auth-config routes reject a non-owner Discord session (admin/moderator), owner allowed", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "authcfg-owner-"));
  const console = startConsole(consolePort, discordPort, tempDir, ROLE_ENV);
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const mod = await signInWithCode(consolePort, "moderator");
    assert.equal(mod.status, 200);
    const H = { cookie: `asc_session=${mod.sessionValue}`, "content-type": "application/json" };
    const csrf = (await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/state`, { headers: H })).json()).csrfToken;
    const post = (path, body) => fetch(`http://127.0.0.1:${consolePort}${path}`, { method: "POST", headers: { ...H, "x-csrf-token": csrf }, body: JSON.stringify(body || {}) });

    // Every auth-config route must be 403 for a moderator.
    assert.equal((await post("/api/setup/write-oauth-config", { DISCORD_OAUTH_OWNER_ALLOWLIST: USER_ID })).status, 403, "moderator must not write oauth config");
    assert.equal((await post("/api/setup/save-oauth-secret", { secret: "x".repeat(30) })).status, 403, "moderator must not save the client secret");
    assert.equal((await post("/api/setup/discord-finalize", { guildId: HOME_GUILD, adminRoleIds: ADMIN_ROLE })).status, 403, "moderator must not finalize");
    assert.equal((await post("/api/setup/discord-restart", {})).status, 403, "moderator must not self-restart the console");
    assert.equal((await fetch(`http://127.0.0.1:${consolePort}/api/setup/discord-identity`, { headers: H })).status, 403, "moderator must not read setup identity");

    // Sanity: the moderator's escalation payload did not poison .env (it may not
    // exist at all -- config came from env vars -- which equally proves nothing
    // was written).
    let env = "";
    try { env = readFileSync(join(tempDir, ".env"), "utf8"); } catch { /* no .env == nothing written */ }
    assert.doesNotMatch(env, /^DISCORD_OAUTH_OWNER_ALLOWLIST=/m, "moderator's write must not have landed");
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

// ---- C2 regression: GET /api/settings/iam/policies returns the editor's catalog ----
test("iam/policies returns the action catalog (policies + actions + actionMap + namespaces)", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "iam-catalog-"));
  const console = startConsole(consolePort, discordPort, tempDir, ROLE_ENV);
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const owner = await signInWithCode(consolePort, "guildowner");
    assert.equal(owner.status, 200);
    const res = await fetch(`http://127.0.0.1:${consolePort}/api/settings/iam/policies`, { headers: { cookie: `asc_session=${owner.sessionValue}` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.policies && body.policies.owner, "policies present");
    assert.ok(Array.isArray(body.actions) && body.actions.length > 0, "actions[] present (the editor reads catalog.actions)");
    assert.ok(body.actionMap && typeof body.actionMap === "object", "actionMap present (route -> IAM action)");
    assert.ok(body.namespaces && typeof body.namespaces === "object", "namespaces present");
    // `actions` is the action-name vocabulary (upstream's own contract, see
    // policyActionValidation.test.js's "the policies endpoint hands back the
    // vocabulary"), not route keys -- it no longer indexes into actionMap.
    // The editor itself reads allActions/actionMap, never actions (see
    // IamPolicyEditor.tsx), so this just pins that every entry is a real,
    // known action.
    for (const action of body.actions) assert.ok(body.allActions.includes(action), `${action} is a known action`);
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

test("guided setup: an owner WHOSE Discord account has 2FA may require it -- finalize writes owner,admin (positive case)", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-setupmfa-"));
  const console = startConsole(consolePort, discordPort, tempDir, { DISCORD_HOME_GUILD_ID: "", DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "0", DISCORD_OAUTH_OWNER_ALLOWLIST: "" });
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const owner = await passwordOwnerSession(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start?setup=1`, { redirect: "manual", headers: { cookie: owner.cookie } });
    const state = sessionCookieValue(start.headers.getSetCookie(), "discord_oauth_state");
    // code "guildowner-mfa": owner of the home guild AND mfa_enabled=true.
    const cb = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=guildowner-mfa&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { cookie: `discord_oauth_state=${state}` } });
    assert.equal(cb.status, 200);

    const H = { cookie: owner.cookie, "x-csrf-token": owner.csrfToken, "content-type": "application/json" };
    const identity = await (await fetch(`http://127.0.0.1:${consolePort}/api/setup/discord-identity`, { headers: H })).json();
    assert.equal(identity.user.mfaEnabled, true, "the captured owner has Discord 2FA");

    const r = await fetch(`http://127.0.0.1:${consolePort}/api/setup/discord-finalize`, { method: "POST", headers: H, body: JSON.stringify({ guildId: HOME_GUILD, adminRoleIds: ADMIN_ROLE, playerRoleIds: PLAYER_ROLE, requireMfa: true }) });
    assert.equal(r.status, 200, await r.text());
    const env = readFileSync(join(tempDir, ".env"), "utf8");
    assert.match(env, /^DISCORD_OAUTH_REQUIRE_MFA_TIERS="?owner,admin"?$/m, "an owner with 2FA may require it");
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

test("guided setup: finalize does not clobber an already-configured owner-bootstrap allowlist (review finding)", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-setup-nobootstrap-clobber-"));
  const { writeFileSync } = await import("node:fs");
  // Pre-seed .env exactly as an operator who already configured a second-owner
  // bootstrap allowlist (the documented DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP=1 +
  // DISCORD_OAUTH_OWNER_ALLOWLIST path) would have on disk before ever running
  // the guided wizard.
  writeFileSync(join(tempDir, ".env"), 'DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP="1"\nDISCORD_OAUTH_OWNER_ALLOWLIST="999999999999999999"\n');
  const console = startConsole(consolePort, discordPort, tempDir, { DISCORD_HOME_GUILD_ID: "", DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "1", DISCORD_OAUTH_OWNER_ALLOWLIST: "999999999999999999" });
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const owner = await passwordOwnerSession(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start?setup=1`, { redirect: "manual", headers: { cookie: owner.cookie } });
    const state = sessionCookieValue(start.headers.getSetCookie(), "discord_oauth_state");
    const cb = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=guildowner&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { cookie: `discord_oauth_state=${state}` } });
    assert.equal(cb.status, 200);
    const H = { cookie: owner.cookie, "x-csrf-token": owner.csrfToken, "content-type": "application/json" };
    const r = await fetch(`http://127.0.0.1:${consolePort}/api/setup/discord-finalize`, { method: "POST", headers: H, body: JSON.stringify({ guildId: HOME_GUILD, adminRoleIds: ADMIN_ROLE, requireMfa: false }) });
    assert.equal(r.status, 200, await r.text());
    const env = readFileSync(join(tempDir, ".env"), "utf8");
    assert.match(env, /DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP="?1"?/, "finalize must not clobber an existing owner-bootstrap allowlist setting");
    assert.match(env, /DISCORD_OAUTH_OWNER_ALLOWLIST="?999999999999999999"?/, "finalize must not touch the owner allowlist it has no field for");
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

test("Discord sign-in attempts silently (prompt=none) and, when interaction is needed, retries LOUDLY interactively; a decline fails loudly", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-silent-"));
  const console = startConsole(consolePort, discordPort, tempDir);
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);

    // start attempts silently: the authorize redirect carries prompt=none.
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    assert.equal(start.status, 302);
    assert.match(start.headers.get("location"), /[?&]prompt=none(&|$)/, "start attempts prompt=none");
    const state = sessionCookieValue(start.headers.getSetCookie(), "discord_oauth_state");

    // Discord could not complete silently -> ?error=login_required with no code.
    // The console retries INTERACTIVELY (no prompt=none) with a fresh state cookie.
    const retry = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/callback?error=login_required&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { cookie: `discord_oauth_state=${state}` } });
    assert.equal(retry.status, 302, "needs-interaction error retries, not errors out");
    const retryLoc = retry.headers.get("location");
    assert.match(retryLoc, /oauth2\/authorize/, "retry goes back to Discord");
    assert.doesNotMatch(retryLoc, /prompt=none/, "retry is interactive");
    assert.ok(sessionCookieValue(retry.headers.getSetCookie(), "discord_oauth_state"), "retry sets a fresh state cookie");

    // A genuine decline fails LOUDLY (403 readable page), not a silent loop.
    const start2 = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    const state2 = sessionCookieValue(start2.headers.getSetCookie(), "discord_oauth_state");
    const denied = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/callback?error=access_denied&state=${encodeURIComponent(state2)}`,
      { redirect: "manual", headers: { cookie: `discord_oauth_state=${state2}` } });
    assert.equal(denied.status, 403, "an explicit decline is a loud 403");
    assert.match((await denied.text()).toLowerCase(), /cancel|admin password/, "loud, actionable error page");
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

// ---- review finding: /start was unmetered (the login limiter only counts
// failures, which /start never records), so a loop could fill the pending-state
// table. It is now metered per client. ----
test("GET /api/auth/discord/start is rate-limited per client after a burst", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-start-rate-"));
  const console = startConsole(consolePort, discordPort, tempDir);
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    let limited = null;
    for (let i = 0; i < 40; i += 1) {
      const response = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
      if (response.status === 429) { limited = { at: i, retryAfter: response.headers.get("retry-after") }; break; }
      assert.equal(response.status, 302, `request ${i} should still redirect`);
    }
    assert.ok(limited, "a 40-request burst from one client must hit the per-client /start limit");
    assert.ok(limited.at >= 10, `the limit must be generous enough for a human (tripped at ${limited.at})`);
    assert.ok(Number(limited.retryAfter) > 0, "429 must carry retry-after");
  } finally {
    await stopProcess(console.child);
    await closeDiscordServer(discordServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("GET /api/auth/discord/start?setup=1 is rate-limited per client after a burst, same as the login-mode branch (review finding)", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-setup-start-rate-"));
  const console = startConsole(consolePort, discordPort, tempDir);
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const owner = await passwordOwnerSession(consolePort);
    let limited = null;
    for (let i = 0; i < 40; i += 1) {
      const response = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start?setup=1`, { redirect: "manual", headers: { cookie: owner.cookie } });
      if (response.status === 429) { limited = { at: i, retryAfter: response.headers.get("retry-after") }; break; }
      assert.equal(response.status, 302, `request ${i} should still redirect`);
    }
    assert.ok(limited, "a 40-request burst against setup-mode start (an authenticated-but-possibly-replayed owner cookie) must also hit a per-client limit");
    assert.ok(Number(limited.retryAfter) > 0, "429 must carry retry-after");
  } finally {
    await stopProcess(console.child);
    await closeDiscordServer(discordServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// #578 review finding: every OTHER failure branch in handleOAuthCallback
// calls oauthCallbackRateLimiter.recordFailure() -- the setup-purpose
// "owner session ended mid-authorization" branch didn't, so repeated hits of
// specifically this failure mode never counted toward the same limiter.
// Reproduced by actually exhausting the shared, IP-keyed bucket via this
// exact failure mode: log in as owner, start setup, log the owner session
// out, then complete the callback with the still-valid state -- repeated
// until the limiter trips, proving recordFailure now actually fires here.
test("repeatedly hitting the setup-purpose owner-session-gone failure trips the same rate limiter every other callback failure does", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-setup-ownergone-rate-"));
  const console = startConsole(consolePort, discordPort, tempDir);
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    let limited = null;
    for (let i = 0; i < 12; i += 1) {
      const owner = await passwordOwnerSession(consolePort);
      const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start?setup=1`, { redirect: "manual", headers: { cookie: owner.cookie } });
      assert.equal(start.status, 302, `request ${i}: setup start should still redirect`);
      const state = sessionCookieValue(start.headers.getSetCookie(), "discord_oauth_state");
      // End the owner session BEFORE the callback lands -- the exact
      // scenario the "owner session ended while Discord was authorizing"
      // branch exists for.
      await fetch(`http://127.0.0.1:${consolePort}/api/auth/logout`, { method: "POST", headers: { cookie: owner.cookie, "x-csrf-token": owner.csrfToken } });
      const cb = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=guildowner&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { cookie: `discord_oauth_state=${state}` } });
      if (cb.status === 429) { limited = { at: i, retryAfter: cb.headers.get("retry-after") }; break; }
      assert.equal(cb.status, 403, `request ${i}: should fail as owner_session_gone, not something else`);
    }
    assert.ok(limited, "repeated owner-session-gone failures must trip the shared callback rate limiter, the same as every other failure branch");
    assert.ok(Number(limited.retryAfter) > 0, "429 must carry retry-after");
  } finally {
    await stopProcess(console.child);
    await closeDiscordServer(discordServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---- review finding: the setup-mode callback was blocked by the exact
// misconfigurations (a half-configured handoff, an unsound role mapping)
// that the guided setup wizard exists to let an owner fix. The /start route
// already exempted setup mode from these checks (its setup branch returns
// before reaching them); the callback did not. ----

test("guided setup: an unsound role mapping does not block the setup-mode callback (only login mode)", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-setup-roleconflict-"));
  // Same role mapped to two tiers -- roleMappingUnsound() is true for the
  // whole process, exactly the state an owner opens the wizard to repair.
  const console = startConsole(consolePort, discordPort, tempDir, {
    DISCORD_CONSOLE_ADMIN_ROLE_IDS: ADMIN_ROLE,
    DISCORD_CONSOLE_MODERATOR_ROLE_IDS: ADMIN_ROLE,
  });
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    // Login mode is still refused loudly -- the fix must not weaken this path.
    const loginStart = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    assert.equal(loginStart.status, 403, "login-mode start still refuses an unsound role mapping");

    const owner = await passwordOwnerSession(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start?setup=1`, { redirect: "manual", headers: { cookie: owner.cookie } });
    assert.equal(start.status, 302, "setup-mode start is unaffected");
    const state = sessionCookieValue(start.headers.getSetCookie(), "discord_oauth_state");
    const cb = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=guildowner&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { cookie: `discord_oauth_state=${state}` } });
    assert.equal(cb.status, 200, "the wizard must be able to complete its round-trip to let the owner fix the conflict");
    assert.match(await cb.text(), /discordSetup=done/);
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

test("guided setup: a half-configured bot handoff does not block the setup-mode callback (only login mode)", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-setup-handoff-"));
  // Handoff secret set, URL missing -- half-configured, handoff.misconfigured
  // is true for the whole process.
  const console = startConsole(consolePort, discordPort, tempDir, {
    DISCORD_BOT_HANDOFF_SECRET: "a".repeat(32),
    DISCORD_BOT_HANDOFF_URL: "",
  });
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    const loginStart = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    assert.equal(loginStart.status, 403, "login-mode start still refuses a half-configured handoff");

    const owner = await passwordOwnerSession(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start?setup=1`, { redirect: "manual", headers: { cookie: owner.cookie } });
    assert.equal(start.status, 302, "setup-mode start is unaffected");
    const state = sessionCookieValue(start.headers.getSetCookie(), "discord_oauth_state");
    const cb = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=guildowner&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { cookie: `discord_oauth_state=${state}` } });
    assert.equal(cb.status, 200, "the wizard must be able to complete its round-trip even with a half-configured handoff");
    assert.match(await cb.text(), /discordSetup=done/);
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

// ---- review finding: the silent-auth interactive retry issued a pending
// state with no `owner`, unlike every other issue() call site, pooling the
// most common real-world path (every /start attempt tries prompt=none
// first) into a shared, unattributed bucket and defeating the per-owner
// eviction guarantee oauth.js's pending-state store otherwise provides. A
// full behavioral proof needs 256+ real requests to force eviction; pinning
// the exact wiring in the source is the precedent this codebase already
// uses for gate-composition correctness (see rbacParity.test.js's ENROLL_ALLOWED
// text scan) and is what mutation-tests here. ----
// ---- review finding (upstream PR #202, 2026-09-06): a callback already
// waiting on Discord could still issue a session after Disable/Forget
// succeeded ----

// Same shape as startFakeDiscord() above, but the token exchange for a code
// containing "slow" is held open for `delayMs` before responding -- long
// enough for a concurrent Disable/Forget request to complete server-side
// while this callback is still in flight, without relying on real network
// jitter to create the race window.
function startSlowFakeDiscord(port, delayMs) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/oauth2/token") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const code = new URLSearchParams(body).get("code") || "";
        const respond = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: `token-${code}`, token_type: "Bearer", expires_in: 604800 }));
        };
        if (code.includes("slow")) setTimeout(respond, delayMs);
        else respond();
      });
      return;
    }
    if (url.pathname === "/users/@me") {
      const auth = String(req.headers.authorization || "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: USER_ID, username: "fleetyard-operator", mfa_enabled: false }));
      return;
    }
    if (url.pathname === `/users/@me/guilds/${HOME_GUILD}/member`) {
      const auth = String(req.headers.authorization || "");
      const roles = auth.includes("token-admin") ? [ADMIN_ROLE, PLAYER_ROLE] : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ user: { id: USER_ID }, roles }));
      return;
    }
    if (url.pathname === "/users/@me/guilds") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: HOME_GUILD, name: "Fleetyard", owner: false }]));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

test("a callback already waiting on Discord cannot issue a session after Disable succeeds in the meantime", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-inflight-disable-"));
  const console = startConsole(consolePort, discordPort, tempDir);
  const discordServer = await startSlowFakeDiscord(discordPort, 400);
  try {
    await waitForHealth(consolePort);

    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    const pendingStateValue = sessionCookieValue(start.headers.getSetCookie() || [], "discord_oauth_state");

    // Fire the callback but do NOT await it yet -- its token exchange is
    // being held open by the fake Discord server above.
    const callbackPromise = fetch(
      `http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=admin-slow&state=${encodeURIComponent(pendingStateValue)}`,
      { redirect: "manual", headers: { cookie: `discord_oauth_state=${pendingStateValue}` } }
    );

    // While that callback is still in flight, disable Discord sign-in via a
    // completely separate, already-authenticated owner session -- exactly
    // Red-Blink's reported sequence ("a callback already waiting on Discord").
    await new Promise((r) => setTimeout(r, 100)); // let the callback pass its entry gate and start the (slow) token exchange
    const owner = await passwordOwnerSession(consolePort);
    const disable = await fetch(`http://127.0.0.1:${consolePort}/api/settings/discord-oauth/disable`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner.cookie, "x-csrf-token": owner.csrfToken },
      body: JSON.stringify({ currentPassword: "correct-password" }),
    });
    assert.equal(disable.status, 200, "disable itself must succeed");

    // NOW the in-flight callback's (slow) token exchange finally resolves.
    const callback = await callbackPromise;
    assert.notEqual(callback.status, 200, "an in-flight callback must not succeed once Discord sign-in was disabled during its own request");
    assert.ok(
      !(callback.headers.getSetCookie() || []).some((c) => c.startsWith("asc_session=")),
      "an in-flight callback must not issue a session after a concurrent Disable succeeded"
    );

    // Confirm Discord sign-in is genuinely, immediately off -- not just that
    // this one callback happened to lose a race.
    const state = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/state`)).json();
    assert.equal(state.config.discordOAuthDisabled, true);
  } finally {
    await stopProcess(console.child);
    await closeDiscordServer(discordServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the silent-auth interactive retry attributes its pending state to an owner, like every other issue() call site", () => {
  const source = readFileSync(join(apiRoot, "server.js"), "utf8");
  const retryLine = source.split("\n").find((line) => line.includes("purpose: consumed.purpose, sessionId: consumed.sessionId"));
  assert.ok(retryLine, "the silent-auth retry's issue() call was not found where expected");
  assert.match(retryLine, /owner:\s*\w/, "the retry must pass an owner key, or a flood of retries pools into one shared, unattributed bucket");
});

// #627 (Requirement 24): DISCORD_OAUTH_CLIENT_SECRET and
// DISCORD_BOT_HANDOFF_SECRET as plain env vars used to get no startup
// warning at all -- an env var is visible to any process on the host that
// can read this process's environment (ps, /proc/<pid>/environ), unlike a
// runtime/secrets/ file. The default startConsole() env already sets
// DISCORD_OAUTH_CLIENT_SECRET as a plain env var.
test("DISCORD_OAUTH_CLIENT_SECRET set as a plain env var produces a startup security warning", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-secret-warning-"));
  const console = startConsole(consolePort, discordPort, tempDir);
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    assert.match(console.logs(), /DISCORD_OAUTH_CLIENT_SECRET is set as a plain environment variable/);
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

test("DISCORD_BOT_HANDOFF_SECRET set as a plain env var produces a startup security warning", async () => {
  const consolePort = await getFreePort(); const discordPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-handoff-warning-"));
  const console = startConsole(consolePort, discordPort, tempDir, { DISCORD_BOT_HANDOFF_SECRET: "a-handoff-secret", DISCORD_BOT_HANDOFF_URL: "http://127.0.0.1:1/handoff" });
  const discordServer = await startFakeDiscord(discordPort);
  try {
    await waitForHealth(consolePort);
    assert.match(console.logs(), /DISCORD_BOT_HANDOFF_SECRET is set as a plain environment variable/);
  } finally { await stopProcess(console.child); await closeDiscordServer(discordServer); rmSync(tempDir, { recursive: true, force: true }); }
});

// ---- Discord Bot Settings: admin-role-change gate (audit finding #2) ----
//
// Reuses the startConsole/startFakeDiscord/startFakeBot harness above to
// get a REAL admin-tier session cookie over the wire (the fake bot's
// handoff response just declares tier: "admin" directly -- no guild-role
// mocking needed), then exercises the real
// POST /api/settings/discord-bot/enable route end-to-end and asserts a
// real 403 comes back for a request that changes adminRoleIds. This
// closes the specific gap a prior review round flagged: the pure
// discordAdminRoleIdsChanged() unit tests (discordAdapterSettings.test.js)
// and the structural route-wiring checks (discordBotSettingsRoutes.test.js)
// are real and stay -- this is additionally the one HTTP-level proof that
// an actual non-owner session gets rejected over the wire.
test("admin-tier session gets a real 403 changing Discord admin role IDs via POST /api/settings/discord-bot/enable", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const botPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-e2e-discordbot-admin403-"));
  const console = startConsole(consolePort, discordPort, tempDir, {
    DISCORD_BOT_HANDOFF_SECRET: HANDOFF_SECRET,
    DISCORD_BOT_HANDOFF_URL: `http://127.0.0.1:${botPort}`,
    DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "",
    DISCORD_OAUTH_OWNER_ALLOWLIST: ""
  });
  const discordServer = await startFakeDiscord(discordPort);
  const botServer = await startFakeBot(botPort, { tier: "admin" });
  try {
    await waitForHealth(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    const pendingStateValue = sessionCookieValue(start.headers.getSetCookie() || [], "discord_oauth_state");

    const callback = await fetch(
      `http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=validcode&state=${encodeURIComponent(pendingStateValue)}`,
      { redirect: "manual", headers: { cookie: `discord_oauth_state=${pendingStateValue}` } }
    );
    assert.equal(callback.status, 200, "handoff-backed sign-in must complete");
    const sessionValue = sessionCookieValue(callback.headers.getSetCookie(), "asc_session");
    assert.ok(sessionValue, "callback must mint a real session cookie");

    const me = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/me`, {
      headers: { cookie: `asc_session=${sessionValue}` }
    })).json();
    assert.equal(me.user.tier, "admin", "sanity check: this really is an admin-tier session, not owner");

    // POST routes require the CSRF header to match the session -- fetch it
    // via /api/auth/state, the same source the real frontend uses.
    const authState = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/state`, {
      headers: { cookie: `asc_session=${sessionValue}` }
    })).json();
    assert.ok(authState.csrfToken, "must have a real CSRF token to exercise the route properly");

    const response = await fetch(`http://127.0.0.1:${consolePort}/api/settings/discord-bot/enable`, {
      method: "POST",
      headers: {
        cookie: `asc_session=${sessionValue}`,
        "x-csrf-token": authState.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({ playerRoleIds: "", moderatorRoleIds: "", adminRoleIds: "999999999999999999" })
    });
    assert.equal(response.status, 403, "an admin-tier session must be rejected over the wire when the request changes adminRoleIds");
    const body = await response.json();
    // Upstream-port structural difference (dune-awakening-selfhost-docker
    // wizard-port to tier1-upstream): fork main's actions.js comment
    // assumed updates:apply is admin-reachable ("admin is denied
    // settings:* but IS allowed updates:*"), so this test originally
    // expected the request to reach server.js's own specific
    // discordAdminRoleIdsChanged()-driven 403 ("...requires owner
    // access."). tier1-upstream's own policy.js treats updates:apply as
    // a crown-jewel, owner-only action (CROWN_JEWEL_DENY_ACTIONS) -- a
    // real, deliberate, stricter security posture already established
    // there, not something this port should weaken. An admin-tier
    // session is now rejected by the earlier, coarser actionForRoute()/
    // evaluate() gate before ever reaching the route handler's own
    // finer-grained check, so the generic permission-denied message is
    // now the correct, expected outcome -- STRICTLY stronger protection
    // than the original assertion required, not weaker.
    assert.match(body.error || "", /permission/i, "an admin-tier session must still be rejected, even if the exact wording differs from fork main's weaker default policy");
  } finally {
    await stopProcess(console.child);
    await closeDiscordServer(discordServer);
    await closeDiscordServer(botServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// Real UAT finding (2026-09-09, "I see no path to remove the bot"): same
// harness and reasoning as the admin-role-id-change 403 test directly
// above, for the new owner-only POST /api/settings/discord-bot/disable
// route -- discordAdapterSettingsPolicy.test.js already proves
// evaluate({tier: "admin"}, "settings:discord-bot-disable") === false, this
// is the one HTTP-level proof that a real non-owner session is rejected
// over the wire.
test("admin-tier session gets a real 403 disabling the Discord Bot adapter via POST /api/settings/discord-bot/disable", async () => {
  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const botPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "oauth-e2e-discordbot-disable403-"));
  const console = startConsole(consolePort, discordPort, tempDir, {
    DISCORD_BOT_HANDOFF_SECRET: HANDOFF_SECRET,
    DISCORD_BOT_HANDOFF_URL: `http://127.0.0.1:${botPort}`,
    DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "",
    DISCORD_OAUTH_OWNER_ALLOWLIST: ""
  });
  const discordServer = await startFakeDiscord(discordPort);
  const botServer = await startFakeBot(botPort, { tier: "admin" });
  try {
    await waitForHealth(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    const pendingStateValue = sessionCookieValue(start.headers.getSetCookie() || [], "discord_oauth_state");

    const callback = await fetch(
      `http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=validcode&state=${encodeURIComponent(pendingStateValue)}`,
      { redirect: "manual", headers: { cookie: `discord_oauth_state=${pendingStateValue}` } }
    );
    assert.equal(callback.status, 200, "handoff-backed sign-in must complete");
    const sessionValue = sessionCookieValue(callback.headers.getSetCookie(), "asc_session");
    assert.ok(sessionValue, "callback must mint a real session cookie");

    const me = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/me`, {
      headers: { cookie: `asc_session=${sessionValue}` }
    })).json();
    assert.equal(me.user.tier, "admin", "sanity check: this really is an admin-tier session, not owner");

    const authState = await (await fetch(`http://127.0.0.1:${consolePort}/api/auth/state`, {
      headers: { cookie: `asc_session=${sessionValue}` }
    })).json();
    assert.ok(authState.csrfToken, "must have a real CSRF token to exercise the route properly");

    const response = await fetch(`http://127.0.0.1:${consolePort}/api/settings/discord-bot/disable`, {
      method: "POST",
      headers: {
        cookie: `asc_session=${sessionValue}`,
        "x-csrf-token": authState.csrfToken,
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
    assert.equal(response.status, 403, "an admin-tier session must be rejected over the wire disabling the adapter");
  } finally {
    await stopProcess(console.child);
    await closeDiscordServer(discordServer);
    await closeDiscordServer(botServer);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
