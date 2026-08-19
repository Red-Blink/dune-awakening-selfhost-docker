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
    permissionCandidates: vi.fn()
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
