import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { backupsApi } from "../../api/backups";
import { BackupsPanel } from "./BackupsPanel";

const assert_eq = (actual: unknown, expected: unknown) => expect(actual).toEqual(expected);

vi.mock("../../api/backups", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../api/backups")>();
  return {
    ...original,
    backupsApi: {
      list: vi.fn(),
      autoStatus: vi.fn(),
      listSystem: vi.fn(),
      createSystem: vi.fn(),
      create: vi.fn(),
      restore: vi.fn(),
      delete: vi.fn(),
      deleteAll: vi.fn(),
      deleteSelected: vi.fn(),
      importExternal: vi.fn(),
      saveAuto: vi.fn(),
      downloadUrl: vi.fn(original.backupsApi.downloadUrl),
      systemDownloadUrl: vi.fn(original.backupsApi.systemDownloadUrl),
      deleteSystem: vi.fn(),
      deleteSystemSelected: vi.fn(),
      deleteSystemAll: vi.fn(),
      restoreSystem: vi.fn()
    }
  };
});

const ARCHIVE = "dune-system-20260830-120000-4711-9931.tar.gz.enc";
const PASSPHRASE = "correct-horse-battery-staple";

function renderPanel(overrides: Partial<Parameters<typeof BackupsPanel>[0]> = {}) {
  return render(<BackupsPanel
    backupRestoreTask={null}
    setBackupRestoreTask={() => {}}
    onError={() => {}}
    confirmAction={vi.fn(async () => true)}
    chooseBackupIdentity={vi.fn(async () => "keep-current" as const)}
    waitForTask={vi.fn(async (task) => ({ ...task, status: "succeeded" }))}
    waitForTaskWithUpdates={vi.fn(async (task) => task)}
    withTimeout={((promise: Promise<unknown>) => promise) as never}
    toHourMinuteTime={(value) => String(value ?? "")}
    sanitizeTimeInput={(value) => value}
    isValidHourMinuteTime={() => true}
    commandStatusSummary={() => ({ status: "ok" })}
    taskTechnicalDetails={() => ""}
    isTerminalTask={() => true}
    {...overrides}
  />);
}

async function fillPassphrases(first: string, second: string) {
  const passphrase = await screen.findByLabelText(/^Passphrase$/);
  const confirm = await screen.findByLabelText(/Confirm Passphrase/);
  fireEvent.change(passphrase, { target: { value: first } });
  fireEvent.change(confirm, { target: { value: second } });
  return { passphrase, confirm };
}


async function systemSection() {
  const heading = await screen.findByText("System Backups (Encrypted)");
  const section = heading.closest("section");
  if (!section) throw new Error("system backups section not found");
  return within(section);
}

