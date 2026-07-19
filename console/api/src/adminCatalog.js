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

function itemImagePath(repoRoot, id) {
  if (!repoRoot) return "/images/items/image-unavailable.png";
  const filename = `${id}.png`;
  const relativePath = `images/items/${filename}`;
  const absolutePath = resolve(repoRoot, "console/web/public", relativePath);
  return existsSync(absolutePath) ? `/${relativePath}` : "/images/items/image-unavailable.png";
}
