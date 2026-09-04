import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const sessions = new Map();

export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "geolocation=(), microphone=(), camera=()"
};

export function withSecurityHeaders(headers = {}) {
  return { ...SECURITY_HEADERS, ...headers };
}

export function parseCookies(header = "") {
  const cookies = new Map();
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return cookies;
}

export function createAuth(config) {
  const now = config.now || (() => Date.now());

  // Integrity tag over an opaque session id -- NOT password storage.
  //
  // CodeQL flags this as js/insufficient-password-hash, which fires when a
  // credential is hashed with a fast hash instead of a slow KDF. There is no
  // password here and no stored digest for anyone to crack: `value` is a
  // server-generated random id, `config.sessionSecret` is an HMAC KEY, and the
  // output authenticates the cookie rather than standing in for a secret. A KDF
  // would be the wrong primitive -- it is not a verifier for a low-entropy,
  // human-chosen input.
  //
  // The id's unguessability comes from randomBytes(32), and the server-side
  // store is the real authority regardless of the signature -- both proven in
  // test/sessionFixation.test.js.
  // codeql[js/insufficient-password-hash]
  function sign(value) {
    return createHmac("sha256", config.sessionSecret).update(value).digest("base64url");
  }

  function constantTimeStringEqual(left, right) {
    const a = Buffer.from(String(left || ""));
    const b = Buffer.from(String(right || ""));
    return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  }

  const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

  // scope: null for a normal session; "enroll" for the short-lived, non-renewable
  // second-factor enrollment session (RFC §4) that the route gate restricts to
  // the enrollment endpoints only. renewable:false keeps the enrollment window
  // fixed so it can't be extended by activity.
  function makeSession({ tier = "owner", userId = "", username = "", displayName = "", guildId = "", scope = null, ttlMs = DEFAULT_TTL_MS, renewable = true } = {}) {
    const id = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const expiresAt = now() + ttlMs;
    const session = { id, csrf, expiresAt, tier, userId, username, displayName, guildId, scope, renewable };
    sessions.set(id, session);
    return { ...session, cookie: `${id}.${sign(id)}` };
  }

  function readSession(req) {
    if (config.authDisabled) return { id: "dev", csrf: "dev", expiresAt: Number.MAX_SAFE_INTEGER, tier: "owner", scope: null, renewable: true };
    const raw = parseCookies(req.headers.cookie || "").get("asc_session");
    if (!raw) return null;
    const [id, sig] = raw.split(".");
    if (!id || !sig || !constantTimeStringEqual(sign(id), sig)) return null;
    const session = sessions.get(id);
    if (!session || session.expiresAt < now()) {
      sessions.delete(id);
      return null;
    }
    if (session.renewable !== false) session.expiresAt = now() + DEFAULT_TTL_MS;
    return session;
  }

  // Invalidate one session by id (enrollment completion, logout, rotation).
  // Server-side lookup by session id, for a flow that must hand data back to
  // a specific live session it did not receive a cookie for (the Discord setup
  // callback). Expiry is honored exactly as readSession does.
  function readSessionById(id) {
    const session = sessions.get(id);
    if (!session || session.expiresAt < now()) return null;
    return session;
  }
  function invalidateSession(id) {
    return sessions.delete(id);
  }

  // Invalidate every OTHER password/TOTP-authenticated session (RFC §2.3/§5:
  // credential rotation clears sessions of the rotated credential type only).
  // Discord- (and future passkey-) authenticated sessions always carry a
  // non-empty userId and are left untouched; this fork has not yet adopted
  // upstream's explicit `local-owner` principal for the password/TOTP tier
  // (deferred, meta), so an empty userId is what currently marks
  // this credential type. Returns the number of sessions invalidated.
  function invalidatePasswordSessions(exceptId) {
    let count = 0;
    for (const [id, session] of sessions) {
      if (id === exceptId || session.userId) continue;
      sessions.delete(id);
      count++;
    }
    return count;
  }

  function passwordMatches(value) {
    const left = Buffer.from(String(value || ""));
    const right = Buffer.from(config.adminPassword);
    return left.length === right.length && timingSafeEqual(left, right);
  }

  function requireAuth(req, res) {
    const session = readSession(req);
    if (!session) {
      json(res, 401, { error: "Your browser login session expired. Refresh the page, then sign in again." });
      return null;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method || "")) {
      const csrf = req.headers["x-csrf-token"];
      if (!config.authDisabled && csrf !== session.csrf) {
        json(res, 403, { error: "Your browser login session expired. Refresh the page, then sign in again." });
        return null;
      }
    }
    return session;
  }

  return { makeSession, readSession, readSessionById, passwordMatches, requireAuth, invalidateSession, invalidatePasswordSessions };
}

export function setSessionCookie(res, session, config = {}, { maxAgeSeconds = 43200 } = {}) {
  const secure = config.secureCookies ? "; Secure" : "";
  res.setHeader("Set-Cookie", `asc_session=${encodeURIComponent(session.cookie)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`);
}

export function clearSessionCookie(res, config = {}) {
  const secure = config.secureCookies ? "; Secure" : "";
  res.setHeader("Set-Cookie", `asc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

export function json(res, status, body, headers = {}) {
  res.writeHead(status, withSecurityHeaders({ "content-type": "application/json; charset=utf-8", ...headers }));
  res.end(serializeJsonResponse(body));
}

export function serializeJsonResponse(body) {
  return JSON.stringify(body, (_key, value) => {
    // Route handlers must turn expected failures into explicit public strings.
    // If an Error object reaches this final boundary, never serialize its stack,
    // message, file paths, SQL, or attached process output to the browser.
    if (value instanceof Error) return { error: "An internal server error occurred." };
    return value;
  });
}
