import { useEffect, useState } from "react";
import { Power } from "lucide-react";
import { api, post } from "../../api/client";
import { setupApi, type Task } from "../../api/setup";
import { InfoTooltip } from "../../components/common/DisplayPrimitives";

type TankStatus = { enabled: boolean; supported: boolean; build: string; applying: boolean; error: string; queuedEntryId?: string | null; queuedEnabled?: boolean | null };
type Confirm = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }) => Promise<boolean>;

export function ExperimentalFeatures({ confirmAction }: { confirmAction: Confirm }) {
  const [status, setStatus] = useState<TankStatus | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [requestedEnabled, setRequestedEnabled] = useState<boolean | null>(null);
  const [queuedEntry, setQueuedEntry] = useState<string | null>(null);
  const busy = submitting || Boolean(queuedEntry) || status?.applying || task?.status === "queued" || task?.status === "running";
  const displayedEnabled = busy ? requestedEnabled ?? status?.queuedEnabled ?? status?.enabled : status?.enabled;
  useEffect(() => { if (!busy) setRequestedEnabled(null); }, [busy]);
  const errorMessage = error || status?.error || ((task?.status === "failed" || task?.status === "cancelled") ? task.errorMessage || "Tank settings could not be applied." : "");
  const refresh = () => api<TankStatus>("/api/settings/experimental-tanks").then((next) => {
    setStatus(next);
    setQueuedEntry(next.queuedEntryId || null);
  }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (task) return;
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    return () => window.clearInterval(timer);
  }, [status?.applying, task?.id]);
  useEffect(() => {
    if (!task || !busy) return;
    const timer = window.setInterval(() => {
      void setupApi.task(task.id).then(({ task: next }) => {
        setTask(next);
        if (next.status !== "running" && next.status !== "queued") void refresh();
      }).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    }, 2000);
    return () => window.clearInterval(timer);
  }, [task?.id, busy]);
  async function change(enabled: boolean) {
    if (!(await confirmAction(`${enabled ? "Enable" : "Disable"} Regis Tanks? Every running Hagga Sietch will restart and disconnect its players. Other maps will not restart.${enabled ? "" : " All Tanks in Hagga Basin will be deleted."}`, {
      title: `${enabled ? "Enable" : "Disable"} Regis Tanks`, confirmLabel: "Apply And Restart Hagga", danger: true
    }))) return;
    setError("");
    setTask(null);
    setRequestedEnabled(enabled);
    setSubmitting(true);
    try {
      const result = await post<{ task?: Task; queued?: boolean; entryId?: string }>("/api/settings/experimental-tanks", { enabled, confirmRestart: true });
      if (result.queued && result.entryId) setQueuedEntry(result.entryId);
      else if (result.task) setTask(result.task);
      else throw new Error("Tank settings could not be started. Refresh and try again.");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSubmitting(false); }
  }
  return <section className="experimental-features-section" aria-labelledby="experimental-features-title">
    <h3 id="experimental-features-title">Experimental Features</h3>
    <div className="experimental-features-grid">
    <article className={`experimental-feature-card ${!status ? "loading" : displayedEnabled ? "enabled" : "disabled"}`} aria-labelledby="regis-tanks-title" aria-busy={busy}>
      <img className="experimental-feature-image" src="/images/features/regis-tank.jpg" alt="Regis Tanks in the desert" width={1672} height={941} />
      <div className="experimental-feature-content">
        <div className="experimental-feature-heading"><h4 id="regis-tanks-title">Regis Tanks</h4><InfoTooltip id="experimental-tanks-help" label="About Regis Tanks">Unofficial, build-specific patch. Disable before updating the game server. Disabling restores the original image. All Tanks in Hagga Basin will be deleted.</InfoTooltip></div>
        <div className="experimental-feature-status" role="status">{queuedEntry ? "Restart Queued" : busy ? <span className="loading-dots">Applying Changes</span> : !status ? "Loading…" : status.enabled ? "Enabled" : "Disabled"}</div>
        {queuedEntry && <p className="attention-text">Hagga will restart after the countdown. See Restart Queue in Admin Tools.</p>}
        <button type="button" className="experimental-feature-button" disabled={!status || busy || (!status.supported && !status.enabled)} onClick={() => { void change(!status?.enabled); }}><Power size={16} aria-hidden="true" />{busy ? displayedEnabled ? "Enabling..." : "Disabling..." : status?.enabled ? "Disable Regis Tanks" : "Enable Regis Tanks"}</button>
        {status && !status.supported && <p className="attention-text">This game build is not supported. Tanks cannot be enabled until a compatible patch is available.</p>}
      {errorMessage && <p role="alert" className="attention-text">{errorMessage}</p>}
      {task && <details className="technical-details"><summary>Operation Log</summary><pre>{task.logLines.map((line) => line.line).join("\n")}</pre></details>}
      </div>
    </article>
    </div>
  </section>;
}
