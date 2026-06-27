import { Fragment, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Grid2X2, List, Lock } from "lucide-react";
import { mapsApi, type LiveMapMemoryRow, type MemoryBalancerState, type UserSettingField, type UserSettingsSchema } from "../../api/maps";
import { setupApi, type Task } from "../../api/setup";
import { SecretInput } from "../../components/SecretInput";
import { KeyValueGrid, StatusPill, TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { firstDefined, formatUiSentence, stripAnsi, summarizeCommandText, titleCase } from "../../lib/display";
import { titleCaseWords } from "../players/playerAdminUtils";

type HomeTaskResult = { status: "running" | "succeeded" | "failed" | "stopped"; title: string; message?: string; details?: string };
type MapsResultScope = "maps" | "modifiers";
type MapsTaskOptions = {
  memoryUpdates?: Array<{ map: string; partitionId?: string; memory: string }>;
  resultScope?: MapsResultScope;
  resultTarget?: string;
  restartAcceptedMessage?: string;
  onRestartAccepted?: () => void;
};
type MapsTaskSequenceOptions = {
  saveAcceptedMessage?: string;
  memoryUpdates?: Array<{ map: string; partitionId?: string; memory: string }>;
  resultScope?: MapsResultScope;
  resultTarget?: string;
};
type PersistedMapsTask = { taskId?: string; result: HomeTaskResult | null; runningTitle?: string; successTitle?: string; resultScope?: MapsResultScope };
type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; details?: { label: string; value: string; tone?: "danger" | "success" | "accent" }[] }) => Promise<boolean>;
type MapsPanelProps = {
  onError: (text: string) => void;
  confirmAction: ConfirmAction;
  confirmSettingsRestart: (kind: "UserEngine" | "UserGame") => Promise<boolean>;
  waitForTaskWithUpdates: (task: Task, onUpdate: (task: Task) => void) => Promise<Task>;
  taskTechnicalDetails: (task: Task) => string;
};

function formatResultTitle(value: unknown, pending = false) {
  return formatUiSentence(value, pending);
}

function formatResultMessage(value: unknown) {
  return formatUiSentence(value, false);
}

function HomeTaskResultCard({ result }: { result: HomeTaskResult }) {
  const pending = result.status === "running";
  const resultClass = result.status === "succeeded" || result.status === "stopped" ? "ok" : result.status === "failed" ? "fail" : "running";
  return <div className={`result-panel home-task-result result-${resultClass}`} aria-live="polite">
    <strong className={pending ? "loading-dots" : ""}>{formatResultTitle(result.title, pending)}</strong>
    {result.message && <p>{formatResultMessage(result.message)}</p>}
    {result.details && <TechnicalDetails title="Technical details" text={result.details} />}
  </div>;
}

function inlineTaskResultClass(result: HomeTaskResult) {
  return result.status === "succeeded" || result.status === "stopped" ? "ok" : result.status === "failed" ? "fail" : "running";
}

function isDeepDesertDualResult(result: HomeTaskResult | null) {
  if (!result) return false;
  return /dual deep desert|extra deep desert/i.test(`${result.title || ""}\n${result.message || ""}`);
}

function isForceDespawnResult(result: HomeTaskResult | null) {
  if (!result) return false;
  return /\bdespawn/i.test(`${result.title || ""}\n${result.message || ""}`);
}

function isMapSettingsResult(result: HomeTaskResult | null) {
  if (!result) return false;
  return /\bmap settings\b|saving .+ settings|settings saved/i.test(`${result.title || ""}\n${result.message || ""}`);
}

