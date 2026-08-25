import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { basesApi, type AutoRefillBase } from "../../api/bases";
import { mapsApi } from "../../api/maps";
import { BasesPanel } from "./BasesPanel";
import { invalidateInstanceNames } from "../maps/instanceNames";

vi.mock("../../api/bases", () => ({
  basesApi: {
    list: vi.fn(),
    forPlayer: vi.fn(),
    refillGenerators: vi.fn(),
    cancelQueuedRefill: vi.fn(),
    pendingRefills: vi.fn(),
    deleteBase: vi.fn(),
    cancelQueuedDelete: vi.fn(),
    pendingDeletes: vi.fn(),
    autoRefill: vi.fn(),
    setAutoRefill: vi.fn(),
    landClaim: vi.fn(),
    updateLandClaim: vi.fn(),
    permissions: vi.fn(),
    setPermissions: vi.fn(),
    transferToSystemCustodian: vi.fn(),
    permissionCandidates: vi.fn(),
    childAccess: vi.fn(),
    setChildAccess: vi.fn(),
    water: vi.fn(),
    refillWater: vi.fn(),
    cancelQueuedWaterRefill: vi.fn(),
    pendingWaterRefills: vi.fn(),
    autoRefillWater: vi.fn(),
    setAutoRefillWater: vi.fn(),
    inventory: vi.fn(),
    containerSlots: vi.fn(),
    deleteContainerItem: vi.fn(),
    addContainerItem: vi.fn()
  }
}));

vi.mock("../../api/client", () => ({
  apiDownload: vi.fn()
}));

vi.mock("../../api/maps", () => ({
  mapsApi: {
    sietchDimensions: vi.fn(),
    restartSietch: vi.fn(),
    respawn: vi.fn()
  }
}));

// BaseInventoryTab's Give/Fill panels use ItemCatalogCombobox, which fetches
// the catalog via adminApi.itemCatalog() on mount -- needed by this file's
// own inventory-tab-related tests, the same way BaseInventoryTab.test.tsx
// mocks it directly.
vi.mock("../../api/admin", () => ({
  adminApi: {
    itemCatalog: vi.fn().mockResolvedValue({ rows: [] })
  }
}));

function renderPanel(overrides: Partial<Parameters<typeof BasesPanel>[0]> = {}) {
  const props = {
    onError: vi.fn(),
    confirmAction: vi.fn().mockResolvedValue(true),
    restartGate: vi.fn().mockResolvedValue("immediate"),
    formatMutationResult: vi.fn().mockReturnValue("Action completed."),
    ...overrides
  };
  render(<BasesPanel {...props} />);
  return props;
}

const commonRow = {
  base_type: "Sub-Fief",
  owner_name: "Chani",
  shared_with: [],
  map: "TheDeepDesert",
  partition_id: 8,
  x: 100,
  y: 200,
  z: 30,
  piece_count: 10,
  placeable_count: 4,
  fuelCells: 0,
  generatorRuntimeSeconds: 0,
  generators: []
};

beforeEach(() => {
  vi.clearAllMocks();
  // Instance names are cached at module scope so remounting the panel does not
  // respawn the CLI. That cache outlives a single test, so a case asserting a
  // cold lookup would otherwise read the previous case's resolved names.
  invalidateInstanceNames();
});

describe("BasesPanel player scope", () => {
  it("loads only the selected player's owned and shared bases", async () => {
    vi.mocked(basesApi.forPlayer).mockResolvedValue({
      capabilities: { bases: true },
      totalCount: 2,
      totalBases: 2,
      totalOwned: 1,
      totalShared: 1,
      totalPieces: 20,
      totalPlaceables: 8,
      rows: [
        { ...commonRow, base_id: "4101", name: "Owned Home", relationship: "Owner", generatorDataAvailable: false, generatorCount: 0 },
        { ...commonRow, base_id: "4102", name: "Shared Workshop", owner_name: "Stilgar", relationship: "Associate", generatorDataAvailable: false, generatorCount: 0 }
      ]
    });

    renderPanel({ playerId: "42", playerName: "Chani", embedded: true });

    await waitFor(() => expect(basesApi.forPlayer).toHaveBeenCalledWith("42", expect.objectContaining({ page: 0, pageSize: 5000 })));
    expect(basesApi.list).not.toHaveBeenCalled();
    expect(await screen.findByText("Owned Home")).toBeInTheDocument();
    expect(screen.getByText("Shared Workshop")).toBeInTheDocument();
    const summary = screen.getByLabelText("Player base totals");
    expect(summary).toHaveTextContent("2 Total");
    expect(summary).toHaveTextContent("1 Owned");
    expect(summary).toHaveTextContent("1 Shared");
    expect(summary).toHaveTextContent("20 Building Pieces");
    expect(summary).toHaveTextContent("8 Placeables");
    expect(screen.getByText(/Bases owned by or shared with Chani/)).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Rows" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "First" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Page 1 of/)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search ID, name, type, or owner")).not.toBeInTheDocument();
  });
});

