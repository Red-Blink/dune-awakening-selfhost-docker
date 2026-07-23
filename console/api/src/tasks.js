import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { runDune, buildDuneArgs } from "./runner.js";
import { liveItemGrantWarning } from "./grantResults.js";
import { createUpdateCheckCache } from "./services/updateCheckCache.js";

export class TaskManager {
  constructor(config, options = {}) {
    this.config = config;
    this.tasks = new Map();
    this.updateCheckCache = options.updateCheckCache || createUpdateCheckCache(config, {
      collect: () => runDune(config, buildDuneArgs("updateCheck"), {
        allowedExitCodes: [0, 100],
        timeoutMs: taskTimeoutMs(config, "updateCheck")
      })
    });
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

    let cachedHit = null;
    if (operation === "updateCheck" && payload.fresh !== true) {
      cachedHit = this.updateCheckCache.peek();
    }

    if (cachedHit) {
      task.currentStep = "Running";
      this.recordUpdateCheckResult(task, cachedHit);
      this.completeTaskSucceeded(task, cachedHit.code);
    }

    this.tasks.set(id, task);
    this.trim();

    if (!cachedHit) {
      queueMicrotask(() => this.run(task, payload));
    }
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
      if (isSelfUpdateApplyOperation(task.operation)) {
        await this.runSelfUpdateHelperTask(task, payload);
        return;
      }

      const operations = taskOperations(task.operation, payload);
      let lastCode = 0;
      for (const operation of operations) {
        task.currentStep = operation;
        this.emit(task, `Running ${operation}`);

        let result;
        if (operation === "updateCheck") {
          result = await this.readUpdateCheck(task, payload);
        } else {
          const args = buildDuneArgs(operation, payload);
          result = await runDune(this.config, args, {
            allowedExitCodes: operation === "selfUpdateCheck" ? [0, 100] : [0],
            env: operation === "init" ? { DUNE_INIT_ASSUME_YES: "1" } : {},
            timeoutMs: taskTimeoutMs(this.config, operation),
            onLine: (text, stream) => this.append(task, text, stream)
          });
        }

        const grantWarning = itemGrantTaskWarning(operation, result);
        if (grantWarning) throw Object.assign(new Error(grantWarning), { code: 1, stdout: result.stdout, stderr: result.stderr });
        lastCode = result.code;
      }
      if (["updateApply", "updateFixSteamcmd"].includes(task.operation)) {
        this.updateCheckCache.invalidate();
      }
      this.completeTaskSucceeded(task, lastCode);
    } catch (error) {
      task.status = "failed";
      task.exitCode = Number.isInteger(error.code) ? error.code : null;
      task.errorMessage = error.message;
      task.currentStep = "Failed";
      task.finishedAt = new Date().toISOString();
      this.emit(task, error.message);
    }
  }

  async runSelfUpdateHelperTask(task, payload) {
    const args = buildDuneArgs(task.operation, payload);
    const helperName = `dune-web-self-update-${Date.now()}`;
    const composeProjectName = process.env.DUNE_COMPOSE_PROJECT_NAME || process.env.COMPOSE_PROJECT_NAME || "dune-awakening-selfhost-docker";
    const helperImage = process.env.DUNE_SYSTEMD_HELPER_IMAGE || "redblink-dune-docker-console:dev";
    const hostRepoRoot = process.env.DUNE_HOST_REPO_ROOT || this.config.hostRepoRoot || this.config.repoRoot;
    const hostUid = process.env.DUNE_HOST_UID || String(process.getuid?.() ?? 0);
    const hostGid = process.env.DUNE_HOST_GID || String(process.getgid?.() ?? 0);
    const dockerSocketGid = process.env.DOCKER_SOCKET_GID || detectDockerSocketGid();
    const logFile = "runtime/generated/web-self-update.log";
    const command = [
      "set -eu",
      "mkdir -p runtime/generated",
      `echo "[$(date -Is)] Starting Web UI stack update: runtime/scripts/dune ${args.map(shellQuote).join(" ")}" > ${shellQuote(logFile)}`,
      `DUNE_WEB_SELF_UPDATE_HELPER=1 runtime/scripts/dune ${args.map(shellQuote).join(" ")} >> ${shellQuote(logFile)} 2>&1`,
      `echo "[$(date -Is)] Web UI stack update finished" >> ${shellQuote(logFile)}`
    ].join("\n");

    task.currentStep = "Starting update helper";
    this.emit(task, "Starting detached update helper");
    const result = await runDockerCommand(buildSelfUpdateHelperDockerArgs({
      helperName,
      hostRepoRoot,
      composeProjectName,
      helperImage,
      hostUid,
      hostGid,
      dockerSocketGid,
      command
    }), this.config.repoRoot);

    this.append(task, `Update helper started: ${result.stdout.trim() || helperName}`, "stdout");
    this.append(task, `Update log: ${logFile}`, "stdout");
    task.status = "succeeded";
    task.exitCode = 0;
    task.currentStep = "Update helper started";
    task.finishedAt = new Date().toISOString();
    this.emit(task, "Update helper started. The Web UI may reconnect while the console restarts.");
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

  async readUpdateCheck(task, payload) {
    const result = await this.updateCheckCache.read({ fresh: payload.fresh === true });
    this.recordUpdateCheckResult(task, result);
    return result;
  }

  recordUpdateCheckResult(task, result) {
    const ageSeconds = Math.max(0, Math.round((Date.now() - result.sampledAtMs) / 1000));
    this.append(task, result.fromCache
      ? `Reusing update check result from ${ageSeconds}s ago (cached).`
      : "Ran a live Steam update check.", "stdout");
    if (result.stdout) this.append(task, result.stdout, "stdout");
    if (result.stderr) this.append(task, result.stderr, "stderr");
  }

  completeTaskSucceeded(task, exitCode) {
    task.status = "succeeded";
    task.exitCode = exitCode;
    task.currentStep = "Finished";
    task.finishedAt = new Date().toISOString();
    this.emit(task, "Task succeeded");
  }

  trim() {
    const all = this.list();
    for (const task of all.slice(this.config.taskRetention)) this.tasks.delete(task.id);
  }
}

