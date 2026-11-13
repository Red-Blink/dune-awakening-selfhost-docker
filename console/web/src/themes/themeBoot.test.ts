import { beforeEach, describe, expect, it } from "vitest";
import { getThemes } from "./themeEngine";
import bootSource from "./themeBoot.ts?raw";
import mainSource from "../main.tsx?raw";
import appSource from "../App.tsx?raw";
import { DEFAULT_THEME_ID, THEME_CACHE_KEY, THEME_STORAGE_KEY, initTheme, readThemeCache } from "./themeBoot";

const root = document.documentElement;
const amber = getThemes().find((t) => t.id === "dd-amber-dunes")!;
const oasis = getThemes().find((t) => t.id === "dd-oasis")!;
const cacheOf = (theme: { id: string; appearance: string; tokens: Record<string, string> }) =>
  JSON.stringify({ id: theme.id, appearance: theme.appearance, tokens: theme.tokens });

beforeEach(() => {
  window.localStorage.clear();
  root.removeAttribute("style");
  delete root.dataset.theme;
});

describe("entry chunk stays free of the palette catalogue", () => {
  it("themeBoot and main.tsx never import the engine statically", () => {
    const staticEngineImport = /^\s*(import|export)\b[^\n]*["'][^"']*themeEngine["']/m;
    expect(staticEngineImport.test(bootSource)).toBe(false);
    expect(staticEngineImport.test(mainSource)).toBe(false);
    expect(bootSource).not.toMatch(/import\.meta\.glob|palettes\/|looks\.json/);
  });
});

describe("the theme code is actually wired in", () => {
  it("main.tsx boots the theme before rendering, from the boot module", () => {
    expect(mainSource).toMatch(/import \{ initTheme \} from "\.\/themes\/themeBoot";/);
    expect(mainSource.indexOf("initTheme();")).toBeGreaterThan(-1);
    expect(mainSource.indexOf("initTheme();")).toBeLessThan(mainSource.indexOf("createRoot("));
  });

  it("App.tsx mounts the launcher in the header and closes the mobile nav when it opens", () => {
    expect(appSource).toMatch(/import \{ ThemeLauncher \} from "\.\/themes\/ThemeLauncher";/);
    expect(appSource).toContain("<ThemeLauncher onOpen={closeMobileNav} />");
  });
});

describe("initTheme", () => {
  it("default sets no overrides and does not need the catalogue", () => {
    initTheme();
    expect(root.getAttribute("style") ?? "").toBe("");
    expect(root.dataset.theme).toBeUndefined();
  });

  it("re-applies the cached tokens synchronously, before the catalogue loads", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, amber.id);
    window.localStorage.setItem(THEME_CACHE_KEY, cacheOf(amber));
    initTheme();
    expect(root.dataset.theme).toBe(amber.id);
    expect(root.style.getPropertyValue("--bg")).toBe(amber.tokens["--bg"]);
    expect(root.style.getPropertyValue("color-scheme")).toBe("dark");
  });

  it("reconciles a stale cache with the real catalogue", async () => {
    const stale = { ...amber, tokens: { ...amber.tokens, "--bg": "#123456" } };
    window.localStorage.setItem(THEME_STORAGE_KEY, amber.id);
    window.localStorage.setItem(THEME_CACHE_KEY, cacheOf(stale));
    initTheme();
    expect(root.style.getPropertyValue("--bg")).toBe("#123456");
    await expect.poll(() => root.style.getPropertyValue("--bg")).toBe(amber.tokens["--bg"]);
    expect(JSON.parse(window.localStorage.getItem(THEME_CACHE_KEY)!).tokens["--bg"]).toBe(amber.tokens["--bg"]);
  });

  it("applies a theme from the catalogue when there is no cache (first boot after an upgrade)", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, oasis.id);
    initTheme();
    expect(root.dataset.theme).toBeUndefined();
    await expect.poll(() => root.dataset.theme).toBe(oasis.id);
  });

  it("drops a stored id that no longer exists", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "gone");
    window.localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ id: "gone", appearance: "dark", tokens: { "--bg": "#010203" } }));
    initTheme();
    expect(root.dataset.theme).toBe("gone");
    await expect.poll(() => root.dataset.theme).toBeUndefined();
    expect(root.getAttribute("style") ?? "").toBe("");
    expect(window.localStorage.getItem(THEME_CACHE_KEY)).toBeNull();
  });

  it("follows another tab choosing, then clearing, a theme", async () => {
    initTheme();
    window.localStorage.setItem(THEME_CACHE_KEY, cacheOf(oasis));
    window.localStorage.setItem(THEME_STORAGE_KEY, oasis.id);
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    expect(root.dataset.theme).toBe(oasis.id);
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    await expect.poll(() => root.dataset.theme).toBeUndefined();
    expect(root.getAttribute("style") ?? "").toBe("");
  });

  it("follows another tab clearing storage entirely", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, amber.id);
    window.localStorage.setItem(THEME_CACHE_KEY, cacheOf(amber));
    initTheme();
    window.localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    await expect.poll(() => root.dataset.theme).toBeUndefined();
  });
});

describe("readThemeCache rejects anything the engine could not have written", () => {
  const put = (value: unknown) => window.localStorage.setItem(THEME_CACHE_KEY, typeof value === "string" ? value : JSON.stringify(value));
  const ok = { id: "x", appearance: "dark", tokens: { "--bg": "#0d0f12", "--bg-glow": "rgba(198, 139, 74, .18)" } };

  it("accepts the engine's own shapes", () => {
    put(ok);
    expect(readThemeCache("x")?.tokens["--bg"]).toBe("#0d0f12");
  });

  it.each([
    ["a value that is not a hex colour or the glow", { ...ok, tokens: { "--bg": "url(https://evil.example/x)" } }],
    ["an expression in a value", { ...ok, tokens: { "--bg": "#0d0f12; background: red" } }],
    ["a property name that is not a custom property", { ...ok, tokens: { "background-image": "#0d0f12" } }],
    ["a custom property outside the theme contract", { ...ok, tokens: { "--bg": "#0d0f12", "--retired-theme-color": "#ffffff" } }],
    ["a non-string value", { ...ok, tokens: { "--bg": 5 } }],
    ["an id that differs from the stored choice", { ...ok, id: "other" }],
    ["a bad appearance", { ...ok, appearance: "sepia" }],
    ["no tokens", { ...ok, tokens: {} }],
    ["too many tokens", { ...ok, tokens: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`--t${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, "#000000"])) }],
    ["not JSON", "{nope"],
    ["JSON null", "null"],
  ])("rejects %s", (_label, value) => {
    put(value);
    expect(readThemeCache("x")).toBeNull();
  });

  it("treats a missing cache and the default id as absent", () => {
    expect(readThemeCache("x")).toBeNull();
    expect(DEFAULT_THEME_ID).toBe("default");
  });
});
