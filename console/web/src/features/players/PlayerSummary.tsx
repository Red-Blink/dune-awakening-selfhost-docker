import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { MapPin, Shield, Coins, CircleDollarSign, Banknote, ChevronDown, ChevronUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PlayerStatusCell } from "../../components/common/DisplayPrimitives";
import { firstDefined } from "../../lib/display";
import { playersApi } from "../../api/players";
import type { DungeonRun } from "../../api/players";
import { DataTable, useSortableRows } from "../../components/common/DataTable";
import { dungeonDisplayName, formatDungeonDuration } from "./dungeonNames";

const currencyIcon = (label: string): LucideIcon => {
  if (label === "Solari Credit") return CircleDollarSign;
  if (label === "Scrip" || label === "House Credit") return Banknote;
  return Coins;
};

type CurrencyRow = { currency_id: number | string; balance: number; label?: string };
type FactionRow = { faction_id: number; faction_name?: string; reputation_amount: number; component_reputation_amount?: number | null; reputation_in_sync?: boolean; estimated_rank?: number; current_rank_limit?: number | null; rank_limited_by_progression?: boolean; progression_repair_available?: boolean; progression_repair_target?: number | null };
type FactionRepairResult = { tone: "success" | "danger" | "neutral"; text: string; pending?: boolean };
type Progression = { level?: number; xp?: number; totalSkillPoints?: number; unspentSkillPoints?: number };
type DungeonRuns = { runs: DungeonRun[]; totalRuns: number; truncated: boolean };
type Vitals = { currentHealth: number | null; maxHealth: number; maxHealthEstimated: boolean; hydration: number | null; maxHydration: number; spiceAddictionLevel: number | null; maxSpiceAddictionLevel: number };
const PLAYER_STATS_REFRESH_MS = 30_000;
const BEST_TIME_CHIP_LIMIT = 8;
const DUNGEON_RUNS_PREVIEW_LIMIT = 5;

function VitalMeter({ value, max, tone = "good" }: { value: number | null; max: number; tone?: "good" | "warn" }) {
  const percent = value === null || max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return <div className={`summary-meter summary-meter-${tone}`} aria-hidden="true"><span style={{ width: `${percent}%` }} /></div>;
}

