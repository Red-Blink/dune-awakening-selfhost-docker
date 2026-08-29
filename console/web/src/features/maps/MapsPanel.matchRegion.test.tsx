import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapsApi } from "../../api/maps";
import { setupApi } from "../../api/setup";
import { coriolisFieldMatchesRegionInference, MapsPanel } from "./MapsPanel";

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

const CORIOLIS_CYCLE_START_HOUR_FIELD = {
  scope: "game",
  id: "coriolis_cycle_start_hour",
  section: "/Script/DuneSandbox.CoriolisSubsystem",
  key: "m_CycleStartHour",
  default: "5",
  type: "integer",
  clientFile: "",
  category: "",
  label: "Cycle Start Hour",
  description: "UTC hour (0-23). Regional master schedules: Europe 05, North America 11, South America 08, Asia 09, and Oceania 19.",
  minimum: 0,
  maximum: 23
};

// coriolis_cycle_start_day's schema default ("3") coincides with the region
// value for three of the five regions (Europe, North America, South
// America) -- the exact "value equals default" trap that caused the Cycle
// Start Hour migration to loop forever on Europe before it was fixed. Any
// test here that uses North America must not assume "region day != default"
// the way most of the hour tests safely could with a default of 5.
const CORIOLIS_CYCLE_START_DAY_FIELD = {
  scope: "game",
  id: "coriolis_cycle_start_day",
  section: "/Script/DuneSandbox.CoriolisSubsystem",
  key: "m_CycleStartDay",
  default: "3",
  type: "integer",
  clientFile: "",
  category: "",
  label: "Cycle Start Day",
  description: "UTC calendar day of the month (1-31). Regional master schedule anchor dates: Europe, North America, and South America use day 3; Asia and Oceania use day 2.",
  minimum: 1,
  maximum: 31
};

