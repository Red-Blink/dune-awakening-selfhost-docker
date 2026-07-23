import { useEffect, useState } from "react";
import { BookOpen, ChevronDown, ChevronUp } from "lucide-react";
import { setupApi, type Task } from "../../api/setup";
import { updatesApi } from "../../api/updates";
import { KeyValueGrid, StatusPill } from "../../components/common/DisplayPrimitives";
import { formatUiSentence, stripAnsi } from "../../lib/display";
import { conciseTaskError } from "../../lib/taskDisplay";
import {
  canApplyUpdateStatus,
  firstVersionMatch,
  formatStackVersionLabel,
  GAME_UPDATE_TASK_KEY,
  loadPersistedUpdateTask,
  normalizeUpdateVersion,
  parseUpdateTask,
  persistUpdateTask,
  stackReleaseNotesUrl,
  STACK_UPDATE_TASK_KEY,
  UPDATE_RESULT_DISMISS_MS,
  updateDisplayValue
} from "./updateUtils";

type HomeTaskResult = { status: "running" | "succeeded" | "failed" | "stopped"; title: string; message?: string; details?: string };
const STACK_UPDATE_HANDOFF_SECONDS = 180;
const STACK_UPDATE_REFRESH_SECONDS = 5;
const STACK_UPDATE_EXPECTED_VERSION_KEY = "arrakis.stackUpdateExpectedVersion";

type UpdatesPanelProps = {
  confirmAction: (message: string) => Promise<boolean>;
  waitForTask: (task: Task) => Promise<Task>;
  parseKeyValueText: (text: string) => Record<string, string>;
  formatTimerStatus: (value: string) => string;
  commandStatusSummary: (result: { stdout?: string; stderr?: string; exitCode?: number } | null) => { status: string; reason: string };
  taskTechnicalDetails: (task: Task) => string;
  formatResultTitle: (value: unknown, pending?: boolean) => string;
  formatResultMessage: (value: unknown) => string;
};

