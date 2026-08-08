import { useCallback, useEffect, useRef, useState } from "react";
import { Boxes, ChevronDown, ChevronUp, Download, Droplet, Fuel, Users, X, Zap } from "lucide-react";
import { BaseInventoryTab } from "./BaseInventoryTab";
import { BasePermissionsTab } from "./BasePermissionsTab";
import { BaseWaterTab } from "./BaseWaterTab";
import { basesApi, type AutoRefillBase, type AutoRefillWaterBase, type RefillDeviceResult, type RefillWaterDeviceResult } from "../../api/bases";
import { mapsApi } from "../../api/maps";
import { friendlyMapName } from "../maps/mapNames";
import { parseSietchRows } from "../maps/sietchRows";
import { InfoTooltip } from "../../components/common/DisplayPrimitives";
import { serverApi } from "../../api/server";
import { setupApi, type Task } from "../../api/setup";
import { apiDownload } from "../../api/client";
import { DataTable, type SortDirection } from "../../components/common/DataTable";
import { pendingRefillCountForPartition, usePendingRefills, usePendingWaterRefills } from "../../lib/usePendingRefills";

type BasesPanelProps = {
  onError: (text: string) => void;
  confirmAction: (message: string, options?: { title?: string; confirmLabel?: string; warning?: string; danger?: boolean; details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] }) => Promise<boolean>;
  formatMutationResult: (result: unknown) => string;
};

type SharedWithEntry = { name: string; rank: number; label: string };

type GeneratorEntry = {
  type: "fuel" | "spice" | "windTurbineOmni" | "windTurbineDirectional";
  name: string;
  fuelName: string;
  fuelCells: number;
  generatorCount: number;
  runtimeSeconds: number;
  // Generators of this type with no accepted fuel units queued in inventory.
  // This deliberately does not claim that a stale burn marker is still active.
  unstockedCount?: number;
};

type BaseRow = Record<string, unknown> & {
  base_id: string;
  name: string;
  base_type: string;
  owner_name: string;
  map: string;
  x: number;
  y: number;
  z: number;
  coordinates: string;
  piece_count: number;
  placeable_count: number;
  shared_with: SharedWithEntry[];
  generatorDataAvailable: boolean;
  generatorCount: number;
  fuelCells: number;
  generatorRuntimeSeconds: number;
  generatorUptimeMultiplier: number;
  generatorUptimeEventLabel: string;
  generatorUptimeEventEndsAt: string;
  generatorUnstockedCount: number;
  generatorAllUnstocked: boolean;
  generators: GeneratorEntry[];
};

function formatRuntime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatEventThroughDate(endsAt: string) {
  const exclusiveEnd = Date.parse(endsAt);
  if (!Number.isFinite(exclusiveEnd)) return "the announced event end";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(exclusiveEnd - 1));
}

function hasNoQueuedFuel(unstockedCount: number | undefined, generatorCount: number) {
  return generatorCount > 0 && (unstockedCount || 0) >= generatorCount;
}

const QUEUED_RESERVE_EXPLANATION = "Queued Reserve counts fuel still in inventory. It excludes fuel currently burning, so the in-game Total Uptime may be higher.";

// A queued refill only applies while its map is confirmed down. On a map that
// never comes down an entry would otherwise sit unnoticed until the server-side
// age limit discards it, so entries past this age are called out in the banner.
const STALE_QUEUED_REFILL_MS = 24 * 60 * 60_000;

function formatAgo(iso: string) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const BASES_AUTO_REFRESH_MS = 15 * 60_000; // 15 minutes — listBases is expensive
const BASES_PAGE_SIZES = [25, 50, 100, 200] as const;
const BASES_DEFAULT_PAGE_SIZE = 50;

type BasesCache = {
  q: string;
  page: number;
  pageSize: number;
  sortColumn: string;
  sortDirection: SortDirection;
  rows: BaseRow[];
  totalCount: number;
  totalBases: number;
  totalPieces: number;
  totalPlaceables: number;
  lastFetchedAt: number;
};

let basesCache: BasesCache | null = null;

type RefillStatusKind = "" | "running" | "ok" | "fail";

// Held at module scope for the same reason basesCache is: switching tabs unmounts
// this panel, but a map restart runs server-side for minutes. Without this,
// returning to Bases showed a blank banner with no hint that a restart was still
// in flight. Written through synchronously so the detached task-wait keeps
// recording progress after the component is gone.
let refillStatusCache: { text: string; kind: RefillStatusKind; at: number } = { text: "", kind: "", at: 0 };
let restartingTargetsCache: string[] = [];

const REFILL_STATUS_TTL_MS = 10_000;

// The task-wait that outlives a tab switch belongs to the unmounted instance, so
// it cannot push into the new one's state directly. Writes go to the cache and
// notify whichever instance is currently mounted, so a restart that finishes
// while you are on another tab still clears its spinner when you come back.
const refillStatusSubscribers = new Set<() => void>();

function writeRefillStatus(text: string, kind: RefillStatusKind) {
  refillStatusCache = { text, kind, at: Date.now() };
  refillStatusSubscribers.forEach((notify) => notify());
}

function writeRestartingTarget(key: string, active: boolean) {
  restartingTargetsCache = active
    ? [...restartingTargetsCache.filter((entry) => entry !== key), key]
    : restartingTargetsCache.filter((entry) => entry !== key);
  refillStatusSubscribers.forEach((notify) => notify());
}

// A finished success is only worth restoring for as long as it would have stayed
// on screen; past that it would read as news when it is history. Running and
// failed states are kept: one is still true, the other still needs reading.
function readCachedRefillStatus() {
  if (refillStatusCache.kind === "ok" && Date.now() - refillStatusCache.at > REFILL_STATUS_TTL_MS) {
    refillStatusCache = { text: "", kind: "", at: 0 };
  }
  return refillStatusCache;
}

