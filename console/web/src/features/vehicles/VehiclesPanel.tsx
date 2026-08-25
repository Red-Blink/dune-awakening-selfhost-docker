import { useCallback, useEffect, useRef, useState } from "react";
import { vehiclesApi, type VehicleRow } from "../../api/vehicles";
import type { SortDirection } from "../../components/common/DataTable";
import { VehicleTable } from "./VehicleTable";

type VehiclesPanelProps = {
  onError: (text: string) => void;
  // Read-only page: confirmAction/formatMutationResult are passed by App.tsx for
  // parity with the other panels but intentionally unused here. The confirmAction
  // signature mirrors the other panels so App.tsx can pass confirmDialog directly.
  confirmAction: (message: string, options?: { title?: string; confirmLabel?: string; warning?: string; danger?: boolean; details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] }) => Promise<boolean>;
  formatMutationResult: (result: unknown) => string;
  focusRequest?: { vehicleId: string; nonce: number };
};

const VEHICLES_AUTO_REFRESH_MS = 15 * 60_000; // 15 minutes — listVehicles is expensive
const VEHICLES_PAGE_SIZES = [25, 50, 100, 200] as const;
const VEHICLES_DEFAULT_PAGE_SIZE = 50;

type VehiclesCache = {
  q: string;
  page: number;
  pageSize: number;
  sortColumn: string;
  sortDirection: SortDirection;
  rows: VehicleRow[];
  totalCount: number;
  totalVehicles: number;
  supported: boolean;
  canEditPermissions: boolean;
  reason: string;
  lastFetchedAt: number;
};

let vehiclesCache: VehiclesCache | null = null;

