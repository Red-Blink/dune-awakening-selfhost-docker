import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playersApi } from "../../api/players";
import { mapsApi } from "../../api/maps";
import { invalidateInstanceNames } from "../maps/instanceNames";
import { PlayersPanel } from "./PlayersPanel";
import { combatApi } from "../../api/combat";
vi.mock("../../api/combat", () => ({ combatApi: { history: vi.fn().mockResolvedValue({ supported: true, status: "recording", leaderboard: [], recentKills: [] }) } }));

vi.mock("../../api/maps", () => ({ mapsApi: { sietchDimensions: vi.fn() } }));

vi.mock("../../api/players", () => ({
  playersApi: {
    list: vi.fn(),
    listSettings: vi.fn(),
    saveListSettings: vi.fn(),
    profile: vi.fn(),
    deletedCharacters: vi.fn()
  }
}));
vi.mock("../../api/vehicles", () => ({ vehiclesApi: { deleteVehicle: vi.fn(), pendingDeletes: vi.fn().mockResolvedValue({ supported: true, total: 0, pending: [], byTarget: [] }) } }));

const bannedPlayer = {
  actor_id: "82",
  character_name: "Vixen",
  last_seen: "2026-08-07T10:00:00Z",
  actual_online_status: "Online",
  online_status: "Banned",
  is_banned: true,
  map: "HaggaBasin",
  partition_id: 1,
  partitionMap: "Survival_1",
  fls_id: "254A06043E9F0B16",
  total_playtime_seconds: 3665
};

it('hides PvP on a confirmed PvE-only server in both Players views', async () => {
  vi.mocked(playersApi.listSettings).mockResolvedValue({
    settings: { inactiveWeeks: null }, defaults: { inactiveWeeks: null },
    limits: { inactiveWeeks: { min: 1, max: 8 } }, source: 'default', pvpVisible: false
  });
  render(<PlayersPanel onError={vi.fn()} renderCharacterAdmin={() => null} />);
  expect(await screen.findByText('Vixen')).toBeInTheDocument();
  await waitFor(() => expect(playersApi.listSettings).toHaveBeenCalled());
  expect(screen.queryByRole('radio', { name: 'PvP' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: 'Deleted Characters' }));
  expect(screen.queryByRole('radio', { name: 'PvP' })).not.toBeInTheDocument();
});

