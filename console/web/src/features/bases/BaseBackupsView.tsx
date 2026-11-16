import { PermissionGate } from "../../lib/consoleAccess";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, FileJson, FolderOpen, Pencil, Trash2, Upload } from "lucide-react";
import { ApiError } from "../../api/client";
import { baseBackupsApi, type BaseBackupFailureBody, type BaseBackupRow, type BaseBackupVersion } from "../../api/baseBackups";
import { playersApi } from "../../api/players";
import { SegmentedControl } from "../../components/common/SegmentedControl";
import { saveDownload } from "./saveDownload";
import { DataTable, useSortableRows } from "../../components/common/DataTable";
import { TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { formatUiSentence } from "../../lib/display";

type ConfirmOptions = {
  title?: string;
  confirmLabel?: string;
  warning?: string;
  danger?: boolean;
  details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[];
};

type BaseBackupsViewProps = {
  onError: (text: string) => void;
  confirmAction: (message: string, options?: ConfirmOptions) => Promise<boolean>;
  // Player pawn id. Set when embedded in a player's admin view: the list is
  // that player's backups and imports go to them.
  playerId?: string;
  playerName?: string;
  // Whether that player is online: the backup only appears after they relog.
  playerOnline?: boolean;
  embedded?: boolean;
  // The Bases page's "Bases | Base Backups" toggle, rendered in the title.
  viewSwitch?: ReactNode;
};

type ViewResult = {
  status: "succeeded" | "failed";
  title: string;
  message: string;
  details?: string;
  // Shown as visible text, never hidden in technical details.
  warnings?: string[];
  // Timeouts and results with warnings stay on screen until dismissed or
  // replaced, so an admin who looked away still reads them.
  persistent?: boolean;
};

type ImportTarget = { pawnId: string; name: string; online: boolean };

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function failureBody(error: unknown): BaseBackupFailureBody {
  return error instanceof ApiError ? error.body as BaseBackupFailureBody : {};
}

function formatMs(value: unknown) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) return "unknown";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
}

function mapLabel(map: string) {
  return map ? map.replace(/([a-z])([A-Z])/g, "$1 $2") : "—";
}

const TIMEOUT_TITLES = { export: "Export Timed Out", import: "Import Timed Out", edit: "Update Timed Out", delete: "Delete Timed Out" };

function timeoutResult(operation: keyof typeof TIMEOUT_TITLES, error: unknown): ViewResult {
  const body = failureBody(error);
  return {
    status: "failed",
    title: TIMEOUT_TITLES[operation],
    message: body.error || errorText(error),
    details: [
      `Step: ${body.step || "unknown"}`,
      `Elapsed: ${formatMs(body.elapsedMs)}`,
      `Limit: ${formatMs(body.limitMs)} (${body.timeoutKind === "client_timeout" ? "console query limit" : "database statement limit"})`
    ].join("\n"),
    persistent: true
  };
}

function versionDetails(file?: BaseBackupVersion, server?: BaseBackupVersion) {
  const build = (version?: BaseBackupVersion) => version?.build || version?.steamBuildId || "unknown";
  return [
    { label: "File game build", value: build(file), tone: "danger" as const },
    { label: "This server's build", value: build(server), tone: "accent" as const },
    { label: "File database patches", value: String(file?.appliedPatchesCount ?? "unknown") },
    { label: "This server's database patches", value: String(server?.appliedPatchesCount ?? "unknown") }
  ];
}

// Mirrors validateBaseBackupName in console/api/src/baseBackups.js.
export const BACKUP_NAME_MAX = 23;
function backupNameProblem(name: string) {
  if (!name) return "Backup name cannot be empty.";
  if (name.length > BACKUP_NAME_MAX) return `Backup name can be at most ${BACKUP_NAME_MAX} characters.`;
  if (name.startsWith("##")) return "Backup name cannot start with ##.";
  if (/[\u0000-\u001f\u007f]/.test(name)) return "Backup name cannot contain control characters.";
  return "";
}

