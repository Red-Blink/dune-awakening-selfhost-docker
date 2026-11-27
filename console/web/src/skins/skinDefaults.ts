import type {
  DuneSkinProfile,
  FontPreset,
  NavGroupConfig,
  PageWidgetLayoutConfig,
  ShellLayoutConfig,
  SkinDesignTokens,
} from "./skinTypes";

export const DEFAULT_FONT_STACKS: Record<FontPreset, string> = {
  inter: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  rajdhani: '"Rajdhani", "Chakra Petch", "Bahnschrift", "DIN Alternate", ui-sans-serif, system-ui, sans-serif',
  "jetbrains-mono": '"JetBrains Mono", "SFMono-Regular", Menlo, Monaco, Consolas, monospace',
  cinzel: '"Cinzel", "Trajan Pro", "Palatino Linotype", Georgia, serif',
  system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
};

export const DEFAULT_DESIGN_TOKENS: SkinDesignTokens = {
  radiusSm: 6,
  radiusMd: 8,
  radiusLg: 12,
  borderWidth: 1,
  panelBlur: 12,
  panelOpacity: 0.92,
  fontPreset: "inter",
  fontScale: 1,
  headingTracking: 0,
  headingUppercase: false,
  shadowStyle: "default",
  sandAnimation: true,
  customBgImageUrl: "",
  customBrandTitle: "",
  customBrandSubtitle: "",
};

export const DEFAULT_SHELL_LAYOUT: ShellLayoutConfig = {
  position: "sidebar-left",
  density: "default",
  contentWidth: "fluid",
  stickyTopbar: false,
  showTopbarSubtitle: true,
  showCommunityButtons: true,
  showFooter: true,
  sidebarWidth: 260,
};

export const DEFAULT_NAVIGATION_GROUPS: NavGroupConfig[] = [
  {
    id: "server-operations",
    title: String("Server Operations"),
    items: [
      { tab: "Home" },
      { tab: "Server Control" },
      { tab: "Backups" },
      { tab: "Database" },
      { tab: "Updates" },
      { tab: "Logs" },
      { tab: "Chat" },
      { tab: "Settings" },
      { tab: "Access Control" },
    ],
  },
  {
    id: "arrakis-management",
    title: String("Arrakis Management"),
    items: [
      { tab: "Maps" },
      { tab: "Players" },
      { tab: "Guilds" },
      { tab: "Bases" },
      { tab: "Vehicles" },
      { tab: "Storage" },
      { tab: "Exchange" },
      { tab: "Live Map" },
      { tab: "Landsraad" },
      { tab: "Admin Tools" },
      { tab: "Care Package" },
    ],
  },
  {
    id: "community",
    title: String("Community"),
    showCommunityLinks: true,
    items: [{ tab: "Addons" }],
  },
];

