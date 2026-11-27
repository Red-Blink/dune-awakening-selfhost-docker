import { PermissionGate } from "../../lib/consoleAccess";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowUp, DatabaseBackup, RefreshCw } from "lucide-react";
import { basesApi, type BaseLandClaim } from "../../api/bases";

type Props = {
  baseId: string;
  baseName: string;
  confirmAction: (message: string, options?: {
    title?: string;
    confirmLabel?: string;
    warning?: string;
    danger?: boolean;
    details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[];
  }) => Promise<boolean>;
  onError: (message: string) => void;
};

type Coordinate = { x: number; y: number };

const keyOf = (x: number, y: number) => `${x},${y}`;
const parseKey = (key: string): Coordinate => {
  const [x, y] = key.split(",").map(Number);
  return { x, y };
};
const neighbors = ({ x, y }: Coordinate): Coordinate[] => [
  { x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 }
];

function reachableKeys(cells: Set<string>) {
  const reached = new Set<string>(["0,0"]);
  const queue: Coordinate[] = [{ x: 0, y: 0 }];
  while (queue.length) {
    const cell = queue.shift()!;
    for (const neighbor of neighbors(cell)) {
      const key = keyOf(neighbor.x, neighbor.y);
      if (cells.has(key) && !reached.has(key)) {
        reached.add(key);
        queue.push(neighbor);
      }
    }
  }
  return reached;
}

function formatYaw(value: number) {
  return `${Math.round(value * 10) / 10}°`;
}

function rotateToWorld({ x, y }: Coordinate, yaw: number): Coordinate {
  const radians = yaw * Math.PI / 180;
  return {
    x: x * Math.cos(radians) - y * Math.sin(radians),
    y: x * Math.sin(radians) + y * Math.cos(radians)
  };
}

