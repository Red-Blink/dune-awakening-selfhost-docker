import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PlayerSummary } from "./PlayerSummary";
import { playersApi } from "../../api/players";

vi.mock("../../api/players", () => ({
  playersApi: {
    currency: vi.fn(),
    factions: vi.fn(),
    progression: vi.fn(),
    intel: vi.fn(),
    solarisCoin: vi.fn(),
    vitals: vi.fn(),
    dungeons: vi.fn()
  }
}));

const baseProps = {
  dbPlayerId: "91",
  actionPlayerId: "action-91"
};

async function settleSummaryLoad() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(playersApi.currency).mockResolvedValue({ rows: [], capabilities: {} });
  vi.mocked(playersApi.factions).mockResolvedValue({ rows: [], capabilities: {} });
  vi.mocked(playersApi.progression).mockResolvedValue({ capabilities: {} });
  vi.mocked(playersApi.intel).mockResolvedValue({ capabilities: {} });
  vi.mocked(playersApi.solarisCoin).mockResolvedValue({ capabilities: {} });
  vi.mocked(playersApi.vitals).mockResolvedValue({ capabilities: {} });
  vi.mocked(playersApi.dungeons).mockResolvedValue({ capabilities: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PlayerSummary", () => {
  describe("Faction fallback", () => {
    it("shows Neutral when no faction is assigned on player or fallback", async () => {
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      await settleSummaryLoad();
      expect(screen.getByText("Neutral")).toBeInTheDocument();
    });

    it("shows the real faction when present on the loaded player", async () => {
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette", faction: "Atreides" } }}
          fallback={{}}
        />
      );
      await settleSummaryLoad();
      expect(screen.getByText("Atreides")).toBeInTheDocument();
      expect(screen.queryByText("Neutral")).not.toBeInTheDocument();
    });

    it("uses the fallback faction before detail has loaded", async () => {
      render(
        <PlayerSummary
          {...baseProps}
          detail={null}
          fallback={{ faction: "Harkonnen" }}
        />
      );
      await settleSummaryLoad();
      expect(screen.getByText("Harkonnen")).toBeInTheDocument();
    });
  });

  describe("Guild fallback", () => {
    it("shows an em dash when no guild is assigned on player or fallback", async () => {
      const { container } = render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      await settleSummaryLoad();
      const guildMeta = container.querySelector(".summary-hero-guild");
      expect(guildMeta?.textContent).toContain("—");
    });

    it("shows the real guild when present on the loaded player", async () => {
      const { container } = render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette", guild: "House Corrino" } }}
          fallback={{}}
        />
      );
      await settleSummaryLoad();
      expect(screen.getByText("House Corrino")).toBeInTheDocument();
      const guildMeta = container.querySelector(".summary-hero-guild");
      expect(guildMeta?.textContent).toContain("House Corrino");
      expect(guildMeta?.textContent).not.toContain("—");
    });

    it("uses the fallback guild before detail has loaded", async () => {
      render(
        <PlayerSummary
          {...baseProps}
          detail={null}
          fallback={{ guild: "Spice Runners" }}
        />
      );
      await settleSummaryLoad();
      expect(screen.getByText("Spice Runners")).toBeInTheDocument();
    });
  });

  describe("Map fallback", () => {
    it("shows an em dash when no map is assigned on player or fallback", async () => {
      const { container } = render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      await settleSummaryLoad();
      const mapMeta = container.querySelector(".summary-hero-map");
      expect(mapMeta?.textContent).toContain("—");
    });

    it("shows the real map when present on the loaded player", async () => {
      const { container } = render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette", map: "Arrakis" } }}
          fallback={{}}
        />
      );
      await settleSummaryLoad();
      expect(screen.getByText("Arrakis")).toBeInTheDocument();
      const mapMeta = container.querySelector(".summary-hero-map");
      expect(mapMeta?.textContent).toContain("Arrakis");
      expect(mapMeta?.textContent).not.toContain("—");
    });
  });

  describe("Currency", () => {
    it("does not fetch currency/factions when there is no dbPlayerId", () => {
      render(
        <PlayerSummary
          {...baseProps}
          dbPlayerId=""
          detail={null}
          fallback={{}}
        />
      );
      expect(playersApi.currency).not.toHaveBeenCalled();
      expect(playersApi.factions).not.toHaveBeenCalled();
      expect(playersApi.progression).not.toHaveBeenCalled();
      expect(playersApi.intel).not.toHaveBeenCalled();
      expect(playersApi.solarisCoin).not.toHaveBeenCalled();
      expect(playersApi.vitals).not.toHaveBeenCalled();
    });

    it("renders each currency balance with its resolved label", async () => {
      vi.mocked(playersApi.currency).mockResolvedValue({
        rows: [
          { currency_id: 0, balance: 5000, label: "Solari Credit" },
          { currency_id: 1, balance: 250, label: "House Credit" }
        ],
        capabilities: {}
      });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        expect(screen.getByText("Solari Credit")).toBeInTheDocument();
        expect(screen.getByText((5000).toLocaleString())).toBeInTheDocument();
        expect(screen.getByText("House Credit")).toBeInTheDocument();
        expect(screen.getByText((250).toLocaleString())).toBeInTheDocument();
      });
    });

    it("renders nothing extra when currency and Solari Coin are both unsupported by the schema", async () => {
      vi.mocked(playersApi.currency).mockResolvedValue({ rows: [], capabilities: { currency: false }, reason: "Unsupported" });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        expect(playersApi.currency).toHaveBeenCalledWith("91");
      });
      expect(screen.queryByText("Solari Credit")).not.toBeInTheDocument();
    });

    it("orders Solari Credit, then Solari Coin, then Scrip", async () => {
      vi.mocked(playersApi.currency).mockResolvedValue({
        rows: [
          { currency_id: 0, balance: 5000, label: "Solari Credit" },
          { currency_id: 1, balance: 250, label: "Scrip" }
        ],
        capabilities: {}
      });
      vi.mocked(playersApi.solarisCoin).mockResolvedValue({ capabilities: { solarisCoin: true }, total: 30129 });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        expect(screen.getByText("Solari Coin")).toBeInTheDocument();
      });
      const labels = screen.getAllByText(/^(Solari Credit|Solari Coin|Scrip)$/).map((el) => el.textContent);
      expect(labels).toEqual(["Solari Credit", "Solari Coin", "Scrip"]);
    });
  });

  describe("Faction Reputation", () => {
    it("reloads reputation immediately when its refresh key changes", async () => {
      vi.mocked(playersApi.factions)
        .mockResolvedValueOnce({
          rows: [{ faction_id: 1, faction_name: "Atreides", reputation_amount: 500 }],
          capabilities: { factions: true }
        })
        .mockResolvedValue({
          rows: [{ faction_id: 1, faction_name: "Atreides", reputation_amount: 5200 }],
          capabilities: { factions: true }
        });
      const detail = { player: { character_name: "Benny Jesserette", faction: "Atreides" } };
      const { rerender } = render(
        <PlayerSummary {...baseProps} detail={detail} fallback={{}} refreshKey={0} />
      );

      expect(await screen.findByText("500")).toBeInTheDocument();
      rerender(<PlayerSummary {...baseProps} detail={detail} fallback={{}} refreshKey={1} />);

      expect(await screen.findByText("5,200")).toBeInTheDocument();
      expect(playersApi.factions).toHaveBeenCalledTimes(2);
    });

    it("renders each faction's reputation amount, distinct from the Faction row", async () => {
      vi.mocked(playersApi.factions).mockResolvedValue({
        rows: [
          { faction_id: 1, faction_name: "Atreides", reputation_amount: 500 },
          { faction_id: 2, faction_name: "Harkonnen", reputation_amount: 120 }
        ],
        capabilities: { factions: true }
      });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette", faction: "Neutral" } }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        expect(screen.getByText("Atreides")).toBeInTheDocument();
        expect(screen.getByText("500")).toBeInTheDocument();
        expect(screen.getByText("Harkonnen")).toBeInTheDocument();
        expect(screen.getByText("120")).toBeInTheDocument();
      });
    });

    it("shows estimated faction rank and a story progression limit when applicable", async () => {
      vi.mocked(playersApi.factions).mockResolvedValue({
        rows: [{ faction_id: 1, faction_name: "Atreides", reputation_amount: 5200, estimated_rank: 12, current_rank_limit: 4, rank_limited_by_progression: true }],
        capabilities: { factions: true, factionRanks: true }
      });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette", faction: "Atreides" } }}
          fallback={{}}
        />
      );
      expect(await screen.findByText("5,200")).toBeInTheDocument();
      const atreides = screen.getByRole("row", { name: "Atreides reputation" });
      expect(atreides).toHaveTextContent("Atreides5,200 Rep12 Est. Rank4 Story Limit");
    });

    it("offers the vendor-facing faction repair directly from the mismatched standing", async () => {
      const onRepairFactionReputation = vi.fn();
      vi.mocked(playersApi.factions).mockResolvedValue({
        rows: [{ faction_id: 1, faction_name: "Atreides", reputation_amount: 11600, estimated_rank: 18, reputation_in_sync: false }],
        capabilities: { factions: true, factionRanks: true }
      });
      render(<PlayerSummary {...baseProps} detail={{ player: { character_name: "Aurokon", faction: "Atreides" } }} fallback={{}} onRepairFactionReputation={onRepairFactionReputation} />);
      const repairButton = await screen.findByRole("button", { name: "Repair Faction" });
      fireEvent.click(repairButton);
      expect(onRepairFactionReputation).toHaveBeenCalledOnce();
      expect(screen.queryByText("Sync Required")).not.toBeInTheDocument();
    });

    it("offers faction repair when earned story progression is missing but reputation is synchronized", async () => {
      const onRepairFactionReputation = vi.fn();
      vi.mocked(playersApi.factions).mockResolvedValue({
        rows: [{ faction_id: 1, faction_name: "Atreides", reputation_amount: 12474, estimated_rank: 20, current_rank_limit: 2, rank_limited_by_progression: true, reputation_in_sync: true, progression_repair_available: true, progression_repair_target: 5 }],
        capabilities: { factions: true, factionRanks: true }
      });
      render(<PlayerSummary {...baseProps} detail={{ player: { character_name: "Aurokon", faction: "Atreides" } }} fallback={{}} onRepairFactionReputation={onRepairFactionReputation} />);
      const repairButton = await screen.findByRole("button", { name: "Repair Faction" });
      fireEvent.click(repairButton);
      expect(onRepairFactionReputation).toHaveBeenCalledOnce();
    });

    it("explains directly on the repair control when the player must log out first", async () => {
      vi.mocked(playersApi.factions).mockResolvedValue({
        rows: [{ faction_id: 1, faction_name: "Atreides", reputation_amount: 11600, estimated_rank: 18, reputation_in_sync: false }],
        capabilities: { factions: true, factionRanks: true }
      });
      render(<PlayerSummary {...baseProps} detail={{ player: { character_name: "Aurokon", faction: "Atreides" } }} fallback={{}} onRepairFactionReputation={vi.fn()} factionRepairDisabled />);
      expect(await screen.findByRole("button", { name: "Player Must Be Offline" })).toBeDisabled();
    });

    it("lists reputation standings under a Faction Standings sub-heading, separate from the alignment", async () => {
      vi.mocked(playersApi.factions).mockResolvedValue({
        rows: [{ faction_id: 1, faction_name: "Atreides", reputation_amount: 500 }],
        capabilities: { factions: true }
      });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette", faction: "Harkonnen" } }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        expect(screen.getByText("Faction Standings")).toBeInTheDocument();
      });
      const block = screen.getByText("Faction Standings").closest(".summary-block");
      expect(block).not.toBeNull();
      expect(block?.textContent).toContain("Alignment");
      expect(block?.textContent).toContain("Harkonnen");
      expect(block?.textContent).toContain("Atreides");
      expect(block?.textContent).toContain("500");
    });

    it("keeps the Faction Standings sub-heading visible even when the player has no standings", async () => {
      vi.mocked(playersApi.factions).mockResolvedValue({ rows: [], capabilities: { factions: true } });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette", faction: "Atreides" } }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        expect(screen.getByText("Faction Standings")).toBeInTheDocument();
      });
    });

    it("hides the Faction Standings sub-heading when the factions capability is unsupported", async () => {
      vi.mocked(playersApi.factions).mockResolvedValue({ rows: [], capabilities: {} });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette", faction: "Atreides" } }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        expect(screen.getByText("Alignment")).toBeInTheDocument();
      });
        expect(screen.queryByText("Faction Standings")).not.toBeInTheDocument();
    });
  });

  describe("Identity", () => {
    it("renders platform, Funcom, and FLS identifiers as a plain single-table block", async () => {
      render(
        <PlayerSummary
          {...baseProps}
          detail={{
            player: {
              character_name: "Benny Jesserette",
              platform_id: "76561197986776594",
              platform_name: "Steam",
              funcom_id: "FN1",
              fls_id: "user1"
            }
          }}
          fallback={{}}
        />
      );
      fireEvent.click(await screen.findByRole("button", { name: /Identity/ }));
      expect(screen.getByText("Steam ID")).toBeInTheDocument();

      expect(screen.getAllByText("Platform Identity")).toHaveLength(1);
      const identityBlock = screen.getByText("Platform Identity").closest(".summary-block");
      expect(identityBlock).not.toBeNull();

      const table = screen.getByText("Steam ID").closest("table");
      expect(table).not.toBeNull();
      expect(table!.querySelectorAll("tr")).toHaveLength(3);

      expect(screen.getByText("76561197986776594")).toBeInTheDocument();
      expect(screen.getByText("Funcom ID")).toBeInTheDocument();
      expect(screen.getByText("FN1")).toBeInTheDocument();
      expect(screen.getByText("FLS ID")).toBeInTheDocument();
      expect(screen.getByText("user1")).toBeInTheDocument();
    });
  });

  describe("Identity fold", () => {
    it("starts collapsed and shows both identity tables when opened", async () => {
      render(<PlayerSummary {...baseProps} detail={{ player: { character_name: "Benny Jesserette", fls_id: "user1" } }} fallback={{}} />);
      const toggle = await screen.findByRole("button", { name: /Identity/ });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByText("FLS ID")).not.toBeInTheDocument();
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("Platform Identity")).toBeInTheDocument();
      expect(screen.getByText("Database Identity")).toBeInTheDocument();
    });
  });

  describe("Database Identity", () => {
    it("renders DB Player, Account, Player Controller, and Player State in one table", async () => {
      render(
        <PlayerSummary
          {...baseProps}
          detail={{
            player: {
              character_name: "Benny Jesserette",
              account_id: 201,
              player_controller_id: 301,
              player_state_id: 102
            }
          }}
          fallback={{}}
        />
      );
      fireEvent.click(await screen.findByRole("button", { name: /Identity/ }));
      expect(screen.getByText("Account")).toBeInTheDocument();

      const block = screen.getByText("Database Identity").closest(".summary-block");
      expect(block).not.toBeNull();
      expect(screen.getByText("DB Player").closest(".summary-block")).toBe(block);
      expect(screen.getByText("Player State").closest(".summary-block")).toBe(block);

      const table = screen.getByText("Account").closest("table");
      expect(table).not.toBeNull();
      expect(table!.querySelectorAll("tr")).toHaveLength(4);

      const dbPlayerRow = screen.getByText("DB Player").closest("tr");
      expect(dbPlayerRow?.textContent).toContain("91");
    });

    it("shows zero-sentinel IDs as em dashes", async () => {
      render(
        <PlayerSummary
          {...baseProps}
          detail={{
            player: {
              character_name: "Benny Jesserette",
              account_id: 0,
              player_controller_id: 0,
              player_state_id: 0,
              fls_id: "user1"
            }
          }}
          fallback={{}}
        />
      );
      fireEvent.click(await screen.findByRole("button", { name: /Identity/ }));
      const accountRow = screen.getByText("Account").closest("tr");
      expect(accountRow?.textContent).toContain("—");
      const controllerRow = screen.getByText("Player Controller").closest("tr");
      expect(controllerRow?.textContent).toContain("—");
      const stateRow = screen.getByText("Player State").closest("tr");
      expect(stateRow?.textContent).toContain("—");
    });
  });

  describe("Progression", () => {
    it("renders Level, XP, and Skill Points when progression is supported", async () => {
      vi.mocked(playersApi.progression).mockResolvedValue({
        capabilities: { progression: true },
        level: 11,
        xp: 4790,
        totalSkillPoints: 12,
        unspentSkillPoints: 3
      });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        const levelTile = screen.getByText("Level").closest(".summary-stat-level");
        expect(levelTile).not.toBeNull();
        expect(levelTile?.querySelector("strong")).toHaveTextContent("11");
        expect(levelTile?.querySelector("small")).toHaveTextContent(`${(4790).toLocaleString()} XP`);
        expect(screen.getByText("Skill Points")).toBeInTheDocument();
        expect(screen.getByText("3 / 12")).toBeInTheDocument();
      });
    });

    it("renders nothing extra when progression is unsupported by the schema", async () => {
      vi.mocked(playersApi.progression).mockResolvedValue({ capabilities: { progression: false }, reason: "Unsupported" });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        expect(playersApi.progression).toHaveBeenCalledWith("91");
      });
      expect(screen.queryByText("Level")).not.toBeInTheDocument();
    });
  });

  describe("Intel", () => {
    it("renders Available Intel when supported by the schema", async () => {
      vi.mocked(playersApi.intel).mockResolvedValue({ capabilities: { intel: true }, intel: 1500, maxIntel: 2779 });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        expect(screen.getByText("Available Intel")).toBeInTheDocument();
        expect(screen.getByText((1500).toLocaleString())).toBeInTheDocument();
      });
    });

    it("renders nothing extra when intel is unsupported by the schema", async () => {
      vi.mocked(playersApi.intel).mockResolvedValue({ capabilities: { intel: false }, reason: "Unsupported" });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        expect(playersApi.intel).toHaveBeenCalledWith("91");
      });
      expect(screen.queryByText("Available Intel")).not.toBeInTheDocument();
    });
  });

  describe("Dungeon Runs", () => {
    const party = [{ controllerId: 23, actorId: 23, characterName: "Aster" }, { controllerId: 36, actorId: 36, characterName: "Brin" }];

    it("lists every run with best times, resolved names and formatted durations", async () => {
      vi.mocked(playersApi.dungeons).mockResolvedValue({
        capabilities: { dungeons: true },
        totalRuns: 3,
        truncated: false,
        runs: [
          { completionId: 4, dungeonId: "DA_Dgn_999_Sand_Storm", difficulty: 2, durationMs: 992717, playerCount: 2, party },
          { completionId: 3, dungeonId: "DA_Dgn_999_Sand_Storm", difficulty: 2, durationMs: 1337938, playerCount: 2, party },
          { completionId: 1, dungeonId: "DA_Dgn_998_Dust", difficulty: 1, durationMs: 883053, playerCount: 1, party: [{ controllerId: 23, actorId: 23, characterName: null }] }
        ]
      });
      render(<PlayerSummary {...baseProps} detail={{ player: { character_name: "Aster" } }} fallback={{}} />);
      await screen.findByText("Best Time by Difficulty");
      // Sand Storm: its best-time row, the Highest Difficulty stat and two run rows.
      expect(screen.getAllByText("Sand Storm")).toHaveLength(4);
      expect(screen.getAllByText("Dust")).toHaveLength(2);
      expect(screen.getByTitle("Difficulty 2")).toHaveTextContent("2 16:33");
      expect(screen.getAllByText("16:33")).toHaveLength(2);
      expect(screen.getAllByText("22:18")).toHaveLength(1);
      expect(screen.getByText("Fastest Clear").parentElement).toHaveTextContent("Fastest Clear14:43Dust · 1");
      expect(screen.getByText("Highest Difficulty").parentElement).toHaveTextContent("Highest Difficulty2Sand Storm");
      expect(screen.getByText("Dungeons").parentElement).toHaveTextContent("Dungeons2");
      expect(screen.getAllByText("2 · Aster, Brin")).toHaveLength(2);
      expect(screen.getByText("1 · Controller 23")).toBeInTheDocument();
    });

    it("sorts the Party column by party size, not by names", async () => {
      vi.mocked(playersApi.dungeons).mockResolvedValue({
        capabilities: { dungeons: true }, totalRuns: 2, truncated: false,
        runs: [
          { completionId: 2, dungeonId: "DA_Dgn_998_Dust", difficulty: 1, durationMs: 1000, playerCount: 3, party: [{ controllerId: 1, actorId: 1, characterName: "Aaron" }, { controllerId: 2, actorId: 2, characterName: "Bea" }, { controllerId: 3, actorId: 3, characterName: "Cy" }] },
          { completionId: 1, dungeonId: "DA_Dgn_998_Dust", difficulty: 1, durationMs: 2000, playerCount: 1, party: [{ controllerId: 4, actorId: 4, characterName: "Zed" }] }
        ]
      });
      render(<PlayerSummary {...baseProps} detail={{ player: { character_name: "Zed" } }} fallback={{}} />);
      await waitFor(() => expect(screen.getByText("1 · Zed")).toBeInTheDocument());
      fireEvent.click(screen.getByRole("columnheader", { name: /Party/ }).querySelector("button") ?? screen.getByRole("columnheader", { name: /Party/ }));
      const partyCells = screen.getAllByText(/^\d · /).map((cell) => cell.textContent);
      expect(partyCells).toEqual(["1 · Zed", "3 · Aaron, Bea, Cy"]);
    });

    it("collapses a dungeon's best times to 8 chips and the run table to the 5 newest runs", async () => {
      // The oldest run is also the fastest and should stay visible in the chip list.
      const runs = Array.from({ length: 12 }, (_, index) => ({
        completionId: 100 - index, dungeonId: "DA_Dgn_998_Dust", difficulty: index + 1, durationMs: (12 - index) * 60_000,
        playerCount: 1, party: [{ controllerId: 23, actorId: 23, characterName: "Aster" }]
      }));
      vi.mocked(playersApi.dungeons).mockResolvedValue({ capabilities: { dungeons: true }, totalRuns: 12, truncated: false, runs });
      render(<PlayerSummary {...baseProps} detail={{ player: { character_name: "Aster" } }} fallback={{}} />);
      await screen.findByText("Best Time by Difficulty");
      const chips = () => document.querySelectorAll("span.summary-chip");
      const runRows = () => document.querySelectorAll(".summary-dungeons-table tbody tr");
      expect(chips()).toHaveLength(8);
      expect([...chips()].map((chip) => chip.querySelector("strong")?.textContent)).toEqual(["12:00", "11:00", "10:00", "9:00", "8:00", "7:00", "6:00", "1:00"]);
      expect(document.querySelectorAll(".summary-chip-best")).toHaveLength(1);
      expect(document.querySelector(".summary-chip-best")).toHaveTextContent("12 1:00");
      expect(runRows()).toHaveLength(5);
      fireEvent.click(screen.getByRole("columnheader", { name: "Duration" }));
      expect([...runRows()].map((row) => row.querySelector('td[data-column="duration"]')?.textContent)).toEqual(["8:00", "9:00", "10:00", "11:00", "12:00"]);
      fireEvent.click(screen.getByRole("button", { name: "+4" }));
      expect(chips()).toHaveLength(12);
      fireEvent.click(screen.getByRole("button", { name: "Show Fewer Items" }));
      expect(chips()).toHaveLength(8);
      fireEvent.click(screen.getByRole("button", { name: "Show All 12 Items" }));
      expect(runRows()).toHaveLength(12);
      fireEvent.click(screen.getByRole("button", { name: "Show Fewer Items" }));
      expect(runRows()).toHaveLength(5);
    });

    it("drops the dungeon card and moves Vitals and Currency into the main column when there are no runs", async () => {
      vi.mocked(playersApi.dungeons).mockResolvedValue({ capabilities: { dungeons: true }, totalRuns: 0, truncated: false, runs: [] });
      vi.mocked(playersApi.vitals).mockResolvedValue({ capabilities: { vitals: true }, currentHealth: 150, maxHealth: 150, maxHealthEstimated: false, hydration: 85, maxHydration: 100, spiceAddictionLevel: 0, maxSpiceAddictionLevel: 10 });
      vi.mocked(playersApi.currency).mockResolvedValue({ capabilities: {}, rows: [{ currency_id: 1, balance: 37641, label: "Solari Credit" }] });
      const { container } = render(<PlayerSummary {...baseProps} detail={{ player: { character_name: "Aster" } }} fallback={{}} />);
      await waitFor(() => expect(screen.getByText("Vitals")).toBeInTheDocument());
      await waitFor(() => expect(screen.getByText("Currency")).toBeInTheDocument());
      expect(container.querySelector(".summary-dungeons")).toBeNull();
      const pair = container.querySelector(".summary-main .summary-main-pair");
      expect(pair).toHaveTextContent("Vitals");
      expect(pair).toHaveTextContent("Currency");
      expect(container.querySelector(".summary-side")).not.toHaveTextContent("Vitals");
      expect(container.querySelector(".summary-side")).toHaveTextContent("Faction");
    });

    it("keeps Vitals and Currency in the sidebar when the dungeon card is shown", async () => {
      vi.mocked(playersApi.dungeons).mockResolvedValue({
        capabilities: { dungeons: true }, totalRuns: 1, truncated: false,
        runs: [{ completionId: 1, dungeonId: "DA_Dgn_998_Dust", difficulty: 1, durationMs: 1000, playerCount: 1, party }]
      });
      vi.mocked(playersApi.vitals).mockResolvedValue({ capabilities: { vitals: true }, currentHealth: 150, maxHealth: 150, maxHealthEstimated: false, hydration: 85, maxHydration: 100, spiceAddictionLevel: 0, maxSpiceAddictionLevel: 10 });
      const { container } = render(<PlayerSummary {...baseProps} detail={{ player: { character_name: "Aster" } }} fallback={{}} />);
      await waitFor(() => expect(container.querySelector(".summary-dungeons")).not.toBeNull());
      await waitFor(() => expect(container.querySelector(".summary-side")).toHaveTextContent("Vitals"));
      expect(container.querySelector(".summary-main-pair")).toBeNull();
    });

    it("notes truncation when only the latest runs were returned", async () => {
      vi.mocked(playersApi.dungeons).mockResolvedValue({
        capabilities: { dungeons: true }, totalRuns: 501, truncated: true,
        runs: [{ completionId: 9, dungeonId: "DA_Dgn_998_Dust", difficulty: 1, durationMs: 1000, playerCount: 1, party }]
      });
      render(<PlayerSummary {...baseProps} detail={{ player: { character_name: "Aster" } }} fallback={{}} />);
      await waitFor(() => expect(screen.getByText("Showing the latest 1 runs.")).toBeInTheDocument());
    });

    it("hides the block when the schema has no dungeon tables", async () => {
      vi.mocked(playersApi.dungeons).mockResolvedValue({ capabilities: { dungeons: false }, reason: "Unsupported" });
      render(<PlayerSummary {...baseProps} detail={{ player: { character_name: "Aster" } }} fallback={{}} />);
      await waitFor(() => expect(playersApi.dungeons).toHaveBeenCalledWith("91"));
      expect(screen.queryByText("Dungeon Runs")).not.toBeInTheDocument();
    });
  });

  describe("Vitals", () => {
    it("renders Health, Hydration, and Spice Addiction when vitals are supported", async () => {
      vi.mocked(playersApi.vitals).mockResolvedValue({ capabilities: { vitals: true }, currentHealth: 175, maxHealth: 205, maxHealthEstimated: true, hydration: 84, maxHydration: 100, spiceAddictionLevel: 8, maxSpiceAddictionLevel: 10 });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        expect(screen.getByText("Health")).toBeInTheDocument();
        expect(screen.getByText("175 / 205 (estimated max)")).toBeInTheDocument();
        expect(screen.getByText("Hydration")).toBeInTheDocument();
        expect(screen.getByText("84 / 100")).toBeInTheDocument();
        expect(screen.getByText("Spice Addiction")).toBeInTheDocument();
        expect(screen.getByText("8 / 10")).toBeInTheDocument();
      });
    });

    it("renders nothing extra when vitals are unsupported by the schema", async () => {
      vi.mocked(playersApi.vitals).mockResolvedValue({ capabilities: { vitals: false }, reason: "Unsupported" });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        expect(playersApi.vitals).toHaveBeenCalledWith("91");
      });
      expect(screen.queryByText("Health")).not.toBeInTheDocument();
      expect(screen.queryByText("Hydration")).not.toBeInTheDocument();
      expect(screen.queryByText("Spice Addiction")).not.toBeInTheDocument();
    });

    it("refreshes player statistics every 30 seconds and stops after closing the summary", async () => {
      vi.useFakeTimers();
      vi.mocked(playersApi.vitals)
        .mockResolvedValueOnce({ capabilities: { vitals: true }, currentHealth: 175, maxHealth: 205, maxHealthEstimated: true, hydration: 84, maxHydration: 100, spiceAddictionLevel: 8, maxSpiceAddictionLevel: 10 })
        .mockResolvedValueOnce({ capabilities: { vitals: true }, currentHealth: 140, maxHealth: 205, maxHealthEstimated: true, hydration: 61, maxHydration: 100, spiceAddictionLevel: 8, maxSpiceAddictionLevel: 10 });

      const { unmount } = render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      await act(async () => { await Promise.resolve(); });
      expect(playersApi.vitals).toHaveBeenCalledTimes(1);
      expect(screen.getByText("175 / 205 (estimated max)")).toBeInTheDocument();

      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(playersApi.vitals).toHaveBeenCalledTimes(2);
      expect(screen.getByText("140 / 205 (estimated max)")).toBeInTheDocument();
      expect(screen.getByText("61 / 100")).toBeInTheDocument();

      unmount();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(playersApi.vitals).toHaveBeenCalledTimes(2);
    });
  });

  describe("Partial failure resilience", () => {
    it("still renders sections whose requests succeeded when one request rejects", async () => {
      vi.mocked(playersApi.intel).mockRejectedValue(new Error("network error"));
      vi.mocked(playersApi.progression).mockResolvedValue({
        capabilities: { progression: true },
        level: 19,
        xp: 9692,
        totalSkillPoints: 18,
        unspentSkillPoints: 6
      });
      vi.mocked(playersApi.factions).mockResolvedValue({
        capabilities: { factions: true },
        rows: [{ faction_id: 1, faction_name: "Atreides", reputation_amount: 500 }]
      });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        expect(screen.getByText("9,692")).toBeInTheDocument();
      });
      expect(screen.getByText("Atreides")).toBeInTheDocument();
      expect(screen.getByText("500")).toBeInTheDocument();
      expect(screen.queryByText("Available Intel")).not.toBeInTheDocument();
    });
  });

  describe("Solari Coin", () => {
    it("renders the summed physical coin total formatted with the viewer's locale grouping", async () => {
      vi.mocked(playersApi.solarisCoin).mockResolvedValue({ capabilities: { solarisCoin: true }, total: 51194 });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        expect(screen.getByText("Solari Coin")).toBeInTheDocument();
        expect(screen.getByText((51194).toLocaleString())).toBeInTheDocument();
      });
    });

    it("renders zero when the player holds no Solari Coin", async () => {
      vi.mocked(playersApi.solarisCoin).mockResolvedValue({ capabilities: { solarisCoin: true }, total: 0 });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        expect(screen.getByText("Solari Coin")).toBeInTheDocument();
        expect(screen.getByText("0")).toBeInTheDocument();
      });
    });

    it("renders nothing extra when Solari Coin is unsupported by the schema", async () => {
      vi.mocked(playersApi.solarisCoin).mockResolvedValue({ capabilities: { solarisCoin: false }, reason: "Unsupported" });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        expect(playersApi.solarisCoin).toHaveBeenCalledWith("91");
      });
      expect(screen.queryByText("Solari Coin")).not.toBeInTheDocument();
    });
  });
});
