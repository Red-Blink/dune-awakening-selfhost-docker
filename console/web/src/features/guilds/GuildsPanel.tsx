import { useCallback, useEffect, useRef, useState } from "react";
import { guildsApi } from "../../api/guilds";
import { DataTable, type SortDirection } from "../../components/common/DataTable";
import { formatCell } from "../../lib/display";

type GuildsPanelProps = {
  onError: (text: string) => void;
};

const GUILDS_AUTO_REFRESH_MS = 10_000;
const GUILDS_PAGE_SIZES = [25, 50, 100, 200] as const;
const GUILDS_DEFAULT_PAGE_SIZE = 50;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type GuildsLoadParams = { q: string; page: number; pageSize: number; sortColumn: string; sortDirection: SortDirection };

export function GuildsPanel({ onError }: GuildsPanelProps) {
  const [q, setQ] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(GUILDS_DEFAULT_PAGE_SIZE);
  const [sortColumn, setSortColumn] = useState("guild_name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalGuilds, setTotalGuilds] = useState(0);
  const [selectedGuild, setSelectedGuild] = useState<Record<string, unknown> | null>(null);
  const [memberRows, setMemberRows] = useState<Record<string, unknown>[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
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

  const load = useCallback(async (params: GuildsLoadParams, options: { silent?: boolean } = {}) => {
    const requestId = ++requestIdRef.current;
    if (!options.silent) onError("");
    try {
      const result = await guildsApi.list(params);
      if (requestIdRef.current !== requestId) return;
      const nextRows = result.rows || [];
      const nextTotalCount = result.totalCount || 0;
      const lastPage = Math.max(0, Math.ceil(nextTotalCount / params.pageSize) - 1);
      setTotalCount(nextTotalCount);
      setTotalGuilds(result.totalGuilds || 0);
      if (params.page > lastPage) {
        setPage(lastPage);
        return;
      }
      setRows(nextRows);
      setSelectedGuild((current) => {
        if (!current) return current;
        const currentId = String(current.guild_id || "");
        return nextRows.find((row) => String(row.guild_id || "") === currentId) || current;
      });
    } catch (error) {
      if (requestIdRef.current === requestId && !options.silent) onError(errorText(error));
    }
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | undefined;
    const params = { q: submittedQ, page, pageSize, sortColumn, sortDirection };

    const scheduleNext = () => {
      if (cancelled) return;
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => { void tick(); }, GUILDS_AUTO_REFRESH_MS);
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
  }, [submittedQ, page, pageSize, sortColumn, sortDirection, load]);

  async function openGuild(row: Record<string, unknown>) {
    const guildId = String(row.guild_id || "");
    if (selectedGuild && String(selectedGuild.guild_id || "") === guildId) {
      setSelectedGuild(null);
      setMemberRows([]);
      return;
    }
    setSelectedGuild(row);
    setMembersLoading(true);
    try {
      const result = await guildsApi.members(guildId);
      setMemberRows(result.rows || []);
    } catch (error) {
      onError(errorText(error));
    } finally {
      setMembersLoading(false);
    }
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
        <h2>Guilds</h2>
        <div className="action-row">
          <button onClick={() => void load({ q: submittedQ, page, pageSize, sortColumn, sortDirection })}>Refresh</button>
        </div>
      </div>
      <p className="action-help-note">Total Guilds: {totalGuilds.toLocaleString()}</p>
      <div className="action-row guilds-search-row">
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") submitSearch(); }}
          placeholder="Search guild name"
        />
        <button onClick={submitSearch}>Search</button>
        <button onClick={handleClearSearch} disabled={!q && !submittedQ}>Clear</button>
      </div>
      <DataTable
        rows={rows}
        columns={["guild_name", "guild_faction", "member_count", "guild_description"]}
        tableClassName="guilds-table"
        onRowClick={openGuild}
        sortColumn={sortColumn}
        sortDirection={sortDirection}
        onSort={handleSort}
        nonSortableColumns={["guild_description"]}
        rowKey={(row) => String(row.guild_id)}
        emptyMessage="No guilds have been found yet."
      />
      <div className="panel-title guilds-pagination-footer">
        <p className="action-help-note">Showing {rangeStart}-{rangeEnd} of {totalCount} rows.</p>
        <div className="database-pagination-controls">
          <label className="compact-select">
            Rows
            <select value={String(pageSize)} onChange={(event) => changePageSize(Number(event.target.value))}>
              {GUILDS_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
          <button disabled={!hasPreviousPage} onClick={() => setPage(0)}>First</button>
          <button disabled={!hasPreviousPage} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="muted database-page-indicator">Page {page + 1} of {totalPages}</span>
          <button disabled={!hasNextPage} onClick={() => setPage(page + 1)}>Next</button>
          <button disabled={!hasNextPage} onClick={() => setPage(totalPages - 1)}>Last</button>
        </div>
      </div>
      {selectedGuild && (
        <div className="guild-members-panel">
          <div className="panel-title">
            <h3>Members of {String(selectedGuild.guild_name || "Guild")}</h3>
            <button onClick={() => { setSelectedGuild(null); setMemberRows([]); }}>Close</button>
          </div>
          <DataTable
            rows={memberRows}
            columns={["character_name", "role_id"]}
            tableClassName="guild-members-table"
            emptyMessage={membersLoading ? "Loading members..." : "This guild has no members."}
            renderCell={(row, col) => {
              if (col === "role_id") return String(row.role_id) === "100" ? "Leader" : "Member";
              return formatCell(row[col]);
            }}
          />
        </div>
      )}
    </section>
  );
}