const BOTH_CORIOLIS_FIELDS = [CORIOLIS_CYCLE_START_HOUR_FIELD, CORIOLIS_CYCLE_START_DAY_FIELD];

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
  // Re-queried inside the waitFor rather than captured before it: the button
  // exists while the panel is still loading, and React can replace the node on
  // the settle re-render instead of mutating it -- a captured reference would
  // then never become enabled.
  await waitFor(() => expect(screen.getByRole("button", { name: "Expand Interactive Modifiers" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Expand Interactive Modifiers" }));
  fireEvent.click(screen.getByRole("tab", { name: "UserGame" }));
  const targetSelect = await screen.findByLabelText("Target");
  fireEvent.change(targetSelect, { target: { value: "__global__::" } });
  await waitFor(() => expect(api.userGame).toHaveBeenCalled());
}

function mockCoriolisFields(api: Record<string, ReturnType<typeof vi.fn>>, values: { hour?: string; day?: string }) {
  const lines = [
    values.hour !== undefined ? `coriolis_cycle_start_hour\t${values.hour}` : "",
    values.day !== undefined ? `coriolis_cycle_start_day\t${values.day}` : ""
  ].filter(Boolean).join("\n");
  api.userGame.mockResolvedValue({ stdout: `${lines}\n`, exitCode: 0 });
}

// Each Coriolis field's Match Region radiogroup is disambiguated by an
// aria-label naming the field ("Match Region for Cycle Start Hour" vs "...
// Day") specifically so more than one can be on screen at once without being
// indistinguishable to assistive tech -- and, incidentally, so these tests
// can scope their queries instead of matching every "On"/"Off" radio on the
// page.
function hourRadiogroup() {
  return screen.getByRole("radiogroup", { name: "Match Region for Cycle Start Hour" });
}
function dayRadiogroup() {
  return screen.getByRole("radiogroup", { name: "Match Region for Cycle Start Day" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("coriolisFieldMatchesRegionInference", () => {
  it("is On when the saved value already matches the region's value", () => {
    expect(coriolisFieldMatchesRegionInference(CORIOLIS_CYCLE_START_HOUR_FIELD as never, "11", 11)).toBe(true);
    expect(coriolisFieldMatchesRegionInference(CORIOLIS_CYCLE_START_DAY_FIELD as never, "2", 2)).toBe(true);
  });
  it("is Off when the saved value is still at the untouched schema default and the default isn't the region's value", () => {
    // The default no longer implies "unset -- go ahead and lock it": a scope this
    // young gets the region's value written once, server-side, before the frontend
    // ever sees it (migrate_coriolis_region_fields in usersettings.py). By the time
    // this runs, a saved default on a region whose value differs is either a genuine
    // manual choice or a deployment the migration hasn't reached yet -- either way,
    // not this toggle's call to silently overwrite.
    expect(coriolisFieldMatchesRegionInference(CORIOLIS_CYCLE_START_HOUR_FIELD as never, "5", 11)).toBe(false);
    expect(coriolisFieldMatchesRegionInference(CORIOLIS_CYCLE_START_DAY_FIELD as never, "3", 2)).toBe(false);
  });
  it("is On when the default happens to equal the region's value", () => {
    expect(coriolisFieldMatchesRegionInference(CORIOLIS_CYCLE_START_HOUR_FIELD as never, "5", 5)).toBe(true);
    expect(coriolisFieldMatchesRegionInference(CORIOLIS_CYCLE_START_DAY_FIELD as never, "3", 3)).toBe(true);
  });
  it("is Off for a deliberate manual value that differs from the region's value", () => {
    expect(coriolisFieldMatchesRegionInference(CORIOLIS_CYCLE_START_HOUR_FIELD as never, "14", 11)).toBe(false);
    expect(coriolisFieldMatchesRegionInference(CORIOLIS_CYCLE_START_DAY_FIELD as never, "7", 2)).toBe(false);
  });
  it("is Off when the region has no defined master value", () => {
    expect(coriolisFieldMatchesRegionInference(CORIOLIS_CYCLE_START_HOUR_FIELD as never, "11", undefined)).toBe(false);
    expect(coriolisFieldMatchesRegionInference(CORIOLIS_CYCLE_START_DAY_FIELD as never, "3", undefined)).toBe(false);
  });
});

describe("MapsPanel Match Region toggle -- Cycle Start Hour", () => {
  it("locks the field when the saved value already matches the region's hour", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.userSettingsSchema.mockResolvedValue({ engine: [], mapEngine: [], partitionEngine: [], partition: [], game: BOTH_CORIOLIS_FIELDS });
    mockCoriolisFields(api, { hour: "11", day: "7" });
    (setupApi.state as ReturnType<typeof vi.fn>).mockResolvedValue({ files: {}, config: {}, serverConfig: { SERVER_REGION: "North America" } });

    await openUserGameGlobalTab(api);

    const hourInput = await screen.findByDisplayValue("11");
    expect(hourInput).toBeDisabled();
    expect(within(hourRadiogroup()).getByRole("radio", { name: "On" })).toBeChecked();
    // Migration is server-side only (see server.js's migrateCoriolisRegionFields)
    // -- merely opening this tab must never issue a write of its own.
    expect(api.saveUserSettings).not.toHaveBeenCalled();
  });

  it("leaves an untouched (still-default) hour editable rather than locking or saving it", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.userSettingsSchema.mockResolvedValue({ engine: [], mapEngine: [], partitionEngine: [], partition: [], game: BOTH_CORIOLIS_FIELDS });
    mockCoriolisFields(api, { hour: "5", day: "7" });
    (setupApi.state as ReturnType<typeof vi.fn>).mockResolvedValue({ files: {}, config: {}, serverConfig: { SERVER_REGION: "North America" } });

    await openUserGameGlobalTab(api);

    const hourInput = await screen.findByDisplayValue("5");
    expect(hourInput).toBeEnabled();
    expect(within(hourRadiogroup()).getByRole("radio", { name: "Off" })).toBeChecked();
    expect(api.saveUserSettings).not.toHaveBeenCalled();
  });

  it("leaves an existing custom hour editable and does not overwrite it", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.userSettingsSchema.mockResolvedValue({ engine: [], mapEngine: [], partitionEngine: [], partition: [], game: BOTH_CORIOLIS_FIELDS });
    mockCoriolisFields(api, { hour: "14", day: "7" });
    (setupApi.state as ReturnType<typeof vi.fn>).mockResolvedValue({ files: {}, config: {}, serverConfig: { SERVER_REGION: "North America" } });

    await openUserGameGlobalTab(api);

    const hourInput = await screen.findByDisplayValue("14");
    expect(hourInput).toBeEnabled();
    expect(within(hourRadiogroup()).getByRole("radio", { name: "Off" })).toBeChecked();
    expect(api.saveUserSettings).not.toHaveBeenCalled();
  });

  it("switches to manual editing when the toggle is turned Off", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.userSettingsSchema.mockResolvedValue({ engine: [], mapEngine: [], partitionEngine: [], partition: [], game: BOTH_CORIOLIS_FIELDS });
    mockCoriolisFields(api, { hour: "11", day: "7" });
    (setupApi.state as ReturnType<typeof vi.fn>).mockResolvedValue({ files: {}, config: {}, serverConfig: { SERVER_REGION: "North America" } });

    await openUserGameGlobalTab(api);
    await screen.findByDisplayValue("11");

    fireEvent.click(within(hourRadiogroup()).getByRole("radio", { name: "Off" }));

    const hourInput = await screen.findByDisplayValue("11");
    expect(hourInput).toBeEnabled();
  });

  it("pins the draft to the region's hour (without saving) when the toggle is turned On", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.userSettingsSchema.mockResolvedValue({ engine: [], mapEngine: [], partitionEngine: [], partition: [], game: BOTH_CORIOLIS_FIELDS });
    mockCoriolisFields(api, { hour: "14", day: "7" });
    (setupApi.state as ReturnType<typeof vi.fn>).mockResolvedValue({ files: {}, config: {}, serverConfig: { SERVER_REGION: "North America" } });

    await openUserGameGlobalTab(api);
    await screen.findByDisplayValue("14");

    fireEvent.click(within(hourRadiogroup()).getByRole("radio", { name: "On" }));

    const hourInput = await screen.findByDisplayValue("11");
    expect(hourInput).toBeDisabled();
    expect(api.saveUserSettings).not.toHaveBeenCalled();
  });
});

describe("MapsPanel Match Region toggle -- Cycle Start Day", () => {
  it("locks the field when the saved value already matches the region's day", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.userSettingsSchema.mockResolvedValue({ engine: [], mapEngine: [], partitionEngine: [], partition: [], game: BOTH_CORIOLIS_FIELDS });
    // Asia's region day is 2 -- distinct from the schema default (3), so a
    // saved 2 is unambiguously "matches region", not "still untouched".
    mockCoriolisFields(api, { hour: "20", day: "2" });
    (setupApi.state as ReturnType<typeof vi.fn>).mockResolvedValue({ files: {}, config: {}, serverConfig: { SERVER_REGION: "Asia" } });

    await openUserGameGlobalTab(api);

    const dayInput = await screen.findByDisplayValue("2");
    expect(dayInput).toBeDisabled();
    expect(within(dayRadiogroup()).getByRole("radio", { name: "On" })).toBeChecked();
    expect(api.saveUserSettings).not.toHaveBeenCalled();
  });

  it("locks the field when the saved value equals both the schema default and the region's day", async () => {
    // North America's region day is 3 -- the exact schema default. Whether a
    // saved value happens to equal the default is irrelevant to the inference;
    // it only asks "does the saved value equal the region's value", the same
    // question migrate_coriolis_region_fields's presence-based migration
    // answers server-side. A value-vs-default comparison would have been unable
    // to tell this apart from "untouched" and either locked it for the wrong
    // reason or (in the old client-side auto-save this replaced) looped trying
    // to re-migrate it -- this pins that the fix reads as "matches", not as
    // "ambiguous", once the value is actually equal.
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.userSettingsSchema.mockResolvedValue({ engine: [], mapEngine: [], partitionEngine: [], partition: [], game: BOTH_CORIOLIS_FIELDS });
    mockCoriolisFields(api, { hour: "20", day: "3" });
    (setupApi.state as ReturnType<typeof vi.fn>).mockResolvedValue({ files: {}, config: {}, serverConfig: { SERVER_REGION: "North America" } });

    await openUserGameGlobalTab(api);

    const dayInput = await screen.findByDisplayValue("3");
    expect(dayInput).toBeDisabled();
    expect(within(dayRadiogroup()).getByRole("radio", { name: "On" })).toBeChecked();
    expect(api.saveUserSettings).not.toHaveBeenCalled();
  });

  it("leaves an untouched (still-default) day editable when the region's day differs from that default", async () => {
    // Asia's region day is 2, distinct from the schema default (3). A saved 3
    // here is genuinely ambiguous -- untouched, or a deliberate match to a
    // *different* region's schedule -- and must not be silently claimed as
    // "matches region" or locked. This is the direct counterpart to the
    // existing untouched-hour test (South America's region hour, 8, differs
    // from the hour default, 5).
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.userSettingsSchema.mockResolvedValue({ engine: [], mapEngine: [], partitionEngine: [], partition: [], game: BOTH_CORIOLIS_FIELDS });
    mockCoriolisFields(api, { hour: "20", day: "3" });
    (setupApi.state as ReturnType<typeof vi.fn>).mockResolvedValue({ files: {}, config: {}, serverConfig: { SERVER_REGION: "Asia" } });

    await openUserGameGlobalTab(api);

    const dayInput = await screen.findByDisplayValue("3");
    expect(dayInput).toBeEnabled();
    expect(within(dayRadiogroup()).getByRole("radio", { name: "Off" })).toBeChecked();
    expect(api.saveUserSettings).not.toHaveBeenCalled();
  });

  it("leaves an existing custom day editable and does not overwrite it", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.userSettingsSchema.mockResolvedValue({ engine: [], mapEngine: [], partitionEngine: [], partition: [], game: BOTH_CORIOLIS_FIELDS });
    mockCoriolisFields(api, { hour: "20", day: "6" });
    (setupApi.state as ReturnType<typeof vi.fn>).mockResolvedValue({ files: {}, config: {}, serverConfig: { SERVER_REGION: "North America" } });

    await openUserGameGlobalTab(api);

    const dayInput = await screen.findByDisplayValue("6");
    expect(dayInput).toBeEnabled();
    expect(within(dayRadiogroup()).getByRole("radio", { name: "Off" })).toBeChecked();
    expect(api.saveUserSettings).not.toHaveBeenCalled();
  });

  it("switches to manual editing when the toggle is turned Off", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.userSettingsSchema.mockResolvedValue({ engine: [], mapEngine: [], partitionEngine: [], partition: [], game: BOTH_CORIOLIS_FIELDS });
    mockCoriolisFields(api, { hour: "20", day: "2" });
    (setupApi.state as ReturnType<typeof vi.fn>).mockResolvedValue({ files: {}, config: {}, serverConfig: { SERVER_REGION: "Asia" } });

    await openUserGameGlobalTab(api);
    await screen.findByDisplayValue("2");

    fireEvent.click(within(dayRadiogroup()).getByRole("radio", { name: "Off" }));

    const dayInput = await screen.findByDisplayValue("2");
    expect(dayInput).toBeEnabled();
  });

  it("pins the draft to the region's day (without saving) when the toggle is turned On", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.userSettingsSchema.mockResolvedValue({ engine: [], mapEngine: [], partitionEngine: [], partition: [], game: BOTH_CORIOLIS_FIELDS });
    mockCoriolisFields(api, { hour: "20", day: "6" });
    (setupApi.state as ReturnType<typeof vi.fn>).mockResolvedValue({ files: {}, config: {}, serverConfig: { SERVER_REGION: "Asia" } });

    await openUserGameGlobalTab(api);
    await screen.findByDisplayValue("6");

    fireEvent.click(within(dayRadiogroup()).getByRole("radio", { name: "On" }));

    const dayInput = await screen.findByDisplayValue("2");
    expect(dayInput).toBeDisabled();
    expect(api.saveUserSettings).not.toHaveBeenCalled();
  });
});

