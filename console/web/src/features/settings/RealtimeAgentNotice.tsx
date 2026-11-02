import { useEffect, useRef, useState } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { realtimeAgentApi, type RealtimeAgentStatus } from "../../api/realtimeAgent";
import { InlineActionResult, type InlineActionResultState } from "../../components/common/InlineActionResult";

type ConfirmAction = (
  message: string,
  options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
) => Promise<boolean>;

const POLL_MS = 3000;
// A first build can take 15 minutes (the server stops waiting then), so stop asking after 20.
const MAX_POLLS = 400;

const INSTALL_MESSAGE = [
  "This builds the Realtime Data position agent from source and starts it as a container on this host.",
  "",
  "What it is meant to do: read live object positions from the game server processes and offer them on 127.0.0.1:8796 for the Console to pass on.",
  "",
  "What it is allowed to do: it runs as root with the host's process list, ptrace and file-permission override, and without AppArmor confinement. Those privileges are broader than its job, and the container does not enforce that it only reads game processes or only reads. It has no login, so any other process on this host can also reach 127.0.0.1:8796; only install it on a host where you trust the local processes.",
  "",
  "The first build can take a few minutes. You can remove the agent again at any time."
].join("\n");

// What actually happened, judged from the status the server reports afterwards,
// not from the fact that a request returned.
function outcome(kind: "install" | "remove", status: RealtimeAgentStatus): InlineActionResultState {
  if (kind === "remove") {
    return status.installed
      ? { key: "agent", tone: "danger", text: "The Realtime Data agent is still installed." }
      : { key: "agent", tone: "success", text: "The Realtime Data agent was removed." };
  }
  if (status.reachable) return { key: "agent", tone: "success", text: "The Realtime Data agent is set up and answering." };
  return { key: "agent", tone: "danger", text: status.running
    ? "The Realtime Data agent was started but is not answering yet."
    : "The Realtime Data agent was set up but is not running." };
}

// Tells the owner that Realtime Data needs the position agent and can set it up
// (or remove it again) on request. Nothing is installed without the confirmation
// below. `needed` is true while a key (or the key being created) holds the
// Realtime Data permission.
export function RealtimeAgentNotice({ needed, confirmAction }: { needed: boolean; confirmAction: ConfirmAction }) {
  const [status, setStatus] = useState<RealtimeAgentStatus | null>(null);
  const [busy, setBusy] = useState<"install" | "remove" | null>(null);
  const [result, setResult] = useState<InlineActionResultState | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Ask again when a key starts or stops needing it, so the notice is current
  // at the moment the owner grants or revokes the permission.
  useEffect(() => {
    let active = true;
    realtimeAgentApi.status().then((next) => { if (active) setStatus(next); }).catch(() => { if (active) setStatus(null); });
    return () => { active = false; };
  }, [needed]);

  // The page may be opened while a setup is already running, and a long first
  // build can outlive the request that started it. While the server reports an
  // operation in progress, ask again until it is finished. Bounded and cleaned up
  // on unmount.
  const serverBusy = status?.busy ?? null;
  useEffect(() => {
    if (!serverBusy || busy) return undefined;
    let active = true;
    let polls = 0;
    const timer = window.setInterval(() => {
      polls += 1;
      if (polls > MAX_POLLS) { window.clearInterval(timer); return; }
      realtimeAgentApi.status().then((next) => {
        if (!active || !mounted.current) return;
        setStatus(next);
        if (!next.busy) setResult(outcome(serverBusy, next));
      }).catch(() => {});
    }, POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [serverBusy, busy]);

  async function change(kind: "install" | "remove") {
    const confirmed = kind === "install"
      ? await confirmAction(INSTALL_MESSAGE, { title: "Set Up Realtime Data Agent", confirmLabel: "Build and Start", danger: true })
      : await confirmAction("Stop and remove the Realtime Data agent? Realtime Data stops working until it is set up again. API keys are not changed.", { title: "Remove Realtime Data Agent", confirmLabel: "Remove Agent", danger: true });
    if (!confirmed) return;
    setBusy(kind);
    setResult(null);
    try {
      const next = await (kind === "install" ? realtimeAgentApi.install() : realtimeAgentApi.remove());
      if (!mounted.current) return;
      setStatus(next);
      setResult(outcome(kind, next));
    } catch (error) {
      if (!mounted.current) return;
      setResult({ key: "agent", tone: "danger", text: error instanceof Error ? error.message : String(error) });
      // Show what is true now: the setup may still be running (a proxy cut the
      // response), or have left an installed agent that is not answering.
      try {
        const latest = await realtimeAgentApi.status();
        if (mounted.current) {
          setStatus(latest);
          if (latest.busy) setResult({ key: "agent", tone: "neutral", text: "The setup is still running on the server. This page keeps checking." });
        }
      } catch { /* the error above stays */ }
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  // Older installations without the setup files, or a status that could not be read: say nothing.
  if (!status || !status.available) return null;

  const activity = busy ?? status.busy;
  const working = activity !== null;
  const missing = needed && !status.reachable;
  const removable = !needed && status.installed;
  if (!missing && !removable && !result) return null;

  return <div className="realtime-agent-notice" role="status">
    {missing && <>
      <p className="attention-text"><AlertTriangle size={16} aria-hidden="true" />{" "}
        {status.reason === "misconfigured"
          ? "Realtime Data is enabled, but DUNE_REALTIME_AGENT_URL is not usable. Fix the address in the Console settings."
          : status.installed
            ? "Realtime Data is enabled, but the position agent is installed and not answering."
            : "Realtime Data is enabled, but the position agent is not installed on this host. Without it the Realtime Data routes answer 503."}
      </p>
      {status.reason !== "misconfigured" && <button type="button" disabled={working} onClick={() => { void change("install"); }}>
        {activity === "install" ? <><LoaderCircle size={16} aria-hidden="true" className="restore-step-spin" /> Setting Up...</> : status.installed ? "Rebuild Agent" : "Set Up Agent"}
      </button>}
    </>}
    {removable && <>
      <p className="muted">No API key uses Realtime Data any more, but the position agent is still installed{status.running ? " and running" : ""}.</p>
      <button type="button" disabled={working} onClick={() => { void change("remove"); }}>
        {activity === "remove" ? <><LoaderCircle size={16} aria-hidden="true" className="restore-step-spin" /> Removing...</> : "Remove Agent"}
      </button>
    </>}
    <InlineActionResult result={result} resultKey="agent" />
  </div>;
}
