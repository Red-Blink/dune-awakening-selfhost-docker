import {
  DEFAULT_THEME_ID,
  ROLE_TOKEN_NAME,
  THEME_CACHE_KEY,
  THEME_STORAGE_KEY,
  THEME_TOKEN_NAMES,
  readThemeCache,
  type ThemeCache,
} from "../themes/themeBoot";
import {
  BUILTIN_SKIN_PRESETS,
  createDefaultSkinProfile,
  DEFAULT_DESIGN_TOKENS,
  DEFAULT_FONT_STACKS,
  DEFAULT_NAVIGATION_GROUPS,
  DEFAULT_PAGE_WIDGET_LAYOUTS,
  DEFAULT_SHELL_LAYOUT,
  GLOBAL_WIDGET_CATALOG,
} from "./skinDefaults";
import type {
  CustomDashboardPageConfig,
  DuneSkinProfile,
  NavGroupConfig,
  PageWidgetLayoutConfig,
  WidgetGroupConfig,
  WidgetInstanceConfig,
  WidgetSpan,
} from "./skinTypes";

export const ACTIVE_SKIN_STORAGE_KEY = "dune-console-active-skin";
export const CUSTOM_SKINS_STORAGE_KEY = "dune-console-custom-skins";
export const SKIN_CHANGED_EVENT = "dune-console:skin-changed";
export const SKIN_LAYOUT_EDIT_MODE_EVENT = "dune-console:skin-edit-mode";

const SKIN_DESIGN_CSS_VARS = [
  "--skin-radius-sm",
  "--skin-radius-md",
  "--skin-radius-lg",
  "--skin-border-width",
  "--skin-panel-blur",
  "--skin-panel-opacity",
  "--skin-font-family",
  "--skin-font-scale",
  "--skin-heading-tracking",
  "--skin-heading-transform",
  "--skin-sidebar-width",
  "--skin-bg-image",
] as const;

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const CSS_CUSTOM_PROP_PATTERN = /^--[a-z0-9-]+$/i;
const UNSAFE_CSS_VALUE_PATTERN = /[;{}<>\\]|url\s*\(/i;

function sanitizeHexColor(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value.trim()) ? value.trim().toLowerCase() : fallback;
}

function sanitizeTokenOverrides(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!CSS_CUSTOM_PROP_PATTERN.test(key)) continue;
    if (typeof val !== "string") continue;
    const trimmed = val.trim();
    if (!trimmed || trimmed.length > 64 || UNSAFE_CSS_VALUE_PATTERN.test(trimmed)) continue;
    out[key] = trimmed;
  }
  return out;
}

let layoutEditMode = false;

export function isLayoutEditMode(): boolean {
  return layoutEditMode;
}

export function setLayoutEditMode(enabled: boolean): void {
  layoutEditMode = enabled;
  if (typeof document !== "undefined") {
    if (enabled) document.documentElement.dataset.skinEditMode = "true";
    else delete document.documentElement.dataset.skinEditMode;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SKIN_LAYOUT_EDIT_MODE_EVENT, { detail: { enabled } }));
  }
}

