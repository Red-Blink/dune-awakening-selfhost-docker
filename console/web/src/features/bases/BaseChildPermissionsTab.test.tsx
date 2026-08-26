import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { basesApi, type BaseChildAccessGroup, type BaseChildAccessRow } from "../../api/bases";
import { BaseChildPermissionsTab } from "./BaseChildPermissionsTab";

vi.mock("../../api/bases", () => ({
  basesApi: {
    childAccess: vi.fn(),
    setChildAccess: vi.fn(),
    pendingChildAccess: vi.fn(),
    cancelQueuedChildAccess: vi.fn()
  }
}));

function mockQueue(updates: { actorId: string; accessLevel: 1 | 2 | 3 | 4 | 5 }[], baseId = 14346) {
  vi.mocked(basesApi.pendingChildAccess).mockResolvedValue({
    supported: true,
    total: updates.length ? 1 : 0,
    pending: updates.length
      ? [{ baseId, map: "DeepDesert", partitionId: 59, queuedAt: "2026-08-25T00:00:00.000Z", attempts: 0, lastError: "", updates }]
      : [],
    byTarget: []
  } as never);
}

function row(
  actorId: string, name: string, buildingType: string, currentAccess: 1 | 2 | 3 | 4 | 5,
  group: BaseChildAccessGroup = "other"
): BaseChildAccessRow {
  return {
    actorId, name, buildingType, group, currentAccess,
    currentAccessLabel: { 1: "Public", 2: "Guild", 3: "Associate", 4: "Co-Owner", 5: "Owner" }[currentAccess],
    isSubFief: currentAccess === 3
  };
}

function mockRows(rows: BaseChildAccessRow[], supported = true, reason = "") {
  vi.mocked(basesApi.childAccess).mockResolvedValue({ supported, inspected: rows.length, rows, reason } as never);
}

