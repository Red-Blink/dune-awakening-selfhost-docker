import { isValidElement, useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import { formatCell, formatDisplayValue, normalizeStatus } from "../../lib/display";

export function KeyValueGrid({ items }: { items: [string, unknown][] }) {
  const visible = items.filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!visible.length) return <div className="empty">No summary values available.</div>;
  return <div className="key-value-grid">{visible.map(([key, value]) => <div className="key-value-item" key={key}>
    <span>{key}</span>
    <strong>{isValidElement(value) ? value : formatCell(value)}</strong>
  </div>)}</div>;
}

export function StatusPill({ value }: { value: unknown }) {
  const text = formatDisplayValue(value || "Unknown");
  const normalized = normalizeStatus(text);
  return <span className={`badge badge-${normalized}`}>{text}</span>;
}

export function TechnicalDetails({ text, title = "Technical details", className = "", open = false }: { text: string; title?: string; className?: string; open?: boolean }) {
  return <details className={`technical-details ${className}`.trim()} open={open}><summary>{title}</summary><pre className="mini-output">{text}</pre></details>;
}

export function OutputPanel({ title, text, action, onAction }: { title: string; text: string; action: string; onAction: () => void }) {
  return <section className="panel"><h2>{title}</h2><button onClick={onAction}>{action}</button><TechnicalDetails text={text} /></section>;
}

export function PlayerStatusCell({ value }: { value: unknown }) {
  const status = String(value || "").toLowerCase();
  const online = status === "online";
  const banned = status === "banned";
  return <span className={`player-status-cell ${banned ? "banned" : online ? "online" : "offline"}`}>{online && <span className="player-status-dot" />}<span>{banned ? "Banned" : online ? "Online" : "Offline"}</span></span>;
}

// A small (i) button next to a toggle that opens a custom popover on hover,
// focus, or click. Originally local to MapsPanel.tsx (Host Memory Protection,
// Memory Balancer, Memory Swap); moved here so other feature panels can reuse
// it without importing across two independently lazy-loaded panel chunks.
export function InfoTooltip({ id, label, children }: { id: string; label: string; children: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  function openTooltip() {
    window.dispatchEvent(new CustomEvent("memory-info-open", { detail: id }));
    setOpen(true);
  }
  useEffect(() => {
    const closeOtherTooltip = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) setOpen(false);
    };
    window.addEventListener("memory-info-open", closeOtherTooltip);
    return () => window.removeEventListener("memory-info-open", closeOtherTooltip);
  }, [id]);
  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const closeOutside = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [open]);
  return <span ref={rootRef} className={`memory-info-tooltip ${open ? "open" : ""}`} onMouseEnter={openTooltip} onMouseLeave={() => setOpen(false)}>
    <button type="button" className="memory-info-button" aria-label={label} aria-expanded={open} aria-describedby={id} onClick={() => open ? setOpen(false) : openTooltip()} onFocus={openTooltip}><Info size={15} aria-hidden="true" /></button>
    <span id={id} role="tooltip" className="memory-info-box">{children}</span>
  </span>;
}
