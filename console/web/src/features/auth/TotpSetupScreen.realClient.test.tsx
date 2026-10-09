import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TotpSetupScreen } from "./TotpSetupScreen";
import { AUTH_SESSION_EXPIRED_EVENT, setCsrfToken } from "../../api/client";

// Unlike TotpSetupScreen.test.tsx (which mocks post()), this drives the REAL
// client so the server's 401-on-wrong-code contract is exercised end to end.
afterEach(() => { setCsrfToken(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function json(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("TotpSetupScreen with the real API client", () => {
  it("stays on the setup screen and shows the server's message after a wrong code", async () => {
    const expired = vi.fn();
    window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
      const path = String(input instanceof Request ? input.url : input);
      if (path.includes("/api/auth/2fa/setup")) return json(200, { secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/x", qrCodeDataUri: "data:image/png;base64,AAAA" });
      if (path.includes("/api/auth/2fa/confirm")) return json(401, { error: "That code was not accepted. Check your device's clock and enter the current code." });
      return json(200, {});
    }));
    const onComplete = vi.fn(); const onCancel = vi.fn();
    render(<TotpSetupScreen mode="enroll" onComplete={onComplete} onCancel={onCancel} />);
    const input = await screen.findByPlaceholderText("6-digit code");
    fireEvent.change(input, { target: { value: "000000" } });
    fireEvent.click(screen.getByText("Confirm"));
    await screen.findByText(/That code was not accepted/);
    expect(expired).not.toHaveBeenCalled();
    expect(screen.getByAltText("Authenticator QR code")).toBeInTheDocument(); // still mounted, same secret
    expect(onComplete).not.toHaveBeenCalled();
    window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, expired);
  });
});
