import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { api, post, setCsrfToken } from "../../api/client";
import { SecretInput } from "../../components/SecretInput";
import { InfoTooltip, KeyValueGrid, StatusPill } from "../../components/common/DisplayPrimitives";
import { RecoveryCodesPanel } from "../auth/RecoveryCodesPanel";
import { firstDefined, formatUiSentence, friendlyColumnName } from "../../lib/display";
import { ApiKeysSection } from "./ApiKeysSection";

// Authenticator apps display codes as "123 456" and the server strips whitespace
// (auth/totp.js) precisely so a paste of that form validates. Do not add
// maxLength={6} to the inputs below: it truncates such a paste to "123 45"
// before the server ever sees it, and every resulting rejection spends
// rate-limiter budget.
function stripCodeWhitespace(value: string) {
  return value.replace(/\s/g, "");
}

type SettingsTaskResult = { status: "running" | "succeeded" | "failed" | "stopped"; title: string; message?: string; details?: string };
type PublicDirectorySettings = {
  available?: boolean;
  enabled?: boolean;
  anonymousCountEnabled?: boolean;
  mode?: string;
  state?: string;
  lastSuccessAt?: string | null;
  error?: string | null;
  probeError?: string | null;
};

type ConfirmAction = (
  message: string,
  options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }
) => Promise<boolean>;

type SettingsPanelProps = {
  onPasswordChanged: () => Promise<void>;
  publicListingUrl?: string;
  // Needed by the API Keys section, which confirms before revoking a key.
  confirmAction: ConfirmAction;
  // Called after POST /api/auth/2fa/enable succeeds, so App can switch to the
  // same TotpSetupScreen the old forced-enrollment login flow used -- this
  // panel doesn't own that top-level view state.
  onTotpEnrollmentStarted: () => void;
};

