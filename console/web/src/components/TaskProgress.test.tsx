import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Task } from "../api/setup";
import { TaskProgress } from "./TaskProgress";

function failedDeployment(lines: string[]): Task {
  return {
    id: "deployment-1",
    type: "setup",
    operation: "init",
    status: "failed",
    currentStep: "Deploying",
    progressMessage: "",
    logLines: lines.map((line, index) => ({ timestamp: String(index), stream: "stdout", line })),
    warnings: [],
    startedAt: "2026-07-26T10:00:00.000Z",
    finishedAt: "2026-07-26T10:10:00.000Z",
    errorMessage: "Deployment command exited with status 1"
  };
}

describe("TaskProgress deployment failures", () => {
  it("does not misclassify Steam's generic low-disk troubleshooting bullet as a disk failure", () => {
    render(<TaskProgress task={failedDeployment([
      "[dune] Disk space at /srv/dune: 812.4 GiB free / 900.0 GiB total",
      "[dune] If SteamCMD printed \"state is 0x6\", common causes are:",
      "[dune]   - not enough free disk space in Docker's volume storage",
      "Steam could not download from its selected content host: cache12-ams1.steamcontent.com",
      "This is a Steam content-host failure, not an install-directory failure."
    ])} />);

    expect(screen.getByRole("heading", { name: /^Steam Download Failed\.?$/ })).toBeInTheDocument();
    expect(screen.getByText(/usually temporary; retry deployment later/i)).toBeInTheDocument();
    expect(screen.queryByText(/There is not enough free disk space/i)).not.toBeInTheDocument();
  });

  it("still reports an authoritative disk preflight failure with its measured free space", () => {
    render(<TaskProgress task={failedDeployment([
      "[dune] Not enough free disk space for a safe Dune server install/update.",
      "[dune] Free disk space is below the configured safety minimum:",
      "[dune]   /srv/dune: 12.5 GiB free, needs at least 25 GiB"
    ])} />);

    expect(screen.getByRole("heading", { name: /^Not Enough Disk Space\.?$/ })).toBeInTheDocument();
    expect(screen.getByText(/\/srv\/dune has 12.5 GiB free, but deployment requires at least 25 GiB/i)).toBeInTheDocument();
  });
});

function restartTask(warnings: string[], lines: string[]): Task {
  return {
    id: "restart-1",
    type: "server",
    operation: "restartAll",
    status: "succeeded",
    currentStep: "Finished",
    progressMessage: "Task succeeded",
    logLines: lines.map((line, index) => ({ timestamp: String(index), stream: "stdout", line })),
    warnings,
    startedAt: "2026-08-28T10:00:00.000Z",
    finishedAt: "2026-08-28T10:04:00.000Z",
    errorMessage: null
  };
}

describe("TaskProgress queued-write warnings", () => {
  // The failure has to be visible without opening anything: a restart that
  // silently skipped a base delete previously reported a plain green
  // "succeeded" and said nothing anywhere the operator could see.
  it("shows queued-write failures in the panel body, not only in the log", () => {
    render(<TaskProgress task={restartTask(
      ["1 queued base delete could not be applied and stay queued: This base was picked up into a backup and is no longer claimed."],
      ["Applied 2 queued generator refills."]
    )} />);

    expect(screen.getByText(/1 queued base delete could not be applied and stay queued/i)).toBeInTheDocument();
    expect(screen.getByLabelText("1 warning")).toBeInTheDocument();
  });

  it("counts multiple warnings and leaves the task's own status alone", () => {
    render(<TaskProgress task={restartTask(
      ["1 queued base delete could not be applied and stay queued: still blocked.", "1 queued vehicle delete was dropped and must be requested again: gave up."],
      []
    )} />);

    expect(screen.getByLabelText("2 warnings")).toBeInTheDocument();
    // The count is a symbol plus a numeral now, so pin the numeral separately:
    // an icon-only regression would still satisfy the label assertion above.
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("succeeded")).toBeInTheDocument();
  });

  it("shows no warning block when nothing failed", () => {
    const { container } = render(<TaskProgress task={restartTask([], ["Applied 1 queued base delete."])} />);
    expect(container.querySelector(".task-warnings")).toBeNull();
    expect(screen.queryByText(/warning/i)).not.toBeInTheDocument();
    // getByText does not match accessible names, so without this the assertion
    // above would pass even if the badge were still rendered.
    expect(screen.queryByLabelText(/warning/i)).not.toBeInTheDocument();
  });

  // .technical-details is display:none behind a body.debug class nothing sets,
  // so a restart task's log was unreachable. It must be an expandable
  // disclosure instead -- collapsed by default, but openable.
  it("renders the log as an expandable disclosure rather than a debug-only block", () => {
    const { container } = render(<TaskProgress task={restartTask([], ["Applied 1 queued base delete."])} />);
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.className).toContain("task-technical-details");
    expect(details?.className).not.toContain("technical-details ");
    expect(details?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("Technical details")).toBeInTheDocument();
  });
});
