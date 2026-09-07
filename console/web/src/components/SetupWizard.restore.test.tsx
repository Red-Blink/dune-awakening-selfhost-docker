import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SetupWizard } from "./SetupWizard";
import { setupApi } from "../api/setup";
import { backupsApi } from "../api/backups";
import { updatesApi } from "../api/updates";
import { serverApi } from "../api/server";
import { apiUpload } from "../api/client";

vi.mock("../api/setup", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/setup")>();
  return { ...original, setupApi: { state: vi.fn(), tasks: vi.fn(), task: vi.fn(), preflight: vi.fn(), writeConfig: vi.fn(), saveToken: vi.fn(), init: vi.fn() } };
});
vi.mock("../api/backups", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/backups")>();
  return { ...original, backupsApi: { ...original.backupsApi, restoreSystem: vi.fn(), importSystemUrl: vi.fn(original.backupsApi.importSystemUrl) } };
});
vi.mock("../api/updates", () => ({ updatesApi: { installAssets: vi.fn() } }));
vi.mock("../api/server", () => ({ serverApi: { reloadConsole: vi.fn() } }));
vi.mock("../api/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/client")>();
  return { ...original, apiUpload: vi.fn() };
});

// jsdom implements no EventSource, and TaskProgress opens one as soon as a task
// is rendered. Without this the whole panel fails to mount.
class FakeEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}
vi.stubGlobal("EventSource", FakeEventSource);

const done = (id: string) => ({ id, type: "backup", operation: "x", status: "succeeded", currentStep: "", progressMessage: "", logLines: [], warnings: [], startedAt: "", finishedAt: "", exitCode: 0, errorMessage: null });

function renderWizard() {
  return render(<SetupWizard mode="first-run" />);
}

async function chooseRestore() {
  renderWizard();
  fireEvent.click(await screen.findByText("Restore a Dune Docker system backup"));
}

// The host step gates Next until its checks pass, so a test cannot simply click
// through: it has to run them, the way the operator does.
async function walkToArchive() {
  await chooseRestore();
  fireEvent.click(screen.getByText("Next"));
  fireEvent.click(await screen.findByText("Run Checks"));
  await waitFor(() => expect(screen.getByText("Next")).not.toBeDisabled());
  fireEvent.click(screen.getByText("Next"));
  fireEvent.click(screen.getByText("Next"));
  fireEvent.click(screen.getByText("Next"));
  return screen.findByLabelText("System backup archive");
}

