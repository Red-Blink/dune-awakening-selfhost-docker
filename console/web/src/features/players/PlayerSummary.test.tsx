import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PlayerSummary } from "./PlayerSummary";
import { playersApi } from "../../api/players";

vi.mock("../../api/players", () => ({
  playersApi: {
    currency: vi.fn(),
    factions: vi.fn(),
    progression: vi.fn(),
    intel: vi.fn(),
    solarisCoin: vi.fn(),
    vitals: vi.fn()
  }
}));

const baseProps = {
  dbPlayerId: "91",
  actionPlayerId: "action-91"
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(playersApi.currency).mockResolvedValue({ rows: [], capabilities: {} });
  vi.mocked(playersApi.factions).mockResolvedValue({ rows: [], capabilities: {} });
  vi.mocked(playersApi.progression).mockResolvedValue({ capabilities: {} });
  vi.mocked(playersApi.intel).mockResolvedValue({ capabilities: {} });
  vi.mocked(playersApi.solarisCoin).mockResolvedValue({ capabilities: {} });
  vi.mocked(playersApi.vitals).mockResolvedValue({ capabilities: {} });
});

describe("PlayerSummary", () => {
  describe("Faction fallback", () => {
    it("shows Neutral when no faction is assigned on player or fallback", () => {
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      expect(screen.getByText("Neutral")).toBeInTheDocument();
    });

    it("shows the real faction when present on the loaded player", () => {
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette", faction: "Atreides" } }}
          fallback={{}}
        />
      );
      expect(screen.getByText("Atreides")).toBeInTheDocument();
      expect(screen.queryByText("Neutral")).not.toBeInTheDocument();
    });

    it("uses the fallback faction before detail has loaded", () => {
      render(
        <PlayerSummary
          {...baseProps}
          detail={null}
          fallback={{ faction: "Harkonnen" }}
        />
      );
      expect(screen.getByText("Harkonnen")).toBeInTheDocument();
    });
  });

  describe("Guild fallback", () => {
    it("shows an em dash when no guild is assigned on player or fallback", () => {
      const { container } = render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      const guildMeta = container.querySelector(".summary-hero-guild");
      expect(guildMeta?.textContent).toContain("—");
    });

    it("shows the real guild when present on the loaded player", () => {
      const { container } = render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette", guild: "House Corrino" } }}
          fallback={{}}
        />
      );
      expect(screen.getByText("House Corrino")).toBeInTheDocument();
      const guildMeta = container.querySelector(".summary-hero-guild");
      expect(guildMeta?.textContent).toContain("House Corrino");
      expect(guildMeta?.textContent).not.toContain("—");
    });

    it("uses the fallback guild before detail has loaded", () => {
      render(
        <PlayerSummary
          {...baseProps}
          detail={null}
          fallback={{ guild: "Spice Runners" }}
        />
      );
      expect(screen.getByText("Spice Runners")).toBeInTheDocument();
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
          { currency_id: 1, balance: 250, label: "Scrip" }
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
        expect(screen.getByText("Scrip")).toBeInTheDocument();
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

    it("lists reputation standings under a Reputation sub-heading, separate from the alignment", async () => {
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
        expect(screen.getByText("Reputation")).toBeInTheDocument();
      });
      const block = screen.getByText("Reputation").closest(".summary-block");
      expect(block).not.toBeNull();
      expect(block?.textContent).toContain("Alignment");
      expect(block?.textContent).toContain("Harkonnen");
      expect(block?.textContent).toContain("Atreides");
      expect(block?.textContent).toContain("500");
    });

    it("keeps the Reputation sub-heading visible even when the player has no standings", async () => {
      vi.mocked(playersApi.factions).mockResolvedValue({ rows: [], capabilities: { factions: true } });
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
      expect(screen.getByText("Reputation")).toBeInTheDocument();
    });

    it("hides the Reputation sub-heading when the factions capability is unsupported", async () => {
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
      expect(screen.queryByText("Reputation")).not.toBeInTheDocument();
    });
  });

  describe("Identity", () => {
    it("splits into two columns of at most 5 rows, with the heading only on the first", async () => {
      render(
        <PlayerSummary
          {...baseProps}
          detail={{
            player: {
              character_name: "Benny Jesserette",
              account_id: 201,
              player_controller_id: 301,
              player_state_id: 102,
              platform_id: "76561197986776594",
              platform_name: "Steam",
              funcom_id: "FN1",
              fls_id: "user1"
            }
          }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        expect(screen.getByText("Account ID")).toBeInTheDocument();
      });
      expect(screen.getAllByText("Identity")).toHaveLength(1);
      const blocks = screen.getAllByText("DB Player ID").map((el) => el.closest(".summary-block"));
      const identityBlock = blocks[0];
      expect(identityBlock).not.toBeNull();
      const rows = identityBlock!.querySelectorAll("tr");
      expect(rows).toHaveLength(5);
      const secondBlock = screen.getByText("Player State ID").closest(".summary-block");
      expect(secondBlock).not.toBeNull();
      const secondRows = secondBlock!.querySelectorAll("tr");
      expect(secondRows).toHaveLength(3);
      expect(screen.getByText("76561197986776594")).toBeInTheDocument();
      expect(screen.getByText("Steam")).toBeInTheDocument();
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
        expect(screen.getByText("Level")).toBeInTheDocument();
        expect(screen.getByText("11")).toBeInTheDocument();
        expect(screen.getByText("XP")).toBeInTheDocument();
        expect(screen.getByText((4790).toLocaleString())).toBeInTheDocument();
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

  describe("Vitals", () => {
    it("renders Health, Hydration, and Spice Addiction when vitals are supported", async () => {
      vi.mocked(playersApi.vitals).mockResolvedValue({ capabilities: { vitals: true }, currentHealth: 175, maxHealth: 205, hydration: 84, maxHydration: 100, spiceAddictionLevel: 8, maxSpiceAddictionLevel: 10 });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        expect(screen.getByText("Health")).toBeInTheDocument();
        expect(screen.getByText("175 / 205")).toBeInTheDocument();
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
