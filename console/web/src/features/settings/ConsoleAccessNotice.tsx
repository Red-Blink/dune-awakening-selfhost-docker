import { useState } from "react";
import { InlineActionResult, type InlineActionResultState } from "../../components/common/InlineActionResult";
import { post } from "../../api/client";

export type ConsoleAccessStatus = {
  pending: boolean; configuredCount: number; activeCount: number;
  canConfirm: boolean; fingerprint: string; recovery: string;
};
type Props = {
  status?: ConsoleAccessStatus;
  confirmAction: (message: string, options?: { title?: string; confirmLabel?: string; danger?: boolean }) => Promise<boolean>;
  onConfirmed: () => Promise<void>;
};
export function ConsoleAccessNotice({ status, confirmAction, onConfirmed }: Props) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<InlineActionResultState | null>(null);
  if (!status?.pending) return null;
  async function confirm() {
    if (!status || !(await confirmAction(
      "Activate the IP restrictions configured in .env? Only listed addresses will be able to open the Console. Make sure every administrator's address is included and that you have SSH access for recovery.",
      { title: "Confirm Console Access", confirmLabel: "Activate Restrictions", danger: true }
    ))) return;
    setBusy(true);
    setResult(null);
    try {
      await post("/api/settings/console-access/confirm", { confirmed: true, fingerprint: status.fingerprint });
      await onConfirmed();
    } catch (error) {
      setResult({ key: "access", tone: "danger", text: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(false); }
  }
  return <div className="playerAdmin_toggle open" role="region" aria-label="Console Access Review">
    <div className="playerAdmin_toggleBody">
      <strong>Review Console IP Restrictions</strong>
      <p className="attention-text">{status.activeCount
        ? "Updated IP restrictions await confirmation. Your current restrictions remain active."
        : "Your existing IP setting was not active before this update. Console access has been preserved until you confirm it."}</p>
      {!status.canConfirm && <p className="muted">Activation is blocked because these restrictions would exclude your current connection or contain an invalid address. Correct the setting using SSH first.</p>}
      <div className="action-row">
        <button disabled={busy || !status.canConfirm} onClick={() => { void confirm(); }}>{busy ? "Activating..." : "Review And Activate"}</button>
        <InlineActionResult result={result} resultKey="access" />
      </div>
      <details><summary>SSH Recovery</summary><p className="muted">{status.recovery}</p></details>
    </div>
  </div>;
}
