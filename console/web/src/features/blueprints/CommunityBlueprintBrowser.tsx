import { PermissionGate } from "../../lib/consoleAccess";
import { Fragment, useEffect, useRef, useState } from "react";
import { ChevronDown, ExternalLink, Search, SendToBack } from "lucide-react";
import { api } from "../../api/client";
import { TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { formatUiSentence } from "../../lib/display";

const PAGE_SIZES = [12, 24, 48];
const BUILDING_SETS = ["", "General", "CHOAM", "Atreides", "Harkonnen", "Smuggler", "Fremen", "Watershippers", "Desert Mechanic", "Dune Man"];

type CommunityBlueprint = {
  id: string;
  title: string;
  description: string;
  ownerName: string;
  buildingSet: string;
  tags: string[];
  pieces: number;
  placeables: number;
  likes: number;
  downloads: number;
  version: number;
  hasPreview: boolean;
  previewNight: boolean;
  updatedAt: string;
};

type BrowserProps = {
  dbPlayerId: string;
  playerName: string;
  confirmAction: (message: string, options?: Record<string, unknown>) => Promise<boolean>;
  onInstalled: () => Promise<void> | void;
};

type InstallResult = {
  ok?: boolean;
  blueprintName?: string;
  pieces?: number;
  placeables?: number;
  removedClaimConsoles?: number;
  removedPentashields?: number;
  online?: boolean;
  warning?: string;
};

function formatDate(value: string) {
  if (!value) return "Unknown";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleDateString();
}

function previewUrl(row: CommunityBlueprint) {
  const revision = `${row.version}-${row.updatedAt || "unknown"}`;
  return `/api/blueprints/community/${encodeURIComponent(row.id)}/preview?v=${encodeURIComponent(revision)}`;
}

function resultDetails(result: InstallResult) {
  const details = [];
  if (result.removedClaimConsoles) details.push(`Removed ${result.removedClaimConsoles} unsafe Sub-Fief claim console${result.removedClaimConsoles === 1 ? "" : "s"}.`);
  if (result.removedPentashields) details.push(`Removed ${result.removedPentashields} linked pentashield row${result.removedPentashields === 1 ? "" : "s"}.`);
  if (result.warning) details.push(result.warning);
  return details.join("\n");
}

export function CommunityBlueprintBrowser({ dbPlayerId, playerName, confirmAction, onInstalled }: BrowserProps) {
  const requestRef = useRef(0);
  const [rows, setRows] = useState<CommunityBlueprint[]>([]);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [buildingSet, setBuildingSet] = useState("");
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState("");
  const [installing, setInstalling] = useState("");
  const [result, setResult] = useState<{ ok: boolean; title: string; message: string; details?: string } | null>(null);

  useEffect(() => {
    const request = ++requestRef.current;
    const params = new URLSearchParams({
      q: submittedQuery,
      set: buildingSet,
      sort,
      limit: String(pageSize),
      offset: String((page - 1) * pageSize)
    });
    setLoading(true);
    setError("");
    void api<{ rows: CommunityBlueprint[]; total: number }>(`/api/blueprints/community?${params}`)
      .then((response) => {
        if (request !== requestRef.current) return;
        setRows(response.rows || []);
        setTotal(Number(response.total) || 0);
      })
      .catch((loadError) => {
        if (request !== requestRef.current) return;
        setRows([]);
        setTotal(0);
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (request === requestRef.current) setLoading(false);
      });
  }, [buildingSet, page, pageSize, sort, submittedQuery]);

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    setPage(1);
    setSubmittedQuery(query.trim());
  }

  async function install(row: CommunityBlueprint) {
    if (!dbPlayerId || installing) return;
    const confirmed = await confirmAction(
      `Download and install “${row.title}” for ${playerName || "this player"}? The Blueprint will be added to the player's backpack and will appear after they relog.`,
      {
        title: "Install Community Blueprint",
        confirmLabel: "Install",
        details: [
          { label: "Player", value: playerName || dbPlayerId, tone: "accent" },
          { label: "Blueprint", value: row.title },
          { label: "Creator", value: row.ownerName },
          { label: "Content", value: `${row.pieces.toLocaleString()} pieces · ${row.placeables.toLocaleString()} placeables` }
        ]
      }
    );
    if (!confirmed) return;
    setInstalling(row.id);
    setResult(null);
    try {
      const response = await api<InstallResult>(`/api/blueprints/community/${encodeURIComponent(row.id)}/install`, {
        method: "POST",
        body: JSON.stringify({ playerId: dbPlayerId })
      });
      const details = resultDetails(response);
      setResult({
        ok: true,
        title: "Blueprint Installed Successfully",
        message: `${response.blueprintName || row.title} was added to ${playerName || "the player"}'s backpack. The player must relog before it appears in-game.`,
        details: details || undefined
      });
      await onInstalled();
    } catch (installError) {
      setResult({
        ok: false,
        title: "Blueprint Could Not Be Installed",
        message: installError instanceof Error ? installError.message : String(installError)
      });
    } finally {
      setInstalling("");
    }
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const rangeStart = total > 0 ? (page - 1) * pageSize + 1 : 0;
  const rangeEnd = Math.min(total, page * pageSize);
  const hasPreviousPage = page > 1;
  const hasNextPage = page < pages;

  return <section className="community-blueprint-browser">
    <div className="community-blueprint-intro">
      <div><h5>Community Blueprints</h5><p>Browse public designs from DuneDocker Base Builder and install one directly for {playerName || "the selected player"}.</p></div>
      <a href="https://blueprints.dunedocker.app" target="_blank" rel="noreferrer">Open Base Builder <ExternalLink size={15} /></a>
    </div>

    <form className="community-blueprint-filters" onSubmit={submitSearch}>
      <label><span>Search</span><span className="community-blueprint-search"><Search size={16} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, creator, or tag" /></span></label>
      <label><span>Building Set</span><select value={buildingSet} onChange={(event) => { setBuildingSet(event.target.value); setPage(1); }}>{BUILDING_SETS.map((value) => <option key={value || "all"} value={value}>{value || "All Sets"}</option>)}</select></label>
      <label><span>Sort By</span><select value={sort} onChange={(event) => { setSort(event.target.value); setPage(1); }}><option value="newest">Newest</option><option value="popular">Most Liked</option><option value="downloads">Most Downloaded</option></select></label>
      <button type="submit" disabled={loading}>Search</button>
    </form>

    {result && <div className={`result-panel home-task-result result-${result.ok ? "ok" : "fail"}`} aria-live="polite"><strong>{result.title}</strong><p>{formatUiSentence(result.message)}</p>{result.details && <TechnicalDetails text={result.details} />}</div>}
    {error && <div className="result-panel result-fail" role="alert"><strong>Community Blueprints Could Not Be Loaded</strong><p>{formatUiSentence(error)}</p></div>}

    <div className="community-blueprint-table-wrap">
      <table className="community-blueprint-table">
        <thead><tr><th>Preview</th><th>Blueprint</th><th>Creator</th><th>Building Set</th><th>Pieces</th><th>Community</th><th>Actions</th></tr></thead>
        <tbody>
          {rows.map((row) => <Fragment key={row.id}>
            <tr>
              <td><div className={`community-blueprint-thumbnail${row.previewNight ? " night" : ""}`}>{row.hasPreview ? <img src={previewUrl(row)} alt={`Preview of ${row.title}`} loading="lazy" /> : <span>No Preview</span>}</div></td>
              <td><strong>{row.title}</strong><small>Updated {formatDate(row.updatedAt)}</small></td>
              <td>{row.ownerName}</td><td>{row.buildingSet}</td>
              <td><strong>{row.pieces.toLocaleString()}</strong><small>{row.placeables.toLocaleString()} placeables</small></td>
              <td><span>♥ {row.likes.toLocaleString()}</span><small>↓ {row.downloads.toLocaleString()}</small></td>
              <td><div className="community-blueprint-actions"><button type="button" className="secondary" aria-expanded={expanded === row.id} onClick={() => setExpanded((current) => current === row.id ? "" : row.id)}>Details <ChevronDown size={15} /></button><PermissionGate action="blueprints:import"><button type="button" disabled={!dbPlayerId || Boolean(installing)} onClick={() => void install(row)}><SendToBack size={15} /> {installing === row.id ? "Installing..." : "Install"}</button></PermissionGate></div></td>
            </tr>
            {expanded === row.id && <tr className="community-blueprint-detail-row"><td colSpan={7}><div className="community-blueprint-details"><div>{row.hasPreview ? <img src={previewUrl(row)} alt={`Large preview of ${row.title}`} /> : <span className="community-blueprint-no-preview">No Preview Available</span>}</div><section><h5>{row.title}</h5><p>{row.description || "No description was provided."}</p>{row.tags.length > 0 && <div className="community-blueprint-tags">{row.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}<a href={`https://blueprints.dunedocker.app/blueprint/${encodeURIComponent(row.id)}`} target="_blank" rel="noreferrer">View Full 3D Blueprint <ExternalLink size={14} /></a></section></div></td></tr>}
          </Fragment>)}
          {!loading && !rows.length && !error && <tr><td colSpan={7} className="community-blueprint-empty">No public Blueprints match these filters.</td></tr>}
          {loading && <tr><td colSpan={7} className="community-blueprint-empty loading-dots">Loading Community Blueprints</td></tr>}
        </tbody>
      </table>
    </div>

    <div className="panel-title community-blueprint-pagination">
      <p className="action-help-note">Showing {rangeStart.toLocaleString()}-{rangeEnd.toLocaleString()} of {total.toLocaleString()} Blueprints.</p>
      <div className="database-pagination-controls">
        <label className="compact-select">Rows<select value={String(pageSize)} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>{PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
        <button type="button" disabled={!hasPreviousPage || loading} onClick={() => setPage(1)}>First</button>
        <button type="button" disabled={!hasPreviousPage || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</button>
        <span className="muted database-page-indicator">Page {Math.min(page, pages).toLocaleString()} of {pages.toLocaleString()}</span>
        <button type="button" disabled={!hasNextPage || loading} onClick={() => setPage((current) => Math.min(pages, current + 1))}>Next</button>
        <button type="button" disabled={!hasNextPage || loading} onClick={() => setPage(pages)}>Last</button>
      </div>
    </div>
    <p className="action-help-note">Community Blueprints are installed as Solido Replicator items. The player needs one free backpack slot, must relog after installation, and must have unlocked the included building pieces before placing the design.</p>
  </section>;
}
