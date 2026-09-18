import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatesPanel } from "./UpdatesPanel";
import { updatesApi } from "../../api/updates";

vi.mock("../../api/updates", () => ({
  updatesApi: {
    installAssets: vi.fn(),
    status: vi.fn(),
    check: vi.fn(),
    apply: vi.fn(),
    fixSteamcmd: vi.fn(),
    auto: vi.fn(),
    selfUpdateStatus: vi.fn(),
    selfUpdateApply: vi.fn(),
    selfUpdateAuto: vi.fn()
  }
}));

class FakeEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}
vi.stubGlobal("EventSource", FakeEventSource);

const task = { id: "t", type: "update", operation: "updateInstallAssets", status: "running", currentStep: "", progressMessage: "", logLines: [], warnings: [], startedAt: "", finishedAt: "", exitCode: null, errorMessage: null };

function renderPanel(installGameFilesRequest: number, confirmAction: (m: string) => Promise<boolean>, onHandled?: () => void) {
  return render(<UpdatesPanel
    installGameFilesRequest={installGameFilesRequest}
    onInstallGameFilesHandled={onHandled}
    confirmAction={confirmAction}
    waitForTask={(async (t: unknown) => t) as never}
    parseKeyValueText={() => ({})}
    formatTimerStatus={(v: string) => v}
    commandStatusSummary={() => ({ status: "", reason: "" })}
    taskTechnicalDetails={() => ""}
    formatResultTitle={(v: unknown) => String(v ?? "")}
    formatResultMessage={(v: unknown) => String(v ?? "")}
  />);
}

describe("install-game-files request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updatesApi.installAssets).mockResolvedValue({ task } as never);
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("tells the caller the request was handled, so it is not repeated", async () => {
    // The panel is rendered only while the Updates tab is open, so it unmounts
    // on every tab change. Without a way to say "handled", the still-non-zero
    // request re-ran on each return to the tab and offered to start another
    // multi-gigabyte download.
    const confirmAction = vi.fn().mockResolvedValue(false);
    const onHandled = vi.fn();
    renderPanel(1, confirmAction, onHandled);

    await waitFor(() => expect(confirmAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onHandled).toHaveBeenCalledTimes(1));
  });

  it("does nothing on a plain mount", async () => {
    const confirmAction = vi.fn().mockResolvedValue(false);
    renderPanel(0, confirmAction);

    await screen.findAllByText(/Game/i);
    expect(confirmAction).not.toHaveBeenCalled();
  });
});
