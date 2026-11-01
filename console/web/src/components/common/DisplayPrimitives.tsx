import { isValidElement, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
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

// A small (i) button that opens a custom popover on hover,
// focus, or click. Originally local to MapsPanel.tsx (Host Memory Protection,
// Memory Balancer, Memory Swap); moved here so other feature panels can reuse
// it without importing across two independently lazy-loaded panel chunks.
// `interactive` is for content long enough to need scrolling: the box takes the
// pointer and keyboard focus, a short close delay lets the pointer cross the gap
// from the button, and it opens beside the button so a stack of (i) buttons
// stays reachable. Tab from the button enters the box; Tab or Escape leaves it.
export function InfoTooltip({ id, label, children, portal = false, interactive = false }: { id: string; label: string; children: ReactNode; portal?: boolean; interactive?: boolean }) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const returningFocus = useRef(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const boxRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Fixed from the start: a closed box left absolute on body still counts as
  // scrollable overflow, so it added page scroll until first opened.
  const [position, setPosition] = useState<CSSProperties>({ position: "fixed" });
  useLayoutEffect(() => {
    if (!portal || !open) return;
    const placeTooltip = () => {
      const anchor = rootRef.current?.getBoundingClientRect();
      const box = boxRef.current?.getBoundingClientRect();
      if (!anchor || !box) return;
      const margin = 14;
      if (interactive) {
        const gap = 8;
        const roomRight = window.innerWidth - anchor.right - gap - margin;
        const roomLeft = anchor.left - gap - margin;
        const width = Math.min(310, Math.max(roomRight, roomLeft));
        // scrollHeight, not the rect: maxHeight below would otherwise feed back.
        const height = (boxRef.current?.scrollHeight ?? box.height) + 2;
        const top = Math.max(margin, Math.min(anchor.top, window.innerHeight - height - margin));
        setPosition({ position: "fixed", width, maxHeight: window.innerHeight - top - margin, top,
          left: roomRight >= width ? anchor.right + gap : anchor.left - gap - width,
          right: "auto", bottom: "auto" });
        return;
      }
      const width = Math.min(310, window.innerWidth - margin * 2);
      const height = Math.min(box.height, window.innerHeight - margin * 2);
      const below = anchor.bottom + 8;
      setPosition({ position: "fixed", width, maxHeight: window.innerHeight - margin * 2,
        left: Math.max(margin, Math.min(anchor.left, window.innerWidth - width - margin)),
        top: Math.max(margin, below + height <= window.innerHeight - margin ? below : anchor.top - height - 8),
        right: "auto", bottom: "auto" });
    };
    placeTooltip();
    window.addEventListener("resize", placeTooltip);
    window.addEventListener("scroll", placeTooltip, true);
    return () => {
      window.removeEventListener("resize", placeTooltip);
      window.removeEventListener("scroll", placeTooltip, true);
    };
  }, [portal, open, children, interactive]);
  function openTooltip() {
    clearTimeout(closeTimer.current);
    window.dispatchEvent(new CustomEvent("memory-info-open", { detail: id }));
    setOpen(true);
  }
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  function closeOnLeave() {
    if (!interactive) setOpen(false);
    else if (!boxRef.current?.contains(document.activeElement)) closeTimer.current = setTimeout(() => setOpen(false), 150);
  }
  function closeOnBlur(next: Node | null) {
    if (interactive && next && !rootRef.current?.contains(next) && !boxRef.current?.contains(next)) setOpen(false);
  }
  function leaveBox(event: ReactKeyboardEvent) {
    if (event.key !== "Tab" && event.key !== "Escape") return;
    // Tab keeps its default, so it carries on from the button to the next control.
    if (event.key === "Escape") event.preventDefault();
    returningFocus.current = true;
    buttonRef.current?.focus();
    returningFocus.current = false;
    setOpen(false);
  }
  function enterBox(event: ReactKeyboardEvent) {
    if (!interactive || !open || event.key !== "Tab" || event.shiftKey) return;
    event.preventDefault();
    boxRef.current?.focus();
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
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !boxRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [open]);
  const boxRole = interactive ? { role: "dialog", "aria-label": label, tabIndex: -1, onKeyDown: leaveBox } : { role: "tooltip" };
  const buttonRole = interactive ? { "aria-haspopup": "dialog" as const, "aria-controls": id } : { "aria-describedby": id };
  const box = <span ref={boxRef} id={id} {...boxRole} className={`memory-info-box ${portal && open ? "open" : ""} ${interactive ? "interactive" : ""}`} style={portal ? position : undefined}>{children}</span>;
  return <span ref={rootRef} className={`memory-info-tooltip ${open ? "open" : ""}`} onPointerEnter={event => { if (event.pointerType !== "touch") openTooltip(); }} onPointerLeave={event => { if (event.pointerType !== "touch") closeOnLeave(); }} onBlur={event => closeOnBlur(event.relatedTarget as Node | null)}>
    <button ref={buttonRef} type="button" className="memory-info-button" aria-label={label} aria-expanded={open} {...buttonRole} onClick={openTooltip} onFocus={() => { if (!returningFocus.current) openTooltip(); }} onKeyDown={enterBox}><Info size={15} aria-hidden="true" /></button>
    {portal ? createPortal(box, document.body) : box}
  </span>;
}
