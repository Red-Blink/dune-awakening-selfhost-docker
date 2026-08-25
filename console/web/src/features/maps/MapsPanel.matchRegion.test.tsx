import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapsApi } from "../../api/maps";
import { setupApi } from "../../api/setup";
import { coriolisHourMatchesRegionInference, MapsPanel } from "./MapsPanel";

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
  pendingRefillCountForMap: () => 0,
  pendingRefillCountForPartition: () => 0
}));

const CORIOLIS_CYCLE_START_HOUR_FIELD = {
  scope: "game",
  id: "coriolis_cycle_start_hour",
  section: "/Script/DuneSandbox.CoriolisSubsystem",
  key: "m_CycleStartHour",
  default: "5",
  type: "integer",
  clientFile: "",
  category: "",
  description: "UTC hour (0-23). Regional master schedules: Europe 05, North America 11, South America 08, Asia 09, and Oceania 19.",
  minimum: 0,
  maximum: 23
};

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

async function openUserGameGlobalTab(api: Record<string, ReturnType<typeof vi.fn>>) {
  renderMapsPanel();
  const modifiers = await screen.findByRole("button", { name: "Expand Interactive Modifiers" });
  await waitFor(() => expect(modifiers).toBeEnabled());
  fireEvent.click(modifiers);
  fireEvent.click(screen.getByRole("tab", { name: "UserGame" }));
  const targetSelect = await screen.findByLabelText("Target");
  fireEvent.change(targetSelect, { target: { value: "__global__::" } });
  await waitFor(() => expect(api.userGame).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("coriolisHourMatchesRegionInference", () => {
  it("is On when the saved value is still at the schema default", () => {
    expect(coriolisHourMatchesRegionInference(CORIOLIS_CYCLE_START_HOUR_FIELD as never, "5", 11)).toBe(true);
  });
  it("is On when the saved value already matches the region's hour", () => {
    expect(coriolisHourMatchesRegionInference(CORIOLIS_CYCLE_START_HOUR_FIELD as never, "11", 11)).toBe(true);
  });
  it("is Off for a deliberate manual value that differs from both", () => {
    expect(coriolisHourMatchesRegionInference(CORIOLIS_CYCLE_START_HOUR_FIELD as never, "14", 11)).toBe(false);
  });
  it("is Off when the region has no defined master hour", () => {
    expect(coriolisHourMatchesRegionInference(CORIOLIS_CYCLE_START_HOUR_FIELD as never, "5", undefined)).toBe(false);
  });
});

describe("MapsPanel Match Region toggle", () => {
  it("locks the field to the region's hour when the saved value is untouched", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.userSettingsSchema.mockResolvedValue({
      engine: [], mapEngine: [], partitionEngine: [], partition: [],
      game: [CORIOLIS_CYCLE_START_HOUR_FIELD]
    });
    api.userGame.mockResolvedValue({ stdout: "coriolis_cycle_start_hour\t5\n", exitCode: 0 });
    (setupApi.state as ReturnType<typeof vi.fn>).mockResolvedValue({
      files: {}, config: {}, serverConfig: { SERVER_REGION: "North America" }
    });

    await openUserGameGlobalTab(api);

    const hourInput = await screen.findByDisplayValue("11");
    expect(hourInput).toBeDisabled();
    expect(screen.getByRole("radio", { name: "On" })).toBeChecked();
  });

  it("leaves an existing custom hour editable and does not overwrite it", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.userSettingsSchema.mockResolvedValue({
      engine: [], mapEngine: [], partitionEngine: [], partition: [],
      game: [CORIOLIS_CYCLE_START_HOUR_FIELD]
    });
    api.userGame.mockResolvedValue({ stdout: "coriolis_cycle_start_hour\t14\n", exitCode: 0 });
    (setupApi.state as ReturnType<typeof vi.fn>).mockResolvedValue({
      files: {}, config: {}, serverConfig: { SERVER_REGION: "North America" }
    });

    await openUserGameGlobalTab(api);

    const hourInput = await screen.findByDisplayValue("14");
    expect(hourInput).toBeEnabled();
    expect(screen.getByRole("radio", { name: "Off" })).toBeChecked();
  });

  it("switches to manual editing when the toggle is turned Off", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.userSettingsSchema.mockResolvedValue({
      engine: [], mapEngine: [], partitionEngine: [], partition: [],
      game: [CORIOLIS_CYCLE_START_HOUR_FIELD]
    });
    api.userGame.mockResolvedValue({ stdout: "coriolis_cycle_start_hour\t5\n", exitCode: 0 });
    (setupApi.state as ReturnType<typeof vi.fn>).mockResolvedValue({
      files: {}, config: {}, serverConfig: { SERVER_REGION: "North America" }
    });

    await openUserGameGlobalTab(api);
    await screen.findByDisplayValue("11");

    fireEvent.click(screen.getByRole("radio", { name: "Off" }));

    const hourInput = await screen.findByDisplayValue("11");
    expect(hourInput).toBeEnabled();
  });
});
