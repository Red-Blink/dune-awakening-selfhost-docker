import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CharacterAdminUI } from "./CharacterAdminUI";
import { playersApi } from "../../api/players";

vi.mock("./PlayerSummary", () => ({ PlayerSummary: ({ actions }: { actions?: ReactNode }) => <div data-testid="summary">{actions}</div> }));
vi.mock("./PlayerDetailTab", () => ({ PlayerDetailTab: () => <div>Inventory</div> }));
vi.mock("./PlayerTeleportControls", () => ({ PlayerTeleportControls: () => <div>Teleport controls</div> }));

function renderAdmin(onlineStatus: string, confirmAction = vi.fn().mockResolvedValue(true)) {
  render(<CharacterAdminUI detail={{ player: { online_status: onlineStatus }, capabilities: {} }} fallback={{}}
    dbPlayerId="1" actionPlayerId="synthetic" playerName="Test Player" onError={vi.fn()} onRefresh={vi.fn()}
    onClose={vi.fn()} confirmAction={confirmAction} waitForTask={vi.fn().mockResolvedValue({ status: "succeeded" })}
    formatMutationResult={() => ""} restartGate={vi.fn()} />);
  return { confirmAction, summary: screen.getByTestId("summary") };
}

describe("Player Summary hero actions", () => {
  it("kicks through the same confirm dialog as the Danger Zone button", async () => {
    const kick = vi.spyOn(playersApi, "kick").mockResolvedValue({ task: { id: "t1" } } as never);
    const { confirmAction, summary } = renderAdmin("Online");
    fireEvent.click(summary.querySelector("button.danger")!);
    await waitFor(() => expect(kick).toHaveBeenCalledWith("synthetic"));
    expect(confirmAction).toHaveBeenCalledWith("Kick Test Player from the server?");
    kick.mockRestore();
  });

  it("does nothing when the kick is not confirmed", async () => {
    const kick = vi.spyOn(playersApi, "kick").mockResolvedValue({ task: { id: "t1" } } as never);
    const { summary } = renderAdmin("Online", vi.fn().mockResolvedValue(false));
    await act(async () => { fireEvent.click(summary.querySelector("button.danger")!); });
    expect(kick).not.toHaveBeenCalled();
    kick.mockRestore();
  });

  it("disables Kick for an offline player", () => {
    const { summary } = renderAdmin("Offline");
    expect(summary.querySelector("button.danger")).toBeDisabled();
  });

  it("opens the Admin tab at the teleport controls", async () => {
    const scrolled: string[] = [];
    const originalScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.className); };
    const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 1; });
    const { summary } = renderAdmin("Offline");
    expect(screen.queryByText("Teleport controls")).not.toBeInTheDocument();
    fireEvent.click(Array.from(summary.querySelectorAll("button")).find((button) => button.textContent === "Teleport")!);
    expect(screen.getByRole("button", { name: "Admin" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByText("Teleport controls")).toBeInTheDocument();
    await waitFor(() => expect(scrolled).toContain("playerAdmin_teleportAnchor"));
    Element.prototype.scrollIntoView = originalScroll;
    frame.mockRestore();
  });
});
