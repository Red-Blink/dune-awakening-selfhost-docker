import { getServerPorts } from "./serverPorts";

export type ApiResult<T = unknown> = Promise<T>;

let csrfToken: string | null = null;
export const AUTH_SESSION_EXPIRED_EVENT = "dune-console-auth-session-expired";
export const AUTH_SESSION_EXPIRED_MESSAGE = "Your browser login session expired. Sign in again to continue.";
const POSTGRES_UNAVAILABLE_MESSAGE = "Postgres is not running or is restarting. Wait for the database service to come back online, then refresh.";
const INVALID_RESPONSE_MESSAGE = "The console received invalid data for this page. Refresh the page and try again.";

export function setCsrfToken(value: string | null) {
  csrfToken = value;
}

export async function api<T>(path: string, options: RequestInit = {}): ApiResult<T> {
  return apiRequest<T>(path, options, false);
}

export async function apiDownload(path: string, options: RequestInit = {}, csrfRetried = false): Promise<Response> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData) && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (csrfToken && !["GET", "HEAD"].includes(options.method || "GET")) headers.set("x-csrf-token", csrfToken);
  const response = await fetch(path, { ...options, headers, credentials: "include" });
  if (!response.ok) {
    const text = await response.text();
    let message = text || `Request failed: ${response.status}`;
    try {
      const data = JSON.parse(text) as { error?: string };
      message = data.error || message;
    } catch {}
    if (isSessionAuthFailure(response.status, message)) {
      if (response.status === 403 && !csrfRetried && await refreshCsrfToken()) return apiDownload(path, options, true);
      announceSessionExpired();
      throw new Error(AUTH_SESSION_EXPIRED_MESSAGE);
    }
    throw new Error(friendlyApiError(message));
  }
  return response;
}

async function apiRequest<T>(path: string, options: RequestInit = {}, csrfRetried = false): ApiResult<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData) && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (csrfToken && !["GET", "HEAD"].includes(options.method || "GET")) headers.set("x-csrf-token", csrfToken);
  const response = await fetch(path, { ...options, headers, credentials: "include" });
  const text = await response.text();
  let data: unknown = {};
  let invalidJsonResponse = false;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      invalidJsonResponse = true;
      const fallback = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
      data = { error: response.ok ? INVALID_RESPONSE_MESSAGE : friendlyApiError(fallback || INVALID_RESPONSE_MESSAGE) };
    }
  }
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  if (isSessionAuthFailure(response.status, String(record.error || ""), path)) {
    if (response.status === 403 && !csrfRetried && await refreshCsrfToken()) {
      return apiRequest<T>(path, options, true);
    }
    announceSessionExpired();
    throw new Error(AUTH_SESSION_EXPIRED_MESSAGE);
  }
  if (response.ok && invalidJsonResponse) throw new Error(INVALID_RESPONSE_MESSAGE);
  if (!response.ok) throw new Error(friendlyApiError(String(record.error || `Request failed: ${response.status}`)));
  return data as T;
}

// The two enrollment routes answer a REJECTED CODE with 401 ("That code was
// not accepted..."), not a lost session -- their session loss is a 403 with a
// "sign in again" message. Treating that 401 as expiry tore the setup screen
// down on the first mistyped code, regenerated the secret on the next login,
// and made the 3-strike clock-skew hint unreachable.
const ENROLLMENT_ROUTES = new Set(["/api/auth/2fa/setup", "/api/auth/2fa/confirm"]);

function isSessionAuthFailure(status: number, message: string, path = "") {
  if (status === 401) return !ENROLLMENT_ROUTES.has(path);
  return status === 403 && /authentication required|csrf token|session expired|login session|sign in to begin/i.test(message);
}

function announceSessionExpired() {
  csrfToken = null;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(AUTH_SESSION_EXPIRED_EVENT));
}

