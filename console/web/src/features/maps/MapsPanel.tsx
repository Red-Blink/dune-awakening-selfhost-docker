import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Download, Fuel, Grid2X2, Info, List, Lock, RotateCcw } from "lucide-react";
import { mapsApi, type ChoamTerminalOverview, type ChoamTradeCenter, type LiveMapMemoryRow, type MapCombatStateResult, type MapRuntimeSettings, type MemoryBalancerState, type MemorySwapState, type PartitionCombatStateRow, type SpicefieldTypeRow, type UserSettingField, type UserSettingsSchema } from "../../api/maps";
import { runGatedRestart, type RestartGate, type RestartGateChoice } from "../server/restartQueueGuard";
import { serverApi, type RestartQueueTarget } from "../../api/server";
import { setupApi, type Task } from "../../api/setup";
import { SecretInput } from "../../components/SecretInput";
import { InfoTooltip, KeyValueGrid, StatusPill, TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { firstDefined, formatUiSentence, stripAnsi, summarizeCommandText, titleCase } from "../../lib/display";
import { refreshServerPorts } from "../../api/serverPorts";
import { titleCaseWords } from "../players/playerAdminUtils";
import { QueueBadges, queueCountsTotal, type QueueCounts } from "../../components/common/QueueBadges";
import {
  childAccessPieceCountForMap,
  childAccessPieceCountForPartition,
  pendingRefillCountForMap,
  pendingRefillCountForPartition,
  usePendingQueues,
  vehicleDeleteCountForMap,
  vehicleDeleteCountForPartition
} from "../../lib/usePendingRefills";
import type { PendingRefills } from "../../api/bases";
import { friendlyMapName, hasFriendlyMapName } from "./mapNames";
import { invalidateInstanceNames } from "./instanceNames";
// Re-exported so existing importers (and MapsPanel.sietchNames.test.ts) keep working.
export { parseSietchRows, type SietchRow } from "./sietchRows";
import {
  SIETCH_PASSWORD_MASK,
  blockedSietchEdits,
  isSietchWriteTarget,
  parseSietchRows,
  reconcileSietchDrafts,
  reconcileSietchPasswordTouched,
  sietchDraftChanges,
  sietchPasswordDraftChanged,
  writableSietchEdits,
  type SietchRow
} from "./sietchRows";

// Taking a partition down is when any base write queued for it gets applied --
// refills, deletes and permission changes alike -- so every control that does
// so says what is waiting on it. Shares QueueBadges with the Bases banner and
// the Server battlegroup note: this badge used to report generator refills
// only, which quietly understated what a restart was about to do.
function PendingRefillBadge({ counts }: { counts: QueueCounts }) {
  if (!queueCountsTotal(counts)) return null;
  return <span className="pending-refill-badge" title="Queued base writes are applied while this is down">
    <QueueBadges counts={counts} labels={false} size={12} />
    pending
  </span>;
}

type HomeTaskResult = { status: "running" | "succeeded" | "failed" | "stopped"; title: string; message?: string; details?: string; warnings?: string[] };
type MapsResultScope = "maps" | "modifiers";
type MapsTaskQueueState = { phase: "queued" | "running"; title: string };
type MapsTaskResponse = { task?: Task; queued?: boolean; invalidatesInstanceNamesOnSuccess?: boolean };
type MapsTaskAction = { label: string; run: () => Promise<MapsTaskResponse> };
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
  // Partitions this sequence writes sietch name/password for. The refresh at
  // the end reloads every row, so without this it replaced every draft --
  // discarding pending edits on rows the save never touched. Omit it when the
  // sequence writes no sietch fields at all; then nothing is discarded.
  writtenPartitionIds?: string[];
};
type PersistedMapsTask = { taskId?: string; result: HomeTaskResult | null; runningTitle?: string; successTitle?: string; resultScope?: MapsResultScope };
type SpicefieldDraft = { maxActive: string; maxPrimed: string; spawningActive: boolean; spawnWeight: string };
export type MapSortColumn = "map" | "status" | "mode" | "memory";
type MapSortState = { column: MapSortColumn | null; direction: "asc" | "desc" };
const MAP_SORT_COLUMNS: Array<[MapSortColumn, string]> = [
  ["map", "Map"],
  ["status", "Status"],
  ["mode", "Mode"],
  ["memory", "Memory"]
];
type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; warning?: string; details?: { label: string; value: string; tone?: "danger" | "success" | "accent" }[] }) => Promise<boolean>;
type MapsPanelProps = {
  onError: (text: string) => void;
  confirmAction: ConfirmAction;
  restartGate: RestartGate;
  confirmSettingsRestart: (kind: "UserEngine" | "UserGame", target?: RestartQueueTarget) => Promise<RestartGateChoice>;
  waitForTaskWithUpdates: (task: Task, onUpdate: (task: Task) => void) => Promise<Task>;
  taskTechnicalDetails: (task: Task) => string;
};
const LIVE_MEMORY_STALE_GRACE_MS = 20000;
const LIVE_MEMORY_REFRESH_MS = 15000;
const MAP_RUNTIME_REFRESH_MS = 15000;
type CachedLiveMemoryRow = { row: LiveMapMemoryRow; sampledAt: number };

export function isPrimaryDeepDesertPartition(row: Record<string, unknown>) {
  return String(row.dimension ?? "") === "0";
}

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
    {result.warnings && result.warnings.length > 0 && <div className="home-task-result-warnings">
      {result.warnings.map((warning, index) => <p key={`${warning}-${index}`}>
        <AlertTriangle size={14} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 6 }} />
        {formatResultMessage(warning)}
      </p>)}
    </div>}
  </div>;
}

function inlineTaskResultClass(result: HomeTaskResult) {
  return result.status === "succeeded" || result.status === "stopped" ? "ok" : result.status === "failed" ? "fail" : "running";
}

function isDeepDesertLayoutResult(result: HomeTaskResult | null) {
  if (!result) return false;
  return /deep desert (?:layout|instance)|dual deep desert|extra deep desert/i.test(`${result.title || ""}\n${result.message || ""}`);
}

function isForceDespawnResult(result: HomeTaskResult | null) {
  if (!result) return false;
  return /\bdespawn/i.test(`${result.title || ""}\n${result.message || ""}`);
}

function isForceSpawnResult(result: HomeTaskResult | null) {
  if (!result) return false;
  return /\bspawn(?:ing|ed)?\b/i.test(`${result.title || ""}\n${result.message || ""}`) && !/\bdespawn/i.test(`${result.title || ""}\n${result.message || ""}`);
}

function isMapSettingsResult(result: HomeTaskResult | null) {
  if (!result) return false;
  return /\bmap settings\b|saving .+ settings|settings saved/i.test(`${result.title || ""}\n${result.message || ""}`);
}

function isSietchRestartResult(result: HomeTaskResult | null) {
  if (!result) return false;
  return /\bsietch\b.+\brestart|\brestart(?:ing|ed)?\b.+\bsietch\b/i.test(`${result.title || ""}\n${result.message || ""}`);
}

function mapResultTarget(map: string, partitionId = "") {
  return partitionId ? `map:${map}:${partitionId}` : `map:${map}`;
}

