import { useEffect, useRef, useState } from "react";
import { backupsApi } from "../../api/backups";
import type { Task } from "../../api/setup";
import { DataTable } from "../../components/common/DataTable";
import { KeyValueGrid, StatusPill, TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { formatUiSentence } from "../../lib/display";
import { conciseTaskError, funcomTokenMismatchDetected } from "../../lib/taskDisplay";

type BackupResult = { status: "running" | "succeeded" | "failed"; title: string; message?: string; details?: string; tone?: "danger" | "attention" };
type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] }) => Promise<boolean>;
type CommandStatus = { status: string; reason?: string };

type BackupsPanelProps = {
  backupRestoreTask: Task | null;
  setBackupRestoreTask: (task: Task | null) => void;
  onError: (text: string) => void;
  confirmAction: ConfirmAction;
  waitForTask: (task: Task) => Promise<Task>;
  waitForTaskWithUpdates: (task: Task, onUpdate: (task: Task) => void) => Promise<Task>;
  withTimeout: <T>(promise: Promise<T>, timeoutMs: number, message: string) => Promise<T>;
  toHourMinuteTime: (value: unknown) => string;
  sanitizeTimeInput: (value: string) => string;
  isValidHourMinuteTime: (value: string) => boolean;
  commandStatusSummary: (result: { stdout?: string; stderr?: string; exitCode?: number } | null) => CommandStatus;
  taskTechnicalDetails: (task: Task) => string;
  isTerminalTask: (status: string) => boolean;
};

function formatResultTitle(value: unknown, pending = false) {
  return formatUiSentence(value, pending);
}

function formatResultMessage(value: unknown) {
  return formatUiSentence(value, false);
}

