import { useEffect, useRef, useState } from "react";
import { HomeHighlights } from "./HomeHighlights";
import type { Dispatch, SetStateAction } from "react";
import type { Tab } from "../../App";
import { ChevronDown, History, Play, Trash2 } from "lucide-react";
import { serverApi, type PerformanceSnapshot, type RestartHistoryResponse, type RestartHistoryRow } from "../../api/server";
import { ServerHostnameSetting, useServerHostname } from "./ServerHostnameSetting";
import { getServerPorts } from "../../api/serverPorts";
import { runGatedRestart, serviceRestartTarget, type RestartGate } from "./restartQueueGuard";
import { setupApi, type Task } from "../../api/setup";
import { PortChecklist } from "../../components/PortChecklist";
import { GAME_CONNECTIONS_LABEL, ReadinessTimeline } from "../../components/ReadinessTimeline";
import { SecretInput } from "../../components/SecretInput";
import { InfoTooltip, KeyValueGrid, StatusPill, TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { formatDisplayValue, formatUiSentence, friendlyColumnName, normalizeStatus, stripAnsi, summarizeCommandText, titleCase } from "../../lib/display";
import { friendlyServiceName } from "../../lib/serviceDisplay";
import { conciseTaskError, funcomTokenMismatchDetected } from "../../lib/taskDisplay";
import { QueueBadges, queueCountsSummary, queueCountsTotal, type QueueCounts } from "../../components/common/QueueBadges";
import { childAccessPieceCount, usePendingQueues } from "../../lib/usePendingRefills";

export type HomeLoadResult = { statusLoaded: boolean; readinessLoaded: boolean; statusError: string; readinessError: string; statusText: string; readinessText: string; sampledAtMs: number };
export type HomeTaskResult = { status: "running" | "succeeded" | "failed" | "stopped"; title: string; message?: string; details?: string };
export type StorageCleanupOperation = "" | "images" | "build-cache";
export type RestartLifecycleState = { stopObserved: boolean; startObserved: boolean };

// A stop alone leaves refills queued -- stop-all.sh removes the Postgres
// container too, so there is nothing to write to. Only a restart's start-all.sh
// step opens a window with Postgres reachable and the map server not yet
// booted, which the background flush uses. Both battlegroup control rows say so.
function PendingRefillNote() {
  const { fuel, water, deletes, vehicleDeletes, permissions } = usePendingQueues();
  // Split per resource rather than reporting one number: every queue flushes on
  // the same restart, but which one is waiting decides whether an operator goes
  // looking at generators, water containers, a deleted base, or a permission
  // change. Same badge vocabulary as the Bases panel's queue banner, from the
  // same component so the two cannot drift.
  const counts: QueueCounts = {
    fuel: fuel.pending?.total || 0,
    water: water.pending?.total || 0,
    deletes: deletes.pending?.total || 0,
    vehicleDeletes: vehicleDeletes.pending?.total || 0,
    permissions: childAccessPieceCount(permissions.pending)
  };
  const total = queueCountsTotal(counts);
  if (!total) return null;
  const summary = queueCountsSummary(counts);
  return <p className="action-help-note pending-refill-note">
    <QueueBadges counts={counts} />
    {/* Explicit space: the badges are inline elements, so without it the
        paragraph's text content reads "1 waterrefills queued" to a screen
        reader and to anyone copying it. The CSS margin is visual only. */}
    {" "}{summary.toLowerCase()} queued across all maps. Restarting the battlegroup applies {total === 1 ? "it" : "them"}; stopping leaves {total === 1 ? "it" : "them"} queued.
  </p>;
}
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

// Readiness is monitored by App so it survives tab changes. Action handlers
// still report command progress, but an in-flight command callback must never
// replace a terminal result already published by that monitor. Without this
// monotonic merge, a late panel callback could turn "Started Successfully"
// back into "Finalizing Startup" and leave it there after polling stopped.
export function preserveTerminalStackResult(current: HomeTaskResult | null, next: HomeTaskResult): HomeTaskResult {
  return current && current.status !== "running" ? current : next;
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

// Returned strings are the ones normalizeStatus() maps to
// badge-pass / badge-warn / badge-fail, so StatusPill needs no change.
export const PERFORMANCE_WARN_PERCENT = 75;
export const PERFORMANCE_FAIL_PERCENT = 90;

// `null` is "no reading yet", not "no percentage concept": the API returns null
// routinely (cpuPercent needs two samples for a delta), and that must read INFO,
// never OK. Cards with no percentage at all are excluded by the caller.
export function performanceCardStatus(percent: number | null, sampled: boolean) {
  if (!sampled || percent === null || !Number.isFinite(percent)) return "INFO";
  // Nonsense rather than healthy -- must not fall through to OK.
  if (percent < 0) return "INFO";
  if (percent > PERFORMANCE_FAIL_PERCENT) return "CRIT";
  if (percent >= PERFORMANCE_WARN_PERCENT) return "WARN";
  return "OK";
}

export function performanceTrackTone(percent: number | null, sampled: boolean) {
  const status = performanceCardStatus(percent, sampled);
  if (status === "CRIT") return "metric-track-fail";
  if (status === "WARN") return "metric-track-warn";
  return "";
}

// Keyed on the stable row id, never the label. The label is display text and is
// expected to change; the id is not. Keying on the label meant a rename silently
// dropped the route -- the lookup fails closed, so the row simply stopped being
// clickable with nothing failing but a button count.
//
// Every row goes to Server Control. These rows report *health*, and Server
// Control is where health is diagnosed -- ReadinessTimeline, PortChecklist,
// DoctorSummary and the Change Funcom Token form all live there. The Database
// row deliberately does not go to the Database tab: that tab is for data (schema
// browser, queries), not for whether Postgres is up and its partitions readable.
//
// Kept as a per-label map rather than one constant so a subsystem can be pointed
// somewhere better later without restructuring. Every destination must be a tab
// the sidebar lists -- "Services" is in ALL_TABS but has no navGroups entry, and
// routing there dropped the operator on a panel with nothing highlighted and no
// way back. App.activeTab.test.tsx guards that.
// A Readiness & Health row. `id` is the stable key every lookup uses; `label` is
// display text only.
export type HomeHealthRow = { id: string; label: string; value: string; status: string; detail: string };

// The rows, in display order. One home per service:
//   database    dune-postgres, the world partitions, and 15432
//   messaging   the two RabbitMQ brokers and the text router, which is a hard
//               client of the game broker -- start-text-router.sh blocks on its
//               TLS listener before starting
//   battlegroup dune-director and dune-server-gateway
//   games       every always-on map server and every map port
//   fls         registration with Funcom's live service; owns no container
//
// dune-orchestrator and dune-coriolis-coordinator are deliberately unowned: the
// control plane is always up, and the coordinator is optional.
const HOME_HEALTH_ROWS: Array<{ id: string; label: string }> = [
  { id: "database", label: "Database" },
  { id: "messaging", label: "Messaging" },
  { id: "battlegroup", label: "Battlegroup Services" },
  { id: "games", label: "Game Servers" },
  { id: "fls", label: "Funcom/FLS" }
];

export const HOME_SUBSYSTEM_ROUTES: Record<string, Tab> = {
  database: "Server Control",
  messaging: "Server Control",
  battlegroup: "Server Control",
  games: "Server Control",
  fls: "Server Control"
};

// Three missed idle polls. Derived from the sample's own age rather than a
// count of consecutive failures: age is true by construction whatever the cause
// -- failed poll, hidden tab, dead backend -- and unlike a counter it survives
// leaving Home and coming back.
export const STALE_SAMPLE_AGE_MS = 90_000;

export function isStatusSampleStale(sampledAtMs: number, now: number) {
  if (!sampledAtMs) return false;
  return now - sampledAtMs > STALE_SAMPLE_AGE_MS;
}

export function formatFreshness(lastUpdatedAt: number, now: number) {
  if (!lastUpdatedAt) return "";
  const seconds = Math.max(0, Math.round((now - lastUpdatedAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

export function HomePanel({ status, readiness, taskResult, setTaskResult, funcomTokenResult, setFuncomTokenResult, runningAction, restartStartObserved, setRunningAction, onLoad, confirmAction, restartGate, onNavigate, sampledAtMs = 0, setSampledAtMs }: {
  status: string;
  readiness: string;
  taskResult: HomeTaskResult | null;
  setTaskResult: Dispatch<SetStateAction<HomeTaskResult | null>>;
  funcomTokenResult: HomeTaskResult | null;
  setFuncomTokenResult: Dispatch<SetStateAction<HomeTaskResult | null>>;
  runningAction: "start" | "stop" | "restart" | "";
  restartStartObserved: boolean;
  setRunningAction: Dispatch<SetStateAction<"start" | "stop" | "restart" | "">>;
  onLoad: (options?: { fresh?: boolean }) => Promise<HomeLoadResult>;
  confirmAction: ConfirmAction;
  restartGate: RestartGate;
  // Absent (e.g. in tests) means the subsystem rows render as text, not buttons.
  onNavigate?: (tab: Tab) => void;
  // Held by App so it outlives this panel unmounting on a tab switch.
  sampledAtMs?: number;
  setSampledAtMs?: (value: number) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState("");
  const [readinessWarning, setReadinessWarning] = useState("");
  const [performance, setPerformance] = useState<PerformanceSnapshot | null>(null);
  const [performanceError, setPerformanceError] = useState("");
  const [restartHistory, setRestartHistory] = useState<RestartHistoryResponse | null>(null);
  const restartHistoryRequestId = useRef(0);
  const [hasLoaded, setHasLoaded] = useState(Boolean(status || readiness));
  const homeActionRunId = useRef(0);
  const homeActionStartedAt = useRef(0);
  const homeRestartLifecycle = useRef<RestartLifecycleState>(createRestartLifecycleState());
  const refreshRunId = useRef(0);

  function setHomeAction(action: "start" | "stop" | "restart" | "") {
    if (action === "restart" || !action) homeRestartLifecycle.current = createRestartLifecycleState();
    setRunningAction(action);
  }

  useEffect(() => {
    if (runningAction && homeActionStartedAt.current === 0) homeActionStartedAt.current = Date.now();
    if (!runningAction) homeActionStartedAt.current = 0;
  }, [runningAction]);

  function applyHomeLoadResult(result: HomeLoadResult) {
    const loaded = result.statusLoaded || result.readinessLoaded;
    if (loaded) setHasLoaded(true);
    // Only a successful read moves the clock. A failed poll leaves the old
    // sample time in place, so its age keeps growing and eventually reads as
    // stale on its own -- no failure counter needed.
    if (loaded && result.sampledAtMs) setSampledAtMs?.(result.sampledAtMs);
    setReadinessWarning(!result.readinessLoaded && result.readinessError ? result.readinessError : "");
    if (!result.statusLoaded && !result.readinessLoaded && result.statusError) setLocalError(friendlyHomeStatusError(result.statusError));
  }

  // `fresh` is opt-in per caller. The mount read deliberately accepts a cached
  // snapshot -- that read is the whole reason the cache exists -- while an
  // operator pressing Refresh Status is asking to go and look again.
  async function refresh(isActive = () => true, options: { fresh?: boolean } = {}) {
    const runId = ++refreshRunId.current;
    setLoading(true);
    setLocalError("");
    setReadinessWarning("");
    try {
      const historyRequestId = ++restartHistoryRequestId.current;
      const [result, history] = await Promise.all([
        onLoad({ fresh: options.fresh }), serverApi.restartHistory().catch(() => null)
      ]);
      if (!isActive() || refreshRunId.current !== runId) return;
      if (history && restartHistoryRequestId.current === historyRequestId) setRestartHistory(history);
      if (result.statusLoaded || result.readinessLoaded) {
        applyHomeLoadResult(result);
      } else {
        setLocalError(friendlyHomeStatusError(result.statusError || result.readinessError || "Server status and readiness checks failed."));
      }
    } catch (error) {
      if (isActive() && refreshRunId.current === runId) {
        setLocalError(friendlyHomeStatusError(error instanceof Error ? error.message : String(error)));
      }
    } finally {
      if (isActive() && refreshRunId.current === runId) setLoading(false);
    }
  }

  async function runServerAction(action: "start" | "stop" | "restart") {
    if (action === "stop" && !(await confirmAction("Stop the battlegroup?"))) return;
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
      const preLoad = await onLoad({ fresh: true }).catch(() => null);
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
      let final: Task;
      if (commandAction === "restart") {
        const gated = await runGatedRestart({ restartGate, label: "battlegroup", dispatch: (opts) => serverApi.restart(opts) });
        if (homeActionRunId.current !== actionRunId) return;
        if (gated.outcome === "cancelled") { setTaskResult(null); return; }
        if (gated.outcome === "queued") { setTaskResult({ status: "succeeded", title: "Restart queued" }); return; }
        if (!gated.task) { setTaskResult(null); return; }
        final = await waitForTaskSilently(gated.task);
      } else {
        const response = commandAction === "start" ? await serverApi.start() : await serverApi.stop();
        final = await waitForTaskSilently(response.task);
      }
      if (homeActionRunId.current !== actionRunId) return;
      const details = taskTechnicalDetails(final);
      if (action === "restart") homeRestartLifecycle.current = advanceRestartLifecycleFromTaskDetails(homeRestartLifecycle.current, details);
      const postLoad = await onLoad({ fresh: true }).catch(() => null);
      if (homeActionRunId.current !== actionRunId) return;
      if (postLoad) applyHomeLoadResult(postLoad);
      const postState = getHomeServerState(postLoad?.statusText || status, postLoad?.readinessText || readiness);
      const elapsedMs = Date.now() - homeActionStartedAt.current;
      const postReady = isHomeActionComplete(postLoad?.statusText || status, postLoad?.readinessText || readiness, elapsedMs);
      if (action === "restart") {
        homeRestartLifecycle.current = advanceRestartLifecycle(homeRestartLifecycle.current, postLoad?.statusText || status, postLoad?.readinessText || readiness);
      }
      const restartReady = isRestartLifecycleReady(action, homeRestartLifecycle.current);
      if (action === "stop" && isHomeStopComplete(postLoad?.statusText || status, postLoad?.readinessText || readiness)) {
        setTaskResult({ status: "stopped", title: copy.success, details });
      } else if (action === "restart" && restartReady) {
        keepPolling = true;
        if (isHomeActionComplete(postLoad?.statusText || status, postLoad?.readinessText || readiness, elapsedMs)) {
          setTaskResult((current) => preserveTerminalStackResult(current, { status: "succeeded", title: copy.success, details }));
          setHomeAction("");
        }
      } else if (action === "start" && elapsedMs >= 8000 && postReady) {
        keepPolling = true;
        setTaskResult((current) => preserveTerminalStackResult(current, { ...stackActionPendingResult(action, "confirming"), details }));
      } else if (final.status !== "succeeded") {
        if ((action === "start" || action === "restart") && (postState.starting || postState.running)) {
          keepPolling = true;
          setTaskResult((current) => preserveTerminalStackResult(current, { ...stackActionPendingResult(action), details }));
        } else {
          setTaskResult((current) => preserveTerminalStackResult(current, { status: "failed", title: copy.failure, details }));
        }
      } else if (action === "stop") {
        keepPolling = true;
        setTaskResult((current) => preserveTerminalStackResult(current, { ...stackActionPendingResult(action), details }));
      } else if (action === "restart" && final.status === "succeeded") {
        keepPolling = true;
        setTaskResult((current) => preserveTerminalStackResult(current, { ...stackActionPendingResult(action, "waiting"), details }));
      } else if ((action === "start" || action === "restart") && (final.status === "succeeded" || postState.starting || postState.running)) {
        keepPolling = true;
        setTaskResult((current) => preserveTerminalStackResult(current, final.status === "succeeded" ? stackActionPendingResult(action, "waiting") : stackActionPendingResult(action)));
      } else {
        setTaskResult((current) => preserveTerminalStackResult(current, { status: "failed", title: copy.failure, details }));
      }
    } catch (error) {
      if (homeActionRunId.current !== actionRunId) return;
      setTaskResult((current) => preserveTerminalStackResult(current, { status: "failed", title: copy.failure, details: error instanceof Error ? error.message : String(error) }));
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
    async function refreshHistory() {
      const requestId = ++restartHistoryRequestId.current;
      try {
        const result = await serverApi.restartHistory();
        if (active && restartHistoryRequestId.current === requestId) setRestartHistory(result);
      } catch { /* Keep the last known history during a restart. */ }
    }
    // Readiness can turn green before the restart task finishes and journals
    // its outcome. Keep watching after the success card has stopped changing.
    if (taskResult) void refreshHistory();
    const timer = window.setInterval(() => { if (!document.hidden) void refreshHistory(); }, 30000);
    const onFocus = () => { void refreshHistory(); };
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [taskResult?.status, taskResult?.title]);

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
    if (runningAction || !homeNeedsWarmRefresh(status, readiness)) return;
    let active = true;
    // fresh: true bypasses the server-side cache by design, so each tick costs a
    // real ~4s status.sh run. Without this guard the interval keeps firing while
    // one is still in flight and they queue back-to-back for the whole warm-up,
    // which is exactly when the host is most loaded. The server dedupes
    // concurrent collects, so this never manufactured parallel subprocesses --
    // it just asked for far more of them than anyone could read.
    let inFlight = false;
    const id = window.setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      // Warming: the whole point is to watch it change, so never cached.
      const result = await onLoad({ fresh: true }).catch(() => null).finally(() => { inFlight = false; });
      if (!active) return;
      if (result) applyHomeLoadResult(result);
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
      // Idle: a cached read is acceptable here and on mount. These are the only
      // two paths that tolerate staleness.
      const result = await onLoad().catch(() => null);
      if (!active) return;
      if (result) applyHomeLoadResult(result);
    }, 30000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [runningAction, status, readiness, onLoad]);

  useEffect(() => {
    if (!isRestartSuccessAwaitingFreshStatus(taskResult, status, readiness)) return;
    let active = true;
    // Same guard as the warm-up poll above, and it matters more here: a 1.5s
    // interval against a ~4s uncached read means every tick but the first would
    // land on top of one already running.
    let inFlight = false;
    const id = window.setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      // Waiting for the restart to show up in status; a cached snapshot here
      // would be the pre-restart one.
      const result = await onLoad({ fresh: true }).catch(() => null).finally(() => { inFlight = false; });
      if (!active) return;
      if (result) applyHomeLoadResult(result);
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
          <h2>Verifying Server Status...</h2>
          <p>Checking system readiness...</p>
          <p>This may take a few seconds while Docker and Dune complete their health checks.</p>
        </div>
      </article>
    </section>;
  }

  if (localError && !hasLoaded) {
    return <section className="grid">
      <article className="hero-panel wide">
        <h2>Server Status Unavailable</h2>
        <p className="error">{localError}</p>
        <button onClick={() => refresh(undefined, { fresh: true })}>Retry Status Check</button>
      </article>
    </section>;
  }

  const funcomTokenCheckRunning = funcomTokenResult?.status === "running";
  const funcomTokenAuthFailure = !funcomTokenCheckRunning && (isFuncomTokenAuthFailure(funcomTokenResult) || hasPersistedFuncomTokenAuthFailure());
  const summary = summarizeHomeStatus(status, readiness, readinessWarning, loading, runningAction, taskResult, restartStartObserved, funcomTokenAuthFailure);
  const overall = summary.identity.find((item) => item.label === "Overall");
  const identityCards = summary.identity.filter((item) => item.label !== "Overall");
  const populationItem = identityCards.find((item) => item.label === "Population");
  const populationWarn = /^warn$/i.test(String(populationItem?.status || ""));
  const populationSegment = homePopulationSegment(populationItem?.value);
  // Drives the dot and the reading beside it from one value, so the two can
  // never disagree about severity.
  const stateTone = homeStateDotTone(overall?.value, summary.health);
  const identityLine = homeIdentityLine(identityCards);

  return (
    <section className="grid home-grid" aria-labelledby="home-overview-heading">
      {/* The h2 is visually hidden but structurally real: without it the page
          jumps h1 -> h3 and this region has no accessible name. Each block's
          h3 (Battlegroup Status, Readiness & Health, Performance) sits under it. */}
      <h2 id="home-overview-heading" className="sr-only">Server Overview</h2>
      <article className="hero-panel home-block home-status-block" aria-labelledby="home-status-heading">
        {/* An h3, not a styled span: it is the peer of the "Readiness &
            Health" and "Performance" headings, so matching them by using
            the same element guarantees the same size and colour instead of
            restating their computed value here. The reading sits beside it
            rather than inside, so the heading text stays just the label. */}
        <div className="home-hero-state">
          <h3 id="home-status-heading" className="home-hero-state-label">Battlegroup Status:</h3>
          {/* Explicit space: the dot between the label and the reading is an
              empty element, so without it the heading's text content reads
              "Battlegroup Status:Stopped" to a screen reader and to anyone
              copying it. Whitespace-only text between flex items is not
              rendered, so this costs nothing visually. */}
          {" "}
          <span className={`home-state-dot home-state-dot-${stateTone}`} aria-hidden="true" />
          <span className={`home-hero-state-value home-hero-state-value-${stateTone}`}>{homeOverallHeading(overall?.value)}</span>
        </div>
        {/* The status above already says Starting/Restarting and the subsystem
            rows show progress, so an in-flight action gets one line here instead
            of a result card; the card is kept for outcomes. */}
        <p className="home-hero-step" aria-live="polite">
          {taskResult?.status === "running" && taskResult.message ? formatResultMessage(taskResult.message) : ""}
        </p>
        {/* Population is rendered apart from the rest of the line so its
            WARN can survive: summarizeHomeStatus flags an unreadable count
            ("14 / ?" or "Unavailable"), and the deleted Server Identity
            band was the only thing that showed that. Folding it into the
            plain summary string dropped the signal silently. */}
        <p className="home-hero-identity">
          {identityLine || (populationSegment ? "" : "Server details are still loading.")}
          {populationSegment && <>
            {identityLine ? " · " : ""}
            <span className={populationWarn ? "home-population-warn" : undefined}>{populationSegment}</span>
          </>}
        </p>
        <dl className="home-hero-meta">
          {HOME_HERO_META_LABELS.map((label) => <div className="home-hero-meta-item" key={label}>
            <dt>{label}</dt>
            <dd>{formatDisplayValue(identityCards.find((item) => item.label === label)?.value || "Unknown")}</dd>
          </div>)}
          <div className="home-hero-meta-item home-last-restart">
            <dt>Last Battlegroup Restart</dt>
            <dd>{restartHistory?.lastBattlegroupRestart ? formatRestartTime(restartHistory.lastBattlegroupRestart.finishedAt) : "Not Recorded Yet"}</dd>
          </div>
        </dl>
        <div className="action-row">
          <button className={loading ? "refresh-status-button refreshing" : "refresh-status-button"} disabled={refreshDisabled} onClick={() => refresh(undefined, { fresh: true })}>{loading ? <span className="loading-dots">Refreshing</span> : "Refresh Status"}</button>
          <button disabled={startDisabled} title={controlsState.running ? "Battlegroup is already running." : ""} onClick={() => runServerAction("start")}><Play size={16} /> Start</button>
          <button className="danger-button" disabled={stopDisabled} onClick={() => runServerAction("stop")}>Stop</button>
          <button disabled={restartDisabled} onClick={() => runServerAction("restart")}>Restart Battlegroup</button>
        </div>
        <StatusFreshness sampledAtMs={sampledAtMs} />
        <PendingRefillNote />
        {taskResult && taskResult.status !== "running" && <HomeTaskResultCard result={taskResult} />}
        {localError && <p className="error">{localError}</p>}
      </article>
      <HomeHighlights />
      <HomeSubsystemList items={summary.health} details={homeRowDetails(status, readiness, funcomTokenAuthFailure)} onNavigate={onNavigate} />
      <HomePerformance performance={performance} error={performanceError} />
    </section>
  );
}

export type HomeStateTone = "ok" | "motion" | "attention" | "failed" | "loading" | "nodata";

// Splits the readings by what the operator should do about them, rather than
// putting six of the ten on one amber -- a restart in flight and a failed
// readiness check are not the same problem.
export function homeStateDotTone(overallValue: unknown, health: { status: string }[] = []): HomeStateTone {
  const value = String(overallValue || "").trim().toLowerCase();
  // Self-resolving states win over the escalation below: during a stop or
  // restart the subsystems are legitimately down, and red would cry wolf.
  if (/^(starting|stopping|restarting)\b/.test(value)) return "motion";
  if (value === "checking") return "loading";
  // Stopped is reported at full severity, same as the rows below it: one
  // state, one colour. It is checked before the escalation so a stop reads as
  // stopped rather than as whichever subsystem happens to have failed.
  if (value === "stopped") return "failed";
  if (value === "unknown" || value === "status loaded") return "nodata";
  // summarizeHomeStatus can report "OK" while Funcom/FLS is FAILED (the
  // token-mismatch branch overrides its ready override), so the heading word
  // alone is not the worst thing on screen.
  if (health.some((item) => normalizeStatus(String(item.status || "")) === "fail")) return "failed";
  if (value === "ok") return "ok";
  return "attention";
}

// summarizeHomeStatus yields "Restarting Battlegroup", which under the
// "Battlegroup Status:" prefix would say Battlegroup twice. Trimmed here, not in
// the summary -- that value is shared with homeNeedsWarmRefresh and with
// isHomeActionComplete, which matches /^OK$/ to detect a finished restart. So
// "OK" is renamed for display only, never in the summary.
// Does this heading read green to the operator?
//
// The union is deliberate. homeStateDotTone with an empty health array asks
// "how green is this word on its own", which already encodes the carve-outs
// this must respect -- motion for starting/stopping, failed for stopped, nodata
// for unknown. homeOverallBadge closes the other half: friendlyHomeOverall
// passes an unrecognised Overall: token straight through, and inferStatus
// badges Healthy, Running, Up, Listening and Found as Ready.
//
// A false positive here is safe: the only thing it enables is a downgrade.
export function heroReadsGreen(value: unknown) {
  return homeStateDotTone(value, []) === "ok" || homeOverallBadge(String(value || "")) === "Ready";
}

export function homeOverallHeading(value: unknown) {
  const text = formatDisplayValue(value || "Unknown");
  if (/^ok$/i.test(text.trim())) return "Ready";
  return text.replace(/\s+battlegroup$/i, "");
}

// Shown even when Unknown: with the Server Identity band gone this is the only
// place they appear, so an absent one must read as absent rather than vanish.
const HOME_HERO_META_LABELS = ["Server IP", "Battlegroup"];

// Title/Region/Mode only. Unknown entries are dropped -- a line reading
// "Unknown · Unknown" tells an operator nothing, and the caller supplies a
// loading sentence when nothing resolves. Population is rendered separately so
// its warn state survives; uptime belongs to the Performance card.
function homeIdentityLine(items: { label: string; value: string }[]) {
  const pick = (label: string) => {
    const value = String(items.find((item) => item.label === label)?.value || "").trim();
    return value && !/^(unknown|unavailable)$/i.test(value) ? value : "";
  };
  const parts = [pick("Title"), pick("Region"), pick("Mode")].filter(Boolean);
  return parts.join(" · ");
}


// formatHomePopulation yields "14", "14 / 40", "14 / ?" or "Unavailable", all of
// which read as a bare trailing number unlabelled. "Unavailable" is kept rather
// than dropped: with the warn tone it says the count could not be read.
function homePopulationSegment(value: unknown) {
  const text = String(value || "").trim();
  if (!text || /^unknown$/i.test(text)) return "";
  // Absence, not a warning. This used to read "population unavailable", and the
  // caller suppressed the whole segment by inspecting the HEADING -- so hiding
  // the count was coupled to whatever word the hero happened to be showing.
  // A count that cannot be read is simply not shown; the reason belongs to the
  // row that owns it.
  if (/^unavailable$/i.test(text)) return "";
  return `${text} online`;
}

// Owns its 1s tick so the per-second re-render stays here instead of redrawing
// every card in the panel.
function StatusFreshness({ sampledAtMs }: { sampledAtMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!sampledAtMs) return null;
  const stale = isStatusSampleStale(sampledAtMs, now);
  const ago = formatFreshness(sampledAtMs, now);
  return <p className={stale ? "home-freshness stale" : "home-freshness"}>
    {stale ? `Status may be stale — last updated ${ago}` : `Updated ${ago}`}
  </p>;
}

// A row is a button when the subsystem has somewhere to be dealt with, so a
// warning routes to the tab that can fix it instead of being a dead end.
function HomeSubsystemList({ items, details, onNavigate }: { items: HomeHealthRow[]; details: Record<string, HomeDetailGroup[]>; onNavigate?: (tab: Tab) => void }) {
  return <section className="panel home-block home-subsystems" aria-label="Readiness and health">
    <h3>Readiness & Health</h3>
    <ul className="home-subsystem-list">
      {items.map((item) => {
        // hasOwn, not a bare index: a plain object inherits Object.prototype,
        // so a label of "constructor" would return a truthy non-Tab value and
        // reach setTab. Fail-closed if labels ever stop being literals.
        const route = Object.hasOwn(HOME_SUBSYSTEM_ROUTES, item.id) ? HOME_SUBSYSTEM_ROUTES[item.id] : undefined;
        const body = <>
          <span className="home-subsystem-label">{item.label}</span>
          <span className="home-subsystem-value">
            {/* A healthy row's value is the literal "OK" beside a "Ready"
                pill saying the same thing twice -- and healthy is the common
                case. Anything else ("Warming", "Token Mismatch Detected",
                "3 of 8 up") is the detail the pill cannot carry, so it stays. */}
            {!/^OK$/i.test(item.value) && <span>{formatDisplayValue(item.value)}</span>}
            {item.detail && <span className="home-subsystem-count">{item.detail}</span>}
            <StatusPill value={item.status} />
          </span>
        </>;
        // detail carries how much of each subsystem is ready ("7 of 7"). It is
        // rendered inline rather than as a title, since a tooltip would hide the
        // count behind a hover the reading is not worth.
        const groups = details[item.id] || [];
        return <li key={item.id} className="home-subsystem-row home-subsystem-row-info">
          {route && onNavigate
            ? <button type="button" className="home-subsystem-button" onClick={() => onNavigate(route)} aria-label={`${item.label}: ${item.value}${item.detail ? `, ${item.detail}` : ""}. Open ${route}`}>{body}</button>
            : <div className="home-subsystem-static">{body}</div>}
          {/* Beside the row, not inside it: the row is itself a button. */}
          {groups.length > 0 && <InfoTooltip id={`home-detail-${item.id}`} label={`${item.label} details`} portal interactive>
            <HomeDetailList groups={groups} />
          </InfoTooltip>}
        </li>;
      })}
    </ul>
  </section>;
}

function HomeDetailList({ groups }: { groups: HomeDetailGroup[] }) {
  return <span className="home-detail">
    {groups.map((group) => <span className="home-detail-group" key={group.title}>
      <span className="home-detail-title">{group.title}</span>
      {group.rows.map((row, index) => <span className="home-detail-row" key={`${row.name}-${index}`} data-no-translate>
        <span>{row.name}</span>
        <span className={`home-detail-value ${homeDetailTone(row.value)}`}>{row.value}</span>
        {row.note && <span className="home-detail-note">{row.note}</span>}
      </span>)}
    </span>)}
  </span>;
}

// Rows in the same style as Readiness & Health beside it, so the two lower
// blocks read as a pair.
function HomePerformance({ performance, error }: { performance: PerformanceSnapshot | null; error: string }) {
  const rows = [
    {
      label: "CPU Usage",
      value: performance?.cpuPercent == null ? "Sampling..." : `${performance.cpuPercent.toFixed(1)}%`,
      percent: performance?.cpuPercent ?? null,
      metered: true,
      detail: "Host Processor Load"
    },
    {
      label: "Memory",
      value: performance?.memory.percent == null ? "Unknown" : `${performance.memory.percent.toFixed(1)}%`,
      percent: performance?.memory.percent ?? null,
      metered: true,
      detail: performance ? `${formatBytes(performance.memory.usedBytes)} / ${formatBytes(performance.memory.totalBytes)}` : "Waiting for Sample"
    },
    {
      label: "Disk",
      value: performance?.disk.percent == null ? "Unknown" : `${performance.disk.percent.toFixed(1)}%`,
      percent: performance?.disk.percent ?? null,
      metered: true,
      detail: performance ? `${formatBytes(performance.disk.usedBytes)} / ${formatBytes(performance.disk.totalBytes)}` : "Waiting for Sample"
    },
    {
      label: "Uptime",
      value: performance?.uptime || "0d 00h 00m",
      percent: null,
      // Not a utilisation figure, so no badge and no bar -- distinct from a
      // metered card whose reading has not arrived yet.
      metered: false,
      detail: "Host Uptime"
    }
  ];
  return <section className="panel home-block home-performance" aria-labelledby="home-performance-heading">
    <h3 id="home-performance-heading">Performance</h3>
    {error && !performance && <p className="error">{error}</p>}
    <ul className="home-subsystem-list">
      {rows.map((item) => {
        const rowStatus = item.metered ? performanceCardStatus(item.percent, Boolean(performance)) : "";
        return <li className="home-subsystem-row home-perf-row" key={item.label}>
          <div className="home-subsystem-static home-perf-line">
            <span className="home-subsystem-label home-perf-label">{item.label}</span>
            <span className="home-perf-meter">
              {item.metered && item.percent !== null && <span className="metric-track" aria-hidden="true"><span className={performanceTrackTone(item.percent, Boolean(performance))} style={{ width: `${clampPercent(item.percent)}%` }} /></span>}
            </span>
            <span className="home-perf-figure">
              <span className="home-perf-detail">{item.detail}</span>
              <span className="home-perf-value">{item.value}</span>
              {rowStatus && <StatusPill value={rowStatus} />}
            </span>
          </div>
        </li>;
      })}
    </ul>
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
  storageCleanupResult: HomeTaskResult | null;
  setStorageCleanupResult: Dispatch<SetStateAction<HomeTaskResult | null>>;
  storageCleanupOperation: StorageCleanupOperation;
  setStorageCleanupOperation: Dispatch<SetStateAction<StorageCleanupOperation>>;
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
  restartGate: RestartGate;
}) {
  const [service, setService] = useState(RESTARTABLE_SERVICES[0].value);
  const [restartSchedule, setRestartSchedule] = useState<{ stdout?: string; stderr?: string; exitCode?: number } | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [restartEnabled, setRestartEnabled] = useState(false);
  const [restartTime, setRestartTime] = useState("05:00");
  const [scheduleResult, setScheduleResult] = useState<HomeTaskResult | null>(null);
  const [serverTitle, setServerTitle] = useState("");
  const hostname = useServerHostname();
  const [savedServerTitle, setSavedServerTitle] = useState("");
  const [serverMode, setServerMode] = useState<ServerMode>("public");
  const [savedServerMode, setSavedServerMode] = useState<ServerMode>("public");
  const [titleResult, setTitleResult] = useState<HomeTaskResult | null>(null);
  const [funcomToken, setFuncomToken] = useState("");
  const [serviceRestartResult, setServiceRestartResult] = useState<HomeTaskResult | null>(null);
  const [serviceRestartingService, setServiceRestartingService] = useState("");
  const [networkBindResult, setNetworkBindResult] = useState<HomeTaskResult | null>(null);
  const { storageCleanupResult, setStorageCleanupResult, storageCleanupOperation, setStorageCleanupOperation } = props;
  const [doctorLoading, setDoctorLoading] = useState(!props.doctor);
  const [doctorError, setDoctorError] = useState("");
  const controlActionRunId = useRef(0);
  const controlActionStartedAt = useRef(0);
  const controlRestartLifecycle = useRef<RestartLifecycleState>(createRestartLifecycleState());
  const serviceRestartRunId = useRef(0);
  const doctorRequestId = useRef(0);
  const { taskResult, setTaskResult, funcomTokenResult, setFuncomTokenResult, runningAction, setRunningAction, confirmAction, restartGate } = props;
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
    if (action === "restart" || !action) controlRestartLifecycle.current = createRestartLifecycleState();
    setRunningAction(action);
  }
  async function loadControlStatus(includeDiagnostics = false): Promise<HomeLoadResult> {
    const currentDoctorRequestId = includeDiagnostics ? ++doctorRequestId.current : 0;
    if (includeDiagnostics) {
      setDoctorLoading(true);
      setDoctorError("");
    }
    if (includeDiagnostics) {
      // Doctor can take much longer than status/readiness. Publish each
      // independent section without holding the main controls behind it.
      void serverApi.ports().then((ports) => props.setPorts(ports.stdout)).catch(() => null);
      void serverApi.doctor().then((doctor) => {
        if (currentDoctorRequestId !== doctorRequestId.current) return;
        props.setDoctor(doctor.stdout || doctor.stderr || "");
        setDoctorLoading(false);
      }).catch((error) => {
        if (currentDoctorRequestId !== doctorRequestId.current) return;
        setDoctorError(error instanceof Error ? error.message : String(error));
        setDoctorLoading(false);
      });
    }
    const [nextStatus, nextReadiness] = await Promise.allSettled([serverApi.status(), serverApi.readiness()]);
    const result: HomeLoadResult = { statusLoaded: false, readinessLoaded: false, statusError: "", readinessError: "", statusText: "", readinessText: "", sampledAtMs: 0 };
    if (nextStatus?.status === "fulfilled") {
      result.statusText = nextStatus.value.stdout;
      result.statusLoaded = true;
      result.sampledAtMs = Date.parse(nextStatus.value.sampledAt || "") || Date.now();
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
    const hostnameChanged = hostname.changed;
    if (!hostname.ready || !hostname.valid) return;
    if (!titleChanged && !modeChanged && !hostnameChanged) {
      setTitleResult({ status: "succeeded", title: "No Changes to Save" });
      return;
    }
    const changeList = [
      titleChanged ? `title to "${title}"` : "",
      modeChanged ? `mode to ${titleCase(serverMode)}` : ""
    ].filter(Boolean).join(" and ");
    if ((titleChanged || modeChanged) && !(await confirmAction(`Change server ${changeList}? This saves the setting and refreshes Director/Gateway only if they are already running.${hostnameChanged ? " The hostname will be saved afterward and requires your next Battlegroup restart." : ""}`))) return;
    setTitleResult({ status: "running", title: "Saving Settings" });
    props.onError("");
    try {
      if (!titleChanged && !modeChanged) {
        await hostname.save();
        setTitleResult({ status: "succeeded", title: "Settings Saved — Battlegroup Restart Required" });
        return;
      }
      const final = await waitForTaskSilently((await serverApi.saveConfig({
        ...(titleChanged ? { title } : {}),
        ...(modeChanged ? { mode: serverMode } : {})
      })).task);
      const details = taskTechnicalDetails(final);
      await loadControlStatus(false).catch(() => null);
      if (final.status === "succeeded") {
        if (titleChanged) setSavedServerTitle(title);
        if (modeChanged) setSavedServerMode(serverMode);
        if (hostnameChanged) await hostname.save();
      }
      setTitleResult(final.status === "succeeded"
        ? { status: "succeeded", title: hostnameChanged ? "Settings Saved — Battlegroup Restart Required" : "Settings Saved Successfully", details }
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
      const final = await waitForTaskSilently(response.task, 3600);
      const details = taskTechnicalDetails(final);
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
      void loadControlStatus(true).catch(() => null);
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
      let final: Task;
      if (action === "restart") {
        const gated = await runGatedRestart({ restartGate, label: "battlegroup", dispatch: (opts) => serverApi.restart(opts) });
        if (controlActionRunId.current !== actionRunId) return;
        if (gated.outcome === "cancelled") { setTaskResult(null); return; }
        if (gated.outcome === "queued") { setTaskResult({ status: "succeeded", title: "Restart queued" }); return; }
        if (!gated.task) { setTaskResult(null); return; }
        final = await waitForTaskSilently(gated.task);
      } else {
        const response = action === "start" ? await serverApi.start() : await serverApi.stop();
        final = await waitForTaskSilently(response.task);
      }
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
        if (isHomeActionComplete(statusText, readinessText, elapsedMs)) {
          setTaskResult((current) => preserveTerminalStackResult(current, { status: "succeeded", title: copy.success, details }));
          setControlAction("");
        }
      } else if (action === "start" && elapsedMs >= 8000 && isHomeActionComplete(statusText, readinessText, elapsedMs)) {
        keepPolling = true;
        setTaskResult((current) => preserveTerminalStackResult(current, { ...stackActionPendingResult(action, "confirming"), details }));
      } else if (final.status !== "succeeded") {
        const postState = getHomeServerState(statusText, readinessText);
        if ((action === "start" || action === "restart") && (postState.starting || postState.running)) {
          keepPolling = true;
          setTaskResult((current) => preserveTerminalStackResult(current, { ...stackActionPendingResult(action), details }));
        } else {
          setTaskResult((current) => preserveTerminalStackResult(current, { status: "failed", title: copy.failure, details }));
        }
      } else {
        keepPolling = true;
        setTaskResult((current) => preserveTerminalStackResult(current, { ...stackActionPendingResult(action, "waiting"), details }));
      }
    } catch (error) {
      if (controlActionRunId.current !== actionRunId) return;
      setTaskResult((current) => preserveTerminalStackResult(current, { status: "failed", title: copy.failure, details: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (controlActionRunId.current === actionRunId && !keepPolling) setControlAction("");
    }
  }
  async function restartSelectedService() {
    const selectedService = service;
    const runId = ++serviceRestartRunId.current;
    setServiceRestartingService(selectedService);
    setServiceRestartResult({ status: "running", title: "Restarting" });
    props.onError("");
    try {
      const gated = await runGatedRestart({ restartGate, label: friendlyServiceName(selectedService), target: serviceRestartTarget(selectedService), dispatch: (opts) => serverApi.restartService(selectedService, opts) });
      if (serviceRestartRunId.current !== runId) return;
      if (gated.outcome === "cancelled") { setServiceRestartingService(""); setServiceRestartResult(null); return; }
      if (gated.outcome === "queued") { setServiceRestartingService(""); setServiceRestartResult({ status: "succeeded", title: "Restart queued" }); return; }
      if (!gated.task) { setServiceRestartingService(""); setServiceRestartResult(null); return; }
      const final = await waitForTaskSilently(gated.task);
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
          <ServerHostnameSetting hostname={hostname} disabled={actionRunning || serviceRestartRunning || titleSaving} />
          <button disabled={actionRunning || serviceRestartRunning || titleSaving || !hostname.ready || !hostname.valid} onClick={saveServerConfig}>Save Settings</button>
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
      <PendingRefillNote />
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
      <RestartHistoryPanel refreshKey={`${taskResult?.status || ""}:${serviceRestartResult?.status || ""}`} />
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

export function RestartHistoryPanel({ refreshKey }: { refreshKey: string }) {
  const [history, setHistory] = useState<RestartHistoryResponse | null>(null);
  const [filter, setFilter] = useState<"all" | RestartHistoryRow["scope"]>("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try { setHistory(await serverApi.restartHistory()); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : String(loadError)); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [refreshKey]);
  const rows = (history?.rows || []).filter((row) => filter === "all" || row.scope === filter);

  return <details className="restart-history-panel">
    <summary>
      <History size={18} aria-hidden="true" />
      <span><strong>Restart History</strong><small>{history?.lastBattlegroupRestart ? <><span>Last Battlegroup Restart</span> {formatRestartTime(history.lastBattlegroupRestart.finishedAt)}</> : "Tracking begins after this update"}</small></span>
      <ChevronDown className="restart-history-chevron" size={18} aria-hidden="true" />
    </summary>
    <div className="restart-history-content">
      <div className="restart-history-toolbar">
        <label>Show<select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
          <option value="all">All Restarts</option>
          <option value="battlegroup">Battlegroup</option>
          <option value="map">Maps</option>
          <option value="service">Services</option>
        </select></label>
        <button className="secondary" disabled={loading} onClick={() => void load()}>{loading ? "Refreshing" : "Refresh"}</button>
      </div>
      {error && <p className="restart-history-message restart-history-error">{error}</p>}
      {!error && !rows.length && <div className="restart-history-empty"><strong>No Matching Restarts</strong><span>No matching restarts have been recorded yet.</span></div>}
      {rows.length > 0 && <div className="restart-history-table-wrap"><table className="restart-history-table">
        <thead><tr><th>Completed</th><th>Type</th><th>Target</th><th>Source</th><th>Reason</th><th>Duration</th><th>Result</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}>
          <td data-label="Completed" className="restart-history-completed">{formatRestartTime(row.finishedAt)}</td>
          <td data-label="Type"><span className={`restart-history-scope scope-${row.scope}`}>{titleCase(row.scope)}</span></td>
          <td data-label="Target" className="restart-history-target"><strong>{row.target}</strong>{row.partitionId && <small>Partition {row.partitionId}</small>}</td>
          <td data-label="Source">{row.source}</td>
          <td data-label="Reason" className="restart-history-reason">{row.reason}</td>
          <td data-label="Duration">{formatRestartDuration(row.durationSeconds)}</td>
          <td data-label="Result"><StatusPill value={row.result} /></td>
        </tr>)}</tbody>
      </table></div>}
    </div>
  </details>;
}

function formatRestartTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatRestartDuration(seconds: number) {
  const value = Math.max(0, Math.round(seconds || 0));
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  const remainder = value % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
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

async function waitForTaskSilently(task: Task, maxPolls = 180) {
  let current = task;
  for (let i = 0; i < maxPolls && !["succeeded", "failed", "cancelled"].includes(current.status); i += 1) {
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

export function summarizeHomeStatus(status: string, readiness: string, readinessWarning: string, loading: boolean, runningAction: "start" | "stop" | "restart" | "" = "", taskResult: HomeTaskResult | null = null, restartStarted = false, funcomTokenAuthFailure = false) {
  void readinessWarning;
  const serverState = getHomeServerState(status, readiness);
  const bootStarting = isHomeBootStarting(status, readiness);
  const actionFailed = taskResult?.status === "failed" && !serverState.running;
  const actionStopped = taskResult?.status === "stopped";
  const restartSuccessAwaitingFreshStatus = isRestartSuccessAwaitingFreshStatus(taskResult, status, readiness);
  const rawOverall = findLineValue(status, ["overall"]);
  const readinessReady = /^READY:/m.test(readiness);
  const liveOverall = readinessReady ? "OK" : friendlyHomeOverall(rawOverall || (readiness ? "Readiness checked" : readinessWarning ? "Status loaded, readiness warning" : status ? "Status loaded" : loading ? "Checking" : "Unknown"));
  // One card per row, keyed by the row id. Every battlegroup container has
  // exactly one home here, so nothing is reported twice.
  //
  // battlegroup has no readiness-derived fallback: `dune ready` reports per
  // container and per check, with nothing that corresponds to "the director and
  // gateway as a pair".
  const raw: Record<string, { label: string; status: string; detail: string }> = {
    database: preferKnownHomeHealth(summarizeDatabase(status), summarizeReadinessDatabase(readiness)),
    messaging: preferKnownHomeHealth(summarizeMessaging(status), summarizeReadinessRabbit(readiness)),
    battlegroup: summarizeBattlegroupServices(status),
    games: preferKnownHomeHealth(summarizeGameServers(status), summarizeReadinessGameServers(readiness)),
    fls: preferKnownHomeHealth(summarizeFls(status, funcomTokenAuthFailure), summarizeReadinessFls(readiness))
  };
  const rawGames = raw.games;
  // ready.sh reports READY off the core containers and the two protected maps
  // only -- it has no notion of the wider always-on roster. So on a host with
  // more always-on maps it says READY while several are still coming up, and
  // believing it left the hero reading "Ready" beside "Game servers 2 of 7".
  // A readiness all-clear is not allowed to override the roster.
  const rosterWarming = isGameServersComingUp(rawGames.label);
  const rosterIncomplete = rosterWarming || /^Needs Review$/i.test(rawGames.label);
  const coreReadyWithReview = !runningAction && isHomeCoreReadyWithReview(status, readiness, raw);
  const isStarting = runningAction === "start" || runningAction === "restart" || restartSuccessAwaitingFreshStatus || rosterWarming || (bootStarting && !coreReadyWithReview);
  const restartSuccessObserved = taskResult?.status === "succeeded" && /restart/i.test(taskResult.title || "");
  const restartStartObserved = restartStarted || restartSuccessAwaitingFreshStatus || restartSuccessObserved;
  const transitionOverall = runningAction === "restart"
    ? restartStartObserved ? "Starting" : "Restarting Battlegroup"
    : runningAction === "stop" ? "Stopping" : isStarting ? "Starting" : "";
  const attentionHealth = !isStarting && !restartSuccessAwaitingFreshStatus && (serverState.stopped || actionStopped || actionFailed) ? attentionHomeHealthCard(serverState.stopped || actionStopped ? "stopped" : "failed") : null;
  // status and readiness are two separate reads, so they can disagree: a stop
  // updates status to STOPPED while readiness is still the previous "READY:".
  // Believing readiness there left the heading and every row reading Ready
  // under a "Battlegroup Stopped" banner. A stop we observed, or an Overall:
  // STOPPED, beats a stale all-clear.
  const readinessAllClear = readinessReady && !attentionHealth && !rosterIncomplete;
  const transitionAction: "start" | "stop" | "restart" | "" = restartStartObserved
    ? "start"
    : runningAction === "restart" ? ""
      : runningAction || (restartSuccessAwaitingFreshStatus || rosterWarming || (bootStarting && !coreReadyWithReview) ? "start" : "");
  // Database Only is a stopped battlegroup over a live Postgres. The blanket
  // "Stopped" below would have the Database row contradict the heading, so that
  // one row keeps its own reading.
  const databaseStillUp = serverState.databaseOnly && !actionStopped;
  const healthRows: HomeHealthRow[] = HOME_HEALTH_ROWS.map(({ id, label }) => {
    const rawCard = raw[id];
    // Applied per row, and only to a row that is not itself reporting a fault.
    //
    // This override only ever does anything when the two reads DISAGREE: when
    // they agree the row is already OK. So it is really the rule "when status
    // and readiness disagree, believe readiness" -- and every guard above it was
    // carved out after a case where that was wrong (an observed stop, an
    // incomplete map roster). A container or listener fault that status reports
    // and readiness does not was the third: `ready.sh` checks the same
    // containers and TCP ports, so the two are contradicting each other about
    // the same fact, and one of the reads is simply stale.
    //
    // Showing the fault is the fail-safe direction. At worst it is one poll of
    // amber that clears itself; hiding it makes a real outage read green.
    // Filling in a reading status could not produce at all (Unknown) is still
    // worth doing, which is what this override is left to do.
    //
    // Nothing hangs on it: isHomeActionComplete is satisfied by readinessReady
    // alone, so a row left at WARN cannot stall a start or a restart, and mid
    // transition transitionHomeHealthCard below still reports "Getting Ready".
    const readyOverride = readinessAllClear && !homeCardReportsFault(rawCard) ? HOME_READY_CARD : null;
    const shown = id === "fls" && funcomTokenAuthFailure
      ? { label: "Token Mismatch Detected", status: "FAILED", detail: "" }
      : readyOverride || transitionHomeHealthCard(rawCard, transitionAction) || (databaseStillUp && id === "database" ? null : attentionHealth) || rawCard;
    // The count comes from the RAW reading, not from whichever display override
    // won. readyOverride and transitionHomeHealthCard both carry an empty
    // detail, so taking it from them would blank the count in the two states it
    // is most wanted: healthy, and mid-start. "3 of 7" is equally true whether
    // the row is showing OK or "Getting Ready".
    return { id, label, value: shown.label, status: shown.status, detail: rawCard.detail };
  });
  // The rows are computed first so the heading can be held to them. Everything
  // that can make this green flows through applyHeroHealthFloor -- keep it that
  // way: exactly one binding named `overall`, defined once, consumed once. An
  // ungated `overall` left in scope is how the last three incidents happened.
  //
  // rosterIncomplete still appears twice: blocking the readiness all-clear at
  // the front does not stop liveOverall, which is "OK" whenever readiness
  // reports READY.
  const overallCandidate = readinessReady && !runningAction && !attentionHealth && !rosterIncomplete ? "OK" : isStarting ? transitionOverall : runningAction ? transitionOverall : serverState.databaseOnly && !actionStopped ? "Database Only" : serverState.stopped || actionStopped ? "Stopped" : coreReadyWithReview ? "Needs Review" : rosterIncomplete ? "Needs Review" : liveOverall;
  const overall = applyHeroHealthFloor(overallCandidate, healthRows);
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
    health: healthRows
  };
}

// Exported for the regression guard in ServerPanels.homeCards.test.tsx: this and
// isHomeActionComplete both read summarizeHomeStatus()'s identity/health arrays,
// so dropping an entry has to fail a test rather than silently break the poll
// cadence and restart detection.
export function homeNeedsWarmRefresh(status: string, readiness: string) {
  if (!status && !readiness) return false;
  // A stopped battlegroup lists its maps as WAIT (nothing to spawn them yet),
  // which would otherwise hold the fresh 5s poll for as long as it stays down.
  if (/Overall:\s*STOPPED\b/i.test(status)) return false;
  const summary = summarizeHomeStatus(status, readiness, "", false);
  const overall = summary.identity.find((item) => item.label === "Overall");
  const games = summary.health.find((item) => item.id === "games");
  const overallOk = /^OK$/i.test(String(overall?.value || "")) || /^Ready$/i.test(String(overall?.status || ""));
  const gamesOk = /^OK$/i.test(String(games?.value || "")) && /^Ready$/i.test(String(games?.status || ""));
  const gameServerText = sectionLines(status, "Game servers").join("\n");
  const warming = /Overall:\s*(WARMING|WAIT|STARTING)/i.test(status) ||
    /\b(WARMING|WAIT|QUEUED|STARTING)\b/i.test(gameServerText) ||
    isGameServersComingUp(games?.value) || /^Starting$/i.test(String(games?.value || "")) ||
    isHomeBootStarting(status, readiness);
  return warming && (!overallOk || !gamesOk);
}

function isHomeCoreReadyWithReview(
  status: string,
  readiness: string,
  cards: Record<string, { label: string; status: string; detail: string }>
) {
  const text = `${status}\n${readiness}`;
  const gamesReady = isReadyHomeCard(cards.games) || (/OK\s+Survival_1\s+ready/i.test(text) && /OK\s+Overmap\s+ready/i.test(text));
  const databaseReady = isReadyHomeCard(cards.database) || /OK\s+world_partition rows:/i.test(text);
  const messagingReady = isReadyHomeCard(cards.messaging) || /OK\s+game server sg\.\* RMQ connections/i.test(text);
  const hasReview = Object.values(cards).some((item) => /^Needs Review$/i.test(item.label) || /^WARN$/i.test(item.status));
  return gamesReady && databaseReady && messagingReady && hasReview;
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

// Game servers are the slowest part of a start: measured on a live restart, two
// maps took roughly four minutes to reach READY, and a host with more always-on
// maps brings them up in batches (DUNE_ALWAYS_ON_STARTUP_PARALLELISM). So wait
// for them -- but never indefinitely. A map that stays WARMING must not pin the
// console in "Starting" with its controls disabled forever, so once this window
// has passed a battlegroup whose only remaining gap is warming maps counts as
// started. This is a backstop, not a target.
export const GAME_SERVER_WARMUP_GRACE_MS = 10 * 60 * 1000;

// Measured on the 2026-08-31 live restart: a map reached READY roughly three
// minutes after its container started. Four gives margin.
const GAME_SERVER_WARMUP_PER_BATCH_MS = 4 * 60 * 1000;

// A backstop on the backstop. However many maps are configured, the console
// stops waiting eventually.
const GAME_SERVER_WARMUP_GRACE_CAP_MS = 45 * 60 * 1000;

// How long a start may legitimately take before a still-warming map is treated
// as "close enough to done".
//
// A flat budget was wrong once the section reported every always-on map rather
// than two: the autoscaler brings them up a few at a time
// (DUNE_ALWAYS_ON_STARTUP_PARALLELISM, clamped by host memory safety), so the
// wait scales with the number of BATCHES, not the number of maps. status.sh
// publishes the concurrency on the section's Note: line -- which every row
// parser already ignores -- so no extra request is needed to read it.
//
// Falls back to the flat floor when the section or the note is absent, so an
// older backend or a roster that could not be read behaves exactly as before.
export function gameServerWarmupGraceMs(status: string) {
  const rows = gameServerRows(status);
  if (!rows.length) return GAME_SERVER_WARMUP_GRACE_MS;
  const noted = String(status || "").match(/starting\s+(\d+)\s+at a time/i);
  const concurrency = Math.max(1, Number(noted?.[1]) || 1);
  const batches = Math.ceil(rows.length / concurrency);
  return Math.min(
    GAME_SERVER_WARMUP_GRACE_CAP_MS,
    Math.max(GAME_SERVER_WARMUP_GRACE_MS, batches * GAME_SERVER_WARMUP_PER_BATCH_MS)
  );
}

export function isHomeActionComplete(status: string, readiness: string, elapsedMs: number = Number.POSITIVE_INFINITY) {
  const statusReady = isHomeStartComplete(status, readiness);
  const readinessReady = isHomeReadinessOperational(readiness);
  const summary = summarizeHomeStatus(status, readiness, "", false);
  const games = summary.health.find((item) => item.id === "games");
  const healthOk = summary.health.length > 0 && summary.health.every((item) =>
    /^OK$/i.test(String(item.value || "")) && /^Ready$/i.test(String(item.status || ""))
  );
  const nonGameHealthOk = summary.health.filter((item) => item.id !== "games").every((item) =>
    /^OK$/i.test(String(item.value || "")) && /^Ready$/i.test(String(item.status || ""))
  );
  const gamesWarming = isGameServersComingUp(games?.value);
  // Inside the grace window a warming map blocks completion outright. None of
  // the signals below can stand in for it: isHomeReadinessOperational only
  // proves the map containers are up, not that the maps are playable.
  //
  // Read the raw summariser rather than gamesWarming above: summarizeHomeStatus
  // rewrites every health row to OK once readiness reports READY (readyOverride),
  // so the view model reports a warming map as OK and the gate would never fire.
  const rawGamesWarming = isGameServersComingUp(summarizeGameServers(status).label);
  if (rawGamesWarming && elapsedMs < gameServerWarmupGraceMs(status)) return false;
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

// status.sh prints ten container rows, but only these eight are battlegroup
// services. dune-orchestrator is the control plane -- it creates and removes the
// others, so it is always Up, including with the battlegroup stopped -- and
// dune-coriolis-coordinator is optional (DUNE_CORIOLIS_COORDINATOR_ENABLED=0
// deletes it, and start-all treats a failed start as non-fatal). Scanning the
// printed rows instead of this list makes "all down" unreachable, "any up"
// always true, and reports a disabled coordinator as a container problem.
const BATTLEGROUP_CONTAINERS = [
  "dune-postgres",
  "dune-rmq-admin",
  "dune-rmq-game",
  "dune-text-router",
  "dune-director",
  "dune-server-gateway",
  "dune-server-survival-1",
  "dune-server-overmap"
];

// docker's own status strings reach these rows verbatim, so a paused container
// arrives as "Up 3 hours (Paused)" -- it matches \bUp\b and would otherwise read
// as healthy. status.sh itself only ever emits a docker status, the literal
// "stopped", or the literal "missing"; the rest are kept for readiness text and
// any other producer of a container table.
const CONTAINER_DOWN = /\b(missing|stopped|exited|dead|paused|not running)\b/i;

// A completed stop, which is a different question from "is this container
// down". A paused container is down but has not stopped, so the restart
// lifecycle must not read it as a finished stop.
const CONTAINER_STOPPED = /\b(missing|stopped|exited|dead|not running)\b/i;

// The status table pads columns, so the name is everything before the first gap.
function containerLineName(line: string) {
  const trimmed = line.trim();
  const firstSpace = trimmed.search(/\s/);
  return firstSpace < 0 ? "" : trimmed.slice(0, firstSpace);
}

function containerSectionLines(status: string) {
  return sectionLines(status, "Containers").filter((line) => !/^SERVICE\s+STATUS/i.test(line));
}

// The single definition of which printed rows belong to the battlegroup, and
// the only way to ask about their status. Two shapes, deliberately NOT
// interchangeable -- collapsing either onto the other is a real bug:
//
//   rows()          the printed rows for the eight. A name with no printed row
//                   is simply absent, so the length shrinks. Callers that count
//                   rows or test emptiness want this.
//   all() / any()   quantify over the eight *names*. A name with no printed row
//                   makes all() false, so a truncated or partial table can
//                   never read as "they are all down" / "they are all up".
//
// all() and any() match the status text only, via containerStatusLineHas, so a
// container's name can never satisfy a status pattern.
const battlegroup = {
  rows(status: string) {
    return containerSectionLines(status).filter((line) =>
      BATTLEGROUP_CONTAINERS.includes(containerLineName(line).toLowerCase())
    );
  },
  all(status: string, pattern: RegExp) {
    const lines = containerSectionLines(status);
    return BATTLEGROUP_CONTAINERS.every((name) =>
      lines.some((line) => containerStatusLineHas(name, line, pattern))
    );
  },
  any(status: string, pattern: RegExp) {
    const lines = containerSectionLines(status);
    return BATTLEGROUP_CONTAINERS.some((name) =>
      lines.some((line) => containerStatusLineHas(name, line, pattern))
    );
  }
};

export function isHomeStopComplete(status: string, readiness: string) {
  if (getHomeServerState(status, readiness).stopped) return true;
  if (battlegroup.all(status, CONTAINER_STOPPED)) return true;

  const text = `${status}\n${readiness}`;
  const readinessContainersStopped = BATTLEGROUP_CONTAINERS.every((name) =>
    textHasContainerReadiness(text, "FAIL", name)
  );
  const allListenersMissing = sectionLines(status, "Listeners").filter((line) => !/^CHECK\s+PORT\s+STATUS/i.test(line)).length >= 6 &&
    sectionLines(status, "Listeners").filter((line) => !/^CHECK\s+PORT\s+STATUS/i.test(line)).every((line) => /\bMISSING\b/i.test(line));
  const gameServersStopped = /Survival_1\s+NOT RUNNING/i.test(text) && /Overmap\s+NOT RUNNING/i.test(text);
  return readinessContainersStopped || (allListenersMissing && gameServersStopped);
}

function hasRestartStopSignal(status: string, readiness: string) {
  const text = `${status}\n${readiness}`;
  return battlegroup.any(status, CONTAINER_STOPPED) ||
    BATTLEGROUP_CONTAINERS.some((name) => textHasContainerReadiness(text, "FAIL", name));
}

function hasRestartStartSignal(status: string, readiness: string) {
  const text = `${status}\n${readiness}`;
  return battlegroup.any(status, /\bUp\b/i) ||
    BATTLEGROUP_CONTAINERS.some((name) => textHasContainerReadiness(text, "OK", name));
}

export function isHomeStartComplete(status: string, readiness: string) {
  const serverState = getHomeServerState(status, readiness);
  if (serverState.stopped) return false;

  const containersReady = battlegroup.all(status, /^Up\b/i);

  const listenerLines = sectionLines(status, "Listeners").filter((line) => !/^CHECK\s+PORT\s+STATUS/i.test(line));
  const listenersReady = listenerLines.length > 0 && !listenerLines.some((line) => /\b(MISSING|FAIL|ERROR)\b/i.test(line));

  const partitionValue = findLineValue(sectionLines(status, "Database").join("\n"), ["World partitions"]);
  const databaseReady = Number(partitionValue) > 0;

  const flsLines = sectionLines(status, "Funcom/FLS summary");
  const flsReady = flsLines.length > 0 && !flsLines.some((line) => /:\s*(WAIT|FAIL|ERROR|MISSING)/i.test(line));

  const messaging = summarizeMessaging(status);
  const messagingReady = /^OK$/i.test(messaging.label) && /^Ready$/i.test(messaging.status);

  // A battlegroup whose containers are up but whose maps are still WARMING is
  // not ready to play on, so the maps gate "started" like everything else.
  // isHomeActionComplete owns the grace window that stops a map stuck warming
  // from hanging the lifecycle on this.
  const games = summarizeGameServers(status);
  const gameServersReady = /^OK$/i.test(games.label) && /^Ready$/i.test(games.status);

  return containersReady && listenersReady && databaseReady && flsReady && messagingReady && gameServersReady;
}

// dune-postgres, dune-orchestrator and dune-coriolis-coordinator all run
// without a Battlegroup -- the console starts Postgres by itself for backups
// and restores -- so none of them says whether the Battlegroup is up. Only the
// game stack does.
const gameStackContainers = [
  "dune-rmq-admin",
  "dune-rmq-game",
  "dune-text-router",
  "dune-director",
  "dune-server-gateway",
  "dune-server-survival-1",
  "dune-server-overmap"
];

export function isGameStackDown(status: string) {
  const containerLines = sectionLines(status, "Containers").filter((line) => !/^SERVICE\s+STATUS/i.test(line));
  const reported = gameStackContainers.filter((name) => containerLines.some((line) => containerStatusLineHas(name, line, /.*/)));
  // A partial container list is not evidence of anything.
  if (reported.length < gameStackContainers.length) return false;
  return gameStackContainers.every((name) => containerLines.some((line) =>
    containerStatusLineHas(name, line, /\b(missing|stopped|exited|dead|not running)\b/i)));
}

export function containerStatusLineHas(containerName: string, line: string, statusPattern: RegExp) {
  const name = containerLineName(line);
  if (!name || name.toLowerCase() !== containerName.toLowerCase()) return false;
  const trimmed = line.trim();
  const firstSpace = trimmed.search(/\s/);
  // Status output may pad columns with multiple spaces or tabs. Normalize
  // the remainder before applying either anchored or unanchored patterns.
  return statusPattern.test(trimmed.slice(firstSpace + 1).trimStart());
}

function textHasContainerReadiness(text: string, state: "OK" | "FAIL", containerName: string) {
  return text.split(/\r?\n/).some((line) => {
    const match = line.trim().match(/^(OK|FAIL)\s+container\s+(\S+)\b/i);
    return Boolean(match && match[1].toUpperCase() === state && match[2].toLowerCase() === containerName.toLowerCase());
  });
}

// Applied when the battlegroup is down or an action failed. The two are not
// the same: a stopped battlegroup has a known cause and every subsystem is off,
// while a failed start leaves the subsystems in whatever state the failure left
// them. Saying "Stopped" for a failed start would be a false claim.
// Every row gets the same card, so this is one card rather than a per-row map.
type HomeRowSeverity = "fail" | "warn" | "transition" | "unknown" | "ok";

// Order is load-bearing: transition MUST be tested before warn, because
// normalizeStatus("Starting") returns "warn". Checking normalizeStatus first
// would classify every transitional row as a warning and make the hero read
// "Needs Review" through every normal start.
//
// Status first, value second: three transitional values (Warming, Waiting,
// Getting Ready) share the one Starting status, so keying on value alone lets a
// future fourth slip through as ok.
function homeHealthRowSeverity(row: { value: string; status: string }): HomeRowSeverity {
  if (/^Starting$/i.test(row.status) || /^(Warming|Waiting|Getting Ready)$/i.test(row.value)) return "transition";
  const normalized = normalizeStatus(String(row.status || ""));
  if (normalized === "fail") return "fail";
  if (normalized === "warn") return "warn";
  if (/^Unknown$/i.test(row.status)) return "unknown";
  return "ok";
}

const HOME_ROW_SEVERITY_ORDER: HomeRowSeverity[] = ["fail", "warn", "transition"];

// The hero is never greener than its worst health row.
//
// "OK" is produced in four independent expressions -- the Overall ternary's
// first branch, liveOverall's readinessReady arm, friendlyHomeOverall("READY"),
// and friendlyHomeOverall's passthrough into inferStatus's pass-list -- each
// with its own guard set. Guarding them one at a time is what let a green
// heading sit above a "Needs Review" row three separate times. This is the one
// place they all flow through, so a guard added here protects every producer,
// including ones added later.
//
// Only ever downgrades. A non-green heading is returned byte-identical, so
// nothing that reads the hero can be made *more* optimistic by this.
//
// `unknown` deliberately does not downgrade: an absent reading is not a
// severity, and preferKnownHomeHealth exists precisely to paper over first-paint
// gaps. Making Unknown a trigger would flicker the heading on every cold load.
export function applyHeroHealthFloor(candidate: string, rows: readonly { value: string; status: string }[]) {
  if (!heroReadsGreen(candidate)) return candidate;
  for (const severity of HOME_ROW_SEVERITY_ORDER) {
    const worst = rows.find((row) => homeHealthRowSeverity(row) === severity);
    if (!worst) continue;
    // Transitional rows resolve to the fixed word rather than the row's own
    // value: "Starting" is a first-class hero value everywhere downstream,
    // where "Warming" badges Info and dots attention.
    return severity === "transition" ? "Starting" : worst.value;
  }
  return candidate;
}

function attentionHomeHealthCard(reason: "stopped" | "failed") {
  return reason === "stopped"
    ? { label: "Stopped", status: "FAILED", detail: "" }
    : { label: "Needs Review", status: "WARN", detail: "" };
}

function transitionHomeHealthCard(item: { label: string; status: string; detail: string }, runningAction: "start" | "stop" | "restart" | "") {
  if (runningAction !== "start" && runningAction !== "restart") return null;
  if (/^OK$/i.test(item.label) && /^Ready$/i.test(item.status)) return item;
  if (isGameServersComingUp(item.label)) return item;
  return { label: "Getting Ready", status: "Starting", detail: "" };
}

const HOME_READY_CARD = { label: "OK", status: "Ready", detail: "" };

// A row that positively reports a fault. Unknown is deliberately not one: it
// means "no reading", which is exactly what a readiness all-clear may fill in.
function homeCardReportsFault(card: { status: string }) {
  return /^(WARN|FAILED)$/i.test(String(card.status || ""));
}

function preferKnownHomeHealth(primary: { label: string; status: string; detail: string }, fallback: { label: string; status: string; detail: string }) {
  return /^Unknown$/i.test(primary.label) && !/^Unknown$/i.test(fallback.label) ? fallback : primary;
}

export function getHomeServerState(status: string, readiness: string) {
  const text = `${status}\n${readiness}`;
  const overall = findLineValue(status, ["overall"]);
  const containerLines = containerSectionLines(status);
  // No length guard needed: all() quantifies over the eight names, so a name
  // with no printed row already makes this false on an empty or partial table.
  const allContainersMissing = battlegroup.all(status, CONTAINER_DOWN);
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
    publishOnlyPartialState,
    isGameStackDown(status)
  ];
  // A state the console creates on purpose: it starts Postgres by itself for
  // backups and restores, and leaves it up. Calling that plainly "stopped"
  // hides a running database, and calling it "starting" was the bug this
  // replaces -- nothing is starting.
  const databaseUp = containerLines.some((line) => containerStatusLineHas("dune-postgres", line, /^Up\b/i));
  const databaseOnly = databaseUp && isGameStackDown(status);
  const stopped = !bootStarting && stoppedSignals.some(Boolean);
  const running = !stopped && runningSignals.some(Boolean);
  const starting = bootStarting || (!stopped && !running && coreRuntimeContainerUp && (/\bUp\s+\d+/i.test(text) || /\b(WARMING|WAIT|QUEUED|STARTING)\b/i.test(text)));
  return { running, stopped, starting, databaseOnly };
}

function isHomeBootStarting(status: string, readiness: string) {
  const text = `${status}\n${readiness}`;
  if (!text.trim()) return false;
  if (/\b(server|stack)\s+(is\s+)?(stopped|offline)\b/i.test(text) || /\bNo\s+(running\s+)?containers\b/i.test(text)) return false;
  if (/Overall:\s*(READY|STOPPED|OFFLINE)/i.test(status) || /^READY:/m.test(readiness)) return false;
  if (isGameStackDown(status)) return false;
  const containerLines = containerSectionLines(status);
  const battlegroupLines = battlegroup.rows(status);
  const anyContainerUp = battlegroupLines.some((line) => /\bUp\b/i.test(line));
  const coreStartupContainerUp = containerLines.some((line) =>
    /^(dune-postgres|dune-rmq-admin|dune-rmq-game|dune-text-router|dune-server-survival-1|dune-server-overmap)\s+.*\bUp\b/i.test(line)
  );
  const missingContainers = battlegroupLines.filter((line) => CONTAINER_DOWN.test(line)).length;
  if (battlegroupLines.length >= 8 && missingContainers >= 8 && !anyContainerUp) return false;
  const listenerLines = sectionLines(status, "Listeners").filter((line) => !/^CHECK\s+PORT\s+STATUS/i.test(line));
  const missingListeners = listenerLines.filter((line) => /\bMISSING\b/i.test(line)).length;
  const gameServersStopped = /Survival_1\s+NOT RUNNING/i.test(text) && /Overmap\s+NOT RUNNING/i.test(text);
  if (gameServersStopped && listenerLines.length > 0 && missingListeners === listenerLines.length && !anyContainerUp) return false;
  if (gameServersStopped && anyContainerUp && !coreStartupContainerUp) return false;
  const gameServerText = sectionLines(status, "Game servers").join("\n");
  if (/Overall:\s*(WARMING|STARTING)/i.test(status) || /\b(WARMING|QUEUED|STARTING)\b/i.test(gameServerText)) return true;
  const readinessStarting = coreStartupContainerUp &&
    /^\s*(WARN|FAIL)\s+container\s+dune-/im.test(readiness) &&
    !/^\s*OK\s+container\s+dune-server-(survival-1|overmap)\b/im.test(readiness);
  return coreStartupContainerUp || readinessStarting || (coreStartupContainerUp && battlegroupLines.length > 0 && missingContainers > 0) || (coreStartupContainerUp && listenerLines.length > 0 && missingListeners > 0);
}

// Colours nothing on screen: the hero dot reads homeStateDotTone(overall.value).
// This produces identity[0].status, whose only remaining consumer is
// homeNeedsWarmRefresh's poll-cadence check. Kept correct because a helper that
// calls a failed readiness check "Ready" is wrong regardless of who reads it.
export function homeOverallBadge(value: string) {
  const normalized = String(value || "").trim().toLowerCase();
  if (/\b(restarting|restart|stopping|starting)\b/.test(normalized)) return "WARN";
  if (/^stopped$/i.test(value)) return "WARN";
  if (/^database only$/i.test(value)) return "WARN";
  if (/^issue(?: detected)?$/i.test(value)) return "WARN";
  if (/warming/i.test(value)) return "Info";
  if (/stopped|not running|offline/i.test(value)) return "WARN";
  // Only ever the label for a readiness run that did NOT pass (a passing one
  // reads "OK"), but inferStatus matches "checked" against its pass list.
  if (normalized === "readiness checked") return "WARN";
  // Something is flagged, but inferStatus finds no keyword and falls through to
  // "Info" -- the same neutral as "Unknown", i.e. "nothing known yet".
  if (normalized === "needs review") return "WARN";
  // The Funcom/FLS row's value when the stored token is rejected. Only reachable
  // here since applyHeroHealthFloor mirrors the worst row into the hero, and
  // inferStatus matches no keyword in the phrase -- so a credential fault would
  // otherwise badge "Unknown", i.e. "nothing known yet".
  if (normalized === "token mismatch detected") return "Failed";
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

export function summarizeContainers(text: string) {
  // Scoped to the battlegroup eight: a coordinator that is off by configuration
  // is not a container problem, and reporting it as one put "Needs Review" on
  // the row while the other five read OK.
  const lines = battlegroup.rows(text);
  if (!lines.length) return { label: "Unknown", status: "Unknown", detail: "" };
  // Denominator is the expected eight, not the printed rows: a container with
  // no row at all is missing, and "7 of 7" would hide exactly that.
  const up = lines.filter((line) => !CONTAINER_DOWN.test(line)).length;
  const detail = `${up} of ${BATTLEGROUP_CONTAINERS.length}`;
  const bad = lines.find((line) => CONTAINER_DOWN.test(line));
  return bad ? { label: "Needs Review", status: "WARN", detail } : { label: "OK", status: "Ready", detail };
}

// Which services each row owns. Every battlegroup container has exactly one
// home, so nothing is counted twice: the Containers and Listeners rows used to
// re-report services that Database, Messaging, Game servers and Funcom/FLS
// already covered.
const DATABASE_CONTAINERS = ["dune-postgres"];
const MESSAGING_CONTAINERS = ["dune-rmq-admin", "dune-rmq-game", "dune-text-router"];
const BATTLEGROUP_SERVICE_CONTAINERS = ["dune-director", "dune-server-gateway"];

// Listener rows keyed by `${port}/${protocol}` -- the only unique key. Labels
// repeat: two partitions of Survival_1 both print "Survival_1 clients", on
// different ports, and a map may be named anything Funcom's world template
// contains. Ports come from the instance's resolved configuration, not the
// stock values, so a host on non-default ports still attributes correctly.
function listenerRows(text: string) {
  return sectionLines(text, "Listeners").flatMap((line) => {
    const match = line.match(/^(.+?)\s+(\d{2,5})\/(tcp|udp)\s+(\S+)$/i);
    return match ? [{ label: match[1], key: `${match[2]}/${match[3].toLowerCase()}`, state: match[4].toUpperCase() }] : [];
  });
}

function listenerStates(text: string) {
  return new Map(listenerRows(text).map((row) => [row.key, row.state]));
}

// The six TCP service ports, by owning row. Everything else in the section --
// every map client/S2S port, fixed or dynamically spawned -- belongs to Game
// servers, so no listener row is unowned and none is owned twice.
function ownedListenerKeys() {
  const ports = getServerPorts();
  return {
    database: [`${ports.postgres}/tcp`],
    messaging: [`${ports.rmqAdmin}/tcp`, `${ports.rmqGame}/tcp`, `${ports.rmqGameHttp}/tcp`, `${ports.textRouter}/tcp`],
    battlegroup: [`${ports.director}/tcp`]
  };
}

// A port that is not printed at all is unknown, not failed: status.sh omits
// rows whose port could not be resolved.
function listenerPortsOk(states: Map<string, string>, keys: string[]) {
  return keys.every((key) => !states.has(key) || states.get(key) === "OK");
}

function mapListenerPortsOk(text: string) {
  const owned = ownedListenerKeys();
  const service = new Set([...owned.database, ...owned.messaging, ...owned.battlegroup]);
  const states = listenerStates(text);
  return [...states.entries()].every(([key, state]) => service.has(key) || state === "OK");
}

// How many of a row's containers are up, from the container table.
function serviceContainerState(text: string, names: string[]) {
  const lines = containerSectionLines(text);
  const rows = names.map((name) => lines.find((line) => containerLineName(line).toLowerCase() === name));
  return {
    listed: rows.filter(Boolean).length,
    up: rows.filter((line) => line && !CONTAINER_DOWN.test(line)).length,
    total: names.length
  };
}

// Counts are services, not checks: a closed port turns the row amber without
// changing the denominator, so "Messaging" reads 3 of 3 rather than 7 of 7.
function summarizeServiceGroup(text: string, names: string[], portKeys: string[]) {
  const { listed, up, total } = serviceContainerState(text, names);
  if (!listed) return { label: "Unknown", status: "Unknown", detail: "" };
  const detail = `${up} of ${total}`;
  if (up < total) return { label: "Needs Review", status: "WARN", detail };
  if (!listenerPortsOk(listenerStates(text), portKeys)) return { label: "Needs Review", status: "WARN", detail };
  return { label: "OK", status: "Ready", detail };
}

function summarizeMessaging(text: string) {
  const group = summarizeServiceGroup(text, MESSAGING_CONTAINERS, ownedListenerKeys().messaging);
  if (!/^OK$/i.test(group.label)) return group;
  // This row also owns the game broker's connection report: the containers can
  // all be up while no game server has actually connected to the broker.
  const lines = sectionLines(text, "RabbitMQ game connections");
  if (lines.some((line) => /not running|missing|failed/i.test(line))) {
    return { ...group, label: "Needs Review", status: "WARN" };
  }
  const director = numberAfterLabel(lines, "Director connections");
  const game = numberAfterLabel(lines, "Game server connections");
  if ((director !== null && director < 1) || (game !== null && game < 1)) {
    return { ...group, label: "Needs Review", status: "WARN" };
  }
  return group;
}

function summarizeBattlegroupServices(text: string) {
  return summarizeServiceGroup(text, BATTLEGROUP_SERVICE_CONTAINERS, ownedListenerKeys().battlegroup);
}

function summarizeDatabase(text: string) {
  const value = findLineValue(sectionLines(text, "Database").join("\n"), ["World partitions"]);
  if (!value) return { label: "Unknown", status: "Unknown", detail: "" };
  const count = Number(value);
  // This row owns dune-postgres outright, so it reports the container and its
  // port as well as the world data. It carries a count like every other row --
  // one service, so "1 of 1" -- rather than the partition figure, which is a
  // property of the world and not a measure of readiness.
  const { up, total } = serviceContainerState(text, DATABASE_CONTAINERS);
  const detail = `${up} of ${total}`;
  const portsOk = listenerPortsOk(listenerStates(text), ownedListenerKeys().database);
  const ready = Number.isFinite(count) && count > 0 && up === total && portsOk;
  if (ready) return { label: "OK", status: "Ready", detail };
  return { label: "Needs Review", status: "WARN", detail };
}

// The map rows of the Game servers section: the header and any Note: line are
// not servers. status.sh reports one row per expected always-on map server, so
// the length of this is the denominator for how long a start should take.
function gameServerRows(text: string) {
  return sectionLines(text, "Game servers").filter((line) => !/^MAP\s+STATE\s+UPTIME/i.test(line) && !/^Note:/i.test(line));
}

// "Warming" and "Waiting" both mean the maps are on their way up. Every caller
// that cares about that distinction-free question goes through here: a bare
// /^Warming$/i check would silently stop matching the moment a start is early
// enough to report Waiting.
export function isGameServersComingUp(label: unknown) {
  return /^(Warming|Waiting)$/i.test(String(label || ""));
}

function summarizeGameServers(text: string) {
  const lines = gameServerRows(text);
  if (!lines.length) return { label: "Unknown", status: "Unknown", detail: "" };
  const bad = lines.find((line) => /\b(ERROR|NOT RUNNING|MISSING)\b/i.test(line));
  // WARMING means the map server is up and loading. WAIT means it has not been
  // spawned yet -- world servers start after Postgres, RabbitMQ, the text
  // router and the director, so early in a start they are waiting on their
  // dependencies rather than warming. Reporting both as "Warming" overstated
  // how far along a start was. QUEUED is a map the autoscaler has not reached
  // yet, so it is waiting too.
  const warming = lines.find((line) => /\bWARMING\b/i.test(line));
  const waiting = lines.find((line) => /\b(WAIT|QUEUED)\b/i.test(line));
  const detail = `${lines.filter((line) => /\bREADY\b/i.test(line)).length} of ${lines.length}`;
  if (bad) return { label: "Needs Review", status: "WARN", detail };
  // Starting, not Info: this is a transitional state and the hero says
  // "Starting" at the same moment. Info read as a neutral aside for something
  // the operator is actively waiting on.
  if (warming) return { label: "Warming", status: "Starting", detail };
  if (waiting) return { label: "Waiting", status: "Starting", detail };
  // This row owns every listener port that is not one of the six TCP service
  // ports -- all the map client and S2S ports, fixed and dynamic alike. Without
  // this they would be unowned once the flat Listeners row went away.
  if (!mapListenerPortsOk(text)) return { label: "Needs Review", status: "WARN", detail };
  return { label: "OK", status: "Ready", detail };
}

// Funcom/FLS is the LAST section status.sh prints, so sectionLines runs to end
// of output and picks up the trailing "Tip:" lines with it. Narrow to rows
// that actually carry a state: counting the tips made a healthy host read
// "4 of 6", and only luck kept them out of the failure check below -- one of
// those tips contains the word "fail".
function flsRows(text: string) {
  return sectionLines(text, "Funcom/FLS summary").filter((line) =>
    /:\s*(OK|WAIT|FAIL|ERROR|MISSING)\b/i.test(line)
  );
}

function summarizeFls(text: string, tokenAuthFailure = false) {
  const lines = flsRows(text);
  if (!lines.length) return { label: "Unknown", status: "Unknown", detail: "" };
  const bad = lines.find((line) => /:\s*(WAIT|FAIL|ERROR|MISSING)/i.test(line));
  // The token probe can fail before the cached status snapshot catches up.
  // Authentication invalidates the Director heartbeat; do not count that
  // cached OK or subtract it twice if status already reports it as failing.
  const detail = `${lines.filter((line) => /:\s*OK\b/i.test(line) && !(tokenAuthFailure && /^Director heartbeat\s*:/i.test(line))).length} of ${lines.length}`;
  if (bad) return { label: "Needs Review", status: "WARN", detail };
  return { label: "OK", status: "Ready", detail };
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

// What the (i) on each Readiness & Health row lists: the raw readings behind the
// row, as printed, so a "Needs Review" can be traced to the line that caused it.
// Same ownership as the summarisers above -- every container and port has one row.
type HomeDetailRow = { name: string; value: string; note?: string };
type HomeDetailGroup = { title: string; rows: HomeDetailRow[] };

const DETAIL_BAD = /\b(fail|error|missing|not listed|stopped|exited|dead|paused|not running|unhealthy|token mismatch)\b/i;

// Green only for a reading known to be healthy: docker's status text reaches
// these rows verbatim, and a figure like "0" partitions is not a state at all.
function homeDetailTone(value: string) {
  if (DETAIL_BAD.test(value)) return "bad";
  if (/\b(wait|warn|warming|queued|restarting|starting)\b/i.test(value)) return "pending";
  if (/^(ok|ready|up)\b/i.test(value)) return "good";
  return "";
}

function detailContainers(status: string, names: string[]): HomeDetailGroup {
  const lines = containerSectionLines(status);
  return {
    title: "Containers",
    rows: names.map((name) => {
      const line = lines.find((candidate) => containerLineName(candidate).toLowerCase() === name);
      return { name, value: line ? line.trim().slice(name.length).trim() : "Not listed" };
    })
  };
}

function detailPorts(rows: ReturnType<typeof listenerRows>): HomeDetailGroup {
  return { title: "Ports", rows: rows.map((row) => ({ name: `${row.label} ${row.key}`, value: row.state })) };
}

// Not readinessRows: that drops ready.sh's WAIT rows, which are the ones that
// explain an amber row.
function detailReadiness(readiness: string, pattern: RegExp) {
  return stripAnsi(readiness).split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(OK|WAIT|WARN|FAIL)\s+(.+)$/i);
    return match && pattern.test(match[2]) ? [{ name: match[2].replace(/^game server sg\.\* RMQ connections$/i, GAME_CONNECTIONS_LABEL), value: match[1].toUpperCase() }] : [];
  });
}

// Readings are "Label: value", except status.sh's "RabbitMQ game is not running".
function detailLabelled(lines: string[]) {
  return lines.flatMap((line) => {
    const match = line.match(/^(.+?)(?::\s*|\s+is\s+)(.+)$/);
    return match ? [{ name: match[1], value: match[2] }] : [];
  });
}

function detailMaps(status: string): HomeDetailGroup {
  return {
    title: "Maps",
    rows: gameServerRows(status).flatMap((line) => {
      const match = line.match(/^(\S+)\s+(NOT RUNNING|\S+)\s*(.*)$/i);
      if (!match) return [];
      // The uptime column explains a map that isn't up; anything routine there
      // is not a reason. A WAIT row can carry "missing" when Postgres is down.
      return [{ name: match[1], value: match[2], note: /^(up|pending|queued)\b/i.test(match[3]) ? undefined : match[3] || undefined }];
    })
  };
}

export function homeRowDetails(status: string, readiness: string, tokenAuthFailure = false): Record<string, HomeDetailGroup[]> {
  const listeners = listenerRows(status);
  const owned = ownedListenerKeys();
  const service = new Set([...owned.database, ...owned.messaging, ...owned.battlegroup]);
  const ports = (keys: string[]) => detailPorts(listeners.filter((row) => keys.includes(row.key)));
  const groups: Record<string, HomeDetailGroup[]> = {
    database: [
      detailContainers(status, DATABASE_CONTAINERS),
      ports(owned.database),
      { title: "Health", rows: [...detailLabelled(sectionLines(status, "Database")), ...detailReadiness(readiness, /world.partition/i)] }
    ],
    messaging: [
      detailContainers(status, MESSAGING_CONTAINERS),
      ports(owned.messaging),
      // "Checked by readiness" is a pointer, not a reading: the row below it is the check.
      { title: "Health", rows: [
        ...detailLabelled(sectionLines(status, "RabbitMQ game connections")).filter((row) => !/^Checked by readiness$/i.test(row.value)),
        ...detailReadiness(readiness, /game server sg\.\* RMQ connections/i)
      ] }
    ],
    battlegroup: [detailContainers(status, BATTLEGROUP_SERVICE_CONTAINERS), ports(owned.battlegroup)],
    games: [detailMaps(status), detailPorts(listeners.filter((row) => !service.has(row.key)))],
    fls: [{ title: "Health", rows: [
      ...detailLabelled(flsRows(status)),
      // ready.sh labels the gateway's wait row differently from its OK row.
      ...detailReadiness(readiness, /\b(Director FLS|Gateway monitoring DB|Gateway DB monitoring)\b/i)
    ] }]
  };
  if (tokenAuthFailure) {
    const health = groups.fls[0];
    const heartbeat = health.rows.filter((row) => /^Director(?: FLS)? heartbeat\b/i.test(row.name));
    if (heartbeat.length) heartbeat.forEach((row) => { row.value = "Token Mismatch Detected"; });
    else health.rows.push({ name: "Funcom/FLS", value: "Token Mismatch Detected" });
  }
  // No status yet means nothing to list, and a container reading "Not listed"
  // for every name would read as a fault.
  if (!containerSectionLines(status).length) groups.database = groups.messaging = groups.battlegroup = [];
  return Object.fromEntries(Object.entries(groups).map(([id, list]) => [id, list.filter((group) => group.rows.length)]));
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
  // An unknown CURRENT count is not a count. A stopped battlegroup prints
  // "Population: unknown/60", and rendering that as "?/60 online" states a
  // player figure nobody measured. The capacity half may still be unknown --
  // "14/?" is a real reading of 14 players -- so only the current side decides.
  //
  // This used to be handled by suppressing the whole segment whenever the HERO
  // read stopped/starting, which coupled a population decision to whatever word
  // the heading happened to show.
  if (normalizedCurrent === "?") return "";
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
