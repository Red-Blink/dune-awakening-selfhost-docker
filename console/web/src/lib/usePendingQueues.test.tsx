import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { basesApi } from "../api/bases";
import { vehiclesApi } from "../api/vehicles";
import { setConsoleAccess } from "./consoleAccess";
import { usePendingQueues } from "./usePendingRefills";

vi.mock("../api/bases", () => ({ basesApi: { pendingRefills: vi.fn(), pendingWaterRefills: vi.fn(), pendingDeletes: vi.fn(), pendingChildAccess: vi.fn() } }));
vi.mock("../api/vehicles", () => ({ vehiclesApi: { pendingDeletes: vi.fn() } }));
const user = { username: "viewer", displayName: "Viewer", tier: "moderator" };

beforeEach(() => {
  vi.clearAllMocks();
  for (const method of Object.values(basesApi)) vi.mocked(method).mockResolvedValue({ pending: [], byTarget: [] } as never);
  vi.mocked(vehiclesApi.pendingDeletes).mockResolvedValue({ pending: [], byTarget: [] } as never);
});

it("does not request queues outside the account's resource grants", () => {
  setConsoleAccess("ready", user, ["maps:read"]);
  renderHook(() => usePendingQueues());
  for (const method of Object.values(basesApi)) expect(method).not.toHaveBeenCalled();
  expect(vehiclesApi.pendingDeletes).not.toHaveBeenCalled();
});

it("removes cached queue information immediately when a resource grant is revoked", async () => {
  setConsoleAccess("ready", user, ["bases:read", "vehicles:read"]);
  const { result } = renderHook(() => usePendingQueues());
  await waitFor(() => expect(result.current.fuel.pending).not.toBeNull());
  await waitFor(() => expect(result.current.vehicleDeletes.pending).not.toBeNull());
  act(() => setConsoleAccess("ready", user, ["maps:read"]));
  for (const queue of Object.values(result.current)) expect(queue.pending).toBeNull();
});
