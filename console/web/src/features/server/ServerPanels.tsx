import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Play, Trash2 } from "lucide-react";
import { serverApi, type PerformanceSnapshot } from "../../api/server";
import { setupApi, type Task } from "../../api/setup";
import { PortChecklist } from "../../components/PortChecklist";
import { ReadinessTimeline } from "../../components/ReadinessTimeline";
import { SecretInput } from "../../components/SecretInput";
import { KeyValueGrid, StatusPill, TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { formatDisplayValue, formatUiSentence, friendlyColumnName, stripAnsi, summarizeCommandText, titleCase } from "../../lib/display";
import { friendlyServiceName } from "../../lib/serviceDisplay";
import { conciseTaskError, funcomTokenMismatchDetected } from "../../lib/taskDisplay";

export type HomeLoadResult = { statusLoaded: boolean; readinessLoaded: boolean; statusError: string; readinessError: string; statusText: string; readinessText: string };
export type HomeTaskResult = { status: "running" | "succeeded" | "failed" | "stopped"; title: string; message?: string; details?: string };
export type RestartLifecycleState = { stopObserved: boolean; startObserved: boolean };
type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean }) => Promise<boolean>;
type ServerMode = "public" | "local";

const RESTARTABLE_SERVICES = [
  { value: "gateway", label: "Gateway" },
  { value: "director", label: "Director" },
  { value: "text-router", label: "Text Router" },
  { value: "survival-1", label: "Survival 1" },
  { value: "overmap", label: "Overmap" },
  { value: "rmq-admin", label: "RabbitMQ Admin" },
  { value: "rmq-game", label: "RabbitMQ Game" },
  { value: "postgres", label: "Postgres" }
];

const FUNCOM_TOKEN_AUTH_ERROR_KEY = "arrakis.funcomTokenAuthError";

function formatResultTitle(value: unknown, pending = false) {
  return formatUiSentence(value, pending);
}

function formatResultMessage(value: unknown) {
  return formatUiSentence(value, false);
}

export function stackActionPendingResult(action: "start" | "stop" | "restart", phase: "running" | "waiting" | "confirming" = "running"): HomeTaskResult {
  if (action === "stop") return { status: "running", title: "Stopping", message: "Stopping battlegroup services." };
  if (action === "start") {
    if (phase === "confirming") return { status: "running", title: "Finalizing Startup", message: "Services reported ready once. Confirming they stay ready." };
    if (phase === "waiting") return { status: "running", title: "Waiting for Server Readiness", message: "Start command finished. Waiting for services to become ready." };
    return { status: "running", title: "Starting", message: "Starting battlegroup services." };
  }
  if (phase === "confirming") return { status: "running", title: "Finalizing Battlegroup Restart", message: "Services reported ready once. Confirming they stay ready." };
  if (phase === "waiting") return { status: "running", title: "Waiting for Battlegroup Readiness", message: "Restart command finished. Waiting for services to become ready." };
  return { status: "running", title: "Restarting Battlegroup", message: "Stopping services, then starting them again." };
}

export function createRestartLifecycleState(): RestartLifecycleState {
  return { stopObserved: false, startObserved: false };
}

export function advanceRestartLifecycle(state: RestartLifecycleState, status: string, readiness: string): RestartLifecycleState {
  const stopObserved = state.stopObserved || isHomeStopComplete(status, readiness) || hasRestartStopSignal(status, readiness);
  const startObserved = state.startObserved || (stopObserved && hasRestartStartSignal(status, readiness));
  return { stopObserved, startObserved };
}

function advanceRestartLifecycleFromTaskDetails(state: RestartLifecycleState, details: string): RestartLifecycleState {
  const text = stripAnsi(details || "");
  const stopObserved = state.stopObserved || /\b(stopping|stopped|stop-all|stop all|docker compose down)\b/i.test(text);
  return { ...state, stopObserved };
}

export function isRestartLifecycleReady(action: "start" | "stop" | "restart" | "", state: RestartLifecycleState) {
  return action !== "restart" || state.startObserved;
}

