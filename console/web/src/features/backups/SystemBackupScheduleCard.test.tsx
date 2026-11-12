import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { backupsApi, scheduledPruneCount } from "../../api/backups";
import type { SystemAutoStatus } from "../../api/backups";
import { SystemBackupScheduleCard } from "./SystemBackupScheduleCard";

vi.mock("../../api/backups", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../api/backups")>();
  return {
    ...original,
    backupsApi: {
      systemAutoStatus: vi.fn(),
      saveSystemAuto: vi.fn(),
      saveSystemPassphrase: vi.fn(),
      removeSystemPassphrase: vi.fn()
    }
  };
});

const PASSPHRASE = "correct horse battery staple";

function mockStatus(status: SystemAutoStatus) {
  vi.mocked(backupsApi.systemAutoStatus).mockResolvedValue({ status: { ok: true, ...status } });
}

function renderCard() {
  const waitForTask = vi.fn(async (task) => ({ ...task, status: "succeeded" }));
  const card = (token: unknown) => <SystemBackupScheduleCard
    disabled={false}
    setBusy={() => {}}
    waitForTask={waitForTask}
    toHourMinuteTime={(value) => String(value ?? "")}
    sanitizeTimeInput={(value) => value}
    isValidHourMinuteTime={(value) => /^\d{2}:\d{2}$/.test(value)}
    refreshToken={token}
    onStatus={() => {}}
  />;
  const { rerender } = render(card(0));
  return { waitForTask, refreshWith: (token: unknown) => rerender(card(token)) };
}

// The one-line keep preview under the controls row.
function preview() {
  return document.querySelector(".backup-keep-preview")?.textContent || "";
}

describe("scheduledPruneCount", () => {
  it("counts the archive the next run adds before pruning", () => {
    expect(scheduledPruneCount(9, 7)).toBe(3);
    expect(scheduledPruneCount(7, 7)).toBe(1);
    expect(scheduledPruneCount(3, 7)).toBe(0);
    expect(scheduledPruneCount(0, 1)).toBe(0);
    expect(scheduledPruneCount(5, 0)).toBe(0);
  });
});

