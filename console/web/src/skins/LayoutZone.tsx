import { createContext, useContext, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Columns,
  Eye,
  EyeOff,
  FolderPlus,
  GripVertical,
  Layers,
  Plus,
  RotateCcw,
  Trash2,
  Ungroup,
} from "lucide-react";
import { DEFAULT_PAGE_WIDGET_LAYOUTS, GLOBAL_WIDGET_CATALOG } from "./skinDefaults";
import { updatePageWidgetLayout } from "./skinEngine";
import type { PageWidgetLayoutConfig, WidgetGroupConfig, WidgetInstanceConfig, WidgetSpan } from "./skinTypes";
import { useSkinConfig } from "./useSkinConfig";

export type DropIntent = "side-left" | "side-right" | "group-center" | "reorder-top" | "reorder-bottom";

interface ActiveDragHover {
  targetId: string;
  intent: DropIntent;
}

interface PendingGroupModalState {
  sourceId: string;
  targetId: string;
  existingGroupId?: string;
  defaultName: string;
}

interface LayoutZoneContextValue {
  page: string;
  editMode: boolean;
  isCustomSkin: boolean;
  widgetsById: Map<string, WidgetInstanceConfig>;
  groupsById: Record<string, WidgetGroupConfig>;
  orderIndexById: Map<string, number>;
  totalWidgets: number;
  draggedId: string | null;
  setDraggedId: (id: string | null) => void;
  activeHover: ActiveDragHover | null;
  setActiveHover: (hover: ActiveDragHover | null) => void;
  moveWidget: (id: string, direction: -1 | 1) => void;
  handleDropIntent: (sourceId: string, targetId: string, intent: DropIntent) => void;
  setWidgetSpan: (id: string, span: WidgetSpan) => void;
  toggleWidgetHidden: (id: string) => void;
  toggleWidgetCollapsed: (id: string) => void;
  removeWidgetFromGroup: (id: string) => void;
  renameGroup: (groupId: string, title: string) => void;
  dissolveGroup: (groupId: string) => void;
  removeCrossPageWidget: (id: string) => void;
}

const LayoutZoneContext = createContext<LayoutZoneContextValue | null>(null);
export const CrossPageWidgetRendererContext = createContext<((widget: WidgetInstanceConfig) => ReactNode) | null>(null);

const SPAN_OPTIONS: { value: WidgetSpan; text: string }[] = [
  { value: 4, text: "1/3" },
  { value: 6, text: "1/2" },
  { value: 8, text: "2/3" },
  { value: 12, text: "Full" },
];

export function computeSideBySidePreviewSpan(
  widgetId: string,
  actualSpan: WidgetSpan,
  draggedId: string | null,
  activeHover: ActiveDragHover | null
): { previewSpan: WidgetSpan; previewOrderOffset: number; isSidePreview: boolean } {
  if (!draggedId || !activeHover || draggedId === activeHover.targetId) {
    return { previewSpan: actualSpan, previewOrderOffset: 0, isSidePreview: false };
  }
  const { targetId, intent } = activeHover;
  if (intent !== "side-left" && intent !== "side-right") {
    return { previewSpan: actualSpan, previewOrderOffset: 0, isSidePreview: false };
  }
  if (widgetId === targetId) {
    const shrunkSpan: WidgetSpan = actualSpan > 6 ? 6 : actualSpan;
    return { previewSpan: shrunkSpan, previewOrderOffset: 0, isSidePreview: true };
  }
  if (widgetId === draggedId) {
    const shrunkSpan: WidgetSpan = actualSpan > 6 ? 6 : actualSpan;
    return {
      previewSpan: shrunkSpan,
      previewOrderOffset: intent === "side-left" ? -0.5 : 0.5,
      isSidePreview: true,
    };
  }
  return { previewSpan: actualSpan, previewOrderOffset: 0, isSidePreview: false };
}

export function detectDropIntentFromPoint(
  clientX: number,
  clientY: number,
  rect: DOMRect
): DropIntent {
  const relX = (clientX - rect.left) / Math.max(1, rect.width);
  const relY = (clientY - rect.top) / Math.max(1, rect.height);

  // Left 26% edge -> place side-by-side on the left
  if (relX < 0.26) return "side-left";
  // Right 26% edge -> place side-by-side on the right
  if (relX > 0.74) return "side-right";
  // Center box (middle 48% horizontally and middle 50% vertically) -> group / merge into container!
  if (relY >= 0.24 && relY <= 0.76) return "group-center";
  // Top / Bottom bands -> vertical reorder
  return relY < 0.24 ? "reorder-top" : "reorder-bottom";
}

