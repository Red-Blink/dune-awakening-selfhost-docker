// Boot-time half of the console themes. main.tsx imports only this file, so the
// palette catalogue (consolePalettes.ts, loaded by themeEngine.ts) stays out of the
// entry chunk. The engine records the tokens of the chosen theme in a small
// cache; this module re-applies them synchronously (no flash of the default
// look) and loads the engine afterwards to reconcile against the real catalogue.
export const DEFAULT_THEME_ID = "default";
export const THEME_STORAGE_KEY = "dune-console-theme";
export const THEME_CACHE_KEY = "dune-console-theme-cache";

// Keep cache application and reset limited to the properties this feature owns.
// A stale cache must not install unrelated properties that Default cannot undo.
export const THEME_TOKEN_NAMES = [
  "--bg", "--panel", "--panel-soft", "--panel-muted", "--border", "--border-strong",
  "--text", "--text-strong", "--muted", "--muted-warm", "--text-subtle", "--text-faint",
  "--title", "--accent", "--accent-strong", "--success", "--success-text", "--danger",
  "--danger-strong", "--danger-text", "--danger-signal", "--state-motion", "--warning", "--bg-glow",
] as const;
const TOKEN_NAMES = new Set<string>(THEME_TOKEN_NAMES);

export interface ThemeCache { id: string; appearance: "dark" | "light"; tokens: Record<string, string> }

// The cache is plain storage anyone with page access can edit, so only the exact
// shapes the engine emits are accepted: custom-property names, hex colours and
// the one rgba() glow. Anything else makes the whole cache count as absent.
const TOKEN_VALUE = /^(#[0-9a-f]{6}|rgba\(\d{1,3}, \d{1,3}, \d{1,3}, \.\d{1,2}\))$/i;

export function readThemeCache(id: string): ThemeCache | null {
  try {
    const raw = window.localStorage.getItem(THEME_CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw) as Partial<ThemeCache> | null;
    if (!cache || cache.id !== id || (cache.appearance !== "dark" && cache.appearance !== "light")) return null;
    const tokens = cache.tokens;
    if (!tokens || typeof tokens !== "object") return null;
    const entries = Object.entries(tokens);
    if (entries.length === 0 || entries.length > 64) return null;
    if (!entries.every(([name, value]) => TOKEN_NAMES.has(name) && typeof value === "string" && TOKEN_VALUE.test(value))) return null;
    return { id, appearance: cache.appearance, tokens: tokens as Record<string, string> };
  } catch { return null; }
}

function storedThemeId(): string {
  try { return window.localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME_ID; } catch { return DEFAULT_THEME_ID; }
}

function loadEngine() {
  return import("./themeEngine");
}

function syncTheme(root: HTMLElement = document.documentElement): void {
  const id = storedThemeId();
  if (id === DEFAULT_THEME_ID) {
    // Nothing applied means nothing to undo, and the default look never loads the catalogue.
    if (root.dataset.theme) void loadEngine().then((engine) => engine.applyTheme(DEFAULT_THEME_ID)).catch(() => {});
    return;
  }
  const cache = readThemeCache(id);
  if (cache) {
    Object.entries(cache.tokens).forEach(([name, value]) => root.style.setProperty(name, value));
    root.style.setProperty("color-scheme", cache.appearance);
    root.dataset.theme = id;
  }
  // Reconcile with the real catalogue: refreshes the cache after an upgrade and
  // drops a stored id that no longer exists.
  void loadEngine().then((engine) => engine.applyTheme(engine.loadSelectedTheme())).catch(() => {});
}

let listening = false;

export function initTheme(): void {
  syncTheme();
  if (listening) return;
  listening = true;
  // Another console tab picked a theme: follow it.
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) syncTheme();
  });
}
