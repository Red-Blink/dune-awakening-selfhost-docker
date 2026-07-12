import { Fragment, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { formatCell, friendlyColumnName } from "../../lib/display";

export type SortDirection = "asc" | "desc";
type SortState = { column: string; direction: SortDirection };

export function compareTableValues(a: unknown, b: unknown, direction: SortDirection) {
  const aNum = Number(a);
  const bNum = Number(b);
  const bothNumeric = a !== null && a !== undefined && a !== "" && b !== null && b !== undefined && b !== "" && !Number.isNaN(aNum) && !Number.isNaN(bNum);
  const result = bothNumeric ? aNum - bNum : String(a ?? "").localeCompare(String(b ?? ""), undefined, { sensitivity: "base" });
  return direction === "asc" ? result : -result;
}

export function useSortState() {
  const [sort, setSort] = useState<SortState | null>(null);
  function onSort(column: string) {
    setSort((current) => (current?.column === column ? { column, direction: current.direction === "asc" ? "desc" : "asc" } : { column, direction: "asc" }));
  }
  return { sortColumn: sort?.column, sortDirection: sort?.direction, onSort, reset: () => setSort(null) };
}

export function useSortableRows<T extends Record<string, unknown>>(rows: T[]) {
  const sortState = useSortState();
  const sortedRows = sortState.sortColumn ? [...rows].sort((a, b) => compareTableValues(a[sortState.sortColumn!], b[sortState.sortColumn!], sortState.sortDirection!)) : rows;
  return { ...sortState, sortedRows };
}

const MIN_COLUMN_WIDTH = 60;

export function useResizableColumns(enabled = true) {
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  const resizeState = useRef<{ column: string; startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    function onMouseMove(event: MouseEvent) {
      const state = resizeState.current;
      if (!state) return;
      const width = Math.max(MIN_COLUMN_WIDTH, state.startWidth + (event.clientX - state.startX));
      setColWidths((current) => ({ ...current, [state.column]: width }));
    }
    function onMouseUp() {
      if (!resizeState.current) return;
      resizeState.current = null;
      document.body.classList.remove("col-resizing");
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [enabled]);

  function startResize(event: ReactMouseEvent<HTMLSpanElement>, column: string) {
    event.preventDefault();
    event.stopPropagation();
    const th = event.currentTarget.parentElement as HTMLTableCellElement;
    resizeState.current = { column, startX: event.clientX, startWidth: th.offsetWidth };
    document.body.classList.add("col-resizing");
  }

  function columnStyle(column: string) {
    return colWidths[column] ? { width: colWidths[column], minWidth: colWidths[column], maxWidth: colWidths[column] } : undefined;
  }

  function resizeHandle(column: string) {
    return <span className="col-resize-handle" onMouseDown={(event) => startResize(event, column)} onClick={(event) => event.stopPropagation()} />;
  }

  return { columnStyle, resizeHandle };
}

type DataTableProps = {
  rows: Record<string, unknown>[];
  columns?: string[];
  onRowClick?: (row: Record<string, unknown>) => void;
  action?: (row: Record<string, unknown>) => ReactNode;
  actionClassName?: string;
  secondaryAction?: (row: Record<string, unknown>) => ReactNode;
  secondaryActionLabel?: string;
  secondaryActionClassName?: string;
  tableClassName?: string;
  renderCell?: (row: Record<string, unknown>, column: string) => ReactNode;
  emptyMessage?: string;
  sortColumn?: string;
  sortDirection?: SortDirection;
  onSort?: (column: string) => void;
  resizableColumns?: boolean;
  isRowExpanded?: (row: Record<string, unknown>) => boolean;
  renderExpandedRow?: (row: Record<string, unknown>) => ReactNode;
  rowKey?: (row: Record<string, unknown>) => string | number;
  rowAttrs?: (row: Record<string, unknown>) => Record<string, string>;
};

export function DataTable({
  rows,
  columns,
  onRowClick,
  action,
  actionClassName = "",
  secondaryAction,
  secondaryActionLabel = "Action",
  secondaryActionClassName = "",
  tableClassName = "",
  renderCell,
  emptyMessage = "No rows.",
  sortColumn,
  sortDirection,
  onSort,
  resizableColumns = false,
  isRowExpanded,
  renderExpandedRow,
  rowKey,
  rowAttrs
}: DataTableProps) {
  const resize = useResizableColumns(resizableColumns);

  const cols = columns?.length ? columns : Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 8);
  if (!rows.length) return <div className="empty">{emptyMessage}</div>;
  const colStyle = (col: string) => resizableColumns ? resize.columnStyle(col) : undefined;
  const totalColumns = cols.length + (action ? 1 : 0) + (secondaryAction ? 1 : 0);
  return <div className="table-wrap"><table className={tableClassName}><thead><tr>{cols.map((col) => <th key={col} className={onSort ? "sortable" : ""} style={colStyle(col)} onClick={onSort ? () => onSort(col) : undefined}>{friendlyColumnName(col)}{onSort && sortColumn === col && <span className="sort-indicator">{sortDirection === "desc" ? " ↓" : " ↑"}</span>}{resizableColumns && resize.resizeHandle(col)}</th>)}{action && <th className={actionClassName}>Actions</th>}{secondaryAction && <th className={secondaryActionClassName}>{secondaryActionLabel}</th>}</tr></thead><tbody>{rows.map((row, index) => <Fragment key={rowKey ? rowKey(row) : index}><tr onClick={() => onRowClick?.(row)} className={onRowClick ? "clickable" : ""} {...(rowAttrs ? rowAttrs(row) : {})}>{cols.map((col) => <td key={col} style={colStyle(col)}>{renderCell ? renderCell(row, col) : formatCell(row[col])}</td>)}{action && <td className={actionClassName}>{action(row)}</td>}{secondaryAction && <td className={secondaryActionClassName}>{secondaryAction(row)}</td>}</tr>{isRowExpanded?.(row) && renderExpandedRow && <tr className="expanded-row"><td colSpan={totalColumns} className="expanded-row-cell">{renderExpandedRow(row)}</td></tr>}</Fragment>)}</tbody></table></div>;
}
