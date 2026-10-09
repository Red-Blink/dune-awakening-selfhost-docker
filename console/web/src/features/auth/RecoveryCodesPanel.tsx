import type { ReactNode } from "react";

type RecoveryCodesPanelProps = {
  codes: string[];
  /**
   * Heading level for the caller's document outline. The login screen is a
   * full-page takeover and owns an `h1`; the settings section sits under the
   * panel's own `h2`, so it needs `h3` -- emitting `h1` there produced a second
   * page-level heading nested under an h2 (an inverted outline, WCAG 1.3.1),
   * which no lint in console/web would have caught.
   */
  headingLevel?: "h1" | "h3";
  heading: string;
  intro: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  acknowledged: boolean;
  onAcknowledgedChange: (next: boolean) => void;
};

/**
 * The "here are your recovery codes, confirm you saved them" gate (RFC §4).
 *
 * Shared deliberately between first-time enrollment / recovery re-setup
 * (TotpSetupScreen) and the settings-panel regenerate action, so the two
 * cannot drift into saying different things about codes that are shown exactly
 * once and are unrecoverable afterwards. The surrounding chrome differs (a
 * full-screen login panel vs. an inline settings section), so only the codes +
 * acknowledgment block lives here.
 */
export function RecoveryCodesPanel({
  codes,
  heading,
  intro,
  confirmLabel,
  onConfirm,
  acknowledged,
  onAcknowledgedChange,
  headingLevel = "h1",
}: RecoveryCodesPanelProps) {
  const Heading = headingLevel;
  return (
    <>
      <Heading className="recovery-codes-heading">{heading}</Heading>
      <p>{intro}</p>
      <ul className="totp-recovery-codes-list">
        {codes.map((recoveryCode) => <li key={recoveryCode}><code>{recoveryCode}</code></li>)}
      </ul>
      <label className="totp-ack-checkbox">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => onAcknowledgedChange(event.target.checked)}
        />
        I have saved these codes somewhere safe
      </label>
      <button type="button" disabled={!acknowledged} onClick={onConfirm}>{confirmLabel}</button>
    </>
  );
}