describe("MapsPanel Match Region -- Hour and Day toggles are independent", () => {
  it("locks one field while leaving the other editable, and toggling one does not affect the other", async () => {
    const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
    api.userSettingsSchema.mockResolvedValue({ engine: [], mapEngine: [], partitionEngine: [], partition: [], game: BOTH_CORIOLIS_FIELDS });
    // North America: hour 11 matches (locked); day 6 is a deliberate custom
    // value that does not match North America's 3 (editable).
    mockCoriolisFields(api, { hour: "11", day: "6" });
    (setupApi.state as ReturnType<typeof vi.fn>).mockResolvedValue({ files: {}, config: {}, serverConfig: { SERVER_REGION: "North America" } });

    await openUserGameGlobalTab(api);
    await screen.findByDisplayValue("11");

    const hourInput = screen.getByDisplayValue("11");
    const dayInput = screen.getByDisplayValue("6");
    expect(hourInput).toBeDisabled();
    expect(dayInput).toBeEnabled();
    expect(within(hourRadiogroup()).getByRole("radio", { name: "On" })).toBeChecked();
    expect(within(dayRadiogroup()).getByRole("radio", { name: "Off" })).toBeChecked();

    // Turning the day toggle On pins the day draft to North America's day (3)
    // and must not touch the hour field's own locked value or state at all.
    fireEvent.click(within(dayRadiogroup()).getByRole("radio", { name: "On" }));

    await waitFor(() => expect(screen.getByDisplayValue("3")).toBeDisabled());
    expect(within(hourRadiogroup()).getByRole("radio", { name: "On" })).toBeChecked();
    expect(screen.getByDisplayValue("11")).toBeDisabled();
    expect(api.saveUserSettings).not.toHaveBeenCalled();
  });
});
