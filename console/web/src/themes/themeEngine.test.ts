import { beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_CACHE_KEY, THEME_TOKEN_NAMES } from "./themeBoot";
import { DEFAULT_THEME_ID, getThemes, THEME_STORAGE_KEY, applyTheme, buildThemeTokens, contrast, ensureContrast, loadSelectedTheme, parseHex, saveSelectedTheme } from "./themeEngine";
import { CONSOLE_PALETTES } from "./consolePalettes";

const THEMES = getThemes();

// Independent WCAG 2.x implementation so the check does not grade ensureContrast with its own yardstick.
function wcag(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("palette catalogue", () => {
  it("offers the project's 19 dark palettes with unique ids and colour combinations", () => {
    expect(THEMES).toHaveLength(19);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(19);
    expect(THEMES.every((t) => t.appearance === "dark")).toBe(true);
    expect(THEMES.map((t) => t.id)).toEqual(CONSOLE_PALETTES.map((p) => p.id));
    expect(new Set(THEMES.map((t) => [t.tokens["--bg"], t.tokens["--panel"], t.tokens["--accent"]].join())).size).toBe(19);
  });

  it("emits a full, valid token set for every palette", () => {
    const keys = Object.keys(THEMES[0].tokens).sort();
    expect(keys).toEqual([...THEME_TOKEN_NAMES].sort());
    for (const theme of THEMES) {
      expect(Object.keys(theme.tokens).sort(), theme.id).toEqual(keys);
      for (const [name, value] of Object.entries(theme.tokens)) {
        if (name !== "--bg-glow") expect(parseHex(value), `${theme.id} ${name}`).not.toBeNull();
      }
    }
  });

  it("keeps readable text at AA or better on the panel and canvas for every palette (independent calculation)", () => {
    for (const theme of THEMES) {
      for (const token of ["--text", "--text-strong", "--muted", "--text-faint", "--text-subtle", "--title", "--success-text", "--danger-text", "--state-motion"]) {
        const fg = theme.tokens[token];
        expect(Math.min(wcag(fg, theme.tokens["--bg"]), wcag(fg, theme.tokens["--panel"])), `${theme.id} ${token}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const token of ["--accent", "--warning"]) {
        expect(wcag(theme.tokens[token], theme.tokens["--panel"]), `${theme.id} ${token}`).toBeGreaterThanOrEqual(2.99);
      }
    }
  });
});

describe("ensureContrast", () => {
  it("leaves a passing colour alone and lifts a failing one", () => {
    const dark = parseHex("#101010")!;
    expect(ensureContrast([240, 240, 240], [dark], 7)).toEqual([240, 240, 240]);
    expect(contrast(ensureContrast([30, 30, 30], [dark], 4.5), dark)).toBeGreaterThanOrEqual(4.5);
  });

  it("darkens toward black on a light surface", () => {
    const light = parseHex("#fafafa")!;
    expect(contrast(ensureContrast([200, 200, 200], [light], 4.5), light)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("buildThemeTokens", () => {
  it("derives a light-palette token set that still meets AA (kept for when light themes are offered)", () => {
    const tokens = buildThemeTokens({ background: "#fafafa", panel: "#f4f4f4" });
    expect(contrast(parseHex(tokens["--muted"])!, parseHex(tokens["--bg"])!)).toBeGreaterThanOrEqual(4.49);
  });

  it("falls back instead of throwing on an empty palette", () => {
    expect(buildThemeTokens({})["--bg"]).toBe("#0d0f12");
  });
});

describe("apply and persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    applyTheme(DEFAULT_THEME_ID);
  });

  it("saves, applies, restores and then resets cleanly", () => {
    const theme = THEMES.find((t) => t.id === "dd-amber-dunes")!;
    saveSelectedTheme("dd-amber-dunes");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dd-amber-dunes");
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe(theme.tokens["--bg"]);
    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("dark");
    expect(loadSelectedTheme()).toBe("dd-amber-dunes");
    saveSelectedTheme(DEFAULT_THEME_ID);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("");
    expect(document.documentElement.style.getPropertyValue("color-scheme")).toBe("");
    expect(document.documentElement.getAttribute("style") ?? "").toBe("");
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("keeps the boot cache in step with the choice", () => {
    saveSelectedTheme("dd-amber-dunes");
    const cached = JSON.parse(window.localStorage.getItem(THEME_CACHE_KEY)!);
    expect(cached.id).toBe("dd-amber-dunes");
    expect(cached.tokens).toEqual(THEMES.find((t) => t.id === "dd-amber-dunes")!.tokens);
    saveSelectedTheme(DEFAULT_THEME_ID);
    expect(window.localStorage.getItem(THEME_CACHE_KEY)).toBeNull();
  });

  it("switching from one theme to another leaves nothing of the first behind", () => {
    saveSelectedTheme("dd-amber-dunes");
    saveSelectedTheme("dd-oasis");
    const oasis = THEMES.find((t) => t.id === "dd-oasis")!;
    for (const [name, value] of Object.entries(oasis.tokens)) expect(document.documentElement.style.getPropertyValue(name), name).toBe(value);
    expect(document.documentElement.dataset.theme).toBe("dd-oasis");
  });

  it("applyTheme with an unknown id clears any theme", () => {
    saveSelectedTheme("dd-amber-dunes");
    applyTheme("nope");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(document.documentElement.getAttribute("style") ?? "").toBe("");
  });

  it("survives storage that throws", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    try {
      expect(loadSelectedTheme()).toBe(DEFAULT_THEME_ID);
      expect(() => saveSelectedTheme("dd-amber-dunes")).not.toThrow();
      expect(document.documentElement.dataset.theme).toBe("dd-amber-dunes");
      expect(loadSelectedTheme()).toBe("dd-amber-dunes");
    } finally { get.mockRestore(); set.mockRestore(); }
  });

  it("ignores a stored id that no longer exists", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "gone");
    expect(loadSelectedTheme()).toBe(DEFAULT_THEME_ID);
  });
});
