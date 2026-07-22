import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PlayerSummary } from "./PlayerSummary";

const baseProps = {
  dbPlayerId: "91",
  actionPlayerId: "action-91"
};

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
});
