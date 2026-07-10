import { useEffect, useMemo, useState } from "react";
import { Grid2X2, List } from "lucide-react";
import { adminApi } from "../../api/admin";
import { titleCase } from "../../lib/display";
import { KeyValueGrid } from "./DisplayPrimitives";

export type CatalogItem = {
  name: string;
  id: string;
  itemId?: string;
  category?: string;
  source?: string;
  image?: string;
};

const CATALOG_CACHE: { items: CatalogItem[]; repoRoot: string } | null = null;

export function ItemCatalogSelector({ label = "Select Item", selected, onSelect, placeholder = "Filter loaded item catalog", excludeCategories }: { label?: string; selected: CatalogItem | null; onSelect: (item: CatalogItem | null) => void; placeholder?: string; excludeCategories?: string[] }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  async function load() {
    if (items.length > 0) return;
    setLoading(true);
    try {
      const result = await adminApi.itemCatalog("", 10000);
      setItems((result.rows || []).map((item) => ({ ...item, id: item.itemId || item.id })));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const categoryCounts = useMemo(() => items.reduce<Record<string, number>>((counts, item) => {
    const key = itemCategory(item);
    if (excludeCategories?.includes(key)) return counts;
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {}), [items, excludeCategories]);
  const categories = useMemo(() => ["all", ...Object.keys(categoryCounts).sort()], [categoryCounts]);
  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      const matchesCategory = category === "all" || itemCategory(item) === category;
      if (!matchesCategory) return false;
      if (!q) return true;
      return item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q);
    }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id, undefined, { sensitivity: "base" }));
  }, [items, category, query]);

  return <div className="catalog-selector">
    <div className="catalog-filter-row">
      <label className="compact-select catalog-category-select">Choose Category
        <select value={category} onChange={(event) => { setCategory(event.target.value); onSelect(null); }}>
          {categories.map((option) => <option key={option} value={option}>{option === "all" ? `All Categories (${items.length})` : `${titleCase(option)} (${categoryCounts[option] || 0})`}</option>)}
        </select>
      </label>
      <div className="catalog-search-tools">
        <input className="catalog-filter-input" aria-label="Filter Items" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={placeholder} />
        <div className="catalog-view-toggle" aria-label="Item catalog view">
          <button type="button" className={viewMode === "grid" ? "active" : ""} title="Grid view" aria-label="Grid view" aria-pressed={viewMode === "grid"} onClick={() => setViewMode("grid")}><Grid2X2 size={17} /></button>
          <button type="button" className={viewMode === "list" ? "active" : ""} title="List view" aria-label="List view" aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")}><List size={18} /></button>
        </div>
      </div>
    </div>
    <div className={`catalog-item-picker ${viewMode === "list" ? "list-view" : "grid-view"}`} aria-label={label}>
      {loading ? <div className="catalog-loading">Loading Items...</div> : viewMode === "list" ? <table className="catalog-item-table">
        <thead><tr><th>Preview</th><th>Item Name</th><th>Category</th><th>Source</th></tr></thead>
        <tbody>{filteredItems.map((item) => {
          const active = selected?.id === item.id && selected?.name === item.name;
          const fullName = catalogItemName(item);
          return <tr className={active ? "active" : ""} key={`${item.id}-${item.name}-${item.source}`} title={fullName} onClick={() => onSelect(item)}>
            <td><CatalogItemThumb item={item} small /></td>
            <td className="catalog-item-name-cell">{fullName}</td>
            <td>{titleCase(itemCategory(item) === item.category ? (item.category || "") : itemCategory(item))}</td>
            <td>{item.source || ""}</td>
          </tr>;
        })}</tbody>
      </table> : filteredItems.map((item) => {
        const active = selected?.id === item.id && selected?.name === item.name;
        const fullName = catalogItemName(item);
        return <button type="button" className={`catalog-item-option ${active ? "active" : ""}`} key={`${item.id}-${item.name}-${item.source}`} title={fullName} onClick={() => onSelect(item)}>
          <CatalogItemThumb item={item} />
          <span>
            <strong>{fullName}</strong>
            {itemCategory(item) !== item.category && <small>{titleCase(itemCategory(item))}</small>}
            {item.category && itemCategory(item) === item.category && <small>{titleCase(item.category)}</small>}
          </span>
        </button>;
      })}
      {!loading && !filteredItems.length && <div className="catalog-empty">No items match your filters.</div>}
    </div>
    {selected && <div className="catalog-selected-item">
      <CatalogItemThumb item={selected} large />
      <KeyValueGrid items={[["Item Name", selected.name], ["Item ID", selected.name], ["Category", selected.category ? titleCase(selected.category) : ""], ["Source", selected.source || ""]]} />
    </div>}
  </div>;
}

