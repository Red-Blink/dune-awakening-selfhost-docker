import { useCallback, useEffect, useRef, useState } from "react";
import { useConsoleAccess } from "../../lib/consoleAccess";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { playersApi, type DeletedCharacterAsset, type DeletedCharacterAssetsResult, type DeletedCharacterEntry } from "../../api/players";
import { vehiclesApi } from "../../api/vehicles";
import { DataTable } from "../../components/common/DataTable";
import { formatAbsoluteDateTime } from "../../lib/display";
import { cachedInstanceNames, resolveInstanceNames } from "../maps/instanceNames";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// Same style as Active players' Last Online one toggle away -- notably "Last
// seen" here is the very same field (last_avatar_activity) that view renders.
function formatTimestamp(value: string | null) {
  return formatAbsoluteDateTime(value, "Unknown");
}

// dune.account_removal_log stores the game's own wording. "new char in fls"
// means the player deleted this character and immediately made another one on
// the same Funcom account, which is a very different situation for an admin
// than an outright deletion -- the account is still active, just under a new
// character.
export function deletionLabel(reason: string) {
  const normalized = reason.trim().toLowerCase();
  if (normalized === "new char in fls") return "Recreated Character";
  if (normalized === "deleted in fls") return "Deleted In FLS";
  if (!normalized) return "Reason Unrecorded";
  return reason.trim().replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function coordinateSummary(asset: DeletedCharacterAsset) {
  if (asset.x === null || asset.y === null) return "";
  return `${Math.round(asset.x)}, ${Math.round(asset.y)}`;
}

function locationLabel(asset: DeletedCharacterAsset, instanceNames: Map<string, string>) {
  const instanceName = asset.partitionMap && asset.partitionId
    ? instanceNames.get(`${asset.partitionMap}:${asset.partitionId}`)
    : "";
  return instanceName || asset.partitionLabel || asset.map || "Unknown";
}

function assetRows(assets: DeletedCharacterAsset[], instanceNames: Map<string, string>) {
  return assets.map((asset) => ({
    id: asset.id,
    name: asset.name || "Unnamed",
    asset_type: asset.assetType || "Unknown",
    location: locationLabel(asset, instanceNames),
    size: asset.kind === "base"
      ? asset.pieceCount === null ? "" : `${asset.pieceCount.toLocaleString()} pieces`
      : asset.moduleCount === null ? "" : `${asset.moduleCount.toLocaleString()} modules`,
    coordinates: coordinateSummary(asset),
    matched_by: asset.matchedBy || "No Respawn Record"
  }));
}

const BASE_COLUMNS = ["id", "name", "asset_type", "location", "size", "coordinates", "matched_by"];
const VEHICLE_COLUMNS = ["id", "name", "asset_type", "location", "size", "coordinates", "matched_by"];

// Label and value carry different neutral steps inside the pill so the four
// chips read as four facts rather than one run-on line. Both are neutrals, not
// further amber steps -- another warm tone here blends into the panel.
function MetaChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="deleted-character-chip">
      <span className="deleted-character-chip-label">{label}</span>
      <span className="deleted-character-chip-value">{value}</span>
    </span>
  );
}

type AssetTableProps = {
  title: string;
  assets: DeletedCharacterAsset[];
  emptyMessage: string;
  columns: string[];
  columnLabels: Record<string, string>;
  onOpen?: (id: string) => void;
  onDelete?: (asset: DeletedCharacterAsset) => void;
  deletingId?: string;
  queuedDeleteIds?: Set<string>;
  instanceNames: Map<string, string>;
};

