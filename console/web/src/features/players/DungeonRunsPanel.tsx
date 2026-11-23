import { useEffect, useMemo, useRef, useState } from "react";
import { dungeonsApi } from "../../api/dungeons";
import type { DungeonLeaderboardEntry } from "../../api/dungeons";
import { playersApi } from "../../api/players";
import type { DungeonRun } from "../../api/players";
import { DataTable, useSortableRows } from "../../components/common/DataTable";
import { SegmentedControl } from "../../components/common/SegmentedControl";
import { dungeonDisplayName, formatDungeonDuration } from "./dungeonNames";

type DungeonView = "leaderboard" | "runs";
type PartyMember = DungeonRun["party"][number];
type ResolvedPlayer = { actorId: string; name: string };

const DUNGEON_VIEWS = [
  { value: "leaderboard", label: "Leaderboard" },
  { value: "runs", label: "All Runs" }
] as const satisfies ReadonlyArray<{ value: DungeonView; label: string }>;
const RUN_PAGE_SIZES = [25, 50, 100, 200] as const;

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// A number is taken as an actor id; anything else must name exactly one
// character (an exact name match wins over a partial one).
async function resolvePlayer(text: string): Promise<ResolvedPlayer | string> {
  const query = text.trim();
  if (/^\d+$/.test(query)) return { actorId: query, name: query };
  const result = await playersApi.list({ q: query, page: 0, pageSize: 200, status: "all", sortColumn: "character_name", sortDirection: "asc" });
  const rows = result.rows || [];
  const exact = rows.filter((row) => String(row.character_name || "").toLowerCase() === query.toLowerCase());
  const match = exact.length === 1 ? exact[0] : rows.length === 1 ? rows[0] : null;
  if (match) return { actorId: String(match.actor_id), name: String(match.character_name || match.actor_id) };
  return rows.length === 0 ? "No player matches that name." : "More than one player matches. Enter the full character name or actor ID.";
}

