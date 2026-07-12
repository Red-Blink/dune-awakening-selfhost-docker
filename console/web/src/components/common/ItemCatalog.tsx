import { useEffect, useState } from "react";
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

export function ItemCatalogSelector({ label = "Select Item", selected, onSelect, placeholder = "Filter loaded item catalog" }: { label?: string; selected: CatalogItem | null; onSelect: (item: CatalogItem | null) => void; placeholder?: string }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [category, setCategory] = useState("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");

  async function load() {
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

  const categoryCounts = items.reduce<Record<string, number>>((counts, item) => {
    const key = item.category || "uncategorized";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const categories = ["all", ...Object.keys(categoryCounts).sort()];
  const filteredItems = items.filter((item) => {
    const matchesCategory = category === "all" || item.category === category;
    const haystack = `${item.name} ${item.id} ${item.category || ""} ${item.source || ""}`.toLowerCase();
    return matchesCategory && (!query.trim() || haystack.includes(query.trim().toLowerCase()));
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id, undefined, { sensitivity: "base" }));

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
        <thead><tr><th>Preview</th><th>Item Name</th><th>Item ID</th><th>Category</th><th>Source</th></tr></thead>
        <tbody>{filteredItems.map((item) => {
          const active = selected?.id === item.id && selected?.name === item.name;
          const fullName = catalogItemName(item);
          return <tr className={active ? "active" : ""} key={`${item.id}-${item.name}-${item.source}`} title={fullName} onClick={() => onSelect(item)}>
            <td><CatalogItemThumb item={item} small /></td>
            <td className="catalog-item-name-cell">{fullName}</td>
            <td>{item.id}</td>
            <td>{item.category ? titleCase(item.category) : ""}</td>
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
            <small>{item.id}{item.category ? ` - ${titleCase(item.category)}` : ""}</small>
          </span>
        </button>;
      })}
      {!loading && !filteredItems.length && <div className="catalog-empty">No items match your filters.</div>}
    </div>
    {selected && <div className="catalog-selected-item">
      <CatalogItemThumb item={selected} large />
      <KeyValueGrid items={[["Item Name", selected.name], ["Item ID", selected.id], ["Category", selected.category ? titleCase(selected.category) : ""], ["Source", selected.source || ""]]} />
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

export function catalogItemMinimumGrade(item?: { itemId?: string; id?: string; source?: string; category?: string } | null) {
  const id = String(item?.itemId || item?.id || "");
  const source = String(item?.source || "").toLowerCase();
  const category = String(item?.category || "").toLowerCase();
  return source.includes("augment") || category.includes("augment") || /^T\d+_Augment_/i.test(id) ? 1 : 0;
}

export function packageItemTextLine(item: { itemName?: string; itemId?: string; quantity?: unknown; quality?: unknown; grade?: unknown; durability?: unknown; augments?: string[]; augmentQuality?: unknown }) {
  const augments = Array.isArray(item.augments) && item.augments.length ? item.augments.join("|") : "";
  const augmentQuality = augments ? Math.max(1, Math.min(5, normalizeItemGrade(item.augmentQuality ?? 1) || 1)) : "";
  return `${item.itemId || item.itemName || ""},${Number(item.quantity) || 1},${itemGrade(item)},${augments},${augmentQuality}`;
}

export function ItemGradeSelect({ value, onChange, minGrade = 0, disabled = false, emptyWhenDisabled = false }: { value: string; onChange: (value: string) => void; minGrade?: number; disabled?: boolean; emptyWhenDisabled?: boolean }) {
  const min = Math.max(0, Math.min(5, Math.trunc(Number(minGrade) || 0)));
  const selected = Math.max(min, normalizeItemGrade(value));
  const selectedValue = disabled && emptyWhenDisabled ? "" : String(selected);
  return <select className="package-item-durability-input" value={selectedValue} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
    {emptyWhenDisabled && <option value=""></option>}
    {[0, 1, 2, 3, 4, 5].filter((grade) => grade >= min).map((grade) => <option key={grade} value={grade}>{grade}</option>)}
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
  return item.itemId || "Resolved on grant";
}

export function friendlyCatalogName(value: string) {
  return value.replace(/^[-*]\s*/, "").replace(/^\/Game\/.*\//, "").replaceAll("_", " ").trim();
}
