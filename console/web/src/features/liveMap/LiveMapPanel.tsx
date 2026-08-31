import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Settings } from "lucide-react";
import { liveMapApi, type LiveMapConfig, type LiveMapMarker, type LiveMapPartition } from "../../api/liveMap";
import { mapsApi } from "../../api/maps";
import type { Task } from "../../api/setup";
import { DataTable } from "../../components/common/DataTable";
import { KeyValueGrid, StatusPill, TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { firstDefined, formatUiSentence, titleCase } from "../../lib/display";
import { friendlyInlineError } from "../players/playerAdminUtils";
import {
  clearDefaultLayerFilters,
  clearDefaultSubtypeLayerFilters,
  loadDefaultLayerFilters,
  loadDefaultSubtypeLayerFilters,
  saveDefaultLayerFilters,
  saveDefaultSubtypeLayerFilters
} from "./liveMapLayerDefaults";

// Layer keys whose visibility is capability-gated -- hidden from the legend
// entirely when the backend reports no data source for them (missing
// archive, table not present, etc). Player/vehicle/base/storage are not
// gated this way; they've always just shown with a zero count instead.
const GATED_LAYER_KEYS = new Set(["spice", "spice_active", "flour_sand", "ore", "scrap", "flora", "poi", "house_representative", "trainer", "fortress", "hazard", "enemy"]);

// Categories that expand into individual sub-types (e.g. Ores & Metals ->
// RhyoliteOre/AzuriteOre/...; Active Spice Blows -> Small/Medium/Large).
// Sub-type lists are derived dynamically from whatever `subtype` values are
// actually present in the loaded markers -- not curated -- so a new
// game-added resource type shows up with zero maintenance.
const EXPANDABLE_KEYS = new Set(["spice", "spice_active", "ore", "scrap", "flora", "poi", "house_representative", "trainer", "fortress", "hazard", "enemy", "vehicle"]);
// Zoom was capped at 100% (1 map-pixel-unit == 1 CSS pixel), too tight for
// precise marker/teleport placement.
const MAX_LIVE_MAP_ZOOM = 4;
// Minimum zoom is exactly the "contain" fit (the whole map visible, no
// scrollbar) -- 1 means no extra shrink past that; see liveMapMinimumZoom.
const MIN_ZOOM_FIT_FACTOR = 1;
// The live map's own map identifiers ("HaggaBasin"/"DeepDesert") aren't the
// instance names /api/maps/combat-state expects ("Survival_1"/"DeepDesert_1")
// -- same translation liveMapPartitions() does server-side, in reverse.
const LIVE_MAP_TO_COMBAT_STATE_MAP: Record<string, string> = { HaggaBasin: "Survival_1", DeepDesert: "DeepDesert_1" };
const SPICE_TIER_TYPES = new Set(["spice", "spice_active"]);
// These rows come from seed archives or the static world-marker atlas. They
// are loaded on entry/map changes and refreshed periodically, but are kept
// across the five-second live actor poll so thousands of unchanged markers
// are not queried and serialized again on every tick.
const STATIC_MARKER_TYPES = new Set(["spice", "ore", "scrap", "flora", "poi", "house_representative", "trainer", "fortress", "hazard", "enemy"]);
// The bottom data table only lists actor types -- resource/POI types
// (ore, poi, etc.) can number in the thousands and would flood a flat
// table with rows nobody's looking to scroll through there.
const TABLE_MARKER_TYPES = new Set(["player", "vehicle", "base", "storage"]);

// Optional third tier within an expanded category's sublist -- a function
// from subtype name to { group, label } (label is what renders instead of
// the raw subtype -- e.g. stripping a group's own name back off so it
// isn't repeated). Returning null leaves that subtype rendered flat,
// alongside the parent category's other ungrouped items -- "ore" groups
// every subtype (all Ore/Pickup). A resolver can also return
// `group: null` to supply a stripped label WITHOUT introducing a subgroup
// nesting tier -- e.g. "fortress" strips the "Fortress" suffix but still
// renders Atreides/Harkonnen as flat siblings, not nested one level deeper.
const SUBGROUP_RESOLVERS: Record<string, (subtype: string) => { group: string | null; label: string } | null> = {
  ore: (subtype) => ({ group: subtype.endsWith("Pickup") ? "Pickup" : "Ore", label: subtype.replace(/(Ore|Pickup|Rock)$/, "") || subtype }),
  scrap: (subtype) => {
    if (subtype.endsWith("Wreckage")) return { group: "Wreckage", label: subtype.slice(0, -"Wreckage".length) || subtype };
    if (subtype.endsWith("Part")) return { group: "Part", label: subtype.slice(0, -"Part".length) || subtype };
    return null;
  },
  house_representative: (subtype) => ({ group: null, label: subtype.startsWith("HouseRepresentative") ? subtype.slice("HouseRepresentative".length) : subtype }),
  trainer: (subtype) => ({ group: null, label: subtype.startsWith("Trainer") ? subtype.slice("Trainer".length) : subtype }),
  fortress: (subtype) => ({ group: null, label: subtype.endsWith("Fortress") ? subtype.slice(0, -"Fortress".length) : subtype }),
  // Light/Medium/Transport/Assault/bare Ornithopter all share one icon (no
  // per-variant art), so they cluster under one "Ornithopter" group the
  // same way the icon-less Ore/Pickup split does -- everything else
  // (Sandbike, Buggy, SandCrawler, TreadWheel, ContainerVehicle, Tank,
  // Other) stays flat since each already has (or deliberately lacks) its
  // own distinct icon.
  vehicle: (subtype) => (subtype.endsWith("Ornithopter") ? { group: "Ornithopter", label: subtype.replace(/Ornithopter$/, "") || "Ornithopter" } : null)
};
const SUBGROUP_ORDER = ["Ore", "Pickup", "Wreckage", "Part"];

type LegendItem =
  | { header: string }
  | { key: string };

// Static layout for the Layers legend: existing live-actor types stay
// ungrouped at top, then themed clusters matching the naming/grouping of
// https://lafamilia-gaming.eu/livemap.
const LEGEND_LAYOUT: LegendItem[] = [
  { key: "player" }, { key: "vehicle" }, { key: "base" }, { key: "storage" },
  { header: "Spice & Resources" },
  { key: "spice" }, { key: "spice_active" }, { key: "flour_sand" },
  { key: "ore" }, { key: "scrap" }, { key: "flora" },
  { header: "World" },
  { key: "poi" }, { key: "house_representative" }, { key: "trainer" }, { key: "fortress" }, { key: "hazard" }, { key: "enemy" }
];

// The app's own built-in starting point -- what a fresh browser with no
// saved "default layers" preference gets. Kept as a named constant so the
// settings popover's Reset action and the initial useState below share the
// exact same values instead of drifting apart.
const DEFAULT_LAYER_FILTERS: Record<string, boolean> = {
  player: true, vehicle: true, base: true, storage: false,
  spice: true, spice_active: true, flour_sand: true, ore: false, scrap: false, flora: false,
  poi: true, house_representative: true, trainer: true, fortress: false, hazard: false, enemy: false
};

// Which category keys fall under each section header, derived once from
// LEGEND_LAYOUT -- lets the section header's own toggle-all checkbox know
// what it's aggregating/cascading to without re-deriving it every render.
const SECTION_MEMBERS: Record<string, string[]> = (() => {
  const map: Record<string, string[]> = {};
  let section = "";
  for (const item of LEGEND_LAYOUT) {
    if ("header" in item) { section = item.header; map[section] = []; continue; }
    if (section) map[section].push(item.key);
  }
  return map;
})();

type HomeTaskResult = { status: "running" | "succeeded" | "failed" | "stopped"; title: string; message?: string; details?: string };
type ConfirmAction = (message: string, options?: { title?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; details?: { label: string; value: string; tone?: "danger" | "success" | "accent" }[] }) => Promise<boolean>;
type LiveMapPanelProps = {
  onError: (text: string) => void;
  confirmAction: ConfirmAction;
  waitForTask: (task: Task) => Promise<Task>;
  taskTechnicalDetails: (task: Task) => string;
  onOpenBase: (baseId: string) => void;
  onOpenVehicle: (vehicleId: string) => void;
};

function formatResultTitle(value: unknown, pending = false) {
  return formatUiSentence(value, pending);
}

function formatResultMessage(value: unknown) {
  return formatUiSentence(value, false);
}

// HTML checkboxes have no declarative `indeterminate` prop -- it has to be
// set imperatively on the DOM node.
function IndeterminateCheckbox({ checked, indeterminate, onChange }: { checked: boolean; indeterminate: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} onChange={onChange} />;
}

function HomeTaskResultCard({ result }: { result: HomeTaskResult }) {
  const pending = result.status === "running";
  return <div className={`result-panel home-task-result result-${result.status === "succeeded" || result.status === "stopped" ? "ok" : result.status === "failed" ? "fail" : "running"}`} aria-live="polite">
    <strong className={pending ? "loading-dots" : ""}>{formatResultTitle(result.title, pending)}</strong>
    {result.message && <p>{formatResultMessage(result.message)}</p>}
    {result.details && <TechnicalDetails title="Technical details" text={result.details} />}
  </div>;
}

export function LiveMapPanel({ onError, confirmAction, waitForTask, taskTechnicalDetails, onOpenBase, onOpenVehicle }: LiveMapPanelProps) {
  const [mapKey, setMapKey] = useState("HaggaBasin");
  const [mapConfig, setMapConfig] = useState<LiveMapConfig | null>(null);
  const [maps, setMaps] = useState<Record<string, LiveMapConfig>>({});
  const [partitions, setPartitions] = useState<LiveMapPartition[]>([]);
  const [partitionId, setPartitionId] = useState("");
  // The effective, merged Bgd.ServerDisplayName per partition -- the name a
  // player actually sees in-game (e.g. "Sietch Abbir", "Sietch Alraab PVP"),
  // not the shortened world_partition.label default. Supplementary metadata
  // only; a resolve failure must not block the Partition dropdown.
  const [partitionDisplayNames, setPartitionDisplayNames] = useState<Record<string, string>>({});
  const [markers, setMarkers] = useState<LiveMapMarker[]>([]);
  const [overlays, setOverlays] = useState<Record<string, string>>({});
  const [capabilities, setCapabilities] = useState<Record<string, unknown>>({});
  // "Pinned" marker (clicked -- stays open until a click lands outside every
  // marker) takes priority over "hoveredMarker" (transient preview, cleared
  // on mouseleave) -- see displayedMarker below.
  const [selected, setSelected] = useState<LiveMapMarker | null>(null);
  const [hoveredMarker, setHoveredMarker] = useState<LiveMapMarker | null>(null);
  const [filters, setFilters] = useState<Record<string, boolean>>(() => ({ ...DEFAULT_LAYER_FILTERS, ...loadDefaultLayerFilters() }));
  const [layerSettingsOpen, setLayerSettingsOpen] = useState(false);
  const [layerSettingsDraft, setLayerSettingsDraft] = useState<Record<string, boolean>>(DEFAULT_LAYER_FILTERS);
  const [layerSettingsSubtypeDraft, setLayerSettingsSubtypeDraft] = useState<Record<string, Record<string, boolean>>>({});
  const layerSettingsRef = useRef<HTMLDivElement | null>(null);
  const [coriolisSeed, setCoriolisSeed] = useState("");
  const [coriolisNextCycleAt, setCoriolisNextCycleAt] = useState("");
  const [coriolisSeedStaleSince, setCoriolisSeedStaleSince] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [subtypeFilters, setSubtypeFilters] = useState<Record<string, Record<string, boolean>>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [expandedSubgroups, setExpandedSubgroups] = useState<Record<string, Record<string, boolean>>>({});
  // Section headers (Spice & Resources / Wildlife / World) default to
  // expanded -- unlike category/sub-group expand state, which defaults to
  // collapsed -- so nothing vanishes on first load. A missing entry means
  // "expanded", not "collapsed".
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [zoom, setZoom] = useState(0.16);
  const [target, setTarget] = useState<{ x: number; y: number } | null>(null);
  const [loading, setLoading] = useState(false);
  // Distinct from `loading` -- that flips on every 5s auto-refresh poll too,
  // which would flicker the overlay constantly. This only tracks the load
  // triggered by switching map/partition, so the overlay appears just for
  // the switch itself.
  const [switching, setSwitching] = useState(false);
  const [drag, setDrag] = useState<{ x: number; y: number; left: number; top: number } | null>(null);
  const [playerDrag, setPlayerDrag] = useState<{ marker: LiveMapMarker; point: LiveMapPoint; startX: number; startY: number } | null>(null);
  const [playerTeleportPreview, setPlayerTeleportPreview] = useState<{ marker: LiveMapMarker; point: LiveMapPoint } | null>(null);
  const [teleportResult, setTeleportResult] = useState<HomeTaskResult | null>(null);
  // Which overlay marker has its "Teleport a player here" picker open --
  // identity-compared the same way as `selected`, not by reference, since
  // marker objects are replaced wholesale on every auto-refresh poll.
  const [teleportPickerFor, setTeleportPickerFor] = useState<LiveMapMarker | null>(null);
  const [teleportPickerPlayerId, setTeleportPickerPlayerId] = useState("");
  const frameRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const zoomAnchorRef = useRef<{ mapX: number; mapY: number; viewportX: number; viewportY: number } | null>(null);
  const liveMapDraggingPlayerRef = useRef(false);
  const pendingPlayerTeleportsRef = useRef<Record<string, { x: number; y: number; z: number; partitionId: number; expiresAt: number }>>({});
  async function load(includeStatic = true) {
    if (liveMapDraggingPlayerRef.current) return;
    onError("");
    setLoading(true);
    try {
      const result = await liveMapApi.markers(mapKey, partitionId, includeStatic);
      const rows = result.rows || [];
      setMarkers((previous) => {
        return applyPendingPlayerTeleports(mergeLiveMapRows(previous, rows, includeStatic, result.map?.actorMap));
      });
      // Merge newly-seen subtypes in (default visible, or whatever the user
      // saved as a default layer setting for it) -- never clobber a subtype
      // the user has already toggled off this session. A subtype with no
      // saved default of its own inherits its category's own on/off default
      // (DEFAULT_LAYER_FILTERS[type]) rather than hardcoding true -- without
      // this, a category whose default is off (e.g. ore: false) still shows
      // its top-level checkbox as checked, since that checkbox's state comes
      // from subtypeFilters, not filters, for expandable categories.
      const savedSubtypeDefaults = loadDefaultSubtypeLayerFilters();
      setSubtypeFilters((prev) => {
        const next: Record<string, Record<string, boolean>> = {};
        for (const key of Object.keys(prev)) next[key] = { ...prev[key] };
        for (const marker of rows) {
          const type = String(marker.type);
          const subtype = typeof marker.subtype === "string" ? marker.subtype : null;
          if (!EXPANDABLE_KEYS.has(type) || !subtype) continue;
          if (!next[type]) next[type] = {};
          if (!(subtype in next[type])) next[type][subtype] = savedSubtypeDefaults?.[type]?.[subtype] ?? DEFAULT_LAYER_FILTERS[type] ?? true;
        }
        return next;
      });
      setOverlays(result.overlays || {});
      setCapabilities((previous) => includeStatic ? (result.capabilities || {}) : ({ ...previous, ...(result.capabilities || {}) }));
      setMapConfig(result.map || null);
      setMaps(result.maps || {});
      setPartitions(result.partitions || []);
      setCoriolisSeed(result.coriolisSeed || "");
      setCoriolisNextCycleAt(result.coriolisNextCycleAt || "");
      setCoriolisSeedStaleSince(result.coriolisSeedStaleSince || "");
      if (!partitionId) {
        const mapName = result.map?.actorMap || result.map?.key;
        const available = (result.partitions || []).filter((row) => row.map === mapName);
        const preferred = available.find((row) => String(row.partition_id) === String(result.map?.defaultPartitionId)) || available[0];
        if (preferred) setPartitionId(String(preferred.partition_id));
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    setSwitching(true);
    load(true).finally(() => setSwitching(false));
  }, [mapKey, partitionId]);
  useEffect(() => {
    const combatStateMapName = LIVE_MAP_TO_COMBAT_STATE_MAP[mapKey];
    if (!combatStateMapName) { setPartitionDisplayNames({}); return; }
    let cancelled = false;
    mapsApi.combatState(combatStateMapName).then((result) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const partition of result.partitions || []) {
        const name = String(partition.serverDisplayName || "").trim();
        if (name) next[partition.partitionId] = name;
      }
      setPartitionDisplayNames(next);
    }).catch(() => {
      if (!cancelled) setPartitionDisplayNames({});
    });
    return () => { cancelled = true; };
  }, [mapKey]);
  useEffect(() => {
    if (!autoRefresh) return;
    const liveId = window.setInterval(() => void load(false), 5000);
    const staticId = window.setInterval(() => void load(true), 60000);
    return () => {
      window.clearInterval(liveId);
      window.clearInterval(staticId);
    };
  }, [autoRefresh, mapKey, partitionId]);
  useEffect(() => {
    if (!coriolisNextCycleAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [coriolisNextCycleAt]);
  useEffect(() => {
    if (!layerSettingsOpen) return;
    function handlePointerDown(event: MouseEvent) {
      if (layerSettingsRef.current && !layerSettingsRef.current.contains(event.target as Node)) setLayerSettingsOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setLayerSettingsOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [layerSettingsOpen]);
  useEffect(() => {
    if (!selected) return;
    function handlePointerDown(event: MouseEvent) {
      // A click on any marker (including a different one) is handled by
      // that marker's own onClick, which re-pins to it -- only a click
      // landing outside every marker should clear the pin here.
      if ((event.target as HTMLElement).closest(".live-map-marker")) return;
      setSelected(null);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setSelected(null);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [selected]);
  useEffect(() => {
    setTeleportPickerFor(null);
  }, [selected?.type, selected?.id]);
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
    if (!frame) return;
    if (!anchor) return;
    frame.scrollLeft = anchor.mapX * zoom - anchor.viewportX;
    frame.scrollTop = anchor.mapY * zoom - anchor.viewportY;
    zoomAnchorRef.current = null;
  }, [zoom, activeMap?.key]);
  useEffect(() => {
    if (!activeMap) return undefined;
    return scheduleFitLiveMapView();
  }, [activeMap?.key]);
  const mapOptions = Object.values(maps);
  const partitionOptions = partitions.filter((row) => row.map === (activeMap?.actorMap || activeMap?.key));
  // Partition-filtered but not yet subtype-filtered -- the base population
  // subtype counts are measured against, so a sub-item's own count doesn't
  // change/disappear just because the user unchecked it.
  const partitionFiltered = markers
    // Static-pool spice and POI markers have no partition_id at all (they're
    // not tied to a specific live dimension), so a marker without one should
    // never be dropped by the partition filter. spice_active markers do
    // carry a real partition_id and filter normally.
    .filter((marker) => !partitionId || marker.partition_id == null || String(marker.partition_id) === partitionId);
  const topLevelVisible = partitionFiltered.filter((marker) => filters[String(marker.type)] !== false);
  const visible = topLevelVisible.filter((marker) => !marker.subtype || subtypeFilters[String(marker.type)]?.[marker.subtype] !== false);
  const plotted = visible.filter((marker) => Number.isFinite(Number(marker.x)) && Number.isFinite(Number(marker.y)));
  const displayRows = visible.filter((marker) => TABLE_MARKER_TYPES.has(String(marker.type))).map((marker) => ({ ...marker, display_name: friendlyMarkerName(marker), raw_name: marker.name || marker.id }));
  const markerCounts = countMarkers(visible);
  const subtypeCounts = countBySubtype(topLevelVisible);
  // Raw, filter-independent population per category for the current
  // map/partition -- used only to decide whether a legend row has anything
  // to show at all. Deliberately not `markerCounts` (which is already
  // filtered by the user's own checkbox choices, so a just-unchecked
  // category would otherwise vanish from the legend the instant it's
  // unchecked, with no way to check it back on) and not `subtypeFilters`
  // presence (which persists across map/partition switches all session, so
  // a category seen once stays "known" even after its current view has none).
  const rawCategoryCounts = countMarkers(partitionFiltered);
  // Same principle one tier down -- a sub-type/sub-group row should only
  // hide when it truly has nothing right now, never because the user
  // unchecked its own or its parent category's checkbox.
  const rawSubtypeCounts = countBySubtype(partitionFiltered);
  const inBounds = activeMap ? plotted.map((marker) => ({ marker, point: worldToLiveMapPoint(marker, activeMap) })).filter((item) => item.point?.inBounds) as { marker: LiveMapMarker; point: LiveMapPoint }[] : [];
  const targetPoint = target && activeMap ? worldToLiveMapPoint({ x: target.x, y: target.y }, activeMap) : null;
  const minimumZoom = liveMapMinimumZoom(activeMap, frameRef.current);
  const zoomMinPercent = Math.round(minimumZoom * 100);
  const zoomMaxPercent = Math.round(MAX_LIVE_MAP_ZOOM * 100);
  const zoomValuePercent = Math.round(zoom * 100);
  const zoomProgressPercent = Math.max(0, Math.min(100, ((zoomValuePercent - zoomMinPercent) / Math.max(1, zoomMaxPercent - zoomMinPercent)) * 100));
  const zoomDisplayPercent = Math.round(zoomProgressPercent);
  function chooseMap(nextKey: string) {
    const nextMap = maps[nextKey];
    setMapKey(nextKey);
    setPartitionId(nextMap?.defaultPartitionId ? String(nextMap.defaultPartitionId) : "");
    setSelected(null);
    setTarget(null);
    setPlayerTeleportPreview(null);
    liveMapDraggingPlayerRef.current = false;
  }
  function openLayerSettings() {
    setLayerSettingsDraft({ ...DEFAULT_LAYER_FILTERS, ...loadDefaultLayerFilters() });
    const savedSubtypeDefaults = loadDefaultSubtypeLayerFilters() || {};
    const seededSubtypeDraft: Record<string, Record<string, boolean>> = {};
    for (const key of Object.keys(subtypeFilters)) {
      seededSubtypeDraft[key] = Object.fromEntries(Object.keys(subtypeFilters[key]).map((subtype) => [subtype, savedSubtypeDefaults[key]?.[subtype] ?? DEFAULT_LAYER_FILTERS[key] ?? true]));
    }
    setLayerSettingsSubtypeDraft(seededSubtypeDraft);
    setLayerSettingsOpen(true);
  }
  function saveLayerSettings() {
    saveDefaultLayerFilters(layerSettingsDraft);
    saveDefaultSubtypeLayerFilters(layerSettingsSubtypeDraft);
    setLayerSettingsOpen(false);
  }
  function resetLayerSettings() {
    clearDefaultLayerFilters();
    clearDefaultSubtypeLayerFilters();
    setLayerSettingsDraft(DEFAULT_LAYER_FILTERS);
    const resetSubtypeDraft: Record<string, Record<string, boolean>> = {};
    for (const key of Object.keys(subtypeFilters)) {
      resetSubtypeDraft[key] = Object.fromEntries(Object.keys(subtypeFilters[key]).map((subtype) => [subtype, true]));
    }
    setLayerSettingsSubtypeDraft(resetSubtypeDraft);
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
  function centerLiveMapView(zoomForCenter = zoom) {
    const frame = frameRef.current;
    const map = activeMap;
    if (!frame || !map) return;
    const width = map.width * zoomForCenter;
    const height = map.height * zoomForCenter;
    frame.scrollLeft = Math.max(0, (width - frame.clientWidth) / 2);
    frame.scrollTop = Math.max(0, (height - frame.clientHeight) / 2);
  }
  function scheduleFitLiveMapView() {
    const handles: number[] = [];
    const run = (attempt = 0) => {
      const frame = frameRef.current;
      if (!activeMap || !frame) return;
      if ((frame.clientWidth === 0 || frame.clientHeight === 0) && attempt < 8) {
        handles.push(window.requestAnimationFrame(() => run(attempt + 1)));
        return;
      }
      const next = liveMapMinimumZoom(activeMap, frame);
      zoomAnchorRef.current = null;
      setZoom(next);
      handles.push(window.requestAnimationFrame(() => centerLiveMapView(next)));
      handles.push(window.setTimeout(() => centerLiveMapView(next), 80));
    };
    handles.push(window.requestAnimationFrame(() => run()));
    return () => {
      for (const handle of handles) {
        window.cancelAnimationFrame(handle);
        window.clearTimeout(handle);
      }
    };
  }
  function fitLiveMapView() {
    const next = liveMapMinimumZoom(activeMap, frameRef.current);
    zoomAnchorRef.current = null;
    setZoom(next);
    requestAnimationFrame(() => centerLiveMapView(next));
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
  function playerMarkerId(marker: LiveMapMarker) {
    return String(firstDefined(marker.action_player_id, marker.fls_id, marker.funcom_id, marker.account_id, marker.id) || "");
  }
  function applyPendingPlayerTeleports(rows: LiveMapMarker[]) {
    const now = Date.now();
    return rows.map((marker) => {
      if (String(marker.type || "").toLowerCase() !== "player") return marker;
      const markerId = playerMarkerId(marker);
      const pending = markerId ? pendingPlayerTeleportsRef.current[markerId] : null;
      if (!pending) return marker;
      if (pending.expiresAt <= now) {
        delete pendingPlayerTeleportsRef.current[markerId];
        return marker;
      }
      const currentX = Number(marker.x);
      const currentY = Number(marker.y);
      const currentPartition = Number(marker.partition_id || 0);
      const caughtUp = Number.isFinite(currentX) && Number.isFinite(currentY) && Math.hypot(currentX - pending.x, currentY - pending.y) < 100 && (!pending.partitionId || currentPartition === pending.partitionId);
      if (caughtUp) delete pendingPlayerTeleportsRef.current[markerId];
      return {
        ...marker,
        x: pending.x,
        y: pending.y,
        z: pending.z,
        partition_id: pending.partitionId || marker.partition_id
      };
    });
  }
  function liveMapPointerPoint(event: MouseEvent | React.MouseEvent) {
    if (!canvasRef.current) return null;
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      px: (event.clientX - rect.left) / zoom,
      py: (event.clientY - rect.top) / zoom,
      inBounds: true
    };
  }
  async function confirmPlayerDragTeleport(marker: LiveMapMarker, point: LiveMapPoint) {
    if (!activeMap) return;
    const world = liveMapPixelsToWorld(point.px, point.py, activeMap);
    const playerId = playerMarkerId(marker);
    if (!world || !playerId) {
      setPlayerTeleportPreview(null);
      liveMapDraggingPlayerRef.current = false;
      setTeleportResult({ status: "failed", title: "Teleport Failed", message: "This player marker does not include a usable admin player ID." });
      return;
    }
    const online = liveMapPlayerStatus(marker) === "online";
    const playerName = friendlyMarkerName(marker);
    const confirmed = await confirmAction("Move this player to the selected map location?", {
      title: `Teleport ${playerName}?`,
      confirmLabel: "Teleport",
      details: [
        { label: "Player", value: playerName, tone: online ? "success" : "danger" },
        { label: "Status", value: online ? "Online" : "Offline", tone: online ? "success" : "danger" },
        { label: "Location", value: `X ${Math.round(world.x)}, Y ${Math.round(world.y)}, Z 5000`, tone: "accent" }
      ]
    });
    if (!confirmed) {
      setPlayerTeleportPreview(null);
      liveMapDraggingPlayerRef.current = false;
      return;
    }
    setTeleportResult({ status: "running", title: "Teleporting Player" });
    try {
      const teleportPosition = { x: Math.round(world.x), y: Math.round(world.y), z: 5000, partitionId: Number(marker.partition_id || partitionId || 0) };
      const response = await liveMapApi.teleportPlayer({ playerId, ...teleportPosition, yaw: 0, online });
      if (response.task) {
        const final = await waitForTask(response.task);
        if (final.status !== "succeeded") throw new Error(taskTechnicalDetails(final) || final.errorMessage || final.progressMessage || "Teleport failed.");
        setTeleportResult({ status: "succeeded", title: "Teleport Sent", message: `${playerName} was teleported to the selected location.` });
      } else if (response.supported === false) {
        setPlayerTeleportPreview(null);
        liveMapDraggingPlayerRef.current = false;
        setTeleportResult({ status: "failed", title: "Offline Teleport Not Available", message: response.reason || "Offline teleport is not supported by this database." });
        return;
      } else {
        setTeleportResult({ status: "succeeded", title: "Respawn Location Saved", message: response.message || `${playerName}'s respawn location was saved.` });
      }
      pendingPlayerTeleportsRef.current[playerId] = { ...teleportPosition, expiresAt: Date.now() + 20000 };
      setMarkers((current) => applyPendingPlayerTeleports(current));
      setSelected((current) => current && playerMarkerId(current) === playerId ? applyPendingPlayerTeleports([current])[0] : current);
      liveMapDraggingPlayerRef.current = false;
      await load(false);
      setPlayerTeleportPreview(null);
    } catch (error) {
      setPlayerTeleportPreview(null);
      liveMapDraggingPlayerRef.current = false;
      setTeleportResult({ status: "failed", title: "Teleport Failed", message: friendlyInlineError(error) });
    }
  }
  // Layer visibility toggles only hide markers from the map, not from
  // teleport eligibility -- read the raw fetched list, not `visible`/`plotted`.
  // Map and partition are separate running server instances in this
  // multi-instance farm, so a player online in a different partition can't
  // reach this one -- the pool always needs a real partition to gate on. A
  // marker "locked to an instance" (base, player, vehicle) already carries
  // its own partition_id, so use that. A static-pool marker (spice, POI)
  // carries none -- it exists identically in every instance of this map --
  // so fall back to whichever partition the admin is currently viewing,
  // never to "any partition, unconstrained".
  function onlinePlayersForMarker(marker: LiveMapMarker) {
    const map = activeMap?.actorMap || activeMap?.key || marker.map;
    const targetPartition = marker.partition_id !== undefined && marker.partition_id !== null ? String(marker.partition_id) : partitionId;
    return markers.filter((row) => {
      if (String(row.type).toLowerCase() !== "player") return false;
      if (liveMapPlayerStatus(row) !== "online") return false;
      if (String(row.map || "") !== String(map || "")) return false;
      if (targetPartition && String(row.partition_id) !== String(targetPartition)) return false;
      return true;
    });
  }
  function openTeleportPicker(marker: LiveMapMarker) {
    const online = onlinePlayersForMarker(marker);
    if (!online.length) {
      setTeleportResult({ status: "failed", title: "Teleport Failed", message: "Error: No online players." });
      return;
    }
    setTeleportPickerFor(marker);
    setTeleportPickerPlayerId(playerMarkerId(online[0]));
  }
  async function confirmTeleportToMarker(marker: LiveMapMarker, targetPlayerId: string) {
    const playerRow = onlinePlayersForMarker(marker).find((row) => playerMarkerId(row) === targetPlayerId);
    if (!playerRow) {
      setTeleportPickerFor(null);
      setTeleportResult({ status: "failed", title: "Teleport Failed", message: "Error: No online players." });
      return;
    }
    const playerName = friendlyMarkerName(playerRow);
    const destinationName = friendlyMarkerName(marker);
    const x = Math.round(Number(marker.x));
    const y = Math.round(Number(marker.y));
    const z = Number.isFinite(Number(marker.z)) ? Math.round(Number(marker.z)) : 5000;
    const confirmed = await confirmAction(`Teleport ${playerName} to ${destinationName}?`, {
      title: "Teleport Player",
      confirmLabel: "Teleport",
      details: [
        { label: "Player", value: playerName, tone: "success" },
        { label: "Destination", value: `${destinationName} (X ${x}, Y ${y}, Z ${z})`, tone: "accent" }
      ]
    });
    if (!confirmed) return;
    setTeleportPickerFor(null);
    setTeleportResult({ status: "running", title: "Teleporting Player" });
    try {
      const teleportPosition = { x, y, z, partitionId: Number(marker.partition_id || partitionId || 0) };
      const response = await liveMapApi.teleportPlayer({ playerId: targetPlayerId, ...teleportPosition, yaw: 0, online: true });
      if (response.task) {
        const final = await waitForTask(response.task);
        if (final.status !== "succeeded") throw new Error(taskTechnicalDetails(final) || final.errorMessage || final.progressMessage || "Teleport failed.");
        setTeleportResult({ status: "succeeded", title: "Teleport Sent", message: `${playerName} was teleported to ${destinationName}.` });
      } else if (response.supported === false) {
        setTeleportResult({ status: "failed", title: "Teleport Not Available", message: response.reason || "Live teleport is not supported by this database." });
        return;
      } else {
        setTeleportResult({ status: "succeeded", title: "Teleport Sent", message: response.message || `${playerName} was teleported to ${destinationName}.` });
      }
      pendingPlayerTeleportsRef.current[targetPlayerId] = { ...teleportPosition, expiresAt: Date.now() + 20000 };
      setMarkers((current) => applyPendingPlayerTeleports(current));
      await load(false);
    } catch (error) {
      setTeleportResult({ status: "failed", title: "Teleport Failed", message: friendlyInlineError(error) });
    }
  }
  useEffect(() => {
    if (!playerDrag) return undefined;
    function move(event: MouseEvent) {
      const point = liveMapPointerPoint(event);
      if (!point) return;
      setPlayerDrag((current) => current ? { ...current, point } : current);
    }
    function up(event: MouseEvent) {
      const current = playerDrag;
      if (!current) return;
      liveMapDraggingPlayerRef.current = false;
      setPlayerDrag(null);
      const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
      const point = liveMapPointerPoint(event) || current.point;
      if (distance < 6) return;
      liveMapDraggingPlayerRef.current = true;
      setPlayerTeleportPreview({ marker: current.marker, point });
      void confirmPlayerDragTeleport(current.marker, point);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up, { once: true });
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [playerDrag, zoom, activeMap?.key]);
  useEffect(() => {
    if (!teleportResult || teleportResult.status === "running") return;
    const id = window.setTimeout(() => setTeleportResult(null), 10400);
    return () => window.clearTimeout(id);
  }, [teleportResult?.status, teleportResult?.title]);
  return <section className="panel">
    <div className="panel-title">
      <div><h2>Live Map</h2><p className="muted">Live world markers, player teleport, partition filtering, zoom, pan, and coordinate selection.</p></div>
      <div className="action-row"><button className={`switch-toggle live-map-auto-toggle ${autoRefresh ? "enabled" : "disabled"}`} onClick={() => setAutoRefresh(!autoRefresh)}><span className="switch-label">Auto-Refresh</span><strong className="switch-state">{autoRefresh ? "ON" : "OFF"}</strong></button></div>
    </div>
    <section className="action-section live-map-view-section">
      <h4>Map View</h4>
      <div className="live-map-view-body">
        <div className="live-map-view-controls">
          <div className="live-map-view-field live-map-view-map-field">
            <span className="live-map-view-label">Map</span>
            <div className="live-map-map-buttons">{mapOptions.map((option) => <button key={option.key} className={option.key === mapKey ? "active" : ""} onClick={() => chooseMap(option.key)}>{option.label}</button>)}</div>
          </div>
          <label className="live-map-view-field live-map-partition-field">
            <span className="live-map-view-label">Partition</span>
            <select value={partitionId} onChange={(event) => setPartitionId(event.target.value)}><option value="">All Partitions</option>{partitionOptions.map((row) => <option key={`${row.map}-${row.partition_id}`} value={String(row.partition_id)}>{partitionDisplayNames[String(row.partition_id)] || row.name || "Partition"} [{row.partition_id}] ({row.marker_count})</option>)}</select>
          </label>
        </div>
        <div className="live-map-view-summary">
          <span className="live-map-view-label">Overview</span>
          <div className="key-value-grid live-map-stats">
            <div className="key-value-item"><span>Visible</span><strong>{visible.length}</strong></div>
            <div className="key-value-item"><span>In Bounds</span><strong>{inBounds.length}</strong></div>
            <div className="key-value-item"><span>Zoom</span><strong>{zoomDisplayPercent}%</strong></div>
            {coriolisSeed && <div className="key-value-item"><span>Coriolis Seed</span><strong>{coriolisSeedNumber(coriolisSeed)}</strong></div>}
            {coriolisNextCycleAt && <div className="key-value-item"><span>Coriolis Countdown</span><strong>{formatCoriolisCountdown(coriolisNextCycleAt, now)}</strong></div>}
            {/* The seed is only printed at container startup, so between a
                Coriolis boundary and the next restart the server can't know
                which seed is live. Static Spice Spawns is suppressed in that
                window rather than showing the previous cycle's pool -- say so,
                otherwise the empty layer reads as a bug. */}
            {coriolisSeedStaleSince && <div className="key-value-item"><span>Coriolis Seed</span><strong title={`Cycle rolled over at ${coriolisSeedStaleSince}; the new seed is only logged when the map server restarts.`}>Awaiting restart</strong></div>}
          </div>
        </div>
      </div>
    </section>
    <div className="live-map-layout">
      <aside className="live-map-sidebar">
        <section className="action-section">
          <div className="live-map-coordinates-header">
            <h4>Coordinates</h4>
            <button type="button" className="live-map-coordinates-clear" disabled={!target} onClick={() => setTarget(null)}>Clear</button>
          </div>
          {target ? <KeyValueGrid items={[["X", target.x.toFixed(0)], ["Y", target.y.toFixed(0)], ["Partition", partitionId || "All"]]} /> : <p className="muted">Double-click the map to pick world coordinates.</p>}
        </section>
        <section className="action-section">
          <div className="live-map-layers-header" ref={layerSettingsRef}>
            <h4>Layers</h4>
            <button type="button" className="live-map-layers-settings-btn" aria-label="Default layer settings" onClick={() => (layerSettingsOpen ? setLayerSettingsOpen(false) : openLayerSettings())}>
              <Settings size={14} aria-hidden="true" />
            </button>
            {layerSettingsOpen && <div className="live-map-layers-popover">
              <p className="live-map-layers-popover-title">Default layers</p>
              <p className="live-map-layers-popover-hint">Choose which layers -- and sub-types -- are on when the map first loads.</p>
              <div className="live-map-layers-popover-list">{(() => {
                let currentSection = "";
                return LEGEND_LAYOUT.map((item, index) => {
                  if ("header" in item) {
                    currentSection = item.header;
                    return <p key={`settings-header-${index}`} className="live-map-layers-popover-section">{item.header}</p>;
                  }
                  const key = item.key;
                  const indent = (node: React.ReactNode, keyValue: React.Key) =>
                    currentSection ? <div key={keyValue} className="live-map-layer-section-item">{node}</div> : <React.Fragment key={keyValue}>{node}</React.Fragment>;
                  const subtypes = EXPANDABLE_KEYS.has(key) ? Object.keys(subtypeFilters[key] || {}).sort() : [];
                  if (subtypes.length === 0) {
                    return indent(<label className="checkbox-row live-map-layer">
                      <span className="live-map-layer-label">{friendlyMarkerType(key)}</span>
                      <input type="checkbox" checked={Boolean(layerSettingsDraft[key])} onChange={() => setLayerSettingsDraft({ ...layerSettingsDraft, [key]: !layerSettingsDraft[key] })} />
                    </label>, key);
                  }
                  const draftSubtypes = layerSettingsSubtypeDraft[key] || {};
                  const checkedCount = subtypes.filter((subtype) => draftSubtypes[subtype] !== false).length;
                  const allChecked = checkedCount === subtypes.length;
                  const noneChecked = checkedCount === 0;
                  function toggleParent() {
                    const nextValue = !allChecked;
                    setLayerSettingsDraft((prev) => ({ ...prev, [key]: nextValue }));
                    setLayerSettingsSubtypeDraft((prev) => ({ ...prev, [key]: Object.fromEntries(subtypes.map((subtype) => [subtype, nextValue])) }));
                  }
                  return indent(<div className="live-map-layer-group" key={key}>
                    <label className="checkbox-row live-map-layer">
                      <span className="live-map-layer-label">{friendlyMarkerType(key)}</span>
                      <IndeterminateCheckbox checked={allChecked} indeterminate={!allChecked && !noneChecked} onChange={toggleParent} />
                    </label>
                    <div className="live-map-layer-sublist">{(() => {
                      const renderSubtypeRow = (subtype: string, label: string = subtype) => {
                        const checked = draftSubtypes[subtype] !== false;
                        return <label key={subtype} className="checkbox-row live-map-layer live-map-layer-sub">
                          <span className="live-map-layer-label">{spaceWords(label)}</span>
                          <input type="checkbox" checked={checked} onChange={() => {
                            const nextSubtypeState = { ...draftSubtypes, [subtype]: !checked };
                            setLayerSettingsSubtypeDraft({ ...layerSettingsSubtypeDraft, [key]: nextSubtypeState });
                            setLayerSettingsDraft((prev) => ({ ...prev, [key]: Object.values(nextSubtypeState).some(Boolean) }));
                          }} />
                        </label>;
                      };
                      const resolveSubgroup = SUBGROUP_RESOLVERS[key];
                      if (!resolveSubgroup) return subtypes.map((subtype) => renderSubtypeRow(subtype));

                      const ungrouped: { subtype: string; label: string }[] = [];
                      const subtypesByGroup = new Map<string, { subtype: string; label: string }[]>();
                      for (const subtype of subtypes) {
                        const resolved = resolveSubgroup(subtype);
                        if (!resolved || !resolved.group) { ungrouped.push({ subtype, label: resolved?.label ?? subtype }); continue; }
                        if (!subtypesByGroup.has(resolved.group)) subtypesByGroup.set(resolved.group, []);
                        subtypesByGroup.get(resolved.group)!.push({ subtype, label: resolved.label });
                      }
                      const groupNames = [...subtypesByGroup.keys()].sort((a, b) => {
                        const orderA = SUBGROUP_ORDER.indexOf(a);
                        const orderB = SUBGROUP_ORDER.indexOf(b);
                        if (orderA === -1 && orderB === -1) return a.localeCompare(b);
                        if (orderA === -1) return 1;
                        if (orderB === -1) return -1;
                        return orderA - orderB;
                      });
                      const groupBlocks = groupNames.map((group) => {
                        const groupItems = subtypesByGroup.get(group)!;
                        const groupSubtypes = groupItems.map((groupItem) => groupItem.subtype);
                        const groupCheckedCount = groupSubtypes.filter((subtype) => draftSubtypes[subtype] !== false).length;
                        const groupAllChecked = groupCheckedCount === groupSubtypes.length;
                        const groupNoneChecked = groupCheckedCount === 0;
                        return <div key={group} className="live-map-layer-subgroup-block">
                          <label className="checkbox-row live-map-layer live-map-layer-subgroup">
                            <span className="live-map-layer-label">{group}</span>
                            <IndeterminateCheckbox checked={groupAllChecked} indeterminate={!groupAllChecked && !groupNoneChecked} onChange={() => {
                              const nextValue = !groupAllChecked;
                              const nextSubtypeState = { ...draftSubtypes, ...Object.fromEntries(groupSubtypes.map((subtype) => [subtype, nextValue])) };
                              setLayerSettingsSubtypeDraft({ ...layerSettingsSubtypeDraft, [key]: nextSubtypeState });
                              setLayerSettingsDraft((prev) => ({ ...prev, [key]: Object.values(nextSubtypeState).some(Boolean) }));
                            }} />
                          </label>
                          {groupItems.map(({ subtype, label }) => renderSubtypeRow(subtype, label))}
                        </div>;
                      });
                      return [...ungrouped.map(({ subtype, label }) => renderSubtypeRow(subtype, label)), ...groupBlocks];
                    })()}</div>
                  </div>, key);
                });
              })()}</div>
              <div className="live-map-layers-popover-actions">
                <button type="button" className="active" onClick={saveLayerSettings}>Save as Default</button>
                <button type="button" onClick={resetLayerSettings}>Reset</button>
              </div>
            </div>}
          </div>
          <div className="live-map-layer-list">{(() => {
            let currentSection = "";
            // "Fully on"/"fully off" for one category key, matching the same
            // aggregate rule each category's own checkbox already uses --
            // all subtypes checked (or the plain filters[key] flag for a
            // non-expandable key) counts as on, none checked counts as off.
            const keyFullyOn = (key: string) => {
              const subtypes = EXPANDABLE_KEYS.has(key) ? Object.keys(subtypeFilters[key] || {}) : null;
              if (subtypes) return subtypes.length === 0 || subtypes.every((subtype) => subtypeFilters[key][subtype] !== false);
              return Boolean(filters[key]);
            };
            const keyFullyOff = (key: string) => {
              const subtypes = EXPANDABLE_KEYS.has(key) ? Object.keys(subtypeFilters[key] || {}) : null;
              if (subtypes) return subtypes.length > 0 && subtypes.every((subtype) => subtypeFilters[key][subtype] === false);
              return !filters[key];
            };
            return LEGEND_LAYOUT.map((item, index) => {
            if ("header" in item) {
              const sectionName = item.header;
              currentSection = sectionName;
              const sectionExpanded = expandedSections[sectionName] !== false;
              const memberKeys = (SECTION_MEMBERS[sectionName] || []).filter((memberKey) => !(GATED_LAYER_KEYS.has(memberKey) && capabilities[memberKey] === false) && (rawCategoryCounts[memberKey] || 0) > 0);
              if (memberKeys.length === 0) return null;
              const sectionAllOn = memberKeys.length > 0 && memberKeys.every(keyFullyOn);
              const sectionAllOff = memberKeys.length > 0 && memberKeys.every(keyFullyOff);
              const toggleSection = () => {
                const nextValue = !sectionAllOn;
                setFilters((prevFilters) => {
                  const next = { ...prevFilters };
                  for (const memberKey of memberKeys) next[memberKey] = nextValue;
                  return next;
                });
                setSubtypeFilters((prev) => {
                  const next = { ...prev };
                  for (const memberKey of memberKeys) {
                    if (prev[memberKey]) next[memberKey] = Object.fromEntries(Object.keys(prev[memberKey]).map((subtype) => [subtype, nextValue]));
                  }
                  return next;
                });
              };
              return <div key={`header-${index}`} className="checkbox-row live-map-layer live-map-layer-group-header">
                <button type="button" className="live-map-layer-group-header-toggle" onClick={() => setExpandedSections((prev) => ({ ...prev, [sectionName]: prev[sectionName] === false }))}>
                  <span className="live-map-layer-expand" aria-hidden="true">{sectionExpanded ? "−" : "+"}</span>
                  {sectionName}
                </button>
                {memberKeys.length > 0 && <IndeterminateCheckbox checked={sectionAllOn} indeterminate={!sectionAllOn && !sectionAllOff} onChange={toggleSection} />}
              </div>;
            }
            if (expandedSections[currentSection] === false) return null;
            const indent = (node: React.ReactNode, keyValue: React.Key) =>
              currentSection ? <div key={keyValue} className="live-map-layer-section-item">{node}</div> : <React.Fragment key={keyValue}>{node}</React.Fragment>;
            // Rows with no chevron (Flour Sand) still need to reserve the
            // same width a sibling's expand button occupies -- otherwise
            // their label starts to the left of every expandable sibling's
            // label under the same section header.
            const chevronSpacer = currentSection ? <span className="live-map-layer-expand-spacer" aria-hidden="true" /> : null;
            const key = item.key;
            if (GATED_LAYER_KEYS.has(key) && capabilities[key] === false) return null;
            if ((rawCategoryCounts[key] || 0) === 0) return null;
            const subtypes = EXPANDABLE_KEYS.has(key) ? Object.keys(subtypeFilters[key] || {}).sort() : [];
            if (subtypes.length === 0) {
              return indent(<label className="checkbox-row live-map-layer">{chevronSpacer}<span className="live-map-layer-label">{friendlyMarkerType(key)}</span><span className="muted">{markerCounts[key] || 0}</span><span className={`live-map-legend-dot marker-${key}`} /><input type="checkbox" checked={filters[key]} onChange={() => setFilters({ ...filters, [key]: !filters[key] })} /></label>, key);
            }
            const checkedCount = subtypes.filter((subtype) => subtypeFilters[key][subtype] !== false).length;
            const allChecked = checkedCount === subtypes.length;
            const noneChecked = checkedCount === 0;
            const expanded = Boolean(expandedGroups[key]);
            function toggleParent() {
              const nextValue = !allChecked;
              setFilters((prevFilters) => ({ ...prevFilters, [key]: nextValue }));
              setSubtypeFilters((prev) => ({ ...prev, [key]: Object.fromEntries(subtypes.map((subtype) => [subtype, nextValue])) }));
            }
            return indent(<div className="live-map-layer-group">
              <label className="checkbox-row live-map-layer">
                <button type="button" className="live-map-layer-expand" aria-label={expanded ? "Collapse" : "Expand"} onClick={() => setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }))}>{expanded ? "−" : "+"}</button>
                <span className="live-map-layer-label">{friendlyMarkerType(key)}</span>
                <span className="muted">{markerCounts[key] || 0}</span>
                <span className="live-map-legend-dot-spacer" aria-hidden="true" />
                <IndeterminateCheckbox checked={allChecked} indeterminate={!allChecked && !noneChecked} onChange={toggleParent} />
              </label>
              {expanded && <div className="live-map-layer-sublist">{(() => {
                const renderSubtypeRow = (subtype: string, label: string = subtype) => {
                  if ((rawSubtypeCounts[key]?.[subtype] || 0) === 0) return null;
                  const checked = subtypeFilters[key][subtype] !== false;
                  return <label key={subtype} className="checkbox-row live-map-layer live-map-layer-sub">
                    <span className="live-map-layer-label">{spaceWords(label)}</span>
                    <span className="muted">{subtypeCounts[key]?.[subtype] || 0}</span>
                    <span className={`live-map-legend-dot marker-${key} subtype-${subtype.toLowerCase()}`} />
                    <input type="checkbox" checked={checked} onChange={() => {
                      const nextSubtypeState = { ...subtypeFilters[key], [subtype]: !checked };
                      setSubtypeFilters({ ...subtypeFilters, [key]: nextSubtypeState });
                      setFilters((prevFilters) => ({ ...prevFilters, [key]: Object.values(nextSubtypeState).some(Boolean) }));
                    }} />
                  </label>;
                };
                const resolveSubgroup = SUBGROUP_RESOLVERS[key];
                if (!resolveSubgroup) return subtypes.map((subtype) => renderSubtypeRow(subtype));

                const ungrouped: { subtype: string; label: string }[] = [];
                const subtypesByGroup = new Map<string, { subtype: string; label: string }[]>();
                for (const subtype of subtypes) {
                  const resolved = resolveSubgroup(subtype);
                  if (!resolved || !resolved.group) { ungrouped.push({ subtype, label: resolved?.label ?? subtype }); continue; }
                  if (!subtypesByGroup.has(resolved.group)) subtypesByGroup.set(resolved.group, []);
                  subtypesByGroup.get(resolved.group)!.push({ subtype, label: resolved.label });
                }
                const groupNames = [...subtypesByGroup.keys()].sort((a, b) => {
                  const orderA = SUBGROUP_ORDER.indexOf(a);
                  const orderB = SUBGROUP_ORDER.indexOf(b);
                  if (orderA === -1 && orderB === -1) return a.localeCompare(b);
                  if (orderA === -1) return 1;
                  if (orderB === -1) return -1;
                  return orderA - orderB;
                });
                const groupBlocks = groupNames.map((group) => {
                  const groupItems = subtypesByGroup.get(group)!;
                  const groupSubtypes = groupItems.map((item) => item.subtype);
                  if (!groupSubtypes.some((subtype) => (rawSubtypeCounts[key]?.[subtype] || 0) > 0)) return null;
                  const groupCheckedCount = groupSubtypes.filter((subtype) => subtypeFilters[key][subtype] !== false).length;
                  const groupAllChecked = groupCheckedCount === groupSubtypes.length;
                  const groupNoneChecked = groupCheckedCount === 0;
                  const groupCount = groupSubtypes.reduce((sum, subtype) => sum + (subtypeCounts[key]?.[subtype] || 0), 0);
                  const groupExpanded = Boolean(expandedSubgroups[key]?.[group]);
                  return <div key={group} className="live-map-layer-subgroup-block">
                    <label className="checkbox-row live-map-layer live-map-layer-subgroup">
                      <button type="button" className="live-map-layer-expand" aria-label={groupExpanded ? "Collapse" : "Expand"} onClick={() => setExpandedSubgroups((prev) => ({ ...prev, [key]: { ...prev[key], [group]: !prev[key]?.[group] } }))}>{groupExpanded ? "−" : "+"}</button>
                      <span className="live-map-layer-label">{group}</span>
                      <span className="muted">{groupCount}</span>
                      <span className="live-map-legend-dot-spacer" aria-hidden="true" />
                      <IndeterminateCheckbox checked={groupAllChecked} indeterminate={!groupAllChecked && !groupNoneChecked} onChange={() => {
                        const nextValue = !groupAllChecked;
                        const nextSubtypeState = { ...subtypeFilters[key], ...Object.fromEntries(groupSubtypes.map((subtype) => [subtype, nextValue])) };
                        setSubtypeFilters({ ...subtypeFilters, [key]: nextSubtypeState });
                        setFilters((prevFilters) => ({ ...prevFilters, [key]: Object.values(nextSubtypeState).some(Boolean) }));
                      }} />
                    </label>
                    {groupExpanded && groupItems.map(({ subtype, label }) => renderSubtypeRow(subtype, label))}
                  </div>;
                });
                return [...ungrouped.map(({ subtype, label }) => renderSubtypeRow(subtype, label)), ...groupBlocks];
              })()}</div>}
            </div>, key);
            });
          })()}</div>
        </section>
      </aside>
      <div className="live-map-main">
        <div className="live-map-toolbar">
          <button onClick={() => setZoomAround(zoom * 1.18)}>Zoom In</button>
          <button onClick={() => setZoomAround(zoom * 0.84)}>Zoom Out</button>
          <button onClick={fitLiveMapView}>Fit Map</button>
          <label>Zoom<input className="live-map-zoom-range" type="range" min={zoomMinPercent} max={zoomMaxPercent} value={zoomValuePercent} style={{ "--zoom-progress": `${zoomProgressPercent}%` } as React.CSSProperties} onChange={(event) => setZoomAround(Number(event.target.value) / 100)} /></label>
          <span className="muted">Drag to Pan. Mouse Wheel Zooms.</span>
        </div>
        {teleportResult && <HomeTaskResultCard result={teleportResult} />}
        <div className={`live-map-frame ${drag ? "dragging" : ""} ${playerDrag ? "dragging-player" : ""}`} ref={frameRef}
          onDoubleClick={handleMapDoubleClick}
          onMouseDown={(event) => { if ((event.target as HTMLElement).closest(".live-map-marker")) return; setDrag({ x: event.clientX, y: event.clientY, left: frameRef.current?.scrollLeft || 0, top: frameRef.current?.scrollTop || 0 }); }}
          onMouseMove={(event) => { if (!drag || !frameRef.current) return; frameRef.current.scrollLeft = drag.left - (event.clientX - drag.x); frameRef.current.scrollTop = drag.top - (event.clientY - drag.y); }}
          onMouseUp={() => setDrag(null)}
          onMouseLeave={() => setDrag(null)}>
          {switching && <div className="live-map-loading-overlay"><span className="spinner" aria-hidden="true" /><strong className="loading-dots">Loading Map</strong></div>}
          {activeMap ? <div className="live-map-canvas" ref={canvasRef} style={{ width: Math.floor(activeMap.width * zoom), height: Math.floor(activeMap.height * zoom) }}>
            {activeMap.image ? <img className="live-map-image" src={activeMap.image} alt={activeMap.label} draggable={false} /> : <div className="live-map-placeholder">{activeMap.label}</div>}
            <div className="live-map-marker-layer">
              {targetPoint && <span className="live-map-target" style={{ left: `${targetPoint.px * zoom}px`, top: `${targetPoint.py * zoom}px` }} />}
              {inBounds.map(({ marker, point }, index) => {
                const playerStatus = liveMapPlayerStatus(marker);
                const isPinned = Boolean(selected && String(selected.type) === String(marker.type) && String(selected.id) === String(marker.id));
                const isHovered = Boolean(hoveredMarker && String(hoveredMarker.type) === String(marker.type) && String(hoveredMarker.id) === String(marker.id));
                // A pinned marker always wins -- hovering a different marker
                // elsewhere on the map never displaces the pinned overlay.
                const overlayOpen = isPinned || (!selected && isHovered);
                const isTeleportPickerOpen = Boolean(teleportPickerFor && String(teleportPickerFor.type) === String(marker.type) && String(teleportPickerFor.id) === String(marker.id));
                const isPlayer = String(marker.type).toLowerCase() === "player";
                const isDraggingThisPlayer = Boolean(playerDrag && String(playerDrag.marker.id) === String(marker.id) && String(playerDrag.marker.type) === String(marker.type));
                const isPreviewingThisPlayer = Boolean(playerTeleportPreview && String(playerTeleportPreview.marker.id) === String(marker.id) && String(playerTeleportPreview.marker.type) === String(marker.type));
                const renderPoint = isDraggingThisPlayer ? playerDrag!.point : isPreviewingThisPlayer ? playerTeleportPreview!.point : point;
                const spiceSizeClass = SPICE_TIER_TYPES.has(String(marker.type)) && typeof marker.subtype === "string" ? `spice-size-${marker.subtype.toLowerCase()}` : "";
                const subtypeClass = typeof marker.subtype === "string" ? `subtype-${marker.subtype.toLowerCase()}` : "";
                // A plain div, not a button: the overlay below nests real
                // buttons and a <details> element, both of which HTML
                // forbids as descendants of <button>. tabIndex + onKeyDown
                // restore the keyboard activation a real button gave for
                // free. mouseenter/leave (unlike mouseover/out) ignore
                // moving onto a child element, so hovering from the icon
                // onto the overlay panel itself -- a DOM descendant, even
                // though visually positioned above the icon -- never closes
                // it.
                return <div key={`${marker.type}-${marker.id}-${index}`} role="button" tabIndex={0}
                  className={`live-map-marker marker-${marker.type} ${spiceSizeClass} ${subtypeClass} ${playerStatus} ${isDraggingThisPlayer ? "dragging" : ""} ${isPreviewingThisPlayer ? "teleport-preview" : ""} ${overlayOpen ? "overlay-open" : ""}`}
                  aria-label={`${friendlyMarkerType(String(marker.type))}: ${friendlyMarkerName(marker)}`}
                  onMouseEnter={() => setHoveredMarker(marker)}
                  onMouseLeave={() => setHoveredMarker(null)}
                  onMouseDown={(event) => {
                    if (!isPlayer) return;
                    event.stopPropagation();
                    event.preventDefault();
                    liveMapDraggingPlayerRef.current = true;
                    setPlayerDrag({ marker, point, startX: event.clientX, startY: event.clientY });
                  }}
                  onClick={(event) => { event.stopPropagation(); setSelected(marker); }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    setSelected(marker);
                  }}
                  style={{ left: `${renderPoint.px * zoom}px`, top: `${renderPoint.py * zoom}px` }}>
                  {overlayOpen && <div className={`live-map-marker-overlay ${overlayAnchorClasses(renderPoint, zoom, frameRef.current)}`} role="dialog" aria-label={`${friendlyMarkerType(String(marker.type))}: ${friendlyMarkerName(marker)}`}>
                    <div className="live-map-marker-overlay-header">
                      <strong>{friendlyMarkerName(marker)}</strong>
                      {isPinned && <button type="button" className="live-map-marker-overlay-close" aria-label="Close" onClick={(event) => { event.stopPropagation(); setSelected(null); setHoveredMarker(null); }}>×</button>}
                    </div>
                    <div className="live-map-marker-overlay-subtitle">{liveMapOverlaySubtitle(marker)}</div>
                    <div className="live-map-marker-overlay-facts">
                      {liveMapOverlayFacts(marker, maps, partitions, partitionDisplayNames).map(([key, value]) => <React.Fragment key={key}><span>{key}</span><strong>{value}</strong></React.Fragment>)}
                    </div>
                    <div className="live-map-marker-overlay-actions">
                      <button type="button" className="live-map-marker-overlay-action" onClick={(event) => { event.stopPropagation(); openTeleportPicker(marker); }}>Teleport</button>
                      {String(marker.type).toLowerCase() === "base" && <button type="button" className="live-map-marker-overlay-action" onClick={(event) => { event.stopPropagation(); onOpenBase(String(marker.id)); }}>Open in Bases</button>}
                      {String(marker.type).toLowerCase() === "vehicle" && <button type="button" className="live-map-marker-overlay-action" onClick={(event) => { event.stopPropagation(); onOpenVehicle(String(marker.id)); }}>Open in Vehicles</button>}
                    </div>
                    {isTeleportPickerOpen && <div className="live-map-marker-overlay-teleport" onClick={(event) => event.stopPropagation()}>
                      <select aria-label="Teleport destination player" value={teleportPickerPlayerId} onChange={(event) => setTeleportPickerPlayerId(event.target.value)}>
                        {onlinePlayersForMarker(marker).map((row) => <option key={playerMarkerId(row)} value={playerMarkerId(row)}>{friendlyMarkerName(row)}</option>)}
                      </select>
                      <div className="live-map-marker-overlay-actions">
                        <button type="button" className="live-map-marker-overlay-action" onClick={() => void confirmTeleportToMarker(marker, teleportPickerPlayerId)}>Confirm</button>
                        <button type="button" className="live-map-marker-overlay-action" onClick={() => setTeleportPickerFor(null)}>Cancel</button>
                      </div>
                    </div>}
                    <TechnicalDetails title="Marker technical details" text={JSON.stringify(marker, null, 2)} />
                  </div>}
                </div>;
              })}
            </div>
          </div> : <div className="empty">Loading map configuration...</div>}
        </div>
      </div>
    </div>
    {Object.entries(overlays).filter(([, reason]) => reason).map(([key, reason]) => <p className="danger-note" key={key}>{key}: {reason}</p>)}
    {displayRows.length > 0 && <DataTable rows={displayRows.map((row) => ({ ...row, type: friendlyMarkerType(String(row.type)) })) as Record<string, unknown>[]} columns={["type", "display_name", "map", "partition_id", "x", "y", "z"]} />}
  </section>;
}

type LiveMapPoint = { px: number; py: number; inBounds: boolean };

export function mergeLiveMapRows(previous: LiveMapMarker[], incoming: LiveMapMarker[], includeStatic: boolean, mapName = "") {
  if (includeStatic) return incoming;
  const retainedStatic = previous.filter((marker) => STATIC_MARKER_TYPES.has(String(marker.type)) && (!mapName || marker.map === mapName));
  return [...retainedStatic, ...incoming];
}

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

// The overlay's own CSS defaults to centered-below the icon, but that
// clips against .live-map-frame's overflow:hidden near an edge. These are
// the overlay's actual dimensions from its CSS (width is fixed, height is
// a max-height cap since content varies) plus the gap CSS also applies --
// kept in sync by hand since the shift decision has to happen in JS
// (based on the marker's on-screen position within the frame's currently
// scrolled viewport, not just its raw canvas position) while the shift
// itself is still applied via CSS classes, not inline math, so it stays
// themeable.
const OVERLAY_WIDTH = 230;
const OVERLAY_MAX_HEIGHT = 320;
const OVERLAY_GAP = 10;
const OVERLAY_EDGE_MARGIN = 12;
function overlayAnchorClasses(renderPoint: LiveMapPoint, zoom: number, frame: HTMLDivElement | null) {
  if (!frame) return "";
  const viewportX = renderPoint.px * zoom - frame.scrollLeft;
  const viewportY = renderPoint.py * zoom - frame.scrollTop;
  const classes: string[] = [];
  if (viewportX < OVERLAY_WIDTH / 2 + OVERLAY_EDGE_MARGIN) classes.push("anchor-left");
  else if (viewportX > frame.clientWidth - OVERLAY_WIDTH / 2 - OVERLAY_EDGE_MARGIN) classes.push("anchor-right");
  if (viewportY > frame.clientHeight - OVERLAY_MAX_HEIGHT - OVERLAY_GAP - OVERLAY_EDGE_MARGIN) classes.push("anchor-above");
  return classes.join(" ");
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
  // Math.min, not Math.max -- this needs to be a "contain" fit (the whole
  // map visible, letterboxed on the shorter axis) so the fully-zoomed-out
  // view never overflows the frame and forces a scrollbar. Math.max would
  // "cover" the frame instead, cropping whichever axis has the smaller
  // required ratio.
  const fitRatio = Math.min(frame.clientWidth / config.width, frame.clientHeight / config.height);
  return Math.max(0.02, fitRatio * MIN_ZOOM_FIT_FACTOR);
}

function clampLiveMapZoom(value: number, minimum = 0.16) {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(MAX_LIVE_MAP_ZOOM, value));
}

function countMarkers(markers: LiveMapMarker[]) {
  return markers.reduce<Record<string, number>>((acc, marker) => {
    const key = String(marker.type || "unknown");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function countBySubtype(markers: LiveMapMarker[]) {
  return markers.reduce<Record<string, Record<string, number>>>((acc, marker) => {
    if (!marker.subtype) return acc;
    const type = String(marker.type || "unknown");
    if (!acc[type]) acc[type] = {};
    acc[type][marker.subtype] = (acc[type][marker.subtype] || 0) + 1;
    return acc;
  }, {});
}

// Layer sub-type labels come straight off the game's blueprint names
// ("ContainerVehicle", "BeneGesserit", "TradingPost") with no natural word
// spacing. Insert a space at each lower/digit -> upper word boundary
// (and turn underscores into spaces) purely for legend/settings display --
// the raw subtype string is still what's used for the checkbox key, CSS
// class, and filter state.
function spaceWords(text: string) {
  return text.replaceAll("_", " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim();
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
  // House Representative / Trainer names are the category prefix and the
  // specific name run together with no separator ("HouseRepresentativeVernius",
  // "TrainerBeneGesserit") -- the category is already shown as its own
  // subtitle line below the name, so drop the prefix rather than repeat it.
  const categoryPrefixMatch = raw.match(/^(HouseRepresentative|Trainer)(.+)$/i);
  if (categoryPrefixMatch) return spaceWords(categoryPrefixMatch[2]);
  return raw.replace(/^\/Game\/.*\//, "").replace(/^BP_/, "").replace(/_C$/, "").replaceAll("_", " ");
}

// The subtitle line under the overlay's name -- the marker's type in its
// own right (base tier / online status / friendly type label), never
// duplicated below in the facts grid.
function liveMapOverlaySubtitle(marker: LiveMapMarker) {
  const type = String(marker.type).toLowerCase();
  if (type === "player") return <StatusPill value={liveMapPlayerStatus(marker)} />;
  if (type === "base") return marker.base_type || "Unknown";
  return friendlyMarkerType(type);
}

// Map + partition collapsed into one line -- every marker on screen already
// belongs to the map the panel is currently showing, so a separate raw "Map"
// row would just repeat page-level context back at the user.
function liveMapOverlayLocation(marker: LiveMapMarker, maps: Record<string, LiveMapConfig>, partitions: LiveMapPartition[], partitionDisplayNames: Record<string, string>) {
  const mapLabel = maps[String(marker.map)]?.label || String(marker.map || "");
  if (marker.partition_id === undefined || marker.partition_id === null) return mapLabel;
  const partitionId = String(marker.partition_id);
  const partitionRow = partitions.find((row) => row.map === marker.map && String(row.partition_id) === partitionId);
  const partitionName = partitionDisplayNames[partitionId] || partitionRow?.name;
  return partitionName ? `${mapLabel}, ${partitionName}` : `${mapLabel}, Partition ${partitionId}`;
}

function liveMapOverlayPosition(marker: LiveMapMarker) {
  const coords = [marker.x, marker.y, marker.z]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => { const n = Number(value); return Number.isFinite(n) ? String(Math.round(n)) : String(value); });
  return coords.length ? coords.join(", ") : null;
}

function liveMapOverlayFacts(marker: LiveMapMarker, maps: Record<string, LiveMapConfig>, partitions: LiveMapPartition[], partitionDisplayNames: Record<string, string>): [string, string][] {
  const facts: [string, string][] = [];
  if (["base", "vehicle"].includes(String(marker.type).toLowerCase())) facts.push(["Owner", String(marker.owner_name || "No Owner")]);
  facts.push(["Location", liveMapOverlayLocation(marker, maps, partitions, partitionDisplayNames)]);
  const position = liveMapOverlayPosition(marker);
  if (position) facts.push(["Position", position]);
  return facts;
}

function coriolisSeedNumber(coriolisSeed: string) {
  const match = coriolisSeed.match(/^cor-(\d+)$/);
  return match ? match[1] : coriolisSeed;
}

function formatCoriolisCountdown(nextCycleAt: string, now: number) {
  const remainingMs = new Date(nextCycleAt).getTime() - now;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "0:00:00";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}

function friendlyMarkerType(type: string) {
  return {
    player: "Player",
    vehicle: "Vehicle",
    base: "Base",
    storage: "Storage",
    service: "Service",
    spice: "Static Spice Spawns",
    spice_active: "Active Spice Blows",
    flour_sand: "Flour Sand",
    ore: "Ores & Metals",
    scrap: "Scrap & Wrecks",
    flora: "Plants & Fibers",
    poi: "POI's",
    house_representative: "House Representative",
    trainer: "Trainer",
    fortress: "Fortress",
    hazard: "Hazard Zones",
    enemy: "Enemy Camp/Outpost"
  }[type.toLowerCase()] || titleCase(type.replaceAll("_", " "));
}

function liveMapPlayerStatus(marker: LiveMapMarker) {
  if (String(marker.type || "").toLowerCase() !== "player") return String(marker.online_status || "").toLowerCase();
  return String(marker.online_status || "").toLowerCase() === "online" ? "online" : "offline";
}
