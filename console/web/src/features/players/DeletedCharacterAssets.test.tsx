import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { playersApi, type DeletedCharacterAsset, type DeletedCharacterAssetsResult } from "../../api/players";
import { vehiclesApi } from "../../api/vehicles";
import { mapsApi } from "../../api/maps";
import { invalidateInstanceNames } from "../maps/instanceNames";
import { DeletedCharacterAssets, deletionLabel } from "./DeletedCharacterAssets";
import { setConsoleAccess } from "../../lib/consoleAccess";

vi.mock("../../api/players", () => ({ playersApi: { deletedCharacters: vi.fn() } }));
vi.mock("../../api/vehicles", () => ({ vehiclesApi: { deleteVehicle: vi.fn(), pendingDeletes: vi.fn() } }));
vi.mock("../../api/maps", () => ({ mapsApi: { sietchDimensions: vi.fn() } }));

const deletedCharacters = vi.mocked(playersApi.deletedCharacters);

function asset(overrides: Partial<DeletedCharacterAsset> = {}): DeletedCharacterAsset {
  return {
    kind: "base",
    id: "3087",
    actorId: "3084",
    name: "Totem_Patent",
    assetType: "Advanced Sub-Fief",
    map: "HaggaBasin",
    partitionId: "1",
    partitionMap: "Survival_1",
    partitionLabel: "Sietch Abbir",
    x: -80832.2,
    y: -123618.4,
    z: 9472.4,
    pieceCount: 492,
    placeableCount: 41,
    moduleCount: null,
    characterStateId: "37",
    matchedBy: "Base Totem",
    ...overrides
  };
}

function result(overrides: Partial<DeletedCharacterAssetsResult> = {}): DeletedCharacterAssetsResult {
  return {
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
    },
    ...overrides
  };
}

const kitty = {
  characterStateId: "37",
  accountId: "985",
  characterName: "kitty",
  flsId: "fls-37",
  deletedAt: "2026-09-19T15:01:09.245Z",
  lastAvatarActivity: "2026-08-01T02:50:07.429Z",
  lastLoginTime: "2026-08-01T00:58:51.585Z",
  controllerId: "3023",
  pawnId: "3025",
  removalReason: "deleted in fls",
  removalEventTime: "2026-09-19T15:01:09.245Z",
  replacementCharacterName: "",
  bases: [asset()],
  vehicles: [asset({
    kind: "vehicle",
    id: "3063",
    actorId: "3063",
    name: "Sandbike",
    assetType: "Sandbike",
    pieceCount: null,
    placeableCount: null,
    moduleCount: 8,
    matchedBy: "Respawn Point"
  })]
};

describe("deletionLabel", () => {
  it("translates the game's removal reasons", () => {
    expect(deletionLabel("new char in fls")).toBe("Recreated Character");
    expect(deletionLabel("deleted in fls")).toBe("Deleted In FLS");
    expect(deletionLabel("")).toBe("Reason Unrecorded");
    expect(deletionLabel("something else")).toBe("Something Else");
  });
});

