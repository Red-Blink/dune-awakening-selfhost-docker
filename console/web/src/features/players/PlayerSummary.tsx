import type { ReactNode } from "react";
import { KeyValueGrid, PlayerStatusCell } from "../../components/common/DisplayPrimitives";
import { firstDefined } from "../../lib/display";

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
      ["FLS ID", firstDefined(player.fls_id, fallback.fls_id, actionPlayerId) || "missing"]
    ]} />
    {actions}
  </section>;
}
