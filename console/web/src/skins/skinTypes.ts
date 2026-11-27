import type { Tab } from "../App";

export type ShellPosition = "sidebar-left" | "sidebar-right" | "top-nav" | "compact-rail";
export type ContentWidthMode = "fluid" | "boxed-1600" | "boxed-1360";
export type DensityMode = "compact" | "default" | "spacious";
export type FontPreset = "inter" | "rajdhani" | "jetbrains-mono" | "cinzel" | "system";
export type ShadowStyle = "default" | "flat" | "deep" | "neon-glow";
export type WidgetSpan = 3 | 4 | 6 | 8 | 12;

export interface CustomColorPalette {
  enabled: boolean;
  name: string;
  appearance: "dark" | "light";
  background: string;
  panel: string;
  accent: string;
  secondary: string;
  tokenOverrides: Record<string, string>;
}

export interface SkinDesignTokens {
  radiusSm: number;
  radiusMd: number;
  radiusLg: number;
  borderWidth: number;
  panelBlur: number;
  panelOpacity: number;
  fontPreset: FontPreset;
  fontScale: number;
  headingTracking: number;
  headingUppercase: boolean;
  shadowStyle: ShadowStyle;
  sandAnimation: boolean;
  customBgImageUrl: string;
  customBrandTitle: string;
  customBrandSubtitle: string;
}

export interface ShellLayoutConfig {
  position: ShellPosition;
  density: DensityMode;
  contentWidth: ContentWidthMode;
  stickyTopbar: boolean;
  showTopbarSubtitle: boolean;
  showCommunityButtons: boolean;
  showFooter: boolean;
  sidebarWidth: number;
}

export interface NavGroupItemConfig {
  /** Built-in tab name or custom page id (e.g. `custom:my-dashboard`) */
  tab: Tab | string;
  customPageId?: string;
  customLabel?: string;
  hidden?: boolean;
}

export interface NavGroupConfig {
  id: string;
  title: string;
  hidden?: boolean;
  showCommunityLinks?: boolean;
  items: NavGroupItemConfig[];
}

export interface WidgetGroupConfig {
  id: string;
  title: string;
  collapsed?: boolean;
}

export interface WidgetInstanceConfig {
  id: string;
  title: string;
  span: WidgetSpan;
  hidden: boolean;
  collapsed?: boolean;
  minHeight?: number;
  customTitle?: string;
  /** Optional group container ID when two or more widgets are merged into a named group */
  groupId?: string;
  /** Source page name when a widget from another area is added to a custom dashboard */
  sourcePage?: string;
}

export interface PageWidgetLayoutConfig {
  page: string;
  columns: 12;
  gap: number;
  widgets: WidgetInstanceConfig[];
  groups?: Record<string, WidgetGroupConfig>;
}

export interface CustomDashboardPageConfig {
  id: string;
  title: string;
  subtitle: string;
  iconName?: string;
  groupId: string;
}

export interface DuneSkinProfile {
  version: 1;
  id: string;
  name: string;
  author: string;
  description: string;
  baseThemeId: string;
  customColors: CustomColorPalette;
  design: SkinDesignTokens;
  shell: ShellLayoutConfig;
  navigation: NavGroupConfig[];
  pages: Record<string, PageWidgetLayoutConfig>;
  customPages?: CustomDashboardPageConfig[];
}
