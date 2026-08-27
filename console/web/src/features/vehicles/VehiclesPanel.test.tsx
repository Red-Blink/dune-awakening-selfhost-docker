import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapsApi } from "../../api/maps";
import { vehiclesApi, type VehiclesListResponse } from "../../api/vehicles";
import { invalidateInstanceNames } from "../maps/instanceNames";
import { VehiclesPanel } from "./VehiclesPanel";

vi.mock("../../api/maps", () => ({ mapsApi: { sietchDimensions: vi.fn() } }));

vi.mock("../../api/vehicles", () => ({
  vehiclesApi: {
    list: vi.fn(),
    permissions: vi.fn(),
    setPermissions: vi.fn(),
    permissionCandidates: vi.fn(),
    transferToSystemCustodian: vi.fn(),
    deleteVehicle: vi.fn(),
    cancelQueuedDelete: vi.fn(),
    pendingDeletes: vi.fn(),
    storage: vi.fn()
  }
}));

function renderPanel(overrides: Partial<Parameters<typeof VehiclesPanel>[0]> = {}) {
  const props = {
    onError: vi.fn(),
    confirmAction: vi.fn().mockResolvedValue(true),
    formatMutationResult: vi.fn().mockReturnValue("Action completed."),
    ...overrides
  };
  render(<VehiclesPanel {...props} />);
  return props;
}

function listResponse(overrides: Partial<VehiclesListResponse> = {}): VehiclesListResponse {
  return {
    capabilities: { vehicles: true },
    totalCount: 1,
    totalVehicles: 1,
    rows: [
      {
        id: "5001",
        name: "Sihaya",
        type: "Sandbike",
        owner: "Duncan_Idaho",
        shared_with: [{ name: "Gurney_H", rank: 2, label: "Co-Owner" }, { name: "Leto_A", rank: 3, label: "Associate" }],
        condition_percent: 92,
        current_fuel: 61,
        max_fuel: 100,
        fuel_percent: 61,
        map: "HaggaBasin",
        partition_id: 1,
        x: 100,
        y: 200,
        z: 30,
        modules: [
          { templateId: "GeneratorModule", name: "Generator", condition: 440, maxCondition: 500, conditionPercent: 88 }
        ]
      }
    ],
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateInstanceNames();
  vi.mocked(mapsApi.sietchDimensions).mockResolvedValue({ stdout: "", exitCode: 1 } as never);
});