describe("system backups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(backupsApi.list).mockResolvedValue({ stdout: "", currentBattlegroupId: "sh-1", rows: [] });
    vi.mocked(backupsApi.autoStatus).mockResolvedValue({ stdout: "", status: { enabled: false } });
    vi.mocked(backupsApi.listSystem).mockResolvedValue({ rows: [] });
    vi.mocked(backupsApi.createSystem).mockResolvedValue({ task: { id: "t1", status: "queued" } as never });
  });

  it("uses the same column names as the database table, in the same order", async () => {
    vi.mocked(backupsApi.listSystem).mockResolvedValue({ rows: [{
      name: ARCHIVE, createdAt: "2026-08-30T12:00:00-04:00", origin: "manual",
      encryption: "aes-256-ocb-gpg-aead", serverTitle: "Kovalt", battlegroupId: "sh-abc-def",
      type: "Manual Backup", source: "Local", hasSidecar: true, sizeBytes: 2048, size: "2 KB"
    }] });
    renderPanel();
    const section = await systemSection();
    const headers = [...(await section.findAllByRole("columnheader"))].map((th) => th.textContent?.trim());
    // Checkbox column first, Actions last; the six between match the database
    // table's names and order, with Encryption appended.
    assert_eq(headers.slice(1, -1), ["Backup Name", "Battlegroup ID", "Created", "Size", "Type", "Source", "Encryption"]);
  });

  it("labels the backup groups so the two kinds are distinguishable", async () => {
    renderPanel();
    // The database backups carry no config or credentials; the system archive
    // carries both. The headers are what tells them apart.
    expect(await screen.findByText("Funcom Backups")).toBeTruthy();
    expect(await screen.findByText("System Backups (Encrypted)")).toBeTruthy();
    expect(await screen.findByText(/no console configuration and no credentials/i)).toBeTruthy();
  });

  it("keeps the passphrase fields masked", async () => {
    renderPanel();
    const { passphrase, confirm } = await fillPassphrases(PASSPHRASE, PASSPHRASE);
    expect(passphrase.getAttribute("type")).toBe("password");
    expect(confirm.getAttribute("type")).toBe("password");
  });

  it("will not create until both fields are filled", async () => {
    renderPanel();
    const button = await screen.findByText("Create System Backup");
    expect(button).toBeDisabled();
    await fillPassphrases(PASSPHRASE, PASSPHRASE);
    expect(button).not.toBeDisabled();
  });

  it("refuses a mismatch without calling the API", async () => {
    renderPanel();
    await fillPassphrases(PASSPHRASE, "something-else-entirely");
    fireEvent.click(await screen.findByText("Create System Backup"));
    await waitFor(() => expect(screen.getByText(/do not match/i)).toBeTruthy());
    expect(backupsApi.createSystem).not.toHaveBeenCalled();
  });

  it("refuses a degenerate passphrase without calling the API", async () => {
    renderPanel();
    await fillPassphrases("aaaaaaaaaaaaaa", "aaaaaaaaaaaaaa");
    fireEvent.click(await screen.findByText("Create System Backup"));
    await waitFor(() => expect(screen.getByText(/at least 5 different characters/i)).toBeTruthy());
    expect(backupsApi.createSystem).not.toHaveBeenCalled();
  });

  it("refuses a short passphrase without calling the API", async () => {
    renderPanel();
    await fillPassphrases("short", "short");
    fireEvent.click(await screen.findByText("Create System Backup"));
    await waitFor(() => expect(screen.getByText(/at least 12 characters/i)).toBeTruthy());
    expect(backupsApi.createSystem).not.toHaveBeenCalled();
  });

  it("sends the passphrase and then clears both fields", async () => {
    renderPanel();
    const { passphrase, confirm } = await fillPassphrases(PASSPHRASE, PASSPHRASE);
    fireEvent.click(await screen.findByText("Create System Backup"));
    await waitFor(() => expect(backupsApi.createSystem).toHaveBeenCalledWith(PASSPHRASE));
    // Never leave a passphrase sitting in the DOM.
    await waitFor(() => expect((passphrase as HTMLInputElement).value).toBe(""));
    expect((confirm as HTMLInputElement).value).toBe("");
  });

  it("clears the fields on failure too", async () => {
    vi.mocked(backupsApi.createSystem).mockRejectedValue(new Error("gpg exploded"));
    renderPanel();
    const { passphrase, confirm } = await fillPassphrases(PASSPHRASE, PASSPHRASE);
    fireEvent.click(await screen.findByText("Create System Backup"));
    await waitFor(() => expect((passphrase as HTMLInputElement).value).toBe(""));
    expect((confirm as HTMLInputElement).value).toBe("");
  });

  it("lists existing archives with a download link", async () => {
    vi.mocked(backupsApi.listSystem).mockResolvedValue({
      rows: [{
        name: ARCHIVE, createdAt: "2026-08-30T12:00:00-04:00", origin: "manual",
        encryption: "aes-256-ocb-gpg-aead", serverTitle: "Kovalt", battlegroupId: "sh-abc-def",
        type: "Manual Backup", source: "Local",
        hasSidecar: true, sizeBytes: 2048, size: "2 KB"
      }]
    });
    renderPanel();
    const link = await screen.findByLabelText(`Download system backup ${ARCHIVE}`);
    expect(link.getAttribute("href")).toBe(`/api/backups/system/${encodeURIComponent(ARCHIVE)}/download`);
  });
});

