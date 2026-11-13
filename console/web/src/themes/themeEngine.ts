// Console themes: maps the Fedaykin Dune palettes (MIT, see palettes/LICENSE)
// onto the console's existing CSS custom properties at runtime. The default
// theme sets nothing, so an operator who never opens the picker sees exactly
// the stylesheet's own :root values.
import tabrLooks from "./tabr/looks.json";

const paletteSources = import.meta.glob("./palettes/dune-*.jsonc", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

export const DEFAULT_THEME_ID = "default";
export const THEME_STORAGE_KEY = "dune-console-theme";
// Palettes keep their upstream // comments, hence .jsonc (the release gate parses every *.json strictly).
// Light palettes are vendored and the engine supports them (color-scheme and all),
// but the stylesheet still has many hardcoded dark surfaces, so a light theme
// renders pale text on dark cards. Hidden until the stylesheet is tokenised.
const OFFERED_APPEARANCE: ThemeInfo["appearance"] = "dark";

export type Rgb = [number, number, number];
export type ThemeTokens = Record<string, string>;
export interface ThemeInfo {
  id: string;
  name: string;
  description: string;
  appearance: "dark" | "light";
  tokens: ThemeTokens;
}

/** Palette files are JSON with // comments; strip them without touching strings. */
export function parseJsonc(source: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      out += ch;
      if (ch === "\\") { out += source[i + 1] ?? ""; i += 1; } else if (ch === '"') inString = false;
    } else if (ch === '"') { inString = true; out += ch; }
    else if (ch === "/" && source[i + 1] === "/") { while (i < source.length && source[i] !== "\n") i += 1; out += "\n"; }
    else out += ch;
  }
  return JSON.parse(out);
}

export function parseHex(value: string): Rgb | null {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!match) return null;
  let hex = match[1];
  if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as Rgb;
}

export function luminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Pull `fg` toward white or black (whichever helps) until it meets `ratio` on every surface. */
export function ensureContrast(fg: Rgb, surfaces: Rgb[], ratio: number): Rgb {
  const worst = (c: Rgb) => Math.min(...surfaces.map((s) => contrast(c, s)));
  if (worst(fg) >= ratio) return fg;
  const lightSurfaces = surfaces.reduce((sum, s) => sum + luminance(s), 0) / surfaces.length > 0.4;
  const target: Rgb = lightSurfaces ? [0, 0, 0] : [255, 255, 255];
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mix(fg, target, step / 20);
    if (worst(candidate) >= ratio) return candidate;
  }
  return target;
}

const slot = (colors: Record<string, string>, n: number, fallback: Rgb): Rgb => parseHex(colors[`color_${String(n).padStart(2, "0")}`] ?? "") ?? fallback;

/** The few colours every source theme has to supply; everything else is derived from them. */
interface ThemeColors {
  bg: Rgb; panel: Rgb; border: Rgb; text: Rgb; strong: Rgb; muted: Rgb; faint: Rgb;
  title: Rgb; accent: Rgb; accentStrong: Rgb; success: Rgb; warning: Rgb; danger: Rgb; info: Rgb;
}

/** Console token overrides. Text tokens are held to AA on the surfaces they sit on. */
function deriveTokens(c: ThemeColors): ThemeTokens {
  const { bg, panel } = c;
  const surfaces = [bg, panel];
  const text = ensureContrast(c.text, surfaces, 7);
  const muted = ensureContrast(c.muted, surfaces, 4.5);
  const accent = ensureContrast(c.accent, surfaces, 3);
  const readable = (color: Rgb) => toHex(ensureContrast(color, surfaces, 4.5));
  return {
    "--bg": toHex(bg),
    "--panel": toHex(panel),
    "--panel-soft": toHex(mix(bg, panel, 0.6)),
    "--panel-muted": toHex(mix(bg, panel, 0.25)),
    "--border": toHex(c.border),
    "--border-strong": toHex(mix(c.border, text, 0.35)),
    "--text": toHex(text),
    "--text-strong": toHex(ensureContrast(c.strong, surfaces, 9)),
    "--muted": toHex(muted),
    "--muted-warm": toHex(ensureContrast(mix(muted, text, 0.4), surfaces, 4.5)),
    "--text-subtle": toHex(ensureContrast(mix(text, panel, 0.25), surfaces, 4.5)),
    "--text-faint": readable(c.faint),
    "--title": readable(c.title),
    "--accent": toHex(accent),
    "--accent-strong": toHex(ensureContrast(c.accentStrong, surfaces, 3)),
    "--success": toHex(mix(c.success, bg, 0.45)),
    "--success-text": readable(c.success),
    "--danger": toHex(mix(c.danger, bg, 0.4)),
    "--danger-strong": toHex(mix(c.danger, bg, 0.55)),
    "--danger-text": readable(c.danger),
    "--danger-signal": readable(c.danger),
    "--state-motion": readable(c.info),
    "--warning": toHex(ensureContrast(c.warning, surfaces, 3)),
    "--bg-glow": `rgba(${accent.map(Math.round).join(", ")}, .18)`,
  };
}

