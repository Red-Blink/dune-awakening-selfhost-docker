import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapsApi } from "../../api/maps";
import { vehiclesApi, type VehiclesListResponse } from "../../api/vehicles";
import { invalidateInstanceNames } from "../maps/instanceNames";
import { PlayerVehiclesTab } from "./PlayerVehiclesTab";

vi.mock("../../api/maps", () => ({ mapsApi: { sietchDimensions: vi.fn() } }));
vi.mock("../../api/vehicles", () => ({
  vehiclesApi: {
    forPlayer: vi.fn(),
    permissions: vi.fn(),
    setPermissions: vi.fn(),
    permissionCandidates: vi.fn(),
    transferToSystemCustodian: vi.fn()
  }
}));

const confirmAction = vi.fn().mockResolvedValue(true);

function response(overrides: Partial<VehiclesListResponse> = {}): VehiclesListResponse {
  return {
    capabilities: { vehicles: true },
    totalCount: 2,
    totalVehicles: 12,
    rows: [
      { id: "1", name: "Owned Bike", type: "Sandbike", owner: "Kovalt", relationship: "Owner", shared_with: [], condition_percent: 90, current_fuel: 50, max_fuel: 100, fuel_percent: 50, map: "HaggaBasin", partition_id: 1, x: 10, y: 20, z: 0, modules: [] },
      { id: "2", name: "Shared Buggy", type: "Buggy", owner: "Duncan", relationship: "Co-Owner", shared_with: [], condition_percent: 80, current_fuel: null, max_fuel: null, fuel_percent: null, map: "DeepDesert", partition_id: 2, x: 0, y: 0, z: 0, modules: [{ templateId: "Wheel", name: "Buggy Tread", condition: 80, maxCondition: 100, conditionPercent: 80 }] }
    ],
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateInstanceNames();
  vi.mocked(mapsApi.sietchDimensions).mockResolvedValue({ stdout: "", exitCode: 1 } as never);
});

describe("PlayerVehiclesTab", () => {
  it("shows owned and shared vehicles with the same expandable vehicle presentation", async () => {
    vi.mocked(vehiclesApi.forPlayer).mockResolvedValue(response());
    render(<PlayerVehiclesTab playerId="42" playerName="Kovalt" confirmAction={confirmAction} />);

    expect(await screen.findByText("Owned Bike")).toBeInTheDocument();
    expect(screen.getByText("Hagga Basin · Partition 1")).toBeInTheDocument();
    expect(vehiclesApi.forPlayer).toHaveBeenCalledWith("42");
    expect(screen.getByText("Co-Owner")).toBeInTheDocument();
    expect(screen.getByText("Duncan")).toBeInTheDocument();
    expect(screen.getByLabelText("Player vehicle totals")).toHaveTextContent("2 Total");
    expect(screen.getByLabelText("Player vehicle totals")).toHaveTextContent("1 Owned");
    expect(screen.getByLabelText("Player vehicle totals")).toHaveTextContent("1 Shared");

    fireEvent.click(screen.getByLabelText("Show components for Shared Buggy"));
    expect(screen.getByText("Buggy Tread")).toBeInTheDocument();
  });

  it("refreshes the filtered list on demand", async () => {
    vi.mocked(vehiclesApi.forPlayer).mockResolvedValue(response({ rows: [], totalCount: 0 }));
    render(<PlayerVehiclesTab playerId="42" playerName="Kovalt" confirmAction={confirmAction} />);
    expect(await screen.findByText("Kovalt has no owned or shared vehicles.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(vehiclesApi.forPlayer).toHaveBeenCalledTimes(2));
  });

  // The default fixture above sends only { vehicles: true } with no
  // vehiclePermissions flag -- this is the regression guard that an older/
  // capability-less API keeps the tab hidden rather than defaulting it on.
  it("hides the Permissions tab without the vehiclePermissions capability", async () => {
    vi.mocked(vehiclesApi.forPlayer).mockResolvedValue(response());
    render(<PlayerVehiclesTab playerId="42" playerName="Kovalt" confirmAction={confirmAction} />);

    fireEvent.click(await screen.findByLabelText("Show components for Owned Bike"));
    expect(screen.queryByRole("tab", { name: "Permissions" })).not.toBeInTheDocument();
  });

  it("shows the Permissions tab and refetches after a save when the capability is present", async () => {
    vi.mocked(vehiclesApi.forPlayer).mockResolvedValue(response({ capabilities: { vehicles: true, vehiclePermissions: true } }));
    vi.mocked(vehiclesApi.permissions).mockResolvedValue({
      supported: true,
      vehicleId: 1,
      actorId: "1",
      map: "HaggaBasin",
      mapNameId: 1,
      entries: [{ playerId: "4", name: "Kovalt", rank: 1, label: "", canonical: true }]
    } as never);
    render(<PlayerVehiclesTab playerId="42" playerName="Kovalt" confirmAction={confirmAction} />);

    fireEvent.click(await screen.findByLabelText("Show components for Owned Bike"));
    fireEvent.click(await screen.findByRole("tab", { name: "Permissions" }));
    await screen.findByText("Kovalt", { selector: ".vehicles-permissions-owner-name" });

    vi.mocked(vehiclesApi.setPermissions).mockResolvedValue({
      supported: true,
      result: { ok: true, vehicleId: 1, actorId: "1", map: "HaggaBasin", added: 1, reranked: 0, removed: 0, total: 2, message: "Permissions were updated." }
    } as never);
    vi.mocked(vehiclesApi.permissionCandidates).mockResolvedValue({ rows: [{ playerId: "9", name: "Leto_A" }] } as never);
    fireEvent.change(screen.getByPlaceholderText("Search a player to add"), { target: { value: "Leto" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add Leto_A" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));

    // ownedCount is derived from row.relationship, which can shift after a
    // rank change, so a save must refetch rather than trust stale rows.
    await waitFor(() => expect(vehiclesApi.forPlayer).toHaveBeenCalledTimes(2));
  });

  // Regression guard for the second confirmAction-threading chain (player
  // detail, via VehicleTable): the transfer button must reach here too, not
  // just the global Vehicles panel.
  it("reaches the transfer-to-custodian button from the player detail mount point", async () => {
    vi.mocked(vehiclesApi.forPlayer).mockResolvedValue(response({ capabilities: { vehicles: true, vehiclePermissions: true } }));
    vi.mocked(vehiclesApi.permissions).mockResolvedValue({
      supported: true,
      vehicleId: 1,
      actorId: "1",
      map: "HaggaBasin",
      mapNameId: 1,
      systemCustodian: { available: true, playerId: "900000201", name: "Server" },
      entries: [{ playerId: "4", name: "Kovalt", rank: 1, label: "", canonical: true }]
    } as never);
    render(<PlayerVehiclesTab playerId="42" playerName="Kovalt" confirmAction={confirmAction} />);

    fireEvent.click(await screen.findByLabelText("Show components for Owned Bike"));
    fireEvent.click(await screen.findByRole("tab", { name: "Permissions" }));

    expect(await screen.findByRole("button", { name: "Transfer to Server" })).toBeInTheDocument();
  });
});
