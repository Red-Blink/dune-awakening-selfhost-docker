import { useCallback, useEffect, useRef, useState } from "react";
import { guildsApi } from "../../api/guilds";
import { DataTable } from "../../components/common/DataTable";
import { formatCell } from "../../lib/display";

type GuildsPanelProps = {
  onError: (text: string) => void;
};

const GUILDS_AUTO_REFRESH_MS = 10_000;

export function GuildsPanel({ onError }: GuildsPanelProps) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [selectedGuild, setSelectedGuild] = useState<Record<string, unknown> | null>(null);
  const [memberRows, setMemberRows] = useState<Record<string, unknown>[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const refreshInFlight = useRef(false);
  const qRef = useRef(q);

  useEffect(() => {
    qRef.current = q;
  }, [q]);

  const load = useCallback(async (options: { silent?: boolean } = {}) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (!options.silent) onError("");
    try {
      const result = await guildsApi.list(qRef.current);
      const nextRows = result.rows || [];
      setRows(nextRows);
      setSelectedGuild((current) => {
        if (!current) return current;
        const currentId = String(current.guild_id || "");
        return nextRows.find((row) => String(row.guild_id || "") === currentId) || current;
      });
    } catch (error) {
      if (!options.silent) onError(error instanceof Error ? error.message : String(error));
    } finally {
      refreshInFlight.current = false;
    }
  }, [onError]);

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
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setMembersLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void load({ silent: true });
    };

    const interval = window.setInterval(refresh, GUILDS_AUTO_REFRESH_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [load]);

  return (
    <section className="panel">
      <div className="panel-title"><h2>Guilds</h2><div className="action-row"><button onClick={() => void load()}>Refresh</button></div></div>
      <div className="action-row guilds-search-row"><input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search guild name" /><button onClick={() => void load()}>Search</button></div>
      <DataTable rows={rows} columns={["guild_name", "guild_faction", "member_count", "guild_description"]} tableClassName="guilds-table" onRowClick={openGuild} emptyMessage="No guilds have been found yet." />
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
