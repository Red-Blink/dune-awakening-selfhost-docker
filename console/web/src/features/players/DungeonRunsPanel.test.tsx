import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DungeonRunsPanel } from "./DungeonRunsPanel";
import { dungeonsApi } from "../../api/dungeons";
import { playersApi } from "../../api/players";
import type { DungeonRun } from "../../api/players";

vi.mock("../../api/dungeons", () => ({ dungeonsApi: { runs: vi.fn(), leaderboard: vi.fn() } }));
vi.mock("../../api/players", () => ({ playersApi: { list: vi.fn() } }));

const aster = { controllerId: 23, actorId: 25, characterName: "Aster" };
const brin = { controllerId: 36, actorId: 38, characterName: "Brin" };
const gone = { controllerId: 52, actorId: null, characterName: null };
const run = (completionId: number, dungeonId: string, difficulty: number, durationMs: number, party: DungeonRun["party"] = [aster]) =>
  ({ completionId, dungeonId, difficulty, durationMs, playerCount: party.length, party });

const entries = [
  { runCount: 4, best: run(2, "DA_Dgn_136_Fire", 2, 872671, [aster, brin]) },
  { runCount: 1, best: run(5, "DA_Dgn_024_Darkness", 1, 883053, [aster, gone]) },
  { runCount: 2, best: run(7, "DA_Dgn_136_Fire", 3, 500000) }
];

function renderPanel() {
  const onOpenPlayer = vi.fn();
  const onError = vi.fn();
  render(<DungeonRunsPanel onOpenPlayer={onOpenPlayer} onError={onError} />);
  return { onOpenPlayer, onError };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dungeonsApi.leaderboard).mockResolvedValue({ capabilities: { dungeons: true }, entries });
  vi.mocked(dungeonsApi.runs).mockResolvedValue({ capabilities: { dungeons: true }, page: 0, pageSize: 50, totalCount: 0, totalRuns: 0, runs: [] });
});

