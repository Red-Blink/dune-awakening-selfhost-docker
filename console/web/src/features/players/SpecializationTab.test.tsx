import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SpecializationTab } from "../players/SpecializationTab";
import { playersApi } from "../../api/players";

vi.mock("../../api/players", () => ({
  playersApi: {
    specs: vi.fn(),
    addSpecializationXp: vi.fn(),
    grantMaxSpecialization: vi.fn(),
    resetSpecialization: vi.fn(),
    grantAllSpecializationKeystones: vi.fn(),
    resetAllSpecializationKeystones: vi.fn()
  }
}));

const mockConfirmAction = vi.fn();
const mockOnError = vi.fn();
const mockOnSkillBaselineChange = vi.fn();
const mockOnActionLog = vi.fn();

const defaultProps = {
  dbPlayerId: "player-123",
  actionPlayerId: "action-456",
  playerName: "TestPlayer",
  isOnline: false,
  onError: mockOnError,
  confirmAction: mockConfirmAction,
  onSkillBaselineChange: mockOnSkillBaselineChange,
  onActionLog: mockOnActionLog
};

const mockSpecsResponse = {
  rows: [
    { track_type: "Trooper", xp_amount: 5000, level: 3 },
    { track_type: "Mentat", xp_amount: 12000, level: 7 },
    { track_type: "Planetologist", xp_amount: 0, level: 0 }
  ],
  skillModules: [
    { module_id: "Skills.Key.Trooper1", level: 2 }
  ],
  capabilities: {}
};

beforeEach(() => {
  vi.clearAllMocks();
  mockConfirmAction.mockResolvedValue(true);
});