describe("deleting system backups", () => {
  // Sibling describe, so the other block's beforeEach does not run here --
  // clear and stub everything this one needs rather than inheriting state.
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(backupsApi.list).mockResolvedValue({ stdout: "", currentBattlegroupId: "sh-1", rows: [] });
    vi.mocked(backupsApi.autoStatus).mockResolvedValue({ stdout: "", status: { enabled: false } });
    vi.mocked(backupsApi.listSystem).mockResolvedValue({ rows: [{
        name: ARCHIVE, createdAt: "2026-08-30T12:00:00-04:00", origin: "manual",
        encryption: "aes-256-ocb-gpg-aead", serverTitle: "Kovalt", battlegroupId: "sh-abc-def",
        type: "Manual Backup", source: "Local",
        hasSidecar: true, sizeBytes: 2048, size: "2 KB"
    }] });
    vi.mocked(backupsApi.deleteSystem).mockResolvedValue({ task: { id: "d1", status: "queued" } as never });
    vi.mocked(backupsApi.deleteSystemAll).mockResolvedValue({ task: { id: "d2", status: "queued" } as never });
    vi.mocked(backupsApi.deleteSystemSelected).mockResolvedValue({ task: { id: "d3", status: "queued" } as never });
  });

  it("deletes a single archive after confirmation", async () => {
    renderPanel();
    fireEvent.click(await screen.findByLabelText(`Delete system backup ${ARCHIVE}`));
    await waitFor(() => expect(backupsApi.deleteSystem).toHaveBeenCalledWith(ARCHIVE));
  });

  it("does not delete when the confirmation is declined", async () => {
    renderPanel({ confirmAction: vi.fn(async () => false) });
    fireEvent.click(await screen.findByLabelText(`Delete system backup ${ARCHIVE}`));
    await waitFor(() => expect(screen.getByLabelText(`Delete system backup ${ARCHIVE}`)).toBeTruthy());
    expect(backupsApi.deleteSystem).not.toHaveBeenCalled();
  });

  it("enables Delete Selected only once something is selected", async () => {
    renderPanel();
    const section = await systemSection();
    const button = await section.findByText(/^Delete Selected/);
    expect(button).toBeDisabled();
    fireEvent.click(await screen.findByLabelText(`Select system backup ${ARCHIVE}`));
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() => expect(backupsApi.deleteSystemSelected).toHaveBeenCalledWith([ARCHIVE]));
  });

  it("deletes them all", async () => {
    renderPanel();
    const section = await systemSection();
    fireEvent.click(await section.findByText("Delete All"));
    await waitFor(() => expect(backupsApi.deleteSystemAll).toHaveBeenCalled());
  });
});

