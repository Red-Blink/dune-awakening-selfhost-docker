import { PermissionGate } from "../../lib/consoleAccess";
import { useEffect, useState } from "react";
import { friendlyApiError } from "../../api/client";
import { playersApi } from "../../api/players";
import { InlineActionResult, type InlineActionResultState } from "../../components/common/InlineActionResult";

type FactionId = 1 | 2 | 3;

const FACTIONS: ReadonlyArray<{ id: FactionId; name: string }> = [
  { id: 3, name: "Neutral" },
  { id: 1, name: "Atreides" },
  { id: 2, name: "Harkonnen" }
];

type ConfirmAction = (message: string, options?: {
  title?: string;
  confirmLabel?: string;
  danger?: boolean;
  details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[];
}) => Promise<boolean>;

function factionIdForName(name: unknown): FactionId | "" {
  const normalized = String(name || "").trim().toLowerCase();
  return FACTIONS.find((faction) => faction.name.toLowerCase() === normalized)?.id || "";
}

function hasGuild(guild: unknown) {
  const value = String(guild || "").trim();
  return value !== "" && value !== "—" && value.toLowerCase() !== "unavailable";
}

export function PlayerFactionAssignment({
  playerId,
  playerName,
  currentFaction,
  guild,
  supported,
  confirmAction,
  onRefresh,
  onActionLog
}: {
  playerId: string;
  playerName: string;
  currentFaction: string;
  guild: unknown;
  supported: boolean;
  confirmAction: ConfirmAction;
  onRefresh: () => void;
  onActionLog: (actionType: string, target: string, amount: string, notes: string) => void;
}) {
  const currentId = factionIdForName(currentFaction);
  const [selectedId, setSelectedId] = useState<FactionId | "">(currentId);
  const [result, setResult] = useState<InlineActionResultState | null>(null);

  useEffect(() => setSelectedId(currentId), [currentId]);

  const selected = FACTIONS.find((faction) => faction.id === selectedId);
  const pending = result?.pending === true;
  const unchanged = selectedId !== "" && selectedId === currentId;
  const guildName = hasGuild(guild) ? String(guild) : "None";

  async function assignFaction() {
    if (!selected || !playerId || unchanged) return;
    const guildWarning = guildName === "None"
      ? ""
      : " The game may realign the guild if this player is its leader, or remove the player from an incompatible aligned guild.";
    const confirmed = await confirmAction(
      `Change ${playerName}'s faction from ${currentFaction || "Neutral"} to ${selected.name}?${guildWarning}`,
      {
        title: "Change Player Faction",
        confirmLabel: "Change Faction",
        danger: true,
        details: [
          { label: "Player", value: playerName, tone: "accent" },
          { label: "Current", value: currentFaction || "Neutral" },
          { label: "New Faction", value: selected.name, tone: "danger" },
          { label: "Guild", value: guildName }
        ]
      }
    );
    if (!confirmed) return;

    setResult({ key: "assignFaction", text: `Changing ${playerName}'s faction`, tone: "neutral", pending: true });
    try {
      const response = await playersApi.setFaction(playerId, { factionId: selected.id, confirmation: "CHANGE PLAYER FACTION" });
      const message = String(response.result?.message || `${playerName} is now assigned to ${selected.name}.`);
      setResult({ key: "assignFaction", text: message, tone: "success" });
      onActionLog("Change Faction", playerName, selected.name, "Succeeded");
      onRefresh();
    } catch (error) {
      const message = friendlyApiError(error);
      setResult({ key: "assignFaction", text: message, tone: "danger" });
      onActionLog("Change Faction", playerName, selected.name, `Failed: ${message}`);
    }
  }

  return (
    <div className="playerAdmin_section playerAdmin_factionSection">
      <h5>Faction Assignment</h5>
      <p>Changes the character's personal allegiance. Faction reputation is managed separately in Quick Rewards.</p>
      <div className="playerAdmin_repairRow">
        <span className="playerAdmin_repairLabel">
          <span>Current: {currentFaction || "Neutral"}</span>
          <em>{guildName === "None" ? "No guild membership required." : `Guild: ${guildName}. Normal guild compatibility rules apply.`}</em>
        </span>
        <div className="playerAdmin_factionControls">
          <label className="playerAdmin_factionField">
            <span>New Faction</span>
            <select
              aria-label="New player faction"
              value={selectedId}
              disabled={!supported || !playerId || pending}
              onChange={(event) => setSelectedId(Number(event.target.value) as FactionId)}
            >
              {!selectedId && <option value="">Select faction</option>}
              {FACTIONS.map((faction) => <option key={faction.id} value={faction.id}>{faction.name}</option>)}
            </select>
          </label>
          <PermissionGate action="players:grant"><button className="danger" disabled={!supported || !playerId || !selected || unchanged || pending} onClick={() => void assignFaction()}>Change Faction</button></PermissionGate>
        </div>
        <InlineActionResult result={result} resultKey="assignFaction" />
      </div>
      {!supported && <p className="playerAdmin_note">Faction assignment is unavailable in the detected database schema.</p>}
    </div>
  );
}
