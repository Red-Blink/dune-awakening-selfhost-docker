import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { VehicleStorage } from "../../api/vehicles";
import { vehiclesApi } from "../../api/vehicles";
import { VehicleStorageOverlay } from "./VehicleStorageOverlay";

vi.mock("../../api/vehicles", () => ({ vehiclesApi: {
  storage: vi.fn(),
  deleteStorageItem: vi.fn(),
  deleteStorageItems: vi.fn(),
  deleteAllStorageItems: vi.fn()
} }));

const STORAGE: VehicleStorage = {
  supported: true,
  found: true,
  vehicleId: "2008",
  inventoryId: "2001",
  maxSlots: 20,
  usedSlots: 3,
  maxVolume: 2000,
  currentVolume: 162.5,
  volumeComplete: true,
  deleteSafety: { safe: true, known: true, state: "", reason: "" },
  slots: [
    {
      itemId: "501", templateId: "JasmiumCrystal", name: "Jasmium Crystal",
      image: "/images/items/JasmiumCrystal.png", positionIndex: 0, quantity: 162,
      qualityLevel: 0, currentDurability: null, maxDurability: null, augments: []
    },
    {
      // Same template as above in a different slot -- the per-slot view exists
      // precisely so these two stay distinguishable.
      itemId: "502", templateId: "JasmiumCrystal", name: "Jasmium Crystal",
      image: "/images/items/JasmiumCrystal.png", positionIndex: 3, quantity: 40,
      qualityLevel: 0, currentDurability: null, maxDurability: null, augments: []
    },
    {
      itemId: "503", templateId: "Mk5Cutteray", name: "Cutteray Mk5",
      image: "/images/items/Mk5Cutteray.png", positionIndex: 5, quantity: 1,
      qualityLevel: 4, currentDurability: 300, maxDurability: 600,
      augments: [{ templateId: "AugPower", name: "Power Augment", qualityLevel: 3 }]
    }
  ]
};

function mockStorage(payload: VehicleStorage = STORAGE) {
  vi.mocked(vehiclesApi.storage).mockResolvedValue(payload as never);
}

const onClose = vi.fn();
const onError = vi.fn();
const confirmAction = vi.fn();

function renderOverlay() {
  return render(
    <VehicleStorageOverlay
      vehicleId="2008"
      vehicleName="Sandcrawler"
      onClose={onClose}
      confirmAction={confirmAction}
      onError={onError}
    />
  );
}

function deleteResult(overrides: Record<string, unknown> = {}) {
  return {
    supported: true,
    result: {
      ok: true, vehicleId: "2008", inventoryId: "2001", partial: false,
      removed: { itemId: "501", templateId: "JasmiumCrystal", count: 162, remaining: 0, positionIndex: 0, qualityLevel: 0, currentDurability: null, maxDurability: null },
      message: "Jasmium Crystal was deleted from the database.",
      ...overrides
    }
  };
}

// The bulk controls are hidden behind a confirm-gated toggle, exactly like the
// bases tab's. Everything bulk-related has to go through this first.
async function revealBulkControls() {
  confirmAction.mockResolvedValueOnce(true);
  fireEvent.click(screen.getByRole("checkbox", { name: /Bulk Delete Controls/i }));
  await waitFor(() => expect(screen.getByRole("button", { name: /Delete All/ })).toBeTruthy());
}

async function loaded() {
  await waitFor(() => expect(screen.getByText("Slots Used")).toBeTruthy());
}

async function toList() {
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^List$/ }));
  await waitFor(() => expect(document.querySelectorAll(".bases-inventory-contents-row:not(.head)").length).toBeGreaterThan(0));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStorage();
  confirmAction.mockResolvedValue(true);
  vi.mocked(vehiclesApi.deleteStorageItem).mockResolvedValue(deleteResult() as never);
  vi.mocked(vehiclesApi.deleteStorageItems).mockResolvedValue({ supported: true, result: { ok: true, vehicleId: "2008", inventoryId: "2001", removed: [], message: "2 of 2 requested item(s) were deleted from the database." } } as never);
  vi.mocked(vehiclesApi.deleteAllStorageItems).mockResolvedValue({ supported: true, result: { ok: true, vehicleId: "2008", inventoryId: "2001", removed: [], message: "3 item(s) were deleted from the database." } } as never);
});

