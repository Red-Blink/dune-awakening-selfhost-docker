// Per-item Market Bot catalog overrides: an admin-editable layer on top of the
// bundled, read-only runtime/data/market-seed-plan.json. Overrides can disable
// a bundled row, reprice it, or change its listing count; newItems adds a row
// the bundled plan does not have at all, sourced only from
// runtime/data/admin-items.json (never free text) so the bot can never be
// pointed at a template id that does not exist anywhere in the catalog.
//
// This module intentionally has no dependency on addonSeedJob.js/addonJobs.js
// (only server.js and those two modules import it) so loadMarketSeedPlan's
// merge call and this module's own file I/O never form an import cycle. The
// unsafe-ids lookup below duplicates the few lines of plan-path resolution
// addonSeedJob.js already duplicates into addonJobs.js for the same reason.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeJsonAtomic, clampInt } from "../jsonStore.js";
import { validateTemplateId } from "../duneDb/presentation.js";
import { listCatalogItems } from "../adminCatalog.js";

const OVERRIDES_PATH = "runtime/generated/market-bot/items.json";

// Categories from admin-items.json that must never appear in the "add item"
// picker: not sellable market items (buildings/contracts) or not physical
// items at all (emotes).
export const EXCLUDED_NEW_ITEM_CATEGORIES = new Set(["buildings", "contracts", "emotes"]);

const PRICE_MIN = 1;
const PRICE_MAX = 999999999;
const LISTINGS_MIN = 1;
const LISTINGS_MAX = 99;

function overridesFile(repoRoot) {
  return resolve(repoRoot, OVERRIDES_PATH);
}

