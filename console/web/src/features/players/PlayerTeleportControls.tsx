import { PermissionGate } from "../../lib/consoleAccess";
import { useEffect, useRef, useState } from "react";
import { playersApi } from "../../api/players";
import { setupApi } from "../../api/setup";
import { InlineActionResult } from "../../components/common/InlineActionResult";
import { friendlyMapName } from "../maps/mapNames";

type DestinationPlayer = { id: string; name: string; online_status: string; map: string; partition_id: number };
type DestinationBase = { id: string; name: string; owner_name: string; map: string; partition_id: number; is_own: boolean };
type DestinationPartition = { map: string; partition_id: number; name: string; marker_count: number; alive?: boolean | null; ready?: boolean | null; current?: boolean; selectable?: boolean };
type TeleportSource = { map: string; partition_id: number; online_status: string; online: boolean };
type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] }) => Promise<boolean>;

export function PlayerTeleportControls({ playerId, playerName, isOnline, confirmAction, onRefresh, onActionLog }: {
  playerId: string;
  playerName: string;
  isOnline: boolean;
  confirmAction: ConfirmAction;
  onRefresh: () => void;
  onActionLog: (actionType: string, target: string, amount: string, notes: string) => void;
}) {
  const [mode, setMode] = useState<"coordinates" | "player" | "base">("coordinates");
  const [coords, setCoords] = useState({ x: "", y: "", z: "" });
  const [players, setPlayers] = useState<DestinationPlayer[]>([]);
  const [bases, setBases] = useState<DestinationBase[]>([]);
  const [partitions, setPartitions] = useState<DestinationPartition[]>([]);
  const [source, setSource] = useState<TeleportSource | null>(null);
  const [destinationId, setDestinationId] = useState("");
  const [partitionId, setPartitionId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ key: string; tone: "success" | "danger" | "neutral"; text: string; pending?: boolean } | null>(null);
  const resultTimer = useRef<number | null>(null);
  const loadedPlayerId = useRef("");

  function showResult(text: string, tone: "success" | "danger" | "neutral", pending = false) {
    setResult({ key: "teleport", text, tone, pending });
    if (resultTimer.current) window.clearTimeout(resultTimer.current);
    resultTimer.current = pending ? null : window.setTimeout(() => setResult(null), 8000);
  }

  async function loadDestinations() {
    if (!playerId) return;
    setLoading(true);
    try {
      const response = await playersApi.teleportDestinations(playerId);
      setPlayers(response.players || []);
      setBases(response.bases || []);
      setPartitions(response.partitions || []);
      setSource(response.source || null);
      const playerChanged = loadedPlayerId.current !== playerId;
      loadedPlayerId.current = playerId;
      setPartitionId((current) => {
        const available = response.partitions || [];
        if (!playerChanged && available.some((row) => row.selectable !== false && String(row.partition_id) === current)) return current;
        const preferred = available.find((row) => row.current && row.selectable !== false)
          || available.find((row) => row.selectable !== false);
        return String(preferred?.partition_id || "");
      });
    } catch (error) {
      showResult(error instanceof Error ? error.message : "Teleport destinations could not be loaded.", "danger");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDestinations();
    return () => { if (resultTimer.current) window.clearTimeout(resultTimer.current); };
  }, [playerId]);

  useEffect(() => {
    const rows = mode === "player" ? players : mode === "base" ? bases : [];
    setDestinationId((current) => rows.some((row) => row.id === current) ? current : rows[0]?.id || "");
  }, [mode, players, bases]);

  async function useCurrentPosition() {
    showResult(`Loading ${playerName}'s position…`, "neutral", true);
    try {
      const response = await playersApi.position(playerId);
      const position = response.position as Record<string, unknown> | undefined;
      if (!position) throw new Error("No saved player position was found.");
      setCoords({ x: String(position.x ?? ""), y: String(position.y ?? ""), z: String(position.z ?? "") });
      showResult("Position loaded. Edit the coordinates before teleporting if needed.", "success");
    } catch (error) {
      showResult(error instanceof Error ? error.message : "The saved position could not be loaded.", "danger");
    }
  }

  async function teleport() {
    const selectedPlayer = players.find((row) => row.id === destinationId);
    const selectedBase = bases.find((row) => row.id === destinationId);
    const selectedPartition = partitions.find((row) => String(row.partition_id) === partitionId);
    const destinationLabel = mode === "player"
      ? selectedPlayer?.name || "the selected player"
      : mode === "base"
        ? `${selectedBase?.name || "the selected base"}${selectedBase?.owner_name ? ` (${selectedBase.owner_name})` : ""}`
        : `${friendlyMapName(selectedPartition?.map)} · ${selectedPartition?.name || `Partition ${partitionId}`} · X=${coords.x} Y=${coords.y} Z=${coords.z}`;
    if (!(await confirmAction(`Teleport ${playerName} to ${destinationLabel}?`, {
      title: "Teleport Player",
      confirmLabel: "Teleport",
      details: [
        { label: "Player", value: playerName, tone: "accent" },
        { label: "Destination", value: destinationLabel, tone: "success" }
      ]
    }))) return;
    showResult(`Teleporting ${playerName}…`, "neutral", true);
    try {
      const payload = mode === "coordinates"
        ? { mode, partitionId: Number(partitionId), x: Number(coords.x), y: Number(coords.y), z: Number(coords.z) }
        : { mode, destinationId };
      const response = await playersApi.teleport(playerId, payload);
      if (response.supported === false) throw new Error(response.reason || "Teleport is not supported by this server schema.");
      if (response.task) {
        let task = response.task;
        for (let attempt = 0; attempt < 30 && !["succeeded", "failed", "cancelled"].includes(task.status); attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 500));
          task = (await setupApi.task(task.id)).task;
        }
        if (task.status !== "succeeded") throw new Error(task.errorMessage || task.progressMessage || "The live teleport command failed.");
      }
      showResult(response.message || `${playerName} was teleported.`, "success");
      onActionLog("Teleport", playerName, destinationLabel, "Succeeded");
      onRefresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Teleport failed.";
      showResult(message, "danger");
      onActionLog("Teleport", playerName, destinationLabel, `Failed: ${message}`);
    }
  }

  const ownBases = bases.filter((base) => base.is_own);
  const otherBases = bases.filter((base) => !base.is_own);
  const effectiveOnline = source?.online ?? isOnline;
  const validCoords = [coords.x, coords.y, coords.z].every((value) => value.trim() !== "" && Number.isFinite(Number(value)));
  const selectedPartition = partitions.find((row) => String(row.partition_id) === partitionId);
  const coordinatePartitionAllowed = Boolean(selectedPartition) && selectedPartition?.selectable !== false;
  const canTeleport = Boolean(playerId) && !loading && (mode === "coordinates"
    ? validCoords && coordinatePartitionAllowed
    : effectiveOnline && Boolean(destinationId));

  return <div className="playerAdmin_teleportPanel">
    <div className="playerAdmin_actionRow playerAdmin_teleportModeRow">
      <span>Teleport To</span>
      <select aria-label="Teleport destination type" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
        <option value="coordinates">Coordinates</option>
        <option value="player">Another Player</option>
        <option value="base">Player Base</option>
      </select>
      {mode === "player" && <select className="playerAdmin_destinationPlayerSelect" aria-label="Destination player" value={destinationId} onChange={(event) => setDestinationId(event.target.value)} disabled={loading || players.length === 0}>
        {players.length === 0 && <option value="">No Players Available</option>}
        {players.map((player) => <option key={player.id} value={player.id}>{player.name} · {player.map || "Unknown Map"} · {player.online_status}</option>)}
      </select>}
      {mode === "base" && <select className="playerAdmin_destinationBaseSelect" aria-label="Destination base" value={destinationId} onChange={(event) => setDestinationId(event.target.value)} disabled={loading || bases.length === 0}>
        {bases.length === 0 && <option value="">No Bases Available</option>}
        {ownBases.length > 0 && <optgroup label={`${playerName}'s Bases`}>{ownBases.map((base) => <option key={base.id} value={base.id}>{base.name} · {base.map || "Unknown Map"}</option>)}</optgroup>}
        {otherBases.length > 0 && <optgroup label="Other Players' Bases">{otherBases.map((base) => <option key={base.id} value={base.id}>{base.name} · {base.owner_name || "Unknown Owner"} · {base.map || "Unknown Map"}</option>)}</optgroup>}
      </select>}
      {mode === "coordinates" && <div className="playerAdmin_coordinateInputs">
        <select className="playerAdmin_coordinatePartitionSelect" aria-label="Teleport destination map and partition" value={partitionId} onChange={(event) => setPartitionId(event.target.value)} disabled={loading || partitions.length === 0}>
          {partitions.length === 0 && <option value="">No Partitions Available</option>}
          {partitions.map((partition) => <option key={partition.partition_id} value={partition.partition_id} disabled={partition.selectable === false}>
            {friendlyMapName(partition.map)} · {partition.name || `Partition ${partition.partition_id}`} · Partition {partition.partition_id}{partition.current ? " · Current" : partition.ready ? " · Ready" : " · Offline"}
          </option>)}
        </select>
        <input value={coords.x} onChange={(event) => setCoords({ ...coords, x: event.target.value })} placeholder="X" aria-label="Teleport X coordinate" />
        <input value={coords.y} onChange={(event) => setCoords({ ...coords, y: event.target.value })} placeholder="Y" aria-label="Teleport Y coordinate" />
        <input value={coords.z} onChange={(event) => setCoords({ ...coords, z: event.target.value })} placeholder="Z" aria-label="Teleport Z coordinate" />
        <button disabled={!playerId || loading} onClick={() => void useCurrentPosition()}>Use Current Position</button>
      </div>}
      <PermissionGate action="players:teleport"><button disabled={!canTeleport || Boolean(result?.pending)} onClick={() => void teleport()}>Teleport</button></PermissionGate>
      <button className="secondary" disabled={loading || !playerId} onClick={() => void loadDestinations()}>{loading ? "Loading…" : "Reload"}</button>
    </div>
    <p className={!effectiveOnline ? "action-help-note warning" : "action-help-note"}>{effectiveOnline
      ? "Coordinates can use the player's current map and partition. Log the player out fully before moving them to another partition. Player and base destinations use a safe offset."
      : mode === "coordinates"
        ? "Offline coordinate teleport can move the player between Hagga Basin and Deep Desert partitions. The saved location is applied on their next login."
        : "The player must be online to teleport to another player or base."}</p>
    <InlineActionResult result={result} resultKey="teleport" />
  </div>;
}