function sameView(cache: VehiclesCache | null, q: string, page: number, pageSize: number, sortColumn: string, sortDirection: SortDirection) {
  return !!cache && cache.q === q && cache.page === page && cache.pageSize === pageSize && cache.sortColumn === sortColumn && cache.sortDirection === sortDirection;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function VehiclesPanel({ onError, focusRequest }: VehiclesPanelProps) {
  const [q, setQ] = useState(() => vehiclesCache?.q ?? "");
  const [submittedQ, setSubmittedQ] = useState(() => vehiclesCache?.q ?? "");
  const [page, setPage] = useState(() => vehiclesCache?.page ?? 0);
  const [pageSize, setPageSize] = useState<number>(() => vehiclesCache?.pageSize ?? VEHICLES_DEFAULT_PAGE_SIZE);
  const [sortColumn, setSortColumn] = useState(() => vehiclesCache?.sortColumn ?? "name");
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => vehiclesCache?.sortDirection ?? "asc");
  const [rows, setRows] = useState<VehicleRow[]>(() => vehiclesCache?.rows ?? []);
  const [totalCount, setTotalCount] = useState(() => vehiclesCache?.totalCount ?? 0);
  const [totalVehicles, setTotalVehicles] = useState(() => vehiclesCache?.totalVehicles ?? 0);
  const [supported, setSupported] = useState(() => vehiclesCache?.supported ?? true);
  const [canEditPermissions, setCanEditPermissions] = useState(() => vehiclesCache?.canEditPermissions ?? false);
  const [reason, setReason] = useState(() => vehiclesCache?.reason ?? "");
  const [loading, setLoading] = useState(() => vehiclesCache === null);
  const requestIdRef = useRef(0);
  const skipNextSearchReset = useRef(true);

  useEffect(() => {
    if (skipNextSearchReset.current) {
      skipNextSearchReset.current = false;
      return;
    }
    setPage(0);
  }, [submittedQ]);

  useEffect(() => {
    const id = String(focusRequest?.vehicleId || "").trim();
    if (!id || !/^\d+$/.test(id)) return;
    vehiclesCache = null;
    setQ(id);
    setSubmittedQ(id);
    setPage(0);
  }, [focusRequest?.nonce]);

  function submitSearch() {
    setSubmittedQ(q);
  }

  function handleClearSearch() {
    setQ("");
    setSubmittedQ("");
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

  function changePageSize(nextSize: number) {
    setPageSize(nextSize);
    setPage(0);
  }

  const load = useCallback(async (params: { q: string; page: number; pageSize: number; sortColumn: string; sortDirection: SortDirection }, options: { silent?: boolean } = {}) => {
    const requestId = ++requestIdRef.current;
    if (!options.silent) onError("");
    try {
      const result = await vehiclesApi.list(params);
      if (requestIdRef.current !== requestId) return;
      const nextRows = result.rows || [];
      const nextSupported = result.capabilities?.vehicles !== false;
      const nextCanEditPermissions = result.capabilities?.vehiclePermissions === true;
      setRows(nextRows);
      setTotalCount(result.totalCount || 0);
      setTotalVehicles(result.totalVehicles || 0);
      setSupported(nextSupported);
      setCanEditPermissions(nextCanEditPermissions);
      setReason(result.reason || "");
      vehiclesCache = {
        q: params.q,
        page: params.page,
        pageSize: params.pageSize,
        sortColumn: params.sortColumn,
        sortDirection: params.sortDirection,
        rows: nextRows,
        totalCount: result.totalCount || 0,
        totalVehicles: result.totalVehicles || 0,
        supported: nextSupported,
        canEditPermissions: nextCanEditPermissions,
        reason: result.reason || "",
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
    const cacheHit = sameView(vehiclesCache, submittedQ, page, pageSize, sortColumn, sortDirection) ? vehiclesCache : null;

    if (cacheHit) {
      setRows(cacheHit.rows);
      setTotalCount(cacheHit.totalCount);
      setTotalVehicles(cacheHit.totalVehicles);
      setSupported(cacheHit.supported);
      setCanEditPermissions(cacheHit.canEditPermissions);
      setReason(cacheHit.reason);
      setLoading(false);
    }

    const scheduleNext = () => {
      if (cancelled) return;
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => { void tick(); }, VEHICLES_AUTO_REFRESH_MS);
    };

    const tick = async () => {
      if (document.visibilityState !== "hidden") await load(params, { silent: true });
      scheduleNext();
    };

    void load(params, { silent: Boolean(cacheHit) }).then(scheduleNext);

    const onVisibilityChange = () => {
      const currentCache = sameView(vehiclesCache, submittedQ, page, pageSize, sortColumn, sortDirection) ? vehiclesCache : null;
      if (document.visibilityState === "visible" && (!currentCache || Date.now() - currentCache.lastFetchedAt >= VEHICLES_AUTO_REFRESH_MS)) {
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

  if (loading && !rows.length) {
    return (
      <section className="panel">
        <div className="loading-panel">
          <span className="spinner" aria-hidden="true" />
          <strong className="loading-dots">Loading Vehicles</strong>
        </div>
      </section>
    );
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const rangeStart = totalCount === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = totalCount === 0 ? 0 : rangeStart + rows.length - 1;
  const hasPreviousPage = page > 0;
  const hasNextPage = page + 1 < totalPages;

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>Vehicles</h2>
        <div className="action-row">
          <button onClick={() => void load({ q: submittedQ, page, pageSize, sortColumn, sortDirection })}>Refresh</button>
        </div>
      </div>
      {supported
        ? <p className="action-help-note">Total Vehicles: {totalVehicles.toLocaleString()}</p>
        : <p className="action-help-note">{reason || "Vehicles are unsupported by the detected database schema."}</p>}
      {supported && <>
        <div className="action-row vehicles-search-row">
          <input
            value={q}
            onChange={(event) => setQ(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") submitSearch(); }}
            placeholder="Search name, type, owner, or map"
          />
          <button onClick={submitSearch}>Search</button>
          <button onClick={handleClearSearch} disabled={!q && !submittedQ}>Clear</button>
        </div>
        <VehicleTable
          rows={rows}
          sortColumn={sortColumn}
          sortDirection={sortDirection}
          onSort={handleSort}
          emptyMessage="No vehicles have been found yet."
          canEditPermissions={canEditPermissions}
          focusVehicleId={focusRequest?.vehicleId}
          focusNonce={focusRequest?.nonce}
          // Owner and Shared With are rendered from the list response, so a
          // saved roster has to refetch or the row above keeps showing the
          // pre-edit names.
          onPermissionsSaved={() => {
            vehiclesCache = null;
            void load({ q: submittedQ, page, pageSize, sortColumn, sortDirection }, { silent: true });
          }}
        />
        <div className="panel-title vehicles-pagination-footer">
          <p className="action-help-note">Showing {rangeStart}-{rangeEnd} of {totalCount} vehicles.</p>
          <div className="database-pagination-controls">
            <label className="compact-select">
              Rows
              <select value={String(pageSize)} onChange={(event) => changePageSize(Number(event.target.value))}>
                {VEHICLES_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
            <button disabled={!hasPreviousPage} onClick={() => setPage(0)}>First</button>
            <button disabled={!hasPreviousPage} onClick={() => setPage(page - 1)}>Previous</button>
            <span className="muted database-page-indicator">Page {page + 1} of {totalPages}</span>
            <button disabled={!hasNextPage} onClick={() => setPage(page + 1)}>Next</button>
            <button disabled={!hasNextPage} onClick={() => setPage(totalPages - 1)}>Last</button>
          </div>
        </div>
      </>}
    </section>
  );
}
