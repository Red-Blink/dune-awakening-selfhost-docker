import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { playersApi } from "../../api/players";
import { DataTable } from "../../components/common/DataTable";
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

const PLAYERS_AUTO_REFRESH_MS = 10_000;

export function PlayersPanel({ onError, renderCharacterAdmin }: PlayersPanelProps) {
  const [q, setQ] = useState("");
  const [playerFilter, setPlayerFilter] = useState<"all" | "online" | "offline">("all");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const refreshInFlight = useRef(false);
  const qRef = useRef(q);
  const playerFilterRef = useRef(playerFilter);

  useEffect(() => {
    qRef.current = q;
  }, [q]);

  useEffect(() => {
    playerFilterRef.current = playerFilter;
  }, [playerFilter]);

  const load = useCallback(async (filter = playerFilterRef.current, options: { silent?: boolean } = {}) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (!options.silent) onError("");
    try {
      const result = filter === "online" ? await playersApi.online() : await playersApi.list(qRef.current);
      const nextRows = result.rows || [];
      const visibleRows = filter === "offline"
        ? nextRows.filter((row) => String(row.online_status || "").toLowerCase() !== "online")
        : nextRows;
      setRows(visibleRows);
      setSelected((current) => {
        if (!current) return current;
        const currentId = String(current.actor_id || current.player_pawn_id || current.id || "");
        return visibleRows.find((row) => String(row.actor_id || row.player_pawn_id || row.id || "") === currentId) || current;
      });
    } catch (error) {
      if (!options.silent) onError(error instanceof Error ? error.message : String(error));
    } finally {
      refreshInFlight.current = false;
    }
  }, [onError]);

  async function open(row: Record<string, unknown>) {
    const id = String(row.actor_id || row.player_pawn_id || row.id || "");
    setSelected(row);
    setDetail(await playersApi.profile(id));
  }

  useEffect(() => {
    void load("all");
  }, [load]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void load(playerFilter, { silent: true });
    };

    const interval = window.setInterval(refresh, PLAYERS_AUTO_REFRESH_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [load, playerFilter]);

  const dbPlayerId = selected ? String(selected.actor_id || selected.player_pawn_id || selected.id || "") : "";
  const actionPlayerId = selected ? String(selected.action_player_id || selected.funcom_id || selected.fls_id || selected.account_id || "") : "";
  const playersEmptyMessage = playerFilter === "online"
    ? "No players are currently online."
    : playerFilter === "offline"
      ? "No offline players were found."
      : "No players have been found yet.";

  return (
    <section className="panel">
      <div className="panel-title"><h2>Players</h2><div className="action-row players-filter-row"><label className="inline-filter-label players-filter-label">Filter <select className="players-filter-select" value={playerFilter} onChange={(event) => { const nextFilter = event.target.value as "all" | "online" | "offline"; setPlayerFilter(nextFilter); void load(nextFilter); }}><option value="all">All Players</option><option value="online">Online</option><option value="offline">Offline</option></select></label><button onClick={() => void load(playerFilter)}>Refresh</button></div></div>
      <div className="action-row"><input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search character, FLS ID, account id, or actor id" /><button onClick={() => void load(playerFilter)}>Search</button></div>
      <DataTable rows={rows} columns={["actor_id", "character_name", "account_id", "last_seen", "online_status", "map", "fls_id"]} tableClassName="players-table" onRowClick={open} emptyMessage={playersEmptyMessage} renderCell={(row, col) => {
        if (col === "online_status") return <PlayerStatusCell value={row[col]} />;
        if (col === "last_seen") return formatLastOnline(row);
        return formatCell(row[col]);
      }} />
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