export const DEFAULT_PAGE_WIDGET_LAYOUTS: Record<string, PageWidgetLayoutConfig> = {
  Home: {
    page: "Home",
    columns: 12,
    gap: 16,
    widgets: [
      { id: "home.hero", title: String("Battlegroup Status & Actions"), span: 6, hidden: false },
      { id: "home.highlights", title: String("Feature Highlights"), span: 6, hidden: false },
      { id: "home.subsystems", title: String("Readiness & Health"), span: 6, hidden: false },
      { id: "home.performance", title: String("Host Performance"), span: 6, hidden: false },
    ],
  },
  "Server Control": {
    page: "Server Control",
    columns: 12,
    gap: 14,
    widgets: [
      { id: "server.config", title: String("Server Configurations"), span: 12, hidden: false },
      { id: "server.lifecycle", title: String("Battlegroup & Service Controls"), span: 12, hidden: false },
      { id: "server.history", title: String("Restart History"), span: 12, hidden: false },
      { id: "server.readiness", title: String("Readiness Timeline"), span: 6, hidden: false },
      { id: "server.ports", title: String("Port Checklist"), span: 6, hidden: false },
      { id: "server.token", title: String("Change Funcom Token"), span: 12, hidden: false },
      { id: "server.doctor", title: String("Doctor Diagnostics & Storage Cleanup"), span: 12, hidden: false },
    ],
  },
  Settings: {
    page: "Settings",
    columns: 12,
    gap: 16,
    widgets: [
      { id: "settings.runtime", title: String("Runtime Configuration & Files"), span: 12, hidden: false },
      { id: "settings.access", title: String("Console Access"), span: 12, hidden: false },
      { id: "settings.password", title: String("Account Security"), span: 12, hidden: false },
      { id: "settings.discord", title: String("Discord"), span: 12, hidden: false },
      { id: "settings.serverStartup", title: String("Server Startup"), span: 6, hidden: false },
      { id: "settings.webPort", title: String("Web Console Port"), span: 6, hidden: false },
      { id: "settings.apiKeys", title: String("API Keys"), span: 6, hidden: false },
      { id: "settings.encryptedApi", title: String("Encrypted API Access"), span: 6, hidden: false },
      { id: "settings.experimental", title: String("Experimental Features"), span: 6, hidden: false },
      { id: "settings.publicProfile", title: String("Public Listing Profile"), span: 6, hidden: false },
    ],
  },
  "Admin Tools": {
    page: "Admin Tools",
    columns: 12,
    gap: 16,
    widgets: [
      { id: "admin.liveTools", title: String("Global Live Tools (Broadcast, MOTD, Chat)"), span: 12, hidden: false },
      { id: "admin.schedule", title: String("Schedule Server Restart & Queue"), span: 12, hidden: false },
      { id: "admin.transfer", title: String("Character Transfer Settings"), span: 6, hidden: false },
      { id: "admin.history", title: String("Admin Command History"), span: 6, hidden: false },
    ],
  },
  Backups: {
    page: "Backups",
    columns: 12,
    gap: 16,
    widgets: [
      { id: "backups.main", title: String("Backup Archives & Restore"), span: 12, hidden: false },
      { id: "backups.import", title: String("Import External Backup"), span: 6, hidden: false },
      { id: "backups.schedule", title: String("Automatic Backup Schedule"), span: 6, hidden: false },
    ],
  },
  Database: {
    page: "Database",
    columns: 12,
    gap: 16,
    widgets: [
      { id: "database.controls", title: String("Database Status, Password & SSH Tunnel"), span: 12, hidden: false },
      { id: "database.tables", title: String("Tables & Row Preview"), span: 12, hidden: false },
      { id: "database.search", title: String("Global Column Search"), span: 6, hidden: false },
      { id: "database.sql", title: String("Database Objects & SQL Console"), span: 6, hidden: false },
    ],
  },
  Players: {
    page: "Players",
    columns: 12,
    gap: 16,
    widgets: [
      { id: "panel.players", title: String("Players Directory & Character Admin"), span: 12, hidden: false, sourcePage: "Players" },
    ],
  },
  Guilds: {
    page: "Guilds",
    columns: 12,
    gap: 16,
    widgets: [
      { id: "panel.guilds", title: String("Guilds Management"), span: 12, hidden: false, sourcePage: "Guilds" },
    ],
  },
  Bases: {
    page: "Bases",
    columns: 12,
    gap: 16,
    widgets: [
      { id: "panel.bases", title: String("Bases, Generators & Inventories"), span: 12, hidden: false, sourcePage: "Bases" },
    ],
  },
  Vehicles: {
    page: "Vehicles",
    columns: 12,
    gap: 16,
    widgets: [
      { id: "panel.vehicles", title: String("Vehicles & Storage"), span: 12, hidden: false, sourcePage: "Vehicles" },
    ],
  },
  Exchange: {
    page: "Exchange",
    columns: 12,
    gap: 16,
    widgets: [
      { id: "panel.exchange", title: String("CHOAM Exchange & Market Bot"), span: 12, hidden: false, sourcePage: "Exchange" },
    ],
  },
  Landsraad: {
    page: "Landsraad",
    columns: 12,
    gap: 16,
    widgets: [
      { id: "panel.landsraad", title: String("Landsraad Tasks & Milestones"), span: 12, hidden: false, sourcePage: "Landsraad" },
    ],
  },
  "Live Map": {
    page: "Live Map",
    columns: 12,
    gap: 16,
    widgets: [
      { id: "panel.liveMap", title: String("Interactive Live World Map"), span: 12, hidden: false, sourcePage: "Live Map" },
    ],
  },
  Maps: {
    page: "Maps",
    columns: 12,
    gap: 16,
    widgets: [
      { id: "panel.maps", title: String("Maps, Sietches & Deep Desert Partitions"), span: 12, hidden: false, sourcePage: "Maps" },
    ],
  },
  "Care Package": {
    page: "Care Package",
    columns: 12,
    gap: 16,
    widgets: [
      { id: "panel.carePackage", title: String("Care Package Delivery"), span: 12, hidden: false, sourcePage: "Care Package" },
    ],
  },
  Addons: {
    page: "Addons",
    columns: 12,
    gap: 16,
    widgets: [
      { id: "panel.addons", title: String("Community Addons"), span: 12, hidden: false, sourcePage: "Addons" },
    ],
  },
  Logs: {
    page: "Logs",
    columns: 12,
    gap: 16,
    widgets: [
      { id: "panel.logs", title: String("Live Service Logs"), span: 12, hidden: false, sourcePage: "Logs" },
    ],
  },
  Chat: {
    page: "Chat",
    columns: 12,
    gap: 16,
    widgets: [
      { id: "panel.chat", title: String("In-Game Chat Monitor"), span: 12, hidden: false, sourcePage: "Chat" },
    ],
  },
  Updates: {
    page: "Updates",
    columns: 12,
    gap: 16,
    widgets: [
      { id: "panel.updates", title: String("Stack & Game Server Updates"), span: 12, hidden: false, sourcePage: "Updates" },
    ],
  },
};

