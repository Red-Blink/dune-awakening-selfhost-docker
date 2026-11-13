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

  function sessionMac(entry) {
    // Password-dependent persistence uses a slow KDF once per credential change.
    // The password never enters the fast cookie-signing data path. Version 1
    // sessions are intentionally expired on upgrade; credentials remain valid.
    if (!persistenceKey || persistenceCredential !== config.adminPassword || persistenceSecret !== config.sessionSecret) {
      persistenceKey = scryptSync(String(config.adminPassword || ""), `dune-session-store-v2:${config.sessionSecret}`, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
      persistenceCredential = config.adminPassword;
      persistenceSecret = config.sessionSecret;
    }
    return createHmac("sha256", persistenceKey).update(JSON.stringify([entry.id, entry.csrf, entry.expiresAt, entry.tier || "owner", entry.userId || "", entry.username || "", entry.guildId || "", Boolean(config.adminPasswordEnvManaged), ...(entry.displayName ? [String(entry.displayName)] : [])])).digest("base64url");
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
          displayName: entry.displayName || entry.username || "",
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
        // Enrollment / resetup sessions (scope set) are short-lived, non-renewable and
        // memory-only: restoring one after a restart without its scope would hand back
        // a full session, so they are never written to the store.
        if (session.scope || session.renewable === false) continue;
        active.push({
          id: session.id,
          csrf: session.csrf,
          expiresAt: session.expiresAt,
          tier: session.tier || "owner",
          userId: session.userId || "",
          username: session.username || "",
          ...(session.displayName ? { displayName: session.displayName } : {}),
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

  const DEFAULT_TTL_MS = SESSION_TTL_MS;

  // scope: null for a normal session; "enroll" for the short-lived, non-renewable
  // second-factor enrollment session (RFC §4) that the route gate restricts to
  // the enrollment endpoints only. renewable:false keeps the enrollment window
  // fixed so it can't be extended by activity.
  // expectedFactorVersion: only set on a recovery-login resetup session
  // (scope:"resetup") -- the second-factor store's factorVersion (see
  // secondFactorStore.js) as of the recovery code that minted this session,
  // re-checked by commit() at confirm time so a stale/concurrent resetup
  // session can't overwrite an authenticator a different session already
  // replaced (review finding, upstream PR #201, 2026-09-06).
  function makeSession({ tier = "owner", userId = "", username = "", displayName = "", guildId = "", scope = null, ttlMs = DEFAULT_TTL_MS, renewable = true, expectedFactorVersion = null } = {}) {
    const id = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const expiresAt = now() + ttlMs;
    const session = { id, csrf, expiresAt, tier, userId, username, displayName, guildId, scope, renewable, expectedFactorVersion };
    sessions.set(id, session);
    if (!scope) persistSessions(true);
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
      if (sessions.delete(id)) persistSessions(true);
      return null;
    }
    if (session.renewable !== false) session.expiresAt = now() + DEFAULT_TTL_MS;
    if (!session.scope) persistSessions(false);
    return session;
  }

  // Server-side lookup by session id, for a flow that must hand data back to
  // a specific live session it did not receive a cookie for (the Discord setup
  // callback). Expiry is honored exactly as readSession does.
  function readSessionById(id) {
    const session = sessions.get(id);
    if (!session || session.expiresAt < now()) return null;
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

  // Invalidate one session by id (enrollment completion, logout, rotation).
  function invalidateSession(id) {
    const session = sessions.get(id);
    const removed = sessions.delete(id);
    // Ordinary sessions are persisted, so removing one must reach the store too.
    if (removed && session && !session.scope) persistSessions(true);
    return removed;
  }

  // Invalidate every OTHER password/TOTP-authenticated session (RFC §2.3/§5:
  // credential rotation clears sessions of the rotated credential type only).
  // Discord- (and future passkey-) authenticated sessions always carry a
  // non-empty userId and are left untouched; this fork has not yet adopted
  // upstream's explicit `local-owner` principal for the password/TOTP tier
  // (deferred, meta), so an empty userId is what currently marks
  // this credential type.
  //
  // `session.scope` must ALSO be excluded (review finding, upstream PR #201,
  // 2026-09-08): an enroll/resetup-scope session (RFC §4) carries no userId
  // either -- the same marker a normal password/TOTP session uses -- so
  // without this check, calling this from inside the 2FA confirm route to
  // fix the finding above would kill a DIFFERENT, still-legitimate concurrent
  // enrollment session's cookie before it ever gets to make its own request,
  // turning its expected 409 (already_configured) into an opaque 403
  // (session/CSRF invalid). Caught by the existing
  // "a second enrollment that loses the race gets 409" test going red on the
  // very first version of that fix. Returns the number of sessions
  // invalidated.
  function invalidatePasswordSessions(exceptId) {
    let count = 0;
    for (const [id, session] of sessions) {
      if (id === exceptId || session.userId || session.scope) continue;
      sessions.delete(id);
      count++;
    }
    // These are ordinary (scope-less) sessions, which are persisted.
    if (count) persistSessions(true);
    return count;
  }

  // Invalidate every OTHER outstanding recovery (resetup-scope) session --
  // called when one resetup session successfully replaces the authenticator
  // (review finding, upstream PR #201, 2026-09-06). commit()'s
  // expectedFactorVersion check already stops a stale sibling from
  // overwriting the newly-committed factor; this additionally ends the
  // sibling's session outright so returning to it surfaces an immediate,
  // unambiguous "your session expired, sign in again" via the normal
  // readSession() expiry path, rather than a confusing generation-mismatch
  // error at the very end of a full re-enrollment flow. Returns the number of
  // sessions invalidated.
  function invalidateResetupSessions(exceptId) {
    let count = 0;
    for (const [id, session] of sessions) {
      if (id === exceptId || session.scope !== "resetup") continue;
      sessions.delete(id);
      count++;
    }
    if (count) persistSessions(true);
    return count;
  }

  // Merged during the 2026-09-21 upstream rebase: upstream/main independently
  // added scrypt-file-password support (async, verifyPassword()) while this
  // fork's tier3-upstream branch was in flight -- kept async and delegating
  // to verifyPassword()/constantTimeStringEqual() (upstream's newer, more
  // capable implementation, understands both the legacy plaintext and the
  // newer scrypt on-disk password formats) rather than reverting to the
  // simpler timingSafeEqual-only version this branch had, which would have
  // been a real regression for any operator already on a scrypt-hashed
  // password file. See server.js's own merge for the matching await-site
  // fixes this made necessary.
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

  return { makeSession, readSession, readSessionById, revokeSession, peekSession, passwordMatches, requireAuth, invalidateSession, invalidatePasswordSessions, invalidateResetupSessions };
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