describe("BasesPanel focused navigation", () => {
  it("finds, expands, and focuses a base opened from another panel", async () => {
    vi.mocked(basesApi.list).mockResolvedValue({
      capabilities: { bases: true },
      totalCount: 1,
      totalBases: 1,
      totalPieces: 10,
      totalPlaceables: 4,
      rows: [{
        ...commonRow,
        base_id: "31573",
        name: "Desert Home",
        generatorDataAvailable: false,
        generatorCount: 0
      }]
    });

    renderPanel({ focusRequest: { baseId: "31573", nonce: 1 } });

    await waitFor(() => expect(basesApi.list).toHaveBeenCalledWith(expect.objectContaining({ q: "31573", page: 0 })));
    expect(await screen.findByDisplayValue("31573")).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: "Power" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("BasesPanel generator details", () => {
  it("keeps fuel and spice generators separate and distinguishes unavailable data", async () => {
    vi.mocked(basesApi.list).mockResolvedValue({
      capabilities: { bases: true },
      totalCount: 2,
      totalBases: 2,
      totalPieces: 20,
      totalPlaceables: 8,
      rows: [
        {
          ...commonRow,
          base_id: "1006",
          name: "Sietch One",
          generatorDataAvailable: true,
          generatorCount: 2,
          fuelCells: 3,
          generatorRuntimeSeconds: 7200,
          generatorUptimeMultiplier: 2,
          generatorUptimeEventLabel: "Double generator uptime event",
          generatorUptimeEventEndsAt: "2026-09-01T00:00:00.000Z",
          generators: [
            { type: "fuel", name: "Fuel-Powered Generator", fuelName: "Fuel Cell", fuelCells: 1, generatorCount: 1, runtimeSeconds: 7200 },
            { type: "spice", name: "Spice-Powered Generator", fuelName: "Spice-infused Fuel Cell", fuelCells: 2, generatorCount: 1, runtimeSeconds: 21600 }
          ]
        },
        {
          ...commonRow,
          base_id: "1007",
          name: "Sietch Two",
          generatorDataAvailable: false,
          generatorCount: 0
        }
      ]
    });

    renderPanel();

    await waitFor(() => expect(screen.getByText("2 · Lowest Queued Reserve 2h 0m", { selector: ".bases-generator-summary" })).toBeInTheDocument());
    expect(screen.getByRole("columnheader", { name: /Base Name/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Building Pieces/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Placeables/ })).toBeInTheDocument();
    // A native title tooltip repeats the same text so a hover always shows it
    // in full, even if a narrow column ever clips the visible text.
    expect(screen.getByText("2 · Lowest Queued Reserve 2h 0m", { selector: ".bases-generator-summary" })).toHaveAttribute(
      "title",
      "2 · Lowest Queued Reserve 2h 0m. Queued Reserve counts fuel still in inventory. It excludes fuel currently burning, so the in-game Total Uptime may be higher."
    );
    expect(screen.getByText("Unavailable")).toHaveAttribute("title", "Generator data is unavailable");
    // The chevron always renders now -- every base can be expanded into at
    // least the Water tab, even one with no generator data at all.
    expect(screen.getByRole("button", { name: "Show details for Sietch Two" })).toBeInTheDocument();
    // Column headers get the same tooltip treatment for when their label is
    // wider than the (user-resizable) column default.
    expect(screen.getByRole("columnheader", { name: /Building Pieces/ })).toHaveAttribute("title", "Building Pieces");

    fireEvent.click(screen.getByRole("button", { name: "Show details for Sietch One" }));

    expect(screen.getByText("Fuel-Powered Generator")).toBeInTheDocument();
    expect(screen.getByText("Spice-Powered Generator")).toBeInTheDocument();
    expect(document.querySelectorAll(".bases-card")).toHaveLength(2);
    expect(screen.getAllByText("Fuel Queued")).toHaveLength(2);
    expect(screen.getByText("1 Fuel Cell")).toBeInTheDocument();
    expect(screen.getByText("2 Spice-infused Fuel Cells")).toBeInTheDocument();
    expect(screen.getByText("2h 0m")).toBeInTheDocument();
    expect(screen.getByText("6h 0m")).toBeInTheDocument();
    expect(screen.getByText("2× Uptime Event")).toHaveClass("bases-uptime-event-badge");
    expect(screen.getByText(/Ends Aug 31, 2026/)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("Queued Reserve counts fuel still in inventory");
    expect(screen.getByRole("note")).toHaveTextContent("excludes fuel currently burning");
  });

  it("renders both wind turbine types and reports generators with no queued fuel", async () => {
    vi.mocked(basesApi.list).mockResolvedValue({
      capabilities: { bases: true },
      totalCount: 1,
      totalBases: 1,
      totalPieces: 10,
      totalPlaceables: 4,
      rows: [
        {
          ...commonRow,
          base_id: "1008",
          name: "Sietch Three",
          generatorDataAvailable: true,
          generatorCount: 4,
          // The lowest queued reserve excludes the unstocked fuel generator.
          generatorRuntimeSeconds: 10800,
          generatorUnstockedCount: 1,
          generatorAllUnstocked: false,
          generators: [
            { type: "fuel", name: "Fuel-Powered Generator", fuelName: "Fuel Cell", fuelCells: 0, generatorCount: 1, runtimeSeconds: 0, unstockedCount: 1 },
            { type: "spice", name: "Spice-Powered Generator", fuelName: "Spice-infused Fuel Cell", fuelCells: 2, generatorCount: 1, runtimeSeconds: 10800, unstockedCount: 0 },
            { type: "windTurbineOmni", name: "Omnidirectional Wind Turbine", fuelName: "Lubricant", fuelCells: 467, generatorCount: 1, runtimeSeconds: 1681200, unstockedCount: 0 },
            { type: "windTurbineDirectional", name: "Directional Wind Turbine", fuelName: "Lubricant", fuelCells: 38, generatorCount: 1, runtimeSeconds: 205200, unstockedCount: 0 }
          ]
        }
      ]
    });

    renderPanel();

    // Wait for this test's API response specifically. Waiting for any summary
    // is flaky because the panel intentionally renders its module-level cache
    // while the fresh request is in flight.
    const alert = await screen.findByText("1 with no queued fuel", { selector: ".bases-fuel-alert" });
    const summary = alert.closest(".bases-generator-summary");
    expect(summary?.textContent?.replace(/\s+/g, " ").trim()).toBe("4 · 1 with no queued fuel Lowest Queued Reserve 3h 0m");
    expect(summary).toHaveAttribute(
      "title",
      "4 · 1 with no queued fuel · Lowest Queued Reserve 3h 0m. Queued Reserve counts fuel still in inventory. It excludes fuel currently burning, so the in-game Total Uptime may be higher."
    );

    fireEvent.click(screen.getByRole("button", { name: "Show details for Sietch Three" }));

    expect(screen.getByText("Fuel-Powered Generator")).toBeInTheDocument();
    expect(screen.getByText("Spice-Powered Generator")).toBeInTheDocument();
    expect(screen.getByText("Omnidirectional Wind Turbine")).toBeInTheDocument();
    expect(screen.getByText("Directional Wind Turbine")).toBeInTheDocument();
    expect(screen.getByText("1 of 1")).toBeInTheDocument();
  });

  it("reports when every generator has no queued fuel without claiming active burns stopped", async () => {
    vi.mocked(basesApi.list).mockResolvedValue({
      capabilities: { bases: true },
      totalCount: 1,
      totalBases: 1,
      totalPieces: 10,
      totalPlaceables: 4,
      rows: [
        {
          ...commonRow,
          base_id: "1009",
          name: "Sietch Four",
          generatorDataAvailable: true,
          generatorCount: 2,
          generatorRuntimeSeconds: 0,
          generatorUnstockedCount: 2,
          generatorAllUnstocked: true,
          generators: [
            { type: "fuel", name: "Fuel-Powered Generator", fuelName: "Fuel Cell", fuelCells: 0, generatorCount: 2, runtimeSeconds: 0, unstockedCount: 2 }
          ]
        }
      ]
    });

    renderPanel();

    const alert = await screen.findByText("No generators have queued fuel", { selector: ".bases-fuel-alert" });
    const summary = alert.closest(".bases-generator-summary");
    expect(summary?.textContent?.replace(/\s+/g, " ").trim()).toBe("2 · No generators have queued fuel");
    expect(summary).toHaveAttribute(
      "title",
      "2 · No generators have queued fuel. Queued Reserve counts fuel still in inventory. It excludes fuel currently burning, so the in-game Total Uptime may be higher."
    );
  });
});

describe("BasesPanel generator refill", () => {
  function listResponse(capabilities: Record<string, unknown>, row: Record<string, unknown>) {
    return {
      capabilities,
      totalCount: 1,
      totalBases: 1,
      totalPieces: 10,
      totalPlaceables: 4,
      rows: [{ ...commonRow, ...row }]
    };
  }

  const stockedBase = {
    base_id: "2001",
    name: "Sietch Refill",
    generatorDataAvailable: true,
    generatorCount: 2,
    generatorRuntimeSeconds: 7200,
    generators: [
      { type: "fuel", name: "Fuel-Powered Generator", fuelName: "Fuel Cell", fuelCells: 1, generatorCount: 1, runtimeSeconds: 7200 }
    ]
  };

  // Every test in this file shares the panel's module-level cache, so the
  // previous test's rows render while this test's request is still in flight.
  // Each base name is unique; waiting for it proves the fresh rows landed and
  // that the capability flag alongside them has been applied.
  async function awaitFreshRows(baseName: string) {
    await screen.findByText(baseName);
    return screen.getByRole("button", { name: "Refill Generators" });
  }

  it("confirms, posts the refill, and reports what each device gained", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(listResponse({ bases: true, generatorRefill: true }, stockedBase));
    vi.mocked(basesApi.refillGenerators).mockResolvedValue({
      supported: true,
      result: {
        ok: true,
        baseId: 2001,
        totalAdded: 856,
        devices: [
          { placeableId: "91204", type: "fuel", label: "Fuel-Powered Generator", fuelName: "Fuel Cell", before: 42, after: 499, added: 457, capped: false },
          { placeableId: "91318", type: "windTurbineOmni", label: "Omnidirectional Wind Turbine", fuelName: "Low-grade Lubricant", before: 100, after: 499, added: 399, capped: false }
        ]
      }
    });

    const props = renderPanel();
    const refill = await awaitFreshRows("Sietch Refill");
    expect(refill).toBeEnabled();

    fireEvent.click(refill);

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      'Refill 2 power devices at "Sietch Refill" to full fuel?',
      {
        title: "Refill Generators",
        confirmLabel: "Refill",
        // This base's schema reports generatorRefill without generatorRefillQueue,
        // so the dialog must warn about the direct write rather than promise queueing.
        warning: expect.stringContaining("Refill writes fuel straight to the database")
      }
    ));
    await waitFor(() => expect(basesApi.refillGenerators).toHaveBeenCalledWith("2001"));
    expect(await screen.findByText(/Added 856 fuel units across 2 devices/)).toBeInTheDocument();
    expect(screen.getByText(/Fuel-Powered Generator: \+457 Fuel Cells/)).toBeInTheDocument();
    expect(screen.getByText(/Omnidirectional Wind Turbine: \+399 Low-grade Lubricants/)).toBeInTheDocument();
    // The list is refetched so the row shows post-refill fuel, not the cache.
    expect(vi.mocked(basesApi.list).mock.calls.length).toBeGreaterThan(1);
  });

  it("does not post when the confirm dialog is declined", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(listResponse({ bases: true, generatorRefill: true }, { ...stockedBase, base_id: "2002", name: "Sietch Declined" }));

    renderPanel({ confirmAction: vi.fn().mockResolvedValue(false) });
    fireEvent.click(await awaitFreshRows("Sietch Declined"));

    await waitFor(() => expect(basesApi.refillGenerators).not.toHaveBeenCalled());
  });

  it("reports an already-full base as nothing added rather than a failure", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(listResponse({ bases: true, generatorRefill: true }, { ...stockedBase, base_id: "2003", name: "Sietch Full" }));
    vi.mocked(basesApi.refillGenerators).mockResolvedValue({
      supported: true,
      result: {
        ok: true,
        baseId: 2003,
        totalAdded: 0,
        devices: [
          { placeableId: "91204", type: "fuel", label: "Fuel-Powered Generator", fuelName: "Fuel Cell", before: 499, after: 499, added: 0, capped: false }
        ]
      }
    });

    renderPanel();
    fireEvent.click(await awaitFreshRows("Sietch Full"));

    expect(await screen.findByText("All 1 device was already full. Nothing added.")).toBeInTheDocument();
  });

  it("disables refill when the database cannot support it or the base has no generators", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(listResponse({ bases: true, generatorRefill: false }, { ...stockedBase, base_id: "2004", name: "Sietch Unsupported" }));

    renderPanel();

    const refill = await awaitFreshRows("Sietch Unsupported");
    expect(refill).toBeDisabled();
    expect(refill).toHaveAttribute("title", "Refill is unsupported on this database");
  });

  it("disables refill when generator data could not be read", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(listResponse(
      { bases: true, generatorRefill: true },
      { ...stockedBase, base_id: "2005", name: "Sietch Unknown", generatorDataAvailable: false, generatorCount: 0, generators: [] }
    ));

    renderPanel();

    const refill = await awaitFreshRows("Sietch Unknown");
    expect(refill).toBeDisabled();
    expect(refill).toHaveAttribute("title", "Generator data is unavailable for this base");
  });
});

