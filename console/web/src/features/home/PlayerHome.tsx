import { useEffect, useState } from "react";
import { api } from "../../api/client";

type PlayerStatus = {
  data?: {
    summary?: { overall?: string | null; title?: string | null; region?: string | null; mode?: string | null; population?: { current?: number; max?: number } | null };
    gameServers?: { map?: string | null; status?: string | null; uptime?: string | null }[];
  };
};

// Home for the `player` tier: server health only. No start/stop/restart, no
// readiness or token checks; the API refuses those for this tier (#1276).
export function PlayerHome() {
  const [status, setStatus] = useState<PlayerStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await api<PlayerStatus>("/api/server/status");
        if (!cancelled) { setStatus(next); setFailed(false); }
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void load();
    const id = window.setInterval(load, 30000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);
  const summary = status?.data?.summary;
  const servers = status?.data?.gameServers || [];
  const pop = summary?.population;
  return (
    <section className="panel player-home" aria-label="Server status">
      <h2>{summary?.title || "Server status"}</h2>
      {failed && !status && <p role="alert">Server status is unavailable right now.</p>}
      {!failed && !status && <p>Loading server status…</p>}
      {summary && (
        <dl>
          <dt>Status</dt><dd>{summary.overall || "Unknown"}</dd>
          {summary.region && (<><dt>Region</dt><dd>{summary.region}</dd></>)}
          {summary.mode && (<><dt>Mode</dt><dd>{summary.mode}</dd></>)}
          {pop && typeof pop.current === "number" && (<><dt>Players online</dt><dd>{pop.current}{typeof pop.max === "number" ? ` / ${pop.max}` : ""}</dd></>)}
        </dl>
      )}
      {servers.length > 0 && (
        <table>
          <thead><tr><th>Map</th><th>Status</th><th>Uptime</th></tr></thead>
          <tbody>{servers.map((g, i) => (<tr key={`${g.map}-${i}`}><td>{g.map}</td><td>{g.status}</td><td>{g.uptime}</td></tr>))}</tbody>
        </table>
      )}
    </section>
  );
}
