import { describe, expect, it } from "vitest";
import { dungeonDisplayName, formatDungeonDuration } from "./dungeonNames";
import { friendlyMapName } from "../maps/mapNames";

describe("dungeonDisplayName", () => {
  it("resolves the friendly map name through the dungeon number", () => {
    expect(dungeonDisplayName("DA_Dgn_089_Radiation")).toBe(friendlyMapName("CB_Ecolab_Bronze_Green_089"));
  });

  it("falls back to the asset suffix for a number with no known map", () => {
    expect(dungeonDisplayName("DA_Dgn_999_Sand_Storm")).toBe("Sand Storm");
  });

  it("resolves named dungeon assets through CB_Dungeon map names", () => {
    expect(dungeonDisplayName("DA_Dgn_Pit")).toBe(friendlyMapName("CB_Dungeon_ThePit"));
    expect(dungeonDisplayName("DA_Dgn_Hephaestus")).toBe(friendlyMapName("CB_Dungeon_Hephaestus"));
    expect(dungeonDisplayName("DA_Dgn_Mystery_Vault")).toBe("Mystery Vault");
  });

  it("returns ids outside the dungeon asset pattern unchanged", () => {
    expect(dungeonDisplayName("DA_Something_Else")).toBe("DA_Something_Else");
    expect(dungeonDisplayName("")).toBe("Unknown");
  });
});

describe("formatDungeonDuration", () => {
  it("formats minutes and seconds, adding hours only when needed", () => {
    expect(formatDungeonDuration(992717)).toBe("16:33");
    expect(formatDungeonDuration(5000)).toBe("0:05");
    expect(formatDungeonDuration(3_723_000)).toBe("1:02:03");
  });
});
