import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// Review finding: /api/auth/state said authenticated:true for an
// enrollment-scope session, so a reload during setup rendered the full console
// where every route is 403 -- a dead end. The state now carries `scope`, and
// App resumes the setup screen from it.
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function json(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("App resumes two-factor setup from the session scope on reload", () => {
  for (const scope of ["enroll", "resetup"] as const) {
    it(`renders the setup screen, not the console, for an authenticated '${scope}' session`, async () => {
      vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
        const path = String(input instanceof Request ? input.url : input);
        if (path.includes("/api/auth/state")) return json(200, { authenticated: true, csrfToken: "csrf", scope, config: {} });
        if (path.includes("/api/auth/2fa/setup")) return json(200, { secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/x", qrCodeDataUri: "data:image/png;base64,AAAA" });
        return json(403, { enrollmentRequired: true, error: "Finish setting up two-factor authentication before using the console." });
      }));
      render(<App />);
      await screen.findByText(scope === "resetup" ? "Set up a new authenticator" : "Set up two-factor authentication");
      expect(document.getElementById("console-navigation")).not.toBeInTheDocument();
      const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
      expect(calls.some((p) => p.includes("/api/setup/state"))).toBe(false);
    });
  }
});
