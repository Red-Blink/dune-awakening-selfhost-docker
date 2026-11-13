import { describe, expect, it } from "vitest";
import { HOUSE_SWATCHES } from "./houseSwatches";
import { contrast, getThemes, parseHex, paletteFromSwatch, type Rgb } from "./themeEngine";

describe("House swatch palettes", () => {
  it("offers every House as a palette with a unique id", () => {
    const ids = getThemes().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const house of HOUSE_SWATCHES) expect(ids).toContain(house.id);
    // Pinned by name so swapping one entry for another is caught, not just a changed count.
    for (const name of ["House Atreides", "House Harkonnen", "House Alexin", "House Wydras", "Sunset Dye", "Dusk Rider", "Blue Dasher", "CHOAM", "Hot Zone", "Water Shipper Utility"]) {
      expect(HOUSE_SWATCHES.map((h) => h.name), name).toContain(name);
    }
    expect(HOUSE_SWATCHES.filter((h) => h.id.startsWith("house-"))).toHaveLength(27);
    expect(HOUSE_SWATCHES.filter((h) => h.id.startsWith("swatch-"))).toHaveLength(15);
  });

  it("keeps text readable on every House's page and panel", () => {
    for (const house of HOUSE_SWATCHES) {
      const tokens = getThemes().find((t) => t.id === house.id)!.tokens;
      const bg = parseHex(tokens["--bg"]) as Rgb, panel = parseHex(tokens["--panel"]) as Rgb;
      expect(contrast(parseHex(tokens["--text"]) as Rgb, bg), house.name).toBeGreaterThanOrEqual(7);
      expect(contrast(parseHex(tokens["--muted"]) as Rgb, panel), house.name).toBeGreaterThanOrEqual(4.5);
      expect(contrast(parseHex(tokens["--accent"]) as Rgb, panel), house.name).toBeGreaterThanOrEqual(3);
      expect(contrast(parseHex(tokens["--text-faint"]) as Rgb, panel), house.name).toBeGreaterThanOrEqual(4.5);
      expect(contrast(parseHex(tokens["--title"]) as Rgb, panel), house.name).toBeGreaterThanOrEqual(4.5);
      expect(contrast(parseHex(tokens["--accent-strong"]) as Rgb, panel), house.name).toBeGreaterThanOrEqual(3);
    }
  });

  it("derives a dark page from light dye sets and distinct surfaces", () => {
    const kenola = HOUSE_SWATCHES.find((h) => h.name === "House Kenola")!;
    const { background, panel } = paletteFromSwatch(kenola);
    expect(background).not.toBe(panel);
    expect((parseHex(background) as Rgb).every((v) => v < 60)).toBe(true);
  });

  it("picks the most vivid light dye as the accent", () => {
    const atreides = HOUSE_SWATCHES.find((h) => h.name === "House Atreides")!;
    expect(paletteFromSwatch(atreides).accent).toBe("#849141");
    const hot = HOUSE_SWATCHES.find((h) => h.name === "Hot Zone")!;
    expect(paletteFromSwatch(hot).accent).toBe("#c5c85f");
  });

  it("handles degenerate dye sets without throwing and keeps surfaces apart", () => {
    const mk = (colors: [string, string, string, string]) => paletteFromSwatch({ id: "x", name: "x", colors });
    for (const colors of [["#808080", "#808080", "#808080", "#808080"], ["#ffffff", "#ffffff", "#ffffff", "#ffffff"], ["#000000", "#000000", "#000000", "#000000"], ["nope", "nope", "nope", "nope"]] as [string, string, string, string][]) {
      const palette = mk(colors);
      expect(Object.values(palette).every((value) => /^#[0-9a-f]{6}$/.test(value)), colors.join()).toBe(true);
      expect(palette.background).not.toBe(palette.panel);
    }
  });
});
