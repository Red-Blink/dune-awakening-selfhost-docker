import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { marketBotItemsApi, type MarketBotItemRow, type MarketCatalogPickItem } from "../../api/marketBotItems";
import { InfoTooltip } from "../../components/common/DisplayPrimitives";
import { EXCHANGE_CATEGORY_LABELS } from "./display";

type BotItemsTabProps = {
  onError: (text: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
};

const BOT_ITEMS_PAGE_SIZES = [25, 50, 100, 200] as const;
const BOT_ITEMS_DEFAULT_PAGE_SIZE = 50;

function qualityLabel(quality: number) {
  return quality > 0 ? `Q${quality}` : "Standard";
}

function categoryLabel(category: string) {
  const raw = String(category || "").trim();
  const known = EXCHANGE_CATEGORY_LABELS[raw.toLowerCase()];
  if (known) return known;
  return raw
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toLocaleUpperCase()}${word.slice(1)}`)
    .join(" ");
}

// Existing-row drafts are keyed by templateId::qualityLevel -- the same
// template id repeats once per grade with its own price, so a template-only
// key would apply one grade's edit to every grade of that item.
function draftKey(templateId: string, qualityLevel: number) {
  return `${templateId}::${qualityLevel}`;
}

type OverrideDraft = { price?: number; listings?: number; enabled?: boolean };
type NewItemDraft = { name: string; category: string; price: number; listings: number; enabled: boolean; qualityLevel: number };
type BotItemsSortColumn = "displayName" | "category" | "qualityLevel" | "price" | "listings" | "enabled";
type SortDirection = "asc" | "desc";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function fmt(value: number) {
  return Number(value || 0).toLocaleString();
}

function ItemPickerOverlay({ onClose, onPick, alreadyAdded }: { onClose: () => void; onPick: (item: MarketCatalogPickItem) => void; alreadyAdded: Set<string> }) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [rows, setRows] = useState<MarketCatalogPickItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timeoutId = window.setTimeout(() => {
      void marketBotItemsApi.catalog({ q, category })
        .then((result) => { if (!cancelled) { setRows(result.rows || []); setLoading(false); } })
        .catch((err) => { if (!cancelled) { setError(errorText(err)); setLoading(false); } });
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timeoutId); };
  }, [q, category]);

  const categories = useMemo(() => [...new Set(rows.map((r) => r.category).filter(Boolean))].sort(), [rows]);

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Add Bot Item" onClick={onClose}>
      <div className="confirm-modal exchange-config-modal" onClick={(event) => event.stopPropagation()}>
        <div className="confirm-modal-title">
          <h3>Add Bot Item</h3>
          <button className="exchange-config-close" aria-label="Close" onClick={onClose}><X size={16} /></button>
        </div>
        <p>Pick from the item catalog. Buildings, contracts, emotes, and unsafe items are not selectable.</p>
        <div className="action-row exchange-search-row">
          <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search Item Name" />
          <label className="compact-select exchange-category-select">
            Category
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">All Categories</option>
              {categories.map((name) => <option key={name} value={name}>{categoryLabel(name)}</option>)}
            </select>
          </label>
        </div>
        {error && <p className="action-help-note error-text">{error}</p>}
        {loading
          ? <p className="muted">Loading…</p>
          : <ul className="exchange-config-chips bot-item-picker-list">
            {rows.length === 0 && <p className="muted exchange-config-empty">No matching items.</p>}
            {rows.map((item) => {
              const added = alreadyAdded.has(item.itemId);
              return (
                <li key={item.itemId} className="exchange-config-chip bot-item-picker-row">
                  <span>{item.name}<em>{categoryLabel(item.category)}</em></span>
                  <button type="button" disabled={added} onClick={() => onPick(item)}>{added ? "Added" : "Add"}</button>
                </li>
              );
            })}
          </ul>}
        <div className="confirm-modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export function BotItemsTab({ onError, onDirtyChange }: BotItemsTabProps) {
  const [rows, setRows] = useState<MarketBotItemRow[]>([]);
  const [supported, setSupported] = useState(true);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [qualityFilter, setQualityFilter] = useState("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(BOT_ITEMS_DEFAULT_PAGE_SIZE);
  const [sortColumn, setSortColumn] = useState<BotItemsSortColumn>("displayName");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, OverrideDraft>>({});
  const [newItemDrafts, setNewItemDrafts] = useState<Record<string, NewItemDraft>>({});
  const [removedNewItems, setRemovedNewItems] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const pageToggleRef = useRef<HTMLInputElement>(null);

  function load() {
    setLoading(true);
    void marketBotItemsApi.list()
      .then((result) => {
        setRows(result.rows || []);
        setSupported(result.capabilities?.exchangeMarket !== false);
        setReason(result.reason || "");
        setLoading(false);
      })
      .catch((error) => {
        onError(errorText(error));
        setLoading(false);
      });
  }

  useEffect(() => { load(); }, []);

  const existingIds = useMemo(() => new Set(rows.map((row) => row.templateId)), [rows]);
  const combinedRows = useMemo(() => {
    const removedSet = new Set(removedNewItems);
    const base = rows.filter((row) => !(row.isNew && removedSet.has(row.templateId)));
    return [
      ...base,
      ...Object.entries(newItemDrafts)
        .filter(([templateId]) => !existingIds.has(templateId))
        .map(([templateId, draft]) => ({
          templateId, displayName: draft.name, category: draft.category, qualityLevel: draft.qualityLevel,
          price: draft.price, listings: draft.listings, enabled: draft.enabled, overridden: false, isNew: true, unsafe: false
        }))
    ] as MarketBotItemRow[];
  }, [rows, newItemDrafts, removedNewItems, existingIds]);

  // Option lists derive from the full combined set (before search/category/quality
  // filters) so a dropdown's own options never disappear while it's the active filter.
  const categories = useMemo(() => [...new Set(combinedRows.map((row) => row.category).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [combinedRows]);
  const qualityLevels = useMemo(() => [...new Set(combinedRows.map((row) => row.qualityLevel))].sort((a, b) => a - b), [combinedRows]);

  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return combinedRows.filter((row) => {
      if (category && row.category !== category) return false;
      if (qualityFilter !== "" && row.qualityLevel !== Number(qualityFilter)) return false;
      if (!term) return true;
      return row.displayName.toLowerCase().includes(term) || row.templateId.toLowerCase().includes(term) || row.category.toLowerCase().includes(term);
    });
  }, [combinedRows, search, category, qualityFilter]);

  function changeSearch(value: string) {
    setSearch(value);
    setPage(0);
  }

  function changeCategory(value: string) {
    setCategory(value);
    setPage(0);
  }

  function changeQuality(value: string) {
    setQualityFilter(value);
    setPage(0);
  }

  function changePageSize(nextSize: number) {
    setPageSize(nextSize);
    setPage(0);
  }

  const dirtyCount = Object.keys(overrideDrafts).length + Object.keys(newItemDrafts).length + removedNewItems.length;
  const toggleableCount = useMemo(() => filteredRows.filter((row) => !row.unsafe).length, [filteredRows]);

  function fieldValue(row: MarketBotItemRow, field: "price" | "listings" | "enabled") {
    if (row.isNew && newItemDrafts[row.templateId]) return newItemDrafts[row.templateId][field === "listings" ? "listings" : field] as number | boolean;
    const draft = overrideDrafts[draftKey(row.templateId, row.qualityLevel)];
    if (draft && field in draft) return draft[field] as number | boolean;
    return row[field];
  }

  const sortedRows = useMemo(() => {
    function sortValue(row: MarketBotItemRow) {
      if (sortColumn === "price" || sortColumn === "listings" || sortColumn === "enabled") return fieldValue(row, sortColumn);
      return row[sortColumn];
    }
    return [...filteredRows].sort((a, b) => {
      const aValue = sortValue(a);
      const bValue = sortValue(b);
      const comparison = typeof aValue === "number" && typeof bValue === "number"
        ? aValue - bValue
        : typeof aValue === "boolean" && typeof bValue === "boolean"
          ? Number(aValue) - Number(bValue)
          : String(aValue ?? "").localeCompare(String(bValue ?? ""), undefined, { sensitivity: "base", numeric: true });
      const directed = sortDirection === "asc" ? comparison : -comparison;
      if (directed !== 0) return directed;
      return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base", numeric: true })
        || a.qualityLevel - b.qualityLevel;
    });
  }, [filteredRows, sortColumn, sortDirection, overrideDrafts, newItemDrafts]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safePage = Math.min(page, totalPages - 1);
  const rangeStart = sortedRows.length === 0 ? 0 : safePage * pageSize + 1;
  const visibleRows = useMemo(() => sortedRows.slice(safePage * pageSize, safePage * pageSize + pageSize), [sortedRows, safePage, pageSize]);
  const rangeEnd = sortedRows.length === 0 ? 0 : rangeStart + visibleRows.length - 1;

  const pageToggleableRows = visibleRows.filter((row) => !row.unsafe);
  const pageEnabledCount = pageToggleableRows.filter((row) => Boolean(fieldValue(row, "enabled"))).length;
  const allPageItemsEnabled = pageToggleableRows.length > 0 && pageEnabledCount === pageToggleableRows.length;
  const somePageItemsEnabled = pageEnabledCount > 0 && !allPageItemsEnabled;

  function changeSort(column: BotItemsSortColumn) {
    if (column === sortColumn) setSortDirection((current) => current === "asc" ? "desc" : "asc");
    else {
      setSortColumn(column);
      setSortDirection("asc");
    }
    setPage(0);
  }

  function sortHeader(column: BotItemsSortColumn, label: string) {
    const active = sortColumn === column;
    return (
      <button
        type="button"
        className="bot-items-sort-button"
        onClick={() => changeSort(column)}
        aria-label={`Sort by ${label}${active ? `, currently ${sortDirection === "asc" ? "ascending" : "descending"}` : ""}`}
      >
        <span>{label}</span>
        <span className={`bot-items-sort-indicator${active ? " active" : ""}`} aria-hidden="true">{active ? (sortDirection === "asc" ? "↑" : "↓") : "↕"}</span>
      </button>
    );
  }

  useEffect(() => {
    if (pageToggleRef.current) pageToggleRef.current.indeterminate = somePageItemsEnabled;
  }, [somePageItemsEnabled]);

  useEffect(() => {
    onDirtyChange?.(dirtyCount > 0);
    return () => onDirtyChange?.(false);
  }, [dirtyCount, onDirtyChange]);

  useEffect(() => {
    if (dirtyCount === 0) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirtyCount]);

  function updateExisting(templateId: string, qualityLevel: number, patch: OverrideDraft) {
    const key = draftKey(templateId, qualityLevel);
    setOverrideDrafts((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  }

  function setEnabledForRows(targetRows: MarketBotItemRow[], enabled: boolean) {
    const overridePatch: Record<string, OverrideDraft> = {};
    const newItemPatch: Record<string, Partial<NewItemDraft>> = {};
    for (const row of targetRows) {
      if (row.unsafe) continue;
      if (row.isNew) newItemPatch[row.templateId] = { enabled };
      else overridePatch[draftKey(row.templateId, row.qualityLevel)] = { enabled };
    }
    setOverrideDrafts((current) => {
      const next = { ...current };
      for (const [key, patch] of Object.entries(overridePatch)) next[key] = { ...next[key], ...patch };
      return next;
    });
    setNewItemDrafts((current) => {
      const next = { ...current };
      for (const [templateId, patch] of Object.entries(newItemPatch)) next[templateId] = { ...next[templateId], ...patch } as NewItemDraft;
      return next;
    });
  }

  // Match actions apply across every filtered page. The header checkbox uses
  // the same update path with only the rows currently visible on the page.
  function setEnabledForFilteredRows(enabled: boolean) {
    setEnabledForRows(filteredRows, enabled);
  }

  function setEnabledForVisibleRows(enabled: boolean) {
    setEnabledForRows(visibleRows, enabled);
  }

  function updateNewDraft(templateId: string, patch: Partial<NewItemDraft>) {
    setNewItemDrafts((current) => ({ ...current, [templateId]: { ...current[templateId], ...patch } as NewItemDraft }));
  }

  function removeNewDraft(templateId: string) {
    setNewItemDrafts((current) => {
      const next = { ...current };
      delete next[templateId];
      return next;
    });
  }

  function removeExistingNewItem(templateId: string) {
    setRemovedNewItems((current) => [...current, templateId]);
  }

  function pickItem(item: MarketCatalogPickItem) {
    updateNewDraft(item.itemId, {
      name: item.name,
      category: item.category,
      price: 100,
      listings: 1,
      enabled: true,
      qualityLevel: 0
    });
  }

  function discardAll() {
    setOverrideDrafts({});
    setNewItemDrafts({});
    setRemovedNewItems([]);
  }

  // Flat draftKey (templateId::qualityLevel) -> per-template map of qualityLevel -> patch,
  // matching the backend's nested overrides schema.
  function buildOverridesPayload() {
    const payload: Record<string, Record<string, OverrideDraft>> = {};
    for (const [key, patch] of Object.entries(overrideDrafts)) {
      const separatorIndex = key.lastIndexOf("::");
      const templateId = key.slice(0, separatorIndex);
      const qualityLevel = key.slice(separatorIndex + 2);
      payload[templateId] = { ...payload[templateId], [qualityLevel]: patch };
    }
    return payload;
  }

  async function saveAll() {
    setSaving(true);
    onError("");
    try {
      await marketBotItemsApi.save({
        overrides: buildOverridesPayload(),
        newItems: Object.fromEntries(Object.entries(newItemDrafts).map(([templateId, draft]) => [templateId, {
          name: draft.name, price: draft.price, listings: draft.listings, enabled: draft.enabled, qualityLevel: draft.qualityLevel
        }])),
        removedNewItems
      });
      discardAll();
      load();
    } catch (error) {
      onError(errorText(error));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="loading-panel">
        <span className="spinner" aria-hidden="true" />
        <strong className="loading-dots">Loading Bot Items</strong>
      </div>
    );
  }

  if (!supported) {
    return <p className="action-help-note">{reason || "The Market Bot is unsupported by the detected database schema."}</p>;
  }

  return (
    <>
      <div className="action-row exchange-search-row bot-items-toolbar">
        <input value={search} onChange={(event) => changeSearch(event.target.value)} placeholder="Search Bot Items" />
        <label className="compact-select exchange-category-select">
          Category
          <select value={category} onChange={(event) => changeCategory(event.target.value)}>
            <option value="">All Categories</option>
            {categories.map((name) => <option key={name} value={name}>{categoryLabel(name)}</option>)}
          </select>
        </label>
        <label className="compact-select exchange-category-select">
          Quality
          <select value={qualityFilter} onChange={(event) => changeQuality(event.target.value)}>
            <option value="">All Qualities</option>
            {qualityLevels.map((level) => <option key={level} value={level}>{qualityLabel(level)}</option>)}
          </select>
        </label>
        <button className="bot-items-add-button" onClick={() => setPickerOpen(true)}><Plus size={14} /> Add Item</button>
      </div>
      <div className="panel-title bot-items-summary-row">
        <p className="action-help-note">
          {filteredRows.length !== combinedRows.length
            ? (filteredRows.length === 1
              ? `Showing ${rangeStart}-${rangeEnd} of ${filteredRows.length.toLocaleString()} item (${combinedRows.length.toLocaleString()} total).`
              : `Showing ${rangeStart}-${rangeEnd} of ${filteredRows.length.toLocaleString()} items (${combinedRows.length.toLocaleString()} total).`)
            : (filteredRows.length === 1
              ? `Showing ${rangeStart}-${rangeEnd} of ${filteredRows.length.toLocaleString()} item.`
              : `Showing ${rangeStart}-${rangeEnd} of ${filteredRows.length.toLocaleString()} items.`)}
        </p>
        <div className="action-row bot-items-match-actions">
          <button title={`Disable all ${toggleableCount.toLocaleString()} matching items`} onClick={() => setEnabledForFilteredRows(false)} disabled={toggleableCount === 0}>Disable Matches</button>
          <button title={`Enable all ${toggleableCount.toLocaleString()} matching items`} onClick={() => setEnabledForFilteredRows(true)} disabled={toggleableCount === 0}>Enable Matches</button>
          <InfoTooltip id="bot-items-filtered-actions-help" label="What Enabling and Disabling Does">Enabling includes matching items in future Market Bot reseeds and uses their configured prices when calculating buyback limits. Disabling excludes them from future reseeds and buyback calculations. It does not immediately remove existing bot listings; those update on the next reseed or when bot listings are cleared. Match actions include all filtered pages and take effect only after Save Changes.</InfoTooltip>
        </div>
      </div>
      <div className="table-wrap bot-items-table-wrap">
        <table className="bot-items-table">
          <thead>
            <tr>
              <th className="bot-items-col-item" aria-label="Item" aria-sort={sortColumn === "displayName" ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}>{sortHeader("displayName", "Item")}</th>
              <th className="bot-items-col-category" aria-label="Category" aria-sort={sortColumn === "category" ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}>{sortHeader("category", "Category")}</th>
              <th className="bot-items-col-quality" aria-label="Quality" aria-sort={sortColumn === "qualityLevel" ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}>{sortHeader("qualityLevel", "Quality")}</th>
              <th className="bot-items-col-price" aria-label="Price" aria-sort={sortColumn === "price" ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}>{sortHeader("price", "Price")}</th>
              <th className="bot-items-col-stock" aria-label="Stock" aria-sort={sortColumn === "listings" ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}>{sortHeader("listings", "Stock")}</th>
              <th className="bot-items-col-enabled" aria-label="On" aria-sort={sortColumn === "enabled" ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}>
                <span className="bot-items-page-toggle">
                  {sortHeader("enabled", "On")}
                  <input
                    ref={pageToggleRef}
                    type="checkbox"
                    aria-label="Enable All Items on This Page"
                    title="Enable or disable all items on this page"
                    checked={allPageItemsEnabled}
                    disabled={pageToggleableRows.length === 0}
                    onChange={(event) => setEnabledForVisibleRows(event.target.checked)}
                  />
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 && (
              <tr><td colSpan={6} className="muted">No bot items match this filter.</td></tr>
            )}
            {visibleRows.map((row) => {
              const price = fieldValue(row, "price") as number;
              const listings = fieldValue(row, "listings") as number;
              const enabled = fieldValue(row, "enabled") as boolean;
              const dirty = row.isNew ? Boolean(newItemDrafts[row.templateId]) : Boolean(overrideDrafts[draftKey(row.templateId, row.qualityLevel)]);
              const disabled = row.unsafe;
              return (
                <tr key={`${row.templateId}:${row.qualityLevel}`} className={dirty ? "bot-item-row-dirty" : undefined}>
                  <td className="bot-items-col-item">
                    <div className="bot-item-identity">
                      <span className="exchange-item-text">
                        <span className="exchange-item-name">{row.displayName}</span>
                        <span className="exchange-item-template" title={row.templateId}>{row.templateId}</span>
                      </span>
                      {row.isNew && (
                        <button
                          type="button"
                          className="bot-item-remove-button"
                          onClick={() => newItemDrafts[row.templateId]
                            ? removeNewDraft(row.templateId)
                            : removeExistingNewItem(row.templateId)}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    <div className="bot-item-badges">
                      {row.unsafe && <span className="bot-item-badge bot-item-badge-unsafe">Unsafe — Excluded</span>}
                      {row.isNew && <span className="bot-item-badge bot-item-badge-new">New</span>}
                    </div>
                  </td>
                  <td className="bot-items-col-category">{row.category ? categoryLabel(row.category) : <span className="muted">—</span>}</td>
                  <td className="bot-items-col-quality">{qualityLabel(row.qualityLevel)}</td>
                  <td className="bot-items-col-price">
                    <input
                      type="number" min={1} disabled={disabled}
                      aria-label={`${row.displayName} Price`}
                      className={dirty ? "bot-item-field-dirty" : undefined}
                      value={price}
                      onChange={(event) => {
                        const next = Math.max(1, Math.trunc(Number(event.target.value) || 0));
                        if (row.isNew) updateNewDraft(row.templateId, { price: next });
                        else updateExisting(row.templateId, row.qualityLevel, { price: next });
                      }}
                    />
                  </td>
                  <td className="bot-items-col-stock">
                    <input
                      type="number" min={1} max={99} disabled={disabled}
                      aria-label={`${row.displayName} Stock`}
                      className={dirty ? "bot-item-field-dirty" : undefined}
                      value={listings}
                      onChange={(event) => {
                        const next = Math.min(99, Math.max(1, Math.trunc(Number(event.target.value) || 0)));
                        if (row.isNew) updateNewDraft(row.templateId, { listings: next });
                        else updateExisting(row.templateId, row.qualityLevel, { listings: next });
                      }}
                    />
                  </td>
                  <td className="bot-items-col-enabled">
                    <input
                      type="checkbox" disabled={disabled}
                      aria-label={`${row.displayName} On`}
                      checked={enabled}
                      onChange={(event) => {
                        if (row.isNew) updateNewDraft(row.templateId, { enabled: event.target.checked });
                        else updateExisting(row.templateId, row.qualityLevel, { enabled: event.target.checked });
                      }}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="panel-title exchange-pagination-footer">
        <p className="action-help-note">{`Showing ${rangeStart}-${rangeEnd} of ${filteredRows.length.toLocaleString()} items.`}</p>
        <div className="database-pagination-controls">
          <label className="compact-select">
            Rows
            <select value={String(pageSize)} onChange={(event) => changePageSize(Number(event.target.value))}>
              {BOT_ITEMS_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
          <button disabled={safePage <= 0} onClick={() => setPage(0)}>First</button>
          <button disabled={safePage <= 0} onClick={() => setPage(safePage - 1)}>Previous</button>
          <span className="muted database-page-indicator">Page {safePage + 1} of {totalPages}</span>
          <button disabled={safePage + 1 >= totalPages} onClick={() => setPage(safePage + 1)}>Next</button>
          <button disabled={safePage + 1 >= totalPages} onClick={() => setPage(totalPages - 1)}>Last</button>
        </div>
      </div>
      {dirtyCount > 0 && (
        <div className="bot-items-unsaved-bar" role="status" aria-live="polite">
          <div className="bot-items-unsaved-copy">
            <strong>{dirtyCount} Unsaved Change{dirtyCount === 1 ? "" : "s"}</strong>
            <span>Save or discard your changes before leaving Bot Items.</span>
          </div>
          <div className="database-pagination-controls">
            <button onClick={discardAll} disabled={saving}>Discard Changes</button>
            <button className="primary" onClick={() => void saveAll()} disabled={saving}>{saving ? "Saving…" : "Save Changes"}</button>
          </div>
        </div>
      )}
      {pickerOpen && (
        <ItemPickerOverlay
          onClose={() => setPickerOpen(false)}
          onPick={pickItem}
          alreadyAdded={new Set([...existingIds, ...Object.keys(newItemDrafts)])}
        />
      )}
    </>
  );
}
