import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { formatAbsoluteDateTime } from "../../lib/display";

type Grant = Record<string, unknown>;
type Props = {
  rows: Grant[];
  describeAction: (action: Grant) => string;
  actionError: (action: Grant) => string;
  onRetry: (row: Grant) => void;
};

function actions(row: Grant): Grant[] {
  return Array.isArray(row.results) ? row.results.filter((value): value is Grant => Boolean(value) && typeof value === "object") : [];
}

function GrantOutcome({ row }: { row: Grant }) {
  const results = actions(row);
  const succeeded = results.filter((action) => action.ok === true).length;
  const failed = results.filter((action) => action.ok === false).length;
  if (succeeded || failed) return <span className="grant-history-outcome">
    {succeeded > 0 && <span className="grant-outcome-success">{succeeded} <span>Succeeded</span></span>}
    {failed > 0 && <span className="grant-outcome-failure">{failed} <span>Failed</span></span>}
  </span>;
  const status = String(row.status || "").toLowerCase();
  if (status.replace(/[\s_]/g, "") === "partialfailed") return <span className="grant-history-outcome"><span className="grant-outcome-success">Succeeded</span><span className="grant-outcome-failure">Failed</span></span>;
  return <span className={status === "granted" ? "grant-outcome-success" : status === "failed" ? "grant-outcome-failure" : "muted"}>{status === "granted" ? "Succeeded" : status === "failed" ? "Failed" : "Unknown"}</span>;
}

function playerName(row: Grant) { return String(row.character_name || row.playerName || "Unknown"); }
function packageName(row: Grant) { return String(row.kitName || row.packageName || row.version || "Unknown"); }
function completed(row: Grant) { return formatAbsoluteDateTime(row.finishedAt || row.timestamp || row.startedAt, "Unknown"); }

export function CarePackageGrantHistory({ rows, ...props }: Props) {
  const [selected, setSelected] = useState<Grant | null>(null);
  const closeDetails = useCallback(() => setSelected(null), []);
  return <>
    <div className="table-wrap grant-history-table-wrap"><table className="grant-history-table">
      <thead><tr><th scope="col">Completed</th><th scope="col">Player</th><th scope="col">Package</th><th scope="col">Result</th><th scope="col">Details</th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={String(row.id || index)}>
        <td data-label="Completed">{completed(row)}</td><td data-label="Player">{playerName(row)}</td><td data-label="Package">{packageName(row)}</td>
        <td data-label="Result"><GrantOutcome row={row} /></td>
        <td data-label="Details"><button className="secondary" onClick={() => setSelected(row)}>Details</button></td>
      </tr>)}</tbody>
    </table></div>
    {selected && <GrantDetails row={selected} {...props} onClose={closeDetails} />}
  </>;
}

function GrantDetails({ row, describeAction, actionError, onRetry, onClose }: Omit<Props, "rows"> & { row: Grant; onClose: () => void }) {
  const titleId = useId();
  const modalRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "Tab") {
        const controls = modalRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]');
        if (!controls?.length) return;
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, [onClose]);
  const results = actions(row);
  return createPortal(<div className="modal-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={modalRef} className="confirm-modal grant-history-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="confirm-modal-title"><h3 id={titleId}>Grant History</h3><button ref={closeRef} className="icon-action" aria-label="Close dialog" onClick={onClose}><X size={18} /></button></div>
      <GrantOutcome row={row} />
      <dl className="confirm-modal-details grant-history-metadata">
        <div><dt>Player</dt><dd>{playerName(row)}</dd></div>
        <div><dt>Package</dt><dd>{packageName(row)}</dd></div>
        <div><dt>Completed</dt><dd>{completed(row)}</dd></div>
        {Boolean(row.source) && <div><dt>Source</dt><dd>{String(row.source)}</dd></div>}
        {Boolean(row.id) && <div><dt>ID</dt><dd>{String(row.id)}</dd></div>}
      </dl>
      {[false, true].map((ok) => {
        const group = results.filter((action) => action.ok === ok);
        if (!group.length) return null;
        return <section className={`grant-history-results ${ok ? "grant-results-success" : "grant-results-failure"}`} key={String(ok)}>
          <h4>{ok ? "Succeeded" : "Failed"}</h4>
          <ul>{group.map((action, index) => <li key={index}><strong>{describeAction(action)}</strong>{actionError(action) && <p>{actionError(action)}</p>}</li>)}</ul>
        </section>;
      })}
      {!results.length && Boolean(row.reason) && <p className="grant-outcome-failure">{String(row.reason)}</p>}
      <div className="confirm-modal-actions">
        <button className="secondary" onClick={onClose}>Close</button>
        {String(row.status || "").toLowerCase() === "failed" && <button onClick={() => { onClose(); onRetry(row); }}>Retry</button>}
      </div>
    </section>
  </div>, document.body);
}
