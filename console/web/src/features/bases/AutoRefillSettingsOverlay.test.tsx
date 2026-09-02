import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutoRefillSettingsOverlay } from "./AutoRefillSettingsOverlay";
import { basesApi } from "../../api/bases";

vi.mock("../../api/bases", () => ({
  basesApi: { autoRefillSettings: vi.fn(), saveAutoRefillSettings: vi.fn() }
}));

function settingsState(overrides: Record<string, unknown> = {}) {
  return {
    settings: { thresholdPercent: 50, intervalHours: 24, waterThresholdPercent: 50, waterIntervalHours: 24 },
    sources: { thresholdPercent: "default", intervalHours: "default", waterThresholdPercent: "default", waterIntervalHours: "default" },
    defaults: { thresholdPercent: 50, intervalHours: 24, waterThresholdPercent: 50, waterIntervalHours: 24 },
    limits: {
      thresholdPercent: { min: 1, max: 99 },
      intervalHours: { min: 1, max: 168 },
      waterThresholdPercent: { min: 1, max: 99 },
      waterIntervalHours: { min: 1, max: 168 }
    },
    envNames: {
      thresholdPercent: "ADMIN_AUTO_REFILL_THRESHOLD_PERCENT",
      intervalHours: "ADMIN_AUTO_REFILL_INTERVAL_HOURS",
      waterThresholdPercent: "ADMIN_AUTO_REFILL_WATER_THRESHOLD_PERCENT",
      waterIntervalHours: "ADMIN_AUTO_REFILL_WATER_INTERVAL_HOURS"
    },
    ...overrides
  };
}

function renderOverlay() {
  const props = { onClose: vi.fn(), onSaved: vi.fn(), onError: vi.fn() };
  render(<AutoRefillSettingsOverlay {...props} />);
  return props;
}

// The visible label is identical on both sides, so queries go through the
// subsystem-qualified accessible name.
const generatorThreshold = () => screen.getByLabelText("Generators: Queue a refill below (%)");
const generatorInterval = () => screen.getByLabelText("Generators: Check every (h)");
const waterThreshold = () => screen.getByLabelText("Water: Queue a refill below (%)");
const resetGeneratorThreshold = () => screen.getByLabelText("Reset generators queue a refill below");
const fields = () => screen.getAllByRole("spinbutton");

