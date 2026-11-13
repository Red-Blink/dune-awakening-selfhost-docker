import { describe, expect, it } from "vitest";
import { HOUSE_SWATCHES } from "./houseSwatches";
import { contrast, getThemes, parseHex, paletteFromSwatch, type Rgb } from "./themeEngine";

describe("House swatch palettes", () => {
  it("offers every House as a palette with a unique id", () => {
    const ids = getThemes().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const house of HOUSE_SWATCHES) expect(ids).toContain(house.id);
    expect(HOUSE_SWATCHES.length).toBeGreaterThanOrEqual(27);
  });

  it("keeps text readable on every House's page and panel", () => {
    for (const house of HOUSE_SWATCHES) {
      const tokens = getThemes().find((t) => t.id === house.id)!.tokens;
      const bg = parseHex(tokens["--bg"]) as Rgb, panel = parseHex(tokens["--panel"]) as Rgb;
      expect(contrast(parseHex(tokens["--text"]) as Rgb, bg), house.name).toBeGreaterThanOrEqual(7);
      expect(contrast(parseHex(tokens["--muted"]) as Rgb, panel), house.name).toBeGreaterThanOrEqual(4.5);
      expect(contrast(parseHex(tokens["--accent"]) as Rgb, panel), house.name).toBeGreaterThanOrEqual(3);
    }
  });

  it("derives a dark page from light dye sets and distinct surfaces", () => {
    const kenola = HOUSE_SWATCHES.find((h) => h.name === "House Kenola")!;
    const { background, panel } = paletteFromSwatch(kenola);
    expect(background).not.toBe(panel);
    expect((parseHex(background) as Rgb).every((v) => v < 60)).toBe(true);
  });
});
