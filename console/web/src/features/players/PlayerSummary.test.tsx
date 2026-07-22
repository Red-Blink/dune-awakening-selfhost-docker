import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PlayerSummary } from "./PlayerSummary";
import { playersApi } from "../../api/players";

vi.mock("../../api/players", () => ({
  playersApi: {
    currency: vi.fn(),
    factions: vi.fn()
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
        expect(screen.getByText("5000")).toBeInTheDocument();
        expect(screen.getByText("Scrip")).toBeInTheDocument();
        expect(screen.getByText("250")).toBeInTheDocument();
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
});
