import { useEffect, useRef, useState } from "react";
import { backupsApi, formatSavedAt, scheduledPruneCount } from "../../api/backups";
import type { SystemAutoStatus } from "../../api/backups";
import type { Task } from "../../api/setup";
import { KeyValueGrid } from "../../components/common/DisplayPrimitives";
import { conciseTaskError } from "../../lib/taskDisplay";

type InlineResult = { status: "running" | "succeeded" | "failed"; title: string; message?: string };

type SystemBackupScheduleCardProps = {
  disabled: boolean;
  setBusy: (busy: boolean) => void;
  waitForTask: (task: Task) => Promise<Task>;
  toHourMinuteTime: (value: unknown) => string;
  sanitizeTimeInput: (value: string) => string;
  isValidHourMinuteTime: (value: string) => boolean;
  // Bumped by the panel whenever the archive list changes, so the stored count
  // behind the keep preview stays current.
  refreshToken: unknown;
  onStatus: (status: SystemAutoStatus) => void;
};

const KEEP_MIN = 1;
const KEEP_MAX = 365;

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) bytes = 0;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${(bytes > 0 ? Math.max(0.1, bytes / 1024 ** 2) : 0).toFixed(1)} MB`;
}

function resultClass(result: InlineResult) {
  return `inline-task-result result-${result.status === "succeeded" ? "ok" : result.status === "failed" ? "fail" : "running"}`;
}

export function SystemBackupScheduleCard({ disabled, setBusy, waitForTask, toHourMinuteTime, sanitizeTimeInput, isValidHourMinuteTime, refreshToken, onStatus }: SystemBackupScheduleCardProps) {
  const [status, setStatus] = useState<SystemAutoStatus>({});
  const [loadError, setLoadError] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [time, setTime] = useState("04:30");
  const [intervalHours, setIntervalHours] = useState("24");
  const [keep, setKeep] = useState("7");
  const [passphrase, setPassphrase] = useState("");
  const [passphraseConfirm, setPassphraseConfirm] = useState("");
  const [passphraseResult, setPassphraseResult] = useState<InlineResult | null>(null);
  const [scheduleResult, setScheduleResult] = useState<InlineResult | null>(null);
  const [working, setWorking] = useState(false);
  const busy = disabled || working;
  const saved = Boolean(status.passphraseSaved);

  async function refresh(syncForm: boolean) {
    try {
      const result = await backupsApi.systemAutoStatus();
      const next = result.status || {};
      setStatus(next);
      setLoadError(next.ok === false ? next.reason || "Scheduled system backup status is unavailable." : "");
      onStatus(next);
      if (syncForm) {
        setEnabled(Boolean(next.enabled));
        if (next.backupTime) setTime(toHourMinuteTime(next.backupTime));
        if (next.intervalHours) setIntervalHours(String(next.intervalHours));
        if (next.keep) setKeep(String(next.keep));
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }

  // The form syncs from the server on mount only. Later list refreshes (after a
  // create, delete or restore) update the counts without discarding unsaved edits.
  const loadedRef = useRef(false);
  useEffect(() => {
    const first = !loadedRef.current;
    loadedRef.current = true;
    void refresh(first);
    // refresh is recreated every render; the token is what should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  async function withWork(action: () => Promise<void>) {
    setWorking(true);
    setBusy(true);
    try {
      await action();
    } finally {
      setWorking(false);
      setBusy(false);
    }
  }

  async function savePassphrase() {
    // Mirrors the server's floor so this fails before a round trip.
    let problem = "";
    if (passphrase.length < 12) problem = "The passphrase must be at least 12 characters.";
    else if (new Set(passphrase).size < 5) problem = "The passphrase must use at least 5 different characters.";
    else if (passphrase !== passphraseConfirm) problem = "The two passphrases do not match.";
    if (problem) {
      setPassphraseResult({ status: "failed", title: "Passphrase Not Saved", message: problem });
      return;
    }
    await withWork(async () => {
      setPassphraseResult({ status: "running", title: "Saving Passphrase" });
      try {
        await backupsApi.saveSystemPassphrase(passphrase, passphraseConfirm);
        setPassphraseResult({ status: "succeeded", title: "Passphrase Saved" });
        await refresh(false);
      } catch (error) {
        setPassphraseResult({ status: "failed", title: "Passphrase Not Saved", message: error instanceof Error ? error.message : String(error) });
      } finally {
        // Cleared on failure too -- never leave a passphrase sitting in the DOM.
        setPassphrase("");
        setPassphraseConfirm("");
      }
    });
  }

  async function removePassphrase() {
    await withWork(async () => {
      setPassphraseResult({ status: "running", title: "Removing Passphrase" });
      try {
        await backupsApi.removeSystemPassphrase();
        setPassphraseResult({ status: "succeeded", title: "Passphrase Removed" });
        await refresh(false);
      } catch (error) {
        setPassphraseResult({ status: "failed", title: "Passphrase Not Removed", message: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  function keepValue() {
    const value = Number(keep);
    return Number.isInteger(value) && value >= KEEP_MIN && value <= KEEP_MAX ? value : null;
  }

  function stepKeep(delta: number) {
    const current = keepValue() ?? 7;
    setKeep(String(Math.min(KEEP_MAX, Math.max(KEEP_MIN, current + delta))));
  }

  async function saveSchedule(nextEnabled: boolean, fromSwitch = false) {
    const sanitizedTime = toHourMinuteTime(time);
    const hours = Number(intervalHours);
    const keepCount = keepValue();
    let fieldProblem = "";
    if (!isValidHourMinuteTime(sanitizedTime)) fieldProblem = "Backup time must be a valid 24-hour time, for example 04:30 or 23:15.";
    else if (!Number.isInteger(hours) || hours < 1 || hours > 168) fieldProblem = "Backup interval must be a whole number from 1 to 168 hours.";
    else if (keepCount === null) fieldProblem = "Keep must be a whole number from 1 to 365.";
    const problem = nextEnabled && !saved ? "Save a passphrase before turning on scheduled system backups." : fieldProblem;
    // Turning the switch off must always work: with a field mid-edit, send a
    // bare disable, which keeps the saved policy, rather than refusing.
    const bareDisable = !nextEnabled && fromSwitch && Boolean(fieldProblem);
    if (problem && !bareDisable) {
      setScheduleResult({ status: "failed", title: "Schedule Not Saved", message: problem });
      return;
    }
    await withWork(async () => {
      setScheduleResult({ status: "running", title: nextEnabled ? "Saving Schedule" : "Turning Off Schedule" });
      try {
        const response = await backupsApi.saveSystemAuto(bareDisable
          ? { enabled: false }
          : { enabled: nextEnabled, time: sanitizedTime, intervalHours: hours, keep: keepCount as number });
        const final = await waitForTask(response.task);
        if (final.status === "succeeded") {
          setEnabled(nextEnabled);
          setScheduleResult({ status: "succeeded", title: "Schedule Saved" });
        } else {
          setScheduleResult({ status: "failed", title: "Schedule Not Saved", message: conciseTaskError(final) });
        }
      } catch (error) {
        setScheduleResult({ status: "failed", title: "Schedule Not Saved", message: error instanceof Error ? error.message : String(error) });
      }
      await refresh(true);
    });
  }

  const count = Number(status.automaticCount || 0);
  const keepCount = keepValue();
  const total = keepCount === null ? 0 : scheduledPruneCount(count, keepCount);
  const remaining = keepCount === null ? 0 : Math.min(count + 1, keepCount);
  const averageBytes = count > 0 ? Number(status.automaticBytes || 0) / count : 0;
  const lastResult = status.lastResult || "";
  // Same vocabulary as the database Automatic Backups grid above it.
  const timerLabel = loadError ? "Unavailable" : enabled && /^(active|enabled)$/i.test(status.timer || "") ? "Active" : "Inactive";

  return <section className="action-section backup-system-schedule">
    <div className="panel-title">
      <h4>Automatic System Backups</h4>
      <label className={`switch-checkbox ${enabled ? "enabled" : "disabled"}`} title={!enabled && !saved ? "Save a passphrase first" : undefined}>
        <input type="checkbox" aria-label="Automatic System Backups" disabled={busy || (!enabled && !saved)} checked={enabled} onChange={(event) => void saveSchedule(event.target.checked, true)} />
        <span className="switch-label">Automatic System Backups</span>
        <strong className="switch-state">{enabled ? "ON" : "OFF"}</strong>
      </label>
    </div>
    <KeyValueGrid items={[
      ["Current Status", loadError ? "Unavailable" : enabled ? "Enabled" : "Disabled"],
      ["First Backup Time (Local Server Time)", toHourMinuteTime(status.backupTime || time)],
      ["Interval", `Every ${status.intervalHours || intervalHours || 24} hours`],
      ["Keep", `Newest ${status.keep || keep}`],
      ["Timer", timerLabel],
      ["Last Run", status.lastRunAt ? `${formatSavedAt(status.lastRunAt)} · ${lastResult || "unknown"}` : "Never"],
      ["Next Run", status.nextRun || ""],
      ["Last Message", status.lastMessage || ""]
    ]} />
    {loadError && <p className="danger-note">{loadError}</p>}
    {!saved && !loadError && <p className="backup-group-note">Save a passphrase below before turning on automatic system backups.</p>}
    <div className="action-line backup-auto-controls">
      <label className="compact-select">First Backup Time<input type="time" step="60" pattern="[0-2][0-9]:[0-5][0-9]" value={time} disabled={busy} onChange={(event) => setTime(sanitizeTimeInput(event.target.value))} placeholder="04:30" /></label>
      <label className="memory-number-field">Repeat Every<span className="backup-number-unit"><input type="number" min="1" max="168" step="1" value={intervalHours} disabled={busy} onChange={(event) => setIntervalHours(event.target.value)} /><span>Hours</span></span></label>
      <div className="memory-number-field backup-keep-field">
        <span id="system-backup-keep-label">Keep Newest</span>
        <span className="backup-keep-stepper">
          <button type="button" aria-label="Keep one fewer" disabled={busy || (keepValue() ?? KEEP_MIN) <= KEEP_MIN} onClick={() => stepKeep(-1)}>−</button>
          <input type="number" aria-labelledby="system-backup-keep-label" min={KEEP_MIN} max={KEEP_MAX} step="1" value={keep} disabled={busy} onChange={(event) => setKeep(event.target.value)} />
          <button type="button" aria-label="Keep one more" disabled={busy || (keepValue() ?? KEEP_MAX) >= KEEP_MAX} onClick={() => stepKeep(1)}>+</button>
        </span>
      </div>
      <button disabled={busy || (!enabled && !saved)} title={!enabled && !saved ? "Save a passphrase first" : undefined} onClick={() => void saveSchedule(enabled)}>Save Settings</button>
      {scheduleResult && <span className={resultClass(scheduleResult)}>
        <strong className={scheduleResult.status === "running" ? "loading-dots" : ""}>{scheduleResult.title}</strong>
        {scheduleResult.message && <span> {scheduleResult.message}</span>}
      </span>}
    </div>
    {keepCount === null
      ? <p className="danger-note">Keep must be a whole number from 1 to 365.</p>
      : <p className="muted backup-keep-preview" aria-live="polite">
        <span>{`Automatic archives stored: ${count}. The next run removes ${total} and keeps ${remaining}`}</span>
        {averageBytes > 0 && <span data-no-translate>{` (${formatBytes(averageBytes * remaining)})`}</span>}.{" "}
        <span>Only automatic archives count. Manual and imported archives are never removed by this setting. Saving deletes nothing now; the next scheduled run prunes.</span>
      </p>}

    <div className="backup-schedule-block">
      <div className="panel-title"><h5>Saved Passphrase</h5><span className={saved ? "badge badge-pass" : "badge"}>{saved ? "Saved" : "Not Saved"}</span></div>
      {saved && status.passphraseSavedAt && <p className="muted">Saved <span data-no-translate>{formatSavedAt(status.passphraseSavedAt)}</span></p>}
      <p className="backup-group-note">
        Automatic backups can't ask for a passphrase, so they use the one saved here. It is stored on this host with owner-only permissions, is never placed inside an archive, and cannot be read back. Only the Owner role can save, replace or remove it.
      </p>
      {saved && <p className="backup-group-note backup-note-warning">Replacing it does not re-encrypt older archives. They still need the passphrase they were made with.</p>}
      <label className="wide-field">{saved ? "New Automatic Backup Passphrase" : "Automatic Backup Passphrase"}<input type="password" autoComplete="new-password" value={passphrase} disabled={busy} onChange={(event) => setPassphrase(event.target.value)} /></label>
      <label className="wide-field">Confirm Automatic Backup Passphrase<input type="password" autoComplete="new-password" value={passphraseConfirm} disabled={busy} onChange={(event) => setPassphraseConfirm(event.target.value)} /></label>
      <div className="action-line backup-group-actions">
        <button disabled={busy || !passphrase || !passphraseConfirm} onClick={() => void savePassphrase()}>{saved ? "Replace Passphrase" : "Save Passphrase"}</button>
        {saved && <button className="danger" disabled={busy || enabled} title={enabled ? "Turn off automatic system backups first" : undefined} onClick={() => void removePassphrase()}>Remove Passphrase</button>}
        {passphraseResult && <span className={resultClass(passphraseResult)}>
          <strong className={passphraseResult.status === "running" ? "loading-dots" : ""}>{passphraseResult.title}</strong>
          {passphraseResult.message && <span> {passphraseResult.message}</span>}
        </span>}
      </div>
    </div>
  </section>;
}
