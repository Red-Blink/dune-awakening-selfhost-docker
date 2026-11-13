// Console themes: maps the project's original palettes onto the existing
// CSS custom properties at runtime. The default
// theme sets nothing, so an operator who never opens the picker sees exactly
// the stylesheet's own :root values.
import { CONSOLE_PALETTES, type ConsolePalette } from "./consolePalettes";
import { HOUSE_SWATCHES, type HouseSwatch } from "./houseSwatches";
import { DEFAULT_THEME_ID, THEME_CACHE_KEY, THEME_STORAGE_KEY, THEME_TOKEN_NAMES, type ThemeCache } from "./themeBoot";

// The boot module (the only theme code in the entry chunk) owns the storage keys.
export { DEFAULT_THEME_ID, THEME_STORAGE_KEY };

export type Rgb = [number, number, number];
export type ThemeTokens = Record<string, string>;
export interface ThemeInfo {
  id: string;
  name: string;
  description: string;
  appearance: "dark" | "light";
  tokens: ThemeTokens;
  /** Picker section heading; not persisted. */
  group?: string;
  /** The source dye colours, shown in the picker for swatch palettes; not persisted. */
  dyes?: readonly string[];
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

/** Four project-authored colours define a palette; the shared roles stay consistent. */
export function buildThemeTokens(colors: Partial<Pick<ConsolePalette, "background" | "panel" | "accent" | "secondary">>): ThemeTokens {
  const bg: Rgb = parseHex(colors.background ?? "") ?? [13, 15, 18];
  const panel: Rgb = parseHex(colors.panel ?? "") ?? [23, 26, 29];
  const text: Rgb = [245, 241, 233];
  const accent: Rgb = parseHex(colors.accent ?? "") ?? [198, 139, 74];
  const secondary: Rgb = parseHex(colors.secondary ?? "") ?? [149, 189, 207];
  return deriveTokens({
    bg, panel, text, accent,
    strong: [255, 252, 246],
    muted: mix(text, panel, 0.35),
    faint: mix(text, panel, 0.45),
    border: mix(panel, text, 0.16),
    title: mix(accent, text, 0.2),
    accentStrong: secondary,
    success: [137, 214, 169],
    warning: [230, 187, 95],
    danger: [247, 120, 112],
    info: secondary,
  });
}

/** A console palette from a House's four dye colours: darkest dye, darkened, is the page; the next lift is the panel; the most vivid light dyes are the accents. */
export function paletteFromSwatch(swatch: HouseSwatch): Pick<ConsolePalette, "background" | "panel" | "accent" | "secondary"> {
  const dyes = swatch.colors.map((hex) => parseHex(hex) ?? [43, 43, 43] as Rgb);
  const byLight = [...dyes].sort((a, b) => luminance(a) - luminance(b));
  const black: Rgb = [0, 0, 0];
  let bg = byLight[0];
  for (let t = 0.3; luminance(bg) > 0.012 && t <= 0.9; t += 0.1) bg = mix(byLight[0], black, t);
  let panel = mix(bg, byLight[1], 0.5);
  for (let t = 0.3; luminance(panel) < 0.025 && t <= 0.9; t += 0.1) panel = mix(bg, byLight[1], t);
  panel = mix(panel, [255, 255, 255], luminance(panel) < 0.02 ? 0.06 : 0);
  const chroma = (c: Rgb) => Math.max(...c) - Math.min(...c);
  const bright = dyes.filter((c) => luminance(c) >= 0.08);
  const pool = (bright.length >= 2 ? bright : byLight.slice(-2)).sort((a, b) => chroma(b) - chroma(a) || luminance(b) - luminance(a));
  const accent = pool[0];
  const secondary = pool.find((c) => contrast(c, accent) >= 1.3 || toHex(c) !== toHex(accent)) ?? accent;
  return { background: toHex(bg), panel: toHex(panel), accent: toHex(accent), secondary: toHex(secondary) };
}

function loadThemes(): ThemeInfo[] {
  const palettes: ThemeInfo[] = CONSOLE_PALETTES.map((palette): ThemeInfo => ({
    id: palette.id,
    name: palette.name,
    description: palette.description,
    appearance: "dark",
    tokens: buildThemeTokens(palette),
    group: palette.id.startsWith("dd-") ? "Console palettes" : "Dune factions",
  }));
  const houses: ThemeInfo[] = HOUSE_SWATCHES.map((swatch): ThemeInfo => ({
    id: swatch.id,
    name: swatch.name,
    description: `The armour dye colours of ${swatch.name}.`,
    appearance: "dark",
    tokens: buildThemeTokens(paletteFromSwatch(swatch)),
    group: swatch.id.startsWith("house-") ? "Houses" : "Outfits and dyes",
    dyes: swatch.colors,
  }));
  return [...palettes, ...houses].sort((a, b) => a.name.localeCompare(b.name));
}

let catalogue: ThemeInfo[] | null = null;
/** Built on first use. This module is only reachable from the lazy picker chunk and from themeBoot's dynamic import, so the default look never downloads the palettes. */
export function getThemes(): ThemeInfo[] {
  catalogue ??= loadThemes();
  return catalogue;
}

export function loadSelectedTheme(): string {
  try {
    const id = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (!id) return DEFAULT_THEME_ID;
    return getThemes().some((t) => t.id === id) ? id : DEFAULT_THEME_ID;
  } catch {
    // A blocked storage API still allows a choice for this page view. Reopening
    // the picker must reflect that applied choice instead of claiming Default.
    const applied = document.documentElement.dataset.theme;
    return getThemes().some((t) => t.id === applied) ? applied! : DEFAULT_THEME_ID;
  }
}

function writeThemeCache(theme: ThemeInfo | null): void {
  try {
    if (!theme) window.localStorage.removeItem(THEME_CACHE_KEY);
    else window.localStorage.setItem(THEME_CACHE_KEY, JSON.stringify({ id: theme.id, appearance: theme.appearance, tokens: theme.tokens } satisfies ThemeCache));
  } catch { /* the cache only avoids a flash at boot; the choice itself still applies */ }
}

export function applyTheme(id: string, root: HTMLElement = document.documentElement): void {
  if (id === DEFAULT_THEME_ID && !root.dataset.theme) return;
  const themes = getThemes();
  THEME_TOKEN_NAMES.forEach((name) => root.style.removeProperty(name));
  const theme = themes.find((t) => t.id === id);
  if (!theme) {
    root.style.removeProperty("color-scheme");
    delete root.dataset.theme;
    writeThemeCache(null);
    return;
  }
  writeThemeCache(theme);
  Object.entries(theme.tokens).forEach(([name, value]) => root.style.setProperty(name, value));
  root.style.setProperty("color-scheme", theme.appearance);
  root.dataset.theme = theme.id;
}

export function saveSelectedTheme(id: string): void {
  // The cache is written first, so another tab reacting to the id change finds both.
  writeThemeCache(getThemes().find((t) => t.id === id) ?? null);
  try {
    if (id === DEFAULT_THEME_ID) window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch { /* storage unavailable: the choice lasts for this page view only */ }
  applyTheme(id);
}
