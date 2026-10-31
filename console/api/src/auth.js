import { createHmac, randomBytes, timingSafeEqual, scryptSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { writeJsonAtomic } from "./jsonStore.js";
import { verifyPassword } from "./passwordHash.js";
import { preferredContentEncoding } from "./http/contentEncoding.js";

const MIN_JSON_COMPRESSION_BYTES = 1024;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_PERSIST_MIN_INTERVAL_MS = 30 * 1000;

export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "permissions-policy": "geolocation=(), microphone=(), camera=()",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
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
  const sessions = new Map();
  const now = config.now || (() => Date.now());
  const sessionStoreFile = config.sessionStoreFile ? String(config.sessionStoreFile) : "";
  let lastPersistAt = 0;
  let persistenceCredential, persistenceSecret, persistenceKey;

  function sign(value) {
    return createHmac("sha256", config.sessionSecret).update(value).digest("base64url");
  }

  function sessionMac(entry) {
    // Password-dependent persistence uses a slow KDF once per credential change.
    // The password never enters the fast cookie-signing data path. Version 1
    // sessions are intentionally expired on upgrade; credentials remain valid.
    if (!persistenceKey || persistenceCredential !== config.adminPassword || persistenceSecret !== config.sessionSecret) {
      persistenceKey = scryptSync(String(config.adminPassword || ""), `dune-session-store-v2:${config.sessionSecret}`, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
      persistenceCredential = config.adminPassword;
      persistenceSecret = config.sessionSecret;
    }
    return createHmac("sha256", persistenceKey).update(JSON.stringify([entry.id, entry.csrf, entry.expiresAt, entry.tier || "owner", entry.userId || "", entry.username || "", entry.guildId || "", Boolean(config.adminPasswordEnvManaged)])).digest("base64url");
  }

  function constantTimeStringEqual(left, right) {
    const a = Buffer.from(String(left || ""));
    const b = Buffer.from(String(right || ""));
    return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
  }

  function loadPersistedSessions() {
    if (!sessionStoreFile || !existsSync(sessionStoreFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(sessionStoreFile, "utf8"));
      if (parsed?.version !== 2) return;
      const entries = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
      const currentNow = now();
      for (const entry of entries) {
        if (!entry || typeof entry.id !== "string" || typeof entry.csrf !== "string") continue;
        const expiresAt = Number(entry.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt < currentNow) continue;
        if (!entry.mac || !constantTimeStringEqual(sessionMac(entry), entry.mac)) continue;
        sessions.set(entry.id, {
          id: entry.id,
          csrf: entry.csrf,
          expiresAt,
          tier: entry.tier || "owner",
          userId: entry.userId || "",
          username: entry.username || "",
          guildId: entry.guildId || ""
        });
      }
    } catch {
      // Corrupt or unreadable session store starts cleanly with in-memory sessions.
    }
  }

  function persistSessions(force = false) {
    if (!sessionStoreFile) return;
    const currentNow = now();
    if (!force && currentNow - lastPersistAt < SESSION_PERSIST_MIN_INTERVAL_MS) return;
    lastPersistAt = currentNow;
    try {
      const active = [];
      for (const [id, session] of sessions) {
        if (!session || session.expiresAt < currentNow) {
          sessions.delete(id);
          continue;
        }
        active.push({
          id: session.id,
          csrf: session.csrf,
          expiresAt: session.expiresAt,
          tier: session.tier || "owner",
          userId: session.userId || "",
          username: session.username || "",
          guildId: session.guildId || "",
          mac: sessionMac(session)
        });
      }
      writeJsonAtomic(sessionStoreFile, { version: 2, sessions: active }, 0o600);
    } catch {
      // Best-effort persistence: in-memory sessions continue working if disk is read-only.
    }
  }

  loadPersistedSessions();

  function makeSession({ tier = "owner", userId = "", username = "", guildId = "" } = {}) {
    const id = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const expiresAt = now() + SESSION_TTL_MS;
    const session = { id, csrf, expiresAt, tier, userId, username, guildId };
    sessions.set(id, session);
    persistSessions(true);
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
      if (sessions.delete(id)) persistSessions(true);
      return null;
    }
    session.expiresAt = now() + SESSION_TTL_MS;
    persistSessions(false);
    return session;
  }

  function revokeSession(req) {
    const raw = parseCookies(req?.headers?.cookie || "").get("asc_session");
    if (!raw) return;
    const [id, sig] = raw.split(".");
    if (!id || !sig || !constantTimeStringEqual(sign(id), sig)) return;
    if (sessions.delete(id)) persistSessions(true);
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

  return { makeSession, readSession, revokeSession, peekSession, passwordMatches, requireAuth };
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
  const payload = serializeJsonResponse(body);
  const acceptEncoding = String(res?.req?.headers?.["accept-encoding"] || "").toLowerCase();
  const rawBuffer = acceptEncoding ? Buffer.from(payload, "utf8") : null;
  const encoding = preferredContentEncoding(acceptEncoding);
  if (Buffer.byteLength(payload) >= MIN_JSON_COMPRESSION_BYTES) headers = { vary: "Accept-Encoding", ...headers };
  if (rawBuffer && rawBuffer.length >= MIN_JSON_COMPRESSION_BYTES && !headers["content-encoding"]) {
    if (encoding === "br") {
      const compressed = brotliCompressSync(rawBuffer, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 }
      });
      res.writeHead(status, withSecurityHeaders({
        "content-type": "application/json; charset=utf-8",
        "content-encoding": "br",
        vary: "Accept-Encoding",
        ...headers
      }));
      res.end(compressed);
      return;
    }
    if (encoding === "gzip") {
      const compressed = gzipSync(rawBuffer, { level: 6 });
      res.writeHead(status, withSecurityHeaders({
        "content-type": "application/json; charset=utf-8",
        "content-encoding": "gzip",
        vary: "Accept-Encoding",
        ...headers
      }));
      res.end(compressed);
      return;
    }
  }
  res.writeHead(status, withSecurityHeaders({ "content-type": "application/json; charset=utf-8", ...headers }));
  res.end(payload);
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
