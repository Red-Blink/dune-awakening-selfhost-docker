import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Columns,
  Copy,
  Download,
  Eye,
  EyeOff,
  Layout,
  Menu,
  Palette,
  Plus,
  RotateCcw,
  Save,
  Sliders,
  Sparkles,
  Trash2,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { PALETTE_GROUPS } from "../themes/consolePalettes";
import { DEFAULT_THEME_ID, getThemes, saveSelectedTheme } from "../themes/themeEngine";
import {
  BUILTIN_SKIN_PRESETS,
  createDefaultSkinProfile,
  DEFAULT_DESIGN_TOKENS,
  DEFAULT_NAVIGATION_GROUPS,
  DEFAULT_PAGE_WIDGET_LAYOUTS,
  DEFAULT_SHELL_LAYOUT,
  GLOBAL_WIDGET_CATALOG,
} from "./skinDefaults";
import {
  exportSkinToJson,
  getAllAvailableSkins,
  importSkinFromJson,
  loadActiveSkin,
  loadCustomSkins,
  saveAndApplySkin,
  saveCustomSkins,
} from "./skinEngine";
import type {
  ContentWidthMode,
  CustomDashboardPageConfig,
  DensityMode,
  DuneSkinProfile,
  FontPreset,
  ShadowStyle,
  ShellPosition,
  WidgetSpan,
} from "./skinTypes";
import { useSkinConfig } from "./useSkinConfig";

type StudioTab = "presets" | "colors" | "design" | "shell" | "navigation" | "widgets";

const STUDIO_TABS: { id: StudioTab; label: string; icon: React.ReactNode }[] = [
  { id: "presets", label: "Skin Presets", icon: <Sparkles size={15} /> },
  { id: "colors", label: "Colors & Tokens", icon: <Palette size={15} /> },
  { id: "design", label: "Typography & Shapes", icon: <Sliders size={15} /> },
  { id: "shell", label: "Shell Structure", icon: <Layout size={15} /> },
  { id: "navigation", label: "Navigation Builder", icon: <Menu size={15} /> },
  { id: "widgets", label: "Object & Widget Layout", icon: <Columns size={15} /> },
];

const CORE_TOKEN_OVERRIDE_FIELDS: { token: string; label: string }[] = [
  { token: "--title", label: "Headings & Titles (--title)" },
  { token: "--text", label: "Body Text (--text)" },
  { token: "--text-strong", label: "Strong Text (--text-strong)" },
  { token: "--muted", label: "Muted Labels (--muted)" },
  { token: "--border", label: "Panel Border (--border)" },
  { token: "--border-strong", label: "Control Border (--border-strong)" },
  { token: "--success", label: "Success Accent (--success)" },
  { token: "--warning", label: "Warning Accent (--warning)" },
  { token: "--danger", label: "Danger Accent (--danger)" },
];

