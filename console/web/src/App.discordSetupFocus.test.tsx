import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// Live-testing feedback from the upstream maintainer (issue #666): clicking
// "Set up Discord sign-in" dead-ended into "Enter the admin password above"
// with no visual cue where "above" was, and no indication of what to do next.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function stubLoggedOutNoDiscord() {
  vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
    const path = String(input instanceof Request ? input.url : input);
    if (path.includes("/api/auth/state")) return jsonResponse({ authenticated: false, csrfToken: null, config: {} });
    return jsonResponse({});
  }));
}

describe("Sign-in screen: setting up Discord focuses the password field", () => {
  it("focuses the admin-password input and names the next action when 'Set up Discord sign-in' is clicked", async () => {
    stubLoggedOutNoDiscord();
    render(<App />);

    const passwordInput = await screen.findByLabelText("Admin password");
    expect(document.activeElement).not.toBe(passwordInput);

    fireEvent.click(screen.getByText("Set up Discord sign-in"));

    expect(document.activeElement).toBe(passwordInput);
    expect(screen.getByText(/select/i).closest("p")?.textContent).toMatch(/type your admin password above.*sign in/i);
  });
});
