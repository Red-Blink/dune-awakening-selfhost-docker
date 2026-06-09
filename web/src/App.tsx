import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Archive, ChevronDown, ChevronUp, Database, FileText, Gift, Home, Map as MapIcon, PackagePlus, Play, RefreshCw, Server, Settings, Shield, Sparkles, Users, X } from "lucide-react";
import { api, post, setCsrfToken } from "./api/client";
import { serverApi } from "./api/server";
import type { PerformanceSnapshot } from "./api/server";
import { playersApi } from "./api/players";
import { logsApi } from "./api/logs";
import { backupsApi } from "./api/backups";
import { databaseApi } from "./api/database";
import { mapsApi, type LiveMapMemoryRow, type UserSettingField, type UserSettingsSchema } from "./api/maps";
import { updatesApi } from "./api/updates";
import { worldDataApi } from "./api/worldData";
import { adminApi } from "./api/admin";
import { starterKitApi, type StarterKitConfig, type StarterKitEntry } from "./api/carePackage";
import type { StarterKitAutoGrantRule } from "./api/carePackage";
import { setupApi, type Task } from "./api/setup";
import { liveMapApi, type LiveMapConfig, type LiveMapMarker, type LiveMapPartition } from "./api/liveMap";
import { SetupWizard } from "./components/SetupWizard";
import { TaskProgress } from "./components/TaskProgress";
import { LogViewer } from "./components/LogViewer";
import { PortChecklist } from "./components/PortChecklist";
import { ReadinessTimeline } from "./components/ReadinessTimeline";
import { SecretInput } from "./components/SecretInput";

type Tab = "Home" | "Setup" | "Server Control" | "Services" | "Players" | "Admin Tools" | "Live Map" | "Maps" | "Care Package" | "Addons" | "Database" | "Storage" | "Backups" | "Logs" | "Updates" | "Settings";
type HomeLoadResult = { statusLoaded: boolean; readinessLoaded: boolean; statusError: string; readinessError: string; statusText: string; readinessText: string };
type CatalogItem = { name: string; id: string; itemId?: string; category?: string; source?: string; image?: string };
type BackupResult = { status: "running" | "succeeded" | "failed"; title: string; message?: string; details?: string; tone?: "danger" | "attention" };
type HomeTaskResult = { status: "running" | "succeeded" | "failed" | "stopped"; title: string; message?: string; details?: string };
type DatabasePasswordState = { taskId?: string; result: HomeTaskResult | null };

const nav: { tab: Tab; icon: React.ReactNode }[] = [
  { tab: "Home", icon: <Home size={18} /> },
  { tab: "Setup", icon: <Shield size={18} /> },
  { tab: "Server Control", icon: <Server size={18} /> },
  { tab: "Players", icon: <Users size={18} /> },
  { tab: "Admin Tools", icon: <PackagePlus size={18} /> },
  { tab: "Live Map", icon: <MapIcon size={18} /> },
  { tab: "Maps", icon: <MapIcon size={18} /> },
  { tab: "Care Package", icon: <Gift size={18} /> },
  { tab: "Addons", icon: <Sparkles size={18} /> },
  { tab: "Database", icon: <Database size={18} /> },
  { tab: "Backups", icon: <Archive size={18} /> },
  { tab: "Logs", icon: <FileText size={18} /> },
  { tab: "Updates", icon: <RefreshCw size={18} /> },
  { tab: "Settings", icon: <Settings size={18} /> }
];

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
const DATABASE_PASSWORD_STATE_KEY = "arrakis.databasePasswordState";

const SERVICE_LABELS: Record<string, string> = {
  postgres: "Postgres",
  "rmq-admin": "RabbitMQ Admin",
  "rmq-game": "RabbitMQ Game",
  "text-router": "Text Router",
  director: "Dune Director",
  gateway: "Gateway",
  survival: "Survival",
  "survival-1": "Survival 1",
  overmap: "Overmap",
  orchestrator: "Orchestrator",
  autoscaler: "Autoscaler",
  "dune-postgres": "Postgres",
  "dune-rmq-admin": "RabbitMQ Admin",
  "dune-rmq-game": "RabbitMQ Game",
  "dune-text-router": "Text Router",
  "dune-director": "Dune Director",
  "dune-server-gateway": "Gateway",
  "dune-server-survival-1": "Survival 1",
  "dune-server-overmap": "Overmap",
  "dune-orchestrator": "Orchestrator",
  "dune-autoscaler": "Autoscaler"
};

