import type { Task } from "../api/setup";
import { StatusBadge } from "./StatusBadge";
import { useEffect, useState } from "react";

const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);

export function TaskProgress({ task, onDismiss }: { task: Task | null; onDismiss?: () => void }) {
  const [liveTask, setLiveTask] = useState<Task | null>(task);
  const [now, setNow] = useState(() => Date.now());

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
    if (!liveTask || !terminalStatuses.has(liveTask.status) || !onDismiss) return;
    const id = window.setTimeout(onDismiss, 8000);
    return () => window.clearTimeout(id);
  }, [liveTask?.id, liveTask?.status, onDismiss]);

  useEffect(() => {
    if (!liveTask || terminalStatuses.has(liveTask.status)) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [liveTask?.id, liveTask?.status]);

  if (!liveTask) return null;
  return (
    <section className="panel">
      <div className="panel-title">
        <h3 className={!terminalStatuses.has(liveTask.status) ? "loading-dots" : ""}>{formatUiSentence(taskTitle(liveTask), !terminalStatuses.has(liveTask.status))}</h3>
        <div className="action-row">
          <StatusBadge status={liveTask.status} />
          {terminalStatuses.has(liveTask.status) && <button onClick={onDismiss}>Dismiss</button>}
        </div>
      </div>
      <p>{formatUiSentence(taskMessage(liveTask))}</p>
      {liveTask.operation === "init" && !terminalStatuses.has(liveTask.status) && <p className="task-elapsed">This can take a while on a fresh server. Elapsed time: <strong>{formatElapsed(now - new Date(liveTask.startedAt).getTime())}</strong></p>}
      {liveTask.operation === "init" && <ProgressBar progress={initTaskProgress(liveTask)} />}
      {liveTask.errorMessage && <p className="error">{formatUiSentence(liveTask.errorMessage)}</p>}
      <details className={liveTask.operation === "init" ? "task-technical-details" : "technical-details"}>
        <summary>{liveTask.operation === "init" ? "Deployment log" : "Technical details"}</summary>
        <pre className="log-box">{liveTask.logLines.slice(-120).map((line) => line.line).join("\n")}</pre>
      </details>
    </section>
  );
}

function formatElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function ProgressBar({ progress }: { progress: { percent: number; label: string } }) {
  return (
    <div className="deployment-progress">
      <div className="progress-row">
        <div className="progress-track" aria-label={`Deployment progress ${progress.percent}%`}>
          <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
        </div>
        <strong>{progress.percent}%</strong>
      </div>
      <span>{progress.label}</span>
    </div>
  );
}

function formatUiSentence(value: unknown, pending = false) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const clean = text.replace(/(?:\s*\.\s*){2,}$/g, "").replace(/\s+[.!?]$/g, "").trim();
  const capitalized = clean.charAt(0).toUpperCase() + clean.slice(1);
  if (pending) return capitalized.replace(/[.!?]+$/g, "");
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

function taskTitle(task: Task) {
  if (task.operation === "init") {
    if (task.status === "succeeded") return "Deployment Complete";
    if (task.status === "failed") return "Deployment Failed";
    return "Deploying Dune Server";
  }
  if (task.operation === "backupRestore") {
    if (task.status === "succeeded") return "Restore Completed";
    if (task.status === "failed") return "Backup Restore Failed";
    return "Restoring Backup";
  }
  return task.operation;
}

function taskMessage(task: Task) {
  if (task.operation === "init") return initTaskMessage(task);
  if (task.operation !== "backupRestore") return task.progressMessage || task.currentStep;
  if (task.status === "succeeded") return "Database restore finished and the Dune console restart completed.";
  if (task.status === "failed") return task.errorMessage || "Database restore failed.";

  const lines = task.logLines.map((row) => row.line).join("\n");
  if (/Starting Dune stack|Restarting Dune stack|Starting services/i.test(lines)) return "Restarting Dune services and waiting for the console to come back up.";
  if (/Database import finished/i.test(lines)) return "Database restore finished. Restarting services.";
  if (/Automatic account relink/i.test(lines)) return "Relinking restored characters to current Docker player identities.";
  if (/Battlegroup remap:/i.test(lines)) return "Adapting imported backup to this Docker battlegroup.";
  if (/Restoring database/i.test(lines)) return "Restoring database contents from the selected backup.";
  if (/Recreating dune database/i.test(lines)) return "Recreating the Dune database before import.";
  if (/Stopping services that depend on the database/i.test(lines)) return "Stopping Dune services before the database restore.";
  if (/Creating database backup/i.test(lines)) return "Creating a pre-restore safety backup.";
  return task.progressMessage || "Preparing database restore.";
}

function initTaskMessage(task: Task) {
  if (task.status === "succeeded") return "Deployment finished. The game services are starting and may need several minutes before they are ready.";
  if (task.status === "failed") return task.errorMessage || "Deployment failed. Open technical details to see the last server output.";
  const lines = task.logLines.map((row) => row.line).join("\n");
  if (/Starting orchestrator container/i.test(lines)) return "Starting the deployment container.";
  if (/Downloading\/loading assets and running database setup\/update/i.test(lines)) return "Downloading server assets, loading Funcom images, and preparing the database.";
  if (/Refresh generated map catalogs|Extracting .* catalog|Generated map catalogs refreshed/i.test(lines)) return "Refreshing generated map catalogs.";
  if (/Starting Dune stack/i.test(lines)) return "Starting Dune services.";
  if (/Wrote local config/i.test(lines)) return "Saving server settings and token.";
  if (/Preparing fresh runtime state|Backing up existing local config/i.test(lines)) return "Preparing local runtime files.";
  if (/Resetting Postgres volume/i.test(lines)) return "Preparing the database volume.";
  if (/Unable to find image|Pulling|Downloaded newer image|Status: Downloaded/i.test(lines)) return "Downloading required Docker images.";
  if (/SteamCMD|download|app_update|Loading server assets/i.test(lines)) return "Downloading or updating Dune server files.";
  if (/run DB setup|database setup|Applying|world partitions/i.test(lines)) return "Preparing Dune database and world data.";
  return "Preparing deployment.";
}

function initTaskProgress(task: Task) {
  if (task.status === "succeeded") return { percent: 100, label: "Deployment complete." };
  if (task.status === "failed" || task.status === "cancelled") return { percent: 100, label: "Deployment stopped." };
  const lines = task.logLines.map((row) => row.line).join("\n");
  if (/Starting Dune stack/i.test(lines)) return { percent: 90, label: "Starting game services." };
  if (/Refresh generated map catalogs|Extracting .* catalog|Generated map catalogs refreshed/i.test(lines)) return { percent: 82, label: "Refreshing generated map catalogs." };
  if (/Downloading\/loading assets and running database setup\/update|SteamCMD|app_update|Loading server assets/i.test(lines)) return { percent: 68, label: "Downloading assets and preparing game data." };
  if (/Starting orchestrator container|Creating|Started|Running/i.test(lines)) return { percent: 42, label: "Starting deployment tools." };
  if (/Wrote local config|Generated battlegroup ID|Saving server settings/i.test(lines)) return { percent: 28, label: "Saving setup settings." };
  if (/Preparing fresh runtime state|Backing up existing local config|Resetting Postgres volume/i.test(lines)) return { percent: 18, label: "Preparing the server workspace." };
  if (/Using saved Web UI setup values|Generating battlegroup ID/i.test(lines)) return { percent: 10, label: "Reading setup details." };
  return { percent: task.status === "queued" ? 3 : 6, label: "Starting deployment." };
}
