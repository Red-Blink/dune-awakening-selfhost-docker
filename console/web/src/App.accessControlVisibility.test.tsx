import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// Live-testing finding: Access Control (the multi-tier RBAC policy editor)
// showed all tiers even when Discord OAuth isn't configured at all -- in
// that state, a password/TOTP session is always "owner" (Tier 3 has no role
// concept), owner already has every permission, and no other tier is
// reachable by anyone (Discord role mapping is the only way to become
// admin/moderator/player). The editor was real UI with nothing real to
// configure. Access Control should only appear once Discord sign-in is
// actually configured -- that's the only thing that makes its multi-tier
// grid meaningful.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function stubSession(discordOAuthConfigured: boolean) {
  vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
    const path = String(input instanceof Request ? input.url : input);
    if (path.includes("/api/auth/state")) return jsonResponse({ authenticated: true, csrfToken: "csrf", config: { discordOAuthConfigured } });
    // A real /api/auth/me response returns the EXPANDED action list for the
    // tier (resolveAllowedActions() expands "*" into every real action) --
    // include settings:read so this session actually passes the pre-existing
    // Settings/Access-Control visibility gate the same way a real owner
    // session would, and this test exercises only the new Discord-config gate.
    if (path.includes("/api/auth/me")) return jsonResponse({ user: { id: "u1", username: "owner", displayName: "Owner", tier: "owner", guildId: "" }, allowedActions: ["server:read", "settings:read", "settings:write"], secondFactorEnrolled: true });
    if (path.includes("/api/setup/state")) return jsonResponse({ files: { env: true, token: true, battlegroup: true, complete: true }, config: {} });
    // Default: the shape a run-command-result endpoint (server status/
    // readiness/etc.) returns, so components reading .stdout don't crash on
    // undefined for the many Home-panel calls this test doesn't care about.
    return jsonResponse({ stdout: "", stderr: "", exitCode: 0 });
  }));
}

describe("Access Control nav visibility depends on Discord OAuth actually being configured", () => {
  it("hides Access Control for a password/TOTP-only owner session with no Discord OAuth configured", async () => {
    // Land on Settings, not the default Home tab -- Home's panel makes many
    // real-server-status calls unrelated to what this test checks (nav
    // visibility), and this test only needs the sidebar to render.
    window.sessionStorage.setItem("dune-console:active-tab", "Settings");
    stubSession(false);
    render(<App />);
    await waitFor(() => expect(document.getElementById("console-navigation")).toBeInTheDocument());
    expect(screen.queryByText("Access Control")).not.toBeInTheDocument();
    // Settings must still be visible -- it's where Discord OAuth gets
    // configured. (getAllByText, not getByText: the active Settings panel's
    // own heading also renders the word "Settings".)
    expect(screen.getAllByText("Settings").length).toBeGreaterThan(0);
  });

  it("shows Access Control once Discord OAuth is configured, even for the owner's own password session", async () => {
    window.sessionStorage.setItem("dune-console:active-tab", "Settings");
    stubSession(true);
    render(<App />);
    await waitFor(() => expect(document.getElementById("console-navigation")).toBeInTheDocument());
    expect(await screen.findByText("Access Control")).toBeInTheDocument();
  });
});
