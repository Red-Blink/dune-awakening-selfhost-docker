import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Download, Upload } from "lucide-react";
import { api } from "../../api/client";
import { DataTable } from "../../components/common/DataTable";
import { formatUiSentence } from "../../lib/display";

type BlueprintRow = Record<string, unknown> & { id: number; name: string; owner_name?: string; item_id?: number; pieces: number; placeables: number };

export function BlueprintsPanel({ onError, confirmAction }: { onError: (text: string) => void; confirmAction: (message: string, options?: Record<string, unknown>) => Promise<boolean> }) {
  const [rows, setRows] = useState<BlueprintRow[]>([]);
  const [message, setMessage] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [playerId, setPlayerId] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    onError("");
    try {
      const result = await api<BlueprintRow[] | { rows: BlueprintRow[] }>("/api/blueprints");
      const data = Array.isArray(result) ? result : ((result as { rows: BlueprintRow[] }).rows || []);
      setRows(data);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleExport(row: Record<string, unknown>) {
    const id = Number(row.id || 0);
    const name = String(row.name || "");
    try {
      const response = await fetch(`/api/blueprints/${id}/export`);
      if (!response.ok) throw new Error(`Export failed: ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name ? `${name.replace(/[^a-zA-Z0-9_-]/g, "_")}.json` : `blueprint_${id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleImport() {
    if (!importFile || !playerId.trim()) return;
    const id = Number(playerId);
    if (!Number.isFinite(id) || id < 1) {
      setMessage("Invalid player ID");
      return;
    }
    if (!(await confirmAction(`Import blueprint to player ${id}? Player must be offline.`, {}))) return;
    setImporting(true);
    const form = new FormData();
    form.append("file", importFile);
    form.append("player_id", playerId);
    try {
      const result = await api<{ ok: boolean; message?: string; error?: string }>("/api/blueprints/import", { method: "POST", body: form });
      setMessage(result.message || result.error || "Import completed");
      setImportFile(null);
      setPlayerId("");
      load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setImporting(false);
    }
  }

  return <section className="panel">
    <div className="panel-title"><h2>Blueprints</h2></div>
    {message && <div className="result-panel transient-result"><strong>Import Result.</strong><p>{formatUiSentence(message)}</p></div>}
    <div className={`playerAdmin_toggle ${importOpen ? "open" : ""}`}>
      <button className="playerAdmin_toggleHeader" onClick={() => setImportOpen(!importOpen)}>
        {importOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Import Blueprint</span>
      </button>
      {importOpen && <div className="playerAdmin_toggleBody">
        <div className="playerAdmin_section">
          <p className="action-help-note">Player must be offline. Blueprint is imported as a Solido Replicator item into their backpack.</p>
          <div className="action-line">
            <label>Player ID<input type="text" value={playerId} onChange={(e) => setPlayerId(e.target.value)} placeholder="Enter player pawn ID" /></label>
            <label className="file-upload-label">Blueprint JSON<input type="file" accept=".json,application/json" onChange={(e) => setImportFile(e.target.files?.[0] || null)} /></label>
            <button disabled={!importFile || !playerId.trim() || importing} onClick={handleImport}>
              {importing ? "Importing..." : <><Upload size={16} /> Import</>}
            </button>
          </div>
        </div>
      </div>}
    </div>
    <DataTable
      rows={rows}
      emptyMessage="No blueprints found. Import one above."
      action={(row: Record<string, unknown>) => <span className="icon-toggle-group">
        <button className="icon-toggle-button success" title="Download Blueprint" aria-label="Download Blueprint" onClick={(event) => { event.stopPropagation(); handleExport(row); }}><Download size={16} /></button>
      </span>}
      rowKey={(row) => String(row.id)}
    />
  </section>;
}
