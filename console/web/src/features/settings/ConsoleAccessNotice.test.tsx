import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { ConsoleAccessNotice, type ConsoleAccessStatus } from "./ConsoleAccessNotice";
vi.mock("../../api/client", () => ({ post: vi.fn() }));
import { post } from "../../api/client";
const status: ConsoleAccessStatus = { pending: true, configuredCount: 1, activeCount: 0, canConfirm: true, fingerprint: "review", recovery: "Edit .env using SSH, then reload the Console." };
beforeEach(() => vi.clearAllMocks());
test("empty or active settings add no warning", () => {
  render(<ConsoleAccessNotice status={{ ...status, pending: false }} confirmAction={vi.fn()} onConfirmed={vi.fn()} />);
  expect(screen.queryByRole("region")).toBeNull();
});
test("unsafe activation is disabled and explains SSH recovery", () => {
  render(<ConsoleAccessNotice status={{ ...status, canConfirm: false }} confirmAction={vi.fn()} onConfirmed={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Review And Activate" })).toBeDisabled();
  expect(screen.getByText(/Activation is blocked/)).toBeVisible();
  fireEvent.click(screen.getByText("SSH Recovery"));
  expect(screen.getByText(status.recovery)).toBeVisible();
});
test("requires confirmation before applying and refreshes after success", async () => {
  const confirmAction = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const refresh = vi.fn().mockResolvedValue(undefined);
  render(<ConsoleAccessNotice status={status} confirmAction={confirmAction} onConfirmed={refresh} />);
  fireEvent.click(screen.getByRole("button", { name: "Review And Activate" }));
  await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
  expect(post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review And Activate" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/api/settings/console-access/confirm", { confirmed: true, fingerprint: "review" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
});
test("failed confirmation stays visible and never pretends activation succeeded", async () => {
  vi.mocked(post).mockRejectedValueOnce(new Error("Restrictions changed. Refresh Settings."));
  render(<ConsoleAccessNotice status={status} confirmAction={vi.fn().mockResolvedValue(true)} onConfirmed={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Review And Activate" }));
  expect(await screen.findByText("Restrictions changed. Refresh Settings.")).toBeVisible();
});
