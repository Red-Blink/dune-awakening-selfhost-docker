import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { runDune, buildDuneArgs, validateServiceName } from "./runner.js";
import { liveItemGrantWarning } from "./grantResults.js";
import { createUpdateCheckCache } from "./services/updateCheckCache.js";
import { initializeSelfUpdateStatus } from "./services/selfUpdateStatus.js";
import { summarizeMapWriteFlush } from "./services/mapWriteSummary.js";
import { withTimeout } from "./services/withTimeout.js";
import { clampInt } from "./jsonStore.js";
import { redactDbError } from "./db.js";

// Operations that leave a map down with the database still reachable, so
// anything queued for that map can be applied before it comes back up. "stop"
// is deliberately absent: stop-all.sh removes the Postgres container too, so
// there is nothing to write to once it finishes. restartServiceStop/
// sietchesRestartStop (not their Start halves) cover survival/Sietch
// restarts -- see taskOperations, which splits those into separate stop and
// start operations so the flush lands between them instead of after both.
const MAP_DOWN_OPERATIONS = new Set(["mapsDespawn", "restartService", "restartServiceStop", "sietchesRestartStop", "stopGameServersForDbWrites"]);

// Generous by default: a flush pass can include a full-database safety backup
// before the first delete it applies. Still far below the 30-minute task
// timeout a restart operation gets, so this fires first and lets the restart
// report the reason and carry on.
export function mapWriteFlushTimeoutMs() {
  return clampInt(process.env.ADMIN_MAP_WRITE_FLUSH_TIMEOUT_MS, 300000, 1000, 1800000);
}

export class TaskManager {
  constructor(config, options = {}) {
    this.config = config;
    this.onMapDown = options.onMapDown || null;
    this.tasks = new Map();
    this.runDockerCommand = options.runDockerCommand || runDockerCommand;
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

  // `options.env` is deliberately NOT stored on the task: this.tasks retains
  // tasks for config.taskRetention and publicTask() serializes them to callers,
  // so a secret placed there would leak. It lives only in this closure.
  create(type, operation, payload = {}, options = {}) {
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
      queueMicrotask(() => this.run(task, payload, options.env));
    }
    return publicTask(task);
  }

  subscribe(id, write) {
    const task = this.get(id);
    if (!task) return null;
    task.subscribers.add(write);
    return () => task.subscribers.delete(write);
  }