function AssetTable({ title, assets, emptyMessage, columns, columnLabels, onOpen, onDelete, deletingId = "", queuedDeleteIds = new Set(), instanceNames }: AssetTableProps) {
  const access = useConsoleAccess();
  if (!access.can(title === "Bases" ? "bases:read" : "vehicles:read")) return null;
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  return (
    <div className="deleted-character-assets-group">
      <h5 className="deleted-character-assets-subtitle">{title}</h5>
      <DataTable
        rows={assetRows(assets, instanceNames)}
        columns={columns}
        columnLabels={columnLabels}
        tableClassName="deleted-character-assets-table"
        wrapClassName="deleted-character-table-wrap"
        rowKey={(row) => String(row.id)}
        emptyMessage={emptyMessage}
        actionClassName="actions-column deleted-character-asset-actions"
        action={onDelete && access.can("vehicles:delete") ? (row) => {
          const asset = assetsById.get(String(row.id));
          if (!asset) return null;
          const label = asset.name || `vehicle ${asset.id}`;
          const queued = queuedDeleteIds.has(asset.id);
          return <button
            type="button"
            className="icon-toggle-button danger"
            title={queued ? "Delete Queued" : "Delete Vehicle"}
            aria-label={queued ? `Delete queued for ${label}` : `Delete ${label}`}
            disabled={queued || deletingId === asset.id}
            onClick={(event) => { event.stopPropagation(); onDelete(asset); }}
          ><Trash2 size={16} /></button>;
        } : onOpen ? (row) => (
          <button type="button" onClick={() => onOpen(String(row.id))}>Open Base</button>
        ) : undefined}
      />
    </div>
  );
}

type DeletedCharacterAssetsProps = {
  onOpenBase?: (baseId: string) => void;
  onError?: (text: string) => void;
  confirmAction?: (message: string, options?: { title?: string; confirmLabel?: string; warning?: string; danger?: boolean; details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] }) => Promise<boolean>;
};

