import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Boxes, ChevronDown, ChevronRight, X } from "lucide-react";
import {
  basesApi,
  type BaseInventory,
  type BaseInventoryContainer,
  type BaseInventoryGroupKey,
  type BaseInventoryItem
} from "../../api/bases";

type BaseInventoryTabProps = {
  baseId: string;
};

// The rollup is capped so the tab cannot blow out the height of an already
// expanded table row; "Show all" lifts it.
const ITEM_PREVIEW_LIMIT = 25;

type GroupFilter = BaseInventoryGroupKey | "all";
type ViewMode = "items" | "containers";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// Falls back to the type when a placeable has never been renamed in-game --
// the backend returns "" rather than the game's '##'-prefixed default.
function containerLabel(container: { name: string; typeName: string; placeableId: string }) {
  return container.name || `${container.typeName} #${container.placeableId}`;
}

export function BaseInventoryTab({ baseId }: BaseInventoryTabProps) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [data, setData] = useState<BaseInventory | null>(null);
  // Containers first: opening the tab is usually "what is at this base", and
  // the cards answer that at a glance. The rollup is the follow-up question.
  const [view, setView] = useState<ViewMode>("containers");
  const [group, setGroup] = useState<GroupFilter>("all");
  // Two-state search, matching every other server-shaped search box in the
  // app: `q` is what is typed, `submittedQ` is what filters. The filtering
  // itself is client-side -- the whole base already arrived in one response --
  // but search-as-you-type is not the panel's vocabulary.
  const [q, setQ] = useState("");
  const [submittedQ, setSubmittedQ] = useState("");
  const [expandedItem, setExpandedItem] = useState("");
  // Placeable id whose contents overlay is open, "" for none.
  const [contentsFor, setContentsFor] = useState("");
  const [showAllItems, setShowAllItems] = useState(false);
  const closeContentsRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      setData(await basesApi.inventory(baseId));
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [baseId]);

  useEffect(() => { void load(); }, [load]);

  const term = submittedQ.trim().toLowerCase();

  const items = useMemo(() => {
    if (!data) return [] as BaseInventoryItem[];
    return data.items
      .map((item) => (group === "all"
        ? item
        : {
            ...item,
            containers: item.containers.filter((holder) => holder.group === group)
          }))
      // Filtering by group re-derives the quantity from the surviving
      // containers -- showing the base-wide total under a group chip would
      // claim stock the group does not hold.
      .map((item) => (group === "all" ? item : {
        ...item,
        quantity: item.containers.reduce((total, holder) => total + holder.quantity, 0),
        containerCount: item.containers.length
      }))
      .filter((item) => item.containers.length > 0)
      .filter((item) => !term ||
        item.name.toLowerCase().includes(term) ||
        item.templateId.toLowerCase().includes(term));
  }, [data, group, term]);

  const containers = useMemo(() => {
    if (!data) return [] as BaseInventoryContainer[];
    return data.containers
      .filter((container) => group === "all" || container.group === group)
      .filter((container) => !term ||
        containerLabel(container).toLowerCase().includes(term) ||
        container.items.some((stack) => stack.name.toLowerCase().includes(term)))
      // Sorted on the rendered label, not on name/typeName separately, so a
      // renamed container files under the name on its card rather than
      // disappearing into a block of its own type. numeric keeps "#9" ahead
      // of "#10"; the cards are grouped into sections downstream, so this is
      // already per-group.
      .slice()
      .sort((left, right) => containerLabel(left).localeCompare(
        containerLabel(right), undefined, { numeric: true, sensitivity: "base" }));
  }, [data, group, term]);

  // Resolved from the unfiltered list: a group chip or search term applied
  // after the overlay opened must not blank out what is on screen.
  const openContainer = contentsFor
    ? data?.containers.find((container) => container.placeableId === contentsFor) || null
    : null;

  // Item icons live on the rollup, keyed by template, so the overlay reuses
  // them rather than the response carrying the same URL twice per container.
  const imagesByTemplate = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of data?.items || []) map.set(item.templateId, item.image);
    return map;
  }, [data]);
  const itemImage = (templateId: string) =>
    imagesByTemplate.get(templateId) || "/images/items/image-unavailable.png";

  // Matches ConfirmDialog: Escape closes, and focus moves to the close button
  // so the overlay is reachable without a mouse.
  useEffect(() => {
    if (!openContainer) return undefined;
    closeContentsRef.current?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setContentsFor("");
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [openContainer]);

  function applySearch(next: string) {
    setSubmittedQ(next);
    setExpandedItem("");
    setShowAllItems(false);
  }

  if (loading) {
    return <p className="muted" role="status">Loading base inventory…</p>;
  }
  if (loadError) {
    return <p className="bases-permissions-error" role="alert">
      {loadError} <button onClick={() => void load()}>Retry</button>
    </p>;
  }
  if (!data) return null;

  const { totals } = data;
  const slotPercent = totals.maxSlots > 0 ? Math.round((totals.usedSlots / totals.maxSlots) * 100) : 0;
  const visibleItems = showAllItems ? items : items.slice(0, ITEM_PREVIEW_LIMIT);

  return (
    <div className="bases-inventory" onClick={(event) => event.stopPropagation()}>
      <div className="bases-tab-body">
        {/* Stated before the data rather than after it: it governs how to read
            everything below, and at the foot of a 27-card list it was never
            seen. */}
        <p className="bases-inventory-note muted">
          Read-only. Base inventory has no live-sync path, so the console cannot write items here.
        </p>

        {/* summary-stats/summary-stat are the app's stat tiles, shared with
            the player summary, so these read as boxes like everywhere else. */}
        <dl className="bases-inventory-totals summary-stats">
          <div className="summary-stat"><dt>Items</dt><dd>{totals.items.toLocaleString()}</dd></div>
          <div className="summary-stat"><dt>Distinct</dt><dd>{totals.distinct.toLocaleString()}</dd></div>
          <div className="summary-stat"><dt>Containers</dt><dd>{totals.containers.toLocaleString()}</dd></div>
          <div className="summary-stat"><dt>Slots used</dt><dd>{totals.maxSlots > 0 ? `${slotPercent}%` : "—"}</dd></div>
        </dl>

        <div className="bases-inventory-controls">
          <div className="bases-inventory-groups" role="group" aria-label="Filter by container group">
            <button
              className={`bases-inventory-chip${group === "all" ? " active" : ""}`}
              aria-pressed={group === "all"}
              onClick={() => { setGroup("all"); setShowAllItems(false); }}
            >All</button>
            {data.groups.filter((entry) => entry.containerCount > 0).map((entry) => (
              <button
                key={entry.key}
                className={`bases-inventory-chip${group === entry.key ? " active" : ""}`}
                aria-pressed={group === entry.key}
                onClick={() => { setGroup(entry.key); setShowAllItems(false); }}
              >{entry.name} <span className="bases-inventory-chip-count">{entry.containerCount}</span></button>
            ))}
          </div>
          <div className="bases-inventory-views" role="group" aria-label="Inventory view">
            <button
              className={`bases-inventory-view${view === "items" ? " active" : ""}`}
              aria-pressed={view === "items"}
              onClick={() => setView("items")}
            >Items</button>
            <button
              className={`bases-inventory-view${view === "containers" ? " active" : ""}`}
              aria-pressed={view === "containers"}
              onClick={() => setView("containers")}
            >Containers</button>
          </div>
        </div>

        <div className="bases-inventory-search">
          <input
            value={q}
            aria-label="Filter base inventory"
            placeholder={view === "items" ? "Filter items…" : "Filter containers…"}
            onChange={(event) => setQ(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") applySearch(q); }}
          />
          <button onClick={() => applySearch(q)}>Search</button>
          <button onClick={() => { setQ(""); applySearch(""); }}>Clear</button>
        </div>

        {view === "items"
          ? <div className="bases-inventory-items">
              {!items.length
                ? <p className="muted">{term || group !== "all" ? "No items match this filter." : "No stored items at this base."}</p>
                : <>
                    <div className="bases-inventory-item-head">
                      <span /><span>Item</span><span>Qty</span><span>Containers</span>
                    </div>
                    {visibleItems.map((item) => {
                      const open = expandedItem === item.templateId;
                      return (
                        <div key={item.templateId}>
                          <button
                            className="bases-inventory-item-row"
                            aria-expanded={open}
                            onClick={() => setExpandedItem(open ? "" : item.templateId)}
                          >
                            <span aria-hidden="true">{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
                            <span className="bases-inventory-item-name">
                              <img src={item.image} alt="" aria-hidden="true" />
                              {item.name}
                            </span>
                            <span className="bases-inventory-qty">{item.quantity.toLocaleString()}</span>
                            <span className="bases-inventory-count">{item.containerCount}</span>
                          </button>
                          {open && <div className="bases-inventory-breakdown">
                            {item.containers.map((holder) => (
                              <div key={holder.placeableId}>
                                <span>{containerLabel(holder)}</span>
                                <span>{holder.quantity.toLocaleString()}</span>
                              </div>
                            ))}
                          </div>}
                        </div>
                      );
                    })}
                    {items.length > ITEM_PREVIEW_LIMIT && <button
                      className="bases-inventory-show-all"
                      onClick={() => setShowAllItems(!showAllItems)}
                    >{showAllItems ? "Show fewer items" : `Show all ${items.length.toLocaleString()} items`}</button>}
                  </>}
            </div>
          : <div className="bases-inventory-containers">
              {!containers.length
                ? <p className="muted">{term || group !== "all" ? "No containers match this filter." : "No storage at this base."}</p>
                : data.groups.filter((entry) =>
                    containers.some((container) => container.group === entry.key)).map((entry) => {
                  const owned = containers.filter((container) => container.group === entry.key);
                  // Distinct templates, not a total quantity: the summary tile
                  // above already gives the base-wide count, and a group's
                  // total is dominated by whichever stack happens to be
                  // largest (one Solari stack buries everything else).
                  const distinct = new Set(
                    owned.flatMap((container) => container.items.map((stack) => stack.templateId))).size;
                  return (
                    <section key={entry.key}>
                      <div className="bases-inventory-group-head">
                        <h4>{entry.name}</h4>
                        <span className="muted">
                          {owned.length.toLocaleString()} {owned.length === 1 ? "container" : "containers"}
                          {" · "}
                          {distinct.toLocaleString()} distinct
                        </span>
                      </div>
                      {/* Same card vocabulary as Power and Water -- the amber
                          bordered group and the rule-separated definition list
                          -- rather than a bespoke one, so the four tabs read
                          as one panel. */}
                      <div className="bases-card-grid bases-inventory-cards">
                        {owned.map((container) => {
                          const percent = container.maxSlots > 0
                            ? Math.round((container.usedSlots / container.maxSlots) * 100)
                            : 0;
                          return (
                            <div className="bases-card" key={container.placeableId}>
                              <div className="bases-card-title">
                                {container.name || container.typeName}
                              </div>
                              {/* The type sits under the name rather than in a
                                  labelled row. When a container has no custom
                                  name the title is already the type, so the
                                  subtitle carries only the id -- most
                                  containers on a real base are unnamed. */}
                              <p className="bases-inventory-card-subtitle">
                                {container.name
                                  ? `${container.typeName} · #${container.placeableId}`
                                  : `#${container.placeableId}`}
                              </p>
                              <dl className="bases-card-stats">
                                <dt>Slots Used</dt>
                                <dd>
                                  <div className="progress-row">
                                    <div className="progress-track">
                                      <div className="progress-fill" style={{ width: `${Math.min(100, percent)}%` }} />
                                    </div>
                                    <span>{container.usedSlots.toLocaleString()} / {container.maxSlots.toLocaleString()}</span>
                                  </div>
                                </dd>
                                <dt>Items</dt>
                                <dd>{container.itemCount.toLocaleString()}</dd>
                                {/* Label hidden but not removed: the row keeps
                                    the same height as every other stat, and
                                    the button below already says what it is. */}
                                <dt className="bases-inventory-spacer-label" aria-hidden="true">Contents</dt>
                                <dd>
                                  {!container.items.length
                                    ? <span className="muted">Empty</span>
                                    : <button
                                        className="bases-inventory-view-contents"
                                        onClick={() => setContentsFor(container.placeableId)}
                                      >
                                        <Boxes size={14} aria-hidden="true" />
                                        View Contents
                                        {/* "distinct", never "stacks": the backend merges rows
                                            of the same template, so this is below usedSlots
                                            whenever a template occupies more than one slot
                                            (8 slots collapsing to 3 templates is common). */}
                                        <span className="muted">
                                          {container.items.length.toLocaleString()} distinct
                                        </span>
                                      </button>}
                                </dd>
                              </dl>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  );
                })}
            </div>}
      </div>

      {openContainer && <div className="modal-overlay" role="presentation" onMouseDown={() => setContentsFor("")}>
        <section
          className="confirm-modal bases-inventory-contents-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="bases-inventory-contents-title"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="confirm-modal-title">
            <div>
              <h3 id="bases-inventory-contents-title">{openContainer.name || openContainer.typeName}</h3>
              <p className="bases-inventory-card-subtitle">
                {openContainer.name
                  ? `${openContainer.typeName} · #${openContainer.placeableId}`
                  : `#${openContainer.placeableId}`}
              </p>
            </div>
            <button ref={closeContentsRef} className="icon-action" aria-label="Close contents" onClick={() => setContentsFor("")}>
              <X size={18} />
            </button>
          </div>

          <dl className="bases-inventory-contents-summary">
            <div><dt>Slots Used</dt><dd>{openContainer.usedSlots.toLocaleString()} / {openContainer.maxSlots.toLocaleString()}</dd></div>
            <div><dt>Items</dt><dd>{openContainer.itemCount.toLocaleString()}</dd></div>
            <div><dt>Distinct</dt><dd>{openContainer.items.length.toLocaleString()}</dd></div>
          </dl>

          <div className="bases-inventory-contents-list">
            {openContainer.items.map((stack) => (
              <div className="bases-inventory-contents-row" key={stack.templateId}>
                <img src={itemImage(stack.templateId)} alt="" aria-hidden="true" />
                <span className="bases-inventory-contents-name" title={stack.templateId}>{stack.name}</span>
                <span className="bases-inventory-contents-qty">{stack.quantity.toLocaleString()}</span>
              </div>
            ))}
          </div>

          <div className="confirm-modal-actions">
            <button onClick={() => setContentsFor("")}>Close</button>
          </div>
        </section>
      </div>}
    </div>
  );
}
