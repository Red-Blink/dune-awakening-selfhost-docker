import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { api, post, postForResult, setCsrfToken } from "../../api/client";
import { SecretInput } from "../../components/SecretInput";
import { InfoTooltip, KeyValueGrid, StatusPill } from "../../components/common/DisplayPrimitives";
import { RecoveryCodesPanel } from "../auth/RecoveryCodesPanel";
import { DiscordSetupWizard } from "../auth/DiscordSetupWizard";
import { restartConsoleAndReload } from "../../lib/consoleRestart";
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
  // #643: true exactly once, when this mount follows a reconfiguration
  // Discord OAuth round-trip (App's own discordSetupReturnMarker) -- auto-
  // expands the Discord OAuth accordion below. onDiscordSetupAutoOpened must
  // be called once consumed, so App can clear it and a later remount of this
  // panel (navigate away from Settings and back) never re-triggers it.
  autoOpenDiscordSetup?: boolean;
  onDiscordSetupAutoOpened?: () => void;
  // #676 §7: same one-shot pattern, for the guided offer screen's "take me
  // there" branch when Discord's own MFA already covers the acting tier.
  autoOpenTwoFactor?: boolean;
  onTwoFactorAutoOpened?: () => void;
};

export function SettingsPanel({ onPasswordChanged, publicListingUrl, confirmAction, onTotpEnrollmentStarted, autoOpenDiscordSetup, onDiscordSetupAutoOpened, autoOpenTwoFactor, onTwoFactorAutoOpened }: SettingsPanelProps) {
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
  // #676 §8: true when the acting session authenticated via Discord OAuth,
  // not the console password -- drives contextual copy on the TOTP
  // enable/disable forms, since that session may not know the password at all.
  const [discordSessionActing, setDiscordSessionActing] = useState(false);
  const [passwordTotpCode, setPasswordTotpCode] = useState("");
  const [twoFactorOpen, setTwoFactorOpen] = useState(false);
  // #676 §7: same one-shot pattern as autoOpenDiscordSetup above.
  useEffect(() => {
    if (autoOpenTwoFactor) {
      setTwoFactorOpen(true);
      onTwoFactorAutoOpened?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot on mount
  }, []);
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
  // Discord OAuth (Tier 1) -- #643: the embedded DiscordSetupWizard now owns
  // all of this, replacing the manual per-field form that used to live here.
  //
  // #676 §3: the accordion defaults OPEN once Discord OAuth is configured
  // (primary) and closed otherwise -- but that default must stay overridable
  // by hand, so this is `null` (no manual choice yet) until the operator
  // actually toggles it, and the computed value below falls back to the
  // config-driven default whenever no override is set.
  const [discordOAuthOpenOverride, setDiscordOAuthOpenOverride] = useState<boolean | null>(null);
  // #643: consume the one-shot auto-open prop exactly once on mount -- never
  // re-checked afterward, so toggling the accordion closed by hand doesn't
  // get silently reopened by a stale prop value from a parent re-render.
  useEffect(() => {
    if (autoOpenDiscordSetup) {
      setDiscordOAuthOpenOverride(true);
      onDiscordSetupAutoOpened?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot on mount
  }, []);
  // #676 §6: soft-disable / re-enable / forget.
  const [discordDisableOpen, setDiscordDisableOpen] = useState(false);
  const [discordDisablePassword, setDiscordDisablePassword] = useState("");
  const [discordDisableTotpCode, setDiscordDisableTotpCode] = useState("");
  const [discordDisableSaving, setDiscordDisableSaving] = useState(false);
  const [discordDisableResult, setDiscordDisableResult] = useState<SettingsTaskResult | null>(null);
  const [discordEnableSaving, setDiscordEnableSaving] = useState(false);
  const [discordEnableResult, setDiscordEnableResult] = useState<SettingsTaskResult | null>(null);
  const [discordForgetOpen, setDiscordForgetOpen] = useState(false);
  const [discordForgetPassword, setDiscordForgetPassword] = useState("");
  const [discordForgetTotpCode, setDiscordForgetTotpCode] = useState("");
  const [discordForgetConfirmText, setDiscordForgetConfirmText] = useState("");
  const [discordForgetSaving, setDiscordForgetSaving] = useState(false);
  const [discordForgetResult, setDiscordForgetResult] = useState<SettingsTaskResult | null>(null);
  // #676 §7: the zero-2FA guard's UI half -- the server is the sole source of
  // truth for whether this fires (see totpDisableRoute), the client only
  // reacts to the 409 it returns rather than duplicating the same check.
  const [totpDisableZeroFactorWarning, setTotpDisableZeroFactorWarning] = useState(false);
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
      // #676 §8: "local-owner" is the server's own literal fallback for a
      // password/TOTP session's empty userId (server.js /api/auth/me route) --
      // anything else means this session is Discord-authenticated.
      setDiscordSessionActing(Boolean(me.user?.id) && me.user?.id !== "local-owner");
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
  // #676 §7: acknowledged=true resubmits after the zero-2FA guard's warning
  // was shown and the operator chose "Disable anyway" -- the guard itself is
  // entirely server-side (totpDisableRoute); this only reacts to its 409.
  async function disableTwoFactor(acknowledged = false) {
    if (!totpDisablePassword) {
      setTotpDisableResult({ status: "failed", title: "Disable Failed", message: "Enter your current login password." });
      return;
    }
    if (!totpDisableTotpCode.trim()) {
      setTotpDisableResult({ status: "failed", title: "Disable Failed", message: "Enter your current authenticator code." });
      return;
    }
    if (!acknowledged) {
      const confirmed = await confirmAction(
        "Two-factor authentication will be turned off, and your current recovery codes will stop working. You can enable it again any time.",
        { title: "Disable two-factor authentication?", confirmLabel: "Disable", danger: true }
      );
      if (!confirmed) return;
    }
    setTotpDisableZeroFactorWarning(false);
    setTotpDisableSaving(true);
    setTotpDisableResult({ status: "running", title: "Disabling Two-Factor Authentication..." });
    try {
      const { status, body } = await postForResult<{ error?: string; zeroFactorWarning?: boolean }>("/api/auth/2fa/disable", {
        currentPassword: totpDisablePassword,
        totpCode: totpDisableTotpCode.trim(),
        ...(acknowledged ? { acknowledgeNoOtherFactor: true } : {}),
      });
      if (status === 409 && body.zeroFactorWarning) {
        setTotpDisableZeroFactorWarning(true);
        setTotpDisableResult(null);
        return;
      }
      if (status < 200 || status >= 300) throw new Error(body.error || `Request failed: ${status}`);
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
  // #676 §6: soft-disable. Requires fresh Tier-3 proof (self-lockout guard,
  // not credential integrity -- see server.js's own comment on this route)
  // and restarts immediately and non-skippably (§6.3): showing "disabled" in
  // this UI before the restart actually applies it would be misleading
  // specifically during the scenario (suspected compromise) this exists for.
  async function disableDiscordOAuth() {
    if (!discordDisablePassword) {
      setDiscordDisableResult({ status: "failed", title: "Disable Failed", message: "Enter your current login password." });
      return;
    }
    const confirmed = await confirmAction(
      "Discord sign-in will stop working as soon as the console restarts. You'll need the admin password to sign in until you turn it back on -- your Discord application's settings are kept, not deleted.",
      { title: "Disable Discord sign-in?", confirmLabel: "Disable", danger: true }
    );
    if (!confirmed) return;
    setDiscordDisableSaving(true);
    setDiscordDisableResult({ status: "running", title: "Disabling Discord sign-in..." });
    try {
      await post("/api/settings/discord-oauth/disable", {
        currentPassword: discordDisablePassword,
        ...(discordDisableTotpCode.trim() ? { totpCode: discordDisableTotpCode.trim() } : {}),
      });
      setDiscordDisablePassword("");
      setDiscordDisableTotpCode("");
      await restartConsoleAndReload((c) => c.discordOAuthDisabled === true, {
        onRestarting: () => setDiscordDisableResult({ status: "running", title: "Restarting the console..." }),
        onTimeout: (message) => setDiscordDisableResult({ status: "failed", title: "Restart taking longer than expected", message }),
      });
    } catch (error) {
      setDiscordDisableResult({ status: "failed", title: "Disable Failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setDiscordDisableSaving(false);
    }
  }

  // #676 §6.3: no fresh proof required -- re-enabling only restores an
  // existing login option, it can never strand the acting session.
  async function enableDiscordOAuth() {
    setDiscordEnableSaving(true);
    setDiscordEnableResult({ status: "running", title: "Re-enabling Discord sign-in..." });
    try {
      await post("/api/settings/discord-oauth/enable", {});
      await restartConsoleAndReload((c) => c.discordOAuthDisabled !== true, {
        onRestarting: () => setDiscordEnableResult({ status: "running", title: "Restarting the console..." }),
        onTimeout: (message) => setDiscordEnableResult({ status: "failed", title: "Restart taking longer than expected", message }),
      });
    } catch (error) {
      setDiscordEnableResult({ status: "failed", title: "Re-enable Failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setDiscordEnableSaving(false);
    }
  }

  // #676 §6.4: irreversible for the role/guild mapping (the Client Secret
  // alone can always be regenerated from Discord's own portal) -- typed
  // confirmation replaces the standard confirmAction dialog here, judged
  // insufficient friction for an action this destructive.
  async function forgetDiscordOAuth() {
    if (discordForgetConfirmText.trim().toLowerCase() !== "forget") {
      setDiscordForgetResult({ status: "failed", title: "Not Confirmed", message: 'Type "forget" to confirm.' });
      return;
    }
    if (!discordForgetPassword) {
      setDiscordForgetResult({ status: "failed", title: "Forget Failed", message: "Enter your current login password." });
      return;
    }
    setDiscordForgetSaving(true);
    setDiscordForgetResult({ status: "running", title: "Forgetting Discord configuration..." });
    try {
      await post("/api/settings/discord-oauth/forget", {
        currentPassword: discordForgetPassword,
        ...(discordForgetTotpCode.trim() ? { totpCode: discordForgetTotpCode.trim() } : {}),
      });
      setDiscordForgetPassword("");
      setDiscordForgetTotpCode("");
      setDiscordForgetConfirmText("");
      await restartConsoleAndReload((c) => c.discordOAuthConfigured !== true && c.discordOAuthDisabled !== true, {
        onRestarting: () => setDiscordForgetResult({ status: "running", title: "Restarting the console..." }),
        onTimeout: (message) => setDiscordForgetResult({ status: "failed", title: "Restart taking longer than expected", message }),
      });
    } catch (error) {
      setDiscordForgetResult({ status: "failed", title: "Forget Failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setDiscordForgetSaving(false);
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
  // #676 §3/§6: the three Discord OAuth states this page's structure is
  // driven by. discordOAuthDisabled is independent of discordOAuthConfigured
  // (config.js gates the latter to false whenever the former is true) --
  // reading only discordOAuthConfigured could not tell "never configured"
  // apart from "configured, then soft-disabled."
  const discordOAuthConfigured = config.discordOAuthConfigured === true;
  const discordOAuthDisabled = config.discordOAuthDisabled === true;
  const discordOAuthOpen = discordOAuthOpenOverride ?? discordOAuthConfigured;
  const currentPort = String(config.port || "8088");
  // #676 §3: extracted so render order can flip based on which credential is
  // primary right now, without duplicating either block's JSX.
  const passwordSignInSection = <>
      {/* #676 §3: shown only once Discord OAuth is the primary sign-in path --
          states plainly that this is now the break-glass fallback, and (once
          Discord's own MFA covers this tier) that the password's separate
          two-factor can safely be turned off here any time, independent of
          the one-time guided offer that may have already covered this. */}
      {discordOAuthConfigured && <p className="muted settings-password-fallback-note">
        This password is Discord sign-in&apos;s break-glass fallback if it&apos;s ever unavailable &mdash; make sure whoever manages Discord access also knows it.
        {secondFactorEnrolled && <> Discord sign-in already requires its own two-factor for your role, you can safely turn off this password-based two-factor below any time.</>}
      </p>}
      <div className={`playerAdmin_toggle settings-login-password-toggle ${loginPasswordOpen ? "open" : ""}`}>
        <button className="playerAdmin_toggleHeader" aria-label={loginPasswordOpen ? "Collapse Login Password" : "Expand Login Password"} onClick={() => setLoginPasswordOpen(!loginPasswordOpen)}>{loginPasswordOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Login Password{discordOAuthConfigured ? " (fallback)" : ""}</span></button>
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
          {totpDisableZeroFactorWarning && <div className="settings-zero-factor-warning attention-text">
            <p>Disabling this will leave your console with no two-factor authentication anywhere &mdash; Discord sign-in doesn&apos;t require Discord&apos;s own two-factor for your role.</p>
            <p className="muted">You can turn on &ldquo;Require Discord two-factor for Owner and Admin&rdquo; from the Discord OAuth section above (Change application credentials) if you&apos;d like to keep two-factor active another way.</p>
            <div className="action-row">
              <button className="danger" disabled={totpDisableSaving} onClick={() => { void disableTwoFactor(true); }}>{totpDisableSaving ? "Disabling..." : "Disable anyway"}</button>
              <button type="button" className="login-password-toggle" onClick={() => setTotpDisableZeroFactorWarning(false)}>Cancel</button>
            </div>
          </div>}
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
          {/* #676 §8: contextual copy for a Discord-authenticated session --
              this is the password credential's OWN 2FA, unrelated to Discord
              sign-in, and this session may not know the password at all. */}
          {discordSessionActing && <p className="muted">This protects the console&apos;s separate password login. Don&apos;t know it? Check <code>runtime/secrets/admin-web-password.txt</code> on the host, or ask whoever manages the server.</p>}
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
  </>;

  // #676 §6: the tri-state Discord OAuth section -- the embedded wizard
  // (#643) when configured-and-active or never-configured, a compact banner
  // with Re-enable/Forget when soft-disabled.
  const discordOAuthSection = discordOAuthDisabled ? <div className="playerAdmin_toggle open settings-discord-disabled-banner">
      <div className="playerAdmin_toggleBody">
        <p><strong>Discord Sign-In (disabled)</strong></p>
        <p className="muted">Your Discord application&apos;s settings are kept, not deleted &mdash; re-enable any time.</p>
        <div className="action-row">
          <button disabled={discordEnableSaving} onClick={() => { void enableDiscordOAuth(); }}>{discordEnableSaving ? "Re-enabling..." : "Re-enable Discord Sign-In"}</button>
          {discordEnableResult && <span className={`inline-task-result result-${discordEnableResult.status === "succeeded" ? "ok" : discordEnableResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={discordEnableResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(discordEnableResult.title, discordEnableResult.status === "running")}</strong>
            {discordEnableResult.message && <span className="inline-task-message">{formatResultMessage(discordEnableResult.message)}</span>}
          </span>}
        </div>
        <hr className="auto-update-settings-divider" />
        <button type="button" className="login-password-toggle" onClick={() => setDiscordForgetOpen(!discordForgetOpen)}>{discordForgetOpen ? "Hide" : "Forget this configuration entirely"}</button>
        {discordForgetOpen && <div className="settings-discord-forget-form">
          <p className="attention-text">Permanently deletes the Client Secret and every saved field (guild, role mapping, MFA requirement). This cannot be undone from here &mdash; you would need to reconfigure from scratch, including generating a new Client Secret in Discord&apos;s Developer Portal.</p>
          <div className="settings-password-grid">
            <label htmlFor="settings-discord-forget-password">Password (to confirm it&apos;s you)<SecretInput id="settings-discord-forget-password" name="settings-discord-forget-password" disabled={discordForgetSaving} value={discordForgetPassword} onChange={(event) => setDiscordForgetPassword(event.target.value)} placeholder="Your login password" /></label>
            {secondFactorEnrolled && <label htmlFor="settings-discord-forget-code">Authenticator Code (to confirm it&apos;s you)<input
              id="settings-discord-forget-code"
              name="settings-discord-forget-code"
              disabled={discordForgetSaving}
              value={discordForgetTotpCode}
              onChange={(event) => setDiscordForgetTotpCode(stripCodeWhitespace(event.target.value))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="Current 6-digit code"
            /></label>}
            <label htmlFor="settings-discord-forget-confirm">Type &ldquo;forget&rdquo; to confirm<input id="settings-discord-forget-confirm" name="settings-discord-forget-confirm" disabled={discordForgetSaving} value={discordForgetConfirmText} onChange={(event) => setDiscordForgetConfirmText(event.target.value)} placeholder="forget" /></label>
          </div>
          <div className="action-row">
            <button className="danger" disabled={discordForgetSaving || discordForgetConfirmText.trim().toLowerCase() !== "forget" || !discordForgetPassword || (secondFactorEnrolled && !discordForgetTotpCode.trim())} onClick={() => { void forgetDiscordOAuth(); }}>{discordForgetSaving ? "Forgetting..." : "Forget This Configuration Entirely"}</button>
            {discordForgetResult && <span className={`inline-task-result result-${discordForgetResult.status === "succeeded" ? "ok" : discordForgetResult.status === "failed" ? "fail" : "running"}`}>
              <strong className={discordForgetResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(discordForgetResult.title, discordForgetResult.status === "running")}</strong>
              {discordForgetResult.message && <span className="inline-task-message">{formatResultMessage(discordForgetResult.message)}</span>}
            </span>}
          </div>
        </div>}
      </div>
    </div> : <div className={`playerAdmin_toggle ${discordOAuthOpen ? "open" : ""}`}>
      {/* #643: replaces the old manual Client ID/Secret/roles form with the
          same guided wizard the pre-login flow uses -- full replacement, no
          "keep both forms" fallback (design decision, discord-settings-embed
          L1 design §6). onDone/onCancel just collapse this accordion; unlike
          the pre-login flow, reconfiguring from an already-authenticated
          session never forces a logout (see the wizard's own embedded-mode
          handling, #643 §4.1). */}
      <button className="playerAdmin_toggleHeader" aria-label={discordOAuthOpen ? "Collapse Discord OAuth" : "Expand Discord OAuth"} onClick={() => setDiscordOAuthOpenOverride(!discordOAuthOpen)}>{discordOAuthOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Discord OAuth</span></button>
      {discordOAuthOpen && <div className="playerAdmin_toggleBody settings-discord-wizard-embed">
        <DiscordSetupWizard
          embedded
          onCancel={() => setDiscordOAuthOpenOverride(false)}
          onDone={() => { setDiscordOAuthOpenOverride(false); void refresh(); }}
        />
        {/* #676 §6: only once there is something to disable -- "never
            configured" shows just the wizard, no danger action. */}
        {discordOAuthConfigured && <>
          <hr className="auto-update-settings-divider" />
          <button type="button" className="login-password-toggle" onClick={() => setDiscordDisableOpen(!discordDisableOpen)}>{discordDisableOpen ? "Hide" : "Disable Discord Sign-In"}</button>
          {discordDisableOpen && <div className="settings-discord-disable-form">
            <p className="attention-text">Discord sign-in will stop working as soon as the console restarts. Your application&apos;s settings are kept, not deleted.</p>
            <div className="settings-password-grid">
              <label htmlFor="settings-discord-disable-password">Password (to confirm it&apos;s you)<SecretInput id="settings-discord-disable-password" name="settings-discord-disable-password" disabled={discordDisableSaving} value={discordDisablePassword} onChange={(event) => setDiscordDisablePassword(event.target.value)} placeholder="Your login password" /></label>
              {secondFactorEnrolled && <label htmlFor="settings-discord-disable-code">Authenticator Code (to confirm it&apos;s you)<input
                id="settings-discord-disable-code"
                name="settings-discord-disable-code"
                disabled={discordDisableSaving}
                value={discordDisableTotpCode}
                onChange={(event) => setDiscordDisableTotpCode(stripCodeWhitespace(event.target.value))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="Current 6-digit code"
              /></label>}
            </div>
            <div className="action-row">
              <button className="danger" disabled={discordDisableSaving || !discordDisablePassword || (secondFactorEnrolled && !discordDisableTotpCode.trim())} onClick={() => { void disableDiscordOAuth(); }}>{discordDisableSaving ? "Disabling..." : "Disable Discord Sign-In"}</button>
              {discordDisableResult && <span className={`inline-task-result result-${discordDisableResult.status === "succeeded" ? "ok" : discordDisableResult.status === "failed" ? "fail" : "running"}`}>
                <strong className={discordDisableResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(discordDisableResult.title, discordDisableResult.status === "running")}</strong>
                {discordDisableResult.message && <span className="inline-task-message">{formatResultMessage(discordDisableResult.message)}</span>}
              </span>}
            </div>
          </div>}
        </>}
      </div>}
    </div>;

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
      {/* #676 §3: Discord OAuth is primary (rendered first) once configured
          and active; Password Sign-In is primary otherwise -- including when
          Discord OAuth is soft-disabled, per the design's own "reverts to
          primary" rule for that state. */}
      {discordOAuthConfigured && !discordOAuthDisabled
        ? <>{discordOAuthSection}{passwordSignInSection}</>
        : <>{passwordSignInSection}{discordOAuthSection}</>}
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
