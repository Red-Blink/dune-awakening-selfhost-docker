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
    solarisCoin: vi.fn()
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
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette" } }}
          fallback={{}}
        />
      );
      expect(screen.getByText("—")).toBeInTheDocument();
    });

    it("shows the real guild when present on the loaded player", () => {
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette", guild: "House Corrino" } }}
          fallback={{}}
        />
      );
      expect(screen.getByText("House Corrino")).toBeInTheDocument();
      expect(screen.queryByText("—")).not.toBeInTheDocument();
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

    it("renders nothing extra when currency is unsupported by the schema", async () => {
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
  });

  describe("Faction Reputation", () => {
    it("renders each faction's reputation amount, distinct from the Faction row", async () => {
      vi.mocked(playersApi.factions).mockResolvedValue({
        rows: [
          { faction_id: 1, faction_name: "Atreides", reputation_amount: 500 },
          { faction_id: 2, faction_name: "Harkonnen", reputation_amount: 120 }
        ],
        capabilities: {}
      });
      render(
        <PlayerSummary
          {...baseProps}
          detail={{ player: { character_name: "Benny Jesserette", faction: "Neutral" } }}
          fallback={{}}
        />
      );
      await waitFor(() => {
        expect(screen.getByText("Atreides Reputation")).toBeInTheDocument();
        expect(screen.getByText("500")).toBeInTheDocument();
        expect(screen.getByText("Harkonnen Reputation")).toBeInTheDocument();
        expect(screen.getByText("120")).toBeInTheDocument();
      });
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

  describe("Total Solari Coin", () => {
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
        expect(screen.getByText("Total Solari Coin")).toBeInTheDocument();
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
        expect(screen.getByText("Total Solari Coin")).toBeInTheDocument();
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
      expect(screen.queryByText("Total Solari Coin")).not.toBeInTheDocument();
    });
  });
});
