import type { Task } from "../api/setup";
import { stripAnsi } from "./display";

export function funcomTokenMismatchDetected(text: string) {
  const value = text || "";
  if (/Funcom token mismatch detected|Invalid Authorization to manage SelfHosted Battlegroup/i.test(value)) return true;
  if (/ACCESS_DENIED|AccessDenied|access denied|invalid authorization|Unauthorized/i.test(value)) {
    return /Battlegroup|SelfHosted|Funcom|FuncomLiveServices/i.test(value);
  }
  if (/(?:HTTP|status|statusCode|response|code)[^,\n]*(?:401|403)\b/i.test(value)) {
    return /Battlegroup|SelfHosted|Funcom|FuncomLiveServices/i.test(value);
  }
  return false;
}

export function conciseTaskError(task: Task) {
  if (/^(GitHub|Docker Hub|Funcom registry|Container registry|Download service) request limit reached\. /.test(task.errorMessage || "")) return task.errorMessage!;
  const text = task.logLines.map((line) => line.line).join("\n");
  const steamState = stripAnsi(text).match(/Error!\s+App\s+'[^']+'\s+state is\s+[^.]+(?:\s+after update job)?/i)?.[0];
  const steamAttempts = stripAnsi(text).match(/SteamCMD failed after \d+ attempts\./i)?.[0];
  if (steamAttempts && steamState) return `${steamAttempts} ${steamState}`;
  if (steamState) return steamState;
  if (steamAttempts) return steamAttempts;

  const lines = task.logLines.map((line) => stripAnsi(line.line).trim()).filter(Boolean);
  const candidates = [task.errorMessage || "", ...lines].filter(Boolean).map((line) => line.replace(/^dune\s+.+?\s+failed with exit \d+$/i, "").trim()).filter((line) => {
    if (!line) return false;
    if (/^===.*===$/.test(line)) return false;
    if (/^Steam app id:/i.test(line)) return false;
    if (/^Running \w+$/i.test(line)) return false;
    if (/^Task started$/i.test(line)) return false;
    // Command echoes aren't failures: SteamCMD's ShutdownOnFailedCommand
    // option contains "failed" even when the download succeeds.
    if (/^(?:\[dune\]\s*)?\$\s/.test(line)) return false;
    return true;
  });
  const seen = new Set<string>();
  const unique = candidates.filter((line) => {
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  });
  return unique.find((line) => /failed|error|could not|cannot|denied|unavailable/i.test(line)) || unique[0] || "Task failed.";
}
