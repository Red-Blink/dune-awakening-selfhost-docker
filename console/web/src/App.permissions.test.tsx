import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

afterEach(() => { vi.unstubAllGlobals(); window.sessionStorage.clear(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function session(actions: string[], tier = "player") {
  const current = { actions, failed: false };
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input instanceof Request ? input.url : input);
    if (path === "/api/auth/state") return json({ authenticated: true, csrfToken: "test-csrf", config: { version: "v1.4.54", discordOAuthConfigured: true } });
    if (path === "/api/auth/me") return current.failed ? json({ error: "Unavailable" }, 500) : json({ user: { id: "test-user", username: "tester", displayName: "Tester", tier, guildId: "test-guild" }, allowedActions: current.actions });
    if (path === "/api/setup/state") return json({ files: { complete: true }, config: {} });
    return json({ rows: [], items: [], stdout: "", exitCode: 0, data: { summary: {}, containers: [], gameServers: [], automation: {}, database: {}, rabbitmq: {}, fls: {} } });
  });
  vi.stubGlobal("fetch", fetch);
  return { current, fetch };
}

describe("page and component permissions", () => {
  it("hides denied pages for a Player and never mounts a forbidden saved page", async () => {
    window.sessionStorage.setItem("dune-console:active-tab", "Settings");
    const { fetch } = session(["server:read", "players:read", "guilds:read", "maps:read"]);
    render(<App />);
    const nav = await screen.findByRole("navigation");
    for (const name of ["Players", "Guilds"]) expect(within(nav).getByRole("button", { name })).toBeVisible();
    for (const name of ["Server Control", "Admin Tools", "Settings", "Access Control", "Database", "Backups", "Storage", "Vehicles", "Updates", "Maps", "Live Map"]) expect(within(nav).queryByRole("button", { name })).toBeNull();
    expect(fetch.mock.calls.some(([path]) => String(path) === "/api/settings")).toBe(false);
    expect(screen.getByRole("button", { name: "Open Updates" })).toHaveTextContent("v1.4.54");
    expect(screen.getByRole("button", { name: "Open Updates" })).toBeDisabled();
  });

  it("renders only Broadcast when that is the account's only granted component", async () => {
    window.sessionStorage.setItem("dune-console:active-tab", "Admin Tools");
    const { fetch } = session(["admin:broadcast"], "moderator");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Send Server Broadcast" }, { timeout: 5000 })).toBeVisible();
    for (const text of ["Send Map Message", "Message of the Day", "Character Transfer Settings", "Schedule Server Restart", "Hydrate All", "Kick All"]) expect(screen.queryByText(text)).toBeNull();
    const calls = fetch.mock.calls.map(([path]) => String(path));
    for (const path of ["/api/admin/character-transfer-settings", "/api/admin/message-of-the-day", "/api/admin/history", "/api/settings", "/api/server/restart-schedule"]) expect(calls).not.toContain(path);
  });

  it("does not interpret an empty action list as unrestricted", async () => {
    session([]);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "No Pages Available" })).toBeVisible();
    const nav = screen.getByRole("navigation");
    expect(within(nav).queryAllByRole("button")).toHaveLength(0);
  });

  it("removes pages and content when permissions are revoked while signed in", async () => {
    const { current } = session(["players:read"]);
    render(<App />);
    const nav = await screen.findByRole("navigation");
    expect(within(nav).getByRole("button", { name: "Players" })).toBeVisible();
    current.actions = [];
    fireEvent.focus(window);
    await screen.findByRole("heading", { name: "No Pages Available" });
    expect(within(nav).queryByRole("button", { name: "Players" })).toBeNull();
  });

  it("fails closed on an access lookup failure and allows retry", async () => {
    const { current } = session(["players:read"]);
    current.failed = true;
    render(<App />);
    await screen.findByRole("button", { name: "Try Again" });
    expect(screen.queryByRole("navigation")).toBeNull();
    current.failed = false;
    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    await waitFor(() => expect(screen.getByRole("navigation")).toBeInTheDocument());
  });
});
