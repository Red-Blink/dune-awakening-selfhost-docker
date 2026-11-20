import { useState, type ReactNode } from "react";
import { Columns, LayoutDashboard, Plus } from "lucide-react";
import { GLOBAL_WIDGET_CATALOG } from "./skinDefaults";
import { updatePageWidgetLayout } from "./skinEngine";
import type { CustomDashboardPageConfig, WidgetInstanceConfig } from "./skinTypes";
import { LayoutWidget, LayoutZone } from "./LayoutZone";
import { useSkinConfig } from "./useSkinConfig";

export function CustomDashboardView({
  dashboard,
  renderSourceWidget,
}: {
  dashboard: CustomDashboardPageConfig;
  renderSourceWidget: (widget: WidgetInstanceConfig) => ReactNode;
}) {
  const [skin, editMode, setEditMode] = useSkinConfig();
  const [selectedWidgetId, setSelectedWidgetId] = useState<string>("");
  const pageLayout = skin.pages[dashboard.id] || {
    page: dashboard.id,
    columns: 12,
    gap: 16,
    widgets: [],
    groups: {},
  };

  const addedIds = new Set(pageLayout.widgets.map((w) => w.id));
  const availableCatalog = GLOBAL_WIDGET_CATALOG.filter((item) => !addedIds.has(item.id));

  function addSelectedWidget() {
    const entry = GLOBAL_WIDGET_CATALOG.find((item) => item.id === selectedWidgetId);
    if (!entry) return;
    updatePageWidgetLayout(dashboard.id, (current) => {
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
    setSelectedWidgetId("");
  }

  return (
    <div className="skin-custom-dashboard-page" data-no-translate>
      <div className="panel skin-custom-dashboard-toolbar">
        <div className="skin-custom-dashboard-toolbar-title">
          <LayoutDashboard size={18} aria-hidden="true" />
          <div>
            <strong>{dashboard.title}</strong>
            <span>{dashboard.subtitle}</span>
          </div>
        </div>
        <div className="skin-custom-dashboard-toolbar-controls">
          {availableCatalog.length > 0 && (
            <div className="skin-add-cross-widget-bar">
              <select
                aria-label="Add widget from any console section"
                value={selectedWidgetId}
                onChange={(e) => setSelectedWidgetId(e.target.value)}
              >
                <option value="">+ Add Section / Field from Console...</option>
                {availableCatalog.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    [{entry.sourcePage}] {entry.title}
                  </option>
                ))}
              </select>
              <button type="button" disabled={!selectedWidgetId} onClick={addSelectedWidget}>
                <Plus size={14} /> Add to Dashboard
              </button>
            </div>
          )}
          <button
            type="button"
            className={editMode ? "active" : ""}
            onClick={() => setEditMode(!editMode)}
          >
            <Columns size={14} />
            <span>{editMode ? "Finish Arranging" : "Arrange & Group Widgets"}</span>
          </button>
        </div>
      </div>

      {pageLayout.widgets.length === 0 ? (
        <section className="panel skin-custom-dashboard-empty">
          <LayoutDashboard size={32} aria-hidden="true" />
          <h3>Your Custom Dashboard "{dashboard.title}" is Empty</h3>
          <p className="muted">
            Choose any module or section from across the Console above (for example <strong>Battlegroup Status</strong>,{" "}
            <strong>Host Performance</strong>, <strong>Players Directory</strong>, <strong>Live Map</strong>,{" "}
            <strong>Server Controls</strong>, <strong>Backups</strong>, or <strong>Database Browser</strong>) to assemble your tailored command view.
          </p>
        </section>
      ) : (
        <LayoutZone page={dashboard.id} className="grid custom-dashboard-grid">
          {pageLayout.widgets.map((widget) => (
            <LayoutWidget key={widget.id} id={widget.id} title={widget.title}>
              {renderSourceWidget(widget)}
            </LayoutWidget>
          ))}
        </LayoutZone>
      )}
    </div>
  );
}
