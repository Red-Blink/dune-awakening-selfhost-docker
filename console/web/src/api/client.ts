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

// Uploads with progress. fetch cannot report upload progress at all, so this is
// XHR -- but it lives here rather than in a panel so it inherits the same CSRF
// header, cookie handling and session-expiry behaviour as every other mutating
// request. Doing it by hand in the panel is what made the first attempt fail
// with "login session expired": a raw XHR sends neither.
export async function apiUpload(
  path: string,
  body: Blob,
  options: { onProgress?: (percent: number) => void; contentType?: string } = {},
  csrfRetried = false
): Promise<{ status: number; body: Record<string, unknown> }> {
  const result = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", path);
    request.withCredentials = true;
    request.setRequestHeader("content-type", options.contentType || "application/octet-stream");
    if (csrfToken) request.setRequestHeader("x-csrf-token", csrfToken);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      let parsed: Record<string, unknown> = {};
      try {
        const data = JSON.parse(request.responseText || "{}");
        parsed = data && typeof data === "object" ? data as Record<string, unknown> : {};
      } catch {
        parsed = { error: request.responseText ? friendlyApiError(request.responseText.replace(/<[^>]+>/g, " ").trim().slice(0, 240)) : INVALID_RESPONSE_MESSAGE };
      }
      resolve({ status: request.status, body: parsed });
    };
    request.onerror = () => reject(new Error("The upload failed before it reached the server."));
    request.send(body);
  });

  if (isSessionAuthFailure(result.status, String(result.body.error || ""))) {
    // A stale CSRF token is recoverable and worth retrying once, exactly as the
    // fetch paths do -- otherwise a long-idle tab loses the whole upload.
    if (result.status === 403 && !csrfRetried && await refreshCsrfToken()) {
      return apiUpload(path, body, options, true);
    }
    announceSessionExpired();
    throw new Error(AUTH_SESSION_EXPIRED_MESSAGE);
  }
  return result;
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
  if (isSessionAuthFailure(response.status, String(record.error || ""))) {
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

function isSessionAuthFailure(status: number, message: string) {
  return status === 401 || (status === 403 && /authentication required|csrf token|session expired|login session/i.test(message));
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
