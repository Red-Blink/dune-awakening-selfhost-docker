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
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
  assert.match(res.headers["permissions-policy"], /camera=\(\)/);
});

test("auth rejects a cookie whose HMAC signature was tampered", () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false });
  const session = auth.makeSession();
  const tampered = session.cookie.slice(0, -2) + (session.cookie.endsWith("aa") ? "bb" : "aa");
  const req = { headers: { cookie: `asc_session=${encodeURIComponent(tampered)}` } };
  assert.equal(auth.readSession(req), null);
});

test("auth rejects an expired session", () => {
  let currentTime = 1_700_000_000_000;
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false, now: () => currentTime });
  const session = auth.makeSession();
  assert.equal(auth.readSession({ headers: { cookie: `asc_session=${encodeURIComponent(session.cookie)}` } })?.id, session.id);
  currentTime += 12 * 60 * 60 * 1000 + 1000;
  const req = { headers: { cookie: `asc_session=${encodeURIComponent(session.cookie)}` } };
  assert.equal(auth.readSession(req), null);
});

test("legacy signed cookie without a live session synthesizes an owner-tier session (upgrade path)", () => {
  // Strict Requirement 0: a cookie minted by a pre-RBAC build (or a cookie
  // surviving a restart) must not lock the operator out. The HMAC proves
  // the cookie is genuine; the missing Map entry gets a fresh owner session.
  const secret = "shared-secret";
  const legacyAuth = createAuth({ sessionSecret: secret, adminPassword: "admin", authDisabled: false });
  const legacy = legacyAuth.makeSession(); // would have been the old format: same shape
  const cookieValue = legacy.cookie;

  const freshAuth = createAuth({ sessionSecret: secret, adminPassword: "admin", authDisabled: false });
  const req = { headers: { cookie: `asc_session=${encodeURIComponent(cookieValue)}` } };
  const session = freshAuth.readSession(req);
  assert.ok(session, "signature-valid legacy cookie must not be rejected");
  assert.equal(session.tier, "owner");
  assert.equal(session.id, legacy.id);
});

test("legacy cookie synthesized session can authenticate via its fresh CSRF token", () => {
  const secret = "another-secret";
  const legacyAuth = createAuth({ sessionSecret: secret, adminPassword: "admin", authDisabled: false });
  const legacy = legacyAuth.makeSession();
  const freshAuth = createAuth({ sessionSecret: secret, adminPassword: "admin", authDisabled: false });

  // The browser always does /api/auth/state first, which returns the
  // synthesized session's CSRF token (moved by requireAuth→readSession).
  const read = freshAuth.readSession({ headers: { cookie: `asc_session=${encodeURIComponent(legacy.cookie)}` } });
  assert.ok(read, "signature-valid legacy cookie must establish a session");
  const res = fakeResponse();
  const authed = freshAuth.requireAuth({ method: "POST", headers: { cookie: `asc_session=${encodeURIComponent(legacy.cookie)}`, "x-csrf-token": read.csrf } }, res);
  assert.equal(authed?.tier, "owner");
  assert.equal(res.status, null);
});

test("makeSession defaults to owner tier and carries identity fields", () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false });
  const plain = auth.makeSession();
  assert.equal(plain.tier, "owner");
  assert.equal(plain.userId, "");

  const oauth = auth.makeSession({ tier: "owner", userId: "123456789012345678", username: "operator", guildId: "987654321098765432" });
  assert.equal(oauth.tier, "owner");
  assert.equal(oauth.userId, "123456789012345678");
  assert.equal(oauth.username, "operator");
  assert.equal(oauth.guildId, "987654321098765432");

  const readBack = auth.readSession({ headers: { cookie: `asc_session=${encodeURIComponent(oauth.cookie)}` } });
  assert.equal(readBack?.tier, "owner");
  assert.equal(readBack?.userId, "123456789012345678");
  assert.equal(readBack?.username, "operator");
});

test("ADMIN_AUTH_DISABLED=1 returns dev owner session, bypasses password and CSRF", () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: true });
  const req = { method: "POST", headers: {} };
  const res = fakeResponse();
  const session = auth.requireAuth(req, res);
  assert.equal(session?.id, "dev");
  assert.equal(session?.tier, "owner");
  assert.equal(session?.csrf, "dev");
  assert.equal(res.status, null);
  assert.equal(auth.passwordMatches("anything"), false); // disabled doesn't skip passwordMatches
});

test("logout deletes session and cookie is cleared", () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false });
  const session = auth.makeSession();
  const cookieValue = session.cookie;
  const res = fakeResponse();
  clearSessionCookie(res, { secureCookies: false });
  assert.match(res.headers["Set-Cookie"], /Max-Age=0/);
  assert.match(res.headers["Set-Cookie"], /asc_session=;/);

  // After logout cookie is sent, the old session cookie should be rejected
  // because the in-memory session should be deleted by the logout handler.
  // This test verifies the cookie-clearing side; the server-side deletion
  // is tested in the integration layer.
});

test("when authDisabled is false, missing cookie returns null", () => {
  const auth = createAuth({ sessionSecret: "secret", adminPassword: "admin", authDisabled: false });
  assert.equal(auth.readSession({ headers: {} }), null);
});

test("constant-time HMAC comparison rejects mismatched signatures", () => {
  const auth = createAuth({ sessionSecret: "secret-a", adminPassword: "admin", authDisabled: false });
  const session = auth.makeSession();
  const otherAuth = createAuth({ sessionSecret: "secret-b", adminPassword: "admin", authDisabled: false });
  const otherSession = otherAuth.makeSession();

  // Tamper by swapping signatures between two different secrets
  const [idA] = session.cookie.split(".");
  const [, sigB] = otherSession.cookie.split(".");
  const tamperedCookie = `${idA}.${sigB}`;
  assert.equal(auth.readSession({ headers: { cookie: `asc_session=${encodeURIComponent(tamperedCookie)}` } }), null);
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
