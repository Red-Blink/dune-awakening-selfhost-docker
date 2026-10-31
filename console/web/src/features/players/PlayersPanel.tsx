import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { playersApi } from "../../api/players";
import { DataTable, type SortDirection } from "../../components/common/DataTable";
import { SegmentedControl } from "../../components/common/SegmentedControl";
import { DeletedCharacterAssets } from "./DeletedCharacterAssets";
import { PlayerStatusCell } from "../../components/common/DisplayPrimitives";
import { formatAbsoluteDateTime, formatCell, formatRelativeAge } from "../../lib/display";
import { cachedInstanceNames, resolveInstanceNames } from "../maps/instanceNames";

export type CharacterAdminRenderProps = {
  detail: Record<string, unknown> | null;
  fallback: Record<string, unknown>;
  dbPlayerId: string;
  actionPlayerId: string;
  playerName: string;
  onRefresh: () => void;
  onClose: () => void;
};

type PlayersPanelProps = {
  onError: (text: string) => void;
  renderCharacterAdmin: (props: CharacterAdminRenderProps) => ReactNode;
  onOpenBase?: (baseId: string) => void;
  confirmAction?: (message: string, options?: { title?: string; confirmLabel?: string; warning?: string; danger?: boolean; details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] }) => Promise<boolean>;
};

type PlayerStatusFilter = "all" | "online" | "offline" | "banned";

// A sub-view, not a status filter. Deleted characters have no live pawn, so
// they cannot be rows in the players table -- selecting one there opens
// CharacterAdminUI, which assumes an inventory, skills, a position to teleport
// and so on. The whole body swaps instead.
type PlayersViewMode = "active" | "deleted";

const PLAYERS_VIEW_MODES = [
  { value: "active", label: "Active Players" },
  { value: "deleted", label: "Deleted Characters" }
] as const satisfies ReadonlyArray<{ value: PlayersViewMode; label: string }>;

const PLAYERS_AUTO_REFRESH_MS = 10_000;
const PLAYERS_PAGE_SIZES = [25, 50, 100, 200] as const;
const PLAYERS_DEFAULT_PAGE_SIZE = 50;
const INACTIVE_PLAYER_WEEK_OPTIONS = [1, 2, 3, 4, 8] as const;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type PlayersLoadParams = { q: string; page: number; pageSize: number; status: PlayerStatusFilter; sortColumn: string; sortDirection: SortDirection; recentOnly: boolean };

