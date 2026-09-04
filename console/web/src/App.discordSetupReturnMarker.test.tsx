import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, loadPersistedTab } from "./App";

// #643 §4.1 (Eight Hats Architect CRITICAL, #676's own L1 audit): an operator
// RECONFIGURING Discord from an already-authenticated Settings session sets
// a sessionStorage marker before the setup-mode OAuth round-trip, so App.tsx
// can tell that return apart from the pre-login first-run flow -- both land
// on the identical "/?discordSetup=done" URL, but only the pre-login flow
// may still force a logout via the standalone wizard's onDone.
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
    if (path.includes("/api/auth/me")) return jsonResponse({ tier: "owner", username: "owner", displayName: "Owner", secondFactorEnrolled: false });
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

  it("marker ABSENT (pre-login first-run flow): the standalone wizard mount is unaffected -- tab is not silently forced to Settings", async () => {
    // No marker set at all -- this is the original, unchanged pre-login path.
    stubDiscordSetupDoneUrl();
    stubAuthenticatedOwner();

    render(<App />);

    // The pre-login flow's own discordSetupOpen/wantDiscordSetup derivation
    // (from the bare ?discordSetup URL param) is untouched by this feature --
    // it must not be redirected into Settings by the marker-consumption effect,
    // since there was no marker to consume.
    await new Promise((r) => setTimeout(r, 0));
    expect(loadPersistedTab()).not.toBe("Settings");
  });
});
