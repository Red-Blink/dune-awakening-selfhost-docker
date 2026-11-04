import { useEffect, useState } from "react";
import { ArrowRight, Crosshair, MapPin, RefreshCw, ShieldCheck, Skull, Swords, TrendingUp, Trophy } from "lucide-react";
import { combatApi, type CombatHistory, type CombatRowLimit } from "../../api/combat";
import { formatAbsoluteDateTime, formatRelativeAge } from "../../lib/display";
import { DataTable } from "../../components/common/DataTable";

export function CombatPanel({ controllerId, playerName }: { controllerId?: string; playerName?: string }) {
  const scope = controllerId || "global";
  const [response, setResponse] = useState<{ scope: string; data: CombatHistory } | null>(null);
  const data = response?.scope === scope ? response.data : null;
  const [leaderboardLimit, setLeaderboardLimit] = useState<CombatRowLimit>(10);
  const [killsLimit, setKillsLimit] = useState<CombatRowLimit>(10);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true); setError("");
    async function load() {
      try {
        const result = await combatApi.history(controllerId, { leaderboardLimit, killsLimit });
        if (active) { setResponse({ scope, data: result }); setError(""); }
      } catch {
        if (active) setError("Combat history could not be loaded. Try again.");
      } finally {
        if (active) { setLoading(false); timer = setTimeout(() => { void load(); }, 30_000); }
      }
    }
    void load();
    return () => { active = false; clearTimeout(timer); };
  }, [controllerId, refresh, scope, leaderboardLimit, killsLimit]);

  const personal = Boolean(controllerId || data?.selfOnly);
  const statistics = personal ? data?.leaderboard.find(row => !controllerId || row.controllerId === controllerId) : null;
  const rankedPlayers = data?.leaderboard.map((row, index) => ({ ...row, rank: index + 1 })) || [];
  const ratio = (value: number | null) => value == null ? "—" : value.toFixed(2);
  const status = data?.status === "recording" ? "Recording" : data?.status === "starting" ? "Starting" : data?.status === "paused" ? "Recording Paused" : "Not Available";

  return <section className="combat-panel" aria-label={playerName ? `${playerName} Combat` : "PvP"} aria-busy={loading}>
    <div className="combat-heading">
      <div className="combat-title"><span className="combat-title-icon"><Swords size={22} aria-hidden="true" /></span><div><h3>{personal ? "Combat" : "PvP"}</h3><p>Player kills, deaths and K/D.</p></div></div>
      <div className="combat-toolbar">
        {data && <span className={`combat-status combat-status-${data.status}`}><span aria-hidden="true" />{status}</span>}
        <button className="combat-refresh" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} aria-hidden="true" />Refresh</button>
      </div>
    </div>
    {error && <p role="alert" className="error-banner">{error}</p>}
    {data && <>
      {data.reason && <p className="attention-text">{data.reason}</p>}
      {data.supported && <div className={`combat-layout${personal ? " combat-layout-personal" : ""}`}>
        <section className="combat-surface combat-standings" aria-label={personal ? "Combat Summary" : "Leaderboard"}>
          <div className="combat-surface-heading"><h4>{personal ? <ShieldCheck size={17} aria-hidden="true" /> : <Trophy size={17} aria-hidden="true" />}{personal ? data.selfOnly ? "Your PvP Statistics" : "Combat Summary" : "Leaderboard"}</h4>{!personal && <label className="combat-row-control"><span>Show</span><select aria-label="Leaderboard Rows" value={leaderboardLimit} onChange={event => setLeaderboardLimit(event.target.value === "all" ? "all" : Number(event.target.value) as CombatRowLimit)}><option value="10">Top 10</option><option value="20">Top 20</option><option value="50">Top 50</option><option value="all">All</option></select></label>}</div>
          {personal && statistics ? <>
            <dl className="combat-metrics">
              <div><dt><Swords size={15} aria-hidden="true" />Kills</dt><dd>{statistics.kills}</dd></div>
              <div><dt><Skull size={15} aria-hidden="true" />PvP Deaths</dt><dd>{statistics.deaths}</dd></div>
              <div><dt><TrendingUp size={15} aria-hidden="true" />K/D</dt><dd>{ratio(statistics.kd)}</dd></div>
            </dl>
            <dl className="combat-secondary-metrics"><div><dt>Self-Deaths</dt><dd>{statistics.selfDeaths}</dd></div><div><dt>Other Deaths</dt><dd>{statistics.otherDeaths}</dd></div><div><dt>Unclassified Deaths</dt><dd>{statistics.unknownDeaths}</dd></div></dl>
          </> : !personal && rankedPlayers.length ? <DataTable rows={rankedPlayers}
            columns={["rank", "name", "kills", "deaths", "kd"]}
            columnLabels={{ rank: "Rank", name: "Player", kills: "Kills", deaths: "PvP Deaths", kd: "K/D" }}
            tableClassName="combat-table" rowKey={row => String(row.controllerId)}
            renderCell={(row, column) => {
              if (column === "rank") return <span className={`combat-rank${row.rank === 1 ? " combat-rank-first" : ""}`}>{row.rank === 1 && <Trophy size={13} aria-hidden="true" />}{String(row.rank)}</span>;
              if (column === "kd") return <span className="combat-ratio">{ratio(row.kd == null ? null : Number(row.kd))}</span>;
              return String(row[column] ?? "—");
            }}
          /> : <div className="combat-empty"><span className="combat-empty-icon"><Trophy size={26} aria-hidden="true" /></span><strong>No Combat Recorded</strong><p>No combat events have been recorded yet.</p></div>}
          {!personal && <div className="combat-list-footer"><span>Ranked by kills</span><span>{rankedPlayers.length} <span>Players Shown</span></span></div>}
        </section>
        <section className="combat-surface combat-activity" aria-label="Recent Kills">
          <div className="combat-surface-heading"><h4><Crosshair size={17} aria-hidden="true" />Recent Kills</h4><label className="combat-row-control"><span>Show</span><select aria-label="Recent Kills Rows" value={killsLimit} onChange={event => setKillsLimit(event.target.value === "all" ? "all" : Number(event.target.value) as CombatRowLimit)}><option value="10">10</option><option value="20">20</option><option value="50">50</option><option value="all">All</option></select></label></div>
          {data.recentKills.length ? <ol className="combat-kill-feed">{data.recentKills.map(kill => <li key={kill.id}>
            <span className="combat-feed-marker" aria-hidden="true"><Swords size={15} /></span>
            <div className="combat-feed-content"><div className="combat-kill-names"><strong>{kill.killer}</strong><span className="combat-kill-arrow"><ArrowRight size={14} aria-hidden="true" /><span className="sr-only">killed</span></span><span>{kill.victim}</span></div>
            <div className="combat-kill-meta"><span><MapPin size={12} aria-hidden="true" />{kill.map || "Unknown Map"}</span><time dateTime={kill.time} title={formatAbsoluteDateTime(kill.time)}>{formatRelativeAge(new Date(kill.time))}</time></div></div>
          </li>)}</ol> : <div className="combat-empty"><span className="combat-empty-icon"><Crosshair size={26} aria-hidden="true" /></span><strong>No Recent Kills</strong><p>No PvP kills have been recorded yet.</p></div>}
          <div className="combat-list-footer"><span>Latest First</span><span>{data.recentKills.length} <span>Kills Shown</span></span></div>
        </section>
      </div>}
      <div className="combat-footer">
        <details className="combat-history-details"><summary>About This History</summary><div>
          {data.recordingStartedAt && <p>Recording since {formatAbsoluteDateTime(data.recordingStartedAt)}</p>}
          {data.recordedSince && <p>Available history from {formatAbsoluteDateTime(data.recordedSince)}.</p>}
          <p>Includes available game history. Self-deaths do not affect PvP K/D. Events removed by the game before collection cannot be recovered.</p>
          <p>Choose how many rows to show in each panel. All includes every available recorded entry.</p>
        </div></details>
        {data.lastCapturedAt && <span>Updated {formatRelativeAge(new Date(data.lastCapturedAt))}</span>}
      </div>
    </>}
    {!data && loading && <div className="loading-panel"><span className="spinner" aria-hidden="true" /><span className="loading-dots">Loading Combat History</span></div>}
  </section>;
}
