import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { basesApi, type BaseInventory } from "../../api/bases";
import { BaseInventoryTab } from "./BaseInventoryTab";

vi.mock("../../api/bases", () => ({
  basesApi: {
    inventory: vi.fn()
  }
}));

const IMAGE = "/images/items/image-unavailable.png";

// One base holding the same template in two groups, so the group chips have
// something to actually change.
const PAYLOAD: BaseInventory = {
  supported: true,
  baseId: 1006,
  groups: [
    { key: "storage", name: "Storage", containerCount: 2, itemCount: 1240 },
    { key: "refining", name: "Refining", containerCount: 1, itemCount: 420 },
    // Empty groups are always present in the response; the chips filter them out.
    { key: "crafting", name: "Crafting", containerCount: 0, itemCount: 0 },
    { key: "machines", name: "Machines", containerCount: 0, itemCount: 0 }
  ],
  containers: [
    {
      placeableId: "40001", name: "Vault", typeName: "Storage Container", group: "storage",
      usedSlots: 2, maxSlots: 45, itemCount: 1200,
      items: [
        { templateId: "Stone", name: "Granite Stone", quantity: 1000 },
        { templateId: "MagnetiteOre", name: "Iron Ore", quantity: 200 }
      ]
    },
    {
      placeableId: "40002", name: "", typeName: "Small Storage Container", group: "storage",
      usedSlots: 1, maxSlots: 10, itemCount: 40,
      items: [{ templateId: "SpiceSand", name: "Spice Sand", quantity: 40 }]
    },
    {
      placeableId: "40003", name: "", typeName: "Small Ore Refinery", group: "refining",
      usedSlots: 1, maxSlots: 5, itemCount: 420,
      items: [{ templateId: "MagnetiteOre", name: "Iron Ore", quantity: 420 }]
    }
  ],
  items: [
    {
      templateId: "Stone", name: "Granite Stone", image: IMAGE, category: "resources",
      quantity: 1000, containerCount: 1,
      containers: [{ placeableId: "40001", name: "Vault", typeName: "Storage Container", group: "storage", quantity: 1000 }]
    },
    {
      templateId: "MagnetiteOre", name: "Iron Ore", image: IMAGE, category: "resources",
      quantity: 620, containerCount: 2,
      containers: [
        { placeableId: "40003", name: "", typeName: "Small Ore Refinery", group: "refining", quantity: 420 },
        { placeableId: "40001", name: "Vault", typeName: "Storage Container", group: "storage", quantity: 200 }
      ]
    },
    {
      templateId: "SpiceSand", name: "Spice Sand", image: IMAGE, category: "resources",
      quantity: 40, containerCount: 1,
      containers: [{ placeableId: "40002", name: "", typeName: "Small Storage Container", group: "storage", quantity: 40 }]
    }
  ],
  totals: { items: 1660, distinct: 3, containers: 3, usedSlots: 4, maxSlots: 60 }
};

function mockInventory(payload: BaseInventory = PAYLOAD) {
  vi.mocked(basesApi.inventory).mockResolvedValue(payload as never);
}

function renderTab() {
  render(<BaseInventoryTab baseId="1006" />);
}

// The totals row is the single "the tab has loaded" signal every test needs.
async function loaded() {
  await waitFor(() => expect(screen.getByText("Distinct")).toBeTruthy());
}

// The tab opens on Containers, so anything testing the rollup switches first.
function showItems() {
  fireEvent.click(screen.getByRole("button", { name: "Items" }));
}

function itemRows() {
  return [...document.querySelectorAll(".bases-inventory-item-row")];
}

function cards() {
  return [...document.querySelectorAll(".bases-inventory-cards .bases-card")];
}

// Group names appear twice on screen -- once as a filter chip, once as a
// section heading -- so both need addressing by role/class, never by text.
function groupHeadings() {
  return [...document.querySelectorAll(".bases-inventory-group-head h4")].map((node) => node.textContent);
}

