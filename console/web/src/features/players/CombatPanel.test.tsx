import { act, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { combatApi, type CombatHistory } from "../../api/combat";
import { CombatPanel } from "./CombatPanel";

vi.mock("../../api/combat", () => ({ combatApi: { history: vi.fn() } }));
const empty = (): CombatHistory => ({ supported: true, status: "recording", reason: "", selfOnly: false,
  recordingStartedAt: "2026-11-02T00:00:00Z", recordedSince: null, lastCapturedAt: new Date().toISOString(), leaderboard: [], recentKills: [] });
const populated = (): CombatHistory => ({ ...empty(), recordedSince: "2026-11-01T00:00:00Z",
  leaderboard: [{ controllerId: "101", name: "Aster", kills: 4, deaths: 2, kd: 2, selfDeaths: 1, otherDeaths: 3, unknownDeaths: 1 }],
  recentKills: [{ id: "synthetic-kill", time: new Date().toISOString(), map: "Deep Desert", killerId: "101", victimId: "102", killer: "Aster", victim: "Mira" }] });
beforeEach(() => { vi.resetAllMocks(); vi.mocked(combatApi.history).mockResolvedValue(empty()); });
afterEach(() => vi.useRealTimers());

describe("Combat history", () => {
  it("requests independent row choices, including all records, without resetting the other panel", async () => {
    vi.mocked(combatApi.history).mockImplementation(async (_controllerId, options) => {
      const result = populated();
      result.leaderboard = Array.from({ length: 64 }, (_, index) => ({ ...result.leaderboard[0], controllerId: String(index + 1), name: `Player ${index + 1}` }));
      result.recentKills = Array.from({ length: 120 }, (_, index) => ({ ...result.recentKills[0], id: `kill-${index}` }));
      result.leaderboard = result.leaderboard.slice(0, options?.leaderboardLimit === "all" ? undefined : options?.leaderboardLimit);
      result.recentKills = result.recentKills.slice(0, options?.killsLimit === "all" ? undefined : options?.killsLimit);
      return result;
    });
    render(<CombatPanel />);
    await screen.findByText("Player 1");
    expect(screen.getAllByRole("row")).toHaveLength(11);
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    fireEvent.change(screen.getByRole("combobox", { name: "Leaderboard Rows" }), { target: { value: "20" } });
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(21));
    expect(screen.getAllByRole("listitem")).toHaveLength(10);
    fireEvent.change(screen.getByRole("combobox", { name: "Recent Kills Rows" }), { target: { value: "50" } });
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(50));
    expect(screen.getAllByRole("row")).toHaveLength(21);
    fireEvent.change(screen.getByRole("combobox", { name: "Leaderboard Rows" }), { target: { value: "all" } });
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(65));
    expect(screen.getAllByRole("listitem")).toHaveLength(50);
    fireEvent.change(screen.getByRole("combobox", { name: "Recent Kills Rows" }), { target: { value: "all" } });
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(120));
    expect(combatApi.history).toHaveBeenLastCalledWith(undefined, { leaderboardLimit: "all", killsLimit: "all" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(combatApi.history).toHaveBeenLastCalledWith(undefined, { leaderboardLimit: "all", killsLimit: "all" }));
    expect(screen.getByRole("combobox", { name: "Leaderboard Rows" })).toHaveValue("all");
    expect(screen.getByRole("combobox", { name: "Recent Kills Rows" })).toHaveValue("all");
  });
  it("keeps existing rows visible while a new row count is being fetched", async () => {
    vi.mocked(combatApi.history).mockResolvedValueOnce(populated()).mockImplementationOnce(() => new Promise(() => {}));
    render(<CombatPanel />);
    await screen.findByRole("cell", { name: "Aster" });
    fireEvent.change(screen.getByRole("combobox", { name: "Leaderboard Rows" }), { target: { value: "20" } });
    expect(screen.getByRole("cell", { name: "Aster" })).toBeVisible();
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  });
  it("shows recording and honest empty states without fabricating a leaderboard", async () => {
    render(<CombatPanel />);
    expect(await screen.findByText("No combat events have been recorded yet.")).toBeVisible();
    expect(screen.getByText("No PvP kills have been recorded yet.")).toBeVisible();
    expect(screen.getByText("Recording")).toBeVisible();
    expect(screen.getByText(/Events removed by the game before collection/)).not.toBeVisible();
    fireEvent.click(screen.getByText("About This History"));
    expect(screen.getByText(/Events removed by the game before collection/)).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
  });
  it("renders PvP totals, separate self deaths, K/D and who killed whom", async () => {
    vi.mocked(combatApi.history).mockResolvedValue(populated());
    render(<CombatPanel />);
    expect(await screen.findByRole("columnheader", { name: "PvP Deaths" })).toBeVisible();
    expect(screen.getByText("2.00")).toBeVisible();
    expect(screen.getByText("Mira")).toBeVisible();
    expect(screen.getByText("Deep Desert", { exact: false })).toBeVisible();
    fireEvent.click(screen.getByText("About This History"));
    expect(screen.getByText(/Available history from/)).toBeVisible();
  });
  it("keeps the leaderboard focused on ranking and PvP rather than secondary death counters", async () => {
    vi.mocked(combatApi.history).mockResolvedValue(populated());
    render(<CombatPanel />);
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("columnheader").map(node => node.textContent)).toEqual(["Rank", "Player", "Kills", "PvP Deaths", "K/D"]);
    expect(screen.queryByText("Total Kills")).toBeNull();
  });
  it("shows the selected player's primary and secondary statistics without a one-row leaderboard", async () => {
    vi.mocked(combatApi.history).mockResolvedValue(populated());
    render(<CombatPanel controllerId="101" playerName="Aster" />);
    await screen.findByText("Combat Summary");
    expect(screen.getByText("Self-Deaths").parentElement).toHaveTextContent("1");
    expect(screen.getByText("Other Deaths").parentElement).toHaveTextContent("3");
    expect(screen.getByText("Unclassified Deaths").parentElement).toHaveTextContent("1");
    expect(screen.getByText("2.00")).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
  });
  it("keeps captured results visible while recording is paused", async () => {
    vi.mocked(combatApi.history).mockResolvedValue({ ...populated(), status: "paused", reason: "Recording will retry automatically." });
    render(<CombatPanel />);
    expect(await screen.findByText("Recording Paused")).toBeVisible();
    expect(screen.getByText("Mira")).toBeVisible();
    expect(screen.getByText("Recording will retry automatically.")).toBeVisible();
  });
  it("uses a dash when K/D has no death denominator", async () => {
    const result = populated(); result.leaderboard[0].kd = null;
    vi.mocked(combatApi.history).mockResolvedValue(result);
    render(<CombatPanel controllerId="101" playerName="Aster" />);
    expect(await screen.findByText("—")).toBeVisible();
    expect(combatApi.history).toHaveBeenCalledWith("101", { leaderboardLimit: 10, killsLimit: 10 });
  });
  it("does not present unsupported data as zero kills", async () => {
    vi.mocked(combatApi.history).mockResolvedValue({ ...empty(), supported: false, status: "unavailable", reason: "Game history unavailable" });
    render(<CombatPanel />);
    expect(await screen.findByText("Not Available")).toBeVisible();
    expect(screen.queryByText("Leaderboard")).toBeNull();
    expect(screen.getByText("Game history unavailable")).toBeVisible();
  });
  it("recovers from a failed fetch on refresh and keeps private error text out", async () => {
    vi.mocked(combatApi.history).mockRejectedValueOnce(new Error("PRIVATE DATABASE DETAIL"));
    render(<CombatPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
    expect(screen.queryByText("PRIVATE DATABASE DETAIL")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Recording");
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("discards a previous character's late response", async () => {
    let resolveOld!: (data: CombatHistory) => void;
    vi.mocked(combatApi.history).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    const view = render(<CombatPanel controllerId="101" playerName="Old Character" />);
    view.rerender(<CombatPanel controllerId="102" playerName="New Character" />);
    await screen.findByText("No combat events have been recorded yet.");
    await act(async () => resolveOld(populated()));
    expect(screen.queryByText("Mira")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });
  it("polls without overlapping requests and stops after unmount", async () => {
    const view = render(<CombatPanel />);
    await screen.findByText("Recording");
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await act(async () => {});
    const before = vi.mocked(combatApi.history).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(combatApi.history).toHaveBeenCalledTimes(before + 1);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(combatApi.history).toHaveBeenCalledTimes(before + 1);
  });
  it("labels a scoped view as personal statistics", async () => {
    vi.mocked(combatApi.history).mockResolvedValue({ ...empty(), selfOnly: true });
    render(<CombatPanel />);
    expect(await screen.findByText("Your PvP Statistics")).toBeVisible();
    expect(screen.queryByText("Leaderboard")).toBeNull();
  });
});
