import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { playersApi } from "../../api/players";
import { BuildingUnlocksTab } from "./BuildingUnlocksTab";

vi.mock("../../api/players", () => ({
  playersApi: {
    buildingUnlocks: vi.fn(),
    grantBuildingUnlock: vi.fn()
  }
}));

const rows = [
  { itemId: "BasicLighting_Patent", name: "Basic Lighting", group: "Furniture & Decorations", status: "Available", experimental: false },
  { itemId: "Windtrap_Patent", name: "Windtrap", group: "Crafting & Utilities", status: "Owned", experimental: false },
  { itemId: "Developer_Storage_Container_Patent", name: "Developer Storage Container", group: "Experimental", status: "Available", experimental: true }
];

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(playersApi.buildingUnlocks).mockResolvedValue({
    capabilities: { buildingUnlockOwnership: true },
    rows
  });
});

describe("BuildingUnlocksTab", () => {
  it("shows experimental entries by default and prevents duplicate grants", async () => {
    render(<BuildingUnlocksTab dbPlayerId="123" playerName="Chani" confirmAction={vi.fn().mockResolvedValue(true)} />);

    expect(await screen.findByText("Basic Lighting")).toBeInTheDocument();
    expect(screen.getByText("BasicLighting_Patent")).toHaveAttribute("title", "BasicLighting_Patent");
    expect(screen.getByText("Windtrap")).toBeInTheDocument();
    expect(screen.getByText("Developer Storage Container")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Show Experimental" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Owned" })).toBeDisabled();
  });

  it("can hide experimental entries", async () => {
    render(<BuildingUnlocksTab dbPlayerId="123" playerName="Chani" confirmAction={vi.fn().mockResolvedValue(true)} />);

    expect(await screen.findByText("Developer Storage Container")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "Show Experimental" }));
    expect(screen.queryByText("Developer Storage Container")).not.toBeInTheDocument();
  });

  it("grants one real token and changes the row to pending", async () => {
    const confirmAction = vi.fn().mockResolvedValue(true);
    vi.mocked(playersApi.grantBuildingUnlock).mockResolvedValue({ ok: true, status: "Pending" });
    render(<BuildingUnlocksTab dbPlayerId="123" playerName="Chani" confirmAction={confirmAction} />);

    fireEvent.change(await screen.findByLabelText("Filter Building Sets"), { target: { value: "Basic Lighting" } });
    fireEvent.click(await screen.findByRole("button", { name: "Grant" }));
    await waitFor(() => expect(playersApi.grantBuildingUnlock).toHaveBeenCalledWith("123", {
      itemId: "BasicLighting_Patent",
      confirmation: "GRANT BUILDING UNLOCK"
    }));
    expect(confirmAction).toHaveBeenCalled();
    expect(await screen.findByText("Pending Login")).toBeInTheDocument();
    expect(screen.getByText(/Dune will process it on the next login/i)).toBeInTheDocument();
  });

  it("shows a DLC requirement in the grant confirmation", async () => {
    const confirmAction = vi.fn().mockResolvedValue(false);
    vi.mocked(playersApi.buildingUnlocks).mockResolvedValue({
      capabilities: { buildingUnlockOwnership: true },
      rows: [{ itemId: "MTX_Sardaukar_BuildingSet_Patent", name: "Sardaukar Building Set", group: "Special & Promotional", status: "Available", experimental: false, requiredDlc: "Filmic Archive", image: "/images/items/MTX_Sardaukar_BuildingSet_Patent.png" }]
    });
    render(<BuildingUnlocksTab dbPlayerId="123" playerName="Chani" confirmAction={confirmAction} />);

    fireEvent.click(await screen.findByRole("button", { name: "Grant" }));
    expect(confirmAction).toHaveBeenCalledWith(expect.stringMatching(/must own Filmic Archive/i), expect.objectContaining({
      details: expect.arrayContaining([expect.objectContaining({ label: "Requires", value: "Filmic Archive" })])
    }));
  });

  it("shows entitlement-controlled database records without claiming DLC ownership", async () => {
    vi.mocked(playersApi.buildingUnlocks).mockResolvedValue({
      capabilities: { buildingUnlockOwnership: true },
      rows: [{ itemId: "MTX_Neut_DesertMechanicSet_Patent", name: "Dune Man Building Set", group: "Special & Promotional", status: "Owned", experimental: false, requiredDlc: "Lost Harvest", entitlementControlled: true }]
    });
    render(<BuildingUnlocksTab dbPlayerId="123" playerName="Chani" confirmAction={vi.fn().mockResolvedValue(true)} />);

    expect(await screen.findByText("Lost Harvest")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recorded" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Owned" })).not.toBeInTheDocument();
  });
});