export function PlayersPanel({ onError, renderCharacterAdmin, onOpenBase, confirmAction }: PlayersPanelProps) {
  const [viewMode, setViewMode] = useState<PlayersViewMode>("active");
  const [q, setQ] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");
  const [playerFilter, setPlayerFilter] = useState<PlayerStatusFilter>("all");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(PLAYERS_DEFAULT_PAGE_SIZE);
  const [sortColumn, setSortColumn] = useState("character_name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [instanceNames, setInstanceNames] = useState<Map<string, string>>(new Map());
  const [totalCount, setTotalCount] = useState(0);
  const [totalPlayers, setTotalPlayers] = useState(0);
  const [statusFilterSupported, setStatusFilterSupported] = useState(true);
  const [showInactive, setShowInactive] = useState(true);
  const [inactiveWeeks, setInactiveWeeks] = useState<number | null>(null);
  const [canConfigureVisibility, setCanConfigureVisibility] = useState(false);
  const [visibilitySaving, setVisibilitySaving] = useState(false);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const requestIdRef = useRef(0);
  const profileRequestIdRef = useRef(0);
  const selectedPlayerIdRef = useRef("");
  const playerDetailRef = useRef<HTMLDivElement>(null);
  const skipNextSearchReset = useRef(true);

  useEffect(() => {
    if (skipNextSearchReset.current) {
      skipNextSearchReset.current = false;
      return;
    }
    setPage(0);
  }, [submittedQ, playerFilter, showInactive]);

  useEffect(() => {
    let cancelled = false;
    void playersApi.listSettings().then((result) => {
      if (cancelled) return;
      const weeks = result.settings?.inactiveWeeks === null ? null : Number(result.settings?.inactiveWeeks);
      setInactiveWeeks(weeks);
      setShowInactive(weeks === null);
      setCanConfigureVisibility(result.canConfigure === true);
    }).catch((error) => {
      if (!cancelled) onError(errorText(error));
    });
    return () => { cancelled = true; };
  }, [onError]);

  function submitSearch() {
    setSubmittedQ(q);
  }

  function handleClearSearch() {
    setQ("");
    setSubmittedQ("");
  }

  const load = useCallback(async (params: PlayersLoadParams, options: { silent?: boolean } = {}) => {
    const requestId = ++requestIdRef.current;
    if (!options.silent) onError("");
    try {
      const result = await playersApi.list(params);
      if (requestIdRef.current !== requestId) return;
      const nextRows = result.rows || [];
      const nextTotalCount = result.totalCount || 0;
      const lastPage = Math.max(0, Math.ceil(nextTotalCount / params.pageSize) - 1);
      const nextStatusFilterSupported = result.capabilities?.statusFilterApplied !== false;
      setStatusFilterSupported(nextStatusFilterSupported);
      setTotalCount(nextTotalCount);
      setTotalPlayers(result.totalPlayers || 0);
      if (!nextStatusFilterSupported && params.status !== "all") {
        setPlayerFilter("all");
        return;
      }
      if (params.page > lastPage) {
        setPage(lastPage);
        return;
      }
      setRows(nextRows);
      setSelected((current) => {
        if (!current) return current;
        const currentId = String(current.actor_id || current.player_pawn_id || current.id || "");
        return nextRows.find((row) => String(row.actor_id || row.player_pawn_id || row.id || "") === currentId) || current;
      });
    } catch (error) {
      if (requestIdRef.current === requestId && !options.silent) onError(errorText(error));
    }
  }, [onError]);

  useEffect(() => {
    // The deleted-characters view has its own fetch and its own Refresh button.
    // Without this guard the players poll keeps running underneath it, hitting
    // /api/players every 10s for a list nobody is looking at.
    if (viewMode !== "active") return;
    let cancelled = false;
    let timeoutId: number | undefined;
    const params = { q: submittedQ, page, pageSize, status: playerFilter, sortColumn, sortDirection, recentOnly: !showInactive };

    const scheduleNext = () => {
      if (cancelled) return;
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => { void tick(); }, PLAYERS_AUTO_REFRESH_MS);
    };

    const tick = async () => {
      if (document.visibilityState !== "hidden") await load(params, { silent: true });
      scheduleNext();
    };

    void load(params).then(scheduleNext);

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void load(params, { silent: true }).then(scheduleNext);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [viewMode, submittedQ, page, pageSize, playerFilter, sortColumn, sortDirection, showInactive, load]);

  async function changeInactiveFilter(value: string) {
    const weeks = value === "never" ? null : Number(value);
    if (weeks === inactiveWeeks) return;
    if (!canConfigureVisibility) {
      onError("You do not have permission to change the inactive-player filter.");
      return;
    }
    const previousWeeks = inactiveWeeks;
    const previousShowInactive = showInactive;
    setInactiveWeeks(weeks);
    setShowInactive(weeks === null);
    setVisibilitySaving(true);
    onError("");
    try {
      const result = await playersApi.saveListSettings(weeks);
      const savedWeeks = result.settings.inactiveWeeks;
      setInactiveWeeks(savedWeeks);
      setShowInactive(savedWeeks === null);
      setPage(0);
      await load({
        q: submittedQ,
        page: 0,
        pageSize,
        status: playerFilter,
        sortColumn,
        sortDirection,
        recentOnly: savedWeeks !== null
      });
    } catch (error) {
      setInactiveWeeks(previousWeeks);
      setShowInactive(previousShowInactive);
      onError(errorText(error));
    } finally {
      setVisibilitySaving(false);
    }
  }

  const partitionMapsKey = [...new Set(rows
    .map((row) => String(row.partitionMap || "").trim())
    .filter(Boolean))].sort().join(",");
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

  async function open(row: Record<string, unknown>) {
    const id = String(row.actor_id || row.player_pawn_id || row.id || "");
    const requestId = ++profileRequestIdRef.current;
    // Never show the previously selected player's profile under a new selection.
    if (selectedPlayerIdRef.current !== id) setDetail(null);
    selectedPlayerIdRef.current = id;
    setSelected(row);
    try {
      const nextDetail = await playersApi.profile(id);
      if (profileRequestIdRef.current === requestId && selectedPlayerIdRef.current === id) setDetail(nextDetail);
    } catch (error) {
      if (profileRequestIdRef.current === requestId) setDetail(null);
      if (profileRequestIdRef.current === requestId) onError(`Could not load this player's profile: ${errorText(error)}`);
    }
  }

  const dbPlayerId = selected ? String(selected.actor_id || selected.player_pawn_id || selected.id || "") : "";
  const actionPlayerId = selected ? String(selected.action_player_id || selected.funcom_id || selected.fls_id || selected.account_id || "") : "";

  useEffect(() => {
    if (!dbPlayerId) return undefined;
    const frame = window.requestAnimationFrame(() => {
      playerDetailRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [dbPlayerId]);

  useEffect(() => {
    if (!dbPlayerId) return undefined;
    let cancelled = false;
    let timeoutId: number | undefined;

    const scheduleNext = () => {
      if (cancelled) return;
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => { void tick(); }, PLAYERS_AUTO_REFRESH_MS);
    };
    const tick = async () => {
      if (document.visibilityState !== "hidden") {
        const requestId = ++profileRequestIdRef.current;
        try {
          const nextDetail = await playersApi.profile(dbPlayerId);
          if (!cancelled && profileRequestIdRef.current === requestId && selectedPlayerIdRef.current === dbPlayerId) setDetail(nextDetail);
        } catch {
          // Keep the last known profile during a transient database or startup interruption.
        }
      }
      scheduleNext();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void tick();
    };

    scheduleNext();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [dbPlayerId]);
  const playersEmptyMessage = playerFilter === "online"
    ? "No players are currently online."
    : playerFilter === "offline"
      ? "No offline players were found."
      : playerFilter === "banned"
        ? "No banned players were found."
        : "No players have been found yet.";

  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const rangeStart = totalCount === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = totalCount === 0 ? 0 : rangeStart + rows.length - 1;
  const hasPreviousPage = page > 0;
  const hasNextPage = page + 1 < totalPages;

  function changePageSize(nextSize: number) {
    setPageSize(nextSize);
    setPage(0);
  }

  // Leaving the players list closes the open character detail: its refresh
  // callback reloads the players list, which is exactly what this view mode is
  // meant to stop doing.
  function handleViewModeChange(next: PlayersViewMode) {
    if (next === viewMode) return;
    selectedPlayerIdRef.current = "";
    profileRequestIdRef.current += 1;
    setSelected(null);
    setDetail(null);
    setViewMode(next);
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

  if (viewMode === "deleted") {
    return (
      <section className="panel">
        <div className="panel-title">
          <h2>Players</h2>
          <SegmentedControl
            name="players-view-mode"
            ariaLabel="Players view"
            value={viewMode}
            options={PLAYERS_VIEW_MODES}
            onChange={handleViewModeChange}
            groupClassName="segmented-control players-view-segments"
          />
        </div>
        <DeletedCharacterAssets onOpenBase={onOpenBase} onError={onError} confirmAction={confirmAction} />
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>Players</h2>
        <SegmentedControl
          name="players-view-mode"
          ariaLabel="Players view"
          value={viewMode}
          options={PLAYERS_VIEW_MODES}
          onChange={handleViewModeChange}
          groupClassName="segmented-control players-view-segments"
        />
        <div className="action-row players-filter-row">
          <label className="inline-filter-label players-filter-label">
            Filter
            <select className="players-filter-select" value={playerFilter} disabled={!statusFilterSupported} title={statusFilterSupported ? undefined : "Status filtering isn't available on this database version"} onChange={(event) => setPlayerFilter(event.target.value as PlayerStatusFilter)}>
              <option value="all">All Players</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
              <option value="banned">Banned</option>
            </select>
          </label>
          <label className="inline-filter-label players-inactive-filter">
            Hide Inactive Players After
            <select
              value={inactiveWeeks === null ? "never" : String(inactiveWeeks)}
              disabled={visibilitySaving || !canConfigureVisibility || playerFilter === "banned"}
              onChange={(event) => void changeInactiveFilter(event.target.value)}
            >
              <option value="never">Never</option>
              {inactiveWeeks !== null && !INACTIVE_PLAYER_WEEK_OPTIONS.includes(inactiveWeeks as typeof INACTIVE_PLAYER_WEEK_OPTIONS[number]) && <option value={inactiveWeeks}>{inactiveWeeks} Weeks</option>}
              <option value="1">1 Week</option>
              <option value="2">2 Weeks</option>
              <option value="3">3 Weeks</option>
              <option value="4">1 Month</option>
              <option value="8">2 Months</option>
            </select>
          </label>
          <button onClick={() => void load({ q: submittedQ, page, pageSize, status: playerFilter, sortColumn, sortDirection, recentOnly: !showInactive })}>Refresh</button>
        </div>
      </div>
      <p className="action-help-note">
        {playerFilter !== "all" || submittedQ || !showInactive
          ? `${totalCount.toLocaleString()} of ${totalPlayers.toLocaleString()} players shown`
          : `${totalPlayers.toLocaleString()} players`}
        {!statusFilterSupported && " · Status filtering isn't available on this database version."}
      </p>
      <div className="action-row players-search-row">
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") submitSearch(); }}
          placeholder="Search Character, FLS ID, Account ID, or Actor ID"
        />
        <button onClick={submitSearch}>Search</button>
        <button onClick={handleClearSearch} disabled={!q && !submittedQ}>Clear</button>
      </div>
      <DataTable
        rows={rows}
        columns={["character_name", "online_status", "last_seen", "total_playtime_seconds", "map", "actor_id", "fls_id"]}
        columnLabels={{
          actor_id: "DB Player ID",
          character_name: "Character",
          last_seen: "Last Online",
          total_playtime_seconds: "Total Playtime",
          online_status: "Status",
          map: "Map",
          fls_id: "FLS ID"
        }}
        tableClassName="players-table"
        wrapClassName={`players-table-wrap ${selected ? "players-table-wrap-compact" : "players-table-wrap-expanded"}`}
        onRowClick={open}
        emptyMessage={playersEmptyMessage}
        sortColumn={sortColumn}
        sortDirection={sortDirection}
        onSort={handleSort}
        resizableColumns
        rowKey={(row) => String(row.actor_id)}
        renderCell={(row, col) => {
          if (col === "online_status") return <PlayerStatusCell value={row[col]} />;
          if (col === "last_seen") return formatLastOnline(row);
          if (col === "total_playtime_seconds") return formatTotalPlaytime(row[col]);
          if (col === "map") return formatPlayerMap(row, instanceNames);
          return formatCell(row[col]);
        }}
      />
      <div className="panel-title players-pagination-footer">
        <p className="action-help-note">Showing {rangeStart}-{rangeEnd} of {totalCount.toLocaleString()}</p>
        <div className="database-pagination-controls">
          <label className="compact-select">
            Rows
            <select value={String(pageSize)} onChange={(event) => changePageSize(Number(event.target.value))}>
              {PLAYERS_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
          <button disabled={!hasPreviousPage} onClick={() => setPage(0)}>First</button>
          <button disabled={!hasPreviousPage} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="muted database-page-indicator">Page {page + 1} of {totalPages}</span>
          <button disabled={!hasNextPage} onClick={() => setPage(page + 1)}>Next</button>
          <button disabled={!hasNextPage} onClick={() => setPage(totalPages - 1)}>Last</button>
        </div>
      </div>
      {selected && (
        <div ref={playerDetailRef} className="players-detail-anchor">
          {renderCharacterAdmin({
            detail,
            fallback: selected,
            dbPlayerId,
            actionPlayerId,
            playerName: String(selected.character_name || actionPlayerId || dbPlayerId || "Selected player"),
            onRefresh: () => {
              void Promise.all([
                open(selected),
                load({ q: submittedQ, page, pageSize, status: playerFilter, sortColumn, sortDirection, recentOnly: !showInactive }, { silent: true })
              ]);
            },
            onClose: () => {
              selectedPlayerIdRef.current = "";
              profileRequestIdRef.current += 1;
              setSelected(null);
              setDetail(null);
            }
          })}
        </div>
      )}
    </section>
  );
}

export function formatPlayerMap(row: Record<string, unknown>, instanceNames: Map<string, string>) {
  const map = String(row.map || "").trim();
  if (!map) return "—";
  const partitionMap = String(row.partitionMap || "").trim();
  const partitionId = String(row.partition_id || "").trim();
  const instanceName = partitionMap && partitionId ? instanceNames.get(`${partitionMap}:${partitionId}`) : "";
  return instanceName ? `${map} (${instanceName})` : map;
}

function formatLastOnline(row: Record<string, unknown>) {
  if (String(row.actual_online_status || row.online_status || "").toLowerCase() === "online") return "Currently Active";
  const date = parseLastOnline(row.last_seen);
  if (!date) return "Unavailable";
  return `${formatAbsoluteDateTime(date)} (${formatRelativeAge(date)} ago)`;
}

export function formatTotalPlaytime(value: unknown) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours.toLocaleString()}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return seconds > 0 ? "Less than 1m" : "0m";
}

function parseLastOnline(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const candidates = [
    raw,
    raw.includes(" ") && !raw.includes("T") ? raw.replace(" ", "T") : "",
    raw.replace(/([+-]\d{2})$/, "$1:00")
  ].filter(Boolean);
  for (const candidate of candidates) {
    const date = new Date(candidate);
    if (Number.isFinite(date.getTime()) && date.getFullYear() >= 2000) return date;
  }
  return null;
}
