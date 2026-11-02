import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const adminItemsCache = new Map();

function loadAdminItemsCatalog(repoRoot) {
  const file = resolve(repoRoot, "runtime/data/admin-items.json");
  let stat;
  try {
    stat = statSync(file, { bigint: true });
  } catch {
    const items = JSON.parse(readFileSync(file, "utf8"));
    const byId = new Map(items.map((item) => [String(item?.id || ""), item]));
    return { items, byId };
  }
  const stamp = `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
  const cached = adminItemsCache.get(file);
  if (cached && cached.stamp === stamp) return cached;
  const items = JSON.parse(readFileSync(file, "utf8"));
  const byId = new Map();
  for (const item of items) {
    const id = String(item?.id || "");
    if (id && !byId.has(id)) byId.set(id, item);
  }
  const entry = { stamp, items, byId };
  if (adminItemsCache.size > 16) adminItemsCache.clear();
  adminItemsCache.set(file, entry);
  return entry;
}

const FILLABLE_GROUPS = new Set(["refined_resource", "component", "raw_resource"]);

// These are actor customization IDs, not inventory token templates (#270).
const DIRECT_CUSTOMIZATION_IDS = new Set([
  "Halloween2026_Radsuit_Variant", "Halloween2026_PlagueDoctorMask_Hood",
  "Halloween2026_PlagueDoctorMask_NoHood", "Swatch_Halloween2026"
]);
export function isDirectCustomizationUnlock(item = {}) {
  return DIRECT_CUSTOMIZATION_IDS.has(String(item.itemId || item.id || ""));
}

const CUSTOMIZATION_GROUPS = Object.freeze([
  { id: "halloween-2026", name: "Halloween 2026", matches: (itemId) => DIRECT_CUSTOMIZATION_IDS.has(itemId) },
  { id: "atreides", name: "Atreides", matches: (itemId) => /^B1C3_Atre/i.test(itemId) },
  { id: "harkonnen", name: "Harkonnen", matches: (itemId) => /^B1C3_Hark/i.test(itemId) },
  { id: "smuggler", name: "Smuggler", matches: (itemId) => /^(?:MTX_)?B1C3_Smug/i.test(itemId) },
  { id: "dune-man", name: "Dune Man", matches: (itemId) => /^MTX_B1C2_DuneMan/i.test(itemId) },
  { id: "filmic-archive", name: "Filmic Archive", matches: (itemId) => /^(?:MTX_Fremen_FedaykinArmor_SetVariant|MTX_Atre_CaladanTrenchcoat_SetVariant|MTX_Sard_Scout_SetVariant)$/i.test(itemId) }
]);

const KNOWN_DLC_REQUIREMENTS = Object.freeze([
  {
    name: "Lost Harvest",
    steamAppId: "3596900",
    matches: (itemId) => /^(?:MTX_B1C2_DuneMan|MTX_Neut_DesertMechanic)/i.test(itemId)
  }
]);

export function resolveCatalogItem(repoRoot, { itemName = "", itemId = "" } = {}) {
  const value = String(itemId || itemName || "").trim();
  if (!value || value.length > 240 || /[\r\n]/.test(value)) throw new Error("Item name or id is required");

  const { items, byId } = loadAdminItemsCatalog(repoRoot);
  const mode = itemId ? "id" : "name";
  if (mode === "id") {
    const exact = byId.get(value);
    return normalizeItem(exact || { id: value, name: value, category: "manual", source: "manual" }, repoRoot);
  }

  const folded = value.toLowerCase();
  const exactNames = items.filter((item) => String(item.name || "").toLowerCase() === folded);
  if (exactNames.length === 1) return normalizeItem(exactNames[0], repoRoot);
  if (exactNames.length > 1) {
    throw new Error(`Ambiguous item name: ${value}. Select the item by its exact catalog ID.`);
  }

  const exactId = byId.get(value);
  if (exactId) return normalizeItem(exactId, repoRoot);
  throw new Error(`No item found for: ${value}`);
}

export function resolveFillableCatalogItem(repoRoot, query = {}) {
  const resolved = resolveCatalogItem(repoRoot, query);
  if (!resolved.group || !FILLABLE_GROUPS.has(resolved.group)) {
    throw new Error("Item type not allowed for fill operation");
  }
  // Every FILLABLE_GROUPS item is expected to carry real catalog volume
  // data (raw_resource/refined_resource/component -- see the item-tagging
  // this restriction shipped with). Found during code review (2026-08-19):
  // a catalog entry missing or reset to 0 volume would silently resolve
  // here anyway, and every downstream volume-cap check in
  // giveItemToBaseContainer/fillItemToBaseContainer/
  // giveMultipleItemsToBaseContainer treats itemVolume <= 0 as "this item
  // is not volume-tracked, skip the cap" -- correct for the standalone
  // Storage tab's much broader catalog (most weapons/gear/schematics
  // genuinely have no volume data, by design), but wrong here: it would let
  // an operator give/fill an unbounded quantity of a fillable resource into
  // a volume-capped container. Not currently triggerable -- verified
  // 2026-08-20 (post-merge review of upstream PR #182, which expanded
  // FILLABLE_GROUPS to include raw_resource) that all 99 currently-fillable
  // items have a non-zero catalogued volume -- but this closes the gap at
  // the one layer both Give and Fill share, rather than trusting every
  // future catalog edit to keep that invariant by hand. Note this is a
  // presence/non-zero check, not per-item verification against the live
  // engine the way a small, hand-reviewed set could be -- at 99 items and
  // growing, some entries' catalogued volume may not have been individually
  // confirmed in-game the way MelangeSpice's was (see
  // docs/incidents/INC-2026-08-19-VOLUME-OVERRIDE-DOUBLE-MULTIPLIED.md).
  const volume = Number(resolved.volume) || resolveItemVolume(repoRoot, resolved.itemId);
  if (!(volume > 0)) {
    throw new Error(`Item ${resolved.itemId} is missing catalogued volume data and cannot be given or filled into a volume-tracked container.`);
  }
  return resolved;
}

export function isFillableItem(item = {}) {
  return FILLABLE_GROUPS.has(String(item.group || ""));
}

export function resolveItemVolume(repoRoot, templateId) {
  const { byId } = loadAdminItemsCatalog(repoRoot);
  const match = byId.get(String(templateId || ""));
  return Number(match?.volume) || 0;
}

// Per-item max stack size the game engine itself enforces. Curated
// incrementally in admin-items.json exactly like `volume`: 0 means "no
// catalogued stack data", which downstream give/fill treats as "insert a
// single row", the pre-existing behavior. Every curated value needs a
// stated, verified source (see duneDb's matching comment and
// docs/console/base-inventory.md's curation note) -- a wrong value silently
// mis-splits or over-clamps every grant of that item.
export function resolveItemStackSize(repoRoot, templateId) {
  const { byId } = loadAdminItemsCatalog(repoRoot);
  const match = byId.get(String(templateId || ""));
  return isValidStackSize(match?.stackSize) ? match.stackSize : 0;
}

// Only a real positive-integer number counts as curated stack data --
// strings, booleans, floats, and negatives are rejected outright rather
// than coerced (true would otherwise coerce to a max stack of 1 and shred
// every give of that item into 1-unit rows). duneDb's adminItemMetadata
// applies the identical rule; keep the two in sync.
function isValidStackSize(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function listCatalogItems(repoRoot, { q = "", limit = 500 } = {}) {
  const { items } = loadAdminItemsCatalog(repoRoot);
  const term = String(q || "").trim().toLowerCase();
  const max = Math.max(1, Math.min(Number(limit) || 500, 10000));
  return items
    // Patent tokens are progression unlocks, not ordinary inventory items.
    // They have their own player-aware browser so a grant can show whether the
    // game has consumed the token, still has it pending, or already owns it.
    // Developer Storage Container is the exception: admins also use its token
    // as a grantable utility item in Give Items and Care Packages.
    .filter((item) => !isBuildingUnlockItem(item) || isSharedCatalogBuildingItem(item))
    .filter((item) => !isDirectCustomizationUnlock(item))
    .filter((item) => {
      if (!term) return true;
      return String(item.id || "").toLowerCase().includes(term) ||
        String(item.name || "").toLowerCase().includes(term) ||
        String(item.category || "").toLowerCase().includes(term);
    })
    .slice(0, max)
    .map((item) => normalizeItem(item, repoRoot));
}

function isSharedCatalogBuildingItem(item = {}) {
  return String(item.id || "") === "Developer_Storage_Container_Patent";
}

export function isBuildingUnlockItem(item = {}) {
  return String(item.category || "").toLowerCase() === "buildings" &&
    String(item.source || "").toLowerCase() === "buildingsets";
}

export function listBuildingUnlockItems(repoRoot) {
  const { items } = loadAdminItemsCatalog(repoRoot);
  return items
    .filter(isBuildingUnlockItem)
    .map((item) => ({
      ...normalizeItem(item, repoRoot),
      group: buildingUnlockGroup(item),
      experimental: buildingUnlockIsExperimental(item)
    }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.itemId.localeCompare(b.itemId));
}

export function isCustomizationGrantItem(item = {}) {
  return String(item.category || "").toLowerCase() === "customizations" &&
    String(item.source || "").toLowerCase() === "customizations";
}

export function listCustomizationGrantItems(repoRoot) {
  const { items } = loadAdminItemsCatalog(repoRoot);
  return CUSTOMIZATION_GROUPS.flatMap((group) => items
    .filter(isCustomizationGrantItem)
    .filter((item) => group.matches(String(item.id || "")))
    .map((item) => ({ ...normalizeItem(item, repoRoot), groupId: group.id, group: group.name })))
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.itemId.localeCompare(b.itemId));
}

export function customizationGrantGroups(repoRoot) {
  const items = listCustomizationGrantItems(repoRoot);
  return CUSTOMIZATION_GROUPS.map(({ id, name }) => ({
    id,
    name,
    count: items.filter((item) => item.groupId === id).length
  }));
}

export function customizationGrantStatus(itemId, { pending = [], owned = [] } = {}) {
  if (isDirectCustomizationUnlock({ itemId }) && owned.includes(itemId)) return "Unlocked";
  const pendingIds = new Set((pending || []).map((value) => String(value).toLowerCase()));
  return pendingIds.has(String(itemId || "").toLowerCase()) ? "Pending" : "Available";
}

export function buildingUnlockStatus(itemId, { owned = [], pending = [], supported = true } = {}) {
  if (!supported) return "Unknown";
  const aliases = buildingUnlockAliases(itemId);
  const ownedIds = new Set((owned || []).map((value) => String(value).toLowerCase()));
  const pendingIds = new Set((pending || []).map((value) => String(value).toLowerCase()));
  if (aliases.some((value) => ownedIds.has(value.toLowerCase()))) return "Owned";
  if (aliases.some((value) => pendingIds.has(value.toLowerCase()))) return "Pending";
  return "Available";
}

function buildingUnlockAliases(itemId) {
  const id = String(itemId || "").trim();
  if (!id) return [];
  if (/_Patent$/i.test(id)) return [id, id.replace(/_Patent$/i, "")];
  return [id, `${id}_Patent`];
}

function buildingUnlockIsExperimental(item) {
  const value = `${item.id || ""} ${item.name || ""}`;
  return /(?:^|[_\s])(Developer|Polar|Test|Placeholder|Debug)(?:$|[_\s])/i.test(value) ||
    /^(?:IceRefinery|WaterTower)_Patent$/i.test(String(item.id || "")) ||
    /^(?:PH_|XX|BUILDING_SET_)/i.test(String(item.name || "")) ||
    String(item.id || "") === String(item.name || "");
}

function buildingUnlockGroup(item) {
  const id = String(item.id || "");
  if (buildingUnlockIsExperimental(item)) return "Experimental";
  if (/^MTX_/i.test(id)) return "Special & Promotional";
  if (/^(?:Atre_|Hark_|Choam_)/i.test(id) || /(?:Atreides|Harkonnen|Choam|Smug|Fremen|House|Faction).*Set/i.test(id)) return "Faction & House Sets";
  if (/(?:Fabricator|Refinery|Station|Container|Extraction|Cistern|Windtrap|Windturbine|Generator|Recycler|Pentashield|Silo|Deathstill|Compactor|Workbench|Printer)/i.test(id)) return "Crafting & Utilities";
  if (/(?:Furniture|Bedroom|Dining|Office|Lighting|Table|Chair|Statue|Decor|Mural|Banner|Carpet|Glowglobe|Trophy)/i.test(id)) return "Furniture & Decorations";
  return "Structures & Building Sets";
}

export function itemRequiresDatabaseGrant(item = {}) {
  const id = String(item.itemId || item.id || "").trim();
  const category = String(item.category || "").toLowerCase();
  const source = String(item.source || "").toLowerCase();
  return category === "schematics" ||
    source === "schematics" ||
    category.includes("augment") ||
    source.includes("augment") ||
    /^schematic(pattern|_)/i.test(id) ||
    /_schematic$/i.test(id) ||
    /schematic$/i.test(id);
}

export function itemIsSchematic(item = {}) {
  const id = String(item.itemId || item.id || "").trim();
  const category = String(item.category || "").toLowerCase();
  const source = String(item.source || "").toLowerCase();
  return category === "schematics" ||
    source === "schematics" ||
    /^schematic(pattern|_)/i.test(id) ||
    /_schematic$/i.test(id) ||
    /schematic$/i.test(id);
}

export function itemIsRankedSchematic(item = {}, grade = 0) {
  const value = Number(grade);
  return itemIsSchematic(item) && Number.isInteger(value) && value > 0 && value <= 5;
}

function normalizeItem(item, repoRoot = "") {
  const id = String(item.id || "").trim();
  if (!/^[A-Za-z0-9_./:-]{1,240}$/.test(id)) throw new Error("Invalid resolved item id");
  const image = itemImagePath(repoRoot, id);
  const result = {
    id,
    itemId: id,
    name: String(item.name || id),
    category: String(item.category || "manual"),
    source: String(item.source || "manual"),
    image
  };
  if (item.group) result.group = String(item.group);
  if (isDirectCustomizationUnlock(item)) result.directUnlock = true;
  if (item.volume !== undefined && item.volume !== null) result.volume = Number(item.volume);
  if (isValidStackSize(item.stackSize)) result.stackSize = item.stackSize;
  const knownRequirement = KNOWN_DLC_REQUIREMENTS.find((entry) => entry.matches(id));
  const requiredDlc = item.requiredDlc || knownRequirement?.name;
  const requiredSteamDlc = item.requiredSteamDlc || knownRequirement?.steamAppId;
  if (requiredDlc) result.requiredDlc = String(requiredDlc);
  if (requiredSteamDlc) result.requiredSteamDlc = String(requiredSteamDlc);
  if (item.entitlementControlled || requiredDlc || /^MTX_/i.test(id)) result.entitlementControlled = true;
  return result;
}

// repoRoot -> item id -> resolved path. The existsSync below is the entire cost
// of a catalog response: listCatalogItems normalizes up to 10,000 rows in one
// request and baseInventory resolves an icon per distinct template, and every
// request repeated the same stats on the event loop.
//
// Keyed by repoRoot because it is a caller argument, not a constant, and nested
// rather than joined into one string key so an item id can never collide with a
// path separator. Both are bounded -- one repoRoot per process in practice, and
// item ids come from the shipped catalog and the game's own template names.
const itemImagePathCache = new Map();

// Misses are cached too, so an image added to console/web/public after the
// process started is not picked up until it restarts. Note that this directory
// is NOT baked into the image -- docker-compose.web.yml bind-mounts the host
// checkout at /repo and points DUNE_DOCKER_DIR at it, so the files are live on
// disk. What makes the stale window harmless is that updating the checkout
// restarts the console container, not that the files cannot change.
// An id becomes both a filesystem path and a URL below, so it may not carry
// path structure. normalizeItem's own id regex does not cover this -- it admits
// "." and "/", so "../../secret" satisfies it -- and baseInventory passes a raw
// dune.items.template_id with no validation at all. Without this, resolve()
// normalises the traversal away and existsSync probes outside the public
// directory, while the returned string reaches an <img src>.
//
// Rejected ids resolve to the unavailable image rather than throwing, matching
// what a missing file already does. Checked before the cache so a malformed id
// cannot take a slot in it either.
function isSafeItemImageId(id) {
  const value = String(id ?? "");
  if (!value || value.length > 240) return false;
  if (/[\\/\0]/.test(value)) return false;
  return value !== "." && value !== "..";
}

export function itemImagePath(repoRoot, id) {
  if (!repoRoot || !isSafeItemImageId(id)) return "/images/items/image-unavailable.png";
  let byId = itemImagePathCache.get(repoRoot);
  if (!byId) {
    byId = new Map();
    itemImagePathCache.set(repoRoot, byId);
  }
  const cached = byId.get(id);
  if (cached !== undefined) return cached;

  const filename = `${id}.png`;
  const relativePath = `images/items/${filename}`;
  const absolutePath = resolve(repoRoot, "console/web/public", relativePath);
  const resolved = existsSync(absolutePath) ? `/${relativePath}` : "/images/items/image-unavailable.png";
  byId.set(id, resolved);
  return resolved;
}
