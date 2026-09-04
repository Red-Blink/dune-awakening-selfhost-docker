import { useEffect, useRef, useState } from "react";
import { backupIdentityDiffers, backupsApi } from "../../api/backups";
import type { SystemBackupRow } from "../../api/backups";
import type { Task } from "../../api/setup";
import { DataTable } from "../../components/common/DataTable";
import { KeyValueGrid, StatusPill, TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { formatUiSentence } from "../../lib/display";
import { conciseTaskError, funcomTokenMismatchDetected } from "../../lib/taskDisplay";

type BackupResult = { status: "running" | "succeeded" | "failed"; title: string; message?: string; details?: string; tone?: "danger" | "attention" };
type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] }) => Promise<boolean>;
type BackupIdentityChoice = "adopt-backup" | "keep-current" | "cancel";
type CommandStatus = { status: string; reason?: string };

type BackupsPanelProps = {
  backupRestoreTask: Task | null;
  setBackupRestoreTask: (task: Task | null) => void;
  onError: (text: string) => void;
  confirmAction: ConfirmAction;
  chooseBackupIdentity: (meta: { backup: string; currentBattlegroupId: string; backupBattlegroupId: string }) => Promise<BackupIdentityChoice>;
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

export function BackupsPanel({ backupRestoreTask, setBackupRestoreTask, onError, confirmAction, chooseBackupIdentity, waitForTask, waitForTaskWithUpdates, withTimeout, toHourMinuteTime, sanitizeTimeInput, isValidHourMinuteTime, commandStatusSummary, taskTechnicalDetails, isTerminalTask }: BackupsPanelProps) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [selectedBackups, setSelectedBackups] = useState<Set<string>>(new Set());
  const [currentBattlegroupId, setCurrentBattlegroupId] = useState("Unknown");
  const [backupsLoading, setBackupsLoading] = useState(true);
  const [autoBackup, setAutoBackup] = useState<{ stdout?: string; stderr?: string; exitCode?: number } | null>(null);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoTime, setAutoTime] = useState("05:00");
  const [autoIntervalHours, setAutoIntervalHours] = useState("24");
  const [autoRetentionDays, setAutoRetentionDays] = useState("0");
  const [backupResult, setBackupResult] = useState<BackupResult | null>(null);
  const [autoResult, setAutoResult] = useState<BackupResult | null>(null);
  const [importResult, setImportResult] = useState<BackupResult | null>(null);
  const [systemRows, setSystemRows] = useState<SystemBackupRow[]>([]);
  const [systemResult, setSystemResult] = useState<BackupResult | null>(null);
  const [systemPassphrase, setSystemPassphrase] = useState("");
  const [systemPassphraseConfirm, setSystemPassphraseConfirm] = useState("");
  const [selectedSystemBackups, setSelectedSystemBackups] = useState<Set<string>>(new Set());
  // The restore passphrase has to survive from preview to apply, so it stays in
  // state between the two calls -- cleared as soon as either finishes, and
  // invalidated the moment it is edited so an apply can never run under a
  // passphrase the preview did not prove.
  const [restoreTarget, setRestoreTarget] = useState<SystemBackupRow | null>(null);
  const [restorePassphrase, setRestorePassphrase] = useState("");
  const [restorePreviewed, setRestorePreviewed] = useState(false);
  const [importBackupFile, setImportBackupFile] = useState<File | null>(null);
  const [importMetadataFile, setImportMetadataFile] = useState<File | null>(null);
  const importBackupInputRef = useRef<HTMLInputElement | null>(null);
  const importMetadataInputRef = useRef<HTMLInputElement | null>(null);
  const backupsRefreshRef = useRef<Promise<void> | null>(null);
  const completedRestoreTaskIdsRef = useRef(new Set<string>());
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
      const nextRows = result.rows?.length ? result.rows : parseBackupRows(result.stdout || "");
      setRows(nextRows);
      const available = new Set(nextRows.map((row) => String(row.name || row.backupName || "")).filter(Boolean));
      setSelectedBackups((current) => new Set([...current].filter((name) => available.has(name))));
      setCurrentBattlegroupId(String(result.currentBattlegroupId || "Unknown"));
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
  async function refreshSystemBackups() {
    const result = await backupsApi.listSystem();
    setSystemRows(result.rows || []);
  }

  async function createSystemBackup() {
    // Double entry mirrors the CLI prompt: a mistyped passphrase produces an
    // archive nobody can ever decrypt, and the archive is the only copy.
    if (systemPassphrase.length < 12) {
      setSystemResult({ status: "failed", title: "System Backup Failed", message: "The passphrase must be at least 12 characters." });
      return;
    }
    // Mirrors the server's floor so this fails before a round trip.
    if (new Set(systemPassphrase).size < 5) {
      setSystemResult({ status: "failed", title: "System Backup Failed", message: "The passphrase must use at least 5 different characters." });
      return;
    }
    if (systemPassphrase !== systemPassphraseConfirm) {
      setSystemResult({ status: "failed", title: "System Backup Failed", message: "The two passphrases do not match." });
      return;
    }
    setBusyAction("createSystem");
    setSystemResult({ status: "running", title: "Creating System Backup" });
    try {
      const response = await backupsApi.createSystem(systemPassphrase);
      const final = await waitForTask(response.task);
      setSystemResult(summarizeBackupTask(final, "System Backup Created", "System Backup Failed"));
      if (final.status === "succeeded") await refreshSystemBackups();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setSystemResult({ status: "failed", title: "System Backup Failed", message: reason });
    } finally {
      // Cleared on failure too -- never leave a passphrase sitting in the DOM.
      setSystemPassphrase("");
      setSystemPassphraseConfirm("");
      setBusyAction("");
    }
  }

  function toggleSystemBackup(name: string, checked: boolean) {
    setSelectedSystemBackups((current) => {
      const next = new Set(current);
      if (checked) next.add(name); else next.delete(name);
      return next;
    });
  }

  function openSystemRestore(row: SystemBackupRow) {
    setRestoreTarget(row);
    setRestorePassphrase("");
    setRestorePreviewed(false);
    setSystemResult(null);
  }

  function closeSystemRestore() {
    setRestoreTarget(null);
    setRestorePassphrase("");
    setRestorePreviewed(false);
  }

  // Restore gets its own runner. summarizeBackupTask is shaped around "a backup
  // file was written", and runSystemBackupTask stamps success with the delete
  // card's tone; neither describes a preview or a restore that leaves the stack
  // running the previous configuration.
  async function runSystemRestoreTask(action: string, taskFactory: () => Promise<{ task: Task }>, runningTitle: string, failureTitle: string, onSuccess: (details: string) => BackupResult) {
    setBusyAction(action);
    setSystemResult({ status: "running", title: runningTitle });
    try {
      const response = await taskFactory();
      const final = await waitForTask(response.task);
      const details = final.logLines.map((line) => line.line).join("\n");
      if (final.status === "succeeded") setSystemResult(onSuccess(details));
      else setSystemResult({ status: "failed", title: failureTitle, message: final.errorMessage || conciseTaskError(final), details });
      return final;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setSystemResult({ status: "failed", title: failureTitle, message: reason });
      onError(reason);
      return null;
    } finally {
      setBusyAction("");
    }
  }

  async function previewSystemRestore() {
    if (!restoreTarget) return;
    const final = await runSystemRestoreTask(
      "restoreSystemPreview",
      () => backupsApi.restoreSystem(restoreTarget.name, { passphrase: restorePassphrase, apply: false }),
      "Checking System Backup...",
      "Restore Preview Failed",
      (details) => ({
        status: "succeeded",
        title: "Preview Only - Nothing Changed",
        message: "The passphrase opened the archive. Review what it would replace below, then apply.",
        details
      })
    );
    // Only a successful decrypt unlocks apply, so a wrong passphrase cannot
    // reach the destructive call at all.
    setRestorePreviewed(final?.status === "succeeded");
  }

  async function applySystemRestore() {
    if (!restoreTarget || !restorePreviewed) return;
    const backup = restoreTarget.name;
    const backupBattlegroupId = String(restoreTarget.battlegroupId || "Unknown");
    // Unlike the database restore, this always confirms before asking about
    // identity: the archive replaces credentials and configuration too, so the
    // identity question alone is not an informed confirmation of it.
    if (!(await confirmAction("This replaces this server's configuration, credentials and database with the contents of the archive.", {
      title: "Restore System Backup",
      confirmLabel: "Restore",
      danger: true,
      details: [
        { label: "Backup", value: backup, tone: "accent" },
        { label: "Replaces", value: ".env, runtime/generated, runtime/secrets and the entire database", tone: "danger" },
        { label: "After", value: "A stack restart is required; the admin password may change", tone: "danger" }
      ]
    }))) return;
    let identityMode: BackupIdentityChoice = "keep-current";
    if (backupIdentityDiffers(currentBattlegroupId, backupBattlegroupId)) {
      identityMode = await chooseBackupIdentity({ backup, currentBattlegroupId, backupBattlegroupId });
      if (identityMode === "cancel") return;
    }
    const final = await runSystemRestoreTask(
      "restoreSystemApply",
      () => backupsApi.restoreSystem(backup, { passphrase: restorePassphrase, apply: true, identityMode }),
      "Restoring System Backup...",
      "System Backup Restore Failed",
      (details) => ({
        status: "succeeded",
        title: "System Backup Restored",
        // "attention", not plain success: the restore is only half-applied from
        // the operator's point of view until the stack is restarted.
        tone: "attention",
        message: "Configuration, credentials and the database were replaced. The stack is still running the previous configuration - restart it from Server Controls to pick this up. The admin password and database credentials may now differ from the ones this session is using.",
        details
      })
    );
    closeSystemRestore();
    if (final?.status === "succeeded") await refreshSystemBackups();
  }

  // The system section keeps its own result card and busy labels so a delete
  // here never overwrites the database backup card beside it.
  async function runSystemBackupTask(action: string, taskFactory: () => Promise<{ task: Task }>, runningTitle: string, successTitle: string, failureTitle: string) {
    setBusyAction(action);
    setSystemResult({ status: "running", title: runningTitle });
    try {
      const response = await taskFactory();
      const final = await waitForTask(response.task);
      const result = summarizeBackupTask(final, successTitle, failureTitle);
      setSystemResult(final.status === "succeeded" ? { ...result, tone: "danger" } : result);
      if (final.status === "succeeded") {
        setSelectedSystemBackups(new Set());
        await refreshSystemBackups();
      }
      return final;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setSystemResult({ status: "failed", title: failureTitle, message: reason });
      onError(reason);
      return null;
    } finally {
      setBusyAction("");
    }
  }

  async function runBackupTask(action: "create" | "delete" | "deleteSelected" | "deleteAll" | "restore" | "auto", taskFactory: () => Promise<{ task: Task }>, successTitle: string, failureTitle: string) {
    setBusyAction(action);
    const setter = action === "auto" ? setAutoResult : setBackupResult;
    setter({ status: "running", title: action === "restore" ? "Restoring Backup..." : action === "delete" || action === "deleteSelected" || action === "deleteAll" ? "Deleting Backup..." : action === "auto" ? "Saving Automatic Backup Settings..." : "Creating Backup..." });
    let restoreImportCompleted = false;
    try {
      const response = await taskFactory();
      const final = action === "restore" ? await waitForTaskWithUpdates(response.task, (task) => {
        if (restoreImportCompleted) return;
        if (backupRestoreHasCompletedImport(task)) {
          restoreImportCompleted = true;
          setBackupRestoreTask(null);
          if (!completedRestoreTaskIdsRef.current.has(task.id)) {
            completedRestoreTaskIdsRef.current.add(task.id);
            setter(backupRestoreCompletedResult(task));
          }
          return;
        }
        setBackupRestoreTask(task);
      }) : await waitForTask(response.task);
      const result = action === "restore" ? backupRestoreTaskResult(final) : summarizeBackupTask(final, successTitle, failureTitle);
      if (action === "restore" && isTerminalTask(final.status)) setBackupRestoreTask(null);
      if (!(action === "restore" && restoreImportCompleted)) {
        setter((final.status === "succeeded" && (action === "delete" || action === "deleteSelected" || action === "deleteAll")) ? { ...result, tone: "danger" } : result);
      }
      if (final.status === "succeeded") await refresh();
      return final;
    } catch (error) {
      if (action === "restore" && restoreImportCompleted) return null;
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
    refreshSystemBackups().catch(() => setSystemRows([]));
  }, []);
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
    if (!backupRestoreTask || !backupRestoreHasCompletedImport(backupRestoreTask)) return;
    if (completedRestoreTaskIdsRef.current.has(backupRestoreTask.id)) return;
    completedRestoreTaskIdsRef.current.add(backupRestoreTask.id);
    setBackupResult(backupRestoreCompletedResult(backupRestoreTask));
    setBackupRestoreTask(null);
  }, [backupRestoreTask?.id, backupRestoreTask?.logLines.length]);
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
  const backupNames = rows.map((row) => String(row.name || row.backupName || "")).filter(Boolean);
  const allSelected = backupNames.length > 0 && backupNames.every((name) => selectedBackups.has(name));
  function toggleBackup(name: string, checked: boolean) {
    setSelectedBackups((current) => {
      const next = new Set(current);
      if (checked) next.add(name); else next.delete(name);
      return next;
    });
  }
  return (
    <section className="panel backups-panel">
      <div className="panel-title"><h2>Backups</h2></div>
      {backupRestoreTask ? <BackupResultCard result={backupRestoreTaskResult(backupRestoreTask)} /> : backupResult && <BackupResultCard result={backupResult} />}
      <section className="action-section backup-funcom-backups">
        <div className="panel-title backup-group-title"><h4>Funcom Backups</h4></div>
        <p className="backup-group-note">A snapshot of the game database only &mdash; characters, bases, vehicles, inventories and world state. These contain no console configuration and no credentials, so restoring one onto a fresh host still leaves every setting to re-enter by hand. Use a System Backup below to move a server to new hardware.</p>
        <div className="action-row backup-group-actions"><button disabled={Boolean(busyAction)} onClick={() => run(refresh)}>Refresh Backups</button><button disabled={Boolean(busyAction)} onClick={() => run(() => runBackupTask("create", backupsApi.create, "Backup Created Successfully", "Backup failed"))}>Create Backup</button><button className="danger" disabled={Boolean(busyAction) || !selectedBackups.size} onClick={() => run(async () => {
          const names = [...selectedBackups];
          if (!(await confirmAction(`Delete ${names.length} selected backup${names.length === 1 ? "" : "s"}? This cannot be undone.`))) return;
          const final = await runBackupTask("deleteSelected", () => backupsApi.deleteSelected(names), "Selected Backups Deleted", "Backup Delete Failed");
          if (final?.status === "succeeded") setSelectedBackups(new Set());
        })}>Delete Selected ({selectedBackups.size})</button><button className="danger" disabled={Boolean(busyAction) || !rows.length} onClick={() => run(async () => {
          if (!(await confirmAction("Delete all backup files? This cannot be undone."))) return;
          await runBackupTask("deleteAll", backupsApi.deleteAll, "Backup Deleted", "Backup Delete Failed");
        })}>Delete All Backups</button></div>
        {rows.length ? <DataTable rows={rows} columns={["backupName", "battlegroupId", "created", "size", "type", "source"]} secondaryActionPosition="start" secondaryActionClassName="backup-select-column" secondaryActionLabel={<label className="backup-select-checkbox" title="Select all backups"><input type="checkbox" aria-label="Select all backups" disabled={Boolean(busyAction)} checked={allSelected} onChange={(event) => setSelectedBackups(event.target.checked ? new Set(backupNames) : new Set())} /><span className="sr-only">Select All</span></label>} secondaryAction={(row) => {
          const name = String(row.name || row.backupName || "");
          return <label className="backup-select-checkbox"><input type="checkbox" aria-label={`Select backup ${name}`} disabled={Boolean(busyAction)} checked={selectedBackups.has(name)} onChange={(event) => toggleBackup(name, event.target.checked)} onClick={(event) => event.stopPropagation()} /><span className="sr-only">Select</span></label>;
        }} action={(row) => <div className="service-actions">
          <button className="icon-action restore-action" title="Restore" aria-label="Restore backup" disabled={Boolean(busyAction)} onClick={(event) => { event.stopPropagation(); run(async () => {
            const backup = String(row.backupName || row.name || "Selected backup");
            const backupBattlegroupId = String(row.battlegroupId || "Unknown");
            const identityMismatch = backupIdentityDiffers(currentBattlegroupId, backupBattlegroupId);
            let identityMode: BackupIdentityChoice = "keep-current";
            if (identityMismatch) {
              identityMode = await chooseBackupIdentity({ backup, currentBattlegroupId, backupBattlegroupId });
              if (identityMode === "cancel") return;
            } else if (!(await confirmAction("The current Battlegroup database will be replaced.", {
              title: "Restore Backup",
              confirmLabel: "Restore",
              danger: true,
              details: [
                { label: "Backup", value: backup, tone: "accent" },
                { label: "Battlegroup", value: backupBattlegroupId === "Unknown" ? "Identity unavailable; current ID will be kept" : backupBattlegroupId, tone: backupBattlegroupId === "Unknown" ? "danger" : "success" }
              ]
            }))) return;
            await runBackupTask("restore", () => backupsApi.restore(String(row.name), identityMode), "Restore Completed", "Backup Restore Failed");
          }); }}><img src="/images/icons/backup-restore.png" alt="" /></button>
          <a className="button-link icon-action download-action" title="Download" aria-label="Download backup" href={backupsApi.downloadUrl(String(row.name))} onClick={(event) => event.stopPropagation()}><img src="/images/icons/backup-download.png" alt="" /></a>
          <button className="icon-action danger" title="Delete" aria-label="Delete backup" disabled={Boolean(busyAction)} onClick={(event) => { event.stopPropagation(); run(async () => {
            if (!(await confirmAction(`Delete backup ${String(row.name)}? This cannot be undone.`))) return;
            await runBackupTask("delete", () => backupsApi.delete(String(row.name)), "Backup Deleted", "Backup Delete Failed");
          }); }}><img src="/images/icons/backup-delete.png" alt="" /></button>
        </div>} actionClassName="backup-table-actions" tableClassName="backup-table" /> : backupsLoading ? <div className="empty backups-loading">Loading Backups...</div> : <div className="empty backups-empty">No database backups have been created yet.</div>}
      </section>
      <section className="action-section backup-external-import">
        <div className="panel-title"><h4>Import Funcom External Backup</h4></div>
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
      <section className="action-section backup-system-backups">
        <div className="panel-title"><h4>System Backups (Encrypted)</h4></div>
        <p className="backup-group-note backup-note-warning">A system backup bundles the database together with <code>.env</code>, <code>runtime/generated</code> and every file in <code>runtime/secrets</code> &mdash; the Funcom token, admin console password, RMQ credentials, sietch join password and IAM policies. It is encrypted with the passphrase you set here, and <strong>there is no way to recover it without that passphrase</strong>. Store the passphrase somewhere durable and separate from the archive.</p>
        <div className="action-line backup-import-controls">
          <label className="wide-field">Passphrase<input type="password" autoComplete="new-password" value={systemPassphrase} onChange={(event) => setSystemPassphrase(event.target.value)} /></label>
          <label className="wide-field">Confirm Passphrase<input type="password" autoComplete="new-password" value={systemPassphraseConfirm} onChange={(event) => setSystemPassphraseConfirm(event.target.value)} /></label>
          <div className="backup-import-actions">
            <button disabled={Boolean(busyAction) || !systemPassphrase || !systemPassphraseConfirm} onClick={() => run(createSystemBackup)}>Create System Backup</button>
            <button className="danger" disabled={Boolean(busyAction) || !selectedSystemBackups.size} onClick={() => run(async () => {
            const names = [...selectedSystemBackups];
            if (!(await confirmAction(`Delete ${names.length} selected system backup${names.length === 1 ? "" : "s"}? Each one is the only copy of the credentials it contains, and this cannot be undone.`, { title: "Delete System Backups", confirmLabel: "Delete", danger: true }))) return;
            await runSystemBackupTask("deleteSystemSelected", () => backupsApi.deleteSystemSelected(names), "Deleting System Backups...", "System Backups Deleted", "System Backup Delete Failed");
          })}>Delete Selected ({selectedSystemBackups.size})</button>
          <button className="danger" disabled={Boolean(busyAction) || !systemRows.length} onClick={() => run(async () => {
            if (!(await confirmAction("Delete every system backup? These archives are the only copy of the credentials they contain, and this cannot be undone.", { title: "Delete All System Backups", confirmLabel: "Delete All", danger: true }))) return;
            await runSystemBackupTask("deleteSystemAll", backupsApi.deleteSystemAll, "Deleting System Backups...", "System Backups Deleted", "System Backup Delete Failed");
          })}>Delete All</button>
          </div>
        </div>
        {restoreTarget && <div className="action-section backup-system-restore">
          <div className="panel-title"><h4>Restore System Backup</h4></div>
          <p className="backup-group-note backup-note-warning">
            Restoring <code>{restoreTarget.name}</code> replaces this server's <code>.env</code>, <code>runtime/generated</code>, <code>runtime/secrets</code> and <strong>the entire database</strong>. What is replaced is copied to <code>runtime/backups/</code> first. <strong>Nothing changes until you apply.</strong>
          </p>
          <label className="wide-field">Passphrase<input type="password" autoComplete="off" aria-label="Restore passphrase" value={restorePassphrase} onChange={(event) => { setRestorePassphrase(event.target.value); setRestorePreviewed(false); }} /></label>
          <div className="action-row backup-group-actions">
            <button disabled={Boolean(busyAction)} onClick={closeSystemRestore}>Cancel</button>
            <button disabled={Boolean(busyAction) || restorePassphrase.length < 12} onClick={() => run(previewSystemRestore)}>Preview Restore</button>
            <button className="danger" disabled={Boolean(busyAction) || !restorePreviewed} onClick={() => run(applySystemRestore)}>Apply Restore</button>
          </div>
        </div>}
        {systemResult && <BackupResultCard result={systemResult} />}
        {systemRows.length === 0 ? <p className="muted">No system backups have been created yet.</p> : <DataTable
          columns={["name", "battlegroupId", "createdAt", "size", "type", "source", "encryption"]}
          columnLabels={{ name: "Backup Name", battlegroupId: "Battlegroup ID", createdAt: "Created", size: "Size", type: "Type", source: "Source", encryption: "Encryption" }}
          rows={systemRows as unknown as Record<string, unknown>[]}
          rowKey={(row) => String(row.name)}
          secondaryActionPosition="start"
          secondaryActionClassName="backup-select-column"
          secondaryActionLabel={<label className="backup-select-checkbox" title="Select all system backups"><input type="checkbox" aria-label="Select all system backups" disabled={Boolean(busyAction)} checked={systemRows.length > 0 && selectedSystemBackups.size === systemRows.length} onChange={(event) => setSelectedSystemBackups(event.target.checked ? new Set(systemRows.map((row) => row.name)) : new Set())} /><span className="sr-only">Select All</span></label>}
          secondaryAction={(row) => <label className="backup-select-checkbox"><input type="checkbox" aria-label={`Select system backup ${String(row.name)}`} disabled={Boolean(busyAction)} checked={selectedSystemBackups.has(String(row.name))} onChange={(event) => toggleSystemBackup(String(row.name), event.target.checked)} onClick={(event) => event.stopPropagation()} /><span className="sr-only">Select</span></label>}
          action={(row) => <div className="service-actions">
            <button className="icon-action restore-action" title="Restore" aria-label={`Restore system backup ${String(row.name)}`} disabled={Boolean(busyAction)} onClick={(event) => { event.stopPropagation(); openSystemRestore(row as unknown as SystemBackupRow); }}><img src="/images/icons/backup-restore.png" alt="" /></button>
            <a className="button-link icon-action download-action" title="Download archive and metadata (.tar)" aria-label={`Download system backup ${String(row.name)}`} href={backupsApi.systemDownloadUrl(String(row.name))} onClick={(event) => event.stopPropagation()}><img src="/images/icons/backup-download.png" alt="" /></a>
            <button className="icon-action danger" title="Delete" aria-label={`Delete system backup ${String(row.name)}`} disabled={Boolean(busyAction)} onClick={(event) => { event.stopPropagation(); run(async () => {
              const name = String(row.name);
              if (!(await confirmAction(`Delete system backup ${name}? It is the only copy of the credentials it contains, and this cannot be undone.`, { title: "Delete System Backup", confirmLabel: "Delete", danger: true }))) return;
              await runSystemBackupTask("deleteSystem", () => backupsApi.deleteSystem(name), "Deleting System Backup...", "System Backup Deleted", "System Backup Delete Failed");
            }); }}><img src="/images/icons/backup-delete.png" alt="" /></button>
          </div>}
          actionClassName="backup-table-actions"
        />}
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
  if (backupRestoreHasCompletedImport(task)) return backupRestoreCompletedResult(task);
  return { status: "running", title: backupRestoreStageTitle(task), message: backupRestoreStageMessage(task), details };
}