function total(label: string) {
  const term = [...document.querySelectorAll(".bases-inventory-totals dt")]
    .find((node) => node.textContent === label);
  return term?.nextElementSibling?.textContent;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BaseInventoryTab", () => {
  it("shows the totals and the item rollup once loaded", async () => {
    mockInventory();
    renderTab();
    await loaded();
    showItems();

    expect(total("Items")).toBe("1,660");
    expect(total("Distinct")).toBe("3");
    expect(total("Containers")).toBe("3");
    // 4 of 60 slots.
    expect(total("Slots used")).toBe("7%");
    expect(itemRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining("Granite Stone"),
      expect.stringContaining("Iron Ore"),
      expect.stringContaining("Spice Sand")
    ]);
  });

  it("surfaces a load failure with a working retry", async () => {
    vi.mocked(basesApi.inventory).mockRejectedValueOnce(new Error("database is unreachable"));
    renderTab();

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("database is unreachable");

    mockInventory();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await loaded();
    expect(basesApi.inventory).toHaveBeenCalledTimes(2);
  });

  it("expands an item to show which containers hold it", async () => {
    mockInventory();
    renderTab();
    await loaded();
    showItems();

    fireEvent.click(itemRows()[1]);
    const breakdown = document.querySelector(".bases-inventory-breakdown");
    expect(breakdown?.textContent).toContain("Small Ore Refinery #40003");
    expect(breakdown?.textContent).toContain("Vault");
    expect(breakdown?.textContent).toContain("420");
    expect(breakdown?.textContent).toContain("200");
  });

  it("switches between the item rollup and the container cards without refetching", async () => {
    mockInventory();
    renderTab();
    await loaded();

    // Opens on Containers.
    expect(itemRows()).toHaveLength(0);
    expect(cards()).toHaveLength(3);
    expect(groupHeadings()).toEqual(["Storage", "Refining"]);

    showItems();
    expect(cards()).toHaveLength(0);
    expect(itemRows()).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Containers" }));
    expect(cards()).toHaveLength(3);
    expect(basesApi.inventory).toHaveBeenCalledTimes(1);
  });

  it("sorts containers by their displayed label within each group", async () => {
    mockInventory({
      ...PAYLOAD,
      groups: [
        { key: "storage", name: "Storage", containerCount: 4, itemCount: 0 },
        { key: "refining", name: "Refining", containerCount: 0, itemCount: 0 },
        { key: "crafting", name: "Crafting", containerCount: 0, itemCount: 0 },
        { key: "machines", name: "Machines", containerCount: 0, itemCount: 0 }
      ],
      // Deliberately out of order, and mixing renamed with unrenamed: a
      // rename has to file under the name shown on the card, and "#9" has to
      // sort ahead of "#10" rather than lexically after it.
      containers: [
        { placeableId: "10", name: "", typeName: "Chest", group: "storage", usedSlots: 0, maxSlots: 20, itemCount: 0, items: [] },
        { placeableId: "9", name: "", typeName: "Chest", group: "storage", usedSlots: 0, maxSlots: 20, itemCount: 0, items: [] },
        { placeableId: "77", name: "Zeta Vault", typeName: "Storage Container", group: "storage", usedSlots: 0, maxSlots: 45, itemCount: 0, items: [] },
        { placeableId: "88", name: "Alpha Vault", typeName: "Storage Container", group: "storage", usedSlots: 0, maxSlots: 45, itemCount: 0, items: [] }
      ],
      items: [],
      totals: { items: 0, distinct: 0, containers: 4, usedSlots: 0, maxSlots: 130 }
    });
    renderTab();
    await loaded();

    const titles = cards().map((card) => card.querySelector(".bases-card-title")?.textContent);
    expect(titles).toEqual(["Alpha Vault", "Chest", "Chest", "Zeta Vault"]);
    // The two Chests are ordered #9 before #10, not lexically.
    expect(cards()[1].textContent).toContain("#9");
    expect(cards()[2].textContent).toContain("#10");
  });

  it("names an unrenamed container by its type and id", async () => {
    mockInventory();
    renderTab();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Containers" }));

    const silo = cards().find((card) => card.textContent?.includes("Small Storage Container"));
    expect(silo?.textContent).toContain("#40002");
  });

  it("filters both views by group, restating quantities to the group's share", async () => {
    mockInventory();
    renderTab();
    await loaded();
    showItems();

    fireEvent.click(screen.getByRole("button", { name: /Refining/ }));
    // Only Iron Ore lives in a refining container, and only 420 of its 620.
    const rows = itemRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Iron Ore");
    expect(rows[0].textContent).toContain("420");
    expect(rows[0].textContent).not.toContain("620");

    fireEvent.click(screen.getByRole("button", { name: "Containers" }));
    expect(cards()).toHaveLength(1);
    expect(cards()[0].textContent).toContain("Small Ore Refinery");

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(cards()).toHaveLength(3);
  });

  it("only filters on submit, and Clear restores everything", async () => {
    mockInventory();
    renderTab();
    await loaded();
    showItems();

    const input = screen.getByLabelText("Filter base inventory");
    fireEvent.change(input, { target: { value: "iron" } });
    expect(itemRows()).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(itemRows()).toHaveLength(1);
    expect(itemRows()[0].textContent).toContain("Iron Ore");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(itemRows()).toHaveLength(3);
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("reports a filter that matches nothing", async () => {
    mockInventory();
    renderTab();
    await loaded();
    showItems();

    fireEvent.change(screen.getByLabelText("Filter base inventory"), { target: { value: "sandworm" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(screen.getByText("No items match this filter.")).toBeTruthy();
  });

  it("caps the rollup and lifts the cap on demand", async () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      templateId: `Item${index}`,
      name: `Item ${index}`,
      image: IMAGE,
      category: "resources",
      quantity: 100 - index,
      containerCount: 1,
      containers: [{ placeableId: "40001", name: "Vault", typeName: "Storage Container", group: "storage" as const, quantity: 100 - index }]
    }));
    mockInventory({ ...PAYLOAD, items: many });
    renderTab();
    await loaded();
    showItems();

    expect(itemRows()).toHaveLength(25);
    fireEvent.click(screen.getByRole("button", { name: "Show all 30 items" }));
    expect(itemRows()).toHaveLength(30);
    fireEvent.click(screen.getByRole("button", { name: "Show fewer items" }));
    expect(itemRows()).toHaveLength(25);
  });

  it("says so plainly when a base stores nothing", async () => {
    mockInventory({
      ...PAYLOAD,
      groups: PAYLOAD.groups.map((group) => ({ ...group, containerCount: 0, itemCount: 0 })),
      containers: [],
      items: [],
      totals: { items: 0, distinct: 0, containers: 0, usedSlots: 0, maxSlots: 0 }
    });
    renderTab();
    await loaded();

    expect(screen.getByText("No storage at this base.")).toBeTruthy();
    // A base with no containers has no group chips to offer beyond All.
    expect(document.querySelectorAll(".bases-inventory-chip")).toHaveLength(1);

    showItems();
    expect(screen.getByText("No stored items at this base.")).toBeTruthy();
  });

  it("opens a container's contents in an overlay and closes it four ways", async () => {
    mockInventory();
    renderTab();
    await loaded();

    const vault = cards().find((card) => card.textContent?.includes("Vault")) as HTMLElement;
    // The button reports the stack count without opening anything.
    expect(within(vault).getByRole("button", { name: /View Contents/ }).textContent).toContain("2 distinct");
    expect(screen.queryByRole("dialog")).toBeNull();

    function open() {
      fireEvent.click(within(cards().find((c) => c.textContent?.includes("Vault")) as HTMLElement)
        .getByRole("button", { name: /View Contents/ }));
      return screen.getByRole("dialog");
    }

    const dialog = open();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // Header identifies the container, body lists every stack with quantities.
    expect(within(dialog).getByRole("heading", { name: "Vault" })).toBeTruthy();
    expect(dialog.textContent).toContain("Storage Container · #40001");
    expect(within(dialog).getByText("Granite Stone")).toBeTruthy();
    expect(within(dialog).getByText("1,000")).toBeTruthy();
    expect(within(dialog).getByText("Iron Ore")).toBeTruthy();
    expect(within(dialog).getByText("200")).toBeTruthy();
    // Not the other containers' contents.
    expect(within(dialog).queryByText("Spice Sand")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    open();
    fireEvent.click(screen.getByRole("button", { name: "Close contents" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    open();
    fireEvent.mouseDown(document.querySelector(".modal-overlay") as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers no contents button for an empty container", async () => {
    mockInventory({
      ...PAYLOAD,
      containers: [{
        placeableId: "40009", name: "", typeName: "Repair Station", group: "machines",
        usedSlots: 0, maxSlots: 5, itemCount: 0, items: []
      }],
      groups: PAYLOAD.groups.map((g) => g.key === "machines"
        ? { ...g, containerCount: 1, itemCount: 0 }
        : { ...g, containerCount: 0, itemCount: 0 })
    });
    renderTab();
    await loaded();

    expect(screen.queryByRole("button", { name: /View Contents/ })).toBeNull();
    expect(cards()[0].textContent).toContain("Empty");
  });

  it("keeps the overlay open when a filter would exclude its container", async () => {
    // The overlay resolves its container from the unfiltered response, so
    // applying a group chip behind it must not blank the dialog.
    mockInventory();
    renderTab();
    await loaded();

    fireEvent.click(within(cards().find((c) => c.textContent?.includes("Vault")) as HTMLElement)
      .getByRole("button", { name: /View Contents/ }));
    fireEvent.click(screen.getByRole("button", { name: /Refining/ }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain("Granite Stone");
  });

  it("shows an empty container rather than hiding it", async () => {
    mockInventory();
    renderTab();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Containers" }));

    const vault = cards().find((card) => card.textContent?.includes("Vault"));
    expect(within(vault as HTMLElement).getByText("2 / 45")).toBeTruthy();
  });
});
