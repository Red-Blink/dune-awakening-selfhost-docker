import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { DataTable } from "../../components/common/DataTable";

// Read-only pages for the `player` tier (#1276). They call only the routes
// console/api/src/playerScope.js admits and render what the API returns for the
// caller. None of the operator controls (delete, edit, permissions, export,
// give-item) exist here, so there is nothing to answer 403.
type Row = Record<string, unknown>;
type ListResult = {
  rows?: Row[];
  notLinked?: boolean;
  notInGuild?: boolean;
  reason?: string;
  linkInstructions?: { message?: string };
};

export function playerListNotice(result: ListResult | null): string {
  if (!result) return "";
  if (result.notLinked) return result.linkInstructions?.message || result.reason || "Your Discord account isn't linked to a character yet.";
  if (result.notInGuild) return result.reason || "Your character isn't in a guild.";
  if (result.reason) return result.reason;
  return "";
}

// Columns that carry other people's details or internal identifiers never get shown.
const HIDDEN_COLUMNS = new Set(["shared_with", "sharedWith"]);
export function visibleRows(rows: Row[]): Row[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !HIDDEN_COLUMNS.has(key))));
}

function usePlayerList(path: string) {
  const [result, setResult] = useState<ListResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(Boolean(path));
  useEffect(() => {
    if (!path) { setResult(null); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    api<ListResult>(path)
      .then((next) => { if (!cancelled) { setResult(next); setFailed(false); } })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path]);
  return { result, failed, loading };
}

function ListBody({ title, empty, result, failed, loading, children }: { title: string; empty: string; result: ListResult | null; failed: boolean; loading: boolean; children?: React.ReactNode }) {
  const notice = playerListNotice(result);
  const rows = result?.rows || [];
  return (
    <section className="panel" aria-label={title}>
      <div className="panel-title"><h2>{title}</h2></div>
      {loading && <p>Loading…</p>}
      {failed && <p role="alert">{title} is unavailable right now.</p>}
      {!loading && !failed && notice && <p role="status">{notice}</p>}
      {!loading && !failed && !notice && rows.length === 0 && <p>{empty}</p>}
      {rows.length > 0 && <DataTable rows={visibleRows(rows)} />}
      {children}
    </section>
  );
}

export function PlayerCharacterPage() {
  const { result, failed, loading } = usePlayerList("/api/players");
  return <ListBody title="Your Character" empty="No character found for your account." result={result} failed={failed} loading={loading} />;
}

export function PlayerGuildPage() {
  const guilds = usePlayerList("/api/guilds");
  const guildId = guilds.result?.rows?.[0] ? String(guilds.result.rows[0].guild_id ?? guilds.result.rows[0].id ?? "") : "";
  const roster = usePlayerList(guildId ? `/api/guilds/${encodeURIComponent(guildId)}/members` : "");
  return (
    <ListBody title="Your Guild" empty="You are not in a guild." result={guilds.result} failed={guilds.failed} loading={guilds.loading}>
      {guildId && (
        <>
          <h3>Roster</h3>
          {roster.failed ? <p role="alert">The roster is unavailable right now.</p> : roster.loading ? <p>Loading…</p> : <DataTable rows={visibleRows(roster.result?.rows || [])} />}
        </>
      )}
    </ListBody>
  );
}

export function PlayerAssetsPage({ kind }: { kind: "bases" | "vehicles" | "storage" }) {
  const { result, failed, loading } = usePlayerList(`/api/${kind}`);
  const title = kind === "bases" ? "Your Bases" : kind === "vehicles" ? "Your Vehicles" : "Your Storage";
  return <ListBody title={title} empty={`You don't own any ${kind} yet.`} result={result} failed={failed} loading={loading} />;
}
