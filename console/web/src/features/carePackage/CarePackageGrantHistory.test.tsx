import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CarePackageGrantHistory } from "./CarePackageGrantHistory";
import { CarePackagePanel } from "./CarePackagePanel";

vi.mock("../../api/carePackage", () => ({ carePackageApi: {
  config: vi.fn().mockResolvedValue({ enabled: false, kits: [], items: [], xp: 0, autoGrantRules: [] }),
  history: vi.fn().mockResolvedValue({ rows: [{ id: "integration-grant", character_name: "Example Player", kitName: "Starter Package", status: "partial_failed", summary: "misleading raw summary", results: [
    { ok: true, operation: "adminAddXp", amount: 50 },
    { ok: false, item: { itemName: "Fiber", quantity: 10 }, stderr: "Inventory is full." }
  ] }] })
} }));
vi.mock("../../api/players", () => ({ playersApi: { listAll: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock("../../api/admin", () => ({ adminApi: { itemCatalog: vi.fn().mockResolvedValue({ rows: [] }) } }));

const grant = {
  id: "grant-example", character_name: "Example Player", kitName: "Starter Package", action_player_id: "internal-player-id",
  timestamp: "2026-10-31T18:00:00.000Z", source: "Manual", status: "partial_failed",
  summary: "1 Succeeded, 1 Failed; internal-operation-name failed: unknown error",
  results: [{ ok: true, item: "Water x2", warning: "Reconnect to see this item." }, { ok: false, item: "Fiber x10", error: "Inventory is full." }]
};
function show(row = grant) {
  const onRetry = vi.fn();
  render(<CarePackageGrantHistory rows={[row]} describeAction={action => String(action.item || "Package")} actionError={action => String(action.error || action.warning || "")} onRetry={onRetry} />);
  return { onRetry };
}

describe("Care Package Grant History", () => {
  it("connects the Care Package page to structured item/XP results and actual failure reasons", async () => {
    render(<CarePackagePanel onError={vi.fn()} confirmAction={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Details" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("50 XP")).toBeVisible();
    expect(within(dialog).getByText("Fiber x10")).toBeVisible();
    expect(within(dialog).getByText("Inventory is full.")).toBeVisible();
    expect(screen.queryByText("misleading raw summary")).toBeNull();
  });
  it("shows success/failure counts from recorded actions instead of the raw summary", () => {
    show();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader").map(el => el.textContent)).toEqual(["Completed", "Player", "Package", "Result", "Details"]);
    expect(within(table).getByText("Succeeded").parentElement).toHaveTextContent("1 Succeeded");
    expect(within(table).getByText("Failed").parentElement).toHaveTextContent("1 Failed");
    expect(screen.queryByText(/internal-operation-name/)).toBeNull();
    expect(screen.queryByText("internal-player-id")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a clean per-item breakdown with the real failure and delivery warning", () => {
    show(); fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const dialog = screen.getByRole("dialog", { name: "Grant History" });
    expect(within(dialog).getByText("Water x2")).toBeVisible();
    expect(within(dialog).getByText("Fiber x10")).toBeVisible();
    expect(within(dialog).getByText("Inventory is full.")).toBeVisible();
    expect(within(dialog).getByText("Reconnect to see this item.")).toBeVisible();
    expect(within(dialog).getByText("Manual")).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("closes with Escape and returns focus to the Details control", () => {
    show(); const details = screen.getByRole("button", { name: "Details" }); details.focus(); fireEvent.click(details);
    expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(details).toHaveFocus();
  });

  it("contains keyboard focus and only dismisses on an outside click", () => {
    show(); fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const dialog = screen.getByRole("dialog");
    screen.getByRole("button", { name: "Close" }).focus(); fireEvent.keyDown(window, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus();
    fireEvent.mouseDown(dialog); expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.mouseDown(dialog.parentElement!); expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps failed-grant retry available without repeating partially successful grants", () => {
    const row = { ...grant, status: "failed", results: [grant.results[1]] };
    const { onRetry } = show(row); fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith(row); expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("handles legacy grants without inventing per-item counts", () => {
    show({ ...grant, status: "granted", results: [] });
    expect(screen.getByText("Succeeded")).toBeVisible();
    expect(screen.queryByText(/\d Succeeded/)).toBeNull();
  });
});