export function App() {
  const [auth, setAuth] = useState(false);
  const [password, setPassword] = useState("");
  const [tab, setTab] = useState<Tab>("Home");
  const [status, setStatus] = useState("");
  const [readiness, setReadiness] = useState("");
  const [ports, setPorts] = useState("");
  const [doctor, setDoctor] = useState("");
  const [services, setServices] = useState("");
  const [selectedLogService, setSelectedLogService] = useState("gateway");
  const [logs, setLogs] = useState("");
  const [task, setTask] = useState<Task | null>(null);
  const [backupRestoreTask, setBackupRestoreTask] = useState<Task | null>(null);
  const [homeTaskResult, setHomeTaskResult] = useState<HomeTaskResult | null>(null);
  const [funcomTokenResult, setFuncomTokenResult] = useState<HomeTaskResult | null>(() => loadPersistedFuncomTokenResult());
  const [homeRunningAction, setHomeRunningAction] = useState<"start" | "stop" | "restart" | "">("");
  const stackActionStartedAt = useRef(0);
  const stackStatusLoadRef = useRef<Promise<HomeLoadResult> | null>(null);
  const [setupJump, setSetupJump] = useState({ step: 0, nonce: 0 });
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ authenticated: boolean; csrfToken: string | null }>("/api/auth/state").then((state) => {
      setAuth(state.authenticated);
      setCsrfToken(state.csrfToken);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    persistFuncomTokenResult(funcomTokenResult);
  }, [funcomTokenResult]);

  async function login() {
    const result = await post<{ authenticated: boolean; csrfToken: string }>("/api/auth/login", { password });
    setCsrfToken(result.csrfToken);
    setAuth(result.authenticated);
  }

  async function safe(action: () => Promise<void>) {
    setError("");
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }

  const loadStackStatus = useCallback(async () => {
    if (stackStatusLoadRef.current) return stackStatusLoadRef.current;
    stackStatusLoadRef.current = (async () => {
      setError("");
      const [nextStatus, nextReadiness] = await Promise.allSettled([
        withTimeout(serverApi.status(), 90000, "Server status check timed out."),
        withTimeout(serverApi.readiness(), 90000, "Readiness check timed out.")
      ]);
      const result: HomeLoadResult = { statusLoaded: false, readinessLoaded: false, statusError: "", readinessError: "", statusText: "", readinessText: "" };
      if (nextStatus.status === "fulfilled") {
        setStatus(nextStatus.value.stdout);
        result.statusText = nextStatus.value.stdout;
        result.statusLoaded = true;
      } else {
        result.statusError = nextStatus.reason instanceof Error ? nextStatus.reason.message : String(nextStatus.reason);
      }
      if (nextReadiness.status === "fulfilled") {
        const readinessText = nextReadiness.value.stdout || nextReadiness.value.stderr || "";
        result.readinessText = readinessText;
        setReadiness(readinessText);
        result.readinessLoaded = Number(nextReadiness.value.exitCode || 0) === 0;
        if (!result.readinessLoaded) result.readinessError = nextReadiness.value.stderr || nextReadiness.value.stdout || "Readiness checks are not ready yet.";
      } else {
        result.readinessError = nextReadiness.reason instanceof Error ? nextReadiness.reason.message : String(nextReadiness.reason);
      }
      return result;
    })().finally(() => {
      stackStatusLoadRef.current = null;
    });
    return stackStatusLoadRef.current;
  }, []);

  useEffect(() => {
    if (!homeRunningAction) return;
    stackActionStartedAt.current = Date.now();
    let active = true;
    async function refreshRunningAction() {
      const result = await loadStackStatus().catch(() => null);
      if (!active || !result) return;
      const statusText = result.statusText;
      const readinessText = result.readinessText;
      const elapsedMs = Date.now() - stackActionStartedAt.current;
      if (homeRunningAction === "stop" && isHomeStopComplete(statusText, readinessText)) {
        setHomeTaskResult({ status: "stopped", title: "Server Stopped" });
        setHomeRunningAction("");
      } else if ((homeRunningAction === "start" || homeRunningAction === "restart") && elapsedMs >= 8000 && isHomeActionComplete(statusText, readinessText)) {
        setHomeTaskResult({ status: "succeeded", title: homeRunningAction === "start" ? "Server Started Successfully" : "Server Restarted Successfully" });
        setHomeRunningAction("");
      }
    }
    const id = window.setInterval(refreshRunningAction, 3000);
    refreshRunningAction();
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [homeRunningAction, loadStackStatus]);

  if (!auth) {
    return (
      <main className="login-screen">
        <section className="login-panel">
          <h1>Arrakis Server Console</h1>
          <p>Sign in with the local admin password from <code>runtime/secrets/admin-web-password.txt</code>.</p>
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Admin password" />
          <button onClick={() => safe(login)}>Sign In</button>
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>Arrakis Server Console</h1>
        <nav>{nav.map((item) => <button key={item.tab} className={tab === item.tab ? "active" : ""} onClick={() => {
          if (item.tab === "Setup") setSetupJump((current) => ({ step: 0, nonce: current.nonce + 1 }));
          setTab(item.tab);
        }}>{item.icon}{item.tab}</button>)}</nav>
      </aside>
      <main className={tab === "Home" ? "home-main" : undefined}>
        {tab === "Home" && (
          <div className="home-backdrop" aria-hidden="true">
            <span className="home-sand-fine" />
            <span className="home-sand-near" />
          </div>
        )}
        <header className="topbar">
          <div>
            <strong>{tab}</strong>
            <span>Docker-native control for RedBlink Dune self-hosting</span>
          </div>
        </header>
        {error && <div className="error-banner">{error}</div>}
        {tab === "Home" && <HomePanel status={status} readiness={readiness} taskResult={homeTaskResult} setTaskResult={setHomeTaskResult} funcomTokenResult={funcomTokenResult} setFuncomTokenResult={setFuncomTokenResult} runningAction={homeRunningAction} setRunningAction={setHomeRunningAction} onLoad={loadStackStatus} />}
        {tab === "Setup" && <SetupWizard initialStep={setupJump.step} jumpNonce={setupJump.nonce} />}
        {tab === "Server Control" && <ServerPanel setTask={setTask} setStatus={setStatus} status={status} setReadiness={setReadiness} setPorts={setPorts} setDoctor={setDoctor} ports={ports} readiness={readiness} doctor={doctor} taskResult={homeTaskResult} setTaskResult={setHomeTaskResult} funcomTokenResult={funcomTokenResult} setFuncomTokenResult={setFuncomTokenResult} runningAction={homeRunningAction} setRunningAction={setHomeRunningAction} onError={setError} onRedeploy={() => {
          setSetupJump((current) => ({ step: 4, nonce: current.nonce + 1 }));
          setTab("Setup");
        }} />}
        {tab === "Services" && <ServicesPanel services={services} setServices={setServices} setTask={setTask} openLogs={(service) => { setSelectedLogService(service); setTab("Logs"); }} onError={setError} />}
        {tab === "Players" && <PlayersPanel setTask={setTask} onError={setError} />}
        {tab === "Admin Tools" && <AdminToolsPanel setTask={setTask} onError={setError} />}
        {tab === "Live Map" && <LiveMapPanel onError={setError} />}
        {tab === "Maps" && <MapsPanel setTask={setTask} onError={setError} />}
        {tab === "Care Package" && <StarterKitPanel onError={setError} />}
        {tab === "Addons" && <AddonsPanel />}
        {tab === "Database" && <DatabasePanel />}
        {tab === "Storage" && <StoragePanel onError={setError} />}
        {tab === "Backups" && <BackupsPanel backupRestoreTask={backupRestoreTask} setBackupRestoreTask={setBackupRestoreTask} onError={setError} />}
        {tab === "Logs" && <LogsPanel selectedService={selectedLogService} setSelectedService={setSelectedLogService} text={logs} setText={setLogs} onError={setError} />}
        {tab === "Updates" && <UpdatesPanel setTask={setTask} />}
        {tab === "Settings" && <SettingsPanel />}
        <TaskProgress task={task} onDismiss={() => setTask(null)} />
      </main>
    </div>
  );
}

function HomePanel({ status, readiness, taskResult, setTaskResult, funcomTokenResult, setFuncomTokenResult, runningAction, setRunningAction, onLoad }: {
  status: string;
  readiness: string;
  taskResult: HomeTaskResult | null;
  setTaskResult: Dispatch<SetStateAction<HomeTaskResult | null>>;
  funcomTokenResult: HomeTaskResult | null;
  setFuncomTokenResult: Dispatch<SetStateAction<HomeTaskResult | null>>;
  runningAction: "start" | "stop" | "restart" | "";
  setRunningAction: Dispatch<SetStateAction<"start" | "stop" | "restart" | "">>;
  onLoad: () => Promise<HomeLoadResult>;
}) {
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState("");
  const [readinessWarning, setReadinessWarning] = useState("");
  const [performance, setPerformance] = useState<PerformanceSnapshot | null>(null);
  const [performanceError, setPerformanceError] = useState("");
  const [hasLoaded, setHasLoaded] = useState(Boolean(status || readiness));
  const homeActionRunId = useRef(0);
  const homeActionStartedAt = useRef(0);
  const refreshRunId = useRef(0);
  const activeHomeAction = useRef<"start" | "stop" | "restart" | "">(runningAction);

  function setHomeAction(action: "start" | "stop" | "restart" | "") {
    activeHomeAction.current = action;
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
        const loadedState = getHomeServerState(result.statusText || status, result.readinessText || readiness);
        if ((runningAction === "start" || runningAction === "restart") && isHomeActionComplete(result.statusText || status, result.readinessText || readiness)) {
          setTaskResult({ status: "succeeded", title: runningAction === "start" ? "Server Started Successfully" : "Server Restarted Successfully" });
          setHomeAction("");
        } else if (runningAction === "stop" && loadedState.stopped) {
          setTaskResult({ status: "stopped", title: "Server Stopped" });
          setHomeAction("");
        }
        if (taskResult?.status === "failed" && isHomeActionComplete(result.statusText || status, result.readinessText || readiness)) {
          setTaskResult({ status: "succeeded", title: /restart/i.test(taskResult.title) ? "Server Restarted Successfully" : "Server Started Successfully" });
        } else if (taskResult?.status === "failed" && loadedState.running) {
          setTaskResult({ status: "succeeded", title: /restart/i.test(taskResult.title) ? "Server Restarted Successfully" : "Server Started Successfully" });
        } else if (taskResult?.status === "failed" && loadedState.stopped && /stop/i.test(taskResult.title)) {
          setTaskResult({ status: "stopped", title: "Server Stopped" });
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
    if (action === "stop" && !window.confirm("Stop the Dune server stack?")) return;
    if (action === "restart" && !window.confirm("Restart the Dune server stack?")) return;
    const actionRunId = ++homeActionRunId.current;
    homeActionStartedAt.current = Date.now();
    let commandAction = action;
    const copy = {
      start: { running: "Starting", success: "Server Started Successfully", failure: "Start Failed" },
      stop: { running: "Stopping", success: "Server Stopped", failure: "Server stop failed." },
      restart: { running: "Restarting", success: "Server Restarted Successfully", failure: "Restart Failed" }
    }[action];
    setLocalError("");
    setHomeAction(action);
    setTaskResult({ status: "running", title: copy.running });
    if (action === "restart") {
      const preLoad = await onLoad().catch(() => null);
      if (homeActionRunId.current !== actionRunId) return;
      if (preLoad) {
        applyHomeLoadResult(preLoad);
        const preState = getHomeServerState(preLoad.statusText || status, preLoad.readinessText || readiness);
        if (preState.stopped) commandAction = "start";
      }
    }
    let keepPolling = false;
    try {
      const response = commandAction === "start" ? await serverApi.start() : commandAction === "stop" ? await serverApi.stop() : await serverApi.restart();
      const final = await waitForTaskSilently(response.task);
      if (homeActionRunId.current !== actionRunId) return;
      const details = taskTechnicalDetails(final);
      const postLoad = await onLoad().catch(() => null);
      if (homeActionRunId.current !== actionRunId) return;
      if (postLoad) applyHomeLoadResult(postLoad);
      const postState = getHomeServerState(postLoad?.statusText || status, postLoad?.readinessText || readiness);
      const postReady = isHomeActionComplete(postLoad?.statusText || status, postLoad?.readinessText || readiness);
      const elapsedMs = Date.now() - homeActionStartedAt.current;
      if (action === "stop" && isHomeStopComplete(postLoad?.statusText || status, postLoad?.readinessText || readiness)) {
        setTaskResult({ status: "stopped", title: copy.success, details });
      } else if ((action === "start" || action === "restart") && elapsedMs >= 8000 && postReady) {
        setTaskResult({ status: "succeeded", title: copy.success, details });
      } else if (final.status !== "succeeded") {
        if ((action === "start" || action === "restart") && (postState.starting || postState.running)) {
          keepPolling = true;
          setTaskResult({ status: "running", title: copy.running, details });
        } else {
          setTaskResult({ status: "failed", title: copy.failure, details });
        }
      } else if (action === "stop") {
        keepPolling = true;
        setTaskResult({ status: "running", title: copy.running, details });
      } else if (action === "restart" && final.status === "succeeded") {
        keepPolling = true;
        setTaskResult({ status: "running", title: copy.running, details });
      } else if ((action === "start" || action === "restart") && (final.status === "succeeded" || postState.starting || postState.running)) {
        keepPolling = true;
        setTaskResult({ status: "running", title: copy.running });
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
      const elapsedMs = Date.now() - homeActionStartedAt.current;
      if (currentAction === "stop" && isHomeStopComplete(result.statusText || status, result.readinessText || readiness)) {
        setTaskResult({ status: "stopped", title: "Server Stopped" });
        setHomeAction("");
      } else if ((currentAction === "start" || currentAction === "restart") && elapsedMs >= 8000 && isHomeActionComplete(result.statusText || status, result.readinessText || readiness)) {
        setTaskResult({ status: "succeeded", title: currentAction === "start" ? "Server Started Successfully" : "Server Restarted Successfully" });
        setHomeAction("");
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
    if (runningAction !== "start" && runningAction !== "restart") return;
    if (!isHomeActionComplete(status, readiness)) return;
    const minimumTransitionMs = runningAction === "restart" ? 8000 : 0;
    const elapsedMs = Date.now() - homeActionStartedAt.current;
    if (elapsedMs < minimumTransitionMs) return;
    setTaskResult({ status: "succeeded", title: runningAction === "start" ? "Server Started Successfully" : "Server Restarted Successfully" });
    setHomeAction("");
  }, [runningAction, status, readiness, setRunningAction, setTaskResult]);

  useEffect(() => {
    if (!taskResult || taskResult.status === "running" || taskResult.status === "failed") return;
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
          <h2>Checking Server Status...</h2>
          <p>Checking Readiness...</p>
          <p>This can take a few seconds while Docker and Dune health checks run.</p>
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
          <button disabled={refreshDisabled} onClick={() => refresh()}>{loading ? "Refreshing..." : "Refresh Status"}</button>
          <button disabled={startDisabled} title={controlsState.running ? "Server is already running." : ""} onClick={() => runServerAction("start")}><Play size={16} /> Start</button>
          <button disabled={stopDisabled} onClick={() => runServerAction("stop")}>Stop</button>
          <button disabled={restartDisabled} onClick={() => runServerAction("restart")}>Restart</button>
        </div>
        {taskResult && <HomeTaskResultCard result={taskResult} />}
        {localError && <p className="error">{localError}</p>}
      </article>
      <PerformanceCards performance={performance} error={performanceError} />
      <HomeHealthCards status={status} readiness={readiness} readinessWarning={readinessWarning} loading={loading} runningAction={runningAction} taskResult={taskResult} funcomTokenResult={funcomTokenResult} />
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
  return <div className={`result-panel home-task-result result-${result.status === "succeeded" || result.status === "stopped" ? "ok" : result.status === "failed" ? "fail" : "running"}`} aria-live="polite">
    <strong className={result.status === "running" ? "loading-dots" : ""}>{result.title}</strong>
    {result.message && <p>{result.message}</p>}
    {result.details && <TechnicalDetails title="Technical details" text={result.details} />}
  </div>;
}

function ServerPanel(props: {
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
  setRunningAction: Dispatch<SetStateAction<"start" | "stop" | "restart" | "">>;
  onError: (text: string) => void;
  onRedeploy: () => void;
}) {
  const [service, setService] = useState(RESTARTABLE_SERVICES[0].value);
  const [restartSchedule, setRestartSchedule] = useState<{ stdout?: string; stderr?: string; exitCode?: number } | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [restartEnabled, setRestartEnabled] = useState(false);
  const [restartTime, setRestartTime] = useState("05:00");
  const [scheduleResult, setScheduleResult] = useState<HomeTaskResult | null>(null);
  const [serverTitle, setServerTitle] = useState("");
  const [titleResult, setTitleResult] = useState<HomeTaskResult | null>(null);
  const [funcomToken, setFuncomToken] = useState("");
  const [serviceRestartResult, setServiceRestartResult] = useState<HomeTaskResult | null>(null);
  const [serviceRestartingService, setServiceRestartingService] = useState("");
  const controlActionRunId = useRef(0);
  const controlActionStartedAt = useRef(0);
  const serviceRestartRunId = useRef(0);
  const { taskResult, setTaskResult, funcomTokenResult, setFuncomTokenResult, runningAction, setRunningAction } = props;
  const activeControlAction = useRef<"start" | "stop" | "restart" | "">(runningAction);
  const actionRunning = Boolean(runningAction);
  const serviceRestartRunning = serviceRestartResult?.status === "running";
  const titleSaving = titleResult?.status === "running";
  const funcomTokenSaving = funcomTokenResult?.status === "running";
  const scheduleSaving = scheduleResult?.status === "running";
  const restartScheduleValues = parseKeyValueText(restartSchedule?.stdout || "");
  const scheduleTimerValue = restartScheduleValues.systemd_timer || "";
  const scheduleTimerLabel = scheduleTimerValue ? formatTimerStatus(scheduleTimerValue) : "Not Installed";
  const scheduleTimerInstalled = Boolean(scheduleTimerValue) && !/not installed/i.test(scheduleTimerValue);
  const scheduleTimerActive = /^active$/i.test(scheduleTimerValue);
  const scheduleActive = restartEnabled && scheduleTimerActive;
  const scheduleLoaded = Boolean(restartSchedule);
  const scheduleDisplayActive = scheduleSaving ? restartEnabled : scheduleActive;
  const scheduleStatusLabel = !scheduleLoaded && !scheduleSaving ? "Checking" : scheduleDisplayActive ? "Enabled" : "Disabled";
  const scheduleDisplayTimerLabel = !scheduleLoaded && !scheduleSaving ? "Checking" : scheduleSaving ? restartEnabled ? "Activating" : "Deactivating" : scheduleTimerLabel;
  const serverState = getHomeServerState(props.status, props.readiness);
  async function run(action: () => Promise<unknown>) {
    props.onError("");
    try { await action(); } catch (error) { props.onError(error instanceof Error ? error.message : String(error)); }
  }
  function setControlAction(action: "start" | "stop" | "restart" | "") {
    activeControlAction.current = action;
    setRunningAction(action);
  }
  async function loadControlStatus(includeDiagnostics = false): Promise<HomeLoadResult> {
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
    if (nextDoctor?.status === "fulfilled") props.setDoctor(nextDoctor.value.stdout);
    if (!result.statusLoaded && result.statusError) props.onError(friendlyHomeStatusError(result.statusError));
    return result;
  }
  async function saveServerTitle() {
    const title = serverTitle.trim();
    if (!title) {
      setTitleResult({ status: "failed", title: "Title Save Failed", message: "Server title cannot be empty." });
      return;
    }
    if (!window.confirm(`Change server title to "${title}"? This restarts Director and Gateway so the new title can be published.`)) return;
    setTitleResult({ status: "running", title: "Saving Title" });
    props.onError("");
    try {
      const final = await waitForTaskSilently((await serverApi.saveTitle(title)).task);
      const details = taskTechnicalDetails(final);
      await loadControlStatus(false).catch(() => null);
      setTitleResult(final.status === "succeeded"
        ? { status: "succeeded", title: "Title Saved Successfully", details }
        : { status: "failed", title: "Title Save Failed", details });
    } catch (error) {
      setTitleResult({ status: "failed", title: "Title Save Failed", details: error instanceof Error ? error.message : String(error) });
    }
  }
  async function saveFuncomToken() {
    const token = funcomToken.trim();
    if (!token) {
      setFuncomTokenResult({ status: "failed", title: "Token Save Failed", message: "Funcom token cannot be empty." });
      return;
    }
    if (!window.confirm("Save the new Funcom token and restart the Dune stack so services reload it?")) return;
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
  async function loadControlVisibleSections() {
    const [statusResult, portsResult] = await Promise.allSettled([loadControlStatus(false), serverApi.ports()]);
    if (portsResult.status === "fulfilled") props.setPorts(portsResult.value.stdout);
    if (statusResult.status === "rejected") throw statusResult.reason;
  }
  async function runServerAction(action: "start" | "stop" | "restart") {
    if (action === "stop" && !window.confirm("Stop the Dune server stack?")) return;
    if (action === "restart" && !window.confirm("Restart the Dune server stack?")) return;
    serviceRestartRunId.current += 1;
    setServiceRestartingService("");
    const actionRunId = ++controlActionRunId.current;
    controlActionStartedAt.current = Date.now();
    const copy = {
      start: { running: "Starting", success: "Server Started Successfully", failure: "Start Failed" },
      stop: { running: "Stopping", success: "Server Stopped", failure: "Server stop failed." },
      restart: { running: "Restarting", success: "Server Restarted Successfully", failure: "Restart Failed" }
    }[action];
    props.onError("");
    setControlAction(action);
    setTaskResult({ status: "running", title: copy.running });
    let keepPolling = false;
    try {
      const response = action === "start" ? await serverApi.start() : action === "stop" ? await serverApi.stop() : await serverApi.restart();
      const final = await waitForTaskSilently(response.task);
      if (controlActionRunId.current !== actionRunId) return;
      const details = taskTechnicalDetails(final);
      const postLoad = await loadControlStatus(false).catch(() => null);
      if (controlActionRunId.current !== actionRunId) return;
      const statusText = postLoad?.statusText || props.status;
      const readinessText = postLoad?.readinessText || props.readiness;
      const elapsedMs = Date.now() - controlActionStartedAt.current;
      if (action === "stop" && isHomeStopComplete(statusText, readinessText)) {
        setTaskResult({ status: "stopped", title: copy.success, details });
      } else if ((action === "start" || action === "restart") && elapsedMs >= 8000 && isHomeActionComplete(statusText, readinessText)) {
        setTaskResult({ status: "succeeded", title: copy.success, details });
      } else if (final.status !== "succeeded") {
        const postState = getHomeServerState(statusText, readinessText);
        if ((action === "start" || action === "restart") && (postState.starting || postState.running)) {
          keepPolling = true;
          setTaskResult({ status: "running", title: copy.running, details });
        } else {
          setTaskResult({ status: "failed", title: copy.failure, details });
        }
      } else {
        keepPolling = true;
        setTaskResult({ status: "running", title: copy.running, details });
      }
    } catch (error) {
      if (controlActionRunId.current !== actionRunId) return;
      setTaskResult({ status: "failed", title: copy.failure, details: error instanceof Error ? error.message : String(error) });
    } finally {
      if (controlActionRunId.current === actionRunId && !keepPolling) setControlAction("");
    }
  }
  async function restartSelectedService() {
    if (!window.confirm(`Restart ${friendlyServiceName(service)}?`)) return;
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
  async function saveSchedule() {
    const sanitizedTime = toHourMinuteTime(restartTime);
    if (restartEnabled && !isValidHourMinuteTime(sanitizedTime)) {
      setScheduleResult({ status: "failed", title: "Schedule Save Failed", message: "Daily restart time must be a valid 24-hour time, for example 05:00 or 23:30." });
      return;
    }
    setRestartTime(sanitizedTime);
    setScheduleResult({ status: "running", title: "Saving Schedule" });
    const requestedEnabled = restartEnabled;
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
    if (title && !titleSaving) setServerTitle(title);
  }, [props.status, titleSaving]);
  useEffect(() => {
    if (!runningAction) return;
    let active = true;
    const id = window.setInterval(async () => {
      const result = await loadControlStatus(true).catch(() => null);
      if (!active || !result) return;
      const currentAction = activeControlAction.current;
      const statusText = result.statusText || props.status;
      const readinessText = result.readinessText || props.readiness;
      const elapsedMs = Date.now() - controlActionStartedAt.current;
      if (currentAction === "stop" && isHomeStopComplete(statusText, readinessText)) {
        setTaskResult({ status: "stopped", title: "Server Stopped" });
        setControlAction("");
      } else if ((currentAction === "start" || currentAction === "restart") && elapsedMs >= 8000 && isHomeActionComplete(statusText, readinessText)) {
        setTaskResult({ status: "succeeded", title: currentAction === "start" ? "Server Started Successfully" : "Server Restarted Successfully" });
        setControlAction("");
      } else {
        setTaskResult((current) => {
          if (current?.status !== "running") return current;
          return { ...current, title: currentAction === "start" ? "Starting" : currentAction === "stop" ? "Stopping" : "Restarting" };
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
    let active = true;
    const id = window.setInterval(async () => {
      if (!active) return;
      const result = await serverApi.doctor().catch(() => null);
      if (active && result) props.setDoctor(result.stdout || result.stderr || "");
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
    if (!taskResult || taskResult.status === "running" || taskResult.status === "failed") return;
    const id = window.setTimeout(() => setTaskResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [taskResult?.status, taskResult?.title]);
  useEffect(() => {
    if (!serviceRestartResult || serviceRestartResult.status === "running" || serviceRestartResult.status === "failed") return;
    const id = window.setTimeout(() => setServiceRestartResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [serviceRestartResult?.status, serviceRestartResult?.title]);
  useEffect(() => {
    if (!titleResult || titleResult.status === "running" || titleResult.status === "failed") return;
    const id = window.setTimeout(() => setTitleResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [titleResult?.status, titleResult?.title]);
  useEffect(() => {
    if (!scheduleResult || scheduleResult.status === "running" || scheduleResult.status === "failed") return;
    const id = window.setTimeout(() => setScheduleResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [scheduleResult?.status, scheduleResult?.title]);
  return (
    <section className="panel server-control-panel">
      <h2>Server Controls</h2>
      <section className="action-section server-title-section">
        <h4>Server Title</h4>
        <div className="action-line title-action-line">
          <label>Current Server Title<input value={serverTitle} onChange={(event) => setServerTitle(event.target.value)} /></label>
          <button disabled={actionRunning || serviceRestartRunning || titleSaving} onClick={saveServerTitle}>Save Title</button>
          {titleResult && <span className={`inline-task-result result-${titleResult.status === "succeeded" ? "ok" : titleResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={titleResult.status === "running" ? "loading-dots" : ""}>{titleResult.title}</strong>
          </span>}
        </div>
      </section>
      <div className="action-row">
        <button disabled={actionRunning || serviceRestartRunning || titleSaving || funcomTokenSaving || scheduleSaving || serverState.running || serverState.starting} onClick={() => runServerAction("start")}><Play size={16} /> Start</button>
        <button disabled={titleSaving || funcomTokenSaving || scheduleSaving || serviceRestartRunning || runningAction === "stop" || (!actionRunning && serverState.stopped)} onClick={() => runServerAction("stop")}>Stop</button>
        <button disabled={actionRunning || serviceRestartRunning || titleSaving || funcomTokenSaving || scheduleSaving || serverState.stopped} onClick={() => runServerAction("restart")}>Restart</button>
        <button disabled={actionRunning || serviceRestartRunning || titleSaving || funcomTokenSaving || scheduleSaving} onClick={props.onRedeploy}>Redeploy</button>
      </div>
      {taskResult && <HomeTaskResultCard result={taskResult} />}
      <div className="action-line restart-service-line">
        <label className="compact-select">Restart Service<select value={service} onChange={(event) => setService(event.target.value)}>
          {RESTARTABLE_SERVICES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select></label>
        <button disabled={actionRunning || serviceRestartRunning || titleSaving || funcomTokenSaving || scheduleSaving} onClick={restartSelectedService}>Restart Service</button>
        {serviceRestartResult && <span className={`inline-task-result result-${serviceRestartResult.status === "succeeded" ? "ok" : serviceRestartResult.status === "failed" ? "fail" : "running"}`}>
          <strong className={serviceRestartResult.status === "running" ? "loading-dots" : ""}>{serviceRestartResult.title}</strong>
        </span>}
      </div>
      <section className="action-section">
        <div className="panel-title"><h4>Scheduled Restarts</h4><StatusPill value={scheduleStatusLabel} /></div>
        <KeyValueGrid items={[
          ["Current Status", scheduleStatusLabel],
          ["Restart Time (Local Server Time)", toHourMinuteTime(restartScheduleValues.restart_time || restartTime)],
          ["Timer", scheduleDisplayTimerLabel]
        ]} />
        {commandStatusSummary(restartSchedule).reason && <p className="danger-note">{commandStatusSummary(restartSchedule).reason}</p>}
        <div className="action-line schedule-action-line">
          <label className="checkbox-row"><input type="checkbox" disabled={scheduleLoading || scheduleSaving} checked={restartEnabled} onChange={(event) => setRestartEnabled(event.target.checked)} /> Enable</label>
          <label className="compact-select">Daily Restart Time<input type="time" step="60" pattern="[0-2][0-9]:[0-5][0-9]" disabled={scheduleSaving} value={restartTime} onChange={(event) => setRestartTime(sanitizeTimeInput(event.target.value))} placeholder="05:00" /></label>
          <button disabled={actionRunning || serviceRestartRunning || titleSaving || funcomTokenSaving || scheduleSaving || scheduleLoading} onClick={saveSchedule}>Save Schedule</button>
          {scheduleResult && <span className={`inline-task-result result-${scheduleResult.status === "succeeded" ? "ok" : scheduleResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={scheduleResult.status === "running" ? "loading-dots" : ""}>{scheduleResult.title}</strong>
          </span>}
        </div>
      </section>
      <ReadinessTimeline text={props.readiness} statusText={props.status} />
      <PortChecklist text={props.ports} statusText={props.status} />
      <section className="action-section">
        <div className="panel-title"><h4>Change Funcom Token</h4></div>
        <div className="action-line funcom-token-action-line">
          <label className="funcom-token-field"><SecretInput aria-label="Funcom token" value={funcomToken} onChange={(event) => setFuncomToken(event.target.value)} placeholder="Paste new token" /></label>
          <button disabled={actionRunning || serviceRestartRunning || titleSaving || funcomTokenSaving || scheduleSaving} onClick={saveFuncomToken}>Save Token</button>
          {funcomTokenResult && <span className={`inline-task-result result-${funcomTokenResult.status === "succeeded" ? "ok" : funcomTokenResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={funcomTokenResult.status === "running" ? "loading-dots" : ""}>{funcomTokenResult.title}</strong>
            {funcomTokenResult.message && <span className="inline-task-message">{funcomTokenResult.message}</span>}
          </span>}
        </div>
      </section>
      <DoctorSummary text={props.doctor} readiness={props.readiness} />
    </section>
  );
}

function ServicesPanel({ services, setServices, setTask, openLogs, onError }: { services: string; setServices: (text: string) => void; setTask: (task: Task) => void; openLogs: (service: string) => void; onError: (text: string) => void }) {
  const rows = parseServiceRows(services);
  async function load() {
    onError("");
    try { setServices((await serverApi.services()).stdout); } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  async function restart(service: string) {
    onError("");
    try {
      if (window.confirm(`Restart ${service}?`)) setTask((await serverApi.restartService(service)).task);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }
  useEffect(() => {
    load();
  }, []);
  return (
    <section className="panel">
      <div className="panel-title"><h2>Services</h2><button onClick={load}>Refresh Services</button></div>
      {rows.length === 0 ? <div className="empty">{services ? "No services parsed from the current Docker output." : "Services are loading or unavailable."}</div> : <div className="service-table">
        {rows.map((row) => <article className="service-card" key={row.name}>
          <div><strong>{friendlyServiceName(row.name)}</strong><span>{row.status}</span><span>{row.ports}</span></div>
          <div className="service-actions">
            {serviceActionName(row.name, "restart") && <button onClick={() => restart(serviceActionName(row.name, "restart") || row.name)}>Restart</button>}
            <button onClick={() => openLogs(serviceActionName(row.name, "logs") || row.name)}>Logs</button>
          </div>
        </article>)}
      </div>}
    </section>
  );
}

function AdminToolsPanel({ setTask, onError }: { setTask: (task: Task) => void; onError: (text: string) => void }) {
  const [playerId, setPlayerId] = useState("");
  const [players, setPlayers] = useState<Record<string, unknown>[]>([]);
  const [selectedPlayer, setSelectedPlayer] = useState("");
  const [itemName, setItemName] = useState("");
  const [itemId, setItemId] = useState("");
  const [selectedItem, setSelectedItem] = useState<CatalogItem | null>(null);
  const [grantQuantity, setGrantQuantity] = useState("1");
  const [grantDurability, setGrantDurability] = useState("1");
  const [search, setSearch] = useState("");
  const [catalogRows, setCatalogRows] = useState<Record<string, unknown>[]>([]);
  const [catalogColumns, setCatalogColumns] = useState<string[]>(["itemName", "itemId", "category", "source"]);
  const [liveToolSummary, setLiveToolSummary] = useState("");
  const [liveToolDetails, setLiveToolDetails] = useState("");
  const [xp, setXp] = useState("1000");
  const [message, setMessage] = useState("");
  const [broadcastDuration, setBroadcastDuration] = useState("30");
  const [history, setHistory] = useState("");
  async function run(action: () => Promise<unknown>) {
    onError("");
    try { await action(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  function showLiveToolResult(result: unknown) {
    setLiveToolSummary(formatLiveToolResult(result));
    setLiveToolDetails(JSON.stringify(result, null, 2));
  }
  useEffect(() => {
    playersApi.list().then((result) => setPlayers(result.rows || [])).catch(() => undefined);
  }, []);
  function selectPlayer(value: string) {
    setSelectedPlayer(value);
    const row = players.find((player) => String(player.actor_id || player.player_pawn_id || player.action_player_id) === value);
    setPlayerId(String(row?.action_player_id || row?.funcom_id || row?.fls_id || row?.account_id || ""));
  }
  function chooseAdminItem(item: CatalogItem | null) {
    setSelectedItem(item);
    setItemName(item?.name || "");
    setItemId(item?.id || "");
  }
  async function loadItemCatalog() {
    const response = await adminApi.itemCatalog(search, 10000);
    setCatalogColumns(["itemName", "itemId", "category", "source"]);
    setCatalogRows((response.rows || []).map((item) => ({ itemName: item.name, itemId: item.itemId || item.id, category: titleCase(item.category || ""), source: item.source })));
  }
  async function loadVehicleCatalog() {
    const response = await adminApi.structuredVehicles();
    setCatalogColumns(["vehicle", "actor", "templates"]);
    setCatalogRows((response.vehicles || []).map((vehicle) => ({ vehicle: vehicle.name || vehicle.id, actor: vehicle.actor || "Unknown", templates: (vehicle.templates || []).join(", ") || "None reported" })));
  }
  return (
    <section className="panel admin-tools-panel">
      <h2>Admin Tools</h2>
      <div className="action-section">
        <h4>Quick Player Actions</h4>
        <p>Select a known player to populate the Admin action ID used by live admin commands.</p>
        <div className="action-line">
          <label className="wide-field">Player<select value={selectedPlayer} onChange={(event) => selectPlayer(event.target.value)}>
            <option value="">Select player</option>
            {players.map((player) => <option key={String(player.actor_id || player.player_pawn_id || player.action_player_id)} value={String(player.actor_id || player.player_pawn_id || player.action_player_id)}>
              {String(player.character_name || "Unknown")} - {String(player.online_status || "unknown")} - admin {String(player.action_player_id || "missing")}
            </option>)}
          </select></label>
        </div>
        <details className="technical-details"><summary>Advanced manual player ID</summary><label>Player FLS/Admin ID<input value={playerId} onChange={(event) => setPlayerId(event.target.value)} /></label></details>
      </div>
      <div className="action-section">
        <h4>Grant Item</h4>
        <ItemCatalogSelector selected={selectedItem} onSelect={chooseAdminItem} />
        <div className="action-line">
          <label className="compact-field">Quantity<input type="number" min="1" value={grantQuantity} onChange={(event) => setGrantQuantity(event.target.value)} /></label>
          <label className="compact-field">Durability<input type="number" min="0" value={grantDurability} onChange={(event) => setGrantDurability(event.target.value)} /></label>
          <button disabled={!selectedItem || !playerId} onClick={() => run(async () => window.confirm(`Give ${grantQuantity} x ${itemName} to ${playerId}?`) && setTask((await playersApi.giveItem(playerId, { itemName, quantity: Number(grantQuantity), durability: Number(grantDurability) })).task))}>Grant Item</button>
        </div>
        <details className="technical-details"><summary>Developer raw item ID</summary><div className="action-line">
          <label>Raw Item ID<input value={itemId} onChange={(event) => setItemId(event.target.value)} placeholder="ItemTemplate_5" /></label>
          <button onClick={() => run(async () => window.confirm(`Give item id ${itemId} to ${playerId}?`) && setTask((await playersApi.giveItemId(playerId, { itemId, quantity: 1, durability: 1 })).task))}>Give Item by ID</button>
        </div></details>
      </div>
      <div className="action-section">
        <h4>XP / Player Tools</h4>
        <div className="action-line">
        <label className="compact-field">XP Amount<input value={xp} onChange={(event) => setXp(event.target.value)} /></label>
        <button onClick={() => run(async () => window.confirm(`Add ${xp} XP to ${playerId}?`) && setTask((await playersApi.addXp(playerId, Number(xp))).task))}>Add XP</button>
        <button onClick={() => run(async () => window.confirm(`Refill water for ${playerId}?`) && setTask((await playersApi.refillWater(playerId)).task))}>Refill Water</button>
        <button className="danger" onClick={() => run(async () => window.confirm(`Kick ${playerId} from the server?`) && setTask((await playersApi.kick(playerId)).task))}>Kick Player</button>
        </div>
      </div>
      <h3>Catalogs</h3>
      <div className="action-row">
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter item catalog, vehicles, or skill modules" />
        <button onClick={() => run(loadItemCatalog)}>Items</button>
        <button onClick={() => run(loadVehicleCatalog)}>Vehicles</button>
        <button onClick={() => run(async () => { const response = await adminApi.skillModules(search); setCatalogColumns(["skillModule", "category", "maxLevel", "id"]); setCatalogRows(parseSkillModuleRows(response.stdout || "")); })}>Skill Modules</button>
      </div>
      <div className="result-panel">
        <strong>Catalog Results</strong>
        {catalogRows.length ? <DataTable rows={catalogRows} columns={catalogColumns} /> : <div className="empty">Use catalog tools to find item names, item IDs, vehicles, and skill modules.</div>}
      </div>
      <h3>Global Live Tools</h3>
      <div className="global-live-tools">
        <p className="danger-note">Experimental: RabbitMQ publish works, but in-game display is not working/verified on the live server.</p>
        <div className="action-line">
          <button className="danger" onClick={() => run(async () => window.confirm("Kick every online player? This publishes PlayerId='*'.") && setTask((await adminApi.kickAllOnline("KICK ALL ONLINE PLAYERS")).task))}>Kick All Online Players</button>
        </div>
        <div className="action-line broadcast-line">
          <label className="broadcast-message">Broadcast Message<input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Broadcast or whisper message" /></label>
          <label className="inline-field">Duration seconds<input type="number" min="1" max="3600" value={broadcastDuration} onChange={(event) => setBroadcastDuration(event.target.value)} /></label>
          <button onClick={() => run(async () => showLiveToolResult(await adminApi.broadcast(message, Number(broadcastDuration || 30))))}>Broadcast Publish Test</button>
        </div>
        <div className="action-line live-tool-buttons">
          <button className="danger" onClick={() => run(async () => { if (window.confirm("Send shutdown broadcast publish test? In-game visibility is unverified.")) showLiveToolResult(await adminApi.shutdownBroadcast({ confirmation: "SHUTDOWN BROADCAST", delayMinutes: 15, shutdownType: "Restart" })); })}>Shutdown Broadcast Publish Test</button>
          <button onClick={() => run(async () => showLiveToolResult(await adminApi.whisper(playerId, message)))}>Whisper</button>
        </div>
      </div>
      <div className="result-panel">
        <strong>Global Live Tool Result</strong>
        <p>{liveToolSummary || "Broadcast, shutdown broadcast, and whisper results appear here. Broadcast publish success does not prove in-game display."}</p>
        {liveToolDetails && <TechnicalDetails text={liveToolDetails} />}
      </div>
      <h3>Command History</h3>
      <div className="history-controls"><button onClick={() => run(async () => setHistory((await adminApi.history()).stdout))}>Refresh Command History</button></div>
      {parseHistoryRows(history).length ? <DataTable rows={parseHistoryRows(history)} columns={["time", "action", "target", "status", "summary"]} /> : <div className="empty">No command history rows found yet.</div>}
      {history && <TechnicalDetails title="Advanced history output" text={history} />}
    </section>
  );
}

function PlayersPanel({ setTask, onError }: { setTask: (task: Task) => void; onError: (text: string) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [tab, setTab] = useState("inventory");
  async function load(online = false) {
    onError("");
    try {
      const result = online ? await playersApi.online() : await playersApi.list(q);
      setRows(result.rows || []);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }
  async function open(row: Record<string, unknown>) {
    const id = String(row.actor_id || row.player_pawn_id || row.id || "");
    setSelected(row);
    setDetail(await playersApi.profile(id));
  }
  useEffect(() => {
    load(false);
  }, []);
  const dbPlayerId = selected ? String(selected.actor_id || selected.player_pawn_id || selected.id || "") : "";
  const actionPlayerId = selected ? String(selected.action_player_id || selected.funcom_id || selected.fls_id || selected.account_id || "") : "";
  return (
    <section className="panel">
      <div className="panel-title"><h2>Players</h2><div className="action-row"><button onClick={() => load(false)}>Refresh Players</button><button onClick={() => load(true)}>Online Only</button></div></div>
      <div className="action-row"><input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search character, FLS ID, account id, or actor id" /><button onClick={() => load(false)}>Search</button></div>
      <DataTable rows={rows} columns={["actor_id", "character_name", "account_id", "action_player_id", "online_status", "map", "fls_id"]} onRowClick={open} />
      {selected && <section className="drawer">
        <div className="panel-title"><h3>{String(selected.character_name || selected.actor_id)}</h3><button onClick={() => setSelected(null)}>Close</button></div>
        <div className="two-col">
          <p><strong>DB actor/player ID:</strong> {dbPlayerId || "missing"}</p>
          <p><strong>Admin action ID:</strong> {actionPlayerId || "missing"}</p>
        </div>
        <PlayerSummary detail={detail} fallback={selected} dbPlayerId={dbPlayerId} actionPlayerId={actionPlayerId} />
        <PlayerCapabilities capabilities={(detail?.capabilities as Record<string, unknown> | undefined) || {}} />
        <div className="action-row">{["inventory", "currency", "factions", "specs", "position", "progression", "events", "stats", "history"].map((name) => <button key={name} className={tab === name ? "active" : ""} onClick={() => setTab(name)}>{friendlyTabName(name)}</button>)}</div>
        <PlayerDetailTab playerId={dbPlayerId} tab={tab} onError={onError} />
        <PlayerActions dbPlayerId={dbPlayerId} actionPlayerId={actionPlayerId} setTask={setTask} onError={onError} onRefresh={() => open(selected)} />
      </section>}
    </section>
  );
}

function PlayerActions({ dbPlayerId, actionPlayerId, setTask, onError, onRefresh }: { dbPlayerId: string; actionPlayerId: string; setTask: (task: Task) => void; onError: (text: string) => void; onRefresh: () => void }) {
  const [itemName, setItemName] = useState("");
  const [itemId, setItemId] = useState("");
  const [selectedItem, setSelectedItem] = useState<CatalogItem | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [durability, setDurability] = useState("1");
  const [multiItems, setMultiItems] = useState("");
  const [multiList, setMultiList] = useState<{ itemName?: string; itemId?: string; quantity: number; durability: number }[]>([]);
  const [xp, setXp] = useState("1000");
  const [points, setPoints] = useState("0");
  const [module, setModule] = useState("");
  const [level, setLevel] = useState("1");
  const [coords, setCoords] = useState({ x: "", y: "", z: "", yaw: "0" });
  const [vehicleId, setVehicleId] = useState("");
  const [vehicleTemplate, setVehicleTemplate] = useState("");
  const [vehicleCatalog, setVehicleCatalog] = useState<Record<string, string[]>>({});
  const [currency, setCurrency] = useState({ currencyId: "0", amount: "1" });
  const [faction, setFaction] = useState({ factionId: "1", amount: "1" });
  const [refuelVehicleId, setRefuelVehicleId] = useState("");
  const [result, setResult] = useState("");
  const [resultDetails, setResultDetails] = useState("");
  async function run(action: () => Promise<unknown>) {
    onError("");
    setResult("");
    setResultDetails("");
    try { await action(); } catch (error) { const text = error instanceof Error ? error.message : String(error); setResult(text); onError(text); }
  }
  async function runTask(action: () => Promise<{ task: Task }>) {
    const response = await action();
    const final = await waitForTask(response.task, setTask);
    if (final.status === "succeeded") onRefresh();
    else throw new Error(final.errorMessage || final.progressMessage || `Task ${final.status}`);
  }
  async function runDirect(action: () => Promise<unknown>) {
    const response = await action();
    setResult(formatMutationResult(response));
    setResultDetails(JSON.stringify(response, null, 2));
    onRefresh();
  }
  function choosePlayerItem(item: CatalogItem | null) {
    setSelectedItem(item);
    setItemName(item?.name || "");
    setItemId(item?.id || "");
  }
  function parsedMultiItems() {
    if (multiList.length) return multiList;
    return multiItems.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      const [nameOrId, qty = "1", durability = "1"] = line.split(",").map((part) => part.trim());
      const item = /^[A-Za-z0-9_./:-]{16,}$/.test(nameOrId) ? { itemId: nameOrId } : { itemName: nameOrId };
      return { ...item, quantity: Number(qty), durability: Number(durability) };
    });
  }
  async function useCurrentPosition() {
    const data = await playersApi.position(dbPlayerId);
    const position = (data.position || data) as Record<string, unknown>;
    const x = firstDefined(position.x, position.X, position.location_x, position.pos_x);
    const y = firstDefined(position.y, position.Y, position.location_y, position.pos_y);
    const z = firstDefined(position.z, position.Z, position.location_z, position.pos_z);
    const yaw = firstDefined(position.yaw, position.Yaw, position.rotation_yaw, position.rot_yaw, 0);
    if (x === undefined || y === undefined || z === undefined) throw new Error("Current position is not available from the detected player position schema.");
    setCoords({ x: String(x), y: String(y), z: String(z), yaw: String(yaw ?? 0) });
    setResult("Teleport coordinates filled from the selected player's current DB position. Yaw defaults to 0 when unavailable.");
  }
  useEffect(() => {
    adminApi.structuredVehicles().then((response) => {
      const parsed = Object.fromEntries((response.vehicles || []).map((vehicle) => [vehicle.id || vehicle.name, vehicle.templates || []]).filter(([id]) => id));
      setVehicleCatalog(parsed);
      const firstVehicle = Object.keys(parsed)[0] || "";
      if (firstVehicle && !vehicleId) {
        setVehicleId(firstVehicle);
        setVehicleTemplate(parsed[firstVehicle]?.[0] || "");
      }
    }).catch(() => {
      adminApi.vehicles("").then((response) => {
        const parsed = parseVehicleCatalog(response.stdout || "");
        setVehicleCatalog(parsed);
      }).catch(() => undefined);
    });
  }, []);
  const vehicleIds = Object.keys(vehicleCatalog);
  const selectedTemplates = vehicleCatalog[vehicleId] || [];
  const canRunCliAction = Boolean(actionPlayerId);
  const cliDisabledReason = "This player row is missing a Funcom/FLS admin action ID. CLI-backed actions are disabled to avoid sending the DB actor ID to dune admin.";
  return <section className="action-panel">
    <h3>Player Actions</h3>
    {!canRunCliAction && <p className="danger-note">{cliDisabledReason}</p>}
    {result && <div className="result-panel"><strong>Action Result</strong><p>{result}</p>{resultDetails && <TechnicalDetails text={resultDetails} />}</div>}
    <div className="action-sections">
      <section className="action-section">
        <h4>Give Items</h4>
        <p>Search the item catalog, select the exact item, then grant it to the player.</p>
        <ItemCatalogSelector selected={selectedItem} onSelect={choosePlayerItem} />
        <div className="action-line item-grant-row">
          <label className="compact-field">Quantity<input type="number" min="1" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
          <label className="compact-field">Durability<input type="number" min="0" value={durability} onChange={(event) => setDurability(event.target.value)} /></label>
          <button disabled={!canRunCliAction || !selectedItem} title={!canRunCliAction ? cliDisabledReason : !selectedItem ? "Select an item from the catalog first." : undefined} onClick={() => run(async () => { if (window.confirm(`Give ${quantity} x ${itemName} to player ${actionPlayerId}?`)) await runTask(() => playersApi.giveItem(actionPlayerId, { itemName, quantity: Number(quantity), durability: Number(durability) })); })}>Give Item</button>
        </div>
        <details className="technical-details"><summary>Developer manual item ID</summary><div className="actions-grid">
          <label>Raw Item ID<input value={itemId} onChange={(event) => setItemId(event.target.value)} /></label>
          <button disabled={!canRunCliAction} title={!canRunCliAction ? cliDisabledReason : undefined} onClick={() => run(async () => { if (window.confirm(`Give raw item id ${itemId} to player ${actionPlayerId}?`)) await runTask(() => playersApi.giveItemId(actionPlayerId, { itemId, quantity: Number(quantity), durability: 1 })); })}>Give Item by ID</button>
        </div></details>
        <h4>Give Multiple Items</h4>
        <div className="action-line">
          <button disabled={!selectedItem} onClick={() => setMultiList([...multiList, { itemName, itemId, quantity: Number(quantity), durability: Number(durability) }])}>Add Selected Item</button>
          <button disabled={!multiList.length} onClick={() => setMultiList([])}>Clear List</button>
        </div>
        {multiList.length ? <div className="table-wrap starter-items-table"><table><thead><tr><th>Item Name</th><th>Item ID</th><th>Quantity</th><th>Durability</th><th>Actions</th></tr></thead><tbody>{multiList.map((item, index) => <tr key={`${item.itemName || item.itemId}-${index}`}><td>{starterItemName(item)}</td><td>{starterItemId(item)}</td><td>{item.quantity}</td><td>{item.durability}</td><td><button className="danger" onClick={() => setMultiList(multiList.filter((_, itemIndex) => itemIndex !== index))}>Remove</button></td></tr>)}</tbody></table></div> : <div className="empty">No multi-item entries yet. Search/select an item, set quantity, then Add Selected Item.</div>}
        <details className="technical-details"><summary>Developer raw multi-item textarea</summary><label>Multiple Items<textarea value={multiItems} onChange={(event) => setMultiItems(event.target.value)} placeholder="One item per line: name or raw id, quantity, durability" rows={4} /></label></details>
        <button disabled={!canRunCliAction} title={!canRunCliAction ? cliDisabledReason : undefined} onClick={() => run(async () => { const items = parsedMultiItems(); if (window.confirm(`Give ${items.length} item entries to player ${actionPlayerId}?`)) await runDirect(() => playersApi.giveItems(actionPlayerId, items)); })}>Give Multiple Items</button>
      </section>

      <section className="action-section">
        <h4>XP / Skills</h4>
        <div className="action-line">
          <label>XP Amount<input value={xp} onChange={(event) => setXp(event.target.value)} /></label>
          <button disabled={!canRunCliAction} title={!canRunCliAction ? cliDisabledReason : undefined} onClick={() => run(async () => { if (window.confirm(`Add ${xp} XP to player ${actionPlayerId}?`)) await runTask(() => playersApi.addXp(actionPlayerId, Number(xp))); })}>Add XP</button>
        </div>
        <div className="action-line">
          <label>Skill Points<input value={points} onChange={(event) => setPoints(event.target.value)} /></label>
          <button disabled={!canRunCliAction} title={!canRunCliAction ? cliDisabledReason : undefined} onClick={() => run(async () => { if (window.confirm(`Set player ${actionPlayerId} to ${points} unspent skill points?`)) await runTask(() => playersApi.setSkillPoints(actionPlayerId, Number(points))); })}>Set Skill Points</button>
        </div>
        <div className="action-line">
          <label>Skill Module<input value={module} onChange={(event) => setModule(event.target.value)} /></label>
          <label>Level<input value={level} onChange={(event) => setLevel(event.target.value)} /></label>
          <button disabled={!canRunCliAction} title={!canRunCliAction ? cliDisabledReason : undefined} onClick={() => run(async () => { if (window.confirm(`Set ${module} to level ${level} for player ${actionPlayerId}?`)) await runTask(() => playersApi.setSkillModule(actionPlayerId, { module, level: Number(level) })); })}>Set Skill Module</button>
        </div>
      </section>

      <section className="action-section">
        <h4>Survival</h4>
        <p>Refill Water uses the live admin CLI and was verified in-game.</p>
        <div className="action-line">
          <button disabled={!canRunCliAction} title={!canRunCliAction ? cliDisabledReason : undefined} onClick={() => run(async () => { if (window.confirm(`Refill water for player ${actionPlayerId}?`)) await runTask(() => playersApi.refillWater(actionPlayerId)); })}>Refill Water</button>
        </div>
      </section>

      <section className="action-section">
        <h4>Movement / Vehicles</h4>
        <p>Use current position only to copy known coordinates; edit X/Y/Z before teleporting if needed. Yaw defaults to 0 when unavailable.</p>
        <div className="action-line">
          <label>X<input value={coords.x} onChange={(event) => setCoords({ ...coords, x: event.target.value })} /></label>
          <label>Y<input value={coords.y} onChange={(event) => setCoords({ ...coords, y: event.target.value })} /></label>
          <label>Z<input value={coords.z} onChange={(event) => setCoords({ ...coords, z: event.target.value })} /></label>
          <label>Yaw<input value={coords.yaw} onChange={(event) => setCoords({ ...coords, yaw: event.target.value })} /></label>
          <button onClick={() => run(useCurrentPosition)}>Use Current Position</button>
          <button disabled={!canRunCliAction} title={!canRunCliAction ? cliDisabledReason : undefined} onClick={() => run(async () => { if (window.confirm(`Teleport player ${actionPlayerId} to X=${coords.x} Y=${coords.y} Z=${coords.z}?`)) await runTask(() => playersApi.teleport(actionPlayerId, { x: Number(coords.x), y: Number(coords.y), z: Number(coords.z), yaw: Number(coords.yaw) })); })}>Teleport</button>
        </div>
        <div className="action-line">
          <label>Vehicle<select value={vehicleId} onChange={(event) => { const nextVehicle = event.target.value; setVehicleId(nextVehicle); setVehicleTemplate(vehicleCatalog[nextVehicle]?.[0] || ""); }}>
            {vehicleIds.length === 0 && <option value="">Manual vehicle ID</option>}
            {vehicleIds.map((id) => <option key={id} value={id}>{id}</option>)}
          </select></label>
          <label>Template<select value={vehicleTemplate} onChange={(event) => setVehicleTemplate(event.target.value)}>
            {selectedTemplates.length === 0 && <option value="">Manual template</option>}
            {selectedTemplates.map((template) => <option key={template} value={template}>{template}</option>)}
          </select></label>
          <button disabled={!canRunCliAction} title={!canRunCliAction ? cliDisabledReason : undefined} onClick={() => run(async () => {
            const knownTemplates = Object.values(vehicleCatalog).flat();
            if (knownTemplates.includes(vehicleId) && !vehicleCatalog[vehicleId]) throw new Error(`${vehicleId} is a vehicle template, not a vehicle ID. Choose a vehicle such as Sandbike, then choose ${vehicleId} as the template.`);
            if (window.confirm(`Spawn ${vehicleId}/${vehicleTemplate} in front of player ${actionPlayerId}?`)) await runTask(() => playersApi.spawnVehicle(actionPlayerId, { vehicleId, template: vehicleTemplate, offset: 400 }));
          })}>Spawn Vehicle</button>
        </div>
        <details className="technical-details">
          <summary>Advanced manual override</summary>
          <div className="actions-grid">
            <label>Manual Vehicle ID<input value={vehicleId} onChange={(event) => setVehicleId(event.target.value)} placeholder="Sandbike" /></label>
            <label>Manual Template<input value={vehicleTemplate} onChange={(event) => setVehicleTemplate(event.target.value)} placeholder="T1_ExtraSeat" /></label>
          </div>
        </details>
      </section>

      <section className="action-section">
        <h4>Currency / Factions</h4>
        <p>These direct DB mutations create a backup first and use the DB player ID.</p>
        <div className="action-line">
          <label>Currency ID<input value={currency.currencyId} onChange={(event) => setCurrency({ ...currency, currencyId: event.target.value })} /></label>
          <label>Currency Amount<input value={currency.amount} onChange={(event) => setCurrency({ ...currency, amount: event.target.value })} /></label>
          <button onClick={() => run(async () => { if (window.confirm(`Add ${currency.amount} currency ${currency.currencyId || "Solaris"} to DB player ${dbPlayerId}? A backup will be created first.`)) await runDirect(() => playersApi.addCurrency(dbPlayerId, { currencyId: Number(currency.currencyId || 0), amount: Number(currency.amount), confirmation: "ADD CURRENCY" })); })}>Add Currency</button>
        </div>
        <div className="action-line">
          <label>Faction ID<input value={faction.factionId} onChange={(event) => setFaction({ ...faction, factionId: event.target.value })} /></label>
          <label>Reputation Amount<input value={faction.amount} onChange={(event) => setFaction({ ...faction, amount: event.target.value })} /></label>
          <button onClick={() => run(async () => { if (window.confirm(`Add ${faction.amount} reputation for faction ${faction.factionId} to DB player ${dbPlayerId}? A backup will be created first.`)) await runDirect(() => playersApi.addFactionReputation(dbPlayerId, { factionId: Number(faction.factionId), amount: Number(faction.amount), confirmation: "ADD FACTION REPUTATION" })); })}>Add Faction Reputation</button>
        </div>
      </section>

      <section className="action-section">
        <h4>Repair / Refuel</h4>
        <p>Offline DB-backed repair/refuel actions create a backup first.</p>
        <div className="action-line">
          <button onClick={() => run(async () => { if (window.confirm(`Repair gear for offline DB player ${dbPlayerId}? A backup will be created first.`)) await runDirect(() => playersApi.repairGear(dbPlayerId, "REPAIR GEAR")); })}>Repair Gear</button>
        </div>
        <div className="action-line">
          <label>Refuel Vehicle Actor ID<input value={refuelVehicleId} onChange={(event) => setRefuelVehicleId(event.target.value)} /></label>
          <button onClick={() => run(async () => { if (window.confirm(`Refuel vehicle ${refuelVehicleId} owned by DB player ${dbPlayerId}? A backup will be created first.`)) await runDirect(() => playersApi.refuelVehicle(dbPlayerId, { vehicleId: refuelVehicleId, confirmation: "REFUEL VEHICLE" })); })}>Refuel Vehicle</button>
        </div>
      </section>

      <section className="action-section danger-section">
        <h4>Dangerous Actions</h4>
        <p>These live CLI actions are destructive or disruptive and still require backend confirmation phrases.</p>
        <div className="action-row">
          <button className="danger" disabled={!canRunCliAction} title={!canRunCliAction ? cliDisabledReason : undefined} onClick={() => run(async () => { if (window.confirm(`Kick player ${actionPlayerId}?`)) await runTask(() => playersApi.kick(actionPlayerId)); })}>Kick Player</button>
          <button className="danger" disabled={!canRunCliAction} title={!canRunCliAction ? cliDisabledReason : undefined} onClick={() => run(async () => { if (window.confirm(`Clean inventory for player ${actionPlayerId}? This removes carried items.`)) await runTask(() => playersApi.cleanInventory(actionPlayerId, "CLEAN INVENTORY")); })}>Clean Inventory</button>
          <button className="danger" disabled={!canRunCliAction} title={!canRunCliAction ? cliDisabledReason : undefined} onClick={() => run(async () => { if (window.confirm(`Reset progression for player ${actionPlayerId}?`)) await runTask(() => playersApi.resetProgression(actionPlayerId, "RESET PROGRESSION")); })}>Reset Progression</button>
        </div>
      </section>
    </div>
  </section>;
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

function loadDatabasePasswordState(): DatabasePasswordState {
  if (typeof window === "undefined") return { result: null };
  try {
    const raw = window.localStorage.getItem(DATABASE_PASSWORD_STATE_KEY);
    if (!raw) return { result: null };
    const parsed = JSON.parse(raw) as DatabasePasswordState;
    return parsed && parsed.result ? parsed : { result: null };
  } catch {
    return { result: null };
  }
}

function persistDatabasePasswordState(state: DatabasePasswordState) {
  if (typeof window === "undefined") return;
  if (!state.result) {
    window.localStorage.removeItem(DATABASE_PASSWORD_STATE_KEY);
    return;
  }
  window.localStorage.setItem(DATABASE_PASSWORD_STATE_KEY, JSON.stringify(state));
}

async function pollDatabasePasswordRestart(
  taskId: string,
  setState: (state: DatabasePasswordState) => void,
  onFinished: () => Promise<void>
) {
  let current: Task;
  try {
    current = (await setupApi.task(taskId)).task;
    for (let i = 0; i < 3600 && !isTerminalTask(current.status); i += 1) {
      const runningState = { taskId, result: { status: "running", title: "Restarting Server..." } satisfies HomeTaskResult };
      persistDatabasePasswordState(runningState);
      setState(runningState);
      await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 1000));
      current = (await setupApi.task(taskId)).task;
    }
  } catch (error) {
    const failed = { result: { status: "failed", title: "Password Change Failed", message: error instanceof Error ? error.message : String(error) } satisfies HomeTaskResult };
    persistDatabasePasswordState(failed);
    setState(failed);
    return;
  }
  const next = current.status === "succeeded"
    ? { result: { status: "succeeded", title: "Password Changed Successfully" } satisfies HomeTaskResult }
    : { result: { status: "failed", title: "Password Change Failed", message: conciseTaskError(current) } satisfies HomeTaskResult };
  persistDatabasePasswordState(next);
  setState(next);
  await onFinished().catch(() => undefined);
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

function loadPersistedFuncomTokenResult(): HomeTaskResult | null {
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

function persistFuncomTokenResult(result: HomeTaskResult | null) {
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then((value) => {
      window.clearTimeout(id);
      resolve(value);
    }).catch((error) => {
      window.clearTimeout(id);
      reject(error);
    });
  });
}

function parseUpdateTask(task: Task) {
  const text = task.logLines.map((line) => line.line).join("\n");
  if (task.status === "failed") return { status: "Check Failed", current: "", latest: "", reason: task.errorMessage || summarizeCommandText(text) };
  if (task.status !== "succeeded") return { status: "Checking...", current: "", latest: "", reason: task.progressMessage || "" };
  const current = firstVersionMatch(text, [/current(?: stack)?(?: build| version)?\s*[:=]\s*([^\n]+)/i, /installed(?: build| version)?\s*[:=]\s*([^\n]+)/i, /local(?: build| version)?\s*[:=]\s*([^\n]+)/i]);
  const latest = firstVersionMatch(text, [/latest(?: release| build| version)?\s*[:=]\s*([^\n]+)/i, /remote(?: build| version)?\s*[:=]\s*([^\n]+)/i, /available(?: build| version)?\s*[:=]\s*([^\n]+)/i]);
  const updateAvailable = /update available|newer|can update|available update/i.test(text);
  const latestStatus = /up to date|already latest|no update|latest/i.test(text) && !updateAvailable;
  if (sameUpdateVersion(current, latest)) return { status: "Latest", current, latest, reason: summarizeCommandText(text) };
  if (updateAvailable) return { status: "Update Available", current, latest, reason: summarizeCommandText(text) };
  if (latestStatus) return { status: "Latest", current, latest, reason: summarizeCommandText(text) };
  return { status: current || latest ? "Completed" : "Version details unavailable", current, latest, reason: current || latest ? summarizeCommandText(text) : "Unable to parse version details from completed check." };
}

function GameUpdateProgress({ task, repairTask, onRetry, onFixSteamcmd }: { task: Task; repairTask: Task | null; onRetry: () => Promise<void>; onFixSteamcmd: () => Promise<void> }) {
  const progress = summarizeGameUpdateProgress(task);
  const running = !isTerminalTask(task.status);
  const repairRunning = Boolean(repairTask && !isTerminalTask(repairTask.status));
  const repairSucceeded = repairTask?.status === "succeeded";
  const repairable = task.status === "failed" && isSteamcmdManifestFailure(task);
  return <div className={`result-panel game-update-progress result-${task.status === "succeeded" ? "ok" : task.status === "failed" ? "fail" : "running"}`} aria-live="polite">
    <div className="panel-title">
      <h4 className={running ? "loading-dots" : ""}>{progress.title}</h4>
      <StatusPill value={task.status === "failed" ? "Failed" : task.status === "succeeded" ? "Succeeded" : "Running"} />
    </div>
    <div className="progress-row">
      <div className="progress-track" aria-label={`Game update progress ${progress.percent}%`}>
        <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
      </div>
      <strong>{progress.percent}%</strong>
    </div>
    <p>{progress.message}</p>
    {repairRunning && <p className="muted">Fixing SteamCMD...</p>}
    {repairSucceeded && <p className="muted">SteamCMD manifest reset. Retry the game update when ready.</p>}
    {task.status === "failed" && <div className="action-line">
      {repairable && <button disabled={repairRunning} onClick={onFixSteamcmd}>Fix SteamCMD</button>}
      <button disabled={repairRunning} onClick={onRetry}>Retry Game Update</button>
    </div>}
  </div>;
}

function summarizeGameUpdateProgress(task: Task) {
  const text = task.logLines.map((line) => line.line).join("\n");
  const latestLine = [...task.logLines].reverse().map((line) => line.line.trim()).find(Boolean) || task.progressMessage || task.currentStep || "";
  if (task.status === "succeeded") {
    return { title: "Update Complete", percent: 100, message: "The game server update finished and the stack restart was started." };
  }
  if (task.status === "failed") {
    return { title: "Update Failed", percent: Math.max(5, gameUpdatePercent(text)), message: conciseTaskError(task) };
  }

  const retryMatch = text.match(/Retrying(?: app install)? in (\d+)s/i);
  if (retryMatch) {
    return { title: "Updating", percent: Math.max(45, gameUpdatePercent(text)), message: `Steam download hit a temporary problem. Retrying in ${retryMatch[1]} seconds.` };
  }
  const attemptMatch = text.match(/SteamCMD install attempt\s+(\d+)\/(\d+)/i);
  const steamcmdStage = isSteamcmdUpdateActive(text) ? summarizeSteamcmdStage(task.logLines.map((line) => line.line), attemptMatch) : null;
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

    if (/Success!\s+App\s+'?\d+'?.*fully installed/i.test(line)) {
      return { title: "Server Files Installed", percent: 62, message: `SteamCMD finished installing the server files.${attemptText}` };
    }
    if (/Validating|validation/i.test(line)) {
      return { title: "Validating Server Files", percent: 56, message: `SteamCMD is validating the installed server files.${attemptText}` };
    }
    if (/Downloading item|download item|download depot|downloading/i.test(line)) {
      return { title: "Downloading Server Files", percent: 46, message: `SteamCMD is downloading server file content.${attemptText}` };
    }
    if (/Connecting anonymously|Connecting to Steam/i.test(line)) {
      return { title: "Connecting To Steam", percent: 43, message: `SteamCMD is connecting to Steam.${attemptText}` };
    }
    if (/Waiting for (client config|user info)/i.test(line)) {
      return { title: "Loading Steam Metadata", percent: 44, message: `SteamCMD is loading Steam account and depot metadata.${attemptText}` };
    }
    if (/Logging in user|login anonymous|Logged in OK/i.test(line)) {
      return { title: "Logging In To Steam", percent: 44, message: `SteamCMD is logging in anonymously to Steam.${attemptText}` };
    }
    if (/Loading Steam API/i.test(line)) {
      return { title: "Starting SteamCMD", percent: 42, message: `SteamCMD is starting and loading the Steam API.${attemptText}` };
    }
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
  if (/Pre-flight: check Steam/i.test(text)) return "Checking Steam for the latest available server build.";
  if (/Check Docker volume free space/i.test(text)) return "Checking available disk space before downloading files.";
  if (/Stop game servers before update/i.test(text)) return "Stopping game servers before replacing server files.";
  if (/Download\/update server files with SteamCMD/i.test(text)) return "Downloading updated game server files.";
  if (/Load updated Funcom image tarballs/i.test(text)) return "Loading updated game container images.";
  if (/Detect loaded image tags/i.test(text)) return "Detecting updated image versions.";
  if (/Run database update\/migration/i.test(text)) return "Running database migrations for the updated build.";
  if (/Refresh generated map catalogs/i.test(text)) return "Refreshing generated map catalogs.";
  if (/Restarting Dune stack/i.test(text)) return "Restarting the Dune stack with the updated build.";
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

function StackUpdateProgress({ task, onRetry }: { task: Task; onRetry: () => Promise<void> }) {
  const progress = summarizeStackUpdateProgress(task);
  const running = !isTerminalTask(task.status);
  return <div className={`result-panel stack-update-progress result-${task.status === "succeeded" ? "ok" : task.status === "failed" ? "fail" : "running"}`} aria-live="polite">
    <div className="panel-title">
      <h4 className={running ? "loading-dots" : ""}>{progress.title}</h4>
      <StatusPill value={task.status === "failed" ? "Failed" : task.status === "succeeded" ? "Succeeded" : "Running"} />
    </div>
    <div className="progress-row">
      <div className="progress-track" aria-label={`Stack update progress ${progress.percent}%`}>
        <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
      </div>
      <strong>{progress.percent}%</strong>
    </div>
    <p>{progress.message}</p>
    {task.status === "failed" && <div className="action-line"><button onClick={onRetry}>Retry Stack Update</button></div>}
  </div>;
}

function summarizeStackUpdateProgress(task: Task) {
  const text = task.logLines.map((line) => line.line).join("\n");
  const latestLine = [...task.logLines].reverse().map((line) => line.line.trim()).find(Boolean) || task.progressMessage || task.currentStep || "";
  if (task.status === "succeeded") {
    const installedVersion = firstVersionMatch(text, [/Installed stack version:\s*([^\n]+)/i]);
    return { title: "Stack Update Complete", percent: 100, message: installedVersion ? `Stack files were updated to ${installedVersion}. Restart or rebuild the web console to run the new stack version.` : "Stack files were updated. Restart or rebuild the web console to run the new stack version." };
  }
  if (task.status === "failed") {
    return { title: "Stack Update Failed", percent: Math.max(5, stackUpdatePercent(text)), message: conciseTaskError(task) };
  }
  const stackStage = summarizeStackUpdateStage(task.logLines.map((line) => line.line));
  if (stackStage) return stackStage;
  return { title: "Updating Stack", percent: stackUpdatePercent(text), message: friendlyStackUpdateMessage(text, latestLine) };
}

function stackUpdatePercent(text: string) {
  const stages: [RegExp, number][] = [
    [/Running selfUpdateApply/i, 5],
    [/Downloading stack release/i, 20],
    [/Backing up current stack files/i, 42],
    [/Installing stack release into/i, 66],
    [/Installed stack version/i, 88],
    [/Previous stack files backup/i, 94],
    [/Exit and reopen dune manager/i, 98]
  ];
  let percent = 3;
  for (const [pattern, value] of stages) {
    if (pattern.test(text)) percent = Math.max(percent, value);
  }
  return percent;
}

function friendlyStackUpdateMessage(text: string, latestLine: string) {
  if (/Downloading stack release/i.test(text)) return "Downloading the selected GitHub release.";
  if (/Backing up current stack files/i.test(text)) return "Backing up the current stack files before replacing them.";
  if (/Installing stack release into/i.test(text)) return "Installing the downloaded stack release files.";
  if (/Installed stack version/i.test(text)) return "Verifying the installed stack version.";
  if (/Previous stack files backup/i.test(text)) return "Finishing the stack update and recording the backup location.";
  return latestLine && !/^\s*Task started/i.test(latestLine) ? friendlyStackUpdateLine(latestLine) : "Preparing the stack update.";
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
    return { title: "Finishing Stack Update", percent: 94, message: backupFile ? `Recorded backup at ${backupFile}.` : "Recording the previous stack backup location." };
  }
  if (installedIndex >= 0) {
    const version = cleanLines[installedIndex].trim().replace(/^Installed stack version:\s*/i, "").trim();
    return { title: "Verifying Stack Version", percent: 88, message: version ? `Installed stack version ${version}. Verifying the update before finishing.` : "Verifying the installed stack version." };
  }
  if (installIndex >= 0) {
    const target = nextIndentedLine(cleanLines, installIndex);
    return { title: "Installing Stack Release", percent: 66, message: target ? `Installing the downloaded stack release into ${target}.` : "Installing the downloaded stack release files." };
  }
  if (backupIndex >= 0) {
    const backupDir = nextIndentedLine(cleanLines, backupIndex);
    return { title: "Backing Up Stack Files", percent: 42, message: backupDir ? `Backing up current stack files to ${backupDir}.` : "Backing up the current stack files before replacing them." };
  }
  if (downloadIndex >= 0) {
    const tag = cleanLines[downloadIndex].trim().replace(/^Downloading stack release:\s*/i, "").trim();
    return { title: "Downloading Stack Release", percent: 20, message: tag ? `Downloading stack release ${tag} from GitHub.` : "Downloading the selected GitHub release." };
  }
  if (dirtyIndex >= 0) {
    return { title: "Preparing Stack Backup", percent: 12, message: "Local tracked changes were detected; the updater will back up the current project files first." };
  }
  return null;
}

function nextIndentedLine(lines: string[], index: number) {
  const next = lines[index + 1] || "";
  return /^\S/.test(next) ? "" : next.trim();
}

function friendlyStackUpdateLine(line: string) {
  if (/^Running selfUpdateApply$/i.test(line)) return "Preparing the stack update.";
  if (/^Task started$/i.test(line)) return "Preparing the stack update.";
  if (/Could not|failed|denied|rate-limited/i.test(line)) return line;
  return "Working on the stack update.";
}

function updateDisplayValue(status: Record<string, string>, key: "current" | "latest") {
  if (/checking/i.test(status.status)) return "Checking...";
  return status[key] || "Unknown";
}

function canApplyUpdateStatus(status: Record<string, string>) {
  return status.status === "Update Available" && !sameUpdateVersion(status.current, status.latest);
}

function sameUpdateVersion(current: string, latest: string) {
  const normalizedCurrent = normalizeUpdateVersion(current);
  const normalizedLatest = normalizeUpdateVersion(latest);
  return Boolean(normalizedCurrent && normalizedLatest && normalizedCurrent === normalizedLatest);
}

function normalizeUpdateVersion(value: string) {
  return String(value || "")
    .trim()
    .replace(/^v/i, "")
    .replace(/\s+\(.+\)$/i, "")
    .toLowerCase();
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

function firstVersionMatch(text: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim().slice(0, 80);
  }
  return "";
}

function PlayerDetailTab({ playerId, tab, onError }: { playerId: string; tab: string; onError: (text: string) => void }) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState("");
  const [messageDetails, setMessageDetails] = useState("");
  async function loadTab() {
    const loaders: Record<string, () => Promise<Record<string, unknown>>> = {
      inventory: () => playersApi.inventory(playerId),
      currency: () => playersApi.currency(playerId),
      factions: () => playersApi.factions(playerId),
      specs: () => playersApi.specs(playerId),
      position: () => playersApi.position(playerId),
      progression: () => playersApi.progression(playerId),
      events: () => playersApi.events(playerId),
      stats: () => playersApi.stats(playerId),
      history: () => playersApi.history(playerId)
    };
    setData(null);
    setMessage("");
    await loaders[tab]?.().then(setData).catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }
  useEffect(() => {
    loadTab();
  }, [playerId, tab]);
  async function deleteItem(row: Record<string, unknown>) {
    const itemId = String(row.id || "");
    if (!window.confirm(`Delete item ${itemId} (${String(row.template_id || "")}) from player ${playerId}? A database backup will be created first.`)) return;
    try {
      const response = await playersApi.deleteInventoryItem(playerId, itemId, "DELETE ITEM");
      setMessage(formatMutationResult(response));
      setMessageDetails(JSON.stringify(response, null, 2));
      await loadTab();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage(text);
      setMessageDetails("");
      onError(text);
    }
  }
  const rows = Array.isArray(data?.rows) ? data.rows as Record<string, unknown>[] : data?.position ? [data.position as Record<string, unknown>] : [];
  return <div>{data?.reason ? <p className="danger-note">{String(data.reason)}</p> : null}{message && <div className="result-panel"><strong>Mutation Result</strong><p>{message}</p>{messageDetails && <TechnicalDetails text={messageDetails} />}</div>}<DataTable rows={rows} action={tab === "inventory" ? (row) => <button className="danger" onClick={(event) => { event.stopPropagation(); deleteItem(row); }}>Delete Item</button> : undefined} /></div>;
}

function LogsPanel({ selectedService, setSelectedService, text, setText, onError }: { selectedService: string; setSelectedService: (service: string) => void; text: string; setText: Dispatch<SetStateAction<string>>; onError: (text: string) => void }) {
  const [services, setServices] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const loadSelectedLogs = useCallback(async (service = selectedService) => {
    onError("");
    try {
      setText((current) => current ? current : "Loading logs...");
      setText((await logsApi.get(service)).stdout);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    }
  }, [onError, selectedService, setText]);
  useEffect(() => {
    logsApi.services().then((result) => setServices(result.services)).catch(() => undefined);
  }, []);
  useEffect(() => {
    let active = true;
    onError("");
    setText("Loading logs...");
    logsApi.get(selectedService).then((result) => {
      if (active) setText(result.stdout);
    }).catch((error) => {
      if (active) onError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, [selectedService, onError, setText]);
  useEffect(() => {
    if (!streaming) return;
    const source = new EventSource(logsApi.streamUrl(selectedService), { withCredentials: true });
    source.onmessage = (event) => {
      if (paused) return;
      const data = JSON.parse(event.data) as { line: string };
      setText((current) => `${current}${data.line}`);
    };
    source.onerror = () => source.close();
    return () => source.close();
  }, [streaming, paused, selectedService]);
  const shown = filter ? text.split(/\r?\n/).filter((line) => line.toLowerCase().includes(filter.toLowerCase())).join("\n") : text;
  return (
    <section className="panel">
      <h2>Logs</h2>
      <div className="action-row">
        <select value={selectedService} onChange={(event) => setSelectedService(event.target.value)}>
          {services.map((service) => <option key={service} value={service}>{friendlyServiceName(service)}</option>)}
        </select>
        <button onClick={() => loadSelectedLogs()}>Refresh Logs</button>
        <button onClick={() => setStreaming(!streaming)}>{streaming ? "Stop Stream" : "Live Stream"}</button>
        <button onClick={() => setPaused(!paused)}>{paused ? "Resume" : "Pause"}</button>
        <a className="button-link" href={logsApi.downloadUrl(selectedService)}>Download</a>
      </div>
      <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search Logs" />
      <LogViewer text={shown} />
    </section>
  );
}

function DatabasePanel() {
  const [schema, setSchema] = useState("dune");
  const [tables, setTables] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<{ columns?: { name: string }[]; rows?: Record<string, unknown>[] } | null>(null);
  const [columns, setColumns] = useState<Record<string, unknown>[]>([]);
  const [count, setCount] = useState("");
  const [sql, setSql] = useState("select * from dune.player_state limit 25");
  const [confirmation, setConfirmation] = useState("");
  const [queryResult, setQueryResult] = useState<{ columns?: { name: string }[]; rows?: Record<string, unknown>[] } | null>(null);
  const [queryRan, setQueryRan] = useState(false);
  const [databaseStatus, setDatabaseStatus] = useState<Record<string, unknown> | null>(null);
  const [databaseStatusError, setDatabaseStatusError] = useState("");
  const [databaseStatusLoading, setDatabaseStatusLoading] = useState(false);
  const [passwordPanelOpen, setPasswordPanelOpen] = useState(false);
  const [databasePassword, setDatabasePassword] = useState("");
  const [databasePasswordConfirm, setDatabasePasswordConfirm] = useState("");
  const [databasePasswordState, setDatabasePasswordState] = useState<DatabasePasswordState>(() => loadDatabasePasswordState());
  const [search, setSearch] = useState("");
  const [searchRows, setSearchRows] = useState<Record<string, unknown>[]>([]);
  const [searchRan, setSearchRan] = useState(false);
  const [advancedSqlOpen, setAdvancedSqlOpen] = useState(false);
  const [editRow, setEditRow] = useState<Record<string, unknown> | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [editResult, setEditResult] = useState<HomeTaskResult | null>(null);
  const previewRef = useRef<HTMLHeadingElement | null>(null);
  const editRef = useRef<HTMLElement | null>(null);
  const databasePasswordResult = databasePasswordState.result;
  async function loadTables() { setTables(await databaseApi.tables(schema)); }
  useEffect(() => {
    loadTables().catch(() => undefined);
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (!databasePasswordState.taskId || databasePasswordState.result?.status !== "running") return undefined;
    void pollDatabasePasswordRestart(databasePasswordState.taskId, (next) => {
      if (!cancelled) setDatabasePasswordState(next);
    }, async () => {
      if (!cancelled) await loadDatabaseStatus();
    });
    return () => {
      cancelled = true;
    };
  }, [databasePasswordState.taskId, databasePasswordState.result?.status]);
  function updateDatabasePasswordState(next: DatabasePasswordState) {
    setDatabasePasswordState(next);
    persistDatabasePasswordState(next);
  }
  async function open(table: string) {
    setSelected(table);
    setEditRow(null);
    setEditResult(null);
    const [nextPreview, nextColumns, nextCount] = await Promise.all([
      databaseApi.preview(schema, table, 50, 0),
      databaseApi.columns(schema, table),
      databaseApi.count(schema, table)
    ]);
    setPreview(nextPreview);
    setColumns(nextColumns);
    setCount(String(nextCount.count));
    window.setTimeout(() => previewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }
  async function loadDatabaseStatus() {
    setDatabaseStatusLoading(true);
    setDatabaseStatusError("");
    try {
      setDatabaseStatus(await databaseApi.status());
    } catch (error) {
      setDatabaseStatus(null);
      setDatabaseStatusError(error instanceof Error ? error.message : String(error));
    } finally {
    setDatabaseStatusLoading(false);
    }
  }
  async function changeDatabasePassword() {
    if (databasePassword.length < 4) {
      updateDatabasePasswordState({ result: { status: "failed", title: "Password Change Failed", message: "Database password must be at least 4 characters." } });
      return;
    }
    if (databasePassword !== databasePasswordConfirm) {
      updateDatabasePasswordState({ result: { status: "failed", title: "Password Change Failed", message: "Passwords do not match." } });
      return;
    }
    updateDatabasePasswordState({ result: { status: "running", title: "Changing Password..." } });
    try {
      const response = await databaseApi.changePassword(databasePassword);
      setDatabasePassword("");
      setDatabasePasswordConfirm("");
      const runningState = { taskId: response.task.id, result: { status: "running", title: "Restarting Server..." } satisfies HomeTaskResult };
      updateDatabasePasswordState(runningState);
      setDatabaseStatus((current) => current ? { ...current, usesDefaultPassword: false } : current);
    } catch (error) {
      updateDatabasePasswordState({ result: { status: "failed", title: "Password Change Failed", message: error instanceof Error ? error.message : String(error) } });
    }
  }
  function startEdit(row: Record<string, unknown>) {
    setEditRow(row);
    setEditResult(null);
    setEditValues(Object.fromEntries(databasePreviewColumns(preview).map((column) => [column, serializeEditableDbValue(row[column])])));
    window.setTimeout(() => editRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }
  async function saveEditedRow() {
    if (!selected || !editRow) return;
    const rowId = String(editRow.__rowid || "");
    setEditResult({ status: "running", title: "Saving Row..." });
    try {
      const originalValues = Object.fromEntries(databasePreviewColumns(preview).map((column) => [column, editRow[column]]));
      const nextValues = Object.fromEntries(Object.entries(editValues).map(([key, value]) => [key, parseEditableDbValue(value, originalValues[key])]));
      const result = await databaseApi.updateRow(schema, selected, rowId, nextValues);
      await open(selected);
      setEditResult(result.updatedRows > 0
        ? { status: "succeeded", title: "Row Saved Successfully" }
        : { status: "failed", title: "Row Save Failed", message: "The row was not updated. Refresh the table and try again." });
    } catch (error) {
      setEditResult({ status: "failed", title: "Row Save Failed", message: error instanceof Error ? error.message : String(error) });
    }
  }
  async function runQuery() {
    setQueryRan(true);
    setQueryResult(await databaseApi.query(sql, confirmation));
  }
  async function searchColumns() {
    setSearchRan(true);
    setSearchRows(await databaseApi.search(search));
  }
  const databaseServer = databaseStatus?.server as Record<string, unknown> | undefined;
  const databaseConfig = databaseStatus?.config as Record<string, unknown> | undefined;
  const showDefaultDatabasePasswordNote = !databaseStatus || databaseStatus.usesDefaultPassword !== false;
  const previewColumns = databasePreviewColumns(preview);
  const previewRows = preview?.rows || [];
  const queryColumns = queryResult?.columns?.map((column) => column.name).filter((name) => name !== "__rowid");
  const queryRows = (queryResult?.rows || []).map((row) => omitInternalRowFields(row));
  return <section className="panel">
    <h2>Database Browser</h2>
    <div className="action-row"><button onClick={loadTables}>Refresh Tables</button><button onClick={() => setPasswordPanelOpen((open) => !open)}>Change Password</button><button disabled={databaseStatusLoading} onClick={loadDatabaseStatus}>{databaseStatusLoading ? "Checking..." : "Status"}</button></div>
    {passwordPanelOpen && <section className="result-panel database-password-panel">
      <div className="panel-title database-status-title"><strong>Change Database Password</strong><StatusPill value={databasePasswordResult?.status === "failed" ? "Failed" : databasePasswordResult?.status === "succeeded" ? "Saved" : "Info"} /></div>
      {showDefaultDatabasePasswordNote && <p className="muted">The default password is "dune".</p>}
      <div className="action-line">
        <label className="wide-field">New Password<SecretInput value={databasePassword} onChange={(event) => setDatabasePassword(event.target.value)} placeholder="New password" /></label>
        <label className="wide-field">Confirm Password<SecretInput value={databasePasswordConfirm} onChange={(event) => setDatabasePasswordConfirm(event.target.value)} placeholder="Confirm password" /></label>
        <button disabled={databasePasswordResult?.status === "running"} onClick={changeDatabasePassword}>Save Password</button>
      </div>
      {databasePasswordResult && <span className={`inline-task-result result-${databasePasswordResult.status === "succeeded" ? "ok" : databasePasswordResult.status === "failed" ? "fail" : "running"}`}>
        <strong className={databasePasswordResult.status === "running" ? "loading-dots" : ""}>{databasePasswordResult.title}</strong>
        {databasePasswordResult.message && <span className="inline-task-message">{databasePasswordResult.message}</span>}
      </span>}
    </section>}
    {(databaseStatus || databaseStatusError) && <section className={`result-panel ${databaseStatusError ? "result-fail" : "result-ok"}`}>
      <div className="panel-title database-status-title"><strong>Database Status</strong><StatusPill value={databaseStatusError ? "Failed" : "Connected"} /></div>
      {databaseStatusError ? <p>{databaseStatusError}</p> : <KeyValueGrid items={[
        ["Connected", databaseStatus?.connected ? "Yes" : "No"],
        ["Database", databaseServer?.current_database || databaseConfig?.database || "Unknown"],
        ["User", databaseServer?.current_user || databaseConfig?.user || "Unknown"],
        ["Dune Tables", databaseStatus?.duneTableCount ?? "Unknown"],
        ["Host", databaseConfig?.host || "Unknown"],
        ["Port", databaseConfig?.port || "Unknown"]
      ]} />}
      {!databaseStatusError && Boolean(databaseServer?.version) && <TechnicalDetails title="Postgres version" text={String(databaseServer?.version)} />}
    </section>}
    <h3>Tables</h3>
    <DataTable rows={tables} columns={["schema", "name", "estimated_rows"]} onRowClick={(row) => open(String(row.name))} />
    <h3 ref={previewRef}>{selected ? `${schema}.${selected} (${count} rows)` : "Table Preview"}</h3>
    {!selected && <div className="empty database-empty">No table selected. Select a table to preview and edit rows.</div>}
    {selected && <section className="database-table-panel">
      <details className="technical-details">
        <summary>Columns</summary>
        <DataTable rows={columns} />
      </details>
      {previewRows.length ? <DataTable rows={previewRows} columns={previewColumns} action={(row) => <button onClick={(event) => { event.stopPropagation(); startEdit(row); }}>Edit</button>} actionClassName="backup-table-actions" tableClassName="backup-table" /> : <div className="empty database-empty">This table has no rows to preview.</div>}
      {editRow && <section ref={editRef} className="result-panel database-edit-panel">
        <div className="panel-title"><strong>Edit Row</strong><StatusPill value={editResult?.status === "failed" ? "Failed" : editResult?.status === "succeeded" ? "Saved" : "Editing"} /></div>
        <div className="database-edit-grid">
          {previewColumns.map((column) => <label key={column}>{column}<textarea rows={2} value={editValues[column] || ""} onChange={(event) => setEditValues({ ...editValues, [column]: event.target.value })} /></label>)}
        </div>
        <div className="action-line">
          <button disabled={editResult?.status === "running"} onClick={saveEditedRow}>Save Row</button>
          <button onClick={() => setEditRow(null)}>Cancel</button>
        </div>
        {editResult && <span className={`inline-task-result result-${editResult.status === "succeeded" ? "ok" : editResult.status === "failed" ? "fail" : "running"}`}>
          <strong className={editResult.status === "running" ? "loading-dots" : ""}>{editResult.title}</strong>
          {editResult.message && <span className="inline-task-message">{editResult.message}</span>}
        </span>}
      </section>}
    </section>}
    <h3>Search Columns</h3>
    <div className="action-row"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tables or columns" /><button onClick={searchColumns}>Search</button></div>
    {searchRan && (searchRows.length ? <DataTable rows={searchRows} /> : <div className="empty database-empty">No matching tables or columns found.</div>)}
    <section className={`action-section database-advanced-section ${advancedSqlOpen ? "" : "collapsed-section"}`}>
      <div className="panel-title">
        <h3>Advanced SQL Console</h3>
        <button className={`icon-toggle-button ${advancedSqlOpen ? "active" : ""}`} aria-label={advancedSqlOpen ? "Collapse Advanced SQL Console" : "Expand Advanced SQL Console"} title={advancedSqlOpen ? "Collapse" : "Expand"} onClick={() => setAdvancedSqlOpen(!advancedSqlOpen)}>{advancedSqlOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button>
      </div>
      {advancedSqlOpen && <>
        <textarea value={sql} onChange={(event) => setSql(event.target.value)} rows={5} />
        <input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="RUN DESTRUCTIVE SQL for write queries" />
        <div className="action-row"><button onClick={runQuery}>Run Query</button><button onClick={async () => setQueryResult(await databaseApi.export(sql))}>Export Query JSON</button></div>
        {queryRan && (queryRows.length ? <DataTable rows={queryRows} columns={queryColumns} /> : <div className="empty database-empty">Query completed. No rows returned.</div>)}
      </>}
    </section>
  </section>;
}

function databasePreviewColumns(preview: { columns?: { name: string }[] } | null) {
  return (preview?.columns || []).map((column) => column.name).filter((name) => name !== "__rowid");
}

function omitInternalRowFields(row: Record<string, unknown>) {
  const { __rowid, ...visible } = row;
  void __rowid;
  return visible;
}

function serializeEditableDbValue(value: unknown) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function parseEditableDbValue(value: string, original: unknown) {
  const text = String(value);
  if (/^NULL$/i.test(text.trim())) return null;
  if (typeof original === "object" && original !== null) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}

function StarterKitPanel({ onError }: { onError: (text: string) => void }) {
  const [config, setConfig] = useState<StarterKitConfig>({
    enabled: false,
    version: "starter-kit-v1",
    activeKitId: "starter-kit-v1",
    autoGrantKitId: "starter-kit-v1",
    kits: [{ id: "starter-kit-v1", name: "Care Package", items: [], xp: 0, welcomeMessage: "" }],
    items: [],
    xp: 0,
    allowRepeatGrants: false,
    autoGrantEnabled: false,
    autoGrantIntervalSeconds: 60,
    grantWhen: "first_online",
    autoGrantRules: [{ id: "auto-rule-1", enabled: true, kitId: "starter-kit-v1", grantWhen: "first_online", lastSeenDays: 30 }]
  });
  const [itemsText, setItemsText] = useState("");
  const [selectedStarterItem, setSelectedStarterItem] = useState<CatalogItem | null>(null);
  const [starterDraft, setStarterDraft] = useState({ itemName: "", itemId: "", quantity: "1", durability: "1" });
  const [editingStarterIndex, setEditingStarterIndex] = useState<number | null>(null);
  const [starterEditDraft, setStarterEditDraft] = useState({ quantity: "1", durability: "1" });
  const [players, setPlayers] = useState<Record<string, unknown>[]>([]);
  const [selectedPlayer, setSelectedPlayer] = useState("");
  const [manualPlayerId, setManualPlayerId] = useState("");
  const [manualKitId, setManualKitId] = useState("starter-kit-v1");
  const [eligibleByRule, setEligibleByRule] = useState<Record<string, Record<string, unknown>[]>>({});
  const [history, setHistory] = useState<Record<string, unknown>[]>([]);
  const [starterGrantTab, setStarterGrantTab] = useState<"auto" | "manual">("auto");
  const [starterKitTab, setStarterKitTab] = useState<"create" | "configure">("configure");
  const [starterItemsOpen, setStarterItemsOpen] = useState(false);
  const [kitSaveResult, setKitSaveResult] = useState<HomeTaskResult | null>(null);
  const [packageCreateResult, setPackageCreateResult] = useState<HomeTaskResult | null>(null);
  const [autoGrantResult, setAutoGrantResult] = useState<HomeTaskResult | null>(null);
  const [newKitName, setNewKitName] = useState("");
  const [newAutoRule, setNewAutoRule] = useState<{ kitId: string; grantWhen: StarterKitAutoGrantRule["grantWhen"]; lastSeenDays: number }>({ kitId: "starter-kit-v1", grantWhen: "first_online", lastSeenDays: 30 });
  const [expandedRuleIds, setExpandedRuleIds] = useState<Record<string, boolean>>({});
  const [output, setOutput] = useState("");
  const [technicalOutput, setTechnicalOutput] = useState("");
  const [outputScope, setOutputScope] = useState<"config" | "grant" | "auto" | "history" | "">("");
  async function run(action: () => Promise<void>) {
    onError("");
    setOutput("");
    setTechnicalOutput("");
    setOutputScope("");
    try { await action(); } catch (error) { const text = error instanceof Error ? error.message : String(error); setOutput(text); onError(text); }
  }
  async function load() {
    const next = await starterKitApi.config();
    const normalized = normalizeStarterKitConfig(next);
    const lastKit = normalized.kits.at(-1);
    const displayConfig = lastKit ? { ...normalized, activeKitId: lastKit.id, version: lastKit.id, items: lastKit.items, xp: lastKit.xp } : normalized;
    setConfig(displayConfig);
    setStarterKitTab(lastKit ? "configure" : "create");
    setNewAutoRule({ kitId: lastKit?.id || normalized.autoGrantKitId || normalized.activeKitId, grantWhen: normalized.grantWhen, lastSeenDays: 30 });
    setManualKitId(lastKit?.id || normalized.activeKitId || "");
    setItemsText((lastKit?.items || normalized.items || []).map((item) => `${item.itemId || item.itemName || ""},${item.quantity},${item.durability}`).join("\n"));
    setHistory((await starterKitApi.history()).rows || []);
    setPlayers((await playersApi.list()).rows || []);
  }
  useEffect(() => {
    run(load);
  }, []);
  useEffect(() => {
    if (!kitSaveResult || kitSaveResult.status === "running") return undefined;
    const timer = window.setTimeout(() => setKitSaveResult(null), 5000);
    return () => window.clearTimeout(timer);
  }, [kitSaveResult]);
  useEffect(() => {
    if (!packageCreateResult || packageCreateResult.status === "running") return undefined;
    const timer = window.setTimeout(() => setPackageCreateResult(null), 5000);
    return () => window.clearTimeout(timer);
  }, [packageCreateResult]);
  useEffect(() => {
    if (!autoGrantResult || autoGrantResult.status === "running") return undefined;
    const timer = window.setTimeout(() => setAutoGrantResult(null), 5000);
    return () => window.clearTimeout(timer);
  }, [autoGrantResult]);
  function nextConfig(source = config): StarterKitConfig {
    const sourceActiveKit = starterKitActiveKit(source);
    return {
      ...source,
      allowRepeatGrants: false,
      grantWhen: source.grantWhen,
      items: source.kits.length === 0 ? [] : sourceActiveKit.items?.length ? sourceActiveKit.items : itemsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const [nameOrId, qty = "1", durability = "1"] = line.split(",").map((part) => part.trim());
        const item = /^[A-Za-z0-9_./:-]{16,}$/.test(nameOrId) ? { itemId: nameOrId } : { itemName: nameOrId };
        return { ...item, quantity: Number(qty), durability: Number(durability) };
      }),
      xp: sourceActiveKit.xp,
      kits: source.kits
    };
  }
  async function saveStarterConfigDraft(draft: StarterKitConfig, successTitle: string, resultTarget: "package" | "auto" | "create" | "setup" = "package") {
    const setResult = resultTarget === "auto" ? setAutoGrantResult : resultTarget === "create" || resultTarget === "setup" ? setPackageCreateResult : setKitSaveResult;
    setResult({ status: "running", title: resultTarget === "auto" ? "Saving Auto Grant..." : resultTarget === "create" ? "Creating Package..." : "Saving Package..." });
    try {
      const saved = normalizeStarterKitConfig(await starterKitApi.saveConfig(nextConfig(draft), "SAVE STARTER KIT"));
      setConfig(saved);
      const savedActiveKit = starterKitActiveKit(saved);
      setNewAutoRule((current) => ({
        kitId: saved.kits.some((kit) => kit.id === current.kitId) ? current.kitId : saved.autoGrantKitId || savedActiveKit.id,
        grantWhen: current.grantWhen,
        lastSeenDays: current.lastSeenDays
      }));
      setManualKitId((current) => saved.kits.some((kit) => kit.id === current) ? current : savedActiveKit.id);
      setItemsText(savedActiveKit.items.map((item) => `${item.itemId || item.itemName || ""},${item.quantity},${item.durability}`).join("\n"));
      if (!saved.kits.length) setStarterKitTab("create");
      setResult({ status: "succeeded", title: successTitle });
      return saved;
    } catch (error) {
      setResult({ status: "failed", title: resultTarget === "auto" ? "Auto Grant Save Failed." : resultTarget === "create" ? "Package Create Failed." : "Package Save Failed.", message: formatStarterKitError(error instanceof Error ? error.message : String(error)) });
      throw error;
    }
  }
  function setActiveKitId(nextId: string) {
    const nextKit = config.kits.find((kit) => kit.id === nextId) || config.kits[0];
    if (!nextKit) return;
    setConfig({ ...config, activeKitId: nextKit.id, version: nextKit.id, items: nextKit.items, xp: nextKit.xp });
    setManualKitId(nextKit.id);
    setItemsText(nextKit.items.map((entry) => `${entry.itemId || entry.itemName || ""},${entry.quantity},${entry.durability}`).join("\n"));
    setEditingStarterIndex(null);
  }
  function updateActiveKit(patch: Partial<StarterKitEntry>) {
    const nextKits = config.kits.map((kit) => kit.id === activeKit.id ? { ...kit, ...patch } : kit);
    const nextActive = nextKits.find((kit) => kit.id === activeKit.id) || nextKits[0];
    setConfig({ ...config, kits: nextKits, activeKitId: nextActive.id, version: nextActive.id, items: nextActive.items, xp: nextActive.xp });
  }
  function addStarterKit() {
    const name = newKitName.trim();
    if (!name) {
      setPackageCreateResult({ status: "failed", title: "Package Create Failed.", message: "Package name is required." });
      return;
    }
    const nextIndex = config.kits.length + 1;
    const id = uniqueStarterKitId(config.kits, name || `starter-kit-${nextIndex}`);
    const nextKit = { id, name, items: [], xp: 0, welcomeMessage: "" };
    const draft = { ...config, kits: [...config.kits, nextKit], activeKitId: id, version: id, items: [], xp: 0 };
    run(async () => {
      await saveStarterConfigDraft(draft, "Package was created.", "create");
      setNewKitName("");
      setStarterKitTab("configure");
      setEditingStarterIndex(null);
      setSelectedStarterItem(null);
      setStarterDraft({ itemName: "", itemId: "", quantity: "1", durability: "1" });
    });
  }
  function deleteActiveKit() {
    const attachedRule = config.autoGrantRules.find((rule) => rule.kitId === activeKit.id);
    if (attachedRule) {
      setPackageCreateResult({ status: "failed", title: "Package Delete Failed.", message: "Delete the Auto Grant rule first." });
      return;
    }
    if (!window.confirm(`Delete ${activeKit.name || "this package"}?`)) return;
    const nextKits = config.kits.filter((kit) => kit.id !== activeKit.id);
    const nextActive = nextKits.at(-1);
    const autoGrantRules = config.autoGrantRules.filter((rule) => nextKits.some((kit) => kit.id === rule.kitId));
    const draft = {
      ...config,
      kits: nextKits,
      activeKitId: nextActive?.id || "",
      autoGrantKitId: nextKits.some((kit) => kit.id === config.autoGrantKitId) ? config.autoGrantKitId : nextActive?.id || "",
      version: nextActive?.id || "",
      items: nextActive?.items || [],
      xp: nextActive?.xp || 0,
      autoGrantRules
    };
    run(async () => {
      await saveStarterConfigDraft(draft, "Package was deleted.", "setup");
      setEditingStarterIndex(null);
      setEligibleByRule({});
      if (!nextKits.length) setStarterKitTab("create");
    });
  }
  function addAutoGrantRule() {
    const kitId = config.kits.some((kit) => kit.id === newAutoRule.kitId) ? newAutoRule.kitId : activeKit.id;
    const id = uniqueStarterRuleId(config.autoGrantRules, `auto-rule-${config.autoGrantRules.length + 1}`);
    const draft = { ...config, autoGrantEnabled: true, autoGrantRules: [...config.autoGrantRules, { id, enabled: false, kitId, grantWhen: newAutoRule.grantWhen, lastSeenDays: newAutoRule.lastSeenDays }] };
    run(async () => { await saveStarterConfigDraft(draft, "Auto grant rule was created.", "auto"); });
  }
  function updateAutoGrantRule(id: string, patch: Partial<StarterKitAutoGrantRule>) {
    const currentRule = config.autoGrantRules.find((rule) => rule.id === id);
    const nextEnabled = typeof patch.enabled === "boolean" ? patch.enabled : currentRule?.enabled;
    const resultTitle = typeof patch.enabled === "boolean"
      ? `${starterKitRuleName(currentRule, config.kits)} was ${patch.enabled ? "enabled" : "disabled"}.`
      : "Auto grant rule was saved.";
    const draft = { ...config, autoGrantEnabled: patch.enabled === true ? true : config.autoGrantEnabled, autoGrantRules: config.autoGrantRules.map((rule) => rule.id === id ? { ...rule, ...patch } : rule) };
    run(async () => {
      await saveStarterConfigDraft(draft, resultTitle, "auto");
      if (typeof nextEnabled === "boolean") setAutoGrantResult({ status: nextEnabled ? "succeeded" : "failed", title: resultTitle });
    });
  }
  function deleteAutoGrantRule(id: string) {
    if (!window.confirm("Delete this Auto Grant rule?")) return;
    const draft = { ...config, autoGrantRules: config.autoGrantRules.filter((rule) => rule.id !== id) };
    run(async () => {
      await saveStarterConfigDraft(draft, "Auto grant rule was deleted.", "auto");
      setEligibleByRule((current) => {
        const { [id]: _removed, ...rest } = current;
        void _removed;
        return rest;
      });
      setExpandedRuleIds((current) => {
        const { [id]: _removed, ...rest } = current;
        void _removed;
        return rest;
      });
    });
  }
  function toggleRuleEligible(ruleId: string) {
    const nextOpen = !expandedRuleIds[ruleId];
    setExpandedRuleIds({ ...expandedRuleIds, [ruleId]: nextOpen });
    if (!nextOpen || eligibleByRule[ruleId]) return;
    run(async () => {
      const result = await starterKitApi.eligible(ruleId);
      setEligibleByRule((current) => ({ ...current, [ruleId]: result.rows || [] }));
    });
  }
  function chooseStarterItem(item: CatalogItem | null) {
    setSelectedStarterItem(item);
    setStarterDraft({ ...starterDraft, itemName: item?.name || "", itemId: item?.id || "" });
  }
  function addStarterItem() {
    const item = starterDraft.itemId ? { itemId: starterDraft.itemId, itemName: starterDraft.itemName, image: selectedStarterItem?.image } : { itemName: starterDraft.itemName, image: selectedStarterItem?.image };
    if (!starterDraft.itemName && !starterDraft.itemId) return;
    const nextItems = [...(activeKit.items || []), { ...item, quantity: Number(starterDraft.quantity), durability: Number(starterDraft.durability) }];
    updateActiveKit({ items: nextItems });
    setItemsText(nextItems.map((entry) => `${entry.itemId || entry.itemName || ""},${entry.quantity},${entry.durability}`).join("\n"));
  }
  function editStarterItem(index: number) {
    const item = activeKit.items?.[index];
    if (!item) return;
    setEditingStarterIndex(index);
    setStarterEditDraft({ quantity: String(item.quantity ?? 1), durability: String(item.durability ?? 1) });
  }
  function saveStarterItemEdit(index: number) {
    const nextItems = (activeKit.items || []).map((item, itemIndex) => itemIndex === index ? { ...item, quantity: Number(starterEditDraft.quantity), durability: Number(starterEditDraft.durability) } : item);
    updateActiveKit({ items: nextItems });
    setItemsText(nextItems.map((entry) => `${entry.itemId || entry.itemName || ""},${entry.quantity},${entry.durability}`).join("\n"));
    setEditingStarterIndex(null);
  }
  const activeKit = starterKitActiveKit(config);
  const manualKit = config.kits.find((kit) => kit.id === manualKitId) || activeKit;
  const starterItemCount = activeKit.items?.length || 0;
  const selected = players.find((player) => String(player.actor_id || player.player_pawn_id || "") === selectedPlayer) || null;
  const grantPlayerId = manualPlayerId.trim() || String(selected?.action_player_id || "");
  const selectedLabel = selected ? `${selected.character_name || "Unknown"} (${selected.online_status || "unknown"}) - actor ${selected.actor_id || "-"} - admin ${selected.action_player_id || "-"}` : "";
  const historyRows = starterKitHistoryRows(history).slice(0, 10);
  return <section className="panel">
    <div className="panel-title"><h2>Care Package</h2></div>
    <div className="action-sections">
      <section className="action-section">
        <div className="panel-title">
          <h4>Care Package Configuration</h4>
          <button className={`starter-kit-toggle ${config.enabled ? "enabled" : "disabled"}`} onClick={() => run(async () => {
            const confirmation = config.enabled ? "DISABLE STARTER KIT" : "ENABLE STARTER KIT";
            const message = config.enabled ? "Disable Care Package?" : "Enable Care Package?";
            if (window.confirm(message)) setConfig(normalizeStarterKitConfig(await starterKitApi[config.enabled ? "disable" : "enable"](confirmation)));
          })}>Care Package: {config.enabled ? "On" : "Off"}</button>
        </div>
        <div className="settings-tabs" role="tablist" aria-label="Care Package setup">
          <button className={starterKitTab === "create" ? "active" : ""} role="tab" aria-selected={starterKitTab === "create"} onClick={() => setStarterKitTab("create")}>Create</button>
          <button className={starterKitTab === "configure" ? "active" : ""} role="tab" aria-selected={starterKitTab === "configure"} disabled={!config.kits.length} onClick={() => setStarterKitTab("configure")}>Configure</button>
          {packageCreateResult && <span className={`inline-task-result result-${packageCreateResult.status === "succeeded" ? "ok" : packageCreateResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={packageCreateResult.status === "running" ? "loading-dots" : ""}>{packageCreateResult.title}</strong>
            {packageCreateResult.message && <span className="inline-task-message">{packageCreateResult.message}</span>}
          </span>}
        </div>
        {starterKitTab === "create" ? <div className="starter-kit-builder starter-kit-create">
          <label className="starter-kit-new-field">New Package Name<input value={newKitName} onChange={(event) => setNewKitName(event.target.value)} placeholder="New package" /></label>
          <button onClick={addStarterKit}>Add Package</button>
        </div> : <>
        <div className="starter-kit-builder">
          <label className="compact-select">Select Package<select value={activeKit.id} onChange={(event) => setActiveKitId(event.target.value)}>{config.kits.map((kit) => <option key={kit.id} value={kit.id}>{kit.name || "Name Required"}</option>)}</select></label>
          <button className="danger" onClick={deleteActiveKit}>Delete Package</button>
        </div>
        <label className="starter-kit-name-field">Package Name<input value={activeKit.name} onChange={(event) => updateActiveKit({ name: event.target.value })} placeholder="Enter package name" /></label>
        <div className="starter-xp-row">
          <span>Grant</span>
          <input type="number" min="0" value={String(activeKit.xp)} onChange={(event) => updateActiveKit({ xp: Number(event.target.value) })} />
          <span>XP</span>
        </div>
        <label className="starter-welcome-field">Send Message<textarea value={activeKit.welcomeMessage || ""} onChange={(event) => updateActiveKit({ welcomeMessage: event.target.value })} placeholder="Optional private whisper after this package is granted" /></label>
        <div className={`starter-items-toggle-panel ${starterItemsOpen ? "open" : ""}`}>
          <div className="starter-items-toggle-row">
            <h4>Starter Items</h4>
            <button className={`icon-toggle-button ${starterItemsOpen ? "active" : ""}`} aria-label={starterItemsOpen ? "Collapse Starter Items" : "Expand Starter Items"} title={starterItemsOpen ? "Collapse" : "Expand"} onClick={() => setStarterItemsOpen(!starterItemsOpen)}>{starterItemsOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button>
          </div>
          {starterItemsOpen && <div className="starter-items-picker-panel">
            <ItemCatalogSelector selected={selectedStarterItem} onSelect={chooseStarterItem} />
            <div className="action-line">
              <label>Quantity<input type="number" min="1" value={starterDraft.quantity} onChange={(event) => setStarterDraft({ ...starterDraft, quantity: event.target.value })} /></label>
              <label>Durability / Quality<input type="number" min="0" value={starterDraft.durability} onChange={(event) => setStarterDraft({ ...starterDraft, durability: event.target.value })} /></label>
              <button disabled={!selectedStarterItem} onClick={addStarterItem}>Add Item</button>
            </div>
          </div>}
        </div>
        {activeKit.items?.length ? <div className="table-wrap starter-items-table"><table><thead><tr><th>Preview</th><th>Item Name</th><th>Item ID</th><th>Quantity</th><th>Durability</th><th>Actions</th></tr></thead><tbody>{activeKit.items.map((item, index) => {
          const editing = editingStarterIndex === index;
          return <tr key={`${item.itemName || item.itemId}-${index}`}><td><StarterItemPreview item={item} /></td><td>{starterItemName(item)}</td><td>{starterItemId(item)}</td><td>{editing ? <input className="starter-item-quantity-input" type="number" min="1" value={starterEditDraft.quantity} onChange={(event) => setStarterEditDraft({ ...starterEditDraft, quantity: event.target.value })} /> : item.quantity}</td><td>{editing ? <input className="starter-item-durability-input" type="number" min="0" value={starterEditDraft.durability} onChange={(event) => setStarterEditDraft({ ...starterEditDraft, durability: event.target.value })} /> : item.durability}</td><td className="starter-actions-cell"><div className="service-actions">{editing ? <><button onClick={() => saveStarterItemEdit(index)}>Save</button><button onClick={() => setEditingStarterIndex(null)}>Cancel</button></> : <button onClick={() => editStarterItem(index)}>Edit</button>}<button className="danger" onClick={() => {
          const nextItems = activeKit.items.filter((_, itemIndex) => itemIndex !== index);
          updateActiveKit({ items: nextItems });
          setItemsText(nextItems.map((entry) => `${entry.itemId || entry.itemName || ""},${entry.quantity},${entry.durability}`).join("\n"));
          if (editingStarterIndex === index) setEditingStarterIndex(null);
        }}>Remove</button></div></td></tr>;
        })}</tbody></table></div> : null}
        <details className="technical-details"><summary>Developer raw starter item textarea</summary><p>One item per line: item name or raw item ID, quantity, durability.</p><label>Starter Items<textarea value={itemsText} onChange={(event) => setItemsText(event.target.value)} placeholder="Plant Fiber,10,1&#10;cup of water,1,1" /></label></details>
        <div className="action-line">
          <button onClick={() => run(async () => {
            if (!window.confirm("Save Care Package?")) return;
            if (selectedStarterItem && !activeKit.items.some((item) => (item.itemId && item.itemId === starterDraft.itemId) || (item.itemName && item.itemName === starterDraft.itemName))) {
              setKitSaveResult({ status: "failed", title: "Package Save Failed.", message: "Click Add Item before saving the package." });
              return;
            }
            setKitSaveResult({ status: "running", title: "Saving Package..." });
            try {
              const saved = normalizeStarterKitConfig(await starterKitApi.saveConfig(nextConfig(), "SAVE STARTER KIT"));
              setConfig(saved);
              const savedActiveKit = starterKitActiveKit(saved);
              setItemsText(savedActiveKit.items.map((item) => `${item.itemId || item.itemName || ""},${item.quantity},${item.durability}`).join("\n"));
              setKitSaveResult({ status: "succeeded", title: "Package was saved successfully." });
            } catch (error) {
              setKitSaveResult({ status: "failed", title: "Package Save Failed.", message: formatStarterKitError(error instanceof Error ? error.message : String(error)) });
            }
          })}>Save Package</button>
          {kitSaveResult && <span className={`inline-task-result result-${kitSaveResult.status === "succeeded" ? "ok" : kitSaveResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={kitSaveResult.status === "running" ? "loading-dots" : ""}>{kitSaveResult.title}</strong>
            {kitSaveResult.message && <span className="inline-task-message">{kitSaveResult.message}</span>}
          </span>}
        </div>
        </>}
      </section>

      <section className="action-section">
        <div className="starter-grant-header">
          <div className="settings-tabs" role="tablist" aria-label="Care Package grants">
            <button className={starterGrantTab === "auto" ? "active" : ""} role="tab" aria-selected={starterGrantTab === "auto"} onClick={() => setStarterGrantTab("auto")}>Auto Grant</button>
            <button className={starterGrantTab === "manual" ? "active" : ""} role="tab" aria-selected={starterGrantTab === "manual"} onClick={() => setStarterGrantTab("manual")}>Manual Grant</button>
          </div>
          {autoGrantResult && <span className={`inline-task-result result-${autoGrantResult.status === "succeeded" ? "ok" : autoGrantResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={autoGrantResult.status === "running" ? "loading-dots" : ""}>{autoGrantResult.title}</strong>
            {autoGrantResult.message && <span className="inline-task-message">{autoGrantResult.message}</span>}
          </span>}
        </div>
        {starterGrantTab === "auto" ? <>
          <div className="action-line starter-auto-line">
            <label className="compact-field">Interval Seconds<input type="number" min="60" max="3600" value={String(config.autoGrantIntervalSeconds)} onChange={(event) => setConfig({ ...config, autoGrantIntervalSeconds: Number(event.target.value) })} /></label>
            <label className="compact-select">Package<select value={newAutoRule.kitId} onChange={(event) => setNewAutoRule({ ...newAutoRule, kitId: event.target.value })}>{config.kits.map((kit) => <option key={kit.id} value={kit.id}>{kit.name || "Name Required"}</option>)}</select></label>
            <label className="compact-select">Grant When<select value={newAutoRule.grantWhen} onChange={(event) => setNewAutoRule({ ...newAutoRule, grantWhen: event.target.value as StarterKitAutoGrantRule["grantWhen"] })}><option value="first_online">First Online</option><option value="last_seen">Last Seen</option></select></label>
            {newAutoRule.grantWhen === "last_seen" && <label className="compact-field">Days Ago<input type="number" min="1" max="3650" value={String(newAutoRule.lastSeenDays)} onChange={(event) => setNewAutoRule({ ...newAutoRule, lastSeenDays: Number(event.target.value) })} /></label>}
            <button disabled={!config.kits.length} onClick={addAutoGrantRule}>Create Rule</button>
          </div>
          <div className="starter-auto-rules">
            {config.autoGrantRules.map((rule) => {
              const kit = config.kits.find((entry) => entry.id === rule.kitId);
              const ruleEligible = eligibleByRule[rule.id] || [];
              const expanded = Boolean(expandedRuleIds[rule.id]);
              return <article className="starter-auto-rule" key={rule.id}>
                <button className={`starter-rule-toggle ${rule.enabled ? "enabled" : "disabled"}`} onClick={() => updateAutoGrantRule(rule.id, { enabled: !rule.enabled })}>{rule.enabled ? "Enabled" : "Disabled"}</button>
                <span className="starter-rule-summary">Grants {starterKitGrantSummary(kit)} based on {starterKitConditionLabel(rule)}</span>
            <button className="icon-toggle-button danger starter-rule-delete" aria-label="Delete Auto Grant rule" title="Delete" onClick={() => deleteAutoGrantRule(rule.id)}><X size={18} /></button>
                <button className={`icon-toggle-button ${expanded ? "active" : ""}`} aria-label={expanded ? "Collapse Eligibility" : "Expand Eligibility"} title={expanded ? "Collapse" : "Expand"} onClick={() => toggleRuleEligible(rule.id)}>{expanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button>
                {expanded && <div className="starter-rule-eligible"><h5>Eligibility</h5>{ruleEligible.length ? <DataTable rows={starterKitEligibleRows(ruleEligible)} /> : <div className="empty starter-history-empty">No eligible players for this rule right now.</div>}</div>}
              </article>;
            })}
          </div>
        </> : <>
          <div className="action-line">
            <label className="compact-select">Package<select value={manualKit.id} onChange={(event) => setManualKitId(event.target.value)}>{config.kits.map((kit) => <option key={kit.id} value={kit.id}>{kit.name || "Name Required"}</option>)}</select></label>
            <label className="wide-field">Player<select value={selectedPlayer} onChange={(event) => setSelectedPlayer(event.target.value)}>
              <option value="">Select player</option>
              {players.map((player) => <option key={String(player.actor_id || player.player_pawn_id || player.action_player_id)} value={String(player.actor_id || player.player_pawn_id || "")}>
                {String(player.character_name || "Unknown")} - {String(player.online_status || "unknown")} - actor {String(player.actor_id || "-")} - admin {String(player.action_player_id || "missing")}
              </option>)}
            </select></label>
            <button disabled={!grantPlayerId || !manualKit.id} onClick={() => run(async () => { if (window.confirm(`Grant ${manualKit.name} to ${selectedLabel || grantPlayerId}?`)) showGrantResult("grant", await starterKitApi.grant(grantPlayerId, "GRANT STARTER KIT", manualKit.id)); })}>Grant Package</button>
          </div>
          {selected && !selected.action_player_id && <p className="danger-note">Selected player has no Admin action ID, so CLI-backed grants are disabled.</p>}
          <details className="technical-details">
            <summary>Advanced manual player ID override</summary>
            <label>Admin action ID<input value={manualPlayerId} onChange={(event) => setManualPlayerId(event.target.value)} placeholder="RedBlink#75570" /></label>
          </details>
          <StarterKitResult output={outputScope === "grant" ? output : ""} technicalOutput={outputScope === "grant" ? technicalOutput : ""} />
        </>}
      </section>

      <section className="action-section">
        <div className="panel-title">
          <h4>Grant History</h4>
          <button onClick={() => run(async () => setHistory((await starterKitApi.history()).rows || []))}>Refresh</button>
        </div>
        <StarterKitResult output={outputScope === "history" ? output : ""} technicalOutput={outputScope === "history" ? technicalOutput : ""} />
        <div className="starter-history-table">
          {historyRows.length ? <DataTable rows={historyRows} columns={["timestamp", "character_name", "action_player_id", "source", "status", "summary"]} action={(row) => String(row.status || "").toLowerCase() === "failed" ? <button onClick={() => run(async () => { if (window.confirm(`Retry Care Package grant ${row.id}?`)) showGrantResult("history", await starterKitApi.retry(String(row.id), "RETRY STARTER KIT")); })}>Retry</button> : null} /> : <div className="empty starter-history-empty">Grant history is clear. Care Package grants will appear here after they run.</div>}
        </div>
      </section>
    </div>
    <details className="technical-details">
      <summary>Raw Care Package JSON</summary>
      <pre className="mini-output">{JSON.stringify(displayStarterKitConfig(config), null, 2)}</pre>
    </details>
  </section>;

  function showGrantResult(scope: "grant" | "auto" | "history", result: Record<string, unknown>) {
    setOutputScope(scope);
    setOutput(formatStarterKitGrantResult(result));
    setTechnicalOutput(JSON.stringify(result, null, 2));
  }
}

function AddonsPanel() {
  return <section className="panel">
    <div className="panel-title"><h2>Addons</h2></div>
    <section className="action-section info-panel">
      <h4>Something is stirring beneath the sand.</h4>
      <p>The next layer of Arrakis is not ready to reveal itself yet. Future updates will unlock new ways to extend, shape, and command your server.</p>
    </section>
  </section>;
}

function normalizeStarterKitConfig(config: StarterKitConfig): StarterKitConfig {
  const fallbackKit: StarterKitEntry = { id: config.version || "starter-kit-v1", name: "Care Package", items: config.items || [], xp: Number(config.xp) || 0, welcomeMessage: "" };
  const kits = (Array.isArray(config.kits) ? config.kits : [fallbackKit]).map((kit, index) => ({
    id: kit.id || `starter-kit-${index + 1}`,
    name: typeof kit.name === "string" ? kit.name : (index === 0 ? "Care Package" : `Care Package ${index + 1}`),
    items: kit.items || [],
    xp: Number(kit.xp) || 0,
    welcomeMessage: normalizeCarePackageWelcomeMessage(kit.welcomeMessage)
  }));
  const activeKitId = kits.some((kit) => kit.id === config.activeKitId) ? config.activeKitId : kits[0]?.id || "";
  const autoGrantKitId = kits.some((kit) => kit.id === config.autoGrantKitId) ? config.autoGrantKitId : activeKitId;
  const activeKit = kits.find((kit) => kit.id === activeKitId) || kits[0] || { id: "", name: "", items: [], xp: 0, welcomeMessage: "" };
  const autoGrantRules = (kits.length ? (Array.isArray(config.autoGrantRules) ? config.autoGrantRules : [{ id: "auto-rule-1", enabled: true, kitId: autoGrantKitId, grantWhen: "first_online" as const, lastSeenDays: 30 }]) : []).map((rule, index) => ({
    id: rule.id || `auto-rule-${index + 1}`,
    enabled: rule.enabled !== false,
    kitId: kits.some((kit) => kit.id === rule.kitId) ? rule.kitId : autoGrantKitId,
    grantWhen: rule.grantWhen === "last_seen" || String(rule.grantWhen) === "first_seen" ? "last_seen" as const : "first_online" as const,
    lastSeenDays: Number(rule.lastSeenDays) || 30
  }));
  const grantWhen = config.grantWhen === "last_seen" || String(config.grantWhen) === "first_seen" ? "last_seen" : "first_online";
  return { ...config, version: activeKit.id, activeKitId, autoGrantKitId, kits, items: activeKit.items, xp: activeKit.xp, allowRepeatGrants: false, grantWhen, autoGrantRules };
}

function normalizeCarePackageWelcomeMessage(value: unknown) {
  const text = typeof value === "string" ? value : "";
  return text.trim() === "Welcome to the server" ? "" : text;
}

function displayStarterKitConfig(config: StarterKitConfig) {
  const { version, allowRepeatGrants, ...visible } = config;
  void version;
  void allowRepeatGrants;
  return visible;
}

function formatStarterKitError(value: string) {
  const text = String(value || "").trim()
    .replaceAll("Starter Kit", "Care Package")
    .replaceAll("starter kit", "care package")
    .replaceAll(" kit", " package")
    .replaceAll(" Kit", " Package");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Care Package save failed.";
}

function starterKitActiveKit(config: StarterKitConfig) {
  return config.kits.find((kit) => kit.id === config.activeKitId) || config.kits[0] || { id: "", name: "", items: [], xp: 0 };
}

function starterKitGrantSummary(kit?: StarterKitEntry) {
  if (!kit) return "Unknown Package";
  const parts = [];
  if (kit.xp) parts.push(`${kit.xp} XP`);
  if (kit.items?.length) parts.push(`${kit.items.length} item${kit.items.length === 1 ? "" : "s"}`);
  return `${kit.name || "Name Required"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function starterKitRuleName(rule: StarterKitAutoGrantRule | undefined, kits: StarterKitEntry[]) {
  const kit = kits.find((entry) => entry.id === rule?.kitId);
  return kit?.name ? `${kit.name} rule` : "Auto Grant rule";
}

function starterKitConditionLabel(rule: StarterKitAutoGrantRule) {
  if (rule.grantWhen === "last_seen") return `Last Seen ${Number(rule.lastSeenDays) || 30} Days Ago`;
  return "First Online";
}

function uniqueStarterKitId(kits: StarterKitEntry[], base: string) {
  const normalized = base.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || "starter-kit";
  let id = normalized;
  let index = 2;
  while (kits.some((kit) => kit.id === id)) {
    id = `${normalized}-${index}`;
    index += 1;
  }
  return id;
}

function uniqueStarterRuleId(rules: StarterKitAutoGrantRule[], base: string) {
  const normalized = base.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || "auto-rule";
  let id = normalized;
  let index = 2;
  while (rules.some((rule) => rule.id === id)) {
    id = `${normalized}-${index}`;
    index += 1;
  }
  return id;
}

function starterKitEligibleRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({
    character_name: row.character_name || "Unknown",
    online_status: row.online_status || "",
    eligible: row.eligible ? "True" : "False",
    reason: row.reason || "",
    action_player_id: row.action_player_id || "",
    actor_id: row.actor_id || ""
  }));
}

function starterKitHistoryRows(rows: Record<string, unknown>[]) {
  return rows.map((row) => ({
    ...row,
    timestamp: String(row.local_timestamp || row.timestamp || ""),
    character_name: titleCaseWords(String(row.character_name || "Unknown")),
    source: titleCaseWords(String(row.source || "")),
    status: titleCaseWords(String(row.status || "")),
    summary: titleCaseWords(String(row.summary || ""))
  }));
}

function StarterKitResult({ output, technicalOutput }: { output: string; technicalOutput: string }) {
  if (!output) return null;
  const rows = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return <div className="result-panel starter-result">
    <strong>Care Package Result</strong>
    <ul className="result-list">
      {rows.map((line, index) => {
        const status = /^OK:/i.test(line) ? "ok" : /^FAIL:/i.test(line) || /failed/i.test(line) ? "fail" : "info";
        return <li className={`result-row result-${status}`} key={`${line}-${index}`}>{friendlyStarterKitResultLine(line)}</li>;
      })}
    </ul>
    {technicalOutput && <TechnicalDetails text={technicalOutput} />}
  </div>;
}

function friendlyStarterKitResultLine(line: string) {
  return line
    .replace(/^OK:\s*/i, "Granted ")
    .replace(/^FAIL:\s*/i, "Failed ")
    .replace(/\s+granted$/i, "")
    .replace(/\s+failed:/i, ":")
    .replace(/\s+/g, " ")
    .trim();
}

function ItemCatalogSelector({ label = "Select Item", selected, onSelect, placeholder = "Filter loaded item catalog" }: { label?: string; selected: CatalogItem | null; onSelect: (item: CatalogItem | null) => void; placeholder?: string }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState("all");
  async function load() {
    setLoading(true);
    try {
      const result = await adminApi.itemCatalog("", 10000);
      setItems((result.rows || []).map((item) => ({ ...item, id: item.itemId || item.id })));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load().catch(() => undefined);
  }, []);
  const categoryCounts = items.reduce<Record<string, number>>((counts, item) => {
    const key = item.category || "uncategorized";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const categories = ["all", ...Object.keys(categoryCounts).sort()];
  const filteredItems = items.filter((item) => {
    const matchesCategory = category === "all" || item.category === category;
    const haystack = `${item.name} ${item.id} ${item.category || ""} ${item.source || ""}`.toLowerCase();
    return matchesCategory && (!query.trim() || haystack.includes(query.trim().toLowerCase()));
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id, undefined, { sensitivity: "base" }));
  return <div className="catalog-selector">
    <div className="catalog-filter-row">
      <label className="compact-select catalog-category-select">Choose Category
        <select value={category} onChange={(event) => { setCategory(event.target.value); onSelect(null); }}>
          {categories.map((option) => <option key={option} value={option}>{option === "all" ? `All Categories (${items.length})` : `${titleCase(option)} (${categoryCounts[option] || 0})`}</option>)}
        </select>
      </label>
      <input className="catalog-filter-input" aria-label="Filter Items" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} />
    </div>
    <div className="catalog-item-picker" aria-label={label}>
      {loading ? <div className="catalog-loading">Loading Items...</div> : filteredItems.map((item) => {
        const active = selected?.id === item.id && selected?.name === item.name;
        return <button type="button" className={`catalog-item-option ${active ? "active" : ""}`} key={`${item.id}-${item.name}-${item.source}`} onClick={() => onSelect(item)}>
          <CatalogItemThumb item={item} />
          <span>
            <strong>{item.name}</strong>
            <small>{item.id}{item.category ? ` - ${titleCase(item.category)}` : ""}</small>
          </span>
        </button>;
      })}
      {!loading && !filteredItems.length && <div className="catalog-empty">No items match your filters.</div>}
    </div>
    {selected && <div className="catalog-selected-item">
      <CatalogItemThumb item={selected} large />
      <KeyValueGrid items={[["Item Name", selected.name], ["Item ID", selected.id], ["Category", selected.category ? titleCase(selected.category) : ""], ["Source", selected.source || ""]]} />
    </div>}
  </div>;
}

function CatalogItemThumb({ item, large = false, small = false }: { item: CatalogItem; large?: boolean; small?: boolean }) {
  const fallback = "/images/items/image-unavailable.png";
  const src = item.image || `/images/items/${encodeURIComponent(item.itemId || item.id)}.png`;
  const [imageSrc, setImageSrc] = useState(src);
  useEffect(() => {
    setImageSrc(src);
  }, [src]);
  return <div className={large ? "catalog-item-preview large" : small ? "catalog-item-preview small" : "catalog-item-preview"}>
    <img src={imageSrc} alt="" onError={() => { if (imageSrc !== fallback) setImageSrc(fallback); }} />
  </div>;
}

function formatStarterKitGrantResult(result: Record<string, unknown>) {
  if (Array.isArray(result.results) && result.results.some((row) => row && typeof row === "object" && "status" in row)) {
    const rows = result.results as Record<string, unknown>[];
    const lines = [
      `Care Package bulk grant finished: ${result.granted || 0} granted, ${result.skipped || 0} skipped, ${result.failed || 0} failed.`
    ];
    rows.slice(0, 20).forEach((row) => {
      const name = row.character_name || row.action_player_id || row.playerId || "Unknown player";
      lines.push(`${String(row.status || "unknown").toUpperCase()}: ${name} - ${row.summary || row.reason || ""}`);
    });
    return lines.join("\n");
  }
  const status = String(result.status || (result.ok ? "granted" : "failed"));
  const lines: string[] = [];
  if (Array.isArray(result.results)) {
    for (const action of result.results as Record<string, unknown>[]) {
      if (action.ok) lines.push(`OK: ${describeStarterKitAction(action)}`);
      else lines.push(`FAIL: to grant ${describeStarterKitAction(action)}`);
    }
  }
  if (!lines.length) {
    if (status === "skipped") lines.push(`FAIL: ${result.reason || "grant was skipped"}`);
    else lines.push(`FAIL: ${result.summary || "grant failed"}`);
  }
  return lines.join("\n");
}

function describeStarterKitAction(action: Record<string, unknown>) {
  const item = action.item as Record<string, unknown> | undefined;
  if (item) return `${item.itemName || item.itemId || "Item"} x${item.quantity || 1}`;
  if (action.operation === "adminAddXp") return `${action.amount || 0} XP`;
  return String(action.operation || "Care Package action");
}

function starterItemName(item: { itemName?: string; itemId?: string }) {
  if (item.itemName) return item.itemName;
  if (item.itemId) return friendlyCatalogName(item.itemId);
  return "Unknown";
}

function StarterItemPreview({ item }: { item: { itemId?: string; image?: string } }) {
  const catalogItem = { id: item.itemId || "", name: item.itemId || "Item", image: item.image } as CatalogItem;
  return <CatalogItemThumb item={catalogItem} small />;
}

function starterItemId(item: { itemId?: string }) {
  return item.itemId || "Resolved on grant";
}

function StoragePanel({ onError }: { onError: (text: string) => void }) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null);
  const [items, setItems] = useState<Record<string, unknown>[]>([]);
  const [itemName, setItemName] = useState("");
  const [canGiveItem, setCanGiveItem] = useState(false);
  const [storageResult, setStorageResult] = useState("Give Item to Storage creates a DB backup first and runs only when the backend verifies the storage schema.");
  async function load() {
    onError("");
    try {
      const result = await worldDataApi.storage();
      setRows(result.rows || []);
      setCanGiveItem(Boolean(result.capabilities?.storageGiveItem));
      if (!result.capabilities?.storageGiveItem) setStorageResult("Storage give-item is unsupported until this database exposes compatible dune.inventories and dune.items insert columns.");
    } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  async function open(row: Record<string, unknown>) {
    setSelected(row);
    setItems((await worldDataApi.storageItems(String(row.id))).rows || []);
  }
  async function giveStorageItem() {
    if (!selected) return;
    onError("");
    try {
      if (!window.confirm(`Give 1 x ${itemName} to storage ${String(selected.id)}? A database backup will be created first.`)) return;
      const response = await worldDataApi.storageGiveItem(String(selected.id), { itemName, quantity: 1, confirmation: "GIVE ITEM TO STORAGE" });
      setStorageResult(formatMutationResult(response));
      setItems((await worldDataApi.storageItems(String(selected.id))).rows || []);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      setStorageResult(text);
      onError(text);
    }
  }
  useEffect(() => {
    load();
  }, []);
  return <section className="panel"><div className="panel-title"><h2>Storage</h2><button onClick={load}>Refresh Storage</button></div><p className="danger-note">{storageResult}</p><DataTable rows={rows} onRowClick={open} />{selected && <section className="drawer"><h3>Storage {String(selected.id)}</h3><div className="action-row"><a className="button-link" href={worldDataApi.storageExportUrl(String(selected.id))}>Export JSON</a><input value={itemName} onChange={(event) => setItemName(event.target.value)} placeholder="Item name" /><button disabled={!canGiveItem} onClick={giveStorageItem}>Give Item to Storage</button></div><DataTable rows={items} /></section>}</section>;
}

function BackupsPanel({ backupRestoreTask, setBackupRestoreTask, onError }: { backupRestoreTask: Task | null; setBackupRestoreTask: (task: Task | null) => void; onError: (text: string) => void }) {
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(true);
  const [autoBackup, setAutoBackup] = useState<{ stdout?: string; stderr?: string; exitCode?: number } | null>(null);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoTime, setAutoTime] = useState("05:00");
  const [autoRetentionDays, setAutoRetentionDays] = useState("0");
  const [backupResult, setBackupResult] = useState<BackupResult | null>(null);
  const [autoResult, setAutoResult] = useState<BackupResult | null>(null);
  const [importResult, setImportResult] = useState<BackupResult | null>(null);
  const [importBackupFile, setImportBackupFile] = useState<File | null>(null);
  const [importMetadataFile, setImportMetadataFile] = useState<File | null>(null);
  const importBackupInputRef = useRef<HTMLInputElement | null>(null);
  const importMetadataInputRef = useRef<HTMLInputElement | null>(null);
  const backupsRefreshRef = useRef<Promise<void> | null>(null);
  const [busyAction, setBusyAction] = useState("");
  const autoStatus = (autoBackup as { status?: Record<string, unknown> } | null)?.status || {};
  const autoTimerValue = String(autoStatus.timer || "");
  const autoTimerActive = autoEnabled && /^(active|enabled)$/i.test(autoTimerValue);
  const autoTimerLabel = commandStatusSummary(autoBackup).reason
    ? "Unavailable"
    : busyAction === "auto" && autoResult?.status === "running"
      ? autoEnabled ? "Activating" : "Deactivating"
      : autoTimerActive ? "Active" : "Inactive";
  async function run(action: () => Promise<void>) {
    onError("");
    try { await action(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  async function refreshAutoBackup() {
    const result = await backupsApi.autoStatus();
    setAutoBackup(result);
    const status = result.status || {};
    setAutoEnabled(Boolean(status.enabled));
    if (status.backupTime) setAutoTime(toHourMinuteTime(status.backupTime));
    if (status.retentionDays !== undefined) setAutoRetentionDays(String(status.retentionDays || "0"));
  }
  async function refresh() {
    if (backupsRefreshRef.current) return backupsRefreshRef.current;
    setBackupsLoading(true);
    backupsRefreshRef.current = (async () => {
      const result = await withTimeout(backupsApi.list(), 60000, "Loading backups timed out.");
      setRows(result.rows?.length ? result.rows : parseBackupRows(result.stdout || ""));
      try {
        await withTimeout(refreshAutoBackup(), 60000, "Loading automatic backup status timed out.");
      } catch (error) {
        setAutoBackup({ exitCode: 1, stderr: error instanceof Error ? error.message : String(error) });
      }
    })().finally(() => {
      backupsRefreshRef.current = null;
      setBackupsLoading(false);
    });
    return backupsRefreshRef.current;
  }
  async function runBackupTask(action: "create" | "delete" | "deleteAll" | "restore" | "auto", taskFactory: () => Promise<{ task: Task }>, successTitle: string, failureTitle: string) {
    setBusyAction(action);
    const setter = action === "auto" ? setAutoResult : setBackupResult;
    setter({ status: "running", title: action === "restore" ? "Restoring Backup..." : action === "delete" || action === "deleteAll" ? "Deleting Backup..." : action === "auto" ? "Saving Automatic Backup Settings..." : "Creating Backup..." });
    try {
      const response = await taskFactory();
      const final = action === "restore" ? await waitForTaskWithUpdates(response.task, setBackupRestoreTask) : await waitForTaskSilently(response.task);
      const result = action === "restore" ? backupRestoreTaskResult(final) : summarizeBackupTask(final, successTitle, failureTitle);
      if (action === "restore" && isTerminalTask(final.status)) setBackupRestoreTask(null);
      setter((final.status === "succeeded" && (action === "delete" || action === "deleteAll")) ? { ...result, tone: "danger" } : result);
      if (final.status === "succeeded") await refresh();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      setter({ status: "failed", title: failureTitle, message: reason });
      onError(reason);
    } finally {
      setBusyAction("");
    }
  }
  async function saveAutomaticBackups() {
    const sanitizedTime = toHourMinuteTime(autoTime);
    if (autoEnabled && !isValidHourMinuteTime(sanitizedTime)) {
      setAutoResult({ status: "failed", title: "Automatic Backup Settings Failed", message: "Daily backup time must be a valid 24-hour time, for example 05:00 or 23:30." });
      return;
    }
    setAutoTime(sanitizedTime);
    await runBackupTask("auto", () => backupsApi.saveAuto({ enabled: autoEnabled, time: sanitizedTime, retentionDays: Number(autoRetentionDays) }), "Automatic Backup Settings Saved", "Automatic Backup Settings Failed");
  }
  async function importExternalBackup() {
    if (!importBackupFile) {
      setImportResult({ status: "failed", title: "Import Failed", message: "Select a .backup file." });
      return;
    }
    if (!importMetadataFile) {
      setImportResult({ status: "failed", title: "Import Failed", message: "Select the matching .backup.yaml file." });
      return;
    }
    if (!/\.backup$/i.test(importBackupFile.name)) {
      setImportResult({ status: "failed", title: "Import Failed", message: "The backup file must end with .backup." });
      return;
    }
    if (!/\.ya?ml$/i.test(importMetadataFile.name)) {
      setImportResult({ status: "failed", title: "Import Failed", message: "The metadata file must end with .yaml or .yml." });
      return;
    }
    setBusyAction("import");
    setImportResult({ status: "running", title: "Importing Backup" });
    try {
      const form = new FormData();
      form.append("backup", importBackupFile);
      form.append("metadata", importMetadataFile);
      const result = await backupsApi.importExternal(form);
      if (result.rows) setRows(result.rows);
      else await refresh();
      setImportResult({ status: "succeeded", title: "Backup Imported Successfully" });
      setImportBackupFile(null);
      setImportMetadataFile(null);
      if (importBackupInputRef.current) importBackupInputRef.current.value = "";
      if (importMetadataInputRef.current) importMetadataInputRef.current.value = "";
    } catch (error) {
      setImportResult({ status: "failed", title: "Import Failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusyAction("");
    }
  }
  useEffect(() => {
    run(refresh);
  }, []);
  useEffect(() => {
    if (!backupResult || backupResult.status === "running" || backupResult.tone === "attention") return;
    const id = window.setTimeout(() => setBackupResult(null), 5400);
    return () => window.clearTimeout(id);
  }, [backupResult?.status, backupResult?.title]);
  useEffect(() => {
    if (!autoResult || autoResult.status === "running") return;
    const id = window.setTimeout(() => setAutoResult(null), 5400);
    return () => window.clearTimeout(id);
  }, [autoResult?.status, autoResult?.title]);
  useEffect(() => {
    if (!importResult || importResult.status === "running") return;
    const id = window.setTimeout(() => setImportResult(null), 5400);
    return () => window.clearTimeout(id);
  }, [importResult?.status, importResult?.title]);
  return (
    <section className="panel">
      <div className="panel-title"><h2>Backups</h2><div className="action-row"><button disabled={Boolean(busyAction)} onClick={() => run(refresh)}>Refresh Backups</button><button disabled={Boolean(busyAction)} onClick={() => run(() => runBackupTask("create", backupsApi.create, "Backup Created Successfully", "Backup failed"))}>Create Backup</button><button className="danger" disabled={Boolean(busyAction) || !rows.length} onClick={() => run(async () => {
        if (!window.confirm("Delete all backup files? This cannot be undone.")) return;
        await runBackupTask("deleteAll", backupsApi.deleteAll, "Backup Deleted", "Backup Delete Failed");
      })}>Delete All Backups</button></div></div>
      {backupRestoreTask ? <BackupResultCard result={backupRestoreTaskResult(backupRestoreTask)} /> : backupResult && <BackupResultCard result={backupResult} />}
      {rows.length ? <DataTable rows={rows} columns={["backupName", "battlegroupId", "created", "type", "source"]} action={(row) => <div className="service-actions">
        <button className="icon-action restore-action" title="Restore" aria-label="Restore backup" disabled={Boolean(busyAction)} onClick={(event) => { event.stopPropagation(); run(async () => {
          const sourceText = /^external$/i.test(String(row.source || "")) ? " External backups automatically use the backup battlegroup ID when it differs from Docker." : "";
          if (!window.confirm(`Restore backup ${String(row.name)}? This replaces the current battlegroup database and is destructive.${sourceText}`)) return;
          await runBackupTask("restore", () => backupsApi.restore(String(row.name)), "Restore Completed", "Backup Restore Failed");
        }); }}><img src="/images/icons/backup-restore.png" alt="" /></button>
        <a className="button-link icon-action download-action" title="Download" aria-label="Download backup" href={backupsApi.downloadUrl(String(row.name))} onClick={(event) => event.stopPropagation()}><img src="/images/icons/backup-download.png" alt="" /></a>
        <button className="icon-action danger" title="Delete" aria-label="Delete backup" disabled={Boolean(busyAction)} onClick={(event) => { event.stopPropagation(); run(async () => {
          if (!window.confirm(`Delete backup ${String(row.name)}? This cannot be undone.`)) return;
          await runBackupTask("delete", () => backupsApi.delete(String(row.name)), "Backup Deleted", "Backup Delete Failed");
        }); }}><img src="/images/icons/backup-delete.png" alt="" /></button>
      </div>} actionClassName="backup-table-actions" tableClassName="backup-table" /> : backupsLoading ? <div className="empty backups-loading">Loading Backups...</div> : <div className="empty backups-empty">No database backups have been created yet.</div>}
      <section className="action-section">
        <div className="panel-title"><h4>Automatic Backups</h4><StatusPill value={autoEnabled ? "Enabled" : "Disabled"} /></div>
        <KeyValueGrid items={[
          ["Current Status", commandStatusSummary(autoBackup).reason ? "Unavailable" : autoEnabled ? "Enabled" : "Disabled"],
          ["Backup Time (Local Server Time)", toHourMinuteTime(autoStatus.backupTime || autoTime)],
          ["Retention", autoStatus.retentionLabel || "No Retention Limit"],
          ["Timer", autoTimerLabel],
          ["Last Run", autoStatus.lastRun],
          ["Next Run", autoStatus.nextRun]
        ]} />
        {commandStatusSummary(autoBackup).reason && <p className="danger-note">{commandStatusSummary(autoBackup).reason}</p>}
        <div className="action-line backup-auto-controls">
          <label className="checkbox-row"><input type="checkbox" checked={autoEnabled} onChange={(event) => setAutoEnabled(event.target.checked)} /> Enable</label>
          <label className="compact-select">Daily Backup Time<input type="time" step="60" pattern="[0-2][0-9]:[0-5][0-9]" value={autoTime} onChange={(event) => setAutoTime(sanitizeTimeInput(event.target.value))} placeholder="05:00" /></label>
          <label className="memory-number-field">Keep<input type="number" min="0" max="3650" step="1" value={autoRetentionDays} onChange={(event) => setAutoRetentionDays(event.target.value)} /></label>
          <span className="unit-label">Days</span>
          <button disabled={Boolean(busyAction)} onClick={() => run(saveAutomaticBackups)}>Save Settings</button>
          {autoResult && <span className={`inline-task-result result-${autoResult.status === "succeeded" ? "ok" : autoResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={autoResult.status === "running" ? "loading-dots" : ""}>{autoResult.title}</strong>
          </span>}
        </div>
      </section>
      <section className="action-section backup-remote-import">
        <div className="panel-title"><h4>Import External Backup</h4></div>
        <div className="action-line backup-import-controls">
          <label className="wide-field">Backup File (.backup)<input ref={importBackupInputRef} type="file" accept=".backup" onChange={(event) => setImportBackupFile(event.target.files?.[0] || null)} /></label>
          <label className="wide-field">Metadata File (.yaml)<input ref={importMetadataInputRef} type="file" accept=".yaml,.yml" onChange={(event) => setImportMetadataFile(event.target.files?.[0] || null)} /></label>
          <div className="backup-import-actions">
            <button disabled={Boolean(busyAction)} onClick={() => run(importExternalBackup)}>Import</button>
            {importResult && <span className={`inline-task-result result-${importResult.status === "succeeded" ? "ok" : importResult.status === "failed" ? "fail" : "running"}`}>
              <strong className={importResult.status === "running" ? "loading-dots" : ""}>{importResult.title}</strong>
            </span>}
          </div>
        </div>
      </section>
    </section>
  );
}

function BackupResultCard({ result }: { result: BackupResult }) {
  const danger = result.tone === "danger";
  const attention = result.tone === "attention";
  return <section className={`result-panel backup-result ${attention ? "warning-panel result-attention" : danger ? "result-danger" : result.status === "failed" ? "warning-panel result-fail" : result.status === "succeeded" ? "result-ok" : "result-running"}`}>
    <div className="panel-title backup-result-title">
      <div className="backup-result-copy">
        <h4 className={result.status === "running" ? "loading-dots" : ""}>{result.title}</h4>
        {result.message && <p>{result.message}</p>}
      </div>
      <StatusPill value={attention ? "Action Required" : danger ? "Deleted" : result.status === "failed" ? "Failed" : result.status === "running" ? "Running" : "Succeeded"} />
    </div>
    {result.details && <TechnicalDetails title="Technical details" text={result.details} />}
  </section>;
}

function backupRestoreTaskResult(task: Task): BackupResult {
  const details = task.logLines.map((line) => line.line).join("\n");
  if (funcomTokenMismatchDetected(details) || funcomTokenMismatchDetected(task.errorMessage || "")) {
    return {
      status: "failed",
      title: "Attention Required",
      message: "Funcom token mismatch detected. Please update your token to match the one used with the previous Battlegroup ID from the Server Controls.",
      details,
      tone: "attention"
    };
  }
  if (task.status === "succeeded") {
    return { status: "succeeded", title: "Restore Completed", message: "Database restore finished and the Dune stack restart completed.", details };
  }
  if (task.status === "failed") {
    return { status: "failed", title: "Backup Restore Failed", message: task.errorMessage || conciseTaskError(task), details };
  }
  return { status: "running", title: "Restoring Backup...", message: backupRestoreStageMessage(task), details };
}

function funcomTokenMismatchDetected(text: string) {
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

function backupRestoreStageMessage(task: Task) {
  const lines = task.logLines.map((row) => row.line).join("\n");
  if (/Starting Dune stack|Restarting Dune stack|Starting services/i.test(lines)) return "Restarting Dune services and waiting for the stack to come back up.";
  if (/Database import finished/i.test(lines)) return "Database restore finished. Restarting services.";
  if (/Automatic account relink/i.test(lines)) return "Relinking restored characters to current Docker player identities.";
  if (/Adopt backup battlegroup:/i.test(lines)) return "Changing Docker to use the backup battlegroup ID.";
  if (/Battlegroup remap:/i.test(lines)) return "Adapting imported backup to this Docker battlegroup.";
  if (/Restoring database/i.test(lines)) return "Restoring database contents from the selected backup.";
  if (/Recreating dune database/i.test(lines)) return "Recreating the Dune database before import.";
  if (/Stopping services that depend on the database/i.test(lines)) return "Stopping Dune services before the database restore.";
  if (/Creating database backup/i.test(lines)) return "Creating a pre-restore safety backup.";
  return task.progressMessage || "Preparing database restore.";
}

function summarizeBackupTask(task: Task, successTitle: string, failureTitle: string): BackupResult {
  const details = task.logLines.map((line) => line.line).join("\n");
  if (task.status === "succeeded") {
    const backupName = extractBackupName(details);
    const created = backupName ? formatBackupTimestamp(backupName.match(/(\d{8}-\d{6})/)?.[1] || "") : "";
    const schedulerNote = /cannot install systemd units|systemctl was not found/i.test(details) ? "Preference saved. Timer installation requires host systemd/root permissions." : "";
    return {
      status: "succeeded",
      title: successTitle,
      message: [backupName, created && created !== "Unknown" ? `Created ${created}` : "", schedulerNote].filter(Boolean).join(" · "),
      details
    };
  }
  return {
    status: "failed",
    title: failureTitle,
    message: conciseTaskError(task),
    details
  };
}

function extractBackupName(text: string) {
  const matches = [...String(text || "").matchAll(/([A-Za-z0-9_.-]+(?:\.backup|\.dump|\.sql))/g)];
  return matches.length ? matches[matches.length - 1][1] : "";
}

function conciseTaskError(task: Task) {
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

function LiveMapPanel({ onError }: { onError: (text: string) => void }) {
  const [mapKey, setMapKey] = useState("HaggaBasin");
  const [mapConfig, setMapConfig] = useState<LiveMapConfig | null>(null);
  const [maps, setMaps] = useState<Record<string, LiveMapConfig>>({});
  const [partitions, setPartitions] = useState<LiveMapPartition[]>([]);
  const [partitionId, setPartitionId] = useState("");
  const [markers, setMarkers] = useState<LiveMapMarker[]>([]);
  const [overlays, setOverlays] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<LiveMapMarker | null>(null);
  const [filters, setFilters] = useState<Record<string, boolean>>({ player: true, vehicle: true, base: true, storage: true });
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [zoom, setZoom] = useState(0.16);
  const [target, setTarget] = useState<{ x: number; y: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [drag, setDrag] = useState<{ x: number; y: number; left: number; top: number } | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const zoomAnchorRef = useRef<{ mapX: number; mapY: number; viewportX: number; viewportY: number } | null>(null);
  async function load() {
    onError("");
    setLoading(true);
    try {
      const result = await liveMapApi.markers(mapKey);
      setMarkers(result.rows || []);
      setOverlays(result.overlays || {});
      setMapConfig(result.map || null);
      setMaps(result.maps || {});
      setPartitions(result.partitions || []);
      if (!partitionId && result.map?.defaultPartitionId) setPartitionId(String(result.map.defaultPartitionId));
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, [mapKey]);
  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(load, 5000);
    return () => window.clearInterval(id);
  }, [autoRefresh, mapKey, partitionId]);
  const activeMap = mapConfig || maps[mapKey];
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    function handleWheel(event: WheelEvent) {
      const currentFrame = frameRef.current;
      const canvas = canvasRef.current;
      if (!currentFrame || !canvas) return;
      const canvasRect = canvas.getBoundingClientRect();
      const isInsideCanvas =
        event.clientX >= canvasRect.left &&
        event.clientX <= canvasRect.right &&
        event.clientY >= canvasRect.top &&
        event.clientY <= canvasRect.bottom;
      if (!isInsideCanvas) return;
      event.preventDefault();
      setZoomAround(zoom * (event.deltaY < 0 ? 1.12 : 0.88), { clientX: event.clientX, clientY: event.clientY });
    }
    frame.addEventListener("wheel", handleWheel, { passive: false });
    return () => frame.removeEventListener("wheel", handleWheel);
  }, [zoom, activeMap?.key]);
  useEffect(() => {
    function syncMinimumZoom() {
      const min = liveMapMinimumZoom(activeMap, frameRef.current);
      setZoom((current) => current < min ? min : current);
    }
    const id = window.requestAnimationFrame(syncMinimumZoom);
    window.addEventListener("resize", syncMinimumZoom);
    return () => {
      window.cancelAnimationFrame(id);
      window.removeEventListener("resize", syncMinimumZoom);
    };
  }, [activeMap?.key]);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const anchor = zoomAnchorRef.current;
    if (!frame || !anchor) return;
    frame.scrollLeft = anchor.mapX * zoom - anchor.viewportX;
    frame.scrollTop = anchor.mapY * zoom - anchor.viewportY;
    zoomAnchorRef.current = null;
  }, [zoom]);
  const mapOptions = Object.values(maps);
  const partitionOptions = partitions.filter((row) => row.map === (activeMap?.actorMap || activeMap?.key));
  const visible = markers
    .filter((marker) => filters[String(marker.type)] !== false)
    .filter((marker) => !partitionId || String(marker.partition_id || "") === partitionId);
  const plotted = visible.filter((marker) => Number.isFinite(Number(marker.x)) && Number.isFinite(Number(marker.y)));
  const displayRows = visible.map((marker) => ({ ...marker, display_name: friendlyMarkerName(marker), raw_name: marker.name || marker.id }));
  const markerCounts = countMarkers(visible);
  const inBounds = activeMap ? plotted.map((marker) => ({ marker, point: worldToLiveMapPoint(marker, activeMap) })).filter((item) => item.point?.inBounds) as { marker: LiveMapMarker; point: LiveMapPoint }[] : [];
  const targetPoint = target && activeMap ? worldToLiveMapPoint({ x: target.x, y: target.y }, activeMap) : null;
  const minimumZoom = liveMapMinimumZoom(activeMap, frameRef.current);
  const zoomMinPercent = Math.round(minimumZoom * 100);
  const zoomValuePercent = Math.round(zoom * 100);
  const zoomProgressPercent = Math.max(0, Math.min(100, ((zoomValuePercent - zoomMinPercent) / Math.max(1, 100 - zoomMinPercent)) * 100));
  const zoomDisplayPercent = Math.round(zoomProgressPercent);
  function chooseMap(nextKey: string) {
    const nextMap = maps[nextKey];
    setMapKey(nextKey);
    setPartitionId(nextMap?.defaultPartitionId ? String(nextMap.defaultPartitionId) : "");
    setSelected(null);
    setTarget(null);
  }
  function centerMarker(marker: LiveMapMarker) {
    if (!activeMap || !frameRef.current) return;
    const point = worldToLiveMapPoint(marker, activeMap);
    if (!point) return;
    setSelected(marker);
    requestAnimationFrame(() => {
      if (!frameRef.current) return;
      frameRef.current.scrollLeft = Math.max(0, point.px * zoom - frameRef.current.clientWidth / 2);
      frameRef.current.scrollTop = Math.max(0, point.py * zoom - frameRef.current.clientHeight / 2);
    });
  }
  function handleMapDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!activeMap || !canvasRef.current) return;
    if ((event.target as HTMLElement).closest(".live-map-marker")) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const px = (event.clientX - rect.left) / zoom;
    const py = (event.clientY - rect.top) / zoom;
    const world = liveMapPixelsToWorld(px, py, activeMap);
    if (!world) return;
    setTarget(world);
  }
  function setZoomAround(nextZoom: number, anchor?: { clientX: number; clientY: number }) {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    const oldZoom = zoom;
    const next = clampLiveMapZoom(nextZoom, liveMapMinimumZoom(activeMap, frame));
    if (!frame) {
      setZoom(next);
      return;
    }
    if (next === oldZoom) {
      zoomAnchorRef.current = null;
      return;
    }
    const canvasRect = canvas?.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const anchorViewportX = anchor ? anchor.clientX - frameRect.left : frame.clientWidth / 2;
    const anchorViewportY = anchor ? anchor.clientY - frameRect.top : frame.clientHeight / 2;
    const anchorMapX = anchor && canvasRect ? (anchor.clientX - canvasRect.left) / oldZoom : (frame.scrollLeft + frame.clientWidth / 2) / oldZoom;
    const anchorMapY = anchor && canvasRect ? (anchor.clientY - canvasRect.top) / oldZoom : (frame.scrollTop + frame.clientHeight / 2) / oldZoom;
    zoomAnchorRef.current = { mapX: anchorMapX, mapY: anchorMapY, viewportX: anchorViewportX, viewportY: anchorViewportY };
    setZoom(next);
  }
  return <section className="panel">
    <div className="panel-title">
      <div><h2>Live Map</h2><p className="muted">Live world markers, partition filtering, zoom, pan, and coordinate selection.</p></div>
      <div className="action-row"><button disabled={loading} onClick={load}>{loading ? "Refreshing..." : "Refresh Map"}</button><button className={`live-map-auto-toggle ${autoRefresh ? "enabled" : "disabled"}`} onClick={() => setAutoRefresh(!autoRefresh)}>{autoRefresh ? "Auto-Refresh On" : "Auto-Refresh Off"}</button></div>
    </div>
    <div className="live-map-layout">
      <aside className="live-map-sidebar">
        <section className="action-section">
          <h4>Map View</h4>
          <div className="live-map-map-buttons">{mapOptions.map((option) => <button key={option.key} className={option.key === mapKey ? "active" : ""} onClick={() => chooseMap(option.key)}>{option.label}</button>)}</div>
          <label className="compact-select">Partition<select value={partitionId} onChange={(event) => setPartitionId(event.target.value)}><option value="">All Partitions</option>{partitionOptions.map((row) => <option key={`${row.map}-${row.partition_id}`} value={String(row.partition_id)}>{row.name || `Partition ${row.partition_id}`} ({row.marker_count})</option>)}</select></label>
          <div className="key-value-grid live-map-stats">
            <div className="key-value-item"><span>Visible</span><strong>{visible.length}</strong></div>
            <div className="key-value-item"><span>In Bounds</span><strong>{inBounds.length}</strong></div>
            <div className="key-value-item"><span>Zoom</span><strong>{zoomDisplayPercent}%</strong></div>
          </div>
        </section>
        <section className="action-section">
          <h4>Layers</h4>
          <div className="live-map-layer-list">{Object.keys(filters).map((key) => <label key={key} className="checkbox-row live-map-layer"><input type="checkbox" checked={filters[key]} onChange={() => setFilters({ ...filters, [key]: !filters[key] })} /><span>{friendlyMarkerType(key)}</span><span className="muted">{markerCounts[key] || 0}</span><span className={`live-map-legend-dot marker-${key}`} /></label>)}</div>
        </section>
        <section className="action-section">
          <h4>Coordinates</h4>
          {target ? <KeyValueGrid items={[["X", target.x.toFixed(0)], ["Y", target.y.toFixed(0)], ["Partition", partitionId || "All"]]} /> : <p className="muted">Double-click the map to pick world coordinates.</p>}
        </section>
      </aside>
      <div className="live-map-main">
        <div className="live-map-toolbar">
          <button onClick={() => setZoomAround(zoom * 1.18)}>Zoom In</button>
          <button onClick={() => setZoomAround(zoom * 0.84)}>Zoom Out</button>
          <button onClick={() => setZoomAround(minimumZoom)}>Fit Map</button>
          <label>Zoom<input className="live-map-zoom-range" type="range" min={zoomMinPercent} max="100" value={zoomValuePercent} style={{ "--zoom-progress": `${zoomProgressPercent}%` } as React.CSSProperties} onChange={(event) => setZoomAround(Number(event.target.value) / 100)} /></label>
          <span className="muted">Drag to pan. Mouse Wheel Zooms.</span>
        </div>
        <div className={`live-map-frame ${drag ? "dragging" : ""}`} ref={frameRef}
          onDoubleClick={handleMapDoubleClick}
          onMouseDown={(event) => { if ((event.target as HTMLElement).closest(".live-map-marker")) return; setDrag({ x: event.clientX, y: event.clientY, left: frameRef.current?.scrollLeft || 0, top: frameRef.current?.scrollTop || 0 }); }}
          onMouseMove={(event) => { if (!drag || !frameRef.current) return; frameRef.current.scrollLeft = drag.left - (event.clientX - drag.x); frameRef.current.scrollTop = drag.top - (event.clientY - drag.y); }}
          onMouseUp={() => setDrag(null)}
          onMouseLeave={() => setDrag(null)}>
          {activeMap ? <div className="live-map-canvas" ref={canvasRef} style={{ width: Math.floor(activeMap.width * zoom), height: Math.floor(activeMap.height * zoom) }}>
            {activeMap.image ? <img className="live-map-image" src={activeMap.image} alt={activeMap.label} draggable={false} /> : <div className="live-map-placeholder">{activeMap.label}</div>}
            <div className="live-map-marker-layer">
              {targetPoint && <span className="live-map-target" style={{ left: `${targetPoint.px * zoom}px`, top: `${targetPoint.py * zoom}px` }} />}
              {inBounds.map(({ marker, point }, index) => <button key={`${marker.type}-${marker.id}-${index}`} className={`live-map-marker marker-${marker.type} ${String(marker.online_status || "").toLowerCase()}`} title={`${friendlyMarkerType(String(marker.type))}: ${friendlyMarkerName(marker)}`} onClick={(event) => { event.stopPropagation(); setSelected(marker); }} style={{ left: `${point.px * zoom}px`, top: `${point.py * zoom}px` }} />)}
            </div>
          </div> : <div className="empty">Loading map configuration...</div>}
        </div>
      </div>
    </div>
    {Object.entries(overlays).filter(([, reason]) => reason).map(([key, reason]) => <p className="danger-note" key={key}>{key}: {reason}</p>)}
    {selected && <section className="drawer"><div className="panel-title"><h3>{friendlyMarkerName(selected)}</h3><button onClick={() => setSelected(null)}>Close</button></div><KeyValueGrid items={[
      ["Type", selected.type],
      ["Name", friendlyMarkerName(selected)],
      ["ID", selected.id],
      ["Map", selected.map],
      ["Partition", selected.partition_id],
      ["X", selected.x],
      ["Y", selected.y],
      ["Z", selected.z]
    ]} /><TechnicalDetails title="Marker technical details" text={JSON.stringify(selected, null, 2)} /></section>}
    {displayRows.length > 0 && <DataTable rows={displayRows.map((row) => ({ ...row, type: friendlyMarkerType(String(row.type)) })) as Record<string, unknown>[]} columns={["type", "display_name", "map", "partition_id", "x", "y", "z"]} />}
  </section>;
}

function MapsPanel({ setTask, onError }: { setTask: (task: Task) => void; onError: (text: string) => void }) {
  const [mapsText, setMapsText] = useState("");
  const [memoryText, setMemoryText] = useState("");
  const [serversText, setServersText] = useState("");
  const [deepText, setDeepText] = useState("");
  const [schema, setSchema] = useState<UserSettingsSchema | null>(null);
  const [engineValues, setEngineValues] = useState<Record<string, string>>({});
  const [engineDraft, setEngineDraft] = useState<Record<string, string>>({});
  const [gameValues, setGameValues] = useState<Record<string, string>>({});
  const [gameDraft, setGameDraft] = useState<Record<string, string>>({});
  const [rawEngine, setRawEngine] = useState("");
  const [rawGame, setRawGame] = useState("");
  const [rawEngineOriginal, setRawEngineOriginal] = useState("");
  const [rawGameOriginal, setRawGameOriginal] = useState("");
  const [liveMemory, setLiveMemory] = useState<LiveMapMemoryRow[]>([]);
  const [memoryError, setMemoryError] = useState("");
  const [sietchesText, setSietchesText] = useState("");
  const [sietchDimensionsText, setSietchDimensionsText] = useState("");
  const [activeSietches, setActiveSietches] = useState("1");
  const [sietchDrafts, setSietchDrafts] = useState<Record<string, { displayName: string; password: string }>>({});
  const [selectedMapName, setSelectedMapName] = useState("");
  const [selectedPartitionId, setSelectedPartitionId] = useState("");
  const [userGameMapName, setUserGameMapName] = useState("");
  const [userGamePartitionId, setUserGamePartitionId] = useState("");
  const [selectedGameCategory, setSelectedGameCategory] = useState("");
  const [settingsTab, setSettingsTab] = useState<"engine" | "game">("engine");
  const [modifiersOpen, setModifiersOpen] = useState(true);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [deepDesertDualAction, setDeepDesertDualAction] = useState("enable");
  const [memory, setMemory] = useState("8");
  const [modeDraft, setModeDraft] = useState("dynamic");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [mapsResult, setMapsResult] = useState<HomeTaskResult | null>(() => loadPersistedMapsResult());
  const mapsLoadRef = useRef<Promise<void> | null>(null);
  async function run(action: () => Promise<unknown>) {
    onError("");
    try { await action(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  async function runTaskAndRefresh(action: () => Promise<{ task: Task }>, runningTitle = "Applying Map Changes", successTitle = "Map Changes Applied") {
    const response = await action();
    setMapsResult({ status: "running", title: runningTitle });
    persistMapsResult({ status: "running", title: runningTitle });
    const final = await waitForTask(response.task, setTask);
    const next: HomeTaskResult = final.status === "succeeded"
      ? { status: "succeeded", title: successTitle, details: taskTechnicalDetails(final) }
      : { status: "failed", title: "Map Change Failed", details: taskTechnicalDetails(final) || final.errorMessage || final.progressMessage };
    setMapsResult(next);
    persistMapsResult(next);
    await loadMaps();
    await loadUserEngine();
    if (userGameMapName) await loadSelectedSettings(userGameMapName, userGamePartitionId);
  }
  async function runTaskSequenceAndRefresh(actions: Array<() => Promise<{ task: Task }>>, runningTitle = "Applying Map Changes", successTitle = "Map Changes Applied") {
    if (!actions.length) return;
    setMapsResult({ status: "running", title: runningTitle });
    persistMapsResult({ status: "running", title: runningTitle });
    let final: Task | null = null;
    for (const action of actions) {
      final = await waitForTask((await action()).task, setTask);
      if (final.status !== "succeeded") break;
    }
    const next: HomeTaskResult = final?.status === "succeeded"
      ? { status: "succeeded", title: successTitle, details: taskTechnicalDetails(final) }
      : { status: "failed", title: "Map Change Failed", details: final ? taskTechnicalDetails(final) || final.errorMessage || final.progressMessage : "No task result." };
    setMapsResult(next);
    persistMapsResult(next);
    await loadMaps();
    await loadSietches();
  }
  async function loadMaps() {
    if (mapsLoadRef.current) return mapsLoadRef.current;
    setLoading(true);
    setLoadError("");
    mapsLoadRef.current = (async () => {
      const [status, memoryStatus] = await Promise.allSettled([
        withTimeout(mapsApi.status(), 60000, "Loading maps timed out."),
        withTimeout(mapsApi.memory(), 60000, "Loading map memory timed out.")
      ]);
      if (status.status !== "fulfilled" && memoryStatus.status !== "fulfilled") {
        const reason = status.status === "rejected" ? status.reason : memoryStatus.reason;
        throw new Error(reason instanceof Error ? reason.message : String(reason));
      }
      const mapStatus = status.status === "fulfilled" ? status.value : {};
      setMapsText(status.status === "fulfilled" ? String(mapStatus.maps?.stdout || "") : "");
      setServersText(status.status === "fulfilled" ? String(mapStatus.services?.stdout || "") : "");
      setMemoryText(memoryStatus.status === "fulfilled" ? memoryStatus.value.stdout : "");
      if (status.status !== "fulfilled" || memoryStatus.status !== "fulfilled") {
        const failed = status.status === "rejected" ? status.reason : memoryStatus.status === "rejected" ? memoryStatus.reason : "";
        setLoadError(failed instanceof Error ? failed.message : String(failed));
      }
    })().finally(() => {
      mapsLoadRef.current = null;
      setLoading(false);
    });
    return mapsLoadRef.current;
  }
  async function loadSchema() {
    const next = await mapsApi.userSettingsSchema();
    setSchema(next);
  }
  async function loadUserEngine() {
    const [values, raw] = await Promise.all([mapsApi.userEngine(), mapsApi.rawUserSettings("engine")]);
    const parsed = parseUserSettingsMap(values.stdout || "");
    setEngineValues(parsed);
    setEngineDraft(parsed);
    setRawEngine(raw.content || "");
    setRawEngineOriginal(raw.content || "");
  }
  async function loadSelectedSettings(mapName: string, partitionId?: string) {
    const [values, raw] = await Promise.all([mapsApi.userGame(mapName, partitionId), mapsApi.rawUserSettings("game", mapName, partitionId)]);
    const parsed = parseUserSettingsMap(values.stdout || "");
    setGameValues(parsed);
    setGameDraft(parsed);
    setRawGame(raw.content || "");
    setRawGameOriginal(raw.content || "");
  }
  async function loadSietches() {
    const [list, dimensions] = await Promise.all([mapsApi.sietches(), mapsApi.sietchDimensions("Survival_1")]);
    setSietchesText(list.stdout || "");
    setSietchDimensionsText(dimensions.stdout || "");
    const rows = parseSietchRows(dimensions.stdout || list.stdout || "");
    const drafts = Object.fromEntries(rows.map((row) => [row.partitionId, { displayName: row.displayName, password: row.password }]));
    if (rows.length) {
      setActiveSietches(String(rows.filter((row) => row.active).length || rows.length));
      setSietchDrafts(drafts);
    }
  }
  async function loadLiveMemory() {
    const result = await mapsApi.liveMemory();
    setLiveMemory(result.rows || []);
    setMemoryError(result.error || "");
  }
  useEffect(() => {
    run(loadMaps);
    run(loadSchema);
    run(loadUserEngine);
    run(loadLiveMemory);
    run(loadSietches);
  }, []);
  useEffect(() => {
    const id = window.setInterval(() => { void loadLiveMemory().catch(() => {}); }, 5000);
    return () => window.clearInterval(id);
  }, []);
  const mapRows = mergeMapAndMemoryRows(mapsText, memoryText, serversText);
  const selectedMap = mapRows.find((row) => String(row.map) === selectedMapName) || null;
  const selectedName = String(selectedMap?.map || "");
  const userGameMap = mapRows.find((row) => String(row.map) === userGameMapName) || null;
  const userGameName = String(userGameMap?.map || "");
  const isSurvival = selectedName === "Survival_1";
  const isDeepDesert = /^DeepDesert_/i.test(selectedName);
  const isDeepDesertRuntime = /^(DeepDesert_|Overmap$)/i.test(selectedName);
  const isUserGameSurvival = userGameName === "Survival_1";
  const isUserGameDeepDesertRuntime = /^(DeepDesert_|Overmap$)/i.test(userGameName);
  const sietchRows = parseSietchRows(sietchDimensionsText || sietchesText);
  const partitionOptions = isSurvival ? sietchRows.filter((row) => row.partitionId) : [];
  const userGamePartitionOptions = isUserGameSurvival ? sietchRows.filter((row) => row.partitionId) : [];
  const effectivePartitionId = isSurvival ? (selectedPartitionId || partitionOptions[0]?.partitionId || "1") : isDeepDesertRuntime ? "2" : selectedPartitionId;
  const effectiveUserGamePartitionId = isUserGameSurvival ? (userGamePartitionId || userGamePartitionOptions[0]?.partitionId || "1") : isUserGameDeepDesertRuntime ? "2" : userGamePartitionId;
  const gameFields = schema ? (effectivePartitionId ? schema.partition : schema.game).filter((field) => field.id !== "partition_pve_enabled" || effectivePartitionId) : [];
  const userGameFields = schema && userGameName ? (effectiveUserGamePartitionId ? schema.partition : schema.game).filter((field) => field.id !== "partition_pve_enabled" || effectiveUserGamePartitionId) : [];
  const gameGroups = groupSettingsFields(userGameFields);
  const activeGameCategory = gameGroups.some(([category]) => category === selectedGameCategory) ? selectedGameCategory : gameGroups[0]?.[0] || "";
  const activeGameFields = gameGroups.find(([category]) => category === activeGameCategory)?.[1] || [];
  const engineFields = (schema?.engine || []).filter((field) => !["server_display_name", "server_login_password", "port", "igw_port"].includes(field.id));
  const engineDirty = changedKeys(engineValues, engineDraft, engineFields.map((field) => field.id));
  const gameDirty = changedKeys(gameValues, gameDraft, userGameFields.map((field) => field.id));
  const sietchesDirty = activeSietches !== String(partitionOptions.filter((row) => row.active).length || partitionOptions.length || "") || partitionOptions.some((sietch) => {
    const draft = sietchDrafts[sietch.partitionId] || { displayName: sietch.displayName, password: sietch.password };
    return draft.displayName !== sietch.displayName || draft.password !== sietch.password;
  });
  const rawEngineDirty = rawEngine !== rawEngineOriginal;
  const rawGameDirty = rawGame !== rawGameOriginal;
  const dirtySummary = [
    engineDirty.length ? `${engineDirty.length} UserEngine value${engineDirty.length === 1 ? "" : "s"}` : "",
    gameDirty.length ? `${gameDirty.length} UserGame value${gameDirty.length === 1 ? "" : "s"}` : "",
    rawEngineDirty ? "UserEngine.ini" : "",
    rawGameDirty ? "UserGame.ini" : ""
  ].filter(Boolean).join(", ");
  function selectMap(row: Record<string, unknown>) {
    const name = String(row.map || "");
    if (selectedMapName === name) {
      setSelectedMapName("");
      setSelectedPartitionId("");
      return;
    }
    setSelectedMapName(name);
    const rowPartition = String(row.partitionId || row.partition || "").trim();
    const defaultPartition = name === "Survival_1" ? "1" : /^(DeepDesert_|Overmap$)/i.test(name) ? "2" : rowPartition;
    setSelectedPartitionId(defaultPartition);
    setSelectedGameCategory("");
    setMemory(memoryInputValue(String(row.memory || "")));
    setModeDraft(modeInputValue(String(row.mode || "")));
    void loadSelectedSettings(name, defaultPartition || undefined).catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }
  function selectPartition(next: string) {
    setSelectedPartitionId(next);
    setSelectedGameCategory("");
    if (selectedMapName) void loadSelectedSettings(selectedMapName, next || undefined).catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }
  function selectUserGameMap(next: string) {
    if (!next) {
      setUserGameMapName("");
      setUserGamePartitionId("");
      setSelectedGameCategory("");
      setGameValues({});
      setGameDraft({});
      return;
    }
    const row = mapRows.find((item) => String(item.map) === next);
    const rowPartition = String(row?.partitionId || row?.partition || "").trim();
    const defaultPartition = next === "Survival_1" ? "1" : /^(DeepDesert_|Overmap$)/i.test(next) ? "2" : rowPartition;
    setUserGameMapName(next);
    setUserGamePartitionId(defaultPartition);
    setSelectedGameCategory("");
    if (next) void loadSelectedSettings(next, defaultPartition || undefined).catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }
  function selectUserGamePartition(next: string) {
    setUserGamePartitionId(next);
    setSelectedGameCategory("");
    if (userGameName) void loadSelectedSettings(userGameName, next || undefined).catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }
  async function saveEngine() {
    await runTaskAndRefresh(() => mapsApi.saveUserSettings({ scope: "engine", values: valuesForFields(engineDraft, engineFields) }), "Saving UserEngine and restarting servers", "UserEngine Saved");
    await loadUserEngine();
  }
  async function saveSelectedMapSettings(row: Record<string, unknown>) {
    const rowName = String(row.map || "");
    const originalMode = modeInputValue(String(row.mode || ""));
    const originalMemory = memoryInputValue(String(row.memory || ""));
    const modeChanged = modeDraft !== originalMode && String(row.mode) !== "Core Map";
    const memoryChanged = memory !== originalMemory;
    if (!modeChanged && !memoryChanged) return;
    const running = /^(Ready|Running|Starting|Assigned)$/i.test(String(row.status || ""));
    const partitionId = String(row.partitionId || row.partition || "").trim();
    if (window.confirm(`Save map settings for ${rowName}${memoryChanged && running ? " and restart the affected map once" : ""}?`)) {
      await runTaskAndRefresh(() => mapsApi.saveMapSettings({
        map: rowName,
        partitionId: partitionId || undefined,
        mode: modeDraft,
        memory: `${memory}g`,
        modeChanged,
        memoryChanged,
        running,
        confirmation: "SAVE MAP SETTINGS"
      }), `Saving ${rowName} Settings`, "Map Settings Saved");
    }
  }
  async function saveSurvivalSietches() {
    const actions: Array<() => Promise<{ task: Task }>> = [];
    const currentActive = String(partitionOptions.filter((row) => row.active).length || partitionOptions.length || "");
    if (activeSietches && activeSietches !== currentActive) {
      actions.push(() => mapsApi.updateSietches({ action: "set-active", map: "Survival_1", count: Number(activeSietches), confirmation: "UPDATE SIETCHES" }));
    }
    for (const sietch of partitionOptions) {
      const draft = sietchDrafts[sietch.partitionId] || { displayName: sietch.displayName, password: sietch.password };
      if (draft.displayName !== sietch.displayName) {
        actions.push(() => mapsApi.updateSietches({ action: "set-display", partitionId: sietch.partitionId, displayName: draft.displayName, confirmation: "UPDATE SIETCHES" }));
      }
      if (draft.password !== sietch.password) {
        actions.push(() => mapsApi.updateSietches({ action: "set-password", partitionId: sietch.partitionId, password: draft.password, confirmation: "UPDATE SIETCHES" }));
      }
    }
    if (!actions.length) return;
    if (window.confirm(`Save ${actions.length} Survival_1 Sietch change${actions.length === 1 ? "" : "s"}?`)) {
      await runTaskSequenceAndRefresh(actions, "Saving Sietch Changes", "Sietches Saved");
    }
  }
  async function saveGame() {
    if (!userGameName) return;
    const scope = effectiveUserGamePartitionId ? "partition" : "map";
    await runTaskAndRefresh(() => mapsApi.saveUserSettings({ scope, map: userGameName, partitionId: effectiveUserGamePartitionId || undefined, values: valuesForFields(gameDraft, userGameFields) }), `Saving ${userGameName} UserGame`, "UserGame Saved");
    await loadSelectedSettings(userGameName, effectiveUserGamePartitionId || undefined);
  }
  async function saveRaw(kind: "engine" | "game") {
    if (kind === "engine") {
      await runTaskAndRefresh(() => mapsApi.saveRawUserSettings({ scope: "engine", content: rawEngine }), "Saving raw UserEngine and restarting servers", "Raw UserEngine Saved");
      await loadUserEngine();
    } else {
      await runTaskAndRefresh(() => mapsApi.saveRawUserSettings({ scope: "game", map: userGameName || "Survival_1", partitionId: effectiveUserGamePartitionId || undefined, content: rawGame }), "Saving raw UserGame and restarting servers", "Raw UserGame Saved");
      if (userGameName) await loadSelectedSettings(userGameName, effectiveUserGamePartitionId || undefined);
    }
  }
  async function importIni(kind: "engine" | "game", file: File | null) {
    if (!file) return;
    const text = await file.text();
    if (kind === "engine") setRawEngine(text);
    else setRawGame(text);
  }
  function downloadIni(kind: "engine" | "game") {
    const text = kind === "engine" ? rawEngine : rawGame;
    const name = kind === "engine" ? "UserEngine.ini" : "UserGame.ini";
    downloadText(name, text);
  }
  async function toggleAdvanced() {
    if (advancedOpen) {
      setAdvancedOpen(false);
      return;
    }
    await loadUserEngine();
    const raw = await mapsApi.rawUserSettings("game");
    setRawGame(raw.content || "");
    setRawGameOriginal(raw.content || "");
    setModifiersOpen(false);
    setAdvancedOpen(true);
  }
  function toggleModifiers() {
    const nextOpen = !modifiersOpen;
    setModifiersOpen(nextOpen);
    if (nextOpen) setAdvancedOpen(false);
  }
  return <section className="panel maps-panel">
    <div className="panel-title"><h2>Maps & Sietches</h2><button disabled={loading} onClick={() => run(loadMaps)}>{loading ? "Refreshing..." : "Refresh Maps"}</button></div>
    {dirtySummary && <p className="dirty-note">Unsaved changes: {dirtySummary}</p>}
    {mapsResult && <HomeTaskResultCard result={mapsResult} />}
    <section className="action-section">
      <h4>Maps Overview</h4>
      {loading && !mapRows.length && <div className="empty">Loading maps...</div>}
      {!loading && loadError && !mapRows.length && <div className="result-panel"><strong>Map list could not be loaded.</strong><p>{loadError}</p><button onClick={() => run(loadMaps)}>Retry</button></div>}
      {mapRows.length ? <div className="table-wrap maps-overview-table-wrap"><table className="maps-overview-table"><thead><tr><th>Map</th><th>Status</th><th>Mode</th><th>Memory</th><th className="actions-column">Action</th></tr></thead><tbody>{mapRows.map((row) => {
        const rowName = String(row.map || "");
        const isSelected = selectedMapName === rowName;
        const memoryRow = memoryForMap(liveMemory, rowName, row);
        const mapSettingsDirty = isSelected && ((modeDraft !== modeInputValue(String(row.mode || "")) && String(row.mode) !== "Core Map") || memory !== memoryInputValue(String(row.memory || "")));
        return <Fragment key={rowName}><tr><td>{rowName}</td><td>{String(row.status || "Not Available")}</td><td>{String(row.mode || "Not Available")}</td><td><MemoryUsageBar row={memoryRow} fallback={liveMemoryFallback(row)} /></td><td className="actions-column"><button className="stable-action-button" onClick={() => selectMap(row)}>{isSelected ? "Close" : "Edit"}</button></td></tr>
          {isSelected && <tr className="inline-edit-row" key={`${rowName}-edit`}><td colSpan={5}>
            <section className="inline-edit-panel">
              <div className="panel-title"><h4>Edit {rowName}</h4></div>
              <KeyValueGrid items={[["Status", row.status], ["Mode", row.mode], ["Memory", row.memory], ["Dimensions", row.dimensions]]} />
              <div className="action-line">
                <label className="compact-select">Mode<select value={modeDraft} disabled={String(row.mode) === "Core Map"} onChange={(event) => setModeDraft(event.target.value)}><option value="dynamic">Dynamic</option><option value="always-on">Always On</option></select></label>
                <label className="memory-number-field">Memory<input type="number" min="1" step="1" value={memory} onChange={(event) => setMemory(event.target.value)} placeholder="8" /></label>
                <span className="unit-label">GB</span>
                <button disabled={!mapSettingsDirty} onClick={() => run(() => saveSelectedMapSettings(row))}>Save Map Settings</button>
              </div>
              {String(row.mode) === "Core Map" && <p className="muted">Core map mode is managed by the base server stack; only memory changes are exposed here.</p>}
              {isSurvival && <section className="action-section nested-action">
                <div className="panel-title"><h4>Sietches</h4><button onClick={() => run(loadSietches)}>Refresh Sietches</button></div>
                <div className="action-line">
                  <label className="memory-number-field">Active Sietches<input type="number" min="1" max="64" step="1" value={activeSietches} onChange={(event) => setActiveSietches(event.target.value)} /></label>
                  <button disabled={!sietchesDirty} onClick={() => run(saveSurvivalSietches)}>Save Sietches</button>
                </div>
                {partitionOptions.length ? <div className="settings-grid">{partitionOptions.map((sietch) => {
                  const draft = sietchDrafts[sietch.partitionId] || { displayName: sietch.displayName, password: sietch.password };
                  return <article className="settings-field" key={sietch.partitionId}>
                    <strong>Partition {sietch.partitionId}</strong>
                    <label>Name<input value={draft.displayName} onChange={(event) => setSietchDrafts({ ...sietchDrafts, [sietch.partitionId]: { ...draft, displayName: event.target.value } })} /></label>
                    <label>Password<SecretInput value={draft.password} onChange={(event) => setSietchDrafts({ ...sietchDrafts, [sietch.partitionId]: { ...draft, password: event.target.value } })} /></label>
                  </article>;
                })}</div> : <MapCommandSummary text={sietchesText || "No Sietch dimensions reported yet."} />}
              </section>}
              {isDeepDesert && <section className="action-section nested-action">
                <div className="action-line deep-desert-dual-line">
                  <strong>Deep Desert Dual Setup:</strong>
                  <label className="compact-select"><select value={deepDesertDualAction} onChange={(event) => setDeepDesertDualAction(event.target.value)}><option value="enable">Enable</option><option value="disable">Disable</option></select></label>
                  <button className={deepDesertDualAction === "disable" ? "danger" : ""} onClick={() => run(async () => { if (window.confirm(`${titleCase(deepDesertDualAction)} dual Deep Desert setup?`)) await runTaskAndRefresh(() => mapsApi.updateDeepdesert({ action: deepDesertDualAction, confirmation: "UPDATE DEEP DESERT" }), `Running Deep Desert ${deepDesertDualAction}`, "Deep Desert Updated"); })}>Save</button>
                </div>
                {deepText && <MapCommandSummary text={deepText} />}
              </section>}
            </section>
          </td></tr>}
        </Fragment>;
      })}</tbody></table></div> : null}
      {loadError && mapRows.length ? <p className="danger-note">Some map data could not be refreshed: {loadError}</p> : null}
      {memoryError && <p className="danger-note">Live memory could not be read: {memoryError}</p>}
    </section>
    <section className="action-section">
      <div className="panel-title">
        <h4>Interactive Modifiers</h4>
        <button className={`icon-toggle-button ${modifiersOpen ? "active" : ""}`} aria-label={modifiersOpen ? "Collapse Interactive Modifiers" : "Expand Interactive Modifiers"} title={modifiersOpen ? "Collapse" : "Expand"} onClick={toggleModifiers}>{modifiersOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button>
      </div>
      {modifiersOpen && <><div className="settings-tabs" role="tablist" aria-label="INI modifier editor">
        <button className={settingsTab === "engine" ? "active" : ""} role="tab" aria-selected={settingsTab === "engine"} onClick={() => setSettingsTab("engine")}>UserEngine</button>
        <button className={settingsTab === "game" ? "active" : ""} role="tab" aria-selected={settingsTab === "game"} onClick={() => setSettingsTab("game")}>UserGame</button>
      </div>
      {settingsTab === "engine" ? <>
        <SettingsEditor fields={engineFields} values={engineDraft} onChange={(id, value) => setEngineDraft({ ...engineDraft, [id]: value })} />
        <div className="action-row"><button disabled={!engineDirty.length} onClick={() => run(saveEngine)}>Save</button><button disabled={!engineDirty.length} onClick={() => setEngineDraft(engineValues)}>Discard Changes</button></div>
      </> : <>
        <div className="settings-selector-row">
          <label className="compact-select">Map<select value={userGameName} onChange={(event) => selectUserGameMap(event.target.value)}><option value="">Select Map</option>{mapRows.map((row) => {
            const name = String(row.map || "");
            return <option key={name} value={name}>{name}</option>;
          })}</select></label>
          {isUserGameSurvival && <label className="compact-select">Sietch / Partition<select value={effectiveUserGamePartitionId} onChange={(event) => selectUserGamePartition(event.target.value)}>{userGamePartitionOptions.map((option) => <option key={option.partitionId} value={option.partitionId}>{option.displayName || `Partition ${option.partitionId}`} ({option.partitionId})</option>)}</select></label>}
          <label className="compact-select">Modifier Category<select disabled={!userGameName} value={activeGameCategory} onChange={(event) => setSelectedGameCategory(event.target.value)}>{gameGroups.map(([category, fields]) => <option key={category} value={category}>{category} ({fields.length})</option>)}</select></label>
        </div>
        {userGameName && <SettingsCardGrid fields={activeGameFields} values={gameDraft} onChange={(id, value) => setGameDraft({ ...gameDraft, [id]: value })} />}
        <div className="action-row"><button disabled={!gameDirty.length || !userGameName} onClick={() => run(saveGame)}>Save</button><button disabled={!gameDirty.length} onClick={() => setGameDraft(gameValues)}>Discard Changes</button></div>
      </>}</>}
    </section>
    <section className="action-section">
      <div className="panel-title">
        <h4>Advanced</h4>
        <div className="action-row advanced-toggle-row">
          <button className={`icon-toggle-button ${advancedOpen ? "active" : ""}`} aria-label={advancedOpen ? "Collapse Advanced" : "Expand Advanced"} title={advancedOpen ? "Collapse" : "Expand"} onClick={() => run(toggleAdvanced)}>{advancedOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button>
        </div>
      </div>
      {advancedOpen && <div className="advanced-grid">
        <article className="raw-editor-card"><div className="panel-title"><h4>UserEngine.ini</h4><div className="action-row"><button onClick={() => downloadIni("engine")}>Download</button><label className="button-link">Import<input className="hidden-file-input" type="file" accept=".ini,text/plain" onChange={(event) => run(async () => { await importIni("engine", event.target.files?.[0] || null); })} /></label></div></div><textarea value={rawEngine} onChange={(event) => setRawEngine(event.target.value)} rows={14} /><div className="action-row"><button disabled={!rawEngineDirty} onClick={() => run(() => saveRaw("engine"))}>Save</button><button disabled={!rawEngineDirty} onClick={() => setRawEngine(rawEngineOriginal)}>Discard Changes</button><button className="danger" onClick={() => run(async () => { if (window.confirm("Restore UserEngine gameplay defaults? Server name, password, Port, and IGWPort will be preserved.")) await runTaskAndRefresh(() => mapsApi.resetUserSettings({ scope: "engine", confirmation: "RESTORE MAP DEFAULTS" }), "Restoring UserEngine defaults", "UserEngine Defaults Restored"); await loadUserEngine(); })}>Restore Defaults</button></div></article>
        <article className="raw-editor-card"><div className="panel-title"><h4>UserGame.ini</h4><div className="action-row"><button onClick={() => downloadIni("game")}>Download</button><label className="button-link">Import<input className="hidden-file-input" type="file" accept=".ini,text/plain" onChange={(event) => run(async () => { await importIni("game", event.target.files?.[0] || null); })} /></label></div></div><textarea value={rawGame} onChange={(event) => setRawGame(event.target.value)} rows={14} /><div className="action-row"><button disabled={!rawGameDirty} onClick={() => run(() => saveRaw("game"))}>Save</button><button disabled={!rawGameDirty} onClick={() => setRawGame(rawGameOriginal)}>Discard Changes</button><button disabled={!userGameName} className="danger" onClick={() => run(async () => { if (window.confirm(`Restore UserGame defaults for ${userGameName}${effectiveUserGamePartitionId ? ` partition ${effectiveUserGamePartitionId}` : ""}?`)) await runTaskAndRefresh(() => mapsApi.resetUserSettings({ scope: effectiveUserGamePartitionId ? "partition" : "map", map: userGameName, partitionId: effectiveUserGamePartitionId || undefined, confirmation: "RESTORE MAP DEFAULTS" }), "Restoring UserGame defaults", "UserGame Defaults Restored"); await loadSelectedSettings(userGameName, effectiveUserGamePartitionId || undefined); })}>Restore Defaults</button></div></article>
      </div>}
    </section>
  </section>;
}

function SettingsEditor({ fields, values, onChange }: { fields: UserSettingField[]; values: Record<string, string>; onChange: (id: string, value: string) => void }) {
  if (!fields.length) return <div className="empty">Settings schema is loading.</div>;
  const groups = groupSettingsFields(fields);
  return <div className="settings-category-list">{groups.map(([category, categoryFields]) => <details className="settings-category" key={category} open>
    <summary><span>{category}</span><strong>{categoryFields.length}</strong></summary>
    <div className="settings-grid settings-grid-roomy">{categoryFields.map((field) => <SettingControl key={field.id} field={field} value={values[field.id] ?? field.default ?? ""} onChange={(value) => onChange(field.id, value)} />)}</div>
  </details>)}</div>;
}

function SettingsCardGrid({ fields, values, onChange }: { fields: UserSettingField[]; values: Record<string, string>; onChange: (id: string, value: string) => void }) {
  if (!fields.length) return <div className="empty">Select a modifier category.</div>;
  return <div className="settings-grid settings-grid-roomy">{fields.map((field) => <SettingControl key={field.id} field={field} value={values[field.id] ?? field.default ?? ""} onChange={(value) => onChange(field.id, value)} />)}</div>;
}

function SettingControl({ field, value, onChange }: { field: UserSettingField; value: string; onChange: (value: string) => void }) {
  const label = friendlySettingLabel(field.id, field.key || field.id);
  const inputId = `setting-${field.scope}-${field.id}`;
  return <label className="settings-field" htmlFor={inputId}>
    <span><strong>{label}</strong><small>{field.key || field.id}</small></span>
    {field.type === "boolean"
      ? <select id={inputId} value={normalizeBooleanText(value)} onChange={(event) => onChange(event.target.value)}><option value="True">True</option><option value="False">False</option></select>
      : field.type === "integer" || field.type === "number"
        ? <input id={inputId} type="number" step={field.type === "integer" ? "1" : "any"} value={value} onChange={(event) => onChange(event.target.value)} />
        : String(value).length > 72 || value.includes("(")
          ? <textarea id={inputId} rows={3} value={value} onChange={(event) => onChange(event.target.value)} />
          : <input id={inputId} value={value} onChange={(event) => onChange(event.target.value)} />}
  </label>;
}

function MemoryUsageBar({ row, fallback }: { row: LiveMapMemoryRow | null; fallback: string }) {
  if (!row) return <span className="muted">{fallback}</span>;
  const percent = Math.max(0, Math.min(100, Number(row.percent) || 0));
  return <div className="memory-usage-cell">
    <div className="memory-usage-bar"><span style={{ width: `${percent}%` }} /></div>
    <strong>{percent.toFixed(1)}%</strong>
    <span>{formatBytes(row.usedBytes)} / {formatBytes(row.limitBytes)}</span>
  </div>;
}

function groupSettingsFields(fields: UserSettingField[]): [string, UserSettingField[]][] {
  const grouped = new globalThis.Map<string, UserSettingField[]>();
  for (const field of fields) {
    const category = settingsCategory(field.section || field.key || field.id);
    grouped.set(category, [...(grouped.get(category) || []), field]);
  }
  return [...grouped.entries()];
}

function settingsCategory(value: string) {
  const raw = value.replace(/^\/Script\/DuneSandbox\./, "").replace(/^\/Script\//, "").replace(/^\/DeteriorationSystem\./, "");
  const cleaned = raw.split(".").pop() || raw;
  if (cleaned === "ConsoleVariables") return "Global";
  return titleCaseWords(cleaned.replace(/Subsystem$/, "").replace(/Settings$/, " Settings").replace(/Config$/, " Config").replace(/([a-z])([A-Z])/g, "$1 $2"));
}

function friendlySettingLabel(id: string, fallback: string) {
  return titleCaseWords(id.replace(/^partition_/, "").replace(/_/g, " ")) || titleCaseWords(fallback);
}

function normalizeBooleanText(value: string) {
  return /^(1|true|yes|on)$/i.test(String(value)) ? "True" : "False";
}

function parseUserSettingsMap(text: string) {
  return Object.fromEntries(parseUserSettingRows(text).map((row) => [String(row.setting), String(row.value ?? "")]));
}

function changedKeys(original: Record<string, string>, draft: Record<string, string>, keys: string[]) {
  return keys.filter((key) => String(original[key] ?? "") !== String(draft[key] ?? ""));
}

function valuesForFields(values: Record<string, string>, fields: UserSettingField[]) {
  return Object.fromEntries(fields.map((field) => [field.id, String(values[field.id] ?? field.default ?? "")]));
}

type SietchRow = { partitionId: string; displayName: string; password: string; active: boolean };

function parseSietchRows(text: string): SietchRow[] {
  const rows: SietchRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const partitionMatch = line.match(/\b(?:partition|id)\s*[:=]?\s*(\d+)\b/i) || line.match(/^\s*(\d+)\s+/);
    if (!partitionMatch) continue;
    const partitionId = partitionMatch[1];
    const displayName = (line.match(/\b(?:display|name)\s*[:=]\s*([^|,\t]+)/i)?.[1] || line.match(/\bSietch\s+([A-Za-z0-9 _-]+)/i)?.[0] || `Sietch ${partitionId}`).trim();
    const password = (line.match(/\bpassword\s*[:=]\s*([^|,\t]+)/i)?.[1] || "").trim();
    const active = !/\binactive|disabled|stopped\b/i.test(line);
    rows.push({ partitionId, displayName, password, active });
  }
  const unique = new globalThis.Map<string, SietchRow>();
  for (const row of rows) unique.set(row.partitionId, row);
  return [...unique.values()].sort((a, b) => Number(a.partitionId) - Number(b.partitionId));
}

function memoryForMap(rows: LiveMapMemoryRow[], map: string, row?: Record<string, unknown>) {
  const normalized = map.toLowerCase();
  const partitionId = String(row?.partitionId || row?.partition || "").trim();
  return rows.find((memoryRow) => {
    const memoryMap = memoryRow.map.toLowerCase();
    const container = memoryRow.container.toLowerCase();
    const containerMap = normalized.replace(/_/g, "-");
    if (partitionId && new RegExp(`-${escapeRegExp(partitionId)}$`).test(container)) return true;
    if (memoryMap === normalized) return true;
    if (container === `dune-server-${containerMap}`) return true;
    if (!partitionId && container.startsWith(`dune-server-${containerMap}-`)) return true;
    return false;
  }) || null;
}

function liveMemoryFallback(row: Record<string, unknown>) {
  const status = String(row.status || "");
  if (/^(Ready|Running|Starting)$/i.test(status)) return "Unavailable";
  return "Not Running";
}

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

const MAPS_RESULT_KEY = "dune.maps.result";

function loadPersistedMapsResult(): HomeTaskResult | null {
  try {
    const raw = window.localStorage.getItem(MAPS_RESULT_KEY);
    return raw ? JSON.parse(raw) as HomeTaskResult : null;
  } catch {
    return null;
  }
}

function persistMapsResult(result: HomeTaskResult | null) {
  try {
    if (result) window.localStorage.setItem(MAPS_RESULT_KEY, JSON.stringify(result));
    else window.localStorage.removeItem(MAPS_RESULT_KEY);
  } catch {
    // Browser storage can be unavailable in hardened modes.
  }
}

type LiveMapPoint = { px: number; py: number; inBounds: boolean };

function worldToLiveMapPoint(marker: Pick<LiveMapMarker, "x" | "y">, config: LiveMapConfig): LiveMapPoint | null {
  const x = Number(marker.x);
  const y = Number(marker.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (config.maxX === config.minX || config.maxY === config.minY) return null;
  const px = ((x - config.minX) / (config.maxX - config.minX)) * config.width;
  let py = ((y - config.minY) / (config.maxY - config.minY)) * config.height;
  if (config.flipY) py = config.height - py;
  return {
    px,
    py,
    inBounds: px >= 0 && px <= config.width && py >= 0 && py <= config.height
  };
}

function liveMapPixelsToWorld(px: number, py: number, config: LiveMapConfig) {
  if (!Number.isFinite(px) || !Number.isFinite(py) || config.width === 0 || config.height === 0) return null;
  let normalizedY = py / config.height;
  if (config.flipY) normalizedY = 1 - normalizedY;
  return {
    x: config.minX + (px / config.width) * (config.maxX - config.minX),
    y: config.minY + normalizedY * (config.maxY - config.minY)
  };
}

function liveMapMinimumZoom(config: LiveMapConfig | null | undefined, frame: HTMLElement | null) {
  if (!config || !frame) return 0.16;
  return Math.max(0.05, frame.clientWidth / config.width, frame.clientHeight / config.height);
}

function clampLiveMapZoom(value: number, minimum = 0.16) {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(1, value));
}

function countMarkers(markers: LiveMapMarker[]) {
  return markers.reduce<Record<string, number>>((acc, marker) => {
    const key = String(marker.type || "unknown");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function friendlyMarkerName(marker: LiveMapMarker) {
  const raw = String(marker.name || marker.id || marker.type || "Marker");
  const normalized = raw.toLowerCase();
  if (/ornithopter.*light|light.*ornithopter/.test(normalized)) return "Light Ornithopter";
  if (/ornithopter.*medium|medium.*ornithopter/.test(normalized)) return "Medium Ornithopter";
  if (/ornithopter.*transport|transport.*ornithopter/.test(normalized)) return "Transport Ornithopter";
  if (/sandbike/.test(normalized)) return "Sandbike";
  if (/buggy/.test(normalized)) return "Buggy";
  if (/tank/.test(normalized)) return "Tank";
  if (/sandcrawler/.test(normalized)) return "Sandcrawler";
  if (/treadwheel/.test(normalized)) return "Treadwheel";
  return raw.replace(/^\/Game\/.*\//, "").replace(/^BP_/, "").replace(/_C$/, "").replaceAll("_", " ");
}

function friendlyMarkerType(type: string) {
  return {
    player: "Player",
    vehicle: "Vehicle",
    base: "Base",
    storage: "Storage",
    service: "Service"
  }[type.toLowerCase()] || titleCase(type.replaceAll("_", " "));
}

function UpdatesPanel({ setTask }: { setTask: (task: Task) => void }) {
  const [gameStatus, setGameStatus] = useState<Record<string, string>>({ status: "Not checked", current: "", latest: "", reason: "" });
  const [stackStatus, setStackStatus] = useState<Record<string, string>>({ status: "Not checked", current: "", latest: "", reason: "" });
  const [gameUpdateTask, setGameUpdateTask] = useState<Task | null>(null);
  const [gameSteamcmdFixTask, setGameSteamcmdFixTask] = useState<Task | null>(null);
  const [stackUpdateTask, setStackUpdateTask] = useState<Task | null>(null);
  const [autoGame, setAutoGame] = useState<{ stdout?: string; stderr?: string; exitCode?: number } | null>(null);
  const [autoGameLoading, setAutoGameLoading] = useState(true);
  const [autoGameEnabled, setAutoGameEnabled] = useState(false);
  const [autoGameTime, setAutoGameTime] = useState("05:00");
  const [autoGameResult, setAutoGameResult] = useState<HomeTaskResult | null>(null);
  const [previousStack, setPreviousStack] = useState<Record<string, string>[]>([]);
  const [previousStackReason, setPreviousStackReason] = useState("");
  const autoGameValues = parseKeyValueText(autoGame?.stdout || "");
  const autoGameTimerValue = autoGameValues.systemd_timer || "";
  const autoGameTimerLabel = autoGameTimerValue ? formatTimerStatus(autoGameTimerValue) : "Not Installed";
  const autoGameTimerReady = /^(active|enabled)$/i.test(autoGameTimerValue);
  const autoGameSaving = autoGameResult?.status === "running";
  const autoGameLoaded = Boolean(autoGame);
  const autoGameDisplayActive = autoGameSaving ? autoGameEnabled : autoGameEnabled && autoGameTimerReady;
  const autoGameStatusLabel = !autoGameLoaded && !autoGameSaving ? "Checking" : autoGameDisplayActive ? "Enabled" : "Disabled";
  const autoGameDisplayTimerLabel = !autoGameLoaded && !autoGameSaving ? "Checking" : autoGameSaving ? autoGameEnabled ? "Activating" : "Deactivating" : autoGameTimerLabel;
  async function checkGame() {
    setGameStatus({ status: "Checking...", current: "", latest: "", reason: "" });
    const final = await waitForTaskSilently((await updatesApi.checkGame()).task);
    setGameStatus(parseUpdateTask(final));
  }
  async function refreshGameStatus() {
    try {
      await checkGame();
    } catch (error) {
      setGameStatus({ status: "Check Failed", current: "", latest: "", reason: error instanceof Error ? error.message : String(error) });
    }
  }
  async function checkStack() {
    setStackStatus({ status: "Checking...", current: "", latest: "", reason: "" });
    const final = await waitForTaskSilently((await updatesApi.checkStack()).task);
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
    if (!window.confirm("Apply the game server update now?")) return;
    setGameSteamcmdFixTask(null);
    const response = await updatesApi.applyGame();
    setGameUpdateTask(response.task);
    const final = await waitForTaskWithUpdates(response.task, setGameUpdateTask);
    if (final.status === "succeeded") refreshGameStatus();
  }
  async function fixSteamcmd() {
    const response = await updatesApi.fixSteamcmd();
    setGameSteamcmdFixTask(response.task);
    await waitForTaskWithUpdates(response.task, setGameSteamcmdFixTask);
  }
  async function applyStackUpdate() {
    if (!window.confirm("Apply the latest RedBlink stack update now?")) return;
    const response = await updatesApi.applyStack();
    setStackUpdateTask(response.task);
    const final = await waitForTaskWithUpdates(response.task, setStackUpdateTask);
    if (final.status === "succeeded") refreshStackStatus();
  }
  async function loadAutoGame() {
    try {
      const result = await updatesApi.autoGameStatus();
      setAutoGame(result);
      const values = parseKeyValueText(result.stdout || "");
      const preferenceEnabled = /^(1|true|enabled)$/i.test(values.auto_updates_enabled || values.enabled || "");
      const timerReady = /^(active|enabled)$/i.test(values.systemd_timer || "");
      setAutoGameEnabled(preferenceEnabled && timerReady);
      if (values.auto_update_time) setAutoGameTime(toHourMinuteTime(values.auto_update_time));
    } finally {
      setAutoGameLoading(false);
    }
  }
  async function saveAutoGame() {
    const sanitizedTime = toHourMinuteTime(autoGameTime);
    if (autoGameEnabled && !isValidHourMinuteTime(sanitizedTime)) {
      setAutoGameResult({ status: "failed", title: "Auto Updates Save Failed", message: "Daily check time must be a valid 24-hour time, for example 05:00 or 23:30." });
      return;
    }
    setAutoGameTime(sanitizedTime);
    setAutoGameResult({ status: "running", title: "Saving Auto Updates" });
    const requestedEnabled = autoGameEnabled;
    try {
      const final = await waitForTaskSilently((await updatesApi.saveAutoGame({ enabled: requestedEnabled, time: sanitizedTime, confirmation: "SAVE AUTO GAME UPDATES" })).task);
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
      setAutoGameResult({ status: "failed", title: "Auto Updates Save Failed", details: error instanceof Error ? error.message : String(error) });
    }
  }
  async function loadPreviousStack() {
    const result = await updatesApi.previousStack();
    setPreviousStack(parseReleaseRows(result.stdout || ""));
    setPreviousStackReason(Number(result.exitCode || 0) === 0 ? "" : result.stderr || result.stdout || "Previous stack list unavailable");
  }
  useEffect(() => {
    refreshGameStatus();
    refreshStackStatus();
    loadAutoGame().catch((error) => setAutoGame({ stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 }));
    loadPreviousStack().catch((error) => setPreviousStackReason(error instanceof Error ? error.message : String(error)));
  }, []);
  useEffect(() => {
    if (gameUpdateTask?.status !== "succeeded") return;
    const id = window.setTimeout(() => setGameUpdateTask(null), 10400);
    return () => window.clearTimeout(id);
  }, [gameUpdateTask?.id, gameUpdateTask?.status]);
  useEffect(() => {
    if (stackUpdateTask?.status !== "succeeded") return;
    const id = window.setTimeout(() => setStackUpdateTask(null), 10400);
    return () => window.clearTimeout(id);
  }, [stackUpdateTask?.id, stackUpdateTask?.status]);
  useEffect(() => {
    if (!autoGameResult || autoGameResult.status === "running" || autoGameResult.status === "failed") return;
    const id = window.setTimeout(() => setAutoGameResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [autoGameResult?.status, autoGameResult?.title]);
  const gameUpdateRunning = Boolean(gameUpdateTask && !isTerminalTask(gameUpdateTask.status));
  const gameCanApply = canApplyUpdateStatus(gameStatus) && !gameUpdateRunning;
  const stackUpdateRunning = Boolean(stackUpdateTask && !isTerminalTask(stackUpdateTask.status));
  const stackCanApply = canApplyUpdateStatus(stackStatus) && !stackUpdateRunning;
  return <section className="panel">
    <h2>Updates</h2>
    <div className="action-sections">
      <section className="action-section">
        <div className="panel-title"><h4>Game Update</h4><StatusPill value={gameStatus.status} /></div>
        <KeyValueGrid items={[["Current Build", updateDisplayValue(gameStatus, "current")], ["Latest Build", updateDisplayValue(gameStatus, "latest")], ["Status", gameStatus.status]]} />
        {gameStatus.status === "Check Failed" && gameStatus.reason && <p className="danger-note">{gameStatus.reason}</p>}
        {gameStatus.status === "Version details unavailable" && <p className="muted">{gameStatus.reason}</p>}
        <div className="action-line">
          <button disabled={gameUpdateRunning} onClick={checkGame}>Refresh Game Check</button>
          {gameCanApply && <button className="update-action" onClick={applyGameUpdate}>Apply Game Update</button>}
        </div>
        {gameUpdateTask && <GameUpdateProgress task={gameUpdateTask} repairTask={gameSteamcmdFixTask} onRetry={applyGameUpdate} onFixSteamcmd={fixSteamcmd} />}
      </section>
      <section className="action-section">
        <div className="panel-title"><h4>Stack Update</h4><StatusPill value={stackStatus.status} /></div>
        <KeyValueGrid items={[["Current Version", updateDisplayValue(stackStatus, "current")], ["Latest Version", updateDisplayValue(stackStatus, "latest")], ["Status", stackStatus.status]]} />
        {stackStatus.status === "Check Failed" && stackStatus.reason && <p className="danger-note">{stackStatus.reason}</p>}
        {stackStatus.status === "Version details unavailable" && <p className="muted">{stackStatus.reason}</p>}
        <div className="action-line">
          <button disabled={stackUpdateRunning} onClick={checkStack}>Refresh Stack Check</button>
          {stackCanApply && <button className="update-action" onClick={applyStackUpdate}>Apply Stack Update</button>}
        </div>
        {stackUpdateTask && <StackUpdateProgress task={stackUpdateTask} onRetry={applyStackUpdate} />}
      </section>
      <section className="action-section">
        <div className="panel-title"><h4>Automatic Game Updates</h4><StatusPill value={autoGameStatusLabel} /></div>
        <KeyValueGrid items={[
          ["Current Status", autoGameStatusLabel],
          ["Check Time (Local Server Time)", toHourMinuteTime(autoGameValues.auto_update_time || autoGameTime)],
          ["Timer", autoGameDisplayTimerLabel]
        ]} />
        {commandStatusSummary(autoGame).reason && <p className="danger-note">{commandStatusSummary(autoGame).reason}</p>}
        <div className="action-line schedule-action-line auto-game-action-line">
          <label className="checkbox-row"><input type="checkbox" disabled={autoGameLoading || autoGameSaving} checked={autoGameEnabled} onChange={(event) => setAutoGameEnabled(event.target.checked)} /> Enable</label>
          <label className="compact-select">Daily Check Time<input type="time" step="60" pattern="[0-2][0-9]:[0-5][0-9]" disabled={autoGameSaving} value={autoGameTime} onChange={(event) => setAutoGameTime(sanitizeTimeInput(event.target.value))} placeholder="05:00" /></label>
          <button disabled={autoGameLoading || autoGameSaving} onClick={saveAutoGame}>Save Auto Updates</button>
          {autoGameResult && <span className={`inline-task-result result-${autoGameResult.status === "succeeded" ? "ok" : autoGameResult.status === "failed" ? "fail" : "running"}`}>
            <strong className={autoGameResult.status === "running" ? "loading-dots" : ""}>{autoGameResult.title}</strong>
          </span>}
        </div>
      </section>
      <section className="action-section">
        <div className="panel-title"><h4>Restore Previous Stack</h4><button onClick={loadPreviousStack}>Refresh Releases</button></div>
        <p className="danger-note">Restoring the previous stack changes the RedBlink stack version. Use only after reviewing backups and release history.</p>
        {previousStackReason && <p className="danger-note">{previousStackReason}</p>}
        {previousStack.length ? <DataTable rows={previousStack.slice(0, 3)} columns={["version", "date", "title"]} /> : <div className="empty">No previous stack releases found.</div>}
        <div className="action-line restore-stack-line">
          <button className="danger" disabled={previousStack.length < 2} onClick={async () => {
            const confirmation = window.prompt("Type RESTORE PREVIOUS STACK to restore the previous stack release.");
            if (confirmation !== "RESTORE PREVIOUS STACK") return;
            setTask((await updatesApi.restorePreviousStack(confirmation)).task);
          }}>Restore Previous Stack</button>
          {previousStack[1]?.version && <span className="muted">Previous Release: {previousStack[1].version}</span>}
        </div>
      </section>
    </div>
  </section>;
}

function SettingsPanel() {
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  async function refresh() {
    setSettings(await api<Record<string, unknown>>("/api/settings"));
  }
  useEffect(() => {
    refresh().catch(() => undefined);
  }, []);
  return <section className="panel">
    <div className="panel-title"><h2>Settings</h2><button onClick={refresh}>Refresh Runtime Settings</button></div>
    <RuntimeSettingsSummary settings={settings} />
  </section>;
}

function HomeHealthCards({ status, readiness, readinessWarning, loading, runningAction, taskResult, funcomTokenResult }: { status: string; readiness: string; readinessWarning: string; loading: boolean; runningAction: "start" | "stop" | "restart" | ""; taskResult: HomeTaskResult | null; funcomTokenResult: HomeTaskResult | null }) {
  const funcomTokenCheckRunning = funcomTokenResult?.status === "running";
  const summary = summarizeHomeStatus(status, readiness, readinessWarning, loading, runningAction, taskResult, !funcomTokenCheckRunning && (isFuncomTokenAuthFailure(funcomTokenResult) || hasPersistedFuncomTokenAuthFailure()));
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

function DoctorSummary({ text, readiness }: { text: string; readiness: string }) {
  const readinessHealthy = /^READY:/m.test(readiness);
  const issues = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^WARN\s+/i.test(line)).filter((line) => {
    if (!readinessHealthy) return true;
    return !/Director heartbeat not seen in recent logs|Gateway DB monitoring not seen in recent logs/i.test(line);
  }).slice(0, 6);
  return <section className="action-section doctor-section">
    <div className="panel-title"><h4>Doctor Diagnostics</h4></div>
    {text ? <p>{issues.length ? `${issues.length} diagnostic item${issues.length === 1 ? "" : "s"} need attention.` : "No obvious warning lines detected in the latest doctor output."}</p> : <p>Run Doctor to show diagnostics.</p>}
    {issues.length > 0 && <div className="check-grid">{issues.map((issue, index) => {
      const advice = doctorAdvice(issue);
      return <article className="check-card" key={`${issue}-${index}`}><div><strong>{advice.title}</strong><p>{advice.message}</p>{advice.nextStep && <span className="muted">{advice.nextStep}</span>}</div><StatusPill value="WARN" /></article>;
    })}</div>}
  </section>;
}

function doctorAdvice(issue: string) {
  const clean = friendlyIssueLine(issue);
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
  return {
    title: "Diagnostic Warning",
    message: clean,
    nextStep: "Open the relevant service logs for recent context.",
    status: inferStatus(issue)
  };
}

function PlayerSummary({ detail, fallback, dbPlayerId, actionPlayerId }: { detail: Record<string, unknown> | null; fallback: Record<string, unknown>; dbPlayerId: string; actionPlayerId: string }) {
  const player = ((detail?.player as Record<string, unknown> | undefined) || fallback) as Record<string, unknown>;
  return <section className="action-section">
    <h4>Player Summary</h4>
    <KeyValueGrid items={[
      ["Character", firstDefined(player.character_name, player.name, fallback.character_name)],
      ["Online status", firstDefined(player.online_status, fallback.online_status)],
      ["Map", firstDefined(player.map, player.world, fallback.map)],
      ["DB actor/player ID", dbPlayerId || "missing"],
      ["Admin action ID", actionPlayerId || "missing"],
      ["Account ID", firstDefined(player.account_id, fallback.account_id)],
      ["Funcom/FLS ID", firstDefined(player.funcom_id, player.fls_id, fallback.funcom_id, fallback.fls_id)],
      ["Controller ID", firstDefined(player.player_controller_id, fallback.player_controller_id)]
    ]} />
  </section>;
}

function PlayerCapabilities({ capabilities }: { capabilities: Record<string, unknown> }) {
  const keys = ["inventory", "currency", "factions", "specs", "progression", "events", "stats", "history"];
  return <section className="action-section">
    <h4>Detected Capabilities</h4>
    <div className="badge-row">
      {keys.map((key) => {
        const value = capabilities[key];
        const label = value === true ? "Available" : value === false ? "Unavailable" : value === undefined ? "Unknown" : String(value);
        return <span className={`badge ${value === true ? "badge-pass" : value === false ? "badge-fail" : "badge-info"}`} key={key}>{friendlyTabName(key)}: {label}</span>;
      })}
    </div>
  </section>;
}

function RuntimeSettingsSummary({ settings }: { settings: Record<string, unknown> | null }) {
  const config = (settings?.config as Record<string, unknown> | undefined) || {};
  const files = (settings?.files as Record<string, unknown> | undefined) || {};
  return <div className="action-sections">
    <section className="action-section">
      <h4>Runtime Configuration</h4>
      <KeyValueGrid items={[
        ["App name", firstDefined(config.appName, config.app_name, "Arrakis Server Console")],
        ["Repo root", config.repoRoot],
        ["Auth", config.authEnabled === false ? "Disabled" : "Enabled"],
        ["Secure Cookies", booleanLabel(config.secureCookies)],
        ["Host Bootstrap", booleanLabel(config.allowHostBootstrap)],
        ["Mock Mode", booleanLabel(config.mockMode)],
        ["Runtime path", config.runtimePath],
        ["Task retention", config.taskRetention]
      ]} />
    </section>
    <section className="action-section">
      <h4>Files Checklist</h4>
      <div className="check-grid">{Object.entries(files).map(([key, value]) => <article className="check-card" key={key}><div><strong>{friendlyFileLabel(key)}</strong><p>{value ? "Found" : "Missing"}</p></div><StatusPill value={value ? "Ready" : "Attention Needed"} /></article>)}</div>
      {!Object.keys(files).length && <p>Runtime file checks have not loaded yet.</p>}
    </section>
  </div>;
}

function MapCommandSummary({ text }: { text: string }) {
  const parsed = parseJsonMaybe(text);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    return <section className="result-panel">
      <strong>Map Status Summary</strong>
      <KeyValueGrid items={Object.entries(record).map(([key, value]) => [key, summarizeValue(value)])} />
    </section>;
  }
  const status = text ? inferStatus(text) : "Unknown";
  return <section className="result-panel">
    <div className="panel-title"><strong>Map Command Result</strong><StatusPill value={status} /></div>
    <p>{text ? summarizeCommandText(text) : "Map, autoscaler, memory, Sietch, or Deep Desert state is loading or unavailable."}</p>
  </section>;
}

function parseMapRows(text: string): Record<string, unknown>[] {
  const parsed = parseJsonMaybe(text);
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    const candidate = firstArray(record.maps, record.rows, record.services, record.servers);
    if (candidate) return candidate.map((row) => {
      const item = row as Record<string, unknown>;
      return {
        map: firstDefined(item.map, item.name, item.service, item.id),
        status: firstDefined(item.status, item.ready, item.state, "Checked"),
        mode: firstDefined(item.mode, item.serverMode, item.kind, "Unknown"),
        memory: firstDefined(item.memory, item.mem, item.memoryLimit, "Unknown"),
        partitionId: firstDefined(item.partitionId, item.partition_id, item.partition, "")
      };
    });
  }
  const rows = stripAnsi(text).split(/\r?\n/).map((line) => line.trim()).filter((line) => {
    if (!line || /^=+/.test(line) || /^MAP\s+/i.test(line)) return false;
    return /\bCurrent:\s*(dynamic|always-on)\b/i.test(line) || /\bPartitions:\s*\d+/i.test(line) || /\bAssigned:\s*\d+/i.test(line);
  }).map((line) => {
    const map = line.split(/\s+/)[0];
    const assigned = line.match(/\bAssigned:\s*(\d+)/i)?.[1] || "";
    const partitions = line.match(/\bPartitions:\s*(\d+)/i)?.[1] || "";
    return {
      map,
      status: assigned && Number(assigned) > 0 ? "Assigned" : "Not Running",
      mode: friendlyMapMode(line.match(/\bCurrent:\s*(dynamic|always-on)\b/i)?.[1] || line.match(/\b(dynamic|always-on)\b/i)?.[1] || ""),
      partitions: partitions || "Unknown",
      assigned: assigned || "Unknown",
      memory: line.match(/\b\d+\s*[gGmM][bB]?\b/)?.[0] || "",
      dimensions: partitions ? `${partitions} partition${Number(partitions) === 1 ? "" : "s"}` : "Not Available"
    };
  });
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = String(row.map);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 50);
}

function parseMemoryRows(text: string): Record<string, unknown>[] {
  return stripAnsi(text).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^===|^Default memory|^MAP\s+MEMORY/i.test(line)).map((line) => {
    const match = line.match(/^(.+?)\s{2,}(.+)$/);
    if (!match) return null;
    return { map: match[1].trim(), memory: formatMemoryValue(match[2].trim()) };
  }).filter(Boolean) as Record<string, unknown>[];
}

function parseServerPartitionRows(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const rawLine of stripAnsi(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^\d+\s*\|/.test(line)) continue;
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length < 9) continue;
    const [partitionId, map, dimension, label, assignedServer, gamePort, igwPort, ready, alive] = parts;
    rows.push({
      partitionId,
      map,
      dimension,
      label,
      assignedServer,
      gamePort,
      igwPort,
      ready,
      alive,
      status: mapRuntimeStatus({ assignedServer, ready, alive })
    });
  }
  return rows;
}

function mergeMapAndMemoryRows(mapsText: string, memoryText: string, serversText = ""): Record<string, unknown>[] {
  const rows = new globalThis.Map<string, Record<string, unknown>>();
  const serverRows = new globalThis.Map<string, Record<string, unknown>>();
  for (const row of parseServerPartitionRows(serversText)) {
    const map = String(row.map || "");
    if (!map) continue;
    const existing = serverRows.get(map);
    serverRows.set(map, {
      ...row,
      status: strongestMapStatus(String(existing?.status || ""), String(row.status || "")),
      dimensions: existing?.dimensions ? `${String(existing.dimensions)}, ${String(row.label || row.partitionId)}` : String(row.label || row.partitionId || "")
    });
  }
  for (const row of parseMemoryRows(memoryText)) {
    const map = String(row.map || "");
    if (!map) continue;
    const server = serverRows.get(map);
    rows.set(map, {
      map,
      status: server?.status || "Not Available",
      mode: map === "Survival_1" || map === "Overmap" ? "Core Map" : "Not Listed",
      memory: row.memory,
      partitionId: server?.partitionId || "",
      dimensions: server?.dimensions || "Not Available"
    });
  }
  for (const row of parseMapRows(mapsText)) {
    const map = String(row.map || "");
    if (!map) continue;
    const server = serverRows.get(map);
    rows.set(map, {
      ...(rows.get(map) || {}),
      ...row,
      status: server?.status || row.status || rows.get(map)?.status || "Not Available",
      mode: row.mode || rows.get(map)?.mode || "Not Available",
      memory: row.memory ? formatMemoryValue(String(row.memory)) : rows.get(map)?.memory || "Not Available",
      partitionId: row.partitionId || row.partition || server?.partitionId || rows.get(map)?.partitionId || "",
      dimensions: row.dimensions || server?.dimensions || rows.get(map)?.dimensions || "Not Available"
    });
  }
  return Array.from(rows.values());
}

function mapRuntimeStatus(row: { assignedServer?: unknown; ready?: unknown; alive?: unknown }) {
  const assigned = Boolean(String(row.assignedServer || "").trim());
  const ready = /^true$/i.test(String(row.ready || "").trim());
  const alive = /^true$/i.test(String(row.alive || "").trim());
  if (ready) return "Ready";
  if (alive) return "Running";
  if (assigned) return "Starting";
  return "Not Running";
}

function strongestMapStatus(a: string, b: string) {
  const order = ["Not Available", "Not Running", "Starting", "Running", "Ready"];
  return order.indexOf(b) > order.indexOf(a) ? b : a || b;
}

function friendlyMapMode(value: string) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "dynamic") return "Dynamic";
  if (normalized === "always-on") return "Always On";
  if (normalized === "core map" || normalized === "core") return "Core Map";
  return value ? titleCase(value) : "Not Available";
}

function modeInputValue(value: string) {
  const normalized = String(value || "").toLowerCase();
  if (/core/.test(normalized)) return "always-on";
  if (/always/.test(normalized)) return "always-on";
  return "dynamic";
}

function memoryInputValue(value: string) {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)\s*(GB|GiB?|MB|MiB?|[gGmM])?/);
  if (!match) return "8";
  return match[1];
}

function formatMemoryValue(value: string) {
  const text = String(value || "").trim();
  if (!text) return "Not Available";
  const isDefault = /\bdefault\b/i.test(text);
  const match = text.match(/(\d+(?:\.\d+)?)\s*(GiB?|GB|MiB?|MB|[gGmM])?/i);
  if (!match) return text;
  const unit = (match[2] || "GB").toLowerCase();
  const displayUnit = unit.startsWith("m") ? "MB" : "GB";
  return `${match[1]} ${displayUnit}${isDefault ? " (Default)" : ""}`;
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

function parseReleaseRows(text: string) {
  return stripAnsi(text).split(/\r?\n/).map((line) => {
    const [version, date, title] = line.trim().split(/\t+/);
    return version ? { version, date: date || "", title: title || "" } : null;
  }).filter(Boolean).sort((a, b) => String(b?.date || "").localeCompare(String(a?.date || ""))) as Record<string, string>[];
}

function parseUserSettingRows(text: string) {
  return stripAnsi(text).split(/\r?\n/).map((line) => {
    const [key, value] = line.split(/\t/);
    if (!key) return null;
    return { setting: friendlySettingName(key), value: value || "" };
  }).filter(Boolean) as Record<string, string>[];
}

function friendlySettingName(key: string) {
  return key.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function firstArray(...values: unknown[]) {
  return values.find((value) => Array.isArray(value)) as unknown[] | undefined;
}

function friendlyMapName(value: unknown) {
  const text = String(value || "");
  return text.replace("Survival_1", "Survival 1").replace("DeepDesert_1", "Deep Desert 1").replaceAll("_", " ");
}

function KeyValueGrid({ items }: { items: [string, unknown][] }) {
  const visible = items.filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!visible.length) return <div className="empty">No summary values available.</div>;
  return <div className="key-value-grid">{visible.map(([key, value]) => <div className="key-value-item" key={key}>
    <span>{key}</span>
    <strong>{formatCell(value)}</strong>
  </div>)}</div>;
}

function StatusPill({ value }: { value: unknown }) {
  const text = formatDisplayValue(value || "Unknown");
  const normalized = normalizeStatus(text);
  return <span className={`badge badge-${normalized}`}>{text}</span>;
}

function TechnicalDetails({ text, title = "Technical details", className = "" }: { text: string; title?: string; className?: string }) {
  return <details className={`technical-details ${className}`.trim()}><summary>{title}</summary><pre className="mini-output">{text}</pre></details>;
}

function OutputPanel({ title, text, action, onAction }: { title: string; text: string; action: string; onAction: () => void }) {
  return <section className="panel"><h2>{title}</h2><button onClick={onAction}>{action}</button><TechnicalDetails text={text} /></section>;
}

function DataTable({ rows, columns, onRowClick, action, actionClassName = "", tableClassName = "" }: { rows: Record<string, unknown>[]; columns?: string[]; onRowClick?: (row: Record<string, unknown>) => void; action?: (row: Record<string, unknown>) => React.ReactNode; actionClassName?: string; tableClassName?: string }) {
  const cols = columns?.length ? columns : Array.from(new Set(rows.flatMap((row) => Object.keys(row)))).slice(0, 8);
  if (!rows.length) return <div className="empty">No rows.</div>;
  return <div className="table-wrap"><table className={tableClassName}><thead><tr>{cols.map((col) => <th key={col}>{friendlyColumnName(col)}</th>)}{action && <th className={actionClassName}>Actions</th>}</tr></thead><tbody>{rows.map((row, index) => <tr key={index} onClick={() => onRowClick?.(row)} className={onRowClick ? "clickable" : ""}>{cols.map((col) => <td key={col}>{formatCell(row[col])}</td>)}{action && <td className={actionClassName}>{action(row)}</td>}</tr>)}</tbody></table></div>;
}

function formatCell(value: unknown) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return formatDisplayValue(value);
}

function friendlyColumnName(value: string) {
  const labels: Record<string, string> = {
    actor_id: "Actor ID",
    character_name: "Character Name",
    account_id: "Account ID",
    action_player_id: "Admin Action ID",
    online_status: "Online Status",
    fls_id: "FLS ID",
    display_name: "Name",
    category: "Category",
    id: "ID",
    raw_name: "Raw Name",
    backupName: "Backup Name",
    battlegroupId: "Battlegroup ID",
    vehicle: "Vehicle",
    actor: "Actor",
    templates: "Templates",
    skillModule: "Skill Module",
    maxLevel: "Max Level",
    itemName: "Item Name",
    itemId: "Item ID",
    quantity: "Quantity",
    durability: "Durability",
    created: "Created",
    name: "Name",
    type: "Type",
    source: "Source",
    time: "Time",
    action: "Action",
    target: "Target/User",
    status: "Status",
    summary: "Summary"
  };
  return labels[value] || value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function friendlyFileLabel(value: string) {
  return {
    env: "Environment File",
    token: "Auth Token",
    battlegroup: "Battlegroup",
    duneScript: "Dune Script"
  }[value] || friendlyColumnName(value);
}

function friendlyTabName(value: string) {
  return {
    inventory: "Inventory",
    currency: "Currency",
    factions: "Factions",
    specs: "Specs",
    position: "Position",
    progression: "Progression",
    events: "Events",
    stats: "Stats",
    history: "History"
  }[value] || friendlyColumnName(value);
}

function formatTechnicalText(sections: [string, string][]) {
  return sections.map(([title, text]) => `# ${title}\n${text}`).join("\n\n");
}

function summarizeHomeStatus(status: string, readiness: string, readinessWarning: string, loading: boolean, runningAction: "start" | "stop" | "restart" | "" = "", taskResult: HomeTaskResult | null = null, funcomTokenAuthFailure = false) {
  void readinessWarning;
  const serverState = getHomeServerState(status, readiness);
  const bootStarting = isHomeBootStarting(status, readiness);
  const isStarting = runningAction === "start" || runningAction === "restart" || bootStarting;
  const actionFailed = taskResult?.status === "failed" && !serverState.running;
  const actionStopped = taskResult?.status === "stopped";
  const rawOverall = findLineValue(status, ["overall"]);
  const liveOverall = /^READY:/m.test(readiness) ? "OK" : friendlyHomeOverall(rawOverall || (readiness ? "Readiness checked" : readinessWarning ? "Status loaded, readiness warning" : status ? "Status loaded" : loading ? "Checking" : "Unknown"));
  const transitionOverall = runningAction === "restart" ? "Restarting" : runningAction === "stop" ? "Stopping" : isStarting ? "Starting" : "";
  const rawContainers = preferKnownHomeHealth(summarizeContainers(status), summarizeReadinessContainers(readiness));
  const rawListeners = preferKnownHomeHealth(summarizeListeners(status), summarizeReadinessListeners(readiness));
  const rawDatabase = preferKnownHomeHealth(summarizeDatabase(status), summarizeReadinessDatabase(readiness));
  const rawGames = preferKnownHomeHealth(summarizeGameServers(status), summarizeReadinessGameServers(readiness));
  const rawRabbit = preferKnownHomeHealth(summarizeRabbit(status), summarizeReadinessRabbit(readiness));
  const rawFls = preferKnownHomeHealth(summarizeFls(status), summarizeReadinessFls(readiness));
  const warmingOverall = /^Warming$/i.test(rawGames.label) ? "Warming" : "";
  const overall = isStarting ? transitionOverall : runningAction ? transitionOverall : serverState.stopped || actionStopped ? "Stopped" : warmingOverall || liveOverall;
  const attentionHealth = !isStarting && (serverState.stopped || actionStopped || actionFailed) ? attentionHomeHealthCards() : null;
  const transitionAction: "start" | "stop" | "restart" | "" = runningAction || (bootStarting ? "start" : "");
  const containers = transitionHomeHealthCard(rawContainers, transitionAction) || attentionHealth?.containers || rawContainers;
  const listeners = transitionHomeHealthCard(rawListeners, transitionAction) || attentionHealth?.listeners || rawListeners;
  const database = transitionHomeHealthCard(rawDatabase, transitionAction) || attentionHealth?.database || rawDatabase;
  const games = transitionHomeHealthCard(rawGames, transitionAction) || attentionHealth?.games || rawGames;
  const rabbit = transitionHomeHealthCard(rawRabbit, transitionAction) || attentionHealth?.rabbit || rawRabbit;
  const fls = funcomTokenAuthFailure
    ? { label: "Token Mismatch Detected", status: "FAILED", detail: "" }
    : transitionHomeHealthCard(rawFls, transitionAction) || attentionHealth?.fls || rawFls;
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

function isHomeActionComplete(status: string, readiness: string) {
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

function isHomeStopComplete(status: string, readiness: string) {
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
  const label = runningAction === "restart" ? "Restarting" : "Getting Ready";
  const status = runningAction === "restart" ? "WARN" : "Starting";
  return { label, status, detail: "" };
}

function preferKnownHomeHealth(primary: { label: string; status: string; detail: string }, fallback: { label: string; status: string; detail: string }) {
  return /^Unknown$/i.test(primary.label) && !/^Unknown$/i.test(fallback.label) ? fallback : primary;
}

function getHomeServerState(status: string, readiness: string) {
  const text = `${status}\n${readiness}`;
  const overall = findLineValue(status, ["overall"]);
  const containerLines = sectionLines(status, "Containers").filter((line) => !/^SERVICE\s+STATUS/i.test(line));
  const allContainersMissing = containerLines.length >= 4 && containerLines.every((line) => /\b(missing|stopped|exited|dead)\b/i.test(line));
  const bootStarting = isHomeBootStarting(status, readiness);
  const runningSignals = [
    !allContainersMissing && /^READY:/m.test(readiness),
    !allContainersMissing && /Overall:\s*(READY|WARMING)/i.test(status),
    !allContainersMissing && /\b(READY|WARMING)\b/i.test(overall),
    /\bUp\s+\d+|\blistening\b|\bcontainer\s+\S+/i.test(text) && !/\b(stopped|exited|missing)\b/i.test(text)
  ];
  const stoppedSignals = [
    /\b(server|stack)\s+(is\s+)?(stopped|not running|offline)\b/i.test(text),
    /Overall:\s*(STOPPED|OFFLINE|NOT RUNNING)/i.test(status),
    /\bNo\s+(running\s+)?containers\b/i.test(text),
    /\b(all|dune)\s+containers\s+(are\s+)?(stopped|down)\b/i.test(text),
    allContainersMissing
  ];
  const stopped = !bootStarting && stoppedSignals.some(Boolean);
  const running = !stopped && runningSignals.some(Boolean);
  const starting = bootStarting || (!stopped && !running && (/\bUp\s+\d+/i.test(text) || /\b(WARMING|WAIT|STARTING)\b/i.test(text)));
  return { running, stopped, starting };
}

function isHomeBootStarting(status: string, readiness: string) {
  const text = `${status}\n${readiness}`;
  if (!text.trim()) return false;
  if (/\b(server|stack)\s+(is\s+)?(stopped|offline)\b/i.test(text) || /\bNo\s+(running\s+)?containers\b/i.test(text)) return false;
  if (/Overall:\s*(READY|STOPPED|OFFLINE)/i.test(status) || /^READY:/m.test(readiness)) return false;
  const containerLines = sectionLines(status, "Containers").filter((line) => !/^SERVICE\s+STATUS/i.test(line));
  const anyContainerUp = containerLines.some((line) => /\bUp\b/i.test(line));
  const missingContainers = containerLines.filter((line) => /\b(missing|stopped|exited|dead|not running)\b/i.test(line)).length;
  if (containerLines.length >= 8 && missingContainers >= 8 && !anyContainerUp) return false;
  const listenerLines = sectionLines(status, "Listeners").filter((line) => !/^CHECK\s+PORT\s+STATUS/i.test(line));
  const missingListeners = listenerLines.filter((line) => /\bMISSING\b/i.test(line)).length;
  const gameServersStopped = /Survival_1\s+NOT RUNNING/i.test(text) && /Overmap\s+NOT RUNNING/i.test(text);
  if (gameServersStopped && listenerLines.length > 0 && missingListeners === listenerLines.length && !anyContainerUp) return false;
  if (/\b(WARMING|WAIT|STARTING)\b/i.test(text)) return true;
  const readinessStarting = /^\s*(WARN|FAIL)\s+container\s+dune-/im.test(readiness) && !/^\s*OK\s+container\s+dune-server-(survival-1|overmap)\b/im.test(readiness);
  return anyContainerUp || readinessStarting || (containerLines.length > 0 && missingContainers > 0) || (listenerLines.length > 0 && missingListeners > 0);
}

function homeOverallBadge(value: string) {
  if (/^restarting$/i.test(value)) return "WARN";
  if (/^stopping$/i.test(value)) return "WARN";
  if (/^stopped$/i.test(value)) return "WARN";
  if (/^starting$/i.test(value)) return "Starting";
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

function taskTechnicalDetails(task: Task) {
  return task.logLines.map((line) => line.line).filter(Boolean).join("\n") || task.errorMessage || "";
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
  for (const rawLine of stripAnsi(text).split(/\r?\n/)) {
    const line = stripAnsi(rawLine).trim();
    for (const key of keys) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = line.match(new RegExp(`^\\s*${escaped}\\s*[:=]\\s*(.+)$`, "i"));
      if (match) return match[1].trim();
    }
  }
  return "";
}

function summarizeSection(text: string, section: string) {
  const lines = sectionLines(text, section).filter((line) => !/^service\s+status$/i.test(line) && !/^check\s+port\s+status$/i.test(line));
  if (!lines.length) return { label: "Unknown", status: "Unknown" };
  const bad = lines.filter((line) => /missing|stopped|not running|error|fail|wait|warming|0$/i.test(line));
  if (bad.length) return { label: "Attention Needed", status: /error|fail|missing|stopped|not running/i.test(bad.join("\n")) ? "Failed" : "Attention Needed", detail: friendlyIssueLine(bad[0]) };
  return { label: "Ready", status: "Ready", detail: "" };
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

function stripAnsi(text: string) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function summarizeSubsystem(text: string, keywords: string[]) {
  const lines = text.split(/\r?\n/).filter((line) => keywords.some((keyword) => line.toLowerCase().includes(keyword)));
  if (!lines.length) return "Unknown";
  return inferStatus(lines.join("\n"));
}

function inferStatus(text: string) {
  if (!text) return "Unknown";
  if (/failed|failure|error|fatal|unhealthy|down|missing|cannot|could not/i.test(text)) return "Failed";
  if (/warning|warn|not ready|starting|waiting|partial|unavailable|attention/i.test(text)) return "Attention Needed";
  if (/ready|ok|healthy|running|listening|up|succeeded|success|checked|found/i.test(text)) return "Ready";
  return "Unknown";
}

function normalizeStatus(value: string) {
  if (/ready|ok|healthy|running|up|succeeded|success|checked|found|available|enabled/i.test(value)) return "pass";
  if (/failed|failure|error|fatal|unhealthy|down|missing|blocked|disabled/i.test(value)) return "fail";
  if (/attention|warning|warn|not ready|starting|waiting|partial|unverified|experimental|unavailable|checking/i.test(value)) return "warn";
  return "info";
}

function formatLiveToolResult(result: unknown) {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  if (record.supported === false) return `Unsupported: ${String(record.reason || record.error || "This live tool is not available.")}`;
  if (record.ok === false) return `Failed: ${String(record.error || record.stderr || "The live tool did not complete.")}`;
  const note = String(record.note || "");
  if (/broadcast/i.test(note) || /publish=ok/i.test(String(record.stdout || ""))) {
    return note || "RabbitMQ publish succeeded, but in-game display has not been verified.";
  }
  if (record.ok === true) return "Live tool request completed. Review technical details if troubleshooting is needed.";
  return summarizeCommandText(JSON.stringify(record || result));
}

function formatMutationResult(result: unknown) {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  if (record.supported === false) return `Unsupported: ${String(record.reason || record.error || "This action is not available.")}`;
  if (record.ok === false) return `Failed: ${String(record.error || record.reason || "The action did not complete.")}`;
  if (record.summary) return String(record.summary);
  if (record.status) return `Action status: ${String(record.status)}`;
  if (record.backup) return "Action completed after creating a database backup.";
  if (record.ok === true) return "Action completed.";
  return summarizeCommandText(JSON.stringify(record || result));
}

function summarizeCommandText(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return "No output.";
  const important = lines.filter((line) => /local build|remote build|current stack version|latest release|update available|no update|already latest|up to date|ok|ready|warning|error|failed|success|blocked|unsupported|publish/i.test(line));
  return (important[0] || lines[0]).slice(0, 240);
}

function parseJsonMaybe(text: string) {
  if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function summarizeValue(value: unknown) {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if ("exitCode" in record) return `exit ${String(record.exitCode)}`;
    if ("stdout" in record) return summarizeCommandText(String(record.stdout || record.stderr || ""));
    return Array.isArray(value) ? `${value.length} rows` : `${Object.keys(record).length} fields`;
  }
  return value;
}

function booleanLabel(value: unknown) {
  if (value === true) return "Enabled";
  if (value === false) return "Disabled";
  return value ?? "Unknown";
}

function titleCase(value: string) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function titleCaseWords(value: string) {
  const smallWords = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "nor", "of", "on", "or", "the", "to", "with"]);
  const acronyms = new Set(["pvp", "pve"]);
  return String(value || "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().split(" ").map((word, index) => {
    const lower = word.toLowerCase();
    if (acronyms.has(lower)) return lower.toUpperCase();
    if (index > 0 && smallWords.has(lower)) return lower;
    return lower ? lower.charAt(0).toUpperCase() + lower.slice(1) : word;
  }).join(" ");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatTimerStatus(value: string) {
  const text = String(value || "").trim();
  if (/^not installed$/i.test(text)) return "Not Installed";
  return titleCase(text);
}

function formatDisplayValue(value: unknown) {
  const text = String(value);
  if (/^stopped$/.test(text)) return "Stopped";
  if (/^unset$/.test(text)) return "Unset";
  return text;
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

function firstDefined(...values: unknown[]) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function parseVehicleCatalog(text: string) {
  const catalog: Record<string, string[]> = {};
  let currentVehicle = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^vehicle/i.test(line) || /^templates?$/i.test(line)) continue;
    if (/^actor:/i.test(line)) continue;
    if (/^templates?:/i.test(line) && currentVehicle) {
      catalog[currentVehicle] = uniqueValues((catalog[currentVehicle] || []).concat(splitTemplateList(line.replace(/^templates?\s*:?/i, ""))));
      continue;
    }
    const colon = line.match(/^([A-Za-z][A-Za-z0-9_-]+)\s*:\s*(.+)$/);
    if (colon) {
      currentVehicle = colon[1];
      catalog[currentVehicle] = uniqueValues((catalog[currentVehicle] || []).concat(splitTemplateList(colon[2])));
      continue;
    }
    const bullet = line.match(/^[-*]\s*(.+)$/);
    if (bullet && currentVehicle) {
      catalog[currentVehicle] = uniqueValues((catalog[currentVehicle] || []).concat(splitTemplateList(bullet[1])));
      continue;
    }
    if (/^[A-Za-z][A-Za-z0-9_-]+$/.test(line)) {
      if (!currentVehicle || /^[A-Z][a-z]/.test(line)) {
        currentVehicle = line;
        catalog[currentVehicle] ||= [];
      } else if (currentVehicle) {
        catalog[currentVehicle] = uniqueValues((catalog[currentVehicle] || []).concat(line));
      }
    }
  }
  return Object.fromEntries(Object.entries(catalog).filter(([vehicle]) => vehicle));
}

function parseCatalogItems(text: string): CatalogItem[] {
  const parsed = parseCatalogRows(text);
  return parsed.map((row) => ({
    name: String(row.name || row.id || "").trim(),
    id: String(row.id || "").trim(),
    category: String(row.category || row.source || "").trim()
  })).filter((item) => item.name || item.id).slice(0, 250);
}

function parseCatalogRows(text: string): Record<string, unknown>[] {
  const clean = stripAnsi(text || "");
  if (!clean.trim()) return [];
  const vehicles = parseVehicleCatalog(clean);
  if (Object.keys(vehicles).length) {
    return Object.entries(vehicles).flatMap(([vehicle, templates]) => templates.length
      ? templates.map((template) => ({ name: friendlyVehicleName(vehicle), id: template, category: "Vehicle template", source: vehicle }))
      : [{ name: friendlyVehicleName(vehicle), id: vehicle, category: "Vehicle", source: "Vehicle catalog" }]);
  }
  const rows: Record<string, unknown>[] = [];
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^[-=]{3,}$/.test(line) || /^(name|item|id|category|template)\b/i.test(line)) continue;
    const tabParts = line.split(/\t|\s{2,}/).map((part) => part.trim()).filter(Boolean);
    if (tabParts.length >= 2) {
      rows.push({ name: friendlyCatalogName(tabParts[0]), id: tabParts[1], category: tabParts[2] || "", source: tabParts.slice(3).join(" ") || "Catalog" });
      continue;
    }
    const keyValueName = line.match(/(?:name|display|item)\s*[:=]\s*([^,|]+)/i)?.[1]?.trim();
    const keyValueId = line.match(/(?:id|template)\s*[:=]\s*([^,|\s]+)/i)?.[1]?.trim();
    const category = line.match(/(?:category|source|type)\s*[:=]\s*([^,|]+)/i)?.[1]?.trim() || "";
    if (keyValueName || keyValueId) {
      rows.push({ name: friendlyCatalogName(keyValueName || keyValueId || ""), id: keyValueId || "", category, source: "Catalog" });
      continue;
    }
    const commaParts = line.split(",").map((part) => part.trim()).filter(Boolean);
    if (commaParts.length >= 2) {
      rows.push({ name: friendlyCatalogName(commaParts[0]), id: commaParts[1], category: commaParts[2] || "", source: "Catalog" });
      continue;
    }
    rows.push({ name: friendlyCatalogName(line), id: "", category: "", source: "Catalog" });
  }
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${String(row.name)}-${String(row.id)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return String(row.name || row.id).trim();
  }).slice(0, 500);
}

function parseSkillModuleRows(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  let current: Record<string, unknown> | null = null;
  for (const rawLine of stripAnsi(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^[-=]{3,}$/.test(line)) continue;
    const header = line.match(/^(.+?)\s+\[([^\]]+)\]$/);
    if (header) {
      if (current) rows.push(current);
      current = { skillModule: friendlyCatalogName(header[1].trim()), category: header[2].trim(), maxLevel: "", id: "" };
      continue;
    }
    if (!current) continue;
    const id = line.match(/^id:\s*(.+)$/i);
    if (id) {
      current.id = id[1].trim();
      continue;
    }
    const maxLevel = line.match(/^max level:\s*(.+)$/i);
    if (maxLevel) current.maxLevel = maxLevel[1].trim();
  }
  if (current) rows.push(current);
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${String(row.skillModule)}-${String(row.id)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return String(row.skillModule || row.id).trim();
  }).slice(0, 500);
}

function friendlyCatalogName(value: string) {
  return value.replace(/^[-*]\s*/, "").replace(/^\/Game\/.*\//, "").replaceAll("_", " ").trim();
}

function friendlyVehicleName(value: string) {
  return {
    OrnithopterLight: "Light Ornithopter",
    OrnithopterMedium: "Medium Ornithopter",
    OrnithopterTransport: "Transport Ornithopter",
    ContainerVehicle: "Container Vehicle"
  }[value] || value.replaceAll("_", " ");
}

function splitTemplateList(text: string) {
  return text.split(/[,\s]+/).map((part) => part.trim()).filter((part) => /^[A-Za-z0-9_.:-]+$/.test(part));
}

function uniqueValues(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function parseServiceRows(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => !/^names\s+/i.test(line)).map((line) => {
    const [name, ...rest] = line.split(/\s{2,}|\t/).filter(Boolean);
    return { name, status: rest[0] || "", ports: rest.slice(1).join(" ") };
  }).filter((row) => row.name);
}

function parseBackupRows(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const name = line.match(/([A-Za-z0-9_.-]+(?:\.backup|\.dump|\.sql))/)?.[1];
    if (!name) return null;
    const listTimestamp = line.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?::(\d{2}))?\b/);
    const timestamp = name.match(/(\d{8}-\d{6})/)?.[1] || "";
    const created = listTimestamp ? `${listTimestamp[1]} ${listTimestamp[2]}:${listTimestamp[3] || "00"}` : formatBackupTimestamp(timestamp);
    const createdSort = listTimestamp ? backupDisplayTimestampSort(created) : backupTimestampSort(timestamp);
    const type = friendlyBackupType(name, line);
    const source = /import/i.test(name) ? "External" : name.includes("__") ? name.split("__")[0].replace(/^dune-db-/, "") : "Local";
    return { name, backupName: name, battlegroupId: "Unknown", created, createdSort, type, source };
  }).filter(Boolean).sort((a, b) => Number((b as Record<string, unknown>).createdSort || 0) - Number((a as Record<string, unknown>).createdSort || 0)) as Record<string, unknown>[];
}

function formatBackupTimestamp(value: string) {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return "Unknown";
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6]}`;
}

function backupTimestampSort(value: string) {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) return 0;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
}

function backupDisplayTimestampSort(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return 0;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])).getTime();
}

function friendlyBackupType(name: string, line: string) {
  if (/auto|scheduled/i.test(name) || /auto|scheduled/i.test(line)) return "Automatic Backup";
  if (/restore[-_ ]?safety/i.test(name) || /restore[-_ ]?safety/i.test(line)) return "Restore Safety Backup";
  if (/pre[-_ ]?update/i.test(name) || /pre[-_ ]?update/i.test(line)) return "Pre-update Backup";
  if (/import/i.test(name) || /import/i.test(line)) return "Imported Backup";
  if (name.endsWith(".backup") || name.endsWith(".dump") || name.endsWith(".sql")) return "Manual Backup";
  return "Unknown";
}

function parseHistoryRows(text: string) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => !/^time\s+/i.test(line)).map((line) => {
    const parts = line.split(/\t/);
    if (parts.length >= 6) {
      return {
        time: parts[0],
        action: parts[1],
        target: parts[2],
        status: parts[5],
        summary: parts.slice(3, 5).concat(parts.slice(6)).filter(Boolean).join(" ")
      };
    }
    const loose = line.split(/\s{2,}/).filter(Boolean);
    return {
      time: loose[0] || "",
      action: loose[1] || "",
      target: loose[2] || "",
      status: loose[5] || "",
      summary: loose.slice(3).join(" ")
    };
  }).filter((row) => row.action || row.summary);
}

function friendlyServiceName(name: string) {
  return SERVICE_LABELS[name] || SERVICE_LABELS[name.replace(/^dune-/, "")] || name.replace(/^dune-server-/, "").replace(/^dune-/, "").replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
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

function serviceActionName(name: string, action: "logs" | "restart") {
  const normalized: Record<string, string> = {
    "dune-postgres": "postgres",
    "dune-rmq-admin": "rmq-admin",
    "dune-rmq-game": "rmq-game",
    "dune-text-router": "text-router",
    "dune-director": "director",
    "dune-server-gateway": "gateway",
    "dune-server-survival-1": "survival-1",
    "dune-server-overmap": "overmap",
    "dune-orchestrator": "orchestrator",
    "dune-autoscaler": "autoscaler"
  };
  const value = normalized[name] || name;
  if (action === "logs") return value;
  return ["text-router", "director", "gateway", "survival", "survival-1", "overmap"].includes(value) ? value : null;
}

function isTerminalTask(status: string) {
  return ["succeeded", "failed", "cancelled"].includes(status);
}
