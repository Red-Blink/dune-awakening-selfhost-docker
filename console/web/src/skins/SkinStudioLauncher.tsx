import { lazy, useState } from "react";
import { Columns, Wand2 } from "lucide-react";
import { LazyTabBoundary } from "../components/common/LazyTabBoundary";
import { useSkinConfig } from "./useSkinConfig";

const SkinStudioModal = lazy(() =>
  import("./SkinStudioModal").then((module) => ({ default: module.SkinStudioModal }))
);

export function SkinStudioLauncher({ onOpen }: { onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const [, editMode, setEditMode] = useSkinConfig();

  return (
    <>
      <button
        className="community-button language-shortcut skin-studio-shortcut"
        type="button"
        title="Skin & Layout Studio"
        aria-label="Skin & Layout Studio"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen(true);
          onOpen?.();
        }}
      >
        <Wand2 size={19} aria-hidden="true" />
      </button>
      {editMode && (
        <button
          className="community-button skin-exit-edit-pill"
          type="button"
          title="Exit Interactive Layout Mode"
          onClick={() => setEditMode(false)}
        >
          <Columns size={16} aria-hidden="true" />
          <span>Done Editing Layout</span>
        </button>
      )}
      {open && (
        <div className="theme-launcher-status">
          <LazyTabBoundary label="Loading Skin Studio" onDismiss={() => setOpen(false)}>
            <SkinStudioModal onClose={() => setOpen(false)} />
          </LazyTabBoundary>
        </div>
      )}
    </>
  );
}
