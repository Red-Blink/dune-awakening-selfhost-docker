import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { encryptedApiApi, type EncryptedApiStatus } from "../../api/encryptedApi";
import { StatusPill } from "../../components/common/DisplayPrimitives";
import { InlineActionResult, type InlineActionResultState } from "../../components/common/InlineActionResult";
import { copyText } from "../../lib/clipboard";

function statusLabel(status: EncryptedApiStatus) {
  if (!status.available) return "Not Available";
  if (!status.enabled) return "Off";
  if (!status.running) return "Stopped";
  if (status.health === "starting") return "Starting";
  if (status.health === "unhealthy") return "Unhealthy";
  return "Running";
}

export function EncryptedApiSection() {
  const [status, setStatus] = useState<EncryptedApiStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<InlineActionResultState | null>(null);

  async function refresh() {
    try {
      setStatus(await encryptedApiApi.status());
    } catch (error) {
      setStatus({ available: false, enabled: false, running: false, state: "", health: "", port: 8797, fingerprint: "" });
      setResult({ key: "status", tone: "danger", text: error instanceof Error ? error.message : String(error) });
    }
  }

  useEffect(() => { void refresh(); }, []);

  useEffect(() => {
    if (!result || result.pending) return undefined;
    const id = window.setTimeout(() => setResult(null), 8000);
    return () => window.clearTimeout(id);
  }, [result]);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setResult({
      key: "toggle",
      tone: "neutral",
      text: enabled ? "Starting the encrypted API access... The first start builds the image and can take a minute." : "Stopping the encrypted API access...",
      pending: true
    });
    try {
      setStatus(await encryptedApiApi.setEnabled(enabled));
      setResult({ key: "toggle", tone: "success", text: enabled ? "Encrypted API access is on." : "Encrypted API access is off." });
    } catch (error) {
      setResult({ key: "toggle", tone: "danger", text: error instanceof Error ? error.message : String(error) });
      void refresh();
    } finally {
      setBusy(false);
    }
  }

  async function copyFingerprint() {
    if (!status?.fingerprint) return;
    try {
      await copyText(status.fingerprint);
      setCopied(true);
    } catch {
      setCopied(false);
      setResult({ key: "copy", tone: "danger", text: "Could not copy automatically. Select the fingerprint and copy it manually." });
    }
  }

  if (status === null) return <p className="muted">Loading Encrypted API Access...</p>;

  const address = `https://${window.location.hostname}:${status.port}`;

  return <div className="encrypted-api-section">
    <p className="muted">
      Serves the Console API over HTTPS with its own long-lived key, so API keys and data are not sent in clear text.
      Only API-key requests (GET) pass; the web UI stays on the normal address.
    </p>

    <div className="action-row">
      <span className="switch-label">Status:</span>
      <StatusPill value={statusLabel(status)} />
      <InlineActionResult result={result} resultKey="status" />
    </div>

    {!status.available && <p className="attention-text">
      This installation does not include the encrypted API access. Update Dune Docker to get it.
    </p>}

    {status.available && <>
      <label className={`switch-checkbox ${status.enabled ? "enabled" : "disabled"}`}>
        <input
          type="checkbox"
          disabled={busy}
          checked={status.enabled}
          onChange={(event) => { void toggle(event.target.checked); }}
        />
        <span className="switch-label">Encrypted API Access:</span>
        <strong className="switch-state">{busy ? "Working" : status.enabled ? "Enabled" : "Disabled"}</strong>
      </label>
      <InlineActionResult result={result} resultKey="toggle" />
      <InlineActionResult result={result} resultKey="copy" />
    </>}

    {status.available && status.fingerprint && <div className="encrypted-api-fingerprint">
      <label>
        <span className="field-label-row"><span>Key Fingerprint</span></span>
        <div className="api-key-reveal-row">
          <input readOnly value={status.fingerprint} aria-label="Key fingerprint of the encrypted API access" onFocus={(event) => event.target.select()} />
          <button onClick={() => { void copyFingerprint(); }}><Copy size={16} aria-hidden="true" /> {copied ? "Copied" : "Copy"}</button>
        </div>
      </label>
      <p className="muted">Address: <code>{address}</code>. Allow TCP {status.port} in the server firewall.</p>
    </div>}
  </div>;
}
