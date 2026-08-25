import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { basesApi, type BaseChildAccessRow } from "../../api/bases";
import { BaseChildPermissionsTab } from "./BaseChildPermissionsTab";

vi.mock("../../api/bases", () => ({
  basesApi: {
    childAccess: vi.fn(),
    setChildAccess: vi.fn()
  }
}));

function row(actorId: string, name: string, buildingType: string, currentAccess: 1 | 2 | 3 | 4 | 5): BaseChildAccessRow {
  return {
    actorId, name, buildingType, currentAccess,
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

beforeEach(() => vi.clearAllMocks());

describe("BaseChildPermissionsTab", () => {
  it("lists pieces with their current level checked in the segmented control", async () => {
    mockRows([row("14274", "Generator", "Generator_Placeable", 2)]);
    renderTab();

    expect(await screen.findByText("Generator")).toBeInTheDocument();
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

    expect(await screen.findByText("Generator")).toBeInTheDocument();
    expect(screen.getByText("Wooden Door")).toBeInTheDocument();
    expect(screen.getByText("Pieces · 2")).toBeInTheDocument();
    expect(screen.getByText("1 not Sub-Fief")).toBeInTheDocument();
    expect(screen.getByText("Generator").closest(".bases-child-access-row")).toHaveClass("unusual");
    expect(screen.getByText("Wooden Door").closest(".bases-child-access-row")).not.toHaveClass("unusual");
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

  it("Reset Selected stages checked rows back to Associate", async () => {
    mockRows([row("14274", "Generator", "Generator_Placeable", 2)]);
    renderTab();

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Generator" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset Selected to Sub-Fief" }));

    await waitFor(() => expect(screen.getByRole("radio", { name: "Associate for Generator" })).toBeChecked());
    expect(basesApi.setChildAccess).not.toHaveBeenCalled();
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
});