// Mirrors server.js's restartPayload: "engine"/"mapEngine"/"partitionEngine"
// (UserEngine.ini is one shared file, not per-map -- "mapEngine"/
// "partitionEngine" just scope the editor's view/edit to one map or
// partition for convenience) plus "global"/"profile" all restart every game
// service (stack-wide), so the restart-queue online check for those must
// stay battlegroup-wide (undefined target) rather than being scoped to
// whatever map happens to be selected in the editor.
function settingsRestartTarget(scope: string, map?: string, partitionId?: string): RestartQueueTarget | undefined {
  if (scope === "engine" || scope === "mapEngine" || scope === "partitionEngine" || scope === "global" || scope === "profile") return undefined;
  if (partitionId) return { partitionId };
  if (map) return { map };
  return undefined;
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
  return `${index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function formatGiB(value: number) {
  const amount = Number.isFinite(value) && value > 0 ? value / (1024 ** 3) : 0;
  return `${amount.toFixed(1)} GB`;
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

function alwaysOnParallelismLimit(settings: MapRuntimeSettings | null, protectionEnabled: boolean, reserveMode: "automatic" | "custom", reserveValue: string) {
  if (!protectionEnabled) return 16;
  const physical = settings?.physicalMemoryGiB || 0;
  const reserve = reserveMode === "automatic" ? settings?.automaticHostMemoryReserveGiB || 4 : Number(reserveValue);
  if (!physical || !Number.isFinite(reserve) || reserve < 1 || reserve >= physical) return settings?.maxAlwaysOnStartupParallelism || 1;
  return Math.max(1, Math.min(16, Math.floor((physical - reserve) / 16)));
}

// Every sietch mutation goes through here so the Bases panel's cached instance
// names cannot outlive a rename. Routed through one wrapper rather than five
// call sites because a missed one is invisible until someone notices a stale
// label on another tab.
function updateSietches(body: Record<string, unknown>) {
  return mapsApi.updateSietches(body).then((result) => {
    invalidateInstanceNames();
    return { ...result, invalidatesInstanceNamesOnSuccess: true };
  });
}

export function MapsPanel({ onError, confirmAction, restartGate, confirmSettingsRestart, waitForTaskWithUpdates, taskTechnicalDetails }: MapsPanelProps) {
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
  const [memorySwap, setMemorySwap] = useState<MemorySwapState | null>(null);
  const [memorySwapSaving, setMemorySwapSaving] = useState(false);
  const [memorySwapMode, setMemorySwapMode] = useState<"low" | "automatic" | "custom">("automatic");
  const [memorySwapAllowance, setMemorySwapAllowance] = useState("2");
  const [memorySwapPool, setMemorySwapPool] = useState("4");
  const [memorySwapSwappiness, setMemorySwapSwappiness] = useState("10");
  const [memorySwapResult, setMemorySwapResult] = useState<HomeTaskResult | null>(null);
  const [runtimeSettings, setRuntimeSettings] = useState<MapRuntimeSettings | null>(null);
  const [startupParallelism, setStartupParallelism] = useState("1");
  const [hostMemoryProtection, setHostMemoryProtection] = useState(true);
  const [hostMemoryReserveMode, setHostMemoryReserveMode] = useState<"automatic" | "custom">("automatic");
  const [hostMemoryReserve, setHostMemoryReserve] = useState("4");
  const [runtimeSettingsSaving, setRuntimeSettingsSaving] = useState(false);
  const [runtimeSettingsResult, setRuntimeSettingsResult] = useState<HomeTaskResult | null>(null);
  const [combatStateByMap, setCombatStateByMap] = useState<Record<string, MapCombatStateResult>>({});
  const [sietchesText, setSietchesText] = useState("");
  const [sietchDimensionsText, setSietchDimensionsText] = useState("");
  const [sietchDimensionIdsText, setSietchDimensionIdsText] = useState("");
  const [activeSietches, setActiveSietches] = useState("1");
  const [deepDesertLayoutDraft, setDeepDesertLayoutDraft] = useState("1");
  const [deepDesertThirdRoleDraft, setDeepDesertThirdRoleDraft] = useState<"pve" | "pvp">("pve");
  const [sietchDrafts, setSietchDrafts] = useState<Record<string, { displayName: string; password: string }>>({});
  const [sietchPasswordTouched, setSietchPasswordTouched] = useState<Record<string, boolean>>({});
  const [selectedMapName, setSelectedMapName] = useState("");
  const [selectedPartitionId, setSelectedPartitionId] = useState("");
  const [mapSort, setMapSort] = useState<MapSortState>({ column: null, direction: "asc" });
  const [engineMapName, setEngineMapName] = useState("__global__");
  const [enginePartitionId, setEnginePartitionId] = useState("");
  const [userGameMapName, setUserGameMapName] = useState("");
  const [userGamePartitionId, setUserGamePartitionId] = useState("");
  const [selectedGameCategory, setSelectedGameCategory] = useState("");
  const [selectedEngineCategory, setSelectedEngineCategory] = useState("");
  const [modifierFilter, setModifierFilter] = useState("");
  const [modifierViewMode, setModifierViewMode] = useState<"grid" | "list">("grid");
  const [settingsTab, setSettingsTab] = useState<"engine" | "game" | "spicefields" | "choam">("engine");
  const [spicefieldRows, setSpicefieldRows] = useState<SpicefieldTypeRow[]>([]);
  const [spicefieldDrafts, setSpicefieldDrafts] = useState<Record<string, SpicefieldDraft>>({});
  const [spicefieldResult, setSpicefieldResult] = useState<HomeTaskResult | null>(null);
  const [spicefieldSavingId, setSpicefieldSavingId] = useState("");
  const [spicefieldFilter, setSpicefieldFilter] = useState("");
  const [choamOverview, setChoamOverview] = useState<ChoamTerminalOverview | null>(null);
  const [choamSavingKey, setChoamSavingKey] = useState("");
  const [choamResult, setChoamResult] = useState<HomeTaskResult | null>(null);
  const [modifiersOpen, setModifiersOpen] = useState(false);
  const [modifierSettingsLoaded, setModifierSettingsLoaded] = useState(false);
  const [deferredRestartPending, setDeferredRestartPending] = useState<{ pending: boolean; since?: string; label?: string }>({ pending: false });
  const [clientIniCounts, setClientIniCounts] = useState<{ engine: number | null; game: number | null }>({ engine: null, game: null });
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [startupSettingsOpen, setStartupSettingsOpen] = useState(false);
  const [memory, setMemory] = useState("8");
  const [modeDraft, setModeDraft] = useState("dynamic");
  const [loading, setLoading] = useState(false);
  const [mapsLoaded, setMapsLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [mapsResult, setMapsResult] = useState<HomeTaskResult | null>(() => loadPersistedMapsResult());
  const [mapsResultScope, setMapsResultScope] = useState<MapsResultScope>(() => loadPersistedMapsResultScope());
  const [mapsResultTarget, setMapsResultTarget] = useState("");
  const [mapsTaskQueueStates, setMapsTaskQueueStates] = useState<Record<string, MapsTaskQueueState>>({});
  const pendingQueues = usePendingQueues();
  // Every queue that a map-down window flushes, for one partition or for every
  // partition of one world_partition map. Kept as callbacks so each restart
  // control reads the same complete set of counts.
  const queueCountsForPartition = useCallback((partitionId: number): QueueCounts => ({
    fuel: pendingRefillCountForPartition(pendingQueues.fuel.pending, partitionId),
    water: pendingRefillCountForPartition(pendingQueues.water.pending, partitionId),
    deletes: pendingRefillCountForPartition(pendingQueues.deletes.pending, partitionId),
    vehicleDeletes: vehicleDeleteCountForPartition(pendingQueues.vehicleDeletes.pending, partitionId),
    permissions: childAccessPieceCountForPartition(pendingQueues.permissions.pending, partitionId)
  }), [pendingQueues.fuel.pending, pendingQueues.water.pending, pendingQueues.deletes.pending, pendingQueues.vehicleDeletes.pending, pendingQueues.permissions.pending]);
  const queueCountsForMap = useCallback((partitionMap: string): QueueCounts => ({
    fuel: pendingRefillCountForMap(pendingQueues.fuel.pending, partitionMap),
    water: pendingRefillCountForMap(pendingQueues.water.pending, partitionMap),
    deletes: pendingRefillCountForMap(pendingQueues.deletes.pending, partitionMap),
    vehicleDeletes: vehicleDeleteCountForMap(pendingQueues.vehicleDeletes.pending, partitionMap),
    permissions: childAccessPieceCountForMap(pendingQueues.permissions.pending, partitionMap)
  }), [pendingQueues.fuel.pending, pendingQueues.water.pending, pendingQueues.deletes.pending, pendingQueues.vehicleDeletes.pending, pendingQueues.permissions.pending]);
  const mapsLoadRef = useRef<Promise<void> | null>(null);
  const mapsRuntimeRefreshRef = useRef<Promise<void> | null>(null);
  const mapsDisplayedTerminalTaskRef = useRef<Set<string>>(new Set());
  const mapsTaskQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mapsQueuedTargetsRef = useRef<Set<string>>(new Set());
  const mapsAnonymousTaskIdRef = useRef(0);
  const liveMemoryCacheRef = useRef<Map<string, CachedLiveMemoryRow>>(new globalThis.Map());
  async function run(action: () => Promise<unknown>) {
    onError("");
    try { await action(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
  }
  function applyOptimisticMemoryUpdates(updates: Array<{ map: string; partitionId?: string; memory: string }> = []) {
    if (!updates.length) return;
    setMemoryText((current) => updateMemoryStatusText(current, updates));
  }
  async function enqueueMapsTask(resultTarget: string, title: string, action: () => Promise<void>) {
    const trackedTarget = resultTarget.trim();
    if (trackedTarget && mapsQueuedTargetsRef.current.has(trackedTarget)) return;
    const queueId = trackedTarget || `task:${++mapsAnonymousTaskIdRef.current}`;
    mapsQueuedTargetsRef.current.add(queueId);
    if (trackedTarget) {
      setMapsTaskQueueStates((current) => ({ ...current, [trackedTarget]: { phase: "queued", title } }));
    }
    const queuedTask = mapsTaskQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (trackedTarget) {
          setMapsTaskQueueStates((current) => ({ ...current, [trackedTarget]: { phase: "running", title } }));
        }
        try {
          await action();
        } finally {
          mapsQueuedTargetsRef.current.delete(queueId);
          if (trackedTarget) {
            setMapsTaskQueueStates((current) => {
              const next = { ...current };
              delete next[trackedTarget];
              return next;
            });
          }
        }
      });
    mapsTaskQueueRef.current = queuedTask.then(() => undefined, () => undefined);
    await queuedTask;
  }
  async function runTaskAndRefresh(action: () => Promise<{ task?: Task; queued?: boolean }>, runningTitle = "Applying Map Changes", successTitle = "Map Changes Applied", options: MapsTaskOptions = {}) {
    await enqueueMapsTask(options.resultTarget || "", runningTitle, () => runTaskAndRefreshNow(action, runningTitle, successTitle, options));
  }
  async function runTaskAndRefreshNow(action: () => Promise<{ task?: Task; queued?: boolean }>, runningTitle: string, successTitle: string, options: MapsTaskOptions) {
    const resultScope = options.resultScope || "maps";
    const resultTarget = options.resultTarget || "";
    const started: HomeTaskResult = { status: "running", title: runningTitle };
    setMapsResultScope(resultScope);
    setMapsResultTarget(resultTarget);
    setMapsResult(started);
    persistMapsTask({ result: started, runningTitle, successTitle, resultScope });
    let response: { task?: Task; queued?: boolean };
    try {
      response = await action();
    } catch (error) {
      const failed: HomeTaskResult = { status: "failed", title: "Map Change Failed", details: error instanceof Error ? error.message : String(error) };
      setMapsResult(failed);
      persistMapsTask(null);
      throw error;
    }
    if (!response.task) {
      // Gated by the restart queue: this save-and-restart was captured into a
      // countdown, so the change applies when it fires. Manage it under
      // Admin Tools -> Restart Queue.
      setMapsResultScope(resultScope);
      setMapsResultTarget(resultTarget);
      setMapsResult({ status: "succeeded", title: successTitle, message: "Restart queued. These changes apply when the countdown completes — manage it under Admin Tools → Restart Queue." });
      persistMapsTask(null);
      await loadMaps();
      return;
    }
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
          // The final terminal `next` (below) never actually displays once this
          // branch has fired -- see the `!restartAcceptedShown || next.status !== "succeeded"`
          // guard after waitForTaskWithUpdates resolves. warnings must come from
          // THIS task snapshot instead; safe because the raw-write step (where
          // usersettings.py prints USERSETTINGS_WARNING lines) always runs before
          // the restart step this handoff fires on, so task.warnings is already complete.
          setMapsResult({ status: "succeeded", title: successTitle, message: options.restartAcceptedMessage, warnings: task.warnings });
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
      ? { status: "succeeded", title: successTitle, details: taskTechnicalDetails(final), warnings: final.warnings }
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
  async function runTaskSequenceAndRefresh(actions: MapsTaskAction[], runningTitle = "Applying Map Changes", successTitle = "Map Changes Applied", options: MapsTaskSequenceOptions = {}) {
    if (!actions.length) return;
    await enqueueMapsTask(options.resultTarget || "", runningTitle, () => runTaskSequenceAndRefreshNow(actions, runningTitle, successTitle, options));
  }
  async function runTaskSequenceAndRefreshNow(actions: MapsTaskAction[], runningTitle: string, successTitle: string, options: MapsTaskSequenceOptions) {
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
    const collectedWarnings: string[] = [];
    for (const [index, action] of actions.entries()) {
      const progressMessage = `Step ${index + 1} of ${actions.length}: ${action.label}`;
      if (!handedOffToWarming) {
        setMapsResultScope(resultScope);
        setMapsResultTarget(resultTarget);
        setMapsResult({ status: "running", title: runningTitle, message: progressMessage });
        persistMapsTask({ result: { status: "running", title: runningTitle, message: progressMessage }, runningTitle, successTitle, resultScope });
      }
      const response = await action.run();
      if (!response.task) {
        // Restart-queue gated (a save-and-restart step captured into a
        // countdown): the remaining change applies when it fires.
        setMapsResultScope(resultScope);
        setMapsResultTarget(resultTarget);
        setMapsResult({ status: "succeeded", title: successTitle, message: "Restart queued. The remaining changes apply when the countdown completes — manage it under Admin Tools → Restart Queue.", warnings: collectedWarnings.length ? collectedWarnings : undefined });
        persistMapsTask(null);
        await loadMaps();
        return;
      }
      if (!handedOffToWarming) {
        persistMapsTask({ taskId: response.task.id, result: { status: "running", title: runningTitle, message: progressMessage }, runningTitle, successTitle, resultScope });
      }
      final = await waitForTaskWithUpdates(response.task, (task) => {
        if (options.saveAcceptedMessage && isMapRuntimeHandoffTask(task)) {
          handedOffToWarming = true;
          mapsDisplayedTerminalTaskRef.current.add(task.id);
          if (!acceptedShown) {
            acceptedShown = true;
            // task.warnings is already complete by handoff time -- same reasoning as
            // runTaskAndRefreshNow's restart-handoff branch: the raw-write step (where
            // usersettings.py prints USERSETTINGS_WARNING lines) always runs before the
            // step this handoff fires on. Fold in whatever earlier actions in this
            // sequence already collected too.
            const handoffWarnings = [...collectedWarnings, ...(task.warnings || [])];
            const accepted: HomeTaskResult = { status: "succeeded", title: successTitle, message: options.saveAcceptedMessage, warnings: handoffWarnings.length ? handoffWarnings : undefined };
            setMapsResultScope(resultScope);
            setMapsResultTarget(resultTarget);
            setMapsResult(accepted);
            persistMapsTask(null);
            void refreshMapRuntime().catch(() => undefined);
            void loadLiveMemory().catch(() => undefined);
            // Handoff means the writes were accepted, so the written rows can
            // take the server's values -- but only those rows.
            void loadSietches({ writtenPartitionIds: options.writtenPartitionIds || [] }).catch(() => undefined);
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
      if (final.status === "succeeded" && response.invalidatesInstanceNamesOnSuccess) {
        // The first invalidation happens when the task is accepted so stale
        // names are not served during the write. Repeat it after completion:
        // a lookup made while the task was running may have read the old name.
        invalidateInstanceNames();
      }
      if (final?.warnings?.length) collectedWarnings.push(...final.warnings);
      if (final.status !== "succeeded") break;
    }
    const next: HomeTaskResult = final?.status === "succeeded"
      ? { status: "succeeded", title: successTitle, message: options.saveAcceptedMessage || undefined, details: options.saveAcceptedMessage ? undefined : taskTechnicalDetails(final), warnings: collectedWarnings.length ? collectedWarnings : undefined }
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
    // This runs after the loop breaks on failure too, so a failed save used to
    // wipe the drafts along with showing the error. Only a succeeded sequence
    // may discard anything, and then only the partitions it wrote.
    await loadSietches({
      writtenPartitionIds: next.status === "succeeded" ? (options.writtenPartitionIds || []) : []
    });
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
  function applyUserEngineValues(stdout: string) {
    const parsed = parseUserSettingsMap(stdout || "");
    setEngineValues(parsed);
    setEngineDraft(parsed);
  }
  async function loadUserEngineValues() {
    const values = await mapsApi.userEngine();
    applyUserEngineValues(values.stdout || "");
  }
  async function loadUserEngine() {
    const [values, raw] = await Promise.all([mapsApi.userEngine(), mapsApi.rawUserSettings("engine")]);
    applyUserEngineValues(values.stdout || "");
    setRawEngine(raw.content || "");
    setRawEngineOriginal(raw.content || "");
  }
  async function loadInitialModifierSettings() {
    // The raw Advanced editor is loaded only when it is opened. Making it part
    // of this gate would add another command before the normal modifier cards
    // can be used.
    await Promise.all([loadSchema(), loadUserEngineValues()]);
    setModifierSettingsLoaded(true);
  }
  async function loadSelectedEngineSettings(mapName: string, partitionId?: string) {
    if (mapName === "__global__") {
      await loadUserEngine();
      return;
    }
    const scope = partitionId ? "partitionEngine" : "mapEngine";
    const values = await mapsApi.userSettingsValues(scope, mapName, partitionId);
    const parsed = parseUserSettingsMap(values.stdout || "");
    setEngineValues(parsed);
    setEngineDraft(parsed);
  }
  async function loadSelectedSettings(mapName: string, partitionId?: string) {
    const [values, raw] = await Promise.all([mapsApi.userGame(mapName, partitionId), mapsApi.rawUserSettings("game", mapName, partitionId)]);
    const parsed = parseUserSettingsMap(values.stdout || "");
    setGameValues(parsed);
    setGameDraft(parsed);
    setRawGame(raw.content || "");
    setRawGameOriginal(raw.content || "");
  }
  // Three draft policies, deliberately distinct:
  //   preserveDrafts      -- background polling; whatever is on screen wins.
  //   writtenPartitionIds -- after a save; only the partitions actually written
  //                          take the server's values, everything else stays
  //                          pending (see reconcileSietchDrafts).
  //   neither             -- full reset, for a mount or an explicit refresh
  //                          where there is nothing pending to protect.
  async function loadSietches(options: { preserveDrafts?: boolean; writtenPartitionIds?: string[] } = {}) {
    const [list, dimensions, ids] = await Promise.all([mapsApi.sietches(), mapsApi.sietchDimensions("Survival_1"), mapsApi.sietchDimensions("Survival_1", true)]);
    // A non-zero exit still answers 200 with empty stdout, so a failed command
    // is only visible in exitCode. Discard its output rather than parsing
    // whatever it managed to print.
    const dimensionsText = dimensions.exitCode ? "" : (dimensions.stdout || "");
    const idsText = ids.exitCode ? "" : (ids.stdout || "");
    setSietchesText(list.stdout || "");
    setSietchDimensionsText(dimensionsText);
    setSietchDimensionIdsText(idsText);
    const rows = parseSietchRows(dimensionsText || list.stdout || "", idsText);
    const drafts = Object.fromEntries(rows.map((row) => [row.partitionId, { displayName: row.displayName, password: row.password }]));
    if (rows.length) {
      if (!options.preserveDrafts) {
        setActiveSietches(String(rows.filter((row) => row.active).length || rows.length));
      }
      if (options.preserveDrafts) {
        setSietchDrafts((current) => ({ ...drafts, ...current }));
      } else if (options.writtenPartitionIds) {
        // Functional updates on purpose: a save is long enough for the operator
        // to type into another row while it runs, and the closure this ran from
        // would not see that edit.
        const written = options.writtenPartitionIds;
        setSietchDrafts((current) => reconcileSietchDrafts(rows, current, written));
        setSietchPasswordTouched((current) => reconcileSietchPasswordTouched(current, written));
      } else {
        setSietchDrafts(drafts);
        setSietchPasswordTouched({});
      }
    }
  }
  async function loadCombatState(map: string) {
    // Combat state (PvP/PvE/MIXED/CONFLICT/UNKNOWN) is resolved server-side
    // from the effective UserGame.ini configuration — never inferred here
    // from dimension index, database labels, or display names. See
    // console/api/src/services/mapCombatState.js for the resolver.
    try {
      const result = await mapsApi.combatState(map);
      setCombatStateByMap((current) => ({ ...current, [map]: result }));
    } catch {
      // Combat state is supplementary metadata for this panel; a failure
      // to resolve it must not block or error the rest of the Maps tab.
      // Partition rows simply render without a combat-state badge.
    }
  }
  async function loadLiveMemory() {
    const result = await mapsApi.liveMemory();
    const now = Date.now();
    const cache = new globalThis.Map(liveMemoryCacheRef.current);
    for (const row of result.rows || []) {
      if (!row.container) continue;
      cache.set(row.container, { row, sampledAt: now });
    }
    for (const [container, cached] of cache.entries()) {
      if (now - cached.sampledAt > LIVE_MEMORY_STALE_GRACE_MS) cache.delete(container);
    }
    liveMemoryCacheRef.current = cache;
    setLiveMemory(Array.from(cache.values()).map((cached) => cached.row));
    setMemoryError(result.error || "");
  }
  async function loadMemoryBalancer() {
    setMemoryBalancer(await mapsApi.memoryBalancer());
  }
  async function loadMemorySwap(preserveDraft = false) {
    const status = await mapsApi.memorySwap();
    setMemorySwap(status);
    if (!preserveDraft) {
      const usesStandardSwappiness = status.configuredSwappiness === 10;
      const usesRecommendedPool = status.poolGiB === status.recommendedPoolGiB;
      const mode = usesStandardSwappiness && usesRecommendedPool && status.perServerGiB === 1
        ? "low"
        : usesStandardSwappiness && usesRecommendedPool && status.perServerGiB === 2
          ? "automatic"
          : "custom";
      setMemorySwapMode(mode);
      setMemorySwapAllowance(String(status.perServerGiB || 2));
      setMemorySwapPool(String(status.poolGiB || status.recommendedPoolGiB || 1));
      setMemorySwapSwappiness(String(status.configuredSwappiness ?? 10));
    }
  }
  async function loadRuntimeSettings() {
    const settings = await mapsApi.runtimeSettings();
    setRuntimeSettings(settings);
    setStartupParallelism(String(settings.alwaysOnStartupParallelism));
    setHostMemoryProtection(settings.hostMemoryProtectionEnabled);
    setHostMemoryReserveMode(settings.hostMemoryReserveConfigured ? "custom" : "automatic");
    setHostMemoryReserve(String(settings.hostMemoryReserveGiB));
  }
  async function loadSpicefields(options: { preserveDrafts?: boolean } = {}) {
    const result = await mapsApi.spicefields();
    const rows = result.rows || [];
    setSpicefieldRows(rows);
    const drafts = Object.fromEntries(rows.map((row) => [String(row.spicefield_type_id), spicefieldDraftFromRow(row)]));
    setSpicefieldDrafts((current) => options.preserveDrafts ? { ...drafts, ...current } : drafts);
    if (result.reason && !rows.length) {
      setSpicefieldResult({ status: "failed", title: "Spice Fields Unavailable", message: result.reason });
    }
  }
  async function loadChoamTerminals() {
    const overview = await mapsApi.choamTerminals();
    setChoamOverview(overview);
    if (!overview.supported) setChoamResult({ status: "failed", title: "CHOAM Terminals Unavailable", message: overview.reason || "This database schema does not support CHOAM terminal placement." });
  }
  async function installChoamCenter(center: ChoamTradeCenter) {
    const sietchCount = choamOverview?.sietches.length || 0;
    if (!(await confirmAction(`Install a CHOAM Exchange terminal at ${center.name}?`, {
      title: `Install at ${center.name}`,
      confirmLabel: "Install Terminals",
      details: [["Installation Scope", `All ${sietchCount} active Sietches`], ["Reload Required", "Restart Battlegroup"]].map(([label, value]) => ({ label, value }))
    }))) return;
    setChoamSavingKey(center.key);
    setChoamResult({ status: "running", title: `Installing ${center.name} Terminals...` });
    try {
      const result = await mapsApi.installChoamTerminals(center.key);
      await loadChoamTerminals();
      const created = result.created.length;
      setChoamResult({
        status: "succeeded",
        title: created ? "CHOAM Terminals Installed" : "CHOAM Terminals Already Installed",
        message: created ? `${created} terminal${created === 1 ? "" : "s"} added. Restart the battlegroup to load them in-game.` : "Every active sietch already has this trade-center terminal."
      });
    } catch (error) {
      setChoamResult({ status: "failed", title: "CHOAM Terminal Installation Failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setChoamSavingKey("");
    }
  }
  async function removeChoamCenter(center: ChoamTradeCenter) {
    const installed = choamOverview?.placements.filter((entry) => entry.trade_center_key === center.key && entry.actor_present).length || 0;
    if (!(await confirmAction(`Remove the console-managed CHOAM Exchange terminals from ${center.name}?`, {
      title: `Remove from ${center.name}`,
      confirmLabel: "Remove Terminals",
      danger: true,
      details: [["Tracked Terminals", String(installed)], ["Reload Required", "Restart Battlegroup"]].map(([label, value]) => ({ label, value, tone: label === "Tracked Terminals" ? "danger" as const : undefined }))
    }))) return;
    setChoamSavingKey(center.key);
    setChoamResult({ status: "running", title: `Removing ${center.name} Terminals...` });
    try {
      const result = await mapsApi.removeChoamTerminals(center.key);
      await loadChoamTerminals();
      setChoamResult({ status: "succeeded", title: "CHOAM Terminals Removed", message: result.removed ? `${result.removed} terminal${result.removed === 1 ? "" : "s"} removed. Restart the battlegroup to unload them in-game.` : "No console-managed terminals were installed at this trade post." });
    } catch (error) {
      setChoamResult({ status: "failed", title: "CHOAM Terminal Removal Failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setChoamSavingKey("");
    }
  }
  async function saveSpicefield(row: SpicefieldTypeRow) {
    const id = String(row.spicefield_type_id);
    const draft = spicefieldDrafts[id] || spicefieldDraftFromRow(row);
    const maxActive = parseWholeNumber(draft.maxActive);
    const maxPrimed = parseWholeNumber(draft.maxPrimed);
    const spawnWeight = Number(draft.spawnWeight);
    if (maxActive === null || maxActive < 0 || maxPrimed === null || maxPrimed < 0 || !Number.isFinite(spawnWeight) || spawnWeight < 0) {
      setSpicefieldResult({ status: "failed", title: "Spice Field Not Saved", message: "Use non-negative numbers for max active, max primed, and spawn weight." });
      return;
    }
    setSpicefieldSavingId(id);
    setSpicefieldResult({ status: "running", title: "Saving Spice Field..." });
    try {
      const result = await mapsApi.updateSpicefield(id, {
        max_globally_active: maxActive,
        max_globally_primed: maxPrimed,
        is_spawning_active: draft.spawningActive,
        global_spawn_weight: spawnWeight
      });
      setSpicefieldRows((current) => current.map((item) => String(item.spicefield_type_id) === id ? result.row : item));
      setSpicefieldDrafts((current) => ({ ...current, [id]: spicefieldDraftFromRow(result.row) }));
      setSpicefieldResult({ status: "succeeded", title: "Spice Field Saved", message: "Live database controls were updated and will be reapplied after battlegroup restarts. Existing active fields may remain until the game updates them." });
    } catch (error) {
      setSpicefieldResult({ status: "failed", title: "Spice Field Save Failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSpicefieldSavingId("");
    }
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
  function selectedSwapValues() {
    const allowance = memorySwapMode === "low" ? 1 : memorySwapMode === "automatic" ? 2 : Number(memorySwapAllowance);
    const automaticPool = Math.max(0, Math.min(32, allowance * (memorySwap?.worldServerCount || 2) - (memorySwap?.existingSwapGiB || 0)));
    const pool = memorySwapMode === "custom" ? Number(memorySwapPool) : automaticPool;
    const swappiness = memorySwapMode === "custom" ? Number(memorySwapSwappiness) : 10;
    return { allowance, pool, swappiness };
  }
  async function saveMemorySwap(enabled: boolean) {
    const { allowance, pool, swappiness } = selectedSwapValues();
    if (enabled && (!Number.isInteger(allowance) || allowance < 1 || allowance > 16 || !Number.isInteger(pool) || pool < 0 || pool > 32 || !Number.isInteger(swappiness) || swappiness < 0 || swappiness > 100)) {
      setMemorySwapResult({ status: "failed", title: "Memory Swap Not Saved", message: "Use 1-16 GB per running map, a 0-32 GB managed swap file, and swappiness from 0-100." });
      return;
    }
    if (enabled && memorySwap && pool > memorySwap.safeAvailableDiskGiB) {
      setMemorySwapResult({ status: "failed", title: "Memory Swap Not Saved", message: `Only ${memorySwap.safeAvailableDiskGiB} GB is safely available after preserving the host disk reserve.` });
      return;
    }
    const existingSwapIsSufficient = enabled && pool === 0 && (memorySwap?.existingSwapGiB || 0) > 0;
    const enableMessage = existingSwapIsSufficient
      ? `Use the existing ${memorySwap?.existingSwapGiB || 0} GB of host swap with up to ${allowance} GB available to each running map and host swappiness ${swappiness}? No additional managed swap file will be created.`
      : `Enable ${pool} GB of managed swap with up to ${allowance} GB available to each running map and host swappiness ${swappiness}?`;
    const confirmed = await confirmAction(enabled ? enableMessage : "Disable custom swap limits and remove the Console-managed Memory Swap file? Existing host swap remains available through Docker's default behavior.", {
      title: enabled ? "Enable Memory Swap" : "Disable Memory Swap",
      confirmLabel: enabled ? "Enable Memory Swap" : "Disable Memory Swap",
      danger: !enabled,
      details: enabled ? [
        ...(existingSwapIsSufficient ? [{ label: "Existing Host Swap", value: `${memorySwap?.existingSwapGiB || 0} GB` }] : []),
        { label: "Additional Managed Swap", value: pool === 0 ? "Not needed (0 GB)" : `${pool} GB` },
        { label: "Per Running Map", value: `${allowance} GB` },
        { label: "Host Swappiness", value: String(swappiness) },
        { label: "Disk Safety Reserve", value: "At least 25 GB or 10%" }
      ] : undefined
    });
    if (!confirmed) return;
    setMemorySwapSaving(true);
    setMemorySwapResult({ status: "running", title: enabled ? "Enabling Memory Swap..." : "Disabling Memory Swap..." });
    try {
      const response = await mapsApi.setMemorySwap({ enabled, perServerGiB: allowance, poolGiB: pool, swappiness, confirmation: enabled ? "ENABLE MEMORY SWAP" : "DISABLE MEMORY SWAP" });
      const final = await waitForTaskWithUpdates(response.task, (current) => setMemorySwapResult({ status: "running", title: enabled ? "Enabling Memory Swap..." : "Disabling Memory Swap...", details: taskTechnicalDetails(current) }));
      if (final.status !== "succeeded") throw new Error(taskTechnicalDetails(final) || final.errorMessage || "Memory Swap operation failed.");
      await loadMemorySwap();
      await loadLiveMemory();
      setMemorySwapResult({ status: "succeeded", title: enabled ? "Memory Swap Enabled" : "Memory Swap Disabled", message: enabled ? "Running, newly started, and rebalanced game servers now preserve the configured emergency swap allowance." : "Custom swap limits were removed and Docker's default swap behavior was restored. Existing administrator-managed swap was not changed." });
    } catch (error) {
      setMemorySwapResult({ status: "failed", title: "Memory Swap Change Failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setMemorySwapSaving(false);
    }
  }
  async function saveRuntimeSettings() {
    const max = alwaysOnParallelismLimit(runtimeSettings, hostMemoryProtection, hostMemoryReserveMode, hostMemoryReserve);
    const value = Number(startupParallelism);
    if (!Number.isInteger(value) || value < 1 || value > max) {
      setRuntimeSettingsResult({ status: "failed", title: "Startup Setting Not Saved", message: `Use a whole number from 1 to ${max}.` });
      return;
    }
    const reserve = hostMemoryReserveMode === "automatic" ? null : Number(hostMemoryReserve);
    const maxReserve = Math.max(1, (runtimeSettings?.physicalMemoryGiB || 2) - 1);
    if (reserve !== null && (!Number.isInteger(reserve) || reserve < 1 || reserve > maxReserve)) {
      setRuntimeSettingsResult({ status: "failed", title: "Startup Setting Not Saved", message: `Use a physical RAM reserve from 1 to ${maxReserve} GB, or select Automatic.` });
      return;
    }
    const loweringProtection = runtimeSettings ? (
      runtimeSettings.hostMemoryProtectionEnabled && !hostMemoryProtection
      || hostMemoryProtection && reserve !== null && reserve < runtimeSettings.hostMemoryReserveGiB
    ) : false;
    if (loweringProtection && !(await confirmAction("Reduce Always-On host memory protection? This can allow more maps to start, but may make the host slow or unresponsive under memory pressure.", {
      title: "Reduce Host Memory Protection",
      confirmLabel: "Save Protection Settings",
      danger: true,
      details: [
        { label: "Protection", value: hostMemoryProtection ? "Enabled" : "Disabled", tone: hostMemoryProtection ? undefined : "danger" },
        { label: "Physical RAM Reserve", value: hostMemoryProtection ? (reserve === null ? `Automatic (${runtimeSettings?.automaticHostMemoryReserveGiB || 4} GB)` : `${reserve} GB`) : "Not enforced" },
        { label: "Dynamic Maps", value: "Not affected" }
      ]
    }))) return;
    setRuntimeSettingsSaving(true);
    setRuntimeSettingsResult(null);
    try {
      const next = await mapsApi.saveRuntimeSettings({
        alwaysOnStartupParallelism: value,
        hostMemoryProtectionEnabled: hostMemoryProtection,
        hostMemoryReserveGiB: reserve
      });
      setRuntimeSettings(next);
      setStartupParallelism(String(next.alwaysOnStartupParallelism));
      setHostMemoryProtection(next.hostMemoryProtectionEnabled);
      setHostMemoryReserveMode(next.hostMemoryReserveConfigured ? "custom" : "automatic");
      setHostMemoryReserve(String(next.hostMemoryReserveGiB));
      setRuntimeSettingsResult({ status: "succeeded", title: "Startup Settings Saved", message: "Applies to Always-On map startup only. Dynamic maps remain available on demand." });
    } catch (error) {
      setRuntimeSettingsResult({ status: "failed", title: "Startup Setting Failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setRuntimeSettingsSaving(false);
    }
  }
  useEffect(() => {
    run(loadMaps);
    // Settings have their own readiness path. Live map status can take much
    // longer (it probes maps, services, readiness, and memory), but none of
    // that is required to inspect or edit the global UserEngine settings.
    run(loadInitialModifierSettings);
    run(loadLiveMemory);
    run(loadMemoryBalancer);
    run(() => loadMemorySwap());
    run(loadRuntimeSettings);
    // Full reset is right here: this is the mount, so there is nothing pending.
    run(loadSietches);
    run(loadSpicefields);
    void loadCombatState("DeepDesert_1").catch(() => {});
    void loadCombatState("Survival_1").catch(() => {});
    void refreshDeferredRestartPending();
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
      // A task resumed from a previous mount: the persisted record carries no
      // written-partition set, so there is nothing to reconcile against and a
      // full reset is the only honest option.
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
    if (!runtimeSettingsResult || runtimeSettingsResult.status === "running") return;
    const id = window.setTimeout(() => {
      setRuntimeSettingsResult(null);
    }, 5000);
    return () => window.clearTimeout(id);
  }, [runtimeSettingsResult]);
  useEffect(() => {
    if (!memorySwapResult || memorySwapResult.status === "running") return;
    const id = window.setTimeout(() => {
      setMemorySwapResult(null);
    }, 10400);
    return () => window.clearTimeout(id);
  }, [memorySwapResult]);
  useEffect(() => {
    if (!spicefieldResult || spicefieldResult.status === "running") return;
    const id = window.setTimeout(() => {
      setSpicefieldResult(null);
    }, 5000);
    return () => window.clearTimeout(id);
  }, [spicefieldResult]);
  useEffect(() => {
    if (!choamResult || choamResult.status === "running") return;
    const id = window.setTimeout(() => setChoamResult(null), 7000);
    return () => window.clearTimeout(id);
  }, [choamResult]);
  useEffect(() => {
    const refreshLiveMemory = () => {
      if (document.visibilityState !== "visible") return;
      void loadLiveMemory().catch(() => {});
    };
    const id = window.setInterval(refreshLiveMemory, LIVE_MEMORY_REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void loadMemoryBalancer().catch(() => {});
    }, LIVE_MEMORY_REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    if (!modifiersOpen || settingsTab !== "spicefields") return undefined;
    const id = window.setInterval(() => { void loadSpicefields({ preserveDrafts: true }).catch(() => {}); }, 5000);
    return () => window.clearInterval(id);
  }, [modifiersOpen, settingsTab]);
  useEffect(() => {
    if (!modifiersOpen || settingsTab !== "choam") return undefined;
    void loadChoamTerminals().catch(() => undefined);
    const id = window.setInterval(() => { void loadChoamTerminals().catch(() => {}); }, 10000);
    return () => window.clearInterval(id);
  }, [modifiersOpen, settingsTab]);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void refreshMapRuntime().catch(() => {});
      void loadSietches({ preserveDrafts: true }).catch(() => {});
      void loadCombatState("DeepDesert_1").catch(() => {});
      void loadCombatState("Survival_1").catch(() => {});
    }, MAP_RUNTIME_REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    const refreshVisibleMaps = () => {
      if (document.visibilityState !== "visible") return;
      void refreshMapRuntime().catch(() => {});
      void loadLiveMemory().catch(() => {});
      void loadSietches({ preserveDrafts: true }).catch(() => {});
      void loadCombatState("DeepDesert_1").catch(() => {});
      void loadCombatState("Survival_1").catch(() => {});
    };
    window.addEventListener("focus", refreshVisibleMaps);
    document.addEventListener("visibilitychange", refreshVisibleMaps);
    return () => {
      window.removeEventListener("focus", refreshVisibleMaps);
      document.removeEventListener("visibilitychange", refreshVisibleMaps);
    };
  }, []);
  const mapRows = mergeMapAndMemoryRows(mapsText, memoryText, serversText, readinessText);
  const sortedMapRows = sortMapRows(mapRows, mapSort.column, mapSort.direction, liveMemory);
  const serverPartitionRows = parseServerPartitionRows(serversText);
  const readinessStatusByPartitionId = parseReadinessPartitionStatuses(readinessText);
  const partitionStatusById = new globalThis.Map(serverPartitionRows.map((row) => [String(row.partitionId || ""), String(row.status || "")]));
  const mapWarmupActive = mapRows.some((row) => {
    const mode = String(row.mode || "").trim();
    const status = String(row.status || "").trim();
    return /^(Always On|Core Map)$/i.test(mode) && /^(Queued|Starting|Loading|Warming)$/i.test(status);
  });
  useEffect(() => {
    if (!mapWarmupActive) return;
    const refreshWarmup = () => {
      if (document.visibilityState !== "visible") return;
      void refreshMapRuntime().catch(() => {});
      void loadLiveMemory().catch(() => {});
    };
    refreshWarmup();
    const id = window.setInterval(refreshWarmup, 1500);
    return () => window.clearInterval(id);
  }, [mapWarmupActive]);
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
  const dynamicDeepDesertRows = deepDesertPartitionRows.filter((row) => !isPrimaryDeepDesertPartition(row));
  const deepDesertInstanceCount = Math.max(1, Math.min(3, deepDesertPartitionRows.length || 1));
  const thirdDeepDesertRow = deepDesertPartitionRows.find((row) => Number(row.dimension ?? -1) === 2) || null;
  const thirdDeepDesertCombat = thirdDeepDesertRow
    ? combatStateByMap["DeepDesert_1"]?.partitions.find((partition) => partition.partitionId === String(thirdDeepDesertRow.partitionId || "")) || null
    : null;
  const deepDesertThirdRoleKnown = deepDesertInstanceCount !== 3 || thirdDeepDesertCombat?.configuredState === "PVP" || thirdDeepDesertCombat?.configuredState === "PVE";
  const deepDesertThirdRole: "pve" | "pvp" = thirdDeepDesertCombat?.configuredState === "PVP" ? "pvp" : "pve";
  const deepDesertMultiEnabled = deepDesertInstanceCount > 1;
  const deepDesertLayoutConfiguring = mapsResultScope === "maps" && mapsResult?.status === "running" && isDeepDesertLayoutResult(mapsResult);
  useEffect(() => {
    if (!deepDesertLayoutConfiguring) {
      setDeepDesertLayoutDraft(String(deepDesertInstanceCount));
      setDeepDesertThirdRoleDraft(deepDesertThirdRole);
    }
  }, [deepDesertInstanceCount, deepDesertLayoutConfiguring, deepDesertThirdRole]);
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
  const isEngineGlobal = engineMapName === "__global__";
  const engineTargetKey = settingsTargetKey(engineMapName, isEngineGlobal ? "" : enginePartitionId);
  const gameFields = schema ? (effectivePartitionId ? schema.partition : schema.game).filter((field) => field.id !== "partition_pve_enabled" || effectivePartitionId) : [];
  const userGameFields = schema && userGameName ? (!isUserGameGlobal && effectiveUserGamePartitionId ? schema.partition : schema.game).filter((field) => field.id !== "partition_pve_enabled" || (!isUserGameGlobal && effectiveUserGamePartitionId)) : [];
  const gameGroups = groupSettingsFields(userGameFields, true, modifiedSettingsFields(userGameFields, gameValues, gameDraft));
  const activeGameCategory = gameGroups.some(([category]) => category === selectedGameCategory) ? selectedGameCategory : gameGroups[0]?.[0] || "";
  const activeGameFields = activeGameCategory === "All" ? userGameFields : gameGroups.find(([category]) => category === activeGameCategory)?.[1] || [];
  const filteredGameFields = filterSettingsFields(activeGameFields, modifierFilter);
  const filteredSpicefieldRows = filterSpicefieldRows(spicefieldRows, spicefieldFilter);
  const engineSchemaFields = isEngineGlobal
    ? schema?.engine || []
    : enginePartitionId
      ? schema?.partitionEngine || []
      : schema?.mapEngine || [];
  const engineFields = engineSchemaFields.filter((field) => !["server_display_name", "server_login_password", "port", "igw_port"].includes(field.id));
  const engineGroups = groupSettingsFields(engineFields, true, modifiedSettingsFields(engineFields, engineValues, engineDraft));
  const activeEngineCategory = engineGroups.some(([category]) => category === selectedEngineCategory) ? selectedEngineCategory : engineGroups[0]?.[0] || "";
  const activeEngineFields = activeEngineCategory === "All" ? engineFields : engineGroups.find(([category]) => category === activeEngineCategory)?.[1] || [];
  const filteredEngineFields = filterSettingsFields(activeEngineFields, modifierFilter);
  const engineDirty = changedKeys(engineValues, engineDraft, engineFields);
  const gameDirty = changedKeys(gameValues, gameDraft, userGameFields);
  // The download buttons report how many settings each client ini actually carries.
  // Count the generated file rather than the drafts: downloads reflect saved state
  // and include only non-default values explicitly classified as client-required.
  useEffect(() => {
    if (!modifiersOpen || (settingsTab !== "engine" && settingsTab !== "game")) return undefined;
    let cancelled = false;
    const engineMap = isEngineGlobal ? undefined : engineMapName;
    const enginePartition = isEngineGlobal ? undefined : enginePartitionId || undefined;
    const gameMap = !userGameName || isUserGameGlobal ? undefined : userGameName;
    const gamePartition = !userGameName || isUserGameGlobal ? undefined : effectiveUserGamePartitionId;
    const count = (kind: "client-engine" | "client-game", map?: string, partitionId?: string) =>
      mapsApi.rawUserSettings(kind, map, partitionId).then((result) => countIniOverrides(result.content || "")).catch(() => null);
    void Promise.all([count("client-engine", engineMap, enginePartition), count("client-game", gameMap, gamePartition)])
      .then(([engine, game]) => { if (!cancelled) setClientIniCounts({ engine, game }); });
    return () => { cancelled = true; };
  }, [modifiersOpen, settingsTab, engineMapName, enginePartitionId, isEngineGlobal, userGameName, isUserGameGlobal, effectiveUserGamePartitionId, engineValues, gameValues]);
  const currentActiveSietches = String(survivalSietchRows.filter((row) => row.active).length || survivalSietchRows.length || "");
  const activeSietchesDirty = activeSietches !== currentActiveSietches;
  const primarySietchDraft = primarySurvivalSietch ? sietchDrafts[primarySurvivalSietch.partitionId] || { displayName: primarySurvivalSietch.displayName, password: primarySurvivalSietch.password } : null;
  const primarySietchDirty = Boolean(primarySurvivalSietch && primarySietchDraft && (primarySietchDraft.displayName !== primarySurvivalSietch.displayName || sietchPasswordDraftChanged(primarySurvivalSietch, primarySietchDraft, Boolean(sietchPasswordTouched[primarySurvivalSietch.partitionId]))));
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
    if (!isMapSettingsResult(mapsResult) && !isForceDespawnResult(mapsResult) && !isSietchRestartResult(mapsResult)) return;
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
  function selectEngineTarget(next: string) {
    const target = userGameTargets.find((item) => item.key === next);
    if (!target) return;
    setEngineMapName(target.map);
    setEnginePartitionId(target.partitionId);
    setSelectedEngineCategory("");
    void loadSelectedEngineSettings(target.map, target.partitionId || undefined).catch((error) => onError(error instanceof Error ? error.message : String(error)));
  }
  async function refreshDeferredRestartPending() {
    try {
      setDeferredRestartPending(await mapsApi.deferredRestartPending());
    } catch {
      // Leave the previous state -- a transient fetch failure shouldn't
      // flip a real pending indicator off.
    }
  }
  async function restartBattlegroupForDeferredSettings() {
    const gated = await runGatedRestart({ restartGate, label: "battlegroup", dispatch: (opts) => serverApi.restart(opts) });
    if (gated.outcome === "cancelled") return;
    if (gated.outcome === "queued") {
      setMapsResultScope("modifiers");
      setMapsResult({ status: "succeeded", title: "Restart Queued", message: "Battlegroup restart queued — see the Restart Queue panel in Admin Tools." });
      return;
    }
    if (!gated.task) return;
    await waitForTaskWithUpdates(gated.task, () => {});
    await refreshDeferredRestartPending();
  }
  async function saveEngine() {
    const isGlobal = engineMapName === "__global__";
    const scope = isGlobal ? "engine" : enginePartitionId ? "partitionEngine" : "mapEngine";
    const choice = await confirmSettingsRestart("UserEngine", settingsRestartTarget(scope, engineMapName, enginePartitionId));
    if (choice === "cancel") return;
    await runTaskAndRefresh(
      () => mapsApi.saveUserSettings({
        scope,
        map: isGlobal ? undefined : engineMapName,
        partitionId: isGlobal ? undefined : enginePartitionId || undefined,
        values: valuesForDirtyFields(engineValues, engineDraft, engineFields),
        immediate: choice === "immediate",
        deferRestart: choice === "manual"
      }),
      "Saving UserEngine changes",
      "UserEngine Saved",
      { resultScope: "modifiers", restartAcceptedMessage: "Changes saved successfully. The maps are restarting and should be back up soon." }
    );
    await loadSelectedEngineSettings(engineMapName, enginePartitionId || undefined);
    await refreshDeferredRestartPending();
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
    // This save carries the primary sietch's name and password alongside the
    // map settings, so it refuses on the same terms as the sietch Save.
    if (rowName === "Survival_1" && primarySurvivalSietch
      && blockedSietchEdits(survivalSietchRows, sietchDrafts, sietchPasswordTouched, primarySurvivalSietch.partitionId).length) {
      return onError(SIETCH_PARTITION_IDS_UNREADABLE);
    }
    const running = mapRuntimeNeedsLiveApply(row.status);
    const actions: MapsTaskAction[] = [];
    if (modeChanged || memoryChanged) {
      actions.push({
        label: `Saving ${rowName}${partitionId ? ` partition ${partitionId}` : ""} map settings`,
        run: () => mapsApi.saveMapSettings({
          map: rowName,
          partitionId: partitionId || undefined,
          mode: modeDraft,
          memory: memoryCliValue(memory),
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
          memoryUpdates: memoryChanged ? [{ map: rowName, memory: memoryCliValue(memory) }] : [],
          resultTarget: mapResultTarget(rowName),
          // This form only carries the primary sietch's fields, so that is the
          // only partition whose draft the refresh may replace.
          writtenPartitionIds: rowName === "Survival_1" && primarySurvivalSietch
            ? writableSietchEdits(survivalSietchRows, sietchDrafts, sietchPasswordTouched, primarySurvivalSietch.partitionId)
              .map((sietch) => sietch.partitionId)
            : []
        }
      );
    }
  }
  function survivalSietchActions({ includeActive, includePartitions, partitionId }: { includeActive: boolean; includePartitions: boolean; partitionId?: string }) {
    const actions: MapsTaskAction[] = [];
    let activeAction: MapsTaskAction | null = null;
    if (includeActive && activeSietches && activeSietchesDirty) {
      const requestedActive = Number(activeSietches);
      const currentActive = Number(currentActiveSietches) || survivalSietchRows.length;
      if (requestedActive > survivalSietchRows.length) {
        actions.push({
          label: `Creating ${requestedActive} available sietch dimensions`,
          run: () => updateSietches({ action: "set-max", map: "Survival_1", count: requestedActive, confirmation: "UPDATE SIETCHES" })
        });
      }
      activeAction = {
        label: requestedActive < currentActive
          ? `Despawning extra sietch${currentActive - requestedActive === 1 ? "" : "es"} and setting active sietches to ${requestedActive}`
          : `Activating ${requestedActive} sietch${requestedActive === 1 ? "" : "es"}`,
        run: () => updateSietches({ action: "set-active", map: "Survival_1", count: requestedActive, confirmation: "UPDATE SIETCHES" })
      };
    }
    if (includePartitions) {
      // The same helper the post-save refresh uses to decide which drafts it
      // may discard, so the two can never disagree about what was written.
      for (const sietch of writableSietchEdits(survivalSietchRows, sietchDrafts, sietchPasswordTouched, partitionId)) {
        const { draft, nameChanged, passwordChanged } = sietchDraftChanges(sietch, sietchDrafts, sietchPasswordTouched);
        const targetName = sietchTargetDisplayName(sietch, draft.displayName);
        if (nameChanged && passwordChanged) {
          actions.push({
            label: `Saving settings for ${targetName}`,
            run: () => updateSietches({ action: "set-settings", partitionId: sietch.partitionId, displayName: draft.displayName, password: draft.password, confirmation: "UPDATE SIETCHES" })
          });
          continue;
        }
        if (nameChanged) {
          actions.push({
            label: `Saving name for ${targetName}`,
            run: () => updateSietches({ action: "set-display", partitionId: sietch.partitionId, displayName: draft.displayName, confirmation: "UPDATE SIETCHES" })
          });
        }
        if (passwordChanged) {
          actions.push({
            label: `Saving password for ${targetName}`,
            run: () => updateSietches({ action: "set-password", partitionId: sietch.partitionId, password: draft.password, confirmation: "UPDATE SIETCHES" })
          });
        }
      }
    }
    if (activeAction) actions.push(activeAction);
    return actions;
  }
  async function saveSietchSettings(sietch: SietchRow) {
    if (!isSietchWriteTarget(sietch)) return onError(SIETCH_PARTITION_IDS_UNREADABLE);
    const parent = mapRows.find((row) => String(row.map || "") === "Survival_1") || {};
    const draft = sietchDrafts[sietch.partitionId] || { displayName: sietch.displayName, password: sietch.password };
    const originalMemory = memoryInputValue(partitionMemoryValue(memoryText, sietch.partitionId, String(parent.memory || "")));
    const memoryChanged = memory !== originalMemory;
    const running = mapRuntimeNeedsLiveApply(parent.status);
    const actions: MapsTaskAction[] = [];
    if (memoryChanged) {
      actions.push({
        label: `Saving RAM for ${sietch.displayName}`,
        run: () => mapsApi.saveMapSettings({
          map: "Survival_1",
          partitionId: sietch.partitionId,
          memory: memoryCliValue(memory),
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
        memoryUpdates: memoryChanged ? [{ map: "Survival_1", partitionId: sietch.partitionId, memory: memoryCliValue(memory) }] : [],
        resultTarget: mapResultTarget("Survival_1", sietch.partitionId),
        // Derived from sietchActions' own source, so a pending edit on any
        // other row -- including a fallback row the guard refused -- survives
        // this save's refresh.
        writtenPartitionIds: writableSietchEdits(survivalSietchRows, sietchDrafts, sietchPasswordTouched, sietch.partitionId)
          .map((row) => row.partitionId)
      });
    }
  }
  async function restartSietch(sietch: SietchRow, resultTarget: string) {
    if (!sietch.active) return;
    if (!isSietchWriteTarget(sietch)) return onError(SIETCH_PARTITION_IDS_UNREADABLE);
    const label = sietch.displayName || `Partition ${sietch.partitionId}`;
    const gated = await runGatedRestart({
      restartGate,
      label,
      note: "Players in this Sietch will be disconnected. Other Sietches will remain running.",
      details: [
        { label: "Sietch", value: label },
        { label: "Partition", value: sietch.partitionId }
      ],
      target: { partitionId: sietch.partitionId },
      dispatch: (opts) => mapsApi.restartSietch(sietch.partitionId, { ...opts, label })
    });
    if (gated.outcome === "cancelled") return;
    if (gated.outcome === "queued") {
      setMapsResultScope("maps");
      setMapsResultTarget(resultTarget);
      setMapsResult({ status: "succeeded", title: "Restart Queued", message: `${label} restart queued — see the Restart Queue panel in Admin Tools.` });
      return;
    }
    if (!gated.task) return;
    const task = gated.task;
    await runTaskAndRefresh(
      () => Promise.resolve({ task }),
      `Restarting ${label}`,
      `${label} Restarted`,
      { resultTarget }
    );
  }
  async function applyDeepDesertLayout() {
    const instances = Number(deepDesertLayoutDraft) as 1 | 2 | 3;
    if (deepDesertInstanceCount === 3 && !deepDesertThirdRoleKnown) return;
    const thirdRoleChanged = instances === 3 && deepDesertInstanceCount === 3 && deepDesertThirdRoleDraft !== deepDesertThirdRole;
    if (![1, 2, 3].includes(instances) || (instances === deepDesertInstanceCount && !thirdRoleChanged)) return;
    const reducing = instances < deepDesertInstanceCount;
    const layoutName = instances === 1 ? "Single" : instances === 2 ? "Dual" : "Triple";
    if (!(await confirmAction(`Apply the ${layoutName} Deep Desert layout?`, {
      title: "Deep Desert Layout",
      confirmLabel: "Apply Layout",
      danger: reducing,
      details: [
        { label: "Instances", value: `${deepDesertInstanceCount} → ${instances}` },
        ...(instances === 3 ? [{ label: "Third Instance", value: deepDesertThirdRoleDraft === "pvp" ? "PvP" : "PvE" }] : []),
        { label: "Impact", value: "Overland will restart to load the updated Kanly layout. Only newly added, removed, or role-changed Deep Desert instances will be affected; unchanged instances stay online." },
        ...(reducing ? [{ label: "Safety", value: "A database safety backup will be created first." }] : []),
        ...(reducing ? [{ label: "Impact", value: "Removed instances must be empty and will be stopped before removal.", tone: "danger" as const }] : [])
      ]
    }))) return;
    await runTaskAndRefresh(
      () => mapsApi.updateDeepdesert({ instances, thirdRole: deepDesertThirdRoleDraft, confirmation: "UPDATE DEEP DESERT" }),
      `Applying ${layoutName} Deep Desert Layout`,
      `${layoutName} Deep Desert Layout Applied`
    );
    await Promise.all([
      loadCombatState("DeepDesert_1"),
      loadSietches({ preserveDrafts: true })
    ]);
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
        memory: memoryCliValue(memory),
        modeChanged: false,
        memoryChanged,
        running,
        confirmation: "SAVE MAP SETTINGS"
      }),
      `Saving ${deepDesertPartitionName(row)} Settings`,
      "Deep Desert Saved",
      { memoryUpdates: [{ map: "DeepDesert_1", partitionId, memory: memoryCliValue(memory) }], resultTarget: mapResultTarget("DeepDesert_1", partitionId) }
    );
  }
  async function forceDespawnMap(row: Record<string, unknown>) {
    const rowName = String(row.map || "");
    if (!rowName || rowName === "Survival_1" || rowName === "Overmap") return;
    if (rowName === "DeepDesert_1" && deepDesertMultiEnabled) {
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
  async function forceSpawnMap(row: Record<string, unknown>) {
    const rowName = String(row.map || "").trim();
    if (!rowName || rowName === "Survival_1" || rowName === "Overmap") return;
    const target = String(row.partitionId || row.partition || rowName).trim();
    if (!target || !(await confirmAction(`Force spawn ${rowName}?`, { danger: false, confirmLabel: "Force Spawn" }))) return;
    await runTaskAndRefresh(() => mapsApi.spawn(target, "SPAWN MAP"), `Spawning ${rowName}`, `${rowName} Spawned`, { resultTarget: mapResultTarget(rowName) });
  }
  // Restart for a map with no managed service: Survival_1 and the Overmap have
  // their own restart paths, everything else only cycles by despawning and
  // respawning its partition. One task so a failed spawn cannot look like a
  // completed restart, and always by partition id -- a map name would let
  // spawn-server.sh pick the first unassigned partition instead.
  async function respawnMap(row: Record<string, unknown>) {
    const rowName = String(row.map || "").trim();
    if (!rowName || rowName === "Survival_1" || rowName === "Overmap") return;
    const partitionId = String(row.partitionId || row.partition || "").trim();
    if (!partitionId) return;
    const gated = await runGatedRestart({ restartGate, label: rowName, target: { partitionId }, dispatch: (opts) => mapsApi.respawn(partitionId, "RESTART MAP", { ...opts, label: rowName }) });
    if (gated.outcome === "cancelled") return;
    if (gated.outcome === "queued") {
      setMapsResultScope("maps");
      setMapsResultTarget(mapResultTarget(rowName));
      setMapsResult({ status: "succeeded", title: "Restart Queued", message: `${rowName} restart queued — see the Restart Queue panel in Admin Tools.` });
      return;
    }
    if (!gated.task) return;
    const task = gated.task;
    await runTaskAndRefresh(() => Promise.resolve({ task }), `Restarting ${rowName}`, `${rowName} Restarted`, { resultTarget: mapResultTarget(rowName) });
  }
  async function forceDespawnDeepDesertPartition(row: Record<string, unknown>) {
    const partitionId = String(row.partitionId || "").trim();
    if (!partitionId) return;
    const label = deepDesertPartitionName(row);
    if (!(await confirmAction(`Force despawn ${label}?`))) return;
    await runTaskAndRefresh(() => mapsApi.despawn(partitionId, "DESPAWN MAP"), `Despawning ${label}`, `${label} Despawned`, { resultTarget: mapResultTarget("DeepDesert_1", partitionId) });
  }
  async function forceSpawnDeepDesertPartition(row: Record<string, unknown>) {
    const partitionId = String(row.partitionId || "").trim();
    if (!partitionId) return;
    const label = deepDesertPartitionName(row);
    if (!(await confirmAction(`Force spawn ${label}?`, { danger: false, confirmLabel: "Force Spawn" }))) return;
    await runTaskAndRefresh(() => mapsApi.spawn(partitionId, "SPAWN MAP"), `Spawning ${label}`, `${label} Spawned`, { resultTarget: mapResultTarget("DeepDesert_1", partitionId) });
  }
  async function saveGame() {
    if (!userGameName) return;
    const scope = isUserGameGlobal ? "global" : effectiveUserGamePartitionId ? "partition" : "map";
    const map = isUserGameGlobal ? "Survival_1" : userGameName;
    const partitionId = isUserGameGlobal ? undefined : effectiveUserGamePartitionId || undefined;
    const choice = await confirmSettingsRestart("UserGame", settingsRestartTarget(scope, map, partitionId));
    if (choice === "cancel") return;
    await runTaskAndRefresh(
      () => mapsApi.saveUserSettings({ scope, map, partitionId, values: valuesForDirtyFields(gameValues, gameDraft, userGameFields), immediate: choice === "immediate", deferRestart: choice === "manual" }),
      `Saving ${isUserGameGlobal ? "Global" : userGameName} UserGame changes`,
      "UserGame Saved",
      { resultScope: "modifiers", restartAcceptedMessage: "Changes saved successfully. The maps are restarting and should be back up soon." }
    );
    await loadSelectedSettings(userGameName, partitionId);
    await refreshDeferredRestartPending();
  }
  async function saveRaw(kind: "engine" | "game") {
    // Raw UserEngine.ini is always the stack-wide profile; raw UserGame.ini
    // here always saves as the global profile too (scope: "global" below),
    // even though a specific map is selected for editing convenience -- so
    // neither has a map/partition to scope the online check to.
    const choice = await confirmSettingsRestart(kind === "engine" ? "UserEngine" : "UserGame");
    if (choice === "cancel") return;
    if (kind === "engine") {
      await runTaskAndRefresh(
        () => mapsApi.saveRawUserSettings({ scope: "engine", content: rawEngine, immediate: choice === "immediate", deferRestart: choice === "manual" }),
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
      // The raw UserEngine.ini editor is the only console-driven path
      // that can change Port/IGWPort (the structured per-field editor
      // deliberately excludes them -- see engineFields' filter above),
      // so refresh the frontend's cached port values after every raw
      // UserEngine save, not just on next page load. See
      // api/serverPorts.ts's refreshServerPorts() for why this is
      // needed.
      await refreshServerPorts();
    } else {
      await runTaskAndRefresh(
        () => mapsApi.saveRawUserSettings({ scope: "global", map: userGameName || "Survival_1", partitionId: effectiveUserGamePartitionId || undefined, content: rawGame, immediate: choice === "immediate", deferRestart: choice === "manual" }),
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
    await refreshDeferredRestartPending();
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
  async function downloadClientGameIni() {
    const map = !userGameName || isUserGameGlobal ? undefined : userGameName;
    const partitionId = !userGameName || isUserGameGlobal ? undefined : effectiveUserGamePartitionId;
    const result = await mapsApi.rawUserSettings("client-game", map, partitionId);
    downloadText("Game.ini", result.content || "");
  }
  // Stages defaults into the draft only -- nothing reaches the server until Save,
  // so this deliberately carries no restart warning. Covers every field on the tab,
  // not just the ones the active category/filter happens to show.
  async function resetAllToDefaults(kind: "engine" | "game") {
    const fields = kind === "engine" ? engineFields : userGameFields;
    if (!fields.length) return;
    const label = kind === "engine" ? "UserEngine" : "UserGame";
    const targetLabel = kind === "engine"
      ? (isEngineGlobal ? "Global" : `${engineMapName}${enginePartitionId ? ` partition ${enginePartitionId}` : ""}`)
      : (isUserGameGlobal ? "Global" : `${userGameName}${effectiveUserGamePartitionId ? ` partition ${effectiveUserGamePartitionId}` : ""}`);
    const confirmed = await confirmAction(`Sets every ${label} setting for ${targetLabel} back to its default value in the form below.`, {
      title: `Restore ${label} Defaults`,
      confirmLabel: "Restore Defaults",
      cancelLabel: "Cancel",
      danger: false,
      details: [
        { label: "Settings", value: `${fields.length}, including any hidden by your current category or filter` },
        { label: "Target", value: targetLabel }
      ],
      warning: "Nothing is written yet. Press Save to apply, or Discard Changes to undo."
    });
    if (!confirmed) return;
    const defaults = Object.fromEntries(fields.map((field) => [field.id, field.default ?? ""]));
    if (kind === "engine") setEngineDraft((current) => ({ ...current, ...defaults }));
    else setGameDraft((current) => ({ ...current, ...defaults }));
  }
  async function downloadClientEngineIni() {
    const map = isEngineGlobal ? undefined : engineMapName;
    const partitionId = isEngineGlobal ? undefined : enginePartitionId || undefined;
    const result = await mapsApi.rawUserSettings("client-engine", map, partitionId);
    downloadText("Engine.ini", result.content || "");
  }
  async function toggleAdvanced() {
    if (!modifierSettingsLoaded) return;
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
    if (!modifierSettingsLoaded) return;
    const nextOpen = !modifiersOpen;
    setModifiersOpen(nextOpen);
    if (nextOpen) setAdvancedOpen(false);
  }
  const modifiersAvailable = modifierSettingsLoaded;
  const advancedAvailable = modifierSettingsLoaded;
  const runtimeParallelismValue = runtimeSettings?.alwaysOnStartupParallelism ?? 1;
  const runtimeParallelismMax = alwaysOnParallelismLimit(runtimeSettings, hostMemoryProtection, hostMemoryReserveMode, hostMemoryReserve);
  const startupParallelismDirty = Boolean(runtimeSettings) && (Number(startupParallelism) !== runtimeParallelismValue
    || hostMemoryProtection !== runtimeSettings?.hostMemoryProtectionEnabled
    || (hostMemoryReserveMode === "custom") !== Boolean(runtimeSettings?.hostMemoryReserveConfigured)
    || hostMemoryReserveMode === "custom" && Number(hostMemoryReserve) !== runtimeSettings?.hostMemoryReserveGiB);
  return <section className="panel maps-panel">
    <div className="panel-title maps-page-header"><h2>Maps & Sietches</h2><div className="maps-title-actions"><div className="memory-feature-toggle"><InfoTooltip id="memory-balancer-help" label="About Memory Balancer">Memory Balancer redistributes existing physical RAM limits between running map containers. It does not create additional memory.</InfoTooltip><button className={`switch-toggle maps-memory-balancer-toggle ${memoryBalancer?.enabled ? "enabled" : "disabled"}`} disabled={memoryBalancerSaving} onClick={() => run(toggleMemoryBalancer)}><span className="switch-label">Memory Balancer</span><strong className="switch-state">{memoryBalancer?.enabled ? "ON" : "OFF"}</strong></button></div><div className="memory-feature-toggle"><InfoTooltip id="memory-swap-help" label="About Memory Swap">Memory Swap adds controlled per-map emergency swap limits and can create a Console-managed host swap file. Turning it off removes those custom controls and restores Docker's normal swap behavior without changing existing host swap.</InfoTooltip><button className={`switch-toggle maps-memory-swap-toggle ${memorySwap?.enabled ? "enabled" : "disabled"}`} disabled={memorySwapSaving || !memorySwap} onClick={() => run(() => saveMemorySwap(!memorySwap?.enabled))}><span className="switch-label">Memory Swap</span><strong className="switch-state">{memorySwap?.enabled ? "ON" : "OFF"}</strong></button></div><button className="maps-refresh-button" disabled={loading} onClick={() => run(loadMaps)}>{loading ? "Refreshing..." : "Refresh Maps"}</button></div></div>
    {memoryBalancer?.enabled ? <div className={`maps-memory-balancer-status ${memoryBalancer.lastError ? "danger" : ""}`}>{memoryBalancer.lastError ? `Memory Balancer error: ${memoryBalancer.lastError}` : memoryBalancer.lastMessage || "Memory Balancer is monitoring running maps"}</div> : null}
    {memorySwap?.enabled ? <div className="memory-swap-panel">
      <div className="memory-swap-summary">
        <div className="memory-swap-copy"><strong>Emergency Swap Settings</strong><span>{memorySwap.hostPoolActive ? `${memorySwap.poolGiB} GB Managed Swap Active · ${memorySwap.perServerGiB} GB per Running Map` : `Existing Host Swap Active · ${memorySwap.perServerGiB} GB per Running Map`}</span></div>
        <div className="memory-swap-metrics"><span><strong>{memorySwap.physicalMemoryGiB} GB</strong> RAM</span><span><strong>{memorySwap.existingSwapGiB} GB</strong> Existing Swap</span><span><strong>{memorySwap.safeAvailableDiskGiB} GB</strong> Safe Disk Available</span><span><strong>{memorySwap.swappiness}</strong> Host Swappiness</span></div>
      </div>
      <div className={`memory-swap-controls ${memorySwapMode === "custom" ? "custom" : "standard"}`}>
        <label className="memory-swap-mode-field">Mode<select value={memorySwapMode} disabled={memorySwapSaving} onChange={(event) => {
          const mode = event.target.value as "low" | "automatic" | "custom";
          setMemorySwapMode(mode);
          if (mode === "low") setMemorySwapAllowance("1");
          if (mode === "automatic") setMemorySwapAllowance("2");
        }}><option value="automatic">Automatic (2 GB/Server)</option><option value="low">Low (1 GB/Server)</option><option value="custom">Custom</option></select></label>
        {memorySwapMode === "custom" ? <div className="memory-swap-custom-fields">
          <label><span className="memory-swap-label-with-help">Per Running Map<InfoTooltip id="memory-swap-per-map-help" label="About the per-running-map allowance">Each active map or Sietch runs in its own game-server container. This is the maximum emergency swap each one may use; it is not a limit for the whole physical server.</InfoTooltip></span><span className="memory-swap-number-field"><input type="number" min="1" max="16" value={memorySwapAllowance} onChange={(event) => setMemorySwapAllowance(event.target.value)} /><span>GB</span></span></label>
          <label><span className="memory-swap-label-with-help">Managed Swap<InfoTooltip id="memory-swap-pool-help" label="About managed swap">This is the additional host swap file created and managed by the Console. Existing host swap is counted first, so this can be 0 GB when the host already has enough swap.</InfoTooltip></span><span className="memory-swap-number-field"><input type="number" min="0" max="32" value={memorySwapPool} onChange={(event) => setMemorySwapPool(event.target.value)} /><span>GB</span></span></label>
          <label><span className="memory-swap-label-with-help">Swappiness<InfoTooltip id="memory-swap-swappiness-help" label="About host swappiness">Controls how readily Linux considers swapping. This is a host-wide kernel setting, not a per-container value. The default is 10.</InfoTooltip></span><span className="memory-swap-number-field"><input type="number" min="0" max="100" value={memorySwapSwappiness} onChange={(event) => setMemorySwapSwappiness(event.target.value)} /><span>0-100</span></span></label>
        </div> : null}
        <button className="memory-swap-apply" disabled={memorySwapSaving} onClick={() => run(() => saveMemorySwap(true))}>{memorySwapSaving ? "Applying..." : "Apply Swap Settings"}</button>
      </div>
    </div> : null}
    {memorySwapResult ? <div className="maps-result-slot"><HomeTaskResultCard result={memorySwapResult} /></div> : null}
    {mapsResult && mapsResultScope === "maps" && !isDeepDesertLayoutResult(mapsResult) && !isForceDespawnResult(mapsResult) && !isForceSpawnResult(mapsResult) && !isMapSettingsResult(mapsResult) && !isSietchRestartResult(mapsResult) ? <div className="maps-result-slot"><HomeTaskResultCard result={mapsResult} /></div> : null}
    <section className="action-section">
      <h4>Maps Overview</h4>
      <MapModeGuide />
      <div className={`playerAdmin_toggle maps-startup-toggle ${startupSettingsOpen ? "open" : ""}`}>
        <button className="playerAdmin_toggleHeader" aria-label={startupSettingsOpen ? "Collapse Always-On Startup" : "Expand Always-On Startup"} onClick={() => setStartupSettingsOpen(!startupSettingsOpen)}>{startupSettingsOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Always-On Startup</span></button>
        {startupSettingsOpen && <div className="playerAdmin_toggleBody maps-startup-settings">
        <div className="maps-startup-settings-copy">
          <strong>Parallel Map Warmup</strong>
          <p>Controls Always-On map warmup only. Dynamic maps requested by player travel are not blocked by this protection.</p>
          <p>Automatic protection preserves 15% of physical RAM, with a 4 GB minimum. Swap remains emergency headroom rather than normal startup capacity.</p>
          {runtimeSettings?.hostMemorySafetyLimited ? <p className="warning">This host is limited to {runtimeSettings.maxAlwaysOnStartupParallelism} parallel start{runtimeSettings.maxAlwaysOnStartupParallelism === 1 ? "" : "s"} to preserve {runtimeSettings.hostMemoryReserveGiB} GB of its {runtimeSettings.physicalMemoryGiB} GB RAM.</p> : null}
        </div>
        <div className="maps-startup-settings-line">
          <label className="memory-number-field">Parallel Starts<input type="number" min="1" max={runtimeParallelismMax} step="1" value={startupParallelism} onChange={(event) => setStartupParallelism(event.target.value)} /></label>
          <div className="memory-feature-toggle maps-host-memory-protection"><InfoTooltip id="always-on-memory-protection-help" label="About Always-On host memory protection">Prevents automatic Always-On map startup from consuming the physical RAM reserved for the host. Dynamic maps requested by player travel are not subject to this check.</InfoTooltip><button type="button" className={`switch-toggle ${hostMemoryProtection ? "enabled" : "disabled"}`} disabled={runtimeSettingsSaving} onClick={() => setHostMemoryProtection((enabled) => !enabled)}><span className="switch-label">Host Memory Protection</span><strong className="switch-state">{hostMemoryProtection ? "ON" : "OFF"}</strong></button></div>
          {hostMemoryProtection ? <label className="compact-select">Physical RAM Reserve<select value={hostMemoryReserveMode} disabled={runtimeSettingsSaving} onChange={(event) => {
            const mode = event.target.value as "automatic" | "custom";
            setHostMemoryReserveMode(mode);
            if (mode === "automatic") setHostMemoryReserve(String(runtimeSettings?.automaticHostMemoryReserveGiB || 4));
          }}><option value="automatic">Automatic ({runtimeSettings?.automaticHostMemoryReserveGiB || 4} GB)</option><option value="custom">Custom</option></select></label> : null}
          {hostMemoryProtection && hostMemoryReserveMode === "custom" ? <label className="maps-host-memory-reserve">Reserve<span className="maps-host-memory-reserve-input"><input type="number" min="1" max={Math.max(1, (runtimeSettings?.physicalMemoryGiB || 2) - 1)} step="1" value={hostMemoryReserve} onChange={(event) => setHostMemoryReserve(event.target.value)} /><span>GB</span></span></label> : null}
          <button className="maps-startup-settings-save" disabled={!startupParallelismDirty || runtimeSettingsSaving} onClick={() => run(saveRuntimeSettings)}>{runtimeSettingsSaving ? "Saving..." : "Save Settings"}</button>
          {runtimeSettingsResult ? <span className={`inline-task-result map-action-result maps-startup-result result-${inlineTaskResultClass(runtimeSettingsResult)}`}>
            <strong>{runtimeSettingsResult.title}</strong>
            {runtimeSettingsResult.message && <span className="inline-task-message">{runtimeSettingsResult.message}</span>}
          </span> : null}
        </div>
        </div>}
      </div>
      {loading && !mapRows.length && <div className="empty"><span className="loading-dots">Loading Maps</span></div>}
      {!loading && loadError && !mapRows.length && <div className="result-panel"><strong>Map list could not be loaded.</strong><p>{loadError}</p><button onClick={() => run(loadMaps)}>Retry</button></div>}
      {mapRows.length ? <div className="table-wrap maps-overview-table-wrap"><table className="maps-overview-table"><thead><tr>{MAP_SORT_COLUMNS.map(([column, label]) => {
        const active = mapSort.column === column;
        return <th key={column} className="sortable" aria-sort={active ? (mapSort.direction === "asc" ? "ascending" : "descending") : "none"}>
          <button type="button" className="maps-sort-button" onClick={() => setMapSort((current) => current.column === column ? { column, direction: current.direction === "asc" ? "desc" : "asc" } : { column, direction: "asc" })}>
            <span>{label}</span><span className={`sort-indicator ${active ? "active" : ""}`} aria-hidden="true">{active ? (mapSort.direction === "asc" ? "↑" : "↓") : "↕"}</span>
          </button>
        </th>;
      })}<th className="actions-column">Action</th></tr></thead><tbody>{sortedMapRows.map((row) => {
        const rowName = String(row.map || "");
        const isSurvivalRow = rowName === "Survival_1";
        const isDeepDesertRow = /^DeepDesert_/i.test(rowName);
        const requiresFreshProcess = isFreshProcessMap(rowName);
        const isSelected = selectedMapName === rowName && (!(isSurvivalRow || isDeepDesertRow) || !selectedPartitionId);
        const mapSettingsDirty = isSelected && ((modeDraft !== modeInputValue(String(row.mode || "")) && String(row.mode) !== "Core Map") || memory !== memoryInputValue(String(row.memory || "")) || (isSurvivalRow && (activeSietchesDirty || primarySietchDirty)));
        const primaryDraft = primarySurvivalSietch ? sietchDrafts[primarySurvivalSietch.partitionId] || { displayName: primarySurvivalSietch.displayName, password: primarySurvivalSietch.password } : undefined;
        const primaryDeepDesertPartition = isDeepDesertRow ? deepDesertPartitionRows.find(isPrimaryDeepDesertPartition) || deepDesertPartitionRows[0] : undefined;
        const memoryRow = memoryForDisplayedMap(liveMemory, rowName, row, primaryDeepDesertPartition);
        const resolvedPrimaryDeepDesertCombatRow = isDeepDesertRow && primaryDeepDesertPartition
          ? combatStateByMap["DeepDesert_1"]?.partitions.find((p) => p.partitionId === String(primaryDeepDesertPartition.partitionId || "")) || null
          : null;
        const primaryDeepDesertCombatRow = isDeepDesertRow && primaryDeepDesertPartition
          ? deepDesertLayoutCombatRow(primaryDeepDesertPartition, resolvedPrimaryDeepDesertCombatRow, deepDesertLayoutConfiguring, deepDesertThirdRoleDraft)
          : null;
        const primaryDeepDesertName = isDeepDesertRow && primaryDeepDesertPartition
          ? deepDesertPartitionName(primaryDeepDesertPartition, primaryDeepDesertCombatRow)
          : undefined;
        const primarySietchCombatRow = isSurvivalRow && primarySurvivalSietch
          ? combatStateByMap["Survival_1"]?.partitions.find((partition) => partition.partitionId === primarySurvivalSietch.partitionId) || null
          : null;
        const baseStatus = isDeepDesertRow && primaryDeepDesertPartition ? partitionStatusById.get(String(primaryDeepDesertPartition.partitionId || "")) || String(primaryDeepDesertPartition.status || row.status || "Not Available")
          : isSurvivalRow && primarySurvivalSietch ? readinessStatusByPartitionId.get(primarySurvivalSietch.partitionId) || partitionStatusById.get(primarySurvivalSietch.partitionId) || String(row.status || "Not Available") : String(row.status || "Not Available");
        const displayStatus = isSurvivalRow && /^Ready$/i.test(baseStatus) ? "Ready" : statusWithLiveMemory(baseStatus, memoryRow, row.mode);
        const canForceDespawn = isDeepDesertRow && deepDesertMultiEnabled
          ? [displayStatus, ...dynamicDeepDesertRows.map((deepRow) => partitionStatusById.get(String(deepRow.partitionId || "")) || String(deepRow.status || ""))].some((status) => mapCanForceDespawn({ status }))
          : mapCanForceDespawn({ ...row, status: displayStatus });
        const canForceSpawn = !canForceDespawn && mapCanForceSpawn({ ...row, status: displayStatus });
        const deepDesertLayoutResultActive = Boolean(mapsResult && mapsResultScope === "maps" && isDeepDesertLayoutResult(mapsResult));
        const rowTarget = mapResultTarget(rowName);
        const rowTaskQueueState = mapsTaskQueueStates[rowTarget];
        const rowResultActive = mapsResultTarget === rowTarget;
        const rowMapSettingsResultActive = Boolean(rowResultActive && mapsResult && mapsResultScope === "maps" && isMapSettingsResult(mapsResult));
        const rowSietchRestartResultActive = Boolean(rowResultActive && mapsResult && mapsResultScope === "maps" && isSietchRestartResult(mapsResult));
        const rowForceDespawnResultActive = Boolean(rowResultActive && mapsResult && mapsResultScope === "maps" && isForceDespawnResult(mapsResult) && !isDeepDesertLayoutResult(mapsResult));
        const rowForceSpawnResultActive = Boolean(rowResultActive && mapsResult && mapsResultScope === "maps" && isForceSpawnResult(mapsResult));
        return <Fragment key={rowName}><tr><td><MapDisplayName mapId={rowName} instanceName={isDeepDesertRow ? primaryDeepDesertName : undefined} sietch={isSurvivalRow ? primarySurvivalSietch : null} draft={isSurvivalRow ? primaryDraft : undefined} combatState={isDeepDesertRow ? primaryDeepDesertCombatRow?.configuredState || "UNKNOWN" : isSurvivalRow ? primarySietchCombatRow?.configuredState || "UNKNOWN" : undefined} combatRestartRequired={Boolean(isDeepDesertRow ? primaryDeepDesertCombatRow?.configurationDrift : primarySietchCombatRow?.configurationDrift)} /></td><td><MapRuntimeStatus value={displayStatus} detail={row.statusDetail} /></td><td>{String(row.mode || "Not Available")}</td><td><MemoryUsageBar row={memoryRow} fallback={liveMemoryFallback(row)} configuredLimit={row.memory} swapEnabled={Boolean(memorySwap?.enabled)} /></td><td className="actions-column"><button className="stable-action-button" onClick={() => selectMap(row)}>{isSelected ? "Close" : "Edit"}</button></td></tr>
          {isSelected && <tr className="inline-edit-row" key={`${rowName}-edit`}><td colSpan={5}>
            <section className="inline-edit-panel">
              <div className="panel-title"><h4>Edit {isDeepDesertRow && primaryDeepDesertName ? primaryDeepDesertName : rowName}</h4></div>
              <KeyValueGrid items={[["Status", displayStatus], ["Mode", row.mode], ["Memory", row.memory], ["Dimensions", row.dimensions], ...(isSurvivalRow && primarySurvivalSietch ? [["Password", primarySurvivalSietch.passwordSet ? "Set" : "Not Set"] as [string, unknown]] : [])]} />
              {requiresFreshProcess
                ? <p className="muted">Smuggler&apos;s Run stays Dynamic so its instance is retired as soon as it becomes empty and the next visit starts with fresh vehicle permissions.</p>
                : isVehicleDeployMap(rowName) && <p className="muted">Vehicle-deploy Overland maps use Overmap Active instead of Always On by default to avoid vehicle ownership restore races during startup.</p>}
              <div className="action-line">
                <label className="compact-select">Mode<select value={modeDraft} disabled={String(row.mode) === "Core Map"} onChange={(event) => setModeDraft(event.target.value)}><option value="dynamic">Dynamic</option>{!requiresFreshProcess && <option value="always-on">Always On</option>}{!requiresFreshProcess && <option value="overmap-active">Overmap Active</option>}<option value="disabled">Disabled</option></select></label>
                <label className="memory-number-field">Memory<input type="number" min="0.01" step="0.01" inputMode="decimal" value={memory} onChange={(event) => setMemory(event.target.value)} placeholder="8" /></label>
                <span className="unit-label">GB</span>
                {isSurvivalRow && <label className="memory-number-field">Active Sietches<input type="number" min="1" max="64" step="1" value={activeSietches} onChange={(event) => setActiveSietches(event.target.value)} /></label>}
                {isSurvivalRow && primarySurvivalSietch && primarySietchDraft && <label>Name<input value={primarySietchDraft.displayName} placeholder="Default name" onChange={(event) => setSietchDrafts({ ...sietchDrafts, [primarySurvivalSietch.partitionId]: { ...primarySietchDraft, displayName: event.target.value } })} /></label>}
                {isSurvivalRow && primarySurvivalSietch && primarySietchDraft && <label>Password<SecretInput value={sietchPasswordInputValue(primarySurvivalSietch, primarySietchDraft, Boolean(sietchPasswordTouched[primarySurvivalSietch.partitionId]))} placeholder={passwordPlaceholder(sietchHasPassword(primarySurvivalSietch, primarySietchDraft))} onFocus={(event) => { if (!sietchPasswordTouched[primarySurvivalSietch.partitionId] && primarySurvivalSietch.passwordSet) event.currentTarget.select(); }} onChange={(event) => { setSietchPasswordTouched({ ...sietchPasswordTouched, [primarySurvivalSietch.partitionId]: true }); setSietchDrafts({ ...sietchDrafts, [primarySurvivalSietch.partitionId]: { ...primarySietchDraft, password: event.target.value } }); }} /></label>}
                <button disabled={!mapSettingsDirty || Boolean(rowTaskQueueState)} onClick={() => run(() => saveSelectedMapSettings(row))}>{rowTaskQueueState?.phase === "queued" ? "Queued" : rowTaskQueueState?.phase === "running" ? "Saving..." : "Save Map Settings"}</button>
                {/* Survival_1 restarts per Sietch, so scope the badge to the
                    primary partition; every other map only respawns whole, so
                    show everything queued anywhere on it. */}
                {isSurvivalRow && primarySurvivalSietch?.active
                  ? <PendingRefillBadge counts={queueCountsForPartition(Number(primarySurvivalSietch.partitionId))} />
                  : <PendingRefillBadge counts={queueCountsForMap(rowName)} />}
                {isSurvivalRow && primarySurvivalSietch?.active && <button disabled={Boolean(rowTaskQueueState)} title="Restart only this Sietch" onClick={() => run(() => restartSietch(primarySurvivalSietch, rowTarget))}>{rowTaskQueueState?.phase === "queued" ? "Queued" : rowTaskQueueState?.phase === "running" ? "Restarting..." : "Restart"}</button>}
                {/* Only offered while the map is up -- a stopped map wants Force
                    Spawn, not a despawn+spawn cycle. */}
                {rowName !== "Survival_1" && rowName !== "Overmap" && canForceDespawn && String(row.partitionId || row.partition || "").trim()
                  && <button disabled={Boolean(rowTaskQueueState)} title="Restart this map by despawning and respawning its partition" onClick={() => run(() => respawnMap(row))}>{rowTaskQueueState?.phase === "queued" ? "Queued" : rowTaskQueueState?.phase === "running" ? "Restarting..." : "Restart"}</button>}
                {rowName !== "Survival_1" && rowName !== "Overmap" && canForceSpawn && <button title="Force spawn this stopped map" onClick={() => run(() => forceSpawnMap(row))}>Force Spawn</button>}
                {rowName !== "Survival_1" && rowName !== "Overmap" && canForceDespawn && <button className="danger" title="Force despawn this running map" onClick={() => run(() => forceDespawnMap(row))}>Force Despawn</button>}
                {rowMapSettingsResultActive && mapsResult ? <span className={`inline-task-result map-action-result result-${inlineTaskResultClass(mapsResult)}`}>
                  <strong className={mapsResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(mapsResult.title, mapsResult.status === "running")}</strong>
                  {mapsResult.message && <span className="inline-task-message">{formatResultMessage(mapsResult.message)}</span>}
                </span> : null}
                {rowSietchRestartResultActive && mapsResult ? <span className={`inline-task-result map-action-result result-${inlineTaskResultClass(mapsResult)}`}>
                  <strong className={mapsResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(mapsResult.title, mapsResult.status === "running")}</strong>
                  {mapsResult.message && <span className="inline-task-message">{formatResultMessage(mapsResult.message)}</span>}
                </span> : null}
                {rowName !== "Survival_1" && rowName !== "Overmap" && rowForceDespawnResultActive && mapsResult ? <span className={`inline-task-result map-action-result result-${inlineTaskResultClass(mapsResult)}`}>
                  <strong className={mapsResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(mapsResult.title, mapsResult.status === "running")}</strong>
                  {mapsResult.message && <span className="inline-task-message">{formatResultMessage(mapsResult.message)}</span>}
                </span> : null}
                {rowName !== "Survival_1" && rowName !== "Overmap" && rowForceSpawnResultActive && mapsResult ? <span className={`inline-task-result map-action-result result-${inlineTaskResultClass(mapsResult)}`}>
                  <strong className={mapsResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(mapsResult.title, mapsResult.status === "running")}</strong>
                  {mapsResult.message && <span className="inline-task-message">{formatResultMessage(mapsResult.message)}</span>}
                </span> : null}
              </div>
              {isDeepDesert && <section className="action-section nested-action deep-desert-layout-section">
                <div className="deep-desert-layout-heading">
                  <div><strong>Deep Desert Layout</strong><p>Choose how many independent Deep Desert instances this battlegroup provides.</p></div>
                  <span className="badge badge-info">{deepDesertInstanceCount} Active</span>
                </div>
                <div className="deep-desert-layout-controls">
                  <div className="deep-desert-layout-options" role="radiogroup" aria-label="Deep Desert instances">
                    {([1, 2, 3] as const).map((count) => <button type="button" role="radio" aria-checked={deepDesertLayoutDraft === String(count)} className={deepDesertLayoutDraft === String(count) ? "active" : ""} key={count} disabled={deepDesertLayoutConfiguring} onClick={() => setDeepDesertLayoutDraft(String(count))}><strong>{count}</strong><span>{count === 1 ? "Single" : count === 2 ? "Dual" : "Triple"}</span></button>)}
                  </div>
                  {deepDesertLayoutDraft === "3" ? <div className="deep-desert-third-role"><span>{deepDesertInstanceCount === 3 && !deepDesertThirdRoleKnown ? "Detecting Third Role..." : "Third Instance"}</span><div role="radiogroup" aria-label="Third Deep Desert role"><button type="button" role="radio" aria-checked={deepDesertThirdRoleDraft === "pve"} className={deepDesertThirdRoleDraft === "pve" ? "active" : ""} disabled={deepDesertLayoutConfiguring || (deepDesertInstanceCount === 3 && !deepDesertThirdRoleKnown)} onClick={() => setDeepDesertThirdRoleDraft("pve")}>PvE</button><button type="button" role="radio" aria-checked={deepDesertThirdRoleDraft === "pvp"} className={deepDesertThirdRoleDraft === "pvp" ? "active" : ""} disabled={deepDesertLayoutConfiguring || (deepDesertInstanceCount === 3 && !deepDesertThirdRoleKnown)} onClick={() => setDeepDesertThirdRoleDraft("pvp")}>PvP</button></div></div> : null}
                  <button disabled={(deepDesertLayoutDraft === String(deepDesertInstanceCount) && !(deepDesertLayoutDraft === "3" && deepDesertThirdRoleDraft !== deepDesertThirdRole)) || deepDesertLayoutConfiguring || (deepDesertInstanceCount === 3 && !deepDesertThirdRoleKnown)} onClick={() => run(applyDeepDesertLayout)}>{deepDesertLayoutConfiguring ? "Applying..." : "Apply Layout"}</button>
                  {deepDesertLayoutResultActive && mapsResult ? <span className={`inline-task-result result-${inlineTaskResultClass(mapsResult)}`}>
                    <strong className={mapsResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(mapsResult.title, mapsResult.status === "running")}</strong>
                    {mapsResult.message && <span className="inline-task-message">{formatResultMessage(mapsResult.message)}</span>}
                  </span> : null}
                </div>
                <p className="deep-desert-layout-note">The first two instances keep the standard PvE/PvP pair. Triple layouts let you choose the third instance role. A safety backup is created before removing instances.</p>
                {deepText && !deepDesertLayoutResultActive && <MapCommandSummary text={deepText} />}
              </section>}
            </section>
          </td></tr>}
          {isDeepDesertRow && dynamicDeepDesertRows.map((deepRow) => {
            const childSelected = selectedMapName === "DeepDesert_1" && selectedPartitionId === String(deepRow.partitionId || "");
            const deepMemory = partitionMemoryValue(memoryText, String(deepRow.partitionId || ""), String(row.memory || ""), "DeepDesert_1");
            const childMemoryRow = memoryForMap(liveMemory, "DeepDesert_1", { partitionId: deepRow.partitionId });
            const childStatus = statusWithLiveMemory(partitionStatusById.get(String(deepRow.partitionId || "")) || String(deepRow.status || "Not Available"), childMemoryRow, row.mode);
            const childMemoryDirty = childSelected && memory !== memoryInputValue(deepMemory);
            const childCanForceDespawn = mapCanForceDespawn({ ...deepRow, status: childStatus });
            const childCanForceSpawn = !childCanForceDespawn && mapCanForceSpawn({ ...deepRow, status: childStatus });
            const childTarget = mapResultTarget("DeepDesert_1", String(deepRow.partitionId || ""));
            const childTaskQueueState = mapsTaskQueueStates[childTarget];
            const childResultActive = mapsResultTarget === childTarget;
            const childMapSettingsResultActive = Boolean(childResultActive && mapsResult && mapsResultScope === "maps" && isMapSettingsResult(mapsResult));
            const childForceDespawnResultActive = Boolean(childResultActive && mapsResult && mapsResultScope === "maps" && isForceDespawnResult(mapsResult) && !isDeepDesertLayoutResult(mapsResult));
            const childForceSpawnResultActive = Boolean(childResultActive && mapsResult && mapsResultScope === "maps" && isForceSpawnResult(mapsResult));
            const resolvedChildCombatRow = combatStateByMap["DeepDesert_1"]?.partitions.find((p) => p.partitionId === String(deepRow.partitionId || "")) || null;
            const childCombatRow = deepDesertLayoutCombatRow(deepRow, resolvedChildCombatRow, deepDesertLayoutConfiguring, deepDesertThirdRoleDraft);
            const childName = deepDesertPartitionName(deepRow, childCombatRow);
            return <Fragment key={`deepdesert-${String(deepRow.partitionId || deepRow.dimension || "")}`}><tr className="sietch-child-row"><td><MapDisplayName mapId="DeepDesert_1" instanceName={childName} combatState={childCombatRow?.configuredState || "UNKNOWN"} combatRestartRequired={Boolean(childCombatRow?.configurationDrift)} /><span className="sietch-child-meta">Partition {String(deepRow.partitionId || "Unknown")} / Dimension {String(deepRow.dimension || "Unknown")}{childCombatRow?.configurationDrift ? " / Restart required to apply saved PvP-PvE settings" : ""}</span></td><td><MapRuntimeStatus value={childStatus} /></td><td>{String(row.mode || "Dynamic")}</td><td><MemoryUsageBar row={childMemoryRow} fallback={liveMemoryFallback({ ...row, status: childStatus })} configuredLimit={deepMemory} swapEnabled={Boolean(memorySwap?.enabled)} /></td><td className="actions-column"><button className="stable-action-button" onClick={() => selectDeepDesertPartition(deepRow)}>{childSelected ? "Close" : "Edit"}</button></td></tr>
              {childSelected && <tr className="inline-edit-row"><td colSpan={5}><section className="inline-edit-panel">
                <div className="panel-title"><h4>Edit {childName}</h4></div>
                <KeyValueGrid items={[["Name", childName], ["Role", childCombatRow?.configuredState === "PVP" ? "PvP" : childCombatRow?.configuredState === "PVE" ? "PvE" : "Not Available"], ["Partition", deepRow.partitionId], ["Dimension", deepRow.dimension], ["Status", childStatus], ["Memory", deepMemory]]} />
                <div className="action-line">
                  <label className="memory-number-field">Memory<input type="number" min="0.01" step="0.01" inputMode="decimal" value={memory} onChange={(event) => setMemory(event.target.value)} placeholder="8" /></label>
                  <span className="unit-label">GB</span>
                  <button disabled={!childMemoryDirty || Boolean(childTaskQueueState)} onClick={() => run(() => saveDeepDesertPartitionSettings(deepRow))}>{childTaskQueueState?.phase === "queued" ? "Queued" : childTaskQueueState?.phase === "running" ? "Saving..." : "Save"}</button>
                  {childCanForceSpawn && <button title="Force spawn this stopped Deep Desert instance" onClick={() => run(() => forceSpawnDeepDesertPartition(deepRow))}>Force Spawn</button>}
                  {childCanForceDespawn && <button className="danger" title="Force despawn this running Deep Desert instance" onClick={() => run(() => forceDespawnDeepDesertPartition(deepRow))}>Force Despawn</button>}
                  {childMapSettingsResultActive && mapsResult ? <span className={`inline-task-result map-action-result result-${inlineTaskResultClass(mapsResult)}`}>
                    <strong className={mapsResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(mapsResult.title, mapsResult.status === "running")}</strong>
                    {mapsResult.message && <span className="inline-task-message">{formatResultMessage(mapsResult.message)}</span>}
                  </span> : null}
                  {childForceDespawnResultActive && mapsResult ? <span className={`inline-task-result map-action-result result-${inlineTaskResultClass(mapsResult)}`}>
                    <strong className={mapsResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(mapsResult.title, mapsResult.status === "running")}</strong>
                    {mapsResult.message && <span className="inline-task-message">{formatResultMessage(mapsResult.message)}</span>}
                  </span> : null}
                  {childForceSpawnResultActive && mapsResult ? <span className={`inline-task-result map-action-result result-${inlineTaskResultClass(mapsResult)}`}>
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
            const childTarget = mapResultTarget("Survival_1", sietch.partitionId);
            const childTaskQueueState = mapsTaskQueueStates[childTarget];
            const childResultActive = mapsResultTarget === childTarget;
            const childMapSettingsResultActive = Boolean(childResultActive && mapsResult && mapsResultScope === "maps" && isMapSettingsResult(mapsResult));
            const childSietchRestartResultActive = Boolean(childResultActive && mapsResult && mapsResultScope === "maps" && isSietchRestartResult(mapsResult));
            const childCombatRow = combatStateByMap["Survival_1"]?.partitions.find((partition) => partition.partitionId === sietch.partitionId) || null;
            return <Fragment key={`sietch-${sietch.partitionId}`}><tr className="sietch-child-row"><td><MapDisplayName mapId="Survival_1" sietch={sietch} draft={draft} combatState={childCombatRow?.configuredState || "UNKNOWN"} combatRestartRequired={Boolean(childCombatRow?.configurationDrift)} /><span className="sietch-child-meta">Partition {sietch.partitionId} / Dimension {sietch.dimension}{childCombatRow?.configurationDrift ? " / Restart required to apply saved PvP-PvE settings" : ""}</span></td><td><MapRuntimeStatus value={childStatus} /></td><td>Sietch</td><td>{sietch.active ? <MemoryUsageBar row={childMemoryRow} fallback={liveMemoryFallback(row)} configuredLimit={sietchMemory} swapEnabled={Boolean(memorySwap?.enabled)} /> : <span className="muted">Unallocated</span>}</td><td className="actions-column"><button className="stable-action-button" onClick={() => selectSietch(sietch)}>{childSelected ? "Close" : "Edit"}</button></td></tr>
              {childSelected && <tr className="inline-edit-row"><td colSpan={5}><section className="inline-edit-panel">
                <div className="panel-title"><h4>Edit {sietch.displayName}</h4></div>
                <KeyValueGrid items={[["Partition", sietch.partitionId], ["Dimension", sietch.dimension], ["Status", childStatus], ["Memory", sietchMemory], ["Password", sietch.passwordSet ? "Set" : "Not Set"]]} />
                <div className="action-line">
                  <label className="memory-number-field">Memory<input type="number" min="0.01" step="0.01" inputMode="decimal" value={memory} onChange={(event) => setMemory(event.target.value)} placeholder="8" /></label>
                  <span className="unit-label">GB</span>
                  <label>Name<input value={draft.displayName} placeholder="Default name" onChange={(event) => setSietchDrafts({ ...sietchDrafts, [sietch.partitionId]: { ...draft, displayName: event.target.value } })} /></label>
                  <label>Password<SecretInput value={sietchPasswordInputValue(sietch, draft, Boolean(sietchPasswordTouched[sietch.partitionId]))} placeholder={passwordPlaceholder(sietchHasPassword(sietch, draft))} onFocus={(event) => { if (!sietchPasswordTouched[sietch.partitionId] && sietch.passwordSet) event.currentTarget.select(); }} onChange={(event) => { setSietchPasswordTouched({ ...sietchPasswordTouched, [sietch.partitionId]: true }); setSietchDrafts({ ...sietchDrafts, [sietch.partitionId]: { ...draft, password: event.target.value } }); }} /></label>
                  <button disabled={!childDirty || Boolean(childTaskQueueState)} onClick={() => run(() => saveSietchSettings(sietch))}>{childTaskQueueState?.phase === "queued" ? "Queued" : childTaskQueueState?.phase === "running" ? "Saving..." : "Save Sietch Settings"}</button>
                  {sietch.active && <PendingRefillBadge counts={queueCountsForPartition(Number(sietch.partitionId))} />}
                  {sietch.active && <button disabled={Boolean(childTaskQueueState)} title="Restart only this Sietch" onClick={() => run(() => restartSietch(sietch, childTarget))}>{childTaskQueueState?.phase === "queued" ? "Queued" : childTaskQueueState?.phase === "running" ? "Restarting..." : "Restart"}</button>}
                  {childMapSettingsResultActive && mapsResult ? <span className={`inline-task-result map-action-result result-${inlineTaskResultClass(mapsResult)}`}>
                    <strong className={mapsResult.status === "running" ? "loading-dots" : ""}>{formatResultTitle(mapsResult.title, mapsResult.status === "running")}</strong>
                    {mapsResult.message && <span className="inline-task-message">{formatResultMessage(mapsResult.message)}</span>}
                  </span> : null}
                  {childSietchRestartResultActive && mapsResult ? <span className={`inline-task-result map-action-result result-${inlineTaskResultClass(mapsResult)}`}>
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
    {(modifierDirtySummary || (mapsResult && mapsResultScope === "modifiers") || deferredRestartPending.pending) && <div className="maps-modifier-status-slot">
      {modifierDirtySummary && <p className="dirty-note">Unsaved changes: {modifierDirtySummary}</p>}
      {deferredRestartPending.pending && <div className="maps-deferred-restart-banner">
        <span className="badge badge-warn">Pending Restart</span>
        <span className="muted">{deferredRestartPending.label || "Settings"} saved — apply at the next battlegroup restart.</span>
        <button className="secondary" onClick={() => run(restartBattlegroupForDeferredSettings)}>Restart Battlegroup</button>
      </div>}
      {mapsResult && mapsResultScope === "modifiers" ? <div className="maps-result-slot"><HomeTaskResultCard result={mapsResult} /></div> : null}
    </div>}
    <div className={`playerAdmin_toggle maps-modifiers-toggle ${modifiersOpen && modifiersAvailable ? "open" : ""}`}>
      <button className="playerAdmin_toggleHeader" disabled={!modifiersAvailable} title={modifiersAvailable ? undefined : "Modifier settings are loading independently of live map status."} aria-label={modifiersOpen && modifiersAvailable ? "Collapse Interactive Modifiers" : "Expand Interactive Modifiers"} onClick={toggleModifiers}>{modifiersOpen && modifiersAvailable ? <ChevronUp size={18} /> : <ChevronDown size={18} />}<span>Interactive Modifiers</span></button>
      {modifiersOpen && modifiersAvailable && <div className="playerAdmin_toggleBody">
      <div className="settings-tabs-row">
        <div className="settings-tabs" role="tablist" aria-label="Interactive modifier editor">
          <button className={settingsTab === "engine" ? "active" : ""} role="tab" aria-selected={settingsTab === "engine"} onClick={() => setSettingsTab("engine")}>UserEngine</button>
          <button className={settingsTab === "game" ? "active" : ""} role="tab" aria-selected={settingsTab === "game"} onClick={() => setSettingsTab("game")}>UserGame</button>
          <button className={settingsTab === "spicefields" ? "active" : ""} role="tab" aria-selected={settingsTab === "spicefields"} onClick={() => { setSettingsTab("spicefields"); void loadSpicefields({ preserveDrafts: true }).catch(() => undefined); }}>Spice Fields</button>
          <button className={settingsTab === "choam" ? "active" : ""} role="tab" aria-selected={settingsTab === "choam"} onClick={() => { setSettingsTab("choam"); void loadChoamTerminals().catch(() => undefined); }}>CHOAM Terminals</button>
        </div>
        {(settingsTab === "engine" || settingsTab === "game") && <div className="settings-download-buttons">
          <InfoTooltip id="client-ini-download-help" label="About Client Configuration Downloads">Some modifiers must match on the server and each player&apos;s client. Save changes first, then download the files, close Dune: Awakening, back up the existing client INIs, and merge the generated sections into Saved/Config/WindowsClient. Only non-default settings known to require client configuration are included.</InfoTooltip>
          <button className="settings-download-button" type="button" title={!isEngineGlobal ? "Download client Engine.ini for the selected UserEngine target" : "Download client Engine.ini for global UserEngine values"} onClick={() => run(downloadClientEngineIni)}><Download size={16} /> Engine.ini{clientIniCounts.engine === null ? "" : ` (${clientIniCounts.engine})`}</button>
          <button className="settings-download-button" type="button" title={userGameName && !isUserGameGlobal ? "Download client Game.ini for the selected UserGame target" : "Download client Game.ini for global UserGame values"} onClick={() => run(downloadClientGameIni)}><Download size={16} /> Game.ini{clientIniCounts.game === null ? "" : ` (${clientIniCounts.game})`}</button>
        </div>}
      </div>
      {settingsTab === "engine" ? <>
        <div className="settings-selector-row">
          <label className="compact-select">Target<select value={engineTargetKey} onChange={(event) => selectEngineTarget(event.target.value)}>{userGameTargets.map((target) => <option key={target.key} value={target.key}>{target.label}</option>)}</select></label>
          <label className="compact-select">Modifier Category<select disabled={!engineGroups.length} value={activeEngineCategory} onChange={(event) => setSelectedEngineCategory(event.target.value)}>{engineGroups.length ? engineGroups.map(([category, fields]) => <option key={category} value={category}>{category} ({fields.length})</option>) : <option value="">--</option>}</select></label>
          <div className="modifier-search-tools">
            <input className="modifier-filter-input" aria-label="Filter Modifiers" value={modifierFilter} onChange={(event) => setModifierFilter(event.target.value)} placeholder="Filter modifiers" />
            <div className="catalog-view-toggle" aria-label="Modifier view">
              <button type="button" className={modifierViewMode === "grid" ? "active" : ""} title="Grid view" aria-label="Grid view" aria-pressed={modifierViewMode === "grid"} onClick={() => setModifierViewMode("grid")}><Grid2X2 size={17} /></button>
              <button type="button" className={modifierViewMode === "list" ? "active" : ""} title="List view" aria-label="List view" aria-pressed={modifierViewMode === "list"} onClick={() => setModifierViewMode("list")}><List size={18} /></button>
            </div>
          </div>
        </div>
        <SettingsCardGrid fields={filteredEngineFields} values={engineDraft} onChange={(id, value) => setEngineDraft({ ...engineDraft, [id]: value })} viewMode={modifierViewMode} emptyMessage={modifierEmptyMessage(!!schema, engineFields.length, modifierFilter, activeEngineCategory)} />
        <div className="action-row"><button disabled={!engineDirty.length} onClick={() => run(saveEngine)}>Save</button><button disabled={!engineDirty.length} onClick={() => setEngineDraft(engineValues)}>Discard Changes</button><button className="settings-reset-all-button" disabled={!engineFields.length} title="Set every UserEngine setting on this tab back to its default value" onClick={() => run(() => resetAllToDefaults("engine"))}>Restore Defaults</button></div>
      </> : settingsTab === "game" ? <>
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
        {userGameName && <SettingsCardGrid fields={filteredGameFields} values={gameDraft} onChange={(id, value) => setGameDraft({ ...gameDraft, [id]: value })} viewMode={modifierViewMode} emptyMessage={modifierEmptyMessage(!!schema, userGameFields.length, modifierFilter, activeGameCategory)} />}
        <div className="action-row"><button disabled={!gameDirty.length || !userGameName} onClick={() => run(saveGame)}>Save</button><button disabled={!gameDirty.length} onClick={() => setGameDraft(gameValues)}>Discard Changes</button><button className="settings-reset-all-button" disabled={!userGameName || !userGameFields.length} title="Set every UserGame setting on this tab back to its default value" onClick={() => run(() => resetAllToDefaults("game"))}>Restore Defaults</button></div>
      </> : settingsTab === "spicefields" ? <>
        <SpicefieldsEditor
          rows={filteredSpicefieldRows}
          allRows={spicefieldRows}
          drafts={spicefieldDrafts}
          filter={spicefieldFilter}
          savingId={spicefieldSavingId}
          result={spicefieldResult}
          onFilterChange={setSpicefieldFilter}
          onRefresh={() => run(() => loadSpicefields({ preserveDrafts: true }))}
          onDraftChange={(id, draft) => setSpicefieldDrafts({ ...spicefieldDrafts, [id]: draft })}
          onDiscard={(row) => setSpicefieldDrafts({ ...spicefieldDrafts, [String(row.spicefield_type_id)]: spicefieldDraftFromRow(row) })}
          onSave={(row) => run(() => saveSpicefield(row))}
        />
      </> : <>
        <ChoamTerminalsEditor
          overview={choamOverview}
          savingKey={choamSavingKey}
          result={choamResult}
          onInstall={(center) => run(() => installChoamCenter(center))}
          onRemove={(center) => run(() => removeChoamCenter(center))}
        />
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

export function SpicefieldsEditor({
  rows,
  allRows,
  drafts,
  filter,
  savingId,
  result,
  onFilterChange,
  onRefresh,
  onDraftChange,
  onDiscard,
  onSave
}: {
  rows: SpicefieldTypeRow[];
  allRows: SpicefieldTypeRow[];
  drafts: Record<string, SpicefieldDraft>;
  filter: string;
  savingId: string;
  result: HomeTaskResult | null;
  onFilterChange: (value: string) => void;
  onRefresh: () => void;
  onDraftChange: (id: string, draft: SpicefieldDraft) => void;
  onDiscard: (row: SpicefieldTypeRow) => void;
  onSave: (row: SpicefieldTypeRow) => void;
}) {
  return <section className="spicefields-editor">
    <div className="settings-selector-row spicefields-toolbar">
      <label className="wide-field">Filter<input value={filter} onChange={(event) => onFilterChange(event.target.value)} placeholder="Filter by map, type, or dimension" /></label>
      <button className="spicefields-refresh-button" onClick={onRefresh}>Refresh</button>
    </div>
    {result && <div className="maps-result-slot"><HomeTaskResultCard result={result} /></div>}
    {!allRows.length ? <div className="empty">Spice field controls are unavailable for this database schema.</div> : null}
    {allRows.length && !rows.length ? <div className="empty">No spice fields match this filter.</div> : null}
    {rows.length ? <div className="settings-list-wrap spicefields-table-wrap"><table className="settings-list-table spicefields-table">
      <thead><tr>
        <th scope="col">Map</th>
        <th scope="col">Type</th>
        <th scope="col">Dimension</th>
        <th scope="col">Live</th>
        <th scope="col">Max Active</th>
        <th scope="col">Max Primed</th>
        <th scope="col">Spawning</th>
        <th scope="col">Weight</th>
        <th scope="col">Actions</th>
      </tr></thead>
      <tbody>{rows.map((row) => {
        const id = String(row.spicefield_type_id);
        const draft = drafts[id] || spicefieldDraftFromRow(row);
        const dirty = spicefieldDraftDirty(row, draft);
        const saving = savingId === id;
        return <tr key={id}>
          <td data-label="Map"><strong>{row.map_name}</strong><small>ID {row.spicefield_type_id}</small></td>
          <td data-label="Type">{row.field_type}</td>
          <td data-label="Dimension">{row.dimension_index}</td>
          <td data-label="Live"><span>{row.current_globally_active ?? 0} active</span><small>{row.current_globally_primed ?? 0} primed</small></td>
          <td data-label="Max Active"><input aria-label={`${row.map_name} Max Active`} type="number" min="0" step="1" value={draft.maxActive} onChange={(event) => onDraftChange(id, { ...draft, maxActive: event.target.value })} /></td>
          <td data-label="Max Primed"><input aria-label={`${row.map_name} Max Primed`} type="number" min="0" step="1" value={draft.maxPrimed} onChange={(event) => onDraftChange(id, { ...draft, maxPrimed: event.target.value })} /></td>
          <td data-label="Spawning"><select aria-label={`${row.map_name} Spawning`} value={draft.spawningActive ? "true" : "false"} onChange={(event) => onDraftChange(id, { ...draft, spawningActive: event.target.value === "true" })}><option value="true">Enabled</option><option value="false">Disabled</option></select></td>
          <td data-label="Weight"><input aria-label={`${row.map_name} Weight`} type="number" min="0" step="any" value={draft.spawnWeight} onChange={(event) => onDraftChange(id, { ...draft, spawnWeight: event.target.value })} /></td>
          <td data-label="Actions"><div className="action-row spicefield-row-actions"><button disabled={!dirty || saving} onClick={() => onSave(row)}>{saving ? "Saving..." : "Save"}</button><button disabled={!dirty || saving} onClick={() => onDiscard(row)}>Discard</button></div></td>
        </tr>;
      })}</tbody>
    </table></div> : null}
  </section>;
}

function ChoamTerminalsEditor({
  overview,
  savingKey,
  result,
  onInstall,
  onRemove
}: {
  overview: ChoamTerminalOverview | null;
  savingKey: string;
  result: HomeTaskResult | null;
  onInstall: (center: ChoamTradeCenter) => void;
  onRemove: (center: ChoamTradeCenter) => void;
}) {
  const activeSietches = overview?.sietches.length || 0;
  return <section className="choam-terminals-editor">
    <div className="choam-terminals-toolbar">
      <p>Restart the battlegroup after installing or removing terminals for the changes to appear in-game.</p>
    </div>
    {result && <div className="maps-result-slot"><HomeTaskResultCard result={result} /></div>}
    {!overview ? <div className="empty">CHOAM terminal state is loading.</div> : null}
    {overview && !overview.supported ? <div className="empty">{overview.reason || "CHOAM terminal placement is unavailable."}</div> : null}
    {overview?.supported ? <div className="settings-list-wrap choam-terminals-table-wrap"><table className="settings-list-table choam-terminals-table">
      <thead><tr><th>Trade Post</th><th>Coverage</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>{overview.tradeCenters.map((center) => {
        const placements = overview.placements.filter((entry) => entry.trade_center_key === center.key && entry.actor_present);
        const installed = placements.length;
        const complete = activeSietches > 0 && installed >= activeSietches;
        const saving = savingKey === center.key;
        return <tr key={center.key}>
          <td><strong>{center.name}</strong></td>
          <td className="choam-terminal-coverage">{installed} / {activeSietches} Sietches</td>
          <td className="choam-terminal-status">
            <span className={`badge ${complete ? "badge-pass" : installed ? "badge-warn" : "badge-info"}`}>
              {complete ? "Installed" : installed ? "Partial" : "Not Installed"}
            </span>
          </td>
          <td className="choam-terminal-actions-cell"><div className="action-row choam-terminal-actions">
            {installed
              ? <button className="danger" disabled={saving} onClick={() => onRemove(center)}>{saving ? "Working..." : "Remove"}</button>
              : <button disabled={saving} onClick={() => onInstall(center)}>{saving ? "Working..." : "Install"}</button>}
          </div></td>
        </tr>;
      })}</tbody>
    </table></div> : null}
  </section>;
}

function SettingsCardGrid({ fields, values, onChange, viewMode = "grid", emptyMessage = "Select a modifier category." }: { fields: UserSettingField[]; values: Record<string, string>; onChange: (id: string, value: string) => void; viewMode?: "grid" | "list"; emptyMessage?: string }) {
  if (!fields.length) return <div className="empty">{emptyMessage}</div>;
  if (viewMode === "list") {
    return <div className="settings-list-wrap"><table className="settings-list-table"><thead><tr><th>Modifier</th><th>Setting Key</th><th>Value</th></tr></thead><tbody>{fields.map((field) => {
      const value = values[field.id] ?? field.default ?? "";
      const modified = isModifiedFromDefault(field, value);
      return <Fragment key={field.id}>
        {(field.clientFile || modified) && <tr className="settings-list-badge-row"><td colSpan={3}>
          {field.clientFile && <span className="badge badge-info settings-list-badge" title={`Also requires updating the client's ${field.clientFile}.`}>Client &quot;{field.clientFile}&quot;</span>}
          {modified && <ModifiedBadge field={field} label={friendlySettingLabel(field.id, field.key || field.id, field.label)} onReset={() => onChange(field.id, field.default ?? "")} />}
        </td></tr>}
        <tr>
          <td><strong>{friendlySettingLabel(field.id, field.key || field.id, field.label)}</strong><small>{fieldCategory(field)}</small></td>
          <td>{field.key || field.id}</td>
          <td><SettingInput field={field} value={value} inputId={`setting-list-${field.scope}-${field.id}`} onChange={(nextValue) => onChange(field.id, nextValue)} /></td>
        </tr>
        {field.description && <tr className="settings-list-description-row"><td colSpan={3}><span className="settings-field-description"><Info size={14} aria-hidden="true" /><span className="settings-field-description-text">{field.description}</span></span></td></tr>}
      </Fragment>;
    })}</tbody></table></div>;
  }
  return <div className="settings-grid settings-grid-roomy">{fields.map((field) => <SettingControl key={field.id} field={field} value={values[field.id] ?? field.default ?? ""} onChange={(value) => onChange(field.id, value)} />)}</div>;
}

