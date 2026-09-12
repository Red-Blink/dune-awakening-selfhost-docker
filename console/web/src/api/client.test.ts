import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  apiDownload,
  AUTH_SESSION_EXPIRED_EVENT,
  AUTH_SESSION_EXPIRED_MESSAGE,
  loginRequest,
  setCsrfToken
} from "./client";

afterEach(() => {
  setCsrfToken(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("API authentication handling", () => {
  it("announces an expired session instead of leaving feature pages in a fallback state", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired, { once: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Your browser login session expired." }),
      { status: 401, headers: { "content-type": "application/json" } }
    )));

    await expect(api("/api/updates/check-stack")).rejects.toThrow(AUTH_SESSION_EXPIRED_MESSAGE);
    expect(expired).toHaveBeenCalledOnce();
  });

  it("refreshes a stale CSRF token without signing the user out", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired, { once: true });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "CSRF token mismatch." }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true, csrfToken: "new-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api<{ ok: boolean }>("/api/settings", { method: "POST", body: "{}" })).resolves.toEqual({ ok: true });
    expect(expired).not.toHaveBeenCalled();
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get("x-csrf-token")).toBe("new-token");
    window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);
  });

  it("does not treat an unrelated forbidden response as an expired session", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired, { once: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Access denied by the configured IP allowlist." }),
      { status: 403 }
    )));

    await expect(api("/api/settings")).rejects.toThrow("Access denied by the configured IP allowlist.");
    expect(expired).not.toHaveBeenCalled();
    window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);
  });

  it("applies the same expired-session behavior to downloads", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired, { once: true });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: "Authentication required." }),
      { status: 401 }
    )));

    await expect(apiDownload("/api/backups/download")).rejects.toThrow(AUTH_SESSION_EXPIRED_MESSAGE);
    expect(expired).toHaveBeenCalledOnce();
  });
});

// #598: loginRequest() used to always replace a non-JSON body with the
// generic "invalid data" message, unlike apiRequest()'s own fallback (a
// reverse proxy's HTML error page, stripped of markup, surfaced via
// friendlyApiError) -- so a Cloudflare/nginx 502/504 at sign-in read as a
// client-side data error instead of the upstream outage it actually was.
describe("loginRequest non-JSON response handling", () => {
  it("surfaces a stripped proxy error page instead of the generic invalid-data message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "<html><body><h1>502 Bad Gateway</h1><p>nginx</p></body></html>",
      { status: 502, headers: { "content-type": "text/html" } }
    )));

    const result = await loginRequest({ password: "x" });
    expect(result.status).toBe(502);
    expect(result.body.error).toBe("502 Bad Gateway nginx");
  });

  it("keeps the generic message for a genuinely invalid 200 response, with no proxy text to surface", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json", { status: 200 })));

    const result = await loginRequest({ password: "x" });
    expect(result.status).toBe(200);
    expect(result.body.error).toBe("The console received invalid data for this page. Refresh the page and try again.");
  });
});
