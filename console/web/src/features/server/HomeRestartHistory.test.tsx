import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { HomePanel } from "./ServerPanels";
import { serverApi } from "../../api/server";

vi.mock("../../api/server", async (original) => ({
  ...await original<typeof import("../../api/server")>(),
  serverApi: { restartHistory: vi.fn(), performance: vi.fn().mockResolvedValue(null),
    checkFuncomToken: vi.fn().mockResolvedValue({ ok: true }) }
}));
vi.mock("../../lib/usePendingRefills", () => ({
  usePendingQueues: () => ({ fuel: {}, water: {}, deletes: {}, vehicleDeletes: {}, permissions: {} }),
  childAccessPieceCount: () => 0
}));

const history = vi.mocked(serverApi.restartHistory);
const status = "Overall: READY\n=== Containers ===\nSERVICE STATUS\ndune-server-survival-1 Up 5 minutes\ndune-server-overmap Up 5 minutes\n=== Game servers ===\nSurvival_1 READY\nOvermap READY";
const fresh = { id: "manual", startedAt: "2026-10-30T08:00:00Z", finishedAt: "2026-10-30T08:05:00Z", durationSeconds: 300,
  scope: "battlegroup" as const, target: "Battlegroup", map: "", partitionId: "", source: "Console", reason: "Battlegroup restart", result: "Succeeded" as const };

function mountHome() {
  return render(<HomePanel status={status} readiness="READY: Battlegroup" taskResult={null}
    setTaskResult={vi.fn()} funcomTokenResult={null} setFuncomTokenResult={vi.fn()}
    runningAction="" restartStartObserved={false} setRunningAction={vi.fn()}
    onLoad={vi.fn().mockResolvedValue({ statusLoaded: true, readinessLoaded: true, statusText: status,
      readinessText: "READY: Battlegroup", statusError: "", readinessError: "" })}
    confirmAction={vi.fn()} restartGate={vi.fn()} />);
}

beforeEach(() => { vi.clearAllMocks(); history.mockResolvedValue({ rows: [], lastBattlegroupRestart: null }); });
afterEach(() => { vi.useRealTimers(); });

test("Refresh Status reloads restart history after a manual restart finishes", async () => {
  const { container } = mountHome();
  await waitFor(() => expect(history).toHaveBeenCalled());
  expect(container.querySelector(".home-last-restart")).toHaveTextContent("Not Recorded Yet");
  history.mockResolvedValue({ rows: [fresh], lastBattlegroupRestart: fresh });
  fireEvent.click(await screen.findByRole("button", { name: "Refresh Status" }));
  await waitFor(() => expect(container.querySelector(".home-last-restart")).not.toHaveTextContent("Not Recorded Yet"));
});

test("Home notices a late history write without a task-result transition or page reload", async () => {
  vi.useFakeTimers();
  let view!: ReturnType<typeof mountHome>;
  await act(async () => { view = mountHome(); });
  expect(history).toHaveBeenCalled();
  history.mockResolvedValue({ rows: [fresh], lastBattlegroupRestart: fresh });
  await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
  expect(view.container.querySelector(".home-last-restart")).not.toHaveTextContent("Not Recorded Yet");
});

test("returning to Home's window refreshes a restart completed while away", async () => {
  const { container } = mountHome();
  await waitFor(() => expect(history).toHaveBeenCalled());
  history.mockResolvedValue({ rows: [fresh], lastBattlegroupRestart: fresh });
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(container.querySelector(".home-last-restart")).not.toHaveTextContent("Not Recorded Yet"));
});