export function UpdatesPanel({
  confirmAction,
  waitForTask,
  parseKeyValueText,
  formatTimerStatus,
  commandStatusSummary,
  taskTechnicalDetails,
  formatResultTitle,
  formatResultMessage
}: UpdatesPanelProps) {
  const [gameUpdateTask, setGameUpdateTask] = useState<Task | null>(() => loadPersistedUpdateTask(GAME_UPDATE_TASK_KEY));
  const [stackUpdateTask, setStackUpdateTask] = useState<Task | null>(() => loadPersistedUpdateTask(STACK_UPDATE_TASK_KEY));
  const [gameStatus, setGameStatus] = useState<Record<string, string>>(() => gameUpdateTask && !isTerminalTask(gameUpdateTask.status) ? { status: "Updating", current: "", latest: "", reason: "Game update is running." } : { status: "Not checked", current: "", latest: "", reason: "" });
  const [stackStatus, setStackStatus] = useState<Record<string, string>>(() => stackUpdateTask && !isTerminalTask(stackUpdateTask.status) ? { status: "Updating", current: "", latest: "", reason: "Console update is running." } : { status: "Not checked", current: "", latest: "", reason: "" });
  const [gameSteamcmdFixTask, setGameSteamcmdFixTask] = useState<Task | null>(null);
  const [autoGame, setAutoGame] = useState<{ stdout?: string; stderr?: string; exitCode?: number } | null>(null);
  const [autoGameOpen, setAutoGameOpen] = useState(false);
  const [autoGameLoading, setAutoGameLoading] = useState(true);
  const [autoGameEnabled, setAutoGameEnabled] = useState(false);
  const [autoGameIntervalMinutes, setAutoGameIntervalMinutes] = useState("60");
  const [autoGameApplyEnabled, setAutoGameApplyEnabled] = useState(true);
  const [autoGameNotifyEnabled, setAutoGameNotifyEnabled] = useState(true);
  const [autoGameNotifyMinutes, setAutoGameNotifyMinutes] = useState("15");
  const [autoGameWaitUntilEmpty, setAutoGameWaitUntilEmpty] = useState(false);
  const [autoGameMaxWaitMinutes, setAutoGameMaxWaitMinutes] = useState("360");
  const [autoGameResult, setAutoGameResult] = useState<HomeTaskResult | null>(null);
  const [stackUpdateNow, setStackUpdateNow] = useState(() => Date.now());
  const [stackUpdateExpectedVersion, setStackUpdateExpectedVersion] = useState(() => loadStackUpdateExpectedVersion());
  const [stackUpdateReadyAt, setStackUpdateReadyAt] = useState<number | null>(null);
  const autoGameValues = parseKeyValueText(autoGame?.stdout || "");
  const autoGameTimerValue = autoGameValues.systemd_timer || "";
  const autoGameTimerLabel = autoGameTimerValue ? formatTimerStatus(autoGameTimerValue) : "Not Installed";
  const autoGameTimerReady = /^(active|enabled)$/i.test(autoGameTimerValue);
  const autoGameSaving = autoGameResult?.status === "running";
  const autoGameLoaded = Boolean(autoGame);
  const autoGameDisplayActive = autoGameEnabled;
  const autoGameStatusLabel = !autoGameLoaded && !autoGameSaving ? "Checking" : autoGameDisplayActive ? "Enabled" : "Disabled";
  const autoGameDisplayTimerLabel = !autoGameLoaded && !autoGameSaving ? "Checking" : autoGameSaving ? autoGameEnabled ? "Activating" : "Deactivating" : autoGameEnabled ? autoGameTimerLabel : "Inactive";

  async function checkGame(options: { fresh?: boolean } = {}) {
    setGameStatus({ status: "Checking...", current: "", latest: "", reason: "" });
    const final = await waitForTask((await updatesApi.checkGame(options)).task);
    setGameStatus(parseUpdateTask(final));
  }

  async function refreshGameStatus(options: { fresh?: boolean } = {}) {
    try {
      await checkGame(options);
    } catch (error) {
      setGameStatus({ status: "Check Failed", current: "", latest: "", reason: error instanceof Error ? error.message : String(error) });
    }
  }

  async function checkStack() {
    setStackStatus({ status: "Checking...", current: "", latest: "", reason: "" });
    const final = await waitForTask((await updatesApi.checkStack()).task);
    setStackStatus(parseUpdateTask(final));
  }

  async function refreshStackStatus() {
    try {
      await checkStack();
    } catch (error) {
      setStackStatus({ status: "Check Failed", current: "", latest: "", reason: error instanceof Error ? error.message : String(error) });
    }
  }

  async function applyGameUpdate() {
    if (!(await confirmAction("Apply the game server update now?"))) return;
    setGameSteamcmdFixTask(null);
    const response = await updatesApi.applyGame();
    setGameUpdateTask(response.task);
    persistUpdateTask(GAME_UPDATE_TASK_KEY, response.task);
    setGameStatus((current) => ({ ...current, status: "Updating", reason: "Game update is running." }));
  }

  async function fixSteamcmd() {
    const response = await updatesApi.fixSteamcmd();
    setGameSteamcmdFixTask(response.task);
    await waitForTaskWithUpdates(response.task, setGameSteamcmdFixTask);
  }

  async function applyStackUpdate() {
    if (!(await confirmAction("Apply the latest console update now?"))) return;
    const expectedVersion = String(stackStatus.latest || "").trim();
    saveStackUpdateExpectedVersion(expectedVersion);
    setStackUpdateExpectedVersion(expectedVersion);
    setStackUpdateReadyAt(null);
    const response = await updatesApi.applyStack();
    setStackUpdateTask(response.task);
    persistUpdateTask(STACK_UPDATE_TASK_KEY, response.task);
    setStackStatus((current) => ({ ...current, status: "Updating", reason: "Console update is running." }));
  }

  async function loadAutoGame() {
    try {
      const result = await updatesApi.autoGameStatus();
      setAutoGame(result);
      const values = parseKeyValueText(result.stdout || "");
      const preferenceEnabled = /^(1|true|enabled)$/i.test(values.auto_updates_enabled || values.enabled || "");
      const timerReady = /^(active|enabled)$/i.test(values.systemd_timer || "");
      setAutoGameEnabled(preferenceEnabled && timerReady);
      if (values.check_interval_minutes) setAutoGameIntervalMinutes(values.check_interval_minutes);
      if (values.apply_updates) setAutoGameApplyEnabled(/^(1|true|yes|enabled)$/i.test(values.apply_updates));
      if (values.notify_players) setAutoGameNotifyEnabled(/^(1|true|yes|enabled)$/i.test(values.notify_players));
      if (values.notify_minutes) setAutoGameNotifyMinutes(values.notify_minutes);
      if (values.wait_until_empty) setAutoGameWaitUntilEmpty(/^(1|true|yes|enabled)$/i.test(values.wait_until_empty));
      if (values.max_wait_minutes) setAutoGameMaxWaitMinutes(values.max_wait_minutes);
    } finally {
      setAutoGameLoading(false);
    }
  }

  async function saveAutoGame(nextEnabled = autoGameEnabled) {
    const intervalMinutes = validateAutoGameInteger(autoGameIntervalMinutes, 5, 1440);
    const notifyMinutes = validateAutoGameInteger(autoGameNotifyMinutes, 1, 1440);
    const maxWaitMinutes = validateAutoGameInteger(autoGameMaxWaitMinutes, 0, 10080);
    if (nextEnabled && (!intervalMinutes || !notifyMinutes || maxWaitMinutes === null)) {
      setAutoGameResult({ status: "failed", title: "Auto Updates Save Failed", message: "Check interval, notice, and max wait values must be valid whole minutes." });
      return;
    }
    setAutoGameIntervalMinutes(String(intervalMinutes || 60));
    setAutoGameNotifyMinutes(String(notifyMinutes || 15));
    setAutoGameMaxWaitMinutes(String(maxWaitMinutes ?? 360));
    setAutoGameResult({ status: "running", title: "Saving Auto Updates" });
    const requestedEnabled = nextEnabled;
    setAutoGameEnabled(requestedEnabled);
    try {
      const final = await waitForTask((await updatesApi.saveAutoGame({
        enabled: requestedEnabled,
        intervalMinutes: intervalMinutes || 60,
        applyEnabled: autoGameApplyEnabled,
        notifyEnabled: autoGameNotifyEnabled,
        notifyMinutes: notifyMinutes || 15,
        waitUntilEmpty: autoGameWaitUntilEmpty,
        maxWaitMinutes: maxWaitMinutes ?? 360,
        confirmation: "SAVE AUTO GAME UPDATES"
      })).task);
      const details = taskTechnicalDetails(final);
      const nextAutoGame = await updatesApi.autoGameStatus();
      setAutoGame(nextAutoGame);
      const nextValues = parseKeyValueText(nextAutoGame.stdout || "");
      const timerReady = /^(active|enabled)$/i.test(nextValues.systemd_timer || "");
      const timerDisabled = !timerReady || /^(disabled|inactive|not installed)$/i.test(nextValues.systemd_timer || "");
      if (requestedEnabled && !timerReady) setAutoGameEnabled(false);
      if (!requestedEnabled && timerDisabled) setAutoGameEnabled(false);
      setAutoGameResult(final.status === "succeeded" && (!requestedEnabled ? timerDisabled : timerReady)
        ? { status: "succeeded", title: "Auto Updates Saved Successfully", details }
        : { status: "failed", title: requestedEnabled ? "Timer Install Failed" : "Auto Updates Save Failed", details: details || nextAutoGame.stdout || nextAutoGame.stderr || "" });
    } catch (error) {
      setAutoGameEnabled(!requestedEnabled);
      setAutoGameResult({ status: "failed", title: "Auto Updates Save Failed", details: error instanceof Error ? error.message : String(error) });
    }
  }

  useEffect(() => {
    if (!gameUpdateTask || isTerminalTask(gameUpdateTask.status)) refreshGameStatus();
    if (!stackUpdateTask || isTerminalTask(stackUpdateTask.status)) refreshStackStatus();
    loadAutoGame().catch((error) => setAutoGame({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 }));
  }, []);

  useEffect(() => {
    if (!gameUpdateTask || isTerminalTask(gameUpdateTask.status)) {
      persistUpdateTask(GAME_UPDATE_TASK_KEY, gameUpdateTask);
      return;
    }
    let cancelled = false;
    persistUpdateTask(GAME_UPDATE_TASK_KEY, gameUpdateTask);
    setGameStatus((current) => ({ ...current, status: "Updating", reason: "Game update is running." }));
    void (async () => {
      let current = gameUpdateTask;
      for (let i = 0; i < 3600 && !cancelled && !isTerminalTask(current.status); i += 1) {
        await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 1000));
        if (cancelled) return;
        current = (await setupApi.task(current.id)).task;
        setGameUpdateTask(current);
        persistUpdateTask(GAME_UPDATE_TASK_KEY, current);
      }
      if (!cancelled && current.status === "succeeded") refreshGameStatus({ fresh: true });
    })().catch(() => {
      if (cancelled) return;
      persistUpdateTask(GAME_UPDATE_TASK_KEY, null);
      setGameUpdateTask(null);
      refreshGameStatus();
    });
    return () => { cancelled = true; };
  }, [gameUpdateTask?.id, gameUpdateTask?.status]);

  useEffect(() => {
    if (!stackUpdateTask || isTerminalTask(stackUpdateTask.status)) {
      persistUpdateTask(STACK_UPDATE_TASK_KEY, stackUpdateTask);
      return;
    }
    let cancelled = false;
    persistUpdateTask(STACK_UPDATE_TASK_KEY, stackUpdateTask);
    setStackStatus((current) => ({ ...current, status: "Updating", reason: "Console update is running." }));
    void (async () => {
      let current = stackUpdateTask;
      for (let i = 0; i < 3600 && !cancelled && !isTerminalTask(current.status); i += 1) {
        await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 1000));
        if (cancelled) return;
        current = (await setupApi.task(current.id)).task;
        setStackUpdateTask(current);
        persistUpdateTask(STACK_UPDATE_TASK_KEY, current);
      }
      if (!cancelled && current.status === "succeeded") refreshStackStatus();
    })().catch(() => {
      if (cancelled) return;
      persistUpdateTask(STACK_UPDATE_TASK_KEY, null);
      setStackUpdateTask(null);
      refreshStackStatus();
    });
    return () => { cancelled = true; };
  }, [stackUpdateTask?.id, stackUpdateTask?.status]);

  useEffect(() => {
    if (!gameUpdateTask || !isTerminalTask(gameUpdateTask.status)) return;
    const id = window.setTimeout(() => setGameUpdateTask(null), UPDATE_RESULT_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [gameUpdateTask?.id, gameUpdateTask?.status]);

  useEffect(() => {
    if (!stackUpdateTask || !isTerminalTask(stackUpdateTask.status)) return;
    if (isDetachedStackUpdateTask(stackUpdateTask)) return;
    if (stackUpdateTask.status === "succeeded") refreshStackStatus();
    const id = window.setTimeout(() => setStackUpdateTask(null), UPDATE_RESULT_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [stackUpdateTask?.id, stackUpdateTask?.status]);

  useEffect(() => {
    if (!stackUpdateTask || !isDetachedStackUpdateTask(stackUpdateTask)) return;
    setStackUpdateNow(Date.now());
    const id = window.setInterval(() => setStackUpdateNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [stackUpdateTask?.id, stackUpdateTask?.status]);

  useEffect(() => {
    if (!stackUpdateTask || !isDetachedStackUpdateTask(stackUpdateTask) || stackUpdateReadyAt !== null) return;
    let cancelled = false;
    const startedAt = Date.now();
    const expectedVersion = stackUpdateExpectedVersion || stackStatus.latest || "";
    void (async () => {
      while (!cancelled) {
        const state = await fetchConsoleAuthState().catch(() => null);
        const runningVersion = String(state?.config?.version || "").trim();
        const expected = normalizeUpdateVersion(expectedVersion);
        const running = normalizeUpdateVersion(runningVersion);
        if (running && (!expected || running === expected)) {
          saveStackUpdateExpectedVersion("");
          setStackUpdateExpectedVersion("");
          setStackUpdateReadyAt(Date.now());
          return;
        }
        const elapsed = Date.now() - startedAt;
        await new Promise((resolvePromise) => window.setTimeout(resolvePromise, elapsed < 30000 ? 2000 : 5000));
      }
    })();
    return () => { cancelled = true; };
  }, [stackUpdateTask?.id, stackUpdateTask?.status, stackUpdateExpectedVersion, stackStatus.latest, stackUpdateReadyAt]);

  const stackUpdateHandoffStartedAt = stackUpdateTask ? Date.parse(stackUpdateTask.finishedAt || stackUpdateTask.startedAt || "") : NaN;
  const stackUpdateHandoffSeconds = stackUpdateTask && isDetachedStackUpdateTask(stackUpdateTask)
    ? Math.max(0, Math.floor((stackUpdateNow - (Number.isFinite(stackUpdateHandoffStartedAt) ? stackUpdateHandoffStartedAt : stackUpdateNow)) / 1000))
    : 0;
  const stackUpdateHandoffPercent = stackUpdateTask && isDetachedStackUpdateTask(stackUpdateTask)
    ? stackUpdateReadyAt !== null
      ? 100
      : Math.min(99, 20 + Math.floor((Math.min(stackUpdateHandoffSeconds, STACK_UPDATE_HANDOFF_SECONDS) / STACK_UPDATE_HANDOFF_SECONDS) * 79))
    : undefined;
  const stackUpdateRefreshCountdown = stackUpdateTask && isDetachedStackUpdateTask(stackUpdateTask) && stackUpdateReadyAt !== null
    ? Math.max(0, STACK_UPDATE_REFRESH_SECONDS - Math.floor((stackUpdateNow - stackUpdateReadyAt) / 1000))
    : null;

  useEffect(() => {
    if (stackUpdateRefreshCountdown !== 0) return;
    window.location.reload();
  }, [stackUpdateRefreshCountdown]);

  useEffect(() => {
    if (!autoGameResult || autoGameResult.status === "running") return;
    const id = window.setTimeout(() => setAutoGameResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [autoGameResult?.status, autoGameResult?.title]);

  const gameUpdateRunning = Boolean(gameUpdateTask && !isTerminalTask(gameUpdateTask.status));
  const gameCanApply = canApplyUpdateStatus(gameStatus) && !gameUpdateRunning;
  const stackUpdateRunning = Boolean(stackUpdateTask && (!isTerminalTask(stackUpdateTask.status) || isDetachedStackUpdateTask(stackUpdateTask)));
  const stackCanApply = canApplyUpdateStatus(stackStatus) && !stackUpdateRunning;
  const stackReleaseNotes = stackReleaseNotesUrl(stackStatus);

  return <section className="panel">
    <h2>Updates</h2>
    <div className="action-sections">
      <section className="action-section">
        <div className="panel-title"><h4>Game Update</h4><StatusPill value={gameStatus.status} /></div>
        <KeyValueGrid items={[["Current Build", updateDisplayValue(gameStatus, "current")], ["Latest Build", updateDisplayValue(gameStatus, "latest")], ["Status", gameStatus.status]]} />
        {gameStatus.status === "Check Failed" && gameStatus.reason && <p className="danger-note">{gameStatus.reason}</p>}
        {gameStatus.status === "Version details unavailable" && <p className="muted">{gameStatus.reason}</p>}
        <div className="action-line">
          <button disabled={gameUpdateRunning} onClick={() => checkGame({ fresh: true })}>Refresh Game Check</button>
          {gameCanApply && <button className="update-action" onClick={applyGameUpdate}>Apply Game Update</button>}
        </div>
        {gameUpdateTask && <GameUpdateProgress task={gameUpdateTask} repairTask={gameSteamcmdFixTask} onRetry={applyGameUpdate} onFixSteamcmd={fixSteamcmd} formatResultTitle={formatResultTitle} formatResultMessage={formatResultMessage} />}
      </section>
      <section className="action-section">
        <div className="panel-title"><h4>Console Update</h4><StatusPill value={stackStatus.status} /></div>
        <KeyValueGrid items={[["Current Console Version", updateDisplayValue(stackStatus, "current", formatStackVersionLabel)], ["Latest Console Version", updateDisplayValue(stackStatus, "latest", formatStackVersionLabel)], ["Status", stackStatus.status]]} />
        {stackStatus.status === "Check Failed" && stackStatus.reason && <p className="danger-note">{stackStatus.reason}</p>}
        {stackStatus.status === "Version details unavailable" && <p className="muted">{stackStatus.reason}</p>}
        <div className="action-line">
          <button disabled={stackUpdateRunning} onClick={checkStack}>Refresh Console Check</button>
          {stackReleaseNotes && <a className="button-link" href={stackReleaseNotes} target="_blank" rel="noreferrer"><BookOpen size={16} aria-hidden="true" />View Patch Notes</a>}
          {stackCanApply && <button className="update-action" onClick={applyStackUpdate}>Apply Console Update</button>}
        </div>
        {stackUpdateTask && <StackUpdateProgress task={stackUpdateTask} handoffPercent={stackUpdateHandoffPercent} refreshCountdown={stackUpdateRefreshCountdown} onRetry={applyStackUpdate} formatResultTitle={formatResultTitle} formatResultMessage={formatResultMessage} />}
      </section>
      <div className={`playerAdmin_toggle auto-game-toggle ${autoGameOpen ? "open" : ""}`}>
          <button className="playerAdmin_toggleHeader" aria-label={autoGameOpen ? "Collapse Automatic Game Updates" : "Expand Automatic Game Updates"} onClick={() => setAutoGameOpen(!autoGameOpen)}>{autoGameOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Automatic Game Updates</span></button>
          {autoGameOpen && <div className="playerAdmin_toggleBody">
        <div className="panel-title"><h4>Service Configuration</h4><label className={`switch-checkbox ${autoGameEnabled ? "enabled" : "disabled"}`}><input type="checkbox" disabled={autoGameLoading || autoGameSaving} checked={autoGameEnabled} onChange={(event) => saveAutoGame(event.target.checked)} /><span className="switch-label">Auto Updates</span><strong className="switch-state">{autoGameEnabled ? "ON" : "OFF"}</strong></label></div>
        <KeyValueGrid items={[
          ["Current Status", autoGameStatusLabel],
          ["Check Interval", `Every ${autoGameValues.check_interval_minutes || autoGameIntervalMinutes} minutes`],
          ["Apply Updates", enabledLabel(autoGameValues.apply_updates, autoGameApplyEnabled)],
          ["Player Notice", enabledLabel(autoGameValues.notify_players, autoGameNotifyEnabled, `${autoGameValues.notify_minutes || autoGameNotifyMinutes} minutes`)],
          ["Empty Server Policy", enabledLabel(autoGameValues.wait_until_empty, autoGameWaitUntilEmpty, `max ${autoGameValues.max_wait_minutes || autoGameMaxWaitMinutes} minutes`)],
          ["Timer", autoGameDisplayTimerLabel]
        ]} />
        {commandStatusSummary(autoGame).reason && <p className="danger-note">{commandStatusSummary(autoGame).reason}</p>}
        <div className="auto-update-policy-grid">
          <section className="auto-update-policy-group">
            <h5>Schedule</h5>
            <label className="auto-update-settings-row"><span>Check for updates every</span><span className="number-unit-field"><input type="number" min="5" max="1440" step="1" disabled={autoGameSaving} value={autoGameIntervalMinutes} onChange={(event) => setAutoGameIntervalMinutes(event.target.value)} /><em>min</em></span><span className="auto-update-settings-spacer" /></label>
          </section>
          <section className="auto-update-policy-group">
            <h5>Update Action</h5>
            <label className="auto-update-settings-row auto-update-settings-boolean-row"><span>Apply update when found</span><strong>{autoGameApplyEnabled ? "Enabled" : "Disabled"}</strong><input type="checkbox" disabled={autoGameSaving} checked={autoGameApplyEnabled} onChange={(event) => setAutoGameApplyEnabled(event.target.checked)} /></label>
          </section>
          <section className="auto-update-policy-group">
            <h5>Player Notice</h5>
            <label className="auto-update-settings-row auto-update-settings-boolean-row"><span>Warn players before restart</span><strong>{autoGameNotifyEnabled ? "Enabled" : "Disabled"}</strong><input type="checkbox" disabled={autoGameSaving} checked={autoGameNotifyEnabled} onChange={(event) => setAutoGameNotifyEnabled(event.target.checked)} /></label>
            <label className={`auto-update-settings-row ${autoGameNotifyEnabled ? "" : "is-disabled"}`}><span>Warning time</span><span className="number-unit-field"><input type="number" min="1" max="1440" step="1" disabled={autoGameSaving || !autoGameNotifyEnabled} value={autoGameNotifyMinutes} onChange={(event) => setAutoGameNotifyMinutes(event.target.value)} /><em>min</em></span><span className="auto-update-settings-spacer" /></label>
          </section>
          <section className="auto-update-policy-group">
            <h5>Empty Server Policy</h5>
            <label className="auto-update-settings-row auto-update-settings-boolean-row"><span>Wait until server is empty</span><strong>{autoGameWaitUntilEmpty ? "Enabled" : "Disabled"}</strong><input type="checkbox" disabled={autoGameSaving} checked={autoGameWaitUntilEmpty} onChange={(event) => setAutoGameWaitUntilEmpty(event.target.checked)} /></label>
            <label className={`auto-update-settings-row ${autoGameWaitUntilEmpty ? "" : "is-disabled"}`}><span>Maximum wait</span><span className="number-unit-field"><input type="number" min="0" max="10080" step="1" disabled={autoGameSaving || !autoGameWaitUntilEmpty} value={autoGameMaxWaitMinutes} onChange={(event) => setAutoGameMaxWaitMinutes(event.target.value)} /><em>min</em></span><span className="auto-update-settings-spacer" /></label>
          </section>
        </div>
        <div className="auto-update-settings-divider" />
        <div className="action-line schedule-action-line auto-game-action-line">
          <button disabled={autoGameLoading || autoGameSaving} onClick={() => saveAutoGame()}>Save Auto Updates</button>
          {autoGameResult && <span className={`inline-task-result result-${autoGameResult.status === "succeeded" ? "ok" : autoGameResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={autoGameResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(autoGameResult.title, autoGameResult.status === "running")}</strong>
          </span>}
        </div>
          </div>}
      </div>
    </div>
  </section>;
}

function validateAutoGameInteger(value: string, min: number, max: number) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function enabledLabel(rawValue: string | undefined, fallback: boolean, detail = "") {
  const enabled = rawValue ? /^(1|true|yes|enabled)$/i.test(rawValue) : fallback;
  return enabled ? detail ? `Enabled (${detail})` : "Enabled" : "Disabled";
}

function GameUpdateProgress({
  task,
  repairTask,
  onRetry,
  onFixSteamcmd,
  formatResultTitle,
  formatResultMessage
}: { task: Task; repairTask: Task | null; onRetry: () => Promise<void>; onFixSteamcmd: () => Promise<void>; formatResultTitle: (value: unknown, pending?: boolean) => string; formatResultMessage: (value: unknown) => string }) {
  const progress = summarizeGameUpdateProgress(task);
  const running = !isTerminalTask(task.status);
  const repairRunning = Boolean(repairTask && !isTerminalTask(repairTask.status));
  const repairSucceeded = repairTask?.status === "succeeded";
  const repairable = task.status === "failed" && isSteamcmdManifestFailure(task);
  const updateLog = task.logLines.slice(-160).map((line) => line.line).join("\n").trim();
  return <div className={`result-panel game-update-progress result-${task.status === "succeeded" ? "ok" : task.status === "failed" ? "fail" : "running"}`} aria-live="polite">
    <div className="panel-title">
      <h4 className={running ? "loading-dots" : ""}>{formatResultTitle(progress.title, running)}</h4>
      <StatusPill value={task.status === "failed" ? "Failed" : task.status === "succeeded" ? "Succeeded" : "Running"} />
    </div>
    <div className="progress-row">
      <div className="progress-track" aria-label={`Game update progress ${progress.percent}%`}>
        <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
      </div>
      <strong>{progress.percent}%</strong>
    </div>
    <p>{formatResultMessage(progress.message)}</p>
    {repairRunning && <p className="muted loading-dots">{formatUiSentence("Fixing SteamCMD", true)}</p>}
    {repairSucceeded && <p className="muted">{formatResultMessage("SteamCMD manifest reset. Retry the game update when ready.")}</p>}
    {task.status === "failed" && <div className="action-line">
      {repairable && <button disabled={repairRunning} onClick={onFixSteamcmd}>Fix SteamCMD</button>}
      <button disabled={repairRunning} onClick={onRetry}>Retry Game Update</button>
    </div>}
    <details className="task-technical-details update-log-details">
      <summary>Update Log</summary>
      <pre className="log-box">{updateLog || "Waiting for game update output..."}</pre>
    </details>
  </div>;
}

function summarizeGameUpdateProgress(task: Task) {
  const text = task.logLines.map((line) => line.line).join("\n");
  const latestLine = [...task.logLines].reverse().map((line) => line.line.trim()).find(Boolean) || task.progressMessage || task.currentStep || "";
  if (task.status === "succeeded") {
    return { title: "Update Complete", percent: 100, message: "The game server update is complete. The server is coming back up now." };
  }
  if (task.status === "failed") {
    return { title: "Update Failed", percent: Math.max(5, gameUpdatePercent(text)), message: conciseTaskError(task) };
  }

  const fixIndex = text.lastIndexOf("Detected a common SteamCMD cache error");
  const attemptIndexes = [...text.matchAll(/SteamCMD install attempt\s+\d+\/\d+/gi)].map((match) => match.index || 0);
  const latestAttemptIndex = attemptIndexes.length ? attemptIndexes[attemptIndexes.length - 1] : -1;
  if (fixIndex >= 0 && fixIndex > latestAttemptIndex) {
    return { title: "Fixing SteamCMD", percent: Math.max(45, gameUpdatePercent(text)), message: "Detected a common Steam download error. Applying the automatic SteamCMD fix, then retrying the update." };
  }
  if (!isSteamcmdUpdateActive(text)) {
    return { title: "Updating", percent: gameUpdatePercent(text), message: friendlyGameUpdateMessage(text, latestLine) };
  }
  const retryMatches = [...text.matchAll(/Retrying(?: app install)? in (\d+)s/gi)];
  const retryMatch = retryMatches[retryMatches.length - 1];
  const retryIndex = retryMatch?.index ?? -1;
  if (retryMatch && retryIndex > latestAttemptIndex) {
    return { title: "Updating", percent: Math.max(45, gameUpdatePercent(text)), message: `Steam download hit a temporary problem. Retrying in ${retryMatch[1]} seconds.` };
  }
  const attemptMatch = text.match(/SteamCMD install attempt\s+(\d+)\/(\d+)/i);
  const steamcmdStage = summarizeSteamcmdStage(task.logLines.map((line) => line.line), attemptMatch);
  if (steamcmdStage) {
    return { title: steamcmdStage.title, percent: Math.max(42, gameUpdatePercent(text), steamcmdStage.percent), message: steamcmdStage.message };
  }
  if (attemptMatch) {
    return { title: "Updating", percent: Math.max(42, gameUpdatePercent(text)), message: `Downloading server files with SteamCMD. Attempt ${attemptMatch[1]} of ${attemptMatch[2]}.` };
  }
  return { title: "Updating", percent: gameUpdatePercent(text), message: friendlyGameUpdateMessage(text, latestLine) };
}

function isSteamcmdUpdateActive(text: string) {
  const clean = stripAnsi(text);
  const steamStart = clean.lastIndexOf("=== Download/update server files with SteamCMD ===");
  if (steamStart < 0) return false;
  const laterText = clean.slice(steamStart);
  return !/===\s+(Load updated Funcom image tarballs|Detect loaded image tags|Run database update\/migration|Refresh generated map catalogs|Restarting Dune stack)\s+===/i.test(laterText);
}

function summarizeSteamcmdStage(lines: string[], attemptMatch: RegExpMatchArray | null) {
  const attemptText = attemptMatch ? ` Attempt ${attemptMatch[1]} of ${attemptMatch[2]}.` : "";
  const cleanLines = lines.flatMap((line) => stripAnsi(line).split(/\r+/).map((part) => part.trim()).filter(Boolean));

  for (const line of [...cleanLines].reverse()) {
    const progressMatches = [...line.matchAll(/Update state\s+\([^)]+\)\s+([^,]+),\s+progress:\s+([0-9.]+)/gi)];
    const progressMatch = progressMatches[progressMatches.length - 1];
    if (progressMatch) {
      const state = progressMatch[1].trim().toLowerCase();
      const steamPercent = Math.max(0, Math.min(100, Number(progressMatch[2]) || 0));
      const scaledPercent = 42 + Math.round(steamPercent * 0.18);
      if (/download/i.test(state)) return { title: "Downloading Server Files", percent: scaledPercent, message: `SteamCMD is downloading updated server files (${steamPercent.toFixed(1)}%).${attemptText}` };
      if (/verif/i.test(state)) return { title: "Verifying Server Files", percent: Math.max(56, scaledPercent), message: `SteamCMD is verifying downloaded server files (${steamPercent.toFixed(1)}%).${attemptText}` };
      if (/install|commit|staging|reconfig/i.test(state)) return { title: "Installing Server Files", percent: Math.max(48, scaledPercent), message: `SteamCMD is ${state} (${steamPercent.toFixed(1)}%).${attemptText}` };
      return { title: "Updating Server Files", percent: scaledPercent, message: `SteamCMD update state: ${state} (${steamPercent.toFixed(1)}%).${attemptText}` };
    }

    if (/Success!\s+App\s+'?\d+'?.*fully installed/i.test(line)) return { title: "Server Files Installed", percent: 62, message: `SteamCMD finished installing the server files.${attemptText}` };
    if (/Validating|validation/i.test(line)) return { title: "Validating Server Files", percent: 56, message: `SteamCMD is validating the installed server files.${attemptText}` };
    if (/Downloading item|download item|download depot|downloading/i.test(line)) return { title: "Downloading Server Files", percent: 46, message: `SteamCMD is downloading server file content.${attemptText}` };
    if (/Connecting anonymously|Connecting to Steam/i.test(line)) return { title: "Connecting To Steam", percent: 43, message: `SteamCMD is connecting to Steam.${attemptText}` };
    if (/Waiting for (client config|user info)/i.test(line)) return { title: "Loading Steam Metadata", percent: 44, message: `SteamCMD is loading Steam account and depot metadata.${attemptText}` };
    if (/Logging in user|login anonymous|Logged in OK/i.test(line)) return { title: "Logging In To Steam", percent: 44, message: `SteamCMD is logging in anonymously to Steam.${attemptText}` };
    if (/Loading Steam API/i.test(line)) return { title: "Starting SteamCMD", percent: 42, message: `SteamCMD is starting and loading the Steam API.${attemptText}` };
  }

  return null;
}

function gameUpdatePercent(text: string) {
  const stages: [RegExp, number][] = [
    [/Pre-flight: check Steam/i, 8],
    [/Update is available/i, 15],
    [/Check Docker volume free space/i, 22],
    [/Stop game servers before update/i, 30],
    [/Download\/update server files with SteamCMD/i, 40],
    [/SteamCMD install attempt\s+2\//i, 52],
    [/SteamCMD install attempt\s+3\//i, 60],
    [/Load updated Funcom image tarballs/i, 70],
    [/Detect loaded image tags/i, 78],
    [/Run database update\/migration/i, 86],
    [/Refresh generated map catalogs/i, 94],
    [/Restarting Dune stack/i, 98]
  ];
  let percent = 3;
  for (const [pattern, value] of stages) {
    if (pattern.test(text)) percent = Math.max(percent, value);
  }
  return percent;
}

function friendlyGameUpdateMessage(text: string, latestLine: string) {
  if (/Restarting Dune stack/i.test(text)) return "Restarting the Dune server with the updated build.";
  if (/Refresh generated map catalogs/i.test(text)) return "Refreshing generated map catalogs.";
  if (/Run database update\/migration/i.test(text)) return "Running database migrations for the updated build.";
  if (/Detect loaded image tags/i.test(text)) return "Detecting updated image versions.";
  if (/Load updated Funcom image tarballs/i.test(text)) return "Loading updated game container images.";
  if (/Download\/update server files with SteamCMD/i.test(text)) return "Downloading updated game server files.";
  if (/Stop game servers before update/i.test(text)) return "Stopping game servers before replacing server files.";
  if (/Check Docker volume free space/i.test(text)) return "Checking available disk space before downloading files.";
  if (/Pre-flight: check Steam/i.test(text)) return "Checking Steam for the latest available server build.";
  return latestLine && !/^\s*Task started/i.test(latestLine) ? friendlyGameUpdateLine(latestLine) : "Preparing the game update.";
}

function friendlyGameUpdateLine(line: string) {
  if (/^Running updateApply$/i.test(line)) return "Preparing the game update.";
  if (/^Task started$/i.test(line)) return "Preparing the game update.";
  if (/Steam app id:/i.test(line)) return "Preparing Steam update metadata.";
  return "Working on the game update.";
}

function isSteamcmdManifestFailure(task: Task) {
  const text = stripAnsi(task.logLines.map((line) => line.line).join("\n"));
  return /SteamCMD failed|App\s+'[^']+'\s+state is\s+0x6|appmanifest_\d+\.acf|SteamCMD cache\/metadata is stale/i.test(text);
}

function StackUpdateProgress({
  task,
  handoffPercent,
  refreshCountdown,
  onRetry,
  formatResultTitle,
  formatResultMessage
}: { task: Task; handoffPercent?: number; refreshCountdown: number | null; onRetry: () => Promise<void>; formatResultTitle: (value: unknown, pending?: boolean) => string; formatResultMessage: (value: unknown) => string }) {
  const progress = summarizeStackUpdateProgress(task, handoffPercent, refreshCountdown);
  const running = !isTerminalTask(task.status) || (isDetachedStackUpdateTask(task) && refreshCountdown === null);
  const resultState = task.status === "failed" ? "fail" : refreshCountdown !== null || (task.status === "succeeded" && !isDetachedStackUpdateTask(task)) ? "ok" : "running";
  return <div className={`result-panel stack-update-progress result-${resultState}`} aria-live="polite">
    <div className="panel-title">
      <h4 className={running ? "loading-dots" : ""}>{formatResultTitle(progress.title, running)}</h4>
      <StatusPill value={task.status === "failed" ? "Failed" : refreshCountdown !== null ? "Succeeded" : "Running"} />
    </div>
    <div className="progress-row">
      <div className="progress-track" aria-label={`Console update progress ${progress.percent}%`}>
        <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
      </div>
      <strong>{progress.percent}%</strong>
    </div>
    <p>{formatResultMessage(progress.message)}</p>
    {refreshCountdown !== null && <div className="action-line"><button onClick={() => window.location.reload()}>Refresh Now</button></div>}
    {task.status === "succeeded" && !isDetachedStackUpdateTask(task) && <div className="action-line"><button onClick={() => window.location.reload()}>Refresh Console</button></div>}
    {task.status === "failed" && <div className="action-line"><button onClick={onRetry}>Retry Console Update</button></div>}
  </div>;
}

function summarizeStackUpdateProgress(task: Task, handoffPercent?: number, refreshCountdown: number | null = null) {
  const text = task.logLines.map((line) => line.line).join("\n");
  const latestLine = [...task.logLines].reverse().map((line) => line.line.trim()).find(Boolean) || task.progressMessage || task.currentStep || "";
  if (task.status === "succeeded" && isDetachedStackUpdateTask(task)) {
    if (refreshCountdown !== null) {
      return { title: "Console Update Complete", percent: 100, message: `The console update is complete. This browser will refresh in ${refreshCountdown} second${refreshCountdown === 1 ? "" : "s"}. You may need to sign in again.` };
    }
    return { title: "Finishing Console Update", percent: Math.max(20, Math.min(99, handoffPercent || 20)), message: "The update helper is rebuilding and restarting the web console. This page will wait until the rebuilt console is serving the new version." };
  }
  if (task.status === "succeeded") {
    const installedVersion = firstVersionMatch(text, [/Installed stack version:\s*([^\n]+)/i]);
    return { title: "Console Update Complete", percent: 100, message: installedVersion ? `Console files were updated to ${installedVersion}. Refresh this page to load the new Web UI. You may need to sign in again.` : "Console files were updated. Refresh this page to load the new Web UI. You may need to sign in again." };
  }
  if (task.status === "failed") {
    return { title: "Console Update Failed", percent: Math.max(5, stackUpdatePercent(text)), message: conciseTaskError(task) };
  }
  const stackStage = summarizeStackUpdateStage(task.logLines.map((line) => line.line));
  if (stackStage) return stackStage;
  return { title: "Updating Console", percent: stackUpdatePercent(text), message: friendlyStackUpdateMessage(text, latestLine) };
}

function isDetachedStackUpdateTask(task: Task) {
  return task.operation === "selfUpdateApply" && task.status === "succeeded" && /Update helper started/i.test(task.logLines.map((line) => line.line).join("\n"));
}

function loadStackUpdateExpectedVersion() {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(STACK_UPDATE_EXPECTED_VERSION_KEY) || "";
  } catch {
    return "";
  }
}

function saveStackUpdateExpectedVersion(value: string) {
  if (typeof window === "undefined") return;
  try {
    const clean = String(value || "").trim();
    if (clean) window.localStorage.setItem(STACK_UPDATE_EXPECTED_VERSION_KEY, clean);
    else window.localStorage.removeItem(STACK_UPDATE_EXPECTED_VERSION_KEY);
  } catch {
    // The visible update flow still works if localStorage is unavailable.
  }
}

async function fetchConsoleAuthState() {
  const response = await fetch("/api/auth/state", {
    credentials: "include",
    cache: "no-store",
    headers: { accept: "application/json" }
  });
  if (!response.ok) throw new Error(`Console state check failed: ${response.status}`);
  return await response.json() as { config?: { version?: string } };
}

function stackUpdatePercent(text: string) {
  const stages: [RegExp, number][] = [
    [/Running selfUpdateApply/i, 5],
    [/Downloading stack release/i, 20],
    [/Backing up current stack files/i, 42],
    [/Installing stack release into/i, 66],
    [/Installed stack version/i, 88],
    [/Previous stack files backup/i, 94],
    [/Rebuilding Dune Docker Console|Dune Docker Console was rebuilt/i, 98]
  ];
  let percent = 3;
  for (const [pattern, value] of stages) {
    if (pattern.test(text)) percent = Math.max(percent, value);
  }
  return percent;
}

function friendlyStackUpdateMessage(text: string, latestLine: string) {
  if (/Downloading stack release/i.test(text)) return "Downloading the selected console release.";
  if (/Backing up current stack files/i.test(text)) return "Backing up the current console files before replacing them.";
  if (/Installing stack release into/i.test(text)) return "Installing the downloaded console release files.";
  if (/Installed stack version/i.test(text)) return "Verifying the installed console version.";
  if (/Rebuilding Dune Docker Console/i.test(text)) return "Rebuilding and restarting the web console container.";
  if (/Dune Docker Console was rebuilt/i.test(text)) return "The web console container was rebuilt successfully.";
  if (/Previous stack files backup/i.test(text)) return "Finishing the console update and recording the backup location.";
  return latestLine && !/^\s*Task started/i.test(latestLine) ? friendlyStackUpdateLine(latestLine) : "Preparing the console update.";
}

function summarizeStackUpdateStage(lines: string[]) {
  const cleanLines = lines.map((line) => stripAnsi(line).replace(/\s+$/g, "")).filter((line) => line.trim());
  const latestIndex = (pattern: RegExp) => {
    for (let index = cleanLines.length - 1; index >= 0; index -= 1) {
      if (pattern.test(cleanLines[index].trim())) return index;
    }
    return -1;
  };
  const backupIndex = latestIndex(/^Backing up current stack files to:/i);
  const installIndex = latestIndex(/^Installing stack release into:/i);
  const installedIndex = latestIndex(/^Installed stack version:\s*/i);
  const backupDoneIndex = latestIndex(/^Previous stack files backup:/i);
  const downloadIndex = latestIndex(/^Downloading stack release:\s*/i);
  const dirtyIndex = latestIndex(/^Local repo has uncommitted tracked changes\./i);

  if (backupDoneIndex >= 0) {
    const backupFile = nextIndentedLine(cleanLines, backupDoneIndex);
    return { title: "Finishing Console Update", percent: 94, message: backupFile ? `Recorded backup at ${backupFile}.` : "Recording the previous console backup location." };
  }
  if (installedIndex >= 0) {
    const version = cleanLines[installedIndex].trim().replace(/^Installed stack version:\s*/i, "").trim();
    return { title: "Verifying Console Version", percent: 88, message: version ? `Installed console version ${version}. Verifying the update before finishing.` : "Verifying the installed console version." };
  }
  if (installIndex >= 0) {
    const target = nextIndentedLine(cleanLines, installIndex);
    return { title: "Installing Console Release", percent: 66, message: target ? `Installing the downloaded console release into ${target}.` : "Installing the downloaded console release files." };
  }
  if (backupIndex >= 0) {
    const backupDir = nextIndentedLine(cleanLines, backupIndex);
    return { title: "Backing Up Console Files", percent: 42, message: backupDir ? `Backing up current console files to ${backupDir}.` : "Backing up the current console files before replacing them." };
  }
  if (downloadIndex >= 0) {
    const tag = cleanLines[downloadIndex].trim().replace(/^Downloading stack release:\s*/i, "").trim();
    return { title: "Downloading Console Release", percent: 20, message: tag ? `Downloading console release ${tag} from GitHub.` : "Downloading the selected console release." };
  }
  if (dirtyIndex >= 0) {
    return { title: "Preparing Console Backup", percent: 12, message: "Local tracked changes were detected; the updater will back up the current console files first." };
  }
  return null;
}

function nextIndentedLine(lines: string[], index: number) {
  const next = lines[index + 1] || "";
  return /^\S/.test(next) ? "" : next.trim();
}

function friendlyStackUpdateLine(line: string) {
  if (/^Running selfUpdateApply$/i.test(line)) return "Preparing the console update.";
  if (/^Task started$/i.test(line)) return "Preparing the console update.";
  if (/Could not|failed|denied|rate-limited/i.test(line)) return line;
  return "Working on the console update.";
}

async function waitForTaskWithUpdates(task: Task, setTask: (task: Task) => void) {
  let current = task;
  setTask(current);
  for (let i = 0; i < 3600 && !isTerminalTask(current.status); i += 1) {
    await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 1000));
    current = (await setupApi.task(current.id)).task;
    setTask(current);
  }
  return current;
}

function isTerminalTask(status: string) {
  return ["succeeded", "failed", "cancelled"].includes(status);
}