describe("scheduled system backups card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(backupsApi.saveSystemPassphrase).mockResolvedValue({ ok: true, savedAt: "2026-11-09T10:00:00.000Z", replaced: false });
    vi.mocked(backupsApi.removeSystemPassphrase).mockResolvedValue({ ok: true, removed: true });
    vi.mocked(backupsApi.saveSystemAuto).mockResolvedValue({ task: { id: "t1", status: "queued" } as never });
  });

  it("cannot be switched on until a passphrase is saved", async () => {
    mockStatus({ enabled: false, passphraseSaved: false });
    renderCard();
    expect(await screen.findByText("Not Saved")).toBeTruthy();
    const toggle = screen.getByLabelText("Automatic System Backups") as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect((screen.getByText("Save Settings") as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves the passphrase write-only and clears both fields", async () => {
    mockStatus({ passphraseSaved: false });
    renderCard();
    const first = await screen.findByLabelText("Automatic Backup Passphrase") as HTMLInputElement;
    const second = screen.getByLabelText("Confirm Automatic Backup Passphrase") as HTMLInputElement;
    expect(first.type).toBe("password");
    expect(second.type).toBe("password");
    fireEvent.change(first, { target: { value: PASSPHRASE } });
    fireEvent.change(second, { target: { value: PASSPHRASE } });
    mockStatus({ passphraseSaved: true, passphraseSavedAt: "2026-11-09T10:00:00.000Z" });
    fireEvent.click(screen.getByText("Save Passphrase"));

    await waitFor(() => expect(backupsApi.saveSystemPassphrase).toHaveBeenCalledWith(PASSPHRASE, PASSPHRASE));
    expect(await screen.findByText("Passphrase Saved")).toBeTruthy();
    expect(await screen.findByText("Replace Passphrase")).toBeTruthy();
    expect((screen.getByLabelText("New Automatic Backup Passphrase") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Confirm Automatic Backup Passphrase") as HTMLInputElement).value).toBe("");
  });

  it("refuses a mismatch or a degenerate passphrase without calling the API", async () => {
    mockStatus({ passphraseSaved: false });
    renderCard();
    const first = await screen.findByLabelText("Automatic Backup Passphrase");
    const second = screen.getByLabelText("Confirm Automatic Backup Passphrase");
    fireEvent.change(first, { target: { value: PASSPHRASE } });
    fireEvent.change(second, { target: { value: `${PASSPHRASE}x` } });
    fireEvent.click(screen.getByText("Save Passphrase"));
    expect(await screen.findByText(/do not match/)).toBeTruthy();

    fireEvent.change(first, { target: { value: "abababababab" } });
    fireEvent.change(second, { target: { value: "abababababab" } });
    fireEvent.click(screen.getByText("Save Passphrase"));
    expect(await screen.findByText(/5 different characters/)).toBeTruthy();
    expect(backupsApi.saveSystemPassphrase).not.toHaveBeenCalled();
  });

  it("previews what the next run will prune and updates as Keep changes", async () => {
    mockStatus({ passphraseSaved: true, enabled: true, keep: "7", automaticCount: 9, automaticBytes: 9 * 50 * 1024 * 1024 });
    renderCard();
    await waitFor(() => expect(preview()).toContain("Automatic archives stored: 9. The next run removes 3 and keeps 7 (350.0 MB)."));

    fireEvent.click(screen.getByLabelText("Keep one more"));
    expect((screen.getByLabelText("Keep Newest") as HTMLInputElement).value).toBe("8");
    expect(preview()).toContain("The next run removes 2 and keeps 8 (400.0 MB).");

    fireEvent.change(screen.getByLabelText("Keep Newest"), { target: { value: "20" } });
    expect(preview()).toContain("The next run removes 0 and keeps 10 (500.0 MB).");
    expect(preview()).toContain("Manual and imported archives are never removed");
  });

  it("refuses an out-of-range Keep before saving", async () => {
    mockStatus({ passphraseSaved: true, enabled: true, keep: "7" });
    renderCard();
    const keep = await screen.findByLabelText("Keep Newest");
    fireEvent.change(keep, { target: { value: "0" } });
    expect(screen.getAllByText("Keep must be a whole number from 1 to 365.").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Save Settings"));
    await waitFor(() => expect(screen.getByText("Schedule Not Saved")).toBeTruthy());
    expect(backupsApi.saveSystemAuto).not.toHaveBeenCalled();
  });

  it("sends the whole schedule and waits for the task", async () => {
    mockStatus({ passphraseSaved: true, enabled: false, backupTime: "04:30", intervalHours: "24", keep: "7" });
    const { waitForTask } = renderCard();
    const toggle = await screen.findByLabelText("Automatic System Backups") as HTMLInputElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Keep Newest"), { target: { value: "5" } });
    fireEvent.click(toggle);
    await waitFor(() => expect(backupsApi.saveSystemAuto).toHaveBeenCalledWith({ enabled: true, time: "04:30", intervalHours: 24, keep: 5 }));
    expect(waitForTask).toHaveBeenCalled();
  });

  it("keeps unsaved edits when the archive list refreshes", async () => {
    mockStatus({ passphraseSaved: true, enabled: true, keep: "7", automaticCount: 3 });
    const { refreshWith } = renderCard();
    const keep = await screen.findByLabelText("Keep Newest") as HTMLInputElement;
    await waitFor(() => expect(keep.value).toBe("7"));
    fireEvent.change(keep, { target: { value: "4" } });
    mockStatus({ passphraseSaved: true, enabled: true, keep: "7", automaticCount: 4 });
    refreshWith(1);
    await waitFor(() => expect(preview()).toContain("Automatic archives stored: 4."));
    expect((screen.getByLabelText("Keep Newest") as HTMLInputElement).value).toBe("4");
  });

  it("turns the schedule off even while a field holds an invalid value", async () => {
    mockStatus({ passphraseSaved: true, enabled: true, keep: "7" });
    renderCard();
    const toggle = await screen.findByLabelText("Automatic System Backups") as HTMLInputElement;
    await waitFor(() => expect(toggle.checked).toBe(true));
    fireEvent.change(screen.getByLabelText("Keep Newest"), { target: { value: "0" } });
    fireEvent.click(toggle);
    // A bare disable: the saved policy stays as it was.
    await waitFor(() => expect(backupsApi.saveSystemAuto).toHaveBeenCalledWith({ enabled: false }));
  });

  it("saves edits made while the schedule is off", async () => {
    mockStatus({ passphraseSaved: true, enabled: false, backupTime: "04:30", intervalHours: "24", keep: "7" });
    renderCard();
    const keep = await screen.findByLabelText("Keep Newest");
    await waitFor(() => expect((screen.getByText("Save Settings") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(keep, { target: { value: "3" } });
    fireEvent.click(screen.getByText("Save Settings"));
    await waitFor(() => expect(backupsApi.saveSystemAuto).toHaveBeenCalledWith({ enabled: false, time: "04:30", intervalHours: 24, keep: 3 }));
  });

  it("shows the same status grid as the database Automatic Backups section", async () => {
    mockStatus({ passphraseSaved: true, enabled: true, backupTime: "04:30", intervalHours: "12", keep: "5", timer: "enabled", nextRun: "Tue 2026-11-10 04:30:00 UTC", lastRunAt: "2026-11-09T04:30:02Z", lastResult: "success" });
    renderCard();
    const grid = (await screen.findByText("Current Status")).closest(".key-value-grid") as HTMLElement;
    const value = (label: string) => within(grid).getByText(label).nextElementSibling?.textContent;
    await waitFor(() => expect(value("Current Status")).toBe("Enabled"));
    expect(value("First Backup Time (Local Server Time)")).toBe("04:30");
    expect(value("Interval")).toBe("Every 12 hours");
    expect(value("Keep")).toBe("Newest 5");
    expect(value("Timer")).toBe("Active");
    expect(value("Next Run")).toBe("Tue 2026-11-10 04:30:00 UTC");
    expect(value("Last Run")).toMatch(/success$/);
  });

  it("will not remove the passphrase while the schedule is on", async () => {
    mockStatus({ passphraseSaved: true, enabled: true });
    renderCard();
    const remove = await screen.findByText("Remove Passphrase") as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
  });
});
