import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Boxes, ChevronDown, ChevronRight, LayoutGrid, List, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import {
  CatalogItemThumb,
  ItemCatalogCombobox,
  ItemCatalogSelector,
  ItemGradeSelect,
  catalogItemMinimumGrade,
  loadFullCatalog,
  type CatalogItem
} from "../../components/common/ItemCatalog";
import { AugmentDropdown } from "../../components/common/AugmentDropdown";
import { augmentLimitForItem, filterAugmentsForItem, formatAugmentOptions, itemCanUseAugments } from "../../lib/augmentEligibility";
import { adminApi } from "../../api/admin";
import { GRID_CELL_CAP, layoutSlots } from "../inventory/slotLayout";
import {
  basesApi,
  type BaseContainerSlots,
  type BaseInventory,
  type BaseInventoryContainer,
  type BaseInventoryGroupKey,
  type BaseInventoryItem,
  type BaseInventorySlot
} from "../../api/bases";

// Mirrors FILLABLE_GROUPS in adminCatalog.js exactly -- both the Give and
// Fill comboboxes must never offer an item the server would reject anyway.
// Give was widened to this same restriction (issue #347 follow-up, per
// explicit operator direction) after a real catalog item -- "Robe of the
// Sisterhood" -- showed up in the Give combobox despite being clothing,
// not a raw/refined resource or component. This tab's Give action is
// deliberately scoped tighter than the older, standalone Storage tab's own
// Give Item action, which still accepts any catalog item unchanged.
const FILLABLE_GROUPS = new Set(["refined_resource", "component", "raw_resource"]);

type BaseInventoryTabProps = {
  baseId: string;
  baseName: string;
  onError: (message: string) => void;
  // Shape copied from BasePermissionsTab, which is what BasesPanel actually
  // passes -- it carries `warning`, which the non-storage delete needs.
  confirmAction: (message: string, options?: { title?: string; confirmLabel?: string; warning?: string; danger?: boolean; details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[] }) => Promise<boolean>;
};

type ContentsView = "list" | "grid";

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

