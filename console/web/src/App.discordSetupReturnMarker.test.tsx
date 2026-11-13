import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, loadPersistedTab } from "./App";

// Both marked OAuth returns and older setup links resume inside Settings.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function stubDiscordSetupDoneUrl() {
  Object.defineProperty(window, "location", {
    value: { ...window.location, search: "?discordSetup=done", pathname: "/" },
    writable: true,
  });
}

function stubAuthenticatedOwner() {
  const logoutCalls: string[] = [];
  vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
    const path = String(input instanceof Request ? input.url : input);
    if (path.includes("/api/auth/logout")) { logoutCalls.push(path); return jsonResponse({ ok: true }); }
    if (path.includes("/api/auth/state")) return jsonResponse({ authenticated: true, csrfToken: "t", scope: null, config: { discordOAuthConfigured: true } });
    if (path.includes("/api/auth/me")) return jsonResponse({ user: { tier: "owner", username: "owner", displayName: "Owner" }, allowedActions: ["*"], secondFactorEnrolled: false });
    // Broad catch-all for the many other endpoints an authenticated dashboard
    // mount probes (status, actions, updates, etc.) -- none of them are what
    // this test is about; a generic empty success keeps them from hanging or
    // throwing so the marker-consumption effect's own behavior is what's
    // actually being observed.
    return jsonResponse({});
  }));
  return logoutCalls;
}

describe("App: discordSetupReturnMarker (#643 §4.1)", () => {
  it("waits for the owner session before displaying an OAuth return instead of flashing the password login", async () => {
    stubDiscordSetupDoneUrl();
    let finish!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => { finish = resolve; });
    vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
      const path = String(input instanceof Request ? input.url : input);
      if (path.includes("/api/auth/state")) return pending.then(response => response.clone());
      if (path.includes("/api/auth/me")) return jsonResponse({ user: { id: "local-owner", tier: "owner", username: "owner", displayName: "Owner" }, allowedActions: ["*"], secondFactorEnrolled: false });
      if (path.includes("/api/setup/state")) return jsonResponse({ files: { complete: true } });
      return jsonResponse({});
    }));
    render(<App />);
    expect(screen.getByText("Checking Your Session")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign In" })).toBeNull();
    finish(new Response(JSON.stringify({ authenticated: true, csrfToken: "t", config: { discordOAuthConfigured: true } }), { headers: { "content-type": "application/json" } }));
    await waitFor(() => expect(screen.queryByText("Checking Your Session")).toBeNull());
    expect(loadPersistedTab()).toBe("Settings");
    expect(screen.queryByRole("button", { name: "Sign In" })).toBeNull();
  });
  it("marker present: redirects to the Settings tab and never calls /api/auth/logout", async () => {
    window.sessionStorage.setItem("dune-console:discord-setup-return", "1");
    stubDiscordSetupDoneUrl();
    const logoutCalls = stubAuthenticatedOwner();

    render(<App />);

    await waitFor(() => expect(loadPersistedTab()).toBe("Settings"));
    // Give any async onDone/logout path a chance to have fired before asserting its absence.
    await new Promise((r) => setTimeout(r, 0));
    expect(logoutCalls.length).toBe(0);
  });

  it("marker present: consumes (removes) the marker so a later reload of \"/\" cannot re-trigger it", async () => {
    window.sessionStorage.setItem("dune-console:discord-setup-return", "1");
    stubDiscordSetupDoneUrl();
    stubAuthenticatedOwner();

    render(<App />);

    await waitFor(() => expect(window.sessionStorage.getItem("dune-console:discord-setup-return")).toBeNull());
  });

  it("an older setup return without a marker also resumes in Settings without signing out", async () => {
    stubDiscordSetupDoneUrl();
    const logoutCalls = stubAuthenticatedOwner();

    render(<App />);

    await waitFor(() => expect(loadPersistedTab()).toBe("Settings"));
    expect(logoutCalls).toEqual([]);
  });
});
