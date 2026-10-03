import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, readSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { downloadFailureMessage } from "./downloadFailure.js";

const RUN_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
const STATES = new Set(["running", "succeeded", "failed"]);
const HELPER_START_TIMEOUT_MS = 2 * 60 * 1000;

export function initializeSelfUpdateStatus(repoRoot, runId, now = Date.now()) {
  const cleanRunId = validateRunId(runId);
  const directory = join(repoRoot, "runtime", "generated", "self-update-status");
  const statusPath = join(directory, `${cleanRunId}.env`);
  const temporaryPath = `${statusPath}.tmp.${process.pid}`;
  const timestamp = new Date(now).toISOString();
  mkdirSync(directory, { recursive: true });
  writeFileSync(temporaryPath, [
    `run_id=${cleanRunId}`,
    "state=running",
    "stage=launching",
    "percent=1",
    "message=Starting the update helper.",
    `started_at=${timestamp}`,
    `updated_at=${timestamp}`,
    "finished_at="
  ].join("\n") + "\n", { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, statusPath);
  return statusPath;
}

export function readSelfUpdateStatus(repoRoot, runId, options = {}) {
  const cleanRunId = validateRunId(runId);

  const statusPath = join(repoRoot, "runtime", "generated", "self-update-status", `${cleanRunId}.env`);
  let source;
  try {
    source = readFileSync(statusPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return missingStatusResult(cleanRunId, options);
    throw error;
  }
  if (Buffer.byteLength(source, "utf8") > 16 * 1024) throw new Error("Console update status file is unexpectedly large.");

  const fields = parseStatusFields(source);
  if (fields.run_id !== cleanRunId) throw new Error("Console update status does not match the requested run.");
  if (!STATES.has(fields.state)) throw new Error("Console update status has an invalid state.");

  const result = {
    runId: cleanRunId,
    state: fields.state,
    stage: safeText(fields.stage, 64) || "unknown",
    percent: boundedPercent(fields.percent),
    message: safeText(fields.message, 500),
    startedAt: safeTimestamp(fields.started_at),
    updatedAt: safeTimestamp(fields.updated_at),
    finishedAt: safeTimestamp(fields.finished_at)
  };
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  if (result.state === "failed") {
    const failure = failureFromRunLog(repoRoot, cleanRunId, now);
    if (failure) result.message = failure;
  }
  const updatedAt = Date.parse(result.updatedAt || result.startedAt || "");
  const consoleStartedAt = Number(options.consoleStartedAt);
  const helperStartedAt = Date.parse(result.startedAt || "");
  if (result.state === "running" && result.stage === "launching" && Number.isFinite(consoleStartedAt) && Number.isFinite(helperStartedAt) && consoleStartedAt > helperStartedAt + 1000) {
    return {
      ...result,
      state: "succeeded",
      stage: "complete",
      percent: 100,
      message: "The updated Console is running. The previous helper did not finish its progress record.",
      updatedAt: new Date(consoleStartedAt).toISOString(),
      finishedAt: new Date(consoleStartedAt).toISOString(),
      recovered: true
    };
  }
  if (result.state === "running" && result.stage === "launching" && Number.isFinite(updatedAt) && now - updatedAt >= HELPER_START_TIMEOUT_MS) {
    return {
      ...result,
      state: "failed",
      stage: "launching",
      message: "The update helper did not begin within two minutes. Review runtime/generated/web-self-update.log for details.",
      finishedAt: new Date(now).toISOString()
    };
  }
  return result;
}

function failureFromRunLog(repoRoot, runId, now) {
  let fd;
  try {
    fd = openSync(join(repoRoot, "runtime", "generated", "web-self-update.log"), "r");
    const size = fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, 4096));
    readSync(fd, head, 0, head.length, 0);
    // The shared log can belong to a newer attempt. Never relabel an old task
    // using another run's errors, and bound reads even for huge build logs.
    if (!head.toString().split(/\r?\n/).includes(`Console update run: ${runId}`)) return "";
    const tail = Buffer.alloc(Math.min(size, 64 * 1024));
    readSync(fd, tail, 0, tail.length, size - tail.length);
    return downloadFailureMessage(tail.toString(), now);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function validateRunId(runId) {
  const cleanRunId = String(runId || "").trim();
  if (!RUN_ID_PATTERN.test(cleanRunId)) throw Object.assign(new Error("Invalid console update run ID."), { code: "INVALID_RUN_ID" });
  return cleanRunId;
}

function missingStatusResult(runId, options) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const taskStartedAt = Date.parse(String(options.taskStartedAt || ""));
  const consoleStartedAt = Number(options.consoleStartedAt);
  if (Number.isFinite(taskStartedAt) && Number.isFinite(consoleStartedAt) && consoleStartedAt > taskStartedAt + 1000) {
    return {
      runId,
      state: "succeeded",
      stage: "complete",
      percent: 100,
      message: "The updated Console is running. The previous helper did not leave a progress record.",
      startedAt: new Date(taskStartedAt).toISOString(),
      updatedAt: new Date(consoleStartedAt).toISOString(),
      finishedAt: new Date(consoleStartedAt).toISOString(),
      recovered: true
    };
  }
  if (Number.isFinite(taskStartedAt) && now - taskStartedAt >= HELPER_START_TIMEOUT_MS) {
    return {
      runId,
      state: "failed",
      stage: "launching",
      percent: 1,
      message: "The update helper did not report progress within two minutes. Review runtime/generated/web-self-update.log for details.",
      startedAt: new Date(taskStartedAt).toISOString(),
      updatedAt: null,
      finishedAt: new Date(now).toISOString()
    };
  }
  return { runId, state: "pending", stage: "launching", percent: 1, message: "Waiting for the update helper to start." };
}

function parseStatusFields(source) {
  const fields = {};
  for (const line of String(source).split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[a-z_]+$/.test(key)) continue;
    fields[key] = line.slice(separator + 1).trim();
  }
  return fields;
}

function boundedPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : 0;
}

function safeText(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength);
}

function safeTimestamp(value) {
  const clean = safeText(value, 64);
  return clean && Number.isFinite(Date.parse(clean)) ? clean : null;
}
