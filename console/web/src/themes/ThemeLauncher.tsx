import { lazy, useState } from "react";
import { Palette } from "lucide-react";
import { LazyTabBoundary } from "../components/common/LazyTabBoundary";

const ThemePanel = lazy(() => import("./ThemePanel").then((module) => ({ default: module.ThemePanel })));

/** The header button and its lazy dialog. State lives here so the picker is testable without the whole App. */
export function ThemeLauncher({ onOpen }: { onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <button
      className="community-button language-shortcut"
      type="button"
      title="Console Theme"
      aria-label="Console Theme"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => {
        setOpen(true);
        onOpen?.();
      }}
    ><Palette size={19} aria-hidden="true" /></button>
    {open && <div className="theme-launcher-status">
      {/* The dialog portals itself out; this wrapper only hosts the loading and failure states, with a way to close them. */}
      <LazyTabBoundary label="Loading Themes" onDismiss={() => setOpen(false)}><ThemePanel onClose={() => setOpen(false)} /></LazyTabBoundary>
    </div>}
  </>;
}
