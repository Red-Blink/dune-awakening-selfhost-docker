import { describe, expect, it } from "vitest";
import type { Task } from "../api/setup";
import { conciseTaskError } from "./taskDisplay";

const command = "[dune] $ env HOME=/home/dune /srv/dune/steam/steamcmd.sh +@ShutdownOnFailedCommand 1 +login anonymous +app_update 4754530 validate +quit";
function failedTask(lines: string[]): Task {
  return { id: "update", type: "updates", operation: "updateApply", status: "failed", currentStep: "", progressMessage: "", startedAt: "", finishedAt: "", warnings: [], errorMessage: "dune update --yes failed with exit 75", logLines: lines.map((line) => ({ timestamp: "", stream: "stderr", line })) };
}

describe("update failure summary", () => {
  it("keeps provider rate-limit guidance ahead of earlier Steam errors", () => {
    const task = failedTask(["Error! App '4754530' state is 0x6 after update job."]);
    task.errorMessage = "Docker Hub request limit reached. Try again later; no retry time was provided.";
    expect(conciseTaskError(task)).toBe(task.errorMessage);
  });
  it("shows the lifecycle refusal instead of a successful SteamCMD invocation", () => {
    const reason = "Another Battlegroup operation is running. Wait for it to finish, then retry the game update. No update files were changed.";
    expect(conciseTaskError(failedTask([command, reason]))).toBe(reason);
  });
  it("does not treat command echoes as the failure reason", () => {
    expect(conciseTaskError(failedTask([command]))).toBe("Task failed.");
  });
  it("preserves actual Steam install failures", () => {
    expect(conciseTaskError(failedTask([command, "Error! App '4754530' state is 0x6 after update job."]))).toContain("state is 0x6");
  });
});