// Explicit Search/Clear player search (never search-as-you-type: it queries
// the server), shared by the import receiver and the edit owner.
function PlayerPicker({ label, chooseLabel, disabled, onChoose, onFailure }: {
  label: string;
  chooseLabel: (name: string) => string;
  disabled: boolean;
  onChoose: (player: ImportTarget) => void;
  onFailure: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<ImportTarget[]>([]);

  async function submit() {
    setSearching(true);
    try {
      const response = await playersApi.list({ q: query, pageSize: 25 });
      setCandidates((response.rows || []).map((row) => {
        const pawnId = String(row.actor_id ?? row.player_pawn_id ?? "");
        return {
          pawnId,
          name: String(row.character_name || `Player ${pawnId}`),
          online: String(row.online_status || "").toLowerCase() === "online"
        };
      }).filter((candidate) => candidate.pawnId));
      setSearched(true);
    } catch (error) {
      onFailure(errorText(error));
    } finally {
      setSearching(false);
    }
  }

  function clear() {
    setQuery("");
    setCandidates([]);
    setSearched(false);
  }

  return <div className="base-backup-player-picker">
    <div className="action-row bases-permissions-search-row">
      <input value={query} placeholder={label} aria-label={label} disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") void submit(); }} />
      <button disabled={searching || disabled} onClick={() => void submit()}>Search</button>
      <button disabled={!query && !searched} onClick={clear}>Clear</button>
    </div>
    {searched && !candidates.length && <p className="muted">No players matched that search.</p>}
    {candidates.length > 0 && <ul className="bases-permissions-candidates">
      {candidates.map((candidate) => <li key={candidate.pawnId}>
        <span>{candidate.name}{candidate.online ? " (online)" : ""}</span>
        <button type="button" disabled={disabled} onClick={() => { onChoose(candidate); clear(); }} aria-label={chooseLabel(candidate.name)}>Choose</button>
      </li>)}
    </ul>}
  </div>;
}

export function BaseBackupsView({ onError, confirmAction, playerId = "", playerName = "", playerOnline = false, embedded = false, viewSwitch }: BaseBackupsViewProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<BaseBackupRow[]>([]);
  const [supported, setSupported] = useState(true);
  const [missing, setMissing] = useState<string[]>([]);
  const [maps, setMaps] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [exportingId, setExportingId] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ViewResult | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  // Server-wide view only: the receiving player is picked by search.
  const [target, setTarget] = useState<ImportTarget | null>(null);
  // Editing one backup's owner and/or name.
  const [editing, setEditing] = useState<BaseBackupRow | null>(null);
  const [editName, setEditName] = useState("");
  const [editOwner, setEditOwner] = useState<ImportTarget | null>(null);
  const [editMap, setEditMap] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  useEffect(() => { void load(); }, [playerId]);

  useEffect(() => {
    if (!result || result.persistent) return undefined;
    const timeout = window.setTimeout(() => setResult(null), 10400);
    return () => window.clearTimeout(timeout);
  }, [result]);

  function showResult(next: ViewResult) {
    onError("");
    setResult(next);
  }

  async function load() {
    setLoading(true);
    try {
      const response = await baseBackupsApi.list(playerId);
      setSupported(response.supported !== false);
      setMissing(response.missing || []);
      setMaps(response.maps || []);
      setRows(response.rows || []);
    } catch (error) {
      showResult({ status: "failed", title: "Base Backups Could Not Be Loaded", message: errorText(error) });
    } finally {
      setLoading(false);
    }
  }

  async function handleExport(row: BaseBackupRow) {
    setExportingId(row.id);
    try {
      const response = await baseBackupsApi.download(row.id);
      await saveDownload(response, `base-backup_${row.id}.json`);
      showResult({ status: "succeeded", title: "Base Backup Exported", message: `${row.name} was downloaded.` });
    } catch (error) {
      if (failureBody(error).code === "timeout") showResult(timeoutResult("export", error));
      else showResult({ status: "failed", title: "Base Backup Export Failed", message: errorText(error) });
    } finally {
      setExportingId(null);
    }
  }

  function clearFile() {
    setImportFile(null);
    setFileInputKey((current) => current + 1);
  }

  const importTarget: ImportTarget | null = embedded
    ? (playerId ? { pawnId: playerId, name: playerName || "this player", online: playerOnline } : null)
    : target;

  async function submitImport(file: File, receiver: ImportTarget, allowVersionMismatch: boolean): Promise<void> {
    try {
      const response = await baseBackupsApi.importFile(file, receiver.pawnId, allowVersionMismatch);
      const { counts } = response;
      clearFile();
      showResult({
        status: "succeeded",
        title: "Base Backup Imported",
        message: `${response.name || "The base"} was added to ${receiver.name}'s base backups: ${counts.pieces} pieces, ${counts.placeables} placeables and ${counts.items} stored items. They can redeploy it with the in-game base backup tool.`,
        warnings: response.warnings?.length ? response.warnings : undefined,
        persistent: Boolean(response.warnings?.length)
      });
      await load();
    } catch (error) {
      const body = failureBody(error);
      if (body.code === "version_mismatch" && !allowVersionMismatch) {
        const proceed = await confirmAction(
          `${file.name} was exported from a different game version than this server is running.`,
          {
            title: "Game Version Mismatch",
            confirmLabel: "Import Anyway",
            danger: true,
            warning: "The game's base backup data may have changed between these versions. Importing anyway can leave a backup that fails to redeploy or loses parts of the base.",
            details: versionDetails(body.file, body.server)
          });
        if (proceed) await submitImport(file, receiver, true);
        return;
      }
      if (body.code === "timeout") showResult(timeoutResult("import", error));
      else showResult({ status: "failed", title: "Base Backup Import Failed", message: errorText(error) });
    }
  }

  async function handleImport() {
    if (!importFile || !importTarget) return;
    const confirmed = await confirmAction(
      `Import ${importFile.name} as a base backup for ${importTarget.name}? The backup, its pieces and its stored items are created for them; they can then redeploy it with the in-game base backup tool.`,
      {
        title: "Import Base Backup",
        confirmLabel: "Import",
        warning: importTarget.online ? `${importTarget.name} is online and must log out and back in before the backup appears in their base backup tool.` : undefined
      });
    if (!confirmed) return;
    setResult(null);
    setImporting(true);
    try {
      await submitImport(importFile, importTarget, false);
    } finally {
      setImporting(false);
    }
  }

  function searchFailed(message: string) {
    showResult({ status: "failed", title: "Player Search Failed", message });
  }

  function startEdit(row: BaseBackupRow) {
    setEditing(row);
    // The game's "##..." placeholder is not a name worth prefilling.
    setEditName(row.rawName.startsWith("##") ? "" : row.rawName);
    setEditOwner(null);
    setEditMap(row.map);
  }

  // The table scrolls inside its own capped box, so a panel opened under a
  // lower row can start out of sight.
  const editPanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The whole row, so the cell's padding is in view too; inline "start"
    // brings a sideways-scrolled table (phones) back to its left edge, where
    // the panel sits.
    if (editing) editPanelRef.current?.closest("tr")?.scrollIntoView?.({ block: "nearest", inline: "start" });
  }, [editing?.id]);

  function cancelEdit() {
    setEditing(null);
    setEditOwner(null);
  }

  const trimmedEditName = editName.trim();
  const unnamedBackup = Boolean(editing?.rawName.startsWith("##"));
  // An unnamed backup may keep its placeholder; a named one cannot be blanked.
  const nameProblem = editing && !(unnamedBackup && !trimmedEditName) ? backupNameProblem(trimmedEditName) : "";
  const nameChanged = Boolean(editing) && trimmedEditName !== "" && trimmedEditName !== editing?.rawName;
  const ownerChanged = Boolean(editing && editOwner && editOwner.pawnId !== String(editing.ownerPawnId ?? ""));
  const mapChanged = Boolean(editing) && editMap !== "" && editMap !== editing?.map;
  const canSave = Boolean(editing) && !nameProblem && (nameChanged || ownerChanged || mapChanged) && !saving;
  // The backup's own map is always offered, even if no live claim is on it now.
  const mapOptions = [...new Set([...(editing?.map ? [editing.map] : []), ...maps])]
    .map((map) => ({ value: map, label: mapLabel(map) }));

  async function saveEdit() {
    if (!editing || !canSave) return;
    const changes = [
      ownerChanged && editOwner ? `give it to ${editOwner.name}` : "",
      nameChanged ? `rename it to "${trimmedEditName}"` : "",
      mapChanged ? `move it to ${mapLabel(editMap)}` : ""
    ].filter(Boolean).join(" and ");
    const warnings = [
      mapChanged ? `After the move it can only be redeployed on ${mapLabel(editMap)}, not on ${mapLabel(editing.map)}.` : "",
      ownerChanged && editOwner?.online
        ? `${editOwner.name} is online and must log out and back in before the backup appears in their base backup tool.`
        : ""
    ].filter(Boolean);
    const confirmed = await confirmAction(`Change ${editing.name}: ${changes}?`, {
      title: "Edit Base Backup",
      confirmLabel: "Save",
      warning: warnings.length ? warnings.join(" ") : undefined
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      const response = await baseBackupsApi.update(editing.id, {
        ...(ownerChanged && editOwner ? { ownerPlayerId: editOwner.pawnId } : {}),
        ...(nameChanged ? { name: trimmedEditName } : {}),
        ...(mapChanged ? { map: editMap } : {})
      });
      const parts = [
        response.owner ? `Owner changed from ${response.owner.fromName || editing.ownerName || "the previous owner"} to ${editOwner?.name || "the new owner"}.` : "",
        response.name ? `Renamed from "${response.name.from || editing.name}" to "${response.name.to}".` : "",
        response.map ? `Moved from ${mapLabel(response.map.from)} to ${mapLabel(response.map.to)}.` : ""
      ].filter(Boolean);
      cancelEdit();
      showResult({
        status: "succeeded",
        title: "Base Backup Updated",
        message: parts.join(" "),
        warnings: response.warnings?.length ? response.warnings : undefined,
        persistent: Boolean(response.warnings?.length)
      });
      await load();
    } catch (error) {
      const body = failureBody(error);
      if (body.code === "owner_online") {
        showResult({ status: "failed", title: "Owner Is Online", message: errorText(error), persistent: true });
      } else if (error instanceof ApiError && error.status === 404) {
        cancelEdit();
        showResult({ status: "failed", title: "Backup No Longer Exists", message: errorText(error) });
        await load();
      } else if (body.code === "timeout") {
        showResult(timeoutResult("edit", error));
      } else {
        showResult({ status: "failed", title: "Base Backup Update Failed", message: errorText(error) });
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(row: BaseBackupRow) {
    const confirmed = await confirmAction(
      `Delete the base backup "${row.name}"${row.ownerName ? ` of ${row.ownerName}` : ""}? This permanently deletes the base and everything stored in it; it can no longer be redeployed.`,
      {
        title: "Delete Base Backup",
        confirmLabel: "Delete",
        danger: true,
        details: [
          { label: "Building Pieces", value: row.pieces.toLocaleString(), tone: "danger" },
          { label: "Placeables", value: row.placeables.toLocaleString(), tone: "danger" },
          { label: "Stored Items", value: row.items.toLocaleString(), tone: "danger" },
          { label: "Map", value: mapLabel(row.map) }
        ],
        warning: "A full database backup is taken automatically before anything is deleted. Export this backup first if you might want to import it again. The owner must be offline."
      });
    if (!confirmed) return;
    setDeletingId(row.id);
    try {
      const response = await baseBackupsApi.remove(row.id);
      if (editing?.id === row.id) cancelEdit();
      showResult({
        status: "succeeded",
        title: "Base Backup Deleted",
        message: `"${response.name || row.name}" was permanently deleted: ${response.counts.pieces} pieces, ${response.counts.placeables} placeables and ${response.counts.items} stored items. A full database backup was taken first.`
      });
      await load();
    } catch (error) {
      const body = failureBody(error);
      if (body.code === "owner_online") {
        showResult({ status: "failed", title: "Owner Is Online", message: errorText(error), persistent: true });
      } else if (error instanceof ApiError && error.status === 404) {
        showResult({ status: "failed", title: "Backup No Longer Exists", message: errorText(error) });
        await load();
      } else if (body.code === "timeout") {
        showResult(timeoutResult("delete", error));
      } else {
        showResult({ status: "failed", title: "Base Backup Delete Failed", message: errorText(error), persistent: true });
      }
    } finally {
      setDeletingId(null);
    }
  }

  const busy = importing || saving || exportingId !== null || deletingId !== null;
  const sort = useSortableRows(rows as unknown as Record<string, unknown>[]);
  const columns = embedded
    ? ["name", "map", "pieces", "placeables", "items"]
    : ["ownerName", "name", "map", "pieces", "placeables", "items"];
  const Heading = embedded ? "h4" : "h2";

  // Opens as an expanded row directly under the backup being edited.
  const editPanel = editing && <div ref={editPanelRef} className="base-backup-edit" role="group" aria-label={`Edit ${editing.name}`}>
    <strong>Edit {editing.name}</strong>
    <label className="base-backup-edit-field">
      <span>Backup name</span>
      <input value={editName} maxLength={BACKUP_NAME_MAX} disabled={saving} aria-label="Backup name"
        placeholder={unnamedBackup ? `Unnamed (${editing.name})` : ""}
        onChange={(event) => setEditName(event.target.value)} />
    </label>
    {nameProblem && <p className="base-backup-edit-problem">{nameProblem}</p>}
    <p className="base-backup-target-chosen">
      <span>Owner: <strong>{editOwner ? editOwner.name : editing.ownerName || "Unknown"}</strong>{editOwner ? ` (was ${editing.ownerName || "unknown"})` : ""}</span>
      {editOwner && <button type="button" disabled={saving} onClick={() => setEditOwner(null)}>Keep current owner</button>}
    </p>
    <PlayerPicker label="Search for the new owner" chooseLabel={(name) => `Make ${name} the owner`}
      disabled={saving} onChoose={setEditOwner} onFailure={searchFailed} />
    {mapOptions.length > 0 && <div className="base-backup-edit-map">
      <span>Map</span>
      <SegmentedControl name={`base-backup-map-${editing.id}`} ariaLabel="Map" value={editMap}
        options={mapOptions.map((option) => ({ ...option, disabled: saving }))} onChange={setEditMap} />
    </div>}
    <p className="action-help-note">The current owner must be offline to change a backup. The game only lets a backup be redeployed on the map it was saved on, so moving it to another map changes where it can be placed.</p>
    <div className="base-backup-edit-actions">
      <PermissionGate action="bases:edit-backup"><button disabled={!canSave} onClick={() => void saveEdit()}>{saving ? "Saving..." : "Save"}</button></PermissionGate>
      <button type="button" disabled={saving} onClick={cancelEdit}>Cancel</button>
    </div>
  </div>;

  return <section className={embedded ? "playerAdmin_box base-backups-view" : "panel base-backups-view"}>
    <div className="panel-title">
      <div>
        <Heading>Base Backups</Heading>
        {embedded && <p className="playerAdmin_note">Bases {playerName || "this player"} picked up with the in-game base backup tool.</p>}
      </div>
      {viewSwitch}
      <div className="action-row">
        <button disabled={loading || busy} onClick={() => void load()}>Refresh</button>
      </div>
    </div>

    {result && <div className={`result-panel home-task-result result-${result.status === "succeeded" ? "ok" : "fail"}${result.persistent ? " result-persistent" : ""}`} aria-live="polite">
      <strong>{result.title}</strong>
      <p>{formatUiSentence(result.message)}</p>
      {/* Technical details are debug-only by default; a timeout's step and
          which limit fired are what the admin needs, so they opt in. */}
      {result.warnings && result.warnings.length > 0 && <div className="home-task-result-warnings">
        {result.warnings.map((warning) => <p key={warning}>
          <AlertTriangle size={14} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 6 }} />
          {formatUiSentence(warning)}
        </p>)}
      </div>}
      {result.details && <TechnicalDetails text={result.details} className={result.persistent ? "base-backup-result-details" : ""} />}
      {result.persistent && <button type="button" onClick={() => setResult(null)}>Dismiss</button>}
    </div>}

    {!supported ? <div className="result-panel result-fail">
      <strong>Base Backups Unavailable</strong>
      <p>This game database does not provide the base backup tables and functions needed for export and import.</p>
      {missing.length > 0 && <TechnicalDetails text={missing.join("\n")} />}
    </div> : <>
      <div className="blueprint-import-row base-backup-import-row">
        <label className="blueprint-file-field">
          <span>Base Backup File</span>
          <span className="blueprint-file-control">
            <FileJson size={18} />
            <span>{importFile ? importFile.name : "Select a JSON file"}</span>
          </span>
          <input ref={fileInputRef} key={fileInputKey} type="file" accept=".json,application/json" disabled={busy} aria-label="Base backup file" onChange={(event) => setImportFile(event.target.files?.[0] || null)} />
        </label>
        <button type="button" disabled={busy} onClick={() => fileInputRef.current?.click()}>
          <FolderOpen size={16} /> Select
        </button>
        <PermissionGate action="bases:import-backup"><button disabled={!importFile || !importTarget || busy} onClick={() => void handleImport()}>
          <Upload size={16} /> {importing ? "Importing..." : "Import"}
        </button></PermissionGate>
        {importFile && <button disabled={busy} onClick={clearFile}>Clear</button>}
      </div>

      {!embedded && <div className="base-backup-target">
        {target ? <p className="base-backup-target-chosen">
          <span>Importing to <strong>{target.name}</strong>{target.online ? " (online)" : ""}</span>
          <button type="button" disabled={busy} onClick={() => setTarget(null)}>Change</button>
        </p> : <PlayerPicker label="Search for the receiving player" chooseLabel={(name) => `Import to ${name}`}
          disabled={busy} onChoose={setTarget} onFailure={searchFailed} />}
      </div>}

      <p className="action-help-note">
        An export includes the base's pieces, placeables, land claim and everything stored in it. Importing creates a new backup for the receiving player, who redeploys it with the in-game base backup tool. The original backup is not changed.
      </p>

      <DataTable
        rows={sort.sortedRows}
        emptyMessage={loading ? "Loading base backups..." : "No base backups found. A base appears here after a player picks it up with the in-game base backup tool."}
        columns={columns}
        columnLabels={{ ownerName: "Owner", name: "Backup" }}
        tableClassName="base-backups-table"
        wrapClassName="base-backups-table-wrap"
        actionClassName="actions-column"
        renderCell={(row, column) => {
          const backup = row as unknown as BaseBackupRow;
          if (column === "ownerName") return backup.ownerName || "—";
          if (column === "name") return <span title={backup.rawName || backup.name}>{backup.name}</span>;
          if (column === "map") return mapLabel(backup.map);
          const value = Number(row[column] || 0);
          return value > 0 ? value.toLocaleString() : "—";
        }}
        action={(row) => {
          const backup = row as unknown as BaseBackupRow;
          return <span className="icon-toggle-group">
            <button className="icon-toggle-button" title="Edit owner or name" aria-label={`Edit ${backup.name}`} disabled={busy} onClick={(event) => { event.stopPropagation(); startEdit(backup); }}><Pencil size={16} /></button>
            <button className="icon-toggle-button success" title="Export base backup" aria-label={`Export ${backup.name}`} disabled={busy} onClick={(event) => { event.stopPropagation(); void handleExport(backup); }}><Download size={16} /></button>
            <PermissionGate action="bases:delete-backup"><button className="icon-toggle-button danger" title="Delete base backup" aria-label={`Delete ${backup.name}`} disabled={busy} onClick={(event) => { event.stopPropagation(); void handleDelete(backup); }}><Trash2 size={16} /></button></PermissionGate>
          </span>;
        }}
        sortColumn={sort.sortColumn}
        sortDirection={sort.sortDirection}
        onSort={sort.onSort}
        rowKey={(row) => String(row.id)}
        isRowExpanded={(row) => editing !== null && Number(row.id) === editing.id}
        renderExpandedRow={() => editPanel}
      />
    </>}
  </section>;
}
