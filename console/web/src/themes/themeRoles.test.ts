import { describe, expect, it } from "vitest";
import css from "../styles.css?raw";
import { readThemeCache, THEME_CACHE_KEY, THEME_STORAGE_KEY } from "./themeBoot";
import { DEFAULT_THEME_ID, applyTheme, contrast, getThemes, parseHex, type Rgb } from "./themeEngine";
import { ROLE_TOKENS } from "./themeRoles";

const rootBlock = css.slice(0, css.indexOf("}", css.indexOf(":root")) + 1);
const ROLE_USE = /var\((--(?:ink|surface|line|tint)[a-z-]*-[a-z]{1,2})(,[^()]*(?:\([^()]*\))?[^()]*)?\)/g;

describe("role colours", () => {
  it("are never declared in :root, so Default renders every original colour from its fallback", () => {
    expect(rootBlock).not.toMatch(/--(ink|surface|line|tint)[a-z-]*-[a-z]{1,2}\s*:/);
  });

  it("are read in the stylesheet only with a fallback colour, and every table entry is used", () => {
    const used = new Set<string>();
    for (const match of css.matchAll(ROLE_USE)) {
      used.add(match[1]);
      expect(match[2], `${match[1]} needs a fallback`).toMatch(/^,\s*(#[0-9a-f]{6}|rgba\(\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\.\d+\))$/i);
    }
    expect([...used].sort()).toEqual(ROLE_TOKENS.map((role) => role.name).sort());
    expect(new Set(ROLE_TOKENS.map((role) => role.name)).size).toBe(ROLE_TOKENS.length);
  });

  it("are derived for every palette in the shapes the boot cache accepts", () => {
    for (const theme of getThemes()) {
      for (const role of ROLE_TOKENS) {
        expect(theme.tokens[role.name], `${theme.id} ${role.name}`).toMatch(role.alpha === undefined ? /^#[0-9a-f]{6}$/ : /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, \.\d{1,2}\)$/);
      }
    }
  });

  it("keep text readable against the fill it sits on (the page and panel unless the role names a fill)", () => {
    const rgbOf = (value: string, panel: Rgb): Rgb => {
      const rgba = /^rgba\((\d+), (\d+), (\d+), (\.\d+)\)$/.exec(value);
      if (!rgba) return parseHex(value) as Rgb;
      const alpha = Number(rgba[4]);
      return [0, 1, 2].map((i) => panel[i] + (Number(rgba[i + 1]) - panel[i]) * alpha) as Rgb;
    };
    for (const theme of getThemes()) {
      const bg = parseHex(theme.tokens["--bg"]) as Rgb;
      const panel = parseHex(theme.tokens["--panel"]) as Rgb;
      for (const role of ROLE_TOKENS.filter((entry) => entry.kind === "ink")) {
        const fg = parseHex(theme.tokens[role.name]) as Rgb;
        const against = role.on ? [rgbOf(role.on.startsWith("--") ? theme.tokens[role.on] : theme.tokens[`--${role.on}`], panel)] : [bg, panel];
        expect(Math.min(...against.map((surface) => contrast(fg, surface))), `${theme.id} ${role.name} on ${role.on ?? "page"}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("have text on a bright accent fill that is readable on it, in every palette", () => {
    const onAccent = ROLE_TOKENS.filter((role) => role.kind === "ink" && role.on === "accent");
    expect(onAccent.length).toBeGreaterThan(0);
    for (const theme of getThemes()) {
      for (const role of onAccent) {
        expect(contrast(parseHex(theme.tokens[role.name]) as Rgb, parseHex(theme.tokens["--accent"]) as Rgb), `${theme.id} ${role.name}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("follow the palette: the sidebar surface and a card surface differ between two palettes", () => {
    const [first, second] = [getThemes().find((t) => t.id === "dd-amber-dunes")!, getThemes().find((t) => t.id === "dd-ice-blue")!];
    const surfaces = ROLE_TOKENS.filter((role) => role.kind === "surface" && role.alpha === undefined);
    expect(surfaces.length).toBeGreaterThan(5);
    expect(surfaces.filter((role) => first.tokens[role.name] !== second.tokens[role.name]).length).toBeGreaterThan(surfaces.length / 2);
  });

  it("are applied and fully removed with the palette", () => {
    window.localStorage.clear();
    const root = document.documentElement;
    const theme = getThemes().find((t) => t.id === "house-alexin")!;
    applyTheme(theme.id, root);
    for (const role of ROLE_TOKENS) expect(root.style.getPropertyValue(role.name), role.name).toBe(theme.tokens[role.name]);
    expect(JSON.parse(window.localStorage.getItem(THEME_CACHE_KEY) ?? "{}").id).toBe(theme.id);
    window.localStorage.setItem(THEME_STORAGE_KEY, theme.id);
    const cached = readThemeCache(theme.id);
    expect(Object.keys(cached?.tokens ?? {}).filter((name) => ROLE_TOKENS.some((role) => role.name === name))).toHaveLength(ROLE_TOKENS.length);
    applyTheme(DEFAULT_THEME_ID, root);
    expect(root.getAttribute("style") ?? "").toBe("");
  });
});