export function HomePanel({ status, readiness, taskResult, setTaskResult, funcomTokenResult, setFuncomTokenResult, runningAction, restartStartObserved, setRunningAction, onLoad, confirmAction }: {
  status: string;
  readiness: string;
  taskResult: HomeTaskResult | null;
  setTaskResult: Dispatch<SetStateAction<HomeTaskResult | null>>;
  funcomTokenResult: HomeTaskResult | null;
  setFuncomTokenResult: Dispatch<SetStateAction<HomeTaskResult | null>>;
  runningAction: "start" | "stop" | "restart" | "";
  restartStartObserved: boolean;
  setRunningAction: Dispatch<SetStateAction<"start" | "stop" | "restart" | "">>;
  onLoad: () => Promise<HomeLoadResult>;
  confirmAction: ConfirmAction;
}) {
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState("");
  const [readinessWarning, setReadinessWarning] = useState("");
  const [performance, setPerformance] = useState<PerformanceSnapshot | null>(null);
  const [performanceError, setPerformanceError] = useState("");
  const [hasLoaded, setHasLoaded] = useState(Boolean(status || readiness));
  const homeActionRunId = useRef(0);
  const homeActionStartedAt = useRef(0);
  const homeActionReadyPolls = useRef(0);
  const homeRestartLifecycle = useRef<RestartLifecycleState>(createRestartLifecycleState());
  const refreshRunId = useRef(0);
  const activeHomeAction = useRef<"start" | "stop" | "restart" | "">(runningAction);

  function setHomeAction(action: "start" | "stop" | "restart" | "") {
    activeHomeAction.current = action;
    homeActionReadyPolls.current = 0;
    if (action === "restart" || !action) homeRestartLifecycle.current = createRestartLifecycleState();
    setRunningAction(action);
  }

  useEffect(() => {
    activeHomeAction.current = runningAction;
    if (runningAction && homeActionStartedAt.current === 0) homeActionStartedAt.current = Date.now();
    if (!runningAction) homeActionStartedAt.current = 0;
  }, [runningAction]);

  function applyHomeLoadResult(result: HomeLoadResult) {
    if (result.statusLoaded || result.readinessLoaded) setHasLoaded(true);
    setReadinessWarning(!result.readinessLoaded && result.readinessError ? result.readinessError : "");
    if (!result.statusLoaded && !result.readinessLoaded && result.statusError) setLocalError(friendlyHomeStatusError(result.statusError));
  }

  async function refresh(isActive = () => true) {
    const runId = ++refreshRunId.current;
    setLoading(true);
    setLocalError("");
    setReadinessWarning("");
    try {
      const result = await onLoad();
      if (!isActive() || refreshRunId.current !== runId) return;
      if (result.statusLoaded || result.readinessLoaded) {
        applyHomeLoadResult(result);
        const statusText = result.statusText || status;
        const readinessText = result.readinessText || readiness;
        const loadedState = getHomeServerState(statusText, readinessText);
        if (runningAction === "restart") homeRestartLifecycle.current = advanceRestartLifecycle(homeRestartLifecycle.current, statusText, readinessText);
        const restartReady = isRestartLifecycleReady(runningAction, homeRestartLifecycle.current);
        if (runningAction === "restart" && restartReady) {
          if (isHomeActionComplete(statusText, readinessText)) setHomeAction("");
        } else if (runningAction === "start" && isHomeActionComplete(statusText, readinessText)) {
          homeActionReadyPolls.current += 1;
          if (homeActionReadyPolls.current >= 2) {
            setTaskResult({ status: "succeeded", title: "Battlegroup Started Successfully" });
            setHomeAction("");
          } else {
            setTaskResult(stackActionPendingResult(runningAction, "confirming"));
          }
        } else if (runningAction === "stop" && loadedState.stopped) {
          setTaskResult({ status: "stopped", title: "Battlegroup Stopped" });
          setHomeAction("");
        } else if (runningAction === "start" || runningAction === "restart") {
          homeActionReadyPolls.current = 0;
        }
        if (taskResult?.status === "failed" && (!/restart/i.test(taskResult.title) || restartReady) && isHomeActionComplete(statusText, readinessText)) {
          setTaskResult({ status: "succeeded", title: /restart/i.test(taskResult.title) ? "Battlegroup Restarted Successfully" : "Battlegroup Started Successfully" });
        } else if (taskResult?.status === "failed" && loadedState.stopped && /stop/i.test(taskResult.title)) {
          setTaskResult({ status: "stopped", title: "Battlegroup Stopped" });
        }
      } else {
        setLocalError(friendlyHomeStatusError(result.statusError || result.readinessError || "Server status and readiness checks failed."));
      }
    } catch (error) {
      if (isActive() && refreshRunId.current === runId) setLocalError(friendlyHomeStatusError(error instanceof Error ? error.message : String(error)));
    } finally {
      if (isActive() && refreshRunId.current === runId) setLoading(false);
    }
  }

  async function runServerAction(action: "start" | "stop" | "restart") {
    if (action === "stop" && !(await confirmAction("Stop the battlegroup?"))) return;
    if (action === "restart" && !(await confirmAction("Restart the battlegroup?"))) return;
    const actionRunId = ++homeActionRunId.current;
    homeActionStartedAt.current = Date.now();
    let commandAction = action;
    const copy = {
      start: { running: "Starting", success: "Battlegroup Started Successfully", failure: "Battlegroup Start Failed" },
      stop: { running: "Stopping", success: "Battlegroup Stopped", failure: "Battlegroup stop failed." },
      restart: { running: "Restarting Battlegroup", success: "Battlegroup Restarted Successfully", failure: "Battlegroup Restart Failed" }
    }[action];
    setLocalError("");
    setHomeAction(action);
    setTaskResult(stackActionPendingResult(action));
    if (action === "restart") {
      const preLoad = await onLoad().catch(() => null);
      if (homeActionRunId.current !== actionRunId) return;
      if (preLoad) {
        applyHomeLoadResult(preLoad);
        const preState = getHomeServerState(preLoad.statusText || status, preLoad.readinessText || readiness);
        if (preState.stopped) {
          homeRestartLifecycle.current = { ...homeRestartLifecycle.current, stopObserved: true };
          commandAction = "start";
        }
      }
    }
    let keepPolling = false;
    try {
      const response = commandAction === "start" ? await serverApi.start() : commandAction === "stop" ? await serverApi.stop() : await serverApi.restart();
      const final = await waitForTaskSilently(response.task);
      if (homeActionRunId.current !== actionRunId) return;
      const details = taskTechnicalDetails(final);
      if (action === "restart") homeRestartLifecycle.current = advanceRestartLifecycleFromTaskDetails(homeRestartLifecycle.current, details);
      const postLoad = await onLoad().catch(() => null);
      if (homeActionRunId.current !== actionRunId) return;
      if (postLoad) applyHomeLoadResult(postLoad);
      const postState = getHomeServerState(postLoad?.statusText || status, postLoad?.readinessText || readiness);
      const postReady = isHomeActionComplete(postLoad?.statusText || status, postLoad?.readinessText || readiness);
      if (action === "restart") {
        homeRestartLifecycle.current = advanceRestartLifecycle(homeRestartLifecycle.current, postLoad?.statusText || status, postLoad?.readinessText || readiness);
      }
      const restartReady = isRestartLifecycleReady(action, homeRestartLifecycle.current);
      const elapsedMs = Date.now() - homeActionStartedAt.current;
      if (action === "stop" && isHomeStopComplete(postLoad?.statusText || status, postLoad?.readinessText || readiness)) {
        setTaskResult({ status: "stopped", title: copy.success, details });
      } else if (action === "restart" && restartReady) {
        keepPolling = true;
        if (isHomeActionComplete(postLoad?.statusText || status, postLoad?.readinessText || readiness)) setHomeAction("");
      } else if (action === "start" && elapsedMs >= 8000 && postReady) {
        keepPolling = true;
        setTaskResult({ ...stackActionPendingResult(action, "confirming"), details });
      } else if (final.status !== "succeeded") {
        if ((action === "start" || action === "restart") && (postState.starting || postState.running)) {
          keepPolling = true;
          setTaskResult({ ...stackActionPendingResult(action), details });
        } else {
          setTaskResult({ status: "failed", title: copy.failure, details });
        }
      } else if (action === "stop") {
        keepPolling = true;
        setTaskResult({ ...stackActionPendingResult(action), details });
      } else if (action === "restart" && final.status === "succeeded") {
        keepPolling = true;
        setTaskResult({ ...stackActionPendingResult(action, "waiting"), details });
      } else if ((action === "start" || action === "restart") && (final.status === "succeeded" || postState.starting || postState.running)) {
        keepPolling = true;
        setTaskResult(final.status === "succeeded" ? stackActionPendingResult(action, "waiting") : stackActionPendingResult(action));
      } else {
        setTaskResult({ status: "failed", title: copy.failure, details });
      }
    } catch (error) {
      if (homeActionRunId.current !== actionRunId) return;
      setTaskResult({ status: "failed", title: copy.failure, details: error instanceof Error ? error.message : String(error) });
    } finally {
      if (homeActionRunId.current === actionRunId && !keepPolling) setHomeAction("");
    }
  }

  useEffect(() => {
    let active = true;
    refresh(() => active);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    async function checkRecentFuncomAuthLogs() {
      const authCheck = await serverApi.checkFuncomToken("10m").catch(() => null);
      if (!active || !authCheck) return;
      if (authCheck.mismatch) {
        setFuncomTokenResult(funcomTokenMismatchFromLogResult(authCheck.details || ""));
        return;
      }
      if (authCheck.ok && (isFuncomTokenAuthFailure(funcomTokenResult) || hasPersistedFuncomTokenAuthFailure())) {
        setFuncomTokenResult(null);
      }
    }
    checkRecentFuncomAuthLogs();
    const id = window.setInterval(checkRecentFuncomAuthLogs, 10000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [status, readiness, funcomTokenResult?.status, funcomTokenResult?.title, funcomTokenResult?.message, setFuncomTokenResult]);

  useEffect(() => {
    if (!runningAction) return;
    let active = true;
    const id = window.setInterval(async () => {
      const result = await onLoad().catch(() => null);
      if (!active || !result) return;
      applyHomeLoadResult(result);
      const currentAction = activeHomeAction.current;
      const statusText = result.statusText || status;
      const readinessText = result.readinessText || readiness;
      if (currentAction === "restart") homeRestartLifecycle.current = advanceRestartLifecycle(homeRestartLifecycle.current, statusText, readinessText);
      const restartReady = isRestartLifecycleReady(currentAction, homeRestartLifecycle.current);
      const elapsedMs = Date.now() - homeActionStartedAt.current;
      if (currentAction === "stop" && isHomeStopComplete(statusText, readinessText)) {
        setTaskResult({ status: "stopped", title: "Battlegroup Stopped" });
        setHomeAction("");
      } else if (currentAction === "restart" && restartReady) {
        if (isHomeActionComplete(statusText, readinessText)) setHomeAction("");
      } else if (currentAction === "start" && elapsedMs >= 8000 && isHomeActionComplete(statusText, readinessText)) {
        homeActionReadyPolls.current += 1;
        if (homeActionReadyPolls.current >= 2) {
          setTaskResult({ status: "succeeded", title: "Battlegroup Started Successfully" });
          setHomeAction("");
        } else {
          setTaskResult(stackActionPendingResult(currentAction, "confirming"));
        }
      } else if (currentAction === "start" || currentAction === "restart") {
        homeActionReadyPolls.current = 0;
        setTaskResult((current) => {
          if (current?.status !== "running") return current;
          const phase = /^Waiting/i.test(current.title) ? "waiting" : "running";
          return { ...current, ...stackActionPendingResult(currentAction, phase) };
        });
      }
    }, 3000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [runningAction, status, readiness, onLoad, setRunningAction, setTaskResult]);

  useEffect(() => {
    if (runningAction || !homeNeedsWarmRefresh(status, readiness)) return;
    let active = true;
    const id = window.setInterval(async () => {
      const result = await onLoad().catch(() => null);
      if (active && result) applyHomeLoadResult(result);
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [runningAction, status, readiness, onLoad]);

  useEffect(() => {
    if (runningAction || homeNeedsWarmRefresh(status, readiness)) return;
    let active = true;
    const id = window.setInterval(async () => {
      if (document.hidden) return;
      const result = await onLoad().catch(() => null);
      if (active && result) applyHomeLoadResult(result);
    }, 30000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [runningAction, status, readiness, onLoad]);

  useEffect(() => {
    if (!isRestartSuccessAwaitingFreshStatus(taskResult, status, readiness)) return;
    let active = true;
    const id = window.setInterval(async () => {
      const result = await onLoad().catch(() => null);
      if (active && result) applyHomeLoadResult(result);
    }, 1500);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [taskResult?.status, taskResult?.title, status, readiness, onLoad]);

  useEffect(() => {
    if (!taskResult || taskResult.status === "running") return;
    const id = window.setTimeout(() => setTaskResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [taskResult?.status, taskResult?.title, setTaskResult]);

  useEffect(() => {
    let active = true;
    async function refreshPerformance() {
      try {
        const next = await serverApi.performance();
        if (!active) return;
        setPerformance(next);
        setPerformanceError("");
      } catch (error) {
        if (!active) return;
        setPerformanceError(error instanceof Error ? error.message : String(error));
      }
    }
    refreshPerformance();
    const id = window.setInterval(refreshPerformance, 3000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, []);

  const serverState = getHomeServerState(status, readiness);
  const controlsState = taskResult?.status === "stopped" && !runningAction ? { running: false, stopped: true, starting: false } : serverState;
  const actionRunning = Boolean(runningAction);
  const refreshDisabled = loading || actionRunning;
  const startDisabled = loading || actionRunning || controlsState.running || controlsState.starting;
  const stopDisabled = runningAction === "stop" || (!actionRunning && (loading || controlsState.stopped));
  const restartDisabled = loading || actionRunning || controlsState.stopped;

  if (loading && !hasLoaded) {
    return <section className="grid">
      <article className="hero-panel wide loading-panel">
        <span className="spinner" aria-hidden="true" />
        <div>
          <h2>Verifying server status...</h2>
          <p>Checking system readiness...</p>
          <p>This may take a few seconds while Docker and Dune complete their health checks.</p>
        </div>
      </article>
    </section>;
  }

  if (localError && !hasLoaded) {
    return <section className="grid">
      <article className="hero-panel wide">
        <h2>Server status unavailable</h2>
        <p className="error">{localError}</p>
        <button onClick={() => refresh()}>Retry Status Check</button>
      </article>
    </section>;
  }

  return (
    <section className="grid">
      <article className="hero-panel">
        <h2>Server Overview</h2>
        <p>Use this dashboard for setup, service health, logs, backups, updates, and player admin actions.</p>
        <div className="action-row">
          <button className={loading ? "refresh-status-button refreshing" : "refresh-status-button"} disabled={refreshDisabled} onClick={() => refresh()}>{loading ? <span className="loading-dots">Refreshing</span> : "Refresh Status"}</button>
          <button disabled={startDisabled} title={controlsState.running ? "Battlegroup is already running." : ""} onClick={() => runServerAction("start")}><Play size={16} /> Start</button>
          <button disabled={stopDisabled} onClick={() => runServerAction("stop")}>Stop</button>
          <button disabled={restartDisabled} onClick={() => runServerAction("restart")}>Restart Battlegroup</button>
        </div>
        {taskResult && <HomeTaskResultCard result={taskResult} />}
        {localError && <p className="error">{localError}</p>}
      </article>
      <PerformanceCards performance={performance} error={performanceError} />
      <HomeHealthCards status={status} readiness={readiness} readinessWarning={readinessWarning} loading={loading} runningAction={runningAction} restartStartObserved={restartStartObserved} taskResult={taskResult} funcomTokenResult={funcomTokenResult} />
    </section>
  );
}

function PerformanceCards({ performance, error }: { performance: PerformanceSnapshot | null; error: string }) {
  const cards = [
    {
      label: "CPU Usage",
      value: performance?.cpuPercent == null ? "Sampling..." : `${performance.cpuPercent.toFixed(1)}%`,
      percent: performance?.cpuPercent ?? 0,
      detail: "Host Processor Load"
    },
    {
      label: "Memory",
      value: performance?.memory.percent == null ? "Unknown" : `${performance.memory.percent.toFixed(1)}%`,
      percent: performance?.memory.percent ?? 0,
      detail: performance ? `${formatBytes(performance.memory.usedBytes)} / ${formatBytes(performance.memory.totalBytes)}` : "Waiting for sample"
    },
    {
      label: "Disk",
      value: performance?.disk.percent == null ? "Unknown" : `${performance.disk.percent.toFixed(1)}%`,
      percent: performance?.disk.percent ?? 0,
      detail: performance ? `${formatBytes(performance.disk.usedBytes)} / ${formatBytes(performance.disk.totalBytes)}` : "Waiting for sample"
    },
    {
      label: "Uptime",
      value: performance?.uptime || "0d 00h 00m",
      percent: null,
      detail: "Host Uptime"
    }
  ];
  return <section className="dashboard-band performance-band wide">
    <h3>Performance</h3>
    {error && !performance && <p className="error">{error}</p>}
    <div className="health-grid health-grid-compact">
      {cards.map((item) => <article className="status-card performance-card" key={item.label}>
        <div className="status-card-title"><span>{item.label}</span><StatusPill value={performance ? "OK" : "INFO"} /></div>
        <strong>{item.value}</strong>
        <p>{item.detail}</p>
        {item.percent !== null && <div className="metric-track" aria-hidden="true"><span style={{ width: `${clampPercent(item.percent)}%` }} /></div>}
      </article>)}
    </div>
  </section>;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let next = value;
  let index = 0;
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024;
    index += 1;
  }
  return `${next >= 10 || index === 0 ? next.toFixed(0) : next.toFixed(1)} ${units[index]}`;
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function HomeTaskResultCard({ result }: { result: HomeTaskResult }) {
  const pending = result.status === "running";
  return <div className={`result-panel home-task-result result-${result.status === "succeeded" || result.status === "stopped" ? "ok" : result.status === "failed" ? "fail" : "running"}`} aria-live="polite">
    <strong className={pending ? "loading-dots" : ""}>{formatResultTitle(result.title, pending)}</strong>
    {result.message && <p>{formatResultMessage(result.message)}</p>}
    {result.details && <TechnicalDetails title="Technical details" text={result.details} />}
  </div>;
}

export function ServerPanel(props: {
  setTask: (task: Task) => void;
  setStatus: (text: string) => void;
  status: string;
  setReadiness: (text: string) => void;
  setPorts: (text: string) => void;
  setDoctor: (text: string) => void;
  ports: string;
  readiness: string;
  doctor: string;
  taskResult: HomeTaskResult | null;
  setTaskResult: Dispatch<SetStateAction<HomeTaskResult | null>>;
  funcomTokenResult: HomeTaskResult | null;
  setFuncomTokenResult: Dispatch<SetStateAction<HomeTaskResult | null>>;
  runningAction: "start" | "stop" | "restart" | "";
  restartStartObserved: boolean;
  setRunningAction: Dispatch<SetStateAction<"start" | "stop" | "restart" | "">>;
  onError: (text: string) => void;
  onRedeploy: () => void;
  confirmAction: ConfirmAction;
}) {
  const [service, setService] = useState(RESTARTABLE_SERVICES[0].value);
  const [restartSchedule, setRestartSchedule] = useState<{ stdout?: string; stderr?: string; exitCode?: number } | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [restartEnabled, setRestartEnabled] = useState(false);
  const [restartTime, setRestartTime] = useState("05:00");
  const [scheduleResult, setScheduleResult] = useState<HomeTaskResult | null>(null);
  const [serverTitle, setServerTitle] = useState("");
  const [savedServerTitle, setSavedServerTitle] = useState("");
  const [serverMode, setServerMode] = useState<ServerMode>("public");
  const [savedServerMode, setSavedServerMode] = useState<ServerMode>("public");
  const [titleResult, setTitleResult] = useState<HomeTaskResult | null>(null);
  const [funcomToken, setFuncomToken] = useState("");
  const [serviceRestartResult, setServiceRestartResult] = useState<HomeTaskResult | null>(null);
  const [serviceRestartingService, setServiceRestartingService] = useState("");
  const [networkBindResult, setNetworkBindResult] = useState<HomeTaskResult | null>(null);
  const [storageCleanupResult, setStorageCleanupResult] = useState<HomeTaskResult | null>(null);
  const [storageCleanupOperation, setStorageCleanupOperation] = useState<"" | "images" | "build-cache">("");
  const [doctorLoading, setDoctorLoading] = useState(!props.doctor);
  const [doctorError, setDoctorError] = useState("");
  const controlActionRunId = useRef(0);
  const controlActionStartedAt = useRef(0);
  const controlActionReadyPolls = useRef(0);
  const controlRestartLifecycle = useRef<RestartLifecycleState>(createRestartLifecycleState());
  const serviceRestartRunId = useRef(0);
  const doctorRequestId = useRef(0);
  const { taskResult, setTaskResult, funcomTokenResult, setFuncomTokenResult, runningAction, setRunningAction, confirmAction } = props;
  const activeControlAction = useRef<"start" | "stop" | "restart" | "">(runningAction);
  const actionRunning = Boolean(runningAction);
  const serviceRestartRunning = serviceRestartResult?.status === "running";
  const titleSaving = titleResult?.status === "running";
  const funcomTokenSaving = funcomTokenResult?.status === "running";
  const scheduleSaving = scheduleResult?.status === "running";
  const storageCleanupRunning = storageCleanupResult?.status === "running";
  const restartScheduleValues = parseKeyValueText(restartSchedule?.stdout || "");
  const scheduleTimerValue = restartScheduleValues.systemd_timer || "";
  const scheduleTimerLabel = scheduleTimerValue ? formatTimerStatus(scheduleTimerValue) : "Not Installed";
  const scheduleTimerInstalled = Boolean(scheduleTimerValue) && !/not installed/i.test(scheduleTimerValue);
  const scheduleTimerActive = /^active$/i.test(scheduleTimerValue);
  const scheduleActive = restartEnabled && scheduleTimerActive;
  const scheduleLoaded = Boolean(restartSchedule);
  const scheduleDisplayActive = scheduleSaving ? restartEnabled : scheduleActive;
  const scheduleStatusLabel = !scheduleLoaded && !scheduleSaving ? "Checking" : scheduleDisplayActive ? "Enabled" : "Disabled";
  const scheduleDisplayTimerLabel = !scheduleLoaded && !scheduleSaving ? "Checking" : scheduleSaving ? restartEnabled ? "Activating" : "Deactivating" : restartEnabled ? scheduleTimerLabel : "Inactive";
  const serverState = getHomeServerState(props.status, props.readiness);
  async function run(action: () => Promise<unknown>) {
    props.onError("");
    try { await action(); } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  }
  function setControlAction(action: "start" | "stop" | "restart" | "") {
    activeControlAction.current = action;
    controlActionReadyPolls.current = 0;
    if (action === "restart" || !action) controlRestartLifecycle.current = createRestartLifecycleState();
    setRunningAction(action);
  }
  async function loadControlStatus(includeDiagnostics = false): Promise<HomeLoadResult> {
    const currentDoctorRequestId = includeDiagnostics ? ++doctorRequestId.current : 0;
    if (includeDiagnostics) {
      setDoctorLoading(true);
      setDoctorError("");
    }
    const requests = includeDiagnostics
      ? [serverApi.status(), serverApi.readiness(), serverApi.ports(), serverApi.doctor()] as const
      : [serverApi.status(), serverApi.readiness()] as const;
    const results = await Promise.allSettled(requests);
    const [nextStatus, nextReadiness, nextPorts, nextDoctor] = results;
    const result: HomeLoadResult = { statusLoaded: false, readinessLoaded: false, statusError: "", readinessError: "", statusText: "", readinessText: "" };
    if (nextStatus?.status === "fulfilled") {
      result.statusText = nextStatus.value.stdout;
      result.statusLoaded = true;
      props.setStatus(nextStatus.value.stdout);
    } else if (nextStatus) {
      result.statusError = nextStatus.reason instanceof Error ? nextStatus.reason.message : String(nextStatus.reason);
    }
    if (nextReadiness?.status === "fulfilled") {
      const readinessText = nextReadiness.value.stdout || nextReadiness.value.stderr || "";
      result.readinessText = readinessText;
      result.readinessLoaded = Number(nextReadiness.value.exitCode || 0) === 0;
      if (!result.readinessLoaded) result.readinessError = nextReadiness.value.stderr || nextReadiness.value.stdout || "Readiness checks are not ready yet.";
      props.setReadiness(readinessText);
    } else if (nextReadiness) {
      result.readinessError = nextReadiness.reason instanceof Error ? nextReadiness.reason.message : String(nextReadiness.reason);
    }
    if (nextPorts?.status === "fulfilled") props.setPorts(nextPorts.value.stdout);
    if (nextDoctor?.status === "fulfilled" && currentDoctorRequestId === doctorRequestId.current) {
      props.setDoctor(nextDoctor.value.stdout || nextDoctor.value.stderr || "");
      setDoctorLoading(false);
    } else if (nextDoctor?.status === "rejected" && currentDoctorRequestId === doctorRequestId.current) {
      setDoctorError(nextDoctor.reason instanceof Error ? nextDoctor.reason.message : String(nextDoctor.reason));
      setDoctorLoading(false);
    }
    if (!result.statusLoaded && result.statusError) props.onError(friendlyHomeStatusError(result.statusError));
    return result;
  }
  async function saveServerConfig() {
    const title = serverTitle.trim();
    if (!title) {
      setTitleResult({ status: "failed", title: "Settings Save Failed", message: "Server title cannot be empty." });
      return;
    }
    const titleChanged = title !== savedServerTitle.trim();
    const modeChanged = serverMode !== savedServerMode;
    if (!titleChanged && !modeChanged) {
      setTitleResult({ status: "succeeded", title: "No Changes to Save" });
      return;
    }
    const changeList = [
      titleChanged ? `title to "${title}"` : "",
      modeChanged ? `mode to ${titleCase(serverMode)}` : ""
    ].filter(Boolean).join(" and ");
    if (!(await confirmAction(`Change server ${changeList}? This saves the setting and refreshes Director/Gateway only if they are already running.`))) return;
    setTitleResult({ status: "running", title: "Saving Settings" });
    props.onError("");
    try {
      const final = await waitForTaskSilently((await serverApi.saveConfig({
        ...(titleChanged ? { title } : {}),
        ...(modeChanged ? { mode: serverMode } : {})
      })).task);
      const details = taskTechnicalDetails(final);
      await loadControlStatus(false).catch(() => null);
      if (final.status === "succeeded") {
        if (titleChanged) setSavedServerTitle(title);
        if (modeChanged) setSavedServerMode(serverMode);
      }
      setTitleResult(final.status === "succeeded"
        ? { status: "succeeded", title: "Settings Saved Successfully", details }
        : { status: "failed", title: "Settings Save Failed", details });
    } catch (error) {
      setTitleResult({ status: "failed", title: "Settings Save Failed", details: error instanceof Error ? error.message : String(error) });
    }
  }
  async function saveFuncomToken() {
    const token = funcomToken.trim();
    if (!token) {
      setFuncomTokenResult({ status: "failed", title: "Token Save Failed", message: "Funcom token cannot be empty." });
      return;
    }
    if (!(await confirmAction("Save the new Funcom token and restart the Dune console so services reload it?"))) return;
    const checkSince = new Date().toISOString();
    setFuncomTokenResult({ status: "running", title: "Saving Funcom Token..." });
    props.onError("");
    try {
      const response = await serverApi.saveFuncomToken(token);
      setFuncomToken("");
      setFuncomTokenResult({ status: "running", title: "Restarting Server" });
      const final = await waitForTaskWithUpdates(response.task, (next) => setFuncomTokenResult(funcomTokenRestartTaskResult(next)));
      const details = taskTechnicalDetails(final);
      if (final.status !== "succeeded") {
        setFuncomTokenResult({ status: "failed", title: "Funcom Token Change Failed", message: "The token was saved, but the server restart failed. Check the task details and try again.", details });
        return;
      }
      const validation = await waitForFuncomTokenRestartValidation(checkSince, details, loadControlStatus, setFuncomTokenResult);
      setFuncomTokenResult(validation);
    } catch (error) {
      setFuncomTokenResult({ status: "failed", title: "Funcom Token Change Failed", message: "Double-check the token and try again.", details: error instanceof Error ? error.message : String(error) });
    }
  }
  async function fixNetworkBinding() {
    if (!(await confirmAction("Set net.ipv4.ip_nonlocal_bind=0 on this host? This fixes public NAT socket binding, but existing game servers must be restarted to rebind their UDP sockets.", { confirmLabel: "Fix Binding" }))) return;
    setNetworkBindResult({ status: "running", title: "Fixing Binding" });
    props.onError("");
    try {
      const final = await waitForTaskSilently((await serverApi.fixNetworkBinding()).task);
      const details = taskTechnicalDetails(final);
      await loadControlStatus(true).catch(() => null);
      setNetworkBindResult(final.status === "succeeded"
        ? { status: "succeeded", title: "Binding Fixed", message: "Restart the battlegroup so game sockets bind to the local IP.", details }
        : { status: "failed", title: "Fix Failed", message: "Run the command shown in Doctor manually, then restart the battlegroup.", details });
    } catch (error) {
      setNetworkBindResult({ status: "failed", title: "Fix Failed", details: error instanceof Error ? error.message : String(error) });
    }
  }
  async function cleanupDockerStorage(operation: "images" | "build-cache") {
    const buildCache = operation === "build-cache";
    const confirmed = await confirmAction(
      buildCache
        ? "Remove all unused Docker build cache? This does not remove running containers, images, volumes, databases, game files, or backups. Docker protects cache used by active builds. Build cache is shared across this Docker host, and future image rebuilds may take longer after cleanup."
        : "Remove obsolete Dune/Funcom and old Dune Docker Console images? Current images, images used by any container, volumes, databases, game files, and backups are protected. Unrelated Docker images are not removed.",
      {
        title: buildCache ? "Clean Docker Build Cache?" : "Clean Obsolete Dune Images?",
        confirmLabel: buildCache ? "Clean Build Cache" : "Clean Images",
        cancelLabel: "Cancel",
        danger: true
      }
    );
    if (!confirmed) return;

    setStorageCleanupOperation(operation);
    setStorageCleanupResult({
      status: "running",
      title: buildCache ? "Cleaning Docker Build Cache" : "Cleaning Obsolete Dune Images",
      message: buildCache ? "Removing unused Docker build cache." : "Removing obsolete project-owned images while protecting current and in-use images."
    });
    props.onError("");
    try {
      const response = buildCache ? await serverApi.cleanupDockerBuildCache() : await serverApi.cleanupDockerImages();
      const final = await waitForTaskSilently(response.task);
      const details = taskTechnicalDetails(final);
      await loadControlStatus(true).catch(() => null);
      setStorageCleanupResult(final.status === "succeeded"
        ? {
            status: "succeeded",
            title: buildCache ? "Build Cache Cleaned" : "Obsolete Images Cleaned",
            message: buildCache ? "Unused Docker build cache was cleaned." : "Obsolete Dune images were cleaned. Protected and unrelated images were left intact.",
            details
          }
        : {
            status: "failed",
            title: buildCache ? "Build Cache Cleanup Failed" : "Image Cleanup Failed",
            message: "Review the task details before trying again.",
            details
          });
    } catch (error) {
      setStorageCleanupResult({
        status: "failed",
        title: buildCache ? "Build Cache Cleanup Failed" : "Image Cleanup Failed",
        details: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setStorageCleanupOperation("");
    }
  }
  async function loadControlVisibleSections() {
    const [statusResult, portsResult] = await Promise.allSettled([loadControlStatus(false), serverApi.ports()]);
    if (portsResult.status === "fulfilled") props.setPorts(portsResult.value.stdout);
    if (statusResult.status === "rejected") throw statusResult.reason;
  }
  async function runServerAction(action: "start" | "stop" | "restart") {
    if (action === "stop" && !(await confirmAction("Stop the battlegroup?"))) return;
    if (action === "restart" && !(await confirmAction("Restart the battlegroup?"))) return;
    serviceRestartRunId.current += 1;
    setServiceRestartingService("");
    const actionRunId = ++controlActionRunId.current;
    controlActionStartedAt.current = Date.now();
    const copy = {
      start: { running: "Starting", success: "Battlegroup Started Successfully", failure: "Battlegroup Start Failed" },
      stop: { running: "Stopping", success: "Battlegroup Stopped", failure: "Battlegroup stop failed." },
      restart: { running: "Restarting Battlegroup", success: "Battlegroup Restarted Successfully", failure: "Battlegroup Restart Failed" }
    }[action];
    props.onError("");
    setControlAction(action);
    setTaskResult(stackActionPendingResult(action));
    let keepPolling = false;
    try {
      const response = action === "start" ? await serverApi.start() : action === "stop" ? await serverApi.stop() : await serverApi.restart();
      const final = await waitForTaskSilently(response.task);
      if (controlActionRunId.current !== actionRunId) return;
      const details = taskTechnicalDetails(final);
      if (action === "restart") controlRestartLifecycle.current = advanceRestartLifecycleFromTaskDetails(controlRestartLifecycle.current, details);
      const postLoad = await loadControlStatus(false).catch(() => null);
      if (controlActionRunId.current !== actionRunId) return;
      const statusText = postLoad?.statusText || props.status;
      const readinessText = postLoad?.readinessText || props.readiness;
      if (action === "restart") controlRestartLifecycle.current = advanceRestartLifecycle(controlRestartLifecycle.current, statusText, readinessText);
      const restartReady = isRestartLifecycleReady(action, controlRestartLifecycle.current);
      const elapsedMs = Date.now() - controlActionStartedAt.current;
      if (action === "stop" && isHomeStopComplete(statusText, readinessText)) {
        setTaskResult({ status: "stopped", title: copy.success, details });
      } else if (action === "restart" && restartReady) {
        keepPolling = true;
        if (isHomeActionComplete(statusText, readinessText)) setControlAction("");
      } else if (action === "start" && elapsedMs >= 8000 && isHomeActionComplete(statusText, readinessText)) {
        keepPolling = true;
        setTaskResult({ ...stackActionPendingResult(action, "confirming"), details });
      } else if (final.status !== "succeeded") {
        const postState = getHomeServerState(statusText, readinessText);
        if ((action === "start" || action === "restart") && (postState.starting || postState.running)) {
          keepPolling = true;
          setTaskResult({ ...stackActionPendingResult(action), details });
        } else {
          setTaskResult({ status: "failed", title: copy.failure, details });
        }
      } else {
        keepPolling = true;
        setTaskResult({ ...stackActionPendingResult(action, "waiting"), details });
      }
    } catch (error) {
      if (controlActionRunId.current !== actionRunId) return;
      setTaskResult({ status: "failed", title: copy.failure, details: error instanceof Error ? error.message : String(error) });
    } finally {
      if (controlActionRunId.current === actionRunId && !keepPolling) setControlAction("");
    }
  }
  async function restartSelectedService() {
    if (!(await confirmAction(`Restart ${friendlyServiceName(service)}?`))) return;
    const selectedService = service;
    const runId = ++serviceRestartRunId.current;
    setServiceRestartingService(selectedService);
    setServiceRestartResult({ status: "running", title: "Restarting" });
    props.onError("");
    try {
      const final = await waitForTaskSilently((await serverApi.restartService(selectedService)).task);
      if (serviceRestartRunId.current !== runId) return;
      const postLoad = await loadControlStatus(true).catch(() => null);
      if (serviceRestartRunId.current !== runId) return;
      const statusText = postLoad?.statusText || props.status;
      if (final.status === "succeeded" && isServiceReady(statusText, selectedService)) {
        setServiceRestartingService("");
        setServiceRestartResult({ status: "succeeded", title: "Service Restarted Successfully", details: taskTechnicalDetails(final) });
      } else if (final.status !== "succeeded") {
        setServiceRestartingService("");
        setServiceRestartResult({ status: "failed", title: "Restart Failed", details: taskTechnicalDetails(final) });
      } else {
        setServiceRestartResult({ status: "running", title: "Restarting", details: taskTechnicalDetails(final) });
      }
    } catch (error) {
      setServiceRestartingService("");
      setServiceRestartResult({ status: "failed", title: "Restart Failed", details: error instanceof Error ? error.message : String(error) });
    }
  }
  async function loadRestartSchedule() {
    setScheduleLoading(true);
    try {
      const result = await serverApi.restartSchedule();
      setRestartSchedule(result);
      const values = parseKeyValueText(result.stdout || "");
      const timerActive = /^active$/i.test(values.systemd_timer || "");
      setRestartEnabled(/^true$/i.test(values.scheduled_restart_enabled || "") && timerActive);
      if (values.restart_time && values.restart_time !== "unset") setRestartTime(toHourMinuteTime(values.restart_time));
    } finally {
      setScheduleLoading(false);
    }
  }
  async function saveSchedule(nextEnabled = restartEnabled) {
    const sanitizedTime = toHourMinuteTime(restartTime);
    if (nextEnabled && !isValidHourMinuteTime(sanitizedTime)) {
      setScheduleResult({ status: "failed", title: "Schedule Save Failed", message: "Daily restart time must be a valid 24-hour time, for example 05:00 or 23:30." });
      return;
    }
    setRestartTime(sanitizedTime);
    setScheduleResult({ status: "running", title: "Saving Schedule" });
    const requestedEnabled = nextEnabled;
    setRestartEnabled(requestedEnabled);
    props.onError("");
    try {
      const final = await waitForTaskSilently((await serverApi.saveRestartSchedule({ enabled: requestedEnabled, time: sanitizedTime })).task);
      const details = taskTechnicalDetails(final);
      const nextSchedule = await serverApi.restartSchedule();
      setRestartSchedule(nextSchedule);
      const nextValues = parseKeyValueText(nextSchedule.stdout || "");
      const timerActive = /^active$/i.test(nextValues.systemd_timer || "");
      const timerInactive = /^inactive$/i.test(nextValues.systemd_timer || "");
      if (requestedEnabled && !timerActive) setRestartEnabled(false);
      if (!requestedEnabled && timerInactive) setRestartEnabled(false);
      setScheduleResult(final.status === "succeeded" && (!requestedEnabled ? timerInactive : timerActive)
        ? { status: "succeeded", title: "Schedule Saved Successfully", details }
        : { status: "failed", title: requestedEnabled ? "Timer Install Failed" : "Schedule Save Failed", details: details || nextSchedule.stdout || nextSchedule.stderr || "" });
    } catch (error) {
      setRestartEnabled(!requestedEnabled);
      setScheduleResult({ status: "failed", title: "Schedule Save Failed", details: error instanceof Error ? error.message : String(error) });
    }
  }
  useEffect(() => {
    run(async () => {
      await Promise.all([loadControlStatus(true), loadRestartSchedule()]);
    });
  }, []);
  useEffect(() => {
    activeControlAction.current = runningAction;
    if (runningAction && controlActionStartedAt.current === 0) controlActionStartedAt.current = Date.now();
    if (!runningAction) controlActionStartedAt.current = 0;
  }, [runningAction]);

  useEffect(() => {
    const title = findLineValue(props.status, ["title", "server title", "SERVER_TITLE"]);
    if (!title || titleSaving) return;
    if (!savedServerTitle || serverTitle.trim() === savedServerTitle.trim()) setServerTitle(title);
    setSavedServerTitle(title);
  }, [props.status, titleSaving, serverTitle, savedServerTitle]);
  useEffect(() => {
    const mode = normalizeServerMode(findLineValue(props.status, ["mode", "server mode", "SERVER_IP_MODE"]));
    if (!mode || titleSaving) return;
    if (serverMode === savedServerMode) setServerMode(mode);
    setSavedServerMode(mode);
  }, [props.status, titleSaving, serverMode, savedServerMode]);
  useEffect(() => {
    if (!runningAction) return;
    let active = true;
    const id = window.setInterval(async () => {
      const result = await loadControlStatus(true).catch(() => null);
      if (!active || !result) return;
      const currentAction = activeControlAction.current;
      const statusText = result.statusText || props.status;
      const readinessText = result.readinessText || props.readiness;
      if (currentAction === "restart") controlRestartLifecycle.current = advanceRestartLifecycle(controlRestartLifecycle.current, statusText, readinessText);
      const restartReady = isRestartLifecycleReady(currentAction, controlRestartLifecycle.current);
      const elapsedMs = Date.now() - controlActionStartedAt.current;
      if (currentAction === "stop" && isHomeStopComplete(statusText, readinessText)) {
        setTaskResult({ status: "stopped", title: "Battlegroup Stopped" });
        setControlAction("");
      } else if (currentAction === "restart" && restartReady) {
        if (isHomeActionComplete(statusText, readinessText)) setControlAction("");
      } else if (currentAction === "start" && elapsedMs >= 8000 && isHomeActionComplete(statusText, readinessText)) {
        controlActionReadyPolls.current += 1;
        if (controlActionReadyPolls.current >= 2) {
          setTaskResult({ status: "succeeded", title: "Battlegroup Started Successfully" });
          setControlAction("");
        } else {
          setTaskResult(stackActionPendingResult(currentAction, "confirming"));
        }
      } else {
        if (currentAction === "start" || currentAction === "restart") controlActionReadyPolls.current = 0;
        setTaskResult((current) => {
          if (current?.status !== "running") return current;
          const phase = /^Waiting/i.test(current.title) ? "waiting" : "running";
          return { ...current, ...stackActionPendingResult(currentAction || "restart", phase) };
        });
      }
    }, 3000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [runningAction, props.status, props.readiness]);
  useEffect(() => {
    if (runningAction || !homeNeedsWarmRefresh(props.status, props.readiness)) return;
    let active = true;
    const id = window.setInterval(async () => {
      if (active) await loadControlStatus(true).catch(() => null);
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [runningAction, props.status, props.readiness]);
  useEffect(() => {
    if (runningAction || homeNeedsWarmRefresh(props.status, props.readiness)) return;
    let active = true;
    const id = window.setInterval(async () => {
      if (active) await loadControlVisibleSections().catch(() => null);
    }, 5000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [runningAction, props.status, props.readiness]);

  useEffect(() => {
    if (!isRestartSuccessAwaitingFreshStatus(taskResult, props.status, props.readiness)) return;
    let active = true;
    const id = window.setInterval(async () => {
      if (active) await loadControlStatus(true).catch(() => null);
    }, 1500);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [taskResult?.status, taskResult?.title, props.status, props.readiness]);
  useEffect(() => {
    let active = true;
    const id = window.setInterval(async () => {
      if (!active) return;
      const currentDoctorRequestId = ++doctorRequestId.current;
      const result = await serverApi.doctor().catch(() => null);
      if (!active || currentDoctorRequestId !== doctorRequestId.current) return;
      if (result) {
        props.setDoctor(result.stdout || result.stderr || "");
        setDoctorError("");
      } else if (!props.doctor) {
        setDoctorError("Doctor diagnostics could not be loaded.");
      }
      setDoctorLoading(false);
    }, 30000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, []);
  useEffect(() => {
    if (!serviceRestartingService || serviceRestartResult?.status !== "running") return;
    let active = true;
    const id = window.setInterval(async () => {
      const result = await loadControlStatus(false).catch(() => null);
      if (!active || !result) return;
      if (isServiceReady(result.statusText || props.status, serviceRestartingService)) {
        setServiceRestartResult({ status: "succeeded", title: "Service Restarted Successfully" });
        setServiceRestartingService("");
      }
    }, 1000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [serviceRestartingService, serviceRestartResult?.status, props.status]);
  useEffect(() => {
    if (!serviceRestartingService || serviceRestartResult?.status !== "running") return;
    if (!isServiceReady(props.status, serviceRestartingService)) return;
    setServiceRestartResult({ status: "succeeded", title: "Service Restarted Successfully" });
    setServiceRestartingService("");
  }, [serviceRestartingService, serviceRestartResult?.status, props.status]);
  useEffect(() => {
    if (!taskResult || taskResult.status === "running") return;
    const id = window.setTimeout(() => setTaskResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [taskResult?.status, taskResult?.title]);
  useEffect(() => {
    if (!serviceRestartResult || serviceRestartResult.status === "running") return;
    const id = window.setTimeout(() => setServiceRestartResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [serviceRestartResult?.status, serviceRestartResult?.title]);
  useEffect(() => {
    if (!titleResult || titleResult.status === "running") return;
    const id = window.setTimeout(() => setTitleResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [titleResult?.status, titleResult?.title]);
  useEffect(() => {
    if (!scheduleResult || scheduleResult.status === "running") return;
    const id = window.setTimeout(() => setScheduleResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [scheduleResult?.status, scheduleResult?.title]);
  useEffect(() => {
    if (!networkBindResult || networkBindResult.status === "running") return;
    const id = window.setTimeout(() => setNetworkBindResult(null), 14000);
    return () => window.clearTimeout(id);
  }, [networkBindResult?.status, networkBindResult?.title]);
  useEffect(() => {
    if (!storageCleanupResult || storageCleanupResult.status === "running") return;
    const id = window.setTimeout(() => setStorageCleanupResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [storageCleanupResult?.status, storageCleanupResult?.title]);
  return (
    <section className="panel server-control-panel">
      <h2>Server Controls</h2>
      <section className="action-section server-title-section">
        <h4>Server Configurations</h4>
        <div className="action-line title-action-line">
          <label>Current Server Title<input value={serverTitle} onChange={(event) => setServerTitle(event.target.value)} /></label>
          <label className="compact-select">Mode<select value={serverMode} onChange={(event) => setServerMode(event.target.value as ServerMode)}>
            <option value="public">Public</option>
            <option value="local">Local</option>
          </select></label>
          <button disabled={actionRunning || serviceRestartRunning || titleSaving} onClick={saveServerConfig}>Save Settings</button>
          {titleResult && <span className={`inline-task-result result-${titleResult.status === "succeeded" ? "ok" : titleResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={titleResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(titleResult.title, titleResult.status === "running")}</strong>
          </span>}
        </div>
      </section>
      <div className="action-row">
        <button disabled={actionRunning || serviceRestartRunning || titleSaving || funcomTokenSaving || scheduleSaving || serverState.running || serverState.starting} onClick={() => runServerAction("start")}><Play size={16} /> Start</button>
        <button disabled={titleSaving || funcomTokenSaving || scheduleSaving || serviceRestartRunning || runningAction === "stop" || (!actionRunning && serverState.stopped)} onClick={() => runServerAction("stop")}>Stop</button>
        <button disabled={actionRunning || serviceRestartRunning || titleSaving || funcomTokenSaving || scheduleSaving || serverState.stopped} onClick={() => runServerAction("restart")}>Restart Battlegroup</button>
        <button disabled={actionRunning || serviceRestartRunning || titleSaving || funcomTokenSaving || scheduleSaving} onClick={props.onRedeploy}>Redeploy</button>
      </div>
      {taskResult && <HomeTaskResultCard result={taskResult} />}
      <div className="action-line restart-service-line">
        <label className="compact-select">Restart Service<select value={service} onChange={(event) => setService(event.target.value)}>
          {RESTARTABLE_SERVICES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select></label>
        <button disabled={actionRunning || serviceRestartRunning || titleSaving || funcomTokenSaving || scheduleSaving} onClick={restartSelectedService}>Restart Service</button>
        {serviceRestartResult && <span className={`inline-task-result result-${serviceRestartResult.status === "succeeded" ? "ok" : serviceRestartResult.status === "failed" ? "fail" : "running"}`}>
          <strong className={serviceRestartResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(serviceRestartResult.title, serviceRestartResult.status === "running")}</strong>
        </span>}
      </div>
      <ReadinessTimeline text={props.readiness} statusText={props.status} />
      <PortChecklist text={props.ports} statusText={props.status} />
      <section className="action-section">
        <div className="panel-title"><h4>Change Funcom Token</h4></div>
        <div className="action-line funcom-token-action-line">
          <label className="funcom-token-field"><SecretInput aria-label="Funcom token" value={funcomToken} onChange={(event) => setFuncomToken(event.target.value)} placeholder="Paste new token" /></label>
          <button disabled={actionRunning || serviceRestartRunning || titleSaving || funcomTokenSaving || scheduleSaving} onClick={saveFuncomToken}>Save Token</button>
          {funcomTokenResult && <span className={`inline-task-result result-${funcomTokenResult.status === "succeeded" ? "ok" : funcomTokenResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={funcomTokenResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(funcomTokenResult.title, funcomTokenResult.status === "running")}</strong>
            {funcomTokenResult.message && <span className="inline-task-message">{formatResultMessage(funcomTokenResult.message)}</span>}
          </span>}
        </div>
      </section>
      <DoctorSummary
        text={props.doctor}
        readiness={props.readiness}
        loading={doctorLoading}
        error={doctorError}
        onFixBinding={fixNetworkBinding}
        onCleanupImages={() => { void cleanupDockerStorage("images"); }}
        onCleanupBuildCache={() => { void cleanupDockerStorage("build-cache"); }}
        fixingBinding={networkBindResult?.status === "running"}
        cleanupOperation={storageCleanupOperation}
        fixDisabled={actionRunning || serviceRestartRunning || titleSaving || funcomTokenSaving || scheduleSaving || storageCleanupRunning}
      />
      {networkBindResult && <HomeTaskResultCard result={networkBindResult} />}
      {storageCleanupResult && <HomeTaskResultCard result={storageCleanupResult} />}
    </section>
  );
}

async function waitForTask(task: Task, setTask: (task: Task) => void) {
  let current = task;
  setTask(current);
  for (let i = 0; i < 180 && !["succeeded", "failed", "cancelled"].includes(current.status); i += 1) {
    await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 1000));
    current = (await setupApi.task(current.id)).task;
    setTask(current);
  }
  return current;
}

async function waitForTaskSilently(task: Task) {
  let current = task;
  for (let i = 0; i < 180 && !["succeeded", "failed", "cancelled"].includes(current.status); i += 1) {
    await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 1000));
    current = (await setupApi.task(current.id)).task;
  }
  return current;
}

async function waitForTaskWithUpdates(task: Task, onUpdate: (task: Task) => void) {
  let current = task;
  onUpdate(current);
  for (let i = 0; i < 3600 && !isTerminalTask(current.status); i += 1) {
    await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 1000));
    current = (await setupApi.task(current.id)).task;
    onUpdate(current);
  }
  return current;
}


function funcomTokenRestartTaskResult(task: Task): HomeTaskResult {
  const details = taskTechnicalDetails(task);
  if (funcomTokenMismatchDetected(details) || funcomTokenMismatchDetected(task.errorMessage || "")) {
    return funcomTokenMismatchResult(details);
  }
  if (task.status === "failed") {
    return {
      status: "failed",
      title: "Funcom Token Change Failed",
      message: "The token was saved, but the server restart failed. Check the task details and try again.",
      details
    };
  }
  if (task.status === "succeeded") {
    return {
      status: "running",
      title: "Checking Funcom Token",
      details
    };
  }
  return {
    status: "running",
    title: "Restarting Server",
    details
  };
}

async function waitForFuncomTokenRestartValidation(
  checkSince: string,
  details: string,
  loadControlStatus: (includeDiagnostics?: boolean) => Promise<HomeLoadResult>,
  setResult: Dispatch<SetStateAction<HomeTaskResult | null>>
): Promise<HomeTaskResult> {
  for (let attempt = 0; attempt < 72; attempt += 1) {
    const authCheck = await serverApi.checkFuncomToken(checkSince).catch((error) => ({ ok: false, mismatch: false, checkedSince: checkSince, details: error instanceof Error ? error.message : String(error) }));
    if (authCheck.mismatch) return funcomTokenMismatchResult([details, authCheck.details || ""].filter(Boolean).join("\n"));

    const status = await loadControlStatus(false).catch(() => null);
    if (status && isHomeActionComplete(status.statusText, status.readinessText)) {
      setResult({ status: "running", title: "Checking Funcom Token", details });
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 2500));
      const finalCheck = await serverApi.checkFuncomToken(checkSince).catch((error) => ({ ok: false, mismatch: false, checkedSince: checkSince, details: error instanceof Error ? error.message : String(error) }));
      if (finalCheck.mismatch) return funcomTokenMismatchResult([details, finalCheck.details || ""].filter(Boolean).join("\n"));
      return {
        status: "succeeded",
        title: "Funcom Token Changed Successfully",
        message: "The Funcom token was changed successfully and the server is up and running.",
        details
      };
    }

    setResult({
      status: "running",
      title: "Restarting Server",
      details
    });
    await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 5000));
  }

  const finalCheck = await serverApi.checkFuncomToken(checkSince).catch((error) => ({ ok: false, mismatch: false, checkedSince: checkSince, details: error instanceof Error ? error.message : String(error) }));
  if (finalCheck.mismatch) return funcomTokenMismatchResult([details, finalCheck.details || ""].filter(Boolean).join("\n"));
  return {
    status: "failed",
    title: "Funcom Token Change Needs Review",
    message: "The token was saved, but the server did not become fully ready. Check Server Control status and logs.",
    details
  };
}

function funcomTokenMismatchResult(details: string): HomeTaskResult {
  return {
    status: "failed",
    title: "Authorization Failed",
    message: "Please make sure the Funcom token belongs to the current Battlegroup ID, then save it again.",
    details
  };
}

function funcomTokenMismatchFromLogResult(details: string): HomeTaskResult {
  return {
    status: "failed",
    title: "Authorization Failed",
    message: "Please make sure the Funcom token belongs to the current Battlegroup ID, then save it again.",
    details
  };
}

function isFuncomTokenAuthFailure(result: HomeTaskResult | null) {
  return Boolean(result && result.status === "failed" && funcomTokenMismatchDetected(result.details || ""));
}

export function loadPersistedFuncomTokenResult(): HomeTaskResult | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(FUNCOM_TOKEN_AUTH_ERROR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HomeTaskResult;
    return isFuncomTokenAuthFailure(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasPersistedFuncomTokenAuthFailure() {
  return Boolean(loadPersistedFuncomTokenResult());
}

export function persistFuncomTokenResult(result: HomeTaskResult | null) {
  if (typeof window === "undefined") return;
  try {
    if (isFuncomTokenAuthFailure(result)) {
      window.localStorage.setItem(FUNCOM_TOKEN_AUTH_ERROR_KEY, JSON.stringify(result));
    } else if (!result || result.status === "succeeded") {
      window.localStorage.removeItem(FUNCOM_TOKEN_AUTH_ERROR_KEY);
    }
  } catch {
    // Ignore storage failures; the visible in-page result still works.
  }
}


function toHourMinuteTime(value: unknown) {
  const text = String(value || "").trim();
  if (!text || /^unset$/i.test(text)) return "Unset";
  const match = text.match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  return match ? `${match[1]}:${match[2]}` : text;
}

function sanitizeTimeInput(value: string) {
  return value.replace(/[^\d:]/g, "").slice(0, 5);
}

function isValidHourMinuteTime(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}





function HomeHealthCards({ status, readiness, readinessWarning, loading, runningAction, restartStartObserved, taskResult, funcomTokenResult }: { status: string; readiness: string; readinessWarning: string; loading: boolean; runningAction: "start" | "stop" | "restart" | ""; restartStartObserved: boolean; taskResult: HomeTaskResult | null; funcomTokenResult: HomeTaskResult | null }) {
  const funcomTokenCheckRunning = funcomTokenResult?.status === "running";
  const summary = summarizeHomeStatus(status, readiness, readinessWarning, loading, runningAction, taskResult, restartStartObserved, !funcomTokenCheckRunning && (isFuncomTokenAuthFailure(funcomTokenResult) || hasPersistedFuncomTokenAuthFailure()));
  return <div className="home-health wide">
    <section className="dashboard-band">
      <h3>Server Identity</h3>
      <div className="health-grid">
        {summary.identity.map((item) => <article className="status-card" key={item.label}>
          <div className="status-card-title"><span>{item.label}</span><StatusPill value={item.status} /></div>
          <strong>{formatDisplayValue(item.value)}</strong>
          {item.detail && <p>{item.detail}</p>}
        </article>)}
      </div>
    </section>
    <section className="dashboard-band">
      <h3>Readiness & Health</h3>
      <div className="health-grid health-grid-compact">
        {summary.health.map((item) => <article className="status-card" key={item.label}>
          <div className="status-card-title"><span>{item.label}</span><StatusPill value={item.status} /></div>
          <strong>{formatDisplayValue(item.value)}</strong>
          {item.detail && <p>{item.detail}</p>}
        </article>)}
      </div>
    </section>
  </div>;
}

function DoctorSummary({ text, readiness, loading, error, onFixBinding, onCleanupImages, onCleanupBuildCache, fixingBinding, cleanupOperation, fixDisabled }: {
  text: string;
  readiness: string;
  loading: boolean;
  error: string;
  onFixBinding: () => void;
  onCleanupImages: () => void;
  onCleanupBuildCache: () => void;
  fixingBinding: boolean;
  cleanupOperation: "" | "images" | "build-cache";
  fixDisabled: boolean;
}) {
  const readinessHealthy = /^READY:/m.test(readiness);
  const issues = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^WARN\s+/i.test(line)).filter((line) => {
    if (!readinessHealthy) return true;
    return !/Director heartbeat not seen in recent logs|Gateway DB monitoring not seen in recent logs|DeepDesert_1 is always-on/i.test(line);
  }).slice(0, 6);
  const info = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^INFO\s+/i.test(line)).slice(0, 3);
  return <section className="action-section doctor-section">
    <div className="panel-title"><h4>Doctor Diagnostics</h4></div>
    {loading ? <p className="loading-dots">Checking diagnostics</p> : error ? <p className="error">{error}</p> : text ? <p>{issues.length ? `${issues.length} diagnostic item${issues.length === 1 ? "" : "s"} need attention.` : "Doctor diagnostics look healthy."}</p> : <p>Doctor diagnostics have not loaded yet.</p>}
    {issues.length > 0 && <div className="check-grid">{issues.map((issue, index) => {
      const advice = doctorAdvice(issue);
      const canFixBinding = isPublicIpBindIssue(issue);
      const canCleanupImages = isDockerImageCleanupIssue(issue);
      const canCleanupBuildCache = isDockerBuildCacheCleanupIssue(issue);
      return <article className="check-card" key={`${issue}-${index}`}>
        <div>
          <strong>{advice.title}</strong>
          <p>{advice.message}</p>
          {advice.nextStep && <span className="muted">{advice.nextStep}</span>}
          {canFixBinding && <div className="action-row compact-action-row">
            <button disabled={fixingBinding || fixDisabled} onClick={onFixBinding}>{fixingBinding ? "Fixing..." : "Fix Binding"}</button>
          </div>}
          {canCleanupImages && <div className="action-row compact-action-row">
            <button disabled={Boolean(cleanupOperation) || fixDisabled} onClick={onCleanupImages}><Trash2 size={15} /> {cleanupOperation === "images" ? "Cleaning..." : "Clean Images"}</button>
          </div>}
          {canCleanupBuildCache && <div className="action-row compact-action-row">
            <button disabled={Boolean(cleanupOperation) || fixDisabled} onClick={onCleanupBuildCache}><Trash2 size={15} /> {cleanupOperation === "build-cache" ? "Cleaning..." : "Clean Build Cache"}</button>
          </div>}
        </div>
        <StatusPill value="WARN" />
      </article>;
    })}</div>}
    {!issues.length && info.length > 0 && <div className="check-grid">{info.map((line, index) => {
      const clean = friendlyIssueLine(line);
      return <article className="check-card" key={`${line}-${index}`}><div><strong>Diagnostic Note</strong><p>{clean}</p></div><StatusPill value="INFO" /></article>;
    })}</div>}
  </section>;
}

function doctorAdvice(issue: string) {
  const clean = friendlyIssueLine(issue);
  if (isPublicIpBindIssue(issue)) return {
    title: "Public IP bind detected",
    message: clean,
    nextStep: "Use Fix Binding, then restart the battlegroup so game sockets bind to the local IP.",
    status: "WARN"
  };
  if (/director.*heartbeat/i.test(issue)) return {
    title: "Director heartbeat not recently observed",
    message: "Check Director logs if readiness is unhealthy.",
    nextStep: "",
    status: "WARN"
  };
  if (/gateway.*db|db monitoring/i.test(issue)) return {
    title: "Gateway DB monitoring not recently observed",
    message: "Check Gateway logs if readiness is unhealthy.",
    nextStep: "",
    status: "WARN"
  };
  if (/public.*private|advertis/i.test(issue)) return {
    title: "Advertised IP Warning",
    message: clean,
    nextStep: "Review Setup -> Server Identity and Network/Ports for Local vs Public mode.",
    status: "WARN"
  };
  if (isDockerImageCleanupIssue(issue)) return {
    title: "Obsolete Docker images can be cleaned",
    message: clean,
    nextStep: "Clean Images removes obsolete project-owned images while protecting current, in-use, and unrelated images.",
    status: "WARN"
  };
  if (isDockerBuildCacheCleanupIssue(issue)) return {
    title: "Unused Docker build cache can be cleaned",
    message: clean,
    nextStep: "Clean Build Cache removes unused build cache. Docker protects active builds, containers, images, volumes, databases, game files, and backups.",
    status: "WARN"
  };
  return {
    title: "Diagnostic Warning",
    message: clean,
    nextStep: "Open the relevant service logs for recent context.",
    status: inferStatus(issue)
  };
}

function isPublicIpBindIssue(issue: string) {
  return /public ip bind risk|ip_nonlocal_bind=1/i.test(issue);
}

function isDockerImageCleanupIssue(issue: string) {
  return /Docker has .*reclaimable images|obsolete project-owned image/i.test(issue);
}

function isDockerBuildCacheCleanupIssue(issue: string) {
  return /Docker has .*reclaimable build cache/i.test(issue);
}

function parseKeyValueText(text: string) {
  const out: Record<string, string> = {};
  for (const rawLine of stripAnsi(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^([^:=]{2,80}):\s*(.*)$/);
    if (!match) continue;
    out[match[1].trim().toLowerCase().replace(/\s+/g, "_")] = match[2].trim();
  }
  return out;
}

function commandStatusSummary(result: { stdout?: string; stderr?: string; exitCode?: number } | null) {
  if (!result) return { status: "Loading", reason: "" };
  if (Number(result.exitCode || 0) === 0) return { status: "Checked", reason: "" };
  return { status: "Check Failed", reason: result.stderr || result.stdout || "Command failed" };
}

function parseUserSettingRows(text: string) {
  return stripAnsi(text).split(/\r?\n/).map((line) => {
    const [key, value] = line.split(/\t/);
    if (!key) return null;
    return { key, setting: friendlySettingName(key), value: value || "" };
  }).filter(Boolean) as Record<string, string>[];
}

function friendlySettingName(key: string) {
  return key.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function firstArray(...values: unknown[]) {
  return values.find((value) => Array.isArray(value)) as unknown[] | undefined;
}

function summarizeHomeStatus(status: string, readiness: string, readinessWarning: string, loading: boolean, runningAction: "start" | "stop" | "restart" | "" = "", taskResult: HomeTaskResult | null = null, restartStarted = false, funcomTokenAuthFailure = false) {
  void readinessWarning;
  const serverState = getHomeServerState(status, readiness);
  const bootStarting = isHomeBootStarting(status, readiness);
  const actionFailed = taskResult?.status === "failed" && !serverState.running;
  const actionStopped = taskResult?.status === "stopped";
  const restartSuccessAwaitingFreshStatus = isRestartSuccessAwaitingFreshStatus(taskResult, status, readiness);
  const rawOverall = findLineValue(status, ["overall"]);
  const readinessReady = /^READY:/m.test(readiness);
  const liveOverall = readinessReady ? "OK" : friendlyHomeOverall(rawOverall || (readiness ? "Readiness checked" : readinessWarning ? "Status loaded, readiness warning" : status ? "Status loaded" : loading ? "Checking" : "Unknown"));
  const rawContainers = preferKnownHomeHealth(summarizeContainers(status), summarizeReadinessContainers(readiness));
  const rawListeners = preferKnownHomeHealth(summarizeListeners(status), summarizeReadinessListeners(readiness));
  const rawDatabase = preferKnownHomeHealth(summarizeDatabase(status), summarizeReadinessDatabase(readiness));
  const rawGames = preferKnownHomeHealth(summarizeGameServers(status), summarizeReadinessGameServers(readiness));
  const rawRabbit = preferKnownHomeHealth(summarizeRabbit(status), summarizeReadinessRabbit(readiness));
  const rawFls = preferKnownHomeHealth(summarizeFls(status), summarizeReadinessFls(readiness));
  const readyOverride = readinessReady ? { label: "OK", status: "Ready", detail: "" } : null;
  const coreReadyWithReview = !runningAction && isHomeCoreReadyWithReview(status, readiness, rawContainers, rawListeners, rawDatabase, rawGames, rawRabbit, rawFls);
  const isStarting = runningAction === "start" || runningAction === "restart" || restartSuccessAwaitingFreshStatus || (bootStarting && !coreReadyWithReview);
  const restartSuccessObserved = taskResult?.status === "succeeded" && /restart/i.test(taskResult.title || "");
  const restartStartObserved = restartStarted || restartSuccessAwaitingFreshStatus || restartSuccessObserved;
  const transitionOverall = runningAction === "restart"
    ? restartStartObserved ? "Starting" : "Restarting Battlegroup"
    : runningAction === "stop" ? "Stopping" : isStarting ? "Starting" : "";
  const warmingOverall = /^Warming$/i.test(rawGames.label) ? "Warming" : "";
  const overall = readinessReady && !runningAction ? "OK" : isStarting ? transitionOverall : runningAction ? transitionOverall : serverState.stopped || actionStopped ? "Stopped" : coreReadyWithReview ? "Needs Review" : warmingOverall || liveOverall;
  const attentionHealth = !isStarting && !restartSuccessAwaitingFreshStatus && (serverState.stopped || actionStopped || actionFailed) ? attentionHomeHealthCards() : null;
  const transitionAction: "start" | "stop" | "restart" | "" = restartStartObserved
    ? "start"
    : runningAction === "restart" ? ""
      : runningAction || (restartSuccessAwaitingFreshStatus || (bootStarting && !coreReadyWithReview) ? "start" : "");
  const containers = readyOverride || transitionHomeHealthCard(rawContainers, transitionAction) || attentionHealth?.containers || rawContainers;
  const listeners = readyOverride || transitionHomeHealthCard(rawListeners, transitionAction) || attentionHealth?.listeners || rawListeners;
  const database = readyOverride || transitionHomeHealthCard(rawDatabase, transitionAction) || attentionHealth?.database || rawDatabase;
  const games = readyOverride || transitionHomeHealthCard(rawGames, transitionAction) || attentionHealth?.games || rawGames;
  const rabbit = readyOverride || transitionHomeHealthCard(rawRabbit, transitionAction) || attentionHealth?.rabbit || rawRabbit;
  const fls = funcomTokenAuthFailure
    ? { label: "Token Mismatch Detected", status: "FAILED", detail: "" }
    : readyOverride || transitionHomeHealthCard(rawFls, transitionAction) || attentionHealth?.fls || rawFls;
  const population = formatHomePopulation(findPopulation(status) || findLineValue(status, ["population", "players"]));
  return {
    identity: [
      { label: "Overall", value: overall, status: homeOverallBadge(overall), detail: "" },
      { label: "Title", value: findLineValue(status, ["title", "server title", "SERVER_TITLE"]) || "Unknown", status: "Info", detail: "" },
      { label: "Region", value: findLineValue(status, ["region", "SERVER_REGION"]) || "Unknown", status: "Info", detail: "" },
      { label: "Mode", value: titleCase(findLineValue(status, ["mode", "server mode"]) || "Unknown"), status: "Info", detail: "" },
      { label: "Server IP", value: findLineValue(status, ["server ip", "ip", "SERVER_IP"]) || "Unknown", status: "Info", detail: "" },
      { label: "Battlegroup", value: findLineValue(status, ["battlegroup", "battlegroup id"]) || "Unknown", status: "Info", detail: "" },
      { label: "Population", value: population, status: population.includes("?") || population === "Unavailable" ? "WARN" : "Info", detail: "" }
    ],
    health: [
      { label: "Containers", value: containers.label, status: containers.status, detail: containers.detail },
      { label: "Listeners", value: listeners.label, status: listeners.status, detail: listeners.detail },
      { label: "Database", value: database.label, status: database.status, detail: database.detail },
      { label: "Game Servers", value: games.label, status: games.status, detail: games.detail },
      { label: "RabbitMQ", value: rabbit.label, status: rabbit.status, detail: rabbit.detail },
      { label: "Funcom/FLS", value: fls.label, status: fls.status, detail: fls.detail }
    ]
  };
}

function homeNeedsWarmRefresh(status: string, readiness: string) {
  if (!status && !readiness) return false;
  const summary = summarizeHomeStatus(status, readiness, "", false);
  const overall = summary.identity.find((item) => item.label === "Overall");
  const games = summary.health.find((item) => item.label === "Game Servers");
  const overallOk = /^OK$/i.test(String(overall?.value || "")) || /^Ready$/i.test(String(overall?.status || ""));
  const gamesOk = /^OK$/i.test(String(games?.value || "")) && /^Ready$/i.test(String(games?.status || ""));
  const gameServerText = sectionLines(status, "Game servers").join("\n");
  const warming = /Overall:\s*(WARMING|WAIT|STARTING)/i.test(status) ||
    /\b(WARMING|WAIT|STARTING)\b/i.test(gameServerText) ||
    /^(Warming|Starting)$/i.test(String(games?.value || "")) ||
    isHomeBootStarting(status, readiness);
  return warming && (!overallOk || !gamesOk);
}

function isHomeCoreReadyWithReview(
  status: string,
  readiness: string,
  containers: { label: string; status: string; detail: string },
  listeners: { label: string; status: string; detail: string },
  database: { label: string; status: string; detail: string },
  games: { label: string; status: string; detail: string },
  rabbit: { label: string; status: string; detail: string },
  fls: { label: string; status: string; detail: string }
) {
  const text = `${status}\n${readiness}`;
  const gamesReady = isReadyHomeCard(games) || (/OK\s+Survival_1\s+ready/i.test(text) && /OK\s+Overmap\s+ready/i.test(text));
  const databaseReady = isReadyHomeCard(database) || /OK\s+world_partition rows:/i.test(text);
  const rabbitReady = isReadyHomeCard(rabbit) || /OK\s+game server sg\.\* RMQ connections/i.test(text);
  const hasReview = [containers, listeners, database, games, rabbit, fls].some((item) => /^Needs Review$/i.test(item.label) || /^WARN$/i.test(item.status));
  return gamesReady && databaseReady && rabbitReady && hasReview;
}

function isReadyHomeCard(item: { label: string; status: string; detail: string }) {
  return /^OK$/i.test(item.label) && /^Ready$/i.test(item.status);
}

function isRestartSuccessAwaitingFreshStatus(taskResult: HomeTaskResult | null, status: string, readiness: string): boolean {
  return taskResult?.status === "succeeded" &&
    /restart/i.test(taskResult.title || "") &&
    getHomeServerState(status, readiness).stopped &&
    !isHomeStartComplete(status, readiness) &&
    !isHomeReadinessOperational(readiness);
}


function formatTimerStatus(value: string) {
  const text = String(value || "").trim();
  if (/^not installed$/i.test(text)) return "Not Installed";
  return titleCase(text);
}

function friendlyIssueLine(line: string) {
  return line
    .replace(/^OK\s+/i, "")
    .replace(/^WARN\s+/i, "")
    .replace(/^WAIT\s+/i, "")
    .replace(/^FAIL\s+/i, "")
    .replace(/\bRabbitMQ game\b/g, "RabbitMQ Game")
    .replace(/\bRabbitMQ Game is Not Running\b/g, "RabbitMQ Game is not running")
    .replace(/\bNot Running\s+-\s+missing\b/gi, "Not Running - Missing")
    .replace(/^Up\s+About\b/, "Up about")
    .replace(/\s+/g, " ")
    .trim();
}

function isServiceReady(status: string, service: string) {
  const container = serviceContainerName(service);
  return sectionLines(status, "Containers").some((line) => {
    const match = line.match(/^(\S+)\s+(.+)$/);
    return Boolean(match && match[1] === container && /\bUp\b/i.test(match[2]));
  });
}

function serviceContainerName(service: string) {
  const normalized = service.replace(/^dune-/, "");
  const containers: Record<string, string> = {
    postgres: "dune-postgres",
    "rmq-admin": "dune-rmq-admin",
    "rmq-game": "dune-rmq-game",
    "text-router": "dune-text-router",
    director: "dune-director",
    gateway: "dune-server-gateway",
    "survival-1": "dune-server-survival-1",
    overmap: "dune-server-overmap"
  };
  return containers[normalized] || service;
}

function isTerminalTask(status: string) {
  return ["succeeded", "failed", "cancelled"].includes(status);
}

export function isHomeActionComplete(status: string, readiness: string) {
  const statusReady = isHomeStartComplete(status, readiness);
  const readinessReady = isHomeReadinessOperational(readiness);
  const summary = summarizeHomeStatus(status, readiness, "", false);
  const games = summary.health.find((item) => item.label === "Game Servers");
  const healthOk = summary.health.length > 0 && summary.health.every((item) =>
    /^OK$/i.test(String(item.value || "")) && /^Ready$/i.test(String(item.status || ""))
  );
  const nonGameHealthOk = summary.health.filter((item) => item.label !== "Game Servers").every((item) =>
    /^OK$/i.test(String(item.value || "")) && /^Ready$/i.test(String(item.status || ""))
  );
  const gamesWarming = /^Warming$/i.test(String(games?.value || ""));
  return statusReady || readinessReady || (healthOk || (gamesWarming && nonGameHealthOk));
}

function isHomeReadinessOperational(readiness: string) {
  if (/^\s*FAIL\b/m.test(readiness)) return false;
  const requiredSignals = [
    /OK\s+container\s+dune-postgres/i,
    /OK\s+container\s+dune-rmq-admin/i,
    /OK\s+container\s+dune-rmq-game/i,
    /OK\s+container\s+dune-text-router/i,
    /OK\s+container\s+dune-director/i,
    /OK\s+container\s+dune-server-gateway/i,
    /OK\s+container\s+dune-server-survival-1/i,
    /OK\s+container\s+dune-server-overmap/i,
    /OK\s+world_partition rows:/i,
    /OK\s+game server sg\.\* RMQ connections/i
  ];
  return requiredSignals.every((pattern) => pattern.test(readiness));
}

export function isHomeStopComplete(status: string, readiness: string) {
  if (getHomeServerState(status, readiness).stopped) return true;
  const requiredContainers = [
    "dune-postgres",
    "dune-rmq-admin",
    "dune-rmq-game",
    "dune-text-router",
    "dune-director",
    "dune-server-gateway",
    "dune-server-survival-1",
    "dune-server-overmap"
  ];
  const containerLines = sectionLines(status, "Containers").filter((line) => !/^SERVICE\s+STATUS/i.test(line));
  const statusContainersStopped = containerLines.length >= requiredContainers.length && requiredContainers.every((name) =>
    containerLines.some((line) => new RegExp(`^${name}\\s+\\b(missing|stopped|exited|dead|not running)\\b`, "i").test(line))
  );
  if (statusContainersStopped) return true;

  const text = `${status}\n${readiness}`;
  const readinessContainersStopped = requiredContainers.every((name) =>
    new RegExp(`FAIL\\s+container\\s+${name}\\b`, "i").test(text)
  );
  const allListenersMissing = sectionLines(status, "Listeners").filter((line) => !/^CHECK\s+PORT\s+STATUS/i.test(line)).length >= 6 &&
    sectionLines(status, "Listeners").filter((line) => !/^CHECK\s+PORT\s+STATUS/i.test(line)).every((line) => /\bMISSING\b/i.test(line));
  const gameServersStopped = /Survival_1\s+NOT RUNNING/i.test(text) && /Overmap\s+NOT RUNNING/i.test(text);
  return readinessContainersStopped || (allListenersMissing && gameServersStopped);
}

function hasRestartStopSignal(status: string, readiness: string) {
  const text = `${status}\n${readiness}`;
  const requiredContainers = [
    "dune-postgres",
    "dune-rmq-admin",
    "dune-rmq-game",
    "dune-text-router",
    "dune-director",
    "dune-server-gateway",
    "dune-server-survival-1",
    "dune-server-overmap"
  ];
  const containerLines = sectionLines(status, "Containers").filter((line) => !/^SERVICE\s+STATUS/i.test(line));
  return requiredContainers.some((name) =>
    containerLines.some((line) => new RegExp(`^${name}\\s+\\b(missing|stopped|exited|dead|not running)\\b`, "i").test(line)) ||
    new RegExp(`\\bFAIL\\s+container\\s+${name}\\b`, "i").test(text)
  );
}

function hasRestartStartSignal(status: string, readiness: string) {
  const text = `${status}\n${readiness}`;
  const requiredContainers = [
    "dune-postgres",
    "dune-rmq-admin",
    "dune-rmq-game",
    "dune-text-router",
    "dune-director",
    "dune-server-gateway",
    "dune-server-survival-1",
    "dune-server-overmap"
  ];
  const containerLines = sectionLines(status, "Containers").filter((line) => !/^SERVICE\s+STATUS/i.test(line));
  return requiredContainers.some((name) =>
    containerLines.some((line) => new RegExp(`^${name}\\s+.*\\bUp\\b`, "i").test(line)) ||
    new RegExp(`\\bOK\\s+container\\s+${name}\\b`, "i").test(text)
  );
}

function isHomeStartComplete(status: string, readiness: string) {
  const serverState = getHomeServerState(status, readiness);
  if (serverState.stopped) return false;

  const containerLines = sectionLines(status, "Containers").filter((line) => !/^SERVICE\s+STATUS/i.test(line));
  const requiredContainers = [
    "dune-postgres",
    "dune-rmq-admin",
    "dune-rmq-game",
    "dune-text-router",
    "dune-director",
    "dune-server-gateway",
    "dune-server-survival-1",
    "dune-server-overmap"
  ];
  const containersReady = requiredContainers.every((name) =>
    containerLines.some((line) => new RegExp(`^${name}\\s+Up\\b`, "i").test(line))
  );

  const listenerLines = sectionLines(status, "Listeners").filter((line) => !/^CHECK\s+PORT\s+STATUS/i.test(line));
  const listenersReady = listenerLines.length > 0 && !listenerLines.some((line) => /\b(MISSING|FAIL|ERROR)\b/i.test(line));

  const partitionValue = findLineValue(sectionLines(status, "Database").join("\n"), ["World partitions"]);
  const databaseReady = Number(partitionValue) > 0;

  const flsLines = sectionLines(status, "Funcom/FLS summary");
  const flsReady = flsLines.length > 0 && !flsLines.some((line) => /:\s*(WAIT|FAIL|ERROR|MISSING)/i.test(line));

  const rabbit = summarizeRabbit(status);
  const rabbitReady = /^OK$/i.test(rabbit.label) && /^Ready$/i.test(rabbit.status);

  return containersReady && listenersReady && databaseReady && flsReady && rabbitReady;
}

function attentionHomeHealthCards() {
  const item = { label: "Needs Review", status: "WARN", detail: "" };
  return {
    containers: item,
    listeners: item,
    database: item,
    games: item,
    rabbit: item,
    fls: item
  };
}

function transitionHomeHealthCard(item: { label: string; status: string; detail: string }, runningAction: "start" | "stop" | "restart" | "") {
  if (runningAction !== "start" && runningAction !== "restart") return null;
  if (/^OK$/i.test(item.label) && /^Ready$/i.test(item.status)) return item;
  if (/^Warming$/i.test(item.label)) return item;
  return { label: "Getting Ready", status: "Starting", detail: "" };
}

function preferKnownHomeHealth(primary: { label: string; status: string; detail: string }, fallback: { label: string; status: string; detail: string }) {
  return /^Unknown$/i.test(primary.label) && !/^Unknown$/i.test(fallback.label) ? fallback : primary;
}

function getHomeServerState(status: string, readiness: string) {
  const text = `${status}\n${readiness}`;
  const overall = findLineValue(status, ["overall"]);
  const containerLines = sectionLines(status, "Containers").filter((line) => !/^SERVICE\s+STATUS/i.test(line));
  const allContainersMissing = containerLines.length >= 4 && containerLines.every((line) => /\b(missing|stopped|exited|dead)\b/i.test(line));
  const coreRuntimeContainerUp = containerLines.some((line) =>
    /^(dune-postgres|dune-rmq-admin|dune-rmq-game|dune-text-router|dune-server-survival-1|dune-server-overmap)\s+.*\bUp\b/i.test(line)
  );
  const gameServersStopped = /Survival_1\s+NOT RUNNING/i.test(text) && /Overmap\s+NOT RUNNING/i.test(text);
  const publishOnlyPartialState = !coreRuntimeContainerUp && gameServersStopped && containerLines.some((line) =>
    /^(dune-director|dune-server-gateway)\s+/i.test(line)
  );
  const bootStarting = isHomeBootStarting(status, readiness);
  const runningSignals = [
    !allContainersMissing && /^READY:/m.test(readiness),
    !allContainersMissing && /Overall:\s*(READY|WARMING)/i.test(status),
    !allContainersMissing && /\b(READY|WARMING)\b/i.test(overall),
    coreRuntimeContainerUp && /\bUp\s+\d+|\blistening\b|\bcontainer\s+\S+/i.test(text) && !/\b(stopped|exited|missing)\b/i.test(text)
  ];
  const stoppedSignals = [
    /\b(server|stack)\s+(is\s+)?(stopped|not running|offline)\b/i.test(text),
    /Overall:\s*(STOPPED|OFFLINE|NOT RUNNING)/i.test(status),
    /\bNo\s+(running\s+)?containers\b/i.test(text),
    /\b(all|dune)\s+containers\s+(are\s+)?(stopped|down)\b/i.test(text),
    allContainersMissing,
    publishOnlyPartialState
  ];
  const stopped = !bootStarting && stoppedSignals.some(Boolean);
  const running = !stopped && runningSignals.some(Boolean);
  const starting = bootStarting || (!stopped && !running && coreRuntimeContainerUp && (/\bUp\s+\d+/i.test(text) || /\b(WARMING|WAIT|STARTING)\b/i.test(text)));
  return { running, stopped, starting };
}

function isHomeBootStarting(status: string, readiness: string) {
  const text = `${status}\n${readiness}`;
  if (!text.trim()) return false;
  if (/\b(server|stack)\s+(is\s+)?(stopped|offline)\b/i.test(text) || /\bNo\s+(running\s+)?containers\b/i.test(text)) return false;
  if (/Overall:\s*(READY|STOPPED|OFFLINE)/i.test(status) || /^READY:/m.test(readiness)) return false;
  const containerLines = sectionLines(status, "Containers").filter((line) => !/^SERVICE\s+STATUS/i.test(line));
  const anyContainerUp = containerLines.some((line) => /\bUp\b/i.test(line));
  const coreStartupContainerUp = containerLines.some((line) =>
    /^(dune-postgres|dune-rmq-admin|dune-rmq-game|dune-text-router|dune-server-survival-1|dune-server-overmap)\s+.*\bUp\b/i.test(line)
  );
  const missingContainers = containerLines.filter((line) => /\b(missing|stopped|exited|dead|not running)\b/i.test(line)).length;
  if (containerLines.length >= 8 && missingContainers >= 8 && !anyContainerUp) return false;
  const listenerLines = sectionLines(status, "Listeners").filter((line) => !/^CHECK\s+PORT\s+STATUS/i.test(line));
  const missingListeners = listenerLines.filter((line) => /\bMISSING\b/i.test(line)).length;
  const gameServersStopped = /Survival_1\s+NOT RUNNING/i.test(text) && /Overmap\s+NOT RUNNING/i.test(text);
  if (gameServersStopped && listenerLines.length > 0 && missingListeners === listenerLines.length && !anyContainerUp) return false;
  if (gameServersStopped && anyContainerUp && !coreStartupContainerUp) return false;
  const gameServerText = sectionLines(status, "Game servers").join("\n");
  if (/Overall:\s*(WARMING|STARTING)/i.test(status) || /\b(WARMING|STARTING)\b/i.test(gameServerText)) return true;
  const readinessStarting = coreStartupContainerUp &&
    /^\s*(WARN|FAIL)\s+container\s+dune-/im.test(readiness) &&
    !/^\s*OK\s+container\s+dune-server-(survival-1|overmap)\b/im.test(readiness);
  return coreStartupContainerUp || readinessStarting || (coreStartupContainerUp && containerLines.length > 0 && missingContainers > 0) || (coreStartupContainerUp && listenerLines.length > 0 && missingListeners > 0);
}

function homeOverallBadge(value: string) {
  const normalized = String(value || "").trim().toLowerCase();
  if (/\b(restarting|restart|stopping|starting)\b/.test(normalized)) return "WARN";
  if (/^stopped$/i.test(value)) return "WARN";
  if (/^issue(?: detected)?$/i.test(value)) return "WARN";
  if (/warming/i.test(value)) return "Info";
  if (/stopped|not running|offline/i.test(value)) return "WARN";
  return inferStatus(value);
}

function friendlyHomeOverall(value: string) {
  if (/^ready$/i.test(value)) return "OK";
  if (/^warming$/i.test(value)) return "Warming";
  if (/^issue$/i.test(value)) return "Stopped";
  return value;
}

export function taskTechnicalDetails(task: Task) {
  return task.logLines.map((line) => line.line).filter(Boolean).join("\n") || task.errorMessage || "";
}

function isMapRuntimeHandoffTask(task: Task) {
  const text = [
    task.progressMessage,
    ...((task.logLines || []).slice(-20).map((line) => line.line))
  ].filter(Boolean).join("\n");
  return /\bBound partition\b.+\bto warming server_id\b/i.test(text) ||
    /\bwarming\b/i.test(text) ||
    /\bRestarting\b.+\b(Survival_1|sietch|map|server)\b/i.test(text) ||
    /\bStarting\b.+\b(Survival_1|sietch|map|server)\b/i.test(text) ||
    /\bSpawned\b.+\bdune-server-/i.test(text) ||
    /\bActive dimensions for\b.+\bset to\b/i.test(text);
}

export function isSettingsRestartHandoffTask(task: Task) {
  const text = [
    task.currentStep,
    task.progressMessage,
    ...((task.logLines || []).slice(-20).map((line) => line.line))
  ].filter(Boolean).join("\n");
  return /^(stop|start|restartService|mapsDespawn|mapsSpawn)$/i.test(String(task.currentStep || "")) ||
    /\bRunning (stop|start|restartService|mapsDespawn|mapsSpawn)\b/i.test(text) ||
    /\bStopping\b.+\bDune\b/i.test(text) ||
    /\bStarting\b.+\b(game|server|stack|services|Dune)\b/i.test(text);
}

function friendlyHomeStatusError(error: string) {
  if (/docker|daemon|socket/i.test(error)) return "Docker status is unavailable. Check that Docker is running and the web admin has access.";
  if (/dune\s+ready|readiness/i.test(error)) return "Readiness is unavailable right now. The server may be starting, stopping, or stopped.";
  if (/exit\s+\d+/i.test(error)) return "Server status is unavailable. Refresh again or check Services and Logs if it persists.";
  return conciseTaskMessage(error) || "Server status is unavailable.";
}

function conciseTaskMessage(text: string) {
  const line = stripAnsi(text).split(/\r?\n/).map((part) => part.trim()).filter(Boolean).find((part) => !/^dune\s+\w+ failed with exit \d+$/i.test(part));
  if (!line) return "";
  return line.replace(/^dune\s+\w+\s+failed\s+with\s+exit\s+\d+[:\s-]*/i, "").slice(0, 220);
}

function summarizeContainers(text: string) {
  const lines = sectionLines(text, "Containers").filter((line) => !/^SERVICE\s+STATUS/i.test(line));
  if (!lines.length) return { label: "Unknown", status: "Unknown", detail: "" };
  const bad = lines.find((line) => /\b(missing|stopped|exited|dead)\b/i.test(line));
  return bad ? { label: "Needs Review", status: "WARN", detail: "" } : { label: "OK", status: "Ready", detail: "" };
}

function summarizeListeners(text: string) {
  const lines = sectionLines(text, "Listeners").filter((line) => !/^CHECK\s+PORT\s+STATUS/i.test(line));
  if (!lines.length) return { label: "Unknown", status: "Unknown", detail: "" };
  const bad = lines.find((line) => /\b(MISSING|FAIL|ERROR)\b/i.test(line));
  return bad ? { label: "Needs Review", status: "WARN", detail: "" } : { label: "OK", status: "Ready", detail: "" };
}

function summarizeDatabase(text: string) {
  const value = findLineValue(sectionLines(text, "Database").join("\n"), ["World partitions"]);
  if (!value) return { label: "Unknown", status: "Unknown", detail: "" };
  const count = Number(value);
  if (Number.isFinite(count) && count > 0) return { label: "OK", status: "Ready", detail: "" };
  return { label: "Needs Review", status: "WARN", detail: "" };
}

function summarizeGameServers(text: string) {
  const lines = sectionLines(text, "Game servers").filter((line) => !/^MAP\s+STATE\s+UPTIME/i.test(line) && !/^Note:/i.test(line));
  if (!lines.length) return { label: "Unknown", status: "Unknown", detail: "" };
  const bad = lines.find((line) => /\b(ERROR|NOT RUNNING|MISSING)\b/i.test(line));
  const wait = lines.find((line) => /\b(WARMING|WAIT)\b/i.test(line));
  if (bad) return { label: "Needs Review", status: "WARN", detail: "" };
  if (wait) return { label: "Warming", status: "Info", detail: "" };
  return { label: "OK", status: "Ready", detail: "" };
}

function summarizeRabbit(text: string) {
  const lines = sectionLines(text, "RabbitMQ game connections");
  if (!lines.length) return { label: "Unknown", status: "Unknown", detail: "" };
  if (lines.some((line) => /not running|missing|failed/i.test(line))) return { label: "Needs Review", status: "WARN", detail: "" };
  const director = numberAfterLabel(lines, "Director connections");
  const game = numberAfterLabel(lines, "Game server connections");
  if ((director !== null && director < 1) || (game !== null && game < 1)) {
    return { label: "Needs Review", status: "WARN", detail: "" };
  }
  return { label: "OK", status: "Ready", detail: "" };
}

function summarizeFls(text: string) {
  const lines = sectionLines(text, "Funcom/FLS summary");
  if (!lines.length) return { label: "Unknown", status: "Unknown", detail: "" };
  const bad = lines.find((line) => /:\s*(WAIT|FAIL|ERROR|MISSING)/i.test(line));
  if (bad) return { label: "Needs Review", status: "WARN", detail: "" };
  return { label: "OK", status: "Ready", detail: "" };
}

function summarizeReadinessContainers(text: string) {
  const lines = readinessRows(text, /container\s+dune-/i);
  if (!lines.length) return { label: "Unknown", status: "Unknown", detail: "" };
  return lines.every((line) => /^OK\s+/i.test(line))
    ? { label: "OK", status: "Ready", detail: "" }
    : { label: "Needs Review", status: "WARN", detail: "" };
}

function summarizeReadinessListeners(text: string) {
  const lines = readinessRows(text, /\b(TCP|UDP)\s+\d+/i);
  if (!lines.length) return { label: "Unknown", status: "Unknown", detail: "" };
  return lines.every((line) => /^OK\s+/i.test(line))
    ? { label: "OK", status: "Ready", detail: "" }
    : { label: "Needs Review", status: "WARN", detail: "" };
}

function summarizeReadinessDatabase(text: string) {
  const lines = readinessRows(text, /world_partition rows:/i);
  if (!lines.length) return { label: "Unknown", status: "Unknown", detail: "" };
  return lines.every((line) => /^OK\s+/i.test(line))
    ? { label: "OK", status: "Ready", detail: "" }
    : { label: "Needs Review", status: "WARN", detail: "" };
}

function summarizeReadinessGameServers(text: string) {
  const lines = readinessRows(text, /\b(Survival_1|Overmap)\s+ready\b/i);
  if (!lines.length) return { label: "Unknown", status: "Unknown", detail: "" };
  return lines.every((line) => /^OK\s+/i.test(line))
    ? { label: "OK", status: "Ready", detail: "" }
    : { label: "Needs Review", status: "WARN", detail: "" };
}

function summarizeReadinessRabbit(text: string) {
  const lines = readinessRows(text, /game server sg\.\* RMQ connections/i);
  if (!lines.length) return { label: "Unknown", status: "Unknown", detail: "" };
  return lines.every((line) => /^OK\s+/i.test(line))
    ? { label: "OK", status: "Ready", detail: "" }
    : { label: "Needs Review", status: "WARN", detail: "" };
}

function summarizeReadinessFls(text: string) {
  const lines = readinessRows(text, /\b(Director FLS|Gateway monitoring DB)\b/i);
  if (!lines.length) return { label: "Unknown", status: "Unknown", detail: "" };
  return lines.every((line) => /^OK\s+/i.test(line))
    ? { label: "OK", status: "Ready", detail: "" }
    : { label: "Needs Review", status: "WARN", detail: "" };
}

function readinessRows(text: string, pattern: RegExp) {
  return stripAnsi(text).split(/\r?\n/).map((line) => line.trim()).filter((line) => /^(OK|WARN|FAIL)\s+/i.test(line) && pattern.test(line));
}

function numberAfterLabel(lines: string[], label: string) {
  const line = lines.find((candidate) => candidate.toLowerCase().startsWith(label.toLowerCase()));
  if (!line) return null;
  const match = line.match(/(-?\d+)/);
  return match ? Number(match[1]) : null;
}

function findPopulation(text: string) {
  for (const rawLine of stripAnsi(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/population|players/i.test(line)) continue;
    const match = line.match(/\b(\d+|\?|unknown)\s*\/\s*(\d+|\?|unknown)\b/i);
    if (match) return normalizePopulationPair(match[1], match[2]);
  }
  return "";
}

function normalizePopulationPair(current: string, max: string) {
  const normalizedCurrent = /^unknown$/i.test(current) ? "?" : current;
  const normalizedMax = /^unknown$/i.test(max) ? "?" : max;
  if (normalizedCurrent === "?" && normalizedMax === "?") return "";
  return `${normalizedCurrent}/${normalizedMax}`;
}

function formatHomePopulation(value: string) {
  const normalized = value.match(/\b(\d+|\?|unknown)\s*\/\s*(\d+|\?|unknown)\b/i);
  if (normalized) return normalizePopulationPair(normalized[1], normalized[2]) || "Unavailable";
  return value && !/^unknown$/i.test(value) ? value : "Unavailable";
}

function findLineValue(text: string, keys: string[]) {
  const normalizedKeys = new Set(keys.map((key) => String(key).trim().toLowerCase()));
  for (const rawLine of stripAnsi(text).split(/\r?\n/)) {
    const line = stripAnsi(rawLine).trim();
    const match = line.match(/^\s*([^:=]+)\s*[:=]\s*(.+)$/);
    if (!match) continue;
    if (normalizedKeys.has(match[1].trim().toLowerCase())) return match[2].trim();
  }
  return "";
}

function normalizeServerMode(value: unknown): ServerMode | "" {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "public" || raw === "local") return raw;
  return "";
}

function sectionLines(text: string, section: string) {
  const lines = stripAnsi(text).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `=== ${section.toLowerCase()} ===`);
  if (start < 0) return [];
  const result: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^=== .+ ===$/.test(line.trim())) break;
    if (line.trim()) result.push(line.trim());
  }
  return result;
}

function inferStatus(text: string) {
  if (!text) return "Unknown";
  if (/failed|failure|error|fatal|unhealthy|down|missing|cannot|could not/i.test(text)) return "Failed";
  if (/warning|warn|not ready|starting|waiting|partial|unavailable|attention/i.test(text)) return "Attention Needed";
  if (/ready|ok|healthy|running|listening|up|succeeded|success|checked|found/i.test(text)) return "Ready";
  return "Unknown";
}
