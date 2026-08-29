import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApi } from "../../api/admin";
import { basesApi, type BaseContainerSlots, type BaseInventory } from "../../api/bases";
import { BaseInventoryTab } from "./BaseInventoryTab";
// Only this file needs the real cascade: jsdom applies no CSS at all unless a
// stylesheet is actually imported, so the column-hiding, header/body-split
// and control-sizing assertions below would otherwise silently check nothing
// against real rules. jsdom has no layout engine, so this only reaches
// declared computed-style facts (display, position, explicit height/padding/
// colour) -- not actual pixel geometry (rendered widths, "does the header
// visually stay put while scrolling"), which stays a live-browser check.
import "../../styles.css";

// Raised from the 5s default for this file only. Importing the real stylesheet
// above means jsdom runs the full cascade on every query, which makes this file
// roughly an order of magnitude slower than the rest of the suite (~75s for its
// tests, with csstree-match hitting its own iteration ceiling). Under full-suite
// parallelism a single test can drift past 5s and time out while still passing
// in isolation. Scoped here rather than set globally in vitest.config.ts so a
// genuine hang anywhere else still fails fast.
vi.setConfig({ testTimeout: 20000 });

vi.mock("../../api/bases", () => ({
  basesApi: {
    inventory: vi.fn(),
    containerSlots: vi.fn(),
    deleteContainerItem: vi.fn(),
    addContainerItem: vi.fn(),
    deleteContainerItems: vi.fn(),
    deleteAllContainerItems: vi.fn(),
    giveContainerItem: vi.fn(),
    giveContainerItems: vi.fn(),
    fillContainerItem: vi.fn()
  }
}));

// Both the Add panel (ItemCatalogSelector) and the Give/Fill panels
// (ItemCatalogCombobox) fetch the full item catalog via adminApi.itemCatalog()
// on mount -- every test that opens the contents overlay needs this mocked,
// the same way every other consumer of ItemCatalogSelector/ItemCatalogCombobox
// already mocks it (see CharacterAdminUI.skills.test.tsx). Left empty here;
// mockCatalog() below provides the actual default response, configurable
// per-test.
vi.mock("../../api/admin", () => ({
  adminApi: {
    itemCatalog: vi.fn()
  }
}));

const IMAGE = "/images/items/image-unavailable.png";

// Small, realistic catalog fixture -- real fillable groups on AzuriteOre/
// PlantFiber/SteelBar/Stone (matching FILLABLE_GROUPS in adminCatalog.js),
// and a non-fillable weapon so the Fill combobox's group filtering has
// something real to exclude. Stone/MagnetiteOre are the templates SLOTS'
// own default fixture uses -- Stone is included here so
// "click a slot to populate Give/Fill" tests have a real, resolvable
// catalog match; MagnetiteOre is deliberately left OUT of the catalog so
// a slot-click test can also prove the "not in the loaded catalog" no-op
// path (distinct from the "not in a fillable group" no-op path
// SilverSword_Ranger already covers).
const CATALOG_ITEMS = [
  { id: "AzuriteOre", itemId: "AzuriteOre", name: "AzuriteOre", category: "resources", source: "Resources", group: "raw_resource", image: IMAGE },
  { id: "PlantFiber", itemId: "PlantFiber", name: "PlantFiber", category: "resources", source: "Resources", group: "raw_resource", image: IMAGE },
  { id: "SteelBar", itemId: "SteelBar", name: "SteelBar", category: "resources", source: "Resources", group: "refined_resource", image: IMAGE },
  { id: "Stone", itemId: "Stone", name: "Granite Stone", category: "resources", source: "Resources", group: "raw_resource", image: IMAGE },
  { id: "SilverSword_Ranger", itemId: "SilverSword_Ranger", name: "SilverSword_Ranger", category: "weapons", source: "Weapons", group: "weapon", image: IMAGE },
  // Used by the Add-panel-specific tests below (ItemCatalogSelector, not the
  // Give/Fill combobox) -- kept in the shared catalog so mockCatalog()'s
  // default covers both this fork's Give/Fill tests and upstream's Add tests.
  { id: "ScrapMetal", itemId: "ScrapMetal", name: "Scrap Metal", category: "resource", source: "Resources", group: "raw_resource", image: IMAGE },
  { id: "UniqueSword_05", itemId: "UniqueSword_05", name: "Karpov 38", category: "weapon", source: "Weapons", group: "weapon", image: IMAGE }
];

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
    { key: "other", name: "Other", containerCount: 0, itemCount: 0 }
  ],
  containers: [
    {
      // Vault deliberately carries real volume figures -- the one container
      // in this fixture with volume tracking on, so tests can assert the
      // Volume Used row renders with real numbers as well as being withheld
      // elsewhere (issue #356).
      placeableId: "40001", name: "Vault", typeName: "Storage Container", group: "storage",
      usedSlots: 2, maxSlots: 45, currentVolume: 120, maxVolume: 500, itemCount: 1200,
      items: [
        { templateId: "Stone", name: "Granite Stone", quantity: 1000 },
        { templateId: "MagnetiteOre", name: "Iron Ore", quantity: 200 }
      ]
    },
    {
      // 0/0 -- a schema without volume tracking (issue #356), or a container
      // whose inventory just has no cap. Row must be withheld, not shown as
      // a misleading 0/0.
      placeableId: "40002", name: "", typeName: "Small Storage Container", group: "storage",
      usedSlots: 1, maxSlots: 10, currentVolume: 0, maxVolume: 0, itemCount: 40,
      items: [{ templateId: "SpiceSand", name: "Spice Sand", quantity: 40 }]
    },
    {
      placeableId: "40003", name: "", typeName: "Small Ore Refinery", group: "refining",
      usedSlots: 1, maxSlots: 5, currentVolume: 0, maxVolume: 0, itemCount: 420,
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
  totals: { items: 1660, distinct: 3, containers: 3, usedSlots: 4, maxSlots: 60, currentVolume: 120, maxVolume: 500 }
};

// The Vault's slots. Deliberately two stacks of the SAME template: that is the
// case the merged items[] collapses into one line and the per-slot view must
// keep apart.
const SLOTS: BaseContainerSlots = {
  supported: true,
  found: true,
  baseId: 1006,
  placeableId: "40001",
  typeName: "Storage Container",
  group: "storage",
  maxSlots: 45,
  usedSlots: 3,
  deleteSafety: { safe: true, known: true, map: "HaggaBasin", partitionId: 1, reason: "" },
  addSafety: { safe: true, known: true, map: "HaggaBasin", partitionId: 1, reason: "" },
  currentVolume: 120,
  maxVolume: 500,
  inventories: [
    {
      inventoryId: "9001",
      maxSlots: 45,
      usedSlots: 3,
      currentVolume: 120,
      maxVolume: 500,
      slots: [
        { itemId: "501", templateId: "Stone", name: "Granite Stone", positionIndex: 0, quantity: 600, qualityLevel: 0, currentDurability: null, maxDurability: null, augments: [] },
        { itemId: "502", templateId: "MagnetiteOre", name: "Iron Ore", positionIndex: 1, quantity: 200, qualityLevel: 0, currentDurability: null, maxDurability: null, augments: [] },
        { itemId: "503", templateId: "Stone", name: "Granite Stone", positionIndex: 2, quantity: 400, qualityLevel: 0, currentDurability: null, maxDurability: null, augments: [] }
      ]
    }
  ]
};

function mockInventory(payload: BaseInventory = PAYLOAD) {
  vi.mocked(basesApi.inventory).mockResolvedValue(payload as never);
}

function mockSlots(payload: BaseContainerSlots = SLOTS) {
  vi.mocked(basesApi.containerSlots).mockResolvedValue(payload as never);
}

function mockCatalog(items = CATALOG_ITEMS) {
  vi.mocked(adminApi.itemCatalog).mockResolvedValue({ rows: items } as never);
}

// Typed with the real signature rather than inferred from `async () => true`,
// so assertions can reach the options argument (the crafting warning) instead
// of indexing into an empty tuple.
type ConfirmOptions = {
  title?: string;
  confirmLabel?: string;
  warning?: string;
  danger?: boolean;
  details?: { label: string; value: string; tone?: "accent" | "success" | "danger" }[];
};
const confirmAction = vi.fn(async (_message: string, _options?: ConfirmOptions) => true);
const onError = vi.fn();

function renderTab() {
  render(<BaseInventoryTab baseId="1006" baseName="Test Base" confirmAction={confirmAction} onError={onError} />);
}

// Opens the Vault's contents overlay and waits for its slots to land. Finds
// the card by name rather than taking the first: the cards sort on their
// rendered label, so "Small Storage Container #40002" precedes "Vault".
//
// The overlay opens on GRID, so this waits for cells, then switches to list
// for the tests that assert on rows. Tests about the grid itself call
// openVaultContents({ stayOnGrid: true }).
async function openVaultContents({ stayOnGrid = false } = {}) {
  const vault = [...document.querySelectorAll(".bases-inventory-cards .bases-card")]
    .find((card) => card.textContent?.includes("Vault")) as HTMLElement;
  fireEvent.click(within(vault).getByRole("button", { name: /View Contents/ }));
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  await waitFor(() => expect(document.querySelectorAll(".bases-inventory-slot-cell").length).toBeGreaterThan(0));
  if (stayOnGrid) return;
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /List/ }));
  await waitFor(() => expect(document.querySelectorAll(".bases-inventory-contents-row:not(.head)").length).toBeGreaterThan(0));
}

// Add Item lives only in list view (grid's empty cells are its own
// affordance there), so a test asserting on the button from a grid-view start
// has to switch first.
async function switchToList() {
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /List/ }));
  await waitFor(() => expect(document.querySelectorAll(".bases-inventory-contents-row:not(.head)").length).toBeGreaterThan(0));
}

// The totals row is the single "the tab has loaded" signal every test needs.
async function loaded() {
  await waitFor(() => expect(screen.getByText("Distinct")).toBeTruthy());
}

// Selects an item from ItemCatalogCombobox the same way a real player would:
// type into the labeled input, wait for the matching option to appear, then
// click it -- typing alone never commits a selection (a player could type
// something the server would reject, or half a name, without this).
async function pickItem(ariaLabel: string, itemName: string) {
  const input = screen.getByRole("combobox", { name: ariaLabel });
  fireEvent.change(input, { target: { value: itemName } });
  // A plain substring-match function, not a dynamically-built RegExp --
  // avoids constructing a regex from a variable (ReDoS lint concern),
  // which is unnecessary here anyway since these are exact fixture names.
  const option = await waitFor(() => screen.getByRole("option", { name: (accessibleName) => accessibleName.includes(itemName) }));
  fireEvent.mouseDown(option);
}

// Give/Fill share one combobox+quantity input, switched by this mode
// toggle (consolidated 2026-08-19, "Alternative A" from the UI/UX hat's
// design review) -- the Give/Fill panel opens in Give mode by default, so
// any test targeting Fill's own combobox/button/warning must switch first.
function switchToFillMode() {
  fireEvent.click(screen.getByRole("button", { name: "Fill" }));
}

