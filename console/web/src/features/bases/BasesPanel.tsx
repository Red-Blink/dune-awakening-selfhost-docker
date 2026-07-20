import { useCallback, useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { basesApi } from "../../api/bases";
import { apiDownload } from "../../api/client";
import { DataTable, useSortableRows } from "../../components/common/DataTable";

type BasesPanelProps = {
  onError: (text: string) => void;
};

type SharedWithEntry = { name: string; rank: number; label: string };

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
  shared_with: SharedWithEntry[];
};

const BASES_AUTO_REFRESH_MS = 15 * 60_000; // 15 minutes — listBases is expensive
const BASES_AUTO_REFRESH_RETRY_MS = 60_000; // backoff if a due refresh hasn't landed yet (in-flight/failed)
const BASES_RELATIVE_TIME_TICK_MS = 30_000; // UI-only re-render cadence for "time ago" text — never fetches
const BASES_PAGE_SIZES = [25, 50, 100, 200] as const;
const BASES_DEFAULT_PAGE_SIZE = 50;

type BasesCache = {
  q: string;
  page: number;
  pageSize: number;
  rows: BaseRow[];
  totalCount: number;
  totalBases: number;
  totalPieces: number;
  totalPlaceables: number;
  lastFetchedAt: number;
};

let basesCache: BasesCache | null = null;

function sameView(cache: BasesCache | null, q: string, page: number, pageSize: number) {
  return !!cache && cache.q === q && cache.page === page && cache.pageSize === pageSize;
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

function formatRelativeTime(fromMs: number, nowMs: number): string {
  const diffSec = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (diffSec < 45) return "just now";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.round(diffMin / 60);
  return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
}

function renderBaseCell(row: Record<string, unknown>, column: string) {
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
  const [rows, setRows] = useState<BaseRow[]>(() => basesCache?.rows ?? []);
  const [totalCount, setTotalCount] = useState(() => basesCache?.totalCount ?? 0);
  const [totalBases, setTotalBases] = useState(() => basesCache?.totalBases ?? 0);
  const [totalPieces, setTotalPieces] = useState(() => basesCache?.totalPieces ?? 0);
  const [totalPlaceables, setTotalPlaceables] = useState(() => basesCache?.totalPlaceables ?? 0);
  const [loading, setLoading] = useState(() => basesCache === null);
  const [now, setNow] = useState(() => Date.now());
  const [downloadingId, setDownloadingId] = useState("");
  const requestIdRef = useRef(0);
  const skipNextSearchReset = useRef(true);
  const sort = useSortableRows(rows);

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

  const load = useCallback(async (params: { q: string; page: number; pageSize: number }, options: { silent?: boolean } = {}) => {
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
    const params = { q: submittedQ, page, pageSize };
    const cacheHit = sameView(basesCache, submittedQ, page, pageSize) ? basesCache : null;
    const isStale = () => !cacheHit || Date.now() - cacheHit.lastFetchedAt >= BASES_AUTO_REFRESH_MS;

    if (cacheHit) {
      setRows(cacheHit.rows);
      setTotalCount(cacheHit.totalCount);
      setTotalBases(cacheHit.totalBases);
      setTotalPieces(cacheHit.totalPieces);
      setTotalPlaceables(cacheHit.totalPlaceables);
      setLoading(false);
    }

    const scheduleNext = (fromTime: number) => {
      if (cancelled) return;
      window.clearTimeout(timeoutId);
      const dueIn = fromTime + BASES_AUTO_REFRESH_MS - Date.now();
      const delay = dueIn > 0 ? dueIn : BASES_AUTO_REFRESH_RETRY_MS;
      timeoutId = window.setTimeout(() => { void tick(); }, delay);
    };

    const tick = async () => {
      if (document.visibilityState !== "hidden") await load(params, { silent: true });
      if (!cancelled) scheduleNext(basesCache?.lastFetchedAt ?? Date.now());
    };

    if (!cacheHit || isStale()) {
      void load(params).then(() => { if (!cancelled) scheduleNext(Date.now()); });
    } else {
      scheduleNext(cacheHit.lastFetchedAt);
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && isStale()) {
        void load(params, { silent: true }).then(() => { if (!cancelled) scheduleNext(Date.now()); });
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [submittedQ, page, pageSize, load]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), BASES_RELATIVE_TIME_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  async function handleDownloadBlueprint(row: BaseRow) {
    const id = String(row.base_id);
    setDownloadingId(id);
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

  const lastFetchedAt = basesCache?.lastFetchedAt ?? null;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const rangeStart = totalCount === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = totalCount === 0 ? 0 : rangeStart + rows.length - 1;
  const hasPreviousPage = page > 0;
  const hasNextPage = page + 1 < totalPages;

  function changePageSize(nextSize: number) {
    setPageSize(nextSize);
    setPage(0);
  }

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>Bases</h2>
        <div className="action-row">
          {lastFetchedAt !== null && (
            <span className="muted">Refreshed {formatRelativeTime(lastFetchedAt, now)}</span>
          )}
          <button onClick={() => void load({ q: submittedQ, page, pageSize })}>Refresh</button>
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
          placeholder="Search base or owner name"
        />
      </div>
      <div className="panel-title bases-row-count">
        <div className="action-row">
          <button onClick={submitSearch}>Search</button>
          <button onClick={handleClearSearch} disabled={!q && !submittedQ}>Clear</button>
          <p className="action-help-note">
            Showing {rangeStart}-{rangeEnd} of {totalCount} rows.
          </p>
        </div>
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
      <DataTable
        rows={sort.sortedRows}
        columns={["base_id", "name", "owner_name", "shared_with", "map", "coordinates", "piece_count", "placeable_count"]}
        tableClassName="bases-table"
        actionClassName="actions-column"
        renderCell={renderBaseCell}
        action={(row) => {
          const base = row as BaseRow;
          const id = String(base.base_id);
          return <span className="icon-toggle-group">
            <button className="icon-toggle-button" title="Download Base as Blueprint" aria-label="Download Base as Blueprint" disabled={downloadingId === id} onClick={(event) => { event.stopPropagation(); void handleDownloadBlueprint(base); }}><Download size={16} /></button>
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