function backupRestoreCompletedResult(task: Task): BackupResult {
  const details = task.logLines.map((line) => line.line).join("\n");
  return {
    status: "succeeded",
    title: "Restore Successful",
    message: "Database restore completed successfully. Dune services are restarting.",
    details
  };
}

function backupRestoreHasCompletedImport(task: Task) {
  const lines = task.logLines.map((row) => row.line).join("\n");
  return /Database import finished|Starting Dune stack|Restarting Dune stack|Starting services/i.test(lines);
}

function backupRestoreStageTitle(task: Task) {
  const lines = task.logLines.map((row) => row.line).join("\n");
  if (/Database import finished|Starting Dune stack|Restarting Dune stack|Starting services/i.test(lines)) return "Restarting Dune Services";
  return "Restoring Backup...";
}

function backupRestoreStageMessage(task: Task) {
  const lines = task.logLines.map((row) => row.line).join("\n");
  if (/Starting Dune stack|Restarting Dune stack|Starting services/i.test(lines)) return "Database restore completed successfully. Dune services are restarting.";
  if (/Database import finished/i.test(lines)) return "Database restore completed successfully. Restarting Dune services.";
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
  // Keep in sync with statusParsers.js: market-bot names must not fall
  // through to the substring-based classifiers below.
  if (/market[-_ ]?bot/i.test(name) || /market[-_ ]?bot/i.test(line)) return "Market Bot Backup";
  if (/auto|scheduled/i.test(name) || /auto|scheduled/i.test(line)) return "Automatic Backup";
  if (/restore[-_ ]?safety|land[-_ ]?claim[-_ ]?editor/i.test(name) || /restore[-_ ]?safety|land[-_ ]?claim[-_ ]?editor/i.test(line)) return "Restore Safety Backup";
  if (/vehicle[-_ ]?delete/i.test(name) || /vehicle[-_ ]?delete/i.test(line)) return "Vehicle Delete Safety Backup";
  if (/pre[-_ ]?update/i.test(name) || /pre[-_ ]?update/i.test(line)) return "Pre-update Backup";
  if (/destructive[-_ ]?sql|sql[-_ ]?safety|base[-_ ]?delete|admin[-_ ]?tools|addon-/i.test(name) || /destructive[-_ ]?sql|sql[-_ ]?safety|base[-_ ]?delete|admin[-_ ]?tools|addon-/i.test(line)) return "SQL Safety Backup";
  if (/import/i.test(name) || /import/i.test(line)) return "Imported Backup";
  if (name.endsWith(".backup") || name.endsWith(".dump") || name.endsWith(".sql")) return "Manual Backup";
  return "Unknown";
}