function renderTab(overrides: Partial<Parameters<typeof BaseChildPermissionsTab>[0]> = {}) {
  const props = {
    baseId: "14346",
    baseName: "Hall of the Iron Fist",
    confirmAction: vi.fn().mockResolvedValue(true),
    onError: vi.fn(),
    ...overrides
  };
  render(<BaseChildPermissionsTab {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQueue([]);
});

describe("BaseChildPermissionsTab", () => {
  it("lists pieces with their current level checked in the segmented control", async () => {
    mockRows([row("14274", "Generator", "Generator_Placeable", 2)]);
    renderTab();

    expect(await screen.findByText("Generator", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Guild for Generator" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Associate for Generator" })).not.toBeChecked();
  });

  it("shows the empty state when the base has no child pieces at all", async () => {
    mockRows([]);
    renderTab();
    expect(await screen.findByText("This base has no doors or devices with their own access level.")).toBeInTheDocument();
  });

  it("lists every piece, not just the ones that deviate from Sub-Fief, and flags only the deviating ones", async () => {
    mockRows([
      row("14274", "Generator", "Generator_Placeable", 2),
      row("14400", "Wooden Door", "Door_Placeable", 3)
    ]);
    renderTab();

    expect(await screen.findByText("Generator", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("Wooden Door", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("Pieces · 2")).toBeInTheDocument();
    expect(screen.getByText("1 not Sub-Fief")).toBeInTheDocument();
    expect(screen.getByText("Generator", { selector: "strong" }).closest(".bases-child-access-row")).toHaveClass("unusual");
    expect(screen.getByText("Wooden Door", { selector: "strong" }).closest(".bases-child-access-row")).not.toHaveClass("unusual");
  });

  it("omits the not-Sub-Fief count when every piece already matches", async () => {
    mockRows([row("14400", "Wooden Door", "Door_Placeable", 3)]);
    renderTab();
    expect(await screen.findByText("Pieces · 1")).toBeInTheDocument();
    expect(screen.queryByText(/not Sub-Fief/)).not.toBeInTheDocument();
  });

  it("shows the unsupported reason when the schema lacks the feature", async () => {
    mockRows([], false, "Child access auditing is unsupported by the detected game database.");
    renderTab();
    expect(await screen.findByText("Child access auditing is unsupported by the detected game database.")).toBeInTheDocument();
  });

  it("selecting a segment only updates local draft until Save is clicked", async () => {
    mockRows([row("14274", "Generator", "Generator_Placeable", 2)]);
    renderTab();

    fireEvent.click(await screen.findByRole("radio", { name: "Associate for Generator" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Associate for Generator" })).toBeChecked());
    expect(basesApi.setChildAccess).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("reverts the draft without calling the server", async () => {
    mockRows([row("14274", "Generator", "Generator_Placeable", 2)]);
    renderTab();

    fireEvent.click(await screen.findByRole("radio", { name: "Owner for Generator" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));

    await waitFor(() => expect(screen.getByRole("radio", { name: "Guild for Generator" })).toBeChecked());
    expect(basesApi.setChildAccess).not.toHaveBeenCalled();
  });

  it("Apply to Selected stages checked rows to the chosen level, defaulting to Associate", async () => {
    mockRows([row("14274", "Generator", "Generator_Placeable", 2)]);
    renderTab();

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Generator" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply to Selected" }));

    await waitFor(() => expect(screen.getByRole("radio", { name: "Associate for Generator" })).toBeChecked());
    expect(basesApi.setChildAccess).not.toHaveBeenCalled();
  });

  it("Apply to Selected uses whichever level is chosen in the Apply dropdown", async () => {
    mockRows([row("14274", "Generator", "Generator_Placeable", 2)]);
    renderTab();

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Generator" }));
    fireEvent.change(screen.getByLabelText("Apply"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply to Selected" }));

    await waitFor(() => expect(screen.getByRole("radio", { name: "Owner for Generator" })).toBeChecked());
  });

  it("filters the list by master category, and Select All only selects the currently visible pieces", async () => {
    mockRows([
      row("14274", "Generator", "Generator_Placeable", 2, "generators"),
      row("14300", "Storage Container", "StorageContainer_Placeable", 2, "storage")
    ]);
    renderTab();

    await screen.findByText("Generator", { selector: "strong" });
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "generators" } });

    expect(screen.getByText("Generator", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByText("Storage Container", { selector: "strong" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Select All" }));
    expect(screen.getByRole("checkbox", { name: "Select Generator" })).toBeChecked();

    // Clearing the filter reveals the Storage Container row again, unselected --
    // Select All while filtered never reached it.
    fireEvent.change(screen.getByLabelText("Type"), { target: { value: "all" } });
    expect(screen.getByRole("checkbox", { name: "Select Storage Container" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select Generator" })).toBeChecked();
  });

  it("offers only the master categories actually present, not individual building types", async () => {
    mockRows([
      row("14274", "Generator", "Generator_Placeable", 2, "generators"),
      row("14300", "Storage Container", "StorageContainer_Placeable", 2, "storage"),
      row("14310", "Small Ore Refinery", "SmallOreRefinery_Placeable", 2, "refining"),
      row("14320", "Water Cistern", "WaterCistern_Placeable", 2, "water")
    ]);
    renderTab();

    const typeSelect = await screen.findByLabelText("Type");
    const optionLabels = [...typeSelect.querySelectorAll("option")].map((option) => option.textContent);
    // No Crafting or Other option -- no row in this fixture belongs to either,
    // and no individual building type (e.g. "Generator") ever appears.
    expect(optionLabels).toEqual(["All Types", "Storage", "Refining", "Generators", "Water Storage"]);
  });

  it("saves only the changed rows after confirmation, then reloads", async () => {
    mockRows([
      row("14274", "Generator", "Generator_Placeable", 2),
      row("14300", "Storage Container", "StorageContainer_Placeable", 2)
    ]);
    vi.mocked(basesApi.setChildAccess).mockResolvedValue({ supported: true, result: { ok: true, baseId: 14346, updated: 1, message: "1 piece updated." } } as never);
    const props = renderTab();

    fireEvent.click(await screen.findByRole("radio", { name: "Associate for Generator" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(props.confirmAction).toHaveBeenCalled());
    await waitFor(() => expect(basesApi.setChildAccess).toHaveBeenCalledWith("14346", [{ actorId: "14274", accessLevel: 3 }]));
  });

  // A running map never applies an access level change, so a save against a
  // live map is queued. The list must keep showing what the game enforces now.
  it("shows queued changes as pending at restart without changing the displayed level", async () => {
    mockRows([row("14274", "Generator", "Generator_Placeable", 2)]);
    mockQueue([{ actorId: "14274", accessLevel: 5 }]);
    renderTab();

    expect(await screen.findByText(/will be written when its map next restarts/i)).toBeInTheDocument();
    expect(await screen.findByText(/Owner at restart/)).toBeInTheDocument();
    // Still Guild -- the queued level must not be shown as if already applied.
    await waitFor(() => expect(screen.getByRole("radio", { name: "Guild for Generator" })).toBeChecked());
    expect(screen.getByRole("radio", { name: "Owner for Generator" })).not.toBeChecked();
  });

  it("reports a queued save rather than claiming the level was updated", async () => {
    mockRows([row("14274", "Generator", "Generator_Placeable", 2)]);
    vi.mocked(basesApi.setChildAccess).mockResolvedValue({
      supported: true,
      result: { ok: true, baseId: 14346, queued: true }
    } as never);
    renderTab();

    fireEvent.click(await screen.findByRole("radio", { name: "Associate for Generator" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText(/queued and will apply at this map's next restart/i)).toBeInTheDocument();
  });

  it("discards queued changes after confirmation", async () => {
    mockRows([row("14274", "Generator", "Generator_Placeable", 2)]);
    mockQueue([{ actorId: "14274", accessLevel: 5 }]);
    vi.mocked(basesApi.cancelQueuedChildAccess).mockResolvedValue({ supported: true, result: { ok: true, baseId: 14346, pending: 0 } } as never);
    renderTab();

    fireEvent.click(await screen.findByRole("button", { name: /discard queued changes/i }));
    await waitFor(() => expect(basesApi.cancelQueuedChildAccess).toHaveBeenCalledWith("14346"));
  });
});
