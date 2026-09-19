import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_SESSION_EXPIRED_EVENT, post, setCsrfToken } from "./client";

// Review finding: the shared client treated EVERY 401 as session expiry, but
// /api/auth/2fa/confirm answers a wrong code with 401. One mistyped code fired
// the expiry event, App tore the setup screen down, and the next login minted
// a new secret -- the authenticator entry just scanned was dead.
afterEach(() => { setCsrfToken(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("enrollment routes and session-expiry detection", () => {
  it("a 401 from /api/auth/2fa/confirm is a rejected code, not an expired session", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(401, { error: "That code was not accepted. Check your device's clock and enter the current code." })));
    await expect(post("/api/auth/2fa/confirm", { code: "000000" })).rejects.toThrow(/not accepted/);
    expect(expired).not.toHaveBeenCalled();
    window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);
  });

  it("a lost enrollment session (403 'Sign in to begin...') still announces expiry", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(403, { error: "Sign in to begin two-factor setup." })));
    await expect(post("/api/auth/2fa/setup")).rejects.toThrow();
    expect(expired).toHaveBeenCalledOnce();
    window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);
  });

  it("a 401 on any other route is still an expired session", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(401, { error: "Your browser login session expired." })));
    await expect(post("/api/settings/admin-password", {})).rejects.toThrow();
    expect(expired).toHaveBeenCalledOnce();
    window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);
  });
});
