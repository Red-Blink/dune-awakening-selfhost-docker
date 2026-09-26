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
    await waitFor(() => expect(api.userGame).toHaveBeenCalledWith("__global__", undefined));

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

  // Mirrors the live confirmation from issue #996's Test 2 (a Deep Desert
  // partition-scoped spice override surviving a Coriolis re-roll) -- this is
  // the frontend half of the same capability, not just the backend write
  // path (already known-generic before this test existed).
  it("scopes Spice Fields to the selected Deep Desert partition once a Target is chosen, instead of always writing Global", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.status.mockResolvedValue({
      maps: { stdout: "" },
      services: { stdout: "8 | DeepDesert_1 | 0 | | server1 | 33001 | 33101 | true | true" },
      readiness: { stdout: "" }
    });
    // Spice Fields is defined in both `game` and `partition` (real
    // usersettings.py's PARTITION_FIELDS spreads MAP_FIELDS, so the two
    // schema arrays carry the same Spice Fields specs) -- spiceFieldSettings
    // reads whichever one matches the currently-selected scope, mirroring
    // userGameFields' own game/partition switch.
    const spiceField = {
      scope: "game", id: "spice_prime_rate_seconds", section: "/Script/DuneSandbox.SpiceHarvestingSystem",
      key: "m_PrimeRateInSeconds", default: "30.000000", type: "number", clientFile: "", category: "Spice Fields",
      description: "Seconds a spice field spends priming before becoming harvestable."
    };
    api.userSettingsSchema.mockResolvedValue({
      engine: [], mapEngine: [], partitionEngine: [], partition: [spiceField],
      game: [spiceField],
      serverCustom: []
    });
    api.userGame.mockImplementation((map: string, partitionId?: string) =>
      Promise.resolve(
        map === "DeepDesert_1" && partitionId === "8"
          ? { stdout: "spice_prime_rate_seconds\t111.000000\n" }
          : { stdout: "spice_prime_rate_seconds\t30.000000\n" }
      )
    );

    renderMapsPanel();
    const modifiers = await screen.findByRole("button", { name: "Expand Interactive Modifiers" });
    await waitFor(() => expect(modifiers).toBeEnabled());
    fireEvent.click(modifiers);

    // The Target selector lives in the Custom Settings tab; the settings
    // grid it drives now lives in the Spice Fields tab (moved there by
    // upstream's own "Improve mobile bases and Spice Field settings" --
    // both tabs share the same userGameName/effectiveUserGamePartitionId
    // state, so a Target picked in one is reflected in the other.
    fireEvent.click(screen.getByRole("tab", { name: "Spice Fields" }));

    // Before selecting a Target, the section shows Global's value.
    expect(await screen.findByDisplayValue("30.000000")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Custom Settings" }));
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "DeepDesert_1::8" } });

    fireEvent.click(screen.getByRole("tab", { name: "Spice Fields" }));

    // After selecting the partition, it reloads to that partition's own value.
    expect(await screen.findByDisplayValue("111.000000")).toBeVisible();
    await waitFor(() => expect(api.userGame).toHaveBeenCalledWith("DeepDesert_1", "8"));

    fireEvent.change(screen.getByDisplayValue("111.000000"), { target: { value: "222.000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.saveUserSettings).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "partition", map: "DeepDesert_1", partitionId: "8", values: { spice_prime_rate_seconds: "222.000000" } })
    ));
  });

  // Regression test for a real Layer 3 audit finding (2026-09-24): the Target
  // selector lives on a different tab than the Spice Fields settings it
  // scopes, so switching it while an operator has an unsaved Spice Fields
  // draft used to silently overwrite that draft -- discarding their edits
  // with zero visibility, since they weren't even looking at that tab.
  it("does not clobber an unsaved Spice Fields draft when the Target is changed from another tab, and re-syncs only once Discard Changes is clicked", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.status.mockResolvedValue({
      maps: { stdout: "" },
      services: { stdout: "8 | DeepDesert_1 | 0 | | server1 | 33001 | 33101 | true | true" },
      readiness: { stdout: "" }
    });
    const spiceField = {
      scope: "game", id: "spice_prime_rate_seconds", section: "/Script/DuneSandbox.SpiceHarvestingSystem",
      key: "m_PrimeRateInSeconds", default: "30.000000", type: "number", clientFile: "", category: "Spice Fields",
      description: "Seconds a spice field spends priming before becoming harvestable."
    };
    api.userSettingsSchema.mockResolvedValue({
      engine: [], mapEngine: [], partitionEngine: [], partition: [spiceField],
      game: [spiceField],
      serverCustom: []
    });
    api.userGame.mockImplementation((map: string, partitionId?: string) =>
      Promise.resolve(
        map === "DeepDesert_1" && partitionId === "8"
          ? { stdout: "spice_prime_rate_seconds\t111.000000\n" }
          : { stdout: "spice_prime_rate_seconds\t30.000000\n" }
      )
    );

    renderMapsPanel();
    const modifiers = await screen.findByRole("button", { name: "Expand Interactive Modifiers" });
    await waitFor(() => expect(modifiers).toBeEnabled());
    fireEvent.click(modifiers);

    fireEvent.click(screen.getByRole("tab", { name: "Spice Fields" }));
    expect(await screen.findByDisplayValue("30.000000")).toBeVisible();

    // Unsaved edit on the Spice Fields tab, made before touching the Target.
    fireEvent.change(screen.getByDisplayValue("30.000000"), { target: { value: "999.000000" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

    const callsBeforeTargetChange = api.userGame.mock.calls.length;

    // Target changed from the *other* tab -- the operator never returns to
    // Spice Fields to see this happen.
    fireEvent.click(screen.getByRole("tab", { name: "Custom Settings" }));
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "DeepDesert_1::8" } });

    // No new fetch fired for Spice Fields -- the reload was skipped because a
    // dirty draft existed, not silently issued and then discarded.
    expect(api.userGame.mock.calls.length).toBe(callsBeforeTargetChange);

    fireEvent.click(screen.getByRole("tab", { name: "Spice Fields" }));

    // The unsaved edit survived the cross-tab Target change.
    expect(screen.getByDisplayValue("999.000000")).toBeVisible();
    // But Save is disabled -- current target is DeepDesert_1/8, this draft is
    // still Global's, and saving now would write it to the wrong scope.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText(/target changed on another tab/i)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Discard Changes" }));

    // Discard Changes closes the loop: it both drops the stale draft and
    // fetches the Target the operator actually has selected now.
    await waitFor(() => expect(api.userGame).toHaveBeenCalledWith("DeepDesert_1", "8"));
    expect(await screen.findByDisplayValue("111.000000")).toBeVisible();
    expect(screen.queryByText(/target changed on another tab/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  // Regression test for a /code-review high finding (2026-09-24): rapidly
  // switching Target A -> B -> C with no unsaved edit in between never trips
  // the dirty-guard, so if the fetch for B resolves *after* the fetch for C
  // (a genuine out-of-order network response), B's stale values could
  // silently overwrite C's already-applied, correct ones.
  it("does not let an out-of-order Spice Fields response overwrite a newer target's already-applied values", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.status.mockResolvedValue({
      maps: { stdout: "" },
      // Two DeepDesert partitions so the Target selector has two real,
      // distinct, non-Global options to switch between without ever
      // revisiting the same key.
      services: { stdout: "8 | DeepDesert_1 | 0 | | server1 | 33001 | 33101 | true | true\n9 | DeepDesert_1 | 1 | | server1 | 33002 | 33102 | true | true" },
      readiness: { stdout: "" }
    });
    const spiceField = {
      scope: "game", id: "spice_prime_rate_seconds", section: "/Script/DuneSandbox.SpiceHarvestingSystem",
      key: "m_PrimeRateInSeconds", default: "30.000000", type: "number", clientFile: "", category: "Spice Fields",
      description: "Seconds a spice field spends priming before becoming harvestable."
    };
    api.userSettingsSchema.mockResolvedValue({
      engine: [], mapEngine: [], partitionEngine: [], partition: [spiceField],
      game: [spiceField],
      serverCustom: []
    });

    // Deferred promises per target, resolved manually by the test in a
    // deliberately out-of-order sequence.
    const pending = new Map<string, { resolve: (value: { stdout: string }) => void }>();
    api.userGame.mockImplementation((map: string, partitionId?: string) => {
      const key = `${map}::${partitionId || ""}`;
      return new Promise((resolve) => { pending.set(key, { resolve }); });
    });

    renderMapsPanel();
    const modifiers = await screen.findByRole("button", { name: "Expand Interactive Modifiers" });
    // Resolve the initial mount-time Global fetch so the app settles before
    // the test's own two target switches begin -- must happen before
    // waiting for the toggle to become enabled, since that itself depends on
    // this same fetch resolving.
    await waitFor(() => expect(pending.has("__global__::")).toBe(true));
    pending.get("__global__::")!.resolve({ stdout: "spice_prime_rate_seconds\t30.000000\n" });
    pending.delete("__global__::");
    await waitFor(() => expect(modifiers).toBeEnabled());
    fireEvent.click(modifiers);

    fireEvent.click(screen.getByRole("tab", { name: "Spice Fields" }));
    expect(await screen.findByDisplayValue("30.000000")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Custom Settings" }));
    // A -> B: select partition 8. Its fetch is issued but deliberately left
    // unresolved.
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "DeepDesert_1::8" } });
    await waitFor(() => expect(pending.has("DeepDesert_1::8")).toBe(true));

    // B -> C: select partition 9 *before* B's fetch has resolved -- no dirty
    // draft exists at any point, so nothing here is gated by the dirty-check.
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "DeepDesert_1::9" } });
    await waitFor(() => expect(pending.has("DeepDesert_1::9")).toBe(true));

    // Resolve in the *wrong* order: C (the current, correct target) first,
    // then the now-stale B request second.
    pending.get("DeepDesert_1::9")!.resolve({ stdout: "spice_prime_rate_seconds\t909.000000\n" });
    fireEvent.click(screen.getByRole("tab", { name: "Spice Fields" }));
    expect(await screen.findByDisplayValue("909.000000")).toBeVisible();

    pending.get("DeepDesert_1::8")!.resolve({ stdout: "spice_prime_rate_seconds\t808.000000\n" });

    // B's late, stale response must be dropped -- C's value stays displayed,
    // not silently overwritten by data that was fetched for a target the
    // operator has since navigated away from.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByDisplayValue("909.000000")).toBeVisible();
    expect(screen.queryByDisplayValue("808.000000")).not.toBeInTheDocument();

    // And it's genuinely ready, not just displaying the right number by
    // coincidence while still flagged stale: an edit now enables Save.
    fireEvent.change(screen.getByDisplayValue("909.000000"), { target: { value: "950.000000" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("shows a distinct explanatory notice instead of the Spice Fields grid when Overmap is selected, and disables its action row", async () => {
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
    api.userGame.mockImplementation((map: string) =>
      Promise.resolve(map === "__global__" ? { stdout: "spice_manager_tick_rate_seconds\t5.000000\n" } : { stdout: "" })
    );

    renderMapsPanel();
    const modifiers = await screen.findByRole("button", { name: "Expand Interactive Modifiers" });
    await waitFor(() => expect(modifiers).toBeEnabled());
    fireEvent.click(modifiers);
    fireEvent.click(screen.getByRole("tab", { name: "Spice Fields" }));
    expect(await screen.findByDisplayValue("5.000000")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Custom Settings" }));
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "Overmap::2" } });
    fireEvent.click(screen.getByRole("tab", { name: "Spice Fields" }));

    expect(await screen.findByText(/doesn.t host spice fields/i)).toBeVisible();
    expect(screen.queryByDisplayValue("5.000000")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard Changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restore Defaults" })).toBeDisabled();
  });

  // Regression test for a /code-review high finding (2026-09-24): Discard
  // Changes used to be disabled whenever Overmap was the selected Target,
  // even when the dirty draft on screen actually belonged to a *different*,
  // previously-selected Target -- trapping the operator with no way to clear
  // it short of navigating to some other non-Overmap target first.
  it("still allows Discard Changes when Overmap is selected but the dirty draft is a stale leftover from a different Target", async () => {
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
    api.userGame.mockImplementation((map: string) =>
      Promise.resolve(map === "__global__" ? { stdout: "spice_manager_tick_rate_seconds\t5.000000\n" } : { stdout: "" })
    );

    renderMapsPanel();
    const modifiers = await screen.findByRole("button", { name: "Expand Interactive Modifiers" });
    await waitFor(() => expect(modifiers).toBeEnabled());
    fireEvent.click(modifiers);
    fireEvent.click(screen.getByRole("tab", { name: "Spice Fields" }));
    expect(await screen.findByDisplayValue("5.000000")).toBeVisible();

    // Unsaved edit while still on Global.
    fireEvent.change(screen.getByDisplayValue("5.000000"), { target: { value: "9.000000" } });
    expect(screen.getByRole("button", { name: "Discard Changes" })).toBeEnabled();

    // Switch straight to Overmap without saving or discarding first.
    fireEvent.click(screen.getByRole("tab", { name: "Custom Settings" }));
    fireEvent.change(screen.getByLabelText("Target"), { target: { value: "Overmap::2" } });
    fireEvent.click(screen.getByRole("tab", { name: "Spice Fields" }));

    expect(await screen.findByText(/doesn.t host spice fields/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Restore Defaults" })).toBeDisabled();
    // The one button that must NOT be stuck disabled -- this is the escape hatch.
    expect(screen.getByRole("button", { name: "Discard Changes" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Discard Changes" }));

    // Clicking it clears the stale draft and doesn't throw/crash navigating
    // into Overmap's own (empty) settings; the row settles back to disabled.
    await waitFor(() => expect(screen.getByRole("button", { name: "Discard Changes" })).toBeDisabled());
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
    // in the dedicated Spice Fields tab's own settings section would use two independent,
    // never-cross-invalidated draft states.
    expect(categoryOptions.some((option) => /Spice Fields/.test(option.textContent || ""))).toBe(false);
  });
});
