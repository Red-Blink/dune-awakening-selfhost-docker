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
  function sign(value) {
    return createHmac("sha256", config.sessionSecret).update(value).digest("base64url");
  }

  function makeSession() {
    const id = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
    sessions.set(id, { id, csrf, expiresAt });
    return { id, csrf, expiresAt, cookie: `${id}.${sign(id)}` };
  }

  function readSession(req) {
    if (config.authDisabled) return { id: "dev", csrf: "dev", expiresAt: Number.MAX_SAFE_INTEGER };
    const raw = parseCookies(req.headers.cookie || "").get("asc_session");
    if (!raw) return null;
    const [id, sig] = raw.split(".");
    if (!id || !sig || sign(id) !== sig) return null;
    const session = sessions.get(id);
    if (!session || session.expiresAt < Date.now()) {
      sessions.delete(id);
      return null;
    }
    session.expiresAt = Date.now() + 12 * 60 * 60 * 1000;
    return session;
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

  return { makeSession, readSession, passwordMatches, requireAuth };
}

export function setSessionCookie(res, session, config = {}) {
  const secure = config.secureCookies ? "; Secure" : "";
  res.setHeader("Set-Cookie", `asc_session=${encodeURIComponent(session.cookie)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure}`);
}

export function clearSessionCookie(res, config = {}) {
  const secure = config.secureCookies ? "; Secure" : "";
  res.setHeader("Set-Cookie", `asc_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

export function json(res, status, body, headers = {}) {
  res.writeHead(status, withSecurityHeaders({ "content-type": "application/json; charset=utf-8", ...headers }));
  res.end(JSON.stringify(body));
}