export function sanitizeSkinProfile(raw: unknown): DuneSkinProfile {
  const fallback = createDefaultSkinProfile();
  if (!raw || typeof raw !== "object") return fallback;
  const obj = raw as Partial<DuneSkinProfile>;

  const design = {
    ...DEFAULT_DESIGN_TOKENS,
    ...(obj.design && typeof obj.design === "object" ? obj.design : {}),
  };
  design.radiusSm = clampNumber(design.radiusSm, 0, 32, DEFAULT_DESIGN_TOKENS.radiusSm);
  design.radiusMd = clampNumber(design.radiusMd, 0, 36, DEFAULT_DESIGN_TOKENS.radiusMd);
  design.radiusLg = clampNumber(design.radiusLg, 0, 48, DEFAULT_DESIGN_TOKENS.radiusLg);
  design.borderWidth = clampNumber(design.borderWidth, 0, 4, DEFAULT_DESIGN_TOKENS.borderWidth);
  design.panelBlur = clampNumber(design.panelBlur, 0, 40, DEFAULT_DESIGN_TOKENS.panelBlur);
  design.panelOpacity = clampNumber(design.panelOpacity, 0.35, 1, DEFAULT_DESIGN_TOKENS.panelOpacity);
  design.fontScale = clampNumber(design.fontScale, 0.85, 1.25, DEFAULT_DESIGN_TOKENS.fontScale);
  design.headingTracking = clampNumber(design.headingTracking, -0.05, 0.25, DEFAULT_DESIGN_TOKENS.headingTracking);
  if (!(design.fontPreset in DEFAULT_FONT_STACKS)) design.fontPreset = "inter";

  const shell = {
    ...DEFAULT_SHELL_LAYOUT,
    ...(obj.shell && typeof obj.shell === "object" ? obj.shell : {}),
  };
  if (!["sidebar-left", "sidebar-right", "top-nav", "compact-rail"].includes(shell.position)) {
    shell.position = "sidebar-left";
  }
  if (!["compact", "default", "spacious"].includes(shell.density)) {
    shell.density = "default";
  }
  if (!["fluid", "boxed-1600", "boxed-1360"].includes(shell.contentWidth)) {
    shell.contentWidth = "fluid";
  }
  shell.sidebarWidth = clampNumber(shell.sidebarWidth, 180, 380, DEFAULT_SHELL_LAYOUT.sidebarWidth);

  const rawColors: Partial<DuneSkinProfile["customColors"]> =
    obj.customColors && typeof obj.customColors === "object" ? obj.customColors : {};
  const customColors = {
    enabled: Boolean(rawColors.enabled),
    name:
      typeof rawColors.name === "string" && rawColors.name.trim()
        ? rawColors.name.trim()
        : fallback.customColors.name,
    appearance: (rawColors.appearance === "light" ? "light" : "dark") as "dark" | "light",
    background: sanitizeHexColor(rawColors.background, fallback.customColors.background),
    panel: sanitizeHexColor(rawColors.panel, fallback.customColors.panel),
    accent: sanitizeHexColor(rawColors.accent, fallback.customColors.accent),
    secondary: sanitizeHexColor(rawColors.secondary, fallback.customColors.secondary),
    tokenOverrides: sanitizeTokenOverrides(rawColors.tokenOverrides),
  };

  const customPages = sanitizeCustomPages(obj.customPages);
  // Reconcile navigation so all valid tabs and custom pages are present
  const navigation = reconcileNavigation(obj.navigation, customPages);
  const pages = reconcilePages(obj.pages, customPages);

  return {
    version: 1,
    id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : fallback.id,
    name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : fallback.name,
    author: typeof obj.author === "string" && obj.author.trim() ? obj.author.trim() : fallback.author,
    description: typeof obj.description === "string" ? obj.description : fallback.description,
    baseThemeId: typeof obj.baseThemeId === "string" && obj.baseThemeId.trim() ? obj.baseThemeId.trim() : DEFAULT_THEME_ID,
    customColors,
    design,
    shell,
    navigation,
    pages,
    customPages,
  };
}

