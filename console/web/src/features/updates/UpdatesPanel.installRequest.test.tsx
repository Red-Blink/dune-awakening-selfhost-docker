import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatesPanel } from "./UpdatesPanel";
import { updatesApi } from "../../api/updates";
import { GAME_UPDATE_TASK_KEY, STACK_UPDATE_TASK_KEY, loadPersistedUpdateTask, persistUpdateTask, UPDATE_RESULT_DISMISS_MS } from "./updateUtils";
import type { Task } from "../../api/setup";

vi.mock("../../api/updates", () => ({
  updatesApi: {
    installAssets: vi.fn(),
    status: vi.fn(),
    check: vi.fn(),
    apply: vi.fn(),
    applyGame: vi.fn(),
    checkGame: vi.fn(),
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

describe("update diagnostics retention", () => {
  beforeEach(() => {
    vi.mocked(updatesApi.applyGame).mockReset();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.useFakeTimers();
    vi.mocked(updatesApi.checkGame).mockResolvedValue({ task: { ...task, operation: "updateCheck", status: "succeeded", logLines: [{ timestamp: "", stream: "stdout", line: "Local build: old\nRemote build: new\nUpdate available." }] } } as never);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it.each([GAME_UPDATE_TASK_KEY, STACK_UPDATE_TASK_KEY])("retains failed logs after the old timeout and remount, until dismissed (%s)", async (key) => {
    const failed: Task = { ...task, operation: key === GAME_UPDATE_TASK_KEY ? "updateApply" : "selfUpdateApply", status: "failed", errorMessage: "Startup could not complete.", logLines: [{ timestamp: "", stream: "stderr", line: "Lifecycle operation was already running." }] };
    persistUpdateTask(key, failed);
    const view = renderPanel(0, vi.fn().mockResolvedValue(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_RESULT_DISMISS_MS * 2); });
    expect(screen.getByText("Lifecycle operation was already running.")).toBeTruthy();
    expect(loadPersistedUpdateTask(key)?.status).toBe("failed");
    view.unmount();
    renderPanel(0, vi.fn().mockResolvedValue(false));
    expect(screen.getByText("Lifecycle operation was already running.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Lifecycle operation was already running.")).toBeNull();
    expect(loadPersistedUpdateTask(key)).toBeNull();
  });

  it("still dismisses successful game updates automatically", async () => {
    // Seed directly: successful results aren't normally persisted.
    window.localStorage.setItem(GAME_UPDATE_TASK_KEY, JSON.stringify({ ...task, status: "succeeded" }));
    renderPanel(0, vi.fn().mockResolvedValue(false));
    expect(screen.getByText("Game Files Installed")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_RESULT_DISMISS_MS + 1); });
    expect(screen.queryByText("Game Files Installed")).toBeNull();
    expect(loadPersistedUpdateTask(GAME_UPDATE_TASK_KEY)).toBeNull();
  });

  const blockedTask: Task = { ...task, operation: "updateApply", status: "failed", errorMessage: "dune update --yes failed with exit 1", logLines: [{ timestamp: "", stream: "stderr", line: "DUNE_GAME_UPDATE_PAUSED=TANK_COMPATIBILITY" }] };

  it("does not restore an old Tank warning when the user opens Updates", async () => {
    window.localStorage.setItem(GAME_UPDATE_TASK_KEY, JSON.stringify(blockedTask));
    await act(async () => { renderPanel(0, vi.fn().mockResolvedValue(true)); });
    expect(screen.queryByText("Game Update Paused")).toBeNull();
    expect(window.localStorage.getItem(GAME_UPDATE_TASK_KEY)).toBeNull();
  });

  it("shows a short Tank warning only after Apply, then removes it without a Dismiss button or leftover panel", async () => {
    vi.mocked(updatesApi.applyGame).mockResolvedValue({ task: blockedTask });
    await act(async () => { renderPanel(0, vi.fn().mockResolvedValue(true)); });
    expect(screen.queryByText("Game Update Paused")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Apply Game Update" })); });
    expect(screen.getByText("Game Update Paused")).toBeVisible();
    expect(screen.getByText(/can remove existing Tank vehicles/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry Game Update" })).toBeNull();
    expect(screen.queryByText("Update Log")).toBeNull();
    expect(screen.queryByLabelText(/Game update progress/)).toBeNull();
    expect(loadPersistedUpdateTask(GAME_UPDATE_TASK_KEY)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_RESULT_DISMISS_MS - 1000); });
    expect(screen.getByText("Game Update Paused")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
    expect(screen.queryByText("Game Update Paused")).toBeNull();
    expect(document.querySelector(".game-update-blocked-notice")).toBeNull();
    expect(screen.getByRole("button", { name: "Apply Game Update" })).toBeEnabled();
  });

  it("keeps cancelled update diagnostics with a truthful status and dismissal", async () => {
    persistUpdateTask(GAME_UPDATE_TASK_KEY, { ...task, status: "cancelled" });
    renderPanel(0, vi.fn().mockResolvedValue(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_RESULT_DISMISS_MS * 2); });
    expect(screen.getByText("Update Cancelled")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(loadPersistedUpdateTask(GAME_UPDATE_TASK_KEY)).toBeNull();
  });

  it("bounds stored logs and clears completed or dismissed results", () => {
    const failed: Task = { ...task, status: "failed", logLines: Array.from({ length: 200 }, (_, index) => ({ timestamp: "", stream: "stdout", line: `${index}:` + "x".repeat(5000) })) };
    persistUpdateTask(GAME_UPDATE_TASK_KEY, failed);
    const stored = loadPersistedUpdateTask(GAME_UPDATE_TASK_KEY)!;
    expect(stored.logLines).toHaveLength(160);
    expect(stored.logLines.every((line) => line.line.length <= 4096)).toBe(true);
    expect(failed.logLines).toHaveLength(200);
    persistUpdateTask(GAME_UPDATE_TASK_KEY, { ...failed, status: "cancelled" });
    expect(loadPersistedUpdateTask(GAME_UPDATE_TASK_KEY)?.status).toBe("cancelled");
    persistUpdateTask(GAME_UPDATE_TASK_KEY, { ...failed, status: "succeeded" });
    expect(loadPersistedUpdateTask(GAME_UPDATE_TASK_KEY)).toBeNull();
  });
});

describe("sidebar version badge sync", () => {
  const api = updatesApi as unknown as Record<string, unknown>;
  const checkTask = (lines: string[], status = "succeeded") => ({ task: { ...task, operation: "selfUpdateCheck", status, logLines: lines.map((line) => ({ timestamp: "", stream: "stdout", line })) } });
  function renderWithSync(onStackStatus: (status: Record<string, string>) => void, installedConsoleVersion = "") {
    return render(<UpdatesPanel
      onStackStatus={onStackStatus}
      installedConsoleVersion={installedConsoleVersion}
      confirmAction={vi.fn().mockResolvedValue(false)}
      waitForTask={(async (t: unknown) => t) as never}
      parseKeyValueText={() => ({})}
      formatTimerStatus={(v: string) => v}
      commandStatusSummary={() => ({ status: "", reason: "" })}
      taskTechnicalDetails={() => ""}
      formatResultTitle={(v: unknown) => String(v ?? "")}
      formatResultMessage={(v: unknown) => String(v ?? "")}
    />);
  }
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    cleanup();
    delete api.checkStack;
  });

  it("hands a completed console check to the sidebar", async () => {
    api.checkStack = vi.fn().mockResolvedValue(checkTask(["Current stack version: v1.4.44", "Latest release:        v1.4.44", "You are already on the latest stack version."]));
    const onStackStatus = vi.fn();
    renderWithSync(onStackStatus);
    await waitFor(() => expect(onStackStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "Latest", current: "v1.4.44", latest: "v1.4.44" })));
  });

  it("does not replace a known sidebar version with a check that learned nothing", async () => {
    api.checkStack = vi.fn().mockResolvedValue(checkTask([], "failed"));
    const onStackStatus = vi.fn();
    renderWithSync(onStackStatus);
    await waitFor(() => expect(api.checkStack).toHaveBeenCalled());
    await screen.findAllByText("Check Failed");
    expect(onStackStatus).not.toHaveBeenCalled();
  });

  it("shows the installed console version when the check could not report one", async () => {
    api.checkStack = vi.fn().mockResolvedValue(checkTask([], "failed"));
    renderWithSync(vi.fn(), "1.4.44");
    await screen.findAllByText("Check Failed");
    expect(screen.getByText("Current Console Version").parentElement?.textContent).toContain("v1.4.44");
  });
});
