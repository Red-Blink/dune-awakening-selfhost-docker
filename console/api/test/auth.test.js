import test from "node:test";
import assert from "node:assert/strict";
import { createAuth, clearSessionCookie, setSessionCookie, json } from "../src/auth.js";

test("auth creates readable signed sessions", () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false });
  const session = auth.makeSession();
  const req = { headers: { cookie: `asc_session=${encodeURIComponent(session.cookie)}` } };
  assert.equal(auth.readSession(req)?.id, session.id);
  assert.equal(auth.passwordMatches("admin"), true);
  assert.equal(auth.passwordMatches("wrong"), false);
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
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.match(res.headers["permissions-policy"], /camera=\(\)/);
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