describe("BasesPanel base deletion", () => {
  function listResponse(capabilities: Record<string, unknown>, row: Record<string, unknown>) {
    return {
      capabilities,
      totalCount: 1,
      totalBases: 1,
      totalPieces: 10,
      totalPlaceables: 4,
      rows: [{ ...commonRow, ...row }]
    };
  }

  const deletableBase = {
    base_id: "2101",
    name: "Sietch Delete",
    generatorDataAvailable: true,
    generatorCount: 1,
    generators: [
      { type: "fuel", name: "Fuel-Powered Generator", fuelName: "Fuel Cell", fuelCells: 1, generatorCount: 1, runtimeSeconds: 0 }
    ]
  };

  beforeEach(() => {
    vi.mocked(basesApi.pendingDeletes).mockResolvedValue({ supported: true, total: 0, pending: [], byTarget: [] });
  });

  async function awaitFreshRows(baseName: string) {
    await screen.findByText(baseName);
    return screen.getByRole("button", { name: "Delete Base" });
  }

  it("hides the Delete Base action when the schema does not support it", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(listResponse({ bases: true }, { ...deletableBase, base_id: "2100", name: "Sietch NoDelete" }));

    renderPanel();
    await screen.findByText("Sietch NoDelete");

    expect(screen.queryByRole("button", { name: "Delete Base" })).not.toBeInTheDocument();
  });

  it("confirms with the piece/placeable counts and deletes immediately when the map is already write-safe", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(listResponse({ bases: true, baseDelete: true, baseDeleteQueue: false }, deletableBase));
    vi.mocked(basesApi.deleteBase).mockResolvedValue({
      supported: true,
      backupCreated: true,
      result: { ok: true, baseId: 2101, deletedActorCount: 5, deletedBuildingCount: 3, deletedPlaceableCount: 1 }
    });

    const props = renderPanel();
    const deleteButton = await awaitFreshRows("Sietch Delete");
    expect(deleteButton).toBeEnabled();

    fireEvent.click(deleteButton);

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      'Delete "Sietch Delete"? This permanently deletes the base and everything built or stored in it.',
      {
        title: "Delete Base",
        confirmLabel: "Delete",
        danger: true,
        details: [
          { label: "Building Pieces", value: "10", tone: "danger" },
          { label: "Placeables", value: "4", tone: "danger" }
        ],
        // No queue capability on this schema, so the warning must promise an
        // immediate write, not a queued one.
        warning: expect.stringContaining("straight to the database")
      }
    ));
    await waitFor(() => expect(basesApi.deleteBase).toHaveBeenCalledWith("2101"));
    expect(await screen.findByText('"Sietch Delete" was deleted.')).toBeInTheDocument();
    // The row is gone, so the list is refetched rather than patched locally.
    expect(vi.mocked(basesApi.list).mock.calls.length).toBeGreaterThan(1);
  });

  it("does not delete when the confirm dialog is declined", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(listResponse(
      { bases: true, baseDelete: true, baseDeleteQueue: false },
      { ...deletableBase, base_id: "2102", name: "Sietch Declined Delete" }
    ));

    renderPanel({ confirmAction: vi.fn().mockResolvedValue(false) });
    fireEvent.click(await awaitFreshRows("Sietch Declined Delete"));

    await waitFor(() => expect(basesApi.deleteBase).not.toHaveBeenCalled());
  });

  it("queues the delete when the map is live and warns that it will apply on the next restart", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(listResponse(
      { bases: true, baseDelete: true, baseDeleteQueue: true },
      { ...deletableBase, base_id: "2103", name: "Sietch Queue Delete" }
    ));
    vi.mocked(basesApi.deleteBase).mockResolvedValue({
      supported: true,
      backupCreated: false,
      result: { ok: true, queued: true, baseId: 2103, map: "HaggaBasin", partitionId: 3 }
    });

    const props = renderPanel();
    fireEvent.click(await awaitFreshRows("Sietch Queue Delete"));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      'Delete "Sietch Queue Delete"? This permanently deletes the base and everything built or stored in it.',
      expect.objectContaining({ warning: expect.stringContaining("queued and applied") })
    ));
    await waitFor(() => expect(basesApi.deleteBase).toHaveBeenCalledWith("2103"));
    expect(await screen.findByText(/is queued and applies when this map next restarts or stops/)).toBeInTheDocument();
    expect(basesApi.pendingDeletes).toHaveBeenCalled();
  });

  it("shows the queued-delete pill, blocks refills on that row, and cancels through basesApi.cancelQueuedDelete", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(listResponse(
      { bases: true, baseDelete: true, baseDeleteQueue: true, generatorRefill: true },
      { ...deletableBase, base_id: "2104", name: "Sietch Pending Delete" }
    ));
    vi.mocked(basesApi.pendingDeletes).mockResolvedValue({
      supported: true,
      total: 1,
      pending: [{ baseId: 2104, map: "HaggaBasin", partitionId: 3, queuedAt: new Date().toISOString(), attempts: 0, lastError: "" }],
      byTarget: [{ map: "HaggaBasin", partitionId: 3, partitionMap: "Survival_1", dimensionIndex: 0, count: 1 }]
    });

    renderPanel();
    await screen.findByText("Sietch Pending Delete");

    expect(await screen.findByRole("button", { name: "Cancel Queued Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Base" })).not.toBeInTheDocument();

    // Server-side, this base rejects every other mutation while its delete is
    // pending -- the row must not offer a control that would just 409.
    const refill = screen.getByRole("button", { name: "Refill Generators" });
    expect(refill).toBeDisabled();
    expect(refill).toHaveAttribute("title", "Blocked while a delete is queued for this base");
  });

  it("cancelling the queued delete calls the API and refreshes the pending list", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(listResponse(
      { bases: true, baseDelete: true, baseDeleteQueue: true },
      { ...deletableBase, base_id: "2105", name: "Sietch Cancel Delete" }
    ));
    vi.mocked(basesApi.pendingDeletes).mockResolvedValue({
      supported: true,
      total: 1,
      pending: [{ baseId: 2105, map: "HaggaBasin", partitionId: 3, queuedAt: new Date().toISOString(), attempts: 0, lastError: "" }],
      byTarget: [{ map: "HaggaBasin", partitionId: 3, partitionMap: "Survival_1", dimensionIndex: 0, count: 1 }]
    });
    vi.mocked(basesApi.cancelQueuedDelete).mockResolvedValue({ supported: true, result: { ok: true, baseId: 2105, pending: 0 } });

    const props = renderPanel();
    await screen.findByText("Sietch Cancel Delete");

    fireEvent.click(await screen.findByRole("button", { name: "Cancel Queued Delete" }));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      'Cancel the queued delete for "Sietch Cancel Delete"?',
      { title: "Cancel Queued Delete", confirmLabel: "Cancel Delete" }
    ));
    await waitFor(() => expect(basesApi.cancelQueuedDelete).toHaveBeenCalledWith("2105"));
    expect(await screen.findByText('Queued delete for "Sietch Cancel Delete" was canceled.')).toBeInTheDocument();
  });
});