export function CatalogItemThumb({ item, large = false, small = false }: { item: CatalogItem; large?: boolean; small?: boolean }) {
  const fallback = "/images/items/image-unavailable.png";
  const src = item.image || `/images/items/${encodeURIComponent(item.itemId || item.id)}.png`;
  const [imageSrc, setImageSrc] = useState(src);
  useEffect(() => {
    setImageSrc(src);
  }, [src]);
  return <div className={large ? "catalog-item-preview large" : small ? "catalog-item-preview small" : "catalog-item-preview"}>
    <img src={imageSrc} alt="" onError={() => { if (imageSrc !== fallback) setImageSrc(fallback); }} />
  </div>;
}

export function normalizeItemGrade(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(5, Math.trunc(numeric)));
}

export function itemGrade(item: { quality?: unknown; grade?: unknown; durability?: unknown }) {
  return normalizeItemGrade(item.quality ?? item.grade ?? item.durability ?? 0);
}

export function grantItemDurability() {
  return 1;
}

// Augment limits — match game config defaults from /Script/DuneSandbox.AugmentSettings:
//   m_MaxRangedWeaponAugments (default 3), m_MaxMeleeWeaponAugments (default 3), m_MaxArmorAugments (default 2).
export const MAX_RANGED_AUGMENTS = 3;
export const MAX_MELEE_AUGMENTS = 3;
export const MAX_ARMOR_AUGMENTS = 2;

export function isWeapon(name: string) {
  return /lasgun|LongRifle|LogRifle|spitdart|jabal|disruptor|[Ss]mg|karpov|[Bb]attle.?[Rr]ifle|BR\b|HarkAr|drillshot|Shotgun|grda|Scattergun|vulcan|LMG|AtreLMG|pyrocket|Fireballer|Flamethrower|rocket|missile|pistol|snubnose|rafiq|maula|HeavyPistol|RocketLauncher|Dmr|Smug|Unique\w*(?:Rifle|Gun|Sword|Dirk|Rapier|Pistol|Shotgun|Launcher|Blade|Cross|Hark|Ar|Sda|Smug|Choam|Thumper|Flame)/i.test(name);
}

export function isArmor(name: string) {
  return /chest|armor|guard|garment|helmet|boots|gloves|suit/i.test(name);
}

export function isMelee(name: string) {
  return /melee|[Ss]word|blade|knife|fremen|Dirk|Rapier|Kindjal|Minotaur|DualBlades|CHOAMSword|Crysknife|DewReaper|Ghola|ScrapMetalKnife|UniqueSword|UniqueDirk|UniqueRapier/i.test(name);
}

export function augmentLimit(itemName: string, category?: string) {
  const cat = (category || "").toLowerCase();
  const nameStr = String(itemName || "");
  if (cat === "schematics" || /_schematic$/i.test(nameStr) || /_Augment_/i.test(nameStr)) return 0;
  const isT6 = /_06(?=_|$)|T6_/i.test(nameStr) || (/Unique/i.test(nameStr) && !/_(0[1-5])(?=_|$)/.test(nameStr));
  if (!isT6) return 0;
  if (cat === "clothing" || isArmor(nameStr)) return MAX_ARMOR_AUGMENTS;
  if (cat === "weapons" || isMelee(nameStr)) return MAX_MELEE_AUGMENTS;
  if (isWeapon(nameStr)) return MAX_RANGED_AUGMENTS;
  return 0;
}