export function DungeonRunsPanel({ onOpenPlayer, onError }: {
  onOpenPlayer: (member: { actorId: number; characterName: string | null }) => void;
  onError: (text: string) => void;
}) {
  const [view, setView] = useState<DungeonView>("leaderboard");
  const [supported, setSupported] = useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [allEntries, setAllEntries] = useState<DungeonLeaderboardEntry[]>([]);
  const [playerEntries, setPlayerEntries] = useState<DungeonLeaderboardEntry[] | null>(null);
  const [playerBoardFailed, setPlayerBoardFailed] = useState(false);
  const [dungeonId, setDungeonId] = useState("");
  const [difficulty, setDifficulty] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [player, setPlayer] = useState<ResolvedPlayer | null>(null);
  const [playerError, setPlayerError] = useState("");
  const [runs, setRuns] = useState<DungeonRun[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalRuns, setTotalRuns] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(50);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const runsRequest = useRef(0);
  const playerSearchRequest = useRef(0);

  useEffect(() => {
    let active = true;
    setLoadFailed(false);
    dungeonsApi.leaderboard().then((result) => {
      if (!active) return;
      setSupported(result.capabilities?.dungeons === true);
      setAllEntries(result.entries || []);
    }).catch((error) => {
      if (!active) return;
      setLoadFailed(true);
      onError(errorText(error));
    });
    return () => { active = false; };
  }, [onError, refreshKey]);

  useEffect(() => {
    // Clear first so the previous player's board never shows under the new name.
    setPlayerEntries(null);
    setPlayerBoardFailed(false);
    if (!player) return undefined;
    let active = true;
    dungeonsApi.leaderboard({ playerId: player.actorId }).then((result) => {
      if (active) setPlayerEntries(result.entries || []);
    }).catch((error) => {
      if (!active) return;
      setPlayerBoardFailed(true);
      onError(errorText(error));
    });
    return () => { active = false; };
  }, [player, onError, refreshKey]);

  useEffect(() => {
    if (view !== "runs" || supported !== true) return;
    const request = ++runsRequest.current;
    setLoading(true);
    dungeonsApi.runs({ dungeonId, difficulty, playerId: player?.actorId, page, pageSize }).then((result) => {
      if (request !== runsRequest.current) return;
      const nextTotal = result.totalCount ?? 0;
      const lastPage = Math.max(0, Math.ceil(nextTotal / pageSize) - 1);
      if (page > lastPage) { setPage(lastPage); return; }
      setRuns(result.runs || []);
      setTotalCount(nextTotal);
      setTotalRuns(result.totalRuns ?? 0);
    }).catch((error) => {
      if (request === runsRequest.current) onError(errorText(error));
    }).finally(() => {
      if (request === runsRequest.current) setLoading(false);
    });
  }, [view, supported, dungeonId, difficulty, player, page, pageSize, onError, refreshKey]);

  const dungeonOptions = useMemo(() => [...new Set(allEntries.map((entry) => entry.best.dungeonId))]
    .map((id) => ({ id, name: dungeonDisplayName(id) }))
    .sort((a, b) => a.name.localeCompare(b.name)), [allEntries]);
  const difficultyOptions = useMemo(() => [...new Set(allEntries
    .filter((entry) => !dungeonId || entry.best.dungeonId === dungeonId)
    .map((entry) => entry.best.difficulty))].sort((a, b) => a - b), [allEntries, dungeonId]);

  const playerBoardLoading = Boolean(player) && playerEntries === null && !playerBoardFailed;
  const leaderboardRows = (player ? playerEntries ?? [] : allEntries)
    .filter((entry) => (!dungeonId || entry.best.dungeonId === dungeonId) && (difficulty === null || entry.best.difficulty === difficulty))
    .map((entry) => ({
      key: `${entry.best.dungeonId}:${entry.best.difficulty}`,
      dungeonId: entry.best.dungeonId,
      dungeon: dungeonDisplayName(entry.best.dungeonId),
      difficulty: entry.best.difficulty,
      best: entry.best.durationMs,
      party: entry.best.playerCount,
      members: entry.best.party,
      runs: entry.runCount
    }))
    .sort((a, b) => a.dungeon.localeCompare(b.dungeon) || a.difficulty - b.difficulty);
  const leaderboardSort = useSortableRows(leaderboardRows);
  // `total` and `count` are names the i18n extractor treats as numbers, so the
  // summary templates below are extracted with placeholders.
  const total = leaderboardRows.reduce((sum, row) => sum + row.runs, 0);
  const count = totalRuns;

  const runRows = runs.map((run) => ({
    completionId: run.completionId,
    dungeonId: run.dungeonId,
    dungeon: dungeonDisplayName(run.dungeonId),
    difficulty: run.difficulty,
    duration: run.durationMs,
    party: run.playerCount,
    members: run.party
  }));
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const rangeStart = totalCount === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = Math.min(totalCount, (page + 1) * pageSize);
  const filtered = Boolean(dungeonId || difficulty !== null || player);

  function changeDungeon(next: string) {
    setDungeonId(next);
    setDifficulty(null);
    setPage(0);
  }

  function changeDifficulty(next: string) {
    setDifficulty(next === "" ? null : Number(next));
    setPage(0);
  }

  async function submitPlayer() {
    if (!q.trim()) { clearPlayer(); return; }
    const request = ++playerSearchRequest.current;
    setPlayerError("");
    try {
      const resolved = await resolvePlayer(q);
      if (request !== playerSearchRequest.current) return;
      // A failed lookup drops the old filter so the results match what's typed.
      if (typeof resolved === "string") { setPlayerError(resolved); setPlayer(null); setPage(0); return; }
      setPlayer(resolved);
      setPage(0);
    } catch (error) {
      if (request === playerSearchRequest.current) onError(errorText(error));
    }
  }

  function clearPlayer() {
    ++playerSearchRequest.current;
    setQ("");
    setPlayer(null);
    setPlayerError("");
    setPage(0);
  }

  function renderParty(count: unknown, members: PartyMember[]) {
    return <span className="dungeon-party" data-no-translate>
      {`${count} · `}
      {members.map((member, index) => <span key={member.controllerId}>
        {index > 0 && ", "}
        {member.actorId !== null
          ? <button type="button" className="dungeon-party-link" onClick={() => onOpenPlayer({ actorId: member.actorId as number, characterName: member.characterName })}>{member.characterName || `Controller ${member.controllerId}`}</button>
          : `Controller ${member.controllerId}`}
      </span>)}
    </span>;
  }

  function renderCell(row: Record<string, unknown>, col: string) {
    if (col === "dungeon") return <span title={String(row.dungeonId)} data-no-translate>{String(row.dungeon)}</span>;
    if (col === "best" || col === "duration") return <span data-no-translate>{formatDungeonDuration(Number(row[col]))}</span>;
    if (col === "party") return renderParty(row.party, row.members as PartyMember[]);
    return <span data-no-translate>{String(row[col])}</span>;
  }

  if (supported === false) return <p className="action-help-note">Dungeon runs aren't available on this database version.</p>;
  if (loadFailed && supported === null) return <div className="action-row">
    <p className="action-help-note danger">Dungeon runs couldn't be loaded.</p>
    <button onClick={() => setRefreshKey((key) => key + 1)}>Refresh</button>
  </div>;

  return <div className="dungeon-runs-panel">
    <div className="action-row dungeon-runs-filters">
      <SegmentedControl name="dungeon-runs-view" ariaLabel="Dungeon Runs View" value={view} options={DUNGEON_VIEWS} onChange={setView} />
      <select aria-label="Dungeon" value={dungeonId} onChange={(event) => changeDungeon(event.target.value)}>
        <option value="">All Dungeons</option>
        {dungeonOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select>
      <select aria-label="Difficulty" value={difficulty === null ? "" : String(difficulty)} onChange={(event) => changeDifficulty(event.target.value)}>
        <option value="">All Difficulties</option>
        {difficultyOptions.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
      <button onClick={() => setRefreshKey((key) => key + 1)}>Refresh</button>
    </div>
    <div className="action-row players-search-row">
      <input
        value={q}
        onChange={(event) => {
          ++playerSearchRequest.current;
          setQ(event.target.value);
        }}
        onKeyDown={(event) => { if (event.key === "Enter") void submitPlayer(); }}
        placeholder="Filter by Character Name or Actor ID"
        aria-label="Filter by Character Name or Actor ID"
      />
      <button onClick={() => void submitPlayer()}>Search</button>
      <button onClick={clearPlayer} disabled={!q && !player}>Clear</button>
    </div>
    {playerError && <p className="action-help-note danger" role="status">{playerError}</p>}
    {player && <p className="action-help-note">Showing runs for <strong data-no-translate>{player.name}</strong></p>}

    {view === "leaderboard" ? <>
      <p className="action-help-note">{playerBoardFailed ? "Dungeon runs couldn't be loaded." : supported === null || playerBoardLoading
        ? "Loading dungeon runs…"
        : `${leaderboardRows.length.toLocaleString()} dungeon and difficulty pairs · ${total.toLocaleString()} runs`}</p>
      {!playerBoardFailed && <DataTable
        rows={leaderboardSort.sortedRows}
        columns={["dungeon", "difficulty", "best", "party", "runs"]}
        columnLabels={{ dungeon: "Dungeon", difficulty: "Difficulty", best: "Best Time", party: "Party", runs: "Runs" }}
        sortColumn={leaderboardSort.sortColumn}
        sortDirection={leaderboardSort.sortDirection}
        onSort={leaderboardSort.onSort}
        tableClassName="dungeon-runs-table"
        rowKey={(row) => String(row.key)}
        emptyMessage={supported === null || playerBoardLoading ? "Loading dungeon runs…" : filtered ? "No runs match these filters." : "No dungeon runs recorded."}
        renderCell={renderCell}
      />}
    </> : <>
      <p className="action-help-note">{loading
        ? "Loading dungeon runs…"
        : filtered
        ? `${totalCount.toLocaleString()} of ${count.toLocaleString()} runs · Newest First`
        : `${count.toLocaleString()} runs · Newest First`}</p>
      <DataTable
        rows={runRows}
        columns={["dungeon", "difficulty", "duration", "party"]}
        columnLabels={{ dungeon: "Dungeon", difficulty: "Difficulty", duration: "Duration", party: "Party" }}
        tableClassName="dungeon-runs-table"
        rowKey={(row) => String(row.completionId)}
        emptyMessage={loading ? "Loading dungeon runs…" : filtered ? "No runs match these filters." : "No dungeon runs recorded."}
        renderCell={renderCell}
      />
      <div className="panel-title players-pagination-footer">
        <p className="action-help-note">Showing {rangeStart}-{rangeEnd} of {totalCount.toLocaleString()}</p>
        <div className="database-pagination-controls">
          <label className="compact-select">
            Rows
            <select value={String(pageSize)} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(0); }}>
              {RUN_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
          <button disabled={page === 0} onClick={() => setPage(0)}>First</button>
          <button disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="muted database-page-indicator">Page {page + 1} of {totalPages}</span>
          <button disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>Next</button>
          <button disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>Last</button>
        </div>
      </div>
    </>}
  </div>;
}