// The whole Give/Fill panel, AND the bulk-delete surface (per-row
// multi-select checkboxes, Delete Selected, Delete All), are hidden by
// default (issue #371, widened same day to also cover bulk delete) behind
// one shared visibility toggle that requires acknowledging a
// confirmAction() dialog before it reveals anything -- confirmAction is
// mocked to always resolve true (see the const above), so this just needs
// to click the toggle and wait for the Give/Fill panel to actually mount.
// Any test targeting the combobox, quantity field, mode toggle, batch
// list, bulk-select checkboxes, Delete Selected, or Delete All must call
// this first. Named showGiveFill (not renamed to something more generic)
// since every existing call site already reads that way and it still
// accurately describes what it waits for (the Give/Fill panel's own
// "Give" button) even though the toggle it clicks now gates more than
// that panel.
async function showGiveFill() {
  // The checkbox's accessible name includes its own ON/OFF state text
  // (a sibling <strong>), not just the "Give / Fill / Delete Controls"
  // label -- matched with a substring rather than the exact string so
  // this does not need updating if the state text changes.
  fireEvent.click(screen.getByRole("checkbox", { name: /Give \/ Fill \/ Delete Controls/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Give" })).toBeTruthy());
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
  confirmAction.mockResolvedValue(true);
  // Every test that opens the contents overlay needs slots; the ones that
  // don't are unaffected by the default.
  mockSlots();
  // Every mount of ItemCatalogCombobox (the Give/Fill panels) fetches the
  // catalog -- needed even for tests that never touch Give/Fill, since the
  // combobox mounts as soon as the contents overlay opens for a storage
  // container.
  mockCatalog();
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
    // 120 of 500 volume (issue #356) -- only the Vault carries volume in this
    // fixture, and its 120/500 is also the tab-wide total since the other
    // two containers are 0/0.
    expect(total("Volume used")).toBe("24%");
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
        { key: "other", name: "Other", containerCount: 0, itemCount: 0 }
      ],
      // Deliberately out of order, and mixing renamed with unrenamed: a
      // rename has to file under the name shown on the card, and "#9" has to
      // sort ahead of "#10" rather than lexically after it.
      containers: [
        { placeableId: "10", name: "", typeName: "Chest", group: "storage", usedSlots: 0, maxSlots: 20, currentVolume: 0, maxVolume: 0, itemCount: 0, items: [] },
        { placeableId: "9", name: "", typeName: "Chest", group: "storage", usedSlots: 0, maxSlots: 20, currentVolume: 0, maxVolume: 0, itemCount: 0, items: [] },
        { placeableId: "77", name: "Zeta Vault", typeName: "Storage Container", group: "storage", usedSlots: 0, maxSlots: 45, currentVolume: 0, maxVolume: 0, itemCount: 0, items: [] },
        { placeableId: "88", name: "Alpha Vault", typeName: "Storage Container", group: "storage", usedSlots: 0, maxSlots: 45, currentVolume: 0, maxVolume: 0, itemCount: 0, items: [] }
      ],
      items: [],
      totals: { items: 0, distinct: 0, containers: 4, usedSlots: 0, maxSlots: 130, currentVolume: 0, maxVolume: 0 }
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

  // An unreadable schema is a settled answer, not a failure: it arrives as a
  // normal 200 and must not offer a Retry, which could only fail identically.
  it("states an unsupported schema without offering a retry", async () => {
    mockInventory({
      supported: false,
      reason: "Unsupported by detected schema. Missing required table(s): dune.items",
      baseId: 1006,
      groups: [],
      containers: [],
      items: [],
      totals: { items: 0, distinct: 0, containers: 0, usedSlots: 0, maxSlots: 0, currentVolume: 0, maxVolume: 0 }
    });
    renderTab();

    expect(await screen.findByText(/Missing required table\(s\): dune\.items/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    // None of the tab's own controls render, so there is nothing to interact
    // with that would imply the data is merely empty.
    expect(screen.queryByRole("button", { name: "Containers" })).not.toBeInTheDocument();
    expect(screen.queryByText("Slots used")).not.toBeInTheDocument();
  });

  it("says so plainly when a base stores nothing", async () => {
    mockInventory({
      ...PAYLOAD,
      groups: PAYLOAD.groups.map((group) => ({ ...group, containerCount: 0, itemCount: 0 })),
      containers: [],
      items: [],
      totals: { items: 0, distinct: 0, containers: 0, usedSlots: 0, maxSlots: 0, currentVolume: 0, maxVolume: 0 }
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
    // Header identifies the container, body lists every SLOT with quantities.
    // Slots arrive in their own request, so the body fills in after the open.
    expect(within(dialog).getByRole("heading", { name: "Vault" })).toBeTruthy();
    expect(dialog.textContent).toContain("Storage Container · #40001");
    // The overlay opens on grid, where names live in tile tooltips rather than
    // as text; switch to list to read them.
    await waitFor(() => expect(document.querySelectorAll(".bases-inventory-slot-cell").length).toBeGreaterThan(0));
    fireEvent.click(within(dialog).getByRole("button", { name: /List/ }));
    await waitFor(() => expect(within(dialog).getAllByText("Granite Stone").length).toBe(2));
    // Two stacks of one template stay apart at their own quantities rather
    // than merging into the 1,000 the rollup reports.
    expect(within(dialog).getByText("600")).toBeTruthy();
    expect(within(dialog).getByText("400")).toBeTruthy();
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

  // Issue #347 (found during manual UI review): an empty Storage container
  // used to render bare "Empty" text with no click target at all, making it
  // permanently unreachable -- exactly the container an operator most needs
  // to open, to Give/Fill something into it. The button must always exist;
  // only its trailing label (distinct-count vs "Empty") changes.
  it("still offers a working contents button for an empty container, labelled Empty", async () => {
    mockInventory({
      ...PAYLOAD,
      containers: [{
        placeableId: "40009", name: "", typeName: "Repair Station", group: "other",
        usedSlots: 0, maxSlots: 5, currentVolume: 0, maxVolume: 0, itemCount: 0, items: []
      }],
      groups: PAYLOAD.groups.map((g) => g.key === "other"
        ? { ...g, containerCount: 1, itemCount: 0 }
        : { ...g, containerCount: 0, itemCount: 0 })
    });
    mockSlots({
      supported: true, found: true, baseId: 1006, placeableId: "40009",
      typeName: "Repair Station", group: "other", maxSlots: 5, usedSlots: 0,
      currentVolume: 0, maxVolume: 0,
      deleteSafety: { safe: false, known: true, map: "HaggaBasin", partitionId: 1, reason: "Item deletion is available only for Storage containers." },
      inventories: [{ inventoryId: "9009", maxSlots: 5, usedSlots: 0, currentVolume: 0, maxVolume: 0, slots: [] }]
    });
    renderTab();
    await loaded();

    const button = screen.getByRole("button", { name: /View Contents/ });
    expect(button.textContent).toContain("Empty");
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  });

  it("keeps the overlay open when a filter would exclude its container", async () => {
    // The overlay resolves its container from the unfiltered response, so
    // applying a group chip behind it must not blank the dialog.
    mockInventory();
    renderTab();
    await loaded();

    fireEvent.click(within(cards().find((c) => c.textContent?.includes("Vault")) as HTMLElement)
      .getByRole("button", { name: /View Contents/ }));
    // Wait for the slots request, and read names from the list view -- the
    // grid the overlay opens on keeps them in tooltips.
    await waitFor(() => expect(document.querySelectorAll(".bases-inventory-slot-cell").length).toBeGreaterThan(0));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /List/ }));
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("Granite Stone"));
    fireEvent.click(screen.getByRole("button", { name: /Refining/ }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain("Granite Stone");
  });

  it("fetches slots per container rather than with the tab", async () => {
    mockInventory();
    renderTab();
    await loaded();
    // The base tab must not carry every slot at the base -- that tripled the
    // response on large bases -- so nothing is requested until a container
    // is actually opened.
    expect(basesApi.containerSlots).not.toHaveBeenCalled();
    await openVaultContents();
    expect(basesApi.containerSlots).toHaveBeenCalledWith("1006", "40001");
  });

  it("shows each slot separately with its own slot number", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    const rows = [...document.querySelectorAll(".bases-inventory-contents-row:not(.head)")];
    expect(rows.length).toBe(3);
    // The two Granite Stone stacks are only distinguishable by slot number.
    expect(rows[0].textContent).toContain("#0");
    expect(rows[2].textContent).toContain("#2");
  });

  // Per explicit operator direction (2026-08-19): clicking an item already
  // in the container also populates the shared Give/Fill combobox with
  // that same item, so giving more of something already sitting in the
  // container does not require re-typing/re-searching its name.
  // Give/Fill is hidden by default (issue #371) -- clicking a fillable
  // item reveals it via the same confirm-and-warn path the visibility
  // toggle itself uses (confirmAction is mocked to always resolve true),
  // rather than the click being a no-op just because the panel was hidden.
  it("populates the Give/Fill combobox when a List row is clicked, revealing the panel if hidden", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    expect(screen.queryByRole("combobox", { name: "Item to give" })).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Granite Stone" })[0]);
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Item to give" }) as HTMLInputElement).value).toBe("Granite Stone"));
  });

  it("populates the Give/Fill combobox when a Grid cell is clicked, revealing the panel if hidden", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents({ stayOnGrid: true });

    fireEvent.click(screen.getByRole("button", { name: /Granite Stone ×600, slot 0/ }));
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Item to give" }) as HTMLInputElement).value).toBe("Granite Stone"));
  });

  it("populates whichever mode (Fill) is currently active, not just Give", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();
    switchToFillMode();

    fireEvent.click(screen.getAllByRole("button", { name: "Granite Stone" })[0]);
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Item to fill" }) as HTMLInputElement).value).toBe("Granite Stone"));
  });

  it("does not populate Give/Fill for an item not in a fillable group (e.g. a weapon), and does not reveal the panel", async () => {
    mockInventory();
    mockSlots({
      ...SLOTS,
      inventories: [{
        ...SLOTS.inventories[0],
        slots: [{ itemId: "901", templateId: "SilverSword_Ranger", name: "SilverSword_Ranger", positionIndex: 0, quantity: 1, qualityLevel: 0, currentDurability: null, maxDurability: null, augments: [] }]
      }]
    });
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.click(screen.getAllByRole("button", { name: "SilverSword_Ranger" })[0]);
    expect(screen.queryByRole("combobox", { name: "Item to give" })).toBeNull();
  });

  it("does not populate Give/Fill for an item not present in the loaded catalog at all, and does not reveal the panel", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    // MagnetiteOre (Iron Ore) is deliberately absent from CATALOG_ITEMS --
    // the click must no-op rather than throw or populate a fabricated item.
    fireEvent.click(screen.getAllByRole("button", { name: "Iron Ore" })[0]);
    expect(screen.queryByRole("combobox", { name: "Item to give" })).toBeNull();
  });

  it("still selects the slot for the delete strip when a Give/Fill-ineligible item is clicked", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    // Iron Ore is not in the loaded catalog (see the test above), so it
    // must not populate Give/Fill -- but the existing delete-selection
    // behavior this same click already performs must be completely
    // unaffected by that no-op.
    fireEvent.click(screen.getAllByRole("button", { name: "Iron Ore" })[0]);
    await waitFor(() => expect(document.querySelector(".bases-inventory-slot-detail")).toBeTruthy());
    expect(screen.getByLabelText(/Amount of Iron Ore to remove/)).toBeTruthy();
  });

  // Found during PR #349's own Layer 3 audit (Architect hat): the header row
  // and each data row must have the SAME number of children in the SAME
  // order, or styles.css's nth-child-based column alignment (e.g. right-
  // aligning "Qty") silently targets the wrong column the moment the
  // with-checkbox modifier adds an extra leading <span/> for bulk-select.
  // This test can't compute actual CSS (jsdom doesn't run a layout engine),
  // but it locks in the one thing that actually determines whether the
  // nth-child selectors line up: identical child counts, header vs. data.
  it("keeps the header row and data rows structurally aligned when bulk-select is offered", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    // bulk-select (and its "with-checkbox" column) is now gated behind the
    // destructive-controls toggle (issue #371) -- must be revealed first.
    await showGiveFill();

    const header = document.querySelector(".bases-inventory-contents-row.head");
    const dataRow = document.querySelector(".bases-inventory-contents-row:not(.head)");
    expect(header).toBeTruthy();
    expect(dataRow).toBeTruthy();
    expect(header?.classList.contains("with-checkbox")).toBe(true);
    expect(dataRow?.classList.contains("with-checkbox")).toBe(true);
    // Same child count is what makes nth-child(N) mean the same column in
    // both rows -- a header with 5 children and a data row with 6 (or vice
    // versa) is exactly the class of bug this test exists to catch.
    expect(header?.children.length).toBe(dataRow?.children.length);
  });

  it("switches to a grid that renders every empty slot", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.click(screen.getByRole("button", { name: /Grid/ }));
    await waitFor(() => expect(document.querySelector(".bases-inventory-slot-grid")).toBeTruthy());
    // 45 capacity: 3 filled, 42 empty.
    expect(document.querySelectorAll(".bases-inventory-slot-cell").length).toBe(45);
    expect(document.querySelectorAll(".bases-inventory-slot-cell.empty").length).toBe(42);
  });

  it("keeps a duplicate or out-of-range slot reachable instead of dropping it", async () => {
    mockInventory();
    // position_index has no unique constraint and is not bounded by
    // max_item_count, so both of these are reachable in real data. An item the
    // delete button cannot reach is the worst outcome, so neither may vanish.
    mockSlots({
      ...SLOTS,
      inventories: [{
        inventoryId: "9001", maxSlots: 4, usedSlots: 3, currentVolume: 0, maxVolume: 0,
        slots: [
          { itemId: "601", templateId: "Stone", name: "Granite Stone", positionIndex: 1, quantity: 10, qualityLevel: 0, currentDurability: null, maxDurability: null, augments: [] },
          { itemId: "602", templateId: "MagnetiteOre", name: "Iron Ore", positionIndex: 1, quantity: 20, qualityLevel: 0, currentDurability: null, maxDurability: null, augments: [] },
          { itemId: "603", templateId: "SpiceSand", name: "Spice Sand", positionIndex: 99, quantity: 30, qualityLevel: 0, currentDurability: null, maxDurability: null, augments: [] }
        ]
      }]
    });
    renderTab();
    await loaded();
    await openVaultContents();
    fireEvent.click(screen.getByRole("button", { name: /Grid/ }));

    await waitFor(() => expect(document.querySelector(".bases-inventory-slot-overflow-note")).toBeTruthy());
    // One wins the cell; the duplicate and the out-of-range one are listed below.
    const overflow = [...document.querySelectorAll(".bases-inventory-contents-row:not(.head)")];
    expect(overflow.length).toBe(2);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Iron Ore");
    expect(dialog.textContent).toContain("Spice Sand");
  });

  it("deletes a whole stack and refetches both the slots and the tab", async () => {
    mockInventory();
    vi.mocked(basesApi.deleteContainerItem).mockResolvedValue({
      supported: true,
      result: {
        ok: true, partial: false, typeName: "Storage Container", group: "storage",
        removed: { itemId: "501", templateId: "Stone", count: 600, remaining: 0 },
        message: "Stone was deleted from the database.",
        deleteSafety: { safe: true, known: true, map: "HaggaBasin", partitionId: 1, reason: "" }
      }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.click(screen.getAllByRole("button", { name: /^Delete Granite Stone/ })[0]);
    await waitFor(() => expect(basesApi.deleteContainerItem).toHaveBeenCalled());
    // Whole-slot delete sends no count at all -- an explicit count equal to the
    // stack would be a different request shape.
    expect(vi.mocked(basesApi.deleteContainerItem).mock.calls[0].slice(0, 4))
      .toEqual(["1006", "40001", "501", "DELETE ITEM"]);
    expect(vi.mocked(basesApi.deleteContainerItem).mock.calls[0][4]).toBeUndefined();
    // Totals, group counts and the rollup are all derived, so the tab reloads too.
    await waitFor(() => expect(vi.mocked(basesApi.inventory).mock.calls.length).toBeGreaterThan(1));
  });

  it("does not call the API when the confirmation is declined", async () => {
    mockInventory();
    confirmAction.mockResolvedValue(false);
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.click(screen.getAllByRole("button", { name: /^Delete Granite Stone/ })[0]);
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(basesApi.deleteContainerItem).not.toHaveBeenCalled();
  });

  // CORRECTED 2026-08-19: the backend no longer ever sends
  // deleteSafety.safe: false for a storage-group container --
  // baseContainerDeleteSafety's map-liveness check was removed (see
  // docs/console/base-inventory.md's "Deletion does not require a stopped
  // map"). This scenario is therefore not reachable in practice anymore,
  // but the UI's own deleteAllowed/deleteUnavailableReason logic still
  // reads deleteSafety.safe generically and must still react correctly if
  // the backend ever sends safe: false again for some other, future
  // reason -- this test locks in that general mechanism, not a live
  // map-running scenario.
  it("disables deletion whenever the backend reports deleteSafety.safe: false for a storage container", async () => {
    mockInventory();
    mockSlots({
      ...SLOTS,
      deleteSafety: {
        safe: false, known: true, map: "HaggaBasin", partitionId: 68,
        reason: "This container's item deletion is unavailable."
      },
      // addSafety is unaffected by deleteSafety's map-check removal --
      // upstream's Add route (baseContainerAddSafety) still requires a
      // stopped map, unlike Delete/Give/Fill. See docs/console/
      // base-inventory.md for the reconciliation record.
      addSafety: {
        safe: false, known: true, map: "HaggaBasin", partitionId: 68,
        reason: "HaggaBasin · Partition 68 is running. Stop that map before adding stored items."
      }
    });
    renderTab();
    await loaded();
    await openVaultContents();
    const button = screen.getAllByRole("button", { name: /^Delete Granite Stone/ })[0] as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/This container's item deletion is unavailable/i)).toBeTruthy();
    expect(confirmAction).not.toHaveBeenCalled();
    expect(basesApi.deleteContainerItem).not.toHaveBeenCalled();
  });

  // Found during PR #349's own Layer 3 audit (UI hat), back when
  // deleteSafety.safe: false for a storage container was a real, reachable
  // scenario (a running map) -- this explanatory clause remains in the UI
  // as a defensive measure in case deleteSafety.safe is ever false again
  // for storage containers for some other, future reason, so this test
  // still locks in that the clause renders correctly whenever that branch
  // is reached, even though it is not reachable today.
  it("explains that Give and Fill are unaffected whenever a storage container's deletion is unavailable", async () => {
    mockInventory();
    mockSlots({
      ...SLOTS,
      deleteSafety: {
        safe: false, known: true, map: "HaggaBasin", partitionId: 68,
        reason: "This container's item deletion is unavailable."
      }
    });
    renderTab();
    await loaded();
    await openVaultContents();
    expect(screen.getByText(/Giving and filling items are unaffected/i)).toBeTruthy();
    // Give/Fill must actually still be live in this exact state, or the
    // explanatory text itself would be false. Give and Fill now share one
    // combobox (mode toggle below it), so this checks the combobox exists
    // in Give mode (the default) and that switching to Fill mode also
    // still works, rather than checking two separately-named comboboxes.
    await showGiveFill();
    expect(screen.getByRole("combobox", { name: "Item to give" })).toBeTruthy();
    switchToFillMode();
    expect(screen.getByRole("combobox", { name: "Item to fill" })).toBeTruthy();
  });

  // The explanatory clause is specific to the "storage container, deletion
  // unavailable for some other reason" case -- it must not appear for the
  // OTHER reason deletion can be unavailable (a Refining/Crafting
  // container), where Give/Fill are ALSO unavailable, so "unaffected"
  // would be actively wrong there.
  it("does not claim Give/Fill are unaffected for crafting/refining containers, where they are also unavailable", async () => {
    mockInventory();
    mockSlots({ ...SLOTS, group: "refining", typeName: "Small Ore Refinery" });
    renderTab();
    await loaded();
    await openVaultContents();
    expect(screen.queryByText(/Giving and filling items are unaffected/i)).toBeNull();
  });

  it("sends a count for a partial removal and rejects an amount above the stack", async () => {
    mockInventory();
    vi.mocked(basesApi.deleteContainerItem).mockResolvedValue({
      supported: true,
      result: {
        ok: true, partial: true, typeName: "Storage Container", group: "storage",
        removed: { itemId: "501", templateId: "Stone", count: 150, remaining: 450 },
        message: "Removed 150 of Stone from the database, leaving 450.",
        deleteSafety: { safe: true, known: true, map: "HaggaBasin", partitionId: 1, reason: "" }
      }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();

    // Selecting a slot moves its controls into the strip below the list.
    fireEvent.click(screen.getAllByRole("button", { name: "Granite Stone" })[0]);
    await waitFor(() => expect(document.querySelector(".bases-inventory-slot-detail")).toBeTruthy());
    const input = screen.getByLabelText(/Amount of Granite Stone/) as HTMLInputElement;

    // Above the stack: blocked in the UI as well as on the server.
    fireEvent.change(input, { target: { value: "9999" } });
    await waitFor(() => expect(document.querySelector(".bases-inventory-amount-error")).toBeTruthy());

    fireEvent.change(input, { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: /Remove 150/ }));
    await waitFor(() => expect(basesApi.deleteContainerItem).toHaveBeenCalled());
    expect(vi.mocked(basesApi.deleteContainerItem).mock.calls[0][4]).toBe(150);
    await waitFor(() => expect(input.value).toBe("450"));
  });

  it("shows grade on every slot, and an augments line only on a slot that has any", async () => {
    mockInventory();
    mockSlots({
      ...SLOTS,
      inventories: [{
        inventoryId: "9001",
        maxSlots: 45,
        usedSlots: 2,
        currentVolume: 120,
        maxVolume: 500,
        slots: [
          { itemId: "501", templateId: "Stone", name: "Granite Stone", positionIndex: 0, quantity: 600, qualityLevel: 0, currentDurability: null, maxDurability: null, augments: [] },
          {
            itemId: "504", templateId: "UniqueSword_05", name: "Replica Pulse-sword", positionIndex: 1, quantity: 1,
            qualityLevel: 3, currentDurability: 100, maxDurability: 100,
            augments: [{ templateId: "T6_Augment_Melee1", name: "Blade Sharpener", qualityLevel: 2 }]
          }
        ]
      }]
    });
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.click(screen.getByRole("button", { name: "Granite Stone" }));
    await waitFor(() => expect(document.querySelector(".bases-inventory-slot-detail")).toBeTruthy());
    const stoneDetail = document.querySelector(".bases-inventory-slot-detail-body") as HTMLElement;
    expect(within(stoneDetail).getByText(/Grade 0/)).toBeTruthy();
    expect(within(stoneDetail).queryByText(/Augments:/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Replica Pulse-sword" }));
    await waitFor(() => expect(screen.getByText(/Grade 3/)).toBeTruthy());
    const swordDetail = document.querySelector(".bases-inventory-slot-detail-body") as HTMLElement;
    expect(within(swordDetail).getByText(/100% durability/)).toBeTruthy();
    expect(within(swordDetail).getByText("Augments: Blade Sharpener (Grade 2)")).toBeTruthy();
  });

  it("keeps crafting and refining contents read-only", async () => {
    mockInventory();
    // The game's own crafting routine consumes allocated ingredients from
    // these same rows, so removing one mid-craft can leave a recipe pointing
    // at an item that no longer exists. This warning is the only thing
    // standing between an operator and that, so it is worth pinning.
    mockSlots({
      ...SLOTS,
      placeableId: "40003",
      typeName: "Small Ore Refinery",
      group: "refining",
      inventories: [{
        inventoryId: "9003", maxSlots: 5, usedSlots: 1, currentVolume: 0, maxVolume: 0,
        slots: [{ itemId: "701", templateId: "MagnetiteOre", name: "Iron Ore", positionIndex: 0, quantity: 420, qualityLevel: 0, currentDurability: null, maxDurability: null, augments: [] }]
      }]
    });
    renderTab();
    await loaded();

    const refinery = [...document.querySelectorAll(".bases-inventory-cards .bases-card")]
      .find((card) => card.textContent?.includes("Small Ore Refinery")) as HTMLElement;
    fireEvent.click(within(refinery).getByRole("button", { name: /View Contents/ }));
    await waitFor(() => expect(document.querySelectorAll(".bases-inventory-slot-cell").length).toBeGreaterThan(0));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /List/ }));
    await waitFor(() => expect(document.querySelectorAll(".bases-inventory-contents-row:not(.head)").length).toBe(1));

    const deleteButton = screen.getByRole("button", { name: /^Delete Iron Ore/ }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    expect(screen.getByText(/available only for Storage containers/i)).toBeTruthy();
    expect(confirmAction).not.toHaveBeenCalled();
    expect(basesApi.deleteContainerItem).not.toHaveBeenCalled();
  });

  it("does not warn about crafting for a plain storage container", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.click(screen.getAllByRole("button", { name: /^Delete Granite Stone/ })[0]);
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    // A chest holds no live game state, so the extra warning would be noise.
    expect(confirmAction.mock.calls[0][1]?.warning).toBeUndefined();
  });

  it("reports a failed delete through onError and leaves the slot listed", async () => {
    mockInventory();
    vi.mocked(basesApi.deleteContainerItem).mockRejectedValue(new Error("database is unreachable"));
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.click(screen.getAllByRole("button", { name: /^Delete Granite Stone/ })[0]);
    await waitFor(() => expect(onError).toHaveBeenCalledWith("database is unreachable"));
    expect([...document.querySelectorAll(".bases-inventory-contents-row:not(.head)")].length).toBe(3);
  });

  // StrictMode double-invokes the load effect, so two requests are genuinely
  // open at once and whichever settles last writes state. A first attempt that
  // fails after the second succeeded must not replace the loaded tab with an
  // error banner.
  it("ignores a stale response that settles after a newer one", async () => {
    const gates: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    vi.mocked(basesApi.inventory).mockImplementation(() => new Promise((resolve, reject) => {
      gates.push({ resolve, reject });
    }) as never);

    render(<StrictMode><BaseInventoryTab baseId="1006" baseName="Test Base" confirmAction={confirmAction} onError={onError} /></StrictMode>);
    await waitFor(() => expect(gates.length).toBe(2));

    // Newest request wins the tab...
    gates[1].resolve(PAYLOAD);
    await loaded();

    // ...and the older one failing afterwards must change nothing.
    gates[0].reject(new Error("stale failure"));
    await waitFor(() => expect(screen.getByText("Distinct")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText(/stale failure/)).toBeNull();
  });

  it("shows a container's slot usage on its card", async () => {
    mockInventory();
    renderTab();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Containers" }));

    const vault = cards().find((card) => card.textContent?.includes("Vault"));
    expect(within(vault as HTMLElement).getByText("2 / 45")).toBeTruthy();
  });

  // ---- Adding an item ----

  const addButton = () => screen.getByRole("button", { name: /Add Item/ }) as HTMLButtonElement;
  const addPanel = () => document.querySelector(".bases-inventory-add-panel");
  const emptyCells = () => [...document.querySelectorAll(".bases-inventory-slot-cell.empty")] as HTMLButtonElement[];

  // Picks a catalog option by template id. Not by index: the selector sorts on
  // the rendered name, so "Karpov 38" precedes "Scrap Metal" and an index
  // would silently select the wrong item. Not by accessible name either --
  // that comes from catalogItemName, which is not what this file is testing.
  async function pickCatalogItem(templateId = "ScrapMetal") {
    await waitFor(() => expect(document.querySelectorAll(".catalog-item-option").length).toBeGreaterThan(0));
    const option = [...document.querySelectorAll(".catalog-item-option")]
      .find((element) => element.textContent?.includes(templateId));
    expect(option).toBeTruthy();
    fireEvent.click(option as Element);
  }

  async function openAddPanel() {
    fireEvent.click(addButton());
    await waitFor(() => expect(addPanel()).toBeTruthy());
  }

  function mockAddSuccess() {
    vi.mocked(basesApi.addContainerItem).mockResolvedValue({
      supported: true,
      result: {
        ok: true, inventoryId: "9001", typeName: "Storage Container", group: "storage",
        added: { itemId: "999", templateId: "ScrapMetal", quantity: 25, qualityLevel: 0, positionIndex: 3 },
        capacity: { usedSlots: 4, maxSlots: 45 },
        message: "ScrapMetal x25 was added to Storage Container in slot #3.",
        addSafety: { safe: true, known: true, map: "HaggaBasin", partitionId: 1, reason: "" }
      }
    } as never);
  }

  it("opens the add panel from the list-view footer button", async () => {
    mockInventory();
    renderTab();
    await loaded();
    // List view enumerates occupied slots only, so it has no empty cell to
    // click -- the footer button is the only add affordance here, which is
    // precisely why it exists (and why it is absent from grid view).
    await openVaultContents();
    expect(emptyCells().length).toBe(0);
    await openAddPanel();
    expect(addPanel()).toBeTruthy();
  });

  it("does not offer Add Item in grid view", async () => {
    mockInventory();
    renderTab();
    await loaded();
    // Grid's own empty cells already open the panel; a second, redundant
    // control in the footer would just be noise there.
    await openVaultContents({ stayOnGrid: true });
    expect(screen.queryByRole("button", { name: /Add Item/ })).toBeNull();
    await switchToList();
    expect(screen.getByRole("button", { name: /Add Item/ })).toBeTruthy();
  });

  it("has no Back to slots button, and hides the footer's Add Item and Close while the add panel is open", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    // Both live in the footer already, via Cancel and the header's X --
    // repeating either at the top of the panel would be redundant.
    await openAddPanel();
    expect(screen.queryByRole("button", { name: /Back to slots/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Add Item/ })).toBeNull();
    // The overlay itself must still be closable from this state.
    expect(screen.getByRole("button", { name: "Close contents" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toBeTruthy());
    expect(screen.getByRole("button", { name: /^Add Item/ })).toBeTruthy();
  });

  it("opens the add panel from an empty grid cell without claiming a slot number", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents({ stayOnGrid: true });

    const cell = emptyCells()[0];
    expect(cell).toBeTruthy();
    // Placement is not chooseable: the server always appends to the next free
    // index, so nothing on this control may promise a specific slot.
    const label = cell.getAttribute("aria-label") || "";
    expect(label).toBe("Add an item to this container");
    expect(label).not.toMatch(/slot\s*#?\d/i);
    expect(cell.getAttribute("title") || "").not.toMatch(/slot\s*#?\d/i);
    // Kept out of the tab order -- 42 empty cells would otherwise sit between
    // the grid and the controls below it.
    expect(cell.tabIndex).toBe(-1);

    fireEvent.click(cell);
    await waitFor(() => expect(addPanel()).toBeTruthy());
  });

  it("states the placement rule in the add panel", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await openAddPanel();
    // Regression guard on both contracts the backend keeps.
    expect(addPanel()!.textContent).toMatch(/next free slot/i);
    expect(addPanel()!.textContent).toMatch(/never topped up/i);
  });

  it("disables adding when the map is running or its state cannot be verified", async () => {
    mockInventory();
    mockSlots({
      ...SLOTS,
      addSafety: {
        safe: false, known: false, map: "", partitionId: 0,
        reason: "The console cannot verify that this base's map is safely stopped, so adding items is disabled."
      }
    });
    renderTab();
    await loaded();
    await openVaultContents({ stayOnGrid: true });

    expect(emptyCells().every((cell) => cell.disabled)).toBe(true);
    expect(screen.getByText(/cannot verify that this base's map is safely stopped, so adding items is disabled/i)).toBeTruthy();
    await switchToList();
    expect(addButton().disabled).toBe(true);
    expect(basesApi.addContainerItem).not.toHaveBeenCalled();
  });

  it("keeps crafting and refining contents read-only for adding too", async () => {
    mockInventory();
    mockSlots({
      ...SLOTS,
      group: "refining",
      typeName: "Ore Refinery",
      // The server refuses on the group before it ever looks at the map.
      addSafety: {
        safe: false, known: true, map: "", partitionId: 0,
        reason: "Adding items is available only for Storage containers. Crafting and Refining contents are read-only to protect active jobs."
      }
    });
    renderTab();
    await loaded();
    await openVaultContents({ stayOnGrid: true });

    expect(screen.getByText(/only for Storage containers/i)).toBeTruthy();
    await switchToList();
    expect(addButton().disabled).toBe(true);
  });

  it("refuses to add to a container with no free slots", async () => {
    // Capacity comes from the container, not from the safety gate: a stopped
    // map and a plain storage box can still be full.
    mockInventory({
      ...PAYLOAD,
      containers: PAYLOAD.containers.map((container) =>
        container.placeableId === "40001" ? { ...container, usedSlots: 45, maxSlots: 45 } : container)
    });
    renderTab();
    await loaded();
    await openVaultContents({ stayOnGrid: true });

    expect(emptyCells().every((cell) => cell.disabled)).toBe(true);
    await switchToList();
    expect(addButton().disabled).toBe(true);
    expect(addButton().title).toMatch(/full \(45 \/ 45 slots\)/i);
    expect(basesApi.addContainerItem).not.toHaveBeenCalled();
  });

  it("adds an item and refetches both the slots and the tab", async () => {
    mockInventory();
    mockAddSuccess();
    renderTab();
    await loaded();
    await openVaultContents();
    const slotLoads = vi.mocked(basesApi.containerSlots).mock.calls.length;
    const tabLoads = vi.mocked(basesApi.inventory).mock.calls.length;

    await openAddPanel();
    await pickCatalogItem();
    fireEvent.change(screen.getByLabelText(/Quantity to add/i), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: /Add to container/i }));

    await waitFor(() => expect(basesApi.addContainerItem).toHaveBeenCalled());
    const call = vi.mocked(basesApi.addContainerItem).mock.calls[0];
    expect(call[0]).toBe("1006");
    expect(call[1]).toBe("40001");
    expect(call[2]).toMatchObject({ itemId: "ScrapMetal", quantity: 25, quality: 0 });
    // The phrase is deliberately distinct from GIVE ITEM TO STORAGE.
    expect(call[3]).toBe("ADD ITEM TO CONTAINER");

    // Both are invalidated by an add: this container's slots, and the tab's
    // totals, group counts and rollup.
    await waitFor(() => expect(vi.mocked(basesApi.containerSlots).mock.calls.length).toBeGreaterThan(slotLoads));
    await waitFor(() => expect(vi.mocked(basesApi.inventory).mock.calls.length).toBeGreaterThan(tabLoads));
  });

  it("tells the operator the slot was not chosen when confirming", async () => {
    mockInventory();
    mockAddSuccess();
    renderTab();
    await loaded();
    await openVaultContents();
    await openAddPanel();
    await pickCatalogItem();
    fireEvent.click(screen.getByRole("button", { name: /Add to container/i }));

    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    const details = confirmAction.mock.calls.at(-1)?.[1]?.details || [];
    const slot = details.find((detail) => detail.label === "Slot");
    // The last place the placement promise is made, and it has to stay honest.
    expect(slot?.value).toBe("Next free slot");
    expect(slot?.value).not.toMatch(/#\d/);
  });

  it("does not call the add API when the confirmation is declined", async () => {
    mockInventory();
    confirmAction.mockResolvedValue(false);
    renderTab();
    await loaded();
    await openVaultContents();
    await openAddPanel();
    await pickCatalogItem();
    fireEvent.click(screen.getByRole("button", { name: /Add to container/i }));

    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(basesApi.addContainerItem).not.toHaveBeenCalled();
  });

  it("surfaces an add failure without blanking the slot list", async () => {
    mockInventory();
    vi.mocked(basesApi.addContainerItem).mockRejectedValue(new Error("This container is full: 45 of 45 slots are used."));
    renderTab();
    await loaded();
    await openVaultContents();
    await openAddPanel();
    await pickCatalogItem();
    fireEvent.click(screen.getByRole("button", { name: /Add to container/i }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringMatching(/45 of 45/)));
    // The panel closes back to the slots, which are still intact -- a failed
    // add must not hide them behind a Retry the way a failed load does.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByText(/45 of 45/)).toBeTruthy();
  });

  it("rejects a quantity outside the server's own bounds before calling the API", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await openAddPanel();
    await pickCatalogItem();
    const input = screen.getByLabelText(/Quantity to add/i);

    for (const value of ["0", "1000001", "1.5"]) {
      fireEvent.change(input, { target: { value } });
      await waitFor(() => expect(document.querySelector(".bases-inventory-amount-error")).toBeTruthy());
      expect((screen.getByRole("button", { name: /Add to container/i }) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.change(input, { target: { value: "25" } });
    await waitFor(() => expect((screen.getByRole("button", { name: /Add to container/i }) as HTMLButtonElement).disabled).toBe(false));
    expect(basesApi.addContainerItem).not.toHaveBeenCalled();
  });

  it("offers augments only for an item that can take them", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await openAddPanel();

    // A resource cannot be augmented, so the control is absent entirely rather
    // than present and empty.
    await pickCatalogItem("ScrapMetal");
    expect(addPanel()!.textContent).not.toMatch(/Aug\. Grade/);
  });

  // This repo has repeatedly shipped CSS-cascade regressions in exactly this
  // shape (fixed-width columns not accounting for a narrower container,
  // position: sticky silently failing inside another sticky ancestor) --
  // each was only caught by a live-browser check, with nothing in CI to
  // reproduce it. jsdom has no layout engine, so these assertions reach
  // computed-style FACTS (display, position, explicit height/padding/colour)
  // that the real styles.css rule declares -- not actual rendered pixel
  // geometry (does a column really fit, does the header really stay put
  // while scrolling), which stays a live-browser check; see the CSS
  // comments this pins for the reasoning and the live measurements taken
  // when each was written.
  it("keeps the CSS-cascade fixes for this panel's narrow catalog table intact", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await openAddPanel();
    const panel = addPanel()!;
    const toggle = panel.querySelector(".catalog-view-toggle")!;
    fireEvent.click(within(toggle as HTMLElement).getByRole("button", { name: /List view/i }));
    await waitFor(() => expect(panel.querySelector(".catalog-item-table")).toBeTruthy());

    // Item ID and Source dropped to fit this panel's ~500px width; Item Name
    // and Category stay. Regresses to crushed, character-wrapped columns if
    // this display:none is ever lost.
    const headers = [...panel.querySelectorAll(".catalog-item-table thead th")];
    const byText = (text: string) => headers.find((th) => th.textContent?.trim() === text)!;
    expect(getComputedStyle(byText("Item ID")).display).toBe("none");
    expect(getComputedStyle(byText("Source")).display).toBe("none");
    expect(getComputedStyle(byText("Item Name")).display).not.toBe("none");
    expect(getComputedStyle(byText("Category")).display).toBe("table-cell");

    // The header/body split that replaced position: sticky (which measurably
    // did not hold in this nesting -- see the CSS comment above these rules).
    // thead as a non-growing flex item and tbody as the sole scrolling region
    // is the mechanism that keeps the header out of the scrolled content
    // altogether; regressing any one of these reopens the drifting-header bug.
    const picker = panel.querySelector(".catalog-item-picker")!;
    const table = panel.querySelector(".catalog-item-table")!;
    const thead = panel.querySelector(".catalog-item-table thead")!;
    const tbody = panel.querySelector(".catalog-item-table tbody")!;
    expect(getComputedStyle(picker).display).toBe("flex");
    expect(getComputedStyle(table).display).toBe("flex");
    expect(getComputedStyle(thead).display).toBe("block");
    expect(getComputedStyle(thead).flexGrow).toBe("0");
    expect(getComputedStyle(tbody).display).toBe("block");
    expect(getComputedStyle(tbody).flexGrow).toBe("1");
    expect(getComputedStyle(tbody).overflowY).toBe("auto");

    // Grade -- a native <select> -- needs an explicit height to match the
    // <input> siblings; a browser rendering quirk means identical padding
    // alone leaves it 2px taller (measured live: 41px vs 43px).
    const grade = panel.querySelector(".bases-inventory-add-field .package-item-durability-input")!;
    expect(getComputedStyle(grade).height).toBe("41px");
  });

  it("scopes the augment dropdown's control styling to this panel, not other panels using the same component", async () => {
    // AugmentDropdown ships its own padding/border/background that only
    // matches this panel's plain inputs once overridden here -- and only
    // here, not in Player give-items, which still uses the component's
    // stock styling. Exercised as a standalone fixture rather than through
    // the full add flow: the mocked catalog in this file has no
    // augment-category item, so the real interactive path never mounts
    // AugmentDropdown -- this instead pins the CSS selector itself
    // (specificity and scoping), independent of that mock gap.
    const scoped = document.createElement("div");
    scoped.className = "bases-inventory-add-panel";
    scoped.innerHTML = '<div class="augment-dropdown-control"></div>';
    document.body.appendChild(scoped);

    const unscoped = document.createElement("div");
    unscoped.innerHTML = '<div class="augment-dropdown-control"></div>';
    document.body.appendChild(unscoped);

    try {
      const inPanel = getComputedStyle(scoped.querySelector(".augment-dropdown-control")!);
      const outsidePanel = getComputedStyle(unscoped.querySelector(".augment-dropdown-control")!);

      // border-color isn't asserted here: the rule sets it via var(--border-
      // strong), and jsdom's getComputedStyle does not resolve CSS custom
      // properties (confirmed empirically -- a literal value on the same rule
      // applies correctly, but the var() one silently falls through to the
      // unscoped default). Real-browser border-color was measured live by the
      // reviewer at rgb(77, 64, 50), matching --border-strong.
      expect(inPanel.padding).toBe("10px 12px");
      expect(inPanel.backgroundColor).toBe("rgb(21, 23, 25)");

      // Same class, no .bases-inventory-add-panel ancestor: must fall back to
      // the component's own stock styling, proving the override cannot leak.
      expect(outsidePanel.padding).not.toBe("10px 12px");
      expect(outsidePanel.backgroundColor).not.toBe("rgb(21, 23, 25)");
    } finally {
      // Raw DOM nodes, not React-rendered -- the file's afterEach(cleanup())
      // only unmounts React trees, so these would otherwise leak into every
      // later test's queries for the rest of the file.
      scoped.remove();
      unscoped.remove();
    }
  });

  it("keeps the add panel and the slot-detail strip mutually exclusive", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    // Selecting a slot arms the delete strip.
    fireEvent.click(screen.getAllByRole("button", { name: "Granite Stone" })[0]);
    await waitFor(() => expect(document.querySelector(".bases-inventory-slot-detail")).toBeTruthy());

    // Opening the add panel replaces the slot region and clears that strip --
    // two modes of one dialog, not two panels stacked in it. The strip is keyed
    // to an existing occupied slot and cannot represent an add.
    await openAddPanel();
    expect(document.querySelector(".bases-inventory-slot-detail")).toBeNull();
    expect(document.querySelector(".bases-inventory-contents-scroll")).toBeNull();

    // Cancel restores the slots with nothing selected. No separate "back"
    // control -- it would just duplicate what Cancel already does.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(addPanel()).toBeNull());
    expect(document.querySelector(".bases-inventory-contents-scroll")).toBeTruthy();
    expect(document.querySelector(".bases-inventory-slot-detail")).toBeNull();
  });

  it("clears the add panel when the overlay is reopened", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await openAddPanel();
    await pickCatalogItem();

    // The footer's Close is hidden while the add panel is open (see the
    // "does not show Close or the footer Add Item while the add panel is
    // open" test); the header's X is what still closes the whole overlay
    // from this state.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close contents" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Reopened directly rather than via openVaultContents: contentsView is
    // sticky, so the overlay comes back in list mode and has no grid cells for
    // that helper to wait on.
    const vault = [...document.querySelectorAll(".bases-inventory-cards .bases-card")]
      .find((card) => card.textContent?.includes("Vault")) as HTMLElement;
    fireEvent.click(within(vault).getByRole("button", { name: /View Contents/ }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());

    // A half-filled form must not carry over: the capacity, the gate and the
    // confirm dialog's Container line all change with the container.
    expect(addPanel()).toBeNull();
  });

  // Issue #356: pre-existing items given before the volume-checking fix
  // landed have a permanent NULL volume_override, which every capacity check
  // already treats as 0 -- so a backfill was judged too risky to run against
  // every operator's live data for a LOW-MEDIUM accuracy gap. Surfacing the
  // real, current volume total directly (rather than leaving it implicit)
  // was the chosen fix instead.
  it("shows a container's volume usage on its card when the schema tracks it", async () => {
    mockInventory();
    renderTab();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Containers" }));

    const vault = cards().find((card) => card.textContent?.includes("Vault"));
    expect(within(vault as HTMLElement).getByText("Volume Used")).toBeTruthy();
    expect(within(vault as HTMLElement).getByText("120.0 / 500.0")).toBeTruthy();
  });

  it("withholds the volume row on a card whose container has no volume cap", async () => {
    mockInventory();
    renderTab();
    await loaded();
    fireEvent.click(screen.getByRole("button", { name: "Containers" }));

    // The 40002 Small Storage Container fixture is 0/0 -- no volume tracked.
    const smallContainer = cards().find((card) => card.textContent?.includes("Small Storage Container"));
    expect(within(smallContainer as HTMLElement).queryByText("Volume Used")).toBeNull();
  });

  it("shows a container's volume usage in the contents overlay summary", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Volume Used")).toBeTruthy();
    expect(within(dialog).getByText("120.0 / 500.0")).toBeTruthy();
  });

  // Give/Give-multiple/Fill/bulk-delete: added alongside the raw-resource
  // catalog work (issue #347). Storage-group only, same as the existing
  // single-item delete above -- SLOTS' fixture container is already a
  // "storage" group with deleteSafety.safe true, so these reuse the same
  // Vault fixture rather than a new one.

  it("gives a single item and refetches both the slots and the tab", async () => {
    mockInventory();
    vi.mocked(basesApi.giveContainerItem).mockResolvedValue({
      supported: true,
      result: { ok: true, inserted: { id: "601", templateId: "AzuriteOre", stackSize: 20 } }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    await pickItem("Item to give", "AzuriteOre");
    fireEvent.change(screen.getByLabelText("Quantity to give"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Give Item" }));

    await waitFor(() => expect(basesApi.giveContainerItem).toHaveBeenCalled());
    expect(vi.mocked(basesApi.giveContainerItem).mock.calls[0]).toEqual([
      "1006", "40001", { itemId: "AzuriteOre", quantity: 20, confirmation: "GIVE ITEM TO STORAGE" }
    ]);
    await waitFor(() => expect(vi.mocked(basesApi.inventory).mock.calls.length).toBeGreaterThan(1));
    // The selection clears after a successful give, ready for the next item.
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Item to give" }) as HTMLInputElement).value).toBe(""));
  });

  // Per explicit operator direction: Give never rejects on hitting a
  // capacity limit -- a requested quantity that would exceed remaining
  // volume is clamped to whatever fits and given, and the UI must say so
  // plainly rather than claiming the full requested amount succeeded.
  it("reports a clamped give (less given than requested) rather than claiming full success", async () => {
    mockInventory();
    vi.mocked(basesApi.giveContainerItem).mockResolvedValue({
      supported: true,
      result: { ok: true, inserted: { id: "601", templateId: "AzuriteOre", stackSize: 25 }, requested: 50, given: 25, clamped: true }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    await pickItem("Item to give", "AzuriteOre");
    fireEvent.change(screen.getByLabelText("Quantity to give"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Give Item" }));

    await waitFor(() => expect(basesApi.giveContainerItem).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/Only 25 of the requested 50 x AzuriteOre fit/)).toBeTruthy());
  });

  it("does not give an item when the confirmation is declined", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    // Reveal the panel first (confirmAction still resolves true here), then
    // switch it to decline for the actual Give confirm this test targets --
    // declining the reveal-toggle's own confirm would never even open the
    // panel, testing nothing about the Give confirmation itself.
    await showGiveFill();
    confirmAction.mockResolvedValue(false);

    await pickItem("Item to give", "AzuriteOre");
    fireEvent.click(screen.getByRole("button", { name: "Give Item" }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(basesApi.giveContainerItem).not.toHaveBeenCalled();
  });

  it("batches several distinct items into one give-items call", async () => {
    mockInventory();
    vi.mocked(basesApi.giveContainerItems).mockResolvedValue({
      supported: true,
      result: { ok: true, results: [] }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    // Queue the first item into the batch...
    await pickItem("Item to give", "AzuriteOre");
    fireEvent.change(screen.getByLabelText("Quantity to give"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to Batch" }));
    await waitFor(() => expect(screen.getByText(/AzuriteOre ×20/)).toBeTruthy());

    // ...then select a second item and give both in one click, folding the
    // not-yet-queued second item in at confirm time.
    await pickItem("Item to give", "PlantFiber");
    fireEvent.change(screen.getByLabelText("Quantity to give"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /Give 2 Items/ }));

    await waitFor(() => expect(basesApi.giveContainerItems).toHaveBeenCalled());
    expect(vi.mocked(basesApi.giveContainerItems).mock.calls[0]).toEqual([
      "1006", "40001",
      [{ itemName: "AzuriteOre", itemId: "AzuriteOre", quantity: 20 }, { itemName: "PlantFiber", itemId: "PlantFiber", quantity: 5 }],
      "GIVE ITEMS TO STORAGE"
    ]);
    // A single-item give must never be routed through the batch endpoint.
    expect(basesApi.giveContainerItem).not.toHaveBeenCalled();
  });

  // Genuine network/validation failures (as opposed to hitting a capacity
  // limit, which no longer throws -- see the "stops partway" test below)
  // still propagate through the ordinary onError/deleteError wiring, the
  // same as every other mutation in this file.
  it("surfaces a genuine give-items request failure through onError", async () => {
    mockInventory();
    vi.mocked(basesApi.giveContainerItems).mockRejectedValue(
      new Error("Network request failed")
    );
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    await pickItem("Item to give", "AzuriteOre");
    fireEvent.change(screen.getByLabelText("Quantity to give"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to Batch" }));
    await waitFor(() => expect(screen.getByText(/AzuriteOre ×20/)).toBeTruthy());

    await pickItem("Item to give", "PlantFiber");
    fireEvent.change(screen.getByLabelText("Quantity to give"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /Give 2 Items/ }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith("Network request failed"));
    expect(screen.getByRole("alert")).toHaveTextContent("Network request failed");
    // The batch is deliberately NOT cleared on failure -- silently dropping
    // a failed batch would force the operator to re-enter every item to
    // retry.
    expect(screen.getByText(/AzuriteOre ×20/)).toBeTruthy();
  });

  // Per explicit operator direction: hitting a capacity limit mid-batch
  // never throws -- giveMultipleItemsToStorage stops the batch and returns
  // ok: true with a per-item breakdown instead. The UI must report exactly
  // how far the batch got as a success-channel notice, not an error.
  it("reports where a give-items batch stopped, without treating it as a failure", async () => {
    mockInventory();
    vi.mocked(basesApi.giveContainerItems).mockResolvedValue({
      supported: true,
      result: {
        ok: true,
        results: [
          { inserted: { id: "601", templateId: "AzuriteOre", stackSize: 20 }, templateId: "AzuriteOre", requested: 20, given: 20, clamped: false, attempted: true },
          { templateId: "PlantFiber", requested: 5, given: 2, clamped: true, attempted: true, reason: "Storage is full by volume." }
        ]
      }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    await pickItem("Item to give", "AzuriteOre");
    fireEvent.change(screen.getByLabelText("Quantity to give"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to Batch" }));
    await waitFor(() => expect(screen.getByText(/AzuriteOre ×20/)).toBeTruthy());

    await pickItem("Item to give", "PlantFiber");
    fireEvent.change(screen.getByLabelText("Quantity to give"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /Give 2 Items/ }));

    await waitFor(() => expect(basesApi.giveContainerItems).toHaveBeenCalled());
    // A real success message, not an error -- onError/the alert box must
    // never fire for this outcome. Both items received something (item 2
    // was clamped to 2 of the requested 5, not reduced to 0), so the
    // count is "2 of 2 items were given," with the partial detail called
    // out separately.
    await waitFor(() => expect(screen.getByText(/2 of 2 items were given before the batch stopped at PlantFiber \(partially, 2 of 5\)/)).toBeTruthy());
    expect(onError).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // The zero-fit variant of the same "never throws" batch behavior: an
  // item that gets given: 0 is excluded from the "N of M" success count
  // (it received nothing), and the parenthetical detail is omitted since
  // "partially, 0 of 5" would be a confusing way to say "none of it".
  it("reports a batch stop where the stopping item received nothing at all", async () => {
    mockInventory();
    vi.mocked(basesApi.giveContainerItems).mockResolvedValue({
      supported: true,
      result: {
        ok: true,
        results: [
          { inserted: { id: "601", templateId: "AzuriteOre", stackSize: 20 }, templateId: "AzuriteOre", requested: 20, given: 20, clamped: false, attempted: true },
          { templateId: "PlantFiber", requested: 5, given: 0, clamped: true, attempted: true, reason: "Storage is full by volume." }
        ]
      }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    await pickItem("Item to give", "AzuriteOre");
    fireEvent.change(screen.getByLabelText("Quantity to give"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to Batch" }));
    await waitFor(() => expect(screen.getByText(/AzuriteOre ×20/)).toBeTruthy());

    await pickItem("Item to give", "PlantFiber");
    fireEvent.change(screen.getByLabelText("Quantity to give"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /Give 2 Items/ }));

    await waitFor(() => expect(basesApi.giveContainerItems).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/1 of 2 items were given before the batch stopped at PlantFiber\.$/)).toBeTruthy());
    expect(onError).not.toHaveBeenCalled();
  });

  it("removes a queued item from the batch before giving", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    await pickItem("Item to give", "AzuriteOre");
    fireEvent.click(screen.getByRole("button", { name: "Add to Batch" }));
    await waitFor(() => expect(screen.getByText(/AzuriteOre/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Remove AzuriteOre from batch/ }));
    expect(screen.queryByText(/AzuriteOre ×/)).toBeNull();
  });

  it("fills a container with a specific amount of a raw resource, refined resource, or component", async () => {
    mockInventory();
    vi.mocked(basesApi.fillContainerItem).mockResolvedValue({
      supported: true,
      result: { ok: true, inserted: { id: "602", templateId: "SteelBar", stackSize: 50, volumeOverride: 50 } }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();
    switchToFillMode();

    await pickItem("Item to fill", "SteelBar");
    fireEvent.change(screen.getByLabelText("Quantity to fill"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Fill Amount" }));

    await waitFor(() => expect(basesApi.fillContainerItem).toHaveBeenCalled());
    expect(vi.mocked(basesApi.fillContainerItem).mock.calls[0]).toEqual([
      "1006", "40001", { itemId: "SteelBar", quantity: 50, confirmation: "FILL ITEM TO STORAGE" }
    ]);
    await waitFor(() => expect(vi.mocked(basesApi.inventory).mock.calls.length).toBeGreaterThan(1));
  });

  // Per explicit operator direction: Fill Amount never rejects on hitting a
  // capacity limit either -- clamped and given, exactly like Give. This is
  // the precise bug an operator reported manually: the modal said "Fill
  // Container" and the confirm dialog said "Fill container with 100 x
  // Plastanium Ingot," but only 100 (the requested amount) was actually
  // inserted even when more was asked for -- the success message must
  // report the real given/clamped outcome, not silently imply the
  // requested amount matched what was inserted.
  it("reports a clamped Fill Amount (less given than requested) rather than claiming full success", async () => {
    mockInventory();
    vi.mocked(basesApi.fillContainerItem).mockResolvedValue({
      supported: true,
      result: { ok: true, inserted: { id: "602", templateId: "SteelBar", stackSize: 25, volumeOverride: 25 }, requested: 50, given: 25, clamped: true }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();
    switchToFillMode();

    await pickItem("Item to fill", "SteelBar");
    fireEvent.change(screen.getByLabelText("Quantity to fill"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Fill Amount" }));

    await waitFor(() => expect(basesApi.fillContainerItem).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/Only 25 of the requested 50 x SteelBar fit/)).toBeTruthy());
  });

  // Issue #347 (found during manual UI review): fillItemToStorage's own
  // quantity: 0 sentinel ("compute the largest stack that fits in whatever
  // volume remains and insert exactly that") was never reachable from any
  // UI -- both this tab's quantity field and the standalone Storage tab's
  // clamp to a minimum of 1. "Fill to Capacity" is a second, explicit
  // button that sends quantity: 0 regardless of whatever the quantity
  // field currently holds, and the success message reports the real
  // inserted count the server actually computed, not the field's value
  // (which is meaningless for this action).
  it("fills a container to capacity, ignoring whatever is in the quantity field", async () => {
    mockInventory();
    vi.mocked(basesApi.fillContainerItem).mockResolvedValue({
      supported: true,
      result: { ok: true, inserted: { id: "603", templateId: "SteelBar", stackSize: 4200, volumeOverride: 4200 }, requested: null, given: 4200, clamped: false }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();
    switchToFillMode();

    await pickItem("Item to fill", "SteelBar");
    fireEvent.change(screen.getByLabelText("Quantity to fill"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Fill to Capacity" }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    // The confirm dialog must not claim a specific quantity the operator
    // never actually chose.
    expect(vi.mocked(confirmAction).mock.calls.at(-1)?.[0]).toMatch(/as much SteelBar as fits/);

    await waitFor(() => expect(basesApi.fillContainerItem).toHaveBeenCalled());
    expect(vi.mocked(basesApi.fillContainerItem).mock.calls[0]).toEqual([
      "1006", "40001", { itemId: "SteelBar", quantity: 0, confirmation: "FILL ITEM TO STORAGE" }
    ]);
    // The success message reports the real amount the server inserted
    // (4200), not the quantity field's stale "50".
    await waitFor(() => expect(screen.getByText(/4,200 x SteelBar was filled/)).toBeTruthy());
  });

  // Issue #430 L2 audit (UI hat H-1): when the per-operation stack-row cap
  // -- not the container's real capacity -- cut a Fill to Capacity short,
  // the backend reports clamped with clampReason "stack-rows", and the
  // message must NOT claim "(as much as fit)": the container still has
  // room, and the operator's correct next step is running Fill again.
  it("reports a stack-row-capped Fill to Capacity honestly instead of claiming the container is full", async () => {
    mockInventory();
    vi.mocked(basesApi.fillContainerItem).mockResolvedValue({
      supported: true,
      result: { ok: true, inserted: { id: "604", templateId: "SteelBar", stackSize: 500 }, requested: null, given: 25000, stacks: 50, clamped: true, clampReason: "stack-rows" }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();
    switchToFillMode();

    await pickItem("Item to fill", "SteelBar");
    fireEvent.click(screen.getByRole("button", { name: "Fill to Capacity" }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    await waitFor(() => expect(basesApi.fillContainerItem).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/25,000 x SteelBar was filled/)).toBeTruthy());
    const notice = screen.getByText(/25,000 x SteelBar was filled/).textContent || "";
    expect(notice).not.toMatch(/as much as fit/);
    expect(notice).toMatch(/stack.*(cap|limit)/i);
    expect(notice).toMatch(/Fill again|repeat/i);
  });

  // FILLABLE_GROUPS filtering (adminCatalog.js) is enforced client-side too:
  // the Fill combobox must never even offer a non-fillable item like a
  // weapon, matching the server's own group check.
  it("only offers fillable items (raw/refined resources, components) in the Fill combobox", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();
    switchToFillMode();

    const fillInput = screen.getByRole("combobox", { name: "Item to fill" });
    fireEvent.change(fillInput, { target: { value: "" } });
    fireEvent.focus(fillInput);
    await waitFor(() => expect(screen.getByRole("option", { name: /SteelBar/ })).toBeTruthy());
    expect(screen.queryByRole("option", { name: /SilverSword_Ranger/ })).toBeNull();
  });

  // CORRECTED 2026-08-19 (issue #347 follow-up): Give used to accept any
  // catalog item -- a real catalog item, "Robe of the Sisterhood"
  // (clothing), showed up in the Give combobox despite this feature being
  // intended for raw/refined resources and components only. The Give
  // combobox now applies the same FILLABLE_GROUPS filter Fill already did.
  it("only offers fillable items (raw/refined resources, components) in the Give combobox", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    const giveInput = screen.getByRole("combobox", { name: "Item to give" });
    fireEvent.change(giveInput, { target: { value: "" } });
    fireEvent.focus(giveInput);
    await waitFor(() => expect(screen.getByRole("option", { name: /SteelBar/ })).toBeTruthy());
    expect(screen.queryByRole("option", { name: /SilverSword_Ranger/ })).toBeNull();
  });

  it("does not offer Give/Fill for crafting or refining containers", async () => {
    mockInventory();
    mockSlots({ ...SLOTS, group: "refining", typeName: "Small Ore Refinery" });
    renderTab();
    await loaded();
    await openVaultContents();

    // The visibility toggle itself is disabled for a non-storage container
    // (giveFillAllowed is false) -- clicking it must do nothing, matching
    // the existing disabled-control convention elsewhere in this overlay.
    const toggle = screen.getByRole("checkbox", { name: /Give \/ Fill \/ Delete Controls/ }) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.queryByRole("combobox", { name: "Item to give" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Item to fill" })).toBeNull();
  });

  // Per INC-2026-07-31-001: the engine only claims dune.items rows at
  // server startup, so given/filled items stay invisible in-game until a
  // restart -- this fork has already relearned that the hard way once
  // (the standalone Storage tab's own "Apply Fills" note), so the warning
  // must not go missing from this second surface either.
  it("warns that given/filled items require a Survival server restart to appear in-game", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    expect(screen.getByText(/not visible in-game until the Survival server restarts/)).toBeTruthy();
  });

  it("does not show the restart warning when Give/Fill is unavailable for this container", async () => {
    mockInventory();
    mockSlots({ ...SLOTS, group: "refining", typeName: "Small Ore Refinery" });
    renderTab();
    await loaded();
    await openVaultContents();

    expect(screen.queryByText(/not visible in-game until the Survival server restarts/)).toBeNull();
  });

  // Per INC-2026-08-19-GIVE-FILL-POSITION-INDEX-COLLISION.md: Give
  // mitigates the position_index collision risk by filling from the high
  // end of the container; Fill cannot use the same mitigation, since it is
  // meant to top up toward real capacity, the same direction the engine
  // already fills. Per explicit operator direction, Fill gets a warning
  // and documentation instead of a mitigation. Give/Fill share one panel
  // (mode toggle, consolidated 2026-08-19) that opens in Give mode by
  // default, so this warning must be absent in Give mode and appear only
  // after switching to Fill mode -- it must never show for Give, which does
  // not carry this risk.
  it("warns specifically about the position_index collision risk for Fill, not Give", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    expect(screen.queryByText(/can land on the same slot and be lost on the next restart/)).toBeNull();
    switchToFillMode();
    expect(screen.getByText(/can land on the same slot and be lost on the next restart/)).toBeTruthy();
  });

  it("does not show the Fill collision warning when Give/Fill is unavailable for this container", async () => {
    mockInventory();
    mockSlots({ ...SLOTS, group: "refining", typeName: "Small Ore Refinery" });
    renderTab();
    await loaded();
    await openVaultContents();

    expect(screen.queryByText(/can land on the same slot and be lost on the next restart/)).toBeNull();
  });

  // Regression guard for a real operator report the same day the Give/Fill
  // consolidation shipped: three separately-stacked notice elements (an
  // explanatory paragraph, the restart warning, and a second, visually
  // identical Fill-only collision warning) rendered at once in Fill mode.
  // The restart warning and the Fill-only collision sentence must share
  // ONE bordered banner element, never two, in either mode.
  it("never renders more than one warning banner element, in either Give or Fill mode", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    expect(document.querySelectorAll(".bases-inventory-restart-warning").length).toBe(1);
    expect(document.querySelectorAll(".bases-inventory-fill-collision-warning").length).toBe(0);

    switchToFillMode();
    expect(document.querySelectorAll(".bases-inventory-restart-warning").length).toBe(1);
    expect(document.querySelectorAll(".bases-inventory-fill-collision-warning").length).toBe(0);
    // Both facts must be present in that single banner while in Fill mode.
    expect(screen.getByText(/not visible in-game until the Survival server restarts/)).toBeTruthy();
    expect(screen.getByText(/can land on the same slot and be lost on the next restart/)).toBeTruthy();
  });

  // Regression guard for a second real operator report the same day: the
  // mode-hint caption and the Give/Fill toggle sat directly above/below
  // the warning banner with no shared visual container, reading as
  // "unpolished" (bare text next to a bordered control next to a
  // bordered-and-iconed banner). Both must now share one grouped
  // container, distinct from the warning banner itself.
  it("groups the mode-hint caption and the Give/Fill toggle into one shared container, separate from the warning banner", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    const group = document.querySelector(".bases-inventory-mode-group");
    expect(group).toBeTruthy();
    expect(group?.querySelector(".bases-inventory-mode-hint")).toBeTruthy();
    expect(group?.querySelector(".bases-inventory-views")).toBeTruthy();
    // The warning banner must NOT be inside the same grouped container --
    // it is deliberately the one heavier-weight element in this panel.
    expect(group?.querySelector(".bases-inventory-restart-warning")).toBeNull();
    expect(document.querySelectorAll(".bases-inventory-mode-group").length).toBe(1);
  });

  // Give/Fill panel consolidation (2026-08-19, "Alternative A" from the
  // UI/UX hat's dispatched design review): one shared item combobox and
  // quantity field, switched by a Give/Fill mode toggle, replacing the
  // previous two separately-stacked panels. These tests lock in the
  // consolidated panel's own new behavior directly, not just via
  // incidental pass-through from the pre-existing Give/Fill action tests
  // above.
  it("opens the Add Item/Fill Container panel in Give mode by default", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    expect(screen.getByRole("button", { name: "Give" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Fill" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("combobox", { name: "Item to give" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Give Item" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fill Amount" })).toBeNull();
  });

  it("switches between Give and Fill mode, swapping the combobox label and action buttons", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    switchToFillMode();
    expect(screen.getByRole("button", { name: "Fill" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("combobox", { name: "Item to fill" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fill Amount" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fill to Capacity" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Give Item" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Give" }));
    expect(screen.getByRole("button", { name: "Give" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("combobox", { name: "Item to give" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Give Item" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Fill Amount" })).toBeNull();
  });

  // CORRECTED 2026-08-19 (real operator report): the selected item used to
  // clear on every mode switch, forcing an operator who glanced at Fill
  // and switched back to Give to re-search the same item. Give and Fill
  // both filter to the exact same FILLABLE_GROUPS, so there is no reason
  // an item valid in one mode would ever be invalid in the other -- the
  // selection now persists across a mode switch. Only the quantity field
  // resets to that mode's own default, since a half-typed Give quantity
  // must still never be silently submitted as a Fill quantity or vice
  // versa.
  it("persists the selected item across a mode switch, but resets the quantity default", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    await pickItem("Item to give", "AzuriteOre");
    fireEvent.change(screen.getByLabelText("Quantity to give"), { target: { value: "42" } });
    expect((screen.getByRole("combobox", { name: "Item to give" }) as HTMLInputElement).value).toBe("AzuriteOre");

    switchToFillMode();
    expect((screen.getByRole("combobox", { name: "Item to fill" }) as HTMLInputElement).value).toBe("AzuriteOre");
    expect((screen.getByLabelText("Quantity to fill") as HTMLInputElement).value).toBe("100");

    fireEvent.click(screen.getByRole("button", { name: "Give" }));
    expect((screen.getByRole("combobox", { name: "Item to give" }) as HTMLInputElement).value).toBe("AzuriteOre");
    expect((screen.getByLabelText("Quantity to give") as HTMLInputElement).value).toBe("1");
  });

  it("keeps a queued Give batch intact after switching to Fill mode and back", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    await pickItem("Item to give", "AzuriteOre");
    fireEvent.click(screen.getByRole("button", { name: "Add to Batch" }));
    expect(screen.getByText(/AzuriteOre ×/)).toBeTruthy();

    switchToFillMode();
    fireEvent.click(screen.getByRole("button", { name: "Give" }));
    // The queued batch entry must still be there -- only the shared
    // selection/quantity fields reset on a mode switch, never the batch.
    expect(screen.getByText(/AzuriteOre ×/)).toBeTruthy();
  });

  // Give/Fill visibility toggle (issue #371, per explicit operator
  // direction): the whole Give/Fill panel is hidden by default on every
  // fresh open, and turning it on requires acknowledging an explicit
  // confirm dialog before it actually reveals anything.
  it("hides the entire Give/Fill panel by default when a storage container's contents are opened", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    expect(screen.queryByRole("combobox", { name: "Item to give" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Give" })).toBeNull();
    expect(screen.queryByText(/not visible in-game until the Survival server restarts/)).toBeNull();
    const toggle = screen.getByRole("checkbox", { name: /Give \/ Fill \/ Delete Controls/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it("shows an explicit confirm dialog, recommending the Daily Restart schedule, before revealing Give/Fill", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.click(screen.getByRole("checkbox", { name: /Give \/ Fill \/ Delete Controls/ }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    const [message, options] = vi.mocked(confirmAction).mock.calls.at(-1) ?? [];
    expect(message).toMatch(/NOT visible in-game until the Survival server restarts/);
    expect(message).toMatch(/Admin Tools.*Schedule Server Restart.*Daily Restart/);
    expect(options?.warning).toMatch(/can land on the same slot/);
  });

  it("does not reveal Give/Fill when the toggle-on confirmation is declined", async () => {
    mockInventory();
    confirmAction.mockResolvedValue(false);
    renderTab();
    await loaded();
    await openVaultContents();

    fireEvent.click(screen.getByRole("checkbox", { name: /Give \/ Fill \/ Delete Controls/ }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(screen.queryByRole("combobox", { name: "Item to give" })).toBeNull();
    const toggle = screen.getByRole("checkbox", { name: /Give \/ Fill \/ Delete Controls/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it("hides Give/Fill again instantly, with no confirmation, when the toggle is switched off", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();
    expect(screen.getByRole("combobox", { name: "Item to give" })).toBeTruthy();
    const callsBeforeToggleOff = vi.mocked(confirmAction).mock.calls.length;

    fireEvent.click(screen.getByRole("checkbox", { name: /Give \/ Fill \/ Delete Controls/ }));
    expect(screen.queryByRole("combobox", { name: "Item to give" })).toBeNull();
    // Turning it back off must not have triggered a second confirmation --
    // hiding a capability is never the risky direction.
    expect(vi.mocked(confirmAction).mock.calls.length).toBe(callsBeforeToggleOff);
  });

  it("resets Give/Fill visibility to hidden every time the contents overlay is reopened", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();
    expect(screen.getByRole("combobox", { name: "Item to give" })).toBeTruthy();

    // Close the overlay, then reopen the same container -- visibility must
    // reset to hidden, matching every other piece of this overlay's own
    // reset-on-open state (selectedSlotId, checkedItemIds, addFillMode).
    fireEvent.click(screen.getByRole("button", { name: "Close contents" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The overlay re-opens on Grid by default, but contentsView is left on
    // "list" from the first openVaultContents() call above (it is not part
    // of the close/reopen reset effect -- a deliberate choice unrelated to
    // this test, view-mode preference persisting across containers), so
    // this reopen deliberately does not use the openVaultContents() helper
    // (which waits for Grid's own slot-cell class first) and instead opens
    // the dialog directly and waits for the List rows it will actually show.
    const vault = [...document.querySelectorAll(".bases-inventory-cards .bases-card")]
      .find((card) => card.textContent?.includes("Vault")) as HTMLElement;
    fireEvent.click(within(vault).getByRole("button", { name: /View Contents/ }));
    await waitFor(() => expect(document.querySelectorAll(".bases-inventory-contents-row:not(.head)").length).toBeGreaterThan(0));
    expect(screen.queryByRole("combobox", { name: "Item to give" })).toBeNull();
  });

  // Bulk delete (Delete Selected/Delete All, and the per-row multi-select
  // checkboxes that feed Delete Selected) is gated behind the same
  // destructive-controls toggle as Give/Fill (issue #371, widened same day
  // after an operator-reported oversight -- these previously rendered
  // whenever deleteAllowed was true regardless of the toggle). Every test
  // below that exercises bulk delete must reveal the toggle first via
  // showGiveFill(), exactly like every Give/Fill test already does.

  it("hides the per-row bulk-select checkboxes and the Delete Selected/Delete All buttons by default", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();

    expect(screen.queryAllByRole("checkbox", { name: /Select Granite Stone for bulk delete/ }).length).toBe(0);
    expect(screen.queryByRole("button", { name: /Delete Selected/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete All" })).toBeNull();
    // The single-item delete strip (per-row trash icon) is a distinct,
    // pre-existing capability this toggle does NOT gate -- it must stay
    // available even while the toggle is off.
    expect(screen.getAllByRole("button", { name: /^Delete Granite Stone/ }).length).toBeGreaterThan(0);
  });

  it("reveals the per-row bulk-select checkboxes and Delete Selected/Delete All once the destructive-controls toggle is on", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    expect(screen.getAllByRole("checkbox", { name: /Select Granite Stone for bulk delete/ }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Delete Selected \(0\)/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete All" })).toBeTruthy();
  });

  it("selects several items and deletes only the checked ones", async () => {
    mockInventory();
    vi.mocked(basesApi.deleteContainerItems).mockResolvedValue({
      supported: true,
      result: {
        ok: true, baseId: 1006, placeableId: "40001", inventoryId: "9001",
        typeName: "Storage Container", group: "storage",
        removed: [
          { itemId: "501", templateId: "Stone", count: 600 },
          { itemId: "503", templateId: "Stone", count: 400 }
        ],
        message: "2 of 2 requested item(s) were deleted from the database.",
        deleteSafety: { safe: true, known: true, map: "HaggaBasin", partitionId: 1, reason: "" }
      }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    const checkboxes = screen.getAllByRole("checkbox", { name: /Select Granite Stone for bulk delete/ });
    expect(checkboxes.length).toBe(2);
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);

    fireEvent.click(screen.getByRole("button", { name: /Delete Selected \(2\)/ }));
    await waitFor(() => expect(basesApi.deleteContainerItems).toHaveBeenCalled());
    expect(vi.mocked(basesApi.deleteContainerItems).mock.calls[0]).toEqual([
      "1006", "40001", ["501", "503"], "DELETE ITEMS"
    ]);
    await waitFor(() => expect(vi.mocked(basesApi.inventory).mock.calls.length).toBeGreaterThan(1));
  });

  it("disables Delete Selected until at least one item is checked", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    const deleteSelected = screen.getByRole("button", { name: /Delete Selected \(0\)/ }) as HTMLButtonElement;
    expect(deleteSelected.disabled).toBe(true);
  });

  it("does not call the bulk-delete API when the confirmation is declined", async () => {
    mockInventory();
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();
    // showGiveFill()'s own toggle-on confirmation already resolved true
    // above; only bulk delete's own confirmation should be declined here.
    confirmAction.mockResolvedValue(false);

    const checkboxes = screen.getAllByRole("checkbox", { name: /Select Granite Stone for bulk delete/ });
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByRole("button", { name: /Delete Selected \(1\)/ }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(basesApi.deleteContainerItems).not.toHaveBeenCalled();
  });

  it("clears every item in the container via Delete All", async () => {
    mockInventory();
    vi.mocked(basesApi.deleteAllContainerItems).mockResolvedValue({
      supported: true,
      result: {
        ok: true, baseId: 1006, placeableId: "40001", inventoryId: "9001",
        typeName: "Storage Container", group: "storage",
        removed: [
          { itemId: "501", templateId: "Stone", count: 600 },
          { itemId: "502", templateId: "MagnetiteOre", count: 200 },
          { itemId: "503", templateId: "Stone", count: 400 }
        ],
        message: "3 item(s) were deleted from the database.",
        deleteSafety: { safe: true, known: true, map: "HaggaBasin", partitionId: 1, reason: "" }
      }
    } as never);
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    fireEvent.click(screen.getByRole("button", { name: "Delete All" }));
    await waitFor(() => expect(basesApi.deleteAllContainerItems).toHaveBeenCalled());
    expect(vi.mocked(basesApi.deleteAllContainerItems).mock.calls[0]).toEqual(["1006", "40001", "DELETE ALL ITEMS"]);
    await waitFor(() => expect(vi.mocked(basesApi.inventory).mock.calls.length).toBeGreaterThan(1));
  });

  it("does not offer bulk-delete controls when the map cannot be verified safe, even with the destructive-controls toggle on", async () => {
    mockInventory();
    mockSlots({
      ...SLOTS,
      deleteSafety: {
        safe: false, known: true, map: "HaggaBasin", partitionId: 68,
        reason: "HaggaBasin · Partition 68 is running. Stop that map before deleting stored items."
      }
    });
    renderTab();
    await loaded();
    await openVaultContents();

    expect(screen.queryByRole("button", { name: /Delete Selected/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete All" })).toBeNull();
    // Give/Fill are pure inserts and stay available regardless of map
    // safety -- and turning the shared toggle on must still not reveal
    // bulk delete, since that half of the gate (deleteAllowed) is false.
    await showGiveFill();
    expect(screen.getByRole("combobox", { name: "Item to give" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Delete Selected/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete All" })).toBeNull();
  });

  it("reports a failed bulk delete through onError without clearing the selection state silently", async () => {
    mockInventory();
    vi.mocked(basesApi.deleteContainerItems).mockRejectedValue(new Error("database is unreachable"));
    renderTab();
    await loaded();
    await openVaultContents();
    await showGiveFill();

    const checkboxes = screen.getAllByRole("checkbox", { name: /Select Granite Stone for bulk delete/ });
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByRole("button", { name: /Delete Selected \(1\)/ }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("database is unreachable"));
  });
});