// Bypasses the ordinary api() helper's caching (implicit `default` fetch
// mode) on purpose: callers of this specific function need to know the
// console's *actual current* running build -- used both by the console
// update flow's own reload-readiness check and by useStaleBuildWatcher to
// detect a build change on an idle tab -- so a cached response would
// defeat the point.
export async function fetchConsoleAuthState() {
  const response = await fetch("/api/auth/state", {
    credentials: "include",
    cache: "no-store",
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw new Error(`Console state check failed: ${response.status}`);
  return await response.json() as { config?: { version?: string; buildId?: string } };
}

async function refreshCsrfToken() {
  try {
    const response = await fetch("/api/auth/state", { credentials: "include" });
    if (!response.ok) return false;
    const state = await response.json() as { authenticated?: boolean; csrfToken?: string | null };
    if (!state.authenticated || !state.csrfToken) return false;
    csrfToken = state.csrfToken;
    return true;
  } catch {
    return false;
  }
}

export function post<T>(path: string, body: unknown = {}) {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

// #676 §7: `post()`/`api()` throw on any non-2xx, exposing only the error
// STRING -- fine for a plain failure, but the zero-2FA guard's whole point is
// a DISTINGUISHABLE 409 (zeroFactorWarning: true) a caller can react to
// differently from an ordinary rejection, without the fragility of matching
// on error text. This mirrors apiRequest's own request-building exactly
// (headers, CSRF, credentials) but never throws -- callers get the real
// status and parsed body for any outcome, 2xx or not.
export async function postForResult<T extends Record<string, unknown>>(path: string, body: unknown = {}, csrfRetried = false): Promise<{ status: number; body: T }> {
  const headers = new Headers({ "content-type": "application/json" });
  if (csrfToken) headers.set("x-csrf-token", csrfToken);
  const response = await fetch(path, { method: "POST", headers, credentials: "include", body: JSON.stringify(body) });
  const text = await response.text();
  let parsed: T;
  try { parsed = text ? (JSON.parse(text) as T) : ({} as T); } catch { parsed = ({} as T); }
  // Layer 3 audit finding (#676 follow-up): this duplicates apiRequest's own
  // request-building, but originally omitted its 403-CSRF-refresh-retry and
  // announceSessionExpired() handling entirely -- a genuinely expired/stale
  // session hit this route's caller with a raw, confusing error instead of
  // the app-wide "session expired, sign in again" flow every other mutation
  // gets. Still never throws on the special 409 zeroFactorWarning outcome
  // this function exists for (that isn't a session failure), and still
  // returns the real status/body afterward either way, so callers keep
  // their own non-throwing contract.
  if (isSessionAuthFailure(response.status, String((parsed as Record<string, unknown>)?.error || ""), path)) {
    if (response.status === 403 && !csrfRetried && await refreshCsrfToken()) {
      return postForResult<T>(path, body, true);
    }
    announceSessionExpired();
  }
  return { status: response.status, body: parsed };
}

export interface LoginResponse {
  status: number;
  body: Record<string, unknown>;
}

// Dedicated entry point for /api/auth/login. Every status code this route
// returns (200 authenticated/enrollmentRequired/resetupRequired, 401 wrong
// password/totpRequired/recoveryFailed, 429 rate-limited, 503 second-factor
// store unavailable) carries a real body the caller must branch on -- there
// is no session yet at login time, so api()/apiRequest()'s blanket "401 =
// session expired" interception (correct for every OTHER authenticated
// route) would misrepresent all of those as a stale-session error instead.
export async function loginRequest(body: unknown): Promise<LoginResponse> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { error: INVALID_RESPONSE_MESSAGE };
    }
  }
  return { status: response.status, body: data };
}

export function friendlyApiError(value: unknown) {
  const text = value instanceof Error ? value.message : String(value || "");
  // Note: the generic "connect ECONNREFUSED"/"Postgres is not running"
  // checks below already catch every real case regardless of which port
  // Postgres is configured on -- the specific-port check is effectively
  // redundant, but kept (now port-aware instead of hardcoded to the
  // stock port 15432) for clearer matching.
  const postgresPort = getServerPorts().postgres;
  const postgresRefused = new RegExp(`ECONNREFUSED.*127\\.0\\.0\\.1:${postgresPort}`, "i");
  if (postgresRefused.test(text) || /connect\s+ECONNREFUSED|Postgres is not running/i.test(text)) return POSTGRES_UNAVAILABLE_MESSAGE;
  if (/Unexpected token|Unexpected end of JSON|is not valid JSON|invalid json|unexpected response/i.test(text)) return "The console found invalid saved data for this page. Refresh the page and try again.";
  return text.replace(/^Error:\s*/i, "").trim() || "Request failed.";
}