export function LayoutZone({
  page,
  className = "",
  ariaLabelledBy,
  renderCrossPageWidget,
  children,
}: {
  page: string;
  className?: string;
  ariaLabelledBy?: string;
  renderCrossPageWidget?: (widget: WidgetInstanceConfig) => ReactNode;
  children: ReactNode;
}) {
  const [skin, editMode] = useSkinConfig();
  const contextCrossPageRenderer = useContext(CrossPageWidgetRendererContext);
  const effectiveCrossPageRenderer = renderCrossPageWidget || contextCrossPageRenderer;
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [activeHover, setActiveHover] = useState<ActiveDragHover | null>(null);
  const [pendingGroup, setPendingGroup] = useState<PendingGroupModalState | null>(null);
  const [groupTitleInput, setGroupTitleInput] = useState<string>("");
  const [addWidgetPickerId, setAddWidgetPickerId] = useState<string>("");

  const pageConfig: PageWidgetLayoutConfig = skin.pages[page] || DEFAULT_PAGE_WIDGET_LAYOUTS[page] || {
    page,
    columns: 12,
    gap: 16,
    widgets: [],
    groups: {},
  };
  const isCustomDashboardPage = page.startsWith("custom:");
  const isCustomSkin = skin.id !== "default" || editMode || isCustomDashboardPage;

  const widgetsById = new Map(pageConfig.widgets.map((w) => [w.id, w]));
  const groupsById = pageConfig.groups || {};
  const orderIndexById = new Map(pageConfig.widgets.map((w, idx) => [w.id, idx]));

  const defaultNativeIds = new Set(
    (DEFAULT_PAGE_WIDGET_LAYOUTS[page]?.widgets || []).map((w) => w.id)
  );
  const extraWidgets = isCustomDashboardPage
    ? []
    : pageConfig.widgets.filter((w) => !defaultNativeIds.has(w.id));

  function moveWidget(id: string, direction: -1 | 1) {
    updatePageWidgetLayout(page, (current) => {
      const idx = current.widgets.findIndex((w) => w.id === id);
      if (idx < 0) return current;
      const targetIdx = idx + direction;
      if (targetIdx < 0 || targetIdx >= current.widgets.length) return current;
      const next = [...current.widgets];
      const [item] = next.splice(idx, 1);
      next.splice(targetIdx, 0, item);
      return { ...current, widgets: next };
    });
  }

  function handleDropIntent(sourceId: string, targetId: string, intent: DropIntent) {
    if (!sourceId || !targetId || sourceId === targetId) return;

    if (intent === "group-center") {
      const sourceW = widgetsById.get(sourceId);
      const targetW = widgetsById.get(targetId);
      const existingGroupId = targetW?.groupId || sourceW?.groupId;
      const existingGroup = existingGroupId ? groupsById[existingGroupId] : undefined;
      const suggestedName =
        existingGroup?.title ||
        `${targetW?.customTitle || targetW?.title || "Section"} & ${sourceW?.customTitle || sourceW?.title || "Section"}`;
      setGroupTitleInput(suggestedName);
      setPendingGroup({
        sourceId,
        targetId,
        existingGroupId,
        defaultName: suggestedName,
      });
      return;
    }

    updatePageWidgetLayout(page, (current) => {
      const fromIdx = current.widgets.findIndex((w) => w.id === sourceId);
      const toIdx = current.widgets.findIndex((w) => w.id === targetId);
      if (fromIdx < 0 || toIdx < 0) return current;

      const next = structuredClone(current.widgets);
      const sourceItem = next[fromIdx];
      const targetItem = next[toIdx];

      if (intent === "side-left" || intent === "side-right") {
        // Automatically adjust both widgets so they fit side by side (6 cols + 6 cols if either was wider)
        if (sourceItem.span + targetItem.span > 12) {
          sourceItem.span = 6;
          targetItem.span = 6;
        }
        // Adopt target's group if target is inside a group
        sourceItem.groupId = targetItem.groupId;
      }

      const [moved] = next.splice(fromIdx, 1);
      const newTargetIdx = next.findIndex((w) => w.id === targetId);
      const insertAt =
        intent === "side-left" || intent === "reorder-top" ? newTargetIdx : newTargetIdx + 1;
      next.splice(Math.max(0, insertAt), 0, moved);
      return { ...current, widgets: next };
    });
  }

  function confirmCreateOrJoinGroup() {
    if (!pendingGroup) return;
    const { sourceId, targetId, existingGroupId, defaultName } = pendingGroup;
    const resolvedGroupName = groupTitleInput.trim() || defaultName || String("Widget Group");
    const groupId = existingGroupId || `grp-${Date.now()}`;

    updatePageWidgetLayout(page, (current) => {
      const nextGroups = { ...(current.groups || {}) };
      nextGroups[groupId] = {
        id: groupId,
        title: resolvedGroupName,
        collapsed: false,
      };

      const fromIdx = current.widgets.findIndex((w) => w.id === sourceId);
      const toIdx = current.widgets.findIndex((w) => w.id === targetId);
      if (fromIdx < 0 || toIdx < 0) return current;

      const nextWidgets = structuredClone(current.widgets);
      nextWidgets[fromIdx].groupId = groupId;
      nextWidgets[toIdx].groupId = groupId;
      // Size both to 6 columns if they were full width so they sit nicely inside the group
      if (nextWidgets[fromIdx].span === 12 && nextWidgets[toIdx].span === 12) {
        nextWidgets[fromIdx].span = 6;
        nextWidgets[toIdx].span = 6;
      }

      const [moved] = nextWidgets.splice(fromIdx, 1);
      const newTargetIdx = nextWidgets.findIndex((w) => w.id === targetId);
      nextWidgets.splice(newTargetIdx + 1, 0, moved);

      return {
        ...current,
        widgets: nextWidgets,
        groups: nextGroups,
      };
    });

    setPendingGroup(null);
  }

  function removeWidgetFromGroup(id: string) {
    updatePageWidgetLayout(page, (current) => ({
      ...current,
      widgets: current.widgets.map((w) => (w.id === id ? { ...w, groupId: undefined } : w)),
    }));
  }

  function renameGroup(groupId: string, title: string) {
    updatePageWidgetLayout(page, (current) => {
      const nextGroups = { ...(current.groups || {}) };
      if (!nextGroups[groupId]) return current;
      nextGroups[groupId] = { ...nextGroups[groupId], title };
      return { ...current, groups: nextGroups };
    });
  }

  function dissolveGroup(groupId: string) {
    updatePageWidgetLayout(page, (current) => {
      const nextGroups = { ...(current.groups || {}) };
      delete nextGroups[groupId];
      return {
        ...current,
        groups: nextGroups,
        widgets: current.widgets.map((w) => (w.groupId === groupId ? { ...w, groupId: undefined } : w)),
      };
    });
  }

  function setWidgetSpan(id: string, span: WidgetSpan) {
    updatePageWidgetLayout(page, (current) => ({
      ...current,
      widgets: current.widgets.map((w) => (w.id === id ? { ...w, span } : w)),
    }));
  }

  function toggleWidgetHidden(id: string) {
    updatePageWidgetLayout(page, (current) => ({
      ...current,
      widgets: current.widgets.map((w) => (w.id === id ? { ...w, hidden: !w.hidden } : w)),
    }));
  }

  function toggleWidgetCollapsed(id: string) {
    updatePageWidgetLayout(page, (current) => ({
      ...current,
      widgets: current.widgets.map((w) => (w.id === id ? { ...w, collapsed: !w.collapsed } : w)),
    }));
  }

  function addCrossPageWidget(widgetId: string) {
    const entry = GLOBAL_WIDGET_CATALOG.find((w) => w.id === widgetId);
    if (!entry) return;
    updatePageWidgetLayout(page, (current) => {
      if (current.widgets.some((w) => w.id === entry.id)) return current;
      return {
        ...current,
        widgets: [
          ...current.widgets,
          {
            id: entry.id,
            title: entry.title,
            span: entry.defaultSpan,
            hidden: false,
            sourcePage: entry.sourcePage,
          },
        ],
      };
    });
    setAddWidgetPickerId("");
  }

  function removeCrossPageWidget(id: string) {
    updatePageWidgetLayout(page, (current) => ({
      ...current,
      widgets: current.widgets.filter((w) => w.id !== id),
    }));
  }

  function resetPageLayout() {
    const defaultPage = DEFAULT_PAGE_WIDGET_LAYOUTS[page];
    if (!defaultPage) {
      updatePageWidgetLayout(page, (current) => ({ ...current, widgets: [], groups: {} }));
      return;
    }
    updatePageWidgetLayout(page, () => structuredClone(defaultPage));
  }

  const hiddenCount = pageConfig.widgets.filter((w) => w.hidden).length;
  const availableCrossPageCatalog = GLOBAL_WIDGET_CATALOG.filter((w) => !widgetsById.has(w.id));
  const activeGroupsList = Object.values(groupsById).filter((g) =>
    pageConfig.widgets.some((w) => w.groupId === g.id)
  );

  return (
    <LayoutZoneContext.Provider
      value={{
        page,
        editMode,
        isCustomSkin,
        widgetsById,
        groupsById,
        orderIndexById,
        totalWidgets: pageConfig.widgets.length,
        draggedId,
        setDraggedId,
        activeHover,
        setActiveHover,
        moveWidget,
        handleDropIntent,
        setWidgetSpan,
        toggleWidgetHidden,
        toggleWidgetCollapsed,
        removeWidgetFromGroup,
        renameGroup,
        dissolveGroup,
        removeCrossPageWidget,
      }}
    >
      {editMode && (
        <div className="skin-layout-zone-banner" role="region" aria-label={`${page} layout editor controls`} data-no-translate>
          <div className="skin-layout-zone-banner-info">
            <Columns size={16} aria-hidden="true" />
            <strong>Layout Edit Mode: {page}</strong>
            <span>
              Drag a block to the <strong>left/right edge</strong> of another block to preview &amp; place them side-by-side, or drop into the <strong>center</strong> to merge them into a named group!
            </span>
          </div>
          <div className="skin-layout-zone-banner-actions">
            {!isCustomDashboardPage && availableCrossPageCatalog.length > 0 && (
              <div className="skin-add-cross-widget-bar">
                <select
                  aria-label="Add widget from another console section"
                  value={addWidgetPickerId}
                  onChange={(e) => setAddWidgetPickerId(e.target.value)}
                >
                  <option value="">+ Add Widget from any Section...</option>
                  {availableCrossPageCatalog.map((item) => (
                    <option key={item.id} value={item.id}>
                      [{item.sourcePage}] {item.title}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!addWidgetPickerId}
                  onClick={() => addCrossPageWidget(addWidgetPickerId)}
                >
                  <Plus size={14} /> Add Here
                </button>
              </div>
            )}
            {hiddenCount > 0 && <span className="skin-hidden-pill">{hiddenCount} hidden</span>}
            <button type="button" onClick={resetPageLayout} title={`Reset ${page} widget layout to defaults`}>
              <RotateCcw size={14} aria-hidden="true" /> Reset {page} Layout
            </button>
          </div>
        </div>
      )}

      {activeGroupsList.length > 0 && editMode && (
        <div className="skin-active-groups-bar" aria-label="Active widget groups on this page" data-no-translate>
          {activeGroupsList.map((grp) => (
            <div key={grp.id} className="skin-active-group-chip">
              <Layers size={14} aria-hidden="true" />
              <input
                type="text"
                aria-label="Group name"
                value={grp.title}
                onChange={(e) => renameGroup(grp.id, e.target.value)}
              />
              <button
                type="button"
                className="danger"
                title="Ungroup all widgets in this group"
                onClick={() => dissolveGroup(grp.id)}
              >
                <Ungroup size={13} /> Ungroup
              </button>
            </div>
          ))}
        </div>
      )}

      {pendingGroup && (
        <div
          className="modal-overlay skin-group-prompt-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="skin-create-group-title"
          data-no-translate
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPendingGroup(null);
          }}
        >
          <div className="confirm-modal skin-group-prompt-modal">
            <div className="confirm-modal-title">
              <h3 id="skin-create-group-title">
                <FolderPlus size={18} style={{ verticalAlign: "-3px", marginRight: 8 }} />
                {pendingGroup.existingGroupId ? "Add Widget to Group" : "Create Widget Group"}
              </h3>
            </div>
            <p>
              Combine these blocks into a shared group container and give the group a custom heading:
            </p>
            <label>
              <span>Group Name</span>
              <input
                type="text"
                autoFocus
                value={groupTitleInput}
                onChange={(e) => setGroupTitleInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirmCreateOrJoinGroup();
                  if (e.key === "Escape") setPendingGroup(null);
                }}
                placeholder="e.g. Server Telemetry & Health"
              />
            </label>
            <div className="confirm-modal-actions">
              <button type="button" onClick={() => setPendingGroup(null)}>
                Cancel
              </button>
              <button type="button" className="active" onClick={confirmCreateOrJoinGroup}>
                Create &amp; Name Group
              </button>
            </div>
          </div>
        </div>
      )}

      <section
        className={`${className}${isCustomSkin ? " skin-widget-grid" : ""}${editMode ? " skin-widget-grid-editing" : ""}`.trim()}
        aria-labelledby={ariaLabelledBy}
        style={isCustomSkin ? ({ "--skin-page-gap": `${pageConfig.gap}px` } as React.CSSProperties) : undefined}
      >
        {children}
        {effectiveCrossPageRenderer &&
          extraWidgets.map((w) => (
            <LayoutWidget key={w.id} id={w.id} widgetTitle={w.title}>
              {effectiveCrossPageRenderer(w)}
            </LayoutWidget>
          ))}
      </section>
    </LayoutZoneContext.Provider>
  );
}