it('removes an open PvP view after modes change without resetting the player filter', async () => {
  vi.useFakeTimers();
  render(<PlayersPanel onError={vi.fn()} renderCharacterAdmin={() => null} />);
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByRole('radio', { name: 'PvP' }));
  vi.mocked(playersApi.listSettings).mockResolvedValue({
    settings: { inactiveWeeks: null }, defaults: { inactiveWeeks: null },
    limits: { inactiveWeeks: { min: 1, max: 8 } }, source: 'default', pvpVisible: false
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(screen.queryByRole('radio', { name: 'PvP' })).not.toBeInTheDocument();
  expect(screen.getByRole('radio', { name: 'Active Players' })).toBeChecked();
});

beforeEach(() => {
  vi.clearAllMocks();
  invalidateInstanceNames();
  vi.mocked(mapsApi.sietchDimensions).mockResolvedValue({ stdout: "", exitCode: 1 } as never);
  vi.mocked(playersApi.list).mockResolvedValue({
    rows: [bannedPlayer],
    totalCount: 1,
    totalPlayers: 1,
    capabilities: { statusFilterApplied: true }
  });
  vi.mocked(playersApi.listSettings).mockResolvedValue({
    settings: { inactiveWeeks: null },
    defaults: { inactiveWeeks: null },
    limits: { inactiveWeeks: { min: 1, max: 8 } },
    source: "default",
    canConfigure: true
  });
  vi.mocked(playersApi.saveListSettings).mockResolvedValue({
    settings: { inactiveWeeks: null },
    defaults: { inactiveWeeks: null },
    limits: { inactiveWeeks: { min: 1, max: 8 } },
    source: "console",
    canConfigure: true
  });
  vi.mocked(playersApi.profile).mockResolvedValue({ player: bannedPlayer });
  vi.mocked(playersApi.deletedCharacters).mockResolvedValue({
    supported: true,
    capabilities: { deletedCharacters: true },
    characters: [],
    unattributed: { bases: [], vehicles: [] },
    totals: {
      deletedCharacters: 0,
      deletedCharactersHoldingAssets: 0,
      deletedCharactersWithoutAssets: 0,
      attributedBases: 0,
      attributedVehicles: 0,
      unattributedBases: 0,
      unattributedVehicles: 0,
      orphanedBases: 0,
      orphanedVehicles: 0
    }
  });
});

it("opens PvP inside Players without continuing the hidden roster poll", async () => {
  vi.mocked(combatApi.history).mockResolvedValue({ supported: true, status: "recording", reason: "", selfOnly: false, recordingStartedAt: null, recordedSince: null, lastCapturedAt: null, leaderboard: [], recentKills: [] });
  render(<PlayersPanel onError={vi.fn()} renderCharacterAdmin={() => null} />);
  await screen.findByText("Vixen");
  fireEvent.click(screen.getByRole("radio", { name: "PvP" }));
  expect(await screen.findByText("No PvP kills have been recorded yet.")).toBeVisible();
  expect(screen.queryByText("Vixen")).toBeNull();
  expect(combatApi.history).toHaveBeenCalledWith(undefined, { leaderboardLimit: 10, killsLimit: 10 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PlayersPanel profile loading", () => {
  it("reports a failed profile load and never shows the previous player's profile", async () => {
    const onError = vi.fn();
    const other = { ...bannedPlayer, actor_id: "90", character_name: "Other" };
    vi.mocked(playersApi.list).mockResolvedValue({ rows: [bannedPlayer, other], totalCount: 2, totalPlayers: 2, capabilities: { statusFilterApplied: true } });
    vi.mocked(playersApi.profile).mockResolvedValueOnce({ player: bannedPlayer }).mockRejectedValueOnce(new Error("db down"));
    const seen: Array<{ id: string; detail: unknown }> = [];
    render(<PlayersPanel onError={onError} renderCharacterAdmin={(props) => { seen.push({ id: props.dbPlayerId, detail: props.detail }); return null; }} />);

    fireEvent.click(await screen.findByText("Vixen"));
    await waitFor(() => expect(seen.some((entry) => entry.id === "82" && entry.detail)).toBe(true));
    fireEvent.click(await screen.findByText("Other"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("db down")));
    expect(seen.filter((entry) => entry.id === "90").every((entry) => entry.detail === null)).toBe(true);
  });
});

describe("PlayersPanel persistent bans", () => {
  it("shows inactive players by default", async () => {
    render(<PlayersPanel onError={vi.fn()} renderCharacterAdmin={() => null} />);

    await waitFor(() => expect(playersApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ recentOnly: false })));
    expect(screen.getByLabelText("Hide Inactive Players After")).toHaveValue("never");
    expect(screen.getByRole("option", { name: "3 Weeks" })).toHaveValue("3");
  });

  it("applies a new inactive-player threshold immediately", async () => {
    vi.mocked(playersApi.saveListSettings).mockResolvedValueOnce({
      settings: { inactiveWeeks: 4 },
      defaults: { inactiveWeeks: null },
      limits: { inactiveWeeks: { min: 1, max: 8 } },
      source: "console",
      canConfigure: true
    });
    render(<PlayersPanel onError={vi.fn()} renderCharacterAdmin={() => null} />);

    const filter = await screen.findByLabelText("Hide Inactive Players After");
    await waitFor(() => expect(filter).toBeEnabled());
    fireEvent.change(filter, { target: { value: "4" } });
    await waitFor(() => expect(playersApi.saveListSettings).toHaveBeenCalledWith(4));
    await waitFor(() => expect(playersApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ page: 0, recentOnly: true })));
    expect(screen.getByLabelText("Hide Inactive Players After")).toHaveValue("4");
  });

  it("refreshes the player list when changing between inactive thresholds", async () => {
    vi.mocked(playersApi.listSettings).mockResolvedValueOnce({
      settings: { inactiveWeeks: 4 },
      defaults: { inactiveWeeks: null },
      limits: { inactiveWeeks: { min: 1, max: 8 } },
      source: "console",
      canConfigure: true
    });
    vi.mocked(playersApi.saveListSettings).mockResolvedValueOnce({
      settings: { inactiveWeeks: 8 },
      defaults: { inactiveWeeks: null },
      limits: { inactiveWeeks: { min: 1, max: 8 } },
      source: "console",
      canConfigure: true
    });
    render(<PlayersPanel onError={vi.fn()} renderCharacterAdmin={() => null} />);

    const filter = await screen.findByLabelText("Hide Inactive Players After");
    await waitFor(() => expect(filter).toHaveValue("4"));
    await waitFor(() => expect(filter).toBeEnabled());
    await waitFor(() => expect(playersApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ recentOnly: true })));
    vi.mocked(playersApi.list).mockClear();

    fireEvent.change(filter, { target: { value: "8" } });

    await waitFor(() => expect(playersApi.saveListSettings).toHaveBeenCalledWith(8));
    await waitFor(() => expect(playersApi.list).toHaveBeenCalledWith(expect.objectContaining({ page: 0, recentOnly: true })));
    expect(filter).toHaveValue("8");
  });

  it("shows the configured Sietch name next to the player's game map", async () => {
    vi.mocked(mapsApi.sietchDimensions).mockImplementation((_map?: string, wantIds?: boolean) => Promise.resolve({
      stdout: wantIds
        ? "1\n"
        : ["DIMENSION  DISPLAY NAME                     PASSWORD", "0          Sietch New                       (unset)"].join("\n"),
      exitCode: 0
    }) as never);

    render(<PlayersPanel onError={vi.fn()} renderCharacterAdmin={() => null} />);

    expect(await screen.findByText("HaggaBasin (Sietch New)")).toBeInTheDocument();
    expect(vi.mocked(mapsApi.sietchDimensions).mock.calls.map((call) => call[0])).toEqual(["Survival_1", "Survival_1"]);
  });

  it("expands the player list until a player detail is opened", async () => {
    render(<PlayersPanel
      onError={vi.fn()}
      renderCharacterAdmin={({ onClose }) => <button onClick={onClose}>Close player detail</button>}
    />);

    const tableWrap = await screen.findByRole("region", { name: "Scrollable data table" });
    expect(tableWrap).toHaveClass("players-table-wrap-expanded");
    expect(tableWrap).not.toHaveClass("players-table-wrap-compact");

    fireEvent.click(screen.getByText("Vixen"));
    await waitFor(() => expect(tableWrap).toHaveClass("players-table-wrap-compact"));
    expect(tableWrap).not.toHaveClass("players-table-wrap-expanded");

    fireEvent.click(screen.getByRole("button", { name: "Close player detail" }));
    await waitFor(() => expect(tableWrap).toHaveClass("players-table-wrap-expanded"));
  });

  it("renders banned status and requests the banned filter", async () => {
    render(<PlayersPanel onError={vi.fn()} renderCharacterAdmin={() => null} />);

    expect(await screen.findByText("Banned", { selector: ".player-status-cell span" })).toBeInTheDocument();
    expect(screen.getByText("Currently Active")).toBeInTheDocument();
    expect(screen.getByText("1h 1m")).toBeInTheDocument();
    const headers = screen.getAllByRole("columnheader").map((header) => header.textContent?.replace(/[↑↓]/g, "").trim());
    expect(headers.indexOf("Total Playtime")).toBe(headers.indexOf("Last Online") + 1);
    const filter = screen.getByLabelText("Filter");
    expect(screen.getByRole("option", { name: "Banned" })).toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "banned" } });

    await waitFor(() => expect(playersApi.list).toHaveBeenLastCalledWith(expect.objectContaining({ status: "banned" })));
  });

  it("automatically refreshes an open player profile", async () => {
    vi.useFakeTimers();
    render(<PlayersPanel onError={vi.fn()} renderCharacterAdmin={({ detail }) => <div data-testid="open-player-map">{String((detail?.player as Record<string, unknown> | undefined)?.map || "Loading")}</div>} />);
    await act(async () => { await Promise.resolve(); });

    fireEvent.click(screen.getByText("Vixen"));
    await act(async () => { await Promise.resolve(); });
    expect(playersApi.profile).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("open-player-map")).toHaveTextContent("HaggaBasin");

    vi.mocked(playersApi.profile).mockResolvedValue({ player: { ...bannedPlayer, map: "DeepDesert_1" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });

    expect(playersApi.profile).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("open-player-map")).toHaveTextContent("DeepDesert_1");
  });
});

