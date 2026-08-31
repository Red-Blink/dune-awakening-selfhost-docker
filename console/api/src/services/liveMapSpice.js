import { readSpiceArchive, fieldsForSeed } from "./spiceLocations.js";
import { readLearnedPool, fieldsForLearnedSeed, recordObservedFields } from "./learnedSpiceLocations.js";
import { resolveCoriolisCycle } from "./coriolisSeed.js";
import { decodeFieldPosition } from "./spiceFieldDecode.js";
import { liveMapSpiceFieldRows, liveMapFlourSandFieldRows } from "../duneDb.js";

// Three independent resource-field layers for the live map:
//
// - "spice" -- the full known pool for the current Coriolis seed: the
//   committed console/api/data/large-spice-locations.json archive (Large
//   tier, Deep-Desert-only, built from the private dune-spice-tools
//   toolkit's ground truth), merged with a runtime-generated
//   learned-spice-locations.json (any tier, either map) that the console
//   grows itself -- see recordObservedFields() below. Whether a pool
//   member is currently blooming or not, it shows here once known for
//   this seed. On a field_id collision between the two sources, the
//   committed archive's position/confidence wins (higher-confidence
//   ground truth).
// - "spice_active" -- fields that are actually up right now, read live from
//   dune.resourcefield_state and positioned by decoding field_id directly
//   (see spiceFieldDecode.js -- ~84% exact on Deep Desert, no way to detect
//   the wrap case from field_id alone). Where a live field_id also exists in
//   the archive, the archive's ground-truth position wins over the decode.
//   Covers both Deep Desert and Hagga Basin (confirmed live: Hagga Basin has
//   real Small-tier spice) -- Hagga Basin's decode is unverified against
//   ground truth (no archive for it), but its coordinate bounds sit fully
//   inside the 21-bit range the decode assumes, unlike Deep Desert's. Every
//   active field observed here also feeds the learned pool above, so a
//   decoded (not archive-confirmed) position can persist into "spice" even
//   though it carries the same accuracy risk this layer already has --
//   each learned entry keeps its own confidence: "decoded" tag rather than
//   claiming more certainty than it has.
// - "flour_sand" -- always decode-only, no archive: there's no historical
//   pool data for flour sand at all, on either map. Unverified assumption:
//   the bit-packing decode has only been validated against spice ground
//   truth (field_kind_id=1); it should apply identically since it's a
//   property of the engine's spawn system, not spice-specific, but this is
//   genuinely untested for field_kind_id=0.
//
// The archive/learned pool are an accuracy/completeness enhancement for
// spice, not a hard requirement: spice_active and flour_sand both work
// from Postgres alone with no archive or learned file at all, so a
// self-hoster with zero setup still gets active blooms.
export async function liveMapSpice(db, config, map = "", {
  resolveCycle = resolveCoriolisCycle,
  partitionId = "",
  includeStaticPool = true,
  decodePosition = decodeFieldPosition,
  fetchLiveRows = liveMapSpiceFieldRows,
  fetchFlourSandRows = liveMapFlourSandFieldRows,
  persistObservedFields = recordObservedFields
} = {}) {
  // staleSince is set when the logged cycle boundary has already passed, i.e.
  // the world re-rolled but no container has restarted to print the new seed
  // yet. currentSeed is null in that window, so every static/learned lookup
  // below short-circuits and nothing is written back -- the map shows only
  // live active fields rather than the previous cycle's pool.
  const { seed: currentSeed, nextCycleAt, staleSince } = await resolveCycle({ map, partitionId });

  // The archive remains available during lightweight refreshes so active
  // fields still use its ground-truth coordinates; only the static pool rows
  // themselves are omitted from those responses.
  const archive = currentSeed && map !== "HaggaBasin" ? readSpiceArchive(config?.spiceLocationsFile) : null;
  const archiveFields = archive ? fieldsForSeed(archive, currentSeed) : null;
  const archiveByFieldId = new Map((archiveFields || []).map((field) => [String(field.field_id), field]));

  const learnedPool = includeStaticPool && currentSeed ? readLearnedPool(config?.learnedSpiceLocationsFile) : null;
  const learnedFields = learnedPool ? fieldsForLearnedSeed(learnedPool, currentSeed) : [];

  // The committed archive only ever has Large Deep-Desert data (the
  // toolkit never tracked Small/Medium or Hagga Basin); the learned pool
  // fills in whatever else has been observed active at least once. Archive
  // wins on a field_id collision -- it's the higher-confidence source.
  const poolFieldsById = new Map();
  if (includeStaticPool) {
    for (const field of learnedFields) poolFieldsById.set(String(field.field_id), { map: field.map, size: field.size || "Large", x: field.x, y: field.y, confidence: field.confidence || "decoded" });
    for (const field of (archiveFields || [])) poolFieldsById.set(String(field.field_id), { map: "DeepDesert", size: "Large", x: Number(field.x), y: Number(field.y), confidence: field.confidence || "" });
  }
  const poolRows = [...poolFieldsById.entries()]
    .filter(([, field]) => !map || field.map === map)
    .map(([fieldId, field]) => spiceRow(fieldId, "spice", `${field.size} Spice`, field.map, field.x, field.y, field.confidence, field.size));

  const [live, flourSand] = await Promise.all([
    fetchLiveRows(db, map),
    fetchFlourSandRows(db, map)
  ]);
  const activeRows = (live.rows || []).map((row) => {
    const fieldId = String(row.field_id);
    const archived = archiveByFieldId.get(fieldId);
    const position = archived
      ? { x: Number(archived.x), y: Number(archived.y), confidence: archived.confidence || "" }
      : { ...decodePosition(fieldId), confidence: "decoded" };
    return { ...spiceRow(fieldId, "spice_active", `Active ${row.size} Spice`, row.map, position.x, position.y, position.confidence, row.size), partition_id: row.partition_id };
  });
  const flourSandRows = (flourSand.rows || []).map((row) => {
    const fieldId = String(row.field_id);
    const position = decodePosition(fieldId);
    return { ...spiceRow(fieldId, "flour_sand", "Flour Sand", row.map, position.x, position.y, "decoded"), partition_id: row.partition_id };
  });

  if (currentSeed) {
    persistObservedFields(config?.learnedSpiceLocationsFile, currentSeed, activeRows.map((row) => ({
      field_id: row.id, map: row.map, size: row.subtype, x: row.x, y: row.y, confidence: row.confidence
    })));
  }

  return {
    capabilities: { ...(includeStaticPool ? { spice: poolRows.length > 0 } : {}), spice_active: activeRows.length > 0, flour_sand: flourSandRows.length > 0 },
    currentSeed: currentSeed || "",
    nextCycleAt: nextCycleAt || "",
    seedStaleSince: staleSince || "",
    generatedAt: archive?.generatedAt || "",
    rows: [...poolRows, ...activeRows, ...flourSandRows]
  };
}

function spiceRow(fieldId, type, name, map, x, y, confidence, subtype) {
  const row = { id: fieldId, type, name, map, x, y, z: null, confidence };
  if (subtype) row.subtype = subtype;
  return row;
}