function sameView(cache: BasesCache | null, q: string, page: number, pageSize: number, sortColumn: string, sortDirection: SortDirection) {
  return !!cache && cache.q === q && cache.page === page && cache.pageSize === pageSize && cache.sortColumn === sortColumn && cache.sortDirection === sortDirection;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// Polls a restart task to a terminal state. The ceiling matches the 30-minute
// timeout the API gives restart operations, since a Deep Desert respawn has to
// boot and load a level, not just bounce a service.
async function waitForTask(task: Task) {
  let current = task;
  for (let i = 0; i < 1800 && !["succeeded", "failed", "cancelled"].includes(current.status); i += 1) {
    await new Promise((resolveTick) => window.setTimeout(resolveTick, 1000));
    current = (await setupApi.task(current.id)).task;
  }
  return current;
}

type QueueRestartTarget =
  | { kind: "sietch"; partitionId: number; label: string }
  | { kind: "service"; service: string; label: string }
  | { kind: "respawn"; partitionId: number; label: string }
  | { kind: "none" };

// Chooses the restart action for a queued base's partition. The name compared
// here must be world_partition.map (supplied as partitionMap), never the base's
// own map: dune.actors reports "HaggaBasin" for partition 1 and "DeepDesert" for
// partition 8, while the restart machinery knows those as "Survival_1" and
// "DeepDesert_1".
//
// Survival_1 goes through the Sietch path, which resolves the partition itself:
// dimension 0 re-runs the primary server, any other dimension despawns and
// respawns just that partition's container. The Overmap is a single service.
// Everything else -- Deep Desert, the SH_* hubs, dungeon and story instances --
// has no managed service at all and only restarts by despawning and respawning
// its own partition.
function queueRestartTarget(partitionMap: string, partitionId: number, dimensionIndex: number): QueueRestartTarget {
  const key = String(partitionMap || "").trim().toLowerCase();
  // Nothing to target: the partition could not be resolved from world_partition
  // (including when the database was unreachable and every group's partitionMap
  // came back empty) -- guessing "respawn" here would pick the wrong mechanism
  // for Survival_1/Overmap, which need the sietch/service path instead.
  if (!partitionId || !key) return { kind: "none" };
  if (key === "survival_1") {
    return {
      kind: "sietch",
      partitionId,
      label: dimensionIndex > 0 ? `Restart Survival_1 Sietch ${partitionId}` : "Restart Survival_1"
    };
  }
  if (key === "overmap") return { kind: "service", service: "overmap", label: "Restart Overmap" };
  return { kind: "respawn", partitionId, label: `Restart ${partitionMap}` };
}

// Report what actually changed per device rather than a generic "Action
// completed." — "nothing was added" is a meaningful outcome here, not a failure.
function summarizeRefill(response: {
  result?: { queued?: boolean; map?: string; totalAdded?: number; devices?: RefillDeviceResult[] };
}) {
  const result = response.result;
  if (result?.queued) {
    return `Refill queued for ${result.map || "this base"}. It applies the next time that map restarts or stops, so a running server cannot overwrite it.`;
  }
  if (!result || !Array.isArray(result.devices) || typeof result.totalAdded !== "number") return "";
  const changed = result.devices.filter((device) => (device.added || 0) > 0);
  if (!changed.length) return `All ${result.devices.length} device${result.devices.length === 1 ? " was" : "s were"} already full. Nothing added.`;
  const detail = changed
    .map((device) => `${device.label}: +${device.added} ${device.fuelName}${device.added === 1 ? "" : "s"}${device.capped ? " (capped by inventory space)" : ""}`)
    .join(" · ");
  const skipped = result.devices.filter((device) => device.skipped).length;
  return `Added ${result.totalAdded} fuel unit${result.totalAdded === 1 ? "" : "s"} across ${changed.length} device${changed.length === 1 ? "" : "s"}. ${detail}${skipped ? ` · ${skipped} skipped (no inventory)` : ""}`;
}

// Mirrors summarizeRefill. No fuelName/capped/skipped -- water refill is a
// plain jsonb_set straight to capacity, not a stack of discrete items.
function summarizeWaterRefill(response: {
  result?: { queued?: boolean; map?: string; totalAdded?: number; devices?: RefillWaterDeviceResult[] };
}) {
  const result = response.result;
  if (result?.queued) {
    return `Water refill queued for ${result.map || "this base"}. It applies the next time that map restarts or stops, so a running server cannot overwrite it.`;
  }
  if (!result || !Array.isArray(result.devices) || typeof result.totalAdded !== "number") return "";
  const changed = result.devices.filter((device) => (device.added || 0) > 0);
  if (!changed.length) return `All ${result.devices.length} container${result.devices.length === 1 ? " was" : "s were"} already full. Nothing added.`;
  const detail = changed.map((device) => `${device.label}: +${device.added.toLocaleString()}`).join(" · ");
  return `Added ${result.totalAdded.toLocaleString()} water across ${changed.length} container${changed.length === 1 ? "" : "s"}. ${detail}`;
}

function withCoordinates(row: Record<string, unknown>): BaseRow {
  const x = Math.round(Number(row.x) || 0);
  const y = Math.round(Number(row.y) || 0);
  const z = Math.round(Number(row.z) || 0);
  return { ...row, x, y, z, coordinates: `${x}, ${y}, ${z}` } as BaseRow;
}

// Columns narrow enough to ellipsize; a title keeps the full value readable.
const TOOLTIP_COLUMNS = new Set(["base_type", "owner_name", "coordinates"]);

function renderBaseCell(row: Record<string, unknown>, column: string, instanceNames?: Map<string, string>) {
  if (column === "map") {
    const mapId = String(row.map || "");
    if (!mapId) return <span className="muted">—</span>;
    const partitionId = String(row.partition_id || "");
    // Looked up under the same map-scoped key the effect writes: a bare
    // partition number is only unique once the map it belongs to is fixed.
    const partitionMap = String(row.partitionMap || "").trim();
    // The instance name if it has arrived, otherwise the partition number.
    // Something identifying always renders, because two instances of one map
    // are otherwise indistinguishable in this column.
    const instance = (partitionId && partitionMap && instanceNames?.get(`${partitionMap}:${partitionId}`))
      || (partitionId ? `Partition ${partitionId}` : "");
    return (
      <span className="bases-map-cell">
        <span className="bases-map-name" title={mapId}>{friendlyMapName(mapId)}</span>
        {instance && <span className="bases-map-instance" title={`Partition ${partitionId}`}>{instance}</span>}
      </span>
    );
  }
  if (column === "name") {
    const name = String(row.name || "");
    return name ? <span className="bases-name" title={name}>{name}</span> : "—";
  }
  if (column === "generators") {
    if (row.generatorDataAvailable === false) return <span className="muted" title="Generator data is unavailable">Unavailable</span>;
    const generatorCount = Number(row.generatorCount) || 0;
    if (!generatorCount) return <span className="muted">—</span>;
    if (row.generatorAllUnstocked) {
      const text = `${generatorCount} · No generators have queued fuel`;
      return (
        <span className="bases-generator-summary" title={`${text}. ${QUEUED_RESERVE_EXPLANATION}`}>
          {generatorCount} · <span className="bases-fuel-alert">No generators have queued fuel</span>
        </span>
      );
    }
    const unstockedCount = Number(row.generatorUnstockedCount) || 0;
    const runtimeSeconds = Number(row.generatorRuntimeSeconds) || 0;
    // The database can verify queued inventory, but active burn timestamps can
    // be stale after a restart/base load. Describe the value as a reserve rather
    // than promising an exact live depletion countdown.
    if (unstockedCount > 0) {
      const text = `${generatorCount} · ${unstockedCount} with no queued fuel · Lowest Queued Reserve ${formatRuntime(runtimeSeconds)}`;
      return (
        <span className="bases-generator-summary" title={`${text}. ${QUEUED_RESERVE_EXPLANATION}`}>
          {generatorCount} · <span className="bases-fuel-alert">{unstockedCount} with no queued fuel</span> <br />
          Lowest Queued Reserve {formatRuntime(runtimeSeconds)}
        </span>
      );
    }
    const text = `${generatorCount} · Lowest Queued Reserve ${formatRuntime(runtimeSeconds)}`;
    return <span className="bases-generator-summary" title={`${text}. ${QUEUED_RESERVE_EXPLANATION}`}>{text}</span>;
  }
  if (TOOLTIP_COLUMNS.has(column)) {
    const value = row[column];
    const text = value == null || value === "" ? "" : String(value);
    return text ? <span className="bases-ellipsis-cell" title={text}>{text}</span> : "—";
  }
  if (column !== "shared_with") {
    const value = row[column];
    if (Array.isArray(value)) return value.join(", ");
    return value == null || value === "" ? "—" : String(value);
  }
  const sharedWith = Array.isArray(row.shared_with) ? (row.shared_with as SharedWithEntry[]) : [];
  if (!sharedWith.length) return <span className="muted">—</span>;
  return (
    <span className="bases-shared-list">
      {sharedWith.map((entry) => (
        <span key={`${entry.name}-${entry.rank}`}>{entry.name} <em>({entry.label})</em></span>
      ))}
    </span>
  );
}

export function BasesPanel({ onError, confirmAction, formatMutationResult }: BasesPanelProps) {
  const [q, setQ] = useState(() => basesCache?.q ?? "");
  const [submittedQ, setSubmittedQ] = useState(() => basesCache?.q ?? "");
  const [page, setPage] = useState(() => basesCache?.page ?? 0);
  const [pageSize, setPageSize] = useState<number>(() => basesCache?.pageSize ?? BASES_DEFAULT_PAGE_SIZE);
  const [sortColumn, setSortColumn] = useState(() => basesCache?.sortColumn ?? "name");
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => basesCache?.sortDirection ?? "asc");
  const [rows, setRows] = useState<BaseRow[]>(() => basesCache?.rows ?? []);
  // partition id -> operator-chosen instance name ("Deep Desert PvE", "Sietch
  // Abbir"). Loaded after the table renders, never blocking it: the names come
  // from a CLI-backed endpoint, and the partition number alone already
  // distinguishes instances if that call is slow or fails outright.
  const [instanceNames, setInstanceNames] = useState<Map<string, string>>(new Map());
  const [totalCount, setTotalCount] = useState(() => basesCache?.totalCount ?? 0);
  const [totalBases, setTotalBases] = useState(() => basesCache?.totalBases ?? 0);
  const [totalPieces, setTotalPieces] = useState(() => basesCache?.totalPieces ?? 0);
  const [totalPlaceables, setTotalPlaceables] = useState(() => basesCache?.totalPlaceables ?? 0);
  const [loading, setLoading] = useState(() => basesCache === null);
  const [downloadingId, setDownloadingId] = useState("");
  const [refillingId, setRefillingId] = useState("");
  const [refillResult, setRefillResult] = useState(() => readCachedRefillStatus().text);
  // Drives the status line's styling: "running" keeps it on screen with a
  // spinner, "ok"/"fail" colour it.
  const [refillStatus, setRefillStatus] = useState<RefillStatusKind>(() => readCachedRefillStatus().kind);
  const [canRefill, setCanRefill] = useState(false);
  const [canQueue, setCanQueue] = useState(false);
  const [canEditPermissions, setCanEditPermissions] = useState(false);
  const [canRefillWater, setCanRefillWater] = useState(false);
  const [canQueueWater, setCanQueueWater] = useState(false);
  // Which tab the expanded row is showing. Power is the default so expanding a
  // row behaves exactly as it did before this feature existed.
  const [expandedTab, setExpandedTab] = useState<"power" | "water" | "inventory" | "permissions">("power");
  const [cancelingId, setCancelingId] = useState("");
  const [cancelingWaterId, setCancelingWaterId] = useState("");
  const [refillingWaterId, setRefillingWaterId] = useState("");
  // Bumped after an immediate (non-queued) water refill so an already-open
  // Water tab knows to refetch -- it fetches its own data independently of
  // the bases list/row, so nothing else tells it a refill just landed.
  const [waterRefreshToken, setWaterRefreshToken] = useState(0);
  // A list, not one key: each row shows its own progress, so the other rows stay
  // clickable and a second restart cannot erase the first one's spinner.
  const [restartingTargets, setRestartingTargets] = useState<string[]>(() => restartingTargetsCache);
  const [expandedBaseId, setExpandedBaseId] = useState<string | null>(null);
  // Enrollment is console-owned config, not part of a base row, so it is fetched
  // once rather than polled: it only changes when this panel changes it.
  const [autoRefillBases, setAutoRefillBases] = useState<Map<string, AutoRefillBase>>(new Map());
  const [autoRefillThreshold, setAutoRefillThreshold] = useState(50);
  const [autoRefillIntervalHours, setAutoRefillIntervalHours] = useState(24);
  const [savingAutoRefillId, setSavingAutoRefillId] = useState("");
  // Distinct from "no bases enrolled": the enrollment read itself failed, so
  // what is on screen may not reflect reality.
  const [autoRefillUnavailable, setAutoRefillUnavailable] = useState(false);
  // Mirrors the block above, for water auto-refill -- own enrollment state so
  // the two subsystems never share or interfere with each other.
  const [autoRefillWaterBases, setAutoRefillWaterBases] = useState<Map<string, AutoRefillWaterBase>>(new Map());
  const [autoRefillWaterThreshold, setAutoRefillWaterThreshold] = useState(50);
  const [autoRefillWaterIntervalHours, setAutoRefillWaterIntervalHours] = useState(24);
  const [savingAutoRefillWaterId, setSavingAutoRefillWaterId] = useState("");
  const [autoRefillWaterUnavailable, setAutoRefillWaterUnavailable] = useState(false);
  const requestIdRef = useRef(0);
  const lastExpandedRef = useRef<string | null>(null);
  const skipNextSearchReset = useRef(true);
  const { pending: pendingRefills, refresh: refreshPendingRefills } = usePendingRefills(canQueue);
  const { pending: pendingWaterRefills, refresh: refreshPendingWaterRefills } = usePendingWaterRefills(canQueueWater);
  const previousPendingTotal = useRef<number | null>(null);

  useEffect(() => {
    if (skipNextSearchReset.current) {
      skipNextSearchReset.current = false;
      return;
    }
    setPage(0);
  }, [submittedQ]);

  function submitSearch() {
    setSubmittedQ(q);
  }

  function handleClearSearch() {
    setQ("");
    setSubmittedQ("");
  }

  const load = useCallback(async (params: { q: string; page: number; pageSize: number; sortColumn: string; sortDirection: SortDirection }, options: { silent?: boolean } = {}) => {
    const requestId = ++requestIdRef.current;
    if (!options.silent) onError("");
    try {
      const result = await basesApi.list(params);
      if (requestIdRef.current !== requestId) return;
      const nextRows = (result.rows || []).map(withCoordinates);
      setRows(nextRows);
      setCanRefill(Boolean(result.capabilities?.generatorRefill));
      setCanQueue(Boolean(result.capabilities?.generatorRefillQueue));
      setCanEditPermissions(Boolean(result.capabilities?.basePermissions));
      setCanRefillWater(Boolean(result.capabilities?.waterRefill));
      setCanQueueWater(Boolean(result.capabilities?.waterRefillQueue));
      setTotalCount(result.totalCount || 0);
      setTotalBases(result.totalBases || 0);
      setTotalPieces(result.totalPieces || 0);
      setTotalPlaceables(result.totalPlaceables || 0);
      basesCache = {
        q: params.q,
        page: params.page,
        pageSize: params.pageSize,
        sortColumn: params.sortColumn,
        sortDirection: params.sortDirection,
        rows: nextRows,
        totalCount: result.totalCount || 0,
        totalBases: result.totalBases || 0,
        totalPieces: result.totalPieces || 0,
        totalPlaceables: result.totalPlaceables || 0,
        lastFetchedAt: Date.now()
      };
    } catch (error) {
      if (requestIdRef.current === requestId && !options.silent) onError(errorText(error));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | undefined;
    const params = { q: submittedQ, page, pageSize, sortColumn, sortDirection };
    const cacheHit = sameView(basesCache, submittedQ, page, pageSize, sortColumn, sortDirection) ? basesCache : null;

    if (cacheHit) {
      setRows(cacheHit.rows);
      setTotalCount(cacheHit.totalCount);
      setTotalBases(cacheHit.totalBases);
      setTotalPieces(cacheHit.totalPieces);
      setTotalPlaceables(cacheHit.totalPlaceables);
      setLoading(false);
    }

    const scheduleNext = () => {
      if (cancelled) return;
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => { void tick(); }, BASES_AUTO_REFRESH_MS);
    };

    const tick = async () => {
      if (document.visibilityState !== "hidden") await load(params, { silent: true });
      scheduleNext();
    };

    // Always refresh on entry. Cached rows remain visible while the current data is fetched.
    void load(params, { silent: Boolean(cacheHit) }).then(scheduleNext);

    const onVisibilityChange = () => {
      const currentCache = sameView(basesCache, submittedQ, page, pageSize, sortColumn, sortDirection) ? basesCache : null;
      if (document.visibilityState === "visible" && (!currentCache || Date.now() - currentCache.lastFetchedAt >= BASES_AUTO_REFRESH_MS)) {
        void load(params, { silent: true }).then(scheduleNext);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [submittedQ, page, pageSize, sortColumn, sortDirection, load]);

  // Upgrade "Partition 59" to "Deep Desert PvE" once the names arrive. One
  // request pair per distinct partition map on the page (the dimension table
  // plus its partition ids, which pair up by row order), fired after the table
  // is already on screen. Failures are swallowed on purpose -- these endpoints
  // shell out to the runtime CLI and are absent on a console-only install, and
  // a missing instance name must never take the base list down with it.
  const partitionMapsKey = [...new Set(rows
    .map((row) => String(row.partitionMap || "").trim())
    .filter(Boolean))].sort().join(",");
  useEffect(() => {
    const maps = partitionMapsKey ? partitionMapsKey.split(",") : [];
    if (!maps.length) return undefined;
    let cancelled = false;
    void (async () => {
      const resolved = new Map<string, string>();
      await Promise.all(maps.map(async (map) => {
        try {
          const [table, ids] = await Promise.all([
            mapsApi.sietchDimensions(map, false),
            mapsApi.sietchDimensions(map, true)
          ]);
          // A non-zero exit still answers 200 with empty stdout, so a failed
          // command is indistinguishable from a map with no sietches unless
          // the code is checked. Treat it as unreadable and keep the fallback.
          if (table.exitCode || ids.exitCode) return;
          for (const row of parseSietchRows(table.stdout || "", ids.stdout || "")) {
            // Keyed by map as well as id, and only for ids that really came
            // from the --ids output: a row that fell back to its dimension
            // index would otherwise answer for another map's partition of the
            // same number and label that base with this map's instance name.
            if (row.displayName && row.partitionIdFromIds) {
              resolved.set(`${map}:${row.partitionId}`, row.displayName);
            }
          }
        } catch {
          // Leave this map on the partition-number fallback.
        }
      }));
      if (!cancelled && resolved.size) setInstanceNames(resolved);
    })();
    return () => { cancelled = true; };
  }, [partitionMapsKey]);

  // A background flush drains the queue whenever a map goes down, which can
  // happen without anyone touching this panel. When the count drops, the fuel
  // numbers on screen are stale, so refetch the table.
  useEffect(() => {
    if (!canQueue || !pendingRefills) return;
    const previous = previousPendingTotal.current;
    previousPendingTotal.current = pendingRefills.total;
    if (previous === null || pendingRefills.total >= previous) return;
    basesCache = null;
    void load({ q: submittedQ, page, pageSize, sortColumn, sortDirection }, { silent: true });
  }, [canQueue, pendingRefills, load, submittedQ, page, pageSize, sortColumn, sortDirection]);

  // Mirror the module cache into this instance's state, and stay subscribed so a
  // restart still in flight from a previous mount reports here when it finishes.
  useEffect(() => {
    const sync = () => {
      const cached = readCachedRefillStatus();
      setRefillResult(cached.text);
      setRefillStatus(cached.kind);
      setRestartingTargets(restartingTargetsCache);
    };
    refillStatusSubscribers.add(sync);
    sync();
    return () => { refillStatusSubscribers.delete(sync); };
  }, []);

  // The .result-ok/.result-fail rules animate a "fade-result" keyframes that does
  // not exist, so nothing clears a finished message by itself -- which is why a
  // restart notice used to sit on screen indefinitely. Retire the success case
  // here. Failures stay until the next action: losing an error is worse than a
  // stale one, and a running notice must never vanish mid-restart.
  useEffect(() => {
    if (refillStatus !== "ok") return;
    const timer = window.setTimeout(() => writeRefillStatus("", ""), REFILL_STATUS_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [refillStatus, refillResult]);

  async function handleDownloadBlueprint(row: BaseRow) {
    const id = String(row.base_id);
    setDownloadingId(id);
    try {
      const response = await apiDownload(`/api/bases/${encodeURIComponent(id)}/export`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      const responseFilename = response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1];
      anchor.download = responseFilename
        || `${String(row.owner_name || "unknown_player").replace(/[^a-zA-Z0-9_-]/g, "_")}_base_${id}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      onError(errorText(error));
    } finally {
      setDownloadingId("");
    }
  }

  async function handleRefillGenerators(base: BaseRow) {
    const id = String(base.base_id);
    const count = Number(base.generatorCount) || 0;
    const confirmed = await confirmAction(
      `Refill ${count} power device${count === 1 ? "" : "s"} at "${base.name || `base ${id}`}" to full fuel?`,
      {
        title: "Refill Generators",
        confirmLabel: "Refill",
        warning: canQueue
          ? "If this base's map is running, the refill is queued and applied the next time that map restarts or stops, so a live server cannot overwrite it. If the map is already down, it is written now."
          : "Refill writes fuel straight to the database. A running game server will not show the new fuel in-game until the map server restarts."
      }
    );
    if (!confirmed) return;
    onError("");
    setRefillingId(id);
    try {
      const response = await basesApi.refillGenerators(id);
      writeRefillStatus(summarizeRefill(response) || formatMutationResult(response), "ok");
      if (response.result?.queued) {
        await refreshPendingRefills();
      } else {
        // The module cache still holds pre-refill fuel counts for this view.
        basesCache = null;
        await load({ q: submittedQ, page, pageSize, sortColumn, sortDirection });
      }
    } catch (error) {
      const text = errorText(error);
      writeRefillStatus(text, "fail");
      onError(text);
    } finally {
      setRefillingId("");
    }
  }

  async function handleCancelQueuedRefill(base: BaseRow) {
    const id = String(base.base_id);
    const label = base.name || `base ${id}`;
    const confirmed = await confirmAction(`Cancel the queued generator refill for "${label}"?`, {
      title: "Cancel Queued Refill",
      confirmLabel: "Cancel Refill"
    });
    if (!confirmed) return;
    onError("");
    setCancelingId(id);
    try {
      await basesApi.cancelQueuedRefill(id);
      writeRefillStatus(`Queued refill for "${label}" was canceled.`, "ok");
      await refreshPendingRefills();
    } catch (error) {
      const text = errorText(error);
      writeRefillStatus(text, "fail");
      onError(text);
    } finally {
      setCancelingId("");
    }
  }

  // Mirrors handleRefillGenerators. No generatorCount-style count in the
  // confirm copy: the Water tab's own container list is fetched on demand,
  // not part of this row's data, so there is nothing to count without an
  // extra request just for the confirm dialog's wording.
  async function handleRefillWater(base: BaseRow) {
    const id = String(base.base_id);
    const confirmed = await confirmAction(
      `Refill water storage at "${base.name || `base ${id}`}" to full?`,
      {
        title: "Refill Water",
        confirmLabel: "Refill",
        warning: canQueueWater
          ? "If this base's map is running, the refill is queued and applied the next time that map restarts or stops, so a live server cannot overwrite it. If the map is already down, it is written now. Blood is never touched -- only water."
          : "Refill writes water straight to the database. A running game server will not show the new water in-game until the map server restarts. Blood is never touched -- only water."
      }
    );
    if (!confirmed) return;
    onError("");
    setRefillingWaterId(id);
    try {
      const response = await basesApi.refillWater(id);
      writeRefillStatus(summarizeWaterRefill(response) || formatMutationResult(response), "ok");
      if (response.result?.queued) {
        await refreshPendingWaterRefills();
      } else {
        // Unlike generator fuel, water isn't part of the row/list data --
        // BaseWaterTab fetches it separately -- so an immediate (non-queued)
        // write needs its own signal to make an already-open Water tab refetch.
        setWaterRefreshToken((token) => token + 1);
      }
    } catch (error) {
      const text = errorText(error);
      writeRefillStatus(text, "fail");
      onError(text);
    } finally {
      setRefillingWaterId("");
    }
  }

  async function handleCancelQueuedWaterRefill(base: BaseRow) {
    const id = String(base.base_id);
    const label = base.name || `base ${id}`;
    const confirmed = await confirmAction(`Cancel the queued water refill for "${label}"?`, {
      title: "Cancel Queued Refill",
      confirmLabel: "Cancel Refill"
    });
    if (!confirmed) return;
    onError("");
    setCancelingWaterId(id);
    try {
      await basesApi.cancelQueuedWaterRefill(id);
      writeRefillStatus(`Queued water refill for "${label}" was canceled.`, "ok");
      await refreshPendingWaterRefills();
    } catch (error) {
      const text = errorText(error);
      writeRefillStatus(text, "fail");
      onError(text);
    } finally {
      setCancelingWaterId("");
    }
  }

  const refreshAutoRefill = useCallback(async () => {
    try {
      const state = await basesApi.autoRefill();
      setAutoRefillBases(new Map(state.bases.map((entry) => [String(entry.baseId), entry])));
      setAutoRefillThreshold(state.thresholdPercent);
      setAutoRefillIntervalHours(state.intervalHours);
      setAutoRefillUnavailable(false);
    } catch {
      // Failing to read enrollment must not blank the bases list, which is this
      // panel's actual job -- but it must not be reported as "off" either.
      // Clearing the map here would render every enrolled base as OFF and let an
      // operator conclude automation had stopped, so whatever was last known is
      // kept and the state is flagged as unread instead.
      setAutoRefillUnavailable(true);
    }
  }, []);

  // canQueue arrives with the first list response, so this fires once the
  // capability is known rather than on mount with an unknown capability.
  useEffect(() => {
    if (!canQueue) return;
    void refreshAutoRefill();
  }, [canQueue, refreshAutoRefill]);

  const refreshAutoRefillWater = useCallback(async () => {
    try {
      const state = await basesApi.autoRefillWater();
      setAutoRefillWaterBases(new Map(state.bases.map((entry) => [String(entry.baseId), entry])));
      setAutoRefillWaterThreshold(state.thresholdPercent);
      setAutoRefillWaterIntervalHours(state.intervalHours);
      setAutoRefillWaterUnavailable(false);
    } catch {
      setAutoRefillWaterUnavailable(true);
    }
  }, []);

  useEffect(() => {
    if (!canQueueWater) return;
    void refreshAutoRefillWater();
  }, [canQueueWater, refreshAutoRefillWater]);

  async function handleToggleAutoRefill(base: BaseRow, nextEnabled: boolean) {
    const id = String(base.base_id);
    const label = base.name || `base ${id}`;
    if (nextEnabled) {
      const confirmed = await confirmAction(
        `Turn on auto-refill for "${label}"?`,
        {
          title: "Auto-Refill",
          confirmLabel: "Turn On",
          warning: `Every ${autoRefillIntervalHours}h this base is checked, and a refill is queued if any generator holds less than ${autoRefillThreshold}% of its fuel cap. Queued refills are written the next time this base's map restarts or stops — auto-refill never restarts a map by itself.`
        }
      );
      if (!confirmed) return;
    }
    onError("");
    setSavingAutoRefillId(id);
    try {
      const result = await basesApi.setAutoRefill(id, nextEnabled);
      // A successful write proves the endpoint is reachable again, so recover the
      // full picture rather than leaving the rest of the panel on stale data.
      if (autoRefillUnavailable) {
        void refreshAutoRefill();
      }
      // The response is authoritative, so no list refetch: enrollment is not
      // part of a base row, and basesApi.list is expensive.
      setAutoRefillBases((current) => {
        const next = new Map(current);
        if (result.enabled) {
          next.set(id, next.get(id) || {
            baseId: Number(id),
            enabledAt: new Date().toISOString(),
            lastCheckedAt: "",
            lastQueuedAt: "",
            lastLowestPercent: null,
            consecutiveQueues: 0,
            stalledAt: ""
          });
        } else {
          next.delete(id);
        }
        return next;
      });
      writeRefillStatus(
        result.enabled
          ? `Auto-refill is on for "${label}". Checked every ${autoRefillIntervalHours}h.`
          : `Auto-refill is off for "${label}".`,
        "ok"
      );
    } catch (error) {
      const text = errorText(error);
      writeRefillStatus(text, "fail");
      onError(text);
    } finally {
      setSavingAutoRefillId("");
    }
  }

  // Mirrors handleToggleAutoRefill.
  async function handleToggleAutoRefillWater(base: BaseRow, nextEnabled: boolean) {
    const id = String(base.base_id);
    const label = base.name || `base ${id}`;
    if (nextEnabled) {
      const confirmed = await confirmAction(
        `Turn on water auto-refill for "${label}"?`,
        {
          title: "Auto-Refill Water",
          confirmLabel: "Turn On",
          warning: `Every ${autoRefillWaterIntervalHours}h this base is checked, and a refill is queued if any water container holds less than ${autoRefillWaterThreshold}% of its capacity. Queued refills are written the next time this base's map restarts or stops — auto-refill never restarts a map by itself. Blood is never touched -- only water.`
        }
      );
      if (!confirmed) return;
    }
    onError("");
    setSavingAutoRefillWaterId(id);
    try {
      const result = await basesApi.setAutoRefillWater(id, nextEnabled);
      if (autoRefillWaterUnavailable) {
        void refreshAutoRefillWater();
      }
      setAutoRefillWaterBases((current) => {
        const next = new Map(current);
        if (result.enabled) {
          next.set(id, next.get(id) || {
            baseId: Number(id),
            enabledAt: new Date().toISOString(),
            lastCheckedAt: "",
            lastQueuedAt: "",
            lastLowestPercent: null,
            consecutiveQueues: 0,
            stalledAt: ""
          });
        } else {
          next.delete(id);
        }
        return next;
      });
      writeRefillStatus(
        result.enabled
          ? `Water auto-refill is on for "${label}". Checked every ${autoRefillWaterIntervalHours}h.`
          : `Water auto-refill is off for "${label}".`,
        "ok"
      );
    } catch (error) {
      const text = errorText(error);
      writeRefillStatus(text, "fail");
      onError(text);
    } finally {
      setSavingAutoRefillWaterId("");
    }
  }

  // Restarting a partition/service already flushes whichever queue(s) have
  // entries waiting on it -- server.js's onMapDown hook fires both
  // flushQueuedGeneratorRefills and flushQueuedWaterRefills unconditionally --
  // so one restart call covers a target with fuel, water, or both queued, and
  // the combined banner below only needs a single handler rather than two.
  async function handleRestartForCombinedQueue(group: { map: string; partitionId: number; partitionMap: string; dimensionIndex: number; fuelCount: number; waterCount: number }) {
    const target = queueRestartTarget(group.partitionMap, group.partitionId, group.dimensionIndex);
    if (target.kind === "none") return;
    const key = `${group.map}|${group.partitionId}`;
    const parts = [];
    if (group.fuelCount) parts.push(`${group.fuelCount} queued generator refill${group.fuelCount === 1 ? "" : "s"}`);
    if (group.waterCount) parts.push(`${group.waterCount} queued water refill${group.waterCount === 1 ? "" : "s"}`);
    const confirmed = await confirmAction(
      `${target.label} now to apply ${parts.join(" and ")}?`,
      {
        title: "Restart Map",
        confirmLabel: "Restart",
        warning: "Players on this map are disconnected while it restarts."
      }
    );
    if (!confirmed) return;
    onError("");
    writeRestartingTarget(key, true);
    const label = group.partitionMap || group.map;
    try {
      // No trailing period: the running state appends animated dots.
      writeRefillStatus(`Restarting ${label}, its queued refills apply while it is down`, "running");
      const started = target.kind === "sietch" ? await mapsApi.restartSietch(String(target.partitionId))
        : target.kind === "respawn" ? await mapsApi.respawn(String(target.partitionId), "RESTART MAP")
        : await serverApi.restartService(target.service);
      // Report what the restart actually did. Without this the running line
      // stands forever and a failed restart reads as a successful one.
      const finished = await waitForTask(started.task);
      const [refreshedFuel, refreshedWater] = await Promise.all([refreshPendingRefills(), refreshPendingWaterRefills()]);
      if (finished.status === "succeeded") {
        // The flush races the restart's own write-safety window, so a
        // succeeded task does not guarantee the refill actually landed --
        // check both queues rather than assume.
        const stillQueued = Boolean(
          pendingRefillCountForPartition(refreshedFuel, group.partitionId)
          || pendingRefillCountForPartition(refreshedWater, group.partitionId)
        );
        writeRefillStatus(
          stillQueued
            ? `${label} restarted. Its refills are still queued and will apply once the map is confirmed down.`
            : `${label} restarted. Any refills queued for it have been applied.`,
          "ok"
        );
      } else {
        const text = `${label} restart ${finished.status}. Its refills are still queued.`;
        writeRefillStatus(text, "fail");
        onError(text);
      }
    } catch (error) {
      const text = errorText(error);
      writeRefillStatus(text, "fail");
      onError(text);
    } finally {
      writeRestartingTarget(key, false);
    }
  }

  // Move focus into a row that has just opened. The expanded panel renders below
  // the row, so without this the focus stays on the chevron and the content can
  // open below the fold. Keyed on the base id alone: switching tabs already
  // focuses the tab that was clicked, and re-focusing on every tab change would
  // fight the user.
  //
  // Must stay above the `loading` early return -- a hook after it changes the
  // hook count between renders.
  useEffect(() => {
    if (!expandedBaseId || lastExpandedRef.current === expandedBaseId) {
      lastExpandedRef.current = expandedBaseId;
      return;
    }
    lastExpandedRef.current = expandedBaseId;
    // Synchronous, not deferred to a frame: the expanded row is committed by the
    // time this effect runs, and a requestAnimationFrame callback never fires
    // while the tab is backgrounded -- which would silently drop the focus move.
    const tab = document.querySelector<HTMLButtonElement>(".bases-expanded-tab.active");
    tab?.focus({ preventScroll: true });
    // Bring the opened panel into view. The table lives in a `.table-wrap`
    // scrollport with its own overflow-y, so the element that needs scrolling is
    // usually that container rather than the window -- scrollIntoView walks every
    // scrollable ancestor and handles both, which hand-rolled window.scrollBy
    // arithmetic does not.
    //
    // block:"nearest" leaves an already-visible panel alone, so opening a row
    // near the top never jumps the view, and aligns the top edge when the panel
    // is taller than the scrollport (showing its start rather than its middle).
    // No behavior:"smooth" -- it is compositor-driven and does not settle
    // reliably in a backgrounded tab.
    //
    // Optional call: jsdom does not implement scrollIntoView, and scrolling is a
    // nicety -- the focus move is the part that matters.
    const panel = document.querySelector<HTMLElement>(".bases-table tbody tr.expanded-row");
    (panel ?? tab)?.scrollIntoView?.({ block: "nearest" });
  }, [expandedBaseId]);

  if (loading) {
    return <section className="panel">
      <div className="panel-title"><h2>Bases</h2></div>
      <div className="loading-panel">
        <span className="spinner" aria-hidden="true" />
        <strong className="loading-dots">Loading Bases</strong>
      </div>
    </section>;
  }

  const pendingTotal = pendingRefills?.total || 0;
  const queuedBaseIds = new Set((pendingRefills?.pending || []).map((entry) => String(entry.baseId)));
  const staleQueued = (pendingRefills?.pending || []).filter((entry) => {
    const queuedAt = Date.parse(entry.queuedAt);
    return Number.isFinite(queuedAt) && Date.now() - queuedAt > STALE_QUEUED_REFILL_MS;
  });
  const staleTargetKeys = new Set(staleQueued.map((entry) => `${entry.map || "Unknown"}|${entry.partitionId}`));
  // With no enrollment read at all, the toggle cannot honestly show ON or OFF.
  const autoRefillUnrecoverable = autoRefillUnavailable && autoRefillBases.size === 0;
  // autoRefillBases is fetched globally (GET /api/bases/auto-refill), same
  // scope as pendingRefills, so this counts stalled bases across the whole
  // battlegroup -- not just whatever page of the list happens to be loaded.
  const stalledFuelBaseIds = new Set([...autoRefillBases.entries()].filter(([, entry]) => entry.stalledAt).map(([baseId]) => baseId));

  // Mirrors the block above, for the water refill queue.
  const pendingWaterTotal = pendingWaterRefills?.total || 0;
  const queuedWaterBaseIds = new Set((pendingWaterRefills?.pending || []).map((entry) => String(entry.baseId)));
  const staleQueuedWater = (pendingWaterRefills?.pending || []).filter((entry) => {
    const queuedAt = Date.parse(entry.queuedAt);
    return Number.isFinite(queuedAt) && Date.now() - queuedAt > STALE_QUEUED_REFILL_MS;
  });
  const staleWaterTargetKeys = new Set(staleQueuedWater.map((entry) => `${entry.map || "Unknown"}|${entry.partitionId}`));
  const autoRefillWaterUnrecoverable = autoRefillWaterUnavailable && autoRefillWaterBases.size === 0;
  const stalledWaterBaseIds = new Set([...autoRefillWaterBases.entries()].filter(([, entry]) => entry.stalledAt).map(([baseId]) => baseId));

  // Combined queue banner: one box covering both queues. Merge byTarget rows
  // keyed on map|partitionId -- restarting a target already flushes
  // whichever queue(s) are waiting on it (see handleRestartForCombinedQueue),
  // so one restart button per target is correct even though the fuel/water
  // counts come from two separate endpoints.
  type CombinedQueueTarget = { map: string; partitionId: number; partitionMap: string; dimensionIndex: number; fuelCount: number; waterCount: number };
  const combinedQueueTargets: CombinedQueueTarget[] = (() => {
    const byKey = new Map<string, CombinedQueueTarget>();
    for (const group of pendingRefills?.byTarget || []) {
      byKey.set(`${group.map}|${group.partitionId}`, {
        map: group.map, partitionId: group.partitionId, partitionMap: group.partitionMap, dimensionIndex: group.dimensionIndex,
        fuelCount: group.count, waterCount: 0
      });
    }
    for (const group of pendingWaterRefills?.byTarget || []) {
      const key = `${group.map}|${group.partitionId}`;
      const existing = byKey.get(key);
      if (existing) existing.waterCount = group.count;
      else byKey.set(key, {
        map: group.map, partitionId: group.partitionId, partitionMap: group.partitionMap, dimensionIndex: group.dimensionIndex,
        fuelCount: 0, waterCount: group.count
      });
    }
    return [...byKey.values()];
  })();
  const combinedQueueTotal = pendingTotal + pendingWaterTotal;
  // Whether any stale entry actually has a restart button in the list above. A
  // group whose partition does not resolve renders "Restart this map from the
  // Maps tab" instead, so pointing at a button that is not there would be wrong.
  const combinedStaleTargetKeys = new Set([...staleTargetKeys, ...staleWaterTargetKeys]);
  const combinedStaleCount = staleQueued.length + staleQueuedWater.length;
  const combinedStaleHasRestartButton = combinedQueueTargets.some((group) =>
    combinedStaleTargetKeys.has(`${group.map}|${group.partitionId}`)
    && queueRestartTarget(group.partitionMap, group.partitionId, group.dimensionIndex).kind !== "none");

  // Combined stalled auto-refill banner: the headline counts unique bases,
  // not queue entries -- a base stalled on both fuel and water should not
  // read as "2 bases have stalled auto-refill" when it is one base with two
  // badges (each badge below does count occurrences, i.e. queue entries).
  const stalledCombinedBaseIds = new Set([...stalledFuelBaseIds, ...stalledWaterBaseIds]);
  const stalledCombinedCount = stalledCombinedBaseIds.size;
  const stalledFuelCount = stalledFuelBaseIds.size;
  const stalledWaterCount = stalledWaterBaseIds.size;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const rangeStart = totalCount === 0 ? 0 : page * pageSize + 1;
  const rangeEnd = totalCount === 0 ? 0 : rangeStart + rows.length - 1;
  const hasPreviousPage = page > 0;
  const hasNextPage = page + 1 < totalPages;

  function changePageSize(nextSize: number) {
    setPageSize(nextSize);
    setPage(0);
  }

  function toggleExpanded(id: string) {
    setExpandedBaseId((current) => {
      // Opening a different base starts on Power again; leaving the previous
      // row's tab selected would drop you into Permissions for a base you only
      // wanted to glance at.
      if (current !== id) setExpandedTab("power");
      return current === id ? null : id;
    });
  }

  function handleSort(column: string) {
    setPage(0);
    if (column === sortColumn) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortColumn(column);
    setSortDirection("asc");
  }

  return (
    <section className="panel">
      <div className="panel-title">
        <h2>Bases</h2>
        <div className="action-row">
          <button onClick={() => void load({ q: submittedQ, page, pageSize, sortColumn, sortDirection })}>Refresh</button>
        </div>
      </div>
      <p className="action-help-note">
        Total Bases: {totalBases.toLocaleString()} · Total Building Pieces: {totalPieces.toLocaleString()} · Total Placeables: {totalPlaceables.toLocaleString()}
      </p>
      {stalledCombinedCount > 0 && <div className="bases-stalled-banner" role="alert">
        <p className="bases-stalled-banner-title">
          {stalledCombinedCount.toLocaleString()} base{stalledCombinedCount === 1 ? " has" : "s have"} stalled auto-refill
          {stalledFuelCount > 0 && <span className="bases-queue-badge bases-queue-badge-fuel">
            <Fuel size={13} aria-hidden="true" />{stalledFuelCount.toLocaleString()} fuel
          </span>}
          {stalledWaterCount > 0 && <span className="bases-queue-badge bases-queue-badge-water">
            <Droplet size={13} aria-hidden="true" />{stalledWaterCount.toLocaleString()} water
          </span>}
        </p>
        <p className="action-help-note">
          Auto-refill queued 3 refills without raising the {stalledFuelCount > 0 && stalledWaterCount > 0 ? "fuel or water" : stalledFuelCount > 0 ? "fuel" : "water"} on {stalledCombinedCount === 1 ? "this base" : "these bases"}. Refill manually to find out why, or turn auto-refill off and back on to resume trying.
        </p>
      </div>}
      {combinedQueueTotal > 0 && <div className="bases-pending-refills">
        {/* Per-resource counts rather than two bare icons over a combined
            total: "2 refills queued" beside a fuel and a water icon does not
            say which is which, and the split is what decides whether you go
            looking at generators or at water containers. Same badge vocabulary
            as the stalled banner above and the per-map rows below. */}
        <p className="bases-pending-refills-title">
          {/* Explicit spaces around the badges: they are inline elements, so
              without them the text content reads "Refills queued2 fuel1 water"
              to a screen reader and to anyone copying it. */}
          Refills queued
          {pendingTotal > 0 && <> <span className="bases-queue-badge bases-queue-badge-fuel">
            <Fuel size={13} aria-hidden="true" />{pendingTotal.toLocaleString()} fuel
          </span></>}
          {pendingWaterTotal > 0 && <> <span className="bases-queue-badge bases-queue-badge-water">
            <Droplet size={13} aria-hidden="true" />{pendingWaterTotal.toLocaleString()} water
          </span></>}
        </p>
        <p className="action-help-note">
          {/* No battlegroup-level advice here: this banner only offers the
              per-map restart buttons below, so pointing at a control that
              lives on another page is noise. Server Control's note still
              covers the battlegroup case, next to the button that does it. */}
          Each one is written when its map next restarts.
        </p>
        <ul className="bases-pending-refills-list">
          {combinedQueueTargets.map((group) => {
            const target = queueRestartTarget(group.partitionMap, group.partitionId, group.dimensionIndex);
            const key = `${group.map}|${group.partitionId}`;
            return <li key={key}>
              <span>
                {group.map}
                {group.partitionMap && group.partitionMap !== group.map ? ` (${group.partitionMap})` : ""}
                {group.partitionId ? ` · partition ${group.partitionId}` : ""}
              </span>
              {group.fuelCount > 0 && <span className="bases-queue-badge bases-queue-badge-fuel">
                <Fuel size={13} aria-hidden="true" />{group.fuelCount.toLocaleString()}
              </span>}
              {group.waterCount > 0 && <span className="bases-queue-badge bases-queue-badge-water">
                <Droplet size={13} aria-hidden="true" />{group.waterCount.toLocaleString()}
              </span>}
              {target.kind === "none"
                ? <span className="muted">Restart this map from the Maps tab</span>
                : restartingTargets.includes(key)
                  ? <span className="bases-restarting-pill">
                      <span className="spinner" aria-hidden="true" />
                      <span className="loading-dots" role="status">Restarting</span>
                    </span>
                  : <button onClick={() => void handleRestartForCombinedQueue(group)}>{target.label}</button>}
            </li>;
          })}
        </ul>
        {combinedStaleCount > 0 && <p className="bases-pending-refills-stale" role="status">
          {combinedStaleCount.toLocaleString()} queued over 24h — {combinedStaleCount === 1 ? "its map has" : "their maps have"} not been down since. {combinedStaleHasRestartButton ? "Restart above to apply." : "Restart from the Maps tab to apply."}
        </p>}
      </div>}
      {refillResult && <p
        className={`inline-task-result bases-refill-status${refillStatus ? ` result-${refillStatus}` : ""}`}
        role={refillStatus === "fail" ? "alert" : "status"}
      >
        {refillStatus === "running" && <span className="spinner" aria-hidden="true" />}
        <strong className={refillStatus === "running" ? "loading-dots" : ""}>{refillResult}</strong>
      </p>}
      <div className="action-row bases-search-row">
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") submitSearch(); }}
          placeholder="Search name, type, or owner"
        />
        <button onClick={submitSearch}>Search</button>
        <button onClick={handleClearSearch} disabled={!q && !submittedQ}>Clear</button>
      </div>
      <DataTable
        rows={rows}
        columns={["base_id", "name", "base_type", "owner_name", "shared_with", "map", "generators", "piece_count", "placeable_count", "coordinates"]}
        columnLabels={{
          base_id: "ID",
          name: "Base Name",
          base_type: "Base Type",
          owner_name: "Owner",
          shared_with: "Shared With",
          map: "Map",
          generators: "Generators",
          piece_count: "Building Pieces",
          placeable_count: "Placeables",
          coordinates: "Coordinates"
        }}
        tableClassName="bases-table"
        wrapClassName="bases-table-wrap"
        headerTitles
        actionClassName="actions-column bases-actions-column"
        renderCell={(row, column) => renderBaseCell(row, column, instanceNames)}
        action={(row) => {
          const base = row as BaseRow;
          const id = String(base.base_id);
          const refillable = canRefill && base.generatorDataAvailable && (Number(base.generatorCount) || 0) > 0;
          // Auto-refill is shown by restyling this button rather than by adding a
          // control: the column is a fixed width and already holds one button per
          // refillable resource. The button stays clickable when enrolled, so
          // turning automation on never costs the on-demand refill.
          const autoRefillEntryForRow = autoRefillBases.get(id);
          const autoRefillOn = Boolean(autoRefillEntryForRow);
          const autoRefillStalled = Boolean(autoRefillEntryForRow?.stalledAt);
          const refillTitle = !canRefill ? "Refill is unsupported on this database"
            : !base.generatorDataAvailable ? "Generator data is unavailable for this base"
            : !refillable ? "No generators at this base"
            : autoRefillStalled ? `Auto-refill has stalled after ${autoRefillEntryForRow?.consecutiveQueues || 3} refills that did not raise the fuel. Click to refill now.`
            : autoRefillOn ? `Auto-refill is on — checked every ${autoRefillIntervalHours}h below ${autoRefillThreshold}%. Click to refill now.`
            : "Refill Generators";
          // Water isn't bundled into this row's data (fetched on demand in the
          // Water tab instead), so there is no per-row "has water storage"
          // signal to disable on the way generator's `refillable` does --
          // this is enabled whenever the capability exists, and a base with
          // none simply reports "No water storage was found" on click.
          const autoRefillWaterEntryForRow = autoRefillWaterBases.get(id);
          const autoRefillWaterOn = Boolean(autoRefillWaterEntryForRow);
          const autoRefillWaterStalled = Boolean(autoRefillWaterEntryForRow?.stalledAt);
          const refillWaterTitle = !canRefillWater ? "Water refill is unsupported on this database"
            : autoRefillWaterStalled ? `Water auto-refill has stalled after ${autoRefillWaterEntryForRow?.consecutiveQueues || 3} refills that did not raise the water. Click to refill now.`
            : autoRefillWaterOn ? `Water auto-refill is on — checked every ${autoRefillWaterIntervalHours}h below ${autoRefillWaterThreshold}%. Click to refill now.`
            : "Refill Water";
          return <span className="icon-toggle-group">
            {/* The actions column is a fixed width, so the queued state stays a
                compact glyph pill rather than a text label: the banner above
                carries the wording, and each glyph has its own tooltip. */}
            {queuedBaseIds.has(id)
              ? <span className="bases-queued-refill" title="Refill queued — applies when this map next restarts or stops">
                  <Fuel size={16} aria-label="Refill queued for this base" />
                  <button
                    className="icon-toggle-button bases-queued-refill-cancel"
                    title="Cancel Queued Refill"
                    aria-label="Cancel Queued Refill"
                    disabled={cancelingId === id}
                    onClick={(event) => { event.stopPropagation(); void handleCancelQueuedRefill(base); }}
                  ><X size={14} /></button>
                </span>
              : <button
                  className={`icon-toggle-button${autoRefillStalled ? " bases-auto-refill-stalled-icon" : autoRefillOn ? " bases-auto-refill-on" : ""}`}
                  title={refillTitle}
                  aria-label={autoRefillStalled ? "Refill Generators (auto-refill stalled)" : autoRefillOn ? "Refill Generators (auto-refill on)" : "Refill Generators"}
                  disabled={!refillable || refillingId === id}
                  onClick={(event) => { event.stopPropagation(); void handleRefillGenerators(base); }}
                ><Fuel size={16} /></button>}
            {queuedWaterBaseIds.has(id)
              ? <span className="bases-queued-refill" title="Water refill queued — applies when this map next restarts or stops">
                  <Droplet size={16} aria-label="Water refill queued for this base" />
                  <button
                    className="icon-toggle-button bases-queued-refill-cancel"
                    title="Cancel Queued Refill"
                    aria-label="Cancel Queued Water Refill"
                    disabled={cancelingWaterId === id}
                    onClick={(event) => { event.stopPropagation(); void handleCancelQueuedWaterRefill(base); }}
                  ><X size={14} /></button>
                </span>
              : <button
                  className={`icon-toggle-button${autoRefillWaterStalled ? " bases-auto-refill-stalled-icon" : autoRefillWaterOn ? " bases-auto-refill-on" : ""}`}
                  title={refillWaterTitle}
                  aria-label={autoRefillWaterStalled ? "Refill Water (auto-refill stalled)" : autoRefillWaterOn ? "Refill Water (auto-refill on)" : "Refill Water"}
                  disabled={!canRefillWater || refillingWaterId === id}
                  onClick={(event) => { event.stopPropagation(); void handleRefillWater(base); }}
                ><Droplet size={16} /></button>}
            <button className="icon-toggle-button" title="Download Base as Blueprint" aria-label="Download Base as Blueprint" disabled={downloadingId === id} onClick={(event) => { event.stopPropagation(); void handleDownloadBlueprint(base); }}><Download size={16} /></button>
          </span>;
        }}
        secondaryActionPosition="start"
        secondaryActionLabel=""
        secondaryActionClassName="bases-expand-column"
        secondaryAction={(row) => {
          const base = row as BaseRow;
          const id = String(base.base_id);
          const isExpanded = expandedBaseId === id;
          // The chevron always renders now: every base can always be expanded
          // into at least the Water tab (fetched on demand, not gated on
          // per-row data the way generators are), so there is no longer a case
          // with nothing to expand into, and no need to pick a granular label.
          const label = `${isExpanded ? "Collapse" : "Show"} details for ${base.name || `base ${id}`}`;
          return <button
            className="bases-expand-button"
            title={label}
            aria-label={label}
            aria-expanded={isExpanded}
            onClick={(event) => { event.stopPropagation(); toggleExpanded(id); }}
          >{isExpanded ? <ChevronUp size={14} className="bases-expand-chevron" /> : <ChevronDown size={14} className="bases-expand-chevron" />}</button>;
        }}
        sortColumn={sortColumn}
        sortDirection={sortDirection}
        onSort={handleSort}
        nonSortableColumns={["generators"]}
        rowKey={(row) => String(row.base_id)}
        onRowClick={(row) => toggleExpanded(String(row.base_id))}
        isRowExpanded={(row) => expandedBaseId === String(row.base_id)}
        renderExpandedRow={(row) => {
          const base = row as BaseRow;
          const id = String(base.base_id);
          const renderPower = () => {
          if (!base.generatorDataAvailable) return <p className="muted">Generator data is currently unavailable.</p>;
          const generators = base.generators ?? [];
          if (!generators.length) return <p className="muted">No generators built at this base.</p>;
          const autoRefillEntry = autoRefillBases.get(id);
          const savingAutoRefill = savingAutoRefillId === id;
          const lastChecked = autoRefillEntry?.lastCheckedAt ? formatAgo(autoRefillEntry.lastCheckedAt) : "";
          // An InfoTooltip (the same component Maps uses for Host Memory
          // Protection / Memory Balancer / Memory Swap) rather than inline
          // text: the expanded row sits in a CSS grid of 240px generator-type
          // columns, so inline text here has no guaranteed width to render
          // into and either wraps unpredictably or silently truncates.
          // InfoTooltip's popover is absolutely positioned with its own fixed
          // max-width, so it has no such constraint -- and it matches the
          // rest of the app rather than a bare native title attribute.
          const autoRefillTooltip = `Checked every ${autoRefillIntervalHours}h. Queues a refill when any generator drops below ${autoRefillThreshold}%.`
            + (autoRefillEntry && lastChecked ? ` Last checked ${lastChecked}${autoRefillEntry.lastLowestPercent === null ? "" : ` — lowest ${autoRefillEntry.lastLowestPercent}%`}.` : "")
            + (autoRefillEntry && !lastChecked ? " Not checked yet." : "")
            + (autoRefillUnavailable ? " Last known state — the latest read failed." : "");
          return (
            <div className="bases-tab-body">
              {/* Hidden entirely without the queue capability: automating a
                  refill that cannot wait for a safe window would write into a
                  possibly-live base, which is the hazard the queue prevents. */}
              {(canQueue || base.generatorUptimeMultiplier > 1) && <div className="bases-auto-refill" onClick={(event) => event.stopPropagation()}>
                {base.generatorUptimeMultiplier > 1 && <div className="bases-uptime-event-inline" role="status">
                  <span className="bases-uptime-event-badge">{base.generatorUptimeMultiplier}× Uptime Event</span>
                  <small>Ends {formatEventThroughDate(base.generatorUptimeEventEndsAt)}</small>
                </div>}
                {canQueue && <>
                  {/* With no enrollment data at all, an OFF pill would be a claim
                      this panel cannot make. Say what is actually known instead. */}
                  {autoRefillUnrecoverable
                    ? <p className="bases-auto-refill-unknown" role="status">
                        Auto-refill state could not be read. <button onClick={() => void refreshAutoRefill()}>Retry</button>
                      </p>
                    : <div className="memory-feature-toggle">
                        <InfoTooltip id={`auto-refill-help-${id}`} label="About Auto-Refill">{autoRefillTooltip}</InfoTooltip>
                        <label className={`switch-checkbox bases-auto-refill-toggle ${autoRefillEntry ? "enabled" : "disabled"}`}>
                          <input
                            type="checkbox"
                            checked={Boolean(autoRefillEntry)}
                            disabled={savingAutoRefill || !canRefill}
                            onChange={(event) => { void handleToggleAutoRefill(base, event.target.checked); }}
                          />
                          <span className="switch-label">Auto-Refill</span>
                          <strong className="switch-state">{savingAutoRefill ? "Saving" : autoRefillEntry ? "ON" : "OFF"}</strong>
                        </label>
                      </div>}
                  {/* Giving up has to be visible, or the operator believes fuel is
                      being handled while this base quietly stays empty. */}
                  {autoRefillEntry?.stalledAt && <p className="bases-auto-refill-stalled" role="alert">
                    Paused after {autoRefillEntry.consecutiveQueues} refills that did not raise this base's fuel. Refill manually to check why, or turn auto-refill off and on to resume.
                  </p>}
                </>}
              </div>}
              <p className="bases-generator-reserve-note" role="note">
                {QUEUED_RESERVE_EXPLANATION}
              </p>
              <div className="bases-card-grid">
              {generators.map((generator, index) => (
                <div className="bases-card" key={`${generator.type}-${index}`}>
                  <div className="bases-card-title">{generator.name}</div>
                  <dl className="bases-card-stats">
                    <dt>Generators</dt>
                    <dd>{generator.generatorCount.toLocaleString()}</dd>
                    <dt>Fuel Queued</dt>
                    <dd>{generator.fuelCells.toLocaleString()} {generator.fuelName}{generator.fuelCells === 1 ? "" : "s"}</dd>
                    {!hasNoQueuedFuel(generator.unstockedCount, generator.generatorCount) ? (
                      <>
                        <dt>Lowest Queued <br />Reserve</dt>
                        <dd>{formatRuntime(Number(generator.runtimeSeconds) || 0)}</dd>
                      </>
                    ) : null}
                    {generator.unstockedCount ? (
                      <>
                        <dt>No Queued Fuel</dt>
                        <dd>{generator.unstockedCount.toLocaleString()} of {generator.generatorCount.toLocaleString()}</dd>
                      </>
                    ) : null}
                  </dl>
                </div>
              ))}
              </div>
            </div>
          );
          };

          const autoRefillWaterEntry = autoRefillWaterBases.get(id);
          const savingAutoRefillWater = savingAutoRefillWaterId === id;
          const lastCheckedWater = autoRefillWaterEntry?.lastCheckedAt ? formatAgo(autoRefillWaterEntry.lastCheckedAt) : "";
          const autoRefillWaterTooltip = `Checked every ${autoRefillWaterIntervalHours}h. Queues a refill when any water container drops below ${autoRefillWaterThreshold}%. Blood is never touched.`
            + (autoRefillWaterEntry && lastCheckedWater ? ` Last checked ${lastCheckedWater}${autoRefillWaterEntry.lastLowestPercent === null ? "" : ` — lowest ${autoRefillWaterEntry.lastLowestPercent}%`}.` : "")
            + (autoRefillWaterEntry && !lastCheckedWater ? " Not checked yet." : "")
            + (autoRefillWaterUnavailable ? " Last known state — the latest read failed." : "");

          // Power and Water always render (Water needs no capability the way
          // Permissions does -- see baseWater's "no capability gate" note in
          // the plan); Permissions only when the schema supports it.
          return (
            <div className="bases-expanded-tabs" onClick={(event) => event.stopPropagation()}>
              <div className="bases-expanded-tablist" role="tablist" aria-label="Base details">
                <button
                  role="tab"
                  id={`bases-tab-power-${id}`}
                  aria-selected={expandedTab === "power"}
                  aria-controls={`bases-panel-power-${id}`}
                  className={`bases-expanded-tab${expandedTab === "power" ? " active" : ""}`}
                  onClick={() => setExpandedTab("power")}
                ><Zap size={15} aria-hidden="true" />Power</button>
                <button
                  role="tab"
                  id={`bases-tab-water-${id}`}
                  aria-selected={expandedTab === "water"}
                  aria-controls={`bases-panel-water-${id}`}
                  className={`bases-expanded-tab${expandedTab === "water" ? " active" : ""}`}
                  onClick={() => setExpandedTab("water")}
                ><Droplet size={15} aria-hidden="true" />Water</button>
                <button
                  role="tab"
                  id={`bases-tab-inventory-${id}`}
                  aria-selected={expandedTab === "inventory"}
                  aria-controls={`bases-panel-inventory-${id}`}
                  className={`bases-expanded-tab${expandedTab === "inventory" ? " active" : ""}`}
                  onClick={() => setExpandedTab("inventory")}
                ><Boxes size={15} aria-hidden="true" />Inventory</button>
                {canEditPermissions && <button
                  role="tab"
                  id={`bases-tab-permissions-${id}`}
                  aria-selected={expandedTab === "permissions"}
                  aria-controls={`bases-panel-permissions-${id}`}
                  className={`bases-expanded-tab${expandedTab === "permissions" ? " active" : ""}`}
                  // The label wraps onto two deliberate lines, so name the tab
                  // explicitly rather than letting the accessible name be
                  // assembled from two adjacent inline spans.
                  aria-label="Sub-Fief Permissions"
                  onClick={() => setExpandedTab("permissions")}
                ><Users size={15} aria-hidden="true" /><span className="bases-expanded-tab-lines">
                  <span>Sub-Fief</span>
                  <span>Permissions</span>
                </span></button>}
              </div>
              {expandedTab === "power"
                ? <div role="tabpanel" id={`bases-panel-power-${id}`} aria-labelledby={`bases-tab-power-${id}`}>{renderPower()}</div>
                : expandedTab === "water"
                ? <div role="tabpanel" id={`bases-panel-water-${id}`} aria-labelledby={`bases-tab-water-${id}`}>
                    <BaseWaterTab
                      baseId={id}
                      refreshToken={waterRefreshToken}
                      autoRefill={{
                        supported: canQueueWater,
                        unavailable: autoRefillWaterUnrecoverable,
                        enabled: Boolean(autoRefillWaterEntry),
                        saving: savingAutoRefillWater,
                        stalledAt: autoRefillWaterEntry?.stalledAt || "",
                        consecutiveQueues: autoRefillWaterEntry?.consecutiveQueues || 0,
                        canToggle: canRefillWater,
                        tooltip: autoRefillWaterTooltip,
                        onToggle: (enabled) => { void handleToggleAutoRefillWater(base, enabled); },
                        onRetry: () => { void refreshAutoRefillWater(); }
                      }}
                    />
                  </div>
                : expandedTab === "inventory"
                ? <div role="tabpanel" id={`bases-panel-inventory-${id}`} aria-labelledby={`bases-tab-inventory-${id}`}>
                    <BaseInventoryTab baseId={id} />
                  </div>
                : <div role="tabpanel" id={`bases-panel-permissions-${id}`} aria-labelledby={`bases-tab-permissions-${id}`}>
                    <BasePermissionsTab
                      baseId={id}
                      baseName={String(base.name || `base ${id}`)}
                      confirmAction={confirmAction}
                      // Owner and Shared With are rendered from the list
                      // response, so a saved roster has to refetch or the row
                      // above keeps showing the pre-edit names.
                      onSaved={() => {
                        basesCache = null;
                        void load({ q: submittedQ, page, pageSize, sortColumn, sortDirection }, { silent: true });
                      }}
                    />
                  </div>}
            </div>
          );
        }}
        emptyMessage="No bases have been found yet."
      />
      <div className="panel-title bases-pagination-footer">
        <p className="action-help-note">
          Showing {rangeStart}-{rangeEnd} of {totalCount} rows.
        </p>
        <div className="database-pagination-controls">
          <label className="compact-select">
            Rows
            <select value={String(pageSize)} onChange={(event) => changePageSize(Number(event.target.value))}>
              {BASES_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
          <button disabled={!hasPreviousPage} onClick={() => setPage(0)}>First</button>
          <button disabled={!hasPreviousPage} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="muted database-page-indicator">Page {page + 1} of {totalPages}</span>
          <button disabled={!hasNextPage} onClick={() => setPage(page + 1)}>Next</button>
          <button disabled={!hasNextPage} onClick={() => setPage(totalPages - 1)}>Last</button>
        </div>
      </div>
    </section>
  );
}