describe("AutoRefillSettingsOverlay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(basesApi.autoRefillSettings).mockResolvedValue(settingsState() as never);
    vi.mocked(basesApi.saveAutoRefillSettings).mockResolvedValue({ ok: true, ...settingsState() } as never);
  });

  it("loads both subsystems' current values", async () => {
    renderOverlay();
    await waitFor(() => expect(fields()).toHaveLength(4));
    expect(screen.getByText("Generators")).toBeInTheDocument();
    expect(screen.getByText("Water")).toBeInTheDocument();
    expect(fields().map((input) => (input as HTMLInputElement).value)).toEqual(["50", "24", "50", "24"]);
  });

  it("sends only edited fields as numbers and leaves the rest reset", async () => {
    const props = renderOverlay();
    await waitFor(() => expect(fields()).toHaveLength(4));
    fireEvent.change(generatorThreshold(), { target: { value: "40" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(vi.mocked(basesApi.saveAutoRefillSettings)).toHaveBeenCalledWith({
      thresholdPercent: 40,
      intervalHours: null,
      waterThresholdPercent: null,
      waterIntervalHours: null
    }));
    expect(props.onSaved).toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
  });

  // The single easiest thing to get wrong. Sending the number here would
  // persist the env value and permanently shadow the env var, so a later change
  // to ADMIN_AUTO_REFILL_* would silently stop taking effect.
  it("sends null, not the number, when a field is reset", async () => {
    vi.mocked(basesApi.autoRefillSettings).mockResolvedValue(settingsState({
      settings: { thresholdPercent: 40, intervalHours: 24, waterThresholdPercent: 50, waterIntervalHours: 24 },
      sources: { thresholdPercent: "console", intervalHours: "default", waterThresholdPercent: "default", waterIntervalHours: "default" }
    }) as never);
    renderOverlay();
    await waitFor(() => expect(generatorThreshold()).toHaveValue(40));

    fireEvent.click(resetGeneratorThreshold());
    expect(generatorThreshold()).toHaveValue(50);
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(vi.mocked(basesApi.saveAutoRefillSettings)).toHaveBeenCalledWith(
      expect.objectContaining({ thresholdPercent: null })
    ));
  });

  it("keeps a console-set value as a number when another field is reset", async () => {
    vi.mocked(basesApi.autoRefillSettings).mockResolvedValue(settingsState({
      settings: { thresholdPercent: 40, intervalHours: 6, waterThresholdPercent: 50, waterIntervalHours: 24 },
      sources: { thresholdPercent: "console", intervalHours: "console", waterThresholdPercent: "default", waterIntervalHours: "default" }
    }) as never);
    renderOverlay();
    await waitFor(() => expect(generatorThreshold()).toHaveValue(40));

    fireEvent.click(resetGeneratorThreshold());
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(vi.mocked(basesApi.saveAutoRefillSettings)).toHaveBeenCalledWith(
      expect.objectContaining({ thresholdPercent: null, intervalHours: 6 })
    ));
  });

  it("Reset is disabled for a field that is not overridden", async () => {
    renderOverlay();
    await waitFor(() => expect(fields()).toHaveLength(4));
    expect(resetGeneratorThreshold()).toBeDisabled();
    fireEvent.change(generatorThreshold(), { target: { value: "40" } });
    expect(resetGeneratorThreshold()).toBeEnabled();
  });

  it("blocks saving an out-of-range or non-numeric value", async () => {
    renderOverlay();
    await waitFor(() => expect(fields()).toHaveLength(4));

    for (const bad of ["0", "100", ""]) {
      fireEvent.change(generatorThreshold(), { target: { value: bad } });
      expect(screen.getByText("Must be a whole number, 1-99.")).toBeInTheDocument();
      expect(screen.getByText("Save")).toBeDisabled();
    }

    fireEvent.change(generatorThreshold(), { target: { value: "40" } });
    expect(screen.queryByText("Must be a whole number, 1-99.")).not.toBeInTheDocument();
    expect(screen.getByText("Save")).toBeEnabled();
    expect(vi.mocked(basesApi.saveAutoRefillSettings)).not.toHaveBeenCalled();
  });

  it("uses each field's own range", async () => {
    renderOverlay();
    await waitFor(() => expect(fields()).toHaveLength(4));
    // 100 is out of range for a percentage but fine for an interval.
    fireEvent.change(generatorInterval(), { target: { value: "100" } });
    expect(screen.queryByText(/Must be a whole number, 1-168\./)).not.toBeInTheDocument();
    expect(screen.getByText("Save")).toBeEnabled();
  });

  it("names the env var when a value comes from the environment", async () => {
    vi.mocked(basesApi.autoRefillSettings).mockResolvedValue(settingsState({
      settings: { thresholdPercent: 50, intervalHours: 12, waterThresholdPercent: 50, waterIntervalHours: 24 },
      sources: { thresholdPercent: "default", intervalHours: "env", waterThresholdPercent: "default", waterIntervalHours: "default" },
      defaults: { thresholdPercent: 50, intervalHours: 12, waterThresholdPercent: 50, waterIntervalHours: 24 }
    }) as never);
    renderOverlay();
    await waitFor(() => expect(screen.getByText(/ADMIN_AUTO_REFILL_INTERVAL_HOURS \(12\)/)).toBeInTheDocument());
  });

  // The settings POST is rate limited where the per-base toggles are not, so a
  // rapid second save can 429. It has to surface, not leave the dialog sitting.
  it("surfaces a save failure and keeps the overlay open", async () => {
    vi.mocked(basesApi.saveAutoRefillSettings).mockRejectedValue(new Error("Too many requests."));
    const props = renderOverlay();
    await waitFor(() => expect(fields()).toHaveLength(4));
    fireEvent.change(generatorThreshold(), { target: { value: "40" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(props.onError).toHaveBeenCalledWith("Too many requests."));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onSaved).not.toHaveBeenCalled();
  });

  it("surfaces a load failure", async () => {
    vi.mocked(basesApi.autoRefillSettings).mockRejectedValue(new Error("Settings could not be read."));
    const props = renderOverlay();
    await waitFor(() => expect(props.onError).toHaveBeenCalledWith("Settings could not be read."));
  });

  it("closes on Escape and on the close button", async () => {
    const props = renderOverlay();
    await waitFor(() => expect(fields()).toHaveLength(4));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  // BasesPanel passes onClose as a new inline arrow every render and re-renders
  // every 10s (usePendingRefills polls on that cadence), so an effect keyed on
  // onClose re-runs and steals focus out of whatever field is being typed in.
  it("keeps focus in the field when the parent re-renders", async () => {
    function Harness() {
      const [tick, setTick] = useState(0);
      return (
        <>
          <button onClick={() => setTick(tick + 1)}>re-render parent</button>
          <AutoRefillSettingsOverlay onClose={() => {}} onSaved={() => {}} onError={() => {}} />
        </>
      );
    }
    render(<Harness />);
    await waitFor(() => expect(fields()).toHaveLength(4));

    generatorThreshold().focus();
    expect(document.activeElement).toBe(generatorThreshold());

    fireEvent.click(screen.getByText("re-render parent"));
    expect(document.activeElement).toBe(generatorThreshold());
  });

  it("warns that the two intervals behave differently in each direction", async () => {
    renderOverlay();
    await waitFor(() => expect(fields()).toHaveLength(4));
    expect(screen.getByText(/A shorter interval pulls the next scan in/)).toBeInTheDocument();
  });

  // The generator and water fields carry the same visible label; without a
  // qualified accessible name a screen-reader user cannot tell which is which.
  it("gives the two subsystems' identical labels distinct accessible names", async () => {
    renderOverlay();
    await waitFor(() => expect(fields()).toHaveLength(4));
    expect(generatorThreshold()).not.toBe(waterThreshold());
    fireEvent.change(waterThreshold(), { target: { value: "30" } });
    expect(generatorThreshold()).toHaveValue(50);
    expect(waterThreshold()).toHaveValue(30);
  });
});
