import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultSkinProfile, BUILTIN_SKIN_PRESETS } from "./skinDefaults";
import {
  applySkinProfile,
  clearSkinDomOverrides,
  exportSkinToJson,
  getAllAvailableSkins,
  importSkinFromJson,
  isLayoutEditMode,
  loadActiveSkin,
  saveAndApplySkin,
  setLayoutEditMode,
  updatePageWidgetLayout,
} from "./skinEngine";
import {
  CrossPageWidgetRendererContext,
  LayoutWidget,
  LayoutZone,
  computeSideBySidePreviewSpan,
  detectDropIntentFromPoint,
} from "./LayoutZone";
import { CustomDashboardView } from "./CustomDashboardView";
import { SkinStudioModal } from "./SkinStudioModal";

describe("Skin & Layout Engine", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearSkinDomOverrides();
    document.documentElement.removeAttribute("style");
    delete document.documentElement.dataset.theme;
    setLayoutEditMode(false);
  });

  afterEach(() => {
    cleanup();
  });

  it("loads the default skin cleanly with zero root style pollution", () => {
    const skin = loadActiveSkin();
    expect(skin.id).toBe("default");
    applySkinProfile(skin);
    expect(document.documentElement.dataset.skinId).toBeUndefined();
    expect(document.documentElement.getAttribute("style") ?? "").toBe("");
  });

  it("can apply and reload imported skins with malformed design text fields", () => {
    const imported = importSkinFromJson(JSON.stringify({
      id: "imported", design: { customBgImageUrl: null, customBrandTitle: 42, customBrandSubtitle: [], fontPreset: "constructor" },
    }));
    saveAndApplySkin(imported);
    expect(loadActiveSkin().design).toEqual(createDefaultSkinProfile().design);
  });

  it("keeps the default palette after resetting a pending custom palette", async () => {
    saveAndApplySkin(BUILTIN_SKIN_PRESETS.find((skin) => skin.customColors.enabled)!);
    saveAndApplySkin(createDefaultSkinProfile());
    await vi.dynamicImportSettled();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("");
  });

  it("applies custom macro shell layout, custom colors, and typography", () => {
    const commandSkin = BUILTIN_SKIN_PRESETS.find((s) => s.id === "arrakis-command-top")!;
    saveAndApplySkin(commandSkin);

    const root = document.documentElement;
    expect(root.dataset.skinId).toBe("arrakis-command-top");
    expect(root.dataset.shellPosition).toBe("top-nav");
    expect(root.dataset.shellDensity).toBe("compact");
    expect(root.dataset.stickyTopbar).toBe("true");
    expect(root.style.getPropertyValue("--skin-radius-sm")).toBe("2px");
    expect(root.style.getPropertyValue("--bg")).toBe("#0a0c0e");
    expect(loadActiveSkin().id).toBe("arrakis-command-top");

    // Resetting back to default removes all overrides
    saveAndApplySkin(createDefaultSkinProfile());
    expect(root.dataset.skinId).toBeUndefined();
    expect(root.dataset.shellPosition).toBeUndefined();
    expect(root.getAttribute("style") ?? "").toBe("");
  });

  it("exports and imports a complete skin profile including navigation and widget layout", () => {
    const harkonnen = BUILTIN_SKIN_PRESETS.find((s) => s.id === "harkonnen-brutalist-right")!;
    const json = exportSkinToJson(harkonnen);
    const imported = importSkinFromJson(json);

    expect(imported.id).toBe("harkonnen-brutalist-right");
    expect(imported.shell.position).toBe("sidebar-right");
    expect(imported.navigation[0].title).toBe("01 // Sector Control");
    expect(imported.pages.Home.widgets[0].id).toBe("home.performance");
  });

  it("updates page widget ordering, column spans and visibility", () => {
    updatePageWidgetLayout("Home", (page) => ({
      ...page,
      widgets: page.widgets.map((w) =>
        w.id === "home.hero" ? { ...w, span: 12 } : w.id === "home.highlights" ? { ...w, hidden: true } : w
      ),
    }));

    const active = loadActiveSkin();
    expect(active.pages.Home.widgets.find((w) => w.id === "home.hero")?.span).toBe(12);
    expect(active.pages.Home.widgets.find((w) => w.id === "home.highlights")?.hidden).toBe(true);
  });

  it("renders LayoutZone and LayoutWidget transparently in Default mode and interactively in Layout Edit Mode", () => {
    setLayoutEditMode(true);
    expect(isLayoutEditMode()).toBe(true);

    render(
      <LayoutZone page="Home" className="grid home-grid">
        <LayoutWidget id="home.hero" title="Battlegroup Status & Actions">
          <div>Hero Content</div>
        </LayoutWidget>
        <LayoutWidget id="home.performance" title="Host Performance">
          <div>Performance Content</div>
        </LayoutWidget>
      </LayoutZone>
    );

    expect(screen.getByText("Layout Edit Mode: Home")).toBeInTheDocument();
    expect(screen.getByText("Hero Content")).toBeInTheDocument();

    // Click Full width (12 cols) on the first widget
    const fullButtons = screen.getAllByRole("button", { name: "Full" });
    fireEvent.click(fullButtons[0]);
    expect(loadActiveSkin().pages.Home.widgets.find((w) => w.id === "home.hero")?.span).toBe(12);
  });

  it("renders SkinStudioModal with all 6 studio tabs, integrated Console Theme palettes under Skin Presets, and applies presets", () => {
    render(<SkinStudioModal onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: /Dune Console Skin & Layout Studio/i })).toBeInTheDocument();
    expect(getAllAvailableSkins().length).toBeGreaterThanOrEqual(5);
    expect(screen.queryByRole("button", { name: /Custom CSS & JSON/i })).toBeNull();
    expect(screen.getByText(/Console Theme Palettes/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Filter palettes/i)).toBeInTheDocument();

    // Switch through tabs
    fireEvent.click(screen.getByRole("button", { name: /Shell Structure/i }));
    expect(screen.getByText(/Macro Shell Architecture/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Navigation Builder/i }));
    expect(screen.getByText(/Navigation Groups & Tab Ordering/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Object & Widget Layout/i }));
    expect(screen.getByText(/Page Object & Widget Grid Composer/i)).toBeInTheDocument();
  });

  it("computes live side-by-side preview spans and drop intents when dragging next to or into another widget", () => {
    const rect = { left: 0, top: 0, width: 400, height: 200 } as DOMRect;
    expect(detectDropIntentFromPoint(40, 100, rect)).toBe("side-left");
    expect(detectDropIntentFromPoint(350, 100, rect)).toBe("side-right");
    expect(detectDropIntentFromPoint(200, 100, rect)).toBe("group-center");
    expect(detectDropIntentFromPoint(200, 10, rect)).toBe("reorder-top");
    expect(detectDropIntentFromPoint(200, 190, rect)).toBe("reorder-bottom");

    // Both full-width (12) widgets automatically shrink to 6 (50% side-by-side) during live hover preview
    const targetPreview = computeSideBySidePreviewSpan("home.hero", 12, "home.performance", {
      targetId: "home.hero",
      intent: "side-right",
    });
    expect(targetPreview.previewSpan).toBe(6);
    expect(targetPreview.isSidePreview).toBe(true);

    const draggedPreview = computeSideBySidePreviewSpan("home.performance", 12, "home.performance", {
      targetId: "home.hero",
      intent: "side-right",
    });
    expect(draggedPreview.previewSpan).toBe(6);
    expect(draggedPreview.previewOrderOffset).toBe(0.5);
    expect(draggedPreview.isSidePreview).toBe(true);
  });

  it("supports creating custom menu dashboard entries and adding widgets from other sections", () => {
    render(<SkinStudioModal onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Navigation Builder/i }));

    const nameInput = screen.getByPlaceholderText(/e.g. Ops Command Center/i);
    fireEvent.change(nameInput, { target: { value: "My Ops Cockpit" } });
    fireEvent.click(screen.getByRole("button", { name: /Create Custom Menu Dashboard/i }));

    // Save Profile
    fireEvent.click(screen.getByRole("button", { name: /Save Profile/i }));

    const active = loadActiveSkin();
    expect(active.customPages?.length).toBe(1);
    const customPage = active.customPages![0];
    expect(customPage.title).toBe("My Ops Cockpit");
    expect(active.navigation[0].items.some((item) => item.tab === customPage.id)).toBe(true);

    cleanup();
    render(
      <CrossPageWidgetRendererContext.Provider
        value={(w) => <div data-testid={`ctx-fallback-${w.id}`}>{w.title}</div>}
      >
        <CustomDashboardView
          dashboard={customPage}
          renderSourceWidget={(w) => <div data-testid={`embedded-${w.id}`}>{w.title}</div>}
        />
      </CrossPageWidgetRendererContext.Provider>
    );
    expect(screen.getAllByTestId("embedded-home.hero")).toHaveLength(1);
    expect(screen.getAllByTestId("embedded-home.performance")).toHaveLength(1);
    expect(screen.queryByTestId("ctx-fallback-home.hero")).toBeNull();
  });

  it("sanitizes invalid hex colors and unsafe tokenOverrides when importing a skin JSON", () => {
    const rawJson = JSON.stringify({
      id: "untrusted-skin",
      name: "Untrusted Skin",
      customColors: {
        enabled: true,
        appearance: "dark",
        background: "not-a-hex",
        panel: "#112233",
        accent: "javascript:alert(1)",
        secondary: "#445566",
        tokenOverrides: {
          "--title": "#ffaa00",
          "--bad-value": "url(https://evil.example/x)",
          "display": "none",
        },
      },
    });
    const imported = importSkinFromJson(rawJson);
    expect(imported.customColors.background).toBe("#0d0f12");
    expect(imported.customColors.panel).toBe("#112233");
    expect(imported.customColors.accent).toBe("#c68b4a");
    expect(imported.customColors.tokenOverrides["--title"]).toBe("#ffaa00");
    expect(imported.customColors.tokenOverrides["--bad-value"]).toBeUndefined();
    expect(imported.customColors.tokenOverrides["display"]).toBeUndefined();
  });
});
