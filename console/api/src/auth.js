import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyPassword } from "./passwordHash.js";

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

  function sign(value) {
    return createHmac("sha256", config.sessionSecret).update(value).digest("base64url");
  }

  function constantTimeStringEqual(left, right) {
    const a = Buffer.from(String(left || ""));
    const b = Buffer.from(String(right || ""));
    return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  }

  function makeSession({ tier = "owner", userId = "", username = "", guildId = "" } = {}) {
    const id = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const expiresAt = now() + 12 * 60 * 60 * 1000;
    const session = { id, csrf, expiresAt, tier, userId, username, guildId };
    sessions.set(id, session);
    return { ...session, cookie: `${id}.${sign(id)}` };
  }

  function readSession(req) {
    if (config.authDisabled) return { id: "dev", csrf: "dev", expiresAt: Number.MAX_SAFE_INTEGER, tier: "owner" };
    const raw = parseCookies(req.headers.cookie || "").get("asc_session");
    if (!raw) return null;
    const [id, sig] = raw.split(".");
    if (!id || !sig || !constantTimeStringEqual(sign(id), sig)) return null;
    const session = sessions.get(id);
    if (!session || session.expiresAt < now()) {
      sessions.delete(id);
      return null;
    }
    session.expiresAt = now() + 12 * 60 * 60 * 1000;
    return session;
  }

  // Like readSession, but for long-lived checks (open streams): it never
  // renews the idle expiry and never deletes anything.
  function peekSession(req) {
    if (config.authDisabled) return { id: "dev", csrf: "dev", expiresAt: Number.MAX_SAFE_INTEGER, tier: "owner" };
    const raw = parseCookies(req.headers.cookie || "").get("asc_session");
    if (!raw) return null;
    const [id, sig] = raw.split(".");
    if (!id || !sig || !constantTimeStringEqual(sign(id), sig)) return null;
    const session = sessions.get(id);
    return session && session.expiresAt >= now() ? session : null;
  }

  async function passwordMatches(value) {
    // ADMIN_PASSWORD is an operator-supplied literal. Password files may be
    // either the legacy plaintext format or the scrypt format written by a
    // newer Console build, so file-backed credentials must understand both.
    if (config.adminPasswordEnvManaged) return constantTimeStringEqual(value, config.adminPassword);
    return verifyPassword(value, config.adminPassword);
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

  return { makeSession, readSession, peekSession, passwordMatches, requireAuth };
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
