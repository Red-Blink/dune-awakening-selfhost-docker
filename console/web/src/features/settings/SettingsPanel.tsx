import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { api, post } from "../../api/client";
import { SecretInput } from "../../components/SecretInput";
import { KeyValueGrid, StatusPill } from "../../components/common/DisplayPrimitives";
import { firstDefined, formatUiSentence, friendlyColumnName } from "../../lib/display";

type SettingsTaskResult = { status: "running" | "succeeded" | "failed" | "stopped"; title: string; message?: string; details?: string };
type PublicDirectorySettings = {
  available?: boolean;
  enabled?: boolean;
  mode?: string;
  state?: string;
  lastSuccessAt?: string | null;
  error?: string | null;
  probeError?: string | null;
};

type SettingsPanelProps = {
  onPasswordChanged: () => Promise<void>;
  publicListingUrl?: string;
};

export function SettingsPanel({ onPasswordChanged, publicListingUrl }: SettingsPanelProps) {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordResult, setPasswordResult] = useState<SettingsTaskResult | null>(null);
  const [webPortResult, setWebPortResult] = useState<SettingsTaskResult | null>(null);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [webPortSaving, setWebPortSaving] = useState(false);
  const [serverListingSaving, setServerListingSaving] = useState(false);
  const [serverListingError, setServerListingError] = useState("");
  const [publicProfileOpen, setPublicProfileOpen] = useState(false);
  const [publicProfileSaving, setPublicProfileSaving] = useState(false);
  const [publicProfileResult, setPublicProfileResult] = useState<SettingsTaskResult | null>(null);
  const [claimCode, setClaimCode] = useState("");
  const [loginPasswordOpen, setLoginPasswordOpen] = useState(false);
  const [webPortOpen, setWebPortOpen] = useState(false);
  const [webPort, setWebPort] = useState("");
  const [webPortRedirectUrl, setWebPortRedirectUrl] = useState("");
  const [webPortRedirectCountdown, setWebPortRedirectCountdown] = useState<number | null>(null);
  async function refresh() {
    const nextSettings = await api<Record<string, unknown>>("/api/settings");
    setSettings(nextSettings);
    const config = (nextSettings.config as Record<string, unknown> | undefined) || {};
    const directory = (nextSettings.publicDirectory as PublicDirectorySettings | undefined) || {};
    setWebPort(String(config.port || "8088"));
  }
  useEffect(() => {
    refresh().catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!passwordResult || passwordResult.status === "running") return;
    const id = window.setTimeout(() => setPasswordResult(null), 5400);
    return () => window.clearTimeout(id);
  }, [passwordResult]);
  useEffect(() => {
    if (!webPortResult || webPortResult.status === "running" || webPortRedirectUrl) return;
    const id = window.setTimeout(() => setWebPortResult(null), 9000);
    return () => window.clearTimeout(id);
  }, [webPortRedirectUrl, webPortResult]);
  useEffect(() => {
    if (!publicProfileResult || publicProfileResult.status === "running") return;
    const id = window.setTimeout(() => setPublicProfileResult(null), 7000);
    return () => window.clearTimeout(id);
  }, [publicProfileResult]);
  useEffect(() => {
    if (!webPortRedirectUrl || webPortRedirectCountdown === null) return;
    if (webPortRedirectCountdown <= 0) {
      window.location.assign(webPortRedirectUrl);
      return;
    }
    const id = window.setTimeout(() => setWebPortRedirectCountdown((value) => value === null ? null : value - 1), 1000);
    return () => window.clearTimeout(id);
  }, [webPortRedirectCountdown, webPortRedirectUrl]);
  const passwordChecks = adminPasswordChecks(newPassword);
  const passwordMeetsRequirements = passwordChecks.every((check) => check.passed);
  const passwordStarted = newPassword.length > 0;
  const confirmStarted = confirmPassword.length > 0;
  const passwordsMatch = newPassword === confirmPassword;
  async function changeLoginPassword() {
    if (!currentPassword) {
      setPasswordResult({ status: "failed", title: "Password Change Failed", message: "Enter your current login password." });
      return;
    }
    if (!passwordMeetsRequirements) {
      setPasswordResult({ status: "failed", title: "Password Change Failed", message: "New password must meet all password requirements." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordResult({ status: "failed", title: "Password Change Failed", message: "New password and confirmation do not match." });
      return;
    }
    setPasswordSaving(true);
    setPasswordResult({ status: "running", title: "Changing Login Password..." });
    try {
      await post("/api/settings/admin-password", { currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordResult({ status: "succeeded", title: "Login Password Changed", message: "Signing you out so you can log back in with the new password." });
      window.setTimeout(() => { void onPasswordChanged(); }, 1600);
    } catch (error) {
      setPasswordResult({ status: "failed", title: "Password Change Failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setPasswordSaving(false);
    }
  }
  async function changeWebPort() {
    const port = Number(webPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setWebPortResult({ status: "failed", title: "Port Change Failed", message: "Enter a port number between 1 and 65535." });
      return;
    }
    setWebPortSaving(true);
    setWebPortRedirectUrl("");
    setWebPortRedirectCountdown(null);
    setWebPortResult({ status: "running", title: "Saving Web Console Port..." });
    try {
      const result = await post<{ ok: boolean; port: number; url: string; message?: string }>("/api/settings/web-port", { port });
      setWebPort(String(result.port));
      setWebPortRedirectUrl(result.url);
      setWebPortRedirectCountdown(10);
      setWebPortResult({
        status: "succeeded",
        title: "Web Console Port Saved",
        message: result.message || `The console is restarting now. You will be redirected to ${result.url}.`
      });
    } catch (error) {
      setWebPortRedirectUrl("");
      setWebPortRedirectCountdown(null);
      setWebPortResult({ status: "failed", title: "Port Change Failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setWebPortSaving(false);
    }
  }
  async function changeServerListing(enabled: boolean) {
    setServerListingSaving(true);
    setServerListingError("");
    try {
      const result = await post<{ ok: boolean; publicDirectory: PublicDirectorySettings }>("/api/settings/public-directory", { enabled });
      setSettings((current) => current ? { ...current, publicDirectory: result.publicDirectory } : current);
    } catch (error) {
      setServerListingError(error instanceof Error ? error.message : String(error));
    } finally {
      setServerListingSaving(false);
    }
  }
  async function verifyListingClaim() {
    setPublicProfileSaving(true);
    setPublicProfileResult({ status: "running", title: "Verifying Listing Claim..." });
    try {
      const result = await post<{ ok: boolean; message: string }>("/api/settings/public-directory/claim", { code: claimCode });
      setClaimCode("");
      setPublicProfileResult({
        status: "succeeded",
        title: "Public Listing Claimed",
        message: result.message
      });
      window.dispatchEvent(new Event("public-directory-claim-changed"));
    } catch (error) {
      setPublicProfileResult({
        status: "failed",
        title: "Listing Claim Failed",
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setPublicProfileSaving(false);
    }
  }
  const config = (settings?.config as Record<string, unknown> | undefined) || {};
  const publicDirectory = (settings?.publicDirectory as PublicDirectorySettings | undefined) || {};
  const serverListingVisible = settings !== null && publicDirectory.available === true;
  const serverListingEnabled = publicDirectory.enabled === true;
  const passwordEnvManaged = Boolean(config.adminPasswordEnvManaged);
  const currentPort = String(config.port || "8088");
  return <section className="panel">
    <div className="panel-title"><h2>Settings</h2><div className="action-row settings-title-actions">
      {serverListingVisible && <label className={`switch-checkbox settings-server-listing-toggle ${serverListingEnabled ? "enabled" : "disabled"}`}>
        <input
          type="checkbox"
          disabled={serverListingSaving}
          checked={serverListingEnabled}
          onChange={(event) => { void changeServerListing(event.target.checked); }}
        />
        <span className="switch-label">Server Listing:</span>
        <strong className="switch-state">{serverListingSaving ? "Saving" : serverListingEnabled ? "Enabled" : "Disabled"}</strong>
      </label>}
      <button onClick={refresh}>Refresh</button>
    </div></div>
    {serverListingError && <p className="error settings-server-listing-error">{serverListingError}</p>}
    {serverListingVisible && serverListingEnabled && publicDirectory.probeError &&
      <p className="error settings-server-listing-error">Server listing issue: {publicDirectory.probeError}</p>}
    <div className="settings-section-stack">
      {serverListingVisible && <div className={`playerAdmin_toggle settings-public-profile-toggle ${publicProfileOpen ? "open" : ""}`}>
        <button className="playerAdmin_toggleHeader" aria-label={publicProfileOpen ? "Collapse Public Listing Profile" : "Expand Public Listing Profile"} onClick={() => setPublicProfileOpen(!publicProfileOpen)}>
          {publicProfileOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
          <span>Public Listing Profile</span>
        </button>
        {publicProfileOpen && <div className="playerAdmin_toggleBody">
          <p className="muted">Public descriptions, community links, recruitment details, and Player Portal settings are managed on DuneDocker.app. Generate a claim code from {publicListingUrl
            ? <a className="settings-server-page-link" href={publicListingUrl} target="_blank" rel="noreferrer">[Your Server Page]</a>
            : "[Your Server Page]"}, then paste it below.</p>
          <label className="settings-discord-field">
            <span className="field-label-row"><span className="settings-discord-label">Generated Claim Code</span></span>
            <input
              disabled={publicProfileSaving}
              value={claimCode}
              onChange={(event) => setClaimCode(event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 14))}
              placeholder="ABCD-EF12-3456"
              autoComplete="off"
            />
          </label>
          <div className="action-row">
            <button disabled={publicProfileSaving || claimCode.replace(/[^A-Z0-9]/g, "").length !== 12} onClick={() => { void verifyListingClaim(); }}>
              {publicProfileSaving ? "Verifying..." : "Verify Generated Code"}
            </button>
            {publicProfileResult && <span className={`inline-task-result result-${publicProfileResult.status === "succeeded" ? "ok" : publicProfileResult.status === "failed" ? "fail" : "running"}`}>
              <strong className={publicProfileResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(publicProfileResult.title, publicProfileResult.status === "running")}</strong>
              {publicProfileResult.message && <span className="inline-task-message">{formatResultMessage(publicProfileResult.message)}</span>}
            </span>}
          </div>
        </div>}
      </div>}
      <RuntimeSettingsSummary settings={settings} />
      <div className={`playerAdmin_toggle settings-web-port-toggle ${webPortOpen ? "open" : ""}`}>
        <button className="playerAdmin_toggleHeader" aria-label={webPortOpen ? "Collapse Web Console Port" : "Expand Web Console Port"} onClick={() => setWebPortOpen(!webPortOpen)}>{webPortOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Web Console Port</span></button>
        {webPortOpen && <div className="playerAdmin_toggleBody">
          <p className="muted">Change the browser port used by this web console.</p>
          <p className="attention-text">After saving, this page will stop responding on port {currentPort}. Open the new address shown in the result message.</p>
          <div className="settings-password-grid settings-web-port-grid">
            <label>Console Port<input disabled={webPortSaving} type="number" min="1" max="65535" step="1" value={webPort} onChange={(event) => setWebPort(event.target.value.replace(/[^\d]/g, "").slice(0, 5))} placeholder="8088" /></label>
          </div>
          <div className="action-row">
            <button disabled={webPortSaving || Boolean(webPortRedirectUrl) || !webPort || webPort === currentPort} onClick={() => { void changeWebPort(); }}>{webPortSaving ? "Saving..." : "Save And Restart Console"}</button>
            {webPortResult && <span className={`inline-task-result result-${webPortResult.status === "succeeded" ? "ok" : webPortResult.status === "failed" ? "fail" : "running"}`}>
              <strong className={webPortResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(webPortResult.title, webPortResult.status === "running")}</strong>
              <span className="inline-task-message">{formatWebPortResultMessage(webPortResult, webPortRedirectUrl, webPortRedirectCountdown)}</span>
            </span>}
          </div>
        </div>}
      </div>
      <div className={`playerAdmin_toggle settings-login-password-toggle ${loginPasswordOpen ? "open" : ""}`}>
        <button className="playerAdmin_toggleHeader" aria-label={loginPasswordOpen ? "Collapse Login Password" : "Expand Login Password"} onClick={() => setLoginPasswordOpen(!loginPasswordOpen)}>{loginPasswordOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Login Password</span></button>
        {loginPasswordOpen && <div className="playerAdmin_toggleBody">
          <p className="muted">Change the password used to sign in to this web console.</p>
          {passwordEnvManaged && <p className="attention-text">The login password is managed by <code>ADMIN_PASSWORD</code>. Update the environment value to change it.</p>}
          <div className="settings-password-grid">
            <label>Current Password<SecretInput disabled={passwordEnvManaged || passwordSaving} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} placeholder="Current password" /></label>
            <label>New Password<SecretInput disabled={passwordEnvManaged || passwordSaving} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="At Least 13 Characters" /></label>
            <label><span className="field-label-row"><span>Confirm New Password</span>{confirmStarted && <span className={`password-match-inline ${passwordsMatch ? "passed" : "missing"}`}>{passwordsMatch ? "Matches" : "Passwords do not match"}</span>}</span><SecretInput disabled={passwordEnvManaged || passwordSaving} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Confirm new password" /></label>
          </div>
          {passwordStarted && <div className="password-check-box">
            <strong>Password Requirements</strong>
            <ul className="password-requirements" aria-label="Password requirements">
              {passwordChecks.map((check) => <li className={check.passed ? "passed" : "missing"} key={check.label}>{check.label}</li>)}
            </ul>
          </div>}
          <div className="action-row">
            <button disabled={passwordEnvManaged || passwordSaving || !passwordMeetsRequirements || !passwordsMatch} onClick={() => { void changeLoginPassword(); }}>{passwordSaving ? "Saving..." : "Change Password"}</button>
            {passwordResult && <span className={`inline-task-result result-${passwordResult.status === "succeeded" ? "ok" : passwordResult.status === "failed" ? "fail" : "running"}`}>
              <strong className={passwordResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(passwordResult.title, passwordResult.status === "running")}</strong>
              {passwordResult.message && <span className="inline-task-message">{formatResultMessage(passwordResult.message)}</span>}
            </span>}
          </div>
        </div>}
      </div>
    </div>
  </section>;
}

function formatResultTitle(value: unknown, pending = false) {
  return formatUiSentence(value, pending);
}

function formatResultMessage(value: unknown) {
  return formatUiSentence(value, false);
}

function formatWebPortResultMessage(result: SettingsTaskResult, redirectUrl: string, countdown: number | null) {
  if (result.status === "succeeded" && redirectUrl && countdown !== null) {
    return `The console is restarting now. Redirecting in ${countdown} second${countdown === 1 ? "" : "s"}.`;
  }
  return result.message ? formatResultMessage(result.message) : "";
}

function adminPasswordChecks(password: string) {
  return [
    { label: "At Least 13 Characters", passed: password.length >= 13 },
    { label: "Lowercase Letter", passed: /[a-z]/.test(password) },
    { label: "Uppercase Letter", passed: /[A-Z]/.test(password) },
    { label: "Number", passed: /\d/.test(password) },
    { label: "Special Character", passed: /[^A-Za-z0-9]/.test(password) }
  ];
}

function RuntimeSettingsSummary({ settings }: { settings: Record<string, unknown> | null }) {
  const config = (settings?.config as Record<string, unknown> | undefined) || {};
  const files = (settings?.files as Record<string, unknown> | undefined) || {};
  return <div className="action-sections">
    <section className="action-section">
      <h4>Runtime Configuration</h4>
      <KeyValueGrid items={[
        ["App Name", firstDefined(config.appName, config.app_name, "Dune Docker Console")],
        ["Repo Root", config.repoRoot],
        ["Auth", config.authEnabled === false ? "Disabled" : "Enabled"],
        ["Secure Cookies", booleanLabel(config.secureCookies)],
        ["Host Bootstrap", booleanLabel(config.allowHostBootstrap)],
        ["Mock Mode", booleanLabel(config.mockMode)],
        ["Runtime path", config.runtimePath],
        ["Task retention", config.taskRetention]
      ]} />
    </section>
    <section className="action-section">
      <h4>Files Checklist</h4>
      <div className="check-grid">{Object.entries(files).map(([key, value]) => <article className="check-card" key={key}><div><strong>{friendlyFileLabel(key)}</strong><p>{value ? "Found" : "Missing"}</p></div><StatusPill value={value ? "Ready" : "Attention Needed"} /></article>)}</div>
      {!Object.keys(files).length && <p>Runtime file checks have not loaded yet.</p>}
    </section>
  </div>;
}

function booleanLabel(value: unknown) {
  if (value === true) return "Enabled";
  if (value === false) return "Disabled";
  return value ?? "Unknown";
}

function friendlyFileLabel(value: string) {
  return {
    env: "Environment File",
    token: "Auth Token",
    battlegroup: "Battlegroup",
    duneScript: "Dune Script"
  }[value] || friendlyColumnName(value);
}
