import { useEffect, useRef, useState } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { realtimeAgentApi, type RealtimeAgentStatus } from "../../api/realtimeAgent";
import { InlineActionResult, type InlineActionResultState } from "../../components/common/InlineActionResult";

type ConfirmAction = (
  message: string,
  options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
) => Promise<boolean>;

const INSTALL_MESSAGE = [
  "This builds the Realtime Data position agent from source and starts it as a container on this host.",
  "",
  "The agent runs as root, shares the host's process list and uses ptrace to read the memory of the game server processes (read-only). It listens on 127.0.0.1:8796 only and has no login; the Console is its only door.",
  "",
  "The first build can take a few minutes. You can remove the agent again at any time."
].join("\n");

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
      setResult({ key: "agent", tone: "success", text: kind === "install" ? "The Realtime Data agent is set up." : "The Realtime Data agent was removed." });
    } catch (error) {
      if (!mounted.current) return;
      setResult({ key: "agent", tone: "danger", text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  // Older installations without the setup files, or a status that could not be read: say nothing.
  if (!status || !status.available) return null;

  const working = busy !== null || status.busy !== null;
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
        {busy === "install" ? <><LoaderCircle size={16} aria-hidden="true" className="restore-step-spin" /> Setting Up...</> : status.installed ? "Rebuild Agent" : "Set Up Agent"}
      </button>}
    </>}
    {removable && <>
      <p className="muted">No API key uses Realtime Data any more, but the position agent is still installed{status.running ? " and running" : ""}.</p>
      <button type="button" disabled={working} onClick={() => { void change("remove"); }}>
        {busy === "remove" ? <><LoaderCircle size={16} aria-hidden="true" className="restore-step-spin" /> Removing...</> : "Remove Agent"}
      </button>
    </>}
    <InlineActionResult result={result} resultKey="agent" />
  </div>;
}
