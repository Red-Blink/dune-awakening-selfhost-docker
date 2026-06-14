import { randomUUID } from "node:crypto";
import { runDune, buildDuneArgs } from "./runner.js";

export class TaskManager {
  constructor(config) {
    this.config = config;
    this.tasks = new Map();
  }

  list() {
    return [...this.tasks.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  get(id) {
    return this.tasks.get(id) || null;
  }

  create(type, operation, payload = {}) {
    const id = randomUUID();
    const task = {
      id,
      type,
      operation,
      status: "queued",
      currentStep: "Queued",
      progressMessage: "",
      logLines: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      errorMessage: null,
      subscribers: new Set()
    };
    this.tasks.set(id, task);
    this.trim();
    queueMicrotask(() => this.run(task, payload));
    return publicTask(task);
  }

  subscribe(id, write) {
    const task = this.get(id);
    if (!task) return null;
    task.subscribers.add(write);
    return () => task.subscribers.delete(write);
  }

  async run(task, payload) {
    task.status = "running";
    task.currentStep = "Running";
    this.emit(task, "Task started");
    try {
      const operations = taskOperations(task.operation, payload);
      let lastCode = 0;
      for (const operation of operations) {
        task.currentStep = operation;
        this.emit(task, `Running ${operation}`);
        const args = buildDuneArgs(operation, payload);
        const result = await runDune(this.config, args, {
          allowedExitCodes: operation === "updateCheck" ? [0, 100] : [0],
          env: operation === "init" ? { DUNE_INIT_ASSUME_YES: "1" } : {},
          timeoutMs: taskTimeoutMs(this.config, operation),
          onLine: (text, stream) => this.append(task, text, stream)
        });
        lastCode = result.code;
      }
      task.status = "succeeded";
      task.exitCode = lastCode;
      task.currentStep = "Finished";
      task.finishedAt = new Date().toISOString();
      this.emit(task, "Task succeeded");
    } catch (error) {
      task.status = "failed";
      task.exitCode = Number.isInteger(error.code) ? error.code : null;
      task.errorMessage = error.message;
      task.currentStep = "Failed";
      task.finishedAt = new Date().toISOString();
      this.emit(task, error.message);
    }
  }

  append(task, text, stream) {
    const lines = String(text).split(/\r?\n/).filter(Boolean).map((line) => ({ timestamp: new Date().toISOString(), stream, line }));
    task.logLines.push(...lines);
    if (task.logLines.length > 1000) task.logLines.splice(0, task.logLines.length - 1000);
    for (const row of lines) this.emit(task, row.line);
  }

  emit(task, message) {
    task.progressMessage = message;
    const data = `data: ${JSON.stringify(publicTask(task))}\n\n`;
    for (const write of task.subscribers) write(data);
  }

  trim() {
    const all = this.list();
    for (const task of all.slice(this.config.taskRetention)) this.tasks.delete(task.id);
  }
}

export function taskTimeoutMs(config, operation) {
  if (["start", "stop", "restartAll", "restartService", "serverTitle", "init", "updateApply", "updateFixSteamcmd", "selfUpdateApply", "selfUpdatePrevious", "backupRestore", "userSettingsSaveAndRestart", "userSettingsResetAndRestart", "userSettingsRawAndRestart", "mapsApplySettings"].includes(operation)) {
    return Math.max(config.commandTimeoutMs, 30 * 60 * 1000);
  }
  return config.commandTimeoutMs;
}

export function taskOperations(operation, payload = {}) {
  if (operation === "restartAll") return ["stop", "start"];
  if (operation === "mapsApplySettings") {
    return [
      ...(payload.modeChanged ? ["mapsSetMode"] : []),
      ...(payload.memoryChanged ? ["memorySetNoRestart"] : []),
      ...(payload.modeChanged ? restartOperations(payload) : [])
    ];
  }
  if (operation === "userSettingsSaveAndRestart") return ["userSettingsSave", "userSettingsMaterializeCurrent", ...restartOperations(payload)];
  if (operation === "userSettingsResetAndRestart") {
    const resetOperation = payload.scope === "engine" ? "userSettingsResetEngineGameplay" : payload.scope === "global" ? "userSettingsResetGlobalGame" : "userSettingsResetGame";
    return [resetOperation, "userSettingsMaterializeCurrent", ...restartOperations(payload)];
  }
  if (operation === "userSettingsRawAndRestart") {
    const rawOperation = payload.scope === "profile" ? "userSettingsProfileWrite" : payload.scope === "engine" ? "userSettingsRawEngineWrite" : "userSettingsRawGameWrite";
    return [rawOperation, "userSettingsMaterializeCurrent", ...restartOperations(payload)];
  }
  return [operation];
}

function restartOperations(payload = {}) {
  if (payload.restartMode === "none") return [];
  if (payload.restartMode === "stack") return ["stop", "start"];
  if (payload.restartMode === "service") return ["restartService"];
  if (payload.restartMode === "respawn") return ["mapsDespawn", "mapsSpawn"];
  return [];
}

export function publicTask(task) {
  return {
    id: task.id,
    type: task.type,
    operation: task.operation,
    status: task.status,
    currentStep: task.currentStep,
    progressMessage: task.progressMessage,
    logLines: task.logLines,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    exitCode: task.exitCode,
    errorMessage: task.errorMessage
  };
}
