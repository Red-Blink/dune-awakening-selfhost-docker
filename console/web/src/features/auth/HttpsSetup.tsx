import { useCallback, useEffect, useRef, useState } from "react";
import { Cloud, ExternalLink, LockKeyhole, RefreshCw, ShieldCheck, Square } from "lucide-react";
import { api, post } from "../../api/client";
import { SecretInput } from "../../components/SecretInput";

type Provider = "cloudflare" | "tailscale" | "ngrok";
type Installation = { provider: Provider; label: string; hostInstalled: boolean; hostDetection: string; containers: { name: string; running: boolean }[] };
type Status = { providers: Installation[]; provider: Provider | ""; enabled: boolean; busy: boolean; phase: string; error: string; target: string; running: boolean; url: string; approvalUrl: string; verified: boolean; tailnetReady?: boolean; ngrokTokenSaved?: boolean };
const choices: { id: Provider; label: string; detail: string; icon: typeof Cloud }[] = [
  { id: "cloudflare", label: "Cloudflare Tunnel", detail: "Public access. No account needed. Temporary address.", icon: Cloud },
  { id: "tailscale", label: "Tailscale", detail: "Private access for devices on your tailnet. Account required.", icon: ShieldCheck },
  { id: "ngrok", label: "ngrok", detail: "Public access with your account's assigned domain.", icon: LockKeyhole }
];
const phaseLabels: Record<string, string> = { "Preparing HTTPS": "Preparing HTTPS", "Downloading and starting connector": "Downloading And Starting Connector", "Waiting for HTTPS": "Waiting For HTTPS" };

