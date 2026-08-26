import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { basesApi, type BasePermissionEntry, type BasePermissionRank } from "../../api/bases";
import { BasePermissionsTab } from "./BasePermissionsTab";

vi.mock("../../api/bases", () => ({
  basesApi: {
    permissions: vi.fn(),
    setPermissions: vi.fn(),
    transferToSystemCustodian: vi.fn(),
    permissionCandidates: vi.fn()
  }
}));

type SystemCustodian = { available: boolean; playerId?: string; name?: string; reason?: string };

function entry(playerId: string, name: string, rank: BasePermissionRank, canonical = true): BasePermissionEntry {
  return { playerId, name, rank, label: "", canonical };
}

function mockRoster(
  entries: BasePermissionEntry[],
  systemCustodian?: SystemCustodian,
  claim: { claimed?: boolean; unclaimedReason?: string } = {}
) {
  vi.mocked(basesApi.permissions).mockResolvedValue({
    supported: true,
    baseId: 1006,
    actorId: "1004",
    map: "DeepDesert",
    mapNameId: 7,
    systemCustodian,
    entries,
    ...claim
  } as never);
}

function renderTab(overrides: Partial<Parameters<typeof BasePermissionsTab>[0]> = {}) {
  const props = {
    baseId: "1006",
    baseName: "Sietch One",
    onSaved: vi.fn(),
    confirmAction: vi.fn().mockResolvedValue(true),
    ...overrides
  };
  render(<BasePermissionsTab {...props} />);
  return props;
}

// The Owner is in the hero card, everyone else is in the roster, so waiting on
// the hero name is the single "the tab has loaded" signal every test needs.
function ownerName() {
  return document.querySelector(".bases-permissions-owner-name");
}

