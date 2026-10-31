import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { RestartHistoryPanel } from "./ServerPanels";

vi.mock("../../api/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/server")>();
  return { ...actual, serverApi: { ...actual.serverApi, restartHistory: vi.fn() } };
});

import { serverApi } from "../../api/server";

const restartHistory = vi.mocked(serverApi.restartHistory);

beforeEach(() => vi.clearAllMocks());

test("capitalizes the Last Battlegroup Restart caption independently of its timestamp", async () => {
  restartHistory.mockResolvedValue({ rows: [], lastBattlegroupRestart: { id: "bg-restart", startedAt: "2026-10-31T18:00:00Z", finishedAt: "2026-10-31T18:01:00Z", durationSeconds: 60, scope: "battlegroup", target: "Battlegroup", map: "", partitionId: "", source: "Console", reason: "Manual restart", result: "Succeeded" } });
  render(<RestartHistoryPanel refreshKey="caption" />);
  expect(await screen.findByText("Last Battlegroup Restart")).toBeVisible();
  expect(screen.queryByText(/Last Battlegroup restart/)).toBeNull();
});

test("starts closed and toggles its history without opening on refresh", async () => {
  restartHistory.mockResolvedValue({ rows: [], lastBattlegroupRestart: null });
  const { container, rerender } = render(<RestartHistoryPanel refreshKey="initial" />);
  const panel = container.querySelector("details")!;
  const toggle = container.querySelector("summary")!;
  await waitFor(() => expect(restartHistory).toHaveBeenCalledTimes(1));
  expect(panel.open).toBe(false);
  expect(screen.getByText("No Matching Restarts")).not.toBeVisible();
  fireEvent.click(toggle);
  expect(panel.open).toBe(true);
  expect(screen.getByText("No Matching Restarts")).toBeVisible();
  fireEvent.click(toggle);
  rerender(<RestartHistoryPanel refreshKey="updated" />);
  await waitFor(() => expect(restartHistory).toHaveBeenCalledTimes(2));
  expect(panel.open).toBe(false);
  expect(screen.getByText("No Matching Restarts")).not.toBeVisible();
});

test("gives an empty restart history comfortable, structured spacing", async () => {
  restartHistory.mockResolvedValue({ rows: [], lastBattlegroupRestart: null });
  const { container } = render(<RestartHistoryPanel refreshKey="initial" />);
  fireEvent.click(screen.getByText("Restart History"));

  expect(await screen.findByText("No Matching Restarts")).toBeVisible();
  expect(screen.getByText("No matching restarts have been recorded yet.")).toBeVisible();
  expect(container.querySelector(".restart-history-empty")).toBeTruthy();
  expect(container.querySelector(".restart-history-content")).toBeTruthy();
});

test("renders populated restart history with clear type, target, timing, and result columns", async () => {
  restartHistory.mockResolvedValue({
    lastBattlegroupRestart: null,
    rows: [{
      id: "restart-1",
      startedAt: "2026-09-29T09:00:00.000Z",
      finishedAt: "2026-09-29T09:01:05.000Z",
      durationSeconds: 65,
      scope: "map",
      target: "Hagga Basin",
      map: "Survival_1",
      partitionId: "31",
      source: "Console",
      reason: "Settings applied with restart",
      result: "Succeeded"
    }]
  });
  render(<RestartHistoryPanel refreshKey="populated" />);
  fireEvent.click(screen.getByText("Restart History"));

  const table = await screen.findByRole("table");
  for (const heading of ["Completed", "Type", "Target", "Source", "Reason", "Duration", "Result"]) {
    expect(within(table).getByRole("columnheader", { name: heading })).toBeVisible();
  }
  expect(within(table).getByText("Map")).toHaveClass("scope-map");
  expect(within(table).getByText("Hagga Basin")).toBeVisible();
  expect(within(table).getByText("Partition 31")).toBeVisible();
  expect(within(table).getByText("1m 5s")).toBeVisible();
  expect(within(table).getByText("Succeeded")).toBeVisible();
});

test("filters populated history without collapsing the clean empty state", async () => {
  restartHistory.mockResolvedValue({
    lastBattlegroupRestart: null,
    rows: [{ id: "restart-1", startedAt: "", finishedAt: "", durationSeconds: 2, scope: "service", target: "Director", map: "", partitionId: "", source: "Console", reason: "Manual restart", result: "Succeeded" }]
  });
  render(<RestartHistoryPanel refreshKey="filter" />);
  fireEvent.click(screen.getByText("Restart History"));
  await screen.findByRole("table");
  fireEvent.change(screen.getByLabelText("Show"), { target: { value: "map" } });
  await waitFor(() => expect(screen.queryByRole("table")).toBeNull());
  expect(screen.getByText("No Matching Restarts")).toBeVisible();
});
