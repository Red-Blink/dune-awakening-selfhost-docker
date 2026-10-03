import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Settings } from "lucide-react";
import { liveMapApi, type LiveMapConfig, type LiveMapMarker, type LiveMapPartition } from "../../api/liveMap";
import { mapsApi } from "../../api/maps";
import type { Task } from "../../api/setup";
import { DataTable } from "../../components/common/DataTable";
import { TechnicalDetails } from "../../components/common/DisplayPrimitives";
import { firstDefined, formatUiSentence, titleCase } from "../../lib/display";
import { friendlyInlineError } from "../players/playerAdminUtils";
import {
  clampLiveMapZoom,
  liveMapCamera,
  liveMapMinimumZoom,
  liveMapPixelsToWorld,
  MAX_LIVE_MAP_ZOOM,
  panScrollDelta,
  terrainViewport,
  visibleWorldRect,
  worldToLiveMapPoint,
  zoomCentreFor,
  type LiveMapPoint
} from "./liveMapGeometry";
import { MAX_TILT, projectToScreen, screenToWorldAtZ, type TerrainCamera } from "./terrain/terrainCamera";
import type { TerrainApi } from "./terrain/DeepDesertTerrain";
import { labelAnchorInView, projectSectorLabels, sectorForWorldPoint, sectorGridFor } from "./liveMapSectorGrid";
import { LiveMapCompass } from "./LiveMapCompass";

// On-screen size of a sector label, in CSS pixels. The SVG is drawn in map-pixel
// space and scaled by zoom, so the font size is divided back out to keep it
// constant rather than growing with the map -- at maximum zoom a label sized in
// viewBox units alone would render around 368px tall.
const SECTOR_LABEL_PX = 15;
// Layouts 0-11 are the twelve whose meshes are bundled. The API deliberately
// reports higher numbers rather than nulling them, so the console has to say
// plainly that it cannot draw one instead of implying it did.
const SHIPPED_LAYOUTS = 12;
// The Overview strip is a narrow grid cell. The reasons produced in this file
// and by the support probe are already short, but an asset failure carries
// whatever the browser threw -- a hashed URL and a status code -- which would
// wrap to several lines and double the strip's height. The full text stays in
// the title attribute.
const TERRAIN_REASON_MAX = 28;
function shortTerrainReason(reason: string): string {
  return reason.length <= TERRAIN_REASON_MAX ? reason : `${reason.slice(0, TERRAIN_REASON_MAX - 1).trimEnd()}…`;
}