describe("SpecializationTab", () => {
  describe("rendering", () => {
    it("shows loading state when no data", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue({ rows: [], skillModules: [], capabilities: {} });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText(/No specialization tracks were found/i)).toBeInTheDocument();
      });
    });

    it("renders specialization tracks from API", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
        expect(screen.getByText("Mentat")).toBeInTheDocument();
        expect(screen.getByText("Planetologist")).toBeInTheDocument();
      });
    });

    it("displays XP values formatted with locale", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("5,000")).toBeInTheDocument();
        expect(screen.getByText("12,000")).toBeInTheDocument();
      });
    });

    it("displays level badges", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("3")).toBeInTheDocument();
        expect(screen.getByText("7")).toBeInTheDocument();
      });
    });

    it("shows error message when API fails", async () => {
      vi.mocked(playersApi.specs).mockRejectedValue(new Error("Database connection failed"));
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText(/Database connection failed/i)).toBeInTheDocument();
      });
    });

    it("calls onSkillBaselineChange with parsed skill modules", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(mockOnSkillBaselineChange).toHaveBeenCalledWith({
          "Skills.Key.Trooper1": 2
        });
      });
    });
  });

  describe("offline gating", () => {
    it("disables action buttons when player is online", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} isOnline={true} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const addButtons = screen.getAllByRole("button", { name: /Add XP to/i });
      expect(addButtons.length).toBeGreaterThan(0);
      addButtons.forEach((btn) => {
        expect(btn).toBeDisabled();
      });
    });

    it("disables Grant All Keystones button when player is online", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} isOnline={true} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const keystoneButton = screen.getByText("Grant All Keystones").closest("button");
      expect(keystoneButton).toBeDisabled();
    });

    it("disables Reset All Keystones button when player is online", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} isOnline={true} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      expect(screen.getByRole("button", { name: "Reset All Keystones" })).toBeDisabled();
      expect(playersApi.resetAllSpecializationKeystones).not.toHaveBeenCalled();
    });

    it("enables action buttons when player is offline", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} isOnline={false} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const addButtons = screen.getAllByRole("button", { name: /Add XP to/i });
      const grantButtons = screen.getAllByText("Grant Max");
      const resetButtons = screen.getAllByText("Reset");

      [...addButtons, ...grantButtons, ...resetButtons].forEach((btn) => {
        expect(btn).not.toBeDisabled();
      });
    });

    it("shows offline notice in header", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText(/offline for all specialization changes/i)).toBeInTheDocument();
      });
    });
  });

  describe("Add XP", () => {
    it("calls addSpecializationXp with correct parameters", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      vi.mocked(playersApi.addSpecializationXp).mockResolvedValue({ supported: true });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const addButtons = screen.getAllByRole("button", { name: /Add XP to/i });
      await fireEvent.click(addButtons[0]);

      await waitFor(() => {
        expect(playersApi.addSpecializationXp).toHaveBeenCalledWith("player-123", {
          trackType: "Trooper",
          amount: 1000,
          confirmation: "ADD SPECIALIZATION XP"
        });
        expect(mockOnActionLog).toHaveBeenCalledWith("Add Specialization XP", "Trooper", "1000", "Succeeded");
      });
    });

    it("shows error when XP amount is empty", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const xpInputs = screen.getAllByRole("spinbutton");
      await fireEvent.change(xpInputs[0], { target: { value: "" } });

      const addButtons = screen.getAllByRole("button", { name: /Add XP to/i });
      await fireEvent.click(addButtons[0]);

      await waitFor(() => {
        expect(screen.getByText(/Enter an XP amount first/i)).toBeInTheDocument();
      });
    });

    it("does not submit Add XP while the player is online", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} isOnline={true} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const addButtons = screen.getAllByRole("button", { name: /Add XP to/i });
      fireEvent.click(addButtons[0]);
      expect(addButtons[0]).toBeDisabled();
      expect(playersApi.addSpecializationXp).not.toHaveBeenCalled();
    });
  });

  describe("Grant Max", () => {
    it("requests confirmation before granting", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      vi.mocked(playersApi.grantMaxSpecialization).mockResolvedValue({ supported: true });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const grantButtons = screen.getAllByText("Grant Max");
      fireEvent.click(grantButtons[0]);

      expect(mockConfirmAction).toHaveBeenCalledWith(
        expect.stringContaining("Grant max level for Trooper"),
        expect.objectContaining({ danger: true })
      );
    });

    it("calls grantMaxSpecialization when confirmed", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      vi.mocked(playersApi.grantMaxSpecialization).mockResolvedValue({ supported: true });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const grantButtons = screen.getAllByText("Grant Max");
      fireEvent.click(grantButtons[0]);

      await waitFor(() => {
        expect(playersApi.grantMaxSpecialization).toHaveBeenCalledWith("player-123", {
          trackType: "Trooper",
          confirmation: "GRANT MAX SPECIALIZATION"
        });
      });
    });
  });

  describe("Reset", () => {
    it("requests confirmation before resetting", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      vi.mocked(playersApi.resetSpecialization).mockResolvedValue({ supported: true });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const resetButtons = screen.getAllByText("Reset");
      fireEvent.click(resetButtons[0]);

      expect(mockConfirmAction).toHaveBeenCalledWith(
        expect.stringContaining("Reset Trooper specialization"),
        expect.objectContaining({ danger: true })
      );
    });

    it("does not reset when confirmation is cancelled", async () => {
      mockConfirmAction.mockResolvedValue(false);
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      const resetButtons = screen.getAllByText("Reset");
      fireEvent.click(resetButtons[0]);

      expect(playersApi.resetSpecialization).not.toHaveBeenCalled();
    });
  });

  describe("Grant All Keystones", () => {
    it("requests confirmation before granting", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      vi.mocked(playersApi.grantAllSpecializationKeystones).mockResolvedValue({ supported: true });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Grant All Keystones")).toBeInTheDocument();
      });

      const keystoneButton = screen.getByText("Grant All Keystones").closest("button");
      fireEvent.click(keystoneButton!);

      expect(mockConfirmAction).toHaveBeenCalledWith(
        expect.stringContaining("Grant all specialization keystones"),
        expect.objectContaining({ danger: true })
      );
    });

    it("calls grantAllSpecializationKeystones when confirmed", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      vi.mocked(playersApi.grantAllSpecializationKeystones).mockResolvedValue({ supported: true });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Grant All Keystones")).toBeInTheDocument();
      });

      const keystoneButton = screen.getByText("Grant All Keystones").closest("button");
      fireEvent.click(keystoneButton!);

      await waitFor(() => {
        expect(playersApi.grantAllSpecializationKeystones).toHaveBeenCalledWith(
          "player-123",
          "GRANT ALL KEYSTONES"
        );
      });
    });
  });

  describe("Reset All Keystones", () => {
    it("requests confirmation before resetting", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      vi.mocked(playersApi.resetAllSpecializationKeystones).mockResolvedValue({ supported: true });
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Reset All Keystones")).toBeInTheDocument();
      });

      const resetButton = screen.getByText("Reset All Keystones").closest("button");
      fireEvent.click(resetButton!);

      expect(mockConfirmAction).toHaveBeenCalledWith(
        expect.stringContaining("Reset all specialization keystones"),
        expect.objectContaining({ danger: true })
      );
    });
  });

  describe("Reload", () => {
    it("calls specs API when Reload is clicked", async () => {
      vi.mocked(playersApi.specs).mockResolvedValue(mockSpecsResponse);
      render(<SpecializationTab {...defaultProps} />);
      await waitFor(() => {
        expect(screen.getByText("Trooper")).toBeInTheDocument();
      });

      vi.mocked(playersApi.specs).mockResolvedValue({
        rows: [{ track_type: "Bene Gesserit", xp_amount: 20000, level: 10 }],
        skillModules: [],
        capabilities: {}
      });

      const reloadButton = screen.getByText("Reload").closest("button");
      fireEvent.click(reloadButton!);

      await waitFor(() => {
        expect(playersApi.specs).toHaveBeenCalledTimes(2);
        expect(screen.getByText("Bene Gesserit")).toBeInTheDocument();
      });
    });
  });

  describe("empty state", () => {
    it("shows empty message when no dbPlayerId", async () => {
      render(<SpecializationTab {...defaultProps} dbPlayerId="" />);
      await waitFor(() => {
        expect(screen.getByText(/No specialization tracks were found/i)).toBeInTheDocument();
      });
    });
  });
});
