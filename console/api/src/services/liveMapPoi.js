import { liveMapPoiAllMarkers, liveMapPoiMarkers } from "../duneDb.js";
import { withLiveMapSector } from "../liveMapSector.js";

// The registry of dune.markers-backed live map categories -- one source of
// truth for both the backend aggregation below and the frontend's Layers
// legend. Adding a new category once it has a real data source is: add one
// entry here, add its ILIKE patterns to duneDb.js's POI_CATEGORY_PATTERNS,
// done -- no new query function, no new orchestration code.
export const POI_CATEGORIES = [
  { key: "ore", label: "Ores & Metals", group: "Spice & Resources" },
  { key: "scrap", label: "Scrap & Wrecks", group: "Spice & Resources" },
  { key: "flora", label: "Plants & Fibers", group: "Spice & Resources" },
  { key: "poi", label: "POI's", group: "World" },
  { key: "house_representative", label: "House Representative", group: "World" },
  { key: "trainer", label: "Trainer", group: "World" },
  { key: "fortress", label: "Fortress", group: "World" },
  { key: "hazard", label: "Hazard Zones", group: "World" },
  { key: "enemy", label: "Enemy Camp/Outpost", group: "World" }
];

// Known game marker identifiers keep the layer controls stable even before a
// player has rediscovered a resource in the current Coriolis cycle. Unknown
// future identifiers are still appended dynamically from dune.markers.
export const LIVE_MAP_KNOWN_SUBTYPES = Object.freeze({
  ore: Object.freeze([
    "AzuriteOre", "AzuritePickup",
    "BasaltOre", "BasaltPickup",
    "BauxiteOre", "BauxitePickup",
    "DolomiteRock", "DolomitePickup",
    "ErythriteOre", "ErythritePickup",
    "JasmiumOre", "JasmiumPickup",
    "MagnetiteOre", "MagnetitePickup",
    "RhyoliteOre", "RhyolitePickup",
    "StravidiumOre", "StravidiumPickup",
    "TitaniumOre", "TitaniumPickup"
  ])
});

const RESOURCE_DISPLAY_NAMES = Object.freeze({
  Azurite: "Copper",
  Basalt: "Basalt",
  Bauxite: "Aluminium",
  Dolomite: "Carbon",
  Erythrite: "Erythrite",
  Jasmium: "Jasmium",
  Magnetite: "Iron",
  Rhyolite: "Granite",
  Stravidium: "Stravidium",
  Titanium: "Titanium"
});

export function liveMapSubtypeLabel(category, subtype) {
  const raw = String(subtype || "");
  if (category !== "ore") return raw;
  const material = raw.replace(/(Ore|Pickup|Rock)$/, "");
  return RESOURCE_DISPLAY_NAMES[material] || material || raw;
}

export const LIVE_MAP_SUBTYPE_LABELS = Object.freeze(Object.fromEntries(
  Object.entries(LIVE_MAP_KNOWN_SUBTYPES).map(([category, subtypes]) => [
    category,
    Object.freeze(Object.fromEntries(subtypes.map((subtype) => [subtype, liveMapSubtypeLabel(category, subtype)])))
  ])
));

const POI_CACHE_TTL_MS = 15_000;
const poiCacheByDb = new WeakMap();
const fallbackPoiCacheByMap = new Map();

function getPoiCacheForDb(db) {
  if (!db || (typeof db !== "object" && typeof db !== "function")) {
    return fallbackPoiCacheByMap;
  }
  let mapCache = poiCacheByDb.get(db);
  if (!mapCache) {
    mapCache = new Map();
    poiCacheByDb.set(db, mapCache);
  }
  return mapCache;
}

export async function liveMapPoi(db, map = "", { fetchCategory = liveMapPoiMarkers } = {}) {
  if (fetchCategory === liveMapPoiMarkers) {
    const poiCacheByMap = getPoiCacheForDb(db);
    const cacheKey = String(map || "");
    const now = Date.now();
    const cached = poiCacheByMap.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.payload;
    }
    try {
      const combined = await liveMapPoiAllMarkers(db, map);
      const capabilities = {};
      const rows = [];
      for (const { key } of POI_CATEGORIES) {
        capabilities[key] = Boolean(combined.capabilities?.[key]);
        for (const row of combined.byCategory?.[key] || []) {
          rows.push(withLiveMapSector({
            id: row.id,
            type: key,
            name: row.marker_type,
            subtype: row.marker_type,
            subtypeLabel: liveMapSubtypeLabel(key, row.marker_type),
            map: row.map,
            x: row.x,
            y: row.y,
            z: row.z
          }));
        }
      }
      const payload = { capabilities, knownSubtypes: LIVE_MAP_KNOWN_SUBTYPES, subtypeLabels: LIVE_MAP_SUBTYPE_LABELS, rows };
      if (poiCacheByMap.size > 16) poiCacheByMap.clear();
      poiCacheByMap.set(cacheKey, { expiresAt: now + POI_CACHE_TTL_MS, payload });
      return payload;
    } catch {
      const capabilities = Object.fromEntries(POI_CATEGORIES.map(({ key }) => [key, false]));
      return { capabilities, knownSubtypes: LIVE_MAP_KNOWN_SUBTYPES, subtypeLabels: LIVE_MAP_SUBTYPE_LABELS, rows: [] };
    }
  }

  const results = await Promise.all(POI_CATEGORIES.map(({ key }) =>
    fetchCategory(db, map, key).catch(() => ({ capabilities: { [key]: false }, rows: [] }))));
  const capabilities = {};
  const rows = [];
  results.forEach((result, index) => {
    const key = POI_CATEGORIES[index].key;
    capabilities[key] = Boolean(result.capabilities?.[key]);
    for (const row of result.rows || []) {
      rows.push(withLiveMapSector({
        id: row.id,
        type: key,
        name: row.marker_type,
        subtype: row.marker_type,
        subtypeLabel: liveMapSubtypeLabel(key, row.marker_type),
        map: row.map,
        x: row.x,
        y: row.y,
        z: row.z
      }));
    }
  });
  return { capabilities, knownSubtypes: LIVE_MAP_KNOWN_SUBTYPES, subtypeLabels: LIVE_MAP_SUBTYPE_LABELS, rows };
}
