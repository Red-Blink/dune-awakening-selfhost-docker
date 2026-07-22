import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { KeyValueGrid, PlayerStatusCell } from "../../components/common/DisplayPrimitives";
import { firstDefined } from "../../lib/display";
import { playersApi } from "../../api/players";

type CurrencyRow = { currency_id: number; balance: number; label?: string };
type FactionRow = { faction_id: number; faction_name?: string; reputation_amount: number };

export function PlayerSummary({
  detail,
  fallback,
  dbPlayerId,
  actionPlayerId,
  actions
}: {
  detail: Record<string, unknown> | null;
  fallback: Record<string, unknown>;
  dbPlayerId: string;
  actionPlayerId: string;
  actions?: ReactNode;
}) {
  const player = ((detail?.player as Record<string, unknown> | undefined) || fallback) as Record<string, unknown>;
  const status = firstDefined(player.online_status, fallback.online_status);
  const [currencyRows, setCurrencyRows] = useState<CurrencyRow[]>([]);
  const [factionRows, setFactionRows] = useState<FactionRow[]>([]);
  const loadRequest = useRef(0);

  useEffect(() => {
    const request = ++loadRequest.current;
    if (!dbPlayerId) {
      setCurrencyRows([]);
      setFactionRows([]);
      return;
    }
    void Promise.all([playersApi.currency(dbPlayerId), playersApi.factions(dbPlayerId)])
      .then(([currency, factions]) => {
        if (request !== loadRequest.current) return;
        setCurrencyRows((currency.rows || []) as CurrencyRow[]);
        setFactionRows((factions.rows || []) as FactionRow[]);
      })
      .catch(() => {
        if (request !== loadRequest.current) return;
        setCurrencyRows([]);
        setFactionRows([]);
      });
  }, [dbPlayerId]);

  return <section className="action-section">
    <h4>Player Summary</h4>
    <KeyValueGrid items={[
      ["Character", firstDefined(player.character_name, player.name, fallback.character_name)],
      ["Funcom ID", firstDefined(player.funcom_id, fallback.funcom_id)],
      ["Status", <PlayerStatusCell value={status} />],
      ["Map", firstDefined(player.map, player.world, fallback.map)],
      ["Faction", firstDefined(player.faction, fallback.faction) || "Neutral"],
      ["Guild", firstDefined(player.guild, fallback.guild) || "—"],
      ["DB Player ID", dbPlayerId || "missing"],
      ["FLS ID", firstDefined(player.fls_id, fallback.fls_id, actionPlayerId) || "missing"],
      ...currencyRows.map((row): [string, string] => [row.label || `Currency ${row.currency_id}`, String(row.balance)]),
      ...factionRows.map((row): [string, string] => [`${row.faction_name || `Faction ${row.faction_id}`} Reputation`, String(row.reputation_amount)])
    ]} />
    {actions}
  </section>;
}