export function packageItemTextLine(item: { itemName?: string; itemId?: string; quantity?: unknown; quality?: unknown; grade?: unknown; durability?: unknown }) {
  return `${item.itemId || item.itemName || ""},${Number(item.quantity) || 1},${itemGrade(item)}`;
}

export function ItemGradeSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <select className="package-item-durability-input" value={String(normalizeItemGrade(value))} onChange={(event) => onChange(event.target.value)}>
    {[0, 1, 2, 3, 4, 5].map((grade) => <option key={grade} value={grade}>{grade}</option>)}
  </select>;
}

export function catalogItemName(item: { itemName?: string; itemId?: string }) {
  if (item.itemName) return item.itemName;
  if (item.itemId) return friendlyCatalogName(item.itemId);
  return "Unknown";
}

export function PackageItemPreview({ item }: { item: { itemId?: string; image?: string } }) {
  const catalogItem = { id: item.itemId || "", name: item.itemId || "Item", image: item.image } as CatalogItem;
  return <CatalogItemThumb item={catalogItem} small />;
}

export function catalogItemId(item: { itemId?: string }) {
  const raw = item.itemId || "";
  if (!raw) return "Resolved on grant";
  return friendlyCatalogName(raw);
}

export function friendlyCatalogName(value: string) {
  return value.replace(/^[-*]\s*/, "").replace(/^\/Game\/.*\//, "").replaceAll("_", " ").replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/\s+/g, " ").trim();
}

export function buildingSubCategory(itemId: string, itemName: string): string {
  const text = ((itemId || "") + " " + (itemName || "")).toLowerCase();
  if (/fabricat/.test(text)) return "Fabricators";
  if (/refin|deathstill|purif/.test(text)) return "Refineries";
  if (/windtrap|generator|pentashield|console|augment.*station|recycler|repair.*station/.test(text)) return "Utilities";
  if (/storage|chest|cistern|container/.test(text)) return "Storage";
  return "Structures";
}

export function itemCategory(item: { category?: string; id: string; name: string }): string {
  if (item.category === "buildings" || item.category === "placeables") {
    return buildingSubCategory(item.id, item.name);
  }
  return item.category || "uncategorized";
}

// AugmentPicker — chip-based multi-select for augment schematics.
// Click an augment to add it as a chip; click the chip X to remove.
// Respects max limit and shows available count.
export function AugmentPicker({ augments, selected, onChange, limit, disabled }: {
  augments: { id: string; name: string }[];
  selected: string[];
  onChange: (selected: string[]) => void;
  limit: number;
  disabled?: boolean;
}) {
  const available = augments.filter((a) => !selected.includes(a.id));
  const selectedItems = augments.filter((a) => selected.includes(a.id));
  const longestName = Math.max(...augments.map((a) => a.name.length), 0);
  const pickerWidth = Math.max(280, longestName * 9 + 40);

  return <div style={{ userSelect: "none" }}>
    {selectedItems.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: "4px", marginBottom: "6px" }}>
      {selectedItems.map((aug) => <span key={aug.id} className="augment-chip" onClick={() => onChange(selected.filter((id) => id !== aug.id))} title={`Remove ${aug.name}`}>
        {aug.name} <span className="augment-chip-x">&times;</span>
      </span>)}
    </div>}
    {!disabled && selected.length < limit && available.length > 0 && <div className="augment-list" style={{ width: pickerWidth, maxHeight: "180px", overflowY: "auto" }}>
      {available.map((aug) => <div key={aug.id} className="augment-option" onClick={() => onChange([...selected, aug.id])}>
        {aug.name}
      </div>)}
    </div>}
    {selected.length >= limit && limit > 0 && <p className="playerAdmin_note" style={{ margin: 0, color: "#9ca3af" }}>{limit === 1 ? "1 augment maximum." : `Maximum ${limit} augments selected.`}</p>}
  </div>;
}