function sanitizeCustomPages(raw: unknown): CustomDashboardPageConfig[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CustomDashboardPageConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const cp = item as Partial<CustomDashboardPageConfig>;
    let id = typeof cp.id === "string" ? cp.id.trim() : "";
    if (!id) continue;
    if (!id.startsWith("custom:")) id = `custom:${id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title: typeof cp.title === "string" && cp.title.trim() ? cp.title.trim() : String("Custom Dashboard"),
      subtitle:
        typeof cp.subtitle === "string" && cp.subtitle.trim()
          ? cp.subtitle.trim()
          : String("Custom multi-module operator dashboard."),
      groupId: typeof cp.groupId === "string" && cp.groupId.trim() ? cp.groupId.trim() : "server-operations",
      ...(cp.iconName ? { iconName: String(cp.iconName) } : {}),
    });
  }
  return out;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function reconcileNavigation(rawNav: unknown, customPages: CustomDashboardPageConfig[]): NavGroupConfig[] {
  const baseGroups =
    !Array.isArray(rawNav) || rawNav.length === 0 ? structuredClone(DEFAULT_NAVIGATION_GROUPS) : rawNav;
  const knownBuiltInTabs = new Set<string>(DEFAULT_NAVIGATION_GROUPS.flatMap((g) => g.items.map((item) => item.tab)));
  const customPageById = new Map(customPages.map((p) => [p.id, p]));
  const seenTabs = new Set<string>();
  const groups: NavGroupConfig[] = [];

  for (const rawGroup of baseGroups) {
    if (!rawGroup || typeof rawGroup !== "object") continue;
    const g = rawGroup as Partial<NavGroupConfig>;
    const items = Array.isArray(g.items)
      ? g.items
          .filter(
            (item) =>
              item &&
              typeof item === "object" &&
              typeof item.tab === "string" &&
              (knownBuiltInTabs.has(item.tab) || customPageById.has(item.tab)) &&
              !seenTabs.has(item.tab)
          )
          .map((item) => {
            seenTabs.add(item.tab);
            const cp = customPageById.get(item.tab);
            return {
              tab: item.tab,
              ...(cp ? { customPageId: cp.id } : {}),
              ...(item.customLabel ? { customLabel: String(item.customLabel) } : cp ? { customLabel: cp.title } : {}),
              ...(item.hidden ? { hidden: Boolean(item.hidden) } : {}),
            };
          })
      : [];
    groups.push({
      id: typeof g.id === "string" && g.id.trim() ? g.id.trim() : `group-${groups.length + 1}`,
      title: typeof g.title === "string" && g.title.trim() ? g.title.trim() : String("Navigation"),
      hidden: Boolean(g.hidden),
      showCommunityLinks: Boolean(g.showCommunityLinks),
      items,
    });
  }

  // Any built-in tab from DEFAULT_NAVIGATION_GROUPS that was missing gets appended to the first group
  const missingTabs = [...knownBuiltInTabs].filter((t) => !seenTabs.has(t));
  if (missingTabs.length > 0) {
    if (groups.length === 0) return structuredClone(DEFAULT_NAVIGATION_GROUPS);
    groups[0].items.push(...missingTabs.map((tab) => ({ tab })));
  }

  // Ensure every custom dashboard page is linked in its target navigation group
  for (const cp of customPages) {
    if (seenTabs.has(cp.id)) continue;
    const targetGroup = groups.find((g) => g.id === cp.groupId) || groups[0];
    if (targetGroup) {
      targetGroup.items.push({
        tab: cp.id,
        customPageId: cp.id,
        customLabel: cp.title,
      });
    }
  }
  return groups;
}

function sanitizeGroupsMap(rawGroups: unknown): Record<string, WidgetGroupConfig> {
  if (!rawGroups || typeof rawGroups !== "object") return {};
  const out: Record<string, WidgetGroupConfig> = {};
  for (const [id, val] of Object.entries(rawGroups as Record<string, Partial<WidgetGroupConfig>>)) {
    if (!val || typeof val !== "object") continue;
    out[id] = {
      id,
      title: typeof val.title === "string" && val.title.trim() ? val.title.trim() : String("Widget Group"),
      ...(val.collapsed ? { collapsed: Boolean(val.collapsed) } : {}),
    };
  }
  return out;
}

function reconcilePages(
  rawPages: unknown,
  customPages: CustomDashboardPageConfig[]
): Record<string, PageWidgetLayoutConfig> {
  const defaults = structuredClone(DEFAULT_PAGE_WIDGET_LAYOUTS);
  const catalogById = new Map(GLOBAL_WIDGET_CATALOG.map((w) => [w.id, w]));
  const source = rawPages && typeof rawPages === "object" ? (rawPages as Record<string, Partial<PageWidgetLayoutConfig>>) : {};

  // 1. Reconcile built-in pages (allowing both their native widgets AND any extra widgets added from other areas!)
  for (const [pageName, defaultPage] of Object.entries(defaults)) {
    const customPage = source[pageName];
    if (!customPage || !Array.isArray(customPage.widgets)) continue;
    const defaultById = new Map(defaultPage.widgets.map((w) => [w.id, w]));
    const seen = new Set<string>();
    const merged: WidgetInstanceConfig[] = [];
    const groups = sanitizeGroupsMap(customPage.groups);

    for (const rawW of customPage.widgets) {
      if (!rawW || typeof rawW !== "object" || typeof rawW.id !== "string") continue;
      if (seen.has(rawW.id)) continue;
      const base = defaultById.get(rawW.id) || catalogById.get(rawW.id);
      if (!base) continue;
      seen.add(rawW.id);
      const fallbackSpan = "span" in base ? base.span : base.defaultSpan;
      const validSpan = ([3, 4, 6, 8, 12].includes(Number(rawW.span)) ? Number(rawW.span) : fallbackSpan) as WidgetSpan;
      merged.push({
        id: base.id,
        title: base.title,
        span: validSpan,
        hidden: Boolean(rawW.hidden),
        collapsed: Boolean(rawW.collapsed),
        ...(rawW.customTitle ? { customTitle: String(rawW.customTitle) } : {}),
        ...(rawW.groupId && groups[rawW.groupId] ? { groupId: String(rawW.groupId) } : {}),
        ...(rawW.sourcePage ? { sourcePage: String(rawW.sourcePage) } : "sourcePage" in base && base.sourcePage ? { sourcePage: base.sourcePage } : {}),
      });
    }
    for (const base of defaultPage.widgets) {
      if (!seen.has(base.id)) merged.push(base);
    }
    defaults[pageName] = {
      page: pageName,
      columns: 12,
      gap: clampNumber(customPage.gap, 6, 36, defaultPage.gap),
      widgets: merged,
      groups,
    };
  }

  // 2. Reconcile custom dashboard pages
  for (const cp of customPages) {
    const customPage = source[cp.id];
    const groups = sanitizeGroupsMap(customPage?.groups);
    const seen = new Set<string>();
    const widgets: WidgetInstanceConfig[] = [];
    if (customPage && Array.isArray(customPage.widgets)) {
      for (const rawW of customPage.widgets) {
        if (!rawW || typeof rawW !== "object" || typeof rawW.id !== "string" || seen.has(rawW.id)) continue;
        const catalogEntry = catalogById.get(rawW.id);
        if (!catalogEntry) continue;
        seen.add(rawW.id);
        const validSpan = ([3, 4, 6, 8, 12].includes(Number(rawW.span))
          ? Number(rawW.span)
          : catalogEntry.defaultSpan) as WidgetSpan;
        widgets.push({
          id: catalogEntry.id,
          title: catalogEntry.title,
          span: validSpan,
          hidden: Boolean(rawW.hidden),
          collapsed: Boolean(rawW.collapsed),
          sourcePage: catalogEntry.sourcePage,
          ...(rawW.customTitle ? { customTitle: String(rawW.customTitle) } : {}),
          ...(rawW.groupId && groups[rawW.groupId] ? { groupId: String(rawW.groupId) } : {}),
        });
      }
    }
    defaults[cp.id] = {
      page: cp.id,
      columns: 12,
      gap: clampNumber(customPage?.gap, 6, 36, 16),
      widgets,
      groups,
    };
  }

  return defaults;
}

export function loadCustomSkins(): DuneSkinProfile[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_SKINS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => sanitizeSkinProfile(item)).filter((skin) => skin.id !== "default");
  } catch {
    return [];
  }
}

export function saveCustomSkins(skins: DuneSkinProfile[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CUSTOM_SKINS_STORAGE_KEY, JSON.stringify(skins));
  } catch {
    // ignore storage errors
  }
}

export function loadActiveSkin(): DuneSkinProfile {
  if (typeof window === "undefined") return createDefaultSkinProfile();
  try {
    const raw = window.localStorage.getItem(ACTIVE_SKIN_STORAGE_KEY);
    if (!raw) return createDefaultSkinProfile();
    return sanitizeSkinProfile(JSON.parse(raw));
  } catch {
    return createDefaultSkinProfile();
  }
}

export function isDefaultSkin(skin: DuneSkinProfile): boolean {
  return (
    skin.id === "default" &&
    !skin.customColors.enabled &&
    skin.baseThemeId === "default" &&
    (!skin.customPages || skin.customPages.length === 0) &&
    skin.shell.position === DEFAULT_SHELL_LAYOUT.position &&
    skin.shell.density === DEFAULT_SHELL_LAYOUT.density &&
    skin.shell.contentWidth === DEFAULT_SHELL_LAYOUT.contentWidth &&
    skin.shell.stickyTopbar === DEFAULT_SHELL_LAYOUT.stickyTopbar &&
    skin.shell.showFooter === DEFAULT_SHELL_LAYOUT.showFooter &&
    skin.shell.showCommunityButtons === DEFAULT_SHELL_LAYOUT.showCommunityButtons &&
    skin.shell.showTopbarSubtitle === DEFAULT_SHELL_LAYOUT.showTopbarSubtitle &&
    skin.shell.sidebarWidth === DEFAULT_SHELL_LAYOUT.sidebarWidth &&
    skin.design.fontPreset === DEFAULT_DESIGN_TOKENS.fontPreset &&
    skin.design.radiusSm === DEFAULT_DESIGN_TOKENS.radiusSm &&
    skin.design.radiusMd === DEFAULT_DESIGN_TOKENS.radiusMd &&
    skin.design.radiusLg === DEFAULT_DESIGN_TOKENS.radiusLg &&
    skin.design.borderWidth === DEFAULT_DESIGN_TOKENS.borderWidth &&
    skin.design.panelBlur === DEFAULT_DESIGN_TOKENS.panelBlur &&
    skin.design.panelOpacity === DEFAULT_DESIGN_TOKENS.panelOpacity &&
    skin.design.fontScale === DEFAULT_DESIGN_TOKENS.fontScale &&
    skin.design.headingTracking === DEFAULT_DESIGN_TOKENS.headingTracking &&
    skin.design.headingUppercase === DEFAULT_DESIGN_TOKENS.headingUppercase &&
    skin.design.shadowStyle === DEFAULT_DESIGN_TOKENS.shadowStyle &&
    skin.design.sandAnimation === DEFAULT_DESIGN_TOKENS.sandAnimation &&
    !skin.design.customBgImageUrl.trim() &&
    !skin.design.customBrandTitle.trim() &&
    !skin.design.customBrandSubtitle.trim()
  );
}

export function clearSkinDomOverrides(root: HTMLElement = document.documentElement): void {
  SKIN_DESIGN_CSS_VARS.forEach((name) => root.style.removeProperty(name));
  delete root.dataset.shellPosition;
  delete root.dataset.shellDensity;
  delete root.dataset.shellWidth;
  delete root.dataset.stickyTopbar;
  delete root.dataset.hideFooter;
  delete root.dataset.hideCommunity;
  delete root.dataset.hideSubtitle;
  delete root.dataset.shadowStyle;
  delete root.dataset.hideSand;
  delete root.dataset.skinId;
}

export function applySkinProfile(skin: DuneSkinProfile, root: HTMLElement = document.documentElement): void {
  // 1. Apply color palette (either custom 4-color generator + overrides or built-in theme)
  if (skin.customColors.enabled) {
    root.dataset.theme = `skin-${skin.id}`;
    root.style.setProperty("color-scheme", skin.customColors.appearance);
    root.style.setProperty("--bg", skin.customColors.background);
    root.style.setProperty("--panel", skin.customColors.panel);
    root.style.setProperty("--accent", skin.customColors.accent);
    root.style.setProperty("--accent-strong", skin.customColors.secondary);
    Object.entries(skin.customColors.tokenOverrides).forEach(([name, value]) => {
      root.style.setProperty(name, value);
    });
    const cached = readThemeCache(`skin-${skin.id}`);
    if (cached) {
      Object.entries(cached.tokens).forEach(([name, value]) => root.style.setProperty(name, value));
    }
    void import("../themes/themeEngine").then((engine) => {
      const base = engine.buildThemeTokens({
        background: skin.customColors.background,
        panel: skin.customColors.panel,
        accent: skin.customColors.accent,
        secondary: skin.customColors.secondary,
      });
      const roleTokens = engine.deriveRoleTokens(base);
      const fullTokens: Record<string, string> = {
        ...base,
        ...roleTokens,
        ...skin.customColors.tokenOverrides,
      };
      THEME_TOKEN_NAMES.forEach((name) => root.style.removeProperty(name));
      [...root.style].filter((name) => ROLE_TOKEN_NAME.test(name)).forEach((name) => root.style.removeProperty(name));
      Object.entries(fullTokens).forEach(([name, value]) => root.style.setProperty(name, value));
      root.style.setProperty("color-scheme", skin.customColors.appearance);
      root.dataset.theme = `skin-${skin.id}`;
      try {
        const cache: ThemeCache = {
          id: `skin-${skin.id}`,
          appearance: skin.customColors.appearance,
          tokens: fullTokens,
        };
        window.localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(cache));
      } catch {
        // ignore
      }
    }).catch(() => {});
  } else {
    const targetTheme = skin.baseThemeId || DEFAULT_THEME_ID;
    if (targetTheme === DEFAULT_THEME_ID) {
      THEME_TOKEN_NAMES.forEach((name) => root.style.removeProperty(name));
      [...root.style].filter((name) => ROLE_TOKEN_NAME.test(name)).forEach((name) => root.style.removeProperty(name));
      root.style.removeProperty("color-scheme");
      delete root.dataset.theme;
      try {
        window.localStorage.removeItem(THEME_CACHE_KEY);
      } catch {
        // ignore
      }
    } else {
      void import("../themes/themeEngine").then((engine) => engine.applyTheme(targetTheme, root)).catch(() => {});
    }
  }

  // If this is the pure default skin without any overrides, keep root clean so existing tests pass!
  if (isDefaultSkin(skin)) {
    clearSkinDomOverrides(root);
    return;
  }

  root.dataset.skinId = skin.id;
  root.dataset.shellPosition = skin.shell.position;
  root.dataset.shellDensity = skin.shell.density;
  root.dataset.shellWidth = skin.shell.contentWidth;
  root.dataset.shadowStyle = skin.design.shadowStyle;

  if (skin.shell.stickyTopbar) root.dataset.stickyTopbar = "true";
  else delete root.dataset.stickyTopbar;

  if (!skin.shell.showFooter) root.dataset.hideFooter = "true";
  else delete root.dataset.hideFooter;

  if (!skin.shell.showCommunityButtons) root.dataset.hideCommunity = "true";
  else delete root.dataset.hideCommunity;

  if (!skin.shell.showTopbarSubtitle) root.dataset.hideSubtitle = "true";
  else delete root.dataset.hideSubtitle;

  if (!skin.design.sandAnimation) root.dataset.hideSand = "true";
  else delete root.dataset.hideSand;

  root.style.setProperty("--skin-radius-sm", `${skin.design.radiusSm}px`);
  root.style.setProperty("--skin-radius-md", `${skin.design.radiusMd}px`);
  root.style.setProperty("--skin-radius-lg", `${skin.design.radiusLg}px`);
  root.style.setProperty("--skin-border-width", `${skin.design.borderWidth}px`);
  root.style.setProperty("--skin-panel-blur", `${skin.design.panelBlur}px`);
  root.style.setProperty("--skin-panel-opacity", String(skin.design.panelOpacity));
  root.style.setProperty("--skin-font-family", DEFAULT_FONT_STACKS[skin.design.fontPreset] || DEFAULT_FONT_STACKS.inter);
  root.style.setProperty("--skin-font-scale", String(skin.design.fontScale));
  root.style.setProperty("--skin-heading-tracking", `${skin.design.headingTracking}em`);
  root.style.setProperty("--skin-heading-transform", skin.design.headingUppercase ? "uppercase" : "none");
  root.style.setProperty("--skin-sidebar-width", `${skin.shell.sidebarWidth}px`);

  if (skin.design.customBgImageUrl.trim()) {
    const safeUrl = skin.design.customBgImageUrl.trim().replace(/["()\\]/g, "");
    root.style.setProperty("--skin-bg-image", `url("${safeUrl}")`);
  } else {
    root.style.removeProperty("--skin-bg-image");
  }
}

export function saveAndApplySkin(skin: DuneSkinProfile): void {
  const sanitized = sanitizeSkinProfile(skin);
  if (typeof window !== "undefined") {
    try {
      if (isDefaultSkin(sanitized)) {
        window.localStorage.removeItem(ACTIVE_SKIN_STORAGE_KEY);
      } else {
        window.localStorage.setItem(ACTIVE_SKIN_STORAGE_KEY, JSON.stringify(sanitized));
      }
      if (!sanitized.customColors.enabled) {
        const themeId = sanitized.baseThemeId || DEFAULT_THEME_ID;
        if (themeId === DEFAULT_THEME_ID) window.localStorage.removeItem(THEME_STORAGE_KEY);
        else window.localStorage.setItem(THEME_STORAGE_KEY, themeId);
      }
    } catch {
      // ignore storage errors
    }
  }
  applySkinProfile(sanitized);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SKIN_CHANGED_EVENT, { detail: { skin: sanitized } }));
  }
}

export function getAllAvailableSkins(): DuneSkinProfile[] {
  const custom = loadCustomSkins();
  const customIds = new Set(custom.map((s) => s.id));
  return [
    ...BUILTIN_SKIN_PRESETS.filter((preset) => !customIds.has(preset.id)),
    ...custom,
  ];
}

export function updatePageWidgetLayout(
  page: string,
  updater: (current: PageWidgetLayoutConfig) => PageWidgetLayoutConfig
): DuneSkinProfile {
  const active = loadActiveSkin();
  const currentPage = active.pages[page] || DEFAULT_PAGE_WIDGET_LAYOUTS[page] || {
    page,
    columns: 12,
    gap: 16,
    widgets: [],
  };
  const updatedPage = updater(structuredClone(currentPage));
  const nextSkin: DuneSkinProfile = {
    ...active,
    id: active.id === "default" ? "custom-active" : active.id,
    name: active.id === "default" ? "Custom Console Layout" : active.name,
    pages: {
      ...active.pages,
      [page]: updatedPage,
    },
  };
  saveAndApplySkin(nextSkin);
  return nextSkin;
}

export function exportSkinToJson(skin: DuneSkinProfile): string {
  return JSON.stringify(sanitizeSkinProfile(skin), null, 2);
}

export function importSkinFromJson(jsonText: string): DuneSkinProfile {
  const parsed = JSON.parse(jsonText);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid skin JSON file.");
  }
  const skin = sanitizeSkinProfile(parsed);
  if (skin.id === "default") {
    skin.id = `imported-${Date.now()}`;
  }
  return skin;
}