export function LayoutWidget({
  id,
  widgetTitle,
  title,
  children,
}: {
  id: string;
  widgetTitle?: string;
  title?: string;
  children: ReactNode;
}) {
  const ctx = useContext(LayoutZoneContext);
  const resolvedTitle = widgetTitle || title || id;

  // If no LayoutZone or completely default skin without editMode, render children transparently!
  if (!ctx || (!ctx.isCustomSkin && !ctx.editMode)) {
    return <>{children}</>;
  }

  const config = ctx.widgetsById.get(id) || {
    id,
    title: resolvedTitle,
    span: 12 as WidgetSpan,
    hidden: false,
    collapsed: false,
  };
  const baseOrder = ctx.orderIndexById.get(id) ?? 0;

  if (config.hidden && !ctx.editMode) {
    return null;
  }

  const { previewSpan, previewOrderOffset, isSidePreview } = computeSideBySidePreviewSpan(
    id,
    config.span,
    ctx.draggedId,
    ctx.activeHover
  );

  const isHoverTarget = ctx.activeHover?.targetId === id && ctx.draggedId !== id;
  const hoverIntent = isHoverTarget ? ctx.activeHover?.intent : null;
  const groupInfo = config.groupId ? ctx.groupsById[config.groupId] : undefined;
  const displayTitle = config.customTitle || config.title || resolvedTitle;
  const isCrossPageExtra = Boolean(config.sourcePage && config.sourcePage !== ctx.page && !ctx.page.startsWith("custom:"));

  // Convert fractional previewOrderOffset (-0.5 / +0.5) into integer CSS order by multiplying baseOrder by 10
  const effectiveOrder = Math.round(baseOrder * 10 + previewOrderOffset * 10);

  return (
    <div
      className={`skin-widget-slot span-${previewSpan}${config.hidden ? " is-hidden" : ""}${config.collapsed ? " is-collapsed" : ""}${isSidePreview ? " is-side-by-side-preview" : ""}${hoverIntent ? ` drop-intent-${hoverIntent}` : ""}${groupInfo ? " is-grouped-widget" : ""}`}
      data-widget-id={id}
      data-group-id={groupInfo?.id}
      style={{ order: effectiveOrder }}
      draggable={ctx.editMode}
      onDragStart={(event) => {
        if (!ctx.editMode) return;
        event.stopPropagation();
        ctx.setDraggedId(id);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", id);
      }}
      onDragEnd={() => {
        ctx.setDraggedId(null);
        ctx.setActiveHover(null);
      }}
      onDragOver={(event) => {
        if (!ctx.editMode) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        if (ctx.draggedId === id) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const intent = detectDropIntentFromPoint(event.clientX, event.clientY, rect);
        if (ctx.activeHover?.targetId !== id || ctx.activeHover?.intent !== intent) {
          ctx.setActiveHover({ targetId: id, intent });
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          if (ctx.activeHover?.targetId === id) {
            ctx.setActiveHover(null);
          }
        }
      }}
      onDrop={(event) => {
        if (!ctx.editMode) return;
        event.preventDefault();
        event.stopPropagation();
        const sourceId = ctx.draggedId || event.dataTransfer.getData("text/plain");
        const rect = event.currentTarget.getBoundingClientRect();
        const intent = ctx.activeHover?.intent || detectDropIntentFromPoint(event.clientX, event.clientY, rect);
        ctx.setActiveHover(null);
        ctx.setDraggedId(null);
        if (sourceId && sourceId !== id) {
          ctx.handleDropIntent(sourceId, id, intent);
        }
      }}
    >
      {groupInfo && (
        <div className="skin-widget-group-badge" data-no-translate>
          <Layers size={13} aria-hidden="true" />
          <strong>{groupInfo.title}</strong>
          {ctx.editMode && (
            <button
              type="button"
              onClick={() => ctx.removeWidgetFromGroup(id)}
              title="Remove this widget from the group"
            >
              <Ungroup size={12} /> Leave Group
            </button>
          )}
        </div>
      )}

      {ctx.editMode && isHoverTarget && (
        <div className={`skin-drop-intent-indicator intent-${hoverIntent}`} aria-live="polite" data-no-translate>
          {hoverIntent === "side-left" && (
            <span>⇤ Dock Side-by-Side (Left of {displayTitle}) — Both auto-fit to 1/2 width</span>
          )}
          {hoverIntent === "side-right" && (
            <span>⇥ Dock Side-by-Side (Right of {displayTitle}) — Both auto-fit to 1/2 width</span>
          )}
          {hoverIntent === "group-center" && (
            <span>⊕ Drop in Center to Create / Join Named Group with "{displayTitle}"</span>
          )}
          {hoverIntent === "reorder-top" && <span>↑ Place Above {displayTitle}</span>}
          {hoverIntent === "reorder-bottom" && <span>↓ Place Below {displayTitle}</span>}
        </div>
      )}

      {ctx.editMode && (
        <div className="skin-widget-toolbar" aria-label={`${displayTitle} layout controls`} data-no-translate>
          <div className="skin-widget-toolbar-title">
            <GripVertical size={15} className="skin-widget-drag-handle" aria-hidden="true" />
            <strong>{displayTitle}</strong>
            <code>{id}</code>
          </div>
          <div className="skin-widget-toolbar-controls">
            <div className="skin-widget-span-group" role="group" aria-label="Column width">
              {SPAN_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={config.span === opt.value ? "active" : ""}
                  onClick={() => ctx.setWidgetSpan(id, opt.value)}
                  title={`Set width to ${opt.text}`}
                >
                  {opt.text}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => ctx.moveWidget(id, -1)}
              disabled={baseOrder <= 0}
              title="Move widget up / earlier"
              aria-label={`Move ${displayTitle} earlier`}
            >
              <ArrowUp size={14} />
            </button>
            <button
              type="button"
              onClick={() => ctx.moveWidget(id, 1)}
              disabled={baseOrder >= ctx.totalWidgets - 1}
              title="Move widget down / later"
              aria-label={`Move ${displayTitle} later`}
            >
              <ArrowDown size={14} />
            </button>
            <button
              type="button"
              onClick={() => ctx.toggleWidgetCollapsed(id)}
              title={config.collapsed ? "Expand widget content" : "Collapse widget content"}
              aria-label={config.collapsed ? `Expand ${displayTitle}` : `Collapse ${displayTitle}`}
            >
              {config.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </button>
            <button
              type="button"
              className={config.hidden ? "danger" : ""}
              onClick={() => ctx.toggleWidgetHidden(id)}
              title={config.hidden ? "Show widget" : "Hide widget"}
              aria-label={config.hidden ? `Show ${displayTitle}` : `Hide ${displayTitle}`}
            >
              {config.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            {(ctx.page.startsWith("custom:") || isCrossPageExtra) && (
              <button
                type="button"
                className="danger"
                onClick={() => ctx.removeCrossPageWidget(id)}
                title="Remove widget from this dashboard"
                aria-label={`Remove ${displayTitle}`}
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </div>
      )}
      {!ctx.editMode && config.collapsed ? (
        <div className="panel skin-widget-collapsed-bar" data-no-translate>
          <strong>{displayTitle}</strong>
          <button type="button" onClick={() => ctx.toggleWidgetCollapsed(id)}>
            <ChevronRight size={14} /> Expand Section
          </button>
        </div>
      ) : (
        <div className="skin-widget-body">{children}</div>
      )}
    </div>
  );
}
