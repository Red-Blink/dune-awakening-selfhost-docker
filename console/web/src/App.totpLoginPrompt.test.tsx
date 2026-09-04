import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// Live-testing finding: after entering the correct password on a TOTP-enabled
// console, the page swaps to the authenticator-code field but ALSO throws the
// server's "Enter your authenticator code" message through the same shared,
// red-styled .error paragraph used for real failures (wrong password, wrong
// code, rate limiting) -- at a glance it looks exactly like the password was
// rejected. The server returns the identical `{ totpRequired: true }` shape
// both right after a correct password (no code attempted yet) and after a
// WRONG code is submitted -- the two need different treatment, distinguished
// client-side by whether a code was actually included in the request that
// just went out.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function stubLoggedOut(loginResponses: Array<{ status: number; body: unknown }>) {
  let call = 0;
  vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
    const path = String(input instanceof Request ? input.url : input);
    if (path.includes("/api/auth/state")) return jsonResponse({ authenticated: false, csrfToken: null, config: {} });
    if (path.includes("/api/auth/login")) {
      const next = loginResponses[Math.min(call, loginResponses.length - 1)];
      call++;
      return jsonResponse(next.body, next.status);
    }
    return jsonResponse({});
  }));
}

describe("Login: transitioning to the TOTP step is not shown as a failure", () => {
  it("shows a neutral prompt, not the red error style, right after a correct password (no code attempted yet)", async () => {
    stubLoggedOut([
      { status: 401, body: { totpRequired: true, recoveryAvailable: true, error: "Enter your authenticator code, or use a recovery code if you have lost your device." } },
    ]);
    render(<App />);

    const passwordInput = await screen.findByLabelText("Admin password");
    fireEvent.change(passwordInput, { target: { value: "correct-password" } });
    fireEvent.click(screen.getByText("Sign In"));

    // The authenticator-code field appears...
    await screen.findByLabelText("Authenticator code");
    // ...with a neutral confirmation, not the shared red .error paragraph.
    expect(document.querySelector("p.error")).toBeNull();
    expect(screen.getByText(/password accepted/i)).toBeTruthy();
  });

  it("shows a real, red-styled error when an actually-wrong authenticator code is submitted", async () => {
    stubLoggedOut([
      { status: 401, body: { totpRequired: true, recoveryAvailable: true, error: "Enter your authenticator code, or use a recovery code if you have lost your device." } },
      { status: 401, body: { totpRequired: true, recoveryAvailable: true, error: "That authenticator code was not accepted. Check your device's clock and enter the current code." } },
    ]);
    render(<App />);

    fireEvent.change(await screen.findByLabelText("Admin password"), { target: { value: "correct-password" } });
    fireEvent.click(screen.getByText("Sign In"));
    const codeInput = await screen.findByLabelText("Authenticator code");

    fireEvent.change(codeInput, { target: { value: "000000" } });
    fireEvent.click(screen.getByText("Sign In"));

    await waitFor(() => expect(document.querySelector("p.error")).toBeTruthy());
    expect(screen.getByText(/authenticator code was not accepted/i)).toBeTruthy();
  });
});