function ModifiedBadge({ field, label, onReset }: { field: UserSettingField; label: string; onReset: () => void }) {
  const defaultLabel = field.default || "empty";
  return <span className="badge warn settings-modified-badge" title={`Changed from the default (${defaultLabel}).`}>
    Modified
    <button type="button" className="settings-reset-button" title={`Reset to default (${defaultLabel})`} aria-label={`Reset ${label} to its default value`} onClick={(event) => { event.preventDefault(); onReset(); }}><RotateCcw size={12} aria-hidden="true" /></button>
  </span>;
}

function SettingControl({ field, value, onChange }: { field: UserSettingField; value: string; onChange: (value: string) => void }) {
  const label = friendlySettingLabel(field.id, field.key || field.id, field.label);
  const inputId = `setting-${field.scope}-${field.id}`;
  const modified = isModifiedFromDefault(field, value);
  return <label className="settings-field" htmlFor={inputId}>
    <div className="settings-field-heading">
      {(field.clientFile || modified) && <span className="settings-field-badges">
        {field.clientFile && <span className="badge badge-info" title={`Also requires updating the client's ${field.clientFile}.`}>Client &quot;{field.clientFile}&quot;</span>}
        {modified && <ModifiedBadge field={field} label={label} onReset={() => onChange(field.default ?? "")} />}
      </span>}
      <strong>{label}</strong>
      <small>{field.key || field.id}</small>
    </div>
    {field.description && <span className="settings-field-description"><Info size={14} aria-hidden="true" /><span className="settings-field-description-text">{field.description}</span></span>}
    <SettingInput field={field} value={value} inputId={inputId} onChange={onChange} />
  </label>;
}

