import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { KeyValueGrid, PlayerStatusCell } from "../../components/common/DisplayPrimitives";
import { firstDefined } from "../../lib/display";
import { playersApi } from "../../api/players";

type CurrencyRow = { currency_id: number; balance: number; label?: string };
type FactionRow = { faction_id: number; faction_name?: string; reputation_amount: number };
type Progression = { level?: number; xp?: number; totalSkillPoints?: number; unspentSkillPoints?: number };

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
  const [progression, setProgression] = useState<Progression | null>(null);
  const [intel, setIntel] = useState<number | null>(null);
  const [solarisCoinTotal, setSolarisCoinTotal] = useState<number | null>(null);
  const loadRequest = useRef(0);

  useEffect(() => {
    const request = ++loadRequest.current;
    if (!dbPlayerId) {
      setCurrencyRows([]);
      setFactionRows([]);
      setProgression(null);
      setIntel(null);
      setSolarisCoinTotal(null);
      return;
    }
    void Promise.all([
      playersApi.currency(dbPlayerId),
      playersApi.factions(dbPlayerId),
      playersApi.progression(dbPlayerId),
      playersApi.intel(dbPlayerId),
      playersApi.solarisCoin(dbPlayerId)
    ])
      .then(([currency, factions, progressionResult, intelResult, solarisCoinResult]) => {
        if (request !== loadRequest.current) return;
        setCurrencyRows((currency.rows || []) as CurrencyRow[]);
        setFactionRows((factions.rows || []) as FactionRow[]);
        setProgression(progressionResult.capabilities?.progression ? progressionResult : null);
        setIntel(intelResult.capabilities?.intel ? (intelResult.intel ?? null) : null);
        setSolarisCoinTotal(solarisCoinResult.capabilities?.solarisCoin ? (solarisCoinResult.total ?? null) : null);
      })
      .catch(() => {
        if (request !== loadRequest.current) return;
        setCurrencyRows([]);
        setFactionRows([]);
        setProgression(null);
        setIntel(null);
        setSolarisCoinTotal(null);
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
      ...(progression ? [
        ["Level", String(progression.level ?? 0)] as [string, string],
        ["XP", (progression.xp ?? 0).toLocaleString()] as [string, string],
        ["Skill Points", `${progression.unspentSkillPoints ?? 0} / ${progression.totalSkillPoints ?? 0}`] as [string, string]
      ] : []),
      ...(intel !== null ? [["Intel", String(intel)] as [string, string]] : []),
      ...currencyRows.map((row): [string, string] => [row.label || `Currency ${row.currency_id}`, Number(row.balance).toLocaleString()]),
      ...(solarisCoinTotal !== null ? [["Total Solari Coin", solarisCoinTotal.toLocaleString()] as [string, string]] : []),
      ...factionRows.map((row): [string, string] => [`${row.faction_name || `Faction ${row.faction_id}`} Reputation`, String(row.reputation_amount)])
    ]} />
    {actions}
  </section>;
}