describe("VehiclesPanel", () => {
  it("renders a vehicle row with type, owner, and shared-with", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse());
    renderPanel();

    expect(await screen.findByText("Sihaya")).toBeInTheDocument();
    expect(screen.getByText("Sandbike")).toBeInTheDocument();
    expect(screen.getByText("Duncan_Idaho")).toBeInTheDocument();
    // Shared-with renders "Name (RankLabel)" like the Bases page.
    expect(screen.getByText(/Gurney_H/)).toBeInTheDocument();
    expect(screen.getByText(/Co-Owner/)).toBeInTheDocument();
    // The location subtext carries the disambiguating map + partition.
    expect(screen.getByText("Hagga Basin · Partition 1")).toBeInTheDocument();
    // Hagga Basin has no sector grid — coords only, no second row.
    expect(screen.queryByText(/^Sector/)).toBeNull();
  });

  it("shows the configured map instance name when it can be resolved", async () => {
    vi.mocked(mapsApi.sietchDimensions).mockImplementation((_map?: string, wantIds?: boolean) => Promise.resolve({
      stdout: wantIds
        ? "1\n"
        : ["DIMENSION  DISPLAY NAME                     PASSWORD", "0          Sietch Abbir                     (unset)"].join("\n"),
      exitCode: 0
    }) as never);
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse());
    renderPanel();

    const location = await screen.findByText("Hagga Basin · Sietch Abbir");
    expect(location).toHaveAttribute("title", "HaggaBasin · Partition 1");
  });

  it("shows the server-provided sub-region on the Location column", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({
      rows: [{ ...listResponse().rows[0], map: "HaggaBasin", region: "Hagga Rift" }]
    }));
    renderPanel();

    expect(await screen.findByText("Hagga Rift")).toBeInTheDocument();
  });

  it("shows the Deep Desert sector grid as a second location row", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({
      rows: [{ ...listResponse().rows[0], map: "DeepDesert", partition_id: 8, x: 0, y: 0 }]
    }));
    renderPanel();

    // (0, 0) on the 9x9 grid (letter = Y descending, number = X ascending) is E-5.
    expect(await screen.findByText("Sector E-5")).toBeInTheDocument();
  });

  // A vehicle's cargo hold hangs off the vehicle actor, not a module, so this
  // is one control on the Components header gated on a fitted storage module
  // -- not a button per component card.
  describe("View Contents", () => {
    const STORAGE_MODULE = { templateId: "SandbikeInventory_2", name: "Sandbike Inventory Mk2", condition: null, maxCondition: null, conditionPercent: null, isStorage: true };

    async function expandWith(overrides: Partial<VehiclesListResponse>) {
      vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse(overrides));
      renderPanel();
      fireEvent.click(await screen.findByLabelText("Show components for Sihaya"));
      await screen.findByText(/component/);
    }

    function withStorageModule(response: VehiclesListResponse): Partial<VehiclesListResponse> {
      return { rows: [{ ...response.rows[0], modules: [...response.rows[0].modules, STORAGE_MODULE] }] };
    }

    it("offers the button when a storage module is fitted and the server can read holds", async () => {
      await expandWith({ capabilities: { vehicles: true, vehicleStorage: true }, ...withStorageModule(listResponse()) });
      expect(screen.getByRole("button", { name: /View Contents/ })).toBeInTheDocument();
    });

    it("hides the button when no storage module is fitted", async () => {
      await expandWith({ capabilities: { vehicles: true, vehicleStorage: true } });
      expect(screen.queryByRole("button", { name: /View Contents/ })).toBeNull();
    });

    it("hides the button when the schema cannot serve holds", async () => {
      await expandWith({ capabilities: { vehicles: true, vehicleStorage: false }, ...withStorageModule(listResponse()) });
      expect(screen.queryByRole("button", { name: /View Contents/ })).toBeNull();
    });

    it("opens the contents overlay without collapsing the expanded row", async () => {
      vi.mocked(vehiclesApi.storage).mockResolvedValue({
        supported: true, found: true, vehicleId: "5001", inventoryId: "9001",
        maxSlots: 15, usedSlots: 0, maxVolume: 250, currentVolume: 0, volumeComplete: true, slots: []
      } as never);
      await expandWith({ capabilities: { vehicles: true, vehicleStorage: true }, ...withStorageModule(listResponse()) });
      fireEvent.click(screen.getByRole("button", { name: /View Contents/ }));
      await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
      expect(vehiclesApi.storage).toHaveBeenCalledWith("5001");
      // The button lives inside a clickable table row; without the click guard
      // the row would toggle shut underneath the modal.
      expect(screen.getByText(/component/)).toBeInTheDocument();
    });
  });

  it("expands a row to show its components", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse());
    renderPanel();

    const expandButton = await screen.findByLabelText("Show components for Sihaya");
    fireEvent.click(expandButton);

    expect(await screen.findByText("1 component")).toBeInTheDocument();
    expect(screen.getByText("Generator")).toBeInTheDocument();
    expect(screen.getByText(/440 \/ 500 · 88%/)).toBeInTheDocument();
  });

  it("shows 'Durability not reported' for a component with no durability data", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({
      rows: [{
        ...listResponse().rows[0],
        modules: [{ templateId: "SandbikeInventory_1", name: "Sandbike Storage", condition: null, maxCondition: null, conditionPercent: null }]
      }]
    }));
    renderPanel();

    fireEvent.click(await screen.findByLabelText("Show components for Sihaya"));
    expect(await screen.findByText("Durability not reported")).toBeInTheDocument();
  });

  it("shows raw current fuel when capacity is unknown", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({
      rows: [{
        ...listResponse().rows[0],
        fuel_percent: null,
        max_fuel: null
      }]
    }));
    renderPanel();

    // Wait for this request's distinctive value instead of the cached row
    // that may be rendered while the panel refreshes in the background.
    expect(await screen.findByText("61 current")).toBeInTheDocument();
    expect(screen.getByText("92%")).toBeInTheDocument();
  });

  it("labels inferred condition and fuel percentages as Estimated without a tilde", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({
      rows: [{
        ...listResponse().rows[0],
        condition_estimated: true,
        modules: [{ ...listResponse().rows[0].modules[0], maxInferred: true }]
      }]
    }));
    renderPanel();

    // The panel can render a cached authoritative row first. Wait for the
    // refreshed response that carries the estimation markers.
    await waitFor(() => expect(screen.getByText(/92%/)).toHaveTextContent("Estimated"));
    await waitFor(() => expect(screen.getByText(/61%/)).toHaveTextContent("Estimated"));
    fireEvent.click(screen.getByLabelText("Show components for Sihaya"));
    expect(screen.getByText(/440 \/ 500 · 88% Estimated/)).toBeInTheDocument();
  });

  it("submits the search term and clears it", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse());
    renderPanel();

    await screen.findByText("Sihaya");
    const input = screen.getByPlaceholderText("Search name, type, owner, or map") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "worm" } });
    fireEvent.click(screen.getByText("Search"));

    await waitFor(() => {
      expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledWith(expect.objectContaining({ q: "worm" }));
    });

    fireEvent.click(screen.getByText("Clear"));
    expect(input.value).toBe("");
  });

  it("advances to the next page", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({ totalCount: 120, totalVehicles: 120 }));
    renderPanel();

    await screen.findByText("Sihaya");
    await waitFor(() => expect(screen.getByText("Next")).not.toBeDisabled());
    fireEvent.click(screen.getByText("Next"));

    await waitFor(() => {
      expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledWith(expect.objectContaining({ page: 1 }));
    });
  });

  it("shows the unsupported reason when the schema lacks vehicle tables", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue({
      capabilities: { vehicles: false },
      totalCount: 0,
      totalVehicles: 0,
      rows: [],
      reason: "Unsupported by detected schema. Missing required table(s): dune.vehicle_modules"
    });
    renderPanel();

    expect(await screen.findByText(/Missing required table/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Search name, type, owner, or map")).not.toBeInTheDocument();
  });

  it("renders rounded world coordinates on the Location column", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({
      rows: [{ ...listResponse().rows[0], x: 100.4, y: -217653.8, map: "HaggaBasin", region: null }]
    }));
    renderPanel();

    // Rounded to plain integers, no thousands separators.
    expect(await screen.findByText("(100, -217654)")).toBeInTheDocument();
  });

  it("colors each meter by its condition threshold", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({
      rows: [{
        ...listResponse().rows[0],
        condition_percent: 80, // green (>=66)
        fuel_percent: 50, // amber (>=33)
        modules: [{ templateId: "Engine", name: "Engine", condition: 5, maxCondition: 100, conditionPercent: 10 }] // red (<33)
      }]
    }));
    const { container } = render(
      <VehiclesPanel onError={vi.fn()} confirmAction={vi.fn().mockResolvedValue(true)} formatMutationResult={vi.fn().mockReturnValue("")} />
    );

    await screen.findByText("Sihaya");
    fireEvent.click(screen.getByLabelText("Show components for Sihaya"));
    await screen.findByText("Engine");

    const backgrounds = Array.from(container.querySelectorAll<HTMLElement>(".vehicles-meter i"))
      .map((fill) => fill.getAttribute("style") || "");
    expect(backgrounds.some((style) => style.includes("--success"))).toBe(true);
    expect(backgrounds.some((style) => style.includes("--warning"))).toBe(true);
    expect(backgrounds.some((style) => style.includes("--danger"))).toBe(true);
  });

  it("splits a locomotion component's mount position onto its own line", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({
      rows: [{
        ...listResponse().rows[0],
        modules: [
          { templateId: "Loco", name: "Heavy Locomotion (Front Left)", condition: 90, maxCondition: 100, conditionPercent: 90 },
          { templateId: "Gen", name: "Generator", condition: 90, maxCondition: 100, conditionPercent: 90 }
        ]
      }]
    }));
    renderPanel();

    fireEvent.click(await screen.findByLabelText("Show components for Sihaya"));

    // The mount position is broken out into its own element, leaving the tier name.
    const position = await screen.findByText("Front Left");
    expect(position).toHaveClass("vehicles-component-position");
    expect(screen.getByText("Heavy Locomotion")).toBeInTheDocument();
    // A name without a position marker stays whole -- no stray position element.
    expect(screen.getByText("Generator")).toBeInTheDocument();
  });

  it("sorts by a column when its header is clicked", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse());
    renderPanel();

    await screen.findByText("Sihaya");
    fireEvent.click(screen.getByRole("columnheader", { name: /Type/ }));

    await waitFor(() => {
      expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledWith(expect.objectContaining({ sortColumn: "type", sortDirection: "asc" }));
    });
  });

  it("reloads with the chosen page size", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({ totalCount: 300, totalVehicles: 300 }));
    renderPanel();

    await screen.findByText("Sihaya");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "100" } });

    await waitFor(() => {
      expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledWith(expect.objectContaining({ pageSize: 100 }));
    });
  });

  it("hides the Permissions tab when the schema lacks the capability", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({ capabilities: { vehicles: true } }));
    renderPanel();

    fireEvent.click(await screen.findByLabelText("Show components for Sihaya"));
    await screen.findByText("1 component");
    expect(screen.queryByRole("tab", { name: "Permissions" })).not.toBeInTheDocument();
  });

  it("shows the Permissions tab and refetches the list after a save", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(listResponse({ capabilities: { vehicles: true, vehiclePermissions: true } }));
    vi.mocked(vehiclesApi.permissions).mockResolvedValue({
      supported: true,
      vehicleId: 5001,
      actorId: "5001",
      map: "HaggaBasin",
      mapNameId: 1,
      entries: [{ playerId: "4", name: "Duncan_Idaho", rank: 1, label: "", canonical: true }]
    } as never);
    renderPanel();

    fireEvent.click(await screen.findByLabelText("Show components for Sihaya"));
    fireEvent.click(await screen.findByRole("tab", { name: "Permissions" }));

    await screen.findByText("Duncan_Idaho", { selector: ".vehicles-permissions-owner-name" });
    expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledTimes(1);

    vi.mocked(vehiclesApi.setPermissions).mockResolvedValue({
      supported: true,
      result: { ok: true, vehicleId: 5001, actorId: "5001", map: "HaggaBasin", added: 1, reranked: 0, removed: 0, total: 2, message: "Permissions were updated." }
    } as never);
    const search = screen.getByPlaceholderText("Search a player to add");
    fireEvent.change(search, { target: { value: "Leto" } });
    vi.mocked(vehiclesApi.permissionCandidates).mockResolvedValue({ rows: [{ playerId: "9", name: "Leto_A" }] } as never);
    // Scoped to the permissions add row: the page's own vehicle search bar
    // has its own "Search"/"Clear" buttons with the same accessible names.
    const addRow = within(document.querySelector(".vehicles-permissions-add") as HTMLElement);
    fireEvent.click(addRow.getByRole("button", { name: "Search" }));
    fireEvent.click(await addRow.findByRole("button", { name: "Add Leto_A" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));

    // A saved roster invalidates the list cache -- owner/shared_with are
    // rendered from the list response, not the permissions tab's own state.
    await waitFor(() => expect(vi.mocked(vehiclesApi.list)).toHaveBeenCalledTimes(2));
  });
});