export function HttpsSetup({ initiallyOpen = false }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [status, setStatus] = useState<Status | null>(null);
  const [provider, setProvider] = useState<Provider>("cloudflare");
  const [token, setToken] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [existing, setExisting] = useState("");
  const inFlight = useRef(false);
  const revision = useRef(0);
  const alive = useRef(true);
  useEffect(() => { if (initiallyOpen) setOpen(true); }, [initiallyOpen]);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const requestedRevision = revision.current;
    try {
      const next = await api<Status>("/api/settings/console-https");
      if (alive.current && requestedRevision === revision.current) { setStatus(next); if (next.enabled && next.provider) setProvider(next.provider); setError(""); }
    } catch (cause) { if (alive.current && requestedRevision === revision.current) setError(cause instanceof Error ? cause.message : "Could not check HTTPS connections."); }
    finally { inFlight.current = false; }
  }, []);
  useEffect(() => {
    alive.current = true;
    if (!open) return () => { alive.current = false; };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, [open, refresh]);
  async function change(action: "start" | "stop" | "detect") {
    revision.current += 1;
    setWorking(true); setError("");
    try {
      await post("/api/settings/console-https", action === "start" ? { action, provider, confirmed, ...(provider === "ngrok" ? { token } : {}) } : { action });
      if (action === "start") {
        setToken("");
        setStatus((current) => current ? { ...current, enabled: true, busy: true, provider, phase: "Preparing HTTPS", error: "" } : current);
      }
      if (action === "stop") setStatus((current) => current ? { ...current, enabled: false, busy: false, running: false, url: "", approvalUrl: "", phase: "", error: "" } : current);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the HTTPS connection."); }
    finally { setWorking(false); }
  }
  const detected = status?.providers?.find((item) => item.provider === provider);
  const installed = detected?.hostInstalled || Boolean(detected?.containers.length);
  const busy = working || Boolean(status?.busy);
  let existingUrl = "";
  try {
    const parsed = new URL(existing);
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash) existingUrl = parsed.origin;
  } catch { /* Incomplete address. */ }
  return <details className="console-https-setup" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>HTTPS Connection Options</summary>
    <div className="console-https-content">
      <p>Choose how to reach this Console securely. Setup runs on the server through Docker, so you do not need to install command line tools.</p>
      {status?.target && <p className="muted">Current Console Address: <code>{status.target}</code>. Managed connections follow Console port changes automatically.</p>}
      <div className="console-https-choices" role="group" aria-label="HTTPS provider">
        {choices.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-pressed={provider === id} disabled={Boolean(status?.enabled) || working} onClick={() => { setProvider(id); setConfirmed(false); setError(""); }}>
          <Icon size={16} aria-hidden="true" /><span>{label}</span>
        </button>)}
      </div>
      <p className="muted console-https-provider-detail">{choices.find((choice) => choice.id === provider)?.detail}</p>
      {installed && <div className="console-https-detected">
        <strong>Existing Installation Detected</strong>
        <p>{detected?.hostInstalled ? `${detected.label} is installed on the host. ` : ""}{detected?.containers.map((c) => `${c.name} (${c.running ? "Running" : "Stopped"})`).join(", ")}</p>
        <p>Your existing setup stays under your control. Use its HTTPS address below, or create a separate connection for this Console.</p>
      </div>}
      {status && !installed && !status.enabled && <p className="muted">{detected?.hostDetection === "unavailable" ? "Host installation detection is unavailable. Docker connectors were checked." : "No existing installation was found in the standard host locations or Docker containers."} The official connector image will be downloaded only if needed.</p>}
      {!status?.enabled && <>
        {provider === "cloudflare" && <p>This creates a public address for your Console. Keep your password and 2FA enabled. The temporary address changes if the connector restarts. For a permanent address, use a named Cloudflare tunnel with your own domain.</p>}
        {provider === "tailscale" && <p>This creates a separate Tailscale device for the Console without changing the host VPN or DNS. Sign in to your account when prompted. Tailscale may also ask you to enable HTTPS for your tailnet. Only your tailnet can reach this address.</p>}
        {provider === "ngrok" && <label className="console-https-token">ngrok Authtoken<SecretInput value={token} onChange={(event) => setToken(event.target.value)} placeholder={status?.ngrokTokenSaved ? "Keep the saved authtoken" : "Paste your account authtoken"} /><small>{status?.ngrokTokenSaved && "Leave this blank to use your saved authtoken. "}Get this from your <a href="https://dashboard.ngrok.com/get-started/your-authtoken" target="_blank" rel="noreferrer">ngrok Dashboard</a>. It is saved privately on this server and never shown again.</small></label>}
        <label className="console-https-confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>{provider === "tailscale" ? "Allow devices on my tailnet to reach this Console." : "Allow public access to this Console's sign in page."}</span></label>
      </>}
      {status?.enabled && <div className="console-https-state" role="status">
        <strong>{status.error ? "Needs Attention" : status.url ? "HTTPS Is Ready" : status.approvalUrl ? "Account Approval Needed" : phaseLabels[status.phase] || "Connecting"}</strong>
        {status.tailnetReady && <p>Tailscale Serve is configured. Open the address from a device on your tailnet to check the connection.</p>}
        {status.url && <a className="console-https-open" href={status.url} target="_blank" rel="noreferrer"><ExternalLink size={16} aria-hidden="true" />Open HTTPS Console</a>}
        {status.url && <code>{status.url}</code>}
        {status.approvalUrl && !status.url && <a href={status.approvalUrl} target="_blank" rel="noreferrer">Continue With Tailscale <ExternalLink size={14} aria-hidden="true" /></a>}
        {!status.url && !status.error && !status.approvalUrl && <p>Preparing your secure address. This page updates automatically.</p>}
        {status.url && <p>Sign in at the HTTPS address, then return to Settings to continue Discord setup. Your current session stays open here.</p>}
        {status.url && status.provider === "cloudflare" && <p className="muted">Keep this connector running. If it restarts, update your Discord application's redirect address to match the new HTTPS address.</p>}
      </div>}
      {(error || status?.error) && <p className="error-text" role="alert">{error || status?.error}</p>}
      <div className="console-https-actions">
        {status?.enabled ? <button type="button" disabled={busy} onClick={() => { void change("stop"); }}><Square size={15} aria-hidden="true" />Stop Connection</button>
          : <button type="button" className="primary" disabled={!status || busy || !confirmed || (provider === "ngrok" && !token.trim() && !status.ngrokTokenSaved)} onClick={() => { void change("start"); }}><LockKeyhole size={16} aria-hidden="true" />{working ? "Starting" : "Set Up HTTPS"}</button>}
        <button type="button" disabled={busy} onClick={() => { void change("detect"); }}><RefreshCw size={15} aria-hidden="true" />Check Again</button>
      </div>
      <details className="console-https-existing"><summary>Use An Existing HTTPS Connection</summary>
        <p>If you already have a reverse proxy or tunnel, open its Console address here. Existing installations are not replaced or reconfigured.</p>
        <label>HTTPS Console Address<input type="url" placeholder="https://console.example.com" value={existing} onChange={(event) => setExisting(event.target.value)} /></label>
        {existingUrl && <a href={existingUrl} target="_blank" rel="noreferrer">Open Existing HTTPS Console <ExternalLink size={14} aria-hidden="true" /></a>}
      </details>
      <p className="muted">Provider account approval and domain ownership stay with you. <a href="https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/" target="_blank" rel="noreferrer">Cloudflare Guide</a> · <a href="https://tailscale.com/docs/features/tailscale-serve" target="_blank" rel="noreferrer">Tailscale Guide</a> · <a href="https://ngrok.com/docs/getting-started/" target="_blank" rel="noreferrer">ngrok Guide</a></p>
    </div>
  </details>;
}
