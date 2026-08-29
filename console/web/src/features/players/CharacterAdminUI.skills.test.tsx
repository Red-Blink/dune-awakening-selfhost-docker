import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApi } from "../../api/admin";
import { playersApi } from "../../api/players";
import { CharacterAdminUI } from "./CharacterAdminUI";

vi.mock("../../api/admin", () => ({
  adminApi: {
    itemCatalog: vi.fn(),
    skillModules: vi.fn()
  }
}));

vi.mock("../../api/players", () => ({
  playersApi: {
    inventory: vi.fn(),
    specs: vi.fn(),
    giveItems: vi.fn(),
    setSkillModule: vi.fn(),
    setSkillPoints: vi.fn()
  }
}));

vi.mock("./PlayerSummary", () => ({ PlayerSummary: () => <div>Summary</div> }));
vi.mock("./PlayerDetailTab", () => ({ PlayerDetailTab: () => <div>Inventory</div> }));

const baseProps = {
  fallback: {},
  dbPlayerId: "101",
  actionPlayerId: "FLS_TEST",
  playerName: "OfflinePlayer",
  onError: vi.fn(),
  onRefresh: vi.fn(),
  onClose: vi.fn(),
  confirmAction: vi.fn().mockResolvedValue(true),
  waitForTask: vi.fn(),
  formatMutationResult: vi.fn().mockReturnValue("Action completed."),
  restartGate: vi.fn().mockResolvedValue("immediate" as const)
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(adminApi.itemCatalog).mockResolvedValue({ rows: [] });
  vi.mocked(adminApi.skillModules).mockResolvedValue({
    stdout: "Energy Capsule [Trooper]\n  id: Skills.Ability.EnergyCapsule\n  max level: 1"
  });
  vi.mocked(playersApi.inventory).mockResolvedValue({} as Awaited<ReturnType<typeof playersApi.inventory>>);
  vi.mocked(playersApi.specs).mockResolvedValue({ rows: [], skillModules: [], capabilities: {} });
});

describe("CharacterAdminUI skill live grants", () => {
  it("does not let an offline player create an unsaved skill draft", async () => {
    render(<CharacterAdminUI
      {...baseProps}
      detail={{ player: { actual_online_status: "Offline" }, capabilities: {} }}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));

    expect(await screen.findByText("The player must be online to change skills or restore starter skills.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Set Energy Capsule rank 1" })).toBeDisabled());
    const rankButton = screen.getByRole("button", { name: "Set Energy Capsule rank 1" });
    expect(rankButton).toHaveAttribute("title", "The player must be online to change skills");

    fireEvent.click(rankButton);
    expect(screen.getByText("0 Unsaved Changes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(playersApi.setSkillModule).not.toHaveBeenCalled();
  });
});

describe("CharacterAdminUI item grant results", () => {
  it("shows the API partial-delivery message instead of unconditional success", async () => {
    vi.mocked(adminApi.itemCatalog).mockResolvedValue({
      rows: [{ id: "T1_Augment_Test", itemId: "T1_Augment_Test", name: "Test Augment", category: "augments", source: "Augments" }]
    });
    vi.mocked(playersApi.giveItems).mockResolvedValue({
      ok: true,
      results: [],
      message: "Only 500 of the requested 1,000 could be granted because the player's inventory ran out of free item slots."
    });
    const formatMutationResult = vi.fn((result: unknown) => {
      const record = result && typeof result === "object" ? result as { message?: string } : {};
      return record.message || "Action completed.";
    });

    render(<CharacterAdminUI
      {...baseProps}
      formatMutationResult={formatMutationResult}
      detail={{ player: { actual_online_status: "Offline" }, capabilities: {} }}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Give Items" }));
    fireEvent.click(await screen.findByRole("button", { name: /Test Augment/ }));
    fireEvent.click(screen.getByRole("button", { name: "Give Item" }));

    expect(await screen.findByText(/Only 500 of the requested 1,000 could be granted/)).toBeInTheDocument();
    expect(screen.queryByText("1 item entry was granted to OfflinePlayer.")).not.toBeInTheDocument();
    expect(formatMutationResult).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Only 500") }));
  });
});
