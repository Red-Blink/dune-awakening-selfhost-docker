import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { vehiclesApi, type VehiclePermissionEntry, type VehiclePermissionRank } from "../../api/vehicles";
import { VehiclePermissionsTab } from "./VehiclePermissionsTab";

vi.mock("../../api/vehicles", () => ({
  vehiclesApi: {
    permissions: vi.fn(),
    setPermissions: vi.fn(),
    permissionCandidates: vi.fn(),
    transferToSystemCustodian: vi.fn()
  }
}));

type SystemCustodian = { available: boolean; canCreate?: boolean; playerId?: string; name?: string; reason?: string };

function entry(playerId: string, name: string, rank: VehiclePermissionRank, canonical = true): VehiclePermissionEntry {
  return { playerId, name, rank, label: "", canonical };
}

function mockRoster(
  entries: VehiclePermissionEntry[],
  systemCustodian?: SystemCustodian,
  claim: { claimed?: boolean; unclaimedReason?: string } = {}
) {
  vi.mocked(vehiclesApi.permissions).mockResolvedValue({
    supported: true,
    vehicleId: 3001,
    actorId: "3001",
    map: "DeepDesert",
    mapNameId: 7,
    systemCustodian,
    entries,
    ...claim
  } as never);
}

function renderTab(overrides: Partial<Parameters<typeof VehiclePermissionsTab>[0]> = {}) {
  const props = {
    vehicleId: "3001",
    vehicleName: "Sandcrawler MK-II",
    onSaved: vi.fn(),
    confirmAction: vi.fn().mockResolvedValue(true),
    ...overrides
  };
  render(<VehiclePermissionsTab {...props} />);
  return props;
}

function ownerName() {
  return document.querySelector(".vehicles-permissions-owner-name");
}

