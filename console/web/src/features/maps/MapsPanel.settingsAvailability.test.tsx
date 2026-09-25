import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapsApi } from "../../api/maps";
import { MapsPanel } from "./MapsPanel";

vi.mock("../../api/maps", () => ({
  mapsApi: new Proxy({} as Record<string, unknown>, {
    get: (target, prop: string) => {
      if (!target[prop]) {
        target[prop] = vi.fn().mockResolvedValue({
          stdout: "",
          exitCode: 0,
          content: "",
          rows: [],
          placements: [],
          tradeCenters: [],
          partitions: [],
          fields: [],
          partition: [],
          partitionEngine: [],
          mapEngine: [],
          game: [],
          engine: [],
          capabilities: {},
          values: {},
          sampledAt: ""
        });
      }
      return target[prop];
    }
  })
}));

vi.mock("../../api/setup", () => ({
  setupApi: new Proxy({} as Record<string, unknown>, {
    get: (target, prop: string) => {
      if (!target[prop]) target[prop] = vi.fn().mockResolvedValue({});
      return target[prop];
    }
  })
}));

vi.mock("../../lib/usePendingRefills", () => ({
  usePendingRefills: () => ({ pending: null, refresh: () => {} }),
  usePendingQueues: () => ({
    fuel: { pending: null, refresh: () => {} },
    water: { pending: null, refresh: () => {} },
    deletes: { pending: null, refresh: () => {} },
    vehicleDeletes: { pending: null, refresh: () => {} },
    permissions: { pending: null, refresh: () => {} }
  }),
  pendingRefillCountForMap: () => 0,
  pendingRefillCountForPartition: () => 0,
  vehicleDeleteCountForMap: () => 0,
  vehicleDeleteCountForPartition: () => 0,
  childAccessPieceCountForMap: () => 0,
  childAccessPieceCountForPartition: () => 0
}));