describe("DeletedCharacterAssets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateInstanceNames();
    vi.mocked(vehiclesApi.pendingDeletes).mockResolvedValue({ supported: true, total: 0, pending: [], byTarget: [] });
    vi.mocked(mapsApi.sietchDimensions).mockResolvedValue({ stdout: "", exitCode: 1 } as never);
  });

  it("shows only the permitted asset component without delete controls for a read-only account", async () => {
    setConsoleAccess("ready", { username: "viewer", displayName: "Viewer", tier: "moderator" }, ["players:read", "vehicles:read"]);
    deletedCharacters.mockResolvedValue(result({ characters: [kitty] }));
    render(<DeletedCharacterAssets confirmAction={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show Assets Held By kitty" }));
    expect(await screen.findByRole("heading", { name: "Vehicles" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Bases" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete / })).toBeNull();
    expect(vehiclesApi.deleteVehicle).not.toHaveBeenCalled();
  });

  it("lists a deleted character and expands to its bases and vehicles", async () => {
    vi.mocked(mapsApi.sietchDimensions).mockImplementation((_map?: string, wantIds?: boolean) => Promise.resolve({
      stdout: wantIds
        ? "1\n"
        : ["DIMENSION  DISPLAY NAME                     PASSWORD", "0          Desert Sanctuary                 (unset)"].join("\n"),
      exitCode: 0
    }) as never);
    deletedCharacters.mockResolvedValue(result({
      characters: [kitty],
      totals: {
        deletedCharacters: 2,
        deletedCharactersHoldingAssets: 1,
        deletedCharactersWithoutAssets: 1,
        attributedBases: 1,
        attributedVehicles: 1,
        unattributedBases: 0,
        unattributedVehicles: 0,
        orphanedBases: 1,
        orphanedVehicles: 1
      }
    }));

    render(<DeletedCharacterAssets />);

    await waitFor(() => expect(screen.getByText("kitty")).toBeTruthy());
    expect(screen.getByText("Deleted In FLS")).toBeTruthy();
    // Same date style as Active players' Last Online one toggle away: short
    // month, no seconds. Regression guard for the two views drifting apart.
    const deletedCell = screen.getByText(/2026/, { selector: "td" });
    expect(deletedCell.textContent).toMatch(/[A-Za-z]{3}/);
    expect(deletedCell.textContent).not.toMatch(/^\d+\/\d+\/\d+/);
    expect(deletedCell.textContent).not.toMatch(/:\d{2}:\d{2}/);
    expect(screen.getByText("1 base · 1 vehicle")).toBeTruthy();
    // The count of deleted characters holding nothing is stated rather than hidden.
    expect(screen.getByText(/1 other deleted character holds none/)).toBeTruthy();

    // Assets are behind the expanded row, not rendered up front.
    expect(screen.queryAllByText("Sandbike").length).toBe(0);
    fireEvent.click(screen.getByText("kitty"));
    // An unnamed vehicle shows its type as its name, so Name and Type both say
    // "Sandbike" -- match all rather than asserting a single node.
    await waitFor(() => expect(screen.getAllByText("Sandbike").length).toBe(2));
    expect(screen.getByText("Totem_Patent")).toBeTruthy();
    expect(screen.getByText("Base Totem")).toBeTruthy();
    expect(screen.getByText("Respawn Point")).toBeTruthy();
    expect(await screen.findAllByText("Desert Sanctuary")).toHaveLength(2);
    expect(screen.getByText("492 pieces")).toBeTruthy();
    expect(screen.getByText("8 modules")).toBeTruthy();
  });

  it("shows the unattributed toggle closed by default and opens it on request", async () => {
    deletedCharacters.mockResolvedValue(result());
    render(<DeletedCharacterAssets />);

    const toggle = await screen.findByRole("button", { name: /Unattributed Orphans/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("No unattributed bases.")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("No unattributed bases.")).toBeTruthy();
    expect(screen.getByText("No unattributed vehicles.")).toBeTruthy();
    expect(screen.getByText("No deleted characters are holding bases or vehicles.")).toBeTruthy();
  });

  it("lists orphans with no respawn record under unattributed", async () => {
    deletedCharacters.mockResolvedValue(result({
      unattributed: {
        bases: [],
        vehicles: [asset({
          kind: "vehicle",
          id: "3333",
          actorId: "3333",
          name: "Buggy",
          assetType: "Buggy",
          pieceCount: null,
          placeableCount: null,
          moduleCount: 11,
          characterStateId: "",
          matchedBy: ""
        })]
      },
      totals: {
        deletedCharacters: 1,
        deletedCharactersHoldingAssets: 0,
        deletedCharactersWithoutAssets: 1,
        attributedBases: 0,
        attributedVehicles: 0,
        unattributedBases: 0,
        unattributedVehicles: 1,
        orphanedBases: 0,
        orphanedVehicles: 1
      }
    }));

    render(<DeletedCharacterAssets />);

    fireEvent.click(await screen.findByRole("button", { name: /Unattributed Orphans/ }));
    await waitFor(() => expect(screen.getAllByText("Buggy").length).toBe(2));
    expect(screen.getByText("No Respawn Record")).toBeTruthy();
  });

  it("opens a base but deletes a vehicle without leaving the view", async () => {
    const onOpenBase = vi.fn();
    const confirmAction = vi.fn().mockResolvedValue(true);
    vi.mocked(vehiclesApi.deleteVehicle).mockResolvedValue({
      supported: true,
      backupCreated: true,
      result: { ok: true, vehicleId: 3063, deletedModuleCount: 8 }
    });
    deletedCharacters.mockResolvedValue(result({ characters: [kitty] }));

    render(<DeletedCharacterAssets onOpenBase={onOpenBase} confirmAction={confirmAction} />);

    await waitFor(() => expect(screen.getByText("kitty")).toBeTruthy());
    fireEvent.click(screen.getByText("kitty"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete Sandbike" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Delete Sandbike" }).closest("td")).toHaveClass("actions-column", "deleted-character-asset-actions");

    const baseOpen = screen.getByText("Open Base");
    fireEvent.click(baseOpen);
    expect(onOpenBase).toHaveBeenCalledWith("3087");
    fireEvent.click(screen.getByRole("button", { name: "Delete Sandbike" }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalledWith(
      expect.stringContaining("Sandbike"),
      expect.objectContaining({ title: "Delete Vehicle", confirmLabel: "Delete", danger: true })
    ));
    await waitFor(() => expect(vehiclesApi.deleteVehicle).toHaveBeenCalledWith("3063"));
    expect(await screen.findByText('"Sandbike" was deleted.')).toBeTruthy();
  });

  it("does not delete a vehicle when confirmation is canceled", async () => {
    const confirmAction = vi.fn().mockResolvedValue(false);
    deletedCharacters.mockResolvedValue(result({ characters: [kitty] }));
    render(<DeletedCharacterAssets confirmAction={confirmAction} />);

    fireEvent.click(await screen.findByText("kitty"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete Sandbike" }));

    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
    expect(vehiclesApi.deleteVehicle).not.toHaveBeenCalled();
  });

  it("marks a safely queued delete without removing the vehicle row", async () => {
    vi.mocked(vehiclesApi.deleteVehicle).mockResolvedValue({
      supported: true,
      backupCreated: false,
      result: { ok: true, vehicleId: 3063, queued: true, map: "HaggaBasin", partitionId: 1 }
    });
    deletedCharacters.mockResolvedValue(result({ characters: [kitty] }));
    render(<DeletedCharacterAssets confirmAction={vi.fn().mockResolvedValue(true)} />);

    fireEvent.click(await screen.findByText("kitty"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete Sandbike" }));

    expect(await screen.findByText(/Delete for "Sandbike" is queued/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete queued for Sandbike" })).toBeDisabled();
  });

  it("shows the reason when the schema does not support the view", async () => {
    deletedCharacters.mockResolvedValue(result({
      capabilities: { deletedCharacters: false },
      reason: "Unsupported by detected schema. Missing required table(s): dune.player_respawn_locations"
    }));

    render(<DeletedCharacterAssets />);

    await waitFor(() => expect(screen.getByText(/dune\.player_respawn_locations/)).toBeTruthy());
    expect(screen.queryByText("Unattributed Orphans")).toBeNull();
  });

  it("surfaces a fetch failure instead of rendering an empty view", async () => {
    deletedCharacters.mockRejectedValue(new Error("Postgres is unavailable."));

    render(<DeletedCharacterAssets />);

    await waitFor(() => expect(screen.getByText("Postgres is unavailable.")).toBeTruthy());
    expect(screen.queryByText("Unattributed Orphans")).toBeNull();
  });

  it("refetches on Refresh", async () => {
    deletedCharacters.mockResolvedValue(result());
    render(<DeletedCharacterAssets />);

    await waitFor(() => expect(deletedCharacters).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Refresh"));
    await waitFor(() => expect(deletedCharacters).toHaveBeenCalledTimes(2));
  });

  it("warns when results were capped", async () => {
    deletedCharacters.mockResolvedValue(result({ truncated: true }));
    render(<DeletedCharacterAssets />);

    await waitFor(() => expect(screen.getByText(/Results were capped/)).toBeTruthy());
  });

  it("exposes expansion to the keyboard, not just to a row click", async () => {
    deletedCharacters.mockResolvedValue(result({ characters: [kitty] }));
    render(<DeletedCharacterAssets />);
    await waitFor(() => expect(screen.getByText("kitty")).toBeTruthy());

    // The expanded row is the only place the per-asset Open buttons exist, so a
    // mouse-only disclosure would put them out of reach entirely.
    const toggle = screen.getByRole("button", { name: /Show Assets Held By kitty/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getAllByText("Sandbike").length).toBe(2));
    expect(screen.getByRole("button", { name: /Collapse Assets Held By kitty/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the current result on screen while refreshing", async () => {
    deletedCharacters.mockResolvedValue(result({ characters: [kitty] }));
    const { container } = render(<DeletedCharacterAssets />);
    await waitFor(() => expect(screen.getByText("kitty")).toBeTruthy());

    let release: (value: DeletedCharacterAssetsResult) => void = () => {};
    deletedCharacters.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    fireEvent.click(screen.getByText("Refresh"));

    // Mid-flight: the previous rows stay, no full-section spinner, and the
    // section reports itself busy rather than collapsing to nothing.
    await waitFor(() => expect(container.querySelector("[aria-busy='true']")).toBeTruthy());
    expect(screen.getByText("kitty")).toBeTruthy();
    expect(screen.getByText("Unattributed Orphans")).toBeTruthy();
    expect(screen.queryByText("Loading Deleted Characters")).toBeNull();

    release(result({ characters: [kitty] }));
    await waitFor(() => expect(container.querySelector("[aria-busy='false']")).toBeTruthy());
    expect(screen.getByText("kitty")).toBeTruthy();
  });

  it("shows the full loading panel only on the very first load", async () => {
    let release: (value: DeletedCharacterAssetsResult) => void = () => {};
    deletedCharacters.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    render(<DeletedCharacterAssets />);

    await waitFor(() => expect(screen.getByText("Loading Deleted Characters")).toBeTruthy());
    release(result({ characters: [kitty] }));
    await waitFor(() => expect(screen.getByText("kitty")).toBeTruthy());
    expect(screen.queryByText("Loading Deleted Characters")).toBeNull();
  });

  it("drops the expansion when a refresh no longer returns that character", async () => {
    deletedCharacters.mockResolvedValue(result({ characters: [kitty] }));
    render(<DeletedCharacterAssets />);
    await waitFor(() => expect(screen.getByText("kitty")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Show Assets Held By kitty/ }));
    await waitFor(() => expect(screen.getAllByText("Sandbike").length).toBe(2));

    deletedCharacters.mockResolvedValue(result({ characters: [] }));
    fireEvent.click(screen.getByText("Refresh"));
    await waitFor(() => expect(screen.queryByText("kitty")).toBeNull());

    // Coming back must not silently re-expand a row nobody clicked.
    deletedCharacters.mockResolvedValue(result({ characters: [kitty] }));
    fireEvent.click(screen.getByText("Refresh"));
    await waitFor(() => expect(screen.getByText("kitty")).toBeTruthy());
    expect(screen.queryAllByText("Sandbike").length).toBe(0);
    expect(screen.getByRole("button", { name: /Show Assets Held By kitty/ })).toBeTruthy();
  });

  it("survives a payload missing its asset arrays", async () => {
    // Unreachable from our own backend, but LazyTabBoundary wraps the whole
    // Players tab -- a bad payload from a proxy would take the tab down, not
    // just this sub-view.
    const malformed = { ...kitty, bases: undefined, vehicles: undefined } as unknown as typeof kitty;
    deletedCharacters.mockResolvedValue(result({ characters: [malformed] }));
    render(<DeletedCharacterAssets />);

    await waitFor(() => expect(screen.getByText("kitty")).toBeTruthy());
    expect(screen.getByText("0 bases · 0 vehicles")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Show Assets Held By kitty/ }));
    await waitFor(() => expect(screen.getByText("No bases.")).toBeTruthy());
    expect(screen.getByText("No vehicles.")).toBeTruthy();
  });
});
