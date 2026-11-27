import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

// #1276: a player is offered only their own pages, has no Live Map, never lands
// on a page the API refuses, and the app does not poll admin endpoints for them.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function stubPlayer() {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn().mockImplementation((input: string | URL | Request) => {
    const path = String(input instanceof Request ? input.url : input);
    calls.push(path);
    if (path.includes("/api/auth/state")) return jsonResponse({ authenticated: true, csrfToken: "csrf", config: { discordOAuthConfigured: true } });
    if (path.includes("/api/auth/me")) return jsonResponse({ user: { id: "p1", username: "p", displayName: "P", tier: "player", guildId: "" }, allowedActions: ["server:read", "players:read", "guilds:read", "bases:read", "vehicles:read", "storage:read"], secondFactorEnrolled: true });
    if (path.includes("/api/server/status")) return jsonResponse({ ok: true, data: { summary: { overall: "READY", title: "Test Server" }, gameServers: [] } });
    if (path.includes("/api/players/online")) return jsonResponse({ rows: [] });
    return jsonResponse({ rows: [], totalCount: 0 });
  }));
  return calls;
}

describe("player tier navigation", () => {
  it("shows only the player's pages, with no Live Map, and sends no admin requests", async () => {
    const calls = stubPlayer();
    render(<App />);
    const nav = await waitFor(() => {
      const el = document.getElementById("console-navigation");
      expect(el).toBeInTheDocument();
      return el as HTMLElement;
    });
    await waitFor(() => expect(within(nav).queryByText("Server Control")).not.toBeInTheDocument());
    for (const shown of ["Home", "Players", "Guilds", "Bases", "Vehicles", "Storage"]) expect(within(nav).getByText(shown)).toBeInTheDocument();
    for (const hidden of ["Live Map", "Maps", "Exchange", "Landsraad", "Admin Tools", "Care Package", "Addons", "Backups", "Logs", "Updates", "Settings", "Database"]) {
      expect(within(nav).queryByText(hidden)).not.toBeInTheDocument();
    }
    expect(await screen.findByText("Test Server")).toBeInTheDocument();
    for (const forbidden of ["/api/server/readiness", "/api/public-directory/status", "/api/addons", "/api/map"]) {
      expect(calls.some((c) => c.includes(forbidden)), forbidden).toBe(false);
    }
  });

  it("moves a player off a persisted page they may not open", async () => {
    window.sessionStorage.setItem("dune-console:active-tab", "Live Map");
    stubPlayer();
    render(<App />);
    expect(await screen.findByText("Test Server")).toBeInTheDocument();
    await waitFor(() => expect(window.sessionStorage.getItem("dune-console:active-tab")).toBe("Home"));
  });
});
