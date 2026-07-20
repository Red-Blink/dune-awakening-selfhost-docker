import { useCallback, useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { basesApi } from "../../api/bases";
import { apiDownload } from "../../api/client";
import { DataTable, type SortDirection } from "../../components/common/DataTable";

type BasesPanelProps = {
  onError: (text: string) => void;
};

type SharedWithEntry = { name: string; rank: number; label: string };

type BaseRow = Record<string, unknown> & {
  base_id: string;
  name: string;
  base_type: string;
  owner_name: string;
  map: string;
  x: number;
  y: number;
  z: number;
  coordinates: string;
  piece_count: number;
  placeable_count: number;
  shared_with: SharedWithEntry[];
};

const BASES_AUTO_REFRESH_MS = 15 * 60_000; // 15 minutes — listBases is expensive
const BASES_PAGE_SIZES = [25, 50, 100, 200] as const;
const BASES_DEFAULT_PAGE_SIZE = 50;

type BasesCache = {
  q: string;
  page: number;
  pageSize: number;
  sortColumn: string;
  sortDirection: SortDirection;
  rows: BaseRow[];
  totalCount: number;
  totalBases: number;
  totalPieces: number;
  totalPlaceables: number;
  lastFetchedAt: number;
};

let basesCache: BasesCache | null = null;

function sameView(cache: BasesCache | null, q: string, page: number, pageSize: number, sortColumn: string, sortDirection: SortDirection) {
  return !!cache && cache.q === q && cache.page === page && cache.pageSize === pageSize && cache.sortColumn === sortColumn && cache.sortDirection === sortDirection;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function withCoordinates(row: Record<string, unknown>): BaseRow {
  const x = Math.round(Number(row.x) || 0);
  const y = Math.round(Number(row.y) || 0);
  const z = Math.round(Number(row.z) || 0);
  return { ...row, x, y, z, coordinates: `${x}, ${y}, ${z}` } as BaseRow;
}

function renderBaseCell(row: Record<string, unknown>, column: string) {
  if (column === "name") {
    const name = String(row.name || "");
    return name ? <span className="bases-name" title={name}>{name}</span> : "—";
  }
  if (column !== "shared_with") {
    const value = row[column];
    if (Array.isArray(value)) return value.join(", ");
    return value == null || value === "" ? "—" : String(value);
  }
  const sharedWith = Array.isArray(row.shared_with) ? (row.shared_with as SharedWithEntry[]) : [];
  if (!sharedWith.length) return <span className="muted">—</span>;
  return (
    <span className="bases-shared-list">
      {sharedWith.map((entry) => (
        <span key={`${entry.name}-${entry.rank}`}>{entry.name} <em>({entry.label})</em></span>
      ))}
    </span>
  );
}

export function BasesPanel({ onError }: BasesPanelProps) {
  const [q, setQ] = useState(() => basesCache?.q ?? "");
  const [submittedQ, setSubmittedQ] = useState(() => basesCache?.q ?? "");
  const [page, setPage] = useState(() => basesCache?.page ?? 0);
  const [pageSize, setPageSize] = useState<number>(() => basesCache?.pageSize ?? BASES_DEFAULT_PAGE_SIZE);
  const [sortColumn, setSortColumn] = useState(() => basesCache?.sortColumn ?? "name");
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => basesCache?.sortDirection ?? "asc");
  const [rows, setRows] = useState<BaseRow[]>(() => basesCache?.rows ?? []);
  const [totalCount, setTotalCount] = useState(() => basesCache?.totalCount ?? 0);
  const [totalBases, setTotalBases] = useState(() => basesCache?.totalBases ?? 0);
  const [totalPieces, setTotalPieces] = useState(() => basesCache?.totalPieces ?? 0);
  const [totalPlaceables, setTotalPlaceables] = useState(() => basesCache?.totalPlaceables ?? 0);
  const [loading, setLoading] = useState(() => basesCache === null);
  const [downloadingId, setDownloadingId] = useState("");
  const requestIdRef = useRef(0);
  const skipNextSearchReset = useRef(true);

  useEffect(() => {
    if (skipNextSearchReset.current) {
      skipNextSearchReset.current = false;
      return;
    }
    setPage(0);
  }, [submittedQ]);

  function submitSearch() {
    setSubmittedQ(q);
  }

  function handleClearSearch() {
    setQ("");
    setSubmittedQ("");
  }

  const load = useCallback(async (params: { q: string; page: number; pageSize: number; sortColumn: string; sortDirection: SortDirection }, options: { silent?: boolean } = {}) => {
    const requestId = ++requestIdRef.current;
    if (!options.silent) onError("");
    try {
      const result = await basesApi.list(params);
      if (requestIdRef.current !== requestId) return;
      const nextRows = (result.rows || []).map(withCoordinates);
      setRows(nextRows);
      setTotalCount(result.totalCount || 0);
      setTotalBases(result.totalBases || 0);
      setTotalPieces(result.totalPieces || 0);
      setTotalPlaceables(result.totalPlaceables || 0);
      basesCache = {
        q: params.q,
        page: params.page,
        pageSize: params.pageSize,
        sortColumn: params.sortColumn,
        sortDirection: params.sortDirection,
        rows: nextRows,
        totalCount: result.totalCount || 0,
        totalBases: result.totalBases || 0,
        totalPieces: result.totalPieces || 0,
        totalPlaceables: result.totalPlaceables || 0,
        lastFetchedAt: Date.now()
      };
    } catch (error) {
      if (requestIdRef.current === requestId && !options.silent) onError(errorText(error));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | undefined;
    const params = { q: submittedQ, page, pageSize, sortColumn, sortDirection };
    const cacheHit = sameView(basesCache, submittedQ, page, pageSize, sortColumn, sortDirection) ? basesCache : null;

    if (cacheHit) {
      setRows(cacheHit.rows);
      setTotalCount(cacheHit.totalCount);
      setTotalBases(cacheHit.totalBases);
      setTotalPieces(cacheHit.totalPieces);
      setTotalPlaceables(cacheHit.totalPlaceables);
      setLoading(false);
    }

    const scheduleNext = () => {
      if (cancelled) return;
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => { void tick(); }, BASES_AUTO_REFRESH_MS);
    };

    const tick = async () => {
      if (document.visibilityState !== "hidden") await load(params, { silent: true });
      scheduleNext();
    };

    // Always refresh on entry. Cached rows remain visible while the current data is fetched.
    void load(params, { silent: Boolean(cacheHit) }).then(scheduleNext);

    const onVisibilityChange = () => {
      const currentCache = sameView(basesCache, submittedQ, page, pageSize, sortColumn, sortDirection) ? basesCache : null;
      if (document.visibilityState === "visible" && (!currentCache || Date.now() - currentCache.lastFetchedAt >= BASES_AUTO_REFRESH_MS)) {
        void load(params, { silent: true }).then(scheduleNext);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [submittedQ, page, pageSize, sortColumn, sortDirection, load]);

  async function handleDownloadBlueprint(row: BaseRow) {
    const id = String(row.base_id);
    setDownloadingId(id);
    try {
      const response = await apiDownload(`/api/bases/${encodeURIComponent(id)}/export`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      const responseFilename = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1];
      anchor.download = responseFilename
        || `${String(row.owner_name || "unknown_player").replace(/[^a-zA-Z0-9_-]/g, "_")}_base_${id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      onError(errorText(error));
    } finally {
      setDownloadingId("");
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

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const rangeStart = totalCount === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = totalCount === 0 ? 0 : rangeStart + rows.length - 1;
  const hasPreviousPage = page > 0;
  const hasNextPage = page + 1 < totalPages;

  function changePageSize(nextSize: number) {
    setPageSize(nextSize);
    setPage(0);
  }

  function handleSort(column: string) {
    setPage(0);
    if (column === sortColumn) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortColumn(column);
    setSortDirection("asc");
  }

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>Bases</h2>
        <div className="action-row">
          <button onClick={() => void load({ q: submittedQ, page, pageSize, sortColumn, sortDirection })}>Refresh</button>
        </div>
      </div>
      <p className="action-help-note">
        Total Bases: {totalBases.toLocaleString()} · Total Building Pieces: {totalPieces.toLocaleString()} · Total Placeables: {totalPlaceables.toLocaleString()}
      </p>
      <div className="action-row bases-search-row">
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") submitSearch(); }}
          placeholder="Search name, type, or owner"
        />
        <button onClick={submitSearch}>Search</button>
        <button onClick={handleClearSearch} disabled={!q && !submittedQ}>Clear</button>
      </div>
      <DataTable
        rows={rows}
        columns={["base_id", "name", "base_type", "owner_name", "shared_with", "map", "coordinates", "piece_count", "placeable_count"]}
        tableClassName="bases-table"
        actionClassName="actions-column bases-actions-column"
        renderCell={renderBaseCell}
        action={(row) => {
          const base = row as BaseRow;
          const id = String(base.base_id);
          return <span className="icon-toggle-group">
            <button className="icon-toggle-button" title="Download Base as Blueprint" aria-label="Download Base as Blueprint" disabled={downloadingId === id} onClick={(event) => { event.stopPropagation(); void handleDownloadBlueprint(base); }}><Download size={16} /></button>
          </span>;
        }}
        sortColumn={sortColumn}
        sortDirection={sortDirection}
        onSort={handleSort}
        rowKey={(row) => String(row.base_id)}
        emptyMessage="No bases have been found yet."
      />
      <div className="panel-title bases-pagination-footer">
        <p className="action-help-note">
          Showing {rangeStart}-{rangeEnd} of {totalCount} rows.
        </p>
        <div className="database-pagination-controls">
          <label className="compact-select">
            Rows
            <select value={String(pageSize)} onChange={(event) => changePageSize(Number(event.target.value))}>
              {BASES_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
          <button disabled={!hasPreviousPage} onClick={() => setPage(0)}>First</button>
          <button disabled={!hasPreviousPage} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="muted database-page-indicator">Page {page + 1} of {totalPages}</span>
          <button disabled={!hasNextPage} onClick={() => setPage(page + 1)}>Next</button>
          <button disabled={!hasNextPage} onClick={() => setPage(totalPages - 1)}>Last</button>
        </div>
      </div>
    </section>
  );
}