export function PlayerSummary({
  detail,
  fallback,
  dbPlayerId,
  actionPlayerId,
  refreshKey = 0,
  onRepairFactionReputation,
  factionRepairDisabled = false,
  factionRepairResult,
  actions
}: {
  detail: Record<string, unknown> | null;
  fallback: Record<string, unknown>;
  dbPlayerId: string;
  actionPlayerId: string;
  refreshKey?: number;
  onRepairFactionReputation?: () => void | Promise<void>;
  factionRepairDisabled?: boolean;
  factionRepairResult?: FactionRepairResult | null;
  actions?: ReactNode;
}) {
  const player = ((detail?.player as Record<string, unknown> | undefined) || fallback) as Record<string, unknown>;
  const status = firstDefined(player.online_status, fallback.online_status);
  const [currencyRows, setCurrencyRows] = useState<CurrencyRow[]>([]);
  const [factionRows, setFactionRows] = useState<FactionRow[] | null>(null);
  const [progression, setProgression] = useState<Progression | null>(null);
  const [intel, setIntel] = useState<number | null>(null);
  const [solarisCoinTotal, setSolarisCoinTotal] = useState<number | null>(null);
  const [vitals, setVitals] = useState<Vitals | null>(null);
  const [dungeonRuns, setDungeonRuns] = useState<DungeonRuns | null>(null);
  const [showAllBestTimes, setShowAllBestTimes] = useState(false);
  const [showAllDungeonRuns, setShowAllDungeonRuns] = useState(false);
  const [showIdentity, setShowIdentity] = useState(false);
  useEffect(() => {
    setShowAllBestTimes(false);
    setShowAllDungeonRuns(false);
    setShowIdentity(false);
  }, [dbPlayerId]);
  const loadRequest = useRef(0);

  useEffect(() => {
    if (!dbPlayerId) {
      setCurrencyRows([]);
      setFactionRows(null);
      setProgression(null);
      setIntel(null);
      setSolarisCoinTotal(null);
      setVitals(null);
      setDungeonRuns(null);
      return;
    }
    let active = true;
    let loading = false;
    const loadStats = async () => {
      if (loading) return;
      loading = true;
      const request = ++loadRequest.current;
      try {
        const [currency, factions, progressionResult, intelResult, solarisCoinResult, vitalsResult, dungeonsResult] = await Promise.allSettled([
          playersApi.currency(dbPlayerId),
          playersApi.factions(dbPlayerId),
          playersApi.progression(dbPlayerId),
          playersApi.intel(dbPlayerId),
          playersApi.solarisCoin(dbPlayerId),
          playersApi.vitals(dbPlayerId),
          playersApi.dungeons(dbPlayerId)
        ]);
        if (!active || request !== loadRequest.current) return;
        setCurrencyRows(currency.status === "fulfilled" ? ((currency.value.rows || []) as CurrencyRow[]) : []);
        setFactionRows(
          factions.status === "fulfilled" && factions.value.capabilities?.factions === true
            ? ((factions.value.rows || []) as FactionRow[])
            : null
        );
        setProgression(progressionResult.status === "fulfilled" && progressionResult.value.capabilities?.progression ? progressionResult.value : null);
        setIntel(intelResult.status === "fulfilled" && intelResult.value.capabilities?.intel ? (intelResult.value.intel ?? null) : null);
        setSolarisCoinTotal(solarisCoinResult.status === "fulfilled" && solarisCoinResult.value.capabilities?.solarisCoin ? (solarisCoinResult.value.total ?? null) : null);
        setVitals(vitalsResult.status === "fulfilled" && vitalsResult.value.capabilities?.vitals
          ? {
              currentHealth: vitalsResult.value.currentHealth ?? null,
              maxHealth: vitalsResult.value.maxHealth ?? 0,
              maxHealthEstimated: vitalsResult.value.maxHealthEstimated ?? true,
              hydration: vitalsResult.value.hydration ?? null,
              maxHydration: vitalsResult.value.maxHydration ?? 0,
              spiceAddictionLevel: vitalsResult.value.spiceAddictionLevel ?? null,
              maxSpiceAddictionLevel: vitalsResult.value.maxSpiceAddictionLevel ?? 0
            }
          : null);
        setDungeonRuns(dungeonsResult.status === "fulfilled" && dungeonsResult.value.capabilities?.dungeons
          ? { runs: dungeonsResult.value.runs || [], totalRuns: dungeonsResult.value.totalRuns ?? 0, truncated: dungeonsResult.value.truncated === true }
          : null);
      } finally {
        loading = false;
      }
    };

    void loadStats();
    const timer = window.setInterval(() => { void loadStats(); }, PLAYER_STATS_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [dbPlayerId, refreshKey]);

  const text = (value: unknown): string => (value === undefined || value === null ? "" : String(value));
  const idText = (value: unknown): string => {
    const resolved = text(value);
    return resolved === "0" ? "" : resolved;
  };
  const characterName = text(firstDefined(player.character_name, player.name, fallback.character_name)) || "—";
  const funcomId = text(firstDefined(player.funcom_id, fallback.funcom_id));
  const map = text(firstDefined(player.map, player.world, fallback.map)) || "—";
  const guild = text(firstDefined(player.guild, fallback.guild)) || "—";
  const faction = text(firstDefined(player.faction, fallback.faction)) || "Neutral";
  const flsId = text(firstDefined(player.fls_id, fallback.fls_id, actionPlayerId)) || "missing";
  const accountId = idText(firstDefined(player.account_id, fallback.account_id));
  const controllerId = idText(firstDefined(player.player_controller_id, fallback.player_controller_id));
  const playerStateId = idText(player.player_state_id);
  const platformId = text(player.platform_id);
  const platformName = text(player.platform_name);

  const platformLabel = platformName ? `${platformName} ID` : "Platform ID";
  const platformValue = platformId || "—";

  const identityRows: { label: string; value: string }[] = [
    { label: platformLabel, value: platformValue },
    { label: "Funcom ID", value: funcomId || "—" },
    { label: "FLS ID", value: flsId },
  ];
  const databaseIdRows: { label: string; value: string }[] = [
    { label: "DB Player", value: dbPlayerId || "missing" },
    { label: "Account", value: accountId || "—" },
    { label: "Player Controller", value: controllerId || "—" },
    { label: "Player State", value: playerStateId || "—" }
  ];

  const currencyItems: { label: string; value: string }[] = [];
  currencyRows
    .filter((row) => row.label === "Solari Credit")
    .forEach((row) => currencyItems.push({ label: "Solari Credit", value: Number(row.balance).toLocaleString() }));
  if (solarisCoinTotal !== null) currencyItems.push({ label: "Solari Coin", value: solarisCoinTotal.toLocaleString() });
  currencyRows
    .filter((row) => row.label !== "Solari Credit")
    .forEach((row) => currencyItems.push({ label: row.label || `Currency ${row.currency_id}`, value: Number(row.balance).toLocaleString() }));
  const currencyTiles = currencyItems.map((item) => ({ ...item, Icon: currencyIcon(item.label) }));

  const dungeonRows = (dungeonRuns?.runs || []).map((run) => ({
    completionId: run.completionId,
    dungeonId: run.dungeonId,
    dungeon: dungeonDisplayName(run.dungeonId),
    difficulty: run.difficulty,
    duration: run.durationMs,
    party: run.playerCount,
    partyNames: run.party.map((member) => member.characterName || `Controller ${member.controllerId}`).join(", ")
  }));
  const dungeonSort = useSortableRows(dungeonRows);
  type DungeonRow = (typeof dungeonRows)[number];
  const bestDungeonTimes = Object.values(dungeonRows.reduce<Record<string, DungeonRow>>((best, row) => {
    const key = `${row.dungeonId}:${row.difficulty}`;
    if (!best[key] || row.duration < best[key].duration) best[key] = row;
    return best;
  }, {}));
  // One row of best-time chips per dungeon, by difficulty; the dungeon's fastest is highlighted.
  const bestByDungeon = Object.values(bestDungeonTimes.reduce<Record<string, { dungeonId: string; dungeon: string; entries: DungeonRow[] }>>((groups, row) => {
    (groups[row.dungeonId] ??= { dungeonId: row.dungeonId, dungeon: row.dungeon, entries: [] }).entries.push(row);
    return groups;
  }, {}))
    .map((group) => {
      const entries = [...group.entries].sort((a, b) => a.difficulty - b.difficulty);
      const fastest = entries.reduce((best, row) => (row.duration < best.duration ? row : best), entries[0]);
      return { ...group, entries, fastestDifficulty: fastest.difficulty };
    })
    .sort((a, b) => a.dungeon.localeCompare(b.dungeon));
  const hasHiddenChips = bestByDungeon.some((group) => group.entries.length > BEST_TIME_CHIP_LIMIT);
  const hardest = bestDungeonTimes.reduce<DungeonRow | null>((top, row) => (!top || row.difficulty > top.difficulty || (row.difficulty === top.difficulty && row.duration < top.duration) ? row : top), null);
  const fastestClear = bestDungeonTimes.reduce<DungeonRow | null>((top, row) => (!top || row.duration < top.duration ? row : top), null);
  const visibleDungeonRows = showAllDungeonRuns ? dungeonSort.sortedRows : dungeonSort.sortedRows.slice(0, DUNGEON_RUNS_PREVIEW_LIMIT);
  const showStats = Boolean(progression) || intel !== null || Boolean(dungeonRuns);
  const showCurrency = currencyRows.length > 0 || solarisCoinTotal !== null;
  // Without a dungeon card the main column would sit mostly empty, so Vitals and Currency move into it.
  const hasDungeonCard = Boolean(dungeonRuns && dungeonRuns.totalRuns > 0);

  const vitalsCard = vitals && <div className="summary-block summary-card">
    <div className="summary-block-label">Vitals</div>
    <div className="summary-vital">
      <div className="summary-vital-row"><span>Health</span><strong>{vitals.currentHealth !== null ? `${Math.round(vitals.currentHealth).toLocaleString()} / ${vitals.maxHealth.toLocaleString()}${vitals.maxHealthEstimated ? " (estimated max)" : ""}` : "—"}</strong></div>
      <VitalMeter value={vitals.currentHealth} max={vitals.maxHealth} />
    </div>
    <div className="summary-vital">
      <div className="summary-vital-row"><span>Hydration</span><strong>{vitals.hydration !== null ? `${Math.round(vitals.hydration).toLocaleString()} / ${vitals.maxHydration.toLocaleString()}` : "—"}</strong></div>
      <VitalMeter value={vitals.hydration} max={vitals.maxHydration} />
    </div>
    <div className="summary-vital">
      <div className="summary-vital-row"><span>Spice Addiction</span><strong>{vitals.spiceAddictionLevel !== null ? `${Math.round(vitals.spiceAddictionLevel).toLocaleString()} / ${vitals.maxSpiceAddictionLevel.toLocaleString()}` : "—"}</strong></div>
      <VitalMeter value={vitals.spiceAddictionLevel} max={vitals.maxSpiceAddictionLevel} tone="warn" />
    </div>
  </div>;

  const currencyCard = showCurrency && <div className="summary-block summary-card">
    <div className="summary-block-label">Currency</div>
    <div className="summary-currency">
      {currencyTiles.map(({ label, value, Icon }) => <div className="summary-currency-tile" key={label}>
        <Icon size={16} className="summary-currency-icon" aria-hidden="true" />
        <span>{label}</span>
        <strong>{value}</strong>
      </div>)}
    </div>
  </div>;

  return <section className="action-section player-summary">
    <div className="summary-hero">
      <div className="summary-hero-text">
        <div className="summary-hero-main">
          <span className="summary-hero-name">{characterName}</span>
          <PlayerStatusCell value={status} />
        </div>
        <div className="summary-hero-sub">
          <span className="summary-hero-meta summary-hero-map"><MapPin size={14} className="summary-hero-icon" aria-label="Map" /><span>{map}</span></span>
          <span className="summary-hero-meta summary-hero-guild"><Shield size={14} className="summary-hero-icon" aria-label="Guild" /><span>{guild}</span></span>
        </div>
      </div>
      {actions}
    </div>

    <div className="summary-layout">
      <div className="summary-main">
        {showStats && <div className="summary-stats">
          {progression && <>
            <div className="summary-stat summary-stat-level">
              <span>Level</span>
              <strong data-no-translate>{String(progression.level ?? 0)}</strong>
              <small><span data-no-translate>{(progression.xp ?? 0).toLocaleString()}</span> <span>XP</span></small>
            </div>
            <div className="summary-stat"><span>Skill Points</span><strong>{`${progression.unspentSkillPoints ?? 0} / ${progression.totalSkillPoints ?? 0}`}</strong></div>
          </>}
          {intel !== null && <div className="summary-stat"><span>Available Intel</span><strong>{intel.toLocaleString()}</strong></div>}
          {dungeonRuns && <div className="summary-stat"><span>Dungeon Runs</span><strong>{dungeonRuns.totalRuns.toLocaleString()}</strong></div>}
        </div>}

        {!hasDungeonCard && (vitalsCard || currencyCard) && <div className="summary-main-pair">
          {vitalsCard}
          {currencyCard}
        </div>}

        {dungeonRuns && hasDungeonCard && <div className="summary-block summary-card summary-dungeons">
          <div className="summary-block-label">Dungeon Runs</div>
            <div className="summary-mini-stats">
              <div className="summary-mini-stat"><span>Dungeons</span><strong data-no-translate>{bestByDungeon.length.toLocaleString()}</strong></div>
              {hardest && <div className="summary-mini-stat"><span>Highest Difficulty</span><strong data-no-translate>{hardest.difficulty}</strong><small data-no-translate>{hardest.dungeon}</small></div>}
              {fastestClear && <div className="summary-mini-stat"><span>Fastest Clear</span><strong data-no-translate>{formatDungeonDuration(fastestClear.duration)}</strong><small data-no-translate>{`${fastestClear.dungeon} · ${fastestClear.difficulty}`}</small></div>}
            </div>
            {dungeonRuns.truncated && <p className="summary-dungeons-truncated">{`Showing the latest ${dungeonRows.length.toLocaleString()} runs.`}</p>}

            <div className="summary-block-label summary-sublabel">Best Time by Difficulty</div>
            <div className="summary-best-list">
              {bestByDungeon.map((group) => {
                const visible = showAllBestTimes ? group.entries : group.entries.slice(0, BEST_TIME_CHIP_LIMIT);
                const hidden = group.entries.length - visible.length;
                return <div className="summary-best-row" key={group.dungeonId}>
                  <span className="summary-best-name" title={group.dungeonId} data-no-translate>{group.dungeon}</span>
                  <div className="summary-chips" data-no-translate>
                    {visible.map((row) => <span
                      key={row.difficulty}
                      className={`summary-chip${row.difficulty === group.fastestDifficulty ? " summary-chip-best" : ""}`}
                      title={`Difficulty ${row.difficulty}`}
                    ><span className="summary-chip-difficulty">{row.difficulty}</span> <strong>{formatDungeonDuration(row.duration)}</strong></span>)}
                    {hidden > 0 && <button type="button" className="summary-chip summary-chip-more" onClick={() => setShowAllBestTimes(true)}>{`+${hidden}`}</button>}
                  </div>
                </div>;
              })}
            </div>
            {hasHiddenChips && showAllBestTimes && <button type="button" className="summary-dungeons-show-all" onClick={() => setShowAllBestTimes(false)}>Show Fewer Items</button>}

            <div className="summary-block-label summary-sublabel">Recent Runs</div>
            <DataTable
              rows={visibleDungeonRows}
              columns={["dungeon", "difficulty", "duration", "party"]}
              columnLabels={{ dungeon: "Dungeon", difficulty: "Difficulty", duration: "Duration", party: "Party" }}
              sortColumn={dungeonSort.sortColumn}
              sortDirection={dungeonSort.sortDirection}
              onSort={dungeonSort.onSort}
              tableClassName="summary-dungeons-table"
              rowKey={(row) => String(row.completionId)}
              renderCell={(row, col) =>
                col === "dungeon" ? <span title={String(row.dungeonId)} data-no-translate>{String(row.dungeon)}</span> :
                col === "duration" ? <span data-no-translate>{formatDungeonDuration(Number(row.duration))}</span> :
                col === "party" ? <span data-no-translate>{`${row.party} · ${row.partyNames}`}</span> :
                <span data-no-translate>{String(row[col])}</span>
              }
            />
            {dungeonRows.length > DUNGEON_RUNS_PREVIEW_LIMIT && <button
              type="button"
              className="summary-dungeons-show-all"
              onClick={() => setShowAllDungeonRuns(!showAllDungeonRuns)}
            >{showAllDungeonRuns ? "Show Fewer Items" : `Show All ${dungeonRows.length.toLocaleString()} Items`}</button>}
        </div>}
      </div>

      <aside className="summary-side">
        {hasDungeonCard && vitalsCard}
        {hasDungeonCard && currencyCard}

        <div className="summary-block summary-card">
          <div className="summary-block-label">Faction</div>
          <table className="summary-kv"><tbody>
            <tr><td>Alignment</td><td>{faction}</td></tr>
          </tbody></table>
          {factionRows !== null && <>
            <div className="summary-block-label summary-sublabel">Faction Standings</div>
            <table className="summary-kv summary-faction-standings"><tbody>
              {factionRows.map((row) => <tr key={row.faction_id} aria-label={`${row.faction_name || `Faction ${row.faction_id}`} reputation`}>
                <td>{row.faction_name || `Faction ${row.faction_id}`}</td>
                <td><span className="summary-faction-metrics">
                  <span><strong>{Number(row.reputation_amount).toLocaleString()}</strong> Rep</span>
                  {row.estimated_rank !== undefined && <span><strong>{row.estimated_rank}</strong> Est. Rank</span>}
                  {row.rank_limited_by_progression && row.current_rank_limit !== null && row.current_rank_limit !== undefined
                    && <span><strong>{row.current_rank_limit}</strong> Story Limit</span>}
                  {(row.reputation_in_sync === false || row.progression_repair_available) && onRepairFactionReputation && <span className="summary-faction-repair-action">
                    <button
                      type="button"
                      className="summary-faction-repair-button"
                      disabled={factionRepairDisabled || factionRepairResult?.pending}
                      title={factionRepairDisabled ? "The player must be fully offline before their faction state can be repaired." : "Restore earned faction progression and synchronize reputation."}
                      onClick={() => void onRepairFactionReputation()}
                    >{factionRepairResult?.pending ? "Repairing…" : factionRepairDisabled ? "Player Must Be Offline" : "Repair Faction"}</button>
                  </span>}
                </span></td>
              </tr>)}
            </tbody></table>
            {factionRepairResult && <div className={`summary-faction-repair-result ${factionRepairResult.tone}${factionRepairResult.pending ? " pending" : ""}`} role="status" aria-live="polite">{factionRepairResult.text}</div>}
          </>}
        </div>

        <div className="summary-block summary-card summary-identity">
          <button type="button" className="summary-fold" aria-expanded={showIdentity} onClick={() => setShowIdentity(!showIdentity)}>
            <span className="summary-block-label">Identity</span>
            <span className="summary-fold-toggle">{showIdentity ? "Hide" : "Show"}{showIdentity ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}</span>
          </button>
          {showIdentity && <>
            <div className="summary-block-label summary-sublabel">Platform Identity</div>
            <table className="summary-kv"><tbody>
              {identityRows.map((row) => <tr key={row.label}><td>{row.label}</td><td className="summary-mono">{row.value}</td></tr>)}
            </tbody></table>
            <div className="summary-block-label summary-sublabel">Database Identity</div>
            <table className="summary-kv"><tbody>
              {databaseIdRows.map((row) => <tr key={row.label}><td>{row.label}</td><td className="summary-mono">{row.value}</td></tr>)}
            </tbody></table>
          </>}
        </div>
      </aside>
    </div>
  </section>;
}