function itemGrantTaskWarning(operation, result) {
  if (operation !== "adminGiveItem" && operation !== "adminGiveItemId") return "";
  return liveItemGrantWarning(result);
}

export function buildSelfUpdateHelperDockerArgs({
  helperName,
  hostRepoRoot,
  composeProjectName,
  helperImage,
  hostUid = "0",
  hostGid = "0",
  dockerSocketGid = "0",
  extraEnv = [],
  command
}) {
  return [
      "run",
      "--rm",
      "-d",
      "--name", helperName,
      "--user", `${hostUid}:${hostGid}`,
      "--group-add", dockerSocketGid,
      "--network", "host",
      "-v", `${hostRepoRoot}:/repo`,
      "-v", "/var/run/docker.sock:/var/run/docker.sock",
      "-e", `DUNE_HOST_REPO_ROOT=${hostRepoRoot}`,
      "-e", `COMPOSE_PROJECT_NAME=${composeProjectName}`,
      "-e", `DUNE_COMPOSE_PROJECT_NAME=${composeProjectName}`,
      "-e", `DUNE_HOST_UID=${hostUid}`,
      "-e", `DUNE_HOST_GID=${hostGid}`,
      "-e", `DOCKER_SOCKET_GID=${dockerSocketGid}`,
      ...extraEnv.flatMap((value) => ["-e", value]),
      "-w", "/repo",
      helperImage,
      "sh", "-lc", command
    ];
}

function isSelfUpdateApplyOperation(operation) {
  return operation === "selfUpdateApply";
}

export function detectDockerSocketGid() {
  try {
    return String(statSync("/var/run/docker.sock").gid);
  } catch {
    return "0";
  }
}

function runDockerCommand(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { cwd, shell: false, env: { ...process.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(Object.assign(new Error(`docker ${args.join(" ")} failed with exit ${code}: ${stderr || stdout}`), { code, stdout, stderr }));
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function taskTimeoutMs(config, operation) {
  if (["start", "stop", "restartAll", "restartService", "serverTitle", "serverConfig", "init", "updateApply", "updateFixSteamcmd", "selfUpdateApply", "backupRestore", "storageCleanupImages", "storageCleanupBuildCache", "userSettingsSaveAndRestart", "userSettingsResetAndRestart", "userSettingsRawAndRestart", "mapsApplySettings", "sietchesSetActive", "sietchesReconcile"].includes(operation)) {
    return Math.max(config.commandTimeoutMs, 30 * 60 * 1000);
  }
  return config.commandTimeoutMs;
}

export function taskOperations(operation, payload = {}) {
  if (operation === "restartAll") return ["stop", "start"];
  if (operation === "mapsApplySettings") {
    return [
      ...(payload.memoryChanged ? ["memorySetNoRestart"] : []),
      ...(payload.modeChanged ? ["mapsSetMode"] : []),
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
  if (payload.restartMode === "respawn" && payload.mode === "disabled") return [];
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