describe("VehiclesPanel vehicle deletion", () => {
  function deleteListResponse(capabilities: Record<string, unknown>, row: Record<string, unknown>) {
    return {
      capabilities,
      totalCount: 1,
      totalVehicles: 1,
      rows: [{ ...listResponse().rows[0], ...row }]
    };
  }

  const deletableVehicle = { id: "5101", name: "Sandcrawler Delete" };

  beforeEach(() => {
    vi.mocked(vehiclesApi.pendingDeletes).mockResolvedValue({ supported: true, total: 0, pending: [], byTarget: [] });
  });

  async function awaitFreshRows(vehicleName: string) {
    await screen.findByText(vehicleName);
    return screen.getByRole("button", { name: `Delete ${vehicleName}` });
  }

  it("hides the Delete Vehicle action when the schema does not support it", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(deleteListResponse({ vehicles: true }, { id: "5100", name: "Sandcrawler NoDelete" }));

    renderPanel();
    await screen.findByText("Sandcrawler NoDelete");

    expect(screen.queryByRole("button", { name: /^Delete /i })).not.toBeInTheDocument();
  });

  it("confirms with the owner and deletes immediately when the map is already write-safe", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(deleteListResponse({ vehicles: true, vehicleDelete: true, vehicleDeleteQueue: false }, deletableVehicle));
    vi.mocked(vehiclesApi.deleteVehicle).mockResolvedValue({
      supported: true,
      backupCreated: true,
      result: { ok: true, vehicleId: 5101, actorId: "5101", deletedModuleCount: 2 }
    });

    const props = renderPanel();
    const deleteButton = await awaitFreshRows("Sandcrawler Delete");
    expect(deleteButton).toBeEnabled();

    fireEvent.click(deleteButton);

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      'Delete "Sandcrawler Delete"? This permanently deletes the vehicle and everything stored in it.',
      {
        title: "Delete Vehicle",
        confirmLabel: "Delete",
        danger: true,
        details: [{ label: "Owner", value: "Duncan_Idaho", tone: "danger" }],
        warning: expect.stringContaining("straight to the database")
      }
    ));
    await waitFor(() => expect(vehiclesApi.deleteVehicle).toHaveBeenCalledWith("5101"));
    expect(await screen.findByText('"Sandcrawler Delete" was deleted.')).toBeInTheDocument();
    expect(vi.mocked(vehiclesApi.list).mock.calls.length).toBeGreaterThan(1);
  });

  it("does not delete when the confirm dialog is declined", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(deleteListResponse(
      { vehicles: true, vehicleDelete: true, vehicleDeleteQueue: false },
      { id: "5102", name: "Sandcrawler Declined Delete" }
    ));

    renderPanel({ confirmAction: vi.fn().mockResolvedValue(false) });
    fireEvent.click(await awaitFreshRows("Sandcrawler Declined Delete"));

    await waitFor(() => expect(vehiclesApi.deleteVehicle).not.toHaveBeenCalled());
  });

  it("queues the delete when the map is live and warns that it will apply on the next restart", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(deleteListResponse(
      { vehicles: true, vehicleDelete: true, vehicleDeleteQueue: true },
      { id: "5103", name: "Sandcrawler Queue Delete" }
    ));
    vi.mocked(vehiclesApi.deleteVehicle).mockResolvedValue({
      supported: true,
      backupCreated: false,
      result: { ok: true, queued: true, vehicleId: 5103, map: "HaggaBasin", partitionId: 3 }
    });

    const props = renderPanel();
    fireEvent.click(await awaitFreshRows("Sandcrawler Queue Delete"));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      'Delete "Sandcrawler Queue Delete"? This permanently deletes the vehicle and everything stored in it.',
      expect.objectContaining({ warning: expect.stringContaining("queued and applied") })
    ));
    await waitFor(() => expect(vehiclesApi.deleteVehicle).toHaveBeenCalledWith("5103"));
    expect(await screen.findByText(/is queued and applies when this map next restarts or stops/)).toBeInTheDocument();
    expect(vehiclesApi.pendingDeletes).toHaveBeenCalled();
  });

  it("shows the queued-delete pill and blocks permission edits on that row", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(deleteListResponse(
      { vehicles: true, vehicleDelete: true, vehicleDeleteQueue: true, vehiclePermissions: true },
      { id: "5104", name: "Sandcrawler Pending Delete" }
    ));
    vi.mocked(vehiclesApi.pendingDeletes).mockResolvedValue({
      supported: true,
      total: 1,
      pending: [{ vehicleId: 5104, map: "HaggaBasin", partitionId: 3, queuedAt: new Date().toISOString(), attempts: 0, lastError: "" }],
      byTarget: [{ map: "HaggaBasin", partitionId: 3, partitionMap: "Survival_1", dimensionIndex: 0, count: 1 }]
    });
    vi.mocked(vehiclesApi.permissions).mockResolvedValue({
      supported: true,
      vehicleId: 5104,
      actorId: "5104",
      map: "HaggaBasin",
      mapNameId: 1,
      entries: [{ playerId: "4", name: "Duncan_Idaho", rank: 1, label: "", canonical: true }]
    } as never);

    renderPanel();
    await screen.findByText("Sandcrawler Pending Delete");

    expect(await screen.findByRole("button", { name: "Cancel queued delete for Sandcrawler Pending Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete Sandcrawler Pending Delete" })).not.toBeInTheDocument();

    // Server-side, this vehicle rejects every other mutation while its
    // delete is pending -- the Permissions tab must not offer a control that
    // would just 409.
    fireEvent.click(await screen.findByLabelText("Show components for Sandcrawler Pending Delete"));
    fireEvent.click(await screen.findByRole("tab", { name: "Permissions" }));
    const saveButton = await screen.findByRole("button", { name: "Save changes" });
    expect(saveButton).toBeDisabled();
    expect(saveButton).toHaveAttribute("title", "This vehicle has a pending delete queued and cannot be modified. Cancel the delete first.");
  });

  it("cancelling the queued delete calls the API and refreshes the pending list", async () => {
    vi.mocked(vehiclesApi.list).mockResolvedValue(deleteListResponse(
      { vehicles: true, vehicleDelete: true, vehicleDeleteQueue: true },
      { id: "5105", name: "Sandcrawler Cancel Delete" }
    ));
    vi.mocked(vehiclesApi.pendingDeletes).mockResolvedValue({
      supported: true,
      total: 1,
      pending: [{ vehicleId: 5105, map: "HaggaBasin", partitionId: 3, queuedAt: new Date().toISOString(), attempts: 0, lastError: "" }],
      byTarget: [{ map: "HaggaBasin", partitionId: 3, partitionMap: "Survival_1", dimensionIndex: 0, count: 1 }]
    });
    vi.mocked(vehiclesApi.cancelQueuedDelete).mockResolvedValue({ supported: true, result: { ok: true, vehicleId: 5105, pending: 0 } });

    const props = renderPanel();
    await screen.findByText("Sandcrawler Cancel Delete");

    fireEvent.click(await screen.findByRole("button", { name: "Cancel queued delete for Sandcrawler Cancel Delete" }));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalledWith(
      'Cancel the queued delete for "Sandcrawler Cancel Delete"?',
      { title: "Cancel Queued Delete", confirmLabel: "Cancel Delete" }
    ));
    await waitFor(() => expect(vehiclesApi.cancelQueuedDelete).toHaveBeenCalledWith("5105"));
    expect(await screen.findByText('Queued delete for "Sandcrawler Cancel Delete" was canceled.')).toBeInTheDocument();
  });
});
