import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerPanel, type HomeTaskResult, type StorageCleanupOperation } from "./ServerPanels";

const mocks = vi.hoisted(() => ({ task: vi.fn(), images: vi.fn(), cache: vi.fn(), doctor: vi.fn().mockResolvedValue({ stdout: "WARN Docker has 6 reclaimable images" }), setStatus: vi.fn() }));
vi.mock("../../api/server", () => ({ serverApi: {
  status: vi.fn().mockResolvedValue({ stdout: "" }), readiness: vi.fn().mockResolvedValue({ stdout: "READY: all checks passed" }),
  ports: vi.fn().mockResolvedValue({ stdout: "" }), doctor: mocks.doctor,
  restartSchedule: vi.fn().mockResolvedValue({ stdout: "" }), restartHistory: vi.fn().mockResolvedValue({ rows: [] }),
  cleanupDockerImages: mocks.images, cleanupDockerBuildCache: mocks.cache
} }));
vi.mock("../../api/setup", () => ({ setupApi: { task: mocks.task } }));
vi.mock("./ServerHostnameSetting", () => ({ useServerHostname: () => ({ ready: true, valid: true }), ServerHostnameSetting: () => null }));
vi.mock("../../lib/usePendingRefills", async (importOriginal) => ({ ...await importOriginal<typeof import("../../lib/usePendingRefills")>(), usePendingQueues: () => ({ fuel: {}, water: {}, deletes: {}, vehicleDeletes: {}, permissions: {} }) }));

function Harness() {
  const [visible, setVisible] = useState(true);
  const [result, setResult] = useState<HomeTaskResult | null>(null);
  const [operation, setOperation] = useState<StorageCleanupOperation>("");
  return <><button onClick={() => setVisible(!visible)}>Navigate</button>{visible && <ServerPanel
    status="" readiness="READY: all checks passed" ports="" doctor="WARN Docker has 6 reclaimable images"
    setTask={vi.fn()} setStatus={mocks.setStatus} setReadiness={vi.fn()} setPorts={vi.fn()} setDoctor={vi.fn()}
    storageCleanupResult={result} setStorageCleanupResult={setResult} storageCleanupOperation={operation} setStorageCleanupOperation={setOperation}
    taskResult={null} setTaskResult={vi.fn()} funcomTokenResult={null} setFuncomTokenResult={vi.fn()}
    runningAction="" setRunningAction={vi.fn()} restartStartObserved={false} onError={vi.fn()} onRedeploy={vi.fn()}
    confirmAction={vi.fn().mockResolvedValue(true)} restartGate={vi.fn()}
  />}</>;
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
describe("storage cleanup navigation", () => {
  it("loads server status without waiting for slow diagnostics", async () => {
    mocks.doctor.mockImplementationOnce(() => new Promise(() => {}));
    await act(async () => { render(<Harness />); });
    expect(mocks.setStatus).toHaveBeenCalledWith("");
  });
  it.each(["succeeded", "failed"])("keeps the running task and its %s result across page changes", async (status) => {
    vi.useFakeTimers();
    mocks.images.mockResolvedValue({ task: { id: "cleanup", status: "running" } });
    mocks.task.mockResolvedValue({ task: { id: "cleanup", status: "running" } });
    render(<Harness />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Clean Images" })); });
    expect(screen.getByText("Cleaning Obsolete Dune Images")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));
    // A cleanup can run longer than the former three-minute polling limit.
    await act(async () => { for (let i = 0; i < 181; i++) await vi.advanceTimersByTimeAsync(1000); });
    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));
    expect(screen.getByText("Cleaning Obsolete Dune Images")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cleaning..." }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));
    mocks.task.mockResolvedValue({ task: { id: "cleanup", status, logLines: [] } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));
    expect(screen.getByText(status === "succeeded" ? "Obsolete Images Cleaned." : "Image Cleanup Failed.")).toBeTruthy();
    expect(mocks.images).toHaveBeenCalledTimes(1);
  });
});
