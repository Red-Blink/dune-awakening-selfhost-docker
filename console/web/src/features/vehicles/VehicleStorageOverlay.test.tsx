import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { VehicleStorage } from "../../api/vehicles";
import { vehiclesApi } from "../../api/vehicles";
import { VehicleStorageOverlay } from "./VehicleStorageOverlay";

vi.mock("../../api/vehicles", () => ({ vehiclesApi: { storage: vi.fn() } }));

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

function renderOverlay() {
  return render(<VehicleStorageOverlay vehicleId="2008" vehicleName="Sandcrawler" onClose={onClose} />);
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

  it("offers no mutation controls -- this view is read-only", async () => {
    renderOverlay();
    await loaded();
    await toList();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: /Add Item/i })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: /Delete/i })).toBeNull();
    expect(within(dialog).queryAllByRole("checkbox").length).toBe(0);
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