export function SkinStudioModal({ onClose }: { onClose: () => void }) {
  const [activeSkin, editMode, setEditMode] = useSkinConfig();
  const [tab, setTab] = useState<StudioTab>("presets");
  const [draft, setDraft] = useState<DuneSkinProfile>(() => structuredClone(activeSkin));
  const [customSkins, setCustomSkins] = useState<DuneSkinProfile[]>(() => loadCustomSkins());
  const [selectedPageForWidgets, setSelectedPageForWidgets] = useState<string>("Home");
  const [newDashboardTitle, setNewDashboardTitle] = useState<string>("");
  const [newDashboardSubtitle, setNewDashboardSubtitle] = useState<string>("");
  const [newDashboardGroupId, setNewDashboardGroupId] = useState<string>("server-operations");
  const [crossWidgetAddId, setCrossWidgetAddId] = useState<string>("");
  const [themeFilter, setThemeFilter] = useState<string>("");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraft(structuredClone(loadActiveSkin()));
  }, []);

  function notify(msg: string) {
    setStatusMessage(msg);
    window.setTimeout(() => setStatusMessage(""), 4000);
  }

  function applyDraftLive(next: DuneSkinProfile) {
    setDraft(next);
    saveAndApplySkin(next);
  }

  function selectPreset(preset: DuneSkinProfile) {
    const clone = structuredClone(preset);
    setDraft(clone);
    saveAndApplySkin(clone);
    notify(`Applied skin "${clone.name}".`);
  }

  function saveAsCustomSkin() {
    const customId =
      draft.id === "default" || BUILTIN_SKIN_PRESETS.some((p) => p.id === draft.id)
        ? `custom-${Date.now()}`
        : draft.id;
    const saved: DuneSkinProfile = {
      ...structuredClone(draft),
      id: customId,
      name: draft.name.trim() || "Custom Skin",
      author: draft.author.trim() || "Local Admin",
    };
    const nextList = [...customSkins.filter((s) => s.id !== saved.id), saved];
    saveCustomSkins(nextList);
    setCustomSkins(nextList);
    applyDraftLive(saved);
    notify(`Saved "${saved.name}" to your custom skins.`);
  }

  function duplicateCurrentSkin() {
    const copy: DuneSkinProfile = {
      ...structuredClone(draft),
      id: `custom-${Date.now()}`,
      name: `${draft.name} (Copy)`,
    };
    const nextList = [...customSkins, copy];
    saveCustomSkins(nextList);
    setCustomSkins(nextList);
    applyDraftLive(copy);
    notify(`Duplicated as "${copy.name}".`);
  }

  function deleteCustomSkin(id: string) {
    const nextList = customSkins.filter((s) => s.id !== id);
    saveCustomSkins(nextList);
    setCustomSkins(nextList);
    if (draft.id === id) {
      const def = createDefaultSkinProfile();
      applyDraftLive(def);
    }
    notify("Removed custom skin.");
  }

  function resetAllToDefault() {
    const def = createDefaultSkinProfile();
    setEditMode(false);
    applyDraftLive(def);
    notify("Restored original Console appearance and layout.");
  }

  function handleDownloadJson() {
    const json = exportSkinToJson(draft);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${draft.id || "dune-skin"}.skin.json`;
    a.click();
    URL.revokeObjectURL(url);
    notify("Downloaded skin JSON file.");
  }

  function handleUploadJsonFile(file: File | null) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = importSkinFromJson(String(reader.result || ""));
        const nextList = [...customSkins.filter((s) => s.id !== imported.id), imported];
        saveCustomSkins(nextList);
        setCustomSkins(nextList);
        applyDraftLive(imported);
        notify(`Imported and applied "${imported.name}".`);
      } catch (err) {
        notify(err instanceof Error ? err.message : "Failed to import skin JSON.");
      }
    };
    reader.readAsText(file);
  }

  const allSkins = getAllAvailableSkins();
  const themes = getThemes();
  const allConsoleThemes = useMemo(() => {
    const swatchTokens = ["--bg", "--panel", "--accent", "--accent-strong"] as const;
    const defaultSwatches = ["#0d0f12", "#171a1d", "#c68b4a", "#d8a05c"] as const;
    const defaultGroup = PALETTE_GROUPS[0];
    return [
      {
        id: DEFAULT_THEME_ID,
        name: "Default",
        description: "The standard console look.",
        group: defaultGroup,
        swatches: defaultSwatches as readonly string[],
      },
      ...getThemes().map((theme) => ({
        id: theme.id,
        name: theme.name,
        description: theme.description,
        group: theme.group ?? defaultGroup,
        swatches:
          theme.dyes ?? (swatchTokens.map((token) => theme.base[token]) as readonly string[]),
      })),
    ];
  }, []);
  const themeQuery = themeFilter.trim().toLowerCase();
  const selectedConsoleThemeId = draft.customColors.enabled
    ? ""
    : draft.baseThemeId || DEFAULT_THEME_ID;
  const matchingConsoleTheme = (option: (typeof allConsoleThemes)[number]) =>
    !themeQuery ||
    option.name.toLowerCase().includes(themeQuery) ||
    option.group.toLowerCase().includes(themeQuery);
  const filteredConsoleThemes = allConsoleThemes.filter(
    (option) => matchingConsoleTheme(option) || option.id === selectedConsoleThemeId
  );
  const consoleThemeGroupNames = [
    ...PALETTE_GROUPS,
    ...new Set(
      allConsoleThemes
        .map((option) => option.group)
        .filter((group) => !(PALETTE_GROUPS as readonly string[]).includes(group))
    ),
  ];
  const consoleThemeGroups = consoleThemeGroupNames
    .map((group) => ({
      group,
      items: filteredConsoleThemes.filter((option) => option.group === group),
    }))
    .filter((entry) => entry.items.length > 0);
  const consoleThemeMatchCount = allConsoleThemes.filter(matchingConsoleTheme).length;

  const activePageWidgets =
    draft.pages[selectedPageForWidgets] || DEFAULT_PAGE_WIDGET_LAYOUTS[selectedPageForWidgets];

  return createPortal(
    <div
      className="modal-overlay skin-studio-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="confirm-modal skin-studio-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skin-studio-title"
      >
        <header className="skin-studio-header">
          <div className="skin-studio-title-row">
            <Wand2 size={22} aria-hidden="true" />
            <div>
              <h2 id="skin-studio-title">Dune Console Skin &amp; Layout Studio</h2>
              <p>Customize colors, typography, shell architecture, navigation structure and dashboard object positions.</p>
            </div>
          </div>
          <div className="skin-studio-header-actions">
            <button
              type="button"
              className={`skin-edit-mode-toggle ${editMode ? "active" : ""}`}
              onClick={() => {
                const next = !editMode;
                setEditMode(next);
                if (next) {
                  onClose();
                }
              }}
              title="Toggle interactive drag-and-drop widget layout mode right on the console pages"
            >
              <Columns size={16} />
              <span>{editMode ? "Exit Interactive Layout Mode" : "Interactive On-Page Layout Editor"}</span>
            </button>
            <button type="button" onClick={resetAllToDefault} title="Reset everything to Standard Console">
              <RotateCcw size={16} /> Reset Default
            </button>
            <button type="button" aria-label="Close Skin Studio" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="skin-studio-meta-bar">
          <label className="skin-meta-field">
            <span>Active Skin Name</span>
            <input
              value={draft.name}
              onChange={(e) =>
                applyDraftLive({
                  ...draft,
                  id: draft.id === "default" ? "custom-working" : draft.id,
                  name: e.target.value,
                })
              }
              placeholder="My Arrakis Skin"
            />
          </label>
          <label className="skin-meta-field">
            <span>Author</span>
            <input
              value={draft.author}
              onChange={(e) =>
                applyDraftLive({
                  ...draft,
                  id: draft.id === "default" ? "custom-working" : draft.id,
                  author: e.target.value,
                })
              }
              placeholder="Server Operator"
            />
          </label>
          <div className="skin-meta-buttons">
            <button type="button" onClick={saveAsCustomSkin}>
              <Save size={15} /> Save Profile
            </button>
            <button type="button" onClick={duplicateCurrentSkin}>
              <Copy size={15} /> Duplicate
            </button>
            <button type="button" onClick={handleDownloadJson}>
              <Download size={15} /> Export JSON
            </button>
            <button type="button" onClick={() => fileInputRef.current?.click()}>
              <Upload size={15} /> Import JSON
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(e) => handleUploadJsonFile(e.target.files?.[0] || null)}
            />
          </div>
        </div>

        {statusMessage && (
          <div className="skin-studio-status-toast" role="status">
            <Check size={15} /> <span>{statusMessage}</span>
          </div>
        )}

        <div className="skin-studio-body">
          <nav className="skin-studio-tabs" aria-label="Skin Studio sections">
            {STUDIO_TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={tab === item.id ? "active" : ""}
                onClick={() => setTab(item.id)}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="skin-studio-panel">
            {tab === "presets" && (
              <div className="skin-studio-section">
                <h3>Built-in &amp; Custom Skin Profiles</h3>
                <p className="muted">
                  Each skin bundles a complete visual theme, shell layout (left sidebar, right dock, top horizontal navbar or compact icon rail), navigation structure and widget grid arrangement.
                </p>
                <div className="skin-preset-grid">
                  {allSkins.map((preset) => {
                    const isSelected = draft.id === preset.id;
                    const isBuiltIn = BUILTIN_SKIN_PRESETS.some((b) => b.id === preset.id);
                    const swatches = preset.customColors.enabled
                      ? [
                          preset.customColors.background,
                          preset.customColors.panel,
                          preset.customColors.accent,
                          preset.customColors.secondary,
                        ]
                      : ["#0d0f12", "#171a1d", "#c68b4a", "#95bdcf"];
                    return (
                      <article
                        key={preset.id}
                        className={`skin-preset-card ${isSelected ? "selected" : ""}`}
                      >
                        <div className="skin-preset-card-top">
                          <div>
                            <strong>{preset.name}</strong>
                            <small>
                              by {preset.author} · Shell: <code>{preset.shell.position}</code> · Density:{" "}
                              <code>{preset.shell.density}</code>
                            </small>
                          </div>
                          <span className="theme-swatches" aria-hidden="true">
                            {swatches.map((c, idx) => (
                              <i key={idx} style={{ background: c }} />
                            ))}
                          </span>
                        </div>
                        <p>{preset.description}</p>
                        <div className="skin-preset-card-actions">
                          <button
                            type="button"
                            className={isSelected ? "active" : ""}
                            onClick={() => selectPreset(preset)}
                          >
                            {isSelected ? <Check size={14} /> : null}
                            {isSelected ? "Applied" : "Apply Skin"}
                          </button>
                          {!isBuiltIn && (
                            <button
                              type="button"
                              className="danger"
                              onClick={() => deleteCustomSkin(preset.id)}
                            >
                              <Trash2 size={14} /> Delete
                            </button>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>

                <div className="skin-console-themes-section">
                  <div className="skin-row-between">
                    <div>
                      <h3>
                        <Palette size={17} style={{ verticalAlign: "-3px", marginRight: 8 }} aria-hidden="true" />
                        Console Theme Palettes ({allConsoleThemes.length} Palettes)
                      </h3>
                      <p className="muted">
                        Choose any of the built-in Console Themes (Dune Docker, Dune Awakening &amp; House Swatches). Picking a Console Theme applies its color palette while keeping your current shell &amp; widget layout.
                      </p>
                    </div>
                    <div className="skin-console-theme-filter-wrap">
                      <input
                        className="theme-filter"
                        type="search"
                        value={themeFilter}
                        placeholder="Filter palettes"
                        aria-label="Filter palettes"
                        onChange={(event) => setThemeFilter(event.target.value)}
                      />
                      <small className="theme-filter-count" role="status" aria-live="polite">
                        {themeQuery
                          ? consoleThemeMatchCount === 0
                            ? "No other palettes match."
                            : `${consoleThemeMatchCount} of ${allConsoleThemes.length} palettes`
                          : `${allConsoleThemes.length} palettes`}
                      </small>
                    </div>
                  </div>

                  <div className="skin-console-themes-groups">
                    {consoleThemeGroups.map(({ group, items }) => (
                      <div
                        key={group}
                        role="radiogroup"
                        aria-label={group}
                        className="theme-group"
                      >
                        <h4>{group}</h4>
                        <div className="theme-grid">
                          {items.map((option) => {
                            const isThemeSelected = selectedConsoleThemeId === option.id;
                            return (
                              <button
                                key={option.id}
                                type="button"
                                role="radio"
                                aria-checked={isThemeSelected}
                                className={`theme-card${isThemeSelected ? " selected" : ""}`}
                                title={option.description}
                                onClick={() => {
                                  saveSelectedTheme(option.id);
                                  applyDraftLive({
                                    ...draft,
                                    baseThemeId: option.id,
                                    customColors: {
                                      ...draft.customColors,
                                      enabled: false,
                                    },
                                  });
                                  notify(`Applied Console Theme "${option.name}".`);
                                }}
                              >
                                <span className="theme-card-name">
                                  <span className="theme-card-label" title={option.name}>
                                    {option.name}
                                  </span>
                                  <Check className="theme-card-check" size={15} aria-hidden="true" />
                                </span>
                                <span className="theme-swatches" aria-hidden="true">
                                  {option.swatches.map((color, swatchIndex) => (
                                    <i key={swatchIndex} style={{ background: color }} />
                                  ))}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {tab === "colors" && (
              <div className="skin-studio-section">
                <h3>Color Engine &amp; Role Token Overrides</h3>
                <div className="skin-field-card">
                  <div className="skin-row-between">
                    <div>
                      <strong>Use Custom 4-Color Generator &amp; Token Overrides</strong>
                      <p className="muted">
                        Automatically derives all 268 surface, ink and tint role tokens with WCAG AA contrast guarantees, or choose one of the 66 built-in palettes below.
                      </p>
                    </div>
                    <label
                      className={`switch-checkbox ${draft.customColors.enabled ? "enabled" : "disabled"}`}
                    >
                      <input
                        type="checkbox"
                        checked={draft.customColors.enabled}
                        onChange={(e) =>
                          applyDraftLive({
                            ...draft,
                            id: draft.id === "default" ? "custom-working" : draft.id,
                            customColors: { ...draft.customColors, enabled: e.target.checked },
                          })
                        }
                      />
                      <span className="switch-label">Custom Palette</span>
                      <strong className="switch-state">{draft.customColors.enabled ? "ON" : "OFF"}</strong>
                    </label>
                  </div>

                  {!draft.customColors.enabled && (
                    <label className="skin-select-field">
                      <span>Base Console Palette (66 Built-in Palettes)</span>
                      <select
                        value={draft.baseThemeId}
                        onChange={(e) =>
                          applyDraftLive({
                            ...draft,
                            baseThemeId: e.target.value,
                          })
                        }
                      >
                        <option value="default">Default (Standard Console)</option>
                        {themes.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.group ? `${t.group}: ` : ""}
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {draft.customColors.enabled && (
                    <>
                      <div className="skin-color-grid">
                        <label>
                          <span>Color Scheme Appearance</span>
                          <select
                            value={draft.customColors.appearance}
                            onChange={(e) =>
                              applyDraftLive({
                                ...draft,
                                id: draft.id === "default" ? "custom-working" : draft.id,
                                customColors: {
                                  ...draft.customColors,
                                  appearance: e.target.value as "dark" | "light",
                                },
                              })
                            }
                          >
                            <option value="dark">Dark Mode Surface</option>
                            <option value="light">Light Mode Surface</option>
                          </select>
                        </label>
                        {(
                          [
                            ["background", "Page Background (--bg)"],
                            ["panel", "Panel / Card Surface (--panel)"],
                            ["accent", "Primary Accent (--accent)"],
                            ["secondary", "Secondary / Info (--accent-strong)"],
                          ] as const
                        ).map(([key, label]) => (
                          <label key={key} className="skin-color-picker-field">
                            <span>{label}</span>
                            <div className="skin-color-input-pair">
                              <input
                                type="color"
                                value={draft.customColors[key]}
                                onChange={(e) =>
                                  applyDraftLive({
                                    ...draft,
                                    id: draft.id === "default" ? "custom-working" : draft.id,
                                    customColors: {
                                      ...draft.customColors,
                                      [key]: e.target.value,
                                    },
                                  })
                                }
                              />
                              <input
                                type="text"
                                value={draft.customColors[key]}
                                onChange={(e) =>
                                  applyDraftLive({
                                    ...draft,
                                    id: draft.id === "default" ? "custom-working" : draft.id,
                                    customColors: {
                                      ...draft.customColors,
                                      [key]: e.target.value,
                                    },
                                  })
                                }
                              />
                            </div>
                          </label>
                        ))}
                      </div>

                      <h4>Fine-Grained Token Overrides (Optional)</h4>
                      <div className="skin-color-grid">
                        {CORE_TOKEN_OVERRIDE_FIELDS.map(({ token, label }) => {
                          const currentVal = draft.customColors.tokenOverrides[token] || "";
                          return (
                            <label key={token} className="skin-color-picker-field">
                              <span>{label}</span>
                              <div className="skin-color-input-pair">
                                <input
                                  type="color"
                                  value={/^#[0-9a-f]{6}$/i.test(currentVal) ? currentVal : "#c68b4a"}
                                  onChange={(e) => {
                                    const nextOverrides = {
                                      ...draft.customColors.tokenOverrides,
                                      [token]: e.target.value,
                                    };
                                    applyDraftLive({
                                      ...draft,
                                      id: draft.id === "default" ? "custom-working" : draft.id,
                                      customColors: {
                                        ...draft.customColors,
                                        tokenOverrides: nextOverrides,
                                      },
                                    });
                                  }}
                                />
                                <input
                                  type="text"
                                  placeholder="Auto-derived"
                                  value={currentVal}
                                  onChange={(e) => {
                                    const val = e.target.value.trim();
                                    const nextOverrides = { ...draft.customColors.tokenOverrides };
                                    if (!val) delete nextOverrides[token];
                                    else nextOverrides[token] = val;
                                    applyDraftLive({
                                      ...draft,
                                      id: draft.id === "default" ? "custom-working" : draft.id,
                                      customColors: {
                                        ...draft.customColors,
                                        tokenOverrides: nextOverrides,
                                      },
                                    });
                                  }}
                                />
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {tab === "design" && (
              <div className="skin-studio-section">
                <h3>Typography, Geometry, Glassmorphism &amp; Branding</h3>
                <div className="skin-controls-grid">
                  <label>
                    <span>Font Family Preset</span>
                    <select
                      value={draft.design.fontPreset}
                      onChange={(e) =>
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          design: { ...draft.design, fontPreset: e.target.value as FontPreset },
                        })
                      }
                    >
                      <option value="inter">Inter / Clean Modern UI (Default)</option>
                      <option value="rajdhani">Rajdhani / Sci-Fi Tactical Display</option>
                      <option value="jetbrains-mono">JetBrains Mono / Technical Telemetry</option>
                      <option value="cinzel">Cinzel / Imperial Serif</option>
                      <option value="system">Native OS System Font</option>
                    </select>
                  </label>

                  <label>
                    <span>Shadow &amp; Elevation Style</span>
                    <select
                      value={draft.design.shadowStyle}
                      onChange={(e) =>
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          design: { ...draft.design, shadowStyle: e.target.value as ShadowStyle },
                        })
                      }
                    >
                      <option value="default">Standard Soft Shadow</option>
                      <option value="flat">Flat / No Shadow (Brutalist)</option>
                      <option value="deep">Deep Floating Elevation</option>
                      <option value="neon-glow">Accent Rim Glow (Sci-Fi)</option>
                    </select>
                  </label>

                  <label>
                    <span>Button &amp; Input Corner Radius ({draft.design.radiusSm}px)</span>
                    <input
                      type="range"
                      min="0"
                      max="24"
                      value={draft.design.radiusSm}
                      onChange={(e) =>
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          design: { ...draft.design, radiusSm: Number(e.target.value) },
                        })
                      }
                    />
                  </label>

                  <label>
                    <span>Panel &amp; Card Corner Radius ({draft.design.radiusMd}px)</span>
                    <input
                      type="range"
                      min="0"
                      max="28"
                      value={draft.design.radiusMd}
                      onChange={(e) =>
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          design: {
                            ...draft.design,
                            radiusMd: Number(e.target.value),
                            radiusLg: Math.min(36, Number(e.target.value) + 4),
                          },
                        })
                      }
                    />
                  </label>

                  <label>
                    <span>Border Width ({draft.design.borderWidth}px)</span>
                    <input
                      type="range"
                      min="0"
                      max="4"
                      step="1"
                      value={draft.design.borderWidth}
                      onChange={(e) =>
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          design: { ...draft.design, borderWidth: Number(e.target.value) },
                        })
                      }
                    />
                  </label>

                  <label>
                    <span>Backdrop Glass Blur ({draft.design.panelBlur}px)</span>
                    <input
                      type="range"
                      min="0"
                      max="32"
                      value={draft.design.panelBlur}
                      onChange={(e) =>
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          design: { ...draft.design, panelBlur: Number(e.target.value) },
                        })
                      }
                    />
                  </label>

                  <label>
                    <span>Heading Letter Spacing ({draft.design.headingTracking}em)</span>
                    <input
                      type="range"
                      min="-0.02"
                      max="0.18"
                      step="0.01"
                      value={draft.design.headingTracking}
                      onChange={(e) =>
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          design: { ...draft.design, headingTracking: Number(e.target.value) },
                        })
                      }
                    />
                  </label>

                  <label className="checkbox-line">
                    <input
                      type="checkbox"
                      checked={draft.design.headingUppercase}
                      onChange={(e) =>
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          design: { ...draft.design, headingUppercase: e.target.checked },
                        })
                      }
                    />
                    <span>Uppercase Headings (H1–H4)</span>
                  </label>

                  <label className="checkbox-line">
                    <input
                      type="checkbox"
                      checked={draft.design.sandAnimation}
                      onChange={(e) =>
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          design: { ...draft.design, sandAnimation: e.target.checked },
                        })
                      }
                    />
                    <span>Animated Desert Sand Particles on Home</span>
                  </label>
                </div>

                <h4>Custom Branding &amp; Background</h4>
                <div className="skin-controls-grid">
                  <label>
                    <span>Custom Console Brand Title</span>
                    <input
                      value={draft.design.customBrandTitle}
                      onChange={(e) =>
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          design: { ...draft.design, customBrandTitle: e.target.value },
                        })
                      }
                      placeholder="Dune Docker Console"
                    />
                  </label>
                  <label>
                    <span>Custom Topbar Subtitle</span>
                    <input
                      value={draft.design.customBrandSubtitle}
                      onChange={(e) =>
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          design: { ...draft.design, customBrandSubtitle: e.target.value },
                        })
                      }
                      placeholder="Run and manage your self-hosted Dune server from the browser."
                    />
                  </label>
                  <label className="wide">
                    <span>Custom Background Image URL (Leave empty for default desert backdrop)</span>
                    <input
                      value={draft.design.customBgImageUrl}
                      onChange={(e) =>
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          design: { ...draft.design, customBgImageUrl: e.target.value },
                        })
                      }
                      placeholder="/images/backgrounds/home-desert-bg.png or https://..."
                    />
                  </label>
                </div>
              </div>
            )}

            {tab === "shell" && (
              <div className="skin-studio-section">
                <h3>Macro Shell Architecture &amp; Chrome Layout</h3>
                <p className="muted">
                  Re-arrange the global application shell: dock the navigation on the left, on the right, across the top as a horizontal command bar, or as a compact icon rail.
                </p>
                <div className="skin-controls-grid">
                  <label>
                    <span>Navigation &amp; Shell Position</span>
                    <select
                      value={draft.shell.position}
                      onChange={(e) =>
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          shell: { ...draft.shell, position: e.target.value as ShellPosition },
                        })
                      }
                    >
                      <option value="sidebar-left">Left Sidebar (Standard)</option>
                      <option value="sidebar-right">Right Sidebar Dock</option>
                      <option value="top-nav">Top Horizontal Command Bar</option>
                      <option value="compact-rail">Compact Collapsible Icon Rail (Hover to expand)</option>
                    </select>
                  </label>

                  <label>
                    <span>UI Spacing &amp; Density</span>
                    <select
                      value={draft.shell.density}
                      onChange={(e) =>
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          shell: { ...draft.shell, density: e.target.value as DensityMode },
                        })
                      }
                    >
                      <option value="compact">Compact (High Data Density)</option>
                      <option value="default">Default (Balanced)</option>
                      <option value="spacious">Spacious (Relaxed Padding)</option>
                    </select>
                  </label>

                  <label>
                    <span>Workspace Container Width</span>
                    <select
                      value={draft.shell.contentWidth}
                      onChange={(e) =>
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          shell: { ...draft.shell, contentWidth: e.target.value as ContentWidthMode },
                        })
                      }
                    >
                      <option value="fluid">Fluid Full-Width</option>
                      <option value="boxed-1600">Boxed Centered (1600px Max)</option>
                      <option value="boxed-1360">Focused Centered (1360px Max)</option>
                    </select>
                  </label>

                  {(draft.shell.position === "sidebar-left" || draft.shell.position === "sidebar-right") && (
                    <label>
                      <span>Sidebar Width ({draft.shell.sidebarWidth}px)</span>
                      <input
                        type="range"
                        min="200"
                        max="360"
                        value={draft.shell.sidebarWidth}
                        onChange={(e) =>
                          applyDraftLive({
                            ...draft,
                            id: draft.id === "default" ? "custom-working" : draft.id,
                            shell: { ...draft.shell, sidebarWidth: Number(e.target.value) },
                          })
                        }
                      />
                    </label>
                  )}
                </div>

                <div className="skin-toggles-list">
                  <label className="checkbox-line">
                    <input
                      type="checkbox"
                      checked={draft.shell.stickyTopbar}
                      onChange={(e) =>
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          shell: { ...draft.shell, stickyTopbar: e.target.checked },
                        })
                      }
                    />
                    <span>Sticky Topbar Header while scrolling</span>
                  </label>

                  <label className="checkbox-line">
                    <input
                      type="checkbox"
                      checked={draft.shell.showTopbarSubtitle}
                      onChange={(e) =>
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          shell: { ...draft.shell, showTopbarSubtitle: e.target.checked },
                        })
                      }
                    />
                    <span>Show Topbar Subtitle description</span>
                  </label>

                  <label className="checkbox-line">
                    <input
                      type="checkbox"
                      checked={draft.shell.showCommunityButtons}
                      onChange={(e) =>
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          shell: { ...draft.shell, showCommunityButtons: e.target.checked },
                        })
                      }
                    />
                    <span>Show Join Discord &amp; Support Project buttons in Topbar</span>
                  </label>

                  <label className="checkbox-line">
                    <input
                      type="checkbox"
                      checked={draft.shell.showFooter}
                      onChange={(e) =>
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          shell: { ...draft.shell, showFooter: e.target.checked },
                        })
                      }
                    />
                    <span>Show Application Footer</span>
                  </label>
                </div>
              </div>
            )}

            {tab === "navigation" && (
              <div className="skin-studio-section">
                <div className="skin-field-card">
                  <h4>Create Custom Menu Entry &amp; Multi-Section Dashboard</h4>
                  <p className="muted">
                    Add your own menu entries to the sidebar navigation. Each custom menu item opens a freely configurable dashboard where you can place fields and sections from any part of the Console (Home, Server Control, Players, Live Map, Database, Backups, etc.).
                  </p>
                  <div className="skin-controls-grid">
                    <label>
                      <span>Menu Entry Title</span>
                      <input
                        value={newDashboardTitle}
                        onChange={(e) => setNewDashboardTitle(e.target.value)}
                        placeholder="e.g. Ops Command Center"
                      />
                    </label>
                    <label>
                      <span>Topbar Subtitle</span>
                      <input
                        value={newDashboardSubtitle}
                        onChange={(e) => setNewDashboardSubtitle(e.target.value)}
                        placeholder="e.g. Combined live telemetry, players & server controls"
                      />
                    </label>
                    <label>
                      <span>Place in Menu Group</span>
                      <select
                        value={newDashboardGroupId}
                        onChange={(e) => setNewDashboardGroupId(e.target.value)}
                      >
                        {draft.navigation.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.title}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="action-row">
                    <button
                      type="button"
                      disabled={!newDashboardTitle.trim()}
                      onClick={() => {
                        const slug = newDashboardTitle
                          .trim()
                          .toLowerCase()
                          .replace(/[^a-z0-9]+/g, "-")
                          .replace(/^-|-$/g, "");
                        const customId = `custom:${slug || "dashboard"}-${Date.now().toString(36)}`;
                        const newPage: CustomDashboardPageConfig = {
                          id: customId,
                          title: newDashboardTitle.trim(),
                          subtitle:
                            newDashboardSubtitle.trim() ||
                            `Custom dashboard view for ${newDashboardTitle.trim()}.`,
                          groupId: newDashboardGroupId || draft.navigation[0]?.id || "server-operations",
                        };
                        const nextCustomPages = [...(draft.customPages || []), newPage];
                        const nextNav = structuredClone(draft.navigation);
                        const targetGroup =
                          nextNav.find((g) => g.id === newPage.groupId) || nextNav[0];
                        if (targetGroup) {
                          targetGroup.items.push({
                            tab: customId,
                            customPageId: customId,
                            customLabel: newPage.title,
                          });
                        }
                        const nextPages = {
                          ...structuredClone(draft.pages),
                          [customId]: {
                            page: customId,
                            columns: 12 as const,
                            gap: 16,
                            widgets: [
                              {
                                id: "home.hero",
                                title: "Battlegroup Status & Actions",
                                span: 6 as WidgetSpan,
                                hidden: false,
                                sourcePage: "Home",
                              },
                              {
                                id: "home.performance",
                                title: "Host Performance",
                                span: 6 as WidgetSpan,
                                hidden: false,
                                sourcePage: "Home",
                              },
                            ],
                            groups: {},
                          },
                        };
                        applyDraftLive({
                          ...draft,
                          id: draft.id === "default" ? "custom-working" : draft.id,
                          customPages: nextCustomPages,
                          navigation: nextNav,
                          pages: nextPages,
                        });
                        setSelectedPageForWidgets(customId);
                        setNewDashboardTitle("");
                        setNewDashboardSubtitle("");
                        notify(
                          `Created custom dashboard "${newPage.title}" in the sidebar menu! You can now add any sections to it.`
                        );
                      }}
                    >
                      <Plus size={15} /> Create Custom Menu Dashboard
                    </button>
                  </div>

                  {(draft.customPages || []).length > 0 && (
                    <div className="skin-custom-pages-list">
                      <strong>Your Custom Menu Dashboards:</strong>
                      <div className="skin-custom-pages-chips">
                        {(draft.customPages || []).map((cp) => (
                          <div key={cp.id} className="skin-active-group-chip">
                            <span>{cp.title}</span>
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedPageForWidgets(cp.id);
                                setTab("widgets");
                              }}
                            >
                              Configure Fields
                            </button>
                            <button
                              type="button"
                              className="danger"
                              onClick={() => {
                                const nextCustomPages = (draft.customPages || []).filter(
                                  (p) => p.id !== cp.id
                                );
                                const nextNav = draft.navigation.map((g) => ({
                                  ...g,
                                  items: g.items.filter((item) => item.tab !== cp.id),
                                }));
                                const nextPages = { ...draft.pages };
                                delete nextPages[cp.id];
                                applyDraftLive({
                                  ...draft,
                                  id: draft.id === "default" ? "custom-working" : draft.id,
                                  customPages: nextCustomPages,
                                  navigation: nextNav,
                                  pages: nextPages,
                                });
                                if (selectedPageForWidgets === cp.id) {
                                  setSelectedPageForWidgets("Home");
                                }
                                notify(`Removed custom menu dashboard "${cp.title}".`);
                              }}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <div className="skin-row-between">
                  <div>
                    <h3>Navigation Groups &amp; Tab Ordering</h3>
                    <p className="muted">
                      Reorder navigation categories, rename group headings, move tabs up/down or between groups, and hide tabs you rarely use.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      applyDraftLive({
                        ...draft,
                        id: draft.id === "default" ? "custom-working" : draft.id,
                        navigation: [
                          ...draft.navigation,
                          {
                            id: `group-${Date.now()}`,
                            title: "Custom Group",
                            items: [],
                          },
                        ],
                      })
                    }
                  >
                    <Plus size={15} /> Add Group
                  </button>
                </div>

                <div className="skin-nav-groups-editor">
                  {draft.navigation.map((group, groupIdx) => (
                    <div key={group.id} className="skin-nav-group-card">
                      <div className="skin-nav-group-header">
                        <input
                          value={group.title}
                          aria-label="Navigation group title"
                          onChange={(e) => {
                            const nextNav = structuredClone(draft.navigation);
                            nextNav[groupIdx].title = e.target.value;
                            applyDraftLive({
                              ...draft,
                              id: draft.id === "default" ? "custom-working" : draft.id,
                              navigation: nextNav,
                            });
                          }}
                        />
                        <div className="skin-nav-item-actions">
                          <button
                            type="button"
                            disabled={groupIdx === 0}
                            title="Move group up"
                            onClick={() => {
                              const nextNav = structuredClone(draft.navigation);
                              const [moved] = nextNav.splice(groupIdx, 1);
                              nextNav.splice(groupIdx - 1, 0, moved);
                              applyDraftLive({
                                ...draft,
                                id: draft.id === "default" ? "custom-working" : draft.id,
                                navigation: nextNav,
                              });
                            }}
                          >
                            <ArrowUp size={14} />
                          </button>
                          <button
                            type="button"
                            disabled={groupIdx === draft.navigation.length - 1}
                            title="Move group down"
                            onClick={() => {
                              const nextNav = structuredClone(draft.navigation);
                              const [moved] = nextNav.splice(groupIdx, 1);
                              nextNav.splice(groupIdx + 1, 0, moved);
                              applyDraftLive({
                                ...draft,
                                id: draft.id === "default" ? "custom-working" : draft.id,
                                navigation: nextNav,
                              });
                            }}
                          >
                            <ArrowDown size={14} />
                          </button>
                          <button
                            type="button"
                            className={group.hidden ? "danger" : ""}
                            title={group.hidden ? "Show group" : "Hide entire group"}
                            onClick={() => {
                              const nextNav = structuredClone(draft.navigation);
                              nextNav[groupIdx].hidden = !nextNav[groupIdx].hidden;
                              applyDraftLive({
                                ...draft,
                                id: draft.id === "default" ? "custom-working" : draft.id,
                                navigation: nextNav,
                              });
                            }}
                          >
                            {group.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>
                      </div>

                      <ul className="skin-nav-items-list">
                        {group.items.map((item, itemIdx) => (
                          <li key={item.tab} className={item.hidden ? "is-hidden" : ""}>
                            <span className="skin-nav-item-tab">{item.tab}</span>
                            <input
                              type="text"
                              placeholder={`Custom label for ${item.tab}`}
                              value={item.customLabel || ""}
                              onChange={(e) => {
                                const nextNav = structuredClone(draft.navigation);
                                nextNav[groupIdx].items[itemIdx].customLabel = e.target.value;
                                applyDraftLive({
                                  ...draft,
                                  id: draft.id === "default" ? "custom-working" : draft.id,
                                  navigation: nextNav,
                                });
                              }}
                            />
                            <select
                              aria-label={`Move ${item.tab} to group`}
                              value={group.id}
                              onChange={(e) => {
                                const targetGroupId = e.target.value;
                                const nextNav = structuredClone(draft.navigation);
                                const [movedItem] = nextNav[groupIdx].items.splice(itemIdx, 1);
                                const targetGroup = nextNav.find((g) => g.id === targetGroupId);
                                if (targetGroup) targetGroup.items.push(movedItem);
                                applyDraftLive({
                                  ...draft,
                                  id: draft.id === "default" ? "custom-working" : draft.id,
                                  navigation: nextNav,
                                });
                              }}
                            >
                              {draft.navigation.map((g) => (
                                <option key={g.id} value={g.id}>
                                  Group: {g.title}
                                </option>
                              ))}
                            </select>
                            <div className="skin-nav-item-actions">
                              <button
                                type="button"
                                disabled={itemIdx === 0}
                                onClick={() => {
                                  const nextNav = structuredClone(draft.navigation);
                                  const [moved] = nextNav[groupIdx].items.splice(itemIdx, 1);
                                  nextNav[groupIdx].items.splice(itemIdx - 1, 0, moved);
                                  applyDraftLive({
                                    ...draft,
                                    id: draft.id === "default" ? "custom-working" : draft.id,
                                    navigation: nextNav,
                                  });
                                }}
                                title="Move tab up"
                              >
                                <ArrowUp size={13} />
                              </button>
                              <button
                                type="button"
                                disabled={itemIdx === group.items.length - 1}
                                onClick={() => {
                                  const nextNav = structuredClone(draft.navigation);
                                  const [moved] = nextNav[groupIdx].items.splice(itemIdx, 1);
                                  nextNav[groupIdx].items.splice(itemIdx + 1, 0, moved);
                                  applyDraftLive({
                                    ...draft,
                                    id: draft.id === "default" ? "custom-working" : draft.id,
                                    navigation: nextNav,
                                  });
                                }}
                                title="Move tab down"
                              >
                                <ArrowDown size={13} />
                              </button>
                              <button
                                type="button"
                                className={item.hidden ? "danger" : ""}
                                onClick={() => {
                                  const nextNav = structuredClone(draft.navigation);
                                  nextNav[groupIdx].items[itemIdx].hidden = !item.hidden;
                                  applyDraftLive({
                                    ...draft,
                                    id: draft.id === "default" ? "custom-working" : draft.id,
                                    navigation: nextNav,
                                  });
                                }}
                                title={item.hidden ? "Show tab" : "Hide tab"}
                              >
                                {item.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === "widgets" && (
              <div className="skin-studio-section">
                <div className="skin-row-between">
                  <div>
                    <h3>Page Object &amp; Widget Grid Composer</h3>
                    <p className="muted">
                      Configure the 12-column grid position, width span (1/3, 1/2, 2/3, Full Width) and visibility of every section block per Console page or Custom Menu Dashboard. Tip: You can also click{" "}
                      <strong>Interactive On-Page Layout Editor</strong> at the top to drag widgets side-by-side or merge them into named groups directly on the page!
                    </p>
                  </div>
                  <label className="skin-page-picker">
                    <span>Select Page or Custom Dashboard</span>
                    <select
                      value={selectedPageForWidgets}
                      onChange={(e) => setSelectedPageForWidgets(e.target.value)}
                    >
                      <optgroup label="Custom Menu Dashboards">
                        {(draft.customPages || []).map((cp) => (
                          <option key={cp.id} value={cp.id}>
                            ★ {cp.title}
                          </option>
                        ))}
                      </optgroup>
                      <optgroup label="Built-in Console Pages">
                        {Object.keys(DEFAULT_PAGE_WIDGET_LAYOUTS).map((pageName) => (
                          <option key={pageName} value={pageName}>
                            {pageName}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </label>
                </div>

                {activePageWidgets && (
                  <div className="skin-field-card">
                    <div className="skin-row-between">
                      <strong>Add Field / Section from any Console Area to this Page</strong>
                      <div className="skin-add-cross-widget-bar">
                        <select
                          aria-label="Select field from console catalog"
                          value={crossWidgetAddId}
                          onChange={(e) => setCrossWidgetAddId(e.target.value)}
                        >
                          <option value="">+ Select any Console Field / Section...</option>
                          {GLOBAL_WIDGET_CATALOG.filter(
                            (entry) => !activePageWidgets.widgets.some((w) => w.id === entry.id)
                          ).map((entry) => (
                            <option key={entry.id} value={entry.id}>
                              [{entry.sourcePage}] {entry.title}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={!crossWidgetAddId}
                          onClick={() => {
                            const entry = GLOBAL_WIDGET_CATALOG.find((e) => e.id === crossWidgetAddId);
                            if (!entry) return;
                            const nextPages = structuredClone(draft.pages);
                            if (!nextPages[selectedPageForWidgets]) {
                              nextPages[selectedPageForWidgets] = {
                                page: selectedPageForWidgets,
                                columns: 12,
                                gap: 16,
                                widgets: [],
                                groups: {},
                              };
                            }
                            nextPages[selectedPageForWidgets].widgets.push({
                              id: entry.id,
                              title: entry.title,
                              span: entry.defaultSpan,
                              hidden: false,
                              sourcePage: entry.sourcePage,
                            });
                            applyDraftLive({
                              ...draft,
                              id: draft.id === "default" ? "custom-working" : draft.id,
                              pages: nextPages,
                            });
                            setCrossWidgetAddId("");
                            notify(`Added "${entry.title}" to ${selectedPageForWidgets}.`);
                          }}
                        >
                          <Plus size={14} /> Add Field to Page
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {activePageWidgets && (
                  <div className="skin-widgets-composer">
                    <div className="skin-widgets-preview-grid">
                      {activePageWidgets.widgets.map((widget, wIdx) => (
                        <div
                          key={widget.id}
                          className={`skin-widget-preview-tile span-${widget.span} ${widget.hidden ? "is-hidden" : ""}`}
                        >
                          <div className="skin-widget-preview-head">
                            <strong>{widget.customTitle || widget.title}</strong>
                            <code>{widget.id}</code>
                          </div>
                          <div className="skin-widget-preview-controls">
                            <label>
                              <span>Width</span>
                              <select
                                value={widget.span}
                                onChange={(e) => {
                                  const nextPages = structuredClone(draft.pages);
                                  nextPages[selectedPageForWidgets].widgets[wIdx].span = Number(
                                    e.target.value
                                  ) as WidgetSpan;
                                  applyDraftLive({
                                    ...draft,
                                    id: draft.id === "default" ? "custom-working" : draft.id,
                                    pages: nextPages,
                                  });
                                }}
                              >
                                <option value={4}>4 cols (1/3 width)</option>
                                <option value={6}>6 cols (1/2 width)</option>
                                <option value={8}>8 cols (2/3 width)</option>
                                <option value={12}>12 cols (Full width)</option>
                              </select>
                            </label>
                            <div className="skin-nav-item-actions">
                              <button
                                type="button"
                                disabled={wIdx === 0}
                                onClick={() => {
                                  const nextPages = structuredClone(draft.pages);
                                  const list = nextPages[selectedPageForWidgets].widgets;
                                  const [moved] = list.splice(wIdx, 1);
                                  list.splice(wIdx - 1, 0, moved);
                                  applyDraftLive({
                                    ...draft,
                                    id: draft.id === "default" ? "custom-working" : draft.id,
                                    pages: nextPages,
                                  });
                                }}
                                title="Move earlier"
                              >
                                <ArrowUp size={14} />
                              </button>
                              <button
                                type="button"
                                disabled={wIdx === activePageWidgets.widgets.length - 1}
                                onClick={() => {
                                  const nextPages = structuredClone(draft.pages);
                                  const list = nextPages[selectedPageForWidgets].widgets;
                                  const [moved] = list.splice(wIdx, 1);
                                  list.splice(wIdx + 1, 0, moved);
                                  applyDraftLive({
                                    ...draft,
                                    id: draft.id === "default" ? "custom-working" : draft.id,
                                    pages: nextPages,
                                  });
                                }}
                                title="Move later"
                              >
                                <ArrowDown size={14} />
                              </button>
                              <button
                                type="button"
                                className={widget.hidden ? "danger" : ""}
                                onClick={() => {
                                  const nextPages = structuredClone(draft.pages);
                                  const target = nextPages[selectedPageForWidgets].widgets[wIdx];
                                  target.hidden = !target.hidden;
                                  applyDraftLive({
                                    ...draft,
                                    id: draft.id === "default" ? "custom-working" : draft.id,
                                    pages: nextPages,
                                  });
                                }}
                                title={widget.hidden ? "Show widget" : "Hide widget"}
                              >
                                {widget.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