  async run(task, payload, env) {
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
            env: { ...(operation === "init" ? { DUNE_INIT_ASSUME_YES: "1" } : {}), ...(env || {}) },
            timeoutMs: taskTimeoutMs(this.config, operation),
            onLine: (text, stream) => this.append(task, text, stream)
          });
        }

        const grantWarning = itemGrantTaskWarning(operation, result);
        if (grantWarning) throw Object.assign(new Error(grantWarning), { code: 1, stdout: result.stdout, stderr: result.stderr });
        lastCode = result.code;
        if (MAP_DOWN_OPERATIONS.has(operation)) await this.flushPendingMapWrites(task, operation, payload);
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
    const composeProjectName = process.env.DUNE_COMPOSE_PROJECT_NAME || process.env.COMPOSE_PROJECT_NAME;
    if (!composeProjectName) throw new Error("Main Dune Compose project name was not provided to the Console.");
    const helperImage = process.env.DUNE_SYSTEMD_HELPER_IMAGE || "redblink-dune-docker-console:dev";
    const hostRepoRoot = process.env.DUNE_HOST_REPO_ROOT || this.config.hostRepoRoot || this.config.repoRoot;
    const hostUid = process.env.DUNE_HOST_UID || String(process.getuid?.() ?? 0);
    const hostGid = process.env.DUNE_HOST_GID || String(process.getgid?.() ?? 0);
    const dockerSocketGid = process.env.DOCKER_SOCKET_GID || detectDockerSocketGid();
    const extraEnv = [
      `DUNE_SELF_UPDATE_RUN_ID=${task.id}`,
      `DUNE_SELF_UPDATE_BUILD_TIMEOUT_SECONDS=${boundedBuildTimeoutSeconds(process.env.DUNE_SELF_UPDATE_BUILD_TIMEOUT_SECONDS)}`,
      ...(process.env.DUNE_SELF_UPDATE_TOKEN ? ["DUNE_SELF_UPDATE_TOKEN"] : [])
    ];
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
    initializeSelfUpdateStatus(this.config.repoRoot, task.id);
    await cleanupStaleSelfUpdateHelpers(this.config.repoRoot, this.runDockerCommand);
    const result = await this.runDockerCommand(buildSelfUpdateHelperDockerArgs({
      helperName,
      hostRepoRoot,
      composeProjectName,
      helperImage,
      hostUid,
      hostGid,
      dockerSocketGid,
      extraEnv,
      command
    }), this.config.repoRoot);

    this.append(task, `Update helper started: ${result.stdout.trim() || helperName}`, "stdout");
    this.append(task, `Update log: ${logFile}`, "stdout");
    task.currentStep = "Update helper running";
    this.emit(task, "Update helper is running. The Web UI may reconnect while the console restarts.");
  }

  // The background poller in server.js is the general safety net for queued
  // writes, but a respawn closes its own window -- mapsDespawn is followed
  // immediately by mapsSpawn -- so flush here rather than hope a tick lands in
  // between. Never fails the restart: an unreachable database just means the
  // entries stay queued for the next window.
  // Never allowed to hang: this runs between a restart's stop and start halves,
  // so an await that never settles leaves the battlegroup down indefinitely.
  // A flush that overruns is reported and abandoned; its entries stay queued
  // and apply on a later pass, which is strictly better than a restart that
  // never finishes. See services/withTimeout.js.
  async flushPendingMapWrites(task, operation, payload = {}) {
    if (!this.onMapDown) return;
    try {
      const timeoutMs = mapWriteFlushTimeoutMs();
      const result = await withTimeout(
        Promise.resolve().then(() => this.onMapDown(operation, payload)),
        timeoutMs,
        `Queued map writes did not finish within ${Math.round(timeoutMs / 1000)}s; continuing the restart. They stay queued and apply on a later pass.`);
      // Failures are prefixed so they survive onto task.warnings. Without that
      // they would reach the task log only, and a restart's log sits behind a
      // disclosure the operator has to think to open -- too easy to miss for a
      // delete that silently did not happen.
      for (const line of summarizeMapWriteFlush(result)) {
        if (line.stream === "stderr") this.appendQueuedWriteWarning(task, line.text);
        else this.append(task, line.text, line.stream);
      }
    } catch (error) {
      // redactDbError, not the raw message: this line is lifted onto
      // task.warnings and rendered in the browser.
      this.appendQueuedWriteWarning(task, `Queued map writes were not applied: ${redactDbError(error)}`);
    }
  }

  // Only the console's own code may raise a queued-write warning. Subprocess
  // output reaches append() verbatim (see the onLine hook above), so without
  // this a spawned script could print the marker and forge an operator-facing
  // warning. USERSETTINGS_WARNING is deliberately not stripped: usersettings.py
  // is the shipped script that raises it, and that is its documented path.
  appendQueuedWriteWarning(task, text) {
    this.append(task, QUEUED_WRITE_WARNING_PREFIX + stripQueuedWriteWarningPrefix(String(text)), "stderr", { internal: true });
  }

  append(task, text, stream, { internal = false } = {}) {
    const lines = String(text).split(/\r?\n/).filter(Boolean)
      .map((line) => ({ timestamp: new Date().toISOString(), stream, line: internal ? line : stripQueuedWriteWarningPrefix(line) }));
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
      "--label", "io.github.red-blink.dune-selfhost.role=self-update-helper",
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
      "--entrypoint", "/bin/sh",
      helperImage,
      "-lc", command
    ];
}