describe("restoring a system backup", () => {
  // Sibling describe: stub everything it needs rather than inheriting state.
  const ROW = {
    name: ARCHIVE, createdAt: "2026-08-30T12:00:00-04:00", origin: "manual",
    encryption: "aes-256-ocb-gpg-aead", serverTitle: "Kovalt", battlegroupId: "sh-abc-def",
    type: "Manual Backup", source: "Local", hasSidecar: true, sizeBytes: 2048, size: "2 KB"
  };
  const RESTORE_PASSPHRASE = "correct-horse-battery-staple";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(backupsApi.list).mockResolvedValue({ stdout: "", currentBattlegroupId: "sh-1", rows: [] });
    vi.mocked(backupsApi.autoStatus).mockResolvedValue({ stdout: "", status: { enabled: false } });
    vi.mocked(backupsApi.listSystem).mockResolvedValue({ rows: [ROW] });
    vi.mocked(backupsApi.restoreSystem).mockResolvedValue(
      { task: { id: "r1", status: "queued", logLines: [{ line: "Dry run: nothing was changed" }] } } as never
    );
  });

  async function openRestore() {
    fireEvent.click(await screen.findByLabelText(`Restore system backup ${ARCHIVE}`));
    return screen.findByLabelText("Restore passphrase");
  }

  async function preview(passphrase = RESTORE_PASSPHRASE) {
    renderPanel();
    const field = await openRestore();
    fireEvent.change(field, { target: { value: passphrase } });
    fireEvent.click(await screen.findByText("Preview Restore"));
    return field;
  }

  it("previews without applying, so a first click can never replace the host", async () => {
    await preview();
    await waitFor(() => expect(backupsApi.restoreSystem).toHaveBeenCalledWith(ARCHIVE, {
      passphrase: RESTORE_PASSPHRASE, apply: false
    }));
  });

  it("keeps Apply disabled until a preview has succeeded", async () => {
    renderPanel();
    const field = await openRestore();
    const applyButton = await screen.findByText("Apply Restore");
    expect(applyButton).toBeDisabled();
    fireEvent.change(field, { target: { value: RESTORE_PASSPHRASE } });
    // Still locked: a filled field is not proof the passphrase opens the archive.
    expect(applyButton).toBeDisabled();
    fireEvent.click(await screen.findByText("Preview Restore"));
    await waitFor(() => expect(applyButton).not.toBeDisabled());
  });

  it("re-locks Apply when the passphrase is edited after a preview", async () => {
    const field = await preview();
    const applyButton = await screen.findByText("Apply Restore");
    await waitFor(() => expect(applyButton).not.toBeDisabled());
    // Otherwise apply would run under a passphrase the preview never proved.
    fireEvent.change(field, { target: { value: `${RESTORE_PASSPHRASE}x` } });
    expect(applyButton).toBeDisabled();
  });

  it("leaves Apply locked when the preview fails", async () => {
    vi.mocked(backupsApi.restoreSystem).mockRejectedValue(new Error("could not be decrypted"));
    await preview("wrong-passphrase-here");
    await waitFor(() => expect(screen.getByText(/could not be decrypted/i)).toBeTruthy());
    expect(await screen.findByText("Apply Restore")).toBeDisabled();
  });

  it("applies only after confirmation, carrying the identity choice", async () => {
    await preview();
    await waitFor(() => expect(screen.getByText("Apply Restore")).not.toBeDisabled());
    fireEvent.click(screen.getByText("Apply Restore"));
    await waitFor(() => expect(backupsApi.restoreSystem).toHaveBeenLastCalledWith(ARCHIVE, {
      passphrase: RESTORE_PASSPHRASE, apply: true, identityMode: "keep-current"
    }));
  });

  it("does not apply when the confirmation is declined", async () => {
    renderPanel({ confirmAction: vi.fn(async () => false) });
    const field = await openRestore();
    fireEvent.change(field, { target: { value: RESTORE_PASSPHRASE } });
    fireEvent.click(await screen.findByText("Preview Restore"));
    await waitFor(() => expect(screen.getByText("Apply Restore")).not.toBeDisabled());
    fireEvent.click(screen.getByText("Apply Restore"));
    // The preview call is allowed; the destructive one must not happen.
    await waitFor(() => expect(screen.getByLabelText("Restore passphrase")).toBeTruthy());
    expect(vi.mocked(backupsApi.restoreSystem).mock.calls.every(([, body]) => body.apply === false)).toBe(true);
  });

  it("says a restart is required once the restore succeeds", async () => {
    await preview();
    await waitFor(() => expect(screen.getByText("Apply Restore")).not.toBeDisabled());
    fireEvent.click(screen.getByText("Apply Restore"));
    // The database is restored but the running stack still holds the old
    // configuration -- saying so is the whole point of the card.
    await waitFor(() => expect(screen.getByText(/restart it from Server Controls/i)).toBeTruthy());
  });

  it("clears the passphrase from the DOM once the restore finishes", async () => {
    await preview();
    await waitFor(() => expect(screen.getByText("Apply Restore")).not.toBeDisabled());
    fireEvent.click(screen.getByText("Apply Restore"));
    await waitFor(() => expect(screen.queryByLabelText("Restore passphrase")).toBeNull());
  });
});