const DEFAULT_ROSTER = [
  entry("4", "DarkShark", 1),
  entry("29", "Yaida", 2),
  entry("31", "Stilgar", 3)
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("VehiclePermissionsTab layout", () => {
  it("puts the Owner in the card and everyone else in the roster", async () => {
    mockRoster(DEFAULT_ROSTER);
    renderTab();

    expect(await screen.findByText("DarkShark", { selector: ".vehicles-permissions-owner-name" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Rank for DarkShark" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove DarkShark" })).not.toBeInTheDocument();

    expect(screen.getAllByRole("radiogroup")).toHaveLength(2);
    expect(screen.getByRole("radiogroup", { name: "Rank for Yaida" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Rank for Stilgar" })).toBeInTheDocument();
  });

  it("checks exactly the segment matching each player's rank", async () => {
    mockRoster(DEFAULT_ROSTER);
    renderTab();
    await screen.findByRole("radio", { name: "Co-Owner for Yaida" });

    expect(screen.getByRole("radio", { name: "Owner for Yaida" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Co-Owner for Yaida" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Associate for Yaida" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Associate for Stilgar" })).toBeChecked();
  });

  it("keeps each row's rank group independent of the others", async () => {
    mockRoster(DEFAULT_ROSTER);
    renderTab();

    fireEvent.click(await screen.findByRole("radio", { name: "Associate for Yaida" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Associate for Yaida" })).toBeChecked());
    expect(screen.getByRole("radio", { name: "Associate for Stilgar" })).toBeChecked();
  });

  // The demote-on-already-checked path: clicking a segment that already reads
  // checked fires no native change event, so onClick has to carry it too --
  // this is what would strand a roster with two Owners if it regressed.
  it("swaps the owner and the roster on promote, and swaps them back", async () => {
    mockRoster(DEFAULT_ROSTER);
    renderTab();

    fireEvent.click(await screen.findByRole("radio", { name: "Owner for Yaida" }));
    await waitFor(() => expect(ownerName()).toHaveTextContent("Yaida"));
    expect(screen.getByRole("radio", { name: "Co-Owner for DarkShark" })).toBeChecked();

    fireEvent.click(screen.getByRole("radio", { name: "Owner for DarkShark" }));
    await waitFor(() => expect(ownerName()).toHaveTextContent("DarkShark"));
    expect(screen.getByRole("radio", { name: "Co-Owner for Yaida" })).toBeChecked();
  });

  it("renders no breakdown at all when the vehicle is shared with nobody", async () => {
    mockRoster([entry("4", "DarkShark", 1)]);
    renderTab();
    expect(await screen.findByText("Shared with · 0")).toBeInTheDocument();
    expect(document.querySelector(".vehicles-permissions-section-meta")).toBeNull();
    expect(screen.getByText("This vehicle is not shared with anyone else.")).toBeInTheDocument();
  });

  it("clears the player search after adding a result", async () => {
    mockRoster(DEFAULT_ROSTER);
    vi.mocked(vehiclesApi.permissionCandidates).mockResolvedValue({
      rows: [{ playerId: "32", name: "Chani" }]
    } as never);
    renderTab();

    const search = await screen.findByPlaceholderText("Search a player to add");
    fireEvent.change(search, { target: { value: "Chani" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add Chani" }));

    await waitFor(() => expect(search).toHaveValue(""));
    expect(screen.queryByRole("button", { name: "Add Chani" })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Associate for Chani" })).toBeChecked();
  });

});

describe("VehiclePermissionsTab ownerless state", () => {
  it("flags a vehicle with no Owner and refuses to save it", async () => {
    mockRoster([entry("29", "Yaida", 2)]);
    renderTab();

    expect(await screen.findByText("No Owner set")).toBeInTheDocument();
    expect(document.querySelector(".vehicles-permissions-owner-card")).toHaveClass("vehicles-permissions-owner-card-empty");
    expect(screen.getByRole("alert")).toHaveTextContent("This vehicle has no Owner.");

    fireEvent.click(screen.getByRole("radio", { name: "Associate for Yaida" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });
});

describe("VehiclePermissionsTab unclaimed vehicle", () => {
  const UNCLAIMED = "This vehicle is not claimed -- it has no dune.permission_actor row.";

  it("explains the unclaimed state and blocks every write, Transfer included", async () => {
    mockRoster([], { available: true, playerId: "900000201", name: "Server" }, {
      claimed: false,
      unclaimedReason: UNCLAIMED
    });
    renderTab();

    expect(await screen.findByText(UNCLAIMED)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Transfer to Server" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.queryByText(/This vehicle has no Owner/)).not.toBeInTheDocument();
  });

  it("leaves the roster read-only rather than letting edits accumulate", async () => {
    mockRoster(DEFAULT_ROSTER, undefined, { claimed: false, unclaimedReason: UNCLAIMED });
    renderTab();

    await screen.findByText(UNCLAIMED);
    expect(screen.getByRole("radio", { name: "Associate for Yaida" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Yaida" })).toBeDisabled();
  });

  it("treats a missing flag as claimed", async () => {
    mockRoster(DEFAULT_ROSTER);
    renderTab();

    await screen.findByText("DarkShark", { selector: ".vehicles-permissions-owner-name" });
    expect(screen.getByRole("radio", { name: "Associate for Yaida" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove Yaida" })).toBeEnabled();
  });
});

describe("VehiclePermissionsTab system custodian", () => {
  it("shows the custodian pill in the hero when the custodian owns the vehicle", async () => {
    mockRoster(
      [entry("900000201", "Server", 1), entry("29", "Yaida", 2)],
      { available: true, playerId: "900000201", name: "Server" }
    );
    renderTab();

    await screen.findByText("Server", { selector: ".vehicles-permissions-owner-name" });
    expect(ownerName()?.querySelector(".bases-permissions-system-label")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Owned by Server" })).toBeDisabled();
  });

  it("shows the custodian pill on the roster row when the custodian is not the Owner", async () => {
    mockRoster(
      [entry("4", "DarkShark", 1), entry("900000201", "Server", 3)],
      { available: true, playerId: "900000201", name: "Server" }
    );
    renderTab();

    await screen.findByText("DarkShark", { selector: ".vehicles-permissions-owner-name" });
    expect(ownerName()?.querySelector(".bases-permissions-system-label")).toBeNull();
    expect(document.querySelector(".vehicles-permissions-row .bases-permissions-system-label")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Transfer to Server" })).toBeEnabled();
  });

  it("keeps the unavailability reason inside the owner card", async () => {
    mockRoster(
      [entry("4", "DarkShark", 1)],
      { available: false, reason: "No supported system custodian was found." }
    );
    renderTab();

    const reason = await screen.findByText("No supported system custodian was found.");
    expect(document.querySelector(".vehicles-permissions-owner-card")).toContainElement(reason);
    expect(screen.getByRole("button", { name: "Transfer to Custodian" })).toBeDisabled();
  });

  it("disables Transfer while the roster is dirty", async () => {
    mockRoster(
      [entry("4", "DarkShark", 1), entry("29", "Yaida", 2)],
      { available: true, playerId: "900000201", name: "Server" }
    );
    renderTab();

    fireEvent.click(await screen.findByRole("radio", { name: "Associate for Yaida" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Transfer to Server" })).toBeDisabled();
  });

  it("confirms, posts, and reloads on Transfer", async () => {
    mockRoster(
      [entry("4", "DarkShark", 1), entry("29", "Yaida", 2)],
      { available: true, playerId: "900000201", name: "Server" }
    );
    vi.mocked(vehiclesApi.transferToSystemCustodian).mockResolvedValue({
      supported: true,
      result: { ok: true, vehicleId: 3001, actorId: "3001", map: "DeepDesert", added: 1, reranked: 1, removed: 0, total: 2, message: "Ownership was transferred to the Server system custodian." }
    } as never);
    const props = renderTab();

    fireEvent.click(await screen.findByRole("button", { name: "Transfer to Server" }));

    await waitFor(() => expect(vehiclesApi.transferToSystemCustodian).toHaveBeenCalledWith("3001"));
    expect(props.confirmAction).toHaveBeenCalled();
    await waitFor(() => expect(vehiclesApi.permissions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
  });

  it("does not post when the confirmation is declined", async () => {
    mockRoster(
      [entry("4", "DarkShark", 1), entry("29", "Yaida", 2)],
      { available: true, playerId: "900000201", name: "Server" }
    );
    renderTab({ confirmAction: vi.fn().mockResolvedValue(false) });

    fireEvent.click(await screen.findByRole("button", { name: "Transfer to Server" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Saving…" })).not.toBeInTheDocument());
    expect(vehiclesApi.transferToSystemCustodian).not.toHaveBeenCalled();
  });

  it("removes the custodian from the roster, rather than demoting it, when another player is promoted to Owner", async () => {
    mockRoster(
      [entry("900000201", "Server", 1), entry("29", "Yaida", 3)],
      { available: true, playerId: "900000201", name: "Server" }
    );
    renderTab();

    fireEvent.click(await screen.findByRole("radio", { name: "Owner for Yaida" }));

    await waitFor(() => expect(ownerName()).toHaveTextContent("Yaida"));
    expect(screen.queryByText("Server")).not.toBeInTheDocument();
    expect(screen.getByText("Shared with · 0")).toBeInTheDocument();
  });

  it("removes the custodian from the roster, rather than demoting it, when a new player is added directly as Owner", async () => {
    mockRoster(
      [entry("900000201", "Server", 1), entry("29", "Yaida", 3)],
      { available: true, playerId: "900000201", name: "Server" }
    );
    vi.mocked(vehiclesApi.permissionCandidates).mockResolvedValue({
      rows: [{ playerId: "32", name: "Chani" }]
    } as never);
    renderTab();

    await screen.findByText("Yaida", { selector: ".vehicles-permissions-name" });
    fireEvent.change(screen.getByLabelText("Add as"), { target: { value: "1" } });
    fireEvent.change(screen.getByPlaceholderText("Search a player to add"), { target: { value: "Chani" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add Chani" }));

    await waitFor(() => expect(ownerName()).toHaveTextContent("Chani"));
    expect(screen.queryByText("Server")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Associate for Yaida" })).toBeChecked();
  });
});

describe("VehiclePermissionsTab entry warnings", () => {
  it("flags a non-canonical Owner from inside the owner card", async () => {
    mockRoster([entry("4", "DarkShark", 1, false), entry("29", "Yaida", 2)]);
    renderTab();

    const warning = await screen.findByLabelText("Ignored by the game");
    expect(document.querySelector(".vehicles-permissions-owner-card")).toContainElement(warning);
  });
});

describe("VehiclePermissionsTab saving", () => {
  it("disables every control while a save is in flight", async () => {
    mockRoster(DEFAULT_ROSTER);
    vi.mocked(vehiclesApi.setPermissions).mockReturnValue(new Promise(() => {}) as never);
    renderTab();

    fireEvent.click(await screen.findByRole("radio", { name: "Associate for Yaida" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Saving…" })).toBeInTheDocument());
    screen.getAllByRole("radio").forEach((radio) => expect(radio).toBeDisabled());
    expect(screen.getByRole("button", { name: "Remove Yaida" })).toBeDisabled();
  });

  it("restores the original segment on Revert without calling the server", async () => {
    mockRoster(DEFAULT_ROSTER);
    renderTab();

    fireEvent.click(await screen.findByRole("radio", { name: "Associate for Yaida" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));

    await waitFor(() => expect(screen.getByRole("radio", { name: "Co-Owner for Yaida" })).toBeChecked());
    expect(vehiclesApi.setPermissions).not.toHaveBeenCalled();
  });

  it("posts the whole roster, not a delta, and refetches on save", async () => {
    mockRoster(DEFAULT_ROSTER);
    vi.mocked(vehiclesApi.setPermissions).mockResolvedValue({
      supported: true,
      result: { ok: true, vehicleId: 3001, actorId: "3001", map: "DeepDesert", added: 0, reranked: 1, removed: 0, total: 3, message: "Permissions were updated." }
    } as never);
    const props = renderTab();

    fireEvent.click(await screen.findByRole("radio", { name: "Associate for Yaida" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(vehiclesApi.setPermissions).toHaveBeenCalledWith("3001", [
      { playerId: "4", rank: 1 },
      { playerId: "29", rank: 3 },
      { playerId: "31", rank: 3 }
    ]));
    await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
  });
});

describe("VehiclePermissionsTab load states", () => {
  it("reports loading, then the roster", async () => {
    mockRoster(DEFAULT_ROSTER);
    renderTab();
    expect(screen.getByText("Loading permissions…")).toBeInTheDocument();
    expect(await screen.findByText("Shared with · 2")).toBeInTheDocument();
  });

  it("offers a working Retry when the roster fails to load", async () => {
    vi.mocked(vehiclesApi.permissions).mockRejectedValueOnce(new Error("Permissions are unavailable."));
    renderTab();

    expect(await screen.findByText(/Permissions are unavailable\./)).toBeInTheDocument();
    mockRoster(DEFAULT_ROSTER);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Shared with · 2")).toBeInTheDocument();
    expect(vehiclesApi.permissions).toHaveBeenCalledTimes(2);
  });
});
