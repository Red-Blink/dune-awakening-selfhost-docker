import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Task } from "../../api/setup";
import { liveMapApi } from "../../api/liveMap";
import { LiveMapPanel } from "./LiveMapPanel";

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
