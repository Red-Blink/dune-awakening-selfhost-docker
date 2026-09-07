import { Circle, CircleCheck, CircleX, LoaderCircle } from "lucide-react";

export type RestoreStepId = "assets" | "verify" | "apply" | "reload";
export type RestoreStepState = "pending" | "active" | "done" | "failed";

export const restoreStepOrder: RestoreStepId[] = ["assets", "verify", "apply", "reload"];

// One label per state: an instruction while waiting, a report once done.
const stepLabels: Record<RestoreStepId, Record<"pending" | "active" | "done", string>> = {
  assets: {
    pending: "Install game files",
    active: "Installing game files",
    done: "Game files installed"
  },
  verify: {
    pending: "Verify the passphrase",
    active: "Verifying the passphrase — preview only",
    done: "Passphrase verified — preview only"
  },
  apply: {
    pending: "Restore database, config and secrets",
    active: "Restoring database, config and secrets",
    done: "Database, config and secrets restored"
  },
  reload: {
    pending: "Restart the console",
    active: "Restarting the console",
    done: "Console restarted"
  }
};

export type RestoreRow = {
  id: RestoreStepId;
  label: string;
  state: RestoreStepState;
  detail: string;
};

export function buildRestoreRows(options: {
  current: RestoreStepId | null;
  finished?: boolean;
  failed?: boolean;
  details?: Partial<Record<RestoreStepId, string>>;
}): RestoreRow[] {
  const { current, finished = false, failed = false, details = {} } = options;
  const activeIndex = current ? restoreStepOrder.indexOf(current) : -1;
  return restoreStepOrder.map((id, index) => {
    const state = rowState(index, activeIndex, finished, failed);
    // A failed step still describes what it was doing, not what it achieved.
    return { id, label: stepLabels[id][state === "failed" ? "active" : state], state, detail: details[id] || "" };
  });
}

function rowState(index: number, activeIndex: number, finished: boolean, failed: boolean): RestoreStepState {
  if (finished) return "done";
  if (activeIndex < 0) return "pending";
  if (index < activeIndex) return "done";
  if (index > activeIndex) return "pending";
  return failed ? "failed" : "active";
}

// Only install-assets can measure this: the images live inside the
// orchestrator and SteamCMD's content log carries no totals.
const ASSET_SIZE_MARKER = /DUNE_GAME_ASSETS_SIZE=([0-9]+(?:\.[0-9]+)?)([KMGT])?/;
const sizeUnits: Record<string, string> = { K: "KB", M: "MB", G: "GB", T: "TB" };

export function installedAssetsSize(lines: string[]): string {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = ASSET_SIZE_MARKER.exec(lines[index] || "");
    if (match) return `${match[1]} ${sizeUnits[match[2] || ""] || "bytes"}`;
  }
  return "";
}

// docker load redraws its progress with carriage returns, which strips to
// nothing, so install-assets counts the tarballs instead.
const ASSET_LOAD_MARKER = /DUNE_GAME_ASSETS_LOAD=([0-9]+)\/([0-9]+)/;

export function imageLoadProgress(lines: string[]): string {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = ASSET_LOAD_MARKER.exec(lines[index] || "");
    if (match) return `Loading images ${match[1]} of ${match[2]}`;
  }
  return "";
}

export function RestoreChecklist({ title, rows, note }: { title: string; rows: RestoreRow[]; note?: string }) {
  return <section className="restore-checklist">
    <h3>{title}</h3>
    <ol>
      {rows.map((row) => <li key={row.id} className={`restore-step restore-step-${row.state}`}>
        <RestoreStepIcon state={row.state} />
        <span className="restore-step-label">{row.label}</span>
        {row.detail && <span className="restore-step-detail">{row.detail}</span>}
      </li>)}
    </ol>
    {/* A caution, not a failure: danger-note's red would read as something
        having gone wrong, when this is the restore working as intended. */}
    {note && <p className="restore-note">{note}</p>}
  </section>;
}

function RestoreStepIcon({ state }: { state: RestoreStepState }) {
  if (state === "done") return <CircleCheck size={16} aria-label="Done" className="restore-step-icon" />;
  if (state === "failed") return <CircleX size={16} aria-label="Failed" className="restore-step-icon" />;
  if (state === "active") return <LoaderCircle size={16} aria-label="In progress" className="restore-step-icon restore-step-spin" />;
  return <Circle size={16} aria-label="Waiting" className="restore-step-icon" />;
}
