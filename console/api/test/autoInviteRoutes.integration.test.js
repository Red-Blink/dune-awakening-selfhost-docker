// Phase 6 (dune-awakening-selfhost-docker#832's design, §4.1/§4.4): exercises
// the two new fully-automated auto-invite routes over a real HTTP request
// through the real server.js entrypoint -- same discipline as
// hostedBotRegistrationRoutes.integration.test.js for the OLD hosted-bot
// OAuth flow, whose fake-listener / cookie-extraction helpers this file
// mirrors rather than re-deriving.

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

// Fake mentat-link /auto-invite/start proxy -- a real, local, listening
// server standing in for the real (live) mentat-link.darkdante.org via the
// MENTAT_LINK_AUTO_INVITE_START_URL test-only env override (config.js).
// `state` is deliberately the caller-controlled knob under test: the state
// value mentat "mints" and hands back to Core, which Core must then record
// verbatim (autoInvite.js's own documented reasoning for why issue() takes
// mentat's state as input rather than minting a second one).
function startFakeMentatLinkStart(port, { status = 200, state = "mentat-minted-state", body } = {}) {
  let hitCount = 0;
  const requests = [];
  const server = createServer((req, res) => {
    hitCount += 1;
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      requests.push(JSON.parse(raw || "{}"));
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body !== undefined ? body : { state }));
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, hits: () => hitCount, requests: () => requests })));
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

function cookieFrom(setCookies, name) {
  const entries = Array.isArray(setCookies) ? setCookies : [setCookies];
  const entry = entries.find((v) => v && v.startsWith(`${name}=`));
  return entry ? entry.split(";")[0].slice(name.length + 1) : null;
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([new Promise((r) => child.once("exit", r)), new Promise((r) => setTimeout(r, 5000))]);
}

async function closeServer(server) {
  try { server.closeAllConnections?.(); } catch { /* best effort */ }
  return new Promise((resolve) => server.close(() => resolve()));
}

function api(port, path, { method, cookie, csrf, body, extraCookie } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = `asc_session=${cookie}${extraCookie ? `; ${extraCookie}` : ""}`;
  if (csrf) headers["x-csrf-token"] = csrf;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: method || (body !== undefined ? "POST" : "GET"),
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual"
  });
}

async function loginAsOwner(port, password = ADMIN_PASSWORD) {
  const res = await api(port, "/api/auth/login", { method: "POST", body: { password } });
  const body = await res.json();
  return { status: res.status, cookie: cookieFrom(res.headers.getSetCookie(), "asc_session"), csrf: body.csrfToken };
}