function SettingInput({ field, value, inputId, onChange }: { field: UserSettingField; value: string; inputId: string; onChange: (value: string) => void }) {
  return field.type === "boolean"
    ? <select id={inputId} value={normalizeBooleanText(value)} onChange={(event) => onChange(event.target.value)}><option value="True">True</option><option value="False">False</option></select>
    : field.type === "integer" || field.type === "number"
      ? <input id={inputId} type="number" step={field.type === "integer" ? "1" : "any"} min={field.minimum ?? undefined} max={field.maximum ?? undefined} value={value} onChange={(event) => onChange(event.target.value)} />
      : String(value).length > 72 || value.includes("(")
        ? <textarea id={inputId} rows={3} value={value} onChange={(event) => onChange(event.target.value)} />
        : <input id={inputId} value={value} onChange={(event) => onChange(event.target.value)} />;
}

export function MemoryUsageBar({ row, fallback, configuredLimit, swapEnabled = false }: { row: LiveMapMemoryRow | null; fallback: string; configuredLimit?: unknown; swapEnabled?: boolean }) {
  if (!row) return <span className="muted">{fallback}</span>;
  const configuredLimitBytes = memoryValueToBytes(String(configuredLimit || ""));
  const limitBytes = configuredLimitBytes || row.limitBytes;
  const showSwap = swapEnabled && row.swapSupported === true;
  const swapUsedBytes = showSwap ? Math.max(0, Number(row.swapUsedBytes) || 0) : 0;
  const swapLimitBytes = showSwap ? Math.max(0, Number(row.swapLimitBytes) || 0) : 0;
  const combinedLimitBytes = limitBytes + swapLimitBytes;
  const measuredUsedBytes = row.usedBytes + swapUsedBytes;
  const percentDenominator = showSwap && combinedLimitBytes > 0 ? combinedLimitBytes : limitBytes;
  const percent = percentDenominator > 0 ? Math.max(0, Math.min(100, (measuredUsedBytes / percentDenominator) * 100)) : Math.max(0, Math.min(100, Number(row.percent) || 0));
  const ramCapacityWidth = showSwap && combinedLimitBytes > 0 ? (limitBytes / combinedLimitBytes) * 100 : 100;
  const swapCapacityWidth = showSwap && combinedLimitBytes > 0 ? (swapLimitBytes / combinedLimitBytes) * 100 : 0;
  const ramFillWidth = limitBytes > 0 ? Math.max(0, Math.min(100, (row.usedBytes / limitBytes) * 100)) : percent;
  const swapFillWidth = swapLimitBytes > 0 ? Math.max(0, Math.min(100, (swapUsedBytes / swapLimitBytes) * 100)) : 0;
  const title = showSwap
    ? `${formatBytes(row.usedBytes)} RAM used of ${formatBytes(limitBytes)}; ${formatBytes(swapUsedBytes)} swap used of ${formatBytes(swapLimitBytes)}; ${formatBytes(combinedLimitBytes)} combined allowance.`
    : `${formatBytes(row.usedBytes)} RAM used of ${formatBytes(limitBytes)}.`;
  return <div className={`memory-usage-cell${showSwap ? " swap-active" : ""}`} title={title}>
    <div className="memory-usage-bar" role="progressbar" aria-label={showSwap ? "Combined RAM and swap usage" : "RAM usage"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Number(percent.toFixed(1))}>
      <span className="memory-usage-zone memory-usage-ram-zone" style={{ width: `${ramCapacityWidth}%` }}><span className="memory-usage-ram" style={{ width: `${ramFillWidth}%` }} /></span>
      {showSwap && swapCapacityWidth > 0 ? <span className="memory-usage-zone memory-usage-swap-zone" style={{ width: `${swapCapacityWidth}%` }}><span className="memory-usage-swap" style={{ width: `${swapFillWidth}%` }} /></span> : null}
    </div>
    <strong>{percent.toFixed(1)}%</strong>
    {showSwap
      ? <span className="memory-usage-detail"><span>{formatGiB(row.usedBytes)} / {formatGiB(limitBytes)} RAM</span><span className="memory-swap-used">+ {formatGiB(swapLimitBytes)} Swap</span><span className="memory-swap-consumed">({formatGiB(swapUsedBytes)} Used)</span></span>
      : <span className="memory-usage-detail">{formatBytes(row.usedBytes)} / {formatBytes(limitBytes)}</span>}
  </div>;
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

export function MapDisplayName({ mapId, instanceName, sietch, draft, combatState, combatRestartRequired = false }: { mapId: string; instanceName?: string; sietch?: SietchRow | null; draft?: { password: string }; combatState?: PartitionCombatStateRow["configuredState"]; combatRestartRequired?: boolean }) {
  const passwordSet = sietchHasPassword(sietch, draft);
  const friendlyName = friendlyMapName(mapId);
  const instanceLabel = String(instanceName || sietch?.displayName || "").trim();
  const rawLabel = instanceLabel ? `${mapId}: ${instanceLabel}` : mapId;
  const combatBadge = combatState ? <CombatStatusBadge state={combatState} restartRequired={combatRestartRequired} /> : null;
  return <span className="map-display-name">
    <span className="map-display-name-primary">{passwordSet && <Lock size={15} aria-label="Password set" />}<strong>{friendlyName}</strong>{!hasFriendlyMapName(mapId) ? combatBadge : null}</span>
    {hasFriendlyMapName(mapId) && <span className="map-display-name-details"><small className="map-display-name-id">{rawLabel}</small>{combatBadge}</span>}
  </span>;
}

export function CombatStatusBadge({ state, restartRequired = false }: { state: PartitionCombatStateRow["configuredState"]; restartRequired?: boolean }) {
  const normalized = state === "PVP" || state === "PVE" || state === "CONFLICT" ? state : "UNKNOWN";
  const label = normalized === "PVP" ? "PvP" : normalized === "PVE" ? "PvE" : normalized === "CONFLICT" ? "Conflict" : "Unknown";
  const detail = normalized === "UNKNOWN"
    ? "The effective combat setting could not be determined."
    : normalized === "CONFLICT"
      ? "The effective PvP/PvE settings conflict."
      : `Effective combat setting: ${label}.`;
  const title = restartRequired ? `${detail} Restart required to apply the saved setting.` : detail;
  return <span className={`combat-status-badge combat-status-${normalized.toLowerCase()}`} title={title} aria-label={`${label} combat status`}>{label}</span>;
}

export function MapRuntimeStatus({ value, detail }: { value: unknown; detail?: unknown }) {
  const label = String(value || "Not Available");
  const explanation = String(detail || mapRuntimeStatusDetail(label));
  return <span className="map-runtime-status" title={explanation}>
    <StatusPill value={label} />
    {detail ? <small className="map-runtime-status-detail">{String(detail)}</small> : null}
  </span>;
}

function mapRuntimeStatusDetail(value: string) {
  if (/^Ready$/i.test(value)) return "Travel-ready: the map has a server ID, endpoint, and farm readiness.";
  if (/^Loading$/i.test(value)) return "The container/server is up, but travel should wait until farm readiness is true.";
  if (/^Starting$/i.test(value)) return "A server is assigned, but it has not reported alive yet.";
  if (/^Queued$/i.test(value)) return "This map is configured Always On and is waiting for the autoscaler to start it.";
  if (/^Not Running$/i.test(value)) return "No active server is assigned for this map.";
  if (/^Configuring$/i.test(value)) return "Map configuration is being updated.";
  return "Runtime state from map registration and readiness checks.";
}

function passwordPlaceholder(passwordSet: boolean) {
  return "Empty for none";
}

function groupSettingsFields(fields: UserSettingField[], includeAll = false, modified?: UserSettingField[]): [string, UserSettingField[]][] {
  const grouped = new globalThis.Map<string, UserSettingField[]>();
  for (const field of fields) {
    const category = fieldCategory(field);
    grouped.set(category, [...(grouped.get(category) || []), field]);
  }
  const groups = [...grouped.entries()];
  if (!includeAll || !fields.length) return groups;
  // "Modified" stays in the list at (0) rather than vanishing, so selecting it does
  // not bounce the admin back to "All" the moment they reset the last override.
  const leading: [string, UserSettingField[]][] = modified ? [["All", fields], [MODIFIED_CATEGORY, modified]] : [["All", fields]];
  return [...leading, ...groups];
}

function filterSettingsFields(fields: UserSettingField[], query: string) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return fields;
  return fields.filter((field) => {
    const label = friendlySettingLabel(field.id, field.key || field.id, field.label);
    const category = fieldCategory(field);
    const haystack = `${label} ${field.id} ${field.key || ""} ${field.section || ""} ${category}`.toLowerCase();
    return haystack.includes(needle);
  });
}

