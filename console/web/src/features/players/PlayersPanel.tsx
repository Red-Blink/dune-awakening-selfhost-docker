import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { playersApi } from "../../api/players";
import { DataTable, type SortDirection } from "../../components/common/DataTable";
import { PlayerStatusCell } from "../../components/common/DisplayPrimitives";
import { formatCell } from "../../lib/display";

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
};

type PlayerStatusFilter = "all" | "online" | "offline";

const PLAYERS_AUTO_REFRESH_MS = 10_000;
const PLAYERS_PAGE_SIZES = [25, 50, 100, 200] as const;
const PLAYERS_DEFAULT_PAGE_SIZE = 50;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type PlayersLoadParams = { q: string; page: number; pageSize: number; status: PlayerStatusFilter; sortColumn: string; sortDirection: SortDirection };

export function PlayersPanel({ onError, renderCharacterAdmin }: PlayersPanelProps) {
  const [q, setQ] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");
  const [playerFilter, setPlayerFilter] = useState<PlayerStatusFilter>("all");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(PLAYERS_DEFAULT_PAGE_SIZE);
  const [sortColumn, setSortColumn] = useState("character_name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPlayers, setTotalPlayers] = useState(0);
  const [statusFilterSupported, setStatusFilterSupported] = useState(true);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const requestIdRef = useRef(0);
  const skipNextSearchReset = useRef(true);

  useEffect(() => {
    if (skipNextSearchReset.current) {
      skipNextSearchReset.current = false;
      return;
    }
    setPage(0);
  }, [submittedQ, playerFilter]);

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
    let cancelled = false;
    let timeoutId: number | undefined;
    const params = { q: submittedQ, page, pageSize, status: playerFilter, sortColumn, sortDirection };

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
  }, [submittedQ, page, pageSize, playerFilter, sortColumn, sortDirection, load]);

  async function open(row: Record<string, unknown>) {
    const id = String(row.actor_id || row.player_pawn_id || row.id || "");
    setSelected(row);
    setDetail(await playersApi.profile(id));
  }

  const dbPlayerId = selected ? String(selected.actor_id || selected.player_pawn_id || selected.id || "") : "";
  const actionPlayerId = selected ? String(selected.action_player_id || selected.funcom_id || selected.fls_id || selected.account_id || "") : "";
  const playersEmptyMessage = playerFilter === "online"
    ? "No players are currently online."
    : playerFilter === "offline"
      ? "No offline players were found."
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
        <h2>Players</h2>
        <div className="action-row players-filter-row">
          <label className="inline-filter-label players-filter-label">
            Filter
            <select className="players-filter-select" value={playerFilter} disabled={!statusFilterSupported} onChange={(event) => setPlayerFilter(event.target.value as PlayerStatusFilter)}>
              <option value="all">All Players</option>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
            </select>
          </label>
          <button onClick={() => void load({ q: submittedQ, page, pageSize, status: playerFilter, sortColumn, sortDirection })}>Refresh</button>
        </div>
      </div>
      <p className="action-help-note">Total Players: {totalPlayers.toLocaleString()}</p>
      <div className="action-row players-search-row">
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") submitSearch(); }}
          placeholder="Search character, FLS ID, account id, or actor id"
        />
        <button onClick={submitSearch}>Search</button>
        <button onClick={handleClearSearch} disabled={!q && !submittedQ}>Clear</button>
      </div>
      <DataTable
        rows={rows}
        columns={["actor_id", "character_name", "last_seen", "online_status", "map", "fls_id"]}
        columnLabels={{ actor_id: "DB Player ID" }}
        tableClassName="players-table"
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
          return formatCell(row[col]);
        }}
      />
      <div className="panel-title players-pagination-footer">
        <p className="action-help-note">Showing {rangeStart}-{rangeEnd} of {totalCount} rows.</p>
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
      {selected && renderCharacterAdmin({
        detail,
        fallback: selected,
        dbPlayerId,
        actionPlayerId,
        playerName: String(selected.character_name || actionPlayerId || dbPlayerId || "Selected player"),
        onRefresh: () => { void open(selected); },
        onClose: () => setSelected(null)
      })}
    </section>
  );
}

function formatLastOnline(row: Record<string, unknown>) {
  if (String(row.online_status || "").toLowerCase() === "online") return "Currently Active";
  const date = parseLastOnline(row.last_seen);
  if (!date) return "Unavailable";
  const absolute = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
  return `${absolute} (${formatAgo(date)} ago)`;
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

function formatAgo(date: Date) {
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  const units = [
    ["y", 365 * 24 * 60 * 60],
    ["mo", 30 * 24 * 60 * 60],
    ["d", 24 * 60 * 60],
    ["h", 60 * 60],
    ["m", 60],
    ["s", 1]
  ] as const;
  const [label, size] = units.find(([, unitSeconds]) => seconds >= unitSeconds) || units[units.length - 1];
  return `${Math.max(1, Math.floor(seconds / size))}${label}`;
}
