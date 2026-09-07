import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { backupsApi } from "../../api/backups";
import { setCsrfToken } from "../../api/client";
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
      restoreSystem: vi.fn(),
      importSystemUrl: vi.fn(original.backupsApi.importSystemUrl)
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
    chooseImportConflict={vi.fn(async () => "rename" as const)}
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

async function openCreate() {
  // The button now opens the panel rather than creating straight away, so the
  // passphrase fields do not exist until it is clicked.
  fireEvent.click(await screen.findByText("Create System Backup"));
}

async function fillPassphrases(first: string, second: string) {
  await openCreate();
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
    await openCreate();
    const button = await screen.findByLabelText("Create the system backup");
    expect(button).toBeDisabled();
    const passphrase = await screen.findByLabelText(/^Passphrase$/);
    const confirm = await screen.findByLabelText(/Confirm Passphrase/);
    fireEvent.change(passphrase, { target: { value: PASSPHRASE } });
    fireEvent.change(confirm, { target: { value: PASSPHRASE } });
    expect(button).not.toBeDisabled();
  });

  it("refuses a mismatch without calling the API", async () => {
    renderPanel();
    await fillPassphrases(PASSPHRASE, "something-else-entirely");
    fireEvent.click(await screen.findByLabelText("Create the system backup"));
    await waitFor(() => expect(screen.getByText(/do not match/i)).toBeTruthy());
    expect(backupsApi.createSystem).not.toHaveBeenCalled();
  });

  it("refuses a degenerate passphrase without calling the API", async () => {
    renderPanel();
    await fillPassphrases("aaaaaaaaaaaaaa", "aaaaaaaaaaaaaa");
    fireEvent.click(await screen.findByLabelText("Create the system backup"));
    await waitFor(() => expect(screen.getByText(/at least 5 different characters/i)).toBeTruthy());
    expect(backupsApi.createSystem).not.toHaveBeenCalled();
  });

  it("refuses a short passphrase without calling the API", async () => {
    renderPanel();
    await fillPassphrases("short", "short");
    fireEvent.click(await screen.findByLabelText("Create the system backup"));
    await waitFor(() => expect(screen.getByText(/at least 12 characters/i)).toBeTruthy());
    expect(backupsApi.createSystem).not.toHaveBeenCalled();
  });

  it("sends the passphrase and then clears both fields", async () => {
    renderPanel();
    const { passphrase, confirm } = await fillPassphrases(PASSPHRASE, PASSPHRASE);
    fireEvent.click(await screen.findByLabelText("Create the system backup"));
    await waitFor(() => expect(backupsApi.createSystem).toHaveBeenCalledWith(PASSPHRASE));
    // Never leave a passphrase sitting in the DOM.
    await waitFor(() => expect((passphrase as HTMLInputElement).value).toBe(""));
    expect((confirm as HTMLInputElement).value).toBe("");
  });

  it("clears the fields on failure too", async () => {
    vi.mocked(backupsApi.createSystem).mockRejectedValue(new Error("gpg exploded"));
    renderPanel();
    const { passphrase, confirm } = await fillPassphrases(PASSPHRASE, PASSPHRASE);
    fireEvent.click(await screen.findByLabelText("Create the system backup"));
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

describe("importing a system backup", () => {
  const ROW = {
    name: ARCHIVE, createdAt: "2026-08-30T12:00:00-04:00", origin: "manual",
    encryption: "aes-256-ocb-gpg-aead", serverTitle: "Kovalt", battlegroupId: "sh-abc-def",
    type: "Manual Backup", source: "Local", hasSidecar: true, sizeBytes: 2048, size: "2 KB"
  };
  let sent: { url: string; body: unknown; headers: Record<string, string>; withCredentials: boolean }[] = [];
  let responses: { status: number; body: unknown }[] = [];

  class FakeXhr {
    url = "";
    headers: Record<string, string> = {};
    withCredentials = false;
    status = 0;
    responseText = "";
    upload = { onprogress: null as ((event: unknown) => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    open(_method: string, url: string) { this.url = url; }
    setRequestHeader(name: string, value: string) { this.headers[name] = value; }
    send(body: unknown) {
      sent.push({ url: this.url, body, headers: this.headers, withCredentials: this.withCredentials });
      const next = responses.shift() || { status: 200, body: { ok: true, backup: ARCHIVE } };
      this.status = next.status;
      this.responseText = JSON.stringify(next.body);
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 });
      this.onload?.();
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sent = [];
    responses = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    vi.mocked(backupsApi.list).mockResolvedValue({ stdout: "", currentBattlegroupId: "sh-1", rows: [] });
    vi.mocked(backupsApi.autoStatus).mockResolvedValue({ stdout: "", status: { enabled: false } });
    vi.mocked(backupsApi.listSystem).mockResolvedValue({ rows: [ROW] });
  });

  function chooseFile(name = "dune-system-20260830-120000-4711-9931.tar.gz.enc.tar") {
    const input = screen.getByLabelText(/Backup file/);
    const file = new File(["payload"], name, { type: "application/x-tar" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
    return file;
  }

  it("opens the import panel from the button row", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("Import Backup"));
    expect(await screen.findByLabelText(/Backup file/)).toBeTruthy();
  });

  it("will not upload until a file is chosen", async () => {
    renderPanel();
    fireEvent.click(await screen.findByText("Import Backup"));
    const button = await screen.findByLabelText("Import system backup");
    expect(button).toBeDisabled();
    chooseFile();
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it("closes the restore panel, so two forms are never open at once", async () => {
    renderPanel();
    fireEvent.click(await screen.findByLabelText(`Restore system backup ${ARCHIVE}`));
    expect(await screen.findByLabelText("Restore passphrase")).toBeTruthy();
    fireEvent.click(await screen.findByText("Import Backup"));
    await waitFor(() => expect(screen.queryByLabelText("Restore passphrase")).toBeNull());
    expect(screen.getByLabelText(/Backup file/)).toBeTruthy();
  });

  it("opening import closes create, and opening create closes import", async () => {
    // Create, import and restore share one slot: three forms stacked above the
    // table would be worse than any one of them being a click away.
    renderPanel();
    fireEvent.click(await screen.findByText("Create System Backup"));
    expect(await screen.findByLabelText(/^Passphrase$/)).toBeTruthy();

    fireEvent.click(await screen.findByText("Import Backup"));
    await waitFor(() => expect(screen.queryByLabelText(/^Passphrase$/)).toBeNull());
    expect(screen.getByLabelText(/Backup file/)).toBeTruthy();

    fireEvent.click(await screen.findByText("Create System Backup"));
    await waitFor(() => expect(screen.queryByLabelText(/Backup file/)).toBeNull());
    expect(screen.getByLabelText(/^Passphrase$/)).toBeTruthy();
  });

  it("uploads the file and reports where it was stored", async () => {
    responses = [{ status: 200, body: { ok: true, backup: ARCHIVE, hadSidecar: true } }];
    renderPanel();
    fireEvent.click(await screen.findByText("Import Backup"));
    chooseFile();
    fireEvent.click(await screen.findByLabelText("Import system backup"));
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0].url).toContain("filename=");
    await waitFor(() => expect(screen.getByText(/Stored as/)).toBeTruthy());
  });

  it("says so when no sidecar came with the archive", async () => {
    responses = [{ status: 200, body: { ok: true, backup: ARCHIVE, hadSidecar: false } }];
    renderPanel();
    fireEvent.click(await screen.findByText("Import Backup"));
    chooseFile();
    fireEvent.click(await screen.findByLabelText("Import system backup"));
    // Otherwise the Unknown columns look like a bug rather than a consequence.
    await waitFor(() => expect(screen.getByText(/read Unknown/)).toBeTruthy());
  });

  it("asks before overwriting, and resends the answer", async () => {
    responses = [
      { status: 409, body: { error: "exists", conflict: ARCHIVE } },
      { status: 200, body: { ok: true, backup: "dune-system-20260901-000000-1-2.tar.gz.enc", renamedFrom: ARCHIVE } }
    ];
    renderPanel();
    fireEvent.click(await screen.findByText("Import Backup"));
    chooseFile();
    fireEvent.click(await screen.findByLabelText("Import system backup"));
    await waitFor(() => expect(sent.length).toBe(2));
    // The server refuses to guess; the second request carries the operator's answer.
    expect(sent[0].url).not.toContain("onConflict");
    expect(sent[1].url).toContain("onConflict=rename");
    await waitFor(() => expect(screen.getByText(/to avoid overwriting/)).toBeTruthy());
  });

  it("sends nothing more when the conflict prompt is cancelled", async () => {
    responses = [{ status: 409, body: { error: "exists", conflict: ARCHIVE } }];
    renderPanel({ chooseImportConflict: vi.fn(async () => "cancel" as const) });
    fireEvent.click(await screen.findByText("Import Backup"));
    chooseFile();
    fireEvent.click(await screen.findByLabelText("Import system backup"));
    await waitFor(() => expect(sent.length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent.length).toBe(1);
  });

  it("sends the CSRF header and cookies, like every other mutating request", async () => {
    // The first version built an XHR in this panel and sent neither, so the
    // server rejected the upload as an expired login. Going through the shared
    // client is what fixes it, and this is the assertion that would have caught
    // it without a live host.
    setCsrfToken("token-abc");
    responses = [{ status: 200, body: { ok: true, backup: ARCHIVE, hadSidecar: true } }];
    renderPanel();
    fireEvent.click(await screen.findByText("Import Backup"));
    chooseFile();
    fireEvent.click(await screen.findByLabelText("Import system backup"));
    await waitFor(() => expect(sent.length).toBe(1));
    assert_eq(sent[0].headers["x-csrf-token"], "token-abc");
    assert_eq(sent[0].withCredentials, true);
  });

  it("surfaces a rejection from the server", async () => {
    responses = [{ status: 400, body: { error: "That file is not an OpenPGP message." } }];
    renderPanel();
    fireEvent.click(await screen.findByText("Import Backup"));
    chooseFile("notes.zip");
    fireEvent.click(await screen.findByLabelText("Import system backup"));
    await waitFor(() => expect(screen.getByText(/not an OpenPGP message/)).toBeTruthy());
  });
});
