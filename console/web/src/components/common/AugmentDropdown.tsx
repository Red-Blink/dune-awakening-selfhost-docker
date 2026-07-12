import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, X } from "lucide-react";

export type AugmentEffect = { label: string; value: string; tone: "positive" | "negative" | "neutral"; text: string };
export type AugmentOption = { id: string; name: string; displayName?: string; effects?: AugmentEffect[] };

export function AugmentDropdown({
  options,
  value,
  onChange,
  maxSelected,
  placeholder = "Select augments"
}: {
  options: AugmentOption[];
  value: string[];
  onChange: (next: string[]) => void;
  maxSelected?: number;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement | null>(null);
  const optionIds = useMemo(() => new Set(options.map((option) => option.id)), [options]);
  const effectiveValue = useMemo(() => value.filter((id) => optionIds.has(id)), [optionIds, value]);
  const selectedNames = useMemo(() => effectiveValue.map((id) => {
    const option = options.find((entry) => entry.id === id);
    return option?.displayName || option?.name || id;
  }), [effectiveValue, options]);
  const summary = selectedNames.length ? selectedNames.join(", ") : placeholder;
  const limit = Number(maxSelected) > 0 ? Number(maxSelected) : options.length;
  const atLimit = effectiveValue.length >= limit;

  useEffect(() => {
    if (effectiveValue.length === value.length) return;
    onChange(effectiveValue);
  }, [effectiveValue, onChange, value.length]);

  const updateMenuPosition = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const control = root.querySelector<HTMLElement>(".augment-dropdown-control");
    const main = root.closest("main");
    const controlRect = (control || root).getBoundingClientRect();
    const mainRect = main?.getBoundingClientRect() || { top: 0, right: window.innerWidth, bottom: window.innerHeight, left: 0, width: window.innerWidth, height: window.innerHeight };
    const gap = 4;
    const inset = 8;
    const preferredHeight = 320;
    const minUsableHeight = 160;
    const availableBelow = Math.max(0, mainRect.bottom - controlRect.bottom - gap - inset);
    const availableAbove = Math.max(0, controlRect.top - mainRect.top - gap - inset);
    const openBelow = availableBelow >= Math.min(minUsableHeight, preferredHeight) || availableBelow >= availableAbove;
    const availableHeight = openBelow ? availableBelow : availableAbove;
    const maxHeight = Math.max(120, Math.min(preferredHeight, availableHeight || preferredHeight));
    const minLeft = mainRect.left + inset;
    const maxLeft = mainRect.right - inset;
    const width = Math.min(440, Math.max(controlRect.width, Math.min(window.innerWidth - inset * 2, mainRect.width - inset * 2)));
    const left = Math.min(Math.max(controlRect.left, minLeft), Math.max(minLeft, maxLeft - width));
    const rawTop = openBelow ? controlRect.bottom + gap : controlRect.top - gap - maxHeight;
    const top = Math.min(Math.max(rawTop, mainRect.top + inset), Math.max(mainRect.top + inset, mainRect.bottom - inset - maxHeight));
    setMenuStyle({ left, top, width, maxHeight });
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    updateMenuPosition();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onReposition = () => updateMenuPosition();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    window.visualViewport?.addEventListener("resize", onReposition);
    window.visualViewport?.addEventListener("scroll", onReposition);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
      window.visualViewport?.removeEventListener("resize", onReposition);
      window.visualViewport?.removeEventListener("scroll", onReposition);
    };
  }, [open, updateMenuPosition]);

  function toggle(id: string) {
    if (effectiveValue.includes(id)) {
      onChange(effectiveValue.filter((item) => item !== id));
      return;
    }
    if (atLimit) return;
    onChange([...effectiveValue, id].slice(0, limit));
  }

  return (
    <div className="augment-dropdown" ref={rootRef}>
      <button className={`augment-dropdown-control ${open ? "open" : ""}`} type="button" onClick={() => setOpen((current) => !current)} title={summary}>
        <span className={selectedNames.length ? "augment-dropdown-value" : "augment-dropdown-placeholder"}>{summary}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="augment-dropdown-menu" style={menuStyle}>
          <div className="augment-dropdown-header">
            <span>{effectiveValue.length}/{limit} selected</span>
            {effectiveValue.length > 0 && <button type="button" onClick={() => onChange([])} aria-label="Clear augments"><X size={14} /></button>}
          </div>
          <div className="augment-dropdown-options">
            {options.map((option) => {
              const checked = effectiveValue.includes(option.id);
              const disabled = !checked && atLimit;
              return (
                <label className={`augment-dropdown-option ${disabled ? "disabled" : ""}`} key={option.id}>
                  <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggle(option.id)} />
                  <span className="augment-dropdown-option-content">
                    <span className="augment-dropdown-option-name">{option.name}</span>
                    {option.effects?.length ? (
                      <span className="augment-dropdown-effects">
                        {option.effects.map((effect) => <span className={`augment-dropdown-effect ${effect.tone}`} key={`${option.id}-${effect.text}`}>{effect.text}</span>)}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