function titleTerrainReason(reason: string): string {
  return shortTerrainReason(reason).replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

// Lazily loaded so a Hagga Basin user never downloads the WebGL renderer or the
// asset-URL table that comes with it.
const DeepDesertTerrain = lazy(() => import("./terrain/DeepDesertTerrain"));
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
// RhyoliteOre/AzuriteOre/...; Active Spice Fields -> Small/Medium/Large).
// Sub-type lists combine the backend's supported-type registry with values
// discovered in the loaded markers. This keeps known resources visible at a
// zero count while still admitting new game-added marker types automatically.
const EXPANDABLE_KEYS = new Set(["spice", "spice_active", "ore", "scrap", "flora", "poi", "house_representative", "trainer", "fortress", "hazard", "enemy", "vehicle"]);
// Zoom was capped at 100% (1 map-pixel-unit == 1 CSS pixel), too tight for
// precise marker/teleport placement.
// Minimum zoom is exactly the "contain" fit (the whole map visible, no
// scrollbar) -- 1 means no extra shrink past that; see liveMapMinimumZoom.
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
  player: true, player_online: true, player_offline: true, vehicle: true, base: true, storage: false,
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
  const knownSubtypesRef = useRef<Record<string, string[]>>({});
  const subtypeLabelsRef = useRef<Record<string, Record<string, string>>>({});
  const knownSubtypes = knownSubtypesRef.current;
  const subtypeLabels = subtypeLabelsRef.current;
  // "Pinned" marker (clicked -- stays open until a click lands outside every
  // marker) takes priority over "hoveredMarker" (transient preview, cleared
  // on mouseleave) -- see displayedMarker below.
  const [selected, setSelected] = useState<LiveMapMarker | null>(null);
  const [hoveredMarker, setHoveredMarker] = useState<LiveMapMarker | null>(null);
  const [filters, setFilters] = useState<Record<string, boolean>>(() => ({ ...DEFAULT_LAYER_FILTERS, ...loadDefaultLayerFilters() }));
  const [markerSearch, setMarkerSearch] = useState("");
  const [layerSettingsOpen, setLayerSettingsOpen] = useState(false);
  const [layerSettingsDraft, setLayerSettingsDraft] = useState<Record<string, boolean>>(DEFAULT_LAYER_FILTERS);
  const [layerSettingsSubtypeDraft, setLayerSettingsSubtypeDraft] = useState<Record<string, Record<string, boolean>>>({});
  const layerSettingsRef = useRef<HTMLDivElement | null>(null);
  const [coriolisSeed, setCoriolisSeed] = useState("");
  const [coriolisNextCycleAt, setCoriolisNextCycleAt] = useState("");
  const [coriolisSeedStaleSince, setCoriolisSeedStaleSince] = useState("");
  // Which of the Deep Desert's 12 cartography layouts this Coriolis cycle
  // selected, or null when it could not be read from the server logs -- which
  // includes the window after a cycle boundary, when the logged layout belongs
  // to the previous rotation (see coriolisSeed.js).
  const [coriolisLayout, setCoriolisLayout] = useState<number | null>(null);
  // Set once the terrain reports it cannot draw. Sticky for the session so a
  // failing GPU is not retried on every poll.
  const [terrainUnavailable, setTerrainUnavailable] = useState("");
  // On by default: the rendered terrain has no grid of its own, and relating a
  // marker to a sector is the common case. In the flat-image fallback this sits
  // over the grid burned into the picture, which is drawn at that image's own
  // mis-scaled extent -- the overlay is the one that agrees with the markers.
  const [showSectorGrid, setShowSectorGrid] = useState(true);
  // Off by default: a reading aid that darkens the terrain slightly.
  const [showElevationLines, setShowElevationLines] = useState(false);
  // The 3D view, radians. Both zero is the flat, top-down map.
  const [tilt, setTilt] = useState(0);
  const [yaw, setYaw] = useState(0);
  const [terrainApi, setTerrainApi] = useState<TerrainApi | null>(null);
  // Bumped on scroll while in 3D, where each marker has to be projected again.
  const [, setViewTick] = useState(0);
  const [rotateDrag, setRotateDrag] = useState<{ x: number; y: number; tilt: number; yaw: number } | null>(null);
  // The canvas mounts empty and paints only once ~7 MB of assets are in, so the
  // flat image stays up until it reports itself ready. Dropping the image when
  // the lazy chunk resolved left a window showing neither.
  //
  // Which map and layout went ready, not a bare boolean: a child's effect runs
  // before its parent's, so an effect here that reset the flag on a layout
  // change would undo the readiness the child had just reported.
  const [readyTerrainKey, setReadyTerrainKey] = useState<string | null>(null);
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
  // The height a location was picked at in 3D. Display only, never sent.
  const [targetHeight, setTargetHeight] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  // Distinct from `loading` -- that flips on every 5s auto-refresh poll too,
  // which would flicker the overlay constantly. This only tracks the load
  // triggered by switching map/partition, so the overlay appears just for
  // the switch itself.
  const [switching, setSwitching] = useState(false);
  // `grab`: for a pan begun in 3D, the camera then and what was grabbed.
  const [drag, setDrag] = useState<{ x: number; y: number; left: number; top: number; grab?: { camera: TerrainCamera; sx: number; sy: number; z: number } } | null>(null);
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
  const sectorLabelsRef = useRef<SVGGElement | null>(null);
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
        for (const [type, subtypes] of Object.entries(result.knownSubtypes || {})) {
          if (!EXPANDABLE_KEYS.has(type)) continue;
          if (!next[type]) next[type] = {};
          for (const subtype of subtypes) {
            if (!(subtype in next[type])) next[type][subtype] = savedSubtypeDefaults?.[type]?.[subtype] ?? DEFAULT_LAYER_FILTERS[type] ?? true;
          }
        }
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
      if (includeStatic) {
        knownSubtypesRef.current = result.knownSubtypes || {};
        subtypeLabelsRef.current = result.subtypeLabels || {};
      }
      setMapConfig(result.map || null);
      setMaps(result.maps || {});
      setPartitions(result.partitions || []);
      setCoriolisSeed(result.coriolisSeed || "");
      setCoriolisNextCycleAt(result.coriolisNextCycleAt || "");
      setCoriolisSeedStaleSince(result.coriolisSeedStaleSince || "");
      setCoriolisLayout(typeof result.coriolisLayout === "number" ? result.coriolisLayout : null);
      const mapName = result.map?.actorMap || result.map?.key;
      const available = (result.partitions || []).filter((row) => row.map === mapName);
      // Re-pick when nothing is selected OR when the selection is not one of
      // this map's partitions. There is no neutral "All Partitions" entry to
      // fall back to any more, so a stale id would leave the select displaying
      // one partition while the markers were filtered by another.
      const selectionIsValid = partitionId && available.some((row) => String(row.partition_id) === partitionId);
      if (!selectionIsValid) {
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
      if (event.key === "Escape") { setSelected(null); setTarget(null); }
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
    // tilt, yaw and the terrain API too: setZoomAround builds the 3D camera from them.
  }, [zoom, activeMap?.key, tilt, yaw, terrainApi]);
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
  const activePartition = partitionOptions.find((row) => String(row.partition_id) === partitionId);
  const partitionRuntimeStatus = activePartition?.ready === true
    ? "Ready"
    : activePartition?.alive === true
      ? "Starting"
      : activePartition?.ready === false
        ? "Offline"
        : "Unknown";
  const partitionIsOffline = activePartition?.ready === false && activePartition?.alive === false;
  // Partition-filtered but not yet subtype-filtered -- the base population
  // subtype counts are measured against, so a sub-item's own count doesn't
  // change/disappear just because the user unchecked it.
  const partitionFiltered = markers
    // Static-pool spice and POI markers have no partition_id at all (they're
    // not tied to a specific live dimension), so a marker without one should
    // never be dropped by the partition filter. spice_active markers do
    // carry a real partition_id and filter normally.
    .filter((marker) => !partitionId || marker.partition_id == null || String(marker.partition_id) === partitionId);
  const topLevelVisible = partitionFiltered.filter((marker) => {
    const type = String(marker.type);
    if (filters[type] === false) return false;
    if (type.toLowerCase() !== "player") return true;
    return filters[`player_${liveMapPlayerStatus(marker)}`] !== false;
  });
  const layerVisible = topLevelVisible.filter((marker) => !marker.subtype || subtypeFilters[String(marker.type)]?.[marker.subtype] !== false);
  const visible = layerVisible.filter((marker) => liveMapMarkerMatchesSearch(marker, markerSearch));
  const searching = markerSearch.trim() !== "";
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
  const rawPlayerStatusCounts = countPlayerStatuses(partitionFiltered);
  const inBounds = activeMap ? plotted.map((marker) => ({ marker, point: worldToLiveMapPoint(marker, activeMap) })).filter((item) => item.point?.inBounds) as { marker: LiveMapMarker; point: LiveMapPoint }[] : [];
  const targetPoint = target && activeMap ? worldToLiveMapPoint({ x: target.x, y: target.y }, activeMap) : null;
  const minimumZoom = liveMapMinimumZoom(activeMap, frameRef.current);
  const zoomMinPercent = Math.round(minimumZoom * 100);
  // The rendered terrain is an upgrade over the flat image, never a replacement:
  // anything missing here just means the image is used, with no error state.
  //
  // One expression decides both whether to draw terrain and what the readout
  // says, because as two they disagreed: the API caps the layout at 63 so that a
  // future Layout_12 is reported truthfully, the render gate stops at the eleven
  // that ship, and the readout consulted neither -- so an unshipped layout drew
  // the flat image while announcing "layout 12".
  const terrainFallback = activeMap?.key !== "DeepDesert" ? null
    : coriolisLayout === null ? "layout unknown"
      : !(Number.isInteger(coriolisLayout) && coriolisLayout >= 0 && coriolisLayout <= SHIPPED_LAYOUTS - 1)
        ? `layout ${coriolisLayout} not shipped`
        : terrainUnavailable || null;
  const terrainEligible = Boolean(activeMap?.key === "DeepDesert" && !terrainFallback);
  // Stable identity: the terrain effects depend on this, and a new function each
  // render would tear the WebGL context down and rebuild it on every poll.
  const handleTerrainUnavailable = useCallback((reason: string) => {
    setTerrainUnavailable(reason || "unavailable");
  }, []);
  const terrainKeyRef = useRef<string>("");
  const handleTerrainReady = useCallback(() => setReadyTerrainKey(terrainKeyRef.current), []);
  // Pixel-space geometry, so it scales and scrolls with the markers rather than
  // being recomputed per frame. Memoised on identity, not just rebuilt cheaply:
  // the label effect below depends on it, so a fresh object each render would
  // tear down and re-add the scroll listener and the ResizeObserver on every
  // marker hover and every five-second poll.
  // A picked point borrows the marker overlay and the marker teleport flow by
  // presenting itself as a marker. Everything downstream compares type and id as
  // strings, so this needs no stable identity.
  const pickedMarker: LiveMapMarker | null = target && activeMap ? {
    id: "picked",
    type: "picked_location",
    name: "Picked Location",
    map: activeMap.actorMap || activeMap.key,
    partition_id: partitionId ? Number(partitionId) : undefined,
    x: target.x,
    y: target.y
  } : null;
  const pickedSector = target && activeMap?.key === "DeepDesert" ? sectorForWorldPoint(target.x, target.y) : null;
  const terrainKey = `${activeMap?.key || ""}:${coriolisLayout ?? ""}`;
  terrainKeyRef.current = terrainKey;
  const terrainReady = readyTerrainKey === terrainKey;
  const can3D = terrainEligible && terrainReady && terrainApi !== null;
  const is3D = can3D && (tilt !== 0 || yaw !== 0);
  // The same helper the terrain canvas builds its camera from. A function,
  // because handlers call it again: the scroll moves between renders.
  function currentView3d() {
    const frame = frameRef.current;
    if (!is3D || !activeMap || !frame || !terrainApi) return null;
    const viewport = terrainViewport(activeMap, zoom, frame.scrollLeft, frame.scrollTop, frame.clientWidth, frame.clientHeight, true);
    const camera = liveMapCamera(activeMap, zoom, viewport, tilt, yaw, terrainApi.pivotZ, terrainApi.topZ);
    return camera ? { viewport, camera } : null;
  }
  const view3d = currentView3d();
  useEffect(() => {
    const frame = frameRef.current;
    if (!is3D || !frame) return undefined;
    let queued = 0;
    const tick = () => {
      if (queued) return;
      queued = requestAnimationFrame(() => { queued = 0; setViewTick((n) => n + 1); });
    };
    frame.addEventListener("scroll", tick, { passive: true });
    const observer = new ResizeObserver(tick);
    observer.observe(frame);
    return () => {
      frame.removeEventListener("scroll", tick);
      observer.disconnect();
      if (queued) cancelAnimationFrame(queued);
    };
  }, [is3D]);
  // Leaving the rendered terrain leaves 3D with it.
  useEffect(() => {
    if (!terrainEligible) { setTilt(0); setYaw(0); }
  }, [terrainEligible]);
  const handleTerrainApi = useCallback((api: TerrainApi | null) => setTerrainApi(api), []);
  // What the terrain hides has been measured again: place the markers again.
  const handleTerrainOcclusion = useCallback(() => setViewTick((n) => n + 1), []);
  /**
   * Where a map point is drawn, inside the marker layer and relative to the
   * viewport. In 3D the marker layer covers the viewport, not the map. In 3D it is projected at height `z`, or the sand's. `visible` is
   * false outside the view, where drawing it would stretch the scroll area.
   */
  function placePoint(point: LiveMapPoint, z?: number) {
    const frame = frameRef.current;
    if (!view3d || !activeMap || !terrainApi) {
      return {
        left: point.px * zoom,
        top: point.py * zoom,
        viewportX: point.px * zoom - (frame?.scrollLeft || 0),
        viewportY: point.py * zoom - (frame?.scrollTop || 0),
        visible: true,
        occluded: false
      };
    }
    const world = liveMapPixelsToWorld(point.px, point.py, activeMap);
    if (!world) return null;
    const height = z !== undefined && Number.isFinite(z) && z !== 0 ? z : terrainApi.heightAt(world.x, world.y);
    const { viewport, camera } = view3d;
    const s = projectToScreen(camera, world.x, world.y, height);
    return {
      left: s.sx,
      top: s.sy,
      viewportX: s.sx + viewport.left - (frame?.scrollLeft || 0),
      viewportY: s.sy + viewport.top - (frame?.scrollTop || 0),
      visible: !s.behind && s.sx >= 0 && s.sx <= viewport.width && s.sy >= 0 && s.sy <= viewport.height,
      occluded: tilt > 0 && terrainApi.occluded(world.x, world.y, height)
    };
  }
  const targetPlaced = targetPoint ? placePoint(targetPoint, targetHeight) : null;
  /**
   * The world point under a mouse event in 3D: read back from the terrain, or
   * failing that the ray walked onto the sand. Null outside the map.
   */
  function worldUnderPointer(event: { clientX: number; clientY: number }) {
    const view3d = currentView3d();
    if (!view3d || !canvasRef.current || !terrainApi || !activeMap) return null;
    const onMap = <T extends { x: number; y: number }>(world: T) => (
      world.x >= Math.min(activeMap.minX, activeMap.maxX) && world.x <= Math.max(activeMap.minX, activeMap.maxX)
      && world.y >= Math.min(activeMap.minY, activeMap.maxY) && world.y <= Math.max(activeMap.minY, activeMap.maxY) ? world : null
    );
    const rect = canvasRef.current.getBoundingClientRect();
    const sx = event.clientX - rect.left - view3d.viewport.left;
    const sy = event.clientY - rect.top - view3d.viewport.top;
    const picked = terrainApi.pick(sx, sy);
    if (picked) return onMap(picked);
    let z = terrainApi.pivotZ;
    let ground = screenToWorldAtZ(view3d.camera, sx, sy, z);
    for (let i = 0; i < 4; i++) {
      z = terrainApi.heightAt(ground.x, ground.y);
      ground = screenToWorldAtZ(view3d.camera, sx, sy, z);
    }
    return onMap({ x: ground.x, y: ground.y, z });
  }
  const sectorGrid = useMemo(() => (activeMap ? sectorGridFor(activeMap) : null), [activeMap]);
  // Keep each sector label inside the visible part of its own cell. Above about
  // 2x zoom a 250,000 uu cell is wider than the frame, so a label pinned to the
  // cell's true centre scrolls out of view and the grid stops answering the one
  // question it exists for. Positions are written straight to the DOM rather
  // than through state: this runs on every scroll frame, and re-rendering 81
  // text nodes each time is not worth it.
  useEffect(() => {
    const frame = frameRef.current;
    const group = sectorLabelsRef.current;
    if (!frame || !group || !showSectorGrid || !sectorGrid) return;
    let queued = 0;
    const place = () => {
      queued = 0;
      const view = {
        left: frame.scrollLeft / zoom,
        top: frame.scrollTop / zoom,
        right: (frame.scrollLeft + frame.clientWidth) / zoom,
        bottom: (frame.scrollTop + frame.clientHeight) / zoom
      };
      const padding = (SECTOR_LABEL_PX * 1.6) / zoom;
      const nodes = group.childNodes;
      sectorGrid.labels.forEach((label, index) => {
        const node = nodes[index] as SVGTextElement | undefined;
        if (!node) return;
        const anchor = labelAnchorInView(label, view, padding);
        if (!anchor) {
          node.style.display = "none";
          return;
        }
        node.style.display = "";
        node.setAttribute("x", String(anchor.px));
        node.setAttribute("y", String(anchor.py));
      });
    };
    const schedule = () => {
      if (queued) return;
      queued = requestAnimationFrame(place);
    };
    place();
    frame.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(frame);
    return () => {
      frame.removeEventListener("scroll", schedule);
      observer.disconnect();
      if (queued) cancelAnimationFrame(queued);
    };
    // is3D: the flat grid is unmounted while tilted and re-placed on the way back.
  }, [showSectorGrid, sectorGrid, zoom, is3D]);
  // Tilted, the terrain draws the lines; only the labels are projected here, each render.
  const sectorLabels3d = view3d && showSectorGrid && sectorGrid
    ? projectSectorLabels(view3d.camera, SECTOR_LABEL_PX * 1.6, SECTOR_LABEL_PX * SECTOR_LABEL_PX * 4)
    : null;

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
    if ((event.target as HTMLElement).closest(".live-map-marker, .live-map-target")) return;
    if (view3d) {
      const picked = worldUnderPointer(event);
      if (picked) { setTarget({ x: picked.x, y: picked.y }); setTargetHeight(picked.z); }
      return;
    }
    const rect = canvasRef.current.getBoundingClientRect();
    const px = (event.clientX - rect.left) / zoom;
    const py = (event.clientY - rect.top) / zoom;
    const world = liveMapPixelsToWorld(px, py, activeMap);
    if (!world) return;
    setTargetHeight(undefined);
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
    const view3d = currentView3d();
    if (view3d && anchor && activeMap && terrainApi && canvas) {
      // 3D: keep the ground under the cursor fixed; the scroll centre is the camera centre.
      const rect = canvas.getBoundingClientRect();
      const ground = screenToWorldAtZ(view3d.camera, anchor.clientX - rect.left - view3d.viewport.left, anchor.clientY - rect.top - view3d.viewport.top, terrainApi.pivotZ);
      const centre = zoomCentreFor(view3d.camera, ground, oldZoom, next);
      const point = worldToLiveMapPoint(centre, activeMap);
      if (point) {
        zoomAnchorRef.current = { mapX: point.px, mapY: point.py, viewportX: frame.clientWidth / 2, viewportY: frame.clientHeight / 2 };
        setZoom(next);
        return;
      }
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
    if (view3d && activeMap) {
      const world = worldUnderPointer(event);
      const point = world ? worldToLiveMapPoint(world, activeMap) : null;
      return point ? { px: point.px, py: point.py, inBounds: true } : null;
    }
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
    const targetRuntime = partitions.find((row) => String(row.partition_id) === targetPartition);
    if (targetRuntime?.ready === false) return [];
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
  }, [playerDrag, zoom, activeMap?.key, tilt, yaw]);
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
            <select value={partitionId} onChange={(event) => setPartitionId(event.target.value)}>{partitionOptions.length === 0 && <option value="">No partitions available</option>}{partitionOptions.map((row) => <option key={`${row.map}-${row.partition_id}`} value={String(row.partition_id)}>{partitionDisplayNames[String(row.partition_id)] || row.name || "Partition"} [{row.partition_id}] ({row.marker_count})</option>)}</select>
          </label>
        </div>
        <div className="live-map-view-summary">
          <span className="live-map-view-label">Overview</span>
          <div className="key-value-grid live-map-stats">
            <div className="key-value-item"><span>Visible</span><strong>{visible.length}</strong></div>
            <div className="key-value-item"><span>In Bounds</span><strong>{inBounds.length}</strong></div>
            <div className="key-value-item"><span>Zoom</span><strong>{zoomDisplayPercent}%</strong></div>
            {activePartition && <div className="key-value-item"><span>Partition Status</span><strong>{partitionRuntimeStatus}</strong></div>}
            {coriolisSeed && <div className="key-value-item"><span>Coriolis Seed</span><strong>{coriolisSeedNumber(coriolisSeed)}</strong></div>}
            {activeMap?.key === "DeepDesert" && <div className="key-value-item"><span>Terrain</span><strong title={terrainFallback ? `Showing the flat map: ${terrainFallback}` : undefined}>{
              terrainFallback ? `Flat Map (${titleTerrainReason(terrainFallback)})` : `Layout ${coriolisLayout}`
            }</strong></div>}
            {coriolisNextCycleAt && <div className="key-value-item"><span>Coriolis Countdown</span><strong>{formatCoriolisCountdown(coriolisNextCycleAt, now)}</strong></div>}
            {/* The seed is only printed at container startup, so between a
                Coriolis boundary and the next restart the server can't know
                which seed is live. Possible Spice Locations is suppressed in that
                window rather than showing the previous cycle's pool -- say so,
                otherwise the empty layer reads as a bug. */}
            {coriolisSeedStaleSince && <div className="key-value-item"><span>Coriolis Seed</span><strong title={`Cycle rolled over at ${coriolisSeedStaleSince}; the new seed is only logged when the map server restarts.`}>Awaiting Restart</strong></div>}
          </div>
          {partitionIsOffline && <div className="live-map-partition-offline-note" role="status">
            <strong>Saved Map Data</strong>
            <span>This dynamic partition is offline. Terrain, resources, bases, and vehicles remain visible from saved data. Teleport becomes available after normal in-game travel starts the partition.</span>
          </div>}
        </div>
      </div>
    </section>
    <div className="live-map-layout">
      <aside className="live-map-sidebar">
        <section className="action-section live-map-search-section">
          <label htmlFor="live-map-marker-search">
            <span className="live-map-view-label">Search Map</span>
            <span className="live-map-search-control">
              <input id="live-map-marker-search" type="search" value={markerSearch} onChange={(event) => setMarkerSearch(event.target.value)} placeholder="Player, owner, base, vehicle..." />
              {markerSearch && <button type="button" onClick={() => setMarkerSearch("")}>Clear</button>}
            </span>
          </label>
          <span className="muted">Searches player names and marker names, plus base and vehicle owners.</span>
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
                  if (key === "player") {
                    const statusKeys = ["online", "offline"];
                    const checkedCount = statusKeys.filter((status) => layerSettingsDraft[`player_${status}`] !== false).length;
                    const allChecked = checkedCount === statusKeys.length;
                    const noneChecked = checkedCount === 0;
                    return indent(<div className="live-map-layer-group" key={key}>
                      <label className="checkbox-row live-map-layer">
                        <span className="live-map-layer-label">Player</span>
                        <IndeterminateCheckbox checked={allChecked} indeterminate={!allChecked && !noneChecked} onChange={() => {
                          const nextValue = !allChecked;
                          setLayerSettingsDraft((prev) => ({ ...prev, player: nextValue, player_online: nextValue, player_offline: nextValue }));
                        }} />
                      </label>
                      <div className="live-map-layer-sublist">{statusKeys.map((status) => <label key={status} className="checkbox-row live-map-layer live-map-layer-sub">
                        <span className="live-map-layer-label">{titleCase(status)}</span>
                        <input type="checkbox" checked={layerSettingsDraft[`player_${status}`] !== false} onChange={() => setLayerSettingsDraft((prev) => {
                          const next = { ...prev, [`player_${status}`]: prev[`player_${status}`] === false };
                          next.player = statusKeys.some((playerStatus) => next[`player_${playerStatus}`] !== false);
                          return next;
                        })} />
                      </label>)}</div>
                    </div>, key);
                  }
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
            return <>
            {/* Terrain overlays, grouped above the marker legend. The divider is
                on the group, not on a row, so both sit above it. */}
            {(activeMap?.key === "DeepDesert" || terrainEligible) && <div className="live-map-overlay-group">
              {activeMap?.key === "DeepDesert" && <label className="checkbox-row live-map-layer">
                <span className="live-map-layer-label">Sector Grid</span>
                <span className="muted">Overlay</span>
                <span className="live-map-sector-grid-swatch" aria-hidden="true" />
                <input type="checkbox" aria-label="Sector Grid" checked={showSectorGrid} onChange={() => setShowSectorGrid((on) => !on)} />
              </label>}
              {/* Only offered when the 3D terrain is actually drawing -- it is a
                  shader effect, so on the flat fallback image it would do nothing. */}
              {terrainEligible && <label className="checkbox-row live-map-layer">
                <span className="live-map-layer-label">Elevation Lines</span>
                <span className="muted">Terrain</span>
                <span className="live-map-elevation-swatch" aria-hidden="true" />
                <input type="checkbox" aria-label="Elevation Lines" checked={showElevationLines} onChange={() => setShowElevationLines((on) => !on)} />
              </label>}
            </div>}
            {LEGEND_LAYOUT.map((item, index) => {
            if ("header" in item) {
              const sectionName = item.header;
              currentSection = sectionName;
              const sectionExpanded = expandedSections[sectionName] !== false;
              const memberKeys = (SECTION_MEMBERS[sectionName] || []).filter((memberKey) => !(GATED_LAYER_KEYS.has(memberKey) && capabilities[memberKey] === false) && ((rawCategoryCounts[memberKey] || 0) > 0 || Boolean(knownSubtypes[memberKey]?.length)));
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
            if ((rawCategoryCounts[key] || 0) === 0 && !(knownSubtypes[key]?.length)) return null;
            if (key === "player") {
              const statusKeys = ["online", "offline"];
              const checkedCount = statusKeys.filter((status) => filters[`player_${status}`] !== false).length;
              const allChecked = checkedCount === statusKeys.length;
              const noneChecked = checkedCount === 0;
              const expanded = Boolean(expandedGroups.player);
              return indent(<div className="live-map-layer-group">
                <label className="checkbox-row live-map-layer">
                  <button type="button" className="live-map-layer-expand" aria-label={expanded ? "Collapse Player" : "Expand Player"} onClick={() => setExpandedGroups((prev) => ({ ...prev, player: !prev.player }))}>{expanded ? "−" : "+"}</button>
                  <span className="live-map-layer-label">Player</span>
                  <span className="muted">{markerCounts.player || 0}</span>
                  <span className="live-map-legend-dot-spacer" aria-hidden="true" />
                  <IndeterminateCheckbox checked={allChecked} indeterminate={!allChecked && !noneChecked} onChange={() => {
                    const nextValue = !allChecked;
                    setFilters((prev) => ({ ...prev, player: nextValue, player_online: nextValue, player_offline: nextValue }));
                  }} />
                </label>
                {expanded && <div className="live-map-layer-sublist">{statusKeys.map((status) => {
                  const checked = filters[`player_${status}`] !== false;
                  return <label key={status} className="checkbox-row live-map-layer live-map-layer-sub">
                    <span className="live-map-layer-label">{titleCase(status)}</span>
                    <span className="muted">{rawPlayerStatusCounts[status] || 0}</span>
                    <span className={`live-map-legend-dot marker-player ${status}`} />
                    <input type="checkbox" checked={checked} onChange={() => setFilters((prev) => {
                      const next = { ...prev, [`player_${status}`]: !checked };
                      next.player = statusKeys.some((playerStatus) => next[`player_${playerStatus}`] !== false);
                      return next;
                    })} />
                  </label>;
                })}</div>}
              </div>, key);
            }
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
                  const checked = subtypeFilters[key][subtype] !== false;
                  const displayLabel = subtypeLabels[key]?.[subtype] || label;
                  return <label key={subtype} className="checkbox-row live-map-layer live-map-layer-sub">
                    <span className="live-map-layer-label">{spaceWords(displayLabel)}</span>
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
            })}
            </>;
          })()}</div>
        </section>
      </aside>
      <div className="live-map-main">
        <div className="live-map-toolbar">
          <button onClick={() => setZoomAround(zoom * 1.18)}>Zoom In</button>
          <button onClick={() => setZoomAround(zoom * 0.84)}>Zoom Out</button>
          <button onClick={fitLiveMapView}>Fit Map</button>
          <label>Zoom<input className="live-map-zoom-range" type="range" min={zoomMinPercent} max={zoomMaxPercent} value={zoomValuePercent} style={{ "--zoom-progress": `${zoomProgressPercent}%` } as React.CSSProperties} onChange={(event) => setZoomAround(Number(event.target.value) / 100)} /></label>
          {can3D && <label>Tilt<input className="live-map-zoom-range live-map-tilt-range" type="range" min={0} max={Math.round((MAX_TILT * 180) / Math.PI)} step={1} value={Math.round((tilt * 180) / Math.PI)} style={{ "--zoom-progress": `${(tilt / MAX_TILT) * 100}%` } as React.CSSProperties} onChange={(event) => setTilt((Number(event.target.value) * Math.PI) / 180)} /></label>}
          {can3D && <button onClick={() => { setTilt(0); setYaw(0); }} disabled={!is3D}>Top-Down</button>}
          <span className="muted">Drag to Pan. Mouse Wheel Zooms. Double-click to pick a location.{can3D ? " Right-drag to tilt and rotate." : ""}</span>
        </div>
        {teleportResult && <HomeTaskResultCard result={teleportResult} />}
        <div className="live-map-stage">
        <div className={`live-map-frame ${drag ? "dragging" : ""} ${playerDrag ? "dragging-player" : ""}`} ref={frameRef}
          onDoubleClick={handleMapDoubleClick}
          onContextMenu={(event) => { if (can3D) event.preventDefault(); }}
          onMouseDown={(event) => {
            if ((event.target as HTMLElement).closest(".live-map-marker, .live-map-target")) return;
            // Right-drag turns the view: across rotates, up leans it back.
            if (event.button === 2) { if (can3D) { event.preventDefault(); setRotateDrag({ x: event.clientX, y: event.clientY, tilt, yaw }); } return; }
            if (event.button !== 0) return;
            // 3D: remember what was grabbed, so that exact point follows the pointer.
            const view = currentView3d();
            const rect = canvasRef.current?.getBoundingClientRect();
            const grab = view && rect && terrainApi ? {
              camera: view.camera,
              sx: event.clientX - rect.left - view.viewport.left,
              sy: event.clientY - rect.top - view.viewport.top,
              z: worldUnderPointer(event)?.z ?? terrainApi.pivotZ
            } : undefined;
            setDrag({ x: event.clientX, y: event.clientY, left: frameRef.current?.scrollLeft || 0, top: frameRef.current?.scrollTop || 0, grab });
          }}
          onMouseMove={(event) => {
            if (rotateDrag) {
              setYaw(rotateDrag.yaw + ((event.clientX - rotateDrag.x) * ROTATE_DEG_PER_PX * Math.PI) / 180);
              setTilt(Math.max(0, Math.min(MAX_TILT, rotateDrag.tilt - ((event.clientY - rotateDrag.y) * TILT_DEG_PER_PX * Math.PI) / 180)));
              return;
            }
            if (!drag || !frameRef.current) return;
            const dx = event.clientX - drag.x;
            const dy = event.clientY - drag.y;
            // 3D: a screen drag is a camera move.
            const delta = drag.grab
              ? panScrollDelta(drag.grab.camera, drag.grab, { sx: drag.grab.sx + dx, sy: drag.grab.sy + dy }, drag.grab.z)
              : { left: -dx, top: -dy };
            frameRef.current.scrollLeft = drag.left + delta.left;
            frameRef.current.scrollTop = drag.top + delta.top;
          }}
          onMouseUp={() => { setDrag(null); setRotateDrag(null); }}
          onMouseLeave={() => { setDrag(null); setRotateDrag(null); }}>
          {switching && <div className="live-map-loading-overlay"><span className="spinner" aria-hidden="true" /><strong className="loading-dots">Loading Map</strong></div>}
          {activeMap ? <div className={`live-map-canvas${is3D ? " is-3d" : ""}`} ref={canvasRef} style={{ width: Math.floor(activeMap.width * zoom), height: Math.floor(activeMap.height * zoom) }}>
            {terrainEligible
              ? <>
                  {!terrainReady && activeMap.image && <img className="live-map-image" src={activeMap.image} alt={activeMap.label} draggable={false} />}
                  <Suspense fallback={null}>
                    <DeepDesertTerrain config={activeMap} layout={coriolisLayout as number} zoom={zoom} frameRef={frameRef} onUnavailable={handleTerrainUnavailable} onReady={handleTerrainReady} elevationLines={showElevationLines} sectorGrid={showSectorGrid} tilt={tilt} yaw={yaw} onTerrainApi={handleTerrainApi} onOcclusion={handleTerrainOcclusion} />
                  </Suspense>
                </>
              : activeMap.image ? <img className="live-map-image" src={activeMap.image} alt={activeMap.label} draggable={false} /> : <div className="live-map-placeholder">{activeMap.label}</div>}
            {showSectorGrid && sectorGrid && !is3D && <svg className="live-map-sector-grid" viewBox={`0 0 ${activeMap.width} ${activeMap.height}`} width={Math.floor(activeMap.width * zoom)} height={Math.floor(activeMap.height * zoom)} aria-hidden="true">
              <g className="lines">
                {sectorGrid.lines.map((line, index) => <line key={index} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} className={line.edge ? "edge" : ""} />)}
              </g>
              <g className="labels" ref={sectorLabelsRef}>
                {sectorGrid.labels.map((label) => <text key={label.text} x={label.px} y={label.py} fontSize={SECTOR_LABEL_PX / Math.max(zoom, 0.01)}>{label.text}</text>)}
              </g>
            </svg>}
            {sectorLabels3d && view3d && <svg className="live-map-sector-grid is-3d" style={{ left: view3d.viewport.left, top: view3d.viewport.top }} width={view3d.viewport.width} height={view3d.viewport.height} aria-hidden="true">
              <g className="labels">
                {sectorLabels3d.map((label) => <text key={label.text} x={label.sx} y={label.sy} fontSize={SECTOR_LABEL_PX}>{label.text}</text>)}
              </g>
            </svg>}
            <div className="live-map-marker-layer" style={view3d ? { inset: "auto", left: view3d.viewport.left, top: view3d.viewport.top, width: view3d.viewport.width, height: view3d.viewport.height } : undefined}>
              {targetPoint && pickedMarker && targetPlaced?.visible && <div className="live-map-target" style={{ left: `${targetPlaced.left}px`, top: `${targetPlaced.top}px` }}>
                <div className={`live-map-marker-overlay ${overlayAnchorClasses(targetPlaced.viewportX, targetPlaced.viewportY, frameRef.current)}`} role="dialog" aria-label="Picked location"
                  onMouseDown={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}>
                  <div className="live-map-marker-overlay-header">
                    <strong>Picked Location</strong>
                    <button type="button" className="live-map-marker-overlay-close" aria-label="Close" onClick={() => setTarget(null)}>×</button>
                  </div>
                  <div className="live-map-marker-overlay-subtitle">{pickedSector ? `Sector ${pickedSector}` : activeMap?.label || ""}</div>
                  <div className="live-map-marker-overlay-facts">
                    <span>X</span><strong>{target!.x.toFixed(0)}</strong>
                    <span>Y</span><strong>{target!.y.toFixed(0)}</strong>
                    <span>Partition</span><strong>{partitionDisplayNames[partitionId] || partitionId || "none selected"}</strong>
                  </div>
                  <div className="live-map-marker-overlay-actions">
                    <button type="button" className="live-map-marker-overlay-action" disabled={onlinePlayersForMarker(pickedMarker).length === 0} title={onlinePlayersForMarker(pickedMarker).length === 0 ? "Teleport is available only when an online player is already inside this running partition." : undefined} onClick={() => openTeleportPicker(pickedMarker)}>Teleport</button>
                  </div>
                  {teleportPickerFor && String(teleportPickerFor.id) === "picked" && <div className="live-map-marker-overlay-teleport">
                    <select aria-label="Teleport destination player" value={teleportPickerPlayerId} onChange={(event) => setTeleportPickerPlayerId(event.target.value)}>
                      {onlinePlayersForMarker(pickedMarker).map((row) => <option key={playerMarkerId(row)} value={playerMarkerId(row)}>{friendlyMarkerName(row)}</option>)}
                    </select>
                    <div className="live-map-marker-overlay-actions">
                      <button type="button" className="live-map-marker-overlay-action" onClick={() => void confirmTeleportToMarker(pickedMarker, teleportPickerPlayerId)}>Confirm</button>
                      <button type="button" className="live-map-marker-overlay-action" onClick={() => setTeleportPickerFor(null)}>Cancel</button>
                    </div>
                  </div>}
                </div>
              </div>}
              {inBounds.map(({ marker, point }, index) => {
                const playerStatus = liveMapPlayerStatus(marker);
                const isPinned = Boolean(selected && String(selected.type) === String(marker.type) && String(selected.id) === String(marker.id));
                const isHovered = Boolean(hoveredMarker && String(hoveredMarker.type) === String(marker.type) && String(hoveredMarker.id) === String(marker.id));
                // A pinned marker always wins -- hovering a different marker
                // elsewhere on the map never displaces the pinned overlay.
                const overlayOpen = isPinned || (!selected && isHovered);
                const isTeleportPickerOpen = Boolean(teleportPickerFor && String(teleportPickerFor.type) === String(marker.type) && String(teleportPickerFor.id) === String(marker.id));
                const isPlayer = String(marker.type).toLowerCase() === "player";
                const canTeleportToMarker = onlinePlayersForMarker(marker).length > 0;
                const isDraggingThisPlayer = Boolean(playerDrag && String(playerDrag.marker.id) === String(marker.id) && String(playerDrag.marker.type) === String(marker.type));
                const isPreviewingThisPlayer = Boolean(playerTeleportPreview && String(playerTeleportPreview.marker.id) === String(marker.id) && String(playerTeleportPreview.marker.type) === String(marker.type));
                const renderPoint = isDraggingThisPlayer ? playerDrag!.point : isPreviewingThisPlayer ? playerTeleportPreview!.point : point;
                // A marker being dragged or previewed takes the ground's height, not its own.
                const placed = placePoint(renderPoint, renderPoint === point ? Number(marker.z) : undefined);
                if (!placed || !placed.visible) return null;
                // Hidden behind the tilted terrain -- but never the marker being
                // worked with, and never while a search is narrowing the map.
                if (placed.occluded && !searching && !isPinned && !isDraggingThisPlayer && !isPreviewingThisPlayer) return null;
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
                  style={{ left: `${placed.left}px`, top: `${placed.top}px` }}>
                  {overlayOpen && <div className={`live-map-marker-overlay ${overlayAnchorClasses(placed.viewportX, placed.viewportY, frameRef.current)}`} role="dialog" aria-label={`${friendlyMarkerType(String(marker.type))}: ${friendlyMarkerName(marker)}`}>
                    <div className="live-map-marker-overlay-header">
                      <strong>{friendlyMarkerName(marker)}</strong>
                      {isPlayer && <span className={`live-map-player-status ${playerStatus}`}>{titleCase(playerStatus)}</span>}
                      {isPinned && <button type="button" className="live-map-marker-overlay-close" aria-label="Close" onClick={(event) => { event.stopPropagation(); setSelected(null); setHoveredMarker(null); }}>×</button>}
                    </div>
                    {!isPlayer && <div className="live-map-marker-overlay-subtitle">{liveMapOverlaySubtitle(marker)}</div>}
                    <div className="live-map-marker-overlay-facts">
                      {liveMapOverlayFacts(marker, maps, partitions, partitionDisplayNames).map(([key, value]) => <React.Fragment key={key}><span>{key}</span><strong>{value}</strong></React.Fragment>)}
                    </div>
                    <div className="live-map-marker-overlay-actions">
                      <button type="button" className="live-map-marker-overlay-action" disabled={!canTeleportToMarker} title={!canTeleportToMarker ? "Teleport is available only when an online player is already inside this running partition." : undefined} onClick={(event) => { event.stopPropagation(); openTeleportPicker(marker); }}>Teleport</button>
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
        {is3D && <LiveMapCompass yaw={yaw} onFaceNorth={() => setYaw(0)} />}
        </div>
      </div>
    </div>
    {Object.entries(overlays).filter(([, reason]) => reason).map(([key, reason]) => <p className="danger-note" key={key}>{key}: {reason}</p>)}
    {displayRows.length > 0 && <DataTable rows={displayRows.map((row) => ({ ...row, type: friendlyMarkerType(String(row.type)) })) as Record<string, unknown>[]} columns={["type", "display_name", "map", "partition_id", "x", "y", "z"]} />}
  </section>;
}


export function mergeLiveMapRows(previous: LiveMapMarker[], incoming: LiveMapMarker[], includeStatic: boolean, mapName = "") {
  if (includeStatic) return incoming;
  const retainedStatic = previous.filter((marker) => STATIC_MARKER_TYPES.has(String(marker.type)) && (!mapName || marker.map === mapName));
  return [...retainedStatic, ...incoming];
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
// Right-drag sensitivity.
const ROTATE_DEG_PER_PX = 0.3;
const TILT_DEG_PER_PX = 0.3;
const OVERLAY_WIDTH = 230;
const OVERLAY_MAX_HEIGHT = 320;
const OVERLAY_GAP = 10;
const OVERLAY_EDGE_MARGIN = 12;
/** Which way a marker's overlay opens, from where the marker sits in the viewport. */
function overlayAnchorClasses(viewportX: number, viewportY: number, frame: HTMLDivElement | null) {
  if (!frame) return "";
  const classes: string[] = [];
  if (viewportX < OVERLAY_WIDTH / 2 + OVERLAY_EDGE_MARGIN) classes.push("anchor-left");
  else if (viewportX > frame.clientWidth - OVERLAY_WIDTH / 2 - OVERLAY_EDGE_MARGIN) classes.push("anchor-right");
  if (viewportY > frame.clientHeight - OVERLAY_MAX_HEIGHT - OVERLAY_GAP - OVERLAY_EDGE_MARGIN) classes.push("anchor-above");
  return classes.join(" ");
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

function countPlayerStatuses(markers: LiveMapMarker[]) {
  return markers.reduce<Record<string, number>>((acc, marker) => {
    if (String(marker.type || "").toLowerCase() !== "player") return acc;
    const status = liveMapPlayerStatus(marker);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
}

export function liveMapMarkerMatchesSearch(marker: LiveMapMarker, search: string) {
  const query = String(search || "").trim().toLocaleLowerCase();
  if (!query) return true;
  const searchable = [
    friendlyMarkerName(marker),
    marker.name,
    marker.owner_name,
    marker.character_name,
    marker.player_name,
    marker.subtypeLabel,
    marker.subtype,
    marker.base_type,
    marker.sector,
    marker.type,
    marker.id
  ];
  return searchable.some((value) => String(value ?? "").toLocaleLowerCase().includes(query));
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
  if (marker.subtypeLabel) return String(marker.subtypeLabel);
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
    spice: "Possible Spice Locations",
    spice_active: "Active Spice Fields",
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