const DEFAULT_ROSTER = [
  entry("4", "DarkShark", 1),
  entry("29", "Yaida", 2),
  entry("31", "Stilgar", 3)
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BasePermissionsTab layout", () => {
  it("puts the Owner in the hero card and everyone else in the roster", async () => {
    mockRoster(DEFAULT_ROSTER);
    renderTab();

    expect(await screen.findByText("DarkShark", { selector: ".bases-permissions-owner-name" })).toBeInTheDocument();
    // The Owner has no rank control and no remove button -- promoting someone
    // else is the only way to change who owns the base.
    expect(screen.queryByRole("radiogroup", { name: "Rank for DarkShark" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove DarkShark" })).not.toBeInTheDocument();

    expect(screen.getAllByRole("radiogroup")).toHaveLength(2);
    expect(screen.getByRole("radiogroup", { name: "Rank for Yaida" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Rank for Stilgar" })).toBeInTheDocument();
  });

  it("checks exactly the segment matching each player's rank", async () => {
    mockRoster(DEFAULT_ROSTER);
    renderTab();
    await screen.findByRole("radio", { name: "Co-Owner for Yaida" });

    expect(screen.getByRole("radio", { name: "Owner for Yaida" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Co-Owner for Yaida" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Associate for Yaida" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Associate for Stilgar" })).toBeChecked();
  });

  // Regression test for the radio `name` attribute. If two rows shared one group
  // name the browser would treat them as one set, and selecting a rank in one
  // row would silently clear the other's.
  it("keeps each row's rank group independent of the others", async () => {
    mockRoster(DEFAULT_ROSTER);
    renderTab();

    fireEvent.click(await screen.findByRole("radio", { name: "Associate for Yaida" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Associate for Yaida" })).toBeChecked());
    expect(screen.getByRole("radio", { name: "Associate for Stilgar" })).toBeChecked();
  });

  it("swaps the hero and the roster on promote, and swaps them back", async () => {
    mockRoster(DEFAULT_ROSTER);
    renderTab();

    fireEvent.click(await screen.findByRole("radio", { name: "Owner for Yaida" }));
    await waitFor(() => expect(ownerName()).toHaveTextContent("Yaida"));
    expect(screen.getByRole("radio", { name: "Co-Owner for DarkShark" })).toBeChecked();

    fireEvent.click(screen.getByRole("radio", { name: "Owner for DarkShark" }));
    await waitFor(() => expect(ownerName()).toHaveTextContent("DarkShark"));
    expect(screen.getByRole("radio", { name: "Co-Owner for Yaida" })).toBeChecked();
  });

  it.each([
    { entries: [entry("4", "DarkShark", 1), entry("29", "Yaida", 2), entry("31", "Stilgar", 3), entry("32", "Chani", 3)], count: "Shared with · 3", meta: "1 co-owner, 2 associates" },
    { entries: [entry("4", "DarkShark", 1), entry("31", "Stilgar", 3)], count: "Shared with · 1", meta: "1 associate" },
    { entries: [entry("4", "DarkShark", 1), entry("29", "Yaida", 2), entry("30", "Duncan", 2)], count: "Shared with · 2", meta: "2 co-owners" }
  ])("summarises the roster as $count / $meta", async ({ entries, count, meta }) => {
    mockRoster(entries);
    renderTab();
    expect(await screen.findByText(count)).toBeInTheDocument();
    expect(screen.getByText(meta)).toBeInTheDocument();
  });

  it("renders no breakdown at all when the base is shared with nobody", async () => {
    mockRoster([entry("4", "DarkShark", 1)]);
    renderTab();
    expect(await screen.findByText("Shared with · 0")).toBeInTheDocument();
    expect(document.querySelector(".bases-permissions-section-meta")).toBeNull();
    expect(screen.getByText("This base is not shared with anyone else.")).toBeInTheDocument();
  });

  it("does not reserve empty banner space on a clean roster", async () => {
    mockRoster(DEFAULT_ROSTER);
    renderTab();
    await screen.findByText("Shared with · 2");
    expect(document.querySelector(".bases-permissions-banner-slot")).toBeNull();
  });

  it("clears the player search after adding a result", async () => {
    mockRoster(DEFAULT_ROSTER);
    vi.mocked(basesApi.permissionCandidates).mockResolvedValue({
      rows: [{ playerId: "32", name: "Chani" }]
    } as never);
    renderTab();

    const search = await screen.findByPlaceholderText("Search a player to add");
    fireEvent.change(search, { target: { value: "Chani" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add Chani" }));

    await waitFor(() => expect(search).toHaveValue(""));
    expect(screen.queryByRole("button", { name: "Add Chani" })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Associate for Chani" })).toBeChecked();
  });
});

describe("BasePermissionsTab ranks the editor cannot represent", () => {
  // permission_set_player_rank is a plain upsert, so a base the game wrote
  // directly can carry two rank-1 rows. Filtering the roster by rank would drop
  // the second from the screen while leaving it in the draft that Save submits.
  it("keeps a duplicate Owner row visible and removable", async () => {
    mockRoster([entry("4", "DarkShark", 1), entry("9", "Shadout", 1), entry("31", "Stilgar", 3)]);
    renderTab();

    expect(await screen.findByText("DarkShark", { selector: ".bases-permissions-owner-name" })).toBeInTheDocument();
    // The second rank-1 row is on the roster rather than silently dropped.
    expect(screen.getByRole("radiogroup", { name: "Rank for Shadout" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Shadout" })).toBeEnabled();
    expect(screen.getByText("Shared with · 2")).toBeInTheDocument();
    // Not "1 associate" -- a rank-1 row is not an Associate.
    expect(screen.getByText("1 associate, 1 of another rank")).toBeInTheDocument();
  });

  it("resolves a duplicate Owner by promoting it", async () => {
    mockRoster([entry("4", "DarkShark", 1), entry("9", "Shadout", 1)]);
    renderTab();

    fireEvent.click(await screen.findByRole("radio", { name: "Owner for Shadout" }));
    await waitFor(() => expect(ownerName()).toHaveTextContent("Shadout"));
    expect(screen.getByRole("radio", { name: "Co-Owner for DarkShark" })).toBeChecked();
    expect(screen.queryByText(/of another rank/)).not.toBeInTheDocument();
  });

  // listBasePermissions selects par.rank with no filter, and duneDb.js keeps a
  // `Rank ${n}` label fallback precisely because ranks outside 1-3 occur.
  it("surfaces a rank outside 1-3 instead of rendering a blank control", async () => {
    const odd = { ...entry("31", "Stilgar", 7 as never), label: "Rank 7" };
    mockRoster([entry("4", "DarkShark", 1), entry("29", "Yaida", 2), odd]);
    renderTab();

    expect(await screen.findByText("Rank 7")).toBeInTheDocument();
    // No segment claims to represent it.
    expect(screen.getByRole("radio", { name: "Owner for Stilgar" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Co-Owner for Stilgar" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Associate for Stilgar" })).not.toBeChecked();
    // Counted apart from the associates rather than swelling their tally.
    expect(screen.getByText("1 co-owner, 1 of another rank")).toBeInTheDocument();
  });
});

describe("BasePermissionsTab ownerless state", () => {
  it("flags a base with no Owner and refuses to save it", async () => {
    mockRoster([entry("29", "Yaida", 2)]);
    renderTab();

    expect(await screen.findByText("No Owner set")).toBeInTheDocument();
    expect(document.querySelector(".bases-permissions-owner-card")).toHaveClass("bases-permissions-owner-card-empty");
    expect(screen.getByRole("alert")).toHaveTextContent("This base has no Owner.");

    // Dirty but still unsaveable -- the missing Owner is the blocker, not the
    // absence of edits.
    fireEvent.click(screen.getByRole("radio", { name: "Associate for Yaida" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });
});

// An unclaimed base has no dune.permission_actor row, so every rank write
// against it fails the permission_actor_rank foreign key. On screen it is
// indistinguishable from an ordinary ownerless base, and Transfer -- the
// control that exists to resolve ownerlessness -- was the shortest path to a
// raw PostgreSQL constraint error.
describe("BasePermissionsTab unclaimed base", () => {
  const UNCLAIMED = "This base is not claimed -- it has no dune.permission_actor row.";

  it("explains the unclaimed state and blocks every write, Transfer included", async () => {
    mockRoster([], { available: true, playerId: "900000201", name: "Server" }, {
      claimed: false,
      unclaimedReason: UNCLAIMED
    });
    renderTab();

    expect(await screen.findByText(UNCLAIMED)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Transfer to Server" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    // The generic "set an Owner" prompt would describe an action that cannot be
    // completed here, so the reason that can be acted on stands alone.
    expect(screen.queryByText(/This base has no Owner/)).not.toBeInTheDocument();
  });

  it("leaves the roster read-only rather than letting edits accumulate", async () => {
    mockRoster(DEFAULT_ROSTER, undefined, { claimed: false, unclaimedReason: UNCLAIMED });
    renderTab();

    await screen.findByText(UNCLAIMED);
    expect(screen.getByRole("radio", { name: "Associate for Yaida" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Yaida" })).toBeDisabled();
  });

  // An API that predates the flag omits it. Reading that as unclaimed would
  // disable editing on every base it serves.
  it("treats a missing flag as claimed", async () => {
    mockRoster(DEFAULT_ROSTER);
    renderTab();

    await screen.findByText("DarkShark", { selector: ".bases-permissions-owner-name" });
    expect(screen.getByRole("radio", { name: "Associate for Yaida" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove Yaida" })).toBeEnabled();
  });
});

describe("BasePermissionsTab system custodian", () => {
  it("shows the custodian pill in the hero when the custodian owns the base", async () => {
    mockRoster(
      [entry("900000201", "Server", 1), entry("29", "Yaida", 2)],
      { available: true, playerId: "900000201", name: "Server" }
    );
    renderTab();

    await screen.findByText("Server", { selector: ".bases-permissions-owner-name" });
    expect(ownerName()?.querySelector(".bases-permissions-system-label")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Owned by Server" })).toBeDisabled();
  });

  it("shows the custodian pill on the roster row when the custodian is not the Owner", async () => {
    mockRoster(
      [entry("4", "DarkShark", 1), entry("900000201", "Server", 3)],
      { available: true, playerId: "900000201", name: "Server" }
    );
    renderTab();

    await screen.findByText("DarkShark", { selector: ".bases-permissions-owner-name" });
    expect(ownerName()?.querySelector(".bases-permissions-system-label")).toBeNull();
    expect(document.querySelector(".bases-permissions-row .bases-permissions-system-label")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Transfer to Server" })).toBeEnabled();
  });

  // The reason paragraph moved into the hero card when the standalone custodian
  // section was absorbed. It is the easiest thing to lose in that refactor.
  it("keeps the unavailability reason inside the owner card", async () => {
    mockRoster(
      [entry("4", "DarkShark", 1)],
      { available: false, reason: "No supported system custodian was found." }
    );
    renderTab();

    const reason = await screen.findByText("No supported system custodian was found.");
    expect(document.querySelector(".bases-permissions-owner-card")).toContainElement(reason);
    expect(screen.getByRole("button", { name: "Transfer to Custodian" })).toBeDisabled();
  });

  it("removes the custodian from the roster, rather than demoting it, when another player is promoted to Owner", async () => {
    mockRoster(
      [entry("900000201", "Server", 1), entry("29", "Yaida", 3)],
      { available: true, playerId: "900000201", name: "Server" }
    );
    renderTab();

    fireEvent.click(await screen.findByRole("radio", { name: "Owner for Yaida" }));

    await waitFor(() => expect(ownerName()).toHaveTextContent("Yaida"));
    expect(screen.queryByText("Server")).not.toBeInTheDocument();
    expect(screen.getByText("Shared with · 0")).toBeInTheDocument();
  });

  it("removes the custodian from the roster, rather than demoting it, when a new player is added directly as Owner", async () => {
    mockRoster(
      [entry("900000201", "Server", 1), entry("29", "Yaida", 3)],
      { available: true, playerId: "900000201", name: "Server" }
    );
    vi.mocked(basesApi.permissionCandidates).mockResolvedValue({
      rows: [{ playerId: "32", name: "Chani" }]
    } as never);
    renderTab();

    await screen.findByText("Yaida", { selector: ".bases-permissions-name" });
    fireEvent.change(screen.getByLabelText("Add as"), { target: { value: "1" } });
    fireEvent.change(screen.getByPlaceholderText("Search a player to add"), { target: { value: "Chani" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add Chani" }));

    await waitFor(() => expect(ownerName()).toHaveTextContent("Chani"));
    expect(screen.queryByText("Server")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Associate for Yaida" })).toBeChecked();
  });
});

describe("BasePermissionsTab entry warnings", () => {
  // Only covered for an Associate before -- an Owner the game ignores is the
  // more urgent case, because the base is effectively unowned in-game.
  it("flags a non-canonical Owner from inside the hero card", async () => {
    mockRoster([entry("4", "DarkShark", 1, false), entry("29", "Yaida", 2)]);
    renderTab();

    const warning = await screen.findByLabelText("Ignored by the game");
    expect(document.querySelector(".bases-permissions-owner-card")).toContainElement(warning);
  });
});

describe("BasePermissionsTab saving", () => {
  it("disables every control while a save is in flight", async () => {
    mockRoster(DEFAULT_ROSTER);
    // Never resolves, so the saving state stays observable.
    vi.mocked(basesApi.setPermissions).mockReturnValue(new Promise(() => {}) as never);
    renderTab();

    fireEvent.click(await screen.findByRole("radio", { name: "Associate for Yaida" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Saving…" })).toBeInTheDocument());
    screen.getAllByRole("radio").forEach((radio) => expect(radio).toBeDisabled());
    expect(screen.getByRole("button", { name: "Remove Yaida" })).toBeDisabled();
  });

  it("restores the original segment on Revert without calling the server", async () => {
    mockRoster(DEFAULT_ROSTER);
    renderTab();

    fireEvent.click(await screen.findByRole("radio", { name: "Associate for Yaida" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Revert" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));

    await waitFor(() => expect(screen.getByRole("radio", { name: "Co-Owner for Yaida" })).toBeChecked());
    expect(basesApi.setPermissions).not.toHaveBeenCalled();
  });
});

describe("BasePermissionsTab load states", () => {
  it("reports loading, then the roster", async () => {
    mockRoster(DEFAULT_ROSTER);
    renderTab();
    expect(screen.getByText("Loading permissions…")).toBeInTheDocument();
    expect(await screen.findByText("Shared with · 2")).toBeInTheDocument();
  });

  it("offers a working Retry when the roster fails to load", async () => {
    vi.mocked(basesApi.permissions).mockRejectedValueOnce(new Error("Permissions are unavailable."));
    renderTab();

    expect(await screen.findByText(/Permissions are unavailable\./)).toBeInTheDocument();
    mockRoster(DEFAULT_ROSTER);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Shared with · 2")).toBeInTheDocument();
    expect(basesApi.permissions).toHaveBeenCalledTimes(2);
  });
});
