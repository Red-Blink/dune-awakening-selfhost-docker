import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// Review finding: every other terminal branch of enrollment (a confirmed
// setup, a 409 already-configured) invalidates the server-side session; the
// "Back to sign in" escape hatch skipped that, leaving the session (and any
// pending secret on it) live for the rest of its TTL.
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function json(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("Cancelling two-factor setup invalidates the enrollment session", () => {
  it("clicking 'Back to sign in' calls POST /api/auth/logout", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
      const path = String(input instanceof Request ? input.url : input);
      calls.push(path);
      if (path.includes("/api/auth/state")) return json(200, { authenticated: true, csrfToken: "csrf", scope: "enroll", config: {} });
      if (path.includes("/api/auth/2fa/setup")) return json(200, { secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/x", qrCodeDataUri: "data:image/png;base64,AAAA" });
      if (path.includes("/api/auth/logout")) return json(200, { ok: true });
      return json(200, {});
    }));
    render(<App />);
    const cancel = await screen.findByText("Back to sign in");
    cancel.click();
    await waitFor(() => expect(calls.some((p) => p.includes("/api/auth/logout"))).toBe(true));
  });
});
