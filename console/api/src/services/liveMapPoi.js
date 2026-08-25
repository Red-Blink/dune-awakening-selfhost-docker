import { liveMapPoiMarkers } from "../duneDb.js";

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

export async function liveMapPoi(db, map = "", { fetchCategory = liveMapPoiMarkers } = {}) {
  const results = await Promise.all(POI_CATEGORIES.map(({ key }) =>
    fetchCategory(db, map, key).catch(() => ({ capabilities: { [key]: false }, rows: [] }))));
  const capabilities = {};
  const rows = [];
  results.forEach((result, index) => {
    const key = POI_CATEGORIES[index].key;
    capabilities[key] = Boolean(result.capabilities?.[key]);
    for (const row of result.rows || []) {
      rows.push({
        id: row.id,
        type: key,
        name: row.marker_type,
        subtype: row.marker_type,
        map: row.map,
        x: row.x,
        y: row.y,
        z: row.z
      });
    }
  });
  return { capabilities, rows };
}
