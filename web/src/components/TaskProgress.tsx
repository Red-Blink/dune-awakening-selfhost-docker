import type { Task } from "../api/setup";
import { StatusBadge } from "./StatusBadge";
import { useEffect, useState } from "react";

const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);

export function TaskProgress({ task, onDismiss }: { task: Task | null; onDismiss?: () => void }) {
  const [liveTask, setLiveTask] = useState<Task | null>(task);

  useEffect(() => {
    setLiveTask(task);
    if (!task || terminalStatuses.has(task.status)) return;
    const source = new EventSource(`/api/setup/tasks/${encodeURIComponent(task.id)}/stream`, { withCredentials: true });
    source.onmessage = (event) => {
      const next = JSON.parse(event.data) as Task;
      setLiveTask(next);
      if (terminalStatuses.has(next.status)) source.close();
    };
    source.onerror = () => source.close();
    return () => source.close();
  }, [task?.id]);

  useEffect(() => {
    if (liveTask?.status !== "succeeded" || !onDismiss) return;
    const id = window.setTimeout(onDismiss, 8000);
    return () => window.clearTimeout(id);
  }, [liveTask?.id, liveTask?.status, onDismiss]);

  if (!liveTask) return null;
  return (
    <section className="panel">
      <div className="panel-title">
        <h3>{taskTitle(liveTask)}</h3>
        <div className="action-row">
          <StatusBadge status={liveTask.status} />
          {terminalStatuses.has(liveTask.status) && <button onClick={onDismiss}>Dismiss</button>}
        </div>
      </div>
      <p>{taskMessage(liveTask)}</p>
      {liveTask.errorMessage && <p className="error">{liveTask.errorMessage}</p>}
      <details className="technical-details">
        <summary>Technical details</summary>
        <pre className="log-box">{liveTask.logLines.slice(-120).map((line) => line.line).join("\n")}</pre>
      </details>
    </section>
  );
}

function taskTitle(task: Task) {
  if (task.operation === "backupRestore") {
    if (task.status === "succeeded") return "Restore Completed";
    if (task.status === "failed") return "Backup Restore Failed";
    return "Restoring Backup";
  }
  return task.operation;
}

function taskMessage(task: Task) {
  if (task.operation !== "backupRestore") return task.progressMessage || task.currentStep;
  if (task.status === "succeeded") return "Database restore finished and the Dune stack restart completed.";
  if (task.status === "failed") return task.errorMessage || "Database restore failed.";

  const lines = task.logLines.map((row) => row.line).join("\n");
  if (/Starting Dune stack|Restarting Dune stack|Starting services/i.test(lines)) return "Restarting Dune services and waiting for the stack to come back up.";
  if (/Database import finished/i.test(lines)) return "Database restore finished. Restarting services.";
  if (/Automatic account relink/i.test(lines)) return "Relinking restored characters to current Docker player identities.";
  if (/Battlegroup remap:/i.test(lines)) return "Adapting imported backup to this Docker battlegroup.";
  if (/Restoring database/i.test(lines)) return "Restoring database contents from the selected backup.";
  if (/Recreating dune database/i.test(lines)) return "Recreating the Dune database before import.";
  if (/Stopping services that depend on the database/i.test(lines)) return "Stopping Dune services before the database restore.";
  if (/Creating database backup/i.test(lines)) return "Creating a pre-restore safety backup.";
  return task.progressMessage || "Preparing database restore.";
}
