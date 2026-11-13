import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Palette, X } from "lucide-react";
import { DEFAULT_THEME_ID, THEME_STORAGE_KEY, getThemes, loadSelectedTheme, saveSelectedTheme } from "./themeEngine";

// One line per palette: its name and four colour boxes. Swatch palettes show their source dyes; the others show page, panel, accent and secondary.
const SWATCH_TOKENS = ["--bg", "--panel", "--accent", "--accent-strong"] as const;
const DEFAULT_SWATCHES = ["#0d0f12", "#171a1d", "#c68b4a", "#d8a05c"];
const GROUP_ORDER = ["Console palettes", "Dune factions", "Houses", "Outfits and dyes"];

export function ThemePanel({ onClose = () => {} }: { onClose?: () => void }) {
  const [selected, setSelected] = useState(loadSelectedTheme);
  const [filter, setFilter] = useState("");
  const modal = useRef<HTMLDivElement>(null);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    modal.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeRef.current();
    };
    // Another tab changed the theme: keep the checked card truthful.
    const onStorage = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) setSelected(loadSelectedTheme());
    };
    document.addEventListener("keydown", onEscape, true);
    window.addEventListener("storage", onStorage);
    return () => {
      document.removeEventListener("keydown", onEscape, true);
      window.removeEventListener("storage", onStorage);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  function choose(id: string) {
    saveSelectedTheme(id);
    setSelected(id);
  }
  const all = [
    { id: DEFAULT_THEME_ID, name: "Default", description: "The standard console look.", group: GROUP_ORDER[0], swatches: DEFAULT_SWATCHES as readonly string[] },
    ...getThemes().map((theme) => ({ id: theme.id, name: theme.name, description: theme.description, group: theme.group ?? GROUP_ORDER[0], swatches: theme.dyes ?? (SWATCH_TOKENS.map((token) => theme.tokens[token]) as readonly string[]) })),
  ];
  const query = filter.trim().toLowerCase();
  // The applied choice stays listed while filtering, so the radio group always has a checked card.
  const options = all.filter((option) => !query || option.name.toLowerCase().includes(query) || option.id === selected);
  const groups = GROUP_ORDER.map((group) => ({ group, items: options.filter((option) => option.group === group) })).filter((entry) => entry.items.length > 0);
  const matches = query ? options.filter((option) => option.name.toLowerCase().includes(query)).length : all.length;
  return createPortal(
    <div className="modal-overlay theme-picker-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) closeRef.current(); }}>
      <div
        ref={modal}
        className="confirm-modal theme-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="theme-picker-title"
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")].filter((control) => control.tabIndex >= 0)
              // A selector list is not guaranteed to come back in document order in every DOM implementation.
              .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
            const first = controls[0];
            const last = controls.at(-1);
            const active = document.activeElement as HTMLElement | null;
            // Focus can sit on a non-tabbable radio after arrow navigation; Tab must still stay in the dialog.
            if (event.shiftKey && (active === first || !controls.includes(active as HTMLElement))) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && (active === last || !controls.includes(active as HTMLElement))) { event.preventDefault(); first?.focus(); }
          }
        }}
      >
        <header className="theme-picker-heading">
          <div><Palette size={22} aria-hidden="true" /><h2 id="theme-picker-title">Console Theme</h2></div>
          <button type="button" aria-label="Close" onClick={() => closeRef.current()}><X size={18} aria-hidden="true" /></button>
        </header>
        <p className="theme-picker-note">Applies to this browser only. Choose Default to restore the standard look.</p>
        <input
          className="theme-filter"
          type="search"
          value={filter}
          placeholder="Filter palettes"
          aria-label="Filter palettes"
          onChange={(event) => setFilter(event.target.value)}
        />
        <p className="theme-filter-count" role="status" aria-live="polite">{matches === 0 ? "No palettes match." : `${matches} palettes`}</p>
        <div role="radiogroup" aria-label="Console theme">
          {groups.map(({ group, items }) => (
            <section key={group} role="group" className="theme-group" aria-labelledby={`theme-group-${group.replace(/\W+/g, "-")}`}>
              <h3 id={`theme-group-${group.replace(/\W+/g, "-")}`}>{group}</h3>
              <div className="theme-grid">
                {items.map((option) => {
                  const index = options.indexOf(option);
                  return (
                    <button
                      key={option.id}
                      ref={(el) => { radios.current[index] = el; }}
                      type="button"
                      role="radio"
                      aria-checked={selected === option.id}
                      tabIndex={selected === option.id ? 0 : -1}
                      onKeyDown={(event) => {
                        // Arrows only move focus; Space/Enter chooses, so browsing does not repaint the whole console.
                        const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
                        const target = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : event.key in keys ? (index + keys[event.key] + options.length) % options.length : -1;
                        if (target < 0) return;
                        event.preventDefault();
                        radios.current[target]?.focus();
                      }}
                      className={`theme-card${selected === option.id ? " selected" : ""}`}
                      title={option.description}
                      aria-describedby={`theme-desc-${option.id}`}
                      onClick={() => choose(option.id)}
                    >
                      <span className="theme-card-name">{option.name}{selected === option.id && <Check size={15} aria-hidden="true" />}</span>
                      <span className="theme-swatches" aria-hidden="true">
                        {option.swatches.map((color, swatchIndex) => <i key={swatchIndex} style={{ background: color }} />)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
        <div hidden>{all.map((option) => <span key={option.id} id={`theme-desc-${option.id}`}>{option.description}</span>)}</div>
      </div>
    </div>,
    document.body,
  );
}