// "Select a modifier category." is only correct once the schema has arrived and
// actually has fields -- otherwise it points the admin at an empty dropdown.
export function modifierEmptyMessage(schemaLoaded: boolean, fieldCount: number, query: string, category = "") {
  if (!schemaLoaded) return "Settings schema is loading.";
  if (!fieldCount) return "No modifiers available for this target.";
  if (String(query || "").trim()) return "No modifiers match your filter.";
  if (category === MODIFIED_CATEGORY) return "Every setting is at its default value.";
  return "Select a modifier category.";
}

function filterSpicefieldRows(rows: SpicefieldTypeRow[], query: string) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => `${row.map_name} ${row.field_type} dimension ${row.dimension_index} ${row.spicefield_type_id}`.toLowerCase().includes(needle));
}

function spicefieldDraftFromRow(row: SpicefieldTypeRow): SpicefieldDraft {
  return {
    maxActive: String(row.max_globally_active ?? 0),
    maxPrimed: String(row.max_globally_primed ?? 0),
    spawningActive: row.is_spawning_active !== false,
    spawnWeight: String(row.global_spawn_weight ?? 0)
  };
}

function spicefieldDraftDirty(row: SpicefieldTypeRow, draft: SpicefieldDraft) {
  return String(row.max_globally_active ?? 0) !== String(parseWholeNumber(draft.maxActive) ?? draft.maxActive)
    || String(row.max_globally_primed ?? 0) !== String(parseWholeNumber(draft.maxPrimed) ?? draft.maxPrimed)
    || (row.is_spawning_active !== false) !== draft.spawningActive
    || Number(row.global_spawn_weight ?? 0) !== Number(draft.spawnWeight);
}

