import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mapsApi } from "../../api/maps";
import { MapsPanel } from "./MapsPanel";
import { cachedInstanceNames, invalidateInstanceNames, resolveInstanceNames } from "./instanceNames";

// The first full MapsPanel mount in the suite. It exists because the bug it
// covers is invisible from the pure helpers: sietchWriteGuard.test.ts asserted
// the fallback draft survived and passed, while the panel was discarding it in
// loadSietches' post-save refresh.

// Auto-stubs every mapsApi method on first access. The default has to resolve
// something shaped permissively: the panel's mount fans out to a dozen
// endpoints with different response shapes (command output, {rows},
// {placements}), and a method returning undefined takes the whole render down.
vi.mock("../../api/maps", () => ({
  mapsApi: new Proxy({} as Record<string, unknown>, {
    get: (target, prop: string) => {
      if (!target[prop]) {
        target[prop] = vi.fn().mockResolvedValue({
          stdout: "", exitCode: 0,
          rows: [], placements: [], tradeCenters: [], partitions: [], fields: [],
          // The settings schema is read as `schema ? schema.partition : ...`, so
          // a truthy object without these throws during render rather than
          // falling back.
          partition: [], game: [], engine: [], global: [],
          capabilities: {}, values: {}, sampledAt: ""
        });
      }
      return target[prop];
    }
  })
}));
vi.mock("../../api/setup", () => ({ setupApi: new Proxy({} as Record<string, unknown>, {
  get: (target, prop: string) => {
    if (!target[prop]) target[prop] = vi.fn().mockResolvedValue({});
    return target[prop];
  }
}) }));
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

// Real `dune sietches dimensions Survival_1` output. The --ids output is one
// line short, so dimension 2 falls back to its dimension index and becomes an
// unwritable row -- the case the write guard refuses and this test protects.
const TABLE = [
  "DIMENSION  DISPLAY NAME                     PASSWORD",
  "0          Hagga Basin                      (unset)",
  "1          Sietch Abbir                     (set)",
  "2          The Kulon Show                   (unset)"
].join("\n");
const PARTIAL_IDS = "1\n31\n";

const MAPS_JSON = JSON.stringify({
  maps: [{ map: "Survival_1", status: "Ready", mode: "Core Map", memory: "12 GB", partitionId: "" }]
});

function stubMapsApi() {
  const api = mapsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;
  // Only the endpoints this test actually depends on; everything else keeps the
  // permissive auto-stub above.
  api.status.mockResolvedValue({
    maps: { stdout: MAPS_JSON },
    services: { stdout: "" },
    readiness: { stdout: "" }
  });
  api.sietchDimensions.mockImplementation((_map?: string, ids?: boolean) =>
    Promise.resolve({ stdout: ids ? PARTIAL_IDS : TABLE, exitCode: 0 }));
  api.updateSietches.mockResolvedValue({ task: { id: "task-1", status: "succeeded" } });
  return api;
}

function renderMapsPanel() {
  const props = {
    onError: vi.fn(),
    confirmAction: vi.fn().mockResolvedValue(true),
    confirmSettingsRestart: vi.fn().mockResolvedValue("immediate"),
    // A prop, so no task polling is needed -- the sequence settles at once.
    waitForTaskWithUpdates: vi.fn().mockImplementation((task: { id: string }) =>
      Promise.resolve({ ...task, status: "succeeded" })),
    taskTechnicalDetails: vi.fn().mockReturnValue(""),
    restartGate: vi.fn().mockResolvedValue("immediate")
  };
  render(<MapsPanel {...props} />);
  return props;
}

// Each sietch renders a child row; its Edit button opens the inline panel that
// holds that row's Name input and Save button.
function sietchRow(partitionId: string) {
  const meta = [...document.querySelectorAll(".sietch-child-meta")]
    .find((node) => node.textContent?.startsWith(`Partition ${partitionId} /`));
  return meta?.closest("tr") as HTMLElement;
}

