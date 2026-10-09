import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// Review finding: every non-owner Discord tier (moderator/player) was
// trapped in the first-run SetupWizard. App gated on GET /api/setup/state,
// which needs setup:read; those tiers get 403, the catch left setupState null,
// "setup incomplete" rendered the wizard, and the wizard has no way out.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function stubSession(allowedActions: string[], setupStatus: number) {
  vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
    const path = String(input instanceof Request ? input.url : input);
    if (path.includes("/api/auth/state")) return jsonResponse({ authenticated: true, csrfToken: "csrf", config: {} });
    if (path.includes("/api/auth/me")) return jsonResponse({ user: { id: "u1", username: "mod", displayName: "Mod", tier: "moderator", guildId: "" }, allowedActions, secondFactorEnrolled: false });
    if (path.includes("/api/setup/state")) {
      return setupStatus === 200
        ? jsonResponse({ files: { env: false, token: false, battlegroup: false, complete: false }, config: {} })
        : jsonResponse({ error: "Your account does not have permission to access this resource." }, setupStatus);
    }
    return jsonResponse({});
  }));
}

// Review finding: a failed /api/auth/me read leaves allowedActions at its
// initial [], indistinguishable from "this tier really has zero actions"
// (the moderator/player case the first test above covers) unless the
// fetch failure is tracked separately -- conflating the two reproduced the
// exact same trap for a transient network blip / 500, regardless of tier.
function stubSessionMeFails() {
  vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
    const path = String(input instanceof Request ? input.url : input);
    if (path.includes("/api/auth/state")) return jsonResponse({ authenticated: true, csrfToken: "csrf", config: {} });
    if (path.includes("/api/auth/me")) return Promise.reject(new Error("network error"));
    if (path.includes("/api/setup/state")) return jsonResponse({ error: "Your account does not have permission to access this resource." }, 403);
    return jsonResponse({});
  }));
}

describe("App first-run setup gate respects the session's permissions", () => {
  it("renders the console, not the setup wizard, for a tier without setup:read", async () => {
    stubSession(["server:read", "players:read"], 403);
    render(<App />);
    await waitFor(() => expect(document.getElementById("console-navigation")).toBeInTheDocument());
    expect(screen.queryByText(/Finish the first-time setup to unlock the console/)).not.toBeInTheDocument();
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(calls.some((p) => p.includes("/api/setup/state"))).toBe(false); // never even asked
  });

  it("renders the console, not the setup wizard, when /api/auth/me itself fails (review finding)", async () => {
    stubSessionMeFails();
    render(<App />);
    await waitFor(() => expect(document.getElementById("console-navigation")).toBeInTheDocument());
    expect(screen.queryByText(/Finish the first-time setup to unlock the console/)).not.toBeInTheDocument();
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(calls.some((p) => p.includes("/api/setup/state"))).toBe(false); // never even asked
  });

  it("still shows the first-run wizard to a session that holds setup:read on an unprovisioned install", async () => {
    stubSession(["setup:read", "setup:write", "server:read"], 200);
    render(<App />);
    await screen.findByText(/Finish the first-time setup to unlock the console/);
    expect(document.getElementById("console-navigation")).not.toBeInTheDocument();
  });
});
