import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    permissions: { pending: null, refresh: () => {} }
  }),
  pendingRefillCountForMap: () => 0,
  pendingRefillCountForPartition: () => 0,
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
});
