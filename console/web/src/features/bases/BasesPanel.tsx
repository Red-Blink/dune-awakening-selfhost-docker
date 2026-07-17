import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Unlock } from "lucide-react";
import { basesApi } from "../../api/bases";
import { apiDownload } from "../../api/client";
import { DataTable, useSortableRows } from "../../components/common/DataTable";

type BasesPanelProps = {
  onError: (text: string) => void;
};

type BaseRow = Record<string, unknown> & {
  base_id: string;
  name: string;
  owner_name: string;
  map: string;
  x: number;
  y: number;
  z: number;
  coordinates: string;
  piece_count: number;
  placeable_count: number;
};

const BASES_AUTO_REFRESH_MS = 10_000;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function withCoordinates(row: Record<string, unknown>): BaseRow {
  const x = Math.round(Number(row.x) || 0);
  const y = Math.round(Number(row.y) || 0);
  const z = Math.round(Number(row.z) || 0);
  return { ...row, x, y, z, coordinates: `${x}, ${y}, ${z}` } as BaseRow;
}

export function BasesPanel({ onError }: BasesPanelProps) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<BaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportingId, setExportingId] = useState("");
  const refreshInFlight = useRef(false);
  const qRef = useRef(q);
  const sort = useSortableRows(rows);

  useEffect(() => {
    qRef.current = q;
  }, [q]);

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (!options.silent) onError("");
    try {
      const result = await basesApi.list(qRef.current);
      setRows((result.rows || []).map(withCoordinates));
    } catch (error) {
      if (!options.silent) onError(errorText(error));
    } finally {
      setLoading(false);
      refreshInFlight.current = false;
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void load({ silent: true });
    };

    const interval = window.setInterval(refresh, BASES_AUTO_REFRESH_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [load]);

  async function handleExport(row: BaseRow) {
    const id = String(row.base_id);
    setExportingId(id);
    try {
      const response = await apiDownload(`/api/bases/${encodeURIComponent(id)}/export`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = row.name ? `${String(row.name).replace(/[^a-zA-Z0-9_-]/g, "_")}.json` : `base_${id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      onError(errorText(error));
    } finally {
      setExportingId("");
    }
  }

  if (loading) {
    return <section className="panel">
      <div className="panel-title"><h2>Bases</h2></div>
      <div className="loading-panel">
        <span className="spinner" aria-hidden="true" />
        <strong className="loading-dots">Loading Bases</strong>
      </div>
    </section>;
  }

  const totalBases = rows.length;
  const totalPieces = rows.reduce((sum, row) => sum + Number(row.piece_count || 0), 0);
  const totalPlaceables = rows.reduce((sum, row) => sum + Number(row.placeable_count || 0), 0);

  return (
    <section className="panel">
      <div className="panel-title"><h2>Bases</h2><div className="action-row"><button onClick={() => void load()}>Refresh</button></div></div>
      <p className="action-help-note">
        Total Bases: {totalBases.toLocaleString()} · Total Building Pieces: {totalPieces.toLocaleString()} · Total Placeables: {totalPlaceables.toLocaleString()}
      </p>
      <div className="action-row bases-search-row"><input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search base or owner name" /><button onClick={() => void load()}>Search</button></div>
      <DataTable
        rows={sort.sortedRows}
        columns={["base_id", "name", "owner_name", "map", "coordinates", "piece_count", "placeable_count"]}
        tableClassName="bases-table"
        actionClassName="actions-column"
        action={(row) => {
          const base = row as BaseRow;
          const id = String(base.base_id);
          return <span className="icon-toggle-group">
            <button className="icon-toggle-button" title="Export base" aria-label="Export base" disabled={exportingId === id} onClick={(event) => { event.stopPropagation(); void handleExport(base); }}><Download size={16} /></button>
            <button className="icon-toggle-button" title="Coming soon" aria-label="Release claim" disabled><Unlock size={16} /></button>
          </span>;
        }}
        sortColumn={sort.sortColumn}
        sortDirection={sort.sortDirection}
        onSort={sort.onSort}
        rowKey={(row) => String(row.base_id)}
        emptyMessage="No bases have been found yet."
      />
    </section>
  );
}