export function DeletedCharacterAssets({ onOpenBase, onError, confirmAction }: DeletedCharacterAssetsProps) {
  const access = useConsoleAccess();
  const [result, setResult] = useState<DeletedCharacterAssetsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [supported, setSupported] = useState(true);
  const [message, setMessage] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionFailed, setActionFailed] = useState(false);
  const [expandedId, setExpandedId] = useState("");
  const [unattributedOpen, setUnattributedOpen] = useState(false);
  const [deletingVehicleId, setDeletingVehicleId] = useState("");
  const [queuedDeleteIds, setQueuedDeleteIds] = useState<Set<string>>(new Set());
  const [instanceNames, setInstanceNames] = useState<Map<string, string>>(new Map());
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setMessage("");
    try {
      const next = await playersApi.deletedCharacters();
      if (requestIdRef.current !== requestId) return;
      const isSupported = next.capabilities?.deletedCharacters !== false;
      setSupported(isSupported);
      setResult(isSupported ? next : null);
      setMessage(isSupported ? "" : next.reason || "");
      setExpandedId((current) => (current && (next.characters || []).some(
        (character) => character.characterStateId === current) ? current : ""));
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setResult(null);
      setSupported(true);
      setMessage(errorText(error));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { requestIdRef.current += 1; };
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    if (!access.can("vehicles:read")) return;
    void vehiclesApi.pendingDeletes().then((pending) => {
      if (!cancelled && pending.supported) {
        setQueuedDeleteIds((current) => new Set([
          ...current,
          ...(pending.pending || []).map((entry) => String(entry.vehicleId))
        ]));
      }
    }).catch(() => {
      // Queue state is informational here. The delete endpoint remains the
      // authority and will safely deduplicate an already queued request.
    });
    return () => { cancelled = true; };
  }, [access]);

  const characters = result?.characters || [];
  const totals = result?.totals;
  const unattributed = result?.unattributed || { bases: [], vehicles: [] };
  const unattributedCount = unattributed.bases.length + unattributed.vehicles.length;
  const partitionMapsKey = [...new Set([
    ...characters.flatMap((character) => [
      ...(Array.isArray(character.bases) ? character.bases : []),
      ...(Array.isArray(character.vehicles) ? character.vehicles : [])
    ]),
    ...unattributed.bases,
    ...unattributed.vehicles
  ].map((asset) => String(asset.partitionMap || "").trim()).filter(Boolean))].sort().join(",");

  useEffect(() => {
    const maps = partitionMapsKey ? partitionMapsKey.split(",") : [];
    if (!maps.length) return undefined;
    const cached = cachedInstanceNames(maps);
    if (cached) {
      setInstanceNames(cached);
      return undefined;
    }
    let cancelled = false;
    void resolveInstanceNames(maps).then((resolved) => {
      if (!cancelled && resolved) setInstanceNames(resolved);
    });
    return () => { cancelled = true; };
  }, [partitionMapsKey]);

  const assetsOf = (character: DeletedCharacterEntry) => ({
    bases: Array.isArray(character.bases) ? character.bases : [],
    vehicles: Array.isArray(character.vehicles) ? character.vehicles : []
  });
  const characterRows = characters.map((character) => {
    const { bases, vehicles } = assetsOf(character);
    return {
      character_state_id: character.characterStateId,
      character_name: character.characterName,
      status: deletionLabel(character.removalReason),
      deleted_at: formatTimestamp(character.deletedAt),
      replacement: character.replacementCharacterName || "None",
      assets: `${bases.length} ${bases.length === 1 ? "base" : "bases"} · ${vehicles.length} ${vehicles.length === 1 ? "vehicle" : "vehicles"}`
    };
  });
  const byId = new Map<string, DeletedCharacterEntry>(characters.map((character) => [character.characterStateId, character]));
  // Refresh keeps the previous result on screen. Tearing the whole tree down for
  // the spinner collapsed the section from ~918px to ~71px and back on every
  // click; only the very first load, with nothing to show yet, gets the panel.
  const showInitialLoading = loading && !result && !message;

  function toggleExpanded(id: string) {
    setExpandedId((current) => (current === id ? "" : id));
  }

  async function deleteVehicle(asset: DeletedCharacterAsset) {
    if (!confirmAction) return;
    const label = asset.name || `vehicle ${asset.id}`;
    const confirmed = await confirmAction(
      `Delete "${label}"? This permanently deletes the vehicle and everything stored in it.`,
      {
        title: "Delete Vehicle",
        confirmLabel: "Delete",
        danger: true,
        details: [{ label: "Location", value: locationLabel(asset, instanceNames), tone: "danger" }],
        warning: "A full database backup is taken automatically. If the vehicle's map is running, deletion is queued until that map safely restarts or stops."
      }
    );
    if (!confirmed) return;

    setActionMessage("");
    setActionFailed(false);
    onError?.("");
    setDeletingVehicleId(asset.id);
    try {
      const response = await vehiclesApi.deleteVehicle(asset.id);
      if (response.result?.queued) {
        setQueuedDeleteIds((current) => new Set(current).add(asset.id));
        setActionMessage(`Delete for "${label}" is queued and will apply when its map next restarts or stops.`);
      } else {
        setActionMessage(`"${label}" was deleted.`);
        await load();
      }
    } catch (error) {
      const text = errorText(error);
      setActionMessage(text);
      setActionFailed(true);
      onError?.(text);
    } finally {
      setDeletingVehicleId("");
    }
  }

  return (
    <section className="deleted-character-assets" aria-busy={loading}>
      <div className="panel-title">
        <div>
          <p className="action-help-note">
            Characters deleted from this server that still hold bases or vehicles. Deleting a character removes its
            ownership rows, so assets are matched back through the respawn points the character had set.
          </p>
        </div>
        <button type="button" disabled={loading} onClick={() => void load()}>Refresh</button>
      </div>

      {showInitialLoading && <div className="loading-panel"><span className="spinner" aria-hidden="true" /><strong className="loading-dots">Loading Deleted Characters</strong></div>}

      {!loading && message && <p className={`playerAdmin_note${supported ? " danger" : ""}`}>{message}</p>}
      {actionMessage && <p
        className={`inline-task-result result-${actionFailed ? "fail" : "ok"}`}
        role={actionFailed ? "alert" : "status"}
      ><strong>{actionMessage}</strong></p>}

      {!showInitialLoading && !message && totals && <>
        <p className="action-help-note deleted-character-summary">
          {totals.deletedCharactersHoldingAssets.toLocaleString()} deleted {totals.deletedCharactersHoldingAssets === 1 ? "character holds" : "characters hold"} {totals.attributedBases.toLocaleString()} {totals.attributedBases === 1 ? "base" : "bases"} and {totals.attributedVehicles.toLocaleString()} {totals.attributedVehicles === 1 ? "vehicle" : "vehicles"}.
          {totals.deletedCharactersWithoutAssets > 0 && ` ${totals.deletedCharactersWithoutAssets.toLocaleString()} other deleted ${totals.deletedCharactersWithoutAssets === 1 ? "character holds" : "characters hold"} none.`}
        </p>

        {result?.truncated && <p className="danger-note">Results were capped. Some deleted characters or orphaned assets are not shown.</p>}

        <DataTable
          rows={characterRows}
          columns={["character_name", "status", "deleted_at", "replacement", "assets"]}
          columnLabels={{
            character_name: "Character",
            deleted_at: "Deleted",
            replacement: "Replacement Character",
            assets: "Holds"
          }}
          tableClassName="deleted-character-table"
          wrapClassName="deleted-character-table-wrap"
          rowKey={(row) => String(row.character_state_id)}
          emptyMessage="No deleted characters are holding bases or vehicles."
          secondaryActionPosition="start"
          secondaryActionLabel=""
          secondaryActionClassName="deleted-character-expand-column"
          // The expanded row is the only place the per-asset Open buttons live,
          // so row-click alone would put them out of reach of a keyboard. Bases
          // and Vehicles pair their expandable rows with this same button.
          secondaryAction={(row) => {
            const id = String(row.character_state_id);
            const isExpanded = id === expandedId;
            const label = `${isExpanded ? "Collapse" : "Show"} Assets Held By ${String(row.character_name) || `Character ${id}`}`;
            return <button
              className="deleted-character-expand-button"
              title={label}
              aria-label={label}
              aria-expanded={isExpanded}
              onClick={(event) => { event.stopPropagation(); toggleExpanded(id); }}
            >{isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>;
          }}
          onRowClick={(row) => toggleExpanded(String(row.character_state_id))}
          isRowExpanded={(row) => String(row.character_state_id) === expandedId}
          renderExpandedRow={(row) => {
            const character = byId.get(String(row.character_state_id));
            if (!character) return null;
            return (
              <div className="deleted-character-detail">
                <div className="deleted-character-meta">
                  <MetaChip label="Account" value={character.accountId || "Unknown"} />
                  <MetaChip label="Character State" value={character.characterStateId} />
                  {character.flsId && <MetaChip label="FLS" value={character.flsId} />}
                  <MetaChip label="Last Seen" value={formatTimestamp(character.lastAvatarActivity || character.lastLoginTime)} />
                </div>
                <AssetTable
                  title="Bases"
                  assets={assetsOf(character).bases}
                  emptyMessage="No bases."
                  columns={BASE_COLUMNS}
                  columnLabels={{ id: "Base ID", asset_type: "Type", size: "Size", matched_by: "Matched By" }}
                  onOpen={onOpenBase}
                  instanceNames={instanceNames}
                />
                <AssetTable
                  title="Vehicles"
                  assets={assetsOf(character).vehicles}
                  emptyMessage="No vehicles."
                  columns={VEHICLE_COLUMNS}
                  columnLabels={{ id: "Vehicle ID", asset_type: "Type", size: "Fitted", matched_by: "Matched By" }}
                  onDelete={confirmAction ? deleteVehicle : undefined}
                  deletingId={deletingVehicleId}
                  queuedDeleteIds={queuedDeleteIds}
                  instanceNames={instanceNames}
                />
              </div>
            );
          }}
        />

        <section className={`playerAdmin_toggle deleted-character-unattributed ${unattributedOpen ? "open" : ""}`}>
          <button
            type="button"
            className="playerAdmin_toggleHeader"
            aria-expanded={unattributedOpen}
            onClick={() => setUnattributedOpen((current) => !current)}
          >
            {unattributedOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
            <span>Unattributed Orphans</span>
            <span className="deleted-character-unattributed-count">{unattributedCount.toLocaleString()} {unattributedCount === 1 ? "Asset" : "Assets"}</span>
          </button>
          {unattributedOpen && <div className="playerAdmin_toggleBody">
            <p className="action-help-note">
              Claimed once but held by no living character, with no respawn record tying them to a specific deleted one.
              A character who never set a respawn point at a base or vehicle leaves it here rather than under their name.
            </p>
            <AssetTable
              title="Bases"
              assets={unattributed.bases}
              emptyMessage="No unattributed bases."
              columns={BASE_COLUMNS}
              columnLabels={{ id: "Base ID", asset_type: "Type", size: "Size", matched_by: "Matched By" }}
              onOpen={onOpenBase}
              instanceNames={instanceNames}
            />
            <AssetTable
              title="Vehicles"
              assets={unattributed.vehicles}
              emptyMessage="No unattributed vehicles."
              columns={VEHICLE_COLUMNS}
              columnLabels={{ id: "Vehicle ID", asset_type: "Type", size: "Fitted", matched_by: "Matched By" }}
              onDelete={confirmAction ? deleteVehicle : undefined}
              deletingId={deletingVehicleId}
              queuedDeleteIds={queuedDeleteIds}
              instanceNames={instanceNames}
            />
          </div>}
        </section>
      </>}
    </section>
  );
}
