import { act, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { canOpenPage, PAGE_ACTIONS, PermissionGate, setConsoleAccess, useConsoleAccess } from "./consoleAccess";

const user = { username: "tester", displayName: "Tester", tier: "player" };

describe("session access", () => {
  it.each([
    ["owner", ["*"], ["Settings", "Access Control", "Database", "Server Control", "Players"]],
    ["admin", ["server:read", "server:start", "players:read", "database:read"], ["Home", "Services", "Server Control", "Players", "Database"]],
    ["moderator", ["players:read", "players:moderate", "admin:broadcast"], ["Players", "Admin Tools"]],
    ["player", ["server:read", "players:read", "guilds:read", "maps:read"], ["Home", "Services", "Players", "Guilds", "Live Map", "Maps"]]
  ])("filters the entire menu using the %s account's grants", (tier, actions, expected) => {
    setConsoleAccess("ready", { ...user, tier }, actions);
    const { result } = renderHook(useConsoleAccess);
    const visible = (Object.keys(PAGE_ACTIONS) as Array<keyof typeof PAGE_ACTIONS>).filter(page => canOpenPage(page, result.current));
    if (tier === "owner") expect(visible).toEqual(Object.keys(PAGE_ACTIONS));
    else expect(visible.sort()).toEqual([...expected].sort());
  });

  it("denies unknown, failed and explicitly empty permissions", () => {
    for (const phase of ["loading", "error", "ready"] as const) {
      setConsoleAccess(phase, user, []);
      const { result, unmount } = renderHook(useConsoleAccess);
      expect(result.current.can("server:read")).toBe(false);
      expect(canOpenPage("Home", result.current)).toBe(false);
      unmount();
    }
  });

  it("uses granted actions rather than assuming a tier can access a page", () => {
    setConsoleAccess("ready", { ...user, tier: "admin" }, ["admin:broadcast"]);
    const { result } = renderHook(useConsoleAccess);
    expect(canOpenPage("Admin Tools", result.current)).toBe(true);
    expect(canOpenPage("Database", result.current)).toBe(false);
    expect(canOpenPage("Settings", result.current)).toBe(false);
    expect(canOpenPage("Home", result.current)).toBe(false);
  });

  it("does not expose owner controls to a read-only account and removes them on revocation", () => {
    setConsoleAccess("ready", user, ["players:read"]);
    render(<><PermissionGate action="players:read"><p>Player List</p></PermissionGate><PermissionGate action="players:reset"><button>Reset Player</button></PermissionGate></>);
    expect(screen.getByText("Player List")).toBeVisible();
    expect(screen.queryByText("Reset Player")).toBeNull();
    act(() => setConsoleAccess("ready", user, []));
    expect(screen.queryByText("Player List")).toBeNull();
  });

  it("requires every permission for compound actions and grants nothing for an empty requirement", () => {
    setConsoleAccess("ready", user, ["vehicles:delete"]);
    render(<><PermissionGate allOf={["vehicles:delete", "vehicles:stored-delete"]}><button>Delete Stored Vehicle</button></PermissionGate><PermissionGate allOf={[]}><p>Invalid Grant</p></PermissionGate></>);
    expect(screen.queryByText("Delete Stored Vehicle")).toBeNull();
    expect(screen.queryByText("Invalid Grant")).toBeNull();
  });

  it("copies grants so a caller cannot broaden access by modifying the supplied array", () => {
    const actions = ["players:read"];
    setConsoleAccess("ready", user, actions);
    actions.push("*");
    const { result } = renderHook(useConsoleAccess);
    expect(result.current.can("settings:write")).toBe(false);
  });
});
