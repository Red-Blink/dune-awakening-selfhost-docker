import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function resolveCatalogItem(repoRoot, { itemName = "", itemId = "" } = {}) {
  const value = String(itemId || itemName || "").trim();
  if (!value || value.length > 240 || /[\r\n]/.test(value)) throw new Error("Item name or id is required");

  const items = JSON.parse(readFileSync(resolve(repoRoot, "runtime/data/admin-items.json"), "utf8"));
  const mode = itemId ? "id" : "name";
  if (mode === "id") {
    const exact = items.find((item) => String(item.id || "") === value);
    return normalizeItem(exact || { id: value, name: value, category: "manual", source: "manual" }, repoRoot);
  }

  const folded = value.toLowerCase();
  const exactNames = items.filter((item) => String(item.name || "").toLowerCase() === folded);
  if (exactNames.length === 1) return normalizeItem(exactNames[0], repoRoot);
  if (exactNames.length > 1) {
    throw new Error(`Ambiguous item name: ${value}. Select the item by its exact catalog ID.`);
  }

  const exactId = items.find((item) => String(item.id || "") === value);
  if (exactId) return normalizeItem(exactId, repoRoot);
  throw new Error(`No item found for: ${value}`);
}

export function listCatalogItems(repoRoot, { q = "", limit = 500 } = {}) {
  const items = JSON.parse(readFileSync(resolve(repoRoot, "runtime/data/admin-items.json"), "utf8"));
  const term = String(q || "").trim().toLowerCase();
  const max = Math.max(1, Math.min(Number(limit) || 500, 10000));
  return items
    .filter((item) => {
      if (!term) return true;
      return String(item.id || "").toLowerCase().includes(term) ||
        String(item.name || "").toLowerCase().includes(term) ||
        String(item.category || "").toLowerCase().includes(term);
    })
    .slice(0, max)
    .map((item) => normalizeItem(item, repoRoot));
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
  return {
    id,
    itemId: id,
    name: String(item.name || id),
    category: String(item.category || "manual"),
    source: String(item.source || "manual"),
    image
  };
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
export function itemImagePath(repoRoot, id) {
  if (!repoRoot) return "/images/items/image-unavailable.png";
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