export function BaseLandClaimTab({ baseId, baseName, confirmAction, onError }: Props) {
  const [claim, setClaim] = useState<BaseLandClaim | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [verticalLevel, setVerticalLevel] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [statusKind, setStatusKind] = useState<"" | "ok" | "fail">("");

  const load = useCallback(async () => {
    setLoading(true);
    setStatus("");
    setStatusKind("");
    try {
      const result = await basesApi.landClaim(baseId);
      setClaim(result);
      setVerticalLevel(result.verticalLevel);
      setSelected(new Set());
    } catch (error) {
      // An initial failure has no claim to render, while a failed manual reload
      // keeps the last good snapshot in place instead of collapsing the entire
      // editor (and jumping the page/footer) into the error-only state.
      setStatus(error instanceof Error ? error.message : String(error));
      setStatusKind("fail");
    } finally {
      setLoading(false);
    }
  }, [baseId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!status || statusKind !== "ok") return undefined;
    // Match the shared result-ok animation. Removing the state after the fade
    // also releases the banner's layout space if animation events are skipped.
    const retire = window.setTimeout(() => {
      setStatus("");
      setStatusKind("");
    }, 10_400);
    return () => window.clearTimeout(retire);
  }, [status, statusKind]);

  const existing = useMemo(() => new Set([
    "0,0",
    ...(claim?.segments || []).map((segment) => keyOf(segment.x, segment.y))
  ]), [claim]);
  const occupied = useMemo(() => new Set([...existing, ...selected]), [existing, selected]);
  const frontier = useMemo(() => {
    const result = new Set<string>();
    for (const key of occupied) {
      for (const neighbor of neighbors(parseKey(key))) {
        const neighborKey = keyOf(neighbor.x, neighbor.y);
        if (!occupied.has(neighborKey) && Math.abs(neighbor.x) <= 128 && Math.abs(neighbor.y) <= 128) result.add(neighborKey);
      }
    }
    return result;
  }, [occupied]);
  const plotted = useMemo(() => [...new Set([...occupied, ...frontier])].map(parseKey), [occupied, frontier]);
  const bounds = useMemo(() => {
    const worldCells = plotted.map((cell) => rotateToWorld(cell, claim?.yaw || 0));
    const xs = worldCells.map((cell) => cell.x);
    const ys = worldCells.map((cell) => cell.y);
    const minX = Math.min(...xs) - 0.7;
    const maxX = Math.max(...xs) + 0.7;
    const minY = Math.min(...ys) - 0.7;
    const maxY = Math.max(...ys) + 0.7;
    return { minX, minY, width: Math.max(2, maxX - minX), height: Math.max(2, maxY - minY) };
  }, [claim?.yaw, plotted]);

  function toggleCell(key: string) {
    if (!claim || saving || loading) return;
    setStatus("");
    setStatusKind("");
    setSelected((current) => {
      if (!current.has(key)) return new Set([...current, key]);
      const remaining = new Set(current);
      remaining.delete(key);
      const allCells = new Set([...existing, ...remaining]);
      const reached = reachableKeys(allCells);
      return new Set([...remaining].filter((entry) => reached.has(entry)));
    });
  }

  const dirty = selected.size > 0 || (claim && verticalLevel !== claim.verticalLevel);
  const canSave = Boolean(claim && !claim.duplicateCoordinates && dirty && !saving && !loading);

  async function save() {
    if (!claim || !canSave) return;
    const additions = [...selected].map(parseKey).sort((a, b) => a.y - b.y || a.x - b.x);
    const confirmed = await confirmAction(
      `Apply these land claim changes to ${baseName}?`,
      {
        title: "Edit Land Claim",
        confirmLabel: "Apply Changes",
        warning: `The Console will create a database backup first. Restart ${claim.map || "the affected game server"} after saving so the game loads these changes.`,
        details: [
          { label: "Horizontal Segments", value: additions.length ? `Add ${additions.length}` : "No Change", tone: additions.length ? "accent" : undefined },
          { label: "Vertical Level", value: verticalLevel === claim.verticalLevel ? `Keep ${verticalLevel}` : `${claim.verticalLevel} → ${verticalLevel}`, tone: verticalLevel !== claim.verticalLevel ? "accent" : undefined },
          { label: "Totem ID", value: claim.totemId }
        ]
      }
    );
    if (!confirmed) return;
    setSaving(true);
    setStatus("");
    setStatusKind("");
    try {
      const response = await basesApi.updateLandClaim(baseId, additions, verticalLevel);
      if (!response.result) throw new Error(response.reason || response.error || "The land claim update did not return a result.");
      setClaim(response.result);
      setVerticalLevel(response.result.verticalLevel);
      setSelected(new Set());
      setStatus(`Saved. Added ${response.result.added} horizontal segment${response.result.added === 1 ? "" : "s"}${response.result.verticalChanged ? ` and set vertical expansion to ${response.result.verticalLevel}` : ""}. A safety backup was created. Restart ${response.result.map || "the affected game server"} to load the changes.`);
      setStatusKind("ok");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      setStatusKind("fail");
      onError(message);
    } finally {
      setSaving(false);
    }
  }

  if (loading && !claim) return <div className="bases-tab-body land-claim-editor"><p className="muted loading-dots">Loading land claim</p></div>;
  if (!claim) return <div className="bases-tab-body land-claim-editor"><p role="alert" className="error-text">{status || "Land Claim Editor is unavailable."}</p><button className="secondary-action" onClick={() => void load()}><RefreshCw size={15} />Retry</button></div>;

  const maxVertical = Math.max(claim.verticalLevel, claim.maxVerticalLevel);
  return (
    <div className="bases-tab-body land-claim-editor" aria-busy={loading}>
      <div className="land-claim-summary">
        <div><span>Totem ID</span><strong>{claim.totemId}</strong></div>
        <div><span>Original Yaw</span><strong>{formatYaw(claim.yaw)}</strong></div>
        <div><span>Horizontal Segments</span><strong>{claim.segmentCount}</strong></div>
        <div><span>Vertical Level</span><strong>{claim.verticalLevel} / {claim.maxVerticalLevel}</strong></div>
      </div>

      {claim.duplicateCoordinates > 0 && <p className="land-claim-warning" role="alert"><AlertTriangle size={17} />This claim contains {claim.duplicateCoordinates} duplicated coordinate{claim.duplicateCoordinates === 1 ? "" : "s"}. Repair the duplicate rows before editing.</p>}

      <div className="land-claim-workspace">
        <section className="land-claim-grid-card" aria-label="Horizontal land claim grid">
          <div className="land-claim-section-heading"><div><h3>Horizontal Claim</h3><p>Click a dotted cell to add it. New cells must remain connected edge-to-edge.</p></div><button className="secondary-action" onClick={() => void load()} disabled={saving || loading} aria-label={loading ? "Reloading land claim" : "Reload"}><RefreshCw size={15} className={loading ? "land-claim-reload-icon" : undefined} />Reload</button></div>
          <div className="land-claim-grid-wrap">
            <div className="land-claim-north-indicator" role="img" aria-label="World North, fixed at the top">
              <span className="land-claim-north-arrow" aria-hidden="true"><ArrowUp size={22} strokeWidth={2.5} /></span>
              <span>North</span>
            </div>
            <svg className="land-claim-grid" viewBox={`${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`} role="img" aria-label={`Land claim grid with ${claim.segmentCount} existing and ${selected.size} selected segments`}>
              <g className="land-claim-world-grid" transform={`rotate(${claim.yaw} 0 0)`} data-testid="land-claim-world-grid">
                {plotted.map(({ x, y }) => {
                  const key = keyOf(x, y);
                  const origin = key === "0,0";
                  const isSelected = selected.has(key);
                  const isExisting = existing.has(key) && !origin;
                  const available = frontier.has(key);
                  return <g key={key}>
                    <rect
                      x={x - 0.44}
                      y={y - 0.44}
                      width="0.88"
                      height="0.88"
                      rx="0.08"
                      className={`land-claim-cell${origin ? " origin" : isSelected ? " selected" : isExisting ? " existing" : " available"}`}
                      role={available || isSelected ? "button" : undefined}
                      tabIndex={available || isSelected ? 0 : undefined}
                      aria-label={origin ? "Sub-Fief origin" : isSelected ? `Remove selected segment ${x}, ${y}` : isExisting ? `Existing segment ${x}, ${y}` : `Add segment ${x}, ${y}`}
                      onClick={() => (available || isSelected) && toggleCell(key)}
                      onKeyDown={(event) => { if ((available || isSelected) && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); toggleCell(key); } }}
                    />
                    {(origin || isSelected) && <text x={x} y={y + 0.09} transform={`rotate(${-claim.yaw} ${x} ${y})`} className="land-claim-cell-label" aria-hidden="true">{origin ? "T" : "+"}</text>}
                  </g>;
                })}
              </g>
            </svg>
          </div>
          <div className="land-claim-legend"><span><i className="origin" />Sub-Fief</span><span><i className="existing" />Existing</span><span><i className="selected" />New</span><span><i className="available" />Available</span></div>
          <p className="land-claim-axis-note">World-oriented view: North stays at the top. The claim grid is rotated using the Sub-Fief&apos;s original yaw, while saved coordinates remain unchanged.</p>
        </section>

        <aside className="land-claim-controls">
          <h3>Expansion</h3>
          <label><span>Vertical Level</span><select value={verticalLevel} disabled={saving || loading} onChange={(event) => setVerticalLevel(Number(event.target.value))}>
            {Array.from({ length: maxVertical - claim.verticalLevel + 1 }, (_, index) => claim.verticalLevel + index).map((level) => <option key={level} value={level}>{level}</option>)}
          </select></label>
          <p className="muted">Vertical expansion grows equally upward and downward. The game hard-caps it at level 5.</p>
          <dl><dt>Pending Horizontal</dt><dd>{selected.size}</dd><dt>Pending Vertical</dt><dd>{verticalLevel === claim.verticalLevel ? "No Change" : `${claim.verticalLevel} → ${verticalLevel}`}</dd></dl>
          <PermissionGate action="bases:mutate"><button className="primary-action" disabled={!canSave} onClick={() => void save()}>{saving ? "Applying…" : "Apply Changes"}</button></PermissionGate>
          {selected.size > 0 && <button className="secondary-action" disabled={saving || loading} onClick={() => setSelected(new Set())}>Clear Selection</button>}
          <p className="land-claim-backup-note"><DatabaseBackup size={16} />A full database backup is created before every save.</p>
          <p className="land-claim-restart-note"><RefreshCw size={16} />Restart {claim.map || "the affected game server"} after saving to load the changes.</p>
        </aside>
      </div>

      <p className="land-claim-disclaimer" role="note"><AlertTriangle size={16} />This advanced editor bypasses normal in-game staking validation. Claiming a protected area does not guarantee that the game will permit building there, particularly around enemy camps and other restricted locations.</p>
      {status && <p
        className={`inline-task-result${statusKind ? ` result-${statusKind}` : ""}`}
        role={statusKind === "fail" ? "alert" : "status"}
        onAnimationEnd={() => {
          if (statusKind !== "ok") return;
          setStatus("");
          setStatusKind("");
        }}
      ><strong>{status}</strong></p>}
    </div>
  );
}
