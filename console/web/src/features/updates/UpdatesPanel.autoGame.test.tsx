import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { UpdatesPanel } from "./UpdatesPanel";
import { fetchConsoleAuthState } from "../../api/client";
import { updatesApi } from "../../api/updates";
vi.mock("../../api/client", () => ({ fetchConsoleAuthState: vi.fn() }));
vi.mock("../../api/updates", () => ({ updatesApi: {
  status: vi.fn(), checkStack: vi.fn(), applyStack: vi.fn(), autoGameStatus: vi.fn(), saveAutoGame: vi.fn(), autoStackStatus: vi.fn(), qaStatus: vi.fn()
} }));
vi.stubGlobal("EventSource", class { close() {} });

const parseKeyValueText = (text: string) => {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([^:=]{2,80}):\s*(.*)$/);
    if (match) out[match[1].trim().toLowerCase().replace(/\s+/g, "_")] = match[2].trim();
  }
  return out;
};
const status = (extra: string) => ({ exitCode: 0, stdout: [
  "Auto updates enabled: 1", "Check interval minutes: 10", "Apply updates:        1", "Notify players:       0",
  "Notify minutes:       15,10,5,1", "Wait until empty:     0", "Max wait minutes:     360", extra,
  "systemd_timer: active"].join("\n") });

beforeEach(() => {
  vi.clearAllMocks(); window.localStorage.clear(); window.sessionStorage.clear();
  vi.mocked(fetchConsoleAuthState).mockResolvedValue({ config: { consoleAccessReviewRequired: false } });
  vi.mocked(updatesApi.saveAutoGame).mockResolvedValue({ task: { status: "succeeded" } } as never);
});

function mount() {
  render(<UpdatesPanel confirmAction={async () => true} waitForTask={async (task) => task}
    parseKeyValueText={parseKeyValueText} formatTimerStatus={(s) => s}
    commandStatusSummary={() => ({ status: "", reason: "" })} taskTechnicalDetails={() => ""}
    formatResultTitle={(s) => String(s)} formatResultMessage={(s) => String(s)} />);
}
async function openPanel() {
  fireEvent.click(await screen.findByRole("button", { name: "Expand Automatic Game Updates" }));
}

test("the Console and Regis Tanks options default to off and are saved with the other settings", async () => {
  vi.mocked(updatesApi.autoGameStatus).mockResolvedValue(status("Update Console:       0\nManage Regis Tanks:   0"));
  mount(); await openPanel();
  const consoleToggle = await screen.findByRole("checkbox", { name: "Update the Console after a game update" });
  const tanksToggle = screen.getByRole("checkbox", { name: "Disable Regis Tanks before the update and restore them afterwards" });
  expect(consoleToggle).not.toBeChecked(); expect(tanksToggle).not.toBeChecked();
  fireEvent.click(consoleToggle); fireEvent.click(tanksToggle);
  fireEvent.click(screen.getByRole("button", { name: "Save Auto Updates" }));
  await waitFor(() => expect(updatesApi.saveAutoGame).toHaveBeenCalledWith(expect.objectContaining({
    enabled: true, updateConsole: true, manageTanks: true, confirmation: "SAVE AUTO GAME UPDATES"
  })));
});

test("saved options are shown when the panel opens", async () => {
  vi.mocked(updatesApi.autoGameStatus).mockResolvedValue(status("Update Console:       1\nManage Regis Tanks:   1"));
  mount(); await openPanel();
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "Update the Console after a game update" })).toBeChecked());
  expect(screen.getByRole("checkbox", { name: "Disable Regis Tanks before the update and restore them afterwards" })).toBeChecked();
});

test("a pending Regis Tanks restore is reported", async () => {
  vi.mocked(updatesApi.autoGameStatus).mockResolvedValue(status(
    "Manage Regis Tanks:   1\nRegis Tanks restore:  pending (disabled for game build 2162777-0-shipping, waiting for a Dune Docker update after v1.4.52)"));
  mount(); await openPanel();
  expect(await screen.findByText(/Regis Tanks restore: pending/)).toBeVisible();
});

test("an older Console that reports neither option leaves both off", async () => {
  vi.mocked(updatesApi.autoGameStatus).mockResolvedValue(status(""));
  mount(); await openPanel();
  const consoleToggle = await screen.findByRole("checkbox", { name: "Update the Console after a game update" });
  expect(consoleToggle).not.toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Save Auto Updates" }));
  await waitFor(() => expect(updatesApi.saveAutoGame).toHaveBeenCalledWith(expect.objectContaining({ updateConsole: false, manageTanks: false })));
});
