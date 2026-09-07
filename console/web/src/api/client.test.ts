import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  apiDownload,
  apiUpload,
  AUTH_SESSION_EXPIRED_EVENT,
  AUTH_SESSION_EXPIRED_MESSAGE,
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

describe("apiUpload settlement on abort and timeout", () => {
  // A stub faithful enough to drive apiUpload's own event wiring, not a mock
  // of apiUpload itself -- this is asserting the real XHR event handlers exist
  // and reject, not that some substitute behaves the way we want.
  class FakeXhr {
    status = 0;
    responseText = "";
    upload = { onprogress: null as ((event: unknown) => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    open() {}
    setRequestHeader() {}
    // Neither fires onload/onerror -- exactly what a real aborted or timed-out
    // request does, and exactly the case that used to leave the promise
    // pending forever.
    send() {}
  }

  it("rejects instead of hanging forever when the request is aborted", async () => {
    let instance!: FakeXhr;
    // A plain function, not an arrow function: vi.fn() only supports `new`
    // through its mock implementation when that implementation is itself a
    // function/class -- an arrow function throws "is not a constructor".
    vi.stubGlobal("XMLHttpRequest", vi.fn().mockImplementation(function XHRCtor(this: unknown) {
      instance = new FakeXhr();
      return instance;
    }));

    const pending = apiUpload("/api/backups/system/import", new Blob(["x"]));
    instance.onabort?.();

    await expect(pending).rejects.toThrow("The upload was cancelled.");
  });

  it("rejects instead of hanging forever when the request times out", async () => {
    let instance!: FakeXhr;
    vi.stubGlobal("XMLHttpRequest", vi.fn().mockImplementation(function XHRCtor(this: unknown) {
      instance = new FakeXhr();
      return instance;
    }));

    const pending = apiUpload("/api/backups/system/import", new Blob(["x"]));
    instance.ontimeout?.();

    await expect(pending).rejects.toThrow("The upload timed out before it reached the server.");
  });
});