function parseWholeNumber(value: string) {
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  return n;
}

function settingsCategory(value: string) {
  const raw = value.replace(/^\/Script\/DuneSandbox\./, "").replace(/^\/Script\//, "").replace(/^\/DeteriorationSystem\./, "");
  const cleaned = raw.split(".").pop() || raw;
  if (cleaned === "ConsoleVariables") return "Global";
  return titleCaseWords(cleaned.replace(/Subsystem$/, "").replace(/Settings$/, " Settings").replace(/Config$/, " Config").replace(/([a-z])([A-Z])/g, "$1 $2"));
}

function fieldCategory(field: UserSettingField) {
  return field.category || settingsCategory(field.section || field.key || field.id);
}

function friendlySettingLabel(id: string, fallback: string, explicit = "") {
  return String(explicit || "").trim() || titleCaseWords(id.replace(/^partition_/, "").replace(/_/g, " ")) || titleCaseWords(fallback);
}

function normalizeBooleanText(value: string) {
  return /^(1|true|yes|on)$/i.test(String(value)) ? "True" : "False";
}

function parseUserSettingsMap(text: string) {
  return Object.fromEntries(parseUserSettingRows(text).map((row) => [String(row.key || row.setting), String(row.value ?? "")]));
}

// A boolean control always emits "True"/"False", but the stored value can be
// "1"/"0" (Hydration.SunExposureEnabled) or lowercase "true"/"false". Compare the
// normalized form so re-picking the value a field already has is not treated as a
// pending change -- saving UserEngine/UserGame restarts the maps.
function settingValueChanged(field: UserSettingField | undefined, original: string, draft: string) {
  if (original === draft) return false;
  if (field?.type === "boolean" && original !== "" && draft !== "") return normalizeBooleanText(original) !== normalizeBooleanText(draft);
  return true;
}

// How many settings a generated client ini actually carries: every line that is
// not blank, a "; comment", or a "[Section]" header.
export function countIniOverrides(content: string) {
  return String(content || "").split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith(";") && !trimmed.startsWith("[");
  }).length;
}