describe("VehicleStorageOverlay", () => {
  it("fetches the hold for its vehicle and renders the summary", async () => {
    renderOverlay();
    await loaded();
    expect(vehiclesApi.storage).toHaveBeenCalledWith("2008");
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByRole("heading", { name: "Sandcrawler" })).toBeTruthy();
    expect(dialog.textContent).toContain("Cargo hold · #2008");
    expect(dialog.textContent).toContain("3 / 20");
    expect(dialog.textContent).toContain("162.5 / 2000.0");
    // 162 + 40 + 1 stacked, across two distinct templates.
    expect(dialog.textContent).toContain("203");
    expect(within(dialog).getByText("Distinct").nextElementSibling?.textContent).toBe("2");
  });

  it("opens on the grid and draws one cell per slot, filled and empty", async () => {
    renderOverlay();
    await loaded();
    await waitFor(() => expect(document.querySelectorAll(".bases-inventory-slot-cell").length).toBe(20));
    expect(document.querySelectorAll(".bases-inventory-slot-cell.empty").length).toBe(17);
    expect(screen.getByRole("button", { name: "Jasmium Crystal ×162, slot 0" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cutteray Mk5 ×1, slot 5" })).toBeTruthy();
  });

  it("shows every stack separately with its own slot number in list view", async () => {
    renderOverlay();
    await loaded();
    await toList();
    const rows = [...document.querySelectorAll(".bases-inventory-contents-row:not(.head)")];
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain("#0");
    expect(rows[1].textContent).toContain("#3");
    expect(rows[0].textContent).toContain("162");
    expect(rows[1].textContent).toContain("40");
  });

  it("shows grade, durability and augments for a selected slot", async () => {
    renderOverlay();
    await loaded();
    await toList();
    fireEvent.click(screen.getByRole("button", { name: "Cutteray Mk5" }));
    const detail = document.querySelector(".bases-inventory-slot-detail") as HTMLElement;
    expect(detail).toBeTruthy();
    expect(detail.textContent).toContain("Slot #5");
    expect(detail.textContent).toContain("Grade 4");
    expect(detail.textContent).toContain("50% durability");
    expect(detail.textContent).toContain("Augments: Power Augment (Grade 3)");
  });

  it("offers no add or give controls -- deletion is the only mutation here", async () => {
    renderOverlay();
    await loaded();
    await toList();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: /Add Item/i })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Give/i })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Fill/i })).toBeNull();
  });

  it("closes four ways", async () => {
    const { unmount } = renderOverlay();
    await loaded();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close contents" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
    fireEvent.mouseDown(document.querySelector(".modal-overlay") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(4);
    unmount();
  });

  it("leaves Escape to a stacked confirm dialog", async () => {
    renderOverlay();
    await loaded();
    const stacked = document.createElement("div");
    stacked.className = "confirm-modal";
    document.body.appendChild(stacked);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    stacked.remove();
  });

  it("surfaces a load failure with a working retry", async () => {
    vi.mocked(vehiclesApi.storage).mockRejectedValueOnce(new Error("database is unreachable"));
    renderOverlay();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("database is unreachable"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await loaded();
    expect(vehiclesApi.storage).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports an unsupported schema without an error state", async () => {
    mockStorage({ supported: false, reason: "Missing required table(s): dune.items", vehicleId: "2008", slots: [] });
    renderOverlay();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Missing required table(s): dune.items"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Slots Used")).toBeNull();
  });

  it("reports a vehicle with no cargo hold", async () => {
    mockStorage({ supported: true, found: false, reason: "That vehicle has no cargo hold.", vehicleId: "2008", slots: [] });
    renderOverlay();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("no cargo hold"));
  });

  it("lists a duplicate or out-of-range slot below the grid rather than dropping it", async () => {
    mockStorage({
      ...STORAGE,
      usedSlots: 2,
      slots: [
        STORAGE.slots[0],
        // Claims slot 0 as well -- position_index has no unique constraint.
        { ...STORAGE.slots[1], positionIndex: 0 }
      ]
    });
    renderOverlay();
    await loaded();
    await waitFor(() => expect(document.querySelector(".bases-inventory-slot-overflow-note")).toBeTruthy());
    expect(document.querySelector(".bases-inventory-slot-overflow-note")?.textContent).toContain("1 item has no place in the grid");
    expect(document.querySelectorAll(".bases-inventory-contents-row:not(.head)").length).toBe(1);
  });

  it("stays in list view when no slot reports a position", async () => {
    mockStorage({ ...STORAGE, usedSlots: 1, slots: [{ ...STORAGE.slots[0], positionIndex: null }] });
    renderOverlay();
    await loaded();
    expect(document.querySelectorAll(".bases-inventory-slot-cell").length).toBe(0);
    expect(document.querySelectorAll(".bases-inventory-contents-row:not(.head)").length).toBe(1);
  });

  it("ignores a response that settles after the overlay is gone", async () => {
    // Held on an object rather than a bare `let`: TS narrows a local assigned
    // only inside the executor callback to `never`, which makes calling it a
    // compile error.
    const deferred: { resolve?: (value: unknown) => void } = {};
    vi.mocked(vehiclesApi.storage).mockReturnValueOnce(new Promise((resolve) => { deferred.resolve = resolve; }) as never);
    const { unmount } = renderOverlay();
    unmount();
    cleanup();
    deferred.resolve?.(STORAGE);
    await Promise.resolve();
    expect(screen.queryByText("Slots Used")).toBeNull();
  });
});

