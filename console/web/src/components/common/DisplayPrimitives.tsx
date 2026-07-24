import { isValidElement } from "react";
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

export function TechnicalDetails({ text, title = "Technical details", className = "" }: { text: string; title?: string; className?: string }) {
  return <details className={`technical-details ${className}`.trim()}><summary>{title}</summary><pre className="mini-output">{text}</pre></details>;
}

export function OutputPanel({ title, text, action, onAction }: { title: string; text: string; action: string; onAction: () => void }) {
  return <section className="panel"><h2>{title}</h2><button onClick={onAction}>{action}</button><TechnicalDetails text={text} /></section>;
}

export function PlayerStatusCell({ value }: { value: unknown }) {
  const online = String(value || "").toLowerCase() === "online";
  return <span className={`player-status-cell ${online ? "online" : "offline"}`}>{online && <span className="player-status-dot" />}<span>{online ? "Online" : "Offline"}</span></span>;
}
