import { PermissionGate } from "../../lib/consoleAccess";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronsDown, ChevronsUp, Trash2 } from "lucide-react";
import { guildsApi } from "../../api/guilds";
import { playersApi } from "../../api/players";
import { DataTable, type SortDirection } from "../../components/common/DataTable";
import { formatCell } from "../../lib/display";

type GuildsPanelProps = {
  onError: (text: string) => void;
  confirmAction: (message: string, options?: { title?: string; confirmLabel?: string; warning?: string; danger?: boolean; details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] }) => Promise<boolean>;
};

const GUILDS_AUTO_REFRESH_MS = 10_000;
const GUILDS_PAGE_SIZES = [25, 50, 100, 200] as const;
const GUILDS_DEFAULT_PAGE_SIZE = 50;
// Must match GUILD_OFFICER_ROLE_ID/GUILD_LEADER_ROLE_ID in console/api/src/duneDb.js -- there is
// no shared constants module across the frontend/backend boundary, so this has to be kept in
// sync by hand.
const GUILD_OFFICER_ROLE_ID = 50;
const GUILD_LEADER_ROLE_ID = 100;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function guildRoleLabel(roleId: unknown): string {
  const value = Number(roleId);
  if (value >= GUILD_LEADER_ROLE_ID) return "Leader";
  if (value >= GUILD_OFFICER_ROLE_ID) return "Officer";
  return "Member";
}

type GuildsLoadParams = { q: string; page: number; pageSize: number; sortColumn: string; sortDirection: SortDirection };

