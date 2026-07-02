import type { ReactNode } from "react";
import { formatCell, friendlyColumnName } from "../../lib/display";

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
  sortDirection?: "asc" | "desc";
  onSort?: (column: string) => void;
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
  onSort
}: DataTableProps) {
  const cols = columns?.length ? columns : Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 8);
  if (!rows.length) return <div className="empty">{emptyMessage}</div>;
  return <div className="table-wrap"><table className={tableClassName}><thead><tr>{cols.map((col) => <th key={col} className={onSort ? "sortable" : ""} onClick={onSort ? () => onSort(col) : undefined}>{friendlyColumnName(col)}{onSort && sortColumn === col && <span className="sort-indicator">{sortDirection === "desc" ? " ↓" : " ↑"}</span>}</th>)}{action && <th className={actionClassName}>Actions</th>}{secondaryAction && <th className={secondaryActionClassName}>{secondaryActionLabel}</th>}</tr></thead><tbody>{rows.map((row, index) => <tr key={index} onClick={() => onRowClick?.(row)} className={onRowClick ? "clickable" : ""}>{cols.map((col) => <td key={col}>{renderCell ? renderCell(row, col) : formatCell(row[col])}</td>)}{action && <td className={actionClassName}>{action(row)}</td>}{secondaryAction && <td className={secondaryActionClassName}>{secondaryAction(row)}</td>}</tr>)}</tbody></table></div>;
}
