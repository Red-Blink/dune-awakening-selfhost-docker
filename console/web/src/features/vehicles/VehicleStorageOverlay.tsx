import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutGrid, List, X } from "lucide-react";
import { CatalogItemThumb } from "../../components/common/ItemCatalog";
import { GRID_CELL_CAP, layoutSlots } from "../inventory/slotLayout";
import { vehiclesApi, type VehicleStorage, type VehicleStorageSlot } from "../../api/vehicles";

type VehicleStorageOverlayProps = {
  vehicleId: string;
  vehicleName: string;
  onClose: () => void;
};

type ContentsView = "list" | "grid";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

// Read-only counterpart to the bases contents modal. It reuses that modal's
// CSS classes verbatim rather than defining a parallel set: the two show the
// same thing, and a second vocabulary for it would drift.
//
// Read-only is the whole scope -- no add, delete, give or fill. That is why
// there are no checkboxes, no destructive-controls toggle, and no
// map-stopped safety gating here: none of the reasons the bases tab needs
// them apply to a view that only reads.
export function VehicleStorageOverlay({ vehicleId, vehicleName, onClose }: VehicleStorageOverlayProps) {
  const [storage, setStorage] = useState<VehicleStorage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [contentsView, setContentsView] = useState<ContentsView>("grid");
  const [selectedItemId, setSelectedItemId] = useState("");
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
      // Yields to a stacked dialog -- the Permissions tab's ConfirmDialog can
      // be open over this one, and it should close first.
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
  const selectedSlot = slots.find((slot) => slot.itemId === selectedItemId) || null;
  const { cells, overflow } = layoutSlots({ maxSlots, slots });
  // Grid needs real slot positions and a sane capacity; without either it
  // would be a wall of empty cells, so it is not offered.
  const gridUsable = maxSlots > 0 && maxSlots <= GRID_CELL_CAP && slots.some((slot) => slot.positionIndex !== null);
  const showGrid = contentsView === "grid" && gridUsable;
  const rows = showGrid ? overflow : slots;
  const distinct = new Set(slots.map((slot) => slot.templateId)).size;
  const itemCount = slots.reduce((total, slot) => total + slot.quantity, 0);

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
            <p className="bases-inventory-card-subtitle">Cargo hold · #{vehicleId}</p>
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

        {loading && <p className="muted" role="status">Loading contents…</p>}
        {error && <p className="bases-permissions-error" role="alert">
          {error} <button onClick={() => void load()}>Retry</button>
        </p>}
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
                    onClick={() => setSelectedItemId(slot.itemId)}
                  >
                    <CatalogItemThumb item={{ id: slot.templateId, itemId: slot.templateId, name: slot.name, image: slot.image }} small />
                    {slot.quantity > 1 && <span className="bases-inventory-slot-qty">{slot.quantity.toLocaleString()}</span>}
                  </button>
                // Inert rather than a button: the bases version opens the add
                // form from an empty cell, and this view has nothing to add.
                // tabIndex is moot for a div, which is the point -- a 20-slot
                // hold holding three items would otherwise wedge 17 dead tab
                // stops between the grid and the Close button.
                : <div className="bases-inventory-slot-cell empty" key={`empty-${index}`} aria-hidden="true" />)}
            </div>}

            {showGrid && overflow.length > 0 && <p className="muted bases-inventory-slot-overflow-note">
              {/* position_index has no unique constraint and is not bounded by
                  max_item_count, so a slot can duplicate another or sit past
                  the end of the grid. Listed rather than dropped. */}
              {overflow.length.toLocaleString()} {overflow.length === 1 ? "item has" : "items have"} no place in the grid — a duplicate or out-of-range slot number.
            </p>}

            {rows.length > 0 && <div className="bases-inventory-contents-list">
              {!showGrid && <div className="bases-inventory-contents-row head">
                <span />
                <span>Item</span><span>Slot</span><span>Qty</span><span />
              </div>}
              {rows.map((slot) => (
                <div
                  className={`bases-inventory-contents-row${selectedItemId === slot.itemId ? " selected" : ""}`}
                  key={slot.itemId}
                >
                  <CatalogItemThumb item={{ id: slot.templateId, itemId: slot.templateId, name: slot.name, image: slot.image }} small />
                  <button
                    className="bases-inventory-contents-name"
                    title={slot.templateId}
                    aria-pressed={selectedItemId === slot.itemId}
                    onClick={() => setSelectedItemId(slot.itemId)}
                  >{slot.name}</button>
                  <span className="bases-inventory-contents-slot muted">
                    {slot.positionIndex === null ? "—" : `#${slot.positionIndex}`}
                  </span>
                  <span className="bases-inventory-contents-qty">{slot.quantity.toLocaleString()}</span>
                  {/* Holds the fifth grid track the bases row uses for its
                      delete button, so both lists align on the same columns
                      and the header's right-aligned Qty label lands over the
                      Qty column. */}
                  <span />
                </div>
              ))}
            </div>}
          </div>
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
        </div>}

        <div className="confirm-modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </section>
    </div>
  );
}
