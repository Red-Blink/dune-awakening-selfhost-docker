// Shared by the two contents overlays -- Bases -> Inventory -> View Contents
// and Vehicles -> Components -> View Contents. Lifted out of BaseInventoryTab
// rather than copied: the "never drop a slot" rule below is the kind of thing
// that silently diverges once there are two of it.

// Guards a corrupt or absurd max_item_count from rendering tens of thousands
// of cells. Above this the modal stays in list mode.
export const GRID_CELL_CAP = 200;

// A slot only has to say where it sits; everything else about it is the
// caller's business.
type PlaceableSlot = { positionIndex: number | null };

// Lays one inventory's slots into a fixed grid. position_index has no unique
// constraint in the schema and is not validated against max_item_count, so all
// three of "sparse", "two slots claim the same index" and "index past the end"
// are reachable. Anything that cannot be placed goes to `overflow` and is
// rendered below the grid -- never dropped, because an item the list cannot
// reach is the worst outcome here.
export function layoutSlots<T extends PlaceableSlot>(inventory: { maxSlots: number; slots: T[] }) {
  const size = Math.min(Math.max(0, inventory.maxSlots), GRID_CELL_CAP);
  const cells: (T | null)[] = new Array(size).fill(null);
  const overflow: T[] = [];
  for (const slot of inventory.slots) {
    const at = slot.positionIndex;
    if (at !== null && Number.isInteger(at) && at >= 0 && at < size && cells[at] === null) cells[at] = slot;
    else overflow.push(slot);
  }
  return { cells, overflow };
}
