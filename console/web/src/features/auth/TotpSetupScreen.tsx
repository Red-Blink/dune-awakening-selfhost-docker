import { useEffect, useState } from "react";
import { post } from "../../api/client";
import { RecoveryCodesPanel } from "./RecoveryCodesPanel";

// Tier 3 enrollment/re-setup screen (RFC docs/rfc-console-auth.md §4/§2.3).
// Shown after a login response carries enrollmentRequired (first post-upgrade
// password login, no second factor configured yet) or resetupRequired (a
// successful recovery-code login -- the old authenticator is presumed lost).
// Both modes drive the same two server endpoints (/api/auth/2fa/setup then
// /api/auth/2fa/confirm); they differ only in copy and in what the server
// does with the confirmed secret (enroll = create-if-absent, resetup =
// overwrite + fresh recovery codes), which is entirely the server's concern.

interface TotpSetupScreenProps {
  mode: "enroll" | "resetup";
  onComplete: () => void;
  // Distinct from onComplete: fires from the "Back to sign in" escape hatch,
  // before any factor has been confirmed. Both currently reset the same App
  // state, but are kept separate since only onComplete implies the factor
  // was actually set up (L2 audit: Architect/Security hats found the setup
  // screen had no way back to plain login if a setup/confirm call failed
  // with a message the client's session-expiry detection doesn't recognize
  // -- rather than trying to enumerate every such message, a visible,
  // always-available way out fixes the dead end unconditionally).
  onCancel: () => void;
}

interface SetupResponse {
  secret: string;
  otpauthUri: string;
  qrCodeDataUri: string;
}

interface ConfirmResponse {
  enrolled?: boolean;
  reconfigured?: boolean;
  recoveryCodes: string[];
}

// RFC §2.3: "After 3 consecutive failed TOTP entries in one session, the
// error message must name the most common real cause -- device clock skew."
const CLOCK_SKEW_THRESHOLD = 3;
const CLOCK_SKEW_MESSAGE =
  "That code was not accepted, and this has failed a few times in a row -- the most common cause is your device's clock being out of sync. Check that your phone or authenticator app has automatic time set on, then try the current code again.";

export function TotpSetupScreen({ mode, onComplete, onCancel }: TotpSetupScreenProps) {
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [failureCount, setFailureCount] = useState(0);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await post<SetupResponse>("/api/auth/2fa/setup");
        if (!cancelled) setSetup(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function confirm() {
    setError("");
    setConfirming(true);
    try {
      const result = await post<ConfirmResponse>("/api/auth/2fa/confirm", { code });
      setRecoveryCodes(result.recoveryCodes);
    } catch (err) {
      const nextFailureCount = failureCount + 1;
      setFailureCount(nextFailureCount);
      const message = err instanceof Error ? err.message : String(err);
      setError(nextFailureCount >= CLOCK_SKEW_THRESHOLD ? CLOCK_SKEW_MESSAGE : message);
    } finally {
      setConfirming(false);
    }
  }

  if (recoveryCodes) {
    return (
      <main className="login-screen">
        <section className="login-panel totp-recovery-codes-panel">
          <RecoveryCodesPanel
            codes={recoveryCodes}
            heading="Save your recovery codes"
            intro="These 10 codes are shown once, right now. If you ever lose your authenticator, use one of these (with your password) to sign back in. Each code works only once."
            confirmLabel="Continue to sign in"
            onConfirm={onComplete}
            acknowledged={acknowledged}
            onAcknowledgedChange={setAcknowledged}
          />
        </section>
      </main>
    );
  }

  return (
    <main className="login-screen">
      <form className="login-panel" onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
        <h1>{mode === "resetup" ? "Set up a new authenticator" : "Set up two-factor authentication"}</h1>
        <p>
          {mode === "resetup"
            ? "Your previous authenticator and recovery codes no longer work. Scan the new code below with your authenticator app, then enter the 6-digit code it shows."
            : "This console now requires an authenticator app. Scan the code below with an app like Google Authenticator or Authy, then enter the 6-digit code it shows."}
        </p>
        {/* RFC §4: a restarted/reloaded setup always regenerates the secret,
            so any previously scanned QR for this console is dead -- true on
            a genuine restart and harmlessly redundant on a first attempt. */}
        <p className="totp-setup-restart-note">
          If you scanned a QR code for this console before, delete that entry from your
          authenticator now -- it is no longer valid.
        </p>
        {setup ? (
          <>
            <img className="totp-setup-qr" src={setup.qrCodeDataUri} alt="Authenticator QR code" />
            <p className="totp-setup-secret-label">Can't scan? Enter this code manually:</p>
            <code className="totp-setup-secret">{setup.secret}</code>
            <input
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="6-digit code"
              autoFocus
            />
            <button type="submit" className="login-primary-button" disabled={confirming}>Confirm</button>
          </>
        ) : !error ? (
          <p className="loading-dots">Loading setup</p>
        ) : null}
        {error && <p className="error">{error}</p>}
        <button type="button" className="login-password-toggle" onClick={onCancel}>Back to sign in</button>
      </form>
    </main>
  );
}
