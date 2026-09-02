import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Task } from "../../api/setup";
import { liveMapApi } from "../../api/liveMap";
import { LiveMapPanel, mergeLiveMapRows } from "./LiveMapPanel";

function fakeTask(status: Task["status"]): Task {
  return {
    id: "t1",
    type: "map",
    operation: "teleport-player",
    status,
    currentStep: "",
    progressMessage: "",
    logLines: [],
    warnings: [],
    startedAt: "2026-08-24T00:00:00.000Z",
    finishedAt: null,
    errorMessage: null
  };
}

// The real component needs WebGL2, which jsdom has not got, so it would always
// fall back. `ready` is controllable because the panel now keeps the flat image
// up until the canvas reports it has something to paint.
const terrain = vi.hoisted(() => ({ signalsReady: true }));
vi.mock("./terrain/DeepDesertTerrain", () => ({
  default: ({ onReady }: { onReady?: () => void }) => {
    useEffect(() => {
      if (terrain.signalsReady) onReady?.();
    }, [onReady]);
    return <canvas className="live-map-terrain" />;
  }
}));

vi.mock("../../api/liveMap", () => ({
  liveMapApi: {
    markers: vi.fn(),
    teleportPlayer: vi.fn()
  }
}));

const map = {
  key: "HaggaBasin",
  label: "Hagga Basin",
  actorMap: "HaggaBasin",
  image: "",
  width: 1000,
  height: 1000,
  minX: 0,
  maxX: 1000,
  minY: 0,
  maxY: 1000,
  flipY: false,
  defaultPartitionId: 1
};

beforeEach(() => {
  vi.clearAllMocks();
  terrain.signalsReady = true;
  vi.mocked(liveMapApi.markers).mockResolvedValue({
    rows: [
      { id: 31573, type: "base", name: "Desert Home", base_type: "Sub-Fief", owner_name: "Chani", map: "HaggaBasin", partition_id: 1, x: 500, y: 500, z: 20 },
      { id: 31574, type: "base", name: "Second Base", base_type: "Sub-Fief", owner_name: "Paul", map: "HaggaBasin", partition_id: 1, x: 600, y: 600, z: 20 },
      { id: 500, type: "player", name: "Liet", online_status: "online", map: "HaggaBasin", partition_id: 1, x: 10, y: 10 },
      { id: 501, type: "player", name: "Duncan", online_status: "offline", map: "HaggaBasin", partition_id: 1, x: 20, y: 20 },
      { id: 502, type: "player", name: "Farok", online_status: "online", map: "HaggaBasin", partition_id: 2, x: 30, y: 30 },
      { id: 700, type: "spice_active", name: "Active Small Spice", map: "HaggaBasin", x: 300, y: 300 },
      { id: 800, type: "house_representative", name: "HouseRepresentativeVernius", map: "HaggaBasin", partition_id: 1, x: 400, y: 400 },
      { id: 801, type: "trainer", name: "TrainerBeneGesserit", map: "HaggaBasin", partition_id: 1, x: 450, y: 450 },
      { id: 900, type: "vehicle", name: "BP_Sandbike_CHOAM_C", owner_name: "Stilgar", map: "HaggaBasin", partition_id: 1, x: 700, y: 700, z: 10 }
    ],
    overlays: {},
    capabilities: { bases: true },
    map,
    maps: { HaggaBasin: map },
    defaultMap: "HaggaBasin",
    partitions: [{ map: "HaggaBasin", partition_id: 1, name: "Sietch New", marker_count: 4 }]
  });
});

it("retains static markers during live-only refreshes without carrying them across maps", () => {
  const previous = [
    { id: "ore-1", type: "ore" as const, map: "HaggaBasin", x: 1, y: 1 },
    { id: "ore-2", type: "ore" as const, map: "DeepDesert", x: 2, y: 2 },
    { id: "player-old", type: "player" as const, map: "HaggaBasin", x: 3, y: 3 }
  ];
  const incoming = [{ id: "player-new", type: "player" as const, map: "HaggaBasin", x: 4, y: 4 }];
  expect(mergeLiveMapRows(previous, incoming, false, "HaggaBasin").map((row) => row.id)).toEqual(["ore-1", "player-new"]);
  expect(mergeLiveMapRows(previous, incoming, true, "HaggaBasin")).toEqual(incoming);
});

