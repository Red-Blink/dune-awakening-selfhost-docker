import { useEffect, useState } from "react";
import { useConsoleAccess } from "../../lib/consoleAccess";
import { setupApi } from "../../api/setup";
import { validDatacenterId } from "../../components/SetupWizard";
import { InfoTooltip } from "../../components/common/DisplayPrimitives";
export function useServerHostname() {
  const access = useConsoleAccess();
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  async function load() {
    if (!access.can("setup:read")) return;
    setError("");
    try {
      const { serverConfig = {} } = await setupApi.state();
      const next = String(serverConfig.HOST_DATACENTER_ID || "").trim() || String(serverConfig.SERVER_PROVIDER || "").trim() || "dune-docker";
      setValue(next); setSaved(next);
    } catch { setError("Could not load the hostname."); }
  }
  useEffect(() => { void load(); }, [access]);
  const valid = validDatacenterId(value.trim());
  return { value, setValue, error, load, ready: Boolean(saved), valid, changed: value.trim() !== saved,
    async save() {
      if (!saved || !valid) throw new Error("Enter a valid server hostname or short ID.");
      const next = value.trim();
      await setupApi.writeConfig({ HOST_DATACENTER_ID: next });
      setSaved(next); setValue(next);
    }
  };
}
export function ServerHostnameSetting({ hostname, disabled }: { hostname: ReturnType<typeof useServerHostname>; disabled: boolean }) {
  return <div className="server-hostname-field">
    <span className="server-hostname-label"><label htmlFor="server-hostname">Server Hostname</label><InfoTooltip id="server-hostname-help" label="About Server Hostname">Optional Datacenter ID for server-browser ping. Use a hostname pointing to your public IP, without https:// or a port, or keep your existing ID. Falls back to SERVER_PROVIDER when unset. Saving the hostname alone does not restart services; apply it at your next Battlegroup restart. Funcom controls whether ping appears.</InfoTooltip></span>
    <input id="server-hostname" value={hostname.value} placeholder="game.example.com" disabled={disabled || !hostname.ready} onChange={event => hostname.setValue(event.target.value)} />
    {hostname.error && <span role="alert">{hostname.error} <button onClick={() => void hostname.load()}>Retry</button></span>}
    {hostname.ready && !hostname.valid && <span role="alert">Use only letters, numbers, dots, and hyphens.</span>}
  </div>;
}