describe("setup wizard restore path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(setupApi.state).mockResolvedValue({ files: {}, serverConfig: {} } as never);
    vi.mocked(setupApi.tasks).mockResolvedValue({ tasks: [] } as never);
    vi.mocked(setupApi.preflight).mockResolvedValue({ checks: [{ id: "docker", label: "Docker", status: "pass", detail: "" }] } as never);
    vi.mocked(setupApi.task).mockImplementation(async (id: string) => ({ task: done(id) }) as never);
    vi.mocked(apiUpload).mockResolvedValue({ status: 200, body: { ok: true, backup: "dune-system-20260907-004052.tar.gz.enc" } } as never);
    vi.mocked(updatesApi.installAssets).mockResolvedValue({ task: done("assets") } as never);
    vi.mocked(backupsApi.restoreSystem).mockResolvedValue({ task: done("restore") } as never);
    vi.mocked(serverApi.reloadConsole).mockResolvedValue({ task: done("reload") } as never);
    window.localStorage.clear();
  });

  it("swaps in the restore steps and drops the ones the archive supplies", async () => {
    await chooseRestore();
    // Identity, token, ports and review all collect values the restore
    // overwrites; asking for them would be typing for nothing.
    expect(screen.queryByText("5. Server Identity")).toBeNull();
    expect(screen.queryByText("6. Funcom Token")).toBeNull();
    expect(await screen.findByText("5. Backup Archive")).toBeTruthy();
    expect(screen.getByText("6. Passphrase")).toBeTruthy();
    expect(screen.getByText("7. Restore")).toBeTruthy();
  });

  it("refuses a Funcom database backup in the browser, before uploading", async () => {
    const picker = await walkToArchive();
    fireEvent.change(picker, { target: { files: [new File(["x"], "steelheart-20260907.backup")] } });

    // The step already carries a standing warning about Funcom backups, so match
    // the rejection itself rather than the phrase they share.
    expect(await screen.findByText(/not a system backup/i)).toBeTruthy();
    expect(screen.getByText(/Look for dune-system/i)).toBeTruthy();
    // The point of the client-side check: no upload is attempted at all.
    expect(apiUpload).not.toHaveBeenCalled();
  });

  it("uploads an archive and reports the name it was stored under", async () => {
    const picker = await walkToArchive();
    fireEvent.change(picker, { target: { files: [new File(["x"], "dune-system-20260907-004052.tar")] } });

    await waitFor(() => expect(apiUpload).toHaveBeenCalled());
    expect(await screen.findByText(/dune-system-20260907-004052\.tar\.gz\.enc/)).toBeTruthy();
  });

  it("restores by the name the server stored, not the local filename", async () => {
    // A .tar bundle is unwrapped server-side into dune-system-*.tar.gz.enc, and
    // every later route validates that shape. Restoring by the uploaded file's
    // own name fails with "Invalid system backup name".
    const picker = await walkToArchive();
    fireEvent.change(picker, { target: { files: [new File(["x"], "my-download (1).tar")] } });
    await waitFor(() => expect(apiUpload).toHaveBeenCalled());

    fireEvent.click(screen.getByText("Next"));
    const field = await screen.findByLabelText("Archive passphrase");
    fireEvent.change(field, { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByText("Next"));
    fireEvent.click(await screen.findByText("Start Restore"));

    await waitFor(() => expect(backupsApi.restoreSystem).toHaveBeenCalledWith(
      "dune-system-20260907-004052.tar.gz.enc",
      expect.anything()
    ));
  });

  it("surfaces an upload the server refused instead of carrying on", async () => {
    vi.mocked(apiUpload).mockResolvedValue({ status: 400, body: { error: "That is not an OpenPGP message." } } as never);
    const picker = await walkToArchive();
    fireEvent.change(picker, { target: { files: [new File(["x"], "dune-system-20260907.tar")] } });

    expect(await screen.findByText(/not an OpenPGP message/i)).toBeTruthy();
  });

  it("runs install, dry run, apply and console reload in that order", async () => {
    const order: string[] = [];
    vi.mocked(updatesApi.installAssets).mockImplementation(async () => { order.push("install"); return { task: done("assets") } as never; });
    vi.mocked(backupsApi.restoreSystem).mockImplementation(async (_name: string, options: { apply?: boolean }) => {
      order.push(options.apply ? "apply" : "dry-run");
      return { task: done("restore") } as never;
    });
    vi.mocked(serverApi.reloadConsole).mockImplementation(async () => { order.push("reload"); return { task: done("reload") } as never; });

    window.localStorage.setItem("arrakis.setupRestore", JSON.stringify({ archive: "dune-system-x.tar.gz.enc", stage: "uploaded" }));
    renderWizard();
    const field = await screen.findByLabelText("Archive passphrase");
    fireEvent.change(field, { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByText("Next"));
    fireEvent.click(await screen.findByText("Start Restore"));

    await waitFor(() => expect(order).toEqual(["install", "dry-run", "apply", "reload"]));
  });

  it("comes back to the restore step after a reload mid-restore", async () => {
    // install-assets writes image-tags.env, which is enough for the server to
    // call setup complete -- without this the operator lands on the console.
    vi.mocked(setupApi.tasks).mockResolvedValue({
      tasks: [{ ...done("running"), operation: "backupSystemRestore", status: "running" }]
    } as never);
    window.localStorage.setItem("arrakis.setupRestore", JSON.stringify({ archive: "dune-system-x.tar.gz.enc", stage: "Restoring" }));

    renderWizard();
    expect(await screen.findByText("Restore")).toBeTruthy();
    expect(screen.getByText(/Restoring/)).toBeTruthy();
  });
});
