import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// Discord setup belongs in the authenticated owner's Settings, not login.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function stubLoggedOut(discordOAuthConfigured = false) {
  vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
    const path = String(input instanceof Request ? input.url : input);
    if (path.includes("/api/auth/state")) return jsonResponse({ authenticated: false, csrfToken: null, config: { discordOAuthConfigured } });
    return jsonResponse({});
  }));
}

describe("Sign-in screen keeps configuration in Settings", () => {
  it("shows the original styled password sign-in without a Discord setup action", async () => {
    stubLoggedOut();
    render(<App />);
    await screen.findByLabelText("Admin password");
    const submit = screen.getByRole("button", { name: "Sign In" });
    expect(submit).toHaveClass("login-submit-button");
    expect(submit).not.toHaveClass("login-primary-button");
    expect(screen.queryByRole("button", { name: /set up discord/i })).toBeNull();
  });

  it("keeps Discord sign-in available once configured", async () => {
    stubLoggedOut(true);
    render(<App />);
    expect(await screen.findByRole("link", { name: /sign in with discord/i })).toHaveAttribute("href", "/api/auth/discord/start");
    expect(screen.queryByRole("button", { name: /set up discord/i })).toBeNull();
  });

  it("refreshes enabled login methods when returning to the login tab and keeps password access", async () => {
    let enabled = false;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
      const path = String(input instanceof Request ? input.url : input);
      if (path.includes("/api/auth/state")) return jsonResponse({ authenticated: false, csrfToken: null, config: { discordOAuthAppConfigured: true, discordOAuthConfigured: enabled } });
      return jsonResponse({});
    }));
    render(<App />);
    await screen.findByLabelText("Admin password");
    expect(screen.queryByRole("link", { name: "Sign In With Discord" })).toBeNull();
    enabled = true;
    fireEvent(window, new Event("focus"));
    const discord = await screen.findByRole("link", { name: "Sign In With Discord" });
    expect(discord).toHaveClass("login-discord-button-primary");
    expect(discord).toHaveAttribute("href", "/api/auth/discord/start");
    fireEvent.click(screen.getByRole("button", { name: "Use Console Password" }));
    expect(screen.getByLabelText("Admin password")).toBeVisible();
    expect(screen.getByRole("button", { name: "Sign In" })).toHaveClass("login-submit-button");
    enabled = false;
    fireEvent(window, new Event("focus"));
    await screen.findByRole("button", { name: "Sign In" });
    await waitFor(() => expect(screen.queryByRole("link", { name: "Sign In With Discord" })).toBeNull());
  });
});