// Drives the "Modified" badge: does this field's current value differ from the
// schema default? Shares settingValueChanged so a boolean stored as 1/0 is not
// permanently flagged against a "True"/"False" selection.
export function isModifiedFromDefault(field: UserSettingField, value: string) {
  return settingValueChanged(field, String(field.default ?? ""), String(value ?? ""));
}

// Pseudo-category listed alongside the real ones, so an admin can see just the
// settings this target overrides.
export const MODIFIED_CATEGORY = "Modified";

// A field would drop out of the "Modified" view the instant its value matched the
// default again -- typing "10" over "25" hits the default on the last keystroke and
// yanks the row out from under the cursor. Keep whatever is modified in the saved
// values visible until the next save settles it, and add anything the draft has
// changed since.
export function modifiedSettingsFields(fields: UserSettingField[], saved: Record<string, string>, draft: Record<string, string>) {
  return fields.filter((field) => {
    const savedValue = saved[field.id] ?? field.default ?? "";
    const draftValue = draft[field.id] ?? field.default ?? "";
    return isModifiedFromDefault(field, savedValue) || isModifiedFromDefault(field, draftValue);
  });
}

export function changedKeys(original: Record<string, string>, draft: Record<string, string>, fields: UserSettingField[]) {
  return fields
    .filter((field) => settingValueChanged(field, String(original[field.id] ?? ""), String(draft[field.id] ?? "")))
    .map((field) => field.id);
}