describe("VehicleStorageOverlay deletion", () => {
  it("deletes a whole stack and refetches the hold", async () => {
    renderOverlay();
    await loaded();
    await toList();
    fireEvent.click(screen.getByRole("button", { name: "Delete Jasmium Crystal from slot 0" }));
    await waitFor(() => expect(vehiclesApi.deleteStorageItem).toHaveBeenCalled());
    // count omitted entirely for a whole slot -- the server treats an absent
    // count as "the whole slot" and a present one as an exact request.
    expect(vehiclesApi.deleteStorageItem).toHaveBeenCalledWith("2008", "501", "DELETE ITEM", undefined);
    await waitFor(() => expect(vehiclesApi.storage).toHaveBeenCalledTimes(2));
    expect(screen.getByText(/was deleted from the database/)).toBeTruthy();
  });

  it("does not call the API when the confirmation is declined", async () => {
    confirmAction.mockResolvedValue(false);
    renderOverlay();
    await loaded();
    await toList();
    fireEvent.click(screen.getByRole("button", { name: "Delete Jasmium Crystal from slot 0" }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(vehiclesApi.deleteStorageItem).not.toHaveBeenCalled();
  });

  it("sends a count for a partial removal and resets the amount to what remains", async () => {
    vi.mocked(vehiclesApi.deleteStorageItem).mockResolvedValue(deleteResult({
      partial: true,
      removed: { itemId: "501", templateId: "JasmiumCrystal", count: 100, remaining: 62, positionIndex: 0, qualityLevel: 0, currentDurability: null, maxDurability: null },
      message: "Removed 100 of JasmiumCrystal from the database, leaving 62."
    }) as never);
    renderOverlay();
    await loaded();
    await toList();
    // Two stacks share this template, so the row button is not unique -- the
    // first is slot 0, the 162 stack.
    fireEvent.click(screen.getAllByRole("button", { name: "Jasmium Crystal" })[0]);
    const input = screen.getByLabelText("Amount of Jasmium Crystal to remove") as HTMLInputElement;
    // Prefilled with the whole stack when the slot is selected.
    expect(input.value).toBe("162");
    fireEvent.change(input, { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove 100" }));
    await waitFor(() => expect(vehiclesApi.deleteStorageItem).toHaveBeenCalledWith("2008", "501", "DELETE ITEM", 100));
    // Without this reset the stale 162 would immediately trip the range error
    // on a *successful* delete.
    await waitFor(() => expect((screen.getByLabelText("Amount of Jasmium Crystal to remove") as HTMLInputElement).value).toBe("62"));
  });

  it("rejects an amount above the stack before calling the API", async () => {
    renderOverlay();
    await loaded();
    await toList();
    fireEvent.click(screen.getAllByRole("button", { name: "Jasmium Crystal" })[0]);
    fireEvent.change(screen.getByLabelText("Amount of Jasmium Crystal to remove"), { target: { value: "999" } });
    expect(screen.getByRole("alert").textContent).toContain("Enter an amount between 1 and 162");
    // The label flips to "Delete stack" at or above the stack size (same
    // expression the bases tab uses), but the button stays disabled -- an
    // over-count is refused, never widened into destroying the whole slot.
    expect((screen.getByRole("button", { name: "Delete stack" }) as HTMLButtonElement).disabled).toBe(true);
    expect(vehiclesApi.deleteStorageItem).not.toHaveBeenCalled();
  });

  it("disables deletion and explains why when the vehicle is in a blocked state", async () => {
    mockStorage({
      ...STORAGE,
      deleteSafety: {
        safe: false, known: true, state: "VehicleRecovery",
        reason: "This vehicle is currently VehicleRecovery and its cargo cannot be changed until that clears. Try again once the vehicle is no longer mid-transit or pending recovery."
      }
    });
    renderOverlay();
    await loaded();
    await toList();
    expect(document.body.textContent).toContain("This vehicle is currently VehicleRecovery");
    expect((screen.getByRole("button", { name: "Delete Jasmium Crystal from slot 0" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: /Bulk Delete Controls/i }) as HTMLInputElement).disabled).toBe(true);
  });

  it("withholds deletion when the vehicle's state could not be verified at all", async () => {
    mockStorage({
      ...STORAGE,
      deleteSafety: { safe: false, known: false, state: "", reason: "The console could not verify this vehicle's state, so cargo deletion is disabled." }
    });
    renderOverlay();
    await loaded();
    await toList();
    expect(document.body.textContent).toContain("could not verify this vehicle's state");
    expect((screen.getByRole("button", { name: "Delete Jasmium Crystal from slot 0" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports a failed delete inline and through onError, leaving the row listed", async () => {
    vi.mocked(vehiclesApi.deleteStorageItem).mockRejectedValueOnce(new Error("database is unreachable"));
    renderOverlay();
    await loaded();
    await toList();
    fireEvent.click(screen.getByRole("button", { name: "Delete Jasmium Crystal from slot 0" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("database is unreachable"));
    expect(onError).toHaveBeenCalledWith("database is unreachable");
    // The list stays valid -- a failed delete must not blank it behind a Retry.
    expect(document.querySelectorAll(".bases-inventory-contents-row:not(.head)").length).toBe(3);
  });
});

describe("VehicleStorageOverlay bulk deletion", () => {
  it("hides the checkboxes and bulk buttons until the toggle is on", async () => {
    renderOverlay();
    await loaded();
    await toList();
    expect(screen.queryByRole("button", { name: /Delete Selected/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete All/ })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Select .* for bulk delete/ })).toBeNull();

    await revealBulkControls();
    expect(screen.getByRole("button", { name: /Delete Selected/ })).toBeTruthy();
    expect(screen.getAllByRole("checkbox", { name: /for bulk delete/ }).length).toBe(3);
  });

  it("reveals nothing when the toggle confirmation is declined", async () => {
    renderOverlay();
    await loaded();
    await toList();
    confirmAction.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("checkbox", { name: /Bulk Delete Controls/i }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Delete All/ })).toBeNull();
  });

  it("hides again instantly with no confirmation when switched off", async () => {
    renderOverlay();
    await loaded();
    await toList();
    await revealBulkControls();
    const calls = confirmAction.mock.calls.length;
    fireEvent.click(screen.getByRole("checkbox", { name: /Bulk Delete Controls/i }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Delete All/ })).toBeNull());
    expect(confirmAction.mock.calls.length).toBe(calls);
  });

  it("deletes only the checked stacks", async () => {
    renderOverlay();
    await loaded();
    await toList();
    await revealBulkControls();
    const boxes = screen.getAllByRole("checkbox", { name: /for bulk delete/ });
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[2]);
    fireEvent.click(screen.getByRole("button", { name: /Delete Selected \(2\)/ }));
    await waitFor(() => expect(vehiclesApi.deleteStorageItems).toHaveBeenCalled());
    expect(vehiclesApi.deleteStorageItems).toHaveBeenCalledWith("2008", ["501", "503"], "DELETE ITEMS");
    await waitFor(() => expect(vehiclesApi.storage).toHaveBeenCalledTimes(2));
  });

  it("disables Delete Selected until at least one stack is checked", async () => {
    renderOverlay();
    await loaded();
    await toList();
    await revealBulkControls();
    expect((screen.getByRole("button", { name: /Delete Selected \(0\)/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("checkbox", { name: /for bulk delete/ })[0]);
    expect((screen.getByRole("button", { name: /Delete Selected \(1\)/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears the whole hold via Delete All", async () => {
    renderOverlay();
    await loaded();
    await toList();
    await revealBulkControls();
    fireEvent.click(screen.getByRole("button", { name: "Delete All" }));
    await waitFor(() => expect(vehiclesApi.deleteAllStorageItems).toHaveBeenCalledWith("2008", "DELETE ALL ITEMS"));
    await waitFor(() => expect(screen.getByText(/item\(s\) were deleted from the database/)).toBeTruthy());
  });

  it("does not call the bulk API when the confirmation is declined", async () => {
    renderOverlay();
    await loaded();
    await toList();
    await revealBulkControls();
    confirmAction.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete All" }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(2));
    expect(vehiclesApi.deleteAllStorageItems).not.toHaveBeenCalled();
  });

  it("keeps the header row and data rows structurally aligned when bulk-select is offered", async () => {
    renderOverlay();
    await loaded();
    await toList();
    await revealBulkControls();
    const head = document.querySelector(".bases-inventory-contents-row.head") as HTMLElement;
    const row = document.querySelector(".bases-inventory-contents-row:not(.head)") as HTMLElement;
    expect(head.classList.contains("with-checkbox")).toBe(true);
    expect(row.classList.contains("with-checkbox")).toBe(true);
    // Same child count, or the columns drift apart.
    expect(head.children.length).toBe(row.children.length);
  });

  it("resets the toggle to hidden every time the overlay is reopened", async () => {
    const { unmount } = renderOverlay();
    await loaded();
    await toList();
    await revealBulkControls();
    unmount();
    cleanup();

    renderOverlay();
    await loaded();
    await toList();
    expect(screen.queryByRole("button", { name: /Delete All/ })).toBeNull();
  });
});
