import { describe, expect, it } from "vitest";
import type { Task } from "../../api/setup";
import { isDetachedStackUpdateTask, isUpdatedConsoleReady, summarizeStackUpdateProgress } from "./UpdatesPanel";
import { gameAssetsMissing, gameAssetsMissingInText } from "./updateUtils";

function detachedTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "123e4567-e89b-42d3-a456-426614174000",
    type: "updates",
    operation: "selfUpdateApply",
    status: "running",
    currentStep: "Update helper running",
    progressMessage: "Update helper is running.",
    logLines: [{ timestamp: "2026-08-18T07:00:00Z", stream: "stdout", line: "Update helper started: helper-id" }],
    warnings: [],
    startedAt: "2026-08-18T07:00:00Z",
    finishedAt: null,
    errorMessage: null,
    ...overrides
  };
}

describe("detached console update progress", () => {
  it("recognizes a running handoff without falsely marking the API task succeeded", () => {
    const task = detachedTask();
    expect(isDetachedStackUpdateTask(task)).toBe(true);
    expect(task.status).toBe("running");
  });

  it("uses durable helper stages instead of time-simulated progress", () => {
    const summary = summarizeStackUpdateProgress(detachedTask(), {
      runId: "123e4567-e89b-42d3-a456-426614174000",
      state: "running",
      stage: "building",
      percent: 82,
      message: "Building the updated web console."
    });
    expect(summary).toEqual({
      title: "Building Web Console",
      percent: 82,
      message: "Building the updated web console."
    });
  });

  it("shows a durable helper failure and enables a truthful terminal result", () => {
    const task = detachedTask({ status: "failed", errorMessage: "Console build timed out.", finishedAt: "2026-08-18T07:30:00Z" });
    const summary = summarizeStackUpdateProgress(task, {
      runId: task.id,
      state: "failed",
      stage: "failed",
      percent: 100,
      message: "Console build timed out."
    });
    expect(summary.title).toBe("Console Update Failed");
    expect(summary.message).toBe("Console build timed out.");
  });

  it("clears a stale completed task after the replacement Console answers", () => {
    expect(isUpdatedConsoleReady({
      runId: "123e4567-e89b-42d3-a456-426614174000",
      state: "succeeded",
      stage: "complete",
      percent: 100,
      message: "Update complete.",
      consoleReplaced: true
    }, "v1.3.97", "v1.3.98")).toBe(true);
  });

  it("keeps waiting when the old Console still answers with the wrong version", () => {
    expect(isUpdatedConsoleReady({
      runId: "123e4567-e89b-42d3-a456-426614174000",
      state: "succeeded",
      stage: "complete",
      percent: 100,
      message: "Update complete.",
      consoleReplaced: false
    }, "v1.3.97", "v1.3.98")).toBe(false);
  });
});

describe("missing game files", () => {
  // A host with no game files fails the Steam check outright, so every
  // "is an update available" condition is false exactly when the operator most
  // needs the install control. The marker is what distinguishes that state from
  // an ordinary check failure.
  it("recognizes the marker in a check failure's reason", () => {
    expect(gameAssetsMissing({
      status: "Check Failed",
      current: "",
      latest: "",
      reason: "DUNE_GAME_ASSETS_MISSING\nCannot start Postgres: the Funcom database image is not installed on this host."
    })).toBe(true);
  });

  it("does not fire on an ordinary check failure", () => {
    expect(gameAssetsMissing({
      status: "Check Failed",
      current: "",
      latest: "",
      reason: "SteamCMD could not retrieve the current app information."
    })).toBe(false);
  });

  it("reads a task log as well as a status reason", () => {
    expect(gameAssetsMissingInText("Restoring database...\nDUNE_GAME_ASSETS_MISSING\n")).toBe(true);
    expect(gameAssetsMissingInText("Database restore failed (exit 1).")).toBe(false);
    expect(gameAssetsMissingInText(undefined)).toBe(false);
  });
});
