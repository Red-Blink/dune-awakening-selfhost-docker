import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { UpdatesPanel } from "./UpdatesPanel";
import { fetchConsoleAuthState } from "../../api/client";
import { updatesApi } from "../../api/updates";
vi.mock("../../api/client", () => ({ fetchConsoleAuthState: vi.fn() }));
vi.mock("../../api/updates", () => ({ updatesApi: {
  status: vi.fn(), checkStack: vi.fn(), applyStack: vi.fn(), autoGameStatus: vi.fn(), autoStackStatus: vi.fn(), qaStatus: vi.fn()
} }));
vi.stubGlobal("EventSource", class { close() {} });
beforeEach(() => {
  vi.clearAllMocks(); window.localStorage.clear(); window.sessionStorage.clear();
  vi.mocked(updatesApi.checkStack).mockResolvedValue({ task: {
    status: "succeeded", logLines: ["Current stack version: v1.4.47", "Latest release:        v1.4.48", "Update available."].map((line) => ({ line }))
  } } as never);
});
function mount(confirmAction: (m: string) => Promise<boolean>) {
  render(<UpdatesPanel confirmAction={confirmAction} waitForTask={async (task) => task}
    parseKeyValueText={() => ({})} formatTimerStatus={(s) => s}
    commandStatusSummary={() => ({ status: "", reason: "" })} taskTechnicalDetails={() => ""}
    formatResultTitle={(s) => String(s)} formatResultMessage={(s) => String(s)} />);
}
test("pending IP review adds an explicit warning to the update confirmation", async () => {
  vi.mocked(fetchConsoleAuthState).mockResolvedValue({ config: { consoleAccessReviewRequired: true } });
  const confirm = vi.fn().mockResolvedValue(false);
  mount(confirm);
  fireEvent.click(await screen.findByRole("button", { name: "Apply Console Update" }));
  await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.stringContaining("IP restrictions await confirmation")));
  expect(updatesApi.applyStack).not.toHaveBeenCalled();
});
test("empty or active lists keep the existing update wording", async () => {
  vi.mocked(fetchConsoleAuthState).mockResolvedValue({ config: { consoleAccessReviewRequired: false } });
  const confirm = vi.fn().mockResolvedValue(false);
  mount(confirm);
  fireEvent.click(await screen.findByRole("button", { name: "Apply Console Update" }));
  await waitFor(() => expect(confirm).toHaveBeenCalledWith("Apply the latest console update now?"));
});
test("a failed access preflight prevents starting an update", async () => {
  vi.mocked(fetchConsoleAuthState).mockRejectedValue(new Error("Console state check failed: 403"));
  const confirm = vi.fn(); mount(confirm);
  fireEvent.click(await screen.findByRole("button", { name: "Apply Console Update" }));
  expect(await screen.findByText("Console state check failed: 403")).toBeVisible();
  expect(confirm).not.toHaveBeenCalled(); expect(updatesApi.applyStack).not.toHaveBeenCalled();
});
