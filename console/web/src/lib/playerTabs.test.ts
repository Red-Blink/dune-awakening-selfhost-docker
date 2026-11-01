import { describe, expect, it } from "vitest";
import { PLAYER_TABS, isPlayerTier, tabAllowedForTier } from "./playerTabs";

describe("playerTabs", () => {
  it("offers a player only their own pages, and no map", () => {
    expect([...PLAYER_TABS]).toEqual(["Home", "Players", "Guilds", "Bases", "Vehicles", "Storage"]);
    for (const tab of ["Live Map", "Maps", "Server Control", "Settings", "Exchange", "Admin Tools", "Backups", "Logs"]) {
      expect(tabAllowedForTier(tab, "player")).toBe(false);
    }
  });
  it("does not narrow other tiers or an unknown session", () => {
    for (const tier of ["owner", "admin", "moderator", undefined, null, ""]) {
      expect(tabAllowedForTier("Live Map", tier)).toBe(true);
    }
    expect(isPlayerTier("player")).toBe(true);
    expect(isPlayerTier("admin")).toBe(false);
  });
});