export interface GlobalWidgetCatalogEntry {
  id: string;
  title: string;
  sourcePage: string;
  defaultSpan: 4 | 6 | 8 | 12;
}

export const GLOBAL_WIDGET_CATALOG: GlobalWidgetCatalogEntry[] = Object.entries(DEFAULT_PAGE_WIDGET_LAYOUTS).flatMap(
  ([pageName, layout]) =>
    layout.widgets.map((w) => ({
      id: w.id,
      title: w.title,
      sourcePage: pageName,
      defaultSpan: (w.span === 3 ? 4 : w.span) as 4 | 6 | 8 | 12,
    }))
);

export function createDefaultSkinProfile(): DuneSkinProfile {
  return {
    version: 1,
    id: "default",
    name: "Standard Console",
    author: "RedBlink",
    description: String("The original Dune Docker Console appearance and two-column layout."),
    baseThemeId: "default",
    customColors: {
      enabled: false,
      name: "Custom Palette",
      appearance: "dark",
      background: "#0d0f12",
      panel: "#171a1d",
      accent: "#c68b4a",
      secondary: "#95bdcf",
      tokenOverrides: {},
    },
    design: { ...DEFAULT_DESIGN_TOKENS },
    shell: { ...DEFAULT_SHELL_LAYOUT },
    navigation: structuredClone(DEFAULT_NAVIGATION_GROUPS),
    pages: structuredClone(DEFAULT_PAGE_WIDGET_LAYOUTS),
  };
}

