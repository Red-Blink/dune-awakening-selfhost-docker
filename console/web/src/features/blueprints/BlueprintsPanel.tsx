import { PermissionGate } from "../../lib/consoleAccess";
import { useEffect, useRef, useState } from "react";
import { Download, FileJson, FolderOpen, Library, Trash2, Upload } from "lucide-react";
import { api, apiDownload } from "../../api/client";
import { DataTable, useSortableRows } from "../../components/common/DataTable";
import { TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { formatUiSentence } from "../../lib/display";
import { CommunityBlueprintBrowser } from "./CommunityBlueprintBrowser";

type BlueprintRow = Record<string, unknown> & {
  id: number;
  name: string;
  owner_name?: string;
  owner_id?: string;
  player_id?: string;
  item_id?: number;
  pieces: number;
  placeables: number;
};

type BlueprintResult = {
  status: "succeeded" | "failed";
  title: string;
  message: string;
  details?: string;
};

type BlueprintsPanelProps = {
  onError: (text: string) => void;
  confirmAction: (message: string, options?: Record<string, unknown>) => Promise<boolean>;
  dbPlayerId?: string;
  playerName?: string;
};

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function blueprintDisplayName(value: unknown, fallback: string) {
  const name = String(value ?? "").replace(/\s+/g, " ").trim().replace(/\.+$/g, "").trim();
  return name || fallback;
}

export function BlueprintsPanel({ onError, confirmAction, dbPlayerId = "", playerName = "" }: BlueprintsPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<BlueprintRow[]>([]);
  const [result, setResult] = useState<BlueprintResult | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ current: number; total: number; name: string } | null>(null);
  const [view, setView] = useState<"player" | "browse">("player");

  useEffect(() => { void load(); }, [dbPlayerId]);

  useEffect(() => {
    if (!result) return undefined;
    const timeout = window.setTimeout(() => setResult(null), 10400);
    return () => window.clearTimeout(timeout);
  }, [result]);

  function showResult(next: BlueprintResult) {
    onError("");
    setResult(next);
  }

  function clearFiles() {
    setImportFiles([]);
    setFileInputKey((current) => current + 1);
  }

  async function load(showFailure = true) {
    onError("");
    setLoading(true);
    try {
      const response = await api<BlueprintRow[] | { rows: BlueprintRow[] }>("/api/blueprints");
      const data = Array.isArray(response) ? response : (response.rows || []);
      const nextRows = dbPlayerId
        ? data.filter((row) => row && String(row.owner_id ?? row.owner_name ?? row.player_id ?? "") === dbPlayerId)
        : data;
      setRows(nextRows);
      setSelected((current) => new Set([...current].filter((id) => nextRows.some((row) => Number(row.id) === id))));
    } catch (error) {
      const message = errorText(error);
      if (showFailure) showResult({ status: "failed", title: "Blueprints Could Not Be Loaded", message });
      else onError(message);
    } finally {
      setLoading(false);
    }
  }

  async function doExport(row: BlueprintRow) {
    const id = Number(row.id || 0);
    const name = String(row.name || "");
    const response = await fetch(`/api/blueprints/${id}/export`);
    if (!response.ok) throw new Error(`The blueprint export failed with status ${response.status}.`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name ? `${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.json` : `blueprint_${id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleExportSingle(row: BlueprintRow) {
    try {
      await doExport(row);
      showResult({ status: "succeeded", title: "Blueprint Exported Successfully", message: `${row.name || `Blueprint ${row.id}`} was downloaded.` });
      await load(false);
    } catch (error) {
      showResult({ status: "failed", title: "Blueprint Export Failed", message: errorText(error) });
    }
  }

  async function exportRows(toExport: BlueprintRow[], label: string, forceArchive = false) {
    if (!toExport.length) return;
    setExporting(true);
    try {
      if (toExport.length === 1 && !forceArchive) {
        await doExport(toExport[0]);
      } else {
        const response = await apiDownload("/api/blueprints/export", {
          method: "POST",
          body: JSON.stringify({ ids: toExport.map((row) => Number(row.id)) })
        });
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] || "blueprints.zip";
        anchor.click();
        URL.revokeObjectURL(url);
      }
      showResult({ status: "succeeded", title: toExport.length === 1 && !forceArchive ? "Blueprint Exported Successfully" : "Blueprint Archive Exported Successfully", message: `${label} downloaded.` });
      await load(false);
    } catch (error) {
      showResult({ status: "failed", title: "Blueprint Export Failed", message: errorText(error) });
    } finally {
      setExporting(false);
    }
  }

  function toggleSelect(id: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((current) => current.size === rows.length && rows.length > 0
      ? new Set()
      : new Set(rows.map((row) => Number(row.id))));
  }

  async function handleDeleteSingle(row: BlueprintRow) {
    const displayName = row.name || `Blueprint ${row.id}`;
    if (!(await confirmAction(`Delete blueprint "${displayName}"? Its Solido Replicator item will also be removed from the player's inventory.`, {}))) return;
    setDeleting(true);
    try {
      const response = await api<{ ok: boolean; error?: string }>(`/api/blueprints/${row.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(response.error || "The blueprint was not deleted.");
      showResult({ status: "succeeded", title: "Blueprint Deleted Successfully", message: `${displayName} was removed.` });
      await load(false);
    } catch (error) {
      showResult({ status: "failed", title: "Blueprint Delete Failed", message: errorText(error) });
    } finally {
      setDeleting(false);
    }
  }

  async function handleDeleteSelected() {
    const toDelete = rows.filter((row) => selected.has(Number(row.id)));
    if (!toDelete.length) return;
    if (!(await confirmAction(`Delete ${toDelete.length} selected blueprint${toDelete.length === 1 ? "" : "s"}? Their Solido Replicator items will also be removed from the player's inventory.`, {}))) return;
    setDeleting(true);
    let deleted = 0;
    const failures: string[] = [];
    for (const row of toDelete) {
      try {
        const response = await api<{ ok: boolean; error?: string }>(`/api/blueprints/${row.id}`, { method: "DELETE" });
        if (!response.ok) throw new Error(response.error || "Delete failed");
        deleted += 1;
      } catch (error) {
        failures.push(`${row.name || `Blueprint ${row.id}`}: ${errorText(error)}`);
      }
    }
    setDeleting(false);
    setSelected(new Set());
    if (failures.length) {
      showResult({
        status: "failed",
        title: "Some Blueprints Could Not Be Deleted",
        message: `${deleted} deleted and ${failures.length} failed.`,
        details: failures.join("\n")
      });
    } else {
      showResult({ status: "succeeded", title: "Blueprints Deleted Successfully", message: `${deleted} blueprint${deleted === 1 ? " was" : "s were"} removed.` });
    }
    await load(false);
  }

  async function handleImport() {
    if (!importFiles.length || !dbPlayerId) return;
    if (importFiles.length > 10) {
      showResult({ status: "failed", title: "Blueprint Import Failed", message: `Select no more than 10 blueprint files at a time. You selected ${importFiles.length}.` });
      return;
    }

    setResult(null);
    setImporting(true);
    try {
      const inventory = await api<{ rows: Record<string, unknown>[]; maxSlots?: number }>(`/api/players/${dbPlayerId}/inventory`);
      // The endpoint now returns equipped gear alongside the backpack; imported
      // blueprints land in the backpack (inventory_type 0), so only those count.
      const itemCount = (inventory.rows || []).filter((row) => Number(row.inventory_type) === 0).length;
      const maxSlots = inventory.maxSlots || 40;
      const available = maxSlots - itemCount;
      if (importFiles.length > available) {
        showResult({
          status: "failed",
          title: "Not Enough Inventory Space",
          message: `${importFiles.length} free slots are required, but only ${available} of ${maxSlots} slots are available.`
        });
        return;
      }
    } catch (error) {
      showResult({ status: "failed", title: "Inventory Check Failed", message: errorText(error) });
      return;
    } finally {
      setImporting(false);
    }

    const count = importFiles.length;
    if (!(await confirmAction(`Import ${count} blueprint${count === 1 ? "" : "s"} for ${playerName || "this player"}? The player must relog before imported blueprints appear in-game.`, {}))) return;

    setResult(null);
    setImporting(true);
    let imported = 0;
    const failures: string[] = [];
    const safetyAdjustments: string[] = [];
    try {
      for (let index = 0; index < importFiles.length; index += 1) {
        const file = importFiles[index];
        setImportProgress({ current: index + 1, total: importFiles.length, name: file.name });
        const form = new FormData();
        form.append("file", file);
        form.append("player_id", dbPlayerId);
        try {
          const response = await api<{
            ok: boolean;
            message?: string;
            error?: string;
            removedClaimConsoles?: number;
            removedPentashields?: number;
          }>("/api/blueprints/import", { method: "POST", body: form });
          if (!response.ok) throw new Error(response.error || "Import failed");
          imported += 1;
          const removedClaims = Number(response.removedClaimConsoles) || 0;
          const removedShields = Number(response.removedPentashields) || 0;
          if (removedClaims > 0) {
            safetyAdjustments.push(
              `${file.name}: removed ${removedClaims} Sub-Fief claim console${removedClaims === 1 ? "" : "s"}`
              + `${removedShields > 0 ? ` and ${removedShields} linked pentashield row${removedShields === 1 ? "" : "s"}` : ""}.`
            );
          }
        } catch (error) {
          failures.push(`${file.name}: ${errorText(error)}`);
        }
      }
    } finally {
      setImportProgress(null);
      setImporting(false);
    }

    clearFiles();
    if (failures.length) {
      showResult({
        status: "failed",
        title: "Some Blueprints Could Not Be Imported",
        message: `${imported} imported and ${failures.length} failed. A relog is required for imported blueprints to appear in-game.`,
        details: [...failures, ...safetyAdjustments].join("\n")
      });
    } else {
      showResult({
        status: "succeeded",
        title: safetyAdjustments.length ? "Blueprints Imported with Safety Adjustments" : "Blueprints Imported Successfully",
        message: `${imported} blueprint${imported === 1 ? " was" : "s were"} added to ${playerName || "the player"}'s inventory. A relog is required.`,
        details: safetyAdjustments.length ? safetyAdjustments.join("\n") : undefined
      });
    }
    await load(false);
  }

  const selectedCount = selected.size;
  const busy = importing || exporting || deleting;
  const blueprintSort = useSortableRows(rows);

  return <section className="blueprints-panel">
    <div className="blueprint-view-tabs" role="tablist" aria-label="Blueprint sections">
      <button type="button" role="tab" aria-selected={view === "player"} className={view === "player" ? "active" : ""} onClick={() => setView("player")}><FileJson size={16} /> Player Blueprints</button>
      <button type="button" role="tab" aria-selected={view === "browse"} className={view === "browse" ? "active" : ""} onClick={() => setView("browse")}><Library size={16} /> Browse Blueprints</button>
    </div>

    {view === "browse" ? <CommunityBlueprintBrowser dbPlayerId={dbPlayerId} playerName={playerName} confirmAction={confirmAction} onInstalled={() => load(false)} /> : <>
    {result && <div className={`result-panel home-task-result result-${result.status === "succeeded" ? "ok" : "fail"}`} aria-live="polite">
      <strong>{result.title}</strong>
      <p>{formatUiSentence(result.message)}</p>
      {result.details && <TechnicalDetails text={result.details} />}
    </div>}

    {importing && importProgress && <div className="result-panel blueprint-import-progress result-running" aria-live="polite">
      <div className="blueprint-progress-heading">
        <strong className="loading-dots">Importing Blueprints</strong>
        <span>{importProgress.current} of {importProgress.total}</span>
      </div>
      <p title={importProgress.name}>{importProgress.name}</p>
      <div className="blueprint-progress-track"><span style={{ width: `${(importProgress.current / importProgress.total) * 100}%` }} /></div>
    </div>}

    <div className="blueprint-import-row">
      <label className="blueprint-file-field">
        <span>Blueprint Files</span>
        <span className="blueprint-file-control">
          <FileJson size={18} />
          <span>{importFiles.length ? `${importFiles.length} file${importFiles.length === 1 ? "" : "s"} selected` : "Select JSON files"}</span>
        </span>
        <input ref={fileInputRef} key={fileInputKey} type="file" accept=".json,application/json" multiple disabled={busy} onChange={(event) => setImportFiles(Array.from(event.target.files || []))} />
      </label>
      <button type="button" disabled={busy} onClick={() => fileInputRef.current?.click()}>
        <FolderOpen size={16} /> Select
      </button>
      <PermissionGate action="blueprints:import"><button disabled={!importFiles.length || !dbPlayerId || busy} onClick={() => void handleImport()}>
        <Upload size={16} /> {importing ? "Importing..." : "Import"}
      </button></PermissionGate>
      {importFiles.length > 0 && <button disabled={busy} onClick={clearFiles}>Clear</button>}
    </div>

    <p className="action-help-note blueprint-help-note">
      Imported blueprints are added to {playerName || "the player"}'s backpack as Solido Replicator items. The player must relog to see them in-game, and must unlock every building piece and placeable included in a blueprint before it can be placed.
    </p>

    <DataTable
      rows={blueprintSort.sortedRows}
      emptyMessage={loading ? "Loading blueprints..." : "No blueprints found. Import a blueprint above."}
      columns={["name", "pieces", "placeables", "item_id"]}
      tableClassName="blueprints-table"
      actionClassName="actions-column blueprint-actions-column"
      secondaryActionClassName="actions-column blueprint-select-column"
      secondaryActionLabel="Select"
      secondaryActionPosition="start"
      secondaryAction={(row) => {
        const blueprint = row as BlueprintRow;
        const id = Number(blueprint.id);
        return <label className="blueprint-row-select" title="Select blueprint">
          <input type="checkbox" checked={selected.has(id)} disabled={busy} aria-label={`Select ${blueprint.name || `blueprint ${id}`}`} onChange={() => toggleSelect(id)} />
        </label>;
      }}
      renderCell={(row, column) => {
        if (column === "name") {
          const name = blueprintDisplayName(row.name, `Blueprint ${row.id}`);
          return <span className="blueprint-name" title={name}>{name}</span>;
        }
        const value = Number(row[column] || 0);
        return value > 0 ? value.toLocaleString() : "—";
      }}
      action={(row) => {
        const blueprint = row as BlueprintRow;
        return <span className="icon-toggle-group">
          <button className="icon-toggle-button success" title="Download blueprint" aria-label="Download blueprint" disabled={busy} onClick={(event) => { event.stopPropagation(); void handleExportSingle(blueprint); }}><Download size={16} /></button>
          <PermissionGate action="blueprints:delete"><button className="icon-toggle-button danger" title="Delete blueprint" aria-label="Delete blueprint" disabled={busy} onClick={(event) => { event.stopPropagation(); void handleDeleteSingle(blueprint); }}><Trash2 size={16} /></button></PermissionGate>
        </span>;
      }}
      sortColumn={blueprintSort.sortColumn}
      sortDirection={blueprintSort.sortDirection}
      onSort={blueprintSort.onSort}
      rowKey={(row) => String(row.id)}
    />

    {rows.length > 0 && (
      <div className="blueprint-list-toolbar blueprint-list-toolbar-bottom">
        <label className="blueprint-select-all">
          <input type="checkbox" checked={selectedCount === rows.length} disabled={busy} onChange={toggleSelectAll} />
          <span>{selectedCount ? `${selectedCount} selected` : "Select all"}</span>
        </label>
        <div className="service-actions">
          <PermissionGate action="blueprints:export"><button disabled={!selectedCount || busy} onClick={() => void exportRows(rows.filter((row) => selected.has(Number(row.id))), `${selectedCount} selected blueprint${selectedCount === 1 ? "" : "s"}`)}>
            <Download size={16} /> Export Selected
          </button></PermissionGate>
          <PermissionGate action="blueprints:delete"><button className="danger" disabled={!selectedCount || busy} onClick={() => void handleDeleteSelected()}>
            <Trash2 size={16} /> Delete Selected
          </button></PermissionGate>
          <PermissionGate action="blueprints:export"><button disabled={busy} onClick={() => void exportRows(rows, `${rows.length} blueprint${rows.length === 1 ? "" : "s"}`, true)}>
            <Download size={16} /> Export All
          </button></PermissionGate>
        </div>
      </div>
    )}
    </>}
  </section>;
}
