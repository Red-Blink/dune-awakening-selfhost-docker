import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, persistActiveTab } from "./App";

// #676 §7: the guided offer screen. Shown at most once, right after a real
// Discord login that follows DiscordSetupWizard's own marker-setting restart
// (see DiscordSetupWizard.test.tsx's own "offer-step marker" suite for the
// marker's SET side; this covers its CONSUME side in App.tsx).
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function stubAuthenticated(userId: string) {
  vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
    const path = String(input instanceof Request ? input.url : input);
    if (path.includes("/api/auth/state")) return jsonResponse({ authenticated: true, csrfToken: "t", scope: null, config: {} });
    if (path.includes("/api/auth/me")) {
      return jsonResponse({
        user: { id: userId, username: "owner", displayName: "Owner", tier: "owner", guildId: "" },
        allowedActions: ["settings:read"],
        secondFactorEnrolled: true,
      });
    }
    return jsonResponse({});
  }));
}

describe("App: DiscordMigrationOffer (#676 §7)", () => {
  it("marker present + a real Discord session (userId set): the offer screen renders", async () => {
    window.sessionStorage.setItem("dune-console:discord-oauth-just-configured", "1");
    stubAuthenticated("222222222222222222");
    render(<App />);

    expect(await screen.findByText("Discord sign-in is connected")).toBeTruthy();
  });

  it("consumes (removes) the marker so a later reload cannot re-trigger it", async () => {
    window.sessionStorage.setItem("dune-console:discord-oauth-just-configured", "1");
    stubAuthenticated("222222222222222222");
    render(<App />);

    await screen.findByText("Discord sign-in is connected");
    expect(window.sessionStorage.getItem("dune-console:discord-oauth-just-configured")).toBeNull();
  });

  it("marker present but a PASSWORD session (userId \"local-owner\"): the offer never shows, and the marker is still consumed", async () => {
    window.sessionStorage.setItem("dune-console:discord-oauth-just-configured", "1");
    stubAuthenticated("local-owner");
    render(<App />);

    await waitFor(() => expect(window.sessionStorage.getItem("dune-console:discord-oauth-just-configured")).toBeNull());
    expect(screen.queryByText("Discord sign-in is connected")).toBeNull();
  });

  it("no marker at all: a normal Discord login never shows the offer", async () => {
    stubAuthenticated("222222222222222222");
    render(<App />);

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Discord sign-in is connected")).toBeNull();
  });

  it("\"Not now\" dismisses without navigating anywhere", async () => {
    window.sessionStorage.setItem("dune-console:discord-oauth-just-configured", "1");
    // Dismissing lands on whatever tab was already active -- Home's own
    // panel has extensive, unrelated data dependencies this test's minimal
    // fetch stub doesn't satisfy, so start on a lighter tab instead of
    // fighting that (pre-existing fragility, not something this feature
    // introduces or needs to fix).
    persistActiveTab("Settings");
    stubAuthenticated("222222222222222222");
    const { unmount } = render(<App />);
    await screen.findByText("Discord sign-in is connected");

    fireEvent.click(screen.getByText("Not now"));

    await waitFor(() => expect(screen.queryByText("Discord sign-in is connected")).toBeNull());
    // Dismissing lands on the full dashboard, which has its own extensive
    // data dependencies unrelated to this feature -- unmount immediately
    // once the assertion above holds, rather than letting further dashboard
    // effects run against this test's deliberately minimal fetch stub.
    unmount();
  });

  it("\"Review Two-Factor Settings\" dismisses the offer and opens Settings", async () => {
    window.sessionStorage.setItem("dune-console:discord-oauth-just-configured", "1");
    stubAuthenticated("222222222222222222");
    const { unmount } = render(<App />);
    await screen.findByText("Discord sign-in is connected");

    fireEvent.click(screen.getByText("Review Two-Factor Settings"));

    await waitFor(() => expect(screen.queryByText("Discord sign-in is connected")).toBeNull());
    // Settings is lazy-loaded; a stable, always-present marker of that tab
    // being active is the sidebar's own active-tab styling, checked via the
    // nav button rather than waiting on the lazy chunk to resolve.
    await waitFor(() => expect(screen.getByRole("button", { name: /settings/i }).className).toContain("active"));
    unmount();
  });
});