it("opens an overlay on the picked point, with its coordinates and a teleport action", async () => {
  const { container } = render(<LiveMapPanel
    onError={vi.fn()}
    confirmAction={vi.fn().mockResolvedValue(true)}
    waitForTask={vi.fn()}
    taskTechnicalDetails={vi.fn().mockReturnValue("")}
    onOpenBase={vi.fn()}
    onOpenVehicle={vi.fn()}
  />);

  await screen.findByRole("button", { name: "Base: Desert Home" });
  expect(container.querySelector(".live-map-target")).toBeNull();

  const frame = container.querySelector(".live-map-frame");
  fireEvent.doubleClick(frame!, { clientX: 100, clientY: 100 });

  // The same overlay a marker gets, not a readout in the sidebar.
  const overlay = screen.getByRole("dialog", { name: "Picked location" });
  expect(overlay).toBeInTheDocument();
  expect(overlay.textContent).toContain("Picked Location");
  expect(overlay.querySelector(".live-map-marker-overlay-facts")?.textContent).toContain("X");
  expect(screen.getByRole("button", { name: "Teleport" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog", { name: "Picked location" })).toBeNull();
  expect(container.querySelector(".live-map-target")).toBeNull();
});

it("shows a base owner and opens that exact base from the marker drawer", async () => {
  const onOpenBase = vi.fn();
  render(<LiveMapPanel
    onError={vi.fn()}
    confirmAction={vi.fn().mockResolvedValue(true)}
    waitForTask={vi.fn()}
    taskTechnicalDetails={vi.fn().mockReturnValue("")}
    onOpenBase={onOpenBase}
    onOpenVehicle={vi.fn()}
  />);

  fireEvent.click(await screen.findByRole("button", { name: "Base: Desert Home" }));
  expect(screen.getByText("Sub-Fief")).toBeInTheDocument();
  expect(screen.getByText("Owner")).toBeInTheDocument();
  expect(screen.getByText("Chani")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open in Bases" }));
  await waitFor(() => expect(onOpenBase).toHaveBeenCalledWith("31573"));
});

it("hovering a marker previews the overlay, and leaving without clicking closes it", async () => {
  render(<LiveMapPanel
    onError={vi.fn()}
    confirmAction={vi.fn().mockResolvedValue(true)}
    waitForTask={vi.fn()}
    taskTechnicalDetails={vi.fn().mockReturnValue("")}
    onOpenBase={vi.fn()}
    onOpenVehicle={vi.fn()}
  />);

  const marker = await screen.findByRole("button", { name: "Base: Desert Home" });
  expect(screen.queryByText("Chani")).not.toBeInTheDocument();

  fireEvent.mouseEnter(marker);
  expect(screen.getByText("Chani")).toBeInTheDocument();

  fireEvent.mouseLeave(marker);
  expect(screen.queryByText("Chani")).not.toBeInTheDocument();
});

it("clicking pins the overlay open even after the mouse leaves, until a click lands outside every marker", async () => {
  render(<LiveMapPanel
    onError={vi.fn()}
    confirmAction={vi.fn().mockResolvedValue(true)}
    waitForTask={vi.fn()}
    taskTechnicalDetails={vi.fn().mockReturnValue("")}
    onOpenBase={vi.fn()}
    onOpenVehicle={vi.fn()}
  />);

  const marker = await screen.findByRole("button", { name: "Base: Desert Home" });
  fireEvent.click(marker);
  fireEvent.mouseLeave(marker);
  expect(screen.getByText("Chani")).toBeInTheDocument();

  fireEvent.mouseDown(document.body);
  expect(screen.queryByText("Chani")).not.toBeInTheDocument();
});

it("the overlay's own close button unpins it without the outside-click needing to fire", async () => {
  render(<LiveMapPanel
    onError={vi.fn()}
    confirmAction={vi.fn().mockResolvedValue(true)}
    waitForTask={vi.fn()}
    taskTechnicalDetails={vi.fn().mockReturnValue("")}
    onOpenBase={vi.fn()}
    onOpenVehicle={vi.fn()}
  />);

  const marker = await screen.findByRole("button", { name: "Base: Desert Home" });
  fireEvent.click(marker);
  expect(screen.getByText("Chani")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByText("Chani")).not.toBeInTheDocument();
});

it("clicking a second marker while one is pinned re-pins to the new marker instead of stacking both", async () => {
  render(<LiveMapPanel
    onError={vi.fn()}
    confirmAction={vi.fn().mockResolvedValue(true)}
    waitForTask={vi.fn()}
    taskTechnicalDetails={vi.fn().mockReturnValue("")}
    onOpenBase={vi.fn()}
    onOpenVehicle={vi.fn()}
  />);

  fireEvent.click(await screen.findByRole("button", { name: "Base: Desert Home" }));
  expect(screen.getByText("Chani")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Base: Second Base" }));
  expect(screen.queryByText("Chani")).not.toBeInTheDocument();
  expect(screen.getByText("Paul")).toBeInTheDocument();
});

it("the Teleport picker only lists online players on the marker's own map and partition", async () => {
  render(<LiveMapPanel
    onError={vi.fn()}
    confirmAction={vi.fn().mockResolvedValue(true)}
    waitForTask={vi.fn()}
    taskTechnicalDetails={vi.fn().mockReturnValue("")}
    onOpenBase={vi.fn()}
    onOpenVehicle={vi.fn()}
  />);

  fireEvent.click(await screen.findByRole("button", { name: "Base: Desert Home" }));
  fireEvent.click(screen.getByRole("button", { name: "Teleport" }));

  const select = screen.getByRole("combobox", { name: "Teleport destination player" });
  expect(select).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Liet" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Duncan" })).not.toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Farok" })).not.toBeInTheDocument();
});

it("a static-pool marker with no partition of its own falls back to the partition currently being viewed, not every partition", async () => {
  render(<LiveMapPanel
    onError={vi.fn()}
    confirmAction={vi.fn().mockResolvedValue(true)}
    waitForTask={vi.fn()}
    taskTechnicalDetails={vi.fn().mockReturnValue("")}
    onOpenBase={vi.fn()}
    onOpenVehicle={vi.fn()}
  />);

  fireEvent.click(await screen.findByRole("button", { name: "Active Spice Blows: Active Small Spice" }));
  fireEvent.click(screen.getByRole("button", { name: "Teleport" }));

  expect(screen.getByRole("option", { name: "Liet" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "Farok" })).not.toBeInTheDocument();
});

it("strips the redundant category prefix from House Representative and Trainer names, since the subtitle already shows the category", async () => {
  render(<LiveMapPanel
    onError={vi.fn()}
    confirmAction={vi.fn().mockResolvedValue(true)}
    waitForTask={vi.fn()}
    taskTechnicalDetails={vi.fn().mockReturnValue("")}
    onOpenBase={vi.fn()}
    onOpenVehicle={vi.fn()}
  />);

  fireEvent.click(await screen.findByRole("button", { name: "House Representative: Vernius" }));
  expect(screen.getByText("Vernius")).toBeInTheDocument();
  expect(screen.queryByText("HouseRepresentativeVernius")).not.toBeInTheDocument();

  fireEvent.click(await screen.findByRole("button", { name: "Trainer: Bene Gesserit" }));
  expect(screen.getByText("Bene Gesserit")).toBeInTheDocument();
  expect(screen.queryByText("TrainerBeneGesserit")).not.toBeInTheDocument();
});

it("a vehicle overlay shows its Owner like a base does, and Open in Vehicles opens that exact vehicle", async () => {
  const onOpenVehicle = vi.fn();
  render(<LiveMapPanel
    onError={vi.fn()}
    confirmAction={vi.fn().mockResolvedValue(true)}
    waitForTask={vi.fn()}
    taskTechnicalDetails={vi.fn().mockReturnValue("")}
    onOpenBase={vi.fn()}
    onOpenVehicle={onOpenVehicle}
  />);

  fireEvent.click(await screen.findByRole("button", { name: "Vehicle: Sandbike" }));
  expect(screen.getByText("Owner")).toBeInTheDocument();
  expect(screen.getByText("Stilgar")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Open in Vehicles" }));
  expect(onOpenVehicle).toHaveBeenCalledWith("900");
});

it("clicking Teleport with no online players on the map/partition shows an inline error instead of a picker", async () => {
  vi.mocked(liveMapApi.markers).mockResolvedValue({
    rows: [
      { id: 31573, type: "base", name: "Desert Home", base_type: "Sub-Fief", owner_name: "Chani", map: "HaggaBasin", partition_id: 1, x: 500, y: 500, z: 20 },
      { id: 501, type: "player", name: "Duncan", online_status: "offline", map: "HaggaBasin", partition_id: 1, x: 20, y: 20 }
    ],
    overlays: {},
    capabilities: { bases: true },
    map,
    maps: { HaggaBasin: map },
    defaultMap: "HaggaBasin",
    partitions: [{ map: "HaggaBasin", partition_id: 1, name: "Sietch New", marker_count: 2 }]
  });
  render(<LiveMapPanel
    onError={vi.fn()}
    confirmAction={vi.fn().mockResolvedValue(true)}
    waitForTask={vi.fn()}
    taskTechnicalDetails={vi.fn().mockReturnValue("")}
    onOpenBase={vi.fn()}
    onOpenVehicle={vi.fn()}
  />);

  fireEvent.click(await screen.findByRole("button", { name: "Base: Desert Home" }));
  fireEvent.click(screen.getByRole("button", { name: "Teleport" }));

  expect(screen.getByText("Error: No online players.")).toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Teleport destination player" })).not.toBeInTheDocument();
});

it("confirming a Teleport sends the picked player to the overlay marker's coordinates", async () => {
  const confirmAction = vi.fn().mockResolvedValue(true);
  const waitForTask = vi.fn().mockResolvedValue(fakeTask("succeeded"));
  vi.mocked(liveMapApi.teleportPlayer).mockResolvedValue({ task: fakeTask("running") });

  render(<LiveMapPanel
    onError={vi.fn()}
    confirmAction={confirmAction}
    waitForTask={waitForTask}
    taskTechnicalDetails={vi.fn().mockReturnValue("")}
    onOpenBase={vi.fn()}
    onOpenVehicle={vi.fn()}
  />);

  fireEvent.click(await screen.findByRole("button", { name: "Base: Desert Home" }));
  fireEvent.click(screen.getByRole("button", { name: "Teleport" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

  await waitFor(() => expect(confirmAction).toHaveBeenCalled());
  expect(confirmAction.mock.calls[0][0]).toMatch(/Teleport Liet to Desert Home/);

  await waitFor(() => expect(liveMapApi.teleportPlayer).toHaveBeenCalledWith({
    playerId: "500",
    x: 500,
    y: 500,
    z: 20,
    partitionId: 1,
    yaw: 0,
    online: true
  }));
  await waitFor(() => expect(waitForTask).toHaveBeenCalledWith(fakeTask("running")));
  expect(await screen.findByText(/Liet was teleported to Desert Home/)).toBeInTheDocument();
});

function renderPanel() {
  return render(<LiveMapPanel
    onError={vi.fn()}
    confirmAction={vi.fn().mockResolvedValue(true)}
    waitForTask={vi.fn()}
    taskTechnicalDetails={vi.fn().mockReturnValue("")}
    onOpenBase={vi.fn()}
    onOpenVehicle={vi.fn()}
  />);
}

function partitionSelect(container: HTMLElement) {
  return [...container.querySelectorAll("select")]
    .find((select) => [...select.options].some((option) => /Partition|Sietch/i.test(option.textContent || "")))!;
}

it("offers no All Partitions choice -- a real partition is always selected", async () => {
  const { container } = renderPanel();
  await screen.findByRole("button", { name: "Base: Desert Home" });

  const select = partitionSelect(container);
  const labels = [...select.options].map((option) => option.textContent);
  expect(labels.some((label) => /all partitions/i.test(label || ""))).toBe(false);
  expect(select.value).toBe("1");
  // and the value shown is a real option, not an unmatched blank
  expect([...select.options].map((option) => option.value)).toContain(select.value);
});

it("falls back to an available partition when the map's default is not one of them", async () => {
  // The invariant that matters now that there is no neutral "All Partitions"
  // entry: whatever the select shows must be one of the options, never an
  // unmatched value that leaves it blank while the markers filter by something
  // else. Here the map asks for partition 1 and the farm only serves 7.
  const moved = { ...map, defaultPartitionId: 1 };
  vi.mocked(liveMapApi.markers).mockResolvedValue({
    rows: [{ id: 31573, type: "base", name: "Desert Home", base_type: "Sub-Fief", owner_name: "Chani", map: "HaggaBasin", partition_id: 7, x: 500, y: 500, z: 20 }],
    overlays: {},
    capabilities: { bases: true },
    map: moved,
    maps: { HaggaBasin: moved },
    defaultMap: "HaggaBasin",
    partitions: [{ map: "HaggaBasin", partition_id: 7, name: "Sietch Tabr", marker_count: 1 }]
  } as never);

  const { container } = renderPanel();
  await screen.findByRole("button", { name: "Base: Desert Home" });

  await waitFor(() => {
    const select = partitionSelect(container);
    expect(select.value).toBe("7");
    expect([...select.options].map((option) => option.value)).toContain(select.value);
  });
});

// jsdom has no ResizeObserver, and the sector-grid label effect observes the
// map frame with one. No Hagga Basin test reaches that effect, so nothing here
// needed it before.
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Every fixture above is Hagga Basin, so the Deep Desert half of this panel --
// the sector grid, its toggle, the terrain gate and the Terrain readout -- had
// no panel-level coverage at all.
const deepDesert = {
  key: "DeepDesert",
  label: "The Deep Desert",
  actorMap: "DeepDesert",
  image: "/images/maps/deep-desert.png",
  width: 4096,
  height: 4096,
  minX: -1177656,
  maxX: 1072344,
  minY: -1177066,
  maxY: 1072934,
  flipY: false,
  defaultPartitionId: 8
};

function useDeepDesert(extra: Record<string, unknown> = {}) {
  vi.mocked(liveMapApi.markers).mockResolvedValue({
    rows: [
      { id: 4242, type: "base", name: "Sietch Tabr", base_type: "Sub-Fief", owner_name: "Stilgar", map: "DeepDesert", partition_id: 8, x: -52656, y: -52066, z: 30 }
    ],
    overlays: {},
    capabilities: { bases: true },
    map: deepDesert,
    maps: { DeepDesert: deepDesert },
    defaultMap: "DeepDesert",
    partitions: [{ map: "DeepDesert", partition_id: 8, name: "PvP", marker_count: 1 }],
    ...extra
  } as never);
}

it("draws the sector grid on the Deep Desert, with a full 9x9 of labels", async () => {
  useDeepDesert({ coriolisLayout: 3 });
  const { container } = renderPanel();
  await screen.findByRole("button", { name: "Base: Sietch Tabr" });

  const grid = container.querySelector("svg.live-map-sector-grid");
  expect(grid).not.toBeNull();
  // 10 lines each way, and a label per cell.
  expect(grid!.querySelectorAll("line")).toHaveLength(20);
  expect(grid!.querySelectorAll("text")).toHaveLength(81);
  // The corners the game's own map art carries, the letter running up the screen.
  const labels = [...grid!.querySelectorAll("text")].map((node) => node.textContent);
  expect(labels).toContain("A1");
  expect(labels).toContain("I9");
});

it("hides the grid when the Sector Grid toggle is switched off", async () => {
  useDeepDesert({ coriolisLayout: 3 });
  const { container } = renderPanel();
  await screen.findByRole("button", { name: "Base: Sietch Tabr" });

  const toggle = screen.getByRole("button", { name: "Sector Grid" });
  // On by default: the terrain carries no grid of its own.
  expect(toggle).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(container.querySelector("svg.live-map-sector-grid")).toBeNull();
});

it("offers no sector grid on Hagga Basin, which has no lettered sectors", async () => {
  const { container } = renderPanel();
  await screen.findByRole("button", { name: "Base: Desert Home" });
  expect(screen.queryByRole("button", { name: "Sector Grid" })).toBeNull();
  expect(container.querySelector("svg.live-map-sector-grid")).toBeNull();
});

it("falls back to the flat image and says so when the layout is unknown", async () => {
  useDeepDesert({ coriolisLayout: null });
  const { container } = renderPanel();
  await screen.findByRole("button", { name: "Base: Sietch Tabr" });

  expect(container.querySelector("img.live-map-image")).not.toBeNull();
  expect(screen.getByText("flat map (layout unknown)")).toBeInTheDocument();
});

it("reports the layout once one is known", async () => {
  useDeepDesert({ coriolisLayout: 3 });
  const { container } = renderPanel();
  await screen.findByRole("button", { name: "Base: Sietch Tabr" });
  // The canvas mounts before its asynchronously loaded terrain is ready. Wait
  // for the readiness signal reflected by removal of the temporary flat image,
  // rather than merely observing the canvas element and racing onReady().
  await waitFor(() => expect(container.querySelector("img.live-map-image")).toBeNull());
  expect(container.querySelector("canvas.live-map-terrain")).not.toBeNull();
  expect(screen.getByText("layout 3")).toBeInTheDocument();
});

// Finding 9: the API caps the layout at 63 so a future Layout_12 is reported
// truthfully rather than nulled, but only 0-11 ship meshes. The render gate and
// the readout used to decide separately, so an unshipped layout drew the flat
// image while the strip announced it as rendered.
it("says a layout it cannot draw is not shipped, rather than claiming it rendered", async () => {
  useDeepDesert({ coriolisLayout: 12 });
  const { container } = renderPanel();
  await screen.findByRole("button", { name: "Base: Sietch Tabr" });

  expect(container.querySelector("img.live-map-image")).not.toBeNull();
  expect(container.querySelector("canvas.live-map-terrain")).toBeNull();
  expect(screen.getByText("flat map (layout 12 not shipped)")).toBeInTheDocument();
  expect(screen.queryByText("layout 12")).toBeNull();
});

// Finding 8 was that the overlay drew a second 9x9 grid about a third of a cell
// off the one burned into the flat PNG. That was the bounds being ~8% too wide,
// not the overlay: with the rect corrected to the square the image covers, the
// two coincide and the overlay is welcome on the fallback again -- it carries
// crisp, zoom-stable labels the picture cannot.
it("still draws the grid over the flat image, now that the two agree", async () => {
  useDeepDesert({ coriolisLayout: null });
  const { container } = renderPanel();
  await screen.findByRole("button", { name: "Base: Sietch Tabr" });

  expect(container.querySelector("img.live-map-image")).not.toBeNull();
  expect(container.querySelector("svg.live-map-sector-grid")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Sector Grid" })).toBeInTheDocument();
});

// Finding 5 of the branch review: the grid geometry was rebuilt on every render
// and is a dependency of the label-placement effect, so the scroll listener and
// the ResizeObserver were torn down and re-added on every marker hover and
// every five-second poll.
it("does not re-subscribe the grid's scroll listener on an unrelated re-render", async () => {
  useDeepDesert({ coriolisLayout: 3 });
  const { container } = renderPanel();
  const marker = await screen.findByRole("button", { name: "Base: Sietch Tabr" });
  const frame = container.querySelector(".live-map-frame") as HTMLDivElement;
  expect(frame).not.toBeNull();

  // Watch this one element rather than HTMLDivElement.prototype, and watch it
  // only once mounting has settled. Counting every div's scroll listeners from
  // a snapshot taken mid-mount made this flaky: anything subscribing later, for
  // any reason, looked like the grid re-subscribing.
  //
  // Removals are the assertion because a re-subscription cannot avoid one --
  // React tears an effect down before running it again -- so a removal means
  // churn and nothing else can fake it.
  const removed: string[] = [];
  const added: string[] = [];
  const realAdd = frame.addEventListener.bind(frame);
  const realRemove = frame.removeEventListener.bind(frame);
  frame.addEventListener = ((type: string, ...rest: unknown[]) => {
    if (type === "scroll") added.push(type);
    return (realAdd as (...args: unknown[]) => void)(type, ...rest);
  }) as typeof frame.addEventListener;
  frame.removeEventListener = ((type: string, ...rest: unknown[]) => {
    if (type === "scroll") removed.push(type);
    return (realRemove as (...args: unknown[]) => void)(type, ...rest);
  }) as typeof frame.removeEventListener;

  try {
    // Re-renders that have nothing to do with the map, the zoom or the grid.
    fireEvent.mouseEnter(marker);
    fireEvent.mouseLeave(marker);
    fireEvent.mouseEnter(marker);
    fireEvent.mouseLeave(marker);

    expect(removed).toEqual([]);
    expect(added).toEqual([]);
  } finally {
    delete (frame as Partial<HTMLDivElement>).addEventListener;
    delete (frame as Partial<HTMLDivElement>).removeEventListener;
  }
});

// Finding 7: the canvas is mounted well before it can paint -- the shared
// library alone is 6.4 MB -- so dropping the flat image when the lazy chunk
// resolved left a window with neither, markers floating over bare background.
it("keeps the flat image up until the terrain reports it can paint", async () => {
  terrain.signalsReady = false;
  useDeepDesert({ coriolisLayout: 3 });
  const { container } = renderPanel();
  await screen.findByRole("button", { name: "Base: Sietch Tabr" });

  // Canvas mounted, but nothing on it yet -- the image is still carrying the map.
  expect(container.querySelector("canvas.live-map-terrain")).not.toBeNull();
  expect(container.querySelector("img.live-map-image")).not.toBeNull();
});

it("drops the flat image once the terrain has painted", async () => {
  useDeepDesert({ coriolisLayout: 3 });
  const { container } = renderPanel();
  await screen.findByRole("button", { name: "Base: Sietch Tabr" });

  await waitFor(() => expect(container.querySelector("img.live-map-image")).toBeNull());
  expect(container.querySelector("canvas.live-map-terrain")).not.toBeNull();
});