describe("DungeonRunsPanel", () => {
  it("shows the leaderboard and filters it by dungeon on the client", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByText("3 dungeon and difficulty pairs · 7 runs")).toBeInTheDocument());
    expect(screen.getByText("14:33")).toBeInTheDocument();
    const firstCells = [...document.querySelectorAll('.dungeon-runs-table td[data-column="dungeon"]')].map((cell) => cell.textContent);
    expect(firstCells).toEqual(["Darkness", "Fire Lab", "Fire Lab"]);
    const dungeonSelect = screen.getByRole("combobox", { name: "Dungeon" });
    expect(within(dungeonSelect).getAllByRole("option").map((option) => option.textContent)).toEqual(["All Dungeons", "Darkness", "Fire Lab"]);
    fireEvent.change(dungeonSelect, { target: { value: "DA_Dgn_136_Fire" } });
    expect(screen.getByText("2 dungeon and difficulty pairs · 6 runs")).toBeInTheDocument();
    expect(within(screen.getByRole("combobox", { name: "Difficulty" })).getAllByRole("option").map((option) => option.textContent)).toEqual(["All Difficulties", "2", "3"]);
  });

  it("opens a party member's details and leaves deleted members as plain text", async () => {
    const { onOpenPlayer } = renderPanel();
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Aster" }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Brin" }));
    expect(onOpenPlayer).toHaveBeenCalledWith({ actorId: 38, characterName: "Brin" });
    expect(screen.getByText(/Controller 52/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Controller 52" })).not.toBeInTheDocument();
  });

  it("pages all runs from the server with the current filters", async () => {
    vi.mocked(dungeonsApi.runs).mockResolvedValue({
      capabilities: { dungeons: true }, page: 0, pageSize: 50, totalCount: 120, totalRuns: 300,
      runs: [run(9, "DA_Dgn_136_Fire", 2, 600000)]
    });
    renderPanel();
    await waitFor(() => expect(screen.getByText("3 dungeon and difficulty pairs · 7 runs")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("radio", { name: "All Runs" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Dungeon" }), { target: { value: "DA_Dgn_136_Fire" } });
    await waitFor(() => expect(dungeonsApi.runs).toHaveBeenLastCalledWith({ dungeonId: "DA_Dgn_136_Fire", difficulty: null, playerId: undefined, page: 0, pageSize: 50 }));
    expect(await screen.findByText("120 of 300 runs · Newest First")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(dungeonsApi.runs).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 })));
  });

  it("resolves a character name to a player filter and reports ambiguous names", async () => {
    vi.mocked(playersApi.list).mockResolvedValueOnce({ rows: [{ actor_id: 25, character_name: "Aster" }, { actor_id: 77, character_name: "Asterix" }], totalCount: 2, totalPlayers: 2, capabilities: {} });
    vi.mocked(playersApi.list).mockResolvedValueOnce({ rows: [{ actor_id: 25, character_name: "Aster" }, { actor_id: 77, character_name: "Asterion" }], totalCount: 2, totalPlayers: 2, capabilities: {} });
    renderPanel();
    await waitFor(() => expect(dungeonsApi.leaderboard).toHaveBeenCalled());
    const input = screen.getByPlaceholderText("Filter by Character Name or Actor ID");
    fireEvent.change(input, { target: { value: "aster" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(dungeonsApi.leaderboard).toHaveBeenCalledWith({ playerId: "25" }));
    expect(screen.getByText("Showing runs for")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "Ast" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("More than one player matches. Enter the full character name or actor ID.")).toBeInTheDocument();
  });

  it("never shows the previous player's leaderboard while the next one loads", async () => {
    let resolveSecond: (value: unknown) => void = () => {};
    vi.mocked(playersApi.list)
      .mockResolvedValueOnce({ rows: [{ actor_id: 25, character_name: "Aster" }], totalCount: 1, totalPlayers: 1, capabilities: {} })
      .mockResolvedValueOnce({ rows: [{ actor_id: 38, character_name: "Brin" }], totalCount: 1, totalPlayers: 1, capabilities: {} });
    vi.mocked(dungeonsApi.leaderboard).mockImplementation(async (filters = {}) => {
      if (filters.playerId === "25") return { capabilities: { dungeons: true }, entries: [entries[0]] };
      if (filters.playerId === "38") return new Promise((resolve) => { resolveSecond = resolve; }) as never;
      return { capabilities: { dungeons: true }, entries };
    });
    renderPanel();
    const input = await screen.findByLabelText("Filter by Character Name or Actor ID");
    fireEvent.change(input, { target: { value: "Aster" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("1 dungeon and difficulty pairs · 4 runs");
    fireEvent.change(input, { target: { value: "Brin" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Loading dungeon runs…", { selector: "p" });
    expect(screen.queryByText("1 dungeon and difficulty pairs · 4 runs")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".dungeon-runs-table tbody tr td[data-column]").length).toBe(0);
    resolveSecond({ capabilities: { dungeons: true }, entries: [entries[2]] });
    expect(await screen.findByText("1 dungeon and difficulty pairs · 2 runs")).toBeInTheDocument();
  });

  it("offers a retry when the first load fails", async () => {
    vi.mocked(dungeonsApi.leaderboard).mockRejectedValueOnce(new Error("boom"));
    const { onError } = renderPanel();
    expect(await screen.findByText("Dungeon runs couldn't be loaded.")).toBeInTheDocument();
    expect(onError).toHaveBeenCalledWith("boom");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("3 dungeon and difficulty pairs · 7 runs")).toBeInTheDocument();
  });

  it("exits loading and lets the user retry a failed player leaderboard", async () => {
    renderPanel();
    await screen.findByText("3 dungeon and difficulty pairs · 7 runs");
    vi.mocked(dungeonsApi.leaderboard).mockRejectedValueOnce(new Error("request failed"));
    fireEvent.change(screen.getByLabelText("Filter by Character Name or Actor ID"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Dungeon runs couldn't be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("Loading dungeon runs…")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("3 dungeon and difficulty pairs · 7 runs");
    expect(dungeonsApi.leaderboard).toHaveBeenLastCalledWith({ playerId: "25" });
  });

  it("does not apply a pending character lookup after Clear", async () => {
    let completeLookup!: (result: Awaited<ReturnType<typeof playersApi.list>>) => void;
    vi.mocked(playersApi.list).mockImplementationOnce(() => new Promise((resolve) => { completeLookup = resolve; }));
    renderPanel();
    await screen.findByText("3 dungeon and difficulty pairs · 7 runs");
    fireEvent.change(screen.getByLabelText("Filter by Character Name or Actor ID"), { target: { value: "Aster" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await act(async () => completeLookup({ rows: [{ actor_id: 25, character_name: "Aster" }], totalCount: 1, totalPlayers: 1, capabilities: {} }));
    expect(screen.queryByText("Showing runs for")).not.toBeInTheDocument();
    expect(dungeonsApi.leaderboard).not.toHaveBeenCalledWith({ playerId: "25" });
  });

  it("drops the applied player filter when a new search fails", async () => {
    vi.mocked(playersApi.list)
      .mockResolvedValueOnce({ rows: [{ actor_id: 25, character_name: "Aster" }], totalCount: 1, totalPlayers: 1, capabilities: {} })
      .mockResolvedValueOnce({ rows: [], totalCount: 0, totalPlayers: 0, capabilities: {} });
    renderPanel();
    const input = await screen.findByLabelText("Filter by Character Name or Actor ID");
    fireEvent.change(input, { target: { value: "Aster" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Showing runs for");
    fireEvent.change(input, { target: { value: "nobody" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("No player matches that name.")).toBeInTheDocument();
    expect(screen.queryByText("Showing runs for")).not.toBeInTheDocument();
  });

  it("explains when the database has no dungeon tables", async () => {
    vi.mocked(dungeonsApi.leaderboard).mockResolvedValue({ capabilities: { dungeons: false }, reason: "Unsupported" });
    renderPanel();
    expect(await screen.findByText("Dungeon runs aren't available on this database version.")).toBeInTheDocument();
  });
});