export function BaseInventoryTab({ baseId, baseName, onError, confirmAction }: BaseInventoryTabProps) {
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
  // Slots for the open container only, fetched on open.
  const [slots, setSlots] = useState<BaseContainerSlots | null>(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState("");
  // Grid by default: the overlay's job is "what is actually in this box", and
  // the slot layout answers that at a glance. List is a click away, and is
  // still the automatic fallback for a container whose slots carry no usable
  // position_index or whose capacity is unusable.
  const [contentsView, setContentsView] = useState<ContentsView>("grid");
  const [deletingItemId, setDeletingItemId] = useState("");
  const [deleteNotice, setDeleteNotice] = useState("");
  // Separate from slotsError on purpose: that one means "the slots could not
  // be loaded" and hides the list behind a Retry. A delete that failed leaves
  // the list perfectly valid, so blanking it would lose the operator's place
  // over an error about one row.
  const [deleteError, setDeleteError] = useState("");
  // Selecting a slot moves its controls into one strip below the list/grid
  // rather than repeating a quantity input on every row -- a packed 100-slot
  // container would otherwise render a hundred of them.
  const [selectedSlotId, setSelectedSlotId] = useState("");
  const [amount, setAmount] = useState("");
  const slotsRequestIdRef = useRef(0);

  // Add-item panel (upstream's addBaseContainerItem UI). It replaces the slot
  // region rather than stacking under it: ItemCatalogSelector brings its own
  // ~300px of category select, filter and scrolling grid, and hanging that
  // below an already-scrolling slot list is what pushed the modal's own
  // actions off screen once before. Kept alongside this fork's own
  // Give/Fill panel below (issue #347) -- the two coexist as separate,
  // differently-named actions rather than one being replaced by the other;
  // see docs/console/base-inventory.md for the reconciliation record.
  const [addOpen, setAddOpen] = useState(false);
  const [addItem, setAddItem] = useState<CatalogItem | null>(null);
  const [addQuantity, setAddQuantity] = useState("1");
  const [addGrade, setAddGrade] = useState("0");
  const [addAugments, setAddAugments] = useState<string[]>([]);
  const [addAugmentGrade, setAddAugmentGrade] = useState("1");
  const [augmentCatalog, setAugmentCatalog] = useState<{ id: string; name: string }[]>([]);
  // Its own triad, for the same reason the delete's is separate from
  // slotsError: a failed add leaves the slot list perfectly valid, and hiding
  // it behind a Retry would lose the operator's place over one form's error.
  const [adding, setAdding] = useState(false);
  const [addNotice, setAddNotice] = useState("");
  const [addError, setAddError] = useState("");
  // Give/Fill/multi-delete are Storage-group only, same as the existing
  // single-item delete -- deliberately reusing deleteAllowed's "storage
  // group" gate rather than a second, looser check, so this new UI can
  // never enable an action the delete strip above would refuse.
  // giveAllowed intentionally does NOT require deleteSafety.safe: Give/Fill
  // are pure inserts (see server.js's baseContainerGiveItemRoute comment),
  // so they are gated on the storage-group check alone. deleteSafety.safe
  // is always true for a storage-group container as of 2026-08-19 (the
  // map-liveness check was removed -- see baseContainerDeleteSafety's own
  // comment in server.js), so deleteAllowed and giveFillAllowed are
  // functionally equivalent today, but deleteAllowed is kept reading
  // deleteSafety.safe rather than being simplified to match giveFillAllowed
  // exactly, so this stays a single, easy-to-find place to reintroduce a
  // real delete-specific gate if one is ever needed again.
  const giveFillAllowed = slots?.group === "storage";
  // Per explicit operator direction (issue #371, widened same day after an
  // operator-reported oversight): Give/Fill/Delete-Selected/Delete-All are
  // all powerful, destructive-or-item-creating capabilities, and an
  // operator who only wants to view a container's contents should not have
  // to see (or accidentally interact with) any of them every time a
  // container is opened. This toggle hides the whole Give/Fill panel --
  // item picker, quantity field, mode toggle, mode-hint, warning banner,
  // batch list, everything inside .bases-inventory-givefill-panel -- AND
  // the bulk-delete surface -- the per-row multi-select checkboxes plus the
  // Delete Selected / Delete All buttons themselves -- by default, per-open
  // (not persisted across closing/reopening the overlay or switching
  // containers, matching every other piece of this overlay's own
  // reset-on-open state, e.g. selectedSlotId/checkedItemIds). It does NOT
  // gate the single-item delete strip (the per-row trash icon, or the
  // selected-slot detail panel's own Remove/Delete stack button) -- that
  // was already one deliberate click on an already-visible item, not a
  // bulk or item-creating action, and stays exactly as exposed as it was
  // before this toggle existed. Turning this ON requires acknowledging an
  // explicit confirm dialog (see requestDestructiveControlsVisible below)
  // before it actually reveals anything -- turning it back OFF is instant,
  // no confirmation needed, since hiding a capability is never the risky
  // direction.
  const [destructiveControlsVisible, setDestructiveControlsVisible] = useState(false);
  const [checkedItemIds, setCheckedItemIds] = useState<Set<string>>(new Set());
  const [bulkDeleteRunning, setBulkDeleteRunning] = useState(false);
  // Give and Fill share one item picker and one quantity field, switched by
  // addFillMode -- consolidated 2026-08-19 after a real operator reported
  // the previous two-panel layout (a separate combobox+quantity+button row
  // for each of Give and Fill, stacked vertically) as confusing, especially
  // once Give and Fill were restricted to the same three item groups in the
  // same session, making the two rows show identical candidate items with
  // no explanation of when to use which. See the UI/UX hat's dispatched
  // design review (referenced in this session's PR/issue trail) for the
  // full diagnosis and the alternatives considered -- this implements its
  // explicit recommendation ("Alternative A"): one shared item+quantity
  // input, a Give/Fill mode toggle, and each mode's own secondary
  // affordance (Give's batch queue, Fill's capacity sentinel) revealed only
  // while that mode is selected, rather than both shown at once.
  const [addFillMode, setAddFillMode] = useState<"give" | "fill">("give");
  const [selectedItem, setSelectedItem] = useState<CatalogItem | null>(null);
  const [quantityText, setQuantityText] = useState("1");
  const [addRunning, setAddRunning] = useState(false);
  // Queued batch entries keep the item's real in-game name for display
  // (the batch list, and the confirm dialog below) alongside itemId, which
  // is all that ever reaches the server -- see giveItems(). Give-only --
  // Fill has no batch concept (one fill call always targets one item).
  const [addBatch, setAddBatch] = useState<{ itemName: string; itemId: string; quantity: number }[]>([]);
  const [fillRunning, setFillRunning] = useState(false);
  // Loaded once per mount (ItemCatalogCombobox loads and caches the same
  // full catalog independently, via loadFullCatalog()'s own module-level
  // cache -- this second call is a cache hit, not a second network
  // request) so a slot click can resolve that slot's templateId to a real
  // CatalogItem (for FILLABLE_GROUPS filtering and the combobox's own
  // name/image/group fields) without waiting on the combobox's own effect
  // to have already run.
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    void loadFullCatalog().then((loaded) => { if (!cancelled) setCatalog(loaded); });
    return () => { cancelled = true; };
  }, []);

  // CORRECTED 2026-08-19 (real operator report): switching modes used to
  // also clear selectedItem, on the theory that a selected item might not
  // be relevant in the other mode. That theory no longer holds -- Give and
  // Fill both filter to the exact same FILLABLE_GROUPS (Give was widened
  // to match Fill's restriction earlier this same session), so any item
  // valid in one mode is valid in the other. Clearing it just forced an
  // operator to re-search the same item after glancing at Fill and coming
  // back, which is exactly the "re-typing the item name" friction the
  // Give-more-from-a-slot work elsewhere in this file is trying to reduce.
  // selectedItem now persists across a mode switch; only the quantity
  // field resets to that mode's own default ("1" for Give, "100" for
  // Fill), since a half-typed Give quantity must still never be silently
  // submitted as a Fill quantity or vice versa. The Give batch itself is
  // also deliberately NOT cleared on a mode switch -- an operator queuing
  // items should be able to glance at Fill and switch back to Give without
  // losing progress.
  function selectAddFillMode(mode: "give" | "fill") {
    if (mode === addFillMode) return;
    setAddFillMode(mode);
    setQuantityText(mode === "fill" ? "100" : "1");
  }

  // Per explicit operator direction (issue #371, widened same day to also
  // cover bulk delete -- see destructiveControlsVisible's own comment
  // above): turning this toggle ON requires acknowledging an explicit
  // warning first. The warning covers BOTH capabilities it now gates --
  // the pre-existing restart-visibility fact for Give/Fill (see
  // INC-2026-07-31-001) plus an actionable Daily Restart recommendation,
  // AND a new sentence stating plainly that Delete Selected/Delete All are
  // irreversible, since a single toggle now controls both an insert-only
  // and a destructive capability and an operator must not be able to
  // mistake one warning for having covered both risks. Turning it back OFF
  // is instant and asks nothing -- hiding a capability is never the risky
  // direction, only revealing it is. Cancelling leaves
  // destructiveControlsVisible unset, matching every other confirmAction()
  // call in this file that no-ops on cancel rather than partially applying
  // a change.
  //
  // Returns whether the controls ended up visible -- callers that need to
  // act immediately after (e.g. selectSlotForGiveFill pre-filling an item)
  // must use this return value, not read destructiveControlsVisible itself
  // right after calling this: setDestructiveControlsVisible is an async
  // state update, so the enclosing closure's own destructiveControlsVisible
  // would still read the pre-call value until the next render.
  async function requestDestructiveControlsVisible(): Promise<boolean> {
    if (destructiveControlsVisible) return true;
    const confirmed = await confirmAction(
      "Given and filled items are inserted directly into the database and are NOT visible in-game until the Survival server restarts -- there is no way to make them appear without one. Strongly consider configuring an automated Daily Restart from Admin Tools \u2192 Schedule Server Restart \u2192 Daily Restart before relying on Give/Fill regularly, so given/filled items do not sit invisible indefinitely. Delete Selected and Delete All are also revealed by this toggle -- both permanently destroy items from the database with no undo.",
      {
        title: "Show Give / Fill / Delete Controls",
        confirmLabel: "Show Controls",
        warning: "Fill also carries a separate, documented risk: while the owning map stays running, a filled item can land on the same slot a live in-game move/pickup claims at the same time, and the row that loses that race is permanently orphaned on the next restart. See the Base Inventory documentation for details."
      }
    );
    if (!confirmed) return false;
    setDestructiveControlsVisible(true);
    return true;
  }

  function toggleDestructiveControlsVisible() {
    if (destructiveControlsVisible) {
      setDestructiveControlsVisible(false);
      return;
    }
    void requestDestructiveControlsVisible();
  }

  // Per explicit operator direction (2026-08-19): clicking an item already
  // in the container also populates the shared Give/Fill combobox with
  // that same item, so giving more of something already sitting in the
  // container does not require re-typing/re-searching its name. Reuses
  // this same click -- it does not add a second, separate click target --
  // so it fires alongside the existing "select this slot for the delete
  // strip" behavior every slot click already has.
  //
  // Resolved against the real catalog (not fabricated from the slot's own
  // name/templateId alone) so the populated selection carries the same
  // real group/image fields the combobox itself relies on. Silently a
  // no-op if the item is not in FILLABLE_GROUPS (e.g. a weapon or
  // schematic) or is not present in the loaded catalog at all -- the
  // combobox could never have accepted that item either, and the existing
  // delete-strip selection this click also performs is unaffected either
  // way.
  //
  // Deliberately does NOT touch addFillMode or quantityText: the item
  // populates whichever mode (Give or Fill) is currently active, and the
  // quantity field is left exactly as the operator last set it -- clicking
  // a slot is a shortcut for "pick this item," not "also decide how many
  // and submit," matching how choosing an item from the combobox itself
  // behaves.
  //
  // If the Give/Fill panel is currently hidden (issue #371's visibility
  // toggle, default off), clicking a slot reveals it -- through the same
  // confirm-and-warn path the toggle button itself uses, not a silent
  // bypass -- with that slot's item already pre-filled, rather than
  // silently no-op'ing on the populate step. This was an explicit open
  // question in issue #371; revealing is the more useful behavior (the
  // operator's click already states clear intent to give/fill this
  // specific item) and is consistent with the toggle itself always
  // requiring the same acknowledgment before the panel becomes visible.
  async function selectSlotForGiveFill(slot: { templateId: string }) {
    if (!giveFillAllowed) return;
    const match = catalog.find((item) => (item.itemId || item.id) === slot.templateId);
    if (!match || !match.group || !FILLABLE_GROUPS.has(match.group)) return;
    // requestDestructiveControlsVisible() shows the same confirm-and-warn
    // dialog the toggle button uses when the panel is currently hidden --
    // if the operator cancels, the item must not be pre-filled into a
    // panel that never actually became visible.
    const visible = await requestDestructiveControlsVisible();
    if (!visible) return;
    setSelectedItem(match);
  }

  // Only the newest request may write state. StrictMode double-invokes this
  // effect, so two requests really are open at once here, and whichever settles
  // last wins -- a first attempt that fails after a second one succeeded would
  // otherwise replace good data with an error banner. Same requestIdRef pattern
  // BasesPanel uses for its own overlapping loads.
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setLoadError("");
    try {
      const result = await basesApi.inventory(baseId);
      if (requestIdRef.current !== requestId) return;
      setData(result);
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setLoadError(errorText(error));
    } finally {
      // Left to the newest request too, so an early finisher cannot clear the
      // spinner while the request that will actually fill the tab is open.
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [baseId]);

  useEffect(() => { void load(); }, [load]);

  const term = submittedQ.trim().toLowerCase();

  const items = useMemo(() => {
    if (!data) return [] as BaseInventoryItem[];
    return data.items
      // Filtering by group re-derives the quantity from the surviving
      // containers -- showing the base-wide total under a group chip would
      // claim stock the group does not hold.
      .map((item) => {
        if (group === "all") return item;
        const containers = item.containers.filter((holder) => holder.group === group);
        return {
          ...item,
          containers,
          quantity: containers.reduce((total, holder) => total + holder.quantity, 0),
          containerCount: containers.length
        };
      })
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

  // Re-resolved from the current slots rather than held as an object, so a
  // refetch after a partial delete updates the strip's quantity instead of
  // leaving it showing the pre-delete stack.
  const selectedSlot = useMemo(() => {
    if (!selectedSlotId || !slots?.inventories) return null;
    for (const inventory of slots.inventories) {
      const found = inventory.slots.find((slot) => slot.itemId === selectedSlotId);
      if (found) return found;
    }
    return null;
  }, [selectedSlotId, slots]);

  // Note: Grid view is silently unavailable for a container whose
  // max_item_count exceeds GRID_CELL_CAP (e.g. the 1000-slot Developer
  // Storage Container used for testing on dune-dev) -- clicking Grid does
  // nothing visible in that case, staying on List instead. Confirmed as a
  // real gap (2026-08-19) but explicitly deprioritized: this only affects
  // oversized dev/test containers no real operator is expected to use, so
  // no fix was made here. Revisit if a real container this large is ever
  // ordinarily used by a real player/operator, not the dev containers this
  // was found on.

  // The server rejects an over-count rather than clearing the slot, so this is
  // a courtesy check, not the guard.
  const amountNumber = Number(amount);
  const amountValid = Boolean(selectedSlot)
    && Number.isInteger(amountNumber)
    && amountNumber >= 1
    && amountNumber <= (selectedSlot?.quantity ?? 0);
  const deleteAllowed = slots?.group === "storage" && slots?.deleteSafety?.safe === true;
  // deleteSafety.safe is always true for a storage-group container as of
  // 2026-08-19 (baseContainerDeleteSafety's map-liveness check was removed
  // -- see its own comment in server.js and "Deletion does not require a
  // stopped map" in docs/console/base-inventory.md). The branch below that
  // reads slots.deleteSafety?.reason is therefore currently unreachable in
  // practice for a storage-group container, but is kept rather than
  // removed: it is the one place this UI would surface a future,
  // real delete-specific restriction if baseContainerDeleteSafety ever
  // grows one again, and its "Giving and filling items are unaffected"
  // clause (added during PR #349's own Layer 3 audit, UI hat -- an
  // operator reading a delete-restriction message with a fully
  // interactive Give/Fill panel a few lines below had no way to tell that
  // was deliberate) stays correct regardless of what that future
  // restriction turns out to be, since Give/Fill only ever insert new rows.
  const deleteUnavailableReason = slots?.found && !deleteAllowed
    ? slots.group !== "storage"
      ? "Item deletion is available only for Storage containers. Crafting and Refining contents are read-only to protect active jobs."
      : `${slots.deleteSafety?.reason || "Item deletion is unavailable for this container."}${giveFillAllowed ? " Giving and filling items are unaffected -- they only add rows." : ""}`
    : "";
  // Delete Selected/Delete All (and the per-row multi-select checkboxes that
  // feed Delete Selected) additionally require destructiveControlsVisible
  // (issue #371, widened same day -- see its own comment above) -- unlike
  // the single-item delete strip (the per-row trash icon, and the
  // selected-slot detail panel's Remove/Delete stack button), which stays
  // gated on deleteAllowed alone and is NOT hidden by this toggle. This was
  // an explicit oversight fix: bulk delete previously rendered whenever
  // deleteAllowed was true regardless of the toggle, defeating the
  // toggle's own "an operator who only wants to view a container's
  // contents should not have to see a destructive control" purpose for
  // every container that permitted deletion at all.
  const bulkDeleteAllowed = deleteAllowed && destructiveControlsVisible;

  // Same shape and the same fail-closed default as the delete gate above. The
  // server re-checks this immediately before the write regardless.
  const addAllowed = slots?.group === "storage" && slots?.addSafety?.safe === true;
  const addUnavailableReason = slots?.found && !addAllowed
    ? slots.group !== "storage"
      ? "Adding items is available only for Storage containers. Crafting and Refining contents are read-only to protect active jobs."
      : slots.addSafety?.reason || "Adding items is unavailable for this container."
    : "";
  // Read off the open container rather than the safety object -- capacity is a
  // property of the box, not of whether its map is stopped.
  const containerFull = Boolean(openContainer) && openContainer!.maxSlots > 0
    && openContainer!.usedSlots >= openContainer!.maxSlots;
  const containerFullReason = containerFull && openContainer
    ? `This container is full (${openContainer.usedSlots.toLocaleString()} / ${openContainer.maxSlots.toLocaleString()} slots). Delete an item to make room.`
    : "";

  const addItemMeta = addItem
    ? { templateId: addItem.itemId || addItem.id, category: addItem.category || "", source: addItem.source || "" }
    : null;
  const addAugmentLimit = addItemMeta ? augmentLimitForItem(addItemMeta) : 0;
  const addAugmentOptions = addItemMeta && itemCanUseAugments(addItemMeta)
    ? formatAugmentOptions(filterAugmentsForItem(addItemMeta, augmentCatalog), addAugmentGrade)
    : [];
  const addQuantityNumber = Number(addQuantity);
  const addQuantityValid = Number.isInteger(addQuantityNumber)
    && addQuantityNumber >= 1
    && addQuantityNumber <= 1000000;

  // Only paid for by an operator who actually opens the add panel -- the
  // catalog fetch is the full 10k-row list.
  useEffect(() => {
    if (!addOpen || augmentCatalog.length > 0) return;
    let cancelled = false;
    adminApi.itemCatalog("", 10000).then((result) => {
      if (cancelled) return;
      setAugmentCatalog((result.rows || []).filter((item) =>
        (item.category || "").toLowerCase().includes("augment") ||
        (item.source || "").toLowerCase() === "augments"
      ).map((item) => ({ id: item.itemId || item.id, name: item.name })));
    }).catch(() => { if (!cancelled) setAugmentCatalog([]); });
    return () => { cancelled = true; };
  }, [addOpen, augmentCatalog.length]);

  function resetAddForm() {
    setAddItem(null);
    setAddQuantity("1");
    setAddGrade("0");
    setAddAugments([]);
    setAddAugmentGrade("1");
    setAddError("");
  }

  // The add panel and the slot-detail strip are two modes of one dialog, not
  // two panels: the strip is keyed to an existing occupied slot and cannot
  // represent an add, so opening either closes the other.
  function openAddPanel() {
    setSelectedSlotId("");
    setAmount("");
    setAddNotice("");
    setAddError("");
    setAddOpen(true);
  }

  function selectSlot(slot: BaseInventorySlot) {
    setAddOpen(false);
    setSelectedSlotId(slot.itemId);
    setAmount(String(slot.quantity));
  }

  // A slot that vanished (deleted, or moved by a player between refetches)
  // must not leave a stale strip pointing at an id the server no longer has.
  useEffect(() => {
    if (selectedSlotId && slots && !selectedSlot) {
      setSelectedSlotId("");
      setAmount("");
    }
  }, [selectedSlotId, slots, selectedSlot]);

  // Same newest-request-wins guard as load(): reopening a different container
  // before the first response lands must not paint the wrong container's slots.
  const loadSlots = useCallback(async (placeableId: string) => {
    const requestId = ++slotsRequestIdRef.current;
    setSlotsLoading(true);
    setSlotsError("");
    try {
      const result = await basesApi.containerSlots(baseId, placeableId);
      if (slotsRequestIdRef.current !== requestId) return;
      setSlots(result);
    } catch (error) {
      if (slotsRequestIdRef.current !== requestId) return;
      setSlotsError(errorText(error));
    } finally {
      if (slotsRequestIdRef.current === requestId) setSlotsLoading(false);
    }
  }, [baseId]);

  useEffect(() => {
    if (!contentsFor) {
      // Invalidates a request that was still in flight when the overlay
      // closed, the same way opening a different container does -- closing
      // is itself a reason the response no longer matters, even though
      // nothing currently renders slots while contentsFor is empty.
      slotsRequestIdRef.current += 1;
      setSlots(null);
      setSlotsError("");
      setDeleteNotice("");
      setDeleteError("");
      setSelectedSlotId("");
      setAmount("");
      setAddOpen(false);
      setAddNotice("");
      resetAddForm();
      setCheckedItemIds(new Set());
      setAddFillMode("give");
      setSelectedItem(null);
      setQuantityText("1");
      setAddBatch([]);
      setDestructiveControlsVisible(false);
      return;
    }
    setSelectedSlotId("");
    setAmount("");
    setDeleteError("");
    // A half-filled form must not carry over to a different container: the
    // capacity, the gate and the confirm dialog's "Container" line all change.
    setAddOpen(false);
    setAddNotice("");
    resetAddForm();
    setCheckedItemIds(new Set());
    setDestructiveControlsVisible(false);
    void loadSlots(contentsFor);
  }, [contentsFor, loadSlots]);

  // Matches ConfirmDialog: Escape closes, and focus moves to the close button
  // so the overlay is reachable without a mouse.
  useEffect(() => {
    if (!openContainer) return undefined;
    closeContentsRef.current?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      // ConfirmDialog listens on window too, so a single Escape reached both
      // and cancelling a delete confirmation also tore down the overlay behind
      // it, losing the operator's place. When a second modal is stacked on
      // top, let it take the key and leave this one open.
      if (document.querySelectorAll(".confirm-modal").length > 1) return;
      setContentsFor("");
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [openContainer]);

  function applySearch(next: string) {
    setSubmittedQ(next);
    setExpandedItem("");
    setShowAllItems(false);
  }

  async function deleteSlot(slot: BaseInventorySlot, amount: number, containerName: string) {
    if (!deleteAllowed) {
      const text = deleteUnavailableReason || "Item deletion is unavailable for this container.";
      setDeleteError(text);
      onError(text);
      return;
    }
    const whole = amount >= slot.quantity;
    const confirmed = await confirmAction(
      whole ? "Delete this item from the container?" : "Remove part of this stack?",
      {
        title: whole ? "Delete Stored Item" : "Remove From Stack",
        confirmLabel: whole ? "Delete" : "Remove",
        danger: true,
        details: [
          { label: "Base", value: baseName },
          { label: "Container", value: containerName, tone: "accent" },
          { label: "Slot", value: slot.positionIndex === null ? "—" : `#${slot.positionIndex}` },
          {
            label: whole ? "Item" : "Removing",
            value: whole
              ? `${slot.name} ×${slot.quantity.toLocaleString()}`
              : `${amount.toLocaleString()} of ${slot.quantity.toLocaleString()} ${slot.name}`,
            tone: "danger"
          }
        ]
      }
    );
    if (!confirmed) return;
    setDeletingItemId(slot.itemId);
    setDeleteNotice("");
    setDeleteError("");
    try {
      const response = await basesApi.deleteContainerItem(
        baseId, contentsFor, slot.itemId, "DELETE ITEM", whole ? undefined : amount);
      const result = response.result;
      if (!response.supported || !result?.ok) {
        throw new Error(response.error || response.reason || "The item could not be deleted.");
      }
      setDeleteNotice(result.message);
      // A whole-slot delete removes the slot entirely, so the vanished-slot
      // effect below clears amount once the refetch lands. A partial delete
      // leaves the same slot selected with a smaller stack, and that effect
      // does not fire for it -- left alone, the stale (larger) amount would
      // exceed the new quantity on the very next render and immediately show
      // the "enter an amount" error on what was actually a successful delete.
      if (result.partial) setAmount(String(result.removed.remaining));
      // Refetch both: the slot list for this container, and the tab totals,
      // group counts and rollup, all of which the delete just invalidated.
      await Promise.all([loadSlots(contentsFor), load()]);
    } catch (error) {
      const text = errorText(error);
      setDeleteError(text);
      onError(text);
    } finally {
      setDeletingItemId("");
    }
  }

  async function addToContainer(containerName: string) {
    if (!addAllowed) {
      const text = addUnavailableReason || "Adding items is unavailable for this container.";
      setAddError(text);
      onError(text);
      return;
    }
    if (!addItem || !addQuantityValid) return;
    const augmentNames = addAugments
      .map((id) => augmentCatalog.find((entry) => entry.id === id)?.name || id);
    const confirmed = await confirmAction("Add this item to the container?", {
      title: "Add Item to Container",
      confirmLabel: "Add",
      details: [
        { label: "Base", value: baseName },
        { label: "Container", value: containerName, tone: "accent" },
        { label: "Item", value: `${addItem.name} ×${addQuantityNumber.toLocaleString()}`, tone: "success" },
        { label: "Grade", value: addGrade },
        ...(augmentNames.length > 0 ? [{ label: "Augments", value: augmentNames.join(", ") }] : []),
        // The last place the operator sees the placement rule, and it has to
        // stay honest: the server appends, and no slot was ever reserved.
        { label: "Slot", value: "Next free slot" }
      ]
    });
    if (!confirmed) return;
    setAdding(true);
    setAddNotice("");
    setAddError("");
    try {
      const response = await basesApi.addContainerItem(baseId, contentsFor, {
        itemId: addItem.itemId || addItem.id,
        quantity: addQuantityNumber,
        quality: Number(addGrade) || 0,
        augments: addAugments,
        augmentQuality: Number(addAugmentGrade) || 1
      }, "ADD ITEM TO CONTAINER");
      const result = response.result;
      if (!response.supported || !result?.ok) {
        throw new Error(response.error || response.reason || "The item could not be added.");
      }
      setAddNotice(result.message);
      setAddOpen(false);
      resetAddForm();
      // Same pair the delete refetches: this container's slots, and the tab's
      // totals, group counts and rollup, all of which the add invalidated.
      await Promise.all([loadSlots(contentsFor), load()]);
    } catch (error) {
      const text = errorText(error);
      setAddError(text);
      onError(text);
    } finally {
      setAdding(false);
    }
  }
  function toggleChecked(itemId: string) {
    setCheckedItemIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  }

  async function deleteCheckedItems(containerName: string) {
    if (!deleteAllowed || checkedItemIds.size === 0) return;
    const ids = [...checkedItemIds];
    const confirmed = await confirmAction(
      `Delete ${ids.length} selected item${ids.length === 1 ? "" : "s"} from the container?`,
      {
        title: "Delete Selected Items",
        confirmLabel: "Delete",
        danger: true,
        details: [
          { label: "Base", value: baseName },
          { label: "Container", value: containerName, tone: "accent" },
          { label: "Items", value: `${ids.length} stack${ids.length === 1 ? "" : "s"}`, tone: "danger" }
        ]
      }
    );
    if (!confirmed) return;
    setBulkDeleteRunning(true);
    setDeleteNotice("");
    setDeleteError("");
    try {
      const response = await basesApi.deleteContainerItems(baseId, contentsFor, ids, "DELETE ITEMS");
      const result = response.result;
      if (!response.supported || !result?.ok) {
        throw new Error(response.error || response.reason || "The selected items could not be deleted.");
      }
      setDeleteNotice(result.message);
      setCheckedItemIds(new Set());
      await Promise.all([loadSlots(contentsFor), load()]);
    } catch (error) {
      const text = errorText(error);
      setDeleteError(text);
      onError(text);
    } finally {
      setBulkDeleteRunning(false);
    }
  }

  async function deleteAllItems(containerName: string, itemCount: number) {
    if (!deleteAllowed || itemCount === 0) return;
    const confirmed = await confirmAction(
      `Delete every item currently in this container?`,
      {
        title: "Delete All Items",
        confirmLabel: "Delete All",
        danger: true,
        details: [
          { label: "Base", value: baseName },
          { label: "Container", value: containerName, tone: "accent" },
          { label: "Items", value: `All ${itemCount.toLocaleString()} stack${itemCount === 1 ? "" : "s"}`, tone: "danger" }
        ]
      }
    );
    if (!confirmed) return;
    setBulkDeleteRunning(true);
    setDeleteNotice("");
    setDeleteError("");
    try {
      const response = await basesApi.deleteAllContainerItems(baseId, contentsFor, "DELETE ALL ITEMS");
      const result = response.result;
      if (!response.supported || !result?.ok) {
        throw new Error(response.error || response.reason || "The container could not be cleared.");
      }
      setDeleteNotice(result.message);
      setCheckedItemIds(new Set());
      await Promise.all([loadSlots(contentsFor), load()]);
    } catch (error) {
      const text = errorText(error);
      setDeleteError(text);
      onError(text);
    } finally {
      setBulkDeleteRunning(false);
    }
  }

  function selectedQuantity() {
    return Math.max(1, Math.min(1000000, Number(quantityText) || 1));
  }

  // Queues the currently-selected item into the batch rather than giving it
  // immediately -- lets an operator add several distinct templates and
  // confirm them all in one give-items call, matching giveMultipleItemsToStorage's
  // "one transaction, all or nothing" batch semantics on the backend.
  // Give-only -- only rendered/reachable while addFillMode === "give".
  function queueAddItem() {
    if (!selectedItem) return;
    setAddBatch((current) => [...current, { itemName: selectedItem.name, itemId: selectedItem.itemId || selectedItem.id, quantity: selectedQuantity() }]);
    setSelectedItem(null);
    setQuantityText("1");
  }

  function removeQueuedItem(index: number) {
    setAddBatch((current) => current.filter((_, i) => i !== index));
  }

  async function giveItems(containerName: string) {
    if (!giveFillAllowed) return;
    // A single selected-but-not-yet-queued item is folded in at confirm
    // time -- an operator should not have to click "Add to batch" before
    // giving just one item.
    const pending = selectedItem
      ? [...addBatch, { itemName: selectedItem.name, itemId: selectedItem.itemId || selectedItem.id, quantity: selectedQuantity() }]
      : addBatch;
    if (pending.length === 0) return;
    const confirmed = await confirmAction(
      pending.length === 1
        ? `Give ${pending[0].quantity} x ${pending[0].itemName} to this container?`
        : `Give ${pending.length} distinct items to this container?`,
      {
        title: "Give Item" + (pending.length === 1 ? "" : "s"),
        confirmLabel: "Give",
        details: [
          { label: "Base", value: baseName },
          { label: "Container", value: containerName, tone: "accent" },
          ...pending.map((item) => ({ label: item.itemName, value: `x${item.quantity.toLocaleString()}` }))
        ]
      }
    );
    if (!confirmed) return;
    setAddRunning(true);
    setDeleteNotice("");
    setDeleteError("");
    try {
      if (pending.length === 1) {
        const response = await basesApi.giveContainerItem(baseId, contentsFor, { itemId: pending[0].itemId, quantity: pending[0].quantity, confirmation: "GIVE ITEM TO STORAGE" });
        if (!response.supported || !response.result?.ok) {
          throw new Error(response.error || response.reason || "The item could not be given.");
        }
        // Never rejected outright -- a request exceeding remaining volume
        // is clamped to whatever fits (issue #347 follow-up). The
        // clamped case is reported plainly rather than claiming the full
        // requested amount was given when it was not.
        const { given, requested, clamped, clampReason } = response.result;
        // "stack-rows" = only the runaway row backstop stopped it (the
        // container has room) -- saying it "fit" would be false. See the
        // fill handler's matching note.
        setDeleteNotice(clamped
          ? (clampReason === "stack-rows"
            ? `${given.toLocaleString()} of the requested ${requested.toLocaleString()} x ${pending[0].itemName} was given -- stopped at the per-operation stack cap, not because the container is full; run Give again to add more.`
            : `Only ${given.toLocaleString()} of the requested ${requested.toLocaleString()} x ${pending[0].itemName} fit and was given to the container.`)
          : `${pending[0].itemName} was given to the container.`);
      } else {
        const response = await basesApi.giveContainerItems(baseId, contentsFor, pending, "GIVE ITEMS TO STORAGE");
        if (!response.supported || !response.result?.ok) {
          throw new Error(response.error || response.reason || "The items could not be given.");
        }
        // A batch never throws on hitting a capacity limit either -- it
        // stops there, and every requested item appears in results
        // (attempted or not). Summarize exactly what happened rather than
        // claiming uniform success when the batch may have stopped partway.
        const results = response.result.results;
        const stoppedAt = results.find((entry) => entry.clamped || (entry.attempted && entry.given === 0));
        setDeleteNotice(stoppedAt
          ? `${results.filter((entry) => entry.given > 0).length} of ${results.length} items were given before the batch stopped at ${stoppedAt.templateId}${stoppedAt.given > 0 ? ` (partially, ${stoppedAt.given.toLocaleString()} of ${stoppedAt.requested.toLocaleString()})` : ""}.`
          : `${pending.length} items were given to the container.`);
      }
      setAddBatch([]);
      setSelectedItem(null);
      setQuantityText("1");
      await Promise.all([loadSlots(contentsFor), load()]);
    } catch (error) {
      const text = errorText(error);
      setDeleteError(text);
      onError(text);
    } finally {
      setAddRunning(false);
    }
  }

  // toCapacity sends quantity: 0, a real sentinel fillItemToStorage
  // (duneDb.js) already supports -- it computes the largest stack that
  // fits in whatever volume remains and inserts exactly that, in one call,
  // rather than requiring the operator to guess a number and retry on a
  // "storage is full by volume" rejection. Found unreachable from any UI
  // during manual review (issue #347): the standalone Storage tab and this
  // tab's own quantity field both clamp to a minimum of 1, so the backend's
  // own capability had no way to be invoked. Fixed by exposing it as its
  // own explicit action -- "Fill to Capacity" -- rather than overloading
  // the quantity field with a special "0 means max" meaning a operator
  // would have no way to discover on their own.
  async function submitFill(containerName: string, toCapacity = false) {
    if (!giveFillAllowed || !selectedItem) return;
    const quantity = toCapacity ? 0 : selectedQuantity();
    const confirmed = await confirmAction(
      toCapacity
        ? `Fill container with as much ${selectedItem.name} as fits in its remaining volume? Only raw resources, refined resources, and components are allowed.`
        : `Fill container with ${quantity} x ${selectedItem.name}? Only raw resources, refined resources, and components are allowed.`,
      {
        title: "Fill Container",
        confirmLabel: "Fill",
        details: [
          { label: "Base", value: baseName },
          { label: "Container", value: containerName, tone: "accent" },
          { label: selectedItem.name, value: toCapacity ? "As much as fits" : `x${quantity.toLocaleString()}` }
        ]
      }
    );
    if (!confirmed) return;
    setFillRunning(true);
    setDeleteNotice("");
    setDeleteError("");
    try {
      const response = await basesApi.fillContainerItem(baseId, contentsFor, { itemId: selectedItem.itemId || selectedItem.id, quantity, confirmation: "FILL ITEM TO STORAGE" });
      if (!response.supported || !response.result?.ok) {
        throw new Error(response.error || response.reason || "The container could not be filled.");
      }
      // Never rejected outright -- Fill Amount is clamped to whatever fits
      // (issue #347 follow-up), the same way Give already is; the message
      // must report the real given amount rather than always claiming the
      // requested quantity succeeded, which was the exact bug reported
      // manually against this feature ("Fill Container said it filled 100
      // when only 100 of a larger request fit -- and separately, sending
      // 100 when the operator meant 'fill it up' at all").
      const { given, clamped, clampReason } = response.result;
      const filledName = selectedItem.name;
      // clampReason "stack-rows" means only the per-operation stack-row cap
      // stopped the fill -- the container still has room, so claiming
      // "(as much as fit)" or "fit" would be false and would steer the
      // operator away from the correct recovery: running the action again
      // (issue #430 L2 audit, UI hat).
      const stackRowCapped = clamped && clampReason === "stack-rows";
      setDeleteNotice(toCapacity
        ? (stackRowCapped
          ? `${given.toLocaleString()} x ${filledName} was filled into the container -- stopped at the per-operation stack cap, not because the container is full; run Fill again to add more.`
          : `${given.toLocaleString()} x ${filledName} was filled into the container (as much as fit).`)
        : clamped
          ? (stackRowCapped
            ? `${given.toLocaleString()} of the requested ${quantity.toLocaleString()} x ${filledName} was filled -- stopped at the per-operation stack cap, not because the container is full; run Fill again to add more.`
            : `Only ${given.toLocaleString()} of the requested ${quantity.toLocaleString()} x ${filledName} fit and was filled into the container.`)
          : `${filledName} was filled into the container.`);
      setSelectedItem(null);
      setQuantityText("100");
      await Promise.all([loadSlots(contentsFor), load()]);
    } catch (error) {
      const text = errorText(error);
      setDeleteError(text);
      onError(text);
    } finally {
      setFillRunning(false);
    }
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
  // A settled answer, not a failure: this database cannot back the tab, so it
  // gets a plain statement and no Retry -- the request would fail identically
  // every time. Genuine failures still land in the branch above, where Retry
  // means something.
  if (!data.supported) {
    return <p className="muted" role="status">
      {data.reason || "Base inventory is unsupported by the detected schema."}
    </p>;
  }

  const { totals } = data;
  const slotPercent = totals.maxSlots > 0 ? Math.round((totals.usedSlots / totals.maxSlots) * 100) : 0;
  // maxVolume is 0 on a schema without dune.inventories.max_item_volume /
  // dune.items.volume_override (issue #356) -- "—" rather than "0%" so an
  // operator does not mistake "not tracked here" for "completely full".
  const volumePercent = totals.maxVolume > 0 ? Math.round((totals.currentVolume / totals.maxVolume) * 100) : 0;
  const visibleItems = showAllItems ? items : items.slice(0, ITEM_PREVIEW_LIMIT);

  return (
    <div className="bases-inventory" onClick={(event) => event.stopPropagation()}>
      <div className="bases-tab-body">
        {/* Stated before the data rather than after it: it governs how to read
            everything below, and at the foot of a 27-card list it was never
            seen.

            CORRECTED 2026-08-19 (real drift caught during a documentation
            review, see docs/console/base-inventory.md's "Deletion does not
            require a stopped map" section): this copy previously said
            deletion required a stopped map, which stopped being true when
            baseContainerDeleteSafety's map-liveness check was removed
            earlier this same session -- deletion, Give, and Fill are all
            equally unaffected by whether the map is running today. */}
        <p className="bases-inventory-note muted">
          A database snapshot, not a live view. Adding an item via "Add Item to Container" requires the owning map to be safely stopped first; Give, Fill, and deletion do not, but none of these changes are reflected in-game until the Survival server restarts.
        </p>

        {/* summary-stats/summary-stat are the app's stat tiles, shared with
            the player summary, so these read as boxes like everywhere else. */}
        <dl className="bases-inventory-totals summary-stats">
          <div className="summary-stat"><dt>Items</dt><dd>{totals.items.toLocaleString()}</dd></div>
          <div className="summary-stat"><dt>Distinct</dt><dd>{totals.distinct.toLocaleString()}</dd></div>
          <div className="summary-stat"><dt>Containers</dt><dd>{totals.containers.toLocaleString()}</dd></div>
          <div className="summary-stat"><dt>Slots used</dt><dd>{totals.maxSlots > 0 ? `${slotPercent}%` : "—"}</dd></div>
          <div className="summary-stat">
            <dt>{totals.volumeComplete === false ? "Known volume" : "Volume used"}</dt>
            <dd>{totals.maxVolume > 0 ? `${totals.volumeComplete === false ? "≥" : ""}${volumePercent}%` : "—"}</dd>
          </div>
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
                                <span className="bases-inventory-breakdown-actions">
                                  {holder.quantity.toLocaleString()}
                                  {/* Same label and icon as the container
                                      cards': one action, one name for it,
                                      wherever a container is listed. */}
                                  <button
                                    className="bases-inventory-view-contents compact"
                                    onClick={() => setContentsFor(holder.placeableId)}
                                  >
                                    <Boxes size={13} aria-hidden="true" />
                                    View Contents
                                  </button>
                                </span>
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
                          // maxVolume is 0 on a schema without volume tracking
                          // (issue #356) -- the row is withheld entirely
                          // rather than shown as a misleading 0/0 or 0%.
                          const volumePercent = container.maxVolume > 0
                            ? Math.round((container.currentVolume / container.maxVolume) * 100)
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
                                {container.maxVolume > 0 && <>
                                  <dt>{container.volumeComplete === false ? "Known Volume" : "Volume Used"}</dt>
                                  <dd>
                                    <div className="progress-row">
                                      <div className="progress-track">
                                        <div className="progress-fill" style={{ width: `${Math.min(100, volumePercent)}%` }} />
                                      </div>
                                      <span>{container.volumeComplete === false ? "≥" : ""}{container.currentVolume.toFixed(1)} / {container.maxVolume.toFixed(1)}</span>
                                    </div>
                                  </dd>
                                </>}
                                <dt>Items</dt>
                                <dd>{container.itemCount.toLocaleString()}</dd>
                                {/* Label hidden but not removed: the row keeps
                                    the same height as every other stat, and
                                    the button below already says what it is. */}
                                <dt className="bases-inventory-spacer-label" aria-hidden="true">Contents</dt>
                                <dd>
                                  {/* Always a real button, even for an empty container
                                      (issue #347's own manual UI review) -- an empty
                                      Storage container is exactly the case an operator
                                      most needs to open, to Give/Fill something into it.
                                      The old "Empty" bare-text state had no click target
                                      at all, making an empty container permanently
                                      unreachable through this card. */}
                                  <button
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
                                      {container.items.length > 0 ? `${container.items.length.toLocaleString()} distinct` : "Empty"}
                                    </span>
                                  </button>
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
            <div className="bases-inventory-contents-head-actions">
              <div className="bases-inventory-views" role="group" aria-label="Contents view">
                <button
                  className={`bases-inventory-view${contentsView === "list" ? " active" : ""}`}
                  aria-pressed={contentsView === "list"}
                  onClick={() => setContentsView("list")}
                ><List size={14} aria-hidden="true" /> List</button>
                <button
                  className={`bases-inventory-view${contentsView === "grid" ? " active" : ""}`}
                  aria-pressed={contentsView === "grid"}
                  onClick={() => setContentsView("grid")}
                ><LayoutGrid size={14} aria-hidden="true" /> Grid</button>
              </div>
              <button ref={closeContentsRef} className="icon-action" aria-label="Close contents" onClick={() => setContentsFor("")}>
                <X size={18} />
              </button>
            </div>
          </div>

          <dl className="bases-inventory-contents-summary">
            <div><dt>Slots Used</dt><dd>{openContainer.usedSlots.toLocaleString()} / {openContainer.maxSlots.toLocaleString()}</dd></div>
            {/* Withheld on a schema without volume tracking (issue #356),
                same as the container card's own Volume Used row. */}
            {openContainer.maxVolume > 0 && <div>
              <dt>{openContainer.volumeComplete === false ? "Known Volume" : "Volume Used"}</dt>
              <dd>{openContainer.volumeComplete === false ? "≥" : ""}{openContainer.currentVolume.toFixed(1)} / {openContainer.maxVolume.toFixed(1)}</dd>
            </div>}
            <div><dt>Items</dt><dd>{openContainer.itemCount.toLocaleString()}</dd></div>
            {/* Distinct templates, not stacks -- the count below the list is
                the stack count, and the two differ whenever a template
                occupies more than one slot. */}
            <div><dt>Distinct</dt><dd>{openContainer.items.length.toLocaleString()}</dd></div>
          </dl>

          {slotsLoading && <p className="muted" role="status">Loading slots…</p>}
          {slotsError && <p className="bases-permissions-error" role="alert">
            {slotsError} <button onClick={() => void loadSlots(contentsFor)}>Retry</button>
          </p>}
          {deleteNotice && <p className="bases-inventory-delete-notice" role="status">{deleteNotice}</p>}
          {deleteError && <p className="bases-inventory-amount-error" role="alert">{deleteError}</p>}
          {deleteUnavailableReason && <p className="bases-inventory-amount-error" role="status">
            {deleteUnavailableReason}
          </p>}
          {addNotice && <p className="bases-inventory-delete-notice" role="status">{addNotice}</p>}
          {addError && <p className="bases-inventory-amount-error" role="alert">{addError}</p>}
          {/* Suppressed when the delete gate already said the same thing --
              both fire on a running map, and two near-identical sentences read
              as a stutter rather than as two independent gates. */}
          {addUnavailableReason && !deleteUnavailableReason && <p className="bases-inventory-amount-error" role="status">
            {addUnavailableReason}
          </p>}

          {!slotsLoading && !slotsError && slots && slots.found === false && <p className="muted" role="status">
            {slots.reason || "That container is no longer at this base."}
          </p>}

          {/* One scroll container around every inventory, and the only part of
              the modal that grows. The per-inventory wrapper below cannot own
              the scrolling: an intermediate block with no height of its own
              breaks the constraint chain, and the list inside then renders at
              its full natural height straight over the controls beneath it. */}
          {!addOpen && <div className="bases-inventory-contents-scroll">
          {!slotsLoading && !slotsError && slots?.found && slots.inventories.map((inventory) => {
            const { cells, overflow } = layoutSlots(inventory);
            // Grid needs real slot positions and a sane capacity; without
            // either it would be a wall of empty cells, so it is not offered.
            const gridUsable = inventory.maxSlots > 0
              && inventory.maxSlots <= GRID_CELL_CAP
              && inventory.slots.some((slot) => slot.positionIndex !== null);
            const showGrid = contentsView === "grid" && gridUsable;
            const rows = showGrid ? overflow : inventory.slots;
            return (
              <div className="bases-inventory-slots" key={inventory.inventoryId}>
                {slots.inventories.length > 1 && <p className="bases-inventory-card-subtitle">
                  Inventory #{inventory.inventoryId} · {inventory.usedSlots.toLocaleString()} / {inventory.maxSlots.toLocaleString()} slots
                  {inventory.maxVolume > 0 && ` · ${inventory.volumeComplete === false ? "≥" : ""}${inventory.currentVolume.toFixed(1)} / ${inventory.maxVolume.toFixed(1)} ${inventory.volumeComplete === false ? "known volume" : "volume"}`}
                </p>}

                {showGrid && <div
                  className="bases-inventory-slot-grid"
                  role="group"
                  aria-label={`${inventory.usedSlots} of ${inventory.maxSlots} slots used`}
                >
                  {cells.map((slot, index) => slot
                    ? <button
                        key={slot.itemId}
                        className={`bases-inventory-slot-cell${selectedSlotId === slot.itemId ? " selected" : ""}`}
                        aria-pressed={selectedSlotId === slot.itemId}
                        // Without the explicit label the quantity badge below
                        // becomes the accessible name, so a filled cell
                        // announced as a bare number and the title fallback
                        // never applied.
                        aria-label={`${slot.name} ×${slot.quantity.toLocaleString()}, slot ${index}`}
                        title={`${slot.name} ×${slot.quantity.toLocaleString()} (slot ${index})`}
                        onClick={() => { selectSlot(slot); selectSlotForGiveFill(slot); }}
                      >
                        <CatalogItemThumb item={{ id: slot.templateId, itemId: slot.templateId, name: slot.name, image: itemImage(slot.templateId) }} small />
                        {slot.quantity > 1 && <span className="bases-inventory-slot-qty">{slot.quantity.toLocaleString()}</span>}
                      </button>
                    // Deliberately says nothing about which slot: the click is a
                    // shortcut to the add form, not a placement target, and the
                    // server always appends to the next free index. tabIndex=-1
                    // because a 45-slot container holding three items would
                    // otherwise wedge 42 tab stops between the grid and the
                    // controls below it -- the header button is the keyboard
                    // route to the identical action.
                    : <button
                        className="bases-inventory-slot-cell empty"
                        key={`empty-${index}`}
                        type="button"
                        tabIndex={-1}
                        disabled={!addAllowed || containerFull}
                        aria-label="Add an item to this container"
                        title={addAllowed
                          ? (containerFull ? containerFullReason : "Add an item to this container")
                          : (addUnavailableReason || "Adding items is unavailable for this container.")}
                        onClick={() => openAddPanel()}
                      />)}
                </div>}

                {showGrid && overflow.length > 0 && <p className="muted bases-inventory-slot-overflow-note">
                  {/* position_index has no unique constraint and is not bounded
                      by max_item_count, so a slot can duplicate another or sit
                      past the end of the grid. Listed rather than dropped. */}
                  {overflow.length.toLocaleString()} {overflow.length === 1 ? "item has" : "items have"} no place in the grid — a duplicate or out-of-range slot number.
                </p>}

                {rows.length > 0 && <div className="bases-inventory-contents-list">
                  {!showGrid && <div className={`bases-inventory-contents-row head${bulkDeleteAllowed ? " with-checkbox" : ""}`}>
                    <span />
                    {bulkDeleteAllowed && <span />}
                    <span>Item</span><span>Slot</span><span>Qty</span><span />
                  </div>}
                  {rows.map((slot) => (
                    <div
                      className={`bases-inventory-contents-row${bulkDeleteAllowed ? " with-checkbox" : ""}${selectedSlotId === slot.itemId ? " selected" : ""}`}
                      key={slot.itemId}
                    >
                      <CatalogItemThumb item={{ id: slot.templateId, itemId: slot.templateId, name: slot.name, image: itemImage(slot.templateId) }} small />
                      {/* Multi-select checkbox, shown only when deletion is
                          possible at all AND the destructive-controls
                          toggle is on (issue #371) -- a container that
                          cannot be deleted from has nothing to select for,
                          and a hidden Delete Selected button has nothing
                          for a checked item to feed. */}
                      {bulkDeleteAllowed && <input
                        type="checkbox"
                        checked={checkedItemIds.has(slot.itemId)}
                        aria-label={`Select ${slot.name} for bulk delete`}
                        disabled={bulkDeleteRunning}
                        onChange={() => toggleChecked(slot.itemId)}
                      />}
                      <button
                        className="bases-inventory-contents-name"
                        title={slot.templateId}
                        aria-pressed={selectedSlotId === slot.itemId}
                        onClick={() => { selectSlot(slot); selectSlotForGiveFill(slot); }}
                      >{slot.name}</button>
                      <span className="bases-inventory-contents-slot muted">
                        {slot.positionIndex === null ? "—" : `#${slot.positionIndex}`}
                      </span>
                      <span className="bases-inventory-contents-qty">{slot.quantity.toLocaleString()}</span>
                      <button
                        className="icon-toggle-button danger"
                        title="Delete this stack"
                        aria-label={`Delete ${slot.name} from slot ${slot.positionIndex ?? "unknown"}`}
                        disabled={!deleteAllowed || deletingItemId === slot.itemId}
                        onClick={() => void deleteSlot(slot, slot.quantity, containerLabel(openContainer))}
                      ><Trash2 size={15} /></button>
                    </div>
                  ))}
                </div>}
              </div>
            );
          })}

          </div>}

          {addOpen && <div className="bases-inventory-add-panel">
            <div className="bases-inventory-add-head">
              <h4>Add Item</h4>
              <span className="muted">
                {openContainer.usedSlots.toLocaleString()} / {openContainer.maxSlots.toLocaleString()} slots used
              </span>
            </div>
            {/* The one sentence that states both contracts the backend
                enforces. It stays visible for the whole form, not just at
                submit time. */}
            <p className="muted bases-inventory-add-note">
              Appends to the next free slot. Existing stacks are never topped up — this always creates a new slot.
            </p>

            <ItemCatalogSelector label="Select item to add" selected={addItem} onSelect={setAddItem} />

            <div className="bases-inventory-add-controls">
              <label className="bases-inventory-add-field">
                <span>Quantity</span>
                <input
                  type="number"
                  min={1}
                  max={1000000}
                  value={addQuantity}
                  aria-label="Quantity to add"
                  onChange={(event) => setAddQuantity(event.target.value)}
                />
              </label>
              <label className="bases-inventory-add-field">
                <span>Grade</span>
                <ItemGradeSelect
                  value={addGrade}
                  minGrade={catalogItemMinimumGrade(addItem)}
                  onChange={setAddGrade}
                />
              </label>
              {addAugmentOptions.length > 0 && <>
                <div className="bases-inventory-add-field bases-inventory-add-augments">
                  <span>Augments</span>
                  <AugmentDropdown
                    options={addAugmentOptions}
                    value={addAugments}
                    maxSelected={addAugmentLimit}
                    onChange={(selected) => setAddAugments(selected.slice(0, addAugmentLimit))}
                  />
                </div>
                <label className="bases-inventory-add-field">
                  <span>Aug. Grade</span>
                  <ItemGradeSelect
                    value={addAugmentGrade}
                    minGrade={1}
                    disabled={addAugments.length === 0}
                    emptyWhenDisabled
                    onChange={setAddAugmentGrade}
                  />
                </label>
              </>}
            </div>

            {addItem && !addQuantityValid && <p className="bases-inventory-amount-error" role="alert">
              Enter a quantity between 1 and 1,000,000.
            </p>}
            {containerFull && <p className="bases-inventory-amount-error" role="status">{containerFullReason}</p>}

            <div className="bases-inventory-add-actions">
              <button
                className="primary"
                disabled={!addAllowed || containerFull || !addItem || !addQuantityValid || adding}
                onClick={() => void addToContainer(containerLabel(openContainer))}
              >{adding ? "Adding…" : "Add to container"}</button>
              <button onClick={() => { setAddOpen(false); resetAddForm(); }}>Cancel</button>
            </div>
          </div>}

          {bulkDeleteAllowed && openContainer.itemCount > 0 && <div className="bases-inventory-bulk-actions">
            <button
              className="danger"
              disabled={checkedItemIds.size === 0 || bulkDeleteRunning}
              onClick={() => void deleteCheckedItems(containerLabel(openContainer))}
            >{bulkDeleteRunning ? "Deleting…" : `Delete Selected (${checkedItemIds.size})`}</button>
            <button
              className="danger"
              disabled={bulkDeleteRunning}
              onClick={() => void deleteAllItems(containerLabel(openContainer), openContainer.itemCount)}
            >{bulkDeleteRunning ? "Deleting…" : "Delete All"}</button>
          </div>}

          {selectedSlot && <div className="bases-inventory-slot-detail">
            <CatalogItemThumb item={{ id: selectedSlot.templateId, itemId: selectedSlot.templateId, name: selectedSlot.name, image: itemImage(selectedSlot.templateId) }} />
            <div className="bases-inventory-slot-detail-body">
              <strong>{selectedSlot.name}</strong>
              <span className="muted">
                {selectedSlot.positionIndex === null ? "Unplaced" : `Slot #${selectedSlot.positionIndex}`}
                {" · "}{selectedSlot.quantity.toLocaleString()} held
                {" · "}Grade {selectedSlot.qualityLevel}
                {selectedSlot.currentDurability !== null && selectedSlot.maxDurability
                  ? ` · ${Math.round((selectedSlot.currentDurability / selectedSlot.maxDurability) * 100)}% durability`
                  : ""}
              </span>
              {/* Its own line, and only when the item actually has any -- a
                  raw resource or an unaugmented item never carries this. */}
              {selectedSlot.augments.length > 0 && <span className="muted">
                Augments: {selectedSlot.augments.map((augment) => `${augment.name} (Grade ${augment.qualityLevel})`).join(", ")}
              </span>}
            </div>
            <label className="bases-inventory-slot-amount">
              <span>Remove</span>
              <input
                type="number"
                min={1}
                max={selectedSlot.quantity}
                value={amount}
                aria-label={`Amount of ${selectedSlot.name} to remove`}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            <button
              className="danger"
              disabled={!deleteAllowed || !amountValid || deletingItemId === selectedSlot.itemId}
              onClick={() => void deleteSlot(selectedSlot, Number(amount), containerLabel(openContainer))}
            >{Number(amount) >= selectedSlot.quantity ? "Delete stack" : `Remove ${Number(amount).toLocaleString()}`}</button>
          </div>}
          {selectedSlot && !amountValid && <p className="bases-inventory-amount-error" role="alert">
            Enter an amount between 1 and {selectedSlot.quantity.toLocaleString()}.
          </p>}

          {/* Give/Fill/Delete visibility toggle (issue #371, per explicit
              operator direction; widened same day to also gate bulk delete
              after an operator-reported oversight -- Delete Selected/
              Delete All previously rendered whenever deleteAllowed was
              true regardless of this toggle) -- hides the entire Give/Fill
              panel below AND the bulk-delete surface (per-row multi-select
              checkboxes, Delete Selected, Delete All) by default on every
              fresh open of this overlay. Does NOT gate the single-item
              delete strip (the per-row trash icon, or the selected-slot
              detail panel's own Remove/Delete stack button) -- that stays
              exactly as exposed as before this toggle existed. Rendered
              even when giveFillAllowed is false (Crafting/Refining
              containers, where neither gated capability is available
              either), disabled with an explanatory title, so an operator
              does not wonder why the toggle itself disappeared rather than
              merely being unusable -- matching how deleteAllowed-gated
              controls elsewhere in this file stay visible-but-disabled
              rather than vanishing. */}
          <label className={`switch-checkbox bases-inventory-givefill-toggle ${destructiveControlsVisible ? "enabled" : "disabled"}`}>
            <input
              type="checkbox"
              checked={destructiveControlsVisible}
              disabled={!giveFillAllowed}
              title={giveFillAllowed ? "" : "Give, Fill, and bulk delete are available only for Storage containers."}
              onChange={toggleDestructiveControlsVisible}
            />
            <span className="switch-label">Give / Fill / Delete Controls</span>
            <strong className="switch-state">{destructiveControlsVisible ? "ON" : "OFF"}</strong>
          </label>

          {giveFillAllowed && destructiveControlsVisible && <div className="bases-inventory-givefill-panel">
            {/* Consolidated 2026-08-19 (per the UI/UX hat's dispatched design
                review, "Alternative A") from two separately-stacked
                panels -- one full combobox+quantity+button row for Give,
                a second, visually identical one for Fill -- into one
                shared item picker + quantity field with a Give/Fill mode
                toggle. A real operator reported the old two-panel layout as
                confusing, especially once Give and Fill were restricted to
                the same three item groups in this same session, making the
                two rows show identical candidate items with nothing
                explaining when to use which. The mode toggle IS that
                explanation now, and each mode's own secondary affordance
                (Give's batch queue, Fill's capacity sentinel) only renders
                while that mode is selected, instead of both being visible
                and competing for attention at once.

                CORRECTED 2026-08-19 (real regression, found the same day by
                a real operator): the consolidation above merged the INPUTS
                but never actually merged the NOTICES -- this block used to
                render three separate stacked <p> elements (an explanatory
                paragraph, the restart warning, and a Fill-only collision
                warning as its own second bordered box), directly
                recreating the "wall of similar-looking warning text"
                problem the very first design review diagnosed. Per a
                second dispatched UI/UX-hat review: shortened the always-
                shown explanatory line to a single muted caption (the mode
                toggle's own labels now carry most of that meaning), moved
                the toggle above the warning so the warning's own mode-
                dependent text change reads as caused by the toggle instead
                of appearing above it, and merged the restart warning and
                the Fill-only collision warning into ONE bordered banner --
                Fill mode appends a trailing sentence to the SAME element
                rather than opening a second, visually-identical box. Never
                more than two notice elements are visible at once now, in
                either mode (one caption line, one warning banner), down
                from three.

                CORRECTED 2026-08-19 (real operator report, same day):
                content-wise there were at most two notice elements, but
                the two prior passes above only ever addressed WHAT text
                renders and WHEN -- neither touched VISUAL TREATMENT, so
                the mode-hint (bare text, no border/padding/icon) and the
                warning banner (bordered, padded, iconed) sat directly
                above and below the same toggle with no shared visual
                language, reading as unpolished/thrown-together rather
                than deliberately designed. Per a third dispatched UI/UX-
                hat review: grouped the mode-hint and the toggle into one
                shared, lightly-bordered/padded container (neutral --border
                token, NOT the warning's amber --warning token, so this
                group reads as "low-weight information," not a second
                alert) -- eliminating the bare-text-sandwiched-between-two-
                bordered-things sequence entirely, while leaving the
                warning banner's own visual weight untouched, since it is
                correctly the one element in this panel that most needs to
                keep looking urgent. */}
            <div className="bases-inventory-mode-group">
              <p className="muted bases-inventory-mode-hint">
                <strong>Give</strong> inserts one or more new stacks (quantities above an item's stack limit are split), and can queue several items at once.{" "}
                <strong>Fill</strong> tops up one item toward capacity, including filling it in one click.
              </p>

              <div className="bases-inventory-views" role="group" aria-label="Give or Fill">
                <button
                  type="button"
                  className={`bases-inventory-view${addFillMode === "give" ? " active" : ""}`}
                  aria-pressed={addFillMode === "give"}
                  onClick={() => selectAddFillMode("give")}
                >Give</button>
                <button
                  type="button"
                  className={`bases-inventory-view${addFillMode === "fill" ? " active" : ""}`}
                  aria-pressed={addFillMode === "fill"}
                  onClick={() => selectAddFillMode("fill")}
                >Fill</button>
              </div>
            </div>

            {/* Per INC-2026-07-31-001: the game engine claims dune.items rows
                only at server startup, so a given/filled item sits in the
                database but stays invisible in-game until the Survival
                server restarts. Silent and easy to rediscover the hard way
                -- surfaced explicitly here so an operator does not spend
                time re-litigating "why isn't this showing up" the way this
                fork's own incident history already did once. Restarting is
                not offered inline here (unlike the standalone Storage tab's
                "Apply Fills" button) -- Server Control/Bases already own
                that action, and duplicating a player-disconnecting restart
                trigger in a third place was judged a bigger risk than one
                extra tab switch. Applies to both modes, so the first
                sentence is always shown.

                The second sentence (per
                INC-2026-08-19-GIVE-FILL-POSITION-INDEX-COLLISION.md: while
                the map stays running, a filled row can land on the same
                slot a live in-game move/pickup claims at the same time,
                and the row that loses that race is never claimed on the
                next restart -- Give mitigates this by filling from the
                high end of the container, see nextHighPositionIndex in
                duneDb.js; Fill cannot use the same mitigation, since it is
                meant to top up toward real capacity, the same direction
                the engine already fills) is a Fill-specific ADDENDUM to
                this same restart-related warning, not an unrelated risk --
                appended as trailing text inside this SAME bordered banner
                only while Fill mode is selected, rather than rendered as a
                second, visually-identical box (the pre-2026-08-19 fix that
                caused a real operator to see "3 warnings" stacked in Fill
                mode). This is a documented, accepted limitation for Fill,
                not a bug. */}
            <p className="bases-inventory-restart-warning" role="status">
              <TriangleAlert size={14} aria-hidden="true" />
              <span>
                Given and filled items are not visible in-game until the Survival server restarts. Restart it from Server Control or Bases when convenient — all connected players will be disconnected for a few minutes.
                {addFillMode === "fill" && " If items are added to this container in-game while the map is running, a filled item can land on the same slot and be lost on the next restart — highest risk for a nearly-full container. See the Base Inventory documentation for details."}
              </span>
            </p>

            <div className="bases-inventory-add-row">
              <ItemCatalogCombobox
                value={selectedItem}
                onChange={setSelectedItem}
                filterGroups={FILLABLE_GROUPS}
                ariaLabel={addFillMode === "give" ? "Item to give" : "Item to fill"}
                placeholder={addFillMode === "give" ? "Type to search items…" : "Type to search fillable items…"}
                disabled={addRunning || fillRunning}
              />
              <input
                type="number"
                min={1}
                max={1000000}
                className="small-input"
                value={quantityText}
                onChange={(event) => setQuantityText(event.target.value)}
                aria-label={addFillMode === "give" ? "Quantity to give" : "Quantity to fill"}
                disabled={addRunning || fillRunning}
              />
              {addFillMode === "give" ? <>
                <button
                  type="button"
                  disabled={!selectedItem || addRunning}
                  onClick={queueAddItem}
                >Add to Batch</button>
                <button
                  disabled={(!selectedItem && addBatch.length === 0) || addRunning}
                  onClick={() => void giveItems(containerLabel(openContainer))}
                >{addRunning ? "Giving…" : addBatch.length > 0 ? `Give ${addBatch.length + (selectedItem ? 1 : 0)} Items` : "Give Item"}</button>
              </> : <>
                <button
                  disabled={!selectedItem || fillRunning}
                  onClick={() => void submitFill(containerLabel(openContainer))}
                >{fillRunning ? "Filling…" : "Fill Amount"}</button>
                <button
                  disabled={!selectedItem || fillRunning}
                  onClick={() => void submitFill(containerLabel(openContainer), true)}
                >{fillRunning ? "Filling…" : "Fill to Capacity"}</button>
              </>}
            </div>
            {addFillMode === "give" && addBatch.length > 0 && <ul className="bases-inventory-add-batch">
              {addBatch.map((item, index) => (
                <li key={`${item.itemId}-${index}`}>
                  {item.itemName} ×{item.quantity.toLocaleString()}
                  <button type="button" className="icon-toggle-button" aria-label={`Remove ${item.itemName} from batch`} onClick={() => removeQueuedItem(index)} disabled={addRunning}>
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>}
          </div>}

          {/* Hidden entirely while the add panel is open, not just disabled:
              its own action row (Add to container / Cancel) is the footer in
              that state, and Cancel already returns here -- a second Close
              next to it would be a redundant way to leave. The X in the
              header and Escape both still close the whole overlay. Does not
              gate the Give/Fill toggle/panel above -- those are independent
              of the Add panel's own open state. */}
          {!addOpen && <div className="confirm-modal-actions confirm-modal-actions-grouped">
            {/* List-view only: grid's own empty cells already open this panel,
                so a second, redundant control there would just be noise. List
                enumerates occupied slots only and has no empty cell to click,
                which is why it needs an explicit affordance. */}
            {contentsView === "list"
              ? <button
                  className="bases-inventory-add-item"
                  aria-expanded={addOpen}
                  disabled={!addAllowed || containerFull}
                  title={addAllowed
                    ? (containerFull ? containerFullReason : "Add an item to this container")
                    : (addUnavailableReason || "Adding items is unavailable for this container.")}
                  onClick={() => openAddPanel()}
                ><Plus size={14} aria-hidden="true" /> Add Item</button>
              : <span />}
            <button onClick={() => setContentsFor("")}>Close</button>
          </div>}
        </section>
      </div>}
    </div>
  );
}
