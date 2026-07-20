import type { Task } from "../../api/setup";
import { summarizeCommandText } from "../../lib/display";

export const GAME_UPDATE_TASK_KEY = "arrakis.gameUpdateTask";
export const STACK_UPDATE_TASK_KEY = "arrakis.stackUpdateTask";
export const UPDATE_RESULT_DISMISS_MS = 10000;

export function parseUpdateTask(task: Task) {
  const text = task.logLines.map((line) => line.line).join("\n");
  const current = firstVersionMatch(text, [/current(?: stack)?(?: build| version)?\s*[:=]\s*([^\n]+)/i, /installed(?: build| version)?\s*[:=]\s*([^\n]+)/i, /local(?: build| version)?\s*[:=]\s*([^\n]+)/i]);
  const latest = firstVersionMatch(text, [/latest(?: release| build| version)?\s*[:=]\s*([^\n]+)/i, /remote(?: build| version)?\s*[:=]\s*([^\n]+)/i, /available(?: build| version)?\s*[:=]\s*([^\n]+)/i]);
  const repository = firstVersionMatch(text, [/github repo\s*[:=]\s*([^\n]+)/i]);
  const versions = { current, latest, repository };
  if (task.status === "failed") return { status: "Check Failed", ...versions, reason: task.errorMessage || summarizeCommandText(text) };
  if (task.status !== "succeeded") return { status: "Checking...", ...versions, reason: task.progressMessage || "" };
  const updateAvailable = /update available|newer|can update|available update/i.test(text);
  const latestStatus = /up to date|already latest|no update|latest/i.test(text) && !updateAvailable;
  if (sameUpdateVersion(current, latest)) return { status: "Latest", ...versions, reason: summarizeCommandText(text) };
  if (updateAvailable) return { status: "Update Available", ...versions, reason: summarizeCommandText(text) };
  if (latestStatus) return { status: "Latest", ...versions, reason: summarizeCommandText(text) };
  return { status: current || latest ? "Completed" : "Version details unavailable", ...versions, reason: current || latest ? summarizeCommandText(text) : "Unable to parse version details from completed check." };
}

export function loadPersistedUpdateTask(key: string) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Task;
    return parsed?.id ? parsed : null;
  } catch {
    return null;
  }
}

export function persistUpdateTask(key: string, task: Task | null) {
  if (typeof window === "undefined") return;
  try {
    if (task && !isTerminalTaskStatus(task.status)) {
      window.localStorage.setItem(key, JSON.stringify(task));
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // The visible page state still works if localStorage is unavailable.
  }
}

export function updateDisplayValue(status: Record<string, string>, key: "current" | "latest", formatter?: (value: string) => string) {
  if (/checking/i.test(status.status)) return "Checking...";
  if (/updating/i.test(status.status)) return status[key] || "Updating...";
  const value = status[key] || "";
  return value ? (formatter ? formatter(value) : value) : "Unknown";
}

export function stackVersionButtonLabel(status: Record<string, string>) {
  const current = String(status.current || "").trim();
  const latest = String(status.latest || "").trim();
  if (/checking/i.test(String(status.status || ""))) return "Checking";
  if (current && latest && !sameUpdateVersion(current, latest)) return `${formatStackVersionLabel(current)} > ${formatStackVersionLabel(latest)}`;
  return formatStackVersionLabel(current || latest) || "Version";
}

export function stackVersionButtonTitle(status: Record<string, string>) {
  const current = String(status.current || "").trim();
  const latest = String(status.latest || "").trim();
  if (current && latest && !sameUpdateVersion(current, latest)) return "Update Available";
  if (status.status === "Update Available") return "Update Available";
  if (status.status === "Latest" || (current && latest && sameUpdateVersion(current, latest))) return "Latest";
  return "Open Updates";
}

export function formatStackVersionLabel(value: string) {
  const clean = String(value || "").trim();
  if (!clean) return "";
  if (/^v/i.test(clean)) return clean;
  if (/^\d+(?:\.\d+)*(?:[-+][\w.-]+)?$/i.test(clean)) return `v${clean}`;
  return clean;
}

export function canApplyUpdateStatus(status: Record<string, string>) {
  return status.status === "Update Available" && !sameUpdateVersion(status.current, status.latest);
}

export function stackReleaseNotesUrl(status: Record<string, string>) {
  const repository = String(status.repository || "").trim();
  const tag = String(status.latest || status.current || "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return "";
  if (!/^v?\d[A-Za-z0-9._+-]*$/.test(tag)) return "";
  return `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`;
}

export function sameUpdateVersion(current: string, latest: string) {
  const normalizedCurrent = normalizeUpdateVersion(current);
  const normalizedLatest = normalizeUpdateVersion(latest);
  return Boolean(normalizedCurrent && normalizedLatest && normalizedCurrent === normalizedLatest);
}

export function normalizeUpdateVersion(value: string) {
  return String(value || "")
    .trim()
    .replace(/^v/i, "")
    .replace(/\s+\(.+\)$/i, "")
    .toLowerCase();
}

export function firstVersionMatch(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const value = match[1].trim().slice(0, 80);
      if (/^(unknown|unavailable|n\/a|none)$/i.test(value)) continue;
      return value;
    }
  }
  return "";
}

function isTerminalTaskStatus(status: string) {
  return ["succeeded", "failed", "cancelled"].includes(status);
}
