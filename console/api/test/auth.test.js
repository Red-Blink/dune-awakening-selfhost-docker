import test from "node:test";
import assert from "node:assert/strict";
import { scryptSync, createHmac } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth, clearSessionCookie, setSessionCookie, json, serializeJsonResponse } from "../src/auth.js";

test("persisted sessions reject tampering, password changes and cross-instance contamination", t => {
  const dir = mkdtempSync(join(tmpdir(), "auth-persistence-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = { sessionSecret: "synthetic-secret", adminPassword: "synthetic-password", sessionStoreFile: join(dir, "sessions.json") };
  const first = createAuth(config);
  const session = first.makeSession({ tier: "player", username: "Name:with:colons" });
  const req = { headers: { cookie: `asc_session=${session.cookie}` } };
  assert.equal(createAuth(config).readSession(req)?.tier, "player");
  assert.equal(createAuth({ ...config, adminPassword: "changed-password" }).readSession(req), null);
  const tampered = JSON.parse(readFileSync(config.sessionStoreFile, "utf8"));
  tampered.sessions[0].tier = "owner";
  writeFileSync(config.sessionStoreFile, JSON.stringify(tampered));
  assert.equal(createAuth(config).readSession(req), null);
  assert.equal(createAuth({ ...config, sessionStoreFile: undefined }).readSession(req), null);
  first.revokeSession(req);
  assert.equal(createAuth(config).readSession(req), null);
});

test("auth creates readable signed sessions", async () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false });
  const session = auth.makeSession();
  const req = { headers: { cookie: `asc_session=${encodeURIComponent(session.cookie)}` } };
  assert.equal(auth.readSession(req)?.id, session.id);
  assert.equal(await auth.passwordMatches("admin"), true);
  assert.equal(await auth.passwordMatches("wrong"), false);
});

test("session persistence uses versioned credential-derived MACs and expires legacy stores", t => {
  const dir = mkdtempSync(join(tmpdir(), 'auth-kdf-persistence-'));
  t.after(() => rmSync(dir, {recursive:true,force:true}));
  const config = {sessionSecret:'synthetic-instance-key',adminPassword:'Synthetic-Password-123!',sessionStoreFile:join(dir,'sessions.json')};
  const auth = createAuth(config), session = auth.makeSession({tier:'player'});
  const store = JSON.parse(readFileSync(config.sessionStoreFile,'utf8'));
  assert.equal(store.version,2);
  const entry = store.sessions[0];
  const key = scryptSync(config.adminPassword,`dune-session-store-v2:${config.sessionSecret}`,32,{N:32768,r:8,p:3,maxmem:64*1024*1024});
  const expected = createHmac('sha256',key).update(JSON.stringify([entry.id,entry.csrf,entry.expiresAt,entry.tier,'','','',false])).digest('base64url');
  assert.equal(entry.mac,expected);
  assert.ok(!readFileSync(config.sessionStoreFile,'utf8').includes(config.adminPassword));
  const req={headers:{cookie:`asc_session=${session.cookie}`}};
  assert.equal(createAuth(config).readSession(req)?.id,session.id);
  assert.equal(createAuth({...config,sessionSecret:'different-instance-key'}).readSession(req),null);
  writeFileSync(config.sessionStoreFile,JSON.stringify({version:1,sessions:[entry]}));
  assert.equal(createAuth(config).readSession(req),null);
});

test("auth accepts a file-backed scrypt password from another Console build", async () => {
  const password = "Dummy-Console-Password-123";
  const salt = "0123456789abcdef0123456789abcdef";
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const auth = createAuth({
    sessionSecret: "secret",
    adminPassword: `scrypt$${salt}$${key.toString("hex")}`,
    adminPasswordEnvManaged: false,
    authDisabled: false
  });

  assert.equal(await auth.passwordMatches(password), true);
  assert.equal(await auth.passwordMatches("wrong"), false);
});

test("auth keeps tier and identity in the server-side session while the cookie remains opaque", () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false });
  const session = auth.makeSession({ tier: "moderator", userId: "123", username: "Tester" });
  assert.equal(session.cookie.split(".")[0], session.id);
  assert.equal(auth.readSession({ headers: { cookie: `asc_session=${encodeURIComponent(session.cookie)}` } })?.tier, "moderator");

});