describe("BasesPanel auto-refill", () => {
  const enrollableBase = {
    ...commonRow,
    generatorDataAvailable: true,
    generatorCount: 2,
    fuelCells: 12,
    generatorRuntimeSeconds: 7200,
    generators: [
      { type: "fuel", name: "Fuel-Powered Generator", fuelName: "Fuel Cell", fuelCells: 12, generatorCount: 2, runtimeSeconds: 7200 }
    ]
  };

  function queueCapableList(row: Record<string, unknown>) {
    return {
      capabilities: { bases: true, generatorRefill: true, generatorRefillQueue: true },
      totalCount: 1,
      totalBases: 1,
      totalPieces: 10,
      totalPlaceables: 4,
      rows: [{ ...enrollableBase, ...row }]
    };
  }

  function enrolled(baseId: number, overrides: Partial<AutoRefillBase> = {}): AutoRefillBase {
    return {
      baseId,
      enabledAt: "2026-07-29T12:00:00.000Z",
      lastCheckedAt: "",
      lastQueuedAt: "",
      lastLowestPercent: null,
      consecutiveQueues: 0,
      stalledAt: "",
      ...overrides
    };
  }

  function autoRefillState(bases: AutoRefillBase[] = []) {
    return {
      supported: true,
      thresholdPercent: 50,
      intervalHours: 24,
      nextRunAt: "2026-07-31T12:00:00.000Z",
      lastRunAt: "",
      lastRunStatus: "",
      lastRunDetail: "",
      total: bases.length,
      bases
    };
  }

  beforeEach(() => {
    vi.mocked(basesApi.pendingRefills).mockResolvedValue({ supported: true, total: 0, pending: [], byTarget: [] });
    vi.mocked(basesApi.autoRefill).mockResolvedValue(autoRefillState());
  });

  async function expandRow(name: string) {
    await screen.findByText(name);
    fireEvent.click(await screen.findByRole("button", { name: `Show details for ${name}` }));
  }

  it("offers the toggle only when the database supports the refill queue", async () => {
    vi.mocked(basesApi.list).mockResolvedValue({
      capabilities: { bases: true, generatorRefill: true },
      totalCount: 1,
      totalBases: 1,
      totalPieces: 10,
      totalPlaceables: 4,
      rows: [{ ...enrollableBase, base_id: "3001", name: "Sietch NoQueue" }]
    });

    renderPanel();
    await expandRow("Sietch NoQueue");

    // Without dune.world_partition a refill cannot wait for a safe window, so
    // automating it would write into a possibly-live base.
    expect(screen.queryByText("Auto-Refill")).not.toBeInTheDocument();
    expect(basesApi.autoRefill).not.toHaveBeenCalled();
  });

  it("shows the rule and turns auto-refill on without refetching the base list", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(queueCapableList({ base_id: "3002", name: "Sietch Enroll" }));
    vi.mocked(basesApi.setAutoRefill).mockResolvedValue({ ok: true, baseId: 3002, enabled: true, total: 1 });

    const props = renderPanel();
    await waitFor(() => expect(basesApi.autoRefill).toHaveBeenCalled());
    await expandRow("Sietch Enroll");

    expect(screen.getByText("Auto-Refill")).toBeInTheDocument();
    expect(screen.getByText("OFF")).toBeInTheDocument();
    // The rule explanation lives in an InfoTooltip (the same component Maps
    // uses for Host Memory Protection etc.), not as visible text -- the row's
    // grid column can be as narrow as 240px.
    expect(screen.getByRole("tooltip")).toHaveTextContent("Checked every 24h. Queues a refill when any generator drops below 50%.");

    const listCallsBefore = vi.mocked(basesApi.list).mock.calls.length;
    fireEvent.click(screen.getByText("Auto-Refill"));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      'Turn on auto-refill for "Sietch Enroll"?',
      {
        title: "Auto-Refill",
        confirmLabel: "Turn On",
        // The dialog must be explicit that this never restarts a map by itself.
        warning: expect.stringContaining("auto-refill never restarts a map by itself")
      }
    ));
    await waitFor(() => expect(basesApi.setAutoRefill).toHaveBeenCalledWith("3002", true));
    expect(await screen.findByText("ON")).toBeInTheDocument();
    // Enrollment is not part of a base row, and basesApi.list is expensive.
    expect(vi.mocked(basesApi.list).mock.calls.length).toBe(listCallsBefore);
  });

  it("does not enroll when the confirm dialog is declined", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(queueCapableList({ base_id: "3003", name: "Sietch Declined Auto" }));

    renderPanel({ confirmAction: vi.fn().mockResolvedValue(false) });
    await expandRow("Sietch Declined Auto");
    fireEvent.click(screen.getByText("Auto-Refill"));

    await waitFor(() => expect(basesApi.setAutoRefill).not.toHaveBeenCalled());
  });

  it("turns auto-refill off without a confirm dialog", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(queueCapableList({ base_id: "3004", name: "Sietch Disable" }));
    vi.mocked(basesApi.autoRefill).mockResolvedValue(autoRefillState([
      enrolled(3004)
    ]));
    vi.mocked(basesApi.setAutoRefill).mockResolvedValue({ ok: true, baseId: 3004, enabled: false, total: 0 });

    const props = renderPanel();
    await expandRow("Sietch Disable");

    expect(await screen.findByText("ON")).toBeInTheDocument();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Not checked yet.");

    fireEvent.click(screen.getByText("Auto-Refill"));

    await waitFor(() => expect(basesApi.setAutoRefill).toHaveBeenCalledWith("3004", false));
    // Turning automation off is not a destructive action.
    expect(props.confirmAction).not.toHaveBeenCalled();
    expect(await screen.findByText("OFF")).toBeInTheDocument();
  });

  it("reports the last check result once a scan has run", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(queueCapableList({ base_id: "3005", name: "Sietch Checked" }));
    vi.mocked(basesApi.autoRefill).mockResolvedValue(autoRefillState([
      enrolled(3005, { lastCheckedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), lastLowestPercent: 78 })
    ]));

    renderPanel();
    await expandRow("Sietch Checked");

    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent(/Last checked 3h ago . lowest 78%\./));
  });

  it("marks the refill button as automated while keeping it clickable", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(queueCapableList({ base_id: "3006", name: "Sietch Marked" }));
    vi.mocked(basesApi.autoRefill).mockResolvedValue(autoRefillState([
      enrolled(3006)
    ]));
    vi.mocked(basesApi.refillGenerators).mockResolvedValue({
      supported: true,
      result: { ok: true, baseId: 3006, queued: true, map: "DeepDesert_1", partitionId: 8 }
    });

    renderPanel();
    await screen.findByText("Sietch Marked");

    // No new column and no extra glyph: the actions column is a fixed 96px.
    const refill = await screen.findByRole("button", { name: "Refill Generators (auto-refill on)" });
    expect(refill).toHaveClass("bases-auto-refill-on");
    expect(refill).toHaveAttribute("title", expect.stringContaining("Click to refill now"));
    // Enrolling a base must not cost the operator the on-demand refill.
    expect(refill).toBeEnabled();

    fireEvent.click(refill);

    await waitFor(() => expect(basesApi.refillGenerators).toHaveBeenCalledWith("3006"));
  });

  it("keeps the queued pill when a base is both enrolled and already queued", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(queueCapableList({ base_id: "3007", name: "Sietch Queued Auto" }));
    vi.mocked(basesApi.autoRefill).mockResolvedValue(autoRefillState([
      enrolled(3007, { lastQueuedAt: "2026-07-30T11:00:00.000Z", lastLowestPercent: 12 })
    ]));
    vi.mocked(basesApi.pendingRefills).mockResolvedValue({
      supported: true,
      total: 1,
      pending: [{ baseId: 3007, map: "DeepDesert", partitionId: 8, queuedAt: new Date().toISOString(), attempts: 0, lastError: "" }],
      byTarget: [{ map: "DeepDesert", partitionId: 8, partitionMap: "DeepDesert_1", dimensionIndex: 0, count: 1 }]
    });

    renderPanel();
    await screen.findByText("Sietch Queued Auto");

    // The queued state has to keep that slot: its X is the only way to cancel.
    expect(await screen.findByRole("button", { name: "Cancel Queued Refill" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refill Generators (auto-refill on)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refill Generators" })).not.toBeInTheDocument();
  });

  it("calls out queued refills that have waited more than a day", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(queueCapableList({ base_id: "3008", name: "Sietch Stale" }));
    vi.mocked(basesApi.pendingRefills).mockResolvedValue({
      supported: true,
      total: 2,
      pending: [
        { baseId: 3008, map: "DeepDesert", partitionId: 8, queuedAt: new Date(Date.now() - 30 * 3600_000).toISOString(), attempts: 0, lastError: "" },
        { baseId: 3009, map: "DeepDesert", partitionId: 8, queuedAt: new Date().toISOString(), attempts: 0, lastError: "" }
      ],
      byTarget: [{ map: "DeepDesert", partitionId: 8, partitionMap: "DeepDesert_1", dimensionIndex: 0, count: 2 }]
    });

    renderPanel();

    // Otherwise an entry on an always-up map expires silently after 7 days.
    expect(await screen.findByText(/1 queued over 24h/)).toBeInTheDocument();
    expect(screen.getByText(/Restart above to apply\./)).toBeInTheDocument();
  });

  it("points a stale refill at the Maps tab when the banner has no restart button", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(queueCapableList({ base_id: "3010", name: "Sietch Unresolved" }));
    vi.mocked(basesApi.pendingRefills).mockResolvedValue({
      supported: true,
      total: 1,
      // partitionId 0 means the partition never resolved, so this group renders
      // "Restart this map from the Maps tab" instead of a button.
      pending: [{ baseId: 3010, map: "DeepDesert", partitionId: 0, queuedAt: new Date(Date.now() - 30 * 3600_000).toISOString(), attempts: 0, lastError: "" }],
      byTarget: [{ map: "DeepDesert", partitionId: 0, partitionMap: "", dimensionIndex: 0, count: 1 }]
    });

    renderPanel();

    expect(await screen.findByText(/1 queued over 24h/)).toBeInTheDocument();
    // Telling the operator to "restart above" when there is no control above
    // would be wrong exactly when they most need correct guidance.
    expect(screen.getByText(/Restart from the Maps tab to apply\./)).toBeInTheDocument();
    expect(screen.queryByText(/Restart above to apply\./)).not.toBeInTheDocument();
  });

  it("says the enrollment state is unreadable rather than reporting it as off", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(queueCapableList({ base_id: "3011", name: "Sietch Unreadable" }));
    vi.mocked(basesApi.autoRefill).mockRejectedValue(new Error("Postgres is not running"));

    renderPanel();
    await expandRow("Sietch Unreadable");

    // Rendering OFF here would let an operator conclude automation had stopped
    // for every enrolled base and start managing fuel by hand.
    expect(await screen.findByText(/Auto-refill state could not be read/)).toBeInTheDocument();
    expect(screen.queryByText("OFF")).not.toBeInTheDocument();
    expect(screen.queryByText("ON")).not.toBeInTheDocument();

    // And it is recoverable without reloading the page.
    vi.mocked(basesApi.autoRefill).mockResolvedValue(autoRefillState([enrolled(3011)]));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("ON")).toBeInTheDocument();
  });

  it("reports a base whose refills keep failing instead of looking healthy", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(queueCapableList({ base_id: "3012", name: "Sietch Stalled" }));
    vi.mocked(basesApi.autoRefill).mockResolvedValue(autoRefillState([
      enrolled(3012, {
        lastCheckedAt: new Date(Date.now() - 3600_000).toISOString(),
        lastQueuedAt: new Date(Date.now() - 3600_000).toISOString(),
        lastLowestPercent: 8,
        consecutiveQueues: 3,
        stalledAt: new Date(Date.now() - 3600_000).toISOString()
      })
    ]));

    renderPanel();

    // A stalled base surfaces at the page level too, not only inside its own
    // expanded row -- otherwise the operator has to know to look for it.
    expect(await screen.findByText("1 base has stalled auto-refill")).toBeInTheDocument();

    // The actions-column icon turns red rather than staying the "healthy"
    // green: a stalled base is a worse state than "on", not a variant of it.
    const refill = await screen.findByRole("button", { name: "Refill Generators (auto-refill stalled)" });
    expect(refill).toHaveClass("bases-auto-refill-stalled-icon");
    expect(refill).not.toHaveClass("bases-auto-refill-on");
    expect(refill).toHaveAttribute("title", expect.stringContaining("Auto-refill has stalled after 3 refills"));

    await expandRow("Sietch Stalled");

    // Auto-refill giving up has to be visible in the row too, or the operator
    // believes fuel is handled while this base quietly stays empty. Two
    // role="alert" elements now exist (the page banner and this row), so this
    // has to be scoped to the row's own paragraph rather than a bare query.
    const rowAlert = screen.getByText(/Paused after 3 refills that did not raise this base's fuel/);
    expect(rowAlert).toHaveAttribute("role", "alert");
    // Still shown as enrolled, because it is.
    expect(screen.getByText("ON")).toBeInTheDocument();
  });

  it("does not show the stalled banner or icon for a base that is merely queued, not stalled", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(queueCapableList({ base_id: "3013", name: "Sietch Healthy Auto" }));
    vi.mocked(basesApi.autoRefill).mockResolvedValue(autoRefillState([
      enrolled(3013, { lastLowestPercent: 30, consecutiveQueues: 1 })
    ]));

    renderPanel();
    await screen.findByText("Sietch Healthy Auto");

    expect(screen.queryByText(/stalled auto-refill/)).not.toBeInTheDocument();
    const refill = await screen.findByRole("button", { name: "Refill Generators (auto-refill on)" });
    expect(refill).toHaveClass("bases-auto-refill-on");
    expect(refill).not.toHaveClass("bases-auto-refill-stalled-icon");
  });
});