export function SettingsPanel({ onPasswordChanged, publicListingUrl, confirmAction, onTotpEnrollmentStarted }: SettingsPanelProps) {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  // Tier 3 credential state. secondFactorEnrolled is read from /api/auth/me,
  // never inferred from a failed request: the form must know BEFORE submitting,
  // or the server demands an authenticator code the form has no field for.
  const [secondFactorEnrolled, setSecondFactorEnrolled] = useState(false);
  // Distinct from "not enrolled": the store threw, so 2FA state is unreadable.
  // Hiding the controls then is the worst possible response -- that is exactly
  // when the operator needs them.
  const [secondFactorUnavailable, setSecondFactorUnavailable] = useState(false);
  const [passwordTotpCode, setPasswordTotpCode] = useState("");
  const [twoFactorOpen, setTwoFactorOpen] = useState(false);
  const [totpEnablePassword, setTotpEnablePassword] = useState("");
  const [totpEnableSaving, setTotpEnableSaving] = useState(false);
  const [totpEnableResult, setTotpEnableResult] = useState<SettingsTaskResult | null>(null);
  const [totpDisablePassword, setTotpDisablePassword] = useState("");
  const [totpDisableTotpCode, setTotpDisableTotpCode] = useState("");
  const [totpDisableSaving, setTotpDisableSaving] = useState(false);
  const [totpDisableResult, setTotpDisableResult] = useState<SettingsTaskResult | null>(null);
  const [regeneratePassword, setRegeneratePassword] = useState("");
  const [regenerateTotpCode, setRegenerateTotpCode] = useState("");
  const [regenerateSaving, setRegenerateSaving] = useState(false);
  const [regenerateResult, setRegenerateResult] = useState<SettingsTaskResult | null>(null);
  const [regeneratedCodes, setRegeneratedCodes] = useState<string[] | null>(null);
  const [regenerateAcknowledged, setRegenerateAcknowledged] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordResult, setPasswordResult] = useState<SettingsTaskResult | null>(null);
  const [webPortResult, setWebPortResult] = useState<SettingsTaskResult | null>(null);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [webPortSaving, setWebPortSaving] = useState(false);
  const [serverListingSaving, setServerListingSaving] = useState(false);
  const [anonymousCountSaving, setAnonymousCountSaving] = useState(false);
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
  async function refreshCredentialState() {
    // Read independently of /api/settings: if this awaited inside refresh()
    // without its own try/catch, a transient failure there would abort before
    // this ran and silently leave secondFactorEnrolled at its `false`
    // initializer -- the dead end again, reached through a fail-open default.
    try {
      const me = await api<{ secondFactorEnrolled?: boolean; secondFactorUnavailable?: boolean; user?: { id?: string } }>("/api/auth/me");
      setSecondFactorEnrolled(Boolean(me.secondFactorEnrolled));
      setSecondFactorUnavailable(Boolean(me.secondFactorUnavailable));
    } catch {
      // Unknown, not "no". Mirror the server's canonical unknown shape --
      // {enrolled:false, unavailable:true}, BOTH flags. Setting only
      // `unavailable` would leave `enrolled` stale from an earlier success,
      // producing {enrolled:true, unavailable:true}, which the server never
      // emits: the panel would then render the "state could not be read"
      // banner AND the interactive regenerate form it just declared unavailable.
      setSecondFactorEnrolled(false);
      setSecondFactorUnavailable(true);
    }
  }
  const [apiKeysOpen, setApiKeysOpen] = useState(false);
  async function refresh() {
    await refreshCredentialState();
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
    // RFC §2.3/§5: once a second factor is enrolled the server requires fresh
    // proof of it, not just the current password. Caught here so the operator is
    // told before a round-trip that burns rate-limiter budget.
    if (secondFactorEnrolled && !passwordTotpCode.trim()) {
      setPasswordResult({ status: "failed", title: "Password Change Failed", message: "Enter your current authenticator code." });
      return;
    }
    setPasswordSaving(true);
    setPasswordResult({ status: "running", title: "Changing Login Password..." });
    try {
      await post("/api/settings/admin-password", secondFactorEnrolled
        ? { currentPassword, newPassword, totpCode: passwordTotpCode.trim() }
        : { currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordTotpCode("");
      setPasswordResult({ status: "succeeded", title: "Login Password Changed", message: "Signing you out so you can log back in with the new password." });
      window.setTimeout(() => { void onPasswordChanged(); }, 1600);
    } catch (error) {
      // A rejected attempt consumes that authenticator code either way (the
      // server advances lastUsedCounter on a match, and a mismatch was never
      // valid), so clear it: the operator must read a fresh one off their
      // device rather than re-submitting the same digits.
      setPasswordTotpCode("");
      setPasswordResult({ status: "failed", title: "Password Change Failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setPasswordSaving(false);
    }
  }
  async function regenerateRecoveryCodes() {
    if (!regeneratePassword) {
      setRegenerateResult({ status: "failed", title: "Regeneration Failed", message: "Enter your current login password." });
      return;
    }
    if (!regenerateTotpCode.trim()) {
      setRegenerateResult({ status: "failed", title: "Regeneration Failed", message: "Enter your current authenticator code." });
      return;
    }
    setRegenerateSaving(true);
    setRegenerateResult({ status: "running", title: "Generating New Recovery Codes..." });
    try {
      const result = await post<{ ok: boolean; recoveryCodes: string[] }>(
        "/api/auth/2fa/recovery-codes/regenerate",
        { currentPassword: regeneratePassword, totpCode: regenerateTotpCode.trim() }
      );
      setRegeneratePassword("");
      setRegenerateTotpCode("");
      setRegenerateAcknowledged(false);
      // Shown exactly once -- only digests are stored server-side, so there is
      // no second chance to retrieve these.
      setRegeneratedCodes(result.recoveryCodes);
      setRegenerateResult(null);
    } catch (error) {
      setRegenerateTotpCode("");
      setRegenerateResult({ status: "failed", title: "Regeneration Failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setRegenerateSaving(false);
    }
  }
  async function enableTwoFactor() {
    if (!totpEnablePassword) {
      setTotpEnableResult({ status: "failed", title: "Could Not Start Setup", message: "Enter your current login password." });
      return;
    }
    setTotpEnableSaving(true);
    setTotpEnableResult({ status: "running", title: "Starting Two-Factor Setup..." });
    try {
      const result = await post<{ enrollmentRequired: boolean; csrfToken: string }>("/api/auth/2fa/enable", { currentPassword: totpEnablePassword });
      setTotpEnablePassword("");
      setTotpEnableResult(null);
      // The server just swapped this session for a short-lived enrollment
      // session and returned ITS csrf token -- the old one is no longer valid.
      setCsrfToken(result.csrfToken);
      onTotpEnrollmentStarted();
    } catch (error) {
      setTotpEnableResult({ status: "failed", title: "Could Not Start Setup", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setTotpEnableSaving(false);
    }
  }
  async function disableTwoFactor() {
    if (!totpDisablePassword) {
      setTotpDisableResult({ status: "failed", title: "Disable Failed", message: "Enter your current login password." });
      return;
    }
    if (!totpDisableTotpCode.trim()) {
      setTotpDisableResult({ status: "failed", title: "Disable Failed", message: "Enter your current authenticator code." });
      return;
    }
    const confirmed = await confirmAction(
      "Two-factor authentication will be turned off, and your current recovery codes will stop working. You can enable it again any time.",
      { title: "Disable two-factor authentication?", confirmLabel: "Disable", danger: true }
    );
    if (!confirmed) return;
    setTotpDisableSaving(true);
    setTotpDisableResult({ status: "running", title: "Disabling Two-Factor Authentication..." });
    try {
      await post("/api/auth/2fa/disable", { currentPassword: totpDisablePassword, totpCode: totpDisableTotpCode.trim() });
      setTotpDisablePassword("");
      setTotpDisableTotpCode("");
      setTotpDisableResult({ status: "succeeded", title: "Two-Factor Authentication Disabled" });
      await refreshCredentialState();
    } catch (error) {
      setTotpDisableTotpCode("");
      setTotpDisableResult({ status: "failed", title: "Disable Failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setTotpDisableSaving(false);
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
  async function changeAnonymousCount(enabled: boolean) {
    setAnonymousCountSaving(true);
    setServerListingError("");
    try {
      const result = await post<{ ok: boolean; publicDirectory: PublicDirectorySettings }>("/api/settings/public-directory", { anonymousCountEnabled: enabled });
      setSettings((current) => current ? { ...current, publicDirectory: result.publicDirectory } : current);
    } catch (error) {
      setServerListingError(error instanceof Error ? error.message : String(error));
    } finally {
      setAnonymousCountSaving(false);
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
  const anonymousCountEnabled = publicDirectory.anonymousCountEnabled !== false;
  const passwordEnvManaged = Boolean(config.adminPasswordEnvManaged);
  const consoleTotpAvailable = config.consoleTotpEnabled === true;
  const currentPort = String(config.port || "8088");
  return <section className="panel">
    <div className="panel-title"><h2>Settings</h2><div className="action-row settings-title-actions">
      <div className="memory-feature-toggle settings-anonymous-count-control">
        <InfoTooltip id="anonymous-count-help" label="About Anonymous Count">Helps us understand how many Dune Docker servers are in use, including local and unlisted installations. Only anonymous server presence is reported—never your server name, IP address, players, or configuration. These statistics help demonstrate project usage and guide future development.</InfoTooltip>
        <label className={`switch-checkbox settings-anonymous-count-toggle ${anonymousCountEnabled ? "enabled" : "disabled"}`}>
          <input
            type="checkbox"
            disabled={anonymousCountSaving}
            checked={anonymousCountEnabled}
            onChange={(event) => { void changeAnonymousCount(event.target.checked); }}
          />
          <span className="switch-label">Anonymous Count:</span>
          <strong className="switch-state">{anonymousCountSaving ? "Saving" : anonymousCountEnabled ? "Enabled" : "Disabled"}</strong>
        </label>
      </div>
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
            <label htmlFor="settings-pw-current">Current Password<SecretInput id="settings-pw-current" name="settings-pw-current" disabled={passwordEnvManaged || passwordSaving} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} placeholder="Current password" /></label>
            <label>New Password<SecretInput disabled={passwordEnvManaged || passwordSaving} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="At Least 13 Characters" /></label>
            <label><span className="field-label-row"><span>Confirm New Password</span>{confirmStarted && <span className={`password-match-inline ${passwordsMatch ? "passed" : "missing"}`}>{passwordsMatch ? "Matches" : "Passwords do not match"}</span>}</span><SecretInput disabled={passwordEnvManaged || passwordSaving} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Confirm new password" /></label>
            {secondFactorEnrolled && <label htmlFor="settings-pw-totp">Authenticator Code<input
              id="settings-pw-totp"
              name="settings-pw-totp"
              disabled={passwordEnvManaged || passwordSaving}
              value={passwordTotpCode}
              onChange={(event) => setPasswordTotpCode(stripCodeWhitespace(event.target.value))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="6-digit code"
            /></label>}
          </div>
          {secondFactorEnrolled && <p className="muted">Two-factor is enabled, so changing the password needs a current code from your authenticator as well.</p>}
          {passwordStarted && <div className="password-check-box">
            <strong>Password Requirements</strong>
            <ul className="password-requirements" aria-label="Password requirements">
              {passwordChecks.map((check) => <li className={check.passed ? "passed" : "missing"} key={check.label}>{check.label}</li>)}
            </ul>
          </div>}
          <div className="action-row">
            <button disabled={passwordEnvManaged || passwordSaving || !passwordMeetsRequirements || !passwordsMatch || (secondFactorEnrolled && !passwordTotpCode.trim())} onClick={() => { void changeLoginPassword(); }}>{passwordSaving ? "Saving..." : "Change Password"}</button>
            {passwordResult && <span className={`inline-task-result result-${passwordResult.status === "succeeded" ? "ok" : passwordResult.status === "failed" ? "fail" : "running"}`}>
              <strong className={passwordResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(passwordResult.title, passwordResult.status === "running")}</strong>
              {passwordResult.message && <span className="inline-task-message">{formatResultMessage(passwordResult.message)}</span>}
            </span>}
          </div>
        </div>}
      </div>
      {/* Rendered OUTSIDE the secondFactorEnrolled gate. While these codes are on
          screen they are the ONLY copy that will ever exist -- the previous sheet
          is already invalidated server-side and only digests persist. Gating them
          on a flag that any /api/auth/me re-read can flip to false would let the
          panel's own Refresh button, a few rows above, destroy them. */}
      {regeneratedCodes && <div className="playerAdmin_toggle open">
        <div className="playerAdmin_toggleBody">
          <div className="settings-recovery-codes">
            <RecoveryCodesPanel
              codes={regeneratedCodes}
              heading="Save your new recovery codes"
              intro="These 10 codes replace your previous set, which no longer works. They are shown once, right now, and cannot be retrieved again."
              confirmLabel="Done"
              onConfirm={() => { setRegeneratedCodes(null); setRegenerateAcknowledged(false); }}
              acknowledged={regenerateAcknowledged}
              onAcknowledgedChange={setRegenerateAcknowledged}
              headingLevel="h3"
            />
          </div>
        </div>
      </div>}
      {secondFactorUnavailable && <p className="attention-text">
        This console&apos;s two-factor state could not be read, so password changes and
        recovery-code regeneration are unavailable right now. Do not delete
        <code> runtime/generated/console-second-factor.json</code> &mdash; see the sign-in
        page&apos;s error for recovery guidance.
      </p>}
      {(secondFactorEnrolled || consoleTotpAvailable) && !secondFactorUnavailable && !regeneratedCodes && <div className={`playerAdmin_toggle ${twoFactorOpen ? "open" : ""}`}>
        <button className="playerAdmin_toggleHeader" aria-label={twoFactorOpen ? "Collapse Two-Factor Authentication" : "Expand Two-Factor Authentication"} onClick={() => setTwoFactorOpen(!twoFactorOpen)}>
          {twoFactorOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Two-Factor Authentication</span>
          {!secondFactorEnrolled && <span className="theme-note"> (off)</span>}
        </button>
        {twoFactorOpen && (secondFactorEnrolled ? <div className="playerAdmin_toggleBody">
          <p className="muted">Generate a fresh set of 10 recovery codes. Your authenticator is unchanged, and you stay signed in everywhere.</p>
          <p className="attention-text">Your existing recovery codes stop working the moment new ones are issued.</p>
          <div className="settings-password-grid">
            <label htmlFor="settings-regen-password">Password (to confirm it&apos;s you)<SecretInput id="settings-regen-password" name="settings-regen-password" disabled={regenerateSaving} value={regeneratePassword} onChange={(event) => setRegeneratePassword(event.target.value)} placeholder="Your login password" /></label>
            <label htmlFor="settings-regen-totp">Authenticator Code (to confirm it&apos;s you)<input
              id="settings-regen-totp"
              name="settings-regen-totp"
              disabled={regenerateSaving}
              value={regenerateTotpCode}
              onChange={(event) => setRegenerateTotpCode(stripCodeWhitespace(event.target.value))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="Current 6-digit code"
            /></label>
          </div>
          <div className="action-row">
            <button disabled={regenerateSaving || !regeneratePassword || !regenerateTotpCode.trim()} onClick={() => { void regenerateRecoveryCodes(); }}>{regenerateSaving ? "Generating..." : "Regenerate Recovery Codes"}</button>
            {regenerateResult && <span className={`inline-task-result result-${regenerateResult.status === "succeeded" ? "ok" : regenerateResult.status === "failed" ? "fail" : "running"}`}>
              <strong className={regenerateResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(regenerateResult.title, regenerateResult.status === "running")}</strong>
              {regenerateResult.message && <span className="inline-task-message">{formatResultMessage(regenerateResult.message)}</span>}
            </span>}
          </div>
          <hr className="auto-update-settings-divider" />
          <h4>Disable Two-Factor Authentication</h4>
          <p className="attention-text">Turns two-factor off entirely and deletes every remaining recovery code. Signing in goes back to password-only until you enable it again.</p>
          <div className="settings-password-grid">
            <label htmlFor="settings-totp-disable-password">Password (to confirm it&apos;s you)<SecretInput id="settings-totp-disable-password" name="settings-totp-disable-password" disabled={totpDisableSaving} value={totpDisablePassword} onChange={(event) => setTotpDisablePassword(event.target.value)} placeholder="Your login password (to disable)" /></label>
            <label htmlFor="settings-totp-disable-code">Authenticator Code (to confirm it&apos;s you)<input
              id="settings-totp-disable-code"
              name="settings-totp-disable-code"
              disabled={totpDisableSaving}
              value={totpDisableTotpCode}
              onChange={(event) => setTotpDisableTotpCode(stripCodeWhitespace(event.target.value))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="Current 6-digit code (to disable)"
            /></label>
          </div>
          <div className="action-row">
            <button disabled={totpDisableSaving || !totpDisablePassword || !totpDisableTotpCode.trim()} onClick={() => { void disableTwoFactor(); }}>{totpDisableSaving ? "Disabling..." : "Disable Two-Factor Authentication"}</button>
            {totpDisableResult && <span className={`inline-task-result result-${totpDisableResult.status === "succeeded" ? "ok" : totpDisableResult.status === "failed" ? "fail" : "running"}`}>
              <strong className={totpDisableResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(totpDisableResult.title, totpDisableResult.status === "running")}</strong>
              {totpDisableResult.message && <span className="inline-task-message">{formatResultMessage(totpDisableResult.message)}</span>}
            </span>}
          </div>
        </div> : <div className="playerAdmin_toggleBody">
          <p className="muted">Off by default. Turn it on to require an authenticator app code (plus 10 one-time recovery codes as backup) in addition to your password at sign-in.</p>
          <div className="settings-password-grid">
            <label htmlFor="settings-totp-enable-password">Password (to confirm it&apos;s you)<SecretInput id="settings-totp-enable-password" name="settings-totp-enable-password" disabled={totpEnableSaving} value={totpEnablePassword} onChange={(event) => setTotpEnablePassword(event.target.value)} placeholder="Your login password" /></label>
          </div>
          <p className="muted">You&apos;ll see a QR code to scan, then be asked to sign back in once it&apos;s confirmed.</p>
          <div className="action-row">
            <button disabled={totpEnableSaving || !totpEnablePassword} onClick={() => { void enableTwoFactor(); }}>{totpEnableSaving ? "Starting..." : "Enable Two-Factor Authentication"}</button>
            {totpEnableResult && <span className={`inline-task-result result-${totpEnableResult.status === "succeeded" ? "ok" : totpEnableResult.status === "failed" ? "fail" : "running"}`}>
              <strong className={totpEnableResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(totpEnableResult.title, totpEnableResult.status === "running")}</strong>
              {totpEnableResult.message && <span className="inline-task-message">{formatResultMessage(totpEnableResult.message)}</span>}
            </span>}
          </div>
        </div>)}
      </div>}
      <div className={`playerAdmin_toggle settings-api-keys-toggle ${apiKeysOpen ? "open" : ""}`}>
        <button className="playerAdmin_toggleHeader" aria-label={apiKeysOpen ? "Collapse API Keys" : "Expand API Keys"} onClick={() => setApiKeysOpen(!apiKeysOpen)}>{apiKeysOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>API Keys</span></button>
        {apiKeysOpen && <div className="playerAdmin_toggleBody"><ApiKeysSection confirmAction={confirmAction} /></div>}
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