function mapResultTarget(map: string, partitionId = "") {
  return partitionId ? `map:${map}:${partitionId}` : `map:${map}`;
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

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isTerminalTask(status: string) {
  return ["succeeded", "failed", "cancelled"].includes(status);
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

function MapModeGuide() {
  const modes = [
    {
      key: "core",
      name: "Core Map",
      summary: "Required World Service",
      detail: "Survival_1 and Overmap stay online because login, travel, server browser state, and the main world route depend on them."
    },
    {
      key: "dynamic",
      name: "Dynamic",
      summary: "Starts On Demand",
      detail: "The map starts when players travel to it, then shuts down after it becomes idle."
    },
    {
      key: "always-on",
      name: "Always On",
      summary: "Kept Running",
      detail: "The map remains online all the time, even when no players are currently using it."
    },
    {
      key: "overmap-active",
      name: "Overmap Active",
      summary: "Follows Overmap Players",
      detail: "The map starts while players are online in Overmap. When Overmap is empty, it waits 5 minutes before shutting down if no one is using it."
    },
    {
      key: "disabled",
      name: "Disabled",
      summary: "Blocked From Deployment",
      detail: "The map stays offline and will not auto-start, even if travel demand appears in-world."
    }
  ];
  return <div className="map-mode-guide" aria-label="Map mode guide">
    {modes.map((mode) => <article className={`map-mode-guide-card mode-${mode.key}`} key={mode.key}>
      <strong>{mode.name}</strong>
      <span>{mode.summary}</span>
      <p>{mode.detail}</p>
    </article>)}
  </div>;
}

function inferStatus(text: string) {
  if (!text) return "Unknown";
  if (/failed|failure|error|fatal|unhealthy|down|missing|cannot|could not/i.test(text)) return "Failed";
  if (/warning|warn|not ready|starting|waiting|partial|unavailable|attention/i.test(text)) return "Attention Needed";
  if (/ready|ok|healthy|running|listening|up|succeeded|success|checked|found/i.test(text)) return "Ready";
  return "Unknown";
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

function firstArray(...values: unknown[]) {
  return values.find((value) => Array.isArray(value)) as unknown[] | undefined;
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

export function MapsPanel({ onError, confirmAction, confirmSettingsRestart, waitForTaskWithUpdates, taskTechnicalDetails }: MapsPanelProps) {
  const [mapsText, setMapsText] = useState("");
  const [memoryText, setMemoryText] = useState("");
  const [serversText, setServersText] = useState("");
  const [readinessText, setReadinessText] = useState("");
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
  const [memoryBalancer, setMemoryBalancer] = useState<MemoryBalancerState | null>(null);
  const [memoryBalancerSaving, setMemoryBalancerSaving] = useState(false);
  const [sietchesText, setSietchesText] = useState("");
  const [sietchDimensionsText, setSietchDimensionsText] = useState("");
  const [sietchDimensionIdsText, setSietchDimensionIdsText] = useState("");
  const [activeSietches, setActiveSietches] = useState("1");
  const [sietchDrafts, setSietchDrafts] = useState<Record<string, { displayName: string; password: string }>>({});
  const [sietchPasswordTouched, setSietchPasswordTouched] = useState<Record<string, boolean>>({});
  const [selectedMapName, setSelectedMapName] = useState("");
  const [selectedPartitionId, setSelectedPartitionId] = useState("");
  const [userGameMapName, setUserGameMapName] = useState("");
  const [userGamePartitionId, setUserGamePartitionId] = useState("");
  const [selectedGameCategory, setSelectedGameCategory] = useState("");
  const [modifierFilter, setModifierFilter] = useState("");
  const [modifierViewMode, setModifierViewMode] = useState<"grid" | "list">("grid");
  const [settingsTab, setSettingsTab] = useState<"engine" | "game">("engine");
  const [modifiersOpen, setModifiersOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [memory, setMemory] = useState("8");
  const [modeDraft, setModeDraft] = useState("dynamic");
  const [loading, setLoading] = useState(false);
  const [mapsLoaded, setMapsLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [mapsResult, setMapsResult] = useState<HomeTaskResult | null>(() => loadPersistedMapsResult());
  const [mapsResultScope, setMapsResultScope] = useState<MapsResultScope>(() => loadPersistedMapsResultScope());
  const [mapsResultTarget, setMapsResultTarget] = useState("");
  const mapsLoadRef = useRef<Promise<void> | null>(null);
  const mapsRuntimeRefreshRef = useRef<Promise<void> | null>(null);
  const mapsDisplayedTerminalTaskRef = useRef<Set<string>>(new Set());
  async function run(action: () => Promise<unknown>) {
    onError("");
    try { await action(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  function applyOptimisticMemoryUpdates(updates: Array<{ map: string; partitionId?: string; memory: string }> = []) {
    if (!updates.length) return;
    setMemoryText((current) => updateMemoryStatusText(current, updates));
  }
  async function runTaskAndRefresh(action: () => Promise<{ task: Task }>, runningTitle = "Applying Map Changes", successTitle = "Map Changes Applied", options: MapsTaskOptions = {}) {
    const resultScope = options.resultScope || "maps";
    const resultTarget = options.resultTarget || "";
    const response = await action();
    const started: HomeTaskResult = { status: "running", title: runningTitle };
    setMapsResultScope(resultScope);
    setMapsResultTarget(resultTarget);
    setMapsResult(started);
    persistMapsTask({ taskId: response.task.id, result: started, runningTitle, successTitle, resultScope });
    let restartAcceptedShown = false;
    const final = await waitForTaskWithUpdates(response.task, (task) => {
      if (options.restartAcceptedMessage && isSettingsRestartHandoffTask(task)) {
        if (!restartAcceptedShown) {
          restartAcceptedShown = true;
          options.onRestartAccepted?.();
          mapsDisplayedTerminalTaskRef.current.add(task.id);
          setMapsResultScope(resultScope);
          setMapsResultTarget(resultTarget);
          setMapsResult({ status: "succeeded", title: successTitle, message: options.restartAcceptedMessage });
          persistMapsTask(null);
        }
        return;
      }
      if (restartAcceptedShown) return;
      const details = taskTechnicalDetails(task);
      const nextProgress: HomeTaskResult = {
        status: "running",
        title: runningTitle,
        details: details || task.progressMessage || task.currentStep
      };
      setMapsResultScope(resultScope);
      setMapsResultTarget(resultTarget);
      setMapsResult(nextProgress);
      persistMapsTask({ taskId: task.id, result: nextProgress, runningTitle, successTitle, resultScope });
    });
    const next: HomeTaskResult = final.status === "succeeded"
      ? { status: "succeeded", title: successTitle, details: taskTechnicalDetails(final) }
      : { status: "failed", title: "Map Change Failed", details: taskTechnicalDetails(final) || final.errorMessage || final.progressMessage };
    mapsDisplayedTerminalTaskRef.current.add(final.id);
    if (next.status === "succeeded") applyOptimisticMemoryUpdates(options.memoryUpdates);
    if (!restartAcceptedShown || next.status !== "succeeded") {
      setMapsResultScope(resultScope);
      setMapsResultTarget(resultTarget);
      setMapsResult(next);
    }
    persistMapsTask(null);
    await loadMaps();
    if (next.status === "succeeded") applyOptimisticMemoryUpdates(options.memoryUpdates);
    await loadUserEngine();
    if (userGameMapName) await loadSelectedSettings(userGameMapName, userGamePartitionId);
  }
  async function runTaskSequenceAndRefresh(actions: Array<{ label: string; run: () => Promise<{ task: Task }> }>, runningTitle = "Applying Map Changes", successTitle = "Map Changes Applied", options: MapsTaskSequenceOptions = {}) {
    if (!actions.length) return;
    const resultScope = options.resultScope || "maps";
    const resultTarget = options.resultTarget || "";
    const savingMessage = "Saving settings.";
    setMapsResultScope(resultScope);
    setMapsResultTarget(resultTarget);
    setMapsResult({ status: "running", title: runningTitle, message: savingMessage });
    persistMapsTask({ result: { status: "running", title: runningTitle, message: savingMessage }, runningTitle, successTitle, resultScope });
    let final: Task | null = null;
    let handedOffToWarming = false;
    let acceptedShown = false;
    for (const [index, action] of actions.entries()) {
      const progressMessage = `Step ${index + 1} of ${actions.length}: ${action.label}`;
      if (!handedOffToWarming) {
        setMapsResultScope(resultScope);
        setMapsResultTarget(resultTarget);
        setMapsResult({ status: "running", title: runningTitle, message: progressMessage });
        persistMapsTask({ result: { status: "running", title: runningTitle, message: progressMessage }, runningTitle, successTitle, resultScope });
      }
      const response = await action.run();
      if (!handedOffToWarming) {
        persistMapsTask({ taskId: response.task.id, result: { status: "running", title: runningTitle, message: progressMessage }, runningTitle, successTitle, resultScope });
      }
      final = await waitForTaskWithUpdates(response.task, (task) => {
        if (options.saveAcceptedMessage && isMapRuntimeHandoffTask(task)) {
          handedOffToWarming = true;
          mapsDisplayedTerminalTaskRef.current.add(task.id);
          if (!acceptedShown) {
            acceptedShown = true;
            const accepted: HomeTaskResult = { status: "succeeded", title: successTitle, message: options.saveAcceptedMessage };
            setMapsResultScope(resultScope);
            setMapsResultTarget(resultTarget);
            setMapsResult(accepted);
            persistMapsTask(null);
            void refreshMapRuntime().catch(() => undefined);
            void loadLiveMemory().catch(() => undefined);
            void loadSietches().catch(() => undefined);
          }
          return;
        }
        if (handedOffToWarming) return;
        const details = taskTechnicalDetails(task);
        const nextProgress: HomeTaskResult = {
          status: "running",
          title: runningTitle,
          message: progressMessage,
          details: details || task.progressMessage || task.currentStep
        };
        setMapsResultScope(resultScope);
        setMapsResultTarget(resultTarget);
        setMapsResult(nextProgress);
        persistMapsTask({ taskId: task.id, result: nextProgress, runningTitle, successTitle, resultScope });
      });
      if (final.status !== "succeeded") break;
    }
    const next: HomeTaskResult = final?.status === "succeeded"
      ? { status: "succeeded", title: successTitle, message: options.saveAcceptedMessage || undefined, details: options.saveAcceptedMessage ? undefined : taskTechnicalDetails(final) }
      : { status: "failed", title: "Map Change Failed", details: final ? taskTechnicalDetails(final) || final.errorMessage || final.progressMessage : "No task result." };
    if (final?.id) mapsDisplayedTerminalTaskRef.current.add(final.id);
    if (next.status === "succeeded") applyOptimisticMemoryUpdates(options.memoryUpdates);
    if (!handedOffToWarming || next.status !== "succeeded") {
      setMapsResultScope(resultScope);
      setMapsResultTarget(resultTarget);
      setMapsResult(next);
    }
    persistMapsTask(null);
    await loadMaps();
    if (next.status === "succeeded") applyOptimisticMemoryUpdates(options.memoryUpdates);
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
      setReadinessText(status.status === "fulfilled" ? String(mapStatus.readiness?.stdout || "") : "");
      setMemoryText(memoryStatus.status === "fulfilled" ? memoryStatus.value.stdout : "");
      if (status.status !== "fulfilled" || memoryStatus.status !== "fulfilled") {
        const failed = status.status === "rejected" ? status.reason : memoryStatus.status === "rejected" ? memoryStatus.reason : "";
        setLoadError(failed instanceof Error ? failed.message : String(failed));
      }
    })().finally(() => {
      mapsLoadRef.current = null;
      setMapsLoaded(true);
      setLoading(false);
    });
    return mapsLoadRef.current;
  }
  async function refreshMapRuntime() {
    if (mapsRuntimeRefreshRef.current) return mapsRuntimeRefreshRef.current;
    mapsRuntimeRefreshRef.current = (async () => {
      const [status, memoryStatus] = await Promise.allSettled([
        withTimeout(mapsApi.status(), 60000, "Refreshing map status timed out."),
        withTimeout(mapsApi.memory(), 60000, "Refreshing map memory timed out.")
      ]);
      if (status.status === "fulfilled") {
        setMapsText(String(status.value.maps?.stdout || ""));
        setServersText(String(status.value.services?.stdout || ""));
        setReadinessText(String(status.value.readiness?.stdout || ""));
      }
      if (memoryStatus.status === "fulfilled") {
        setMemoryText(memoryStatus.value.stdout);
      }
      if (status.status === "fulfilled" || memoryStatus.status === "fulfilled") {
        setLoadError("");
      }
    })().finally(() => {
      mapsRuntimeRefreshRef.current = null;
    });
    return mapsRuntimeRefreshRef.current;
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
  async function loadSietches(options: { preserveDrafts?: boolean } = {}) {
    const [list, dimensions, ids] = await Promise.all([mapsApi.sietches(), mapsApi.sietchDimensions("Survival_1"), mapsApi.sietchDimensions("Survival_1", true)]);
    setSietchesText(list.stdout || "");
    setSietchDimensionsText(dimensions.stdout || "");
    setSietchDimensionIdsText(ids.stdout || "");
    const rows = parseSietchRows(dimensions.stdout || list.stdout || "", ids.stdout || "");
    const drafts = Object.fromEntries(rows.map((row) => [row.partitionId, { displayName: row.displayName, password: row.password }]));
    if (rows.length) {
      if (!options.preserveDrafts) {
        setActiveSietches(String(rows.filter((row) => row.active).length || rows.length));
      }
      if (options.preserveDrafts) {
        setSietchDrafts((current) => ({ ...drafts, ...current }));
      } else {
        setSietchDrafts(drafts);
        setSietchPasswordTouched({});
      }
    }
  }
  async function loadLiveMemory() {
    const result = await mapsApi.liveMemory();
    setLiveMemory(result.rows || []);
    setMemoryError(result.error || "");
  }
  async function loadMemoryBalancer() {
    setMemoryBalancer(await mapsApi.memoryBalancer());
  }
  async function toggleMemoryBalancer() {
    setMemoryBalancerSaving(true);
    try {
      setMemoryBalancer(await mapsApi.setMemoryBalancer(!memoryBalancer?.enabled));
      await loadLiveMemory();
    } finally {
      setMemoryBalancerSaving(false);
    }
  }
  useEffect(() => {
    run(loadMaps);
    run(loadSchema);
    run(loadUserEngine);
    run(loadLiveMemory);
    run(loadMemoryBalancer);
    run(loadSietches);
  }, []);
  useEffect(() => {
    const persisted = loadPersistedMapsTask();
    if (!persisted?.taskId || persisted.result?.status !== "running") return;
    let cancelled = false;
    const runningTitle = persisted.runningTitle || persisted.result.title || "Applying Map Changes";
    const successTitle = persisted.successTitle || "Map Changes Applied";
    const resultScope = persisted.resultScope || "maps";
    (async () => {
      let current = (await setupApi.task(persisted.taskId || "")).task;
      while (!cancelled && !isTerminalTask(current.status)) {
        const details = taskTechnicalDetails(current);
        const nextProgress: HomeTaskResult = {
          status: "running",
          title: runningTitle,
          message: persisted.result?.message,
          details: details || current.progressMessage || current.currentStep
        };
        setMapsResultScope(resultScope);
        setMapsResult(nextProgress);
        persistMapsTask({ taskId: current.id, result: nextProgress, runningTitle, successTitle, resultScope });
        await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 1000));
        current = (await setupApi.task(current.id)).task;
      }
      if (cancelled) return;
      if (mapsDisplayedTerminalTaskRef.current.has(current.id)) {
        persistMapsTask(null);
        return;
      }
      const next: HomeTaskResult = current.status === "succeeded"
        ? { status: "succeeded", title: successTitle, details: taskTechnicalDetails(current) }
        : { status: "failed", title: "Map Change Failed", details: taskTechnicalDetails(current) || current.errorMessage || current.progressMessage };
      setMapsResultScope(resultScope);
      setMapsResult(next);
      persistMapsTask(null);
      await loadMaps();
      await loadSietches();
    })().catch((error) => {
      if (isMissingPersistedTaskError(error)) {
        persistMapsTask(null);
        setMapsResult(null);
        return;
      }
      onError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!mapsResult || mapsResult.status === "running") return;
    const clearDelayMs = mapsResultScope === "modifiers" && mapsResult.status === "succeeded" ? 5000 : 10400;
    const id = window.setTimeout(() => {
      setMapsResult(null);
      setMapsResultTarget("");
      setMapsResultScope("maps");
      persistMapsTask(null);
    }, clearDelayMs);
    return () => window.clearTimeout(id);
  }, [mapsResult, mapsResultScope]);
  useEffect(() => {
    const id = window.setInterval(() => { void loadLiveMemory().catch(() => {}); }, 5000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    const id = window.setInterval(() => { void loadMemoryBalancer().catch(() => {}); }, 5000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshMapRuntime().catch(() => {});
      void loadLiveMemory().catch(() => {});
      void loadSietches({ preserveDrafts: true }).catch(() => {});
    }, 5000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    const refreshVisibleMaps = () => {
      if (document.visibilityState !== "visible") return;
      void refreshMapRuntime().catch(() => {});
      void loadLiveMemory().catch(() => {});
      void loadSietches({ preserveDrafts: true }).catch(() => {});
    };
    window.addEventListener("focus", refreshVisibleMaps);
    document.addEventListener("visibilitychange", refreshVisibleMaps);
    return () => {
      window.removeEventListener("focus", refreshVisibleMaps);
      document.removeEventListener("visibilitychange", refreshVisibleMaps);
    };
  }, []);
  const mapRows = mergeMapAndMemoryRows(mapsText, memoryText, serversText);
  const serverPartitionRows = parseServerPartitionRows(serversText);
  const readinessStatusByPartitionId = parseReadinessPartitionStatuses(readinessText);
  const partitionStatusById = new globalThis.Map(serverPartitionRows.map((row) => [String(row.partitionId || ""), String(row.status || "")]));
  const selectedMap = mapRows.find((row) => String(row.map) === selectedMapName) || null;
  const selectedName = String(selectedMap?.map || "");
  const userGameMap = mapRows.find((row) => String(row.map) === userGameMapName) || null;
  const userGameName = String(userGameMap?.map || userGameMapName || "");
  const isSurvival = selectedName === "Survival_1";
  const isDeepDesert = /^DeepDesert_/i.test(selectedName);
  const isDeepDesertRuntime = /^(DeepDesert_|Overmap$)/i.test(selectedName);
  const isUserGameSurvival = userGameName === "Survival_1";
  const isUserGameDeepDesert = /^DeepDesert_/i.test(userGameName);
  const isUserGameDeepDesertRuntime = /^(DeepDesert_|Overmap$)/i.test(userGameName);
  const sietchRows = parseSietchRows(sietchDimensionsText || sietchesText, sietchDimensionIdsText);
  const survivalSietchRows = sietchRows.filter((row) => row.partitionId);
  const primarySurvivalSietch = survivalSietchRows.find((row) => String(row.dimension) === "0") || survivalSietchRows[0] || null;
  const dynamicSurvivalSietchRows = survivalSietchRows.filter((row) => String(row.dimension) !== "0");
  const deepDesertPartitionRows = serverPartitionRows.filter((row) => String(row.map || "") === "DeepDesert_1").sort((a, b) => Number(a.dimension ?? 0) - Number(b.dimension ?? 0));
  const userGameDeepDesertPartitionOptions = isUserGameDeepDesert ? deepDesertPartitionRows.filter((row) => row.partitionId) : [];
  const dynamicDeepDesertRows = deepDesertPartitionRows.filter((row) => String(row.dimension || "") !== "0");
  const deepDesertDualEnabled = dynamicDeepDesertRows.length > 0;
  const deepDesertDualConfiguring = mapsResultScope === "maps" && mapsResult?.status === "running" && isDeepDesertDualResult(mapsResult);
  const partitionOptions = isSurvival ? survivalSietchRows : [];
  const userGamePartitionOptions = isUserGameSurvival ? sietchRows.filter((row) => row.partitionId) : [];
  const userGameTargets = buildUserGameTargets(mapRows, serverPartitionRows, survivalSietchRows, deepDesertPartitionRows);
  const effectivePartitionId = isSurvival ? (selectedPartitionId || partitionOptions[0]?.partitionId || "1") : isDeepDesertRuntime ? "2" : selectedPartitionId;
  const effectiveUserGamePartitionId = isUserGameSurvival
    ? (userGamePartitionId || userGamePartitionOptions[0]?.partitionId || "1")
    : isUserGameDeepDesert
      ? (userGamePartitionId || String(userGameDeepDesertPartitionOptions[0]?.partitionId || "8"))
      : isUserGameDeepDesertRuntime ? "2" : userGamePartitionId;
  const isUserGameGlobal = userGameName === "__global__";
  const userGameTargetKey = userGameName ? settingsTargetKey(userGameName, isUserGameGlobal ? "" : effectiveUserGamePartitionId) : "";
  const gameFields = schema ? (effectivePartitionId ? schema.partition : schema.game).filter((field) => field.id !== "partition_pve_enabled" || effectivePartitionId) : [];
  const userGameFields = schema && userGameName ? (!isUserGameGlobal && effectiveUserGamePartitionId ? schema.partition : schema.game).filter((field) => field.id !== "partition_pve_enabled" || (!isUserGameGlobal && effectiveUserGamePartitionId)) : [];
  const gameGroups = groupSettingsFields(userGameFields, true);
  const activeGameCategory = gameGroups.some(([category]) => category === selectedGameCategory) ? selectedGameCategory : gameGroups[0]?.[0] || "";
  const activeGameFields = activeGameCategory === "All" ? userGameFields : gameGroups.find(([category]) => category === activeGameCategory)?.[1] || [];
  const filteredGameFields = filterSettingsFields(activeGameFields, modifierFilter);
  const engineFields = (schema?.engine || []).filter((field) => !["server_display_name", "server_login_password", "port", "igw_port"].includes(field.id));
  const engineDirty = changedKeys(engineValues, engineDraft, engineFields.map((field) => field.id));
  const gameDirty = changedKeys(gameValues, gameDraft, userGameFields.map((field) => field.id));
  const currentActiveSietches = String(survivalSietchRows.filter((row) => row.active).length || survivalSietchRows.length || "");
  const activeSietchesDirty = activeSietches !== currentActiveSietches;
  const primarySietchDraft = primarySurvivalSietch ? sietchDrafts[primarySurvivalSietch.partitionId] || { displayName: primarySurvivalSietch.displayName, password: primarySurvivalSietch.password } : null;
  const primarySietchDirty = Boolean(primarySurvivalSietch && primarySietchDraft && (primarySietchDraft.displayName !== primarySurvivalSietch.displayName || sietchPasswordDraftChanged(primarySurvivalSietch, primarySietchDraft, Boolean(sietchPasswordTouched[primarySurvivalSietch.partitionId]))));
  const sietchesDirty = activeSietchesDirty || partitionOptions.some((sietch) => {
    const draft = sietchDrafts[sietch.partitionId] || { displayName: sietch.displayName, password: sietch.password };
    const passwordTouched = Boolean(sietchPasswordTouched[sietch.partitionId]);
    return draft.displayName !== sietch.displayName || sietchPasswordDraftChanged(sietch, draft, passwordTouched);
  });
  const rawEngineDirty = normalizeRawIniContent(rawEngine) !== normalizeRawIniContent(rawEngineOriginal);
  const rawGameDirty = normalizeRawIniContent(rawGame) !== normalizeRawIniContent(rawGameOriginal);
  const modifierDirtySummary = [
    engineDirty.length ? `${engineDirty.length} UserEngine value${engineDirty.length === 1 ? "" : "s"}` : "",
    gameDirty.length ? `${gameDirty.length} UserGame value${gameDirty.length === 1 ? "" : "s"}` : "",
    rawEngineDirty ? "UserEngine.ini" : "",
    rawGameDirty ? "UserGame.ini" : ""
  ].filter(Boolean).join(", ");
  function clearMapActionResultForTarget(target: string) {
    if (!mapsResult || mapsResultScope !== "maps" || !mapsResultTarget || mapsResultTarget === target) return;
    if (!isMapSettingsResult(mapsResult) && !isForceDespawnResult(mapsResult)) return;
    setMapsResult(null);
    setMapsResultTarget("");
    persistMapsTask(null);
  }
  function selectMap(row: Record<string, unknown>) {
    const name = String(row.map || "");
    if (selectedMapName === name) {
      setSelectedMapName("");
      setSelectedPartitionId("");
      return;
    }
    setSelectedMapName(name);
    const rowPartition = String(row.partitionId || row.partition || "").trim();
    const defaultPartition = name === "Survival_1" || /^DeepDesert_/i.test(name) ? "" : /^Overmap$/i.test(name) ? "2" : rowPartition;
    clearMapActionResultForTarget(mapResultTarget(name, defaultPartition));
    setSelectedPartitionId(defaultPartition);
    setSelectedGameCategory("");
    setMemory(memoryInputValue(String(row.memory || "")));
    setModeDraft(modeInputValue(String(row.mode || "")));
    void loadSelectedSettings(name, defaultPartition || undefined).catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }
  function selectDeepDesertPartition(row: Record<string, unknown>) {
    const partitionId = String(row.partitionId || "").trim();
    if (selectedMapName === "DeepDesert_1" && selectedPartitionId === partitionId) {
      setSelectedMapName("");
      setSelectedPartitionId("");
      return;
    }
    const parent = mapRows.find((item) => String(item.map || "") === "DeepDesert_1");
    clearMapActionResultForTarget(mapResultTarget("DeepDesert_1", partitionId));
    setSelectedMapName("DeepDesert_1");
    setSelectedPartitionId(partitionId);
    setSelectedGameCategory("");
    setMemory(memoryInputValue(partitionMemoryValue(memoryText, partitionId, String(parent?.memory || ""), "DeepDesert_1")));
    setModeDraft(modeInputValue(String(parent?.mode || "")));
    void loadSelectedSettings("DeepDesert_1", partitionId).catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }
  function selectSietch(row: SietchRow) {
    if (selectedMapName === "Survival_1" && selectedPartitionId === row.partitionId) {
      setSelectedMapName("");
      setSelectedPartitionId("");
      return;
    }
    const parent = mapRows.find((item) => String(item.map || "") === "Survival_1");
    clearMapActionResultForTarget(mapResultTarget("Survival_1", row.partitionId));
    setSelectedMapName("Survival_1");
    setSelectedPartitionId(row.partitionId);
    setSelectedGameCategory("");
    setMemory(memoryInputValue(partitionMemoryValue(memoryText, row.partitionId, String(parent?.memory || ""))));
    setModeDraft(modeInputValue(String(parent?.mode || "")));
    void loadSelectedSettings("Survival_1", row.partitionId).catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }
  function selectPartition(next: string) {
    setSelectedPartitionId(next);
    setSelectedGameCategory("");
    if (selectedMapName) void loadSelectedSettings(selectedMapName, next || undefined).catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }
  function selectUserGameTarget(next: string) {
    const target = userGameTargets.find((item) => item.key === next);
    if (!target) {
      setUserGameMapName("");
      setUserGamePartitionId("");
      setSelectedGameCategory("");
      setGameValues({});
      setGameDraft({});
      return;
    }
    setUserGameMapName(target.map);
    setUserGamePartitionId(target.partitionId);
    setSelectedGameCategory("");
    void loadSelectedSettings(target.map, target.partitionId || undefined).catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }
  async function saveEngine() {
    if (!(await confirmSettingsRestart("UserEngine"))) return;
    await runTaskAndRefresh(
      () => mapsApi.saveUserSettings({ scope: "engine", values: valuesForDirtyFields(engineValues, engineDraft, engineFields) }),
      "Saving UserEngine changes",
      "UserEngine Saved",
      { resultScope: "modifiers", restartAcceptedMessage: "Changes saved successfully. The maps are restarting and should be back up soon." }
    );
    await loadUserEngine();
  }
  async function saveSelectedMapSettings(row: Record<string, unknown>) {
    const rowName = String(row.map || "");
    const originalMode = modeInputValue(String(row.mode || ""));
    const originalMemory = memoryInputValue(String(row.memory || ""));
    const modeChanged = modeDraft !== originalMode && String(row.mode) !== "Core Map";
    const memoryChanged = memory !== originalMemory;
    const partitionId = "";
    const activeChanged = rowName === "Survival_1" && activeSietchesDirty;
    const requestedActiveSietches = Number(activeSietches);
    const currentActiveCount = Number(currentActiveSietches) || survivalSietchRows.filter((sietch) => sietch.active).length || survivalSietchRows.length;
    const activeSietchesDecreased = activeChanged && Number.isFinite(requestedActiveSietches) && requestedActiveSietches < currentActiveCount;
    const primaryChanged = rowName === "Survival_1" && primarySietchDirty;
    if (!modeChanged && !memoryChanged && !activeChanged && !primaryChanged) return;
    const running = mapRuntimeNeedsLiveApply(row.status);
    const actions: Array<{ label: string; run: () => Promise<{ task: Task }> }> = [];
    if (modeChanged || memoryChanged) {
      actions.push({
        label: `Saving ${rowName}${partitionId ? ` partition ${partitionId}` : ""} map settings`,
        run: () => mapsApi.saveMapSettings({
          map: rowName,
          partitionId: partitionId || undefined,
          mode: modeDraft,
          memory: `${memory}g`,
          modeChanged,
          memoryChanged,
          running,
          confirmation: "SAVE MAP SETTINGS"
        })
      });
    }
    if (activeChanged) actions.push(...survivalSietchActions({ includeActive: true, includePartitions: false }));
    if (rowName === "Survival_1" && primarySurvivalSietch) actions.push(...survivalSietchActions({ includeActive: false, includePartitions: true, partitionId: primarySurvivalSietch.partitionId }));
    const confirmed = await confirmAction(`Save map settings for ${rowName}?`);
    if (confirmed) {
      const successMessage = activeChanged
        ? activeSietchesDecreased
          ? primaryChanged
            ? "Sietch changes saved successfully. Extra sietches were despawned, and the main sietch settings were updated. Changes may take a short time to appear in-game."
            : "Sietch changes saved successfully. Extra sietches were despawned and removed from the active list."
          : primaryChanged
            ? "Sietch changes saved successfully. The new sietch is starting, and the main sietch settings were updated. Changes may take a short time to appear in-game."
            : "Sietch changes saved successfully. The sietch is starting and may take a few minutes to appear in-game after it is running."
        : primaryChanged
          ? "Sietch settings saved successfully. Changes may take a short time to appear in-game."
          : modeChanged && memoryChanged
          ? "Mode and memory settings saved successfully."
          : modeChanged
          ? "Map mode saved successfully."
          : "Memory settings saved successfully.";
      await runTaskSequenceAndRefresh(
        actions,
        `Saving ${rowName} Settings`,
        activeChanged ? "Sietch Changes Saved" : "Map Settings Saved",
        {
          saveAcceptedMessage: successMessage,
          memoryUpdates: memoryChanged ? [{ map: rowName, memory: `${memory}g` }] : [],
          resultTarget: mapResultTarget(rowName)
        }
      );
    }
  }
  function survivalSietchActions({ includeActive, includePartitions, partitionId }: { includeActive: boolean; includePartitions: boolean; partitionId?: string }) {
    const actions: Array<{ label: string; run: () => Promise<{ task: Task }> }> = [];
    let activeAction: { label: string; run: () => Promise<{ task: Task }> } | null = null;
    if (includeActive && activeSietches && activeSietchesDirty) {
      const requestedActive = Number(activeSietches);
      const currentActive = Number(currentActiveSietches) || survivalSietchRows.length;
      if (requestedActive > survivalSietchRows.length) {
        actions.push({
          label: `Creating ${requestedActive} available sietch dimensions`,
          run: () => mapsApi.updateSietches({ action: "set-max", map: "Survival_1", count: requestedActive, confirmation: "UPDATE SIETCHES" })
        });
      }
      activeAction = {
        label: requestedActive < currentActive
          ? `Despawning extra sietch${currentActive - requestedActive === 1 ? "" : "es"} and setting active sietches to ${requestedActive}`
          : `Activating ${requestedActive} sietch${requestedActive === 1 ? "" : "es"}`,
        run: () => mapsApi.updateSietches({ action: "set-active", map: "Survival_1", count: requestedActive, confirmation: "UPDATE SIETCHES" })
      };
    }
    if (includePartitions) {
      for (const sietch of survivalSietchRows) {
        if (partitionId && sietch.partitionId !== partitionId) continue;
        const draft = sietchDrafts[sietch.partitionId] || { displayName: sietch.displayName, password: sietch.password };
        const nameChanged = draft.displayName !== sietch.displayName;
        const passwordChanged = sietchPasswordDraftChanged(sietch, draft, Boolean(sietchPasswordTouched[sietch.partitionId]));
        const targetName = sietchTargetDisplayName(sietch, draft.displayName);
        if (nameChanged && passwordChanged) {
          actions.push({
            label: `Saving settings for ${targetName}`,
            run: () => mapsApi.updateSietches({ action: "set-settings", partitionId: sietch.partitionId, displayName: draft.displayName, password: draft.password, confirmation: "UPDATE SIETCHES" })
          });
          continue;
        }
        if (nameChanged) {
          actions.push({
            label: `Saving name for ${targetName}`,
            run: () => mapsApi.updateSietches({ action: "set-display", partitionId: sietch.partitionId, displayName: draft.displayName, confirmation: "UPDATE SIETCHES" })
          });
        }
        if (passwordChanged) {
          actions.push({
            label: `Saving password for ${targetName}`,
            run: () => mapsApi.updateSietches({ action: "set-password", partitionId: sietch.partitionId, password: draft.password, confirmation: "UPDATE SIETCHES" })
          });
        }
      }
    }
    if (activeAction) actions.push(activeAction);
    return actions;
  }
  async function saveSurvivalSietches() {
    const actions = survivalSietchActions({ includeActive: true, includePartitions: true });
    if (!actions.length) return;
    if (await confirmAction(`Save ${actions.length} Survival_1 Sietch change${actions.length === 1 ? "" : "s"}?`)) {
      const activeChanged = Boolean(activeSietches && activeSietchesDirty);
      await runTaskSequenceAndRefresh(actions, "Saving Sietch Changes", "Sietches Saved", {
        saveAcceptedMessage: activeChanged
          ? "Sietch changes saved successfully. The sietch is starting and may take a few minutes to appear in-game after it is running."
          : "Sietch settings saved successfully. Changes may take a short time to appear in-game."
      });
    }
  }
  async function saveSietchSettings(sietch: SietchRow) {
    const parent = mapRows.find((row) => String(row.map || "") === "Survival_1") || {};
    const draft = sietchDrafts[sietch.partitionId] || { displayName: sietch.displayName, password: sietch.password };
    const originalMemory = memoryInputValue(partitionMemoryValue(memoryText, sietch.partitionId, String(parent.memory || "")));
    const memoryChanged = memory !== originalMemory;
    const running = mapRuntimeNeedsLiveApply(parent.status);
    const actions: Array<{ label: string; run: () => Promise<{ task: Task }> }> = [];
    if (memoryChanged) {
      actions.push({
        label: `Saving RAM for ${sietch.displayName}`,
        run: () => mapsApi.saveMapSettings({
          map: "Survival_1",
          partitionId: sietch.partitionId,
          memory: `${memory}g`,
          modeChanged: false,
          memoryChanged,
          running,
          confirmation: "SAVE MAP SETTINGS"
        })
      });
    }
    const sietchActions = survivalSietchActions({ includeActive: false, includePartitions: true, partitionId: sietch.partitionId });
    actions.push(...sietchActions);
    if (!actions.length) return;
    const willRestart = false;
    const confirmed = willRestart
      ? await confirmAction("Save these Sietch settings and restart this Sietch?", {
        title: "Restart Required",
        confirmLabel: "Save And Restart",
        details: [
          { label: "Sietch", value: sietch.displayName || `Partition ${sietch.partitionId}` },
          { label: "Impact", value: "Players in this Sietch will be disconnected.", tone: "danger" }
        ]
      })
      : await confirmAction(`Save settings for ${sietch.displayName || `partition ${sietch.partitionId}`}?`);
    if (confirmed) {
      const successMessage = sietchActions.length > 0
        ? "Sietch settings saved successfully. Changes may take a short time to appear in-game."
        : "Memory settings saved successfully.";
      await runTaskSequenceAndRefresh(actions, `Saving ${sietchTargetDisplayName(sietch, draft.displayName)} Settings`, "Sietch Saved", {
        saveAcceptedMessage: successMessage,
        memoryUpdates: memoryChanged ? [{ map: "Survival_1", partitionId: sietch.partitionId, memory: `${memory}g` }] : [],
        resultTarget: mapResultTarget("Survival_1", sietch.partitionId)
      });
    }
  }
  async function enableDualDeepDesert() {
    if (!(await confirmAction("Enable dual Deep Desert setup?"))) return;
    await runTaskAndRefresh(
      () => mapsApi.updateDeepdesert({ action: "enable", confirmation: "UPDATE DEEP DESERT" }),
      "Enabling Dual Deep Desert",
      "Dual Deep Desert Enabled"
    );
  }
  async function disableDualDeepDesert(row?: Record<string, unknown>) {
    const label = row ? deepDesertPartitionName(row) : "Dual Deep Desert";
    if (!(await confirmAction(`Disable ${label}?`, {
      title: "Dual Deep Desert",
      confirmLabel: "Disable",
      danger: true,
      details: [
        { label: "Impact", value: "The extra Deep Desert instance will be despawned.", tone: "danger" }
      ]
    }))) return;
    await runTaskAndRefresh(
      () => mapsApi.updateDeepdesert({ action: "disable", confirmation: "UPDATE DEEP DESERT" }),
      "Despawning Extra Deep Desert",
      "Dual Deep Desert Disabled"
    );
  }
  async function saveDeepDesertPartitionSettings(row: Record<string, unknown>) {
    const parent = mapRows.find((item) => String(item.map || "") === "DeepDesert_1") || {};
    const partitionId = String(row.partitionId || "").trim();
    const originalMemory = memoryInputValue(partitionMemoryValue(memoryText, partitionId, String(parent.memory || ""), "DeepDesert_1"));
    const memoryChanged = memory !== originalMemory;
    if (!memoryChanged || !partitionId) return;
    const running = mapRuntimeNeedsLiveApply(row.status || parent.status);
    if (!(await confirmAction(`Save memory settings for ${deepDesertPartitionName(row)}?`))) return;
    await runTaskAndRefresh(
      () => mapsApi.saveMapSettings({
        map: "DeepDesert_1",
        partitionId,
        memory: `${memory}g`,
        modeChanged: false,
        memoryChanged,
        running,
        confirmation: "SAVE MAP SETTINGS"
      }),
      `Saving ${deepDesertPartitionName(row)} Settings`,
      "Deep Desert Saved",
      { memoryUpdates: [{ map: "DeepDesert_1", partitionId, memory: `${memory}g` }], resultTarget: mapResultTarget("DeepDesert_1", partitionId) }
    );
  }
  async function forceDespawnMap(row: Record<string, unknown>) {
    const rowName = String(row.map || "");
    if (!rowName || rowName === "Survival_1" || rowName === "Overmap") return;
    if (rowName === "DeepDesert_1" && deepDesertDualEnabled) {
      const targets = [String(row.partitionId || row.partition || "").trim(), ...dynamicDeepDesertRows.map((deepRow) => String(deepRow.partitionId || "").trim())].filter(Boolean);
      const uniqueTargets = Array.from(new Set(targets));
      if (!uniqueTargets.length) return;
      if (!(await confirmAction("Force despawn all Deep Desert instances?"))) return;
      await runTaskSequenceAndRefresh(
        uniqueTargets.map((target) => ({ label: `Despawning Deep Desert partition ${target}`, run: () => mapsApi.despawn(target, "DESPAWN MAP") })),
        "Despawning Deep Desert Instances",
        "Deep Desert Instances Despawned",
        { resultTarget: mapResultTarget(rowName) }
      );
      return;
    }
    const target = String(row.partitionId || row.partition || rowName);
    if (!(await confirmAction(`Force despawn ${rowName}?`))) return;
    await runTaskAndRefresh(() => mapsApi.despawn(target, "DESPAWN MAP"), `Despawning ${rowName}`, `${rowName} Despawned`, { resultTarget: mapResultTarget(rowName) });
  }
  async function forceDespawnDeepDesertPartition(row: Record<string, unknown>) {
    const partitionId = String(row.partitionId || "").trim();
    if (!partitionId) return;
    const label = deepDesertPartitionName(row);
    if (!(await confirmAction(`Force despawn ${label}?`))) return;
    await runTaskAndRefresh(() => mapsApi.despawn(partitionId, "DESPAWN MAP"), `Despawning ${label}`, `${label} Despawned`, { resultTarget: mapResultTarget("DeepDesert_1", partitionId) });
  }
  async function saveGame() {
    if (!userGameName) return;
    if (!(await confirmSettingsRestart("UserGame"))) return;
    const scope = isUserGameGlobal ? "global" : effectiveUserGamePartitionId ? "partition" : "map";
    const map = isUserGameGlobal ? "Survival_1" : userGameName;
    const partitionId = isUserGameGlobal ? undefined : effectiveUserGamePartitionId || undefined;
    await runTaskAndRefresh(
      () => mapsApi.saveUserSettings({ scope, map, partitionId, values: valuesForDirtyFields(gameValues, gameDraft, userGameFields) }),
      `Saving ${isUserGameGlobal ? "Global" : userGameName} UserGame changes`,
      "UserGame Saved",
      { resultScope: "modifiers", restartAcceptedMessage: "Changes saved successfully. The maps are restarting and should be back up soon." }
    );
    await loadSelectedSettings(userGameName, partitionId);
  }
  async function saveRaw(kind: "engine" | "game") {
    if (!(await confirmSettingsRestart(kind === "engine" ? "UserEngine" : "UserGame"))) return;
    if (kind === "engine") {
      await runTaskAndRefresh(
        () => mapsApi.saveRawUserSettings({ scope: "engine", content: rawEngine }),
        "Saving UserEngine changes",
        "UserEngine Saved",
        {
          resultScope: "modifiers",
          restartAcceptedMessage: "Changes saved successfully. The maps are restarting and should be back up soon.",
          onRestartAccepted: () => setRawEngineOriginal(rawEngine)
        }
      );
      setRawEngineOriginal(rawEngine);
      await loadUserEngine();
    } else {
      await runTaskAndRefresh(
        () => mapsApi.saveRawUserSettings({ scope: "global", map: userGameName || "Survival_1", partitionId: effectiveUserGamePartitionId || undefined, content: rawGame }),
        "Saving UserGame changes",
        "UserGame Saved",
        {
          resultScope: "modifiers",
          restartAcceptedMessage: "Changes saved successfully. The maps are restarting and should be back up soon.",
          onRestartAccepted: () => setRawGameOriginal(rawGame)
        }
      );
      setRawGameOriginal(rawGame);
      if (userGameName) await loadSelectedSettings(userGameName, effectiveUserGamePartitionId || undefined);
    }
  }
  async function restoreRawGameDefaults() {
    if (userGameName) {
      const scope = isUserGameGlobal ? "global" : effectiveUserGamePartitionId ? "partition" : "map";
      const map = isUserGameGlobal ? "Survival_1" : userGameName;
      const partitionId = isUserGameGlobal ? undefined : effectiveUserGamePartitionId || undefined;
      if (!(await confirmAction(`Restore UserGame defaults for ${isUserGameGlobal ? "Global" : userGameName}${partitionId ? ` partition ${partitionId}` : ""}?`))) return;
      await runTaskAndRefresh(
        () => mapsApi.resetUserSettings({ scope, map, partitionId, confirmation: "RESTORE MAP DEFAULTS" }),
        "Restoring UserGame defaults",
        "UserGame Defaults Restored",
        {
          resultScope: "modifiers",
          restartAcceptedMessage: "Defaults restored successfully. The maps are restarting and should be back up soon.",
          onRestartAccepted: () => setRawGameOriginal(rawGame)
        }
      );
      await loadSelectedSettings(userGameName, partitionId);
      return;
    }
    if (!(await confirmAction("Restore all UserGame defaults? This removes custom UserGame overrides for maps and partitions."))) return;
    const defaultGameProfile = [
      "; UserGame.ini managed by Docker.",
      "; Edit this single file for all map and partition UserGame settings.",
      "; Docker applies the correct values to each server when maps start or restart.",
      ""
    ].join("\n");
    await runTaskAndRefresh(
      () => mapsApi.saveRawUserSettings({ scope: "global", map: "Survival_1", content: defaultGameProfile }),
      "Restoring all UserGame defaults",
      "UserGame Defaults Restored",
      {
        resultScope: "modifiers",
        restartAcceptedMessage: "Defaults restored successfully. The maps are restarting and should be back up soon.",
        onRestartAccepted: () => setRawGameOriginal(defaultGameProfile)
      }
    );
    setRawGame(defaultGameProfile);
    setRawGameOriginal(defaultGameProfile);
    setGameValues({});
    setGameDraft({});
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
    if (!mapsLoaded) return;
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
    if (!mapsLoaded) return;
    const nextOpen = !modifiersOpen;
    setModifiersOpen(nextOpen);
    if (nextOpen) setAdvancedOpen(false);
  }
  const modifiersAvailable = mapsLoaded;
  const advancedAvailable = mapsLoaded;
  return <section className="panel maps-panel">
    <div className="panel-title"><h2>Maps & Sietches</h2><div className="maps-title-actions">{memoryBalancer?.enabled && <span className={`maps-memory-balancer-status ${memoryBalancer.lastError ? "danger" : ""}`}>{memoryBalancer.lastError ? `Memory Balancer error: ${memoryBalancer.lastError}` : memoryBalancer.lastMessage || "Memory Balancer is monitoring running maps"}</span>}<button className={`switch-toggle maps-memory-balancer-toggle ${memoryBalancer?.enabled ? "enabled" : "disabled"}`} disabled={memoryBalancerSaving} onClick={() => run(toggleMemoryBalancer)}><span className="switch-label">Memory Balancer</span><strong className="switch-state">{memoryBalancer?.enabled ? "ON" : "OFF"}</strong></button><button disabled={loading} onClick={() => run(loadMaps)}>{loading ? "Refreshing..." : "Refresh Maps"}</button></div></div>
    {mapsResult && mapsResultScope === "maps" && !isDeepDesertDualResult(mapsResult) && !isForceDespawnResult(mapsResult) && !isMapSettingsResult(mapsResult) ? <div className="maps-result-slot"><HomeTaskResultCard result={mapsResult} /></div> : null}
    <section className="action-section">
      <h4>Maps Overview</h4>
      <MapModeGuide />
      {loading && !mapRows.length && <div className="empty"><span className="loading-dots">Loading Maps</span></div>}
      {!loading && loadError && !mapRows.length && <div className="result-panel"><strong>Map list could not be loaded.</strong><p>{loadError}</p><button onClick={() => run(loadMaps)}>Retry</button></div>}
      {mapRows.length ? <div className="table-wrap maps-overview-table-wrap"><table className="maps-overview-table"><thead><tr><th>Map</th><th>Status</th><th>Mode</th><th>Memory</th><th className="actions-column">Action</th></tr></thead><tbody>{mapRows.map((row) => {
        const rowName = String(row.map || "");
        const isSurvivalRow = rowName === "Survival_1";
        const isDeepDesertRow = /^DeepDesert_/i.test(rowName);
        const isSelected = selectedMapName === rowName && (!(isSurvivalRow || isDeepDesertRow) || !selectedPartitionId);
        const memoryRow = memoryForMap(liveMemory, rowName, row);
        const mapSettingsDirty = isSelected && ((modeDraft !== modeInputValue(String(row.mode || "")) && String(row.mode) !== "Core Map") || memory !== memoryInputValue(String(row.memory || "")) || (isSurvivalRow && (activeSietchesDirty || primarySietchDirty)));
        const primaryDraft = primarySurvivalSietch ? sietchDrafts[primarySurvivalSietch.partitionId] || { displayName: primarySurvivalSietch.displayName, password: primarySurvivalSietch.password } : undefined;
        const primaryDeepDesertPartition = isDeepDesertRow ? deepDesertPartitionRows.find((deepRow) => String(deepRow.dimension || "") === "0") || deepDesertPartitionRows[0] : undefined;
        const baseStatus = isDeepDesertRow && deepDesertDualConfiguring
          ? "Configuring"
          : isDeepDesertRow && primaryDeepDesertPartition ? partitionStatusById.get(String(primaryDeepDesertPartition.partitionId || "")) || String(primaryDeepDesertPartition.status || row.status || "Not Available")
          : isSurvivalRow && primarySurvivalSietch ? partitionStatusById.get(primarySurvivalSietch.partitionId) || readinessStatusByPartitionId.get(primarySurvivalSietch.partitionId) || String(row.status || "Not Available") : String(row.status || "Not Available");
        const displayStatus = statusWithLiveMemory(baseStatus, memoryRow, row.mode);
        const canForceDespawn = isDeepDesertRow && deepDesertDualEnabled
          ? [displayStatus, ...dynamicDeepDesertRows.map((deepRow) => partitionStatusById.get(String(deepRow.partitionId || "")) || String(deepRow.status || ""))].some((status) => mapCanForceDespawn({ status }))
          : mapCanForceDespawn({ ...row, status: displayStatus });
        const dualDeepDesertResultActive = Boolean(mapsResult && mapsResultScope === "maps" && isDeepDesertDualResult(mapsResult));
        const rowResultActive = mapsResultTarget === mapResultTarget(rowName);
        const rowMapSettingsResultActive = Boolean(rowResultActive && mapsResult && mapsResultScope === "maps" && isMapSettingsResult(mapsResult));
        const rowForceDespawnResultActive = Boolean(rowResultActive && mapsResult && mapsResultScope === "maps" && isForceDespawnResult(mapsResult) && !isDeepDesertDualResult(mapsResult));
        return <Fragment key={rowName}><tr><td>{isSurvivalRow ? <SietchMapName name={rowName} sietch={primarySurvivalSietch} draft={primaryDraft} /> : rowName}</td><td><MapRuntimeStatus value={displayStatus} /></td><td>{String(row.mode || "Not Available")}</td><td><MemoryUsageBar row={memoryRow} fallback={liveMemoryFallback(row)} configuredLimit={row.memory} /></td><td className="actions-column"><button className="stable-action-button" onClick={() => selectMap(row)}>{isSelected ? "Close" : "Edit"}</button></td></tr>
          {isSelected && <tr className="inline-edit-row" key={`${rowName}-edit`}><td colSpan={5}>
            <section className="inline-edit-panel">
              <div className="panel-title"><h4>Edit {rowName}</h4></div>
              <KeyValueGrid items={[["Status", displayStatus], ["Mode", row.mode], ["Memory", row.memory], ["Dimensions", row.dimensions], ...(isSurvivalRow && primarySurvivalSietch ? [["Password", primarySurvivalSietch.passwordSet ? "Set" : "Not Set"] as [string, unknown]] : [])]} />
              <div className="action-line">
                <label className="compact-select">Mode<select value={modeDraft} disabled={String(row.mode) === "Core Map"} onChange={(event) => setModeDraft(event.target.value)}><option value="dynamic">Dynamic</option><option value="always-on">Always On</option><option value="overmap-active">Overmap Active</option><option value="disabled">Disabled</option></select></label>
                <label className="memory-number-field">Memory<input type="number" min="1" step="1" value={memory} onChange={(event) => setMemory(event.target.value)} placeholder="8" /></label>
                <span className="unit-label">GB</span>
                {isSurvivalRow && <label className="memory-number-field">Active Sietches<input type="number" min="1" max="64" step="1" value={activeSietches} onChange={(event) => setActiveSietches(event.target.value)} /></label>}
                {isSurvivalRow && primarySurvivalSietch && primarySietchDraft && <label>Name<input value={primarySietchDraft.displayName} placeholder="Default name" onChange={(event) => setSietchDrafts({ ...sietchDrafts, [primarySurvivalSietch.partitionId]: { ...primarySietchDraft, displayName: event.target.value } })} /></label>}
                {isSurvivalRow && primarySurvivalSietch && primarySietchDraft && <label>Password<SecretInput value={sietchPasswordInputValue(primarySurvivalSietch, primarySietchDraft, Boolean(sietchPasswordTouched[primarySurvivalSietch.partitionId]))} placeholder={passwordPlaceholder(sietchHasPassword(primarySurvivalSietch, primarySietchDraft))} onFocus={(event) => { if (!sietchPasswordTouched[primarySurvivalSietch.partitionId] && primarySurvivalSietch.passwordSet) event.currentTarget.select(); }} onChange={(event) => { setSietchPasswordTouched({ ...sietchPasswordTouched, [primarySurvivalSietch.partitionId]: true }); setSietchDrafts({ ...sietchDrafts, [primarySurvivalSietch.partitionId]: { ...primarySietchDraft, password: event.target.value } }); }} /></label>}
                <button disabled={!mapSettingsDirty} onClick={() => run(() => saveSelectedMapSettings(row))}>Save Map Settings</button>
                {rowName !== "Survival_1" && rowName !== "Overmap" && <button className="danger" disabled={!canForceDespawn} title={canForceDespawn ? "Force despawn this running map" : "Map is not running"} onClick={() => run(() => forceDespawnMap(row))}>Force Despawn</button>}
                {rowMapSettingsResultActive && mapsResult ? <span className={`inline-task-result map-action-result result-${inlineTaskResultClass(mapsResult)}`}>
                  <strong className={mapsResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(mapsResult.title, mapsResult.status === "running")}</strong>
                  {mapsResult.message && <span className="inline-task-message">{formatResultMessage(mapsResult.message)}</span>}
                </span> : null}
                {rowName !== "Survival_1" && rowName !== "Overmap" && rowForceDespawnResultActive && mapsResult ? <span className={`inline-task-result map-action-result result-${inlineTaskResultClass(mapsResult)}`}>
                  <strong className={mapsResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(mapsResult.title, mapsResult.status === "running")}</strong>
                  {mapsResult.message && <span className="inline-task-message">{formatResultMessage(mapsResult.message)}</span>}
                </span> : null}
              </div>
              {isDeepDesert && <section className="action-section nested-action deep-desert-dual-section">
                <div className="action-line deep-desert-dual-line">
                  <span className="deep-desert-dual-label">Dual Deep Desert:</span>
                  <label className={`switch-checkbox deep-desert-dual-toggle ${deepDesertDualEnabled ? "enabled" : "disabled"}`}><input aria-label="Dual Deep Desert" type="checkbox" checked={deepDesertDualEnabled} onChange={(event) => run(() => event.target.checked ? enableDualDeepDesert() : disableDualDeepDesert())} /><strong className="switch-state">{deepDesertDualEnabled ? "ON" : "OFF"}</strong></label>
                  {dualDeepDesertResultActive && mapsResult ? <span className={`inline-task-result result-${inlineTaskResultClass(mapsResult)}`}>
                    <strong className={mapsResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(mapsResult.title, mapsResult.status === "running")}</strong>
                    {mapsResult.message && <span className="inline-task-message">{formatResultMessage(mapsResult.message)}</span>}
                  </span> : null}
                </div>
                {deepText && !dualDeepDesertResultActive && <MapCommandSummary text={deepText} />}
              </section>}
            </section>
          </td></tr>}
          {isDeepDesertRow && dynamicDeepDesertRows.map((deepRow) => {
            const childSelected = selectedMapName === "DeepDesert_1" && selectedPartitionId === String(deepRow.partitionId || "");
            const deepMemory = partitionMemoryValue(memoryText, String(deepRow.partitionId || ""), String(row.memory || ""), "DeepDesert_1");
            const childMemoryRow = memoryForMap(liveMemory, "DeepDesert_1", { partitionId: deepRow.partitionId });
            const childStatus = deepDesertDualConfiguring ? "Configuring" : statusWithLiveMemory(partitionStatusById.get(String(deepRow.partitionId || "")) || String(deepRow.status || "Not Available"), childMemoryRow, row.mode);
            const childMemoryDirty = childSelected && memory !== memoryInputValue(deepMemory);
            const childCanForceDespawn = mapCanForceDespawn({ ...deepRow, status: childStatus });
            const childResultActive = mapsResultTarget === mapResultTarget("DeepDesert_1", String(deepRow.partitionId || ""));
            const childMapSettingsResultActive = Boolean(childResultActive && mapsResult && mapsResultScope === "maps" && isMapSettingsResult(mapsResult));
            const childForceDespawnResultActive = Boolean(childResultActive && mapsResult && mapsResultScope === "maps" && isForceDespawnResult(mapsResult) && !isDeepDesertDualResult(mapsResult));
            return <Fragment key={`deepdesert-${String(deepRow.partitionId || deepRow.dimension || "")}`}><tr className="sietch-child-row"><td><span className="sietch-child-name">{deepDesertPartitionName(deepRow)}</span><span className="sietch-child-meta">Partition {String(deepRow.partitionId || "Unknown")} / Dimension {String(deepRow.dimension || "Unknown")}</span></td><td><MapRuntimeStatus value={childStatus} /></td><td>Dual</td><td><MemoryUsageBar row={childMemoryRow} fallback={liveMemoryFallback({ ...row, status: childStatus })} configuredLimit={deepMemory} /></td><td className="actions-column"><button className="stable-action-button" onClick={() => selectDeepDesertPartition(deepRow)}>{childSelected ? "Close" : "Edit"}</button></td></tr>
              {childSelected && <tr className="inline-edit-row"><td colSpan={5}><section className="inline-edit-panel">
                <div className="panel-title"><h4>Edit {deepDesertPartitionName(deepRow)}</h4></div>
                <KeyValueGrid items={[["Partition", deepRow.partitionId], ["Dimension", deepRow.dimension], ["Status", childStatus], ["Memory", deepMemory]]} />
                <div className="action-line">
                  <label className="memory-number-field">Memory<input type="number" min="1" step="1" value={memory} onChange={(event) => setMemory(event.target.value)} placeholder="8" /></label>
                  <span className="unit-label">GB</span>
                  <button disabled={!childMemoryDirty} onClick={() => run(() => saveDeepDesertPartitionSettings(deepRow))}>Save</button>
                  <button className="danger" disabled={!childCanForceDespawn} title={childCanForceDespawn ? "Force despawn this Deep Desert instance" : "Deep Desert instance is not running"} onClick={() => run(() => forceDespawnDeepDesertPartition(deepRow))}>Force Despawn</button>
                  {childMapSettingsResultActive && mapsResult ? <span className={`inline-task-result map-action-result result-${inlineTaskResultClass(mapsResult)}`}>
                    <strong className={mapsResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(mapsResult.title, mapsResult.status === "running")}</strong>
                    {mapsResult.message && <span className="inline-task-message">{formatResultMessage(mapsResult.message)}</span>}
                  </span> : null}
                  {childForceDespawnResultActive && mapsResult ? <span className={`inline-task-result map-action-result result-${inlineTaskResultClass(mapsResult)}`}>
                    <strong className={mapsResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(mapsResult.title, mapsResult.status === "running")}</strong>
                    {mapsResult.message && <span className="inline-task-message">{formatResultMessage(mapsResult.message)}</span>}
                  </span> : null}
                </div>
              </section></td></tr>}
            </Fragment>;
          })}
          {isSurvivalRow && dynamicSurvivalSietchRows.map((sietch) => {
            const childSelected = selectedMapName === "Survival_1" && selectedPartitionId === sietch.partitionId;
            const draft = sietchDrafts[sietch.partitionId] || { displayName: sietch.displayName, password: sietch.password };
            const sietchMemory = partitionMemoryValue(memoryText, sietch.partitionId, String(row.memory || ""));
            const childMemoryDirty = childSelected && memory !== memoryInputValue(sietchMemory);
            const passwordTouched = Boolean(sietchPasswordTouched[sietch.partitionId]);
            const childDirty = childMemoryDirty || draft.displayName !== sietch.displayName || sietchPasswordDraftChanged(sietch, draft, passwordTouched);
            const childMemoryRow = memoryForMap(liveMemory, "Survival_1", { ...row, partitionId: sietch.partitionId });
            const childStatus = statusWithLiveMemory(partitionStatusById.get(sietch.partitionId) || readinessStatusByPartitionId.get(sietch.partitionId) || (sietch.active ? String(row.status || "Not Available") : "Not Running"), childMemoryRow, row.mode);
            const childResultActive = mapsResultTarget === mapResultTarget("Survival_1", sietch.partitionId);
            const childMapSettingsResultActive = Boolean(childResultActive && mapsResult && mapsResultScope === "maps" && isMapSettingsResult(mapsResult));
            return <Fragment key={`sietch-${sietch.partitionId}`}><tr className="sietch-child-row"><td><span className="sietch-child-name"><SietchName sietch={sietch} draft={draft} /></span><span className="sietch-child-meta">Partition {sietch.partitionId} / Dimension {sietch.dimension}</span></td><td><MapRuntimeStatus value={childStatus} /></td><td>Sietch</td><td>{sietch.active ? <MemoryUsageBar row={childMemoryRow} fallback={liveMemoryFallback(row)} configuredLimit={sietchMemory} /> : <span className="muted">Unallocated</span>}</td><td className="actions-column"><button className="stable-action-button" onClick={() => selectSietch(sietch)}>{childSelected ? "Close" : "Edit"}</button></td></tr>
              {childSelected && <tr className="inline-edit-row"><td colSpan={5}><section className="inline-edit-panel">
                <div className="panel-title"><h4>Edit {sietch.displayName}</h4></div>
                <KeyValueGrid items={[["Partition", sietch.partitionId], ["Dimension", sietch.dimension], ["Status", childStatus], ["Memory", sietchMemory], ["Password", sietch.passwordSet ? "Set" : "Not Set"]]} />
                <div className="action-line">
                  <label className="memory-number-field">Memory<input type="number" min="1" step="1" value={memory} onChange={(event) => setMemory(event.target.value)} placeholder="8" /></label>
                  <span className="unit-label">GB</span>
                  <label>Name<input value={draft.displayName} placeholder="Default name" onChange={(event) => setSietchDrafts({ ...sietchDrafts, [sietch.partitionId]: { ...draft, displayName: event.target.value } })} /></label>
                  <label>Password<SecretInput value={sietchPasswordInputValue(sietch, draft, Boolean(sietchPasswordTouched[sietch.partitionId]))} placeholder={passwordPlaceholder(sietchHasPassword(sietch, draft))} onFocus={(event) => { if (!sietchPasswordTouched[sietch.partitionId] && sietch.passwordSet) event.currentTarget.select(); }} onChange={(event) => { setSietchPasswordTouched({ ...sietchPasswordTouched, [sietch.partitionId]: true }); setSietchDrafts({ ...sietchDrafts, [sietch.partitionId]: { ...draft, password: event.target.value } }); }} /></label>
                  <button disabled={!childDirty} onClick={() => run(() => saveSietchSettings(sietch))}>Save Sietch Settings</button>
                  {childMapSettingsResultActive && mapsResult ? <span className={`inline-task-result map-action-result result-${inlineTaskResultClass(mapsResult)}`}>
                    <strong className={mapsResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(mapsResult.title, mapsResult.status === "running")}</strong>
                    {mapsResult.message && <span className="inline-task-message">{formatResultMessage(mapsResult.message)}</span>}
                  </span> : null}
                </div>
              </section></td></tr>}
            </Fragment>;
          })}
        </Fragment>;
      })}</tbody></table></div> : null}
      {loadError && mapRows.length ? <p className="danger-note">Some map data could not be refreshed: {loadError}</p> : null}
      {memoryError && <p className="danger-note">Live memory could not be read: {memoryError}</p>}
    </section>
    {(modifierDirtySummary || (mapsResult && mapsResultScope === "modifiers")) && <div className="maps-modifier-status-slot">
      {modifierDirtySummary && <p className="dirty-note">Unsaved changes: {modifierDirtySummary}</p>}
      {mapsResult && mapsResultScope === "modifiers" ? <div className="maps-result-slot"><HomeTaskResultCard result={mapsResult} /></div> : null}
    </div>}
    <div className={`playerAdmin_toggle maps-modifiers-toggle ${modifiersOpen && modifiersAvailable ? "open" : ""}`}>
      <button className="playerAdmin_toggleHeader" disabled={!modifiersAvailable} aria-label={modifiersOpen && modifiersAvailable ? "Collapse Interactive Modifiers" : "Expand Interactive Modifiers"} onClick={toggleModifiers}>{modifiersOpen && modifiersAvailable ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Interactive Modifiers</span></button>
      {modifiersOpen && modifiersAvailable && <div className="playerAdmin_toggleBody">
      <div className="settings-tabs" role="tablist" aria-label="INI modifier editor">
        <button className={settingsTab === "engine" ? "active" : ""} role="tab" aria-selected={settingsTab === "engine"} onClick={() => setSettingsTab("engine")}>UserEngine</button>
        <button className={settingsTab === "game" ? "active" : ""} role="tab" aria-selected={settingsTab === "game"} onClick={() => setSettingsTab("game")}>UserGame</button>
      </div>
      {settingsTab === "engine" ? <>
        <SettingsEditor fields={engineFields} values={engineDraft} onChange={(id, value) => setEngineDraft({ ...engineDraft, [id]: value })} />
        <div className="action-row"><button disabled={!engineDirty.length} onClick={() => run(saveEngine)}>Save</button><button disabled={!engineDirty.length} onClick={() => setEngineDraft(engineValues)}>Discard Changes</button></div>
      </> : <>
        <div className="settings-selector-row">
          <label className="compact-select">Target<select value={userGameTargetKey} onChange={(event) => selectUserGameTarget(event.target.value)}><option value="">Select Map Or Partition</option>{userGameTargets.map((target) => <option key={target.key} value={target.key}>{target.label}</option>)}</select></label>
          <label className="compact-select">Modifier Category<select disabled={!userGameName} value={activeGameCategory} onChange={(event) => setSelectedGameCategory(event.target.value)}>{gameGroups.map(([category, fields]) => <option key={category} value={category}>{category} ({fields.length})</option>)}</select></label>
          <div className="modifier-search-tools">
            <input className="modifier-filter-input" disabled={!userGameName} aria-label="Filter Modifiers" value={modifierFilter} onChange={(event) => setModifierFilter(event.target.value)} placeholder="Filter modifiers" />
            <div className="catalog-view-toggle" aria-label="Modifier view">
              <button type="button" className={modifierViewMode === "grid" ? "active" : ""} title="Grid view" aria-label="Grid view" aria-pressed={modifierViewMode === "grid"} onClick={() => setModifierViewMode("grid")}><Grid2X2 size={17} /></button>
              <button type="button" className={modifierViewMode === "list" ? "active" : ""} title="List view" aria-label="List view" aria-pressed={modifierViewMode === "list"} onClick={() => setModifierViewMode("list")}><List size={18} /></button>
            </div>
          </div>
        </div>
        {userGameName && <SettingsCardGrid fields={filteredGameFields} values={gameDraft} onChange={(id, value) => setGameDraft({ ...gameDraft, [id]: value })} viewMode={modifierViewMode} emptyMessage={modifierFilter.trim() ? "No modifiers match your filter." : "Select a modifier category."} />}
        <div className="action-row"><button disabled={!gameDirty.length || !userGameName} onClick={() => run(saveGame)}>Save</button><button disabled={!gameDirty.length} onClick={() => setGameDraft(gameValues)}>Discard Changes</button></div>
      </>}</div>}
    </div>
    <div className={`playerAdmin_toggle maps-advanced-toggle ${advancedOpen && advancedAvailable ? "open" : ""}`}>
      <button className="playerAdmin_toggleHeader" disabled={!advancedAvailable} onClick={() => run(toggleAdvanced)}>{advancedOpen && advancedAvailable ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Advanced</span></button>
      {advancedOpen && advancedAvailable && <div className="playerAdmin_toggleBody"><div className="advanced-grid">
        <article className="raw-editor-card"><div className="panel-title"><h4>UserEngine.ini</h4><div className="action-row"><button onClick={() => downloadIni("engine")}>Download</button><label className="button-link">Import<input className="hidden-file-input" type="file" accept=".ini,text/plain" onChange={(event) => run(async () => { await importIni("engine", event.target.files?.[0] || null); })} /></label></div></div><textarea value={rawEngine} onChange={(event) => setRawEngine(event.target.value)} rows={14} /><div className="action-row"><button disabled={!rawEngineDirty} onClick={() => run(() => saveRaw("engine"))}>Save</button><button disabled={!rawEngineDirty} onClick={() => setRawEngine(rawEngineOriginal)}>Discard Changes</button><button className="danger" onClick={() => run(async () => { if (await confirmAction("Restore UserEngine gameplay defaults? Server name, password, Port, and IGWPort will be preserved.")) await runTaskAndRefresh(() => mapsApi.resetUserSettings({ scope: "engine", confirmation: "RESTORE MAP DEFAULTS" }), "Restoring UserEngine defaults", "UserEngine Defaults Restored", { resultScope: "modifiers", restartAcceptedMessage: "Defaults restored successfully. The maps are restarting and should be back up soon.", onRestartAccepted: () => setRawEngineOriginal(rawEngine) }); await loadUserEngine(); })}>Restore Defaults</button></div></article>
        <article className="raw-editor-card"><div className="panel-title"><h4>UserGame.ini</h4><div className="action-row"><button onClick={() => downloadIni("game")}>Download</button><label className="button-link">Import<input className="hidden-file-input" type="file" accept=".ini,text/plain" onChange={(event) => run(async () => { await importIni("game", event.target.files?.[0] || null); })} /></label></div></div><textarea value={rawGame} onChange={(event) => setRawGame(event.target.value)} rows={14} /><div className="action-row"><button disabled={!rawGameDirty} onClick={() => run(() => saveRaw("game"))}>Save</button><button disabled={!rawGameDirty} onClick={() => setRawGame(rawGameOriginal)}>Discard Changes</button><button className="danger" onClick={() => run(restoreRawGameDefaults)}>{userGameName ? "Restore Defaults" : "Restore All UserGame Defaults"}</button></div></article>
      </div></div>}
    </div>
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

function SettingsCardGrid({ fields, values, onChange, viewMode = "grid", emptyMessage = "Select a modifier category." }: { fields: UserSettingField[]; values: Record<string, string>; onChange: (id: string, value: string) => void; viewMode?: "grid" | "list"; emptyMessage?: string }) {
  if (!fields.length) return <div className="empty">{emptyMessage}</div>;
  if (viewMode === "list") {
    return <div className="settings-list-wrap"><table className="settings-list-table"><thead><tr><th>Modifier</th><th>Setting Key</th><th>Value</th></tr></thead><tbody>{fields.map((field) => <tr key={field.id}>
      <td><strong>{friendlySettingLabel(field.id, field.key || field.id)}</strong><small>{settingsCategory(field.section || field.key || field.id)}</small></td>
      <td>{field.key || field.id}</td>
      <td><SettingInput field={field} value={values[field.id] ?? field.default ?? ""} inputId={`setting-list-${field.scope}-${field.id}`} onChange={(value) => onChange(field.id, value)} /></td>
    </tr>)}</tbody></table></div>;
  }
  return <div className="settings-grid settings-grid-roomy">{fields.map((field) => <SettingControl key={field.id} field={field} value={values[field.id] ?? field.default ?? ""} onChange={(value) => onChange(field.id, value)} />)}</div>;
}

function SettingControl({ field, value, onChange }: { field: UserSettingField; value: string; onChange: (value: string) => void }) {
  const label = friendlySettingLabel(field.id, field.key || field.id);
  const inputId = `setting-${field.scope}-${field.id}`;
  return <label className="settings-field" htmlFor={inputId}>
    <span><strong>{label}</strong><small>{field.key || field.id}</small></span>
    <SettingInput field={field} value={value} inputId={inputId} onChange={onChange} />
  </label>;
}

function SettingInput({ field, value, inputId, onChange }: { field: UserSettingField; value: string; inputId: string; onChange: (value: string) => void }) {
  return field.type === "boolean"
    ? <select id={inputId} value={normalizeBooleanText(value)} onChange={(event) => onChange(event.target.value)}><option value="True">True</option><option value="False">False</option></select>
    : field.type === "integer" || field.type === "number"
      ? <input id={inputId} type="number" step={field.type === "integer" ? "1" : "any"} value={value} onChange={(event) => onChange(event.target.value)} />
      : String(value).length > 72 || value.includes("(")
        ? <textarea id={inputId} rows={3} value={value} onChange={(event) => onChange(event.target.value)} />
        : <input id={inputId} value={value} onChange={(event) => onChange(event.target.value)} />;
}

function MemoryUsageBar({ row, fallback, configuredLimit }: { row: LiveMapMemoryRow | null; fallback: string; configuredLimit?: unknown }) {
  if (!row) return <span className="muted">{fallback}</span>;
  const configuredLimitBytes = memoryValueToBytes(String(configuredLimit || ""));
  const limitBytes = configuredLimitBytes || row.limitBytes;
  const percent = limitBytes > 0 ? Math.max(0, Math.min(100, (row.usedBytes / limitBytes) * 100)) : Math.max(0, Math.min(100, Number(row.percent) || 0));
  return <div className="memory-usage-cell">
    <div className="memory-usage-bar"><span style={{ width: `${percent}%` }} /></div>
    <strong>{percent.toFixed(1)}%</strong>
    <span>{formatBytes(row.usedBytes)} / {formatBytes(limitBytes)}</span>
  </div>;
}

function sietchPasswordDraftChanged(row: SietchRow, draft: { password: string }, touched = false) {
  if (!touched) return false;
  if (row.passwordSet) return draft.password !== SIETCH_PASSWORD_MASK;
  return Boolean(draft.password);
}

function sietchHasPassword(row: SietchRow | null | undefined, draft?: { password: string }) {
  return Boolean(row?.passwordSet || row?.password || (draft?.password && draft.password !== SIETCH_PASSWORD_MASK));
}

function sietchPasswordInputValue(row: SietchRow, draft: { password: string }, touched: boolean) {
  if (touched) return draft.password;
  return row.passwordSet ? SIETCH_PASSWORD_MASK : draft.password;
}

function defaultSietchName(row: SietchRow) {
  const dimension = Number(row.dimension);
  if (dimension === 0) return "Sietch Abbir";
  if (dimension === 1) return "Sietch Alraab";
  return `Sietch ${dimension + 1}`;
}

function sietchTargetDisplayName(row: SietchRow, draftDisplayName?: string) {
  const draft = String(draftDisplayName ?? "").trim();
  if (draft) return draft;
  return defaultSietchName(row) || row.displayName || `partition ${row.partitionId}`;
}

function SietchMapName({ name, sietch, draft }: { name: string; sietch?: SietchRow | null; draft?: { password: string } }) {
  const passwordSet = sietchHasPassword(sietch, draft);
  const label = sietch?.displayName ? `${name} (${sietch.displayName})` : name;
  return <span className="map-name-with-lock">{passwordSet && <Lock size={15} aria-label="Password set" />}<span>{label}</span></span>;
}

function SietchName({ sietch, draft }: { sietch: SietchRow; draft?: { password: string } }) {
  return <span className="map-name-with-lock sietch-name-with-lock">{sietchHasPassword(sietch, draft) && <Lock size={15} aria-label="Password set" />}<span>{sietch.displayName}</span></span>;
}

function MapRuntimeStatus({ value }: { value: unknown }) {
  const label = String(value || "Not Available");
  return <span className="map-runtime-status" title={mapRuntimeStatusDetail(label)}>
    <StatusPill value={label} />
  </span>;
}

function mapRuntimeStatusDetail(value: string) {
  if (/^Ready$/i.test(value)) return "Travel-ready: the map has a server ID, endpoint, and farm readiness.";
  if (/^Loading$/i.test(value)) return "The container/server is up, but travel should wait until farm readiness is true.";
  if (/^Starting$/i.test(value)) return "A server is assigned, but it has not reported alive yet.";
  if (/^Not Running$/i.test(value)) return "No active server is assigned for this map.";
  if (/^Configuring$/i.test(value)) return "Map configuration is being updated.";
  return "Runtime state from map registration and readiness checks.";
}

function passwordPlaceholder(passwordSet: boolean) {
  return "Empty for none";
}

function groupSettingsFields(fields: UserSettingField[], includeAll = false): [string, UserSettingField[]][] {
  const grouped = new globalThis.Map<string, UserSettingField[]>();
  for (const field of fields) {
    const category = settingsCategory(field.section || field.key || field.id);
    grouped.set(category, [...(grouped.get(category) || []), field]);
  }
  const groups = [...grouped.entries()];
  return includeAll && fields.length ? [["All", fields], ...groups] : groups;
}

function filterSettingsFields(fields: UserSettingField[], query: string) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return fields;
  return fields.filter((field) => {
    const label = friendlySettingLabel(field.id, field.key || field.id);
    const category = settingsCategory(field.section || field.key || field.id);
    const haystack = `${label} ${field.id} ${field.key || ""} ${field.section || ""} ${category}`.toLowerCase();
    return haystack.includes(needle);
  });
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
  return Object.fromEntries(parseUserSettingRows(text).map((row) => [String(row.key || row.setting), String(row.value ?? "")]));
}

function changedKeys(original: Record<string, string>, draft: Record<string, string>, keys: string[]) {
  return keys.filter((key) => String(original[key] ?? "") !== String(draft[key] ?? ""));
}

function valuesForDirtyFields(original: Record<string, string>, draft: Record<string, string>, fields: UserSettingField[]) {
  return Object.fromEntries(fields
    .filter((field) => String(original[field.id] ?? "") !== String(draft[field.id] ?? ""))
    .map((field) => [field.id, String(draft[field.id] ?? field.default ?? "")]));
}

type SietchRow = { partitionId: string; dimension: string; displayName: string; password: string; passwordSet: boolean; active: boolean };
const SIETCH_PASSWORD_MASK = "********";

function parseSietchRows(text: string, idsText = ""): SietchRow[] {
  const rows: SietchRow[] = [];
  const ids = idsText.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
  let dimensionIndex = 0;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*DIMENSION\b/i.test(line)) continue;
    const partitionMatch = line.match(/\b(?:partition|id)\s*[:=]?\s*(\d+)\b/i) || line.match(/^\s*(\d+)\s+/);
    if (!partitionMatch) continue;
    const dimension = partitionMatch[1];
    const partitionId = ids[dimensionIndex] || partitionMatch[1];
    const displayName = (line.match(/\b(?:display|name)\s*[:=]\s*([^|,\t]+)/i)?.[1] || line.match(/\bSietch\s+([A-Za-z0-9 _-]+)/i)?.[0] || `Sietch ${partitionId}`).trim();
    const passwordValue = (line.match(/\bpassword\s*[:=]\s*([^|,\t]+)/i)?.[1] || line.match(/\((?:un)?set\)\s*$/i)?.[0] || "").trim();
    const passwordSet = /\(set\)|\bset\b|true|yes/i.test(passwordValue) || /\(set\)\s*$/i.test(line);
    const password = /\(set\)|\(unset\)|\bset\b|\bunset\b/i.test(passwordValue) ? "" : passwordValue;
    const active = !/\binactive|disabled|stopped\b/i.test(line);
    rows.push({ partitionId, dimension, displayName, password, passwordSet: passwordSet || Boolean(password), active });
    dimensionIndex += 1;
  }
  const unique = new globalThis.Map<string, SietchRow>();
  for (const row of rows) unique.set(row.partitionId, row);
  return [...unique.values()].sort((a, b) => Number(a.dimension) - Number(b.dimension));
}

function memoryForMap(rows: LiveMapMemoryRow[], map: string, row?: Record<string, unknown>) {
  const normalized = normalizeMapKey(map);
  const partitionId = String(row?.partitionId || row?.partition || "").trim();
  const containerMap = normalizeContainerMapKey(map);
  const partitionMatch = partitionId ? rows.find((memoryRow) => {
    const container = memoryRow.container.toLowerCase();
    return container.endsWith(`-${partitionId.toLowerCase()}`);
  }) || null : null;
  if (partitionMatch) return partitionMatch;
  if (partitionId && normalized === "survival_1") return null;
  return rows.find((memoryRow) => {
    const memoryMap = normalizeMapKey(memoryRow.map);
    const memoryContainerMap = normalizeContainerMapKey(memoryRow.map);
    const container = memoryRow.container.toLowerCase();
    if (memoryMap === normalized) return true;
    if (memoryContainerMap === containerMap) return true;
    if (container === `dune-server-${containerMap}`) return true;
    if (container.startsWith(`dune-server-${containerMap}-`)) return true;
    return false;
  }) || null;
}

function statusWithLiveMemory(status: string, memoryRow: LiveMapMemoryRow | null, mode?: unknown) {
  const normalized = String(status || "Not Available");
  if (!memoryRow) return normalized;
  if (/^(Not Running|Not Available|Unallocated|Assigned|Idle)$/i.test(normalized)) {
    return "Loading";
  }
  return normalized;
}

function liveMemoryIsReadyMode(mode: unknown) {
  return /^(Always On|Core Map)$/i.test(String(mode || "").trim());
}

function partitionMemoryValue(memoryText: string, partitionId: string, fallback: string, mapName = "Survival_1") {
  const target = `${mapName}:${partitionId}`;
  const row = parseMemoryRows(memoryText).find((item) => String(item.map || "") === target);
  return String(row?.memory || fallback || "");
}

function deepDesertPartitionName(row: Record<string, unknown>) {
  const label = String(row.label || "").trim();
  if (label && !/^[-\d\s]+$/.test(label)) return label;
  const dimension = Number(row.dimension);
  if (dimension === 0) return "Deep Desert PvP";
  if (dimension === 1) return "Deep Desert PvE";
  return `Deep Desert ${Number.isFinite(dimension) ? dimension + 1 : "Instance"}`;
}

type UserGameTarget = { key: string; map: string; partitionId: string; label: string };

function settingsTargetKey(map: string, partitionId = "") {
  return `${map}::${partitionId}`;
}

function buildUserGameTargets(
  mapRows: Record<string, unknown>[],
  serverPartitionRows: Record<string, unknown>[],
  sietchRows: SietchRow[],
  deepDesertRows: Record<string, unknown>[]
): UserGameTarget[] {
  const targets: UserGameTarget[] = [];
  const seen = new Set<string>();
  function add(map: string, partitionId: string, label: string) {
    const normalizedMap = String(map || "").trim();
    const normalizedPartition = String(partitionId || "").trim();
    if (!normalizedMap) return;
    const key = settingsTargetKey(normalizedMap, normalizedPartition);
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ key, map: normalizedMap, partitionId: normalizedPartition, label });
  }

  add("__global__", "", "Global");
  for (const sietch of sietchRows) {
    add("Survival_1", sietch.partitionId, `Survival_1 - ${sietch.displayName || `Sietch ${sietch.dimension}`} (${sietch.partitionId})`);
  }
  for (const row of deepDesertRows) {
    const partitionId = String(row.partitionId || "").trim();
    if (partitionId) add("DeepDesert_1", partitionId, `DeepDesert_1 - ${deepDesertPartitionName(row)} (${partitionId})`);
  }
  for (const row of serverPartitionRows) {
    const map = String(row.map || "").trim();
    const partitionId = String(row.partitionId || "").trim();
    if (!map || !partitionId || map === "Survival_1" || /^DeepDesert_/i.test(map)) continue;
    const label = String(row.label || "").trim();
    add(map, partitionId, `${map}${label ? ` - ${label}` : ""} (${partitionId})`);
  }
  for (const row of mapRows) {
    const map = String(row.map || "").trim();
    const partitionId = String(row.partitionId || row.partition || (map === "Overmap" ? "2" : "")).trim();
    if (!map || map === "Survival_1" || /^DeepDesert_/i.test(map)) continue;
    add(map, partitionId, partitionId ? `${map} (${partitionId})` : map);
  }

  return targets;
}

function liveMemoryFallback(row: Record<string, unknown>) {
  const configured = String(row.memory || "").trim();
  if (configured && !/^Not Available$/i.test(configured) && liveMemoryIsReadyMode(row.mode)) return configured;
  const status = String(row.status || "");
  if (/^(Ready|Running|Starting|Loading|Warming)$/i.test(status)) return "Unavailable";
  return "Unallocated";
}

function normalizeMapKey(value: unknown) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeContainerMapKey(value: unknown) {
  return normalizeMapKey(value).replace(/_/g, "-");
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
  return loadPersistedMapsTask()?.result || null;
}

function loadPersistedMapsResultScope(): MapsResultScope {
  return loadPersistedMapsTask()?.resultScope || "maps";
}

function loadPersistedMapsTask(): PersistedMapsTask | null {
  try {
    const raw = window.localStorage.getItem(MAPS_RESULT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedMapsTask;
    if (parsed?.result?.status !== "running" || !parsed.taskId) {
      window.localStorage.removeItem(MAPS_RESULT_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function persistMapsTask(state: PersistedMapsTask | null) {
  try {
    if (!state?.result || state.result.status !== "running" || !state.taskId) window.localStorage.removeItem(MAPS_RESULT_KEY);
    else window.localStorage.setItem(MAPS_RESULT_KEY, JSON.stringify(state));
  } catch {
    // Browser storage can be unavailable in hardened modes.
  }
}

function isMissingPersistedTaskError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /task not found|404/i.test(message);
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
    return /\bCurrent:\s*(dynamic|always-on|overmap-active|disabled)\b/i.test(line) || /\bPartitions:\s*\d+/i.test(line) || /\bAssigned:\s*\d+/i.test(line);
  }).map((line) => {
    const map = line.split(/\s+/)[0];
    const assigned = line.match(/\bAssigned:\s*(\d+)/i)?.[1] || "";
    const partitions = line.match(/\bPartitions:\s*(\d+)/i)?.[1] || "";
    return {
      map,
      status: assigned && Number(assigned) > 0 ? "Starting" : "Not Running",
      mode: friendlyMapMode(line.match(/\bCurrent:\s*(dynamic|always-on|overmap-active|disabled)\b/i)?.[1] || line.match(/\b(dynamic|always-on|overmap-active|disabled)\b/i)?.[1] || ""),
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

function updateMemoryStatusText(text: string, updates: Array<{ map: string; partitionId?: string; memory: string }>) {
  const normalizedUpdates = updates.map((update) => ({
    key: update.partitionId ? `${update.map}:${update.partitionId}` : update.map,
    memory: formatMemoryValue(update.memory)
  })).filter((update) => update.key && update.memory);
  if (!normalizedUpdates.length) return text;
  const pending = new globalThis.Map(normalizedUpdates.map((update) => [update.key, update.memory]));
  const lines = String(text || "").split(/\r?\n/);
  const nextLines = lines.map((line) => {
    const match = line.trim().match(/^(.+?)\s{2,}(.+)$/);
    if (!match) return line;
    const key = match[1].trim();
    const memory = pending.get(key);
    if (!memory) return line;
    pending.delete(key);
    return `${key.padEnd(28)} ${memory}`;
  });
  const insertLines = Array.from(pending.entries()).map(([key, memory]) => `${key.padEnd(28)} ${memory}`);
  if (!insertLines.length) return nextLines.join("\n");
  const hasBody = nextLines.some((line) => line.trim());
  const base = hasBody ? nextLines : ["=== Memory configuration ===", "Default memory: built-in per-map defaults, or server catalog for other dynamic maps", "", "MAP                          MEMORY"];
  return [...base, ...insertLines].join("\n");
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

function parseReadinessPartitionStatuses(text: string) {
  const statuses = new globalThis.Map<string, string>();
  for (const rawLine of stripAnsi(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    const baseSurvivalMatch = line.match(/^(OK|WAIT|FAIL)\s+Survival_1\s+(.+)$/i);
    if (baseSurvivalMatch) {
      const [, state, detail] = baseSurvivalMatch;
      if (/^OK$/i.test(state) && /\bready\b/i.test(detail)) statuses.set("1", "Ready");
      else if (/^WAIT$/i.test(state) && /\bwarming\b/i.test(detail)) statuses.set("1", "Loading");
      else if (/^FAIL$/i.test(state)) statuses.set("1", "Not Running");
      continue;
    }
    const match = line.match(/^(OK|WAIT|FAIL)\s+dune-server-survival-1-(\d+)\s+(.+)$/i);
    if (!match) continue;
    const [, state, partitionId, detail] = match;
    if (/^OK$/i.test(state) && /\bready\b/i.test(detail)) statuses.set(partitionId, "Ready");
    else if (/^WAIT$/i.test(state) && /\bwarming\b/i.test(detail)) statuses.set(partitionId, "Loading");
    else if (/^FAIL$/i.test(state)) statuses.set(partitionId, "Not Running");
  }
  return statuses;
}

function mergeMapAndMemoryRows(mapsText: string, memoryText: string, serversText = ""): Record<string, unknown>[] {
  const rows = new globalThis.Map<string, Record<string, unknown>>();
  const serverRows = new globalThis.Map<string, Record<string, unknown>>();
  for (const row of parseServerPartitionRows(serversText)) {
    const map = String(row.map || "");
    if (!map) continue;
    const existing = serverRows.get(map);
    const existingDimension = Number(existing?.dimension ?? Number.POSITIVE_INFINITY);
    const rowDimension = Number(row.dimension ?? Number.POSITIVE_INFINITY);
    const existingPartitionId = Number(existing?.partitionId ?? Number.POSITIVE_INFINITY);
    const rowPartitionId = Number(row.partitionId ?? Number.POSITIVE_INFINITY);
    const useRowAsBase = !existing || rowDimension < existingDimension || (rowDimension === existingDimension && rowPartitionId < existingPartitionId);
    const base = useRowAsBase ? row : existing;
    const status = map === "DeepDesert_1" ? String(base?.status || "") : strongestMapStatus(String(existing?.status || ""), String(row.status || ""));
    serverRows.set(map, {
      ...base,
      status,
      dimensions: existing?.dimensions ? `${String(existing.dimensions)}, ${String(row.label || row.partitionId)}` : String(row.label || row.partitionId || "")
    });
  }
  for (const row of parseMemoryRows(memoryText)) {
    const map = String(row.map || "");
    if (!map) continue;
    if (map.includes(":")) continue;
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
  const ready = isTruthyDbValue(row.ready);
  const alive = isTruthyDbValue(row.alive);
  if (ready && alive) return "Ready";
  if (alive) return "Loading";
  if (assigned) return "Starting";
  return "Not Running";
}

function isTruthyDbValue(value: unknown) {
  return /^(true|t|1|yes|y)$/i.test(String(value || "").trim());
}

function mapCanForceDespawn(row: Record<string, unknown>) {
  return /^(Ready|Loading|Starting|Warming|Running)$/i.test(String(row.status || "").trim());
}

function mapRuntimeNeedsLiveApply(status: unknown) {
  return /^(Ready|Loading|Starting|Assigned|Warming|Running)$/i.test(String(status || "").trim());
}

function strongestMapStatus(a: string, b: string) {
  const order = ["Not Available", "Not Running", "Starting", "Loading", "Warming", "Running", "Ready"];
  return order.indexOf(b) > order.indexOf(a) ? b : a || b;
}

function friendlyMapMode(value: string) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "dynamic") return "Dynamic";
  if (normalized === "always-on") return "Always On";
  if (normalized === "overmap-active") return "Overmap Active";
  if (normalized === "disabled") return "Disabled";
  if (normalized === "core map" || normalized === "core") return "Core Map";
  return value ? titleCase(value) : "Not Available";
}

function modeInputValue(value: string) {
  const normalized = String(value || "").toLowerCase();
  if (/core/.test(normalized)) return "always-on";
  if (/always/.test(normalized)) return "always-on";
  if (/overmap/.test(normalized)) return "overmap-active";
  if (/disabled/.test(normalized)) return "disabled";
  return "dynamic";
}

function memoryInputValue(value: string) {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)\s*(GB|GiB?|MB|MiB?|[gGmM])?/);
  if (!match) return "8";
  return match[1];
}

function memoryValueToBytes(value: string) {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)\s*(GiB?|GB|MiB?|MB|[gGmM])?/i);
  if (!match) return 0;
  const amount = Number(match[1]) || 0;
  const unit = (match[2] || "GB").toLowerCase();
  const multiplier = unit.startsWith("m") ? 1024 ** 2 : 1024 ** 3;
  return amount * multiplier;
}

function normalizeRawIniContent(value: string) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\s+$/g, "");
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

function isSettingsRestartHandoffTask(task: Task) {
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