describe("BasesPanel permissions editing", () => {
  const permissionRow = {
    ...commonRow,
    base_id: "1006",
    name: "Sietch One",
    owner_name: "DarkShark",
    shared_with: [{ name: "Yaida", rank: 2, label: "Co-Owner" }],
    generatorDataAvailable: true,
    generatorCount: 0,
    generatorUptimeMultiplier: 1,
    generatorUptimeEventLabel: "",
    generatorUptimeEventEndsAt: "",
    generatorUnstockedCount: 0,
    generatorAllUnstocked: false
  };

  function mockList(basePermissions: boolean) {
    vi.mocked(basesApi.list).mockResolvedValue({
      capabilities: { bases: true, basePermissions },
      totalCount: 1,
      totalBases: 1,
      totalPieces: 10,
      totalPlaceables: 4,
      rows: [permissionRow]
    } as never);
  }

  // The only route into the editor now that the pencil is gone: expand the row,
  // then switch to Permissions.
  async function openPermissionsTab() {
    fireEvent.click(await screen.findByRole("button", { name: "Show details for Sietch One" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Sub-Fief Permissions" }));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Sub-Fief Permissions" })).toHaveAttribute("aria-selected", "true"));
  }

  function mockRoster() {
    vi.mocked(basesApi.permissions).mockResolvedValue({
      supported: true,
      baseId: 1006,
      actorId: "1004",
      map: "DeepDesert",
      mapNameId: 7,
      systemCustodian: { available: true, playerId: "900000201", name: "Server" },
      entries: [
        { playerId: "4", name: "DarkShark", rank: 1, label: "Owner", canonical: true },
        { playerId: "29", name: "Yaida", rank: 2, label: "Co-Owner", canonical: true }
      ]
    } as never);
  }

  it("hides the Permissions tab when the schema does not support it, but still allows expanding into Power/Water", async () => {
    mockList(false);
    renderPanel();
    expect(await screen.findByText("Sietch One")).toBeInTheDocument();
    // The chevron always renders now -- every base can always be expanded
    // into at least the Water tab -- so this base's lack of permission
    // support has to be checked by expanding it, not by the chevron's absence.
    fireEvent.click(await screen.findByRole("button", { name: "Show details for Sietch One" }));
    const powerTab = screen.getByRole("tab", { name: "Power" });
    expect(powerTab).toBeInTheDocument();
    // Details render directly under the clicked row (DataTable's default
    // "inline" placement), not in a separate panel after the whole table.
    expect(powerTab.closest("table")).not.toBeNull();
    expect(screen.getByRole("tab", { name: "Water" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Inventory" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Sub-Fief Permissions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Base Permissions" })).not.toBeInTheDocument();
  });

  it("shows the Base Permissions tab only when the schema supports child access auditing", async () => {
    vi.mocked(basesApi.list).mockResolvedValue({
      capabilities: { bases: true, basePermissions: false, baseChildAccess: true },
      totalCount: 1,
      totalBases: 1,
      totalPieces: 10,
      totalPlaceables: 4,
      rows: [permissionRow]
    } as never);
    vi.mocked(basesApi.childAccess).mockResolvedValue({
      supported: true,
      inspected: 1,
      rows: [{ actorId: "14274", name: "Generator", buildingType: "Generator_Placeable", currentAccess: 2, currentAccessLabel: "Guild", isSubFief: false }]
    } as never);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Show details for Sietch One" }));
    expect(screen.queryByRole("tab", { name: "Sub-Fief Permissions" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("tab", { name: "Base Permissions" }));
    expect(await screen.findByText("Generator", { selector: "strong" })).toBeInTheDocument();
  });

  // Inventory sits between Water and Permissions, and is ungated the way Water
  // is: the backend response, not the tab's absence, reports an unreadable
  // schema.
  it("opens the Inventory tab and loads that base's stored items", async () => {
    mockList(false);
    vi.mocked(basesApi.inventory).mockResolvedValue({
      supported: true,
      baseId: 1006,
      groups: [
        { key: "storage", name: "Storage", containerCount: 1, itemCount: 1000 },
        { key: "refining", name: "Refining", containerCount: 0, itemCount: 0 },
        { key: "crafting", name: "Crafting", containerCount: 0, itemCount: 0 },
        { key: "other", name: "Other", containerCount: 0, itemCount: 0 }
      ],
      containers: [{
        placeableId: "40001", name: "Vault", typeName: "Storage Container", group: "storage",
        usedSlots: 1, maxSlots: 45, itemCount: 1000,
        items: [{ templateId: "Stone", name: "Granite Stone", quantity: 1000 }]
      }],
      items: [{
        templateId: "Stone", name: "Granite Stone", image: "/images/items/image-unavailable.png",
        category: "resources", quantity: 1000, containerCount: 1,
        containers: [{ placeableId: "40001", name: "Vault", typeName: "Storage Container", group: "storage", quantity: 1000 }]
      }],
      totals: { items: 1000, distinct: 1, containers: 1, usedSlots: 1, maxSlots: 45 }
    } as never);

    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Show details for Sietch One" }));

    const tabs = screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label") || tab.textContent);
    expect(tabs).toEqual(["Power", "Water", "Inventory", "Land Claim Editor"]);

    fireEvent.click(screen.getByRole("tab", { name: "Inventory" }));
    // The tab opens on the container cards, not the item rollup.
    expect(await screen.findByText("Vault")).toBeInTheDocument();
    expect(document.querySelectorAll(".bases-inventory-cards .bases-card")).toHaveLength(1);
    await waitFor(() => expect(basesApi.inventory).toHaveBeenCalledWith("1006"));
  });

  // BaseInventoryTab reaches confirmAction/onError/baseName only through this
  // panel. Types prove the props are passed at all; this proves the values are
  // the right ones, which is what a delete confirmation actually shows the
  // operator before destroying something.
  it("wires the inventory tab's delete through to the panel's confirm and base name", async () => {
    mockList(false);
    vi.mocked(basesApi.inventory).mockResolvedValue({
      supported: true,
      baseId: 1006,
      groups: [
        { key: "storage", name: "Storage", containerCount: 1, itemCount: 500 },
        { key: "refining", name: "Refining", containerCount: 0, itemCount: 0 },
        { key: "crafting", name: "Crafting", containerCount: 0, itemCount: 0 },
        { key: "other", name: "Other", containerCount: 0, itemCount: 0 }
      ],
      containers: [{
        placeableId: "40001", name: "Vault", typeName: "Storage Container", group: "storage",
        usedSlots: 1, maxSlots: 45, itemCount: 500,
        items: [{ templateId: "Stone", name: "Granite Stone", quantity: 500 }]
      }],
      items: [{
        templateId: "Stone", name: "Granite Stone", image: "/images/items/image-unavailable.png",
        category: "resources", quantity: 500, containerCount: 1,
        containers: [{ placeableId: "40001", name: "Vault", typeName: "Storage Container", group: "storage", quantity: 500 }]
      }],
      totals: { items: 500, distinct: 1, containers: 1, usedSlots: 1, maxSlots: 45 }
    } as never);
    vi.mocked(basesApi.containerSlots).mockResolvedValue({
      supported: true, found: true, baseId: 1006, placeableId: "40001",
      typeName: "Storage Container", group: "storage", maxSlots: 45, usedSlots: 1,
      deleteSafety: { safe: true, known: true, map: "HaggaBasin", partitionId: 1, reason: "" },
      addSafety: { safe: true, known: true, map: "HaggaBasin", partitionId: 1, reason: "" },
      inventories: [{
        inventoryId: "9001", maxSlots: 45, usedSlots: 1,
        slots: [{ itemId: "501", templateId: "Stone", name: "Granite Stone", positionIndex: 0, quantity: 500, qualityLevel: 0, currentDurability: null, maxDurability: null }]
      }]
    } as never);
    vi.mocked(basesApi.deleteContainerItem).mockResolvedValue({
      supported: true,
      result: {
        ok: true, partial: false, typeName: "Storage Container", group: "storage",
        removed: { itemId: "501", templateId: "Stone", count: 500, remaining: 0 },
        message: "Stone was deleted from the database.",
        deleteSafety: { safe: true, known: true, map: "HaggaBasin", partitionId: 1, reason: "" }
      }
    } as never);

    const props = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Show details for Sietch One" }));
    fireEvent.click(screen.getByRole("tab", { name: "Inventory" }));
    expect(await screen.findByText("Vault")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /View Contents/ }));
    await waitFor(() => expect(basesApi.containerSlots).toHaveBeenCalledWith("1006", "40001"));
    // The overlay opens on grid; the per-row delete button lives in the list.
    await waitFor(() => expect(document.querySelectorAll(".bases-inventory-slot-cell").length).toBeGreaterThan(0));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /List/ }));

    fireEvent.click(await screen.findByRole("button", { name: /^Delete Granite Stone/ }));
    await waitFor(() => expect(props.confirmAction).toHaveBeenCalled());
    // The panel's own confirm, carrying the panel's own base name -- not a
    // placeholder and not the base id.
    const options = vi.mocked(props.confirmAction).mock.calls[0][1] as { details?: { label: string; value: string }[] };
    expect(options.details?.find((detail) => detail.label === "Base")?.value).toBe("Sietch One");
    await waitFor(() => expect(basesApi.deleteContainerItem)
      .toHaveBeenCalledWith("1006", "40001", "501", "DELETE ITEM", undefined));
  });

  // A base with no generators had no expand chevron before this feature. It
  // needs one now, or the Permissions tab would be unreachable for those rows.
  it("gives a generator-less base an expand chevron once permissions are editable", async () => {
    mockList(true);
    mockRoster();
    renderPanel();
    expect(await screen.findByRole("button", { name: "Show details for Sietch One" })).toBeInTheDocument();
  });

  it("reaches the roster by expanding the row and switching tabs", async () => {
    mockList(true);
    mockRoster();
    renderPanel();
    await openPermissionsTab();
    // DarkShark is the Owner, so he is in the hero card and not the roster. The
    // selector scopes past the Owner cell of the collapsed row above, which
    // also says "DarkShark".
    expect(await screen.findByText("DarkShark", { selector: ".bases-permissions-owner-name" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Co-Owner for Yaida" })).toBeChecked();
  });

  it("defaults to the Power tab when the row is expanded normally", async () => {
    mockList(true);
    mockRoster();
    renderPanel();
    fireEvent.click(await screen.findByText("Sietch One"));
    await waitFor(() => expect(screen.getByRole("tab", { name: "Power" })).toHaveAttribute("aria-selected", "true"));
  });

  // Promoting has to demote the incumbent in the same edit, so the one-owner
  // rule can never be violated on screen.
  it("demotes the current owner when another player is promoted", async () => {
    mockList(true);
    mockRoster();
    renderPanel();
    await openPermissionsTab();
    fireEvent.click(await screen.findByRole("radio", { name: "Owner for Yaida" }));
    await waitFor(() => {
      expect(screen.getByText("Yaida", { selector: ".bases-permissions-owner-name" })).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: "Co-Owner for DarkShark" })).toBeChecked();
    });
    // The new Owner leaves the roster entirely -- there is no second place a
    // rank can be edited, so the one-owner rule cannot be violated on screen.
    expect(screen.queryByRole("radio", { name: "Owner for Yaida" })).not.toBeInTheDocument();
  });

  it("blocks removing the owner and enables Save only once the roster is dirty", async () => {
    mockList(true);
    mockRoster();
    renderPanel();
    await openPermissionsTab();
    // The Owner has no remove control at all now -- promoting a replacement is
    // the only way to free him, which is what the old disabled button said.
    expect(await screen.findByText("DarkShark", { selector: ".bases-permissions-owner-name" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove DarkShark" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Yaida" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Remove Yaida" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("reverts local edits without calling the server", async () => {
    mockList(true);
    mockRoster();
    renderPanel();
    await openPermissionsTab();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Yaida" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Co-Owner for Yaida" })).toBeChecked());
    expect(basesApi.setPermissions).not.toHaveBeenCalled();
  });

  it("saves the whole roster as one request", async () => {
    mockList(true);
    mockRoster();
    vi.mocked(basesApi.setPermissions).mockResolvedValue({
      supported: true,
      result: { ok: true, baseId: 1006, actorId: "1004", map: "DeepDesert", added: 0, reranked: 0, removed: 1, total: 1, message: "Permissions were updated." }
    } as never);
    renderPanel();
    await openPermissionsTab();
    fireEvent.click(await screen.findByRole("button", { name: "Remove Yaida" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(basesApi.setPermissions).toHaveBeenCalledWith("1006", [{ playerId: "4", rank: 1 }]));
  });

  it("confirms and transfers to the detected Server custodian without exposing it in player search", async () => {
    mockList(true);
    mockRoster();
    vi.mocked(basesApi.transferToSystemCustodian).mockResolvedValue({
      supported: true,
      result: { ok: true, baseId: 1006, actorId: "1004", map: "DeepDesert", added: 1, reranked: 1, removed: 0, total: 3, message: "Ownership was transferred to the Server system custodian." }
    });
    const props = renderPanel();
    await openPermissionsTab();
    fireEvent.click(await screen.findByRole("button", { name: "Transfer to Server" }));
    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      expect.stringContaining("reserved Server identity"),
      expect.objectContaining({ title: "Transfer to Server Custodian", confirmLabel: "Transfer Ownership" })
    ));
    await waitFor(() => expect(basesApi.transferToSystemCustodian).toHaveBeenCalledWith("1006"));
    expect(basesApi.permissionCandidates).not.toHaveBeenCalled();
    expect(await screen.findByText("Ownership was transferred to the Server system custodian.")).toBeInTheDocument();
    // The custodian control now lives in the Owner hero card rather than a
    // section of its own -- assert the placement, not just its presence.
    expect(document.querySelector(".bases-permissions-owner-card"))
      .toContainElement(screen.getByRole("button", { name: "Transfer to Server" }));
  });

  it("disables the custodian transfer when Server is unavailable", async () => {
    mockList(true);
    vi.mocked(basesApi.permissions).mockResolvedValue({
      supported: true,
      baseId: 1006,
      actorId: "1004",
      map: "DeepDesert",
      mapNameId: 7,
      systemCustodian: { available: false, reason: "No supported system custodian was found." },
      entries: [{ playerId: "4", name: "DarkShark", rank: 1, label: "Owner", canonical: true }]
    });
    renderPanel();
    await openPermissionsTab();
    expect(await screen.findByRole("button", { name: "Transfer to Custodian" })).toBeDisabled();
    expect(screen.getByText(/No supported system custodian/)).toBeInTheDocument();
  });

  it("offers to create Server while transferring when no service has provisioned it", async () => {
    mockList(true);
    vi.mocked(basesApi.permissions).mockResolvedValue({
      supported: true,
      baseId: 1006,
      actorId: "1004",
      map: "DeepDesert",
      mapNameId: 7,
      systemCustodian: {
        available: false,
        canCreate: true,
        playerId: "900000201",
        name: "Server",
        reason: "The reserved Server identity will be created when ownership is transferred."
      },
      entries: [{ playerId: "4", name: "DarkShark", rank: 1, label: "Owner", canonical: true }]
    });
    vi.mocked(basesApi.transferToSystemCustodian).mockResolvedValue({
      supported: true,
      result: { ok: true, baseId: 1006, actorId: "1004", map: "DeepDesert", added: 1, reranked: 1, removed: 0, total: 2, message: "Ownership was transferred to the Server system custodian." }
    });
    const props = renderPanel();
    await openPermissionsTab();
    const transfer = await screen.findByRole("button", { name: "Transfer to Server" });
    expect(transfer).toBeEnabled();
    expect(screen.getByText(/will be created when ownership is transferred/)).toBeInTheDocument();
    fireEvent.click(transfer);
    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      expect.stringContaining("reserved Server identity"),
      expect.objectContaining({ title: "Transfer to Server Custodian" })
    ));
    await waitFor(() => expect(basesApi.transferToSystemCustodian).toHaveBeenCalledWith("1006"));
  });

  it("uses the detected GM identity when Server is not present", async () => {
    mockList(true);
    vi.mocked(basesApi.permissions).mockResolvedValue({
      supported: true,
      baseId: 1006,
      actorId: "1004",
      map: "DeepDesert",
      mapNameId: 7,
      systemCustodian: { available: true, playerId: "900000101", name: "GM" },
      entries: [{ playerId: "4", name: "DarkShark", rank: 1, label: "Owner", canonical: true }]
    });
    vi.mocked(basesApi.transferToSystemCustodian).mockResolvedValue({
      supported: true,
      result: { ok: true, baseId: 1006, actorId: "1004", map: "DeepDesert", added: 1, reranked: 1, removed: 0, total: 2, message: "Ownership was transferred to the GM system custodian." }
    });
    const props = renderPanel();
    await openPermissionsTab();
    fireEvent.click(await screen.findByRole("button", { name: "Transfer to GM" }));
    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      expect.stringContaining("reserved GM identity"),
      expect.objectContaining({ title: "Transfer to GM Custodian" })
    ));
    await waitFor(() => expect(basesApi.transferToSystemCustodian).toHaveBeenCalledWith("1006"));
  });

  // A roster row naming a non-canonical actor is one the game ignores. The
  // console can see it and the game client cannot, so it must be visible here.
  // Both entries below are named "DarkShark" on purpose, and it is load-bearing
  // that one of them is the Owner: the Owner renders in the hero card, so only
  // one node ends up carrying the warning and findByLabelText stays unambiguous.
  it("flags a roster entry the game ignores", async () => {
    mockList(true);
    vi.mocked(basesApi.permissions).mockResolvedValue({
      supported: true,
      baseId: 1006,
      actorId: "1004",
      map: "DeepDesert",
      mapNameId: 7,
      entries: [
        { playerId: "4", name: "DarkShark", rank: 1, label: "Owner", canonical: true },
        { playerId: "5", name: "DarkShark", rank: 3, label: "Associate", canonical: false }
      ]
    } as never);
    renderPanel();
    await openPermissionsTab();
    expect(await screen.findByLabelText("Ignored by the game")).toBeInTheDocument();
  });
});

