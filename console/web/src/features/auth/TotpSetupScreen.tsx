import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { post, setCsrfToken } from "../../api/client";
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
  onComplete: (authenticated?: boolean) => void;
  presentation?: "page" | "dialog";
  // Distinct from onComplete: fires from the "Back to sign in" escape hatch,
  // before any factor has been confirmed. Both currently reset the same App
  // state, but are kept separate since only onComplete implies the factor
  // was actually set up (L2 audit: Architect/Security hats found the setup
  // screen had no way back to plain login if a setup/confirm call failed
  // with a message the client's session-expiry detection doesn't recognize
  // -- rather than trying to enumerate every such message, a visible,
  // always-available way out fixes the dead end unconditionally).
  onCancel: (authenticated?: boolean) => void;
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
  authenticated?: boolean;
  csrfToken?: string;
}

// RFC §2.3: "After 3 consecutive failed TOTP entries in one session, the
// error message must name the most common real cause -- device clock skew."
const CLOCK_SKEW_THRESHOLD = 3;
const CLOCK_SKEW_MESSAGE =
  "That code was not accepted, and this has failed a few times in a row -- the most common cause is your device's clock being out of sync. Check that your phone or authenticator app has automatic time set on, then try the current code again.";

export function TotpSetupScreen({ mode, onComplete, onCancel, presentation = "page" }: TotpSetupScreenProps) {
  const dialog = presentation === "dialog";
  const Heading = dialog ? "h3" : "h1";
  const dialogRef = useRef<HTMLElement>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [failureCount, setFailureCount] = useState(0);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => { document.body.style.overflow = overflow; previous?.focus(); };
  }, [dialog]);

  async function cancel() {
    if (confirming || recoveryCodes) return;
    if (!dialog) { onCancel(); return; }
    setConfirming(true);
    try {
      const result = await post<{ csrfToken: string }>("/api/auth/2fa/cancel");
      setCsrfToken(result.csrfToken);
      onCancel(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setConfirming(false); }
  }

  function layout(content: ReactNode) {
    if (!dialog) return <main className="login-screen">{content}</main>;
    return <div className="modal-overlay totp-enrollment-overlay">
      <section className="confirm-modal totp-enrollment-dialog" role="dialog" aria-modal="true" aria-labelledby="totp-dialog-title" ref={dialogRef} tabIndex={-1} onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); void cancel(); }
        if (event.key === "Tab") {
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href]')];
          const first = controls[0], last = controls.at(-1);
          if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
        <div className="confirm-modal-title"><h2 id="totp-dialog-title">Enable 2FA</h2>{!recoveryCodes && <button type="button" className="icon-action" aria-label="Cancel 2FA setup" disabled={confirming} onClick={() => { void cancel(); }}><X size={18} /></button>}</div>
        {content}
      </section>
    </div>;
  }

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
      if (result.csrfToken) setCsrfToken(result.csrfToken);
      setAuthenticated(Boolean(result.authenticated));
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
    return layout(
        <section className={dialog ? "totp-dialog-content" : "login-panel totp-recovery-codes-panel"}>
          <RecoveryCodesPanel
            codes={recoveryCodes}
            heading="Save your recovery codes"
            intro="These 10 codes are shown once, right now. If you ever lose your authenticator, use one of these (with your password) to sign back in. Each code works only once."
            confirmLabel={dialog && authenticated ? "Done" : "Continue to sign in"}
            onConfirm={() => onComplete(authenticated)}
            headingLevel={dialog ? "h3" : "h1"}
            acknowledged={acknowledged}
            onAcknowledgedChange={setAcknowledged}
          />
        </section>
    );
  }

  return layout(
      <form className={dialog ? "totp-dialog-content" : "login-panel"} onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
        <Heading>{mode === "resetup" ? "Set up a new authenticator" : "Set up two-factor authentication"}</Heading>
        <p>
          {mode === "resetup"
            ? "Your previous authenticator and recovery codes no longer work. Scan the new code below with your authenticator app, then enter the 6-digit code it shows."
            : "Scan the QR code with your authenticator app, then enter its current 6-digit code."}
        </p>
        {/* RFC §4: a restarted/reloaded setup always regenerates the secret,
            so any previously scanned QR for this console is dead -- true on
            a genuine restart and harmlessly redundant on a first attempt. */}
        <p className="totp-setup-restart-note">
          Replace any authenticator entry from an earlier setup attempt with the QR code shown here.
        </p>
        {setup ? (
          <>
            <img className="totp-setup-qr" src={setup.qrCodeDataUri} alt="Authenticator QR code" />
            <p className="totp-setup-secret-label">Can't scan? Enter this code manually:</p>
            <code className="totp-setup-secret">{setup.secret}</code>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="Authenticator Code"
              maxLength={6}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="6-digit code"
              autoFocus
            />
            <button type="submit" className={dialog ? "" : "login-primary-button"} disabled={confirming}>Confirm</button>
          </>
        ) : !error ? (
          <p className="loading-dots">Loading setup</p>
        ) : null}
        {error && <p className="error">{error}</p>}
        <button type="button" className="login-password-toggle" disabled={confirming} onClick={() => { void cancel(); }}>{dialog ? "Cancel" : "Back to sign in"}</button>
        {dialog && /sign in again|no longer signed in|session expired/i.test(error) && <button type="button" onClick={() => onCancel(false)}>Sign In Again</button>}
      </form>
  );
}