describe("PlayersPanel view mode", () => {
  it("swaps the players list for the deleted-characters view", async () => {
    render(<PlayersPanel onError={vi.fn()} renderCharacterAdmin={() => null} />);
    expect(await screen.findByText("Vixen")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Deleted Characters" }));

    await waitFor(() => expect(screen.getByText("Unattributed Orphans")).toBeInTheDocument());
    // The players table, its filter and its search are gone, not merely hidden.
    expect(screen.queryByText("Vixen")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Filter")).not.toBeInTheDocument();
    expect(playersApi.deletedCharacters).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("radio", { name: "Active Players" }));
    expect(await screen.findByText("Vixen")).toBeInTheDocument();
  });

  it("stops polling the players list while the deleted view is open", async () => {
    vi.useFakeTimers();
    render(<PlayersPanel onError={vi.fn()} renderCharacterAdmin={() => null} />);
    await act(async () => { await Promise.resolve(); });

    const callsBefore = vi.mocked(playersApi.list).mock.calls.length;
    fireEvent.click(screen.getByRole("radio", { name: "Deleted Characters" }));
    await act(async () => { await Promise.resolve(); });

    // Three full refresh intervals with nobody looking at the players list.
    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    }
    expect(vi.mocked(playersApi.list).mock.calls.length).toBe(callsBefore);
  });

  it("closes an open player detail when leaving the players list", async () => {
    render(<PlayersPanel
      onError={vi.fn()}
      renderCharacterAdmin={() => <div data-testid="player-detail">Detail</div>}
    />);
    expect(await screen.findByText("Vixen")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Vixen"));
    await waitFor(() => expect(screen.getByTestId("player-detail")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("radio", { name: "Deleted Characters" }));
    await waitFor(() => expect(screen.queryByTestId("player-detail")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("radio", { name: "Active Players" }));
    expect(await screen.findByText("Vixen")).toBeInTheDocument();
    expect(screen.queryByTestId("player-detail")).not.toBeInTheDocument();
  });
});
