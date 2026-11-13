import { PermissionGate } from "../../lib/consoleAccess";
import { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { encryptedApiApi, type EncryptedApiStatus } from "../../api/encryptedApi";
import { StatusPill } from "../../components/common/DisplayPrimitives";
import { InlineActionResult, type InlineActionResultState } from "../../components/common/InlineActionResult";
import { copyText } from "../../lib/clipboard";

function statusLabel(status: EncryptedApiStatus) {
  if (!status.available) return "Not Available";
  if (!status.enabled) return "Disabled";
  if (!status.running) return "Stopped";
  if (status.health === "starting") return "Starting";
  if (status.health === "unhealthy") return "Unhealthy";
  return "Running";
}

export function EncryptedApiSection() {
  const [status, setStatus] = useState<EncryptedApiStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [changingTo, setChangingTo] = useState(false);
  const [copied, setCopied] = useState<"address" | "fingerprint" | null>(null);
  const [statusError, setStatusError] = useState("");
  const [result, setResult] = useState<InlineActionResultState | null>(null);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    let active = true;
    let timer: number;
    mounted.current = true;
    async function refresh() {
      const requestedRevision = revision.current;
      try {
        if (!busyRef.current) {
          const next = await encryptedApiApi.status();
          if (active && requestedRevision === revision.current && !busyRef.current) {
            setStatus(next);
            setStatusError("");
          }
        }
      } catch (error) {
        if (active && requestedRevision === revision.current && !busyRef.current) {
          setStatusError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        // Schedule after completion so slow requests never overlap. Continue
        // after healthy/failed states too, including changes made through SSH.
        if (active) timer = window.setTimeout(() => { void refresh(); }, 5000);
      }
    }
    void refresh();
    return () => {
      active = false;
      mounted.current = false;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function toggle(enabled: boolean) {
    busyRef.current = true;
    revision.current += 1;
    setBusy(true);
    setChangingTo(enabled);
    setStatusError("");
    setResult(null);
    try {
      const next = await encryptedApiApi.setEnabled(enabled);
      if (!mounted.current) return;
      setStatus(next);
    } catch (error) {
      if (!mounted.current) return;
      setResult({ key: "toggle", tone: "danger", text: error instanceof Error ? error.message : String(error) });
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function copyValue(kind: "address" | "fingerprint", value: string) {
    try {
      await copyText(value);
      if (mounted.current) setCopied(kind);
    } catch {
      if (!mounted.current) return;
      setCopied(null);
      setResult({ key: "copy", tone: "danger", text: "Could not copy automatically. Select the value and copy it manually." });
    }
  }

  if (status === null) return statusError
    ? <p className="attention-text" role="alert">Could not load API status: {statusError} Retrying automatically.</p>
    : <p className="muted">Loading Encrypted API Access...</p>;

  const address = `https://${window.location.hostname}:${status.port}`;
  const enabled = busy ? changingTo : status.enabled;
  const label = busy ? changingTo ? "Starting" : "Stopping" : statusLabel(status);
  const needsAttention = enabled && !busy && (!status.running || status.health === "unhealthy");

  return <div className="encrypted-api-section">
    <div className="encrypted-api-intro">
      <p className="muted encrypted-api-description">
        Let external tools read the Console API over HTTPS using an API key. Your Console login stays at its current address.
      </p>

      <div className="encrypted-api-controls">
        {status.available ? <label className={`switch-checkbox encrypted-api-switch ${enabled ? "enabled" : "disabled"} ${busy || label === "Starting" ? "is-pending" : needsAttention ? "needs-attention" : ""}`}
          title={busy && changingTo ? "The first start can take a minute." : undefined}>
          <PermissionGate action="settings:write"><input type="checkbox" aria-label="Enable Encrypted API Access" disabled={busy} checked={enabled}
            onChange={(event) => { void toggle(event.target.checked); }} /></PermissionGate>
          <span className="switch-label">HTTPS Access</span>
          <strong className="switch-state" role="status" aria-label="Encrypted API Status">{label}</strong>
        </label> : <StatusPill value={label} />}
      </div>
    </div>
    {statusError && <p className="attention-text" role="alert">Could not refresh API status: {statusError} Retrying automatically.</p>}

    {!status.available && <p className="attention-text">
      This installation does not include the encrypted API access. Update Dune Docker to get it.
    </p>}

    {result && <div role="alert">
      <InlineActionResult result={result} resultKey="toggle" />
      <InlineActionResult result={result} resultKey="copy" />
    </div>}

    {status.available && <div className="encrypted-api-details">
      <div className="encrypted-api-field">
        <div className="encrypted-api-field-heading">
          <span className="encrypted-api-field-label">HTTPS API Address</span>
          <button type="button" aria-label="Copy API address" onClick={() => { void copyValue("address", address); }}>
            <Copy size={16} aria-hidden="true" />{copied === "address" ? "Copied" : "Copy"}
          </button>
        </div>
        <code className="encrypted-api-value">{address}</code>
        <p className="muted">{status.enabled ? `For connections from another computer, allow TCP ${status.port} in the server firewall.` : "Enable HTTPS API access to use this address."}</p>
      </div>
      <div className="encrypted-api-field">
        <div className="encrypted-api-field-heading">
          <span className="encrypted-api-field-label">Key Fingerprint</span>
          {status.fingerprint && <button type="button" aria-label="Copy key fingerprint" onClick={() => { void copyValue("fingerprint", status.fingerprint); }}>
              <Copy size={16} aria-hidden="true" />{copied === "fingerprint" ? "Copied" : "Copy"}
          </button>}
        </div>
        {status.fingerprint ? <>
          <code className="encrypted-api-value">{status.fingerprint}</code>
          <p className="muted">Compare this fingerprint with the one shown by your tool before trusting the connection.</p>
        </> : <p className="muted">Created when HTTPS API access is first enabled.</p>}
      </div>
    </div>}
  </div>;
}
