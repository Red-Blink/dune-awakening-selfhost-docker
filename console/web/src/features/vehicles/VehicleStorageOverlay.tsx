import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutGrid, List, Trash2, X } from "lucide-react";
import { CatalogItemThumb } from "../../components/common/ItemCatalog";
import { GRID_CELL_CAP, layoutSlots } from "../inventory/slotLayout";
import { vehiclesApi, type VehicleStorage, type VehicleStorageSlot } from "../../api/vehicles";

type ConfirmAction = (
  message: string,
  options?: {
    title?: string;
    confirmLabel?: string;
    warning?: string;
    danger?: boolean;
    details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[];
  }
) => Promise<boolean>;

type VehicleStorageOverlayProps = {
  vehicleId: string;
  vehicleName: string;
  onClose: () => void;
  confirmAction: ConfirmAction;
  // Optional: the global Vehicles panel has a banner to echo failures into
  // once this modal is dismissed. PlayerVehiclesTab has none, and the inline
  // deleteError below is the primary surface either way.
  onError?: (text: string) => void;
};

type ContentsView = "list" | "grid";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

// Counterpart to the bases contents modal, reusing its CSS classes verbatim so
// the two read as one control. Cargo deletion mirrors the base container
// delete family: a per-stack trash button and a partial-stack Remove are one
// deliberate click on an already-visible item, while the bulk controls sit
// behind a confirm-gated toggle.
export function VehicleStorageOverlay({ vehicleId, vehicleName, onClose, confirmAction, onError }: VehicleStorageOverlayProps) {
  const [storage, setStorage] = useState<VehicleStorage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [contentsView, setContentsView] = useState<ContentsView>("grid");
  const [selectedItemId, setSelectedItemId] = useState("");
  const [amount, setAmount] = useState("");
  const [deletingItemId, setDeletingItemId] = useState("");
  const [bulkDeleteRunning, setBulkDeleteRunning] = useState(false);
  const [checkedItemIds, setCheckedItemIds] = useState<Set<string>>(new Set());
  const [destructiveControlsVisible, setDestructiveControlsVisible] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);
  // Newest-request-wins, same guard as the bases tab's loadSlots: a Retry
  // fired while the first request is still in flight would otherwise let the
  // slower of the two decide what is on screen.
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError("");
    try {
      const result = await vehiclesApi.storage(vehicleId);
      if (requestIdRef.current !== requestId) return;
      setStorage(result);
    } catch (caught) {
      if (requestIdRef.current !== requestId) return;
      setError(errorText(caught));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [vehicleId]);

  useEffect(() => {
    setStorage(null);
    setSelectedItemId("");
    setAmount("");
    setCheckedItemIds(new Set());
    // Never persisted and never carried across an open: revealing the bulk
    // controls is a decision about this session with this vehicle.
    setDestructiveControlsVisible(false);
    setDeleteNotice("");
    setDeleteError("");
    void load();
    // Bumps the request id on unmount/id change so a response that is already
    // in flight cannot land on a closed -- or re-opened, different -- overlay.
    return () => { requestIdRef.current += 1; };
  }, [load]);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Yields to a stacked dialog -- a delete confirm can be open over this
      // one, and a single Escape must not cancel the confirm and tear down the
      // overlay behind it.
      if (document.querySelectorAll(".confirm-modal").length > 1) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const found = Boolean(storage?.supported && storage?.found);
  const slots: VehicleStorageSlot[] = found && storage ? storage.slots : [];
  const maxSlots = storage?.maxSlots || 0;
  const usedSlots = storage?.usedSlots || 0;
  const maxVolume = storage?.maxVolume || 0;
  const currentVolume = storage?.currentVolume || 0;
  // Re-derived from `storage` every render rather than held in state, so a
  // partial delete refreshes the detail strip instead of showing a stale stack.
  const selectedSlot = slots.find((slot) => slot.itemId === selectedItemId) || null;
  const { cells, overflow } = layoutSlots({ maxSlots, slots });
  // Grid needs real slot positions and a sane capacity; without either it
  // would be a wall of empty cells, so it is not offered.
  const gridUsable = maxSlots > 0 && maxSlots <= GRID_CELL_CAP && slots.some((slot) => slot.positionIndex !== null);
  const showGrid = contentsView === "grid" && gridUsable;
  const rows = showGrid ? overflow : slots;
  const distinct = new Set(slots.map((slot) => slot.templateId)).size;
  const itemCount = slots.reduce((total, slot) => total + slot.quantity, 0);

  const deleteAllowed = found && storage?.deleteSafety?.safe === true;
  const bulkDeleteAllowed = deleteAllowed && destructiveControlsVisible;
  const deleteUnavailableReason = found && !deleteAllowed
    ? storage?.deleteSafety?.reason || "Cargo deletion is unavailable for this vehicle."
    : "";
  const amountNumber = Number(amount);
  // A courtesy check, not the guard -- the server refuses an over-count
  // outright rather than widening it.
  const amountValid = Boolean(selectedSlot)
    && Number.isInteger(amountNumber)
    && amountNumber >= 1
    && amountNumber <= (selectedSlot?.quantity ?? 0);

  function selectSlot(slot: VehicleStorageSlot) {
    setSelectedItemId(slot.itemId);
    setAmount(String(slot.quantity));
  }

  function toggleChecked(itemId: string) {
    setCheckedItemIds((previous) => {
      const next = new Set(previous);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  // Returns whether the controls ended up visible. Callers must use the return
  // value rather than reading state right after -- setState is async, so the
  // flag would still be false on the next line.
  async function requestDestructiveControlsVisible(): Promise<boolean> {
    if (destructiveControlsVisible) return true;
    const confirmed = await confirmAction(
      "Delete Selected and Delete All permanently destroy items from the database with no undo. Deleting does not require the map to be stopped, but the change is not reflected in-game until the affected map server restarts: the row is gone immediately, and a running map keeps showing it until then.",
      {
        title: "Show Bulk Delete Controls",
        confirmLabel: "Show Controls",
        warning: "Bulk delete acts on whole stacks. To remove part of a stack, select it and use the Remove amount instead."
      }
    );
    if (!confirmed) return false;
    setDestructiveControlsVisible(true);
    return true;
  }

  function toggleDestructiveControlsVisible() {
    if (destructiveControlsVisible) { setDestructiveControlsVisible(false); return; }
    void requestDestructiveControlsVisible();
  }

  function reportFailure(text: string) {
    setDeleteError(text);
    onError?.(text);
  }

  async function deleteSlot(slot: VehicleStorageSlot, requested: number) {
    if (!deleteAllowed) {
      reportFailure(deleteUnavailableReason || "Cargo deletion is unavailable for this vehicle.");
      return;
    }
    const whole = requested >= slot.quantity;
    const confirmed = await confirmAction(
      whole ? "Delete this item from the vehicle's cargo hold?" : "Remove part of this stack?",
      {
        title: whole ? "Delete Cargo Item" : "Remove From Stack",
        confirmLabel: whole ? "Delete" : "Remove",
        danger: true,
        details: [
          { label: "Vehicle", value: vehicleName, tone: "accent" },
          { label: "Slot", value: slot.positionIndex === null ? "—" : `#${slot.positionIndex}` },
          {
            label: whole ? "Item" : "Removing",
            value: whole
              ? `${slot.name} ×${slot.quantity.toLocaleString()}`
              : `${requested.toLocaleString()} of ${slot.quantity.toLocaleString()} ${slot.name}`,
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
      const response = await vehiclesApi.deleteStorageItem(vehicleId, slot.itemId, "DELETE ITEM", whole ? undefined : requested);
      const result = response.result;
      if (!response.supported || !result?.ok) {
        throw new Error(response.error || response.reason || "The item could not be deleted.");
      }
      setDeleteNotice(result.message);
      // A partial delete leaves the same slot selected with a smaller stack.
      // Without this the stale larger amount immediately trips the validation
      // error on a *successful* delete.
      if (result.partial) setAmount(String(result.removed.remaining));
      await load();
    } catch (caught) {
      reportFailure(errorText(caught));
    } finally {
      setDeletingItemId("");
    }
  }

  async function deleteCheckedItems() {
    if (!bulkDeleteAllowed || checkedItemIds.size === 0) return;
    const ids = [...checkedItemIds];
    const confirmed = await confirmAction(
      `Delete ${ids.length} selected item${ids.length === 1 ? "" : "s"} from the vehicle's cargo hold?`,
      {
        title: "Delete Selected Items",
        confirmLabel: "Delete",
        danger: true,
        details: [
          { label: "Vehicle", value: vehicleName, tone: "accent" },
          { label: "Items", value: `${ids.length} stack${ids.length === 1 ? "" : "s"}`, tone: "danger" }
        ]
      }
    );
    if (!confirmed) return;
    setBulkDeleteRunning(true);
    setDeleteNotice("");
    setDeleteError("");
    try {
      const response = await vehiclesApi.deleteStorageItems(vehicleId, ids, "DELETE ITEMS");
      const result = response.result;
      if (!response.supported || !result?.ok) {
        throw new Error(response.error || response.reason || "The selected items could not be deleted.");
      }
      setDeleteNotice(result.message);
      setCheckedItemIds(new Set());
      await load();
    } catch (caught) {
      reportFailure(errorText(caught));
    } finally {
      setBulkDeleteRunning(false);
    }
  }

  async function deleteAllItems() {
    if (!bulkDeleteAllowed || slots.length === 0) return;
    const confirmed = await confirmAction(
      "Delete every item currently in this vehicle's cargo hold?",
      {
        title: "Delete All Items",
        confirmLabel: "Delete All",
        danger: true,
        details: [
          { label: "Vehicle", value: vehicleName, tone: "accent" },
          { label: "Items", value: `All ${slots.length.toLocaleString()} stack${slots.length === 1 ? "" : "s"}`, tone: "danger" }
        ]
      }
    );
    if (!confirmed) return;
    setBulkDeleteRunning(true);
    setDeleteNotice("");
    setDeleteError("");
    try {
      const response = await vehiclesApi.deleteAllStorageItems(vehicleId, "DELETE ALL ITEMS");
      const result = response.result;
      if (!response.supported || !result?.ok) {
        throw new Error(response.error || response.reason || "The cargo hold could not be cleared.");
      }
      setDeleteNotice(result.message);
      setCheckedItemIds(new Set());
      await load();
    } catch (caught) {
      reportFailure(errorText(caught));
    } finally {
      setBulkDeleteRunning(false);
    }
  }

  const rowClass = bulkDeleteAllowed ? " with-checkbox" : "";

  return (
    <div className="modal-overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="confirm-modal bases-inventory-contents-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vehicles-storage-contents-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="confirm-modal-title">
          <div>
            <h3 id="vehicles-storage-contents-title">{vehicleName}</h3>
            <p className="bases-inventory-card-subtitle">Cargo Hold · #{vehicleId}</p>
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
            <button ref={closeRef} className="icon-action" aria-label="Close contents" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </div>

        {found && <dl className="bases-inventory-contents-summary">
          <div><dt>Slots Used</dt><dd>{usedSlots.toLocaleString()} / {maxSlots.toLocaleString()}</dd></div>
          {/* Withheld on a schema without volume tracking, same as the bases
              modal's own Volume Used row. */}
          {maxVolume > 0 && <div>
            <dt>{storage?.volumeComplete === false ? "Known Volume" : "Volume Used"}</dt>
            <dd>{storage?.volumeComplete === false ? "≥" : ""}{currentVolume.toFixed(1)} / {maxVolume.toFixed(1)}</dd>
          </div>}
          <div><dt>Items</dt><dd>{itemCount.toLocaleString()}</dd></div>
          {/* Distinct templates, not stacks -- the two differ whenever one
              template occupies more than one slot. */}
          <div><dt>Distinct</dt><dd>{distinct.toLocaleString()}</dd></div>
        </dl>}

        {loading && <p className="muted" role="status">Loading Contents…</p>}
        {error && <p className="bases-permissions-error" role="alert">
          {error} <button onClick={() => void load()}>Retry</button>
        </p>}
        {/* These sit apart from `error` deliberately: a failed delete leaves
            the list perfectly valid, so blanking it behind a Retry would lose
            the operator's place over one bad row. */}
        {deleteNotice && <p className="bases-inventory-delete-notice" role="status">{deleteNotice}</p>}
        {deleteError && <p className="bases-inventory-amount-error" role="alert">{deleteError}</p>}
        {deleteUnavailableReason && <p className="bases-inventory-amount-error" role="status">{deleteUnavailableReason}</p>}
        {!loading && !error && storage && storage.supported === false && <p className="muted" role="status">
          {storage.reason || "Cargo contents are unsupported by the detected schema."}
        </p>}
        {!loading && !error && storage?.supported && storage.found === false && <p className="muted" role="status">
          {storage.reason || "That vehicle has no cargo hold."}
        </p>}
        {!loading && !error && found && slots.length === 0 && !showGrid && <p className="muted" role="status">
          This cargo hold is empty.
        </p>}

        {!loading && !error && found && <div className="bases-inventory-contents-scroll">
          <div className="bases-inventory-slots">
            {showGrid && <div
              className="bases-inventory-slot-grid"
              role="group"
              aria-label={`${usedSlots} of ${maxSlots} slots used`}
            >
              {cells.map((slot, index) => slot
                ? <button
                    key={slot.itemId}
                    className={`bases-inventory-slot-cell${selectedItemId === slot.itemId ? " selected" : ""}`}
                    type="button"
                    aria-pressed={selectedItemId === slot.itemId}
                    // Without the explicit label the quantity badge becomes
                    // the accessible name, so a filled cell announces as a
                    // bare number.
                    aria-label={`${slot.name} ×${slot.quantity.toLocaleString()}, slot ${index}`}
                    title={`${slot.name} ×${slot.quantity.toLocaleString()} (slot ${index})`}
                    onClick={() => selectSlot(slot)}
                  >
                    <CatalogItemThumb item={{ id: slot.templateId, itemId: slot.templateId, name: slot.name, image: slot.image }} small />
                    {slot.quantity > 1 && <span className="bases-inventory-slot-qty">{slot.quantity.toLocaleString()}</span>}
                  </button>
                // Inert rather than a button: the bases version opens its add
                // form from an empty cell, and this view has nothing to add.
                // A 20-slot hold holding three items would otherwise wedge 17
                // dead tab stops between the grid and the controls below it.
                : <div className="bases-inventory-slot-cell empty" key={`empty-${index}`} aria-hidden="true" />)}
            </div>}

            {showGrid && overflow.length > 0 && <p className="muted bases-inventory-slot-overflow-note">
              {/* position_index has no unique constraint and is not bounded by
                  max_item_count, so a slot can duplicate another or sit past
                  the end of the grid. Listed rather than dropped -- an item
                  the delete button cannot reach is the worst outcome here. */}
              {overflow.length.toLocaleString()} {overflow.length === 1 ? "item has" : "items have"} no place in the grid — a duplicate or out-of-range slot number.
            </p>}

            {rows.length > 0 && <div className="bases-inventory-contents-list">
              {!showGrid && <div className={`bases-inventory-contents-row head${rowClass}`}>
                <span />
                {bulkDeleteAllowed && <span />}
                <span>Item</span><span>Slot</span><span>Qty</span><span />
              </div>}
              {rows.map((slot) => (
                <div
                  className={`bases-inventory-contents-row${rowClass}${selectedItemId === slot.itemId ? " selected" : ""}`}
                  key={slot.itemId}
                >
                  <CatalogItemThumb item={{ id: slot.templateId, itemId: slot.templateId, name: slot.name, image: slot.image }} small />
                  {/* Shown only when deletion is possible at all AND the
                      toggle is on: a hold that cannot be deleted from has
                      nothing to select for, and a hidden Delete Selected
                      button has nothing for a checked item to feed. */}
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
                    aria-pressed={selectedItemId === slot.itemId}
                    onClick={() => selectSlot(slot)}
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
                    onClick={() => void deleteSlot(slot, slot.quantity)}
                  ><Trash2 size={15} /></button>
                </div>
              ))}
            </div>}
          </div>
        </div>}

        {found && slots.length > 0 && <label
          className={`switch-checkbox bases-inventory-givefill-toggle ${destructiveControlsVisible ? "enabled" : "disabled"}`}
        >
          {/* Rendered even when deletion is unavailable -- visible but
              disabled, so an operator does not wonder why it vanished. */}
          <input
            type="checkbox"
            checked={destructiveControlsVisible}
            disabled={!deleteAllowed}
            title={deleteAllowed ? "" : deleteUnavailableReason}
            onChange={toggleDestructiveControlsVisible}
          />
          <span className="switch-label">Bulk Delete Controls</span>
          <strong className="switch-state">{destructiveControlsVisible ? "ON" : "OFF"}</strong>
        </label>}

        {bulkDeleteAllowed && slots.length > 0 && <div className="bases-inventory-bulk-actions">
          <button
            className="danger"
            disabled={checkedItemIds.size === 0 || bulkDeleteRunning}
            onClick={() => void deleteCheckedItems()}
          >{bulkDeleteRunning ? "Deleting…" : `Delete Selected (${checkedItemIds.size})`}</button>
          <button
            className="danger"
            disabled={bulkDeleteRunning}
            onClick={() => void deleteAllItems()}
          >{bulkDeleteRunning ? "Deleting…" : "Delete All"}</button>
        </div>}

        {selectedSlot && <div className="bases-inventory-slot-detail">
          <CatalogItemThumb item={{ id: selectedSlot.templateId, itemId: selectedSlot.templateId, name: selectedSlot.name, image: selectedSlot.image }} />
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
            {/* Its own line, and only when the item actually has any -- a raw
                resource or an unaugmented item never carries this. */}
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
            onClick={() => void deleteSlot(selectedSlot, amountNumber)}
          >{amountNumber >= selectedSlot.quantity ? "Delete Stack" : `Remove ${amountNumber.toLocaleString()}`}</button>
        </div>}

        {selectedSlot && !amountValid && <p className="bases-inventory-amount-error" role="alert">
          Enter an amount between 1 and {selectedSlot.quantity.toLocaleString()}.
        </p>}

        {found && <p className="muted bases-inventory-note">
          A database snapshot, not a live view. Deleting does not require the map to be
          stopped, but the change is not reflected in-game until the affected map
          server restarts.
        </p>}

        <div className="confirm-modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </section>
    </div>
  );
}