describe("BasesPanel water refill", () => {
  const waterCapableBase = {
    ...commonRow,
    generatorDataAvailable: true,
    generatorCount: 0,
    generators: []
  };

  function waterCapableList(row: Record<string, unknown>) {
    return {
      capabilities: { bases: true, waterRefill: true, waterRefillQueue: true },
      totalCount: 1,
      totalBases: 1,
      totalPieces: 10,
      totalPlaceables: 4,
      rows: [{ ...waterCapableBase, ...row }]
    };
  }

  beforeEach(() => {
    vi.mocked(basesApi.pendingRefills).mockResolvedValue({ supported: true, total: 0, pending: [], byTarget: [] });
    vi.mocked(basesApi.pendingWaterRefills).mockResolvedValue({ supported: true, total: 0, pending: [], byTarget: [] });
    vi.mocked(basesApi.autoRefillWater).mockResolvedValue({
      supported: true, thresholdPercent: 50, intervalHours: 24, nextRunAt: "", lastRunAt: "", lastRunStatus: "", lastRunDetail: "", total: 0, bases: []
    });
  });

  it("checks water immediately when auto-refill is enabled and reports the queued refill", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(waterCapableList({ base_id: "4001", name: "Sietch Auto Water" }));
    vi.mocked(basesApi.autoRefillWater)
      .mockResolvedValueOnce({
        supported: true, thresholdPercent: 50, intervalHours: 24, nextRunAt: "", lastRunAt: "", lastRunStatus: "", lastRunDetail: "", total: 0, bases: []
      })
      .mockResolvedValue({
        supported: true,
        thresholdPercent: 50,
        intervalHours: 24,
        nextRunAt: "2026-08-15T12:00:00.000Z",
        lastRunAt: "2026-08-14T12:00:00.000Z",
        lastRunStatus: "ok",
        lastRunDetail: "Checked 1, queued 1",
        total: 1,
        bases: [{
          baseId: 4001,
          enabledAt: "2026-08-14T12:00:00.000Z",
          lastCheckedAt: "2026-08-14T12:00:00.000Z",
          lastQueuedAt: "2026-08-14T12:00:00.000Z",
          lastLowestPercent: 2.3,
          consecutiveQueues: 1,
          stalledAt: ""
        }]
      });
    vi.mocked(basesApi.water).mockResolvedValue({
      supported: true,
      baseId: 4001,
      containers: [{ type: "waterCistern", name: "Water Cistern", count: 1, stored: 23000, capacity: 1000000, percent: 2.3 }]
    });
    vi.mocked(basesApi.setAutoRefillWater).mockResolvedValue({
      ok: true,
      baseId: 4001,
      enabled: true,
      newlyEnabled: true,
      total: 1,
      initialCheck: { status: "ok", detail: "Checked 1, queued 1", checked: 1, queued: 1, failures: 0 }
    });

    const props = renderPanel();
    await screen.findByText("Sietch Auto Water");
    fireEvent.click(await screen.findByRole("button", { name: "Show details for Sietch Auto Water" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Water" }));
    await screen.findByText("23,000 / 1,000,000");

    fireEvent.click(screen.getByText("Auto-Refill"));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      'Turn on water auto-refill for "Sietch Auto Water"?',
      expect.objectContaining({ warning: expect.stringContaining("checked now, then every 24h") })
    ));
    await waitFor(() => expect(basesApi.setAutoRefillWater).toHaveBeenCalledWith("4001", true));
    expect(await screen.findByText(/A refill is queued for the next map stop or restart/)).toBeInTheDocument();
    expect(await screen.findByText("ON")).toBeInTheDocument();
  });

  // Water isn't part of the row/list data the way generator fuel is --
  // BaseWaterTab fetches its own container levels -- so an immediate
  // (non-queued) refill needs its own signal to make an already-open Water
  // tab refetch, rather than relying on the bases list reloading.
  it("refetches the open Water tab's container levels after an immediate refill", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(waterCapableList({ base_id: "4002", name: "Sietch Immediate" }));
    vi.mocked(basesApi.water)
      .mockResolvedValueOnce({
        supported: true,
        baseId: 1006,
        containers: [{ type: "waterCistern", name: "Water Cistern", count: 1, stored: 1250, capacity: 5000, percent: 25 }]
      })
      .mockResolvedValueOnce({
        supported: true,
        baseId: 1006,
        containers: [{ type: "waterCistern", name: "Water Cistern", count: 1, stored: 5000, capacity: 5000, percent: 100 }]
      });
    vi.mocked(basesApi.refillWater).mockResolvedValue({
      supported: true,
      result: {
        ok: true,
        baseId: 1006,
        totalAdded: 3750,
        devices: [{ placeableId: "9101", type: "waterCistern", label: "Water Cistern", before: 1250, after: 5000, added: 3750 }]
      }
    });

    renderPanel();
    await screen.findByText("Sietch Immediate");
    fireEvent.click(await screen.findByRole("button", { name: "Show details for Sietch Immediate" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Water" }));

    expect(await screen.findByText("1,250 / 5,000")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refill Water" }));
    await waitFor(() => expect(basesApi.refillWater).toHaveBeenCalledWith("4002"));

    expect(await screen.findByText("5,000 / 5,000")).toBeInTheDocument();
    expect(vi.mocked(basesApi.water).mock.calls.length).toBe(2);
  });

  it("does not refetch the Water tab when the refill is queued instead of applied immediately", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(waterCapableList({ base_id: "4003", name: "Sietch Queued Water" }));
    vi.mocked(basesApi.water).mockResolvedValue({
      supported: true,
      baseId: 4003,
      containers: [{ type: "waterCistern", name: "Water Cistern", count: 1, stored: 1250, capacity: 5000, percent: 25 }]
    });
    vi.mocked(basesApi.refillWater).mockResolvedValue({
      supported: true,
      result: { ok: true, baseId: 4003, queued: true, map: "DeepDesert_1", partitionId: 8 }
    });

    renderPanel();
    await screen.findByText("Sietch Queued Water");
    fireEvent.click(await screen.findByRole("button", { name: "Show details for Sietch Queued Water" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Water" }));

    await screen.findByText("1,250 / 5,000");
    fireEvent.click(screen.getByRole("button", { name: "Refill Water" }));
    await waitFor(() => expect(basesApi.refillWater).toHaveBeenCalledWith("4003"));

    // Queued refills are applied later by a map restart, not written yet -- so
    // there is nothing fresh to refetch, and the queue banner is what should
    // update instead (covered by basesApi.pendingWaterRefills below).
    await waitFor(() => expect(basesApi.pendingWaterRefills).toHaveBeenCalled());
    expect(vi.mocked(basesApi.water).mock.calls.length).toBe(1);
  });

  // A schema that cannot back the tab is a settled answer, not a transient
  // failure: it arrives as a 200 carrying supported:false, so it must not be
  // rendered in the error style with a Retry that could only fail identically.
  it("states the reason with no Retry when the schema cannot back the Water tab", async () => {
    vi.mocked(basesApi.list).mockResolvedValue(waterCapableList({ base_id: "4004", name: "Sietch Unsupported" }));
    vi.mocked(basesApi.water).mockResolvedValue({
      supported: false,
      reason: "Unsupported by detected schema. Missing required table(s): dune.placeables",
      baseId: 4004,
      containers: []
    });

    renderPanel();
    await screen.findByText("Sietch Unsupported");
    fireEvent.click(await screen.findByRole("button", { name: "Show details for Sietch Unsupported" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Water" }));

    const notice = await screen.findByText(/Missing required table\(s\): dune\.placeables/);
    expect(notice).toHaveAttribute("role", "status");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    // Not the empty-base wording either -- "no water storage" would read as a
    // fact about this base rather than about the database.
    expect(screen.queryByText("No water storage at this base.")).not.toBeInTheDocument();
    // Auto-refill acts on the very devices this schema cannot describe.
    expect(screen.queryByRole("checkbox", { name: /Auto-Refill/ })).not.toBeInTheDocument();
  });
});

describe("BasesPanel combined fuel/water queue and stalled banners", () => {
  beforeEach(() => {
    vi.mocked(basesApi.pendingRefills).mockResolvedValue({ supported: true, total: 0, pending: [], byTarget: [] });
    vi.mocked(basesApi.autoRefill).mockResolvedValue({
      supported: true, thresholdPercent: 50, intervalHours: 24, nextRunAt: "", lastRunAt: "", lastRunStatus: "", lastRunDetail: "", total: 0, bases: []
    });
  });

  it("shows only the water badge, not a fuel badge, when only water refills are queued", async () => {
    vi.mocked(basesApi.list).mockResolvedValue({
      capabilities: { bases: true, waterRefill: true, waterRefillQueue: true },
      totalCount: 1,
      totalBases: 1,
      totalPieces: 10,
      totalPlaceables: 4,
      rows: [{ ...commonRow, base_id: "4101", name: "Sietch Water Only", generatorDataAvailable: true, generatorCount: 0, generators: [] }]
    });
    vi.mocked(basesApi.pendingWaterRefills).mockResolvedValue({
      supported: true,
      total: 1,
      pending: [{ baseId: 4101, map: "DeepDesert", partitionId: 8, queuedAt: new Date().toISOString(), attempts: 0, lastError: "" }],
      byTarget: [{ map: "DeepDesert", partitionId: 8, partitionMap: "DeepDesert_1", dimensionIndex: 0, count: 1 }]
    });
    vi.mocked(basesApi.autoRefillWater).mockResolvedValue({
      supported: true, thresholdPercent: 50, intervalHours: 24, nextRunAt: "", lastRunAt: "", lastRunStatus: "", lastRunDetail: "", total: 0, bases: []
    });

    renderPanel();

    expect(await screen.findByText("Refills queued")).toBeInTheDocument();
    expect(screen.getByText("1 water")).toBeInTheDocument();
    // The banner's title badges and each row's badges are gated on
    // fuelCount/waterCount independently -- with zero fuel queued, no "fuel"
    // badge should render alongside the water one.
    expect(screen.queryByText(/\d+ fuel\b/)).not.toBeInTheDocument();
  });

  it("scopes the stalled-banner explanation to only the resource that actually stalled", async () => {
    vi.mocked(basesApi.list).mockResolvedValue({
      capabilities: { bases: true, waterRefill: true, waterRefillQueue: true },
      totalCount: 1,
      totalBases: 1,
      totalPieces: 10,
      totalPlaceables: 4,
      rows: [{ ...commonRow, base_id: "4102", name: "Sietch Stalled Water", generatorDataAvailable: true, generatorCount: 0, generators: [] }]
    });
    vi.mocked(basesApi.pendingWaterRefills).mockResolvedValue({ supported: true, total: 0, pending: [], byTarget: [] });
    vi.mocked(basesApi.autoRefillWater).mockResolvedValue({
      supported: true, thresholdPercent: 50, intervalHours: 24, nextRunAt: "", lastRunAt: "", lastRunStatus: "", lastRunDetail: "",
      total: 1,
      bases: [{
        baseId: 4102,
        enabledAt: "2026-07-29T12:00:00.000Z",
        lastCheckedAt: "",
        lastQueuedAt: "",
        lastLowestPercent: 8,
        consecutiveQueues: 3,
        stalledAt: new Date().toISOString()
      }]
    });

    renderPanel();

    expect(await screen.findByText("1 base has stalled auto-refill")).toBeInTheDocument();
    expect(screen.getByText(/without raising the water on this base/)).toBeInTheDocument();
    expect(screen.queryByText(/fuel or water/)).not.toBeInTheDocument();
  });

  it("merges both resources into one queued-refills banner with per-type badges", async () => {
    vi.mocked(basesApi.list).mockResolvedValue({
      capabilities: { bases: true, generatorRefill: true, generatorRefillQueue: true, waterRefill: true, waterRefillQueue: true },
      totalCount: 1,
      totalBases: 1,
      totalPieces: 10,
      totalPlaceables: 4,
      rows: [{ ...commonRow, base_id: "4103", name: "Sietch Both Queued", generatorDataAvailable: true, generatorCount: 1, generators: [] }]
    });
    vi.mocked(basesApi.pendingRefills).mockResolvedValue({
      supported: true,
      total: 1,
      pending: [{ baseId: 4103, map: "DeepDesert", partitionId: 8, queuedAt: new Date().toISOString(), attempts: 0, lastError: "" }],
      byTarget: [{ map: "DeepDesert", partitionId: 8, partitionMap: "DeepDesert_1", dimensionIndex: 0, count: 1 }]
    });
    vi.mocked(basesApi.pendingWaterRefills).mockResolvedValue({
      supported: true,
      total: 1,
      pending: [{ baseId: 4103, map: "DeepDesert", partitionId: 8, queuedAt: new Date().toISOString(), attempts: 0, lastError: "" }],
      byTarget: [{ map: "DeepDesert", partitionId: 8, partitionMap: "DeepDesert_1", dimensionIndex: 0, count: 1 }]
    });
    vi.mocked(basesApi.autoRefillWater).mockResolvedValue({
      supported: true, thresholdPercent: 50, intervalHours: 24, nextRunAt: "", lastRunAt: "", lastRunStatus: "", lastRunDetail: "", total: 0, bases: []
    });

    renderPanel();

    // One target, one queued fuel refill and one queued water refill: a single
    // combined banner, not two separate ones, and the title splits the total
    // per resource rather than reporting a bare "2".
    expect(await screen.findByText("Refills queued")).toBeInTheDocument();
    expect(screen.getByText("1 fuel")).toBeInTheDocument();
    expect(screen.getByText("1 water")).toBeInTheDocument();
    expect(document.querySelectorAll(".bases-pending-refills")).toHaveLength(1);
  });
});

describe("BasesPanel map column", () => {
  // Verbatim `dune sietches dimensions DeepDesert_1` output from the live
  // server, paired with its `--ids` output: two instances of one map, which is
  // exactly the case the map name alone cannot distinguish.
  const DEEP_DESERT_TABLE = [
    "DIMENSION  DISPLAY NAME                     PASSWORD",
    "0          Deep Desert PvP                  (unset)",
    "1          Deep Desert PvE                  (unset)"
  ].join("\n");
  const DEEP_DESERT_IDS = "8\n59\n";

  function mockTwoDeepDesertBases() {
    vi.mocked(basesApi.list).mockResolvedValue({
      capabilities: { bases: true },
      totalCount: 2,
      totalBases: 2,
      totalPieces: 20,
      totalPlaceables: 8,
      rows: [
        { ...commonRow, base_id: "5001", name: "PvP Outpost", map: "DeepDesert", partition_id: 8, partitionMap: "DeepDesert_1", dimensionIndex: 0, generatorDataAvailable: false, generatorCount: 0 },
        { ...commonRow, base_id: "5002", name: "PvE Outpost", map: "DeepDesert", partition_id: 59, partitionMap: "DeepDesert_1", dimensionIndex: 1, generatorDataAvailable: false, generatorCount: 0 }
      ]
    } as never);
  }

  function mapCells() {
    return [...document.querySelectorAll(".bases-map-cell")].map((cell) => ({
      map: cell.querySelector(".bases-map-name")?.textContent,
      instance: cell.querySelector(".bases-map-instance")?.textContent
    }));
  }

  it("renders the friendly map name and upgrades the partition to its instance name", async () => {
    mockTwoDeepDesertBases();
    vi.mocked(mapsApi.sietchDimensions).mockImplementation((_map?: string, ids?: boolean) =>
      Promise.resolve({ stdout: ids ? DEEP_DESERT_IDS : DEEP_DESERT_TABLE }) as never);

    renderPanel();
    expect(await screen.findByText("PvP Outpost")).toBeInTheDocument();

    // "DeepDesert" is the game's internal name; the column shows the real one,
    // keeping the raw value in the title for anyone matching against the DB.
    await waitFor(() => expect(mapCells()).toEqual([
      { map: "Deep Desert", instance: "Deep Desert PvP" },
      { map: "Deep Desert", instance: "Deep Desert PvE" }
    ]));
    expect(document.querySelector(".bases-map-name")).toHaveAttribute("title", "DeepDesert");
    // One pair of requests for the single distinct partition map, not per row.
    expect(vi.mocked(mapsApi.sietchDimensions).mock.calls.map((call) => call[0])).toEqual(["DeepDesert_1", "DeepDesert_1"]);
  });

  it("falls back to the partition number when the instance names cannot be read", async () => {
    // These endpoints shell out to the runtime CLI and are absent on a
    // console-only install. The rows must still identify their instance.
    mockTwoDeepDesertBases();
    vi.mocked(mapsApi.sietchDimensions).mockRejectedValue(new Error("spawn runtime/scripts/dune ENOENT"));

    renderPanel();
    expect(await screen.findByText("PvP Outpost")).toBeInTheDocument();

    expect(mapCells()).toEqual([
      { map: "Deep Desert", instance: "Partition 8" },
      { map: "Deep Desert", instance: "Partition 59" }
    ]);
  });

  // Two bases on two different maps, which is what makes the id keyspace
  // matter: a partition number is only unique once its map is fixed.
  function mockOneBasePerMap() {
    vi.mocked(basesApi.list).mockResolvedValue({
      capabilities: { bases: true },
      totalCount: 2,
      totalBases: 2,
      totalPieces: 20,
      totalPlaceables: 8,
      rows: [
        { ...commonRow, base_id: "5001", name: "Basin Hold", map: "HaggaBasin", partition_id: 1, partitionMap: "Survival_1", dimensionIndex: 0, generatorDataAvailable: false, generatorCount: 0 },
        { ...commonRow, base_id: "5002", name: "PvP Outpost", map: "DeepDesert", partition_id: 8, partitionMap: "DeepDesert_1", dimensionIndex: 0, generatorDataAvailable: false, generatorCount: 0 }
      ]
    } as never);
  }

  // Both assertions below are negative -- an instance name must NOT appear --
  // so they need a sync point that does not depend on one arriving. A
  // module-level cache means the panel mounts with the previous test's rows and
  // fires this effect twice, so the call count is not usable either; wait for
  // the call the current rows triggered, then drain the resolve pass.
  async function settleInstanceNames(map: string) {
    await waitFor(() => expect(vi.mocked(mapsApi.sietchDimensions)).toHaveBeenCalledWith(map, true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  // The dimension table lists rows 0 and 1 while --ids comes back empty, so
  // parseSietchRows keys those rows by dimension index. Pooled into one map
  // across every partition map, DeepDesert_1's dimension 1 then answers the
  // lookup for Survival_1's partition 1 and labels the Hagga Basin base
  // "Deep Desert PvE".
  it("does not label a base with another map's instance when partition ids are missing", async () => {
    mockOneBasePerMap();
    vi.mocked(mapsApi.sietchDimensions).mockImplementation((map?: string, ids?: boolean) =>
      Promise.resolve({ stdout: map === "DeepDesert_1" && !ids ? DEEP_DESERT_TABLE : "" }) as never);

    renderPanel();
    expect(await screen.findByText("Basin Hold")).toBeInTheDocument();
    await settleInstanceNames("Survival_1");

    expect(mapCells()).toEqual([
      // Never "Deep Desert PvE": that name is keyed by a dimension index, and
      // this base is on a different map entirely.
      { map: "Hagga Basin", instance: "Partition 1" },
      { map: "Deep Desert", instance: "Partition 8" }
    ]);
  });

  // commandJson answers 200 with an empty stdout when the CLI exits non-zero,
  // so the failure is only visible in exitCode.
  it("keeps the partition fallback when the CLI reports a non-zero exit", async () => {
    mockTwoDeepDesertBases();
    // Plausible stdout, but the command failed -- trusting it would publish
    // instance names read from a stale or partial table.
    vi.mocked(mapsApi.sietchDimensions).mockImplementation((_map?: string, ids?: boolean) =>
      Promise.resolve({ stdout: ids ? DEEP_DESERT_IDS : DEEP_DESERT_TABLE, exitCode: 1 }) as never);

    renderPanel();
    expect(await screen.findByText("PvP Outpost")).toBeInTheDocument();
    await settleInstanceNames("DeepDesert_1");

    expect(mapCells()).toEqual([
      { map: "Deep Desert", instance: "Partition 8" },
      { map: "Deep Desert", instance: "Partition 59" }
    ]);
  });
});
