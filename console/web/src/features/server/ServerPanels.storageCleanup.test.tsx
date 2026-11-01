import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerPanel, applyStorageCleanupReport, type HomeTaskResult, type StorageCleanupOperation } from "./ServerPanels";

const mocks = vi.hoisted(() => ({ task: vi.fn(), images: vi.fn(), cache: vi.fn(), doctor: vi.fn().mockResolvedValue({ stdout: "WARN Docker has 6 reclaimable images" }), setStatus: vi.fn() }));
const confirmation = vi.fn().mockResolvedValue(true);
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
  const [doctor, setDoctor] = useState("WARN Docker has 6 reclaimable images\nWARN Docker has 11.05GB of reclaimable build cache\nWARN Keep this unrelated diagnostic");
  const [visible, setVisible] = useState(true);
  const [result, setResult] = useState<HomeTaskResult | null>(null);
  const [operation, setOperation] = useState<StorageCleanupOperation>("");
  return <><button onClick={() => setVisible(!visible)}>Navigate</button>{visible && <ServerPanel
    status="" readiness="READY: all checks passed" ports="" doctor={doctor}
    setTask={vi.fn()} setStatus={mocks.setStatus} setReadiness={vi.fn()} setPorts={vi.fn()} setDoctor={setDoctor}
    storageCleanupResult={result} setStorageCleanupResult={setResult} storageCleanupOperation={operation} setStorageCleanupOperation={setOperation}
    taskResult={null} setTaskResult={vi.fn()} funcomTokenResult={null} setFuncomTokenResult={vi.fn()}
    runningAction="" setRunningAction={vi.fn()} restartStartObserved={false} onError={vi.fn()} onRedeploy={vi.fn()}
    confirmAction={confirmation} restartGate={vi.fn()}
  />}</>;
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
describe("storage cleanup navigation", () => {
  it("explains host-wide image removal and runs nothing when confirmation is declined", async () => {
    confirmation.mockResolvedValueOnce(false);
    await act(async () => { render(<Harness />); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Clean Images" })); });
    const message = confirmation.mock.calls[0][0];
    expect(message).toContain("other projects' unused images");
    expect(message).toContain("running or stopped containers");
    expect(message).toContain("configured startup images");
    expect(mocks.images).not.toHaveBeenCalled();
  });
  it.each(["images", "cache"])("updates storage cards immediately after verified %s cleanup, ignoring an older pending scan", async (operation) => {
    let finishDoctor!: (value: { stdout: string }) => void;
    mocks.doctor.mockImplementationOnce(() => new Promise((resolve) => { finishDoctor = resolve; }));
    const report = "STORAGE_RESULT OK   No unused Docker images eligible for cleanup\nSTORAGE_RESULT OK   Reclaimable Docker build cache: 0B";
    const completed = { task: { id: "cleanup", status: "succeeded", logLines: [{ line: report }] } };
    (operation === "images" ? mocks.images : mocks.cache).mockResolvedValue(completed);
    await act(async () => { render(<Harness />); });
    expect(screen.getByRole("button", { name: "Clean Images" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clean Build Cache" })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: operation === "images" ? "Clean Images" : "Clean Build Cache" })); });
    expect(screen.queryByRole("button", { name: "Clean Images" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Clean Build Cache" })).toBeNull();
    expect(screen.getByText("Keep this unrelated diagnostic")).toBeTruthy();
    expect(mocks.doctor).toHaveBeenCalledTimes(1);
    await act(async () => { finishDoctor({ stdout: "WARN Docker has 6 reclaimable images" }); });
    expect(screen.queryByRole("button", { name: "Clean Images" })).toBeNull();
  });
  it("retains genuine remaining storage warnings and ignores incomplete reports", () => {
    const previous = "WARN Keep this unrelated diagnostic\nWARN Docker has 6 reclaimable images";
    expect(applyStorageCleanupReport(previous, "")).toBe(previous);
    expect(applyStorageCleanupReport(previous, "STORAGE_RESULT OK   No obsolete project-owned Docker images found")).toBe(previous);
    const next = applyStorageCleanupReport(previous, "STORAGE_RESULT WARN Docker has 1 unused image(s) that can be cleaned (up to 98GB)\nSTORAGE_RESULT WARN Docker has 12GB of reclaimable build cache");
    expect(next).toContain("WARN Keep this unrelated diagnostic");
    expect(next).toContain("1 unused image(s)");
    expect(next).toContain("up to 98GB");
    expect(next).toContain("12GB of reclaimable build cache");
    expect(next).not.toContain("6 reclaimable images");
  });
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
    expect(screen.getByText("Clean Images")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));
    // A cleanup can run longer than the former three-minute polling limit.
    await act(async () => { for (let i = 0; i < 181; i++) await vi.advanceTimersByTimeAsync(1000); });
    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));
    expect(screen.getByText("Clean Images")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cleaning..." }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));
    mocks.task.mockResolvedValue({ task: { id: "cleanup", status, logLines: [] } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    fireEvent.click(screen.getByRole("button", { name: "Navigate" }));
    expect(screen.getByText(status === "succeeded" ? "Action completed." : "Image Cleanup Failed.")).toBeTruthy();
    expect(mocks.images).toHaveBeenCalledTimes(1);
  });
});