function isSelfUpdateApplyOperation(operation) {
  return operation === "selfUpdateApply" || operation === "selfUpdateQaApply";
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

export async function cleanupStaleSelfUpdateHelpers(cwd, runCommand) {
  const listed = await runCommand(["ps", "-a", "--format", "{{.Names}}\t{{.State}}"], cwd);
  const helpers = listed.stdout.split(/\r?\n/).map((line) => {
    const [name = "", state = ""] = line.trim().split(/\s+/, 2);
    return { name, state };
  }).filter(({ name }) => /^(?:dune-web-self-update-\d+|dune-console-self-update-\d+)$/.test(name));
  const staleAfterMs = (boundedBuildTimeoutSeconds(process.env.DUNE_SELF_UPDATE_BUILD_TIMEOUT_SECONDS) + 300) * 1000;
  const now = Date.now();
  const stale = helpers.filter(({ name, state }) => state !== "running" || selfUpdateHelperAgeMs(name, now) > staleAfterMs);
  if (stale.length) await runCommand(["rm", "-f", ...stale.map(({ name }) => name)], cwd);
  const active = helpers.filter((helper) => !stale.includes(helper));
  if (active.length) throw Object.assign(new Error("Another console update is already running. Wait for it to finish before retrying."), { code: 75 });
}

export function selfUpdateHelperAgeMs(name, now = Date.now()) {
  const milliseconds = String(name || "").match(/^dune-web-self-update-(\d{13})$/)?.[1];
  if (milliseconds) return Math.max(0, now - Number(milliseconds));
  const seconds = String(name || "").match(/^dune-console-self-update-(\d{10})$/)?.[1];
  if (seconds) return Math.max(0, now - Number(seconds) * 1000);
  return 0;
}

function boundedBuildTimeoutSeconds(value) {
  const number = Number(value || 1800);
  return Number.isInteger(number) && number >= 60 && number <= 7200 ? number : 1800;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function taskTimeoutMs(config, operation) {
  if (["backupSystemCreate", "backupSystemRestore", "start", "stop", "restartAll", "stopGameServersForDbWrites", "restartService", "restartServiceStop", "restartServiceStart", "serverTitle", "serverConfig", "init", "updateApply", "updateFixSteamcmd", "selfUpdateApply", "backupRestore", "storageCleanupImages", "storageCleanupBuildCache", "userSettingsSaveAndRestart", "userSettingsResetAndRestart", "userSettingsRawAndRestart", "mapsApplySettings", "mapsRespawn", "sietchesSetActive", "sietchesRestart", "sietchesRestartStop", "sietchesRestartStart", "sietchesReconcile", "deepdesertAction"].includes(operation)) {
    return Math.max(config.commandTimeoutMs, 30 * 60 * 1000);
  }
  return config.commandTimeoutMs;
}

export function taskOperations(operation, payload = {}) {
  if (operation === "restartAll") return ["stopGameServersForDbWrites", "stop", "start"];
  if (operation === "restartService") return restartServiceOperations(payload);
  // Every Sietch partition is a Survival_1 sub-partition, so this always
  // splits -- the shell layer resolves primary vs. secondary internally.
  if (operation === "sietchesRestart") return ["sietchesRestartStop", "sietchesRestartStart"];
  // The only way to restart a map that is neither Survival_1 nor the Overmap:
  // those two have managed services, everything else (Deep Desert, the SH_*
  // hubs) exists only as a spawned partition container. One task so a failed
  // spawn cannot be mistaken for a completed restart.
  if (operation === "mapsRespawn") return restartOperations({ restartMode: "respawn", target: payload.target });
  if (operation === "mapsApplySettings") {
    return [
      ...(payload.memoryChanged ? ["memorySetNoRestart"] : []),
      ...(payload.modeChanged ? ["mapsSetMode"] : []),
      ...(payload.modeChanged ? restartOperations(payload) : [])
    ];
  }
  if (operation === "userSettingsSaveAndRestart") return ["userSettingsSave", "userSettingsMaterializeCurrent", ...restartOperations(payload)];
  if (operation === "userSettingsResetAndRestart") {
    const resetOperation = payload.scope === "engine"
      ? "userSettingsResetEngineGameplay"
      : payload.scope === "mapEngine"
        ? "userSettingsResetMapEngine"
        : payload.scope === "partitionEngine"
          ? "userSettingsResetPartitionEngine"
          : payload.scope === "global"
            ? "userSettingsResetGlobalGame"
            : "userSettingsResetGame";
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
  if (payload.restartMode === "service") return restartServiceOperations(payload);
  if (payload.restartMode === "respawn" && payload.mode === "disabled") return [];
  if (payload.restartMode === "respawn") return ["mapsDespawn", "mapsSpawn"];
  return [];
}

// Survival/Sietches are the only restart targets that host player bases and
// generators, so only they need the flush window a stop/start split
// provides -- other services (overmap, gateway, director, text-router)
// never host bases, so a single combined op is still correct for them. Used
// both for a direct "Restart Battlegroup" task and for settings-driven
// restarts routed through restartOperations, so both paths get the fix.
function restartServiceOperations(payload = {}) {
  const service = validateServiceName(payload.service);
  return service === "survival" || service === "survival-1"
    ? ["restartServiceStop", "restartServiceStart"]
    : ["restartService"];
}

const USERSETTINGS_WARNING_PREFIX = "USERSETTINGS_WARNING: ";
// Queued base/vehicle writes that did not apply during a restart's map-down
// window. Same in-log prefix convention as the usersettings warning above: the
// prefixed line stays in the task log, and taskWarnings lifts its text onto the
// task so a panel can show it without the caller parsing log lines.
const QUEUED_WRITE_WARNING_PREFIX = "QUEUED_WRITE_WARNING: ";
const WARNING_PREFIXES = [USERSETTINGS_WARNING_PREFIX, QUEUED_WRITE_WARNING_PREFIX];

function stripQueuedWriteWarningPrefix(line) {
  return line.startsWith(QUEUED_WRITE_WARNING_PREFIX) ? line.slice(QUEUED_WRITE_WARNING_PREFIX.length) : line;
}

// usersettings.py prints one of these lines per Advanced Editor content warning (duplicate
// keys, PvP/PvE selector overlaps with a toggle, legacy guild-alias overrides) instead of
// silently dropping the content -- surfaced here as a distinct field so callers can show it
// without parsing logLines themselves, while logLines keeps the raw line for diagnostics.
// The prefixes are an internal marker so taskWarnings can lift a line onto the
// task; they are not for operators. The log is now a disclosure anyone can
// open, and the de-prefixed text already renders above it, so shipping the
// sentinel would just be leaked plumbing shown twice.
function withoutWarningPrefix(entry) {
  const prefix = WARNING_PREFIXES.find((candidate) => entry.line.startsWith(candidate));
  return prefix ? { ...entry, line: entry.line.slice(prefix.length) } : entry;
}

export function taskWarnings(task) {
  return task.logLines
    .map((entry) => {
      const prefix = WARNING_PREFIXES.find((candidate) => entry.line.startsWith(candidate));
      return prefix ? entry.line.slice(prefix.length) : "";
    })
    .filter((text) => text !== "");
}

export function publicTask(task) {
  return {
    id: task.id,
    type: task.type,
    operation: task.operation,
    status: task.status,
    currentStep: task.currentStep,
    progressMessage: task.progressMessage,
    logLines: task.logLines.map(withoutWarningPrefix),
    warnings: taskWarnings(task),
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    exitCode: task.exitCode,
    errorMessage: task.errorMessage
  };
}