async function openSietch(partitionId: string) {
  const row = await waitFor(() => {
    const found = sietchRow(partitionId);
    expect(found).toBeTruthy();
    return found;
  });
  fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
}

function nameInput() {
  const label = [...document.querySelectorAll(".inline-edit-panel label")]
    .find((node) => node.textContent?.startsWith("Name"));
  return label?.querySelector("input") as HTMLInputElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateInstanceNames();
});

describe("MapsPanel sietch drafts", () => {
  it("keeps a fallback row's pending edit when another sietch is saved", async () => {
    const api = stubMapsApi();
    renderMapsPanel();

    // Partition "2" fell back to its dimension index, so the guard will refuse
    // to write it. Leave an edit pending on it.
    await openSietch("2");
    fireEvent.change(nameInput(), { target: { value: "Renamed Fallback" } });
    expect(nameInput().value).toBe("Renamed Fallback");

    // Now edit and save the verified row. Opening it closes the panel above,
    // but the draft lives in panel state, not in the panel body.
    await openSietch("31");
    fireEvent.change(nameInput(), { target: { value: "Renamed Verified" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Sietch Settings" }));

    await waitFor(() => expect(api.updateSietches).toHaveBeenCalled());

    // Only the verified partition is written -- never the fallback one, whose
    // id would land on whatever partition happens to share that number.
    const written = api.updateSietches.mock.calls.map(([body]) => body.partitionId);
    expect(written).toEqual(["31"]);
    expect(written).not.toContain("2");

    // The refresh at the end of the save reloads every row. The fallback edit
    // must still be pending afterwards, because nothing else will tell the
    // operator it was dropped.
    await waitFor(() => expect(api.sietchDimensions.mock.calls.length).toBeGreaterThan(2));
    await openSietch("2");
    await waitFor(() => expect(nameInput().value).toBe("Renamed Fallback"));
  });

  it("keeps every pending edit when the save fails", async () => {
    const api = stubMapsApi();
    const props = renderMapsPanel();
    // The sequence runs the action, then reports the task as failed.
    props.waitForTaskWithUpdates.mockImplementation((task: { id: string }) =>
      Promise.resolve({ ...task, status: "failed", errorMessage: "boom" }));

    await openSietch("2");
    fireEvent.change(nameInput(), { target: { value: "Renamed Fallback" } });

    await openSietch("31");
    fireEvent.change(nameInput(), { target: { value: "Renamed Verified" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Sietch Settings" }));

    await waitFor(() => expect(api.updateSietches).toHaveBeenCalled());
    await waitFor(() => expect(api.sietchDimensions.mock.calls.length).toBeGreaterThan(2));

    // A failed save must not take the edits with it -- they are what the
    // operator needs in order to retry.
    await waitFor(() => expect(nameInput().value).toBe("Renamed Verified"));
    await openSietch("2");
    await waitFor(() => expect(nameInput().value).toBe("Renamed Fallback"));
  });

  it("invalidates names again after an accepted sietch write finishes", async () => {
    stubMapsApi();
    const props = renderMapsPanel();
    let finishTask!: () => void;
    const taskCompletion = new Promise<void>((resolve) => { finishTask = resolve; });
    props.waitForTaskWithUpdates.mockImplementation(async (task: { id: string }) => {
      // Simulate the Bases tab resolving the old name after the API accepted
      // the write but before the background task actually changed it.
      await resolveInstanceNames(["Survival_1"]);
      await taskCompletion;
      return { ...task, status: "succeeded" };
    });

    await openSietch("31");
    fireEvent.change(nameInput(), { target: { value: "Renamed Verified" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Sietch Settings" }));

    await waitFor(() => expect(cachedInstanceNames(["Survival_1"])).not.toBeNull());
    finishTask();
    await waitFor(() => expect(cachedInstanceNames(["Survival_1"])).toBeNull());
  });
});