test("POST /api/integrations/discord/hosted-bot/auto-invite/start requires a real session (401 unauthenticated)", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-unauth-"));
  const console_ = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/auto-invite/start", { method: "POST", body: { consoleUrl: "https://console.example.test" } });
    assert.equal(res.status, 401, "an unauthenticated request must never reach the route handler");
  } finally {
    await stopProcess(console_.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST .../auto-invite/start is owner-only -- an admin-tier session gets a real 403, and mentat-link records zero hits", async () => {
  // Reuses the exact admin-tier-via-bot-handoff harness already proven in
  // hostedBotRegistrationRoutes.integration.test.js's own analogous test,
  // rather than re-deriving a second way to mint an admin session.
  const { createServer: createHttpServer } = await import("node:http");
  const { signPayload } = await import("../src/integrations/discord/handoff.js");
  const HOME_GUILD = "111111111111111111";
  const USER_ID = "222222222222222222";
  const HANDOFF_SECRET = "e2e-handoff-shared-secret";

  const consolePort = await getFreePort();
  const discordPort = await getFreePort();
  const botPort = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-admin403-"));

  const discordServer = await new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/oauth2/token") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          const code = new URLSearchParams(body).get("code") || "";
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ access_token: `token-${code}`, token_type: "Bearer", expires_in: 604800 }));
        });
        return;
      }
      if (url.pathname === "/users/@me") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: USER_ID, username: "fleetyard-operator" }));
        return;
      }
      if (url.pathname === "/users/@me/guilds") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ id: HOME_GUILD }]));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    server.listen(discordPort, "127.0.0.1", () => resolve(server));
  });
  const botServer = await new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
      if (new URL(req.url, "http://localhost").pathname === "/resolve-console-tier") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          const { userId, guildId } = JSON.parse(body || "{}");
          const payload = { userId, guildId, tier: "admin", ts: Date.now() };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ...payload, signature: signPayload(payload, HANDOFF_SECRET) }));
        });
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    server.listen(botPort, "127.0.0.1", () => resolve(server));
  });
  const mentatLink = await startFakeMentatLinkStart(mentatLinkPort);

  const console_ = startConsole(consolePort, tempDir, {
    DISCORD_OAUTH_CLIENT_ID: "client-id",
    DISCORD_OAUTH_CLIENT_SECRET: "client-secret",
    DISCORD_OAUTH_REDIRECT_URI: `http://127.0.0.1:${consolePort}/api/auth/discord/callback`,
    DISCORD_OAUTH_BASE_URL: `http://127.0.0.1:${discordPort}`,
    DISCORD_HOME_GUILD_ID: HOME_GUILD,
    DISCORD_BOT_HANDOFF_SECRET: HANDOFF_SECRET,
    DISCORD_BOT_HANDOFF_URL: `http://127.0.0.1:${botPort}`,
    DISCORD_OAUTH_ALLOW_OWNER_BOOTSTRAP: "",
    DISCORD_OAUTH_OWNER_ALLOWLIST: "",
    MENTAT_LINK_AUTO_INVITE_START_URL: `http://127.0.0.1:${mentatLinkPort}/api/consoles/auto-invite/start`
  });
  try {
    await waitForHealth(consolePort);
    const start = await fetch(`http://127.0.0.1:${consolePort}/api/auth/discord/start`, { redirect: "manual" });
    const pendingStateValue = cookieFrom(start.headers.getSetCookie() || [], "discord_oauth_state");
    const callback = await fetch(
      `http://127.0.0.1:${consolePort}/api/auth/discord/callback?code=validcode&state=${encodeURIComponent(pendingStateValue)}`,
      { redirect: "manual", headers: { cookie: `discord_oauth_state=${pendingStateValue}` } }
    );
    const sessionValue = cookieFrom(callback.headers.getSetCookie(), "asc_session");
    assert.ok(sessionValue, "callback must mint a real session cookie");

    const response = await fetch(`http://127.0.0.1:${consolePort}/api/integrations/discord/hosted-bot/auto-invite/start`, {
      method: "POST",
      headers: { cookie: `asc_session=${sessionValue}`, "content-type": "application/json" },
      body: JSON.stringify({ consoleUrl: "https://console.example.test" })
    });
    assert.equal(response.status, 403, "an admin-tier session must be rejected over the wire -- the auto-invite flow is owner-only, matching the old flow's own gating");
    assert.equal(mentatLink.hits(), 0, "the IAM gate must reject before the route body ever runs, so mentat-link must never see a request");
  } finally {
    await stopProcess(console_.child);
    await closeServer(discordServer);
    await closeServer(botServer);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST .../auto-invite/start rejects a non-https consoleUrl with 400 before ever calling mentat-link", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-nonhttps-"));
  const console_ = startConsole(port, tempDir, {
    MENTAT_LINK_AUTO_INVITE_START_URL: `http://127.0.0.1:${mentatLinkPort}/api/consoles/auto-invite/start`
  });
  const mentatLink = await startFakeMentatLinkStart(mentatLinkPort);
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/auto-invite/start", {
      method: "POST", cookie: session.cookie, csrf: session.csrf, body: { consoleUrl: "http://insecure.example.com" }
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error || "", /https/i);
    assert.equal(mentatLink.hits(), 0, "an invalid consoleUrl must be rejected before any outbound call to mentat-link");
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST .../auto-invite/start rejects a malformed consoleUrl with 400", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-malformed-"));
  const console_ = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/auto-invite/start", {
      method: "POST", cookie: session.cookie, csrf: session.csrf, body: { consoleUrl: "not a url" }
    });
    assert.equal(res.status, 400);
  } finally {
    await stopProcess(console_.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST .../auto-invite/start succeeds end-to-end: silently enables the hosted adapter, forwards consoleUrl+adapterToken to mentat-link, and returns a real Discord authorizeUrl", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-success-"));
  const console_ = startConsole(port, tempDir, {
    MENTAT_LINK_AUTO_INVITE_START_URL: `http://127.0.0.1:${mentatLinkPort}/api/consoles/auto-invite/start`,
    AUTO_INVITE_DISCORD_REDIRECT_URI: "https://mentat-link.darkdante.org/api/consoles/auto-invite/callback"
  });
  const mentatLink = await startFakeMentatLinkStart(mentatLinkPort, { state: "real-mentat-state-value" });
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);

    // Deliberately never called POST /api/settings/discord-bot/enable first
    // -- design doc §4.1 step 1 requires this route to silently enable the
    // hosted deployment + mint an adapter token on its own, matching the
    // old wizard's own first-step behavior, so an operator never has to
    // visit a separate screen first.
    const consoleUrl = "https://console.example.test";
    const res = await api(port, "/api/integrations/discord/hosted-bot/auto-invite/start", {
      method: "POST", cookie: session.cookie, csrf: session.csrf, body: { consoleUrl }
    });
    assert.equal(res.status, 200, "must succeed on a fresh console with no prior hosted-bot setup");
    const body = await res.json();
    assert.match(body.authorizeUrl || "", /^https:\/\/discord\.com\/oauth2\/authorize/);
    const authorizeUrl = new URL(body.authorizeUrl);
    assert.equal(authorizeUrl.searchParams.get("state"), "real-mentat-state-value", "must use mentat's own minted state, not a fresh one of Core's own");
    assert.equal(authorizeUrl.searchParams.get("redirect_uri"), "https://mentat-link.darkdante.org/api/consoles/auto-invite/callback");

    const stateCookie = cookieFrom(res.headers.getSetCookie() || [], "auto_invite_state");
    assert.equal(stateCookie, "real-mentat-state-value", "the state cookie must carry the exact same value that round-trips through Discord and back");

    assert.equal(mentatLink.hits(), 1);
    const [forwarded] = mentatLink.requests();
    assert.equal(forwarded.consoleUrl, consoleUrl);
    assert.ok(forwarded.adapterToken, "must forward a real, freshly-minted adapter token");

    // Confirm the silent-enable side effect actually took (design doc §4.1
    // step 1) -- a subsequent /api/settings/discord-bot read must reflect
    // deploymentChoice: hosted and tokenConfigured: true.
    const settingsState = await (await api(port, "/api/settings/discord-bot", { cookie: session.cookie })).json();
    assert.equal(settingsState.deploymentChoice, "hosted");
    assert.equal(settingsState.tokenConfigured, true);
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// Layer 2 audit finding, CRITICAL (#866): tokenConfigured and role-ID
// configuration are independent env vars -- an operator can have real
// role IDs already set via the documented legacy env-var path
// (discordRoleMappingFromEnv()) while never having minted a hosted-bot
// adapter token. The silent-enable step above must never destroy that
// existing configuration just because it's minting a token for the
// first time.
test("POST .../auto-invite/start preserves an operator's existing role-ID configuration when silently minting a first-time adapter token", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-preserve-roles-"));
  const console_ = startConsole(port, tempDir, {
    MENTAT_LINK_AUTO_INVITE_START_URL: `http://127.0.0.1:${mentatLinkPort}/api/consoles/auto-invite/start`,
    // Real, pre-existing role-ID configuration -- deliberately NOT going
    // through POST /api/settings/discord-bot/enable first, matching the
    // documented legacy path where these were hand-set in .env before the
    // hosted-bot adapter token ever existed.
    DISCORD_PLAYER_ROLE_IDS: "111111111111111111",
    DISCORD_MODERATOR_ROLE_IDS: "222222222222222222",
    DISCORD_ADMIN_ROLE_IDS: "333333333333333333"
  });
  const mentatLink = await startFakeMentatLinkStart(mentatLinkPort);
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);

    const before = await (await api(port, "/api/settings/discord-bot", { cookie: session.cookie })).json();
    assert.equal(before.tokenConfigured, false, "sanity check: no adapter token minted yet");
    assert.deepEqual(before.roleIds, { player: ["111111111111111111"], moderator: ["222222222222222222"], admin: ["333333333333333333"] });

    const res = await api(port, "/api/integrations/discord/hosted-bot/auto-invite/start", {
      method: "POST", cookie: session.cookie, csrf: session.csrf, body: { consoleUrl: "https://console.example.test" }
    });
    assert.equal(res.status, 200, "the route must still succeed while minting the first-time token");

    const after = await (await api(port, "/api/settings/discord-bot", { cookie: session.cookie })).json();
    assert.equal(after.tokenConfigured, true, "a token must now be minted");
    assert.deepEqual(
      after.roleIds,
      { player: ["111111111111111111"], moderator: ["222222222222222222"], admin: ["333333333333333333"] },
      "the operator's pre-existing role-ID configuration must survive the silent first-time token mint, not be wiped to empty"
    );
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST .../auto-invite/start returns 502 when mentat-link is unreachable, and never mints a pending state for it", async () => {
  const port = await getFreePort();
  const unreachablePort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-unreachable-"));
  const console_ = startConsole(port, tempDir, {
    MENTAT_LINK_AUTO_INVITE_START_URL: `http://127.0.0.1:${unreachablePort}/api/consoles/auto-invite/start`
  });
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/auto-invite/start", {
      method: "POST", cookie: session.cookie, csrf: session.csrf, body: { consoleUrl: "https://console.example.test" }
    });
    assert.equal(res.status, 502);
  } finally {
    await stopProcess(console_.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST .../auto-invite/start returns 502 when mentat-link rejects the request", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-rejected-"));
  const console_ = startConsole(port, tempDir, {
    MENTAT_LINK_AUTO_INVITE_START_URL: `http://127.0.0.1:${mentatLinkPort}/api/consoles/auto-invite/start`
  });
  const mentatLink = await startFakeMentatLinkStart(mentatLinkPort, { status: 401, body: { error: "bad proxy secret" } });
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/auto-invite/start", {
      method: "POST", cookie: session.cookie, csrf: session.csrf, body: { consoleUrl: "https://console.example.test" }
    });
    assert.equal(res.status, 502);
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("POST .../auto-invite/start returns 502 when mentat-link's response body has no usable state", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-badbody-"));
  const console_ = startConsole(port, tempDir, {
    MENTAT_LINK_AUTO_INVITE_START_URL: `http://127.0.0.1:${mentatLinkPort}/api/consoles/auto-invite/start`
  });
  const mentatLink = await startFakeMentatLinkStart(mentatLinkPort, { body: { unexpected: "shape" } });
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/auto-invite/start", {
      method: "POST", cookie: session.cookie, csrf: session.csrf, body: { consoleUrl: "https://console.example.test" }
    });
    assert.equal(res.status, 502);
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("GET .../auto-invite/complete requires no session (reached via a plain top-level browser navigation, not an authenticated API call)", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-complete-noauth-"));
  const console_ = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    // Deliberately no asc_session cookie at all. This route sits alongside
    // the IAM-gated routes in server.js's central dispatch, so unlike a
    // typical "public" route it DOES pass through requireAuth()+evaluate()
    // -- the real question this test locks in is what actually happens.
    const res = await fetch(`http://127.0.0.1:${port}/api/integrations/discord/hosted-bot/auto-invite/complete?state=x&ok=true`, { redirect: "manual" });
    assert.equal(res.status, 401, "an unauthenticated top-level navigation to this route is rejected the same way every other IAM-gated route is");
  } finally {
    await stopProcess(console_.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("GET .../auto-invite/complete rejects a state/cookie mismatch with 400 and clears the state cookie", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-complete-mismatch-"));
  const console_ = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const res = await fetch(`http://127.0.0.1:${port}/api/integrations/discord/hosted-bot/auto-invite/complete?state=bogus-state&ok=true`, {
      redirect: "manual",
      headers: { cookie: `asc_session=${session.cookie}; auto_invite_state=bogus-state` }
    });
    assert.equal(res.status, 400, "an unrecognized state must be rejected -- no real /start call ever issued this state");
    assert.match(res.headers.get("content-type") || "", /text\/html/, "this is a top-level browser navigation, must return real HTML");
    const cleared = (res.headers.getSetCookie() || []).some((c) => c.startsWith("auto_invite_state=;"));
    assert.ok(cleared, "the auto_invite_state cookie must be cleared on a failed consume");
  } finally {
    await stopProcess(console_.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("auto-invite/start -> auto-invite/complete round trip succeeds and renders the real outcome via postMessage, without touching persistHostedBotConnectedGuild", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-roundtrip-"));
  const console_ = startConsole(port, tempDir, {
    MENTAT_LINK_AUTO_INVITE_START_URL: `http://127.0.0.1:${mentatLinkPort}/api/consoles/auto-invite/start`
  });
  const mentatLink = await startFakeMentatLinkStart(mentatLinkPort, { state: "roundtrip-state-value" });
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);

    const start = await api(port, "/api/integrations/discord/hosted-bot/auto-invite/start", {
      method: "POST", cookie: session.cookie, csrf: session.csrf, body: { consoleUrl: "https://console.example.test" }
    });
    assert.equal(start.status, 200);
    const stateCookie = cookieFrom(start.headers.getSetCookie() || [], "auto_invite_state");
    assert.equal(stateCookie, "roundtrip-state-value");

    // Simulates mentat-link's own bounce page performing a top-level
    // navigation back to this exact route with the signed-and-verified
    // outcome fields as query params -- Core's own job here is just to
    // consume its own double-submit state cookie and hand the outcome to
    // the popup's opener; the actual signature verification already
    // happened on mentat-link's side (see that repo's return.js), which is
    // out of scope for THIS integration test.
    const complete = await fetch(
      `http://127.0.0.1:${port}/api/integrations/discord/hosted-bot/auto-invite/complete?state=${encodeURIComponent(stateCookie)}&ok=true&guildName=${encodeURIComponent("Fleetyard")}&reclaimed=false&confirmationId=confirmation-xyz`,
      { redirect: "manual", headers: { cookie: `asc_session=${session.cookie}; auto_invite_state=${stateCookie}` } }
    );
    assert.equal(complete.status, 200);
    const text = await complete.text();
    assert.match(text, /Request sent — check Discord to confirm the connection\./);
    assert.match(text, /"guildName":"Fleetyard"/);
    assert.match(text, /"ok":true/);
    assert.match(text, /"confirmationId":"confirmation-xyz"/);
    const clearedState = (complete.headers.getSetCookie() || []).some((c) => c.startsWith("auto_invite_state=;"));
    assert.ok(clearedState, "the now-consumed auto_invite_state cookie must be cleared");
    // Round 4 Layer 2 audit fix: on a real ok:true outcome with a
    // confirmationId, /complete must set the double-submit cookie the new
    // /confirmation-status route requires.
    const confirmationIdCookie = cookieFrom(complete.headers.getSetCookie() || [], "auto_invite_confirmation_id");
    assert.equal(confirmationIdCookie, "confirmation-xyz");

    // ok:true here means "staged and owner notified," not "connected" --
    // this route must never mark the guild as connected on its own (design
    // doc §7's own reasoning, mirrored in server.js's own comment at this
    // route). A subsequent read of the persisted hosted-bot connection
    // state must show it untouched.
    const settingsState = await (await api(port, "/api/settings/discord-bot", { cookie: session.cookie })).json();
    assert.equal(settingsState.hostedBotConnection?.guildId, undefined, "auto-invite/complete must never itself persist a connected guild");

    // The state must be genuinely single-use -- replaying the exact same
    // completed URL a second time must fail, matching the old flow's own
    // single-use pending-registration-handle guarantee.
    const replay = await fetch(
      `http://127.0.0.1:${port}/api/integrations/discord/hosted-bot/auto-invite/complete?state=${encodeURIComponent(stateCookie)}&ok=true`,
      { redirect: "manual", headers: { cookie: `asc_session=${session.cookie}; auto_invite_state=${stateCookie}` } }
    );
    assert.equal(replay.status, 400, "a state can never be consumed twice");
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("auto-invite/complete renders ok:false with the caller's reason when mentat's own bounce reports a failure", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-failure-outcome-"));
  const console_ = startConsole(port, tempDir, {
    MENTAT_LINK_AUTO_INVITE_START_URL: `http://127.0.0.1:${mentatLinkPort}/api/consoles/auto-invite/start`
  });
  const mentatLink = await startFakeMentatLinkStart(mentatLinkPort, { state: "failure-state-value" });
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const start = await api(port, "/api/integrations/discord/hosted-bot/auto-invite/start", {
      method: "POST", cookie: session.cookie, csrf: session.csrf, body: { consoleUrl: "https://console.example.test" }
    });
    const stateCookie = cookieFrom(start.headers.getSetCookie() || [], "auto_invite_state");

    const complete = await fetch(
      `http://127.0.0.1:${port}/api/integrations/discord/hosted-bot/auto-invite/complete?state=${encodeURIComponent(stateCookie)}&ok=false&reason=owner_changed`,
      { redirect: "manual", headers: { cookie: `asc_session=${session.cookie}; auto_invite_state=${stateCookie}` } }
    );
    assert.equal(complete.status, 200, "a signaled ok:false outcome still gets a normal 200 render -- the 400 status is reserved for THIS route's own state-consume failure, not an upstream-reported failure");
    const text = await complete.text();
    assert.match(text, /Could not connect\. Check the console for details\./);
    assert.match(text, /"ok":false/);
    assert.match(text, /"reason":"owner_changed"/);
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ─── GET /api/integrations/discord/hosted-bot/auto-invite/confirmation-status
// (dune-awakening-selfhost-docker#876, design doc §13, round 4): the
// completion-signal poll. Before this route existed, Core had no way to
// ever learn whether/when the Discord owner actually confirmed. ──────────

// Fake mentat-link /confirmation-status proxy, mirroring
// startFakeMentatLinkStart()'s own pattern above.
function startFakeMentatLinkConfirmationStatus(port, { status = 200, body = { status: "pending" } } = {}) {
  let hitCount = 0;
  const requestUrls = [];
  const server = createServer((req, res) => {
    hitCount += 1;
    requestUrls.push(req.url);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, hits: () => hitCount, urls: () => requestUrls })));
}

test("GET .../auto-invite/confirmation-status requires a real session (401 unauthenticated)", async () => {
  const port = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-confirmation-status-noauth-"));
  const console_ = startConsole(port, tempDir);
  try {
    await waitForHealth(port);
    const res = await fetch(`http://127.0.0.1:${port}/api/integrations/discord/hosted-bot/auto-invite/confirmation-status?confirmationId=x`, { redirect: "manual" });
    assert.equal(res.status, 401);
  } finally {
    await stopProcess(console_.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("GET .../auto-invite/confirmation-status requires the confirmationId query param (400, never calls mentat-link)", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-confirmation-status-missing-id-"));
  const console_ = startConsole(port, tempDir, {
    MENTAT_LINK_CONFIRMATION_STATUS_URL: `http://127.0.0.1:${mentatLinkPort}/api/consoles/auto-invite/confirmation-status`
  });
  const mentatLink = await startFakeMentatLinkConfirmationStatus(mentatLinkPort);
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/auto-invite/confirmation-status", { cookie: session.cookie });
    assert.equal(res.status, 400);
    assert.equal(mentatLink.hits(), 0, "a missing confirmationId must never reach mentat-link at all");
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// Layer 2 audit finding on this exact route: a valid session alone was
// not enough to trust an arbitrary caller-supplied confirmationId --
// persisting the wrong guild has a real, if narrow, blast radius. These
// two tests lock in the double-submit-cookie fix.
test("GET .../auto-invite/confirmation-status rejects a confirmationId with no matching cookie at all (403), never reaching mentat-link", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-confirmation-status-no-cookie-"));
  const console_ = startConsole(port, tempDir, {
    MENTAT_LINK_CONFIRMATION_STATUS_URL: `http://127.0.0.1:${mentatLinkPort}/api/consoles/auto-invite/confirmation-status`
  });
  const mentatLink = await startFakeMentatLinkConfirmationStatus(mentatLinkPort, { body: { status: "confirmed", guildId: "999999999999999999", guildName: "Attacker Guild" } });
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    // A valid session, but this browser never went through /complete for
    // this (or any) confirmationId -- no auto_invite_confirmation_id
    // cookie at all, simulating an attacker-crafted link/CSRF attempt.
    const res = await api(port, "/api/integrations/discord/hosted-bot/auto-invite/confirmation-status?confirmationId=attacker-chosen-id", { cookie: session.cookie });
    assert.equal(res.status, 403);
    assert.equal(mentatLink.hits(), 0, "an unverified confirmationId must never even reach mentat-link");

    const settings = await (await api(port, "/api/settings/discord-bot", { cookie: session.cookie })).json();
    assert.equal(settings.hostedBotConnectedGuildId, null, "nothing must be persisted from an unverified request");
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("GET .../auto-invite/confirmation-status rejects a confirmationId that does NOT match the double-submit cookie (403) -- the actual CSRF-style attack this fix closes", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-confirmation-status-mismatch-"));
  const console_ = startConsole(port, tempDir, {
    MENTAT_LINK_CONFIRMATION_STATUS_URL: `http://127.0.0.1:${mentatLinkPort}/api/consoles/auto-invite/confirmation-status`
  });
  const mentatLink = await startFakeMentatLinkConfirmationStatus(mentatLinkPort, { body: { status: "confirmed", guildId: "999999999999999999", guildName: "Attacker Guild" } });
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    // This browser DID legitimately go through /complete for its OWN
    // confirmationId ("real-own-id") -- but the request here asks about a
    // DIFFERENT one ("attacker-chosen-id"), exactly what an attacker
    // exploiting a leaked/staged confirmationId would attempt against a
    // logged-in operator's browser.
    const res = await api(port, "/api/integrations/discord/hosted-bot/auto-invite/confirmation-status?confirmationId=attacker-chosen-id", {
      cookie: session.cookie,
      extraCookie: "auto_invite_confirmation_id=real-own-id"
    });
    assert.equal(res.status, 403);
    assert.equal(mentatLink.hits(), 0);
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("GET .../auto-invite/confirmation-status forwards confirmationId to mentat-link and returns its status verbatim when still pending", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-confirmation-status-pending-"));
  const console_ = startConsole(port, tempDir, {
    MENTAT_LINK_CONFIRMATION_STATUS_URL: `http://127.0.0.1:${mentatLinkPort}/api/consoles/auto-invite/confirmation-status`
  });
  const mentatLink = await startFakeMentatLinkConfirmationStatus(mentatLinkPort, { body: { status: "pending" } });
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/auto-invite/confirmation-status?confirmationId=abc123", { cookie: session.cookie, extraCookie: "auto_invite_confirmation_id=abc123" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "pending");
    assert.equal(mentatLink.hits(), 1);
    assert.match(mentatLink.urls()[0], /confirmationId=abc123/);
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// This is THE closing test for issue #876 -- the console actually learning
// a connection succeeded, and persisting it the same way the OLD flow's
// own /register route already does.
test("GET .../auto-invite/confirmation-status persists the connected guild via persistHostedBotConnectedGuild when mentat-link reports confirmed", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-confirmation-status-confirmed-"));
  const console_ = startConsole(port, tempDir, {
    MENTAT_LINK_CONFIRMATION_STATUS_URL: `http://127.0.0.1:${mentatLinkPort}/api/consoles/auto-invite/confirmation-status`
  });
  const mentatLink = await startFakeMentatLinkConfirmationStatus(mentatLinkPort, { body: { status: "confirmed", guildId: "111111111111111111", guildName: "Fleetyard" } });
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);

    const res = await api(port, "/api/integrations/discord/hosted-bot/auto-invite/confirmation-status?confirmationId=abc123", { cookie: session.cookie, extraCookie: "auto_invite_confirmation_id=abc123" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "confirmed");
    assert.equal(body.guildName, "Fleetyard");

    // The real assertion: this actually reached persistHostedBotConnectedGuild(),
    // reflected on a subsequent settings read -- exactly the gap issue #876
    // exists to close.
    const settings = await (await api(port, "/api/settings/discord-bot", { cookie: session.cookie })).json();
    assert.equal(settings.hostedBotConnectedGuildId, "111111111111111111");
    assert.equal(settings.hostedBotConnectedGuildName, "Fleetyard");
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// Automated review finding on this PR's own first commit: guildId (unlike
// guildName) never went through any format check before reaching
// persistHostedBotConnectedGuild() -- this route is the first caller to
// source guildId from a response Core doesn't independently re-verify, so
// a compromised/buggy/MITM'd mentat-link could otherwise inject a
// malicious guildId into the same .env-write/shell-source path issue #870
// hardened guildName against.
test("GET .../auto-invite/confirmation-status does NOT persist a malformed (non-snowflake) guildId from mentat-link", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-confirmation-status-bad-guildid-"));
  const console_ = startConsole(port, tempDir, {
    MENTAT_LINK_CONFIRMATION_STATUS_URL: `http://127.0.0.1:${mentatLinkPort}/api/consoles/auto-invite/confirmation-status`
  });
  const mentatLink = await startFakeMentatLinkConfirmationStatus(mentatLinkPort, { body: { status: "confirmed", guildId: "not-a-real-snowflake-$(evil)", guildName: "Fleetyard" } });
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/auto-invite/confirmation-status?confirmationId=abc123", { cookie: session.cookie, extraCookie: "auto_invite_confirmation_id=abc123" });
    assert.equal(res.status, 200, "the poll response itself is still returned normally to the frontend");

    const settings = await (await api(port, "/api/settings/discord-bot", { cookie: session.cookie })).json();
    assert.equal(settings.hostedBotConnectedGuildId, null, "a malformed guildId must never be persisted, regardless of what mentat-link claims");
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("GET .../auto-invite/confirmation-status does NOT persist anything when the status is denied/pending/not_found", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-confirmation-status-denied-"));
  const console_ = startConsole(port, tempDir, {
    MENTAT_LINK_CONFIRMATION_STATUS_URL: `http://127.0.0.1:${mentatLinkPort}/api/consoles/auto-invite/confirmation-status`
  });
  const mentatLink = await startFakeMentatLinkConfirmationStatus(mentatLinkPort, { body: { status: "denied" } });
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/auto-invite/confirmation-status?confirmationId=abc123", { cookie: session.cookie, extraCookie: "auto_invite_confirmation_id=abc123" });
    const body = await res.json();
    assert.equal(body.status, "denied");

    const settings = await (await api(port, "/api/settings/discord-bot", { cookie: session.cookie })).json();
    assert.equal(settings.hostedBotConnectedGuildId, null, "a denied outcome must never persist a connected guild");
  } finally {
    await stopProcess(console_.child);
    await closeServer(mentatLink.server);
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("GET .../auto-invite/confirmation-status returns 502 when mentat-link is unreachable", async () => {
  const port = await getFreePort();
  const mentatLinkPort = await getFreePort();
  const tempDir = mkdtempSync(join(tmpdir(), "auto-invite-routes-e2e-confirmation-status-unreachable-"));
  const console_ = startConsole(port, tempDir, {
    MENTAT_LINK_CONFIRMATION_STATUS_URL: `http://127.0.0.1:${mentatLinkPort}/api/consoles/auto-invite/confirmation-status`
  });
  try {
    await waitForHealth(port);
    const session = await loginAsOwner(port);
    const res = await api(port, "/api/integrations/discord/hosted-bot/auto-invite/confirmation-status?confirmationId=abc123", { cookie: session.cookie, extraCookie: "auto_invite_confirmation_id=abc123" });
    assert.equal(res.status, 502);
  } finally {
    await stopProcess(console_.child);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