export function valuesForDirtyFields(original: Record<string, string>, draft: Record<string, string>, fields: UserSettingField[]) {
  return Object.fromEntries(fields
    .filter((field) => settingValueChanged(field, String(original[field.id] ?? ""), String(draft[field.id] ?? "")))
    .map((field) => [field.id, String(draft[field.id] ?? field.default ?? "")]));
}


// Shown instead of writing when isSietchWriteTarget rejects a row, so a
// refused Restart or Save says why rather than appearing to do nothing.
const SIETCH_PARTITION_IDS_UNREADABLE =
  "Sietch partition IDs could not be read from the server, so this change cannot be applied to the right Sietch. Reload the Maps tab and try again.";

function memoryForMap(rows: LiveMapMemoryRow[], map: string, row?: Record<string, unknown>) {
  const normalized = normalizeMapKey(map);
  const partitionId = String(row?.partitionId || row?.partition || "").trim();
  const containerMap = normalizeContainerMapKey(map);
  const partitionMatch = partitionId ? rows.find((memoryRow) => {
    const container = memoryRow.container.toLowerCase();
    return container.endsWith(`-${partitionId.toLowerCase()}`);
  }) || null : null;
  if (partitionMatch) return partitionMatch;
  if (partitionId && (normalized === "survival_1" || normalized === "deepdesert_1")) return null;
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

export function memoryForDisplayedMap(rows: LiveMapMemoryRow[], map: string, row?: Record<string, unknown>, primaryDeepDesertPartition?: Record<string, unknown>) {
  if (/^DeepDesert_/i.test(map) && primaryDeepDesertPartition) {
    return memoryForMap(rows, map, {
      ...row,
      partitionId: primaryDeepDesertPartition.partitionId ?? primaryDeepDesertPartition.partition
    });
  }
  return memoryForMap(rows, map, row);
}

export function statusWithLiveMemory(status: string, memoryRow: LiveMapMemoryRow | null, mode?: unknown) {
  const normalized = String(status || "Not Available");
  if (/^Always On$/i.test(String(mode || "").trim()) && /^(Not Running|Not Available|Unallocated|Assigned|Idle|Starting|Queued)$/i.test(normalized)) {
    return memoryRow ? "Loading" : "Queued";
  }
  if (!memoryRow) return normalized;
  if (/^(Not Running|Not Available|Unallocated|Assigned|Idle|Starting)$/i.test(normalized)) {
    return "Loading";
  }
  return normalized;
}

function liveMemoryIsReadyMode(mode: unknown) {
  return /^(Always On|Core Map)$/i.test(String(mode || "").trim());
}

function liveMemoryIsPendingStatus(status: unknown) {
  return /^(Ready|Running|Starting|Loading|Warming|Assigned|Queued|Idle)$/i.test(String(status || "").trim());
}

function partitionMemoryValue(memoryText: string, partitionId: string, fallback: string, mapName = "Survival_1") {
  const target = `${mapName}:${partitionId}`;
  const row = parseMemoryRows(memoryText).find((item) => String(item.map || "") === target);
  return String(row?.memory || fallback || "");
}

// `combatRow`, when available, comes from the /api/maps/combat-state
// resolver (see console/api/src/services/mapCombatState.js), which derives
// PvP/PvE state from the partition's effective UserGame.ini configuration.
// This function must NOT infer PvP/PvE from `row.dimension` — dimension
// index is positional metadata only and does not determine combat state
// (see the "Dual Deep Desert" resolver contract).
//
// `combatRow.serverDisplayName`, when present, is the effective, merged
// Bgd.ServerDisplayName (partition -> map -> global UserEngine.ini) — the
// name a player actually sees in-game. It takes precedence over the
// synthesized "Deep Desert N (PvP/PvE)" text below.
type DeepDesertCombatDisplayRow = Partial<PartitionCombatStateRow> & Pick<PartitionCombatStateRow, "configuredState">;

// A layout change creates partition rows before every downstream combat-state
// read has caught up. During that short window, show the roles the operator
// selected instead of flashing each new row's template/default PvE badge and
// changing it later. Once the task finishes, the server-resolved state becomes
// authoritative again.
export function deepDesertLayoutCombatRow(
  row: Record<string, unknown>,
  resolved: PartitionCombatStateRow | null,
  configuring: boolean,
  thirdRole: "pve" | "pvp"
): DeepDesertCombatDisplayRow | null {
  if (!configuring) return resolved;
  const dimension = Number(row.dimension ?? row.dimensionIndex);
  const configuredState = dimension === 0
    ? "PVE"
    : dimension === 1
      ? "PVP"
      : dimension === 2
        ? (thirdRole === "pvp" ? "PVP" : "PVE")
        : "UNKNOWN";
  return { ...resolved, configuredState, configurationDrift: false, restartRequired: false };
}

export function deepDesertPartitionName(row: Record<string, unknown>, combatRow?: DeepDesertCombatDisplayRow | null) {
  const configuredName = String(combatRow?.serverDisplayName || "").trim();
  if (configuredName) {
    // Managed default names contain a role for readability. Always reconcile
    // that word with the same canonical combat state used by the adjacent
    // badge so a stale name cache can never display PvE beside a PvP badge.
    if (/^Deep Desert Pv[EP](?: \d+)?$/i.test(configuredName) && (combatRow?.configuredState === "PVP" || combatRow?.configuredState === "PVE")) {
      const role = combatRow.configuredState === "PVP" ? "PvP" : "PvE";
      return configuredName.replace(/Pv[EP]/i, role);
    }
    return configuredName;
  }
  const dimension = Number(row.dimension);
  const suffix = Number.isFinite(dimension) ? ` ${dimension + 1}` : "";
  if (combatRow) {
    if (combatRow.configuredState === "PVP") return `Deep Desert${suffix} (PvP)`;
    if (combatRow.configuredState === "PVE") return `Deep Desert${suffix} (PvE)`;
    if (combatRow.configuredState === "CONFLICT") return `Deep Desert${suffix} (Conflicting PvP/PvE config)`;
  }
  const label = String(row.label || "").trim();
  if (!combatRow && label && !/^[-\d\s]+$/.test(label)) return label;
  return `Deep Desert${suffix || " Instance"}`;
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
  if (liveMemoryIsPendingStatus(row.status)) return "Waiting for Sample";
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

export function parseMapRows(text: string): Record<string, unknown>[] {
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
    const mode = friendlyMapMode(line.match(/\bCurrent:\s*(dynamic|always-on|overmap-active|disabled)\b/i)?.[1] || line.match(/\b(dynamic|always-on|overmap-active|disabled)\b/i)?.[1] || "");
    const memoryBlock = line.match(/\bBlock:\s*host-memory\s+available=(\d+)GiB\s+required=(\d+)GiB\s+requested=(\d+)GiB\s+reserve=(\d+)GiB\s+swap-free=(\d+)GiB/i);
    const statusDetail = memoryBlock
      ? `Waiting for physical RAM: ${memoryBlock[1]} GB available; ${memoryBlock[2]} GB required (${memoryBlock[3]} GB map + ${memoryBlock[4]} GB safety reserve). Swap is emergency-only and is not used as startup capacity.`
      : "";
    return {
      map,
      status: assigned && Number(assigned) > 0 ? "Starting" : /^Always On$/i.test(mode) ? "Queued" : "Not Running",
      statusDetail,
      mode,
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
    const parsed = parseMemoryStatusLine(line);
    if (!parsed) return null;
    return { map: parsed.map, memory: formatMemoryValue(parsed.memory) };
  }).filter(Boolean) as Record<string, unknown>[];
}

function defaultMemoryFromStatus(text: string) {
  const line = stripAnsi(text).split(/\r?\n/).find((candidate) => /^Default memory:/i.test(candidate.trim())) || "";
  const value = line.replace(/^Default memory:\s*/i, "").trim();
  if (!value || /built-in per-map defaults/i.test(value)) return "";
  return formatMemoryValue(value);
}

function fallbackMemoryForMap(map: string, memoryText: string) {
  const globalDefault = defaultMemoryFromStatus(memoryText);
  if (globalDefault) return globalDefault;
  if (map === "Survival_1" || map === "DeepDesert_1") return "16.00 GB (Default)";
  if (map === "Overmap") return "3.00 GB (Default)";
  return "3.00 GB (Default)";
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
    const parsed = parseMemoryStatusLine(line.trim());
    if (!parsed) return line;
    const key = parsed.map;
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

function parseMemoryStatusLine(line: string) {
  const match = String(line || "").trim().match(/^(.+?)\s+((?:\d+(?:\.\d+)?)\s*(?:[KMGT](?:i?B?|B)?)(?:\s+\(?default\)?)?)$/i);
  if (!match) return null;
  return { map: match[1].trim(), memory: match[2].trim() };
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
    const baseOvermapMatch = line.match(/^(OK|WAIT|FAIL)\s+Overmap\s+(.+)$/i);
    if (baseOvermapMatch) {
      const [, state, detail] = baseOvermapMatch;
      if (/^OK$/i.test(state) && /\bready\b/i.test(detail)) statuses.set("2", "Ready");
      else if (/^WAIT$/i.test(state) && /\bwarming\b/i.test(detail)) statuses.set("2", "Loading");
      else if (/^FAIL$/i.test(state)) statuses.set("2", "Not Running");
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

function mergeMapAndMemoryRows(mapsText: string, memoryText: string, serversText = "", readinessText = ""): Record<string, unknown>[] {
  const rows = new globalThis.Map<string, Record<string, unknown>>();
  const serverRows = new globalThis.Map<string, Record<string, unknown>>();
  const readinessStatuses = parseReadinessPartitionStatuses(readinessText);
  for (const row of parseServerPartitionRows(serversText)) {
    const map = String(row.map || "");
    if (!map) continue;
    const partitionId = String(row.partitionId || "").trim();
    const readinessStatus = partitionId ? readinessStatuses.get(partitionId) : "";
    const coreReadinessAuthoritative = /^(Survival_1|Overmap)$/i.test(map);
    const mergedStatus = readinessStatus && coreReadinessAuthoritative ? readinessStatus : readinessStatus ? strongestMapStatus(String(row.status || ""), readinessStatus) : "";
    const rowWithReadiness = mergedStatus ? { ...row, status: mergedStatus } : row;
    const existing = serverRows.get(map);
    const existingDimension = Number(existing?.dimension ?? Number.POSITIVE_INFINITY);
    const rowDimension = Number(rowWithReadiness.dimension ?? Number.POSITIVE_INFINITY);
    const existingPartitionId = Number(existing?.partitionId ?? Number.POSITIVE_INFINITY);
    const rowPartitionId = Number(rowWithReadiness.partitionId ?? Number.POSITIVE_INFINITY);
    const useRowAsBase = !existing || rowDimension < existingDimension || (rowDimension === existingDimension && rowPartitionId < existingPartitionId);
    const base = useRowAsBase ? rowWithReadiness : existing;
    const status = map === "DeepDesert_1" ? String(base?.status || "") : strongestMapStatus(String(existing?.status || ""), String(rowWithReadiness.status || ""));
    serverRows.set(map, {
      ...base,
      status,
      dimensions: existing?.dimensions ? `${String(existing.dimensions)}, ${String(rowWithReadiness.label || rowWithReadiness.partitionId)}` : String(rowWithReadiness.label || rowWithReadiness.partitionId || "")
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
      memory: row.memory ? formatMemoryValue(String(row.memory)) : rows.get(map)?.memory || fallbackMemoryForMap(map, memoryText),
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
  if (assigned) return "Loading";
  return "Not Running";
}

function isTruthyDbValue(value: unknown) {
  return /^(true|t|1|yes|y)$/i.test(String(value || "").trim());
}

function mapCanForceDespawn(row: Record<string, unknown>) {
  return /^(Ready|Loading|Starting|Warming|Running)$/i.test(String(row.status || "").trim());
}

function mapCanForceSpawn(row: Record<string, unknown>) {
  return /^(Not Running|Not Available|Stopped|Offline|Unassigned)$/i.test(String(row.status || "").trim());
}

function mapRuntimeNeedsLiveApply(status: unknown) {
  return /^(Ready|Loading|Starting|Assigned|Warming|Running|Queued)$/i.test(String(status || "").trim());
}

function strongestMapStatus(a: string, b: string) {
  const order = ["Not Available", "Not Running", "Queued", "Starting", "Loading", "Warming", "Running", "Ready"];
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

function isVehicleDeployMap(value: string) {
  return /^CB_Overland_/i.test(String(value || "").trim());
}

function isFreshProcessMap(value: string) {
  return String(value || "").trim() === "CB_Overland_S_06";
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
  const match = String(value || "").match(/(\d+(?:\.\d+)?)\s*(GB|GiB?|MB|MiB?|[gGmM])?/i);
  if (!match) return "8";
  const amount = Number(match[1]) || 0;
  const unit = (match[2] || "GB").toLowerCase();
  const amountInGb = unit.startsWith("m") ? amount / 1024 : amount;
  return amountInGb.toFixed(2);
}

function memoryCliValue(value: string) {
  return `${String(value || "").trim()}g`;
}

function memoryValueToBytes(value: string) {
  const match = String(value || "").match(/(\d+(?:\.\d+)?)\s*(GiB?|GB|MiB?|MB|[gGmM])?/i);
  if (!match) return 0;
  const amount = Number(match[1]) || 0;
  const unit = (match[2] || "GB").toLowerCase();
  const multiplier = unit.startsWith("m") ? 1024 ** 2 : 1024 ** 3;
  return amount * multiplier;
}

function coreMapRank(row: Record<string, unknown>) {
  const map = String(row.map || "").trim().toLowerCase();
  if (map === "survival_1") return 0;
  if (map === "overmap") return 1;
  return String(row.mode || "").trim().toLowerCase() === "core map" ? 2 : Number.POSITIVE_INFINITY;
}

export function sortMapRows(rows: Record<string, unknown>[], column: MapSortColumn | null, direction: "asc" | "desc", liveMemoryRows: LiveMapMemoryRow[] = []) {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return rows.map((row, index) => ({ row, index })).sort((left, right) => {
    const leftCoreRank = coreMapRank(left.row);
    const rightCoreRank = coreMapRank(right.row);
    const leftIsCore = Number.isFinite(leftCoreRank);
    const rightIsCore = Number.isFinite(rightCoreRank);
    if (leftIsCore !== rightIsCore) return leftIsCore ? -1 : 1;
    if (leftIsCore && rightIsCore) return leftCoreRank - rightCoreRank || left.index - right.index;
    if (!column) return left.index - right.index;

    if (column === "memory") {
      const leftMemory = memoryForMap(liveMemoryRows, String(left.row.map || ""), left.row);
      const rightMemory = memoryForMap(liveMemoryRows, String(right.row.map || ""), right.row);
      if (Boolean(leftMemory) !== Boolean(rightMemory)) return leftMemory ? -1 : 1;
      if (!leftMemory || !rightMemory) return left.index - right.index;
      const compare = leftMemory.usedBytes - rightMemory.usedBytes || leftMemory.percent - rightMemory.percent;
      return (direction === "asc" ? compare : -compare) || left.index - right.index;
    }

    const compare = collator.compare(String(left.row[column] || ""), String(right.row[column] || ""));
    return (direction === "asc" ? compare : -compare) || left.index - right.index;
  }).map(({ row }) => row);
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
  const displayValue = (Number(match[1]) || 0).toFixed(2);
  return `${displayValue} ${displayUnit}${isDefault ? " (Default)" : ""}`;
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
    /\bSpawned\b.+\bdune-server-/i.test(text);
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
