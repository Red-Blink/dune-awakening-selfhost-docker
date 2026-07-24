import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { MapPin, Shield, Coins, CircleDollarSign, Banknote } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PlayerStatusCell } from "../../components/common/DisplayPrimitives";
import { firstDefined } from "../../lib/display";
import { playersApi } from "../../api/players";

const currencyIcon = (label: string): LucideIcon => {
  if (label === "Solari Credit") return CircleDollarSign;
  if (label === "Scrip") return Banknote;
  return Coins;
};

type CurrencyRow = { currency_id: number; balance: number; label?: string };
type FactionRow = { faction_id: number; faction_name?: string; reputation_amount: number };
type Progression = { level?: number; xp?: number; totalSkillPoints?: number; unspentSkillPoints?: number };
type Vitals = { currentHealth: number | null; maxHealth: number; hydration: number | null; maxHydration: number; spiceAddictionLevel: number | null; maxSpiceAddictionLevel: number };

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
  const [factionRows, setFactionRows] = useState<FactionRow[] | null>(null);
  const [progression, setProgression] = useState<Progression | null>(null);
  const [intel, setIntel] = useState<number | null>(null);
  const [solarisCoinTotal, setSolarisCoinTotal] = useState<number | null>(null);
  const [vitals, setVitals] = useState<Vitals | null>(null);
  const loadRequest = useRef(0);

  useEffect(() => {
    const request = ++loadRequest.current;
    if (!dbPlayerId) {
      setCurrencyRows([]);
      setFactionRows(null);
      setProgression(null);
      setIntel(null);
      setSolarisCoinTotal(null);
      setVitals(null);
      return;
    }
    void Promise.allSettled([
      playersApi.currency(dbPlayerId),
      playersApi.factions(dbPlayerId),
      playersApi.progression(dbPlayerId),
      playersApi.intel(dbPlayerId),
      playersApi.solarisCoin(dbPlayerId),
      playersApi.vitals(dbPlayerId)
    ]).then(([currency, factions, progressionResult, intelResult, solarisCoinResult, vitalsResult]) => {
      if (request !== loadRequest.current) return;
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
            hydration: vitalsResult.value.hydration ?? null,
            maxHydration: vitalsResult.value.maxHydration ?? 0,
            spiceAddictionLevel: vitalsResult.value.spiceAddictionLevel ?? null,
            maxSpiceAddictionLevel: vitalsResult.value.maxSpiceAddictionLevel ?? 0
          }
        : null);
    });
  }, [dbPlayerId]);

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

  return <section className="action-section player-summary">
    <h4>Player Summary</h4>

    <div className="summary-hero">
      <div className="summary-hero-main">
        <span className="summary-hero-name">{characterName}</span>
        <PlayerStatusCell value={status} />
      </div>
      <div className="summary-hero-sub">
        <span className="summary-hero-meta summary-hero-map"><MapPin size={14} className="summary-hero-icon" aria-label="Map" /><span>{map}</span></span>
        <span className="summary-hero-meta summary-hero-guild"><Shield size={14} className="summary-hero-icon" aria-label="Guild" /><span>{guild}</span></span>
      </div>
    </div>

    {(progression || intel !== null) && <div className="summary-stats">
      {progression && <>
        <div className="summary-stat"><span>Level</span><strong>{String(progression.level ?? 0)}</strong></div>
        <div className="summary-stat"><span>XP</span><strong>{(progression.xp ?? 0).toLocaleString()}</strong></div>
        <div className="summary-stat"><span>Skill Points</span><strong>{`${progression.unspentSkillPoints ?? 0} / ${progression.totalSkillPoints ?? 0}`}</strong></div>
      </>}
      {intel !== null && <div className="summary-stat"><span>Available Intel</span><strong>{intel.toLocaleString()}</strong></div>}
    </div>}

    <div className="summary-cols">
      {vitals && <div className="summary-block">
        <div className="summary-block-label">Vitals</div>
        <table className="summary-kv"><tbody>
          <tr><td>Health</td><td>{vitals.currentHealth !== null ? `${Math.round(vitals.currentHealth).toLocaleString()} / ${vitals.maxHealth.toLocaleString()}` : "—"}</td></tr>
          <tr><td>Hydration</td><td>{vitals.hydration !== null ? `${Math.round(vitals.hydration).toLocaleString()} / ${vitals.maxHydration.toLocaleString()}` : "—"}</td></tr>
          <tr><td>Spice Addiction</td><td>{vitals.spiceAddictionLevel !== null ? `${Math.round(vitals.spiceAddictionLevel).toLocaleString()} / ${vitals.maxSpiceAddictionLevel.toLocaleString()}` : "—"}</td></tr>
        </tbody></table>
      </div>}
      <div className="summary-block">
        <div className="summary-block-label">Faction</div>
        <table className="summary-kv"><tbody>
          <tr><td>Alignment</td><td>{faction}</td></tr>
        </tbody></table>
        {factionRows !== null && <>
          <div className="summary-block-label summary-sublabel">Reputation</div>
          <table className="summary-kv"><tbody>
            {factionRows.map((row) => <tr key={row.faction_id}>
              <td>{row.faction_name || `Faction ${row.faction_id}`}</td>
              <td>{String(row.reputation_amount)}</td>
            </tr>)}
          </tbody></table>
        </>}
      </div>
      <div className="summary-block">
        <div className="summary-block-label">Platform Identity</div>
        <table className="summary-kv"><tbody>
          {identityRows.map((row) => <tr key={row.label}><td>{row.label}</td><td className="summary-mono">{row.value}</td></tr>)}
        </tbody></table>
      </div>
      <div className="summary-block">
        <div className="summary-block-label">Database Identity</div>
        <table className="summary-kv"><tbody>
          {databaseIdRows.map((row) => <tr key={row.label}><td>{row.label}</td><td className="summary-mono">{row.value}</td></tr>)}
        </tbody></table>
      </div>
    </div>

    {(currencyRows.length > 0 || solarisCoinTotal !== null) && <div className="summary-block">
      <div className="summary-block-label">Currency</div>
      <div className="summary-currency">
        {currencyTiles.map(({ label, value, Icon }) => <div className="summary-currency-tile" key={label}>
          <Icon size={18} className="summary-currency-icon" aria-hidden="true" />
          <div className="summary-currency-body">
            <strong>{value}</strong>
            <span>{label}</span>
          </div>
        </div>)}
      </div>
    </div>}

    {actions}
  </section>;
}
