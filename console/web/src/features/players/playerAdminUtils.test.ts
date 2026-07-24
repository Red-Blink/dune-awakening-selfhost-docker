import { describe, expect, it } from "vitest";
import { playerAssignedFaction } from "./playerAdminUtils";

describe("playerAssignedFaction", () => {
  it("resolves assigned factions without relying on display casing", () => {
    expect(playerAssignedFaction("atreides", true)).toEqual({ id: 1, name: "Atreides" });
    expect(playerAssignedFaction("HARKONNEN", true)).toEqual({ id: 2, name: "Harkonnen" });
    expect(playerAssignedFaction("Smuggler", true)).toEqual({ id: 4, name: "Smuggler" });
  });

  it("hides reputation controls for unassigned or unsupported factions", () => {
    expect(playerAssignedFaction("Atreides", false)).toBeNull();
    expect(playerAssignedFaction("Unassigned", true)).toBeNull();
    expect(playerAssignedFaction("Neutral", true)).toBeNull();
  });
});
