import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { VehicleModule, VehicleRow, VehicleSharedEntry } from "../../api/vehicles";
import { DataTable, type SortDirection } from "../../components/common/DataTable";
import { cachedInstanceNames, resolveInstanceNames } from "../maps/instanceNames";
import { friendlyMapName } from "../maps/mapNames";
import { VehiclePermissionsTab } from "./VehiclePermissionsTab";

const GLOBAL_COLUMNS = ["name", "type", "owner", "shared_with", "condition_percent", "fuel_percent", "location"];
const PLAYER_COLUMNS = ["name", "type", "relationship", "owner", "condition_percent", "fuel_percent", "location"];
const COLUMN_LABELS: Record<string, string> = {
  name: "Vehicle",
  type: "Type",
  relationship: "Access",
  owner: "Owner",
  shared_with: "Shared With",
  condition_percent: "Lowest Condition",
  fuel_percent: "Fuel",
  location: "Location"
};

type VehicleTableProps = {
  rows: VehicleRow[];
  context?: "global" | "player";
  emptyMessage?: string;
  sortColumn?: string;
  sortDirection?: SortDirection;
  onSort?: (column: string) => void;
  canEditPermissions?: boolean;
  onPermissionsSaved?: () => void;
  // A deep-link request from elsewhere (the Live Map's "Open in Vehicles"
  // button) to auto-expand one specific vehicle. focusNonce increments on
  // every request so the same vehicle can be re-focused twice in a row.
  focusVehicleId?: string;
  focusNonce?: number;
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function meterColor(percent: number) {
  if (percent >= 66) return "var(--success)";
  if (percent >= 33) return "var(--warning)";
  return "var(--danger)";
}

function formatObservedValue(value: number) {
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function renderMeter(percent: number | null, { estimated = false, observedValue = null }: { estimated?: boolean; observedValue?: number | null } = {}) {
  if (percent === null) {
    return observedValue === null
      ? <span className="muted">—</span>
      : <span className="vehicles-observed-value" title="Current value is known; maximum capacity is unavailable.">{formatObservedValue(observedValue)} current</span>;
  }
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className="vehicles-meter-cell" title={estimated ? "Estimated from multiple observed vehicles with the same component type." : undefined}>
      <div className="vehicles-meter"><i style={{ width: `${clamped}%`, background: meterColor(clamped) }} /></div>
      <span className="vehicles-meter-pct">{clamped}%{estimated && <em> Estimated</em>}</span>
    </div>
  );
}

function vehiclePartitionMap(map: unknown) {
  const normalized = String(map || "").trim().toLowerCase();
  if (normalized === "haggabasin") return "Survival_1";
  if (normalized === "deepdesert") return "DeepDesert_1";
  return "";
}

function formatMapPartition(row: VehicleRow, instanceNames: Map<string, string>) {
  const rawMap = String(row.map || "").trim();
  const partitionId = String(row.partition_id ?? 0);
  const partitionMap = vehiclePartitionMap(rawMap);
  const instanceName = partitionMap ? instanceNames.get(`${partitionMap}:${partitionId}`) : "";
  return `${friendlyMapName(rawMap)} · ${instanceName || `Partition ${partitionId}`}`;
}

function formatCoords(row: VehicleRow) {
  const x = toNumber(row.x);
  const y = toNumber(row.y);
  return x === null || y === null ? "—" : `(${Math.round(x)}, ${Math.round(y)})`;
}

function mapGridSector(row: VehicleRow): string | null {
  if (!/deepdesert/i.test(String(row.map || ""))) return null;
  const x = toNumber(row.x);
  const y = toNumber(row.y);
  if (x === null || y === null) return null;
  const letter = String.fromCharCode(65 + Math.max(0, Math.min(8, Math.floor((1125000 - y) / 250000))));
  const number = Math.max(0, Math.min(8, Math.floor((x + 1125000) / 250000))) + 1;
  return `${letter}-${number}`;
}

function formatDurability(value: unknown): string {
  const number = toNumber(value);
  return number === null ? "—" : Math.round(number).toLocaleString();
}

function relationshipClass(value: string) {
  return `vehicles-access ${value.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function renderVehicleCell(row: Record<string, unknown>, column: string, instanceNames: Map<string, string>) {
  const vehicle = row as VehicleRow;
  if (column === "name") {
    const rawLocation = `${vehicle.map || "Unknown map"} · Partition ${vehicle.partition_id ?? 0}`;
    return <div className="vehicles-name-cell"><span className="vehicles-name">{vehicle.name || "—"}</span><span className="vehicles-location" title={rawLocation}>{formatMapPartition(vehicle, instanceNames)}</span></div>;
  }
  if (column === "location") {
    const sector = mapGridSector(vehicle);
    const subLine = sector ? `Sector ${sector}` : (vehicle.region ? String(vehicle.region) : null);
    return <div className="vehicles-location-cell"><span className="vehicles-coords">{formatCoords(vehicle)}</span>{subLine && <span className="vehicles-grid">{subLine}</span>}</div>;
  }
  if (column === "type") return vehicle.type ? String(vehicle.type) : <span className="muted">—</span>;
  if (column === "owner") return vehicle.owner ? String(vehicle.owner) : <span className="muted">—</span>;
  if (column === "relationship") {
    const relationship = String(vehicle.relationship || "").trim();
    return relationship ? <span className={relationshipClass(relationship)}>{relationship}</span> : <span className="muted">—</span>;
  }
  if (column === "condition_percent") return renderMeter(toNumber(vehicle.condition_percent), { estimated: vehicle.condition_estimated === true });
  if (column === "fuel_percent") return renderMeter(toNumber(vehicle.fuel_percent), { estimated: vehicle.fuel_percent !== null && vehicle.fuel_percent !== undefined, observedValue: toNumber(vehicle.current_fuel) });
  if (column === "shared_with") {
    const shared: VehicleSharedEntry[] = Array.isArray(vehicle.shared_with) ? vehicle.shared_with : [];
    if (!shared.length) return <span className="muted">—</span>;
    return <span className="vehicles-shared-list">{shared.map((entry) => <span key={`${entry.name}-${entry.rank}`}>{entry.name} <em>({entry.label})</em></span>)}</span>;
  }
  const value = row[column];
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function splitComponentName(name: string): { base: string; position: string | null } {
  const match = /^(.*\S)\s+\((Front|Back|Center) (Left|Right|Center)\)$/.exec(name || "");
  return match ? { base: match[1], position: `${match[2]} ${match[3]}` } : { base: name, position: null };
}

function renderComponent(module: VehicleModule, index: number) {
  const percent = module.conditionPercent;
  const { base, position } = splitComponentName(module.name || "");
  return (
    <div className="vehicles-component-card" key={`${module.templateId}-${index}`}>
      <span className="vehicles-component-name">{base}{position && <span className="vehicles-component-position">{position}</span>}</span>
      {percent === null || percent === undefined
        ? <span className="vehicles-component-meta">{module.condition === null || module.condition === undefined ? "Durability not reported" : `${formatDurability(module.condition)} durability`}</span>
        : <><div className="vehicles-meter"><i style={{ width: `${Math.max(0, Math.min(100, Math.round(percent)))}%`, background: meterColor(percent) }} /></div><span className="vehicles-component-meta">{formatDurability(module.condition)} / {formatDurability(module.maxCondition)} · {Math.round(percent)}%{module.maxInferred ? " Estimated" : ""}</span></>}
    </div>
  );
}

export function VehicleTable({ rows, context = "global", emptyMessage = "No vehicles have been found yet.", sortColumn, sortDirection, onSort, canEditPermissions = false, onPermissionsSaved, focusVehicleId, focusNonce }: VehicleTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedTab, setExpandedTab] = useState<"components" | "permissions">("components");
  const [instanceNames, setInstanceNames] = useState<Map<string, string>>(new Map());
  const expandedContentRef = useRef<HTMLDivElement>(null);
  const satisfiedFocusNonceRef = useRef<number | undefined>(undefined);
  const columns = context === "player" ? PLAYER_COLUMNS : GLOBAL_COLUMNS;
  const partitionMapsKey = [...new Set(rows.map((row) => vehiclePartitionMap(row.map)).filter(Boolean))].sort().join(",");

  useEffect(() => {
    if (expandedId && !rows.some((row) => String(row.id) === expandedId)) {
      setExpandedId(null);
      setExpandedTab("components");
    }
  }, [expandedId, rows]);

  // The caller's search request and this row data arrive on different
  // renders (the id lands in `rows` only once the parent's fetch resolves),
  // so this waits for a matching row instead of setting expandedId eagerly
  // -- which would just get bounced straight back to null by the reset
  // effect above while the old (non-matching) rows are still on screen.
  // satisfiedFocusNonceRef stops a later, unrelated rows refresh (the
  // 15-minute auto-refresh) from re-opening a panel the admin already
  // closed by hand.
  useEffect(() => {
    if (focusNonce === undefined || !focusVehicleId || satisfiedFocusNonceRef.current === focusNonce) return;
    if (!rows.some((row) => String(row.id) === focusVehicleId)) return;
    satisfiedFocusNonceRef.current = focusNonce;
    setExpandedTab("components");
    setExpandedId(focusVehicleId);
  }, [focusNonce, focusVehicleId, rows]);

  // Moves focus into the expanded content so keyboard and screen-reader users
  // land on what they just opened instead of staying on the (now possibly
  // relocated) expand button. Fires only on an actual expandedId change --
  // not on every render -- so a background row refresh never yanks focus
  // away from a control the user is mid-interaction with.
  useEffect(() => {
    // preventScroll: a row expanding near the bottom of the viewport
    // otherwise triggers the browser's default scroll-into-view on focus,
    // which yanks the page out from under a mouse user who just clicked a
    // row in place (confirmed live: a 147px jump). Keyboard/screen-reader
    // users still get the focus move itself, which is what they need --
    // browsers already keep a newly focused element approximately in view
    // when it was reached via Tab or a same-page click, since both already
    // scrolled the row into view before it expanded. The Live Map's "Open
    // in Vehicles" deep link (focusVehicleId below) also lands here after
    // switching tabs and narrowing the search to one row, which puts it at
    // the top of the page already -- same "already in view" outcome.
    if (expandedId) expandedContentRef.current?.focus({ preventScroll: true });
  }, [expandedId]);

  useEffect(() => {
    const maps = partitionMapsKey ? partitionMapsKey.split(",") : [];
    if (!maps.length) return undefined;
    const cached = cachedInstanceNames(maps);
    if (cached) {
      setInstanceNames(cached);
      return undefined;
    }
    let cancelled = false;
    void resolveInstanceNames(maps).then((resolved) => {
      if (!cancelled && resolved) setInstanceNames(resolved);
    });
    return () => { cancelled = true; };
  }, [partitionMapsKey]);

  function toggleExpanded(id: string) {
    // A different vehicle's expansion should never inherit the previous one's
    // tab -- landing on Permissions for a vehicle that was never showing it
    // would look like a stale/wrong panel.
    setExpandedTab("components");
    setExpandedId((current) => current === id ? null : id);
  }

  return (
    <DataTable
      rows={rows}
      columns={columns}
      columnLabels={COLUMN_LABELS}
      tableClassName={`vehicles-table${context === "player" ? " player-vehicles-table" : ""}`}
      wrapClassName="vehicles-table-wrap"
      headerTitles
      renderCell={(row, column) => renderVehicleCell(row, column, instanceNames)}
      nonSortableColumns={["shared_with", "location"]}
      sortColumn={sortColumn}
      sortDirection={sortDirection}
      onSort={onSort}
      secondaryActionPosition="start"
      secondaryActionLabel=""
      secondaryActionClassName="vehicles-expand-column"
      secondaryAction={(row) => {
        const vehicle = row as VehicleRow;
        const id = String(vehicle.id);
        const isExpanded = expandedId === id;
        const label = `${isExpanded ? "Collapse" : "Show"} components for ${vehicle.name || `vehicle ${id}`}`;
        return <button className="vehicles-expand-button" title={label} aria-label={label} aria-expanded={isExpanded} onClick={(event) => { event.stopPropagation(); toggleExpanded(id); }}>{isExpanded ? <ChevronUp size={14} className="vehicles-expand-chevron" /> : <ChevronDown size={14} className="vehicles-expand-chevron" />}</button>;
      }}
      rowKey={(row) => String((row as VehicleRow).id)}
      onRowClick={(row) => toggleExpanded(String((row as VehicleRow).id))}
      isRowExpanded={(row) => expandedId === String((row as VehicleRow).id)}
      renderExpandedRow={(row) => {
        const vehicle = row as VehicleRow;
        const id = String(vehicle.id);
        const modules: VehicleModule[] = Array.isArray(vehicle.modules) ? vehicle.modules : [];
        const componentsPanel = <div className="vehicles-expanded">
          <p className="vehicles-expanded-header">{modules.length} component{modules.length === 1 ? "" : "s"}</p>
          {modules.length === 0 ? <p className="muted">No components fitted.</p> : <div className="vehicles-component-grid">{modules.map(renderComponent)}</div>}
        </div>;
        // tabIndex=-1 makes this programmatically focusable (see the
        // expandedId effect above) without adding it to the normal Tab
        // order -- it is a landing point, not a control.
        if (!canEditPermissions) return <div ref={expandedContentRef} tabIndex={-1}>{componentsPanel}</div>;
        return (
          <div ref={expandedContentRef} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
            <div className="vehicles-expanded-tablist" role="tablist">
              <button
                role="tab"
                id={`vehicles-tab-components-${id}`}
                aria-selected={expandedTab === "components"}
                aria-controls={`vehicles-panel-components-${id}`}
                className={`vehicles-expanded-tab${expandedTab === "components" ? " active" : ""}`}
                onClick={() => setExpandedTab("components")}
              >Components</button>
              <button
                role="tab"
                id={`vehicles-tab-permissions-${id}`}
                aria-selected={expandedTab === "permissions"}
                aria-controls={`vehicles-panel-permissions-${id}`}
                className={`vehicles-expanded-tab${expandedTab === "permissions" ? " active" : ""}`}
                onClick={() => setExpandedTab("permissions")}
              >Permissions</button>
            </div>
            {expandedTab === "components"
              ? <div role="tabpanel" id={`vehicles-panel-components-${id}`} aria-labelledby={`vehicles-tab-components-${id}`}>{componentsPanel}</div>
              : <div role="tabpanel" id={`vehicles-panel-permissions-${id}`} aria-labelledby={`vehicles-tab-permissions-${id}`}>
                  <VehiclePermissionsTab
                    vehicleId={id}
                    vehicleName={String(vehicle.name || `vehicle ${id}`)}
                    onSaved={() => onPermissionsSaved?.()}
                  />
                </div>}
          </div>
        );
      }}
      emptyMessage={emptyMessage}
    />
  );
}