function renderMapsPanel() {
  render(<MapsPanel
    onError={vi.fn()}
    confirmAction={vi.fn().mockResolvedValue(true)}
    confirmSettingsRestart={vi.fn().mockResolvedValue("manual")}
    waitForTaskWithUpdates={vi.fn()}
    taskTechnicalDetails={vi.fn().mockReturnValue("")}
    restartGate={vi.fn().mockResolvedValue("immediate")}
  />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MapsPanel modifier availability", () => {
  it("keeps credits story maps dynamic and explains their fresh-process lifecycle", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.status.mockResolvedValue({
      maps: { stdout: JSON.stringify({ maps: [{ map: "CB_Story_OrbitalMonitor", status: "Ready", mode: "Dynamic", partitionId: "32" }] }) },
      services: { stdout: "" },
      readiness: { stdout: "" }
    });

    renderMapsPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));

    expect(screen.getByText(/completed instance is retired/i)).toBeVisible();
    expect(screen.getByLabelText("Mode")).toHaveValue("dynamic");
    expect(screen.queryByRole("option", { name: "Always On" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Overmap Active" })).not.toBeInTheDocument();
  });

  it("force despawns the whole map instead of only its first partition", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.status.mockResolvedValue({
      maps: { stdout: JSON.stringify({ maps: [{ map: "CB_Overland_S_08", status: "Ready", mode: "Dynamic", partitionId: "29" }] }) },
      services: { stdout: "" },
      readiness: { stdout: "" }
    });
    api.despawn.mockResolvedValue({ task: { id: "task-1", status: "succeeded" } });

    renderMapsPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Force Despawn" }));

    await waitFor(() => expect(api.despawn).toHaveBeenCalledWith("CB_Overland_S_08", "DESPAWN MAP"));
  });

  it("opens settings while the live map-status request is still pending", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.status.mockImplementation(() => new Promise(() => {}));
    api.userSettingsSchema.mockResolvedValue({
      engine: [{
        scope: "engine",
        id: "mining_output_multiplier",
        section: "ConsoleVariables",
        key: "Dune.GlobalMiningOutputMultiplier",
        default: "1.0",
        type: "number",
        clientFile: "",
        category: "Multipliers",
        description: "Mining output multiplier."
      }],
      mapEngine: [],
      partitionEngine: [],
      game: [],
      partition: []
    });
    api.userEngine.mockResolvedValue({ stdout: "mining_output_multiplier\t2.0\n", exitCode: 0 });
    api.rawUserSettings.mockImplementation(() => new Promise(() => {}));

    renderMapsPanel();

    expect(await screen.findByText("Loading Maps")).toBeInTheDocument();
    const modifiers = screen.getByRole("button", { name: "Expand Interactive Modifiers" });
    await waitFor(() => expect(modifiers).toBeEnabled());
    expect(api.rawUserSettings).not.toHaveBeenCalled();

    fireEvent.click(modifiers);

    expect(screen.getByRole("tab", { name: "UserEngine" })).toBeVisible();
    expect(screen.getByDisplayValue("2.0")).toBeVisible();
    expect(api.status).toHaveBeenCalledTimes(1);
  });

  it("edits native ServerCustomSettings values in the dedicated Custom Settings tab", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.status.mockResolvedValue({
      maps: { stdout: JSON.stringify({ maps: [{ map: "Overmap", status: "Ready", mode: "Core Map", partitionId: "2" }] }) },
      services: { stdout: "" },
      readiness: { stdout: "" }
    });
    api.userSettingsSchema.mockResolvedValue({
      engine: [], mapEngine: [], partitionEngine: [], game: [], partition: [],
      serverCustom: [{
        scope: "serverCustom", id: "pvp_mode", section: "/Script/DuneSandbox.UserServerCustomSettings",
        key: "PVPMode", default: "Limited", type: "text", options: ["NoPVP", "Limited", "FullPVP"], clientFile: "", category: "Combat", description: ""
      }, {
        scope: "serverCustom", id: "gathering_amount", section: "/Script/DuneSandbox.UserServerCustomSettings",
        key: "GatheringAmount", default: "1.000000", type: "number", minimum: 0.1, maximum: 10, clientFile: "", category: "Crafting And Resources", description: ""
      }, {
        scope: "serverCustom", id: "building_piece_limit_multiplier", section: "/Script/DuneSandbox.UserServerCustomSettings",
        key: "BuildingPieceLimitMultiplier", default: "1.000000", type: "number", minimum: 0.1, maximum: null,
        recommendedMinimum: 0.1, recommendedMaximum: 10, clientFile: "", category: "Building", description: ""
      }, {
        scope: "serverCustom", id: "base_backup_tool_time_restriction", section: "/Script/DuneSandbox.UserServerCustomSettings",
        key: "BaseBackupToolTimeRestriction", label: "Base Reconstruction Cooldown (Hours)", default: "16.000000",
        type: "number", minimum: 0.2, maximum: null, clientFile: "", category: "Building",
        description: "Cooldown in hours before the Base Reconstruction Tool can pack the same base again."
      }]
    });
    api.userSettingsValues.mockResolvedValue({ stdout: "pvp_mode\tLimited\ngathering_amount\t2.000000\nbuilding_piece_limit_multiplier\t1.000000\nbase_backup_tool_time_restriction\t16.000000\n" });

    renderMapsPanel();
    const modifiers = await screen.findByRole("button", { name: "Expand Interactive Modifiers" });
    await waitFor(() => expect(modifiers).toBeEnabled());
    fireEvent.click(modifiers);
    fireEvent.click(screen.getByRole("tab", { name: "Custom Settings" }));
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "Overmap::2" } });

    expect(await screen.findByDisplayValue("2.000000")).toBeVisible();
    expect(api.userSettingsValues).toHaveBeenCalledWith("serverCustomPartition", "Overmap", "2");
    expect(screen.getByText("ServerCustomSettings.ini", { exact: false })).toBeVisible();

    const pvpMode = screen.getByDisplayValue("Limited");
    expect(pvpMode.tagName).toBe("SELECT");
    expect(pvpMode).toHaveTextContent("NoPVP");
    expect(pvpMode).toHaveTextContent("FullPVP");

    const gatheringAmount = screen.getByDisplayValue("2.000000");
    expect(gatheringAmount).toHaveAttribute("min", "0.1");
    expect(gatheringAmount).toHaveAttribute("max", "10");
    expect(screen.getByText("Allowed: 0.1–10")).toBeVisible();
    fireEvent.change(gatheringAmount, { target: { value: "10.1" } });
    expect(screen.getByText(/supported value within the displayed range/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save Custom Settings" })).toBeDisabled();

    fireEvent.change(gatheringAmount, { target: { value: "10" } });
    expect(screen.queryByText(/supported value within the displayed range/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Custom Settings" })).toBeEnabled();

    const buildingLimit = screen.getByLabelText("Building Piece Limit Multiplier");
    expect(buildingLimit).toHaveAttribute("min", "0.1");
    expect(buildingLimit).not.toHaveAttribute("max");
    expect(screen.getByText("Recommended: 0.1–10")).toBeVisible();
    fireEvent.change(buildingLimit, { target: { value: "20" } });
    expect(screen.getByText(/above Funcom's recommended range/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save Custom Settings" })).toBeEnabled();

    const backupCooldown = screen.getByLabelText("Base Reconstruction Cooldown (Hours)");
    expect(backupCooldown).toHaveAttribute("min", "0.2");
    expect(backupCooldown).not.toHaveAttribute("max");
  });

  it("shows global settings below the Spice Fields table and saves them at Global scope", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.status.mockResolvedValue({
      maps: { stdout: JSON.stringify({ maps: [{ map: "Overmap", status: "Ready", mode: "Core Map", partitionId: "2" }] }) },
      services: { stdout: "" },
      readiness: { stdout: "" }
    });
    api.userSettingsSchema.mockResolvedValue({
      engine: [], mapEngine: [], partitionEngine: [], partition: [],
      game: [{
        scope: "game", id: "spice_manager_tick_rate_seconds", section: "/Script/DuneSandbox.SpiceHarvestingSystem",
        key: "m_ManagerTickRateInSeconds", default: "5.000000", type: "number", clientFile: "", category: "Spice Fields",
        description: "How often (seconds) the spice manager re-evaluates spawn/despawn state."
      }],
      serverCustom: []
    });
    // Two distinct mapsApi.userGame() calls happen: the always-on global Spice
    // Fields load (map="__global__", no explicit Target selection needed) and,
    // separately, the per-target "UserGame" tab's own load once a Target is
    // picked. Assert on the call args rather than a single blanket mock so a
    // regression that stops the global load firing independently is caught.
    api.userGame.mockImplementation((map: string) =>
      Promise.resolve(map === "__global__" ? { stdout: "spice_manager_tick_rate_seconds\t9.000000\n" } : { stdout: "" })
    );
    api.spicefields.mockResolvedValue({
      activeFields: [{ field_id: "12345", map_name: "HaggaBasin", field_type: "Small", dimension_index: 0, spawn_time: 10, value_remaining: 5000 }],
      reason: ""
    });

    renderMapsPanel();
    const modifiers = await screen.findByRole("button", { name: "Expand Interactive Modifiers" });
    await waitFor(() => expect(modifiers).toBeEnabled());
    fireEvent.click(modifiers);
    fireEvent.click(screen.getByRole("tab", { name: "Custom Settings" }));

    // It no longer appears in Custom Settings, where global controls looked
    // like they belonged to the selected map or partition.
    expect(screen.queryByDisplayValue("9.000000")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Spice Fields" }));

    // No Target is needed: this editor is global and follows the live table.
    expect(await screen.findByDisplayValue("9.000000")).toBeVisible();
    const table = document.querySelector(".spicefields-table");
    const settingsHeading = screen.getByRole("heading", { name: "Settings" });
    expect(table).not.toBeNull();
    expect(table!.compareDocumentPosition(settingsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(api.userGame).toHaveBeenCalledWith("__global__"));

    expect(screen.getByRole("button", { name: "Restore Defaults" })).toBeEnabled();
    expect(screen.getByLabelText("Filter Spice Field Settings")).toBeEnabled();

    fireEvent.change(screen.getByDisplayValue("9.000000"), { target: { value: "" } });
    expect(screen.getByText(/valid value for every changed setting/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "3.000000" } });
    expect(screen.queryByText(/valid value for every changed setting/i)).not.toBeInTheDocument();

    // Return to the last-loaded value before exercising Discard independently.
    fireEvent.click(screen.getByRole("button", { name: "Discard Changes" }));
    fireEvent.change(screen.getByDisplayValue("9.000000"), { target: { value: "3.000000" } });

    // Discard reverts to the last-loaded value, not the field's schema default.
    fireEvent.click(screen.getByRole("button", { name: "Discard Changes" }));
    expect(await screen.findByDisplayValue("9.000000")).toBeVisible();

    fireEvent.change(screen.getByDisplayValue("9.000000"), { target: { value: "3.000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.saveUserSettings).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "global", map: "Survival_1", values: { spice_manager_tick_rate_seconds: "3.000000" } })
    ));
  });

  it("excludes Spice Fields from the plain UserGame tab's field list, so there is exactly one editable surface per field", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.status.mockResolvedValue({
      maps: { stdout: JSON.stringify({ maps: [{ map: "Overmap", status: "Ready", mode: "Core Map", partitionId: "2" }] }) },
      services: { stdout: "" },
      readiness: { stdout: "" }
    });
    api.userSettingsSchema.mockResolvedValue({
      engine: [], mapEngine: [], partitionEngine: [], partition: [],
      game: [
        {
          scope: "game", id: "spice_manager_tick_rate_seconds", section: "/Script/DuneSandbox.SpiceHarvestingSystem",
          key: "m_ManagerTickRateInSeconds", default: "5.000000", type: "number", clientFile: "", category: "Spice Fields",
          description: ""
        },
        {
          scope: "game", id: "gathering_amount", section: "/Script/DuneSandbox.GuildSettings",
          key: "GatheringAmount", default: "1.000000", type: "number", clientFile: "", category: "Multipliers",
          description: ""
        }
      ],
      serverCustom: []
    });
    api.userGame.mockResolvedValue({ stdout: "" });

    renderMapsPanel();
    const modifiers = await screen.findByRole("button", { name: "Expand Interactive Modifiers" });
    await waitFor(() => expect(modifiers).toBeEnabled());
    fireEvent.click(modifiers);
    fireEvent.click(screen.getByRole("tab", { name: "UserGame" }));
    // Global, not a specific map/partition: userGameFields reads schema.game
    // only at Global scope -- a partition target would read schema.partition
    // instead (a separate schema key), which isn't what this diff touches.
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "__global__::" } });

    // The unrelated field is present, proving the target/tab actually loaded
    // -- if this were also missing, the exclusion test below would be
    // meaningless (both could be absent for an unrelated reason).
    const categorySelect = await screen.findByLabelText("Modifier Category");
    await waitFor(() => expect(categorySelect).toBeEnabled());
    const categoryOptions = within(categorySelect).getAllByRole("option");
    expect(categoryOptions.some((option) => option.textContent === "Multipliers (1)")).toBe(true);

    // The Spice Fields category itself must not appear in the UserGame tab's
    // category selector at all -- this is the exact scenario the Architect
    // hat flagged: without this exclusion, editing the same field here and
    // in the dedicated Custom Settings section would use two independent,
    // never-cross-invalidated draft states.
    expect(categoryOptions.some((option) => /Spice Fields/.test(option.textContent || ""))).toBe(false);
  });
});