test("auth uses the injected clock for session expiry", () => {
  let currentTime = 1_700_000_000_000;
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false, now: () => currentTime });
  const session = auth.makeSession();
  currentTime += 12 * 60 * 60 * 1000 + 1;
  assert.equal(auth.readSession({ headers: { cookie: `asc_session=${encodeURIComponent(session.cookie)}` } }), null);
});

test("auth rejects state-changing requests without CSRF token", () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false });
  const session = auth.makeSession();
  const req = { method: "POST", headers: { cookie: `asc_session=${encodeURIComponent(session.cookie)}` } };
  const res = fakeResponse();
  assert.equal(auth.requireAuth(req, res), null);
  assert.equal(res.status, 403);
});

test("auth accepts state-changing requests with CSRF token", () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false });
  const session = auth.makeSession();
  const req = { method: "POST", headers: { cookie: `asc_session=${encodeURIComponent(session.cookie)}`, "x-csrf-token": session.csrf } };
  const res = fakeResponse();
  assert.equal(auth.requireAuth(req, res)?.id, session.id);
  assert.equal(res.status, null);
});

test("session cookies can opt into Secure for production/container deployments", () => {
  const res = fakeResponse();
  setSessionCookie(res, { cookie: "abc.sig" }, { secureCookies: true });
  assert.match(res.headers["Set-Cookie"], /HttpOnly/);
  assert.match(res.headers["Set-Cookie"], /SameSite=Lax/);
  assert.match(res.headers["Set-Cookie"], /Secure/);

  clearSessionCookie(res, { secureCookies: true });
  assert.match(res.headers["Set-Cookie"], /Max-Age=0/);
  assert.match(res.headers["Set-Cookie"], /Secure/);
});

test("json responses include defensive browser headers", () => {
  const res = fakeResponse();
  json(res, 200, { ok: true });
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.match(res.headers["permissions-policy"], /camera=\(\)/);
  assert.match(res.headers["content-security-policy"], /default-src 'self'/);
});

test("auth persists and restores HMAC-authenticated sessions across restarts when sessionStoreFile is configured", () => {
  const dir = mkdtempSync(join(tmpdir(), "auth-sessions-"));
  try {
    const sessionStoreFile = join(dir, "sessions.json");
    const firstAuth = createAuth({ sessionSecret: "persist-secret", adminPassword: "admin", authDisabled: false, sessionStoreFile });
    const session = firstAuth.makeSession({ tier: "owner", username: "Paul" });
    const restartedAuth = createAuth({ sessionSecret: "persist-secret", adminPassword: "admin", authDisabled: false, sessionStoreFile });
    const restored = restartedAuth.readSession({ headers: { cookie: `asc_session=${encodeURIComponent(session.cookie)}` } });
    assert.equal(restored?.id, session.id);
    assert.equal(restored?.csrf, session.csrf);
    assert.equal(restored?.username, "Paul");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("json response serialization preserves ordinary public payloads", () => {
  const output = serializeJsonResponse({ ok: true, result: { status: "ready" } });
  assert.deepEqual(JSON.parse(output), { ok: true, result: { status: "ready" } });
});

function fakeResponse() {
  return {
    status: null,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(status, headers = {}) {
      this.status = status;
      Object.assign(this.headers, headers);
    },
    end(body) {
      this.body = body;
    }
  };
}

test("peekSession checks a session without renewing its idle expiry", () => {
  let currentTime = 1_700_000_000_000;
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false, now: () => currentTime });
  const session = auth.makeSession();
  const req = { headers: { cookie: `asc_session=${encodeURIComponent(session.cookie)}` } };
  const first = auth.peekSession(req).expiresAt;
  currentTime += 60 * 60 * 1000;
  assert.equal(auth.peekSession(req).expiresAt, first, "peek must not slide the expiry");
  assert.ok(auth.readSession(req).expiresAt > first, "readSession still renews");
  currentTime += 13 * 60 * 60 * 1000;
  assert.equal(auth.peekSession(req), null);
  assert.equal(auth.peekSession({ headers: { cookie: "asc_session=forged.value" } }), null);
});
