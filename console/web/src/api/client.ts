export type ApiResult<T = unknown> = Promise<T>;

let csrfToken: string | null = null;
const POSTGRES_UNAVAILABLE_MESSAGE = "Postgres is not running or is restarting. Wait for the database service to come back online, then refresh.";
const INVALID_RESPONSE_MESSAGE = "The console received invalid data for this page. Refresh the page and try again.";

export function setCsrfToken(value: string | null) {
  csrfToken = value;
}

export async function api<T>(path: string, options: RequestInit = {}): ApiResult<T> {
  return apiRequest<T>(path, options, false);
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
  if (response.status === 401 || response.status === 403) {
    const rawError = String(record.error || "");
    if (/authentication required|csrf token|session expired|login session/i.test(rawError)) {
      if (response.status === 403 && !csrfRetried && await refreshCsrfToken()) {
        return apiRequest<T>(path, options, true);
      }
      throw new Error("Your browser login session expired. Refresh the page, then sign in again.");
    }
  }
  if (response.ok && invalidJsonResponse) throw new Error(INVALID_RESPONSE_MESSAGE);
  if (!response.ok) throw new Error(friendlyApiError(String(record.error || `Request failed: ${response.status}`)));
  return data as T;
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
  if (/ECONNREFUSED.*127\.0\.0\.1:15432|connect\s+ECONNREFUSED|Postgres is not running/i.test(text)) return POSTGRES_UNAVAILABLE_MESSAGE;
  if (/Unexpected token|Unexpected end of JSON|is not valid JSON|invalid json|unexpected response/i.test(text)) return "The console found invalid saved data for this page. Refresh the page and try again.";
  return text.replace(/^Error:\s*/i, "").trim() || "Request failed.";
}