export function BackupsPanel({ backupRestoreTask, setBackupRestoreTask, onError, confirmAction, waitForTask, waitForTaskWithUpdates, withTimeout, toHourMinuteTime, sanitizeTimeInput, isValidHourMinuteTime, commandStatusSummary, taskTechnicalDetails, isTerminalTask }: BackupsPanelProps) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(true);
  const [autoBackup, setAutoBackup] = useState<{ stdout?: string; stderr?: string; exitCode?: number } | null>(null);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoTime, setAutoTime] = useState("05:00");
  const [autoIntervalHours, setAutoIntervalHours] = useState("24");
  const [autoRetentionDays, setAutoRetentionDays] = useState("0");
  const [backupResult, setBackupResult] = useState<BackupResult | null>(null);
  const [autoResult, setAutoResult] = useState<BackupResult | null>(null);
  const [importResult, setImportResult] = useState<BackupResult | null>(null);
  const [importBackupFile, setImportBackupFile] = useState<File | null>(null);
  const [importMetadataFile, setImportMetadataFile] = useState<File | null>(null);
  const importBackupInputRef = useRef<HTMLInputElement | null>(null);
  const importMetadataInputRef = useRef<HTMLInputElement | null>(null);
  const backupsRefreshRef = useRef<Promise<void> | null>(null);
  const [busyAction, setBusyAction] = useState("");
  const autoStatus = (autoBackup as { status?: Record<string, unknown> } | null)?.status || {};
  const autoTimerValue = String(autoStatus.timer || "");
  const autoTimerActive = autoEnabled && /^(active|enabled)$/i.test(autoTimerValue);
  const autoTimerLabel = commandStatusSummary(autoBackup).reason
    ? "Unavailable"
    : busyAction === "auto" && autoResult?.status === "running"
      ? autoEnabled ? "Activating" : "Deactivating"
      : autoTimerActive ? "Active" : "Inactive";
  async function run(action: () => Promise<unknown>) {
    onError("");
    try { await action(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  async function refreshAutoBackup() {
    const result = await backupsApi.autoStatus();
    setAutoBackup(result);
    const status = result.status || {};
    setAutoEnabled(Boolean(status.enabled));
    if (status.backupTime) setAutoTime(toHourMinuteTime(status.backupTime));
    if (status.intervalHours) setAutoIntervalHours(String(status.intervalHours));
    if (status.retentionDays !== undefined) setAutoRetentionDays(String(status.retentionDays || "0"));
  }
  async function refresh() {
    if (backupsRefreshRef.current) return backupsRefreshRef.current;
    setBackupsLoading(true);
    backupsRefreshRef.current = (async () => {
      const result = await withTimeout(backupsApi.list(), 60000, "Loading backups timed out.");
      setRows(result.rows?.length ? result.rows : parseBackupRows(result.stdout || ""));
      try {
        await withTimeout(refreshAutoBackup(), 60000, "Loading automatic backup status timed out.");
      } catch (error) {
        setAutoBackup({ exitCode: 1, stderr: error instanceof Error ? error.message : String(error) });
      }
    })().finally(() => {
      backupsRefreshRef.current = null;
      setBackupsLoading(false);
    });
    return backupsRefreshRef.current;
  }
  async function runBackupTask(action: "create" | "delete" | "deleteAll" | "restore" | "auto", taskFactory: () => Promise<{ task: Task }>, successTitle: string, failureTitle: string) {
    setBusyAction(action);
    const setter = action === "auto" ? setAutoResult : setBackupResult;
    setter({ status: "running", title: action === "restore" ? "Restoring Backup..." : action === "delete" || action === "deleteAll" ? "Deleting Backup..." : action === "auto" ? "Saving Automatic Backup Settings..." : "Creating Backup..." });
    try {
      const response = await taskFactory();
      const final = action === "restore" ? await waitForTaskWithUpdates(response.task, setBackupRestoreTask) : await waitForTask(response.task);
      const result = action === "restore" ? backupRestoreTaskResult(final) : summarizeBackupTask(final, successTitle, failureTitle);
      if (action === "restore" && isTerminalTask(final.status)) setBackupRestoreTask(null);
      setter((final.status === "succeeded" && (action === "delete" || action === "deleteAll")) ? { ...result, tone: "danger" } : result);
      if (final.status === "succeeded") await refresh();
      return final;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setter({ status: "failed", title: failureTitle, message: reason });
      onError(reason);
      return null;
    } finally {
      setBusyAction("");
    }
  }
  async function saveAutomaticBackups(nextEnabled = autoEnabled) {
    const sanitizedTime = toHourMinuteTime(autoTime);
    if (nextEnabled && !isValidHourMinuteTime(sanitizedTime)) {
      setAutoResult({ status: "failed", title: "Automatic Backup Settings Failed", message: "Daily backup time must be a valid 24-hour time, for example 05:00 or 23:30." });
      return;
    }
    const intervalHours = Number(autoIntervalHours);
    if (nextEnabled && (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 168)) {
      setAutoResult({ status: "failed", title: "Automatic Backup Settings Failed", message: "Backup interval must be a whole number from 1 to 168 hours." });
      return;
    }
    setAutoTime(sanitizedTime);
    setAutoIntervalHours(String(intervalHours || 24));
    setAutoEnabled(nextEnabled);
    const final = await runBackupTask("auto", () => backupsApi.saveAuto({ enabled: nextEnabled, time: sanitizedTime, retentionDays: Number(autoRetentionDays), intervalHours: intervalHours || 24 }), "Automatic Backup Settings Saved", "Automatic Backup Settings Failed");
    if (final?.status !== "succeeded") {
      setAutoEnabled(!nextEnabled);
    }
  }
  async function importExternalBackup() {
    if (!importBackupFile) {
      setImportResult({ status: "failed", title: "Import Failed", message: "Select a .backup file." });
      return;
    }
    if (!importMetadataFile) {
      setImportResult({ status: "failed", title: "Import Failed", message: "Select the matching .backup.yaml file." });
      return;
    }
    if (!/\.backup$/i.test(importBackupFile.name)) {
      setImportResult({ status: "failed", title: "Import Failed", message: "The backup file must end with .backup." });
      return;
    }
    if (!/\.ya?ml$/i.test(importMetadataFile.name)) {
      setImportResult({ status: "failed", title: "Import Failed", message: "The metadata file must end with .yaml or .yml." });
      return;
    }
    setBusyAction("import");
    setImportResult({ status: "running", title: "Importing Backup" });
    try {
      const form = new FormData();
      form.append("backup", importBackupFile);
      form.append("metadata", importMetadataFile);
      const result = await backupsApi.importExternal(form);
      if (result.rows) setRows(result.rows);
      else await refresh();
      setImportResult({ status: "succeeded", title: "Backup Imported Successfully" });
      setImportBackupFile(null);
      setImportMetadataFile(null);
      if (importBackupInputRef.current) importBackupInputRef.current.value = "";
      if (importMetadataInputRef.current) importMetadataInputRef.current.value = "";
    } catch (error) {
      setImportResult({ status: "failed", title: "Import Failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyAction("");
    }
  }
  useEffect(() => {
    refresh().catch((error) => {
      setBackupResult({
        status: "failed",
        title: "Backup List Unavailable",
        message: error instanceof Error ? error.message : String(error)
      });
    });
  }, []);
  useEffect(() => {
    if (!backupResult || backupResult.status === "running" || backupResult.tone === "attention") return;
    const id = window.setTimeout(() => setBackupResult(null), 5400);
    return () => window.clearTimeout(id);
  }, [backupResult?.status, backupResult?.title]);
  useEffect(() => {
    if (!autoResult || autoResult.status === "running") return;
    const id = window.setTimeout(() => setAutoResult(null), 5400);
    return () => window.clearTimeout(id);
  }, [autoResult?.status, autoResult?.title]);
  useEffect(() => {
    if (!importResult || importResult.status === "running") return;
    const id = window.setTimeout(() => setImportResult(null), 5400);
    return () => window.clearTimeout(id);
  }, [importResult?.status, importResult?.title]);
  return (
    <section className="panel">
      <div className="panel-title"><h2>Backups</h2><div className="action-row"><button disabled={Boolean(busyAction)} onClick={() => run(refresh)}>Refresh Backups</button><button disabled={Boolean(busyAction)} onClick={() => run(() => runBackupTask("create", backupsApi.create, "Backup Created Successfully", "Backup failed"))}>Create Backup</button><button className="danger" disabled={Boolean(busyAction) || !rows.length} onClick={() => run(async () => {
        if (!(await confirmAction("Delete all backup files? This cannot be undone."))) return;
        await runBackupTask("deleteAll", backupsApi.deleteAll, "Backup Deleted", "Backup Delete Failed");
      })}>Delete All Backups</button></div></div>
      {backupRestoreTask ? <BackupResultCard result={backupRestoreTaskResult(backupRestoreTask)} /> : backupResult && <BackupResultCard result={backupResult} />}
      {rows.length ? <DataTable rows={rows} columns={["backupName", "battlegroupId", "created", "size", "type", "source"]} action={(row) => <div className="service-actions">
        <button className="icon-action restore-action" title="Restore" aria-label="Restore backup" disabled={Boolean(busyAction)} onClick={(event) => { event.stopPropagation(); run(async () => {
          const sourceText = /^external$/i.test(String(row.source || "")) ? " External backups will be matched to the backup battlegroup automatically when needed." : "";
          if (!(await confirmAction(`The current battlegroup database will be replaced.${sourceText}`, {
            title: "Restore Backup",
            confirmLabel: "Restore",
            danger: true,
            details: [{ label: "Backup", value: String(row.backupName || row.name || "Selected backup"), tone: "accent" }]
          }))) return;
          await runBackupTask("restore", () => backupsApi.restore(String(row.name)), "Restore Completed", "Backup Restore Failed");
        }); }}><img src="/images/icons/backup-restore.png" alt="" /></button>
        <a className="button-link icon-action download-action" title="Download" aria-label="Download backup" href={backupsApi.downloadUrl(String(row.name))} onClick={(event) => event.stopPropagation()}><img src="/images/icons/backup-download.png" alt="" /></a>
        <button className="icon-action danger" title="Delete" aria-label="Delete backup" disabled={Boolean(busyAction)} onClick={(event) => { event.stopPropagation(); run(async () => {
          if (!(await confirmAction(`Delete backup ${String(row.name)}? This cannot be undone.`))) return;
          await runBackupTask("delete", () => backupsApi.delete(String(row.name)), "Backup Deleted", "Backup Delete Failed");
        }); }}><img src="/images/icons/backup-delete.png" alt="" /></button>
      </div>} actionClassName="backup-table-actions" tableClassName="backup-table" /> : backupsLoading ? <div className="empty backups-loading">Loading Backups...</div> : <div className="empty backups-empty">No database backups have been created yet.</div>}
      <section className="action-section">
        <div className="panel-title"><h4>Automatic Backups</h4><label className={`switch-checkbox ${autoEnabled ? "enabled" : "disabled"}`}><input type="checkbox" disabled={Boolean(busyAction)} checked={autoEnabled} onChange={(event) => run(() => saveAutomaticBackups(event.target.checked))} /><span className="switch-label">Automatic Backups</span><strong className="switch-state">{autoEnabled ? "ON" : "OFF"}</strong></label></div>
        <KeyValueGrid items={[
          ["Current Status", commandStatusSummary(autoBackup).reason ? "Unavailable" : autoEnabled ? "Enabled" : "Disabled"],
          ["First Backup Time (Local Server Time)", toHourMinuteTime(autoStatus.backupTime || autoTime)],
          ["Interval", `Every ${autoStatus.intervalHours || autoIntervalHours || 24} hours`],
          ["Retention", autoStatus.retentionLabel || "No Retention Limit"],
          ["Timer", autoTimerLabel],
          ["Last Run", autoStatus.lastRun],
          ["Next Run", autoStatus.nextRun]
        ]} />
        {commandStatusSummary(autoBackup).reason && <p className="danger-note">{commandStatusSummary(autoBackup).reason}</p>}
        <div className="action-line backup-auto-controls">
          <label className="compact-select">First Backup Time<input type="time" step="60" pattern="[0-2][0-9]:[0-5][0-9]" value={autoTime} onChange={(event) => setAutoTime(sanitizeTimeInput(event.target.value))} placeholder="05:00" /></label>
          <label className="memory-number-field">Repeat Every<input type="number" min="1" max="168" step="1" value={autoIntervalHours} onChange={(event) => setAutoIntervalHours(event.target.value)} /></label>
          <span className="unit-label">Hours</span>
          <label className="memory-number-field">Keep<input type="number" min="0" max="3650" step="1" value={autoRetentionDays} onChange={(event) => setAutoRetentionDays(event.target.value)} /></label>
          <span className="unit-label">Days</span>
          <button disabled={Boolean(busyAction)} onClick={() => run(() => saveAutomaticBackups())}>Save Settings</button>
          {autoResult && <span className={`inline-task-result result-${autoResult.status === "succeeded" ? "ok" : autoResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={autoResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(autoResult.title, autoResult.status === "running")}</strong>
          </span>}
        </div>
      </section>
      <section className="action-section backup-external-import">
        <div className="panel-title"><h4>Import External Backup</h4></div>
        <div className="action-line backup-import-controls">
          <label className="wide-field">Backup File (.backup)<input ref={importBackupInputRef} type="file" accept=".backup" onChange={(event) => setImportBackupFile(event.target.files?.[0] || null)} /></label>
          <label className="wide-field">Metadata File (.yaml)<input ref={importMetadataInputRef} type="file" accept=".yaml,.yml" onChange={(event) => setImportMetadataFile(event.target.files?.[0] || null)} /></label>
          <div className="backup-import-actions">
            <button disabled={Boolean(busyAction)} onClick={() => run(importExternalBackup)}>Import</button>
            {importResult && <span className={`inline-task-result result-${importResult.status === "succeeded" ? "ok" : importResult.status === "failed" ? "fail" : "running"}`}>
              <strong className={importResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(importResult.title, importResult.status === "running")}</strong>
            </span>}
          </div>
        </div>
      </section>
    </section>
  );
}

function BackupResultCard({ result }: { result: BackupResult }) {
  const danger = result.tone === "danger";
  const attention = result.tone === "attention";
  return <section className={`result-panel backup-result ${attention ? "warning-panel result-attention" : danger ? "result-danger" : result.status === "failed" ? "warning-panel result-fail" : result.status === "succeeded" ? "result-ok" : "result-running"}`}>
    <div className="panel-title backup-result-title">
      <div className="backup-result-copy">
        <h4 className={result.status === "running" ? "loading-dots" : ""}>{formatResultTitle(result.title, result.status === "running")}</h4>
        {result.message && <p>{formatResultMessage(result.message)}</p>}
      </div>
      <StatusPill value={attention ? "Action Required" : danger ? "Deleted" : result.status === "failed" ? "Failed" : result.status === "running" ? "Running" : "Succeeded"} />
    </div>
    {result.details && <TechnicalDetails title="Technical details" text={result.details} />}
  </section>;
}

function backupRestoreTaskResult(task: Task): BackupResult {
  const details = task.logLines.map((line) => line.line).join("\n");
  if (funcomTokenMismatchDetected(details) || funcomTokenMismatchDetected(task.errorMessage || "")) {
    return {
      status: "failed",
      title: "Attention Required",
      message: "Funcom token mismatch detected. Please update your token to match the one used with the previous Battlegroup ID from the Server Controls.",
      details,
      tone: "attention"
    };
  }
  if (task.status === "succeeded") {
    return { status: "succeeded", title: "Restore Completed", message: "Database restore finished and the Dune console restart completed.", details };
  }
  if (task.status === "failed") {
    return { status: "failed", title: "Backup Restore Failed", message: task.errorMessage || conciseTaskError(task), details };
  }
  return { status: "running", title: "Restoring Backup...", message: backupRestoreStageMessage(task), details };
}

function backupRestoreStageMessage(task: Task) {
  const lines = task.logLines.map((row) => row.line).join("\n");
  if (/Starting Dune stack|Restarting Dune stack|Starting services/i.test(lines)) return "Restarting Dune services and waiting for the console to come back up.";
  if (/Database import finished/i.test(lines)) return "Database restore finished. Restarting services.";
  if (/Automatic account relink/i.test(lines)) return "Relinking restored characters to current Docker player identities.";
  if (/Adopt backup battlegroup:/i.test(lines)) return "Changing Docker to use the backup battlegroup ID.";
  if (/Battlegroup remap:/i.test(lines)) return "Adapting imported backup to this Docker battlegroup.";
  if (/Restoring database/i.test(lines)) return "Restoring database contents from the selected backup.";
  if (/Recreating dune database/i.test(lines)) return "Recreating the Dune database before import.";
  if (/Stopping services that depend on the database/i.test(lines)) return "Stopping Dune services before the database restore.";
  if (/Creating database backup/i.test(lines)) return "Creating a pre-restore safety backup.";
  return task.progressMessage || "Preparing database restore.";
}

function summarizeBackupTask(task: Task, successTitle: string, failureTitle: string): BackupResult {
  const details = task.logLines.map((line) => line.line).join("\n");
  if (task.status === "succeeded") {
    const backupName = extractBackupName(details);
    const created = backupName ? formatBackupTimestamp(backupName.match(/(\d{8}-\d{6})/)?.[1] || "") : "";
    const schedulerNote = /cannot install systemd units|systemctl was not found/i.test(details) ? "Preference saved. Timer installation requires host systemd/root permissions." : "";
    return {
      status: "succeeded",
      title: successTitle,
      message: [backupName, created && created !== "Unknown" ? `Created ${created}` : "", schedulerNote].filter(Boolean).join(" · "),
      details
    };
  }
  return {
    status: "failed",
    title: failureTitle,
    message: conciseTaskError(task),
    details
  };
}

function extractBackupName(text: string) {
  const matches = [...String(text || "").matchAll(/([A-Za-z0-9_.-]+(?:\.backup|\.dump|\.sql))/g)];
  return matches.length ? matches[matches.length - 1][1] : "";
}

function parseBackupRows(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const name = line.match(/([A-Za-z0-9_.-]+(?:\.backup|\.dump|\.sql))/)?.[1];
    if (!name) return null;
    const listTimestamp = line.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?::(\d{2}))?\b/);
    const timestamp = name.match(/(\d{8}-\d{6})/)?.[1] || "";
    const created = listTimestamp ? `${listTimestamp[1]} ${listTimestamp[2]}:${listTimestamp[3] || "00"}` : formatBackupTimestamp(timestamp);
    const createdSort = listTimestamp ? backupDisplayTimestampSort(created) : backupTimestampSort(timestamp);
    const type = friendlyBackupType(name, line);
    const source = /import/i.test(name) ? "External" : name.includes("__") ? name.split("__")[0].replace(/^dune-db-/, "") : "Local";
    const size = formatBackupListSize(line);
    return { name, backupName: name, battlegroupId: "Unknown", created, createdSort, size, type, source };
  }).filter(Boolean).sort((a, b) => Number((b as Record<string, unknown>).createdSort || 0) - Number((a as Record<string, unknown>).createdSort || 0)) as Record<string, unknown>[];
}

function formatBackupListSize(line: string) {
  const match = line.match(/\b(\d+(?:\.\d+)?)\s*(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)\b/i);
  if (!match) return "Unknown";
  const unit = match[2].replace(/iB$/i, "B").toUpperCase();
  return `${match[1]} ${unit}`;
}

function formatBackupTimestamp(value: string) {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return "Unknown";
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
}

function backupTimestampSort(value: string) {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return 0;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
}

function backupDisplayTimestampSort(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return 0;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])).getTime();
}

function friendlyBackupType(name: string, line: string) {
  if (/auto|scheduled/i.test(name) || /auto|scheduled/i.test(line)) return "Automatic Backup";
  if (/restore[-_ ]?safety/i.test(name) || /restore[-_ ]?safety/i.test(line)) return "Restore Safety Backup";
  if (/pre[-_ ]?update/i.test(name) || /pre[-_ ]?update/i.test(line)) return "Pre-update Backup";
  if (/destructive[-_ ]?sql|sql[-_ ]?safety/i.test(name) || /destructive[-_ ]?sql|sql[-_ ]?safety/i.test(line)) return "SQL Safety Backup";
  if (/import/i.test(name) || /import/i.test(line)) return "Imported Backup";
  if (name.endsWith(".backup") || name.endsWith(".dump") || name.endsWith(".sql")) return "Manual Backup";
  return "Unknown";
}