export function GuildsPanel({ onError, confirmAction }: GuildsPanelProps) {
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
  const [promotingId, setPromotingId] = useState("");
  const [demotingId, setDemotingId] = useState("");
  const [removingId, setRemovingId] = useState("");
  const [disbandingId, setDisbandingId] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState("");
  const [addResults, setAddResults] = useState<Record<string, unknown>[]>([]);
  const [addSearching, setAddSearching] = useState(false);
  const [addSelected, setAddSelected] = useState<Record<string, unknown> | null>(null);
  const [addRoleId, setAddRoleId] = useState(1);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState("");
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

  async function refreshMembers(guildId: string) {
    setMembersLoading(true);
    try {
      const result = await guildsApi.members(guildId);
      setMemberRows(result.rows || []);
    } finally {
      setMembersLoading(false);
    }
  }

  async function openGuild(row: Record<string, unknown>) {
    const guildId = String(row.guild_id || "");
    if (selectedGuild && String(selectedGuild.guild_id || "") === guildId) {
      setSelectedGuild(null);
      setMemberRows([]);
      return;
    }
    setSelectedGuild(row);
    try {
      await refreshMembers(guildId);
    } catch (error) {
      onError(errorText(error));
    }
  }

  async function handlePromote(row: Record<string, unknown>) {
    const guildId = String(selectedGuild?.guild_id || "");
    const playerId = String(row.player_id || "");
    const name = String(row.character_name || "this member");
    const guildName = String(selectedGuild?.guild_name || "this guild");
    const isOfficer = Number(row.role_id) >= GUILD_OFFICER_ROLE_ID;
    const currentLeader = memberRows.find((member) => Number(member.role_id) >= GUILD_LEADER_ROLE_ID);
    const leaderName = currentLeader ? String(currentLeader.character_name || "the current leader") : "";
    const confirmed = await confirmAction(
      isOfficer
        ? (leaderName
            ? `Promote ${name} to Leader of ${guildName}? ${leaderName} will be demoted to Officer.`
            : `Promote ${name} to Leader of ${guildName}?`)
        : `Promote ${name} to Officer of ${guildName}?`,
      { title: isOfficer ? "Promote to Leader" : "Promote to Officer", confirmLabel: "Promote" }
    );
    if (!confirmed) return;
    onError("");
    setPromotingId(playerId);
    try {
      const response = await guildsApi.promote(guildId, playerId);
      await refreshMembers(guildId);
      if (response.result?.alreadyLeader) {
        onError(`${name} was already the guild leader -- no changes were made.`);
      }
    } catch (error) {
      onError(errorText(error));
    } finally {
      setPromotingId("");
    }
  }

  async function handleDemote(row: Record<string, unknown>) {
    const guildId = String(selectedGuild?.guild_id || "");
    const playerId = String(row.player_id || "");
    const name = String(row.character_name || "this member");
    const guildName = String(selectedGuild?.guild_name || "this guild");
    const confirmed = await confirmAction(`Demote ${name} to Member of ${guildName}?`, { title: "Demote to Member", confirmLabel: "Demote" });
    if (!confirmed) return;
    onError("");
    setDemotingId(playerId);
    try {
      await guildsApi.demote(guildId, playerId);
      await refreshMembers(guildId);
    } catch (error) {
      onError(errorText(error));
    } finally {
      setDemotingId("");
    }
  }

  async function handleRemove(row: Record<string, unknown>) {
    const guildId = String(selectedGuild?.guild_id || "");
    const playerId = String(row.player_id || "");
    const name = String(row.character_name || "this member");
    const guildName = String(selectedGuild?.guild_name || "this guild");
    const confirmed = await confirmAction(`Remove ${name} from ${guildName}?`, { title: "Remove Member", confirmLabel: "Remove" });
    if (!confirmed) return;
    onError("");
    setRemovingId(playerId);
    try {
      await guildsApi.removeMember(guildId, playerId);
      await refreshMembers(guildId);
    } catch (error) {
      onError(errorText(error));
    } finally {
      setRemovingId("");
    }
  }

  async function handleDisband(row: Record<string, unknown>) {
    const guildId = String(row.guild_id || "");
    const name = String(row.guild_name || "this guild");
    // The row's own member_count can be several seconds stale (only refreshed by the 10s
    // auto-refresh poll or a manual action) -- fetch the live count for this irreversible
    // action's confirmation, falling back to the stale value if the fetch itself fails.
    let memberCount = Number(row.member_count || 0);
    try {
      const fresh = await guildsApi.members(guildId);
      memberCount = (fresh.rows || []).length;
    } catch {
      // Fall back to the guild list's own count above.
    }
    const confirmed = await confirmAction(
      `Disband ${name}? This permanently deletes the guild and removes all its members.`,
      { title: "Disband Guild", confirmLabel: "Disband", danger: true, details: [{ label: "Members", value: String(memberCount), tone: "danger" }] }
    );
    if (!confirmed) return;
    onError("");
    setDisbandingId(guildId);
    try {
      await guildsApi.disband(guildId, "DISBAND GUILD");
      if (String(selectedGuild?.guild_id || "") === guildId) {
        setSelectedGuild(null);
        setMemberRows([]);
      }
      await load({ q: submittedQ, page, pageSize, sortColumn, sortDirection });
    } catch (error) {
      onError(errorText(error));
    } finally {
      setDisbandingId("");
    }
  }

  function openAddModal() {
    setAddQuery("");
    setAddResults([]);
    setAddSelected(null);
    setAddRoleId(1);
    setAddError("");
    setAddOpen(true);
  }

  function closeAddModal() {
    setAddOpen(false);
  }

  async function submitAddSearch() {
    const query = addQuery.trim();
    if (!query) return;
    setAddSearching(true);
    setAddError("");
    try {
      const result = await playersApi.list({ q: query, pageSize: 8, status: "all" });
      setAddResults(result.rows || []);
    } catch (error) {
      setAddError(errorText(error));
    } finally {
      setAddSearching(false);
    }
  }

  async function handleAddMember() {
    if (!addSelected || !selectedGuild) return;
    const guildId = String(selectedGuild.guild_id || "");
    const playerId = String(addSelected.actor_id || addSelected.player_id || "");
    setAddBusy(true);
    setAddError("");
    try {
      await guildsApi.addMember(guildId, playerId, addRoleId);
      await refreshMembers(guildId);
      closeAddModal();
    } catch (error) {
      setAddError(errorText(error));
    } finally {
      setAddBusy(false);
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
        actionClassName="actions-column"
        onRowClick={openGuild}
        sortColumn={sortColumn}
        sortDirection={sortDirection}
        onSort={handleSort}
        nonSortableColumns={["guild_description"]}
        rowKey={(row) => String(row.guild_id)}
        emptyMessage="No guilds have been found yet."
        action={(row) => {
          const guildId = String(row.guild_id || "");
          return (
            <PermissionGate action="guilds:disband"><button
              className="icon-toggle-button danger"
              disabled={disbandingId === guildId}
              title="Disband guild"
              aria-label={`Disband ${String(row.guild_name || "guild")}`}
              onClick={(event) => { event.stopPropagation(); void handleDisband(row); }}
            ><Trash2 size={16} /></button></PermissionGate>
          );
        }}
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
            <h3>
              Members of {String(selectedGuild.guild_name || "Guild")}
              {membersLoading && <span className="muted"> (refreshing...)</span>}
            </h3>
            <div className="action-row">
              <PermissionGate action="guilds:membership"><button onClick={openAddModal}>Add Member</button></PermissionGate>
              <button onClick={() => { setSelectedGuild(null); setMemberRows([]); }}>Close</button>
            </div>
          </div>
          <DataTable
            rows={memberRows}
            columns={["character_name", "role_id"]}
            tableClassName="guild-members-table"
            actionClassName="actions-column"
            rowKey={(row) => String(row.player_id)}
            emptyMessage={membersLoading ? "Loading members..." : "This guild has no members."}
            renderCell={(row, col) => {
              if (col === "role_id") return guildRoleLabel(row.role_id);
              return formatCell(row[col]);
            }}
            action={(row) => {
              const role = Number(row.role_id);
              const isLeader = role >= GUILD_LEADER_ROLE_ID;
              const isOfficer = role >= GUILD_OFFICER_ROLE_ID && role < GUILD_LEADER_ROLE_ID;
              const isMember = role < GUILD_OFFICER_ROLE_ID;
              const playerId = String(row.player_id || "");
              const name = String(row.character_name || "member");
              return (
                <span className="icon-toggle-group guild-member-actions">
                  <PermissionGate action="guilds:rank"><button
                    className="icon-toggle-button success"
                    disabled={isLeader || promotingId === playerId}
                    title={isLeader ? "Already the guild leader" : (isOfficer ? "Promote to Leader" : "Promote to Officer")}
                    aria-label={isLeader ? "Cannot promote the leader further" : `Promote ${name} to ${isOfficer ? "Leader" : "Officer"}`}
                    onClick={(event) => { event.stopPropagation(); void handlePromote(row); }}
                  ><ChevronsUp size={16} /></button></PermissionGate>
                  <PermissionGate action="guilds:rank"><button
                    className="icon-toggle-button warning"
                    disabled={isLeader || isMember || demotingId === playerId}
                    title={isLeader ? "Promote another member before demoting the leader" : (isMember ? "Already the lowest rank" : "Demote to Member")}
                    aria-label={isLeader ? "Cannot demote the leader" : (isMember ? `Cannot demote ${name} further` : `Demote ${name} to Member`)}
                    onClick={(event) => { event.stopPropagation(); void handleDemote(row); }}
                  ><ChevronsDown size={16} /></button></PermissionGate>
                  <PermissionGate action="guilds:membership"><button
                    className="icon-toggle-button danger"
                    disabled={isLeader || removingId === playerId}
                    title={isLeader ? "Promote another member before removing the leader" : "Remove from guild"}
                    aria-label={isLeader ? "Cannot remove the leader" : `Remove ${name} from guild`}
                    onClick={(event) => { event.stopPropagation(); void handleRemove(row); }}
                  ><Trash2 size={16} /></button></PermissionGate>
                </span>
              );
            }}
          />
        </div>
      )}
      {addOpen && selectedGuild && (
        <PermissionGate action="guilds:membership"><div className="modal-overlay" role="presentation" onMouseDown={closeAddModal}>
          <section className="confirm-modal guild-add-member-modal" role="dialog" aria-modal="true" aria-labelledby="guild-add-member-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="confirm-modal-title">
              <h3 id="guild-add-member-title">Add Member to {String(selectedGuild.guild_name || "Guild")}</h3>
            </div>
            {!addSelected ? (
              <>
                <p>Search for a character to add.</p>
                <div className="action-row guild-add-member-search-row">
                  <input
                    value={addQuery}
                    onChange={(event) => setAddQuery(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") void submitAddSearch(); }}
                    placeholder="Search character name"
                  />
                  <button onClick={() => void submitAddSearch()} disabled={addSearching || !addQuery.trim()}>{addSearching ? "Searching..." : "Search"}</button>
                </div>
                <div className="guild-add-member-results">
                  {addResults.length === 0 && <p className="action-help-note">No results yet. Enter a name and press Search.</p>}
                  {addResults.map((candidate) => (
                    <button
                      key={String(candidate.actor_id || candidate.player_id)}
                      className="guild-add-member-result"
                      onClick={() => setAddSelected(candidate)}
                    >
                      {String(candidate.character_name || "Unknown")}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="guild-add-member-selected">
                  <span>{String(addSelected.character_name || "Selected player")}</span>
                  <button onClick={() => setAddSelected(null)}>Change</button>
                </div>
                <label className="compact-select">
                  Rank
                  <select value={String(addRoleId)} onChange={(event) => setAddRoleId(Number(event.target.value))}>
                    <option value="1">Member</option>
                    <option value="50">Officer</option>
                  </select>
                </label>
              </>
            )}
            {addError && <p className="danger-note">{addError}</p>}
            <div className="confirm-modal-actions">
              <button onClick={closeAddModal}>Cancel</button>
              <PermissionGate action="guilds:membership"><button className="success" disabled={!addSelected || addBusy} onClick={() => void handleAddMember()}>{addBusy ? "Adding..." : "Add to Guild"}</button></PermissionGate>
            </div>
          </section>
        </div></PermissionGate>
      )}
    </section>
  );
}