/** Tokens for a Fedaykin editor palette (color_NN slots). */
export function buildThemeTokens(colors: Record<string, string>): ThemeTokens {
  const bg = slot(colors, 1, [13, 15, 18]);
  const panel = slot(colors, 2, bg);
  const text = slot(colors, 9, [243, 239, 231]);
  const muted = slot(colors, 10, text);
  const accent = slot(colors, 25, [198, 139, 74]);
  return deriveTokens({
    bg, panel, text, muted, accent,
    border: slot(colors, 7, mix(bg, text, 0.15)),
    strong: slot(colors, 29, text),
    faint: slot(colors, 11, muted),
    title: slot(colors, 15, accent),
    accentStrong: slot(colors, 26, accent),
    success: slot(colors, 23, [155, 230, 189]),
    warning: slot(colors, 21, [169, 121, 50]),
    danger: slot(colors, 20, [224, 90, 79]),
    info: slot(colors, 22, accent),
  });
}

/** Tokens for a Tabr look (--c-* variables of one theme variant). */
export function buildTabrTokens(vars: Record<string, string>): ThemeTokens {
  const get = (name: string, fallback: Rgb) => parseHex(vars[name] ?? "") ?? fallback;
  const text = get("text", [243, 239, 231]);
  const spice = get("spice", [198, 139, 74]);
  return deriveTokens({
    bg: get("ground", [13, 15, 18]),
    panel: get("panel", [23, 26, 29]),
    border: get("hair", mix(get("ground", [13, 15, 18]), text, 0.15)),
    text,
    strong: text,
    muted: get("dim", text),
    faint: get("dim", text),
    title: get("gold", spice),
    accent: spice,
    accentStrong: get("blue", get("focus", spice)),
    success: get("ok", [155, 230, 189]),
    warning: get("warn", [169, 121, 50]),
    danger: get("bad", [224, 90, 79]),
    info: get("sky", spice),
  });
}

function loadThemes(): ThemeInfo[] {
  const themes: ThemeInfo[] = [];
  for (const [path, source] of Object.entries(paletteSources)) {
    try {
      const palette = parseJsonc(source) as { name?: string; description?: string; appearance?: string; colors?: Record<string, string> };
      if (!palette.colors) continue;
      themes.push({
        id: path.replace(/^.*\/dune-/, "").replace(/\.jsonc$/, ""),
        name: (palette.name ?? path).replace(/^Dune\s+/, ""),
        description: palette.description ?? "",
        appearance: palette.appearance === "light" ? "light" : "dark",
        tokens: buildThemeTokens(palette.colors),
      });
    } catch { /* a malformed vendored palette is skipped, never fatal to the console */ }
  }
  const tabrNames: Record<string, string> = { fremen: "Fremen", awakening: "Awakening", sietch: "Sietch" };
  for (const [look, variants] of Object.entries(tabrLooks as Record<string, Record<"dark" | "light", Record<string, string>>>)) {
    for (const appearance of ["dark", "light"] as const) {
      themes.push({
        id: `tabr-${look}${appearance === "light" ? "-dayside" : ""}`,
        name: `Tabr ${tabrNames[look] ?? look}${appearance === "light" ? " Dayside" : ""}`,
        description: `The ${tabrNames[look] ?? look} look from the Tabr save editor${appearance === "light" ? ", light variant" : ""}.`,
        appearance,
        tokens: buildTabrTokens(variants[appearance]),
      });
    }
  }
  return themes.filter((t) => t.appearance === OFFERED_APPEARANCE).sort((a, b) => a.name.localeCompare(b.name));
}

let catalogue: ThemeInfo[] | null = null;
/** Built on first use, so an operator who never leaves the default pays nothing at startup. */
export function getThemes(): ThemeInfo[] {
  catalogue ??= loadThemes();
  return catalogue;
}

export function loadSelectedTheme(): string {
  try {
    const id = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (!id) return DEFAULT_THEME_ID;
    return getThemes().some((t) => t.id === id) ? id : DEFAULT_THEME_ID;
  } catch { return DEFAULT_THEME_ID; }
}

export function applyTheme(id: string, root: HTMLElement = document.documentElement): void {
  if (id === DEFAULT_THEME_ID && !root.dataset.theme) return;
  const themes = getThemes();
  Object.keys(themes[0]?.tokens ?? {}).forEach((name) => root.style.removeProperty(name));
  const theme = themes.find((t) => t.id === id);
  if (!theme) {
    root.style.removeProperty("color-scheme");
    delete root.dataset.theme;
    return;
  }
  Object.entries(theme.tokens).forEach(([name, value]) => root.style.setProperty(name, value));
  root.style.setProperty("color-scheme", theme.appearance);
  root.dataset.theme = theme.id;
}

export function saveSelectedTheme(id: string): void {
  try {
    if (id === DEFAULT_THEME_ID) window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch { /* storage unavailable: the choice lasts for this page view only */ }
  applyTheme(id);
}

let storageListening = false;

export function initTheme(): void {
  applyTheme(loadSelectedTheme());
  if (storageListening) return;
  storageListening = true;
  // Another console tab picked a theme: follow it.
  window.addEventListener("storage", (event) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) applyTheme(loadSelectedTheme());
  });
}