function emptyState() {
  return { overrides: {}, newItems: {} };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// overrides is nested { templateId: { qualityLevel: {enabled?, price?, listings?} } }
// -- the same template id can carry a different price at every grade (Q0..Q5
// each have their own row in the bundled plan), so a template-only key would
// silently apply one edit to every grade of that item at once.
export function readMarketItemOverrides(repoRoot) {
  const file = overridesFile(repoRoot);
  if (!existsSync(file)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const overrides = {};
    if (isPlainObject(raw?.overrides)) {
      for (const [templateId, byQuality] of Object.entries(raw.overrides)) {
        if (!isPlainObject(byQuality)) continue;
        overrides[templateId] = { ...byQuality };
      }
    }
    const newItems = isPlainObject(raw?.newItems) ? raw.newItems : {};
    return { overrides, newItems };
  } catch {
    return emptyState();
  }
}

export function getOverrideRow(overrideMap, templateId, qualityLevel) {
  return overrideMap?.[templateId]?.[String(qualityLevel)];
}

function resolveSeedPlanFile(repoRoot) {
  const bundled = resolve(repoRoot, "runtime/data/market-seed-plan.json");
  if (existsSync(bundled)) return bundled;
  const addonFallback = resolve(repoRoot, "runtime/addons/installed/eda-exchange-bot/web/market-seed-plan.json");
  return existsSync(addonFallback) ? addonFallback : null;
}

// The upstream generator's own blocklist (NPC-only weapon variants,
// story-unique items, etc.) — used here as a hard block, not a warning.
export function readUnsafeTemplateIds(repoRoot) {
  const path = resolveSeedPlanFile(repoRoot);
  if (!path) return [];
  try {
    const plan = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(plan?.unsafe_template_ids) ? plan.unsafe_template_ids.map(String) : [];
  } catch {
    return [];
  }
}

// New items are additions to the bundled plan, not another way to edit an
// existing row. Keep this check on the server: the picker is only a convenience
// and API clients can submit save payloads directly.
export function readBaseMarketTemplateIds(repoRoot) {
  const path = resolveSeedPlanFile(repoRoot);
  if (!path) return [];
  try {
    const plan = JSON.parse(readFileSync(path, "utf8"));
    return [...new Set((Array.isArray(plan?.rows) ? plan.rows : [])
      .map((row) => String(row?.template_id ?? row?.templateId ?? "").trim())
      .filter(Boolean))];
  } catch {
    return [];
  }
}

function findCatalogEntry(repoRoot, templateId) {
  let items;
  try {
    items = JSON.parse(readFileSync(resolve(repoRoot, "runtime/data/admin-items.json"), "utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(items)) return null;
  return items.find((item) => String(item?.id || "") === templateId) || null;
}

function normalizeOverrideRow(raw) {
  const out = {};
  if (raw?.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") throw new Error("Item override 'enabled' must be true or false.");
    out.enabled = raw.enabled;
  }
  if (raw?.price !== undefined) {
    const price = Number(raw.price);
    if (!Number.isFinite(price) || price < PRICE_MIN || price > PRICE_MAX) throw new Error("Item override price must be a positive number.");
    out.price = Math.trunc(price);
  }
  if (raw?.listings !== undefined) {
    const listings = Number(raw.listings);
    if (!Number.isInteger(listings) || listings < LISTINGS_MIN || listings > LISTINGS_MAX) {
      throw new Error(`Item override listings must be an integer from ${LISTINGS_MIN} to ${LISTINGS_MAX}.`);
    }
    out.listings = listings;
  }
  return out;
}

function normalizeNewItemRow(raw, templateId, catalogEntry) {
  const price = Number(raw?.price);
  if (!Number.isFinite(price) || price < PRICE_MIN || price > PRICE_MAX) throw new Error(`New item ${templateId} price must be a positive number.`);
  const listings = Number(raw?.listings);
  if (!Number.isInteger(listings) || listings < LISTINGS_MIN || listings > LISTINGS_MAX) {
    throw new Error(`New item ${templateId} listings must be an integer from ${LISTINGS_MIN} to ${LISTINGS_MAX}.`);
  }
  const durabilityMax = clampInt(raw?.durabilityMax, 100, 100, 200);
  return {
    name: String(raw?.name || catalogEntry.name || templateId).slice(0, 200),
    category: String(catalogEntry.category || "misc").toLowerCase(),
    qualityLevel: clampInt(raw?.qualityLevel, 0, 0, 5),
    categoryDepth: clampInt(raw?.categoryDepth, 1, 0, 4),
    categoryMask: Math.trunc(Number(raw?.categoryMask) || 0),
    kind: String(raw?.kind || "equippable").slice(0, 40),
    stackSize: Math.max(1, Math.trunc(Number(raw?.stackSize) || 1)),
    price: Math.trunc(price),
    listings,
    enabled: raw?.enabled !== false,
    durabilityMax,
    durabilityCur: Math.min(clampInt(raw?.durabilityCur ?? durabilityMax, durabilityMax, 100, 200), durabilityMax),
    addedAt: new Date().toISOString()
  };
}

export function saveMarketItemOverrides(repoRoot, payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Bot item overrides payload must be a JSON object.");
  }
  const unsafeSet = new Set(readUnsafeTemplateIds(repoRoot));
  const baseTemplateIds = new Set(readBaseMarketTemplateIds(repoRoot));
  const previous = readMarketItemOverrides(repoRoot);
  const nextOverrides = {};
  for (const [templateId, byQuality] of Object.entries(previous.overrides)) nextOverrides[templateId] = { ...byQuality };
  const nextNewItems = { ...previous.newItems };

  if (payload.overrides !== undefined && !isPlainObject(payload.overrides)) {
    throw new Error("overrides must be an object of templateId to {qualityLevel: patch}.");
  }
  for (const [rawId, byQuality] of Object.entries(payload.overrides || {})) {
    const templateId = validateTemplateId(rawId);
    if (unsafeSet.has(templateId)) throw new Error(`${templateId} is flagged unsafe and cannot be edited.`);
    if (!isPlainObject(byQuality)) throw new Error(`Item override for ${templateId} must be an object keyed by quality level.`);
    for (const [rawQuality, rawRow] of Object.entries(byQuality)) {
      const qualityLevel = clampInt(rawQuality, -1, -1, 5);
      if (qualityLevel < 0 || String(qualityLevel) !== String(rawQuality).trim()) {
        throw new Error(`${templateId} has an invalid quality level override key: ${rawQuality}.`);
      }
      const normalized = normalizeOverrideRow(rawRow);
      const key = String(qualityLevel);
      if (Object.keys(normalized).length === 0) {
        if (nextOverrides[templateId]) {
          delete nextOverrides[templateId][key];
          if (Object.keys(nextOverrides[templateId]).length === 0) delete nextOverrides[templateId];
        }
      } else {
        nextOverrides[templateId] = { ...nextOverrides[templateId], [key]: { ...nextOverrides[templateId]?.[key], ...normalized } };
      }
    }
  }

  for (const [rawId, rawRow] of Object.entries(payload.newItems || {})) {
    const templateId = validateTemplateId(rawId);
    if (unsafeSet.has(templateId)) throw new Error(`${templateId} is flagged unsafe and cannot be added.`);
    if (baseTemplateIds.has(templateId)) throw new Error(`${templateId} is already in the base catalog; edit it there instead of adding it as new.`);
    const catalogEntry = findCatalogEntry(repoRoot, templateId);
    if (!catalogEntry) throw new Error(`${templateId} was not found in the item catalog.`);
    const category = String(catalogEntry.category || "").toLowerCase();
    if (EXCLUDED_NEW_ITEM_CATEGORIES.has(category)) {
      throw new Error(`${templateId} is in an excluded category (${category}) and cannot be added.`);
    }
    nextNewItems[templateId] = normalizeNewItemRow(rawRow, templateId, catalogEntry);
  }

  for (const rawId of Array.isArray(payload.removedNewItems) ? payload.removedNewItems : []) {
    delete nextNewItems[validateTemplateId(rawId)];
  }

  const next = { overrides: nextOverrides, newItems: nextNewItems };
  writeJsonAtomic(overridesFile(repoRoot), next, 0o600);
  return next;
}

function newItemStatsJson(durCur, durMax) {
  return JSON.stringify({
    FItemStackAndDurabilityStats: [[], {
      CurrentDurability: durCur,
      MaxDurability: durMax,
      DecayedMaxDurability: durMax
    }]
  });
}

// Applies overrides to the full seed-run row shape from addonSeedJob.js's
// loadMarketSeedPlan (templateId/stackSize/price/categoryMask/categoryDepth/
// qualityLevel/kind/listings/itemStats). A disabled row (explicit override or
// unsafe id) is dropped entirely, matching what the old commodityStacks-only
// override could never do for anything outside its ~30-item allowlist.
export function mergeMarketSeedPlanWithOverrides(plan, overrides, unsafeIds = []) {
  const unsafeSet = new Set(unsafeIds);
  const overrideMap = overrides?.overrides || {};
  const newItems = overrides?.newItems || {};
  const rows = (plan.rows || [])
    .filter((row) => !unsafeSet.has(row.templateId))
    .filter((row) => getOverrideRow(overrideMap, row.templateId, row.qualityLevel)?.enabled !== false)
    .map((row) => {
      const o = getOverrideRow(overrideMap, row.templateId, row.qualityLevel);
      if (!o) return row;
      return { ...row, price: o.price ?? row.price, listings: o.listings ?? row.listings };
    });
  for (const [templateId, item] of Object.entries(newItems)) {
    if (unsafeSet.has(templateId) || item.enabled === false) continue;
    rows.push({
      templateId,
      stackSize: item.stackSize,
      price: item.price,
      categoryMask: item.categoryMask,
      categoryDepth: item.categoryDepth,
      qualityLevel: item.qualityLevel,
      kind: item.kind,
      listings: item.listings,
      itemStats: newItemStatsJson(item.durabilityCur, item.durabilityMax)
    });
  }
  return { ...plan, rows };
}

// Same idea for addonJobs.js's loadBuybackSeedPlan, whose rows are a smaller
// shape (no stackSize/listings/itemStats — buyback only needs a reference
// price per template+grade). Listings overrides don't apply here; only price
// and enabled/disable matter for a buyback cap.
export function mergeBuybackSeedPlanWithOverrides(plan, overrides, unsafeIds = []) {
  const unsafeSet = new Set(unsafeIds);
  const overrideMap = overrides?.overrides || {};
  const newItems = overrides?.newItems || {};
  const rows = (plan.rows || [])
    .filter((row) => !unsafeSet.has(row.templateId))
    .filter((row) => getOverrideRow(overrideMap, row.templateId, row.qualityLevel)?.enabled !== false)
    .map((row) => {
      const o = getOverrideRow(overrideMap, row.templateId, row.qualityLevel);
      if (!o || o.price === undefined) return row;
      return { ...row, price: o.price };
    });
  for (const [templateId, item] of Object.entries(newItems)) {
    if (unsafeSet.has(templateId) || item.enabled === false) continue;
    rows.push({
      templateId,
      displayName: item.name,
      price: item.price,
      qualityLevel: item.qualityLevel,
      categoryMask: item.categoryMask,
      kind: item.kind
    });
  }
  return { ...plan, rows };
}

// Picker results for the "add item" flow: the admin-items.json catalog minus
// excluded categories and anything the upstream generator flagged unsafe.
export function listBotItemCatalogPickerItems(repoRoot, { q = "", category = "" } = {}) {
  const unsafe = new Set(readUnsafeTemplateIds(repoRoot));
  const baseTemplateIds = new Set(readBaseMarketTemplateIds(repoRoot));
  const safeCategory = String(category || "").trim().toLowerCase();
  return listCatalogItems(repoRoot, { q, limit: 3000 })
    .filter((item) => !EXCLUDED_NEW_ITEM_CATEGORIES.has(String(item.category || "").toLowerCase()))
    .filter((item) => !unsafe.has(item.id))
    .filter((item) => !baseTemplateIds.has(item.id))
    .filter((item) => !safeCategory || String(item.category || "").toLowerCase() === safeCategory);
}
