import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApi } from "../../api/admin";
import { playersApi } from "../../api/players";
import type { Task } from "../../api/setup";
import { CharacterAdminUI } from "./CharacterAdminUI";

vi.mock("../../api/admin", () => ({
  adminApi: {
    itemCatalog: vi.fn(),
    skillModules: vi.fn(),
    structuredVehicles: vi.fn()
  }
}));

vi.mock("../../api/players", () => ({
  playersApi: {
    inventory: vi.fn(),
    journey: vi.fn(),
    specs: vi.fn(),
    giveItems: vi.fn(),
    addCurrency: vi.fn(),
    setSkillModule: vi.fn(),
    setSkillPoints: vi.fn(),
    spawnVehicle: vi.fn()
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
  vi.mocked(adminApi.structuredVehicles).mockResolvedValue({ vehicles: [] });
  vi.mocked(adminApi.skillModules).mockResolvedValue({
    stdout: "Energy Capsule [Trooper]\n  id: Skills.Ability.EnergyCapsule\n  max level: 1"
  });
  vi.mocked(playersApi.inventory).mockResolvedValue({} as Awaited<ReturnType<typeof playersApi.inventory>>);
  vi.mocked(playersApi.journey).mockResolvedValue({ capabilities: {}, rows: { story: [
    { id: "parent", name: "Journey Parent", category: "Story", depth: 0, parentId: "" },
    { id: "child", name: "Journey Child", category: "Story", depth: 1, parentId: "parent" }
  ] } });
  vi.mocked(playersApi.specs).mockResolvedValue({ rows: [], skillModules: [], capabilities: {} });
  vi.mocked(playersApi.addCurrency).mockResolvedValue({ supported: true, result: {} });
});

describe("CharacterAdminUI Tank catalog", () => {
  it("uses centered icons and expands Journey children without changing their state", async () => {
    render(<CharacterAdminUI {...baseProps} detail={{ player: { actual_online_status: "Offline" } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Journey" }));
    fireEvent.click(await screen.findByRole("button", { name: "Story (2)" }));
    const expand = screen.getByRole("button", { name: "Expand" });
    expect(expand.querySelector("svg.lucide-plus")).toHaveAttribute("width", "12");
    expect(screen.queryByText("Journey Child")).toBeNull();
    fireEvent.click(expand);
    expect(screen.getByText("Journey Child")).toBeVisible();
    const collapse = screen.getByRole("button", { name: "Collapse" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    expect(collapse.querySelector("svg.lucide-minus")).toHaveAttribute("height", "12");
    fireEvent.click(collapse);
    expect(screen.queryByText("Journey Child")).toBeNull();
  });
  it("uses the standard spawn confirmation and honors cancellation", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    vi.mocked(adminApi.structuredVehicles).mockResolvedValue({ vehicles: [{ id: "Tank", name: "Tank", templates: ["T0"] }] });
    render(<CharacterAdminUI {...baseProps} confirmAction={confirm} detail={{ player: { actual_online_status: "Online" } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    await screen.findByRole("option", { name: "Tier 6 Booster Dart" });
    fireEvent.click(screen.getByRole("button", { name: "Spawn" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0]).toBe("Spawn Regis Tank / Tier 6 Booster Dart 20 meters in front of OfflinePlayer?");
    expect(playersApi.spawnVehicle).not.toHaveBeenCalled();
  });

  it("replaces the standard spawning message with success when the task completes", async () => {
    let complete!: (task: Task) => void;
    const waiting = vi.fn(() => new Promise<Task>((resolve) => { complete = resolve; }));
    const task: Task = { id: "tank-spawn", type: "admin", operation: "adminSpawnVehicle", status: "running", currentStep: "Running", progressMessage: "", logLines: [], warnings: [], startedAt: "2026-10-04T19:50:00Z", finishedAt: null, errorMessage: null };
    vi.mocked(adminApi.structuredVehicles).mockResolvedValue({ vehicles: [{ id: "Tank", name: "Tank", templates: ["T0"] }] });
    vi.mocked(playersApi.spawnVehicle).mockResolvedValue({ task });
    const confirm = vi.fn().mockResolvedValue(true);
    render(<CharacterAdminUI {...baseProps} confirmAction={confirm} waitForTask={waiting} detail={{ player: { actual_online_status: "Online" } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    await screen.findByRole("option", { name: "Tier 6 Booster Dart" });
    fireEvent.click(screen.getByRole("button", { name: "Spawn" }));
    expect(await screen.findByText("Spawning Regis Tank for OfflinePlayer")).toBeInTheDocument();
    await waitFor(() => expect(waiting).toHaveBeenCalled());
    complete({ ...task, status: "succeeded" });
    expect(await screen.findByText("Regis Tank (Tier 6 Booster Dart) was spawned 20 meters in front of OfflinePlayer.")).toBeInTheDocument();
    expect(screen.queryByText("Spawning Regis Tank for OfflinePlayer")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Spawn" })).toBeEnabled();
  });

  it("shows Regis Tank and six presets when enabled, even without a profile map", async () => {
    vi.mocked(adminApi.structuredVehicles).mockResolvedValue({ vehicles: [{ id: "Tank", name: "Tank", templates: ["T0", "T6_CombatDart", "T6_CombatFire", "T6_DartInventory", "T6_RocketInventory", "T6_FireInventory"] }] });
    render(<CharacterAdminUI {...baseProps} detail={{ player: { online_status: "Offline" } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    expect(await screen.findByRole("option", { name: "Regis Tank" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Tier 6 Booster Dart" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Tier 6 Booster Rocket" })).toBeInTheDocument();
    expect(screen.getAllByRole("option").filter((option) => option.textContent?.startsWith("Tier 6 "))).toHaveLength(6);
    expect(screen.getByRole("button", { name: "Spawn" })).toBeDisabled();
  });
});

describe("CharacterAdminUI currency schema", () => {
  it("uses the current House Credit option and stable currency id", async () => {
    render(<CharacterAdminUI
      {...baseProps}
      detail={{
        player: { actual_online_status: "Offline" },
        capabilities: { addCurrency: true },
        currencyOptions: [{ id: 0, label: "Solari Credit" }, { id: 1, label: "House Credit" }]
      }}
    />);

    const row = screen.getByText("Give Currency").closest(".playerAdmin_actionRow");
    expect(row).not.toBeNull();
    const select = row!.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "1" } });
    fireEvent.click(row!.querySelector("button") as HTMLButtonElement);

    await waitFor(() => expect(playersApi.addCurrency).toHaveBeenCalledWith("101", {
      currencyId: 1,
      amount: 100,
      confirmation: "ADD CURRENCY"
    }));
    expect(await screen.findByText("OfflinePlayer's House Credit was updated. Relog required.")).toBeInTheDocument();
  });
});

describe("CharacterAdminUI skill live grants", () => {
  it("does not let an offline player create an unsaved skill draft", async () => {
    render(<CharacterAdminUI
      {...baseProps}
      detail={{ player: { actual_online_status: "Offline" }, capabilities: {} }}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));

    expect(await screen.findByText("The player must be online to change skills or restore starter skills.")).toBeInTheDocument();
    const rankButton = await screen.findByRole("button", { name: "Set Energy Capsule rank 1" });
    await waitFor(() => expect(rankButton).toBeDisabled());
    expect(rankButton).toHaveAttribute("title", "The player must be online to change skills");

    fireEvent.click(rankButton);
    expect(screen.getByText("0 Unsaved Changes")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(playersApi.setSkillModule).not.toHaveBeenCalled();
  });
});

describe("CharacterAdminUI skill rank bars", () => {
  it("renders one rank bar per catalog max level, not the hardcoded card rank", async () => {
    // Weirding Step became a 3-rank skill in a later game build. The card table
    // in CharacterAdminUI is only a fallback; the catalog is what must win, so a
    // stale hardcoded rank must not cap the bars back down to one.
    vi.mocked(adminApi.skillModules).mockResolvedValue({
      stdout: "Weirding Step [BeneGesserit]\n  id: Skills.Ability.WeirdingStep\n  max level: 3"
    });

    render(<CharacterAdminUI
      {...baseProps}
      detail={{ player: { actual_online_status: "Online" }, capabilities: {} }}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bene Gesserit" }));

    expect(await screen.findByRole("button", { name: "Set Weirding Step rank 3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set Weirding Step rank 2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set Weirding Step rank 4" })).not.toBeInTheDocument();
  });
});

describe("CharacterAdminUI skill rank from points", () => {
  it("shows the resolved level, not the raw cumulative point cost", async () => {
    // A rank-2 Weirding Step stores SkillPointsSpent=5 (ladder 2/5/9). Reading
    // that number as the rank used to render 3/3 via the Math.min clamp.
    vi.mocked(adminApi.skillModules).mockResolvedValue({
      stdout: "Weirding Step [BeneGesserit]\n  id: Skills.Ability.WeirdingStep\n  max level: 3"
    });
    vi.mocked(playersApi.specs).mockResolvedValue({
      rows: [],
      capabilities: {},
      skillModules: [{ module_id: "Skills.Ability.WeirdingStep", skill_points_spent: 5, level: 2, max_level: 3 }]
    } as unknown as Awaited<ReturnType<typeof playersApi.specs>>);

    render(<CharacterAdminUI
      {...baseProps}
      detail={{ player: { actual_online_status: "Online" }, capabilities: {} }}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bene Gesserit" }));

    // Rank 2 of 3: clicking pip 2 would clear it, so its label reads "rank 0".
    expect(await screen.findByRole("button", { name: "Set Weirding Step rank 0" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Set Weirding Step rank 3" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set Weirding Step rank 2" })).not.toBeInTheDocument();
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
