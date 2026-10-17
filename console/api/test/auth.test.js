import test from "node:test";
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { createAuth, clearSessionCookie, setSessionCookie, json, serializeJsonResponse } from "../src/auth.js";

test("auth creates readable signed sessions", async () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false });
  const session = auth.makeSession();
  const req = { headers: { cookie: `asc_session=${encodeURIComponent(session.cookie)}` } };
  assert.equal(auth.readSession(req)?.id, session.id);
  assert.equal(await auth.passwordMatches("admin"), true);
  assert.equal(await auth.passwordMatches("wrong"), false);
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