export const BUILTIN_SKIN_PRESETS: DuneSkinProfile[] = [
  createDefaultSkinProfile(),
  {
    version: 1,
    id: "arrakis-command-top",
    name: "Arrakis Command Deck (Top Nav)",
    author: "Dune Skin Studio",
    description: String("Wide horizontal top navigation bar, 3-column bento dashboard layout, sharp tactical corners and high-density metrics."),
    baseThemeId: "dd-amber-dunes",
    customColors: {
      enabled: true,
      name: "Arrakis Tactical Amber",
      appearance: "dark",
      background: "#0a0c0e",
      panel: "#13171c",
      accent: "#e59a3c",
      secondary: "#5ca8c8",
      tokenOverrides: {},
    },
    design: {
      ...DEFAULT_DESIGN_TOKENS,
      radiusSm: 2,
      radiusMd: 3,
      radiusLg: 4,
      borderWidth: 1,
      panelBlur: 16,
      panelOpacity: 0.94,
      fontPreset: "rajdhani",
      fontScale: 1,
      headingTracking: 0.05,
      headingUppercase: true,
      shadowStyle: "neon-glow",
      sandAnimation: true,
      customBrandTitle: "ARRAKIS COMMAND DECK",
      customBrandSubtitle: "Orbital Telemetry & Sietch Control Matrix",
    },
    shell: {
      ...DEFAULT_SHELL_LAYOUT,
      position: "top-nav",
      density: "compact",
      contentWidth: "fluid",
      stickyTopbar: true,
    },
    navigation: structuredClone(DEFAULT_NAVIGATION_GROUPS),
    pages: {
      ...structuredClone(DEFAULT_PAGE_WIDGET_LAYOUTS),
      Home: {
        page: "Home",
        columns: 12,
        gap: 14,
        widgets: [
          { id: "home.hero", title: String("Battlegroup Status & Actions"), span: 12, hidden: false },
          { id: "home.subsystems", title: String("Readiness & Health"), span: 4, hidden: false },
          { id: "home.performance", title: String("Host Performance"), span: 4, hidden: false },
          { id: "home.highlights", title: String("Feature Highlights"), span: 4, hidden: false },
        ],
      },
      "Server Control": {
        page: "Server Control",
        columns: 12,
        gap: 14,
        widgets: [
          { id: "server.lifecycle", title: String("Battlegroup & Service Controls"), span: 6, hidden: false },
          { id: "server.config", title: String("Server Configurations"), span: 6, hidden: false },
          { id: "server.readiness", title: String("Readiness Timeline"), span: 4, hidden: false },
          { id: "server.ports", title: String("Port Checklist"), span: 4, hidden: false },
          { id: "server.doctor", title: String("Doctor Diagnostics & Storage Cleanup"), span: 4, hidden: false },
          { id: "server.history", title: String("Restart History"), span: 8, hidden: false },
          { id: "server.token", title: String("Change Funcom Token"), span: 4, hidden: false },
        ],
      },
    },
  },
  {
    version: 1,
    id: "harkonnen-brutalist-right",
    name: "Harkonnen Industrial (Right Dock)",
    author: "Dune Skin Studio",
    description: String("Giedi Prime industrial monolith look: right-hand sidebar dock, zero border-radius, high-contrast crimson accents and monospace telemetry."),
    baseThemeId: "dune-harkonnen",
    customColors: {
      enabled: true,
      name: "Giedi Prime Obsidian",
      appearance: "dark",
      background: "#070709",
      panel: "#121216",
      accent: "#d9383a",
      secondary: "#8c96a6",
      tokenOverrides: {},
    },
    design: {
      ...DEFAULT_DESIGN_TOKENS,
      radiusSm: 0,
      radiusMd: 0,
      radiusLg: 0,
      borderWidth: 2,
      panelBlur: 0,
      panelOpacity: 0.98,
      fontPreset: "jetbrains-mono",
      fontScale: 0.96,
      headingTracking: 0.08,
      headingUppercase: true,
      shadowStyle: "flat",
      sandAnimation: false,
      customBrandTitle: "GIEDI PRIME // OVERSEER",
      customBrandSubtitle: "House Harkonnen Industrial Server Grid",
    },
    shell: {
      ...DEFAULT_SHELL_LAYOUT,
      position: "sidebar-right",
      density: "compact",
      contentWidth: "fluid",
      stickyTopbar: true,
      sidebarWidth: 270,
    },
    navigation: [
      {
        id: "arrakis-management",
        title: String("01 // Sector Control"),
        items: [
          { tab: "Players" },
          { tab: "Maps" },
          { tab: "Live Map" },
          { tab: "Bases" },
          { tab: "Vehicles" },
          { tab: "Guilds" },
          { tab: "Landsraad" },
          { tab: "Exchange" },
          { tab: "Admin Tools" },
          { tab: "Care Package" },
        ],
      },
      {
        id: "server-operations",
        title: String("02 // Core Infrastructure"),
        items: [
          { tab: "Home" },
          { tab: "Server Control" },
          { tab: "Logs" },
          { tab: "Database" },
          { tab: "Backups" },
          { tab: "Updates" },
          { tab: "Chat" },
          { tab: "Settings" },
        ],
      },
      {
        id: "community",
        title: String("03 // Extensions"),
        showCommunityLinks: false,
        items: [{ tab: "Addons" }],
      },
    ],
    pages: {
      ...structuredClone(DEFAULT_PAGE_WIDGET_LAYOUTS),
      Home: {
        page: "Home",
        columns: 12,
        gap: 12,
        widgets: [
          { id: "home.performance", title: String("Host Performance"), span: 6, hidden: false },
          { id: "home.subsystems", title: String("Readiness & Health"), span: 6, hidden: false },
          { id: "home.hero", title: String("Battlegroup Status & Actions"), span: 12, hidden: false },
          { id: "home.highlights", title: String("Feature Highlights"), span: 12, hidden: true },
        ],
      },
    },
  },
  {
    version: 1,
    id: "bene-gesserit-glass-rail",
    name: "Imperial Archive (Compact Icon Rail)",
    author: "Dune Skin Studio",
    description: String("Collapsible left icon rail, soft rounded glassmorphic panels, boxed 1600px reading container and serene gold/jade tones."),
    baseThemeId: "dune-sardaukar-imperial",
    customColors: {
      enabled: true,
      name: "Kaitain Imperial Glass",
      appearance: "dark",
      background: "#0b1114",
      panel: "#141f24",
      accent: "#d4af37",
      secondary: "#52b788",
      tokenOverrides: {},
    },
    design: {
      ...DEFAULT_DESIGN_TOKENS,
      radiusSm: 10,
      radiusMd: 14,
      radiusLg: 18,
      borderWidth: 1,
      panelBlur: 20,
      panelOpacity: 0.82,
      fontPreset: "cinzel",
      fontScale: 1.02,
      headingTracking: 0.03,
      headingUppercase: false,
      shadowStyle: "deep",
      sandAnimation: true,
      customBrandTitle: "Imperial Archive",
    },
    shell: {
      ...DEFAULT_SHELL_LAYOUT,
      position: "compact-rail",
      density: "spacious",
      contentWidth: "boxed-1600",
      stickyTopbar: false,
    },
    navigation: structuredClone(DEFAULT_NAVIGATION_GROUPS),
    pages: {
      ...structuredClone(DEFAULT_PAGE_WIDGET_LAYOUTS),
      Home: {
        page: "Home",
        columns: 12,
        gap: 20,
        widgets: [
          { id: "home.hero", title: String("Battlegroup Status & Actions"), span: 8, hidden: false },
          { id: "home.performance", title: String("Host Performance"), span: 4, hidden: false },
          { id: "home.subsystems", title: String("Readiness & Health"), span: 6, hidden: false },
          { id: "home.highlights", title: String("Feature Highlights"), span: 6, hidden: false },
        ],
      },
    },
  },
  {
    version: 1,
    id: "caladan-daylight",
    name: "Caladan Daylight (Light Mode)",
    author: "Dune Skin Studio",
    description: String("High-readability daylight skin with warm alabaster surfaces, deep oceanic accents and clean modern cards."),
    baseThemeId: "default",
    customColors: {
      enabled: true,
      name: "Caladan Daylight",
      appearance: "light",
      background: "#f4f1ea",
      panel: "#ffffff",
      accent: "#0f6e8c",
      secondary: "#b86b28",
      tokenOverrides: {},
    },
    design: {
      ...DEFAULT_DESIGN_TOKENS,
      radiusSm: 8,
      radiusMd: 10,
      radiusLg: 14,
      borderWidth: 1,
      panelBlur: 10,
      panelOpacity: 0.96,
      fontPreset: "inter",
      fontScale: 1,
      headingTracking: 0,
      headingUppercase: false,
      shadowStyle: "default",
      sandAnimation: false,
      customBrandTitle: "Caladan Server Console",
    },
    shell: {
      ...DEFAULT_SHELL_LAYOUT,
      position: "sidebar-left",
      density: "default",
      contentWidth: "boxed-1600",
      stickyTopbar: true,
    },
    navigation: structuredClone(DEFAULT_NAVIGATION_GROUPS),
    pages: structuredClone(DEFAULT_PAGE_WIDGET_LAYOUTS),
  },
];
