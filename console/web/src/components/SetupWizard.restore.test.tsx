import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  return { ...original, backupsApi: { ...original.backupsApi, restoreSystem: vi.fn(), listSystem: vi.fn(), importSystemUrl: vi.fn(original.backupsApi.importSystemUrl) } };
});
vi.mock("../api/updates", () => ({ updatesApi: { installAssets: vi.fn() } }));
vi.mock("../api/server", () => ({ serverApi: { reloadConsole: vi.fn(), start: vi.fn() } }));
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
    vi.mocked(serverApi.start).mockResolvedValue({ task: done("start") } as never);
    vi.mocked(backupsApi.listSystem).mockResolvedValue({ rows: [{ name: "dune-system-x.tar.gz.enc" }] } as never);
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

  it("links the Funcom token requirement to the account site", async () => {
    // The welcome step names the token as a prerequisite without saying where
    // to get one, which is the first thing a new operator has to go and find.
    renderWizard();
    const link = await screen.findByRole("link", { name: "Funcom self-host token" });
    expect(link.getAttribute("href")).toBe("https://account.duneawakening.com/");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("re-locks the stepper when the operator switches path", async () => {
    // The two paths are different step lists, so progress through one says
    // nothing about the other. Walking the restore path and switching back
    // unlocked a deploy step that was never satisfied.
    await walkToArchive();

    fireEvent.click(screen.getByText("1. Welcome"));
    fireEvent.click(await screen.findByText("Deploy a new server"));

    const identity = await screen.findByText("5. Server Identity");
    expect(identity).toBeDisabled();
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
    vi.mocked(serverApi.start).mockImplementation(async () => { order.push("start"); return { task: done("start") } as never; });
    vi.mocked(serverApi.reloadConsole).mockImplementation(async () => { order.push("reload"); return { task: done("reload") } as never; });

    window.localStorage.setItem("arrakis.setupRestore", JSON.stringify({ archive: "dune-system-x.tar.gz.enc", stage: "uploaded" }));
    renderWizard();
    const field = await screen.findByLabelText("Archive passphrase");
    fireEvent.change(field, { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByText("Next"));
    fireEvent.click(await screen.findByText("Start Restore"));

    // The reload is deliberately not in this list: it is held behind the finish
    // screen's countdown, because restarting the console takes the page away
    // and that screen is the only confirmation the operator ever gets.
    await waitFor(() => expect(order).toEqual(["install", "dry-run", "apply", "start"]));
    expect(await screen.findByText("Congratulations")).toBeTruthy();
    expect(screen.getByText(/Restarting the console in/)).toBeTruthy();
    expect(serverApi.reloadConsole).not.toHaveBeenCalled();
  });

  it("restarts the console only once the countdown has run down", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      window.localStorage.setItem("arrakis.setupRestore", JSON.stringify({ archive: "dune-system-x.tar.gz.enc", stage: "uploaded" }));
      renderWizard();
      const field = await screen.findByLabelText("Archive passphrase");
      fireEvent.change(field, { target: { value: "correct-horse-battery" } });
      fireEvent.click(screen.getByText("Next"));
      fireEvent.click(await screen.findByText("Start Restore"));
      await waitFor(() => expect(backupsApi.restoreSystem).toHaveBeenCalledTimes(2));

      // One second at a time: each tick schedules the next from a React effect,
      // so a single large advance only ever processes one of them.
      const tick = async (times: number) => {
        for (let i = 0; i < times; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      };

      // Well short of the hold: still on screen, console untouched.
      await tick(10);
      expect(screen.getByText(/Restarting the console in/)).toBeTruthy();
      expect(serverApi.reloadConsole).not.toHaveBeenCalled();

      await tick(6);
      await waitFor(() => expect(serverApi.reloadConsole).toHaveBeenCalled());
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a Battlegroup that will not start without failing the restore", async () => {
    // The restore is already applied by then. Failing the whole thing over the
    // start would misdescribe what happened and hide that the data is in place.
    vi.mocked(serverApi.start).mockRejectedValue(new Error("Docker refused to start dune-director."));
    window.localStorage.setItem("arrakis.setupRestore", JSON.stringify({ archive: "dune-system-x.tar.gz.enc", stage: "uploaded" }));
    renderWizard();
    const field = await screen.findByLabelText("Archive passphrase");
    fireEvent.change(field, { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByText("Next"));
    fireEvent.click(await screen.findByText("Start Restore"));

    expect(await screen.findByText("Congratulations")).toBeTruthy();
    expect(screen.getByText(/Docker refused to start dune-director/)).toBeTruthy();
  });

  it("starts at the welcome step when the stored archive is gone", async () => {
    // The hint lives in the browser, so it outlives the host: a rebuilt server
    // still had it and opened on the passphrase step of a restore that could not
    // happen, past the step where deploy-or-restore is chosen.
    vi.mocked(backupsApi.listSystem).mockResolvedValue({ rows: [] } as never);
    window.localStorage.setItem("arrakis.setupRestore", JSON.stringify({ archive: "dune-system-gone.tar.gz.enc", stage: "uploaded" }));

    renderWizard();
    expect(await screen.findByText("Welcome to Dune Docker Console")).toBeTruthy();
    expect(screen.queryByLabelText("Archive passphrase")).toBeNull();
    // and the dead hint is not left to do the same thing again next time.
    await waitFor(() => expect(window.localStorage.getItem("arrakis.setupRestore")).toBeNull());
  });

  it("still resumes when the stored archive is really there", async () => {
    window.localStorage.setItem("arrakis.setupRestore", JSON.stringify({ archive: "dune-system-x.tar.gz.enc", stage: "uploaded" }));

    renderWizard();
    expect(await screen.findByLabelText("Archive passphrase")).toBeTruthy();
  });

  it("resumes rather than discarding progress when the listing cannot be read", async () => {
    // Refusing to resume because the check itself failed would be the worse of
    // the two mistakes: it strands a restore that is genuinely in progress.
    vi.mocked(backupsApi.listSystem).mockRejectedValue(new Error("Postgres is not running."));
    window.localStorage.setItem("arrakis.setupRestore", JSON.stringify({ archive: "dune-system-x.tar.gz.enc", stage: "uploaded" }));

    renderWizard();
    expect(await screen.findByLabelText("Archive passphrase")).toBeTruthy();
  });

  it("does not resume a restore in the redeploy wizard, which has no restore path", async () => {
    // redeploySteps is a different, shorter list. Resuming into restoreSteps
    // there sets a step index past its end, so no stepper entry is active and
    // Next is inert -- the wizard reads as broken rather than as a stale hint.
    window.localStorage.setItem("arrakis.setupRestore", JSON.stringify({ archive: "dune-system-x.tar.gz.enc", stage: "uploaded" }));
    render(<SetupWizard mode="redeploy" />);

    expect(await screen.findByText("Server Identity")).toBeTruthy();
    expect(screen.queryByLabelText("Archive passphrase")).toBeNull();
    await waitFor(() => expect(document.querySelector(".stepper button.active")).not.toBeNull());
    expect(screen.getByText("Next")).not.toBeDisabled();
  });

  it("surfaces a failed poll on the resumed restore instead of stalling", async () => {
    // The sequence's own watch is inside a try/catch; the one started on
    // resume was not, so a rejected poll killed the loop with no error shown
    // and no further updates -- indistinguishable from a very slow restore.
    vi.mocked(setupApi.tasks).mockResolvedValue({
      tasks: [{ ...done("running"), operation: "backupSystemRestore", status: "running" }]
    } as never);
    vi.mocked(setupApi.task).mockRejectedValue(new Error("The console lost the task."));
    window.localStorage.setItem("arrakis.setupRestore", JSON.stringify({ archive: "dune-system-x.tar.gz.enc", stage: "apply" }));

    renderWizard();

    expect(await screen.findByText(/The console lost the task/)).toBeTruthy();
  });

  it("forgets the stored restore once the operator chooses to deploy instead", async () => {
    // A failed or abandoned restore leaves the hint behind, and it lives in the
    // browser, so every later load returned to the restore path. The stepper
    // always allows walking back to Welcome; choosing deploy there is the
    // operator saying what they want, and it has to survive a reload.
    window.localStorage.setItem("arrakis.setupRestore", JSON.stringify({ archive: "dune-system-x.tar.gz.enc", stage: "uploaded" }));
    renderWizard();
    expect(await screen.findByLabelText("Archive passphrase")).toBeTruthy();

    fireEvent.click(screen.getByText("1. Welcome"));
    fireEvent.click(await screen.findByText("Deploy a new server"));

    expect(window.localStorage.getItem("arrakis.setupRestore")).toBeNull();
  });

  it("comes back to the restore step after a reload mid-restore", async () => {
    // install-assets writes image-tags.env, which is enough for the server to
    // call setup complete -- without this the operator lands on the console.
    vi.mocked(setupApi.tasks).mockResolvedValue({
      tasks: [{ ...done("running"), operation: "backupSystemRestore", status: "running" }]
    } as never);
    window.localStorage.setItem("arrakis.setupRestore", JSON.stringify({ archive: "dune-system-x.tar.gz.enc", stage: "apply" }));

    renderWizard();
    expect(await screen.findByText("Restore")).toBeTruthy();
    // The checklist has to come back mid-sequence, not restart at the top:
    // the install already ran, and re-running it is a multi-gigabyte download.
    expect(screen.getByText("Game files installed").closest("li")?.className).toContain("restore-step-done");
    expect(screen.getByText("Restoring database, config and secrets").closest("li")?.className).toContain("restore-step-active");
    expect(screen.getByText("Restart the console").closest("li")?.className).toContain("restore-step-pending");
  });
});
